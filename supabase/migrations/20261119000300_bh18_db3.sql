-- ============================================================================
-- Bug hunt 2026-11-18 (bh18), database fixes, package db3 (prod and staging).
--
-- sql08-4  my_bookings returned the whole booking row to the rider, staff's own marks with it: the check-in state staff
--          put on it (staff_state), when they sent "Running late?" (late_msg_at) and who checked the rider in and took
--          the bike back (checked_in_by / checked_out_by, staff names). They come back empty now, as the desk note and
--          the Petromin visitor mark already did. The rider app reads none of them.
-- sql08-3  petromin_guest_book: a guest's Edit onto another Petromin night that only had a waitlist place there
--          cancelled the confirmed booking they held. Such a move is undone now and answers {ok:false, error:'full'};
--          the booking they hold stays. (The Petromin page says its generic "could not save" for 'full' until it
--          words it.)
-- sql09-4  rider_register: a phone's resubmission could add its own four companions to a party the desk had already
--          filled (rider_party_add's five-rider cap counts the whole party; the form's counted its own companions
--          only), giving one P- number nine riders. The desk's companions now count: more than five riders in all
--          answers 'riders' before anything is written.
-- sql14-1  The Door role (20261111180500) could still write every table whose write policy only asks is_staff()
--          (Saturday, farm and partner codes, badges, titles, waitlist offers, registrations, the operator list, ...)
--          straight through the API. The same a_door_guard trigger (_door_write_guard) now sits on each of them; it
--          refuses only a Door account's own write (not what a trigger does after its check-in), so nobody else
--          changes. bike_assignments and staff_actions stay open to it, as before (its check-in and its log).
-- sql09-2 / app29-2  staff_checkin, staff_bulk_checkin, staff_return, staff_bulk_return and staff_close_out asked only
--          is_staff(): a view-only Owner, or an account without Bookings' edit right, could check riders in, set
--          payments, mark no-shows, return bikes and mark them Missing by calling them directly. They ask Bookings'
--          edit right now (_staff_mod('queue', true), STAFF_ONLY as staff_cancel_session); a Door account still checks
--          riders in (staff_checkin, staff_bulk_checkin), held to that by its trigger.
-- sql09-3  staff_checkin on a booking another desk had already checked in answered ok/noop and dropped the payment it
--          carried, so cash taken on the second device never reached the booking. The payment is recorded when the
--          booking is not paid yet (paid_now: true); one already paid is not written over (already_paid: true).
-- sql09-1  The community application functions asked only is_staff(): staff_community_approve, _decide and
--          _ask_changes now ask the Community section's edit right (_staff_mod('community', true), which People's
--          edit right also passes), and staff_community_new_password / staff_learn_new_password the rule of
--          staff_set_customer_temp_password: an admin, or a manager or front desk account with that edit right. The
--          "staff update applications" policy on community_applications asks the same edit right.
-- sql10-3  staff_fnb_decide checked a partner request's status on an unlocked copy: two staff deciding it at once (or
--          the venue cancelling it) and the last write won. It reads the request again under a lock after the date's,
--          and each write names the status it leaves (NOT_PENDING / NOT_LIVE otherwise).
-- sql10-5  staff_learn_schedule linked a learn-to-ride sign-up to the oldest account on the same phone even when that
--          account had another email (a family phone), filled its empty fields with the learner's details and made no
--          account for the learner. The phone match now takes only an account with no email or the same email;
--          otherwise the learner gets an account of their own (a shared phone is allowed).
-- sql10-7  staff_locker_cancel: an admin's Cancel that gives a locker fee back to the wallet (or off a paid ride's
--          bill) skipped the operator PIN and the manager's approval over the owner's refund limit that
--          staff_locker_refund asks for the same money. It asks them now (PIN_REQUIRED / MANAGER_REQUIRED) and takes
--          p_op / p_approval (two new arguments with defaults; the old four-argument function is dropped so a call
--          is never ambiguous).
-- sql10-4  staff_locker_house made a locker free with no manager approval, past the owner's "on the house" limit that
--          a ride on the house is held to (_house_guard). Non-admins now need _mgr_ok('house', fee, approval); the
--          page already asks for it (it calls with kind 'house' and retries through the approver on MANAGER_REQUIRED).
-- sql10-6  staff_merge_customers left the mentorship records (mentor_profiles, mentor_mentors, mentor_offers,
--          mentor_checks) on the merged-away account, so the member lost their mentee profile or mentor card and could
--          register again. They move to the keeper now (a live one only while the keeper has none) and are recorded,
--          and staff_unmerge_customers moves them back.
-- sql10-1  staff_move_session copies a session to its new id and deletes the old row, re-pointing a hand-kept list of
--          tables: the Farmhouse code (farm_codes), the night's crew (session_crew), volunteer feedback and ratings were
--          deleted with it (on delete cascade) and hub posts and circuit laps lost their night. Every table with a
--          foreign key to sessions now follows the move (read from pg_constraint, so later tables do too), and a row
--          left naming the old id stops the move (MOVE_LEFT_ROWS) instead of being deleted. _session_crew_stamp, which
--          keeps a crew row's night on update, lets a move through (mm.session_move).
--
-- Rebuilt whole from the live text (pg_get_functiondef; the body's md5 is checked in $pre$ below, on prod and staging
-- alike; headers unchanged, so SECURITY DEFINER and search_path stay):
--   my_bookings             20261009200000_desk_note.sql with 20261117120000's in-place pm_visitor line
--   petromin_guest_book     20261113150000_petromin_merged_page.sql
--   staff_checkin           20261107100000_bookings_review.sql
--   staff_fnb_decide        20261003150000_fnb_partners.sql
--   staff_locker_cancel     20261111235100_bh11_live_b.sql (+ p_op, p_approval; the 4-argument one dropped)
--   staff_locker_house      20261110200000_locker_staff_edit.sql
--   staff_merge_customers, staff_unmerge_customers, staff_move_session   20261111235100_bh11_live_b.sql
-- Patched in place (pg_get_functiondef + exact-count text replaces; each block skips itself once applied):
--   rider_register (12 arguments: 20260922235500 and the in-place patches up to 20261114030000)
--   staff_bulk_checkin, staff_bulk_return, staff_close_out (20261111180000), staff_return (20261107100000)
--   staff_community_approve (20260930160000 + patches to 20261007120100), staff_community_decide,
--   staff_community_new_password (20260922200000 + 20261007120100), staff_community_ask_changes (20260930200000 +
--   20261007223000, 20261011120000), staff_learn_new_password (20260928210000), staff_learn_schedule
--   (20260930170000 + 20261004145000, 20261005210100), _session_crew_stamp (20261118230000; skipped where absent)
-- Grants as they were (CREATE OR REPLACE keeps them; restated for the staff functions; the new staff_locker_cancel
-- gets the old one's: authenticated). Data: none changed.
--
-- Client follow-ups (not needed for this file to be safe; each works as before until then):
--   * Petromin page (mm-platform forms/petromin): petromin_guest_book's 'full' -> back to the session step,
--     "This night is full. Your booking stays as it was."
--   * Petromin page: 'riders' after the desk added companions -> the existing f-riders error is shown; a line saying the
--     party is five riders at most counting the desk's would be clearer.
--   * Booking app (_lkCancelAsk): an admin's Refund cancel should call staff_locker_cancel with _pinArgs() and, on
--     PIN_REQUIRED / MANAGER_REQUIRED, retry through _gatedRpc(..., {kind:'refund', amount:r.price}) as Refund does;
--     until then such a cancel over the owner's refund limit is refused with the approval message.
--   * Booking app (check-in drawer, noop branch): when staff_checkin answers already_paid with a payment sent, say the
--     rider had paid already (the second desk took money twice); paid_now needs nothing (the reload shows Paid).
--
-- Rollback: re-run the definitions named above from their files (my_bookings with the 20261117120000 line,
--   staff_locker_cancel(uuid,text,boolean,boolean) from 20261111235100 then drop the 6-argument one); for the in-place
--   patches remove the lines marked (20261119000300); drop trigger a_door_guard on the tables in section 11; re-create
--   "staff update applications" with (select is_staff()).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(src text, a text, b text, n integer default 1) returns text
language plpgsql as $f$
declare c integer := (length(src) - length(replace(src, a, ''))) / greatest(length(a), 1);
begin
  if c <> n then raise exception 'bh18_db3: expected % of [%], found %', n, left(a, 90), c; end if;
  return replace(src, a, b);
end $f$;

-- Every function rebuilt whole below must still be the live text this file was built from (md5 of the body, rebuilt
-- from the migrations and matching the md5 recorded by 20261111235100 and 20261117120000), or already this file's
-- (a re-run): else stop, rather than undo a change made since.
do $pre$
declare f record; m text;
begin
  for f in select * from (values
    ('public.my_bookings(text,text)', '3390e30044b3f29e7a25fea2b85ea41a', '29d39bb236a591a32a5ddc0012a52c1f'),
    ('public.petromin_guest_book(text,text,text,text,text,text,text,text)', '1e2508ef7c1eff3fd461f1278d792260', 'bf6b0d89ef5a70f9ef93b05492dbd818'),
    ('public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid,text)', '5db73b25c023f83951a6d616d3ec54bc', '7237c9a27e55597cd7657f17632a3ab1'),
    ('public.staff_fnb_decide(bigint,text,text,text)', 'ab1034641c76fe84ffb12fd43055e9a7', 'cc0b801c289612d974029f05661260ee'),
    ('public.staff_locker_house(uuid,boolean,text,text)', '0653e807002edd995c8b21b8326d8558', '8aab63d9d6d7c7d57ceb967eba6688a7'),
    ('public.staff_merge_customers(text,text,text,text,text)', '407201e12effe2f5d3658d37f2c6bf68', 'c17c9f5da33684dfc4bdb692d96917cf'),
    ('public.staff_unmerge_customers(bigint)', '1a3eed720857b6db773768e236cbd86e', '4e21ff5cb31fb9c29fb2605b3e264e95'),
    ('public.staff_move_session(text,text,text,boolean)', '5bea0f612c84201dfbd89bdb07fa8c80', '15dc7b4e8516d9f0f586f082ce8c1aaa')
  ) v(fn, was, now_) loop
    select md5(p.prosrc) into m from pg_proc p where p.oid = to_regprocedure(f.fn);
    if m is distinct from f.was and m is distinct from f.now_ then
      raise exception '% changed since this file was written (md5 %): rebuild it from the live definition', f.fn, m;
    end if;
  end loop;
  -- staff_locker_cancel: the four-argument one is the live text, or gone because this file ran (the six-argument one)
  select md5(p.prosrc) into m from pg_proc p where p.oid = to_regprocedure('public.staff_locker_cancel(uuid,text,boolean,boolean)');
  if m is not null and m <> '4b16af77a16c2ea70d26d0798cd010ec' then
    raise exception 'staff_locker_cancel(uuid,text,boolean,boolean) changed since this file was written (md5 %)', m;
  end if;
  select md5(p.prosrc) into m from pg_proc p where p.oid = to_regprocedure('public.staff_locker_cancel(uuid,text,boolean,boolean,text,text)');
  if m is not null and m <> '9ce3d7888b88cc4c0689e89320c5d1dd' then
    raise exception 'staff_locker_cancel(uuid,text,boolean,boolean,text,text) is not this file''s (md5 %)', m;
  end if;
end $pre$;

-- ── 1. sql08-4 my_bookings: staff's marks stay with staff ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.my_bookings(p_id text, p_token text)
 RETURNS SETOF queue_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare r queue_entries;
begin
  if not _cust_token_ok(p_id,p_token) then return; end if;
  /* the staff's desk note stays with staff */
  for r in select * from queue_entries where customer_id = p_id loop
    r.desk_note := null;
    r.pm_visitor := false;   /* the visitor mark is staff's too (20261117120000) */
    /* and so are the check-in state staff put on the booking, when they sent "Running late?", and who checked the
       rider in and took the bike back (20261107100000, 20261107101000; bh18 sql08-4) (20261119000300) */
    r.staff_state := null;
    r.late_msg_at := null;
    r.checked_in_by := null;
    r.checked_out_by := null;
    return next r;
  end loop;
end $function$;
-- grants unchanged (anon, authenticated: a rider's own token-checked read)

-- ── 2. sql08-3 petromin_guest_book: an edit onto a full night keeps the place held ───────────────────────────────
CREATE OR REPLACE FUNCTION public.petromin_guest_book(p_id text, p_token text, p_session_id text, p_type text, p_company text, p_waiver text DEFAULT NULL::text, p_from_no text DEFAULT NULL::text, p_from_session text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_type text := coalesce(p_type, '');
  v_company text := left(btrim(regexp_replace(coalesce(p_company, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 120);
  v_today text := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  v_stamp text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_from_no text := upper(trim(coalesce(p_from_no, '')));
  v_cust customers%rowtype;
  v_sess sessions%rowtype; v_win record;
  v_from queue_entries%rowtype; v_prev queue_entries%rowtype; v_row queue_entries%rowtype;
  v_asks text[]; v_no text; v_new_id text; v_err text;
begin
  if not _rider_gate() then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  select * into v_cust from customers where id = p_id;
  if coalesce(p_waiver, '') !~ '^[A-Za-z0-9._-]{1,40}$' then return jsonb_build_object('ok', false, 'error', 'waiver'); end if;
  if _waiver_outdated(p_waiver) then raise exception 'WAIVER_OUTDATED' using errcode = 'P0001'; end if;
  -- The company as typed: two characters or more, not punctuation alone.
  if length(v_company) < 2 or v_company !~ '[^[:punct:][:space:]]' then
    return jsonb_build_object('ok', false, 'error', 'company');
  end if;
  if v_type not in ('Road', 'Hybrid', 'Mountain') then return jsonb_build_object('ok', false, 'error', 'type'); end if;
  -- What the account owes (an emergency contact, the nationality from the second booking on, a field staff
  -- flagged) is answered first, as before any booking of its own.
  v_asks := coalesce(_customer_asks(p_id), '{}'::text[]);
  if cardinality(v_asks) > 0 then
    return jsonb_build_object('ok', false, 'error', 'fix', 'fields', to_jsonb(v_asks));
  end if;

  -- An open Petromin night that has not ended, open to everyone (never one for men or women only).
  select * into v_sess from sessions where id = p_session_id;
  if v_sess.id is null or coalesce(v_sess.ride_kind, '') <> 'petromin' or not _rider_session_open(v_sess)
     or v_sess.session_date < v_today or v_sess.gender_only is not null then
    return jsonb_build_object('ok', false, 'error', 'session');
  end if;
  select * into v_win from _session_window(v_sess);
  if v_win.ends_at <= now() then return jsonb_build_object('ok', false, 'error', 'session'); end if;

  -- The booking being edited: this account's, by its number on its night, still waiting.
  if v_from_no <> '' then
    select * into v_from from queue_entries q
     where q.invite_no = v_from_no and q.session_id = coalesce(p_from_session, '') and q.customer_id = p_id
       and q.status in ('waiting', 'waitlist', 'active', 'done')
     order by q.queue_num limit 1;
    if v_from.id is null then return jsonb_build_object('ok', false, 'error', 'notfound'); end if;
    if v_from.status in ('active', 'done') then
      return jsonb_build_object('ok', false, 'error', 'checked_in', 'invite_no', v_from.invite_no);
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('invite:' || v_sess.id || ':' || p_id));
  if v_from.id is not null and v_from.session_id = v_sess.id then
    v_prev := v_from;
  else
    select * into v_prev from queue_entries q
     where q.session_id = v_sess.id and q.invite_no is not null and q.customer_id = p_id
       and q.status in ('waiting', 'waitlist', 'active', 'done')
     order by q.queue_num limit 1;
  end if;
  if v_prev.id is not null and v_prev.status in ('active', 'done') then
    return jsonb_build_object('ok', false, 'error', 'checked_in', 'invite_no', v_prev.invite_no);
  end if;
  -- The account already rides this night on a booking of its own (a member's, a Petromin tag holder's): not twice.
  if v_prev.id is null and exists (
       select 1 from queue_entries q
        where q.session_id = v_sess.id and q.customer_id = p_id and q.invite_no is null
          and q.status in ('waiting', 'waitlist', 'active', 'done')
          and lower(btrim(coalesce(q.name, ''))) = lower(btrim(coalesce(v_cust.name, '')))) then
    return jsonb_build_object('ok', false, 'error', 'booked');
  end if;

  begin
    if v_prev.id is not null then
      update queue_entries
         set type_preference = v_type, invite_company = v_company, waiver_version = p_waiver, waiver_at = v_stamp
       where id = v_prev.id
      returning * into v_row;
    else
      v_no := _invite_next(v_sess.id);
      perform set_config('mm.invite', v_sess.id || '|' || v_no, true);
      select b.id into v_new_id
        from customer_create_booking(p_id, p_token, jsonb_build_array(jsonb_build_object(
               'session_id', v_sess.id, 'name', coalesce(v_cust.name, ''), 'type_preference', v_type,
               'waiver_version', p_waiver, 'height', v_cust.height))) b
       limit 1;
      if v_new_id is null then raise exception 'GUEST_NO_ROW'; end if;
      update queue_entries set invite_no = v_no, invite_company = v_company, via = 'invite'
       where id = v_new_id
      returning * into v_row;
      /* An edit onto another night that only has a waitlist place there keeps the place it holds (bh18 sql08-3)
         (20261119000300): the new booking and its I- number are undone below and the page is told 'full'. */
      if v_from.id is not null and v_from.status = 'waiting' and v_row.status = 'waitlist' then
        raise exception 'GUEST_FULL';
      end if;
      perform set_config('mm.invite', '', true);
    end if;
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform set_config('mm.invite', '', true);
    if v_err = 'TYPE_CLOSED' then return jsonb_build_object('ok', false, 'error', 'type_closed'); end if;
    if v_err = 'TYPE_FULL' then return jsonb_build_object('ok', false, 'error', 'type_full'); end if;
    if v_err = 'FIX_FIRST' then
      return jsonb_build_object('ok', false, 'error', 'fix', 'fields', to_jsonb(coalesce(_customer_asks(p_id), '{}'::text[])));
    end if;
    if v_err in ('STALE_SESSION', 'ACCOUNT_ARCHIVED') then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
    if v_err = 'SESSION_CLOSED' then return jsonb_build_object('ok', false, 'error', 'session'); end if;
    if v_err = 'GUEST_FULL' then return jsonb_build_object('ok', false, 'error', 'full', 'invite_no', v_from.invite_no); end if;
    raise;
  end;

  -- Edited onto another night: the old booking goes.
  if v_from.id is not null and v_from.id <> v_row.id then
    update queue_entries set status = 'cancelled', cancelled_by = 'customer' where id = v_from.id;
  end if;
  -- The company is the account's too.
  update customers set workplace = v_company where id = p_id and coalesce(workplace, '') <> v_company;

  return jsonb_build_object(
    'ok', true, 'resubmitted', v_prev.id is not null, 'booking_no', v_row.invite_no, 'invite_no', v_row.invite_no,
    'ref', 'MMC-' || v_row.queue_num || '-' || left(v_row.id, 6),
    'status', v_row.status, 'name', v_row.name, 'phone', v_row.phone, 'type', v_row.type_preference,
    'company', v_row.invite_company, 'price', v_row.price,
    'session', jsonb_build_object('id', v_sess.id, 'title', v_sess.title,
      'start', to_char(v_win.starts_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
      'end',   to_char(v_win.ends_at   at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
      'collect', _rider_collect(v_sess),
      'place', nullif(trim(coalesce(v_sess.location, '')), '')));
end $function$;
revoke all on function public.petromin_guest_book(text, text, text, text, text, text, text, text) from public;
grant execute on function public.petromin_guest_book(text, text, text, text, text, text, text, text) to anon, authenticated;

-- ── 3. sql09-4 rider_register: the desk's companions count toward the five riders ────────────────────────────────
do $rr$
declare d text;
begin
  if to_regprocedure('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,text)') is null then
    raise exception 'rider_register (12 arguments) is missing';
  end if;
  d := pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,text)'::regprocedure);
  if position('(20261119000300)' in d) > 0 then raise notice 'rider_register already counts the desk''s companions'; return; end if;
  d := pg_temp._once(d,
$a$    v_bno := _rider_next_no(v_sess.id, v_company, v_src);
  end if;
$a$,
$b$    v_bno := _rider_next_no(v_sess.id, v_company, v_src);
  end if;
  /* The whole party is five riders at most, the companions the desk added counted (rider_party_add's rule; bh18
     sql09-4) (20261119000300): a phone's resubmission skips the desk's party numbers below, so its own four took the
     party past five. Checked under the party's lock, before anything is written. The desk's own calls are unchanged. */
  if not v_staff and v_n_extra > 0 then
    perform pg_advisory_xact_lock(hashtext('rider-party:' || coalesce(v_sess.id, '') || ':' || v_bno));
    if 1 + v_n_extra + (select count(*) from rider_registrations r
                         where r.badge_key = lower(regexp_replace(v_badge, '[^a-zA-Z0-9]', '', 'g'))
                           and coalesce(r.session_id,'') = coalesce(v_sess.id,'') and r.added_by_desk) > 5 then
      return jsonb_build_object('ok', false, 'error', 'riders');
    end if;
  end if;
$b$);
  execute d;
end $rr$;

-- ── 4. sql09-2 / app29-2 / sql09-3 the desk's writes: Bookings' edit right; a late check-in keeps its payment ─────
CREATE OR REPLACE FUNCTION public.staff_checkin(p_booking_id text, p_bike_id text DEFAULT NULL::text, p_paid boolean DEFAULT NULL::boolean, p_price numeric DEFAULT NULL::numeric, p_pay_method text DEFAULT NULL::text, p_card_amount numeric DEFAULT NULL::numeric, p_type text DEFAULT NULL::text, p_ride_group text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid, p_at text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid := auth.uid(); v_claimed int; v_prior jsonb; v_res jsonb; q public.queue_entries%rowtype; b public.bikes%rowtype; a_id uuid; first_a uuid; holder text;
        got text[] := '{}'; rsv text[]; bid text; dropped boolean := false; st text; new_bike text;
        v_by text := (select left(nullif(btrim(s.display_name), ''), 60) from public.staff s where s.user_id = auth.uid());   /* (20261107100000) */
        v_late_pay boolean := false;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  /* Bookings' edit right (bh18 sql09-2) (20261119000300): a view-only Owner, a mechanic or a cashier no longer
     checks riders in or sets their payment here. A Door account has no section to change but checks riders in
     (20261111180500); its trigger keeps it to that. */
  if not (_staff_mod('queue', true) or _staff_is_door()) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  /* the desk outbox's op id (20261009215000): a replay of a call that landed is answered from its receipt */
  if p_op_id is not null and v_uid is not null then
    insert into rpc_receipts (user_id, op_id, fn) values (v_uid, p_op_id, 'staff_checkin')
      on conflict do nothing returning 1 into v_claimed;
    if v_claimed is null then
      select result into v_prior from rpc_receipts where user_id = v_uid and op_id = p_op_id;
      return coalesce(v_prior, jsonb_build_object('ok', true, 'noop', true)) || jsonb_build_object('replayed', true);
    end if;
    if random() < 0.02 then delete from rpc_receipts where created_at < now() - interval '7 days'; end if;
  end if;
  if p_price is not null and (p_price < 0 or p_price > 5000) then raise exception 'PRICE_RANGE' using errcode = '22023'; end if;   -- the event seat's ceiling (20261005210000)
  if p_card_amount is not null and (p_card_amount < 0 or p_card_amount > 100000) then raise exception 'PRICE_RANGE' using errcode = '22023'; end if;
  if p_pay_method is not null and p_pay_method !~ '^[a-z_]{0,24}$' then raise exception 'BAD_PAY_METHOD: %', p_pay_method using errcode = '22023'; end if;

  select * into q from public.queue_entries where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND: no booking %', p_booking_id; end if;
  if p_bike_id is not null then
    select * into b from public.bikes where id = p_bike_id for update;
    if not found then raise exception 'BIKE_NOT_FOUND: no bike %', p_bike_id; end if;
  end if;

  if q.status = 'active' then
    /* Already checked in (another desk, or the outbox replaying a check-in another device made first): the payment
       this call carries is still recorded when the booking is not paid yet, as the check-in itself records it (bh18
       sql09-3) (20261119000300). It was dropped with the no-op, so cash taken on the second device never reached the
       booking. A payment for a booking already paid is not written over: the answer says so (already_paid). A bike
       that cannot be handed over raises below, which undoes this too. */
    if coalesce(p_paid, false) and not coalesce(q.paid, false) then
      update public.queue_entries
         set paid = true,
             price = coalesce(p_price, price),
             pay_method = case when p_pay_method is null then pay_method else nullif(p_pay_method, '') end,
             card_amount = case when p_pay_method is null then card_amount else p_card_amount end
       where id = q.id;
      v_late_pay := true;
    end if;
    if p_bike_id is null then
      return jsonb_build_object('ok', true, 'noop', true, 'paid_now', v_late_pay,
                                'already_paid', coalesce(p_paid, false) and coalesce(q.paid, false));
    end if;
    if exists (select 1 from public.bike_assignments where booking_id = q.id and bike_id = b.id and returned_at is null) then
      return jsonb_build_object('ok', true, 'noop', true, 'paid_now', v_late_pay,
                                'already_paid', coalesce(p_paid, false) and coalesce(q.paid, false));
    end if;
    if q.assigned_bike_id = b.id then
      -- checked in before assignments existed on this very bike: record it, then it is a no-op
      insert into public.bike_assignments (booking_id, bike_id, assigned_by) values (q.id, b.id, auth.uid())
      on conflict (bike_id) where returned_at is null do nothing;
      return jsonb_build_object('ok', true, 'noop', true, 'paid_now', v_late_pay,
                                'already_paid', coalesce(p_paid, false) and coalesce(q.paid, false));
    end if;
    raise exception 'BAD_BOOKING_STATE: #% is already on another bike - use staff_swap_bike', coalesce(q.queue_num::text, q.id);
  end if;
  if q.status not in ('waiting','waitlist') then
    raise exception 'BAD_BOOKING_STATE: #% is %, not waiting', coalesce(q.queue_num::text, q.id), q.status;
  end if;
  if coalesce(q.approval, 'pending') <> 'approved' and exists (select 1 from public.sessions s where s.id = q.session_id
       and coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') <> 'snd96' and coalesce(s.needs_approval, false)) then
    raise exception 'NOT_APPROVED: #% is not approved for this session yet', coalesce(q.queue_num::text, q.id);
  end if;   /* an approval ride's request not approved yet is approved on the list first (20261029160000) */

  if p_bike_id is not null then
    if b.status <> 'available' then
      select e.name into holder from public.bike_assignments ba join public.queue_entries e on e.id = ba.booking_id
        where ba.bike_id = b.id and ba.returned_at is null limit 1;
      raise exception 'BIKE_UNAVAILABLE: bike % is %', coalesce(b.bike_number::text, b.name),
        b.status || case when holder is not null then ' (with ' || holder || ')' else '' end;
    end if;
    got := array[b.id];
    new_bike := b.id;
  else
    -- The booking's own reservation: every reserved bike is claimed, or (one is gone) none is.
    rsv := coalesce(public._bike_ids(q.assigned_bike_id), '{}'::text[]);
    foreach bid in array rsv loop
      select status into st from public.bikes where id = bid for update;
      if st is distinct from 'available' then dropped := true; exit; end if;
    end loop;
    if dropped then got := '{}'; new_bike := null; else got := rsv; new_bike := q.assigned_bike_id; end if;
  end if;

  if array_length(got, 1) is not null then
    update public.bikes set status = 'in-use' where id = any(got);
  end if;
  update public.queue_entries
     set status = 'active',
         assigned_bike_id = new_bike,
         checked_in_at = public._desk_at(p_at, q.session_date),   /* the desk's time, clamped (20261107100000) */
         checked_in_by = v_by,
         paid = coalesce(p_paid, paid),
         price = coalesce(p_price, price),
         pay_method = case when p_pay_method is null then pay_method else nullif(p_pay_method, '') end,
         card_amount = case when p_pay_method is null then card_amount else p_card_amount end,
         type_preference = coalesce(nullif(p_type, ''), type_preference),
         ride_group = case when p_ride_group is null then ride_group else nullif(p_ride_group, '') end
   where id = q.id;
  foreach bid in array got loop
    insert into public.bike_assignments (booking_id, bike_id, assigned_by)
      values (q.id, bid, auth.uid()) returning id into a_id;
    first_a := coalesce(first_a, a_id);
  end loop;
  v_res := jsonb_build_object('ok', true, 'noop', false, 'assignment_id', first_a,
                            'bikes', to_jsonb(got), 'reservation_dropped', dropped);
  if v_claimed is not null then update rpc_receipts set result = v_res where user_id = v_uid and op_id = p_op_id; end if;
  return v_res;
end $function$;
revoke all on function public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid,text) from public, anon;
grant execute on function public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid,text) to authenticated, service_role;

-- The bulk check-in (a Door account too), the returns and the close-out: the same right, after the staff check.
do $desk$
declare f record; d text;
begin
  for f in select * from (values
    ('public.staff_bulk_checkin(text[],uuid[],text)',
     $g$  if not (_staff_mod('queue', true) or _staff_is_door()) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;   -- Bookings' edit right, or a Door account (bh18 sql09-2) (20261119000300)$g$),
    ('public.staff_bulk_return(jsonb,text)',
     $g$  if not _staff_mod('queue', true) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;   -- Bookings' edit right (bh18 sql09-2) (20261119000300)$g$),
    ('public.staff_close_out(text,jsonb,text[],text[])',
     $g$  if not _staff_mod('queue', true) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;   -- Bookings' edit right (bh18 app29-2) (20261119000300)$g$),
    ('public.staff_return(text,text,text,uuid,text)',
     $g$  if not _staff_mod('queue', true) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;   -- Bookings' edit right (bh18 sql09-2) (20261119000300)$g$)
  ) v(fn, gate) loop
    d := pg_get_functiondef(f.fn::regprocedure);
    if position('(20261119000300)' in d) > 0 then raise notice '% already asks Bookings'' edit right', f.fn; continue; end if;
    d := pg_temp._once(d,
$a$  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
$a$,
$b$  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
$b$ || f.gate || E'\n');
    execute d;
  end loop;
end $desk$;

-- ── 5. sql09-1 community applications: the Community section's edit right ───────────────────────────────────────
do $comm$
declare f record; d text;
begin
  for f in select * from (values
    ('public.staff_community_approve(uuid,text,boolean)',
     $g$  if not _staff_mod('community', true) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;   -- the Community section's edit right (bh18 sql09-1) (20261119000300)$g$),
    ('public.staff_community_decide(uuid,text,text)',
     $g$  if not _staff_mod('community', true) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;   -- the Community section's edit right (bh18 sql09-1) (20261119000300)$g$),
    ('public.staff_community_ask_changes(uuid,text[],text,text)',
     $g$  if not _staff_mod('community', true) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;   -- the Community section's edit right (bh18 sql09-1) (20261119000300)$g$),
    ('public.staff_community_new_password(uuid)',
     $g$  /* a temporary password is staff_set_customer_temp_password's rule: an admin, or a manager or front desk account
     with the Community section's edit right (bh18 sql09-1) (20261119000300) */
  if not (is_admin() or (_staff_mod('community', true)
          and exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null
                        and s.role in ('manager', 'frontdesk')))) then
    raise exception 'STAFF_ONLY' using errcode = '42501';
  end if;$g$),
    ('public.staff_learn_new_password(uuid)',
     $g$  /* a temporary password is staff_set_customer_temp_password's rule: an admin, or a manager or front desk account
     with the Community section's edit right (bh18 sql09-1) (20261119000300) */
  if not (is_admin() or (_staff_mod('community', true)
          and exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null
                        and s.role in ('manager', 'frontdesk')))) then
    raise exception 'STAFF_ONLY' using errcode = '42501';
  end if;$g$)
  ) v(fn, gate) loop
    d := pg_get_functiondef(f.fn::regprocedure);
    if position('(20261119000300)' in d) > 0 then raise notice '% already asks the section''s right', f.fn; continue; end if;
    d := pg_temp._once(d,
$a$  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
$a$,
$b$  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
$b$ || f.gate || E'\n');
    execute d;
  end loop;
end $comm$;

drop policy if exists "staff update applications" on public.community_applications;
create policy "staff update applications" on public.community_applications for update to authenticated
  using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));

-- ── 6. sql10-3 staff_fnb_decide: the request read again under its lock ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.staff_fnb_decide(p_booking bigint, p_action text, p_note text DEFAULT ''::text, p_by text DEFAULT ''::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b fnb_bookings%rowtype; cap int; n int;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  perform set_config('fnb.actor', 'staff:' || coalesce(p_by, ''), true);
  select * into b from fnb_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select capacity into cap from fnb_dates where day = b.day for update;
  /* The request is read again under its own lock, after the date's (bh18 sql10-3) (20261119000300): two staff
     deciding it at once, or the venue cancelling it meanwhile, passed the checks below on the first, unlocked copy
     and the last one wrote over the other's answer (a declined venue shown confirmed). The writes also name the
     status they leave. */
  select * into b from fnb_bookings where id = p_booking for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_action = 'confirm' then
    if b.status <> 'pending' then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
    select count(*) into n from fnb_bookings where day = b.day and status = 'confirmed';
    if n >= cap then raise exception 'DATE_FULL' using errcode = 'P0001'; end if;
    update fnb_bookings set status = 'confirmed', staff_note = left(coalesce(p_note, ''), 500),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now() where id = b.id and status = 'pending';
    if not found then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
    if n + 1 >= cap then
      update fnb_bookings set status = 'declined', staff_note = 'another_venue', decided_by = coalesce(p_by, ''),
             decided_at = now(), updated_at = now()
       where day = b.day and status = 'pending' and id <> b.id;
    end if;
  elsif p_action = 'decline' then
    if b.status <> 'pending' then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
    update fnb_bookings set status = 'declined', staff_note = left(coalesce(p_note, ''), 500),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now() where id = b.id and status = 'pending';
    if not found then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
  elsif p_action = 'cancel' then
    if b.status not in ('pending','confirmed') then raise exception 'NOT_LIVE' using errcode = 'P0001'; end if;
    update fnb_bookings set status = 'cancelled', cancelled_by = 'mm', cancel_reason = left(coalesce(p_note, ''), 300),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now() where id = b.id and status in ('pending','confirmed');
    if not found then raise exception 'NOT_LIVE' using errcode = 'P0001'; end if;
  else
    raise exception 'BAD_ACTION' using errcode = '22023';
  end if;
  perform _fnb_sync_day(b.day);
end $function$;
revoke all on function public.staff_fnb_decide(bigint, text, text, text) from public, anon;
grant execute on function public.staff_fnb_decide(bigint, text, text, text) to authenticated;

-- ── 7. sql10-5 staff_learn_schedule: a shared phone links only an account with no email or the same one ──────────
do $ls$
declare d text;
begin
  d := pg_get_functiondef('public.staff_learn_schedule(uuid,timestamp with time zone,text,text)'::regprocedure);
  if position('(20261119000300)' in d) > 0 then raise notice 'staff_learn_schedule already checks the email'; return; end if;
  d := pg_temp._once(d,
$a$= v_digits
         order by (merged_into is null) desc, created_at limit 1;
$a$,
$b$= v_digits
           /* the phone alone is another person's when that account has another email (a family phone; staff may
              share a phone too): then the learner gets an account of their own (bh18 sql10-5) (20261119000300) */
           and (coalesce(btrim(email), '') = '' or lower(btrim(email)) = lower(btrim(coalesce(a.email, ''))))
         order by (merged_into is null) desc, created_at limit 1;
$b$);
  execute d;
end $ls$;

-- ── 8. sql10-7 / sql10-4 lockers: money back and on the house ask what their twins ask ───────────────────────────
CREATE OR REPLACE FUNCTION public.staff_locker_cancel(p_rental uuid, p_reason text, p_undo boolean, p_no_refund boolean DEFAULT false, p_op text DEFAULT NULL::text, p_approval text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r locker_rentals%rowtype; who text; keep boolean := false; back numeric := 0;
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
  /* Money back is an admin's (the owner, 2026-11-10; staff_locker_refund and staff_locker_edit's lower fee ask the
     same): a Cancel that gives the fee back by itself - a wallet receipt voided into the wallet, or the fee taken off
     a ride's paid bill - is an admin's too (ADMIN_REFUND: the amount, which the app says). Anyone else cancels it
     with no refund; a locker paid at the Sales till (refunded there) or not paid at all cancels as before
     (bh11 sql07-1). */
  /* An admin's Cancel that gives the fee back asks what staff_locker_refund asks for the same money (bh18 sql10-7)
     (20261119000300): the operator's PIN and, over the owner's limit for refunds (Settings > Business), a manager's
     approval (p_op / p_approval, as the page sends them to Refund; PIN_REQUIRED / MANAGER_REQUIRED). */
  if not keep and not r.house then
    back := (case when r.on_bill and r.booking_id is not null
                   and exists (select 1 from queue_entries e where e.id = r.booking_id and coalesce(e.paid, false))
                  then r.price else 0 end)
          + (case when r.receipt_id is not null and coalesce(r.pay, '') <> 'card'
                   and exists (select 1 from cashier_sales c where c.id = r.receipt_id and c.voided_at is null and c.refunded_at is null)
                  then r.price else 0 end);
    if back > 0 then
      if not coalesce(is_admin(), false) then raise exception 'ADMIN_REFUND: %', back using errcode = '42501'; end if;
      if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
      if not _mgr_ok('refund', back, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
    end if;
  end if;
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
drop function if exists public.staff_locker_cancel(uuid, text, boolean, boolean);
revoke all on function public.staff_locker_cancel(uuid, text, boolean, boolean, text, text) from public, anon;
grant execute on function public.staff_locker_cancel(uuid, text, boolean, boolean, text, text) to authenticated;

CREATE OR REPLACE FUNCTION public.staff_locker_house(p_rental uuid, p_on boolean, p_op text, p_approval text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r locker_rentals%rowtype;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into r from locker_rentals where id = p_rental;
  if r.id is null then raise exception 'NOT_FOUND: no such rental' using errcode = 'P0002'; end if;
  perform _lk_lock(r.day);
  select * into r from locker_rentals where id = p_rental for update;
  if r.status = 'cancelled' then raise exception 'LOCKER_NOT_OPEN: already cancelled' using errcode = 'P0001'; end if;
  if coalesce(p_on, true) then
    if _lk_paid(r.id) > 0 then raise exception 'LOCKER_PAID: refund it to make it free' using errcode = 'P0001'; end if;
    /* On the house asks a manager over the owner's limit, as a ride on the house does (_house_guard, staff_set_house;
       bh18 sql10-4) (20261119000300): the page already asks for it (_lkEdRpc, kind 'house'); an admin is not asked,
       as there. A locker already on the house is not asked again. */
    if not r.house and not coalesce(is_admin(), false)
       and not _mgr_ok('house', coalesce(nullif(r.price, 0), _lk_price(r.period)), p_approval) then
      raise exception 'MANAGER_REQUIRED' using errcode = '42501';
    end if;
    if r.receipt_id is not null then perform _lk_unpay(r.id, _lk_who()); end if;  -- a voided payment: nothing was taken
    update locker_rentals set price = 0, house = true, receipt_id = null where id = r.id;
  else
    if not r.house then return jsonb_build_object('ok', true, 'id', r.id); end if;
    if r.refunded > 0 then raise exception 'LOCKER_REFUNDED: its money went back; rent it again' using errcode = 'P0001'; end if;
    update locker_rentals set price = _lk_price(r.period), house = false where id = r.id;
  end if;
  return jsonb_build_object('ok', true, 'id', r.id, 'price', (select x.price from locker_rentals x where x.id = r.id),
                            'booking_id', r.booking_id, 'addons', (select e.addons from queue_entries e where e.id = r.booking_id));
end $function$;
revoke all on function public.staff_locker_house(uuid, boolean, text, text) from public, anon;
grant execute on function public.staff_locker_house(uuid, boolean, text, text) to authenticated;

-- ── 9. sql10-6 merge and unmerge: the mentorship records follow the account ─────────────────────────────────────
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

-- ── 10. sql10-1 staff_move_session: everything that names the session follows it ────────────────────────────────
-- The night's crew: its stamp keeps a row's night on update, except in a move (skipped where session_crew is not there).
do $crew$
declare d text;
begin
  if to_regprocedure('public._session_crew_stamp()') is null then
    raise notice '_session_crew_stamp is not on this database; nothing to patch'; return;
  end if;
  d := pg_get_functiondef('public._session_crew_stamp()'::regprocedure);
  if position('(20261119000300)' in d) > 0 then raise notice '_session_crew_stamp already lets a move through'; return; end if;
  d := pg_temp._once(d,
$a$    new.session_id := old.session_id;
$a$,
$b$    -- staff_move_session moves the night's crew with it (bh18 sql10-1) (20261119000300)
    if coalesce(current_setting('mm.session_move', true), '') <> '1' then new.session_id := old.session_id; end if;
$b$);
  execute d;
end $crew$;

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

  update queue_entries set session_id = v_to, session_date = to_char(d, 'YYYY-MM-DD'), session_day = v_day where session_id = p_from;
  /* Lockers reserved for the evening on the Lockers page move with it too (bh11 sql07-3): they have no booking for
     _lk_booking_follow to move, so they kept the old date and a session id deleted below; the new evening did not
     hold their door and the old one's End of night cancelled them. As a moved booking's locker: the door goes along
     only when nobody holds it there for an overlapping time, and one left without a door is given a free one. A
     cancelled or handed-back rental keeps its day and follows the id, for its history. */
  perform _lk_lock(d);
  update locker_rentals r set session_id = v_to, day = d
   where r.session_id = p_from and r.booking_id is null and r.status in ('reserved', 'in_use');
  update locker_rentals r set locker_id = null, status = 'reserved', assigned_at = null, assigned_by = null
   where r.session_id = v_to and r.booking_id is null and r.status in ('reserved', 'in_use') and r.locker_id is not null
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

-- ── 11. sql14-1 the Door role's guard on every table any staff account may write ─────────────────────────────────
do $door$
declare t text;
begin
  foreach t in array array['saturday_codes', 'saturday_code_rides', 'saturday_settings', 'farm_codes', 'session_partner_codes', 'session_partners', 'session_rota', 'customer_badges', 'customer_titles', 'badge_requests', 'waitlist_offers', 'rider_registrations', 'team_members', 'bike_service_log', 'inventory_moves', 'vl_receipts', 'ambassadors', 'ambassador_redemptions', 'community_applications', 'learn_applications', 'customer_contacts', 'customer_ig_followers', 'staff_comments', 'member_welcome', 'squads', 'rotm_rounds', 'hub_posts', 'hub_goals', 'hub_club_goals', 'hub_photos', 'hub_ramadan', 'mentor_profiles', 'mentor_mentors', 'mentor_offers', 'mentor_checks'] loop
    if to_regclass('public.' || t) is null then raise notice 'no table %; skipped', t; continue; end if;
    execute format('drop trigger if exists a_door_guard on public.%I', t);
    execute format('create trigger a_door_guard before insert or update or delete on public.%I for each row execute function public._door_write_guard()', t);
  end loop;
end $door$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119000300', 'bh18_db3')
on conflict do nothing;

-- Checks: every definer function this file wrote keeps SECURITY DEFINER and its search_path; the patched ones carry
-- this file's mark; one staff_locker_cancel; the guard on the Door tables; the applications policy.
do $chk$
declare f text;
begin
  foreach f in array array['public.my_bookings(text,text)', 'public.petromin_guest_book(text,text,text,text,text,text,text,text)',
                           'public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,text)',
                           'public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid,text)',
                           'public.staff_bulk_checkin(text[],uuid[],text)', 'public.staff_bulk_return(jsonb,text)',
                           'public.staff_close_out(text,jsonb,text[],text[])', 'public.staff_return(text,text,text,uuid,text)',
                           'public.staff_community_approve(uuid,text,boolean)', 'public.staff_community_decide(uuid,text,text)',
                           'public.staff_community_ask_changes(uuid,text[],text,text)', 'public.staff_community_new_password(uuid)',
                           'public.staff_learn_new_password(uuid)', 'public.staff_fnb_decide(bigint,text,text,text)',
                           'public.staff_learn_schedule(uuid,timestamp with time zone,text,text)',
                           'public.staff_locker_cancel(uuid,text,boolean,boolean,text,text)', 'public.staff_locker_house(uuid,boolean,text,text)',
                           'public.staff_merge_customers(text,text,text,text,text)', 'public.staff_unmerge_customers(bigint)',
                           'public.staff_move_session(text,text,text,boolean)', 'public._door_write_guard()'] loop
    if not exists (select 1 from pg_proc p where p.oid = to_regprocedure(f) and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
    if f <> 'public._door_write_guard()' and position('(20261119000300)' in pg_get_functiondef(to_regprocedure(f))) = 0 then
      raise exception '% does not carry this file''s change', f;
    end if;
  end loop;
  if to_regprocedure('public._session_crew_stamp()') is not null then
    if position('(20261119000300)' in pg_get_functiondef('public._session_crew_stamp()'::regprocedure)) = 0
       or not (select prosecdef from pg_proc where oid = 'public._session_crew_stamp()'::regprocedure) then
      raise exception '_session_crew_stamp was not patched, or lost SECURITY DEFINER';
    end if;
  end if;
  if to_regprocedure('public.staff_locker_cancel(uuid,text,boolean,boolean)') is not null then
    raise exception 'the four-argument staff_locker_cancel is still there (a call would be ambiguous)';
  end if;
  if has_function_privilege('anon', 'public.staff_locker_cancel(uuid,text,boolean,boolean,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_locker_cancel(uuid,text,boolean,boolean,text,text)', 'execute') then
    raise exception 'staff_locker_cancel grants are wrong';
  end if;
  if not has_function_privilege('anon', 'public.my_bookings(text,text)', 'execute')
     or not has_function_privilege('anon', 'public.petromin_guest_book(text,text,text,text,text,text,text,text)', 'execute') then
    raise exception 'my_bookings / petromin_guest_book lost the riders'' grant';
  end if;
  foreach f in array array['saturday_codes', 'saturday_code_rides', 'saturday_settings', 'farm_codes', 'session_partner_codes', 'session_partners', 'session_rota', 'customer_badges', 'customer_titles', 'badge_requests', 'waitlist_offers', 'rider_registrations', 'team_members', 'bike_service_log', 'inventory_moves', 'vl_receipts', 'ambassadors', 'ambassador_redemptions', 'community_applications', 'learn_applications', 'customer_contacts', 'customer_ig_followers', 'staff_comments', 'member_welcome', 'squads', 'rotm_rounds', 'hub_posts', 'hub_goals', 'hub_club_goals', 'hub_photos', 'hub_ramadan', 'mentor_profiles', 'mentor_mentors', 'mentor_offers', 'mentor_checks'] loop
    if to_regclass('public.' || f) is not null and not exists (
         select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
          where g.tgrelid = to_regclass('public.' || f) and g.tgname = 'a_door_guard' and p.proname = '_door_write_guard') then
      raise exception 'a_door_guard is not on %', f;
    end if;
  end loop;
  if not exists (select 1 from pg_policy where polrelid = 'public.community_applications'::regclass
                   and polname = 'staff update applications' and pg_get_expr(polqual, polrelid) like '%_staff_mod%') then
    raise exception 'the applications policy does not ask the section''s right';
  end if;
end $chk$;

commit;

-- check (read only): the marks, one staff_locker_cancel, the guarded tables, the policy, the ledger row.
-- select (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and position('(20261119000300)' in prosrc) > 0) as patched_fns,
--        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'staff_locker_cancel') as locker_cancel_fns,
--        (select array_agg(tgrelid::regclass::text order by 1) from pg_trigger where tgname = 'a_door_guard') as door_guarded,
--        (select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'staff update applications') as app_policy,
--        (select name from supabase_migrations.schema_migrations where version = '20261119000300') as ledger;
