-- ============================================================================
-- Lockers: staff edit a reservation, move it to another evening, refund it, put it on the house, give it to another
-- account (the user, 2026-11-10: "allow staff to edit a locker reservation and reschedule it or refund it and other
-- options"). The owner's answers: refunds go to the customer's wallet, admins only (PIN, manager limit); staff may
-- change everything at any time, after the key too; a change that costs more or less is settled the way the locker
-- was paid; the other options are On the house, Change the person and a WhatsApp message (the page's).
--
-- staff_locker_edit(rental, day, period, code, name, customer, op, approval): the evening, the time, the locker, the
--   name and the account, under both evenings' locks. A moved locker waits for its key on the new evening; its locker
--   goes along when it is free there. Money, when the fee changes: a wallet payment is re-taken at the new fee (on a
--   Petromin night or with the wallet short, it is paid at the desk instead); unpaid, the price follows (on a ride's
--   bill the bill changes); paid otherwise (a paid ride's bill, the till, a card), the price paid stays and the
--   difference is settled apart - more is due at the till ('due', the page puts it in the Sales cart, linked), less is
--   given back to the wallet by an admin in the same call (on a ride's bill the bill drops by it; at the till the lines
--   are refunded and the new fee taken from the wallet), and a card is refunded in Payments.
-- staff_locker_refund(rental, keep, reason, op, approval): admins: what was taken for the locker goes to the wallet -
--   its wallet receipt refunded (its wallet part comes back by _wallet_sale_follow), its till lines refunded and their
--   money posted, or its fee off a paid ride's bill (what the wallet had paid of the bill comes back by _wallet_follow,
--   the rest is posted). Keep = the locker stays, free (on the house); else it is cancelled. A card: PAID_ONLINE.
-- staff_locker_house(rental, on, op, approval): free a locker nobody has paid for yet (operator PIN); off again puts the
--   fee back. A paid one is refunded with keep (admins).
-- staff_locker_paid(links): the Sales till names the locker lines it rang up ({r: rental, l: line id}): the rental knows
--   its till lines (till_lines), so a refund finds them and a change knows what was paid.
--
-- Rollback: drop function staff_locker_edit, staff_locker_refund, staff_locker_house, staff_locker_paid, _lk_paid;
--   alter table locker_rentals drop column house, till_lines, refunded, refunded_at, refunded_by.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

alter table public.locker_rentals
  add column if not exists house boolean not null default false,
  add column if not exists till_lines text[] not null default '{}',
  add column if not exists refunded numeric not null default 0,
  add column if not exists refunded_at timestamptz,
  add column if not exists refunded_by text;
do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'locker_rentals_refunded_by_check') then
    alter table public.locker_rentals add constraint locker_rentals_refunded_by_check check (refunded_by is null or length(refunded_by) <= 60);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'locker_rentals_till_lines_check') then
    alter table public.locker_rentals add constraint locker_rentals_till_lines_check check (coalesce(array_length(till_lines, 1), 0) <= 20);
  end if;
end $c$;

-- ── What has been taken for a rental and not given back ──────────────────────────────────────
-- A paid ride's bill (the fee is on it), its own wallet receipt (or a card's, on a database that takes cards), and the
-- till lines rung up for it.
create or replace function public._lk_paid(p_rental uuid)
returns numeric
language plpgsql stable security definer set search_path to 'public'
as $$
declare r locker_rentals%rowtype; v numeric := 0;
begin
  select * into r from locker_rentals where id = p_rental;
  if r.id is null or r.status = 'cancelled' then return 0; end if;
  if r.on_bill and r.booking_id is not null
     and exists (select 1 from queue_entries e where e.id = r.booking_id and coalesce(e.paid, false)) then
    v := v + r.price;
  end if;
  if r.receipt_id is not null and (coalesce(r.pay, '') = 'card'
       or exists (select 1 from cashier_sales c where c.id = r.receipt_id and c.voided_at is null and c.refunded_at is null)) then
    v := v + r.price;
  end if;
  v := v + coalesce((select sum(coalesce(c.qty, 0) * coalesce(c.price, 0)) from cashier_sales c
                      where c.id = any(r.till_lines) and c.pay = 'paid' and c.voided_at is null and c.refunded_at is null), 0);
  return round(v, 2);
