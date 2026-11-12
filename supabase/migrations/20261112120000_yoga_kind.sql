-- ============================================================================
-- Yoga, a kind of session inside MicroMobility Experiences (the user, 2026-11-12: "create a session under
-- micromobility experiences, yoga for the community"; the first one is Hatha Yoga for Cyclists with
-- Jassim Alsaady, Saturday 21 November 2026, 4:00 to 5:30 PM, 15 places).
--
-- ride_kind 'yoga', event_kind 'community', session id suffix -yg. No bike, no breakfast, no gathering time:
-- a start and an end, like the pool. The server only needs to know the new kind where it names kinds:
--   1. promo_codes.ride_kind may name it (promo_codes_ride_kind_known), and _session_kind answers it, so a code
--      made for yoga applies to yoga (20261107111000).
--   2. _vol_sess_name gives a volunteer's certificate the session's name (20261109120000).
--   3. staff_record_waiver takes the activity waiver for it, as the app's _waiverKind gives it (20261029160000,
--      20261103180000): a desk-signed waiver on a yoga place was refused WAIVER_OUTDATED without this.
--   4. _yoga_entry_guard: one place per account on a yoga session (ONE_PER_SESSION), as on the runs. Staff are
--      exempt (the desk may seat anyone); leaving, finishing or a no-show is never refused.
-- Each function is restated from its LIVE definition (pg_get_functiondef on prod, 2026-11-12) with the one
-- change; SECURITY DEFINER and the search_path are kept.
--
-- Safe before the app: nothing reads 'yoga' until a session of that kind exists, and the session row is a
-- separate script (supabase/checks/yoga-session-2026-11-21.sql) run only after the app that knows yoga is live.
-- Undo: drop trigger queue_entries_yoga_guard on public.queue_entries; drop function public._yoga_entry_guard();
--       re-run the three functions and the constraint from 20261107111000, 20261110235400 (_vol_sess_name)
--       and 20261103180000 (staff_record_waiver).
-- ============================================================================
begin;

-- ── 1. Promo codes for the kind ────────────────────────────────────────────────
alter table public.promo_codes drop constraint if exists promo_codes_ride_kind_known;
alter table public.promo_codes add constraint promo_codes_ride_kind_known
  check (ride_kind is null or ride_kind in ('jcc','saturday','petromin','swim','workshop','snd96','event','runher','vlap','arena','defe5k','blood','yoga'));
comment on column public.promo_codes.ride_kind is 'Only for this kind of ride, as the app names kinds (jcc, saturday, petromin, swim, workshop, snd96, event, runher, vlap, arena, defe5k, blood, yoga). NULL = any. (20261107111000, 20261112120000)';

