-- ============================================================================
-- The Farmhouse Night badge (2026-11-14, the user: "create a badge for attending the farmhouse night").
--
-- Earned: the app reads the rider's own bookings (my_bookings returns status) and gives it for a booking on a farm
-- night (ride_kind 'farm', session id ending -fh) that staff checked in: on site (active) or checked out (done). The
-- member who booked holds it; the family on their booking are names, not accounts. Undoing the check-in takes it back.
--
-- The app draws it itself (BD_SYS farmhouse_night: a barn under a crescent moon, on the farm night's own special medal,
-- peach into ember into maroon) and words it in every language; the columns here are the English and Arabic fallback.
-- The table's colour check holds only the eight plain colours, so the row says orange, the nearest of them.
--
-- held_only true: only those who hold it see it (the badge's "Customers and members see it" switch starts off), as the
-- Blood Donation Visitor and the other event badges. Staff can still give it by hand from Community > Badges.
--
-- Safe before or after the app. Until this runs Community > Badges does not list it; a rider who earned it sees theirs
-- either way. 20261114173000 (food_blogger_tag) was the newest on production when this was numbered.
--
-- Undo:
--   delete from public.badges where id = 'bd_farmhouse_night';
-- ============================================================================

begin;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort, held_only) values
  ('bd_farmhouse_night', 'farmhouse_night', 'barn', 'orange', 'Farmhouse Night', 'ليلة فارم هاوس', 'Come to one of our farmhouse nights.', 'احضر ليلة فارم هاوس معنا.', true, true, 93, true)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true, retired = false,
  sort = excluded.sort, held_only = true;

do $chk$
begin
  if not exists (select 1 from public.badges where slug = 'farmhouse_night' and icon = 'barn' and system and auto and not retired and held_only) then
    raise exception 'the Farmhouse Night badge is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114200000', 'farmhouse_night_badge')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- Check (read-only):
--   select id, slug, icon, color, sort, system, auto, retired, held_only from public.badges where slug = 'farmhouse_night';
--   select version, name from supabase_migrations.schema_migrations where version = '20261114200000';
