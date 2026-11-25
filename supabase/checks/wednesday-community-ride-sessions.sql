-- Wednesday Community Ride (جولة الأربعاء المجتمعية): every Wednesday from 25 November 2026 to 24 February 2027, meet up
-- 6:30 PM, ride 7:00 PM, at the Saturday Social Ride's meeting point (https://maps.app.goo.gl/pdcMn1mGcCdabia7A?g_st=ic).
-- Inside MicroMobility Experiences for community members alone, not featured; first come first served (nobody
-- approves); no place limit (500 places, never counted out to riders); bike rental at the standard fare (ride_prices:
-- 57.5 Hybrid / Mountain / Kids, 75 Road) paid at the desk, own bike free; no ride groups, distance or route. Staff
-- change any of it in the app.
-- Run this ONLY after the booking app that knows the wed kind is live AND after migration 20261125170000: an older page
-- shows an unknown community kind as the Saturday ride (free, approval), and an older _session_kind calls it one.
-- Ids are <date>-wc. A date that already has its row is left as it is (on conflict do nothing).
begin;
insert into public.sessions (id, day, session_date, capacity, status, bike_slots, created_at,
  event_kind, required_tag_id, title, title_ar, needs_approval, hide_queue, spots, ride_kind, paid_ride, price, open_to_all,
  location, meet_name, meet_url)
select to_char(d, 'YYYY-MM-DD') || '-wc', 'Wednesday', to_char(d, 'YYYY-MM-DD'), 500, 'open', '{"_time":"18:30 - 19:00"}',
       to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       'community', null, 'Wednesday Community Ride', 'جولة الأربعاء المجتمعية', false, true, 500, 'wed', true, null, false,
       null, null, 'https://maps.app.goo.gl/pdcMn1mGcCdabia7A?g_st=ic'
  from generate_series(date '2026-11-25', date '2027-02-24', interval '7 days') as g(d)
on conflict (id) do nothing;
commit;

-- Check (expect 14 rows, 2026-11-25-wc to 2027-02-24-wc: wed, community, open, 500 places, members only, paid, no price,
-- no approval, 18:30 - 19:00, the Saturday meeting point):
select id, day, ride_kind, event_kind, status, capacity, spots, open_to_all, paid_ride, price, needs_approval, hide_queue,
       title, title_ar, meet_url, bike_slots
  from public.sessions where id like '%-wc' order by id;
