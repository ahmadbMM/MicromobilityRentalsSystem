-- ============================================================================
-- The emergency contact on the Petromin employee form (the owner, 2026-10-07: "make the emergency
-- contact obligatory only the first one not the second and unskippable for all the customers ... and all
-- forms currently available").
--
--  1. rider_registrations.emergency_name / emergency_phone / emergency_relation and emergency2_*: one
--     pair for the whole booking, written on every row of the party (same booking_no and session), under
--     the customers' rules (a name of 2 to 80 characters, a mobile number '^\+?[0-9]{8,15}$', the eight
--     relation codes) and a second contact never without a first. Grants are the table's own: staff
--     (authenticated, under the "staff read"/"staff update" RLS policies) read and correct them through
--     the table-level grants they already have; anon has no grant on the table and gets none here.
--  2. rider_register takes p_emergency jsonb default null = {name, phone, relation, name2, phone2,
--     relation2} as a new last parameter (patched from its live definition; its signature changes, so the
--     old one is dropped and execute granted as it was: anon, authenticated, service_role).
--     - Required on every registration that is not the desk's (is_staff(): the desk's walk-in sends
--       p_source 'petromin' like the form, so the source cannot tell them apart), except an edit that
--       rider_edit has proved (mm.rider_proved) and that sends none: refused with BAD_INPUT, 22023,
--       detail 'em_required'.
--     - Checked as customer_set_emergency / customer_set_emergency2 check theirs (detail em_name,
--       em_phone, em_relation, em_self, em_same; hint 'second' for the second contact). A dash in a name
--       becomes a space, as in the rider's own name; the desk is exempt from the two-word and the
--       two-letters-a-word rules, as for riders' names.
--     - Not sent (the desk, a proved edit): the booking keeps the pair it has; new companion rows take it.
--     - The answer carries 'emergency' (the pair the booking now holds) for the form's edit.
--  3. rider_edit takes p_emergency jsonb default null as a new last parameter and passes it on (null keeps
--     the stored pair); signature changes, old one dropped, grants as they were.
--  4. rider_party_add (the desk adding companions) copies the employee row's pair onto the new rows.
--
-- The form (mm-platform forms/petromin) sends p_emergency since 2026-10-07 and calls once more without it
-- on PGRST202, so it works before and after this migration. A form page loaded BEFORE that form deploy
-- sends no p_emergency and is refused (em_required) once this runs: deploy the form first.
--
-- Not touched: _cact_row (it names no emergency column), the rider_registration_guard trigger, staff's
-- Riders tab (select('*') on rider_registrations simply receives six more columns).
--
-- Rollback (in this order): re-create public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text) and public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text) from the definitions saved before this
--   ran (their prosrc md5 a9424f5ad6a2544a89c2a7d02e55c37c / 1912e58af57a215bf10227fb3f37b12d) with
--   execute to anon, authenticated, service_role; drop function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,jsonb); drop function public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,jsonb);
--   run the rider_party_add patch backwards; then alter table public.rider_registrations drop column
--   emergency_name, ... emergency2_relation (the constraints go with them).
-- Idempotent: each patch is skipped when its function already carries '(20261007235900)'.
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


-- ── 1. the columns ────────────────────────────────────────────────────────────────────────────
alter table public.rider_registrations add column if not exists emergency_name text;
alter table public.rider_registrations add column if not exists emergency_phone text;
alter table public.rider_registrations add column if not exists emergency_relation text;
alter table public.rider_registrations add column if not exists emergency2_name text;
alter table public.rider_registrations add column if not exists emergency2_phone text;
alter table public.rider_registrations add column if not exists emergency2_relation text;
alter table public.rider_registrations drop constraint if exists rider_registrations_emergency_name_len;
alter table public.rider_registrations add constraint rider_registrations_emergency_name_len
  check (emergency_name is null or char_length(emergency_name) between 2 and 80);
alter table public.rider_registrations drop constraint if exists rider_registrations_emergency_phone_shape;
alter table public.rider_registrations add constraint rider_registrations_emergency_phone_shape
  check (emergency_phone is null or emergency_phone ~ '^\+?[0-9]{8,15}$');
