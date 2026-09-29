-- ============================================================================
-- A temporary password staff make for a customer (the owner, 2026-09-29: "add a button when staff
-- edits customer password to generate him a random password to send to the customer and the next
-- time the customer signs in with the temp password force him to change it").
--
-- staff_set_customer_temp_password is staff_set_customer_password with the account's
-- must_change_pwd mark set, the way staff_community_approve sets it for a new member: the next
-- sign-in meets "Choose your own password" (customer_pwd_state), which only
-- customer_set_own_password closes. The password is stored hashed (bcrypt) and the session token
-- rotates, so every device signed in to the account is signed out. _customers_pwd_changed clears
-- the mark on any other password change; mm.temp_pwd tells it this one is the temporary one.
-- A password staff type themselves still goes through staff_set_customer_password, unchanged.
--
-- Rollback: drop function if exists public.staff_set_customer_temp_password(text, text);
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function public.staff_set_customer_temp_password(p_customer_id text, p_new_pwd text)
returns boolean
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare n int;
begin
  if not is_staff() then return false; end if;
  if length(coalesce(p_new_pwd, '')) < 8 or p_new_pwd !~ '[A-Z]' or p_new_pwd !~ '[0-9]' then return false; end if;
  perform set_config('mm.temp_pwd', '1', true);
  update customers
     set password_hash   = crypt(p_new_pwd, gen_salt('bf', 10)),
         session_token   = encode(gen_random_bytes(24), 'hex'),
         must_change_pwd = true
   where id = p_customer_id;
  get diagnostics n = row_count;
  perform set_config('mm.temp_pwd', '', true);
  return n > 0;
end $$;

revoke all on function public.staff_set_customer_temp_password(text, text) from public, anon;
grant execute on function public.staff_set_customer_temp_password(text, text) to authenticated;

commit;
