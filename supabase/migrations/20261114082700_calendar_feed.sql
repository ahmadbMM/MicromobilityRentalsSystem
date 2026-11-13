-- ============================================================================
-- A calendar address of the rider's own (new features build F27; the owner marked it Build now on 2026-11-13).
-- For PROD and STAGING. The order of this script and the app's deploy does not matter: the Account row "Calendar"
-- shows only once calendar_link answers, so a database without this script never offers it.
--
-- What it is: each rider can have one private address (experiences.micromobility.sa/api/ics?k=<key>) that a phone or
-- a calendar service subscribes to. It lists the bookings the rider still holds on sessions not yet over, as
-- calendar events: the session's name, its start and end, the gathering time and the meeting point where the session
-- has them. No other rider, no price, no name. The rider opens it from Account (Add to my calendar, Copy the address,
-- Replace the address); replacing writes a new key, and the old address answers with an empty calendar from then on.
--
--   calendar_feeds                one row per rider who opened the pop-up: the key (64 hex characters, about 244
--                                 random bits), the language the events are written in, and the address's own meter.
--                                 Nobody reads the table: RLS is on with no policy and every grant is revoked, staff
--                                 included. It goes with the account (on delete cascade).
--   calendar_link(id, token, lang, op)
--                                 the rider's own, token-checked as every rider function. op 'peek' says the feature
--                                 is here and whether an address exists, and writes nothing; 'get' answers the key,
--                                 making one on the first ask; 'new' replaces it.
--   calendar_feed(key)            what functions/api/ics.js (the Pages function behind the address) asks. A key nobody
--                                 holds, or one of the wrong shape, answers exactly as a rider with no bookings does,
--                                 so the answer says nothing about a key. A real key is metered on its own row (60
--                                 reads an hour, then 'busy' until the hour is out); the key is never written to a
--                                 log table. Rows: one per session, bookings in waiting or active, the ones My
--                                 Bookings lists as ahead (a waitlisted, cancelled or done booking is not in it: a
--                                 reservation staff refuse is cancelled by the refusal, so it leaves as its ticket
--                                 does; nothing of an archived account is), from yesterday in Jeddah on; the Pages
--                                 function leaves out what has ended. The breakfast spot's location stays unsaid
--                                 until sessions.reveal_at, as list_sessions keeps it.
--
-- The per-network meter (_ip_gate) is not used here on purpose: the database sees the Pages function's address, not
-- the caller's, so one budget would be shared by every rider. The caller's address is metered in the Pages function.
--
-- Idempotent. Rollback:
--   drop function if exists public.calendar_feed(text);
--   drop function if exists public.calendar_link(text, text, text, text);
--   drop table if exists public.calendar_feeds;
-- ============================================================================

begin;

create table if not exists public.calendar_feeds (
  customer_id text primary key references public.customers(id) on delete cascade,
  feed_key    text not null unique,
  lang        text not null default 'en',
  created_at  timestamptz not null default now(),
  replaced_at timestamptz,
  read_at     timestamptz,
  hits        integer not null default 0,
  hits_from   timestamptz,
  constraint calendar_feeds_key_shape check (feed_key ~ '^[0-9a-f]{64}$')
);
alter table public.calendar_feeds enable row level security;
revoke all on public.calendar_feeds from public, anon, authenticated;
comment on table public.calendar_feeds is 'A rider''s private calendar address (2026-11-13): the key, the events'' language, the address''s own meter. Read and written only by calendar_link and calendar_feed.';

-- ── the rider's own address ───────────────────────────────────────────────────────────────────────────────────
create or replace function public.calendar_link(p_id text, p_token text, p_lang text default null, p_op text default 'get')
 returns jsonb
 language plpgsql
 volatile
 security definer
 set search_path to 'public'
as $function$
declare
  v_key  text;
  v_new  text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_lang text := case when p_lang in ('en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn') then p_lang end;
begin
  if p_id is null or p_token is null or not coalesce(_cust_token_ok(p_id, p_token), false) then
    return jsonb_build_object('ok', false, 'error', 'denied');
  end if;
  select f.feed_key into v_key from calendar_feeds f where f.customer_id = p_id;
  -- Is the feature here, and has this rider an address: nothing is made and no key leaves.
  if p_op = 'peek' then
    return jsonb_build_object('ok', true, 'has', v_key is not null);
  end if;
  if v_key is null then
    -- The first ask makes the address. Two asks at once keep the one that landed first.
    insert into calendar_feeds (customer_id, feed_key, lang)
    values (p_id, v_new, coalesce(v_lang, 'en'))
    on conflict (customer_id) do nothing;
    select f.feed_key into v_key from calendar_feeds f where f.customer_id = p_id;
  elsif p_op = 'new' then
    -- Replaced: the old key is gone from the table, so the old address finds nobody from this moment.
    update calendar_feeds f
       set feed_key = v_new, replaced_at = now(), hits = 0, hits_from = null, lang = coalesce(v_lang, f.lang)
     where f.customer_id = p_id;
    v_key := v_new;
  elsif v_lang is not null then
    update calendar_feeds f set lang = v_lang where f.customer_id = p_id and f.lang is distinct from v_lang;
  end if;
  return jsonb_build_object('ok', true, 'key', v_key);