alter table public.rider_registrations drop constraint if exists rider_registrations_emergency_relation_code;
alter table public.rider_registrations add constraint rider_registrations_emergency_relation_code
  check (emergency_relation is null or emergency_relation in ('spouse', 'parent', 'sibling', 'child', 'relative', 'friend', 'colleague', 'other'));
alter table public.rider_registrations drop constraint if exists rider_registrations_emergency2_name_len;
alter table public.rider_registrations add constraint rider_registrations_emergency2_name_len
  check (emergency2_name is null or char_length(emergency2_name) between 2 and 80);
alter table public.rider_registrations drop constraint if exists rider_registrations_emergency2_phone_shape;
alter table public.rider_registrations add constraint rider_registrations_emergency2_phone_shape
  check (emergency2_phone is null or emergency2_phone ~ '^\+?[0-9]{8,15}$');
alter table public.rider_registrations drop constraint if exists rider_registrations_emergency2_relation_code;
alter table public.rider_registrations add constraint rider_registrations_emergency2_relation_code
  check (emergency2_relation is null or emergency2_relation in ('spouse', 'parent', 'sibling', 'child', 'relative', 'friend', 'colleague', 'other'));
alter table public.rider_registrations drop constraint if exists rider_registrations_emergency2_needs_first;
alter table public.rider_registrations add constraint rider_registrations_emergency2_needs_first
  check (emergency2_name is null or emergency_name is not null);
comment on column public.rider_registrations.emergency_name is
  'Who to call if a rider on this booking needs help; one pair per booking, on every row of the party (20261007235900).';
comment on column public.rider_registrations.emergency_phone is
  'The emergency contact''s mobile number, digits with an optional + (20261007235900).';
comment on column public.rider_registrations.emergency_relation is
  'The emergency contact to the employee: spouse, parent, sibling, child, relative, friend, colleague or other (20261007235900).';
comment on column public.rider_registrations.emergency2_name is
  'An optional second emergency contact, held only beside a first (20261007235900).';
comment on column public.rider_registrations.emergency2_phone is
  'The second emergency contact''s mobile number (20261007235900).';
comment on column public.rider_registrations.emergency2_relation is
  'The second emergency contact to the employee, the same eight codes (20261007235900).';


-- ── 2. rider_register takes p_emergency (patched from its live definition) ─────────────────────
do $reg$
declare d text;
begin
  if to_regprocedure('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,jsonb)') is not null
     and position('(20261007235900)' in pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,jsonb)'::regprocedure)) > 0 then
    raise notice 'rider_register already takes p_emergency; nothing to do';
    return;
  end if;
  d := pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)'::regprocedure);

  -- signature
  d := pg_temp._once(d,
$a$p_privacy text DEFAULT NULL::text)
 RETURNS jsonb$a$,
