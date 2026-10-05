-- ============================================================================
-- bike_assignments.return_condition takes the two codes the code already writes (2026-10-04 review).
--
-- The check from 20260911120000 allows ok / needs_check / damaged / swapped / auto. Two writers use
-- codes outside it, and each refusal takes its whole statement down with it:
--   - queue_entries_reassign_close (_close_assignments_on_reassign, 20260928200000) closes the open
--     assignment of a bike a rider no longer holds with 'reassigned'. It runs AFTER an update of
--     queue_entries.assigned_bike_id, so a refused close refused the bike change itself: any change of
--     an active rider's bike outside staff_swap_bike (which closes as 'swapped' first) failed;
--   - the staff hand-over's Undo clears the rider's bike (that trigger again) and then closes the
--     assignment with 'undo': once a fleet is back, every hand-over Undo would fail.
-- Nothing failed yet only because the fleet is empty (bikes and bike_assignments have no rows).
-- The check now also takes 'reassigned' and 'undo'; nothing else changes.
--
-- Rollback: put the old check back (only if no row holds either code):
--   alter table public.bike_assignments drop constraint if exists bike_assignments_return_condition_check;
--   alter table public.bike_assignments add constraint bike_assignments_return_condition_check
--     check (return_condition = any (array['ok','needs_check','damaged','swapped','auto']));
-- Idempotent.
-- ============================================================================

begin;

alter table public.bike_assignments drop constraint if exists bike_assignments_return_condition_check;
alter table public.bike_assignments add constraint bike_assignments_return_condition_check
  check (return_condition = any (array['ok','needs_check','damaged','swapped','auto','reassigned','undo']));

insert into supabase_migrations.schema_migrations (version, name)
values ('20261004193000', 'assignment_return_codes')
on conflict do nothing;

commit;
