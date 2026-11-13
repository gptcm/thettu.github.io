-- ConnectChat voice messages migration
-- Run once in Supabase Dashboard -> SQL Editor after schema.sql and friends.sql.

alter table public.messages
  add column if not exists message_type text not null default 'text',
  add column if not exists media_url text;

alter table public.direct_messages
  add column if not exists message_type text not null default 'text',
  add column if not exists media_url text;

alter table public.messages drop constraint if exists messages_message_type_check;
alter table public.messages add constraint messages_message_type_check
  check (message_type in ('text','voice'));

alter table public.direct_messages drop constraint if exists direct_messages_message_type_check;
alter table public.direct_messages add constraint direct_messages_message_type_check
  check (message_type in ('text','voice'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-voice', 'chat-voice', true, 15728640,
        array['audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav'])
on conflict (id) do update set public = true, file_size_limit = 15728640,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users upload their own chat voice messages" on storage.objects;
create policy "Users upload their own chat voice messages" on storage.objects
for insert to authenticated
with check (bucket_id = 'chat-voice' and (storage.foldername(name))[1] = auth.uid()::text);

-- Public bucket URLs are used for playback. Only authenticated users can upload,
-- and each uploader is restricted to their own user-id folder.
