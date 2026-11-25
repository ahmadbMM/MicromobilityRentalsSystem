-- ============================================================================
-- A Farmhouse night for one place per account (the user, 2026-11-25: "do me the farmhouse session for tomorrow and
-- make it invisible only can be shown for those who get the link and code and only can book for themselves with no
-- extra booking").
--
-- A farm night whose bike_slots carry "_solo" (1 / true) takes the account holder alone: farm_night says max 1 (the
-- Farmhouse page then shows no family step and says "Just you, one place per account"), and farm_book refuses any
-- family name on it ('cap', as the four-place limit is refused). Every other farm night keeps four per account.
-- The night itself stays closed (hidden in the booking app and on the website) and is booked only through
-- micromobility.sa/farmhouse with its code (farm_codes, written by hand on prod: never in this public repo).
--
-- Both functions are patched in place: each anchor must be found exactly once, or nothing changes. CREATE OR REPLACE
-- from pg_get_functiondef keeps SECURITY DEFINER, search_path and the grants.
--
-- Rollback: run the same patch with the replacements swapped (or re-run 20261119000600_bh18_r2a.sql's definitions).
-- ============================================================================

begin;

do $mig$
declare
  v_def text;
  v_solo constant text := $s$(case when coalesce(v_slots->>'_solo', '') not in ('', '0', 'false') then 1 else 4 end)$s$;
  a1 constant text := $a$'state', v_state, 'max', 4, 'held', v_held$a$;
  a2 constant text := $a$if v_held + v_new > 4 then$a$;
begin
  -- farm_night: the night's own limit
  v_def := pg_get_functiondef('public.farm_night(text, text, text)'::regprocedure);
  if (length(v_def) - length(replace(v_def, a1, ''))) / length(a1) <> 1 then
    raise exception 'farm_solo_night: farm_night anchor not found once';
  end if;
  execute replace(v_def, a1, $r$'state', v_state, 'max', $r$ || v_solo || $r$, 'held', v_held$r$);

  -- farm_book: the holder and (on a solo night) no one else
  v_def := pg_get_functiondef('public.farm_book(text, text, text, text, jsonb, text)'::regprocedure);
  if (length(v_def) - length(replace(v_def, a2, ''))) / length(a2) <> 1 then
    raise exception 'farm_solo_night: farm_book anchor not found once';
  end if;
  execute replace(v_def, a2, 'if v_held + v_new > ' || v_solo || ' then /* one on a _solo night (20261125190000) */');
end
$mig$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261125190000', 'farm_solo_night')
on conflict (version) do nothing;

commit;

-- Check (read only): both functions know _solo, keep their attributes, and the ledger row is ours.
select p.proname, prosecdef, proconfig, pg_get_functiondef(p.oid) like '%_solo%' as solo
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('farm_night', 'farm_book');
select version, name from supabase_migrations.schema_migrations where version = '20261125190000';
