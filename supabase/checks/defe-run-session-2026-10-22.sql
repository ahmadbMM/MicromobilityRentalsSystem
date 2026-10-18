-- The DEFE 5KM Run, Thursday 22 October 2026 at 19:00, the Jeddah Corniche Circuit (kits at Jeddah Park on
-- 21 October, 16:00-22:00). A date inside MicroMobility Experiences for community members: free, 5 km, one
-- place per account, 300 places (then the waitlist), first come first served. Staff change any of it in the app.
-- Run this ONLY after the booking app that knows the Defe run is live (and after migration 20261018150000): an
-- older page shows an unknown community kind as the Saturday ride.
begin;
insert into public.sessions (id, day, session_date, capacity, status, bike_slots, created_at,
  event_kind, required_tag_id, title, needs_approval, hide_queue, spots, ride_kind, paid_ride, price, open_to_all,
  location, meet_url)
values ('2026-10-22-df', 'Thursday', '2026-10-22', 300, 'open', '{"_time":"19:00"}',
  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'community', null, null, false, true, 300, 'defe5k', false, null, false,
  'JCC', 'https://maps.app.goo.gl/aWjWgoxHX1W28JB26')
on conflict (id) do nothing;
commit;

-- Check (expect one row: defe5k, community, open, 300 places, members only, free, no approval, JCC, 19:00):
select id, ride_kind, event_kind, status, capacity, spots, open_to_all, paid_ride, price, needs_approval, location, bike_slots
  from public.sessions where id = '2026-10-22-df';
