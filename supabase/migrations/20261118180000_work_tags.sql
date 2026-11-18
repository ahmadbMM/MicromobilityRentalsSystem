-- ============================================================================
-- The four work tags (the user, 2026-11-18: "create new lawyer hr senior marketing, show me a lot of design options",
-- then their picks on the new staff tags page): Lawyer, HR, Senior and Marketing. Locked tags like the food worker tag
-- (20261115150000): staff give them by hand (never auto-granted) and only staff see them (customer_tags is staff-only,
-- policy "staff full"). Lawyer: the scales of justice on taupe; HR: the letters HR on berry; Senior (a senior role):
-- a necktie on chocolate; Marketing: the word itself on indigo (TAG_BRANDS.lawyer / hr / senior / marketing). The mark
-- after the holder's name on their bookings, a band in the tag's colour on their Bookings row, a filter on People and
-- Bookings, and report counts. The description is what staff read when they tap the tag (_tagInfo, same release).
-- Data only: no function, no grant, no policy changes. Idempotent.
--
-- Rollback:
--   delete from public.customer_tags where tag_id in ('tag_lawyer', 'tag_hr', 'tag_senior', 'tag_marketing');
--   delete from public.tags where id in ('tag_lawyer', 'tag_hr', 'tag_senior', 'tag_marketing');
-- ============================================================================

begin;

insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values
  ('tag_lawyer', 'lawyer', 'Lawyer', '#7d6b5d',
   'A lawyer: given by staff, seen only by staff. Marked after their name on bookings and counted in the reports.',
   false, true, (extract(epoch from now()) * 1000)::bigint),
  ('tag_hr', 'hr', 'HR', '#a61e4d',
   'Works in HR (human resources): given by staff, seen only by staff. Marked after their name on bookings and counted in the reports.',
   false, true, (extract(epoch from now()) * 1000)::bigint),
  ('tag_senior', 'senior', 'Senior', '#8a4b1f',
   'Holds a senior role: given by staff, seen only by staff. Marked after their name on bookings and counted in the reports.',
   false, true, (extract(epoch from now()) * 1000)::bigint),
  ('tag_marketing', 'marketing', 'Marketing', '#4c3fd1',
   'Works in marketing: given by staff, seen only by staff. Marked after their name on bookings and counted in the reports.',
   false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do update set color = excluded.color;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261118180000', 'work_tags')
on conflict (version) do nothing;

commit;

-- Check (read only): the four tags are in and locked, and the ledger row is ours.
select id, slug, name, color, locked, auto_grant from public.tags where id in ('tag_lawyer', 'tag_hr', 'tag_senior', 'tag_marketing') order by id;
select version, name from supabase_migrations.schema_migrations where version = '20261118180000';
