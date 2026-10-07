-- ============================================================================
-- The waiver popup for desk-added riders takes only the waiver in force (the owner, 2026-10-07: "yes" to
-- "it accepts an outdated waiver version - should it force the current version?").
--
-- customer_accept_waiver stamped whatever version-shaped text it was sent, so a page loaded before a
-- waiver change recorded the old waiver. It now refuses a version older than the one in force for its
-- kind, as customer_create_booking and rider_register have since 20261005210000 (_waiver_outdated,
-- WAIVER_OUTDATED, P0001); a version the rule does not know still passes, as there. The booking app
-- (acceptWaiverGate) and the website (/api/account/pending-waiver) answer it by saying the waiver changed
-- and reloading into the current page, whose waiver the rider then agrees to.
--
-- Apply AFTER both clients that handle WAIVER_OUTDATED are live: a page from before would read the refusal
-- as a failed save until reloaded.
-- Rollback: re-run the pg_get_functiondef of customer_accept_waiver from before this migration (drop the
-- WAIVER_OUTDATED block).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

do $aw$
declare d text;
begin
  d := pg_get_functiondef('public.customer_accept_waiver(text,text,text,text)'::regprocedure);
  if position('(20261007234500)' in d) > 0 then
    raise notice 'customer_accept_waiver already takes the waiver in force only; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  if coalesce(p_version, '') !~ '^[A-Za-z0-9._-]{1,40}$' then
    raise exception 'WAIVER_REQUIRED' using errcode = 'P0001';
  end if;$a$,
$b$  if coalesce(p_version, '') !~ '^[A-Za-z0-9._-]{1,40}$' then
    raise exception 'WAIVER_REQUIRED' using errcode = 'P0001';
  end if;
  -- only the waiver in force (the owner, 2026-10-07): an older version is refused, as a booking refuses it (20261007234500)
  if _waiver_outdated(p_version) then
    raise exception 'WAIVER_OUTDATED' using errcode = 'P0001';
  end if;$b$);
  execute d;
end $aw$;

do $chk$
declare f text := 'public.customer_accept_waiver(text,text,text,text)';
begin
  if position('(20261007234500)' in pg_get_functiondef(f::regprocedure)) = 0 then
    raise exception '% was not patched', f;
  end if;
  if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '% lost SECURITY DEFINER or its search_path', f;
  end if;
  if not has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
    raise exception '% lost a client grant', f;
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261007234500', 'waiver_popup_current_only')
on conflict (version) do nothing;

commit;
