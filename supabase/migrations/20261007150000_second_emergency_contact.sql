-- ============================================================================
-- A second emergency contact (the owner, 2026-10-07: "add a second optional emergency contact field, show
-- it in the customer My Account, and allow the staff to flag it").
--
--  1. customers.emergency2_name / emergency2_phone / emergency2_relation: an optional second person to
--     call, under the first contact's rules (a name of 2 to 80 characters, a mobile number, the same eight
--     relation codes) and the first contact's grants (staff read and edit them under the table's RLS:
--     select + update to authenticated only; anon gets none of them).
--  2. customer_emergency returns both contacts (six columns). Its return type changes, so it is dropped
--     and made again; a client that reads the first three columns reads them as before.
--  3. customer_set_emergency (the first contact) refuses the second contact's number ('em_same', the last
--     nine digits, as 'em_self' compares them), and clearing it moves the second contact up into its
--     place: a second contact never stands alone. Without a second contact that is the clear it was.
--  4. customer_set_emergency2 saves the second contact: all three or none (all blank clears it), under the
--     first contact's rules and words (em_name, em_phone, em_relation, em_self), plus 'em_same' for the
--     first contact's number. Saved on an account that has no first contact, it becomes the first.
--  5. Staff can flag it: 'emergency2' joins customers_fix_fields_known and customer_flags_fields_known (each made
--     again from the names it holds now, so a field another migration added stays) and staff_flag_customer's list
--     (patched in place).
--  6. customer_fix_save answers it (patched in place from its live definition; each anchor must match
--     exactly once, and none touches the 'birth_date' lines the 2026-10-07 bug hunt patches
--     (20261007120000), so the two run in either order):
--     - "I don't have one" (p_values.none) for 'emergency2' clears the second contact;
--     - the first contact ('emergency') is also refused the second contact's number while the second is
--       not asked too; when it is, the pair is judged after the loop, where the second contact is answered
--       (p_values.emergency2 = {name, phone, relation}) under customer_set_emergency2's rules, against the
--       rider's own number and the first contact's as they then stand. A first contact answered with the
--       number a still-asked second contact keeps goes back to what it was and stays asked;
--     - a second contact left alone moves up into the first place, as the two saves above do;
--     - the flag's history (customer_flags.changes) records 'emergency2' as {name, phone, relation},
--       like 'emergency'.
--
-- Not touched: _run_entry_guard (it needs the first contact, which is filled whenever a second is),
-- _customer_asks (it passes every flagged name through), staff_merge_customers and _cact_row (neither
-- names the first contact's columns).
--
-- Rollback (in this order): drop function if exists public.customer_set_emergency2(text, text, text, text, text);
--   drop public.customer_emergency(text, text) and re-run 20261005230000's three-column one and its
--   customer_set_emergency, with their grants; run the customer_fix_save and staff_flag_customer patches
--   backwards (each replacement back to its anchor); once no customers.fix_fields and no
--   customer_flags.fields holds 'emergency2', make the two checks again without it (keep any other name they hold);
--   last, alter table public.customers drop column if exists emergency2_name,
--     drop column if exists emergency2_phone, drop column if exists emergency2_relation;
-- Idempotent (each patch is skipped when its function already carries '(20261007150000)').
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


-- ── 1. the second contact on the account ─────────────────────────────────────────────────────
alter table public.customers add column if not exists emergency2_name text;
alter table public.customers add column if not exists emergency2_phone text;
alter table public.customers add column if not exists emergency2_relation text;
alter table public.customers drop constraint if exists customers_emergency2_name_len;
alter table public.customers add constraint customers_emergency2_name_len
  check (emergency2_name is null or char_length(emergency2_name) between 2 and 80);
alter table public.customers drop constraint if exists customers_emergency2_phone_shape;
alter table public.customers add constraint customers_emergency2_phone_shape
  check (emergency2_phone is null or emergency2_phone ~ '^\+?[0-9]{8,15}$');
alter table public.customers drop constraint if exists customers_emergency2_relation_code;
alter table public.customers add constraint customers_emergency2_relation_code
  check (emergency2_relation is null
         or emergency2_relation in ('spouse', 'parent', 'sibling', 'child', 'relative', 'friend', 'colleague', 'other'));
comment on column public.customers.emergency2_name is
  'A second, optional person to call if the rider needs help at an event; held only beside a first (20261007150000).';
comment on column public.customers.emergency2_phone is
  'The second emergency contact''s mobile number, digits with an optional + (20261007150000).';
comment on column public.customers.emergency2_relation is
  'The second emergency contact to the rider: spouse, parent, sibling, child, relative, friend, colleague or other (20261007150000).';

-- Staff read them on the roster and in the account editor, and correct them there.
grant select (emergency2_name, emergency2_phone, emergency2_relation) on public.customers to authenticated;
grant update (emergency2_name, emergency2_phone, emergency2_relation) on public.customers to authenticated;


-- ── 2. the rider reads both contacts ─────────────────────────────────────────────────────────
drop function if exists public.customer_emergency(text, text);
create function public.customer_emergency(p_id text, p_token text)
 returns table(emergency_name text, emergency_phone text, emergency_relation text,
               emergency2_name text, emergency2_phone text, emergency2_relation text)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not _cust_token_ok(p_id, p_token) then return; end if;
  return query select c.emergency_name, c.emergency_phone, c.emergency_relation,
                      c.emergency2_name, c.emergency2_phone, c.emergency2_relation
                 from customers c where c.id = p_id;
end $function$;
revoke execute on function public.customer_emergency(text, text) from public;
grant  execute on function public.customer_emergency(text, text) to anon, authenticated;


-- ── 3. the first contact: not the second's number; cleared, the second moves up ──────────────
create or replace function public.customer_set_emergency(p_id text, p_token text, p_name text, p_phone text, p_relation text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_name text := nullif(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
  v_ph   text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
  v_rel  text := nullif(lower(btrim(coalesce(p_relation, ''))), '');
  v_own  text;
  v_two  text;
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if v_name is null and v_ph is null and v_rel is null then
    -- the second contact moves up into the first place, so it never stands alone; without a second
    -- contact this clears the first, as it always did (20261007150000)
    update customers set emergency_name = emergency2_name, emergency_phone = emergency2_phone,
                         emergency_relation = emergency2_relation,
                         emergency2_name = null, emergency2_phone = null, emergency2_relation = null
     where id = p_id;
    return found;
  end if;
  if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 80
     or not _name_chars_ok(v_name) or not _name_parts_ok(v_name) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_name';
  end if;
  if v_ph is null or v_ph !~ '^\+?[0-9]{8,15}$' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_phone';
  end if;
  if v_rel is null or v_rel not in ('spouse', 'parent', 'sibling', 'child', 'relative', 'friend', 'colleague', 'other') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_relation';
  end if;
  select regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), regexp_replace(coalesce(c.emergency2_phone, ''), '\D', '', 'g')
    into v_own, v_two from customers c where c.id = p_id;
  -- someone else's number: the rider's own phone cannot be who we call when the rider needs help
  if v_own <> '' and right(regexp_replace(v_ph, '\D', '', 'g'), 9) = right(v_own, 9) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_self';
  end if;
  -- and not the second contact's: two contacts are two people (20261007150000)
  if v_two <> '' and right(regexp_replace(v_ph, '\D', '', 'g'), 9) = right(v_two, 9) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_same';
  end if;
  update customers set emergency_name = v_name, emergency_phone = v_ph, emergency_relation = v_rel where id = p_id;
  return found;
end $function$;
revoke execute on function public.customer_set_emergency(text, text, text, text, text) from public;
grant  execute on function public.customer_set_emergency(text, text, text, text, text) to anon, authenticated;


-- ── 4. the second contact: all three or none ─────────────────────────────────────────────────
create or replace function public.customer_set_emergency2(p_id text, p_token text, p_name text, p_phone text, p_relation text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_name text := nullif(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
  v_ph   text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
  v_rel  text := nullif(lower(btrim(coalesce(p_relation, ''))), '');
  v_own  text;
  v_one  text;
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if v_name is null and v_ph is null and v_rel is null then
    update customers set emergency2_name = null, emergency2_phone = null, emergency2_relation = null where id = p_id;
    return found;
  end if;
  if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 80
     or not _name_chars_ok(v_name) or not _name_parts_ok(v_name) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_name';
  end if;
  if v_ph is null or v_ph !~ '^\+?[0-9]{8,15}$' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_phone';
  end if;
  if v_rel is null or v_rel not in ('spouse', 'parent', 'sibling', 'child', 'relative', 'friend', 'colleague', 'other') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_relation';
  end if;
  select regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), regexp_replace(coalesce(c.emergency_phone, ''), '\D', '', 'g')
    into v_own, v_one from customers c where c.id = p_id;
  -- not the rider's own number, and not the first contact's: two contacts are two people
  if v_own <> '' and right(regexp_replace(v_ph, '\D', '', 'g'), 9) = right(v_own, 9) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_self';
  end if;
  if v_one <> '' and right(regexp_replace(v_ph, '\D', '', 'g'), 9) = right(v_one, 9) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_same';
  end if;
  update customers set emergency2_name = v_name, emergency2_phone = v_ph, emergency2_relation = v_rel where id = p_id;
  if not found then return false; end if;
  -- on an account without a first contact it becomes the first: a second contact never stands alone
  update customers set emergency_name = emergency2_name, emergency_phone = emergency2_phone,
                       emergency_relation = emergency2_relation,
                       emergency2_name = null, emergency2_phone = null, emergency2_relation = null
   where id = p_id and emergency_name is null and emergency2_name is not null;
  return true;
end $function$;
revoke execute on function public.customer_set_emergency2(text, text, text, text, text) from public;
grant  execute on function public.customer_set_emergency2(text, text, text, text, text) to anon, authenticated;


-- ── 5. staff can flag it ─────────────────────────────────────────────────────────────────────
-- Both checks are made again from the names they hold NOW plus 'emergency2', never from a written list: another
-- migration of the same day adds a field of its own ('whatsapp', 20261007200000) the same way, so the two keep
-- each other's name whichever runs first. Skipped when 'emergency2' is already there.
do $known$
declare
  d text;
  names text[];
begin
  select pg_get_constraintdef(oid) into d from pg_constraint
   where conname = 'customers_fix_fields_known' and conrelid = 'public.customers'::regclass;
  names := array(select m[1] from regexp_matches(coalesce(d, ''), '''([a-z0-9_]+)''', 'g') m);
  if cardinality(names) < 19 then raise exception 'customers_fix_fields_known is missing or unreadable: %', d; end if;
  if not ('emergency2' = any(names)) then
    alter table public.customers drop constraint customers_fix_fields_known;
    execute format('alter table public.customers add constraint customers_fix_fields_known check ('
                   'fix_fields is null or fix_fields <@ array[%s]::text[])',
                   (select string_agg(quote_literal(n), ',' order by o)
                      from unnest(array_append(names, 'emergency2')) with ordinality u(n, o)));
  end if;

  select pg_get_constraintdef(oid) into d from pg_constraint
   where conname = 'customer_flags_fields_known' and conrelid = 'public.customer_flags'::regclass;
  names := array(select m[1] from regexp_matches(coalesce(d, ''), '''([a-z0-9_]+)''', 'g') m);
  if cardinality(names) < 19 then raise exception 'customer_flags_fields_known is missing or unreadable: %', d; end if;
  if not ('emergency2' = any(names)) then
    alter table public.customer_flags drop constraint customer_flags_fields_known;
    execute format('alter table public.customer_flags add constraint customer_flags_fields_known check ('
                   'cardinality(fields) > 0 and fields <@ array[%s]::text[])',
                   (select string_agg(quote_literal(n), ',' order by o)
                      from unnest(array_append(names, 'emergency2')) with ordinality u(n, o)));
  end if;
end $known$;

-- staff_flag_customer keeps only the names it knows (patched from its live definition)
do $sfc$
declare d text;
begin
  d := pg_get_functiondef('public.staff_flag_customer(text,text[],text)'::regprocedure);
  if position('(20261007150000)' in d) > 0 then
    raise notice 'staff_flag_customer already keeps emergency2; nothing to do';
    return;
  end if;
  execute pg_temp._once(d,
$a$'linkedin','emergency'])$a$,
$b$'linkedin','emergency','emergency2'])  -- the second emergency contact too (20261007150000)$b$);
end $sfc$;


