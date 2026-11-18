-- ============================================================================
-- The store catalogue's base (2026-11-19, store product management build): the two catalogue tables and their helpers,
-- for a database that has no store yet (production).
--
-- Why it exists. The user, 2026-11-19: "how can we add products to the store? make sure to implement everything needed
-- in details in the staff page", "i want to be able to add to the store from the current staff website" and "i dont
-- want the store to become live". So staff build the catalogue in the LIVE staff app (staff.micromobility.sa, the
-- production database) before the store goes live; production gets ONLY the catalogue (no orders, payments, gift
-- cards, reviews or quotes), and an hourly job copies what staff publish to staging, where the store is looked at.
-- Production has none of the store's tables (they came with 20261110150000_online_payments and
-- 20261115235500_store_build, which are staging only), so this file makes the two the catalogue stands on.
--
-- What it does:
--  * Where public.store_products already exists (staging, or production once the store is live) it does NOTHING but
--    write its ledger row.
--  * Elsewhere it creates public.store_products and public.store_variants EXACTLY as staging has them after
--    20261119300000_sx_do_all (every column, default, named constraint and its body, index, policy, grant and
--    trigger, the fleet_bike_id foreign key to bikes), and the functions they need: _store_touch (verbatim),
--    _store_licence (production body: reads site_content 'store.discountLicence' directly, as production has no
--    _pay_setting; same answer: the trimmed licence number, at most 40 characters, or null), _store_product_guard
--    (verbatim) and staff_store_stock (verbatim), with staging's grants. Copied from 20261110150000 (tables, policies,
--    _store_touch, staff_store_stock), 20261115235500 (the columns and checks it added, _store_licence,
--    _store_product_guard) and 20261119300000 (fleet_bike_id); staging's live definitions were read on 2026-11-19.
--  * It does NOT create staff_store_ready(): the staff app in use today shows Orders and Payments when that function
--    answers true, and production has neither. The staff app asks staff_store_mode() (20261119400100) instead.
--  * 20261119400100_store_catalog_plus.sql runs next, on both databases, and adds everything else.
--
-- At launch (the store goes live on production): the store's own migrations (20261110150000 onward) must not
-- re-create these tables. They use "create table if not exists", so they leave them as they are; they DO re-create
-- some policies and functions 20261119400100 changes (the products' and variants' read policies, _store_licence and
-- the store functions that test "published"), so run 20261119400100 again after them (it is re-runnable).
--
-- Applied by the lead: staging first (a no-op there), then production. Idempotent: run twice, the second run changes
-- nothing. Rollback idea (production only, before anything else uses them): drop table public.store_variants,
-- public.store_products; drop function public.staff_store_stock(uuid, int), public._store_product_guard(),
-- public._store_licence(), public._store_touch(); delete the ledger row.
-- Tested on a throwaway local Postgres 17 (production-like stubs and a staging-like build), applied twice.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $base$
begin
  if to_regclass('public.store_products') is not null then
    raise notice 'store_catalog_base: public.store_products exists here, nothing to do';
    return;
  end if;

  -- -- store_products, as staging has it ----------------------------------------------------------
  create table public.store_products (
    id              uuid not null default gen_random_uuid(),
    slug            text not null,
    category        text not null,
    brand           text,
    name_en         text not null,
    name_ar         text,
    tagline_en      text,
    tagline_ar      text,
    description_en  text,
    description_ar  text,
    specs           jsonb not null default '[]'::jsonb,
    images          text[] not null default '{}',
    price           numeric(10,2) not null,
    compare_at      numeric(10,2),
    ship_ksa        boolean not null default true,
    catalog_model   uuid,
    published       boolean not null default false,
    sort            integer not null default 0,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    kind            text not null default 'item',
    condition       text not null default 'new',
    warranty_months integer,
    key_specs       jsonb not null default '[]'::jsonb,
    box             jsonb not null default '[]'::jsonb,
    fit             jsonb,
    faq             jsonb not null default '[]'::jsonb,
    sizes           jsonb not null default '[]'::jsonb,
    image_meta      jsonb not null default '{}'::jsonb,
    goes_with       uuid[] not null default '{}',
    compare_with    uuid[] not null default '{}',
    bundle          jsonb,
    sale_from       date,
    sale_to         date,
    fleet_bike_id   text,
    constraint store_products_pkey primary key (id),
    constraint store_products_slug_key unique (slug),
    constraint store_products_slug_check
      check (slug ~ '^[a-z][a-z0-9-]{1,60}$' and slug not in ('cart', 'checkout', 'order', 'track', 'saved', 'category')
             and (slug <> 'gift-card' or kind = 'gift_card')),
    constraint store_products_category_check
      check (category in ('bikes', 'accessories', 'apparel', 'parts', 'nutrition', 'gift')),
    constraint store_products_brand_check check (brand is null or length(brand) <= 40),
    constraint store_products_name_en_check check (length(name_en) between 1 and 80),
    constraint store_products_name_ar_check check (name_ar is null or length(name_ar) <= 80),
    constraint store_products_tagline_en_check check (tagline_en is null or length(tagline_en) <= 140),
    constraint store_products_tagline_ar_check check (tagline_ar is null or length(tagline_ar) <= 140),
    constraint store_products_description_en_check check (description_en is null or length(description_en) <= 4000),
    constraint store_products_description_ar_check check (description_ar is null or length(description_ar) <= 4000),
    constraint store_products_specs_check check (jsonb_typeof(specs) = 'array' and pg_column_size(specs) < 8000),
    constraint store_products_images_check check (coalesce(array_length(images, 1), 0) <= 24),
    constraint store_products_price_check check (price > 0 and price <= 100000),
    constraint store_products_check check (compare_at is null or compare_at > price),
    constraint store_products_kind_check check (kind in ('item', 'gift_card') and (kind <> 'gift_card' or category = 'gift')),
    constraint store_products_condition_check check (condition in ('new', 'certified')),
    constraint store_products_warranty_months_check
      check (warranty_months is null or (warranty_months between 12 and 120 and (condition <> 'new' or warranty_months >= 24))),
    constraint store_products_key_specs_check
      check (case when jsonb_typeof(key_specs) = 'array' then jsonb_array_length(key_specs) <= 6 and pg_column_size(key_specs) < 4000 else false end),
    constraint store_products_box_check
      check (case when jsonb_typeof(box) = 'array' then jsonb_array_length(box) <= 12 and pg_column_size(box) < 4000 else false end),
    constraint store_products_fit_check check (fit is null or (jsonb_typeof(fit) = 'object' and pg_column_size(fit) < 2000)),
    constraint store_products_faq_check
      check (case when jsonb_typeof(faq) = 'array' then jsonb_array_length(faq) <= 8 and pg_column_size(faq) < 12000 else false end),
    constraint store_products_sizes_check
      check (case when jsonb_typeof(sizes) = 'array' then jsonb_array_length(sizes) <= 12 and pg_column_size(sizes) < 3000 else false end),
    constraint store_products_image_meta_check check (jsonb_typeof(image_meta) = 'object' and pg_column_size(image_meta) < 12000),
    constraint store_products_goes_with_check check (cardinality(goes_with) <= 8),
    constraint store_products_compare_with_check check (cardinality(compare_with) <= 3),
    constraint store_products_bundle_check check (bundle is null or (jsonb_typeof(bundle) = 'object' and pg_column_size(bundle) < 1000)),
    constraint store_products_sale_check check (sale_from is null or sale_to is null or sale_to >= sale_from),
    constraint store_products_fleet_bike_check check (fleet_bike_id is null or (length(fleet_bike_id) <= 80 and condition = 'certified')),
    constraint store_products_fleet_bike_id_fkey foreign key (fleet_bike_id) references public.bikes (id) on delete set null
  );
  comment on column public.store_products.fleet_bike_id is
    'N25 (2026-11-18): the fleet bike a certified pre-owned product was; its rides and months show on the product page (store_fleet_record).';
  create index store_products_fleet_bike_idx on public.store_products (fleet_bike_id) where fleet_bike_id is not null;

  -- -- store_variants, as staging has it ----------------------------------------------------------
  create table public.store_variants (
    id          uuid not null default gen_random_uuid(),
    product_id  uuid not null,
    sku         text,
    size        text,
    color_en    text,
    color_ar    text,
    color_hex   text,
    price       numeric(10,2),
    stock       integer not null default 0,
    active      boolean not null default true,
    sort        integer not null default 0,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now(),
    constraint store_variants_pkey primary key (id),
    constraint store_variants_product_id_fkey foreign key (product_id) references public.store_products (id) on delete cascade,
    constraint store_variants_sku_key unique (sku),
    constraint store_variants_sku_check check (sku is null or sku ~ '^[A-Za-z0-9._-]{1,40}$'),
    constraint store_variants_size_check check (size is null or length(size) <= 20),
    constraint store_variants_color_en_check check (color_en is null or length(color_en) <= 30),
    constraint store_variants_color_ar_check check (color_ar is null or length(color_ar) <= 30),
    constraint store_variants_color_hex_check check (color_hex is null or color_hex ~ '^#[0-9a-fA-F]{6}$'),
    constraint store_variants_price_check check (price is null or (price > 0 and price <= 100000)),
    constraint store_variants_stock_check check (stock >= 0)
  );
  create index store_variants_product on public.store_variants (product_id, sort);

  -- -- Who reads and writes: anyone reads what is published, staff read all, admins write ---------
  alter table public.store_products enable row level security;
  alter table public.store_variants enable row level security;
  revoke all on public.store_products, public.store_variants from anon, authenticated;
  create policy "store products public read" on public.store_products for select to anon, authenticated
    using (published or (select is_staff()));
  create policy "store products admin insert" on public.store_products for insert to authenticated with check ((select is_admin()));
  create policy "store products admin update" on public.store_products for update to authenticated
    using ((select is_admin())) with check ((select is_admin()));
  create policy "store products admin delete" on public.store_products for delete to authenticated using ((select is_admin()));
  create policy "store variants public read" on public.store_variants for select to anon, authenticated
    using ((select is_staff()) or (active and exists (select 1 from store_products p where p.id = store_variants.product_id and p.published)));
  create policy "store variants admin insert" on public.store_variants for insert to authenticated with check ((select is_admin()));
  create policy "store variants admin update" on public.store_variants for update to authenticated
    using ((select is_admin())) with check ((select is_admin()));
  create policy "store variants admin delete" on public.store_variants for delete to authenticated using ((select is_admin()));
  grant select on public.store_products, public.store_variants to anon;
  grant select, insert, update, delete on public.store_products, public.store_variants to authenticated;

  -- -- The functions (verbatim from staging, but _store_licence's body) --------------------------
  create or replace function public._store_touch() returns trigger
  language plpgsql set search_path = public as $fn$
  begin new.updated_at := now(); return new; end $fn$;
  revoke all on function public._store_touch() from public, anon, authenticated;

  -- The discount licence number (store.discountLicence): a written string, trimmed, or null. Staging reads it through
  -- the payments helper _pay_setting; production has none, so this body reads site_content itself (same answer).
  create or replace function public._store_licence() returns text
  language sql stable security definer set search_path = public as $fn$
    select case when jsonb_typeof(v) = 'string' then left(nullif(btrim(v #>> '{}'), ''), 40) end
      from (select (select c.value from site_content c where c.key = 'store.discountLicence') v) x
  $fn$;
  revoke execute on function public._store_licence() from public, anon, authenticated;

  -- What a product row may say (20261115235500, verbatim): a former price, a bundle and sale dates need the discount
  -- licence number (STORE_LICENCE); a gift card is in the gift category (STORE_KIND); a bundle is 1-3 other products and
  -- a price (STORE_BUNDLE), kept tidy.
  create or replace function public._store_product_guard() returns trigger
  language plpgsql security definer set search_path = public as $fn$
  declare lic text := _store_licence(); ids text[]; pr numeric;
  begin
    if new.kind = 'gift_card' and new.category is distinct from 'gift' then raise exception 'STORE_KIND' using errcode = 'P0001'; end if;
    if lic is null then
      if new.compare_at is not null and (tg_op = 'INSERT' or new.compare_at is distinct from old.compare_at) then
        raise exception 'STORE_LICENCE: compare_at' using errcode = 'P0001';
      end if;
      if new.bundle is not null and (tg_op = 'INSERT' or new.bundle is distinct from old.bundle) then
        raise exception 'STORE_LICENCE: bundle' using errcode = 'P0001';
      end if;
      if (new.sale_from is not null and (tg_op = 'INSERT' or new.sale_from is distinct from old.sale_from))
         or (new.sale_to is not null and (tg_op = 'INSERT' or new.sale_to is distinct from old.sale_to)) then
        raise exception 'STORE_LICENCE: sale' using errcode = 'P0001';
      end if;
    end if;
    if new.bundle is not null and (tg_op = 'INSERT' or new.bundle is distinct from old.bundle) then
      if jsonb_typeof(new.bundle) is distinct from 'object' or jsonb_typeof(new.bundle -> 'items') is distinct from 'array'
         or jsonb_typeof(new.bundle -> 'price') is distinct from 'number' or new.kind = 'gift_card' then
        raise exception 'STORE_BUNDLE' using errcode = 'P0001';
      end if;
      if exists (select 1 from jsonb_array_elements(new.bundle -> 'items') e where jsonb_typeof(e) <> 'string') then
        raise exception 'STORE_BUNDLE' using errcode = 'P0001';
      end if;
      select array_agg(lower(btrim(x)) order by n) into ids from jsonb_array_elements_text(new.bundle -> 'items') with ordinality t(x, n);
      if coalesce(array_length(ids, 1), 0) not between 1 and 3
         or exists (select 1 from unnest(ids) x where x !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
         or (select count(distinct x) from unnest(ids) x) <> array_length(ids, 1)
         or new.id::text = any(ids)
         or (select count(*) from store_products p where p.id::text = any(ids) and p.kind <> 'gift_card') <> array_length(ids, 1) then
        raise exception 'STORE_BUNDLE' using errcode = 'P0001';
      end if;
      pr := (new.bundle ->> 'price')::numeric;
      if pr <= 0 or pr > 100000 then raise exception 'STORE_BUNDLE' using errcode = 'P0001'; end if;
      new.bundle := jsonb_build_object('items', to_jsonb(ids), 'price', round(pr, 2));
    end if;
    return new;
  end $fn$;
  revoke execute on function public._store_product_guard() from public, anon, authenticated;

  create trigger store_products_guard before insert or update on public.store_products
    for each row execute function _store_product_guard();
  create trigger store_products_touch before update on public.store_products for each row execute function _store_touch();
  create trigger store_variants_touch before update on public.store_variants for each row execute function _store_touch();

  -- Stock counted or received: a change by so many (20261110150000, verbatim). Its moves are logged by
  -- 20261119400100's trigger with the reason 'edit'.
  create or replace function public.staff_store_stock(p_variant uuid, p_delta int) returns jsonb
  language plpgsql security definer set search_path = public as $fn$
  declare v store_variants%rowtype;
  begin
    if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
    if p_delta is null or abs(p_delta) > 10000 then raise exception 'STORE_STOCK' using errcode = 'P0001'; end if;
    update store_variants set stock = stock + p_delta where id = p_variant and stock + p_delta >= 0 returning * into v;
    if v.id is null then raise exception 'STORE_STOCK' using errcode = 'P0001'; end if;
    return jsonb_build_object('id', v.id, 'stock', v.stock);
  end $fn$;
  revoke execute on function public.staff_store_stock(uuid, int) from public, anon;
  grant execute on function public.staff_store_stock(uuid, int) to authenticated;
end $base$;

-- -- Checks (both databases): the catalogue tables under row security, the helpers' attributes, no client runs the
--    inner ones, and where there are no orders there is no staff_store_ready (the old app would show Orders) ------
do $chk$
declare f text;
begin
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.store_products'::regclass)
     or not (select c.relrowsecurity from pg_class c where c.oid = 'public.store_variants'::regclass) then
    raise exception 'store_products or store_variants has no row security';
  end if;
  foreach f in array array['public._store_licence()', 'public._store_product_guard()', 'public.staff_store_stock(uuid,integer)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._store_licence()', 'public._store_product_guard()', 'public._store_touch()'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.staff_store_stock(uuid,integer)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_store_stock(uuid,integer)', 'execute') then
    raise exception 'staff_store_stock: anon may run it or staff may not';
  end if;
  if to_regclass('public.store_orders') is null and to_regprocedure('public.staff_store_ready()') is not null then
    raise exception 'staff_store_ready() exists on a database without store_orders: the staff app would show Orders and Payments';
  end if;
  if has_table_privilege('anon', 'public.store_products', 'insert') or not has_table_privilege('anon', 'public.store_products', 'select') then
    raise exception 'store_products grants are not staging''s';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name) values ('20261119400000', 'store_catalog_base') on conflict do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only), after applying:
-- select to_regclass('public.store_products') is not null as products_true,
--        to_regclass('public.store_variants') is not null as variants_true,
--        (select count(*) from pg_constraint where conrelid = 'public.store_products'::regclass) as product_constraints,
--        (select count(*) from pg_policies where schemaname = 'public' and tablename in ('store_products', 'store_variants')) as policies_8,
--        to_regprocedure('public.staff_store_ready()') is not null as staff_store_ready_false_on_production,
--        public._store_licence() as licence,
--        (select count(*) from supabase_migrations.schema_migrations where version = '20261119400000') as ledger_1;