create or replace function public._session_kind(p_session text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case
           when s.ride_kind = 'snd96' then 'snd96'
           when coalesce(s.event_kind, '') <> 'community' then 'jcc'
           when s.ride_kind in ('event','petromin','swim','workshop','runher','vlap','arena','defe5k','blood','yoga') then s.ride_kind
           else 'saturday'
         end
    from sessions s where s.id = p_session
$function$;
revoke execute on function public._session_kind(text) from public, anon, authenticated;

-- ── 2. The session's name on a volunteer's certificate ───────────────────────
create or replace function public._vol_sess_name(p_session text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when s.ride_kind in ('saturday', 'petromin', 'swim', 'workshop', 'snd96', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'blood', 'yoga')
              then coalesce(nullif(btrim(s.title), ''),
                            case s.ride_kind when 'saturday' then 'Saturday Social Ride' when 'petromin' then 'Petromin night' /* the user's pick, 2026-11-10 (20261110235400) */
                              when 'swim' then 'Triathlon Pool Session' when 'workshop' then 'T100 Triathlon Prep'
                              when 'snd96' then 'Saudi National Day 96 Ride' when 'event' then 'Event' when 'runher' then 'Run for Her'
                              when 'vlap' then 'Victory Lap' when 'arena' then 'Arena Heros Hybrid Race' when 'defe5k' then 'DEFE 5KM Run'
                              when 'yoga' then 'Hatha Yoga for Cyclists' /* 20261112120000 */
                              else 'Micromobility Blood Donation' end)
              else 'Jeddah Corniche Circuit' end
    from sessions s where s.id = p_session
$function$;
revoke all on function public._vol_sess_name(text) from public, anon, authenticated;

-- ── 3. A desk-signed waiver on a yoga place is the activity waiver ───────────
create or replace function public.staff_record_waiver(p_entry_ids text[], p_version text, p_op text default null::text)
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
  if coalesce(p_version, '') !~ '^((swim|activity|blood)-)?[0-9]{4}-[0-9]{2}-v[0-9]{1,6}$' then
    raise exception 'WAIVER_REQUIRED' using errcode = 'P0001';
  end if;
  if _waiver_outdated(p_version) then
    raise exception 'WAIVER_OUTDATED' using errcode = 'P0001';
  end if;
  v_pre := coalesce(substring(p_version from '^(swim|activity|blood)-'), '');
  for r in select q.id, q.status, s.event_kind, s.ride_kind
             from queue_entries q left join sessions s on s.id = q.session_id
            where q.id = any(v_ids)
              for update of q loop
    v_n := v_n + 1;
    if r.status not in ('waiting', 'waitlist', 'active') then
      raise exception 'BAD_BOOKING_STATE: % is %', r.id, r.status;
    end if;
    v_kind := case when coalesce(r.event_kind, '') = 'community' and coalesce(r.ride_kind, '') <> 'snd96' then
                (case when r.ride_kind = 'swim' then 'swim' when r.ride_kind = 'blood' then 'blood'
                      when r.ride_kind in ('workshop', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'yoga') then 'activity'
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

-- ── 4. One place per account on a yoga session ──────────────────────────────
create or replace function public._yoga_entry_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  s record;
  _live int;
begin
  if new.customer_id is null or (select is_staff()) then return new; end if;
  select x.ride_kind, x.event_kind into s from sessions x where x.id = new.session_id;
  if not found or coalesce(s.ride_kind, '') <> 'yoga' or coalesce(s.event_kind, '') <> 'community' then
    return new;
  end if;
  -- leaving, finishing or being marked a no-show is never refused
  if coalesce(new.status, '') in ('cancelled', 'removed', 'noshow', 'done') then return new; end if;
  -- a live row that stays on its session is not judged again
  if tg_op = 'UPDATE' and old.session_id is not distinct from new.session_id
     and coalesce(old.status, '') not in ('cancelled', 'removed', 'noshow') then
    return new;
  end if;
  -- the same lock _solo_ride_cap and _run_entry_guard take, so two bookings sent at once take turns
  perform pg_advisory_xact_lock(hashtext('ridecap:' || coalesce(new.session_id, '') || ':' || new.customer_id));
  select count(*) into _live
    from queue_entries q
   where q.session_id = new.session_id
     and q.customer_id = new.customer_id
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
     and q.id <> new.id;
  if _live >= 1 then
    raise exception 'One place per person on this session.' using detail = 'ONE_PER_SESSION';
  end if;
  return new;
end $function$;
revoke all on function public._yoga_entry_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_yoga_guard on public.queue_entries;
create trigger queue_entries_yoga_guard
  before insert or update of status, session_id on public.queue_entries
  for each row execute function public._yoga_entry_guard();

insert into supabase_migrations.schema_migrations (version, name)
values ('20261112120000', 'yoga_kind')
on conflict (version) do nothing;

commit;

-- Check (expect: the constraint names yoga; _session_kind and _vol_sess_name and staff_record_waiver mention yoga;
-- the guard is SECURITY DEFINER with search_path; the trigger exists; the ledger row is there):
-- select pg_get_constraintdef(oid) like '%yoga%' as promo_ok from pg_constraint where conname = 'promo_codes_ride_kind_known';
-- select p.proname, p.prosecdef, p.proconfig, p.prosrc like '%''yoga''%' as names_yoga
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname in ('_session_kind', '_vol_sess_name', 'staff_record_waiver', '_yoga_entry_guard');
-- select tgname from pg_trigger where tgname = 'queue_entries_yoga_guard';
-- select version, name from supabase_migrations.schema_migrations where version = '20261112120000';
