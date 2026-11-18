-- ============================================================================
-- Bug hunt 2026-11-18 (bh18), round 2, package r2stg: online payments and the store. STAGING ONLY, like the files it
-- follows (20261110150000_online_payments, 20261110235200_bh10_payments, 20261110235500_bh10_payments_b,
-- 20261111235200_bh11_payments, 20261115235500_store_build, 20261119000500_bh18_dbstg_staging): production has no
-- payments or store yet, and this file stops unless 20261115235500 and 20261119000500 are in the ledger (it rebuilds
-- pay_booking_cancel from 20261119000500's text, which would undo this file's change if it ran after it). When payments
-- and the store go live, this file goes to production right after 20261119000500.
--
-- stg0-1. pay_booking_cancel (the website's /api/pay/cancel): 20261119000500 (sql08-1) caps the refund at what is left
--    of the payment. A payment that paid several bookings still had room after staff refunded one of them from
--    Payments (staff_pay_refund_begin leaves the booking open, its refund row carries the booking), so that booking's
--    cancel refunded its whole card_amount a second time out of the other bookings' money. The refund is now also no
--    more than the booking's card_amount less its refunds owed, on their way or done ('due', 'pending', 'done'); nothing
--    left, nothing refunded or recorded, as before. The answer's shape is unchanged.
-- stg0-2. pay_booking_cancel never moved the waitlist up: a seated rider's cancel on the website left the place empty
--    and the riders waiting where they were (the fill rule counts the waitlist, so the night stayed full). After the
--    loop, each seated booking cancelled gives its place to _promote_next_waitlist (once per place, in the waitlist's
--    order and mode: never on an approval ride, an offer in claim mode), as the booking app's customer_booking_update
--    does, on a ride whose day is not gone; a waitlisted booking holding an open offer closes it and the place is
--    offered again (_wl_offer_fill), as customer_booking_update does since 20261119000200 (sql05-4). Moved after the
--    loop so a waitlisted booking of the same cancel is never moved up and then cancelled.
-- stg11-2. store_checkout kept only {day, time id} of a Jeddah delivery slot, so the order page and the staff view read
--    the window's hours from today's settings: staff changing or removing a time rewrote orders already booked. The
--    slot now keeps the window's hours too: {day, time, from, to}. The website reads slot.from/to first (its round-1
--    change); older orders fall back to the settings there.
-- stg11-3. store_checkout's slot check took any of today's windows with a lead of 0 days, even one already over. A
--    window on today's date (Riyadh) is taken only before it starts, and a day with no window left is not one of the
--    days offered, the days running on one further, exactly as the website's slotDays/slotTimes (round 1) count them:
--    a new _store_slot_days(jsonb, date, text) takes the Riyadh clock's HH:MM; the two-argument one stays as it was.
-- stg11-4. An issued tax invoice's seller (legal name, VAT number, CR) and its ZATCA QR were rebuilt from the current
--    Legal settings. store_orders gets seller_name_en, seller_name_ar, seller_vat and seller_cr, filled by _store_invoice
--    when it gives the order its number, read as the website's storeLegal reads them (site.legal.legalName / vat / cr,
--    biz.public.vat_no, the certificate's values as the fallbacks). _store_order_json returns them as 'seller'
--    {name_en, name_ar, vat, cr}, null for an order invoiced before this file (no row is changed: those keep the
--    website's fallback to today's settings).
--
-- Rebuilt from (the newest full text of each; no later file patches them in place, checked with grep):
--   pay_booking_cancel   20261119000500_bh18_dbstg_staging.sql (keeps its sql08-1 change and its 20261119000500 mark)
--   store_checkout       20261115235500_store_build.sql
--   _store_invoice       20261115235500_store_build.sql
--   _store_order_json    20261115235500_store_build.sql
--   _store_slot_days(jsonb, date, text)  new, from _store_slot_days(jsonb, date) in 20261115235500_store_build.sql
-- Every function keeps SECURITY DEFINER (where it had it), its search_path, volatility and language; grants and
-- revokes as the files above had them. Idempotent (create or replace, add column if not exists, drop constraint if
-- exists + add). None of them is in the Community round's list.
-- Rollback: run the blocks of those files again for those four functions; drop function
-- _store_slot_days(jsonb, date, text); the four seller columns and their checks may stay (nothing reads them then).
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $pre$
begin
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261115235500') then
    raise exception '20261119000800 is for staging, after 20261115235500_store_build.sql (payments and the store): that file is not in the ledger here';
  end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261119000500') then
    raise exception '20261119000800 goes after 20261119000500_bh18_dbstg_staging.sql (it rebuilds pay_booking_cancel from that text): apply that file first';
  end if;