$b$p_privacy text DEFAULT NULL::text, p_emergency jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb$b$);

  -- declare
  d := pg_temp._once(d,
$a$  v_staff boolean := is_staff(); v_prev rider_registrations%rowtype;
begin
$a$,
$b$  v_staff boolean := is_staff(); v_prev rider_registrations%rowtype;
  -- the emergency contact pair for the whole booking (20261007235900)
  v_em jsonb; v_em_set boolean := false;
  v_em_name text; v_em_phone text; v_em_rel text; v_em2_name text; v_em2_phone text; v_em2_rel text;
begin
$b$);

  -- validate
  d := pg_temp._once(d,
$a$  if v_sess.id is not null and v_last9 is not null then
$a$,
$b$  -- The emergency contact (20261007235900): p_emergency = {name, phone, relation, name2, phone2, relation2},
  -- one pair for the whole booking. The first contact is required on every registration that is not the
  -- desk's, except an edit proved by rider_edit that sends none (the stored pair stays). The second is all
  -- three or none. Neither is the rider's own number, and the second is not the first's. The words are
  -- customer_set_emergency's (BAD_INPUT, 22023, detail em_*); hint 'second' names the second contact.
  v_em := case when jsonb_typeof(p_emergency) = 'object' then p_emergency end;
  if v_em is not null then
    v_em_name  := nullif(regexp_replace(trim(regexp_replace(coalesce(v_em->>'name',''), '[-\u058a\u05be\u1400\u1806\u2010-\u2015\u2212\u2e17\u2e1a\u2e3a\u2e3b\u2e40\u301c\u3030\u30a0\ufe31\ufe32\ufe58\ufe63\uff0d]', ' ', 'g')), '\s+', ' ', 'g'), '');
    v_em_phone := nullif(regexp_replace(coalesce(v_em->>'phone',''), '[^0-9+]', '', 'g'), '');
    v_em_rel   := nullif(lower(trim(coalesce(v_em->>'relation',''))), '');
    v_em2_name  := nullif(regexp_replace(trim(regexp_replace(coalesce(v_em->>'name2',''), '[-\u058a\u05be\u1400\u1806\u2010-\u2015\u2212\u2e17\u2e1a\u2e3a\u2e3b\u2e40\u301c\u3030\u30a0\ufe31\ufe32\ufe58\ufe63\uff0d]', ' ', 'g')), '\s+', ' ', 'g'), '');
    v_em2_phone := nullif(regexp_replace(coalesce(v_em->>'phone2',''), '[^0-9+]', '', 'g'), '');
    v_em2_rel   := nullif(lower(trim(coalesce(v_em->>'relation2',''))), '');
    if v_em_name is null and v_em_phone is null and v_em_rel is null then
      -- no first contact: refused, unless the desk is clearing it (a second never stands alone)
      if not v_staff or v_em2_name is not null or v_em2_phone is not null or v_em2_rel is not null then
        raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_required';
      end if;
    else
      if v_em_name is null or char_length(v_em_name) not between 2 and 80 or not _name_chars_ok(v_em_name)
         or (not v_staff and (v_em_name !~ '\s' or not _name_parts_ok(v_em_name))) then
        raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_name';
      end if;
      if v_em_phone is null or v_em_phone !~ '^\+?[0-9]{8,15}$' then
        raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_phone';
      end if;
      if v_em_rel is null or v_em_rel not in ('spouse', 'parent', 'sibling', 'child', 'relative', 'friend', 'colleague', 'other') then
        raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_relation';
      end if;
      -- not the rider's own number (the last nine digits, as everywhere else)
      if v_last9 is not null and right(regexp_replace(v_em_phone, '\D', '', 'g'), 9) = v_last9 then
        raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_self';
      end if;
    end if;
    if v_em2_name is not null or v_em2_phone is not null or v_em2_rel is not null then
      if v_em2_name is null or char_length(v_em2_name) not between 2 and 80 or not _name_chars_ok(v_em2_name)
         or (not v_staff and (v_em2_name !~ '\s' or not _name_parts_ok(v_em2_name))) then
        raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_name', hint = 'second';
      end if;
      if v_em2_phone is null or v_em2_phone !~ '^\+?[0-9]{8,15}$' then
        raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_phone', hint = 'second';
      end if;
      if v_em2_rel is null or v_em2_rel not in ('spouse', 'parent', 'sibling', 'child', 'relative', 'friend', 'colleague', 'other') then
        raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_relation', hint = 'second';
      end if;
      -- not the rider's own number (the last nine digits, as everywhere else)
      if v_last9 is not null and right(regexp_replace(v_em2_phone, '\D', '', 'g'), 9) = v_last9 then
        raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_self', hint = 'second';
      end if;
      if right(regexp_replace(v_em2_phone, '\D', '', 'g'), 9) = right(regexp_replace(v_em_phone, '\D', '', 'g'), 9) then
        raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_same', hint = 'second';
      end if;
    end if;
    v_em_set := true;
  elsif not v_staff and nullif(current_setting('mm.rider_proved', true), '') is null then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_required';
  end if;

  if v_sess.id is not null and v_last9 is not null then
$b$);

  -- keep
  d := pg_temp._once(d,
$a$  v_bno := v_prev.booking_no;
  if v_bno is null then
$a$,
$b$  -- No contact sent (the desk, or an edit that leaves it alone): the booking keeps the pair it has (20261007235900).
  if not v_em_set and v_prev.id is not null then
    v_em_name := v_prev.emergency_name; v_em_phone := v_prev.emergency_phone; v_em_rel := v_prev.emergency_relation;
    v_em2_name := v_prev.emergency2_name; v_em2_phone := v_prev.emergency2_phone; v_em2_rel := v_prev.emergency2_relation;
  end if;
  v_bno := v_prev.booking_no;
  if v_bno is null then
$b$);

  -- main insert
  d := pg_temp._once(d,
$a$privacy_at)
  values (v_badge, v_name, v_phone, p_height, v_type, v_entry.id, v_cust_id, v_kind, v_src, v_sess.id, v_company, v_bno, 1, p_waiver, case when p_waiver is not null then now() end, p_privacy, case when p_privacy is not null then now() end)
