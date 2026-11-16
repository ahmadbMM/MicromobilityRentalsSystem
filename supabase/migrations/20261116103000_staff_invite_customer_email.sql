-- ============================================================================
-- A staff account on an email a customer account already uses (the user, 2026-11-16: "allow creating a staff
-- account with the same email used in a customer account"), 2026-11-16.
--
-- Customer accounts live in public.customers and sign in with their own session tokens, so a customer who made a
-- password account never had a Supabase Auth row and Team > Invite already took that email. A customer who ever
-- signed in with Google or Apple did get one (auth.users + a 'google' or 'apple' identity), and staff_invite refused
-- any email with an auth.users row (EMAIL_TAKEN). Read on prod 2026-11-16: 1,999 auth.users rows with no staff row,
-- every one Google or Apple only (no password, no 'email' identity, no ban, no NULL token column), 1,586 of them on
-- a customer's current email; 593 auth.sessions rows on them, the last made 2026-11-09 (the buttons went that day).
-- Five of the twelve staff accounts already are one auth user with an 'email' identity beside a Google or Apple one.
--
-- staff_invite (rebuilt from the live definition, 20261111180500, md5 97aa4a9907a32abd3f51dfa0a7f6ff24 on prod and
-- staging):
--   - an email whose auth.users row already has a staff row is still refused (EMAIL_TAKEN);
--   - an email whose row has none (a customer's old Google or Apple sign-in) becomes the staff account: the row gets
--     the temporary password, 'email' among its providers, op_name in its user metadata and a confirmed email; an
--     'email' identity is added if it has none; its auth.sessions rows are deleted, so a device still holding the old
--     Google or Apple session is not signed in as staff (the customer page already drops such a session at boot,
--     _sbDropOauth). The staff row is made as for a new account (must_change_pwd = true). The customer account in
--     public.customers is not touched, and its Google or Apple mark (_sign_in_methods reads the identities) stays.
--   - an email with no row is made new, as before.
-- The answer gains 'linked' (true when an existing sign-in was taken over). staff_invite_check reads the same five
-- facts either way.
--
-- Rollback: re-run staff_invite from 20261111180500_door_role.sql (section 1). An account made through the takeover
--   keeps its staff row and password; disable it on Team if it should go.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

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
  v_old uuid;
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
  -- a sign-in already on this email: a staff account's is refused, a customer's Google or Apple one is taken over
  -- (20261116103000)
  select u.id into v_old from auth.users u where lower(u.email) = v_email order by u.created_at limit 1 for update;
  if v_old is not null then
    if exists (select 1 from staff where user_id = v_old) then
      raise exception 'EMAIL_TAKEN' using errcode = '23505';
    end if;
    v_uid := v_old;
    update auth.users u
       set encrypted_password = crypt(p_password, gen_salt('bf')),
           email_confirmed_at = coalesce(u.email_confirmed_at, now()),
           banned_until = null,
           raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('providers',
             (select coalesce(jsonb_agg(distinct p), '["email"]'::jsonb)
                from jsonb_array_elements_text(
                       case when jsonb_typeof(u.raw_app_meta_data -> 'providers') = 'array'
                            then u.raw_app_meta_data -> 'providers' else '[]'::jsonb end || '["email"]'::jsonb) p)),
           raw_user_meta_data = coalesce(u.raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('op_name', v_name),
           confirmation_token = coalesce(u.confirmation_token, ''), recovery_token = coalesce(u.recovery_token, ''),
           email_change_token_new = coalesce(u.email_change_token_new, ''), email_change = coalesce(u.email_change, ''),
           email_change_token_current = coalesce(u.email_change_token_current, ''),
           phone_change = coalesce(u.phone_change, ''), phone_change_token = coalesce(u.phone_change_token, ''),
           reauthentication_token = coalesce(u.reauthentication_token, ''),
           updated_at = now()
     where u.id = v_uid;
    if not exists (select 1 from auth.identities i where i.user_id = v_uid and i.provider = 'email') then
      insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (gen_random_uuid(), v_uid, v_uid::text,
              jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
              'email', null, now(), now());
    end if;
    delete from auth.sessions where user_id = v_uid;
  else
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
  end if;
  -- a Door account reads Bookings and changes no section (20261111180500)
  insert into staff (user_id, role, must_change_pwd, display_name, volunteer_session, modules_view, modules_edit)
    values (v_uid, p_role, true, v_name, case when p_role = 'volunteer' then _volunteer_next() end,
            case when p_role = 'door' then array['queue']::text[] end,
            case when p_role = 'door' then '{}'::text[] end);
  return jsonb_build_object('ok', true, 'user_id', v_uid, 'linked', v_old is not null);
end $function$;
revoke all on function public.staff_invite(text, text, text, text) from public, anon;
grant execute on function public.staff_invite(text, text, text, text) to authenticated;

do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.staff_invite(text,text,text,text)'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))
     or has_function_privilege('anon', 'public.staff_invite(text,text,text,text)', 'execute') then
    raise exception 'staff_invite carries the wrong attributes';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261116103000', 'staff_invite_customer_email')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- Check (read-only), after: the function takes over a customer's sign-in, and the attributes are right.
--   select pg_get_functiondef('public.staff_invite(text,text,text,text)'::regprocedure) like '%(20261116103000)%' as rebuilt,
--          (select prosecdef from pg_proc where oid = 'public.staff_invite(text,text,text,text)'::regprocedure) as definer,
--          has_function_privilege('anon', 'public.staff_invite(text,text,text,text)', 'execute') as anon_can,
--          (select name from supabase_migrations.schema_migrations where version = '20261116103000') as ledger;
