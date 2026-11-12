-- ============================================================================
-- Bug hunt 2026-11-11 (bh11), live database fixes, part B (prod and staging).
--
-- 1. rider_edit (sql06-1): a rider could move a Petromin party to another night even when the desk had tied it to a
--    queue booking of its own, which Cancel refuses ('desk'); the first night's booking kept its bikes for nobody and
--    lost its link. Moving such a party to another night now answers 'desk' too; same-night edits are unchanged.
-- 2. staff_vl_receipt (sql08-3): confirming a bank-transfer receipt marked a cancelled, removed or no-show Victory
--    Lap / Arena booking paid by transfer. Confirm now answers 'gone' for those (staff_vl_receipt_put already
--    refuses them); sending the receipt back still works.
-- 3. staff_volunteer_decide (sql08-4): declining a volunteer who had already clocked in left the shift accepted (the
--    upsert skips it) but logged a decline and counted it done, so the app said Saved. Such a person is now counted
--    in 'skipped' and nothing is logged; the app already says so and reads the team again.
-- 4. staff_locker_cancel (sql07-1): Cancel with the money back voided a locker's wallet receipt into the wallet, or
--    took its fee off a ride's paid bill, for any staffer, past the owner's rule that money back is an admin's
--    (staff_locker_refund and staff_locker_edit's lower fee require it). That refund is now an admin's: anyone else
--    gets ADMIN_REFUND: <amount> (the app says "This change gives {0} back to the wallet: an admin makes it") and
--    cancels with No refund. A locker paid at the Sales till, on the house, or not paid cancels as before.
-- 5. staff_merge_customers / staff_unmerge_customers (sql07-2): a merge left the dropped account's locker rentals,
--    volunteer certificates, portal Updates and shift feedback behind, so the keeper's My lockers and the volunteer
--    portal no longer showed them. They move to the keeper now (a certificate or Update the keeper already has for
--    the same session stays, as a shift does) and are recorded in the merge, so an unmerge moves them back.
-- 6. staff_move_session (sql07-3): moving a session to another date left its Lockers-page reservations (no booking
--    to follow) on the old date with a deleted session id: the new evening did not hold their door and the old one's
--    End of night cancelled them. Live ones now move with the session as a booking's locker does (door kept when
--    free there, else a free one held); cancelled and handed-back ones follow the id.
-- 7. staff_locker_edit (sql07-5): a ride's locker could be moved to another evening than its ride, its fee left on
--    the ride's bill and the trigger still cancelling or moving it with the ride. A ride's locker now stays on its
--    ride's evening (LOCKER_ON_BOOKING otherwise; moving the ride moves it).
-- 8. volunteer_interest (sql09-1): answering off withdrew an accepted shift at any time before closes_at, after the
--    event had started too, which volunteer_coming refuses (VOL_CLOSED), so a no-show could clear their own record
--    and a team lead dropped off mid-event. An accepted shift is now withdrawn only until the session starts.
-- 9. staff_wallet_refund_booking (sql09-2): a Victory Lap or Arena entry paid at the desk could be refunded into
--    the MicroMobility wallet (only a transfer was refused). Any race entry is now refused (WALLET_RACE), as every
--    other wallet path refuses it.
-- 10. team_members (sql10-1): any staffer could rename team-list entries directly, move their own PIN onto a
--    manager approver's name and approve their own manager-gated actions. A trigger now refuses renaming an entry
--    that has an operator PIN when the app writes the table itself, unless an admin does it; and through a staff
--    function (staff_my_settings, the caller's own entry) a PIN entry never takes an approver's name (NAME_TAKEN).
-- 11. tags (sql10-2): the "staff full" policy let any staffer change a tag's slug or auto_grant, so they could give
--    an ordinary tag the 'vip' slug (_is_vip reads the slug, the VIP approval guard the id) or hand VIP to every new
--    account. A trigger now keeps a tag's id, slug, auto_grant and locked flag, and adding or deleting a VIP,
--    auto-granted or locked tag, an admin's; name, colour, description and Hide stay every staffer's, as the app
--    writes them.
-- 12. hub_pick_level (hub-7): the month's level could be changed again after choosing, down to the lowest late in
--    the month to earn the challenge badge. It is chosen once now; the same answer again is fine, another answers
--    'chosen'.
-- 13. hub_feed (hub-8): a 29 February birthday got no birthday card three years out of four. It shows on 28 February
--    in a year with no 29th, as the website greets it.
-- 14. photos bucket (dbgrants-1): anyone with the public key could upload without limit. The upload policy now
--    also asks _photos_upload_ok(): staff as before; anyone else while the bucket has taken fewer than 30 pictures in
--    ten minutes and 200 in a day (the busiest ten minutes since September held 46, a one-off; a normal day has
--    two or three). Tying each upload to a rider's token needs an upload Function; not here.
--
-- Each function is replaced from its live definition on prod (pg_get_functiondef, checked by md5; staging runs the
-- same text, checked 2026-11-12). Headers are unchanged; CREATE OR REPLACE keeps the grants. New functions get
-- their own grants. Idempotent. Run supabase/checks/security-attributes.sql after.
-- Rollback: re-run the definitions named in $pre$ below (their latest migrations); drop trigger team_members_name_guard
--   on team_members and tags_admin_guard on tags, and their functions; re-create the "photos upload" policy from
--   20260922124000 and drop _photos_upload_ok().
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- Every function replaced below must still be the live text this file was built from (md5 of the body, read on
-- prod and staging 2026-11-12), or already this file's (a re-run): else stop, rather than undo a change made since.
do $pre$
declare f record; m text;
begin
  for f in select * from (values
    ('public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text,text)', 'e43aad5c729b11ac072c121be5a2d3a8', '4b3dcb0a00331af9645ce730c679ea37'),
    ('public.staff_vl_receipt(text,boolean)', 'f603d23b15bdd9c01b6654541c640408', '5aa75bea0e0ef7f662c2bfa77c9adc5b'),
    ('public.staff_volunteer_decide(text,text[],text,text)', '2c4a526292309709f2cb4e54aadb467d', 'e81b3674652b61c86e9cc18c629b4a65'),
    ('public.staff_locker_cancel(uuid,text,boolean,boolean)', '94210934c1c00ff5ccda4daa07db2f55', '4b16af77a16c2ea70d26d0798cd010ec'),
    ('public.staff_merge_customers(text,text,text,text,text)', 'ecf641774d3995f90a833516bf7d1631', '407201e12effe2f5d3658d37f2c6bf68'),
    ('public.staff_unmerge_customers(bigint)', '403db0e3911dce8ac528eb17c72513a8', '1a3eed720857b6db773768e236cbd86e'),
    ('public.staff_move_session(text,text,text,boolean)', '4de45f9ddb3db399bef966c11f366ad5', '5bea0f612c84201dfbd89bdb07fa8c80'),
    ('public.staff_locker_edit(uuid,date,text,text,text,text,text,text)', 'c6de8ea5f1ed2f15b441411719ed1ab5', '71b49bf5374d9ff3587f997df97df39c'),
    ('public.volunteer_interest(text,text,text,boolean,text,text)', '10b732e87e477b73242de466d0863018', '321a5e6c5843f1ecfc3ccc961cc91f65'),
    ('public.staff_wallet_refund_booking(text,text,text,text)', '1ef7b5e63246d45066d48731b9bb9d7f', '10042554c5a220bfcac2d3386787ca1a'),
    ('public.hub_pick_level(text,text,integer)', 'e7cb01bdbe85e6a5fe34bf3a22af9dce', 'fb1177f1fee5ee4de24d89da8dd41253'),
    ('public.hub_feed(text,text)', '5341bf29dbef5bbbe21e6d285da7eb07', '0fbf381efea702a66de2bd3805ce5710')
  ) v(fn, was, now_) loop
    select md5(p.prosrc) into m from pg_proc p where p.oid = f.fn::regprocedure;
    if m is distinct from f.was and m is distinct from f.now_ then
      raise exception '% changed since 2026-11-12 (md5 %): rebuild this file from the live definition', f.fn, m;
    end if;
  end loop;
end $pre$;

-- 1 rider_edit ---------------------------------------------------------------
create or replace function public.rider_edit(p_booking_no text, p_proof_phone text, p_badge text, p_name text, p_height integer, p_type text, p_session_id text DEFAULT NULL::text, p_company text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_riders jsonb DEFAULT NULL::jsonb, p_waiver text DEFAULT NULL::text, p_from_session text DEFAULT NULL::text, p_lang text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row rider_registrations%rowtype;
  v_proof text := right(regexp_replace(coalesce(p_proof_phone,''), '\D', '', 'g'), 9);
  v_newkey text := lower(regexp_replace(trim(coalesce(p_badge,'')), '[^a-zA-Z0-9]', '', 'g'));
  v_sess_id text;
  v_r jsonb;
  v_seq integer; v_bno text;
begin
  if not _rider_gate() then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  select r.* into v_row from rider_registrations r left join sessions s on s.id = r.session_id
   where upper(r.booking_no) = upper(trim(coalesce(p_booking_no,''))) and r.party_no = 1
     /* the night of the confirmation being edited, when the form sends it: numbers start again every night
        (20261110235400) */
     and (p_from_session is null or coalesce(r.session_id, '') = p_from_session)
   order by (r.phone is not null and right(regexp_replace(r.phone, '\D', '', 'g'), 9) = v_proof) desc,
            (r.checked_in_at is null) desc,
            (coalesce(s.status, '') in ('open', 'full')) desc,
            r.session_id desc nulls last
   limit 1;
  if v_row.id is null then return jsonb_build_object('ok', false, 'error', 'notfound'); end if;
  if v_row.phone is null or length(v_proof) < 9 or right(regexp_replace(v_row.phone, '\D', '', 'g'), 9) <> v_proof then
    return jsonb_build_object('ok', false, 'error', 'notfound');
  end if;
  if v_row.checked_in_at is not null then return jsonb_build_object('ok', false, 'error', 'checked_in'); end if;
  if exists (select 1 from rider_registrations r
              where r.booking_no = v_row.booking_no and coalesce(r.session_id, '') = coalesce(v_row.session_id, '')
                and r.checked_in_at is not null) then
    return jsonb_build_object('ok', false, 'error', 'checked_in');
  end if;
  v_sess_id := coalesce(p_session_id, v_row.session_id);
  if v_newkey = '' then return jsonb_build_object('ok', false, 'error', 'badge'); end if;
  if exists (select 1 from rider_registrations r
              where r.badge_key = v_newkey and coalesce(r.session_id,'') = coalesce(v_sess_id,'') and (r.booking_no is distinct from v_row.booking_no or coalesce(r.session_id, '') is distinct from coalesce(v_row.session_id, ''))) then
    return jsonb_build_object('ok', false, 'error', 'duplicate');
  end if;
  /* A party the desk tied to a queue booking of its own (matched_entry_id) holds bikes in the Queue: moving it to
     another night is the desk's to do, as cancelling it is (rider_cancel answers 'desk'; bh11 sql06-1). */
  if coalesce(v_sess_id, '') <> coalesce(v_row.session_id, '')
     and exists (select 1 from rider_registrations r
                  where r.booking_no = v_row.booking_no and coalesce(r.session_id, '') = coalesce(v_row.session_id, '')
                    and r.matched_entry_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'desk');
  end if;
  begin
    v_bno := v_row.booking_no;
    if coalesce(v_sess_id, '') <> coalesce(v_row.session_id, '') then
      insert into rider_night_counters(session_key, source, n) values (coalesce(v_sess_id, ''), coalesce(v_row.source, 'petromin'), 1)
        on conflict (session_key, source) do update set n = rider_night_counters.n + 1 returning n into v_seq;
      v_bno := upper(left(coalesce(v_row.source, 'petromin'), 1)) || '-' || lpad(v_seq::text, 3, '0');
    end if;
    perform set_config('mm.rider_proved', v_bno, true);
    update rider_registrations
       set badge = trim(p_badge), session_id = v_sess_id, booking_no = v_bno
     where booking_no = v_row.booking_no and coalesce(session_id, '') = coalesce(v_row.session_id, '');   -- the whole party moves together
    v_r := rider_register(p_badge, p_name, p_height, p_type, coalesce(v_row.source, 'petromin'), p_phone, v_sess_id, p_company, p_riders, p_waiver, p_lang => p_lang);
    perform set_config('mm.rider_proved', '', true);
    if not coalesce((v_r->>'ok')::boolean, false) then
      raise exception using errcode = 'MM001', message = v_r::text;
    end if;
  exception when sqlstate 'MM001' then
    perform set_config('mm.rider_proved', '', true);
    return sqlerrm::jsonb;
  end;
  return v_r;
end $function$;

-- 2 staff_vl_receipt ---------------------------------------------------------
create or replace function public.staff_vl_receipt(p_entry_id text, p_ok boolean)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
AS $function$
declare
  v_paid boolean;
  v_method text;
  v_rc text;
  v_status text;
begin
  if not coalesce((select public.is_staff()), false) then
    raise exception 'STAFF_ONLY: staff only' using errcode = '42501';
  end if;
  select coalesce(x.paid, false), x.pay_method, x.vl_receipt_at, x.status
    into v_paid, v_method, v_rc, v_status
    from queue_entries x join sessions s on s.id = x.session_id
   where x.id = p_entry_id and coalesce(s.ride_kind, '') in ('vlap', 'arena')
   for update of x;
  if not found or v_rc is null then return 'missing'; end if;
  if coalesce(p_ok, false) then
    /* a booking cancelled, removed or marked no-show is not marked paid by its receipt, as staff_vl_receipt_put
       refuses it; sending the receipt back still works (bh11 sql08-3) */
    if coalesce(v_status, '') in ('cancelled', 'removed', 'noshow') then return 'gone'; end if;
    if v_paid and coalesce(v_method, '') <> 'transfer' then return 'desk'; end if;
    update queue_entries set paid = true, pay_method = 'transfer', card_amount = null where id = p_entry_id;
    return 'confirmed';
  end if;
  update queue_entries
     set vl_receipt_at = null,
         paid = case when pay_method = 'transfer' then false else paid end,
         pay_method = case when pay_method = 'transfer' then null else pay_method end
   where id = p_entry_id;
  delete from vl_receipts where entry_id = p_entry_id;
  return 'returned';
end $function$;

-- 3 staff_volunteer_decide ---------------------------------------------------
create or replace function public.staff_volunteer_decide(p_session text, p_customers text[], p_status text, p_role text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
AS $function$
declare _c text; _n int := 0; _skip int := 0; _exp int := 0; _unag int := 0; _op text := _vol_op(); v volunteers%rowtype; _av text := _vol_agreement_v();
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_status not in ('accepted', 'declined') then raise exception 'BAD_STATUS' using errcode = '22023'; end if;
  if not exists (select 1 from volunteer_sessions w where w.session_id = p_session) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  foreach _c in array coalesce(p_customers, '{}') loop
    v := null;
    select * into v from volunteers x where x.customer_id = _c for update;
    if v.status is null and not exists (select 1 from customers c where c.id = _c and c.merged_into is null) then _skip := _skip + 1; continue; end if;
    if p_status = 'accepted' and v.status in ('paused', 'removed') then _skip := _skip + 1; continue; end if;
    if p_status = 'accepted' and v.expires_on is not null and v.expires_on < _vol_today() then _exp := _exp + 1; continue; end if;
    if p_status = 'accepted' and v.agreed_version is distinct from _av then _unag := _unag + 1; end if;
    if p_status = 'accepted' then
      insert into volunteers (customer_id, status, decided_at, decided_by) values (_c, 'active', now(), _op)
      on conflict (customer_id) do update set status = 'active', decided_at = now(), decided_by = _op, updated_at = now()
        where volunteers.status = 'applied';
    end if;
    /* a volunteer already clocked in is not declined (the upsert below leaves that shift as it is): counted as left
       out, not logged and counted as a decline that never happened (bh11 sql08-4) */
    if p_status = 'declined' and exists (select 1 from volunteer_shifts x
                                          where x.session_id = p_session and x.customer_id = _c and x.clock_in is not null) then
      _skip := _skip + 1; continue;
    end if;
    insert into volunteer_shifts (session_id, customer_id, status, role, decided_at, decided_by, updated_by)
    values (p_session, _c, p_status, nullif(left(btrim(coalesce(p_role, '')), 40), ''), now(), _op, _op)
    on conflict (session_id, customer_id) do update set status = p_status,
      role = case when p_role is null then volunteer_shifts.role else excluded.role end,
      decided_at = now(), decided_by = _op, updated_at = now(), updated_by = _op
      where volunteer_shifts.clock_in is null or p_status = 'accepted';
    perform _vol_slog(_c, p_session, case when p_status = 'accepted' then 'staff_accept' else 'staff_decline' end);
    _n := _n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'n', _n, 'skipped', _skip + _exp, 'expired', _exp, 'unagreed', _unag);
end $function$;

-- 4 staff_locker_cancel ------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_locker_cancel(p_rental uuid, p_reason text, p_undo boolean, p_no_refund boolean DEFAULT false)
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
  if not keep and not r.house and not coalesce(is_admin(), false) then
    back := (case when r.on_bill and r.booking_id is not null
                   and exists (select 1 from queue_entries e where e.id = r.booking_id and coalesce(e.paid, false))
                  then r.price else 0 end)
          + (case when r.receipt_id is not null and coalesce(r.pay, '') <> 'card'
                   and exists (select 1 from cashier_sales c where c.id = r.receipt_id and c.voided_at is null and c.refunded_at is null)
                  then r.price else 0 end);
    if back > 0 then raise exception 'ADMIN_REFUND: %', back using errcode = '42501'; end if;
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

-- 5 staff_merge_customers ----------------------------------------------------
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

-- 5 staff_unmerge_customers --------------------------------------------------
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

-- 6 staff_move_session -------------------------------------------------------
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

  delete from sessions where id = p_from;
  return jsonb_build_object('ok', true, 'id', v_to, 'day', v_day);
end $function$;

-- 7 staff_locker_edit --------------------------------------------------------
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
end $function$;

-- 8 volunteer_interest -------------------------------------------------------
create or replace function public.volunteer_interest(p_id text, p_token text, p_session text, p_on boolean, p_role text default null::text, p_message text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
AS $function$
declare w volunteer_sessions%rowtype; sh volunteer_shifts%rowtype; v volunteers%rowtype; c record; _st text; _day text; _stop int; _auto boolean;
        _cfg jsonb := _vol_settings(); _min int; sx record; _start timestamptz;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  select x.must_change_pwd, x.deletion_requested_at, x.birth_date, x.gender into c from customers x where x.id = p_id;
  if coalesce(c.must_change_pwd, false) or c.deletion_requested_at is not null then raise exception 'VOL_ACCOUNT' using errcode = '42501'; end if;
  select * into v from volunteers where customer_id = p_id;
  if found and (v.status in ('paused', 'removed') or (v.expires_on is not null and v.expires_on < _vol_today())) then
    raise exception 'VOL_NOT_VOLUNTEER' using errcode = '42501';
  end if;
  select * into w from volunteer_sessions where session_id = p_session;
  if not found or not w.enabled or now() >= w.closes_at
     or exists (select 1 from sessions x where x.id = p_session and x.cancelled_at is not null) then
    raise exception 'VOL_CLOSED' using errcode = '42501';
  end if;
  select * into sh from volunteer_shifts where session_id = p_session and customer_id = p_id for update;
  if found and sh.status = 'blocked' then raise exception 'VOL_NOT_ACCEPTED' using errcode = '42501'; end if;

  if not coalesce(p_on, false) then
    if sh.id is null or sh.status = 'withdrawn' then return jsonb_build_object('ok', true, 'noop', true, 'status', 'withdrawn'); end if;
    if sh.clock_in is not null then raise exception 'VOL_ALREADY_IN' using errcode = 'P0001'; end if;
    -- Staff's answer stands: withdrawing and asking again must not wipe a decline or a no-show.
    if sh.status in ('declined', 'no_show', 'done', 'ended') then raise exception 'VOL_DECLINED' using errcode = 'P0001'; end if;
    /* An accepted shift is withdrawn only until the session starts, as volunteer_coming allows (the start as _vol_tick
       reads it); after that it is staff's to mark, no-show or done, and a team lead stays on the team (bh11 sql09-1). */
    if sh.status = 'accepted' then
      select x.session_date, x.bike_slots into sx from sessions x where x.id = p_session;
      _start := coalesce(_vol_session_start(sx.session_date, sx.bike_slots), _vol_starts(w.opens_at, sx.session_date));
      if now() >= coalesce(_start, 'infinity'::timestamptz) then raise exception 'VOL_CLOSED' using errcode = '42501'; end if;
    end if;
    update volunteer_shifts set status = 'withdrawn', lead = false, updated_at = now() where id = sh.id;
    perform _vol_log(p_id, p_session, 'withdraw');
    return jsonb_build_object('ok', true, 'status', 'withdrawn');
  end if;

  if sh.id is not null and sh.status in ('interested', 'accepted', 'done') then return jsonb_build_object('ok', true, 'noop', true, 'status', sh.status); end if;
  if sh.id is not null and sh.status in ('declined', 'no_show', 'ended') then raise exception 'VOL_DECLINED' using errcode = 'P0001'; end if;
  -- The profile first, then staff's yes on the person; after that one tap per opportunity (20261109120000).
  if v.customer_id is null or v.status <> 'active' then
    raise exception '%', case when v.profile_at is null then 'VOL_PROFILE' else 'VOL_PENDING' end using errcode = 'P0001';
  end if;
  if not w.signup_open then raise exception 'VOL_SIGNUP_CLOSED' using errcode = 'P0001'; end if;
  -- Old enough on the day: the settings' min_age (18 unless staff set another, decision 3) or the opportunity's own,
  -- whichever is higher (20261111140000).
  _min := greatest(_vol_min_age(), coalesce(w.min_age, 0));
  if _min > 0 then
    if coalesce(c.birth_date, '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'VOL_DOB' using errcode = 'P0001'; end if;
    select x.session_date into _day from sessions x where x.id = p_session;
    if left(c.birth_date, 10)::date + make_interval(years => _min)
       > coalesce(case when coalesce(_day, '') ~ '^\d{4}-\d{2}-\d{2}' then left(_day, 10)::date end, _vol_today()) then
      raise exception 'VOL_AGE' using errcode = 'P0001';
    end if;
  end if;
  -- A women-only or men-only opportunity (decision 12): anyone else, or an account with no gender, is refused.
  if w.gender is not null and _vol_gender(c.gender) is distinct from w.gender then raise exception 'VOL_GENDER' using errcode = 'P0001'; end if;
  _stop := coalesce(nullif(_cfg ->> 'noshow_stop', '')::numeric, 0)::int;
  -- Accepted at once: someone staff trust, or (auto_returning, on unless staff turn it off; decision 10) anyone who has
  -- already worked an event. The no-show limit holds for both.
  _auto := (coalesce(v.auto_accept, false)
            or (coalesce(_cfg ->> 'auto_returning', 'true') <> 'false'
                and exists (select 1 from volunteer_shifts x where x.customer_id = p_id and x.status = 'done')))
           and not (_stop > 0 and (select count(*) from volunteer_shifts x where x.customer_id = p_id and x.status = 'no_show') >= _stop);
  _st := case when _auto then 'accepted' else 'interested' end;
  insert into volunteer_shifts (session_id, customer_id, status, pref_role, message, decided_at, decided_by)
  values (p_session, p_id, _st, nullif(left(btrim(coalesce(p_role, '')), 40), ''), nullif(left(btrim(coalesce(p_message, '')), 300), ''),
          case when _st = 'accepted' then now() end, case when _st = 'accepted' then 'auto' end)
  on conflict (session_id, customer_id) do update set status = excluded.status, pref_role = excluded.pref_role, message = excluded.message,
    decided_at = excluded.decided_at, decided_by = excluded.decided_by, updated_at = now();
  perform _vol_log(p_id, p_session, 'interest');
  return jsonb_build_object('ok', true, 'status', _st);
end $function$;

-- 9 staff_wallet_refund_booking ----------------------------------------------
create or replace function public.staff_wallet_refund_booking(p_booking_id text, p_reason text default null,
                                                              p_op text default null, p_approval text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
AS $function$
declare q queue_entries%rowtype; amt numeric; real numeric; net numeric; b numeric; who text; card numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;  -- the owner, 2026-11-03
  if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into q from queue_entries where id = p_booking_id for update;
  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  /* A Victory Lap or Arena entry is the organiser's money however it was paid: never the wallet's, as every other
     wallet path refuses it (_wallet_pay_row, staff_wallet_fee, staff_cancel_session; bh11 sql09-2). */
  if exists (select 1 from sessions s where s.id = q.session_id and coalesce(s.ride_kind, '') in ('vlap', 'arena')) then
    raise exception 'WALLET_RACE' using errcode = 'P0001';
  end if;
  net := coalesce(q.wallet_paid, 0);
  if not coalesce(q.paid, false) and net <= 0 then raise exception 'WALLET_NOT_PAID' using errcode = 'P0001'; end if;
  if q.pay_method = 'transfer' then raise exception 'WALLET_RACE' using errcode = 'P0001'; end if;
  if q.customer_id is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
  amt := case when coalesce(q.paid, false) then _wallet_amount(q.price, q.addons) else net end;
  if amt <= 0 then raise exception 'WALLET_NOTHING_DUE' using errcode = 'P0001'; end if;
  if not _mgr_ok('refund', amt, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  perform set_config('mm.wallet_op', coalesce(p_op, ''), true);
  perform set_config('mm.wallet_note', coalesce(p_reason, ''), true);
  who := _wallet_owner(q.customer_id);
  if coalesce(q.paid, false) then
    real := amt - net;  -- what the desk took; the wallet's part goes back with the row below
    if real > 0 then
      card := case when q.card_amount is not null then least(greatest(q.card_amount, 0), real)
                   when q.pay_method = 'card' then real when q.pay_method = 'cash' then 0 end;
      perform _wallet_post(who, real, 'refund', case when q.card_amount is not null then 'split' when q.pay_method in ('card', 'cash') then q.pay_method end,
                           card, q.id, null, q.session_id);
    end if;
    update queue_entries set paid = false, pay_method = null, card_amount = null where id = q.id;
  else
    perform _wallet_release(q);
  end if;
  perform set_config('mm.wallet_note', '', true);
  select balance into b from wallet_balances where customer_id = who;
  return jsonb_build_object('ok', true, 'id', q.id, 'amount', amt, 'balance', coalesce(b, 0));
end $function$;

-- 10 team_members: an entry with an operator PIN keeps its name ------------
-- Invoker on purpose: current_user is the app's role (anon/authenticated) for a direct write, and the function owner
-- inside a SECURITY DEFINER function such as staff_my_settings.
create or replace function public._team_member_name_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare ap jsonb;
begin
  if new.name is not distinct from old.name or old.pin_hash is null or coalesce((select is_admin()), false) then
    return new;
  end if;
  /* the app writing the table itself: an entry with a PIN is renamed by an admin (bh11 sql10-1) */
  if current_user in ('anon', 'authenticated') then
    raise exception 'ADMIN_ONLY: an entry with an operator PIN is renamed by an admin' using errcode = '42501';
  end if;
  /* a staff function (staff_my_settings renames the caller's own entry): never onto a manager approver's name */
  select o.items -> 'approvers' into ap from staff_options o where o.key = 'biz';
  if jsonb_typeof(ap) = 'array' and ap ? new.name and not ap ? old.name then
    raise exception 'NAME_TAKEN' using errcode = '23505';
  end if;
  return new;
end $function$;
revoke all on function public._team_member_name_guard() from public, anon, authenticated;
drop trigger if exists team_members_name_guard on public.team_members;
create trigger team_members_name_guard before update of name on public.team_members
  for each row execute function public._team_member_name_guard();

-- 11 tags: what a tag means is an admin's -----------------------------------
create or replace function public._tags_admin_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  /* the service role, cron, migrations and SECURITY DEFINER functions, and admins: as before */
  if current_user not in ('anon', 'authenticated') or coalesce((select is_admin()), false) then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  /* everyone else (bh11 sql10-2): _is_vip reads the slug, _grant_auto_tags gives an auto_grant tag to every new
     account, and the app never changes the id, slug, auto_grant or locked flag, nor adds or deletes such a tag */
  if tg_op = 'INSERT' then
    if coalesce(new.auto_grant, false) or coalesce(new.locked, false) or new.id = 'tag_vip' or lower(coalesce(new.slug, '')) = 'vip' then
      raise exception 'ADMIN_ONLY: tag' using errcode = '42501';
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if coalesce(old.auto_grant, false) or coalesce(old.locked, false) or old.id = 'tag_vip' or lower(coalesce(old.slug, '')) = 'vip' then
      raise exception 'ADMIN_ONLY: tag' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.id is distinct from old.id or new.slug is distinct from old.slug
     or new.auto_grant is distinct from old.auto_grant or new.locked is distinct from old.locked then
    raise exception 'ADMIN_ONLY: tag' using errcode = '42501';
  end if;
  return new;
end $function$;
revoke all on function public._tags_admin_guard() from public, anon, authenticated;
drop trigger if exists tags_admin_guard on public.tags;
create trigger tags_admin_guard before insert or update or delete on public.tags
  for each row execute function public._tags_admin_guard();

-- 12 hub_pick_level ----------------------------------------------------------
create or replace function public.hub_pick_level(p_id text, p_token text, p_level integer)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
AS $function$
declare v_month date := date_trunc('month', _ksa_today())::date;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  update hub_levels set target = p_level, chosen = true
   where customer_id = p_id and month = v_month and kind = 'level' and p_level = any(levels)
     and not chosen;  /* the month's level is chosen once, before the riding counts (bh11 hub-7) */
  if not found then
    /* the same answer again (a second tap) is fine; another one once chosen is not */
    if exists (select 1 from hub_levels where customer_id = p_id and month = v_month and kind = 'level' and chosen and target = p_level) then
      return jsonb_build_object('ok', true);
    end if;
    return jsonb_build_object('ok', false, 'error',
      case when exists (select 1 from hub_levels where customer_id = p_id and month = v_month and kind = 'level' and chosen)
           then 'chosen' else 'level' end);
  end if;
  return jsonb_build_object('ok', true);
end $function$;

-- 13 hub_feed ----------------------------------------------------------------
create or replace function public.hub_feed(p_id text, p_token text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
AS $function$
declare
  v_today date := _ksa_today();
  v_month date := date_trunc('month', _ksa_today())::date;
  v_end date := (date_trunc('month', _ksa_today()) + interval '1 month' - interval '1 day')::date;
  v_accts text[];
  lv hub_levels%rowtype;
  v_club jsonb; v_ct int; v_cn int; sg hub_goals%rowtype;
  v_got text[];
  v_last text; v_lr int; v_lp int; v_mn int; v_all int;
  v_post jsonb; v_ann jsonb; v_vol text; v_bday boolean := false;
  v_year int; v_year_doc jsonb; v_first text;
  v_bd text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  v_accts := _accts_of(p_id);
  insert into hub_opens (customer_id, day) values (p_id, v_today) on conflict do nothing;

  lv := _hub_level_row(p_id, v_accts, v_month);

  -- the club goal: a staff goal running now, else the month's own
  select * into sg from hub_goals where kind = 'goal' and v_today between starts_on and ends_on order by ends_on limit 1;
  if found then
    v_cn := (select count(*) from (select distinct q.customer_id, q.session_id
                from queue_entries q join sessions s on s.id = q.session_id
                join customer_tags ct on ct.customer_id = q.customer_id and ct.tag_id = 'tag_saturday'
               where q.status = 'done'
                 and s.session_date >= to_char(sg.starts_on, 'YYYY-MM-DD') and s.session_date <= to_char(sg.ends_on, 'YYYY-MM-DD')
                 and (case when sg.scope = 'saturday' then s.ride_kind = 'saturday' else s.event_kind = 'community' end)) z);
    v_club := jsonb_build_object('name', sg.name, 'name_ar', sg.name_ar, 'scope', sg.scope, 'target', sg.target, 'n', v_cn,
      'mine', _hub_count(v_accts, sg.scope, sg.starts_on, sg.ends_on), 'from', sg.starts_on, 'ends_on', sg.ends_on);
  else
    v_ct := _hub_club_row(v_month);
    if v_ct is not null then
      v_club := jsonb_build_object('scope', 'saturday', 'target', v_ct, 'n', _hub_club_n(v_month, v_end),
        'mine', _hub_n(v_accts, v_month, v_end, true), 'from', v_month, 'ends_on', v_end);
    end if;
  end if;

  v_got := _hub_award(p_id, v_accts);

  -- club numbers, all riders, totals of 10 or more only
  select max(s.session_date) into v_last from queue_entries q join sessions s on s.id = q.session_id
   where q.status = 'done' and s.ride_kind = 'saturday' and s.session_date <= to_char(v_today, 'YYYY-MM-DD');
  if v_last is not null then
    select count(distinct q.customer_id), count(*) into v_lr, v_lp from queue_entries q join sessions s on s.id = q.session_id
     where q.status = 'done' and s.ride_kind = 'saturday' and s.session_date = v_last;
  end if;
  select count(*) into v_mn from queue_entries q join sessions s on s.id = q.session_id
   where q.status = 'done' and s.ride_kind = 'saturday' and s.session_date >= to_char(v_month, 'YYYY-MM-DD') and s.session_date <= to_char(v_end, 'YYYY-MM-DD');
  select count(*), min(s.session_date) into v_all, v_first from queue_entries q join sessions s on s.id = q.session_id
   where q.status = 'done' and s.ride_kind = 'saturday';

  -- the staff card: the newest Saturday report showing today
  select jsonb_build_object('id', p.id, 'line', p.line, 'line_ar', p.line_ar,
           'riders', case when p.riders >= 10 then p.riders end, 'rides', case when p.rides >= 10 then p.rides end,
           'date', s.session_date, 'img', p.img is not null)
    into v_post from hub_posts p left join sessions s on s.id = p.session_id
   where v_today between p.shows_from and p.shows_until order by p.shows_from desc, p.created_at desc limit 1;
  select value into v_ann from site_content where key = 'site.announce.messages';
  select vs.session_id into v_vol from volunteer_sessions vs join sessions s on s.id = vs.session_id
   where vs.enabled and vs.signup_open
     and now() between vs.opens_at and vs.closes_at and s.session_date >= to_char(v_today, 'YYYY-MM-DD')
   order by vs.closes_at limit 1;
  select c.birth_date into v_bd from customers c where c.id = p_id;
  /* a 29 February birthday falls on 28 February in a year with no 29th, as the website greets it (bh11 hub-8) */
  if v_bd ~ '^\d{4}-\d{2}-\d{2}$'
     and (right(v_bd, 5) = to_char(v_today, 'MM-DD')
          or (right(v_bd, 5) = '02-29' and to_char(v_today, 'MM-DD') = '02-28'
              and extract(day from make_date(extract(year from v_today)::int, 3, 1) - 1) = 28)) then
    v_bday := true;
  end if;

  -- December and January: the year that is ending or has just ended; in full from 27 December
  if extract(month from v_today) in (12, 1) then
    v_year := extract(year from v_today)::integer - (case when extract(month from v_today) = 1 then 1 else 0 end);
    with mine as (
      select distinct q.session_id, s.session_date, coalesce(s.ride_kind, 'rental') as kind
        from queue_entries q join sessions s on s.id = q.session_id
       where q.customer_id = any(v_accts) and q.status = 'done' and left(s.session_date, 4) = v_year::text)
    select case when count(*) = 0 then null else jsonb_build_object('year', v_year,
             'full', not (extract(month from v_today) = 12 and extract(day from v_today) < 27),
             'sessions', count(*),
             'saturdays', count(*) filter (where kind = 'saturday'),
             'first', min(session_date),
             'kinds', (select jsonb_agg(distinct m2.kind) from mine m2),
             'busiest', (select left(m3.session_date, 7) from mine m3 group by left(m3.session_date, 7) order by count(*) desc, left(m3.session_date, 7) limit 1),
             'sats_held', (select count(distinct s2.session_date) from queue_entries q2 join sessions s2 on s2.id = q2.session_id
                            where q2.status = 'done' and s2.ride_kind = 'saturday' and left(s2.session_date, 4) = v_year::text
                              and s2.session_date >= min(mine.session_date)),
             'club', (select count(*) from queue_entries q3 join sessions s3 on s3.id = q3.session_id
                       where q3.status = 'done' and left(s3.session_date, 4) = v_year::text),
             'club_first', (select min(s4.session_date) from queue_entries q4 join sessions s4 on s4.id = q4.session_id
                             where q4.status = 'done' and left(s4.session_date, 4) = v_year::text),
             'badges', (select count(*) from customer_badges cb where cb.customer_id = any(v_accts)
                          and extract(year from cb.awarded_at at time zone 'Asia/Riyadh') = v_year)) end
      into v_year_doc from mine;
  end if;

  return jsonb_build_object('ok', true,
    'today', v_today,
    'me', jsonb_build_object('kind', lv.kind, 'levels', to_jsonb(lv.levels), 'target', lv.target, 'chosen', lv.chosen,
            'n', _hub_n(v_accts, v_month, v_end, false), 'ends_on', v_end, 'sats', _hub_sats(v_month)),
    'club', v_club,
    'goals', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'name_ar', g.name_ar, 'scope', g.scope, 'target', g.target,
               'n', _hub_count(v_accts, g.scope, g.starts_on, g.ends_on), 'ends_on', g.ends_on,
               'badge', case when bd.id is not null then jsonb_build_object('slug', bd.slug, 'icon', bd.icon, 'color', bd.color) end)
               order by g.ends_on)
        from hub_goals g left join badges bd on bd.id = g.badge_id and not bd.retired
       where g.kind = 'challenge' and v_today between g.starts_on and g.ends_on), '[]'::jsonb),
    'numbers', jsonb_build_object(
      'last', v_last, 'last_riders', case when v_lr >= 10 then v_lr end, 'last_rides', case when v_lp >= 10 then v_lp end,
      'month', case when v_mn >= 10 then v_mn end, 'all', case when v_all >= 10 then v_all end, 'since', v_first),
    'post', v_post,
    'announce', coalesce(v_ann, '[]'::jsonb),
    'volunteer', v_vol,
    'birthday', v_bday,
    'awarded', to_jsonb(v_got),
    'year', v_year_doc);
end $function$;

-- 14 photos bucket: a limit on uploads with the public key ------------------
create or replace function public._photos_upload_ok()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  /* staff as before; anyone else (riders upload with the public key) while the bucket has taken fewer than 30
     pictures in ten minutes and 200 in a day (bh11 dbgrants-1) */
  select coalesce((select is_staff()), false)
      or ((select count(*) from storage.objects o
            where o.bucket_id = 'photos' and o.created_at > now() - interval '10 minutes') < 30
          and (select count(*) from storage.objects o
                where o.bucket_id = 'photos' and o.created_at > now() - interval '1 day') < 200)
$function$;
revoke all on function public._photos_upload_ok() from public, anon, authenticated;
grant execute on function public._photos_upload_ok() to anon, authenticated;

drop policy if exists "photos upload" on storage.objects;
create policy "photos upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'photos' and name ~ '^p/[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png|webp)$'
              and (select public._photos_upload_ok()));

-- checks: every function kept SECURITY DEFINER and its search_path; the guards, their triggers and the policy are there
do $chk$
declare f text;
begin
  foreach f in array array['rider_edit', 'staff_vl_receipt', 'staff_volunteer_decide', 'staff_locker_cancel', 'staff_merge_customers', 'staff_unmerge_customers', 'staff_move_session', 'staff_locker_edit', 'volunteer_interest', 'staff_wallet_refund_booking', 'hub_pick_level', 'hub_feed', '_photos_upload_ok'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['_team_member_name_guard', '_tags_admin_guard'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing or has no search_path', f;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger where tgname = 'team_members_name_guard' and tgrelid = 'public.team_members'::regclass)
     or not exists (select 1 from pg_trigger where tgname = 'tags_admin_guard' and tgrelid = 'public.tags'::regclass) then
    raise exception 'a guard trigger is missing';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'photos upload'
                   and with_check like '%_photos_upload_ok%') then
    raise exception 'the photos upload policy is missing its limit';
  end if;
  if not has_function_privilege('anon', 'public._photos_upload_ok()', 'execute')
     or not has_function_privilege('authenticated', 'public._photos_upload_ok()', 'execute') then
    raise exception '_photos_upload_ok lost its grant';
  end if;
  if has_function_privilege('anon', 'public.staff_locker_cancel(uuid,text,boolean,boolean)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_locker_cancel(uuid,text,boolean,boolean)', 'execute')
     or not has_function_privilege('anon', 'public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text,text)', 'execute')
     or not has_function_privilege('anon', 'public.hub_feed(text,text)', 'execute') then
    raise exception 'a grant changed';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111235100', 'bh11_live_b')
on conflict (version) do nothing;

commit;
