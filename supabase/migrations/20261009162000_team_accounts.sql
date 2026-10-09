-- ============================================================================
-- Team: accounts and what each may do (Staff app research 2026-10-09, M17), 2026-10-09.
--
--  1. staff.disabled_at: a disabled account is no staff account. is_staff() and is_admin() stop
--     answering for it (every policy and staff RPC reads them), and Supabase Auth refuses its
--     sign-in (auth.users.banned_until). Lock-out guard: nobody disables themselves, and the last
--     enabled admin cannot be disabled (staff_set_disabled). Re-enabling clears both.
--  2. staff.caps (jsonb): can_export, can_see_costs, can_refund, can_undo. Admins may do all four;
--     a cap an account does not name keeps what it had before caps existed (refund and costs yes,
--     export and undo no) - _staff_cap(cap). Refunds check it on the server
--     (staff_refund_receipt: CAP_REFUND), and inventory costs (staff_inventory_costs answers none).
--  3. staff_team_more(): for the Team page, each account's disabled_at, caps, display name and its
--     last sign-in (auth.users.last_sign_in_at). Admins and the Owner (read-only) role.
--     staff_team_list() answers the Owner role too (it read admins only).
--  4. staff_set_caps(user, caps), staff_set_disabled(user, on), staff_reset_password(user, pwd):
--     admins, never on their own account. A reset sets must_change_pwd, as a new account has.
--  5. staff_invite(email, name, role, password): admins make a new sign-in (auth.users + its email
--     identity, confirmed) with a temporary password and a staff row with must_change_pwd = true:
--     the person picks their own password at the first sign-in, as the staff onboarding script did.
--     An email that already has a sign-in is refused (EMAIL_TAKEN).
--  6. staff_set_access takes the new 'manager' role (the Manager preset: wide sections, no admin).
--
-- Rollback: alter table staff drop column disabled_at, drop column caps (after restoring is_staff /
--   is_admin from 20260925120000's pattern: exists(select 1 from staff where user_id = auth.uid()
--   [and role = 'admin'])); drop the new functions; re-run the saved pg_get_functiondef of
--   staff_team_list, staff_set_access, staff_refund_receipt and staff_inventory_costs (every patched
--   line carries "(20261009162000)"); update auth.users set banned_until = null for disabled staff.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

alter table public.staff add column if not exists disabled_at timestamptz;
alter table public.staff add column if not exists caps jsonb;
alter table public.staff drop constraint if exists staff_caps_shape;
alter table public.staff add constraint staff_caps_shape check (caps is null or (jsonb_typeof(caps) = 'object' and length(caps::text) <= 400));

-- ── 1. A disabled account is no staff account ───────────────────────────────────────────────
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path to 'public', 'extensions'
as $$
  select exists(select 1 from staff where user_id = auth.uid() and disabled_at is null);
$$;

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path to 'public'
as $$ select exists(select 1 from staff where user_id = auth.uid() and role = 'admin' and disabled_at is null); $$;

-- ── 2. Caps ─────────────────────────────────────────────────────────────────────────────────
create or replace function public._staff_cap(p_cap text)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select exists(
    select 1 from staff s
     where s.user_id = auth.uid() and s.disabled_at is null
       and (s.role = 'admin'
            or case when jsonb_typeof(s.caps -> p_cap) = 'boolean' then (s.caps ->> p_cap)::boolean
                    else p_cap in ('can_refund', 'can_see_costs') end))
$$;
revoke execute on function public._staff_cap(text) from public, anon;
grant execute on function public._staff_cap(text) to authenticated;

-- ── 3. The Team page's facts ────────────────────────────────────────────────────────────────
create or replace function public._staff_owner()
returns boolean
language sql stable security definer set search_path to 'public'
as $$ select exists(select 1 from staff where user_id = auth.uid() and role = 'owner' and disabled_at is null); $$;
revoke execute on function public._staff_owner() from public, anon, authenticated;