-- ── 6. customer_fix_save answers it (patched from its live definition) ───────────────────────
do $cfs$
declare d text;
begin
  d := pg_get_functiondef('public.customer_fix_save(text,text,jsonb)'::regprocedure);
  if position('(20261007150000)' in d) > 0 then
    raise notice 'customer_fix_save already answers the second emergency contact; nothing to do';
    return;
  end if;

  -- "I don't have one" clears the second contact
  d := pg_temp._once(d,
$a$          update customers set emergency_name = null, emergency_phone = null, emergency_relation = null where id = p_id;
        else continue;$a$,
$b$          update customers set emergency_name = null, emergency_phone = null, emergency_relation = null where id = p_id;
        when 'emergency2' then  -- the second emergency contact (20261007150000)
          update customers set emergency2_name = null, emergency2_phone = null, emergency2_relation = null where id = p_id;
        else continue;$b$);

  -- the first contact is not the second contact's number
  d := pg_temp._once(d,
$a$      update customers set emergency_name = em_name, emergency_phone = em_ph, emergency_relation = em_rel where id = p_id;$a$,
$b$      -- nor the second contact's number, while that one is not asked too; when it is, the pair is judged
      -- after this loop, where the second contact is answered (20261007150000)
      if not ('emergency2' = any(flags)) and coalesce(c.emergency2_phone,'') <> ''
         and right(regexp_replace(em_ph, '\D', '', 'g'), 9) = right(regexp_replace(c.emergency2_phone, '\D', '', 'g'), 9) then
        continue;
      end if;
      update customers set emergency_name = em_name, emergency_phone = em_ph, emergency_relation = em_rel where id = p_id;$b$);

  -- the second contact, once the loop is done
  d := pg_temp._once(d,
$a$  stored := array(select f from unnest(stored) f where f <> all(done));$a$,
$b$  -- The second emergency contact (20261007150000): one answer of three parts, under
  -- customer_set_emergency2's rules, against the rider's own number and the first contact's as they
  -- stand now (the loop may just have changed either). "I don't have one" cleared it above.
  if 'emergency2' = any(flags) and not ('emergency2' = any(done)) and jsonb_typeof(p_values->'emergency2') = 'object' then
    declare
      e2      jsonb := p_values->'emergency2';
      e2_name text := nullif(regexp_replace(btrim(coalesce(e2->>'name','')), '\s+', ' ', 'g'), '');
      e2_ph   text := nullif(regexp_replace(coalesce(e2->>'phone',''), '[^0-9+]', '', 'g'), '');
      e2_rel  text := nullif(lower(btrim(coalesce(e2->>'relation',''))), '');
      e2_own  text;
      e2_one  text;
    begin
      select regexp_replace(coalesce(x.phone,''), '\D', '', 'g'), regexp_replace(coalesce(x.emergency_phone,''), '\D', '', 'g')
        into e2_own, e2_one from customers x where x.id = p_id;
      if e2_name is not null and char_length(e2_name) between 2 and 80
         and _name_chars_ok(e2_name) and _name_parts_ok(e2_name)
         and coalesce(e2_ph ~ '^\+?[0-9]{8,15}$', false)
         and coalesce(e2_rel in ('spouse','parent','sibling','child','relative','friend','colleague','other'), false)
         and (e2_own = '' or right(regexp_replace(e2_ph, '\D', '', 'g'), 9) <> right(e2_own, 9))
         and (e2_one = '' or right(regexp_replace(e2_ph, '\D', '', 'g'), 9) <> right(e2_one, 9)) then
        update customers set emergency2_name = e2_name, emergency2_phone = e2_ph, emergency2_relation = e2_rel where id = p_id;
        done := array_append(done, 'emergency2');
      end if;
    end;
  end if;
  -- A first contact just answered with the number a still-asked second contact keeps goes back to what
  -- it was and stays asked: two contacts are two people.
  if 'emergency' = any(done) and 'emergency2' = any(flags) and not ('emergency2' = any(done))
     and exists (select 1 from customers x
                  where x.id = p_id and coalesce(x.emergency_phone,'') <> '' and coalesce(x.emergency2_phone,'') <> ''
                    and right(regexp_replace(x.emergency_phone, '\D', '', 'g'), 9)
                        = right(regexp_replace(x.emergency2_phone, '\D', '', 'g'), 9)) then
    update customers set emergency_name = c.emergency_name, emergency_phone = c.emergency_phone,
                         emergency_relation = c.emergency_relation where id = p_id;
    done := array_remove(done, 'emergency');
  end if;
  -- A second contact never stands alone: without a first, it moves up into the first place.
  update customers set emergency_name = emergency2_name, emergency_phone = emergency2_phone,
                       emergency_relation = emergency2_relation,
                       emergency2_name = null, emergency2_phone = null, emergency2_relation = null
   where id = p_id and emergency_name is null and emergency2_name is not null;

  stored := array(select f from unnest(stored) f where f <> all(done));$b$);

  -- the flag's history: the second contact as {name, phone, relation}, before and after
  d := pg_temp._once(d,
$a$                             else jsonb_build_object('name', c.emergency_name, 'phone', c.emergency_phone, 'relation', c.emergency_relation) end$a$,
$b$                             else jsonb_build_object('name', c.emergency_name, 'phone', c.emergency_phone, 'relation', c.emergency_relation) end
                           when k2 = 'emergency2' then case when c.emergency2_name is null then null  -- (20261007150000)
                             else jsonb_build_object('name', c.emergency2_name, 'phone', c.emergency2_phone, 'relation', c.emergency2_relation) end$b$);
  d := pg_temp._once(d,
$a$                             else jsonb_build_object('name', n.emergency_name, 'phone', n.emergency_phone, 'relation', n.emergency_relation) end$a$,
$b$                             else jsonb_build_object('name', n.emergency_name, 'phone', n.emergency_phone, 'relation', n.emergency_relation) end
                           when k2 = 'emergency2' then case when n.emergency2_name is null then null
                             else jsonb_build_object('name', n.emergency2_name, 'phone', n.emergency2_phone, 'relation', n.emergency2_relation) end$b$);

  execute d;
