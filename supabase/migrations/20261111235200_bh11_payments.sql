-- ============================================================================
-- Bug hunt 2026-11-11 (bh11): online payments. STAGING ONLY for now, like 20261110235200_bh10_payments.sql and
-- 20261110235500_bh10_payments_b.sql, which must be applied first (pay_booking_start below is built from the text
-- 20261110235500 left; this file stops if it is not in the ledger). When payments go live, these files go to
-- production in order.
--
-- 1. pay_booking_cancel (the website's POST /api/pay/cancel, with ids the rider sends) checked only that a booking
--    was waiting or waitlisted, never that its ride had ended. Close-out has not run on a ride left open, so a rider
--    who paid from the wallet and did not come could cancel it the next day (or a week later) and _wallet_follow put
--    the wallet money back; a card-paid no-show became 'cancelled' (and its wallet part came back); with
--    pay.refundDays 0 even the card was refunded for a ride that ended earlier that day. A booking paid in full or in
--    part (paid, or a wallet part) whose ride day is past or whose time is over is now refused (PAY_NOT_OPEN), as
--    customer_booking_update has refused it since 20261110235000; close-out settles it. An unpaid booking cancels as
--    before. The website's own undo of a booking whose payment could not start (bookings just made) is not touched.
-- 2. _pay_apply (pay_settle): a card payment marked its bookings paid at the amount frozen when the payment started,
--    never compared with what each still owed. The wallet paying part while the rider was in 3-D Secure (40 of 100)
--    left the card charging the full 100 on top: 140 for a 100 SAR ride, nothing refunded; a price staff lowered
--    meanwhile was charged at the old price; the wallet's part taken back meanwhile left the ride paid with the card's
--    part only. A payment now pays what the booking owes when it settles and the rest is refunded (pay_settle's
--    automatic refund); one bringing less than is owed, or for a booking owing nothing, is refunded whole and the
--    booking stays to pay, as a workshop job's payment already is (20261110235200).
-- 3. pay_booking_start: an open payment was handed back whenever all its bookings were among those asked for, so a
--    payment open for A, handed back for "Pay" on A and B, charged A alone and B silently stayed unpaid; one open for
--    A and B refused paying A alone (PAY_IN_PROGRESS) until it ran out, and with a hold A was then let go. The open
--    payment is now handed back only when it is for exactly the bookings still to pay, at what each owes now. Any other
--    gives way to a new payment for what is due: a payment without a hold is cancelled (money still reaching it is
--    applied and the excess refunded, as for any late payment); one that holds places keeps running, and a place it
--    holds keeps that hold and that payment, so it is still let go when the hold runs out unpaid. A new payment never
--    lengthens or ends a hold.
-- 4. staff_pay_refund_decline: any staffer with can_refund could decline a refund owed to a customer (the money is
--    kept, dest 'none'), while sending one is an admin's (staff_pay_refund_begin since 20261110235200). Declining now
--    needs an admin with can_refund too (ADMIN_ONLY, then CAP_REFUND, as staff_pay_refund_begin). The signature is
--    unchanged, so the staff app's current call keeps working for admins.
--
-- Each function is replaced from its live staging definition (header copied from pg_get_functiondef, the live text
-- checked by md5 before the fix); CREATE OR REPLACE keeps the grants. Idempotent. Run
-- supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $pre$
begin
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261110235500') then
    raise exception 'apply 20261110235500_bh10_payments_b.sql first: this file replaces the pay_booking_start it left';
  end if;
end $pre$;

-- 1 pay_booking_cancel ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pay_booking_cancel(p_key text, p_id text, p_token text, p_ids text[], p_dest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q queue_entries%rowtype; s sessions%rowtype; dest text; late boolean; rf payment_refunds%rowtype; outv jsonb := '[]'::jsonb;
        days int := _pay_int('pay.refundDays', 1, 0, 30); bid text; ended boolean;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_dest is null or p_dest not in ('wallet', 'card') then raise exception 'PAY_DEST' using errcode = 'P0001'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 20 then raise exception 'PAY_NOTHING' using errcode = 'P0001'; end if;
  foreach bid in array (select array_agg(distinct x order by x) from unnest(p_ids) x) loop
    select * into q from queue_entries where id = bid and customer_id = p_id for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
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
    perform set_config('mm.pay_refund_dest', coalesce(dest, 'none'), true);
    update queue_entries set status = 'cancelled', cancel_reason = 'customer', cancelled_by = 'customer', cancelled_at = now(),
                             pay_hold_until = null
     where id = q.id;
    perform set_config('mm.pay_refund_dest', '', true);
    if dest = 'wallet' then
      perform set_config('mm.wallet_op', 'Cancelled online booking', true);
      perform _wallet_post(_wallet_owner(p_id), q.card_amount, 'refund', 'online', q.card_amount, q.id, 'pay-' || q.payment_id, q.session_id);
      perform set_config('mm.wallet_op', '', true);
      insert into payment_refunds (payment_id, provider_id, amount, dest, status, reason, booking_id, by_name, done_at)
      select q.payment_id, p.provider_id, q.card_amount, 'wallet', 'done', 'rider cancelled', q.id, 'customer', now()
        from payments p where p.id = q.payment_id;
      perform _pay_event(q.payment_id, 'customer', 'refund_wallet', null, q.id);
    elsif dest = 'card' then
      insert into payment_refunds (payment_id, provider_id, amount, dest, status, reason, booking_id, by_name)
      select q.payment_id, p.provider_id, q.card_amount, 'card', 'pending', 'rider cancelled', q.id, 'customer'
        from payments p where p.id = q.payment_id
      returning * into rf;
      perform _pay_event(q.payment_id, 'customer', 'refund_card', rf.provider_id, q.id);
      outv := outv || jsonb_build_array(jsonb_build_object('id', rf.id, 'provider_id', rf.provider_id, 'amount', rf.amount));
    elsif dest = 'none' then
      insert into payment_refunds (payment_id, provider_id, amount, dest, status, reason, booking_id, by_name)
      select q.payment_id, p.provider_id, q.card_amount, 'none', 'declined', 'cancelled too late for a refund', q.id, 'customer'
        from payments p where p.id = q.payment_id;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'refunds', outv);
end $function$;

-- 2 _pay_apply --------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._pay_apply(p payments)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l jsonb; q queue_entries%rowtype; amt numeric; back numeric := 0; o store_orders%rowtype; i store_order_items%rowtype;
        r locker_rentals%rowtype; j workshop_jobs%rowtype; ok boolean; w numeric; due numeric;
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
      exception when others then ok := false;
      end;
      if not ok then return p.amount; end if;
    else
      return p.amount;
    end if;
    update store_orders set status = 'paid', paid_at = now(), expires_at = null, cancel_reason = null where id = o.id;
    insert into store_order_events (order_id, status, note) values (o.id, 'paid', null);
    insert into receipt_numbers (receipt_id) values ('ord-' || o.no) on conflict (receipt_id) do nothing;
  elsif p.kind = 'locker' then
    for l in select x from jsonb_array_elements(p.lines) x loop
      amt := (l ->> 'amount')::numeric;
      select * into r from locker_rentals where id = (l ->> 'id')::uuid for update;
      if r.id is null or r.receipt_id is not null then back := back + amt; continue; end if;
      if r.status = 'cancelled' then
        if r.cancel_reason is distinct from 'unpaid'
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

-- 3 pay_booking_start -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pay_booking_start(p_key text, p_id text, p_token text, p_ids text[], p_hold boolean DEFAULT false, p_wallet boolean DEFAULT false, p_lang text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q queue_entries%rowtype; s sessions%rowtype; ids text[]; lines jsonb := '[]'::jsonb; total numeric := 0;
        due numeric; p payments%rowtype; mins int; bid text; days text; kinds text; give numeric; g numeric; who text;
        op payments%rowtype;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _pay_on('pay.enabled') then raise exception 'PAY_OFF' using errcode = 'P0001'; end if;
  select array_agg(distinct x order by x) into ids from unnest(coalesce(p_ids, '{}'::text[])) x where x ~ '^[A-Za-z0-9_-]{1,64}$';
  if coalesce(array_length(ids, 1), 0) = 0 or array_length(ids, 1) > 20 then raise exception 'PAY_NOTHING' using errcode = 'P0001'; end if;

  /* these bookings already being paid: that payment again (a reload, a second tap), but only when it is for exactly
     the ones still to pay, at what each owes now. One open for A was handed back for A and B, so B was never charged;
     one open for A and B refused A alone (PAY_IN_PROGRESS) until it ran out, and with a hold A was then let go. Any
     other open payment now gives way to a new one for what is due (below) (bug hunt 2026-11-11 (20261111235200)) */
  select * into op from payments
   where kind = 'booking' and status = 'initiated' and customer_id = p_id and expires_at > now() and refs && ids
   order by created_at desc limit 1;
  if op.id is not null and not exists (
       (select l ->> 'id' as id, (l ->> 'amount')::numeric as amount from jsonb_array_elements(op.lines) l
        except
        select e.id, _pay_due(e) from queue_entries e
         where e.id = any(ids) and e.customer_id = p_id and not coalesce(e.paid, false)
           and coalesce(e.status, '') in ('waiting', 'active') and _pay_due(e) > 0)
       union all
       (select e.id, _pay_due(e) from queue_entries e
         where e.id = any(ids) and e.customer_id = p_id and not coalesce(e.paid, false)
           and coalesce(e.status, '') in ('waiting', 'active') and _pay_due(e) > 0
        except
        select l ->> 'id', (l ->> 'amount')::numeric from jsonb_array_elements(op.lines) l)) then
    return _pay_json(op);
  end if;

  if p_wallet then
    begin  -- the wallet pays what it can (the rider's switch); what it may not pay is left to the card
      perform customer_wallet_pay(p_id, p_token, ids);
    exception when others then null;
    end;
  end if;

  foreach bid in array ids loop
    select * into q from queue_entries where id = bid and customer_id = p_id for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    select * into s from sessions where id = q.session_id;
    if coalesce(q.paid, false) then continue; end if;
    if coalesce(q.status, '') not in ('waiting', 'active') then raise exception 'PAY_NOT_OPEN' using errcode = 'P0001'; end if;
    if coalesce(s.ride_kind, '') in ('petromin', 'vlap', 'arena') then raise exception 'PAY_NOT_OPEN' using errcode = 'P0001'; end if;
    if left(coalesce(s.session_date, q.session_date), 10) < to_char(_pay_today(), 'YYYY-MM-DD') then
      raise exception 'PAY_NOT_OPEN' using errcode = 'P0001';
    end if;
    due := _pay_due(q);
    if due <= 0 then continue; end if;
    lines := lines || jsonb_build_array(jsonb_build_object('id', q.id, 'amount', due));
    total := total + due;
  end loop;

  /* the open payment given way to: one that holds places keeps running, so a place it holds is still let go when it
     runs out unpaid (that place keeps it, below); any other is cancelled. Money still reaching either is applied and
     what is paid twice refunded, as for any late payment (pay_settle, _pay_apply) */
  if op.id is not null and not op.hold then
    update payments set status = 'cancelled' where id = op.id and status = 'initiated';
    perform _pay_event(op.id, 'start', 'cancelled', null, 'replaced by a new payment');
  end if;

  if total <= 0 then
    return jsonb_build_object('id', null, 'amount', 0, 'status', 'paid');  -- nothing left to pay (the wallet covered it)
  end if;
  /* the wallet left the card less than Moyasar's 1 SAR (199.50 against two rides of 100): it gives back, from the
     bookings it paid in part, what makes the card's part 1 SAR, rather than PAY_TOO_SMALL undoing them, as
     store_checkout does (bug hunt 2026-11-10 (20261110235500)). Not enough to give back: PAY_TOO_SMALL as before. */
  if total > 0 and total < 1 then
    give := round(1 - total, 2);
    for q in select e.* from queue_entries e
              where e.id in (select l ->> 'id' from jsonb_array_elements(lines) l)
                and coalesce(e.wallet_paid, 0) > 0 and not coalesce(e.paid, false)
              order by e.wallet_paid desc, e.id loop
      exit when give <= 0;
      g := least(give, q.wallet_paid);
      select _wallet_owner(l.customer_id) into who from wallet_ledger l
       where l.booking_id = q.id and l.kind = 'spend' order by l.id desc limit 1;
      perform _wallet_post(coalesce(who, _wallet_owner(q.customer_id)), g, 'return', null, null, q.id, null, q.session_id);
      perform set_config('mm.wallet_ok', '1', true);
      update queue_entries set wallet_paid = wallet_paid - g where id = q.id;
      perform set_config('mm.wallet_ok', '', true);
      give := give - g;
    end loop;
    if give <= 0 then  /* the lines again, at what the card pays now */
      select jsonb_agg(jsonb_build_object('id', e.id, 'amount', _pay_due(e)) order by t.o), sum(_pay_due(e))
        into lines, total
        from jsonb_array_elements(lines) with ordinality t(l, o) join queue_entries e on e.id = t.l ->> 'id';
    end if;
  end if;
  if total < 1 then raise exception 'PAY_TOO_SMALL' using errcode = 'P0001'; end if;

  mins := case when p_hold then _pay_int('pay.holdMinutes', 15, 5, 60) else 60 end;
  select string_agg(distinct coalesce(nullif(btrim(se.title), ''), 'Ride'), ', '),
         string_agg(distinct left(coalesce(se.session_date, e.session_date), 10), ', ')
    into kinds, days
    from queue_entries e left join sessions se on se.id = e.session_id
   where e.id in (select l ->> 'id' from jsonb_array_elements(lines) l);
  p := _pay_new('booking', lines -> 0 ->> 'id',
                array(select l ->> 'id' from jsonb_array_elements(lines) l order by 1), lines, p_id, total,
                left(coalesce(kinds, 'Ride') || ' · ' || coalesce(days, ''), 120), mins, p_hold, p_lang);
  /* a place still held for an earlier payment keeps that hold and that payment, which lets it go when it runs out
     unpaid: a new payment never lengthens or ends a hold, and this one still pays it (20261111235200) */
  update queue_entries set payment_id = p.id,
         pay_hold_until = case when p_hold then p.expires_at else pay_hold_until end
   where id = any(p.refs) and pay_hold_until is null;
  return _pay_json(p);
end $function$;

-- 4 staff_pay_refund_decline ------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_pay_refund_decline(p_refund uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r payment_refunds%rowtype; who text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  /* declining keeps the customer's money: an admin's decision, as sending a refund is (staff_pay_refund_begin since
     20261110235200); any staffer with can_refund could decline (bug hunt 2026-11-11 (20261111235200)) */
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  select coalesce(nullif(btrim(s.display_name), ''), 'Staff') into who from staff s where s.user_id = auth.uid();
  update payment_refunds set status = 'declined', dest = 'none', reason = left(coalesce(nullif(btrim(p_reason), ''), reason), 200),
                             by_user = auth.uid(), by_name = left(who, 60), done_at = now()
   where id = p_refund and status in ('due', 'failed') returning * into r;
  if r.id is null then raise exception 'PAY_REFUND_STATE' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', r.id, 'status', r.status);
end $function$;

-- checks: every function kept SECURITY DEFINER and its search_path; the inner one no client may run
do $chk$
declare f text;
begin
  foreach f in array array['public.pay_booking_cancel(text,text,text,text[],text)', 'public._pay_apply(public.payments)',
                           'public.pay_booking_start(text,text,text,text[],boolean,boolean,text)',
                           'public.staff_pay_refund_decline(uuid,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public._pay_apply(public.payments)', 'execute')
     or has_function_privilege('authenticated', 'public._pay_apply(public.payments)', 'execute') then
    raise exception '_pay_apply is executable by a client';
  end if;
  if has_function_privilege('anon', 'public.staff_pay_refund_decline(uuid,text)', 'execute') then
    raise exception 'staff_pay_refund_decline is executable by anon';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111235200', 'bh11_payments')
on conflict (version) do nothing;

commit;
