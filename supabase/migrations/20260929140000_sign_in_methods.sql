-- ============================================================================
-- Which accounts sign in with Google or Apple (the owner, 2026-09-29: "show an icon besides the
-- account's email showing if the customer is signed in with apple or google").
--
-- customers.password_hash cannot tell: customer_oauth_signup writes 'oauth:google' for a Google
-- and an Apple sign-up alike, and a password account that also signs in with Google or Apple
-- keeps its password (before 2026-09-25, and Apple accounts since 20260929080000). What does
-- tell is Supabase Auth's own record of each sign-in (auth.identities, provider 'google' or
-- 'apple'), matched on the account's email or its linked Apple relay address. On 2026-09-29:
-- 562 accounts Google, 197 Apple, 19 both, 190 password accounts that also use one; 149 social
-- accounts had no record, all made before the move to this project on 2026-07-04 (141 of them
-- Gmail addresses), whose 'oauth:google' is right. So:
--   google = a Google record, or no record at all and 'oauth:google' (not a relay address);
--   apple  = an Apple record, or an Apple relay email, or no record at all and 'oauth:apple'.
--
--  1. _sign_in_methods(p_id): that rule for every account (or one), internal only: it reads
--     auth.identities and password_hash, which no client may.
--  2. staff_sign_in_methods(): staff only, the accounts with either, for the Accounts list and the
--     account editor. Read on its own, not through staff_sync, so no device's cached copy of the
--     customers has to be thrown away.
--  3. customer_about(p_id, p_token) gains sign_in ('google', 'apple' or 'google,apple'), for the
--     rider's own account page (dropped and made again: its columns change).
--
-- Rollback:
--   drop function if exists public.staff_sign_in_methods();
--   re-run customer_about from 20260929110000 (drop it first);
--   drop function if exists public._sign_in_methods(text);
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function public._sign_in_methods(p_id text default null)
 returns table(id text, google boolean, apple boolean)
 language sql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
  with idp as (
    -- Every Google or Apple sign-in record, by the email it carries and by its user's email.
    select distinct lower(btrim(x.em)) as em, x.provider
      from (select i.identity_data->>'email' as em, i.provider
              from auth.identities i where i.provider in ('google', 'apple')
            union all
            select u.email, i.provider
              from auth.identities i join auth.users u on u.id = i.user_id
             where i.provider in ('google', 'apple')) x
     where coalesce(btrim(x.em), '') <> ''
  ), c as (
    select cu.id, lower(btrim(coalesce(cu.email, ''))) as em, lower(btrim(coalesce(cu.apple_email, ''))) as aem,
           coalesce(cu.password_hash, '') as ph
      from customers cu
     where p_id is null or cu.id = p_id
  ), k as (
    -- Two plain matches (the email, the relay address), so each is a hash join.
    select c.id, idp.provider from c join idp on idp.em = c.em
    union all
    select c.id, idp.provider from c join idp on idp.em = c.aem where c.aem <> ''
  ), m as (
    select c.id, c.em, c.ph,
           coalesce(bool_or(k.provider = 'google'), false) as g,
           coalesce(bool_or(k.provider = 'apple'), false) as a
      from c left join k on k.id = c.id
     group by c.id, c.em, c.ph
  )
  select m.id,
         m.g or (not m.a and m.ph = 'oauth:google' and m.em not like '%@privaterelay.appleid.com'),
         m.a or m.em like '%@privaterelay.appleid.com' or (not m.g and m.ph = 'oauth:apple')
    from m
$function$;
revoke execute on function public._sign_in_methods(text) from public, anon, authenticated;

create or replace function public.staff_sign_in_methods()
 returns table(id text, google boolean, apple boolean)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return query select s.id, s.google, s.apple from _sign_in_methods(null) s where s.google or s.apple;
end $function$;
revoke execute on function public.staff_sign_in_methods() from public, anon;
grant  execute on function public.staff_sign_in_methods() to authenticated;

drop function if exists public.customer_about(text, text);
create function public.customer_about(p_id text, p_token text)
 returns table(profession text, workplace text, heard_from text, sign_in text)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not _cust_token_ok(p_id, p_token) then return; end if;
  return query select c.profession, c.workplace, c.heard_from,
      nullif(concat_ws(',', case when s.google then 'google' end, case when s.apple then 'apple' end), '')
    from customers c left join _sign_in_methods(p_id) s on s.id = c.id
   where c.id = p_id;
end $function$;
revoke execute on function public.customer_about(text, text) from public;
grant  execute on function public.customer_about(text, text) to anon, authenticated;

commit;
