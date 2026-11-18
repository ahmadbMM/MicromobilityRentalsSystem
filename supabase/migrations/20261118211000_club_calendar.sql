-- ============================================================================
-- Club calendar (the user, 2026-11-18, picked from the Community features list: "Club calendar: the Calendar row would
-- also offer every upcoming Saturday ride and featured session, not just the rider's own bookings. It uses the existing
-- calendar address.").
--
-- Same address, one subscription: the rider's own /api/ics?k=<key> (20261114082700) also lists the club's sessions once
-- the rider turns on "Club sessions too" in the Calendar pop-up (calendar-feed.js).
--
--  1. calendar_feeds.club boolean (default off): the rider's choice, kept on their address's row. A replaced address
--     keeps it (calendar_link 'new' writes the key only).
--  2. calendar_link(id, token, lang, op): as 20261114082700 (header copied from there: plpgsql, volatile, security
--     definer, search_path public), its 'get' and 'new' answers now also carry 'club' (the switch's state). 'peek' is
--     unchanged and still sends nothing more than whether an address exists.
--  3. calendar_club_set(id, token, on): the switch. Token-checked as every rider function; it changes only the
--     caller's own row and answers {ok, club}; a rider with no address yet gets {ok: false, error: 'none'} (the switch is
--     in the pop-up, which makes the address first). New function: its attributes are calendar_link's.
--  4. calendar_feed(key): as 20261114082700 (same header, same meter, same answers for a key nobody holds and for a
--     rider with nothing ahead), plus, when the rider's row has club on, one row per club session ('club': true):
--       sessions shown to riders (open or full, or closed as Full, no waitlist: bike_slots._fbk, not called off, not a
--       draft, not waiting on its timer) from today to 60 days ahead in Jeddah, that are
--         (a) a Saturday Social Ride (the app's _rideKind 'saturday'), only for an active community member, or
--         (b) featured: a date inside MicroMobility Experiences (_featOk: the Saturday ride, a Petromin night, the pool,
--             the Defe run, yoga, the Farm House night) whose bike_slots._feat is on, or with no _feat a kind featured as
--             made (FEAT_KINDS: yoga, defe5k, farm), as the app's _featured(s) reads it;
--       never a session the rider holds a waiting or active place on (that one is already in the feed as their
--       booking); a men-only or women-only session only to an account of that gender; a members-only community session
--       (open_to_all off) only to an active member; a private event (required_tag_id) only to a holder of its tag, as
--       list_sessions shows it. At most 60.
--     What a club row carries: the session's id, date, times, kind, approval flag, its title (English and Arabic). The
--     breakfast spot never (no breakfast column is read); while sessions.reveal_at is ahead the place AND the meeting
--     point are left out too (the booking rows keep their meeting point, as 20261114082700 decided). No price, no
--     count, nobody's name. functions/api/ics.js writes each as its own event (UID club-<session>@micromobility.sa, so a
--     session the rider then books shows once, as the booking), opening its description with the booking app's link
--     to that session, and with no alarm.
--
-- Safe before or after the app: the pop-up offers the switch only when calendar_link's answer carries 'club'; without
-- this migration the address lists the bookings as before.
--
-- Rollback:
--   re-run the calendar_link and calendar_feed definitions of 20261114082700_calendar_feed.sql;
--   drop function if exists public.calendar_club_set(text, text, boolean);
--   alter table public.calendar_feeds drop column if exists club;   -- loses the riders' choices
-- ============================================================================

begin;
set local lock_timeout = '5s';

alter table public.calendar_feeds add column if not exists club boolean not null default false;

-- ── the rider's own address, with the switch's state ─────────────────────────────────────────────────────────────
create or replace function public.calendar_link(p_id text, p_token text, p_lang text default null, p_op text default 'get')
 returns jsonb
 language plpgsql
 volatile
 security definer
 set search_path to 'public'
as $function$
declare
  v_key  text;
  v_club boolean;
  v_new  text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_lang text := case when p_lang in ('en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn') then p_lang end;
begin
  if p_id is null or p_token is null or not coalesce(_cust_token_ok(p_id, p_token), false) then
    return jsonb_build_object('ok', false, 'error', 'denied');
  end if;
  select f.feed_key, f.club into v_key, v_club from calendar_feeds f where f.customer_id = p_id;
  -- Is the feature here, and has this rider an address: nothing is made and no key leaves.
  if p_op = 'peek' then
    return jsonb_build_object('ok', true, 'has', v_key is not null);
  end if;
  if v_key is null then
    -- The first ask makes the address. Two asks at once keep the one that landed first.
    insert into calendar_feeds (customer_id, feed_key, lang)
    values (p_id, v_new, coalesce(v_lang, 'en'))
    on conflict (customer_id) do nothing;
    select f.feed_key, f.club into v_key, v_club from calendar_feeds f where f.customer_id = p_id;
  elsif p_op = 'new' then
    -- Replaced: the old key is gone from the table, so the old address finds nobody from this moment.
    update calendar_feeds f
       set feed_key = v_new, replaced_at = now(), hits = 0, hits_from = null, lang = coalesce(v_lang, f.lang)
     where f.customer_id = p_id;
    v_key := v_new;
  elsif v_lang is not null then
    update calendar_feeds f set lang = v_lang where f.customer_id = p_id and f.lang is distinct from v_lang;
  end if;
  return jsonb_build_object('ok', true, 'key', v_key, 'club', coalesce(v_club, false));
end $function$;
revoke all on function public.calendar_link(text, text, text, text) from public;
grant execute on function public.calendar_link(text, text, text, text) to anon, authenticated;

-- ── the switch ─────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.calendar_club_set(p_id text, p_token text, p_on boolean)
 returns jsonb
 language plpgsql
 volatile
 security definer
 set search_path to 'public'
as $function$
declare v boolean;
begin
  if p_id is null or p_token is null or not coalesce(_cust_token_ok(p_id, p_token), false) then
    return jsonb_build_object('ok', false, 'error', 'denied');
  end if;
  if p_on is null then
    return jsonb_build_object('ok', false, 'error', 'bad');
  end if;
  update calendar_feeds f set club = p_on where f.customer_id = p_id returning f.club into v;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'none');
  end if;
  return jsonb_build_object('ok', true, 'club', v);
