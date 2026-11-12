-- ============================================================================
-- The influencer tag (the owner, 2026-11-12: "create a new influencer tag that is given manually by staff"). A locked
-- system tag like Community, the blacklist, VIP and special needs; staff give it by hand (never auto-granted) and only
-- staff see it: customer_tags is staff-only (policy "staff full") and no rider-facing function reads this tag. The app
-- draws it as a white megaphone on magenta (TAG_BRANDS.influencer), puts that mark after the holder's name on the
-- roster, check-in, the hand-over, the scanner and the printed sheets, gives their Bookings row a magenta band, and
-- offers an Influencer filter and report counts.
-- Data only: no function, no grant, no policy changes. Idempotent.
--
-- Rollback:
--   delete from public.customer_tags where tag_id = 'tag_influencer';
--   delete from public.tags where id = 'tag_influencer';
-- ============================================================================

begin;

insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values ('tag_influencer', 'influencer', 'Influencer', '#c2255c',
        'An influencer: given by staff, seen only by staff. Marked on Bookings and counted in the reports.',
        false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do update set color = excluded.color;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261112235800', 'influencer_tag')
on conflict (version) do nothing;

commit;

-- Check (read only): the tag is in and locked.
select id, slug, name, color, locked, auto_grant from public.tags where id = 'tag_influencer';
