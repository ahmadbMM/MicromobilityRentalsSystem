-- Dukan employees register for the Petromin nights (the user, 2026-11-12: "create a registration page for dukan
-- employees do everything the same way you did with petromin but only ask them for their name and phone number and
-- the booking number starts with d instead make it on a link micromobility.sa/dukan"; their answers: Petromin nights,
-- billed like Petromin, one rider each, no companions).
--
-- A Dukan registration is an ordinary rider_registrations row on a Petromin night with company 'Dukan':
--   * source stays 'petromin' (the night's ride_kind), so the employee fare (_booking_fare), the desk's Petromin page,
--     rider_sessions / rider_lookup / rider_cancel and the billing report all work as they do for Petromin.
--   * its number comes from its own counter per night ('dukan' in rider_night_counters): D-001, D-002 ... every night.
--   * the form asks no badge: the phone's last nine digits stand in for it ('DK' + digits), so one phone is one
--     registration a night and a second submission from that phone updates it. The desk without a phone gets a
--     random stand-in.
--   * no height and no bike type are asked: the height stays empty and the bike is Hybrid until the desk picks
--     another; a later submission without a type leaves the type the row has.
--   * the form sends no companions (refused for Dukan unless it is the desk, which can still add them).
-- form_step counts the Dukan form too (form 'dukan'). The desk's night move (staff_rider_party_move) keeps the D-.
-- Every block skips itself once applied, so the file can be run again safely.
--
-- rider_register and rider_edit are patched from their LIVE definitions with exact-count text replaces (pg_temp._once,
-- as 20261111030000 did): the headers keep SECURITY DEFINER and the search_path, and a text that does not match stops
-- everything. Petromin and Petrolube rows behave exactly as before: every new branch is guarded by v_dukan, and the
-- two upsert guards (v_type_given, the height) are always true for them (both are required unless the company is Dukan).
-- Rollback: re-run 20261111030000's rider_edit and restore rider_register from its live definition before this file;
-- form_step from 20261111030000; the company check without 'Dukan' (only once no Dukan rows remain).

begin;

-- ── 1. the company ───────────────────────────────────────────────────────────────────────────────────────────────
alter table public.rider_registrations drop constraint if exists rider_registrations_company_check;
alter table public.rider_registrations add constraint rider_registrations_company_check
  check (company is null or company = any (array['Petromin'::text, 'Petrolube'::text, 'Dukan'::text]));

create or replace function pg_temp._once(src text, a text, b text, n integer default 1) returns text
language plpgsql as $f$
declare c integer := (length(src) - length(replace(src, a, ''))) / greatest(length(a), 1);
begin
  if c <> n then raise exception 'dukan_registrations: expected % of [%], found %', n, left(a, 80), c; end if;
  return replace(src, a, b);
end $f$;

-- ── 2. rider_register ────────────────────────────────────────────────────────────────────────────────────────────
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,text)'::regprocedure);
  if position('v_dukan' in d) > 0 then raise notice 'rider_register already knows Dukan; nothing to do'; return; end if;
  d := pg_temp._once(d,
$a$  v_desk int[] := '{}'; v_pno int := 1; v_wrote int[] := '{}';$a$,
$b$  v_desk int[] := '{}'; v_pno int := 1; v_wrote int[] := '{}';
  -- A Dukan employee (micromobility.sa/dukan, 20261112210000) gives a name and a phone only.
  v_dukan boolean := trim(coalesce(p_company, '')) = 'Dukan';
  v_type_given boolean := coalesce(p_type, '') <> '';$b$);
  d := pg_temp._once(d,
$a$  if v_badge = '' or length(v_badge) > 40 or v_badge !~$a$,
$b$  -- No badge on the Dukan form: the phone's last nine digits stand in for it, so one phone is one registration a
  -- night; the desk without a phone gets a stand-in of its own (20261112210000).
  if v_dukan and v_badge = '' then
    v_badge := 'DK' || coalesce(nullif(right(v_digits, 9), ''), upper(substr(md5(random()::text || clock_timestamp()::text), 1, 9)));
  end if;
  if v_badge = '' or length(v_badge) > 40 or v_badge !~$b$);
  d := pg_temp._once(d,
$a$  if p_height is null or p_height < 100 or p_height > 250 then return jsonb_build_object('ok', false, 'error', 'height'); end if;$a$,
$b$  if (p_height is null and not v_dukan) or p_height < 100 or p_height > 250 then return jsonb_build_object('ok', false, 'error', 'height'); end if;
  -- The desk picks a Dukan employee's bike: Hybrid until it does (20261112210000).
  if v_dukan and v_type = '' then v_type := 'Hybrid'; end if;$b$);
  d := pg_temp._once(d,
$a$if v_company is not null and v_company not in ('Petromin','Petrolube') then$a$,
$b$if v_company is not null and v_company not in ('Petromin','Petrolube','Dukan') then$b$);
  d := pg_temp._once(d,
$a$  if v_n_extra > 4 then return jsonb_build_object('ok', false, 'error', 'riders'); end if;$a$,
$b$  if v_n_extra > 4 then return jsonb_build_object('ok', false, 'error', 'riders'); end if;
  -- One rider per Dukan registration from the form; the desk can still add riders (20261112210000).
  if v_dukan and not v_staff and v_n_extra > 0 then return jsonb_build_object('ok', false, 'error', 'riders'); end if;$b$);
  -- D-001, D-002 ... on the night's own Dukan counter.
  d := pg_temp._once(d,
$a$values (coalesce(v_sess.id, ''), v_src, 1)$a$,
$b$values (coalesce(v_sess.id, ''), case when v_dukan then 'dukan' else v_src end, 1)$b$);
  d := pg_temp._once(d,
$a$v_bno := upper(left(v_src, 1)) || '-'$a$,
$b$v_bno := upper(left(case when v_dukan then 'dukan' else v_src end, 1)) || '-'$b$);
  -- A Dukan submission without a height or a type leaves what the row (or the desk) has.
  d := pg_temp._once(d,
$a$height          = case when rider_registrations.checked_out_at is null then excluded.height          else rider_registrations.height          end,$a$,
$b$height          = case when rider_registrations.checked_out_at is null and (p_height is not null or not v_dukan) then excluded.height          else rider_registrations.height          end,$b$, 2);
  d := pg_temp._once(d,
$a$type_preference = case when rider_registrations.checked_out_at is null then excluded.type_preference else rider_registrations.type_preference end,$a$,
$b$type_preference = case when rider_registrations.checked_out_at is null and (v_type_given or not v_dukan) then excluded.type_preference else rider_registrations.type_preference end,$b$, 2);
  execute d;