end $function$;
revoke all on function public.calendar_club_set(text, text, boolean) from public;
grant execute on function public.calendar_club_set(text, text, boolean) to anon, authenticated;

-- ── what the address serves ───────────────────────────────────────────────────────────────────────────────────
create or replace function public.calendar_feed(p_key text)
 returns jsonb
 language plpgsql
 volatile
 security definer
 set search_path to 'public'
as $function$
declare
  f       calendar_feeds%rowtype;
  v       jsonb;
  vc      jsonb := '[]'::jsonb;
  v_from  text := to_char((now() at time zone 'Asia/Riyadh')::date - 1, 'YYYY-MM-DD');
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
  v_cid   text;
  v_g     text;
  v_mem   boolean;
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
  -- The club's sessions (20261118211000), only when the rider turned them on: the Saturday rides for a member and the
  -- featured dates, as the app shows them to this rider, less what they hold. No breakfast spot ever; while the spot is
  -- held (reveal_at ahead) no place and no meeting point either.
  if f.club then
    select cu.id, cu.gender, coalesce(_member_active(cu.id), false) into v_cid, v_g, v_mem
      from customers cu where cu.id = f.customer_id and (to_jsonb(cu)->>'archived_at') is null;
    if v_cid is not null then
      select coalesce(jsonb_agg(t.x order by t.x->>'date', t.x->>'time', t.x->>'id'), '[]'::jsonb) into vc from (
        select jsonb_build_object(
                 'id', s.id,
                 'club', true,
                 'date', s.session_date,
                 'time', substring(coalesce(s.bike_slots, '') from '"_time"\s*:\s*"([^"]*)"'),
                 'ek', a.sj->>'event_kind',
                 'rk', a.sj->>'ride_kind',
                 'appr', a.sj->'needs_approval',
                 'title', nullif(btrim(a.sj->>'title'), ''),
                 'title_ar', nullif(btrim(a.sj->>'title_ar'), ''),
                 'meet', case when b.held then null else nullif(btrim(a.sj->>'meet_url'), '') end,
                 'loc', case when b.held then null else nullif(btrim(s.location), '') end,
                 'held', b.held) as x
          from sessions s
          cross join lateral (select to_jsonb(s) as sj) a
          cross join lateral (select (s.reveal_at is not null and s.reveal_at > now()) as held,
                                     (coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') <> 'snd96') as comm,
                                     substring(coalesce(s.bike_slots, '') from '"_feat"\s*:\s*("[^"]*"|[^,}\s]+)') as feat,
                                     substring(coalesce(s.bike_slots, '') from '"_fbk"\s*:\s*("[^"]*"|[^,}\s]+)') as fbk) b
          -- the app's _rideKind: a community session by its kind (a Saturday ride when it names none), anything else the circuit
          cross join lateral (select case when not b.comm then 'jcc'
                                          when s.ride_kind in ('petromin', 'swim', 'workshop', 'runher', 'vlap', 'arena', 'defe5k',
                                                               'blood', 'yoga', 'farm', 'event') then s.ride_kind
                                          else 'saturday' end as kind) k
         where s.session_date >= to_char(v_today, 'YYYY-MM-DD')
           and s.session_date <= to_char(v_today + 60, 'YYYY-MM-DD')
           -- shown to riders: live, or closed as Full, no waitlist (_sessShown)
           and (s.status in ('open', 'full')
                or (s.status = 'closed' and b.fbk is not null and b.fbk not in ('0', 'false', 'null', '""')
                    and (a.sj->>'cancelled_at') is null and coalesce((a.sj->>'draft')::boolean, false) = false
                    and (a.sj->>'opens_at') is null))
           -- a private event only to a holder of its tag (list_sessions)
           and (s.required_tag_id is null
                or exists (select 1 from customer_tags ct where ct.customer_id = v_cid and ct.tag_id = s.required_tag_id
                             and _ctag_active(ct.starts_at, ct.expires_at)))
           -- men only or women only: that gender alone
           and (a.sj->>'gender_only' is null or a.sj->>'gender_only' = v_g)
           -- the members' gate of a community session
           and (not b.comm or coalesce((a.sj->>'open_to_all')::boolean, false) or v_mem)
           -- (a) the Saturday ride for a member, (b) a featured date (_featured)
           and ((k.kind = 'saturday' and v_mem)
                or (k.kind in ('saturday', 'petromin', 'swim', 'defe5k', 'yoga', 'farm')
                    and case when b.feat is null or b.feat = 'null' then k.kind in ('yoga', 'defe5k', 'farm')
                             else b.feat not in ('0', 'false', '""') end))
           -- what the rider holds is in the feed already, as their booking
           and not exists (select 1 from queue_entries q where q.session_id = s.id and q.customer_id = v_cid
                              and q.status in ('waiting', 'active'))
         order by s.session_date, s.id
         limit 60
      ) t;
    end if;
  end if;
  v := v || vc;
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
  foreach fn in array array['public.calendar_link(text,text,text,text)'::regprocedure, 'public.calendar_feed(text)'::regprocedure,
                            'public.calendar_club_set(text,text,boolean)'::regprocedure] loop
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
values ('20261118211000', 'club_calendar')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only): the column, the three functions definer and reachable, and the ledger row.
--   select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'calendar_feeds'
--             and column_name = 'club') as club_col_1,
--          (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
--             and p.proname in ('calendar_link', 'calendar_feed', 'calendar_club_set') and p.prosecdef) as definer_3,
--          has_function_privilege('anon', 'public.calendar_club_set(text,text,boolean)', 'execute') as anon_switch_true,
--          (select count(*) from supabase_migrations.schema_migrations where version = '20261118211000') as ledger_1;
