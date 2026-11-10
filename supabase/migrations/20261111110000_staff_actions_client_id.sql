-- ============================================================================
-- History > Log knows each line by an id the page gives it (staff round s10, items 38 and D1). For PROD and STAGING.
--
-- 1. staff_actions.client_id (text, new): the id logAction gives every line on the device that writes it. The Log
--    shows this device's own lines (S.fullLog, kept on the device) beside the shared table, and used to drop a device
--    line against a shared one with the same words written within a minute: two desks logging the same action in
--    that minute lost a line or showed one twice. It now drops a device line only when the table holds its id. Lines
--    written before this column have none and are all shown.
-- 2. An admin's Undo of a check-in from the Log (D1, the owner's answer of 2026-11-10: any device, not only the one
--    that checked the rider in) writes its own line with client_id 'u:<the undone line's key>' (its client id, or
--    'id:<its id>' for a line from before the column). That line marks the check-in undone on every device, and the
--    unique index below refuses a second undo line for the same check-in if two admins race (the undo write itself
--    is guarded on the rider still being on that bike).
--
-- No new policy: the table keeps "audit insert" / "audit read" (is_staff()); authenticated holds table-level
-- INSERT and SELECT, which covers the new column. No function changes. No saved-views table either: an account's
-- private saved views go into staff.prefs 'views.<section>' through staff_my_prefs, which has accepted that key
-- since 20261009190000 (own row only, security definer).
--
-- The page works without this migration: logAction drops the column after the first refusal (PGRST204 / 42703) and
-- the Log falls back to the old match for lines without an id.
--
-- Rollback: drop index if exists public.staff_actions_client_id_key;
--           alter table public.staff_actions drop constraint if exists staff_actions_client_id_len;
--           alter table public.staff_actions drop column if exists client_id;
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

alter table public.staff_actions add column if not exists client_id text;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'staff_actions_client_id_len' and conrelid = 'public.staff_actions'::regclass) then
    alter table public.staff_actions add constraint staff_actions_client_id_len check (client_id is null or length(client_id) <= 60);
  end if;
end $c$;

-- One line per id: the Log's merge and the "already undone" read (client_id = 'u:<key>') go by it.
create unique index if not exists staff_actions_client_id_key on public.staff_actions (client_id) where client_id is not null;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111110000', 'staff_actions_client_id')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- After:
-- select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'staff_actions' and column_name = 'client_id';
-- select indexname from pg_indexes where tablename = 'staff_actions' and indexname = 'staff_actions_client_id_key';
