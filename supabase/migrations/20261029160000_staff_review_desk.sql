-- ============================================================================
-- The desk, from the staff panel review (2026-10-28, batch 2: P10 and P13; S03-core3-05, S04-core4-04,
-- S14-best-practice-03). Not during a ride night (about 18:00-23:00 Riyadh). Apply once the app that knows
-- NOT_APPROVED and the waiver sheet is live (an older page reads NOT_APPROVED as its raw sentence, and never
-- calls the new function).
--
-- 1. staff_checkin refuses a request not approved yet. On an approval ride (a community ride, not the National Day
--    ride, with needs_approval true: the Saturday ride, a workshop or a pool session staff approve; one with none set
--    is not refused here, as the other functions read none as false) a booking whose approval is not 'approved'
--    (pending, rejected and put back, or none, which the page reads as pending) is not checked in:
--    NOT_APPROVED (P0001), which the page says in the desk's words (_rpcMessage, RPC_SAY). The roster never offered
--    such a row Check in, but Select all, the bulk Check in, a party's chain, Scan several and Express did; the
--    page leaves them out now, and this is the rule no path can get round. A booking already checked in is
--    answered as before (a no-op), so a replay of a check-in that landed still reads as landed.
-- 2. staff_record_waiver(p_entry_ids text[], p_version text, p_op text default null) - NEW. The check-in drawer's
--    "Agree on this device": a rider added at the desk reads the session's waiver on the desk device and agrees.
--    is_staff() only; one to twenty bookings, all live (waiting, waitlist or on the ride); the version must be the
--    one in force for each booking's session kind (the page's _waiverKind: ride, swim- or activity-, and not older
--    than _waiver_min, _waiver_outdated): WAIVER_REQUIRED for a version of no known shape, WAIVER_OUTDATED for an
--    older one or one of another kind, BAD_BOOKING_STATE, BOOKING_NOT_FOUND. It stamps waiver_at / waiver_version
--    (customer_accept_waiver's format) on each booking that has none - a booking that has one keeps it - and writes
--    one audit_log row per booking stamped: the staff account (actor, actor_email, as every audit row) and
--    "desk: <operator>". Answers {ok:true, stamped:n}. Executable by authenticated (the staff page calls it);
--    nothing for anon/public.
--
-- Proof staff_checkin is rebuilt from the live definition (md5 of the body between `as $function$` and the closing
-- tag, Python hashlib): no single repo file holds it. The body of 20261004120000_staff_security_oct4.sql
-- (9b432464527f7b51b329ce36fded8e61), with the PRICE_RANGE patch of 20261005210000_audit_bookings.sql (section 6)
-- and the four body replacements of 20261009215000_desk_outbox_op_ids.sql applied as those files apply them, is
-- d4108fc41ce3d4f5fda61af8fbd12d61 = production's live md5 (2026-10-29). This file's body is that text with one block
-- added after the status check (marked 20261029160000); the header is 20261004120000's with 20261009215000's p_op_id.
-- After applying, md5(prosrc): staff_checkin e9d7ed086671a392c86c0b0f3ece4a03 (8e77fed7235c5acf8b774a8752bbca94 if
-- pasted through an editor that drops whole-line comments: the live body carries two), staff_record_waiver
-- d479ef42f0e549ac8286a0e1b4587d26 (no comment lines). The check after the commit compares them.
-- Tried on a local PostgreSQL 17 holding that live staff_checkin and stand-ins for the tables and helpers it reads: the
-- in-transaction check and the check after the commit pass, a second run changes nothing, a pending, rejected or
-- unset request on a Saturday ride is refused while an approved one, one already on the ride (a no-op), a Petromin
-- night and a circuit night check in, and a refused call leaves its op id unclaimed; staff_record_waiver stamps
-- only rows with no waiver, writes one audit row each and refuses each case above (anon cannot call it).
--
-- Rollback:
--   re-run the staff_checkin block below without the four-line NOT_APPROVED block that ends in (20261029160000)
--   (what is left is the live body of 2026-10-29, md5 d4108fc41ce3d4f5fda61af8fbd12d61);
--   drop function if exists public.staff_record_waiver(text[], text, text);
--   take the staff_record_waiver line out of supabase/checks/security-attributes.sql. Waivers it stamped stay (each
--   is a rider's agreement, and an audit_log row says who took it).
-- Idempotent. Then run supabase/checks/security-attributes.sql: it must print nothing.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. staff_checkin refuses a request not approved yet ──────────────────────────────────────
create or replace function public.staff_checkin(p_booking_id text, p_bike_id text default null,
    p_paid boolean default null, p_price numeric default null, p_pay_method text default null,
    p_card_amount numeric default null, p_type text default null, p_ride_group text default null,
    p_op_id uuid default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid(); v_claimed int; v_prior jsonb; v_res jsonb; q public.queue_entries%rowtype; b public.bikes%rowtype; a_id uuid; first_a uuid; holder text;
        got text[] := '{}'; rsv text[]; bid text; dropped boolean := false; st text; new_bike text;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
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
    if p_bike_id is null then return jsonb_build_object('ok', true, 'noop', true); end if;
    if exists (select 1 from public.bike_assignments where booking_id = q.id and bike_id = b.id and returned_at is null) then
      return jsonb_build_object('ok', true, 'noop', true);
    end if;
    if q.assigned_bike_id = b.id then
      -- checked in before assignments existed on this very bike: record it, then it is a no-op
      insert into public.bike_assignments (booking_id, bike_id, assigned_by) values (q.id, b.id, auth.uid())
      on conflict (bike_id) where returned_at is null do nothing;
      return jsonb_build_object('ok', true, 'noop', true);
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
         checked_in_at = public._iso_now(),
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
revoke all on function public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid) from public, anon;
grant execute on function public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid) to authenticated, service_role;

-- ── 2. staff_record_waiver: the rider agrees on the desk device ──────────────────────────────
create or replace function public.staff_record_waiver(p_entry_ids text[], p_version text, p_op text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_ids text[]; v_pre text; v_kind text; v_n int := 0; r record;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select array_agg(distinct x) into v_ids from unnest(coalesce(p_entry_ids, '{}'::text[])) x where nullif(btrim(x), '') is not null;
  if v_ids is null or array_length(v_ids, 1) > 20 then
    raise exception 'BAD_INPUT: one to twenty bookings' using errcode = '22023';
  end if;
  if coalesce(p_version, '') !~ '^((swim|activity)-)?[0-9]{4}-[0-9]{2}-v[0-9]{1,6}$' then
    raise exception 'WAIVER_REQUIRED' using errcode = 'P0001';
  end if;
  if _waiver_outdated(p_version) then
    raise exception 'WAIVER_OUTDATED' using errcode = 'P0001';
  end if;
  v_pre := coalesce(substring(p_version from '^(swim|activity)-'), '');
  for r in select q.id, q.status, s.event_kind, s.ride_kind
             from queue_entries q left join sessions s on s.id = q.session_id
            where q.id = any(v_ids)
              for update of q loop
    v_n := v_n + 1;
    if r.status not in ('waiting', 'waitlist', 'active') then
      raise exception 'BAD_BOOKING_STATE: % is %', r.id, r.status;
    end if;
    v_kind := case when coalesce(r.event_kind, '') = 'community' and coalesce(r.ride_kind, '') <> 'snd96' then
                (case when r.ride_kind = 'swim' then 'swim'
                      when r.ride_kind in ('workshop', 'event', 'runher', 'vlap', 'arena', 'defe5k') then 'activity'
                      else '' end)
              else '' end;
    if v_pre <> v_kind then
      raise exception 'WAIVER_OUTDATED' using errcode = 'P0001';
    end if;
  end loop;
  if v_n <> array_length(v_ids, 1) then raise exception 'BOOKING_NOT_FOUND'; end if;
  with u as (
    update queue_entries q
       set waiver_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           waiver_version = p_version
     where q.id = any(v_ids) and coalesce(q.waiver_version, '') = ''
    returning q.id)
  insert into audit_log (tbl, row_id, op, changed)
  select 'queue_entries', u.id, 'UPDATE',
         jsonb_build_object('waiver_version', jsonb_build_object('old', null, 'new', p_version),
                            'waiver_by', jsonb_build_object('old', null, 'new', 'desk: ' || coalesce(nullif(left(btrim(coalesce(p_op, '')), 40), ''), 'staff')))
    from u;
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'stamped', v_n);
end
$function$;
revoke all on function public.staff_record_waiver(text[], text, text) from public, anon, authenticated;
grant execute on function public.staff_record_waiver(text[], text, text) to authenticated;

do $chk$
declare f regprocedure;
begin
  foreach f in array array['public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid)'::regprocedure,
                           'public.staff_record_waiver(text[],text,text)'::regprocedure] loop
    if not exists (select 1 from pg_proc p where p.oid = f and p.prosecdef and 'search_path=public' = any(coalesce(p.proconfig, '{}'))) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception '% is not executable by the staff page', f; end if;
  end loop;
  if position('(20261029160000)' in (select prosrc from pg_proc where oid = 'public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid)'::regprocedure)) = 0 then
    raise exception 'staff_checkin is not the 20261029160000 definition';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'staff_checkin') <> 1 then
    raise exception 'staff_checkin has more than one signature (PostgREST could not choose)';
  end if;
  if _waiver_outdated('2026-10-v3') or _waiver_outdated('swim-2026-10-v3') or _waiver_outdated('activity-2026-10-v3') then
    raise exception '_waiver_outdated refuses the versions this page sends (WAIVER_VERSION and the others in app.src.html)';
  end if;
