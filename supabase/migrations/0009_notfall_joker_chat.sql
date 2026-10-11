-- Verbesserungen Runde 3:
-- * Joker erst ab einer einstellbaren Zeit nach Jagdbeginn (joker.available_after_minutes), einmal pro Spieltag.
-- * Ausserhalb der eigenen Zone bzw. des Spielfelds: Live-Standort immer an alle Hunter.
-- * Notfall: alle Hunter werden alarmiert und sehen den Notfallkontakt; die Person selbst kann einen Fehlalarm abbrechen.
-- * Chat: Spieler schreiben nur mit der Spielleitung; Ankündigungen schreibt nur die Spielleitung.

create or replace function public.grant_jokers(p_game public.games, p_now timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_types jsonb := coalesce(v_cfg -> 'joker' -> 'types', '[]');
  v_n int := jsonb_array_length(v_types);
  v_per int := public.cfg_int(v_cfg, 'joker', 'per_day', 1);
  v_sel text := public.cfg_text(v_cfg, 'joker', 'selection', 'zufall');
  v_carry text := public.cfg_text(v_cfg, 'joker', 'carry_over', 'einen_tag');
  v_max int := public.cfg_int(v_cfg, 'joker', 'max_inventory', 2);
  v_p public.participants;
  v_t jsonb;
  v_done int;
  v_after int := public.cfg_int(v_cfg, 'joker', 'available_after_minutes', 0);
  v_have int;
  i int;
begin
  if not public.cfg_bool(v_cfg, 'joker', 'enabled', false) or v_n = 0 or v_per = 0 then return; end if;
  if p_game.status not in ('laeuft', 'finale') or p_game.current_day < 1 then return; end if;
  -- Erst ab "verfügbar ab" nach Jagdbeginn, und pro Spieltag nur einmal.
  if p_game.hunt_start_at is null or p_now < p_game.hunt_start_at + make_interval(mins => v_after) then return; end if;
  select coalesce((state_json ->> 'joker_day')::int, 0) into v_done from public.games where id = p_game.id;
  if v_done >= p_game.current_day then return; end if;
  update public.games set state_json = state_json || jsonb_build_object('joker_day', p_game.current_day) where id = p_game.id;
  -- Aufheben: nie = alte verfallen, einen_tag = älter als gestern verfällt.
  if v_carry = 'nie' then
    update public.inventory_items set expired = true where game_id = p_game.id and kind = 'joker' and used_at is null and not expired;
  elsif v_carry = 'einen_tag' then
    update public.inventory_items set expired = true where game_id = p_game.id and kind = 'joker' and used_at is null and not expired
      and granted_day < p_game.current_day - 1;
  end if;
  for v_p in select * from public.participants where game_id = p_game.id and role = 'spieler' and state in ('aktiv', 'ausserhalb', 'notfall') loop
    for i in 1..v_per loop
      select count(*) into v_have from public.inventory_items where participant_id = v_p.id and kind = 'joker' and used_at is null and not expired;
      exit when v_have >= v_max;
      v_t := case v_sel
        when 'fest_pro_tag' then v_types -> ((p_game.current_day - 1) % v_n)
        when 'spieler_waehlt' then jsonb_build_object('type', 'wahl')
        else v_types -> floor(random() * v_n)::int
      end;
      insert into public.inventory_items (game_id, participant_id, kind, type, minutes, granted_day, granted_at, source)
      values (p_game.id, v_p.id, 'joker', v_t ->> 'type', (v_t ->> 'minutes')::int, p_game.current_day, p_now, 'tag');
      perform public.notify(p_game.id, null, v_p.id, 'joker', 'Neuer Joker: ' || replace(v_t ->> 'type', '_', ' '),
        case when v_t ? 'minutes' then (v_t ->> 'minutes') || ' min' else '' end, '{}', 'normal');
    end loop;
  end loop;
end; $$;

create or replace function public.tick_game(p_game_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  g public.games;
  v_cfg jsonb;
  v_now timestamptz;
  v_delta int;
  v_p public.participants;
  v_e public.active_effects;
  v_sh public.speedhunts;
  v_h public.hideouts;
  v_v public.violations;
  v_c public.catches;
  v_ch public.challenges;
  v_pos record;
  v_max int;
  v_remaining int;
  v_announce int;
  v_times jsonb;
  v_t jsonb;
  v_target uuid;
  v_leave int;
  v_loss int;
  v_runner_pos public.positions;
  v_hunter_pos public.positions;
begin
  select * into g from public.games where id = p_game_id for update skip locked;
  if g.id is null or g.status not in ('vorsprung', 'laeuft', 'finale') then return; end if;
  v_now := now() + g.clock_offset;
  if g.paused_at is not null then return; end if;
  v_cfg := g.config_json;
  v_delta := greatest(0, extract(epoch from (v_now - coalesce(g.last_tick_at, v_now)))::int);

  -- Jagdbeginn
  if g.status = 'vorsprung' and v_now >= g.hunt_start_at then
    g := public.hunt_begin(g, v_now);
  end if;
  if g.status = 'vorsprung' then
    update public.games set last_tick_at = v_now where id = g.id;
    perform public.bump(g.id);
    return;
  end if;

  -- 1. Tagesreset
  while g.next_day_at is not null and g.next_day_at <= v_now loop
    g := public.day_reset(g, v_now);
  end loop;

  -- Joker des Spieltags (sobald sie verfügbar sind)
  perform public.grant_jokers(g, v_now);

  -- Spielfeld-Phasen alle X Minuten
  if public.shrink_every_minutes(v_cfg) > 0 then
    while (g.state_json ->> 'next_phase_at') is not null and (g.state_json ->> 'next_phase_at')::timestamptz <= v_now loop
      g := public.phase_advance(g, v_now);
    end loop;
    g := public.phase_announce(g, v_now);
  end if;

  -- Ankündigung der Spielfeldänderung
  v_announce := public.cfg_int(v_cfg, 'zone', 'shrink_announce_minutes', 180);
  if public.shrink_every_minutes(v_cfg) = 0 and g.next_day_at is not null and g.next_day_at - make_interval(mins => v_announce) <= v_now
     and coalesce((g.state_json ->> 'announced_day')::int, 0) < g.current_day + 1
     and exists (select 1 from public.zones where game_id = g.id and kind = 'spielfeld' and day_index = g.current_day + 1) then
    update public.games set state_json = state_json || jsonb_build_object('announced_day', g.current_day + 1), map_version = map_version + 1
    where id = g.id returning * into g;
    perform public.notify(g.id, 'alle', null, 'zone_announce', 'Neues Spielfeld ab ' || to_char(g.next_day_at at time zone g.timezone, 'HH24:MI'),
      'Die neuen Grenzen sind auf der Karte gestrichelt.', '{}', 'hoch');
  end if;

  -- 3. Effekt-Enden
  for v_e in select * from public.active_effects where game_id = g.id and ends_at is not null and ends_at <= v_now and not (payload ? 'done') loop
    update public.active_effects set payload = payload || '{"done": true}' where id = v_e.id;
    if v_e.type = 'hotel' then
      perform public.create_ping(g, v_e.participant_id, 'hotel_end', (v_e.payload ->> 'lat')::double precision, (v_e.payload ->> 'lng')::double precision,
        null, null, null, null, 'Hotel', 0, v_now);
      perform public.notify(g.id, null, v_e.participant_id, 'hotel_end', 'Hotel vorbei: du wurdest erkannt!',
        'Die Taskforce kennt deinen Ort. Verlass ihn sofort.', '{}', 'kritisch');
      perform public.notify(g.id, 'taskforce', null, 'hotel_end', 'Hotel-Ping: ' || public.pname(v_e.participant_id), '', '{}', 'hoch');
    elsif v_e.type in ('regeneration', 'catch_free', 'leo') then
      perform public.notify(g.id, null, v_e.participant_id, 'effect_end',
        case v_e.type when 'regeneration' then 'Regeneration vorbei' when 'catch_free' then 'Catch-Free vorbei' else 'LEO vorbei' end,
        '', '{}', 'normal');
    end if;
  end loop;
  -- Aufgeschobene Straf-Speedhunts starten, sobald keine Regeneration mehr läuft.
  for v_sh in select * from public.speedhunts where game_id = g.id and status = 'aufgeschoben' loop
    if not public.has_effect(v_sh.target_id, 'regeneration', v_now) then
      update public.speedhunts set status = 'beendet', ended_at = v_now, end_reason = 'neu_gestartet' where id = v_sh.id;
      perform public.start_speedhunt_internal(g, v_sh.target_id, v_sh.triggered_by, true, v_now);
    end if;
  end loop;

  -- 4. Pings
  for v_p in select * from public.participants where game_id = g.id and role = 'spieler' and next_ping_at is not null and next_ping_at <= v_now loop
    perform public.process_ping_due(g, v_p, v_now);
  end loop;

  -- 5. Speedhunt-Timeouts und Zufalls-Speedhunts
  for v_sh in select * from public.speedhunts where game_id = g.id and status = 'laeuft' and deadline_at <= v_now loop
    perform public.end_speedhunt(g, v_sh, 'zeit_abgelaufen', v_now);
  end loop;
  v_times := coalesce(g.state_json -> 'random_speedhunts', '[]');
  if jsonb_array_length(v_times) > 0 then
    for v_t in select * from jsonb_array_elements(v_times) loop
      if (v_t #>> '{}')::timestamptz <= v_now and g.speedhunts_left > 0 then
        select p.id into v_target from public.participants p
        where p.game_id = g.id and p.role = 'spieler' and p.state = 'aktiv'
          and not public.has_effect(p.id, 'regeneration', v_now) and not public.has_effect(p.id, 'hotel', v_now)
          and (public.running_speedhunt_on(p.id)).id is null
        order by random() limit 1;
        if v_target is not null then
          perform public.start_speedhunt_internal(g, v_target, null, false, v_now);
          update public.games set speedhunts_left = speedhunts_left - 1 where id = g.id returning * into g;
        end if;
        v_times := (select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements(v_times) x where x <> v_t);
      end if;
    end loop;
    update public.games set state_json = state_json || jsonb_build_object('random_speedhunts', v_times) where id = g.id returning * into g;
  end if;

  -- Ausserhalb-Zeit
  v_max := public.cfg_int(v_cfg, 'out_of_bounds', 'max_minutes', 120);
  for v_p in select * from public.participants where game_id = g.id and role = 'spieler' and state = 'ausserhalb' loop
    update public.participants set out_accum_s = out_accum_s + v_delta where id = v_p.id returning * into v_p;
    if v_p.out_accum_s >= v_max * 60 then
      perform public.close_live_windows(v_p.id, 'ausserhalb', v_now);
      case public.cfg_text(v_cfg, 'out_of_bounds', 'on_timeout', 'disqualify')
        when 'catch' then perform public.auto_catch(g, v_p.id, 'Zu lange ausserhalb', v_now);
        when 'disqualify' then perform public.disqualify(g, v_p.id, 'Zu lange ausserhalb des Spielfelds', v_now);
        else
          update public.participants set out_accum_s = 0 where id = v_p.id;
          perform public.create_violation(g, v_p.id, 'ausserhalb_limit', '{}', v_now);
      end case;
      select * into g from public.games where id = g.id;
      exit when g.status = 'beendet';
    end if;
  end loop;
  if g.status = 'beendet' then perform public.bump(g.id); return; end if;

  -- Verschanzen-Zeit (7.8)
  v_max := public.cfg_int(v_cfg, 'hideout', 'max_minutes', 120);
  for v_h in select h.* from public.hideouts h join public.participants p on p.id = h.participant_id
             where h.game_id = g.id and h.status = 'aktiv' and h.inside and p.state in ('aktiv', 'ausserhalb') loop
    if public.has_effect(v_h.participant_id, 'hotel', v_now) then continue; end if;
    update public.hideouts set accum_s = accum_s + v_delta where id = v_h.id returning * into v_h;
    v_remaining := v_max * 60 - v_h.accum_s;
    if v_remaining <= 0 then
      update public.hideouts set status = 'abgelaufen', inside = false, left_at = v_now where id = v_h.id;
      if public.cfg_text(v_cfg, 'hideout', 'on_timeout', 'catch') = 'catch' then
        perform public.auto_catch(g, v_h.participant_id, 'Verschanzen über dem Limit', v_now);
      else
        perform public.create_violation(g, v_h.participant_id, 'verschanzen_limit', '{}', v_now);
      end if;
      select * into g from public.games where id = g.id;
      exit when g.status = 'beendet';
    elsif v_remaining <= 120 and v_h.warned < 3 then
      update public.hideouts set warned = 3 where id = v_h.id;
      perform public.notify(g.id, null, v_h.participant_id, 'hideout_warning', 'Noch 2 min verschanzt!',
        'Dann musst du raus (' || public.cfg_int(v_cfg, 'hideout', 'min_leave_distance_m', 200) || ' m Abstand).', '{}', 'kritisch');
    elsif v_remaining <= 600 and v_h.warned < 2 then
      update public.hideouts set warned = 2 where id = v_h.id;
      perform public.notify(g.id, null, v_h.participant_id, 'hideout_warning', 'Noch 10 min verschanzt',
        'Dann musst du raus (' || public.cfg_int(v_cfg, 'hideout', 'min_leave_distance_m', 200) || ' m Abstand).', '{}', 'hoch');
    elsif v_remaining <= 1800 and v_h.warned < 1 then
      update public.hideouts set warned = 1 where id = v_h.id;
      perform public.notify(g.id, null, v_h.participant_id, 'hideout_warning', 'Noch 30 min verschanzt', '', '{}', 'hoch');
    end if;
  end loop;
  if g.status = 'beendet' then perform public.bump(g.id); return; end if;

  -- Verstösse automatisch verhängen
  for v_v in select * from public.violations where game_id = g.id and status = 'offen' and auto_apply_at is not null and auto_apply_at <= v_now loop
    perform public.apply_penalty(g, v_v.id, v_v.proposed_penalty, v_now);
    select * into g from public.games where id = g.id;
    exit when g.status = 'beendet';
  end loop;
  if g.status = 'beendet' then perform public.bump(g.id); return; end if;

  -- Fang-Bestätigungen und Beweise, die abgelaufen sind
  for v_c in select * from public.catches where game_id = g.id and status in ('wartet_auf_bestaetigung', 'wartet_auf_beweis') and expires_at <= v_now loop
    if v_c.status = 'wartet_auf_beweis' then
      update public.catches set status = 'abgelehnt', reason = 'Kein Beweis innerhalb der Frist' where id = v_c.id;
      perform public.notify(g.id, null, v_c.hunter_id, 'catch_rejected', 'Fang ungültig', 'Kein Foto/Video innerhalb von 2 min.', '{}', 'hoch');
    elsif public.cfg_text(v_cfg, 'roles', 'gm_mode', 'auto') = 'mensch' then
      perform public.notify(g.id, 'gm', null, 'catch_decide', 'Fang bestätigen?', public.pname(v_c.runner_id) || ' hat nicht reagiert.', jsonb_build_object('catch_id', v_c.id), 'hoch');
      update public.catches set expires_at = null where id = v_c.id;
    else
      -- Auto-Spielleitung: gültig, wenn der GPS-Abstand passt (7.6).
      select * into v_runner_pos from public.positions where participant_id = v_c.runner_id;
      select * into v_hunter_pos from public.positions where participant_id = v_c.hunter_id;
      if v_runner_pos.participant_id is not null and v_hunter_pos.participant_id is not null
         and public.dist_m(v_runner_pos.geom, v_hunter_pos.geom) <= public.cfg_int(v_cfg, 'catch', 'max_distance_m', 30) + coalesce(v_runner_pos.accuracy_m, 0) + coalesce(v_hunter_pos.accuracy_m, 0) then
        perform public.apply_catch(g, v_c.id, v_now);
      else
        update public.catches set status = 'abgelehnt', reason = 'Keine Bestätigung, GPS-Abstand zu gross' where id = v_c.id;
        perform public.notify(g.id, null, v_c.hunter_id, 'catch_rejected', 'Fang abgelehnt', 'Keine Bestätigung und GPS-Abstand zu gross.', '{}', 'hoch');
      end if;
      select * into g from public.games where id = g.id;
      exit when g.status = 'beendet';
    end if;
  end loop;
  if g.status = 'beendet' then perform public.bump(g.id); return; end if;

  -- Challenges
  for v_ch in select * from public.challenges where game_id = g.id and status in ('geplant', 'angekuendigt', 'laeuft') loop
    if v_ch.status = 'geplant' and coalesce(v_ch.announce_at, v_ch.starts_at) <= v_now then
      update public.challenges set status = 'angekuendigt' where id = v_ch.id;
      perform public.notify(g.id, 'spieler', null, 'challenge_announce', 'Challenge: ' || v_ch.title,
        'Start ' || to_char(v_ch.starts_at at time zone g.timezone, 'HH24:MI') || '. ' || left(v_ch.description, 200), jsonb_build_object('challenge_id', v_ch.id), 'hoch');
      if v_ch.reveal_location_to_taskforce then
        perform public.notify(g.id, 'taskforce', null, 'challenge_announce', 'Challenge der Spieler: ' || v_ch.title,
          'Start ' || to_char(v_ch.starts_at at time zone g.timezone, 'HH24:MI'), jsonb_build_object('challenge_id', v_ch.id), 'normal');
      end if;
      v_ch.status := 'angekuendigt';
    end if;
    if v_ch.status = 'angekuendigt' and v_ch.starts_at <= v_now then
      update public.challenges set status = 'laeuft' where id = v_ch.id;
      perform public.notify(g.id, 'spieler', null, 'challenge_start', 'Challenge läuft: ' || v_ch.title, '', jsonb_build_object('challenge_id', v_ch.id), 'hoch');
      v_ch.status := 'laeuft';
    end if;
    if v_ch.status = 'laeuft' and v_ch.ends_at <= v_now then
      update public.challenges set status = 'beendet' where id = v_ch.id;
      update public.challenge_entries set result = 'gescheitert', decided_at = v_now where challenge_id = v_ch.id and result = 'offen';
      perform public.notify(g.id, 'spieler', null, 'challenge_end', 'Challenge beendet: ' || v_ch.title, '', jsonb_build_object('challenge_id', v_ch.id), 'normal');
    end if;
  end loop;

  -- Signalverlust und Akku (7.18, 15)
  v_loss := public.cfg_int(v_cfg, 'tracking', 'signal_loss_max_minutes', 15);
  for v_p in select * from public.participants where game_id = g.id and role in ('spieler', 'hunter', 'zentrale') and state in ('aktiv', 'ausserhalb')
             and last_seen_at is not null and last_seen_at < v_now - make_interval(mins => v_loss)
             and (signal_warned_at is null or signal_warned_at < last_seen_at) loop
    update public.participants set signal_warned_at = v_now where id = v_p.id;
    perform public.notify(g.id, 'gm', null, 'signal_loss', 'Signalverlust: ' || public.pname(v_p.id),
      'Seit ' || to_char(v_p.last_seen_at at time zone g.timezone, 'HH24:MI') || ' keine Daten.', '{}', 'hoch');
  end loop;

  -- Teambildung (alle 30 s)
  if coalesce((g.state_json ->> 'last_proximity')::timestamptz, '-infinity') <= v_now - interval '30 seconds' then
    perform public.check_proximity(g, v_now);
    update public.games set state_json = state_json || jsonb_build_object('last_proximity', v_now) where id = g.id returning * into g;
  end if;

  -- Exitpoint bekanntgeben (7.19)
  if public.cfg_bool(v_cfg, 'exit', 'enabled', true) and not g.exit_revealed and g.exit_reveal_at is not null and g.exit_reveal_at <= v_now and g.exit_zone_id is not null then
    update public.zones set visible_from = v_now,
      visible_to = case public.cfg_text(v_cfg, 'exit', 'reveal_to_taskforce', 'gleichzeitig') when 'gleichzeitig' then 'alle' else 'spieler' end
    where id = g.exit_zone_id;
    update public.games set exit_revealed = true, status = 'finale', map_version = map_version + 1,
      state_json = state_json || jsonb_build_object('exit_taskforce_at', case public.cfg_text(v_cfg, 'exit', 'reveal_to_taskforce', 'gleichzeitig')
        when 'verzoegert' then to_jsonb(v_now + interval '15 minutes') else null end)
    where id = g.id returning * into g;
    perform public.notify(g.id, case public.cfg_text(v_cfg, 'exit', 'reveal_to_taskforce', 'gleichzeitig') when 'gleichzeitig' then 'alle' else 'spieler' end,
      null, 'exit_reveal', 'Exitpoint bekannt: ' || coalesce(nullif((select name from public.zones where id = g.exit_zone_id), ''), 'siehe Karte'),
      'Ankunft bis ' || to_char(g.deadline_at at time zone g.timezone, 'HH24:MI') || '.', '{}', 'kritisch');
    if public.cfg_text(v_cfg, 'exit', 'reveal_to_taskforce', 'gleichzeitig') <> 'gleichzeitig' then
      perform public.notify(g.id, 'gm', null, 'exit_reveal', 'Exitpoint an Spieler bekanntgegeben', '', '{}', 'normal');
    end if;
    -- Spieler, die schon im Radius stehen, gelten sofort als angekommen.
    perform public.recheck_exit(g, v_now);
  end if;
  if g.state_json ? 'exit_taskforce_at' and jsonb_typeof(g.state_json -> 'exit_taskforce_at') = 'string'
     and (g.state_json ->> 'exit_taskforce_at')::timestamptz <= v_now then
    update public.zones set visible_to = 'alle' where id = g.exit_zone_id;
    update public.games set state_json = state_json - 'exit_taskforce_at', map_version = map_version + 1 where id = g.id returning * into g;
    perform public.notify(g.id, 'taskforce', null, 'exit_reveal', 'Exitpoint bekannt', 'Siehe Karte.', '{}', 'kritisch');
  end if;

  -- Spielende
  if v_now >= g.ends_at and not coalesce((g.state_json ->> 'end_notified')::boolean, false) and public.cfg_bool(v_cfg, 'exit', 'enabled', true)
     and g.deadline_at > g.ends_at then
    update public.games set state_json = state_json || '{"end_notified": true}' where id = g.id returning * into g;
    perform public.notify(g.id, 'alle', null, 'time_up', 'Spielzeit vorbei', 'Ankunft am Exitpoint noch bis ' || to_char(g.deadline_at at time zone g.timezone, 'HH24:MI') || '.', '{}', 'hoch');
  end if;
  if v_now >= g.deadline_at then
    perform public.finish_game(g, v_now, 'zeit_abgelaufen');
  end if;

  update public.games set last_tick_at = v_now where id = g.id;
  perform public.bump(g.id);
end; $$;

create or replace function public.check_player_zone(p_game public.games, p_p public.participants, p_point extensions.geometry, p_now timestamptz)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_area extensions.geometry;
  v_inside boolean;
  v_tol int := public.cfg_int(v_cfg, 'zone', 'edge_tolerance_m', 25);
  v_grace int := public.cfg_int(v_cfg, 'out_of_bounds', 'grace_seconds', 60);
  v_max int := public.cfg_int(v_cfg, 'out_of_bounds', 'max_minutes', 120);
  v_restricted public.zones;
  v_cross int := public.cfg_int(v_cfg, 'zone', 'restricted_crossing_max_seconds', 60);
begin
  v_area := public.allowed_area(p_game.id, p_p.id, p_game.current_day, public.cfg_bool(v_cfg, 'zone', 'sections_per_player', false));
  v_inside := v_area is null or ST_DWithin(v_area::geography, p_point::geography, v_tol);

  -- Sperrzonen (22.3)
  select * into v_restricted from public.zones where game_id = p_game.id and kind = 'sperrzone' and ST_Covers(geom, p_point) limit 1;
  if v_restricted.id is not null then
    if public.cfg_bool(v_cfg, 'zone', 'restricted_counts_as_outside', false) then v_inside := false; end if;
    if p_p.restricted_zone_id is distinct from v_restricted.id then
      update public.participants set restricted_zone_id = v_restricted.id, restricted_since = p_now, restricted_violated = false where id = p_p.id;
      perform public.notify(p_game.id, null, p_p.id, 'restricted', 'Sperrzone! Sofort verlassen', coalesce(nullif(v_restricted.name, ''), 'Sperrzone'), '{}', 'kritisch');
      p_p.restricted_since := p_now;
      p_p.restricted_violated := false;
    end if;
    if not p_p.restricted_violated and (not v_restricted.crossing_allowed or p_now - p_p.restricted_since > make_interval(secs => v_cross)) then
      update public.participants set restricted_violated = true where id = p_p.id;
      perform public.create_violation(p_game, p_p.id, 'sperrzone',
        jsonb_build_object('zone', v_restricted.name, 'lat', ST_Y(p_point), 'lng', ST_X(p_point)), p_now);
    end if;
  elsif p_p.restricted_zone_id is not null then
    update public.participants set restricted_zone_id = null, restricted_since = null, restricted_violated = false where id = p_p.id;
  end if;

  if v_inside or (p_p.grace_until is not null and p_p.grace_until > p_now) then
    if p_p.state = 'ausserhalb' then
      update public.participants set state = 'aktiv', out_pending_since = null,
        out_accum_s = case when public.cfg_text(v_cfg, 'out_of_bounds', 'count_mode', 'pro_ausflug') = 'pro_ausflug' then 0 else out_accum_s end
      where id = p_p.id;
      perform public.close_live_windows(p_p.id, 'ausserhalb', p_now);
      perform public.notify(p_game.id, null, p_p.id, 'back_inside', 'Zurück im Spielfeld', '', '{}', 'normal');
      perform public.notify(p_game.id, 'taskforce', null, 'back_inside', public.pname(p_p.id) || ' ist zurück im Spielfeld', 'Live-Standort beendet.', '{}', 'normal');
    elsif p_p.out_pending_since is not null then
      update public.participants set out_pending_since = null where id = p_p.id;
    end if;
    return;
  end if;

  if p_p.state = 'ausserhalb' then return; end if;
  if p_p.out_pending_since is null then
    update public.participants set out_pending_since = p_now where id = p_p.id;
    if v_grace > 0 then
      perform public.notify(p_game.id, null, p_p.id, 'outside_warning', 'Achtung: Spielfeldgrenze',
        'Du bist am Rand oder ausserhalb. Geh zurück.', '{}', 'hoch');
      return;
    end if;
    p_p.out_pending_since := p_now;
  end if;
  if p_now - p_p.out_pending_since >= make_interval(secs => v_grace) then
    update public.participants set state = 'ausserhalb' where id = p_p.id;
    -- Immer live an die Hunter, solange die Person ausserhalb ist.
    perform public.open_live_window(p_game.id, p_p.id, 'ausserhalb', p_now, null);
    perform public.notify(p_game.id, null, p_p.id, 'outside', 'Du bist ausserhalb!',
      greatest(0, v_max - p_p.out_accum_s / 60) || ' min bis ' ||
      case public.cfg_text(v_cfg, 'out_of_bounds', 'on_timeout', 'disqualify')
        when 'catch' then 'zum Fang' when 'disqualify' then 'zur Disqualifikation' else 'zur Strafe' end || '. Die Taskforce sieht dich live.',
      '{}', 'kritisch');
    perform public.notify(p_game.id, 'taskforce', null, 'outside', public.pname(p_p.id) || ' ist ausserhalb', 'Live-Standort sichtbar.', '{}', 'hoch');
    perform public.notify(p_game.id, 'gm', null, 'outside', public.pname(p_p.id) || ' ist ausserhalb', '', '{}', 'normal');
  end if;
end; $$;

create or replace function public.emergency_start(p_game_id uuid, p_lat double precision default null, p_lng double precision default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me public.participants;
  g public.games;
  v_id uuid;
  v_now timestamptz;
  v_pos public.positions;
begin
  v_me := public.require_participant(p_game_id);
  select * into g from public.games where id = p_game_id;
  v_now := public.engine_now(p_game_id);
  select * into v_pos from public.positions where participant_id = v_me.id;
  insert into public.emergencies (game_id, participant_id, at, lat, lng) values (p_game_id, v_me.id, v_now, coalesce(p_lat, v_pos.lat), coalesce(p_lng, v_pos.lng))
  returning id into v_id;
  if v_me.state in ('aktiv', 'ausserhalb') then
    update public.participants set state_before = state, state = 'notfall' where id = v_me.id;
  end if;
  perform public.open_live_window(p_game_id, v_me.id, 'notfall', v_now, null);
  perform public.notify(p_game_id, 'gm', null, 'emergency', 'NOTFALL: ' || public.pname(v_me.id), 'Standort auf der Karte. Notfallkontakt in der Teilnehmerliste.', jsonb_build_object('emergency_id', v_id), 'kritisch');
  perform public.notify(p_game_id, 'taskforce', null, 'emergency', 'NOTFALL: ' || public.pname(v_me.id), 'Jagd auf diese Person ist ausgesetzt. Standort und Notfallkontakt in der App. Bitte helft sofort, wenn ihr in der Nähe seid.', jsonb_build_object('emergency_id', v_id), 'kritisch');
  if public.cfg_text(g.config_json, 'safety', 'emergency_pauses', 'person') = 'alle' and g.status in ('vorsprung', 'laeuft', 'finale') then
    perform public.pause_internal(p_game_id, 'Notfall: ' || public.pname(v_me.id));
  end if;
  perform public.notify(p_game_id, null, v_me.id, 'emergency_self', 'Notfall gemeldet',
    'Alle Hunter' || case when exists (select 1 from public.participants where game_id = p_game_id and role = 'gm') then ' und die Spielleitung' else '' end
    || ' sind alarmiert. Bei Gefahr: Polizei 117, Sanität 144, Notruf 112.', jsonb_build_object('emergency_id', v_id), 'kritisch');
  perform public.log_game_event(p_game_id, 'emergency', jsonb_build_object('participant', v_me.id));
  perform public.bump(p_game_id);
  return v_id;
end; $$;

create or replace function public.emergency_resolve(p_emergency_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_e public.emergencies;
  v_me public.participants;
  v_p public.participants;
  g public.games;
  v_now timestamptz;
begin
  select * into v_e from public.emergencies where id = p_emergency_id;
  v_me := public.require_participant(v_e.game_id);
  select * into g from public.games where id = v_e.game_id;
  if not (v_me.role = 'gm' or public.is_game_host(g.id)
          or v_me.id = v_e.participant_id) then
    raise exception 'Nur die Person selbst oder die Spielleitung kann den Notfall beenden.' using errcode = '42501';
  end if;
  v_now := public.engine_now(g.id);
  update public.emergencies set status = 'erledigt', resolved_by = auth.uid(), resolved_at = v_now where id = v_e.id;
  select * into v_p from public.participants where id = v_e.participant_id;
  if v_p.state = 'notfall' then
    update public.participants set state = coalesce(state_before, 'aktiv'), state_before = null where id = v_p.id;
  end if;
  perform public.close_live_windows(v_p.id, 'notfall', v_now);
  perform public.notify(g.id, 'alle', null, 'emergency_end',
    case when v_me.id = v_e.participant_id then 'Notfall abgebrochen' else 'Notfall erledigt' end,
    public.pname(v_p.id) || case when v_me.id = v_e.participant_id then ': alles in Ordnung (Fehlalarm oder erledigt).' else '' end, '{}', 'hoch');
  perform public.bump(g.id);
end; $$;

create or replace function public.emergency_contact(p_game_id uuid, p_participant uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  -- Spielleitung immer; Hunter nur bei einem offenen Notfall dieser Person.
  if not (public.is_game_leader(p_game_id)
          or (exists (select 1 from public.participants where game_id = p_game_id and user_id = auth.uid() and role in ('hunter', 'zentrale'))
              and exists (select 1 from public.emergencies where game_id = p_game_id and participant_id = p_participant and status = 'offen'))) then
    raise exception 'Nur Spielleitung, oder Hunter bei einem Notfall.' using errcode = '42501';
  end if;
  select jsonb_build_object('name', pp.emergency_contact_name, 'phone', pp.emergency_contact_phone) into v
  from public.participants p join public.profile_private pp on pp.user_id = p.user_id where p.id = p_participant and p.game_id = p_game_id;
  perform public.log_game_event(p_game_id, 'emergency_contact_viewed', jsonb_build_object('participant', p_participant));
  return v;
end; $$;

create or replace function public.send_message(p_game_id uuid, p_channel text, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_me public.participants;
  g public.games;
begin
  v_me := public.require_participant(p_game_id);
  select * into g from public.games where id = p_game_id;
  if p_channel = 'ankuendigung' and v_me.role <> 'gm'
     and not (public.is_game_host(p_game_id) and v_me.role not in ('spieler', 'hunter', 'zentrale')) then
    raise exception 'Nur die Spielleitung kündigt an.' using errcode = '42501';
  elsif p_channel = 'taskforce' and v_me.role not in ('hunter', 'zentrale', 'gm') then
    raise exception 'Nur für die Taskforce.' using errcode = '42501';
  elsif p_channel = 'spieler' and v_me.role <> 'gm' then
    raise exception 'Spieler schreiben nur mit der Spielleitung.' using errcode = '42501';
  elsif p_channel like 'gm:%' and v_me.role <> 'gm' and p_channel <> 'gm:' || v_me.id::text then
    raise exception 'Nicht dein Kanal.' using errcode = '42501';
  elsif p_channel not in ('ankuendigung', 'taskforce', 'spieler') and p_channel not like 'gm:%' then
    raise exception 'Unbekannter Kanal.' using errcode = 'P0001';
  end if;
  insert into public.messages (game_id, channel, sender_id, sender_name, body, at)
  values (p_game_id, p_channel, auth.uid(), public.pname(v_me.id), trim(p_body), now());
end; $$;

revoke all on function public.grant_jokers(public.games, timestamptz) from public, anon, authenticated;
revoke all on function public.check_player_zone(public.games, public.participants, extensions.geometry, timestamptz) from public, anon, authenticated;
