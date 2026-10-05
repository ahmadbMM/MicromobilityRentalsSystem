-- ============================================================================
-- Bookings: the 2026-10-05 audit, database half (the owner: "fix all but the ones you need a
-- decision from me"). Items numbered as in the audit's database list.
--
--  1. A capacity raise or a staff reopen now hands free places to the waitlist. A new trigger,
--     sessions_capacity_promote (AFTER UPDATE OF capacity, status on sessions), recounts the
--     night (_session_fill_recount) and, when it is open or full by the fill rule's own count
--     (auto_full), promotes waitlisters in their order (_promote_next_waitlist) while places
--     are free. A full a person set (Mark Full, auto_full false) stands and promotes nobody,
--     as do closed, deleted, past and approval nights. customer_create_booking sends a new
--     booker to the waitlist on sight only for a full a person set; on the fill rule's full it
--     books 'waiting' and lets _capacity_guard count the places (a stale auto 'full' no longer
--     waitlists people into free places). _session_has_room reads 'full' the same way.
--  4. Waiver versions are checked, not only shaped: _waiver_min(kind) holds the current
--     minimum of each waiver ('ride' 2026-10-v3, 'swim' swim-2026-10-v3, 'activity'
--     activity-2026-10-v2: the booking app's WAIVER_VERSION / SWIM_WAIVER_VERSION /
--     ACTIVITY_WAIVER_VERSION and the website's WAIVER_VERSIONS, checked 2026-10-05), and
--     _waiver_outdated(version) is true for a version older than the minimum of its own kind,
--     which its prefix names (none = ride, swim-, activity-, and workshop- from before the
--     activity waiver). customer_create_booking raises WAIVER_OUTDATED (P0001) for one; an
--     unknown prefix, an unparseable or a newer version passes, so a later bump never breaks
--     booking. Both clients map a session to its waiver exactly alike (bike ride -> ride, the
--     pool -> swim, the workshop and events -> activity), so the version a booking carries is
--     always of its session's kind. rider_register gets the same check in 20261005210200.
--  5. customer_booking_update refuses to move a PAID booking to a ride whose fare (for its
--     type) differs from the fare of the ride it is on: raise PAID_MOVE (P0001). A house or VIP
--     row (paid at 0, no code) the account's rule still covers moves as before.
--     _enforce_booking_price no longer writes 0 over the price of a paid row on a free ride.
--  6. One price ceiling: a booking may be priced up to 5000 like an event seat (sessions.price
--     and _fare_now allow 5000). queue_entries_price_sane, _enforce_booking_price,
--     staff_checkin and staff_set_price go from 1000 to 5000.
--  7. The JCC rule (three riders per account per ride, the booking app's JCC_ACCOUNT_CAP) holds
--     on the server: _group_ride_cap caps every non-community ride at three live rows
--     (waiting, on the bike, waitlisted - as the app counts) per account for customer bookings;
--     the National Day ride counts as JCC, as in the app. customer_booking_update's restore of a
--     cancelled booking counts the same three.
--  8. On an approval ride (needs_approval) a customer's booking is stamped registered_at = now():
--     the Saturday roster is ordered by it and a page could send any time it liked. Other rides
--     keep the time the page sends (outbox replays), as validated before.
-- 10. A rider on their own bike takes no place except on the Petromin ride, so a full night
--     no longer waitlists them: customer_create_booking books an Own rider 'waiting' on any
--     full non-Petromin ride (approval rides still mark them pending), and _session_has_room
--     answers for Own before it looks at 'full'.
-- 11. A row that (re)joins the waitlist from another status by a customer's or the system's
--     write gets a new number at the end (_wl_num_assign): cancel-and-restore no longer jumps
--     the queue. Staff writes keep the number they send (Undo of a cancel, parking a request).
-- 13. A free row spends no promo code: the free community ride (_enforce_booking_price), the
--     house row (_apply_default_pay, and customer_create_booking's first rider) drop the code,
--     and customer_booking_update takes no new code on a paid row - so _promo_count never counts
--     a discount nobody got.
-- 14. One house row per account per ride: _apply_default_pay (and customer_create_booking's
--     first rider) frees a row in the holder's own name only when the account has no live free
--     row in its own name on that ride (_house_taken). customer_booking_update treats a VIP
--     (_is_vip) as house when a type change would otherwise unpay the row.
-- 15. customer_booking_update leaves a staff cancel's reason and note alone (a customer patch
--     carrying status 'cancelled' wiped them).
-- 16. _addons_price_snapshot keeps an add-on line's sold price only while its quantity is not
--     above what was bought at that price; more of a line is priced afresh, the whole line at
--     today's inventory price (the simplest correct choice: one price per line, as the page and
--     the reports read it).
-- 30. customer_waitlist_ranks(p_id, p_token) -> rows (entry_id, rank): each of the caller's live
--     waitlist bookings (ride today or later) with its place in the session's line, 1 = next,
--     in the order _promote_next_waitlist promotes (waitlist number, then registered_at; an Own
--     rider is not in the line on a non-Petromin ride and gets no row). Token-checked; anon and
--     authenticated.
-- 31. promo_codes gets a unique index on lower(code) (no duplicates on 2026-10-05; codes are
--     looked up by lower(code) everywhere, a duplicate would be ambiguous). Skipped with a
--     notice if duplicates exist when this runs.
-- Data counts relied on (2026-10-05): no Own rider waitlisted anywhere, no account with two free
-- rows in its own name on one ride, no stale auto full on a ride ahead, one promo code.
--
-- Patched in place from the live definitions (pg_get_functiondef keeps SECURITY DEFINER, the
-- search_path and the grants; each anchor must match exactly once or nothing is changed):
-- customer_create_booking, customer_booking_update, staff_checkin. Rewritten whole, headers as
-- live: _enforce_booking_price, _apply_default_pay, _group_ride_cap, _addons_price_snapshot,
-- _session_has_room, _wl_num_assign, staff_set_price.
--
-- Rollback (in this order):
--   drop trigger if exists sessions_capacity_promote on public.sessions;
--   drop function if exists public._session_capacity_promote(), public.customer_waitlist_ranks(text, text);
--   drop index if exists public.promo_codes_code_lower_uniq;
--   re-run the previous definitions (20261004120000 for _addons_price_snapshot, 20261004100000 for
--   _group_ride_cap, 20260922122000 for _session_has_room, the rest from pg_get_functiondef as saved
--   before applying) and put queue_entries_price_sane back to 1000 (only if no price is above it);
--   then drop function public._waiver_outdated(text), public._waiver_min(text), public._house_taken(text, text, text).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


-- ── 4. the current minimum of each waiver ─────────────────────────────────────────────────────
-- Raise a minimum only after the clients carry the new version (see AGENTS.md, "Waiver versions").
create or replace function public._waiver_min(p_kind text)
returns text
language sql stable set search_path to 'public'
as $$
  select case p_kind
           when 'ride'     then '2026-10-v3'
           when 'swim'     then 'swim-2026-10-v3'
           when 'activity' then 'activity-2026-10-v2'
         end
$$;
revoke all on function public._waiver_min(text) from public, anon, authenticated;

-- [prefix-]YYYY-MM-vN, compared with the minimum of the kind its prefix names.
create or replace function public._waiver_outdated(p_version text)
returns boolean
language plpgsql stable set search_path to 'public'
as $$
declare v text[]; m text[]; k text;
begin
  v := regexp_match(coalesce(p_version, ''), '^(?:([a-z]+)-)?([0-9]{4})-([0-9]{2})-v([0-9]{1,6})$');
  if v is null then return false; end if;                  -- not a version this rule knows: never refused
  k := case coalesce(v[1], '') when '' then 'ride' when 'swim' then 'swim'
            when 'activity' then 'activity' when 'workshop' then 'activity' end;
  if k is null then return false; end if;                  -- a kind added later
  m := regexp_match(coalesce(_waiver_min(k), ''), '^(?:([a-z]+)-)?([0-9]{4})-([0-9]{2})-v([0-9]{1,6})$');
  if m is null then return false; end if;
  return (v[2]::int, v[3]::int, v[4]::int) < (m[2]::int, m[3]::int, m[4]::int);
end $$;
revoke all on function public._waiver_outdated(text) from public, anon, authenticated;


-- ── 14. the account's free row on a ride ──────────────────────────────────────────────────────
-- A live row of the account on the ride, paid at 0, in the account holder's own name.
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
       and lower(btrim(coalesce(q.name, ''))) = lower(btrim(coalesce(c.name, ''))))
$$;
revoke all on function public._house_taken(text, text, text) from public, anon, authenticated;


-- ── 1. a capacity raise or a reopen promotes the waitlist ─────────────────────────────────────
create or replace function public._session_capacity_promote()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare st text; af boolean; n int := 0;
begin
  -- Staff pick the riders of an approval ride by hand; a ride already past is left as it was.
  if coalesce(new.needs_approval, false)
     or coalesce(new.session_date, '') < to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD') then
    return null;
  end if;
  perform _session_fill_recount(new.id);
  select s.status, s.auto_full into st, af from sessions s where s.id = new.id;
  -- Open, or full by the fill rule's own count: the free places go to the waitlist in its
  -- order. A full a person set (Mark Full), a closed and a deleted night promote nobody.
  if st = 'open' or (st = 'full' and coalesce(af, false)) then
    while n < 500 and _promote_next_waitlist(new.id) is not null loop
      n := n + 1;
    end loop;
  end if;
  return null;
end $$;
revoke all on function public._session_capacity_promote() from public, anon, authenticated;

drop trigger if exists sessions_capacity_promote on public.sessions;
create trigger sessions_capacity_promote
  after update of capacity, status on public.sessions
  for each row
  when (new.capacity is distinct from old.capacity or new.status is distinct from old.status)
  execute function public._session_capacity_promote();


-- ── 1 + 10. _session_has_room: an own bike first, then only a full a person set ───────────────
CREATE OR REPLACE FUNCTION public._session_has_room(p_session_id text, p_type text, p_exclude text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare s sessions%rowtype; _own boolean; _live int;
begin
  select * into s from sessions where id = p_session_id for update;
  if not found then return false; end if;
  _own := coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin';
  -- An own bike takes no place (but on the Petromin ride), full night or not (20261005210000).
  if coalesce(p_type, '') = 'Own' and not _own then return true; end if;
  -- A full a person set (Mark Full) has no room; the fill rule's own full is counted below.
  if coalesce(s.status, '') = 'full' and (coalesce(s.needs_approval, false) or not coalesce(s.auto_full, false)) then
    return false;
  end if;
  if coalesce(s.needs_approval, false) then return true; end if;   -- staff pick those riders by hand
  perform pg_advisory_xact_lock(hashtext('cap:' || p_session_id));
  select count(*) into _live from queue_entries q
   where q.session_id = p_session_id and q.id is distinct from p_exclude
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
     and (_own or coalesce(q.type_preference, '') <> 'Own');
  return _live < coalesce(s.capacity, 12);
end $function$;
revoke all on function public._session_has_room(text, text, text) from public, anon, authenticated;


-- ── 11. a row (re)joining the waitlist goes to its end ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._wl_num_assign()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.status='waitlist' then
    -- From another status, by a customer or the system: a new number at the end, so a cancel
    -- and restore never gets its old place back. Staff send the number they mean (Undo of a
    -- cancel, parking a request) and keep it (20261005210000).
    if tg_op = 'UPDATE' and old.status is distinct from 'waitlist' and not is_staff() then
      new.waitlist_num := null;
    end if;
    perform pg_advisory_xact_lock(hashtext('wlnum:'||new.session_id));
    if new.waitlist_num is null or exists(
      select 1 from queue_entries q
      where q.session_id=new.session_id and q.status='waitlist'
        and q.waitlist_num=new.waitlist_num and q.id is distinct from new.id) then
      select coalesce(max(waitlist_num),0)+1 into new.waitlist_num
      from queue_entries where session_id=new.session_id;
    end if;
  end if;
  return new;
end$function$;


-- ── 5 + 6 + 13. _enforce_booking_price ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._enforce_booking_price()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare canonical numeric; _kind text; _paid boolean; _ride_kind text;
        _c promo_codes%rowtype; _fresh boolean; _base numeric; _old_c numeric;
begin
  select coalesce(s.event_kind, ''), coalesce(s.paid_ride, false), coalesce(s.ride_kind, '')
    into _kind, _paid, _ride_kind
    from sessions s where s.id = new.session_id;
  if _kind = 'community' and not _paid then
    -- A free ride. A row already paid keeps what was paid (it moved here, or staff took money):
    -- never 0 over a payment. A code spends nothing here, so a new one is dropped (20261005210000).
    if not coalesce(new.paid, false) or new.price is null then new.price := 0; end if;
    if coalesce(new.promo_code, '') <> ''
       and (tg_op = 'INSERT' or new.promo_code is distinct from old.promo_code) then
      new.promo_code := null;
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and (select is_staff()) then return new; end if;
  if new.assigned_bike_id is null
     and coalesce(new.paid, false) = false
     and coalesce(new.status, 'waiting') in ('waiting', 'waitlist') then
    if tg_op = 'UPDATE'
       and new.session_id is not distinct from old.session_id
       and new.type_preference is not distinct from old.type_preference
       and lower(coalesce(new.promo_code, '')) = lower(coalesce(old.promo_code, ''))
       and not (coalesce(old.paid, false) and not coalesce(new.paid, false))
       and not (coalesce(old.status, '') in ('cancelled', 'removed') and coalesce(new.promo_code, '') <> '') then
      new.price := least(greatest(coalesce(new.price, 0), 0), 5000);
      return new;
    end if;
    canonical := _fare_now(new.session_id, new.id, new.type_preference);
    if canonical is null and coalesce(new.type_preference, '') <> 'Own' then
      select max(price) into canonical from ride_prices;
    end if;
    if canonical is null then
      if coalesce(new.promo_code, '') <> '' then new.promo_code := null; end if;
      new.price := case when (select is_staff()) then least(greatest(coalesce(new.price, 0), 0), 5000) else 0 end;
      return new;
    end if;
    if coalesce(new.promo_code, '') = '' then
      new.price := canonical;
    else
      _fresh := tg_op = 'INSERT' or lower(coalesce(old.promo_code, '')) <> lower(new.promo_code)
                or coalesce(old.status, '') in ('cancelled', 'removed');
      if _fresh then
        select * into _c from promo_codes c
         where lower(c.code) = lower(new.promo_code)
           and c.active = true
           and (c.expires_at  is null or c.expires_at >= (now() at time zone 'Asia/Riyadh')::date)
           and (c.max_uses    is null or coalesce(c.uses, 0) < c.max_uses)
           and (c.customer_id is null or c.customer_id = new.customer_id)
         order by c.id limit 1
         for update;
      else
        select * into _c from promo_codes c where lower(c.code) = lower(new.promo_code) order by c.id limit 1;
      end if;
      if _c.id is null or (_c.applies_to is not null and _c.applies_to is distinct from new.type_preference) then
        new.promo_code := null;
        new.price := canonical;
      elsif _c.kind = 'flat' and _c.applies_to is null then
        if not _fresh then
          _old_c := _fare_now(old.session_id, old.id, old.type_preference);
          new.price := case when coalesce(_old_c, 0) > 0
                            then least(canonical, greatest(round(coalesce(old.price, _old_c) * canonical / _old_c, 2),
                                                           canonical - greatest(coalesce(_c.value, 0), 0)))
                            else canonical end;
        else
          _base := null;
          if tg_op = 'INSERT' and lower(coalesce(current_setting('mm.promo_code', true), '')) = lower(new.promo_code) then
            _base := nullif(current_setting('mm.promo_base', true), '')::numeric;
          end if;
          if _base is null then
            _base := canonical + coalesce((
              select sum(coalesce(_fare_now(q.session_id, q.id, q.type_preference), 0))
                from queue_entries q
               where new.customer_id is not null and q.customer_id = new.customer_id
                 and q.session_id = new.session_id and q.id <> new.id
                 and coalesce(q.status, '') in ('waiting', 'waitlist', 'active')
                 and not coalesce(q.paid, false)), 0);
          end if;
          new.price := _promo_fare(_c, new.type_preference, canonical, _base);
        end if;
      else
        new.price := _promo_fare(_c, new.type_preference, canonical, canonical);
      end if;
    end if;
  end if;
  new.price := least(greatest(coalesce(new.price, 0), 0), 5000);   -- the event seat's ceiling (20261005210000)
  return new;
end $function$;


-- ── 13 + 14. _apply_default_pay: one free row per ride, and it spends no code ──────────────────
CREATE OR REPLACE FUNCTION public._apply_default_pay()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _dp text; _nm text; _house text;
begin
  if new.customer_id is null or coalesce(new.paid, false)
     or coalesce(new.status, '') in ('cancelled', 'removed') then
    return new;
  end if;
  select c.default_pay, c.name into _dp, _nm from customers c where c.id = new.customer_id;
  if _is_vip(new.customer_id) then
    _house := 'all';                                   -- VIP: every type, whatever default_pay says
  elsif coalesce(_dp, '') like 'house%' then
    _house := case when _dp = 'house' then 'all' else substring(_dp from 7) end;
  else
    return new;
  end if;
  if lower(btrim(coalesce(new.name, ''))) = lower(btrim(coalesce(_nm, '')))
     and (_house = 'all' or coalesce(nullif(new.type_preference, ''), 'Any') = any(string_to_array(_house, ',')))
     -- The holder rides once: one free row in their own name per ride (20261005210000).
     and not _house_taken(new.customer_id, new.session_id, new.id) then
    new.paid := true;
    new.price := 0;
    new.promo_code := null;   -- a free row spends no code (20261005210000)
  end if;
  return new;
end $function$;


-- ── 7. _group_ride_cap: three per account on every non-community ride ─────────────────────────
CREATE OR REPLACE FUNCTION public._group_ride_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _live int; _cap int; _jcc boolean;
begin
  if new.customer_id is null or (select is_staff()) then return new; end if;

  -- A community ride: five per booker on an event, two on the others (an approval ride is
  -- _solo_ride_cap's). Every other ride - the circuit, the National Day ride - three per
  -- account, the booking app's JCC_ACCOUNT_CAP (20261005210000).
  select case when coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') <> 'snd96'
              then case when coalesce(s.needs_approval, false) then null
                        when coalesce(s.ride_kind, '') = 'event' then 5 else 2 end
              else 3 end,
         not (coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') <> 'snd96')
    into _cap, _jcc
    from sessions s
   where s.id = new.session_id;
  if _cap is null then return new; end if;

  -- Two bookings sent at once by one account take turns (20261004100000).
  perform pg_advisory_xact_lock(hashtext('ridecap:' || coalesce(new.session_id, '') || ':' || new.customer_id));
  select count(*) into _live
    from queue_entries q
   where q.session_id = new.session_id
     and q.customer_id = new.customer_id
     and q.id <> new.id
     and case when _jcc then coalesce(q.status, '') in ('waiting', 'active', 'waitlist')   -- as the app counts
              else coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow') end;

  if _live >= _cap then
    raise exception 'Up to % riders per booking on this ride.', _cap using detail = 'GROUP_CAP';
  end if;

  return new;
end $function$;


-- ── 16. _addons_price_snapshot: more of a line is priced afresh ───────────────────────────────
CREATE OR REPLACE FUNCTION public._addons_price_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare j jsonb; old_j jsonb := '[]'::jsonb; x jsonb; o jsonb; outv jsonb := '[]'::jsonb;
        v_id text; pr numeric; changed boolean := false; staff boolean;
begin
  if new.addons is null or btrim(new.addons) in ('', '[]') then return new; end if;
  begin j := new.addons::jsonb; exception when others then return new; end; -- the CHECK refuses it
  if jsonb_typeof(j) <> 'array' then return new; end if;
  staff := (select is_staff());
  if tg_op = 'UPDATE' and old.addons is not null and btrim(old.addons) <> '' then
    begin old_j := old.addons::jsonb; exception when others then old_j := '[]'::jsonb; end;
    if jsonb_typeof(old_j) <> 'array' then old_j := '[]'::jsonb; end if;
  end if;
  for x in select value from jsonb_array_elements(j) loop
    if jsonb_typeof(x) = 'string' then
      o := jsonb_build_object('id', x #>> '{}', 'qty', 1); changed := true;
    elsif jsonb_typeof(x) = 'object' then
      o := x;
    else
      outv := outv || jsonb_build_array(x); continue;
    end if;
    v_id := o ->> 'id';
    if o ? 'p' then
      if jsonb_typeof(o -> 'p') <> 'number' then
        o := o - 'p'; changed := true;
      elsif not staff and not exists (
          select 1 from jsonb_array_elements(old_j) y
           where jsonb_typeof(y) = 'object' and y ->> 'id' = v_id and y -> 'p' = o -> 'p'
             -- Only as many as were bought at that price keep it: a line that grew is priced
             -- afresh, all of it at today's price (one price per line; 20261005210000).
             and (case when (o ->> 'qty') ~ '^[0-9]{1,3}$' then greatest((o ->> 'qty')::int, 1) else 1 end)
              <= (case when (y ->> 'qty') ~ '^[0-9]{1,3}$' then greatest((y ->> 'qty')::int, 1) else 1 end)) then
        o := o - 'p'; changed := true; -- a customer's page never prices its own add-on
      end if;
    end if;
    if not (o ? 'p') then
      pr := null;
      select i.price into pr from inventory i where i.id = v_id;
      if pr is not null then o := o || jsonb_build_object('p', pr); changed := true; end if;
    end if;
    outv := outv || jsonb_build_array(o);
  end loop;
  if changed then new.addons := outv::text; end if;
  return new;
end $function$;


-- ── 6. staff_set_price and the table's own ceiling ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.staff_set_price(p_booking_id text, p_price numeric, p_op text, p_approval text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  q queue_entries%rowtype; np numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if p_price is null or p_price < 0 or p_price > 5000 then raise exception 'PRICE_RANGE' using errcode = '22023'; end if;
  select * into q from queue_entries where id = p_booking_id for update;
  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  update queue_entries set price = p_price where id = p_booking_id returning price into np;
  return jsonb_build_object('ok', true, 'id', p_booking_id, 'old_price', q.price, 'price', np);
end $function$;

alter table public.queue_entries drop constraint if exists queue_entries_price_sane;
alter table public.queue_entries add constraint queue_entries_price_sane
  check (price is null or (price >= 0 and price <= 5000));


-- ── 1 + 4 + 8 + 10 + 13 + 14. customer_create_booking (patched from its live definition) ──────
do $ccb$
declare d text;
begin
  d := pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure);
  if position('(20261005210000)' in d) > 0 then
    raise notice 'customer_create_booking already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  _ids text[] := '{}';
begin
$a$,
$b$  _ids text[] := '{}'; _petro boolean;
begin
$b$);
  d := pg_temp._once(d,
$a$  _status := case when coalesce(s.status,'') = 'full' then 'waitlist' else 'waiting' end;
$a$,
$b$  -- Only a full a person set (Mark Full) waitlists a new booker on sight; the fill rule's own
  -- full is left to _capacity_guard, which counts the places (20261005210000).
  _status := case when coalesce(s.status,'') = 'full' and (_appr or not coalesce(s.auto_full, false))
                  then 'waitlist' else 'waiting' end;
  _petro := coalesce(s.event_kind,'') = 'community' and coalesce(s.ride_kind,'') = 'petromin';
$b$);
  d := pg_temp._once(d,
$a$      raise exception 'WAIVER_REQUIRED' using errcode = 'P0001';   -- every booking needs an agreed waiver (20261003210000)
    end if;
$a$,
$b$      raise exception 'WAIVER_REQUIRED' using errcode = 'P0001';   -- every booking needs an agreed waiver (20261003210000)
    end if;
    if _waiver_outdated(it->>'waiver_version') then
      raise exception 'WAIVER_OUTDATED' using errcode = 'P0001';   -- a superseded waiver (20261005210000)
    end if;
$b$);
  d := pg_temp._once(d,
$a$       and (_house = 'all' or _type = any(string_to_array(_house, ','))) then
      _house_first := true;
$a$,
$b$       and (_house = 'all' or _type = any(string_to_array(_house, ',')))
       and not _house_taken(p_id, _sid, null) then   -- one free row per ride (20261005210000)
      _house_first := true;
$b$);
  d := pg_temp._once(d,
$a$    _reg := it->>'registered_at';
$a$,
$b$    -- An approval ride's roster runs by the server's clock, not the page's (20261005210000).
    _reg := case when _appr then null else it->>'registered_at' end;
$b$);
  d := pg_temp._once(d,
$a$    if _rc is not null and _rc !~ '^[A-Za-z0-9_-]{1,40}$' then _rc := null; end if;
$a$,
$b$    if _rc is not null and _rc !~ '^[A-Za-z0-9_-]{1,40}$' then _rc := null; end if;
    if _paid then _rc := null; end if;   -- the free first rider spends no code (20261005210000)
$b$);
  d := pg_temp._once(d,
$a$      _status,
      _paid,
$a$,
$b$      case when _type = 'Own' and not _petro then 'waiting' else _status end,   -- an own bike takes no place (20261005210000)
      _paid,
$b$);
  execute d;
end $ccb$;


-- ── 5 + 7 + 13 + 14 + 15. customer_booking_update (patched from its live definition) ──────────
do $cbu$
declare d text;
begin
  d := pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure);
  if position('(20261005210000)' in d) > 0 then
    raise notice 'customer_booking_update already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$                        when coalesce(_at.ride_kind,'') = 'event' then 5 else 2 end) then return false; end if;
    end if;
$a$,
$b$                        when coalesce(_at.ride_kind,'') = 'event' then 5 else 2 end) then return false; end if;
    else
      -- Every other ride: three per account, as _group_ride_cap counts them (20261005210000).
      select count(*) into _live from queue_entries x
       where x.session_id = q.session_id and x.customer_id = p_id and x.id <> q.id
         and coalesce(x.status,'') in ('waiting','active','waitlist');
      if _live >= 3 then return false; end if;
    end if;
$b$);
  d := pg_temp._once(d,
$a$      if _code is null or _code !~ '^[A-Za-z0-9_-]{1,40}$' or coalesce(q.promo_code,'') <> '' then _code := null; end if;
$a$,
$b$      -- A paid row takes no new code: there is nothing left to discount (20261005210000).
      if _code is null or _code !~ '^[A-Za-z0-9_-]{1,40}$' or coalesce(q.promo_code,'') <> '' or q.paid then _code := null; end if;
$b$);
  d := pg_temp._once(d,
$a$        _house := case when _dp = 'house' then 'all' when _dp like 'house:%' then substring(_dp from 7) end;
$a$,
$b$        _house := case when _is_vip(p_id) then 'all'   -- a VIP rides free on every type (20261005210000)
                       when _dp = 'house' then 'all' when _dp like 'house:%' then substring(_dp from 7) end;
$b$);
  d := pg_temp._once(d,
$a$  _cancelling := coalesce(_p->>'status','') = 'cancelled'
$a$,
$b$  -- A paid booking keeps what it paid: it moves only to a ride with the same fare for its type.
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
$b$);
  d := pg_temp._once(d,
$a$    cancel_reason    = case
                         when _cancelling then
$a$,
$b$    cancel_reason    = case
                         when q.status = 'cancelled' and coalesce(q.cancelled_by,'') <> 'customer' then x.cancel_reason   -- staff's stays (20261005210000)
                         when _cancelling then
$b$);
  d := pg_temp._once(d,
$a$    cancel_note      = case
                         when _cancelling then
$a$,
$b$    cancel_note      = case
                         when q.status = 'cancelled' and coalesce(q.cancelled_by,'') <> 'customer' then x.cancel_note
                         when _cancelling then
$b$);
  execute d;