end $$;
revoke execute on function public._lk_paid(uuid) from public, anon, authenticated;

-- ── The till names the locker lines it rang up ──────────────────────────────────────────────
create or replace function public.staff_locker_paid(p_links jsonb)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare x jsonb; rid uuid; line text; n int := 0;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  for x in select value from jsonb_array_elements(case when jsonb_typeof(p_links) = 'array' then p_links else '[]'::jsonb end) loop
    begin rid := (x ->> 'r')::uuid; exception when invalid_text_representation then continue; end;
    line := left(nullif(btrim(coalesce(x ->> 'l', '')), ''), 64);
    if rid is null or line is null then continue; end if;
    -- a line is one rental's (never linked twice), and a rental keeps at most twenty
    if exists (select 1 from locker_rentals y where line = any(y.till_lines)) then continue; end if;
    update locker_rentals set till_lines = array_append(till_lines, line),
           pay = case when pay is null and not on_bill then 'desk' else pay end
     where id = rid and status <> 'cancelled' and coalesce(array_length(till_lines, 1), 0) < 20;
    if found then n := n + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'linked', n);
end $$;
revoke execute on function public.staff_locker_paid(jsonb) from public, anon;
grant execute on function public.staff_locker_paid(jsonb) to authenticated;

-- ── A refund's money (inside the two staff calls below; the caller holds the evening's lock) ──
-- Gives what was taken for the rental to the wallet, by the way it was taken. Returns what was given.
-- p_drop: the rental's price on a ride's bill drops to this (the fee leaves the bill: its wallet part comes back by
-- _wallet_follow, the rest is posted here). p_retake: after refunding the till lines, take this new fee from the
-- wallet as the locker's own receipt (a cheaper change on a locker paid at the till).
create or replace function public._lk_give_back(p_rental uuid, p_who text, p_why text, p_drop numeric, p_retake numeric)
returns numeric
language plpgsql volatile security definer set search_path to 'public'
as $$
declare r locker_rentals%rowtype; q queue_entries%rowtype; who text; took numeric := 0; card numeric := 0; gave numeric := 0;
        net_b numeric; net_a numeric; part numeric; rcpt text;
