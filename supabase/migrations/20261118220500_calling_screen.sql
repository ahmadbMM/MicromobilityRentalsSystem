-- ============================================================================
-- 20261118220500 - The calling screen: staff may broadcast on the private topic staff-desk.
--
-- The user picked item 6 of the staff Bookings features (2026-11-18, "do 2 4 6 7 9 10"): "Now-calling screen. A
-- big-screen mode on a staff device, like Ask's big screen. It shows booking numbers only ('Desk 1: #23'), so the crowd
-- waits without asking." A desk calls a booking to the desk; the call travels as a realtime broadcast
-- {sid, id, num, desk, at} on the private topic staff-desk, the topic the desks already join for "who has a rider open"
-- (BK08, 20261107100000). Nothing is stored in a table.
--
-- 20261107100000 opened staff-desk to is_staff() for reading presence and broadcast ("staff see staff-desk") and for
-- writing presence only ("staff track staff-desk"); staff-ref (20260921160000) has no client write at all (its
-- broadcasts come from triggers). So a desk's broadcast is refused today. This adds ONE policy: authenticated staff
-- (is_staff()) may insert broadcast messages on staff-desk. Nothing else changes: no table, no function, no grant.
-- Riders and anon cannot join or send on the topic (no policy names them).
--
-- Before this runs the page works: a call is kept on the desk that made it (its "Called" pill) and the desk is told the
-- screens did not hear it.
--
-- Rollback:
--   drop policy if exists "staff call on staff-desk" on realtime.messages;
-- Idempotent (drop if exists + create).
-- ============================================================================

begin;
set local lock_timeout = '5s';

drop policy if exists "staff call on staff-desk" on realtime.messages;
create policy "staff call on staff-desk" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) = 'staff-desk'
    and (select public.is_staff())
  );

insert into supabase_migrations.schema_migrations (version, name)
values ('20261118220500', 'calling_screen')
on conflict (version) do nothing;

commit;

-- check (read only): the three staff-desk policies are there, the new one an INSERT for broadcast; and the ledger row.
-- select policyname, cmd, roles, with_check from pg_policies
--  where schemaname = 'realtime' and tablename = 'messages' and policyname like '%staff-desk%' order by policyname;
-- select version, name from supabase_migrations.schema_migrations where version = '20261118220500';
