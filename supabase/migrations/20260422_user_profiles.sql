-- user_profiles: canonical per-device profile storage so the app survives
-- localStorage wipes (browser cache clear, app reinstall). The current
-- Supabase project uses the same `device_id`-as-secret model as
-- `squad_members`, so we match that: no real auth, the device_id itself
-- is the access token. True cross-device sync needs email/OTP auth and
-- is a follow-up.
--
-- Run this in the Supabase dashboard's SQL editor:
--   Project → SQL Editor → New query → paste → Run.

create table if not exists public.user_profiles (
  device_id text primary key,
  profile jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

-- Permissive RLS to match squad_members' existing model: the anon key
-- can read/write any row. Security relies on device_id being hard to
-- guess (UUIDv4 via crypto.randomUUID() from main.jsx). Tighten this
-- when email/OTP auth lands — keyed by auth.uid() then.
drop policy if exists "Anyone can select user_profiles" on public.user_profiles;
create policy "Anyone can select user_profiles"
  on public.user_profiles for select
  using (true);

drop policy if exists "Anyone can insert user_profiles" on public.user_profiles;
create policy "Anyone can insert user_profiles"
  on public.user_profiles for insert
  with check (true);

drop policy if exists "Anyone can update user_profiles" on public.user_profiles;
create policy "Anyone can update user_profiles"
  on public.user_profiles for update
  using (true);
