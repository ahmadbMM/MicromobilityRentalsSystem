-- The owner's decisions of 2026-10-07 on passwords.
--
-- 1. No self-service password reset. customer_reset set a new password from an email and the last
--    nine digits of the account's phone, with nothing sent to the rider, and handed back a live
--    session: anyone who knew both could take the account over (2,278 accounts qualified).
--    A rider who forgets their password now messages us on WhatsApp, and staff send a temporary
--    password (staff_set_customer_temp_password) that the rider changes at the next sign-in.
--    The function stays, with its signature and grants, so an old page still cached on a phone
--    gets a clear refusal instead of a missing-function error.
--
-- 2. Every password staff set is temporary. staff_set_customer_password set a rider's password
--    with no mark, so staff could sign in as the rider without the rider ever knowing. It now
--    does exactly what staff_set_customer_temp_password does (must_change_pwd, the same rules).

create or replace function public.customer_reset(p_email text, p_phone text, p_new_pwd text)
returns table(id text, name text, email text, phone text, height integer, type_preference text,
              created_at text, birth_date text, country text, city text, photo text, session_token text)
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
begin
  -- (20261007140000) Reset by staff only: the rider messages us, staff send a temporary password.
  raise exception 'RESET_BY_STAFF' using errcode = 'P0001';
end $function$;

create or replace function public.staff_set_customer_password(p_customer_id text, p_new_pwd text)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
begin
  -- (20261007140000) Always temporary: the rider chooses their own at the next sign-in.
  return staff_set_customer_temp_password(p_customer_id, p_new_pwd);
end $function$;
