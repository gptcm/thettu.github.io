-- ConnectChat image, video and file attachments
-- Run after schema.sql, friends.sql and voice-messages-migration.sql.

alter table public.messages
  add column if not exists file_name text;
alter table public.direct_messages
  add column if not exists file_name text;

alter table public.messages drop constraint if exists messages_message_type_check;
alter table public.messages add constraint messages_message_type_check
  check (message_type in ('text','voice','image','video','file'));

alter table public.direct_messages drop constraint if exists direct_messages_message_type_check;
alter table public.direct_messages add constraint direct_messages_message_type_check
  check (message_type in ('text','voice','image','video','file'));

insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-media', 'chat-media', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = 52428800;

drop policy if exists "Authenticated users upload chat attachments" on storage.objects;
create policy "Authenticated users upload chat attachments" on storage.objects
for insert to authenticated
with check (bucket_id = 'chat-media' and (storage.foldername(name))[1] = auth.uid()::text);
