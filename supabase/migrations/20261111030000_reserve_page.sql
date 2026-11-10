-- ============================================================================
-- A booking that asked for a place is never turned into a waitlist place without asking (the Reserve research,
-- 2026-11-10, row 13; the user: "implement everything now").
--
-- Two devices can reach Confirm for the same last place. _capacity_guard then turns the slower one's rows from
-- 'waiting' into 'waitlist', and the rider who tapped Confirm for a booking got a waitlist place, or a party was
-- split, some seated and the rest waitlisted, without being asked.
--
--  1. customer_create_booking: an entry may carry "seat_only": true (the booking app sends it when the rider was
--     booking a place, not joining the waitlist). When any of the call's rows landed on the waitlist, the whole call
--     is refused with PLACE_GONE and nothing is kept. The app then asks: Join waitlist, or Choose another ride.
--     An entry without the key (an older page, the offline outbox) books exactly as before, and a page that sends
--     the key to a database without this patch is simply not asked (the key is ignored there), so the app and this
--     patch can go out in either order.
--  2. reserve_funnel: one row per step a booking attempt reached (row 20: list, pick, step2, step3, waiver, confirm,
--     booked, waitlisted, refused, place_gone), from the app ('app') or the website ('site'). No account, no name, no
--     device: a random id per attempt, the event kind and, for a refusal, its code. Each step once per attempt.
--     Written only through reserve_funnel_add (anon and signed-in pages), read only through staff_reserve_funnel
--     (staff, counts per step). Rows older than 180 days are cleared as new ones arrive.
--
-- Rollback: run the patch below backwards (remove the PLACE_GONE block);
--   drop function if exists public.staff_reserve_funnel(integer); drop function if exists public.reserve_funnel_add(text, text, jsonb);
--   drop table if exists public.reserve_funnel;
-- Idempotent. Run supabase/checks/security-attributes.sql after (the patch keeps SECURITY DEFINER and search_path,
-- as pg_get_functiondef returns the whole definition).
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if position(b in def) > 0 then return def; end if;
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

do $do$
declare v text;
begin
  select pg_get_functiondef('public.customer_create_booking'::regproc) into v;
  v := pg_temp._once(v,
    $a$  perform set_config('mm.promo_code', '', true);$a$,
    $b$  -- A rider who asked for a place and would land on the waitlist (another device took the last place) is asked
  -- first: the whole call is refused and nothing is kept (20261111030000).
  if exists (select 1 from jsonb_array_elements(p_entries) x where x->>'seat_only' = 'true')
     and exists (select 1 from queue_entries q where q.id = any(_ids) and q.status = 'waitlist') then
    raise exception 'PLACE_GONE' using errcode = 'P0001';
  end if;
  perform set_config('mm.promo_code', '', true);$b$);
  execute v;
end $do$;

create table if not exists public.reserve_funnel (
  id    bigint generated always as identity primary key,
  at    timestamptz not null default now(),
  src   text not null check (src in ('app', 'site')),
  visit text not null,
  ev    text not null,
  k     text,
  d     text
);
comment on table public.reserve_funnel is
  'The Reserve funnel (20261111030000): one row per step a booking attempt reached; no account, a random id per attempt.';
create index if not exists reserve_funnel_at on public.reserve_funnel (at);
create unique index if not exists reserve_funnel_once on public.reserve_funnel (visit, ev);
alter table public.reserve_funnel enable row level security;
revoke all on public.reserve_funnel from anon, authenticated;

create or replace function public.reserve_funnel_add(p_src text, p_visit text, p_events jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare e jsonb; n int := 0;
begin
  if coalesce(p_src, '') not in ('app', 'site') or coalesce(p_visit, '') !~ '^[A-Za-z0-9_-]{12,32}$'
     or p_events is null or jsonb_typeof(p_events) <> 'array' then
    return;
  end if;
  -- a flood is dropped, not stored: no attempt makes more than ten rows, and an hour holds at most 20,000
  if (select count(*) from reserve_funnel f where f.at > now() - interval '1 hour') >= 20000 then return; end if;
  for e in select * from jsonb_array_elements(p_events) loop
    n := n + 1;
    exit when n > 20;
    if jsonb_typeof(e) <> 'object' or coalesce(e->>'ev', '') not in
       ('list', 'pick', 'step2', 'step3', 'waiver', 'confirm', 'booked', 'waitlisted', 'refused', 'place_gone') then
      continue;
    end if;
    insert into reserve_funnel (src, visit, ev, k, d)
    values (p_src, p_visit, e->>'ev',
            left(nullif(regexp_replace(coalesce(e->>'k', ''), '[^a-z0-9_-]', '', 'g'), ''), 20),
            left(nullif(regexp_replace(coalesce(e->>'d', ''), '[^A-Za-z0-9_ -]', '', 'g'), ''), 40))
    on conflict (visit, ev) do nothing;
  end loop;
  if random() < 0.01 then delete from reserve_funnel where at < now() - interval '180 days'; end if;
end $function$;
revoke all on function public.reserve_funnel_add(text, text, jsonb) from public;
grant execute on function public.reserve_funnel_add(text, text, jsonb) to anon, authenticated;

create or replace function public.staff_reserve_funnel(p_days integer default 30)
 returns table(src text, k text, ev text, visits bigint)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return query
    select f.src, coalesce(f.k, ''), f.ev, count(*)::bigint
      from reserve_funnel f
     where f.at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 180)))
     group by 1, 2, 3;
end $function$;
revoke all on function public.staff_reserve_funnel(integer) from public;
grant execute on function public.staff_reserve_funnel(integer) to authenticated;

do $chk$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'customer_create_booking' and p.prosecdef
                    and position('PLACE_GONE' in pg_get_functiondef(p.oid)) > 0) then
    raise exception 'customer_create_booking lost SECURITY DEFINER or the PLACE_GONE block';
  end if;
  if not has_function_privilege('anon', 'public.reserve_funnel_add(text,text,jsonb)', 'execute') then
    raise exception 'reserve_funnel_add is not callable by a page';
  end if;
  if has_table_privilege('anon', 'public.reserve_funnel', 'select') or has_table_privilege('authenticated', 'public.reserve_funnel', 'select') then
    raise exception 'reserve_funnel is readable by a page';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111030000', 'reserve_page')
on conflict (version) do nothing;

commit;
