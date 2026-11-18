-- ============================================================================
-- Bug hunt 2026-11-18 (bh18), package dbstg: online payments and the store. STAGING ONLY, like the files it follows
-- (20261110150000_online_payments, 20261110235200_bh10_payments, 20261110235500_bh10_payments_b,
-- 20261111235200_bh11_payments, 20261115235500_store_build): production has no payments or store yet, and this file
-- stops unless 20261115235500 is in the ledger. When payments and the store go live, this file goes to production
-- right after those.
--
-- sql02-3. _pay_apply (pay_settle, a card payment for lockers): a rental let go unpaid when its hold ran out came back
--    'reserved' when the late payment landed, checked only for another rental on the same locker, without the
--    evening's lock. It came back on a night called off (_lk_session_cancelled sweeps only 'reserved' rentals), after its
--    time was over, on a unit taken out of service, past the room left, or past 3 lockers per account for a time, and
--    no refund was queued. It now takes the evening's lock first (before the rental's row, the order every locker
--    function uses) and comes back only as customer_locker_book would take it: an evening still offering lockers for its
--    time, the time not over, the unit in service and free, room in the slots, at most 3 for the account; else the
--    card is refunded (pay_settle's own refund of what _pay_apply hands back).
-- sql08-1. pay_booking_cancel (the website's /api/pay/cancel): the refund was the booking's card_amount whatever the
--    payment still held, so after staff refunded that payment (staff_pay_refund_begin, which leaves the booking live)
--    the rider's cancel refunded it again in full: to the wallet at once, or as a second card refund. It now locks the
--    payment (before the booking, as pay_settle does, so a staff refund and the cancel take turns) and refunds no more
--    than is left of it, counted as staff_pay_refund_begin counts it (card refunds done or pending, wallet refunds
--    done); nothing left, nothing refunded or recorded. The answer's shape is unchanged.
-- sql11-4. staff_payments stopped at the newest 500 payments of the range with no sign, so the Payments tab's list and
--    figures came out short. It takes p_offset and p_limit now (1 to 1000, 500 by default; newest first, ties by id)
--    and the staff page reads pages until a short one. The old three-argument function is dropped in the same file;
--    the app's current call (three named arguments) reaches the new one with the defaults, unchanged.
--    CLIENT CHANGE NEEDED (app.src.html _payLoad): read pages of 500 with p_offset until one is shorter than 500.
-- sql11-1. staff_store_order_cancel gave back o.wallet_paid - kept to the wallet and never looked at what had already
--    gone back to it: after "Void cards and refund" (staff_store_order_gift_refund, which leaves the order open) the
--    cancel paid the wallet part a second time (150 by wallet, 30 of its card spent: 70 back, then 120 more). It now
--    counts the wallet's own lines of the order ('ord-' || no, sale and sale_back), as _store_gift_refund_plan and
--    staff_store_return_decide do, and gives back what is left of them less what stays kept.
-- sql11-2. _store_give_back (an order cancelled or let go unpaid) and staff_store_return_decide credited the order's
--    gift card part back onto the card without looking at it: a void card (its own order cancelled, voided and
--    refunded, voided by staff) or an expired one cannot be spent, so the money was lost while a 'back'/'refund' move
--    and an event said it was given back. A new inner function, _store_gift_return, locks the card and gives it back
--    onto the card while it is active and not expired; otherwise into the account's wallet (a 'sale_back' on the
--    order's receipt, as the order's other wallet refunds, and a gift card move of the new kind 'wallet', so the same
--    part is never given back twice); a guest's expired card still takes it (staff can move its expiry), and a guest's
--    void card takes nothing: the cancel goes on and a staff-only event says what is owed, while a return refuses that
--    part (it counts as nothing left to give back that way, PAY_TOO_MUCH, or STORE_GIFT_STATE in a race). The wallet's
--    room (_store_gift_refund_plan, staff_store_return_decide, staff_store_order_cancel) leaves out those 'wallet'
--    give-backs, and what a card bought by an order paid elsewhere stays "kept" for that order when the other order's
--    give-back went to the wallet (staff_store_order_cancel's kept still counts spend/back/refund only).
--    store_gift_card_moves.kind takes 'wallet' (the check constraint is widened; no row changes).
-- dbgrants-3. store_reviews: the one read policy was for anon and authenticated (status shown, or staff), and
--    authenticated has every column, so a signed-in account that is not staff (a Volunteer-role account, any Supabase
--    Auth user) read order_id and decided_by (a staffer's name) of every shown review. Two policies now: anon reads
--    shown reviews (its column grant is unchanged: no order, no name), authenticated reads only as staff (every
--    review, every column, as the staff Store tab reads it). The website reads reviews with the anon key.
--
-- Not changed here (see the package's report): form-lockers-0-3 and sql06-2 (customer_locker_change, customer_locker_drop,
-- customer_lockers) are production functions as well; the same bugs are in production's text, so they go to a migration
-- for both databases. sql06-1 (a locker on the house turned payable by the rider's change) was fixed in place on both
-- databases by 20261110235300_bh10_live_c.sql item 5.
--
-- Rebuilt from (the newest full text of each; no later file patches them in place):
--   _pay_apply                   20261115235500_store_build.sql
--   pay_booking_cancel           20261111235200_bh11_payments.sql
--   staff_payments               20261110150000_online_payments.sql (signature changed: old one dropped, grants redone)
--   _store_gift_refund_plan      20261115235500_store_build.sql
--   _store_give_back             20261115235500_store_build.sql
--   staff_store_order_cancel     20261115235500_store_build.sql
--   staff_store_return_decide    20261115235500_store_build.sql
--   _store_gift_return           new (inner, no client may run it)
-- Every function keeps SECURITY DEFINER, its search_path, volatility and language; grants are redone as the files
-- above had them. Idempotent (create or replace, drop ... if exists).
-- Rollback: run the blocks of the files above again for those functions; drop function _store_gift_return and
-- staff_payments(date,date,text,int,int), then the three-argument staff_payments from 20261110150000; put back the
-- one policy "store reviews shown read" (to anon, authenticated) and drop "store reviews staff read"; the 'wallet'
-- kind may stay in the check (or be taken out once no move has it).
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $pre$
begin
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261115235500') then
    raise exception '20261119000500 is for staging, after 20261115235500_store_build.sql (payments and the store): that file is not in the ledger here';
  end if;
end $pre$;

-- ── sql02-3 _pay_apply ──────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._pay_apply(p payments)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l jsonb; q queue_entries%rowtype; amt numeric; back numeric := 0; o store_orders%rowtype; i store_order_items%rowtype;
        r locker_rentals%rowtype; j workshop_jobs%rowtype; ok boolean; w numeric; due numeric; d date; ev record;
begin
  perform set_config('mm.pay_ok', '1', true);
  if p.kind = 'booking' then
    for l in select x from jsonb_array_elements(p.lines) x order by x ->> 'id' loop
      amt := (l ->> 'amount')::numeric;
      select * into q from queue_entries where id = l ->> 'id' for update;
      if q.id is null or coalesce(q.paid, false) then back := back + amt; continue; end if;
      if q.status in ('cancelled', 'removed') then
        if q.cancel_reason is distinct from 'unpaid' then back := back + amt; continue; end if;
        ok := true;
        begin  -- the place was let go when the hold ran out: back on it when there is still room
          /* the room counted as for a new booking (bug hunt 2026-11-10): no trigger counts places on a change of status */
          if not _pay_place_free(q) then raise exception 'SESSION_FULL'; end if;
          update queue_entries set status = 'waiting', cancel_reason = null, cancelled_at = null, cancelled_by = null where id = q.id;
          /* the wallet's part went back to the wallet when the place was let go: taken again, as the order's branch
             below does - all of it or none, and only from a rider who let the wallet pay this booking; else the card
             is refunded and the booking stays cancelled (bug hunt 2026-11-10) */
          select * into q from queue_entries where id = q.id;
          w := round(_wallet_amount(q.price, q.addons) - coalesce(q.wallet_paid, 0) - amt, 2);
          if w > 0 then
            if not exists (select 1 from wallet_ledger x where x.booking_id = q.id and x.kind = 'spend') then
              raise exception 'PAY_SHORT';
            end if;
            perform _wallet_post(_wallet_owner(q.customer_id), -w, 'spend', null, null, q.id, null, q.session_id);
            perform set_config('mm.wallet_ok', '1', true);
            update queue_entries set wallet_paid = coalesce(wallet_paid, 0) + w where id = q.id;
            perform set_config('mm.wallet_ok', '', true);
          end if;
        exception when others then ok := false;
        end;
        if not ok then back := back + amt; continue; end if;
      end if;
      /* what the booking owes now against what this payment brings for it: while the card payment was open the wallet
         may have paid part of it, its wallet part may have been taken back, or staff may have changed its price, and it
         was marked paid at the amount frozen when the payment started (100 by card on top of 40 from the wallet: 140
         for a 100 SAR ride). A payment bringing more than is owed now pays what is owed and the rest is refunded; one
         bringing less, or a booking owing nothing, is refunded whole and the booking stays to pay (no longer held by
         this payment), as a workshop job's payment is (bug hunt 2026-11-11 (20261111235200)) */
      select * into q from queue_entries where id = q.id;
      due := _pay_due(q);
      if due <= 0 or due > round(amt, 2) then
        back := back + amt;
        update queue_entries set pay_hold_until = null where id = q.id and payment_id = p.id and pay_hold_until is not null;
        continue;
      end if;
      if due < round(amt, 2) then
        back := back + (amt - due);
        amt := due;
      end if;
      update queue_entries set paid = true, pay_method = 'online', card_amount = amt, paid_at = now(),
                               pay_hold_until = null, payment_id = p.id
       where id = q.id;
    end loop;
  elsif p.kind = 'order' then
    select * into o from store_orders where id = p.ref::uuid for update;
    if o.id is null then return p.amount; end if;
    if o.status = 'pending' then
      null;
    elsif o.status = 'cancelled' and o.cancel_reason = 'unpaid' then
      ok := true;
      begin  -- the stock was put back when the hold ran out: taken again when it is still there
        for i in select * from store_order_items where order_id = o.id and not held order by variant_id loop
          update store_variants set stock = stock - i.qty where id = i.variant_id and stock >= i.qty;
          if not found then raise exception 'STORE_STOCK'; end if;
          update store_order_items set held = true where id = i.id;
        end loop;
        if o.wallet_paid > 0 then  -- the wallet's part went back on the cancel: taken again
          perform _wallet_post(_wallet_owner(o.customer_id), -o.wallet_paid, 'sale', null, null, null, 'ord-' || o.no, null);
        end if;
        /* the gift card's part went back onto it on the cancel: taken again while the card still holds it and has not
           expired, else the payment is refunded; the code's use is counted again (store build 2026-11-15 (20261115235500)) */
        if o.gift_card_id is not null and o.gift_paid > 0 then
          update store_gift_cards set balance = balance - o.gift_paid
           where id = o.gift_card_id and status = 'active' and balance >= o.gift_paid and expires_at > now();
          if not found then raise exception 'STORE_GIFT'; end if;
          insert into store_gift_card_moves (card_id, order_id, amount, kind, by_name) values (o.gift_card_id, o.id, -o.gift_paid, 'spend', 'system');
        end if;
        if o.promo_code is not null then
          perform set_config('mm.store_ok', '1', true);
          update store_promo_codes set uses = uses + 1 where code = o.promo_code;
          perform set_config('mm.store_ok', '', true);
        end if;
      exception when others then ok := false;
      end;
      if not ok then return p.amount; end if;
    else
      return p.amount;
    end if;
    update store_orders set status = 'paid', paid_at = now(), expires_at = null, cancel_reason = null where id = o.id returning * into o;
    insert into store_order_events (order_id, status, note) values (o.id, 'paid', null);
    insert into receipt_numbers (receipt_id) values ('ord-' || o.no) on conflict (receipt_id) do nothing;
    /* its gift cards, and a gift card order delivered at once (store build 2026-11-15 (20261115235500)) */
    perform _store_paid(o);
  elsif p.kind = 'locker' then
    for l in select x from jsonb_array_elements(p.lines) x loop
      amt := (l ->> 'amount')::numeric;
      /* the evening's lock before the rental's row, as every locker function takes them (bug hunt 2026-11-18 (20261119000500)) */
      d := (select x.day from locker_rentals x where x.id = (l ->> 'id')::uuid);
      if d is not null then perform _lk_lock(d); end if;
      select * into r from locker_rentals where id = (l ->> 'id')::uuid for update;
      if r.id is null or r.receipt_id is not null then back := back + amt; continue; end if;
      if r.status = 'cancelled' then
        if r.day is distinct from d then perform _lk_lock(r.day); end if;
        select * into ev from _lk_evening(r.day);
        /* let go unpaid, it comes back only as a new reservation would be taken (customer_locker_book): an evening still
           offering lockers for its time (not called off or deleted), the time not over, its locker still in service and
           free, room in each slot, and no more than 3 lockers of the account's for each time; else the card is refunded
           (bug hunt 2026-11-18 (20261119000500), sql02-3: a late card payment brought a locker back on a night called
           off, kept no refund, and could give a unit taken meanwhile) */
        if r.cancel_reason is distinct from 'unpaid'
           or ev.session_id is null or not _lk_period_ok(ev.kind, r.period) or _lk_ended(r.day, r.period)
           or (r.locker_id is not null and not exists (select 1 from lockers k where k.id = r.locker_id and k.status = 'available'))
           or not _lk_room(r.day, r.period, 1)
           or (r.booking_id is null and r.customer_id is not null
               and (select count(*) from locker_rentals x where x.day = r.day and x.customer_id = r.customer_id
                      and x.booking_id is null and x.id <> r.id and x.status in ('reserved', 'in_use')
                      and _lk_slots(x.period) && _lk_slots(r.period)) >= 3)
           or exists (select 1 from locker_rentals x where x.locker_id = r.locker_id and x.day = r.day and x.id <> r.id
                        and x.status in ('reserved', 'in_use') and _lk_slots(x.period) && _lk_slots(r.period)) then
          back := back + amt; continue;
        end if;
        update locker_rentals set status = 'reserved', cancelled_at = null, cancelled_by = null, cancel_reason = null where id = r.id;
      elsif r.status not in ('reserved', 'in_use', 'returned') then
        back := back + amt; continue;
      end if;
      update locker_rentals set receipt_id = 'pay-' || p.id, payment_id = p.id where id = r.id;
    end loop;
  elsif p.kind = 'topup' then
    perform set_config('mm.wallet_op', 'Online top-up', true);
    perform _wallet_post(_wallet_owner(p.customer_id), p.amount, 'topup', 'online', p.amount, null, 'pay-' || p.id, null);
    perform set_config('mm.wallet_op', '', true);
  elsif p.kind = 'workshop' then
    select * into j from workshop_jobs where id = p.ref::bigint for update;
    /* a payment started before staff changed the price pays the old price: refunded, the job stays to pay
       (bug hunt 2026-11-10) */
    if j.id is null or j.paid_at is not null or p.amount is distinct from round(j.price_final, 2) then return p.amount; end if;
    update workshop_jobs set paid_at = now(), paid_receipt = 'pay-' || p.id, payment_id = p.id where id = j.id;
  end if;
  perform set_config('mm.pay_ok', '', true);
  return round(back, 2);
end $function$;
revoke execute on function public._pay_apply(payments) from public, anon, authenticated;

-- ── sql08-1 pay_booking_cancel ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pay_booking_cancel(p_key text, p_id text, p_token text, p_ids text[], p_dest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q queue_entries%rowtype; s sessions%rowtype; dest text; late boolean; rf payment_refunds%rowtype; outv jsonb := '[]'::jsonb;
        days int := _pay_int('pay.refundDays', 1, 0, 30); bid text; ended boolean;
        pid uuid; pp payments%rowtype; room numeric; amt numeric;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_dest is null or p_dest not in ('wallet', 'card') then raise exception 'PAY_DEST' using errcode = 'P0001'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 20 then raise exception 'PAY_NOTHING' using errcode = 'P0001'; end if;
  foreach bid in array (select array_agg(distinct x order by x) from unnest(p_ids) x) loop
    /* the payment's row before the booking's, as pay_settle takes them, so a staff refund of the same payment
       (staff_pay_refund_begin locks it) and this cancel take turns (bug hunt 2026-11-18 (20261119000500), sql08-1) */
    pid := (select e.payment_id from queue_entries e where e.id = bid and e.customer_id = p_id);
    pp := null;
    if pid is not null then select * into pp from payments where id = pid for update; end if;
    select * into q from queue_entries where id = bid and customer_id = p_id for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if q.payment_id is distinct from pid then
      pp := null;
      if q.payment_id is not null then select * into pp from payments where id = q.payment_id for update; end if;
    end if;
    if coalesce(q.status, '') not in ('waiting', 'waitlist') then raise exception 'PAY_NOT_OPEN' using errcode = 'P0001'; end if;
    select * into s from sessions where id = q.session_id;
    /* a ride paid by card or from the wallet that has ended (an earlier day, or its time over today) is settled at
       close-out, not cancelled by the rider: cancelled afterwards, the wallet's part came back for a ride missed and a
       no-show became 'cancelled', as customer_booking_update refuses it since 20261110235000 (bug hunt 2026-11-11
       (20261111235200)). A time the window cannot read ends nothing. */
    if coalesce(q.paid, false) or coalesce(q.wallet_paid, 0) > 0 then
      begin ended := (select w.ends_at from _session_window(s) w) <= now();
      exception when others then ended := false; end;
      if left(coalesce(s.session_date, q.session_date, ''), 10) < to_char(_pay_today(), 'YYYY-MM-DD') or coalesce(ended, false) then
        raise exception 'PAY_NOT_OPEN' using errcode = 'P0001';
      end if;
    end if;
    late := (_pay_today() + days) > left(coalesce(s.session_date, q.session_date), 10)::date;
    dest := case when q.pay_method = 'online' and coalesce(q.card_amount, 0) > 0 then case when late then 'none' else p_dest end end;
    /* never more than is left of the payment: its card refunds done or on their way and its wallet refunds done (staff
       refunding it, another booking it paid), as staff_pay_refund_begin counts it. Nothing left: nothing refunded and
       nothing recorded (bug hunt 2026-11-18 (20261119000500), sql08-1: a payment staff had refunded was refunded again
       in full when the rider cancelled) */
    amt := null;
    if dest is not null then
      room := case when pp.id is not null and pp.status in ('paid', 'partly_refunded') then
                pp.amount - pp.refunded - coalesce((select sum(x.amount) from payment_refunds x where x.payment_id = pp.id
                                                     and ((x.status = 'pending' and x.dest = 'card') or (x.status = 'done' and x.dest = 'wallet'))), 0)
              else 0 end;
      amt := round(least(q.card_amount, greatest(room, 0)), 2);
      if amt <= 0 then dest := null; end if;
    end if;
    perform set_config('mm.pay_refund_dest', coalesce(dest, 'none'), true);
    update queue_entries set status = 'cancelled', cancel_reason = 'customer', cancelled_by = 'customer', cancelled_at = now(),
                             pay_hold_until = null
     where id = q.id;
    perform set_config('mm.pay_refund_dest', '', true);
    if dest = 'wallet' then
      perform set_config('mm.wallet_op', 'Cancelled online booking', true);
      perform _wallet_post(_wallet_owner(p_id), amt, 'refund', 'online', amt, q.id, 'pay-' || q.payment_id, q.session_id);
      perform set_config('mm.wallet_op', '', true);
      insert into payment_refunds (payment_id, provider_id, amount, dest, status, reason, booking_id, by_name, done_at)
      select q.payment_id, p.provider_id, amt, 'wallet', 'done', 'rider cancelled', q.id, 'customer', now()
        from payments p where p.id = q.payment_id;
      perform _pay_event(q.payment_id, 'customer', 'refund_wallet', null, q.id);
    elsif dest = 'card' then
      insert into payment_refunds (payment_id, provider_id, amount, dest, status, reason, booking_id, by_name)
      select q.payment_id, p.provider_id, amt, 'card', 'pending', 'rider cancelled', q.id, 'customer'
        from payments p where p.id = q.payment_id
      returning * into rf;
      perform _pay_event(q.payment_id, 'customer', 'refund_card', rf.provider_id, q.id);
      outv := outv || jsonb_build_array(jsonb_build_object('id', rf.id, 'provider_id', rf.provider_id, 'amount', rf.amount));
    elsif dest = 'none' then
      insert into payment_refunds (payment_id, provider_id, amount, dest, status, reason, booking_id, by_name)
      select q.payment_id, p.provider_id, amt, 'none', 'declined', 'cancelled too late for a refund', q.id, 'customer'
        from payments p where p.id = q.payment_id;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'refunds', outv);
end $function$;
revoke execute on function public.pay_booking_cancel(text, text, text, text[], text) from public;
grant execute on function public.pay_booking_cancel(text, text, text, text[], text) to anon, authenticated;

-- ── sql11-4 staff_payments: pages ───────────────────────────────────────────────────────────────────
drop function if exists public.staff_payments(date, date, text);
create or replace function public.staff_payments(p_from date default null, p_to date default null, p_kind text default null,
                                                 p_offset int default 0, p_limit int default 500) returns jsonb
language plpgsql stable security definer set search_path = public as $$
/* A page of the payments, newest first: p_limit of them (1 to 1000, 500 by default) after the first p_offset. A page
   shorter than p_limit is the last one; the staff page reads pages until it gets one (bug hunt 2026-11-18
   (20261119000500), sql11-4: one read stopped at the newest 500 of the range, and the figures counted only those). */
declare v_lim int := least(greatest(coalesce(p_limit, 500), 1), 1000); v_off int := greatest(coalesce(p_offset, 0), 0);
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(_pay_json(p) || jsonb_build_object('customer_id', p.customer_id, 'provider_id', p.provider_id,
            'customer', (select c.name from customers c where c.id = p.customer_id), 'refs', p.refs,
            'refunds', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'dest', r.dest, 'status', r.status,
                                   'reason', r.reason, 'by', r.by_name, 'at', coalesce(r.done_at, r.created_at), 'booking_id', r.booking_id,
                                   'order_id', r.order_id, 'error', r.error) order by r.created_at)
                                 from payment_refunds r where r.payment_id = p.id), '[]'::jsonb))
            order by p.created_at desc, p.id desc)
          from (select * from payments
                 where status <> 'initiated'
                   and (p_from is null or (created_at at time zone 'Asia/Riyadh')::date >= p_from)
                   and (p_to is null or (created_at at time zone 'Asia/Riyadh')::date <= p_to)
                   and (p_kind is null or kind = p_kind)
                 order by created_at desc, id desc offset v_off limit v_lim) p), '[]'::jsonb);
