-- ============================================================================
-- The wallet pays what it can, and the rider chooses (the owner, 2026-11-03: "allow wallet money to deduct from the
-- amount to pay no need for it to be equivalent or more than the amount"; "add a switch that is named wallet for the
-- customer in checking out and paying if he wants to use the wallet money or not").
--
--  1. queue_entries.wallet_paid: how much of this booking the wallet holds now. Only these functions move it: the
--     trigger puts back whatever a client writes. A booking the wallet covers whole is still paid, pay_method 'wallet'.
--     One it covers in part stays unpaid, and the desk takes the rest by any method.
--  2. zz_wallet_follow: everything goes back when the booking is cancelled, removed or deleted; when it is a no-show
--     not paid in full (a no-show paid in full keeps it, as a card payment does); when it goes from paid to unpaid;
--     when a wholly wallet-paid booking is marked another way; on the house. A lower price gives back what is over; a
--     higher one keeps what was paid and leaves the difference to pay, so nothing is taken unasked.
--  3. customer_wallet_pay and staff_wallet_pay_booking take what the balance can. customer_wallet_release is the rider
--     turning the switch off, while the booking is still waiting. staff_wallet_refund_booking also takes an unpaid
--     booking's part back.
--  4. _mt_core: card, cash and pending leave out the wallet's part; revenue keeps it once the booking is paid.
--
-- Rollback: back the money out first (update queue_entries set paid = false, pay_method = null where wallet_paid > 0),
-- re-run the function blocks of 20261102210000 and 20261103120000 and the _mt_core block of 20261028140000, then
-- drop function public.customer_wallet_release(text, text, text[]); drop function public._wallet_release(public.queue_entries);
-- drop function public._wallet_pay_row(public.queue_entries, numeric); alter table public.queue_entries drop column wallet_paid.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

alter table public.queue_entries add column if not exists wallet_paid numeric(10,2) not null default 0;
do $chk$ begin
  if not exists (select 1 from pg_constraint where conname = 'queue_entries_wallet_paid_ok') then
    alter table public.queue_entries add constraint queue_entries_wallet_paid_ok check (wallet_paid >= 0);
  end if;
end $chk$;

create or replace function public._wallet_follow()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare net numeric; who text; amt numeric; bid text;
begin
  if tg_op = 'INSERT' then
    new.wallet_paid := 0;
    if new.pay_method = 'wallet' then new.pay_method := null; new.paid := false; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if coalesce(old.wallet_paid, 0) = 0 and old.pay_method is distinct from 'wallet' then return old; end if;
  else
    -- _wallet_pay_row and _wallet_release have moved the money themselves; the price stays what it was
    if coalesce(current_setting('mm.wallet_ok', true), '') = '1' then new.price := old.price; return new; end if;
    new.wallet_paid := old.wallet_paid;
    if coalesce(old.wallet_paid, 0) = 0 and old.pay_method is distinct from 'wallet' and new.pay_method is distinct from 'wallet' then
      return new;  -- nearly every write to this table
    end if;
  end if;

  bid := case when tg_op = 'DELETE' then old.id else new.id end;
  select coalesce(-sum(l.amount), 0) into net from wallet_ledger l where l.booking_id = bid and l.kind in ('spend', 'return');
  select _wallet_owner(l.customer_id) into who from wallet_ledger l
   where l.booking_id = bid and l.kind = 'spend' order by l.id desc limit 1;

  if tg_op = 'DELETE' then
    if net > 0 then perform _wallet_post(who, net, 'return', null, null, old.id, null, old.session_id); end if;
    return old;
  end if;

  amt := _wallet_amount(new.price, new.addons);

  if coalesce(new.status, '') in ('cancelled', 'removed')
     or (new.status = 'noshow' and not coalesce(new.paid, false))
     or amt <= 0
     or (coalesce(old.paid, false) and not coalesce(new.paid, false))
     or (old.pay_method = 'wallet' and coalesce(new.paid, false) and new.pay_method is distinct from 'wallet') then
    if net > 0 then perform _wallet_post(who, net, 'return', null, null, new.id, null, new.session_id); end if;
    new.wallet_paid := 0;
    if new.pay_method = 'wallet' then
      new.pay_method := null;
      if amt > 0 then new.paid := false; end if;
    end if;
    return new;
  end if;

  if net > amt then
    perform _wallet_post(who, net - amt, 'return', null, null, new.id, null, new.session_id);
    net := amt;
  end if;

  if coalesce(new.paid, false) and new.pay_method = 'wallet' then
    new.card_amount := null;
    if net < amt then
      if coalesce(old.paid, false) and old.pay_method = 'wallet' then
        new.paid := false; new.pay_method := null;  -- it costs more now: what was paid stays, the rest is to pay
      else
        if new.customer_id is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
        perform _wallet_post(_wallet_owner(new.customer_id), net - amt, 'spend', null, null, new.id, null, new.session_id);
        net := amt;
      end if;
    end if;
  elsif net >= amt and not coalesce(new.paid, false) then
    new.paid := true; new.pay_method := 'wallet'; new.card_amount := null;  -- a lower price: the wallet now covers it
  end if;
  new.wallet_paid := net;
  return new;
end $$;
revoke execute on function public._wallet_follow() from public, anon, authenticated;

-- What the balance can pay of one booking, row locked by the caller. Nothing to take is a 0, not an error.
drop function if exists public._wallet_pay_row(public.queue_entries, numeric);
create or replace function public._wallet_pay_row(q public.queue_entries, p_amount numeric)
returns numeric
language plpgsql volatile security definer set search_path to 'public'
as $$
declare who text; net numeric := coalesce(q.wallet_paid, 0); due numeric; take numeric;
begin
  if coalesce(q.paid, false) then return 0; end if;
  due := p_amount - net;
  if due <= 0 then raise exception 'WALLET_NOTHING_DUE' using errcode = 'P0001'; end if;
  if q.customer_id is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
  if coalesce(q.status, '') in ('cancelled', 'removed') then raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001'; end if;
  if exists (select 1 from sessions s where s.id = q.session_id and coalesce(s.ride_kind, '') in ('vlap', 'arena')) then
    raise exception 'WALLET_RACE' using errcode = 'P0001';  -- the organiser's money
  end if;
  who := _wallet_owner(q.customer_id);
  select least(coalesce((select balance from wallet_balances where customer_id = who for update), 0), due) into take;
  if take <= 0 then return 0; end if;
  perform _wallet_post(who, -take, 'spend', null, null, q.id, null, q.session_id);
  perform set_config('mm.wallet_ok', '1', true);
  update queue_entries
     set wallet_paid = net + take,
         paid = (take = due),
         pay_method = case when take = due then 'wallet' else pay_method end,
         card_amount = case when take = due then null else card_amount end
   where id = q.id;
  perform set_config('mm.wallet_ok', '', true);
  return take;
end $$;
revoke execute on function public._wallet_pay_row(public.queue_entries, numeric) from public, anon, authenticated;

-- Gives back what the wallet holds of one booking, row locked by the caller.
create or replace function public._wallet_release(q public.queue_entries)
returns numeric
language plpgsql volatile security definer set search_path to 'public'
as $$
declare net numeric := coalesce(q.wallet_paid, 0); who text;
begin
  if net <= 0 then return 0; end if;
  if coalesce(q.paid, false) then
    update queue_entries set paid = false, pay_method = null, card_amount = null where id = q.id;  -- the trigger gives it back
    return net;
  end if;
  select _wallet_owner(l.customer_id) into who from wallet_ledger l
   where l.booking_id = q.id and l.kind = 'spend' order by l.id desc limit 1;
  perform _wallet_post(who, net, 'return', null, null, q.id, null, q.session_id);
  perform set_config('mm.wallet_ok', '1', true);
  update queue_entries set wallet_paid = 0 where id = q.id;
  perform set_config('mm.wallet_ok', '', true);
  return net;
end $$;
revoke execute on function public._wallet_release(public.queue_entries) from public, anon, authenticated;

create or replace function public.staff_wallet_pay_booking(p_booking_ids text[], p_op text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; bid text; total numeric := 0; took numeric; acct text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  perform set_config('mm.wallet_op', coalesce(p_op, ''), true);
  foreach bid in array (select coalesce(array_agg(x order by x), '{}') from unnest(p_booking_ids) x) loop
    select * into q from queue_entries where id = bid for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    acct := coalesce(acct, q.customer_id);
    if coalesce(q.paid, false) then continue; end if;
    took := _wallet_pay_row(q, _wallet_amount(q.price, q.addons));
    total := total + took;
  end loop;
  if total <= 0 then raise exception 'WALLET_SHORT' using errcode = 'P0001'; end if;
  return jsonb_build_object('ok', true, 'amount', total,
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'paid', e.paid, 'pay_method', e.pay_method, 'wallet_paid', e.wallet_paid)), '[]'::jsonb)
               from queue_entries e where e.id = any(p_booking_ids)),
    'balance', coalesce((select balance from wallet_balances where customer_id = _wallet_owner(acct)), 0));
