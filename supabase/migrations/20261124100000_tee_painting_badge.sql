-- ============================================================================
-- The Tee Painting Workshop badge (2026-11-24, the user: "create a badge for it", the Tee Painting Workshop of
-- 20261123150000_tee_painting).
--
-- Earned: the app reads the rider's own bookings (my_bookings returns status) and gives it for a booking on a Tee
-- Painting Workshop (ride_kind 'paint', session id ending -tp) that staff checked in: on site (active) or checked out
-- (done). Undoing the check-in takes it back.
--
-- The app draws it itself (BD_SYS tee_painting: the workshop's tee with a brush stroke and paint drops, on the
-- workshop's own special medal, sunflower into red into navy, its Paint Splash look) and words it in every language;
-- the columns here are the English and Arabic fallback. The table's colour check holds only the eight plain colours,
-- so the row says red, the nearest of them.
--
-- held_only true: only those who hold it see it (the badge's "Customers and members see it" switch starts off), as the
-- Farmhouse Night and the other event badges. Staff can still give it by hand from Community > Badges.
--
-- sort 94: next after the Farmhouse Night (93), with the event badges.
--
-- Safe before or after the app. Until this runs Community > Badges does not list it; a rider who earned it sees theirs
-- either way. 20261123150000 (tee_painting) was the newest in supabase/migrations when this was numbered.
--
-- Undo:
--   delete from public.badges where id = 'bd_tee_painting';
-- ============================================================================

begin;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort, held_only) values
  ('bd_tee_painting', 'tee_painting', 'tee', 'red', 'Tee Painting Workshop', 'ورشة الرسم على التيشيرت', 'Come to one of our tee painting workshops.', 'احضر ورشة الرسم على التيشيرت معنا.', true, true, 94, true)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true, retired = false,
  sort = excluded.sort, held_only = true;

do $chk$
begin
  if not exists (select 1 from public.badges where slug = 'tee_painting' and icon = 'tee' and system and auto and not retired and held_only) then
    raise exception 'the Tee Painting Workshop badge is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261124100000', 'tee_painting_badge')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- Check (read-only):
--   select id, slug, icon, color, sort, system, auto, retired, held_only from public.badges where slug = 'tee_painting';
--   select version, name from supabase_migrations.schema_migrations where version = '20261124100000';
