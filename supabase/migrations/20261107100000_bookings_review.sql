-- ============================================================================
-- 20261107100000 - Bookings, from the 2026-11-06 staff review (BK01, BK08, BK09).
-- Not during a ride night (about 18:00-23:00 Riyadh). The page works before and after it.
--
-- BK01  staff_checkin and staff_return take p_at (text, ISO time, default null): when the check-in or the return
--       happened on the desk. The desk outbox sends the time a change was made while the booth was offline, so a
--       check-in made at 21:00 and sent at 21:40 is saved at 21:00 (it was saved at 21:40, and a check-in and a
--       return sent together gave rides of about 0 minutes). The time is clamped by _desk_at: never after now(),
--       never more than 12 hours ago, never before the booking's ride day (00:00 Riyadh), and a return never
--       before its check-in. No p_at (an online call, an older page) is now(), as before.
--       The parameter list grows by one, so each old signature is dropped after the new one is made (two
--       candidates for one named call would be ambiguous to PostgREST). An older page calls with its named
--       arguments and gets p_at null. This page against a database without p_at gets PGRST202 / 42883 and asks
--       again without it (_rpcOp).
-- BK09  queue_entries.checked_in_by / checked_out_by (text, <= 60): the staff member's display name (staff.display_name)
--       stamped by staff_checkin / staff_return. A guard trigger keeps riders from writing them; staff writes
--       (an Undo that clears them) pass.
-- BK08  Presence on the private topic staff-desk: who has a rider open, shared between staff phones on the realtime
--       socket the desk already holds. Two policies on realtime.messages open the topic to is_staff() only (read:
--       presence and broadcast; write: presence). Nothing is stored in a table.
--
-- Function bodies: staff_checkin is 20261029160000's definition (the live one since that migration) with p_at,
-- v_by and the two stamped columns added (marked 20261107100000). staff_return is 20261009170000's definition with
-- 20261009215000's op id block (the live one since then; no later migration touches it) and the same additions.
-- SECURITY DEFINER and search_path restated on both. Grants as they were: authenticated (and service_role for
-- staff_checkin), nothing for anon/public.
--
-- Rollback:
--   re-run 20261029160000 section 1 (staff_checkin, 9 arguments) and the staff_return of 20261009170000 patched by
--   20261009215000, then drop the 10- and 5-argument signatures; drop function public._desk_at(text,text,text);
--   drop trigger queue_entries_desk_by_guard on public.queue_entries; drop function public._desk_by_guard();
--   alter table public.queue_entries drop column checked_in_by, drop column checked_out_by;
--   drop policy "staff see staff-desk" on realtime.messages; drop policy "staff track staff-desk" on realtime.messages.
-- Idempotent. Then run supabase/checks/security-attributes.sql: it must print nothing.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── BK09: who checked the rider in, who took the bike back ─────────────────────────────────────
alter table public.queue_entries add column if not exists checked_in_by text;
alter table public.queue_entries add column if not exists checked_out_by text;
alter table public.queue_entries drop constraint if exists queue_entries_checked_in_by_len;
alter table public.queue_entries add constraint queue_entries_checked_in_by_len check (checked_in_by is null or char_length(checked_in_by) <= 60) not valid;
alter table public.queue_entries drop constraint if exists queue_entries_checked_out_by_len;
alter table public.queue_entries add constraint queue_entries_checked_out_by_len check (checked_out_by is null or char_length(checked_out_by) <= 60) not valid;
comment on column public.queue_entries.checked_in_by is 'The staff member who checked the rider in (staff.display_name, stamped by staff_checkin; 20261107100000).';
comment on column public.queue_entries.checked_out_by is 'The staff member who took the bike back (staff.display_name, stamped by staff_return; 20261107100000).';

create or replace function public._desk_by_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if current_user in ('anon', 'authenticated') and not coalesce((select is_staff()), false) then
    new.checked_in_by := case when tg_op = 'UPDATE' then old.checked_in_by else null end;
    new.checked_out_by := case when tg_op = 'UPDATE' then old.checked_out_by else null end;
  end if;
  return new;
end $function$;
revoke execute on function public._desk_by_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_desk_by_guard on public.queue_entries;
create trigger queue_entries_desk_by_guard
  before insert or update of checked_in_by, checked_out_by on public.queue_entries
  for each row execute function public._desk_by_guard();

