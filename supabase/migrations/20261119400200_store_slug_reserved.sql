-- ============================================================================
-- Store catalogue: two more product addresses kept back (2026-11-19, store product management build).
-- The staging website's store gained /store/collection/<slug> (collections) and a product's Preview mark; a product
-- slugged 'collection' or 'preview' would sit behind those pages. store_products_slug_check now refuses them too,
-- beside cart, checkout, order, track, saved and category (store_categories and store_collections already refuse them).
-- Both databases (after 20261119400000/400100). Idempotent. Applied by the lead.
-- ============================================================================
begin;
set local lock_timeout = '5s';

do $chk$
begin
  if exists (select 1 from public.store_products where slug in ('collection', 'preview')) then
    raise exception 'a product already uses the slug collection or preview: rename it first';
  end if;
end $chk$;

alter table public.store_products drop constraint if exists store_products_slug_check;
alter table public.store_products add constraint store_products_slug_check check (
  slug ~ '^[a-z][a-z0-9-]{1,60}$'
  and slug <> all (array['cart', 'checkout', 'order', 'track', 'saved', 'category', 'collection', 'preview'])
  and (slug <> 'gift-card' or kind = 'gift_card')
);

insert into supabase_migrations.schema_migrations (version, name) values ('20261119400200', 'store_slug_reserved') on conflict do nothing;

commit;
