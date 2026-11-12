-- Hatha Yoga for Cyclists, a collaboration between MicroMobility and Jassim Alsaady: Saturday 21 November 2026,
-- 4:00 to 5:30 PM (90 minutes) at SILKDEER, Jeddah (https://maps.app.goo.gl/TfCSEPEPxA4C5f7d7). A date inside
-- MicroMobility Experiences for community members: free, one place per account, 15 places (then the waitlist),
-- first come first served, nobody approves. Staff change any of it in the app.
-- Run this ONLY after the booking app that knows yoga is live (and after migration 20261112120000): an older page
-- shows an unknown community kind as the Saturday ride.
begin;
insert into public.sessions (id, day, session_date, capacity, status, bike_slots, created_at,
  event_kind, required_tag_id, title, needs_approval, hide_queue, spots, ride_kind, paid_ride, price, open_to_all,
  location, meet_url)
values ('2026-11-21-yg', 'Saturday', '2026-11-21', 15, 'open', '{"_time":"16:00 - 17:30"}',
  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'community', null, null, false, true, 15, 'yoga', false, null, false,
  'SILKDEER', 'https://maps.app.goo.gl/TfCSEPEPxA4C5f7d7')
on conflict (id) do nothing;
commit;

-- Check (expect one row: yoga, community, open, 15 places, members only, free, no approval, SILKDEER, 16:00 - 17:30):
select id, ride_kind, event_kind, status, capacity, spots, open_to_all, paid_ride, price, needs_approval, location, bike_slots
  from public.sessions where id = '2026-11-21-yg';
