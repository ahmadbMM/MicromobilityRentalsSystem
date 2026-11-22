-- KAUST Triathlon 2026: Friday 4 December 2026 at KAUST Urban Beach, report 6:00 a.m. (Olympic 6:30, Sprint 7:30,
-- Future Champs 9:00; Coastline Recreation's race, entered at rec.coastline-fm.com/events/kaust-triathlon-2026/register,
-- closing Wed 2 Dec 23:50). A featured date inside MicroMobility Experiences that every rider sees; community members book a
-- free place in the MicroMobility group (50 places, then the waitlist), one each, first come first served, nobody approves.
-- Run this ONLY after the booking app that knows ktri is live (and after migration 20261122150000): an older page shows an
-- unknown community kind as the Saturday ride.
begin;
insert into public.sessions (id, day, session_date, capacity, status, bike_slots, created_at,
  event_kind, required_tag_id, title, needs_approval, hide_queue, spots, ride_kind, paid_ride, price, open_to_all,
  location, meet_url)
values ('2026-12-04-kt', 'Friday', '2026-12-04', 50, 'open', '{"_time":"06:00 - 11:00"}',
  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'community', null, null, false, true, 50, 'ktri', false, null, false,
  'KAUST Urban Beach', 'https://www.google.com/maps/search/?api=1&query=KAUST+Urban+Beach')
on conflict (id) do nothing;
commit;

-- Check (expect one row: ktri, community, open, 50 places, members only, free, no approval, KAUST Urban Beach, 06:00 - 11:00):
select id, ride_kind, event_kind, status, capacity, spots, open_to_all, paid_ride, price, needs_approval, location, bike_slots
  from public.sessions where id = '2026-12-04-kt';
