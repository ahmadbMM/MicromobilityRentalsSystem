-- ============================================================================
-- The Door role (staff round s10, D11; the owner, 2026-11-11: "do it all"), 2026-11-11.
--
-- A staff account whose only job is checking riders in at the entrance (helpers at runs, blood drives, the Corniche
-- gate). It IS staff (is_staff() is true): it reads the day's bookings and the live channel as the desk does, and checks
-- riders in through the desk's own staff_checkin (and staff_bulk_checkin, which runs it per rider). It changes nothing
-- else. The page signs it into one locked scan screen (staff-parts/door.js).
-- The Volunteer role is unchanged and different: blood donation only, is_staff() false, its own staff_volunteer_*
-- functions, one donor at a time from a ticket or a whole number, never the list, and it ends with its session.
--
-- Read on prod 2026-11-11 (read-only): staff.role has no CHECK constraint; the role list lives in staff_invite and
-- staff_set_access; _staff_cap (20261110235100) defaults can_refund and can_see_costs to true; queue_entries, customers,
-- sessions, lockers, locker_items and cashier_sales take any staff write (is_staff()); staff_options any staff write but
-- the biz keys; wallet_ledger and locker_rentals are written by functions only.
--
-- 1. staff_invite and staff_set_access take 'door' (rebuilt from the live definitions). A Door account's section lists
--    are the database's own, as a volunteer's are, whatever the page sends: modules_view {queue}, modules_edit {}. So
--    _staff_mod gives it Bookings to read and no section to change.
-- 2. _staff_role_mods (from 20261111180200): 'door' -> {queue}. Before this an unknown role read as Front desk.
-- 3. _staff_cap: a Door account has no capability (no refund, no costs), ticked or not.
-- 4. _staff_is_door(): the caller is an active Door account.
-- 5. The guards, triggers named a_door_guard so each runs before every other BEFORE trigger of its table and sees the
--    statement's own change. They act only on a write the Door account itself made (pg_trigger_depth() = 1): what other
--    triggers do in the wake of its check-in (the session's fill, the lockers' line, the wallet's follow) goes on as for
--    anyone, and every other account is untouched.
--    - queue_entries (_door_queue_guard): the one change a Door account may make is a check-in: 'waiting' -> 'active'
--      with only the arrival (status, checked_in_at, checked_in_by), the bike the booking held (assigned_bike_id) and the
--      Saturday ride's group (ride_group) changing, of a rider who has paid or owes nothing (paid; a free ride: community,
--      not snd96, not paid_ride; their own bike, a price of 0 or a wallet that covered the price, with no add-ons).
--      An unpaid rider raises DOOR_UNPAID; any other insert, update or delete DOOR_ONLY_CHECKIN (42501 both). So a check-in
--      that takes a payment, mark paid, edits, no-show, the waitlist (onto it, off it, or checked in from it), cancel,
--      return, the wallet paying a booking and the close-out are refused to it, whichever way they come.
--    - cashier_sales, wallet_ledger, locker_rentals, lockers, locker_items, staff_options, customers and sessions
--      (_door_write_guard): no write of its own at all (DOOR_ONLY_CHECKIN): the till, the wallet, the lockers, the shared
--      lists, accounts and sessions. NOT bikes or bike_assignments: staff_checkin claims the booking's reserved bike itself.
--    Reading is unchanged. Messages (site_messages) need Messages "change" since 20261111180200, and the message templates
--    (site_content) are admins' only.
--
-- Rollback: move any Door account to another role first; re-run staff_invite, staff_set_access and _staff_cap from their
--   live definitions (_staff_cap: 20261110235100) and _staff_role_mods from 20261111180200; drop trigger a_door_guard on
--   the nine tables; drop function _door_queue_guard(), _door_write_guard(), _staff_is_door().
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. The role in the two ways an account gets one ──────────────────────────────────────────
create or replace function public.staff_invite(p_email text, p_name text, p_role text, p_password text)
 returns jsonb
 language plpgsql
 security definer
 set search_path = public, extensions, auth