end $$;
revoke all on function public.staff_wallet_pay_booking(text[], text) from public, anon;
grant execute on function public.staff_wallet_pay_booking(text[], text) to authenticated;

-- A paid booking: its money back into the wallet, card and cash as a refund, the wallet's part as a return. An unpaid
-- one that carries a part: that part back. The booking is left to pay; cancelling it is a separate act.
create or replace function public.staff_wallet_refund_booking(p_booking_id text, p_reason text default null,
                                                              p_op text default null, p_approval text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; amt numeric; real numeric; net numeric; b numeric; who text; card numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into q from queue_entries where id = p_booking_id for update;
  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  net := coalesce(q.wallet_paid, 0);
  if not coalesce(q.paid, false) and net <= 0 then raise exception 'WALLET_NOT_PAID' using errcode = 'P0001'; end if;
  if q.pay_method = 'transfer' then raise exception 'WALLET_RACE' using errcode = 'P0001'; end if;
  if q.customer_id is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
  amt := case when coalesce(q.paid, false) then _wallet_amount(q.price, q.addons) else net end;
  if amt <= 0 then raise exception 'WALLET_NOTHING_DUE' using errcode = 'P0001'; end if;
  if not _mgr_ok('refund', amt, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  perform set_config('mm.wallet_op', coalesce(p_op, ''), true);
  perform set_config('mm.wallet_note', coalesce(p_reason, ''), true);
  who := _wallet_owner(q.customer_id);
  if coalesce(q.paid, false) then
    real := amt - net;  -- what the desk took; the wallet's part goes back with the row below
    if real > 0 then
      card := case when q.card_amount is not null then least(greatest(q.card_amount, 0), real)
                   when q.pay_method = 'card' then real when q.pay_method = 'cash' then 0 end;
      perform _wallet_post(who, real, 'refund', case when q.card_amount is not null then 'split' when q.pay_method in ('card', 'cash') then q.pay_method end,
                           card, q.id, null, q.session_id);
    end if;
    update queue_entries set paid = false, pay_method = null, card_amount = null where id = q.id;
  else
    perform _wallet_release(q);
  end if;
  perform set_config('mm.wallet_note', '', true);
  select balance into b from wallet_balances where customer_id = who;
  return jsonb_build_object('ok', true, 'id', q.id, 'amount', amt, 'balance', coalesce(b, 0));
end $$;
revoke all on function public.staff_wallet_refund_booking(text, text, text, text) from public, anon;
grant execute on function public.staff_wallet_refund_booking(text, text, text, text) to authenticated;

-- The rider's switch on: what the balance can pay of their own bookings, in order, whatever is left stays to pay.
create or replace function public.customer_wallet_pay(p_id text, p_token text, p_booking_ids text[])
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; bid text; total numeric := 0; took numeric; s sessions%rowtype;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if coalesce(array_length(p_booking_ids, 1), 0) = 0 or array_length(p_booking_ids, 1) > 20 then
    raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001';
  end if;
  foreach bid in array (select array_agg(x order by x) from unnest(p_booking_ids) x) loop
    select * into q from queue_entries where id = bid and customer_id = p_id for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if coalesce(q.paid, false) then continue; end if;
    select * into s from sessions where id = q.session_id;
    if coalesce(q.status, '') not in ('waiting', 'active') then raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001'; end if;
    if coalesce(s.ride_kind, '') = 'petromin' then raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001'; end if;
    if left(coalesce(s.session_date, q.session_id, ''), 10) < to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD') then
      raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001';
    end if;
    took := _wallet_pay_row(q, _wallet_amount(q.price, q.addons));
    total := total + took;
  end loop;
  return jsonb_build_object('ok', true, 'amount', total,
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'paid', e.paid, 'pay_method', e.pay_method, 'wallet_paid', e.wallet_paid)), '[]'::jsonb)
               from queue_entries e where e.id = any(p_booking_ids) and e.customer_id = p_id),
    'balance', coalesce((select balance from wallet_balances where customer_id = p_id), 0));
