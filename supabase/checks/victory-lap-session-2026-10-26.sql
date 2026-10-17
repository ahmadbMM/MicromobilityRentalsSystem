-- Victory Lap by Fitness Empire, Monday 26 October 2026: doors 16:30, first heat 17:15, the Jeddah Corniche
-- Circuit, run by Kamin Sports. Community members and Victory Lap tag holders, 16 and over, 150 SAR per athlete
-- VAT included (the way to pay announced later), 500 places (then the waitlist), every race and division open,
-- partner requests on. Staff change any of it in the app (Bookings > the race > Race settings).
-- Run this ONLY after the booking app that knows Victory Lap is live (and after migration 20261017210000): an
-- older page shows an unknown community kind as the Saturday ride.
begin;
insert into public.sessions (id, day, session_date, capacity, status, bike_slots, created_at,
  event_kind, required_tag_id, title, needs_approval, hide_queue, spots, ride_kind, paid_ride, price, open_to_all,
  location, meet_url, vl)
values ('2026-10-26-vl', 'Monday', '2026-10-26', 500, 'open', '{"_time":"16:30 - 17:15"}',
  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'community', null, null, false, true, 500, 'vlap', true, 150, false,
  'JCC', 'https://maps.app.goo.gl/aWjWgoxHX1W28JB26',
  '{"races":["ws","ms","wd","md","xd"],"divs":["so","se","op","el"],"pair":true}'::jsonb)
on conflict (id) do nothing;
commit;

-- Check (expect one row: vlap, community, open, 500 places, members and tag holders, 150, no approval):
select id, ride_kind, event_kind, status, capacity, spots, open_to_all, paid_ride, price, needs_approval, location, bike_slots, vl
  from public.sessions where id = '2026-10-26-vl';