as $function$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_uid uuid := gen_random_uuid();
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if v_email !~ '^[^\s@<>"''()]+@[^\s@<>"''()]+\.[^\s@<>"''()]+$' or length(v_email) > 120 then
    raise exception 'BAD_EMAIL' using errcode = '22023';
  end if;
  if v_name !~ '^[[:alpha:] ]{2,40}$' then raise exception 'BAD_NAME' using errcode = '22023'; end if;
  if p_role is null or p_role not in ('admin', 'manager', 'frontdesk', 'leader', 'mechanic', 'cashier', 'owner', 'volunteer', 'door') then
    raise exception 'ROLE' using errcode = '22023';
  end if;
  if p_role = 'volunteer' and _volunteer_next() is null then raise exception 'NO_VOLUNTEER_SESSION' using errcode = 'P0001'; end if;
  if length(coalesce(p_password, '')) < 8 or p_password !~ '[A-Z]' or p_password !~ '[0-9]' then
    raise exception 'BAD_PASSWORD' using errcode = '22023';
  end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'EMAIL_TAKEN' using errcode = '23505';
  end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change,
                          email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', v_email,
          crypt(p_password, gen_salt('bf')), now(),
          jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
          jsonb_build_object('op_name', v_name), now(), now(), '', '', '', '', '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_uid, v_uid::text,
          jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
          'email', null, now(), now());
  -- a Door account reads Bookings and changes no section (20261111180500)
  insert into staff (user_id, role, must_change_pwd, display_name, volunteer_session, modules_view, modules_edit)
    values (v_uid, p_role, true, v_name, case when p_role = 'volunteer' then _volunteer_next() end,
            case when p_role = 'door' then array['queue']::text[] end,
            case when p_role = 'door' then '{}'::text[] end);
  return jsonb_build_object('ok', true, 'user_id', v_uid);
end $function$;
revoke all on function public.staff_invite(text, text, text, text) from public, anon;
grant execute on function public.staff_invite(text, text, text, text) to authenticated;

create or replace function public.staff_set_access(p_user uuid, p_role text, p_view text[], p_edit text[])
 returns boolean
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  allowed text[] := array['queue','dashboard','cashier','inventory','workshop','customers','community','ambassadors','vendors','website','catalog','messages','analytics','history','team','volunteers'];  -- vendors: the section since 2026-10-03 (20261007120100)
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'NOT_YOURSELF' using errcode = '42501'; end if;
  if p_role is null or p_role not in ('admin', 'manager', 'frontdesk', 'leader', 'mechanic', 'cashier', 'owner', 'volunteer', 'door') then /* manager (20261009162000), door (20261111180500) */ raise exception 'ROLE' using errcode = '22023'; end if;
  if p_role = 'volunteer' and _volunteer_next() is null then raise exception 'NO_VOLUNTEER_SESSION' using errcode = 'P0001'; end if;
  if p_view is not null and not (p_view <@ allowed) then raise exception 'SECTION' using errcode = '22023'; end if;
  if p_edit is not null and not (p_edit <@ coalesce(p_view, allowed)) then raise exception 'EDIT_NOT_VIEW' using errcode = '22023'; end if;
  update staff set role = p_role,
         -- the volunteer's lists and the Door account's are the database's own, whatever was sent
         modules_view = case when p_role = 'volunteer' then '{}'::text[] when p_role = 'door' then array['queue']::text[] else p_view end,
         modules_edit = case when p_role in ('volunteer', 'door') then '{}'::text[] else p_edit end,
         volunteer_session = case when p_role = 'volunteer' then _volunteer_next() end
   where user_id = p_user;
  if not found then raise exception 'NO_SUCH_STAFF' using errcode = 'P0002'; end if;
  return true;
end $function$;
revoke all on function public.staff_set_access(uuid, text, text[], text[]) from public, anon;
grant execute on function public.staff_set_access(uuid, text, text[], text[]) to authenticated;

-- ── 2. A role's sections: Door reads Bookings ────────────────────────────────────────────────
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
    when 'door' then array['queue']  -- the scan screen: the day's bookings (20261111180500)
    else array['queue','cashier','workshop']  -- frontdesk (DESK_TABS), and an unknown role as on the page
  end
$function$;
revoke all on function public._staff_role_mods(text) from public, anon;
grant execute on function public._staff_role_mods(text) to authenticated;

-- ── 3. No capability for a Door account ──────────────────────────────────────────────────────
create or replace function public._staff_cap(p_cap text)
 returns boolean
 language sql
 stable security definer
 set search_path = public
