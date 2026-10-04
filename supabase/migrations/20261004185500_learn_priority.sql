-- ============================================================================
-- A priority on each learn-to-ride sign-up (the owner, 2026-10-04: "allows staff to put a priority
-- on each learning applicant, Critical High Medium Low").
--
-- learn_applications.priority: 'critical' | 'high' | 'medium' | 'low', or null (none set yet).
-- Staff set it on the sign-up's card (Community > Applications > Learn to ride, New and Scheduled)
-- through the table UPDATE they already hold ("staff update learn applications", is_staff()); New
-- lists the sign-ups by it, Critical first. A second tap on the picked one sets it back to null.
--
-- Nothing else reads or writes it: the website's form (learn_apply / customer_learn_apply) never
-- sends it and a resend of a pending sign-up updates its own columns only, so the priority stays;
-- the learn_heard_to_account trigger fires on customer_id / heard_from only. No new grants.
-- The app loads the list without the column until this has run (the cards then carry no priority).
--
-- Rollback: alter table public.learn_applications drop column if exists priority;
-- Idempotent.
-- ============================================================================

begin;

alter table public.learn_applications add column if not exists priority text;

alter table public.learn_applications drop constraint if exists learn_applications_priority_check;
alter table public.learn_applications add constraint learn_applications_priority_check
  check (priority is null or priority in ('critical', 'high', 'medium', 'low'));

comment on column public.learn_applications.priority is
  'Staff''s priority for the sign-up: critical, high, medium or low; null = none set (2026-10-04).';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261004185500', 'learn_priority')
on conflict (version) do nothing;

commit;
