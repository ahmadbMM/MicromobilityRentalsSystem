-- ============================================================================
-- The distance ladder (the owner, 2026-10-16: "create a badge for who completes 20 km 40km 70km 100 km ...
-- whenever a booking is completed consider the kilometers counted").
--
-- 20 km Club > 40 km Club > 70 km Club > 100 km Club, earned by riding: every Saturday social ride ridden adds
-- its group's distance (the ride's own, else 20 km Beginners and 40 km Intermediates), so one Beginners ride
-- brings the 20 km badge and one Intermediates ride the 40 km one. The app works it out (_mrBadges and
-- BDG_LADDERS in app.src.html, the website's ride-record.ts); this only adds the catalogue rows, without which
-- the four stay hidden.
--
-- Undo (only while nobody was given one by hand):
--   delete from public.badges where slug in ('km20', 'km40', 'km70', 'km100');
-- ============================================================================

begin;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort) values
  ('bd_km20', 'km20', 'road', 'green', '20 km Club', 'نادي 20 كم', 'Rode 20 km on community rides', 'قطعت 20 كم في الجولات المجتمعية', true, true, 255),
  ('bd_km40', 'km40', 'road', 'blue', '40 km Club', 'نادي 40 كم', 'Rode 40 km on community rides', 'قطعت 40 كم في الجولات المجتمعية', true, true, 256),
  ('bd_km70', 'km70', 'road', 'purple', '70 km Club', 'نادي 70 كم', 'Rode 70 km on community rides', 'قطعت 70 كم في الجولات المجتمعية', true, true, 257),
  ('bd_km100', 'km100', 'road', 'gold', '100 km Club', 'نادي 100 كم', 'Rode 100 km on community rides', 'قطعت 100 كم في الجولات المجتمعية', true, true, 258)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true,
  retired = false, sort = excluded.sort;

do $chk$
begin
  if (select count(*) from public.badges where slug in ('km20', 'km40', 'km70', 'km100') and system and auto and not retired) <> 4 then
    raise exception 'the distance badges are missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261016120000', 'distance_badges')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
