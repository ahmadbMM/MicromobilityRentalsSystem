-- ============================================================================
-- The store catalogue, plus (2026-11-19, store product management build): everything the staff app's Store section
-- needs to manage the catalogue in detail, on BOTH databases (staging, where the store runs, and production, where
-- only the catalogue lives until the store goes live). Its contract is the build's CONTRACT.md, sections 1 to 9
-- (10, the store.* settings, and 11, photos, need no database change).
--
-- The user, 2026-11-19: "how can we add products to the store? make sure to implement everything needed in details
-- in the staff page and allow customizability as much as possible for the staff and add features as much as
-- possible", "i want to be able to add to the store from the current staff website", and "i dont want the store to
-- become live".
--
-- Applied by the lead: staging first, then production, after 20261119400000_store_catalog_base.sql (it stops when
-- public.store_products is missing). Re-runnable: tables and columns "if not exists", constraints, policies and
-- triggers dropped and made again, functions "create or replace", seeds "on conflict do nothing". Run it again after
-- the store's own migrations when the store goes live on production (they put back the read policies and the store
-- functions this file changes).
--
--  1. Mode: staff_store_mode() (staff) answers 'full' where store_orders exists (staging) and 'catalog' elsewhere
--     (production). The staff app shows only the catalogue screens in catalog mode.
--  2. Visibility: store_products.preview (shown on the staging website only, marked Preview, never buyable),
--     publish_at / unpublish_at (a schedule); _store_live(p) = published and inside its schedule. The public read
--     policies of store_products and store_variants show live and preview products (staff see all). Buyable = live.
--  3. Categories made by staff (store_categories, two levels, a template and filters each), seeded with the six the
--     staff app shows today; store_products.category becomes a foreign key to them (the fixed check goes);
--     staff_store_category_delete moves a category's products and deletes it. 'gift' stays (STORE_CAT_GIFT).
--  4. Collections (store_collections, store_collection_items) and store_bestsellers (anyone; '[]' without orders).
--  5. More product fields (badge, SEO, max per order, pre-order with a ships-on date, weight, dimensions, tags,
--     low-stock level) and store_variants.barcode. Trigger store_products_tidy trims the tags.
--  6. Staff-only data: store_suppliers, store_product_private (supplier, cost, staff note), store_variant_costs.
--  7. Stock moves: store_stock_moves, written by the trigger store_variants_stock_log on every stock change (the
--     reason from the local setting mm.stock_reason, else 'edit' for staff and 'order' for everyone else), and
--     staff_store_stock_move / _count / _receive / _moves.
--  8. Product operations: staff_store_duplicate, staff_store_import (CSV rows; dry run; all or nothing),
--     staff_store_bulk, staff_store_sort.
--  9. staff_store_report: stock value, products by state and category, stock moves, and sales where orders exist.
--  S. Staging only (where store_orders exists; dynamic SQL, so production never parses it): the functions that tested
--     "published" now test _store_live (_store_quote_json, staff_store_quote_save, store_promo_check,
--     store_stock_request, store_checkout, store_rode_type, store_fleet_record); store_checkout refuses more than a
--     product's max per order (STORE_MAX_QTY: <product>), an order under store.minOrder (STORE_MIN_ORDER) and sells a
--     pre-order product beyond its stock (the line flagged preorder, stock down by what is there, never below zero,
--     store_order_items.stock_taken = what it took); _store_order_json shows each line's preorder and its product's
--     ships_on; _store_restock puts back what a line took and logs it as 'cancel'. store_promo_check and
--     staff_store_quote_save let a pre-order product past its stock too, as checkout does.
--     Rebuilt from the text in this repo (never prosrc), each keeping SECURITY DEFINER, its search_path and grants:
--       _store_quote_json, staff_store_quote_save, store_rode_type, store_fleet_record, _store_order_json
--                                     20261119300000_sx_do_all.sql
--       store_promo_check, store_stock_request   20261115235500_store_build.sql
--       store_checkout                           20261119000800_bh18_r2stg_staging.sql
--       _store_restock                           20261110150000_online_payments.sql
--     store_checkout_plus (20261119300000) calls store_checkout and is not changed. Non-ASCII literals of those texts
--     (Arabic digits, the Arabic name of Jeddah, the middle dot, the bullet) are written as chr() so this file stays
--     ASCII; they make the same strings.
--
-- Rollback idea: drop the functions and triggers this file adds; drop the tables store_stock_moves,
-- store_variant_costs, store_product_private, store_suppliers, store_collection_items, store_collections; put
-- store_products_category_check back (after moving products to the six) and drop store_products_category_fkey, then
-- store_categories; drop the new columns; put back the two read policies with "published"; on staging run the
-- functions' blocks of the files named above again and drop store_order_items.preorder / stock_taken.
-- Tested on a throwaway local Postgres 17: a production-like database (stubs, the base, this file twice) and a
-- staging-like one (the store's migrations in order, the base, this file twice), with rule tests for every part.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $pre$
begin
  if to_regclass('public.store_products') is null or to_regclass('public.store_variants') is null then
    raise exception 'store_catalog_plus needs public.store_products and public.store_variants: apply 20261119400000_store_catalog_base.sql first';
  end if;
  if to_regclass('public.store_orders') is not null
     and not exists (select 1 from supabase_migrations.schema_migrations where version = '20261119300000') then
    raise exception 'store_catalog_plus rebuilds store functions from 20261119300000_sx_do_all.sql: apply that file first here';
  end if;
end $pre$;

-- === 1. Mode =====================================================================================
create or replace function public.staff_store_mode() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return case when to_regclass('public.store_orders') is not null then 'full' else 'catalog' end;
end $$;
revoke all on function public.staff_store_mode() from public, anon;
grant execute on function public.staff_store_mode() to authenticated;

-- === 2 + 5. Product columns ======================================================================
alter table public.store_products add column if not exists preview boolean not null default false;
alter table public.store_products add column if not exists publish_at timestamptz;
alter table public.store_products add column if not exists unpublish_at timestamptz;
alter table public.store_products add column if not exists badge text;
alter table public.store_products add column if not exists badge_en text;
alter table public.store_products add column if not exists badge_ar text;
alter table public.store_products add column if not exists badge_until date;
alter table public.store_products add column if not exists seo_title_en text;
alter table public.store_products add column if not exists seo_title_ar text;
alter table public.store_products add column if not exists seo_desc_en text;
alter table public.store_products add column if not exists seo_desc_ar text;
alter table public.store_products add column if not exists max_per_order int;
alter table public.store_products add column if not exists preorder boolean not null default false;
alter table public.store_products add column if not exists ships_on date;
alter table public.store_products add column if not exists weight_g int;
alter table public.store_products add column if not exists dims_cm jsonb;
alter table public.store_products add column if not exists tags text[] not null default '{}';
alter table public.store_products add column if not exists low_stock_at int;

-- Tags: at most 12, each 1-30 characters with no space at either end (store_products_tidy trims them first).
create or replace function public._store_tags_ok(p text[]) returns boolean
language sql immutable security definer set search_path = public as $$
  select p is not null and coalesce(cardinality(p), 0) <= 12
     and not exists (select 1 from unnest(p) t where t is null or t <> btrim(t) or length(t) not between 1 and 30)
$$;
revoke all on function public._store_tags_ok(text[]) from public, anon;
grant execute on function public._store_tags_ok(text[]) to authenticated;   -- the check below runs as the writer

alter table public.store_products drop constraint if exists store_products_schedule_check;
alter table public.store_products add constraint store_products_schedule_check
  check (publish_at is null or unpublish_at is null or unpublish_at > publish_at);
alter table public.store_products drop constraint if exists store_products_badge_check;
alter table public.store_products add constraint store_products_badge_check
  check ((badge is null or badge in ('new', 'best', 'limited', 'exclusive', 'sale', 'custom'))
         and (badge_en is null or length(badge_en) <= 24) and (badge_ar is null or length(badge_ar) <= 24)
         and (badge is distinct from 'custom' or coalesce(btrim(badge_en), '') <> '' or coalesce(btrim(badge_ar), '') <> ''));
alter table public.store_products drop constraint if exists store_products_seo_check;
alter table public.store_products add constraint store_products_seo_check
  check ((seo_title_en is null or length(seo_title_en) <= 70) and (seo_title_ar is null or length(seo_title_ar) <= 70)
         and (seo_desc_en is null or length(seo_desc_en) <= 170) and (seo_desc_ar is null or length(seo_desc_ar) <= 170));
alter table public.store_products drop constraint if exists store_products_max_per_order_check;
alter table public.store_products add constraint store_products_max_per_order_check check (max_per_order is null or max_per_order between 1 and 99);
alter table public.store_products drop constraint if exists store_products_weight_g_check;
alter table public.store_products add constraint store_products_weight_g_check check (weight_g is null or weight_g between 1 and 200000);
alter table public.store_products drop constraint if exists store_products_dims_cm_check;
alter table public.store_products add constraint store_products_dims_cm_check
  check (dims_cm is null or case when jsonb_typeof(dims_cm) = 'object' and pg_column_size(dims_cm) < 200
                                      and jsonb_typeof(dims_cm -> 'l') = 'number' and jsonb_typeof(dims_cm -> 'w') = 'number'
                                      and jsonb_typeof(dims_cm -> 'h') = 'number'
                                 then (dims_cm ->> 'l')::numeric between 1 and 400 and (dims_cm ->> 'w')::numeric between 1 and 400
                                      and (dims_cm ->> 'h')::numeric between 1 and 400
                                 else false end);
alter table public.store_products drop constraint if exists store_products_tags_check;
alter table public.store_products add constraint store_products_tags_check check (_store_tags_ok(tags));
alter table public.store_products drop constraint if exists store_products_low_stock_at_check;
alter table public.store_products add constraint store_products_low_stock_at_check check (low_stock_at is null or low_stock_at between 0 and 1000);

alter table public.store_variants add column if not exists barcode text;
alter table public.store_variants drop constraint if exists store_variants_barcode_check;
alter table public.store_variants add constraint store_variants_barcode_check check (barcode is null or barcode ~ '^[0-9]{8,14}$');
do $bk$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.store_variants'::regclass and conname = 'store_variants_barcode_key') then
    alter table public.store_variants add constraint store_variants_barcode_key unique (barcode);
  end if;
end $bk$;

-- Tags kept tidy: trimmed, empty ones dropped, each once (the first spelling kept).
create or replace function public._store_product_tidy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.tags is distinct from old.tags then
    new.tags := coalesce(array(select x from (select btrim(t) x, min(k) k from unnest(coalesce(new.tags, '{}'::text[])) with ordinality u(t, k)
                                              where t is not null and btrim(t) <> '' group by btrim(t)) y order by k), '{}'::text[]);
  end if;
  return new;
end $$;
revoke all on function public._store_product_tidy() from public, anon, authenticated;
drop trigger if exists store_products_tidy on public.store_products;
create trigger store_products_tidy before insert or update on public.store_products for each row execute function _store_product_tidy();

-- === 2. Live, preview, scheduled =================================================================
create or replace function public._store_live(p public.store_products) returns boolean
language sql stable security definer set search_path = public as $$
  select p.published and (p.publish_at is null or p.publish_at <= now()) and (p.unpublish_at is null or p.unpublish_at > now())
$$;
revoke all on function public._store_live(public.store_products) from public, anon;
grant execute on function public._store_live(public.store_products) to anon, authenticated;

drop policy if exists "store products public read" on public.store_products;
create policy "store products public read" on public.store_products for select to anon, authenticated
  using (_store_live(store_products) or preview or (select is_staff()));
drop policy if exists "store variants public read" on public.store_variants;
create policy "store variants public read" on public.store_variants for select to anon, authenticated
  using ((select is_staff()) or (active and exists (select 1 from store_products p where p.id = store_variants.product_id
                                                     and (_store_live(p) or p.preview))));

-- === 3. Categories ===============================================================================
create table if not exists public.store_categories (
  slug         text primary key,
  parent       text,
  name_en      text not null,
  name_ar      text,
  blurb_en     text,
  blurb_ar     text,
  image        text,
  sort         int not null default 0,
  visible      boolean not null default true,
  seo_title_en text,
  seo_title_ar text,
  seo_desc_en  text,
  seo_desc_ar  text,
  template     jsonb not null default '{}'::jsonb,
  filters      jsonb not null default '["brand","size","colour","price","instock"]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.store_categories drop constraint if exists store_categories_slug_check;
alter table public.store_categories add constraint store_categories_slug_check
  check (slug ~ '^[a-z][a-z0-9-]{1,40}$'
         and slug not in ('cart', 'checkout', 'order', 'track', 'saved', 'category', 'collection', 'gift-card', 'preview'));
alter table public.store_categories drop constraint if exists store_categories_parent_fkey;
alter table public.store_categories add constraint store_categories_parent_fkey
  foreign key (parent) references public.store_categories (slug) on update cascade on delete restrict;
alter table public.store_categories drop constraint if exists store_categories_parent_check;
alter table public.store_categories add constraint store_categories_parent_check check (parent is distinct from slug);
alter table public.store_categories drop constraint if exists store_categories_text_check;
alter table public.store_categories add constraint store_categories_text_check
  check (length(btrim(name_en)) >= 1 and length(name_en) <= 60 and (name_ar is null or length(name_ar) <= 60)
         and (blurb_en is null or length(blurb_en) <= 400) and (blurb_ar is null or length(blurb_ar) <= 400)
         and (seo_title_en is null or length(seo_title_en) <= 70) and (seo_title_ar is null or length(seo_title_ar) <= 70)
         and (seo_desc_en is null or length(seo_desc_en) <= 170) and (seo_desc_ar is null or length(seo_desc_ar) <= 170));
alter table public.store_categories drop constraint if exists store_categories_image_check;
alter table public.store_categories add constraint store_categories_image_check
  check (image is null or image ~ '^/(media|site)/[A-Za-z0-9_./-]{1,200}$');
alter table public.store_categories drop constraint if exists store_categories_template_check;
alter table public.store_categories add constraint store_categories_template_check
  check (case when jsonb_typeof(template) = 'object' and pg_column_size(template) < 6000 then
           (case when jsonb_typeof(template -> 'specs') = 'array' then jsonb_array_length(template -> 'specs') <= 20 else not (template ? 'specs') end)
           and (case when jsonb_typeof(template -> 'keys') = 'array' then jsonb_array_length(template -> 'keys') <= 6 else not (template ? 'keys') end)
           and (case when jsonb_typeof(template -> 'box') = 'array' then jsonb_array_length(template -> 'box') <= 12 else not (template ? 'box') end)
           and (not (template ? 'warranty_months') or jsonb_typeof(template -> 'warranty_months') in ('number', 'null'))
           and (not (template ? 'ship_ksa') or jsonb_typeof(template -> 'ship_ksa') in ('boolean', 'null'))
         else false end);
alter table public.store_categories drop constraint if exists store_categories_filters_check;
alter table public.store_categories add constraint store_categories_filters_check
  check (jsonb_typeof(filters) = 'array' and pg_column_size(filters) < 1000
         and filters <@ '["brand","size","colour","price","instock","sale","condition","tags"]'::jsonb);
create index if not exists store_categories_parent on public.store_categories (parent) where parent is not null;

-- Two levels only; 'gift' (gift cards) has no parent and no children and is never deleted or given another slug.
create or replace function public._store_cat_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.slug = 'gift' then raise exception 'STORE_CAT_GIFT' using errcode = 'P0001'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.slug = 'gift' and new.slug is distinct from 'gift' then
    raise exception 'STORE_CAT_GIFT' using errcode = 'P0001';
  end if;
  if (new.slug = 'gift' and new.parent is not null) or new.parent = 'gift' then
    raise exception 'STORE_CAT_GIFT' using errcode = 'P0001';
  end if;
  if new.parent is not null then
    if exists (select 1 from store_categories c where c.slug = new.parent and c.parent is not null) then
      raise exception 'STORE_CAT_LEVEL' using errcode = 'P0001';
    end if;
    if exists (select 1 from store_categories c where c.parent = case when tg_op = 'UPDATE' then old.slug else new.slug end) then
      raise exception 'STORE_CAT_LEVEL' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
revoke all on function public._store_cat_guard() from public, anon, authenticated;
drop trigger if exists store_categories_guard on public.store_categories;
create trigger store_categories_guard before insert or update or delete on public.store_categories
  for each row execute function _store_cat_guard();
drop trigger if exists store_categories_touch on public.store_categories;
create trigger store_categories_touch before update on public.store_categories for each row execute function _store_touch();

-- The six the staff app shows today (STO_CAT keys, English and Arabic), written as UTF-8 hex to keep this file ASCII.
insert into public.store_categories (slug, name_en, name_ar, sort, template) values
  ('bikes', 'Bikes', convert_from(decode('d8afd8b1d8a7d8acd8a7d8aa', 'hex'), 'UTF8'), 10, '{}'),
  ('accessories', 'Accessories', convert_from(decode('d8a5d983d8b3d8b3d988d8a7d8b1d8a7d8aa', 'hex'), 'UTF8'), 20, '{}'),
  ('apparel', 'Apparel', convert_from(decode('d985d984d8a7d8a8d8b3', 'hex'), 'UTF8'), 30, '{}'),
  ('parts', 'Parts', convert_from(decode('d982d8b7d8b920d8bad98ad8a7d8b1', 'hex'), 'UTF8'), 40, '{}'),
  ('nutrition', 'Nutrition', convert_from(decode('d8aad8bad8b0d98ad8a9', 'hex'), 'UTF8'), 50, '{}'),
  ('gift', 'Gift cards', convert_from(decode('d8a8d8b7d8a7d982d8a7d8aa20d987d8afd8a7d98ad8a7', 'hex'), 'UTF8'), 60, '{}')
on conflict (slug) do nothing;

alter table public.store_categories enable row level security;
revoke all on public.store_categories from anon, authenticated;
drop policy if exists "store categories public read" on public.store_categories;
create policy "store categories public read" on public.store_categories for select to anon, authenticated
  using (visible or (select is_staff()));
drop policy if exists "store categories admin insert" on public.store_categories;
create policy "store categories admin insert" on public.store_categories for insert to authenticated with check ((select is_admin()));
drop policy if exists "store categories admin update" on public.store_categories;
create policy "store categories admin update" on public.store_categories for update to authenticated
  using ((select is_admin())) with check ((select is_admin()));
drop policy if exists "store categories admin delete" on public.store_categories;
create policy "store categories admin delete" on public.store_categories for delete to authenticated using ((select is_admin()));
grant select on public.store_categories to anon;
grant select, insert, update, delete on public.store_categories to authenticated;

-- A product's category is one of them (a sub-category too); the fixed list goes.
alter table public.store_products drop constraint if exists store_products_category_check;
alter table public.store_products drop constraint if exists store_products_category_fkey;
alter table public.store_products add constraint store_products_category_fkey
  foreign key (category) references public.store_categories (slug) on update cascade on delete restrict;
create index if not exists store_products_category on public.store_products (category);

-- Delete a category (admins): its products move to p_move_to first (required when it has any). Answers how many moved.
create or replace function public.staff_store_category_delete(p_slug text, p_move_to text default null) returns int
language plpgsql security definer set search_path = public as $$
declare c store_categories%rowtype; n int;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if p_slug = 'gift' then raise exception 'STORE_CAT_GIFT' using errcode = 'P0001'; end if;
  select * into c from store_categories where slug = p_slug for update;
  if c.slug is null then raise exception 'STORE_CAT' using errcode = 'P0001'; end if;
  if exists (select 1 from store_categories x where x.parent = c.slug) then raise exception 'STORE_CAT_CHILDREN' using errcode = 'P0001'; end if;
  if p_move_to is not null
     and (p_move_to = 'gift' or p_move_to = c.slug or not exists (select 1 from store_categories x where x.slug = p_move_to)) then
    raise exception 'STORE_CAT_MOVE' using errcode = 'P0001';
  end if;
  select count(*) into n from store_products where category = c.slug;
  if n > 0 then
    if p_move_to is null then raise exception 'STORE_CAT_MOVE' using errcode = 'P0001'; end if;
    update store_products set category = p_move_to where category = c.slug;
  end if;
  delete from store_categories where slug = c.slug;
  return n;
end $$;
revoke all on function public.staff_store_category_delete(text, text) from public, anon;
grant execute on function public.staff_store_category_delete(text, text) to authenticated;

-- === 4. Collections ==============================================================================
create table if not exists public.store_collections (
  slug         text primary key,
  name_en      text not null,
  name_ar      text,
  blurb_en     text,
  blurb_ar     text,
  image        text,
  sort         int not null default 0,
  visible      boolean not null default true,
  on_store     boolean not null default false,
  starts_on    date,
  ends_on      date,
  kind         text not null default 'manual',
  days         int not null default 30,
  max_items    int not null default 12,
  seo_title_en text,
  seo_title_ar text,
  seo_desc_en  text,
  seo_desc_ar  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.store_collections drop constraint if exists store_collections_slug_check;
alter table public.store_collections add constraint store_collections_slug_check
  check (slug ~ '^[a-z][a-z0-9-]{1,40}$'
         and slug not in ('cart', 'checkout', 'order', 'track', 'saved', 'category', 'collection', 'gift-card', 'preview'));
alter table public.store_collections drop constraint if exists store_collections_text_check;
alter table public.store_collections add constraint store_collections_text_check
  check (length(btrim(name_en)) >= 1 and length(name_en) <= 60 and (name_ar is null or length(name_ar) <= 60)
         and (blurb_en is null or length(blurb_en) <= 400) and (blurb_ar is null or length(blurb_ar) <= 400)
         and (seo_title_en is null or length(seo_title_en) <= 70) and (seo_title_ar is null or length(seo_title_ar) <= 70)
         and (seo_desc_en is null or length(seo_desc_en) <= 170) and (seo_desc_ar is null or length(seo_desc_ar) <= 170));
alter table public.store_collections drop constraint if exists store_collections_image_check;
alter table public.store_collections add constraint store_collections_image_check
  check (image is null or image ~ '^/(media|site)/[A-Za-z0-9_./-]{1,200}$');
alter table public.store_collections drop constraint if exists store_collections_dates_check;
alter table public.store_collections add constraint store_collections_dates_check
  check (starts_on is null or ends_on is null or ends_on >= starts_on);
alter table public.store_collections drop constraint if exists store_collections_kind_check;
alter table public.store_collections add constraint store_collections_kind_check
  check (kind in ('manual', 'new', 'sale', 'best') and days between 1 and 365 and max_items between 1 and 48);
drop trigger if exists store_collections_touch on public.store_collections;
create trigger store_collections_touch before update on public.store_collections for each row execute function _store_touch();

create table if not exists public.store_collection_items (
  collection text not null references public.store_collections (slug) on update cascade on delete cascade,
  product_id uuid not null references public.store_products (id) on delete cascade,
  sort       int not null default 0,
  primary key (collection, product_id)
);
create index if not exists store_collection_items_product on public.store_collection_items (product_id);

alter table public.store_collections enable row level security;
alter table public.store_collection_items enable row level security;
revoke all on public.store_collections, public.store_collection_items from anon, authenticated;
drop policy if exists "store collections public read" on public.store_collections;
create policy "store collections public read" on public.store_collections for select to anon, authenticated
  using ((visible and (starts_on is null or starts_on <= current_date) and (ends_on is null or ends_on >= current_date))
         or (select is_staff()));
drop policy if exists "store collections admin insert" on public.store_collections;
create policy "store collections admin insert" on public.store_collections for insert to authenticated with check ((select is_admin()));
drop policy if exists "store collections admin update" on public.store_collections;
create policy "store collections admin update" on public.store_collections for update to authenticated
  using ((select is_admin())) with check ((select is_admin()));
drop policy if exists "store collections admin delete" on public.store_collections;
create policy "store collections admin delete" on public.store_collections for delete to authenticated using ((select is_admin()));
-- an item is read where its collection is (the subquery reads store_collections under its own policy)
drop policy if exists "store collection items public read" on public.store_collection_items;
create policy "store collection items public read" on public.store_collection_items for select to anon, authenticated
  using ((select is_staff()) or exists (select 1 from store_collections c where c.slug = store_collection_items.collection));
drop policy if exists "store collection items admin insert" on public.store_collection_items;
create policy "store collection items admin insert" on public.store_collection_items for insert to authenticated with check ((select is_admin()));
drop policy if exists "store collection items admin update" on public.store_collection_items;
create policy "store collection items admin update" on public.store_collection_items for update to authenticated
  using ((select is_admin())) with check ((select is_admin()));
drop policy if exists "store collection items admin delete" on public.store_collection_items;
create policy "store collection items admin delete" on public.store_collection_items for delete to authenticated using ((select is_admin()));
grant select on public.store_collections, public.store_collection_items to anon;
grant select, insert, update, delete on public.store_collections, public.store_collection_items to authenticated;

-- Best sellers: the live products sold most in the last p_days (1-365, 30), as [{product_id, units}] (p_limit 1-48, 12),
-- from orders paid and later (never pending, cancelled or refunded). '[]' where there are no orders (production).
create or replace function public.store_bestsellers(p_days int default 30, p_limit int default 12) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if to_regclass('public.store_order_items') is null or to_regclass('public.store_orders') is null then return '[]'::jsonb; end if;
  execute $q$
    select coalesce(jsonb_agg(jsonb_build_object('product_id', x.product_id, 'units', x.units) order by x.units desc, x.product_id), '[]'::jsonb)
      from (select i.product_id, sum(i.qty)::int units
              from store_order_items i
              join store_orders o on o.id = i.order_id
              join store_products p on p.id = i.product_id
             where o.status in ('paid', 'preparing', 'ready', 'shipped', 'out', 'delivered')
               and coalesce(o.paid_at, o.created_at) >= now() - make_interval(days => $1)
               and _store_live(p)
             group by i.product_id
             order by sum(i.qty) desc, i.product_id
             limit $2) x
  $q$ into r using greatest(1, least(coalesce(p_days, 30), 365)), greatest(1, least(coalesce(p_limit, 12), 48));
  return coalesce(r, '[]'::jsonb);
end $$;
revoke all on function public.store_bestsellers(int, int) from public;
grant execute on function public.store_bestsellers(int, int) to anon, authenticated;

-- === 6. Staff-only data ==========================================================================
create table if not exists public.store_suppliers (
  id         bigint generated always as identity primary key,
  name       text not null unique,
  contact    text,
  phone      text,
  email      text,
  website    text,
  note       text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.store_suppliers drop constraint if exists store_suppliers_text_check;
alter table public.store_suppliers add constraint store_suppliers_text_check
  check (length(btrim(name)) between 1 and 80 and length(name) <= 80 and (contact is null or length(contact) <= 80)
         and (phone is null or length(phone) <= 30) and (email is null or length(email) <= 120)
         and (website is null or length(website) <= 200) and (note is null or length(note) <= 1000));
drop trigger if exists store_suppliers_touch on public.store_suppliers;
create trigger store_suppliers_touch before update on public.store_suppliers for each row execute function _store_touch();

create table if not exists public.store_product_private (
  product_id   uuid primary key references public.store_products (id) on delete cascade,
  supplier_id  bigint references public.store_suppliers (id) on delete set null,
  supplier_sku text,
  cost         numeric(10,2),
  staff_note   text,
  updated_at   timestamptz not null default now()
);
alter table public.store_product_private drop constraint if exists store_product_private_check;
alter table public.store_product_private add constraint store_product_private_check
  check ((supplier_sku is null or length(supplier_sku) <= 60) and (cost is null or cost between 0 and 100000)
         and (staff_note is null or length(staff_note) <= 2000));
create index if not exists store_product_private_supplier on public.store_product_private (supplier_id) where supplier_id is not null;
drop trigger if exists store_product_private_touch on public.store_product_private;
create trigger store_product_private_touch before update on public.store_product_private for each row execute function _store_touch();

create table if not exists public.store_variant_costs (
  variant_id uuid primary key references public.store_variants (id) on delete cascade,
  cost       numeric(10,2) not null,
  updated_at timestamptz not null default now()
);
alter table public.store_variant_costs drop constraint if exists store_variant_costs_cost_check;
alter table public.store_variant_costs add constraint store_variant_costs_cost_check check (cost between 0 and 100000);
drop trigger if exists store_variant_costs_touch on public.store_variant_costs;
create trigger store_variant_costs_touch before update on public.store_variant_costs for each row execute function _store_touch();

alter table public.store_suppliers enable row level security;
alter table public.store_product_private enable row level security;
alter table public.store_variant_costs enable row level security;
revoke all on public.store_suppliers, public.store_product_private, public.store_variant_costs from anon, authenticated;
do $pol$
declare t text; nm text;
begin
  foreach t in array array['store_suppliers', 'store_product_private', 'store_variant_costs'] loop
    nm := replace(t, '_', ' ');
    execute format('drop policy if exists %I on public.%I', nm || ' staff read', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select is_staff()))', nm || ' staff read', t);
    execute format('drop policy if exists %I on public.%I', nm || ' admin insert', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select is_admin()))', nm || ' admin insert', t);
    execute format('drop policy if exists %I on public.%I', nm || ' admin update', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select is_admin())) with check ((select is_admin()))', nm || ' admin update', t);
    execute format('drop policy if exists %I on public.%I', nm || ' admin delete', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select is_admin()))', nm || ' admin delete', t);
  end loop;
