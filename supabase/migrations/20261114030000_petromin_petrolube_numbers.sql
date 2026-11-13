-- Petromin bookings are numbered PM-001, PM-002 ... and Petrolube bookings PL-001, PL-002 ... (the user, 2026-11-13:
-- "change petromin bookings to start with pm and petrolube to start with pl").
--
-- Until now both companies took P- numbers from one counter a night ('petromin' in rider_night_counters). From here:
--   * Petromin  -> PM-, its own counter a night (source 'pm')
--   * Petrolube -> PL-, its own counter a night (source 'pl')
--   * Dukan     -> D-,  as before (source 'dukan')
--   * a registration with no company (the desk may leave it empty) -> P- on the old counter, as before
-- Each series starts again at 001 every night. A number is minted when a registration is made and when it moves to
-- another night (rider_edit, staff_rider_party_move); a registration that already has a number keeps it, so the 295
-- past P- bookings and the one P- booking already made for 2026-11-18 keep theirs (the riders were told them).
--
-- 1. _rider_next_no(night, company, source): takes the night's next number in the company's series, passing over one
--    already used there. Called only from inside the three SECURITY DEFINER functions below, so it is closed to every
--    client.
-- 2. rider_register, rider_edit and staff_rider_party_move mint through it. They are patched from their LIVE definitions
--    with exact-count text replaces (pg_temp._once, as 20261112210000 did), so the headers keep SECURITY DEFINER and the
--    search_path, and a text that does not match stops everything. rider_edit mints with the company the edit sends
--    (a rider who moves night and changes company at once gets the new company's series).
-- invite_no (I-, _invite_next) is not touched. Every block skips itself once applied, so the file can be run again.
-- Rollback: restore the three functions from their definitions before this file (20261113190000's rider_register,
-- 20261112210000's rider_edit and staff_rider_party_move), then drop _rider_next_no. PM-/PL- rows keep their numbers.

begin;

create or replace function pg_temp._once(src text, a text, b text, n integer default 1) returns text
language plpgsql as $f$
declare c integer := (length(src) - length(replace(src, a, ''))) / greatest(length(a), 1);
begin
  if c <> n then raise exception 'petromin_petrolube_numbers: expected % of [%], found %', n, left(a, 80), c; end if;
  return replace(src, a, b);
end $f$;

-- ── 1. the night's next number in the company's series ──────────────────────────────────────────────────────────
create or replace function public._rider_next_no(p_session text, p_company text, p_source text)
returns text
language plpgsql
set search_path to 'public'
as $function$
declare
  v_co   text := trim(coalesce(p_company, ''));
  v_src  text := coalesce(nullif(p_source, ''), 'petromin');
  v_key  text := case v_co when 'Petromin' then 'pm' when 'Petrolube' then 'pl' when 'Dukan' then 'dukan' else v_src end;
  v_pre  text := case v_co when 'Petromin' then 'PM' when 'Petrolube' then 'PL' when 'Dukan' then 'D' else upper(left(v_src, 1)) end;
  v_seq  int; v_no text; v_tries int := 0;
begin
  loop
    insert into rider_night_counters (session_key, source, n) values (coalesce(p_session, ''), v_key, 1)
      on conflict (session_key, source) do update set n = rider_night_counters.n + 1
    returning n into v_seq;
    v_no := v_pre || '-' || lpad(v_seq::text, 3, '0');
    exit when not exists (select 1 from rider_registrations x
                           where coalesce(x.session_id, '') = coalesce(p_session, '') and x.booking_no = v_no);
    v_tries := v_tries + 1;
    if v_tries > 1000 then raise exception 'NO_FREE_NUMBER' using errcode = 'P0001'; end if;
  end loop;
  return v_no;
end $function$;

revoke all on function public._rider_next_no(text, text, text) from public, anon, authenticated;

-- ── 2. rider_register ────────────────────────────────────────────────────────────────────────────────────────────
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,text)'::regprocedure);
  if position('_rider_next_no' in d) > 0 then raise notice 'rider_register already mints PM-/PL-; nothing to do'; return; end if;
  d := pg_temp._once(d,
$a$    -- Numbers start again at P-001 every night: each night has its own counter.
    insert into rider_night_counters(session_key, source, n) values (coalesce(v_sess.id, ''), case when v_dukan then 'dukan' else v_src end, 1)
      on conflict (session_key, source) do update set n = rider_night_counters.n + 1 returning n into v_seq;
    v_bno := upper(left(case when v_dukan then 'dukan' else v_src end, 1)) || '-' || lpad(v_seq::text, 3, '0');$a$,
$b$    -- PM- for Petromin, PL- for Petrolube, D- for Dukan, each starting again at 001 every night (20261114030000).
    v_bno := _rider_next_no(v_sess.id, v_company, v_src);$b$);
  execute d;
end $mig$;

-- ── 3. rider_edit: a party moved to another night takes that night's next number in its company's series ─────────
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text,text)'::regprocedure);
  if position('_rider_next_no' in d) > 0 then raise notice 'rider_edit already mints PM-/PL-; nothing to do'; return; end if;
  d := pg_temp._once(d,
$a$      insert into rider_night_counters(session_key, source, n) values (coalesce(v_sess_id, ''), case when v_row.company = 'Dukan' then 'dukan' else coalesce(v_row.source, 'petromin') end, 1)
        on conflict (session_key, source) do update set n = rider_night_counters.n + 1 returning n into v_seq;
      v_bno := upper(left(case when v_row.company = 'Dukan' then 'dukan' else coalesce(v_row.source, 'petromin') end, 1)) || '-' || lpad(v_seq::text, 3, '0');$a$,
$b$      -- In the series of the company the edit sends (PM-, PL-, D-; 20261114030000).
      v_bno := _rider_next_no(v_sess_id, coalesce(nullif(trim(coalesce(p_company, '')), ''), v_row.company), coalesce(v_row.source, 'petromin'));$b$);
  execute d;
end $mig$;

-- ── 4. staff_rider_party_move: the desk's night move, the same way ──────────────────────────────────────────────
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.staff_rider_party_move(bigint,text)'::regprocedure);
  if position('_rider_next_no' in d) > 0 then raise notice 'staff_rider_party_move already mints PM-/PL-; nothing to do'; return; end if;
  d := pg_temp._once(d,
$a$    insert into rider_night_counters(session_key, source, n) values (p_session, case when r.company = 'Dukan' then 'dukan' else src end, 1)
      on conflict (session_key, source) do update set n = rider_night_counters.n + 1 returning n into seq;
    bno := upper(left(case when r.company = 'Dukan' then 'dukan' else src end, 1)) || '-' || lpad(seq::text, 3, '0');$a$,
$b$    bno := _rider_next_no(p_session, r.company, src);   -- PM-, PL-, D- (20261114030000)$b$);
  execute d;
end $mig$;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114030000', 'petromin_petrolube_numbers')
on conflict (version) do nothing;

commit;

-- Check (read-only): expect patched = 3, definer = 3, helper_open = 0, ledger = petromin_petrolube_numbers.
select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('rider_register', 'rider_edit', 'staff_rider_party_move')
           and p.prosrc like '%_rider_next_no(%') as patched,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('rider_register', 'rider_edit', 'staff_rider_party_move')
           and p.prosecdef and 'search_path=public' = any (p.proconfig)) as definer,
       (select count(*) from information_schema.routine_privileges
         where routine_schema = 'public' and routine_name = '_rider_next_no' and grantee in ('PUBLIC', 'anon', 'authenticated')) as helper_open,
       (select name from supabase_migrations.schema_migrations where version = '20261114030000') as ledger;
