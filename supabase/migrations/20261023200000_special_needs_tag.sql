-- ============================================================================
-- The special needs tag (the owner, 2026-10-23: "add a new tag for special needs and make its logo a man on a
-- wheelchair"). A locked system tag like Community, the blacklist and VIP; staff give it by hand (never
-- auto-granted). The app draws it as a figure in a wheelchair, white on orange (TAG_BRANDS.special_needs), puts that
-- mark after the holder's name on the roster, check-in, the hand-over, the scanner and the printed sheets, and
-- counts holders in the reports (the account report's Special needs section, the session sheets' tile).
-- Data only: no function, no grant, no policy changes. Idempotent.
--
-- Rollback:
--   delete from public.customer_tags where tag_id = 'tag_special_needs';
--   delete from public.tags where id = 'tag_special_needs';
-- ============================================================================

begin;

insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values ('tag_special_needs', 'special_needs', 'Special needs', '#e8590c',
        'Rides with special needs: the desk is ready to help at check-in. Counted in the reports.',
        false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do update set color = excluded.color;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261023200000', 'special_needs_tag')
on conflict (version) do nothing;

commit;

-- Check (read only): the tag is in and locked.
select id, slug, name, color, locked, auto_grant from public.tags where id = 'tag_special_needs';
