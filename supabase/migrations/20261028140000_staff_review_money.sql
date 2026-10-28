-- ============================================================================
-- Money and Petromin billing, from the staff panel review (2026-10-28, batch 1 P02/P03).
--
-- 1. A Petromin booking moved anywhere moves its registration (S05-core5-02, S03-core3-01, S13-open-items-04).
--    The company invoice (the Petromin page's Billing report) counts only registrations with checked_out_at,
--    and the registration's price is set by _rider_registration_guard when that stamp lands. Only the Petromin
--    page wrote the stamps, so a rider checked in or returned on the Bookings roster, the drawer, Hand-over,
--    a bike's Return or Close out billed nothing (21 Oct: 23 of 23 registrations checked in, none returned).
--    queue_entries_rider_sync (AFTER UPDATE OF status, only when the status changes) calls
--    _rider_reg_follow_booking, which stamps the rows of rider_registrations whose matched_entry_id is the
--    booking:
--      to 'active'                      checked_in_at (and checked_in_by) when not stamped yet
--      to 'done'                        checked_in_at when not stamped, and checked_out_at (and checked_out_by)
--                                       when not stamped: the guard trigger then prices the ride
--      'done' back to 'active'          clears checked_out_at / checked_out_by (an undone return)
--      'done' back to waiting/waitlist  the same (Close out's undo puts a rider checked in without a bike back
--                                       to waiting; still checked in, no longer returned)
--      'active' back to waiting/waitlist  clears checked_in_at / checked_in_by when not returned (an undone
--                                       check-in)
--    No-show, cancel and every other move leave the registration alone. Every write is guarded on the stamp
--    being empty (or set, for a clear), so it never fights the Petromin page's own two-step write
--    (registration first, then the booking: the second step finds the stamp there and does nothing).
--    checked_in_by / checked_out_by are filled only from a source: the signed-in staff account's display_name
--    (staff.display_name, as _staff_comments_stamp names an author); a cron job or the service role has none
--    and leaves them as they are. Times are the transaction's (now()), so a Close out stamps its own time.
--    No loop: the triggers on rider_registrations are rider_registration_guard (BEFORE UPDATE, writes NEW
--    only), cact_rider_registrations (_cact_row: returns at once for a staff session, and for an update only
--    logs rider_edit to customer_activity) and rider_registration_link_reprice, which does write queue_entries
--    but fires only on INSERT, DELETE or UPDATE OF matched_entry_id, source - columns this function never sets
--    (and a price write is no status change, which the WHEN clause above requires). Security definer with
--    search_path public (the registrations are staff-only under RLS, and a customer's own write may move a
--    status); no client may execute it. Registrations already left unbilled are not touched here: the Billing
--    dialog now lists them for the period with one "Return them" (and the check query at the end lists the
--    rest).
--
-- 2. _mt_core (Analytics months, the daily close-out and weekly snapshots, the weekly revenue by day):
--    a. rev_cash is cash recorded as cash: pay_method 'cash', or what a split's card_amount leaves (S10-money-01,
--       S08-analytics-03, S13-open-items-05). It was rev_rides - rev_card, so every paid booking with no method
--       (264 rows, SAR 16,562.50 from June to September per the 2026-10-24 review) was reported as cash. Such a
--       row is now in neither card nor cash; the page shows it as "Method not recorded" = rev_rides - rev_card
--       - rev_cash. Older snapshots keep their numbers (their cash was the rest, so they read 0 not recorded).
--    b. Sales rung up on a booking (queue_entries.purchases) whose line says method 'card' (the Cashier pop-up
--       records Card or Cash since this change, S05-core5-08) count in sales_card; a line without a method is
--       cash, as before.
--    c. A till sale with no session (the shop) is dated by its Riyadh day, not by the UTC date at the head of
--       its created_at text (handover dbf-c-4 / dbm1-3): one rung up between 00:00 and 03:00 Riyadh went to the
--       day, or the month, before. The cast is guarded by a pattern of an ISO time (the page writes
--       toISOString()); anything else keeps its first ten characters, as before.
--    Same name, arguments and RETURNS TABLE, so staff_monthly_totals and _report_snapshot_data keep reading it.
-- 3. _report_snapshot_data: the daily close-out's till dates its no-session sales by the Riyadh day, the same
--    fix as 2c. Nothing else.
--
-- Proof these are the live definitions (md5 of the body between `as $function$` and `$function$` read from
-- production, against the repo text, Python hashlib):
--   _mt_core                 be7b859d729951649357fd0350a87cdb = the body of 20261024120000_vl_transfers_not_takings.sql
--                            (4477 characters), the base of 2 above.
--   _report_snapshot_data    ac453ee21e368c50d8140477a7194af6 = the body of 20261009207000_weekly_revenue_by_day.sql
--                            with its three whole-line comments taken out (4706 characters; the file's own body,
--                            comments in, is 75bcea8a472233b389dcaf409a067ea4: the editor it was pasted through
--                            dropped them). Part 3 is that live body with the one change; no body in this file
--                            carries a comment line.
--   _rider_registration_guard 97d2526c2ee4eb34ef3fbf4c1fb47670 = 20260917100000_rider_price_follows_type.sql
--                            (invoker); not changed here.
-- Headers are copied from those migrations (language, volatility, security definer, search_path, RETURNS).
-- Once applied, the bodies read (md5 of prosrc; the check at the end compares them): _mt_core
-- db714184830a0ba73a1b6b2c1c9d5212, _report_snapshot_data 627d86db6bfa0dc319d4fbbdfd0cacf9, _rider_reg_follow_booking
-- 6d98a377f1947e0c72c06a1102d95df1 (a body pasted through an editor that drops comment lines still matches: none has one).
-- Tried on a local PostgreSQL 17 with the repo's previous definitions and these triggers: the figures and every
-- status move above came out as described, and a second run changes nothing.
--
-- Rollback:
--   drop trigger if exists queue_entries_rider_sync on public.queue_entries;
--   drop function if exists public._rider_reg_follow_booking();
--   then re-run the _mt_core block of 20261024120000_vl_transfers_not_takings.sql and the
--   _report_snapshot_data block of 20261009207000_weekly_revenue_by_day.sql, and take the
--   _rider_reg_follow_booking line out of supabase/checks/security-attributes.sql. Stamps the trigger wrote
--   stay (they are what the page's own Return would have written).
-- Not during a ride night (about 18:00-23:00 Riyadh): the trigger takes a short lock on queue_entries.
-- Idempotent. Then run supabase/checks/security-attributes.sql.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. A Petromin booking moved anywhere moves its registration ───────────────────────────────
create or replace function public._rider_reg_follow_booking()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_by text;
begin
  if not exists (select 1 from rider_registrations r where r.matched_entry_id = new.id) then
    return null;
  end if;
  select left(nullif(btrim(s.display_name), ''), 120) into v_by from staff s where s.user_id = auth.uid();
  if new.status = 'active' and old.status = 'done' then
    update rider_registrations r set checked_out_at = null, checked_out_by = null
     where r.matched_entry_id = new.id and r.checked_out_at is not null;
  elsif new.status = 'active' then
    update rider_registrations r set checked_in_at = now(), checked_in_by = coalesce(r.checked_in_by, v_by)
     where r.matched_entry_id = new.id and r.checked_in_at is null;
  elsif new.status = 'done' then
    update rider_registrations r
       set checked_in_at = coalesce(r.checked_in_at, now()),
           checked_in_by = case when r.checked_in_at is null then coalesce(r.checked_in_by, v_by) else r.checked_in_by end,
           checked_out_at = now(),
           checked_out_by = coalesce(r.checked_out_by, v_by)
     where r.matched_entry_id = new.id and r.checked_out_at is null;
  elsif new.status in ('waiting', 'waitlist') and old.status = 'done' then
    update rider_registrations r set checked_out_at = null, checked_out_by = null
     where r.matched_entry_id = new.id and r.checked_out_at is not null;
  elsif new.status in ('waiting', 'waitlist') and old.status = 'active' then
    update rider_registrations r set checked_in_at = null, checked_in_by = null
     where r.matched_entry_id = new.id and r.checked_in_at is not null and r.checked_out_at is null;
  end if;
  return null;
end
$fn$;
revoke all on function public._rider_reg_follow_booking() from public, anon, authenticated;

drop trigger if exists queue_entries_rider_sync on public.queue_entries;
create trigger queue_entries_rider_sync
  after update of status on public.queue_entries
  for each row when (old.status is distinct from new.status)
  execute function public._rider_reg_follow_booking();

-- ── 2. _mt_core: cash recorded as cash, booking sales by method, shop sales by the Riyadh day ──
create or replace function public._mt_core(p_from date, p_to date)
returns table (
  month text, sessions_held int, seats int, bookings int, rides int, riders int, noshows int, cancellations int,
  rev_rides numeric, rev_card numeric, rev_cash numeric, rev_sales numeric, sales_card numeric, sales_cash numeric,
  pending numeric
)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  with
  s as (
    select id, left(session_date, 7) as m, coalesce(capacity, 12) as cap
    from sessions
    where status is distinct from 'deleted'
      and left(session_date, 10) between to_char(p_from, 'YYYY-MM-DD') and to_char(p_to, 'YYYY-MM-DD')
  ),
  qa as (
    select s.m, q.session_id, q.status, coalesce(q.paid, false) as paid, q.customer_id,
      coalesce(q.price, 57.5) + coalesce((
        select sum(coalesce(case when jsonb_typeof(a) = 'object' and (a->>'p') ~ '^-?[0-9]+(\.[0-9]+)?$' then (a->>'p')::numeric end, i.price, 0)
                   * greatest(coalesce(case when jsonb_typeof(a) = 'object' and (a->>'qty') ~ '^[0-9]+$' then (a->>'qty')::numeric end, 1), 1))
        from jsonb_array_elements(_mt_json(q.addons)) a
        left join inventory i on i.id = case when jsonb_typeof(a) = 'object' then a->>'id' else a #>> '{}' end
      ), 0) as amt,
      q.card_amount, q.pay_method,
      coalesce((
        select sum(coalesce((p->>'qty')::numeric, 0) * coalesce((p->>'price')::numeric, 0))
        from jsonb_array_elements(_mt_json(q.purchases)) p
        where jsonb_typeof(p) = 'object' and p->>'pay' = 'paid' and coalesce(p->>'cat', '') <> '__cardmeta__'
          and (p->>'qty') ~ '^-?[0-9]+(\.[0-9]+)?$' and (p->>'price') ~ '^-?[0-9]+(\.[0-9]+)?$'
      ), 0) as purch,
      coalesce((
        select sum(coalesce((p->>'qty')::numeric, 0) * coalesce((p->>'price')::numeric, 0))
        from jsonb_array_elements(_mt_json(q.purchases)) p
        where jsonb_typeof(p) = 'object' and p->>'pay' = 'paid' and p->>'method' = 'card' and coalesce(p->>'cat', '') <> '__cardmeta__'
          and (p->>'qty') ~ '^-?[0-9]+(\.[0-9]+)?$' and (p->>'price') ~ '^-?[0-9]+(\.[0-9]+)?$'
      ), 0) as purch_card
    from queue_entries q
    join s on s.id = q.session_id
  ),
  qb as (
    select qa.*,
      case when paid and status not in ('cancelled', 'removed')
        then case when card_amount is not null then least(greatest(card_amount, 0), amt)
                  when pay_method = 'card' then amt else 0 end
        else 0 end as card,
      case when paid and status not in ('cancelled', 'removed') and pay_method is distinct from 'transfer'
        then case when card_amount is not null then amt - least(greatest(card_amount, 0), amt)
                  when pay_method = 'cash' then amt else 0 end
        else 0 end as cash
    from qa
  ),
  qt as (
    select coalesce(m, 'total') as m,
      count(distinct session_id) filter (where status = 'done')::int as sessions_held,
      count(*) filter (where status in ('waiting', 'active', 'done', 'noshow'))::int as bookings,
      count(*) filter (where status = 'done')::int as rides,
      count(distinct customer_id) filter (where status = 'done')::int as riders,
      count(*) filter (where status = 'noshow')::int as noshows,
      count(*) filter (where status = 'cancelled')::int as cancellations,
      coalesce(sum(amt) filter (where paid and status not in ('cancelled', 'removed') and pay_method is distinct from 'transfer'), 0) as rev_rides,
      coalesce(sum(card), 0) as rev_card,
      coalesce(sum(cash), 0) as rev_cash,
      coalesce(sum(purch), 0) as purch,
      coalesce(sum(purch_card), 0) as purch_card,
      coalesce(sum(amt) filter (where status = 'done' and not paid), 0) as pending
    from qb
    group by grouping sets ((m), ())
  ),
  st as (
    select coalesce(m, 'total') as m, sum(cap)::int as seats from s group by grouping sets ((m), ())
  ),
  cs as (
    select coalesce(s.m, left(k.d, 7)) as m, c.receipt_id, c.id, c.category, c.pay,
      coalesce(c.qty, 0) as qty, coalesce(c.price, 0) as price
    from cashier_sales c
    cross join lateral (
      select case when c.created_at ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?(Z|[+-]([01]\d|2[0-3])(:?[0-5]\d)?)?$'
                  then to_char(c.created_at::timestamptz at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
                  else left(c.created_at, 10) end as d
    ) k
    left join s on s.id = c.session_id
    where c.voided_at is null
      and (s.id is not null
           or (c.session_id is null and k.d between to_char(p_from, 'YYYY-MM-DD') and to_char(p_to, 'YYYY-MM-DD')))
  ),
  rf as (
    select distinct coalesce(receipt_id, id) as k from cs where pay = 'refunded'
  ),
  ct as (
    select coalesce(cs.m, 'total') as m,
      coalesce(sum(cs.qty * cs.price) filter (where cs.pay = 'paid' and cs.category is distinct from '__cardmeta__' and cs.qty <> 0), 0) as sales,
      coalesce(sum(cs.price) filter (where cs.category = '__cardmeta__' and rf.k is null), 0) as card
    from cs
    left join rf on rf.k = coalesce(cs.receipt_id, cs.id)
    group by grouping sets ((cs.m), ())
  ),
  months as (
    select m from st union select m from qt union select m from ct
  )
  select mo.m,
    coalesce(qt.sessions_held, 0), coalesce(st.seats, 0), coalesce(qt.bookings, 0), coalesce(qt.rides, 0),
    coalesce(qt.riders, 0), coalesce(qt.noshows, 0), coalesce(qt.cancellations, 0),
    round(coalesce(qt.rev_rides, 0), 2), round(coalesce(qt.rev_card, 0), 2),
    round(coalesce(qt.rev_cash, 0), 2),
    round(coalesce(ct.sales, 0) + coalesce(qt.purch, 0), 2),
    round(least(coalesce(ct.card, 0), coalesce(ct.sales, 0)) + coalesce(qt.purch_card, 0), 2),
    round(coalesce(ct.sales, 0) + coalesce(qt.purch, 0) - least(coalesce(ct.card, 0), coalesce(ct.sales, 0)) - coalesce(qt.purch_card, 0), 2),
    round(coalesce(qt.pending, 0), 2)
  from months mo
  left join qt on qt.m = mo.m
  left join st on st.m = mo.m
  left join ct on ct.m = mo.m
  where mo.m is not null
  order by (mo.m = 'total'), mo.m;
$fn$;
revoke all on function public._mt_core(date, date) from public, anon, authenticated;

-- ── 3. _report_snapshot_data: the close-out's shop sales by the Riyadh day ─────────────────────
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
       or (c.session_id is null
           and (case when c.created_at ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?(Z|[+-]([01]\d|2[0-3])(:?[0-5]\d)?)?$'
                     then to_char(c.created_at::timestamptz at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
                     else left(c.created_at, 10) end) between d1 and d2);
    return jsonb_build_object('totals', coalesce(v_tot, '{}'::jsonb), 'sessions', v_sess, 'till', v_till);
  end if;
  select to_jsonb(t) - 'month' into v_prev from _mt_core(p_from - v_len, p_from - 1) t where t.month = 'total';
  select to_jsonb(t) - 'month' into v_ly from _mt_core((p_from - interval '1 year')::date, (p_to - interval '1 year')::date) t where t.month = 'total';
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
declare f regprocedure;
begin
  foreach f in array array['public._rider_reg_follow_booking()'::regprocedure, 'public._mt_core(date, date)'::regprocedure,
                           'public._report_snapshot_data(text, date, date)'::regprocedure] loop
    if not exists (select 1 from pg_proc p where p.oid = f and p.prosecdef and 'search_path=public' = any(coalesce(p.proconfig, '{}'))) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is open to the wrong roles', f;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.queue_entries'::regclass and tgname = 'queue_entries_rider_sync'
                   and tgfoid = 'public._rider_reg_follow_booking()'::regprocedure and tgenabled <> 'D') then
    raise exception 'queue_entries_rider_sync is missing';
  end if;
  if position('when pay_method = ''cash'' then amt' in (select prosrc from pg_proc where oid = 'public._mt_core(date, date)'::regprocedure)) = 0
     or position('is distinct from ''transfer''' in (select prosrc from pg_proc where oid = 'public._mt_core(date, date)'::regprocedure)) = 0
     or position('Asia/Riyadh' in (select prosrc from pg_proc where oid = 'public._mt_core(date, date)'::regprocedure)) = 0 then
    raise exception '_mt_core is not the 20261028140000 definition';
  end if;
  if position('Asia/Riyadh' in (select prosrc from pg_proc where oid = 'public._report_snapshot_data(text, date, date)'::regprocedure)) = 0 then
    raise exception '_report_snapshot_data is not the 20261028140000 definition';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261028140000', 'staff_review_money')
on conflict (version) do nothing;

commit;

-- ── Check (read-only), after the commit ───────────────────────────────────────────────────────
-- 1. Every line ok = true.
select 'sync trigger on queue_entries' as what,
       exists (select 1 from pg_trigger where tgrelid = 'public.queue_entries'::regclass and tgname = 'queue_entries_rider_sync' and tgenabled <> 'D') as ok
union all
select 'rider sync is definer, closed to clients',
       (select p.prosecdef and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
          from pg_proc p where p.oid = 'public._rider_reg_follow_booking()'::regprocedure)
union all
select 'bodies are this file''s',
       (select count(*) = 3 from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and (p.proname, md5(p.prosrc)) in (('_mt_core', 'db714184830a0ba73a1b6b2c1c9d5212'),
                                              ('_report_snapshot_data', '627d86db6bfa0dc319d4fbbdfd0cacf9'),
                                              ('_rider_reg_follow_booking', '6d98a377f1947e0c72c06a1102d95df1')))
union all
select 'months: card + cash never above the fares',
       not exists (select 1 from public._mt_core((current_date - 400), current_date) t where t.rev_card + t.rev_cash > t.rev_rides + 0.005)
union all
select 'months: sales split adds up',
       not exists (select 1 from public._mt_core((current_date - 400), current_date) t where abs(t.sales_card + t.sales_cash - t.rev_sales) > 0.005);
-- 2. What the months now call "not recorded" (paid, no method), per month - the figure the page shows:
-- select month, rev_rides, rev_card, rev_cash, rev_rides - rev_card - rev_cash as not_recorded
--   from public._mt_core((current_date - 400), current_date) order by month;
-- 3. Petromin registrations whose booking is done but which carry no return (none after this trigger; the
--    older ones are what the Billing dialog's "Return them" settles, period by period):
select s.session_date, r.booking_no, r.name, r.company, r.checked_in_at, r.checked_out_at
  from public.rider_registrations r
  join public.queue_entries q on q.id = r.matched_entry_id
  left join public.sessions s on s.id = r.session_id
 where q.status = 'done' and r.checked_out_at is null
 order by s.session_date desc, r.booking_no;
