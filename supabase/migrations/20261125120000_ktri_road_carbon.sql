-- ============================================================================
-- The KAUST Triathlon rents Road Carbon too (2026-11-25, the user: "in kaust triathlon bike rentals include road
-- carbon option").
--
-- 20260921210000 kept carbon bikes off every community date but Petromin's: _comm_no_carbon turns a Road Carbon
-- booking into Road there. The KAUST Triathlon (ride_kind ktri, 20261122150000) is a community date whose rider
-- rents a bike at the Sharafeyah branch at its usual price, so Road Carbon (250) is offered and kept as booked.
-- The app holds the same rule in _noCarbon.
--
-- Header copied from production (invoker, search_path public). Rollback: re-run 20260921210000. Idempotent.
-- ============================================================================
begin;

CREATE OR REPLACE FUNCTION public._comm_no_carbon()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.type_preference = 'Road Carbon' and exists(
    select 1 from sessions s
     where s.id = new.session_id
       and s.event_kind = 'community'
       and coalesce(s.ride_kind, '') not in ('petromin', 'ktri')) then
    new.type_preference := 'Road';
  end if;
  return new;
end$function$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261125120000', 'ktri_road_carbon')
on conflict (version) do nothing;

commit;

-- Check (read-only):
--   select pg_get_functiondef('public._comm_no_carbon()'::regprocedure) like '%''ktri''%';   -- true
--   select prosecdef from pg_proc where proname = '_comm_no_carbon';                          -- false
--   select version, name from supabase_migrations.schema_migrations where version = '20261125120000';
