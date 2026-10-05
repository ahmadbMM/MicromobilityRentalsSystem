-- ============================================================================
-- Vendors and forms: the 2026-10-05 audit, database half (the owner: "fix all but the ones you
-- need a decision from me"). Items numbered as in the audit's database list. Needs
-- 20261005210000 first (_waiver_outdated).
--
--  4. rider_register (the Petromin form, rider_edit) raises WAIVER_OUTDATED (P0001) for a waiver
--     older than the current one (_waiver_outdated); the desk is exempt, as it is from the waiver.
--  9. A shared phone or email no longer takes over another account's pending application:
--     customer_community_apply and customer_learn_apply (with learn_apply behind it) match the
--     pending application by customer_id, or by email / phone only where it has no account.
--     learn_apply learns the account from the transaction setting mm.learn_cid, which only
--     customer_learn_apply sets (learn_apply is no client's to call since 20261004100000).
-- 12. _vendor_riders (the rider count a venue sees) counts riders on the bike too and leaves out
--     approval-ride requests still pending (status waiting / active / done, approval neither
--     pending nor rejected).
-- 17. staff_vendor_decide takes the date's lock, then the booking's (for update), and each update
--     names the status it expects, so two staffers deciding one booking cannot both land.
-- 19. rider_register links a form registration to a booking or an account by its phone only; a
--     name match is the desk's call (staff calls keep it). A stranger's booking with the same name
--     was linked and repriced to the employee fare (_rider_link_reprice, _booking_fare).
-- 20. learn_apply: a resent sign-up merged into a pending one is held to the same five learners
--     as one submission (it allowed six).
-- 24. Venue logins that are phone numbers are their E.164 form (_vendor_phone): 0501..., 9665...
--     and +966 50... are one login. _vendor_login_key does it, so vendor_login and
--     staff_vendor_user_add (and the throttle key) agree; existing digit logins are rewritten
--     (none on 2026-10-05; a rewrite that would collide is left alone with a notice).
-- 25. vendor_users that must change their password and have no expiry get now() + 72 hours (none
--     on 2026-10-05).
-- 26. vendor_login runs one bcrypt round when the login does not exist, so a wrong login takes as
--     long as a wrong password.
-- 27. customer_community_apply takes privacy_version from the form only with privacy_ack = true
--     (the form showed the notice and the rider ticked it); otherwise the account's own, which may
--     be none: the application then carries '' and records no consent (staff_community_approve
--     records none for it, 20261005210100).
-- 28. The Petromin form's Privacy Notice tick is recorded: rider_register takes p_privacy text
--     default null as its last parameter and stores it on every row of the party
--     (rider_registrations.privacy_version, privacy_at; shaped like the waiver). The
--     10-argument function is dropped and the 11-argument one created in this transaction with
--     the same owner, SECURITY DEFINER, search_path and grants (anon, authenticated,
--     service_role), so PostgREST sees one candidate; a caller without p_privacy (rider_edit,
--     today's form) is answered by the default.
-- 29. staff_rider_party_move(p_reg_id bigint, p_session text) returns jsonb: staff move a
--     registration's whole party (its booking number on its night) to another night of the same
--     kind, under that night's next number (rider_night_counters, as rider_edit does; a number
--     already taken there is skipped), and the party's live bookings with it (a new queue number,
--     waitlist -> waiting, as the desk's move did), freeing their places for the old night's
--     waitlist. Answers {ok:true, booking_no, moved, bookings} or {ok:false, error} with error
--     'notfound' | 'session' | 'checked_in' | 'on_bike' | 'duplicate' | 'full'.
-- 32. workshop_request drops a promo code meant for one rental bike type (applies_to).
-- 34. vendor_profile_save syncs the venue's confirmed Saturdays only when what the ride shows
--     changed (the map link or an offer), and then leaves a ride whose stop staff typed by hand:
--     _vendor_sync_day gets p_keep_hand (default false) and, when true, updates only rides still
--     showing the synced name (vendor_dates.synced_name). Its one-argument form is dropped and
--     recreated with the default (callers unchanged; grants as before: service_role only).
--
-- Patched in place from the live definitions (each anchor must match exactly once, or n times
-- where said): rider_register, customer_community_apply, customer_learn_apply, learn_apply,
-- workshop_request, vendor_profile_save. Rewritten whole, headers as live: _vendor_riders,
-- staff_vendor_decide, _vendor_login_key, vendor_login, _vendor_sync_day.
--
-- Rollback: drop function public.staff_rider_party_move(bigint, text); restore rider_register's
-- 10-argument definition (saved pg_get_functiondef) after dropping the 11-argument one, with
-- grants to anon, authenticated, service_role; re-run the saved definitions of the others
-- (_vendor_sync_day: drop the (date, boolean) form, create the (date) one, grant service_role);
-- alter table public.rider_registrations drop column privacy_version, drop column privacy_at.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

do $need$
begin
  if to_regprocedure('public._waiver_outdated(text)') is null then
    raise exception 'run 20261005210000_audit_bookings.sql first (_waiver_outdated is missing)';
  end if;
end $need$;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

create or replace function pg_temp._times(def text, a text, b text, n int) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> n then
    raise exception 'anchor not found % times: %', n, left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


-- ── 28. where the Privacy Notice tick is kept ─────────────────────────────────────────────────
alter table public.rider_registrations add column if not exists privacy_version text;
alter table public.rider_registrations add column if not exists privacy_at timestamptz;
alter table public.rider_registrations drop constraint if exists rider_registrations_privacy_version_shape;
alter table public.rider_registrations add constraint rider_registrations_privacy_version_shape
  check (privacy_version is null or privacy_version ~ '^[A-Za-z0-9._-]{1,40}$');
comment on column public.rider_registrations.privacy_version is
  'The Privacy Notice version the Petromin form showed and the rider ticked (rider_register p_privacy, 20261005210200).';


-- ── 4 + 19 + 28. rider_register: the waiver minimum, phone-only links, p_privacy ──────────────
do $rr$
declare d text;
begin
  if to_regprocedure('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)') is not null then
    raise notice 'rider_register already takes p_privacy; nothing to do';
    return;
  end if;
  d := pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text)'::regprocedure);
  d := pg_temp._once(d,
$a$p_waiver text DEFAULT NULL::text)
 RETURNS jsonb
$a$,
$b$p_waiver text DEFAULT NULL::text, p_privacy text DEFAULT NULL::text)
 RETURNS jsonb
