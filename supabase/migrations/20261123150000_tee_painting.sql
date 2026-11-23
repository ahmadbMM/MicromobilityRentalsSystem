-- ============================================================================
-- Tee Painting Workshop, a kind of session inside MicroMobility Experiences (the user, 2026-11-23: "create a
-- session that is exclusively for community members and put it under micromobility experiences only as featured,
-- it is a micromobility t shirt coloring and painting"). The first one: Saturday 28 November 2026, 3:00 to 6:00 PM
-- at Red Mug Caffe, Jeddah, 20 places, 130 SAR per person (the way to pay is announced later; staff mark places
-- paid as on any paid booking), members only, one place each, first come first served, then the waitlist.
--
-- ride_kind 'paint', event_kind 'community', session id suffix -tp. No bike, no breakfast, no gathering time: a start
-- and an end, like yoga. The server learns the kind where it names kinds:
--   1. promo_codes.ride_kind may name it, and _session_kind answers it (20261122150000).
--   2. _updates_key: a session's words, not a ride's (20261122150000).
--   3. _vol_sess_name: a volunteer's certificate names it (20261122150000; "MicroMobility Blood Donation" and the
--      20261122120000 spellings kept).
--   4. staff_record_waiver: the activity waiver, as the app's _waiverKind gives it (20261122150000).
--   5. booking_late: "Running late?" from the start, as on the other kinds that start together (20261122150000).
--   6. calendar_feed: a featured date, as the app shows it (FEAT_KINDS: yoga, defe5k, farm, ktri, paint) (20261122150000).
--   7. _fare_now: a place costs the session's own price (sessions.price, 130) when paid_ride is on, like an event's
--      seat or a race's (20261028200000).
--   8. _paint_entry_guard: one place per account on the session (ONE_PER_SESSION); staff are exempt.
--   9. push_words 'kind:paint': the kind's name in the evening-before reminder, in the eleven languages.
-- Functions are restated from their latest text in this folder (the files named above) with the one change;
-- SECURITY DEFINER (where it was) and the search_path are kept.
--
-- Safe before the app: nothing reads 'paint' until a session of that kind exists, and the session row is a separate
-- script (supabase/checks/tee-painting-session-2026-11-28.sql) run only after the app that knows the kind is live.
-- Undo: drop trigger queue_entries_paint_guard on public.queue_entries; drop function public._paint_entry_guard();
--       delete from public.push_words where key = 'kind:paint'; re-run the functions and the constraint from
--       20261122150000_kaust_triathlon.sql and _fare_now from 20261028200000_arena_race.sql.
-- ============================================================================
begin;
set local lock_timeout = '5s';

-- ── 1. Promo codes for the kind, and the kind itself ──────────────────────────
alter table public.promo_codes drop constraint if exists promo_codes_ride_kind_known;
alter table public.promo_codes add constraint promo_codes_ride_kind_known
  check (ride_kind is null or ride_kind in ('jcc','saturday','petromin','swim','workshop','snd96','event','runher','vlap','arena','defe5k','blood','yoga','farm','ktri','paint'));

