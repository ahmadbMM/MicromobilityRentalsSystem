-- ============================================================================
-- What the database linter asked for after the 2026-09-27 review (get_advisors, performance):
--
--  1. Three foreign keys had no covering index: the catalogue's sub-type and colour links, and
--     the website hand-off's customer link. A delete or update of the referenced row scans the
--     whole referencing table without one; the catalogue's are small today, but the index is
--     what keeps them small to work with.
--  2. sync_deletions had no primary key. The staff page's delta sync writes one row per deleted
--     row (_sync_tombstone, by column name) and reads them back by table and time (staff_sync),
--     so an identity column costs nothing and gives the table the key every table should have.
--
-- Rollback:
--   drop index if exists public.catalog_models_subtype_idx, public.catalog_photos_color_idx,
--     public.customer_handoffs_customer_idx;
--   alter table public.sync_deletions drop column if exists id;
-- Idempotent.
-- ============================================================================

begin;

create index if not exists catalog_models_subtype_idx on public.catalog_models (subtype_id) where subtype_id is not null;
create index if not exists catalog_photos_color_idx on public.catalog_photos (color_id) where color_id is not null;
create index if not exists customer_handoffs_customer_idx on public.customer_handoffs (customer_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.sync_deletions'::regclass and contype = 'p') then
    alter table public.sync_deletions add column id bigint generated always as identity primary key;
  end if;
end $$;

commit;