$b$);
  d := pg_temp._once(d,
$a$  if not v_staff and p_waiver is null then return jsonb_build_object('ok', false, 'error', 'waiver'); end if;
$a$,
$b$  if not v_staff and p_waiver is null then return jsonb_build_object('ok', false, 'error', 'waiver'); end if;
  -- A superseded waiver: the form's page is out of date (20261005210200).
  if not v_staff and _waiver_outdated(p_waiver) then raise exception 'WAIVER_OUTDATED' using errcode = 'P0001'; end if;
  -- The Privacy Notice the form showed and the rider ticked, shaped like the waiver (20261005210200).
  if coalesce(p_privacy, '') !~ '^[A-Za-z0-9._-]{1,40}$' then p_privacy := null; end if;
$b$);
  -- A form registration links a booking or an account by its phone only: a name match gave a
  -- stranger's booking the employee fare. A name match is the desk's call (20261005210200).
  d := pg_temp._once(d,
$a$  if v_entry.id is null and v_sess.id is not null then
$a$,
$b$  if v_entry.id is null and v_sess.id is not null and v_staff then   -- by name: the desk only (20261005210200)
$b$);
  d := pg_temp._once(d,
$a$  if v_entry.id is null then
$a$,
$b$  if v_entry.id is null and v_staff then   -- by name: the desk only
$b$);
  d := pg_temp._once(d,
$a$    if v_cust_id is null then
$a$,
$b$    if v_cust_id is null and v_staff then   -- by name: the desk only
$b$);
  d := pg_temp._times(d,
$a$party_no, waiver_version, waiver_at)
$a$,
$b$party_no, waiver_version, waiver_at, privacy_version, privacy_at)
$b$, 2);
  d := pg_temp._times(d,
$a$p_waiver, case when p_waiver is not null then now() end)
$a$,
$b$p_waiver, case when p_waiver is not null then now() end, p_privacy, case when p_privacy is not null then now() end)
$b$, 2);
  d := pg_temp._times(d,
$a$waiver_at = coalesce(excluded.waiver_at, rider_registrations.waiver_at),
$a$,
$b$waiver_at = coalesce(excluded.waiver_at, rider_registrations.waiver_at),
        privacy_version = coalesce(excluded.privacy_version, rider_registrations.privacy_version),
        privacy_at = coalesce(excluded.privacy_at, rider_registrations.privacy_at),
$b$, 2);
  drop function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text);
  execute d;
