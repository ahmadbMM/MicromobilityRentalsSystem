-- ============================================================================
-- Lockers: an automatic locker for every reservation made away from the desk, and Cancel with no refund
-- (the user, 2026-11-10: "add the ability to cancel locker reservation with no refund, whenever a customer books a locker
-- online or not on site assign them an automatic locker so it stays reserved for them"), 2026-11-11.
--
-- 1. An automatic locker. A reservation held with no number only counted against the evening's places; the desk gave the
--    number later. Now a free door is held for the rider at once (_lk_free_unit: a door free for every slot of the time,
--    the ones already taken for the other slot first, so whole doors stay for "both", then by number):
--    - customer_locker_reserve with no door picked (a page cached before the review's cabinet, or the cabinet not read);
--    - a booking moved to another evening whose locker is someone else's there (_lk_booking_follow), or that had none;
--    - staff_locker_edit moving a reservation to another evening, or to a time its locker is taken for (an Unassign, and a
--      rental left without a number on the same evening, stay without one);
--    - staff_locker_reserve / staff_locker_walkup for a later evening (the renter is not at the desk; tonight the desk gives
--      the door as before). Both answer the 'code' they gave.
--    The lockers page (customer_locker_book) always takes picked doors, unchanged. When no single door is free for the whole
--    time (one taken 6-8, another 9-11), the rental is held with no number as before.
--    Reservations from today on with no number get one now (the rider's own, and staff ones for later evenings).
-- 2. Cancel with no refund: staff_locker_cancel(rental, reason, undo, p_no_refund). The locker is freed and what was paid for
--    it stays: its wallet or card receipt is not voided (a card's refund owed, written by _pay_locker_follow where online
--    payments exist, is declined), its fee stays on a paid ride's bill (locker_rentals.kept, counted by _lk_line), its till
--    lines stay. A locker nothing has been paid for cancels as before. The old three-argument call still works (default
--    false), so the staff page in use keeps cancelling with the money back.
--
-- Rebuilt from the live definitions (prod and staging matched the repo on 2026-11-10): _lk_line (20261109120000),
-- _lk_booking_follow (20261109230000), customer_locker_reserve and staff_locker_cancel (20261110235000), staff_locker_reserve
-- and staff_locker_walkup (20261109120000), staff_locker_edit (20261110200000).
-- Rollback: re-run those definitions; drop function staff_locker_cancel(uuid, text, boolean, boolean) and _lk_free_unit;
--   alter table locker_rentals drop column kept (a booking's kept fee then leaves its bill on its next write).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

alter table public.locker_rentals add column if not exists kept boolean not null default false;

-- ── A free locker for an evening's time ─────────────────────────────────────────────────────
-- A door in service that nobody holds for any slot of the time (p_except: the rental being placed). Doors already taken for
-- the evening's other slot come first, so the whole doors stay free for "both" and Petromin nights; then by number. The
-- caller holds the evening's lock. Null when none is free.
create or replace function public._lk_free_unit(p_day date, p_period text, p_except uuid)
returns uuid
language sql stable security definer set search_path to 'public'
as $$
  select l.id
    from lockers l
   where l.status = 'available'
     and not exists (select 1 from locker_rentals x
                      where x.locker_id = l.id and x.day = p_day and x.status in ('reserved', 'in_use')
                        and x.id is distinct from p_except and _lk_slots(x.period) && _lk_slots(p_period))
   order by (select count(*) from locker_rentals x
              where x.locker_id = l.id and x.day = p_day and x.status in ('reserved', 'in_use') and x.id is distinct from p_except) desc,
            regexp_replace(l.code, '[0-9]+$', ''), coalesce(substring(l.code from '[0-9]+$'), '0')::int, l.code
   limit 1
$$;
revoke execute on function public._lk_free_unit(date, text, uuid) from public, anon, authenticated;

-- ── The fee on the bill: a locker cancelled with no refund keeps it ────────────────────────────
create or replace function public._lk_line(p_booking text, p_addons text)
returns text
language plpgsql stable security definer set search_path to 'public'
as $$
declare fee numeric; j jsonb; x jsonb; outv jsonb := '[]'::jsonb;
begin
  -- a locker cancelled with no refund (kept) keeps its fee on the bill
  select sum(r.price) into fee from locker_rentals r
   where r.booking_id = p_booking and r.on_bill and (r.status in ('reserved', 'in_use', 'returned') or (r.status = 'cancelled' and r.kept));
  if fee is null and (p_addons is null or position('"locker"' in p_addons) = 0) then return p_addons; end if;
  begin j := coalesce(nullif(btrim(coalesce(p_addons, '')), ''), '[]')::jsonb; exception when others then return p_addons; end;
  if jsonb_typeof(j) <> 'array' then return p_addons; end if;
  for x in select value from jsonb_array_elements(j) loop
    if not ((jsonb_typeof(x) = 'object' and x ->> 'id' = 'locker') or (jsonb_typeof(x) = 'string' and x #>> '{}' = 'locker')) then
      outv := outv || jsonb_build_array(x);
    end if;
  end loop;
  if coalesce(fee, 0) > 0 then outv := outv || jsonb_build_array(jsonb_build_object('id', 'locker', 'qty', 1, 'p', fee)); end if;
  if jsonb_array_length(outv) = 0 and p_addons is null then return null; end if;
  if outv = j then return p_addons; end if;
  return outv::text;
end $$;
revoke execute on function public._lk_line(text, text) from public, anon, authenticated;

-- ── The booking leads: a moved booking's locker ─────────────────────────────────────────────
create or replace function public._lk_booking_follow()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare nd date; fr record;
begin
  if tg_op = 'DELETE' then
    perform set_config('mm.lk_deleting', old.id, true);
    update locker_rentals set status = 'cancelled', cancelled_at = now(), cancel_reason = 'booking deleted'
     where booking_id = old.id and status = 'reserved';
    perform set_config('mm.lk_deleting', '', true);
    return old;
  end if;
  if new.session_id is distinct from old.session_id then
    select case when s.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date, 10)::date end into nd
      from sessions s where s.id = new.session_id;
    if nd is not null then perform _lk_lock(nd); end if;
    update locker_rentals r set session_id = new.session_id, day = coalesce(nd, r.day)
     where r.booking_id = new.id and r.status in ('reserved', 'in_use');
    -- the locker goes along only when nobody holds it there for an overlapping time
    update locker_rentals r set locker_id = null, status = 'reserved', assigned_at = null, assigned_by = null
     where r.booking_id = new.id and r.status in ('reserved', 'in_use') and r.locker_id is not null
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
      update locker_rentals set status = 'cancelled', cancelled_at = now(), cancel_reason = 'booking ' || new.status
       where booking_id = new.id and status = 'reserved';
    elsif new.status = 'noshow' then
      update locker_rentals set status = 'returned', returned_at = now(), returned_by = 'no-show'
       where booking_id = new.id and status = 'reserved';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public._lk_booking_follow() from public, anon, authenticated;

-- ── The review's lockers ────────────────────────────────────────────────────────────────────
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

-- ── Staff: a booking's locker, a walk-up's, a reservation edited ───────────────────────────
create or replace function public.staff_locker_reserve(p_booking_id text, p_period text, p_on_bill boolean)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; k text; d date; rid uuid;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into q from queue_entries where id = p_booking_id for update;
  if q.id is null then raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0002'; end if;
  if coalesce(q.status, '') not in ('waiting', 'waitlist', 'active') then raise exception 'LOCKER_NOT_OPEN: the booking is %', q.status using errcode = 'P0001'; end if;
  if p_on_bill and coalesce(q.paid, false) then raise exception 'BOOKING_PAID' using errcode = 'P0001'; end if;
  k := _lk_kind(q.session_id);
  if not _lk_period_ok(k, p_period) then raise exception 'LOCKER_NOT_OPEN: this session offers no such period' using errcode = 'P0001'; end if;
  select case when s.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date, 10)::date end into d
    from sessions s where s.id = q.session_id;
  if d is null then raise exception 'LOCKER_NOT_OPEN: the session has no date' using errcode = 'P0001'; end if;
  perform _lk_lock(d);
  if exists (select 1 from locker_rentals r where r.booking_id = q.id and r.status in ('reserved', 'in_use')) then
    raise exception 'LOCKER_HELD' using errcode = 'P0001';
  end if;
  if not _lk_room(d, p_period, 1) then raise exception 'LOCKERS_FULL' using errcode = 'P0001'; end if;
  insert into locker_rentals (day, period, booking_id, session_id, customer_id, name, price, on_bill, status, created_by)
  values (d, p_period, q.id, q.session_id, q.customer_id, left(q.name, 120), _lk_price(p_period), coalesce(p_on_bill, false), 'reserved', _lk_who())
  returning id into rid;
  -- a later evening (the rider is not at the desk): a free locker is held for them now (the user, 2026-11-10)
  if d > (now() at time zone 'Asia/Riyadh')::date then
    update locker_rentals set locker_id = _lk_free_unit(d, p_period, rid) where id = rid;
  end if;
  -- the booking's add-ons as the line now has them, for the desk to draw at once
  return jsonb_build_object('ok', true, 'id', rid, 'booking_id', q.id, 'addons', (select e.addons from queue_entries e where e.id = q.id),
                            'code', (select l.code from locker_rentals x join lockers l on l.id = x.locker_id where x.id = rid));
end $$;
revoke execute on function public.staff_locker_reserve(text, text, boolean) from public, anon;
grant execute on function public.staff_locker_reserve(text, text, boolean) to authenticated;

create or replace function public.staff_locker_walkup(p_customer text, p_name text, p_period text, p_day date)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare d date := coalesce(p_day, (now() at time zone 'Asia/Riyadh')::date); nm text; rid uuid;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_period not in ('early', 'late', 'both', 'pm') then raise exception 'LOCKER_NOT_OPEN: no such period' using errcode = 'P0001'; end if;
  nm := nullif(btrim(coalesce(p_name, '')), '');
  if p_customer is not null then
    select coalesce(nm, c.name) into nm from customers c where c.id = p_customer;
    if not found then raise exception 'NOT_FOUND: no such account' using errcode = 'P0002'; end if;
  end if;
  if nm is null then raise exception 'LOCKER_NO_NAME' using errcode = 'P0001'; end if;
  perform _lk_lock(d);
  if not _lk_room(d, p_period, 1) then raise exception 'LOCKERS_FULL' using errcode = 'P0001'; end if;
  insert into locker_rentals (day, period, customer_id, name, price, on_bill, status, created_by)
  values (d, p_period, p_customer, left(nm, 120), _lk_price(p_period), false, 'reserved', _lk_who())
  returning id into rid;
  -- a later evening (the renter is not at the desk): a free locker is held for them now (the user, 2026-11-10)
  if d > (now() at time zone 'Asia/Riyadh')::date then
    update locker_rentals set locker_id = _lk_free_unit(d, p_period, rid) where id = rid;
  end if;
  return jsonb_build_object('ok', true, 'id', rid, 'price', _lk_price(p_period),
                            'code', (select l.code from locker_rentals x join lockers l on l.id = x.locker_id where x.id = rid));
end $$;
revoke execute on function public.staff_locker_walkup(text, text, text, date) from public, anon;
grant execute on function public.staff_locker_walkup(text, text, text, date) to authenticated;

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

-- ── Cancel, with the money back or with no refund ──────────────────────────────────────────
drop function if exists public.staff_locker_cancel(uuid, text, boolean);
CREATE OR REPLACE FUNCTION public.staff_locker_cancel(p_rental uuid, p_reason text, p_undo boolean, p_no_refund boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r locker_rentals%rowtype; who text; keep boolean := false;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into r from locker_rentals where id = p_rental;
  if r.id is null then raise exception 'NOT_FOUND: no such rental' using errcode = 'P0002'; end if;
  perform _lk_lock(r.day);
  select * into r from locker_rentals where id = p_rental for update;
  if coalesce(p_undo, false) then
    if r.status <> 'returned' or r.locker_id is null then raise exception 'LOCKER_NOT_OPEN: nothing to undo' using errcode = 'P0001'; end if;
    select x.name into who from locker_rentals x
     where x.locker_id = r.locker_id and x.day = r.day and x.id <> r.id and x.status in ('reserved', 'in_use')
       and _lk_slots(x.period) && _lk_slots(r.period) limit 1;
    if found then raise exception 'LOCKER_TAKEN: the locker is with %', coalesce(who, '?') using errcode = 'P0001'; end if;
    /* the evening's places too: the one the hand-back gave up may have gone to someone else since; the
       rental is still 'returned', so _lk_room counts without it (bug hunt 2026-11-10, 20261110235000) */
    if not _lk_room(r.day, r.period, 1) then raise exception 'LOCKERS_FULL' using errcode = 'P0001'; end if;
    update locker_rentals set status = 'in_use', returned_at = null, returned_by = null where id = r.id;
    return jsonb_build_object('ok', true);
  end if;
  if r.status not in ('reserved', 'in_use', 'returned') then raise exception 'LOCKER_NOT_OPEN: already cancelled' using errcode = 'P0001'; end if;
  /* No refund (the user, 2026-11-10: "add the ability to cancel locker reservation with no refund"): the locker is freed,
     what was paid for it stays - its wallet or card receipt is not voided, its fee stays on a paid ride's bill (kept, which
     _lk_line counts), its till lines stay. Nothing paid yet: an ordinary cancel (the fee comes off; nothing is owed). */
  keep := coalesce(p_no_refund, false) and not r.house and _lk_paid(r.id) > 0;
  update locker_rentals set status = 'cancelled', cancelled_at = now(), cancelled_by = _lk_who(), kept = keep,
         cancel_reason = left(coalesce(nullif(btrim(p_reason), ''), 'staff') || case when keep then ' (no refund)' else '' end, 120)
   where id = r.id;
  if keep then
    -- a locker paid by card online: the refund owed that the cancel wrote (_pay_locker_follow, where online payments exist) is declined
    if to_regclass('public.payment_refunds') is not null then
      execute $q$update payment_refunds set status = 'declined', dest = 'none', by_name = left($2, 60), done_at = now()
                   where reason = $1 and status = 'due'$q$
        using 'locker ' || r.id::text, _lk_who();
    end if;
  else
    perform _lk_unpay(r.id, _lk_who());
  end if;
  if r.booking_id is null then return jsonb_build_object('ok', true, 'kept', keep); end if;
  return jsonb_build_object('ok', true, 'kept', keep, 'booking_id', r.booking_id, 'addons', (select e.addons from queue_entries e where e.id = r.booking_id));
end $function$;
revoke execute on function public.staff_locker_cancel(uuid, text, boolean, boolean) from public, anon;
grant execute on function public.staff_locker_cancel(uuid, text, boolean, boolean) to authenticated;

-- ── Reservations already held with no number ────────────────────────────────────────────────
-- From today on: the rider's own, and staff ones for a later evening. Oldest first, under each evening's lock.
do $fill$
declare fr record; today date := (now() at time zone 'Asia/Riyadh')::date;
begin
  for fr in select r.id, r.day, r.period from locker_rentals r
             where r.status = 'reserved' and r.locker_id is null and r.day >= today
               and (r.created_by in ('rider', 'page') or r.day > today)
             order by r.day, r.created_at loop
    perform _lk_lock(fr.day);
    update locker_rentals set locker_id = _lk_free_unit(fr.day, fr.period, fr.id) where id = fr.id;
  end loop;
end $fill$;

-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._lk_free_unit(date,text,uuid)', 'public._lk_line(text,text)', 'public._lk_booking_follow()',
                           'public.customer_locker_reserve(text,text,text[],text,text[])',
                           'public.staff_locker_reserve(text,text,boolean)', 'public.staff_locker_walkup(text,text,text,date)',
                           'public.staff_locker_edit(uuid,date,text,text,text,text,text,text)',
                           'public.staff_locker_cancel(uuid,text,boolean,boolean)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._lk_free_unit(date,text,uuid)', 'public._lk_line(text,text)', 'public._lk_booking_follow()'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  foreach f in array array['public.staff_locker_reserve(text,text,boolean)', 'public.staff_locker_walkup(text,text,text,date)',
                           'public.staff_locker_edit(uuid,date,text,text,text,text,text,text)',
                           'public.staff_locker_cancel(uuid,text,boolean,boolean)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception '% is not executable by staff', f; end if;
  end loop;
  if to_regprocedure('public.staff_locker_cancel(uuid,text,boolean)') is not null then
    raise exception 'the three-argument staff_locker_cancel is still there (a call would be ambiguous)';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111002000', 'locker_auto_no_refund')
on conflict (version) do nothing;

commit;
