-- Schritt 3: Tabellen der Spiel-Engine (Kapitel 13).
-- Gelesen wird fast alles über game_state() (0006), damit die Sichtbarkeit
-- (Kapitel 5.2) an einer Stelle serverseitig entschieden wird.

-- ---------------------------------------------------------------------------
-- Spiel- und Teilnehmerzustand
-- ---------------------------------------------------------------------------

alter table public.games
  add column hunt_start_at timestamptz,
  add column deadline_at timestamptz,
  add column next_day_at timestamptz,
  add column paused_at timestamptz,
  add column pause_reason text,
  add column clock_offset interval not null default interval '0',
  add column is_test boolean not null default false,
  add column exit_zone_id uuid references public.zones (id) on delete set null,
  add column exit_reveal_at timestamptz,
  add column exit_revealed boolean not null default false,
  add column last_tick_at timestamptz,
  add column speedhunts_left int not null default 0,
  add column last_speedhunt_target uuid,
  add column state_json jsonb not null default '{}'::jsonb,
  add column result_json jsonb,
  add column ended_at timestamptz,
  add column map_version int not null default 1;

alter table public.participants
  add column catch_secret text not null default encode(gen_random_bytes(12), 'hex'),
  add column next_ping_at timestamptz,
  add column ping_pending_until timestamptz,
  add column location_request_at timestamptz,
  add column last_silent_ping_at timestamptz,
  add column out_pending_since timestamptz,
  add column out_accum_s int not null default 0,
  add column grace_until timestamptz,
  add column restricted_zone_id uuid,
  add column restricted_since timestamptz,
  add column restricted_violated boolean not null default false,
  add column speeding_since timestamptz,
  add column transport_prompted_at timestamptz,
  add column forbidden_since timestamptz,
  add column forbidden_last_violation_at timestamptz,
  add column stationary_center extensions.geometry(Point, 4326),
  add column stationary_since timestamptz,
  add column hideout_prompted_at timestamptz,
  add column rides_today int not null default 0,
  add column ferry_stops_today int not null default 0,
  add column budget_balance numeric(10, 2) not null default 0,
  add column bounty int not null default 0,
  add column state_before text,
  add column caught_at timestamptz,
  add column finished_at timestamptz,
  add column last_seen_at timestamptz,
  add column battery int,
  add column signal_warned_at timestamptz,
  add column battery_warned int,
  add column device_check jsonb not null default '{}'::jsonb,
  add column in_hq boolean not null default false,
  add column on_break boolean not null default false,
  add column briefing_done_day int;

-- Aktuelle Position je Teilnehmer (letzter gültiger Punkt).
create table public.positions (
  participant_id uuid primary key references public.participants (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  geom extensions.geometry(Point, 4326) not null,
  lat double precision not null,
  lng double precision not null,
  accuracy_m real,
  speed_mps real,
  heading real,
  at timestamptz not null,
  received_at timestamptz not null default now()
);

create table public.location_samples (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  at timestamptz not null,
  geom extensions.geometry(Point, 4326) not null,
  accuracy_m real,
  speed_mps real,
  heading real,
  battery int,
  is_mock boolean not null default false,
  received_at timestamptz not null default now()
);
create index location_samples_p_idx on public.location_samples (participant_id, at desc);
create index location_samples_g_idx on public.location_samples (game_id, at);

create table public.pings (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  at timestamptz not null,
  visible_at timestamptz not null,
  lat double precision,
  lng double precision,
  accuracy_m real,
  source text not null check (source in (
    'silent', 'speedhunt', 'purchase', 'transit', 'proximity', 'fake', 'hotel_end', 'out_of_bounds',
    'penalty', 'gm', 'kein_signal', 'challenge', 'device_switch'
  )),
  n int,
  speedhunt_id uuid,
  zone_kind text,
  label text,
  stale_seconds int,
  is_fake boolean not null default false
);
create index pings_game_idx on public.pings (game_id, at);

-- Echte Position gefälschter Pings: nur Spielleitung (Kapitel 16).
create table public.ping_truth (
  ping_id uuid primary key references public.pings (id) on delete cascade,
  lat double precision not null,
  lng double precision not null
);

create table public.live_windows (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  reason text not null,
  starts_at timestamptz not null,
  ends_at timestamptz
);
create index live_windows_p_idx on public.live_windows (participant_id);

create table public.active_effects (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  type text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  source_item_id uuid
);
create index active_effects_p_idx on public.active_effects (participant_id);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  kind text not null check (kind in ('joker', 'bonus')),
  type text not null,
  minutes int,
  granted_day int,
  granted_at timestamptz not null,
  expires_at timestamptz,
  used_at timestamptz,
  expired boolean not null default false,
  source text
);

