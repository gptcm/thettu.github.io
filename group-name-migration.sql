-- ConnectChat group-name migration
-- Run this once in Supabase SQL Editor for an existing installation.
alter table public.rooms add column if not exists name text not null default 'Group';
alter table public.rooms drop constraint if exists rooms_name_length_check;
alter table public.rooms add constraint rooms_name_length_check check (char_length(name) between 1 and 40);

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
grant execute on function public.create_room(text, text) to authenticated;

drop policy if exists "Creators can rename their rooms" on public.rooms;
create policy "Creators can rename their rooms" on public.rooms
for update to authenticated using (created_by = auth.uid()) with check (created_by = auth.uid());
grant update(name) on public.rooms to authenticated;