-- ── BK01: the desk's time, clamped ─────────────────────────────────────────────────────────────
-- p_at: the device's ISO time (null/blank/unreadable = now). p_day: the booking's session_date (YYYY-MM-DD).
-- p_after: an ISO time the answer may not precede (a return's check-in). Answers _iso_now()'s format.
create or replace function public._desk_at(p_at text, p_day text default null, p_after text default null)
 returns text
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare v timestamptz; v_floor timestamptz := now() - interval '12 hours'; v_x timestamptz;
begin
  if p_at is null or btrim(p_at) = '' then return public._iso_now(); end if;
  begin v := p_at::timestamptz; exception when others then return public._iso_now(); end;
  if p_day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    begin v_floor := greatest(v_floor, (p_day::date)::timestamp at time zone 'Asia/Riyadh'); exception when others then null; end;
  end if;
  if p_after is not null and btrim(p_after) <> '' then
    begin v_x := p_after::timestamptz; v_floor := greatest(v_floor, v_x); exception when others then null; end;
  end if;
  v := least(now(), greatest(v, v_floor));
  return to_char(v at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
end $function$;
revoke execute on function public._desk_at(text, text, text) from public, anon, authenticated;

-- ── staff_checkin: p_at, checked_in_by ─────────────────────────────────────────────────────────
create or replace function public.staff_checkin(p_booking_id text, p_bike_id text default null,
    p_paid boolean default null, p_price numeric default null, p_pay_method text default null,
    p_card_amount numeric default null, p_type text default null, p_ride_group text default null,
    p_op_id uuid default null, p_at text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid(); v_claimed int; v_prior jsonb; v_res jsonb; q public.queue_entries%rowtype; b public.bikes%rowtype; a_id uuid; first_a uuid; holder text;
        got text[] := '{}'; rsv text[]; bid text; dropped boolean := false; st text; new_bike text;
        v_by text := (select left(nullif(btrim(s.display_name), ''), 60) from public.staff s where s.user_id = auth.uid());   /* (20261107100000) */
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
drop function if exists public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid);
revoke all on function public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid,text) from public, anon;
grant execute on function public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid,text) to authenticated, service_role;

-- ── staff_return: p_at, checked_out_by ─────────────────────────────────────────────────────────
create or replace function public.staff_return(p_booking_id text, p_return_condition text default 'ok'::text,
    p_notes text default null::text, p_op_id uuid default null::uuid, p_at text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_uid uuid := auth.uid(); v_claimed int; v_prior jsonb; v_res jsonb; q public.queue_entries%rowtype; bid text; n int := 0; v_status text; v_held boolean := false;
        v_out text; v_by text := (select left(nullif(btrim(s.display_name), ''), 60) from public.staff s where s.user_id = auth.uid());   /* (20261107100000) */
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  /* the desk outbox's op id (20261009215000), as staff_checkin */
  if p_op_id is not null and v_uid is not null then
    insert into rpc_receipts (user_id, op_id, fn) values (v_uid, p_op_id, 'staff_return')
      on conflict do nothing returning 1 into v_claimed;
    if v_claimed is null then
      select result into v_prior from rpc_receipts where user_id = v_uid and op_id = p_op_id;
      return coalesce(v_prior, jsonb_build_object('ok', true, 'noop', true)) || jsonb_build_object('replayed', true);
    end if;
    if random() < 0.02 then delete from rpc_receipts where created_at < now() - interval '7 days'; end if;
  end if;
  if p_return_condition not in ('ok','needs_check','damaged') then
    raise exception 'BAD_CONDITION: % (ok | needs_check | damaged)', p_return_condition;
  end if;

  select * into q from public.queue_entries where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND: no booking %', p_booking_id; end if;
  if q.status = 'done' and not exists (select 1 from public.bike_assignments where booking_id = q.id and returned_at is null) then
    return jsonb_build_object('ok', true, 'noop', true);
  end if;
  if q.status <> 'active' then
    raise exception 'BAD_BOOKING_STATE: #% is %, not on a bike', coalesce(q.queue_num::text, q.id), q.status;
  end if;
  v_out := public._desk_at(p_at, q.session_date, q.checked_in_at);   /* the desk's time, clamped (20261107100000) */

  -- Damaged: maintenance. Needs a check (or every return, when the business says so): 'check',
  -- which nobody can hand out until staff clear it. Otherwise back in the pool.
  v_status := case
    when p_return_condition = 'damaged' then 'maintenance'
    when p_return_condition = 'needs_check' or public._return_check_all() then 'check'
    else 'available' end;

  -- The bikes to free: every open assignment, plus the legacy pointer for a ride that
  -- went out before assignments existed and was not caught by the backfill.
  for bid in
    select distinct x.bike_id from (
      select bike_id from public.bike_assignments where booking_id = q.id and returned_at is null
      union
      select q.assigned_bike_id where q.assigned_bike_id is not null and q.assigned_bike_id not like '[%'
      union
      select arr from jsonb_array_elements_text(case when q.assigned_bike_id like '[%' then q.assigned_bike_id::jsonb else '[]'::jsonb end) as arr
    ) x order by 1
  loop
    perform 1 from public.bikes where id = bid for update;
    update public.bikes
       set status = v_status,
           -- the day in Jeddah, not the server's UTC day (a return before 03:00 is still today)
           retired_date = case when v_status = 'maintenance'
                               then to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD') else retired_date end
     where id = bid;
    n := n + 1;
    if v_status = 'check' then v_held := true; end if;
  end loop;

  update public.bike_assignments
     set returned_at = v_out::timestamptz, returned_by = auth.uid(), return_condition = p_return_condition, return_notes = p_notes
   where booking_id = q.id and returned_at is null;
  update public.queue_entries set status = 'done', checked_out_at = v_out, checked_out_by = v_by where id = q.id;
  v_res := jsonb_build_object('ok', true, 'noop', false, 'bikes_freed', n, 'held', v_held, 'bike_status', v_status);
  if v_claimed is not null then update rpc_receipts set result = v_res where user_id = v_uid and op_id = p_op_id; end if;
  return v_res;
end $function$;
drop function if exists public.staff_return(text,text,text,uuid);
revoke all on function public.staff_return(text,text,text,uuid,text) from public, anon;
grant execute on function public.staff_return(text,text,text,uuid,text) to authenticated;

-- ── BK08: presence on the private topic staff-desk, staff only ─────────────────────────────────
drop policy if exists "staff see staff-desk" on realtime.messages;
create policy "staff see staff-desk" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('presence', 'broadcast')
    and (select realtime.topic()) = 'staff-desk'
    and (select public.is_staff())
  );
