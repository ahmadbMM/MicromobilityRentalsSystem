-- ============================================================================
-- 20261111180400_night_checklists
--
-- Staff round s10, second batch (2026-11-11), owner decision D10 ("do it all"): the night checklists.
--
--   public.session_checks  One row per item ticked on a night's list: the opening list ('open', "Open the night" in
--                          Bookings' More / Desk tools and the Dashboard's prompt) or the close-night list ('close',
--                          shown when staff press Close out, before the close-out runs). item_key is the item's key
--                          from staff_options 'night_checklists' (or the built-in list), or 'owe:<booking id>' for a
--                          rider staff knowingly leave owing at the close. Unticking deletes the row. The database
--                          stamps who ticked it (auth.uid() and staff.display_name, else the sign-in email) and when,
--                          whatever the page sent. One row per (session, list, item): a second desk ticking the same
--                          item meets the unique key (23505) and reads the night again.
--                          Staff read; staff who may change Bookings (_staff_mod('queue', true)) tick and untick;
--                          no updates; anon has no grant at all. Every change is broadcast on the private topic
--                          staff-ref (event session_checks), as session_notes does (20261111180300), so the other
--                          desks see a tick without a read and without a new postgres_changes binding.
--                          No foreign key: a session moves by insert and delete (staff_move_session).
--
--   _staff_opt_ok(key)     Re-created from 20261111180200 (section_checks, not on prod when this was written) with one
--                          more admin-only key: 'night_checklists' (the staff-ticked items of both lists, and the
--                          switch "The checklist must be complete before Close out"). Everything else is unchanged.
--
-- The switch is the page's to keep: Close out stays refused on the page while an item is open; staff_close_out is not
-- changed (the automatic items are read from what the desk holds: riders on a bike, owing, lockers, its outbox, the
-- drawer count).
--
-- Safe before or after the app: until this is applied the lists still show, the automatic items still work, and a
-- tick stays on the device that made it (the pop-up says "Waiting for the database update").
--
-- Rollback: drop table if exists public.session_checks; drop function if exists public._session_checks_stamp();
--           drop function if exists public._session_checks_broadcast(); re-run _staff_opt_ok from 20261111180200.
-- Idempotent: safe to re-run. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. The ticks ─────────────────────────────────────────────────────────────────────────────────
create table if not exists public.session_checks (
  id            bigint generated always as identity primary key,
  session_id    text not null check (length(session_id) between 1 and 80),
  list          text not null check (list in ('open', 'close')),
  item_key      text not null check (length(item_key) between 1 and 120),
  done_by       uuid default auth.uid(),
  done_by_name  text check (done_by_name is null or length(done_by_name) <= 120),
  done_at       timestamptz not null default now(),
  constraint session_checks_one unique (session_id, list, item_key)
);
comment on table public.session_checks is 'Night checklist ticks per session (20261111180400); staff only, never shown to customers';

alter table public.session_checks enable row level security;

drop policy if exists "session checks staff read" on public.session_checks;
create policy "session checks staff read" on public.session_checks for select to authenticated
  using ((select public.is_staff()));
drop policy if exists "session checks queue insert" on public.session_checks;
create policy "session checks queue insert" on public.session_checks for insert to authenticated
  with check ((select public._staff_mod('queue', true)));
drop policy if exists "session checks queue delete" on public.session_checks;
create policy "session checks queue delete" on public.session_checks for delete to authenticated
  using ((select public._staff_mod('queue', true)));

revoke all on public.session_checks from anon, authenticated;
grant select, insert, delete on public.session_checks to authenticated;

-- Who ticked it and when come from the session, whatever the page sent.
create or replace function public._session_checks_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  new.done_at := now();
  new.done_by := auth.uid();
  new.done_by_name := left(coalesce(
    (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()),
    auth.jwt() ->> 'email',
    'staff'), 120);
  return new;
end $function$;
revoke all on function public._session_checks_stamp() from public, anon, authenticated;
drop trigger if exists session_checks_stamp on public.session_checks;
create trigger session_checks_stamp before insert on public.session_checks
  for each row execute function public._session_checks_stamp();

-- The other desks hear of a tick on staff-ref (the realtime.messages policy "staff hear staff-ref" opens the topic to
-- is_staff() only). A tick is never refused because its broadcast failed.
create or replace function public._session_checks_broadcast()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r jsonb; o jsonb;
begin
  if tg_op = 'INSERT' then r := to_jsonb(new); end if;
  if tg_op = 'DELETE' then
    o := jsonb_build_object('id', old.id, 'session_id', old.session_id, 'list', old.list, 'item_key', old.item_key);
  end if;
  begin
    perform realtime.send(jsonb_build_object('op', tg_op, 'row', r, 'old', o), 'session_checks', 'staff-ref', true);
  exception when others then
    null;
  end;
  return null;
end $function$;
revoke all on function public._session_checks_broadcast() from public, anon, authenticated;
drop trigger if exists session_checks_broadcast on public.session_checks;
create trigger session_checks_broadcast after insert or delete on public.session_checks
  for each row execute function public._session_checks_broadcast();

-- ── 2. The lists' items and the switch: admins only ──────────────────────────────────────────────
create or replace function public._staff_opt_ok(p_key text)
 returns boolean
 language sql
 stable security definer
 set search_path = public
as $function$
  select case
    when p_key = 'biz' or p_key like 'biz.%' then is_admin()
    when p_key in ('dup_ok', 'acc_report_default', 'community.app_rules', 'community.wa_group', 'service_every', 'service_every_days', 'night_checklists') then is_admin()
    when p_key = 'session_templates' then _staff_mod('queue', true)
    when p_key in ('birthday_wishes', 'accounts_look_fine') then _staff_mod('community', true)
    when p_key in ('bike_brands', 'bike_groupsets', 'bike_wheels', 'bike_brakes', 'bike_frames', 'bike_locations') then _staff_mod('inventory', true) or _staff_mod('workshop', true)
    when p_key in ('inv_cats_eq', 'inv_cats_supp', 'inv_brands_eq', 'inv_brands_supp', 'protein_subtypes_own', 'inv_flavs_by_brand') then _staff_mod('inventory', true)
    else is_staff()  -- 'views' (checked per view by staff_options_views_guard) and any key not named here
  end
$function$;
revoke all on function public._staff_opt_ok(text) from public, anon;
grant execute on function public._staff_opt_ok(text) to authenticated;

-- ── Checks ───────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._session_checks_stamp()', 'public._session_checks_broadcast()', 'public._staff_opt_ok(text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.session_checks'::regclass) then
    raise exception 'row level security is off on session_checks';
  end if;
  if has_table_privilege('anon', 'public.session_checks', 'select') then
    raise exception 'anon can read session_checks';
  end if;
  if has_table_privilege('authenticated', 'public.session_checks', 'update') then
    raise exception 'session_checks takes updates; a tick is inserted or deleted';
  end if;
  foreach f in array array['public.is_staff()', 'public.is_admin()', 'public._staff_mod(text,boolean)'] loop
    if to_regprocedure(f) is null then raise exception '% is missing', f; end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111180400', 'night_checklists')
on conflict (version) do nothing;

commit;
