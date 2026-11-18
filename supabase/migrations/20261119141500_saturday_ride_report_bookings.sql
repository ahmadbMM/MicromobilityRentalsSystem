-- ============================================================================
-- 20261119141500_saturday_ride_report_bookings
--
-- The Saturday Social Ride report counts every booking, checked in or not (the user, 2026-11-18: "include all bookings
-- of all time even non checked in bookings"; before that, "include all bookings not only checked in ones from the
-- period we used to not check in", which this replaces).
--
-- staff_saturday_ride_report() now counts, on every Saturday ride already held (its date today or earlier, KSA), each
-- booking that was given a place: checked in (active, done), marked no-show, or left waiting. Not counted: cancelled
-- bookings, bookings staff removed, the waitlist, and requests that were never approved (pending, rejected), unless
-- staff checked them in. Rides still to come count nothing (their open bookings stay in rides[].requests).
-- summary.attendances and rides[].attended are that count (the field names stay, so the page that is live reads them);
-- new: summary.checked_in, summary.not_checked_in (given a place, neither checked in nor marked no-show), and the same
-- two on each ride. The show-up rate is checked in / (checked in + no-shows), on rides where staff marked a no-show.
-- On 2026-11-18: 1,847 checked in + 377 no-shows + 29 never checked in = 2,253 bookings.
-- Copied from 20261119130500 (its only definition); header unchanged (stable security definer, search_path public).
-- Rollback: re-run the definition from 20261119130500.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.staff_saturday_ride_report()
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
  v jsonb;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;

  with s as (
    select id, session_date::date as d, capacity
    from sessions
    where ride_kind = 'saturday' and cancelled_at is null and coalesce(draft, false) = false
      and coalesce(status, '') <> 'deleted' and session_date ~ '^\d{4}-\d\d-\d\d$'
  ),
  b as (
    select q.session_id, s.d, q.status, q.approval, q.ride_group, q.type_preference, q.customer_id,
           coalesce(q.customer_id, 'p:' || q.phone, 'n:' || lower(trim(q.name))) as rider
    from queue_entries q join s on s.id = q.session_id
  ),
  -- a counted booking: on a ride already held, given a place, checked in or not (20261119141500)
  a as (select * from b where d <= v_today and status not in ('cancelled', 'removed', 'waitlist')
          and (status in ('active', 'done') or coalesce(approval, 'approved') = 'approved')),
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
  buckets(sort, lo, hi) as (values (1, 1, 1), (2, 2, 2), (3, 3, 3), (4, 4, 4), (5, 5, 9), (6, 10, 100000))
  select jsonb_build_object(
    'generated_at', now(),
    'summary', jsonb_build_object(
      'attendances', (select count(*) from a),
      'checked_in', (select count(*) from a where status in ('active', 'done')),
      'not_checked_in', (select count(*) from a where status not in ('active', 'done', 'noshow')),
      'unique_riders', (select count(*) from per),
      'first_ride', (select min(d)::text from held),
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
      'groups_from', (select d::text from g0)
    ),
    'rides', coalesce((select jsonb_agg(jsonb_build_object(
        'date', d::text, 'state', state, 'attended', attended, 'checked_in', checked_in, 'not_checked_in', not_checked_in,
        'first_timers', first_timers,
        'returning', returning_riders, 'no_shows', no_shows, 'cancelled', cancelled,
        'requests', case when state = 'upcoming' then open_bookings else 0 end,
        'beginner', beginner, 'intermediate', intermediate, 'own_bike', own_bike,
        'riders_to_date', riders_to_date, 'attended_to_date', attended_to_date, 'capacity', capacity)
        order by d, id) from rs), '[]'::jsonb),
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
revoke all on function public.staff_saturday_ride_report() from public, anon;
grant execute on function public.staff_saturday_ride_report() to authenticated;

do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.staff_saturday_ride_report()'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'staff_saturday_ride_report lost SECURITY DEFINER or its search_path';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119141500', 'saturday_ride_report_bookings')
on conflict (version) do nothing;

commit;

-- check: select p.prosecdef, md5(p.prosrc) as body_md5, has_function_privilege('anon', p.oid, 'execute') as anon_can,
--          has_function_privilege('authenticated', p.oid, 'execute') as auth_can,
--          (select count(*) from supabase_migrations.schema_migrations where version = '20261119141500') as ledger
--        from pg_proc p where p.oid = 'public.staff_saturday_ride_report()'::regprocedure;