end $$;
revoke execute on function public.staff_payments(date, date, text, int, int) from public, anon;
grant execute on function public.staff_payments(date, date, text, int, int) to authenticated;

-- ── sql11-2 a gift card's part given back where it can be spent ────────────────────────────────────
do $kind$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.store_gift_card_moves'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%kind%' and pg_get_constraintdef(oid) not like '%wallet%' loop
    execute format('alter table public.store_gift_card_moves drop constraint %I', c.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conrelid = 'public.store_gift_card_moves'::regclass
                   and conname = 'store_gift_card_moves_kind_check') then
    /* + issue / back / refund / wallet (given back to the order's account wallet, not onto the card), - spend / void */
    alter table public.store_gift_card_moves add constraint store_gift_card_moves_kind_check
      check (kind in ('issue', 'spend', 'back', 'refund', 'void', 'wallet'));
  end if;
end $kind$;

-- An order's gift card part given back (p_amt, move p_kind 'back' or 'refund'): onto the card while it can be spent
-- (active, not expired); else into the order's account wallet, as a 'sale_back' on the order's receipt with a move
-- 'wallet' on the card (the card's balance does not change); a guest's card that is active but expired still takes
-- it (staff can move its expiry). Answers 'gift', 'wallet', or 'none' (a guest's void card: nothing moved).
-- The caller holds the order's row (bug hunt 2026-11-18 (20261119000500), sql11-2).
create or replace function public._store_gift_return(o store_orders, p_amt numeric, p_kind text, p_by text, p_note text)
returns text
language plpgsql security definer set search_path = public as $$
declare gc store_gift_cards%rowtype; own text;
begin
  /* bug hunt 2026-11-18 (20261119000500), sql11-2 */
  if o.gift_card_id is null or coalesce(p_amt, 0) <= 0 then return 'none'; end if;
  if p_kind is null or p_kind not in ('back', 'refund') then raise exception 'STORE_GIFT_KIND' using errcode = 'P0001'; end if;
  select * into gc from store_gift_cards where id = o.gift_card_id for update;
  if gc.id is null then return 'none'; end if;
  if o.customer_id is not null then own := _wallet_owner(o.customer_id); end if;
  if gc.status = 'active' and (gc.expires_at > now() or own is null) then
    update store_gift_cards set balance = least(amount, balance + p_amt) where id = gc.id;
    insert into store_gift_card_moves (card_id, order_id, amount, kind, by_name) values (gc.id, o.id, p_amt, p_kind, left(p_by, 60));
    return 'gift';
  end if;
  if own is null then return 'none'; end if;
  perform set_config('mm.wallet_op', left(coalesce(p_by, ''), 40), true);
  perform set_config('mm.wallet_note', left(coalesce(p_note, ''), 300), true);
  perform _wallet_post(own, p_amt, 'sale_back', null, null, null, 'ord-' || o.no, null);
  perform set_config('mm.wallet_op', '', true);
  perform set_config('mm.wallet_note', '', true);
  insert into store_gift_card_moves (card_id, order_id, amount, kind, by_name) values (gc.id, o.id, p_amt, 'wallet', left(p_by, 60));
  return 'wallet';
end $$;
revoke execute on function public._store_gift_return(store_orders, numeric, text, text, text) from public, anon, authenticated;

create or replace function public._store_gift_refund_plan(o store_orders) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p payments%rowtype; n int; unspent numeric; card_room numeric := 0; wal_room numeric := 0; amt numeric; c numeric;
begin
  select count(*), coalesce(sum(g.balance), 0) into n, unspent
    from store_gift_cards g where g.order_id = o.id and g.status = 'active' and g.balance > 0;
  select * into p from payments where id = o.payment_id;
  if p.id is not null and p.status in ('paid', 'partly_refunded') then
    card_room := greatest(round(p.amount - p.refunded - coalesce((select sum(x.amount) from payment_refunds x
                   where x.payment_id = p.id and x.provider_id is not distinct from p.provider_id
                     and ((x.status = 'pending' and x.dest = 'card') or (x.status = 'done' and x.dest = 'wallet')
                          or x.status in ('due', 'failed'))), 0), 2), 0);
  end if;
  if o.wallet_paid > 0 and o.customer_id is not null then
    /* a gift card's part given back to the wallet ('wallet' moves: the card void or expired) is not the wallet's own
       part (bug hunt 2026-11-18 (20261119000500), sql11-2) */
    select greatest(coalesce(-sum(l.amount), 0)
                    + coalesce((select sum(m.amount) from store_gift_card_moves m where m.order_id = o.id and m.kind = 'wallet'), 0), 0)
      into wal_room from wallet_ledger l
     where l.receipt_id = 'ord-' || o.no and l.kind in ('sale', 'sale_back');
  end if;
  amt := round(least(unspent, card_room + wal_room), 2);
  c := least(amt, card_room);
  return jsonb_build_object('cards', n, 'unspent', unspent, 'refund', amt, 'card', c, 'wallet', amt - c);
end $$;
revoke execute on function public._store_gift_refund_plan(store_orders) from public, anon, authenticated;

create or replace function public._store_give_back(o store_orders, p_by text, p_promo boolean) returns void
language plpgsql security definer set search_path = public as $$
declare net numeric; how text;
begin
  if o.gift_card_id is not null and o.gift_paid > 0 then
    select coalesce(-sum(m.amount), 0) into net from store_gift_card_moves m
     where m.card_id = o.gift_card_id and m.order_id = o.id and m.kind in ('spend', 'back', 'refund', 'wallet');
    if net > 0 then
      /* onto the card while it can still be spent, else into the account's wallet (_store_gift_return); a guest's void
         card takes nothing, and staff see what is owed (bug hunt 2026-11-18 (20261119000500), sql11-2: it went onto a
         void card, lost to the customer) */
      how := _store_gift_return(o, net, 'back', p_by, 'MM-' || o.no);
      if how = 'wallet' then
        insert into store_order_events (order_id, status, note, by_name) values (o.id, 'refund', net::text || ' SAR · wallet', left(p_by, 60));
      elsif how = 'none' then
        insert into store_order_events (order_id, status, note, public, by_name)
        values (o.id, 'gift_void', net::text || ' SAR owed: the gift card that paid it is void', false, left(p_by, 60));
      end if;
    end if;
  end if;
  if p_promo and o.promo_code is not null then
    perform set_config('mm.store_ok', '1', true);
    update store_promo_codes set uses = greatest(uses - 1, 0) where code = o.promo_code;
    perform set_config('mm.store_ok', '', true);
  end if;
end $$;
revoke execute on function public._store_give_back(store_orders, text, boolean) from public, anon, authenticated;

-- ── sql11-1 staff_store_order_cancel (and sql11-2's wallet room) ────────────────────────────────────
create or replace function public.staff_store_order_cancel(p_order uuid, p_reason text, p_op text default null, p_approval text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; p payments%rowtype; who text; owed numeric; g store_gift_cards%rowtype; kept numeric := 0; cut numeric;
        wal_room numeric := 0;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() and not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into o from store_orders where id = p_order for update;
  if o.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status in ('delivered', 'cancelled', 'refunded') then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  select coalesce(nullif(btrim(s.display_name), ''), 'Staff') into who from staff s where s.user_id = auth.uid();
  perform _store_restock(o.id);
  /* the gift cards this order bought are issued once it is paid, so they may be spent before the goods go out: what
     they paid for elsewhere stays spent and is kept back from the refund (store build review 2026-11-15: a 100 SAR card
     spent in full and its order cancelled still owed the 100 SAR by card) */
  select greatest(coalesce(-sum(m.amount), 0), 0) into kept
    from store_gift_card_moves m join store_gift_cards gc on gc.id = m.card_id
   where gc.order_id = o.id and m.kind in ('spend', 'back', 'refund');
  select * into p from payments where id = o.payment_id;
  /* owed: the card's money less what came back or is on its way, on the order's own Moyasar payment, as
     staff_pay_refund_begin counts it: card refunds done (p.refunded), being sent, failed (for a retry), wallet
     refunds done, and refunds already owed. Nothing when nothing is left; an order refunded whole before the cancel
     is 'refunded', as pay_refund_done and staff_pay_refund_begin leave it (bug hunt 2026-11-10 (20261110235500): it
     was p.amount - p.refunded, so those were owed a second time) */
  if p.status in ('paid', 'partly_refunded') then
    owed := round(p.amount - p.refunded - coalesce((select sum(x.amount) from payment_refunds x
              where x.payment_id = p.id and x.provider_id is not distinct from p.provider_id
                and ((x.status = 'pending' and x.dest = 'card') or (x.status = 'done' and x.dest = 'wallet')
                     or x.status in ('due', 'failed'))), 0), 2);
    cut := least(greatest(owed, 0), kept);
    owed := owed - cut;
    kept := kept - cut;
  end if;
  /* the wallet's part less what already went back to the wallet ("Void cards and refund", a return), counted from the
     wallet's lines as _store_gift_refund_plan and staff_store_return_decide count it, less what stays kept (bug hunt
     2026-11-18 (20261119000500), sql11-1: it was o.wallet_paid - kept, so a "Void cards and refund" before the cancel
     was given back a second time) */
  if o.wallet_paid > 0 and o.customer_id is not null then
    select greatest(coalesce(-sum(l.amount), 0)
                    + coalesce((select sum(m.amount) from store_gift_card_moves m where m.order_id = o.id and m.kind = 'wallet'), 0), 0)
      into wal_room from wallet_ledger l
     where l.receipt_id = 'ord-' || o.no and l.kind in ('sale', 'sale_back');
  end if;
  if wal_room - kept > 0 then
    perform set_config('mm.wallet_op', left(coalesce(p_op, who), 40), true);
    perform _wallet_post(_wallet_owner(o.customer_id), wal_room - kept, 'sale_back', null, null, null, 'ord-' || o.no, null);
    perform set_config('mm.wallet_op', '', true);
  end if;
  /* a gift card's part back onto it; a code's use back for an order never paid; the gift cards it bought are no longer
     sold, so what is left on them is voided (store build 2026-11-15 (20261115235500)) */
  perform _store_give_back(o, left(coalesce(p_op, who), 60), o.status = 'pending');
  for g in select * from store_gift_cards where order_id = o.id and status = 'active' order by created_at for update loop
    update store_gift_cards set status = 'void', balance = 0, voided_at = now(), void_reason = 'order cancelled' where id = g.id;
    insert into store_gift_card_moves (card_id, order_id, amount, kind, by_name) values (g.id, o.id, -g.balance, 'void', left(coalesce(p_op, who), 60));
  end loop;
  if o.status = 'pending' then
    update payments set status = 'cancelled' where id = o.payment_id and status = 'initiated';
  end if;
  update store_orders set status = 'cancelled', cancel_reason = 'staff', expires_at = null where id = o.id returning * into o;
  insert into store_order_events (order_id, status, note, by_name) values (o.id, 'cancelled', left(nullif(btrim(coalesce(p_reason, '')), ''), 300), left(who, 60));
  if p.status in ('paid', 'partly_refunded') then
    if owed > 0 then
      insert into payment_refunds (payment_id, provider_id, amount, status, reason, order_id, by_user, by_name)
      values (p.id, p.provider_id, owed, 'due', left(coalesce(p_reason, 'order cancelled'), 200), o.id, auth.uid(), left(who, 60));
    elsif (select coalesce(sum(x.amount), 0) from payment_refunds x where x.order_id = o.id and x.status = 'done' and x.dest in ('card', 'wallet'))
          >= o.total - o.wallet_paid - o.gift_paid then
      update store_orders set status = 'refunded' where id = o.id and status = 'cancelled' returning * into o;
    end if;
  end if;
  return _store_order_json(o, true);
end $$;
revoke execute on function public.staff_store_order_cancel(uuid, text, text, text) from public, anon;
grant execute on function public.staff_store_order_cancel(uuid, text, text, text) to authenticated;

-- ── sql11-2 staff_store_return_decide ───────────────────────────────────────────────────────────────
create or replace function public.staff_store_return_decide(p_id uuid, p_approve boolean, p_amount numeric, p_note text,
                                                           p_op text default null, p_approval text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare rq store_return_requests%rowtype; o store_orders%rowtype; p payments%rowtype; who text; amt numeric;
        card_room numeric := 0; wal_room numeric := 0; gift_room numeric := 0; c numeric := 0; w numeric := 0; g numeric := 0;
        nt text := left(nullif(btrim(coalesce(p_note, '')), ''), 300); how text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() and not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into rq from store_return_requests where id = p_id for update;
  if rq.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if rq.status <> 'open' then raise exception 'STORE_RETURN_STATE' using errcode = 'P0001'; end if;
  select * into o from store_orders where id = rq.order_id for update;
  select left(coalesce(p_op, nullif(btrim(s.display_name), ''), 'Staff'), 60) into who from staff s where s.user_id = auth.uid();
  who := coalesce(who, left(coalesce(p_op, 'Staff'), 60));
  if not coalesce(p_approve, false) then
    update store_return_requests set status = 'refused', staff_note = nt, decided_by = who, decided_at = now() where id = rq.id;
    insert into store_order_events (order_id, status, note, by_name) values (o.id, 'return_refused', rq.kind, who);
    return _store_order_json(o, true);
  end if;
  amt := case when rq.kind = 'return' then round(coalesce(p_amount, 0), 2) end;
  if amt < 0 then raise exception 'PAY_AMOUNT' using errcode = 'P0001'; end if;
  if amt > 0 then
    -- what is left of each way the order was paid
    select * into p from payments where id = o.payment_id;
    if p.id is not null and p.status in ('paid', 'partly_refunded') then
      card_room := greatest(round(p.amount - p.refunded - coalesce((select sum(x.amount) from payment_refunds x
                     where x.payment_id = p.id and x.provider_id is not distinct from p.provider_id
                       and ((x.status = 'pending' and x.dest = 'card') or (x.status = 'done' and x.dest = 'wallet')
                            or x.status in ('due', 'failed'))), 0), 2), 0);
    end if;
    if o.wallet_paid > 0 and o.customer_id is not null then
      /* a gift card's part given back to the wallet ('wallet' moves: the card void or expired) is not the wallet's own
         part (bug hunt 2026-11-18 (20261119000500), sql11-2) */
      select greatest(coalesce(-sum(l.amount), 0)
                      + coalesce((select sum(m.amount) from store_gift_card_moves m where m.order_id = o.id and m.kind = 'wallet'), 0), 0)
        into wal_room from wallet_ledger l
       where l.receipt_id = 'ord-' || o.no and l.kind in ('sale', 'sale_back');
    end if;
    if o.gift_card_id is not null and o.gift_paid > 0 then
      select greatest(coalesce(-sum(m.amount), 0), 0) into gift_room from store_gift_card_moves m
       where m.card_id = o.gift_card_id and m.order_id = o.id and m.kind in ('spend', 'back', 'refund', 'wallet');
      /* a void card takes nothing back and a guest has no wallet: that part cannot be given back here (bug hunt
         2026-11-18 (20261119000500), sql11-2) */
      if gift_room > 0 and (o.customer_id is null or _wallet_owner(o.customer_id) is null)
         and not exists (select 1 from store_gift_cards gc where gc.id = o.gift_card_id and gc.status = 'active') then
        gift_room := 0;
      end if;
    end if;
    if amt > card_room + wal_room + gift_room then raise exception 'PAY_TOO_MUCH' using errcode = 'P0001'; end if;
    /* over the shop's manager limit a manager's word, as every refund staff make (staff_pay_refund_begin, lockers): the
       wallet's and the gift card's parts are given back here at once, and the staff page asks for that word on approving
       (store build integration 2026-11-15) */
    if not _mgr_ok('refund', amt, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
    c := least(amt, card_room);
    w := least(amt - c, wal_room);
    g := least(amt - c - w, gift_room);
    if c > 0 then
      insert into payment_refunds (payment_id, provider_id, amount, status, reason, order_id, by_user, by_name)
      values (p.id, p.provider_id, c, 'due', 'return ' || rq.id, o.id, auth.uid(), who);
      perform _pay_event(p.id, 'staff', 'refund_due', null, c::text);
    end if;
    if w > 0 then
      perform set_config('mm.wallet_op', left(who, 40), true);
      perform set_config('mm.wallet_note', 'return MM-' || o.no, true);
      perform _wallet_post(_wallet_owner(o.customer_id), w, 'sale_back', null, null, null, 'ord-' || o.no, null);
      perform set_config('mm.wallet_op', '', true);
      perform set_config('mm.wallet_note', '', true);
      insert into store_order_events (order_id, status, note, by_name) values (o.id, 'refund', w::text || ' SAR · wallet', who);
    end if;
    if g > 0 then
      /* onto the card while it can still be spent, else into the account's wallet (bug hunt 2026-11-18 (20261119000500),
         sql11-2: a void card took it and the customer could never spend it) */
      how := _store_gift_return(o, g, 'refund', who, 'return MM-' || o.no);
      if how = 'none' then raise exception 'STORE_GIFT_STATE' using errcode = 'P0001'; end if;
      insert into store_order_events (order_id, status, note, by_name)
      values (o.id, 'refund', g::text || case when how = 'wallet' then ' SAR · wallet' else ' SAR · gift card' end, who);
    end if;
  end if;
  update store_return_requests set status = 'approved', amount = amt, staff_note = nt, decided_by = who, decided_at = now() where id = rq.id;
  insert into store_order_events (order_id, status, note, by_name) values (o.id, 'return_approved', rq.kind, who);
  return _store_order_json(o, true);
end $$;
revoke execute on function public.staff_store_return_decide(uuid, boolean, numeric, text, text, text) from public, anon;
grant execute on function public.staff_store_return_decide(uuid, boolean, numeric, text, text, text) to authenticated;

-- ── dbgrants-3 store_reviews: the public reads shown reviews, signed-in accounts only as staff ─────
drop policy if exists "store reviews shown read" on public.store_reviews;
create policy "store reviews shown read" on public.store_reviews for select to anon using (status = 'shown');
drop policy if exists "store reviews staff read" on public.store_reviews;
create policy "store reviews staff read" on public.store_reviews for select to authenticated using ((select is_staff()));

-- ── checks ──────────────────────────────────────────────────────────────────────────────────────────
-- every function written here is SECURITY DEFINER with its search_path; the inner ones no client may run, the staff
-- ones not anon, the website's one reachable; one staff_payments; the moves take 'wallet'; store_reviews has no policy
-- that lets a signed-in account that is not staff read, and anon still reads no order and no name
do $chk$
declare f text;
begin
  foreach f in array array['public._pay_apply(public.payments)',
                           'public.pay_booking_cancel(text,text,text,text[],text)',
                           'public.staff_payments(date,date,text,integer,integer)',
                           'public._store_gift_return(public.store_orders,numeric,text,text,text)',
                           'public._store_gift_refund_plan(public.store_orders)',
                           'public._store_give_back(public.store_orders,text,boolean)',
                           'public.staff_store_order_cancel(uuid,text,text,text)',
                           'public.staff_store_return_decide(uuid,boolean,numeric,text,text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and position('20261119000500' in p.prosrc) > 0
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, lacks this file''s change, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._pay_apply(public.payments)',
                           'public._store_gift_return(public.store_orders,numeric,text,text,text)',
                           'public._store_gift_refund_plan(public.store_orders)',
                           'public._store_give_back(public.store_orders,text,boolean)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  foreach f in array array['public.staff_payments(date,date,text,integer,integer)',
                           'public.staff_store_order_cancel(uuid,text,text,text)',
                           'public.staff_store_return_decide(uuid,boolean,numeric,text,text,text)'] loop
    if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is open to anon or lost its grant', f;
    end if;
  end loop;
  if not has_function_privilege('anon', 'public.pay_booking_cancel(text,text,text,text[],text)', 'execute') then
    raise exception 'pay_booking_cancel lost its grant';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'staff_payments') <> 1 then
    raise exception 'staff_payments has more than one signature';
  end if;
  if (select provolatile from pg_proc where oid = 'public.staff_payments(date,date,text,integer,integer)'::regprocedure) <> 's' then
    raise exception 'staff_payments is no longer STABLE';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.store_gift_card_moves'::regclass
                   and conname = 'store_gift_card_moves_kind_check' and pg_get_constraintdef(oid) like '%wallet%') then
    raise exception 'store_gift_card_moves does not take the kind wallet';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'store_reviews' and cmd in ('SELECT', 'ALL')
               and 'authenticated' = any(roles) and coalesce(qual, '') not like '%is_staff()%') then
    raise exception 'a store_reviews read policy lets signed-in accounts that are not staff read';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'store_reviews' and cmd in ('SELECT', 'ALL')
               and 'anon' = any(roles) and coalesce(qual, '') like '%is_staff()%') then
    raise exception 'a store_reviews read policy for anon still names staff';
  end if;
  if has_column_privilege('anon', 'public.store_reviews', 'decided_by', 'select') or has_column_privilege('anon', 'public.store_reviews', 'order_id', 'select')
     or not has_column_privilege('anon', 'public.store_reviews', 'bought_month', 'select') then
    raise exception 'store_reviews: anon''s columns changed';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name) values ('20261119000500', 'bh18_dbstg_staging') on conflict do nothing;

commit;

-- check (read only): the functions' marks and attributes, the policies, the move kinds, the ledger row
-- select p.proname, p.prosecdef, p.proconfig, position('20261119000500' in p.prosrc) > 0 as fixed,
--        pg_get_function_identity_arguments(p.oid) as args
--   from pg_proc p where p.pronamespace = 'public'::regnamespace
--    and p.proname in ('_pay_apply', 'pay_booking_cancel', 'staff_payments', '_store_gift_return', '_store_gift_refund_plan',
--                      '_store_give_back', 'staff_store_order_cancel', 'staff_store_return_decide') order by 1;
-- select policyname, roles, qual from pg_policies where tablename = 'store_reviews';
-- select pg_get_constraintdef(oid) from pg_constraint where conname = 'store_gift_card_moves_kind_check';
-- select position('20261110235300' in prosrc) > 0 as house_fix_on_staging
--   from pg_proc where oid = 'public.customer_locker_change(text,text,uuid,text,text)'::regprocedure;
-- select name from supabase_migrations.schema_migrations where version = '20261119000500';
