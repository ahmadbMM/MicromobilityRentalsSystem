-- ============================================================================
-- The owner's answers of 2026-11-03: refunding into a wallet and taking money out are an admin's alone (adding already
-- was); a wallet can pay at the Sales till. Balances do not expire; the no-show rule and the refused kinds stay.
--
--  1. staff_wallet_change and staff_wallet_refund_booking and _receipt refuse anyone but an admin (ADMIN_ONLY). Undoing a
--     pay-from-wallet just made is not a refund of money taken, so any staffer may: staff_wallet_undo_pay.
--  2. A sale paid from a wallet carries a qty-0 line category '__cardmeta__', pay 'wallet', id 'wal-<receipt>', price the
--     amount, beside the card line: every screen already leaves those out of what was sold. staff_wallet_pay_sale writes it
--     and takes the money (what the balance can); nothing else may write such a line. Ledger kinds 'sale' and 'sale_back'.
--  3. The line refunded, voided or deleted gives the money back (wallet_sale_follow), whichever way the receipt goes.
--     staff_wallet_refund_receipt credits only what the desk took; the wallet's part comes back with the line.
--  4. _mt_core: the wallet's part of a sale is neither card nor cash. _report_snapshot_data sums qty x price: unaffected.
--
-- Rollback: refund the receipts holding 'wal-' lines first; drop the triggers wallet_sale_guard and wallet_sale_follow; drop
-- function public.staff_wallet_unpay_sale(text), public.staff_wallet_pay_sale(text, text, text, numeric, text, text, text),
-- public.staff_wallet_undo_pay(text), public._wallet_sale_follow(), public._wallet_sale_guard(); re-run the function
-- blocks of 20261103120000 and 20261103140000. Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

alter table public.wallet_ledger drop constraint if exists wallet_ledger_kind_check;
alter table public.wallet_ledger add constraint wallet_ledger_kind_check
  check (kind in ('topup', 'adjust', 'takeout', 'refund', 'spend', 'return', 'merge_in', 'merge_out', 'unmerge', 'sale', 'sale_back'));

