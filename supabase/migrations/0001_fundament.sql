-- Schritt 1: Fundament
-- Konten/Profile (Kapitel 20), Spiele, Teilnehmende und Lobby (Kapitel 6, 13, 21.5).
-- Im Supabase-Dashboard unter "SQL Editor" komplett einfügen und ausführen.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Profile
-- ---------------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique check (username ~ '^[a-z0-9_.]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  age_confirmed boolean not null default false,
  is_adult boolean not null default false,
  locale text not null default 'de',
  username_changed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Notfallkontakt getrennt, damit ihn niemand ausser der Person selbst liest.
-- (Spielleitung im Notfall: ab Schritt 3 über eine eigene Funktion.)
create table public.profile_private (
  user_id uuid primary key references auth.users (id) on delete cascade,
  emergency_contact_name text not null check (char_length(emergency_contact_name) between 1 and 80),
  emergency_contact_phone text not null check (char_length(emergency_contact_phone) between 5 and 30),
  updated_at timestamptz not null default now()
);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('agb', 'datenschutz', 'standort')),
  version text not null,
  accepted_at timestamptz not null default now(),
  unique (user_id, kind, version)
);

-- ---------------------------------------------------------------------------
-- Spiele und Teilnehmende
-- ---------------------------------------------------------------------------

create table public.games (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[0-9]{6}$'),
  host_id uuid not null references auth.users (id),
  name text not null check (char_length(name) between 1 and 60),
  preset_id text,
  status text not null default 'lobby' check (
    status in ('entwurf', 'geplant', 'lobby', 'vorsprung', 'laeuft', 'pausiert', 'finale', 'beendet', 'archiviert')
  ),
  config_json jsonb not null default '{}'::jsonb,
  config_version int not null default 1,
  start_at timestamptz,
  ends_at timestamptz,
  current_day int not null default 0,
  timezone text not null default 'Europe/Zurich',
  meeting_point text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'offen' check (role in ('offen', 'spieler', 'hunter', 'zentrale', 'gm', 'zuschauer')),
  wished_role text check (wished_role in ('spieler', 'hunter', 'zentrale', 'zuschauer')),
  state text not null default 'aktiv',
  effects_json jsonb not null default '[]'::jsonb,
  color text,
  ready boolean not null default false,
  rules_accepted_at timestamptz,
  joined_at timestamptz not null default now(),
  unique (game_id, user_id)
);

create index participants_user_idx on public.participants (user_id);

-- Jede Regeländerung wird protokolliert (Kapitel 8).
create table public.game_config_changes (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  changed_by uuid references auth.users (id),
  path text not null,
  old_value jsonb,
  new_value jsonb,
  at timestamptz not null default now()
);

-- Unveränderliches Ereignisprotokoll (Kapitel 12, Event Sourcing light).
create table public.game_events (
  id bigint generated always as identity primary key,
  game_id uuid not null references public.games (id) on delete cascade,
  at timestamptz not null default now(),
  type text not null,
  actor_id uuid references auth.users (id),
  payload_json jsonb not null default '{}'::jsonb
);

create index game_events_game_idx on public.game_events (game_id, at);

-- ---------------------------------------------------------------------------
-- Hilfsfunktionen
-- ---------------------------------------------------------------------------

create or replace function public.is_game_member(p_game_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.participants where game_id = p_game_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_game_host(p_game_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.games where id = p_game_id and host_id = auth.uid());
$$;

create or replace function public.log_game_event(p_game_id uuid, p_type text, p_payload jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.game_events (game_id, type, actor_id, payload_json)
  values (p_game_id, p_type, auth.uid(), coalesce(p_payload, '{}'::jsonb));
$$;

revoke execute on function public.log_game_event(uuid, text, jsonb) from public, anon, authenticated;

-- Prüft die Voraussetzungen aus Kapitel 20, bevor jemand einem Spiel beitritt.
create or replace function public.assert_can_play()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet.' using errcode = '28000';
  end if;
  if not exists (select 1 from auth.users where id = auth.uid() and email_confirmed_at is not null) then
    raise exception 'Bitte bestätige zuerst deine E-Mail-Adresse.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profiles where user_id = auth.uid() and age_confirmed) then
    raise exception 'Bitte vervollständige zuerst dein Profil.' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.profile_private where user_id = auth.uid()) then
    raise exception 'Bitte erfasse zuerst einen Notfallkontakt.' using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Aktionen (RPC)
-- ---------------------------------------------------------------------------

create or replace function public.create_game(p_name text, p_preset_id text, p_config jsonb, p_start_at timestamptz default null)
returns public.games
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_game public.games;
begin
  perform public.assert_can_play();

  loop
    v_code := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from public.games where code = v_code);
  end loop;

  insert into public.games (code, host_id, name, preset_id, config_json, start_at, timezone)
  values (
    v_code,
    auth.uid(),
    p_name,
    p_preset_id,
    coalesce(p_config, '{}'::jsonb),
    p_start_at,
    coalesce(p_config #>> '{game,timezone}', 'Europe/Zurich')
  )
  returning * into v_game;

  -- Der Host ist automatisch Spielleitung (Kapitel 5.1).
  insert into public.participants (game_id, user_id, role, ready)
  values (v_game.id, auth.uid(), 'gm', true);

  perform public.log_game_event(v_game.id, 'game_created', jsonb_build_object('preset', p_preset_id));
  return v_game;
end;
$$;

create or replace function public.join_game(p_code text)
returns public.games
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game public.games;
begin
  perform public.assert_can_play();

  select * into v_game from public.games
  where code = trim(p_code) and status not in ('beendet', 'archiviert')
  order by created_at desc
  limit 1;

  if v_game.id is null then
    raise exception 'Kein offenes Spiel mit diesem Code gefunden.' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.participants where game_id = v_game.id and user_id = auth.uid()) then
    return v_game;
  end if;

  if v_game.status not in ('entwurf', 'geplant', 'lobby') then
    raise exception 'Dieses Spiel läuft bereits. Beitreten ist nur in der Lobby möglich.' using errcode = 'P0001';
  end if;

  insert into public.participants (game_id, user_id) values (v_game.id, auth.uid());
  perform public.log_game_event(v_game.id, 'participant_joined');
  return v_game;
