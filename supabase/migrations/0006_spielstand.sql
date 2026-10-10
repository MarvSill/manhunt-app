-- Spielstand für die Oberfläche: eine Abfrage, Sichtbarkeit nach Rolle (Kapitel 5.2, 16).

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
      'next_day_at', g.next_day_at, 'current_day', g.current_day, 'paused', g.paused_at is not null, 'pause_reason', g.pause_reason,
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

-- Wiederholung nach Spielende (12.3): alle Spuren, ausgedünnt auf einen Punkt pro Minute.
create or replace function public.game_replay(p_game_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare g public.games;
begin
  select * into g from public.games where id = p_game_id;
  if not public.is_game_member(p_game_id) then raise exception 'Du bist nicht in diesem Spiel.' using errcode = '42501'; end if;
  if g.status not in ('beendet', 'archiviert') and not public.is_game_gm(p_game_id) then
    raise exception 'Die Wiederholung gibt es erst nach Spielende.' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'start', g.hunt_start_at, 'end', coalesce(g.ended_at, now() + g.clock_offset),
    'tracks', (
      select coalesce(jsonb_object_agg(pid, pts), '{}') from (
        select participant_id pid, jsonb_agg(jsonb_build_array(extract(epoch from m)::bigint, round(lat::numeric, 6), round(lng::numeric, 6)) order by m) pts
        from (
          select distinct on (participant_id, date_trunc('minute', at)) participant_id, date_trunc('minute', at) m, ST_Y(geom) lat, ST_X(geom) lng
          from public.location_samples where game_id = p_game_id
          order by participant_id, date_trunc('minute', at), at desc
        ) s group by participant_id
      ) t
    ),
    'pings', (select coalesce(jsonb_agg(jsonb_build_object('participant_id', participant_id, 'at', at, 'lat', lat, 'lng', lng, 'source', source, 'is_fake', is_fake) order by at), '[]')
              from public.pings where game_id = p_game_id and lat is not null),
    'catches', (select coalesce(jsonb_agg(jsonb_build_object('runner_id', runner_id, 'hunter_id', hunter_id, 'at', at, 'lat', lat, 'lng', lng)), '[]')
                from public.catches where game_id = p_game_id and status = 'gueltig'),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('at', at, 'type', type, 'payload', payload_json) order by at), '[]')
               from public.game_events where game_id = p_game_id)
  );
end; $$;

revoke execute on function public.game_state(uuid), public.game_replay(uuid) from public, anon;
grant execute on function public.game_state(uuid), public.game_replay(uuid) to authenticated;
