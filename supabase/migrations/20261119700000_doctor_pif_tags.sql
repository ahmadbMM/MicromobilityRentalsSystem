-- ============================================================================
-- The Medical doctor and PIF & subsidiaries tags (the user, 2026-11-19: "add a new medical doctor tag and pif &
-- subsidaries tag give me options to choose from, for pif include the logo as an option", then their picks on the pick
-- page). Locked tags like the work tags (20261118180000): staff give them by hand (never auto-granted) and only staff see
-- them (customer_tags is staff-only, policy "staff full"). Medical doctor: a heart with a heartbeat cut out of it on
-- hospital blue; PIF & subsidiaries: PIF's seal and letters on a white chip edged in PIF gold (TAG_BRANDS.doctor / pif).
-- The mark beside the holder's name on accounts and after it on bookings, a band in the tag's colour on their Bookings
-- row, filters and report counts. A PIF holder may carry the company they work at, or none ("let the staff have the
-- option to put the company in pif or not include one"): the app writes it to customer_tags.note, a column that is
-- already there. The description is what staff read when they tap the tag (_tagInfo).
-- Data only: no function, no grant, no policy changes. Idempotent.
--
-- Rollback:
--   delete from public.customer_tags where tag_id in ('tag_doctor', 'tag_pif');
--   delete from public.tags where id in ('tag_doctor', 'tag_pif');
-- ============================================================================

begin;

insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values
  ('tag_doctor', 'doctor', 'Medical doctor', '#1971c2',
   'A medical doctor: given by staff, seen only by staff. Marked beside their name on accounts and bookings and counted in the reports.',
   false, true, (extract(epoch from now()) * 1000)::bigint),
  ('tag_pif', 'pif', 'PIF & subsidiaries', '#8c6a2c',
   'Works at PIF (the Public Investment Fund) or one of its companies: given by staff, seen only by staff. Staff may add which company. Marked beside their name on accounts and bookings and counted in the reports.',
   false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do update set color = excluded.color;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119700000', 'doctor_pif_tags')
on conflict (version) do nothing;

commit;

-- Check (read only): the two tags are in and locked, and the ledger row is ours.
select id, slug, name, color, locked, auto_grant from public.tags where id in ('tag_doctor', 'tag_pif') order by id;
select version, name from supabase_migrations.schema_migrations where version = '20261119700000';
