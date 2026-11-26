-- ============================================================================
-- The Banker tag (the user, 2026-11-26: "add a new banker tag and give me multiple options to choose", then their
-- picks on the pick page). Anyone who works in banking or finance. A locked tag like the Medical doctor and PIF tags
-- (20261119700000): staff give it by hand (never auto-granted) and only staff see it (customer_tags is staff-only,
-- policy "staff full"). A bank drawn in lines on bank green (TAG_BRANDS.banker). Like PIF, a grant may name where the
-- holder works in customer_tags.note (a bank from the app's list, one typed under Other, or none).
-- The description is what staff read when they tap the tag (_tagInfo).
-- Data only: no function, no grant, no policy changes. Idempotent.
--
-- Rollback:
--   delete from public.customer_tags where tag_id = 'tag_banker';
--   delete from public.tags where id = 'tag_banker';
-- ============================================================================

begin;

insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values
  ('tag_banker', 'banker', 'Banker', '#14532d',
   'Works in banking or finance. Staff may note the bank they work at. Given by staff, seen only by staff. Marked beside their name on accounts and bookings and counted in the reports.',
   false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do update set color = excluded.color;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261126150000', 'banker_tag')
on conflict (version) do nothing;

commit;

-- Check (read only): the tag is in and locked, and the ledger row is ours.
select id, slug, name, color, locked, auto_grant from public.tags where id = 'tag_banker';
select version, name from supabase_migrations.schema_migrations where version = '20261126150000';