end $chk$;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261029160000', 'staff_review_desk')
on conflict (version) do nothing;

commit;

-- ── Check (read-only), after the commit ───────────────────────────────────────────────────────
-- 1. Every line ok = true.
select 'staff_checkin refuses a request not approved yet' as what,
       (select position('NOT_APPROVED' in p.prosrc) > 0 and p.prosecdef from pg_proc p
         where p.oid = 'public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid)'::regprocedure) as ok
union all
select 'staff_checkin body is this file''s',
       (select md5(p.prosrc) in ('e9d7ed086671a392c86c0b0f3ece4a03', '8e77fed7235c5acf8b774a8752bbca94') from pg_proc p
         where p.oid = 'public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid)'::regprocedure)
union all
select 'staff_record_waiver: definer, staff page only',
       (select p.prosecdef and md5(p.prosrc) = 'd479ef42f0e549ac8286a0e1b4587d26' and not has_function_privilege('anon', p.oid, 'execute')
               and has_function_privilege('authenticated', p.oid, 'execute')
          from pg_proc p where p.oid = 'public.staff_record_waiver(text[],text,text)'::regprocedure)
union all
select 'one staff_checkin', (select count(*) = 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'staff_checkin');
-- 2. Bookings on an approval ride from today on that were checked in while still a request (what the fast paths let
--    through before), per ride - for staff to look at; nothing here changes them:
select q.session_id, count(*) as checked_in_unapproved
  from public.queue_entries q join public.sessions s on s.id = q.session_id
 where coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') <> 'snd96' and coalesce(s.needs_approval, false)
   and coalesce(q.approval, 'pending') <> 'approved' and q.status in ('active', 'done')
   and coalesce(q.session_date, '') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
 group by q.session_id order by q.session_id;
