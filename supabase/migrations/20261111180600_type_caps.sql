-- ============================================================================
-- 20261111180600_type_caps
--
-- Each bike type is capped on its own (the owner, 2026-11-11: "do it all"; staff round s10, second batch, "caps").
--
-- Before this file the database held every booking to the session's places (_capacity_guard) and a type to its own
-- count in bike_slots ONLY while bikes of that type were out of service (_out_bikes_guard, _out_bikes_room). So
-- "Road 0 left" on the desk could still be booked online while the session had room. Now:
--
-- 1. _type_places(session, type) (new): the places a type has where the session counts them by type: bike_slots gives
--    it a number, a number per size (summed), or the fleet picked (_bikes) holds bikes of it. Null where the session
--    counts its bikes as a total only (every session made since August), so those sessions are unchanged.
-- 2. _out_bikes_room (replaced from its live text): the type's own places, less its bikes out, are counted with no bike
--    out too. Every caller follows: _session_has_room (a rider taking back a cancelled booking goes to the waitlist,
--    an own bike switched to one of ours is refused), customer_claim_spot, and, with their "bikes out" gate opened
--    below, _promote_next_waitlist, _wl_offer_fill and staff_offer_spot: a waitlisted rider of a full type is not
--    moved up (the next one of another type is). A type given no places and none out is not counted, as the desk's
--    figure has it.
-- 3. _type_full_guard (new) + trigger trg_type_full_guard (BEFORE INSERT OR UPDATE OF type_preference, session_id on
--    queue_entries): a booking that takes a place (waiting, or on a bike) of a type whose places are all taken -
--    bookings of the type that are not cancelled, removed or a no-show, the waitlist too (the desk's "places left"
--    figure, _n6rTypePlaces / _n6rHeld) - is refused with TYPE_FULL (detail: the type; hint: "taken/places").
--      - Riders: always refused, on a new booking, a move to another session and a change of type. A rider who has no
--        other type to pick on that ride (every type they are offered is full, closed or hidden from them;
--        _type_room_else) joins the waitlist instead on a new booking or a move, as on a full night: the app shows
--        that ride as its waitlist. A booking on the waitlist takes no place and passes, so the waitlist works as
--        before.
--      - Staff: refused too, unless they said Add anyway: the request header `x-mm-type-cap: ok` on the desk's insert,
--        or mm.type_cap_ok = '1' set by a staff function. The desk logs the override (History > Log). A staff change
--        of type or session on an existing booking passes (the bike handed over at the booth).
--      - Never an approval ride (staff pick its riders), an own bike, 'Any', or a session that does not count the type.
--    Named trg_type_f... so it fires after the triggers that rewrite the type (queue_entries_comm_no_carbon,
--    queue_entries_vip_no_carbon), after _capacity_guard and _out_bikes_guard set the waitlist, after
--    trg_type_closed_guard (a closed type says TYPE_CLOSED first), and before wl_num_assign_ins numbers the waitlist.
-- 4. _out_bikes_guard (replaced from its live text): keeps the session's places less the bikes out (the waitlist);
--    its per-type half moved into _type_full_guard, so a type full with or without bikes out answers the same.
--
-- Not changed: _capacity_guard, customer_create_booking (a rider who asked for a place and lands on the waitlist this
-- way is asked first with PLACE_GONE, 20261111050000), customer_booking_update, _session_has_room, customer_claim_spot
-- (they call _out_bikes_room). Claim mode (_wl_offer_fill) may offer two places of one type in a pass, as it may with
-- bikes out: the second claim is answered FULL.
--
-- Safe before or after the app: the app reads TYPE_FULL when it comes and sends the header only on Add anyway; until
-- this is applied a full type is still taken by the database (the app's picker already says Full).
-- Rollback: re-run the four replaced functions from 20261110235000_bh10_live_a.sql (_out_bikes_room,
--   _promote_next_waitlist, _wl_offer_fill), 20261110235300_bh10_live_c.sql (staff_offer_spot) and
--   20261107111000_sessions_review2.sql (_out_bikes_guard); drop trigger trg_type_full_guard on public.queue_entries;
--   drop function public._type_full_guard(), public._type_room_else(public.sessions, text, text),
--   public._type_places(text, text).
-- Idempotent: safe to re-run. Run supabase/checks/security-attributes.sql after.
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

-- The two functions replaced whole must still be the live text this file was built from (md5 of the body, read on
-- prod and staging 2026-11-11), or already this file's (a re-run): else stop, rather than undo a change made since.
do $pre$
declare f record; m text;
begin
  for f in select * from (values
    ('public._out_bikes_room(text,text,text,boolean)', '82f0575c1b5bab50a0065b1781a42dcc'),
    ('public._out_bikes_guard()', '7794f90f62ec78b97efec02eff77964f')
  ) v(fn, was) loop
    select md5(p.prosrc) into m from pg_proc p where p.oid = f.fn::regprocedure;
    if m is distinct from f.was
       and position('20261111180600' in (select p.prosrc from pg_proc p where p.oid = f.fn::regprocedure)) = 0 then
      raise exception '% changed since 2026-11-11 (md5 %): rebuild this file from the live definition', f.fn, m;
    end if;
  end loop;
end $pre$;

-- 1 _type_places (new) -----------------------------------------------------------------------------------------
create or replace function public._type_places(p_session_id text, p_type text)
 returns integer
 language plpgsql
 stable security definer
 set search_path = public
as $function$
/* The places bike type p_type has on a session where the session counts them by type (20261111180600): bike_slots
   gives the type a number, or a number per size (summed), or the fleet picked (_bikes) holds bikes of it. Null where
   the session counts its bikes as a total only, and where bike_slots cannot be read. The desk's _n6rTypePlaces and
   the rider's _capLeft read the same. */
declare _slots jsonb; _n int;
begin
  if coalesce(p_type, '') = '' then return null; end if;
  begin
    select coalesce(nullif(s.bike_slots, '')::jsonb, '{}'::jsonb) into _slots from sessions s where s.id = p_session_id;
  exception when others then return null;
  end;
  if _slots is null or jsonb_typeof(_slots) <> 'object' then return null; end if;
  if jsonb_typeof(_slots -> '_bikes') = 'array' then
    select count(*) into _n from bikes b
     where b.type = p_type and b.id::text in (select jsonb_array_elements_text(_slots -> '_bikes'));
    return _n;
  elsif jsonb_typeof(_slots -> p_type) = 'number' then
    return (_slots ->> p_type)::numeric::int;
  elsif jsonb_typeof(_slots -> p_type) = 'object' then
    select coalesce(sum((value #>> '{}')::numeric), 0)::int into _n
      from jsonb_each(_slots -> p_type) where jsonb_typeof(value) = 'number';
    return _n;
  end if;
  return null;
end $function$;
revoke execute on function public._type_places(text, text) from public, anon, authenticated;

-- 2 _out_bikes_room (replaced) ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._out_bikes_room(p_session_id text, p_type text, p_exclude text, p_held boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Whether the session still has a bike for one more rider of type p_type, counted as a new booking is counted: every
   place taken (with p_held only the places held, the waitlist left out), the rider's own row p_exclude left out.
   - The bikes staff marked out of service (sessions.out_bikes) take their places off the capacity (bug hunt
     2026-11-10, 20261110235000).
   - The type's own places where the session counts them (_type_places: bike_slots by type, or the fleet picked),
     less its bikes out: since 20261111180600 with no bike out too (the owner, 2026-11-11: each bike type is capped on
     its own). A type given no places and none out is not counted, as the desk's figure has it (_tylN).
   True on an approval ride, and for an own bike but on the Petromin night. */
declare s sessions%rowtype; _own boolean; _out int := 0; _n int := 0; _live int; _places int;
begin
  select * into s from sessions where id = p_session_id;
  if not found or coalesce(s.needs_approval, false) then return true; end if;
  _own := coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin';
  if coalesce(p_type, '') = 'Own' and not _own then return true; end if;
  if jsonb_typeof(s.out_bikes) = 'object' then
    select coalesce(sum(greatest(0, floor((value #>> '{}')::numeric))), 0)::int into _out
      from jsonb_each(s.out_bikes) where jsonb_typeof(value) = 'number';
  end if;
  if _out > 0 then
    select count(*) into _live from queue_entries q
     where q.session_id = p_session_id and q.id is distinct from p_exclude
       and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
       and not (p_held and coalesce(q.status, '') = 'waitlist')
       and (_own or coalesce(q.type_preference, '') <> 'Own');
    if _live >= greatest(0, coalesce(s.capacity, 12) - _out) then return false; end if;
    if jsonb_typeof(s.out_bikes -> p_type) = 'number' then
      _n := greatest(0, floor((s.out_bikes ->> p_type)::numeric))::int;
    end if;
  end if;
  _places := _type_places(p_session_id, p_type);
  if _places is null or (_places <= 0 and _n <= 0) then return true; end if;
  select count(*) into _live from queue_entries q
   where q.session_id = p_session_id and q.type_preference = p_type and q.id is distinct from p_exclude
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
     and not (p_held and coalesce(q.status, '') = 'waitlist');
  return _live < greatest(0, _places - _n);
end $function$;
revoke execute on function public._out_bikes_room(text, text, text, boolean) from public, anon, authenticated;

-- 3 _type_room_else (new) --------------------------------------------------------------------------------------
create or replace function public._type_room_else(s public.sessions, p_type text, p_cust text)
 returns boolean
 language plpgsql
 stable security definer
 set search_path = public
as $function$
/* Whether a rider booking session s has a bike type other than p_type still to pick (20261111180600): the types the
   booking app offers them (an own bike where the ride takes one; Road, Hybrid, Mountain, Kids and Road Carbon less
   the types hidden on their account and Road Carbon for a VIP) that staff have not closed and that have room
   (_out_bikes_room). The app asks the same before it draws a ride as its waitlist (_capAll). */
declare _hid text[] := '{}'; _u text;
begin
  if coalesce(s.event_kind, '') = 'community' or coalesce(s.ride_kind, '') = 'snd96' then return true; end if;
  if p_cust is not null then
    select array(select btrim(x) from unnest(string_to_array(coalesce(c.hidden_types, ''), ',')) x) into _hid
      from customers c where c.id = p_cust;
    _hid := coalesce(_hid, '{}');
    if _is_vip(p_cust) then _hid := _hid || 'Road Carbon'::text; end if;
  end if;
  foreach _u in array array['Road', 'Hybrid', 'Mountain', 'Kids', 'Road Carbon'] loop
    continue when _u = p_type or _u = any(coalesce(s.closed_types, '{}'::text[])) or _u = any(_hid);
    if _out_bikes_room(s.id, _u, null, false) then return true; end if;
  end loop;
  return false;
end $function$;
revoke execute on function public._type_room_else(public.sessions, text, text) from public, anon, authenticated;

-- 4 _type_full_guard (new) and its trigger ---------------------------------------------------------------------
create or replace function public._type_full_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public
as $function$
/* Each bike type is capped on its own (the owner, 2026-11-11; 20261111180600). A booking that takes a place (waiting,
   or on a bike) of a type whose own places on the session are all taken - _type_places less its bikes out of
   service, against the bookings of the type that are not cancelled, removed or a no-show, the waitlist too - is
   refused TYPE_FULL (detail: the type; hint: taken/places), on insert, on a move to another session and on a change of
   type. A rider with no other type to pick there (_type_room_else) joins the waitlist instead on a new booking or a
   move. Staff are refused unless they said Add anyway (the header x-mm-type-cap: ok, or mm.type_cap_ok = '1'); their
   change of type or session on an existing booking passes. Never on an approval ride, an own bike, 'Any', the
   waitlist, or a session that does not count the type. */
declare s sessions%rowtype; _staff boolean; _ok boolean := false; _new boolean := true; _places int; _n int := 0; _live int;
begin
  if coalesce(current_setting('mm.promoting', true), '') = '1' then return new; end if;
  if coalesce(new.status, '') not in ('waiting', 'active') or coalesce(new.type_preference, '') in ('', 'Any', 'Own') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.type_preference is not distinct from old.type_preference and new.session_id is not distinct from old.session_id then
      return new;
    end if;
    _new := new.session_id is distinct from old.session_id;
  end if;
  _staff := (select is_staff());
  if tg_op = 'UPDATE' and _staff then return new; end if;   /* the desk changes a rider's type to the bike handed over */
  select * into s from sessions where id = new.session_id;
  if not found or coalesce(s.needs_approval, false) then return new; end if;
  _places := _type_places(new.session_id, new.type_preference);
  if _places is null then return new; end if;
  if jsonb_typeof(s.out_bikes -> new.type_preference) = 'number' then
    _n := greatest(0, floor((s.out_bikes ->> new.type_preference)::numeric))::int;
  end if;
  if _places <= 0 and _n <= 0 then return new; end if;
  perform pg_advisory_xact_lock(hashtext('cap:' || new.session_id));
  select count(*) into _live from queue_entries q
   where q.session_id = new.session_id and q.type_preference = new.type_preference and q.id is distinct from new.id
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
  if _live < greatest(0, _places - _n) then return new; end if;
  if _staff then
    begin
      _ok := coalesce(current_setting('mm.type_cap_ok', true), '') = '1'
             or coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-mm-type-cap', '') = 'ok';
    exception when others then _ok := false;
    end;
    if _ok then return new; end if;   /* Add anyway: the desk asked, and its Log has the line */
  elsif _new and not _type_room_else(s, new.type_preference, new.customer_id) then
    new.status := 'waitlist';         /* nothing else to pick on this ride: its waitlist, as on a full night */
    return new;
  end if;
  raise exception 'TYPE_FULL' using errcode = 'P0001', detail = new.type_preference,
    hint = _live::text || '/' || greatest(0, _places - _n)::text;
end $function$;
revoke execute on function public._type_full_guard() from public, anon, authenticated;

drop trigger if exists trg_type_full_guard on public.queue_entries;
create trigger trg_type_full_guard
  before insert or update of type_preference, session_id on public.queue_entries
  for each row execute function public._type_full_guard();

-- 5 _out_bikes_guard (replaced): the session's places less the bikes out; the type's own places are _type_full_guard's
CREATE OR REPLACE FUNCTION public._out_bikes_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* The bikes staff mark out of service (sessions.out_bikes) take their places off the session's capacity: a rider's
   new booking (or move) past them joins the waitlist. A type's own places, its bikes out among them, are
   _type_full_guard's since 20261111180600 (a rider is refused TYPE_FULL while another type has room). */
declare s sessions%rowtype; _own boolean; _out int := 0; _live int;
begin
  if coalesce(current_setting('mm.promoting', true), '') = '1' then return new; end if;
  if coalesce(new.status, '') <> 'waiting' or (select is_staff()) then return new; end if;
  select * into s from sessions where id = new.session_id;
  if not found or coalesce(s.needs_approval, false) or s.out_bikes is null or s.out_bikes = '{}'::jsonb then return new; end if;
  _own := coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin';
  if coalesce(new.type_preference, '') = 'Own' and not _own then return new; end if;
  select coalesce(sum(greatest(0, floor((value #>> '{}')::numeric))), 0)::int into _out
    from jsonb_each(s.out_bikes) where jsonb_typeof(value) = 'number';
  if _out <= 0 then return new; end if;
  perform pg_advisory_xact_lock(hashtext('cap:' || new.session_id));
  select count(*) into _live from queue_entries q
   where q.session_id = new.session_id
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
     and (_own or coalesce(q.type_preference, '') <> 'Own');
  if _live >= greatest(0, coalesce(s.capacity, 12) - _out) then new.status := 'waitlist'; end if;
  return new;
end $function$;

-- 6 _promote_next_waitlist, _wl_offer_fill, staff_offer_spot: _out_bikes_room asked with no bike out too ---------
do $do$
declare d text;
begin
  select pg_get_functiondef('public._promote_next_waitlist(text)'::regprocedure) into d;
  if position('20261111180600' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$     and (coalesce(_s.out_bikes, '{}'::jsonb) = '{}'::jsonb
          or _out_bikes_room(p_session_id, type_preference, id, true))$a$,
$b$     /* ... and the type's own places, with no bike out too (each type capped on its own, 20261111180600) */
     and _out_bikes_room(p_session_id, type_preference, id, true)$b$);
  execute d;
end $do$;

do $do$
declare d text;
begin
  select pg_get_functiondef('public._wl_offer_fill(text)'::regprocedure) into d;
  if position('20261111180600' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$    continue when _out > 0 and not _out_bikes_room(p_session_id, r.type_preference, r.id, true);   /* no working bike of the type */$a$,
$b$    continue when not _out_bikes_room(p_session_id, r.type_preference, r.id, true);   /* no working bike of the type, or its places all taken (20261111180600) */$b$);
  execute d;
end $do$;

do $do$
declare d text;
begin
  select pg_get_functiondef('public.staff_offer_spot(text,text)'::regprocedure) into d;
  if position('20261111180600' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$         or (_out > 0 and not _out_bikes_room(p_session_id, _typ, _bid, true)) then$a$,
$b$         or not _out_bikes_room(p_session_id, _typ, _bid, true) then   /* the type's own places too (20261111180600) */$b$);
  execute d;
end $do$;

-- ── Checks ───────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._type_places(text,text)', 'public._out_bikes_room(text,text,text,boolean)',
                           'public._type_room_else(public.sessions,text,text)', 'public._type_full_guard()',
                           'public._out_bikes_guard()', 'public._promote_next_waitlist(text)', 'public._wl_offer_fill(text)',
                           'public.staff_offer_spot(text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._type_places(text,text)', 'public._out_bikes_room(text,text,text,boolean)',
                           'public._type_room_else(public.sessions,text,text)', 'public._promote_next_waitlist(text)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is open to anon or authenticated', f;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'public.staff_offer_spot(text,text)', 'execute') then
    raise exception 'staff_offer_spot lost its grant';
  end if;
  foreach f in array array['public._promote_next_waitlist(text)', 'public._wl_offer_fill(text)', 'public.staff_offer_spot(text,text)'] loop
    if position('20261111180600' in pg_get_functiondef(f::regprocedure)) = 0 then
      raise exception '% was not patched', f;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.queue_entries'::regclass and tgname = 'trg_type_full_guard') then
    raise exception 'trg_type_full_guard is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111180600', 'type_caps')
on conflict (version) do nothing;

commit;
