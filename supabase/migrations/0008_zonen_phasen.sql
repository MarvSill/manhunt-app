-- Spielfeld-Phasen: Verkleinerung auch alle X Minuten (nicht nur pro Spieltag),
-- Prüfungen der Karte beim Start (Treffpunkt und Exit im Spielfeld, nicht in Sperrzonen).
-- Spielfeld-Zonen mit day_index meinen ab jetzt "Phase": pro Spieltag oder pro Zeitabschnitt.

-- Minuten pro Phase (0 = eine Phase pro Spieltag).
create or replace function public.shrink_every_minutes(p_cfg jsonb)
returns int language sql immutable as $$
  select case when public.cfg_text(p_cfg, 'zone', 'shrink_mode', 'manuell') = 'aus' then 0
    else greatest(0, public.cfg_int(p_cfg, 'zone', 'shrink_every_minutes', 0)) end;
$$;

-- Anzahl Phasen des Spiels.
create or replace function public.phase_count(p_cfg jsonb)
returns int language sql immutable as $$
  select case when public.shrink_every_minutes(p_cfg) > 0
    then least(50, greatest(1, ceil(public.cfg_int(p_cfg, 'game', 'duration_minutes', 5760)::numeric / public.shrink_every_minutes(p_cfg))::int))
    else public.cfg_int(p_cfg, 'game', 'days', 4) end;
$$;

-- Beginn einer Phase.
create or replace function public.phase_start(p_game public.games, p_phase int)
returns timestamptz language sql stable set search_path = public as $$
  select case when public.shrink_every_minutes(p_game.config_json) > 0
    then p_game.hunt_start_at + make_interval(mins => (greatest(p_phase, 1) - 1) * public.shrink_every_minutes(p_game.config_json))
    else public.day_start(p_game, p_phase) end;
$$;

-- Aktuelle Phase für das Spielfeld (bei Zeit-Phasen aus dem Spielzustand, sonst der Spieltag).
create or replace function public.field_phase(p_game_id uuid, p_day int)
returns int language sql stable security definer set search_path = public as $$
  select case when public.shrink_every_minutes(g.config_json) > 0
    then coalesce((g.state_json ->> 'phase')::int, 1) else p_day end
  from public.games g where g.id = p_game_id;
$$;

-- Nächste Phase aktivieren (Zeit-Phasen).
create or replace function public.phase_advance(p_game public.games, p_now timestamptz)
returns public.games language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_phase int := coalesce((p_game.state_json ->> 'phase')::int, 1) + 1;
  v_next timestamptz;
  v_grace int := public.cfg_int(v_cfg, 'zone', 'shrink_grace_minutes', 0);
begin
  v_next := public.phase_start(p_game, v_phase + 1);
  if v_phase >= public.phase_count(v_cfg) or v_next >= p_game.ends_at then v_next := null; end if;
  update public.games set state_json = state_json || jsonb_build_object('phase', v_phase, 'next_phase_at', v_next)
  where id = p_game.id returning * into p_game;
  if exists (select 1 from public.zones where game_id = p_game.id and kind = 'spielfeld' and day_index = v_phase) then
    if v_grace > 0 then
      update public.participants set grace_until = p_now + make_interval(mins => v_grace) where game_id = p_game.id and role = 'spieler';
    end if;
    perform public.recheck_zones(p_game, p_now);
    perform public.notify(p_game.id, 'alle', null, 'zone_active', 'Das Spielfeld ist jetzt kleiner',
      'Phase ' || v_phase || ' von ' || public.phase_count(v_cfg) || ': neue Grenzen gelten ab sofort.', '{}', 'hoch');
    update public.games set map_version = map_version + 1 where id = p_game.id returning * into p_game;
    perform public.log_game_event(p_game.id, 'phase', jsonb_build_object('phase', v_phase));
  end if;
  return p_game;
end; $$;

-- Ankündigung der nächsten Phase (Zeit-Phasen).
create or replace function public.phase_announce(p_game public.games, p_now timestamptz)
returns public.games language plpgsql security definer set search_path = public as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_next timestamptz := (p_game.state_json ->> 'next_phase_at')::timestamptz;
  v_phase int := coalesce((p_game.state_json ->> 'phase')::int, 1) + 1;