end $pol$;
grant select, insert, update, delete on public.store_suppliers, public.store_product_private, public.store_variant_costs to authenticated;

-- === 7. Stock moves ==============================================================================
create table if not exists public.store_stock_moves (
  id          bigint generated always as identity primary key,
  variant_id  uuid references public.store_variants (id) on delete set null,
  product_id  uuid,
  label       text,
  delta       int not null,
  stock_after int not null,
  reason      text not null,
  note        text,
  supplier_id bigint references public.store_suppliers (id) on delete set null,
  unit_cost   numeric(10,2),
  ref         text,
  by_name     text,
  at          timestamptz not null default now()
);
alter table public.store_stock_moves drop constraint if exists store_stock_moves_reason_check;
alter table public.store_stock_moves add constraint store_stock_moves_reason_check
  check (reason in ('receive', 'count', 'damaged', 'lost', 'return', 'order', 'cancel', 'edit', 'import', 'other'));
alter table public.store_stock_moves drop constraint if exists store_stock_moves_text_check;
alter table public.store_stock_moves add constraint store_stock_moves_text_check
  check ((note is null or length(note) <= 300) and (ref is null or length(ref) <= 60) and (label is null or length(label) <= 200)
         and (by_name is null or length(by_name) <= 60));
create index if not exists store_stock_moves_variant on public.store_stock_moves (variant_id, at desc);
create index if not exists store_stock_moves_at on public.store_stock_moves (at desc);
alter table public.store_stock_moves enable row level security;
revoke all on public.store_stock_moves from anon, authenticated;
drop policy if exists "store stock moves staff read" on public.store_stock_moves;
create policy "store stock moves staff read" on public.store_stock_moves for select to authenticated using ((select is_staff()));
grant select on public.store_stock_moves to authenticated;
-- the two identity sequences: nobody but the functions and admins' inserts moves them (an insert needs no sequence
-- right; a client's setval could make the next number clash)
revoke all on sequence public.store_suppliers_id_seq, public.store_stock_moves_id_seq from anon, authenticated;