create table public.speedhunts (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  target_id uuid not null references public.participants (id) on delete cascade,
  day_index int not null,
  triggered_by uuid references public.participants (id),
  is_penalty boolean not null default false,
  status text not null default 'laeuft' check (status in ('wartet_auf_freigabe', 'aufgeschoben', 'laeuft', 'beendet')),
  queries_total int not null,
  queries_used int not null default 0,
  created_at timestamptz not null,
  started_at timestamptz,
  deadline_at timestamptz,
  last_query_at timestamptz,
  ended_at timestamptz,
  end_reason text
);
create index speedhunts_game_idx on public.speedhunts (game_id, status);

create table public.catches (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  runner_id uuid not null references public.participants (id) on delete cascade,
  hunter_id uuid references public.participants (id),
  at timestamptz not null,
  lat double precision,
  lng double precision,
  method text not null,
  distance_m real,
  media_path text,
  status text not null default 'gueltig' check (status in ('wartet_auf_bestaetigung', 'wartet_auf_beweis', 'gueltig', 'abgelehnt', 'annulliert')),
  expires_at timestamptz,
  reason text
);

create table public.violations (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  type text not null,
  detected_by text not null default 'auto' check (detected_by in ('auto', 'gm', 'meldung')),
  at timestamptz not null,
  evidence jsonb not null default '{}'::jsonb,
  proposed_penalty text not null,
  decided_penalty text,
  status text not null default 'offen' check (status in ('offen', 'verhaengt', 'verworfen')),
  auto_apply_at timestamptz,
  explanation text,
  decided_at timestamptz
);

create table public.hideouts (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  center extensions.geometry(Point, 4326) not null,
  first_entered_at timestamptz not null,
  entered_at timestamptz not null,
  accum_s int not null default 0,
  inside boolean not null default true,
  status text not null default 'aktiv' check (status in ('aktiv', 'verlassen', 'abgelaufen')),
  detection text not null,
  warned int not null default 0,
  left_at timestamptz
);

create table public.transit_sessions (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  mode text not null,
  line text,
  from_station text,
  to_station text,
  stops int,
  started_at timestamptz not null,
  ended_at timestamptz,
  live_after_minutes int
);

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  amount numeric(10, 2) not null check (amount > 0),
  category text not null,
  note text,
  at timestamptz not null,
  lat double precision,
  lng double precision,
  receipt_path text
);

create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  template text not null default 'eigene',
  title text not null,
  description text not null default '',
  lat double precision,
  lng double precision,
  radius_m int,
  announce_at timestamptz,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  proof_type text not null default 'geofence' check (proof_type in ('geofence', 'code', 'foto', 'spielleitung')),
  secret_code text,
  reward_type text not null default 'bonus_fake_ping',
  reward_value int,
  reveal_location_to_taskforce boolean not null default true,
  max_participants int,
  status text not null default 'geplant' check (status in ('geplant', 'angekuendigt', 'laeuft', 'beendet', 'abgesagt')),
  created_at timestamptz not null default now()
);

create table public.challenge_entries (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  joined_at timestamptz not null,
  proof_path text,
  proof_text text,
  result text not null default 'offen' check (result in ('offen', 'eingereicht', 'erfolgreich', 'gescheitert')),
  decided_at timestamptz,
  unique (challenge_id, participant_id)
);

create table public.emergencies (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  participant_id uuid not null references public.participants (id) on delete cascade,
  at timestamptz not null,
  lat double precision,
  lng double precision,
  status text not null default 'offen' check (status in ('offen', 'erledigt')),
  resolved_by uuid,
  resolved_at timestamptz
);

