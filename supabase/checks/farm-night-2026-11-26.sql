-- The Farmhouse Night: Thursday 26 November 2026 at Farmhouse, Dhahban, Jeddah, arrival 6:30 PM (the user,
-- 2026-11-25: "do me the farmhouse session for tomorrow and make it invisible only can be shown for those who get the
-- link and code and only can book for themselves with no extra booking", "make it on 6:30 pm thursday 26 nov", "all
-- bookings needs approval the same way saturday social ride gets"). Dinner kept at 8:30 PM as on 19 November.
--   * invisible: made CLOSED, so neither the booking app nor the website lists it; micromobility.sa/farmhouse books it
--     with its code (farm_codes, inserted by hand on prod only: the code is never written in this public repo);
--   * one place per account: bike_slots._solo (20261125190000_farm_solo_night: farm_night says max 1, farm_book
--     takes no family names);
--   * approval as the Saturday ride: needs_approval, the list hidden until staff publish it.
-- 130 places, as staff set the 19 November night. Run after migration 20261125190000.
begin;
insert into public.sessions (id, day, session_date, capacity, status, bike_slots, created_at,
  event_kind, required_tag_id, title, title_ar, needs_approval, hide_queue, spots, ride_kind, paid_ride, price, open_to_all,
  location, meet_url, meet_name, meet_name_ar)
values ('2026-11-26-fh', 'Thursday', '2026-11-26', 130, 'closed', '{"_time":"18:30 - 20:30","_ig":"thefarmhouse.jed","_solo":1}',
  to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'community', null, 'The Farmhouse Night', 'ليلة فارم هاوس', true, true, 130, 'farm', false, null, false,
  'Farmhouse, Dhahban', 'https://maps.app.goo.gl/BYteRL5JCueWZUEs6', 'Farmhouse, Dhahban', 'فارم هاوس، ذهبان')
on conflict (id) do nothing;
commit;

-- Check (expect one row: farm, community, CLOSED, 130 places, approval, list hidden, 18:30 - 20:30, _solo 1):
select id, ride_kind, event_kind, status, capacity, spots, open_to_all, paid_ride, price, needs_approval, hide_queue,
       title, title_ar, meet_name, bike_slots
  from public.sessions where id = '2026-11-26-fh';