end $pre$;

-- ── stg11-4 the seller kept with the order ─────────────────────────────────────────────────────────
alter table public.store_orders add column if not exists seller_name_en text;
alter table public.store_orders add column if not exists seller_name_ar text;
alter table public.store_orders add column if not exists seller_vat text;
alter table public.store_orders add column if not exists seller_cr text;
alter table public.store_orders drop constraint if exists store_orders_seller_check;
alter table public.store_orders add constraint store_orders_seller_check
  check ((seller_name_en is null or length(seller_name_en) <= 160) and (seller_name_ar is null or length(seller_name_ar) <= 160)
         and (seller_vat is null or seller_vat ~ '^[0-9]{15}$') and (seller_cr is null or length(seller_cr) <= 60));

-- ── stg0-1 + stg0-2 pay_booking_cancel ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pay_booking_cancel(p_key text, p_id text, p_token text, p_ids text[], p_dest text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q queue_entries%rowtype; s sessions%rowtype; dest text; late boolean; rf payment_refunds%rowtype; outv jsonb := '[]'::jsonb;
        days int := _pay_int('pay.refundDays', 1, 0, 30); bid text; ended boolean;
        pid uuid; pp payments%rowtype; room numeric; amt numeric;
        bk_back numeric; had_offer boolean; sid text; sids text[] := '{}'; osids text[] := '{}';   -- (20261119000800)
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
      /* ... and never more of this booking than is left of it: refunds owed, on their way or done for it (staff
         refunding it from Payments leave the booking open) come off its card_amount first (bug hunt 2026-11-18
         (20261119000800), stg0-1: a booking staff had refunded in part was refunded in full again while its payment,
         which paid other bookings too, still had room) */
      bk_back := coalesce((select sum(r.amount) from payment_refunds r
                            where r.booking_id = q.id and r.status in ('due', 'pending', 'done')), 0);
      amt := round(least(q.card_amount - bk_back, greatest(room, 0)), 2);
      if amt <= 0 then dest := null; end if;
    end if;
    /* a waitlisted booking holding an open offer (claim mode), read before it leaves, as customer_booking_update
       reads it (stg0-2) */
    had_offer := q.status = 'waitlist'
                 and exists (select 1 from waitlist_offers o where o.booking_id = q.id and o.status = 'open');
    perform set_config('mm.pay_refund_dest', coalesce(dest, 'none'), true);
    update queue_entries set status = 'cancelled', cancel_reason = 'customer', cancelled_by = 'customer', cancelled_at = now(),
                             pay_hold_until = null
     where id = q.id;
    perform set_config('mm.pay_refund_dest', '', true);
    /* the place a seated booking leaves goes to the waitlist, once for each place, and an offer it held is closed and
       made again; both after the loop, so a waitlisted booking of this same cancel is never moved up only to be
       cancelled next (bug hunt 2026-11-18 (20261119000800), stg0-2) */
    if q.status = 'waiting' then sids := sids || q.session_id; end if;
    if had_offer then
      update waitlist_offers set status = 'closed' where booking_id = q.id and status = 'open';
      osids := osids || q.session_id;
    end if;
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
  /* each place left goes to the next on the waitlist, in its order and its mode (staff pick on an approval ride; in
     claim mode it is offered), as the booking app's own cancel moves it (customer_booking_update); not on a day gone
     (bug hunt 2026-11-18 (20261119000800), stg0-2: a seated rider's cancel on the website left the place empty and
     the waitlist where it was, the fill rule counting the waitlist kept the night full) */
  foreach sid in array sids loop
    if exists (select 1 from sessions s2 where s2.id = sid and coalesce(s2.session_date, '') >= to_char(_pay_today(), 'YYYY-MM-DD')) then
      perform _promote_next_waitlist(sid);
    end if;
  end loop;
  foreach sid in array coalesce((select array_agg(distinct x) from unnest(osids) x), '{}'::text[]) loop
    perform _wl_offer_fill(sid);
  end loop;
  return jsonb_build_object('ok', true, 'refunds', outv);
end $function$;
revoke execute on function public.pay_booking_cancel(text, text, text, text[], text) from public;
grant execute on function public.pay_booking_cancel(text, text, text, text[], text) to anon, authenticated;

-- ── stg11-3 the days a slot can be booked, with the clock ──────────────────────────────────────────
-- The days a scheduled delivery can be booked for from p_today (Riyadh), as _store_slot_days(jsonb, date), except that
-- p_today itself counts only while one of its windows starts after p_now (HH:MM on the Riyadh clock), as the website's
-- slotDays with `now` (bug hunt 2026-11-18 (20261119000800), stg11-3).
create or replace function public._store_slot_days(p_slots jsonb, p_today date, p_now text) returns date[]
language plpgsql immutable set search_path = public as $$
declare d date; outv date[] := '{}'; g int := 0; ahead int := _store_jint(p_slots -> 'ahead', 6, 1, 14);
        skip int[] := coalesce((select array_agg(_store_jint(x, -1, 0, 6)) from jsonb_array_elements(coalesce(p_slots -> 'skip', '[]'::jsonb)) x), '{}');
begin
  if p_slots is null or p_today is null then return '{}'; end if;
  d := _store_working_day(p_today, _store_jint(p_slots -> 'lead', 1, 0, 7));
  while cardinality(outv) < ahead and g < 60 loop
    /* p_today itself only while one of its windows has not started at p_now (HH:MM, Riyadh) */
    if not (extract(dow from d)::int = any(skip))
       and (d > p_today or p_now is null
            or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p_slots -> 'times') = 'array' then p_slots -> 'times' else '[]'::jsonb end) t
                        where (t ->> 'from') collate "C" > p_now collate "C")) then
      outv := outv || d;
    end if;
    d := d + 1; g := g + 1;
  end loop;
  return outv;