as $function$
  select exists(
    select 1 from staff s
     where s.user_id = auth.uid() and s.disabled_at is null
       and s.role is distinct from 'volunteer'  -- can_refund and can_see_costs default to true (20261105090000)
       and s.role is distinct from 'door'  -- a Door account only checks riders in (20261111180500)
       and not (s.role = 'owner' and p_cap = 'can_refund')  /* the Owner role only looks: no refund, ticked or not (bh10) */
       and (s.role = 'admin'
            or case when jsonb_typeof(s.caps -> p_cap) = 'boolean' then (s.caps ->> p_cap)::boolean
                    else p_cap in ('can_refund', 'can_see_costs') end))
$function$;
revoke all on function public._staff_cap(text) from public, anon;
grant execute on function public._staff_cap(text) to authenticated;

-- ── 4. Is the caller a Door account ──────────────────────────────────────────────────────────
create or replace function public._staff_is_door()
 returns boolean
 language sql
 stable security definer
 set search_path = public
as $function$
  select exists(select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null and s.role = 'door')
$function$;
revoke all on function public._staff_is_door() from public, anon;
grant execute on function public._staff_is_door() to authenticated;

-- ── 5. The guards ────────────────────────────────────────────────────────────────────────────
-- A booking: a check-in of a rider who owes nothing, and nothing else.
create or replace function public._door_queue_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  moved constant text[] := array['status', 'checked_in_at', 'checked_in_by', 'assigned_bike_id', 'ride_group'];
  v_free boolean;
begin
  if pg_trigger_depth() > 1 or auth.uid() is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if not _staff_is_door() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'waiting' and new.status = 'active'
     and (to_jsonb(new) - moved) = (to_jsonb(old) - moved) then
    select coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') <> 'snd96' and not coalesce(s.paid_ride, false)
      into v_free from sessions s where s.id = old.session_id;
    if coalesce(old.paid, false) or coalesce(v_free, false)
       or ((coalesce(old.type_preference, '') = 'Own' or (old.price is not null and old.price <= coalesce(old.wallet_paid, 0)))
           and coalesce(nullif(btrim(old.addons), ''), '[]') in ('[]', '{}', 'null')) then
      return new;
    end if;
    raise exception 'DOOR_UNPAID: #% has not paid; the desk takes the payment', coalesce(old.queue_num::text, old.id)
      using errcode = '42501';
  end if;
  raise exception 'DOOR_ONLY_CHECKIN: a Door account only checks riders in' using errcode = '42501', detail = 'queue_entries';
end $function$;
revoke all on function public._door_queue_guard() from public, anon, authenticated;

drop trigger if exists a_door_guard on public.queue_entries;
create trigger a_door_guard before insert or update or delete on public.queue_entries
  for each row execute function public._door_queue_guard();

-- Everything else a Door account could reach: no write of its own.
create or replace function public._door_write_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public
as $function$
begin
  if pg_trigger_depth() = 1 and auth.uid() is not null then
    if _staff_is_door() then
      raise exception 'DOOR_ONLY_CHECKIN: a Door account only checks riders in' using errcode = '42501', detail = tg_table_name;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $function$;
revoke all on function public._door_write_guard() from public, anon, authenticated;

drop trigger if exists a_door_guard on public.cashier_sales;
create trigger a_door_guard before insert or update or delete on public.cashier_sales
  for each row execute function public._door_write_guard();
drop trigger if exists a_door_guard on public.wallet_ledger;
create trigger a_door_guard before insert or update or delete on public.wallet_ledger
  for each row execute function public._door_write_guard();
drop trigger if exists a_door_guard on public.locker_rentals;
create trigger a_door_guard before insert or update or delete on public.locker_rentals
  for each row execute function public._door_write_guard();
drop trigger if exists a_door_guard on public.lockers;
create trigger a_door_guard before insert or update or delete on public.lockers
  for each row execute function public._door_write_guard();
drop trigger if exists a_door_guard on public.locker_items;
create trigger a_door_guard before insert or update or delete on public.locker_items
  for each row execute function public._door_write_guard();
drop trigger if exists a_door_guard on public.staff_options;
create trigger a_door_guard before insert or update or delete on public.staff_options
  for each row execute function public._door_write_guard();
drop trigger if exists a_door_guard on public.customers;
create trigger a_door_guard before insert or update or delete on public.customers
  for each row execute function public._door_write_guard();
drop trigger if exists a_door_guard on public.sessions;
create trigger a_door_guard before insert or update or delete on public.sessions
  for each row execute function public._door_write_guard();

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111180500', 'door_role')
on conflict (version) do nothing;

commit;