end $rr$;
alter function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text) owner to postgres;
revoke all on function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text) from public;
grant execute on function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)
  to anon, authenticated, service_role;


-- ── 29. staff_rider_party_move ────────────────────────────────────────────────────────────────
create or replace function public.staff_rider_party_move(p_reg_id bigint, p_session text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r rider_registrations%rowtype; s sessions%rowtype; src text; old_sess text; old_bno text;
  seq int; bno text; tries int := 0; n_regs int; n_bk int := 0; held int; movers int; freed int := 0;
  bk record; qn int; v_day text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into r from rider_registrations where id = p_reg_id;
  if r.id is null then return jsonb_build_object('ok', false, 'error', 'notfound'); end if;
  src := coalesce(r.source, 'petromin');
  old_sess := r.session_id; old_bno := r.booking_no;
  -- The party: one booking number on one night, locked in one order.
  perform 1 from rider_registrations x
   where x.booking_no is not distinct from old_bno and coalesce(x.session_id, '') = coalesce(old_sess, '')
   order by x.id for update;
  if coalesce(p_session, '') = coalesce(old_sess, '') then
    return jsonb_build_object('ok', true, 'booking_no', old_bno, 'moved', 0, 'bookings', 0);
  end if;
  select * into s from sessions where id = p_session for update;
  if s.id is null or coalesce(s.status, '') = 'deleted' or s.ride_kind is distinct from src then
    return jsonb_build_object('ok', false, 'error', 'session');
  end if;
  if exists (select 1 from rider_registrations x
              where x.booking_no is not distinct from old_bno and coalesce(x.session_id, '') = coalesce(old_sess, '')
                and x.checked_in_at is not null) then
    return jsonb_build_object('ok', false, 'error', 'checked_in');
  end if;
  if exists (select 1 from rider_registrations x where x.badge_key = r.badge_key and x.session_id = p_session) then
    return jsonb_build_object('ok', false, 'error', 'duplicate');
  end if;
  -- The party's live bookings: none on a bike, and room for every one that moves.
  if exists (select 1 from queue_entries q
              where q.status = 'active'
                and q.id in (select x.matched_entry_id from rider_registrations x
                              where x.booking_no is not distinct from old_bno and coalesce(x.session_id, '') = coalesce(old_sess, ''))) then
    return jsonb_build_object('ok', false, 'error', 'on_bike');
  end if;
  select count(*) into movers from queue_entries q
   where q.status in ('waiting', 'waitlist') and q.session_id is distinct from p_session
     and q.id in (select x.matched_entry_id from rider_registrations x
                   where x.booking_no is not distinct from old_bno and coalesce(x.session_id, '') = coalesce(old_sess, ''));
  if movers > 0 then
    select count(*) into held from queue_entries q
     where q.session_id = p_session and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
       and ((coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin')
            or coalesce(q.type_preference, '') <> 'Own');
    if held + movers > coalesce(s.capacity, 12) then
      return jsonb_build_object('ok', false, 'error', 'full');
    end if;
  end if;
  -- That night's next number, as rider_edit takes it; one already used there is passed over.
  loop
    insert into rider_night_counters(session_key, source, n) values (p_session, src, 1)
      on conflict (session_key, source) do update set n = rider_night_counters.n + 1 returning n into seq;
    bno := upper(left(src, 1)) || '-' || lpad(seq::text, 3, '0');
    exit when not exists (select 1 from rider_registrations x where coalesce(x.session_id, '') = p_session and x.booking_no = bno);
    tries := tries + 1;
    if tries > 1000 then raise exception 'NO_FREE_NUMBER' using errcode = 'P0001'; end if;
  end loop;
  update rider_registrations set session_id = p_session, booking_no = bno
   where booking_no is not distinct from old_bno and coalesce(session_id, '') = coalesce(old_sess, '');
  get diagnostics n_regs = row_count;
  -- The bookings follow, each with a new number on the new night (as the desk's move did).
  v_day := case when s.day in ('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday') then s.day
              else to_char(s.session_date::date, 'FMDay') end;
  for bk in select q.id, q.status, q.session_id from queue_entries q
             where q.status in ('waiting', 'waitlist') and q.session_id is distinct from p_session
               and q.id in (select x.matched_entry_id from rider_registrations x
                             where x.booking_no = bno and x.session_id = p_session)
             order by q.queue_num for update loop
    update sessions
       set last_qnum = greatest(coalesce(last_qnum, 0),
                                coalesce((select max(x.queue_num) from queue_entries x where x.session_id = p_session), 0)) + 1
     where id = p_session
     returning last_qnum into qn;
    update queue_entries
       set session_id = p_session, session_day = v_day, session_date = s.session_date, queue_num = qn,
           status = 'waiting', waitlist_num = null
     where id = bk.id;
    n_bk := n_bk + 1;
    if bk.status = 'waiting' and bk.session_id is not distinct from old_sess then freed := freed + 1; end if;
  end loop;
  -- The places they held on the old night go to its waitlist.
  while freed > 0 and old_sess is not null and _promote_next_waitlist(old_sess) is not null loop
    freed := freed - 1;
  end loop;
  return jsonb_build_object('ok', true, 'booking_no', bno, 'moved', n_regs, 'bookings', n_bk);
end $$;
revoke all on function public.staff_rider_party_move(bigint, text) from public, anon;
grant execute on function public.staff_rider_party_move(bigint, text) to authenticated;


-- ── 9 + 27. customer_community_apply (patched from live) ──────────────────────────────────────
do $cca$
declare d text;
begin
  d := pg_get_functiondef('public.customer_community_apply(text,text,jsonb)'::regprocedure);
  if position('(20261005210200)' in d) > 0 then
    raise notice 'customer_community_apply already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  v_pv := coalesce(nullif(c.privacy_version,''), p->>'privacy_version', '');
$a$,
$b$  -- The form's notice only when the form showed it and the rider ticked it (privacy_ack); else
  -- the account's own, which may be none: no consent is recorded that was not given (20261005210200).
  v_pv := case when p->>'privacy_ack' = 'true' and coalesce(p->>'privacy_version', '') <> '' then p->>'privacy_version'
               else coalesce(nullif(c.privacy_version,''), '') end;
$b$);
  d := pg_temp._once(d,
$a$  if v_pv !~ '^$a$,
$b$  if v_pv <> '' and v_pv !~ '^$b$);
  d := pg_temp._once(d,
$a$   where x.status = 'pending' and (x.customer_id = p_id or lower(x.email) = v_email or x.phone = v_phone)
$a$,
$b$   -- another account's application stays its own, whatever number or email it shares (20261005210200)
   where x.status = 'pending' and (x.customer_id = p_id or (x.customer_id is null and (lower(x.email) = v_email or x.phone = v_phone)))
$b$);
  execute d;
end $cca$;


-- ── 9. customer_learn_apply (patched from live) ───────────────────────────────────────────────
do $cla$
declare d text;
begin
  d := pg_get_functiondef('public.customer_learn_apply(text,text,jsonb)'::regprocedure);
  if position('(20261005210200)' in d) > 0 then
    raise notice 'customer_learn_apply already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  r := learn_apply((p - 'name'$a$,
$b$  -- learn_apply looks for this account's pending sign-up, not another's on the same number (20261005210200)
  perform set_config('mm.learn_cid', p_id, true);
  r := learn_apply((p - 'name'$b$);
  d := pg_temp._once(d,
$a$         'height', v_height, 'ride_news', coalesce(c.ride_news, false), 'privacy_version', v_pv));
$a$,
$b$         'height', v_height, 'ride_news', coalesce(c.ride_news, false), 'privacy_version', v_pv));
  perform set_config('mm.learn_cid', '', true);
$b$);
  d := pg_temp._once(d,
$a$                  where x.status = 'pending' and (lower(x.email) = v_email or x.phone = v_phone)
                  order by x.updated_at desc limit 1)
