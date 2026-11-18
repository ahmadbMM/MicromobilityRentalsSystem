-- ============================================================================
-- 20261118230000_session_crew
--
-- Tonight's crew (the user, 2026-11-18, picking it from the proposed Bookings features: "Tonight's crew. Who is
-- working tonight and in what role: desk, bikes, leader, sweeper or door. It's set in the opening checklist, shows
-- next to Notes, and fills in the part-timers' hours at close-out."):
--
--   public.session_crew         One row per person working a night, with their role (desk, bikes, leader, sweeper or
--                               door). One role a night per person: changing the role is an update, and the unique
--                               (session_id, staff_user_id) keeps anyone from being listed twice. The person is a staff
--                               account (staff.user_id). Part-timers are staff accounts too (part_timers.user_id is the
--                               account's user id, 20261007210000), so one column names both, and the close-out's
--                               part-timers' hours read a crew member as a part-timer by that id. No foreign key to
--                               staff or part_timers: a removed account's row still reads with its name, as part-timers'
--                               hours do. The database stamps the person's name (staff.display_name, else the
--                               part-timer's name, else the sign-in email's first part) and who added them and when
--                               (auth.uid() and staff.display_name, else the sign-in email); an update changes the role
--                               alone. Staff read; staff who may change Bookings (_staff_mod('queue', true)) add,
--                               change and remove; anon has no grant at all. Every change is broadcast on the private
--                               topic staff-ref (event session_crew), which realtime.messages already opens to
--                               is_staff() only (20260921160000), so the other desks see it without a read.
--   public.staff_crew_people()  The people a crew is picked from: active staff accounts that can open Bookings (and
--                               admins), and active part-timers, each once, with their name and whether they are a
--                               part-timer. Any staff account may call it (the page asks only for staff who may
--                               change Bookings); it returns names only, never an email.
--
-- The night's foreign key removes its crew with it (a session purged). A date move (staff_move_session inserts the new
-- session and deletes the old one) leaves the moved night with no crew: staff set it again.
--
-- Safe before or after the app: until this is applied the Crew chip and its pop-up say "Waiting for the database
-- update", the opening checklist's "Crew set" stays a tick staff make, and the close-out's hours are not pre-filled.
--
-- Rollback: drop table if exists public.session_crew; drop function if exists public._session_crew_stamp();
--           drop function if exists public._session_crew_broadcast(); drop function if exists public.staff_crew_people();
-- Idempotent: safe to re-run. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create table if not exists public.session_crew (
  id               uuid primary key default gen_random_uuid(),
  session_id       text not null references public.sessions (id) on delete cascade,
  staff_user_id    uuid not null,
  name             text check (name is null or length(name) <= 120),
  role             text not null check (role in ('desk', 'bikes', 'leader', 'sweeper', 'door')),
  created_by       uuid default auth.uid(),
  created_by_name  text check (created_by_name is null or length(created_by_name) <= 120),
  created_at       timestamptz not null default now(),
  constraint session_crew_one unique (session_id, staff_user_id)
);
create index if not exists session_crew_person on public.session_crew (staff_user_id);
comment on table public.session_crew is 'Who works a night and in what role (20261118230000); staff only, never shown to customers';

alter table public.session_crew enable row level security;

drop policy if exists "session crew staff read" on public.session_crew;
create policy "session crew staff read" on public.session_crew for select to authenticated
  using ((select public.is_staff()));
drop policy if exists "session crew queue insert" on public.session_crew;
create policy "session crew queue insert" on public.session_crew for insert to authenticated
  with check ((select public._staff_mod('queue', true)));
drop policy if exists "session crew queue update" on public.session_crew;
create policy "session crew queue update" on public.session_crew for update to authenticated
  using ((select public._staff_mod('queue', true)))
  with check ((select public._staff_mod('queue', true)));
drop policy if exists "session crew queue delete" on public.session_crew;
create policy "session crew queue delete" on public.session_crew for delete to authenticated
  using ((select public._staff_mod('queue', true)));

revoke all on public.session_crew from anon, authenticated;
grant select, insert, update, delete on public.session_crew to authenticated;

