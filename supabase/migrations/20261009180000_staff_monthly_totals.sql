-- Analytics past twelve months (staff app research 2026-10-09, M14).
--
-- The staff app computes Analytics in the browser from the twelve months it holds, so "All" was really
-- "Last 12 months" and nothing could be set against the same month a year earlier. These functions add
-- the bookings and the till up ON THE SERVER, one row per month, so the page can show any span of years
-- without downloading it.
--
-- _mt_json(text)                      a text column holding JSON (addons, purchases) as jsonb; '[]' when it
--                                     is empty or does not parse (a hand-edited row must not stop a report).
-- _mt_core(p_from date, p_to date)    the totals, one row per month ('YYYY-MM') of the session dates in
--                                     [p_from, p_to], plus a row 'total' for the whole span (its riders are
--                                     distinct over the span, not a sum of the months). No caller check: it
--                                     is revoked from every client role and read only by the two below and by
--                                     the scheduled reports (20261009181000).
-- staff_monthly_totals(p_from, p_to)  the same, for a signed-in staff account (is_staff()), else STAFF_ONLY.
--
-- The rules are the page's own (_bookingRevenue, _salesTotals, the close-out):
--   rides          bookings marked done              riders       distinct accounts among them
--   bookings       waiting / active / done / no-show (places taken), cancellations, no-shows
--   rev_rides      paid bookings still standing (not cancelled or removed): the fare (57.5 when the row has
--                  none) plus its add-ons at the price stored on the line, else the item's list price
--   rev_card       the card part of rev_rides (card_amount, else the whole amount when pay_method is card);
--                  rev_cash the rest
--   rev_sales      the till: cashier sales marked paid (discount lines reduce it), not voided or refunded,
--                  plus purchases added to a booking and marked paid; sales_card is what the receipts'
--                  card lines say, sales_cash the rest. A sale with no session counts on its own date.
--   pending        bookings ridden and not paid (their amount)
--   seats          capacity offered (12 where a session has none); sessions_held: sessions with a ride done
-- Deleted sessions are out, as on the page. Dates are the sessions' own KSA date strings.
--
-- Rollback: drop function public.staff_monthly_totals(date, date); drop function public._mt_core(date, date);
--           drop function public._mt_json(text);

begin;

create or replace function public._mt_json(p text)
returns jsonb
language plpgsql
immutable
set search_path to 'public'
as $fn$
declare j jsonb;
begin
  if p is null or btrim(p) = '' then return '[]'::jsonb; end if;
  j := p::jsonb;
  if jsonb_typeof(j) <> 'array' then return '[]'::jsonb; end if;
  return j;
exception when others then
  return '[]'::jsonb;
end
$fn$;
revoke all on function public._mt_json(text) from public, anon, authenticated;

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
      coalesce(sum(amt) filter (where paid and status not in ('cancelled', 'removed')), 0) as rev_rides,
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

create or replace function public.staff_monthly_totals(p_from date, p_to date)
returns table (
  month text, sessions_held int, seats int, bookings int, rides int, riders int, noshows int, cancellations int,
  rev_rides numeric, rev_card numeric, rev_cash numeric, rev_sales numeric, sales_card numeric, sales_cash numeric,
  pending numeric
)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  if not coalesce((select is_staff()), false) then
    raise exception 'STAFF_ONLY: staff only' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'BAD_RANGE: the span is empty' using errcode = '22023';
  end if;
  if p_to - p_from > 366 * 15 then
    raise exception 'BAD_RANGE: fifteen years at most' using errcode = '22023';
  end if;
  return query select * from _mt_core(p_from, p_to);
end
$fn$;
revoke all on function public.staff_monthly_totals(date, date) from public, anon;
grant execute on function public.staff_monthly_totals(date, date) to authenticated;

do $chk$
begin
  if not (select prosecdef from pg_proc where oid = 'public.staff_monthly_totals(date, date)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public._mt_core(date, date)'::regprocedure) then
    raise exception 'the monthly totals lost security definer';
  end if;
  if has_function_privilege('anon', 'public.staff_monthly_totals(date, date)', 'execute')
     or has_function_privilege('authenticated', 'public._mt_core(date, date)', 'execute') then
    raise exception 'the monthly totals are open to the wrong roles';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009180000', 'staff_monthly_totals')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
