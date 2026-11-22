-- ============================================================================
-- The name is written MicroMobility, both Ms capital (the user, 2026-11-22: "change any word mentioned or written
-- anywhere from Micromobility to MicroMobility with both the Ms capitalized").
--
--  1. _vol_sess_name: the Blood Donation fallback name (live text of 20261114130000, that word only).
--  2. The words and records the business wrote: push_words (the Blood Donation name in 11 languages), session titles,
--     the website's text (site_content), store products, and volunteer certificates (initiative + its sessions list).
--  Left as they were: what people typed (customers.workplace, community_applications.workplace,
--  queue_entries.blood_club) and logs or saved copies (customer_activity, staff_actions, site_content_history,
--  report_copies). Rows are edited, none deleted.
-- ============================================================================
begin;

create or replace function public._vol_sess_name(p_session text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when s.ride_kind in ('saturday', 'petromin', 'swim', 'workshop', 'snd96', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'blood', 'yoga', 'farm')
              then coalesce(nullif(btrim(s.title), ''),
                            case s.ride_kind when 'saturday' then 'Saturday Social Ride' when 'petromin' then 'Petromin night' /* the user's pick, 2026-11-10 (20261110235400) */
                              when 'swim' then 'Triathlon Pool Session' when 'workshop' then 'T100 Triathlon Prep'
                              when 'snd96' then 'Saudi National Day 96 Ride' when 'event' then 'Event' when 'runher' then 'Run for Her'
                              when 'vlap' then 'Victory Lap' when 'arena' then 'Arena Heros Hybrid Race' when 'defe5k' then 'DEFE 5KM Run'
                              when 'yoga' then 'Hatha Yoga for Cyclists' /* 20261112120000 */
                              when 'farm' then 'Farm House Night' /* 20261114130000 */
                              else 'MicroMobility Blood Donation' end) /* 20261122120000 */
              else 'Jeddah Corniche Circuit' end
    from sessions s where s.id = p_session
$function$;
revoke all on function public._vol_sess_name(text) from public, anon, authenticated;

update public.push_words set title = replace(title, 'Micromobility', 'MicroMobility'), body = replace(body, 'Micromobility', 'MicroMobility')
 where title like '%Micromobility%' or body like '%Micromobility%';

update public.sessions set title = replace(title, 'Micromobility', 'MicroMobility') where title like '%Micromobility%';

update public.site_content set value = replace(value::text, 'Micromobility', 'MicroMobility')::jsonb
 where value::text like '%Micromobility%';

update public.store_products set brand = replace(brand, 'Micromobility', 'MicroMobility'),
       tagline_en = replace(tagline_en, 'Micromobility', 'MicroMobility'),
       description_en = replace(description_en, 'Micromobility', 'MicroMobility')
 where brand like '%Micromobility%' or tagline_en like '%Micromobility%' or description_en like '%Micromobility%';

update public.volunteer_certs set initiative = replace(initiative, 'Micromobility', 'MicroMobility'),
       sessions = replace(sessions::text, 'Micromobility', 'MicroMobility')::jsonb
 where initiative like '%Micromobility%' or sessions::text like '%Micromobility%';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261122120000', 'micromobility_capitals')
on conflict (version) do nothing;

commit;

-- Read-only check after applying (expect 0 everywhere, the function says MicroMobility, ledger row present):
-- select (select count(*) from push_words where title like '%Micromobility%' or body like '%Micromobility%') as push_words,
--        (select count(*) from sessions where title like '%Micromobility%') as sessions,
--        (select count(*) from site_content where value::text like '%Micromobility%') as site_content,
--        (select count(*) from store_products where brand like '%Micromobility%' or tagline_en like '%Micromobility%'
--           or description_en like '%Micromobility%') as store_products,
--        (select count(*) from volunteer_certs where initiative like '%Micromobility%' or sessions::text like '%Micromobility%') as certs,
--        (select pg_get_functiondef('public._vol_sess_name(text)'::regprocedure) like '%MicroMobility Blood Donation%') as fn,
--        (select name from supabase_migrations.schema_migrations where version = '20261122120000') as ledger;
