-- ============================================================================
-- Bug hunt 2026-10-28, staff side of the database (group fx-db-b).
--
-- 1. _promote_next_waitlist and _wl_offer_fill (dbf-c-1): the waitlist moved up (or was offered a
--    place) on the session's capacity alone. A member put on the members' waitlist by
--    _community_booking_gate (the members limit, 20261017120000 / 20261018140000) went to waiting
--    when a partner place was cancelled or the capacity was raised, and the gate never runs on that
--    update, so the members' count went past member_cap. A member's booking now moves up, or is
--    offered a place, only while the members' live count (counted as the gate counts it: partner
--    null, not cancelled/removed/no-show/waitlist), plus the open offers to members, is under the
--    limit. Own bikes and partner rows are not limited, as before.
-- 2. _purge_old (dbsec-4, dbf-c-2, dbm1-7): anonymising an account left the person in other tables.
--    customers_to_applications copies only non-blank values, so the applications kept the email,
--    phone, birth date, Instagram and WhatsApp under the name 'Former Rider'. The anonymiser now
--    also blanks the community and learn applications, the Petromin rider forms matched to the
--    account, the bookings' party contact and desk note, the desk waitlist rows of its bookings,
--    the till's customer name (and the audit lines that update wrote), the tag notes, and deletes
--    the staff notes on the account and its push subscriptions. (Off on prod: anon_years unset.)
-- 3. staff_vendor_* writes (dbf-b-2): each checked only is_staff(), so a leader, mechanic, cashier
--    or front-desk account (or the read-only Owner role) could mint a venue's portal password with
--    one rpc call. They now need Vendors in the account's edit list (_staff_mod, 'fnb' being its
--    old name) and a role whose sections hold Vendors (admin, manager), as the desk shows it.
--    staff_vendor_tier_save already asks is_admin().
-- 4. staff_void_receipt (dbf-b-1, server half): a void takes a receipt out of the takings but asked
--    neither the refund capability nor the manager limit that a refund asks. It now raises
--    CAP_REFUND and MANAGER_REQUIRED as staff_refund_receipt does (the amount: the receipt's live,
--    paid, non-house lines). The desk's _gatedRpc already asks an approver on MANAGER_REQUIRED.
-- 5. _house_guard (dbm1-5): a ride already on the house passed only when its session was unchanged
--    too, so moving a session's date (one update of every booking in it) or a rider to another
--    session was refused with MANAGER_REQUIRED, with no way to pass an approval. The same rider,
--    name and bike on another session is the same free ride and passes.
-- 6. staff_last_seen (dbm1-4): one row per account, more than PostgREST's 1,000; the desk now reads
--    it in pages with .range(), and the rows come ordered by id so the pages do not overlap.
--
-- Each function is replaced from its live definition (header copied from pg_get_functiondef);
-- CREATE OR REPLACE keeps the grants, which are restated below. Idempotent.
-- Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- 1 -------------------------------------------------------------------------
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
revoke all on function public._promote_next_waitlist(text) from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public._wl_offer_fill(p_session_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _s sessions%rowtype; _own boolean; _held int; _open int; _free int; _n int := 0; r record; _min int;
        _mroom int; _ismem boolean;
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
  _free := coalesce(_s.capacity, 12) - _held - _open;
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
revoke all on function public._wl_offer_fill(text) from public, anon, authenticated;
grant execute on function public._wl_offer_fill(text) to service_role;

-- 2 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._purge_old(p_dry boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  c_sa timestamptz := _ret_cut('staff_actions', 'm', 24);
  c_ca timestamptz := _ret_cut('customer_activity', 'm', 24);
  c_al timestamptz := _ret_cut('audit_log', 'm', 24);
  c_sh timestamptz := _ret_cut('site_content_history', 'm', 24);
  c_el timestamptz := _ret_cut('error_log', 'd', 90);
  yrs int := coalesce((select case when jsonb_typeof(o.items -> 'retention' -> 'anon_years') = 'number'
                                    and (o.items -> 'retention' ->> 'anon_years')::numeric between 1 and 20
                                   then (o.items -> 'retention' ->> 'anon_years')::numeric::int end
                         from staff_options o where o.key = 'biz'), 0);
  n_sa int; n_ca int; n_al int; n_sh int; n_el int; n_an int := 0; ids text[];
begin
  if p_dry then
    select count(*) into n_sa from staff_actions
     where coalesce(at_server, case when at ~ '^\d{4}-\d{2}-\d{2}' then left(at, 10)::date::timestamptz end) < c_sa;
    select count(*) into n_ca from customer_activity where at < c_ca;
    select count(*) into n_al from audit_log where at < c_al;
    select count(*) into n_sh from site_content_history where changed_at < c_sh;
    select count(*) into n_el from error_log where case when at ~ '^\d{4}-\d{2}-\d{2}' then left(at, 10)::date::timestamptz end < c_el;
  else
    delete from staff_actions
     where coalesce(at_server, case when at ~ '^\d{4}-\d{2}-\d{2}' then left(at, 10)::date::timestamptz end) < c_sa;
    get diagnostics n_sa = row_count;
    delete from customer_activity where at < c_ca;              get diagnostics n_ca = row_count;
    delete from audit_log where at < c_al;                      get diagnostics n_al = row_count;
    delete from site_content_history where changed_at < c_sh;   get diagnostics n_sh = row_count;
    delete from error_log where case when at ~ '^\d{4}-\d{2}-\d{2}' then left(at, 10)::date::timestamptz end < c_el;
    get diagnostics n_el = row_count;
  end if;

  if yrs >= 1 then
    select array_agg(c.id) into ids
      from customers c
     where c.merged_into is null
       and c.created_at ~ '^\d{4}-\d{2}-\d{2}' and left(c.created_at, 10)::date < (now() - make_interval(years => yrs))::date
       and not (c.name = 'Former Rider' and c.email is null and c.phone is null)
       and not exists (select 1 from queue_entries q where q.customer_id = c.id
                        and (q.status in ('waiting', 'waitlist', 'active')
                             or (q.session_date ~ '^\d{4}-\d{2}-\d{2}' and left(q.session_date, 10)::date > (now() - make_interval(years => yrs))::date)))
       and not exists (select 1 from cashier_sales s where s.customer_id = c.id
                        and (s.created_at !~ '^\d{4}-\d{2}-\d{2}' or left(s.created_at, 10)::date > (now() - make_interval(years => yrs))::date))
       and not exists (select 1 from customer_activity a where a.customer_id = c.id and a.at > now() - make_interval(years => yrs));
    n_an := coalesce(array_length(ids, 1), 0);
    if not p_dry and n_an > 0 then
      update customers set name = 'Former Rider', email = null, phone = null, whatsapp = null, whatsapp_same = null,
             photo = null, birth_date = null, emergency_name = null, emergency_phone = null, emergency_relation = null,
             emergency2_name = null, emergency2_phone = null, emergency2_relation = null, blood_type = null /* (20261014180000) */, socials = null,
             workplace = null, profession = null, apple_email = null, session_token = null,
             password_hash = 'anonymised'
       where id = any(ids);
      update queue_entries set name = 'Former Rider', phone = null, email = null,
             group_contact = null, group_phone = null, desk_note = null   -- (bug hunt 2026-10-28)
       where customer_id = any(ids);
      -- The rest of what names or reaches the person (bug hunt 2026-10-28). customers_to_applications
      -- copies only non-blank values, so the applications kept the old email, phone, birth date and
      -- handles under 'Former Rider'; the NOT NULL columns take ''.
      update community_applications
         set name = 'Former Rider', email = '', phone = '', instagram = '', linkedin = '', birth_date = null,
             whatsapp = null, whatsapp_same = null, workplace = null, profession = null, fix_prev = null, acct_before = null
       where customer_id = any(ids);
      update learn_applications
         set name = 'Former Rider', email = '', phone = '', learner_name = null, notes = '', birth_date = null,
             instagram = null, linkedin = null, whatsapp = null, whatsapp_same = null, workplace = null, profession = null,
             fix_prev = null,
             learners = coalesce((select jsonb_agg(case when jsonb_typeof(e.v) = 'object' then e.v - 'name' else e.v end order by e.n)
                                    from jsonb_array_elements(learners) with ordinality e(v, n)), '[]'::jsonb)
       where customer_id = any(ids);
      update rider_registrations set name = 'Former Rider', phone = null where matched_customer_id = any(ids);
      update desk_waitlist set name = 'Former Rider', phone = null
       where booking_id in (select q.id from queue_entries q where q.customer_id = any(ids));
      update cashier_sales set customer_name = 'Former Rider'
       where customer_id = any(ids) and customer_name is distinct from 'Former Rider';
      delete from audit_log where tbl = 'cashier_sales' and at >= now()   -- the lines that update just wrote
         and row_id in (select s.id from cashier_sales s where s.customer_id = any(ids));
      update customer_tags set note = null where customer_id = any(ids) and note is not null;
      delete from customer_notes where customer_id = any(ids);
      delete from push_subscriptions where customer_id = any(ids);
      -- The update above wrote the old name, email and phone into audit_log (customers_audit_upd),
      -- and the activity log holds them too: an anonymised account keeps neither (bh14, 2026-10-14).
      delete from audit_log where tbl = 'customers' and row_id = any(ids);
      update customer_activity
         set who = 'Former Rider',
             detail = coalesce(detail, '{}'::jsonb) - array['email', 'phone', 'rider', 'from_rider', 'text', 'feedback', 'note', 'ch']
       where customer_id = any(ids);
    end if;
  end if;

  if not p_dry then
    insert into staff_actions (at, action, who, device, view, user_id)
      values (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              format('Retention purge: actions %s, customer activity %s, audit %s, website history %s, errors %s, anonymised %s',
                     n_sa, n_ca, n_al, n_sh, n_el, n_an),
              'server', 'server', 'settings', auth.uid());
  end if;
  return jsonb_build_object('staff_actions', n_sa, 'customer_activity', n_ca, 'audit_log', n_al,
                            'site_content_history', n_sh, 'error_log', n_el, 'anon', n_an);
end $function$;
revoke all on function public._purge_old(boolean) from public, anon, authenticated;
grant execute on function public._purge_old(boolean) to service_role;

-- 3 -------------------------------------------------------------------------
-- Vendors is a section of the admin and manager roles (the desk's ROLE_TABS) and of an account's
-- own edit list (staff.modules_edit; 'fnb' is its name until 2026-10-03). The Owner role only looks.
CREATE OR REPLACE FUNCTION public.staff_vendor_user_add(p_venue bigint, p_login text, p_name text, p_role text DEFAULT 'manager'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare k text := _vendor_login_key(p_login); pw text := _community_temp_pwd(); uid bigint;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not ((_staff_mod('vendors', true) or _staff_mod('fnb', true))
          and exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null and s.role in ('admin', 'manager'))) then
    raise exception 'STAFF_ONLY' using errcode = '42501';   -- Vendors' own staff only (bug hunt 2026-10-28)
  end if;
  if k is null then raise exception 'BAD_LOGIN' using errcode = '22023'; end if;
  if exists(select 1 from vendor_users where login = k) then raise exception 'LOGIN_TAKEN' using errcode = '23505'; end if;
  insert into vendor_users (venue_id, login, name, role, password_hash, must_change_pwd, temp_expires_at)
  values (p_venue, k, coalesce(trim(p_name), ''), coalesce(p_role, 'manager'), crypt(pw, gen_salt('bf')), true, now() + interval '72 hours')
  returning id into uid;
  return jsonb_build_object('id', uid, 'login', k, 'password', pw);
end $function$;

CREATE OR REPLACE FUNCTION public.staff_vendor_user_reset(p_user bigint)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare pw text := _community_temp_pwd(); k text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not ((_staff_mod('vendors', true) or _staff_mod('fnb', true))
          and exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null and s.role in ('admin', 'manager'))) then
    raise exception 'STAFF_ONLY' using errcode = '42501';   -- Vendors' own staff only (bug hunt 2026-10-28)
  end if;
  update vendor_users set password_hash = crypt(pw, gen_salt('bf')), must_change_pwd = true, session_token = null,
         temp_expires_at = now() + interval '72 hours'
   where id = p_user returning login into k;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  delete from vendor_sessions where user_id = p_user;
  delete from login_throttle where identifier = 'vendor:' || k;
  return pw;
end $function$;

CREATE OR REPLACE FUNCTION public.staff_vendor_user_active(p_user bigint, p_active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not ((_staff_mod('vendors', true) or _staff_mod('fnb', true))
          and exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null and s.role in ('admin', 'manager'))) then
    raise exception 'STAFF_ONLY' using errcode = '42501';   -- Vendors' own staff only (bug hunt 2026-10-28)
  end if;
  update vendor_users set active = p_active, session_token = null where id = p_user;
  if not p_active then delete from vendor_sessions where user_id = p_user; end if;
end $function$;

CREATE OR REPLACE FUNCTION public.staff_vendor_decide(p_booking bigint, p_action text, p_note text DEFAULT ''::text, p_by text DEFAULT ''::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b vendor_bookings%rowtype; cap int; n int; v_day date; k int;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not ((_staff_mod('vendors', true) or _staff_mod('fnb', true))
          and exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null and s.role in ('admin', 'manager'))) then
    raise exception 'STAFF_ONLY' using errcode = '42501';   -- Vendors' own staff only (bug hunt 2026-10-28)
  end if;
  perform set_config('vendor.actor', 'staff:' || coalesce(p_by, ''), true);
  select day into v_day from vendor_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  -- The date first, then the booking, each locked: a second staffer deciding the same booking
  -- waits and then reads what the first did (20261005210200).
  select capacity into cap from vendor_dates where day = v_day for update;
  select * into b from vendor_bookings where id = p_booking for update;
  if p_action = 'confirm' then
    if b.status <> 'pending' then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
    select count(*) into n from vendor_bookings where day = b.day and status = 'confirmed';
    if n >= cap then raise exception 'DATE_FULL' using errcode = 'P0001'; end if;
    update vendor_bookings set status = 'confirmed', staff_note = left(coalesce(p_note, ''), 500),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now() where id = b.id and status = 'pending';
    get diagnostics k = row_count;
    if k = 0 then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
    if n + 1 >= cap then
      update vendor_bookings set status = 'declined', staff_note = 'another_venue', decided_by = coalesce(p_by, ''),
             decided_at = now(), updated_at = now()
       where day = b.day and status = 'pending' and id <> b.id;
    end if;
  elsif p_action = 'decline' then
    if b.status <> 'pending' then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
    update vendor_bookings set status = 'declined', staff_note = left(coalesce(p_note, ''), 500),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now() where id = b.id and status = 'pending';
    get diagnostics k = row_count;
    if k = 0 then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
  elsif p_action = 'cancel' then
    if b.status not in ('pending','confirmed') then raise exception 'NOT_LIVE' using errcode = 'P0001'; end if;
    update vendor_bookings set status = 'cancelled', cancelled_by = 'mm', cancel_reason = left(coalesce(p_note, ''), 300),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now()
     where id = b.id and status in ('pending','confirmed');
    get diagnostics k = row_count;
    if k = 0 then raise exception 'NOT_LIVE' using errcode = 'P0001'; end if;
  else
    raise exception 'BAD_ACTION' using errcode = '22023';
  end if;
  perform _vendor_sync_day(b.day);
end $function$;

CREATE OR REPLACE FUNCTION public.staff_vendor_date_set(p_day date, p_state text, p_reason text DEFAULT ''::text, p_capacity integer DEFAULT NULL::integer, p_by text DEFAULT ''::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n int := 0;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not ((_staff_mod('vendors', true) or _staff_mod('fnb', true))
          and exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null and s.role in ('admin', 'manager'))) then
    raise exception 'STAFF_ONLY' using errcode = '42501';   -- Vendors' own staff only (bug hunt 2026-10-28)
  end if;
  if p_state not in ('open','closed','remove') then raise exception 'BAD_STATE' using errcode = '22023'; end if;
  perform set_config('vendor.actor', 'staff:' || coalesce(p_by, ''), true);
  if p_state = 'remove' then
    if exists(select 1 from vendor_bookings where day = p_day) then raise exception 'HAS_BOOKINGS' using errcode = 'P0001'; end if;
    delete from vendor_dates where day = p_day;
    return 0;
  end if;
  insert into vendor_dates (day, state, reason, capacity, updated_by)
  values (p_day, p_state, coalesce(p_reason, ''), coalesce(p_capacity, 1), coalesce(p_by, ''))
  on conflict (day) do update set state = excluded.state, reason = excluded.reason,
     capacity = coalesce(p_capacity, vendor_dates.capacity), updated_by = excluded.updated_by, updated_at = now();
  if p_state = 'closed' then
    update vendor_bookings set status = 'cancelled', cancelled_by = 'mm', cancel_reason = coalesce(nullif(p_reason, ''), 'closed'),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now()
     where day = p_day and status in ('pending','confirmed');
    get diagnostics n = row_count;
    perform _vendor_sync_day(p_day);
  end if;
  return n;
end $function$;

CREATE OR REPLACE FUNCTION public.staff_vendor_dates_open(p_from date, p_to date, p_weekday integer DEFAULT 6)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n int;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not ((_staff_mod('vendors', true) or _staff_mod('fnb', true))
          and exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null and s.role in ('admin', 'manager'))) then
    raise exception 'STAFF_ONLY' using errcode = '42501';   -- Vendors' own staff only (bug hunt 2026-10-28)
  end if;
  if p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_RANGE' using errcode = '22023'; end if;
  insert into vendor_dates (day) select g::date from generate_series(p_from, p_to, interval '1 day') g
   where extract(dow from g)::int = p_weekday on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $function$;

CREATE OR REPLACE FUNCTION public.staff_vendor_venue_save(p jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare vid bigint := nullif(p ->> 'id', '')::bigint;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not ((_staff_mod('vendors', true) or _staff_mod('fnb', true))
          and exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null and s.role in ('admin', 'manager'))) then
    raise exception 'STAFF_ONLY' using errcode = '42501';   -- Vendors' own staff only (bug hunt 2026-10-28)
  end if;
  if vid is null then
    insert into vendor_venues (name, created_by) values (trim(p ->> 'name'), coalesce(p ->> 'by', '')) returning id into vid;
  end if;
  update vendor_venues set
    name          = coalesce(trim(p ->> 'name'), name),
    name_ar       = coalesce(p ->> 'name_ar', name_ar),
    kind          = coalesce(p ->> 'kind', kind),
    area          = coalesce(p ->> 'area', area),
    map_url       = coalesce(p ->> 'map_url', map_url),
    seats         = case when p ? 'seats' then nullif(p ->> 'seats', '')::int else seats end,
    contact_name  = coalesce(p ->> 'contact_name', contact_name),
    contact_phone = coalesce(p ->> 'contact_phone', contact_phone),
    contact_email = coalesce(p ->> 'contact_email', contact_email),
    offer_en      = coalesce(p ->> 'offer_en', offer_en),
    offer_ar      = coalesce(p ->> 'offer_ar', offer_ar),
    staff_notes   = coalesce(p ->> 'staff_notes', staff_notes),
    tier_id       = coalesce(p ->> 'tier_id', tier_id),
    status        = coalesce(p ->> 'status', status),
    updated_at    = now()
   where id = vid;
  -- the venue's confirmed Saturdays still ahead show what was saved, as vendor_profile_save does;
  -- a stop staff typed by hand on a ride stays (20261007120100)
  perform _vendor_sync_day(b.day, true) from vendor_bookings b
   where b.venue_id = vid and b.status = 'confirmed' and b.day >= _vendor_today();
  return vid;
end $function$;

CREATE OR REPLACE FUNCTION public.staff_vendor_share_ratings(p_booking bigint, p_comments jsonb DEFAULT '[]'::jsonb, p_by text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b vendor_bookings%rowtype; keys constant text[] := array['breakfast','bf_restaurant','bf_atmosphere','bf_food','bf_service'];
        n int; av jsonb; cm jsonb; out vendor_shared_ratings%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not ((_staff_mod('vendors', true) or _staff_mod('fnb', true))
          and exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null and s.role in ('admin', 'manager'))) then
    raise exception 'STAFF_ONLY' using errcode = '42501';   -- Vendors' own staff only (bug hunt 2026-10-28)
  end if;
  select * into b from vendor_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if b.status <> 'confirmed' then raise exception 'NOT_CONFIRMED' using errcode = 'P0001'; end if;
  if jsonb_typeof(coalesce(p_comments, '[]'::jsonb)) <> 'array' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  with r as (
    select q.id, q.rating_detail as d from queue_entries q join sessions s on s.id = q.session_id
     where s.session_date = b.day::text and s.event_kind = 'community'
       and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.status <> 'deleted'
       and q.status = 'done' and q.rating_detail ->> 'form' = 'social'
       and coalesce((q.rating_detail ->> 'skip_bf')::boolean, false) = false
       and q.rating_detail -> 's' ? 'breakfast')
  select (select count(*) from r),
         (select coalesce(jsonb_object_agg(x.k, x.a), '{}'::jsonb) from (
            select k, round(avg((r.d -> 's' ->> k)::numeric), 1) as a from r cross join unnest(keys) as k
             where (r.d -> 's' ->> k) ~ '^[0-9]+$' group by k) x),
         (select coalesce(jsonb_agg(jsonb_build_object('k', c.k, 'text', c.t) order by array_position(keys, c.k), c.t), '[]'::jsonb) from (
            select distinct p ->> 'k' as k, r.d -> 'why' ->> (p ->> 'k') as t
              from jsonb_array_elements(coalesce(p_comments, '[]'::jsonb)) p
              join r on r.id = p ->> 'e'
             where (p ->> 'k') = any(keys) and coalesce(r.d -> 'why' ->> (p ->> 'k'), '') <> '') c)
    into n, av, cm;
  insert into vendor_shared_ratings (booking_id, venue_id, day, riders, averages, comments, shared_by, shared_at)
  values (b.id, b.venue_id, b.day, n, av, cm, coalesce(p_by, ''), now())
  on conflict (booking_id) do update set riders = excluded.riders, averages = excluded.averages,
     comments = excluded.comments, shared_by = excluded.shared_by, shared_at = now()
  returning * into out;
  return to_jsonb(out);
end $function$;

CREATE OR REPLACE FUNCTION public.staff_vendor_unshare_ratings(p_booking bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not ((_staff_mod('vendors', true) or _staff_mod('fnb', true))
          and exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null and s.role in ('admin', 'manager'))) then
    raise exception 'STAFF_ONLY' using errcode = '42501';   -- Vendors' own staff only (bug hunt 2026-10-28)
  end if;
  delete from vendor_shared_ratings where booking_id = p_booking;
end $function$;

revoke all on function public.staff_vendor_user_add(bigint, text, text, text) from public, anon;
revoke all on function public.staff_vendor_user_reset(bigint) from public, anon;
revoke all on function public.staff_vendor_user_active(bigint, boolean) from public, anon;
revoke all on function public.staff_vendor_decide(bigint, text, text, text) from public, anon;
revoke all on function public.staff_vendor_date_set(date, text, text, integer, text) from public, anon;
revoke all on function public.staff_vendor_dates_open(date, date, integer) from public, anon;
revoke all on function public.staff_vendor_venue_save(jsonb) from public, anon;
revoke all on function public.staff_vendor_share_ratings(bigint, jsonb, text) from public, anon;
revoke all on function public.staff_vendor_unshare_ratings(bigint) from public, anon;
grant execute on function public.staff_vendor_user_add(bigint, text, text, text) to authenticated, service_role;
grant execute on function public.staff_vendor_user_reset(bigint) to authenticated, service_role;
grant execute on function public.staff_vendor_user_active(bigint, boolean) to authenticated, service_role;
grant execute on function public.staff_vendor_decide(bigint, text, text, text) to authenticated, service_role;
grant execute on function public.staff_vendor_date_set(date, text, text, integer, text) to authenticated, service_role;
grant execute on function public.staff_vendor_dates_open(date, date, integer) to authenticated, service_role;
grant execute on function public.staff_vendor_venue_save(jsonb) to authenticated, service_role;
grant execute on function public.staff_vendor_share_ratings(bigint, jsonb, text) to authenticated, service_role;
grant execute on function public.staff_vendor_unshare_ratings(bigint) to authenticated, service_role;

-- 4 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_void_receipt(p_receipt_id text, p_reason text, p_op text, p_approval text, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  n int; items jsonb; v_uid uuid := auth.uid(); v_claimed int; v_prior jsonb; v_res jsonb;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  -- A void takes the receipt out of the takings: it asks what a refund asks (bug hunt 2026-10-28).
  if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if p_op_id is not null and v_uid is not null then
    insert into rpc_receipts (user_id, op_id, fn) values (v_uid, p_op_id, 'staff_void_receipt')
      on conflict do nothing returning 1 into v_claimed;
    if v_claimed is null then
      select result into v_prior from rpc_receipts where user_id = v_uid and op_id = p_op_id;
      return coalesce(v_prior, jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'count', 0, 'items', '[]'::jsonb)) || jsonb_build_object('replayed', true);
    end if;
    if random() < 0.02 then delete from rpc_receipts where created_at < now() - interval '7 days'; end if;
  end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if not _mgr_ok('refund', (select coalesce(sum(coalesce(c.qty, 0) * coalesce(c.price, 0)), 0) from cashier_sales c
                             where coalesce(c.receipt_id, c.id) = p_receipt_id and c.refunded_at is null and c.voided_at is null
                               and c.pay is distinct from 'house' and c.pay is distinct from 'refunded'
                               and c.category is distinct from '__cardmeta__'), p_approval) then
    raise exception 'MANAGER_REQUIRED' using errcode = '42501';  -- the refund limit in Settings > Business (bug hunt 2026-10-28)
  end if;
  if p_receipt_id is null or not exists (select 1 from cashier_sales where coalesce(receipt_id, id) = p_receipt_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  with u as (
    update cashier_sales
       set voided_at = now(),
           voided_by = left(nullif(btrim(coalesce(p_op, '')), ''), 40),
           void_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 300)
     where coalesce(receipt_id, id) = p_receipt_id and voided_at is null
     returning id, item_id, qty, name, category, pay, price)
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'item_id', item_id, 'qty', qty, 'name', name,
                                               'category', category, 'pay', pay, 'price', price)), '[]'::jsonb)
    into n, items from u;
  v_res := jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'count', n, 'items', items);
  if v_claimed is not null then
    update rpc_receipts set result = v_res where user_id = v_uid and op_id = p_op_id;
  end if;
  return v_res;
