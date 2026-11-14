-- ============================================================================
-- The food blogger tag (the owner, 2026-11-14: "create a new food bloggers tag give me options to the design and show
-- the tag besides the name of the account and bookings"). A locked tag like the influencer tag: staff give it by hand
-- (never auto-granted) and only staff see it (customer_tags is staff-only, policy "staff full"). The owner's picks: a
-- white fork and knife on aubergine purple (TAG_BRANDS.food_blogger); the mark after the holder's name on their
-- bookings (roster, check-in, the hand-over, the scanner, the printed sheets) and beside the account's name on
-- Accounts, Members and the account page; a purple band on their Bookings row; a Food blogger filter and report counts.
-- Data only: no function, no grant, no policy changes. Idempotent.
--
-- Rollback:
--   delete from public.customer_tags where tag_id = 'tag_food_blogger';
--   delete from public.tags where id = 'tag_food_blogger';
-- ============================================================================

begin;

insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values ('tag_food_blogger', 'food_blogger', 'Food blogger', '#6f2dbd',
        'A food blogger: given by staff, seen only by staff. Marked beside their name on accounts and bookings and counted in the reports.',
        false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do update set color = excluded.color;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114173000', 'food_blogger_tag')
on conflict (version) do nothing;

commit;

-- Check (read only): the tag is in and locked.
select id, slug, name, color, locked, auto_grant from public.tags where id = 'tag_food_blogger';
