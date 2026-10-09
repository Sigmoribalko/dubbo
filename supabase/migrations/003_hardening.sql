-- DubParty: security hardening.
-- Run once in Supabase → SQL Editor → New query → paste → Run.

-- 1. Wins are reported by the winner's own browser, so a player could call record_win in a loop
--    with made-up round keys. Real rounds take minutes: allow one win per 2 minutes and 30 per day.
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
  if round_key is null or length(round_key) = 0 or length(round_key) > 100 then
    raise exception 'bad round';
  end if;
  -- Serialise calls per player so the limits below can't be raced.
  perform 1 from public.profiles where id = auth.uid() for update;
  if not exists (select 1 from public.wins w
                 where w.user_id = auth.uid() and w.created_at > now() - interval '2 minutes')
     and (select count(*) from public.wins w
          where w.user_id = auth.uid() and w.created_at > now() - interval '1 day') < 30 then
    insert into public.wins (user_id, round_key) values (auth.uid(), round_key)
    on conflict do nothing;
    if found then
      update public.profiles set wins = wins + 1, updated_at = now() where id = auth.uid();
    end if;
  end if;
  select wins into total from public.profiles where id = auth.uid();
  return total;
end;
$$;

revoke all on function public.record_win(text) from public, anon;
grant execute on function public.record_win(text) to authenticated;

-- 2. Display names come from sign-up metadata the client controls: cap their length.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, left(new.raw_user_meta_data ->> 'name', 40), new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 3. Tables are read-only from the site; every change goes through the functions above.
--    RLS already blocks writes; drop the grants too so a future policy slip can't open them.
revoke insert, update, delete, truncate on public.profiles, public.dubs, public.wins from anon, authenticated;
revoke all on public.profiles, public.dubs, public.wins from anon;

-- 4. Trigger helper is not meant to be called directly.
revoke all on function public.handle_new_user() from public, anon, authenticated;
