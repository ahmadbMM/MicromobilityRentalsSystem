-- ============================================================================
-- Two more steps on the Saturday social ride ladder: Tailwind at 2 rides and Momentum at 3 (new features build
-- F1, "First five rides path"; the owner marked it Build now on 2026-11-13).
--
-- Why: the ladder went from 1 ride (Rolling Start) straight to 5 (Slipstream), so the second and third Saturday
-- rides, the ones that decide whether a new rider comes back, were marked by nothing. It is now
-- 1, 2, 3, 5, 10, 25, 50, 100.
--
-- The app counts these badges itself, on the rider's own done Saturday rides (_mrBadges, BD_SYS, BDG_LADDERS in
-- app.src.html), exactly as it counts the other six; nothing is written to customer_badges. These two rows put the
-- new steps in the catalogue, so a rider sees them among the badges still to earn and staff see them in
-- Community > Badges. The app draws and words them itself in every language; the columns here are the English and
-- Arabic fallback. They sort between Rolling Start (225) and Slipstream (230).
--
-- Safe before or after the app: until this runs a rider who has reached a step still sees it as earned, and the
-- steps not yet reached are simply not listed.
--
-- Undo:
--   delete from public.badges where id in ('bd_tailwind', 'bd_momentum');
--   delete from supabase_migrations.schema_migrations where version = '20261114080100';
-- ============================================================================

begin;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort) values
  ('bd_tailwind', 'tailwind', 'wind', 'silver', 'Tailwind', 'الرياح المواتية', '2 community rides', 'جولتان مجتمعيتان', true, true, 226),
  ('bd_momentum', 'momentum', 'wind', 'orange', 'Momentum', 'الزخم', '3 community rides', '3 جولات مجتمعية', true, true, 228)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true, retired = false,
  sort = excluded.sort;

do $chk$
begin
  if (select count(*) from public.badges where slug in ('tailwind', 'momentum') and system and auto and not retired) <> 2 then
    raise exception 'the Saturday ladder''s steps at 2 and 3 rides are missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114080100', 'saturday_ladder_2_3')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select (select count(*) from public.badges where slug in ('tailwind', 'momentum') and system and auto and not retired) as steps_2,
       (select string_agg(slug, ' ' order by sort) from public.badges
         where slug in ('rolling_start', 'tailwind', 'momentum', 'slipstream', 'paceline', 'peloton', 'grand_tour', 'hall_of_fame'))
         as ladder_rolling_start_tailwind_momentum_slipstream_paceline_peloton_grand_tour_hall_of_fame,
       (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity) as no_rls_0,
       (select version from supabase_migrations.schema_migrations where version = '20261114080100') as ledger;
