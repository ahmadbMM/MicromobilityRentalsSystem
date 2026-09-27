-- ============================================================================
-- A ticketed event as a ride kind (2026-09-28): talks, classes, festivals - anything with seats,
-- a price and a rule about who may book, run through the same sessions, bookings, waitlist and
-- passes as a ride. ride_kind 'event' under event_kind 'community' (seats, no bikes, no approval,
-- no queue numbers shown), open_to_all per event (everyone, or community members), paid_ride when
-- it has a price.
--
--  1. sessions.description - what the event is (the card and the website show it).
--     sessions.price - the seat price in SAR; 0 or null with paid_ride false is a free event.
--  2. _fare_now: an event's seat costs its own price, not a bike fare (rebuilt from the live
--     definition; attributes kept: sql, STABLE, search_path public).
--  3. _group_ride_cap: an event takes up to five riders per booking (a party), other community
--     rides two as before (rebuilt from the live definition; SECURITY DEFINER kept).
--
-- Rollback: re-create _fare_now and _group_ride_cap from their previous migrations;
--   alter table public.sessions drop column if exists description, drop column if exists price;
-- Idempotent.
-- ============================================================================
alter table public.sessions add column if not exists description text;
alter table public.sessions add column if not exists price numeric;
alter table public.sessions drop constraint if exists sessions_price_range;
alter table public.sessions add constraint sessions_price_range check (price is null or (price >= 0 and price <= 5000));
alter table public.sessions drop constraint if exists sessions_description_len;
alter table public.sessions add constraint sessions_description_len check (description is null or length(description) <= 2000);

CREATE OR REPLACE FUNCTION public._fare_now(p_session_id text, p_entry_id text, p_type text)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case
    when coalesce(s.event_kind, '') = 'community' and not coalesce(s.paid_ride, false) then 0
    when coalesce(s.ride_kind, '') = 'event' then least(greatest(coalesce(s.price, 0), 0), 5000)
    else coalesce(_booking_fare(p_entry_id, coalesce(s.ride_kind, ''), p_type),
                  case when coalesce(p_type, '') = 'Own' then null
                       else (select max(price) from ride_prices) end)
  end
  from sessions s where s.id = p_session_id
$function$;

CREATE OR REPLACE FUNCTION public._group_ride_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _live int; _cap int;
begin
  if new.customer_id is null or (select is_staff()) then return new; end if;

  select case when coalesce(s.ride_kind, '') = 'event' then 5 else 2 end into _cap
    from sessions s
   where s.id = new.session_id
     and s.event_kind = 'community'
     and coalesce(s.needs_approval,false) = false;
  if _cap is null then return new; end if;

  select count(*) into _live
    from queue_entries q
   where q.session_id = new.session_id
     and q.customer_id = new.customer_id
     and coalesce(q.status,'') not in ('cancelled','removed','noshow')
     and q.id <> new.id;

  if _live >= _cap then
    raise exception 'Up to % riders per booking on this ride.', _cap using detail = 'GROUP_CAP';
  end if;

  return new;
end $function$;