create table public.proximity_pairs (
  game_id uuid not null references public.games (id) on delete cascade,
  a uuid not null references public.participants (id) on delete cascade,
  b uuid not null references public.participants (id) on delete cascade,
  alerted boolean not null default false,
  last_alert_at timestamptz,
  primary key (a, b)
);

-- Mitteilungen (Kapitel 11). audience: alle, spieler, taskforce, gm; oder recipient = eine Person.
create table public.notifications (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  audience text check (audience in ('alle', 'spieler', 'taskforce', 'gm')),
  recipient_id uuid references public.participants (id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  payload jsonb not null default '{}'::jsonb,
  priority text not null default 'normal' check (priority in ('normal', 'hoch', 'kritisch')),
  at timestamptz not null,
  created_at timestamptz not null default now()
);
create index notifications_game_idx on public.notifications (game_id, id);

-- Chat (Kapitel 7.20). channel: ankuendigung, taskforce, spieler, gm:<participant_id>, gruppe
create table public.messages (
  id bigint generated always as identity primary key,
  game_id uuid references public.games (id) on delete cascade,
  group_id uuid references public.groups (id) on delete cascade,
  channel text not null,
  sender_id uuid references auth.users (id) on delete set null,
  sender_name text,
  body text not null check (char_length(body) between 1 and 2000),
  at timestamptz not null default now(),
  check (game_id is not null or group_id is not null)
);
create index messages_game_idx on public.messages (game_id, channel, id);
create index messages_group_idx on public.messages (group_id, id);

-- Änderungszähler pro Spiel: Clients abonnieren ihn und laden dann game_state() neu.
create table public.game_ticks (
  game_id uuid primary key references public.games (id) on delete cascade,
  version bigint not null default 0,
  map_version int not null default 1,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Hilfsfunktionen
-- ---------------------------------------------------------------------------

-- Spielzeit: echte Zeit plus Vorlauf im Probelauf (22.6).
create or replace function public.engine_now(p_game_id uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select now() + coalesce((select clock_offset from public.games where id = p_game_id), interval '0');
$$;

create or replace function public.cfg_int(p_cfg jsonb, p_section text, p_key text, p_default int)
returns int language sql immutable as $$
  select coalesce((p_cfg -> p_section ->> p_key)::int, p_default);
$$;

create or replace function public.cfg_bool(p_cfg jsonb, p_section text, p_key text, p_default boolean)
returns boolean language sql immutable as $$
  select coalesce((p_cfg -> p_section ->> p_key)::boolean, p_default);
$$;

create or replace function public.cfg_text(p_cfg jsonb, p_section text, p_key text, p_default text)
returns text language sql immutable as $$
  select coalesce(p_cfg -> p_section ->> p_key, p_default);
$$;

create or replace function public.bump(p_game_id uuid)
returns void language sql security definer set search_path = public as $$
  insert into public.game_ticks (game_id, version) values (p_game_id, 1)
  on conflict (game_id) do update set version = game_ticks.version + 1, updated_at = now();
$$;

create or replace function public.notify(
  p_game_id uuid, p_audience text, p_recipient uuid, p_kind text, p_title text,
  p_body text default '', p_payload jsonb default '{}'::jsonb, p_priority text default 'normal'
) returns void language sql security definer set search_path = public as $$
  insert into public.notifications (game_id, audience, recipient_id, kind, title, body, payload, priority, at)
  values (p_game_id, p_audience, p_recipient, p_kind, p_title, coalesce(p_body, ''), coalesce(p_payload, '{}'::jsonb),
          p_priority, public.engine_now(p_game_id));
$$;

create or replace function public.pname(p_participant_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select pr.display_name from public.participants p join public.profiles pr on pr.user_id = p.user_id
  where p.id = p_participant_id;
$$;

create or replace function public.my_participant(p_game_id uuid)
returns public.participants language sql stable security definer set search_path = public as $$
  select * from public.participants where game_id = p_game_id and user_id = auth.uid();
$$;

create or replace function public.has_effect(p_participant_id uuid, p_type text, p_now timestamptz)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.active_effects
    where participant_id = p_participant_id and type = p_type and starts_at <= p_now
      and (ends_at is null or ends_at > p_now)
  );
$$;

create or replace function public.has_live_window(p_participant_id uuid, p_now timestamptz)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.live_windows
    where participant_id = p_participant_id and starts_at <= p_now and (ends_at is null or ends_at > p_now)
  );
$$;

create or replace function public.open_live_window(p_game_id uuid, p_participant_id uuid, p_reason text, p_starts timestamptz, p_ends timestamptz)
returns void language sql security definer set search_path = public as $$
  insert into public.live_windows (game_id, participant_id, reason, starts_at, ends_at)
  values (p_game_id, p_participant_id, p_reason, p_starts, p_ends);
$$;

create or replace function public.close_live_windows(p_participant_id uuid, p_reason text, p_at timestamptz)
returns void language sql security definer set search_path = public as $$
  update public.live_windows set ends_at = p_at
  where participant_id = p_participant_id and reason = p_reason and (ends_at is null or ends_at > p_at);
$$;

-- RLS: Direkte Tabellenzugriffe sind gesperrt, ausser Mitteilungen, Chat und Änderungszähler
-- (für Realtime). Alles andere liest game_state().
alter table public.positions enable row level security;
alter table public.location_samples enable row level security;
alter table public.pings enable row level security;
alter table public.ping_truth enable row level security;
alter table public.live_windows enable row level security;
alter table public.active_effects enable row level security;
alter table public.inventory_items enable row level security;
alter table public.speedhunts enable row level security;
alter table public.catches enable row level security;
alter table public.violations enable row level security;
alter table public.hideouts enable row level security;
alter table public.transit_sessions enable row level security;
alter table public.purchases enable row level security;
alter table public.challenges enable row level security;
alter table public.challenge_entries enable row level security;
alter table public.emergencies enable row level security;
alter table public.proximity_pairs enable row level security;
alter table public.notifications enable row level security;
alter table public.messages enable row level security;
alter table public.game_ticks enable row level security;

create or replace function public.can_see_notification(n public.notifications)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_p public.participants := public.my_participant(n.game_id);
begin
  if v_p.id is null then return false; end if;
  if n.recipient_id is not null then return n.recipient_id = v_p.id; end if;
  return case n.audience
    when 'alle' then true
    when 'spieler' then v_p.role in ('spieler', 'zuschauer', 'gm')
    when 'taskforce' then v_p.role in ('hunter', 'zentrale', 'gm')
    when 'gm' then v_p.role = 'gm'
    else false
  end;
end; $$;

create or replace function public.can_see_message(m public.messages)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_p public.participants;
begin
  if m.group_id is not null then return public.is_group_member(m.group_id); end if;
  v_p := public.my_participant(m.game_id);
  if v_p.id is null then return false; end if;
  if v_p.role = 'gm' then return true; end if;
  if m.channel = 'ankuendigung' then return true; end if;
  if m.channel = 'taskforce' then return v_p.role in ('hunter', 'zentrale'); end if;
  if m.channel = 'spieler' then return v_p.role = 'spieler'; end if;
  if m.channel = 'gm:' || v_p.id::text then return true; end if;
  return false;
end; $$;

create policy "Mitteilungen: Empfänger" on public.notifications for select to authenticated using (public.can_see_notification(notifications));
create policy "Chat: Kanal-Mitglieder" on public.messages for select to authenticated using (public.can_see_message(messages));
create policy "Ticks: Teilnehmende" on public.game_ticks for select to authenticated using (public.is_game_member(game_id));
grant select on public.notifications, public.messages, public.game_ticks to authenticated;

alter publication supabase_realtime add table public.notifications;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.game_ticks;

-- Speicher für Beweisfotos (Fang, Beleg, Challenge).
insert into storage.buckets (id, name, public) values ('beweise', 'beweise', false) on conflict (id) do nothing;

create policy "Beweise: eigene hochladen" on storage.objects for insert to authenticated
  with check (bucket_id = 'beweise' and (storage.foldername(name))[2] = auth.uid()::text);
create policy "Beweise: Teilnehmende lesen" on storage.objects for select to authenticated
  using (bucket_id = 'beweise' and public.is_game_member(((storage.foldername(name))[1])::uuid));