end $cfs$;


-- ── checks ────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare
  f text;
  d text;
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'customers'
         and column_name in ('emergency2_name', 'emergency2_phone', 'emergency2_relation')) <> 3 then
    raise exception 'a second emergency contact column is missing';
  end if;
  if (select count(*) from pg_constraint
       where conrelid = 'public.customers'::regclass
         and conname in ('customers_emergency2_name_len', 'customers_emergency2_phone_shape', 'customers_emergency2_relation_code')) <> 3 then
    raise exception 'a second emergency contact check is missing';
  end if;
  foreach f in array array['public.customer_emergency(text,text)',
                           'public.customer_set_emergency(text,text,text,text,text)',
                           'public.customer_set_emergency2(text,text,text,text,text)',
                           'public.customer_fix_save(text,text,jsonb)',
                           'public.staff_flag_customer(text,text[],text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if (select count(*) from pg_proc p, unnest(p.proargmodes) m
       where p.oid = 'public.customer_emergency(text,text)'::regprocedure and m = 't') <> 6 then
    raise exception 'customer_emergency does not return both contacts';
  end if;
  foreach f in array array['public.customer_emergency(text,text)',
                           'public.customer_set_emergency(text,text,text,text,text)',
                           'public.customer_set_emergency2(text,text,text,text,text)',
                           'public.customer_fix_save(text,text,jsonb)'] loop
    if not has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% lost a client grant', f;
    end if;
  end loop;
  if position('(20261007150000)' in pg_get_functiondef('public.customer_fix_save(text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'the customer_fix_save patch did not take';
  end if;
  if position('''emergency2''' in pg_get_functiondef('public.staff_flag_customer(text,text[],text)'::regprocedure)) = 0 then
    raise exception 'staff_flag_customer does not keep emergency2';
  end if;
  select pg_get_constraintdef(oid) into d from pg_constraint
   where conname = 'customers_fix_fields_known' and conrelid = 'public.customers'::regclass;
  if d is null or position('''emergency2''' in d) = 0 then raise exception 'customers_fix_fields_known lacks emergency2'; end if;
  select pg_get_constraintdef(oid) into d from pg_constraint
   where conname = 'customer_flags_fields_known' and conrelid = 'public.customer_flags'::regclass;
  if d is null or position('''emergency2''' in d) = 0 then raise exception 'customer_flags_fields_known lacks emergency2'; end if;
  if not has_column_privilege('authenticated', 'public.customers', 'emergency2_phone', 'select')
     or not has_column_privilege('authenticated', 'public.customers', 'emergency2_phone', 'update')
     or has_column_privilege('anon', 'public.customers', 'emergency2_phone', 'select') then
    raise exception 'the second emergency contact columns carry the wrong grants';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261007150000', 'second_emergency_contact')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
