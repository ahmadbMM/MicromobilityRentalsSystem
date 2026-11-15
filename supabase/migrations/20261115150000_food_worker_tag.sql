-- ============================================================================
-- The food worker tag (the user, 2026-11-15: "add a new food worker tag that looks the same as food blogger but has a
-- worker between the fork and knife, but use a different color"). A locked tag like the food blogger tag
-- (20261114173000): staff give it by hand (never auto-granted) and only staff see it (customer_tags is staff-only,
-- policy "staff full"). A white worker between the fork and knife on chocolate brown (TAG_BRANDS.food_worker); the
-- mark after the holder's name on their bookings and beside the account's name, a brown band on their Bookings row,
-- a Food worker filter and report counts, all as the food blogger's.
-- Data only: no function, no grant, no policy changes. Idempotent.
--
-- Rollback:
--   delete from public.customer_tags where tag_id = 'tag_food_worker';
--   delete from public.tags where id = 'tag_food_worker';
-- ============================================================================

begin;

insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values ('tag_food_worker', 'food_worker', 'Food worker', '#8a4b1f',
        'A food worker: given by staff, seen only by staff. Marked beside their name on accounts and bookings and counted in the reports.',
        false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do update set color = excluded.color;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261115150000', 'food_worker_tag')
on conflict (version) do nothing;

commit;

-- Check (read only): the tag is in and locked.
select id, slug, name, color, locked, auto_grant from public.tags where id = 'tag_food_worker';
