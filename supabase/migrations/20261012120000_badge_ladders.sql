-- ============================================================================
-- Badge levels (the owner, 2026-10-12: "for marshal pit crew green flag scrutineer champion race spirit
-- front row put levels and multiple badges in each one ... add a new badge for owning a bike from
-- micromobility then level 2 owning a road bike then level 3 owning a carbon road bike").
--
-- Each badge gets two levels above it, one catalogue row per level (as the Saturday ladder and the T100
-- ladder): the app folds a ladder into one tile, and a level held brings the ones under it (BDG_LADDERS in
-- app.src.html, LADDERS in the website's ride-record.ts). Staff give the staff ladders' levels by hand,
-- each level's line saying how often it was done; Front Row's levels are earned by riding (first in the
-- queue on 1, 3 and 5 rides ridden). Bike Owner / Road Bike Owner / Carbon Owner are given by staff:
-- nothing in the bookings says who bought a bike from MicroMobility.
-- Front Row's line now says the ride was ridden: a #1 who never came no longer earns it.
-- Nothing else changes: every staffer could already write customer_badges ("staff full" policy).
--
-- Undo (only while nobody holds one):
--   delete from public.badges where slug in ('senior_marshal', 'chief_marshal', 'pit_boss', 'crew_chief', 'clear_track', 'track_guardian', 'tech_inspector', 'chief_scrutineer', 'hat_trick', 'grand_champion', 'fair_play', 'heart_of_race', 'bike_owner', 'road_owner', 'carbon_owner', 'pole_position', 'pole_master');
-- ============================================================================

begin;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort) values
  ('bd_senior_marshal', 'senior_marshal', 'shield', 'blue', 'Senior Marshal', 'كبير المنظّمين', 'Led, swept or helped run 5 rides or events', 'قدت أو تابعت مؤخرة أو ساعدت في تنظيم 5 جولات أو فعاليات', true, false, 11),
  ('bd_chief_marshal', 'chief_marshal', 'shield', 'gold', 'Chief Marshal', 'رئيس المنظّمين', 'Led, swept or helped run 15 rides or events', 'قدت أو تابعت مؤخرة أو ساعدت في تنظيم 15 جولة أو فعالية', true, false, 12),
  ('bd_pit_boss', 'pit_boss', 'wrench', 'teal', 'Pit Boss', 'رئيس الصيانة', 'Helped other riders out on 3 rides', 'ساعدت راكبين آخرين في 3 جولات', true, false, 21),
  ('bd_crew_chief', 'crew_chief', 'wrench', 'gold', 'Crew Chief', 'قائد الطاقم', 'Helped other riders out on 10 rides', 'ساعدت راكبين آخرين في 10 جولات', true, false, 22),
  ('bd_clear_track', 'clear_track', 'wflag', 'teal', 'Clear Track', 'المسار الآمن', 'Rode with care for the people around you on 5 rides', 'قدت بعناية بمن حولك في 5 جولات', true, false, 31),
  ('bd_track_guardian', 'track_guardian', 'wflag', 'gold', 'Track Guardian', 'حارس المسار', 'Rode with care for the people around you on 15 rides', 'قدت بعناية بمن حولك في 15 جولة', true, false, 32),
  ('bd_tech_inspector', 'tech_inspector', 'search', 'blue', 'Tech Inspector', 'المفتّش الفني', 'Reported 3 bike faults the team confirmed', 'أبلغت عن 3 أعطال في الدراجات وأكّدها الفريق', true, false, 51),
  ('bd_chief_scrutineer', 'chief_scrutineer', 'search', 'gold', 'Chief Scrutineer', 'كبير المدقّقين', 'Reported 10 bike faults the team confirmed', 'أبلغت عن 10 أعطال في الدراجات وأكّدها الفريق', true, false, 52),
  ('bd_hat_trick', 'hat_trick', 'trophy', 'purple', 'Hat-Trick', 'هاتريك', 'Won 3 MicroMobility challenges or events', 'فزت في 3 تحديات أو فعاليات من مايكروموبيليتي', true, false, 61),
  ('bd_grand_champion', 'grand_champion', 'trophy', 'gold', 'Grand Champion', 'البطل الأكبر', 'Won 5 MicroMobility challenges or events', 'فزت في 5 تحديات أو فعاليات من مايكروموبيليتي', true, false, 62),
  ('bd_fair_play', 'fair_play', 'heart', 'purple', 'Fair Play', 'اللعب النظيف', 'Showed great sportsmanship on 5 rides', 'أظهرت روحاً رياضية رائعة في 5 جولات', true, false, 71),
  ('bd_heart_of_race', 'heart_of_race', 'heart', 'gold', 'Heart of the Race', 'قلب السباق', 'Showed great sportsmanship on 15 rides', 'أظهرت روحاً رياضية رائعة في 15 جولة', true, false, 72),
  ('bd_bike_owner', 'bike_owner', 'bike', 'green', 'Bike Owner', 'مالك دراجة', 'Owns a bike bought from MicroMobility', 'تملك دراجة اشتريتها من مايكروموبيليتي', true, false, 78),
  ('bd_road_owner', 'road_owner', 'bike', 'blue', 'Road Bike Owner', 'مالك دراجة طريق', 'Owns a road bike bought from MicroMobility', 'تملك دراجة طريق اشتريتها من مايكروموبيليتي', true, false, 79),
  ('bd_carbon_owner', 'carbon_owner', 'bike', 'gold', 'Carbon Owner', 'مالك دراجة كربون', 'Owns a carbon road bike bought from MicroMobility', 'تملك دراجة طريق من الكربون اشتريتها من مايكروموبيليتي', true, false, 80),
  ('bd_pole_position', 'pole_position', 'one', 'purple', 'Pole Position', 'مركز الانطلاق الأول', 'First in the queue on 3 rides you rode', 'كنت الأول في الطابور في 3 جولات وركبتها', true, true, 131),
  ('bd_pole_master', 'pole_master', 'one', 'red', 'Pole Master', 'سيّد الانطلاق', 'First in the queue on 5 rides you rode', 'كنت الأول في الطابور في 5 جولات وركبتها', true, true, 132)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = excluded.auto,
  retired = false, sort = excluded.sort;

update public.badges set description = 'First in the queue on a ride you rode',
  description_ar = 'كنت الأول في الطابور في جولة وركبتها'
 where slug = 'front_row';

do $chk$
begin
  if (select count(*) from public.badges where slug in ('senior_marshal', 'chief_marshal', 'pit_boss', 'crew_chief', 'clear_track', 'track_guardian', 'tech_inspector', 'chief_scrutineer', 'hat_trick', 'grand_champion', 'fair_play', 'heart_of_race', 'bike_owner', 'road_owner', 'carbon_owner', 'pole_position', 'pole_master') and system and not retired) <> 17 then
    raise exception 'the badge levels are missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261012120000', 'badge_ladders')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