begin
  select * into r from locker_rentals where id = p_rental for update;
  who := _wallet_owner(coalesce(r.customer_id, (select e.customer_id from queue_entries e where e.id = r.booking_id)));
  if who is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
  perform set_config('mm.wallet_note', left(coalesce(p_why, ''), 300), true);
  -- its own wallet receipt: refunded; the wallet's part comes back by _wallet_sale_follow
  if r.receipt_id is not null and coalesce(r.pay, '') = 'wallet' and p_drop is null and p_retake is null
     and exists (select 1 from cashier_sales c where c.id = r.receipt_id and c.voided_at is null and c.refunded_at is null) then
    update cashier_sales set pay = 'refunded', refunded_at = now(), refunded_by = left(coalesce(p_who, ''), 40),
           refund_reason = left(coalesce(p_why, ''), 300)
     where receipt_id = r.receipt_id and refunded_at is null and voided_at is null and pay is distinct from 'refunded';
    gave := gave + r.price;
  end if;
  -- its till lines: refunded, their money posted to the wallet (cash or card as the receipts say)
  if p_drop is null then
    select coalesce(sum(coalesce(c.qty, 0) * coalesce(c.price, 0)), 0), min(c.receipt_id) into took, rcpt from cashier_sales c
     where c.id = any(r.till_lines) and c.pay = 'paid' and c.voided_at is null and c.refunded_at is null;
    if took > 0 then
      select least(coalesce(sum(m.price), 0), took) into card from cashier_sales m
       where m.category = '__cardmeta__' and m.pay is distinct from 'wallet' and m.voided_at is null and m.refunded_at is null
         and m.receipt_id in (select c.receipt_id from cashier_sales c where c.id = any(r.till_lines));
      update cashier_sales set pay = 'refunded', refunded_at = now(), refunded_by = left(coalesce(p_who, ''), 40),
             refund_reason = left(coalesce(p_why, ''), 300)
       where id = any(r.till_lines) and pay = 'paid' and voided_at is null and refunded_at is null;
      perform _wallet_post(who, took, 'refund', case when card <= 0 then 'cash' when card >= took then 'card' else 'split' end,
                           greatest(card, 0), null, rcpt, r.session_id);
      gave := gave + took;
    end if;
    if p_retake is not null and p_retake > 0 then
      update locker_rentals set receipt_id = null, pay = 'wallet', price = p_retake where id = r.id;
      perform _lk_wallet_sale(r.id);
      gave := gave - p_retake;
    end if;
  end if;
  -- its fee on a paid ride's bill: the bill drops; what the wallet paid of it comes back by _wallet_follow
  if p_drop is not null and r.on_bill and r.booking_id is not null then
    select * into q from queue_entries where id = r.booking_id;
    if coalesce(q.paid, false) and r.price > p_drop then
      select coalesce(-sum(l.amount), 0) into net_b from wallet_ledger l where l.booking_id = q.id and l.kind in ('spend', 'return');
      update locker_rentals set price = p_drop where id = r.id;
      select coalesce(-sum(l.amount), 0) into net_a from wallet_ledger l where l.booking_id = q.id and l.kind in ('spend', 'return');
      part := round((r.price - p_drop) - greatest(net_b - net_a, 0), 2);
      if part > 0 then
        perform _wallet_post(who, part, 'refund', case when q.pay_method in ('card', 'cash') then q.pay_method end,
                             case when q.pay_method = 'card' then part when q.pay_method = 'cash' then 0 end, q.id, null, q.session_id);
      end if;
      gave := gave + (r.price - p_drop);
    end if;
  end if;
  perform set_config('mm.wallet_note', '', true);
  return round(gave, 2);
end $$;
revoke execute on function public._lk_give_back(uuid, text, text, numeric, numeric) from public, anon, authenticated;