begin
  if v_next is null then return p_game; end if;
  if v_next - make_interval(mins => public.cfg_int(v_cfg, 'zone', 'shrink_announce_minutes', 180)) > p_now then return p_game; end if;
  if coalesce((p_game.state_json ->> 'announced_phase')::int, 0) >= v_phase then return p_game; end if;
  if not exists (select 1 from public.zones where game_id = p_game.id and kind = 'spielfeld' and day_index = v_phase) then return p_game; end if;
  update public.games set state_json = state_json || jsonb_build_object('announced_phase', v_phase), map_version = map_version + 1
  where id = p_game.id returning * into p_game;
  perform public.notify(p_game.id, 'alle', null, 'zone_announce', 'Spielfeld wird kleiner um ' || to_char(v_next at time zone p_game.timezone, 'HH24:MI'),
    'Die neuen Grenzen sind auf der Karte gestrichelt.', '{}', 'hoch');
  return p_game;
end; $$;

revoke execute on function public.shrink_every_minutes(jsonb), public.phase_count(jsonb), public.phase_start(public.games, int),
  public.field_phase(uuid, int), public.phase_advance(public.games, timestamptz), public.phase_announce(public.games, timestamptz)
  from public, anon, authenticated;


create or replace function public.allowed_area(p_game_id uuid, p_participant_id uuid, p_day int, p_sections boolean)
returns extensions.geometry language plpgsql stable security definer set search_path = public, extensions as $$
declare v extensions.geometry;
begin
  if p_sections then
    select ST_Union(geom) into v from public.zones
    where game_id = p_game_id and (
      (kind = 'sektion' and (owner_participant_id = p_participant_id or released))
      or kind in ('startzone', 'center')
    );
    return v;
  end if;
  v := public.spielfeld_day(p_game_id, public.field_phase(p_game_id, p_day));
  if v is null then
    select ST_Union(geom) into v from public.zones where game_id = p_game_id and kind in ('sektion', 'startzone', 'center');
  end if;
  return v;
end; $$;

create or replace function public.day_reset(p_game public.games, p_now timestamptz)
returns public.games language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_day int := p_game.current_day + 1;
  v_days int := public.cfg_int(v_cfg, 'game', 'days', 4);
  v_next timestamptz;
  v_grace int := public.cfg_int(v_cfg, 'zone', 'shrink_grace_minutes', 0);
  v_left int;
  v_changed boolean;
begin
  -- 1. Spieltag-Zähler
  v_next := case when v_day < v_days then public.day_start(p_game, v_day + 1) end;
  if v_next is not null and v_next >= p_game.ends_at then v_next := null; end if;
  v_left := public.speedhunt_quota(v_cfg, v_day)
    + case when public.cfg_bool(v_cfg, 'speedhunt', 'carry_over', false) then p_game.speedhunts_left else 0 end;
  update public.games set current_day = v_day, next_day_at = v_next, speedhunts_left = v_left where id = p_game.id
  returning * into p_game;

  -- 2. Neues Spielfeld
  v_changed := public.shrink_every_minutes(v_cfg) = 0 and exists (select 1 from public.zones where game_id = p_game.id and kind = 'spielfeld' and day_index = v_day);
  if v_changed then
    if v_grace > 0 then
      update public.participants set grace_until = p_now + make_interval(mins => v_grace) where game_id = p_game.id and role = 'spieler';
    end if;
    perform public.recheck_zones(p_game, p_now);
    perform public.notify(p_game.id, 'alle', null, 'zone_active', 'Das Spielfeld hat sich geändert', 'Spieltag ' || v_day || ': neue Grenzen gelten jetzt.', '{}', 'hoch');
    update public.games set map_version = map_version + 1 where id = p_game.id;
  end if;

  -- 3. Budget
  if public.cfg_bool(v_cfg, 'budget', 'enabled', false) then
    update public.participants set budget_balance = case when public.cfg_bool(v_cfg, 'budget', 'allow_saving', false)
      then budget_balance + public.cfg_int(v_cfg, 'budget', 'daily_amount', 30) else public.cfg_int(v_cfg, 'budget', 'daily_amount', 30) end
    where game_id = p_game.id and role = 'spieler';
  end if;

  -- 4. Joker
  perform public.grant_jokers(p_game, p_now);

  -- 5. Boni verfallen
  if public.cfg_bool(v_cfg, 'bonus', 'expire_at_day_reset', true) then
    update public.inventory_items set expired = true where game_id = p_game.id and kind = 'bonus' and used_at is null and not expired;
    update public.active_effects set ends_at = p_now, payload = payload || '{"done": true}'
      where game_id = p_game.id and type = 'fake_ping' and (ends_at is null or ends_at > p_now);
  end if;

  -- 6. ÖV-Nachlauf und Fähren-Zähler zurücksetzen; Ausserhalb-Zeit pro Tag
  update public.participants set rides_today = 0, ferry_stops_today = 0,
    out_accum_s = case when public.cfg_text(v_cfg, 'out_of_bounds', 'count_mode', 'pro_ausflug') = 'pro_tag' then 0 else out_accum_s end
  where game_id = p_game.id;

  -- 7. Speedhunt-Kontingent (oben gesetzt), Zufalls-Speedhunts planen
  perform public.schedule_random_speedhunts(p_game, p_now);

  -- 9. Mitteilung
  if v_day > 1 then
    perform public.notify(p_game.id, 'alle', null, 'day_reset', 'Neuer Spieltag: ' || v_day || ' von ' || v_days,
      case when public.cfg_bool(v_cfg, 'speedhunt', 'enabled', true) then 'Speedhunts heute: ' || v_left else '' end, '{}', 'hoch');
  end if;
  if public.cfg_bool(v_cfg, 'taskforce', 'daily_briefing', false) then
    perform public.notify(p_game.id, 'taskforce', null, 'briefing', 'Einsatzbesprechung', 'Bitte trefft euch und bestätigt das Briefing.', '{}', 'normal');
  end if;
  perform public.log_game_event(p_game.id, 'day_reset', jsonb_build_object('day', v_day));
  return p_game;
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

