-- ============================================================================
-- Ironman finisher badges (2026-11-13, the user: "add a new half iron man and full iron man badges",
-- then "ironman 70.3 ironman 140.6").
--
-- Two staff-given badges: Ironman 70.3 (the half distance) and Ironman 140.6 (the full one). The races
-- are not ours, so nothing in the bookings says who finished: staff give each by hand (Community >
-- Badges, Give to a rider), like the T100 race badges. The app draws them itself (BDG_RACE
-- ironman_703 / ironman_1406: a finisher's medal on a red ribbon with 70.3 or 140.6 struck on it, silver
-- and gold) and words them in every language; the columns here are the English and Arabic fallback.
-- They are one badge in two levels (BDG_LADDERS): 140.6 given brings 70.3 with it. Every rider sees
-- them greyed until they hold them (held_only false), as the T100 ones.
--
-- Undo (only while nobody holds one):
--   delete from public.badges where id in ('bd_ironman_1406', 'bd_ironman_703');
-- ============================================================================

begin;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort, held_only) values
  ('bd_ironman_1406', 'ironman_1406', 'ironman_1406', 'gold',   'Ironman 140.6 Finisher', 'إنجاز آيرونمان 140.6', 'Finished a full Ironman 140.6 triathlon', 'أنهيت سباق آيرونمان 140.6 الكامل', true, false, 88, false),
  ('bd_ironman_703',  'ironman_703',  'ironman_703',  'silver', 'Ironman 70.3 Finisher',  'إنجاز آيرونمان 70.3',  'Finished an Ironman 70.3 triathlon',      'أنهيت سباق آيرونمان 70.3',         true, false, 89, false)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = false, retired = false,
  sort = excluded.sort, held_only = false;

do $chk$
begin
  if (select count(*) from public.badges where slug in ('ironman_703', 'ironman_1406') and system and not auto and not retired and not held_only) <> 2 then
    raise exception 'the Ironman badges are missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114070000', 'ironman_badges')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- Check (read only):
--   select slug, icon, color, system, auto, retired, held_only, sort from public.badges where slug like 'ironman%' order by sort;
--   select slug, held_only from public.badge_catalog() where slug like 'ironman%';
--   select version, name from supabase_migrations.schema_migrations where version = '20261114070000';