end $function$;
revoke all on function public.staff_void_receipt(text, text, text, text, uuid) from public, anon;
grant execute on function public.staff_void_receipt(text, text, text, text, uuid) to authenticated, service_role;

-- 5 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._house_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare k text; pr boolean; amt numeric;
begin
  if not (coalesce(new.paid, false) and coalesce(new.price, 0) = 0) then return new; end if;   -- not on the house
  -- it already was, and is the same rider's ride: a move to another session (a session's new date,
  -- or the rider's) keeps the free ride it had (bug hunt 2026-10-28)
  if coalesce(old.paid, false) and coalesce(old.price, 0) = 0
     and new.type_preference is not distinct from old.type_preference
     and new.customer_id is not distinct from old.customer_id
     and new.name is not distinct from old.name then return new; end if;
  if coalesce(current_setting('mm.house_ok', true), '') = '1' then return new; end if;         -- staff_set_house
  if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;                     -- service role, cron
  if not is_staff() or is_admin() then return new; end if;
  if coalesce(new.type_preference, '') = 'Own' then return new; end if;                        -- a bike owner rides free
  select coalesce(s.event_kind, ''), coalesce(s.paid_ride, false) into k, pr from sessions s where s.id = new.session_id;
  if k = 'community' and not pr then return new; end if;                                        -- a free ride
  if _house_earned(new.customer_id, new.name, new.type_preference) then return new; end if;    -- VIP / default payment
  if coalesce(new.promo_code, '') <> '' and old.price = 0
     and lower(new.promo_code) = lower(coalesce(old.promo_code, '')) then return new; end if;    -- free by its code
  amt := greatest(coalesce(old.price, 0), coalesce(_fare_now(new.session_id, new.id, new.type_preference), 0));
  if amt <= 0 or _mgr_ok('house', amt, null) then return new; end if;
  raise exception 'MANAGER_REQUIRED' using errcode = '42501',
    hint = 'A ride on the house over the limit in Settings > Business needs an approver: staff_set_house.';
