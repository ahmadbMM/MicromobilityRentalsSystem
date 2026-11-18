-- ============================================================================
-- 20261119000400_bh18_db4
--
-- Bug hunt 2026-11-18, package db4: database fixes (prod and staging).
--
-- 1. staff_swap_bike (sql11-3): with Settings > Business "Every returned bike needs a check" on, staff_return sends every
--    returned bike to 'check', but a swap (the desk's bike change, usually because the bike has a problem) put the bike
--    it took off the rider straight back to 'available', so the next rider could be given an unchecked bike. The bike a
--    swap takes off now goes where a return sends it: 'check' with the setting on, else 'available' as before, and the
--    answer carries held:true (as staff_return's) and old_bike_status. So that the swap's Undo, or a wrong bike typed
--    and put right, still works, a bike on check whose latest assignment is this same booking's 'swapped' one (nobody
--    has had it since) may come back to that booking: it comes off check and goes out in the one call
--    (bikes_check_hold still refuses check -> in-use in a single write everywhere else). Any other bike on check is
--    still BIKE_UNAVAILABLE. With the setting off nothing changes. Copied from 20260911120000 (its only definition).
-- 2. staff_vl_receipt / staff_vl_receipt_put (app28-1): both marked a Victory Lap / Arena booking paid by transfer (or
--    sent the receipt back and un-marked it) for any staff account (is_staff()), a view-only Owner account or a
--    staffer without Bookings editing included; the app shows the buttons only with Bookings editing. Both now ask
--    _staff_mod('queue', true), as the other Bookings writes do; the refusal is the same STAFF_ONLY. Copied from
--    20261111235100 (staff_vl_receipt) and 20261102190000 (staff_vl_receipt_put); only the gate changed.
-- 3. staff_wallet_fee (app50-1): waiving a late fee posts the fee back to the wallet with only the admin check and the
--    operator's own PIN, while every other wallet refund also asks _staff_cap('can_refund') and, over mgr_over with
--    refund ticked, an approver's PIN (_mgr_ok). The waive now asks both (CAP_REFUND, MANAGER_REQUIRED); the app's
--    _gatedRpc already asks the approver on MANAGER_REQUIRED and says CAP_REFUND in words. Copied from 20261107121000.
-- 4. _till_stamp (sql14-2, PART of the fix): a cashier could lower the opening float of an open till, or set the
--    expected cash and card before the close, through the table. The trigger now keeps float, expected_cash and
--    card_expected as they were on any update by a non-admin, except that the update closing the till writes
--    expected_cash and card_expected; a new till starts with both empty. Admins (and the database itself, no
--    signed-in account) may still correct them. NOT fixed here: the close still stores the expected figures the
--    browser worked out (_tillCloseGo), and till_counts.expected_cash too; working them out on the server needs the
--    app's whole _tillTake (bookings by method and wallet part, desk purchases, Sales receipts and their card lines,
--    wallet moves, cash deposits, earlier tills of the day) in SQL and a till_close RPC the app calls: a change of its
--    own (see the package result). Copied from 20261009150000 (its only definition); trigger till_sessions_stamp is
--    unchanged and keeps calling it.
-- 5. volunteer_name_ar_save (sql13-3): the name in Arabic a volunteer types (printed on their certificates and shown by
--    the public certificate check) refused only Latin letters and Western digits, so dashes, Arabic-Indic digits,
--    punctuation and emoji were saved. It now also has to pass _name_chars_ok and _name_parts_ok, as every other
--    name: BAD_INPUT (errcode 22023, detail name_chars), which the volunteer portal already says as a bad input.
--    Copied from 20261108220000 (its only definition).
--
-- Every function keeps its header (SECURITY DEFINER and search_path; _till_stamp is not a definer and keeps its
-- search_path) and its grants are stated again. Idempotent. Run supabase/checks/security-attributes.sql after.
-- No data is changed.
-- Rollback: re-run the five definitions from the migrations named above (and their revoke/grant lines).
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- 1 staff_swap_bike (sql11-3) ----------------------------------------------------------------------
create or replace function public.staff_swap_bike(p_booking_id text, p_new_bike_id text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare q public.queue_entries%rowtype; nb public.bikes%rowtype; bid text; a_id uuid;
        v_status text; v_held boolean := false; v_back boolean := false;   /* (bh18 sql11-3) */
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;

  select * into q from public.queue_entries where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND: no booking %', p_booking_id; end if;
  if q.status <> 'active' then
    raise exception 'BAD_BOOKING_STATE: #% is %, not on a bike', coalesce(q.queue_num::text, q.id), q.status;
  end if;
  if exists (select 1 from public.bike_assignments where booking_id = q.id and bike_id = p_new_bike_id and returned_at is null) then
    return jsonb_build_object('ok', true, 'noop', true);
  end if;

  -- The bike taken off the rider goes where a return sends it (bh18 sql11-3): with the business setting "Every
  -- returned bike needs a check" on, to 'check', which nobody can hand out until staff clear it; else back in the pool.
  v_status := case when public._return_check_all() then 'check' else 'available' end;

  -- old bikes first (lower ids lock first), then the new one, all by id order
  for bid in
    select distinct x.bike_id from (
      select bike_id from public.bike_assignments where booking_id = q.id and returned_at is null
      union
      select q.assigned_bike_id where q.assigned_bike_id is not null and q.assigned_bike_id not like '[%'
      union
      select arr from jsonb_array_elements_text(case when q.assigned_bike_id like '[%' then q.assigned_bike_id::jsonb else '[]'::jsonb end) as arr
    ) x where x.bike_id <> p_new_bike_id order by 1
  loop
    perform 1 from public.bikes where id = bid for update;
    update public.bikes set status = v_status where id = bid and status = 'in-use';
    if found and v_status = 'check' then v_held := true; end if;
  end loop;
  update public.bike_assignments
     set returned_at = now(), returned_by = auth.uid(), return_condition = 'swapped'
   where booking_id = q.id and returned_at is null;

  select * into nb from public.bikes where id = p_new_bike_id for update;
  if not found then raise exception 'BIKE_NOT_FOUND: no bike %', p_new_bike_id; end if;
  -- A bike on check because a swap took it off THIS booking, and handed to nobody since, may come back to it
  -- (bh18 sql11-3): the swap's Undo, or a wrong bike typed and put right. Any other bike on check stays refused.
  if nb.status = 'check' and exists (
       select 1 from public.bike_assignments a
        where a.bike_id = nb.id and a.booking_id = q.id and a.return_condition = 'swapped' and a.returned_at is not null
          and not exists (select 1 from public.bike_assignments b
                           where b.bike_id = nb.id and b.id <> a.id
                             and (b.returned_at is null or b.assigned_at > a.assigned_at))) then
    v_back := true;
  elsif nb.status <> 'available' then
    raise exception 'BIKE_UNAVAILABLE: bike % is %', coalesce(nb.bike_number::text, nb.name), nb.status;
  end if;
  -- its own rider's bike comes off check first: bikes_check_hold refuses check -> in-use in one write
  if v_back then update public.bikes set status = 'available' where id = nb.id; end if;
  update public.bikes set status = 'in-use' where id = nb.id;
  update public.queue_entries set assigned_bike_id = nb.id where id = q.id;
  insert into public.bike_assignments (booking_id, bike_id, assigned_by)
    values (q.id, nb.id, auth.uid()) returning id into a_id;
  return jsonb_build_object('ok', true, 'noop', false, 'assignment_id', a_id, 'held', v_held, 'old_bike_status', v_status);
end $$;
revoke execute on function public.staff_swap_bike(text,text) from public, anon;
grant execute on function public.staff_swap_bike(text,text) to authenticated;

-- 2 staff_vl_receipt, staff_vl_receipt_put (app28-1) ------------------------------------------------
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
  /* staff who may change Bookings, as the app's Confirm / Not valid / Upload buttons (bh18 app28-1): is_staff()
     let a view-only Owner account, or a staffer without Bookings editing, mark a booking paid by transfer */
  if not coalesce((select public._staff_mod('queue', true)), false) then
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
revoke all on function public.staff_vl_receipt(text, boolean) from public, anon;
grant execute on function public.staff_vl_receipt(text, boolean) to authenticated;

create or replace function public.staff_vl_receipt_put(p_entry_id text, p_img text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_img text := nullif(btrim(coalesce(p_img, '')), '');
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_paid boolean;
  v_method text;
  v_cust text;
begin
  /* staff who may change Bookings, as the app's Confirm / Not valid / Upload buttons (bh18 app28-1): is_staff()
     let a view-only Owner account, or a staffer without Bookings editing, mark a booking paid by transfer */
  if not coalesce((select public._staff_mod('queue', true)), false) then
    raise exception 'STAFF_ONLY: staff only' using errcode = '42501';
  end if;
  if v_img is null or v_img !~ '^data:image/(jpeg|png|webp);base64,' or length(v_img) > 3000000 then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'vl_receipt';
  end if;
  select coalesce(x.paid, false), x.pay_method, x.customer_id
    into v_paid, v_method, v_cust
    from queue_entries x join sessions s on s.id = x.session_id
   where x.id = p_entry_id
     and coalesce(s.ride_kind, '') in ('vlap', 'arena')
     and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow')
   for update of x;
  if not found then return 'missing'; end if;
  insert into vl_receipts (entry_id, customer_id, img) values (p_entry_id, v_cust, v_img)
  on conflict (entry_id) do update set img = excluded.img, customer_id = excluded.customer_id, created_at = now();
  if v_paid and coalesce(v_method, '') <> 'transfer' then
    update queue_entries set vl_ticket = 'buy', vl_ticket_at = v_now, vl_receipt_at = v_now where id = p_entry_id;
    return 'desk';
  end if;
  update queue_entries
     set vl_ticket = 'buy', vl_ticket_at = v_now, vl_receipt_at = v_now,
         paid = true, pay_method = 'transfer', card_amount = null
   where id = p_entry_id;
  return 'confirmed';
end $function$;
revoke all on function public.staff_vl_receipt_put(text, text) from public, anon;
grant execute on function public.staff_vl_receipt_put(text, text) to authenticated;

-- 3 staff_wallet_fee (app50-1) ----------------------------------------------------------------------
create or replace function public.staff_wallet_fee(p_booking_id text, p_waive boolean default false,
                                                   p_op text default null, p_approval text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare
  q queue_entries%rowtype; biz jsonb; k text; amt numeric; held numeric; who text; b numeric; took numeric;
  hrs int; st_txt text; start_at timestamptz; rk text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;  -- money out of a wallet is an admin's (2026-11-03)
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into q from queue_entries where id = p_booking_id for update;
  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if q.customer_id is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
  select coalesce(-sum(l.amount), 0) into held from wallet_ledger l where l.booking_id = q.id and l.kind in ('fee', 'fee_back');
  perform set_config('mm.wallet_op', coalesce(p_op, ''), true);

  if coalesce(p_waive, false) then
    if held <= 0 then raise exception 'FEE_NONE' using errcode = 'P0001'; end if;
    /* a waive puts money back in a wallet: it asks what every other wallet refund asks (bh18 app50-1), the refund
       right and, over Settings > Business mgr_over with refund ticked, an approver's PIN (the app already asks it) */
    if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
    if not _mgr_ok('refund', held, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
    select _wallet_owner(l.customer_id) into who from wallet_ledger l
     where l.booking_id = q.id and l.kind = 'fee' order by l.id desc limit 1;
    perform set_config('mm.wallet_note', 'waived', true);
    b := _wallet_post(who, held, 'fee_back', null, null, q.id, null, q.session_id);
    perform set_config('mm.wallet_note', '', true);
    return jsonb_build_object('ok', true, 'id', q.id, 'amount', held, 'balance', b, 'waived', true);
  end if;

  if held > 0 then raise exception 'FEE_ALREADY' using errcode = 'P0001'; end if;
  select items into biz from staff_options where key = 'biz';
  if coalesce(biz ->> 'late_fee_on', '') <> 'true' then raise exception 'FEE_OFF' using errcode = 'P0001'; end if;
  select s.ride_kind, _rs_time(s.bike_slots::text) into rk, st_txt from sessions s where s.id = q.session_id;
  if rk in ('vlap', 'arena') then raise exception 'WALLET_RACE' using errcode = 'P0001'; end if;

  if q.status = 'noshow' then
    k := 'noshow';
    amt := case when jsonb_typeof(biz -> 'late_fee_noshow') = 'number' then (biz ->> 'late_fee_noshow')::numeric end;
  elsif q.status = 'cancelled' and q.cancelled_by = 'customer' and q.cancelled_at is not null then
    k := 'late_cancel';
    amt := case when jsonb_typeof(biz -> 'late_fee_cancel') = 'number' then (biz ->> 'late_fee_cancel')::numeric end;
    hrs := case when jsonb_typeof(biz -> 'late_fee_hours') = 'number' then least(greatest((biz ->> 'late_fee_hours')::numeric, 1), 72)::int else 24 end;
    -- the start: the session's date at the first time in its bike_slots (_time), Riyadh; 18:00 when it has none
    st_txt := coalesce(substring(coalesce(st_txt, '') from '(\d{1,2}:\d{2})'), '18:00');
    start_at := (q.session_date::date + st_txt::time) at time zone 'Asia/Riyadh';
    if q.cancelled_at < start_at - make_interval(hours => hrs) then raise exception 'FEE_NOT_LATE' using errcode = 'P0001'; end if;
  else
    raise exception 'FEE_NOT_DUE' using errcode = 'P0001';
  end if;
  if amt is null or amt <= 0 or amt > 1000 then raise exception 'FEE_NO_AMOUNT' using errcode = 'P0001'; end if;

  who := _wallet_owner(q.customer_id);
  select balance into b from wallet_balances where customer_id = who;
  took := least(round(amt, 2), coalesce(b, 0));
  if took <= 0 then raise exception 'WALLET_SHORT' using errcode = 'P0001'; end if;
  perform set_config('mm.wallet_note', k, true);
  b := _wallet_post(who, -took, 'fee', null, null, q.id, null, q.session_id);
  perform set_config('mm.wallet_note', '', true);
  return jsonb_build_object('ok', true, 'id', q.id, 'kind', k, 'amount', took, 'balance', b);
end $$;
revoke all on function public.staff_wallet_fee(text, boolean, text, text) from public, anon;
grant execute on function public.staff_wallet_fee(text, boolean, text, text) to authenticated;

-- 4 _till_stamp (sql14-2, part) --------------------------------------------------------------------
create or replace function public._till_stamp()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  if tg_op = 'INSERT' then
    new.opened_by := coalesce(auth.uid(), new.opened_by);
    new.opened_at := now();
    new.closed_at := null; new.closed_by := null;
    new.expected_cash := null; new.card_expected := null;   -- written once, by the close (bh18 sql14-2)
  else
    new.opened_by := old.opened_by; new.opened_at := old.opened_at;
    -- The figures a till is checked against (bh18 sql14-2): for anyone but an admin (or the database itself, no signed-in
    -- account) the opening float stays what the till opened with, and the expected cash and card are written only by
    -- the update that closes it.
    if auth.uid() is not null and not coalesce(public.is_admin(), false) then
      new.float := old.float;
      if not (new.closed_at is not null and old.closed_at is null) then
        new.expected_cash := old.expected_cash; new.card_expected := old.card_expected;
      end if;
    end if;
    if new.closed_at is not null and old.closed_at is null then
      new.closed_at := now();
      new.closed_by := coalesce(auth.uid(), new.closed_by);
    elsif old.closed_at is not null then
      new.closed_at := old.closed_at; new.closed_by := old.closed_by;
    end if;
  end if;
  return new;
end $fn$;
revoke all on function public._till_stamp() from public, anon, authenticated;

-- 5 volunteer_name_ar_save (sql13-3) ---------------------------------------------------------------
create or replace function public.volunteer_name_ar_save(p_id text, p_token text, p_name_ar text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _v text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  _v := left(nullif(btrim(coalesce(p_name_ar, '')), ''), 120);
  -- A name in Arabic carries no Latin letter and no Western digit. Written as a refusal rather than
  -- an Arabic range: a range in a regex is read by the collation, and this database's is not C.
  if _v is not null and _v ~ '[A-Za-z0-9]' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  -- and the names rule every other name obeys (bh18 sql13-3): letters and spaces, no dash, no digit of any script,
  -- no punctuation, no emoji, no one-letter word (_name_chars_ok, _name_parts_ok, as customers.name)
  if _v is not null and (not _name_chars_ok(_v) or not _name_parts_ok(_v)) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'name_chars';
  end if;
  update customers set name_ar = _v where id = p_id and merged_into is null;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true, 'name_ar', _v);
end $function$;

-- checks: every function kept SECURITY DEFINER (but _till_stamp) and its search_path, and its grants
do $chk$
declare f text;
begin
  foreach f in array array['public.staff_swap_bike(text,text)', 'public.staff_vl_receipt(text,boolean)',
                           'public.staff_vl_receipt_put(text,text)', 'public.staff_wallet_fee(text,boolean,text,text)',
                           'public.volunteer_name_ar_save(text,text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public.staff_swap_bike(text,text)', 'public.staff_vl_receipt(text,boolean)',
                           'public.staff_vl_receipt_put(text,text)', 'public.staff_wallet_fee(text,boolean,text,text)'] loop
    if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% has the wrong grants', f;
    end if;
  end loop;
  if not exists (select 1 from pg_proc p where p.oid = 'public._till_stamp()'::regprocedure and not p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '_till_stamp lost its search_path';
  end if;
  if has_function_privilege('authenticated', 'public._till_stamp()', 'execute') then
    raise exception 'authenticated can run _till_stamp';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'till_sessions_stamp' and tgrelid = 'public.till_sessions'::regclass) then
    raise exception 'trigger till_sessions_stamp is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119000400', 'bh18_db4')
on conflict (version) do nothing;

commit;

-- Read-only check after applying (expect: t, t, t, t, t, t, t, t, 1):
-- select (select prosecdef from pg_proc where oid = 'public.staff_swap_bike(text,text)'::regprocedure),
--        pg_get_functiondef('public.staff_swap_bike(text,text)'::regprocedure) like '%_return_check_all()%',
--        pg_get_functiondef('public.staff_vl_receipt(text,boolean)'::regprocedure) like '%_staff_mod(''queue'', true)%',
--        pg_get_functiondef('public.staff_vl_receipt_put(text,text)'::regprocedure) like '%_staff_mod(''queue'', true)%',
--        pg_get_functiondef('public.staff_wallet_fee(text,boolean,text,text)'::regprocedure) like '%_mgr_ok(''refund'', held, p_approval)%',
--        pg_get_functiondef('public.volunteer_name_ar_save(text,text,text)'::regprocedure) like '%_name_chars_ok(_v)%',
--        pg_get_functiondef('public._till_stamp()'::regprocedure) like '%new.float := old.float%',
--        not has_function_privilege('anon', 'public.staff_wallet_fee(text,boolean,text,text)', 'execute'),
--        (select count(*) from supabase_migrations.schema_migrations where version = '20261119000400');
