-- ============================================================================
-- National Day 96 badge (the owner, 2026-09-29: "for those who attended the snd96 parade").
--
-- The app earns it for a rider checked in (done, or on the bike) on the Saudi National Day 96 Ride
-- (sessions.ride_kind 'snd96', 23 September 2026): attendance, paid or not. It shows only to those
-- who rode it, drawn in the app's National Day greens (the colour here is only what the table can
-- hold), and pops up once. Staff may still give it by hand, to a rider who rode without being
-- checked in.
-- ============================================================================

insert into public.badges (id, slug, icon, color, name, description, system, auto, sort, rule) values
  ('bd_national_day_96', 'national_day_96', 'n96', 'green', 'National Day 96', 'Rode in the Saudi National Day 96 Ride', true, true, 90, null)
on conflict (id) do nothing;
