-- ============================================================================
-- When each account last opened the app or the website, and last signed in (the owner,
-- 2026-10-11: "add an option in report builder for community and customers to show the last
-- time they logged on/opened the website" + "an option to sort them with it").
--
-- A rider stays signed in for months, so a sign-in alone says little; nothing recorded an
-- opening. Now:
--  1. customer_seen: one row per account, seen_at = the last opening (booking app or website),
--     via = 'app' or 'web'. Its own table, not a customers column: a customers write would run
--     the activity trigger, the delta-sync stamp and every customers trigger on each opening.
--     RLS on with no policy: only the functions below touch it.
--  2. customer_seen(p_id, p_token, p_via): the rider's own stamp, token-checked, written at most
--     every 5 minutes per account. Volatile (PostgREST runs a stable function read-only).
--     The booking app calls it once per boot, the website when an account page is drawn.
--  3. staff_last_seen(): staff only, every account with either date: seen_at, via, and
--     signin_at = its last sign-in in customer_activity (logged since 2026-10-04 15:22 UTC;
--     app and website, password, Google and Apple alike).
--  4. Backfill: seen_at = the account's last line in customer_activity (anything it did since
--     2026-10-04), so the column is not empty on day one.
--
-- Rollback:
--   drop function if exists public.staff_last_seen();
--   drop function if exists public.customer_seen(text, text, text);
--   drop table if exists public.customer_seen;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create table if not exists public.customer_seen (
  customer_id text primary key references public.customers(id) on delete cascade,
  seen_at     timestamptz not null default now(),
  via         text not null default 'app' check (via in ('app', 'web'))
);
alter table public.customer_seen enable row level security;
revoke all on table public.customer_seen from public, anon, authenticated;

create or replace function public.customer_seen(p_id text, p_token text, p_via text default 'app')
 returns void
 language plpgsql
 volatile
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not _cust_token_ok(p_id, p_token) then return; end if;
  insert into customer_seen as s (customer_id, seen_at, via)
  values (p_id, now(), case when p_via = 'web' then 'web' else 'app' end)
  on conflict (customer_id) do update set seen_at = excluded.seen_at, via = excluded.via
   where s.seen_at < now() - interval '5 minutes';
end $function$;
revoke execute on function public.customer_seen(text, text, text) from public;
grant  execute on function public.customer_seen(text, text, text) to anon, authenticated;

create or replace function public.staff_last_seen()
 returns table(id text, seen_at timestamptz, via text, signin_at timestamptz)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return query
    with si as (
      select a.customer_id, max(a.at) as at
        from customer_activity a
       where a.action = 'signin' and a.customer_id is not null
       group by a.customer_id
    )
    select coalesce(s.customer_id, si.customer_id), s.seen_at, s.via, si.at
      from customer_seen s full join si on si.customer_id = s.customer_id;
end $function$;
revoke execute on function public.staff_last_seen() from public, anon;
grant  execute on function public.staff_last_seen() to authenticated;

insert into public.customer_seen (customer_id, seen_at, via)
select a.customer_id, max(a.at), 'app'
  from public.customer_activity a
  join public.customers c on c.id = a.customer_id
 group by a.customer_id
on conflict (customer_id) do nothing;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261011130000', 'customer_last_seen')
on conflict (version) do nothing;

commit;
