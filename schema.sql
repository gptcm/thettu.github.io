-- ConnectChat database setup for Supabase
-- Run the entire file in Supabase Dashboard -> SQL Editor -> New query.

create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null default 'Group' check (char_length(name) between 1 and 40),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists messages_room_created_idx on public.messages(room_id, created_at);

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.messages enable row level security;

create or replace function public.is_room_member(target_room uuid)
returns boolean language sql security definer set search_path = public
as $$
  select exists (
    select 1 from public.room_members
    where room_id = target_room and user_id = auth.uid()
  );
$$;

drop function if exists public.create_room(text);
create or replace function public.create_room(p_code text, p_name text)
returns uuid language plpgsql security definer set search_path = public
as $$
declare new_room uuid;
begin
  if auth.uid() is null then raise exception 'You must be logged in'; end if;
  if p_code !~ '^[A-Z0-9]{6,8}$' then raise exception 'Invalid room code'; end if;
  if p_name is null or char_length(trim(p_name)) not between 1 and 40 then raise exception 'Group name must be 1 to 40 characters'; end if;
  insert into public.rooms(code, name, created_by) values (p_code, trim(p_name), auth.uid()) returning id into new_room;
  insert into public.room_members(room_id, user_id) values (new_room, auth.uid());
  return new_room;
end;
$$;

create or replace function public.join_room(p_code text)
returns json language plpgsql security definer set search_path = public
as $$
declare found_room public.rooms;
begin
  if auth.uid() is null then raise exception 'You must be logged in'; end if;
  select * into found_room from public.rooms where code = upper(p_code);
  if found_room.id is null then raise exception 'Room code not found'; end if;
  insert into public.room_members(room_id, user_id)
  values(found_room.id, auth.uid()) on conflict do nothing;
  return json_build_object('id', found_room.id, 'code', found_room.code);
end;
$$;

drop policy if exists "Members can read their rooms" on public.rooms;
create policy "Members can read their rooms" on public.rooms
for select to authenticated using (public.is_room_member(id));

drop policy if exists "Users can read own room memberships" on public.room_members;
create policy "Users can read own room memberships" on public.room_members
for select to authenticated using (user_id = auth.uid());

drop policy if exists "Members can read room messages" on public.messages;
create policy "Members can read room messages" on public.messages
for select to authenticated using (public.is_room_member(room_id));

drop policy if exists "Members can send messages as themselves" on public.messages;
create policy "Members can send messages as themselves" on public.messages
for insert to authenticated with check (
  sender_id = auth.uid() and public.is_room_member(room_id)
);

grant execute on function public.create_room(text, text) to authenticated;
drop policy if exists "Creators can rename their rooms" on public.rooms;
create policy "Creators can rename their rooms" on public.rooms
for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());

grant update(name) on public.rooms to authenticated;
grant execute on function public.join_room(text) to authenticated;
grant execute on function public.is_room_member(uuid) to authenticated;
grant select on public.rooms, public.room_members, public.messages to authenticated;
grant insert on public.messages to authenticated;

-- Enable Realtime for new message events. If this reports that the table is
-- already in the publication, that is fine.
alter publication supabase_realtime add table public.messages;

-- Optional feature migration: run friends.sql separately to enable username search and private chats.
