-- ============================================================================
-- The Petromin employee form needs an agreed waiver too (the owner, 2026-10-03: "you can't book
-- anything without agreeing" covers the partner rider form).
--
--  1. rider_registrations.waiver_version / waiver_at - which waiver the person agreed to, and when.
--  2. rider_register(..., p_waiver) - a registration that is not the desk's (is_staff()) must carry
--     the waiver it agreed to (e.g. 2026-10-v2) or it is refused with {"ok":false,"error":"waiver"},
--     before anything is written; the employee's row and the companions' rows record it. The desk's
--     walk-ins are unchanged (staff-added riders, the owner's decision of 2026-09-02).
--  3. rider_edit(..., p_waiver) - passes it on to rider_register (an edit is a resubmission).
-- Both functions are patched from their live definitions (the SECURITY DEFINER header is kept);
-- each patch refuses to run unless every anchor is found exactly once. The new parameter changes
-- the signature, so the old versions are dropped and the grants given again (anon + authenticated,
-- as before). The staff app's calls name their arguments and take the default.
--
-- Rollback: re-run the two functions from their definitions before this (git history of this
-- file's predecessors / pg_dump), drop the (…, text) versions, drop the two columns.
-- Idempotent: a second run finds p_waiver already there and does nothing.
-- ============================================================================

alter table public.rider_registrations add column if not exists waiver_version text;
alter table public.rider_registrations add column if not exists waiver_at timestamptz;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 80);
  end if;
  return replace(def, a, b);
end $f$;

do $patch$
declare
  def text;
begin
  if exists (select 1 from pg_proc where proname = 'rider_register' and pronamespace = 'public'::regnamespace
              and pg_get_function_identity_arguments(oid) like '%p_waiver%') then
    raise notice 'rider_register already takes p_waiver; nothing to do';
    return;
  end if;

  -- rider_register
  def := pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb)'::regprocedure);
  def := pg_temp._once(def, E'p_riders jsonb DEFAULT NULL::jsonb)\n RETURNS jsonb',
                            E'p_riders jsonb DEFAULT NULL::jsonb, p_waiver text DEFAULT NULL::text)\n RETURNS jsonb');
  def := pg_temp._once(def, E'  if not _rider_gate() then return jsonb_build_object(''ok'', false, ''error'', ''throttled''); end if;\n',
                            E'  if not _rider_gate() then return jsonb_build_object(''ok'', false, ''error'', ''throttled''); end if;\n'
                         || E'  -- Every registration that is not the desk''s carries the waiver it agreed to (20261003220000).\n'
                         || E'  if coalesce(p_waiver, '''') !~ ''^[A-Za-z0-9._-]{1,40}$'' then p_waiver := null; end if;\n'
                         || E'  if not v_staff and p_waiver is null then return jsonb_build_object(''ok'', false, ''error'', ''waiver''); end if;\n');
  def := pg_temp._once(def, E'company, booking_no, party_no)\n  values (v_badge, v_name, v_phone, p_height, v_type, v_entry.id, v_cust_id, v_kind, v_src, v_sess.id, v_company, v_bno, 1)',
                            E'company, booking_no, party_no, waiver_version, waiver_at)\n  values (v_badge, v_name, v_phone, p_height, v_type, v_entry.id, v_cust_id, v_kind, v_src, v_sess.id, v_company, v_bno, 1, p_waiver, case when p_waiver is not null then now() end)');
  def := pg_temp._once(def, E'        submissions = rider_registrations.submissions + 1, updated_at = now()\n  returning id, submissions, booking_no',
                            E'        waiver_version = coalesce(excluded.waiver_version, rider_registrations.waiver_version),\n'
                         || E'        waiver_at = coalesce(excluded.waiver_at, rider_registrations.waiver_at),\n'
                         || E'        submissions = rider_registrations.submissions + 1, updated_at = now()\n  returning id, submissions, booking_no');
  def := pg_temp._once(def, E'company, booking_no, party_no)\n    values (v_badge, v_cname, null, v_ch, v_ctype, null, null, ''none'', v_src, v_sess.id, v_company, v_bno, v_i + 2)',
                            E'company, booking_no, party_no, waiver_version, waiver_at)\n    values (v_badge, v_cname, null, v_ch, v_ctype, null, null, ''none'', v_src, v_sess.id, v_company, v_bno, v_i + 2, p_waiver, case when p_waiver is not null then now() end)');
  def := pg_temp._once(def, E'          submissions = rider_registrations.submissions + 1, updated_at = now();\n  end loop;',
                            E'          waiver_version = coalesce(excluded.waiver_version, rider_registrations.waiver_version),\n'
                         || E'          waiver_at = coalesce(excluded.waiver_at, rider_registrations.waiver_at),\n'
                         || E'          submissions = rider_registrations.submissions + 1, updated_at = now();\n  end loop;');
  execute def;
  drop function public.rider_register(text,text,integer,text,text,text,text,text,jsonb);

  -- rider_edit
  def := pg_get_functiondef('public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb)'::regprocedure);
  def := pg_temp._once(def, E'p_riders jsonb DEFAULT NULL::jsonb)\n RETURNS jsonb',
                            E'p_riders jsonb DEFAULT NULL::jsonb, p_waiver text DEFAULT NULL::text)\n RETURNS jsonb');
  def := pg_temp._once(def, E'p_phone, v_sess_id, p_company, p_riders);',
                            E'p_phone, v_sess_id, p_company, p_riders, p_waiver);');
  execute def;
  drop function public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb);
end $patch$;

revoke all on function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text) from public;
grant execute on function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text) to anon, authenticated;
revoke all on function public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text) from public;
grant execute on function public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text) to anon, authenticated;
