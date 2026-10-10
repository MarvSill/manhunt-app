-- Schritt 3 bis 6: Spiel-Engine (Kapitel 6, 7, 14, 23).
-- Server-autoritativ: alle Regelentscheidungen fallen hier. Die Engine wird
-- von engine_tick_all() (pg_cron, alle 15 s) und bei jedem Standort-Update
-- (report_location) für das betroffene Spiel aufgerufen.

-- ---------------------------------------------------------------------------
-- Geometrie
-- ---------------------------------------------------------------------------

create or replace function public.pt(p_lat double precision, p_lng double precision)
returns extensions.geometry language sql immutable set search_path = public, extensions as $$
  select ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
$$;

create or replace function public.dist_m(a extensions.geometry, b extensions.geometry)
returns double precision language sql immutable set search_path = public, extensions as $$
  select ST_Distance(a::geography, b::geography);
$$;

-- Spielfeld eines Spieltags: Zonen mit dem höchsten day_index <= Tag, sonst die ohne Tag.
create or replace function public.spielfeld_day(p_game_id uuid, p_day int)
returns extensions.geometry language sql stable security definer set search_path = public, extensions as $$
  with best as (
    select max(day_index) d from public.zones
    where game_id = p_game_id and kind = 'spielfeld' and day_index is not null and day_index <= greatest(p_day, 1)
  )
  select ST_Union(z.geom) from public.zones z, best
  where z.game_id = p_game_id and z.kind = 'spielfeld'
    and ((best.d is not null and z.day_index = best.d) or (best.d is null and z.day_index is null));
$$;

-- Erlaubter Bereich eines Spielers (7.2). Sperrzonen werden separat geprüft.
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
  v := public.spielfeld_day(p_game_id, p_day);
  if v is null then
    select ST_Union(geom) into v from public.zones where game_id = p_game_id and kind in ('sektion', 'startzone', 'center');
  end if;
  return v;
end; $$;

-- Zonentyp mit eigenem Ping-Intervall an einem Punkt (center > kern > aussen).
create or replace function public.zone_kind_at(p_game_id uuid, p_point extensions.geometry)
returns text language sql stable security definer set search_path = public, extensions as $$
  select kind from public.zones
  where game_id = p_game_id and kind in ('center', 'kern', 'aussen') and ST_Covers(geom, p_point)
  order by case kind when 'center' then 1 when 'kern' then 2 else 3 end
  limit 1;
$$;

create or replace function public.ping_interval_at(p_game public.games, p_point extensions.geometry)
returns int language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_zone public.zones;
  v_override int;
