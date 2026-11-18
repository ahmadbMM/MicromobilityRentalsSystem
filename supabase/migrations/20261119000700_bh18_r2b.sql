-- ============================================================================
-- Bug hunt 2026-11-18, round 2, package r2b: the server halves round 1 left, and their app mirrors. BOTH databases
-- (staging, then production). Needs 20261119000100..000400 first (it rebuilds db1's _hub_push_tick, db3's
-- staff_merge_customers / staff_unmerge_customers / staff_move_session and db4's _till_stamp from their texts).
--
--  1. app03-1  _rider_price: an employee fare left empty (ride_prices.employee_price null) was 50 SAR on the server while
--              the desk, Settings > Pricing ("empty = the standard fare") and every quote read it as the type's standard
--              fare. Mountain, Hybrid, Kids and Any now fall back to the type's own price (57.5 when it has no row); Road
--              as before; a type with no employee fare of its own (Road Carbon...) keeps 50. Only a cleared fare changes.
--  2. app03-2  The waitlist cap staff set (sessions.bike_slots._wl: {m:'count'|'pct', v}) was the browser's alone, so two
--              riders, a stale page or a micromobility.sa form went past it. New BEFORE INSERT trigger zw_wl_cap_guard
--              (_wl_cap_guard, definer, after every trigger that may put a booking on the waitlist): a customer's new
--              booking that lands on the waitlist when the waitlist already holds the cap is refused WAITLIST_FULL
--              (P0001; the booking app already says errWaitlistFull). The cap is worked out as the app's waitlistCap:
--              floor(v), or v% of the places (spots, else capacity), at least one. Staff, promotions and a session
--              without _wl are never stopped. WEBSITE: the form pages may map WAITLIST_FULL to their own words.
--  3. app17-3  staff_payment_figures(p_from, p_to, p_kind) (new, staff): the Payments page's Paid / Taken / Refunded over
--              every payment in the range, by status, beside the newest 500 the list holds. The app already calls it and
--              keeps its own figures without it. It reads payments / payment_refunds, which only staging has so far: on
--              production it is created (plpgsql checks no table until it runs) and is never called (no Payments page).
--  4. app19-4  staff_locker_edit: the money step ran for a door-only change too, so after a price change a rehome off a
--              broken door was refused ADMIN_REFUND / PIN_REQUIRED (or left a charge due nobody took). It now runs only
--              when the evening or the time changes; a door change still renames the wallet receipt's line.
--  5. app29-4  staff_cancel_held(p_ids) (new, staff): each cancelled booking's wallet part as staff_cancel_session counts
--              it (the whole ledger, before its cancel). The Cancel session list read a 200-row page of the ledger and
--              showed the whole price as the desk's. The app already calls it and falls back without it.
--  6. app30-1  A booking on the house kept no record of its price, so taking it off the house from the pay menu kept a
--              promo booking at 0 (paid or pending, never charged). New column queue_entries.house_from: trigger
--              zw_house_from keeps the row's price as it goes onto the house (paid at 0), keeps it while it stays there,
--              and clears it once it leaves; staff_set_house(p_on=false) restores it (else the fare now, as before).
--              The app uses it for Paid / Pending on a row on the house. A 100%-off promo row that was never on the house
--              has none and stays free.
--  7. app33-3  staff_give_spot(p_session_id, p_booking_id) (new, Bookings edit): Give the place, under the ride's promotion
--              lock, counting the places held, the bikes out of service, the type's own places and the other riders'
--              open offers as staff_offer_spot does: NO_PLACE when none is left, NOT_WAITLISTED when the rider moved. Two
--              desks can no longer both give the last place. The app calls it, and its old update where it is missing.
--  8. app35-5  staff_customer_stats: Spent ("sp") was the price alone (null as 0), no add-ons, transfers left out only on
--              vlap/arena. It is now _mt_core's amount: price (57.5 when none) plus the add-ons, every transfer left out.
--  9. ppl-rentals0-1  staff_merge_customers / staff_unmerge_customers: the account's owner (account_owners), family link
--              (account_family) and follow-ups (account_followups) stayed on the merged-away account. They move to the
--              keeper (owner and family when it has none; a second family link is kept in the record and taken off) and
--              back on undo. The three stamp triggers forced customer_id back on update; a merge (mm.merge) now moves a
--              row whole, with who made it.
-- 10. sql04-1  staff_move_session: a Saturday ride moved to a date with no confirmed breakfast venue kept the old date's
--              venue. A stop that was the old day's synced venue is cleared on the copy; one typed by hand stays; the new
--              day's confirmed venue (the insert trigger) stands. App half: the editor sends the stop only when changed.
--              Also sql01-5's page lockers (db1 left it to this rebuild): only reserved ones move with the date, one in
--              use keeps its day and door until handed back.
-- 11. app42-3  Data fix: workshop_jobs.parts_used lines stored the part's unit cost, readable by staff without the
--              can_see_costs cap. The app stopped writing it in round 1; the 'cost' key is taken out of the stored lines
--              (only rows that hold one; idempotent; no other key touched).
-- 12. app46-3  staff_wallet_moves(p_from) also returns receipt_id, so a shop till counts a wallet refund on the day its
--              receipt was sold (the app already reads it). Its result columns change: dropped and made again, grants
--              as before.
-- 13. sql14-2  Till close-out: the expected cash and card were the browser's. New _till_expected(p_id) works them out on
--              the server as the app's _tillTake / _tillNet do (float; the day's paid bookings by card, cash and the
--              wallet's part; desk purchases on bookings; Sales receipts with their card and wallet lines, refunded ones
--              left out; wallet moves at the ride, the shop's by day and a refund by its receipt's day; cash deposits;
--              less the tills of the day closed before). New till_close(p_id, p_counted, p_card, p_notes, p_by_name)
--              closes with them (the app calls it). _till_stamp writes them on any close by a non-admin through the
--              table too (an older page still closes; admins keep the old path and may still correct the figures), and
--              _till_count_stamp sets a count's expected cash the same way.
-- 14. sql01-2  The Saturday recap push and its Updates line said "{0} riders came out this Saturday" (a club head count;
--              members never see one). The words carry no number in all ten languages, _hub_push_tick sends no
--              argument, and the recap rows already written lose theirs (their body is written again from the new
--              words; the Updates list renders from the words already).
-- 15. sql06-2 + form-lockers-0-3  The tested PRODUCTION TOO patch (dbstg, work/dbstg/production-too-lockers.sql), folded in
--              as is (anchors and the 'bh18-lockers' mark kept): customer_locker_change counts the account's own page
--              lockers per time (LOCKER_LIMIT) and refuses another fee once paid at the desk (LOCKER_NOT_OPEN);
--              customer_locker_drop gives desk money back (_lk_money_back); customer_lockers says paid for desk-paid
--              rentals. WEBSITE: forms/lockers changeRefused maps LOCKER_LIMIT to "Up to 3 lockers per account for each
--              time.". When payments go to production, 20261110235200 item 7 replaces customer_locker_change whole: run
--              20261110235300 item 5 and this section again after it.
-- Not changed: app47-1 (staff_inventory_costs already returns no row to an account without can_see_costs since
-- 20261009162000's in-place patch); the Community round's functions.
--
-- Copied from (newest text, only the named lines changed, headers kept): _rider_price 20261009161000;
-- staff_locker_edit 20261111235100; staff_set_house 20261009205000; staff_customer_stats 20261107120000;
-- staff_merge_customers, staff_unmerge_customers, staff_move_session 20261119000300; _account_family_stamp,
-- _account_owners_stamp 20261118210000; _account_followups_stamp 20261111180700; _till_stamp 20261119000400;
-- _till_count_stamp 20261009150000; _hub_push_tick 20261119000100; staff_wallet_moves 20261102210000. A pre-check stops
-- the file when any of them is no longer that text (md5 of the body) nor this file's.
--
-- Rollback: re-run each function above from its file; drop trigger zw_wl_cap_guard / zw_house_from on queue_entries and
-- their functions; drop function staff_payment_figures(date,date,text), staff_cancel_held(text[]),
-- staff_give_spot(text,text), till_close(uuid,numeric,numeric,text,text), _till_expected(uuid); staff_wallet_moves back to
-- 20261102210000's (drop first); push_words 'recap' bodies from 20261114000200 / supabase/seeds/push_words_more.sql.
-- queue_entries.house_from may stay. The parts_used cost and the recap rows' old bodies are not restored.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

-- Every function rebuilt whole below must still be the text it was copied from (md5 of the body), or already this
-- file's (a re-run): else stop, rather than undo a change made since.
do $pre$
declare f record; m text;
begin
  for f in select * from (values
    ('public.staff_locker_edit(uuid,date,text,text,text,text,text,text)', '71b49bf5374d9ff3587f997df97df39c', '589ed86df54bd9a0dda326a4eb7da352'),
    ('public.staff_set_house(text,boolean,text,text)', '2c2e64b95a995b7bd9d525c614fc93fa', '9f350985a1ee5ad940bf9c8c53e8bcc9'),
    ('public.staff_customer_stats()', '7a9146d0f41676c62d2e89ca283f2dd4', '208f793c677775caaa748c21f95d0394'),
    ('public.staff_merge_customers(text,text,text,text,text)', 'c17c9f5da33684dfc4bdb692d96917cf', 'c4debc47c9ae92eca50a9546a5aef9e8'),
    ('public.staff_unmerge_customers(bigint)', '4e21ff5cb31fb9c29fb2605b3e264e95', '02acbe15c3d42864e5a5682b90e8ea7e'),
    ('public._account_family_stamp()', '685f54ebdc0b37625f3f1f7bb66439e5', '2c2a71f03d46572bdb99c97a1b92704d'),
    ('public._account_owners_stamp()', '4a4dd6fbcfd1d38a8bca69a97034142e', '043c8fc41790f5d090f447f8ff497533'),
    ('public._account_followups_stamp()', 'a9a3b896e555054af2b0fb4d5988ce0d', '1ac5a20cb92095db965a25a22d0d8a5b'),
    ('public.staff_move_session(text,text,text,boolean)', '15dc7b4e8516d9f0f586f082ce8c1aaa', '6b20101689e75989b1a4ff33bdf2fe39'),
    ('public._till_stamp()', '1c9be8b072c647b3e61f163c74f87afb', '24c11b4ed93fd06da157228ec9059daf'),
    ('public._till_count_stamp()', 'd6ace2e843f9c2859f8f6fff6200af5a', 'ff0ffbc129208e09a32eb3e5bdd494c2'),
    ('public._hub_push_tick()', '0604c2633a9c8c955d098e0c7080193e', '59321b07b8090aec5efd0b523e13401e'),
    ('public._rider_price(text)', 'b0af471e2b2a0e5e7fc1c2d663ec925d', '03db984311ee031b5d4a1c0f313afc62')
  ) v(fn, was, now_) loop
    select md5(p.prosrc) into m from pg_proc p where p.oid = to_regprocedure(f.fn);
    if m is distinct from f.was and m is distinct from f.now_ then
      raise exception '% changed since this file was written (md5 %): rebuild it from the live definition', f.fn, m;
    end if;
  end loop;
  select md5(p.prosrc) into m from pg_proc p where p.oid = to_regprocedure('public.staff_wallet_moves(date)');
  if m is distinct from '7d5dbbf15d8375c8ce9d886f3351d1c4'
     and position('(20261119000700)' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.staff_wallet_moves(date)')), '')) = 0 then
    raise exception 'staff_wallet_moves(date) changed since this file was written (md5 %)', m;
  end if;
  if to_regprocedure('public.customer_locker_change(text,text,uuid,text,text)') is null
     or to_regprocedure('public.customer_locker_drop(text,text,uuid)') is null
     or to_regprocedure('public.customer_lockers(text,text)') is null then
    raise exception 'the Lockers page functions are missing';
  end if;
end $pre$;

-- ── 1. app03-1 _rider_price: an empty employee fare is the standard fare ─────────────────────────────────────────────
create or replace function public._rider_price(p_type text)
returns numeric
language sql stable set search_path to 'public'
as $$
  select coalesce(
    (select r.employee_price from ride_prices r where r.type = p_type),
    /* an employee fare left empty is the type's standard fare, as Settings > Pricing says and the app reads it (bug
       hunt 2026-11-18, app03-1) (20261119000700); a type with no row of its own keeps the old 50 */
    case when p_type = 'Road' then coalesce((select r.price from ride_prices r where r.type = 'Road'), 75)
         when p_type in ('Mountain', 'Hybrid', 'Kids', 'Any') then coalesce((select r.price from ride_prices r where r.type = p_type), 57.5)
         else 50 end)
$$;

-- ── 2. app03-2 the waitlist cap, on the server ─────────────────────────────────────────────────────────────────────
create or replace function public._wl_cap_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
/* The waitlist cap staff set on a session (bike_slots._wl = {m: 'count' | 'pct', v}), for a customer's new booking that
   lands on the waitlist (bug hunt 2026-11-18, app03-2) (20261119000700). It runs after every trigger that may put it
   there (_capacity_guard, _out_bikes_guard, _type_full_guard), under the ride's 'cap:' lock as they count. The cap as
   the app's waitlistCap: floor(v) riders, or v% of the places (spots, else capacity), at least one. A full waitlist:
   WAITLIST_FULL. Never for staff, a promotion, or a session without a cap. */
declare v_raw text; v_base numeric; v_slots jsonb; v_w jsonb; v_v numeric; v_cap int; v_n int;
begin
  if coalesce(new.status, '') <> 'waitlist' then return new; end if;
  if coalesce(current_setting('mm.promoting', true), '') = '1' then return new; end if;
  if coalesce((select public.is_staff()), false) then return new; end if;
  select s.bike_slots, coalesce(nullif(s.spots, 0), s.capacity, 0) into v_raw, v_base from sessions s where s.id = new.session_id;
  if not found then return new; end if;
  begin v_slots := coalesce(nullif(btrim(v_raw), ''), '{}')::jsonb; exception when others then v_slots := '{}'::jsonb; end;
  if jsonb_typeof(v_slots) is distinct from 'object' or jsonb_typeof(v_slots -> '_wl') is distinct from 'object' then return new; end if;
  v_w := v_slots -> '_wl';
  begin v_v := (v_w ->> 'v')::numeric; exception when others then v_v := null; end;
  if v_v is null or v_v <= 0 then return new; end if;
  v_cap := case when v_w ->> 'm' = 'pct' then greatest(1, round(coalesce(v_base, 0) * v_v / 100))::int else floor(v_v)::int end;
  perform pg_advisory_xact_lock(hashtext('cap:' || new.session_id));
  select count(*) into v_n from queue_entries q
   where q.session_id = new.session_id and q.status = 'waitlist' and q.id is distinct from new.id;
  if v_n >= v_cap then
    raise exception 'WAITLIST_FULL' using errcode = 'P0001', detail = 'WAITLIST_FULL';
  end if;
  return new;
end $fn$;
revoke all on function public._wl_cap_guard() from public, anon, authenticated;
drop trigger if exists zw_wl_cap_guard on public.queue_entries;
create trigger zw_wl_cap_guard before insert on public.queue_entries
  for each row execute function public._wl_cap_guard();

-- ── 3. app17-3 the Payments page's figures over the whole range ────────────────────────────────────────────────────
create or replace function public.staff_payment_figures(p_from date default null, p_to date default null, p_kind text default null)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
/* Paid, Taken and Refunded per status over every payment in the range, as staff_payments filters them (bug hunt
   2026-11-18, app17-3) (20261119000700). {ok, by: {<status>: {n, amount, back}}}. Online payments are on staging only. */
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return jsonb_build_object('ok', true, 'by', coalesce((
    select jsonb_object_agg(s.status, jsonb_build_object('n', s.n, 'amount', s.amount, 'back', s.back))
      from (select p.status, count(*) as n, coalesce(sum(p.amount), 0) as amount,
                   coalesce(sum((select sum(r.amount) from payment_refunds r
                                  where r.payment_id = p.id and r.status = 'done' and r.dest in ('card', 'wallet'))), 0) as back
              from payments p
             where p.status <> 'initiated'
               and (p_from is null or (p.created_at at time zone 'Asia/Riyadh')::date >= p_from)
               and (p_to is null or (p.created_at at time zone 'Asia/Riyadh')::date <= p_to)
               and (p_kind is null or p.kind = p_kind)
             group by p.status) s), '{}'::jsonb));
end $$;
revoke execute on function public.staff_payment_figures(date, date, text) from public, anon;
grant execute on function public.staff_payment_figures(date, date, text) to authenticated;

-- ── 4. app19-4 staff_locker_edit: no money step for a door, name or account change ─────────────────────────────────
create or replace function public.staff_locker_edit(p_rental uuid, p_day date, p_period text, p_code text, p_name text,
                                                    p_customer text, p_op text, p_approval text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
AS $function$
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
  /* A ride's locker stays on its ride's evening (bh11 sql07-5): its fee is on that booking's bill and it follows the
     booking (moved, cancelled, no-show) through _lk_booking_follow, as customer_locker_reserve holds it. Moving the
     ride moves it; another evening is a locker of its own (cancel this one and rent one there). */
  if r.booking_id is not null and d <> r.day
     and d is distinct from (select case when e.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(e.session_date, 10)::date end
                               from queue_entries e where e.id = r.booking_id) then
    raise exception 'LOCKER_ON_BOOKING' using errcode = 'P0001';
  end if;
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
  -- moved to another evening, or its locker taken for the new time: a free one is held there instead (the user, 2026-11-10:
  -- "assign them an automatic locker so it stays reserved for them"). An Unassign ('') and a rental left without a number on
  -- the same evening stay without one.
  if p_code is null and lk.id is null and (d <> r.day or r.locker_id is not null) then
    select l.* into lk from lockers l where l.id = (select _lk_free_unit(d, per, r.id));
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
  /* and only when the evening or the time changes (bug hunt 2026-11-18, app19-4) (20261119000700): a door, a name or an
     account changed alone takes or gives back nothing, so a rehome off a broken door after a price change is not
     refused ADMIN_REFUND / PIN_REQUIRED and leaves nothing due; the receipt's line still names the new door */
  if per = r.period and d = r.day then
    if coalesce(r.pay, '') = 'wallet' and r.receipt_id is not null and lk.id is distinct from r.locker_id then
      update cashier_sales set name = left('Locker ' || coalesce(lk.code, '') || ' · ' || case per when 'early' then '6-8 PM' when 'late' then '9-11 PM'
                                                                                     when 'both' then '6-11 PM' else '7-9 PM' end, 120)
       where id = r.receipt_id;
    end if;
  else
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
  end if;
  select * into r from locker_rentals where id = p_rental;
  return jsonb_build_object('ok', true, 'id', r.id, 'day', r.day, 'period', r.period, 'status', r.status,
                            'code', (select l.code from lockers l where l.id = r.locker_id), 'price', r.price, 'pay', r.pay,
                            'due', round(due, 2), 'back', round(back, 2), 'left', _lk_left(r.day),
                            'booking_id', r.booking_id, 'addons', (select e.addons from queue_entries e where e.id = r.booking_id));
end $function$;
revoke execute on function public.staff_locker_edit(uuid, date, text, text, text, text, text, text) from public, anon;
grant execute on function public.staff_locker_edit(uuid, date, text, text, text, text, text, text) to authenticated;

-- ── 5. app29-4 the wallet's part of a booking cancelled earlier ───────────────────────────────────────────────────
create or replace function public.staff_cancel_held(p_ids text[])
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
/* {booking id: what the wallet held for it just before its cancel}, summed over its whole ledger as
   staff_cancel_session's held is (bug hunt 2026-11-18, app29-4) (20261119000700); cancelled bookings only. */
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_object_agg(q.id, (select greatest(coalesce(-sum(l.amount), 0), 0) from wallet_ledger l
                                    where l.booking_id = q.id and l.kind in ('spend', 'return')
                                      and l.created_at < coalesce(q.cancelled_at, 'infinity'::timestamptz)))
      from queue_entries q
     where q.id = any(coalesce(p_ids, '{}')) and q.status = 'cancelled'), '{}'::jsonb);
end $$;
revoke all on function public.staff_cancel_held(text[]) from public, anon;
grant execute on function public.staff_cancel_held(text[]) to authenticated;

-- ── 6. app30-1 the price a booking had before the house ───────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists house_from numeric(10,2);
comment on column public.queue_entries.house_from is
  'The price before the booking went on the house (paid at 0), while it stays there; null otherwise (20261119000700, zw_house_from)';

create or replace function public._house_from_keep()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
/* A booking on the house (paid at 0) keeps the price it had just before (bug hunt 2026-11-18, app30-1)
   (20261119000700): written as it goes onto the house, kept while it stays there whatever an update sends, cleared once
   it leaves. Taking it off the house (staff_set_house, the pay menu) charges that price again. */
begin
  if coalesce(new.paid, false) and coalesce(new.price, 0) = 0 then
    if coalesce(old.paid, false) and coalesce(old.price, 0) = 0 then
      new.house_from := old.house_from;
    else
      new.house_from := old.price;
    end if;
  else
    new.house_from := null;
  end if;
  return new;
end $fn$;
revoke all on function public._house_from_keep() from public, anon, authenticated;
drop trigger if exists zw_house_from on public.queue_entries;
create trigger zw_house_from before update of paid, price, house_from on public.queue_entries
  for each row execute function public._house_from_keep();

create or replace function public.staff_set_house(p_booking_id text, p_on boolean default true,
                                                  p_op text default null, p_approval text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; amt numeric; f numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into q from queue_entries where id = p_booking_id for update;
  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if coalesce(p_on, true) then
    if coalesce(q.paid, false) and coalesce(q.price, 0) = 0 then
      return jsonb_build_object('ok', true, 'id', q.id, 'noop', true);
    end if;
    amt := greatest(coalesce(q.price, 0), coalesce(_fare_now(q.session_id, q.id, q.type_preference), 0));
    if not _mgr_ok('house', amt, p_approval) then
      raise exception 'MANAGER_REQUIRED' using errcode = '42501';
    end if;
    perform set_config('mm.house_ok', '1', true);
    update queue_entries set paid = true, price = 0, pay_method = null, card_amount = null where id = q.id;
    perform set_config('mm.house_ok', '', true);
    return jsonb_build_object('ok', true, 'id', q.id, 'amount', amt, 'old_price', q.price, 'old_paid', q.paid);
  end if;
  if not (coalesce(q.paid, false) and coalesce(q.price, 0) = 0) then
    return jsonb_build_object('ok', true, 'id', q.id, 'noop', true);
  end if;
  /* the price it had before the house (house_from, kept by zw_house_from), else the fare now: a promo booking put on the
     house and taken off it again pays its promo price, not the full fare (bug hunt 2026-11-18, app30-1) (20261119000700) */
  f := coalesce(q.house_from, _fare_now(q.session_id, q.id, q.type_preference), 0);
  update queue_entries set paid = false, price = f, pay_method = null, card_amount = null where id = q.id;
  return jsonb_build_object('ok', true, 'id', q.id, 'price', f);
end $$;
revoke execute on function public.staff_set_house(text, boolean, text, text) from public, anon;
grant execute on function public.staff_set_house(text, boolean, text, text) to authenticated;

-- ── 7. app33-3 Give the place, on the server ──────────────────────────────────────────────────────────────────────
create or replace function public.staff_give_spot(p_session_id text, p_booking_id text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $fn$
/* Staff give a waitlisted rider the place now (bug hunt 2026-11-18, app33-3) (20261119000700): under the ride's promotion
   lock, the places held, the bikes out of service, the type's own places and the other riders' open offers counted as
   staff_offer_spot counts them, so two desks never both give the last place. NO_PLACE: none left; NOT_WAITLISTED: the
   rider is no longer on this ride's waitlist. An approval ride, and an own bike but on the Petromin night, take no
   place. The rider's open offer closes with the move (queue_entries_wl_offer_close); the add-ons stay the app's. */
declare _s sessions%rowtype; _own boolean; _typ text; _held int; _open int; _out int := 0; _n int;
begin
  if not coalesce((select public._staff_mod('queue', true)), false) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into _s from sessions where id = p_session_id;
  if not found then raise exception 'NO_SESSION' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('promote:' || p_session_id));
  select coalesce(q.type_preference, '') into _typ from queue_entries q
   where q.id = p_booking_id and q.session_id = p_session_id and q.status = 'waitlist'
   for update;
  if not found then raise exception 'NOT_WAITLISTED' using errcode = 'P0001'; end if;
  _own := coalesce(_s.event_kind, '') = 'community' and coalesce(_s.ride_kind, '') = 'petromin';
  if not coalesce(_s.needs_approval, false) and (_own or _typ <> 'Own') then
    select count(*) into _held from queue_entries q
     where q.session_id = p_session_id
       and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow', 'waitlist')
       and (_own or coalesce(q.type_preference, '') <> 'Own');
    select count(*) into _open from waitlist_offers w join queue_entries x on x.id = w.booking_id
     where w.session_id = p_session_id and w.status = 'open' and w.expires_at > now() and w.booking_id <> p_booking_id
       and x.status = 'waitlist' and (_own or coalesce(x.type_preference, '') <> 'Own');
    select coalesce(sum(greatest(0, floor((value #>> '{}')::numeric))), 0)::int into _out
      from jsonb_each(case when jsonb_typeof(_s.out_bikes) = 'object' then _s.out_bikes else '{}'::jsonb end)
     where jsonb_typeof(value) = 'number';
    if greatest(0, coalesce(_s.capacity, 12) - _out) - _held - _open <= 0
       or not _out_bikes_room(p_session_id, _typ, p_booking_id, true) then
      raise exception 'NO_PLACE' using errcode = 'P0001';
    end if;
  end if;
  perform set_config('mm.promoting', '1', true);
  update queue_entries set status = 'waiting' where id = p_booking_id and session_id = p_session_id and status = 'waitlist';
  get diagnostics _n = row_count;
  perform set_config('mm.promoting', '', true);
  if _n = 0 then raise exception 'NOT_WAITLISTED' using errcode = 'P0001'; end if;
  return jsonb_build_object('ok', true, 'id', p_booking_id);
end $fn$;
revoke all on function public.staff_give_spot(text, text) from public, anon;
grant execute on function public.staff_give_spot(text, text) to authenticated;

-- ── 8. app35-5 Spent, as revenue is counted everywhere else ──────────────────────────────────────────────────────
create or replace function public.staff_customer_stats()
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path = public
as $function$
begin
  if not coalesce((select is_staff()), false) then
    raise exception 'STAFF_ONLY' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_array(x.cid, x.b, x.r, x.cr, x.f, x.l, x.ns, x.cx, x.mi, x.sp))
    from (
      select q.customer_id::text as cid,
             count(*)::int as b,
             (count(*) filter (where q.status = 'done'))::int as r,
             (count(*) filter (where q.status = 'done' and s.event_kind = 'community'
                                 and coalesce(s.ride_kind, '') <> 'snd96'))::int as cr,
             min(left(q.session_date::text, 10)) filter (where q.status = 'done') as f,
             max(left(q.session_date::text, 10)) filter (where q.status = 'done') as l,
             (count(*) filter (where q.status = 'noshow'))::int as ns,
             (count(*) filter (where q.status = 'cancelled'))::int as cx,
             coalesce(sum(coalesce(q.ride_duration, 0)) filter (where q.status = 'done'), 0)::int as mi,
             /* spent as the app's _bookingRevenue and the server's _mt_core count it (bug hunt 2026-11-18, app35-5)
                (20261119000700): the price (57.5 when none) and the add-ons, every transfer to an organiser left out */
             round(coalesce(sum(coalesce(q.price, 57.5) + coalesce((
                 select sum(coalesce(case when jsonb_typeof(a) = 'object' and (a->>'p') ~ '^-?[0-9]+(\.[0-9]+)?$' then (a->>'p')::numeric end, i.price, 0)
                            * greatest(coalesce(case when jsonb_typeof(a) = 'object' and (a->>'qty') ~ '^[0-9]+$' then (a->>'qty')::numeric end, 1), 1))
                   from jsonb_array_elements(_mt_json(q.addons)) a
                   left join inventory i on i.id = case when jsonb_typeof(a) = 'object' then a->>'id' else a #>> '{}' end), 0)) filter (
               where q.paid and q.status not in ('cancelled', 'removed') and q.pay_method is distinct from 'transfer'), 0)::numeric, 2) as sp
      from queue_entries q
      left join sessions s on s.id = q.session_id
      where q.customer_id is not null and q.status <> 'removed'
      group by q.customer_id
    ) x), '[]'::jsonb);
end $function$;
revoke all on function public.staff_customer_stats() from public, anon;
grant execute on function public.staff_customer_stats() to authenticated;

-- ── 9. ppl-rentals0-1 a merge moves the owner, the family link and the follow-ups ─────────────────────────────────
create or replace function public._account_family_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- a merge or its undo moves the link whole, with who made it (bug hunt 2026-11-18, ppl-rentals0-1) (20261119000700)
  if coalesce(current_setting('mm.merge', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' or new.customer_id is distinct from old.customer_id then
    new.added_at := now();
    new.added_by := auth.uid();
    new.added_by_name := left(coalesce(
      (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()),
      auth.jwt() ->> 'email',
      'staff'), 120);
    return new;
  end if;
  new.added_at := old.added_at;
  new.added_by := old.added_by;
  new.added_by_name := old.added_by_name;
  return new;
end $function$;
revoke all on function public._account_family_stamp() from public, anon, authenticated;

create or replace function public._account_owners_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
begin
  -- a merge or its undo moves the row whole to the other account (bug hunt 2026-11-18, ppl-rentals0-1) (20261119000700)
  if tg_op = 'UPDATE' and coalesce(current_setting('mm.merge', true), '') = '1' then return new; end if;
  if not exists (select 1 from staff s where s.user_id = new.owner_id and s.disabled_at is null) then
    raise exception 'OWNER_NOT_STAFF' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' then new.customer_id := old.customer_id; end if;
  new.owner_name := left(coalesce(
    (select nullif(btrim(s.display_name), '') from staff s where s.user_id = new.owner_id),
    (select u.email::text from auth.users u where u.id = new.owner_id),
    'staff'), 120);
  new.set_at := now();
  new.set_by := auth.uid();
  new.set_by_name := left(coalesce(
    (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()),
    auth.jwt() ->> 'email',
    'staff'), 120);
  return new;
end $function$;
revoke all on function public._account_owners_stamp() from public, anon, authenticated;

create or replace function public._account_followups_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me text := left(coalesce(
    (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()),
    auth.jwt() ->> 'email',
    'staff'), 120);
begin
  -- a merge or its undo moves the follow-up whole to the other account (bug hunt 2026-11-18, ppl-rentals0-1) (20261119000700)
  if tg_op = 'UPDATE' and coalesce(current_setting('mm.merge', true), '') = '1' then return new; end if;
  new.note := btrim(new.note);
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
    new.created_by_name := me;
    new.done_at := null;
    new.done_by := null;
    new.done_by_name := null;
    return new;
  end if;
  new.customer_id := old.customer_id;
  new.created_at := old.created_at;
  new.created_by := old.created_by;
  new.created_by_name := old.created_by_name;
  if new.done_at is null then
    new.done_by := null;
    new.done_by_name := null;
  elsif old.done_at is null then
    new.done_at := now();
    new.done_by := auth.uid();
    new.done_by_name := me;
  else
    new.done_at := old.done_at;
    new.done_by := old.done_by;
    new.done_by_name := old.done_by_name;
  end if;
  return new;
end $function$;
revoke all on function public._account_followups_stamp() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.staff_merge_customers(p_keep text, p_drop text, p_by text DEFAULT NULL::text, p_op text DEFAULT NULL::text, p_approval text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  k customers%rowtype; d customers%rowtype;
  mv jsonb := '{}'::jsonb; fl text[] := '{}'; ids text[]; m_id bigint;
  tags_moved text[] := '{}'; tags_dup jsonb := '[]'::jsonb; ct customer_tags%rowtype;
  bd customer_badges%rowtype; bdg_moved text[] := '{}'; bdg_dup jsonb := '[]'::jsonb;
  kf customer_flags%rowtype; df customer_flags%rowtype;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  -- The operator's PIN approval (staff_pin_approve), 2026-10-04.
  if not _pin_ok_strict(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if p_keep is null or p_drop is null or p_keep = p_drop then raise exception 'SAME_ACCOUNT' using errcode = '22023'; end if;
  -- both rows locked, lower id first, so two admins merging the same pair cannot cross
  if p_keep < p_drop then
    select * into k from customers where id = p_keep for update;
    select * into d from customers where id = p_drop for update;
  else
    select * into d from customers where id = p_drop for update;
    select * into k from customers where id = p_keep for update;
  end if;
  if k.id is null then raise exception 'NOT_FOUND: keep' using errcode = 'P0002'; end if;
  if d.id is null then raise exception 'NOT_FOUND: drop' using errcode = 'P0002'; end if;
  if k.merged_into is not null or d.merged_into is not null then raise exception 'ALREADY_MERGED' using errcode = '22023'; end if;
  -- an archived account is never joined to another (the user, 2026-11-11; 20261111200000)
  if k.archived_at is not null or d.archived_at is not null then raise exception 'ARCHIVED' using errcode = '22023'; end if;

  with u as (update queue_entries set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('queue_entries', to_jsonb(ids));
  with u as (update cashier_sales set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('cashier_sales', to_jsonb(ids));
  with u as (update customer_notes set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('customer_notes', to_jsonb(ids));
  -- Both accounts may have a correction flag open (one pending per account,
  -- customer_flags_one_pending): the dropped one's fields join the keeper's flag and it is
  -- withdrawn before it moves; unmerge puts both back (20261005210100).
  select * into kf from customer_flags where customer_id = p_keep and status = 'pending' for update;
  select * into df from customer_flags where customer_id = p_drop and status = 'pending' for update;
  if kf.id is not null and df.id is not null then
    update customer_flags
       set fields = kf.fields || array(select f from unnest(df.fields) f where f <> all(kf.fields))
     where id = kf.id;
    update customer_flags set status = 'withdrawn', answered_at = now() where id = df.id;
    mv := mv || jsonb_build_object('flag_fold',
            jsonb_build_object('keep', kf.id, 'drop', df.id, 'keep_fields', to_jsonb(kf.fields)));
  end if;
  with u as (update customer_flags set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('customer_flags', to_jsonb(ids));
  with u as (update push_subscriptions set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('push_subscriptions', to_jsonb(ids));
  with u as (update rider_registrations set matched_customer_id = p_keep where matched_customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('rider_registrations', to_jsonb(ids));
  with u as (update ambassadors set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('ambassadors', to_jsonb(ids));
  with u as (update community_applications set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('community_applications', to_jsonb(ids));
  with u as (update learn_applications set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('learn_applications', to_jsonb(ids));
  with u as (update workshop_jobs set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('workshop_jobs', to_jsonb(ids));
  with u as (update site_messages set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('site_messages', to_jsonb(ids));
  with u as (update promo_codes set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('promo_codes', to_jsonb(ids));
  -- One live award per person per session: the keeper's stands, the other waits voided for an unmerge.
  with u as (update volunteer_hours dup set voided_at = now(), voided_by = 'merge'
              where dup.customer_id = p_drop and dup.source = 'session' and dup.voided_at is null
                and exists (select 1 from volunteer_hours kept where kept.customer_id = p_keep and kept.session_id = dup.session_id
                             and kept.source = 'session' and kept.voided_at is null) returning dup.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_hours_void', to_jsonb(ids));
  with u as (update volunteer_hours set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_hours', to_jsonb(ids));
  with u as (update volunteer_shifts h set customer_id = p_keep where h.customer_id = p_drop
              and not exists (select 1 from volunteer_shifts x where x.customer_id = p_keep and x.session_id = h.session_id) returning h.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_shifts', to_jsonb(ids));
  update volunteer_log set customer_id = p_keep where customer_id = p_drop;
  if not exists (select 1 from volunteers where customer_id = p_keep)
     and exists (select 1 from volunteers where customer_id = p_drop) then
    update volunteers set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('volunteer', true);
  end if;
  /* What else names the account (bh11 sql07-2): its lockers (a Lockers-page rental has no booking to follow, so the
     keeper's My lockers never showed it), its volunteer certificates, portal Updates and the feedback on the shifts
     that moved. A certificate or Update the keeper already has for the same session stays where it is, as a shift
     does; unmerge moves back what moved. */
  with u as (update locker_rentals set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('locker_rentals', to_jsonb(ids));
  with u as (update volunteer_certs c set customer_id = p_keep where c.customer_id = p_drop
              and not (c.kind = 'session' and c.revoked_at is null
                       and exists (select 1 from volunteer_certs x where x.customer_id = p_keep and x.session_id = c.session_id
                                    and x.kind = 'session' and x.revoked_at is null)) returning c.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_certs', to_jsonb(ids));
  with u as (update volunteer_updates w set customer_id = p_keep where w.customer_id = p_drop
              and not exists (select 1 from volunteer_updates x where x.customer_id = p_keep
                               and coalesce(x.session_id, '') = coalesce(w.session_id, '') and x.kind = w.kind) returning w.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_updates', to_jsonb(ids));
  with u as (update volunteer_feedback f set customer_id = p_keep where f.customer_id = p_drop
              and exists (select 1 from volunteer_shifts h where h.id = f.shift_id and h.customer_id = p_keep) returning f.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_feedback', to_jsonb(ids));
  /* The mentorship records (bh18 sql10-6) (20261119000300): the member-side pages read them by the account signed in,
     so on the keeper the student's mentee profile and match, or the mentor's card and offers, were gone and they could
     register again. The profiles, the mentor card, the offers made as a mentor and the check-ins move. A live profile
     (pending, open, matched) moves only while the keeper has none, a mentor card only when the keeper has none, and
     an offer only when the keeper has no live one on the same profile (one each, as the tables keep it); what stays
     is still seen by staff on the merged account. Unmerge moves back what moved. */
  with u as (update mentor_profiles p set customer_id = p_keep where p.customer_id = p_drop
              and not (p.status in ('pending', 'open', 'matched')
                       and exists (select 1 from mentor_profiles x where x.customer_id = p_keep
                                    and x.status in ('pending', 'open', 'matched'))) returning p.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('mentor_profiles', to_jsonb(ids));
  with u as (update mentor_offers o set mentor_id = p_keep where o.mentor_id = p_drop
              and not (o.status in ('offered', 'proposed', 'matched')
                       and exists (select 1 from mentor_offers x where x.mentor_id = p_keep and x.profile_id = o.profile_id
                                    and x.status in ('offered', 'proposed', 'matched'))) returning o.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('mentor_offers', to_jsonb(ids));
  with u as (update mentor_checks set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('mentor_checks', to_jsonb(ids));
  if not exists (select 1 from mentor_mentors where customer_id = p_keep)
     and exists (select 1 from mentor_mentors where customer_id = p_drop) then
    update mentor_mentors set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('mentor_mentor', true);
  end if;
  delete from customer_handoffs where customer_id = p_drop; -- two-minute sign-in codes: nothing to keep

  -- tags: a tag the keeper holds already is dropped, the others move (the primary key is (customer, tag))
  /* A dropped one is kept whole in the record, as a badge is, so unmerge gives it back with its window and who
     gave it when, not as a grant with no end (bh10). */
  for ct in select * from customer_tags where customer_id = p_drop loop
    if exists (select 1 from customer_tags where customer_id = p_keep and tag_id = ct.tag_id) then
      delete from customer_tags where customer_id = p_drop and tag_id = ct.tag_id;
      tags_dup := tags_dup || jsonb_build_array(to_jsonb(ct));
    else
      update customer_tags set customer_id = p_keep where customer_id = p_drop and tag_id = ct.tag_id;
      tags_moved := tags_moved || ct.tag_id;
    end if;
  end loop;
  mv := mv || jsonb_build_object('tags_moved', to_jsonb(tags_moved), 'tags_dup', tags_dup);

  -- badges, the same way; a badge the keeper holds already is kept whole in the record for unmerge
  for bd in select * from customer_badges where customer_id = p_drop loop
    if exists (select 1 from customer_badges where customer_id = p_keep and badge_id = bd.badge_id) then
      delete from customer_badges where customer_id = p_drop and badge_id = bd.badge_id;
      bdg_dup := bdg_dup || jsonb_build_array(to_jsonb(bd));
    else
      update customer_badges set customer_id = p_keep where customer_id = p_drop and badge_id = bd.badge_id;
      bdg_moved := array_append(bdg_moved, bd.badge_id);
    end if;
  end loop;
  mv := mv || jsonb_build_object('badges_moved', to_jsonb(bdg_moved), 'badges_dup', bdg_dup);

  -- one-row-per-account records: moved only when the keeper has none
  if not exists (select 1 from customer_ig_followers where customer_id = p_keep)
     and exists (select 1 from customer_ig_followers where customer_id = p_drop) then
    update customer_ig_followers set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('ig_followers', true);
  end if;
  if not exists (select 1 from customer_owner_pwd where customer_id = p_keep)
     and exists (select 1 from customer_owner_pwd where customer_id = p_drop) then
    update customer_owner_pwd set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('owner_pwd', true);
  end if;
  /* The staff-side links (bug hunt 2026-11-18, ppl-rentals0-1) (20261119000700): the account's owner and its family link
     go to the keeper when it has none (one row per account), and its follow-ups go with it, so the keeper's window shows
     them and a family's list never names the merged-away account. A family link of the dropped account while the
     keeper has one of its own is kept whole in the record and taken off (unmerge puts it back). The stamp triggers keep
     who made each row while mm.merge says this is a merge. */
  perform set_config('mm.merge', '1', true);
  if not exists (select 1 from account_owners where customer_id = p_keep)
     and exists (select 1 from account_owners where customer_id = p_drop) then
    update account_owners set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('account_owner', true);
  end if;
  if exists (select 1 from account_family where customer_id = p_drop) then
    if not exists (select 1 from account_family where customer_id = p_keep) then
      update account_family set customer_id = p_keep where customer_id = p_drop;
      mv := mv || jsonb_build_object('account_family', true);
    else
      mv := mv || jsonb_build_object('account_family_dup', (select to_jsonb(f) from account_family f where f.customer_id = p_drop));
      delete from account_family where customer_id = p_drop;
    end if;
  end if;
  with u as (update account_followups set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('account_followups', to_jsonb(ids));
  perform set_config('mm.merge', '', true);

  -- what the keeper lacked, from the other
  if coalesce(k.height, 0) = 0 and coalesce(d.height, 0) > 0 then update customers set height = d.height where id = p_keep; fl := array_append(fl, 'height'); end if;
  if coalesce(k.gender, '') = '' and coalesce(d.gender, '') <> '' then update customers set gender = d.gender where id = p_keep; fl := array_append(fl, 'gender'); end if;
  if coalesce(k.birth_date, '') = '' and coalesce(d.birth_date, '') <> '' then update customers set birth_date = d.birth_date where id = p_keep; fl := array_append(fl, 'birth_date'); end if;
  if coalesce(k.country, '') = '' and coalesce(d.country, '') <> '' then update customers set country = d.country where id = p_keep; fl := array_append(fl, 'country'); end if;
  if coalesce(k.city, '') = '' and coalesce(d.city, '') <> '' then update customers set city = d.city where id = p_keep; fl := array_append(fl, 'city'); end if;
  if coalesce(k.nationality, '') = '' and coalesce(d.nationality, '') <> '' then update customers set nationality = d.nationality where id = p_keep; fl := array_append(fl, 'nationality'); end if;
  if coalesce(k.type_preference, '') = '' and coalesce(d.type_preference, '') <> '' then update customers set type_preference = d.type_preference where id = p_keep; fl := array_append(fl, 'type_preference'); end if;
  if coalesce(k.photo, '') = '' and coalesce(d.photo, '') <> '' then update customers set photo = d.photo where id = p_keep; fl := array_append(fl, 'photo'); end if;
  if coalesce(k.profession, '') = '' and coalesce(d.profession, '') <> '' then update customers set profession = d.profession where id = p_keep; fl := array_append(fl, 'profession'); end if;
  if coalesce(k.workplace, '') = '' and coalesce(d.workplace, '') <> '' then update customers set workplace = d.workplace where id = p_keep; fl := array_append(fl, 'workplace'); end if;
  if coalesce(k.heard_from, '') = '' and coalesce(d.heard_from, '') <> '' then update customers set heard_from = d.heard_from where id = p_keep; fl := array_append(fl, 'heard_from'); end if;
  if k.socials is null and d.socials is not null then update customers set socials = d.socials where id = p_keep; fl := array_append(fl, 'socials'); end if;

  update customers set merged_into = p_keep, session_token = null where id = p_drop;

  insert into customer_merges (keep_id, drop_id, keep_name, drop_name, moved, filled, merged_by)
    values (p_keep, p_drop, k.name, d.name, mv, to_jsonb(fl), p_by) returning id into m_id;
  return jsonb_build_object('ok', true, 'id', m_id, 'moved', mv, 'filled', to_jsonb(fl), 'keep_name', k.name, 'drop_name', d.name);
end $function$;
revoke all on function public.staff_merge_customers(text, text, text, text, text) from public, anon;
grant execute on function public.staff_merge_customers(text, text, text, text, text) to authenticated;

CREATE OR REPLACE FUNCTION public.staff_unmerge_customers(p_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  m customer_merges%rowtype; ids text[]; col text; tg text; bj jsonb;
  cols text[] := array['height','gender','birth_date','country','city','nationality','type_preference','photo','profession','workplace','heard_from','socials'];
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  select * into m from customer_merges where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if m.undone_at is not null then raise exception 'ALREADY_UNDONE' using errcode = '22023'; end if;
  if m.merged_at < now() - interval '30 days' then raise exception 'TOO_LATE' using errcode = '22023'; end if;
  perform 1 from customers where id in (m.keep_id, m.drop_id) order by id for update;
  -- Either account deleted since: nothing to give back to (it failed on a foreign key half way; bh14).
  if (select count(*) from customers where id in (m.keep_id, m.drop_id)) < 2 then
    raise exception 'NOT_FOUND: account' using errcode = 'P0002';
  end if;
  -- Either account archived since: restore it first (20261111200000).
  if exists (select 1 from customers where id in (m.keep_id, m.drop_id) and archived_at is not null) then
    raise exception 'ARCHIVED' using errcode = '22023';
  end if;
  -- The keeper was merged into a third account since: that merge is undone first (20261005210100).
  if exists (select 1 from customers where id = m.keep_id and merged_into is not null) then
    raise exception 'KEEPER_MERGED' using errcode = '22023';
  end if;

  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'queue_entries', '[]')) x;
  update queue_entries set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'cashier_sales', '[]')) x;
  update cashier_sales set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'customer_notes', '[]')) x;
  update customer_notes set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'customer_flags', '[]')) x;
  update customer_flags set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  -- Two open flags were folded at the merge: the keeper's gets its own fields back, the other
  -- is open again on its own account (20261005210100).
  if m.moved ? 'flag_fold' then
    update customer_flags
       set fields = array(select x from jsonb_array_elements_text(m.moved->'flag_fold'->'keep_fields') with ordinality t(x, o) order by o)
     where id = (m.moved->'flag_fold'->>'keep')::uuid and status = 'pending';
    update customer_flags set status = 'pending', answered_at = null
     where id = (m.moved->'flag_fold'->>'drop')::uuid and customer_id = m.drop_id and status = 'withdrawn'
       and not exists (select 1 from customer_flags x where x.customer_id = m.drop_id and x.status = 'pending');
  end if;
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'push_subscriptions', '[]')) x;
  update push_subscriptions set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'rider_registrations', '[]')) x;
  update rider_registrations set matched_customer_id = m.drop_id where matched_customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'ambassadors', '[]')) x;
  update ambassadors set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'community_applications', '[]')) x;
  update community_applications set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'learn_applications', '[]')) x;
  update learn_applications set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'workshop_jobs', '[]')) x;
  update workshop_jobs set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'site_messages', '[]')) x;
  update site_messages set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'promo_codes', '[]')) x;
  update promo_codes set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);

  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_hours', '[]')) x;
  update volunteer_hours set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_hours_void', '[]')) x;
  update volunteer_hours set voided_at = null, voided_by = null where id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_shifts', '[]')) x;
  update volunteer_shifts set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  if coalesce((m.moved->>'volunteer')::boolean, false)
     and not exists (select 1 from volunteers where customer_id = m.drop_id) then
    update volunteers set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;
  /* lockers, certificates, portal Updates and feedback the merge moved (bh11 sql07-2) */
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'locker_rentals', '[]')) x;
  update locker_rentals set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_certs', '[]')) x;
  update volunteer_certs c set customer_id = m.drop_id where c.customer_id = m.keep_id and c.id::text = any(ids)
    and not (c.kind = 'session' and c.revoked_at is null
             and exists (select 1 from volunteer_certs y where y.customer_id = m.drop_id and y.session_id = c.session_id
                          and y.kind = 'session' and y.revoked_at is null));
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_updates', '[]')) x;
  update volunteer_updates w set customer_id = m.drop_id where w.customer_id = m.keep_id and w.id::text = any(ids)
    and not exists (select 1 from volunteer_updates y where y.customer_id = m.drop_id
                     and coalesce(y.session_id, '') = coalesce(w.session_id, '') and y.kind = w.kind);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_feedback', '[]')) x;
  update volunteer_feedback set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  /* the mentorship records the merge moved (bh18 sql10-6) (20261119000300); a live one only while the account it goes
     back to has none */
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'mentor_profiles', '[]')) x;
  update mentor_profiles p set customer_id = m.drop_id where p.customer_id = m.keep_id and p.id::text = any(ids)
    and not (p.status in ('pending', 'open', 'matched')
             and exists (select 1 from mentor_profiles y where y.customer_id = m.drop_id and y.status in ('pending', 'open', 'matched')));
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'mentor_offers', '[]')) x;
  update mentor_offers o set mentor_id = m.drop_id where o.mentor_id = m.keep_id and o.id::text = any(ids)
    and not (o.status in ('offered', 'proposed', 'matched')
             and exists (select 1 from mentor_offers y where y.mentor_id = m.drop_id and y.profile_id = o.profile_id
                          and y.status in ('offered', 'proposed', 'matched')));
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'mentor_checks', '[]')) x;
  update mentor_checks set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  if coalesce((m.moved->>'mentor_mentor')::boolean, false)
     and not exists (select 1 from mentor_mentors where customer_id = m.drop_id) then
    update mentor_mentors set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;

  for tg in select x from jsonb_array_elements_text(coalesce(m.moved->'tags_moved', '[]')) x loop
    update customer_tags set customer_id = m.drop_id where customer_id = m.keep_id and tag_id = tg
      and not exists (select 1 from customer_tags where customer_id = m.drop_id and tag_id = tg);
  end loop;
  /* The dropped account's own copy of a tag both held comes back as it was: its window, who gave it and when
     (bh10; zz_sync_touch stamps updated_at, so the staff pages see it). A record from before kept the tag's id
     alone, and that comes back as before. */
  for bj in select x from jsonb_array_elements(coalesce(m.moved->'tags_dup', '[]')) x loop
    if jsonb_typeof(bj) = 'object' then
      insert into customer_tags select (jsonb_populate_record(null::customer_tags, bj || jsonb_build_object('customer_id', m.drop_id))).*
        on conflict do nothing;
    elsif jsonb_typeof(bj) = 'string' then
      insert into customer_tags (customer_id, tag_id, added_by, added_at)
        values (m.drop_id, bj #>> '{}', 'unmerge', (extract(epoch from now()) * 1000)::bigint)
        on conflict do nothing;
    end if;
  end loop;

  for tg in select x from jsonb_array_elements_text(coalesce(m.moved->'badges_moved', '[]')) x loop
    update customer_badges set customer_id = m.drop_id where customer_id = m.keep_id and badge_id = tg
      and not exists (select 1 from customer_badges where customer_id = m.drop_id and badge_id = tg);
  end loop;
  for bj in select x from jsonb_array_elements(coalesce(m.moved->'badges_dup', '[]')) x loop
    insert into customer_badges select (jsonb_populate_record(null::customer_badges, bj || jsonb_build_object('customer_id', m.drop_id))).*
      on conflict do nothing;
  end loop;
  if coalesce((m.moved->>'ig_followers')::boolean, false)
     and not exists (select 1 from customer_ig_followers where customer_id = m.drop_id) then
    update customer_ig_followers set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;
  if coalesce((m.moved->>'owner_pwd')::boolean, false)
     and not exists (select 1 from customer_owner_pwd where customer_id = m.drop_id) then
    update customer_owner_pwd set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;
  /* the owner, the family link and the follow-ups the merge moved (bug hunt 2026-11-18, ppl-rentals0-1) (20261119000700) */
  perform set_config('mm.merge', '1', true);
  if coalesce((m.moved->>'account_owner')::boolean, false)
     and not exists (select 1 from account_owners where customer_id = m.drop_id) then
    update account_owners set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;
  if coalesce((m.moved->>'account_family')::boolean, false)
     and not exists (select 1 from account_family where customer_id = m.drop_id) then
    update account_family set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;
  if jsonb_typeof(m.moved->'account_family_dup') = 'object'
     and not exists (select 1 from account_family where customer_id = m.drop_id) then
    insert into account_family select (jsonb_populate_record(null::account_family, (m.moved->'account_family_dup') || jsonb_build_object('customer_id', m.drop_id))).*
      on conflict do nothing;
  end if;
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'account_followups', '[]')) x;
  update account_followups set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  perform set_config('mm.merge', '', true);

  for col in select x from jsonb_array_elements_text(coalesce(m.filled, '[]')) x loop
    -- only while the keeper still holds the value it was given: one it set since is its own (20261007120100)
    if col = any(cols) then
      execute format('update customers k set %I = null from customers d where k.id = $1 and d.id = $2 and k.%I is not distinct from d.%I',
                     col, col, col)
        using m.keep_id, m.drop_id;
    end if;
  end loop;

  update customers set merged_into = null where id = m.drop_id and merged_into = m.keep_id;
  update customer_merges set undone_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'keep_name', m.keep_name, 'drop_name', m.drop_name);