create or replace function public.staff_team_more()
returns table(user_id uuid, disabled_at timestamptz, caps jsonb, display_name text, last_sign_in_at timestamptz)
language plpgsql stable security definer set search_path to 'public', 'auth'
as $$
begin
  if not (is_admin() or _staff_owner()) then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  return query
    select s.user_id, s.disabled_at, s.caps, s.display_name, u.last_sign_in_at
      from staff s left join auth.users u on u.id = s.user_id;
end $$;
revoke execute on function public.staff_team_more() from public, anon;
grant execute on function public.staff_team_more() to authenticated;

do $tl$
declare d text;
begin
  d := pg_get_functiondef('public.staff_team_list()'::regprocedure);
  if position('(20261009162000)' in d) > 0 then raise notice 'staff_team_list already answers the owner'; return; end if;
  d := pg_temp._once(d,
$a$  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;$a$,
$b$  if not (is_admin() or _staff_owner()) then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;  -- the Owner reads Team (20261009162000)$b$);
  execute d;
end $tl$;

-- ── 4. Caps, disable, reset ─────────────────────────────────────────────────────────────────
create or replace function public.staff_set_caps(p_user uuid, p_caps jsonb)
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
declare k text; clean jsonb := '{}'::jsonb;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'NOT_YOURSELF' using errcode = '42501'; end if;
  if p_caps is not null and jsonb_typeof(p_caps) <> 'object' then raise exception 'BAD_CAPS' using errcode = '22023'; end if;
  for k in select key from jsonb_each(coalesce(p_caps, '{}'::jsonb)) loop
    if k not in ('can_export', 'can_see_costs', 'can_refund', 'can_undo') or jsonb_typeof(p_caps -> k) <> 'boolean' then
      raise exception 'BAD_CAPS' using errcode = '22023';
    end if;
    clean := clean || jsonb_build_object(k, p_caps -> k);
  end loop;
  update staff set caps = nullif(clean, '{}'::jsonb) where user_id = p_user;
  if not found then raise exception 'NO_SUCH_STAFF' using errcode = 'P0002'; end if;
  return true;
end $$;
revoke execute on function public.staff_set_caps(uuid, jsonb) from public, anon;
grant execute on function public.staff_set_caps(uuid, jsonb) to authenticated;

create or replace function public.staff_set_disabled(p_user uuid, p_disabled boolean)
returns boolean
language plpgsql security definer set search_path to 'public', 'auth'
as $$
declare r staff%rowtype;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'NOT_YOURSELF' using errcode = '42501'; end if;
  -- one at a time: two admins disabling each other cannot leave nobody
  perform pg_advisory_xact_lock(hashtext('staff_set_disabled'));
  select * into r from staff where user_id = p_user for update;
  if r.user_id is null then raise exception 'NO_SUCH_STAFF' using errcode = 'P0002'; end if;
  if coalesce(p_disabled, false) then
    if r.role = 'admin' and r.disabled_at is null
       and not exists (select 1 from staff s where s.role = 'admin' and s.disabled_at is null and s.user_id <> p_user) then
      raise exception 'LAST_ADMIN' using errcode = '42501';
    end if;
    update staff set disabled_at = coalesce(disabled_at, now()) where user_id = p_user;
    update auth.users set banned_until = now() + interval '100 years' where id = p_user;
  else
    update staff set disabled_at = null where user_id = p_user;
    update auth.users set banned_until = null where id = p_user;
  end if;
  return true;
end $$;
revoke execute on function public.staff_set_disabled(uuid, boolean) from public, anon;
grant execute on function public.staff_set_disabled(uuid, boolean) to authenticated;

create or replace function public.staff_reset_password(p_user uuid, p_password text)
returns boolean
language plpgsql security definer set search_path to 'public', 'extensions', 'auth'
as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'NOT_YOURSELF' using errcode = '42501'; end if;
  if length(coalesce(p_password, '')) < 8 or p_password !~ '[A-Z]' or p_password !~ '[0-9]' then
    raise exception 'BAD_PASSWORD' using errcode = '22023';
  end if;
  if not exists (select 1 from staff where user_id = p_user) then raise exception 'NO_SUCH_STAFF' using errcode = 'P0002'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = p_user;
  update staff set must_change_pwd = true where user_id = p_user;
  return true;
