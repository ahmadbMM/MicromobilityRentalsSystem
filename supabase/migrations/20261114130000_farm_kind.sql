-- ============================================================================
-- The Farm House Night, a kind of session inside MicroMobility Experiences (the user, 2026-11-13: "create a seesion
-- Nawar Farm House Night ... Date: 19/11/2026 Arrival: starts from 4:30 P.M. Dinner: 8:30 P.M. Approval-based
-- reservations same of Saturday Social Ride approval system ... put it under micromobility experiences card not to
-- public, every member can bring family members with them and add them to their bookings").
--
-- ride_kind 'farm', event_kind 'community', session id suffix -fh. No bike, no breakfast; it gathers: its _time is
-- "arrival - dinner", as the Saturday ride's is "gathering - start". Members only, free, needs_approval: staff pick
-- every place as on the Saturday ride. Unlike the Saturday ride, a member books themselves AND their family on one
-- booking, each by name. The server needs to know the kind where it names kinds, and where it caps places:
--   1. promo_codes.ride_kind may name it (promo_codes_ride_kind_known), and _session_kind answers it (20261107111000).
--   2. _vol_sess_name gives a volunteer's certificate the session's name (20261110235400).
--   3. staff_record_waiver takes the activity waiver for it, as the app's _waiverKind gives it (20261103180000).
--   4. _updates_key words its Updates lines as a session, never a ride (20261114080300).
--   5. _solo_ride_cap, one place per account on a ride staff approve, leaves it alone: a family books together.
--   6. _group_ride_cap caps it instead, at the event's seats per account (Settings > Business event_seat_max, five),
--      which is the app's EVENT_SEAT_MAX: the member and four of their family. Staff are exempt, as everywhere.
--   7. push_words names the kind in the ten languages (20261114000200), for the evening-before reminder.
-- Each function is restated from its LIVE definition (pg_get_functiondef on production, 2026-11-13) with the one
-- change; SECURITY DEFINER and the search_path are kept.
--
-- Safe before the app: nothing reads 'farm' until a session of that kind exists, and the session row is a separate
-- script (supabase/checks/farm-night-2026-11-19.sql) run only after the app that knows the kind is live.
-- Undo: re-run the functions and the constraint from 20261112120000 (promo list, _session_kind, _vol_sess_name,
--       staff_record_waiver), 20261114080300 (_updates_key) and 20261009160000 (the two caps), and
--       delete from push_words where key = 'kind:farm'.
-- ============================================================================
begin;

-- ── 1. Promo codes for the kind ────────────────────────────────────────────────
alter table public.promo_codes drop constraint if exists promo_codes_ride_kind_known;
alter table public.promo_codes add constraint promo_codes_ride_kind_known
  check (ride_kind is null or ride_kind in ('jcc','saturday','petromin','swim','workshop','snd96','event','runher','vlap','arena','defe5k','blood','yoga','farm'));
comment on column public.promo_codes.ride_kind is 'Only for this kind of ride, as the app names kinds (jcc, saturday, petromin, swim, workshop, snd96, event, runher, vlap, arena, defe5k, blood, yoga, farm). NULL = any. (20261107111000, 20261112120000, 20261114130000)';

create or replace function public._session_kind(p_session text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case
           when s.ride_kind = 'snd96' then 'snd96'
           when coalesce(s.event_kind, '') <> 'community' then 'jcc'
           when s.ride_kind in ('event','petromin','swim','workshop','runher','vlap','arena','defe5k','blood','yoga','farm') then s.ride_kind
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
  select case when s.ride_kind in ('saturday', 'petromin', 'swim', 'workshop', 'snd96', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'blood', 'yoga', 'farm')
              then coalesce(nullif(btrim(s.title), ''),
                            case s.ride_kind when 'saturday' then 'Saturday Social Ride' when 'petromin' then 'Petromin night' /* the user's pick, 2026-11-10 (20261110235400) */
                              when 'swim' then 'Triathlon Pool Session' when 'workshop' then 'T100 Triathlon Prep'
                              when 'snd96' then 'Saudi National Day 96 Ride' when 'event' then 'Event' when 'runher' then 'Run for Her'
                              when 'vlap' then 'Victory Lap' when 'arena' then 'Arena Heros Hybrid Race' when 'defe5k' then 'DEFE 5KM Run'
                              when 'yoga' then 'Hatha Yoga for Cyclists' /* 20261112120000 */
                              when 'farm' then 'Farm House Night' /* 20261114130000 */
                              else 'Micromobility Blood Donation' end)
              else 'Jeddah Corniche Circuit' end
    from sessions s where s.id = p_session
$function$;
revoke all on function public._vol_sess_name(text) from public, anon, authenticated;

-- ── 3. A desk-signed waiver on a farm night's place is the activity waiver ──
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
                      when r.ride_kind in ('workshop', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'yoga', 'farm') then 'activity'
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

-- ── 4. Its Updates lines say session, never ride ────────────────────────────
create or replace function public._updates_key(p_key text, p_session text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when _session_kind(p_session) in ('swim', 'workshop', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'blood', 'yoga', 'farm')
              then p_key || '_s' else p_key end;
$function$;

-- ── 5. One place per account on a ride staff approve: not on the farm night ─
create or replace function public._solo_ride_cap()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _live int;
begin
  if new.customer_id is null or (select is_staff()) then return new; end if;

  -- The Farm House Night is approved like the Saturday ride but takes a member's family on one booking:
  -- _group_ride_cap caps it instead (20261114130000).
  if not exists (select 1 from sessions s
                  where s.id = new.session_id
                    and s.event_kind = 'community'
                    and coalesce(s.needs_approval, false) = true
                    and coalesce(s.ride_kind, '') <> 'farm') then
    return new;
  end if;

  -- Two bookings sent at once by one account take turns (20261004100000).
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

-- ── 6. The farm night's family cap: the event's seats per account ───────────
create or replace function public._group_ride_cap()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _live int; _cap int; _jcc boolean;
begin
  if new.customer_id is null or (select is_staff()) then return new; end if;

  -- A community ride: five per booker on an event and on the Farm House Night (a member and their family,
  -- 20261114130000), two on the others (an approval ride is _solo_ride_cap's). Every other ride - the circuit,
  -- the National Day ride - three per account, the booking app's JCC_ACCOUNT_CAP (20261005210000).
  select case when coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') <> 'snd96'
              then case when coalesce(s.ride_kind, '') = 'farm' then _biz_int('event_seat_max', 5)
                        when coalesce(s.needs_approval, false) then null
                        when coalesce(s.ride_kind, '') = 'event' then _biz_int('event_seat_max', 5)
                        else _biz_int('group_ride_max', 2) end
              else _biz_int('jcc_account_cap', 3) end,  -- Settings > Business (20261009160000)
         not (coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') <> 'snd96')
    into _cap, _jcc
    from sessions s
   where s.id = new.session_id;
  if _cap is null then return new; end if;

  -- Two bookings sent at once by one account take turns (20261004100000).
  perform pg_advisory_xact_lock(hashtext('ridecap:' || coalesce(new.session_id, '') || ':' || new.customer_id));
  select count(*) into _live
    from queue_entries q
   where q.session_id = new.session_id
     and q.customer_id = new.customer_id
     and q.id <> new.id
     and case when _jcc then coalesce(q.status, '') in ('waiting', 'active', 'waitlist')   -- as the app counts
              else coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow') end;

  if _live >= _cap then
    raise exception 'Up to % riders per booking on this ride.', _cap using detail = 'GROUP_CAP';
  end if;

  return new;
end $function$;

-- ── 7. The kind's name for the evening-before reminder ──────────────────────
insert into public.push_words (key, lang, title, body) values
  ('kind:farm', 'en', 'Farm House Night', ''),     ('kind:farm', 'ar', 'ليلة المزرعة', ''),
  ('kind:farm', 'fr', 'Soirée à la ferme', ''),    ('kind:farm', 'es', 'Noche en la granja', ''),
  ('kind:farm', 'pt', 'Noite na fazenda', ''),     ('kind:farm', 'ur', 'فارم ہاؤس نائٹ', ''),
  ('kind:farm', 'hi', 'फ़ार्म हाउस नाइट', ''),       ('kind:farm', 'tl', 'Farm House Night', ''),
  ('kind:farm', 'ne', 'फार्म हाउस नाइट', ''),       ('kind:farm', 'bn', 'ফার্ম হাউস নাইট', '')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114130000', 'farm_kind')
on conflict (version) do nothing;

commit;

-- Check (expect: the constraint names farm; the five functions name it, each SECURITY DEFINER with its search_path;
-- ten push words; the ledger row named farm_kind):
-- select pg_get_constraintdef(oid) like '%farm%' as promo_ok from pg_constraint where conname = 'promo_codes_ride_kind_known';
-- select p.proname, p.prosecdef, p.proconfig, p.prosrc like '%''farm''%' as names_farm
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname in ('_session_kind', '_vol_sess_name', 'staff_record_waiver', '_updates_key', '_solo_ride_cap', '_group_ride_cap');
-- select count(*) from public.push_words where key = 'kind:farm';
-- select version, name from supabase_migrations.schema_migrations where version = '20261114130000';
