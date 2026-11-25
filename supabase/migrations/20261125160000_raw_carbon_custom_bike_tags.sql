-- ============================================================================
-- The Raw carbon bike and Customized bike tags (the user, 2026-11-25: "add a new Raw Carbon tag and Customized Bike
-- tag, show me multiple options of how will it look like and let me choose", then their picks on the pick page).
-- Locked tags like the Medical doctor and PIF tags (20261119700000): staff give them by hand (never auto-granted) and
-- only staff see them (customer_tags is staff-only, policy "staff full"). Raw carbon bike: the rider's own unpainted
-- carbon bike, the word RAW on a carbon-weave chip in carbon black; Customized bike: a bike MicroMobility built or
-- changed for the rider, a wrench and the word CUSTOM on workshop orange (TAG_BRANDS.raw_carbon / custom_bike).
-- The description is what staff read when they tap the tag (_tagInfo).
-- Data only: no function, no grant, no policy changes. Idempotent.
--
-- Rollback:
--   delete from public.customer_tags where tag_id in ('tag_raw_carbon', 'tag_custom_bike');
--   delete from public.tags where id in ('tag_raw_carbon', 'tag_custom_bike');
-- ============================================================================

begin;

insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values
  ('tag_raw_carbon', 'raw_carbon', 'Raw carbon bike', '#24282f',
   'Rides their own raw (unpainted) carbon bike: it is theirs, not ours, so handle it with care. Given by staff, seen only by staff. Marked beside their name on accounts and bookings and counted in the reports.',
   false, true, (extract(epoch from now()) * 1000)::bigint),
  ('tag_custom_bike', 'custom_bike', 'Customized bike', '#d9480f',
   'Has a bike MicroMobility built or changed for them. Given by staff, seen only by staff. Marked beside their name on accounts and bookings and counted in the reports.',
   false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do update set color = excluded.color;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261125160000', 'raw_carbon_custom_bike_tags')
on conflict (version) do nothing;

commit;

-- Check (read only): the two tags are in and locked, and the ledger row is ours.
select id, slug, name, color, locked, auto_grant from public.tags where id in ('tag_raw_carbon', 'tag_custom_bike') order by id;
select version, name from supabase_migrations.schema_migrations where version = '20261125160000';
