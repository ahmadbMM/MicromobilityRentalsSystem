-- ============================================================================
-- Bug hunt 2026-11-11 (bh11), database functions, live part A (applied on PROD and STAGING).
--
-- 1. _house_taken (sql00-1): "one free row per ride" matched the earlier row's name against the account's
--    name as it is now, so a house or VIP holder who renamed the account got a second free row on the same
--    ride. A free row in a name the account had before (every rename is in audit_log, customers_audit_upd)
--    now counts too.
-- 2. _lk_booking_follow + new _lk_money_back (sql01-2): a booking cancelled, removed or deleted cancelled
--    its reserved locker but kept what the locker took outside the ride's bill (its wallet receipt, its till
--    lines paid at the desk), and the locker tools then refused to refund a cancelled locker. Its own
--    receipt is now voided (the wallet's part comes back, as staff_locker_cancel, the sweep and the rider's
--    Remove do) and its paid till lines are refunded to the account's wallet (as staff_locker_refund does);
--    money that cannot move (no account, a wallet that refuses it) stays and the cancel goes on. A no-show
--    keeps it, as before. The fee on a ride's bill still leaves the bill with the rental.
-- 3. _lk_booking_follow (sql01-5): a booking moved to a ride with no lockers, or none for the locker's time
--    (a community ride, a night with lockers off or called off, a Petromin night for a JCC time), took its
--    locker along, held a door there and kept the fee on the bill. A reservation is now cancelled with its
--    money given back (as in 2); a locker already handed over stays on the evening it was given.
-- 4. _lk_kind + new trigger sessions_lockers_cancelled / _lk_session_cancelled (sql04-1): a night called
--    off is closed with cancelled_at (staff_cancel_session, Cancel night), never status 'cancelled', so the
--    Lockers page kept selling lockers for it and charging the wallet. _lk_kind now treats cancelled_at as
--    closed (every locker door asks it), and calling a night off cancels the lockers reserved on it from
--    the Lockers page (booking_id null, that session) with their money given back, unless another locker
--    evening runs that day. Desk walk-ups (no session) and lockers handed over are left to staff.
-- 5. customer_locker_reserve (sql04-2): with no door picked, the room check counts places per time while
--    the door pick needs one door free for the whole time, so a 'both' locker could be billed with no door
--    held (locker_id null). It now answers LOCKERS_FULL and keeps nothing.
-- 6. _mt_core (sql01-4): a receipt with any one line refunded lost its whole card amount, so the rest of a
--    card receipt counted as cash in the monthly totals and the report snapshots. Card and wallet are now
--    taken per receipt, each no more than what the receipt still has paid.
-- 7. customer_signup, customer_exists (sql04-3): a taken number was refused only on the exact string, so
--    '+966...' signed up beside '966...' and then could not sign in by phone (customer_login and _phone_main
--    match by digits). Both now compare digits; staff may still reuse a number.
-- 8. new trigger volunteer_hours_cert_follow / _vol_cert_follow (sql02-1): an automatic event certificate
--    kept the hours it had when first made (the first entry logged), so later hours on the event never
--    reached it. Any change to the hours of an event now brings that volunteer's automatic certificate for
--    it to the event's live total (while there is one; the last hours voided revoke it, as before).
-- 9. _vol_reward, _vol_note (sql02-2): the reward update said the certificate was ready when it was not
--    made (an event still ahead). It now says the free ride alone and carries cert_later; once the
--    certificate is made on a later reward, that update names it and shows as new.
-- 10. customer_claim_spot (sql03-1): an offer was claimed for a booking that had since moved to another
--    ride's waitlist, promoting it there past that ride's places and line. It now closes the offer and
--    offers the place to the next in line on the ride it was for.
-- 11. _wl_offer_fill, customer_claim_spot, _wl_offer_tick (sql03-8): a session time the window cannot read
--    raised, which stopped a rider's cancel on that ride and rolled back every session's offers in the tick.
--    The window is read as the customer doors read it (unreadable = not ended), and the tick runs each
--    session's offers on its own.
-- 12. customer_booking_update (sql03-3): a switch between two of our bike types skipped the out-of-service
--    check (only a switch from an own bike was checked); it now needs a working bike of the new type.
-- 13. customer_booking_update (sql03-4): a paid row compared the new type's fare with the price paid, so any
--    row with a code or a party's share could never change type; it now compares fare with fare, and a code
--    kept to one type does not go with the row to another.
-- 14. customer_booking_update (sql03-5): taking back a cancelled free row (house, VIP) brought it back free
--    beside a free row booked after the cancel; the holder's row now comes back to pay when another free row
--    of theirs is on the ride.
--
-- Not changed: sql01-6 (_promo_valid). The price guard that prices a code (_enforce_booking_price, live =
-- 20261005210000) locks the code row FOR UPDATE and re-checks uses < max_uses, so two bookings at once take
-- turns, and customer_create_booking inserts its rows one statement at a time, so each row's use is counted
-- before the next is priced.
--
-- Every function is replaced from its live definition (prod and staging carried the same text, checked by
-- md5 on 2026-11-12; customer_signup is prod's own text, patched in place by 20261111130000). Headers are
-- unchanged, so CREATE OR REPLACE keeps the grants; the three new functions are revoked from every API role.
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- 1 _house_taken (sql00-1) ------------------------------------------------------------------------
create or replace function public._house_taken(p_customer text, p_session text, p_exclude text)
returns boolean
language sql set search_path to 'public'
as $$
  select exists (
    select 1 from queue_entries q join customers c on c.id = q.customer_id
     where q.customer_id = p_customer and q.session_id = p_session
       and q.id is distinct from p_exclude
       and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
       and coalesce(q.paid, false) and coalesce(q.price, 0) = 0
       and (lower(btrim(coalesce(q.name, ''))) = lower(btrim(coalesce(c.name, '')))
            /* or a name the account had before: a free row made before a rename still counts, so a rename
               does not make room for a second one (bug hunt 2026-11-11, sql00-1). customers_audit_upd
               writes every rename into audit_log. */
            or (btrim(coalesce(q.name, '')) <> '' and exists (
                  select 1 from audit_log a
                   where a.tbl = 'customers' and a.row_id = p_customer and a.op = 'UPDATE' and a.changed ? 'name'
                     and lower(btrim(coalesce(a.changed -> 'name' ->> 'old', ''))) = lower(btrim(q.name))))))
$$;

-- 2 _lk_money_back, new (sql01-2, sql01-5, sql04-1) -----------------------------------------------
create or replace function public._lk_money_back(p_rental uuid, p_who text, p_why text)
returns numeric
language plpgsql volatile security definer set search_path to 'public'
as $$
/* What a locker reservation took outside a ride's bill, given back when it goes with its booking or its night
   (bug hunt 2026-11-11): its own receipt (the wallet, or a card online) is voided, as staff_locker_cancel, the
   sweep and the rider's own Remove do, and the wallet's part comes back by _wallet_sale_follow; its till lines
   paid at the desk are refunded to the account's wallet, as staff_locker_refund does. Money that cannot move
   now (no account, a wallet that refuses it) stays where it is and the cancel goes on: staff settle it in
   Sales. Returns what the till lines gave to the wallet. The fee on a ride's bill is not this function's:
   it leaves the bill with the rental (_lk_line). */
declare r locker_rentals%rowtype; took numeric := 0; gave numeric := 0;
begin
  select * into r from locker_rentals where id = p_rental for update;
  if r.id is null then return 0; end if;
  begin
    perform _lk_unpay(r.id, p_who);
  exception when others then null;
  end;
  begin
    select coalesce(sum(coalesce(c.qty, 0) * coalesce(c.price, 0)), 0) into took from cashier_sales c
     where c.id = any(r.till_lines) and c.pay = 'paid' and c.voided_at is null and c.refunded_at is null;
    if took > 0
       and _wallet_owner(coalesce(r.customer_id, (select e.customer_id from queue_entries e where e.id = r.booking_id))) is not null then
      gave := coalesce(_lk_give_back(r.id, left(coalesce(p_who, ''), 40), p_why, null, null), 0);
      if gave > 0 then
        update locker_rentals set refunded = refunded + gave, refunded_at = now(), refunded_by = left(coalesce(p_who, ''), 60)
         where id = r.id;
      end if;
    end if;
  exception when others then
    gave := 0;
  end;
  return gave;
end $$;
revoke execute on function public._lk_money_back(uuid, text, text) from public, anon, authenticated;

-- 3 _lk_booking_follow (sql01-2, sql01-5) ---------------------------------------------------------
create or replace function public._lk_booking_follow()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare nd date; fr record; k text; who text;
begin
  -- who gives a locker's money back when its booking goes (bug hunt 2026-11-11)
  who := case when (select is_staff()) then _lk_who()
              when coalesce(auth.role(), '') in ('anon', 'authenticated') then 'rider' else 'system' end;
  if tg_op = 'DELETE' then
    perform set_config('mm.lk_deleting', old.id, true);
    -- what the locker took outside the ride's bill comes back, as on a cancel (below)
    for fr in select r.id from locker_rentals r where r.booking_id = old.id and r.status = 'reserved' loop
      perform _lk_money_back(fr.id, who, 'booking deleted');
    end loop;
    update locker_rentals set status = 'cancelled', cancelled_at = now(), cancel_reason = 'booking deleted'
     where booking_id = old.id and status = 'reserved';
    perform set_config('mm.lk_deleting', '', true);
    return old;
  end if;
  if new.session_id is distinct from old.session_id then
    select case when s.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date, 10)::date end into nd
      from sessions s where s.id = new.session_id;
    if nd is not null then perform _lk_lock(nd); end if;
    -- A ride that offers no locker, or none for the locker's time (a community ride, a night with lockers
    -- off or called off, a Petromin night for a JCC time), takes none along: a reservation is cancelled with
    -- its money given back, as when the booking is cancelled, and a locker already handed over stays on the
    -- evening it was given (bug hunt 2026-11-11, sql01-5).
    k := _lk_kind(new.session_id);
    for fr in select r.id from locker_rentals r
               where r.booking_id = new.id and r.status = 'reserved' and not _lk_period_ok(k, r.period) loop
      perform _lk_money_back(fr.id, who, 'booking moved');
      update locker_rentals set status = 'cancelled', cancelled_at = now(), cancel_reason = 'booking moved: no locker there'
       where id = fr.id;
    end loop;
    update locker_rentals r set session_id = new.session_id, day = coalesce(nd, r.day)
     where r.booking_id = new.id and r.status in ('reserved', 'in_use') and _lk_period_ok(k, r.period);
    -- the locker goes along only when nobody holds it there for an overlapping time
    update locker_rentals r set locker_id = null, status = 'reserved', assigned_at = null, assigned_by = null
     where r.booking_id = new.id and r.session_id = new.session_id and r.status in ('reserved', 'in_use') and r.locker_id is not null
       and exists (select 1 from locker_rentals x
                    where x.locker_id = r.locker_id and x.day = r.day and x.id <> r.id
                      and x.status in ('reserved', 'in_use') and _lk_slots(x.period) && _lk_slots(r.period));
    -- ...and one without a locker there is given a free one, so it stays reserved for the rider (the user, 2026-11-10)
    if nd is not null then
      for fr in select r.id, r.day, r.period from locker_rentals r
                 where r.booking_id = new.id and r.status = 'reserved' and r.locker_id is null order by r.created_at loop
        update locker_rentals set locker_id = _lk_free_unit(fr.day, fr.period, fr.id) where id = fr.id;
      end loop;
    end if;
  end if;
  if new.status is distinct from old.status then
    if new.status in ('cancelled', 'removed') or (new.status = 'noshow' and not coalesce(new.paid, false)) then
      -- What the locker took outside the ride's bill (its wallet or card receipt, its till lines) comes back,
      -- as a cancel from the locker tools gives it back: cancelled with the booking, it stayed taken and
      -- the locker tools could no longer refund it (bug hunt 2026-11-11, sql01-2). A no-show keeps it.
      if new.status in ('cancelled', 'removed') then
        for fr in select r.id from locker_rentals r where r.booking_id = new.id and r.status = 'reserved' loop
          perform _lk_money_back(fr.id, who, 'booking ' || new.status);
        end loop;
      end if;
      update locker_rentals set status = 'cancelled', cancelled_at = now(), cancel_reason = 'booking ' || new.status
       where booking_id = new.id and status = 'reserved';
    elsif new.status = 'noshow' then
      update locker_rentals set status = 'returned', returned_at = now(), returned_by = 'no-show'
       where booking_id = new.id and status = 'reserved';
    end if;
  end if;
  return new;