end $function$;
revoke all on function public._house_guard() from public, anon, authenticated;
grant execute on function public._house_guard() to service_role;

-- 6 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_last_seen()
 RETURNS TABLE(id text, seen_at timestamp with time zone, via text, signin_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  -- ordered by id: the desk reads it in pages of 1,000 with .range() (bug hunt 2026-10-28)
  return query
    with si as (
      select a.customer_id, max(a.at) as at
        from customer_activity a
       where a.action = 'signin' and a.customer_id is not null
       group by a.customer_id
    )
    select coalesce(s.customer_id, si.customer_id), s.seen_at, s.via, si.at
      from customer_seen s full join si on si.customer_id = s.customer_id
     order by 1;
end $function$;
revoke all on function public.staff_last_seen() from public, anon;
grant execute on function public.staff_last_seen() to authenticated, service_role;

-- checks: every function kept SECURITY DEFINER and its search_path
do $chk$
declare f text;
begin
  foreach f in array array['_promote_next_waitlist','_wl_offer_fill','_purge_old',
                           'staff_vendor_user_add','staff_vendor_user_reset','staff_vendor_user_active','staff_vendor_decide',
                           'staff_vendor_date_set','staff_vendor_dates_open','staff_vendor_venue_save',
                           'staff_vendor_share_ratings','staff_vendor_unshare_ratings',
                           'staff_void_receipt','_house_guard','staff_last_seen'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261028120200', 'bh28_staff')
on conflict (version) do nothing;

commit;
