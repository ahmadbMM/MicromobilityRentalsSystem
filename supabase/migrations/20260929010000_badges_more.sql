-- ============================================================================
-- More badges (the owner, 2026-09-29: "do them all", the research shortlist).
--
-- Thirteen badges the app works out from a rider's own bookings, as it does the first nine: Race
-- Ready (the whole profile filled in, drawn in the app's special gold), Back on
-- Track (a ride two months after the last), Safety Car and Endurance (6 and 12 weeks running, one
-- quiet week in four forgiven), Triple Crown (three kinds of ride), Slipstream, Paceline and Peloton
-- (5, 15, 30 community rides), Clean Sheet (10 rides in a row with no no-show), Works Team (3
-- company nights), and three dated ones: Winter Series, Ramadan Nights and Founding Day.
--
-- A dated badge keeps its windows here, in badges.rule, so a new season needs no code: admins
-- edit them in Community > Badges, and may date a badge of their own the same way.
--   rule = {"rides": n, "windows": [{"from": .., "to": ..}]}
-- YYYY-MM-DD is one window; MM-DD comes back every year and may cross New Year. A rider earns the
-- badge with n ride nights inside one window. The Ramadan windows are the Umm al-Qura dates; an
-- admin moves one a day when the moon is sighted differently. Riders read the dated badges through
-- badge_seasons() (the catalogue itself stays staff-only).
--
-- list_sessions() now also returns the nights a rider has ridden (status done). A members-only
-- ride stopped being returned once the rider's tag lapsed, so a former member's ride history lost
-- its kind of ride, and their complimentary rides stopped counting as rides at all.
-- ============================================================================

alter table public.badges add column if not exists rule jsonb;

-- The rule's shape, as the app writes it (the same test as _bdgRuleOf).
create or replace function public._badge_rule_ok(r jsonb)
returns boolean
language sql immutable set search_path to 'public'
as $$
  select r is null or (
    jsonb_typeof(r) = 'object'
    and case when jsonb_typeof(r->'rides') = 'number' then (r->>'rides')::numeric between 1 and 99 else false end
    and case when jsonb_typeof(r->'windows') = 'array' then
          jsonb_array_length(r->'windows') between 1 and 20
          and not exists (select 1 from jsonb_array_elements(r->'windows') w
                           where jsonb_typeof(w) <> 'object'
                              or coalesce(w->>'from', '') !~ '^([0-9]{4}-)?[0-9]{2}-[0-9]{2}$'
                              or coalesce(w->>'to', '') !~ '^([0-9]{4}-)?[0-9]{2}-[0-9]{2}$'
                              or length(w->>'from') <> length(w->>'to'))
        else false end)
$$;

alter table public.badges drop constraint if exists badges_rule_ok;
alter table public.badges add constraint badges_rule_ok check (public._badge_rule_ok(rule));

insert into public.badges (id, slug, icon, color, name, description, system, auto, sort, rule) values
  ('bd_back_on_track', 'back_on_track', 'return', 'teal', 'Back on Track', 'Came back for a ride after two months away', true, true, 190, null),
  ('bd_safety_car', 'safety_car', 'beacon', 'orange', 'Safety Car', 'Rode 6 weeks running (one quiet week in four is forgiven)', true, true, 200, null),
  ('bd_endurance', 'endurance', 'clock', 'purple', 'Endurance', 'Rode 12 weeks running (one quiet week in four is forgiven)', true, true, 210, null),
  ('bd_triple_crown', 'triple_crown', 'crown', 'gold', 'Triple Crown', 'Rode three different kinds of ride', true, true, 220, null),
  ('bd_slipstream', 'slipstream', 'wind', 'green', 'Slipstream', '5 community rides', true, true, 230, null),
  ('bd_paceline', 'paceline', 'wind', 'blue', 'Paceline', '15 community rides', true, true, 240, null),
  ('bd_peloton', 'peloton', 'wind', 'gold', 'Peloton', '30 community rides', true, true, 250, null),
  ('bd_clean_sheet', 'clean_sheet', 'calcheck', 'green', 'Clean Sheet', '10 rides in a row with no missed booking', true, true, 260, null),
  ('bd_works_team', 'works_team', 'briefcase', 'teal', 'Works Team', '3 company rides', true, true, 270, null),
  ('bd_winter_series', 'winter_series', 'snow', 'blue', 'Winter Series', '6 rides in one winter, December to February', true, true, 280,
    '{"rides": 6, "windows": [{"from": "12-01", "to": "02-29"}]}'),
  ('bd_ramadan_nights', 'ramadan_nights', 'lantern', 'purple', 'Ramadan Nights', '3 rides during Ramadan', true, true, 290,
    '{"rides": 3, "windows": [{"from": "2025-03-01", "to": "2025-03-29"}, {"from": "2026-02-18", "to": "2026-03-19"}, {"from": "2027-02-08", "to": "2027-03-09"}, {"from": "2028-01-28", "to": "2028-02-26"}]}'),
  ('bd_founding_day', 'founding_day', 'fort', 'orange', 'Founding Day', 'A ride around Founding Day, 18 to 28 February', true, true, 300,
    '{"rides": 1, "windows": [{"from": "02-18", "to": "02-28"}]}'),
  -- Race Ready (the owner, 2026-09-29): the whole profile filled in. The app draws it in its special
  -- gold-into-green; the colour here is only what the table can hold.
  ('bd_complete_profile', 'complete_profile', 'profile', 'gold', 'Race Ready', 'Filled in every part of your profile', true, true, 95, null)
on conflict (id) do nothing;

-- Plainer how-to lines (the owner asked what "the grid" meant): the flavour moved to the app's about lines.
update public.badges set description = 'Completed 5 rides' where id = 'bd_regular';
update public.badges set description = 'Completed 10 rides' where id = 'bd_podium';

-- The dated badges a rider can earn: their look, words and windows. Nothing about any rider.
create or replace function public.badge_seasons()
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'slug', slug, 'icon', icon, 'color', color, 'name', name, 'name_ar', name_ar,
           'description', description, 'description_ar', description_ar, 'system', system, 'rule', rule)
         order by sort), '[]'::jsonb)
    from badges
   where rule is not null and not retired
$$;

revoke execute on function public.badge_seasons() from public;
grant  execute on function public.badge_seasons() to anon, authenticated;

-- Rebuilt from the live definition (pg_get_functiondef, 2026-09-29): the header is copied, and the
-- one change is 'done' in the list of a rider's own bookings that keep a night visible.
CREATE OR REPLACE FUNCTION public.list_sessions(p_id text, p_token text)
 RETURNS SETOF sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if p_id is not null and p_token is not null and _cust_token_ok(p_id, p_token) then
    return query
      select s.* from sessions s
       where s.required_tag_id is null
          or exists (select 1 from customer_tags ct
                      where ct.customer_id = p_id and ct.tag_id = s.required_tag_id
                        and _ctag_active(ct.starts_at, ct.expires_at))
          -- a booking the rider still holds, or a night they rode, keeps it visible after the tag lapses
          or exists (select 1 from queue_entries q
                      where q.session_id = s.id and q.customer_id = p_id
                        and q.status in ('waiting','waitlist','active','done'))
       order by s.session_date;
  else
    return query
      select s.* from sessions s
       where s.required_tag_id is null
       order by s.session_date;
  end if;
end $function$;
