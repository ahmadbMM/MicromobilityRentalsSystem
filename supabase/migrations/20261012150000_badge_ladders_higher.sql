-- ============================================================================
-- Higher numbers and more levels for the staff badge ladders and Front Row (the owner, 2026-10-12:
-- "increase the n of each badge 1 5 10 are too low even if you need to increase the number of levels").
--
-- Marshal, Pit Crew, Green Flag, Scrutineer and Race Spirit: 1 / 10 / 25 / 50 / 100; Champion and Front Row:
-- 1 / 5 / 10 / 25 / 50. Levels 2 and 3 (20261012120000) take the new numbers (nobody held one yet), Hat-Trick
-- is renamed Repeat Champion, and each ladder gains two levels (14 new rows). Front Row's levels are
-- earned by riding (BDG_LADDERS / _mrBadges in app.src.html, LADDERS in the website's ride-record.ts).
--
-- Undo the new rows (only while nobody holds one):
--   delete from public.badges where slug in ('clerk_of_course', 'race_director', 'team_manager', 'team_principal', 'flag_bearer', 'track_legend', 'tech_delegate', 'chief_engineer', 'dynasty', 'world_champion', 'ride_ambassador', 'soul_of_ride', 'grid_leader', 'pole_legend');
-- ============================================================================

begin;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort) values
  ('bd_senior_marshal', 'senior_marshal', 'shield', 'blue', 'Senior Marshal', 'كبير المنظّمين', 'Led, swept or helped run 10 rides or events', 'قدت أو تابعت مؤخرة أو ساعدت في تنظيم 10 جولات أو فعاليات', true, false, 11),
  ('bd_chief_marshal', 'chief_marshal', 'shield', 'gold', 'Chief Marshal', 'رئيس المنظّمين', 'Led, swept or helped run 25 rides or events', 'قدت أو تابعت مؤخرة أو ساعدت في تنظيم 25 جولة أو فعالية', true, false, 12),
  ('bd_clerk_of_course', 'clerk_of_course', 'shield', 'red', 'Clerk of the Course', 'مدير المضمار', 'Led, swept or helped run 50 rides or events', 'قدت أو تابعت مؤخرة أو ساعدت في تنظيم 50 جولة أو فعالية', true, false, 13),
  ('bd_race_director', 'race_director', 'shield', 'gold', 'Race Director', 'مدير السباق', 'Led, swept or helped run 100 rides or events', 'قدت أو تابعت مؤخرة أو ساعدت في تنظيم 100 جولة أو فعالية', true, false, 14),
  ('bd_pit_boss', 'pit_boss', 'wrench', 'teal', 'Pit Boss', 'رئيس الصيانة', 'Helped other riders out on 10 rides', 'ساعدت راكبين آخرين في 10 جولات', true, false, 21),
  ('bd_crew_chief', 'crew_chief', 'wrench', 'gold', 'Crew Chief', 'قائد الطاقم', 'Helped other riders out on 25 rides', 'ساعدت راكبين آخرين في 25 جولة', true, false, 22),
  ('bd_team_manager', 'team_manager', 'wrench', 'red', 'Team Manager', 'مدير الفريق', 'Helped other riders out on 50 rides', 'ساعدت راكبين آخرين في 50 جولة', true, false, 23),
  ('bd_team_principal', 'team_principal', 'wrench', 'gold', 'Team Principal', 'رئيس الفريق', 'Helped other riders out on 100 rides', 'ساعدت راكبين آخرين في 100 جولة', true, false, 24),
  ('bd_clear_track', 'clear_track', 'wflag', 'teal', 'Clear Track', 'المسار الآمن', 'Rode with care for the people around you on 10 rides', 'قدت بعناية بمن حولك في 10 جولات', true, false, 31),
  ('bd_track_guardian', 'track_guardian', 'wflag', 'gold', 'Track Guardian', 'حارس المسار', 'Rode with care for the people around you on 25 rides', 'قدت بعناية بمن حولك في 25 جولة', true, false, 32),
  ('bd_flag_bearer', 'flag_bearer', 'wflag', 'red', 'Flag Bearer', 'حامل الراية', 'Rode with care for the people around you on 50 rides', 'قدت بعناية بمن حولك في 50 جولة', true, false, 33),
  ('bd_track_legend', 'track_legend', 'wflag', 'gold', 'Track Legend', 'أسطورة المسار', 'Rode with care for the people around you on 100 rides', 'قدت بعناية بمن حولك في 100 جولة', true, false, 34),
  ('bd_tech_inspector', 'tech_inspector', 'search', 'blue', 'Tech Inspector', 'المفتّش الفني', 'Reported 10 bike faults the team confirmed', 'أبلغت عن 10 أعطال في الدراجات وأكّدها الفريق', true, false, 51),
  ('bd_chief_scrutineer', 'chief_scrutineer', 'search', 'gold', 'Chief Scrutineer', 'كبير المدقّقين', 'Reported 25 bike faults the team confirmed', 'أبلغت عن 25 عطلاً في الدراجات وأكّدها الفريق', true, false, 52),
  ('bd_tech_delegate', 'tech_delegate', 'search', 'red', 'Technical Delegate', 'المندوب الفني', 'Reported 50 bike faults the team confirmed', 'أبلغت عن 50 عطلاً في الدراجات وأكّدها الفريق', true, false, 53),
  ('bd_chief_engineer', 'chief_engineer', 'search', 'gold', 'Chief Engineer', 'كبير المهندسين', 'Reported 100 bike faults the team confirmed', 'أبلغت عن 100 عطل في الدراجات وأكّدها الفريق', true, false, 54),
  ('bd_hat_trick', 'hat_trick', 'trophy', 'purple', 'Repeat Champion', 'البطل المتكرر', 'Won 5 MicroMobility challenges or events', 'فزت في 5 تحديات أو فعاليات من مايكروموبيليتي', true, false, 61),
  ('bd_grand_champion', 'grand_champion', 'trophy', 'red', 'Grand Champion', 'البطل الأكبر', 'Won 10 MicroMobility challenges or events', 'فزت في 10 تحديات أو فعاليات من مايكروموبيليتي', true, false, 62),
  ('bd_dynasty', 'dynasty', 'trophy', 'blue', 'Dynasty', 'الحقبة الذهبية', 'Won 25 MicroMobility challenges or events', 'فزت في 25 تحدياً أو فعالية من مايكروموبيليتي', true, false, 63),
  ('bd_world_champion', 'world_champion', 'trophy', 'gold', 'World Champion', 'بطل العالم', 'Won 50 MicroMobility challenges or events', 'فزت في 50 تحدياً أو فعالية من مايكروموبيليتي', true, false, 64),
  ('bd_fair_play', 'fair_play', 'heart', 'purple', 'Fair Play', 'اللعب النظيف', 'Showed great sportsmanship on 10 rides', 'أظهرت روحاً رياضية رائعة في 10 جولات', true, false, 71),
  ('bd_heart_of_race', 'heart_of_race', 'heart', 'gold', 'Heart of the Race', 'قلب السباق', 'Showed great sportsmanship on 25 rides', 'أظهرت روحاً رياضية رائعة في 25 جولة', true, false, 72),
  ('bd_ride_ambassador', 'ride_ambassador', 'heart', 'red', 'Ride Ambassador', 'سفير الجولات', 'Showed great sportsmanship on 50 rides', 'أظهرت روحاً رياضية رائعة في 50 جولة', true, false, 73),
  ('bd_soul_of_ride', 'soul_of_ride', 'heart', 'gold', 'Soul of the Ride', 'روح الجولة', 'Showed great sportsmanship on 100 rides', 'أظهرت روحاً رياضية رائعة في 100 جولة', true, false, 74),
  ('bd_pole_position', 'pole_position', 'one', 'purple', 'Pole Position', 'مركز الانطلاق الأول', 'First in the queue on 5 rides you rode', 'كنت الأول في الطابور في 5 جولات وركبتها', true, true, 131),
  ('bd_pole_master', 'pole_master', 'one', 'red', 'Pole Master', 'سيّد الانطلاق', 'First in the queue on 10 rides you rode', 'كنت الأول في الطابور في 10 جولات وركبتها', true, true, 132),
  ('bd_grid_leader', 'grid_leader', 'one', 'blue', 'Grid Leader', 'قائد خط الانطلاق', 'First in the queue on 25 rides you rode', 'كنت الأول في الطابور في 25 جولة وركبتها', true, true, 133),
  ('bd_pole_legend', 'pole_legend', 'one', 'gold', 'Pole Legend', 'أسطورة الانطلاق', 'First in the queue on 50 rides you rode', 'كنت الأول في الطابور في 50 جولة وركبتها', true, true, 134)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = excluded.auto,
  retired = false, sort = excluded.sort;

do $chk$
begin
  if (select count(*) from public.badges where slug in ('senior_marshal', 'chief_marshal', 'clerk_of_course', 'race_director', 'pit_boss', 'crew_chief', 'team_manager', 'team_principal', 'clear_track', 'track_guardian', 'flag_bearer', 'track_legend', 'tech_inspector', 'chief_scrutineer', 'tech_delegate', 'chief_engineer', 'hat_trick', 'grand_champion', 'dynasty', 'world_champion', 'fair_play', 'heart_of_race', 'ride_ambassador', 'soul_of_ride', 'pole_position', 'pole_master', 'grid_leader', 'pole_legend') and system and not retired) <> 28 then
    raise exception 'the badge levels are missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261012150000', 'badge_ladders_higher')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