end $function$;
revoke all on function public.calendar_link(text, text, text, text) from public;
grant execute on function public.calendar_link(text, text, text, text) to anon, authenticated;

-- ── what the address serves ───────────────────────────────────────────────────────────────────────────────────
create or replace function public.calendar_feed(p_key text)
 returns jsonb
 language plpgsql
 volatile
 security definer
 set search_path to 'public'
as $function$
declare
  f      calendar_feeds%rowtype;
  v      jsonb;
  v_from text := to_char((now() at time zone 'Asia/Riyadh')::date - 1, 'YYYY-MM-DD');
begin
  -- A key nobody holds answers exactly as a rider with no bookings does.
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', true, 'items', '[]'::jsonb);
  end if;
  select c.* into f from calendar_feeds c where c.feed_key = p_key;
  if not found then
    return jsonb_build_object('ok', true, 'items', '[]'::jsonb);
  end if;
  -- The address's own meter: 60 reads in an hour, then nothing more until the hour is out. Kept on the row, so the
  -- key is never an identifier in a log or throttle table.
  if f.hits_from is null or f.hits_from < now() - interval '1 hour' then
    update calendar_feeds c set hits = 1, hits_from = now(), read_at = now() where c.customer_id = f.customer_id;
  elsif f.hits >= 60 then
    return jsonb_build_object('ok', false, 'error', 'busy');
  else
    update calendar_feeds c set hits = c.hits + 1, read_at = now() where c.customer_id = f.customer_id;
  end if;
  -- One row per session the rider still holds a place on. to_jsonb reads the columns later migrations added
  -- (title_ar, archived_at), so a database without one of them answers null for it instead of failing.
  select coalesce(jsonb_agg(t.x order by t.x->>'date', t.x->>'time', t.x->>'id'), '[]'::jsonb) into v from (
    select distinct on (s.id) jsonb_build_object(
             'id', q.id,
             'date', s.session_date,
             'time', substring(coalesce(s.bike_slots, '') from '"_time"\s*:\s*"([^"]*)"'),
             'ek', a.sj->>'event_kind',
             'rk', a.sj->>'ride_kind',
             'appr', a.sj->'needs_approval',
             'title', nullif(btrim(a.sj->>'title'), ''),
             'title_ar', nullif(btrim(a.sj->>'title_ar'), ''),
             'meet', nullif(btrim(a.sj->>'meet_url'), ''),
             -- the breakfast spot's location stays unsaid until staff's time; the meeting point shows at once
             'loc', case when b.held then null else nullif(btrim(s.location), '') end,
             'held', b.held) as x
      from queue_entries q
      join sessions s on s.id = q.session_id
      cross join lateral (select to_jsonb(s) as sj) a
      cross join lateral (select (s.reveal_at is not null and s.reveal_at > now()) as held) b
     where q.customer_id = f.customer_id
       and q.status in ('waiting', 'active')
       and s.session_date >= v_from
       and exists (select 1 from customers cu where cu.id = f.customer_id and (to_jsonb(cu)->>'archived_at') is null)
     order by s.id, q.queue_num, q.id
     limit 100
  ) t;
  -- Nothing ahead: the same answer a key nobody holds gets, without the language.
  if v = '[]'::jsonb then return jsonb_build_object('ok', true, 'items', v); end if;
  return jsonb_build_object('ok', true, 'lang', f.lang, 'items', v);
end $function$;
revoke all on function public.calendar_feed(text) from public;
grant execute on function public.calendar_feed(text) to anon, authenticated;

-- checks ------------------------------------------------------------------------------------------------------------------
do $chk$
declare fn regprocedure;
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.calendar_feeds'::regclass) then
    raise exception 'calendar_feeds has no row level security';
  end if;
  if has_table_privilege('anon', 'public.calendar_feeds', 'select') or has_table_privilege('authenticated', 'public.calendar_feeds', 'select') then
    raise exception 'calendar_feeds is readable from outside';
  end if;
  foreach fn in array array['public.calendar_link(text,text,text,text)'::regprocedure, 'public.calendar_feed(text)'::regprocedure] loop
    if not exists (select 1 from pg_proc p where p.oid = fn::oid and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', fn;
    end if;
    if not has_function_privilege('anon', fn::oid, 'execute') then
      raise exception 'the page cannot reach %', fn;
    end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114082700', 'calendar_feed')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): the table is locked, both functions are definer and reachable, and the ledger has the row.
select (select c.relrowsecurity from pg_class c where c.oid = 'public.calendar_feeds'::regclass) as rls_true,
       has_table_privilege('anon', 'public.calendar_feeds', 'select') as anon_reads_false,
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
          and p.proname in ('calendar_link', 'calendar_feed') and p.prosecdef) as definer_2,
       (select count(*) from supabase_migrations.schema_migrations where version = '20261114082700') as ledger_1;
