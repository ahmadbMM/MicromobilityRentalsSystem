-- ─────────────────────────────────────────────────────────────────────────────
-- The role column gets teeth, and the two public oracles get a meter.
--
-- Four loosely-related hardenings, found by the security advisor and by reading:
--
-- 1. ROLES. staff.role has existed since July and the DATABASE has never read
--    it: every policy asks is_staff(), so a frontdesk session can delete any
--    customer, session, bike, inventory item or promo code the API will accept
--    -- the UI hides the buttons, the API does not. is_admin() makes the role
--    real, and DELETE moves behind it on the five tables whose deletion is an
--    admin act. Deliberately NOT admin-gated: queue_entries delete (the booking
--    retry path rolls back its own inserts at the desk) and cashier_sales
--    delete (voiding a sale at the till is front-desk work).
--
-- 2. On sessions, the redundant "staff write" ALL policy is REPLACED by an
--    explicit "staff read" -- not dropped outright, because it is what lets
--    staff SELECT tag-gated sessions ("public read ungated" covers only
--    required_tag_id IS NULL). The app reads sessions through list_sessions,
--    but a direct select must keep working.
--
-- 3. ORACLES. customer_exists (does this email/phone have an account?) and
--    staff_email_for_phone (phone -> staff email) are anon-callable by design:
--    login and signup need them before any auth exists. Unmetered, they let
--    anyone enumerate the customer list overnight. They now spend from a
--    per-IP budget in login_throttle (prefix 'oracle:'): 30 calls per window,
--    then 5 minutes locked. A locked caller gets the not-found answer, not an
--    error -- the shape of the reply must not become the new oracle. Real use
--    is 1-2 calls per signup attempt. This slows enumeration ~100x; a
--    distributed attacker still exists, and this does not pretend otherwise.
--
-- 4. HYGIENE. Trigger functions and staff_mark_pwd_changed lose their anon
--    EXECUTE. PostgREST cannot invoke trigger-typed functions anyway, so
--    nothing changes in practice -- but the advisor stops flagging 9 findings,
--    and a quiet audit is what makes the next real finding visible.
--
-- Plus: the three staff mobiles hardcoded in the public JS bundle move into
-- staff_phones, where Alwaleed's already lives; the client map is deleted in
-- the same commit.
--
-- Rollback: drop function is_admin() cascade will not work (policies depend);
-- instead re-point the five DELETE policies back to is_staff(), re-create
-- "staff write" on sessions, and re-apply the previous one-line bodies of the
-- two oracle functions (in git history).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. the role, readable at last
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ select exists(select 1 from staff where user_id = auth.uid() and role = 'admin'); $$;
REVOKE ALL ON FUNCTION public.is_admin() FROM public;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;

-- 2. sessions: replace the ALL policy with the read it was actually providing
DROP POLICY IF EXISTS "staff write" ON public.sessions;
DROP POLICY IF EXISTS "staff read" ON public.sessions;
CREATE POLICY "staff read" ON public.sessions FOR SELECT USING ((select is_staff()));
ALTER POLICY "staff delete" ON public.sessions USING ((select is_admin()));

-- customers: the ALL policy splits so DELETE alone can move
DROP POLICY IF EXISTS "staff full" ON public.customers;
DROP POLICY IF EXISTS "staff read" ON public.customers;
DROP POLICY IF EXISTS "staff insert" ON public.customers;
DROP POLICY IF EXISTS "staff update" ON public.customers;
DROP POLICY IF EXISTS "admin delete" ON public.customers;
CREATE POLICY "staff read"   ON public.customers FOR SELECT USING ((select is_staff()));
CREATE POLICY "staff insert" ON public.customers FOR INSERT WITH CHECK ((select is_staff()));
CREATE POLICY "staff update" ON public.customers FOR UPDATE USING ((select is_staff())) WITH CHECK ((select is_staff()));
CREATE POLICY "admin delete" ON public.customers FOR DELETE USING ((select is_admin()));

ALTER POLICY "staff delete" ON public.bikes       USING ((select is_admin()));
ALTER POLICY "staff delete" ON public.inventory   USING ((select is_admin()));
ALTER POLICY "staff delete" ON public.promo_codes USING ((select is_admin()));

-- 3. the per-IP meter, shared by both oracles
CREATE OR REPLACE FUNCTION public._oracle_gate()
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare ip text; k text; thr login_throttle%rowtype; n int;
begin
  begin
    ip := split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for','?'), ',', 1);
  exception when others then ip := '?';
  end;
  k := 'oracle:' || left(trim(ip), 60);
  select * into thr from login_throttle where identifier = k;
  if thr.locked_until is not null and thr.locked_until > now() then return false; end if;
  n := (case when thr.locked_until is not null and thr.locked_until <= now() then 0
             else coalesce(thr.fails, 0) end) + 1;
  insert into login_throttle(identifier, fails, locked_until)
    values (k, n, case when n >= 30 then now() + interval '5 minutes' else null end)
    on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until;
  return true;
end $function$;
REVOKE ALL ON FUNCTION public._oracle_gate() FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.customer_exists(p_email text, p_phone text)
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  -- Over budget answers "no account", not an error: the reply's SHAPE must not
  -- become the new oracle. A throttled real user falls through to signup, whose
  -- unique constraints still hold the line.
  if not _oracle_gate() then return false; end if;
  return exists(select 1 from customers
    where (coalesce(p_email,'')<>'' and lower(email)=lower(p_email))
       or (coalesce(p_phone,'')<>'' and phone=p_phone));
end $function$;

CREATE OR REPLACE FUNCTION public.staff_email_for_phone(p_phone text)
 RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  -- Same rule: over budget looks like "no such phone"; staff fall back to
  -- typing their email, which never touches this function.
  if not _oracle_gate() then return null; end if;
  return (select email from staff_phones
    where regexp_replace(phone, '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g')
    limit 1);
end $function$;

-- 4. anon loses what it could never usefully call
REVOKE EXECUTE ON FUNCTION public._approval_guard() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._community_booking_gate() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._grant_auto_tags() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._promo_count() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._session_fill_status() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assign_queue_num() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.queue_num_update_guard() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.staff_mark_pwd_changed() FROM anon;

-- The three mobiles that had been riding in the public bundle since July were moved into
-- staff_phones here, one row per staff login. Those rows are people's data, so they are no longer
-- written in this file (2026-10-05, the repository is public): staff phones are entered with
-- sql/applied/staff-onboarding.sql, as for every other staff member.
