-- ============================================================================
-- The activity waiver is activity-2026-10-v3 (the owner, 2026-10-18: no cycling words on a non-cycling session,
-- "especially in the waiver too"). Its first sentence said "any ride or activity"; it now says "any activity", in
-- every language. The workshop, events, the runs and Victory Lap take this waiver (_waiverKind 'activity').
--
-- This raises _waiver_min('activity') from activity-2026-10-v2 to activity-2026-10-v3, so customer_create_booking,
-- rider_register and customer_accept_waiver refuse the old text (WAIVER_OUTDATED, P0001) from a page that still
-- carries it; the page then says the waiver changed and reloads into the new one. Bookings already stamped v2 keep
-- their stamp and are NOT asked again: the desk-added waiver pop-up asks only rows with no waiver at all.
--
-- Apply AFTER both clients carry activity-2026-10-v3 (the booking app's ACTIVITY_WAIVER_VERSION and mm-platform's
-- WAIVER_VERSIONS): until then v3 already passes (a newer version than the minimum is never refused), so nothing
-- needs this to book; applied first, it would refuse every page that still shows the v2 text.
-- Rollback: the same function with 'activity-2026-10-v2'.
-- Idempotent.
-- ============================================================================

begin;

create or replace function public._waiver_min(p_kind text)
returns text
language sql stable set search_path to 'public'
as $$
  select case p_kind
           when 'ride'     then '2026-10-v3'
           when 'swim'     then 'swim-2026-10-v3'
           when 'activity' then 'activity-2026-10-v3'
         end
$$;
revoke all on function public._waiver_min(text) from public, anon, authenticated;

do $chk$
begin
  if _waiver_outdated('activity-2026-10-v3') or _waiver_outdated('2026-10-v3') or _waiver_outdated('swim-2026-10-v3')
     or not _waiver_outdated('activity-2026-10-v2') or not _waiver_outdated('workshop-2026-09-v1') then
    raise exception '_waiver_outdated does not answer as expected';
  end if;
  if has_function_privilege('anon', 'public._waiver_min(text)', 'execute')
     or has_function_privilege('authenticated', 'public._waiver_min(text)', 'execute') then
    raise exception '_waiver_min is executable by a client';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261018190000', 'activity_waiver_v3')
on conflict (version) do nothing;

commit;