-- ── Refund (admins) ─────────────────────────────────────────────────────────────────────────
create or replace function public.staff_locker_refund(p_rental uuid, p_keep boolean, p_reason text, p_op text, p_approval text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare r locker_rentals%rowtype; paid numeric; gave numeric; why text; b numeric; who text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;  -- the owner, 2026-11-10: refunds go to the wallet, admins only
  if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into r from locker_rentals where id = p_rental;
  if r.id is null then raise exception 'NOT_FOUND: no such rental' using errcode = 'P0002'; end if;
  perform _lk_lock(r.day);
  select * into r from locker_rentals where id = p_rental for update;
  if r.status = 'cancelled' then raise exception 'LOCKER_NOT_OPEN: already cancelled' using errcode = 'P0001'; end if;
  if (coalesce(r.pay, '') = 'card' and r.receipt_id is not null)
     or (r.on_bill and exists (select 1 from queue_entries e where e.id = r.booking_id and coalesce(e.paid, false) and e.pay_method = 'online')) then
    raise exception 'PAID_ONLINE' using errcode = 'P0001';  -- a card is refunded in Payments, to the card
  end if;
  paid := _lk_paid(r.id);
  if paid <= 0 then raise exception 'LOCKER_NOT_PAID' using errcode = 'P0001'; end if;
  if not _mgr_ok('refund', paid, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  why := left(coalesce(nullif(btrim(p_reason), ''), 'locker refund'), 300);
  perform set_config('mm.wallet_op', left(coalesce(p_op, ''), 40), true);
  gave := _lk_give_back(r.id, left(coalesce(p_op, _lk_who()), 40), why, null, null);
  if r.on_bill and r.booking_id is not null and exists (select 1 from queue_entries e where e.id = r.booking_id and coalesce(e.paid, false)) then
    gave := gave + _lk_give_back(r.id, left(coalesce(p_op, _lk_who()), 40), why, 0, null);
  end if;
  perform set_config('mm.wallet_op', '', true);
  if coalesce(p_keep, false) then
    update locker_rentals set price = 0, house = true, refunded = refunded + gave, refunded_at = now(), refunded_by = _lk_who() where id = r.id;
  else
    update locker_rentals set status = 'cancelled', cancelled_at = now(), cancelled_by = _lk_who(),
           cancel_reason = left('refunded: ' || why, 120), refunded = refunded + gave, refunded_at = now(), refunded_by = _lk_who()
     where id = r.id;
  end if;
  who := _wallet_owner(coalesce(r.customer_id, (select e.customer_id from queue_entries e where e.id = r.booking_id)));
  select balance into b from wallet_balances where customer_id = who;
  return jsonb_build_object('ok', true, 'id', r.id, 'amount', gave, 'balance', coalesce(b, 0), 'kept', coalesce(p_keep, false),
                            'booking_id', r.booking_id, 'addons', (select e.addons from queue_entries e where e.id = r.booking_id));
end $$;
revoke execute on function public.staff_locker_refund(uuid, boolean, text, text, text) from public, anon;
grant execute on function public.staff_locker_refund(uuid, boolean, text, text, text) to authenticated;

-- ── On the house (unpaid lockers; a paid one is refunded with keep) ─────────────────────────
create or replace function public.staff_locker_house(p_rental uuid, p_on boolean, p_op text, p_approval text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare r locker_rentals%rowtype;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into r from locker_rentals where id = p_rental;
  if r.id is null then raise exception 'NOT_FOUND: no such rental' using errcode = 'P0002'; end if;
  perform _lk_lock(r.day);
  select * into r from locker_rentals where id = p_rental for update;
  if r.status = 'cancelled' then raise exception 'LOCKER_NOT_OPEN: already cancelled' using errcode = 'P0001'; end if;
  if coalesce(p_on, true) then
    if _lk_paid(r.id) > 0 then raise exception 'LOCKER_PAID: refund it to make it free' using errcode = 'P0001'; end if;
    if r.receipt_id is not null then perform _lk_unpay(r.id, _lk_who()); end if;  -- a voided payment: nothing was taken
    update locker_rentals set price = 0, house = true, receipt_id = null where id = r.id;
  else
    if not r.house then return jsonb_build_object('ok', true, 'id', r.id); end if;
    if r.refunded > 0 then raise exception 'LOCKER_REFUNDED: its money went back; rent it again' using errcode = 'P0001'; end if;
    update locker_rentals set price = _lk_price(r.period), house = false where id = r.id;
  end if;
  return jsonb_build_object('ok', true, 'id', r.id, 'price', (select x.price from locker_rentals x where x.id = r.id),
                            'booking_id', r.booking_id, 'addons', (select e.addons from queue_entries e where e.id = r.booking_id));
end $$;
revoke execute on function public.staff_locker_house(uuid, boolean, text, text) from public, anon;
grant execute on function public.staff_locker_house(uuid, boolean, text, text) to authenticated;

-- ── Edit: the evening, the time, the locker, the name, the account ──────────────────────────
-- p_day / p_period null: kept. p_code null: kept when still free there (else none); '' : none; a number: that locker.
-- p_customer null: kept (a ride's locker is its rider's: LOCKER_ON_BOOKING for another account).
create or replace function public.staff_locker_edit(p_rental uuid, p_day date, p_period text, p_code text, p_name text,
                                                    p_customer text, p_op text, p_approval text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare r locker_rentals%rowtype; d date; per text; k text; sid text; c text; lk lockers%rowtype; fee numeric; paid numeric;
        cap int; s text; nm text; cust text; st text; due numeric := 0; back numeric := 0; newprice numeric; holder text;
        bill_paid boolean := false;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into r from locker_rentals where id = p_rental;
  if r.id is null then raise exception 'NOT_FOUND: no such rental' using errcode = 'P0002'; end if;
  d := coalesce(p_day, r.day);
  per := coalesce(nullif(btrim(coalesce(p_period, '')), ''), r.period);
  -- both evenings' locks, the earlier first, so two phones never wait on each other
  perform _lk_lock(least(r.day, d));
  if d <> r.day then perform _lk_lock(greatest(r.day, d)); end if;
  select * into r from locker_rentals where id = p_rental for update;
  if r.status not in ('reserved', 'in_use') then raise exception 'LOCKER_NOT_OPEN: the rental is %', r.status using errcode = 'P0001'; end if;
  -- the evening and its kind
  if d <> r.day then
    select e.session_id, e.kind into sid, k from _lk_evening(d) e;
    if sid is null then raise exception 'LOCKER_NO_EVENING' using errcode = 'P0001'; end if;
    if _lk_ended(d, per) then raise exception 'LOCKER_ENDED' using errcode = 'P0001'; end if;
  else
    sid := r.session_id; k := coalesce(nullif(_lk_kind(r.session_id), ''), case when r.period = 'pm' then 'pm' else 'jcc' end);
  end if;
  if not _lk_period_ok(k, per) then raise exception 'LOCKER_PERIOD: %', per using errcode = 'P0001'; end if;
  -- the locker: kept when free there, none, or the one named
  if p_code is null then
    if r.locker_id is not null then select * into lk from lockers where id = r.locker_id; end if;
  elsif btrim(p_code) <> '' then
    c := _lk_code(p_code);
    select * into lk from lockers where code = c and status <> 'retired';
    if lk.id is null then raise exception 'LOCKER_UNKNOWN: %', c using errcode = 'P0002'; end if;
    if lk.status <> 'available' then raise exception 'LOCKER_OUT: %', c using errcode = 'P0001'; end if;
  end if;
  if lk.id is not null then
    select x.name into holder from locker_rentals x
     where x.locker_id = lk.id and x.day = d and x.id <> r.id and x.status in ('reserved', 'in_use') and _lk_slots(x.period) && _lk_slots(per)
     limit 1;
    if found then
      if p_code is null then lk := null;  -- its locker is someone else's there: it moves without a number
      else raise exception 'LOCKER_TAKEN: % is with %', lk.code, coalesce(holder, '?') using errcode = 'P0001'; end if;
    end if;
  end if;
  -- room in each slot the new evening and time take, this rental aside
  if d <> r.day or per <> r.period then
    select count(*) into cap from lockers where status = 'available';
    foreach s in array _lk_slots(per) loop
      if (select count(*) from locker_rentals x where x.day = d and x.id <> r.id and x.status in ('reserved', 'in_use')
            and s = any(_lk_slots(x.period))) >= cap then
        raise exception 'LOCKERS_FULL' using errcode = 'P0001';
      end if;
    end loop;
  end if;
  -- the account: a ride's locker stays its rider's
  cust := r.customer_id;
  if nullif(btrim(coalesce(p_customer, '')), '') is not null and p_customer is distinct from r.customer_id then
    if r.booking_id is not null then raise exception 'LOCKER_ON_BOOKING' using errcode = 'P0001'; end if;
    if not exists (select 1 from customers x where x.id = p_customer) then raise exception 'NOT_FOUND: no such account' using errcode = 'P0002'; end if;
    cust := p_customer;
  end if;
  nm := coalesce(nullif(left(btrim(coalesce(p_name, '')), 120), ''),
                 case when cust is distinct from r.customer_id then (select left(x.name, 120) from customers x where x.id = cust) end,
                 r.name);
  -- a locker moved to another evening waits for its key there; one without a number cannot be in use
  st := case when d <> r.day or lk.id is null then 'reserved' else r.status end;
  update locker_rentals set day = d, session_id = sid, period = per, locker_id = lk.id, status = st, name = nm, customer_id = cust,
         assigned_at = case when st = 'in_use' and lk.id is distinct from r.locker_id then now() when st = 'reserved' then null else assigned_at end,
         assigned_by = case when st = 'in_use' and lk.id is distinct from r.locker_id then _lk_who() when st = 'reserved' then null else assigned_by end
   where id = r.id;
  -- the money: only when the fee changes
  fee := case when r.house then 0 else _lk_price(per) end;
  paid := _lk_paid(r.id);
  bill_paid := r.on_bill and r.booking_id is not null and exists (select 1 from queue_entries e where e.id = r.booking_id and coalesce(e.paid, false));
  if coalesce(r.pay, '') = 'wallet' and r.receipt_id is not null and paid > 0 then
    -- the wallet paid: re-taken at the new fee; a Petromin night or a short wallet pays at the desk instead
    if (k = 'pm' and d <> r.day) or fee <> r.price then
      perform _lk_unpay(r.id, _lk_who());
      update locker_rentals set receipt_id = null, price = fee where id = r.id;
      if k = 'pm' or fee <= 0 then
        update locker_rentals set pay = 'desk' where id = r.id;
        due := fee;
      else
        begin
          perform _lk_wallet_sale(r.id);
        exception when raise_exception then
          if sqlerrm not like 'WALLET_SHORT%' then raise; end if;
          update locker_rentals set pay = 'desk' where id = r.id;
          due := fee;
        end;
      end if;
    else
      update cashier_sales set name = left('Locker ' || coalesce(lk.code, '') || ' · ' || case per when 'early' then '6-8 PM' when 'late' then '9-11 PM'
                                                                                     when 'both' then '6-11 PM' else '7-9 PM' end, 120)
       where id = r.receipt_id;  -- the receipt's line says the locker it now is
    end if;
  elsif paid <= 0 then
    newprice := fee;  -- nothing paid yet: the price follows (on a ride's bill the bill changes)
    if newprice <> r.price then update locker_rentals set price = newprice where id = r.id; end if;
  elsif fee > paid then
    if not bill_paid then update locker_rentals set price = fee where id = r.id; end if;  -- a paid bill keeps its line
    due := fee - paid;  -- rung up at the till (the page puts it in the Sales cart, linked to this rental)
  elsif fee < paid then
    back := paid - fee;
    if (coalesce(r.pay, '') = 'card' and r.receipt_id is not null)
       or (bill_paid and exists (select 1 from queue_entries e where e.id = r.booking_id and e.pay_method = 'online')) then
      raise exception 'PAID_ONLINE' using errcode = 'P0001';
    end if;
    if not is_admin() then raise exception 'ADMIN_REFUND: %', back using errcode = '42501'; end if;  -- money back is an admin's (the owner)
    if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
    if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
    if not _mgr_ok('refund', back, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
    perform set_config('mm.wallet_op', left(coalesce(p_op, ''), 40), true);
    if bill_paid then
      perform _lk_give_back(r.id, left(coalesce(p_op, _lk_who()), 40), 'locker changed', greatest(r.price - back, 0), null);
    else
      perform _lk_give_back(r.id, left(coalesce(p_op, _lk_who()), 40), 'locker changed', null, fee);
    end if;
    perform set_config('mm.wallet_op', '', true);
    update locker_rentals set refunded = refunded + back, refunded_at = now(), refunded_by = _lk_who() where id = r.id;
  end if;
  select * into r from locker_rentals where id = p_rental;
  return jsonb_build_object('ok', true, 'id', r.id, 'day', r.day, 'period', r.period, 'status', r.status,
                            'code', (select l.code from lockers l where l.id = r.locker_id), 'price', r.price, 'pay', r.pay,
                            'due', round(due, 2), 'back', round(back, 2), 'left', _lk_left(r.day),
                            'booking_id', r.booking_id, 'addons', (select e.addons from queue_entries e where e.id = r.booking_id));
end $$;
revoke execute on function public.staff_locker_edit(uuid, date, text, text, text, text, text, text) from public, anon;
grant execute on function public.staff_locker_edit(uuid, date, text, text, text, text, text, text) to authenticated;

-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._lk_paid(uuid)', 'public._lk_give_back(uuid,text,text,numeric,numeric)',
                           'public.staff_locker_paid(jsonb)', 'public.staff_locker_refund(uuid,boolean,text,text,text)',
                           'public.staff_locker_house(uuid,boolean,text,text)',
                           'public.staff_locker_edit(uuid,date,text,text,text,text,text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
  end loop;
  foreach f in array array['public._lk_paid(uuid)', 'public._lk_give_back(uuid,text,text,numeric,numeric)'] loop
    if has_function_privilege('authenticated', f, 'execute') then raise exception '% is executable by a client', f; end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261110200000', 'locker_staff_edit')
on conflict (version) do nothing;

commit;
