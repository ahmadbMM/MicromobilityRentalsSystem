-- Tee Painting Workshop (ورشة الرسم على التيشيرت): drawing and colouring on MicroMobility T-shirts, Saturday 28 November
-- 2026, 3:00 to 6:00 PM at Red Mug Caffe, 7257 Prince Saud Al Faisal, Jeddah (https://maps.app.goo.gl/PrRpv2rXTSKH7meJ8).
-- A featured date inside MicroMobility Experiences for community members: 130 SAR per person (the way to pay is announced
-- later; staff mark places paid), one place per account, 20 places (then the waitlist), first come first served, nobody
-- approves. Staff change any of it in the app.
-- Run this ONLY after the booking app that knows the paint kind is live (and after migration 20261123150000): an older
-- page shows an unknown community kind as the Saturday ride, and an older _fare_now prices it as a bike.
begin;
insert into public.sessions (id, day, session_date, capacity, status, bike_slots, created_at,
  event_kind, required_tag_id, title, title_ar, needs_approval, hide_queue, spots, ride_kind, paid_ride, price, open_to_all,
  location, meet_name, meet_url)
values ('2026-11-28-tp', 'Saturday', '2026-11-28', 20, 'open', '{"_time":"15:00 - 18:00"}',
  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'community', null, 'Tee Painting Workshop', 'ورشة الرسم على التيشيرت', false, true, 20, 'paint', true, 130, false,
  'Red Mug Caffe', 'Red Mug Caffe', 'https://maps.app.goo.gl/PrRpv2rXTSKH7meJ8')
on conflict (id) do nothing;
commit;

-- Check (expect one row: paint, community, open, 20 places, members only, paid, 130, no approval, Red Mug Caffe, 15:00 - 18:00):
select id, ride_kind, event_kind, status, capacity, spots, open_to_all, paid_ride, price, needs_approval, title, title_ar,
       location, meet_name, meet_url, bike_slots
  from public.sessions where id = '2026-11-28-tp';
