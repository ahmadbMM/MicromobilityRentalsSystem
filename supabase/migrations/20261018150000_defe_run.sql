-- ============================================================================
-- DEFE 5KM Run (the owner, 2026-10-18): the Defe breast-cancer 5 km race at the Jeddah Corniche Circuit
-- on Thursday 22 October 2026 at 19:00 (kits collected at Jeddah Park on 21 October, 16:00-22:00), booked
-- by Community members inside MicroMobility Experiences. Free, one place per account, 5 km only. The
-- runner step shows the account's details filled in (name, email, birth date, emergency contact), asks
-- for what is missing and lets the runner change any of it. Once the place is booked the rider is asked
-- "Have you registered for the race?" (the race itself is entered on Defe’s registration page); No shows the link and the members’ code.
--
--  1. queue_entries.race_reg: the rider's answer, 'yes' or 'no' (null = not answered), and
--     race_reg_at when it was given. The booking stands whatever the answer.
--  2. customer_set_race_reg(p_id, p_token, p_entry_id, p_answer): a rider answers for their own live
--     booking on a Defe run (token-checked, definer). Staff write the column directly (RLS).
--  3. _defe_run_guard (BEFORE INSERT OR UPDATE OF status, session_id, run_km on queue_entries): on a
--     Defe run (ride_kind 'defe5k', event_kind 'community') every live row runs 5 km (run_km is set to
--     5, staff's too); a customer's live row needs a full name of two words or more, an email and the
--     emergency contact on the account (RUN_DETAILS) and no other live row of the same account on that
--     session (ONE_PER_SESSION). Its own trigger: Run for Her's guard is left exactly as it is.
--     The members gate needs nothing: the run is event_kind 'community' with open_to_all false.
--  4. The finisher's badge, defe_5k: earned by a finished (done) row on a Defe run (computed by the app
--     and the website, like Run for Her's), shown only to those who earned it; staff can give it too.
--
-- The session itself (2026-10-22-df) is a separate insert, run once the app that knows the kind is
-- live: an older page reads an unknown community kind as the Saturday ride.
--
-- Rollback:
--   drop trigger if exists queue_entries_defe_guard on public.queue_entries;
--   drop function if exists public._defe_run_guard(), public.customer_set_race_reg(text, text, text, text);
--   alter table public.queue_entries drop column if exists race_reg, drop column if exists race_reg_at;
--   delete from public.customer_badges where badge_id = 'bd_defe_5k'; delete from public.badges where id = 'bd_defe_5k';
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';


/* -- 1. the rider's answer ------------------------------------------------------------------- */
alter table public.queue_entries add column if not exists race_reg text;
alter table public.queue_entries add column if not exists race_reg_at text;
alter table public.queue_entries drop constraint if exists queue_entries_race_reg_chk;
alter table public.queue_entries add constraint queue_entries_race_reg_chk
  check (race_reg is null or race_reg in ('yes', 'no'));
comment on column public.queue_entries.race_reg is
  'DEFE 5KM Run: has the runner registered for the race through Defe, yes or no; null = not answered (20261018150000).';
comment on column public.queue_entries.race_reg_at is 'When race_reg was answered, ISO UTC (20261018150000).';


/* -- 2. a rider answers ---------------------------------------------------------------------- */
create or replace function public.customer_set_race_reg(p_id text, p_token text, p_entry_id text, p_answer text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_a text := lower(btrim(coalesce(p_answer, '')));
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if v_a not in ('yes', 'no') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'race_reg';
  end if;
  update queue_entries x
     set race_reg = v_a,
         race_reg_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    from sessions s
   where s.id = x.session_id
     and coalesce(s.ride_kind, '') = 'defe5k'
     and x.id = p_entry_id
     and x.customer_id = p_id
     and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow');
  return found;
end $function$;
revoke all on function public.customer_set_race_reg(text, text, text, text) from public;
grant execute on function public.customer_set_race_reg(text, text, text, text) to anon, authenticated;


/* -- 3. a runner's row on a Defe run ---------------------------------------------------------- */
create or replace function public._defe_run_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  s record;
  c record;
  _live int;
begin
  select x.ride_kind, x.event_kind into s from sessions x where x.id = new.session_id;
  if not found or coalesce(s.ride_kind, '') <> 'defe5k' then return new; end if;
  -- one distance: everyone on the run runs 5 km, whoever writes the row
  new.run_km := 5;
  if new.customer_id is null or (select is_staff()) then return new; end if;
  -- leaving the run, finishing it or being marked a no-show is never refused
  if coalesce(new.status, '') in ('cancelled', 'removed', 'noshow', 'done') then return new; end if;
  -- a live row that stays where it is is not judged again
  if tg_op = 'UPDATE' and old.session_id is not distinct from new.session_id
     and coalesce(old.status, '') not in ('cancelled', 'removed', 'noshow') then
    return new;
  end if;

  select x.name, x.email, x.emergency_name, x.emergency_phone, x.emergency_relation
    into c from customers x where x.id = new.customer_id;
  if not found
     or coalesce(array_length(array_remove(regexp_split_to_array(btrim(coalesce(c.name, '')), '\s+'), ''), 1), 0) < 2
     or nullif(btrim(coalesce(c.email, '')), '') is null
     or nullif(btrim(coalesce(c.emergency_name, '')), '') is null
     or nullif(btrim(coalesce(c.emergency_phone, '')), '') is null
     or nullif(btrim(coalesce(c.emergency_relation, '')), '') is null then
    raise exception 'Runner details are missing.' using errcode = 'P0001', detail = 'RUN_DETAILS';
  end if;

  -- one place per account: the same lock _solo_ride_cap takes, so two bookings sent at once take turns
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
revoke execute on function public._defe_run_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_defe_guard on public.queue_entries;
create trigger queue_entries_defe_guard
  before insert or update of status, session_id, run_km on public.queue_entries
  for each row execute function public._defe_run_guard();


/* -- 4. the finisher's badge ------------------------------------------------------------------- */
insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort)
values ('bd_defe_5k', 'defe_5k', 'defe', 'red', 'DEFE 5K', 'دفء 5 كم',
        'Finish the DEFE 5KM Run', 'أكمل سباق دفء 5 كم', true, true, 94)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true, retired = false,
  sort = excluded.sort;


/* -- checks ------------------------------------------------------------------------------------ */
do $chk$
declare f text;
begin
  foreach f in array array['customer_set_race_reg','_defe_run_guard'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if not has_function_privilege('anon', 'public.customer_set_race_reg(text,text,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.customer_set_race_reg(text,text,text,text)', 'execute') then
    raise exception 'a client grant is missing';
  end if;
  if has_function_privilege('anon', 'public._defe_run_guard()', 'execute')
     or has_function_privilege('authenticated', 'public._defe_run_guard()', 'execute') then
    raise exception '_defe_run_guard is executable by a client';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'queue_entries_defe_guard'
                   and tgrelid = 'public.queue_entries'::regclass and not tgisinternal) then
    raise exception 'queue_entries_defe_guard is missing';
  end if;
  if not exists (select 1 from public.badges where slug = 'defe_5k' and auto and system and not retired) then
    raise exception 'the defe_5k badge is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261018150000', 'defe_run')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