end $$;

-- 4 _lk_kind and the night called off (sql04-1) ---------------------------------------------------
create or replace function public._lk_kind(p_session text)
returns text
language sql stable security definer set search_path to 'public'
as $$
  select case
    /* a night called off is closed with cancelled_at (staff_cancel_session, Cancel night); no cancel path
       writes status 'cancelled', so the Lockers page sold lockers for it (bug hunt 2026-11-11, sql04-1) */
    when s.id is null or not coalesce(s.lockers, false) or coalesce(s.status, '') = 'cancelled' or s.cancelled_at is not null then ''
    when coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin' then 'pm'
    when coalesce(s.event_kind, '') = 'community' then ''
    else 'jcc' end
    from (select 1) one left join sessions s on s.id = p_session
$$;

create or replace function public._lk_session_cancelled()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
/* A night called off (cancelled_at set: staff_cancel_session, Cancel night) takes no more lockers (_lk_kind),
   and the lockers reserved on it from the Lockers page (booking_id null, this session) are cancelled with
   their money given back, as the evening's sweep gives it back. Its rides' lockers follow their bookings
   (_lk_booking_follow); a locker already handed over and a desk walk-up are left to staff; another locker
   evening the same day keeps them (bug hunt 2026-11-11, sql04-1). */
declare d date; fr record; who text;
begin
  d := case when new.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(new.session_date, 10)::date end;
  if d is null then return null; end if;
  perform _lk_lock(d);
  if exists (select 1 from _lk_evening(d) e where e.session_id is not null and e.session_id is distinct from new.id) then
    return null;
  end if;
  who := case when (select is_staff()) then _lk_who() else 'system' end;
  for fr in select r.id from locker_rentals r
             where r.session_id = new.id and r.booking_id is null and r.status = 'reserved'
             order by r.created_at loop
    perform _lk_money_back(fr.id, who, 'night cancelled');
    update locker_rentals set status = 'cancelled', cancelled_at = now(), cancelled_by = left(who, 60), cancel_reason = 'night cancelled'
     where id = fr.id and status = 'reserved';
  end loop;
  return null;
end $$;
revoke execute on function public._lk_session_cancelled() from public, anon, authenticated;
drop trigger if exists sessions_lockers_cancelled on public.sessions;
create trigger sessions_lockers_cancelled after update of cancelled_at on public.sessions
  for each row when (old.cancelled_at is null and new.cancelled_at is not null)
  execute function public._lk_session_cancelled();