-- Every stock change is a move. The reason, note, reference, supplier and unit cost come from the transaction's local
-- settings mm.stock_reason / mm.stock_note / mm.stock_ref / mm.stock_supplier / mm.stock_cost (the functions below set
-- and clear them); without a reason a staff member's change is 'edit' and anyone else's (a checkout) 'order'.
create or replace function public._store_stock_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare d int; r text := nullif(current_setting('mm.stock_reason', true), ''); who text; lbl text; sup bigint; cst numeric;
        s text;
begin
  if tg_op = 'INSERT' then d := new.stock; if coalesce(d, 0) <= 0 then return null; end if;
  else d := new.stock - old.stock; if coalesce(d, 0) = 0 then return null; end if;
  end if;
  r := coalesce(r, case when is_staff() then 'edit' else 'order' end);
  if r not in ('receive', 'count', 'damaged', 'lost', 'return', 'order', 'cancel', 'edit', 'import', 'other') then r := 'other'; end if;
  select left(coalesce(nullif(btrim(st.display_name), ''), 'Staff'), 60) into who from staff st where st.user_id = auth.uid();
  select left(concat_ws(' ' || chr(183) || ' ', p.name_en, nullif(new.size, ''), nullif(new.color_en, '')), 200) into lbl
    from store_products p where p.id = new.product_id;
  s := current_setting('mm.stock_supplier', true);
  if s ~ '^[0-9]{1,18}$' then select x.id into sup from store_suppliers x where x.id = s::bigint; end if;
  s := current_setting('mm.stock_cost', true);
  if s ~ '^[0-9]{1,6}([.][0-9]{1,2})?$' then cst := s::numeric; end if;
  insert into store_stock_moves (variant_id, product_id, label, delta, stock_after, reason, note, supplier_id, unit_cost, ref, by_name)
  values (new.id, new.product_id, lbl, d, new.stock, r, left(nullif(btrim(coalesce(current_setting('mm.stock_note', true), '')), ''), 300),
          sup, cst, left(nullif(btrim(coalesce(current_setting('mm.stock_ref', true), '')), ''), 60), who);
  return null;
end $$;
revoke all on function public._store_stock_log() from public, anon, authenticated;
drop trigger if exists store_variants_stock_log on public.store_variants;
create trigger store_variants_stock_log after insert or update of stock on public.store_variants
  for each row execute function _store_stock_log();