$a$,
$b$                  where x.status = 'pending' and (x.customer_id = p_id or (x.customer_id is null and (lower(x.email) = v_email or x.phone = v_phone)))
                  order by (x.customer_id = p_id) desc nulls last, x.updated_at desc limit 1)
$b$);
  execute d;
end $cla$;


-- ── 9 + 20. learn_apply (patched from live) ───────────────────────────────────────────────────
do $la$
declare d text;
begin
  d := pg_get_functiondef('public.learn_apply(jsonb)'::regprocedure);
  if position('(20261005210200)' in d) > 0 then
    raise notice 'learn_apply already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$   where status = 'pending' and (lower(email) = v_email or phone = v_phone)
   order by (lower(email) = v_email) desc, created_at limit 1;
$a$,
$b$   -- The calling account's pending sign-up, or one with no account; never another account's on
   -- the same number or email (customer_learn_apply sets mm.learn_cid; 20261005210200).
   where status = 'pending'
     and (customer_id = nullif(current_setting('mm.learn_cid', true), '')
          or ((customer_id is null or nullif(current_setting('mm.learn_cid', true), '') is null)
              and (lower(email) = v_email or phone = v_phone)))
   order by (customer_id = nullif(current_setting('mm.learn_cid', true), '')) desc nulls last,
            (lower(email) = v_email) desc, created_at limit 1;
