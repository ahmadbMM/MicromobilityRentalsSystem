-- ============================================================================
-- Bug hunt 2026-11-10 (bh10): online payments, the store and card-paid lockers. STAGING ONLY for now: the online
-- payments of 20261110150000 exist only on staging. When payments go live, this file goes to production right after
-- 20261110150000 (customer_locker_change, item 7, is a production function as well: see its note).
--
-- 1. _pay_apply, for a booking whose pay hold ran out (its place let go, cancel_reason 'unpaid') and whose card
--    payment came in after (a slow 3-D Secure, a late webhook, the reconcile run):
--    (a) it came back on the ride whatever the ride held by then. No trigger counts places on a change of status, so
--        a place taken meanwhile made the ride one over. It now comes back only to a ride still taking riders and
--        only into a place still free as a new booking would find it: the waitlist counted, bikes out of service,
--        the members' limit and the account's own limit (_pay_place_free, new). Otherwise its card is refunded
--        ('place no longer held') and it stays cancelled.
--    (b) it was marked paid with the card's part alone. The wallet's part, given back to the wallet when the place
--        was let go, was never taken again: a 100 SAR ride paid 30 from the wallet and 70 by card ended paid with the
--        30 back in the wallet. What the card does not cover is now taken from the wallet again, as the store
--        order's branch already did: all of it or none, and only from a rider who let the wallet pay this booking
--        (the price can go up on the way back when a code is used up). Otherwise the card is refunded and the
--        booking stays cancelled.
--    (c) a workshop job was marked paid by any payment of its own, even one started before staff changed the price
--        (100 SAR on a 150 SAR job). The payment must now be the job's price, or it is refunded and the job stays
--        to pay.
-- 2. _pay_release: a held booking let go when its payment ran out freed a place, but nobody on the waitlist moved
--    up (the fill rule counts the waitlist, so the night stayed 'full') and the ride went out a rider short. The
--    places now go to the waitlist in its order, as when a rider cancels, by _session_capacity_promote's rule: an
--    open night or one full by the count; never an approval ride, a full staff set or a night gone. The staff and
--    claim modes of Settings run as _promote_next_waitlist runs them.
-- 3. pay_reconcile_list:
--    (a) every pending card refund on one Moyasar payment got the same 'already' (the payment's refunded total), so
--        one refund that went through confirmed a second that never reached Moyasar: the rider was short and the
--        payment showed refunded. 'already' is now each refund's own: the card refunds done on that Moyasar payment
--        and those pending that were sent before it.
--    (b) a payment staff cancelled (a store order cancelled while its rider was in 3-D Secure) was never asked about
--        again, though money can still arrive on it. Cancelled payments are now asked about as expired ones are.
-- 4. pay_refund_done:
--    (a) the payment's refunded total was Moyasar's total or the old total plus this refund, whichever was more, so a
--        refund already inside an earlier answer (its own answer lost) was counted twice. It is now Moyasar's total
--        or the refunds done, whichever is more.
--    (b) a refund the reconcile run marked failed while the server was still sending it stayed failed when Moyasar's
--        answer came back accepted (payments.refunded short, and a retry refunds twice). That answer now records it
--        done when Moyasar's total shows it.
--    (c) a failed card refund of a wallet top-up puts back into the wallet what item 5(a) took out, for a retry.
-- 5. staff_pay_refund_begin:
--    (a) a wallet top-up's refund paid the money out twice: 'To wallet' credited the wallet a second time, and 'To
--        card' sent the money back while the top-up stayed in the wallet, spent or not. A top-up's own money is now
--        refunded to the card only (PAY_DEST for the wallet), and it leaves the wallet first ('takeout'; WALLET_SHORT
--        when it is spent). A refund owed on another Moyasar payment (a payment made twice) now keeps that payment when it
--        is retried; it was sent against the payment that paid.
--    (b) a store order refunded wholly into the wallet stayed 'cancelled': only the card's answer moved an order to
--        'refunded'. The wallet refund now runs the same check.
--    (c) a refund owed for days (a locker's, a cancelled booking's) or a failed one retried kept its old created_at,
--        so the reconcile run's two-minute grace did not cover it and the run could mark it failed while it was
--        being sent. created_at is now the moment it is sent.
-- 6. store_checkout: a wallet that left less than 1 SAR for the card (149.50 against 150) failed the checkout every
--    time (PAY_TOO_SMALL: Moyasar takes no less than 1 SAR). The wallet now leaves the card 1 SAR in that case.
-- 7. customer_locker_change: a locker paid by card took a change of time at another fee as if the wallet had paid
--    it. The card payment was neither refunded nor credited, the whole new fee was taken from the wallet (or the
--    change was refused WALLET_SHORT), and a later Remove gave back only the wallet's. A card locker now changes only
--    to a time of the same fee (another locker, early or late); another fee is the desk's (LOCKER_NOT_OPEN), as a
--    paid ride bill's is. The same holds while its card payment is still open, which would settle at the old amount.
--    This is a production function too, identical on production and staging today. Nothing is paid by card on
--    production, so there it changes nothing; if production's copy changes before this file goes there, rebuild
--    item 7 from production's copy.
--
-- Each function is replaced from its live staging definition (checked by md5: identical to the text of
-- 20261110150000 / 20261109233000 in the repo); CREATE OR REPLACE keeps the grants. _pay_place_free is new and no
-- client may run it. Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- 1 (a) _pay_place_free (new) -----------------------------------------------
-- May a booking that let its place go when its pay hold ran out come back now that its money is in? The checks a new
-- booking meets (the INSERT guards): a ride still taking riders (open or full, not past, not ended), a place free with
-- the waitlist counted (_session_has_room, which takes the lock new bookings take), bikes out of service
-- (_out_bikes_guard), the members' limit (_community_booking_gate) and the account's own limit (_group_ride_cap,
-- _solo_ride_cap).
CREATE OR REPLACE FUNCTION public._pay_place_free(q queue_entries)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s sessions%rowtype; ended boolean; own boolean; outn int; n int; live int; slots jsonb; places int; cap int; jcc boolean;
begin
  select * into s from sessions where id = q.session_id;
  if s.id is null or coalesce(s.status, '') not in ('open', 'full')
     or coalesce(s.session_date, '') < to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD') then
    return false;
  end if;
  begin ended := (select w.ends_at from _session_window(s) w) <= now();
  exception when others then ended := false; end;
  if coalesce(ended, false) then return false; end if;
  /* the ride's places, the waitlist counted */
  if not _session_has_room(q.session_id, q.type_preference, q.id) then return false; end if;
  select * into s from sessions where id = q.session_id;
  own := coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin';
  /* bikes out of service, as _out_bikes_guard counts them */
  if not coalesce(s.needs_approval, false) and s.out_bikes is not null and s.out_bikes <> '{}'::jsonb
     and (coalesce(q.type_preference, '') <> 'Own' or own) then
    select coalesce(sum(greatest(0, floor((value #>> '{}')::numeric))), 0)::int into outn
      from jsonb_each(s.out_bikes) where jsonb_typeof(value) = 'number';
    if outn > 0 then
      select count(*) into live from queue_entries x
       where x.session_id = q.session_id and x.id <> q.id
         and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow')
         and (own or coalesce(x.type_preference, '') <> 'Own');
      if live >= greatest(0, coalesce(s.capacity, 12) - outn) then return false; end if;
      if jsonb_typeof(s.out_bikes -> q.type_preference) = 'number' then
        n := greatest(0, floor((s.out_bikes ->> q.type_preference)::numeric))::int;
        if n > 0 then
          begin slots := coalesce(nullif(s.bike_slots, '')::jsonb, '{}'::jsonb);
          exception when others then slots := '{}'::jsonb; end;
          if jsonb_typeof(slots -> '_bikes') = 'array' then
            select count(*) into places from bikes b
             where b.type = q.type_preference and b.id::text in (select jsonb_array_elements_text(slots -> '_bikes'));
          elsif jsonb_typeof(slots -> q.type_preference) = 'number' then
            places := (slots ->> q.type_preference)::numeric::int;
          elsif jsonb_typeof(slots -> q.type_preference) = 'object' then
            select coalesce(sum((value #>> '{}')::numeric), 0)::int into places
              from jsonb_each(slots -> q.type_preference) where jsonb_typeof(value) = 'number';
          end if;
          if places is not null then
            select count(*) into live from queue_entries x
             where x.session_id = q.session_id and x.id <> q.id and x.type_preference = q.type_preference
               and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow');
            if live >= greatest(0, places - n) then return false; end if;
          end if;
        end if;
      end if;
    end if;
  end if;
  /* the members' limit, as _community_booking_gate counts it (own bikes and a partner's riders aside) */
  if s.member_cap is not null and q.partner is null and coalesce(q.type_preference, '') <> 'Own' then
    perform pg_advisory_xact_lock(hashtext('membercap:' || s.id));
    select count(*) into live from queue_entries x
     where x.session_id = s.id and x.partner is null and x.id <> q.id
       and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow', 'waitlist');
    if live >= s.member_cap then return false; end if;
  end if;
  /* the account's own limit, as _group_ride_cap and _solo_ride_cap count it */
  if q.customer_id is not null then
    perform pg_advisory_xact_lock(hashtext('ridecap:' || coalesce(q.session_id, '') || ':' || q.customer_id));
    jcc := not (coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') <> 'snd96');
    cap := case when not jcc then case when coalesce(s.needs_approval, false) then null
                                       when coalesce(s.ride_kind, '') = 'event' then _biz_int('event_seat_max', 5)
                                       else _biz_int('group_ride_max', 2) end
                else _biz_int('jcc_account_cap', 3) end;
    if cap is not null then
      select count(*) into live from queue_entries x
       where x.session_id = q.session_id and x.customer_id = q.customer_id and x.id <> q.id
         and case when jcc then coalesce(x.status, '') in ('waiting', 'active', 'waitlist')
                  else coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow') end;
      if live >= cap then return false; end if;
    end if;
    if coalesce(s.event_kind, '') = 'community' and coalesce(s.needs_approval, false)
       and exists (select 1 from queue_entries x where x.session_id = q.session_id and x.customer_id = q.customer_id
                     and x.id <> q.id and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow')) then
      return false;
    end if;
  end if;
  return true;
end $function$;
revoke execute on function public._pay_place_free(public.queue_entries) from public, anon, authenticated;

-- 1 _pay_apply -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._pay_apply(p payments)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l jsonb; q queue_entries%rowtype; amt numeric; back numeric := 0; o store_orders%rowtype; i store_order_items%rowtype;
        r locker_rentals%rowtype; j workshop_jobs%rowtype; ok boolean; w numeric;
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

-- 2 _pay_release -----------------------------------------------------------
CREATE OR REPLACE FUNCTION public._pay_release(p payments, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o store_orders%rowtype; sids text[]; sid text; s sessions%rowtype; n int;
begin
  if p.kind = 'booking' and p.hold then
    perform set_config('mm.pay_ok', '1', true);
    with gone as (
      update queue_entries set status = 'cancelled', cancel_reason = 'unpaid', cancelled_by = 'system', cancelled_at = now(),
                               pay_hold_until = null
       where id = any(p.refs) and payment_id = p.id and not coalesce(paid, false) and pay_hold_until is not null
         and coalesce(status, '') in ('waiting', 'waitlist')
      returning session_id)
    select array_agg(distinct session_id) into sids from gone;
    perform set_config('mm.pay_ok', '', true);
    /* the places let go go to the waitlist in its order, as when a rider cancels (bug hunt 2026-11-10: the fill rule
       counts the waitlist, so the night stayed 'full' and nobody moved up). As _session_capacity_promote: an open
       night or one full by the count; never an approval ride, a full staff set or a night gone */
    foreach sid in array coalesce(sids, '{}'::text[]) loop
      select * into s from sessions where id = sid;
      if s.id is null or coalesce(s.needs_approval, false)
         or coalesce(s.session_date, '') < to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
         or not (coalesce(s.status, '') = 'open' or (s.status = 'full' and coalesce(s.auto_full, false))) then
        continue;
      end if;
      n := 0;
      while n < 500 and _promote_next_waitlist(sid) is not null loop
        n := n + 1;
      end loop;
    end loop;
  elsif p.kind = 'order' then
    select * into o from store_orders where id = p.ref::uuid for update;
    if o.status = 'pending' then
      perform _store_restock(o.id);
      if o.wallet_paid > 0 then
        perform _wallet_post(_wallet_owner(o.customer_id), o.wallet_paid, 'sale_back', null, null, null, 'ord-' || o.no, null);
      end if;
      update store_orders set status = 'cancelled', cancel_reason = 'unpaid', expires_at = null where id = o.id;
      insert into store_order_events (order_id, status, note) values (o.id, 'cancelled', p_reason);
    end if;
  elsif p.kind = 'locker' then
    update locker_rentals set status = 'cancelled', cancel_reason = 'unpaid', cancelled_by = 'system', cancelled_at = now()
     where id::text = any(p.refs) and payment_id = p.id and status = 'reserved' and receipt_id is null and pay = 'card';
  end if;
end $function$;

-- 3 pay_reconcile_list ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.pay_reconcile_list(p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  return jsonb_build_object(
    /* a payment staff cancelled (a store order) can still be paid by a rider in 3-D Secure: asked about as an
       expired one (bug hunt 2026-11-10) */
    'payments', coalesce((select jsonb_agg(x.id) from (
                   select p.id from payments p
                    where p.status in ('initiated', 'expired', 'cancelled') and p.created_at > now() - interval '3 days'
                      and p.created_at < now() - interval '2 minutes'
                      and coalesce(p.checked_at, p.created_at) < now() - case when p.status = 'initiated' then interval '3 minutes' else interval '30 minutes' end
                    order by coalesce(p.checked_at, p.created_at) limit 20) x), '[]'::jsonb),
    -- a card refund still pending minutes later: confirmed against Moyasar's refunded total ('already' = what this
    -- database counted for that Moyasar payment before it), never sent twice
    /* 'already' is each refund's own (bug hunt 2026-11-10): the card refunds done on that Moyasar payment and those
       pending that were sent before it, so one refund that went through never confirms a second that never left */
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'provider_id', r.provider_id, 'amount', r.amount,
                                                             'already', coalesce((select sum(x.amount) from payment_refunds x
                                                                where x.payment_id = r.payment_id and x.provider_id = r.provider_id
                                                                  and x.dest = 'card' and x.id <> r.id
                                                                  and (x.status = 'done'
                                                                       or (x.status = 'pending' and (x.created_at, x.id) < (r.created_at, r.id)))), 0))
                                        order by r.created_at, r.id)
                           from (select * from payment_refunds where status = 'pending' and dest = 'card'
                                   and created_at < now() - interval '2 minutes' order by created_at limit 10) r), '[]'::jsonb));
end $function$;

-- 4 pay_refund_done -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pay_refund_done(p_key text, p_refund uuid, p_ok boolean, p_refunded_halalas integer, p_error text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r payment_refunds%rowtype; p payments%rowtype; tot numeric; done_sum numeric; late boolean := false; topup boolean;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into r from payment_refunds where id = p_refund for update;
  if r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into p from payments where id = r.payment_id for update;
  /* a wallet top-up's own refund took its money out of the wallet when it was sent (staff_pay_refund_begin); one owed
     on another Moyasar payment of it (paid twice) never was in the wallet */
  topup := p.kind = 'topup' and r.provider_id is not distinct from p.provider_id;
  if r.status <> 'pending' then
    /* the reconcile run marked it failed while this server was still sending it, and Moyasar took it: done after all
       (bug hunt 2026-11-10) */
    if not (coalesce(p_ok, false) and r.status = 'failed' and r.dest = 'card') then
      return jsonb_build_object('ok', true, 'status', r.status);
    end if;
    late := true;
  end if;
  if not p_ok then
    update payment_refunds set status = 'failed', error = left(p_error, 300) where id = r.id;
    if topup then  /* its money goes back into the wallet, for a retry to take out again */
      perform set_config('mm.wallet_note', 'card refund failed', true);
      perform _wallet_post(_wallet_owner(p.customer_id), r.amount, 'adjust', null, null, null, 'pay-' || p.id, null);
      perform set_config('mm.wallet_note', '', true);
    end if;
    perform _pay_event(r.payment_id, 'refund', 'failed', r.provider_id, p_error);
    return jsonb_build_object('ok', false, 'status', 'failed');
  end if;
  /* what this database counts done on that Moyasar payment, this refund aside */
  select coalesce(sum(x.amount), 0) into done_sum from payment_refunds x
   where x.payment_id = r.payment_id and x.provider_id is not distinct from r.provider_id and x.dest = 'card'
     and x.status = 'done' and x.id <> r.id;
  if late then
    if coalesce(p_refunded_halalas, 0) / 100.0 < done_sum + r.amount then
      return jsonb_build_object('ok', true, 'status', r.status);  /* Moyasar's total does not show it */
    end if;
    if topup then  /* the failure put its money back into the wallet: out again */
      perform set_config('mm.wallet_note', 'card refund went through', true);
      perform _wallet_post(_wallet_owner(p.customer_id), -r.amount, 'takeout', 'online', null, null, 'pay-' || p.id, null);
      perform set_config('mm.wallet_note', '', true);
    end if;
  end if;
  update payment_refunds set status = 'done', done_at = now(), error = null where id = r.id;
  if r.provider_id is not distinct from p.provider_id then
    /* Moyasar's total, or the refunds done with this one, whichever is more (bug hunt 2026-11-10: the old total plus
       this refund counted it twice when Moyasar's earlier answer already held it) */
    tot := greatest(coalesce(p_refunded_halalas, 0) / 100.0, done_sum + r.amount);
    update payments set refunded = least(tot, amount),
                        status = case when least(tot, amount) >= amount then 'refunded' else 'partly_refunded' end
     where id = p.id;
  end if;
  if r.order_id is not null then
    insert into store_order_events (order_id, status, note, by_name) values (r.order_id, 'refund', r.amount::text || ' SAR', r.by_name);
    update store_orders set status = 'refunded'
     where id = r.order_id and status = 'cancelled'
       and (select coalesce(sum(x.amount), 0) from payment_refunds x where x.order_id = r.order_id and x.status = 'done' and x.dest in ('card', 'wallet'))
           >= total - wallet_paid;
  end if;
  perform _pay_event(r.payment_id, 'refund', 'done', r.provider_id, r.amount::text);
  return jsonb_build_object('ok', true, 'status', 'done');
end $function$;

-- 5 staff_pay_refund_begin ------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_pay_refund_begin(p_payment uuid, p_amount numeric, p_dest text, p_reason text, p_refund uuid DEFAULT NULL::uuid, p_op text DEFAULT NULL::text, p_approval text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p payments%rowtype; r payment_refunds%rowtype; room numeric; who text; amt numeric; owner text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if p_dest is null or p_dest not in ('card', 'wallet') then raise exception 'PAY_DEST' using errcode = 'P0001'; end if;
  if p_refund is not null then
    select * into r from payment_refunds where id = p_refund for update;
    if r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if r.status not in ('due', 'failed') then raise exception 'PAY_REFUND_STATE' using errcode = 'P0001'; end if;
    p_payment := r.payment_id;
  end if;
  select * into p from payments where id = p_payment for update;
  if p.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p.status not in ('paid', 'partly_refunded') then raise exception 'PAY_NOT_PAID' using errcode = 'P0001'; end if;
  /* a wallet top-up put its money in the wallet: that money is refunded to the card only, out of the wallet (bug hunt
     2026-11-10: 'To wallet' credited it a second time); one owed on another Moyasar payment of it (paid twice) may go
     either way */
  if p.kind = 'topup' and p_dest = 'wallet' and coalesce(r.provider_id, p.provider_id) is not distinct from p.provider_id then
    raise exception 'PAY_DEST' using errcode = 'P0001';
  end if;
  amt := round(coalesce(p_amount, r.amount), 2);
  if amt is null or amt <= 0 then raise exception 'PAY_AMOUNT' using errcode = 'P0001'; end if;
  room := p.amount - p.refunded - coalesce((select sum(x.amount) from payment_refunds x where x.payment_id = p.id
                                              and ((x.status = 'pending' and x.dest = 'card') or (x.status = 'done' and x.dest = 'wallet'))
                                              and x.id is distinct from r.id), 0);
  if amt > room then raise exception 'PAY_TOO_MUCH' using errcode = 'P0001'; end if;
  if not _mgr_ok('refund', amt, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  select coalesce(nullif(btrim(s.display_name), ''), 'Staff') into who from staff s where s.user_id = auth.uid();
  if r.id is null then
    insert into payment_refunds (payment_id, provider_id, amount, status, reason, by_user, by_name,
                                 order_id, booking_id)
    values (p.id, p.provider_id, amt, 'due', left(p_reason, 200), auth.uid(), left(coalesce(p_op, who), 60),
            case when p.kind = 'order' then p.ref::uuid end, case when p.kind = 'booking' and array_length(p.refs, 1) = 1 then p.refs[1] end)
    returning * into r;
  end if;
  if p_dest = 'wallet' then
    owner := coalesce(p.customer_id, (select o.customer_id from store_orders o where o.id = r.order_id));
    if owner is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
    perform set_config('mm.wallet_op', left(coalesce(p_op, who), 40), true);
    perform set_config('mm.wallet_note', coalesce(p_reason, ''), true);
    perform _wallet_post(_wallet_owner(owner), amt, 'refund', 'online', amt, r.booking_id, 'pay-' || p.id, null);
    perform set_config('mm.wallet_op', '', true);
    perform set_config('mm.wallet_note', '', true);
    update payment_refunds set amount = amt, dest = 'wallet', status = 'done', done_at = now(), reason = coalesce(left(p_reason, 200), reason),
                               by_user = auth.uid(), by_name = left(coalesce(p_op, who), 60), error = null
     where id = r.id returning * into r;
    if r.order_id is not null then
      insert into store_order_events (order_id, status, note, by_name) values (r.order_id, 'refund', amt::text || ' SAR · wallet', r.by_name);
      /* refunded whole: 'refunded', as the card's answer does it in pay_refund_done (bug hunt 2026-11-10) */
      update store_orders set status = 'refunded'
       where id = r.order_id and status = 'cancelled'
         and (select coalesce(sum(x.amount), 0) from payment_refunds x where x.order_id = r.order_id and x.status = 'done' and x.dest in ('card', 'wallet'))
             >= total - wallet_paid;
    end if;
    perform _pay_event(p.id, 'staff', 'refund_wallet', null, amt::text);
  else
    /* a top-up's own money leaves the wallet now (WALLET_SHORT when it is spent); a failed send puts it back
       (pay_refund_done). A refund owed on another Moyasar payment of it (paid twice) was never in the wallet
       (bug hunt 2026-11-10: the card got the money back and the wallet kept it) */
    if p.kind = 'topup' and coalesce(r.provider_id, p.provider_id) is not distinct from p.provider_id then
      perform set_config('mm.wallet_op', left(coalesce(p_op, who), 40), true);
      perform set_config('mm.wallet_note', coalesce(p_reason, ''), true);
      perform _wallet_post(_wallet_owner(p.customer_id), -amt, 'takeout', 'online', null, null, 'pay-' || p.id, null);
      perform set_config('mm.wallet_op', '', true);
      perform set_config('mm.wallet_note', '', true);
    end if;
    /* sent now, so the reconcile run's two-minute grace starts now (a refund owed for days, or a failed one retried,
       was in its list at once and could be marked failed while being sent); a refund owed on another Moyasar payment
       goes to that one (bug hunt 2026-11-10) */
    update payment_refunds set amount = amt, dest = 'card', status = 'pending', provider_id = coalesce(provider_id, p.provider_id),
                               created_at = now(),
                               reason = coalesce(left(p_reason, 200), reason), by_user = auth.uid(), by_name = left(coalesce(p_op, who), 60), error = null
     where id = r.id returning * into r;
    perform _pay_event(p.id, 'staff', 'refund_card', r.provider_id, amt::text);
  end if;
  return jsonb_build_object('id', r.id, 'status', r.status, 'dest', r.dest, 'amount', r.amount, 'provider_id', r.provider_id);
end $function$;

-- 6 store_checkout --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.store_checkout(p_key text, p_id text, p_token text, p_order jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare it jsonb; v store_variants%rowtype; pr store_products%rowtype; n int := 0; qty int; sub numeric := 0; fee numeric;
        fulfil text := p_order ->> 'fulfil'; name text; phone text; email text; addr jsonb; o store_orders%rowtype;
        p payments%rowtype; due numeric; bal numeric; take numeric := 0; who text; lang text := p_order ->> 'lang';
        mins int := _pay_int('store.orderMinutes', 30, 10, 120); city text; label text;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _pay_on('pay.enabled') or not _pay_on('store.open') then raise exception 'STORE_CLOSED' using errcode = 'P0001'; end if;
  if p_id is not null and not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if fulfil is null or fulfil not in ('pickup', 'jeddah', 'ksa') then raise exception 'STORE_FULFIL' using errcode = 'P0001'; end if;

  name := left(btrim(regexp_replace(coalesce(p_order #>> '{contact,name}', ''), '\s+', ' ', 'g')), 60);
  phone := _pay_phone(p_order #>> '{contact,phone}');
  email := nullif(lower(btrim(coalesce(p_order #>> '{contact,email}', ''))), '');
  if length(name) < 2 then raise exception 'STORE_NAME' using errcode = 'P0001'; end if;
  if phone is null then raise exception 'STORE_PHONE' using errcode = 'P0001'; end if;
  if email is not null and (length(email) > 120 or email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then raise exception 'STORE_EMAIL' using errcode = 'P0001'; end if;

  if fulfil <> 'pickup' then
    addr := jsonb_strip_nulls(jsonb_build_object(
      'city', left(nullif(btrim(p_order #>> '{address,city}'), ''), 40),
      'district', left(nullif(btrim(p_order #>> '{address,district}'), ''), 60),
      'street', left(nullif(btrim(p_order #>> '{address,street}'), ''), 80),
      'building', left(nullif(btrim(p_order #>> '{address,building}'), ''), 10),
      'postal', left(nullif(btrim(p_order #>> '{address,postal}'), ''), 5),
      'extra', left(nullif(btrim(p_order #>> '{address,extra}'), ''), 4),
      'short', upper(left(nullif(btrim(p_order #>> '{address,short}'), ''), 8)),
      'notes', left(nullif(btrim(p_order #>> '{address,notes}'), ''), 200)));
    city := lower(coalesce(addr ->> 'city', ''));
    if coalesce(addr ->> 'district', '') = '' or coalesce(addr ->> 'street', '') = '' or city = '' then
      raise exception 'STORE_ADDRESS' using errcode = 'P0001';
    end if;
    if addr ? 'postal' and (addr ->> 'postal') !~ '^[0-9]{5}$' then raise exception 'STORE_ADDRESS' using errcode = 'P0001'; end if;
    if addr ? 'short' then
      addr := addr || jsonb_build_object('short', translate(addr ->> 'short', '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'));
      if (addr ->> 'short') !~ '^[A-Z]{4}[0-9]{4}$' then raise exception 'STORE_ADDRESS' using errcode = 'P0001'; end if;
    end if;
    -- a courier may not take a parcel without the national address since 2026-01-01 (TGA): its short code
    if fulfil = 'ksa' and not addr ? 'short' then raise exception 'STORE_ADDRESS' using errcode = 'P0001'; end if;
    if fulfil = 'jeddah' and city not in ('jeddah', 'jiddah', 'jedda', 'جدة', 'جده') then raise exception 'STORE_CITY' using errcode = 'P0001'; end if;
  end if;

  if jsonb_typeof(p_order -> 'items') <> 'array' or jsonb_array_length(p_order -> 'items') = 0 or jsonb_array_length(p_order -> 'items') > 20 then
    raise exception 'STORE_EMPTY' using errcode = 'P0001';
  end if;

  insert into store_orders (customer_id, fulfil, name, phone, email, address, note, subtotal, total, lang, expires_at)
  values (p_id, fulfil, name, phone, email, addr, left(nullif(btrim(coalesce(p_order ->> 'note', '')), ''), 300), 0, 0,
          case when lang ~ '^[a-z]{2}$' then lang end, now() + make_interval(mins => mins))
  returning * into o;

  -- each line: the variant locked, live and in stock, at the database's price
  for it in select x from jsonb_array_elements(p_order -> 'items') x order by x ->> 'variant' loop
    qty := case when (it ->> 'qty') ~ '^[0-9]{1,2}$' then (it ->> 'qty')::int else 0 end;
    if qty < 1 or qty > 10 or coalesce(it ->> 'variant', '') !~ '^[0-9a-f-]{36}$' then raise exception 'STORE_ITEM' using errcode = 'P0001'; end if;
    select * into v from store_variants where id = (it ->> 'variant')::uuid for update;
    select * into pr from store_products where id = v.product_id;
    if v.id is null or not v.active or pr.id is null or not pr.published then raise exception 'STORE_GONE: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if v.stock < qty then raise exception 'STORE_STOCK: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if fulfil = 'ksa' and not pr.ship_ksa then raise exception 'STORE_NO_SHIP: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if exists (select 1 from store_order_items i where i.order_id = o.id and i.variant_id = v.id) then raise exception 'STORE_ITEM' using errcode = 'P0001'; end if;
    update store_variants set stock = stock - qty where id = v.id;
    label := nullif(concat_ws(' · ', nullif(v.size, ''), nullif(case when lang = 'ar' then coalesce(v.color_ar, v.color_en) else v.color_en end, '')), '');
    insert into store_order_items (order_id, product_id, variant_id, name, variant, unit_price, qty)
    values (o.id, pr.id, v.id, case when lang = 'ar' then coalesce(pr.name_ar, pr.name_en) else pr.name_en end, label, coalesce(v.price, pr.price), qty);
    sub := sub + coalesce(v.price, pr.price) * qty; n := n + 1;
  end loop;

  fee := _store_delivery_fee(fulfil, sub);
  if fee is null then raise exception 'STORE_FULFIL' using errcode = 'P0001'; end if;
  update store_orders set subtotal = round(sub, 2), delivery_fee = fee, total = round(sub + fee, 2) where id = o.id returning * into o;

  -- the account's wallet pays what it can first, when the customer chose it
  if p_id is not null and coalesce((p_order ->> 'wallet')::boolean, false) then
    who := _wallet_owner(p_id);
    select coalesce(balance, 0) into bal from wallet_balances where customer_id = who for update;
    take := least(coalesce(bal, 0), o.total);
    /* the card takes no less than 1 SAR (Moyasar's least): a wallet that would leave less leaves the card 1 SAR
       (bug hunt 2026-11-10: PAY_TOO_SMALL failed the checkout every time) */
    if o.total - take > 0 and o.total - take < 1 then take := greatest(o.total - 1, 0); end if;
    if take > 0 then
      perform set_config('mm.wallet_op', 'Online store', true);
      perform _wallet_post(who, -take, 'sale', null, null, null, 'ord-' || o.no, null);
      perform set_config('mm.wallet_op', '', true);
      update store_orders set wallet_paid = take where id = o.id returning * into o;
    end if;
  end if;

  insert into store_order_events (order_id, status, note) values (o.id, 'pending', null);
  due := round(o.total - o.wallet_paid, 2);
  if due <= 0 then
    update store_orders set status = 'paid', paid_at = now(), expires_at = null where id = o.id returning * into o;
    insert into store_order_events (order_id, status, note) values (o.id, 'paid', 'wallet');
    insert into receipt_numbers (receipt_id) values ('ord-' || o.no) on conflict (receipt_id) do nothing;
    return jsonb_build_object('order', _store_order_json(o), 'key', o.track_key, 'payment', null);
  end if;
  if due < 1 then raise exception 'PAY_TOO_SMALL' using errcode = 'P0001'; end if;
  p := _pay_new('order', o.id::text, array[o.id::text], jsonb_build_array(jsonb_build_object('id', o.id, 'amount', due)),
                p_id, due, 'Order MM-' || o.no, mins, true, lang);
  update store_orders set payment_id = p.id, expires_at = p.expires_at where id = o.id returning * into o;
  return jsonb_build_object('order', _store_order_json(o), 'key', o.track_key, 'payment', _pay_json(p));
end $function$;

-- 7 customer_locker_change ------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_locker_change(p_id text, p_token text, p_rental uuid, p_period text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r locker_rentals%rowtype; q queue_entries%rowtype; k text; c text; lk lockers%rowtype; fee numeric; cap int; s text;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into r from locker_rentals where id = p_rental;
  if r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if r.booking_id is not null then
    select * into q from queue_entries where id = r.booking_id;
    if q.id is null or q.customer_id is distinct from p_id then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  elsif r.customer_id is distinct from p_id then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform _lk_lock(r.day);
  select * into r from locker_rentals where id = p_rental for update;
  if r.status <> 'reserved' then raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001'; end if;
  if r.booking_id is not null and coalesce((select e.paid from queue_entries e where e.id = r.booking_id), false) then
    raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';  -- a paid bill keeps its fee: the desk changes it
  end if;
  k := _lk_kind(r.session_id);
  if not _lk_period_ok(k, p_period) or _lk_ended(r.day, p_period) then raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001'; end if;
  c := _lk_code(p_code);
  select * into lk from lockers where code = c and status <> 'retired';
  if lk.id is null then raise exception 'LOCKER_UNKNOWN: %', c using errcode = 'P0002'; end if;
  if lk.status <> 'available' then raise exception 'LOCKER_OUT: %', c using errcode = 'P0001'; end if;
  if exists (select 1 from locker_rentals x where x.locker_id = lk.id and x.day = r.day and x.id <> r.id
               and x.status in ('reserved', 'in_use') and _lk_slots(x.period) && _lk_slots(p_period)) then
    raise exception 'LOCKER_TAKEN: %', c using errcode = 'P0001';
  end if;
  -- room in each slot the new time adds, this rental aside
  select count(*) into cap from lockers where status = 'available';
  foreach s in array _lk_slots(p_period) loop
    if not (s = any(_lk_slots(r.period)))
       and (select count(*) from locker_rentals x where x.day = r.day and x.id <> r.id
              and x.status in ('reserved', 'in_use') and s = any(_lk_slots(x.period))) >= cap then
      raise exception 'LOCKERS_FULL' using errcode = 'P0001';
    end if;
  end loop;
  fee := _lk_price(p_period);
  /* paid by card, or its card payment still open: the fee stays what the card pays, another fee is the desk's, as a
     paid bill's (bug hunt 2026-11-10: the change voided nothing, took the whole new fee from the wallet and left the
     card unrefunded; an open payment would settle at the old amount) */
  if (coalesce(r.pay, '') = 'card' or coalesce(r.receipt_id, '') like 'pay-%') and fee is distinct from r.price then
    raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';
  end if;
  if r.receipt_id is not null and fee <> r.price then
    perform _lk_unpay(r.id, 'rider: changed');
    update locker_rentals set receipt_id = null, period = p_period, locker_id = lk.id, price = fee where id = r.id;
    perform _lk_wallet_sale(r.id);
  else
    update locker_rentals set period = p_period, locker_id = lk.id, price = fee where id = r.id;
    if r.receipt_id is not null then  -- the receipt's line says the locker it now is
      update cashier_sales set name = left('Locker ' || lk.code || ' · ' || case p_period when 'early' then '6-8 PM' when 'late' then '9-11 PM'
                                                                                when 'both' then '6-11 PM' else '7-9 PM' end, 120)
       where id = r.receipt_id;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'id', r.id, 'code', lk.code, 'period', p_period, 'price', fee,
                            'paid', (select x.receipt_id is not null from locker_rentals x where x.id = r.id), 'left', _lk_left(r.day));
end $function$;

-- checks: every function kept SECURITY DEFINER and its search_path; the inner ones no client may run
do $chk$
declare f text;
begin
  foreach f in array array['public._pay_place_free(public.queue_entries)', 'public._pay_apply(public.payments)',
                           'public._pay_release(public.payments,text)', 'public.pay_reconcile_list(text)',
                           'public.pay_refund_done(text,uuid,boolean,integer,text)',
                           'public.staff_pay_refund_begin(uuid,numeric,text,text,uuid,text,text)',
                           'public.store_checkout(text,text,text,jsonb)',
                           'public.customer_locker_change(text,text,uuid,text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._pay_place_free(public.queue_entries)', 'public._pay_apply(public.payments)',
                           'public._pay_release(public.payments,text)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.staff_pay_refund_begin(uuid,numeric,text,text,uuid,text,text)', 'execute') then
    raise exception 'staff_pay_refund_begin is executable by anon';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261110235200', 'bh10_payments')
on conflict (version) do nothing;

commit;