create or replace function public.start_game(p_game_id uuid, p_test boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  g public.games;
  v_cfg jsonb;
  v_now timestamptz := now();
  v_players int;
  v_hunters int;
  v_open int;
  v_field extensions.geometry;
  v_exit uuid;
  v_days int;
  v_d int;
  v_center extensions.geometry;
  v_factor double precision;
  v_z public.zones;
  v_sec record;
  v_i int := 0;
  v_ids uuid[];
begin
  if not public.is_game_host(p_game_id) then raise exception 'Nur der Host kann das Spiel starten.' using errcode = '42501'; end if;
  select * into g from public.games where id = p_game_id for update;
  if g.status not in ('entwurf', 'geplant', 'lobby') then raise exception 'Das Spiel wurde schon gestartet.' using errcode = 'P0001'; end if;
  v_cfg := g.config_json;
  select count(*) filter (where role = 'spieler'), count(*) filter (where role in ('hunter', 'zentrale')), count(*) filter (where role = 'offen')
    into v_players, v_hunters, v_open from public.participants where game_id = p_game_id;
  if v_open > 0 then raise exception 'Noch % Person(en) ohne Rolle.', v_open using errcode = 'P0001'; end if;
  if v_players < 1 then raise exception 'Mindestens 1 Spieler nötig.' using errcode = 'P0001'; end if;
  if v_hunters < 1 then raise exception 'Mindestens 1 Hunter nötig.' using errcode = 'P0001'; end if;
  if v_players > public.cfg_int(v_cfg, 'roles', 'players_max', 9) then raise exception 'Zu viele Spieler für die Regeln.' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.zones where game_id = p_game_id and kind in ('spielfeld', 'sektion')) then
    raise exception 'Zeichne zuerst ein Spielfeld auf der Karte.' using errcode = 'P0001';
  end if;
  if public.cfg_bool(v_cfg, 'exit', 'enabled', true) and public.cfg_text(v_cfg, 'win', 'mode', 'alle_ueberlebenden') <> 'letzter_ueberlebender'
     and not exists (select 1 from public.zones where game_id = p_game_id and kind = 'exit') then
    raise exception 'Setze mindestens einen Exitpoint-Kandidaten auf der Karte (oder schalte den Exitpoint aus).' using errcode = 'P0001';
  end if;

  -- Kartenprüfungen (22.4)
  if exists (
    select 1 from public.zones t
    where t.game_id = p_game_id and t.kind = 'treffpunkt'
      and public.spielfeld_day(p_game_id, 1) is not null
      and not ST_DWithin(public.spielfeld_day(p_game_id, 1)::geography, t.geom::geography, 25)
  ) then
    raise exception 'Der Treffpunkt liegt ausserhalb des Spielfelds.' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.zones p join public.zones s on s.game_id = p.game_id and s.kind = 'sperrzone'
    where p.game_id = p_game_id and p.kind in ('treffpunkt', 'exit', 'hq') and ST_Intersects(s.geom, p.geom)
  ) then
    raise exception 'Treffpunkt, HQ oder ein Exitpoint liegt in einer Sperrzone.' using errcode = 'P0001';
  end if;

  -- Exitpoint auswählen (zufällig oder der erste Kandidat)
  if public.cfg_bool(v_cfg, 'exit', 'enabled', true) then
    select id into v_exit from public.zones where game_id = p_game_id and kind = 'exit'
    order by case when public.cfg_bool(v_cfg, 'exit', 'random_from_candidates', true) then random() else 0 end, created_at limit 1;
    -- Nicht gewählte Kandidaten bleiben für immer verborgen.
    update public.zones set visible_to = 'gm' where game_id = p_game_id and kind = 'exit' and id <> v_exit;
    update public.zones set visible_to = 'gm' where id = v_exit;
  end if;

  -- Automatische Verkleinerung: Spielfeld je Tag um x % (Fläche) um den Exit bzw. Mittelpunkt (7.1).
  -- Phasen: pro Spieltag oder alle X Minuten.
  v_days := public.phase_count(v_cfg);
  if public.cfg_text(v_cfg, 'zone', 'shrink_mode', 'manuell') = 'auto' and v_days > 1
     and not exists (select 1 from public.zones where game_id = p_game_id and kind = 'spielfeld' and day_index is not null) then
    v_field := public.spielfeld_day(p_game_id, 1);
    if v_field is not null then
      select coalesce((select geom from public.zones where id = v_exit), ST_Centroid(v_field)) into v_center;
      if not ST_Covers(v_field, v_center) then v_center := ST_PointOnSurface(v_field); end if;
      update public.zones set day_index = 1 where game_id = p_game_id and kind = 'spielfeld' and day_index is null;
      for v_d in 2..v_days loop
        v_factor := sqrt(power(1 - public.cfg_int(v_cfg, 'zone', 'auto_shrink_percent', 20) / 100.0, v_d - 1));
        insert into public.zones (game_id, kind, name, geom, day_index)
        values (p_game_id, 'spielfeld', case when public.shrink_every_minutes(v_cfg) > 0 then 'Spielfeld Phase ' else 'Spielfeld Tag ' end || v_d,
          ST_Translate(ST_Scale(ST_Translate(v_field, -ST_X(v_center), -ST_Y(v_center)), v_factor, v_factor), ST_X(v_center), ST_Y(v_center)), v_d);
      end loop;
    end if;
  end if;

  -- Spielfelder künftiger Tage erst mit der Ankündigung sichtbar
  for v_z in select * from public.zones where game_id = p_game_id and kind = 'spielfeld' and day_index > 1 loop
    update public.zones set visible_from = 'infinity' where id = v_z.id;
  end loop;

  -- Sektionen zuweisen (falls nicht schon manuell vergeben)
  if public.cfg_bool(v_cfg, 'zone', 'sections_per_player', false) then
    select array_agg(id order by random()) into v_ids from public.participants where game_id = p_game_id and role = 'spieler';
    for v_sec in select id from public.zones where game_id = p_game_id and kind = 'sektion' and owner_participant_id is null order by created_at loop
      exit when v_i >= coalesce(array_length(v_ids, 1), 0);
      v_i := v_i + 1;
      if not exists (select 1 from public.zones where game_id = p_game_id and kind = 'sektion' and owner_participant_id = v_ids[v_i]) then
        update public.zones set owner_participant_id = v_ids[v_i] where id = v_sec.id;
      end if;
    end loop;
  end if;

  update public.participants set state = 'aktiv', out_accum_s = 0, ready = true where game_id = p_game_id;
  update public.games set
    status = 'vorsprung',
    is_test = p_test,
    clock_offset = interval '0',
    hunt_start_at = v_now + make_interval(mins => public.cfg_int(v_cfg, 'start', 'head_start_minutes', 60)),
    exit_zone_id = v_exit,
    last_tick_at = v_now,
    current_day = 0,
    state_json = '{}'
  where id = p_game_id returning * into g;
  update public.games set
    start_at = v_now,
    ends_at = g.hunt_start_at + make_interval(mins => public.cfg_int(v_cfg, 'game', 'duration_minutes', 5760)),
    deadline_at = g.hunt_start_at + make_interval(mins => public.cfg_int(v_cfg, 'game', 'duration_minutes', 5760)
      + case when v_exit is not null then public.cfg_int(v_cfg, 'exit', 'arrival_deadline_offset_minutes', 15) else 0 end),
    exit_reveal_at = case when v_exit is not null then g.hunt_start_at
      + make_interval(mins => greatest(0, public.cfg_int(v_cfg, 'game', 'duration_minutes', 5760) - public.cfg_int(v_cfg, 'exit', 'reveal_minutes_before_end', 120))) end
  where id = p_game_id returning * into g;
  if public.shrink_every_minutes(v_cfg) > 0 then
    update public.games set state_json = state_json || jsonb_build_object('phase', 1, 'next_phase_at',
      case when public.phase_count(v_cfg) > 1 and public.phase_start(g, 2) < g.ends_at then public.phase_start(g, 2) end)
    where id = p_game_id returning * into g;
  end if;
  -- Zukünftige Spielfelder werden zur Ankündigungszeit sichtbar
  for v_z in select * from public.zones where game_id = p_game_id and kind = 'spielfeld' and day_index > 1 loop
    update public.zones set visible_from = public.phase_start(g, v_z.day_index) - make_interval(mins => public.cfg_int(v_cfg, 'zone', 'shrink_announce_minutes', 180))
    where id = v_z.id;
  end loop;

  perform public.notify(p_game_id, 'spieler', null, 'game_start', 'Los! Ihr habt Vorsprung',
    public.cfg_int(v_cfg, 'start', 'head_start_minutes', 60) || ' min, dann startet die Jagd.', '{}', 'kritisch');
  perform public.notify(p_game_id, 'taskforce', null, 'game_start', 'Spiel gestartet',
    'Bleibt im HQ. Die Jagd beginnt um ' || to_char(g.hunt_start_at at time zone g.timezone, 'HH24:MI') || '.', '{}', 'kritisch');
  perform public.log_game_event(p_game_id, 'game_started', jsonb_build_object('test', p_test));
  perform public.tick_game(p_game_id);
  perform public.bump(p_game_id);
  return jsonb_build_object('hunt_start_at', g.hunt_start_at, 'ends_at', g.ends_at);