$b$);
  d := pg_temp._once(d,
$a$    if jsonb_array_length(v_list) > 6 then return jsonb_build_object('ok', false, 'error', 'learners'); end if;
$a$,
$b$    -- one submission's limit, merged or not (20261005210200)
    if jsonb_array_length(v_list) > 5 then return jsonb_build_object('ok', false, 'error', 'learners'); end if;
$b$);
  execute d;
end $la$;


-- ── 32. workshop_request: no rental-type code on a workshop job (patched from live) ───────────
do $wr$
declare d text;
begin
  d := pg_get_functiondef('public.workshop_request(jsonb)'::regprocedure);
  if position('(20261005210200)' in d) > 0 then
    raise notice 'workshop_request already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  if v_code is not null and (v_code !~ '^[A-Za-z0-9_-]{1,40}$' or not _promo_valid(v_code, v_cust)) then v_code := null; end if;
$a$,
$b$  if v_code is not null and (v_code !~ '^[A-Za-z0-9_-]{1,40}$' or not _promo_valid(v_code, v_cust)) then v_code := null; end if;
  -- A code for one rental bike type discounts no workshop job (20261005210200).
  if v_code is not null and exists (select 1 from promo_codes c where lower(c.code) = lower(v_code) and c.applies_to is not null) then
    v_code := null;
  end if;
$b$);
  execute d;
end $wr$;


-- ── 12. _vendor_riders: on the bike counts, a pending request does not ────────────────────────
CREATE OR REPLACE FUNCTION public._vendor_riders(p_day date)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- riders coming, riding or back; an approval request not yet approved is nobody (20261005210200)
  select count(*)::int from queue_entries q join sessions s on s.id = q.session_id
   where s.session_date = p_day::text and s.event_kind = 'community'
     and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.status <> 'deleted'
     and q.status in ('waiting','active','done') and coalesce(q.approval, '') not in ('pending','rejected')
$function$;


