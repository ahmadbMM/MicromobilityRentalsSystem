-- ============================================================================
-- Visitors at the Blood Donation event (the owner, 2026-11-05: "ask people when registering if they are a visitor or
-- donor, make sure to differentiate between donors and visitors everywhere").
--
--  1. queue_entries.blood_role: 'donor' or 'visitor', as the person answered when registering. Null = booked before
--     the question was asked, which is a donor (the owner: those stay donors, with no pop-up).
--  2. customer_create_booking stores the answer, on this event alone.
--  3. _blood_entry_guard: a visitor gives everything a donor gives (18 or over, birth date, nationality, name, mobile,
--     email, the agreement to share) except the blood type (the owner's pick).
--  4. _blood_donated_apply: a visitor cannot be marked donated (BLOOD_VISITOR), so the free ride stays with donors.
--  5. staff_blood_role, volunteer_blood_role: staff and volunteers switch someone on the spot, refused once the
--     donation is marked (BLOOD_DONATED: take it back first). A volunteer's switch goes in volunteer_log, action 'role',
--     the new role in mark_at and the old one in prev_status. A rider cannot switch: customer_booking_update takes no
--     blood_role, and they tell the team, or cancel and register again.
--  6. volunteer_find, volunteer_list and staff_volunteer_find say 'visitor'; volunteer_enter's counts say 'visitors'.
--
-- Safe before the app: nothing reads the column yet, and a booking from a page without the question stores null, a
-- donor, under every rule it had. Touches no existing booking.
--
-- Rollback:
--   drop function if exists public.volunteer_blood_role(text, text, text, text, text),
--     public.staff_blood_role(text, text), public._blood_role_apply(text, text);
--   then run the patches below backwards, and restore volunteer_log_action_check without 'role';
--   alter table public.queue_entries drop column if exists blood_role;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if position(b in def) > 0 then return def; end if;
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


/* -- 1. the column ----------------------------------------------------------------------------- */
alter table public.queue_entries add column if not exists blood_role text
  check (blood_role in ('donor', 'visitor'));
comment on column public.queue_entries.blood_role is
  'Blood Donation event: donor or visitor, as answered when registering or as staff and volunteers switched it; null = booked before the question, a donor (20261105140000).';


/* -- 2, 3, 4, 6. each patched in place, so every attribute and later change stays ---------------- */
do $do$
declare v text;
begin
  select pg_get_functiondef('public.customer_create_booking'::regproc) into v;
  v := pg_temp._once(v,
    $a$waiver_at, waiver_version, ride_group, run_km,  -- Run for Her's distance (20261005230000)$a$,
    $b$waiver_at, waiver_version, ride_group, run_km,  -- Run for Her's distance (20261005230000)
      blood_role,                                     -- the Blood Donation event: donor or visitor (20261105140000)$b$);
  v := pg_temp._once(v,
    $a$case when it->>'run_km' in ('3','5') then (it->>'run_km')::smallint end,$a$,
    $b$case when it->>'run_km' in ('3','5') then (it->>'run_km')::smallint end,
      case when coalesce(s.ride_kind, '') = 'blood' and it->>'blood_role' in ('donor', 'visitor') then it->>'blood_role' end,$b$);
  execute v;

  select pg_get_functiondef('public._blood_entry_guard'::regproc) into v;
  execute pg_temp._once(v,
    $a$or nullif(btrim(coalesce(c.blood_type, '')), '') is null$a$,
    $b$or (coalesce(new.blood_role, '') <> 'visitor' and nullif(btrim(coalesce(c.blood_type, '')), '') is null)$b$);

  select pg_get_functiondef('public._blood_donated_apply'::regproc) into v;
  execute pg_temp._once(v,
    $a$-- Only someone who was checked in, on an account the code can belong to.$a$,
    $b$-- A visitor gave no blood: staff or a volunteer switch them to donor first (20261105140000).
  if (select x.blood_role from queue_entries x where x.id = q.id) = 'visitor' then
    raise exception 'BLOOD_VISITOR' using errcode = 'P0001';
  end if;

  -- Only someone who was checked in, on an account the code can belong to.$b$);

  select pg_get_functiondef('public.volunteer_find'::regproc) into v;
  execute pg_temp._once(v,
    $a$'donated', r.donated_at is not null,$a$,
    $b$'donated', r.donated_at is not null,
             'visitor', coalesce(r.blood_role, '') = 'visitor',$b$);

  select pg_get_functiondef('public.volunteer_list'::regproc) into v;
  execute pg_temp._once(v,
    $a$'donated', r.donated_at is not null,$a$,
    $b$'donated', r.donated_at is not null,
             'visitor', coalesce(r.blood_role, '') = 'visitor',$b$);

  select pg_get_functiondef('public.staff_volunteer_find'::regproc) into v;
  v := pg_temp._once(v,
    $a$'donated', r.donated_at is not null,$a$,
    $b$'donated', r.donated_at is not null,
             'visitor', coalesce(r.blood_role, '') = 'visitor',$b$);
  v := pg_temp._once(v,
    $a$select q.id, q.name, q.queue_num, q.status, q.donated_at$a$,
    $b$select q.id, q.name, q.queue_num, q.status, q.donated_at, q.blood_role$b$);
  execute v;

  select pg_get_functiondef('public.volunteer_enter'::regproc) into v;
  v := pg_temp._once(v,
    $a$count(*) filter (where q.donated_at is not null) donated$a$,
    $b$count(*) filter (where q.donated_at is not null) donated,
         count(*) filter (where q.status in ('waiting', 'waitlist', 'active', 'done') and q.blood_role = 'visitor') visitors$b$);
  v := pg_temp._once(v,
    $a$'donated', _n.donated)$a$,
    $b$'donated', _n.donated, 'visitors', _n.visitors)$b$);
  execute v;
