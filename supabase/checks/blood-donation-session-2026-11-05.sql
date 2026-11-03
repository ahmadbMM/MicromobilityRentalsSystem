-- The Blood Donation event, Thursday 5 November 2026, 17:00-23:00, the Jeddah Corniche Circuit. Open to everyone,
-- free, no bikes, one place per account. Staff change any of it in the app.
-- Run this ONLY after the booking app that knows the event is live (and after migration 20261103180000): an older
-- page shows an unknown community kind as the Saturday ride.
begin;
insert into public.sessions (id, day, session_date, capacity, status, bike_slots, created_at,
  event_kind, required_tag_id, title, needs_approval, hide_queue, spots, ride_kind, paid_ride, price, open_to_all,
  location, meet_url)
values ('2026-11-05-bd', 'Thursday', '2026-11-05', 100000, 'open', '{"_time":"17:00 - 23:00"}',
  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'community', null, null, false, true, 100000, 'blood', false, null, true,
  'JCC', 'https://maps.app.goo.gl/U77D5RvQPagN8Yke8')
on conflict (id) do nothing;
commit;

-- Check (expect one row: blood, community, open, 100000 places (no real cap, the owner 2026-11-03), open to all, free, no approval, JCC, 17:00 - 23:00):
select id, ride_kind, event_kind, status, capacity, spots, open_to_all, paid_ride, price, needs_approval, location, bike_slots
  from public.sessions where id = '2026-11-05-bd';