-- ── 17. staff_vendor_decide: the date's lock, then the booking's ──────────────────────────────
CREATE OR REPLACE FUNCTION public.staff_vendor_decide(p_booking bigint, p_action text, p_note text DEFAULT ''::text, p_by text DEFAULT ''::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b vendor_bookings%rowtype; cap int; n int; v_day date; k int;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
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


-- ── 24. a phone login is its E.164 number ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._vendor_login_key(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  -- A phone is its E.164 form (_vendor_phone): 0501..., 9665... and +966 50... are one login;
  -- anything else keeps its digits, as before (20261005210200).
  select case when position('@' in coalesce(p,'')) > 0 then lower(trim(p))
              else coalesce(nullif(_vendor_phone(p), ''),
                            nullif(regexp_replace(coalesce(p,''), '[^[:digit:]]', '', 'g'), '')) end
$function$;

do $logins$
declare n_skip int;
begin
  select count(*) into n_skip from vendor_users u
   where position('@' in u.login) = 0 and _vendor_login_key(u.login) is distinct from u.login
     and (exists (select 1 from vendor_users w where w.login = _vendor_login_key(u.login))
          or (select count(*) from vendor_users z where position('@' in z.login) = 0
                and _vendor_login_key(z.login) = _vendor_login_key(u.login)) > 1);
  if n_skip > 0 then
    raise notice '% venue login(s) would collide with another once normalised: left as they are', n_skip;
  end if;
  update vendor_users u set login = _vendor_login_key(u.login)
   where position('@' in u.login) = 0 and _vendor_login_key(u.login) is not null
     and _vendor_login_key(u.login) <> u.login
     and not exists (select 1 from vendor_users w where w.login = _vendor_login_key(u.login))
     and (select count(*) from vendor_users z where position('@' in z.login) = 0
            and _vendor_login_key(z.login) = _vendor_login_key(u.login)) = 1;
end $logins$;


-- ── 25. a temporary password with no end gets one ─────────────────────────────────────────────
update public.vendor_users set temp_expires_at = now() + interval '72 hours'
 where must_change_pwd and temp_expires_at is null;


-- ── 26. vendor_login: a missing login takes a bcrypt round too ────────────────────────────────
CREATE OR REPLACE FUNCTION public.vendor_login(p_login text, p_pwd text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare k text := _vendor_login_key(p_login); u vendor_users%rowtype; thr login_throttle%rowtype; nf int; tok text;
        gate text; hdr text; ua text; got boolean;
begin
  -- the gate (dormant while vendor_gate is empty): only the portal's Worker knows the secret
  select secret_hash into gate from vendor_gate limit 1;
  if gate is not null then
    begin
      hdr := current_setting('request.headers', true)::json ->> 'x-vendor-gate';
    exception when others then hdr := null;
    end;
    if hdr is null or encode(sha256(convert_to(hdr, 'UTF8')), 'hex') <> gate then
      raise exception 'FORBIDDEN' using errcode = '42501';
    end if;
  end if;
  if k is null or coalesce(p_pwd, '') = '' then raise exception 'BAD_LOGIN' using errcode = '28000'; end if;
  select * into thr from login_throttle where identifier = 'vendor:' || k;
  if thr.locked_until is not null and thr.locked_until > now() then raise exception 'LOCKED' using errcode = 'P0001'; end if;
  select x.* into u from vendor_users x join vendor_venues v on v.id = x.venue_id
   where x.login = k and x.active and v.status <> 'ended';
  got := found;
  -- No such login costs the same bcrypt round as a wrong password: the time says nothing (20261005210200).
  if not got or u.password_hash is null then perform crypt(p_pwd, gen_salt('bf')); end if;
  if not got or u.password_hash is null or crypt(p_pwd, u.password_hash) <> u.password_hash then
    nf := (case when (thr.locked_until is not null and thr.locked_until <= now()) or thr.updated_at < now() - interval '1 day'
                then 0 else coalesce(thr.fails, 0) end) + 1;
    insert into login_throttle(identifier, fails, locked_until, updated_at)
      values ('vendor:' || k, nf, case when nf >= 8 then now() + interval '15 minutes' end, now())
      on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
    return jsonb_build_object('error', 'BAD_LOGIN');
  end if;
  delete from login_throttle where identifier = 'vendor:' || k;
  -- a temporary password lasts 72 hours; staff send a new one after that
  if u.must_change_pwd and u.temp_expires_at is not null and u.temp_expires_at < now() then
    return jsonb_build_object('error', 'TEMP_EXPIRED');
  end if;
  begin
    ua := left(coalesce(current_setting('request.headers', true)::json ->> 'user-agent', ''), 300);
  exception when others then ua := '';
  end;
  tok := encode(gen_random_bytes(32), 'hex');
  delete from vendor_sessions where user_id = u.id and (expires_at <= now() or last_seen < now() - interval '14 days');
  -- at most ten devices at once: the oldest goes
  delete from vendor_sessions where id in (select id from vendor_sessions where user_id = u.id order by last_seen desc offset 9);
  insert into vendor_sessions (user_id, token_hash, expires_at, user_agent)
  values (u.id, sha256(convert_to(tok, 'UTF8')), now() + interval '30 days', ua);
  update vendor_users set last_login_at = now() where id = u.id;
  return jsonb_build_object('id', u.id, 'token', tok, 'must_change', u.must_change_pwd);
end $function$;


-- ── 34. _vendor_sync_day keeps a stop typed by hand when asked ────────────────────────────────
drop function if exists public._vendor_sync_day(date);
CREATE OR REPLACE FUNCTION public._vendor_sync_day(p_day date, p_keep_hand boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v vendor_venues%rowtype; old_name text;
begin
  perform set_config('vendor.sync', '1', true);
  select synced_name into old_name from vendor_dates where day = p_day;
  select ve.* into v from vendor_bookings b join vendor_venues ve on ve.id = b.venue_id
   where b.day = p_day and b.status = 'confirmed' order by b.decided_at nulls last, b.id limit 1;
  if found then
    update sessions s set breakfast_name = v.name, breakfast_url = nullif(v.map_url, ''),
           breakfast_name_ar = nullif(trim(v.name_ar), ''), breakfast_offer_en = nullif(trim(v.offer_en), ''),
           breakfast_offer_ar = nullif(trim(v.offer_ar), '')
     where s.session_date = p_day::text and s.event_kind = 'community'
       and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.status <> 'deleted'
       -- a venue's own edit leaves a stop staff typed by hand (20261005210200)
       and (not coalesce(p_keep_hand, false) or s.breakfast_name is not distinct from old_name)
       and (s.breakfast_name is distinct from v.name or s.breakfast_url is distinct from nullif(v.map_url, '')
            or s.breakfast_name_ar is distinct from nullif(trim(v.name_ar), '')
            or s.breakfast_offer_en is distinct from nullif(trim(v.offer_en), '')
            or s.breakfast_offer_ar is distinct from nullif(trim(v.offer_ar), ''));
    update vendor_dates set synced_name = v.name where day = p_day;
  elsif old_name is not null then
    update sessions s set breakfast_name = null, breakfast_url = null,
           breakfast_name_ar = null, breakfast_offer_en = null, breakfast_offer_ar = null
     where s.session_date = p_day::text and s.event_kind = 'community'
       and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.breakfast_name = old_name;
    update vendor_dates set synced_name = null where day = p_day;
  end if;
  perform set_config('vendor.sync', '', true);
end $function$;
revoke all on function public._vendor_sync_day(date, boolean) from public, anon, authenticated;
grant execute on function public._vendor_sync_day(date, boolean) to service_role;


-- ── 34. vendor_profile_save syncs only what the ride shows (patched from live) ────────────────
do $vps$
declare d text;
begin
  d := pg_get_functiondef('public.vendor_profile_save(bigint,text,jsonb)'::regprocedure);
  if position('(20261005210200)' in d) > 0 then
    raise notice 'vendor_profile_save already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$        cn text; cp text; ce text; oe text; oa text; mu text;
$a$,
$b$        cn text; cp text; ce text; oe text; oa text; mu text; o vendor_venues%rowtype;
$b$);
  d := pg_temp._once(d,
$a$  update vendor_venues set
$a$,
$b$  select * into o from vendor_venues where id = u.venue_id;
  update vendor_venues set
$b$);
  d := pg_temp._once(d,
$a$  -- the offer rides on the venue's confirmed Saturdays still ahead
  perform _vendor_sync_day(b.day) from vendor_bookings b
   where b.venue_id = u.venue_id and b.status = 'confirmed' and b.day >= _vendor_today();
$a$,
$b$  -- The offer rides on the venue's confirmed Saturdays still ahead: only when what the ride shows
  -- changed (the map link, an offer), and never over a stop staff typed by hand (20261005210200).
  if coalesce(mu, o.map_url) is distinct from o.map_url
     or coalesce(oe, o.offer_en) is distinct from o.offer_en
     or coalesce(oa, o.offer_ar) is distinct from o.offer_ar then
    perform _vendor_sync_day(b.day, true) from vendor_bookings b
     where b.venue_id = u.venue_id and b.status = 'confirmed' and b.day >= _vendor_today();
  end if;
$b$);
  execute d;
end $vps$;


-- ── checks ────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text; acl text;
begin
  foreach f in array array['rider_register','staff_rider_party_move','customer_community_apply','customer_learn_apply',
                           'learn_apply','workshop_request','_vendor_riders','staff_vendor_decide','vendor_login',
                           '_vendor_sync_day','vendor_profile_save'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef) then
      raise exception '% is missing or lost SECURITY DEFINER', f;
    end if;
  end loop;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_vendor_login_key' and p.prosecdef) then
    raise exception '_vendor_login_key became SECURITY DEFINER';
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
               and p.proname in ('rider_register','staff_rider_party_move','customer_community_apply','customer_learn_apply',
                                 'learn_apply','workshop_request','_vendor_riders','staff_vendor_decide','vendor_login',
                                 '_vendor_sync_day','vendor_profile_save','_vendor_login_key')
               and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'a function lost its search_path';
  end if;
  -- one rider_register, the 11-argument one, as the old one was granted
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'rider_register') <> 1
     or to_regprocedure('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)') is null then
    raise exception 'rider_register is not the one 11-argument function';
  end if;
  select p.proacl::text into acl from pg_proc p where p.oid = 'public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)'::regprocedure;
  if acl like '%{=X%' or acl like '%,=X%'
     or not has_function_privilege('anon', 'public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)', 'execute') then
    raise exception 'rider_register grants differ from before: %', acl;
  end if;
  if position('p_privacy' in pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)'::regprocedure)) = 0
     or position('WAIVER_OUTDATED' in pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)'::regprocedure)) = 0 then
    raise exception 'rider_register was not rebuilt';
  end if;
  if position('(20261005210200)' in pg_get_functiondef('public.customer_community_apply(text,text,jsonb)'::regprocedure)) = 0
     or position('(20261005210200)' in pg_get_functiondef('public.customer_learn_apply(text,text,jsonb)'::regprocedure)) = 0
     or position('(20261005210200)' in pg_get_functiondef('public.learn_apply(jsonb)'::regprocedure)) = 0
     or position('(20261005210200)' in pg_get_functiondef('public.workshop_request(jsonb)'::regprocedure)) = 0
     or position('(20261005210200)' in pg_get_functiondef('public.vendor_profile_save(bigint,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'a patch did not take';
  end if;
  if to_regprocedure('public._vendor_sync_day(date)') is not null
     or to_regprocedure('public._vendor_sync_day(date,boolean)') is null then
    raise exception '_vendor_sync_day is not the one (date, boolean) function';
  end if;
  if has_function_privilege('anon', 'public._vendor_sync_day(date,boolean)', 'execute')
     or has_function_privilege('authenticated', 'public._vendor_sync_day(date,boolean)', 'execute')
     or has_function_privilege('anon', 'public.staff_rider_party_move(bigint,text)', 'execute')
     or has_function_privilege('anon', 'public.learn_apply(jsonb)', 'execute') then
    raise exception 'a function is executable by a client that should not be';
  end if;
  if not has_function_privilege('authenticated', 'public.staff_rider_party_move(bigint,text)', 'execute')
     or not has_function_privilege('anon', 'public.customer_community_apply(text,text,jsonb)', 'execute')
     or not has_function_privilege('anon', 'public.customer_learn_apply(text,text,jsonb)', 'execute')
     or not has_function_privilege('anon', 'public.workshop_request(jsonb)', 'execute')
     or not has_function_privilege('anon', 'public.vendor_login(text,text)', 'execute')
     or not has_function_privilege('anon', 'public.vendor_profile_save(bigint,text,jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_vendor_decide(bigint,text,text,text)', 'execute') then
    raise exception 'a client grant is missing';
  end if;
  if _vendor_login_key('0501234567') <> '+966501234567' or _vendor_login_key('966501234567') <> '+966501234567'
     or _vendor_login_key('+966 50 123 4567') <> '+966501234567' or _vendor_login_key('Cafe@Example.TEST ') <> 'cafe@example.test'
     or _vendor_login_key('abc12') <> '12' or _vendor_login_key('abc') is not null then
    raise exception '_vendor_login_key does not answer as expected';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'rider_registrations' and column_name = 'privacy_version') then
    raise exception 'rider_registrations.privacy_version is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261005210200', 'audit_vendors_forms')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
