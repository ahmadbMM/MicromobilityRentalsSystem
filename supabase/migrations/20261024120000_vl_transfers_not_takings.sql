-- ============================================================================
-- A Victory Lap transfer is the organiser's money, not ours (2026-10-24).
--
-- customer_vl_ticket (20261023160000) marks an athlete's booking paid with pay_method 'transfer' when
-- they upload the receipt of a bank transfer to the race's organiser. The place is settled, but the money
-- never reaches MicroMobility, and _mt_core counted it in rev_rides and, as it is not card, in rev_cash:
-- Analytics' months, the scheduled snapshots (20261009181000) and the weekly revenue by day
-- (20261009207000) would have shown the race's tickets as fares taken in cash. rev_rides now leaves a
-- transfer out, as the app does (_paidToOrg); rev_card never held one (customer_vl_ticket clears
-- card_amount), so rev_cash = rev_rides - rev_card follows.
--
-- Everything else is 20261009180000's definition, unchanged: its body was read back from production on
-- 2026-10-24 (md5 d481d2bf84c75c86785aa937a042a3c8, 4434 characters) and matched the file. Same name,
-- arguments and result, so staff_monthly_totals and the report functions that read it keep working.
--
-- Rollback: run the _mt_core definition in 20261009180000_staff_monthly_totals.sql again.
-- ============================================================================

begin;
set local lock_timeout = '5s';

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
      ), 0) as purch
    from queue_entries q
    join s on s.id = q.session_id
  ),
  qb as (
    select qa.*,
      case when paid and status not in ('cancelled', 'removed')
        then case when card_amount is not null then least(greatest(card_amount, 0), amt)
                  when pay_method = 'card' then amt else 0 end
        else 0 end as card
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
      coalesce(sum(purch), 0) as purch,
      coalesce(sum(amt) filter (where status = 'done' and not paid), 0) as pending
    from qb
    group by grouping sets ((m), ())
  ),
  st as (
    select coalesce(m, 'total') as m, sum(cap)::int as seats from s group by grouping sets ((m), ())
  ),
  cs as (
    select coalesce(s.m, left(c.created_at, 7)) as m, c.receipt_id, c.id, c.category, c.pay,
      coalesce(c.qty, 0) as qty, coalesce(c.price, 0) as price
    from cashier_sales c
    left join s on s.id = c.session_id
    where c.voided_at is null
      and (s.id is not null
           or (c.session_id is null and left(c.created_at, 10) between to_char(p_from, 'YYYY-MM-DD') and to_char(p_to, 'YYYY-MM-DD')))
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
    round(coalesce(qt.rev_rides, 0) - coalesce(qt.rev_card, 0), 2),
    round(coalesce(ct.sales, 0) + coalesce(qt.purch, 0), 2),
    round(least(coalesce(ct.card, 0), coalesce(ct.sales, 0)), 2),
    round(coalesce(ct.sales, 0) + coalesce(qt.purch, 0) - least(coalesce(ct.card, 0), coalesce(ct.sales, 0)), 2),
    round(coalesce(qt.pending, 0), 2)
  from months mo
  left join qt on qt.m = mo.m
  left join st on st.m = mo.m
  left join ct on ct.m = mo.m
  where mo.m is not null
  order by (mo.m = 'total'), mo.m;
$fn$;
revoke all on function public._mt_core(date, date) from public, anon, authenticated;

do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public._mt_core(date, date)'::regprocedure
                   and p.prosecdef and 'search_path=public' = any(coalesce(p.proconfig, '{}'))) then
    raise exception '_mt_core lost SECURITY DEFINER or its search_path';
  end if;
  if has_function_privilege('anon', 'public._mt_core(date, date)', 'execute')
     or has_function_privilege('authenticated', 'public._mt_core(date, date)', 'execute') then
    raise exception '_mt_core is open to the wrong roles';
  end if;
  if position('is distinct from ''transfer''' in (select prosrc from pg_proc where oid = 'public._mt_core(date, date)'::regprocedure)) = 0 then
    raise exception '_mt_core still counts a transfer to the organiser';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261024120000', 'vl_transfers_not_takings')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