begin
  if p_point is not null then
    select * into v_zone from public.zones
    where game_id = p_game.id and kind in ('center', 'kern', 'aussen') and ST_Covers(geom, p_point)
    order by case kind when 'center' then 1 when 'kern' then 2 else 3 end limit 1;
    if v_zone.id is not null then
      if v_zone.ping_interval_override is not null then return v_zone.ping_interval_override; end if;
      v_override := (v_cfg #>> array['ping', 'zone_overrides', v_zone.kind])::int;
      if v_override is not null then return v_override; end if;
    end if;
  end if;
  return public.cfg_int(v_cfg, 'ping', 'interval_minutes', 120);
end; $$;

-- ---------------------------------------------------------------------------
-- Zeitraster
-- ---------------------------------------------------------------------------

-- Nächster Ping-Zeitpunkt strikt nach p_from (7.3, 14.4).
create or replace function public.next_ping_time(p_game public.games, p_from timestamptz, p_interval int)
returns timestamptz language plpgsql stable set search_path = public as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_offset int := public.cfg_int(v_cfg, 'ping', 'offset_minutes', 0);
  v_jitter int := public.cfg_int(v_cfg, 'ping', 'jitter_minutes', 0);
  v_base timestamptz;
  v_local timestamp;
  v_midnight timestamp;
  v_min double precision;
  v_k bigint;
  v_t timestamptz;
begin
  if public.cfg_bool(v_cfg, 'time', 'align_to_full_hour', true) then
    v_local := p_from at time zone p_game.timezone;
    v_midnight := date_trunc('day', v_local);
    v_min := extract(epoch from (v_local - v_midnight)) / 60.0;
    v_k := floor((v_min - v_offset) / p_interval) + 1;
    v_t := (v_midnight + make_interval(mins => (v_offset + v_k * p_interval)::int)) at time zone p_game.timezone;
  else
    v_base := p_game.hunt_start_at + make_interval(mins => public.cfg_int(v_cfg, 'ping', 'first_ping_delay_minutes', 0));
    v_k := greatest(1, floor(extract(epoch from (p_from - v_base)) / 60.0 / p_interval) + 1);
    v_t := v_base + make_interval(mins => (v_k * p_interval)::int);
  end if;
  if v_t <= p_from then v_t := v_t + make_interval(mins => p_interval); end if;
  if v_jitter > 0 then v_t := v_t + make_interval(secs => floor(random() * v_jitter * 60)); end if;
  return v_t;
end; $$;

-- Beginn von Spieltag d (6.4, 7.1).
create or replace function public.day_start(p_game public.games, p_day int)
returns timestamptz language plpgsql stable set search_path = public as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_len int := public.cfg_int(v_cfg, 'game', 'day_length_minutes', 1440);
  v_reset text := public.cfg_text(v_cfg, 'game', 'day_reset_time', '06:00');
  v_local timestamp;
  v_first timestamptz;
begin
  if p_day <= 1 then return p_game.hunt_start_at; end if;
  if v_len = 1440 and public.cfg_bool(v_cfg, 'time', 'align_to_full_hour', true) then
    v_local := date_trunc('day', p_game.hunt_start_at at time zone p_game.timezone) + v_reset::time;
    v_first := v_local at time zone p_game.timezone;
    if v_first <= p_game.hunt_start_at then v_first := v_first + interval '1 day'; end if;
    return v_first + make_interval(days => p_day - 2);
  end if;
  return p_game.hunt_start_at + make_interval(mins => (p_day - 1) * v_len);
end; $$;

-- Jagdfreie Zeiten (game.quiet_hours, lokale Zeit; über Mitternacht erlaubt).
create or replace function public.in_quiet_hours(p_game public.games, p_now timestamptz)
returns boolean language plpgsql stable set search_path = public as $$
declare
  v_t time := (p_now at time zone p_game.timezone)::time;
  q jsonb;
  v_from time;
  v_to time;
begin
  for q in select * from jsonb_array_elements(coalesce(p_game.config_json -> 'game' -> 'quiet_hours', '[]')) loop
    v_from := (q ->> 'from')::time;
    v_to := (q ->> 'to')::time;
    if (v_from <= v_to and v_t >= v_from and v_t < v_to) or (v_from > v_to and (v_t >= v_from or v_t < v_to)) then
      return true;
    end if;
  end loop;
  return false;
end; $$;

create or replace function public.speedhunt_quota(p_cfg jsonb, p_day int)
returns int language sql immutable as $$
  select coalesce((p_cfg -> 'speedhunt' -> 'quota_per_day' ->> (p_day - 1))::int,
                  public.cfg_int(p_cfg, 'speedhunt', 'quota_default', 2));
$$;

-- ---------------------------------------------------------------------------
-- Position und Pings
-- ---------------------------------------------------------------------------

-- Beste Position: Median der Punkte der letzten 30 s mit Genauigkeit < 100 m, sonst letzter Punkt (23.4).
create or replace function public.best_position(p_participant_id uuid, p_now timestamptz,
  out lat double precision, out lng double precision, out accuracy_m real, out age_s int)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_n int;
  v_last timestamptz;
begin
  select count(*), percentile_cont(0.5) within group (order by ST_Y(geom)),
         percentile_cont(0.5) within group (order by ST_X(geom)),
         percentile_cont(0.5) within group (order by s.accuracy_m), max(at)
    into v_n, lat, lng, accuracy_m, v_last
  from public.location_samples s
  where participant_id = p_participant_id and at > p_now - interval '30 seconds' and at <= p_now
    and coalesce(s.accuracy_m, 0) < 100 and not is_mock;
  if v_n > 0 then
    age_s := greatest(0, extract(epoch from (p_now - v_last))::int);
    return;
  end if;
  select p.lat, p.lng, p.accuracy_m, greatest(0, extract(epoch from (p_now - p.at))::int)
    into lat, lng, accuracy_m, age_s
  from public.positions p where participant_id = p_participant_id;
end; $$;

-- Ping erzeugen. Ein scharfer Fake-Ping ersetzt genau den nächsten Ping der passenden Art (14.3, Regel 6).
create or replace function public.create_ping(
  p_game public.games, p_participant_id uuid, p_source text, p_lat double precision, p_lng double precision,
  p_accuracy real, p_stale int, p_n int, p_speedhunt_id uuid, p_label text, p_delay_min int, p_now timestamptz
) returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_fake public.active_effects;
  v_id uuid;
  v_blur int := public.cfg_int(p_game.config_json, 'ping', 'precision_blur_m', 0);
  v_lat double precision := p_lat;
  v_lng double precision := p_lng;
  v_is_fake boolean := false;
  v_zone text;
begin
  if p_source in ('silent', 'speedhunt') and p_lat is not null then
    select * into v_fake from public.active_effects
    where participant_id = p_participant_id and type = 'fake_ping' and (ends_at is null or ends_at > p_now)
      and (payload ->> 'applies' in ('beide', p_source))
    order by starts_at limit 1;
    if v_fake.id is not null then
      v_lat := (v_fake.payload ->> 'lat')::double precision;
      v_lng := (v_fake.payload ->> 'lng')::double precision;
      v_is_fake := true;
      update public.active_effects set ends_at = p_now, payload = payload || '{"done": true}' where id = v_fake.id;
    end if;
  end if;
  if v_blur > 0 and v_lat is not null and not v_is_fake then
    v_lat := v_lat + (random() - 0.5) * 2 * v_blur / 111320.0;
    v_lng := v_lng + (random() - 0.5) * 2 * v_blur / (111320.0 * cos(radians(v_lat)));
  end if;
  if v_lat is not null then v_zone := public.zone_kind_at(p_game.id, public.pt(v_lat, v_lng)); end if;

  insert into public.pings (game_id, participant_id, at, visible_at, lat, lng, accuracy_m, source, n, speedhunt_id,
                            zone_kind, label, stale_seconds, is_fake)
  values (p_game.id, p_participant_id, p_now, p_now + make_interval(mins => coalesce(p_delay_min, 0)), v_lat, v_lng,
          p_accuracy, p_source, p_n, p_speedhunt_id, v_zone, p_label, p_stale, v_is_fake)
  returning id into v_id;
  if v_is_fake then
    insert into public.ping_truth (ping_id, lat, lng) values (v_id, p_lat, p_lng);
  end if;
  return v_id;
end; $$;

create or replace function public.schedule_next_ping(p_game public.games, p_participant_id uuid, p_from timestamptz)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_pos public.positions;
  v_interval int;
begin
  select * into v_pos from public.positions where participant_id = p_participant_id;
  v_interval := public.ping_interval_at(p_game, v_pos.geom);
  update public.participants
  set next_ping_at = public.next_ping_time(p_game, p_from, v_interval), ping_pending_until = null
  where id = p_participant_id;
end; $$;

create or replace function public.running_speedhunt_on(p_participant_id uuid)
returns public.speedhunts language sql stable security definer set search_path = public as $$
  select * from public.speedhunts where target_id = p_participant_id and status = 'laeuft' limit 1;
$$;

-- Fälliger Silent-Ping (14.4 mit Frische-Regel aus 23.4).
create or replace function public.process_ping_due(p_game public.games, p_p public.participants, p_now timestamptz)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_suppressed boolean;
  v_pos record;
  v_max_age int := public.cfg_int(v_cfg, 'ping', 'max_age_seconds', 60);
  v_wait int := public.cfg_int(v_cfg, 'ping', 'fresh_fix_wait_seconds', 30);
  v_hotel public.active_effects;
begin
  if p_p.next_ping_at is null or p_p.next_ping_at > p_now then return; end if;
  if p_p.state not in ('aktiv', 'ausserhalb') then
    if p_p.state in ('gefangen', 'disqualifiziert', 'aufgegeben', 'im_ziel') then
      update public.participants set next_ping_at = null where id = p_p.id;
    else
      perform public.schedule_next_ping(p_game, p_p.id, p_now);
    end if;
    return;
  end if;

  select * into v_hotel from public.active_effects
  where participant_id = p_p.id and type = 'hotel' and starts_at <= p_now and (ends_at is null or ends_at > p_now) limit 1;
  v_suppressed := public.in_quiet_hours(p_game, p_now)
    or public.has_effect(p_p.id, 'regeneration', p_now)
    or public.has_effect(p_p.id, 'leo', p_now)
    or (public.cfg_text(v_cfg, 'ping', 'during_speedhunt', 'weiterlaufen') = 'aussetzen' and (public.running_speedhunt_on(p_p.id)).id is not null)
    or (v_hotel.id is not null and public.cfg_text(v_cfg, 'bonus', 'hotel_pings', 'weiter') = 'pausiert');
  if v_suppressed then
    if public.cfg_bool(v_cfg, 'ping', 'show_suppressed_to_taskforce', false) then
      perform public.create_ping(p_game, p_p.id, 'kein_signal', null, null, null, null, null, null, null, 0, p_now);
    end if;
    perform public.schedule_next_ping(p_game, p_p.id, p_now);
    return;
  end if;

  select * into v_pos from public.best_position(p_p.id, p_now);
  if v_pos.lat is null then
    perform public.create_ping(p_game, p_p.id, 'kein_signal', null, null, null, null, null, null, 'Noch kein Standort', 0, p_now);
    perform public.schedule_next_ping(p_game, p_p.id, p_now);
    return;
  end if;
  if v_pos.age_s > v_max_age then
    if p_p.ping_pending_until is null then
      update public.participants set ping_pending_until = p_now + make_interval(secs => v_wait), location_request_at = p_now
      where id = p_p.id;
      return;
    elsif p_now < p_p.ping_pending_until then
      return;
    end if;
  end if;

  perform public.create_ping(p_game, p_p.id, 'silent', v_pos.lat, v_pos.lng, v_pos.accuracy_m,
    case when v_pos.age_s > v_max_age then v_pos.age_s end, null, null, null, 0, p_now);
  update public.participants set last_silent_ping_at = p_now, location_request_at = null where id = p_p.id;
  perform public.schedule_next_ping(p_game, p_p.id, p_now);
  if public.cfg_bool(v_cfg, 'ping', 'notify_player', false) then
    perform public.notify(p_game.id, null, p_p.id, 'ping_self', 'Du wurdest gepingt', '', '{}', 'normal');
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- Verstösse und Strafen (7.17)
-- ---------------------------------------------------------------------------

create or replace function public.default_penalty(p_cfg jsonb, p_type text)
returns text language sql immutable as $$
  select case p_type
    when 'ausserhalb_limit' then 'straf_speedhunt'
    when 'sperrzone' then 'verwarnung'
    when 'verschanzen_limit' then 'straf_speedhunt'
    when 'versteck_gesperrt' then 'straf_speedhunt'
    when 'oev_nicht_angemeldet' then 'straf_speedhunt'
    when 'fahrzeug_verbotene_zone' then 'straf_speedhunt'
    when 'faehren_limit' then 'verwarnung'
    when 'signalverlust' then 'straf_speedhunt'
    when 'hunter_hq' then 'verwarnung'
    else 'verwarnung'
  end;
$$;

create or replace function public.create_violation(p_game public.games, p_participant_id uuid, p_type text,
  p_evidence jsonb, p_now timestamptz, p_penalty text default null, p_detected_by text default 'auto')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_penalty text := coalesce(p_penalty, public.default_penalty(v_cfg, p_type));
  v_esc jsonb := coalesce(v_cfg -> 'penalty' -> 'escalation', '["verwarnung","straf_speedhunt","disqualifikation"]');
  v_prior int;
  v_idx int;
  v_mode text := public.cfg_text(v_cfg, 'roles', 'gm_mode', 'auto');
  v_id uuid;
begin
  -- Eskalation bei Wiederholung desselben Verstosses (penalty.escalation).
  if p_penalty is null and p_type not in ('fahrzeug_verbotene_zone') then
    select count(*) into v_prior from public.violations
    where participant_id = p_participant_id and type = p_type and status = 'verhaengt';
    select (ord - 1) into v_idx from jsonb_array_elements_text(v_esc) with ordinality e(val, ord) where val = v_penalty;
    if v_idx is not null and v_prior > 0 then
      v_penalty := v_esc ->> least(v_idx + v_prior, jsonb_array_length(v_esc) - 1);
    end if;
  end if;
  insert into public.violations (game_id, participant_id, type, detected_by, at, evidence, proposed_penalty, auto_apply_at)
  values (p_game.id, p_participant_id, p_type, p_detected_by, p_now, coalesce(p_evidence, '{}'), v_penalty,
          case when v_mode in ('auto', 'beides')
               then p_now + make_interval(secs => public.cfg_int(v_cfg, 'penalty', 'auto_apply_delay_seconds', 60)) end)
  returning id into v_id;
  perform public.notify(p_game.id, null, p_participant_id, 'violation', 'Regelverstoss: ' || replace(p_type, '_', ' '),
    'Vorgeschlagene Strafe: ' || replace(v_penalty, '_', ' ') || '. Du kannst eine Erklärung abgeben.',
    jsonb_build_object('violation_id', v_id), 'hoch');
  perform public.notify(p_game.id, 'gm', null, 'violation', 'Verstoss: ' || public.pname(p_participant_id),
    replace(p_type, '_', ' ') || ' · Vorschlag: ' || replace(v_penalty, '_', ' '), jsonb_build_object('violation_id', v_id), 'hoch');
  return v_id;
end; $$;

-- ---------------------------------------------------------------------------
-- Speedhunt (7.4, 7.5)
-- ---------------------------------------------------------------------------

create or replace function public.start_speedhunt_internal(p_game public.games, p_target uuid, p_by uuid,
  p_is_penalty boolean, p_now timestamptz, p_status text default 'laeuft')
returns public.speedhunts language plpgsql security definer set search_path = public as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_sh public.speedhunts;
  v_queries int := public.cfg_int(v_cfg, 'speedhunt', 'queries', 4);
  v_used int := 0;
  v_min_after int := public.cfg_int(v_cfg, 'speedhunt', 'min_minutes_after_silent_ping', 0);
  v_last timestamptz;
  v_text text := public.cfg_text(v_cfg, 'speedhunt', 'announce_text', 'Speedhunt gestartet!');
begin
  if p_status = 'laeuft' and not p_is_penalty and v_min_after > 0 then
    select last_silent_ping_at into v_last from public.participants where id = p_target;
    if v_last is not null and v_last > p_now - make_interval(mins => v_min_after) then
      v_used := 1; -- Wien: Silent-Ping zählt als erste Abfrage
    end if;
  end if;
  insert into public.speedhunts (game_id, target_id, day_index, triggered_by, is_penalty, status, queries_total, queries_used,
                                 created_at, started_at, deadline_at)
  values (p_game.id, p_target, p_game.current_day, p_by, p_is_penalty, p_status, v_queries, v_used, p_now,
          case when p_status = 'laeuft' then p_now end,
          case when p_status = 'laeuft' then p_now + make_interval(mins => public.cfg_int(v_cfg, 'speedhunt', 'max_duration_minutes', 90)) end)
  returning * into v_sh;

  if p_status = 'laeuft' then
    update public.games set last_speedhunt_target = p_target where id = p_game.id;
    perform public.notify(p_game.id, 'spieler', null, 'speedhunt_start', 'SPEEDHUNT!',
      v_text || ' Einer von euch wird gejagt.', jsonb_build_object('speedhunt_id', v_sh.id), 'kritisch');
    perform public.notify(p_game.id, 'taskforce', null, 'speedhunt_start',
      case when p_is_penalty then 'Straf-Speedhunt: ' else 'Speedhunt: ' end || public.pname(p_target),
      v_queries - v_used || ' Abfragen, max. ' || public.cfg_int(v_cfg, 'speedhunt', 'max_duration_minutes', 90) || ' min',
      jsonb_build_object('speedhunt_id', v_sh.id), 'kritisch');
    if public.cfg_bool(v_cfg, 'speedhunt', 'reveal_target_to_target', false) then
      perform public.notify(p_game.id, null, p_target, 'speedhunt_target', 'Du bist das Ziel!', '', '{}', 'kritisch');
    end if;
    if v_used = 1 then
      perform public.notify(p_game.id, 'taskforce', null, 'speedhunt_info', 'Silent-Ping zählt als Abfrage 1',
        'Der letzte Silent-Ping liegt weniger als ' || v_min_after || ' min zurück.', '{}', 'normal');
    end if;
  end if;
  return v_sh;
end; $$;

create or replace function public.end_speedhunt(p_game public.games, p_sh public.speedhunts, p_reason text, p_now timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_leo_end timestamptz;
begin
  update public.speedhunts set status = 'beendet', ended_at = p_now, end_reason = p_reason where id = p_sh.id;
  if p_sh.status <> 'laeuft' then return; end if;
  perform public.notify(p_game.id, 'alle', null, 'speedhunt_end', 'Speedhunt beendet', '',
    jsonb_build_object('speedhunt_id', p_sh.id, 'reason', p_reason), 'normal');
  if p_reason <> 'gefangen' and public.cfg_bool(v_cfg, 'leo', 'enabled', false) then
    if public.cfg_text(v_cfg, 'leo', 'mode', 'bis_ende_naechste_volle_stunde') = 'feste_dauer' then
      v_leo_end := p_now + make_interval(mins => public.cfg_int(v_cfg, 'leo', 'duration_minutes', 60));
    else
      -- Ende der nächsten vollen Stunde: 14:20 -> 16:00 (Akzeptanztest 6).
      v_leo_end := date_trunc('hour', p_now) + interval '2 hours';
    end if;
    insert into public.active_effects (game_id, participant_id, type, starts_at, ends_at)
    values (p_game.id, p_sh.target_id, 'leo', p_now, v_leo_end);
  end if;
end; $$;

create or replace function public.speedhunt_query_internal(p_game public.games, p_sh public.speedhunts, p_now timestamptz)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_pos record;
  v_n int := p_sh.queries_used + 1;
  v_ping uuid;
  v_live int := public.cfg_int(v_cfg, 'speedhunt', 'vehicle_live_seconds', 60);
  v_speed real;
  v_in_vehicle boolean;
begin
  select * into v_pos from public.best_position(p_sh.target_id, p_now);
  v_ping := public.create_ping(p_game, p_sh.target_id, 'speedhunt', v_pos.lat, v_pos.lng, v_pos.accuracy_m,
    case when v_pos.age_s > public.cfg_int(v_cfg, 'ping', 'max_age_seconds', 60) then v_pos.age_s end,
    v_n, p_sh.id, null, 0, p_now);
  update public.speedhunts set queries_used = v_n, last_query_at = p_now where id = p_sh.id;
  update public.participants set location_request_at = p_now where id = p_sh.target_id;

  select speed_mps into v_speed from public.positions where participant_id = p_sh.target_id;
  v_in_vehicle := exists (select 1 from public.transit_sessions where participant_id = p_sh.target_id and ended_at is null)
    or coalesce(v_speed, 0) * 3.6 > public.cfg_int(v_cfg, 'transport', 'speed_threshold_kmh', 8);
  if v_in_vehicle and v_live > 0 then
    perform public.open_live_window(p_game.id, p_sh.target_id, 'fahrzeug', p_now, p_now + make_interval(secs => v_live));
  end if;

  if public.cfg_bool(v_cfg, 'speedhunt', 'notify_each_query_to_players', true) then
    perform public.notify(p_game.id, 'spieler', null, 'speedhunt_query', 'SPEEDHUNT: Abfrage ' || v_n || ' von ' || p_sh.queries_total,
      '', jsonb_build_object('speedhunt_id', p_sh.id), 'hoch');
  end if;
  perform public.notify(p_game.id, 'taskforce', null, 'speedhunt_query',
    'Abfrage ' || v_n || '/' || p_sh.queries_total || ': ' || public.pname(p_sh.target_id),
    case when v_in_vehicle and v_live > 0 then 'Ziel ist unterwegs: ' || v_live || ' s live.' else '' end,
    jsonb_build_object('speedhunt_id', p_sh.id, 'ping_id', v_ping), 'hoch');

  if v_n >= p_sh.queries_total then
    select * into p_sh from public.speedhunts where id = p_sh.id;
    perform public.end_speedhunt(p_game, p_sh, 'abfragen_aufgebraucht', p_now);
  end if;
  return v_ping;
end; $$;

-- ---------------------------------------------------------------------------
-- Fang (7.6) und Spielende (7.19)
-- ---------------------------------------------------------------------------

create or replace function public.free_players(p_game_id uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.participants
  where game_id = p_game_id and role = 'spieler' and state in ('aktiv', 'ausserhalb', 'notfall');
$$;

create or replace function public.finish_game(p_game public.games, p_now timestamptz, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_exit boolean := public.cfg_bool(v_cfg, 'exit', 'enabled', true) and public.cfg_text(v_cfg, 'win', 'mode', 'alle_ueberlebenden') <> 'letzter_ueberlebender';
  v_missed text := public.cfg_text(v_cfg, 'exit', 'missed_policy', 'verloren');
  v_mode text := public.cfg_text(v_cfg, 'win', 'mode', 'alle_ueberlebenden');
  v_winners jsonb;
  v_scores jsonb;
  v_hours double precision;
  v_sh public.speedhunts;
  v_names text;
begin
  if p_game.status = 'beendet' then return; end if;
  for v_sh in select * from public.speedhunts where game_id = p_game.id and status in ('laeuft', 'wartet_auf_freigabe', 'aufgeschoben') loop
    perform public.end_speedhunt(p_game, v_sh, 'spielende', p_now);
  end loop;
  update public.live_windows set ends_at = p_now where game_id = p_game.id and (ends_at is null or ends_at > p_now);
  update public.active_effects set ends_at = p_now where game_id = p_game.id and (ends_at is null or ends_at > p_now);

  select coalesce(jsonb_agg(id), '[]') into v_winners from public.participants
  where game_id = p_game.id and role = 'spieler' and (
    state = 'im_ziel'
    or (state in ('aktiv', 'ausserhalb', 'notfall') and (not v_exit or v_missed = 'gewonnen_ohne_exit'))
  );

  -- Punkte (win.mode = punkte): Spieler 10 pro überlebte Stunde, 50 für den Exit, 20 pro Challenge; Hunter Kopfgeld.
  select coalesce(jsonb_object_agg(p.id, case
      when p.role = 'spieler' then
        round(10 * extract(epoch from (coalesce(p.caught_at, p.finished_at, p_now) - p_game.hunt_start_at)) / 3600.0)
        + case when p.state = 'im_ziel' then 50 else 0 end
        + 20 * (select count(*) from public.challenge_entries e where e.participant_id = p.id and e.result = 'erfolgreich')
      else p.bounty end), '{}')
    into v_scores
  from public.participants p where p.game_id = p_game.id and p.role in ('spieler', 'hunter', 'zentrale');

  v_hours := extract(epoch from (p_now - p_game.hunt_start_at)) / 3600.0;
  update public.games set status = 'beendet', ended_at = p_now, result_json = jsonb_build_object(
    'reason', p_reason,
    'winners', v_winners,
    'mode', v_mode,
    'scores', v_scores,
    'hours', round(v_hours::numeric, 2),
    'catches', (select count(*) from public.catches where game_id = p_game.id and status = 'gueltig'),
    'pings', (select count(*) from public.pings where game_id = p_game.id),
    'speedhunts', (select count(*) from public.speedhunts where game_id = p_game.id and started_at is not null)
  ) where id = p_game.id;
  update public.participants set state = 'verloren' where game_id = p_game.id and role = 'spieler'
    and state in ('aktiv', 'ausserhalb', 'notfall') and not (v_winners ? id::text);

  select string_agg(public.pname(w::uuid), ', ') into v_names from jsonb_array_elements_text(v_winners) w;
  perform public.notify(p_game.id, 'alle', null, 'game_end', 'Spielende!',
    case when v_names is null then 'Keine Sieger: die Taskforce hat gewonnen.' else 'Sieger: ' || v_names end,
    jsonb_build_object('reason', p_reason), 'hoch');
  perform public.log_game_event(p_game.id, 'game_ended', jsonb_build_object('reason', p_reason));
end; $$;

-- Gültiger Fang mit allen Folgen (7.6).
create or replace function public.apply_catch(p_game public.games, p_catch_id uuid, p_now timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_c public.catches;
  v_sh public.speedhunts;
  v_free int;
begin
  select * into v_c from public.catches where id = p_catch_id;
  update public.catches set status = 'gueltig' where id = v_c.id;
  update public.participants set state = 'gefangen', caught_at = p_now, next_ping_at = null where id = v_c.runner_id;
  for v_sh in select * from public.speedhunts where target_id = v_c.runner_id and status in ('laeuft', 'aufgeschoben', 'wartet_auf_freigabe') loop
    perform public.end_speedhunt(p_game, v_sh, 'gefangen', p_now);
  end loop;
  update public.live_windows set ends_at = p_now where participant_id = v_c.runner_id and (ends_at is null or ends_at > p_now);
  update public.active_effects set ends_at = p_now where participant_id = v_c.runner_id and (ends_at is null or ends_at > p_now);
  update public.hideouts set status = 'verlassen', inside = false, left_at = p_now where participant_id = v_c.runner_id and status = 'aktiv';
  update public.transit_sessions set ended_at = p_now where participant_id = v_c.runner_id and ended_at is null;
  if public.cfg_bool(v_cfg, 'zone', 'release_on_catch', false) then
    update public.zones set released = true where game_id = p_game.id and kind = 'sektion' and owner_participant_id = v_c.runner_id;
  end if;
  if v_c.hunter_id is not null then
    update public.participants set bounty = bounty + public.cfg_int(v_cfg, 'taskforce', 'bounty_per_catch', 1000) where id = v_c.hunter_id;
  end if;
  if public.cfg_bool(v_cfg, 'speedhunt', 'catch_removes_one', true) then
    update public.games set speedhunts_left = greatest(0, speedhunts_left - 1) where id = p_game.id;
  end if;
  if public.cfg_text(v_cfg, 'catch', 'caught_player_becomes', 'zuschauer') = 'hunter_helfer' then
    update public.participants set role = 'hunter', state = 'aktiv' where id = v_c.runner_id;
  end if;
  v_free := public.free_players(p_game.id);
  if public.cfg_bool(v_cfg, 'catch', 'announce_to_players', true) then
    perform public.notify(p_game.id, 'alle', null, 'catch', public.pname(v_c.runner_id) || ' wurde gefangen',
      'Noch ' || v_free || ' Spieler frei.', jsonb_build_object('catch_id', v_c.id), 'hoch');
  else
    perform public.notify(p_game.id, 'taskforce', null, 'catch', public.pname(v_c.runner_id) || ' wurde gefangen',
      'Noch ' || v_free || ' Spieler frei.', jsonb_build_object('catch_id', v_c.id), 'hoch');
    perform public.notify(p_game.id, null, v_c.runner_id, 'catch', 'Du wurdest gefangen', '', '{}', 'hoch');
  end if;
  perform public.log_game_event(p_game.id, 'catch', jsonb_build_object('runner', v_c.runner_id, 'hunter', v_c.hunter_id));
  if v_free = 0 or (public.cfg_text(v_cfg, 'win', 'mode', 'alle_ueberlebenden') = 'letzter_ueberlebender' and v_free <= 1) then
    select * into p_game from public.games where id = p_game.id;
    perform public.finish_game(p_game, p_now, case when v_free = 0 then 'alle_gefangen' else 'letzter_ueberlebender' end);
  end if;
end; $$;

create or replace function public.auto_catch(p_game public.games, p_runner uuid, p_reason text, p_now timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into public.catches (game_id, runner_id, at, method, status, reason)
  values (p_game.id, p_runner, p_now, 'auto', 'gueltig', p_reason) returning id into v_id;
  perform public.apply_catch(p_game, v_id, p_now);
end; $$;

create or replace function public.disqualify(p_game public.games, p_participant uuid, p_reason text, p_now timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare v_sh public.speedhunts;
begin
  update public.participants set state = 'disqualifiziert', next_ping_at = null where id = p_participant;
  for v_sh in select * from public.speedhunts where target_id = p_participant and status in ('laeuft', 'aufgeschoben', 'wartet_auf_freigabe') loop
    perform public.end_speedhunt(p_game, v_sh, 'disqualifiziert', p_now);
  end loop;
  update public.live_windows set ends_at = p_now where participant_id = p_participant and (ends_at is null or ends_at > p_now);
  perform public.notify(p_game.id, 'alle', null, 'disqualified', public.pname(p_participant) || ' ist disqualifiziert', p_reason, '{}', 'hoch');
  if public.free_players(p_game.id) = 0 then
    select * into p_game from public.games where id = p_game.id;
    perform public.finish_game(p_game, p_now, 'alle_ausgeschieden');
  end if;
end; $$;

create or replace function public.apply_penalty(p_game public.games, p_violation_id uuid, p_penalty text, p_now timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare
  v public.violations;
  v_p public.participants;
begin
  select * into v from public.violations where id = p_violation_id;
  select * into v_p from public.participants where id = v.participant_id;
  update public.violations set status = 'verhaengt', decided_penalty = p_penalty, decided_at = p_now where id = v.id;
  if v_p.state not in ('aktiv', 'ausserhalb', 'notfall') and v_p.role = 'spieler' then return; end if;
  case p_penalty
    when 'verwarnung' then
      perform public.notify(p_game.id, null, v.participant_id, 'penalty', 'Verwarnung', replace(v.type, '_', ' '), '{}', 'hoch');
    when 'straf_speedhunt' then
      if v_p.role <> 'spieler' then
        perform public.notify(p_game.id, null, v.participant_id, 'penalty', 'Verwarnung', replace(v.type, '_', ' '), '{}', 'hoch');
      elsif public.has_effect(v.participant_id, 'regeneration', p_now) then
        -- Straf-Speedhunts werden bis zum Ende des Regenerations-Jokers aufgeschoben (14.3, Regel 3).
        perform public.start_speedhunt_internal(p_game, v.participant_id, null, true, p_now, 'aufgeschoben');
      else
        perform public.start_speedhunt_internal(p_game, v.participant_id, null, true, p_now);
      end if;
      perform public.notify(p_game.id, 'gm', null, 'penalty', 'Straf-Speedhunt: ' || public.pname(v.participant_id), replace(v.type, '_', ' '), '{}', 'normal');
    when 'disqualifikation' then
      perform public.disqualify(p_game, v.participant_id, 'Strafe: ' || replace(v.type, '_', ' '), p_now);
    when 'catch' then
      perform public.auto_catch(p_game, v.participant_id, 'Strafe: ' || v.type, p_now);
    when 'sofort_ping' then
      declare v_pos record;
      begin
        select * into v_pos from public.best_position(v.participant_id, p_now);
        perform public.create_ping(p_game, v.participant_id, 'penalty', v_pos.lat, v_pos.lng, v_pos.accuracy_m, v_pos.age_s, null, null, 'Strafe', 0, p_now);
      end;
    when 'live_standort' then
      perform public.open_live_window(p_game.id, v.participant_id, 'strafe', p_now, p_now + interval '15 minutes');
    else
      null;
  end case;
end; $$;

-- ---------------------------------------------------------------------------
-- Spieltag (6.4) und Jagdbeginn
-- ---------------------------------------------------------------------------

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
  v_have int;
  i int;
begin
  if not public.cfg_bool(v_cfg, 'joker', 'enabled', false) or v_n = 0 or v_per = 0 then return; end if;
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

create or replace function public.schedule_random_speedhunts(p_game public.games, p_now timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_until timestamptz := coalesce(p_game.next_day_at, p_game.ends_at);
  v_times jsonb := '[]';
  i int;
begin
  if public.cfg_text(p_game.config_json, 'speedhunt', 'trigger_mode', 'taskforce') <> 'random'
     or not public.cfg_bool(p_game.config_json, 'speedhunt', 'enabled', true) then return; end if;
  for i in 1..p_game.speedhunts_left loop
    v_times := v_times || to_jsonb(p_now + (v_until - p_now) * random());
  end loop;
  update public.games set state_json = state_json || jsonb_build_object('random_speedhunts', v_times) where id = p_game.id;
end; $$;

-- Zonenprüfung für alle Spieler nach Spielfeldwechsel.
create or replace function public.recheck_zones(p_game public.games, p_now timestamptz)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_pos public.positions;
  v_p public.participants;
begin
  for v_p in select * from public.participants where game_id = p_game.id and role = 'spieler' and state in ('aktiv', 'ausserhalb') loop
    select * into v_pos from public.positions where participant_id = v_p.id;
    if v_pos.participant_id is not null then
      perform public.check_player_zone(p_game, v_p, v_pos.geom, p_now);
    end if;
  end loop;
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
  v_changed := exists (select 1 from public.zones where game_id = p_game.id and kind = 'spielfeld' and day_index = v_day);
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

create or replace function public.hunt_begin(p_game public.games, p_now timestamptz)
returns public.games language plpgsql security definer set search_path = public as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_p public.participants;
begin
  update public.games set status = 'laeuft', current_day = 0 where id = p_game.id returning * into p_game;
  if public.cfg_bool(v_cfg, 'budget', 'enabled', false) then
    update public.participants set budget_balance = public.cfg_int(v_cfg, 'budget', 'start_amount', 30)
    where game_id = p_game.id and role = 'spieler';
  end if;
  p_game := public.day_reset(p_game, p_now);
  -- Budget am ersten Tag: Startbetrag statt Tagesbetrag
  if public.cfg_bool(v_cfg, 'budget', 'enabled', false) then
    update public.participants set budget_balance = public.cfg_int(v_cfg, 'budget', 'start_amount', 30)
    where game_id = p_game.id and role = 'spieler';
  end if;
  for v_p in select * from public.participants where game_id = p_game.id and role = 'spieler' and state = 'aktiv' loop
    perform public.schedule_next_ping(p_game, v_p.id,
      p_game.hunt_start_at + make_interval(mins => public.cfg_int(v_cfg, 'ping', 'first_ping_delay_minutes', 0)));
  end loop;
  perform public.notify(p_game.id, 'alle', null, 'hunt_begin', 'Die Jagd beginnt!', 'Die Taskforce ist unterwegs.', '{}', 'hoch');
  perform public.log_game_event(p_game.id, 'hunt_begin');
  return p_game;
end; $$;

-- ---------------------------------------------------------------------------
-- Standortverarbeitung (14.2)
-- ---------------------------------------------------------------------------

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
    if public.cfg_bool(v_cfg, 'out_of_bounds', 'live_visible', true) then
      perform public.open_live_window(p_game.id, p_p.id, 'ausserhalb', p_now, null);
    end if;
    perform public.notify(p_game.id, null, p_p.id, 'outside', 'Du bist ausserhalb!',
      greatest(0, v_max - p_p.out_accum_s / 60) || ' min bis ' ||
      case public.cfg_text(v_cfg, 'out_of_bounds', 'on_timeout', 'disqualify')
        when 'catch' then 'zum Fang' when 'disqualify' then 'zur Disqualifikation' else 'zur Strafe' end || '. Die Taskforce sieht dich live.',
      '{}', 'kritisch');
    perform public.notify(p_game.id, 'taskforce', null, 'outside', public.pname(p_p.id) || ' ist ausserhalb', 'Live-Standort sichtbar.', '{}', 'hoch');
    perform public.notify(p_game.id, 'gm', null, 'outside', public.pname(p_p.id) || ' ist ausserhalb', '', '{}', 'normal');
  end if;
end; $$;

create or replace function public.check_transport(p_game public.games, p_p public.participants, p_point extensions.geometry, p_speed real, p_now timestamptz)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_threshold int := public.cfg_int(v_cfg, 'transport', 'speed_threshold_kmh', 8);
  v_detect int := public.cfg_int(v_cfg, 'transport', 'detect_seconds', 90);
  v_in_transit boolean := exists (select 1 from public.transit_sessions where participant_id = p_p.id and ended_at is null);
  v_fast boolean := coalesce(p_speed, 0) * 3.6 > v_threshold;
  v_forbidden jsonb := coalesce(v_cfg -> 'transport' -> 'forbidden_in_zone_types', '[]');
  v_kind text;
  v_repeat int := public.cfg_int(v_cfg, 'transport', 'violation_repeat_minutes', 10);
begin
  -- Fahrzeug in verbotener Zone (Bangkok: center) – alle violation_repeat_minutes ein neuer Verstoss.
  if (v_in_transit or v_fast) and jsonb_array_length(v_forbidden) > 0 then
    select kind into v_kind from public.zones where game_id = p_game.id and v_forbidden ? kind and ST_Covers(geom, p_point) limit 1;
  end if;
  if v_kind is not null then
    if p_p.forbidden_since is null then
      update public.participants set forbidden_since = p_now, forbidden_last_violation_at = p_now where id = p_p.id;
      perform public.create_violation(p_game, p_p.id, 'fahrzeug_verbotene_zone', jsonb_build_object('zone', v_kind), p_now);
    elsif p_now - p_p.forbidden_last_violation_at >= make_interval(mins => v_repeat) then
      update public.participants set forbidden_last_violation_at = forbidden_last_violation_at + make_interval(mins => v_repeat) where id = p_p.id;
      perform public.create_violation(p_game, p_p.id, 'fahrzeug_verbotene_zone', jsonb_build_object('zone', v_kind, 'wiederholt', true), p_now);
    end if;
  elsif p_p.forbidden_since is not null then
    update public.participants set forbidden_since = null, forbidden_last_violation_at = null where id = p_p.id;
  end if;

  -- Unangemeldete Fahrt erkennen (7.9)
  if v_in_transit or not v_fast then
    if p_p.speeding_since is not null then
      update public.participants set speeding_since = null, transport_prompted_at = null where id = p_p.id;
    end if;
    return;
  end if;
  if not public.cfg_bool(v_cfg, 'transport', 'checkin_required', true) then return; end if;
  if p_p.speeding_since is null then
    update public.participants set speeding_since = p_now where id = p_p.id;
  elsif p_p.transport_prompted_at is null and p_now - p_p.speeding_since >= make_interval(secs => v_detect) then
    update public.participants set transport_prompted_at = p_now where id = p_p.id;
    perform public.notify(p_game.id, null, p_p.id, 'transport_prompt', 'Fährst du?', 'Du bist schnell unterwegs. Jetzt Transport anmelden!', '{}', 'hoch');
    perform public.notify(p_game.id, 'gm', null, 'transport_prompt', 'Transport-Verdacht: ' || public.pname(p_p.id), '', '{}', 'normal');
  elsif p_p.transport_prompted_at is not null and p_now - p_p.transport_prompted_at >= interval '2 minutes' then
    update public.participants set speeding_since = null, transport_prompted_at = null where id = p_p.id;
    perform public.create_violation(p_game, p_p.id, 'oev_nicht_angemeldet',
      jsonb_build_object('speed_kmh', round((p_speed * 3.6)::numeric, 1), 'lat', ST_Y(p_point), 'lng', ST_X(p_point)), p_now);
  end if;
end; $$;

create or replace function public.check_hideout(p_game public.games, p_p public.participants, p_point extensions.geometry, p_now timestamptz)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_h public.hideouts;
  v_radius int := public.cfg_int(v_cfg, 'hideout', 'stationary_radius_m', 40);
  v_minutes int := public.cfg_int(v_cfg, 'hideout', 'stationary_minutes', 20);
  v_leave int := public.cfg_int(v_cfg, 'hideout', 'min_leave_distance_m', 200);
  v_detection text := public.cfg_text(v_cfg, 'hideout', 'detection', 'beides');
begin
  if not public.cfg_bool(v_cfg, 'hideout', 'enabled', true) then return; end if;
  select * into v_h from public.hideouts where participant_id = p_p.id and status = 'aktiv' limit 1;
  if v_h.id is not null then
    -- Versteck gilt erst als verlassen, wenn der Mindestabstand erreicht ist (7.8).
    if public.dist_m(v_h.center, p_point) > v_leave then
      update public.hideouts set status = 'verlassen', inside = false, left_at = p_now where id = v_h.id;
      perform public.notify(p_game.id, null, p_p.id, 'hideout_left', 'Versteck verlassen', 'Mindestabstand erreicht.', '{}', 'normal');
    elsif v_h.inside and public.dist_m(v_h.center, p_point) > greatest(v_radius * 2, 60) then
      update public.hideouts set inside = false where id = v_h.id;
    end if;
    return;
  end if;
  if v_detection = 'selbstmeldung' then return; end if;
  -- Automatische Erkennung: Stillstand innerhalb des Radius (7.8)
  if p_p.stationary_center is null or public.dist_m(p_p.stationary_center, p_point) > v_radius then
    update public.participants set stationary_center = p_point, stationary_since = p_now, hideout_prompted_at = null where id = p_p.id;
  elsif p_p.hideout_prompted_at is null and p_now - p_p.stationary_since >= make_interval(mins => v_minutes) then
    update public.participants set hideout_prompted_at = p_now where id = p_p.id;
    perform public.notify(p_game.id, null, p_p.id, 'hideout_prompt', 'Bist du verschanzt?',
      'Du bist seit ' || v_minutes || ' min am selben Ort. Bist du in einem nicht öffentlichen Ort (Wohnung, Haus)?',
      jsonb_build_object('since', p_p.stationary_since), 'hoch');
  end if;
end; $$;

create or replace function public.check_proximity(p_game public.games, p_now timestamptz)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_dist int := public.cfg_int(v_cfg, 'proximity', 'distance_m', 250);
  v_hyst int := public.cfg_int(v_cfg, 'proximity', 'hysteresis_m', 50);
  v_repeat int := public.cfg_int(v_cfg, 'proximity', 'repeat_minutes', 0);
  v_pair record;
  v_state public.proximity_pairs;
  v_suspended boolean;
begin
  if not public.cfg_bool(v_cfg, 'proximity', 'enabled', true) then return; end if;
  if p_now < p_game.hunt_start_at + make_interval(mins => public.cfg_int(v_cfg, 'proximity', 'active_after_minutes', 60)) then return; end if;
  -- Challenge-Fenster: Regel ausgesetzt (7.13, 7.14)
  v_suspended := exists (
    select 1 from public.challenges c where c.game_id = p_game.id and c.status <> 'abgesagt'
      and p_now between c.starts_at - make_interval(mins => public.cfg_int(v_cfg, 'challenge', 'suspend_proximity_before_minutes', 60))
                    and c.ends_at + make_interval(mins => public.cfg_int(v_cfg, 'challenge', 'suspend_proximity_after_minutes', 60))
  );
  if v_suspended then return; end if;

  for v_pair in
    select a.id a_id, b.id b_id, pa.geom ga, pb.geom gb, pa.lat alat, pa.lng alng, pa.accuracy_m aacc, pb.lat blat, pb.lng blng, pb.accuracy_m bacc,
           public.dist_m(pa.geom, pb.geom) d
    from public.participants a
    join public.participants b on b.game_id = a.game_id and b.id > a.id
    join public.positions pa on pa.participant_id = a.id
    join public.positions pb on pb.participant_id = b.id
    where a.game_id = p_game.id and a.role = 'spieler' and b.role = 'spieler'
      and a.state in ('aktiv', 'ausserhalb') and b.state in ('aktiv', 'ausserhalb')
      and pa.at > p_now - interval '5 minutes' and pb.at > p_now - interval '5 minutes'
  loop
    select * into v_state from public.proximity_pairs where a = v_pair.a_id and b = v_pair.b_id;
    if v_pair.d < v_dist then
      if v_state.a is null or not v_state.alerted
         or (v_repeat > 0 and v_state.last_alert_at <= p_now - make_interval(mins => v_repeat)) then
        insert into public.proximity_pairs (game_id, a, b, alerted, last_alert_at) values (p_game.id, v_pair.a_id, v_pair.b_id, true, p_now)
        on conflict (a, b) do update set alerted = true, last_alert_at = p_now;
        -- Regenerations-Joker unterdrückt nur die eigene Position (7.14).
        if not public.has_effect(v_pair.a_id, 'regeneration', p_now) then
          perform public.create_ping(p_game, v_pair.a_id, 'proximity', v_pair.alat, v_pair.alng, v_pair.aacc, null, null, null, null, 0, p_now);
        end if;
        if not public.has_effect(v_pair.b_id, 'regeneration', p_now) then
          perform public.create_ping(p_game, v_pair.b_id, 'proximity', v_pair.blat, v_pair.blng, v_pair.bacc, null, null, null, null, 0, p_now);
        end if;
        perform public.notify(p_game.id, 'taskforce', null, 'proximity', 'Teambildungs-Alarm',
          public.pname(v_pair.a_id) || ' und ' || public.pname(v_pair.b_id) || ' sind unter ' || v_dist || ' m.', '{}', 'hoch');
        perform public.notify(p_game.id, null, v_pair.a_id, 'proximity_self', 'Teambildung: ' || public.pname(v_pair.b_id) || ' ist in der Nähe',
          'Die Taskforce wurde alarmiert.', jsonb_build_object('lat', v_pair.blat, 'lng', v_pair.blng, 'name', public.pname(v_pair.b_id)), 'hoch');
        perform public.notify(p_game.id, null, v_pair.b_id, 'proximity_self', 'Teambildung: ' || public.pname(v_pair.a_id) || ' ist in der Nähe',
          'Die Taskforce wurde alarmiert.', jsonb_build_object('lat', v_pair.alat, 'lng', v_pair.alng, 'name', public.pname(v_pair.a_id)), 'hoch');
      end if;
    elsif v_pair.d > v_dist + v_hyst and v_state.alerted then
      update public.proximity_pairs set alerted = false where a = v_pair.a_id and b = v_pair.b_id;
    end if;
  end loop;
end; $$;

create or replace function public.process_location(p_game public.games, p_p public.participants, p_point extensions.geometry, p_speed real, p_now timestamptz)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cfg jsonb := p_game.config_json;
  v_hq public.zones;
  v_exit public.zones;
begin
  if p_game.status = 'vorsprung' and p_p.role in ('hunter', 'zentrale') and public.cfg_bool(v_cfg, 'start', 'hunters_must_stay_in_hq', true) then
    select * into v_hq from public.zones where game_id = p_game.id and kind = 'hq' limit 1;
    if v_hq.id is not null and public.dist_m(v_hq.geom, p_point) > coalesce(v_hq.radius_m, public.cfg_int(v_cfg, 'start', 'hq_radius_m', 100)) + public.cfg_int(v_cfg, 'zone', 'edge_tolerance_m', 25)
       and not exists (select 1 from public.violations where participant_id = p_p.id and type = 'hunter_hq') then
      perform public.create_violation(p_game, p_p.id, 'hunter_hq', jsonb_build_object('lat', ST_Y(p_point), 'lng', ST_X(p_point)), p_now);
    end if;
    return;
  end if;

  if p_p.role <> 'spieler' or p_game.status not in ('laeuft', 'finale') then return; end if;
  if p_p.state not in ('aktiv', 'ausserhalb') then return; end if;

  perform public.check_player_zone(p_game, p_p, p_point, p_now);
  select * into p_p from public.participants where id = p_p.id;
  perform public.check_transport(p_game, p_p, p_point, p_speed, p_now);
  select * into p_p from public.participants where id = p_p.id;
  perform public.check_hideout(p_game, p_p, p_point, p_now);

  -- Exitpoint (7.19)
  if p_game.exit_revealed and p_game.exit_zone_id is not null and public.cfg_text(v_cfg, 'exit', 'confirm', 'geofence') = 'geofence'
     and p_now <= p_game.deadline_at then
    select * into v_exit from public.zones where id = p_game.exit_zone_id;
    if public.dist_m(v_exit.geom, p_point) <= coalesce(v_exit.radius_m, public.cfg_int(v_cfg, 'exit', 'radius_m', 30)) then
      perform public.reach_exit(p_game, p_p.id, p_now);
    end if;
  end if;
end; $$;

create or replace function public.reach_exit(p_game public.games, p_participant uuid, p_now timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare v_sh public.speedhunts;
begin
  update public.participants set state = 'im_ziel', finished_at = p_now, next_ping_at = null where id = p_participant and state in ('aktiv', 'ausserhalb');
  if not found then return; end if;
  for v_sh in select * from public.speedhunts where target_id = p_participant and status = 'laeuft' loop
    perform public.end_speedhunt(p_game, v_sh, 'im_ziel', p_now);
  end loop;
  update public.live_windows set ends_at = p_now where participant_id = p_participant and (ends_at is null or ends_at > p_now);
  perform public.notify(p_game.id, null, p_participant, 'exit_reached', 'Geschafft!', 'Du bist am Exitpoint und in Sicherheit.', '{}', 'hoch');
  perform public.notify(p_game.id, 'alle', null, 'exit_reached', public.pname(p_participant) || ' hat den Exitpoint erreicht', '', '{}', 'normal');
  if public.free_players(p_game.id) = 0 then
    select * into p_game from public.games where id = p_game.id;
    perform public.finish_game(p_game, p_now, 'alle_im_ziel_oder_gefangen');
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- Tick: alle Timer eines Spiels (14.1). Reihenfolge nach 14.3, Regel 9.
-- ---------------------------------------------------------------------------

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

  -- Ankündigung der Spielfeldänderung
  v_announce := public.cfg_int(v_cfg, 'zone', 'shrink_announce_minutes', 180);
  if g.next_day_at is not null and g.next_day_at - make_interval(mins => v_announce) <= v_now
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

create or replace function public.recheck_exit(p_game public.games, p_now timestamptz)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_exit public.zones;
  v_p record;
begin
  if public.cfg_text(p_game.config_json, 'exit', 'confirm', 'geofence') <> 'geofence' then return; end if;
  select * into v_exit from public.zones where id = p_game.exit_zone_id;
  for v_p in select p.id from public.participants p join public.positions pos on pos.participant_id = p.id
             where p.game_id = p_game.id and p.role = 'spieler' and p.state in ('aktiv', 'ausserhalb')
               and public.dist_m(v_exit.geom, pos.geom) <= coalesce(v_exit.radius_m, 30) loop
    perform public.reach_exit(p_game, v_p.id, p_now);
  end loop;
end; $$;

create or replace function public.engine_tick_all()
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  for v_id in select id from public.games where status in ('vorsprung', 'laeuft', 'finale') and paused_at is null loop
    begin
      perform public.tick_game(v_id);
    exception when others then
      perform public.log_game_event(v_id, 'tick_error', jsonb_build_object('error', sqlerrm));
    end;
  end loop;
end; $$;

-- Interne Funktionen nicht über die API aufrufbar machen.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in (
      'pt', 'dist_m', 'spielfeld_day', 'allowed_area', 'zone_kind_at', 'ping_interval_at', 'next_ping_time', 'day_start',
      'speedhunt_quota', 'in_quiet_hours', 'best_position', 'create_ping', 'schedule_next_ping', 'running_speedhunt_on', 'process_ping_due',
      'default_penalty', 'create_violation', 'start_speedhunt_internal', 'end_speedhunt', 'speedhunt_query_internal',
      'free_players', 'finish_game', 'apply_catch', 'auto_catch', 'disqualify', 'apply_penalty', 'grant_jokers',
      'schedule_random_speedhunts', 'recheck_zones', 'day_reset', 'hunt_begin', 'check_player_zone', 'check_transport',
      'check_hideout', 'check_proximity', 'process_location', 'reach_exit', 'tick_game', 'recheck_exit', 'engine_tick_all',
      'bump', 'notify', 'open_live_window', 'close_live_windows', 'has_effect', 'has_live_window', 'cfg_int', 'cfg_bool', 'cfg_text'
    )
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;
