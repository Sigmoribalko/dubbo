-- DubParty: player profiles and a dub counter for future plan limits.
-- Run once in Supabase → SQL Editor → New query → paste → Run.

-- One row per account, created automatically on sign-up.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  name        text,
  email       text,
  plan        text not null default 'free',
  dubs_used   integer not null default 0,
  dubs_limit  integer,                      -- null = unlimited
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Every recorded line a player sends, for history and stats.
create table if not exists public.dubs (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  scene       text,
  created_at  timestamptz not null default now()
);
create index if not exists dubs_user_id_idx on public.dubs (user_id, created_at desc);

-- Players can read their own rows only; all changes go through the functions below.
alter table public.profiles enable row level security;
alter table public.dubs enable row level security;

drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles for select using (auth.uid() = id);

drop policy if exists "read own dubs" on public.dubs;
create policy "read own dubs" on public.dubs for select using (auth.uid() = user_id);

-- Create the profile when someone signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, new.raw_user_meta_data ->> 'name', new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Accounts created before this script ran.
insert into public.profiles (id, name, email)
select id, raw_user_meta_data ->> 'name', email from auth.users
on conflict (id) do nothing;

-- Count one dub, unless the player's limit is reached. Called by the site when a take is sent.
create or replace function public.use_dub(scene_title text default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid() for update;
  if p.id is null then
    raise exception 'not signed in';
  end if;
  if p.dubs_limit is not null and p.dubs_used >= p.dubs_limit then
    return json_build_object('allowed', false, 'used', p.dubs_used, 'limit', p.dubs_limit);
  end if;
  update public.profiles set dubs_used = dubs_used + 1, updated_at = now() where id = p.id;
  insert into public.dubs (user_id, scene) values (p.id, left(scene_title, 200));
  return json_build_object('allowed', true, 'used', p.dubs_used + 1, 'limit', p.dubs_limit);
end;
$$;

revoke all on function public.use_dub(text) from public, anon;
grant execute on function public.use_dub(text) to authenticated;

-- To limit everyone on the free plan later, for example to 20 dubs:
--   update public.profiles set dubs_limit = 20 where plan = 'free';
