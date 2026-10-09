-- DubParty: count how many times a player was voted "best voice".
-- Run once in Supabase → SQL Editor → New query → paste → Run.

alter table public.profiles add column if not exists wins integer not null default 0;

-- One row per win, so the same round can't be counted twice.
create table if not exists public.wins (
  user_id     uuid not null references auth.users (id) on delete cascade,
  round_key   text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, round_key)
);
alter table public.wins enable row level security;
drop policy if exists "read own wins" on public.wins;
create policy "read own wins" on public.wins for select using (auth.uid() = user_id);

-- Record a win for the signed-in player (once per room round); returns the new total.
create or replace function public.record_win(round_key text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  total integer;
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  insert into public.wins (user_id, round_key) values (auth.uid(), left(round_key, 100))
  on conflict do nothing;
  if found then
    update public.profiles set wins = wins + 1, updated_at = now() where id = auth.uid();
  end if;
  select wins into total from public.profiles where id = auth.uid();
  return total;
end;
$$;

revoke all on function public.record_win(text) from public, anon;
grant execute on function public.record_win(text) to authenticated;