-- ── 1. An admin's alone ─────────────────────────────────────────────────────────────────────────
create or replace function public.staff_wallet_change(p_customer text, p_amount numeric, p_method text, p_note text,
                                                      p_session text default null, p_op text default null,
                                                      p_approval text default null, p_op_id uuid default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_uid uuid := auth.uid(); v_claimed int; v_prior jsonb; v_res jsonb; who text; amt numeric := round(p_amount, 2); b numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;  -- adding and taking out, the owner, 2026-11-03
  if amt is null or amt = 0 or abs(amt) > 10000 then raise exception 'WALLET_AMOUNT' using errcode = 'P0001'; end if;
  if p_method is null or p_method not in ('card', 'cash', 'transfer', 'none') then raise exception 'WALLET_METHOD' using errcode = 'P0001'; end if;
  if p_method = 'none' and nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'WALLET_NOTE' using errcode = 'P0001'; end if;
  if p_op_id is not null and v_uid is not null then
    insert into rpc_receipts (user_id, op_id, fn) values (v_uid, p_op_id, 'staff_wallet_change')
      on conflict do nothing returning 1 into v_claimed;
    if v_claimed is null then
      select result into v_prior from rpc_receipts where user_id = v_uid and op_id = p_op_id;
      return coalesce(v_prior, jsonb_build_object('ok', true)) || jsonb_build_object('replayed', true);
    end if;
  end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if not _mgr_ok('refund', abs(amt), p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  who := _wallet_owner(p_customer);
  if who is null or not exists (select 1 from customers where id = who) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform set_config('mm.wallet_op', coalesce(p_op, ''), true);
  perform set_config('mm.wallet_note', coalesce(p_note, ''), true);
  b := _wallet_post(who, amt, case when p_method = 'none' then 'adjust' when amt > 0 then 'topup' else 'takeout' end,
                    nullif(p_method, 'none'), null, null, null, nullif(btrim(coalesce(p_session, '')), ''));
  perform set_config('mm.wallet_note', '', true);
  v_res := jsonb_build_object('ok', true, 'customer_id', who, 'balance', b);
  if v_claimed is not null then
    update rpc_receipts set result = v_res where user_id = v_uid and op_id = p_op_id;
  end if;
  return v_res;
end $$;
revoke all on function public.staff_wallet_change(text, numeric, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.staff_wallet_change(text, numeric, text, text, text, text, text, uuid) to authenticated;

create or replace function public.staff_wallet_refund_booking(p_booking_id text, p_reason text default null,
                                                              p_op text default null, p_approval text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; amt numeric; real numeric; net numeric; b numeric; who text; card numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;  -- the owner, 2026-11-03
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

-- Undo of a pay-from-wallet: the wallet's part back, nothing the desk took.
create or replace function public.staff_wallet_undo_pay(p_booking_id text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; took numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into q from queue_entries where id = p_booking_id for update;
  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if coalesce(q.paid, false) and q.pay_method is distinct from 'wallet' then raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001'; end if;
  took := _wallet_release(q);
  return jsonb_build_object('ok', true, 'id', q.id, 'amount', took);
end $$;
revoke all on function public.staff_wallet_undo_pay(text) from public, anon;
grant execute on function public.staff_wallet_undo_pay(text) to authenticated;

create or replace function public.staff_wallet_refund_receipt(p_receipt_id text, p_reason text, p_op text,
                                                              p_approval text, p_op_id uuid default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare who text; took numeric; held numeric; card numeric; sess text; res jsonb; b numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;  -- the owner, 2026-11-03
  select _wallet_owner(max(c.customer_id)), max(c.session_id) into who, sess from cashier_sales c
   where coalesce(c.receipt_id, c.id) = p_receipt_id and c.customer_id is not null;
  if who is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
  select coalesce(sum(coalesce(c.qty, 0) * coalesce(c.price, 0)) filter (where c.pay = 'paid' and c.category is distinct from '__cardmeta__'), 0),
         coalesce(max(c.price) filter (where c.category = '__cardmeta__' and c.pay is distinct from 'wallet'), 0),
         coalesce(sum(c.price) filter (where c.category = '__cardmeta__' and c.pay = 'wallet'), 0)
    into took, card, held from cashier_sales c
   where coalesce(c.receipt_id, c.id) = p_receipt_id and c.refunded_at is null and c.voided_at is null;
  took := greatest(round(took - held, 2), 0);  -- what the desk took; the wallet's part comes back with its line
  res := staff_refund_receipt(p_receipt_id, p_reason, p_op, p_approval, p_op_id);
  if coalesce((res->>'replayed')::boolean, false) or coalesce((res->>'count')::int, 0) = 0 then return res; end if;
  if took > 0 then
    perform set_config('mm.wallet_op', coalesce(p_op, ''), true);
    perform set_config('mm.wallet_note', coalesce(p_reason, ''), true);
    card := least(greatest(card, 0), took);
    b := _wallet_post(who, took, 'refund', case when card = 0 then 'cash' when card = took then 'card' else 'split' end, card, null, p_receipt_id, sess);
    perform set_config('mm.wallet_note', '', true);
  end if;
  res := res || jsonb_build_object('wallet', took + held, 'balance',
           coalesce((select balance from wallet_balances where customer_id = who), 0));
  if p_op_id is not null then
    update rpc_receipts set result = res where user_id = auth.uid() and op_id = p_op_id;
  end if;
  return res;
end $$;
revoke all on function public.staff_wallet_refund_receipt(text, text, text, text, uuid) from public, anon;
grant execute on function public.staff_wallet_refund_receipt(text, text, text, text, uuid) to authenticated;

-- ── 2. A sale paid from a wallet ────────────────────────────────────────────────────────────────
-- Only staff_wallet_pay_sale writes a wallet line, and nothing changes its amount.
create or replace function public._wallet_sale_guard()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.pay is distinct from 'wallet' then return new; end if;
  if coalesce(current_setting('mm.wallet_ok', true), '') = '1' then return new; end if;
  if tg_op = 'UPDATE' and old.pay = 'wallet' and new.price = old.price and new.qty = old.qty then return new; end if;
  raise exception 'WALLET_LINE' using errcode = '42501';
end $$;
revoke execute on function public._wallet_sale_guard() from public, anon, authenticated;
drop trigger if exists wallet_sale_guard on public.cashier_sales;
create trigger wallet_sale_guard before insert or update on public.cashier_sales
  for each row execute function public._wallet_sale_guard();

-- The line refunded, voided or deleted: the money back, once.
create or replace function public._wallet_sale_follow()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare net numeric; who text; rid text;
begin
  if old.pay is distinct from 'wallet' or old.refunded_at is not null or old.voided_at is not null then return null; end if;
  if tg_op = 'UPDATE' and new.pay = 'wallet' and new.refunded_at is null and new.voided_at is null then return null; end if;
  rid := coalesce(old.receipt_id, old.id);
  select coalesce(-sum(l.amount), 0) into net from wallet_ledger l where l.receipt_id = rid and l.kind in ('sale', 'sale_back');
  if net <= 0 then return null; end if;
  select _wallet_owner(l.customer_id) into who from wallet_ledger l where l.receipt_id = rid and l.kind = 'sale' order by l.id desc limit 1;
  perform _wallet_post(who, net, 'sale_back', null, null, null, rid, old.session_id);
  return null;
end $$;
revoke execute on function public._wallet_sale_follow() from public, anon, authenticated;
drop trigger if exists wallet_sale_follow on public.cashier_sales;
create trigger wallet_sale_follow after update or delete on public.cashier_sales
  for each row execute function public._wallet_sale_follow();

-- What the balance can pay of a sale, before its lines are written: the desk records the rest as card or cash.
create or replace function public.staff_wallet_pay_sale(p_receipt_id text, p_customer text, p_session text, p_amount numeric,
                                                        p_name text default null, p_at text default null, p_op text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare who text; take numeric; b numeric; rid text := nullif(btrim(coalesce(p_receipt_id, '')), ''); line cashier_sales%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if rid is null or length(rid) > 64 then raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <= 0 or p_amount > 10000 then raise exception 'WALLET_AMOUNT' using errcode = 'P0001'; end if;
  select * into line from cashier_sales where id = 'wal-' || rid;
  if line.id is not null then  -- a retry of the same receipt
    return jsonb_build_object('ok', true, 'taken', line.price, 'row', to_jsonb(line), 'replayed', true);
  end if;
  who := _wallet_owner(p_customer);
  if who is null or not exists (select 1 from customers where id = who) then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
  select least(coalesce((select balance from wallet_balances where customer_id = who for update), 0), round(p_amount, 2)) into take;
  if take <= 0 then raise exception 'WALLET_SHORT' using errcode = 'P0001'; end if;
  perform set_config('mm.wallet_op', coalesce(p_op, ''), true);
  b := _wallet_post(who, -take, 'sale', null, null, null, rid, nullif(btrim(coalesce(p_session, '')), ''));
  perform set_config('mm.wallet_ok', '1', true);
  insert into cashier_sales (id, receipt_id, session_id, customer_name, item_id, name, category, qty, price, pay, team_name, created_at, sold_by_name)
  values ('wal-' || rid, rid, nullif(btrim(coalesce(p_session, '')), ''), left(p_name, 120), null, 'Wallet', '__cardmeta__', 0, take, 'wallet', null,
          coalesce(p_at, to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), left(nullif(btrim(coalesce(p_op, '')), ''), 60))
  returning * into line;
  perform set_config('mm.wallet_ok', '', true);
  return jsonb_build_object('ok', true, 'taken', take, 'balance', b, 'row', to_jsonb(line));
end $$;
revoke all on function public.staff_wallet_pay_sale(text, text, text, numeric, text, text, text) from public, anon;
grant execute on function public.staff_wallet_pay_sale(text, text, text, numeric, text, text, text) to authenticated;

-- The device could not store the sale it just took the money for: the money back. Not once the sale's lines are there.
create or replace function public.staff_wallet_unpay_sale(p_receipt_id text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if exists (select 1 from cashier_sales where receipt_id = p_receipt_id and id <> 'wal-' || p_receipt_id) then
    raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001';
  end if;
  delete from cashier_sales where id = 'wal-' || p_receipt_id;  -- wallet_sale_follow gives it back
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.staff_wallet_unpay_sale(text) from public, anon;
grant execute on function public.staff_wallet_unpay_sale(text) to authenticated;

-- ── 4. _mt_core: the wallet's part of a sale is neither card nor cash ───────────────────────────
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
      coalesce(sum(cs.price) filter (where cs.category = '__cardmeta__' and rf.k is null and cs.pay is distinct from 'wallet'), 0) as card,
      coalesce(sum(cs.price) filter (where cs.category = '__cardmeta__' and rf.k is null and cs.pay = 'wallet'), 0) as wal
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
    round(coalesce(ct.sales, 0) + coalesce(qt.purch, 0) - least(coalesce(ct.card, 0), coalesce(ct.sales, 0)) - coalesce(qt.purch_card, 0) - coalesce(ct.wal, 0), 2),
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
values ('20261103170000', 'wallet_admin_and_shop')
on conflict (version) do nothing;

commit;