end $function$;
revoke all on function public.staff_unmerge_customers(bigint) from public, anon;
grant execute on function public.staff_unmerge_customers(bigint) to authenticated;

-- ── 10. sql04-1 a date move takes the new day's breakfast stop (and sql01-5's page lockers) ───────────────────────
CREATE OR REPLACE FUNCTION public.staff_move_session(p_from text, p_to_id text, p_date text, p_exact boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s sessions%rowtype;
  d date;
  v_to text := p_to_id;
  v_day text;
  n int := 1;
  fr record;
  fk record; v_left boolean;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  begin
    d := p_date::date;
  exception when others then
    raise exception 'BAD_DATE' using errcode = '22007';
  end;
  if coalesce(p_to_id, '') = '' or (not p_exact and left(p_to_id, 10) <> to_char(d, 'YYYY-MM-DD')) then
    raise exception 'BAD_SESSION_ID' using errcode = '22023';
  end if;
  select * into s from sessions where id = p_from for update;
  if s.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_to_id = p_from then raise exception 'BAD_SESSION_ID' using errcode = '22023'; end if;

  while exists (select 1 from sessions where id = v_to) loop
    if p_exact then raise exception 'SESSION_ID_TAKEN' using errcode = '23505'; end if;
    n := n + 1;
    if n > 25 then raise exception 'SESSION_ID_TAKEN' using errcode = '23505'; end if;
    v_to := p_to_id || '-' || n;
  end loop;

  v_day := to_char(d, 'FMDay');
  insert into sessions
    select (jsonb_populate_record(s, jsonb_build_object('id', v_to, 'session_date', to_char(d, 'YYYY-MM-DD'), 'day', v_day,
      /* the ride's own moments move with its date, as many days on or back (bug hunt 2026-11-10, 20261110235300):
         its announce time, its timed opening, its go/no-go decision time; none stays none */
      'reveal_at', s.reveal_at + make_interval(days => coalesce(d - s.session_date::date, 0)),
      'opens_at', s.opens_at + make_interval(days => coalesce(d - s.session_date::date, 0)),
      'go_decide_at', s.go_decide_at + make_interval(days => coalesce(d - s.session_date::date, 0))))).*;
  /* The breakfast stop (bug hunt 2026-11-18, sql04-1) (20261119000700): the insert puts the new day's confirmed venue on the
     copy (_vendor_session_fill). With none confirmed that day, a stop that was the old day's venue does not go along; a
     stop typed by hand stays. */
  if s.event_kind = 'community' and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.breakfast_name is not null
     and _safe_date(s.session_date) is distinct from d
     and not exists (select 1 from vendor_bookings b join vendor_venues ve on ve.id = b.venue_id where b.day = d and b.status = 'confirmed')
     and s.breakfast_name is not distinct from (select vd.synced_name from vendor_dates vd where vd.day = _safe_date(s.session_date)) then
    perform set_config('vendor.sync', '1', true);
    update sessions set breakfast_name = null, breakfast_url = null, breakfast_name_ar = null, breakfast_offer_en = null, breakfast_offer_ar = null
     where id = v_to;
    perform set_config('vendor.sync', '', true);
  end if;

  update queue_entries set session_id = v_to, session_date = to_char(d, 'YYYY-MM-DD'), session_day = v_day where session_id = p_from;
  /* Lockers reserved for the evening on the Lockers page move with it too (bh11 sql07-3): they have no booking for
     _lk_booking_follow to move, so they kept the old date and a session id deleted below; the new evening did not
     hold their door and the old one's End of night cancelled them. As a moved booking's locker: the door goes along
     only when nobody holds it there for an overlapping time, and one left without a door is given a free one. A
     cancelled or handed-back rental keeps its day and follows the id, for its history. */
  perform _lk_lock(d);
  /* only those still reserved (bug hunt 2026-11-18, sql01-5's page lockers) (20261119000700): one in use keeps its day and its
     door until it is handed back (its session id follows below, for its history) */
  update locker_rentals r set session_id = v_to, day = d
   where r.session_id = p_from and r.booking_id is null and r.status = 'reserved';
  update locker_rentals r set locker_id = null, status = 'reserved', assigned_at = null, assigned_by = null
   where r.session_id = v_to and r.booking_id is null and r.status = 'reserved' and r.locker_id is not null
     and exists (select 1 from locker_rentals x
                  where x.locker_id = r.locker_id and x.day = r.day and x.id <> r.id
                    and x.status in ('reserved', 'in_use') and _lk_slots(x.period) && _lk_slots(r.period));
  for fr in select r.id, r.day, r.period from locker_rentals r
             where r.session_id = v_to and r.booking_id is null and r.status = 'reserved' and r.locker_id is null
             order by r.created_at loop
    update locker_rentals set locker_id = _lk_free_unit(fr.day, fr.period, fr.id) where id = fr.id;
  end loop;
  update locker_rentals set session_id = v_to where session_id = p_from;
  update cashier_sales set session_id = v_to where session_id = p_from;
  update community_applications set invited_session = v_to where invited_session = p_from;
  update customer_badges set session_id = v_to where session_id = p_from;
  update rider_registrations set session_id = v_to where session_id = p_from;
  update session_partners set session_id = v_to where session_id = p_from;
  update saturday_code_rides set session_id = v_to where session_id = p_from;   -- 20261108120000
  update part_timer_shifts set session_id = v_to where session_id = p_from;
  update till_sessions set session_id = v_to where session_id = p_from;
  update deposits set session_id = v_to where session_id = p_from;
  update waitlist_offers set session_id = v_to where session_id = p_from;
  update wallet_ledger set session_id = v_to where session_id = p_from;
  update session_rota set session_id = v_to where session_id = p_from;   -- 20261107111000
  update member_kudos k set session_id = v_to where k.session_id = p_from
    and not exists (select 1 from member_kudos x where x.from_id = k.from_id and x.to_id = k.to_id and x.session_id = v_to);
  update live_positions l set session_id = v_to where l.session_id = p_from
    and not exists (select 1 from live_positions x where x.session_id = v_to and x.role = l.role);
  update rider_night_counters c set session_key = v_to where c.session_key = p_from
    and not exists (select 1 from rider_night_counters x where x.session_key = v_to and x.source = c.source);

  -- Volunteers (20261105120000).
  update volunteer_sessions w set session_id = v_to,
         opens_at = w.opens_at + make_interval(days => d - s.session_date::date),
         closes_at = w.closes_at + make_interval(days => d - s.session_date::date)
   where w.session_id = p_from and not exists (select 1 from volunteer_sessions x where x.session_id = v_to);
  update volunteer_shifts h set session_id = v_to where h.session_id = p_from
    and not exists (select 1 from volunteer_shifts x where x.session_id = v_to and x.customer_id = h.customer_id);
  update volunteer_hours set session_id = v_to where session_id = p_from;
  update volunteer_log set session_id = v_to where session_id = p_from;
  /* What else names the session (bug hunt 2026-11-10, 20261110235000): a promo code made for this one
     session, the volunteers' VL- free-ride codes, their portal Updates (on delete cascade) and their
     certificates (on delete set null) stayed with the old id; they move with the session now. */
  update promo_codes set session_id = v_to where session_id = p_from;
  update promo_codes set volunteer_session_id = v_to where volunteer_session_id = p_from;
  update volunteer_updates u set session_id = v_to where u.session_id = p_from
    and not exists (select 1 from volunteer_updates x where x.customer_id = u.customer_id and x.session_id = v_to and x.kind = u.kind);
  update volunteer_certs set session_id = v_to where session_id = p_from;

  /* Every row that names the session through a foreign key follows it (bh18 sql10-1) (20261119000300). The id is
     never updated (a copy is made and the old row deleted below), so 'on update cascade' never fired and the delete
     took what was not on the list above: the Farmhouse night's code (farm_codes, on delete cascade: the page then
     refused everyone with 'code'), the night's crew (session_crew), the volunteers' feedback and ratings, and blanked
     the hub posts and circuit laps (on delete set null). The tables are read from the database's own foreign keys, so
     one added later follows too. The crew's stamp keeps a row's night unless mm.session_move says this is a move.
     A row still naming the old id after that stops the move (MOVE_LEFT_ROWS) rather than be deleted with it. */
  perform set_config('mm.session_move', '1', true);
  for fk in select c.conrelid::regclass::text as t, a.attname::text as col
              from pg_constraint c
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
             where c.contype = 'f' and c.confrelid = 'public.sessions'::regclass and cardinality(c.conkey) = 1
               and c.conrelid <> 'public.sessions'::regclass
             order by 1, 2 loop
    execute format('update %s set %I = $1 where %I = $2', fk.t, fk.col, fk.col) using v_to, p_from;
  end loop;
  perform set_config('mm.session_move', '', true);
  for fk in select c.conrelid::regclass::text as t, a.attname::text as col
              from pg_constraint c
              join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
             where c.contype = 'f' and c.confrelid = 'public.sessions'::regclass and cardinality(c.conkey) = 1
               and c.conrelid <> 'public.sessions'::regclass loop
    execute format('select exists (select 1 from %s where %I = $1)', fk.t, fk.col) into v_left using p_from;
    if v_left then raise exception 'MOVE_LEFT_ROWS: % still names the session', fk.t using errcode = 'P0001'; end if;
  end loop;

  delete from sessions where id = p_from;
  return jsonb_build_object('ok', true, 'id', v_to, 'day', v_day);
end $function$;
revoke all on function public.staff_move_session(text, text, text, boolean) from public, anon;
grant execute on function public.staff_move_session(text, text, text, boolean) to authenticated;

-- ── 11. app42-3 data fix: no unit cost in a workshop job's part lines ─────────────────────────────────────────────
-- Only rows whose lines hold a 'cost' key; every other key of every line stays; a re-run finds none.
update public.workshop_jobs w
   set parts_used = (select jsonb_agg(case when jsonb_typeof(e) = 'object' then e - 'cost' else e end order by o)
                       from jsonb_array_elements(w.parts_used) with ordinality t(e, o))
 where w.parts_used is not null and jsonb_typeof(w.parts_used) = 'array'
   and exists (select 1 from jsonb_array_elements(w.parts_used) e where jsonb_typeof(e) = 'object' and e ? 'cost');

-- ── 12. app46-3 the till's wallet moves carry their receipt ──────────────────────────────────────────────────────
do $wm$
begin
  if position('(20261119000700)' in coalesce((select prosrc from pg_proc where oid = to_regprocedure('public.staff_wallet_moves(date)')), '')) = 0 then
    drop function if exists public.staff_wallet_moves(date);
  end if;
end $wm$;
create or replace function public.staff_wallet_moves(p_from date)
returns table(id bigint, kind text, amount numeric, method text, card_part numeric, session_id text, created_at timestamptz, receipt_id text)
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  -- with the receipt a refund gave back, so a shop till counts it on the day the receipt was sold (bug hunt 2026-11-18,
  -- app46-3) (20261119000700)
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return query select l.id, l.kind, l.amount, l.method, l.card_part, l.session_id, l.created_at, l.receipt_id from wallet_ledger l
    where l.kind in ('topup', 'takeout', 'refund') and l.created_at >= (coalesce(p_from, current_date - 60)::timestamp at time zone 'Asia/Riyadh');
end $$;
revoke all on function public.staff_wallet_moves(date) from public, anon;
grant execute on function public.staff_wallet_moves(date) to authenticated;

-- ── 13. sql14-2 the till's expected figures, worked out on the server ─────────────────────────────────────────────
create or replace function public._till_expected(p_id uuid)
returns table(cash numeric, card numeric)
language plpgsql stable security definer set search_path to 'public'
as $fn$
/* What a till is checked against (bug hunt 2026-11-18, sql14-2) (20261119000700), from its own records, as the staff
   app's _tillTake / _tillNet / _tillDep / _cwTill / _salesCC / _mnySum / _mnyPurch work it out:
   - a ride's till (session_id set): every session of its day. The paid bookings (not cancelled or removed, not a
     transfer to an organiser) at price (the default fare when none) plus add-ons, less the wallet's part, split by
     card_amount, else by pay_method card / cash (online and no method: neither); the purchases rung up on any booking
     of those sessions (paid lines; card when their method says so, else cash); the Sales receipts of each session by
     their '__cardmeta__' card and wallet lines, a receipt with a refunded line left out, voided lines left out; the
     wallet moves at those sessions whatever the hour (a refund by its card_part, the rest cash; a top-up or take-out by
     its method); the cash deposits of those sessions or that day, a returned one only for what was kept.
   - the shop's till (no session): the Sales receipts with no ride sold that KSA day; the wallet moves with no ride of
     that day, a refund on the day its receipt was sold.
   - less what the tills of the same kind closed earlier that day took (their expected cash less their float, their
     card), as _tillPriorRead does.
   cash = float + takings in cash + deposits; card = takings by card. Staff who can see the till (cashier). */
declare t till_sessions%rowtype; v_day text; v_ids text[]; v_dp numeric := 57.5; v_n numeric;
  r_cash numeric := 0; r_card numeric := 0; p_all numeric := 0; p_card numeric := 0; s_cash numeric := 0; s_card numeric := 0;
  w_cash numeric := 0; w_card numeric := 0; v_dep numeric := 0; o_cash numeric := 0; o_card numeric := 0; o_n int := 0;
  k_cash numeric; k_card numeric;
begin
  if not coalesce((select public._staff_mod('cashier', false)), false) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into t from till_sessions where id = p_id;
  if not found then return; end if;
  v_day := to_char(t.day, 'YYYY-MM-DD');
  -- the default fare (Settings > Pricing), as the app's DEFAULT_PRICE reads it
  select (o.items ->> 'default_price')::numeric into v_n from staff_options o
   where o.key = 'biz' and jsonb_typeof(o.items -> 'default_price') = 'number';
  if v_n between 1 and 5000 then v_dp := v_n; end if;

  if t.session_id is null then
    -- the shop: its day's Sales receipts with no ride
    select coalesce(round(sum(x.c), 2), 0), coalesce(round(sum(x.l - x.c), 2), 0) into s_card, s_cash
      from (select least(greatest(0, rc.card), greatest(0, rc.paid - least(greatest(0, rc.wal), greatest(0, rc.paid)))) as c,
                   greatest(0, rc.paid - least(greatest(0, rc.wal), greatest(0, rc.paid))) as l
              from (select coalesce(c.receipt_id, c.id) as k,
                           coalesce(bool_or(c.pay = 'refunded'), false) as refunded,
                           coalesce(sum(coalesce(c.qty, 0) * coalesce(c.price, 0)) filter (where c.pay = 'paid' and c.category is distinct from '__cardmeta__'), 0) as paid,
                           coalesce((array_agg(c.price order by c.id desc) filter (where c.category = '__cardmeta__' and c.pay is distinct from 'wallet' and c.pay is distinct from 'refunded'))[1], 0) as card,
                           coalesce((array_agg(c.price order by c.id desc) filter (where c.category = '__cardmeta__' and c.pay = 'wallet'))[1], 0) as wal
                      from cashier_sales c
                     where nullif(c.session_id, '') is null and c.voided_at is null
                       and (case when c.created_at::text ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?(Z|[+-]([01]\d|2[0-3])(:?[0-5]\d)?)?$'
                                 then to_char(c.created_at::text::timestamptz at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
                                 else left(c.created_at::text, 10) end) = v_day
                     group by 1) rc
             where not rc.refunded) x;
    -- the wallet moves with no ride: the day's, and a refund on the day its receipt was sold
    select coalesce(round(sum(case when m.kind = 'refund' then m.amount - coalesce(m.card_part, 0) when m.method = 'cash' then m.amount else 0 end), 2), 0),
           coalesce(round(sum(case when m.kind = 'refund' then coalesce(m.card_part, 0) when m.method = 'card' then m.amount else 0 end), 2), 0)
      into w_cash, w_card
      from wallet_ledger m
     where m.kind in ('topup', 'takeout', 'refund') and nullif(m.session_id, '') is null
       and (m.kind <> 'refund' or m.method is not null)
       and m.created_at >= (t.day::timestamp at time zone 'Asia/Riyadh')
       and coalesce(case when m.kind = 'refund' and m.receipt_id is not null then
                      (select case when c.created_at::text ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?(Z|[+-]([01]\d|2[0-3])(:?[0-5]\d)?)?$'
                                   then to_char(c.created_at::text::timestamptz at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
                                   else left(c.created_at::text, 10) end
                         from cashier_sales c where coalesce(c.receipt_id, c.id) = m.receipt_id and c.voided_at is null
                        order by c.id limit 1) end,
                    to_char(m.created_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD')) = v_day;
    k_cash := round(s_cash + w_cash, 2);
    k_card := round(s_card + w_card, 2);
  else
    select coalesce(array_agg(s.id), '{}') into v_ids from sessions s where coalesce(s.session_date, s.id) = v_day;
    -- the paid bookings, by how their money was taken
    with q as (
      select qe.paid, qe.pay_method, qe.card_amount, coalesce(qe.wallet_paid, 0) as wp,
             coalesce(qe.price, v_dp) + coalesce((
               select round(sum(round(coalesce(case when jsonb_typeof(a) = 'object' and jsonb_typeof(a -> 'p') = 'number' then (a ->> 'p')::numeric end, i.price, 0)
                                      * greatest(case when jsonb_typeof(a) = 'object' and (a ->> 'qty') ~ '^[0-9]+(\.[0-9]+)?$' then (a ->> 'qty')::numeric else 1 end, 1), 2)), 2)
                 from jsonb_array_elements(_mt_json(qe.addons)) a
                 left join inventory i on i.id = case when jsonb_typeof(a) = 'object' then a ->> 'id' else a #>> '{}' end
                where nullif(case when jsonb_typeof(a) = 'object' then a ->> 'id' else a #>> '{}' end, '') is not null), 0) as amt
        from queue_entries qe
       where qe.session_id = any(v_ids) and coalesce(qe.paid, false)
         and coalesce(qe.status, '') not in ('cancelled', 'removed') and qe.pay_method is distinct from 'transfer'
    ), d as (
      select q.pay_method, q.card_amount, greatest(0, round(q.amt - case when q.pay_method = 'wallet' then q.amt else q.wp end, 2)) as due from q
    )
    select coalesce(round(sum(case when d.pay_method = 'online' then 0
                                   when d.card_amount is not null then d.due - least(greatest(0, d.card_amount), d.due)
                                   when d.pay_method = 'cash' then d.due else 0 end), 2), 0),
           coalesce(round(sum(case when d.pay_method = 'online' then 0
                                   when d.card_amount is not null then least(greatest(0, d.card_amount), d.due)
                                   when d.pay_method = 'card' then d.due else 0 end), 2), 0)
      into r_cash, r_card from d;
    -- the purchases rung up on those sessions' bookings
    select coalesce(round(sum(x.v), 2), 0), coalesce(round(sum(x.v) filter (where x.method = 'card'), 2), 0) into p_all, p_card
      from (select (case when (p ->> 'qty') ~ '^-?[0-9]+(\.[0-9]+)?$' then (p ->> 'qty')::numeric else 0 end)
                   * (case when (p ->> 'price') ~ '^-?[0-9]+(\.[0-9]+)?$' then (p ->> 'price')::numeric else 0 end) as v,
                   p ->> 'method' as method
              from queue_entries qe cross join lateral jsonb_array_elements(_mt_json(qe.purchases)) p
             where qe.session_id = any(v_ids) and jsonb_typeof(p) = 'object' and p ->> 'pay' = 'paid'
               and (p ->> 'cat') is distinct from '__cardmeta__') x;
    -- the Sales receipts of each session
    select coalesce(sum(z.cash), 0), coalesce(sum(z.card), 0) into s_cash, s_card
      from (select round(sum(x.l - x.c), 2) as cash, round(sum(x.c), 2) as card
              from (select rc.sid, least(greatest(0, rc.card), greatest(0, rc.paid - least(greatest(0, rc.wal), greatest(0, rc.paid)))) as c,
                           greatest(0, rc.paid - least(greatest(0, rc.wal), greatest(0, rc.paid))) as l
                      from (select c.session_id as sid, coalesce(c.receipt_id, c.id) as k,
                                   coalesce(bool_or(c.pay = 'refunded'), false) as refunded,
                                   coalesce(sum(coalesce(c.qty, 0) * coalesce(c.price, 0)) filter (where c.pay = 'paid' and c.category is distinct from '__cardmeta__'), 0) as paid,
                                   coalesce((array_agg(c.price order by c.id desc) filter (where c.category = '__cardmeta__' and c.pay is distinct from 'wallet' and c.pay is distinct from 'refunded'))[1], 0) as card,
                                   coalesce((array_agg(c.price order by c.id desc) filter (where c.category = '__cardmeta__' and c.pay = 'wallet'))[1], 0) as wal
                              from cashier_sales c
                             where c.session_id = any(v_ids) and c.voided_at is null
                             group by 1, 2) rc
                     where not rc.refunded) x
             group by x.sid) z;
    -- the wallet moves at those sessions, whatever the hour
    select coalesce(round(sum(case when m.kind = 'refund' then m.amount - coalesce(m.card_part, 0) when m.method = 'cash' then m.amount else 0 end), 2), 0),
           coalesce(round(sum(case when m.kind = 'refund' then coalesce(m.card_part, 0) when m.method = 'card' then m.amount else 0 end), 2), 0)
      into w_cash, w_card
      from wallet_ledger m
     where m.kind in ('topup', 'takeout', 'refund') and m.session_id = any(v_ids) and (m.kind <> 'refund' or m.method is not null);
    -- the cash deposits held in the drawer
    select coalesce(round(sum(case when x.returned_at is not null then coalesce(x.kept_amount, 0) else x.amount end), 2), 0) into v_dep
      from deposits x where x.method = 'cash' and (x.session_id = any(v_ids) or x.day = t.day);
    k_cash := round(r_cash + s_cash + round(p_all - p_card, 2) + w_cash, 2);
    k_card := round(r_card + s_card + p_card + w_card, 2);
  end if;
  -- what the tills of the same kind closed earlier that day took with them
  select count(*), coalesce(round(sum(coalesce(x.expected_cash, 0) - coalesce(x.float, 0)), 2), 0), coalesce(round(sum(coalesce(x.card_expected, 0)), 2), 0)
    into o_n, o_cash, o_card
    from till_sessions x
   where x.day = t.day and x.id <> t.id and x.closed_at is not null and x.opened_at < t.opened_at and x.expected_cash is not null
     and (x.session_id is null) = (t.session_id is null);
  if o_n > 0 then
    k_cash := round(k_cash - o_cash, 2);
    k_card := round(k_card - o_card, 2);
  end if;
  cash := round(coalesce(t.float, 0) + k_cash + v_dep, 2);
  card := k_card;
  return next;
end $fn$;
revoke all on function public._till_expected(uuid) from public, anon;
-- _till_stamp and _till_count_stamp are not definers: they call it as the signed-in staffer (its own cashier check)
grant execute on function public._till_expected(uuid) to authenticated;

create or replace function public.till_close(p_id uuid, p_counted numeric, p_card numeric default null,
                                             p_notes text default null, p_by_name text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $fn$
/* Close a till (bug hunt 2026-11-18, sql14-2) (20261119000700): the expected cash and card are worked out here
   (_till_expected), the counted cash and the card terminal's total are the cashier's. Cashier edit rights. An already
   closed till: {ok: false, reason: 'CLOSED'}. Answers {ok: true, row: the till as stored}. */
declare t till_sessions%rowtype; x record;
begin
  if not coalesce((select public._staff_mod('cashier', true)), false) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_counted is null or p_counted < 0 or p_counted > 1000000 or (p_card is not null and (p_card < 0 or p_card > 1000000)) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  select * into t from till_sessions where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if t.closed_at is not null then return jsonb_build_object('ok', false, 'reason', 'CLOSED'); end if;
  select e.cash, e.card into x from public._till_expected(p_id) e;
  perform set_config('mm.till_close', '1', true);
  update till_sessions
     set closed_at = now(), closed_by_name = nullif(left(btrim(coalesce(p_by_name, '')), 60), ''),
         expected_cash = x.cash, card_expected = x.card, counted_cash = round(p_counted, 2),
         card_terminal_total = round(p_card, 2), notes = left(coalesce(p_notes, ''), 500)
   where id = p_id
  returning * into t;
  perform set_config('mm.till_close', '', true);
  return jsonb_build_object('ok', true, 'row', to_jsonb(t));
end $fn$;
revoke all on function public.till_close(uuid, numeric, numeric, text, text) from public, anon;
grant execute on function public.till_close(uuid, numeric, numeric, text, text) to authenticated;

create or replace function public._till_stamp()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  if tg_op = 'INSERT' then
    new.opened_by := coalesce(auth.uid(), new.opened_by);
    new.opened_at := now();
    new.closed_at := null; new.closed_by := null;
    new.expected_cash := null; new.card_expected := null;   -- written once, by the close (bh18 sql14-2)
  else
    new.opened_by := old.opened_by; new.opened_at := old.opened_at;
    -- The figures a till is checked against (bh18 sql14-2): for anyone but an admin (or the database itself, no signed-in
    -- account) the opening float stays what the till opened with, and the expected cash and card are written only by
    -- the update that closes it.
    if auth.uid() is not null and not coalesce(public.is_admin(), false) then
      new.float := old.float;
      if not (new.closed_at is not null and old.closed_at is null) then
        new.expected_cash := old.expected_cash; new.card_expected := old.card_expected;
      elsif coalesce(current_setting('mm.till_close', true), '') <> '1' then
        -- the close: the figures it is checked against are worked out here, never taken from the browser; till_close has
        -- written them already (bug hunt 2026-11-18, sql14-2) (20261119000700)
        select x.cash, x.card into new.expected_cash, new.card_expected from public._till_expected(old.id) x;
      end if;
    end if;
    if new.closed_at is not null and old.closed_at is null then
      new.closed_at := now();
      new.closed_by := coalesce(auth.uid(), new.closed_by);
    elsif old.closed_at is not null then
      new.closed_at := old.closed_at; new.closed_by := old.closed_by;
    end if;
  end if;
  return new;
end $fn$;
revoke all on function public._till_stamp() from public, anon, authenticated;

create or replace function public._till_count_stamp()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  new.counted_by := coalesce(auth.uid(), new.counted_by);
  new.at := now();
  -- what the count is checked against is worked out here for anyone but an admin, as at the close (bug hunt
  -- 2026-11-18, sql14-2) (20261119000700)
  if (auth.uid() is not null and not coalesce(public.is_admin(), false)) or new.expected_cash is null then
    new.expected_cash := (select x.cash from public._till_expected(new.till_id) x);
  end if;
  return new;
end $fn$;
revoke all on function public._till_count_stamp() from public, anon, authenticated;

-- ── 14. sql01-2 the Saturday recap says no head count ────────────────────────────────────────────────────────────
update public.push_words w set body = v.body
  from (values
    ('en', 'See how this Saturday went'),
    ('ar', 'شاهد كيف كان هذا السبت'),
    ('fr', 'Découvrez comment s''est passé ce samedi'),
    ('es', 'Mira cómo fue este sábado'),
    ('pt', 'Veja como foi este sábado'),
    ('ur', 'دیکھیں اس ہفتے کے دن کیا ہوا'),
    ('hi', 'देखें यह शनिवार कैसा रहा'),
    ('tl', 'Tingnan kung paano ang Sabadong ito'),
    ('ne', 'यो शनिबार कस्तो रह्यो हेर्नुहोस्'),
    ('bn', 'দেখুন এই শনিবার কেমন কাটল')
  ) v(lang, body)
 where w.key = 'recap' and w.lang = v.lang and w.body is distinct from v.body;

create or replace function public._hub_push_tick()
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_ksa timestamp := now() at time zone 'Asia/Riyadh'; v_today date := (now() at time zone 'Asia/Riyadh')::date;
  v_month date := date_trunc('month', (now() at time zone 'Asia/Riyadh'))::date; v_n int := 0; r record; t record;
  v_sess text; v_at text; v_sent timestamptz; v_key text;
begin
  -- the evening before, from 21:00: every live booking on tomorrow's sessions, with push or without
  if extract(hour from v_ksa) >= 21 then
    -- One reminder per account and session (bug hunt 2026-11-18, sql01-4): an account holding several places there (a
    -- friend on a group ride, a party on the Farm House night) got one per place, all alike. It opens the account's
    -- first ticket there, and none is written while any of its places there already has one.
    for r in select distinct on (q.customer_id, s.id)
                    q.id, q.customer_id, q.reminded_at, s.id as sid, s.title, s.ride_kind, w.starts_at
               from queue_entries q join sessions s on s.id = q.session_id
               cross join lateral _session_window(s) w
              where s.session_date = to_char(v_today + 1, 'YYYY-MM-DD') and s.status <> 'deleted' and s.cancelled_at is null
                and s.ride_status is distinct from 'cancelled' and not coalesce(s.draft, false)
                and q.status = 'waiting' and q.customer_id is not null
                and coalesce(q.approval, 'approved') = 'approved'
                and not exists (select 1 from queue_entries q2
                                  join push_outbox o on o.customer_id = q2.customer_id and o.tag = 'rem-' || q2.id
                                 where q2.session_id = q.session_id and q2.customer_id = q.customer_id)
              order by q.customer_id, s.id, q.registered_at nulls last, q.id loop
      v_sess := coalesce(nullif(trim(r.title), ''), 'kind:' || coalesce(r.ride_kind, 'jcc'));
      v_at := to_char(r.starts_at at time zone 'Asia/Riyadh', 'HH24:MI');
      v_key := _updates_key('remind', r.sid); -- a session with no bike is not a ride
      -- its reminder has the words 20261114080200_still_coming wrote, with the sentence about cancelling
      if v_key = 'remind_s' then v_key := 'remind:nc'; end if;
      select * into t from _push_text(r.customer_id, v_key, array[_push_sess_name(r.customer_id, r.title, r.ride_kind), v_at]);
      -- staff already reminded this booking by hand: its row is for the list only
      insert into push_outbox (customer_id, tag, title, body, url, cat, key, args, sent_at, result)
      values (r.customer_id, 'rem-' || r.id, left(t.title, 120), left(t.body, 300), '/my-bookings?tk=' || r.id, 'rides', v_key, array[v_sess, v_at],
              case when r.reminded_at is not null then now() end, case when r.reminded_at is not null then 'inapp' end)
      on conflict (customer_id, tag) do nothing
      returning sent_at into v_sent;
      if found then
        -- going out as a push (the gate left it waiting): staff skip that rider
        if v_sent is null then
          begin
            -- every place the account holds there: staff skip them all
            update queue_entries set reminded_at = now(), reminded_kind = 'push'
             where session_id = r.sid and customer_id = r.customer_id and status = 'waiting'
               and coalesce(approval, 'approved') = 'approved' and reminded_at is null;
          exception when others then
            null; -- a mark the table refuses never undoes the run's rows
          end;
        end if;
        v_n := v_n + 1;
      end if;
    end loop;
  end if;

  -- the 1st, from 10:00 to 21:59: the month's challenge is ready, to every active member
  if extract(day from v_ksa) = 1 and extract(hour from v_ksa) between 10 and 21 then
    for r in select h.customer_id from hub_levels h
              where h.month = v_month and _member_active(h.customer_id)
                and not exists (select 1 from push_outbox o
                                 where o.customer_id = h.customer_id and o.tag = 'hub-ch-' || to_char(v_month, 'YYYYMM')) loop
      select * into t from _push_text(r.customer_id, 'challenge', '{}');
      insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
      values (r.customer_id, 'hub-ch-' || to_char(v_month, 'YYYYMM'), left(t.title, 120), left(t.body, 300), '/members?src=push', 'community',
              'challenge', '{}')
      on conflict (customer_id, tag) do nothing;
      if found then v_n := v_n + 1; end if;
    end loop;
  end if;

  -- the Saturday recap, written in the last 12 hours, to the members who rode it (08:00 to 21:59); its words carry no
  -- head count (members never see the club's numbers: bug hunt 2026-11-18, sql01-2) (20261119000700)
  if extract(hour from v_ksa) between 8 and 21 then
    for r in select distinct p.id as pid, p.riders, q.customer_id
               from hub_posts p join queue_entries q on q.session_id = p.session_id and q.status = 'done'
              where p.auto and not p.hidden and p.created_at > now() - interval '12 hours' and coalesce(p.riders, 0) >= 10
                and q.customer_id is not null and _member_active(q.customer_id)
                and not exists (select 1 from push_outbox o where o.customer_id = q.customer_id and o.tag = 'hub-rc-' || p.id) loop
      select * into t from _push_text(r.customer_id, 'recap', '{}');
      insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
      values (r.customer_id, 'hub-rc-' || r.pid, left(t.title, 120), left(t.body, 300), '/members?src=push', 'community',
              'recap', '{}')
      on conflict (customer_id, tag) do nothing;
      if found then v_n := v_n + 1; end if;
    end loop;
  end if;
  return v_n;
end $$;
revoke all on function public._hub_push_tick() from public, anon, authenticated;

-- the recap rows already written: their words again, with no number (the Updates list renders from the words, a push
-- not yet sent takes the stored body)
update public.push_outbox o
   set body = left(coalesce((select x.body from _push_text(o.customer_id, 'recap', '{}') x), o.body), 300), args = '{}'
 where o.key = 'recap' and coalesce(o.args, '{}') <> '{}';

-- ── 15. sql06-2 + form-lockers-0-3: the PRODUCTION TOO lockers patch (package dbstg), as tested ──────────────────
-- form-lockers-0-3 + sql06-2 (a) customer_locker_change ----------------------------------------------------------
do $do$
declare d text;
begin
  select pg_get_functiondef('public.customer_locker_change(text,text,uuid,text,text)'::regprocedure) into d;
  if position('bh18-lockers' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$  -- room in each slot the new time adds, this rental aside
$a$,
$b$  /* up to 3 lockers per account for each time, as customer_locker_book counts them: the account's own (no booking)
     in each slot the new time adds (bug hunt 2026-11-18, bh18-lockers, form-lockers-0-3) */
  if r.booking_id is null then
    foreach s in array _lk_slots(p_period) loop
      if not (s = any(_lk_slots(r.period)))
         and (select count(*) from locker_rentals x where x.day = r.day and x.customer_id = p_id and x.booking_id is null
                and x.id <> r.id and x.status in ('reserved', 'in_use') and s = any(_lk_slots(x.period))) >= 3 then
        raise exception 'LOCKER_LIMIT' using errcode = 'P0001';
      end if;
    end loop;
  end if;
  -- room in each slot the new time adds, this rental aside
$b$);
  d := pg_temp._once(d,
$a$  fee := case when r.house then 0 else _lk_price(p_period) end;  /* on the house stays free, as staff_locker_edit has it (bug hunt 2026-11-10, 20261110235300) */
$a$,
$b$  fee := case when r.house then 0 else _lk_price(p_period) end;  /* on the house stays free, as staff_locker_edit has it (bug hunt 2026-11-10, 20261110235300) */
  /* paid at the desk (till lines rung up for it): another fee is the desk's, as a paid bill's (bug hunt 2026-11-18,
     bh18-lockers, sql06-2) */
  if fee is distinct from r.price
     and coalesce((select sum(coalesce(c.qty, 0) * coalesce(c.price, 0)) from cashier_sales c
                    where c.id = any(r.till_lines) and c.pay = 'paid' and c.voided_at is null and c.refunded_at is null), 0) > 0 then
    raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';
  end if;
$b$);
  execute d;
end $do$;

-- sql06-2 (b) customer_locker_drop ---------------------------------------------------------------------------------
do $do$
declare d text;
begin
  select pg_get_functiondef('public.customer_locker_drop(text,text,uuid)'::regprocedure) into d;
  if position('bh18-lockers' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$  update locker_rentals set status = 'cancelled', cancelled_at = now(), cancelled_by = 'rider', cancel_reason = 'rider'
   where id = r.id;
  perform _lk_unpay(r.id, 'rider');
$a$,
$b$  /* its money back as a cancel by its booking or its night gives it: its receipt voided (the wallet's part back) and
     its till lines paid at the desk refunded to the account's wallet (bug hunt 2026-11-18, bh18-lockers, sql06-2: desk
     cash was kept with nothing left to refund) */
  perform _lk_money_back(r.id, 'rider', 'rider removed');
  update locker_rentals set status = 'cancelled', cancelled_at = now(), cancelled_by = 'rider', cancel_reason = 'rider'
   where id = r.id;
$b$);
  execute d;
end $do$;

-- sql06-2 (c) customer_lockers --------------------------------------------------------------------------------------
do $do$
declare d text;
begin
  select pg_get_functiondef('public.customer_lockers(text,text)'::regprocedure) into d;
  if position('bh18-lockers' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$'paid', r.receipt_id is not null,$a$,
$b$'paid', r.receipt_id is not null  /* or paid at the desk (bug hunt 2026-11-18, bh18-lockers, sql06-2) */
                                                 or exists (select 1 from cashier_sales c where c.id = any(r.till_lines) and c.pay = 'paid'
                                                              and c.voided_at is null and c.refunded_at is null),$b$);
  execute d;
end $do$;

do $chk$
declare f text;
begin
  foreach f in array array['public.customer_locker_change(text,text,uuid,text,text)', 'public.customer_locker_drop(text,text,uuid)',
                           'public.customer_lockers(text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and position('bh18-lockers' in p.prosrc) > 0
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path, or lacks this change', f;
    end if;
    if not has_function_privilege('anon', f, 'execute') then raise exception '% lost its grant', f; end if;
  end loop;
  if position('20261110235300' in (select prosrc from pg_proc where oid = 'public.customer_locker_change(text,text,uuid,text,text)'::regprocedure)) = 0 then
    raise exception 'customer_locker_change lacks 20261110235300 item 5 (on the house): run it first';
  end if;
  if (select provolatile from pg_proc where oid = 'public.customer_lockers(text,text)'::regprocedure) <> 's' then
    raise exception 'customer_lockers is no longer STABLE';
  end if;
end $chk$;

-- ── Checks ─────────────────────────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._wl_cap_guard()', 'public.staff_payment_figures(date,date,text)',
                           'public.staff_locker_edit(uuid,date,text,text,text,text,text,text)', 'public.staff_cancel_held(text[])',
                           'public.staff_set_house(text,boolean,text,text)', 'public.staff_give_spot(text,text)',
                           'public.staff_customer_stats()', 'public._account_family_stamp()', 'public._account_owners_stamp()',
                           'public._account_followups_stamp()', 'public.staff_merge_customers(text,text,text,text,text)',
                           'public.staff_unmerge_customers(bigint)', 'public.staff_move_session(text,text,text,boolean)',
                           'public.staff_wallet_moves(date)', 'public._till_expected(uuid)',
                           'public.till_close(uuid,numeric,numeric,text,text)', 'public._hub_push_tick()'] loop
    if not exists (select 1 from pg_proc p where p.oid = to_regprocedure(f) and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
    if position('(20261119000700)' in pg_get_functiondef(to_regprocedure(f))) = 0 then
      raise exception '% does not carry this file''s change', f;
    end if;
  end loop;
  -- not definers, as before: _rider_price, _till_stamp, _till_count_stamp; nor the new _house_from_keep
  foreach f in array array['public._rider_price(text)', 'public._till_stamp()', 'public._till_count_stamp()', 'public._house_from_keep()'] loop
    if not exists (select 1 from pg_proc p where p.oid = to_regprocedure(f) and not p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
                     and position('(20261119000700)' in p.prosrc) > 0) then
      raise exception '% is missing, became a definer, lost its search_path or lacks this change', f;
    end if;
  end loop;
  if (select provolatile from pg_proc where oid = 'public._rider_price(text)'::regprocedure) <> 's' then
    raise exception '_rider_price is no longer STABLE';
  end if;
  foreach f in array array['public.staff_payment_figures(date,date,text)', 'public.staff_cancel_held(text[])',
                           'public.staff_give_spot(text,text)', 'public.staff_wallet_moves(date)', 'public.till_close(uuid,numeric,numeric,text,text)',
                           'public.staff_locker_edit(uuid,date,text,text,text,text,text,text)', 'public.staff_set_house(text,boolean,text,text)',
                           'public.staff_customer_stats()', 'public.staff_merge_customers(text,text,text,text,text)',
                           'public.staff_unmerge_customers(bigint)', 'public.staff_move_session(text,text,text,boolean)',
                           'public._till_expected(uuid)'] loop
    if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% grants are wrong', f;
    end if;
  end loop;
  foreach f in array array['public._wl_cap_guard()', 'public._house_from_keep()', 'public._hub_push_tick()', 'public._till_stamp()',
                           'public._till_count_stamp()', 'public._account_family_stamp()', 'public._account_owners_stamp()',
                           'public._account_followups_stamp()'] loop
    if has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute') then
      raise exception '% can be run by a client', f;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgname = 'zw_wl_cap_guard' and tgrelid = 'public.queue_entries'::regclass)
     or not exists (select 1 from pg_trigger where tgname = 'zw_house_from' and tgrelid = 'public.queue_entries'::regclass)
     or not exists (select 1 from pg_trigger where tgname = 'till_sessions_stamp' and tgrelid = 'public.till_sessions'::regclass)
     or not exists (select 1 from pg_trigger where tgname = 'till_counts_stamp' and tgrelid = 'public.till_counts'::regclass) then
    raise exception 'a trigger is missing';
  end if;
  if exists (select 1 from push_words where key = 'recap' and position('{0}' in body) > 0) then
    raise exception 'a recap body still carries the head count';
  end if;
  if exists (select 1 from workshop_jobs w where jsonb_typeof(w.parts_used) = 'array'
               and exists (select 1 from jsonb_array_elements(w.parts_used) e where jsonb_typeof(e) = 'object' and e ? 'cost')) then
    raise exception 'a workshop part line still holds a cost';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119000700', 'bh18_r2b')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- Read-only check after applying (expect: t, t, t, t, t, t, t, 0, 0, 1):
-- select position('(20261119000700)' in pg_get_functiondef('public._rider_price(text)'::regprocedure)) > 0,
--        exists (select 1 from pg_trigger where tgname = 'zw_wl_cap_guard'),
--        exists (select 1 from pg_trigger where tgname = 'zw_house_from'),
--        exists (select 1 from information_schema.columns where table_name = 'queue_entries' and column_name = 'house_from'),
--        to_regprocedure('public.staff_give_spot(text,text)') is not null and to_regprocedure('public.staff_cancel_held(text[])') is not null,
--        to_regprocedure('public.till_close(uuid,numeric,numeric,text,text)') is not null,
--        (select count(*) from pg_proc where proname = 'customer_locker_change' and position('bh18-lockers' in prosrc) > 0) = 1,
--        (select count(*) from push_words where key = 'recap' and position('{0}' in body) > 0),
--        (select count(*) from workshop_jobs w where jsonb_typeof(w.parts_used) = 'array' and w.parts_used::text like '%"cost"%'),
--        (select count(*) from supabase_migrations.schema_migrations where version = '20261119000700');
