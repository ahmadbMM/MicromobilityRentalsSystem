-- ============================================================================
-- Bug hunt 2026-11-10 (bh10), the live database, part C: the staff side. For PROD and STAGING (every function
-- here was the same on both on 2026-11-10). Apply after 20261110235000_bh10_live_a.sql (it checks) and, on
-- staging, after 20261110235200_bh10_payments.sql.
--
-- 1. staff_my_settings (app26-1, app26-2):
--    (a) the bell's switches on Settings: the saved off-list kept only 10 of the bell's 22 kinds, so "Session
--        full", "Waitlist place free", "Close-out", "Referral held" and the others could never be turned off.
--        Every kind of the app's NT_KINDS is kept now.
--    (b) a new name that another team-list entry already has (that entry's PIN) is refused with NAME_TAKEN
--        (the app says so) instead of being taken while the account's own entry stayed behind. A change of
--        capitals only ('ali' to 'Ali') now moves the account's own entry and its PIN; before, it matched itself
--        as a clash and the entry kept the old spelling. An account with no name yet is refused a name already on
--        the team list as well (none on production on 2026-11-10: every live account has a name, the list is empty).
-- 2. staff_volunteer_shift_save (app07-5): saving a role or note on an offer that ended sent its status 'ended'
--    back, which was refused (BAD_STATUS). 'ended' is accepted; unchanged, it writes no log line.
-- 3. staff_offer_spot (app28-1): staff could offer the one free place to a second waitlisted rider while it was
--    out on another rider's open offer (two devices, or two taps), and whoever claimed second got FULL. A new offer
--    now needs a place free once the places held, the open offers and the bikes out of service are counted, as
--    _wl_offer_fill counts them; else NO_PLACE (the app says the ride has no free place). Also: called without a
--    booking id (offer the next rider in line) it always stopped with "column reference o.booking_id is ambiguous"
--    (its subquery's alias was the name of its offer variable); the alias is renamed. The app always names the rider.
-- 4. staff_move_session (app17-3): moving a session to another date kept its announce time (reveal_at), its timed
--    opening (opens_at) and its go/no-go decision time (go_decide_at) on the old date, so a Saturday ride moved
--    earlier never showed riders its breakfast spot. They move by the same number of days now; none stays none.
-- 5. customer_locker_change: a locker staff gave on the house became payable when the rider changed its time
--    (the new time's fee). It stays free now, as staff_locker_edit has it. Patched on production's text, or on
--    20261110235200_bh10_payments.sql's on staging. That file replaces the function whole: when it goes to
--    production after this one, run this file again after it (only this item is redone; the rest is skipped).
-- 6. staff_delete_customer (app18-1): a deleted rider's own codes (RF-, RW-, VL-, BD-, a code made for them) stayed
--    live, bound to an account id that no longer exists, and a later edit of the code could leave it open to
--    anyone. They are turned off with the account.
-- 7. staff_rider_party_move (app35-3): a registration with no booking number (older rows) took every other
--    unnumbered registration of its night along when it was moved, all under one new number. It is a party of
--    one now.
-- 8. staff_void_receipt, staff_refund_receipt (app36-1): a workshop job paid by a till receipt stayed "Paid" after
--    the receipt was voided or refunded, so the right payment could not be taken. The job is unpaid again now
--    (staff_wallet_refund_receipt refunds through staff_refund_receipt, so it is covered too).
--
-- Not changed: app28-3 (the bikes out of service in _promote_next_waitlist, _wl_offer_fill and
-- customer_claim_spot): 20261110235000_bh10_live_a.sql already counts them in all three (_out_bikes_room).
-- app25-1 (staff_set_price and the manager's limit): the live function already calls
-- _mgr_ok('price', old price - new price, p_approval) after _pin_ok.
--
-- Each function is patched in place from its live text (pg_get_functiondef): every anchor must be found exactly
-- once (the party move's four times), else the file stops. The header, SECURITY DEFINER, the search_path and the
-- grants are kept. A function already carrying this file's mark (20261110235300) is left alone, so a re-run
-- changes nothing.
-- Run supabase/checks/security-attributes.sql after.
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

create or replace function pg_temp._times(def text, a text, b text, n int) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> n then
    raise exception 'anchor not found % times: %', n, left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

-- bh10_live_a first: staff_move_session is patched on its text, staff_offer_spot calls its _out_bikes_room
do $pre$
begin
  if to_regprocedure('public._out_bikes_room(text,text,text,boolean)') is null
     or position('20261110235000' in pg_get_functiondef('public.staff_move_session(text,text,text,boolean)'::regprocedure)) = 0 then
    raise exception 'apply 20261110235000_bh10_live_a.sql first';
  end if;
end $pre$;


-- 1 staff_my_settings --------------------------------------------------------------------------------
do $do$
declare d text;
begin
  select pg_get_functiondef('public.staff_my_settings(text,text,boolean,text[])'::regprocedure) into d;
  if position('20261110235300' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$    select nullif(btrim(s.display_name), '') into _old from staff s where s.user_id = _uid;
    update staff set display_name = _new where user_id = _uid;$a$,
$b$    select nullif(btrim(s.display_name), '') into _old from staff s where s.user_id = _uid;
    /* Another team-list entry has the name (and its PIN): refused, the account keeps its own. A change of
       capitals only is the account's own entry (bug hunt 2026-11-10, 20261110235300). */
    if exists (select 1 from team_members t
                where lower(t.name) = lower(_new) and lower(t.name) <> lower(coalesce(_old, ''))) then
      raise exception 'NAME_TAKEN' using errcode = '23505';
    end if;
    update staff set display_name = _new where user_id = _uid;$b$);
  d := pg_temp._once(d,
$a$    if _old is not null and _old <> _new
       and not exists (select 1 from team_members where lower(name) = lower(_new)) then
      update team_members set name = _new where name = _old;
    end if;$a$,
$b$    /* the account's own entry moves, PIN and all: the one of its old name, else the one that differs from it
       only in capitals (20261110235300) */
    if _old is not null and _old <> _new and not exists (select 1 from team_members where name = _new) then
      update team_members set name = _new
       where name = coalesce((select t.name from team_members t where t.name = _old),
                             (select t.name from team_members t where lower(t.name) = lower(_old) order by t.name limit 1));
    end if;$b$);
  d := pg_temp._once(d,
$a$k in ('long','ws','apps','learn','bday','msgs','attn','lowrate','stock','vlate')$a$,
$b$k in (/* every kind the bell has, the app's NT_KINDS (20261110235300) */
                    'refheld','long','coopen','kiosk','ws','apps','learn','bday','msgs','attn','lowrate','stock','vlate',
                    'natnew','closeout','remind','wlfree','sneeds','sfull','gonogo','vsign','vopen')$b$);
  execute d;
end $do$;


-- 2 staff_volunteer_shift_save -----------------------------------------------------------------------
do $do$
declare d text;
begin
  select pg_get_functiondef('public.staff_volunteer_shift_save(text,text,text,text,text)'::regprocedure) into d;
  if position('20261110235300' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$if p_status not in ('interested', 'accepted', 'declined', 'withdrawn', 'blocked', 'no_show', 'done') then$a$,
$b$if p_status not in ('interested', 'accepted', 'declined', 'withdrawn', 'blocked', 'no_show', 'done',
                       'ended' /* the system writes it; a role or note saved on an ended offer sends it back (20261110235300) */) then$b$);
  execute d;
end $do$;


-- 3 staff_offer_spot ---------------------------------------------------------------------------------
do $do$
declare d text;
begin
  select pg_get_functiondef('public.staff_offer_spot(text,text)'::regprocedure) into d;
  if position('20261110235300' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$declare _s sessions%rowtype; _own boolean; _bid text; o waitlist_offers%rowtype;$a$,
$b$declare _s sessions%rowtype; _own boolean; _bid text; o waitlist_offers%rowtype; _typ text; _held int; _open int; _out int := 0;$b$);
  d := pg_temp._once(d,
$a$       and not exists (select 1 from waitlist_offers o where o.booking_id = q.id
                        and o.status in ('open', 'expired', 'declined'))$a$,
$b$       and not exists (select 1 from waitlist_offers wo where wo.booking_id = q.id   /* not o, the offer variable (20261110235300) */
                        and wo.status in ('open', 'expired', 'declined'))$b$);
  d := pg_temp._once(d,
$a$  if not found then
    insert into waitlist_offers (booking_id, session_id, token, expires_at, offered_by)$a$,
$b$  if not found then
    /* A new offer only into a place still free: the places held, the open offers and the bikes out of service
       counted as _wl_offer_fill counts them, so one place is never promised to two riders (bug hunt 2026-11-10,
       20261110235300). An open offer counts while its rider still waits (as the app counts it); an own bike
       takes no place but on the Petromin night. */
    select coalesce(q.type_preference, '') into _typ from queue_entries q where q.id = _bid;
    if _own or _typ <> 'Own' then
      select count(*) into _held from queue_entries q
       where q.session_id = p_session_id
         and coalesce(q.status,'') not in ('cancelled','removed','noshow','waitlist')
         and (_own or coalesce(q.type_preference,'') <> 'Own');
      select count(*) into _open from waitlist_offers w join queue_entries x on x.id = w.booking_id
       where w.session_id = p_session_id and w.status = 'open' and w.expires_at > now()
         and x.status = 'waitlist' and (_own or coalesce(x.type_preference,'') <> 'Own');
      select coalesce(sum(greatest(0, floor((value #>> '{}')::numeric))), 0)::int into _out
        from jsonb_each(coalesce(_s.out_bikes, '{}'::jsonb)) where jsonb_typeof(value) = 'number';
      if greatest(0, coalesce(_s.capacity, 12) - _out) - _held - _open <= 0
         or (_out > 0 and not _out_bikes_room(p_session_id, _typ, _bid, true)) then
        raise exception 'NO_PLACE' using errcode = 'P0001';
      end if;
    end if;
    insert into waitlist_offers (booking_id, session_id, token, expires_at, offered_by)$b$);
  execute d;
end $do$;


-- 4 staff_move_session (on bh10_live_a's text) -------------------------------------------------------
do $do$
declare d text;
begin
  select pg_get_functiondef('public.staff_move_session(text,text,text,boolean)'::regprocedure) into d;
  if position('20261110235300' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$jsonb_build_object('id', v_to, 'session_date', to_char(d, 'YYYY-MM-DD'), 'day', v_day)$a$,
$b$jsonb_build_object('id', v_to, 'session_date', to_char(d, 'YYYY-MM-DD'), 'day', v_day,
      /* the ride's own moments move with its date, as many days on or back (bug hunt 2026-11-10, 20261110235300):
         its announce time, its timed opening, its go/no-go decision time; none stays none */
      'reveal_at', s.reveal_at + make_interval(days => coalesce(d - s.session_date::date, 0)),
      'opens_at', s.opens_at + make_interval(days => coalesce(d - s.session_date::date, 0)),
      'go_decide_at', s.go_decide_at + make_interval(days => coalesce(d - s.session_date::date, 0)))$b$);
  execute d;
end $do$;


-- 5 customer_locker_change (production's text, or 20261110235200_bh10_payments.sql's on staging) --------
do $do$
declare d text;
begin
  select pg_get_functiondef('public.customer_locker_change(text,text,uuid,text,text)'::regprocedure) into d;
  if position('20261110235300' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$  fee := _lk_price(p_period);$a$,
$b$  fee := case when r.house then 0 else _lk_price(p_period) end;  /* on the house stays free, as staff_locker_edit has it (bug hunt 2026-11-10, 20261110235300) */$b$);
  execute d;
end $do$;


-- 6 staff_delete_customer ----------------------------------------------------------------------------
do $do$
declare d text;
begin
  select pg_get_functiondef('public.staff_delete_customer(text,text,text)'::regprocedure) into d;
  if position('20261110235300' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$  delete from push_subscriptions where customer_id = any(v_ids);
  get diagnostics v_push = row_count;$a$,
$b$  delete from push_subscriptions where customer_id = any(v_ids);
  get diagnostics v_push = row_count;
  /* Their own codes stop (RF-, RW-, VL-, BD-, a code made for them): promo_codes.customer_id has no key, so the
     code stayed live, bound to an account that is gone (bug hunt 2026-11-10, 20261110235300). */
  update promo_codes set active = false where customer_id = any(v_ids) and active;$b$);
  execute d;
end $do$;


-- 7 staff_rider_party_move ---------------------------------------------------------------------------
do $do$
declare d text;
begin
  select pg_get_functiondef('public.staff_rider_party_move(bigint,text)'::regprocedure) into d;
  if position('20261110235300' in d) > 0 then return; end if;
  d := pg_temp._times(d,
$a$x.booking_no is not distinct from old_bno and coalesce(x.session_id, '') = coalesce(old_sess, '')$a$,
$b$(case when old_bno is null then x.id = r.id else x.booking_no = old_bno and coalesce(x.session_id, '') = coalesce(old_sess, '') end)$b$,
    4);
  d := pg_temp._once(d,
$a$  update rider_registrations set session_id = p_session, booking_no = bno
   where booking_no is not distinct from old_bno and coalesce(session_id, '') = coalesce(old_sess, '');$a$,
$b$  /* A registration with no number is a party of one (bug hunt 2026-11-10, 20261110235300): every unnumbered
     registration of its night moved with it, under one new number. The lock, the checked-in, on-a-bike and
     movers checks above count the party the same way. */
  update rider_registrations set session_id = p_session, booking_no = bno
   where case when old_bno is null then id = r.id
              else booking_no = old_bno and coalesce(session_id, '') = coalesce(old_sess, '') end;$b$);
  execute d;
end $do$;


-- 8 staff_void_receipt, staff_refund_receipt ---------------------------------------------------------
do $do$
declare d text; f text;
begin
  foreach f in array array['public.staff_void_receipt(text,text,text,text,uuid)',
                           'public.staff_refund_receipt(text,text,text,text,uuid)'] loop
    select pg_get_functiondef(f::regprocedure) into d;
    continue when position('20261110235300' in d) > 0;
    d := pg_temp._once(d,
$a$  v_res := jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'count', n, 'items', items);$a$,
$b$  /* A workshop job this receipt paid is unpaid again, for its payment to be taken anew (bug hunt 2026-11-10,
     20261110235300). staff_wallet_refund_receipt refunds through staff_refund_receipt. */
  update workshop_jobs set paid_at = null, paid_receipt = null,
         updated_by = coalesce(left(nullif(btrim(coalesce(p_op, '')), ''), 120), updated_by)
   where paid_receipt = p_receipt_id;
  v_res := jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'count', n, 'items', items);$b$);
    execute d;
  end loop;
end $do$;


-- checks: every function carries this file's change, kept SECURITY DEFINER and its search_path, and its grants
do $chk$
declare f text;
begin
  foreach f in array array['public.staff_my_settings(text,text,boolean,text[])',
                           'public.staff_volunteer_shift_save(text,text,text,text,text)',
                           'public.staff_offer_spot(text,text)',
                           'public.staff_move_session(text,text,text,boolean)',
                           'public.customer_locker_change(text,text,uuid,text,text)',
                           'public.staff_delete_customer(text,text,text)',
                           'public.staff_rider_party_move(bigint,text)',
                           'public.staff_void_receipt(text,text,text,text,uuid)',
                           'public.staff_refund_receipt(text,text,text,text,uuid)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and position('20261110235300' in p.prosrc) > 0
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path, or lacks this file''s change', f;
    end if;
    if not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% lost its grant', f;
    end if;
    if f <> 'public.customer_locker_change(text,text,uuid,text,text)' and has_function_privilege('anon', f, 'execute') then
      raise exception '% is open to anon', f;
    end if;
  end loop;
  if not has_function_privilege('anon', 'public.customer_locker_change(text,text,uuid,text,text)', 'execute') then
    raise exception 'customer_locker_change lost its grant';
  end if;
  if (select string_agg(x, ',') from unnest((select proconfig from pg_proc
        where oid = 'public.staff_my_settings(text,text,boolean,text[])'::regprocedure)) x) not like '%extensions%' then
    raise exception 'staff_my_settings lost extensions from its search_path';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261110235300', 'bh10_live_c')
on conflict (version) do nothing;

commit;
