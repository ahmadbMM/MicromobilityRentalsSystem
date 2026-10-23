-- ============================================================================
-- A name for each partner code (the owner, 2026-10-23: "make staff able to name each code a name and put
-- that name besides each bookings"). session_partner_codes.name: what staff call the code (who it was
-- given to); the Bookings page shows it beside every booking made with the code, the code itself when
-- no name is set. Staff only, like the rest of the table (its RLS is unchanged); customers never see it.
--
-- Rollback: alter table public.session_partner_codes drop column name;
-- ============================================================================

begin;
set local lock_timeout = '5s';

alter table public.session_partner_codes add column if not exists name text
  check (name is null or length(name) <= 60);
comment on column public.session_partner_codes.name is
  'What staff call this code (20261023220000); shown beside the bookings made with it. Null: the code is shown.';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261023220000', 'partner_code_names')
on conflict (version) do nothing;

commit;

-- Check (read only): the column is there.
select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'session_partner_codes' and column_name = 'name';