$a$,
$b$privacy_at, emergency_name, emergency_phone, emergency_relation, emergency2_name, emergency2_phone, emergency2_relation)
  values (v_badge, v_name, v_phone, p_height, v_type, v_entry.id, v_cust_id, v_kind, v_src, v_sess.id, v_company, v_bno, 1, p_waiver, case when p_waiver is not null then now() end, p_privacy, case when p_privacy is not null then now() end, v_em_name, v_em_phone, v_em_rel, v_em2_name, v_em2_phone, v_em2_rel)
$b$);

  -- main update
  d := pg_temp._once(d,
$a$        privacy_at = coalesce(excluded.privacy_at, rider_registrations.privacy_at),
        submissions = rider_registrations.submissions + 1, updated_at = now()
  returning id$a$,
$b$        privacy_at = coalesce(excluded.privacy_at, rider_registrations.privacy_at),
        emergency_name = excluded.emergency_name,
        emergency_phone = excluded.emergency_phone,
        emergency_relation = excluded.emergency_relation,
        emergency2_name = excluded.emergency2_name,
        emergency2_phone = excluded.emergency2_phone,
        emergency2_relation = excluded.emergency2_relation,
        submissions = rider_registrations.submissions + 1, updated_at = now()
  returning id$b$);

  -- companion insert
  d := pg_temp._once(d,
$a$privacy_at)
    values (v_badge, v_cname, null, v_ch, v_ctype, null, null, 'none', v_src, v_sess.id, v_company, v_bno, v_i + 2, p_waiver, case when p_waiver is not null then now() end, p_privacy, case when p_privacy is not null then now() end)
$a$,
$b$privacy_at, emergency_name, emergency_phone, emergency_relation, emergency2_name, emergency2_phone, emergency2_relation)
    values (v_badge, v_cname, null, v_ch, v_ctype, null, null, 'none', v_src, v_sess.id, v_company, v_bno, v_i + 2, p_waiver, case when p_waiver is not null then now() end, p_privacy, case when p_privacy is not null then now() end, v_em_name, v_em_phone, v_em_rel, v_em2_name, v_em2_phone, v_em2_rel)
$b$);

  -- companion update
  d := pg_temp._once(d,
$a$        privacy_at = coalesce(excluded.privacy_at, rider_registrations.privacy_at),
          submissions = rider_registrations.submissions + 1, updated_at = now();
$a$,
$b$        privacy_at = coalesce(excluded.privacy_at, rider_registrations.privacy_at),
          emergency_name = excluded.emergency_name,
          emergency_phone = excluded.emergency_phone,
          emergency_relation = excluded.emergency_relation,
          emergency2_name = excluded.emergency2_name,
          emergency2_phone = excluded.emergency2_phone,
          emergency2_relation = excluded.emergency2_relation,
          submissions = rider_registrations.submissions + 1, updated_at = now();
$b$);

  -- return
  d := pg_temp._once(d,
$a$    'ok', true, 'resubmitted', v_n > 1, 'booking_no', v_bno, 'riders', v_n_extra + 1,
$a$,
$b$    'ok', true, 'resubmitted', v_n > 1, 'booking_no', v_bno, 'riders', v_n_extra + 1,
    -- the pair this booking now holds, for the form's edit: what it sent, or (a proved edit) what it kept (20261007235900)
    'emergency', case when v_em_name is not null then jsonb_strip_nulls(jsonb_build_object('name', v_em_name, 'phone', v_em_phone,
        'relation', v_em_rel, 'name2', v_em2_name, 'phone2', v_em2_phone, 'relation2', v_em2_rel)) end,
$b$);

  execute d;
  drop function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text);
end $reg$;
revoke execute on function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,jsonb) from public;
grant  execute on function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,jsonb) to anon, authenticated, service_role;