end $do$;


/* -- 5. switching on the spot ------------------------------------------------------------------ */
-- The one place that changes it. Answers the role it replaced.
create or replace function public._blood_role_apply(p_entry_id text, p_role text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  q record;
begin
  if coalesce(p_role, '') not in ('donor', 'visitor') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'role';
  end if;
  select x.id, x.donated_at, x.blood_role, s.ride_kind into q
    from queue_entries x join sessions s on s.id = x.session_id
   where x.id = p_entry_id for update of x;
  if not found or coalesce(q.ride_kind, '') <> 'blood' then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001';
  end if;
  if p_role = 'visitor' and q.donated_at is not null then
    raise exception 'BLOOD_DONATED' using errcode = 'P0001';
  end if;
  update queue_entries set blood_role = p_role where id = q.id;
  return coalesce(q.blood_role, 'donor');
end $function$;
revoke all on function public._blood_role_apply(text, text) from public, anon, authenticated;

create or replace function public.staff_blood_role(p_entry_id text, p_role text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not (select is_staff()) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  perform _blood_role_apply(p_entry_id, p_role);
  return jsonb_build_object('ok', true, 'role', p_role);
end $function$;
revoke all on function public.staff_blood_role(text, text) from public, anon;
grant execute on function public.staff_blood_role(text, text) to authenticated;

alter table public.volunteer_log drop constraint if exists volunteer_log_action_check;
alter table public.volunteer_log add constraint volunteer_log_action_check
  check (action in ('enter', 'list', 'scan', 'search', 'checkin', 'uncheckin', 'donated', 'undonated', 'clock_in', 'clock_out', 'agree', 'interest', 'withdraw', 'role'));

create or replace function public.volunteer_blood_role(p_id text, p_token text, p_session text, p_entry_id text, p_role text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare q queue_entries%rowtype; _prev text;
begin
  perform _vol_gate(p_id, p_token, p_session, 'checkin');
  select * into q from queue_entries where id = p_entry_id and session_id = p_session for update;
  if not found then raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001'; end if;
  if q.customer_id is not distinct from p_id then raise exception 'VOL_OWN_BOOKING' using errcode = '42501'; end if;
  if q.status not in ('waiting', 'waitlist', 'active', 'done') then raise exception 'BAD_BOOKING_STATE' using errcode = 'P0001'; end if;
  _prev := _blood_role_apply(q.id, p_role);
  perform _vol_log(p_id, p_session, 'role', q.id, p_role, _prev);
  return jsonb_build_object('ok', true, 'role', p_role);
end $function$;
revoke all on function public.volunteer_blood_role(text, text, text, text, text) from public;
grant execute on function public.volunteer_blood_role(text, text, text, text, text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261105140000', 'blood_visitors')
on conflict (version) do nothing;

commit;
