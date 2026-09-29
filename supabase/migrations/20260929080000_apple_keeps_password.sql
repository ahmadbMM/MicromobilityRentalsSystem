-- An Apple account keeps its password when its rider signs in with Apple (the owner, 2026-09-29).
--
-- Since the review fixes of 2026-09-25, a Google or Apple sign-in ends a password on the account
-- it lands on: whoever set one before the address's owner proved the address loses it, and the
-- session token rotates, signing every other device out. An account holding an Apple relay
-- address (apple_email) is the one kind the site REQUIRES a password from: _customer_asks asks
-- for 'password' while its hash is 'oauth:%', and customer_create_booking refuses the booking
-- until it is answered (FIX_FIRST). So the two rules chased each other: the rider sets a
-- password, signs in with Apple, the password is gone, the other devices are signed out, and the
-- next event pick asks for a password again. 21 Apple accounts held a password on 2026-09-29.
--
-- On an account with an apple_email, a sign-in now keeps the password and the session token, as
-- it already did for an account with no password. Every other account is unchanged. Rebuilt from
-- the live pg_get_functiondef: SECURITY DEFINER and the search_path stay (see
-- supabase/checks/security-attributes.sql); CREATE OR REPLACE keeps the grants.

CREATE OR REPLACE FUNCTION public.customer_oauth_login(p_email text)
 RETURNS TABLE(id text, name text, email text, phone text, height integer, type_preference text, created_at text, birth_date text, country text, city text, photo text, session_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare r customers%rowtype; c customers%rowtype; tok text; prov text := coalesce(auth.jwt()->'app_metadata'->>'provider',''); hops int := 0;
begin
  if auth.uid() is null or lower(coalesce(auth.jwt()->>'email','')) <> lower(p_email)
     or prov not in ('google','apple') then return; end if;
  select * into r from customers
   where lower(customers.email) = lower(p_email) or lower(customers.apple_email) = lower(p_email)
   order by coalesce(lower(customers.email) = lower(p_email), false) desc
   limit 1;
  if not found then return; end if;
  while r.merged_into is not null and hops < 5 loop
    select * into c from customers where customers.id = r.merged_into;
    exit when not found;
    r := c; hops := hops + 1;
  end loop;
  -- No password to end, or an Apple account the site asks to keep one (2026-09-29): the
  -- password and the token stay, so no other device is signed out.
  if coalesce(r.password_hash,'') like 'oauth:%' or coalesce(btrim(r.apple_email),'') <> '' then
    tok := coalesce(nullif(r.session_token,''), encode(gen_random_bytes(24),'hex'));
    update customers set session_token = tok where customers.id = r.id;
  else
    tok := encode(gen_random_bytes(24),'hex');
    update customers set session_token = tok, password_hash = 'oauth:' || prov, must_change_pwd = false
     where customers.id = r.id;
  end if;
  return query select r.id, r.name, r.email, r.phone, r.height, r.type_preference,
    r.created_at, r.birth_date, r.country, r.city, r.photo, tok;
end $function$;

DO $check$
BEGIN
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.customer_oauth_login(text)'::regprocedure) THEN
    RAISE EXCEPTION 'customer_oauth_login lost SECURITY DEFINER';
  END IF;
END $check$;
