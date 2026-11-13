-- ============================================================================
-- The IMC tag (the owner, 2026-11-13: "create a new tag call it IMC and let the attached logo to be what's inside the
-- tag but only the image and IMC letters", then "and show the tag on their bookings"). A locked tag like the
-- influencer tag: staff give it by hand (never auto-granted) and only staff see it (customer_tags is staff-only,
-- policy "staff full"). The app draws IMC's arch and letters on a white chip edged in IMC blue (TAG_BRANDS.imc) and puts
-- the same logo after the holder's name on their bookings: the roster, check-in, the hand-over, the scanner and the
-- printed sheets.
-- Data only: no function, no grant, no policy changes. Idempotent.
--
-- Rollback:
--   delete from public.customer_tags where tag_id = 'tag_imc';
--   delete from public.tags where id = 'tag_imc';
-- ============================================================================

begin;

insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values ('tag_imc', 'imc', 'IMC', '#0e5592',
        'IMC: given by staff, seen only by staff. Its logo is marked after the holder''s name on their bookings.',
        false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do update set color = excluded.color;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114140000', 'imc_tag')
on conflict (version) do nothing;

commit;

-- Check (read only): the tag is in and locked.
select id, slug, name, color, locked, auto_grant from public.tags where id = 'tag_imc';
