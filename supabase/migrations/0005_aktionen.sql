-- Schritt 3 bis 8: Aktionen der Teilnehmenden (Kapitel 7, 9, 10).
-- Jede Aktion prüft Rolle, Spielstatus und Regeln serverseitig.

-- ---------------------------------------------------------------------------
-- Hilfen
-- ---------------------------------------------------------------------------

create or replace function public.require_participant(p_game_id uuid, p_roles text[] default null)
returns public.participants language plpgsql stable security definer set search_path = public as $$
declare v public.participants;
begin
  select * into v from public.participants where game_id = p_game_id and user_id = auth.uid();
  if v.id is null then raise exception 'Du bist nicht in diesem Spiel.' using errcode = '42501'; end if;
  if p_roles is not null and not (v.role = any (p_roles)) then
    raise exception 'Das darf deine Rolle nicht.' using errcode = '42501';
  end if;
  return v;
end; $$;

create or replace function public.require_running(p_game_id uuid, p_allow_vorsprung boolean default false)
returns public.games language plpgsql stable security definer set search_path = public as $$
declare g public.games;
begin
  select * into g from public.games where id = p_game_id;
  if g.status = 'beendet' then raise exception 'Das Spiel ist beendet.' using errcode = 'P0001'; end if;
  if g.paused_at is not null then raise exception 'Das Spiel ist pausiert.' using errcode = 'P0001'; end if;
  if g.status not in ('laeuft', 'finale') and not (p_allow_vorsprung and g.status = 'vorsprung') then
    raise exception 'Das Spiel läuft noch nicht.' using errcode = 'P0001';
  end if;
  return g;
end; $$;