-- 5 customer_locker_reserve (sql04-2) -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_locker_reserve(p_id text, p_token text, p_booking_ids text[], p_period text, p_codes text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q queue_entries%rowtype; bid text; k text; d date; n int; ids text[]; codes text[]; c text; lk lockers%rowtype; i int := 0;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select array_agg(x order by o) into ids
    from (select distinct on (x) x, o from unnest(p_booking_ids) with ordinality u(x, o) where x is not null order by x, o) z;
  n := coalesce(array_length(ids, 1), 0);
  if n = 0 or n > 20 then raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001'; end if;
  if p_codes is not null then
    select array_agg(_lk_code(x) order by o) into codes from unnest(p_codes) with ordinality u(x, o);
    if coalesce(array_length(codes, 1), 0) <> n or (select count(distinct x) from unnest(codes) x) <> n then
      raise exception 'LOCKER_PICK' using errcode = 'P0001';
    end if;
  end if;
  foreach bid in array ids loop
    select * into q from queue_entries where id = bid and customer_id = p_id for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if coalesce(q.status, '') not in ('waiting', 'waitlist') or coalesce(q.paid, false) then
      raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';
    end if;
    if exists (select 1 from rider_registrations rr where rr.matched_entry_id = q.id) then
      raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';  -- the Petromin form's riders take none (the owner, 2026-11-09)
    end if;
    if k is null then
      k := _lk_kind(q.session_id);
      select case when s.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date, 10)::date end into d
        from sessions s where s.id = q.session_id;
    elsif _lk_kind(q.session_id) is distinct from k
       or (select left(s.session_date, 10) from sessions s where s.id = q.session_id) is distinct from d::text then
      raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';
    end if;
  end loop;
  /* a period already over tonight is not open either, as on the /lockers page (bug hunt 2026-11-10,
     20261110235000) */
  if not _lk_period_ok(k, p_period) or d is null or _lk_ended(d, p_period) then
    raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';
  end if;
  perform _lk_lock(d);
  if exists (select 1 from locker_rentals r where r.booking_id = any(ids) and r.status in ('reserved', 'in_use')) then
    raise exception 'LOCKER_HELD' using errcode = 'P0001';
  end if;
  if not _lk_room(d, p_period, n) then raise exception 'LOCKERS_FULL' using errcode = 'P0001'; end if;
  foreach bid in array ids loop
    i := i + 1; lk := null;
    if codes is not null then
      c := codes[i];
      select * into lk from lockers where code = c and status <> 'retired';
      if lk.id is null then raise exception 'LOCKER_UNKNOWN: %', c using errcode = 'P0002'; end if;
      if lk.status <> 'available' then raise exception 'LOCKER_OUT: %', c using errcode = 'P0001'; end if;
      if exists (select 1 from locker_rentals x where x.locker_id = lk.id and x.day = d and x.status in ('reserved', 'in_use')
                   and _lk_slots(x.period) && _lk_slots(p_period)) then
        raise exception 'LOCKER_TAKEN: %', c using errcode = 'P0001';
      end if;
    else
      -- no door picked (a page cached before the cabinet, or the cabinet not read): a free one is held for the rider, so
      -- the locker stays theirs (the user, 2026-11-10: "assign them an automatic locker so it stays reserved for them")
      select l.* into lk from lockers l where l.id = (select _lk_free_unit(d, p_period, null));
      -- no one door free for the whole time (the places left sit on different doors): the time is full,
      -- rather than a locker billed with no door held (bug hunt 2026-11-11, sql04-2)
      if lk.id is null then raise exception 'LOCKERS_FULL' using errcode = 'P0001'; end if;
    end if;
    insert into locker_rentals (day, period, booking_id, session_id, customer_id, name, locker_id, price, on_bill, status, created_by)
    select d, p_period, e.id, e.session_id, e.customer_id, left(e.name, 120), lk.id, _lk_price(p_period), true, 'reserved', 'rider'
      from queue_entries e where e.id = bid;
  end loop;
  return jsonb_build_object('ok', true, 'left', _lk_left(d),
    -- the lockers held, so the review can say the number it gave
    'lockers', (select coalesce(jsonb_agg(jsonb_build_object('booking_id', r.booking_id, 'code', l.code) order by r.created_at), '[]'::jsonb)
                  from locker_rentals r left join lockers l on l.id = r.locker_id
                 where r.booking_id = any(ids) and r.status = 'reserved'),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'addons', e.addons, 'paid', e.paid, 'pay_method', e.pay_method,
                                                          'wallet_paid', e.wallet_paid)), '[]'::jsonb)
               from queue_entries e where e.id = any(ids)));
end $function$;

