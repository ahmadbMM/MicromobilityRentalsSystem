-- ============================================================================
-- The booking app moved to https://experiences.micromobility.sa (2026-11-09, the user: "move the current bookings
-- app to a new domain experiences.micromobility.sa"). The push drain (mm-push-drain, every two minutes) posted to
-- the old address's /api/push-send. That address still answers /api (functions/_middleware.js keeps it for this
-- call and for pages opened before the move), so nothing broke; this points the call at the site's own address.
--
-- Apply AFTER experiences.micromobility.sa serves the app (curl -sI https://experiences.micromobility.sa/ is 200):
-- before that the new address does not resolve and the drain would fail.
--
-- Header copied from 20261108180000_referral_extras.sql (not from prosrc): security definer, search_path public.
-- create or replace keeps the function's grants; the revoke is repeated as that migration does.
--
-- Rollback: the same function with url := 'https://micromobilityrentals.pages.dev/api/push-send'.
-- ============================================================================

create or replace function public._push_drain_call()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if exists (select 1 from push_outbox where sent_at is null and created_at > now() - interval '3 days') then
    perform net.http_post(url := 'https://experiences.micromobility.sa/api/push-send', body := '{"drain":true}'::jsonb,
                          headers := '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds := 20000);
  end if;
end $function$;
revoke all on function public._push_drain_call() from public, anon, authenticated;
