-- ============================================================================
-- Hide tags (2026-11-08, the owner: "add a feature to hide tags like the victory lap session has ended and we
-- longer need the tag so i want to hide it not delete it").
--
--   tags.hidden_at  timestamptz: when staff hid it; null = shown.
--   tags.hidden_by  text: the staff name that hid it.
--
-- Staff set and clear them from the Tags page (a plain update: the "staff full" policy already covers tags). A
-- hidden tag keeps every account that holds it, and every rule the database keys on it (the Victory Lap gate,
-- one of two, VIP on the house) works as before; the app only leaves it off the chips, pickers, filters and
-- reports and lists it under Hidden on the Tags page, where Unhide brings it back. The staff-ref broadcast sends
-- the whole tags row, so other desks follow at once.
--
-- Safe before or after the app: until this runs the Tags page's Hide button says "Waiting for the database update".
--
-- Rollback:
--   alter table public.tags drop column if exists hidden_at, drop column if exists hidden_by;
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

alter table public.tags
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_by text check (char_length(hidden_by) <= 120);
comment on column public.tags.hidden_at is 'Hidden by staff (the Tags page''s Hidden list); null = shown (20261108100000).';

-- Staff already hold table-level select and update; named here too, so a later move to column grants keeps them.
grant select (hidden_at, hidden_by), update (hidden_at, hidden_by) on public.tags to authenticated;

do $chk$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'tags'
         and column_name in ('hidden_at', 'hidden_by')) <> 2 then
    raise exception 'hidden_at / hidden_by missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261108100000', 'tag_hide')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