end $$;
revoke execute on function public.staff_reset_password(uuid, text) from public, anon;
grant execute on function public.staff_reset_password(uuid, text) to authenticated;

-- ── 5. A new sign-in ────────────────────────────────────────────────────────────────────────
create or replace function public.staff_invite(p_email text, p_name text, p_role text, p_password text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions', 'auth'
as $$
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
  if p_role is null or p_role not in ('admin', 'manager', 'frontdesk', 'leader', 'mechanic', 'cashier', 'owner') then
    raise exception 'ROLE' using errcode = '22023';
  end if;
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
  insert into staff (user_id, role, must_change_pwd, display_name) values (v_uid, p_role, true, v_name);
  return jsonb_build_object('ok', true, 'user_id', v_uid);
end $$;
revoke execute on function public.staff_invite(text, text, text, text) from public, anon;
grant execute on function public.staff_invite(text, text, text, text) to authenticated;

-- ── 6. The Manager role; refunds and costs follow the caps ──────────────────────────────────
do $sa$
declare d text;
begin
  d := pg_get_functiondef('public.staff_set_access(uuid,text,text[],text[])'::regprocedure);
  if position('(20261009162000)' in d) > 0 then raise notice 'staff_set_access already takes manager'; return; end if;
  d := pg_temp._once(d,
$a$p_role not in ('admin', 'frontdesk', 'leader', 'mechanic', 'cashier', 'owner') then$a$,
$b$p_role not in ('admin', 'manager', 'frontdesk', 'leader', 'mechanic', 'cashier', 'owner') then  -- manager (20261009162000)$b$);
  -- 'customers' has been a section of its own since 2026-10-07: an account limited to it was refused
  d := pg_temp._once(d,
$a$'inventory','workshop','community',$a$,
$b$'inventory','workshop','customers','community',$b$);
  execute d;
end $sa$;

do $rr$
declare d text;
begin
  d := pg_get_functiondef('public.staff_refund_receipt(text,text,text,text,uuid)'::regprocedure);
  if position('(20261009162000)' in d) > 0 then raise notice 'staff_refund_receipt already checks the cap'; return; end if;
  d := pg_temp._once(d,
$a$  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;$a$,
$b$  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;  -- Team caps (20261009162000)$b$);
  execute d;
end $rr$;

do $ic$
declare d text;
begin
  d := pg_get_functiondef('public.staff_inventory_costs()'::regprocedure);
  if position('(20261009162000)' in d) > 0 then raise notice 'staff_inventory_costs already checks the cap'; return; end if;
  d := pg_temp._once(d,
$a$  return query select i.id, i.cost from public.inventory i;$a$,
$b$  if not _staff_cap('can_see_costs') then return; end if;  -- Team caps: none for an account without it (20261009162000)
  return query select i.id, i.cost from public.inventory i;$b$);
  execute d;
end $ic$;

-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public.is_staff()', 'public.is_admin()', 'public._staff_cap(text)', 'public._staff_owner()',
    'public.staff_team_more()', 'public.staff_team_list()', 'public.staff_set_caps(uuid,jsonb)',
    'public.staff_set_disabled(uuid,boolean)', 'public.staff_reset_password(uuid,text)',
    'public.staff_invite(text,text,text,text)', 'public.staff_set_access(uuid,text,text[],text[])',
    'public.staff_refund_receipt(text,text,text,text,uuid)', 'public.staff_inventory_costs()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public.staff_team_more()', 'public.staff_set_caps(uuid,jsonb)', 'public.staff_set_disabled(uuid,boolean)',
    'public.staff_reset_password(uuid,text)', 'public.staff_invite(text,text,text,text)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception '% lost its authenticated grant', f; end if;
  end loop;
  -- nobody is locked out by this migration: every admin that was is still one
  if not exists (select 1 from staff where role = 'admin' and disabled_at is null) then
    raise exception 'no enabled admin left';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009162000', 'team_accounts')
on conflict (version) do nothing;

commit;
