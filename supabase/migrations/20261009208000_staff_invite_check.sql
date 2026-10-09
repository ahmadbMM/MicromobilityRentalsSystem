-- ============================================================================
-- A check after Team > Invite (staff app round 2, 2026-10-09).
--
-- staff_invite (20261009162000) writes auth.users, auth.identities and staff itself, inside the database,
-- instead of going through Supabase Auth's admin API (the page has no service key). A change in Auth's
-- tables (a new NOT NULL column, a changed identity shape) could leave an account that cannot sign in
-- while staff_invite still answers ok. staff_invite_check(p_user) reads back, for admins only, what the
-- new account needs to sign in with its email and password:
--   {ok, staff, auth, identity, confirmed, password, email, role}
--   staff     a staff row (not disabled)        auth       an auth.users row
--   identity  an 'email' identity for it        confirmed  email_confirmed_at is set
--   password  encrypted_password is set (bcrypt) ok         all of these
-- Read-only. The page calls it right after staff_invite and says plainly which part is missing.
--
-- Rollback: drop function public.staff_invite_check(uuid).
-- Idempotent.
-- ============================================================================

begin;

create or replace function public.staff_invite_check(p_user uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public', 'auth'
as $$
declare v_staff boolean; v_role text; v_auth boolean; v_conf boolean; v_pwd boolean; v_email text; v_ident boolean;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  select true, s.role into v_staff, v_role from staff s where s.user_id = p_user and s.disabled_at is null;
  select true, u.email_confirmed_at is not null, coalesce(u.encrypted_password, '') like '$2%', u.email
    into v_auth, v_conf, v_pwd, v_email
    from auth.users u where u.id = p_user;
  select exists (select 1 from auth.identities i where i.user_id = p_user and i.provider = 'email') into v_ident;
  v_staff := coalesce(v_staff, false); v_auth := coalesce(v_auth, false);
  v_conf := coalesce(v_conf, false); v_pwd := coalesce(v_pwd, false);
  return jsonb_build_object('ok', v_staff and v_auth and v_ident and v_conf and v_pwd,
    'staff', v_staff, 'auth', v_auth, 'identity', v_ident, 'confirmed', v_conf, 'password', v_pwd,
    'email', v_email, 'role', v_role);
end $$;
revoke execute on function public.staff_invite_check(uuid) from public, anon;
grant execute on function public.staff_invite_check(uuid) to authenticated;

do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.staff_invite_check(uuid)'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))
     or has_function_privilege('anon', 'public.staff_invite_check(uuid)', 'execute') then
    raise exception 'staff_invite_check carries the wrong attributes';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009208000', 'staff_invite_check')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