end; $$;

create or replace function public.resume_game(p_game_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  v_now timestamptz;
  d interval;
  v_ext boolean;
begin
  if not public.is_game_leader(p_game_id) then raise exception 'Nur Host oder Spielleitung.' using errcode = '42501'; end if;
  select * into g from public.games where id = p_game_id for update;
  if g.paused_at is null then return; end if;
  v_now := public.engine_now(p_game_id);
  d := v_now - g.paused_at;
  v_ext := public.cfg_bool(g.config_json, 'game', 'pause_extends_game', true);
  update public.games set paused_at = null, pause_reason = null, last_tick_at = v_now,
    hunt_start_at = case when status = 'vorsprung' then hunt_start_at + d else hunt_start_at end,
    ends_at = case when v_ext then ends_at + d else ends_at end,
    deadline_at = case when v_ext then deadline_at + d else deadline_at end,
    exit_reveal_at = case when v_ext then exit_reveal_at + d else exit_reveal_at end,
    next_day_at = case when v_ext then next_day_at + d else next_day_at end
  where id = p_game_id;
  update public.participants set next_ping_at = next_ping_at + d, ping_pending_until = ping_pending_until + d,
    grace_until = grace_until + d, out_pending_since = out_pending_since + d, stationary_since = stationary_since + d,
    speeding_since = speeding_since + d, transport_prompted_at = transport_prompted_at + d
  where game_id = p_game_id;
  update public.speedhunts set deadline_at = deadline_at + d where game_id = p_game_id and status = 'laeuft';
  update public.active_effects set ends_at = ends_at + d where game_id = p_game_id and ends_at > g.paused_at;
  update public.live_windows set ends_at = ends_at + d where game_id = p_game_id and ends_at > g.paused_at;
  update public.violations set auto_apply_at = auto_apply_at + d where game_id = p_game_id and status = 'offen';
  update public.catches set expires_at = expires_at + d where game_id = p_game_id and expires_at > g.paused_at;
  update public.challenges set starts_at = starts_at + d, ends_at = ends_at + d, announce_at = announce_at + d
    where game_id = p_game_id and status in ('geplant', 'angekuendigt', 'laeuft');
  update public.games set state_json = jsonb_set(state_json, '{next_phase_at}', to_jsonb((state_json ->> 'next_phase_at')::timestamptz + d))
    where id = p_game_id and v_ext and (state_json ->> 'next_phase_at') is not null;
  update public.zones set visible_from = visible_from + d where game_id = p_game_id and visible_from > g.paused_at and visible_from <> 'infinity' and v_ext;
  perform public.notify(p_game_id, 'alle', null, 'resume', 'Weiter geht''s!', 'Das Spiel läuft wieder.', '{}', 'kritisch');
  perform public.log_game_event(p_game_id, 'resumed', jsonb_build_object('seconds', extract(epoch from d)::int));
  perform public.bump(p_game_id);
end; $$;

create or replace function public.game_state(p_game_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  g public.games;
  v_cfg jsonb;
  me public.participants;
  v_role text;
  v_now timestamptz;
  v_tf boolean;
  v_gm boolean;
  v_ended boolean;
  v_delay int;
  v_hist int;
  v_out jsonb;
begin
  select * into g from public.games where id = p_game_id;
  select * into me from public.participants where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'Du bist nicht in diesem Spiel.' using errcode = '42501'; end if;
  v_cfg := g.config_json;
  v_role := me.role;
  v_now := now() + g.clock_offset;
  v_gm := v_role = 'gm';
  v_tf := v_role in ('hunter', 'zentrale');
  v_ended := g.status in ('beendet', 'archiviert');
  v_delay := public.cfg_int(v_cfg, 'spectator', 'delay_minutes', 30);
  v_hist := public.cfg_int(v_cfg, 'ping', 'history_per_player', 5);

  v_out := jsonb_build_object(
    'now', v_now,
    'server_now', now(),
    'game', jsonb_build_object(
      'id', g.id, 'name', g.name, 'code', g.code, 'status', g.status, 'is_test', g.is_test, 'host', g.host_id = auth.uid(),
      'start_at', g.start_at, 'hunt_start_at', g.hunt_start_at, 'ends_at', g.ends_at, 'deadline_at', g.deadline_at,
      'next_day_at', g.next_day_at, 'current_day', g.current_day,
      'phase', public.field_phase(g.id, g.current_day), 'phase_count', public.phase_count(v_cfg),
      'next_phase_at', case when public.shrink_every_minutes(v_cfg) > 0 then (g.state_json ->> 'next_phase_at')::timestamptz else g.next_day_at end, 'paused', g.paused_at is not null, 'pause_reason', g.pause_reason,
      'timezone', g.timezone, 'speedhunts_left', g.speedhunts_left, 'exit_revealed', g.exit_revealed, 'exit_reveal_at', g.exit_reveal_at,
      'map_version', g.map_version, 'result', g.result_json, 'meeting_point', g.meeting_point, 'config', v_cfg, 'group_id', g.group_id,
      'quiet', public.in_quiet_hours(g, v_now)
    ),
    'me', jsonb_build_object(
      'id', me.id, 'role', me.role, 'state', me.state, 'budget', me.budget_balance, 'bounty', me.bounty,
      'next_ping_at', case when v_role = 'spieler' then me.next_ping_at end,
      'location_requested', me.location_request_at is not null,
      'hideout_prompt', me.hideout_prompted_at is not null and not exists (select 1 from public.hideouts where participant_id = me.id and status = 'aktiv' and inside),
      'transport_prompt', me.transport_prompted_at is not null,
      'out_accum_s', me.out_accum_s, 'out_pending', me.out_pending_since is not null, 'in_restricted', me.restricted_zone_id is not null,
      'briefing_done', me.briefing_done_day = g.current_day,
      'live', public.has_live_window(me.id, v_now),
      'effects', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'type', e.type, 'ends_at', e.ends_at, 'payload', e.payload)), '[]')
                  from public.active_effects e where e.participant_id = me.id and e.starts_at <= v_now and (e.ends_at is null or e.ends_at > v_now) and not (e.payload ? 'done')),
      'inventory', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'type', i.type, 'minutes', i.minutes, 'source', i.source) order by i.granted_at), '[]')
                    from public.inventory_items i where i.participant_id = me.id and i.used_at is null and not i.expired),
      'hideout', (select jsonb_build_object('id', h.id, 'inside', h.inside, 'accum_s', h.accum_s, 'entered_at', h.entered_at,
                    'max_s', public.cfg_int(v_cfg, 'hideout', 'max_minutes', 120) * 60, 'lat', ST_Y(h.center), 'lng', ST_X(h.center))
                  from public.hideouts h where h.participant_id = me.id and h.status = 'aktiv' limit 1),
      'transit', (select jsonb_build_object('id', t.id, 'mode', t.mode, 'line', t.line, 'started_at', t.started_at)
                  from public.transit_sessions t where t.participant_id = me.id and t.ended_at is null limit 1),
      'device_check', me.device_check
    ),
    'participants', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', pr.display_name, 'username', pr.username, 'role', p.role, 'color', p.color,
        'state', case when v_gm or v_ended or p.id = me.id or p.state in ('gefangen', 'disqualifiziert', 'aufgegeben', 'im_ziel', 'verloren', 'ausserhalb', 'notfall') then p.state else 'aktiv' end,
        'battery', case when v_gm or (v_tf and p.role in ('hunter', 'zentrale')) then p.battery end,
        'last_seen_at', case when v_gm then p.last_seen_at end,
        'bounty', p.bounty,
        'budget', case when v_gm then p.budget_balance end,
        'device_check', case when v_gm or p.id = me.id or g.status in ('lobby', 'geplant', 'entwurf') then p.device_check end,
        'next_ping_at', case when (v_tf and public.cfg_bool(v_cfg, 'ping', 'reveal_schedule_to_taskforce', true)) or v_gm then p.next_ping_at end,
        'protected', case when v_tf or v_gm then (public.has_effect(p.id, 'regeneration', v_now) or public.has_effect(p.id, 'hotel', v_now)) end,
        'catch_free', case when v_tf or v_gm then public.has_effect(p.id, 'catch_free', v_now) end,
        'briefing_done', p.briefing_done_day = g.current_day
      ) order by p.role, pr.display_name), '[]')
      from public.participants p join public.profiles pr on pr.user_id = p.user_id
      where p.game_id = g.id
    ),
    -- Positionen: Spielleitung alles, Taskforce die eigenen Leute und Spieler im Live-Fenster,
    -- Spieler nur sich selbst, Zuschauer verzögert (5.2, 7.18).
    'positions', (
      select coalesce(jsonb_agg(jsonb_build_object('participant_id', x.participant_id, 'lat', x.lat, 'lng', x.lng, 'accuracy_m', x.accuracy_m,
        'speed_mps', x.speed_mps, 'heading', x.heading, 'at', x.at, 'live', x.live)), '[]')
      from (
        select pos.participant_id, pos.lat, pos.lng, pos.accuracy_m, pos.speed_mps, pos.heading, pos.at,
               public.has_live_window(pos.participant_id, v_now) live
        from public.positions pos join public.participants p on p.id = pos.participant_id
        where pos.game_id = g.id and v_role <> 'zuschauer' and (
          v_gm or v_ended or pos.participant_id = me.id
          or (v_tf and p.role in ('hunter', 'zentrale') and public.cfg_bool(v_cfg, 'taskforce', 'share_positions_internally', true))
          or (v_tf and p.role = 'spieler' and public.has_live_window(p.id, v_now) and p.state in ('aktiv', 'ausserhalb', 'notfall'))
          or (v_role = 'spieler' and p.role = 'spieler' and p.state = 'notfall')
        )
        union all
        (select distinct on (s.participant_id) s.participant_id, ST_Y(s.geom), ST_X(s.geom), s.accuracy_m, s.speed_mps, s.heading, s.at, false
        from public.location_samples s
        where s.game_id = g.id and v_role = 'zuschauer' and public.cfg_bool(v_cfg, 'spectator', 'enabled', false)
          and s.at <= v_now - make_interval(mins => v_delay)
        order by s.participant_id, s.at desc)
      ) x
    ),
    -- Pings: Taskforce sieht die letzten n je Spieler (ohne Fake-Markierung), Spieler die eigenen,
    -- Spielleitung alles inkl. echter Position, Zuschauer verzögert.
    'pings', (
      select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'participant_id', x.participant_id, 'at', x.at, 'lat', x.lat, 'lng', x.lng,
        'accuracy_m', x.accuracy_m, 'source', x.source, 'n', x.n, 'speedhunt_id', x.speedhunt_id, 'zone_kind', x.zone_kind, 'label', x.label,
        'stale_seconds', x.stale_seconds,
        'is_fake', case when v_gm or v_ended or x.participant_id = me.id then x.is_fake end,
        'truth', case when (v_gm or v_ended) and x.is_fake then (select jsonb_build_object('lat', t.lat, 'lng', t.lng) from public.ping_truth t where t.ping_id = x.id) end
      ) order by x.at), '[]')
      from (
        select pg.*, row_number() over (partition by pg.participant_id order by pg.at desc) rn
        from public.pings pg
        where pg.game_id = g.id and (
          v_gm or v_ended
          or (v_tf and pg.visible_at <= v_now)
          or (v_role = 'spieler' and pg.participant_id = me.id)
          or (v_role = 'zuschauer' and public.cfg_bool(v_cfg, 'spectator', 'enabled', false) and pg.visible_at <= v_now - make_interval(mins => v_delay))
        )
      ) x where x.rn <= case when v_gm or v_ended then 1000 else v_hist end
    ),
    'speedhunts', (
      select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'status', s.status, 'is_penalty', s.is_penalty,
        'target_id', case when v_gm or v_tf or v_ended or (s.target_id = me.id and public.cfg_bool(v_cfg, 'speedhunt', 'reveal_target_to_target', false)) then s.target_id end,
        'queries_total', s.queries_total, 'queries_used', s.queries_used, 'started_at', s.started_at, 'deadline_at', s.deadline_at,
        'last_query_at', s.last_query_at, 'ended_at', s.ended_at, 'end_reason', s.end_reason, 'day_index', s.day_index) order by s.created_at desc), '[]')
      from public.speedhunts s where s.game_id = g.id and (s.status in ('laeuft', 'wartet_auf_freigabe', 'aufgeschoben') or s.ended_at > v_now - interval '2 hours' or v_gm or v_ended)
        and (s.status <> 'wartet_auf_freigabe' or v_gm or v_tf) and (s.status <> 'aufgeschoben' or v_gm or v_tf)
        and not (s.status = 'beendet' and s.started_at is null and not v_gm)
    ),
    'catches', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'runner_id', c.runner_id, 'hunter_id', c.hunter_id, 'at', c.at, 'method', c.method,
        'status', c.status, 'expires_at', c.expires_at, 'distance_m', c.distance_m, 'reason', c.reason, 'lat', case when v_gm or v_ended then c.lat end,
        'lng', case when v_gm or v_ended then c.lng end) order by c.at desc), '[]')
      from public.catches c where c.game_id = g.id and (c.status = 'gueltig' or v_gm or c.runner_id = me.id or c.hunter_id = me.id)
    ),
    'violations', (
      select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'participant_id', v.participant_id, 'type', v.type, 'at', v.at, 'evidence', v.evidence,
        'proposed_penalty', v.proposed_penalty, 'decided_penalty', v.decided_penalty, 'status', v.status, 'auto_apply_at', v.auto_apply_at,
        'explanation', v.explanation, 'detected_by', v.detected_by) order by v.at desc), '[]')
      from public.violations v where v.game_id = g.id and (v_gm or v.participant_id = me.id or v_ended)
    ),
    'challenges', (
      select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'description', c.description, 'template', c.template,
        'lat', case when v_role <> 'zuschauer' and (not v_tf or c.reveal_location_to_taskforce) then c.lat end,
        'lng', case when v_role <> 'zuschauer' and (not v_tf or c.reveal_location_to_taskforce) then c.lng end,
        'radius_m', c.radius_m, 'starts_at', c.starts_at, 'ends_at', c.ends_at, 'announce_at', c.announce_at, 'proof_type', c.proof_type,
        'secret_code', case when v_gm then c.secret_code end, 'reward_type', c.reward_type, 'reward_value', c.reward_value, 'status', c.status,
        'max_participants', c.max_participants,
        'entries', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'participant_id', e.participant_id, 'result', e.result, 'proof_path', case when v_gm then e.proof_path end, 'proof_text', case when v_gm then e.proof_text end)), '[]')
                    from public.challenge_entries e where e.challenge_id = c.id and (v_gm or e.participant_id = me.id or v_ended))
      ) order by c.starts_at), '[]')
      from public.challenges c where c.game_id = g.id and (v_gm or c.status <> 'geplant')
    ),
    'emergencies', (
      select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'participant_id', e.participant_id, 'at', e.at, 'lat', e.lat, 'lng', e.lng, 'status', e.status)), '[]')
      from public.emergencies e where e.game_id = g.id and e.status = 'offen' and (v_gm or v_tf or e.participant_id = me.id or public.is_game_host(g.id))
    ),
    'transits', (
      select coalesce(jsonb_agg(jsonb_build_object('participant_id', t.participant_id, 'mode', t.mode, 'line', t.line, 'from', t.from_station, 'to', t.to_station,
        'started_at', t.started_at)), '[]')
      from public.transit_sessions t where t.game_id = g.id and t.ended_at is null and (v_gm or v_tf or t.participant_id = me.id)
    ),
    'hideouts', (
      select coalesce(jsonb_agg(jsonb_build_object('participant_id', h.participant_id, 'inside', h.inside, 'accum_s', h.accum_s, 'lat', ST_Y(h.center), 'lng', ST_X(h.center))), '[]')
      from public.hideouts h where h.game_id = g.id and h.status = 'aktiv' and v_gm
    ),
    'purchases', (
      select coalesce(jsonb_agg(jsonb_build_object('participant_id', u.participant_id, 'amount', u.amount, 'category', u.category, 'note', u.note, 'at', u.at) order by u.at desc), '[]')
      from public.purchases u where u.game_id = g.id and (v_gm or u.participant_id = me.id)
    ),
    'notifications', (
      select coalesce(jsonb_agg(x order by (x ->> 'id')::bigint desc), '[]') from (
        select jsonb_build_object('id', n.id, 'kind', n.kind, 'title', n.title, 'body', n.body, 'payload', n.payload, 'priority', n.priority, 'at', n.at) x
        from public.notifications n where n.game_id = g.id and public.can_see_notification(n)
        order by n.id desc limit 60
      ) q
    ),
    'next_silent_ping_at', case when v_gm or (v_tf and public.cfg_bool(v_cfg, 'ping', 'reveal_schedule_to_taskforce', true))
      then (select min(next_ping_at) from public.participants where game_id = g.id and role = 'spieler' and state in ('aktiv', 'ausserhalb')) end,
    'free_players', public.free_players(g.id)
  );
  return v_out;
end; $$;
