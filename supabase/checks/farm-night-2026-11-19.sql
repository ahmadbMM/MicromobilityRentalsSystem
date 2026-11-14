-- The Farmhouse Night: Thursday 19 November 2026 at Farmhouse, Dhahban, Jeddah
-- (https://maps.app.goo.gl/BYteRL5JCueWZUEs6). First inserted as Nawar Farm House Night (ليلة مزرعة نوار), renamed on
-- production 2026-11-13 (the user: "change the name of the session to the little farmhouse night"), then on 2026-11-14
-- to The Farmhouse Night, the venue to Farmhouse, Dhahban (the user: "remove little from the name of the farmhouse").
-- Arrival from 4:30 PM, dinner at 8:30 PM. A date inside MicroMobility Experiences for community members and their
-- families: free, staff approve every place as on the Saturday ride (the list hidden until staff publish it), and a
-- member books themselves and up to three more on one booking, each by name (four per booking, 20261114150000).
-- 60 places for staff to allocate. Staff change any of it in the app.
-- Run this ONLY after the booking app that knows the farm night is live (and after migration 20261114130000): an
-- older page shows an unknown community kind as the Saturday ride.
begin;
insert into public.sessions (id, day, session_date, capacity, status, bike_slots, created_at,
  event_kind, required_tag_id, title, title_ar, needs_approval, hide_queue, spots, ride_kind, paid_ride, price, open_to_all,
  location, meet_url, meet_name, meet_name_ar)
values ('2026-11-19-fh', 'Thursday', '2026-11-19', 60, 'open', '{"_time":"16:30 - 20:30"}',
  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'community', null, 'The Farmhouse Night', 'ليلة فارم هاوس', true, true, 60, 'farm', false, null, false,
  'Farmhouse, Dhahban', 'https://maps.app.goo.gl/BYteRL5JCueWZUEs6', 'Farmhouse, Dhahban', 'فارم هاوس، ذهبان')
on conflict (id) do nothing;
commit;

-- Check (expect one row: farm, community, open, 60 places, members only, free, approval, list hidden, 16:30 - 20:30):
select id, ride_kind, event_kind, status, capacity, spots, open_to_all, paid_ride, price, needs_approval, hide_queue,
       title, title_ar, meet_name, bike_slots
  from public.sessions where id = '2026-11-19-fh';