end $cbu$;


-- ── 6. staff_checkin: the same ceiling (patched from its live definition) ─────────────────────
do $sci$
declare d text;
begin
  d := pg_get_functiondef('public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text)'::regprocedure);
  if position('(20261005210000)' in d) > 0 then
    raise notice 'staff_checkin already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  if p_price is not null and (p_price < 0 or p_price > 1000) then raise exception 'PRICE_RANGE' using errcode = '22023'; end if;
$a$,
$b$  if p_price is not null and (p_price < 0 or p_price > 5000) then raise exception 'PRICE_RANGE' using errcode = '22023'; end if;   -- the event seat's ceiling (20261005210000)
$b$);
  execute d;
end $sci$;


-- ── 30. customer_waitlist_ranks ───────────────────────────────────────────────────────────────
-- The caller's live waitlist bookings with their place in line, in the order
-- _promote_next_waitlist takes them: the waitlist number, then registered_at (then the id, so
-- two equal rows keep one order). An Own rider on a non-Petromin ride is not in that line.
create or replace function public.customer_waitlist_ranks(p_id text, p_token text)
returns table(entry_id text, rank integer)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not _cust_token_ok(p_id, p_token) then return; end if;
  return query
  with mine as (
    select q.id, q.session_id from queue_entries q
     where q.customer_id = p_id and q.status = 'waitlist'
       and coalesce(q.session_date, '') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD')),
  line as (
    select q.id,
           row_number() over (partition by q.session_id
                              order by coalesce(q.waitlist_num, 2147483647), q.registered_at, q.id) as rn
      from queue_entries q join sessions s on s.id = q.session_id
     where q.session_id in (select m.session_id from mine m) and q.status = 'waitlist'
       and ((coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin')
            or coalesce(q.type_preference, '') <> 'Own'))
  select l.id, l.rn::integer from line l where l.id in (select m.id from mine m);
end $$;
revoke all on function public.customer_waitlist_ranks(text, text) from public;
grant execute on function public.customer_waitlist_ranks(text, text) to anon, authenticated;


-- ── 31. one promo code per spelling ───────────────────────────────────────────────────────────
do $promo$
begin
  if exists (select 1 from promo_codes group by lower(code) having count(*) > 1) then
    raise notice 'promo_codes holds duplicate codes: the unique index is skipped, resolve them first';
  else
    create unique index if not exists promo_codes_code_lower_uniq on public.promo_codes (lower(code));
  end if;
end $promo$;


-- ── checks ────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  -- definer where it was, and where it must be
  foreach f in array array['customer_create_booking','customer_booking_update','staff_checkin','staff_set_price',
                           '_enforce_booking_price','_apply_default_pay','_group_ride_cap','_addons_price_snapshot',
                           '_session_capacity_promote','customer_waitlist_ranks'] loop
    if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and not p.prosecdef)
       or not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f) then
      raise exception '% is missing or lost SECURITY DEFINER', f;
    end if;
  end loop;
  foreach f in array array['_session_has_room','_wl_num_assign','_waiver_min','_waiver_outdated','_house_taken'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and not p.prosecdef) then
      raise exception '% is missing or SECURITY DEFINER', f;
    end if;
  end loop;
  -- every function rewritten or patched keeps its search_path
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
               and p.proname in ('customer_create_booking','customer_booking_update','staff_checkin','staff_set_price',
                                 '_enforce_booking_price','_apply_default_pay','_group_ride_cap','_addons_price_snapshot',
                                 '_session_capacity_promote','customer_waitlist_ranks','_session_has_room','_wl_num_assign',
                                 '_waiver_min','_waiver_outdated','_house_taken')
               and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'a function lost its search_path';
  end if;
  -- the patches took
  if position('(20261005210000)' in pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure)) = 0
     or position('(20261005210000)' in pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure)) = 0
     or position('(20261005210000)' in pg_get_functiondef('public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text)'::regprocedure)) = 0 then
    raise exception 'a patch did not take';
  end if;
  -- the callers kept their grants; the helpers are no client's
  if not has_function_privilege('anon', 'public.customer_create_booking(text,text,jsonb)', 'execute')
     or not has_function_privilege('anon', 'public.customer_booking_update(text,text,text,jsonb)', 'execute')
     or not has_function_privilege('anon', 'public.customer_waitlist_ranks(text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.customer_waitlist_ranks(text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_set_price(text,numeric,text,text)', 'execute') then
    raise exception 'a client grant is missing';
  end if;
  if has_function_privilege('anon', 'public._waiver_min(text)', 'execute')
     or has_function_privilege('anon', 'public._waiver_outdated(text)', 'execute')
     or has_function_privilege('anon', 'public._house_taken(text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public._session_capacity_promote()', 'execute') then
    raise exception 'an internal helper is executable by a client';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'sessions_capacity_promote'
                   and tgrelid = 'public.sessions'::regclass and not tgisinternal) then
    raise exception 'sessions_capacity_promote is missing';
  end if;
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'queue_entries_price_sane'
                             and conrelid = 'public.queue_entries'::regclass)) not like '%5000%' then
    raise exception 'queue_entries_price_sane is not at 5000';
  end if;
  -- the waiver rule as the clients use it today
  if _waiver_outdated('2026-10-v3') or _waiver_outdated('swim-2026-10-v3') or _waiver_outdated('activity-2026-10-v2')
     or _waiver_outdated('2026-11-v4') or _waiver_outdated('something-else')
     or not _waiver_outdated('2026-10-v2') or not _waiver_outdated('swim-2026-08-v1')
     or not _waiver_outdated('workshop-2026-09-v1') or not _waiver_outdated('activity-2026-10-v1') then
    raise exception '_waiver_outdated does not answer as expected';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'promo_codes_code_lower_uniq')
     and not exists (select 1 from promo_codes group by lower(code) having count(*) > 1) then
    raise exception 'promo_codes_code_lower_uniq is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261005210000', 'audit_bookings')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