end;
$$;

-- Host vergibt Rollen (Kapitel 21.5, Schritt 5).
create or replace function public.set_participant_role(p_participant_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_id uuid;
begin
  select game_id into v_game_id from public.participants where id = p_participant_id;
  if v_game_id is null or not public.is_game_host(v_game_id) then
    raise exception 'Nur der Host kann Rollen vergeben.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.games where id = v_game_id and status in ('entwurf', 'geplant', 'lobby')) then
    raise exception 'Rollen können nur vor dem Start geändert werden.' using errcode = 'P0001';
  end if;
  if p_role not in ('offen', 'spieler', 'hunter', 'zentrale', 'gm', 'zuschauer') then
    raise exception 'Unbekannte Rolle.' using errcode = '22023';
  end if;

  update public.participants set role = p_role, ready = false where id = p_participant_id;
  perform public.log_game_event(v_game_id, 'role_assigned', jsonb_build_object('participant_id', p_participant_id, 'role', p_role));
end;
$$;

-- Host entfernt eine Person aus der Lobby oder eine Person verlässt das Spiel.
create or replace function public.remove_participant(p_participant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_p public.participants;
  v_game public.games;
begin
  select * into v_p from public.participants where id = p_participant_id;
  if v_p.id is null then
    return;
  end if;
  select * into v_game from public.games where id = v_p.game_id;
  if v_p.user_id <> auth.uid() and v_game.host_id <> auth.uid() then
    raise exception 'Keine Berechtigung.' using errcode = '42501';
  end if;
  if v_p.user_id = v_game.host_id then
    raise exception 'Der Host kann das Spiel nicht verlassen.' using errcode = 'P0001';
  end if;
  if v_game.status not in ('entwurf', 'geplant', 'lobby') then
    raise exception 'Während des Spiels: bitte "Aufgeben" verwenden (kommt in Schritt 3).' using errcode = 'P0001';
  end if;

  delete from public.participants where id = p_participant_id;
  perform public.log_game_event(v_p.game_id, 'participant_left', jsonb_build_object('user_id', v_p.user_id));
end;
$$;

-- Teilnehmende melden sich bereit: Wunschrolle und Regeln akzeptiert.
create or replace function public.set_ready(p_game_id uuid, p_ready boolean, p_wished_role text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_wished_role is not null and p_wished_role not in ('spieler', 'hunter', 'zentrale', 'zuschauer') then
    raise exception 'Unbekannte Rolle.' using errcode = '22023';
  end if;
  update public.participants
  set ready = p_ready,
      wished_role = coalesce(p_wished_role, wished_role),
      rules_accepted_at = case when p_ready then coalesce(rules_accepted_at, now()) else rules_accepted_at end
  where game_id = p_game_id and user_id = auth.uid();
end;
$$;

-- Regeländerung durch den Host, jede geänderte Einstellung wird protokolliert.
create or replace function public.update_game_config(p_game_id uuid, p_config jsonb, p_changes jsonb default '[]'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_change jsonb;
begin
  if not public.is_game_host(p_game_id) then
    raise exception 'Nur der Host kann die Regeln ändern.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.games where id = p_game_id and status in ('entwurf', 'geplant', 'lobby')) then
    raise exception 'Live-Änderungen während des Spiels kommen in Schritt 7.' using errcode = 'P0001';
  end if;

  update public.games
  set config_json = p_config,
      timezone = coalesce(p_config #>> '{game,timezone}', timezone),
      updated_at = now()
  where id = p_game_id;

  for v_change in select * from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) loop
    insert into public.game_config_changes (game_id, changed_by, path, old_value, new_value)
    values (p_game_id, auth.uid(), v_change ->> 'path', v_change -> 'old', v_change -> 'new');
  end loop;

  perform public.log_game_event(p_game_id, 'config_changed', jsonb_build_object('changes', jsonb_array_length(coalesce(p_changes, '[]'::jsonb))));
end;
$$;

create or replace function public.update_game_details(p_game_id uuid, p_name text, p_start_at timestamptz, p_meeting_point text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_game_host(p_game_id) then
    raise exception 'Nur der Host kann das Spiel bearbeiten.' using errcode = '42501';
  end if;
  update public.games
  set name = p_name, start_at = p_start_at, meeting_point = p_meeting_point, updated_at = now()
  where id = p_game_id;
end;
$$;

-- Profil-Namen der Mitspielenden (nur Anzeigename und Benutzername).
create or replace function public.game_roster(p_game_id uuid)
returns table (
  participant_id uuid,
  user_id uuid,
  username text,
  display_name text,
  role text,
  wished_role text,
  ready boolean,
  is_adult boolean,
  joined_at timestamptz
)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, p.user_id, pr.username, pr.display_name, p.role, p.wished_role, p.ready, pr.is_adult, p.joined_at
  from public.participants p
  join public.profiles pr on pr.user_id = p.user_id
  where p.game_id = p_game_id and public.is_game_member(p_game_id)
  order by p.joined_at;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security: Lesen über Policies, Schreiben nur über die Funktionen oben
-- (ausser dem eigenen Profil).
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.profile_private enable row level security;
alter table public.consents enable row level security;
alter table public.games enable row level security;
alter table public.participants enable row level security;
alter table public.game_config_changes enable row level security;
alter table public.game_events enable row level security;

create policy "Profil: eigenes lesen" on public.profiles
  for select to authenticated using (user_id = auth.uid());
create policy "Profil: eigenes anlegen" on public.profiles
  for insert to authenticated with check (user_id = auth.uid());
create policy "Profil: eigenes ändern" on public.profiles
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "Notfallkontakt: nur selbst" on public.profile_private
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "Einwilligungen: eigene lesen" on public.consents
  for select to authenticated using (user_id = auth.uid());
create policy "Einwilligungen: eigene anlegen" on public.consents
  for insert to authenticated with check (user_id = auth.uid());

create policy "Spiele: Teilnehmende lesen" on public.games
  for select to authenticated using (public.is_game_member(id));

create policy "Teilnehmende: Mitspielende lesen" on public.participants
  for select to authenticated using (public.is_game_member(game_id));

create policy "Regeländerungen: Teilnehmende lesen" on public.game_config_changes
  for select to authenticated using (public.is_game_member(game_id));

create policy "Ereignisse: Host liest" on public.game_events
  for select to authenticated using (public.is_game_host(game_id));

-- Nur angemeldete Personen dürfen die Funktionen aufrufen.
revoke execute on function public.create_game(text, text, jsonb, timestamptz) from public, anon;
revoke execute on function public.join_game(text) from public, anon;
revoke execute on function public.set_participant_role(uuid, text) from public, anon;
revoke execute on function public.remove_participant(uuid) from public, anon;
revoke execute on function public.set_ready(uuid, boolean, text) from public, anon;
revoke execute on function public.update_game_config(uuid, jsonb, jsonb) from public, anon;
revoke execute on function public.update_game_details(uuid, text, timestamptz, text) from public, anon;
revoke execute on function public.game_roster(uuid) from public, anon;
revoke execute on function public.assert_can_play() from public, anon;
grant execute on function public.create_game(text, text, jsonb, timestamptz) to authenticated;
grant execute on function public.join_game(text) to authenticated;
grant execute on function public.set_participant_role(uuid, text) to authenticated;
grant execute on function public.remove_participant(uuid) to authenticated;
grant execute on function public.set_ready(uuid, boolean, text) to authenticated;
grant execute on function public.update_game_config(uuid, jsonb, jsonb) to authenticated;
grant execute on function public.update_game_details(uuid, text, timestamptz, text) to authenticated;
grant execute on function public.game_roster(uuid) to authenticated;
grant execute on function public.assert_can_play() to authenticated;

-- Live-Updates für die Lobby (Realtime beachtet RLS).
alter publication supabase_realtime add table public.participants;
alter publication supabase_realtime add table public.games;

-- Tabellenrechte ausdrücklich setzen (neuere Supabase-Projekte geben neue
-- Tabellen nicht mehr automatisch für die Data API frei). RLS gilt zusätzlich.
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.profile_private to authenticated;
grant select, insert on public.consents to authenticated;
grant select on public.games, public.participants, public.game_config_changes, public.game_events to authenticated;
