-- ============================================================================
-- The first emergency contact is required of every customer (the owner, 2026-10-07: "make the emergency
-- contact obligatory only the first one not the second and unskippable for all the customers and force
-- them even add it in the sign up page and all forms currently available"). The second contact
-- (20261007150000) stays optional. Runs AFTER 20261007150000.
--
--  1. _customer_asks asks 'emergency' of every account without a first contact. That one rule makes
--     the booking app's check-up open at sign-in with no way past it but Log out (customer_fix_fields),
--     and customer_create_booking refuse the account's bookings meanwhile (FIX_FIRST), as for the
--     other asks. Staff adds and walk-ins are not refused (staff insert their rows themselves).
--     Patched in place, like the two below.
--  2. customer_fix_save: "I don't have one" no longer clears the first contact (patched in place).
--  3. customer_set_emergency: a blank save clears the first contact only when a second moves up into
--     its place (20261007150000); otherwise it is refused, detail 'em_required' (patched in place).
--
-- Rollback: run the three patches backwards (each replacement back to its anchor).
-- Idempotent (each patch is skipped when its function already carries '(20261007235800)').
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

do $pre$
begin
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261007150000') then
    raise exception 'run 20261007150000_second_emergency_contact first';
  end if;
end $pre$;


-- ── 1. every account without a first emergency contact is asked for one ──────────────────────
-- Patched in place from the live definition (pg_get_functiondef keeps SECURITY DEFINER and the search_path), so
-- what other migrations added stays (20261007200000's WhatsApp ask among them, whichever runs first).
do $asks$
declare d text;
begin
  d := pg_get_functiondef('public._customer_asks(text)'::regprocedure);
  if position('(20261007235800)' in d) > 0 then
    raise notice '_customer_asks already asks the emergency contact; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  return f;
end$a$,
$b$  -- The first emergency contact, of every account (20261007235800).
  if coalesce(btrim(c.emergency_phone),'') = '' and not ('emergency' = any(f)) then
    f := f || 'emergency'::text;
  end if;
  return f;
end$b$);
  execute d;
end $asks$;
revoke execute on function public._customer_asks(text) from public, anon, authenticated;


-- ── 2. "I don't have one" is not an answer for the first contact ─────────────────────────────
do $cfs$
declare d text;
begin
  d := pg_get_functiondef('public.customer_fix_save(text,text,jsonb)'::regprocedure);
  if position('(20261007235800)' in d) > 0 then
    raise notice 'customer_fix_save already keeps the first contact; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$        when 'emergency' then
          update customers set emergency_name = null, emergency_phone = null, emergency_relation = null where id = p_id;$a$,
$b$        when 'emergency' then continue;  -- the first contact is required: never cleared here (20261007235800)$b$);
  execute d;
end $cfs$;


-- ── 3. a blank save keeps the first contact unless the second moves up ───────────────────────
do $cse$
declare d text;
begin
  d := pg_get_functiondef('public.customer_set_emergency(text,text,text,text,text)'::regprocedure);
  if position('(20261007235800)' in d) > 0 then
    raise notice 'customer_set_emergency already refuses a bare clear; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  if v_name is null and v_ph is null and v_rel is null then$a$,
$b$  if v_name is null and v_ph is null and v_rel is null then
    -- the first contact is required: cleared only when a second takes its place (20261007235800)
    if not exists (select 1 from customers x where x.id = p_id and x.emergency2_phone is not null) then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_required';
    end if;$b$);
  execute d;
end $cse$;


-- ── checks ────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._customer_asks(text)',
                           'public.customer_fix_save(text,text,jsonb)',
                           'public.customer_set_emergency(text,text,text,text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public.customer_fix_save(text,text,jsonb)',
                           'public.customer_set_emergency(text,text,text,text,text)'] loop
    if not has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% lost a client grant', f;
    end if;
    if position('(20261007235800)' in pg_get_functiondef(f::regprocedure)) = 0 then
      raise exception 'the % patch did not take', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public._customer_asks(text)', 'execute')
     or has_function_privilege('authenticated', 'public._customer_asks(text)', 'execute') then
    raise exception '_customer_asks must not be callable by clients';
  end if;
  if position('(20261007235800)' in pg_get_functiondef('public._customer_asks(text)'::regprocedure)) = 0 then
    raise exception '_customer_asks does not ask the emergency contact';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261007235800', 'emergency_contact_required')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
