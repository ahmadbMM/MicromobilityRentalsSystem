-- ============================================================================
-- 20261111180300_session_notes_incidents
--
-- Staff website round s10 (2026-11-10), items 48 and 49 of the staff design review:
--
--   public.session_notes      A handover note per night: short notes staff write on a session ("lockers 4 and 9
--                             jammed; two helmets missing"), shown in Bookings' figures bar (Notes (N), a centred
--                             pop-up), on the Dashboard (today's latest) and as a bell line on the other desks.
--                             Staff read; staff who may change Bookings (_staff_mod('queue', true)) write; the
--                             author or an admin edits or deletes. The database stamps the author (auth.uid() and
--                             staff.display_name, else the sign-in email) and the time; an edit keeps them and
--                             stamps edited_at. Every change is broadcast on the private topic staff-ref (event
--                             session_notes), which realtime.messages already opens to is_staff() only
--                             (20260921160000), so the other desks see it without a read and without a new
--                             postgres_changes binding. In-app only: no email, no SMS.
--
--   public.booking_incidents  An incident on a booking: a fall, an injury, first aid given, the emergency contact
--                             called, bike damage or other, with a note and the time it happened (the page sends now
--                             unless staff change it; never in the future). The database stamps who recorded it and
--                             when, and copies the booking's session, account and rider name (a removed booking keeps
--                             its incidents readable). Staff read; staff who may change Bookings write; admins delete.
--                             No edits: an admin deletes and staff record again.
--
-- Both tables are staff-only under RLS (anon has no grant at all), so no customer read can carry them. Neither has a
-- foreign key: a session moves by insert and delete (staff_move_session), which would take the rows with it.
--
-- Safe before or after the app: until this is applied the Notes button and Record incident say "Waiting for the
-- database update", and nothing else reads the tables.
--
-- Rollback: drop table if exists public.session_notes; drop table if exists public.booking_incidents;
--           drop function if exists public._session_notes_stamp(); drop function if exists public._session_notes_broadcast();
--           drop function if exists public._booking_incidents_stamp();
-- Idempotent: safe to re-run. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. Handover notes ────────────────────────────────────────────────────────────────────────────
create table if not exists public.session_notes (
  id           bigint generated always as identity primary key,
  session_id   text not null check (length(session_id) between 1 and 80),
  body         text not null check (length(btrim(body)) between 1 and 500),
  author_id    uuid default auth.uid(),
  author_name  text check (author_name is null or length(author_name) <= 120),
  created_at   timestamptz not null default now(),
  edited_at    timestamptz
);
create index if not exists session_notes_session on public.session_notes (session_id, created_at);
comment on table public.session_notes is 'Staff handover notes per session (20261111180300); staff only, never shown to customers';

alter table public.session_notes enable row level security;

drop policy if exists "session notes staff read" on public.session_notes;
create policy "session notes staff read" on public.session_notes for select to authenticated
  using ((select public.is_staff()));
drop policy if exists "session notes queue insert" on public.session_notes;
create policy "session notes queue insert" on public.session_notes for insert to authenticated
  with check ((select public._staff_mod('queue', true)));
drop policy if exists "session notes own or admin update" on public.session_notes;
create policy "session notes own or admin update" on public.session_notes for update to authenticated
  using ((select public.is_staff()) and (author_id = (select auth.uid()) or (select public.is_admin())))
  with check ((select public.is_staff()) and (author_id = (select auth.uid()) or (select public.is_admin())));
drop policy if exists "session notes own or admin delete" on public.session_notes;
create policy "session notes own or admin delete" on public.session_notes for delete to authenticated
  using ((select public.is_staff()) and (author_id = (select auth.uid()) or (select public.is_admin())));

revoke all on public.session_notes from anon, authenticated;
grant select, insert, update, delete on public.session_notes to authenticated;

-- Who wrote it and when come from the session, whatever the page sent; an edit changes the words alone.
create or replace function public._session_notes_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if tg_op = 'UPDATE' then
    new.session_id := old.session_id;
    new.author_id := old.author_id;
    new.author_name := old.author_name;
    new.created_at := old.created_at;
    new.body := btrim(new.body);
    if new.body is distinct from old.body then new.edited_at := now(); else new.edited_at := old.edited_at; end if;
    return new;
  end if;
  new.created_at := now();
  new.edited_at := null;
  new.author_id := auth.uid();
  new.author_name := left(coalesce(
    (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()),
    auth.jwt() ->> 'email',
    'staff'), 120);
  new.body := btrim(new.body);
  return new;
