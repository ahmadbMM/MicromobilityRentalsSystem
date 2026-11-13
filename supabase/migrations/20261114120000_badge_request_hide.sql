-- ============================================================================
-- Hide badge requests (2026-11-13, the owner: "add an option to hide badge requests in a hidden section").
--
--   badge_requests.hidden_at  timestamptz: when staff hid it; null = shown.
--   badge_requests.hidden_by  text: the staff name that hid it.
--
-- Staff set and clear them from the Badge requests section (a plain update: badge_requests_staff_update already
-- lets staff update the table). A hidden request keeps its status and waits under the Hidden pill, out of the
-- other pills, the rail's number and the bell; Unhide puts it back. Display only: customer_badge_request and
-- customer_my_badge_requests never read or write them, so the rider sees nothing of it.
--
-- Safe before or after the app: until this runs the section reads the requests without them and Hide says
-- "Waiting for the database update".
--
-- Rollback:
--   alter table public.badge_requests drop column if exists hidden_at, drop column if exists hidden_by;
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

alter table public.badge_requests
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by text;
alter table public.badge_requests drop constraint if exists badge_requests_hidden_by_chk;
alter table public.badge_requests add constraint badge_requests_hidden_by_chk
  check (hidden_by is null or char_length(hidden_by) <= 60);
comment on column public.badge_requests.hidden_at is 'Hidden by staff (the Hidden pill); null = shown (20261114120000).';
comment on column public.badge_requests.hidden_by is 'The staff name that hid it (20261114120000).';

-- Staff already hold table-level select and update; named here too, so a later move to column grants keeps them.
grant select (hidden_at, hidden_by), update (hidden_at, hidden_by) on public.badge_requests to authenticated;

do $chk$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'badge_requests'
         and column_name in ('hidden_at', 'hidden_by')) <> 2 then
    raise exception 'hidden_at / hidden_by missing';
  end if;
  if has_table_privilege('anon', 'public.badge_requests', 'select') then
    raise exception 'anon can read badge_requests';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114120000', 'badge_request_hide')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- Check (read-only):
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'badge_requests' and column_name like 'hidden_%' order by 1;
--   select version, name from supabase_migrations.schema_migrations where version = '20261114120000';
