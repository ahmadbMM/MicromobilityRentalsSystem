-- ============================================================================
-- Staff reset an account's sign-in wait (the owner, 2026-09-30: "this account ... shows her too
-- many failed attempts try again in 15 mins, reset the waiting time and add an option to reset the
-- waiting time for accounts by staff as a button on their account page from community section").
--
-- customer_login and customer_reset (20260922121000) count failures in login_throttle and lock a
-- key for 15 minutes at 8: the email or Apple address as typed, 'phone:' + the typed digits,
-- 'acct:' + the account's id, and 'reset:' + the email for Forgot password. Nothing but a success
-- or the 15 minutes cleared them, so a locked rider waited even with staff on the phone.
--
--  1. _sign_in_lock_rows(id): the account's rows. Its email and Apple address now and every email
--     it had before (audit_log; a rider keeps typing the old one), each with its 'reset:' twin,
--     'acct:' + id, and every phone key whose last 9 digits are the account's (the digits are the
--     typed ones: 0501234567 and 966501234567 are one phone). Internal only.
--  2. staff_sign_in_lock(id): the account's standing, for the editor: the most failures on any of
--     its keys that still count (not past an expired lock, not a day old) and when a live lock ends.
--     A read; is_staff()-gated.
--  3. staff_clear_sign_in_lock(id): deletes those rows and says how many went. is_staff()-gated.
--
-- login_throttle keeps RLS on with no policy (no client reads or writes it); these are security
-- definer for that reason. The per-network meters (_ip_gate) are not the account's and stay.
--
-- Rollback:
--   drop function if exists public.staff_clear_sign_in_lock(text);
--   drop function if exists public.staff_sign_in_lock(text);
--   drop function if exists public._sign_in_lock_rows(text);
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function public._sign_in_lock_rows(p_customer_id text)
 returns setof public.login_throttle
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  with c as (
    select cu.id, right(regexp_replace(coalesce(cu.phone, ''), '\D', '', 'g'), 9) as p9
      from customers cu where cu.id = p_customer_id
  ), em as (
    select lower(btrim(x.e)) as e
      from c, lateral (
        select cu.email from customers cu where cu.id = c.id
        union all select cu.apple_email from customers cu where cu.id = c.id
        union all select al.changed->'email'->>'old' from audit_log al
                   where al.tbl = 'customers' and al.row_id = c.id and al.changed ? 'email'
      ) x(e)
     where coalesce(btrim(x.e), '') <> ''
  ), k as (
    select 'acct:' || c.id as k from c
    union select em.e from em
    union select 'reset:' || em.e from em
  )
  select t.* from login_throttle t where t.identifier in (select k.k from k)
  union
  select t.* from login_throttle t, c
   where length(c.p9) = 9 and t.identifier like 'phone:%' and right(t.identifier, 9) = c.p9
$function$;
revoke all on function public._sign_in_lock_rows(text) from public, anon, authenticated;

create or replace function public.staff_sign_in_lock(p_customer_id text)
 returns table(fails integer, locked_until timestamptz)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
begin
  if not is_staff() then return; end if;
  return query
    select coalesce(max(r.fails) filter (where (r.locked_until is null or r.locked_until > now())
                                           and r.updated_at >= now() - interval '1 day'), 0)::integer,
           max(r.locked_until) filter (where r.locked_until > now())
      from _sign_in_lock_rows(p_customer_id) r;
end $function$;
revoke all on function public.staff_sign_in_lock(text) from public, anon;
grant execute on function public.staff_sign_in_lock(text) to authenticated;

create or replace function public.staff_clear_sign_in_lock(p_customer_id text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n integer;
begin
  if not is_staff() then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from login_throttle t
   where t.identifier in (select r.identifier from _sign_in_lock_rows(p_customer_id) r);
  get diagnostics n = row_count;
  return n;
end $function$;
revoke all on function public.staff_clear_sign_in_lock(text) from public, anon;
grant execute on function public.staff_clear_sign_in_lock(text) to authenticated;

commit;