create or replace function public.is_game_leader(p_game_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_game_host(p_game_id) or public.is_game_gm(p_game_id);
$$;

-- ---------------------------------------------------------------------------
-- Spielstart (6.3)
-- ---------------------------------------------------------------------------

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

  -- Exitpoint auswählen (zufällig oder der erste Kandidat)
  if public.cfg_bool(v_cfg, 'exit', 'enabled', true) then
    select id into v_exit from public.zones where game_id = p_game_id and kind = 'exit'
    order by case when public.cfg_bool(v_cfg, 'exit', 'random_from_candidates', true) then random() else 0 end, created_at limit 1;
    -- Nicht gewählte Kandidaten bleiben für immer verborgen.
    update public.zones set visible_to = 'gm' where game_id = p_game_id and kind = 'exit' and id <> v_exit;
    update public.zones set visible_to = 'gm' where id = v_exit;
  end if;

  -- Automatische Verkleinerung: Spielfeld je Tag um x % (Fläche) um den Exit bzw. Mittelpunkt (7.1).
  v_days := public.cfg_int(v_cfg, 'game', 'days', 4);
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
        values (p_game_id, 'spielfeld', 'Spielfeld Tag ' || v_d,
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
  -- Zukünftige Spielfelder werden zur Ankündigungszeit sichtbar
  for v_z in select * from public.zones where game_id = p_game_id and kind = 'spielfeld' and day_index > 1 loop
    update public.zones set visible_from = public.day_start(g, v_z.day_index) - make_interval(mins => public.cfg_int(v_cfg, 'zone', 'shrink_announce_minutes', 180))
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

-- Probelauf: Spielzeit vorspulen (22.6). Nur in Testspielen.
create or replace function public.advance_time(p_game_id uuid, p_minutes int)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  v_step int;
  v_left int := p_minutes;
begin
  if not public.is_game_leader(p_game_id) then raise exception 'Nur Host oder Spielleitung.' using errcode = '42501'; end if;
  select * into g from public.games where id = p_game_id;
  if not g.is_test then raise exception 'Vorspulen geht nur im Probelauf.' using errcode = 'P0001'; end if;
  if p_minutes < 1 or p_minutes > 1440 then raise exception 'Zwischen 1 und 1440 Minuten.' using errcode = 'P0001'; end if;
  -- In Schritten ticken, damit Timer in der richtigen Reihenfolge feuern.
  while v_left > 0 loop
    v_step := least(v_left, 5);
    update public.games set clock_offset = clock_offset + make_interval(mins => v_step) where id = p_game_id;
    -- Geräte gelten im Probelauf als durchgehend gemeldet: letzte Positionen mitverschieben.
    update public.positions set at = at + make_interval(mins => v_step) where game_id = p_game_id;
    update public.participants set last_seen_at = last_seen_at + make_interval(mins => v_step) where game_id = p_game_id;
    perform public.tick_game(p_game_id);
    v_left := v_left - v_step;
  end loop;
  return public.engine_now(p_game_id);
end; $$;

-- Client-Tick: hält das Spiel in Bewegung, auch wenn pg_cron fehlt.
create or replace function public.game_tick(p_game_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_game_member(p_game_id) then return; end if;
  perform public.tick_game(p_game_id);
end; $$;

-- ---------------------------------------------------------------------------
-- Standort (14.2)
-- p_samples: [{lat, lng, acc, speed, heading, age_s, battery, mock}]
-- ---------------------------------------------------------------------------

create or replace function public.report_location(p_game_id uuid, p_samples jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_p public.participants;
  g public.games;
  v_now timestamptz;
  s jsonb;
  v_last jsonb;
  v_at timestamptz;
  v_last_at timestamptz;
  v_geom extensions.geometry;
  v_battery int;
  v_warn int;
begin
  v_p := public.require_participant(p_game_id);
  select * into g from public.games where id = p_game_id;
  if g.status in ('beendet', 'archiviert') then return jsonb_build_object('stop', true); end if;
  if v_p.role in ('zuschauer') or (v_p.state in ('gefangen', 'disqualifiziert', 'aufgegeben', 'im_ziel', 'verloren')
     and not public.cfg_bool(g.config_json, 'catch', 'track_after_catch', false) and v_p.role = 'spieler') then
    return jsonb_build_object('stop', true);
  end if;
  v_now := public.engine_now(p_game_id);
  for s in select * from jsonb_array_elements(coalesce(p_samples, '[]')) order by coalesce((value ->> 'age_s')::int, 0) desc loop
    if (s ->> 'lat') is null or (s ->> 'lng') is null then continue; end if;
    v_at := v_now - make_interval(secs => least(greatest(coalesce((s ->> 'age_s')::int, 0), 0), 3600));
    v_geom := public.pt((s ->> 'lat')::double precision, (s ->> 'lng')::double precision);
    insert into public.location_samples (game_id, participant_id, at, geom, accuracy_m, speed_mps, heading, battery, is_mock)
    values (p_game_id, v_p.id, v_at, v_geom, (s ->> 'acc')::real, (s ->> 'speed')::real, (s ->> 'heading')::real,
            (s ->> 'battery')::int, coalesce((s ->> 'mock')::boolean, false));
    if v_last_at is null or v_at >= v_last_at then v_last := s; v_last_at := v_at; end if;
  end loop;
  if v_last is null then return jsonb_build_object('ok', false); end if;
  if coalesce((v_last ->> 'mock')::boolean, false) then
    perform public.notify(p_game_id, 'gm', null, 'mock_location', 'Verdacht Standort-Fälschung: ' || public.pname(v_p.id), '', '{}', 'hoch');
  end if;

  v_geom := public.pt((v_last ->> 'lat')::double precision, (v_last ->> 'lng')::double precision);
  insert into public.positions (participant_id, game_id, geom, lat, lng, accuracy_m, speed_mps, heading, at)
  values (v_p.id, p_game_id, v_geom, (v_last ->> 'lat')::double precision, (v_last ->> 'lng')::double precision,
          (v_last ->> 'acc')::real, (v_last ->> 'speed')::real, (v_last ->> 'heading')::real, v_last_at)
  on conflict (participant_id) do update set geom = excluded.geom, lat = excluded.lat, lng = excluded.lng,
    accuracy_m = excluded.accuracy_m, speed_mps = excluded.speed_mps, heading = excluded.heading, at = excluded.at, received_at = now()
  where positions.at <= excluded.at;

  v_battery := (v_last ->> 'battery')::int;
  v_warn := public.cfg_int(g.config_json, 'safety', 'battery_warn_percent', 25);
  update public.participants set last_seen_at = v_now, battery = coalesce(v_battery, battery),
    location_request_at = case when location_request_at is not null and location_request_at <= v_last_at then null else location_request_at end
  where id = v_p.id returning * into v_p;
  if v_battery is not null and v_battery <= v_warn and coalesce(v_p.battery_warned, 100) > v_warn and g.status in ('vorsprung', 'laeuft', 'finale') then
    update public.participants set battery_warned = v_battery where id = v_p.id;
    perform public.notify(p_game_id, null, v_p.id, 'battery', 'Akku niedrig (' || v_battery || ' %)', 'Powerbank anschliessen!', '{}', 'hoch');
    perform public.notify(p_game_id, 'gm', null, 'battery', 'Akku niedrig: ' || public.pname(v_p.id), v_battery || ' %', '{}', 'normal');
  elsif v_battery is not null and v_battery > v_warn + 5 then
    update public.participants set battery_warned = null where id = v_p.id;
  end if;

  if g.status in ('vorsprung', 'laeuft', 'finale') and g.paused_at is null then
    perform public.process_location(g, v_p, v_geom, (v_last ->> 'speed')::real, v_now);
    perform public.tick_game(p_game_id);
  end if;
  select * into v_p from public.participants where id = v_p.id;
  return jsonb_build_object('ok', true, 'request_now', v_p.location_request_at is not null,
    'interval_s', case when public.has_live_window(v_p.id, v_now) or v_p.location_request_at is not null then 5
                       else public.cfg_int(g.config_json, 'tracking', 'sample_interval_seconds', 15) end);
end; $$;

-- Gerätecheck in der Lobby (6.2)
create or replace function public.set_device_check(p_game_id uuid, p_checks jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_p public.participants;
begin
  v_p := public.require_participant(p_game_id);
  update public.participants set device_check = coalesce(p_checks, '{}') || jsonb_build_object('at', now()),
    battery = coalesce((p_checks ->> 'battery')::int, battery)
  where id = v_p.id;
  perform public.bump(p_game_id);
end; $$;

-- ---------------------------------------------------------------------------
-- Speedhunt (7.4)
-- ---------------------------------------------------------------------------

create or replace function public.speedhunt_start(p_game_id uuid, p_target uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me public.participants;
  g public.games;
  v_cfg jsonb;
  v_now timestamptz;
  v_t public.participants;
  v_sh public.speedhunts;
  v_free int;
  v_min_after int;
  v_mode text;
begin
  v_me := public.require_participant(p_game_id, array['hunter', 'zentrale', 'gm']);
  g := public.require_running(p_game_id);
  v_cfg := g.config_json;
  v_now := public.engine_now(p_game_id);
  v_mode := public.cfg_text(v_cfg, 'speedhunt', 'trigger_mode', 'taskforce');
  if not public.cfg_bool(v_cfg, 'speedhunt', 'enabled', true) then raise exception 'Speedhunts sind ausgeschaltet.' using errcode = 'P0001'; end if;
  if v_mode = 'random' then raise exception 'Speedhunts starten in diesem Spiel zufällig.' using errcode = 'P0001'; end if;
  if v_mode = 'gm' and v_me.role <> 'gm' then raise exception 'Nur die Spielleitung startet Speedhunts.' using errcode = '42501'; end if;
  if public.in_quiet_hours(g, v_now) then raise exception 'Jagdfreie Zeit.' using errcode = 'P0001'; end if;
  if g.speedhunts_left <= 0 then raise exception 'Kein Speedhunt mehr übrig heute.' using errcode = 'P0001'; end if;
  if (select count(*) from public.speedhunts where game_id = p_game_id and status = 'laeuft' and not is_penalty)
     >= public.cfg_int(v_cfg, 'speedhunt', 'max_parallel', 2) then
    raise exception 'Schon % Speedhunts gleichzeitig.', public.cfg_int(v_cfg, 'speedhunt', 'max_parallel', 2) using errcode = 'P0001';
  end if;
  select * into v_t from public.participants where id = p_target and game_id = p_game_id;
  if v_t.id is null or v_t.role <> 'spieler' or v_t.state not in ('aktiv', 'ausserhalb') then
    raise exception 'Dieses Ziel kann nicht gejagt werden.' using errcode = 'P0001';
  end if;
  if (public.running_speedhunt_on(p_target)).id is not null then raise exception 'Auf dieses Ziel läuft schon ein Speedhunt.' using errcode = 'P0001'; end if;
  -- Regenerations-Joker und Hotel schützen vor neuen Speedhunts (7.11, 7.12).
  if public.has_effect(p_target, 'regeneration', v_now) then raise exception 'Ziel ist durch einen Joker geschützt.' using errcode = 'P0001'; end if;
  if public.has_effect(p_target, 'hotel', v_now) then raise exception 'Ziel ist im Hotel geschützt.' using errcode = 'P0001'; end if;
  v_free := public.free_players(p_game_id);
  if public.cfg_bool(v_cfg, 'speedhunt', 'no_consecutive_same_target', true) and g.last_speedhunt_target = p_target
     and v_free > public.cfg_int(v_cfg, 'speedhunt', 'consecutive_allowed_when_players_left_le', 2) then
    raise exception 'Nicht zweimal hintereinander dasselbe Ziel.' using errcode = 'P0001';
  end if;
  if public.cfg_int(v_cfg, 'speedhunt', 'max_per_player_per_day', 0) > 0
     and (select count(*) from public.speedhunts where target_id = p_target and day_index = g.current_day and not is_penalty and started_at is not null)
       >= public.cfg_int(v_cfg, 'speedhunt', 'max_per_player_per_day', 0) then
    raise exception 'Dieses Ziel hatte heute schon genug Speedhunts.' using errcode = 'P0001';
  end if;
  v_min_after := public.cfg_int(v_cfg, 'speedhunt', 'min_minutes_after_silent_ping', 0);
  if v_min_after > 0 and public.cfg_text(v_cfg, 'speedhunt', 'early_start_policy', 'silent_zaehlt_als_abfrage') = 'verbieten'
     and v_t.last_silent_ping_at > v_now - make_interval(mins => v_min_after) then
    raise exception 'Erst % min nach dem letzten Silent-Ping möglich.', v_min_after using errcode = 'P0001';
  end if;

  update public.games set speedhunts_left = speedhunts_left - 1 where id = p_game_id;
  if public.cfg_bool(v_cfg, 'speedhunt', 'gm_approval', false) and v_me.role <> 'gm' then
    v_sh := public.start_speedhunt_internal(g, p_target, v_me.id, false, v_now, 'wartet_auf_freigabe');
    perform public.notify(p_game_id, 'gm', null, 'speedhunt_approval', 'Speedhunt freigeben?', public.pname(p_target), jsonb_build_object('speedhunt_id', v_sh.id), 'hoch');
  else
    v_sh := public.start_speedhunt_internal(g, p_target, v_me.id, false, v_now);
  end if;
  perform public.log_game_event(p_game_id, 'speedhunt_start', jsonb_build_object('target', p_target, 'by', v_me.id));
  perform public.bump(p_game_id);
  return v_sh.id;
end; $$;

create or replace function public.speedhunt_approve(p_speedhunt_id uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_sh public.speedhunts;
  g public.games;
  v_now timestamptz;
begin
  select * into v_sh from public.speedhunts where id = p_speedhunt_id;
  perform public.require_participant(v_sh.game_id, array['gm']);
  if v_sh.status <> 'wartet_auf_freigabe' then raise exception 'Schon entschieden.' using errcode = 'P0001'; end if;
  g := public.require_running(v_sh.game_id);
  v_now := public.engine_now(g.id);
  update public.speedhunts set status = 'beendet', ended_at = v_now, end_reason = case when p_approve then 'freigegeben' else 'abgelehnt' end where id = v_sh.id;
  if p_approve then
    perform public.start_speedhunt_internal(g, v_sh.target_id, v_sh.triggered_by, false, v_now);
  else
    update public.games set speedhunts_left = speedhunts_left + 1 where id = g.id;
    perform public.notify(g.id, 'taskforce', null, 'speedhunt_rejected', 'Speedhunt abgelehnt', 'Die Spielleitung hat nicht freigegeben.', '{}', 'normal');
  end if;
  perform public.bump(g.id);
end; $$;

create or replace function public.speedhunt_query(p_speedhunt_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_sh public.speedhunts;
  g public.games;
  v_now timestamptz;
  v_gap int;
  v_id uuid;
begin
  select * into v_sh from public.speedhunts where id = p_speedhunt_id for update;
  if v_sh.id is null then raise exception 'Speedhunt nicht gefunden.' using errcode = 'P0001'; end if;
  perform public.require_participant(v_sh.game_id, array['hunter', 'zentrale', 'gm']);
  g := public.require_running(v_sh.game_id);
  v_now := public.engine_now(g.id);
  if v_sh.status <> 'laeuft' then raise exception 'Der Speedhunt läuft nicht.' using errcode = 'P0001'; end if;
  v_gap := public.cfg_int(g.config_json, 'speedhunt', 'query_min_gap_minutes', 0);
  if v_gap > 0 and v_sh.last_query_at > v_now - make_interval(mins => v_gap) then
    raise exception 'Nächste Abfrage erst um %.', to_char((v_sh.last_query_at + make_interval(mins => v_gap)) at time zone g.timezone, 'HH24:MI') using errcode = 'P0001';
  end if;
  v_id := public.speedhunt_query_internal(g, v_sh, v_now);
  perform public.bump(g.id);
  return v_id;
end; $$;

-- ---------------------------------------------------------------------------
-- Fang (7.6)
-- ---------------------------------------------------------------------------

create or replace function public.catch_code_at(p_secret text, p_window bigint)
returns text language sql immutable as $$
  select lpad((abs(hashtextextended(p_secret || ':' || p_window, 7)) % 1000000)::text, 6, '0');
$$;

create or replace function public.my_catch_code(p_game_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_p public.participants;
  v_epoch bigint := floor(extract(epoch from now()));
begin
  v_p := public.require_participant(p_game_id, array['spieler']);
  return jsonb_build_object('code', public.catch_code_at(v_p.catch_secret, v_epoch / 30),
    'valid_s', 30 - (v_epoch % 30), 'qr', 'HM:' || public.catch_code_at(v_p.catch_secret, v_epoch / 30));
end; $$;

create or replace function public.catch_blocked_reason(g public.games, p_runner public.participants, p_now timestamptz)
returns text language plpgsql stable security definer set search_path = public, extensions as $$
declare v_pos public.positions;
begin
  if g.status = 'vorsprung' then return 'Während des Vorsprungs darf nicht gefangen werden.'; end if;
  if p_runner.state not in ('aktiv', 'ausserhalb') then return 'Diese Person ist nicht mehr im Spiel.'; end if;
  if public.in_quiet_hours(g, p_now) then return 'Jagdfreie Zeit.'; end if;
  if public.has_effect(p_runner.id, 'catch_free', p_now) then return 'Catch-Free-Joker aktiv: kein Fang möglich.'; end if;
  if public.has_effect(p_runner.id, 'hotel', p_now) then return 'Spieler ist im Hotel geschützt.'; end if;
  select * into v_pos from public.positions where participant_id = p_runner.id;
  if v_pos.participant_id is not null and exists (select 1 from public.zones where game_id = g.id and kind = 'sicher' and ST_Covers(geom, v_pos.geom)) then
    return 'Spieler ist in einer sicheren Zone.';
  end if;
  return null;
end; $$;

create or replace function public.register_catch(g public.games, p_hunter public.participants, p_runner public.participants,
  p_method text, p_lat double precision, p_lng double precision, p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cfg jsonb := g.config_json;
  v_block text;
  v_rpos public.positions;
  v_dist double precision;
  v_id uuid;
begin
  v_block := public.catch_blocked_reason(g, p_runner, p_now);
  if v_block is not null then raise exception '%', v_block using errcode = 'P0001'; end if;
  select * into v_rpos from public.positions where participant_id = p_runner.id;
  if p_lat is not null and v_rpos.participant_id is not null then
    v_dist := public.dist_m(public.pt(p_lat, p_lng), v_rpos.geom);
    if v_dist > public.cfg_int(v_cfg, 'catch', 'max_distance_m', 30) + coalesce(v_rpos.accuracy_m, 0) + 30 and p_method <> 'gm' then
      raise exception 'GPS-Abstand zu gross (% m). Geh näher ran.', round(v_dist) using errcode = 'P0001';
    end if;
  end if;
  insert into public.catches (game_id, runner_id, hunter_id, at, lat, lng, method, distance_m, status, expires_at)
  values (g.id, p_runner.id, p_hunter.id, p_now, p_lat, p_lng, p_method, v_dist,
    case when public.cfg_bool(v_cfg, 'catch', 'require_media', false) and p_method <> 'gm' then 'wartet_auf_beweis'
         when p_method = 'touch_confirm' then 'wartet_auf_bestaetigung' else 'gueltig' end,
    case when public.cfg_bool(v_cfg, 'catch', 'require_media', false) and p_method <> 'gm' then p_now + interval '2 minutes'
         when p_method = 'touch_confirm' then p_now + make_interval(secs => public.cfg_int(v_cfg, 'catch', 'confirm_seconds', 60)) end)
  returning id into v_id;
  if public.cfg_bool(v_cfg, 'catch', 'require_media', false) and p_method <> 'gm' then
    perform public.notify(g.id, null, p_hunter.id, 'catch_proof', 'Beweis hochladen', 'Foto oder Video innerhalb von 2 min.', jsonb_build_object('catch_id', v_id), 'hoch');
    perform public.notify(g.id, null, p_runner.id, 'catch_pending', 'Fang wird geprüft', public.pname(p_hunter.id) || ' meldet deinen Fang.', jsonb_build_object('catch_id', v_id), 'kritisch');
  elsif p_method = 'touch_confirm' then
    perform public.notify(g.id, null, p_runner.id, 'catch_confirm', 'Wurdest du gefangen?', public.pname(p_hunter.id) || ' meldet einen Fang. Bitte bestätigen.',
      jsonb_build_object('catch_id', v_id), 'kritisch');
  else
    perform public.apply_catch(g, v_id, p_now);
  end if;
  perform public.bump(g.id);
  return jsonb_build_object('catch_id', v_id, 'status', (select status from public.catches where id = v_id), 'runner', public.pname(p_runner.id));
end; $$;

create or replace function public.catch_by_code(p_game_id uuid, p_code text, p_lat double precision default null, p_lng double precision default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.participants;
  g public.games;
  v_r public.participants;
  v_code text := regexp_replace(coalesce(p_code, ''), '^HM:', '');
  v_w bigint := floor(extract(epoch from now()) / 30);
begin
  v_me := public.require_participant(p_game_id, array['hunter', 'zentrale']);
  g := public.require_running(p_game_id, true);
  select * into v_r from public.participants
  where game_id = p_game_id and role = 'spieler'
    and (public.catch_code_at(catch_secret, v_w) = v_code or public.catch_code_at(catch_secret, v_w - 1) = v_code)
  limit 1;
  if v_r.id is null then raise exception 'Code ungültig oder abgelaufen.' using errcode = 'P0001'; end if;
  return public.register_catch(g, v_me, v_r, 'qr', p_lat, p_lng, public.engine_now(p_game_id));
end; $$;

create or replace function public.catch_claim(p_game_id uuid, p_runner uuid, p_lat double precision default null, p_lng double precision default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.participants;
  g public.games;
  v_r public.participants;
begin
  v_me := public.require_participant(p_game_id, array['hunter', 'zentrale', 'gm']);
  g := public.require_running(p_game_id, true);
  select * into v_r from public.participants where id = p_runner and game_id = p_game_id and role = 'spieler';
  if v_r.id is null then raise exception 'Spieler nicht gefunden.' using errcode = 'P0001'; end if;
  return public.register_catch(g, v_me, v_r, case when v_me.role = 'gm' then 'gm' else 'touch_confirm' end, p_lat, p_lng, public.engine_now(p_game_id));
end; $$;

create or replace function public.catch_respond(p_catch_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_c public.catches;
  v_me public.participants;
  g public.games;
begin
  select * into v_c from public.catches where id = p_catch_id;
  v_me := public.require_participant(v_c.game_id);
  g := public.require_running(v_c.game_id, true);
  if v_c.status <> 'wartet_auf_bestaetigung' then raise exception 'Schon entschieden.' using errcode = 'P0001'; end if;
  if v_me.id = v_c.runner_id then
    if p_accept then perform public.apply_catch(g, v_c.id, public.engine_now(g.id));
    else
      update public.catches set expires_at = null where id = v_c.id;
      perform public.notify(g.id, 'gm', null, 'catch_disputed', 'Fang bestritten', public.pname(v_c.runner_id) || ' bestreitet den Fang durch ' || public.pname(v_c.hunter_id) || '.', jsonb_build_object('catch_id', v_c.id), 'hoch');
      perform public.notify(g.id, null, v_c.hunter_id, 'catch_disputed', 'Fang bestritten', 'Die Spielleitung entscheidet.', '{}', 'hoch');
      if public.cfg_text(g.config_json, 'roles', 'gm_mode', 'auto') = 'auto' then
        -- Ohne menschliche Spielleitung entscheidet der GPS-Abstand sofort.
        update public.catches set expires_at = public.engine_now(g.id) where id = v_c.id;
        perform public.tick_game(g.id);
      end if;
    end if;
  elsif v_me.role = 'gm' then
    if p_accept then perform public.apply_catch(g, v_c.id, public.engine_now(g.id));
    else update public.catches set status = 'abgelehnt', reason = 'Spielleitung' where id = v_c.id; end if;
  else
    raise exception 'Nur die gefangene Person oder die Spielleitung.' using errcode = '42501';
  end if;
  perform public.bump(g.id);
end; $$;

create or replace function public.catch_attach_media(p_catch_id uuid, p_path text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_c public.catches;
  v_me public.participants;
  g public.games;
begin
  select * into v_c from public.catches where id = p_catch_id;
  v_me := public.require_participant(v_c.game_id);
  if v_me.id <> v_c.hunter_id then raise exception 'Nur wer gefangen hat.' using errcode = '42501'; end if;
  if v_c.status <> 'wartet_auf_beweis' then raise exception 'Kein Beweis nötig.' using errcode = 'P0001'; end if;
  select * into g from public.games where id = v_c.game_id;
  update public.catches set media_path = p_path where id = v_c.id;
  perform public.apply_catch(g, v_c.id, public.engine_now(g.id));
  perform public.bump(g.id);
end; $$;

create or replace function public.gm_catch_decide(p_catch_id uuid, p_valid boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_c public.catches;
  g public.games;
begin
  select * into v_c from public.catches where id = p_catch_id;
  perform public.require_participant(v_c.game_id, array['gm']);
  select * into g from public.games where id = v_c.game_id;
  if p_valid and v_c.status <> 'gueltig' then
    perform public.apply_catch(g, v_c.id, public.engine_now(g.id));
  elsif not p_valid and v_c.status = 'gueltig' then
    -- Fang annullieren: Person kommt zurück ins Spiel.
    update public.catches set status = 'annulliert' where id = v_c.id;
    update public.participants set state = 'aktiv', caught_at = null, role = 'spieler' where id = v_c.runner_id;
    perform public.schedule_next_ping(g, v_c.runner_id, public.engine_now(g.id));
    if v_c.hunter_id is not null then
      update public.participants set bounty = greatest(0, bounty - public.cfg_int(g.config_json, 'taskforce', 'bounty_per_catch', 1000)) where id = v_c.hunter_id;
    end if;
    perform public.notify(g.id, 'alle', null, 'catch_annulled', 'Fang annulliert', public.pname(v_c.runner_id) || ' ist wieder im Spiel.', '{}', 'hoch');
  elsif not p_valid then
    update public.catches set status = 'abgelehnt', reason = 'Spielleitung' where id = v_c.id;
  end if;
  perform public.bump(g.id);
end; $$;

-- ---------------------------------------------------------------------------
-- Exit per QR oder Spielleitung, Aufgeben
-- ---------------------------------------------------------------------------

create or replace function public.confirm_exit(p_game_id uuid, p_participant uuid default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_me public.participants;
  g public.games;
  v_exit public.zones;
  v_pos public.positions;
begin
  v_me := public.require_participant(p_game_id);
  g := public.require_running(p_game_id);
  if not g.exit_revealed then raise exception 'Der Exitpoint ist noch nicht bekannt.' using errcode = 'P0001'; end if;
  if v_me.role = 'gm' and p_participant is not null then
    perform public.reach_exit(g, p_participant, public.engine_now(p_game_id));
  elsif v_me.role = 'spieler' then
    select * into v_exit from public.zones where id = g.exit_zone_id;
    select * into v_pos from public.positions where participant_id = v_me.id;
    if v_pos.participant_id is null or public.dist_m(v_exit.geom, v_pos.geom) > coalesce(v_exit.radius_m, 30) + coalesce(v_pos.accuracy_m, 0) + 20 then
      raise exception 'Du bist noch nicht am Exitpoint.' using errcode = 'P0001';
    end if;
    perform public.reach_exit(g, v_me.id, public.engine_now(p_game_id));
  else
    raise exception 'Nicht erlaubt.' using errcode = '42501';
  end if;
  perform public.bump(p_game_id);
end; $$;

create or replace function public.give_up(p_game_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_me public.participants;
  g public.games;
begin
  v_me := public.require_participant(p_game_id, array['spieler']);
  g := public.require_running(p_game_id, true);
  update public.participants set state = 'aufgegeben', next_ping_at = null where id = v_me.id and state in ('aktiv', 'ausserhalb', 'notfall');
  perform public.close_live_windows(v_me.id, 'ausserhalb', public.engine_now(p_game_id));
  perform public.notify(p_game_id, 'alle', null, 'give_up', public.pname(v_me.id) || ' hat aufgegeben', '', '{}', 'hoch');
  if public.free_players(p_game_id) = 0 then
    perform public.finish_game(g, public.engine_now(p_game_id), 'alle_ausgeschieden');
  end if;
  perform public.bump(p_game_id);
end; $$;

-- ---------------------------------------------------------------------------
-- Verschanzen (7.8)
-- ---------------------------------------------------------------------------

create or replace function public.hideout_report(p_game_id uuid, p_inside boolean)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_me public.participants;
  g public.games;
  v_cfg jsonb;
  v_now timestamptz;
  v_pos public.positions;
  v_h public.hideouts;
  v_prev public.hideouts;
  v_lock int;
  v_first timestamptz;
begin
  v_me := public.require_participant(p_game_id, array['spieler']);
  g := public.require_running(p_game_id);
  v_cfg := g.config_json;
  v_now := public.engine_now(p_game_id);
  if not public.cfg_bool(v_cfg, 'hideout', 'enabled', true) then raise exception 'Verschanzen-Regel ist aus.' using errcode = 'P0001'; end if;
  select * into v_pos from public.positions where participant_id = v_me.id;
  select * into v_h from public.hideouts where participant_id = v_me.id and status = 'aktiv';
  if not p_inside then
    if v_h.id is not null then update public.hideouts set inside = false where id = v_h.id; end if;
    update public.participants set hideout_prompted_at = v_now, stationary_since = v_now where id = v_me.id;
    perform public.bump(p_game_id);
    return jsonb_build_object('inside', false);
  end if;
  if v_pos.participant_id is null then raise exception 'Noch kein Standort.' using errcode = 'P0001'; end if;
  if v_h.id is not null then
    update public.hideouts set inside = true where id = v_h.id;
  else
    -- Sperre: derselbe Ort darf nach lockout_after_first_entry_minutes nicht mehr genutzt werden.
    v_lock := public.cfg_int(v_cfg, 'hideout', 'lockout_after_first_entry_minutes', 480);
    select * into v_prev from public.hideouts where participant_id = v_me.id
      and public.dist_m(center, v_pos.geom) <= public.cfg_int(v_cfg, 'hideout', 'min_leave_distance_m', 200)
    order by first_entered_at limit 1;
    v_first := coalesce(v_prev.first_entered_at, case when v_me.stationary_since is not null and v_me.stationary_center is not null
      and public.dist_m(v_me.stationary_center, v_pos.geom) <= public.cfg_int(v_cfg, 'hideout', 'stationary_radius_m', 40) then v_me.stationary_since end, v_now);
    insert into public.hideouts (game_id, participant_id, center, first_entered_at, entered_at, accum_s, detection)
    values (p_game_id, v_me.id, v_pos.geom, v_first, v_now,
            coalesce(v_prev.accum_s, 0) + case when v_prev.id is null and v_first < v_now then extract(epoch from (v_now - v_first))::int else 0 end,
            case when v_me.hideout_prompted_at is not null then 'automatisch' else 'selbstmeldung' end)
    returning * into v_h;
    if v_lock > 0 and v_prev.id is not null and v_now - v_prev.first_entered_at > make_interval(mins => v_lock) then
      perform public.create_violation(g, v_me.id, 'versteck_gesperrt', jsonb_build_object('erstmals', v_prev.first_entered_at), v_now);
    end if;
  end if;
  update public.participants set hideout_prompted_at = null where id = v_me.id;
  perform public.bump(p_game_id);
  return jsonb_build_object('inside', true, 'remaining_s', public.cfg_int(v_cfg, 'hideout', 'max_minutes', 120) * 60 - v_h.accum_s);
end; $$;

-- ---------------------------------------------------------------------------
-- ÖV (7.9)
-- ---------------------------------------------------------------------------

create or replace function public.transit_checkin(p_game_id uuid, p_mode text, p_line text default null, p_from text default null, p_to text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me public.participants;
  g public.games;
  v_cfg jsonb;
  v_now timestamptz;
  v_id uuid;
  v_pos public.positions;
begin
  v_me := public.require_participant(p_game_id, array['spieler']);
  g := public.require_running(p_game_id, true);
  v_cfg := g.config_json;
  v_now := public.engine_now(p_game_id);
  if not (coalesce(v_cfg -> 'transport' -> 'allowed_modes', '[]') ? p_mode) then
    raise exception 'Diese Fortbewegung ist nicht erlaubt.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.transit_sessions where participant_id = v_me.id and ended_at is null) then
    raise exception 'Du bist schon angemeldet.' using errcode = 'P0001';
  end if;
  insert into public.transit_sessions (game_id, participant_id, mode, line, from_station, to_station, started_at)
  values (p_game_id, v_me.id, p_mode, nullif(p_line, ''), nullif(p_from, ''), nullif(p_to, ''), v_now) returning id into v_id;
  update public.participants set rides_today = rides_today + 1, speeding_since = null, transport_prompted_at = null where id = v_me.id;
  if g.status <> 'vorsprung' and public.cfg_bool(v_cfg, 'transport', 'live_during', true) then
    perform public.open_live_window(p_game_id, v_me.id, 'oev', v_now, null);
  end if;
  select * into v_pos from public.positions where participant_id = v_me.id;
  if g.status <> 'vorsprung' then
    perform public.create_ping(g, v_me.id, 'transit', v_pos.lat, v_pos.lng, v_pos.accuracy_m, null, null, null,
      replace(p_mode, '_', ' ') || coalesce(' ' || nullif(p_line, ''), ''), 0, v_now);
    perform public.notify(p_game_id, 'taskforce', null, 'transit', public.pname(v_me.id) || ' fährt ' || case p_mode when 'oev_bus' then 'Bus' when 'oev_bahn' then 'Bahn' when 'oev_tram' then 'Tram'
      when 'faehre' then 'Fähre' when 'taxi' then 'Taxi' when 'fahrrad' then 'Velo' when 'scooter' then 'Scooter' else replace(p_mode, '_', ' ') end || coalesce(' ' || nullif(p_line, ''), ''),
      case when nullif(p_from, '') is not null or nullif(p_to, '') is not null
        then coalesce(nullif(p_from, ''), '?') || ' → ' || coalesce(nullif(p_to, ''), '?') || '. ' else '' end || 'Live-Standort sichtbar.', jsonb_build_object('participant_id', v_me.id), 'hoch');
  end if;
  perform public.bump(p_game_id);
  return v_id;
end; $$;

create or replace function public.transit_checkout(p_game_id uuid, p_stops int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.participants;
  g public.games;
  v_cfg jsonb;
  v_now timestamptz;
  v_t public.transit_sessions;
  v_after int;
begin
  v_me := public.require_participant(p_game_id, array['spieler']);
  g := public.require_running(p_game_id, true);
  v_cfg := g.config_json;
  v_now := public.engine_now(p_game_id);
  select * into v_t from public.transit_sessions where participant_id = v_me.id and ended_at is null;
  if v_t.id is null then raise exception 'Keine laufende Fahrt.' using errcode = 'P0001'; end if;
  -- Nachlauf wächst mit jeder Fahrt am Tag (Bangkok).
  v_after := public.cfg_int(v_cfg, 'transport', 'live_after_base_minutes', 10)
    + public.cfg_int(v_cfg, 'transport', 'live_after_increment_minutes', 5) * greatest(v_me.rides_today - 1, 0);
  update public.transit_sessions set ended_at = v_now, stops = p_stops, live_after_minutes = v_after where id = v_t.id;
  perform public.close_live_windows(v_me.id, 'oev', v_now);
  if g.status <> 'vorsprung' and v_after > 0 then
    perform public.open_live_window(p_game_id, v_me.id, 'oev_nachlauf', v_now, v_now + make_interval(mins => v_after));
  end if;
  if v_t.mode = 'faehre' and p_stops is not null then
    update public.participants set ferry_stops_today = ferry_stops_today + p_stops where id = v_me.id returning * into v_me;
    if v_me.ferry_stops_today > public.cfg_int(v_cfg, 'transport', 'ferry_max_stops_per_day', 10) then
      perform public.create_violation(g, v_me.id, 'faehren_limit', jsonb_build_object('stops', v_me.ferry_stops_today), v_now);
    end if;
  end if;
  if g.status <> 'vorsprung' then
    perform public.notify(p_game_id, 'taskforce', null, 'transit_end', public.pname(v_me.id) || ' ist ausgestiegen',
      case when v_after > 0 then 'Noch ' || v_after || ' min live.' else '' end, jsonb_build_object('participant_id', v_me.id), 'normal');
  end if;
  perform public.bump(p_game_id);
  return jsonb_build_object('live_after_minutes', v_after);
end; $$;

-- ---------------------------------------------------------------------------
-- Budget (7.10)
-- ---------------------------------------------------------------------------

create or replace function public.make_purchase(p_game_id uuid, p_amount numeric, p_category text, p_note text default null, p_receipt text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me public.participants;
  g public.games;
  v_cfg jsonb;
  v_now timestamptz;
  v_pos public.positions;
begin
  v_me := public.require_participant(p_game_id, array['spieler']);
  g := public.require_running(p_game_id, true);
  v_cfg := g.config_json;
  v_now := public.engine_now(p_game_id);
  if not public.cfg_bool(v_cfg, 'budget', 'enabled', false) then raise exception 'Budget ist aus.' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Betrag fehlt.' using errcode = 'P0001'; end if;
  if p_amount > v_me.budget_balance then
    raise exception 'Nicht genug Budget (noch % %).', v_me.budget_balance, public.cfg_text(v_cfg, 'budget', 'currency', 'USD') using errcode = 'P0001';
  end if;
  if public.cfg_bool(v_cfg, 'budget', 'receipt_photo_required', false) and nullif(p_receipt, '') is null then
    raise exception 'Belegfoto ist Pflicht.' using errcode = 'P0001';
  end if;
  select * into v_pos from public.positions where participant_id = v_me.id;
  insert into public.purchases (game_id, participant_id, amount, category, note, at, lat, lng, receipt_path)
  values (p_game_id, v_me.id, p_amount, coalesce(nullif(p_category, ''), 'sonstiges'), p_note, v_now, v_pos.lat, v_pos.lng, nullif(p_receipt, ''));
  update public.participants set budget_balance = budget_balance - p_amount where id = v_me.id returning * into v_me;
  if g.status <> 'vorsprung' then
    perform public.create_ping(g, v_me.id, 'purchase', v_pos.lat, v_pos.lng, v_pos.accuracy_m, null, null, null,
      case when public.cfg_bool(v_cfg, 'budget', 'reveal_amount', false) then p_amount || ' ' || public.cfg_text(v_cfg, 'budget', 'currency', 'USD') else 'Kauf' end,
      public.cfg_int(v_cfg, 'budget', 'ping_delay_minutes', 0), v_now);
  end if;
  perform public.bump(p_game_id);
  return jsonb_build_object('balance', v_me.budget_balance);
end; $$;

-- ---------------------------------------------------------------------------
-- Joker und Boni (7.11, 7.12)
-- ---------------------------------------------------------------------------

create or replace function public.use_item(p_item_id uuid, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_i public.inventory_items;
  v_me public.participants;
  g public.games;
  v_cfg jsonb;
  v_now timestamptz;
  v_type text;
  v_minutes int;
  v_pos public.positions;
  v_target extensions.geometry;
  v_snapshot jsonb;
begin
  select * into v_i from public.inventory_items where id = p_item_id;
  if v_i.id is null then raise exception 'Gegenstand nicht gefunden.' using errcode = 'P0001'; end if;
  v_me := public.require_participant(v_i.game_id, array['spieler']);
  if v_me.id <> v_i.participant_id then raise exception 'Nicht dein Gegenstand.' using errcode = '42501'; end if;
  g := public.require_running(v_i.game_id);
  v_cfg := g.config_json;
  v_now := public.engine_now(g.id);
  if v_i.used_at is not null or v_i.expired then raise exception 'Schon benutzt oder verfallen.' using errcode = 'P0001'; end if;
  if v_me.state not in ('aktiv', 'ausserhalb') then raise exception 'Du bist nicht mehr im Spiel.' using errcode = 'P0001'; end if;
  v_type := v_i.type;
  v_minutes := v_i.minutes;
  if v_type = 'wahl' then
    -- Joker-Wahl: Typ aus den erlaubten wählen
    select e ->> 'type', (e ->> 'minutes')::int into v_type, v_minutes
    from jsonb_array_elements(coalesce(v_cfg -> 'joker' -> 'types', '[]')) e where e ->> 'type' = p_payload ->> 'type';
    if v_type is null then raise exception 'Bitte einen Joker-Typ wählen.' using errcode = 'P0001'; end if;
  end if;
  select * into v_pos from public.positions where participant_id = v_me.id;

  case v_type
    when 'regeneration' then
      -- Nicht während eines laufenden Speedhunts (auf irgendwen) (14.3, Regel 2).
      if exists (select 1 from public.speedhunts where game_id = g.id and status = 'laeuft') then
        raise exception 'Während eines Speedhunts nicht möglich.' using errcode = 'P0001';
      end if;
      insert into public.active_effects (game_id, participant_id, type, starts_at, ends_at, source_item_id)
      values (g.id, v_me.id, 'regeneration', v_now, v_now + make_interval(mins => coalesce(v_minutes, 240)), v_i.id);
      perform public.notify(g.id, 'taskforce', null, 'joker', 'Joker: Regeneration', 'Ein Spieler ist für ' || coalesce(v_minutes, 240) || ' min nicht ortbar.', '{}', 'normal');
    when 'catch_free' then
      insert into public.active_effects (game_id, participant_id, type, starts_at, ends_at, source_item_id)
      values (g.id, v_me.id, 'catch_free', v_now, v_now + make_interval(mins => coalesce(v_minutes, 180)), v_i.id);
      perform public.notify(g.id, 'taskforce', null, 'joker', 'Joker: Catch-Free', public.pname(v_me.id) || ' kann ' || coalesce(v_minutes, 180) || ' min nicht gefangen werden.', '{}', 'hoch');
    when 'hunter_erfragen' then
      select coalesce(jsonb_agg(jsonb_build_object('name', public.pname(p.id), 'lat', pos.lat, 'lng', pos.lng, 'at', pos.at)), '[]') into v_snapshot
      from public.participants p join public.positions pos on pos.participant_id = p.id
      where p.game_id = g.id and p.role in ('hunter', 'zentrale');
      insert into public.active_effects (game_id, participant_id, type, starts_at, ends_at, payload, source_item_id)
      values (g.id, v_me.id, 'hunter_snapshot', v_now, v_now + interval '5 minutes', jsonb_build_object('hunters', v_snapshot), v_i.id);
      perform public.notify(g.id, null, v_me.id, 'joker', 'Hunter-Standorte', 'Auf der Karte 5 min sichtbar.', jsonb_build_object('hunters', v_snapshot), 'hoch');
    when 'fake_ping' then
      if (p_payload ->> 'lat') is null then raise exception 'Bitte einen Ort auf der Karte wählen.' using errcode = 'P0001'; end if;
      v_target := public.pt((p_payload ->> 'lat')::double precision, (p_payload ->> 'lng')::double precision);
      if v_pos.participant_id is not null and public.dist_m(v_pos.geom, v_target) > public.cfg_int(v_cfg, 'bonus', 'fake_ping_max_distance_m', 3000) then
        raise exception 'Zu weit weg (max. % m).', public.cfg_int(v_cfg, 'bonus', 'fake_ping_max_distance_m', 3000) using errcode = 'P0001';
      end if;
      if not ST_DWithin(coalesce(public.allowed_area(g.id, v_me.id, g.current_day, public.cfg_bool(v_cfg, 'zone', 'sections_per_player', false)), v_target)::geography, v_target::geography, 1) then
        raise exception 'Der Fake-Ping muss im Spielfeld liegen.' using errcode = 'P0001';
      end if;
      insert into public.active_effects (game_id, participant_id, type, starts_at, payload, source_item_id)
      values (g.id, v_me.id, 'fake_ping', v_now, jsonb_build_object('lat', p_payload -> 'lat', 'lng', p_payload -> 'lng',
              'applies', coalesce(nullif(p_payload ->> 'applies', ''), 'beide')), v_i.id);
    when 'hotel' then
      if v_pos.participant_id is null then raise exception 'Noch kein Standort.' using errcode = 'P0001'; end if;
      insert into public.active_effects (game_id, participant_id, type, starts_at, ends_at, payload, source_item_id)
      values (g.id, v_me.id, 'hotel', v_now, v_now + make_interval(mins => public.cfg_int(v_cfg, 'bonus', 'hotel_minutes', 360)),
              jsonb_build_object('lat', v_pos.lat, 'lng', v_pos.lng, 'radius_m', public.cfg_int(v_cfg, 'bonus', 'hotel_radius_m', 50)), v_i.id);
      perform public.notify(g.id, 'taskforce', null, 'bonus', 'Bonus: Hotel', 'Ein Spieler ist ' || public.cfg_int(v_cfg, 'bonus', 'hotel_minutes', 360) || ' min geschützt.', '{}', 'normal');
    when 'budget' then
      update public.participants set budget_balance = budget_balance + coalesce(v_minutes, 10) where id = v_me.id;
    else
      raise exception 'Unbekannter Gegenstand.' using errcode = 'P0001';
  end case;
  update public.inventory_items set used_at = v_now, type = v_type where id = v_i.id;
  perform public.log_game_event(g.id, 'item_used', jsonb_build_object('type', v_type, 'participant', v_me.id));
  perform public.bump(g.id);
  return jsonb_build_object('type', v_type);
end; $$;

create or replace function public.gm_grant_item(p_game_id uuid, p_participant uuid, p_kind text, p_type text, p_minutes int default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  v_id uuid;
begin
  if not public.is_game_leader(p_game_id) then raise exception 'Nur Host oder Spielleitung.' using errcode = '42501'; end if;
  select * into g from public.games where id = p_game_id;
  insert into public.inventory_items (game_id, participant_id, kind, type, minutes, granted_day, granted_at, source)
  values (p_game_id, p_participant, p_kind, p_type, p_minutes, g.current_day, public.engine_now(p_game_id), 'spielleitung') returning id into v_id;
  perform public.notify(p_game_id, null, p_participant, p_kind, case p_kind when 'joker' then 'Neuer Joker: ' else 'Neuer Bonus: ' end || replace(p_type, '_', ' '), '', '{}', 'normal');
  perform public.bump(p_game_id);
  return v_id;
end; $$;

-- ---------------------------------------------------------------------------
-- Challenges (7.13)
-- ---------------------------------------------------------------------------

create or replace function public.challenge_create(p_game_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_now timestamptz := public.engine_now(p_game_id);
  v_start timestamptz;
  v_cfg jsonb;
begin
  if not public.is_game_leader(p_game_id) then raise exception 'Nur Host oder Spielleitung.' using errcode = '42501'; end if;
  select config_json into v_cfg from public.games where id = p_game_id;
  v_start := coalesce((p_data ->> 'starts_at')::timestamptz, v_now + make_interval(mins => coalesce((p_data ->> 'starts_in_minutes')::int, 30)));
  insert into public.challenges (game_id, template, title, description, lat, lng, radius_m, announce_at, starts_at, ends_at,
    proof_type, secret_code, reward_type, reward_value, reveal_location_to_taskforce, max_participants)
  values (p_game_id, coalesce(p_data ->> 'template', 'eigene'), coalesce(nullif(p_data ->> 'title', ''), 'Challenge'), coalesce(p_data ->> 'description', ''),
    (p_data ->> 'lat')::double precision, (p_data ->> 'lng')::double precision, coalesce((p_data ->> 'radius_m')::int, 50),
    v_start - make_interval(mins => public.cfg_int(v_cfg, 'challenge', 'announce_before_minutes', 60)),
    v_start, v_start + make_interval(mins => coalesce((p_data ->> 'duration_minutes')::int, 30)),
    coalesce(p_data ->> 'proof_type', 'geofence'), nullif(p_data ->> 'secret_code', ''),
    coalesce(p_data ->> 'reward_type', 'bonus_fake_ping'), (p_data ->> 'reward_value')::int,
    coalesce((p_data ->> 'reveal_location_to_taskforce')::boolean, true), (p_data ->> 'max_participants')::int)
  returning id into v_id;
  perform public.tick_game(p_game_id);
  perform public.bump(p_game_id);
  return v_id;
end; $$;

create or replace function public.challenge_cancel(p_challenge_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_c public.challenges;
begin
  select * into v_c from public.challenges where id = p_challenge_id;
  if not public.is_game_leader(v_c.game_id) then raise exception 'Nur Host oder Spielleitung.' using errcode = '42501'; end if;
  update public.challenges set status = 'abgesagt' where id = v_c.id;
  perform public.notify(v_c.game_id, 'spieler', null, 'challenge_cancel', 'Challenge abgesagt: ' || v_c.title, '', '{}', 'normal');
  perform public.bump(v_c.game_id);
end; $$;

create or replace function public.challenge_reward(g public.games, p_c public.challenges, p_participant uuid, p_now timestamptz)
returns void language plpgsql security definer set search_path = public as $$
begin
  case p_c.reward_type
    when 'bonus_fake_ping' then
      insert into public.inventory_items (game_id, participant_id, kind, type, granted_day, granted_at, source)
      values (g.id, p_participant, 'bonus', 'fake_ping', g.current_day, p_now, 'challenge');
    when 'bonus_hotel' then
      insert into public.inventory_items (game_id, participant_id, kind, type, granted_day, granted_at, source)
      values (g.id, p_participant, 'bonus', 'hotel', g.current_day, p_now, 'challenge');
    when 'budget' then
      update public.participants set budget_balance = budget_balance + coalesce(p_c.reward_value, 10) where id = p_participant;
    when 'joker' then
      insert into public.inventory_items (game_id, participant_id, kind, type, minutes, granted_day, granted_at, source)
      values (g.id, p_participant, 'joker', 'catch_free', coalesce(p_c.reward_value, 60), g.current_day, p_now, 'challenge');
    else null;
  end case;
  perform public.notify(g.id, null, p_participant, 'challenge_won', 'Challenge geschafft!', 'Belohnung: ' || replace(p_c.reward_type, '_', ' '), '{}', 'hoch');
end; $$;

create or replace function public.challenge_join(p_challenge_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_c public.challenges;
  v_me public.participants;
begin
  select * into v_c from public.challenges where id = p_challenge_id;
  v_me := public.require_participant(v_c.game_id, array['spieler']);
  if v_c.status not in ('angekuendigt', 'laeuft') then raise exception 'Anmeldung nicht möglich.' using errcode = 'P0001'; end if;
  if v_c.max_participants is not null and (select count(*) from public.challenge_entries where challenge_id = v_c.id) >= v_c.max_participants then
    raise exception 'Challenge ist voll.' using errcode = 'P0001';
  end if;
  insert into public.challenge_entries (challenge_id, participant_id, joined_at) values (v_c.id, v_me.id, public.engine_now(v_c.game_id))
  on conflict do nothing;
  perform public.bump(v_c.game_id);
end; $$;

create or replace function public.challenge_submit(p_challenge_id uuid, p_code text default null, p_proof_path text default null)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_c public.challenges;
  v_me public.participants;
  g public.games;
  v_e public.challenge_entries;
  v_pos public.positions;
  v_now timestamptz;
  v_ok boolean := false;
begin
  select * into v_c from public.challenges where id = p_challenge_id;
  v_me := public.require_participant(v_c.game_id, array['spieler']);
  g := public.require_running(v_c.game_id);
  v_now := public.engine_now(g.id);
  if v_c.status <> 'laeuft' then raise exception 'Die Challenge läuft gerade nicht.' using errcode = 'P0001'; end if;
  insert into public.challenge_entries (challenge_id, participant_id, joined_at) values (v_c.id, v_me.id, v_now) on conflict do nothing;
  select * into v_e from public.challenge_entries where challenge_id = v_c.id and participant_id = v_me.id;
  if v_e.result in ('erfolgreich', 'gescheitert') then raise exception 'Schon entschieden.' using errcode = 'P0001'; end if;
  case v_c.proof_type
    when 'geofence' then
      select * into v_pos from public.positions where participant_id = v_me.id;
      v_ok := v_pos.participant_id is not null and v_c.lat is not null
        and public.dist_m(v_pos.geom, public.pt(v_c.lat, v_c.lng)) <= coalesce(v_c.radius_m, 50) + coalesce(v_pos.accuracy_m, 0);
      if not v_ok then raise exception 'Du bist noch nicht am Ort der Challenge.' using errcode = 'P0001'; end if;
    when 'code' then
      v_ok := lower(trim(coalesce(p_code, ''))) = lower(trim(coalesce(v_c.secret_code, '')));
      if not v_ok then raise exception 'Code falsch.' using errcode = 'P0001'; end if;
    else
      update public.challenge_entries set result = 'eingereicht', proof_path = p_proof_path, proof_text = p_code where id = v_e.id;
      if public.cfg_text(g.config_json, 'roles', 'gm_mode', 'auto') = 'auto' then
        -- Ohne menschliche Spielleitung zählt eine Einreichung (im Zweifel für die Spieler).
        v_ok := true;
      else
        perform public.notify(g.id, 'gm', null, 'challenge_review', 'Challenge prüfen: ' || public.pname(v_me.id), v_c.title, jsonb_build_object('entry_id', v_e.id), 'hoch');
        perform public.bump(g.id);
        return 'eingereicht';
      end if;
  end case;
  update public.challenge_entries set result = 'erfolgreich', decided_at = v_now, proof_path = p_proof_path where id = v_e.id;
  perform public.challenge_reward(g, v_c, v_me.id, v_now);
  perform public.bump(g.id);
  return 'erfolgreich';
end; $$;

create or replace function public.challenge_decide(p_entry_id uuid, p_success boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_e public.challenge_entries;
  v_c public.challenges;
  g public.games;
begin
  select * into v_e from public.challenge_entries where id = p_entry_id;
  select * into v_c from public.challenges where id = v_e.challenge_id;
  if not public.is_game_leader(v_c.game_id) then raise exception 'Nur Host oder Spielleitung.' using errcode = '42501'; end if;
  select * into g from public.games where id = v_c.game_id;
  if v_e.result = 'erfolgreich' then return; end if;
  update public.challenge_entries set result = case when p_success then 'erfolgreich' else 'gescheitert' end, decided_at = public.engine_now(g.id) where id = v_e.id;
  if p_success then perform public.challenge_reward(g, v_c, v_e.participant_id, public.engine_now(g.id)); end if;
  perform public.bump(g.id);
end; $$;

-- ---------------------------------------------------------------------------
-- Notfall und Pause (7.15, 7.16)
-- ---------------------------------------------------------------------------

create or replace function public.pause_game(p_game_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare g public.games;
begin
  if not public.is_game_leader(p_game_id) then raise exception 'Nur Host oder Spielleitung.' using errcode = '42501'; end if;
  select * into g from public.games where id = p_game_id;
  if g.paused_at is not null or g.status not in ('vorsprung', 'laeuft', 'finale') then return; end if;
  perform public.tick_game(p_game_id);
  update public.games set paused_at = public.engine_now(p_game_id), pause_reason = coalesce(nullif(p_reason, ''), 'Pause') where id = p_game_id;
  perform public.notify(p_game_id, 'alle', null, 'pause', 'Spiel pausiert', coalesce(nullif(p_reason, ''), ''), '{}', 'kritisch');
  perform public.log_game_event(p_game_id, 'paused', jsonb_build_object('reason', p_reason));
  perform public.bump(p_game_id);
end; $$;

create or replace function public.pause_internal(p_game_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.games set paused_at = public.engine_now(p_game_id), pause_reason = p_reason where id = p_game_id and paused_at is null;
  perform public.notify(p_game_id, 'alle', null, 'pause', 'Spiel pausiert', p_reason, '{}', 'kritisch');
end; $$;

-- Fortsetzen: alle laufenden Fristen um die Pausendauer verschieben (14.3, Regel 8).
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
  update public.zones set visible_from = visible_from + d where game_id = p_game_id and visible_from > g.paused_at and visible_from <> 'infinity' and v_ext;
  perform public.notify(p_game_id, 'alle', null, 'resume', 'Weiter geht''s!', 'Das Spiel läuft wieder.', '{}', 'kritisch');
  perform public.log_game_event(p_game_id, 'resumed', jsonb_build_object('seconds', extract(epoch from d)::int));
  perform public.bump(p_game_id);
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
  perform public.notify(p_game_id, 'taskforce', null, 'emergency', 'NOTFALL: ' || public.pname(v_me.id), 'Jagd auf diese Person ist ausgesetzt. Helft, wenn ihr in der Nähe seid.', jsonb_build_object('emergency_id', v_id), 'kritisch');
  if public.cfg_text(g.config_json, 'safety', 'emergency_pauses', 'person') = 'alle' and g.status in ('vorsprung', 'laeuft', 'finale') then
    perform public.pause_internal(p_game_id, 'Notfall: ' || public.pname(v_me.id));
  end if;
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
          or (v_me.id = v_e.participant_id and public.cfg_text(g.config_json, 'roles', 'gm_mode', 'auto') = 'auto')) then
    raise exception 'Nur die Spielleitung kann den Notfall beenden.' using errcode = '42501';
  end if;
  v_now := public.engine_now(g.id);
  update public.emergencies set status = 'erledigt', resolved_by = auth.uid(), resolved_at = v_now where id = v_e.id;
  select * into v_p from public.participants where id = v_e.participant_id;
  if v_p.state = 'notfall' then
    update public.participants set state = coalesce(state_before, 'aktiv'), state_before = null where id = v_p.id;
  end if;
  perform public.close_live_windows(v_p.id, 'notfall', v_now);
  perform public.notify(g.id, 'alle', null, 'emergency_end', 'Notfall erledigt', public.pname(v_p.id), '{}', 'hoch');
  perform public.bump(g.id);
end; $$;

-- Notfallkontakt: nur Spielleitung bzw. Host (Kapitel 15).
create or replace function public.emergency_contact(p_game_id uuid, p_participant uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not public.is_game_leader(p_game_id) then raise exception 'Nur Host oder Spielleitung.' using errcode = '42501'; end if;
  select jsonb_build_object('name', pp.emergency_contact_name, 'phone', pp.emergency_contact_phone) into v
  from public.participants p join public.profile_private pp on pp.user_id = p.user_id where p.id = p_participant and p.game_id = p_game_id;
  perform public.log_game_event(p_game_id, 'emergency_contact_viewed', jsonb_build_object('participant', p_participant));
  return v;
end; $$;

-- ---------------------------------------------------------------------------
-- Verstösse (7.17)
-- ---------------------------------------------------------------------------

create or replace function public.violation_explain(p_violation_id uuid, p_text text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v public.violations;
  v_me public.participants;
begin
  select * into v from public.violations where id = p_violation_id;
  v_me := public.require_participant(v.game_id);
  if v_me.id <> v.participant_id then raise exception 'Nicht dein Verstoss.' using errcode = '42501'; end if;
  update public.violations set explanation = left(p_text, 500) where id = v.id;
  -- Mit menschlicher Spielleitung wartet die Strafe auf die Entscheidung.
  if public.cfg_text((select config_json from public.games where id = v.game_id), 'roles', 'gm_mode', 'auto') <> 'auto' then
    update public.violations set auto_apply_at = null where id = v.id and status = 'offen';
  end if;
  perform public.notify(v.game_id, 'gm', null, 'violation_explained', 'Erklärung: ' || public.pname(v.participant_id), left(p_text, 200), jsonb_build_object('violation_id', v.id), 'normal');
  perform public.bump(v.game_id);
end; $$;

create or replace function public.violation_decide(p_violation_id uuid, p_penalty text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v public.violations;
  g public.games;
begin
  select * into v from public.violations where id = p_violation_id;
  perform public.require_participant(v.game_id, array['gm']);
  select * into g from public.games where id = v.game_id;
  if v.status <> 'offen' then raise exception 'Schon entschieden.' using errcode = 'P0001'; end if;
  if p_penalty is null or p_penalty = 'verwerfen' then
    update public.violations set status = 'verworfen', decided_at = public.engine_now(g.id) where id = v.id;
    perform public.notify(g.id, null, v.participant_id, 'violation_dismissed', 'Verstoss verworfen', '', '{}', 'normal');
  else
    perform public.apply_penalty(g, v.id, p_penalty, public.engine_now(g.id));
  end if;
  perform public.bump(g.id);
end; $$;

create or replace function public.violation_report(p_game_id uuid, p_participant uuid, p_type text, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_me public.participants;
  g public.games;
  v_id uuid;
begin
  v_me := public.require_participant(p_game_id);
  select * into g from public.games where id = p_game_id;
  v_id := public.create_violation(g, p_participant, coalesce(nullif(p_type, ''), 'sonstiges'), jsonb_build_object('note', p_note, 'by', public.pname(v_me.id)),
    public.engine_now(p_game_id), null, case when v_me.role = 'gm' then 'gm' else 'meldung' end);
  -- Meldungen durch Mitspielende werden nie automatisch bestraft.
  if v_me.role <> 'gm' then update public.violations set auto_apply_at = null where id = v_id; end if;
  perform public.bump(p_game_id);
  return v_id;
end; $$;

-- ---------------------------------------------------------------------------
-- Spielleitung (7.16, 22.7)
-- ---------------------------------------------------------------------------

create or replace function public.gm_ping(p_game_id uuid, p_participant uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  g public.games;
  v_pos record;
  v_id uuid;
begin
  perform public.require_participant(p_game_id, array['gm']);
  g := public.require_running(p_game_id);
  select * into v_pos from public.best_position(p_participant, public.engine_now(p_game_id));
  v_id := public.create_ping(g, p_participant, 'gm', v_pos.lat, v_pos.lng, v_pos.accuracy_m, v_pos.age_s, null, null, 'Spielleitung', 0, public.engine_now(p_game_id));
  perform public.notify(p_game_id, 'taskforce', null, 'gm_ping', 'Sonder-Ping: ' || public.pname(p_participant), '', jsonb_build_object('ping_id', v_id), 'hoch');
  perform public.bump(p_game_id);
  return v_id;
end; $$;

create or replace function public.gm_add_zone(p_game_id uuid, p_feature jsonb)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id uuid;
  v_geom extensions.geometry;
begin
  perform public.require_participant(p_game_id, array['gm']);
  if (p_feature #>> '{properties,kind}') not in ('sperrzone', 'sicher', 'treffpunkt') then
    raise exception 'Im Spiel nur Sperrzonen, sichere Zonen oder Treffpunkte.' using errcode = 'P0001';
  end if;
  v_geom := ST_SetSRID(ST_GeomFromGeoJSON((p_feature -> 'geometry')::text), 4326);
  -- Punkt mit Radius als Kreisfläche speichern (Sperr- und Schutzzonen sind Flächen).
  if ST_GeometryType(v_geom) = 'ST_Point' and (p_feature #>> '{properties,kind}') <> 'treffpunkt' then
    v_geom := ST_Buffer(v_geom::geography, coalesce(nullif(p_feature #>> '{properties,radius_m}', '')::int, 50))::geometry;
  end if;
  insert into public.zones (game_id, kind, name, geom, radius_m, crossing_allowed)
  values (p_game_id, p_feature #>> '{properties,kind}', coalesce(p_feature #>> '{properties,name}', ''),
          v_geom, nullif(p_feature #>> '{properties,radius_m}', '')::int,
          coalesce((p_feature #>> '{properties,crossing_allowed}')::boolean, false))
  returning id into v_id;
  update public.games set map_version = map_version + 1 where id = p_game_id;
  perform public.notify(p_game_id, 'alle', null, 'zone_added', 'Neue Zone: ' || coalesce(nullif(p_feature #>> '{properties,name}', ''), p_feature #>> '{properties,kind}'), 'Siehe Karte.', '{}', 'hoch');
  perform public.bump(p_game_id);
  return v_id;
end; $$;

create or replace function public.gm_set_state(p_participant uuid, p_state text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_p public.participants;
  g public.games;
begin
  select * into v_p from public.participants where id = p_participant;
  perform public.require_participant(v_p.game_id, array['gm']);
  select * into g from public.games where id = v_p.game_id;
  if p_state not in ('aktiv', 'gefangen', 'disqualifiziert', 'im_ziel', 'pausiert') then raise exception 'Unbekannter Status.' using errcode = 'P0001'; end if;
  if p_state = 'disqualifiziert' then
    perform public.disqualify(g, p_participant, 'Spielleitung', public.engine_now(g.id));
  elsif p_state = 'gefangen' then
    perform public.auto_catch(g, p_participant, 'Spielleitung', public.engine_now(g.id));
  elsif p_state = 'im_ziel' then
    perform public.reach_exit(g, p_participant, public.engine_now(g.id));
  else
    update public.participants set state = p_state where id = p_participant;
    if p_state = 'aktiv' and v_p.next_ping_at is null and v_p.role = 'spieler' then
      perform public.schedule_next_ping(g, p_participant, public.engine_now(g.id));
    end if;
  end if;
  perform public.bump(g.id);
end; $$;

create or replace function public.gm_end_game(p_game_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare g public.games;
begin
  if not public.is_game_leader(p_game_id) then raise exception 'Nur Host oder Spielleitung.' using errcode = '42501'; end if;
  select * into g from public.games where id = p_game_id;
  if g.status in ('entwurf', 'geplant', 'lobby') then
    update public.games set status = 'beendet', ended_at = now(), result_json = '{"reason": "abgebrochen", "winners": []}' where id = p_game_id;
  else
    perform public.finish_game(g, public.engine_now(p_game_id), 'abgebrochen');
  end if;
  perform public.bump(p_game_id);
end; $$;

-- Live-Regeländerung durch die Spielleitung (z. B. Ping-Intervall), mit Protokoll.
create or replace function public.gm_update_config(p_game_id uuid, p_config jsonb, p_changes jsonb default '[]'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  c jsonb;
  g public.games;
begin
  perform public.require_participant(p_game_id, array['gm']);
  select * into g from public.games where id = p_game_id;
  if not public.cfg_bool(g.config_json, 'ping', 'gm_can_change_live', true) then raise exception 'Live-Änderungen sind ausgeschaltet.' using errcode = 'P0001'; end if;
  update public.games set config_json = p_config, updated_at = now() where id = p_game_id;
  for c in select * from jsonb_array_elements(coalesce(p_changes, '[]')) loop
    insert into public.game_config_changes (game_id, changed_by, path, old_value, new_value) values (p_game_id, auth.uid(), c ->> 'path', c -> 'old', c -> 'new');
  end loop;
  perform public.notify(p_game_id, 'alle', null, 'rules_changed', 'Regeln geändert', (select string_agg(c ->> 'path', ', ') from jsonb_array_elements(coalesce(p_changes, '[]')) c), '{}', 'hoch');
  perform public.bump(p_game_id);
end; $$;

create or replace function public.briefing_confirm(p_game_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_me public.participants;
  g public.games;
begin
  v_me := public.require_participant(p_game_id, array['hunter', 'zentrale']);
  select * into g from public.games where id = p_game_id;
  update public.participants set briefing_done_day = g.current_day where id = v_me.id;
  perform public.bump(p_game_id);
end; $$;

-- ---------------------------------------------------------------------------
-- Chat (7.20)
-- ---------------------------------------------------------------------------

create or replace function public.send_message(p_game_id uuid, p_channel text, p_body text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_me public.participants;
  g public.games;
begin
  v_me := public.require_participant(p_game_id);
  select * into g from public.games where id = p_game_id;
  if p_channel = 'ankuendigung' and v_me.role <> 'gm' and not public.is_game_host(p_game_id) then
    raise exception 'Nur die Spielleitung kündigt an.' using errcode = '42501';
  elsif p_channel = 'taskforce' and v_me.role not in ('hunter', 'zentrale', 'gm') then
    raise exception 'Nur für die Taskforce.' using errcode = '42501';
  elsif p_channel = 'spieler' and (v_me.role not in ('spieler', 'gm') or (v_me.role = 'spieler' and not public.cfg_bool(g.config_json, 'communication', 'player_to_player', false))) then
    raise exception 'Chat zwischen Spielern ist in diesem Spiel aus.' using errcode = '42501';
  elsif p_channel like 'gm:%' and v_me.role <> 'gm' and p_channel <> 'gm:' || v_me.id::text then
    raise exception 'Nicht dein Kanal.' using errcode = '42501';
  elsif p_channel not in ('ankuendigung', 'taskforce', 'spieler') and p_channel not like 'gm:%' then
    raise exception 'Unbekannter Kanal.' using errcode = 'P0001';
  end if;
  insert into public.messages (game_id, channel, sender_id, sender_name, body, at)
  values (p_game_id, p_channel, auth.uid(), public.pname(v_me.id), trim(p_body), now());
end; $$;

create or replace function public.send_group_message(p_group_id uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_group_member(p_group_id) then raise exception 'Nicht in der Gruppe.' using errcode = '42501'; end if;
  insert into public.messages (group_id, channel, sender_id, sender_name, body, at)
  values (p_group_id, 'gruppe', auth.uid(), (select display_name from public.profiles where user_id = auth.uid()), trim(p_body), now());
end; $$;

-- Zugriffsrechte
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'require_participant', 'require_running', 'catch_code_at', 'catch_blocked_reason', 'register_catch', 'challenge_reward', 'pause_internal'
    )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
  end loop;
  for r in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'is_game_leader', 'start_game', 'advance_time', 'game_tick', 'report_location', 'set_device_check', 'speedhunt_start', 'speedhunt_approve',
      'speedhunt_query', 'my_catch_code', 'catch_by_code', 'catch_claim', 'catch_respond', 'catch_attach_media', 'gm_catch_decide',
      'confirm_exit', 'give_up', 'hideout_report', 'transit_checkin', 'transit_checkout', 'make_purchase', 'use_item', 'gm_grant_item',
      'challenge_create', 'challenge_cancel', 'challenge_join', 'challenge_submit', 'challenge_decide', 'pause_game', 'resume_game',
      'emergency_start', 'emergency_resolve', 'emergency_contact', 'violation_explain', 'violation_decide', 'violation_report',
      'gm_ping', 'gm_add_zone', 'gm_set_state', 'gm_end_game', 'gm_update_config', 'briefing_confirm', 'send_message', 'send_group_message'
    )
  loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;