end $$;
revoke execute on function public._store_slot_days(jsonb, date, text) from public, anon, authenticated;

-- ── stg11-2 + stg11-3 store_checkout ───────────────────────────────────────────────────────────────
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
        ngift int := 0; lines jsonb := '[]'::jsonb; elig numeric := 0; img text; unit numeric; offs jsonb; disc numeric;
        promo text; pc jsonb; gc text; g store_gift_cards%rowtype; sl jsonb; sday date; slot jsonb; rest numeric;
        gift boolean := coalesce(p_order -> 'gift' = 'true'::jsonb, false); gnote text;
        nowhm text := to_char(now() at time zone 'Asia/Riyadh', 'HH24:MI');   -- (20261119000800)
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _pay_on('pay.enabled') or not _pay_on('store.open') then raise exception 'STORE_CLOSED' using errcode = 'P0001'; end if;
  if p_id is not null and not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if fulfil is null or fulfil not in ('pickup', 'jeddah', 'ksa', 'digital') then raise exception 'STORE_FULFIL' using errcode = 'P0001'; end if;
  /* a way staff switched off is refused; pickup too since X01 (store build 2026-11-15) */
  if _store_delivery_fee(fulfil, 0) is null then raise exception 'STORE_FULFIL' using errcode = 'P0001'; end if;

  name := left(btrim(regexp_replace(coalesce(p_order #>> '{contact,name}', ''), '\s+', ' ', 'g')), 60);
  phone := _pay_phone(p_order #>> '{contact,phone}');
  email := nullif(lower(btrim(coalesce(p_order #>> '{contact,email}', ''))), '');
  if length(name) < 2 then raise exception 'STORE_NAME' using errcode = 'P0001'; end if;
  if phone is null then raise exception 'STORE_PHONE' using errcode = 'P0001'; end if;
  if email is not null and (length(email) > 120 or email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then raise exception 'STORE_EMAIL' using errcode = 'P0001'; end if;

  if fulfil in ('jeddah', 'ksa') then
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
    /* the Jeddah districts the shop delivers to, while staff keep that list on (F79, store build 2026-11-15) */
    if fulfil = 'jeddah' and not _store_district_ok(addr ->> 'district') then raise exception 'STORE_DISTRICT' using errcode = 'P0001'; end if;
    /* scheduled Jeddah delivery (F78): while it is on, a day and a time it offers; a slot sent otherwise is ignored */
    sl := case when fulfil = 'jeddah' then _store_slots() end;
    if sl is not null then
      begin
        sday := case when (p_order #>> '{slot,day}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (p_order #>> '{slot,day}')::date end;
      exception when others then sday := null;
      end;
      /* today's windows only before they start, and a day with none left is not one of the days (they run on a day
         further), as the website's slotDays and slotTimes count them on the Riyadh clock (bug hunt 2026-11-18
         (20261119000800), stg11-3: with a lead of 0 days a window already over today was booked) */
      if sday is null or not (sday = any(_store_slot_days(sl, _pay_today(), nowhm)))
         or not exists (select 1 from jsonb_array_elements(sl -> 'times') t where t ->> 'id' = p_order #>> '{slot,time}'
                          and (sday > _pay_today() or (t ->> 'from') collate "C" > nowhm collate "C")) then
        raise exception 'STORE_SLOT' using errcode = 'P0001';
      end if;
      /* the window's hours are kept with the order, so staff changing or removing a time later does not change what
         was booked (stg11-2) */
      slot := (select jsonb_build_object('day', to_char(sday, 'YYYY-MM-DD'), 'time', t ->> 'id', 'from', t ->> 'from', 'to', t ->> 'to')
                 from jsonb_array_elements(sl -> 'times') t where t ->> 'id' = p_order #>> '{slot,time}' limit 1);
    end if;
  end if;

  if jsonb_typeof(p_order -> 'items') is distinct from 'array' or jsonb_array_length(p_order -> 'items') = 0 or jsonb_array_length(p_order -> 'items') > 20 then
    raise exception 'STORE_EMPTY' using errcode = 'P0001';
  end if;

  /* a gift order (F58): its note goes on the slip, which shows no prices */
  gnote := case when gift then left(nullif(btrim(coalesce(p_order ->> 'gift_note', '')), ''), 200) end;

  insert into store_orders (customer_id, fulfil, name, phone, email, address, note, subtotal, total, lang, expires_at, gift, gift_note, slot)
  values (p_id, fulfil, name, phone, email, addr, left(nullif(btrim(coalesce(p_order ->> 'note', '')), ''), 300), 0, 0,
          case when lang ~ '^[a-z]{2}$' then lang end, now() + make_interval(mins => mins), gift, gnote, slot)
  returning * into o;

  -- each line: the variant locked, live and in stock, at the database's price
  for it in select x from jsonb_array_elements(p_order -> 'items') x order by x ->> 'variant' loop
    qty := case when (it ->> 'qty') ~ '^[0-9]{1,2}$' then (it ->> 'qty')::int else 0 end;
    if qty < 1 or qty > 10 or coalesce(it ->> 'variant', '') !~ '^[0-9a-f-]{36}$' then raise exception 'STORE_ITEM' using errcode = 'P0001'; end if;
    select * into v from store_variants where id = (it ->> 'variant')::uuid for update;
    select * into pr from store_products where id = v.product_id;
    if v.id is null or not v.active or pr.id is null or not pr.published then raise exception 'STORE_GONE: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if v.stock < qty then raise exception 'STORE_STOCK: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if fulfil = 'ksa' and not pr.ship_ksa and pr.kind <> 'gift_card' then raise exception 'STORE_NO_SHIP: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if exists (select 1 from store_order_items i where i.order_id = o.id and i.variant_id = v.id) then raise exception 'STORE_ITEM' using errcode = 'P0001'; end if;
    unit := coalesce(v.price, pr.price);
    /* a gift card is one face value, 10 to 5000 SAR (store_gift_cards) */
    if pr.kind = 'gift_card' and (unit < 10 or unit > 5000) then raise exception 'STORE_ITEM' using errcode = 'P0001'; end if;
    update store_variants set stock = stock - qty where id = v.id;
    label := nullif(concat_ws(' · ', nullif(v.size, ''), nullif(case when lang = 'ar' then coalesce(v.color_ar, v.color_en) else v.color_en end, '')), '');
    /* X08: the line keeps its own photo (the first one staff tagged with its colour, else the cover) and address */
    img := coalesce((select u.x from unnest(pr.images) with ordinality u(x, k)
                      where v.color_en is not null and pr.image_meta -> u.x ->> 'colour' = v.color_en order by u.k limit 1), pr.images[1]);
    insert into store_order_items (order_id, product_id, variant_id, name, variant, unit_price, qty, image, slug, gift_card)
    values (o.id, pr.id, v.id, case when lang = 'ar' then coalesce(pr.name_ar, pr.name_en) else pr.name_en end, label, unit, qty,
            left(img, 300), pr.slug, pr.kind = 'gift_card');
    sub := sub + unit * qty; n := n + 1;
    if pr.kind = 'gift_card' then
      ngift := ngift + 1;
    else
      lines := lines || jsonb_build_array(jsonb_build_object('product', pr.id, 'unit', unit, 'qty', qty));
      elig := elig + unit * qty;
    end if;
  end loop;
  /* gift cards alone are 'digital' (nothing to deliver), and 'digital' is gift cards alone (F57) */
  if (fulfil = 'digital') is distinct from (ngift = n) then raise exception 'STORE_DIGITAL' using errcode = 'P0001'; end if;

  /* the bundle prices (F31) and a code (F67): only with the discount licence, never on gift cards */
  offs := _store_bundle_off(lines);
  disc := coalesce((select sum((x ->> 'amount')::numeric) from jsonb_array_elements(offs) x), 0);
  promo := nullif(upper(regexp_replace(coalesce(p_order ->> 'promo', ''), '\s+', '', 'g')), '');
  if promo is not null then
    pc := _store_promo_off(promo, round(elig - disc, 2), true);
    disc := disc + (pc ->> 'discount')::numeric;
    offs := offs || jsonb_build_array(jsonb_build_object('kind', 'promo', 'ref', pc ->> 'code', 'amount', (pc ->> 'discount')::numeric));
  end if;
  sub := round(sub, 2); disc := round(disc, 2);

  fee := _store_delivery_fee(fulfil, sub - disc);
  if fee is null then raise exception 'STORE_FULFIL' using errcode = 'P0001'; end if;
  /* an order that buys gift cards gets its gift key: the whole codes, for the buyer's checkout alone (section 6) */
  update store_orders set subtotal = sub, discount = disc, discounts = offs, promo_code = pc ->> 'code',
         delivery_fee = fee, total = round(sub - disc + fee, 2),
         gift_key = case when ngift > 0 then replace(gen_random_uuid()::text, '-', '') end
   where id = o.id returning * into o;

  /* a gift card pays first (F57): not for gift cards; it leaves the card at least 1 SAR, as the wallet does */
  gc := nullif(upper(regexp_replace(coalesce(p_order ->> 'gift_card', ''), '\s+', '', 'g')), '');
  if gc is not null then
    if ngift > 0 then raise exception 'STORE_GIFT_ON_GIFT' using errcode = 'P0001'; end if;
    select * into g from store_gift_cards where code = gc for update;
    if g.id is null or g.status <> 'active' or g.balance <= 0 then raise exception 'STORE_GIFT' using errcode = 'P0001'; end if;
    /* a year to spend it (the owner, 2026-11-15) */
    if g.expires_at <= now() then raise exception 'STORE_GIFT_EXPIRED' using errcode = 'P0001'; end if;
    take := least(g.balance, o.total);
    if o.total - take > 0 and o.total - take < 1 then take := greatest(o.total - 1, 0); end if;
    if take > 0 then
      update store_gift_cards set balance = balance - take where id = g.id;
      insert into store_gift_card_moves (card_id, order_id, amount, kind, by_name) values (g.id, o.id, -take, 'spend', 'customer');
      update store_orders set gift_paid = take, gift_card_id = g.id where id = o.id returning * into o;
    end if;
  end if;

  -- the account's wallet pays what it can first, when the customer chose it
  if p_id is not null and coalesce((p_order ->> 'wallet')::boolean, false) then
    who := _wallet_owner(p_id);
    select coalesce(balance, 0) into bal from wallet_balances where customer_id = who for update;
    rest := o.total - o.gift_paid;
    take := least(coalesce(bal, 0), rest);
    /* the card takes no less than 1 SAR (Moyasar's least): a wallet that would leave less leaves the card 1 SAR
       (bug hunt 2026-11-10: PAY_TOO_SMALL failed the checkout every time) */
    if rest - take > 0 and rest - take < 1 then take := greatest(rest - 1, 0); end if;
    if take > 0 then
      perform set_config('mm.wallet_op', 'Online store', true);
      perform _wallet_post(who, -take, 'sale', null, null, null, 'ord-' || o.no, null);
      perform set_config('mm.wallet_op', '', true);
      update store_orders set wallet_paid = take where id = o.id returning * into o;
    end if;
  end if;

  insert into store_order_events (order_id, status, note) values (o.id, 'pending', null);
  due := round(o.total - o.gift_paid - o.wallet_paid, 2);
  if due <= 0 then
    update store_orders set status = 'paid', paid_at = now(), expires_at = null where id = o.id returning * into o;
    insert into store_order_events (order_id, status, note)
    values (o.id, 'paid', case when o.wallet_paid > 0 then 'wallet' when o.gift_paid > 0 then 'gift_card' end);
    insert into receipt_numbers (receipt_id) values ('ord-' || o.no) on conflict (receipt_id) do nothing;
    perform _store_paid(o);
    select * into o from store_orders where id = o.id;
    return jsonb_build_object('order', _store_order_json(o), 'key', o.track_key, 'payment', null, 'gift_key', o.gift_key);
  end if;
  if due < 1 then raise exception 'PAY_TOO_SMALL' using errcode = 'P0001'; end if;
  p := _pay_new('order', o.id::text, array[o.id::text], jsonb_build_array(jsonb_build_object('id', o.id, 'amount', due)),
                p_id, due, 'Order MM-' || o.no, mins, true, lang);
  update store_orders set payment_id = p.id, expires_at = p.expires_at where id = o.id returning * into o;
  return jsonb_build_object('order', _store_order_json(o), 'key', o.track_key, 'payment', _pay_json(p), 'gift_key', o.gift_key);
end $function$;
revoke execute on function public.store_checkout(text, text, text, jsonb) from public;
grant execute on function public.store_checkout(text, text, text, jsonb) to anon, authenticated;

-- ── stg11-4 _store_invoice ─────────────────────────────────────────────────────────────────────────
create or replace function public._store_invoice(p_order uuid) returns bigint
language plpgsql security definer set search_path = public as $$
declare cur bigint; n bigint; ln jsonb := _pay_setting('site.legal.legalName'); lc jsonb := _pay_setting('site.legal.cr');
        lv jsonb := _pay_setting('site.legal.vat'); en text; ar text; vs text; bz text;   -- (20261119000800)
begin
  select o.invoice_no into cur from store_orders o where o.id = p_order for update;
  if cur is not null then return cur; end if;
  insert into store_invoice_counter (id, last_no) values (true, 0) on conflict (id) do nothing;
  update store_invoice_counter set last_no = last_no + 1 where id returning last_no into n;
  /* the seller as the invoice names it, kept with the order when its number is given, so a later change to the
     Legal settings does not change an invoice already issued or its QR (bug hunt 2026-11-18 (20261119000800),
     stg11-4). Read as the website's storeLegal reads it: a name or number is set when both its languages are text,
     the side asked for first (trimmed), else the other; an empty name or an unset one is the certificate's name; the
     VAT number a 15-digit one on the Legal line, else Settings > Business's, else the certificate's; the CR as set
     (empty hides it), else the certificate's. */
  if jsonb_typeof(ln -> 'en') = 'string' and jsonb_typeof(ln -> 'ar') = 'string' then
    en := regexp_replace(ln ->> 'en', '^\s+|\s+$', '', 'g'); ar := regexp_replace(ln ->> 'ar', '^\s+|\s+$', '', 'g');
  end if;
  if jsonb_typeof(lv -> 'en') = 'string' and jsonb_typeof(lv -> 'ar') = 'string' then
    vs := left(coalesce(nullif(regexp_replace(lv ->> 'en', '^\s+|\s+$', '', 'g'), ''), regexp_replace(lv ->> 'ar', '^\s+|\s+$', '', 'g')), 60);
  end if;
  bz := regexp_replace(coalesce(_pay_setting('biz.public') ->> 'vat_no', ''), '^\s+|\s+$', '', 'g');
  update store_orders
     set invoice_no = n,
         seller_name_en = coalesce(nullif(left(coalesce(nullif(en, ''), ar), 160), ''), 'Micromobility Company Ltd.'),
         seller_name_ar = coalesce(nullif(left(coalesce(nullif(ar, ''), en), 160), ''), 'شركة التنقل الدقيق المحدودة'),
         seller_vat = case when vs ~ '^[0-9]{15}$' then vs when bz ~ '^[0-9]{15}$' then bz else '312555068900003' end,
         seller_cr = case when jsonb_typeof(lc -> 'en') = 'string' and jsonb_typeof(lc -> 'ar') = 'string'
                          then left(coalesce(nullif(regexp_replace(lc ->> 'en', '^\s+|\s+$', '', 'g'), ''),
                                             regexp_replace(lc ->> 'ar', '^\s+|\s+$', '', 'g')), 60)
                          else '1009107240' end
   where id = p_order;
  return n;
end $$;
revoke execute on function public._store_invoice(uuid) from public, anon, authenticated;

-- ── stg11-4 _store_order_json ──────────────────────────────────────────────────────────────────────
create or replace function public._store_order_json(o store_orders, p_staff boolean default false) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', o.id, 'no', o.no, 'status', o.status, 'fulfil', o.fulfil, 'name', o.name,
    'phone', case when p_staff then o.phone else '•••• ' || right(o.phone, 4) end,
    'email', case when p_staff then o.email end,
    'address', case when p_staff then o.address else
                 case when o.address is null then null else jsonb_build_object('city', o.address ->> 'city', 'district', o.address ->> 'district') end end,
    'note', case when p_staff then o.note end, 'staff_note', case when p_staff then o.staff_note end,
    'customer_id', case when p_staff then o.customer_id end,
    'subtotal', o.subtotal, 'delivery_fee', o.delivery_fee, 'total', o.total, 'wallet_paid', o.wallet_paid,
    -- L06: a gift card is a voucher, so its VAT is charged when it is spent, not when it is sold (store build)
    'vat', round(greatest(o.total - coalesce((select sum(i.unit_price * i.qty) from store_order_items i where i.order_id = o.id and i.gift_card), 0), 0) * 15 / 115, 2),
    'courier', o.courier, 'tracking_no', o.tracking_no, 'expires_at', o.expires_at, 'paid_at', o.paid_at,
    'created_at', o.created_at, 'cancel_reason', o.cancel_reason, 'payment_id', o.payment_id,
    -- the order's invoice number (paid by card or wholly from the wallet: 'ord-<no>' either way)
    'receipt_no', (select r.no from receipt_numbers r where r.receipt_id = 'ord-' || o.no),
    'payment', (select _pay_json(p) from payments p where p.id = o.payment_id),
    -- X08: each line's own photo and address, kept when it was sold (the product's now, for a line sold before that)
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'variant', i.variant, 'qty', i.qty,
                         'unit_price', i.unit_price, 'product_id', i.product_id, 'variant_id', i.variant_id,
                         'image', coalesce(i.image, sp.images[1]), 'slug', coalesce(i.slug, sp.slug), 'gift_card', i.gift_card,
                         'reviewed', exists (select 1 from store_reviews rv where rv.order_id = o.id and rv.product_id = i.product_id)) order by i.id)
                       from store_order_items i left join store_products sp on sp.id = i.product_id where i.order_id = o.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('at', e.at, 'status', e.status, 'note', e.note, 'by', case when p_staff then e.by_name end,
                          'public', e.public) order by e.id)
                        from store_order_events e where e.order_id = o.id and (p_staff or e.public)), '[]'::jsonb))
  || jsonb_build_object(
    'discount', o.discount, 'discounts', o.discounts, 'promo_code', o.promo_code, 'gift_paid', o.gift_paid,
    'gift', o.gift, 'gift_note', o.gift_note, 'slot', o.slot,
    -- L06: the store's own invoice number, given when the order was paid ("INV-000001"); null for an order never paid
    'invoice_no', o.invoice_no,
    'invoice', case when o.invoice_no is not null then 'INV-' || case when length(o.invoice_no::text) >= 6 then o.invoice_no::text
                                                                    else lpad(o.invoice_no::text, 6, '0') end end,
    -- the seller as it stood when the invoice was issued (20261119000800, stg11-4); null for an invoice issued before
    'seller', case when o.seller_name_en is not null then jsonb_build_object('name_en', o.seller_name_en, 'name_ar', o.seller_name_ar,
                                                                              'vat', o.seller_vat, 'cr', o.seller_cr) end,
    'gift_card_id', case when p_staff then o.gift_card_id end,
    -- staff only: what Void cards and refund would void and refund now (null for an order that bought no gift cards)
    'gift_refund', case when p_staff and exists (select 1 from store_gift_cards g where g.order_id = o.id) then _store_gift_refund_plan(o) end,
    'gift_card_code', case when p_staff then (select g.code from store_gift_cards g where g.id = o.gift_card_id) end,
    'delivered_at', (select e.at from store_order_events e where e.order_id = o.id and e.status = 'delivered' order by e.id limit 1),
    'returns', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'status', r.status, 'items', r.items, 'reason', r.reason,
                           'note', r.note, 'amount', r.amount, 'created_at', r.created_at, 'decided_at', r.decided_at)
                           || case when p_staff then jsonb_build_object('staff_note', r.staff_note, 'decided_by', r.decided_by) else '{}'::jsonb end
                           order by r.created_at)
                         from store_return_requests r where r.order_id = o.id), '[]'::jsonb),
    -- the gift cards this order bought, once it is paid: whole codes for staff, masked for every customer read
    -- (store_order_get with the gift key and customer_orders put the buyer's whole codes back)
    'gift_cards', _store_order_gifts(o, p_staff, p_staff),
    -- X09: every refund and where it went. Refunds of the order's payments (one owed is staff's only), the wallet's
    -- part given back (a give-back the order took again when it was paid late is left out), the gift card's part given
    -- back or refunded (the same). A wallet refund staff send in Payments is a payment_refunds row, never counted twice.
    'refunds', coalesce((select jsonb_agg(x.j order by x.at, x.k) from (
        select jsonb_build_object('id', r.id, 'amount', r.amount, 'dest', r.dest, 'status', r.status, 'at', coalesce(r.done_at, r.created_at)) j,
               coalesce(r.done_at, r.created_at) at, 1 k
          from payment_refunds r
         where (r.order_id = o.id or r.payment_id in (select p.id from payments p where p.kind = 'order' and p.ref = o.id::text))
           and (p_staff or r.status in ('pending', 'done'))
        union all
        select jsonb_build_object('amount', l.amount, 'dest', 'wallet', 'status', 'done', 'at', l.created_at), l.created_at, 2
          from wallet_ledger l
         where o.wallet_paid > 0 and l.receipt_id = 'ord-' || o.no and l.kind = 'sale_back'
           and not exists (select 1 from wallet_ledger l2 where l2.receipt_id = l.receipt_id and l2.kind = 'sale' and l2.id > l.id)
        union all
        select jsonb_build_object('amount', m.amount, 'dest', 'gift', 'status', 'done', 'at', m.at), m.at, 3
          from store_gift_card_moves m
         where o.gift_card_id is not null and m.card_id = o.gift_card_id and m.order_id = o.id and m.kind in ('back', 'refund')
           and not exists (select 1 from store_gift_card_moves m2 where m2.card_id = m.card_id and m2.order_id = m.order_id
                             and m2.kind = 'spend' and m2.id > m.id)) x), '[]'::jsonb))
$$;
revoke execute on function public._store_order_json(store_orders, boolean) from public, anon, authenticated;

-- ── checks ──────────────────────────────────────────────────────────────────────────────────────────
-- every definer function written here is SECURITY DEFINER with its search_path and this file's change; the inner ones
-- no client may run; the website's ones reachable; the seller columns are there
do $chk$
declare f text;
begin
  foreach f in array array['public.pay_booking_cancel(text,text,text,text[],text)',
                           'public.store_checkout(text,text,text,jsonb)',
                           'public._store_invoice(uuid)',
                           'public._store_order_json(public.store_orders,boolean)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and position('20261119000800' in p.prosrc) > 0
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, lacks this file''s change, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if position('20261119000500' in (select prosrc from pg_proc where oid = 'public.pay_booking_cancel(text,text,text,text[],text)'::regprocedure)) = 0 then
    raise exception 'pay_booking_cancel lost 20261119000500''s change';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public._store_slot_days(jsonb,date,text)'::regprocedure and p.provolatile = 'i'
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '_store_slot_days(jsonb,date,text) is missing, not IMMUTABLE, or has no search_path';
  end if;
  foreach f in array array['public._store_invoice(uuid)', 'public._store_order_json(public.store_orders,boolean)',
                           'public._store_slot_days(jsonb,date,text)', 'public._store_slot_days(jsonb,date)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  foreach f in array array['public.pay_booking_cancel(text,text,text,text[],text)', 'public.store_checkout(text,text,text,jsonb)'] loop
    if not has_function_privilege('anon', f, 'execute') then
      raise exception '% lost its grant', f;
    end if;
  end loop;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'store_orders'
        and column_name in ('seller_name_en', 'seller_name_ar', 'seller_vat', 'seller_cr')) <> 4 then
    raise exception 'store_orders is missing a seller column';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name) values ('20261119000800', 'bh18_r2stg_staging') on conflict do nothing;

commit;

-- check (read only): the functions' marks and attributes, the seller columns, the ledger row
-- select p.proname, p.prosecdef, p.proconfig, p.provolatile, position('20261119000800' in p.prosrc) > 0 as fixed,
--        pg_get_function_identity_arguments(p.oid) as args
--   from pg_proc p where p.pronamespace = 'public'::regnamespace
--    and p.proname in ('pay_booking_cancel', 'store_checkout', '_store_invoice', '_store_order_json', '_store_slot_days') order by 1, 6;
-- select column_name from information_schema.columns where table_name = 'store_orders' and column_name like 'seller%';
-- select name from supabase_migrations.schema_migrations where version = '20261119000800';