-- A move staff make by hand: receive, damaged, lost, return or other, by p_delta (1-10000 either way), never below zero.
-- Answers {id (the variant), stock, move}.
create or replace function public.staff_store_stock_move(p_variant uuid, p_delta int, p_reason text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v store_variants%rowtype; mv bigint;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_reason is null or p_reason not in ('receive', 'damaged', 'lost', 'return', 'other') then raise exception 'STORE_REASON' using errcode = 'P0001'; end if;
  if p_delta is null or abs(p_delta) not between 1 and 10000 then raise exception 'STORE_STOCK' using errcode = 'P0001'; end if;
  perform set_config('mm.stock_reason', p_reason, true);
  perform set_config('mm.stock_note', coalesce(left(nullif(btrim(p_note), ''), 300), ''), true);
  update store_variants set stock = stock + p_delta where id = p_variant and stock + p_delta >= 0 returning * into v;
  perform set_config('mm.stock_reason', '', true);
  perform set_config('mm.stock_note', '', true);
  if v.id is null then raise exception 'STORE_STOCK' using errcode = 'P0001'; end if;
  select max(m.id) into mv from store_stock_moves m where m.variant_id = v.id;
  return jsonb_build_object('id', v.id, 'stock', v.stock, 'move', mv);
end $$;
revoke all on function public.staff_store_stock_move(uuid, int, text, text) from public, anon;
grant execute on function public.staff_store_stock_move(uuid, int, text, text) to authenticated;

-- A count: the stock becomes p_count (0-100000). A count that finds what was there is still written (delta 0), so the
-- history says when it was last counted. Answers {id (the variant), stock, move}.
create or replace function public.staff_store_stock_count(p_variant uuid, p_count int, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v store_variants%rowtype; was int; mv bigint; who text; lbl text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_count is null or p_count not between 0 and 100000 then raise exception 'STORE_STOCK' using errcode = 'P0001'; end if;
  select x.stock into was from store_variants x where x.id = p_variant for update;
  if was is null then raise exception 'STORE_STOCK' using errcode = 'P0001'; end if;
  perform set_config('mm.stock_reason', 'count', true);
  perform set_config('mm.stock_note', coalesce(left(nullif(btrim(p_note), ''), 300), ''), true);
  update store_variants set stock = p_count where id = p_variant returning * into v;
  perform set_config('mm.stock_reason', '', true);
  perform set_config('mm.stock_note', '', true);
  if was = p_count then
    select left(coalesce(nullif(btrim(st.display_name), ''), 'Staff'), 60) into who from staff st where st.user_id = auth.uid();
    select left(concat_ws(' ' || chr(183) || ' ', p.name_en, nullif(v.size, ''), nullif(v.color_en, '')), 200) into lbl
      from store_products p where p.id = v.product_id;
    insert into store_stock_moves (variant_id, product_id, label, delta, stock_after, reason, note, by_name)
    values (v.id, v.product_id, lbl, 0, v.stock, 'count', left(nullif(btrim(p_note), ''), 300), who);
  end if;
  select max(m.id) into mv from store_stock_moves m where m.variant_id = v.id;
  return jsonb_build_object('id', v.id, 'stock', v.stock, 'move', mv);
end $$;
revoke all on function public.staff_store_stock_count(uuid, int, text) from public, anon;
grant execute on function public.staff_store_stock_count(uuid, int, text) to authenticated;

-- A delivery received: p_items [{variant, qty 1-10000, cost (unit, 0-100000) or null}] (1-200 lines), from a supplier,
-- with its reference and a note; each line is a 'receive' move carrying the supplier, reference and unit cost.
-- p_set_cost (admins) also writes each given cost as the variant's cost. Answers {moves, units}.
-- STORE_RECEIVE (: the line's number) for a line that is not one; STORE_SUPPLIER for a supplier that is not there.
create or replace function public.staff_store_receive(p_items jsonb, p_supplier bigint default null, p_ref text default null,
                                                      p_note text default null, p_set_cost boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare it jsonb; k int := 0; q numeric; c numeric; vid uuid; v store_variants%rowtype; nm int := 0; units int := 0;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if coalesce(p_set_cost, false) and not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 200 then
    raise exception 'STORE_RECEIVE' using errcode = 'P0001';
  end if;
  if p_supplier is not null and not exists (select 1 from store_suppliers s where s.id = p_supplier) then
    raise exception 'STORE_SUPPLIER' using errcode = 'P0001';
  end if;
  perform set_config('mm.stock_reason', 'receive', true);
  perform set_config('mm.stock_supplier', coalesce(p_supplier::text, ''), true);
  perform set_config('mm.stock_ref', coalesce(left(nullif(btrim(p_ref), ''), 60), ''), true);
  perform set_config('mm.stock_note', coalesce(left(nullif(btrim(p_note), ''), 300), ''), true);
  for it in select x from jsonb_array_elements(p_items) x loop
    k := k + 1;
    if jsonb_typeof(it) is distinct from 'object' or coalesce(it ->> 'variant', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(it -> 'qty') is distinct from 'number' or coalesce(jsonb_typeof(it -> 'cost'), 'null') not in ('number', 'null') then
      raise exception 'STORE_RECEIVE: %', k using errcode = 'P0001';
    end if;
    q := (it ->> 'qty')::numeric;
    c := case when jsonb_typeof(it -> 'cost') = 'number' then (it ->> 'cost')::numeric end;
    if q <> trunc(q) or q not between 1 and 10000 or (c is not null and c not between 0 and 100000) then
      raise exception 'STORE_RECEIVE: %', k using errcode = 'P0001';
    end if;
    vid := (it ->> 'variant')::uuid;
    perform set_config('mm.stock_cost', coalesce(round(c, 2)::text, ''), true);
    update store_variants set stock = stock + q::int where id = vid returning * into v;
    if v.id is null then raise exception 'STORE_RECEIVE: %', k using errcode = 'P0001'; end if;
    if coalesce(p_set_cost, false) and c is not null then
      insert into store_variant_costs (variant_id, cost) values (vid, round(c, 2))
      on conflict (variant_id) do update set cost = excluded.cost, updated_at = now();
    end if;
    nm := nm + 1; units := units + q::int;
  end loop;
  perform set_config('mm.stock_reason', '', true);
  perform set_config('mm.stock_supplier', '', true);
  perform set_config('mm.stock_ref', '', true);
  perform set_config('mm.stock_note', '', true);
  perform set_config('mm.stock_cost', '', true);
  return jsonb_build_object('moves', nm, 'units', units);
end $$;
revoke all on function public.staff_store_receive(jsonb, bigint, text, text, boolean) from public, anon;
grant execute on function public.staff_store_receive(jsonb, bigint, text, text, boolean) to authenticated;

-- The history, newest first: one product's, one variant's, one reason's, between two Riyadh days (p_limit 1-1000, 200).
create or replace function public.staff_store_stock_moves(p_product uuid default null, p_variant uuid default null, p_reason text default null,
                                                          p_from date default null, p_to date default null, p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_reason is not null and p_reason not in ('receive', 'count', 'damaged', 'lost', 'return', 'order', 'cancel', 'edit', 'import', 'other') then
    raise exception 'STORE_REASON' using errcode = 'P0001';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'at', m.at, 'variant_id', m.variant_id, 'product_id', m.product_id,
                     'label', m.label, 'delta', m.delta, 'stock_after', m.stock_after, 'reason', m.reason, 'note', m.note,
                     'supplier', s.name, 'unit_cost', m.unit_cost, 'ref', m.ref, 'by_name', m.by_name) order by m.at desc, m.id desc)
                     from (select * from store_stock_moves x
                            where (p_product is null or x.product_id = p_product)
                              and (p_variant is null or x.variant_id = p_variant)
                              and (p_reason is null or x.reason = p_reason)
                              and (p_from is null or (x.at at time zone 'Asia/Riyadh')::date >= p_from)
                              and (p_to is null or (x.at at time zone 'Asia/Riyadh')::date <= p_to)
                            order by x.at desc, x.id desc
                            limit greatest(1, least(coalesce(p_limit, 200), 1000))) m
                     left join store_suppliers s on s.id = m.supplier_id), '[]'::jsonb);
end $$;
revoke all on function public.staff_store_stock_moves(uuid, uuid, text, date, date, int) from public, anon;
grant execute on function public.staff_store_stock_moves(uuid, uuid, text, date, date, int) to authenticated;

-- === 8. Product operations =======================================================================
-- A copy of a product (admins): unpublished, not in preview, unscheduled, under its own slug and English name, with
-- every other column of the product; its variants (no SKU, no barcode, no stock) with their costs; its private row; its
-- collections. Without the discount licence a former price, bundle and sale dates are left off the copy (the licence
-- guard would refuse them). STORE_SLUG (bad or taken), STORE_NAME, STORE_GONE.
create or replace function public.staff_store_duplicate(p_product uuid, p_slug text, p_name_en text) returns uuid
language plpgsql security definer set search_path = public as $$
declare p store_products%rowtype; j jsonb; nid uuid := gen_random_uuid(); sl text := lower(btrim(coalesce(p_slug, '')));
        nm text := btrim(coalesce(p_name_en, '')); cols text; v store_variants%rowtype; vj jsonb; vid uuid; vcols text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  select * into p from store_products where id = p_product;
  if p.id is null then raise exception 'STORE_GONE' using errcode = 'P0001'; end if;
  if sl !~ '^[a-z][a-z0-9-]{1,60}$' or sl in ('cart', 'checkout', 'order', 'track', 'saved', 'category')
     or (sl = 'gift-card' and p.kind <> 'gift_card') or exists (select 1 from store_products x where x.slug = sl) then
    raise exception 'STORE_SLUG' using errcode = 'P0001';
  end if;
  if length(nm) not between 1 and 80 then raise exception 'STORE_NAME' using errcode = 'P0001'; end if;
  j := to_jsonb(p) || jsonb_build_object('id', nid, 'slug', sl, 'name_en', nm, 'published', false, 'preview', false,
                                         'publish_at', null, 'unpublish_at', null, 'created_at', now(), 'updated_at', now(),
                                         'fleet_bike_id', null);
  if _store_licence() is null then
    j := j || jsonb_build_object('compare_at', null, 'bundle', null, 'sale_from', null, 'sale_to', null);
  end if;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into cols
    from pg_attribute a where a.attrelid = 'public.store_products'::regclass and a.attnum > 0 and not a.attisdropped
                          and a.attgenerated = '';
  execute format('insert into store_products (%s) select %s from jsonb_populate_record(null::store_products, $1)', cols, cols) using j;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into vcols
    from pg_attribute a where a.attrelid = 'public.store_variants'::regclass and a.attnum > 0 and not a.attisdropped
                          and a.attgenerated = '';
  for v in select * from store_variants where product_id = p.id order by sort, created_at, id loop
    vid := gen_random_uuid();
    vj := to_jsonb(v) || jsonb_build_object('id', vid, 'product_id', nid, 'sku', null, 'barcode', null, 'stock', 0,
                                            'created_at', now(), 'updated_at', now());
    execute format('insert into store_variants (%s) select %s from jsonb_populate_record(null::store_variants, $1)', vcols, vcols) using vj;
    insert into store_variant_costs (variant_id, cost) select vid, c.cost from store_variant_costs c where c.variant_id = v.id;
  end loop;
  insert into store_product_private (product_id, supplier_id, supplier_sku, cost, staff_note)
  select nid, x.supplier_id, x.supplier_sku, x.cost, x.staff_note from store_product_private x where x.product_id = p.id;
  insert into store_collection_items (collection, product_id, sort)
  select ci.collection, nid, ci.sort from store_collection_items ci where ci.product_id = p.id;
  return nid;
end $$;
revoke all on function public.staff_store_duplicate(uuid, text, text) from public, anon;
grant execute on function public.staff_store_duplicate(uuid, text, text) to authenticated;

-- CSV import (admins). p_rows: one object per VARIANT line (1-2000), keys as the CSV's columns, values strings or numbers.
-- A product is found by slug (made when new: slug, name_en, category and price needed); the first non-empty value of a
-- product field across its lines wins; an empty value changes nothing. A variant is found by sku, else by (product, size,
-- color_en); a line with no variant field touches no variant. stock sets the count (reason 'import'). Suppliers are
-- found by name (any case) and made when new. Images are never imported. p_dry (the default) writes nothing; a real run
-- writes everything or nothing. Answers {ok, dry, products:{created, updated}, variants:{created, updated},
-- suppliers:{created}, errors:[{row, col, code}]} (row: 1-based in p_rows; code: the constraint or a STORE_* name; the
-- counts say what the run did or would do).
create or replace function public.staff_store_import(p_rows jsonb, p_dry boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  pkeys text[] := array['name_en', 'name_ar', 'category', 'brand', 'price', 'compare_at', 'published', 'preview', 'tagline_en',
                        'tagline_ar', 'description_en', 'description_ar', 'tags', 'badge', 'badge_en', 'badge_ar', 'max_per_order',
                        'preorder', 'ships_on', 'weight_g', 'ship_ksa', 'warranty_months', 'condition', 'seo_title_en',
                        'seo_title_ar', 'seo_desc_en', 'seo_desc_ar', 'cost', 'supplier', 'supplier_sku'];
  vkeys text[] := array['sku', 'barcode', 'size', 'color_en', 'color_ar', 'color_hex', 'variant_price', 'stock', 'variant_active',
                        'variant_cost'];
  nums text[] := array['price', 'compare_at', 'cost', 'variant_price', 'variant_cost'];
  ints text[] := array['max_per_order', 'weight_g', 'warranty_months', 'stock'];
  bools text[] := array['published', 'preview', 'preorder', 'ship_ksa', 'variant_active'];
  dry boolean := coalesce(p_dry, true);
  total int; i int; r jsonb; k text; s text; sl text;
  slugs text[] := '{}'; prow jsonb := '{}'::jsonb;   -- slug -> {rows: [n...], f: {key: {v, row}}}
  errs jsonb := '[]'::jsonb; e jsonb;
  pc int := 0; pu int := 0; vc int := 0; vu int := 0; sc int := 0;
  f jsonb; pj jsonb; prv jsonb; vj jsonb; vcost numeric; bad boolean; pid uuid; isnew boolean; cols text; sets text;
  vid uuid; vprod uuid; sup bigint; rown int; cn text; msg text; col text; frow int; ln int;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 2000 then
    raise exception 'STORE_IMPORT' using errcode = 'P0001';
  end if;
  total := jsonb_array_length(p_rows);

  -- pass 1: each line's product (by slug) and the first non-empty value of each product field
  for i in 1 .. total loop
    r := p_rows -> (i - 1);
    if jsonb_typeof(r) is distinct from 'object' then
      errs := errs || jsonb_build_array(jsonb_build_object('row', i, 'col', null, 'code', 'STORE_ROW')); continue;
    end if;
    sl := lower(btrim(coalesce(case when jsonb_typeof(r -> 'slug') in ('string', 'number') then r ->> 'slug' end, '')));
    if sl = '' then
      errs := errs || jsonb_build_array(jsonb_build_object('row', i, 'col', 'slug', 'code', 'STORE_REQUIRED')); continue;
    end if;
    if not prow ? sl then
      slugs := slugs || sl;
      prow := prow || jsonb_build_object(sl, jsonb_build_object('rows', '[]'::jsonb, 'f', '{}'::jsonb));
    end if;
    prow := jsonb_set(prow, array[sl, 'rows'], (prow #> array[sl, 'rows']) || to_jsonb(i));
    foreach k in array pkeys loop
      s := btrim(coalesce(case when jsonb_typeof(r -> k) in ('string', 'number', 'boolean') then r ->> k end, ''));
      if s <> '' and not (prow #> array[sl, 'f']) ? k then
        prow := jsonb_set(prow, array[sl, 'f', k], jsonb_build_object('v', s, 'row', i));
      end if;
    end loop;
  end loop;

  begin
    perform set_config('mm.stock_reason', 'import', true);
    -- pass 2: each product, then its lines' variants
    foreach sl in array slugs loop
      f := prow #> array[sl, 'f'];
      frow := (prow #>> array[sl, 'rows', '0'])::int;
      pj := '{}'::jsonb; prv := '{}'::jsonb; bad := false;
      select x.id into pid from store_products x where x.slug = sl;
      isnew := pid is null;
      foreach k in array pkeys loop
        continue when not f ? k;
        s := f #>> array[k, 'v']; rown := (f #>> array[k, 'row'])::int;
        e := null;
        if k = any(nums) then
          if s !~ '^-?[0-9]{1,9}([.][0-9]+)?$' then e := jsonb_build_object('row', rown, 'col', k, 'code', 'STORE_NUMBER');
          elsif k = 'cost' then prv := prv || jsonb_build_object('cost', round(s::numeric, 2));
          else pj := pj || jsonb_build_object(k, round(s::numeric, 2)); end if;
        elsif k = any(ints) then
          if s !~ '^-?[0-9]{1,9}$' then e := jsonb_build_object('row', rown, 'col', k, 'code', 'STORE_INT');
          else pj := pj || jsonb_build_object(k, s::int); end if;
        elsif k = any(bools) then
          if lower(s) in ('yes', 'true', '1') then pj := pj || jsonb_build_object(k, true);
          elsif lower(s) in ('no', 'false', '0') then pj := pj || jsonb_build_object(k, false);
          else e := jsonb_build_object('row', rown, 'col', k, 'code', 'STORE_BOOL'); end if;
        elsif k = 'ships_on' then
          begin
            if s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'x'; end if;
            pj := pj || jsonb_build_object(k, s::date);
          exception when others then e := jsonb_build_object('row', rown, 'col', k, 'code', 'STORE_DATE');
          end;
        elsif k = 'tags' then
          pj := pj || jsonb_build_object('tags', coalesce((select jsonb_agg(btrim(t) order by n) from unnest(string_to_array(s, '|')) with ordinality u(t, n)
                                                            where btrim(t) <> ''), '[]'::jsonb));
        elsif k = 'category' then
          if not exists (select 1 from store_categories c where c.slug = lower(s)) then
            e := jsonb_build_object('row', rown, 'col', k, 'code', 'STORE_CAT');
          else pj := pj || jsonb_build_object(k, lower(s)); end if;
        elsif k in ('badge', 'condition') then
          pj := pj || jsonb_build_object(k, lower(s));
        elsif k = 'supplier' then
          if length(s) > 80 then e := jsonb_build_object('row', rown, 'col', k, 'code', 'store_suppliers_text_check');
          else prv := prv || jsonb_build_object('supplier', s); end if;
        elsif k = 'supplier_sku' then
          prv := prv || jsonb_build_object('supplier_sku', s);
        else
          pj := pj || jsonb_build_object(k, s);
        end if;
        if e is not null then errs := errs || jsonb_build_array(e); bad := true; end if;
      end loop;
      if isnew then
        foreach k in array array['name_en', 'category', 'price'] loop
          if not f ? k then
            errs := errs || jsonb_build_array(jsonb_build_object('row', frow, 'col', k, 'code', 'STORE_REQUIRED')); bad := true;
          end if;
        end loop;
      end if;
      continue when bad;

      -- the product row (its own savepoint: a refusal is this product's error, and its lines are skipped)
      begin
        if isnew then
          pid := gen_random_uuid();
          pj := pj || jsonb_build_object('id', pid, 'slug', sl);
          select string_agg(quote_ident(x), ', ') into cols from jsonb_object_keys(pj) x;
          execute format('insert into store_products (%s) select %s from jsonb_populate_record(null::store_products, $1)', cols, cols) using pj;
          pc := pc + 1;
        elsif pj <> '{}'::jsonb then
          select string_agg(format('%I = q.%I', x, x), ', ') into sets from jsonb_object_keys(pj) x;
          execute format('update store_products t set %s from jsonb_populate_record(null::store_products, $1) q where t.id = $2', sets) using pj, pid;
          pu := pu + 1;
        end if;
        if prv <> '{}'::jsonb then
          sup := null;
          if prv ? 'supplier' then
            select x.id into sup from store_suppliers x where lower(x.name) = lower(prv ->> 'supplier') order by x.id limit 1;
            if sup is null then
              insert into store_suppliers (name) values (prv ->> 'supplier') returning id into sup;
              sc := sc + 1;
            end if;
          end if;
          insert into store_product_private (product_id, supplier_id, supplier_sku, cost)
          values (pid, sup, prv ->> 'supplier_sku', (prv ->> 'cost')::numeric)
          on conflict (product_id) do update
            set supplier_id = case when prv ? 'supplier' then excluded.supplier_id else store_product_private.supplier_id end,
                supplier_sku = case when prv ? 'supplier_sku' then excluded.supplier_sku else store_product_private.supplier_sku end,
                cost = case when prv ? 'cost' then excluded.cost else store_product_private.cost end;
          if not isnew and pj = '{}'::jsonb then pu := pu + 1; end if;
        end if;
      exception when others then
        get stacked diagnostics cn = constraint_name, msg = message_text;
        col := case when coalesce(cn, '') <> '' then
                 regexp_replace(regexp_replace(cn, '^store_(products|product_private|suppliers)_', ''), '_(check|key|fkey)$', '')
               else nullif(btrim(split_part(msg, ':', 2)), '') end;
        col := case cn when 'store_products_check' then 'compare_at' when 'store_product_private_check' then 'cost'
                       when 'store_suppliers_text_check' then 'supplier' when 'store_suppliers_name_key' then 'supplier'
                       when 'store_products_pkey' then 'slug' else col end;
        errs := errs || jsonb_build_array(jsonb_build_object(
                  'row', coalesce((f #>> array[col, 'row'])::int, frow), 'col', col,
                  'code', coalesce(nullif(cn, ''), nullif(split_part(msg, ':', 1), ''), 'STORE_IMPORT')));
        continue;
      end;

      -- its lines' variants
      for ln in select (x #>> '{}')::int from jsonb_array_elements(prow #> array[sl, 'rows']) x loop
        r := p_rows -> (ln - 1);
        vj := '{}'::jsonb; vcost := null; bad := false;
        foreach k in array vkeys loop
          s := btrim(coalesce(case when jsonb_typeof(r -> k) in ('string', 'number', 'boolean') then r ->> k end, ''));
          continue when s = '';
          e := null;
          if k = any(nums) then
            if s !~ '^-?[0-9]{1,9}([.][0-9]+)?$' then e := jsonb_build_object('row', ln, 'col', k, 'code', 'STORE_NUMBER');
            elsif k = 'variant_cost' then vcost := round(s::numeric, 2);
            else vj := vj || jsonb_build_object('price', round(s::numeric, 2)); end if;
          elsif k = any(ints) then
            if s !~ '^-?[0-9]{1,9}$' then e := jsonb_build_object('row', ln, 'col', k, 'code', 'STORE_INT');
            else vj := vj || jsonb_build_object('stock', s::int); end if;
          elsif k = any(bools) then
            if lower(s) in ('yes', 'true', '1') then vj := vj || jsonb_build_object('active', true);
            elsif lower(s) in ('no', 'false', '0') then vj := vj || jsonb_build_object('active', false);
            else e := jsonb_build_object('row', ln, 'col', k, 'code', 'STORE_BOOL'); end if;
          else
            vj := vj || jsonb_build_object(k, s);
          end if;
          if e is not null then errs := errs || jsonb_build_array(e); bad := true; end if;
        end loop;
        continue when bad or (vj = '{}'::jsonb and vcost is null);
        begin
          vid := null; vprod := null;
          if vj ? 'sku' then
            select x.id, x.product_id into vid, vprod from store_variants x where x.sku = vj ->> 'sku';
            if vid is not null and vprod <> pid then raise exception 'STORE_SKU: sku' using errcode = 'P0001'; end if;
          end if;
          if vid is null then
            select x.id into vid from store_variants x
             where x.product_id = pid and x.size is not distinct from (vj ->> 'size') and x.color_en is not distinct from (vj ->> 'color_en')
             order by x.sort, x.created_at, x.id limit 1;
          end if;
          if vid is null then
            vid := gen_random_uuid();
            vj := vj || jsonb_build_object('id', vid, 'product_id', pid);
            select string_agg(quote_ident(x), ', ') into cols from jsonb_object_keys(vj) x;
            execute format('insert into store_variants (%s) select %s from jsonb_populate_record(null::store_variants, $1)', cols, cols) using vj;
            vc := vc + 1;
          else
            if vj <> '{}'::jsonb then
              select string_agg(format('%I = q.%I', x, x), ', ') into sets from jsonb_object_keys(vj) x;
              execute format('update store_variants t set %s from jsonb_populate_record(null::store_variants, $1) q where t.id = $2', sets) using vj, vid;
            end if;
            vu := vu + 1;
          end if;
          if vcost is not null then
            insert into store_variant_costs (variant_id, cost) values (vid, vcost)
            on conflict (variant_id) do update set cost = excluded.cost, updated_at = now();
          end if;
        exception when others then
          get stacked diagnostics cn = constraint_name, msg = message_text;
          col := case when coalesce(cn, '') <> '' then
                   regexp_replace(regexp_replace(cn, '^store_(variants|variant_costs)_', ''), '_(check|key|fkey)$', '')
                 else nullif(btrim(split_part(msg, ':', 2)), '') end;
          col := case col when 'price' then 'variant_price' when 'active' then 'variant_active' when 'cost' then 'variant_cost' else col end;
          errs := errs || jsonb_build_array(jsonb_build_object('row', ln, 'col', col,
                    'code', coalesce(nullif(cn, ''), nullif(split_part(msg, ':', 1), ''), 'STORE_IMPORT')));
        end;
      end loop;
    end loop;
    perform set_config('mm.stock_reason', '', true);
    -- a dry run, or any error: nothing is kept
    if dry or jsonb_array_length(errs) > 0 then raise exception 'STORE_IMPORT_UNDO' using errcode = 'P0001'; end if;
  exception when raise_exception then
    if sqlerrm <> 'STORE_IMPORT_UNDO' then raise; end if;
  end;

  return jsonb_build_object('ok', jsonb_array_length(errs) = 0, 'dry', dry,
                            'products', jsonb_build_object('created', pc, 'updated', pu),
                            'variants', jsonb_build_object('created', vc, 'updated', vu),
                            'suppliers', jsonb_build_object('created', sc),
                            'errors', (select coalesce(jsonb_agg(x order by n), '[]'::jsonb)
                                         from jsonb_array_elements(errs) with ordinality t(x, n) where n <= 1000));
end $$;
revoke all on function public.staff_store_import(jsonb, boolean) from public, anon;
grant execute on function public.staff_store_import(jsonb, boolean) to authenticated;

-- One change to many products (admins, 1-500 ids); answers how many products (or collection rows) it changed.
-- STORE_BULK for an action it does not know or a value that is not one; the licence guard and the table's checks still
-- apply (one refusal undoes the whole call). price_pct / price_add change the product's price and every variant's own
-- price (2 decimals); a former price that is no longer above the new price is cleared.
create or replace function public.staff_store_bulk(p_ids uuid[], p_action text, p_value jsonb default null) returns int
language plpgsql security definer set search_path = public as $$
declare ids uuid[]; n int := 0; num numeric; t text[]; s text; d date; i int; ts1 timestamptz; ts2 timestamptz; sup bigint; b text;
        v jsonb := case when p_value is null or jsonb_typeof(p_value) = 'null' then null else p_value end;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  select array_agg(distinct x) into ids from unnest(coalesce(p_ids, '{}'::uuid[])) x where x is not null;
  if coalesce(cardinality(ids), 0) not between 1 and 500 or cardinality(p_ids) > 500 then raise exception 'STORE_BULK' using errcode = 'P0001'; end if;
  if p_action = 'publish' then
    update store_products set published = true where id = any(ids); get diagnostics n = row_count;
  elsif p_action = 'unpublish' then
    update store_products set published = false where id = any(ids); get diagnostics n = row_count;
  elsif p_action = 'preview_on' then
    update store_products set preview = true where id = any(ids); get diagnostics n = row_count;
  elsif p_action = 'preview_off' then
    update store_products set preview = false where id = any(ids); get diagnostics n = row_count;
  elsif p_action = 'category' then
    if jsonb_typeof(v) is distinct from 'string' or not exists (select 1 from store_categories c where c.slug = v #>> '{}') then
      raise exception 'STORE_BULK' using errcode = 'P0001';
    end if;
    update store_products set category = v #>> '{}' where id = any(ids); get diagnostics n = row_count;
  elsif p_action in ('price_pct', 'price_add') then
    if jsonb_typeof(v) is distinct from 'number' then raise exception 'STORE_BULK' using errcode = 'P0001'; end if;
    num := (v #>> '{}')::numeric;
    if (p_action = 'price_pct' and num not between -90 and 500) or (p_action = 'price_add' and abs(num) > 100000) then
      raise exception 'STORE_BULK' using errcode = 'P0001';
    end if;
    if p_action = 'price_pct' then
      update store_products set price = round(price * (1 + num / 100), 2),
                                compare_at = case when compare_at > round(price * (1 + num / 100), 2) then compare_at end
       where id = any(ids);
      get diagnostics n = row_count;
      update store_variants set price = round(price * (1 + num / 100), 2) where product_id = any(ids) and price is not null;
    else
      update store_products set price = round(price + num, 2), compare_at = case when compare_at > round(price + num, 2) then compare_at end
       where id = any(ids);
      get diagnostics n = row_count;
      update store_variants set price = round(price + num, 2) where product_id = any(ids) and price is not null;
    end if;
  elsif p_action in ('tags_add', 'tags_remove') then
    if jsonb_typeof(v) is distinct from 'array' or jsonb_array_length(v) not between 1 and 12
       or exists (select 1 from jsonb_array_elements(v) x where jsonb_typeof(x) <> 'string' or btrim(x #>> '{}') = '' or length(btrim(x #>> '{}')) > 30) then
      raise exception 'STORE_BULK' using errcode = 'P0001';
    end if;
    select array_agg(btrim(x)) into t from jsonb_array_elements_text(v) x;
    if p_action = 'tags_add' then
      update store_products sp set tags = sp.tags || array(select x from unnest(t) with ordinality u(x, k)
                                                             where not exists (select 1 from unnest(sp.tags) y where lower(y) = lower(x)) order by k)
       where id = any(ids);
    else
      update store_products sp set tags = array(select y from unnest(sp.tags) with ordinality u(y, k)
                                                 where lower(y) <> all (select lower(x) from unnest(t) x) order by k)
       where id = any(ids);
    end if;
    get diagnostics n = row_count;
  elsif p_action = 'badge' then
    if v is null then
      update store_products set badge = null, badge_en = null, badge_ar = null, badge_until = null where id = any(ids);
    else
      if jsonb_typeof(v) <> 'object' or jsonb_typeof(v -> 'badge') is distinct from 'string'
         or (v ->> 'badge') not in ('new', 'best', 'limited', 'exclusive', 'sale', 'custom')
         or coalesce(jsonb_typeof(v -> 'en'), 'null') not in ('string', 'null') or coalesce(jsonb_typeof(v -> 'ar'), 'null') not in ('string', 'null')
         or coalesce(jsonb_typeof(v -> 'until'), 'null') not in ('string', 'null') then
        raise exception 'STORE_BULK' using errcode = 'P0001';
      end if;
      d := null;
      if jsonb_typeof(v -> 'until') = 'string' then
        begin
          if (v ->> 'until') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'x'; end if;
          d := (v ->> 'until')::date;
        exception when others then raise exception 'STORE_BULK' using errcode = 'P0001';
        end;
      end if;
      update store_products set badge = v ->> 'badge', badge_en = nullif(btrim(v ->> 'en'), ''), badge_ar = nullif(btrim(v ->> 'ar'), ''),
                                badge_until = d
       where id = any(ids);
    end if;
    get diagnostics n = row_count;
  elsif p_action in ('collection_add', 'collection_remove') then
    if jsonb_typeof(v) is distinct from 'string' or not exists (select 1 from store_collections c where c.slug = v #>> '{}') then
      raise exception 'STORE_BULK' using errcode = 'P0001';
    end if;
    if p_action = 'collection_add' then
      insert into store_collection_items (collection, product_id, sort)
      select v #>> '{}', p.id, coalesce((select max(ci.sort) from store_collection_items ci where ci.collection = v #>> '{}'), 0)
                               + 10 * row_number() over (order by p.sort, p.created_at, p.id)
        from store_products p
       where p.id = any(ids) and not exists (select 1 from store_collection_items ci where ci.collection = v #>> '{}' and ci.product_id = p.id)
      on conflict (collection, product_id) do nothing;
    else
      delete from store_collection_items where collection = v #>> '{}' and product_id = any(ids);
    end if;
    get diagnostics n = row_count;
  elsif p_action = 'max_per_order' then
    if v is not null and (jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric)
                          or (v #>> '{}')::numeric not between 1 and 99) then
      raise exception 'STORE_BULK' using errcode = 'P0001';
    end if;
    update store_products set max_per_order = (v #>> '{}')::int where id = any(ids); get diagnostics n = row_count;
  elsif p_action = 'preorder' then
    if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v -> 'on') is distinct from 'boolean'
       or coalesce(jsonb_typeof(v -> 'ships_on'), 'null') not in ('string', 'null') then
      raise exception 'STORE_BULK' using errcode = 'P0001';
    end if;
    d := null;
    if jsonb_typeof(v -> 'ships_on') = 'string' then
      begin
        if (v ->> 'ships_on') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'x'; end if;
        d := (v ->> 'ships_on')::date;
      exception when others then raise exception 'STORE_BULK' using errcode = 'P0001';
      end;
    end if;
    update store_products set preorder = (v ->> 'on')::boolean, ships_on = d where id = any(ids); get diagnostics n = row_count;
  elsif p_action = 'ship_ksa' then
    if jsonb_typeof(v) is distinct from 'boolean' then raise exception 'STORE_BULK' using errcode = 'P0001'; end if;
    update store_products set ship_ksa = (v #>> '{}')::boolean where id = any(ids); get diagnostics n = row_count;
  elsif p_action = 'low_stock_at' then
    if v is not null and (jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric)
                          or (v #>> '{}')::numeric not between 0 and 1000) then
      raise exception 'STORE_BULK' using errcode = 'P0001';
    end if;
    update store_products set low_stock_at = (v #>> '{}')::int where id = any(ids); get diagnostics n = row_count;
  elsif p_action = 'supplier' then
    sup := null;
    if v is not null then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}') !~ '^[0-9]{1,18}$' then raise exception 'STORE_BULK' using errcode = 'P0001'; end if;
      select x.id into sup from store_suppliers x where x.id = (v #>> '{}')::bigint;
      if sup is null then raise exception 'STORE_BULK' using errcode = 'P0001'; end if;
    end if;
    insert into store_product_private (product_id, supplier_id)
    select p.id, sup from store_products p where p.id = any(ids)
    on conflict (product_id) do update set supplier_id = excluded.supplier_id;
    get diagnostics n = row_count;
  elsif p_action = 'schedule' then
    if jsonb_typeof(v) is distinct from 'object' or coalesce(jsonb_typeof(v -> 'publish_at'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(v -> 'unpublish_at'), 'null') not in ('string', 'null') then
      raise exception 'STORE_BULK' using errcode = 'P0001';
    end if;
    begin
      ts1 := (v ->> 'publish_at')::timestamptz; ts2 := (v ->> 'unpublish_at')::timestamptz;
    exception when others then raise exception 'STORE_BULK' using errcode = 'P0001';
    end;
    if ts1 is not null and ts2 is not null and ts2 <= ts1 then raise exception 'STORE_BULK' using errcode = 'P0001'; end if;
    update store_products set publish_at = ts1, unpublish_at = ts2 where id = any(ids); get diagnostics n = row_count;
  elsif p_action = 'delete' then
    delete from store_products where id = any(ids); get diagnostics n = row_count;
  else
    raise exception 'STORE_BULK' using errcode = 'P0001';
  end if;
  return n;
end $$;
revoke all on function public.staff_store_bulk(uuid[], text, jsonb) from public, anon;
grant execute on function public.staff_store_bulk(uuid[], text, jsonb) to authenticated;

-- Order (admins): p_kind 'products' (ids), 'categories' (slugs), 'collections' (slugs) or 'collection:<slug>' (the product
-- ids in that collection); each key's sort becomes its position * 10 (10, 20, ...). Answers how many rows it set.
-- STORE_SORT for an unknown kind, no keys (or over 5000), a key twice or a key that cannot be one.
create or replace function public.staff_store_sort(p_kind text, p_keys text[]) returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; coll text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if coalesce(cardinality(p_keys), 0) not between 1 and 5000 or exists (select 1 from unnest(p_keys) x where x is null)
     or (select count(distinct x) from unnest(p_keys) x) <> cardinality(p_keys) then
    raise exception 'STORE_SORT' using errcode = 'P0001';
  end if;
  if p_kind in ('products') or p_kind like 'collection:%' then
    if exists (select 1 from unnest(p_keys) x where x !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'STORE_SORT' using errcode = 'P0001';
    end if;
  end if;
  if p_kind = 'products' then
    update store_products p set sort = k.n * 10 from unnest(p_keys) with ordinality k(key, n) where p.id = k.key::uuid;
  elsif p_kind = 'categories' then
    update store_categories c set sort = k.n * 10 from unnest(p_keys) with ordinality k(key, n) where c.slug = k.key;
  elsif p_kind = 'collections' then
    update store_collections c set sort = k.n * 10 from unnest(p_keys) with ordinality k(key, n) where c.slug = k.key;
  elsif p_kind like 'collection:%' then
    coll := substr(p_kind, 12);
    if not exists (select 1 from store_collections c where c.slug = coll) then raise exception 'STORE_SORT' using errcode = 'P0001'; end if;
    update store_collection_items ci set sort = k.n * 10 from unnest(p_keys) with ordinality k(key, n)
     where ci.collection = coll and ci.product_id = k.key::uuid;
  else
    raise exception 'STORE_SORT' using errcode = 'P0001';
  end if;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.staff_store_sort(text, text[]) from public, anon;
grant execute on function public.staff_store_sort(text, text[]) to authenticated;

-- === 9. Reports ==================================================================================
-- Staff. Default window: the last 30 Riyadh days. Products by state: live (_store_live), scheduled (published, its
-- publish_at still ahead), preview (neither, in preview), draft (the rest). Stock figures leave gift cards out (a
-- voucher is not stock); low = an active variant with 1..its product's low_stock_at (else store.lowStock, else 3) left;
-- out = an active variant with none; cost = units at the variant's cost, else the product's; missing_cost = variants
-- with stock and no cost. moves = the sum of delta per reason in the window. sales: null in catalog mode, else the
-- orders paid and later (not pending, cancelled or refunded) by the day they were paid; revenue = the lines' totals
-- (before delivery and discounts); cost = units at today's costs where known; margin = revenue - cost.
create or replace function public.staff_store_report(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d_to date := coalesce(p_to, (now() at time zone 'Asia/Riyadh')::date); d_from date; lv jsonb; low_def int := 3;
        prods jsonb; stock jsonb; cats jsonb; moves jsonb; sales jsonb;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  d_from := coalesce(p_from, d_to - 29);
  if d_from > d_to or d_to - d_from > 3700 then raise exception 'STORE_REPORT' using errcode = 'P0001'; end if;
  select c.value into lv from site_content c where c.key = 'store.lowStock';
  if jsonb_typeof(lv) = 'number' then
    low_def := case when (lv #>> '{}')::numeric = trunc((lv #>> '{}')::numeric) and (lv #>> '{}')::numeric between 0 and 1000
                    then (lv #>> '{}')::int else 3 end;
  end if;

  select jsonb_build_object('total', count(*), 'live', count(*) filter (where st = 'live'), 'preview', count(*) filter (where st = 'preview'),
                            'draft', count(*) filter (where st = 'draft'), 'scheduled', count(*) filter (where st = 'scheduled'))
    into prods
    from (select case when _store_live(p) then 'live'
                      when p.published and p.publish_at > now() then 'scheduled'
                      when p.preview then 'preview' else 'draft' end st
            from store_products p) x;

  select jsonb_build_object(
           'variants', (select count(*) from store_variants),
           'units', coalesce(sum(v.stock), 0),
           'low', count(*) filter (where v.active and v.stock > 0 and v.stock <= coalesce(p.low_stock_at, low_def)),
           'out', count(*) filter (where v.active and v.stock = 0),
           'stock', jsonb_build_object('retail', coalesce(sum(v.stock * coalesce(v.price, p.price)), 0),
                                       'cost', coalesce(sum(v.stock * coalesce(vc.cost, pp.cost)), 0),
                                       'missing_cost', count(*) filter (where v.stock > 0 and coalesce(vc.cost, pp.cost) is null)))
    into stock
    from store_variants v join store_products p on p.id = v.product_id
    left join store_variant_costs vc on vc.variant_id = v.id
    left join store_product_private pp on pp.product_id = p.id
   where p.kind <> 'gift_card';

  select coalesce(jsonb_agg(jsonb_build_object('slug', c.slug, 'name_en', c.name_en, 'name_ar', c.name_ar,
                                               'products', coalesce(a.products, 0), 'units', coalesce(b.units, 0),
                                               'retail', coalesce(b.retail, 0), 'cost', coalesce(b.cost, 0))
                            order by c.sort, c.slug), '[]'::jsonb)
    into cats
    from store_categories c
    left join (select p.category, count(*) products from store_products p group by p.category) a on a.category = c.slug
    left join (select p.category, sum(v.stock) units, sum(v.stock * coalesce(v.price, p.price)) retail,
                      sum(v.stock * coalesce(vc.cost, pp.cost)) cost
                 from store_variants v join store_products p on p.id = v.product_id
                 left join store_variant_costs vc on vc.variant_id = v.id
                 left join store_product_private pp on pp.product_id = p.id
                where p.kind <> 'gift_card'
                group by p.category) b on b.category = c.slug;

  select jsonb_object_agg(r.reason, coalesce(m.s, 0)) into moves
    from unnest(array['receive', 'count', 'damaged', 'lost', 'return', 'order', 'cancel', 'edit', 'import', 'other']) r(reason)
    left join (select x.reason, sum(x.delta) s from store_stock_moves x
                where (x.at at time zone 'Asia/Riyadh')::date between d_from and d_to group by x.reason) m on m.reason = r.reason;

  if to_regclass('public.store_orders') is not null and to_regclass('public.store_order_items') is not null then
    execute $q$
      with o as (select o.id, coalesce(o.paid_at, o.created_at) paid
                   from store_orders o
                  where o.status in ('paid', 'preparing', 'ready', 'shipped', 'out', 'delivered')
                    and (coalesce(o.paid_at, o.created_at) at time zone 'Asia/Riyadh')::date between $1 and $2),
           l as (select i.order_id, i.product_id, i.name, i.qty, i.unit_price * i.qty rev,
                        i.qty * coalesce(vc.cost, pp.cost) cost, p.category, p.name_en
                   from store_order_items i join o on o.id = i.order_id
                   left join store_products p on p.id = i.product_id
                   left join store_variant_costs vc on vc.variant_id = i.variant_id
                   left join store_product_private pp on pp.product_id = i.product_id)
      select jsonb_build_object(
        'orders', (select count(*) from o),
        'units', coalesce((select sum(qty) from l), 0),
        'revenue', coalesce((select sum(rev) from l), 0),
        'cost', coalesce((select sum(cost) from l), 0),
        'margin', coalesce((select sum(rev) from l), 0) - coalesce((select sum(cost) from l), 0),
        'missing_cost', (select count(*) from l where cost is null),
        'by_product', coalesce((select jsonb_agg(jsonb_build_object('product_id', x.product_id, 'name', x.name, 'units', x.units,
                                                                    'revenue', x.revenue, 'cost', x.cost) order by x.revenue desc, x.name)
                                  from (select l.product_id, coalesce(max(l.name_en), max(l.name)) name, sum(l.qty) units,
                                               sum(l.rev) revenue, coalesce(sum(l.cost), 0) cost
                                          from l group by l.product_id) x), '[]'::jsonb),
        'by_category', coalesce((select jsonb_agg(jsonb_build_object('slug', x.category, 'units', x.units, 'revenue', x.revenue)
                                                  order by x.revenue desc, x.category)
                                   from (select l.category, sum(l.qty) units, sum(l.rev) revenue from l group by l.category) x), '[]'::jsonb),
        'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', x.day, 'orders', x.orders, 'revenue', x.revenue) order by x.day)
                              from (select (o.paid at time zone 'Asia/Riyadh')::date as day, count(distinct o.id) orders,
                                           coalesce(sum(l.rev), 0) revenue
                                      from o left join l on l.order_id = o.id group by 1) x), '[]'::jsonb))
    $q$ into sales using d_from, d_to;
  end if;

  return jsonb_build_object('mode', case when to_regclass('public.store_orders') is not null then 'full' else 'catalog' end,
                            'from', d_from, 'to', d_to, 'products', prods)
         || stock
         || jsonb_build_object('by_category', cats, 'moves', moves, 'sales', sales);
end $$;
revoke all on function public.staff_store_report(date, date) from public, anon;
grant execute on function public.staff_store_report(date, date) to authenticated;

-- === S. Staging only: where orders exist =========================================================
-- Dynamic SQL: production has no store_orders, store_quotes or payments, so it never parses these.
do $stg$
begin
  if to_regclass('public.store_orders') is null then
    raise notice 'store_catalog_plus: no store_orders here (catalog mode), the order-side changes are skipped';
    return;
  end if;

  -- a pre-order line sold beyond the stock there (5): flagged, and how many units it took (null: all of qty)
  execute $f$ alter table public.store_order_items add column if not exists preorder boolean not null default false $f$;
  execute $f$ alter table public.store_order_items add column if not exists stock_taken int $f$;
  execute $f$ alter table public.store_order_items drop constraint if exists store_order_items_stock_taken_check $f$;
  execute $f$ alter table public.store_order_items add constraint store_order_items_stock_taken_check
                check (stock_taken is null or stock_taken between 0 and qty) $f$;

  -- _store_restock (20261110150000): puts back what each held line took (stock_taken, else qty), logged as 'cancel'
  execute $f$
create or replace function public._store_restock(p_order uuid) returns void
language plpgsql security definer set search_path = public as $fn$
declare i store_order_items%rowtype; prev text := current_setting('mm.stock_reason', true);
begin
  /* a move's reason (store catalogue plus, 20261119400100) */
  perform set_config('mm.stock_reason', 'cancel', true);
  for i in select * from store_order_items where order_id = p_order and held order by id for update loop
    update store_variants set stock = stock + coalesce(i.stock_taken, i.qty) where id = i.variant_id;
    update store_order_items set held = false, stock_taken = null where id = i.id;
  end loop;
  perform set_config('mm.stock_reason', coalesce(prev, ''), true);
end $fn$
  $f$;
  execute $f$ revoke execute on function public._store_restock(uuid) from public, anon, authenticated $f$;

  -- _store_quote_json (20261119300000): a line is live when its product is _store_live
  execute $f$
create or replace function public._store_quote_json(q store_quotes) returns jsonb
language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    'id', q.id, 'no', q.no, 'token', q.token, 'fulfil', q.fulfil, 'slot', q.slot, 'handover', q.handover,
    'name', q.name, 'phone', q.phone, 'staff_note', q.staff_note, 'lang', q.lang, 'status', q.status,
    'state', case when q.status = 'void' then 'void'
                  when o.id is not null and o.status not in ('pending', 'cancelled') then 'used'
                  when q.expires_at <= now() then 'expired' else 'open' end,
    'expires_at', q.expires_at, 'created_at', q.created_at, 'created_by', q.created_by,
    'order_id', o.id, 'order_no', o.no, 'order_status', o.status,
    'items', coalesce((select jsonb_agg(jsonb_build_object('variant', x ->> 'variant', 'qty', (x ->> 'qty')::int,
                         'product_id', p.id, 'name_en', p.name_en, 'name_ar', p.name_ar,
                         'label', nullif(concat_ws(' ' || chr(183) || ' ', nullif(v.size, ''), nullif(v.color_en, '')), ''),
                         /* live: published and inside its schedule (store catalogue plus, 20261119400100) */
                         'unit', coalesce(v.price, p.price), 'live', coalesce(v.active and _store_live(p), false), 'stock', v.stock) order by n)
                       from jsonb_array_elements(q.items) with ordinality y(x, n)
                       left join store_variants v on v.id = (x ->> 'variant')::uuid
                       left join store_products p on p.id = v.product_id), '[]'::jsonb),
    'subtotal', coalesce((select sum(coalesce(v.price, p.price) * (x ->> 'qty')::int)
                            from jsonb_array_elements(q.items) x
                            join store_variants v on v.id = (x ->> 'variant')::uuid join store_products p on p.id = v.product_id), 0))
  from (select 1) one left join store_orders o on o.id = q.order_id
$fn$
  $f$;
  execute $f$ revoke execute on function public._store_quote_json(store_quotes) from public, anon, authenticated $f$;

  -- staff_store_quote_save (20261119300000): live products (_store_live); a pre-order product past its stock
  execute $f$
create or replace function public.staff_store_quote_save(p_quote jsonb) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare q store_quotes%rowtype; it jsonb; v store_variants%rowtype; pr store_products%rowtype; v_items jsonb := '[]'::jsonb; seen text[] := '{}';
        qty int; f text; v_slot jsonb; ho jsonb; nm text; ph text; v_note text; days int; who text; v_lang text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if jsonb_typeof(p_quote) is distinct from 'object' or jsonb_typeof(p_quote -> 'items') is distinct from 'array'
     or jsonb_array_length(p_quote -> 'items') not between 1 and 20 then
    raise exception 'STORE_QUOTE_ITEMS' using errcode = 'P0001';
  end if;
  for it in select x from jsonb_array_elements(p_quote -> 'items') x loop
    qty := case when (it ->> 'qty') ~ '^[0-9]{1,2}$' then (it ->> 'qty')::int else 0 end;
    if qty not between 1 and 10 or coalesce(it ->> 'variant', '') !~* '^[0-9a-f-]{36}$' or lower(it ->> 'variant') = any(seen) then
      raise exception 'STORE_QUOTE_ITEMS' using errcode = 'P0001';
    end if;
    select * into v from store_variants where id = (it ->> 'variant')::uuid;
    select * into pr from store_products where id = v.product_id;
    /* live (store catalogue plus, 20261119400100): published and inside its schedule; a pre-order product past its stock */
    if v.id is null or not v.active or pr.id is null or not _store_live(pr) or pr.kind = 'gift_card' or (v.stock < qty and not pr.preorder) then
      raise exception 'STORE_QUOTE_ITEMS: %', it ->> 'variant' using errcode = 'P0001';
    end if;
    seen := seen || lower(it ->> 'variant');
    v_items := v_items || jsonb_build_array(jsonb_build_object('variant', lower(it ->> 'variant'), 'qty', qty));
  end loop;
  f := nullif(p_quote ->> 'fulfil', '');
  if f is not null and f not in ('pickup', 'jeddah', 'ksa') then raise exception 'STORE_QUOTE_FULFIL' using errcode = 'P0001'; end if;
  v_slot := case when f = 'jeddah' and (p_quote #>> '{slot,day}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and (p_quote #>> '{slot,time}') ~ '^[a-z0-9]{1,12}$'
               then jsonb_build_object('day', p_quote #>> '{slot,day}', 'time', p_quote #>> '{slot,time}') end;
  ho := case when f = 'pickup' and (p_quote #>> '{handover,day}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and _store_hm(p_quote #>> '{handover,at}') is not null
             then jsonb_build_object('day', p_quote #>> '{handover,day}', 'at', p_quote #>> '{handover,at}') end;
  nm := nullif(btrim(regexp_replace(coalesce(p_quote ->> 'name', ''), '\s+', ' ', 'g')), '');
  if nm is not null and length(nm) not between 2 and 60 then raise exception 'STORE_NAME' using errcode = 'P0001'; end if;
  ph := nullif(btrim(coalesce(p_quote ->> 'phone', '')), '');
  if ph is not null then
    ph := _pay_phone(ph);
    if ph is null then raise exception 'STORE_PHONE' using errcode = 'P0001'; end if;
  end if;
  v_note := left(nullif(btrim(coalesce(p_quote ->> 'staff_note', '')), ''), 300);
  v_lang := case when (p_quote ->> 'lang') ~ '^[a-z]{2}$' then p_quote ->> 'lang' end;
  days := case when jsonb_typeof(p_quote -> 'days') = 'number' then _store_jint(p_quote -> 'days', 7, 1, 30) else _pay_int('store.quoteDays', 7, 1, 30) end;
  select coalesce(nullif(btrim(s.display_name), ''), 'Staff') into who from staff s where s.user_id = auth.uid();
  if nullif(p_quote ->> 'id', '') is not null then
    if (p_quote ->> 'id') !~* '^[0-9a-f-]{36}$' then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    select * into q from store_quotes where id = (p_quote ->> 'id')::uuid for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if q.status = 'void' or (q.order_id is not null and exists (select 1 from store_orders x where x.id = q.order_id and x.status not in ('pending', 'cancelled'))) then
      raise exception 'STORE_QUOTE_USED' using errcode = 'P0001';
    end if;
    update store_quotes set items = v_items, fulfil = f, slot = v_slot, handover = ho, name = nm, phone = ph, staff_note = v_note, lang = v_lang,
           expires_at = now() + make_interval(days => days), updated_at = now()
     where id = q.id returning * into q;
  else
    insert into store_quotes (token, items, fulfil, slot, handover, name, phone, staff_note, lang, expires_at, created_by)
    values (replace(gen_random_uuid()::text, '-', ''), v_items, f, v_slot, ho, nm, ph, v_note, v_lang, now() + make_interval(days => days), left(coalesce(who, 'Staff'), 60))
    returning * into q;
  end if;
  return _store_quote_json(q);
end $fn$
  $f$;
  execute $f$ revoke execute on function public.staff_store_quote_save(jsonb) from public, anon $f$;
  execute $f$ grant execute on function public.staff_store_quote_save(jsonb) to authenticated $f$;

  -- store_promo_check (20261115235500): live products (_store_live); a pre-order product past its stock counts
  execute $f$
create or replace function public.store_promo_check(p_key text, p_code text, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare it jsonb; v store_variants%rowtype; pr store_products%rowtype; qty int; lines jsonb := '[]'::jsonb; elig numeric := 0;
        disc numeric; seen uuid[] := '{}';
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _ip_gate('storepromo' || _store_visitor(), 20, interval '10 minutes') then raise exception 'STORE_BUSY' using errcode = 'P0001'; end if;
  if _store_licence() is null then raise exception 'STORE_LICENCE' using errcode = 'P0001'; end if;
  for it in select x from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) with ordinality t(x, k)
             order by k limit 20 loop
    qty := case when (it ->> 'qty') ~ '^[0-9]{1,2}$' then (it ->> 'qty')::int else 0 end;
    continue when qty < 1 or qty > 10
               or coalesce(it ->> 'variant', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    select * into v from store_variants where id = (it ->> 'variant')::uuid;
    continue when v.id is null or not v.active or v.id = any(seen);
    select * into pr from store_products where id = v.product_id;
    /* live, and a pre-order product past its stock as checkout sells it (store catalogue plus, 20261119400100) */
    continue when pr.id is null or not _store_live(pr) or pr.kind = 'gift_card' or (v.stock < qty and not pr.preorder);
    seen := seen || v.id;
    lines := lines || jsonb_build_array(jsonb_build_object('product', pr.id, 'unit', coalesce(v.price, pr.price), 'qty', qty));
    elig := elig + coalesce(v.price, pr.price) * qty;
  end loop;
  disc := coalesce((select sum((x ->> 'amount')::numeric) from jsonb_array_elements(_store_bundle_off(lines)) x), 0);
  return _store_promo_off(upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g')), round(elig - disc, 2), false);
end $fn$
  $f$;
  execute $f$ revoke execute on function public.store_promo_check(text, text, jsonb) from public $f$;
  execute $f$ grant execute on function public.store_promo_check(text, text, jsonb) to anon, authenticated $f$;

  -- store_stock_request (20261115235500): live products (_store_live)
  execute $f$
create or replace function public.store_stock_request(p_key text, p_variant uuid, p_name text, p_phone text, p_lang text) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare v store_variants%rowtype; pr store_products%rowtype; nm text; ph text; r store_stock_requests%rowtype;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _ip_gate('storestock' || _store_visitor(), 10, interval '10 minutes') then raise exception 'STORE_BUSY' using errcode = 'P0001'; end if;
  nm := left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 60);
  if length(nm) < 2 then raise exception 'STORE_NAME' using errcode = 'P0001'; end if;
  ph := _pay_phone(p_phone);
  if ph is null then raise exception 'STORE_PHONE' using errcode = 'P0001'; end if;
  select * into v from store_variants where id = p_variant;
  select * into pr from store_products where id = v.product_id;
  /* live: published and inside its schedule (store catalogue plus, 20261119400100) */
  if v.id is null or not v.active or pr.id is null or not _store_live(pr) then raise exception 'STORE_GONE' using errcode = 'P0001'; end if;
  insert into store_stock_requests (product_id, variant_id, label, name, phone, lang)
  values (pr.id, v.id, left(nullif(concat_ws(' ' || chr(183) || ' ', nullif(v.size, ''), nullif(v.color_en, '')), ''), 60), nm, ph,
          case when p_lang ~ '^[a-z]{2}$' then p_lang end)
  on conflict (variant_id, phone) where status = 'open' do nothing
  returning * into r;
  if r.id is null then
    select * into r from store_stock_requests where variant_id = v.id and phone = ph and status = 'open';
  end if;
  return jsonb_build_object('id', r.id);
end $fn$
  $f$;
  execute $f$ revoke execute on function public.store_stock_request(text, uuid, text, text, text) from public $f$;
  execute $f$ grant execute on function public.store_stock_request(text, uuid, text, text, text) to anon, authenticated $f$;

  -- store_checkout (20261119000800): live products only; a pre-order product past its stock; max per order; min order
  execute $f$
create or replace function public.store_checkout(p_key text, p_id text, p_token text, p_order jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare it jsonb; v store_variants%rowtype; pr store_products%rowtype; n int := 0; qty int; sub numeric := 0; fee numeric;
        fulfil text := p_order ->> 'fulfil'; name text; phone text; email text; addr jsonb; o store_orders%rowtype;
        p payments%rowtype; due numeric; bal numeric; take numeric := 0; who text; lang text := p_order ->> 'lang';
        mins int := _pay_int('store.orderMinutes', 30, 10, 120); city text; label text;
        ngift int := 0; lines jsonb := '[]'::jsonb; elig numeric := 0; img text; unit numeric; offs jsonb; disc numeric;
        promo text; pc jsonb; gc text; g store_gift_cards%rowtype; sl jsonb; sday date; slot jsonb; rest numeric;
        gift boolean := coalesce(p_order -> 'gift' = 'true'::jsonb, false); gnote text;
        nowhm text := to_char(now() at time zone 'Asia/Riyadh', 'HH24:MI');   -- (20261119000800)
        /* the Arabic-Indic and Eastern Arabic-Indic digits, Jeddah's two Arabic spellings and the middle dot, written as
           chr() to keep the migration ASCII (store catalogue plus, 20261119400100) */
        ardig text := (select string_agg(chr(c), '' order by c) from generate_series(1632, 1641) c)
                      || (select string_agg(chr(c), '' order by c) from generate_series(1776, 1785) c);
        jed1 text := chr(1580) || chr(1583) || chr(1577); jed2 text := chr(1580) || chr(1583) || chr(1607);
        dot text := ' ' || chr(183) || ' ';
        /* store catalogue plus (20261119400100): a pre-order line, units taken, the limits */
        pre boolean; tk int; maxq int; minv numeric; mo jsonb; bad uuid;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _pay_on('pay.enabled') or not _pay_on('store.open') then raise exception 'STORE_CLOSED' using errcode = 'P0001'; end if;
  if p_id is not null and not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if fulfil is null or fulfil not in ('pickup', 'jeddah', 'ksa', 'digital') then raise exception 'STORE_FULFIL' using errcode = 'P0001'; end if;
  /* a way staff switched off is refused; pickup too since X01 (store build 2026-11-15) */
  if _store_delivery_fee(fulfil, 0) is null then raise exception 'STORE_FULFIL' using errcode = 'P0001'; end if;

  name := left(btrim(regexp_replace(coalesce(p_order #>> '{contact,name}', ''), '\s+', ' ', 'g')), 60);
  phone := _pay_phone(p_order #>> '{contact,phone}');
  email := nullif(lower(btrim(coalesce(p_order #>> '{contact,email}', ''))), '');
  if length(name) < 2 then raise exception 'STORE_NAME' using errcode = 'P0001'; end if;
  if phone is null then raise exception 'STORE_PHONE' using errcode = 'P0001'; end if;
  if email is not null and (length(email) > 120 or email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then raise exception 'STORE_EMAIL' using errcode = 'P0001'; end if;

  if fulfil in ('jeddah', 'ksa') then
    addr := jsonb_strip_nulls(jsonb_build_object(
      'city', left(nullif(btrim(p_order #>> '{address,city}'), ''), 40),
      'district', left(nullif(btrim(p_order #>> '{address,district}'), ''), 60),
      'street', left(nullif(btrim(p_order #>> '{address,street}'), ''), 80),
      'building', left(nullif(btrim(p_order #>> '{address,building}'), ''), 10),
      'postal', left(nullif(btrim(p_order #>> '{address,postal}'), ''), 5),
      'extra', left(nullif(btrim(p_order #>> '{address,extra}'), ''), 4),
      'short', upper(left(nullif(btrim(p_order #>> '{address,short}'), ''), 8)),
      'notes', left(nullif(btrim(p_order #>> '{address,notes}'), ''), 200)));
    city := lower(coalesce(addr ->> 'city', ''));
    if coalesce(addr ->> 'district', '') = '' or coalesce(addr ->> 'street', '') = '' or city = '' then
      raise exception 'STORE_ADDRESS' using errcode = 'P0001';
    end if;
    if addr ? 'postal' and (addr ->> 'postal') !~ '^[0-9]{5}$' then raise exception 'STORE_ADDRESS' using errcode = 'P0001'; end if;
    if addr ? 'short' then
      addr := addr || jsonb_build_object('short', translate(addr ->> 'short', ardig, '01234567890123456789'));
      if (addr ->> 'short') !~ '^[A-Z]{4}[0-9]{4}$' then raise exception 'STORE_ADDRESS' using errcode = 'P0001'; end if;
    end if;
    -- a courier may not take a parcel without the national address since 2026-01-01 (TGA): its short code
    if fulfil = 'ksa' and not addr ? 'short' then raise exception 'STORE_ADDRESS' using errcode = 'P0001'; end if;
    if fulfil = 'jeddah' and city not in ('jeddah', 'jiddah', 'jedda', jed1, jed2) then raise exception 'STORE_CITY' using errcode = 'P0001'; end if;
    /* the Jeddah districts the shop delivers to, while staff keep that list on (F79, store build 2026-11-15) */
    if fulfil = 'jeddah' and not _store_district_ok(addr ->> 'district') then raise exception 'STORE_DISTRICT' using errcode = 'P0001'; end if;
    /* scheduled Jeddah delivery (F78): while it is on, a day and a time it offers; a slot sent otherwise is ignored */
    sl := case when fulfil = 'jeddah' then _store_slots() end;
    if sl is not null then
      begin
        sday := case when (p_order #>> '{slot,day}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (p_order #>> '{slot,day}')::date end;
      exception when others then sday := null;
      end;
      /* today's windows only before they start, and a day with none left is not one of the days (they run on a day
         further), as the website's slotDays and slotTimes count them on the Riyadh clock (bug hunt 2026-11-18
         (20261119000800), stg11-3: with a lead of 0 days a window already over today was booked) */
      if sday is null or not (sday = any(_store_slot_days(sl, _pay_today(), nowhm)))
         or not exists (select 1 from jsonb_array_elements(sl -> 'times') t where t ->> 'id' = p_order #>> '{slot,time}'
                          and (sday > _pay_today() or (t ->> 'from') collate "C" > nowhm collate "C")) then
        raise exception 'STORE_SLOT' using errcode = 'P0001';
      end if;
      /* the window's hours are kept with the order, so staff changing or removing a time later does not change what
         was booked (stg11-2) */
      slot := (select jsonb_build_object('day', to_char(sday, 'YYYY-MM-DD'), 'time', t ->> 'id', 'from', t ->> 'from', 'to', t ->> 'to')
                 from jsonb_array_elements(sl -> 'times') t where t ->> 'id' = p_order #>> '{slot,time}' limit 1);
    end if;
  end if;

  if jsonb_typeof(p_order -> 'items') is distinct from 'array' or jsonb_array_length(p_order -> 'items') = 0 or jsonb_array_length(p_order -> 'items') > 20 then
    raise exception 'STORE_EMPTY' using errcode = 'P0001';
  end if;

  /* a gift order (F58): its note goes on the slip, which shows no prices */
  gnote := case when gift then left(nullif(btrim(coalesce(p_order ->> 'gift_note', '')), ''), 200) end;

  insert into store_orders (customer_id, fulfil, name, phone, email, address, note, subtotal, total, lang, expires_at, gift, gift_note, slot)
  values (p_id, fulfil, name, phone, email, addr, left(nullif(btrim(coalesce(p_order ->> 'note', '')), ''), 300), 0, 0,
          case when lang ~ '^[a-z]{2}$' then lang end, now() + make_interval(mins => mins), gift, gnote, slot)
  returning * into o;

  -- each line: the variant locked, live and in stock, at the database's price
  for it in select x from jsonb_array_elements(p_order -> 'items') x order by x ->> 'variant' loop
    qty := case when (it ->> 'qty') ~ '^[0-9]{1,2}$' then (it ->> 'qty')::int else 0 end;
    if qty < 1 or qty > 10 or coalesce(it ->> 'variant', '') !~ '^[0-9a-f-]{36}$' then raise exception 'STORE_ITEM' using errcode = 'P0001'; end if;
    select * into v from store_variants where id = (it ->> 'variant')::uuid for update;
    select * into pr from store_products where id = v.product_id;
    /* live: published and inside its schedule; a product in preview is never bought (store catalogue plus, 20261119400100) */
    if v.id is null or not v.active or pr.id is null or not _store_live(pr) then raise exception 'STORE_GONE: %', it ->> 'variant' using errcode = 'P0001'; end if;
    /* a pre-order product is sold past its stock: the stock goes down by what is there, never below zero, and the line is
       marked (store catalogue plus, 20261119400100) */
    pre := pr.preorder and v.stock < qty;
    if v.stock < qty and not pre then raise exception 'STORE_STOCK: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if fulfil = 'ksa' and not pr.ship_ksa and pr.kind <> 'gift_card' then raise exception 'STORE_NO_SHIP: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if exists (select 1 from store_order_items i where i.order_id = o.id and i.variant_id = v.id) then raise exception 'STORE_ITEM' using errcode = 'P0001'; end if;
    unit := coalesce(v.price, pr.price);
    /* a gift card is one face value, 10 to 5000 SAR (store_gift_cards) */
    if pr.kind = 'gift_card' and (unit < 10 or unit > 5000) then raise exception 'STORE_ITEM' using errcode = 'P0001'; end if;
    tk := least(v.stock, qty);
    update store_variants set stock = stock - tk where id = v.id;
    label := nullif(concat_ws(dot, nullif(v.size, ''), nullif(case when lang = 'ar' then coalesce(v.color_ar, v.color_en) else v.color_en end, '')), '');
    /* X08: the line keeps its own photo (the first one staff tagged with its colour, else the cover) and address */
    img := coalesce((select u.x from unnest(pr.images) with ordinality u(x, k)
                      where v.color_en is not null and pr.image_meta -> u.x ->> 'colour' = v.color_en order by u.k limit 1), pr.images[1]);
    insert into store_order_items (order_id, product_id, variant_id, name, variant, unit_price, qty, image, slug, gift_card, preorder, stock_taken)
    values (o.id, pr.id, v.id, case when lang = 'ar' then coalesce(pr.name_ar, pr.name_en) else pr.name_en end, label, unit, qty,
            left(img, 300), pr.slug, pr.kind = 'gift_card', pre, case when tk < qty then tk end);
    sub := sub + unit * qty; n := n + 1;
    if pr.kind = 'gift_card' then
      ngift := ngift + 1;
    else
      lines := lines || jsonb_build_array(jsonb_build_object('product', pr.id, 'unit', unit, 'qty', qty));
      elig := elig + unit * qty;
    end if;
  end loop;
  /* gift cards alone are 'digital' (nothing to deliver), and 'digital' is gift cards alone (F57) */
  if (fulfil = 'digital') is distinct from (ngift = n) then raise exception 'STORE_DIGITAL' using errcode = 'P0001'; end if;

  /* no more of one product than its max per order, else store.maxPerOrder, else no limit (store catalogue plus,
     20261119400100); its sizes and colours count together */
  mo := _pay_setting('store.maxPerOrder');
  maxq := case when jsonb_typeof(mo) = 'number' then _store_jint(mo, null, 1, 1000) end;
  select i.product_id into bad
    from store_order_items i join store_products sp on sp.id = i.product_id
   where i.order_id = o.id
   group by i.product_id, sp.max_per_order
  having sum(i.qty) > coalesce(sp.max_per_order, maxq, 2147483647)
   order by i.product_id limit 1;
  if bad is not null then raise exception 'STORE_MAX_QTY: %', bad using errcode = 'P0001'; end if;

  /* the bundle prices (F31) and a code (F67): only with the discount licence, never on gift cards */
  offs := _store_bundle_off(lines);
  disc := coalesce((select sum((x ->> 'amount')::numeric) from jsonb_array_elements(offs) x), 0);
  promo := nullif(upper(regexp_replace(coalesce(p_order ->> 'promo', ''), '\s+', '', 'g')), '');
  if promo is not null then
    pc := _store_promo_off(promo, round(elig - disc, 2), true);
    disc := disc + (pc ->> 'discount')::numeric;
    offs := offs || jsonb_build_array(jsonb_build_object('kind', 'promo', 'ref', pc ->> 'code', 'amount', (pc ->> 'discount')::numeric));
  end if;
  sub := round(sub, 2); disc := round(disc, 2);

  /* the least order (store.minOrder, SAR): the lines' subtotal, gift cards counted, delivery not (store catalogue plus,
     20261119400100) */
  mo := _pay_setting('store.minOrder');
  minv := case when jsonb_typeof(mo) = 'number' then (mo #>> '{}')::numeric end;
  if minv is not null and minv > 0 and sub < minv then raise exception 'STORE_MIN_ORDER' using errcode = 'P0001'; end if;

  fee := _store_delivery_fee(fulfil, sub - disc);
  if fee is null then raise exception 'STORE_FULFIL' using errcode = 'P0001'; end if;
  /* an order that buys gift cards gets its gift key: the whole codes, for the buyer's checkout alone (section 6) */
  update store_orders set subtotal = sub, discount = disc, discounts = offs, promo_code = pc ->> 'code',
         delivery_fee = fee, total = round(sub - disc + fee, 2),
         gift_key = case when ngift > 0 then replace(gen_random_uuid()::text, '-', '') end
   where id = o.id returning * into o;

  /* a gift card pays first (F57): not for gift cards; it leaves the card at least 1 SAR, as the wallet does */
  gc := nullif(upper(regexp_replace(coalesce(p_order ->> 'gift_card', ''), '\s+', '', 'g')), '');
  if gc is not null then
    if ngift > 0 then raise exception 'STORE_GIFT_ON_GIFT' using errcode = 'P0001'; end if;
    select * into g from store_gift_cards where code = gc for update;
    if g.id is null or g.status <> 'active' or g.balance <= 0 then raise exception 'STORE_GIFT' using errcode = 'P0001'; end if;
    /* a year to spend it (the owner, 2026-11-15) */
    if g.expires_at <= now() then raise exception 'STORE_GIFT_EXPIRED' using errcode = 'P0001'; end if;
    take := least(g.balance, o.total);
    if o.total - take > 0 and o.total - take < 1 then take := greatest(o.total - 1, 0); end if;
    if take > 0 then
      update store_gift_cards set balance = balance - take where id = g.id;
      insert into store_gift_card_moves (card_id, order_id, amount, kind, by_name) values (g.id, o.id, -take, 'spend', 'customer');
      update store_orders set gift_paid = take, gift_card_id = g.id where id = o.id returning * into o;
    end if;
  end if;

  -- the account's wallet pays what it can first, when the customer chose it
  if p_id is not null and coalesce((p_order ->> 'wallet')::boolean, false) then
    who := _wallet_owner(p_id);
    select coalesce(balance, 0) into bal from wallet_balances where customer_id = who for update;
    rest := o.total - o.gift_paid;
    take := least(coalesce(bal, 0), rest);
    /* the card takes no less than 1 SAR (Moyasar's least): a wallet that would leave less leaves the card 1 SAR
       (bug hunt 2026-11-10: PAY_TOO_SMALL failed the checkout every time) */
    if rest - take > 0 and rest - take < 1 then take := greatest(rest - 1, 0); end if;
    if take > 0 then
      perform set_config('mm.wallet_op', 'Online store', true);
      perform _wallet_post(who, -take, 'sale', null, null, null, 'ord-' || o.no, null);
      perform set_config('mm.wallet_op', '', true);
      update store_orders set wallet_paid = take where id = o.id returning * into o;
    end if;
  end if;

  insert into store_order_events (order_id, status, note) values (o.id, 'pending', null);
  due := round(o.total - o.gift_paid - o.wallet_paid, 2);
  if due <= 0 then
    update store_orders set status = 'paid', paid_at = now(), expires_at = null where id = o.id returning * into o;
    insert into store_order_events (order_id, status, note)
    values (o.id, 'paid', case when o.wallet_paid > 0 then 'wallet' when o.gift_paid > 0 then 'gift_card' end);
    insert into receipt_numbers (receipt_id) values ('ord-' || o.no) on conflict (receipt_id) do nothing;
    perform _store_paid(o);
    select * into o from store_orders where id = o.id;
    return jsonb_build_object('order', _store_order_json(o), 'key', o.track_key, 'payment', null, 'gift_key', o.gift_key);
  end if;
  if due < 1 then raise exception 'PAY_TOO_SMALL' using errcode = 'P0001'; end if;
  p := _pay_new('order', o.id::text, array[o.id::text], jsonb_build_array(jsonb_build_object('id', o.id, 'amount', due)),
                p_id, due, 'Order MM-' || o.no, mins, true, lang);
  update store_orders set payment_id = p.id, expires_at = p.expires_at where id = o.id returning * into o;
  return jsonb_build_object('order', _store_order_json(o), 'key', o.track_key, 'payment', _pay_json(p), 'gift_key', o.gift_key);
end $fn$
  $f$;
  execute $f$ revoke execute on function public.store_checkout(text, text, text, jsonb) from public $f$;
  execute $f$ grant execute on function public.store_checkout(text, text, text, jsonb) to anon, authenticated $f$;

  -- _store_order_json (20261119300000): each line's preorder mark and its product's ships_on
  execute $f$
create or replace function public._store_order_json(o store_orders, p_staff boolean default false) returns jsonb
language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    'id', o.id, 'no', o.no, 'status', o.status, 'fulfil', o.fulfil, 'name', o.name,
    'phone', case when p_staff then o.phone else repeat(chr(8226), 4) || ' ' || right(o.phone, 4) end,
    'email', case when p_staff then o.email end,
    'address', case when p_staff then o.address else
                 case when o.address is null then null else jsonb_build_object('city', o.address ->> 'city', 'district', o.address ->> 'district') end end,
    'note', case when p_staff then o.note end, 'staff_note', case when p_staff then o.staff_note end,
    'customer_id', case when p_staff then o.customer_id end,
    'subtotal', o.subtotal, 'delivery_fee', o.delivery_fee, 'total', o.total, 'wallet_paid', o.wallet_paid,
    -- L06: a gift card is a voucher, so its VAT is charged when it is spent, not when it is sold (store build)
    'vat', round(greatest(o.total - coalesce((select sum(i.unit_price * i.qty) from store_order_items i where i.order_id = o.id and i.gift_card), 0), 0) * 15 / 115, 2),
    'courier', o.courier, 'tracking_no', o.tracking_no, 'expires_at', o.expires_at, 'paid_at', o.paid_at,
    'created_at', o.created_at, 'cancel_reason', o.cancel_reason, 'payment_id', o.payment_id,
    -- the order's invoice number (paid by card or wholly from the wallet: 'ord-<no>' either way)
    'receipt_no', (select r.no from receipt_numbers r where r.receipt_id = 'ord-' || o.no),
    'payment', (select _pay_json(p) from payments p where p.id = o.payment_id),
    -- X08: each line's own photo and address, kept when it was sold (the product's now, for a line sold before that);
    -- a pre-order line and its product's ships-on date (store catalogue plus, 20261119400100)
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'variant', i.variant, 'qty', i.qty,
                         'unit_price', i.unit_price, 'product_id', i.product_id, 'variant_id', i.variant_id,
                         'image', coalesce(i.image, sp.images[1]), 'slug', coalesce(i.slug, sp.slug), 'gift_card', i.gift_card,
                         'reviewed', exists (select 1 from store_reviews rv where rv.order_id = o.id and rv.product_id = i.product_id),
                         'preorder', i.preorder, 'ships_on', sp.ships_on) order by i.id)
                       from store_order_items i left join store_products sp on sp.id = i.product_id where i.order_id = o.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('at', e.at, 'status', e.status, 'note', e.note, 'by', case when p_staff then e.by_name end,
                          'public', e.public) order by e.id)
                        from store_order_events e where e.order_id = o.id and (p_staff or e.public)), '[]'::jsonb))
  || jsonb_build_object(
    'discount', o.discount, 'discounts', o.discounts, 'promo_code', o.promo_code, 'gift_paid', o.gift_paid,
    'gift', o.gift, 'gift_note', o.gift_note, 'slot', o.slot,
    -- L06: the store's own invoice number, given when the order was paid ("INV-000001"); null for an order never paid
    'invoice_no', o.invoice_no,
    'invoice', case when o.invoice_no is not null then 'INV-' || case when length(o.invoice_no::text) >= 6 then o.invoice_no::text
                                                                    else lpad(o.invoice_no::text, 6, '0') end end,
    -- the seller as it stood when the invoice was issued (20261119000800, stg11-4); null for an invoice issued before
    'seller', case when o.seller_name_en is not null then jsonb_build_object('name_en', o.seller_name_en, 'name_ar', o.seller_name_ar,
                                                                              'vat', o.seller_vat, 'cr', o.seller_cr) end,
    'gift_card_id', case when p_staff then o.gift_card_id end,
    -- staff only: what Void cards and refund would void and refund now (null for an order that bought no gift cards)
    'gift_refund', case when p_staff and exists (select 1 from store_gift_cards g where g.order_id = o.id) then _store_gift_refund_plan(o) end,
    'gift_card_code', case when p_staff then (select g.code from store_gift_cards g where g.id = o.gift_card_id) end,
    'delivered_at', (select e.at from store_order_events e where e.order_id = o.id and e.status = 'delivered' order by e.id limit 1),
    'returns', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'status', r.status, 'items', r.items, 'reason', r.reason,
                           'note', r.note, 'amount', r.amount, 'created_at', r.created_at, 'decided_at', r.decided_at)
                           || case when p_staff then jsonb_build_object('staff_note', r.staff_note, 'decided_by', r.decided_by) else '{}'::jsonb end
                           order by r.created_at)
                         from store_return_requests r where r.order_id = o.id), '[]'::jsonb),
    -- the gift cards this order bought, once it is paid: whole codes for staff, masked for every customer read
    -- (store_order_get with the gift key and customer_orders put the buyer's whole codes back)
    'gift_cards', _store_order_gifts(o, p_staff, p_staff),
    -- X09: every refund and where it went. Refunds of the order's payments (one owed is staff's only), the wallet's
    -- part given back (a give-back the order took again when it was paid late is left out), the gift card's part given
    -- back or refunded (the same). A wallet refund staff send in Payments is a payment_refunds row, never counted twice.
    'refunds', coalesce((select jsonb_agg(x.j order by x.at, x.k) from (
        select jsonb_build_object('id', r.id, 'amount', r.amount, 'dest', r.dest, 'status', r.status, 'at', coalesce(r.done_at, r.created_at)) j,
               coalesce(r.done_at, r.created_at) at, 1 k
          from payment_refunds r
         where (r.order_id = o.id or r.payment_id in (select p.id from payments p where p.kind = 'order' and p.ref = o.id::text))
           and (p_staff or r.status in ('pending', 'done'))
        union all
        select jsonb_build_object('amount', l.amount, 'dest', 'wallet', 'status', 'done', 'at', l.created_at), l.created_at, 2
          from wallet_ledger l
         where o.wallet_paid > 0 and l.receipt_id = 'ord-' || o.no and l.kind = 'sale_back'
           and not exists (select 1 from wallet_ledger l2 where l2.receipt_id = l.receipt_id and l2.kind = 'sale' and l2.id > l.id)
        union all
        select jsonb_build_object('amount', m.amount, 'dest', 'gift', 'status', 'done', 'at', m.at), m.at, 3
          from store_gift_card_moves m
         where o.gift_card_id is not null and m.card_id = o.gift_card_id and m.order_id = o.id and m.kind in ('back', 'refund')
           and not exists (select 1 from store_gift_card_moves m2 where m2.card_id = m.card_id and m2.order_id = m.order_id
                             and m2.kind = 'spend' and m2.id > m.id)) x), '[]'::jsonb))
  -- the build of 2026-11-18 (B3): a company, the pin, the handover slot, the session, still learning, the quote (_store_order_sx)
  || _store_order_sx(o, p_staff)
$fn$
  $f$;
  execute $f$ revoke execute on function public._store_order_json(store_orders, boolean) from public, anon, authenticated $f$;

  -- store_fleet_record (20261119300000): a live product's fleet bike
  execute $f$
create or replace function public.store_fleet_record(p_product uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $fn$
declare
  v_bike text;
  v_from date;
  v_to date;
  v_rides int;
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
begin
  if p_product is null then return null; end if;
  /* live: published and inside its schedule (store catalogue plus, 20261119400100) */
  select sp.fleet_bike_id into v_bike
    from store_products sp
   where sp.id = p_product and _store_live(sp) and sp.condition = 'certified' and sp.fleet_bike_id is not null;
  if v_bike is null then return null; end if;

  -- a ride: a booking checked in on this bike (an assignment row, or the booking's own assigned_bike_id)
  select count(*) into v_rides from (
    select ba.booking_id as id
      from bike_assignments ba join queue_entries q on q.id = ba.booking_id
     where ba.bike_id = v_bike and q.status in ('active', 'done')
    union
    select q.id from queue_entries q
     where q.assigned_bike_id = v_bike and q.status in ('active', 'done')
  ) r;

  select case when b.in_service_date ~ '^\d{4}-\d\d-\d\d$' then b.in_service_date::date end,
         case when b.retired_date ~ '^\d{4}-\d\d-\d\d$' then b.retired_date::date end
    into v_from, v_to
    from bikes b where b.id = v_bike;
  if v_from is null then
    select (min(ba.assigned_at) at time zone 'Asia/Riyadh')::date into v_from from bike_assignments ba where ba.bike_id = v_bike;
  end if;
  v_to := least(coalesce(v_to, v_today), v_today);

  if coalesce(v_rides, 0) = 0 and v_from is null then return null; end if;
  return jsonb_build_object(
    'rides', coalesce(v_rides, 0),
    'months', case when v_from is null or v_to < v_from then 0
                   else (extract(year from age(v_to, v_from)) * 12 + extract(month from age(v_to, v_from)))::int end);
end $fn$
  $f$;
  execute $f$ revoke execute on function public.store_fleet_record(uuid) from public $f$;
  execute $f$ grant execute on function public.store_fleet_record(uuid) to anon, authenticated $f$;

  -- store_rode_type (20261119300000): a live bike product
  execute $f$
create or replace function public.store_rode_type(p_id text, p_token text, p_product uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $fn$
declare
  v_type text;
  v_n int;
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
begin
  if p_id is null or p_token is null or p_product is null or length(p_id) > 80 or length(p_token) > 200 then return null; end if;
  if not _cust_token_ok(p_id, p_token) then return null; end if;
  /* live: published and inside its schedule (store catalogue plus, 20261119400100) */
  select cm.ride_type into v_type
    from store_products sp join catalog_models cm on cm.id = sp.catalog_model
   where sp.id = p_product and _store_live(sp) and sp.category = 'bikes';
  if v_type is null then return null; end if;

  select count(*) into v_n
    from queue_entries q
    join sessions s on s.id = q.session_id
    left join bikes b on b.id = q.assigned_bike_id
   where q.customer_id = p_id
     and q.status in ('active', 'done')
     and s.ride_kind = 'saturday' and s.cancelled_at is null and coalesce(s.draft, false) = false
     and coalesce(s.status, '') <> 'deleted'
     and s.session_date ~ '^\d{4}-\d\d-\d\d$' and s.session_date::date <= v_today
     and coalesce(b.type, q.type_preference) = v_type;
  if coalesce(v_n, 0) = 0 then return null; end if;
  return jsonb_build_object('rides', v_n);
end $fn$
  $f$;
  execute $f$ revoke execute on function public.store_rode_type(text, text, uuid) from public $f$;
  execute $f$ grant execute on function public.store_rode_type(text, text, uuid) to anon, authenticated $f$;
end $stg$;

-- === Checks ======================================================================================
-- every definer function written here keeps SECURITY DEFINER and its search_path; the inner ones no client may run; the
-- staff ones not anon; what the public reads is reachable; every new table under row security; the staff-only tables
-- never readable by anon; no staff_store_ready where there are no orders.
do $chk$
declare f text; t text; defs text[]; inner_fns text[]; staff_fns text[]; anon_fns text[];
begin
  defs := array['public.staff_store_mode()', 'public._store_tags_ok(text[])', 'public._store_product_tidy()',
                'public._store_live(public.store_products)', 'public._store_cat_guard()', 'public.staff_store_category_delete(text,text)',
                'public.store_bestsellers(integer,integer)', 'public._store_stock_log()',
                'public.staff_store_stock_move(uuid,integer,text,text)', 'public.staff_store_stock_count(uuid,integer,text)',
                'public.staff_store_receive(jsonb,bigint,text,text,boolean)',
                'public.staff_store_stock_moves(uuid,uuid,text,date,date,integer)', 'public.staff_store_duplicate(uuid,text,text)',
                'public.staff_store_import(jsonb,boolean)', 'public.staff_store_bulk(uuid[],text,jsonb)', 'public.staff_store_sort(text,text[])',
                'public.staff_store_report(date,date)'];
  inner_fns := array['public._store_product_tidy()', 'public._store_cat_guard()', 'public._store_stock_log()'];
  staff_fns := array['public.staff_store_mode()', 'public.staff_store_category_delete(text,text)',
                     'public.staff_store_stock_move(uuid,integer,text,text)', 'public.staff_store_stock_count(uuid,integer,text)',
                     'public.staff_store_receive(jsonb,bigint,text,text,boolean)',
                     'public.staff_store_stock_moves(uuid,uuid,text,date,date,integer)', 'public.staff_store_duplicate(uuid,text,text)',
                     'public.staff_store_import(jsonb,boolean)', 'public.staff_store_bulk(uuid[],text,jsonb)',
                     'public.staff_store_sort(text,text[])', 'public.staff_store_report(date,date)'];
  anon_fns := array['public._store_live(public.store_products)', 'public.store_bestsellers(integer,integer)'];
  if to_regclass('public.store_orders') is not null then
    defs := defs || array['public._store_restock(uuid)', 'public._store_quote_json(public.store_quotes)', 'public.staff_store_quote_save(jsonb)',
                          'public.store_promo_check(text,text,jsonb)', 'public.store_stock_request(text,uuid,text,text,text)',
                          'public.store_checkout(text,text,text,jsonb)', 'public._store_order_json(public.store_orders,boolean)',
                          'public.store_fleet_record(uuid)', 'public.store_rode_type(text,text,uuid)'];
    inner_fns := inner_fns || array['public._store_restock(uuid)', 'public._store_quote_json(public.store_quotes)',
                                    'public._store_order_json(public.store_orders,boolean)'];
    staff_fns := staff_fns || array['public.staff_store_quote_save(jsonb)'];
    anon_fns := anon_fns || array['public.store_promo_check(text,text,jsonb)', 'public.store_stock_request(text,uuid,text,text,text)',
                                  'public.store_checkout(text,text,text,jsonb)', 'public.store_fleet_record(uuid)',
                                  'public.store_rode_type(text,text,uuid)'];
  end if;
  foreach f in array defs loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array inner_fns loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  foreach f in array staff_fns loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception 'staff cannot reach %', f; end if;
  end loop;
  foreach f in array anon_fns loop
    if not has_function_privilege('anon', f, 'execute') then raise exception 'the public cannot reach %', f; end if;
  end loop;
  foreach t in array array['store_categories', 'store_collections', 'store_collection_items', 'store_suppliers', 'store_product_private',
                           'store_variant_costs', 'store_stock_moves'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      raise exception '% has no row security', t;
    end if;
  end loop;
  foreach t in array array['store_suppliers', 'store_product_private', 'store_variant_costs', 'store_stock_moves'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') then raise exception 'anon can read %', t; end if;
  end loop;
  if has_table_privilege('authenticated', 'public.store_stock_moves', 'insert') then raise exception 'clients can write stock moves'; end if;
  if has_sequence_privilege('anon', 'public.store_stock_moves_id_seq', 'update') or has_sequence_privilege('authenticated', 'public.store_stock_moves_id_seq', 'update')
     or has_sequence_privilege('anon', 'public.store_suppliers_id_seq', 'update') or has_sequence_privilege('authenticated', 'public.store_suppliers_id_seq', 'update') then
    raise exception 'a client can move a store sequence';
  end if;
  if to_regclass('public.store_orders') is null and to_regprocedure('public.staff_store_ready()') is not null then
    raise exception 'staff_store_ready() exists on a database without store_orders';
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.store_products'::regclass and conname = 'store_products_category_check')
     or not exists (select 1 from pg_constraint where conrelid = 'public.store_products'::regclass and conname = 'store_products_category_fkey') then
    raise exception 'store_products.category is not the categories'' foreign key';
  end if;
  if (select count(*) from store_categories where slug in ('bikes', 'accessories', 'apparel', 'parts', 'nutrition', 'gift')) <> 6 then
    raise exception 'the six categories are not all there';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name) values ('20261119400100', 'store_catalog_plus') on conflict do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only), after applying:
-- select (select count(*) from store_categories) as categories_6_or_more,
--        (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'store_products'
--           and column_name in ('preview','publish_at','unpublish_at','badge','badge_en','badge_ar','badge_until','seo_title_en',
--                               'seo_title_ar','seo_desc_en','seo_desc_ar','max_per_order','preorder','ships_on','weight_g',
--                               'dims_cm','tags','low_stock_at')) as product_columns_18,
--        (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relrowsecurity
--           and c.relname in ('store_categories','store_collections','store_collection_items','store_suppliers',
--                             'store_product_private','store_variant_costs','store_stock_moves')) as secured_tables_7,
--        to_regprocedure('public.staff_store_ready()') is not null as staff_store_ready_false_on_production,
--        (select count(*) from supabase_migrations.schema_migrations where version = '20261119400100') as ledger_1;
-- and, as staff (the staff app): select staff_store_mode();  -- 'catalog' on production, 'full' on staging