-- The person's name and who added them come from the database, whatever the page sent; an update changes the role alone.
-- Only a staff account (not a blood-drive volunteer) or an active part-timer can be on a crew.
create or replace function public._session_crew_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.session_id := old.session_id;
    new.staff_user_id := old.staff_user_id;
    new.name := old.name;
    new.created_by := old.created_by;
    new.created_by_name := old.created_by_name;
    new.created_at := old.created_at;
    return new;
  end if;
  if not exists (select 1 from staff s where s.user_id = new.staff_user_id and s.disabled_at is null
                   and s.role is distinct from 'volunteer')
     and not exists (select 1 from part_timers p where p.user_id = new.staff_user_id and p.active) then
    raise exception 'That person is not on the staff.' using errcode = 'P0001';
  end if;
  new.name := left(coalesce(
    (select nullif(btrim(s.display_name), '') from staff s where s.user_id = new.staff_user_id),
    (select nullif(btrim(p.name), '') from part_timers p where p.user_id = new.staff_user_id),
    (select nullif(split_part(u.email::text, '@', 1), '') from auth.users u where u.id = new.staff_user_id),
    'staff'), 120);
  new.created_at := now();
  new.created_by := auth.uid();
  new.created_by_name := left(coalesce(
    (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()),
    auth.jwt() ->> 'email',
    'staff'), 120);
  return new;
end $function$;
revoke all on function public._session_crew_stamp() from public, anon, authenticated;
drop trigger if exists session_crew_stamp on public.session_crew;
create trigger session_crew_stamp before insert or update on public.session_crew
  for each row execute function public._session_crew_stamp();

-- The other desks hear of a change on staff-ref. A change is never refused because its broadcast failed.
create or replace function public._session_crew_broadcast()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r jsonb; o jsonb;
begin
  if tg_op <> 'DELETE' then r := to_jsonb(new); end if;
  if tg_op <> 'INSERT' then o := jsonb_build_object('id', old.id, 'session_id', old.session_id); end if;
  begin
    perform realtime.send(jsonb_build_object('op', tg_op, 'row', r, 'old', o), 'session_crew', 'staff-ref', true);
  exception when others then
    null;
  end;
  return null;
end $function$;
revoke all on function public._session_crew_broadcast() from public, anon, authenticated;
drop trigger if exists session_crew_broadcast on public.session_crew;
create trigger session_crew_broadcast after insert or update or delete on public.session_crew
  for each row execute function public._session_crew_broadcast();

-- The people a crew is picked from: staff who can open Bookings (as _staff_mod reads it: an admin, or 'queue' in the
-- account's own list or its role's) and active part-timers, each once. Names only.
create or replace function public.staff_crew_people()
 returns table(user_id uuid, name text, part_timer boolean)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return query
    with ppl as (
      select s.user_id as uid from staff s
       where s.disabled_at is null and s.role is distinct from 'volunteer'
         and (s.role = 'admin' or 'queue' = any(coalesce(s.modules_view, _staff_role_mods(s.role))))
      union
      select p.user_id from part_timers p where p.active
    )
    select x.uid,
           left(coalesce(nullif(btrim(s.display_name), ''), nullif(btrim(p.name), ''),
                         nullif(split_part(u.email::text, '@', 1), ''), 'staff'), 120),
           coalesce(p.active, false)
      from ppl x
      left join staff s on s.user_id = x.uid
      left join part_timers p on p.user_id = x.uid
      left join auth.users u on u.id = x.uid
     order by 2;
end $function$;
revoke all on function public.staff_crew_people() from public, anon;
grant execute on function public.staff_crew_people() to authenticated;

-- ── Checks ───────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._session_crew_stamp()', 'public._session_crew_broadcast()', 'public.staff_crew_people()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.session_crew'::regclass) then
    raise exception 'row level security is off on session_crew';
  end if;
  if has_table_privilege('anon', 'public.session_crew', 'select') then
    raise exception 'anon can read session_crew';
  end if;
  if has_function_privilege('anon', 'public.staff_crew_people()', 'execute') then
    raise exception 'anon can call staff_crew_people';
  end if;
  foreach f in array array['public.is_staff()', 'public.is_admin()', 'public._staff_mod(text,boolean)', 'public._staff_role_mods(text)'] loop
    if to_regprocedure(f) is null then raise exception '% is missing', f; end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261118230000', 'session_crew')
on conflict (version) do nothing;

commit;

-- Check (read only): the table, its policies and triggers, the functions' attributes and grants, the ledger row.
select (select relrowsecurity from pg_class where oid = 'public.session_crew'::regclass) as rls,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'session_crew') as policies,
       (select count(*) from pg_trigger where tgrelid = 'public.session_crew'::regclass and not tgisinternal) as triggers,
       has_table_privilege('anon', 'public.session_crew', 'select') as anon_reads,
       (select json_agg(json_build_object('fn', p.proname, 'definer', p.prosecdef, 'settings', p.proconfig,
                                          'anon', has_function_privilege('anon', p.oid, 'execute')) order by p.proname)
          from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('_session_crew_stamp', '_session_crew_broadcast', 'staff_crew_people')) as fns,
       (select count(*) from public.session_crew) as rows,
       (select name from supabase_migrations.schema_migrations where version = '20261118230000') as ledger;