end $$;
revoke all on function public.customer_wallet_pay(text, text, text[]) from public;
grant execute on function public.customer_wallet_pay(text, text, text[]) to anon, authenticated;

-- The rider's switch off: the money back, while the place is still waiting. Not a booking the desk has taken money on.
create or replace function public.customer_wallet_release(p_id text, p_token text, p_booking_ids text[])
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; bid text; total numeric := 0;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if coalesce(array_length(p_booking_ids, 1), 0) = 0 or array_length(p_booking_ids, 1) > 20 then
    raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001';
  end if;
  foreach bid in array (select array_agg(x order by x) from unnest(p_booking_ids) x) loop
    select * into q from queue_entries where id = bid and customer_id = p_id for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if coalesce(q.wallet_paid, 0) <= 0 then continue; end if;
    if q.status is distinct from 'waiting' or (coalesce(q.paid, false) and q.pay_method is distinct from 'wallet') then
      raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001';
    end if;
    total := total + _wallet_release(q);
  end loop;
  return jsonb_build_object('ok', true, 'amount', total,
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'paid', e.paid, 'pay_method', e.pay_method, 'wallet_paid', e.wallet_paid)), '[]'::jsonb)
               from queue_entries e where e.id = any(p_booking_ids) and e.customer_id = p_id),
    'balance', coalesce((select balance from wallet_balances where customer_id = p_id), 0));
end $$;
revoke all on function public.customer_wallet_release(text, text, text[]) from public;
grant execute on function public.customer_wallet_release(text, text, text[]) to anon, authenticated;

-- ── _mt_core: card, cash and pending leave out what the wallet paid ─────────────────────────────
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
      q.card_amount, q.pay_method, coalesce(q.wallet_paid, 0) as wal,
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
        then case when card_amount is not null then least(greatest(card_amount, 0), amt - wal)
                  when pay_method = 'card' then amt - wal else 0 end
        else 0 end as card,
      case when paid and status not in ('cancelled', 'removed') and pay_method is distinct from 'transfer'
        then case when card_amount is not null then amt - wal - least(greatest(card_amount, 0), amt - wal)
                  when pay_method = 'cash' then amt - wal else 0 end
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
      coalesce(sum(amt - wal) filter (where status = 'done' and not paid), 0) as pending
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

insert into supabase_migrations.schema_migrations (version, name)
values ('20261103140000', 'wallet_part_pay')
on conflict (version) do nothing;

commit;
