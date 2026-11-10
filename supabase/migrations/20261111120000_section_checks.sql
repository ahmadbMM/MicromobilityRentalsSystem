-- ============================================================================
-- Section rights at the database (staff website round s10, item 42), 2026-11-11.
--
-- Before: _staff_mod passed every section for an account whose list was NULL ("everything its role allows" on the
-- page, but the page's role map never reached the database), and workshop_jobs, site_messages and the shared
-- staff_options rows (the team's saved views among them) were open to any staff account (is_staff()).
-- Read on prod 2026-11-10 (read-only): 6 active admins and 1 disabled admin with NULL lists (admins pass anyway);
-- the one active Front desk account had modules_view {queue,cashier} and modules_edit NULL, so it could change
-- every section the database checks (customers, community, vendors, volunteers, queue, cashier); of the 2 disabled
-- Front desk accounts one had both lists NULL; the disabled Owner had {cashier} / {}.
--
-- 1. _staff_role_mods(role): the page's ROLE_TABS (app.src.html) in the database's section ids. A section the page
--    derives goes in as its parent (Sessions, Lockers and the Waitlist with Bookings 'queue'; Badge requests with
--    People 'community'; the Store and Payments with Sales 'cashier'); People is both 'customers' and 'community',
--    Vendors both 'vendors' and 'fnb' (the ids the database's checks use). An unknown role reads as Front desk, as
--    on the page (ROLE_TABS[role]||DESK_TABS). When ROLE_TABS changes, change this map too.
-- 2. _staff_mod: a NULL view list is the role's map; a NULL edit list is the account's view list, or the role's map
--    when that is NULL too (the page's _editOk under _deskTabOk). Every id is read with its aliases, so a list the
--    Team page wrote with 'community' passes a 'customers' check (and 'vendors' an 'fnb' one), and a derived id asked
--    for ('sessions', 'store', ...) is its parent. Admins pass, the Owner never edits, disabled and Volunteer accounts
--    fail: unchanged. Explicit lists are read as before (an empty list still opens nothing).
-- 3. workshop_jobs: insert needs Workshop (change); update Workshop or Sales (change), because a void or refund in
--    the till takes the payment off the job it paid (_wsUnpay). Reading and the admin delete are unchanged.
-- 4. site_messages: read needs Messages or the website section (open), update the same (change). The admin delete
--    is unchanged.
-- 5. staff_options writes (insert, update, delete) go through _staff_opt_ok(key): biz / biz.* stay admin-only, and
--    the rows the page already writes only for an admin become admin-only here too (dup_ok, acc_report_default,
--    community.app_rules, community.wa_group, service_every, service_every_days); session_templates needs Bookings,
--    birthday_wishes and accounts_look_fine People, the bike lists Inventory or Workshop, the inventory lists
--    Inventory (all "change"). Any other key stays open to staff, as before. Reading is unchanged.
--    'views' (the team's shared saved views, one row) is checked per view by a trigger: every view added, changed or
--    removed needs "change" on its section (sessions -> queue, logs -> history, accounts -> community). A view of a
--    section the database does not know is left to is_staff(), so a new saved-views section keeps working.
--
-- Rebuilt from the live definitions read on prod 2026-11-10: _staff_mod (20261105090000) and the policies of
-- workshop_jobs (20260924160000), site_messages and staff_options (names as live).
-- Rollback: re-run _staff_mod from 20261105090000; recreate the six policies with is_staff() alone (staff_options:
-- is_staff() and (key not biz/biz.% or is_admin())); drop trigger staff_options_views_guard on staff_options; drop
-- function _staff_views_guard(), _staff_opt_ok(text), _staff_role_mods(text).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. A role's sections (the page's ROLE_TABS) ──────────────────────────────────────────────
create or replace function public._staff_role_mods(p_role text)
 returns text[]
 language sql
 immutable
 set search_path = public
as $function$
  select case coalesce(p_role, '')
    when 'admin' then array['queue','dashboard','cashier','inventory','workshop','customers','community','ambassadors','vendors','fnb','website','catalog','messages','analytics','history','team','volunteers']
    when 'manager' then array['dashboard','queue','cashier','inventory','workshop','customers','community','volunteers','messages','vendors','fnb','analytics','history']
    when 'leader' then array['queue']
    when 'mechanic' then array['inventory','workshop']
    when 'cashier' then array['cashier','inventory']
    when 'owner' then array['dashboard','queue','cashier','inventory','workshop','customers','community','volunteers','analytics','history','messages','vendors','fnb','website','team']
    when 'volunteer' then array[]::text[]
    else array['queue','cashier','workshop']  -- frontdesk (DESK_TABS), and an unknown role as on the page
  end
$function$;
revoke all on function public._staff_role_mods(text) from public, anon;
grant execute on function public._staff_role_mods(text) to authenticated;

-- ── 2. _staff_mod: a NULL list is the role's sections, ids read with their aliases ──────────
create or replace function public._staff_mod(p_mod text, p_edit boolean default false)
 returns boolean
 language sql
 stable security definer
 set search_path = public
as $function$
  select exists(
    select 1 from staff s
     where s.user_id = auth.uid() and s.disabled_at is null
       and s.role is distinct from 'volunteer'
       and not (p_edit and s.role = 'owner')  -- the Owner role only looks
       and (s.role = 'admin'
            or (case when p_mod in ('customers', 'community', 'badgereq') then array['customers', 'community']
                     when p_mod in ('vendors', 'fnb') then array['vendors', 'fnb']
                     when p_mod in ('sessions', 'lockers', 'waitlist') then array['queue']
                     when p_mod in ('store', 'payments') then array['cashier']
                     else array[p_mod] end)
               && (case when p_edit then coalesce(s.modules_edit, s.modules_view, _staff_role_mods(s.role))
                        else coalesce(s.modules_view, _staff_role_mods(s.role)) end)))
$function$;
revoke all on function public._staff_mod(text, boolean) from public, anon;
grant execute on function public._staff_mod(text, boolean) to authenticated;

-- ── 3. workshop_jobs: Workshop writes (and Sales takes a voided payment off its job) ─────────
drop policy if exists "workshop staff insert" on public.workshop_jobs;
create policy "workshop staff insert" on public.workshop_jobs for insert to authenticated
  with check ((select _staff_mod('workshop', true)));
drop policy if exists "workshop staff update" on public.workshop_jobs;
create policy "workshop staff update" on public.workshop_jobs for update to authenticated
  using ((select _staff_mod('workshop', true)) or (select _staff_mod('cashier', true)))
  with check ((select _staff_mod('workshop', true)) or (select _staff_mod('cashier', true)));

-- ── 4. site_messages: Messages (or the website section) reads and answers ───────────────────
drop policy if exists "site messages staff read" on public.site_messages;
create policy "site messages staff read" on public.site_messages for select to authenticated
  using ((select _staff_mod('messages')) or (select _staff_mod('website')));
drop policy if exists "site messages staff update" on public.site_messages;
create policy "site messages staff update" on public.site_messages for update to authenticated
  using ((select _staff_mod('messages', true)) or (select _staff_mod('website', true)))
  with check ((select _staff_mod('messages', true)) or (select _staff_mod('website', true)));

-- ── 5. staff_options: each shared row is written by the section that owns it ────────────────
create or replace function public._staff_opt_ok(p_key text)
 returns boolean
 language sql
 stable security definer
 set search_path = public
as $function$
  select case
    when p_key = 'biz' or p_key like 'biz.%' then is_admin()
    when p_key in ('dup_ok', 'acc_report_default', 'community.app_rules', 'community.wa_group', 'service_every', 'service_every_days') then is_admin()
    when p_key = 'session_templates' then _staff_mod('queue', true)
    when p_key in ('birthday_wishes', 'accounts_look_fine') then _staff_mod('community', true)
    when p_key in ('bike_brands', 'bike_groupsets', 'bike_wheels', 'bike_brakes', 'bike_frames', 'bike_locations') then _staff_mod('inventory', true) or _staff_mod('workshop', true)
    when p_key in ('inv_cats_eq', 'inv_cats_supp', 'inv_brands_eq', 'inv_brands_supp', 'protein_subtypes_own', 'inv_flavs_by_brand') then _staff_mod('inventory', true)
    else is_staff()  -- 'views' (checked per view by staff_options_views_guard) and any key not named here
  end
$function$;
revoke all on function public._staff_opt_ok(text) from public, anon;
grant execute on function public._staff_opt_ok(text) to authenticated;

drop policy if exists staff_options_ins on public.staff_options;
create policy staff_options_ins on public.staff_options for insert to authenticated
  with check ((select is_staff()) and _staff_opt_ok(key));
drop policy if exists staff_options_upd on public.staff_options;
create policy staff_options_upd on public.staff_options for update to authenticated
  using ((select is_staff()) and _staff_opt_ok(key))
  with check ((select is_staff()) and _staff_opt_ok(key));
drop policy if exists staff_options_del on public.staff_options;
create policy staff_options_del on public.staff_options for delete to authenticated
  using ((select is_staff()) and _staff_opt_ok(key));

-- The team's shared saved views: one row, every section's views in it ({id, sec, name, state, by, at}). A view added,
-- changed or removed needs "change" on its section. An insert that meets the row (the page's upsert) is compared with
-- the row as it stands, so the views of other sections it carries over unchanged are not asked about.
create or replace function public._staff_views_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  k text;
  o jsonb := '[]'::jsonb;
  n jsonb := '[]'::jsonb;
  sec text;
  mods constant text[] := array['queue','dashboard','cashier','inventory','workshop','customers','community','ambassadors','vendors','website','catalog','messages','analytics','history','team','volunteers'];
begin
  if tg_op = 'DELETE' then k := old.key; else k := new.key; end if;
  if k is distinct from 'views' or auth.uid() is null or is_admin() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'INSERT' then
    select coalesce(x.items, '[]'::jsonb) into o from staff_options x where x.key = 'views';
  elsif tg_op = 'UPDATE' or tg_op = 'DELETE' then
    o := old.items;
  end if;
  if tg_op <> 'DELETE' then n := new.items; end if;
  if jsonb_typeof(o) is distinct from 'array' then o := '[]'::jsonb; end if;
  if jsonb_typeof(n) is distinct from 'array' then n := '[]'::jsonb; end if;
  for sec in
    select distinct case d.v ->> 'sec' when 'sessions' then 'queue' when 'logs' then 'history'
                                       when 'accounts' then 'community' when 'people' then 'community'
                                       else d.v ->> 'sec' end
      from ((select v from jsonb_array_elements(n) v except select v from jsonb_array_elements(o) v)
            union
            (select v from jsonb_array_elements(o) v except select v from jsonb_array_elements(n) v)) d(v)
  loop
    if sec = any(mods) and not _staff_mod(sec, true) then
      raise exception 'SECTION' using errcode = '42501', detail = sec;
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $function$;
revoke all on function public._staff_views_guard() from public, anon;

drop trigger if exists staff_options_views_guard on public.staff_options;
create trigger staff_options_views_guard before insert or update or delete on public.staff_options
  for each row execute function public._staff_views_guard();

commit;
