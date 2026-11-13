-- ConnectChat: friend search, friend requests and private one-to-one messages.
-- Run this ONCE in Supabase Dashboard -> SQL Editor -> New query.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique check (username ~ '^[a-zA-Z0-9_]{3,24}$'),
  display_name text not null default 'ConnectChat user' check (char_length(display_name) between 1 and 40),
  avatar_url text,
  created_at timestamptz not null default now()
);

-- Profile pictures: public bucket for image delivery; each user may manage only their own folder.
alter table public.profiles add column if not exists avatar_url text;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-avatars', 'profile-avatars', true, 5242880, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public = true, file_size_limit = 5242880, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Anyone can view profile pictures" on storage.objects;
create policy "Anyone can view profile pictures" on storage.objects
for select to public using (bucket_id = 'profile-avatars');
drop policy if exists "Users can upload their own profile picture" on storage.objects;
create policy "Users can upload their own profile picture" on storage.objects
for insert to authenticated with check (bucket_id = 'profile-avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Users can update their own profile picture" on storage.objects;
create policy "Users can update their own profile picture" on storage.objects
for update to authenticated using (bucket_id = 'profile-avatars' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'profile-avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "Users can delete their own profile picture" on storage.objects;
create policy "Users can delete their own profile picture" on storage.objects
for delete to authenticated using (bucket_id = 'profile-avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','rejected')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint friend_request_not_self check (sender_id <> receiver_id),
  constraint friend_request_unique_pair unique(sender_id, receiver_id)
);

create table if not exists public.direct_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references auth.users(id) on delete cascade,
  receiver_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  constraint direct_message_not_self check (sender_id <> receiver_id)
);
create index if not exists direct_messages_pair_created_idx on public.direct_messages(sender_id, receiver_id, created_at);

create or replace function public.create_connectchat_profile()
returns trigger language plpgsql security definer set search_path = public
as $$
declare base_name text;
begin
  base_name := lower(regexp_replace(split_part(coalesce(new.email, 'friend'), '@', 1), '[^a-zA-Z0-9_]', '', 'g'));
  if char_length(base_name) < 3 then base_name := 'user'; end if;
  insert into public.profiles(id, username, display_name)
  values(new.id, left(base_name, 14) || '_' || left(replace(new.id::text, '-', ''), 8), left(coalesce(nullif(split_part(coalesce(new.email,''), '@', 1),''), 'ConnectChat user'), 40))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_connectchat_profile on auth.users;
create trigger on_auth_user_created_connectchat_profile
after insert on auth.users for each row execute procedure public.create_connectchat_profile();

-- Backfill profiles for accounts that already existed before this feature was installed.
insert into public.profiles(id, username, display_name)
select u.id,
       left(coalesce(nullif(regexp_replace(split_part(coalesce(u.email,'friend'), '@', 1), '[^a-zA-Z0-9_]', '', 'g'), ''), 'friend'), 14)
         || '_' || left(replace(u.id::text, '-', ''), 8),
       left(coalesce(nullif(split_part(coalesce(u.email,''), '@', 1),''), 'ConnectChat user'), 40)
from auth.users u
on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.friend_requests enable row level security;
alter table public.direct_messages enable row level security;

drop policy if exists "Authenticated users can search profiles" on public.profiles;
create policy "Authenticated users can search profiles" on public.profiles
for select to authenticated using (true);
drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile" on public.profiles
for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "Users can read their friend requests" on public.friend_requests;
create policy "Users can read their friend requests" on public.friend_requests
for select to authenticated using (sender_id = auth.uid() or receiver_id = auth.uid());

drop policy if exists "Friends can read private messages" on public.direct_messages;
create policy "Friends can read private messages" on public.direct_messages
for select to authenticated using (
  (sender_id = auth.uid() or receiver_id = auth.uid()) and exists (
    select 1 from public.friend_requests fr
    where fr.status = 'accepted'
      and ((fr.sender_id = direct_messages.sender_id and fr.receiver_id = direct_messages.receiver_id)
        or (fr.sender_id = direct_messages.receiver_id and fr.receiver_id = direct_messages.sender_id))
  )
);
drop policy if exists "Friends can send private messages" on public.direct_messages;
create policy "Friends can send private messages" on public.direct_messages
for insert to authenticated with check (
  sender_id = auth.uid() and exists (
    select 1 from public.friend_requests fr
    where fr.status = 'accepted'
      and ((fr.sender_id = direct_messages.sender_id and fr.receiver_id = direct_messages.receiver_id)
        or (fr.sender_id = direct_messages.receiver_id and fr.receiver_id = direct_messages.sender_id))
  )
);

create or replace function public.send_friend_request(p_username text)
returns uuid language plpgsql security definer set search_path = public
as $$
declare target_id uuid; request_id uuid;
begin
  if auth.uid() is null then raise exception 'You must be logged in'; end if;
  select id into target_id from public.profiles where lower(username) = lower(trim(p_username));
  if target_id is null then raise exception 'No user found with that username'; end if;
  if target_id = auth.uid() then raise exception 'You cannot add yourself'; end if;
  if exists (select 1 from public.friend_requests where status='accepted'
    and ((sender_id=auth.uid() and receiver_id=target_id) or (sender_id=target_id and receiver_id=auth.uid()))) then
    raise exception 'You are already friends';
  end if;
  select id into request_id from public.friend_requests
    where sender_id=auth.uid() and receiver_id=target_id and status='pending';
  if request_id is not null then return request_id; end if;
  if exists (select 1 from public.friend_requests where sender_id=target_id and receiver_id=auth.uid() and status='pending') then
    raise exception 'This person has already sent you a request. Accept it in Friend requests';
  end if;
  insert into public.friend_requests(sender_id, receiver_id) values(auth.uid(), target_id)
  on conflict(sender_id, receiver_id) do update set status='pending', created_at=now(), responded_at=null
  returning id into request_id;
  return request_id;
end;
$$;

create or replace function public.respond_friend_request(p_request_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'You must be logged in'; end if;
  update public.friend_requests
  set status = case when p_accept then 'accepted' else 'rejected' end, responded_at = now()
  where id = p_request_id and receiver_id = auth.uid() and status = 'pending';
  if not found then raise exception 'Friend request not found or already handled'; end if;
end;
$$;

grant select on public.profiles, public.friend_requests, public.direct_messages to authenticated;
grant update(username, display_name, avatar_url) on public.profiles to authenticated;
grant insert on public.direct_messages to authenticated;
grant execute on function public.send_friend_request(text) to authenticated;
grant execute on function public.respond_friend_request(uuid, boolean) to authenticated;

-- Realtime for private messages; client filters events to the active friend.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'direct_messages'
  ) then
    execute 'alter publication supabase_realtime add table public.direct_messages';
  end if;
end $$;
