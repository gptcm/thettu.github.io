-- Run once in Supabase SQL Editor. Each signed-in user can manage only their own FCM tokens.
create table if not exists public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  fcm_token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.device_tokens enable row level security;

drop policy if exists "Users can view their own device tokens" on public.device_tokens;
create policy "Users can view their own device tokens"
  on public.device_tokens for select to authenticated using (auth.uid() = user_id);

drop policy if exists "Users can add their own device tokens" on public.device_tokens;
create policy "Users can add their own device tokens"
  on public.device_tokens for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "Users can update their own device tokens" on public.device_tokens;
create policy "Users can update their own device tokens"
  on public.device_tokens for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Users can remove their own device tokens" on public.device_tokens;
create policy "Users can remove their own device tokens"
  on public.device_tokens for delete to authenticated using (auth.uid() = user_id);

create index if not exists device_tokens_user_id_idx on public.device_tokens(user_id);