end $function$;
revoke all on function public._session_notes_stamp() from public, anon, authenticated;
drop trigger if exists session_notes_stamp on public.session_notes;
create trigger session_notes_stamp before insert or update on public.session_notes
  for each row execute function public._session_notes_stamp();

-- The other desks hear of a note on staff-ref (the realtime.messages policy "staff hear staff-ref" opens the topic to
-- is_staff() only). A note is never refused because its broadcast failed.
create or replace function public._session_notes_broadcast()
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
    perform realtime.send(jsonb_build_object('op', tg_op, 'row', r, 'old', o), 'session_notes', 'staff-ref', true);
  exception when others then
    null;
  end;
  return null;
end $function$;
revoke all on function public._session_notes_broadcast() from public, anon, authenticated;
drop trigger if exists session_notes_broadcast on public.session_notes;
create trigger session_notes_broadcast after insert or update or delete on public.session_notes
  for each row execute function public._session_notes_broadcast();

-- ── 2. Incidents on a booking ────────────────────────────────────────────────────────────────────
create table if not exists public.booking_incidents (
  id           bigint generated always as identity primary key,
  booking_id   text not null check (length(booking_id) between 1 and 80),
  session_id   text,
  customer_id  text,
  rider_name   text check (rider_name is null or length(rider_name) <= 120),
  kind         text not null check (kind in ('fall', 'injury', 'first_aid', 'em_called', 'bike_damage', 'other')),
  note         text check (note is null or length(note) <= 1000),
  happened_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  author_id    uuid default auth.uid(),
  author_name  text check (author_name is null or length(author_name) <= 120)
);
create index if not exists booking_incidents_booking on public.booking_incidents (booking_id);
create index if not exists booking_incidents_session on public.booking_incidents (session_id);
create index if not exists booking_incidents_customer on public.booking_incidents (customer_id);
create index if not exists booking_incidents_happened on public.booking_incidents (happened_at desc);
comment on table public.booking_incidents is 'Incidents recorded on a booking by staff (20261111180300); staff only, never shown to customers';

alter table public.booking_incidents enable row level security;

drop policy if exists "booking incidents staff read" on public.booking_incidents;
create policy "booking incidents staff read" on public.booking_incidents for select to authenticated
  using ((select public.is_staff()));
drop policy if exists "booking incidents queue insert" on public.booking_incidents;
create policy "booking incidents queue insert" on public.booking_incidents for insert to authenticated
  with check ((select public._staff_mod('queue', true)));
drop policy if exists "booking incidents admin delete" on public.booking_incidents;
create policy "booking incidents admin delete" on public.booking_incidents for delete to authenticated
  using ((select public.is_admin()));

revoke all on public.booking_incidents from anon, authenticated;
grant select, insert, delete on public.booking_incidents to authenticated;

-- The booking's session, account and name, who recorded it and when, from the database; the time it happened is the
-- page's (now unless staff changed it), never in the future.
create or replace function public._booking_incidents_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare q record;
begin
  select e.session_id, e.customer_id, e.name into q from queue_entries e where e.id = new.booking_id;
  if not found then
    raise exception 'That booking is no longer there.' using errcode = 'P0001';
  end if;
  new.session_id := q.session_id;
  new.customer_id := q.customer_id;
  new.rider_name := left(q.name, 120);
  new.created_at := now();
  new.happened_at := coalesce(new.happened_at, now());
  if new.happened_at > now() + interval '10 minutes' then
    raise exception 'The time of an incident cannot be in the future.' using errcode = 'P0001';
  end if;
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  new.author_id := auth.uid();
  new.author_name := left(coalesce(
    (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()),
    auth.jwt() ->> 'email',
    'staff'), 120);
  return new;
end $function$;
revoke all on function public._booking_incidents_stamp() from public, anon, authenticated;
drop trigger if exists booking_incidents_stamp on public.booking_incidents;
create trigger booking_incidents_stamp before insert on public.booking_incidents
  for each row execute function public._booking_incidents_stamp();

-- ── Checks ───────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._session_notes_stamp()', 'public._session_notes_broadcast()', 'public._booking_incidents_stamp()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.session_notes'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.booking_incidents'::regclass) then
    raise exception 'row level security is off on a new table';
  end if;
  if has_table_privilege('anon', 'public.session_notes', 'select') or has_table_privilege('anon', 'public.booking_incidents', 'select') then
    raise exception 'anon can read a staff-only table';
  end if;
  foreach f in array array['public.is_staff()', 'public.is_admin()', 'public._staff_mod(text,boolean)'] loop
    if to_regprocedure(f) is null then raise exception '% is missing', f; end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111180300', 'session_notes_incidents')
on conflict (version) do nothing;

commit;
