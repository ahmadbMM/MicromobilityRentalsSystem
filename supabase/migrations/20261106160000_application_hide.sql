-- ============================================================================
-- Hide applications (2026-11-06, the owner: "add a button on applications both learn and community and call it hide
-- that hides applications in a new section called hidden").
--
--   community_applications.hidden_at, learn_applications.hidden_at  timestamptz: when staff hid it; null = shown.
--   community_applications.hidden_by, learn_applications.hidden_by  text: the staff name that hid it.
--
-- Staff set and clear them from the card (a plain update, as learn_applications.priority: the "staff update"
-- policies already cover both tables). A hidden application keeps its status and waits under the Hidden pill;
-- Unhide puts it back in its list. The forms' RPCs never read or write them.
--
-- Safe before or after the app: until this runs the cards' Hide button says "Waiting for the database update".
--
-- Rollback:
--   alter table public.community_applications drop column if exists hidden_at, drop column if exists hidden_by;
--   alter table public.learn_applications     drop column if exists hidden_at, drop column if exists hidden_by;
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

alter table public.community_applications
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by text check (char_length(hidden_by) <= 120);
alter table public.learn_applications
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by text check (char_length(hidden_by) <= 120);
comment on column public.community_applications.hidden_at is 'Hidden by staff (the Hidden list); null = shown (20261106160000).';
comment on column public.learn_applications.hidden_at is 'Hidden by staff (the Hidden list); null = shown (20261106160000).';

-- Staff already hold table-level select and update on both; named here too, so a later move to column grants keeps them.
grant select (hidden_at, hidden_by), update (hidden_at, hidden_by) on public.community_applications to authenticated;
grant select (hidden_at, hidden_by), update (hidden_at, hidden_by) on public.learn_applications to authenticated;

do $chk$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name in ('community_applications', 'learn_applications')
         and column_name in ('hidden_at', 'hidden_by')) <> 4 then
    raise exception 'hidden_at / hidden_by missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261106160000', 'application_hide')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
