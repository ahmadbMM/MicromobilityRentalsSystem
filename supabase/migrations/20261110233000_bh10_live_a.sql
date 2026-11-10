-- ============================================================================
-- Bug hunt 2026-11-10 (bh10), the live database, part A. For PROD and STAGING (the functions here were the
-- same on both on 2026-11-10).
--
-- 1. staff_move_session (app17-4, sql06-2): moving a session (calendar drag, a new date in the editor) copies
--    it under the new id, moves a fixed list of tables and deletes the old row. Four things added since were
--    left behind: a promo code made for that one session (promo_codes.session_id) no longer matched it, so
--    every rider was refused the code; the volunteers' portal Updates were deleted with the old row (on
--    delete cascade); their certificates and VL- free-ride codes lost the event (on delete set null), so a
--    later reward gave each volunteer a second free ride. All four now move with the session.
-- 2. _addons_price_snapshot (sql00-1): a rider's add-on line kept the price it was bought at when one old
--    line matched it, line by line, so twenty copies of a line bought free (or before a price rise) all
--    kept that price. The lines of an item at one price are now added up: when they grew, every one of them
--    is priced at today's price, as the function's own rule says.
-- 3. _out_bikes_room (new), _promote_next_waitlist, _wl_offer_fill, customer_claim_spot (sql01-3, sql03-2):
--    the bikes staff mark out of service (sessions.out_bikes) only held back new bookings. A promotion from
--    the waitlist counted the full capacity and filled the places that had no working bike; claim-mode
--    offers and claims did the same. They now count the capacity less the bikes out, and the rider's own
--    bike type's places, as a new booking is counted. A claim also keeps to the members limit (member_cap)
--    now, as a promotion already did, so a claimed offer no longer makes a 21st member on 20 bikes.
-- 4. _community_booking_gate (sql03-2): in claim mode a place offered to a waitlisted member was still free
--    to anyone booking directly while the offer was open. Open member offers now count against the members
--    limit, as _wl_offer_fill counts them when it makes the offers.
-- 5. _session_has_room (sql03-1 high, sql03-3): a rider who booked an own bike and then switched to one of
--    ours, or took back their own cancelled booking, was checked against the total capacity only. The
--    members limit and the bikes out of service were skipped, so a member refused one of our bikes
--    (MEMBER_BIKES_FULL, "join with your own bike") got one this way, ahead of the members' waitlist. Both
--    are checked now, approval ride or not (the one session with a members limit is an approval ride): the
--    switch is refused, the booking taken back goes to the waitlist.
-- 6. queue_entries_out_bikes_upd (new trigger, sql03-4): a booking moved to another session skipped the
--    bikes out of service there (the guard ran on insert only). The same guard now runs on a move.
-- 7. customer_booking_update (sql03-6, sql04-4): (a) a rider could add priced add-ons to a booking paid at
--    the desk, by card or online, and it stayed paid, so they were never collected: refused now (the
--    wallet's own rows follow in _wallet_follow, a ride on the house as before). (b) a paid booking could be
--    cancelled after its ride had ended, giving wallet money back for a ride missed: refused now, close-out
--    settles it.
-- 8. customer_wallet_release (sql04-4): a wallet payment could be taken back after the ride the same way:
--    refused now (WALLET_NOT_OPEN), as customer_wallet_pay refuses a ride already past.
-- 9. customer_locker_reserve, customer_locker_offer (sql04-2): the booking flow took a locker period already
--    over tonight (6-8 PM after 20:00, a Petromin night after 21:00) and put its fee on the bill. An ended
--    period is refused now (_lk_ended, as on the /lockers page), and the offer says which periods are over
--    ('ended'), for the app to leave them out.
-- 10. staff_locker_cancel (sql06-6): undoing a hand-back did not check the evening's places, which may have
--    gone to someone else since; it is refused with LOCKERS_FULL now.
-- 11. partner_book (sql05-5): partner ride codes could be guessed without limit. A wrong code is now counted
--    per address (30 in 10 minutes, as Saturday codes) and answered with a row (status 'BAD_CODE', id null)
--    instead of an error that undid the count; a locked address gets RATE_LIMITED. No page calls it today.
-- 12. _promo_count + trg_promo_count_del (sql09-4): a deleted booking (the desk's Undo, a group insert rolled
--    back) kept its promo code's use for good. A delete now gives it back, as a cancel does. Every code's
--    count matched its live bookings on prod on 2026-11-10, so nothing is recounted.
--
-- Not changed: sql01-5 (a one-use code taken twice at once). _enforce_booking_price already locks the code's
-- row (FOR UPDATE, uses < max_uses) on every booking that takes a code, so the second one waits, reads the
-- count the first one left and goes without the code.
--
-- Each function is replaced from its live text (md5 of the body checked on prod, and the whole definition
-- on staging, 2026-11-10); the header is pg_get_functiondef's, and CREATE OR REPLACE keeps the grants. The
-- first block stops the file if any of them changed since. Idempotent.
-- Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- Every function replaced here must still be the live text this file was built from (md5 of the body,
-- read on prod and staging 2026-11-10), or already this file's (a re-run): else stop, rather than undo
-- a change made since.
do $pre$
declare f record; m text;
begin
  for f in select * from (values
    ('public.staff_move_session(text,text,text,boolean)', 'a14f16129bc04a43f42f48ef98b2bc3d', 'bb71358198b434dbe7aea0f61ed12eb3'),
    ('public._addons_price_snapshot()', '7964147a9e109be1ab78ce8df614ee49', 'e12efd7e33defcc8e90a7161ee5e8e17'),
    ('public._promote_next_waitlist(text)', '010e80159695750e600f353972125e20', '16c6c245c7838ac2ab5a5aa11ad57463'),
    ('public._wl_offer_fill(text)', '4f91a7bdb0734c71cf1fdf0407b7413e', 'a77cc99d4453dbfb7c83008ffc0bdd1e'),
    ('public.customer_claim_spot(text,boolean)', 'ddd839954640e17868b5eed07c0d26d2', '9f53495e64fc3c20a551964a54602c42'),
    ('public._community_booking_gate()', '773d3c7ea38fca7e4eea215f54421852', '6b1cefd3f6e183d5cb1876da751808fd'),
    ('public._session_has_room(text,text,text)', '30069f5e8ae37b6f454acc030a9644ca', 'f6c9c802362568337001523b18b9041d'),
    ('public.customer_booking_update(text,text,text,jsonb)', '1f73337bd73e7199dc2740dc3fe144c9', 'd61393557605123ad51a193ce8fd6bbf'),
    ('public.customer_wallet_release(text,text,text[])', 'a70ff85802b06ea712cfe1e9e51efc58', '7024cf45594a250b6c4214022c733fe0'),
    ('public.customer_locker_reserve(text,text,text[],text,text[])', '8e43c2f99752faf8e1bf63672f61c210', '1bbef4fae4133e41b52d9973fcd1aef2'),
    ('public.customer_locker_offer(text)', '49867a72b22f487ba422a5889fcb3bdf', '9c9063515c3545f7809bf9d86a3eb430'),
    ('public.staff_locker_cancel(uuid,text,boolean)', 'b52cd4730a91a656854e80fb0fccb379', 'a82bd7a87e28f2d35a838f62b99148a9'),
    ('public.partner_book(text,text,text,text,jsonb)', '5b22fd148a3cf14bad3454a03c888cea', '32cff4dfc2d6b1c73d387c1e03e9aa4a'),
    ('public._promo_count()', 'd03cd1016a3c3bd9a6a9a5066ff9eeaf', '228871c08cc4b42c1715bf2a5636e47a')
  ) v(fn, was, now_) loop
    select md5(p.prosrc) into m from pg_proc p where p.oid = f.fn::regprocedure;
    if m is distinct from f.was and m is distinct from f.now_
       and position('20261110233000' in (select p.prosrc from pg_proc p where p.oid = f.fn::regprocedure)) = 0 then
      raise exception '% changed since 2026-11-10 (md5 %): rebuild this file from the live definition', f.fn, m;
    end if;
  end loop;
end $pre$;

-- 1 staff_move_session ------------------------------------------------------------------------------
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
    select (jsonb_populate_record(s, jsonb_build_object('id', v_to, 'session_date', to_char(d, 'YYYY-MM-DD'), 'day', v_day))).*;

  update queue_entries set session_id = v_to, session_date = to_char(d, 'YYYY-MM-DD'), session_day = v_day where session_id = p_from;
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
  /* What else names the session (bug hunt 2026-11-10, 20261110233000): a promo code made for this one
     session, the volunteers' VL- free-ride codes, their portal Updates (on delete cascade) and their
     certificates (on delete set null) stayed with the old id; they move with the session now. */
  update promo_codes set session_id = v_to where session_id = p_from;
  update promo_codes set volunteer_session_id = v_to where volunteer_session_id = p_from;
  update volunteer_updates u set session_id = v_to where u.session_id = p_from
    and not exists (select 1 from volunteer_updates x where x.customer_id = u.customer_id and x.session_id = v_to and x.kind = u.kind);
  update volunteer_certs set session_id = v_to where session_id = p_from;

  delete from sessions where id = p_from;
  return jsonb_build_object('ok', true, 'id', v_to, 'day', v_day);
end $function$;

-- 2 _addons_price_snapshot --------------------------------------------------------------------------
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
      elsif not staff and (v_id is null or
          /* Only as many as were bought at that price keep it: lines that grew are priced afresh, all of
             them at today's price (20261005210000). Every line of the item at that price is added up, so
             one line sent many times is a line that grew (bug hunt 2026-11-10, 20261110233000). */
          (select coalesce(sum(case when (n ->> 'qty') ~ '^[0-9]{1,3}$' then greatest((n ->> 'qty')::int, 1) else 1 end), 0)
             from jsonb_array_elements(j) n
            where jsonb_typeof(n) = 'object' and n ->> 'id' = v_id and n -> 'p' = o -> 'p')
          > (select coalesce(sum(case when (y ->> 'qty') ~ '^[0-9]{1,3}$' then greatest((y ->> 'qty')::int, 1) else 1 end), 0)
               from jsonb_array_elements(old_j) y
              where jsonb_typeof(y) = 'object' and y ->> 'id' = v_id and y -> 'p' = o -> 'p')) then
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

-- 3 _out_bikes_room (new) ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._out_bikes_room(p_session_id text, p_type text, p_exclude text, p_held boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* Whether the bikes staff marked out of service on a session (sessions.out_bikes) still leave a working
   bike for one more rider of type p_type, counted as _out_bikes_guard counts a new booking: every place
   taken (with p_held only the places held, the waitlist left out), the rider's own row p_exclude left out.
   True with no bike out, on an approval ride, and for an own bike but on the Petromin night
   (bug hunt 2026-11-10, 20261110233000). */
declare s sessions%rowtype; _own boolean; _out int; _n int; _live int; _slots jsonb; _places int;
begin
  select * into s from sessions where id = p_session_id;
  if not found or coalesce(s.needs_approval, false) or s.out_bikes is null or s.out_bikes = '{}'::jsonb then
    return true;
  end if;
  _own := coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin';
  if coalesce(p_type, '') = 'Own' and not _own then return true; end if;
  select coalesce(sum(greatest(0, floor((value #>> '{}')::numeric))), 0)::int into _out
    from jsonb_each(s.out_bikes) where jsonb_typeof(value) = 'number';
  if _out <= 0 then return true; end if;
  select count(*) into _live from queue_entries q
   where q.session_id = p_session_id and q.id is distinct from p_exclude
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
     and not (p_held and coalesce(q.status, '') = 'waitlist')
     and (_own or coalesce(q.type_preference, '') <> 'Own');
  if _live >= greatest(0, coalesce(s.capacity, 12) - _out) then return false; end if;
  /* the type's own places, where the session counts them */
  if jsonb_typeof(s.out_bikes -> p_type) is distinct from 'number' then return true; end if;
  _n := greatest(0, floor((s.out_bikes ->> p_type)::numeric))::int;
  if _n <= 0 then return true; end if;
  begin
    _slots := coalesce(nullif(s.bike_slots, '')::jsonb, '{}'::jsonb);
  exception when others then return true;
  end;
  if jsonb_typeof(_slots -> '_bikes') = 'array' then
    select count(*) into _places from bikes b
     where b.type = p_type and b.id::text in (select jsonb_array_elements_text(_slots -> '_bikes'));
  elsif jsonb_typeof(_slots -> p_type) = 'number' then
    _places := (_slots ->> p_type)::numeric::int;
  elsif jsonb_typeof(_slots -> p_type) = 'object' then
    select coalesce(sum((value #>> '{}')::numeric), 0)::int into _places
      from jsonb_each(_slots -> p_type) where jsonb_typeof(value) = 'number';
  else
    return true;
  end if;
  select count(*) into _live from queue_entries q
   where q.session_id = p_session_id and q.type_preference = p_type and q.id is distinct from p_exclude
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
     and not (p_held and coalesce(q.status, '') = 'waitlist');
  return _live < greatest(0, _places - _n);
end $function$;
revoke execute on function public._out_bikes_room(text, text, text, boolean) from public, anon, authenticated;

-- 3 _promote_next_waitlist --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._promote_next_waitlist(p_session_id text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _s sessions%rowtype; _row queue_entries%rowtype; _n int; _own boolean; _held int; _a jsonb; k text; _mem int := 0;
begin
  select * into _s from sessions where id = p_session_id;
  if not found or coalesce(_s.needs_approval,false) then return null; end if;   -- staff pick riders on an approval ride
  perform pg_advisory_xact_lock(hashtext('promote:'||p_session_id));
  /* Settings > Business wl_offer_mode (20261009225000): staff choose, or the rider claims an offer */
  if _wl_mode() <> 'auto' then
    if _wl_mode() = 'claim' then perform _wl_offer_fill(p_session_id); end if;
    return null;
  end if;
  _own := coalesce(_s.event_kind,'') = 'community' and coalesce(_s.ride_kind,'') = 'petromin';
  select count(*) into _held from queue_entries q
   where q.session_id = p_session_id
     and coalesce(q.status,'') not in ('cancelled','removed','noshow','waitlist')
     and (_own or coalesce(q.type_preference,'') <> 'Own');
  if _held >= coalesce(_s.capacity, 12) then return null; end if;
  -- The members limit, counted as _community_booking_gate counts it: a member's booking moves up
  -- only while the members are under it (bug hunt 2026-10-28).
  if _s.member_cap is not null then
    select count(*) into _mem from queue_entries q
     where q.session_id = p_session_id and q.partner is null
       and coalesce(q.status,'') not in ('cancelled','removed','noshow','waitlist');
  end if;
  select * into _row from queue_entries
   where session_id = p_session_id and status = 'waitlist'
     and (_own or coalesce(type_preference,'') <> 'Own')
     and not (_s.member_cap is not null and _mem >= _s.member_cap
              and partner is null and coalesce(type_preference,'') <> 'Own')
     /* bikes out of service take their places off, the rider's own bike type's too, as _out_bikes_guard
        counts them for a new booking (bug hunt 2026-11-10, 20261110233000) */
     and (coalesce(_s.out_bikes, '{}'::jsonb) = '{}'::jsonb
          or _out_bikes_room(p_session_id, type_preference, id, true))
   order by coalesce(waitlist_num, 2147483647), registered_at
   limit 1;
  if not found then return null; end if;
  perform set_config('mm.promoting','1',true);
  update queue_entries set status='waiting' where id = _row.id and status='waitlist';
  get diagnostics _n = row_count;
  perform set_config('mm.promoting','',true);
  if _n = 0 then return null; end if;   -- another device got there first
  begin
    _a := _addon_map(_row.addons);
    for k in select jsonb_object_keys(_a) loop
      update inventory i
         set qty = i.qty - greatest((_a->>k)::int - coalesce((coalesce(_row.addons_held, '{}'::jsonb)->>k)::int, 0), 0)
       where i.id = k;
    end loop;
    update queue_entries set addons_held = _a where id = _row.id;
  exception when others then null;
  end;
  return _row.id;
end $function$;

-- 3 _wl_offer_fill ----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._wl_offer_fill(p_session_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _s sessions%rowtype; _own boolean; _held int; _open int; _free int; _n int := 0; r record; _min int;
        _mroom int; _ismem boolean; _out int := 0;
begin
  if _wl_mode() <> 'claim' then return 0; end if;
  perform pg_advisory_xact_lock(hashtext('promote:'||p_session_id));  /* the promotion's own lock: two fills never pick one rider */
  select * into _s from sessions where id = p_session_id;
  if not found or coalesce(_s.needs_approval, false) or _s.cancelled_at is not null or _s.status = 'deleted' then return 0; end if;
  if (select w.ends_at from _session_window(_s) w) <= now() then return 0; end if;
  _own := coalesce(_s.event_kind,'') = 'community' and coalesce(_s.ride_kind,'') = 'petromin';
  select count(*) into _held from queue_entries q
   where q.session_id = p_session_id
     and coalesce(q.status,'') not in ('cancelled','removed','noshow','waitlist')
     and (_own or coalesce(q.type_preference,'') <> 'Own');
  select count(*) into _open from waitlist_offers o
   where o.session_id = p_session_id and o.status = 'open' and o.expires_at > now();
  /* bikes out of service take their places off, as _out_bikes_guard counts them (bug hunt 2026-11-10,
     20261110233000) */
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

-- 3 customer_claim_spot -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_claim_spot(p_token text, p_decline boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o waitlist_offers%rowtype; q queue_entries%rowtype; _s sessions%rowtype; _own boolean; _held int; _n int; _a jsonb; k text;
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
  if _s.id is null or _s.cancelled_at is not null or (select w.ends_at from _session_window(_s) w) <= now() then
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
     20261110233000) */
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

-- 4 _community_booking_gate -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._community_booking_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare s sessions%rowtype; pb text[]; sc text[]; _live int; _wl int; _code boolean := false;
begin
  select * into s from sessions where id = new.session_id;
  pb := string_to_array(coalesce(current_setting('mm.partner', true), ''), '|');
  if tg_op = 'INSERT' and cardinality(pb) = 3 and pb[1] = new.session_id then
    new.partner := pb[2];
    new.partner_code := (pb[3] = '1');
    new.approval := 'approved';
    if new.status = 'waitlist' then new.status := 'waiting'; end if;
    return new;
  end if;
  -- A Saturday Social Ride (20261108120000): the booking saturday_book is making came with a code, and the
  -- code lets the rider in, member or not. While staff have switched micromobility.sa/saturday on, that is
  -- the only way a rider's own booking comes onto a Saturday ride.
  if s.id is not null and s.event_kind = 'community' and coalesce(nullif(s.ride_kind, ''), 'saturday') = 'saturday' then
    sc := string_to_array(coalesce(current_setting('mm.satcode', true), ''), '|');
    _code := tg_op = 'INSERT' and cardinality(sc) = 2 and sc[1] = new.session_id;
    if not _code and not is_staff() and saturday_link_only() then
      raise exception 'Saturday Social Ride places are booked at micromobility.sa/saturday.'
        using detail = 'SATURDAY_LINK';
    end if;
  end if;
  if s.id is not null
     and s.event_kind = 'community'
     and coalesce(s.open_to_all, false) = false
     and not is_staff()
     and not _code
     and (new.customer_id is null or not exists (
            select 1
              from customer_tags ct
              join tags tg on tg.id = ct.tag_id
             where ct.customer_id = new.customer_id
               and lower(tg.slug) = 'saturday'
               and _ctag_active(ct.starts_at, ct.expires_at)))
     and not (coalesce(s.ride_kind, '') = 'petromin' and _petromin_holder(new.customer_id))
     and not (coalesce(s.ride_kind, '') = 'vlap' and _vlap_holder(new.customer_id))
  then
    raise exception 'This ride is for community members only.' using detail = 'MEMBERS_ONLY';
  end if;
  -- The members limit (20261017120000) and its waitlist (20261018140000). Own bikes are never limited.
  if s.id is not null and s.member_cap is not null and new.partner is null
     and coalesce(new.type_preference, '') <> 'Own'
     and coalesce(new.status, '') not in ('cancelled', 'removed', 'noshow') then
    perform pg_advisory_xact_lock(hashtext('membercap:' || s.id));
    if coalesce(new.status, '') <> 'waitlist' then
      select count(*) into _live from queue_entries q
       where q.session_id = s.id and q.partner is null and q.id <> new.id
         and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow', 'waitlist');
      /* a place offered to a waitlisted member is theirs while the offer is open (claim mode), as
         _wl_offer_fill counts it (bug hunt 2026-11-10, 20261110233000) */
      _live := _live + (select count(*) from waitlist_offers o join queue_entries q on q.id = o.booking_id
                         where o.session_id = s.id and o.status = 'open' and o.expires_at > now()
                           and q.partner is null and coalesce(q.type_preference, '') <> 'Own'
                           and q.id is distinct from new.id);
      if _live < s.member_cap then
        return new;
      end if;
    end if;
    -- Past the limit (or a booking sent as waitlist): the members' waitlist while it has room.
    if tg_op = 'INSERT' and s.member_wl is not null then
      select count(*) into _wl from queue_entries q
       where q.session_id = s.id and q.partner is null and q.id <> new.id and q.status = 'waitlist';
      if _wl < s.member_wl then
        new.status := 'waitlist';
        return new;
      end if;
      raise exception 'Our bikes are taken for this ride. You can still join with your own bike.'
        using detail = 'MEMBER_BIKES_FULL';
    end if;
    if coalesce(new.status, '') <> 'waitlist' then
      raise exception 'Our bikes are taken for this ride. You can still join with your own bike.'
        using detail = 'MEMBER_BIKES_FULL';
    end if;
  end if;
  return new;
end $function$;

-- 5 _session_has_room -------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._session_has_room(p_session_id text, p_type text, p_exclude text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare s sessions%rowtype; _own boolean; _live int; _mem int;
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
  if not coalesce(s.needs_approval, false) then   /* staff pick an approval ride's riders by hand */
    perform pg_advisory_xact_lock(hashtext('cap:' || p_session_id));
    select count(*) into _live from queue_entries q
     where q.session_id = p_session_id and q.id is distinct from p_exclude
       and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
       and (_own or coalesce(q.type_preference, '') <> 'Own');
    if _live >= coalesce(s.capacity, 12) then return false; end if;
    /* the bikes out of service, as _out_bikes_guard counts them for a new booking (bug hunt 2026-11-10,
       20261110233000) */
    if not _out_bikes_room(p_session_id, p_type, p_exclude, false) then return false; end if;
  end if;
  /* The members limit, as _community_booking_gate holds a new booking to it, approval ride or not, with
     the places offered to waitlisted members: an own bike and a partner's place are never limited. */
  if s.member_cap is not null and coalesce(p_type, '') <> 'Own'
     and (select x.partner from queue_entries x where x.id = p_exclude) is null then
    perform pg_advisory_xact_lock(hashtext('membercap:' || p_session_id));
    select count(*) into _mem from queue_entries x
     where x.session_id = p_session_id and x.partner is null and x.id is distinct from p_exclude
       and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow', 'waitlist');
    _mem := _mem + (select count(*) from waitlist_offers o join queue_entries x on x.id = o.booking_id
                     where o.session_id = p_session_id and o.status = 'open' and o.expires_at > now()
                       and x.partner is null and coalesce(x.type_preference, '') <> 'Own'
                       and x.id is distinct from p_exclude);
    if _mem >= s.member_cap then return false; end if;
  end if;
  return true;
end $function$;

-- 7 customer_booking_update -------------------------------------------------------------------------
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
       its wallet money back for a ride missed (bug hunt 2026-11-10, 20261110233000). */
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
    elsif q.paid and _type is not null and _type is distinct from q.type_preference
          and coalesce(_fare_now(q.session_id, q.id, _type), 0) > coalesce(q.price, 0) then
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

-- 8 customer_wallet_release -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_wallet_release(p_id text, p_token text, p_booking_ids text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q queue_entries%rowtype; bid text; total numeric := 0; s sessions%rowtype; _ended boolean;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if coalesce(array_length(p_booking_ids, 1), 0) = 0 or array_length(p_booking_ids, 1) > 20 then
    raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001';
  end if;
  foreach bid in array (select array_agg(x order by x) from unnest(p_booking_ids) x) loop
    select * into q from queue_entries where id = bid and customer_id = p_id for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if coalesce(q.wallet_paid, 0) <= 0 then continue; end if;
    if q.status is distinct from 'waiting' or (coalesce(q.paid, false) and q.pay_method is distinct from 'wallet') then
      raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001';
    end if;
    /* A ride that has ended keeps its payment until close-out settles it (a paid no-show keeps it): taken
       back afterwards it undid the payment for a ride missed (bug hunt 2026-11-10, 20261110233000). */
    select * into s from sessions where id = q.session_id;
    begin _ended := (select w.ends_at from _session_window(s) w) <= now();
    exception when others then _ended := false; end;
    if left(coalesce(s.session_date, q.session_date, q.session_id, ''), 10) < to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
       or coalesce(_ended, false) then
      raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001';
    end if;
    total := total + _wallet_release(q);
  end loop;
  return jsonb_build_object('ok', true, 'amount', total,
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'paid', e.paid, 'pay_method', e.pay_method, 'wallet_paid', e.wallet_paid)), '[]'::jsonb)
               from queue_entries e where e.id = any(p_booking_ids) and e.customer_id = p_id),
    'balance', coalesce((select balance from wallet_balances where customer_id = p_id), 0));
end $function$;

-- 9 customer_locker_reserve -------------------------------------------------------------------------
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
     20261110233000) */
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
    end if;
    insert into locker_rentals (day, period, booking_id, session_id, customer_id, name, locker_id, price, on_bill, status, created_by)
    select d, p_period, e.id, e.session_id, e.customer_id, left(e.name, 120), lk.id, _lk_price(p_period), true, 'reserved', 'rider'
      from queue_entries e where e.id = bid;
  end loop;
  return jsonb_build_object('ok', true, 'left', _lk_left(d),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'addons', e.addons, 'paid', e.paid, 'pay_method', e.pay_method,
                                                          'wallet_paid', e.wallet_paid)), '[]'::jsonb)
               from queue_entries e where e.id = any(ids)));
end $function$;

-- 9 customer_locker_offer ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_locker_offer(p_session text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare k text; d date;
begin
  k := _lk_kind(p_session);
  if k = '' then return jsonb_build_object('kind', ''); end if;
  select case when s.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date, 10)::date end into d
    from sessions s where s.id = p_session;
  if d is null then return jsonb_build_object('kind', ''); end if;
  /* 'ended': the periods already over, which the booking flow no longer offers (bug hunt 2026-11-10,
     20261110233000) */
  return jsonb_build_object('kind', k, 'one', _lk_price('early'), 'both', _lk_price('both'), 'left', _lk_left(d),
                            'ended', jsonb_build_object('early', _lk_ended(d, 'early'), 'late', _lk_ended(d, 'late'),
                                                       'both', _lk_ended(d, 'both'), 'pm', _lk_ended(d, 'pm')));
end $function$;

-- 10 staff_locker_cancel ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_locker_cancel(p_rental uuid, p_reason text, p_undo boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r locker_rentals%rowtype; who text;
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
       rental is still 'returned', so _lk_room counts without it (bug hunt 2026-11-10, 20261110233000) */
    if not _lk_room(r.day, r.period, 1) then raise exception 'LOCKERS_FULL' using errcode = 'P0001'; end if;
    update locker_rentals set status = 'in_use', returned_at = null, returned_by = null where id = r.id;
    return jsonb_build_object('ok', true);
  end if;
  if r.status not in ('reserved', 'in_use', 'returned') then raise exception 'LOCKER_NOT_OPEN: already cancelled' using errcode = 'P0001'; end if;
  update locker_rentals set status = 'cancelled', cancelled_at = now(), cancelled_by = _lk_who(),
         cancel_reason = left(coalesce(nullif(btrim(p_reason), ''), 'staff'), 120)
   where id = r.id;
  perform _lk_unpay(r.id, _lk_who());
  if r.booking_id is null then return jsonb_build_object('ok', true); end if;
  return jsonb_build_object('ok', true, 'booking_id', r.booking_id, 'addons', (select e.addons from queue_entries e where e.id = r.booking_id));
end $function$;

-- 11 partner_book -----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.partner_book(p_id text, p_token text, p_partner text, p_code text, p_entry jsonb)
 RETURNS TABLE(id text, queue_num integer, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare sp session_partners%rowtype; pc session_partner_codes%rowtype; r record; _code boolean;
        _name text; _ask jsonb; _got text; _size text;
begin
  if not _cust_token_ok(p_id, p_token) then
    raise exception 'STALE_SESSION' using errcode = 'P0001';
  end if;
  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'entry';
  end if;
  if not exists (select 1 from customers c
                  where c.id = p_id
                    and nullif(btrim(coalesce(c.birth_date, '')), '') is not null
                    and nullif(btrim(coalesce(c.nationality, '')), '') is not null
                    and nullif(btrim(coalesce(c.socials->>'instagram', '')), '') is not null) then
    raise exception 'FIX_FIRST' using errcode = 'P0001', detail = 'birth_date,nationality,instagram';
  end if;
  if p_entry ? 'ask' and jsonb_typeof(p_entry->'ask') <> 'null' then
    if jsonb_typeof(p_entry->'ask') <> 'object' then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'ask';
    end if;
    _got := p_entry->'ask'->>'shirt_got';
    if _got is null or _got not in ('true', 'false') then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'ask';
    end if;
    if _got = 'true' then
      _ask := jsonb_build_object('shirt_got', true);
    else
      _size := upper(btrim(coalesce(p_entry->'ask'->>'shirt', '')));
      if _size not in ('XS', 'S', 'M', 'L', 'XL', 'XXL') then
        raise exception 'SHIRT_SIZE' using errcode = 'P0001';
      end if;
      _ask := jsonb_build_object('shirt_got', false, 'shirt', _size);
    end if;
  end if;
  sp := _partner_session(p_partner);
  if sp.session_id is null then
    raise exception 'PARTNER_CLOSED' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('partner:' || sp.session_id || ':' || sp.partner));
  if _partner_live(sp.session_id, sp.partner, false) >= sp.places then
    raise exception 'PARTNER_FULL' using errcode = 'P0001';
  end if;
  _code := sp.code_needed;
  if _code then
    /* Wrong codes are counted per address and a locked address refused, as saturday_book does: guessed
       without a limit, a partner's places went to whoever found a code (bug hunt 2026-11-10,
       20261110233000). */
    if exists (select 1 from login_throttle l
                where l.identifier = 'partnercode:' || _client_ip() and l.locked_until > now()) then
      raise exception 'RATE_LIMITED' using errcode = 'P0001';
    end if;
    select * into pc from session_partner_codes c
     where c.session_id = sp.session_id and c.partner = sp.partner
       and lower(c.code) = lower(btrim(coalesce(p_code, '')));
    if pc.code is null then
      perform _ip_gate('partnercode', 30, interval '10 minutes');
      /* answered with a row, not raised: an error would undo the count */
      id := null; queue_num := null; status := 'BAD_CODE';
      return next;
      return;
    end if;
    if _partner_code_live(sp.session_id, sp.partner, pc.code) >= pc.places then
      raise exception 'CODE_USED_UP' using errcode = 'P0001';
    end if;
  end if;
  select c.name into _name from customers c where c.id = p_id;
  perform set_config('mm.partner', sp.session_id || '|' || sp.partner || '|' || case when _code then '1' else '0' end, true);
  perform set_config('mm.partner_ask', coalesce(_ask::text, ''), true);
  perform set_config('mm.partner_code', case when _code then pc.code else '' end, true);
  for r in
    select * from customer_create_booking(p_id, p_token, jsonb_build_array(
      (p_entry - 'promo_code' - 'group_id' - 'run_km' - 'share_ok' - 'ask')
      || jsonb_build_object('session_id', sp.session_id, 'name', coalesce(_name, ''))))
  loop
    if r.status = 'waitlist' then
      raise exception 'PARTNER_FULL' using errcode = 'P0001';
    end if;
    id := r.id; queue_num := r.queue_num; status := r.status;
    return next;
  end loop;
  perform set_config('mm.partner', '', true);
  perform set_config('mm.partner_ask', '', true);
  perform set_config('mm.partner_code', '', true);
end $function$;

-- 12 _promo_count -----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._promo_count()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _o text; _n text;
begin
  /* A deleted booking gives its use back, as a cancelled one does (bug hunt 2026-11-10, 20261110233000):
     the desk's Undo and a group insert rolled back kept a limited code's use for good. */
  if tg_op = 'DELETE' then
    if coalesce(old.status,'') not in ('cancelled','removed') and nullif(old.promo_code, '') is not null then
      update promo_codes set uses = greatest(coalesce(uses, 0) - 1, 0) where lower(code) = lower(old.promo_code);
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.promo_code is not null and new.promo_code <> '' then
      update promo_codes set uses = coalesce(uses, 0) + 1
       where lower(code) = lower(new.promo_code);
    end if;
    return new;
  end if;

  -- A row holds one use while it is live and carries the code. A cancel, a restore, a code
  -- applied after booking or cleared by the price trigger each move the count to match.
  _o := case when coalesce(old.status,'') not in ('cancelled','removed') then lower(nullif(old.promo_code, '')) end;
  _n := case when coalesce(new.status,'') not in ('cancelled','removed') then lower(nullif(new.promo_code, '')) end;
  if _o is not distinct from _n then return new; end if;
  if _o is not null then
    update promo_codes set uses = greatest(coalesce(uses, 0) - 1, 0) where lower(code) = _o;
  end if;
  if _n is not null then
    update promo_codes set uses = coalesce(uses, 0) + 1 where lower(code) = _n;
  end if;
  return new;
end $function$;

-- 6 the out-of-service guard on a move ----------------------------------------------------------------
-- The guard counts the rows already in new.session_id; the row being moved is not one of them yet. Staff
-- and promotions pass through it, as on insert.
drop trigger if exists queue_entries_out_bikes_upd on public.queue_entries;
create trigger queue_entries_out_bikes_upd
  before update of session_id on public.queue_entries
  for each row when (new.session_id is distinct from old.session_id)
  execute function public._out_bikes_guard();

-- 12 a deleted booking gives its code's use back ----------------------------------------------------
drop trigger if exists trg_promo_count_del on public.queue_entries;
create trigger trg_promo_count_del
  after delete on public.queue_entries
  for each row execute function public._promo_count();

-- checks: every function kept SECURITY DEFINER (_session_has_room never had it) and its search_path, the
-- grants are as they were, the new helper is closed to callers, the two triggers are there
do $chk$
declare f text;
begin
  foreach f in array array['staff_move_session','_addons_price_snapshot','_out_bikes_room','_promote_next_waitlist',
                           '_wl_offer_fill','customer_claim_spot','_community_booking_gate','customer_booking_update',
                           'customer_wallet_release','customer_locker_reserve','customer_locker_offer',
                           'staff_locker_cancel','partner_book','_promo_count','_out_bikes_guard'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if not exists (select 1 from pg_proc p where p.oid = 'public._session_has_room(text,text,text)'::regprocedure
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '_session_has_room lost its search_path';
  end if;
  foreach f in array array['public.customer_booking_update(text,text,text,jsonb)', 'public.customer_claim_spot(text,boolean)',
                           'public.customer_wallet_release(text,text,text[])',
                           'public.customer_locker_reserve(text,text,text[],text,text[])', 'public.customer_locker_offer(text)',
                           'public.partner_book(text,text,text,text,jsonb)'] loop
    if not has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% lost its grant', f;
    end if;
  end loop;
  foreach f in array array['public.staff_move_session(text,text,text,boolean)', 'public.staff_locker_cancel(uuid,text,boolean)'] loop
    if not has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute') then
      raise exception '% grants changed', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public._out_bikes_room(text,text,text,boolean)', 'execute')
     or has_function_privilege('authenticated', 'public._out_bikes_room(text,text,text,boolean)', 'execute') then
    raise exception '_out_bikes_room is open to anon or authenticated';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.queue_entries'::regclass and tgname = 'queue_entries_out_bikes_upd')
     or not exists (select 1 from pg_trigger where tgrelid = 'public.queue_entries'::regclass and tgname = 'trg_promo_count_del') then
    raise exception 'a trigger of this file is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261110233000', 'bh10_live_a')
on conflict (version) do nothing;

commit;