-- 6 _mt_core (sql01-4) ----------------------------------------------------------------------------
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
  /* Card and wallet per receipt, each no more than what the receipt still has paid: a receipt with one
     line refunded (a locker given back by _lk_give_back) kept its other lines in sales but lost its whole
     card part, which then counted as cash (bug hunt 2026-11-11, sql01-4). A receipt refunded whole has
     no paid line left, so nothing, as before. */
  rcp as (
    select cs.m, coalesce(cs.receipt_id, cs.id) as k,
      coalesce(sum(cs.qty * cs.price) filter (where cs.pay = 'paid' and cs.category is distinct from '__cardmeta__' and cs.qty <> 0), 0) as sales,
      coalesce(sum(cs.price) filter (where cs.category = '__cardmeta__' and cs.pay is distinct from 'wallet' and cs.pay is distinct from 'refunded'), 0) as card_meta,
      coalesce(sum(cs.price) filter (where cs.category = '__cardmeta__' and cs.pay = 'wallet'), 0) as wal_meta
    from cs
    group by cs.m, coalesce(cs.receipt_id, cs.id)
  ),
  rc as (
    select m, sales,
      least(card_meta, greatest(sales, 0)) as card,
      least(wal_meta, greatest(sales - least(card_meta, greatest(sales, 0)), 0)) as wal
    from rcp
  ),
  ct as (
    select coalesce(rc.m, 'total') as m,
      coalesce(sum(rc.sales), 0) as sales,
      coalesce(sum(rc.card), 0) as card,
      coalesce(sum(rc.wal), 0) as wal
    from rc
    group by grouping sets ((rc.m), ())
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

-- 7 customer_signup, customer_exists (sql04-3) ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_signup(p_id text, p_name text, p_email text, p_phone text, p_pwd text, p_height integer, p_type_preference text, p_gender text, p_heard_from text DEFAULT NULL::text)
 RETURNS TABLE(id text, session_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare tok text;
begin
  if not (select is_staff()) and not _ip_gate('signup', 20, interval '10 minutes') then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;
  p_gender := nullif(p_gender, '');
  p_type_preference := coalesce(nullif(p_type_preference, ''), 'Any');
  p_heard_from := nullif(btrim(coalesce(p_heard_from, '')), '');
  if coalesce(p_id,'') !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'id'; end if;
  if not _type_ok(p_type_preference) then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'type_preference'; end if;
  -- the password rule every other password door keeps: 8 or more, an upper-case letter and a digit (20261007233000)
  if length(coalesce(p_pwd, '')) < 8 or public._pwd_common(p_pwd) then
    raise exception 'WEAK_PASSWORD' using errcode = '22023';
  end if;
  if p_gender is not null and p_gender not in ('male','female') then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'gender'; end if;
  if p_height is not null and (p_height < 100 or p_height > 250) then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'height'; end if;
  if coalesce(p_phone,'') <> '' and p_phone !~ '^\+?[0-9]{6,15}$' then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'phone'; end if;
  if p_heard_from is not null and p_heard_from not in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp','google','friend','invited','passed_by','event','hotel','school','work','community','other','desk') then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'heard_from'; end if;
  -- Staff may give a new account a number another account has (20260930180000); the account
  -- that had it first keeps signing in with it (customer_login). A rider signing up may not.
  -- The number is compared by its digits, as customer_login and _phone_main find an account: '966...' and
  -- '+966...' are one number (bug hunt 2026-11-11, sql04-3).
  if exists(select 1 from customers
            where (coalesce(p_email,'')<>'' and lower(email)=lower(p_email))
               or (coalesce(p_phone,'')<>''
                   and regexp_replace(coalesce(phone,''), '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g')
                   and not (select is_staff()))) then
    raise exception 'DUPLICATE' using errcode = 'unique_violation';
  end if;
  tok := encode(gen_random_bytes(24),'hex');
  insert into customers(id,name,email,phone,password_hash,created_at,height,type_preference,gender,session_token,heard_from)
  values(p_id,p_name,p_email,p_phone,crypt(p_pwd, gen_salt('bf', 10)),to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         p_height,p_type_preference,p_gender,tok,p_heard_from);
  return query select p_id, tok;
end $function$;

CREATE OR REPLACE FUNCTION public.customer_exists(p_email text, p_phone text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- Over budget answers "no account", not an error: the reply's SHAPE must not
  -- become the new oracle.
  if not _oracle_gate() then return false; end if;
  return exists(select 1 from customers
    where (coalesce(p_email,'')<>'' and (lower(email)=lower(p_email) or lower(apple_email)=lower(p_email)))
       -- by the number's digits, as customer_signup refuses it and customer_login finds it (bug hunt 2026-11-11, sql04-3)
       or (regexp_replace(coalesce(p_phone,''), '\D', '', 'g') <> ''
           and regexp_replace(coalesce(phone,''), '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g')));
end $function$;

-- 8 the automatic certificate follows the hours (sql02-1) -----------------------------------------
create or replace function public._vol_cert_follow()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
/* An automatic event certificate (issued_by 'auto', made by _vol_reward at the first hours logged) follows
   the event's live hours: it kept the figure it had when first made, so hours logged later never reached it
   (bug hunt 2026-11-11, sql02-1). A certificate a volunteer or staff made stays as it was issued; the last
   hours voided revoke the automatic one (staff_volunteer_hours_void), so nothing is done at zero. */
declare x record; _h numeric;
begin
  for x in select distinct v.c, v.s
             from (values (case when tg_op <> 'INSERT' then old.customer_id end, case when tg_op <> 'INSERT' then old.session_id end),
                          (case when tg_op <> 'DELETE' then new.customer_id end, case when tg_op <> 'DELETE' then new.session_id end)) v(c, s)
            where v.c is not null and v.s is not null loop
    select coalesce(sum(h.hours), 0) into _h from volunteer_hours h
     where h.customer_id = x.c and h.session_id = x.s and h.voided_at is null;
    if _h > 0 then
      update volunteer_certs vc
         set hours = _h,
             sessions = case when jsonb_typeof(vc.sessions) = 'array' and jsonb_array_length(vc.sessions) = 1
                             then jsonb_set(vc.sessions, '{0,hours}', to_jsonb(_h)) else vc.sessions end
       where vc.customer_id = x.c and vc.session_id = x.s and vc.kind = 'session' and vc.issued_by = 'auto'
         and vc.revoked_at is null and vc.hours is distinct from _h;
    end if;
  end loop;
  return null;
end $$;
revoke execute on function public._vol_cert_follow() from public, anon, authenticated;
drop trigger if exists volunteer_hours_cert_follow on public.volunteer_hours;
create trigger volunteer_hours_cert_follow after insert or update or delete on public.volunteer_hours
  for each row execute function public._vol_cert_follow();

-- 9 _vol_reward, _vol_note (sql02-2) --------------------------------------------------------------
create or replace function public._vol_reward(p_cust text, p_session text, p_op text)
 returns int
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _lvl int; _fr jsonb; _cert jsonb;
begin
  _lvl := _vol_badges(p_cust, p_session, p_op);
  if p_session is null then return _lvl; end if;
  begin
    _cert := _vol_cert_make_session(p_cust, p_session, _vol_sess_name(p_session), 'auto');
  exception when others then
    _cert := null; -- an event dated ahead of today: its certificate is made when the volunteer asks for it
  end;
  _fr := _vol_free_ride(p_cust, p_session);
  if not coalesce((_fr ->> 'again')::boolean, false) then
    insert into volunteer_log (customer_id, session_id, action, actor) values (p_cust, p_session, 'reward', left(coalesce(p_op, 'auto'), 120));
  end if;
  -- The update says the certificate is ready only when it is (bug hunt 2026-11-11, sql02-2): without one
  -- (an event still ahead) it says the free ride alone and carries cert_later; made on a later call (the
  -- event's day come, more hours logged), the update sent before names it and shows as new again.
  if _cert is not null then
    update volunteer_updates u
       set data = coalesce(u.data, '{}'::jsonb) || jsonb_build_object('cert', _cert ->> 'serial', 'cert_later', false),
           created_at = now(), read_at = null
     where u.customer_id = p_cust and u.session_id = p_session and u.kind = 'reward'
       and nullif(u.data ->> 'cert', '') is null;
  end if;
  perform _vol_note(p_cust, p_session, 'reward', jsonb_build_object('code', _fr ->> 'code', 'expires_at', _fr ->> 'expires_at', 'cert', _cert ->> 'serial',
                                                                     'cert_later', _cert is null));
  return _lvl;
end $function$;

create or replace function public._vol_note(p_cust text, p_session text, p_kind text, p_data jsonb default '{}'::jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _id bigint; _d text; _dm text; _b text;
begin
  if p_cust is null then return; end if;
  if p_kind in ('reminder_day', 'reminder_soon', 'reward') then
    insert into volunteer_updates (customer_id, session_id, kind, data) values (p_cust, p_session, p_kind, coalesce(p_data, '{}'::jsonb))
    on conflict (customer_id, (coalesce(session_id, '')), kind) do nothing
    returning id into _id;
    if _id is null then return; end if;
  else
    insert into volunteer_updates (customer_id, session_id, kind, data) values (p_cust, p_session, p_kind, coalesce(p_data, '{}'::jsonb))
    on conflict (customer_id, (coalesce(session_id, '')), kind) do update set data = excluded.data, created_at = now(), read_at = null
    returning id into _id;
  end if;
  select to_char(s.session_date::date, 'FMDD Mon'), to_char(s.session_date::date, 'DD/MM') into _d, _dm
    from sessions s where s.id = p_session and s.session_date ~ '^\d{4}-\d{2}-\d{2}$';
  _d := coalesce(_d, ''); _dm := coalesce(_dm, '');
  -- English | Arabic, as the other notifications (_ref_expiry_tick): the database does not know the reader's language.
  _b := case p_kind
    when 'approved'      then 'You are a MicroMobility volunteer. Pick an opportunity to help at. | أصبحت متطوعًا في مايكروموبيليتي. اختر فرصة تطوع.'
    when 'accepted'      then 'You are on the volunteer team for ' || _d || '. | تم قبولك في فريق المتطوعين ليوم ' || _dm || '.'
    when 'declined'      then 'Not this time for ' || _d || '. Thank you for offering. | ليس هذه المرة ليوم ' || _dm || '. شكرًا لعرضك المساعدة.'
    when 'ended'         then 'The opportunity on ' || _d || ' has ended. Thank you for offering. | انتهت فرصة يوم ' || _dm || '. شكرًا لعرضك المساعدة.'
    when 'briefing'      then 'The briefing for ' || _d || ' has changed. Please read it. | تغيّرت التوجيهات ليوم ' || _dm || '. يرجى قراءتها.'
    when 'reminder_day'  then 'Reminder: you volunteer on ' || _d || '. | تذكير: موعد تطوعك يوم ' || _dm || '.'
    when 'reminder_soon' then 'Your volunteer shift starts soon. Tap I have arrived when you get there. | يبدأ تطوعك قريبًا. اضغط وصلت عند وصولك.'
    /* a session called off (20261110235400) */
    when 'cancelled'     then 'The opportunity on ' || _d || ' has been cancelled. Thank you for offering. | أُلغيت فرصة يوم ' || _dm || '. شكرًا لعرضك المساعدة.'
    when 'lead'          then 'You lead the volunteer team on ' || _d || '. | أنت قائد فريق المتطوعين يوم ' || _dm || '.'
    /* no certificate made yet (an event still ahead): the free ride alone (bug hunt 2026-11-11) */
    when 'reward'        then case when nullif(coalesce(p_data, '{}'::jsonb) ->> 'cert', '') is null
                                   then 'Thank you for volunteering. Your free ride is ready. Your certificate will be ready after the event. | شكرًا لتطوعك. جولتك المجانية جاهزة، وستكون شهادتك جاهزة بعد الفعالية.'
                                   else 'Thank you for volunteering. Your certificate and free ride are ready. | شكرًا لتطوعك. شهادتك وجولتك المجانية جاهزتان.' end
    /* an application declined, and staff's thanks after an event (20261111140000) */
    when 'not_approved'  then 'Thank you for applying to volunteer with MicroMobility. We cannot take you on this time. | شكرًا لتقديمك للتطوع مع مايكروموبيليتي. لا يمكننا قبولك هذه المرة.'
    when 'thanks'        then 'Thank you for volunteering on ' || _d || '. Our team has a note for you. | شكرًا لتطوعك يوم ' || _dm || '. لديك رسالة من فريقنا.'
  end;
  if _b is not null then
    perform _push_queue(p_cust, 'vol-' || _id || '-' || to_char(now(), 'YYYYMMDDHH24MISS'), 'MicroMobility Volunteers', _b,
                        'https://volunteer.micromobility.sa/#updates');
  end if;
end $function$;

-- 10 customer_claim_spot (sql03-1, sql03-8) -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_claim_spot(p_token text, p_decline boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o waitlist_offers%rowtype; q queue_entries%rowtype; _s sessions%rowtype; _own boolean; _held int; _n int; _a jsonb; k text;
        _ended boolean;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND'); end if;
  select * into o from waitlist_offers where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND'); end if;
  if o.status = 'claimed' then return jsonb_build_object('ok', true, 'already', true); end if;
  if o.status <> 'open' then return jsonb_build_object('ok', false, 'reason', upper(o.status)); end if;
  if o.expires_at <= now() then
    update waitlist_offers set status = 'expired' where id = o.id;
    perform _wl_offer_fill(o.session_id);
    return jsonb_build_object('ok', false, 'reason', 'EXPIRED');
  end if;
  select * into _s from sessions where id = o.session_id;
  /* the members limit's lock before the promotion's, the order a new booking takes them in */
  if _s.member_cap is not null then perform pg_advisory_xact_lock(hashtext('membercap:'||o.session_id)); end if;
  perform pg_advisory_xact_lock(hashtext('promote:'||o.session_id));
  select * into q from queue_entries where id = o.booking_id for update;
  if q.id is null or q.status <> 'waitlist' then
    update waitlist_offers set status = 'closed' where id = o.id;
    if q.status in ('waiting', 'active', 'done') then return jsonb_build_object('ok', true, 'already', true); end if;
    return jsonb_build_object('ok', false, 'reason', 'CLOSED');
  end if;
  /* The booking has moved to another ride's waitlist since the offer: this ride's place is not its to take,
     and every check below counts this ride, so it was promoted on the other one past its places and its
     line (bug hunt 2026-11-11, sql03-1). The place goes to the next in line here. */
  if q.session_id is distinct from o.session_id then
    update waitlist_offers set status = 'closed' where id = o.id;
    perform _wl_offer_fill(o.session_id);
    return jsonb_build_object('ok', false, 'reason', 'CLOSED');
  end if;
  /* a time the window cannot read closes nothing, as at the other customer doors (sql03-8) */
  begin _ended := (select w.ends_at from _session_window(_s) w) <= now();
  exception when others then _ended := false; end;
  if _s.id is null or _s.cancelled_at is not null or coalesce(_ended, false) then
    update waitlist_offers set status = 'closed' where id = o.id;
    return jsonb_build_object('ok', false, 'reason', 'ENDED');
  end if;
  if p_decline then
    update waitlist_offers set status = 'declined' where id = o.id;
    perform _wl_offer_fill(o.session_id);
    return jsonb_build_object('ok', true, 'declined', true);
  end if;
  _own := coalesce(_s.event_kind,'') = 'community' and coalesce(_s.ride_kind,'') = 'petromin';
  select count(*) into _held from queue_entries x
   where x.session_id = o.session_id
     and coalesce(x.status,'') not in ('cancelled','removed','noshow','waitlist')
     and (_own or coalesce(x.type_preference,'') <> 'Own');
  if _held >= coalesce(_s.capacity, 12) and (_own or coalesce(q.type_preference,'') <> 'Own') then
    return jsonb_build_object('ok', false, 'reason', 'FULL');
  end if;
  /* the bikes out of service and the members limit, as a promotion counts them (bug hunt 2026-11-10,
     20261110235000) */
  if not _out_bikes_room(o.session_id, q.type_preference, q.id, true) then
    return jsonb_build_object('ok', false, 'reason', 'FULL');
  end if;
  if _s.member_cap is not null and q.partner is null and coalesce(q.type_preference,'') <> 'Own'
     and (select count(*) from queue_entries x
           where x.session_id = o.session_id and x.partner is null
             and coalesce(x.status,'') not in ('cancelled','removed','noshow','waitlist')) >= _s.member_cap then
    return jsonb_build_object('ok', false, 'reason', 'FULL');
  end if;
  update waitlist_offers set status = 'claimed', claimed_at = now() where id = o.id;
  perform set_config('mm.promoting','1',true);
  update queue_entries set status = 'waiting' where id = q.id and status = 'waitlist';
  get diagnostics _n = row_count;
  perform set_config('mm.promoting','',true);
  if _n = 0 then raise exception 'CHANGED' using errcode = 'P0001'; end if;
  begin
    _a := _addon_map(q.addons);
    for k in select jsonb_object_keys(_a) loop
      update inventory i
         set qty = i.qty - greatest((_a->>k)::int - coalesce((coalesce(q.addons_held, '{}'::jsonb)->>k)::int, 0), 0)
       where i.id = k;
    end loop;
    update queue_entries set addons_held = _a where id = q.id;
  exception when others then null;
  end;
  return jsonb_build_object('ok', true, 'queue_num', q.queue_num);
end $function$;

-- 11 _wl_offer_fill, _wl_offer_tick (sql03-8) -----------------------------------------------------
CREATE OR REPLACE FUNCTION public._wl_offer_fill(p_session_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _s sessions%rowtype; _own boolean; _held int; _open int; _free int; _n int := 0; r record; _min int;
        _mroom int; _ismem boolean; _out int := 0; _ended boolean;
begin
  if _wl_mode() <> 'claim' then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('promote:'||p_session_id));  /* the promotion's own lock: two fills never pick one rider */
  select * into _s from sessions where id = p_session_id;
  if not found or coalesce(_s.needs_approval, false) or _s.cancelled_at is not null or _s.status = 'deleted' then return 0; end if;
  /* a time the window cannot read closes nothing, as at the customer doors: it raised here, which stopped a
     rider's cancel on that ride and rolled back every session's offers in the tick (bug hunt 2026-11-11, sql03-8) */
  begin _ended := (select w.ends_at from _session_window(_s) w) <= now();
  exception when others then _ended := false; end;
  if coalesce(_ended, false) then return 0; end if;
  _own := coalesce(_s.event_kind,'') = 'community' and coalesce(_s.ride_kind,'') = 'petromin';
  select count(*) into _held from queue_entries q
   where q.session_id = p_session_id
     and coalesce(q.status,'') not in ('cancelled','removed','noshow','waitlist')
     and (_own or coalesce(q.type_preference,'') <> 'Own');
  select count(*) into _open from waitlist_offers o
   where o.session_id = p_session_id and o.status = 'open' and o.expires_at > now();
  /* bikes out of service take their places off, as _out_bikes_guard counts them (bug hunt 2026-11-10,
     20261110235000) */
  select coalesce(sum(greatest(0, floor((value #>> '{}')::numeric))), 0)::int into _out
    from jsonb_each(coalesce(_s.out_bikes, '{}'::jsonb)) where jsonb_typeof(value) = 'number';
  _free := greatest(0, coalesce(_s.capacity, 12) - _out) - _held - _open;
  if _free <= 0 then return 0; end if;
  -- The members limit, counted as _community_booking_gate counts it, less the open offers to
  -- members: no more members are offered a place than it has room for (bug hunt 2026-10-28).
  if _s.member_cap is not null then
    select _s.member_cap
           - (select count(*) from queue_entries q
               where q.session_id = p_session_id and q.partner is null
                 and coalesce(q.status,'') not in ('cancelled','removed','noshow','waitlist'))
           - (select count(*) from waitlist_offers o join queue_entries q on q.id = o.booking_id
               where o.session_id = p_session_id and o.status = 'open' and o.expires_at > now()
                 and q.partner is null and coalesce(q.type_preference,'') <> 'Own')
      into _mroom;
  end if;
  _min := _wl_claim_min();
  for r in
    select q.id, q.partner, q.type_preference from queue_entries q
     where q.session_id = p_session_id and q.status = 'waitlist'
       and (_own or coalesce(q.type_preference,'') <> 'Own')
       and not exists (select 1 from waitlist_offers o where o.booking_id = q.id
                        and o.status in ('open', 'expired', 'declined'))
     order by coalesce(q.waitlist_num, 2147483647), q.registered_at
  loop
    exit when _n >= _free;
    _ismem := _s.member_cap is not null and r.partner is null and coalesce(r.type_preference,'') <> 'Own';
    continue when _ismem and _mroom <= 0;
    continue when _out > 0 and not _out_bikes_room(p_session_id, r.type_preference, r.id, true);   /* no working bike of the type */
    insert into waitlist_offers (booking_id, session_id, token, expires_at)
    values (r.id, p_session_id, replace(gen_random_uuid()::text, '-', ''), now() + make_interval(mins => _min))
    on conflict (booking_id) where status = 'open' do nothing;
    if found then
      _n := _n + 1;
      if _ismem then _mroom := _mroom - 1; end if;
    end if;
  end loop;
  return _n;
end $function$;

create or replace function public._wl_offer_tick()
returns int
language plpgsql security definer set search_path to 'public'
as $$
declare sid text; _n int := 0;
begin
  for sid in
    with x as (update waitlist_offers set status = 'expired'
                where status = 'open' and expires_at <= now() returning session_id)
    select distinct session_id from x
  loop
    -- one session whose offers cannot be made leaves the others' expiries and offers standing (bug hunt 2026-11-11)
    begin
      _n := _n + _wl_offer_fill(sid);
    exception when others then null;
    end;
  end loop;
  return _n;
end $$;

-- 12 customer_booking_update (sql03-3, sql03-4, sql03-5) ------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_booking_update(p_id text, p_token text, p_entry_id text, p_patch jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  q queue_entries%rowtype; _to sessions%rowtype; _at sessions%rowtype; _p jsonb; _today text;
  _want text; _new_status text; _move boolean := false; _qnum int; _live int;
  _type text; _size text; _h int; _name text; _addons text; _set_addons boolean := false;
  _code text; _unpay boolean := false; _rb int; _re int; _cancelling boolean;
  _cu customers%rowtype; _dp text; _house text; _reapprove boolean := false; _to_own boolean := false;
  _rt text[]; _rd jsonb; _ended boolean;
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  _p := coalesce(p_patch, '{}'::jsonb);
  if jsonb_typeof(_p) <> 'object' then return false; end if;
  select * into q from queue_entries x where x.id = p_entry_id and x.customer_id = p_id for update;
  if not found then return false; end if;
  select * into _cu from customers where customers.id = p_id;
  _today := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  _want := nullif(_p->>'status', '');
  if _want = q.status then _want := null; end if;
  if _want is not null and _want not in ('cancelled','waiting','waitlist') then return false; end if;
  if _p ? 'session_id' and (_p->>'session_id') is distinct from q.session_id then
    if q.status not in ('waiting','waitlist') or _want = 'cancelled' then return false; end if;
    select * into _at from sessions where sessions.id = q.session_id;
    select * into _to from sessions where sessions.id = _p->>'session_id';
    -- a ride that ended earlier today takes no one, as a new booking (bug hunt 2026-10-28); a time the
    -- window cannot read closes nothing
    begin _ended := (select w.ends_at from _session_window(_to) w) <= now();
    exception when others then _ended := false; end;
    if _to.id is null
       or coalesce(_to.status,'') not in ('open','full')
       or coalesce(_to.needs_approval,false) or coalesce(_at.needs_approval,false)
       or coalesce(_to.ride_kind,'') = 'snd96' or coalesce(_at.ride_kind,'') = 'snd96'
       or _to.session_date < _today or coalesce(_ended, false)
       or (_to.required_tag_id is not null and not exists (
             select 1 from customer_tags ct
              where ct.customer_id = p_id and ct.tag_id = _to.required_tag_id
                and _ctag_active(ct.starts_at, ct.expires_at))) then
      return false;
    end if;
    _move := true;
    _new_status := case when coalesce(_to.status,'') = 'full' or _want = 'waitlist' then 'waitlist' else 'waiting' end;
    update sessions
       set last_qnum = greatest(coalesce(last_qnum, 0),
                                coalesce((select max(x.queue_num) from queue_entries x where x.session_id = _to.id), 0)) + 1
     where sessions.id = _to.id
     returning last_qnum into _qnum;
  elsif _want = 'cancelled' then
    if q.status not in ('waiting','waitlist') then return false; end if;
    /* A paid ride that has ended is settled at close-out, not by the rider: cancelled afterwards it gave
       its wallet money back for a ride missed (bug hunt 2026-11-10, 20261110235000). */
    if coalesce(q.paid, false) or coalesce(q.wallet_paid, 0) > 0 then
      select * into _at from sessions where sessions.id = q.session_id;
      begin _ended := (select w.ends_at from _session_window(_at) w) <= now();
      exception when others then _ended := false; end;
      if left(coalesce(_at.session_date, q.session_date, ''), 10) < _today or coalesce(_ended, false) then
        return false;
      end if;
    end if;
    _new_status := 'cancelled';
  elsif _want in ('waiting','waitlist') then
    if q.status <> 'cancelled' or coalesce(q.cancelled_by,'') <> 'customer' then return false; end if;
    select * into _at from sessions where sessions.id = q.session_id;
    begin _ended := (select w.ends_at from _session_window(_at) w) <= now();   -- (bug hunt 2026-10-28)
    exception when others then _ended := false; end;
    if _at.id is null or coalesce(_at.status,'') not in ('open','full') or _at.session_date < _today
       or coalesce(_ended, false) then   -- ended earlier today, as a new booking
      return false;
    end if;
    -- a private ride takes a rider back only while they hold its tag, as a new booking would (20261014120000)
    if _at.required_tag_id is not null and not exists (
         select 1 from customer_tags ct
          where ct.customer_id = p_id and ct.tag_id = _at.required_tag_id
            and _ctag_active(ct.starts_at, ct.expires_at)) then
      return false;
    end if;
    if coalesce(_at.event_kind,'') = 'community' then
      if not coalesce(_at.open_to_all,false)
         and not (coalesce(_at.ride_kind,'') = 'petromin' and _petromin_holder(p_id))   -- (20261012180000)
         and not (coalesce(_at.ride_kind,'') = 'vlap' and _vlap_holder(p_id))           -- (20261017210000)
         and not exists (
           select 1 from customer_tags ct join tags tg on tg.id = ct.tag_id
            where ct.customer_id = p_id and lower(tg.slug) = 'saturday'
              and _ctag_active(ct.starts_at, ct.expires_at)) then
        return false;
      end if;
      select count(*) into _live from queue_entries x
       where x.session_id = q.session_id and x.customer_id = p_id and x.id <> q.id
         and coalesce(x.status,'') not in ('cancelled','removed','noshow');
      -- the cap _group_ride_cap applies: an event takes five per booker (20261004100000)
      if _live >= (case when coalesce(_at.needs_approval,false) then 1
                        when coalesce(_at.ride_kind,'') = 'snd96' then _biz_int('jcc_account_cap', 3)
                        when coalesce(_at.ride_kind,'') = 'event' then _biz_int('event_seat_max', 5)
                        else _biz_int('group_ride_max', 2) end) then return false; end if;   -- Settings > Business, as _group_ride_cap (20261014120000)
    else
      -- Every other ride: three per account, as _group_ride_cap counts them (20261005210000).
      select count(*) into _live from queue_entries x
       where x.session_id = q.session_id and x.customer_id = p_id and x.id <> q.id
         and coalesce(x.status,'') in ('waiting','active','waitlist');
      if _live >= _biz_int('jcc_account_cap', 3) then return false; end if;
    end if;
    _new_status := case when _want = 'waiting' and _session_has_room(q.session_id, q.type_preference, q.id)
                        then 'waiting' else 'waitlist' end;
    _reapprove := coalesce(_at.needs_approval, false);
    if exists (select 1 from queue_entries x
                where x.session_id = q.session_id and x.queue_num = q.queue_num and x.id <> q.id
                  and x.status not in ('cancelled','removed','noshow')) then
      update sessions
         set last_qnum = greatest(coalesce(last_qnum, 0),
                                  coalesce((select max(x.queue_num) from queue_entries x where x.session_id = q.session_id), 0)) + 1
       where sessions.id = q.session_id
       returning last_qnum into _qnum;
    end if;
    /* The holder's free row (the house rule, VIP) comes back free only while they have no other free row on
       the ride: one booked after the cancel took the one free place, so this one comes back to pay
       (bug hunt 2026-11-11, sql03-5). _enforce_booking_price prices it as it leaves paid. A friend's row
       staff put on the house is not the holder's and keeps what staff gave. */
    if coalesce(q.paid, false) and coalesce(q.price, 0) = 0 and coalesce(q.promo_code, '') = ''
       and coalesce(_fare_now(q.session_id, q.id, q.type_preference), 0) > 0
       and (lower(btrim(coalesce(q.name, ''))) = lower(btrim(coalesce(_cu.name, '')))
            or (btrim(coalesce(q.name, '')) <> '' and exists (
                  select 1 from audit_log a
                   where a.tbl = 'customers' and a.row_id = p_id and a.op = 'UPDATE' and a.changed ? 'name'
                     and lower(btrim(coalesce(a.changed -> 'name' ->> 'old', ''))) = lower(btrim(q.name)))))
       and _house_taken(p_id, q.session_id, q.id) then
      _unpay := true;
    end if;
  end if;
  if q.status in ('waiting','waitlist') and coalesce(_new_status,'') <> 'cancelled' then
    if _p ? 'type_preference' and _type_ok(_p->>'type_preference') and (_p->>'type_preference') <> 'Any' then _type := _p->>'type_preference'; end if;
    if _p ? 'size' and coalesce(_p->>'size','') in ('','XS','S','M','L','XL') then _size := coalesce(_p->>'size',''); end if;
    if (_p->>'height') ~ '^[0-9]{3}$' and (_p->>'height')::int between 100 and 250 then _h := (_p->>'height')::int; end if;
    if _p ? 'name' then
      _name := nullif(left(btrim(regexp_replace(coalesce(_p->>'name',''), '\s+', ' ', 'g')), 60), '');
      -- letters and spaces only, as every other customer door takes a name: else the name stays (bug hunt 2026-10-28)
      if _name is not null and (not _name_chars_ok(_name) or not _name_parts_ok(_name)) then _name := null; end if;
    end if;
    if _p ? 'promo_code' then
      _code := nullif(btrim(coalesce(_p->>'promo_code','')), '');
      -- A paid row takes no new code: there is nothing left to discount (20261005210000).
      if _code is null or _code !~ '^[A-Za-z0-9_-]{1,40}$' or coalesce(q.promo_code,'') <> '' or q.paid then _code := null; end if;
    end if;
    if q.paid and coalesce(q.price,0) = 0 and coalesce(q.promo_code,'') = '' then
      if _type is not null and _type is distinct from q.type_preference then
        _dp := coalesce(_cu.default_pay, '');
        _house := case when _is_vip(p_id) then 'all'   -- a VIP rides free on every type (20261005210000)
                       when _dp = 'house' then 'all' when _dp like 'house:%' then substring(_dp from 7) end;
        if _house is null or not (_house = 'all' or _type = any(string_to_array(_house, ','))) then _unpay := true; end if;
      end if;
      if _name is not null and lower(btrim(coalesce(q.name,''))) = lower(btrim(coalesce(_cu.name,'')))
         and lower(_name) <> lower(btrim(coalesce(_cu.name,''))) then
        _unpay := true;
      end if;
    /* A paid row takes another type only at no higher fare: fare against fare, as a move compares them (a
       code or a party's share left the price paid under the fare, and every change was refused), and a code
       kept to one type does not go with the row to another (bug hunt 2026-11-11, sql03-4). */
    elsif q.paid and _type is not null and _type is distinct from q.type_preference
          and (coalesce(_fare_now(q.session_id, q.id, _type), 0)
                 > greatest(coalesce(_fare_now(q.session_id, q.id, q.type_preference), 0), coalesce(q.price, 0))
               or (coalesce(q.promo_code, '') <> '' and exists (
                     select 1 from promo_codes c
                      where lower(c.code) = lower(q.promo_code)
                        and c.applies_to is not null and c.applies_to is distinct from _type))) then
      return false;
    end if;
  end if;
  if _p ? 'addons' and q.status in ('waiting','waitlist','active') and coalesce(_new_status,'') <> 'cancelled' then
    _addons := nullif(_p->>'addons','');
    _set_addons := _addons is null or _addons_ok(_addons);
    if _set_addons and _addons is not null and (
         jsonb_array_length(_addons::jsonb) > 20
         or exists (select 1 from jsonb_each_text(_addon_map(_addons)) m where m.value::int > 20)) then
      _set_addons := false;
    end if;
    if _set_addons and q.status = 'active' and exists (
         select 1 from jsonb_each_text(_addon_map(q.addons)) o
          where coalesce((_addon_map(_addons)->>o.key)::int, 0) < o.value::int) then
      _set_addons := false;
    end if;
    /* A booking paid at the desk, by card or online takes no more of a priced add-on: it stayed paid, so
       nobody collected it (bug hunt 2026-11-10). The wallet's own rows follow in _wallet_follow; a ride
       on the house as before. */
    if _set_addons and coalesce(q.paid, false) and coalesce(q.pay_method, '') <> 'wallet'
       and not (coalesce(q.price, 0) = 0 and coalesce(q.promo_code, '') = '')
       and exists (select 1 from jsonb_each_text(_addon_map(_addons)) n join inventory i on i.id = n.key
                    where coalesce(i.price, 0) > 0
                      and n.value::int > coalesce((_addon_map(q.addons)->>n.key)::int, 0)) then
      return false;
    end if;
  end if;
  -- A ride still ahead is not rated (20261004100000).
  if coalesce(q.session_date, '') > _today then
    _p := _p - 'rating_bike' - 'rating_exp' - 'rating_tags' - 'rating_detail' - 'feedback';
  end if;
  if _p ? 'rating_bike' then
    _rb := case when (_p->>'rating_bike') ~ '^[0-9]{1,2}$' and (_p->>'rating_bike')::int between 1 and 10 then (_p->>'rating_bike')::int end;
  end if;
  if _p ? 'rating_exp' then
    _re := case when (_p->>'rating_exp') ~ '^[0-9]{1,2}$' and (_p->>'rating_exp')::int between 1 and 10 then (_p->>'rating_exp')::int end;
  end if;
  if _p ? 'rating_tags' and jsonb_typeof(_p->'rating_tags') = 'array' then
    select array_agg(x order by o) into _rt
      from (select x, o from jsonb_array_elements_text(_p->'rating_tags') with ordinality as e(x, o)
             where x ~ '^[a-z_]{1,24}$' limit 8) s;
  end if;
  if _p ? 'rating_detail' and jsonb_typeof(_p->'rating_detail') = 'object' then
    _rd := jsonb_strip_nulls(jsonb_build_object(
      'form', case when (_p->'rating_detail'->>'form') in ('rental','social') then _p->'rating_detail'->>'form' end,
      's', (select coalesce(jsonb_object_agg(k, case when v ~ '^[0-9]{1,2}$' then v::int end), '{}'::jsonb)
              from (select k, v from jsonb_each_text(case when jsonb_typeof(_p->'rating_detail'->'s') = 'object'
                                                          then _p->'rating_detail'->'s' else '{}'::jsonb end) e(k, v)
                     where k ~ '^[a-z_]{1,24}$'
                       and (case when v ~ '^[0-9]{1,2}$' then v::int end) between 1 and 10
                     limit 20) s1),
      'why', (select coalesce(jsonb_object_agg(k, left(btrim(v), 300)), '{}'::jsonb)
                from (select k, v from jsonb_each_text(case when jsonb_typeof(_p->'rating_detail'->'why') = 'object'
                                                            then _p->'rating_detail'->'why' else '{}'::jsonb end) e(k, v)
                       where k ~ '^[a-z_]{1,24}$' and btrim(v) <> ''
                       limit 20) w1),
      'skip_bf', case when (_p->'rating_detail'->>'skip_bf') = 'true' then true end));
  end if;
  -- A paid booking keeps what it paid: it moves only to a ride with the same fare for its type.
  -- A free row the account's house rule (or VIP) still covers moves as before (20261005210000).
  if _move and q.paid and not _unpay
     and coalesce(_fare_now(_to.id, q.id, coalesce(_type, q.type_preference)), 0)
         <> coalesce(_fare_now(q.session_id, q.id, coalesce(_type, q.type_preference)), 0)
     and not (coalesce(q.price, 0) = 0 and coalesce(q.promo_code, '') = ''
              and (_is_vip(p_id) or coalesce(_cu.default_pay, '') = 'house'
                   or (coalesce(_cu.default_pay, '') like 'house:%'
                       and coalesce(_type, q.type_preference) = any(string_to_array(substring(_cu.default_pay from 7), ','))))) then
    raise exception 'PAID_MOVE' using errcode = 'P0001';
  end if;
  _cancelling := coalesce(_p->>'status','') = 'cancelled'
                 and (_new_status = 'cancelled' or (q.status = 'cancelled' and coalesce(q.cancelled_by,'') = 'customer'));
  if q.status = 'waiting' and not _move and coalesce(_new_status, 'waiting') = 'waiting'
     and coalesce(q.type_preference, '') = 'Own' and _type is not null and _type <> 'Own'
     and not exists (select 1 from sessions s where s.id = q.session_id
                      and coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin')
     and not _session_has_room(q.session_id, _type, q.id) then
    return false;
  end if;
  /* A switch between two of our bikes needs a working bike of the new type, as a new booking, a promotion
     and a claim count them; only a switch from an own bike was checked (bug hunt 2026-11-11, sql03-3). */
  if q.status = 'waiting' and not _move and coalesce(_new_status, 'waiting') = 'waiting'
     and coalesce(q.type_preference, '') <> 'Own' and _type is not null and _type <> 'Own'
     and _type is distinct from q.type_preference
     and not _out_bikes_room(q.session_id, _type, q.id, true) then
    return false;
  end if;
  _to_own := q.status = 'waiting' and not _move and coalesce(_new_status, 'waiting') = 'waiting'
             and coalesce(q.type_preference, '') <> 'Own' and _type = 'Own';
  update queue_entries x set
    type_preference  = coalesce(_type, x.type_preference),
    size             = coalesce(_size, x.size),
    height           = coalesce(_h, x.height),
    name             = coalesce(_name, x.name),
    paid             = case when _unpay then false else x.paid end,
    status           = coalesce(_new_status, x.status),
    approval         = case when _reapprove then 'pending' else x.approval end,
    queue_num        = coalesce(_qnum, x.queue_num),
    promo_code       = coalesce(_code, x.promo_code),
    session_id       = case when _move then _to.id else x.session_id end,
    session_day      = case when _move then _to.day else x.session_day end,
    session_date     = case when _move then _to.session_date else x.session_date end,
    waitlist_num     = case when _move then null else x.waitlist_num end,
    rating_bike      = case when _p ? 'rating_bike' then _rb else x.rating_bike end,
    rating_exp       = case when _p ? 'rating_exp'  then _re else x.rating_exp end,
    rating_tags      = case when _p ? 'rating_tags' then _rt else x.rating_tags end,
    rating_detail    = case when _p ? 'rating_detail' then _rd else x.rating_detail end,
    feedback         = case when _p ? 'feedback'    then left(nullif(_p->>'feedback',''), 1000) else x.feedback end,
    addons           = case when _set_addons then _addons else x.addons end,
    assigned_bike_id = case when _new_status = 'cancelled' then null else x.assigned_bike_id end,
    cancelled_by     = case when _new_status = 'cancelled' then 'customer'
                            when x.status = 'cancelled' and _new_status in ('waiting','waitlist') then null
                            else x.cancelled_by end,
    cancel_reason    = case
                         when q.status = 'cancelled' and coalesce(q.cancelled_by,'') <> 'customer' then x.cancel_reason   -- staff's stays (20261005210000)
                         when _cancelling then case when (_p->>'cancel_reason') ~ '^[a-z_]{1,24}$' then _p->>'cancel_reason' else null end
                         when _p ? 'status' then null
                         else x.cancel_reason end,
    cancel_note      = case
                         when q.status = 'cancelled' and coalesce(q.cancelled_by,'') <> 'customer' then x.cancel_note
                         when _cancelling then left(nullif(btrim(coalesce(_p->>'cancel_note','')),''), 300)
                         when _p ? 'status' then null
                         else x.cancel_note end
  where x.id = q.id;
  if (q.status = 'waiting' and (_new_status = 'cancelled' or _move)) or _to_own then
    perform _promote_next_waitlist(q.session_id);
  end if;
  return true;
end $function$;

-- checks ---------------------------------------------------------------------------------------------
do $chk$
declare fn text;
begin
  foreach fn in array array['_lk_money_back', '_lk_booking_follow', '_lk_kind', '_lk_session_cancelled', 'customer_locker_reserve',
                            '_mt_core', 'customer_signup', 'customer_exists', '_vol_cert_follow', '_vol_reward', '_vol_note',
                            'customer_claim_spot', '_wl_offer_fill', '_wl_offer_tick', 'customer_booking_update'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = fn and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', fn;
    end if;
  end loop;
  -- _house_taken is an invoker helper (called only from definer functions and triggers): its search_path stays
  if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_house_taken'
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '_house_taken lost its search_path';
  end if;
  -- one overload each, as before
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname in ('customer_signup', 'customer_exists', 'customer_booking_update', 'customer_claim_spot',
                          'customer_locker_reserve', '_house_taken', '_mt_core', '_vol_reward', '_vol_note')) <> 9 then
    raise exception 'a replaced function gained a second overload';
  end if;
  -- the password rule 20261111130000 put into customer_signup is still there
  if position('_pwd_common' in (select p.prosrc from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'customer_signup')) = 0 then
    raise exception 'customer_signup lost its _pwd_common check';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'sessions_lockers_cancelled' and tgrelid = 'public.sessions'::regclass) then
    raise exception 'sessions_lockers_cancelled trigger missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'volunteer_hours_cert_follow' and tgrelid = 'public.volunteer_hours'::regclass) then
    raise exception 'volunteer_hours_cert_follow trigger missing';
  end if;
  if has_function_privilege('anon', 'public._lk_money_back(uuid, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public._lk_money_back(uuid, text, text)', 'EXECUTE') then
    raise exception '_lk_money_back is callable from the API';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111235000', 'bh11_live_a')
on conflict (version) do nothing;

commit;