-- ── 3. rider_edit takes p_emergency and passes it on ─────────────────────────────────────────
do $edit$
declare d text;
begin
  if to_regprocedure('public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,jsonb)') is not null
     and position('(20261007235900)' in pg_get_functiondef('public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,jsonb)'::regprocedure)) > 0 then
    raise notice 'rider_edit already takes p_emergency; nothing to do';
    return;
  end if;
  d := pg_get_functiondef('public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text)'::regprocedure);

  -- signature
  d := pg_temp._once(d,
$a$p_waiver text DEFAULT NULL::text)
 RETURNS jsonb$a$,
$b$p_waiver text DEFAULT NULL::text, p_emergency jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb$b$);

  -- call
  d := pg_temp._once(d,
$a$    v_r := rider_register(p_badge, p_name, p_height, p_type, coalesce(v_row.source, 'petromin'), p_phone, v_sess_id, p_company, p_riders, p_waiver);
$a$,
$b$    -- the emergency contact goes through as given; none keeps the stored pair (20261007235900)
    v_r := rider_register(p_badge, p_name, p_height, p_type, coalesce(v_row.source, 'petromin'), p_phone, v_sess_id, p_company, p_riders, p_waiver,
                          p_emergency => p_emergency);
$b$);

  execute d;
  drop function public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text);
end $edit$;
revoke execute on function public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,jsonb) from public;
grant  execute on function public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,jsonb) to anon, authenticated, service_role;


-- ── 4. rider_party_add: new companions take the booking's pair ────────────────────────────────
do $party$
declare d text;
begin
  d := pg_get_functiondef('public.rider_party_add(bigint,jsonb)'::regprocedure);
  if position('(20261007235900)' in d) > 0 then
    raise notice 'rider_party_add already copies the emergency contacts; nothing to do';
    return;
  end if;

  -- companion insert
  d := pg_temp._once(d,
$a$booking_no, party_no)
    values (v_row.badge, v_name, v_row.phone, v_h, v_type, null, null, 'none', v_row.source, v_row.session_id, v_row.company, v_row.booking_no, v_next)
$a$,
$b$booking_no, party_no,
                                     emergency_name, emergency_phone, emergency_relation, emergency2_name, emergency2_phone, emergency2_relation)  -- the booking's emergency contacts (20261007235900)
    values (v_row.badge, v_name, v_row.phone, v_h, v_type, null, null, 'none', v_row.source, v_row.session_id, v_row.company, v_row.booking_no, v_next,
            v_row.emergency_name, v_row.emergency_phone, v_row.emergency_relation, v_row.emergency2_name, v_row.emergency2_phone, v_row.emergency2_relation)
$b$);

  execute d;
end $party$;


-- ── checks ────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'rider_registrations'
         and column_name in ('emergency_name', 'emergency_phone', 'emergency_relation', 'emergency2_name', 'emergency2_phone', 'emergency2_relation')) <> 6 then
    raise exception 'an emergency contact column is missing';
  end if;
  if (select count(*) from pg_constraint where conrelid = 'public.rider_registrations'::regclass
        and conname like 'rider_registrations_emergency%') <> 7 then
    raise exception 'an emergency contact check is missing';
  end if;
  if to_regprocedure('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)') is not null or to_regprocedure('public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text)') is not null then
    raise exception 'an old rider_register / rider_edit signature is still there';
  end if;
  foreach f in array array['public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,jsonb)', 'public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,jsonb)', 'public.rider_party_add(bigint,jsonb)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if position('(20261007235900)' in pg_get_functiondef(f::regprocedure)) = 0 then
      raise exception 'the patch of % did not take', f;
    end if;
  end loop;
  foreach f in array array['public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,jsonb)', 'public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,jsonb)'] loop
    if not has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute')
       or not has_function_privilege('service_role', f, 'execute') then
      raise exception '% lost a grant', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.rider_party_add(bigint,jsonb)', 'execute') then
    raise exception 'rider_party_add must stay staff-only (no anon execute)';
  end if;
  if has_column_privilege('anon', 'public.rider_registrations', 'emergency_phone', 'select')
     or has_column_privilege('anon', 'public.rider_registrations', 'emergency2_phone', 'select')
     or not has_column_privilege('authenticated', 'public.rider_registrations', 'emergency_phone', 'select')
     or not has_column_privilege('authenticated', 'public.rider_registrations', 'emergency2_phone', 'update') then
    raise exception 'the emergency contact columns carry the wrong grants';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261007235900', 'petromin_emergency_contact')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
