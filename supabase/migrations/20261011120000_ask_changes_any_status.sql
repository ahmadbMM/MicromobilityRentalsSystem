-- ============================================================================
-- Ask for changes on every application, whatever its status (the owner, 2026-10-11: "add the option to
-- ask for changes in all applications even if they were invited or completed etc. wherever they were").
--
--  Until now staff could ask only a pending community applicant (and a New or Scheduled learn-to-ride
--  sign-up); staff_*_ask_changes answered 'decided' otherwise, and the applicant's form link
--  (community_fix_get / _submit, learn_fix_get / _submit) answered 'gone' once the application had moved
--  on. Every status is now allowed on both sides: approved (invited, completed, didn't show), rejected,
--  scheduled, done, cancelled. The answer still reaches a linked account through
--  _community_app_to_account / _learn_app_to_account, as it already did. A link already answered still
--  says 'done'; asking again issues a new link.
--  Patched in place from the live definitions.
--
-- Rollback: replace each patched line below back to its anchor.
-- Idempotent (skipped when a function already carries '(20261011120000)').
-- Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

do $ask$
declare fn text; d text;
begin
  foreach fn in array array['public.staff_community_ask_changes(uuid,text[],text,text)',
                            'public.staff_learn_ask_changes(uuid,text[],text,text)'] loop
    d := pg_get_functiondef(fn::regprocedure);
    if position('(20261011120000)' in d) > 0 then
      raise notice '% already asks at any status; nothing to do', fn;
      continue;
    end if;
    if fn like '%community%' then
      d := pg_temp._once(d,
$a$  if a.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'decided', 'status', a.status); end if;$a$,
$b$  -- any status may be asked (20261011120000)$b$);
    else
      d := pg_temp._once(d,
$a$  if a.status not in ('pending', 'scheduled') then return jsonb_build_object('ok', false, 'error', 'decided', 'status', a.status); end if;$a$,
$b$  -- any status may be asked (20261011120000)$b$);
    end if;
    execute d;
  end loop;
end $ask$;

do $form$
declare fn text; d text;
begin
  foreach fn in array array['public.community_fix_get(text)', 'public.community_fix_submit(text,jsonb)',
                            'public.learn_fix_get(text)', 'public.learn_fix_submit(text,jsonb)'] loop
    d := pg_get_functiondef(fn::regprocedure);
    if position('(20261011120000)' in d) > 0 then
      raise notice '% already answers at any status; nothing to do', fn;
      continue;
    end if;
    if fn like '%community%' then
      d := pg_temp._once(d,
$a$  if a.id is null or a.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'gone'); end if;$a$,
$b$  if a.id is null then return jsonb_build_object('ok', false, 'error', 'gone'); end if;  -- any status (20261011120000)$b$);
    else
      d := pg_temp._once(d,
$a$  if a.id is null or a.status not in ('pending', 'scheduled') then return jsonb_build_object('ok', false, 'error', 'gone'); end if;$a$,
$b$  if a.id is null then return jsonb_build_object('ok', false, 'error', 'gone'); end if;  -- any status (20261011120000)$b$);
    end if;
    execute d;
  end loop;
end $form$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261011120000', 'ask_changes_any_status')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- Check (read-only), after:
--   select p.proname, p.prosecdef, position('(20261011120000)' in pg_get_functiondef(p.oid)) > 0 patched
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname in ('staff_community_ask_changes','staff_learn_ask_changes',
--          'community_fix_get','community_fix_submit','learn_fix_get','learn_fix_submit');   -- t, t six times