end $mig$;

-- ── 3. rider_edit ────────────────────────────────────────────────────────────────────────────────────────────────
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text,text)'::regprocedure);
  if position('Dukan' in d) > 0 then raise notice 'rider_edit already knows Dukan; nothing to do'; return; end if;
  d := pg_temp._once(d,
$a$  if v_newkey = '' then return jsonb_build_object('ok', false, 'error', 'badge'); end if;$a$,
$b$  -- A Dukan registration has no badge of its own: the phone stands in for it, as rider_register makes it (20261112210000).
  if v_newkey = '' and coalesce(nullif(trim(coalesce(p_company, '')), ''), v_row.company) = 'Dukan' then
    p_badge := 'DK' || coalesce(nullif(right(regexp_replace(coalesce(nullif(trim(coalesce(p_phone, '')), ''), v_row.phone, ''), '\D', '', 'g'), 9), ''),
                               right(v_row.badge_key, 9));
    v_newkey := lower(regexp_replace(trim(p_badge), '[^a-zA-Z0-9]', '', 'g'));
  end if;
  if v_newkey = '' then return jsonb_build_object('ok', false, 'error', 'badge'); end if;$b$);
  -- A Dukan party moved to another night takes that night's next D- number.
  d := pg_temp._once(d,
$a$values (coalesce(v_sess_id, ''), coalesce(v_row.source, 'petromin'), 1)$a$,
$b$values (coalesce(v_sess_id, ''), case when v_row.company = 'Dukan' then 'dukan' else coalesce(v_row.source, 'petromin') end, 1)$b$);
  d := pg_temp._once(d,
$a$v_bno := upper(left(coalesce(v_row.source, 'petromin'), 1)) || '-'$a$,
$b$v_bno := upper(left(case when v_row.company = 'Dukan' then 'dukan' else coalesce(v_row.source, 'petromin') end, 1)) || '-'$b$);
  execute d;
end $mig$;

-- ── 4. form_step: the Dukan form's steps are counted too ─────────────────────────────────────────────────────────
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.form_step(text,integer,text,text,text)'::regprocedure);
  if position('dukan' in d) > 0 then raise notice 'form_step already counts Dukan; nothing to do'; return; end if;
  d := pg_temp._once(d,
$a$if p_form is distinct from 'petromin' or p_step is null$a$,
$b$if p_form is null or p_form not in ('petromin', 'dukan') or p_step is null$b$);
  execute d;
end $mig$;

-- ── 5. staff_rider_party_move: the desk moving a Dukan party to another night gives it that night's next D- number ─
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.staff_rider_party_move(bigint,text)'::regprocedure);
  if position('Dukan' in d) > 0 then raise notice 'staff_rider_party_move already knows Dukan; nothing to do'; return; end if;
  d := pg_temp._once(d,
$a$values (p_session, src, 1)$a$,
$b$values (p_session, case when r.company = 'Dukan' then 'dukan' else src end, 1)$b$);
  d := pg_temp._once(d,
$a$bno := upper(left(src, 1)) || '-'$a$,
$b$bno := upper(left(case when r.company = 'Dukan' then 'dukan' else src end, 1)) || '-'$b$);
  execute d;
end $mig$;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261112210000', 'dukan_registrations')
on conflict (version) do nothing;

commit;