create or replace function public._session_kind(p_session text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case
           when s.ride_kind = 'snd96' then 'snd96'
           when coalesce(s.event_kind, '') <> 'community' then 'jcc'
           when s.ride_kind in ('event','petromin','swim','workshop','runher','vlap','arena','defe5k','blood','yoga','farm','ktri','paint') then s.ride_kind
           else 'saturday'
         end
    from sessions s where s.id = p_session
$function$;
revoke execute on function public._session_kind(text) from public, anon, authenticated;

-- ── 2. A session's words, not a ride's ────────────────────────────────────────
create or replace function public._updates_key(p_key text, p_session text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when _session_kind(p_session) in ('swim', 'workshop', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'blood', 'yoga', 'farm', 'ktri', 'paint')
              then p_key || '_s' else p_key end;
$function$;
revoke execute on function public._updates_key(text, text) from public, anon, authenticated;

-- ── 3. The session's name on a volunteer's certificate ───────────────────────
create or replace function public._vol_sess_name(p_session text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when s.ride_kind in ('saturday', 'petromin', 'swim', 'workshop', 'snd96', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'blood', 'yoga', 'farm', 'ktri', 'paint')
              then coalesce(nullif(btrim(s.title), ''),
                            case s.ride_kind when 'saturday' then 'Saturday Social Ride' when 'petromin' then 'Petromin night' /* the user's pick, 2026-11-10 (20261110235400) */
                              when 'swim' then 'Triathlon Pool Session' when 'workshop' then 'T100 Triathlon Prep'
                              when 'snd96' then 'Saudi National Day 96 Ride' when 'event' then 'Event' when 'runher' then 'Run for Her'
                              when 'vlap' then 'Victory Lap' when 'arena' then 'Arena Heros Hybrid Race' when 'defe5k' then 'DEFE 5KM Run'
                              when 'yoga' then 'Hatha Yoga for Cyclists' /* 20261112120000 */
                              when 'farm' then 'Farm House Night' /* 20261114130000 */
                              when 'ktri' then 'KAUST Triathlon' /* 20261122150000 */
                              when 'paint' then 'Tee Painting Workshop' /* 20261123150000 */
                              else 'MicroMobility Blood Donation' end) /* 20261122120000 */
              else 'Jeddah Corniche Circuit' end
    from sessions s where s.id = p_session
$function$;
revoke all on function public._vol_sess_name(text) from public, anon, authenticated;

-- ── 4. A desk-signed waiver on a tee painting place is the activity waiver ───────
create or replace function public.staff_record_waiver(p_entry_ids text[], p_version text, p_op text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_ids text[]; v_pre text; v_kind text; v_n int := 0; r record;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_entry_ids, '{}'::text[])) x where nullif(btrim(x), '') is not null;
  if v_ids is null or array_length(v_ids, 1) > 20 then
    raise exception 'BAD_INPUT: one to twenty bookings' using errcode = '22023';
  end if;
  if coalesce(p_version, '') !~ '^((swim|activity|blood|farm)-)?[0-9]{4}-[0-9]{2}-v[0-9]{1,6}$' then
    raise exception 'WAIVER_REQUIRED' using errcode = 'P0001';
  end if;
  if _waiver_outdated(p_version) then
    raise exception 'WAIVER_OUTDATED' using errcode = 'P0001';
  end if;
  v_pre := coalesce(substring(p_version from '^(swim|activity|blood|farm)-'), '');
  for r in select q.id, q.status, s.event_kind, s.ride_kind
             from queue_entries q left join sessions s on s.id = q.session_id
            where q.id = any(v_ids)
              for update of q loop
    v_n := v_n + 1;
    if r.status not in ('waiting', 'waitlist', 'active') then
      raise exception 'BAD_BOOKING_STATE: % is %', r.id, r.status;
    end if;
    v_kind := case when coalesce(r.event_kind, '') = 'community' and coalesce(r.ride_kind, '') <> 'snd96' then
                (case when r.ride_kind = 'swim' then 'swim' when r.ride_kind = 'blood' then 'blood'
                      when r.ride_kind = 'farm' then 'farm'
                      when r.ride_kind in ('workshop', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'yoga', 'ktri', 'paint') then 'activity'
                      else '' end)
              else '' end;
    if v_pre <> v_kind then
      raise exception 'WAIVER_OUTDATED' using errcode = 'P0001';
    end if;
  end loop;
  if v_n <> array_length(v_ids, 1) then raise exception 'BOOKING_NOT_FOUND'; end if;
  with u as (
    update queue_entries q
       set waiver_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           waiver_version = p_version
     where q.id = any(v_ids) and coalesce(q.waiver_version, '') = ''
    returning q.id)
  insert into audit_log (tbl, row_id, op, changed)
  select 'queue_entries', u.id, 'UPDATE',
         jsonb_build_object('waiver_version', jsonb_build_object('old', null, 'new', p_version),
                            'waiver_by', jsonb_build_object('old', null, 'new', 'desk: ' || coalesce(nullif(left(btrim(coalesce(p_op, '')), 40), ''), 'staff')))
    from u;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'stamped', v_n);
end
$function$;
revoke all on function public.staff_record_waiver(text[], text, text) from public, anon, authenticated;
grant execute on function public.staff_record_waiver(text[], text, text) to authenticated;

-- ── 5. "Running late?" from the reporting time ────────────────────────────────
create or replace function public.booking_late(p_id text, p_token text, p_session text, p_min integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare s sessions%rowtype; v_kind text; v_from timestamptz; v_to timestamptz; v_start timestamptz; v_n int; v_at timestamptz;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if p_min is not null and p_min not in (10, 20, 30) then return jsonb_build_object('ok', false, 'error', 'bad'); end if;
  select * into s from sessions where id = p_session;
  if not found or s.status = 'deleted' or s.cancelled_at is not null or s.ride_status is not distinct from 'cancelled' then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  -- a time to turn up: the kinds that gather (their times are "gathering, then start") and the ones that start together
  v_kind := _session_kind(s.id);
  if coalesce(s.ride_kind, '') = 'testride'
     or v_kind not in ('saturday', 'snd96', 'runher', 'vlap', 'farm', 'workshop', 'event', 'yoga', 'defe5k', 'ktri', 'paint') then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  select w.starts_at, w.ends_at into v_from, v_to from _session_window(s) w;
  if v_to < v_from then v_to := v_to + interval '1 day'; end if; -- a session that runs past midnight
  v_start := case when v_kind in ('saturday', 'snd96', 'runher', 'vlap', 'farm') then v_to else v_from end;
  if v_from is null or now() < v_from - interval '3 hours' or now() >= v_start + interval '2 hours' then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  -- a party partly (or wholly) checked in is past asking: the desk sees them (review fix)
  if exists (select 1 from queue_entries q where q.session_id = p_session and q.customer_id = p_id and q.status in ('active', 'done')) then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  v_at := case when p_min is null then null else now() end;
  -- the rider's own seated rows, all of them: one answer for the party; a late rider is a coming one
  update queue_entries q
     set late_min = p_min, late_at = v_at,
         coming_at = case when p_min is not null and (q.coming_at is null or q.coming_at < v_from - interval '48 hours')
                          then now() else q.coming_at end
   where q.session_id = p_session and q.customer_id = p_id and q.status = 'waiting'
     and coalesce(q.approval, 'approved') = 'approved';
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('ok', false, 'error', 'none'); end if;
  return jsonb_build_object('ok', true, 'late_min', p_min, 'late_at', v_at, 'n', v_n,
    'coming_at', (select min(q.coming_at) from queue_entries q
                   where q.session_id = p_session and q.customer_id = p_id and q.status = 'waiting' and q.coming_at is not null));
end $function$;

-- ── 6. The club's calendar: a featured date ───────────────────────────────────
create or replace function public.calendar_feed(p_key text)
 returns jsonb
 language plpgsql
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
                                                               'blood', 'yoga', 'farm', 'event', 'ktri', 'paint') then s.ride_kind
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
                or (k.kind in ('saturday', 'petromin', 'swim', 'defe5k', 'yoga', 'farm', 'ktri', 'paint')
                    and case when b.feat is null or b.feat = 'null' then k.kind in ('yoga', 'defe5k', 'farm', 'ktri', 'paint')
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

-- ── 7. A place's price: the session's own, as an event's seat ──────────────────
create or replace function public._fare_now(p_session_id text, p_entry_id text, p_type text)
 returns numeric
 language sql
 stable
 set search_path to 'public'
as $function$
  select case
    when coalesce(s.event_kind, '') = 'community' and not coalesce(s.paid_ride, false) then 0
    when coalesce(s.ride_kind, '') in ('event', 'vlap', 'arena', 'paint') then least(greatest(coalesce(s.price, 0), 0), 5000)
    else coalesce(_booking_fare(p_entry_id, coalesce(s.ride_kind, ''), p_type),
                  case when coalesce(p_type, '') = 'Own' then null
                       else (select max(price) from ride_prices) end)
  end
  from sessions s where s.id = p_session_id
$function$;

revoke all on function public._fare_now(text, text, text) from public, anon, authenticated;

-- ── 8. One place per account on a tee painting session ───────────────────────
create or replace function public._paint_entry_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  s record;
  _live int;
begin
  if new.customer_id is null or (select is_staff()) then return new; end if;
  select x.ride_kind, x.event_kind into s from sessions x where x.id = new.session_id;
  if not found or coalesce(s.ride_kind, '') <> 'paint' or coalesce(s.event_kind, '') <> 'community' then
    return new;
  end if;
  -- leaving, finishing or being marked a no-show is never refused
  if coalesce(new.status, '') in ('cancelled', 'removed', 'noshow', 'done') then return new; end if;
  -- a live row that stays on its session is not judged again
  if tg_op = 'UPDATE' and old.session_id is not distinct from new.session_id
     and coalesce(old.status, '') not in ('cancelled', 'removed', 'noshow') then
    return new;
  end if;
  -- the same lock _solo_ride_cap and _run_entry_guard take, so two bookings sent at once take turns
  perform pg_advisory_xact_lock(hashtext('ridecap:' || coalesce(new.session_id, '') || ':' || new.customer_id));
  select count(*) into _live
    from queue_entries q
   where q.session_id = new.session_id
     and q.customer_id = new.customer_id
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
     and q.id <> new.id;
  if _live >= 1 then
    raise exception 'One place per person on this session.' using detail = 'ONE_PER_SESSION';
  end if;
  return new;
end $function$;
revoke execute on function public._paint_entry_guard() from public, anon, authenticated;
drop trigger if exists queue_entries_paint_guard on public.queue_entries;
create trigger queue_entries_paint_guard
  before insert or update of status, session_id on public.queue_entries
  for each row execute function public._paint_entry_guard();

-- ── 9. The kind's name for the evening-before reminder ───────────────────────
insert into public.push_words (key, lang, title, body) values
  ('kind:paint', 'en', 'Tee Painting Workshop', ''),          ('kind:paint', 'ar', 'ورشة الرسم على التيشيرت', ''),
  ('kind:paint', 'fr', 'Atelier de peinture sur t-shirt', ''), ('kind:paint', 'es', 'Taller de pintura de camisetas', ''),
  ('kind:paint', 'pt', 'Oficina de pintura de camisetas', ''), ('kind:paint', 'ur', 'ٹی شرٹ پینٹنگ ورکشاپ', ''),
  ('kind:paint', 'hi', 'टी-शर्ट पेंटिंग वर्कशॉप', ''),           ('kind:paint', 'tl', 'Workshop sa Pagpipinta ng T-shirt', ''),
  ('kind:paint', 'ne', 'टी-सर्ट चित्रकला कार्यशाला', ''),         ('kind:paint', 'bn', 'টি-শার্ট পেইন্টিং কর্মশালা', ''),
  ('kind:paint', 'ms', 'Bengkel Melukis Baju-T', '')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- ── checks ─────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['_session_kind','_updates_key','_vol_sess_name','staff_record_waiver','booking_late','calendar_feed',
                           '_paint_entry_guard'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_fare_now'
                   and p.prosrc like '%''paint''%') then
    raise exception '_fare_now does not price the paint kind';
  end if;
  if has_function_privilege('anon', 'public._fare_now(text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public._fare_now(text,text,text)', 'execute') then
    raise exception '_fare_now is executable by a client';
  end if;
  if has_function_privilege('anon', 'public._paint_entry_guard()', 'execute')
     or has_function_privilege('authenticated', 'public._paint_entry_guard()', 'execute') then
    raise exception '_paint_entry_guard is executable by a client';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'queue_entries_paint_guard'
                   and tgrelid = 'public.queue_entries'::regclass and not tgisinternal) then
    raise exception 'queue_entries_paint_guard is missing';
  end if;
  if (select count(*) from public.push_words where key = 'kind:paint') <> 11 then
    raise exception 'the kind:paint push words are not all there';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261123150000', 'tee_painting')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
