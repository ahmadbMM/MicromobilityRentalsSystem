-- ============================================================================
-- Every waiver now covers everyone on a booking, and the Farm House Night has its own (the user, 2026-11-13: "update all
-- waivers especially the nawar farm house session").
--
-- The ride, swim and activity waivers gain the sentence a booking for other people needs: the one who books accepts the
-- waiver for each of them as well as for themselves, says they may, and is the parent or legal guardian of every child on
-- the booking (or has the guardian's permission) and supervises them. New versions: 2026-11-v4, swim-2026-11-v4,
-- activity-2026-11-v4. The Farm House Night's own waiver, farm-2026-11-v1: the farm and its animals, the food and drink
-- (allergies told before eating), damage by anyone on the booking, and the family a member brings.
--   1. _waiver_min names the new versions, so an older one is refused (WAIVER_OUTDATED) by customer_create_booking,
--      customer_accept_waiver and every form that asks _waiver_outdated, as each earlier bump did; and the farm kind.
--   2. _waiver_outdated knows the farm- prefix.
--   3. staff_record_waiver (the desk's signature) takes the farm waiver for a farm night's place, and only that.
--   4. _farm_waiver_guard: a farm night's place carries the farm waiver, never another kind's (an older page sent the
--      activity waiver for it); staff are exempt, a blank waiver is never refused (the forced pop-up asks for it).
--   5. Places already on a farm night with another kind's waiver are asked again: their waiver is cleared, so the
--      unskippable waiver pop-up asks for the farm night's own (none existed when this was written).
-- Run ONLY after the booking app (rentals) and the website (mm-platform: content/waivers.ts, the Petromin and Saturday
-- forms) that send the new versions are live: an older page's booking would be refused until it reloads.
-- Each function is restated from its LIVE definition (production, 2026-11-13) with the change; attributes kept.
-- Undo: re-run _waiver_min / _waiver_outdated from 20261018190000, staff_record_waiver from 20261114130000;
--       drop trigger queue_entries_farm_waiver on public.queue_entries; drop function public._farm_waiver_guard().
-- ============================================================================
begin;

-- ── 1. The versions in force ─────────────────────────────────────────────────
create or replace function public._waiver_min(p_kind text)
 returns text
 language sql
 stable
 set search_path to 'public'
as $function$
  select case p_kind
           when 'ride'     then '2026-11-v4'
           when 'swim'     then 'swim-2026-11-v4'
           when 'activity' then 'activity-2026-11-v4'
           when 'farm'     then 'farm-2026-11-v1'
         end
$function$;

-- ── 2. The farm- prefix is a kind of its own ─────────────────────────────────
create or replace function public._waiver_outdated(p_version text)
 returns boolean
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare v text[]; m text[]; k text;
begin
  v := regexp_match(coalesce(p_version, ''), '^(?:([a-z]+)-)?([0-9]{4})-([0-9]{2})-v([0-9]{1,6})$');
  if v is null then return false; end if;                  -- not a version this rule knows: never refused
  k := case coalesce(v[1], '') when '' then 'ride' when 'swim' then 'swim'
            when 'activity' then 'activity' when 'workshop' then 'activity'
            when 'farm' then 'farm' end;                     -- the Farm House Night (20261114160000)
  if k is null then return false; end if;                  -- a kind added later
  m := regexp_match(coalesce(_waiver_min(k), ''), '^(?:([a-z]+)-)?([0-9]{4})-([0-9]{2})-v([0-9]{1,6})$');
  if m is null then return false; end if;
  return (v[2]::int, v[3]::int, v[4]::int) < (m[2]::int, m[3]::int, m[4]::int);
end $function$;

-- ── 3. The desk's signature on a farm night's place is the farm waiver ───────
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
  if coalesce(p_version, '') !~ '^((swim|activity|blood|farm)-)?[0-9]{4}-[0-9]{2}-v[0-9]{1,6}$' then
    raise exception 'WAIVER_REQUIRED' using errcode = 'P0001';
  end if;
  if _waiver_outdated(p_version) then
    raise exception 'WAIVER_OUTDATED' using errcode = 'P0001';
  end if;
  v_pre := coalesce(substring(p_version from '^(swim|activity|blood|farm)-'), '');
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
                      when r.ride_kind = 'farm' then 'farm'
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

-- ── 4. A farm night's place carries the farm waiver ─────────────────────────
create or replace function public._farm_waiver_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if nullif(btrim(coalesce(new.waiver_version, '')), '') is null or (select is_staff()) then return new; end if;
  if tg_op = 'UPDATE' and new.waiver_version is not distinct from old.waiver_version
     and new.session_id is not distinct from old.session_id then
    return new;
  end if;
  if exists (select 1 from sessions s where s.id = new.session_id and s.event_kind = 'community' and s.ride_kind = 'farm')
     and new.waiver_version !~ '^farm-' then
    raise exception 'WAIVER_OUTDATED' using errcode = 'P0001';
  end if;
  return new;
end $function$;
revoke all on function public._farm_waiver_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_farm_waiver on public.queue_entries;
create trigger queue_entries_farm_waiver
  before insert or update of waiver_version, session_id on public.queue_entries
  for each row execute function public._farm_waiver_guard();

-- ── 5. Places already on a farm night with another kind's waiver are asked again ──
update public.queue_entries q
   set waiver_version = null, waiver_at = null
  from public.sessions s
 where s.id = q.session_id and s.event_kind = 'community' and s.ride_kind = 'farm'
   and coalesce(q.waiver_version, '') <> '' and q.waiver_version !~ '^farm-'
   and coalesce(q.status, '') in ('waiting', 'waitlist', 'active');

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114160000', 'waivers_for_everyone')
on conflict (version) do nothing;

commit;

-- Check (expect: the four minimums; the farm prefix known and an older ride version refused; the desk function and the
-- guard SECURITY DEFINER with search_path; the trigger; no farm place with another kind's waiver; the ledger row):
-- select _waiver_min('ride'), _waiver_min('swim'), _waiver_min('activity'), _waiver_min('farm');
-- select _waiver_outdated('2026-10-v3') as old_ride_refused, _waiver_outdated('2026-11-v4') as new_ride_refused,
--        _waiver_outdated('farm-2026-11-v1') as farm_refused, _waiver_outdated('farm-2026-10-v1') as old_farm_refused;
-- select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname in ('staff_record_waiver', '_farm_waiver_guard');
-- select tgname from pg_trigger where tgname = 'queue_entries_farm_waiver';
-- select count(*) from queue_entries q join sessions s on s.id = q.session_id
--  where s.ride_kind = 'farm' and coalesce(q.waiver_version, '') <> '' and q.waiver_version !~ '^farm-';
-- select version, name from supabase_migrations.schema_migrations where version = '20261114160000';
