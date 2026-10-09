-- ============================================================================
-- Weekly KPI report: revenue per day (staff app round 2, 2026-10-09).
--
-- _report_snapshot_data (20261009181000) gave the weekly report's by_day only {date, rides}. Each day now also
-- carries the money, counted by _mt_core (20261009180000) for that one day:
--   fares, fares_card, fares_cash   paid bookings still standing (rev_rides, rev_card, rev_cash)
--   sales, sales_card, sales_cash   the till (rev_sales, sales_card, sales_cash)
-- A day with no ride but with till sales (the shop) is listed too. Analytics > Reports shows a table of the
-- days (older snapshots, without the money, show their rides only). The daily close-out is unchanged.
-- Recreated whole, with the header of 20261009181000 (language plpgsql stable security definer
-- set search_path to 'public'); the live definition matched that file on 2026-10-09.
--
-- Rollback: re-run the _report_snapshot_data block of 20261009181000_report_snapshots.sql.
-- Idempotent.
-- ============================================================================

begin;

create or replace function public._report_snapshot_data(p_kind text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_tot jsonb; v_prev jsonb; v_ly jsonb; v_sess jsonb; v_till jsonb; v_days jsonb;
  d1 text := to_char(p_from, 'YYYY-MM-DD'); d2 text := to_char(p_to, 'YYYY-MM-DD');
  v_len int := p_to - p_from + 1;
begin
  select to_jsonb(t) - 'month' into v_tot from _mt_core(p_from, p_to) t where t.month = 'total';
  if p_kind = 'daily_closeout' then
    select coalesce(jsonb_agg(x order by x->>'time', x->>'id'), '[]'::jsonb) into v_sess from (
      select jsonb_build_object(
        'id', s.id, 'title', coalesce(nullif(s.title, ''), s.ride_kind, s.day), 'time', _rs_time(s.bike_slots),
        'capacity', coalesce(s.capacity, 12),
        'booked', count(q.id) filter (where q.status in ('waiting', 'active', 'done', 'noshow')),
        'rides', count(q.id) filter (where q.status = 'done'),
        'noshows', count(q.id) filter (where q.status = 'noshow'),
        'cancelled', count(q.id) filter (where q.status = 'cancelled'),
        -- the fares taken (paid and still standing; add-ons are in the day's totals)
        'fares', coalesce(sum(coalesce(q.price, 57.5)) filter (where q.paid and q.status not in ('cancelled', 'removed')), 0),
        'unpaid', count(q.id) filter (where q.status = 'done' and not coalesce(q.paid, false)),
        'sales', coalesce((select sum(coalesce(c.qty, 0) * coalesce(c.price, 0)) from cashier_sales c
                           where c.session_id = s.id and c.pay = 'paid' and c.voided_at is null
                             and c.category is distinct from '__cardmeta__'), 0)
      ) as x
      from sessions s left join queue_entries q on q.session_id = s.id
      where s.status is distinct from 'deleted' and left(s.session_date, 10) between d1 and d2
      group by s.id
    ) z;
    select jsonb_build_object(
      'paid', coalesce(sum(coalesce(qty, 0) * coalesce(price, 0)) filter (where pay = 'paid' and category is distinct from '__cardmeta__' and category is distinct from '__discount__' and voided_at is null), 0),
      'house', coalesce(sum(coalesce(qty, 0) * coalesce(price, 0)) filter (where pay = 'house' and voided_at is null), 0),
      'team', coalesce(sum(coalesce(qty, 0) * coalesce(price, 0)) filter (where pay = 'team' and voided_at is null), 0),
      'refunded', coalesce(sum(coalesce(qty, 0) * coalesce(price, 0)) filter (where pay = 'refunded' and category is distinct from '__cardmeta__'), 0),
      'voided', count(distinct coalesce(receipt_id, id)) filter (where voided_at is not null),
      'discount', coalesce(-sum(coalesce(qty, 0) * coalesce(price, 0)) filter (where category = '__discount__' and pay = 'paid' and voided_at is null), 0)
    ) into v_till
    from cashier_sales c
    where c.session_id in (select id from sessions where status is distinct from 'deleted' and left(session_date, 10) between d1 and d2)
       or (c.session_id is null and left(c.created_at, 10) between d1 and d2);
    return jsonb_build_object('totals', coalesce(v_tot, '{}'::jsonb), 'sessions', v_sess, 'till', v_till);
  end if;
  -- weekly
  select to_jsonb(t) - 'month' into v_prev from _mt_core(p_from - v_len, p_from - 1) t where t.month = 'total';
  select to_jsonb(t) - 'month' into v_ly from _mt_core((p_from - interval '1 year')::date, (p_to - interval '1 year')::date) t where t.month = 'total';
  -- each day: the rides done, and the money (20261009207000): fares and till sales, card and cash, as
  -- _mt_core counts them for that one day; a day with no ride but till sales is listed too
  select coalesce(jsonb_agg(jsonb_build_object('date', z.d, 'rides', coalesce(z.r, 0),
           'fares', coalesce(m.rev_rides, 0), 'fares_card', coalesce(m.rev_card, 0), 'fares_cash', coalesce(m.rev_cash, 0),
           'sales', coalesce(m.rev_sales, 0), 'sales_card', coalesce(m.sales_card, 0), 'sales_cash', coalesce(m.sales_cash, 0))
           order by z.d), '[]'::jsonb) into v_days
    from (
      select to_char(g.day, 'YYYY-MM-DD') as d,
             (select count(q.id) filter (where q.status = 'done')
                from sessions s left join queue_entries q on q.session_id = s.id
               where s.status is distinct from 'deleted' and left(s.session_date, 10) = to_char(g.day, 'YYYY-MM-DD')) as r,
             exists (select 1 from sessions s where s.status is distinct from 'deleted'
                      and left(s.session_date, 10) = to_char(g.day, 'YYYY-MM-DD')) as held,
             g.day::date as dd
        from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(day)
    ) z
    left join lateral (select t.* from _mt_core(z.dd, z.dd) t where t.month = 'total') m on true
   where z.held or coalesce(m.rev_sales, 0) <> 0 or coalesce(m.rev_rides, 0) <> 0;
  return jsonb_build_object('totals', coalesce(v_tot, '{}'::jsonb), 'prev', coalesce(v_prev, '{}'::jsonb), 'last_year', coalesce(v_ly, '{}'::jsonb),
    'occupancy', case when coalesce((v_tot->>'seats')::int, 0) > 0 then round(100.0 * (v_tot->>'rides')::int / (v_tot->>'seats')::int) else 0 end,
    'by_day', v_days);
end
$fn$;
revoke all on function public._report_snapshot_data(text, date, date) from public, anon, authenticated;

do $chk$
begin
  if not (select prosecdef from pg_proc where oid = 'public._report_snapshot_data(text, date, date)'::regprocedure)
     or not exists (select 1 from pg_proc p where p.oid = 'public._report_snapshot_data(text, date, date)'::regprocedure
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))
     or has_function_privilege('authenticated', 'public._report_snapshot_data(text, date, date)', 'execute') then
    raise exception '_report_snapshot_data carries the wrong attributes';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009207000', 'weekly_revenue_by_day')
on conflict (version) do nothing;

commit;
