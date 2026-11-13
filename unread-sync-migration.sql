-- Cross-device unread/read synchronization for ConnectChat.
-- Run once in Supabase Dashboard -> SQL Editor AFTER schema.sql and friends.sql.

create table if not exists public.conversation_reads (
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_type text not null check (conversation_type in ('dm', 'room')),
  conversation_id uuid not null,
  last_read_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, conversation_type, conversation_id)
);

create index if not exists conversation_reads_user_idx
  on public.conversation_reads(user_id);

alter table public.conversation_reads enable row level security;

drop policy if exists "Users can read their own conversation read states" on public.conversation_reads;
create policy "Users can read their own conversation read states"
  on public.conversation_reads for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Users can insert their own conversation read states" on public.conversation_reads;
create policy "Users can insert their own conversation read states"
  on public.conversation_reads for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists "Users can update their own conversation read states" on public.conversation_reads;
create policy "Users can update their own conversation read states"
  on public.conversation_reads for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update on public.conversation_reads to authenticated;

-- Add to Supabase Realtime only if it is not already present.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'conversation_reads'
  ) then
    alter publication supabase_realtime add table public.conversation_reads;
  end if;
end $$;

-- Prevent an older device timestamp from moving a read position backwards.
create or replace function public.keep_conversation_read_monotonic()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.last_read_at < old.last_read_at then
    new.last_read_at := old.last_read_at;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists conversation_reads_monotonic on public.conversation_reads;
create trigger conversation_reads_monotonic
before update on public.conversation_reads
for each row execute function public.keep_conversation_read_monotonic();