drop policy if exists "staff track staff-desk" on realtime.messages;
create policy "staff track staff-desk" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and (select realtime.topic()) = 'staff-desk'
    and (select public.is_staff())
  );

-- ── Checks ─────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f regprocedure;
begin
  foreach f in array array['public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid,text)'::regprocedure,
                           'public.staff_return(text,text,text,uuid,text)'::regprocedure] loop
    if not exists (select 1 from pg_proc p where p.oid = f and p.prosecdef and 'search_path=public' = any(coalesce(p.proconfig, '{}'))) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception '% is not executable by the staff page', f; end if;
  end loop;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('staff_checkin', 'staff_return')) <> 2 then
    raise exception 'staff_checkin / staff_return have more than one signature (PostgREST could not choose)';
  end if;
  if position('(20261029160000)' in (select prosrc from pg_proc where oid = 'public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid,text)'::regprocedure)) = 0 then
    raise exception 'staff_checkin lost the NOT_APPROVED block';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'queue_entries'
       and column_name in ('checked_in_by', 'checked_out_by')) <> 2 then
    raise exception 'checked_in_by / checked_out_by missing';
  end if;
  if public._desk_at('2000-01-01T00:00:00Z') < to_char((now() - interval '12 hours 1 minute') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     or public._desk_at('2999-01-01T00:00:00Z') > public._iso_now() then
    raise exception '_desk_at does not clamp';
  end if;
end $chk$;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261107100000', 'bookings_review')
on conflict (version) do nothing;

commit;

-- ── Check (read-only), after the commit ───────────────────────────────────────────────────────
-- Every line ok = true.
select 'staff_checkin takes p_at, definer, staff only' as what,
       (select p.prosecdef and position('_desk_at' in p.prosrc) > 0 and position('checked_in_by' in p.prosrc) > 0
               and not has_function_privilege('anon', p.oid, 'execute')
          from pg_proc p where p.oid = 'public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid,text)'::regprocedure) as ok
union all
select 'staff_return takes p_at, definer, staff only',
       (select p.prosecdef and position('_desk_at' in p.prosrc) > 0 and position('checked_out_by' in p.prosrc) > 0
               and not has_function_privilege('anon', p.oid, 'execute')
          from pg_proc p where p.oid = 'public.staff_return(text,text,text,uuid,text)'::regprocedure)
union all
select 'one staff_checkin, one staff_return',
       (select count(*) = 2 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('staff_checkin', 'staff_return'))
union all
select 'staff-desk presence policies', (select count(*) = 2 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
                                         and policyname in ('staff see staff-desk', 'staff track staff-desk'));
-- Check-ins and returns stamped since, with who (most recent first):
-- select id, checked_in_at, checked_in_by, checked_out_at, checked_out_by from public.queue_entries
--  where checked_in_by is not null or checked_out_by is not null order by coalesce(checked_out_at, checked_in_at) desc limit 20;
