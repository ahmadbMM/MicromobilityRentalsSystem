-- ============================================================================
-- 20261119840000_saturday_ride_rides
--
-- The months counted by hand (20261119830000) gain their rides (the user, 2026-11-19: "starting from 24/01 including
-- it there was a saturday social ride every saturday except ramadan saturdays and summer splash saturday"): every
-- Saturday from 24 Jan to 31 Jul 2026 but the four in Ramadan 1447 (21 and 28 Feb, 7 and 14 Mar 2026; Ramadan ran
-- about 18 Feb to 19 Mar) and 25 Jul (the Summer Splash Run): 22 rides - Jan 2, Feb 2, Mar 2, Apr 4, May 5, Jun 4,
-- Jul 3 (4, 11 and 18 July; 18 July is also the booking system's first ride, counted once, in July's).
--   * months[].rides is now given for the hand months too;
--   * summary.hand_rides (22), summary.rides_all_time = hand_rides + the booking system's rides held after 31 July,
--     summary.avg_all_time = all_time / rides_all_time. summary.rides_held and avg_per_ride stay the booking system's.
-- The rule covers the months by hand only: from August the booking system's own sessions are the rides (it has none on
-- 1 Aug, and 17 Oct was a Run for Her).
-- Same signature, header and grants as 20261119830000.
-- Rollback: run the function from 20261119830000_saturday_ride_history.sql again.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.staff_saturday_ride_report(p_mode text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
  v_mode text := coalesce(p_mode, 'all');
  v_cut date := date '2026-09-05'; -- the first Saturday ride staff checked in rider by rider
  v_first date := date '2026-01-24'; -- the first Saturday Social Ride, months before the booking system (20261119830000)
  v_hand_to date := date '2026-07-31'; -- the months up to here are counted by hand; the booking system counts after it
  v jsonb;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if v_mode not in ('checked_in', 'mixed', 'all') then raise exception 'BAD_MODE' using errcode = '22023'; end if;

  with s as (
    select id, session_date::date as d, capacity
    from sessions
    where ride_kind = 'saturday' and cancelled_at is null and coalesce(draft, false) = false
      and coalesce(status, '') <> 'deleted' and session_date ~ '^\d{4}-\d\d-\d\d$'
      and session_date <> '2026-07-25' -- the Summer Splash Run, held on a Saturday ride's session: no ride that day
  ),
  -- Saturday riders per month before the booking system counted them, given by the user on 2026-11-19 (July = 4, 11
  -- and 18 July; the booking system's 18 July is inside the 140, so a month here replaces the system's count for it)
  hand(mon, riders) as (values (date '2026-01-01', 45), (date '2026-02-01', 120), (date '2026-03-01', 150),
    (date '2026-04-01', 180), (date '2026-05-01', 210), (date '2026-06-01', 220), (date '2026-07-01', 140)),
  -- the rides of those months (20261119840000; the user, 2026-11-19: "starting from 24/01 including it there was a
  -- saturday social ride every saturday except ramadan saturdays and summer splash saturday"): every Saturday from
  -- v_first to v_hand_to but the four of Ramadan 1447 (21 and 28 Feb, 7 and 14 Mar 2026) and the Summer Splash Run's
  sat as (select g::date as d from generate_series(v_first::timestamp, v_hand_to::timestamp, interval '7 days') g
          where g::date <> all (array[date '2026-02-21', date '2026-02-28', date '2026-03-07', date '2026-03-14',
                                      date '2026-07-25'])),
  b as (
    select q.session_id, s.d, q.status, q.approval, q.ride_group, q.type_preference, q.customer_id,
           coalesce(q.customer_id, 'p:' || q.phone, 'n:' || lower(trim(q.name))) as rider
    from queue_entries q join s on s.id = q.session_id
  ),
  -- a counted booking (20261119150000): checked in, on every version; given a place but not checked in (no-show, left
  -- waiting) on 'all', and on 'mixed' before v_cut; never cancelled, removed, the waitlist or a request not approved
  a as (select * from b where d <= v_today and status not in ('cancelled', 'removed', 'waitlist')
          and (status in ('active', 'done')
               or (coalesce(approval, 'approved') = 'approved' and (v_mode = 'all' or (v_mode = 'mixed' and d < v_cut))))),
  per as (select rider, count(*) as rides, min(d) as first_d from a group by rider),
  r as (
    select s.id, s.d, s.capacity,
           case when count(a.rider) > 0 then 'held' when s.d >= v_today then 'upcoming' else 'none' end as state,
           count(a.rider) as attended,
           count(a.rider) filter (where p.first_d = s.d) as first_timers,
           count(a.rider) filter (where p.first_d < s.d) as returning_riders,
           count(a.rider) filter (where a.ride_group = 'beg') as beginner,
           count(a.rider) filter (where a.ride_group = 'int') as intermediate,
           count(a.rider) filter (where a.type_preference = 'Own') as own_bike
    from s
    left join a on a.session_id = s.id
    left join per p on p.rider = a.rider
    group by s.id, s.d, s.capacity
  ),
  rs as (
    select r.*,
           (select count(*) from a x where x.session_id = r.id and x.status in ('active', 'done')) as checked_in,
           (select count(*) from a x where x.session_id = r.id and x.status not in ('active', 'done', 'noshow')) as not_checked_in,
           (select count(*) from b where b.session_id = r.id and b.status = 'noshow') as no_shows,
           (select count(*) from b where b.session_id = r.id and b.status = 'cancelled') as cancelled,
           (select count(*) from b where b.session_id = r.id and b.status in ('waiting', 'waitlist', 'approved', 'confirmed')) as open_bookings,
           (select count(*) from per where per.first_d <= r.d) as riders_to_date,
           sum(r.attended) over (order by r.d, r.id) as attended_to_date
    from r
  ),
  held as (select * from rs where state = 'held'),
  lastd as (select max(d) as d from held),
  people as (
    select distinct on (a.rider) a.rider, c.gender, c.nationality,
           case when c.birth_date ~ '^\d{4}-\d\d-\d\d$'
                then extract(year from age(v_today, c.birth_date::date))::int end as age
    from a left join customers c on c.id = a.customer_id
    order by a.rider
  ),
  g0 as (select min(d) as d from a where ride_group is not null),
  nat as (
    select coalesce(nullif(trim(nationality), ''), '') as label, count(*) as n
    from people group by 1
  ),
  nat_top as (
    select label, n, row_number() over (order by (label = ''), n desc, label) as rk from nat
  ),
  m as (
    select 'group' as dimension,
           case ride_group when 'beg' then 'beg' when 'int' then 'int' else '' end as label,
           case ride_group when 'beg' then 1 when 'int' then 2 else 3 end as sort,
           count(*) as value
    from a where d >= (select d from g0) group by 2, 3
    union all
    select 'bike', case when type_preference is null then 'Any' else type_preference end,
           case when type_preference = 'Own' then 9 else 1 end, count(*)
    from a group by 2, 3
    union all
    select 'gender', case gender when 'male' then 'male' when 'female' then 'female' else '' end,
           case gender when 'male' then 1 when 'female' then 2 else 3 end, count(*)
    from people group by 2, 3
    union all
    select 'age',
           case when age is null then '' when age < 13 then '0-12' when age < 18 then '13-17' when age < 25 then '18-24'
                when age < 35 then '25-34' when age < 45 then '35-44' when age < 55 then '45-54' else '55+' end,
           case when age is null then 9 when age < 13 then 1 when age < 18 then 2 when age < 25 then 3
                when age < 35 then 4 when age < 45 then 5 when age < 55 then 6 else 7 end,
           count(*)
    from people group by 2, 3
    union all
    select 'nationality',
           case when label = '' then '' when rk <= 8 then label else '*' end,
           case when label = '' then 99 when rk <= 8 then rk::int else 98 end,
           sum(n)
    from nat_top group by 2, 3
  ),
  mo as (
    select mon, riders::bigint as riders, (select count(*) from sat where date_trunc('month', sat.d)::date = hand.mon) as rides,
           true as by_hand from hand
    union all
    select date_trunc('month', d)::date, count(*), count(distinct session_id), false from a where d > v_hand_to group by 1
  ),
  buckets(sort, lo, hi) as (values (1, 1, 1), (2, 2, 2), (3, 3, 3), (4, 4, 4), (5, 5, 9), (6, 10, 100000))
  select jsonb_build_object(
    'generated_at', now(),
    'summary', jsonb_build_object(
      'attendances', (select count(*) from a),
      'checked_in', (select count(*) from a where status in ('active', 'done')),
      'not_checked_in', (select count(*) from a where status not in ('active', 'done', 'noshow')),
      'unique_riders', (select count(*) from per),
      'first_ride', (select least(v_first, min(d))::text from held),
      'system_from', (select min(d)::text from held),
      'hand_from', v_first::text,
      'hand_to', v_hand_to::text,
      'hand_riders', (select sum(riders) from hand),
      'all_time', (select sum(riders) from mo),
      'hand_rides', (select count(*) from sat),
      'rides_all_time', (select count(*) from sat) + (select count(*) from held where d > v_hand_to),
      'avg_all_time', (select round((select sum(riders) from mo)::numeric
                                    / nullif((select count(*) from sat) + (select count(*) from held where d > v_hand_to), 0), 1)),
      'rides_held', (select count(*) from held),
      'avg_per_ride', (select round(avg(attended), 1) from held),
      'best_count', (select attended from held order by attended desc, d limit 1),
      'best_date', (select d::text from held order by attended desc, d limit 1),
      'last_count', (select attended from held order by d desc limit 1),
      'last_date', (select d::text from held order by d desc limit 1),
      'prev_count', (select attended from held order by d desc offset 1 limit 1),
      'prev_date', (select d::text from held order by d desc offset 1 limit 1),
      'last_new', (select count(*) from per where first_d = (select d from lastd)),
      'repeat_riders', (select count(*) from per where rides >= 2),
      'repeat_pct', (select round(100.0 * count(*) filter (where rides >= 2) / nullif(count(*), 0), 1) from per),
      'five_plus', (select count(*) from per where rides >= 5),
      'five_plus_pct', (select round(100.0 * count(*) filter (where rides >= 5) / nullif(count(*), 0), 1) from per),
      'most_rides', (select max(rides) from per),
      'rides_per_rider', (select round(avg(rides), 2) from per),
      'came_back_pct', (select round(100.0 * count(*) filter (where rides >= 2) / nullif(count(*), 0), 1)
                          from per where first_d < (select d from lastd)),
      'no_shows', (select coalesce(sum(no_shows), 0) from held),
      'cancellations', (select coalesce(sum(cancelled), 0) from held),
      'noshow_rides', (select count(*) from held where no_shows > 0),
      'show_rate', (select round(100.0 * sum(checked_in) / nullif(sum(checked_in + no_shows), 0), 1) from held where no_shows > 0),
      'groups_from', (select d::text from g0),
      'mode', v_mode,
      'checkin_from', v_cut::text
    ),
    'rides', coalesce((select jsonb_agg(jsonb_build_object(
        'date', d::text, 'state', state, 'attended', attended, 'checked_in', checked_in, 'not_checked_in', not_checked_in,
        'first_timers', first_timers,
        'returning', returning_riders, 'no_shows', no_shows, 'cancelled', cancelled,
        'requests', case when state = 'upcoming' then open_bookings else 0 end,
        'beginner', beginner, 'intermediate', intermediate, 'own_bike', own_bike,
        'riders_to_date', riders_to_date, 'attended_to_date', attended_to_date, 'capacity', capacity)
        order by d, id) from rs), '[]'::jsonb),
    'months', coalesce((select jsonb_agg(jsonb_build_object(
        'month', to_char(mon, 'YYYY-MM-DD'), 'riders', riders, 'rides', rides, 'by_hand', by_hand) order by mon) from mo), '[]'::jsonb),
    'frequency', coalesce((select jsonb_agg(jsonb_build_object(
        'lo', bk.lo, 'hi', case when bk.hi > 1000 then null else bk.hi end,
        'riders', (select count(*) from per where rides between bk.lo and bk.hi),
        'attendances', (select coalesce(sum(rides), 0) from per where rides between bk.lo and bk.hi))
        order by bk.sort) from buckets bk), '[]'::jsonb),
    'mix', coalesce((select jsonb_agg(jsonb_build_object(
        'dimension', dimension, 'label', label, 'value', value, 'pct', pct)
        order by dimension, sort, value desc)
      from (select m.*, round(100.0 * value / nullif(sum(value) over (partition by dimension), 0), 1) as pct from m) mm), '[]'::jsonb)
  ) into v;

  return v;
end $function$;
revoke all on function public.staff_saturday_ride_report(text) from public, anon;
grant execute on function public.staff_saturday_ride_report(text) to authenticated;

do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.staff_saturday_ride_report(text)'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'staff_saturday_ride_report lost SECURITY DEFINER or its search_path';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119840000', 'saturday_ride_rides')
on conflict (version) do nothing;

commit;

-- check: select p.prosecdef, md5(p.prosrc) as body_md5, has_function_privilege('anon', p.oid, 'execute') as anon_can,
--          has_function_privilege('authenticated', p.oid, 'execute') as auth_can,
--          (select count(*) from supabase_migrations.schema_migrations where version = '20261119840000') as ledger
--        from pg_proc p where p.oid = 'public.staff_saturday_ride_report(text)'::regprocedure;
