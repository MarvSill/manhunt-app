-- Schritt 2: Karte und Zonen (Kapitel 7.2, 22), Gruppen und Einladungen (Kapitel 21)

create extension if not exists postgis with schema extensions;

-- ---------------------------------------------------------------------------
-- Gruppen (Crews)
-- ---------------------------------------------------------------------------

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 3 and 40),
  description text,
  invite_code text not null unique default lpad((floor(random() * 100000000))::int::text, 8, '0'),
  owner_id uuid not null references auth.users (id),
  members_can_create_games boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'mitglied' check (role in ('besitzer', 'admin', 'mitglied')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

alter table public.games add column group_id uuid references public.groups (id) on delete set null;

create or replace function public.is_group_member(p_group_id uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.group_members where group_id = p_group_id and user_id = auth.uid());
$$;

create or replace function public.create_group(p_name text, p_description text default null)
returns public.groups language plpgsql security definer set search_path = public as $$
declare v public.groups;
begin
  perform public.assert_can_play();
  insert into public.groups (name, description, owner_id) values (trim(p_name), p_description, auth.uid()) returning * into v;
  insert into public.group_members (group_id, user_id, role) values (v.id, auth.uid(), 'besitzer');
  return v;
end; $$;

create or replace function public.join_group(p_code text)
returns public.groups language plpgsql security definer set search_path = public as $$
declare v public.groups;
begin
  perform public.assert_can_play();
  select * into v from public.groups where invite_code = trim(p_code);
  if v.id is null then raise exception 'Keine Gruppe mit diesem Code gefunden.' using errcode = 'P0002'; end if;
  insert into public.group_members (group_id, user_id) values (v.id, auth.uid()) on conflict do nothing;
  return v;
end; $$;

create or replace function public.leave_group(p_group_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.groups where id = p_group_id and owner_id = auth.uid()) then
    raise exception 'Als Besitzer kannst du die Gruppe nicht verlassen. Übertrage zuerst den Besitz oder lösche die Gruppe.' using errcode = 'P0001';
  end if;
  delete from public.group_members where group_id = p_group_id and user_id = auth.uid();
end; $$;

create or replace function public.set_group_member_role(p_group_id uuid, p_user_id uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.groups where id = p_group_id and owner_id = auth.uid()) then
    raise exception 'Nur der Besitzer kann Rollen ändern.' using errcode = '42501';
  end if;
  if p_role = 'besitzer' then
    update public.group_members set role = 'admin' where group_id = p_group_id and user_id = auth.uid();
    update public.groups set owner_id = p_user_id where id = p_group_id;
  end if;
  update public.group_members set role = p_role where group_id = p_group_id and user_id = p_user_id;
end; $$;

create or replace function public.remove_group_member(p_group_id uuid, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.group_members where group_id = p_group_id and user_id = auth.uid() and role in ('besitzer', 'admin')) then
    raise exception 'Nur Admins können Mitglieder entfernen.' using errcode = '42501';
  end if;
  if exists (select 1 from public.groups where id = p_group_id and owner_id = p_user_id) then
    raise exception 'Der Besitzer kann nicht entfernt werden.' using errcode = 'P0001';
  end if;
  delete from public.group_members where group_id = p_group_id and user_id = p_user_id;
end; $$;

create or replace function public.delete_group(p_group_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.groups where id = p_group_id and owner_id = auth.uid()) then
    raise exception 'Nur der Besitzer kann die Gruppe löschen.' using errcode = '42501';
  end if;
  delete from public.groups where id = p_group_id;
end; $$;

create or replace function public.group_roster(p_group_id uuid)
returns table (user_id uuid, username text, display_name text, role text, joined_at timestamptz)
language sql security definer set search_path = public stable as $$
  select m.user_id, p.username, p.display_name, m.role, m.joined_at
  from public.group_members m join public.profiles p on p.user_id = m.user_id
  where m.group_id = p_group_id and public.is_group_member(p_group_id)
  order by m.joined_at;
$$;

-- Spiel einer Gruppe zuordnen (Admins, oder Mitglieder falls erlaubt).
create or replace function public.set_game_group(p_game_id uuid, p_group_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_game_host(p_game_id) then raise exception 'Nur der Host.' using errcode = '42501'; end if;
  if p_group_id is not null and not exists (
    select 1 from public.group_members m join public.groups g on g.id = m.group_id
    where m.group_id = p_group_id and m.user_id = auth.uid() and (m.role in ('besitzer', 'admin') or g.members_can_create_games)
  ) then
    raise exception 'In dieser Gruppe darfst du keine Spiele erstellen.' using errcode = '42501';
  end if;
  update public.games set group_id = p_group_id where id = p_game_id;
end; $$;

-- Gruppen-Admins/Mitglieder sehen die Spiele ihrer Gruppe (Name, Status, Code), um beizutreten.
create or replace function public.group_games(p_group_id uuid)
returns table (id uuid, name text, code text, status text, start_at timestamptz, created_at timestamptz)
language sql security definer set search_path = public stable as $$
  select g.id, g.name, g.code, g.status, g.start_at, g.created_at from public.games g
  where g.group_id = p_group_id and public.is_group_member(p_group_id)
  order by g.created_at desc;
$$;

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
create policy "Gruppen: Mitglieder lesen" on public.groups for select to authenticated using (public.is_group_member(id));
create policy "Gruppen: Besitzer ändert" on public.groups for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "Mitglieder: Gruppe liest" on public.group_members for select to authenticated using (public.is_group_member(group_id));
grant select, update on public.groups to authenticated;
grant select on public.group_members to authenticated;

-- ---------------------------------------------------------------------------
-- Zonen
-- ---------------------------------------------------------------------------

create table public.zones (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  kind text not null check (kind in (
    'spielfeld', 'sektion', 'startzone', 'center', 'kern', 'aussen', 'sperrzone', 'sicher',
    'exit', 'hq', 'treffpunkt'
  )),
  name text not null default '',
  color text,
  geom extensions.geometry(Geometry, 4326) not null,
  -- Punkt-Zonen (HQ, Exit, Treffpunkt): Radius in Metern.
  radius_m int,
  -- Spielfeld pro Spieltag (null = alle Tage).
  day_index int,
  -- Spielfeld-Tag vergrössert sich bewusst (22.2).
  grows boolean not null default false,
  ping_interval_override int,
  -- Sperrzone: Überqueren erlaubt, Aufenthalt nicht.
  crossing_allowed boolean not null default false,
  restricted_type text,
  owner_participant_id uuid references public.participants (id) on delete set null,
  released boolean not null default false,
  -- Sichtbarkeit im Spiel (22.7): ab wann und für wen.
  visible_from timestamptz,
  visible_to text not null default 'alle' check (visible_to in ('alle', 'spieler', 'gm')),
  version int not null default 1,
  created_at timestamptz not null default now()
);

create index zones_game_idx on public.zones (game_id);
create index zones_geom_idx on public.zones using gist (geom);

-- Rolle der aktuellen Person in einem Spiel.
create or replace function public.my_role(p_game_id uuid)
returns text language sql security definer set search_path = public stable as $$
  select role from public.participants where game_id = p_game_id and user_id = auth.uid();
$$;

create or replace function public.is_game_gm(p_game_id uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select coalesce(public.my_role(p_game_id) = 'gm', false);
$$;

-- Wer darf eine Zone sehen? Vor dem Start: alle Teilnehmenden ausser Exit-Kandidaten
-- (die sieht nur die Spielleitung). Im Spiel gilt visible_from/visible_to.
create or replace function public.can_see_zone(z public.zones)
returns boolean language plpgsql security definer set search_path = public stable as $$
declare
  v_role text := public.my_role(z.game_id);
  v_status text;
  v_now timestamptz;
begin
  if v_role is null then return false; end if;
  if v_role = 'gm' then return true; end if;
  select status into v_status from public.games where id = z.game_id;
  if v_status in ('beendet', 'archiviert') then return true; end if;
  if z.visible_to = 'gm' then return false; end if;
  if z.visible_to = 'spieler' and v_role not in ('spieler', 'zuschauer') then return false; end if;
  if z.kind = 'exit' and z.visible_from is null then return false; end if;
  v_now := public.engine_now(z.game_id);
  return z.visible_from is null or z.visible_from <= v_now;
end; $$;

alter table public.zones enable row level security;
create policy "Zonen: nach Sichtbarkeit" on public.zones for select to authenticated using (public.can_see_zone(zones));
grant select on public.zones to authenticated;

-- Karte speichern: ersetzt alle Zonen eines Spiels (nur vor dem Start).
-- p_features: GeoJSON-FeatureCollection.features; properties: kind, name, color, radius_m,
-- day_index, grows, ping_interval_override, crossing_allowed, restricted_type, owner_participant_id.
create or replace function public.save_map(p_game_id uuid, p_features jsonb)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare
  f jsonb;
  n int := 0;
begin
  if not public.is_game_host(p_game_id) then
    raise exception 'Nur der Host kann die Karte bearbeiten.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.games where id = p_game_id and status in ('entwurf', 'geplant', 'lobby')) then
    raise exception 'Die Karte ist ab Spielstart gesperrt (nur die Spielleitung kann Sperrzonen ergänzen).' using errcode = 'P0001';
  end if;
  delete from public.zones where game_id = p_game_id;
  for f in select * from jsonb_array_elements(coalesce(p_features, '[]'::jsonb)) loop
    insert into public.zones (
      game_id, kind, name, color, geom, radius_m, day_index, grows, ping_interval_override,
      crossing_allowed, restricted_type, owner_participant_id
    ) values (
      p_game_id,
      f #>> '{properties,kind}',
      coalesce(f #>> '{properties,name}', ''),
      f #>> '{properties,color}',
      ST_SetSRID(ST_GeomFromGeoJSON((f -> 'geometry')::text), 4326),
      nullif(f #>> '{properties,radius_m}', '')::int,
      nullif(f #>> '{properties,day_index}', '')::int,
      coalesce((f #>> '{properties,grows}')::boolean, false),
      nullif(f #>> '{properties,ping_interval_override}', '')::int,
      coalesce((f #>> '{properties,crossing_allowed}')::boolean, false),
      f #>> '{properties,restricted_type}',
      nullif(f #>> '{properties,owner_participant_id}', '')::uuid
    );
    n := n + 1;
  end loop;
  perform public.log_game_event(p_game_id, 'map_saved', jsonb_build_object('zones', n));
  return n;
end; $$;

-- Karte als GeoJSON lesen (nur sichtbare Zonen).
create or replace function public.game_map(p_game_id uuid)
returns jsonb language sql security definer set search_path = public, extensions stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'type', 'Feature',
    'id', z.id,
    'geometry', ST_AsGeoJSON(z.geom)::jsonb,
    'properties', jsonb_build_object(
      'id', z.id, 'kind', z.kind, 'name', z.name, 'color', z.color, 'radius_m', z.radius_m,
      'day_index', z.day_index, 'grows', z.grows, 'ping_interval_override', z.ping_interval_override,
      'crossing_allowed', z.crossing_allowed, 'restricted_type', z.restricted_type,
      'owner_participant_id', z.owner_participant_id, 'released', z.released,
      'visible_from', z.visible_from
    )
  ) order by z.created_at), '[]'::jsonb)
  from public.zones z
  where z.game_id = p_game_id and public.can_see_zone(z);
$$;

revoke execute on function public.save_map(uuid, jsonb) from public, anon;
revoke execute on function public.game_map(uuid) from public, anon;
grant execute on function public.save_map(uuid, jsonb), public.game_map(uuid) to authenticated;
grant execute on function public.create_group(text, text), public.join_group(text), public.leave_group(uuid),
  public.set_group_member_role(uuid, uuid, text), public.remove_group_member(uuid, uuid), public.delete_group(uuid),
  public.group_roster(uuid), public.set_game_group(uuid, uuid), public.group_games(uuid) to authenticated;
revoke execute on function public.create_group(text, text), public.join_group(text), public.leave_group(uuid),
  public.set_group_member_role(uuid, uuid, text), public.remove_group_member(uuid, uuid), public.delete_group(uuid),
  public.group_roster(uuid), public.set_game_group(uuid, uuid), public.group_games(uuid) from anon;
