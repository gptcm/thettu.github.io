-- ConnectChat message deletion migration
-- Run once in Supabase SQL Editor after schema.sql, friends.sql and voice-messages-migration.sql.
-- "Delete for me" hides a message only for the requesting account.
-- "Delete for everyone" is available only to the original sender.

alter table public.messages add column if not exists deleted_for uuid[] not null default '{}';
alter table public.direct_messages add column if not exists deleted_for uuid[] not null default '{}';

create or replace function public.delete_room_message_for_me(p_message_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  update public.messages m set deleted_for=array_append(m.deleted_for,auth.uid())
  where m.id=p_message_id and public.is_room_member(m.room_id)
    and not (auth.uid()=any(m.deleted_for));
  if not found then raise exception 'Message not found or access denied'; end if;
end; $$;

create or replace function public.delete_room_message_everyone(p_message_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  update public.messages set body='This message was deleted', message_type='text', media_url=null
  where id=p_message_id and sender_id=auth.uid();
  if not found then raise exception 'Only the sender can delete this message for everyone'; end if;
end; $$;

create or replace function public.delete_direct_message_for_me(p_message_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  update public.direct_messages set deleted_for=array_append(deleted_for,auth.uid())
  where id=p_message_id and (sender_id=auth.uid() or receiver_id=auth.uid())
    and not (auth.uid()=any(deleted_for));
  if not found then raise exception 'Message not found or access denied'; end if;
end; $$;

create or replace function public.delete_direct_message_everyone(p_message_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  update public.direct_messages set body='This message was deleted', message_type='text', media_url=null
  where id=p_message_id and sender_id=auth.uid();
  if not found then raise exception 'Only the sender can delete this message for everyone'; end if;
end; $$;

grant execute on function public.delete_room_message_for_me(uuid) to authenticated;
grant execute on function public.delete_room_message_everyone(uuid) to authenticated;
grant execute on function public.delete_direct_message_for_me(uuid) to authenticated;
grant execute on function public.delete_direct_message_everyone(uuid) to authenticated;
