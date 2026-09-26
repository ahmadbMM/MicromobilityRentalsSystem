-- ============================================================================
-- The bike catalogue: micromobility.sa/bikes (owner, 2026-09-26).
--
-- What the public website shows under /bikes - categories, their sub-types, the models in
-- them, each model's specifications, colours, photos and spec sheet - edited from the staff
-- page (Website > Bikes catalog). The website reads it with the public key, like site_content;
-- only admins write it. A model is hidden until it is published, so staff can fill it in first.
--
--  1. catalog_categories  - two levels in one table: a row with no parent is a category
--                           (Road, Mountain...), a row whose parent is a category is a sub-type
--                           (Carbon, Endurance...). A sub-type cannot have children. The slug is
--                           the address segment (/bikes/road/carbon) and must start with a
--                           letter: /bikes/42 is a fleet bike's NFC page, so a number can never
--                           be a category.
--  2. catalog_spec_fields - the specifications a model can carry (Frame, Groupset, Weight...),
--                           with their labels in English and Arabic, a group and a unit. Staff
--                           define them once; every model's specs are values keyed by them.
--  3. catalog_models      - a model: its category and optional sub-type, brand, name, year, the
--                           rental bike type it rides as (which decides the Book a ride price),
--                           its texts, its specs (JSON: {"frame": {"en": "...", "ar": "..."}}),
--                           its spec sheet (a PDF) and whether it is published.
--  4. catalog_colors      - a model's colour options.
--  5. catalog_photos      - a model's photos, in order, each optionally for one colour.
--  6. The 'site' bucket now also takes PDFs (spec sheets) and 10 MB files.
--
-- Everyone may read published rows (anon, authenticated); admins read everything and insert,
-- change and delete. updated_at is set on every write.
--
-- Rollback:
--   drop table if exists public.catalog_photos, public.catalog_colors, public.catalog_models,
--     public.catalog_spec_fields, public.catalog_categories;
--   drop function if exists public._catalog_touch(), public._catalog_category_check(),
--     public._catalog_model_check(), public._catalog_photo_check();
--   update storage.buckets set file_size_limit = 5242880,
--     allowed_mime_types = array['image/jpeg','image/png','image/webp','image/avif'] where id = 'site';
-- Idempotent.
-- ============================================================================

begin;

-- ── Shared: updated_at is the server's clock ─────────────────────────────────
create or replace function public._catalog_touch()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  new.updated_at := now();
  return new;
end $function$;
revoke all on function public._catalog_touch() from public, anon, authenticated;

-- ── 1. Categories and sub-types ──────────────────────────────────────────────
create table if not exists public.catalog_categories (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid references public.catalog_categories(id) on delete restrict,
  slug       text not null,
  name_en    text not null,
  name_ar    text not null default '',
  blurb_en   text not null default '',
  blurb_ar   text not null default '',
  cover      text,
  sort       integer not null default 0,
  published  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_categories_slug_shape check (slug ~ '^[a-z][a-z0-9-]{0,59}$'),
  constraint catalog_categories_name_size check (length(name_en) between 1 and 60 and length(name_ar) <= 60),
  constraint catalog_categories_blurb_size check (length(blurb_en) <= 300 and length(blurb_ar) <= 300),
  constraint catalog_categories_cover_shape check (cover is null or (length(cover) <= 400 and cover ~ '^(/media/[A-Za-z0-9_./-]+|https://[^[:space:]]+)$')),
  constraint catalog_categories_slug_uniq unique nulls not distinct (parent_id, slug)
);
create index if not exists catalog_categories_parent_sort on public.catalog_categories (parent_id, sort, name_en);

-- Two levels only: a parent must itself be a category (no parent), and never the row itself.
create or replace function public._catalog_category_check()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  p_parent uuid;
begin
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'a category cannot be its own parent' using errcode = 'check_violation';
    end if;
    select parent_id into p_parent from public.catalog_categories where id = new.parent_id;
    if not found then
      raise exception 'parent category not found' using errcode = 'foreign_key_violation';
    end if;
    if p_parent is not null then
      raise exception 'a sub-type cannot have sub-types of its own' using errcode = 'check_violation';
    end if;
    -- A category with sub-types cannot become a sub-type.
    if exists (select 1 from public.catalog_categories where parent_id = new.id) then
      raise exception 'a category with sub-types cannot become a sub-type' using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $function$;
revoke all on function public._catalog_category_check() from public, anon, authenticated;
drop trigger if exists catalog_category_check on public.catalog_categories;
create trigger catalog_category_check before insert or update on public.catalog_categories
  for each row execute function public._catalog_category_check();

alter table public.catalog_categories enable row level security;
drop policy if exists "catalog categories public read" on public.catalog_categories;
create policy "catalog categories public read" on public.catalog_categories
  for select to anon, authenticated using (published or (select public.is_admin()));
drop policy if exists "catalog categories admin insert" on public.catalog_categories;
create policy "catalog categories admin insert" on public.catalog_categories
  for insert to authenticated with check ((select public.is_admin()));
drop policy if exists "catalog categories admin update" on public.catalog_categories;
create policy "catalog categories admin update" on public.catalog_categories
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "catalog categories admin delete" on public.catalog_categories;
create policy "catalog categories admin delete" on public.catalog_categories
  for delete to authenticated using ((select public.is_admin()));
revoke all on public.catalog_categories from anon, authenticated;
grant select on public.catalog_categories to anon;
grant select, insert, update, delete on public.catalog_categories to authenticated;

-- ── 2. The specifications a model can carry ──────────────────────────────────
create table if not exists public.catalog_spec_fields (
  key        text primary key,
  label_en   text not null,
  label_ar   text not null default '',
  group_en   text not null default '',
  group_ar   text not null default '',
  unit_en    text not null default '',
  unit_ar    text not null default '',
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_spec_fields_key_shape check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint catalog_spec_fields_label_size check (length(label_en) between 1 and 60 and length(label_ar) <= 60),
  constraint catalog_spec_fields_group_size check (length(group_en) <= 60 and length(group_ar) <= 60),
  constraint catalog_spec_fields_unit_size check (length(unit_en) <= 12 and length(unit_ar) <= 12)
);
drop trigger if exists catalog_spec_fields_touch on public.catalog_spec_fields;
create trigger catalog_spec_fields_touch before update on public.catalog_spec_fields
  for each row execute function public._catalog_touch();

alter table public.catalog_spec_fields enable row level security;
drop policy if exists "catalog spec fields public read" on public.catalog_spec_fields;
create policy "catalog spec fields public read" on public.catalog_spec_fields
  for select to anon, authenticated using (true);
drop policy if exists "catalog spec fields admin insert" on public.catalog_spec_fields;
create policy "catalog spec fields admin insert" on public.catalog_spec_fields
  for insert to authenticated with check ((select public.is_admin()));
drop policy if exists "catalog spec fields admin update" on public.catalog_spec_fields;
create policy "catalog spec fields admin update" on public.catalog_spec_fields
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "catalog spec fields admin delete" on public.catalog_spec_fields;
create policy "catalog spec fields admin delete" on public.catalog_spec_fields
  for delete to authenticated using ((select public.is_admin()));
revoke all on public.catalog_spec_fields from anon, authenticated;
grant select on public.catalog_spec_fields to anon;
grant select, insert, update, delete on public.catalog_spec_fields to authenticated;

-- ── 3. Models ────────────────────────────────────────────────────────────────
create table if not exists public.catalog_models (
  id             uuid primary key default gen_random_uuid(),
  category_id    uuid not null references public.catalog_categories(id) on delete restrict,
  subtype_id     uuid references public.catalog_categories(id) on delete set null,
  slug           text not null,
  brand          text not null default '',
  name           text not null,
  model_year     integer,
  ride_type      text,
  tagline_en     text not null default '',
  tagline_ar     text not null default '',
  description_en text not null default '',
  description_ar text not null default '',
  specs          jsonb not null default '{}'::jsonb,
  spec_sheet     text,
  sort           integer not null default 0,
  published      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint catalog_models_slug_shape check (slug ~ '^[a-z][a-z0-9-]{0,79}$'),
  constraint catalog_models_slug_uniq unique (slug),
  constraint catalog_models_brand_size check (length(brand) <= 60),
  constraint catalog_models_name_size check (length(name) between 1 and 80),
  constraint catalog_models_year_range check (model_year is null or model_year between 1990 and 2100),
  constraint catalog_models_ride_type check (ride_type is null or ride_type in ('Road', 'Mountain', 'Hybrid', 'Gravel', 'Kids', 'Road Carbon')),
  constraint catalog_models_tagline_size check (length(tagline_en) <= 140 and length(tagline_ar) <= 140),
  constraint catalog_models_description_size check (length(description_en) <= 4000 and length(description_ar) <= 4000),
  constraint catalog_models_specs_shape check (jsonb_typeof(specs) = 'object' and octet_length(specs::text) <= 20000),
  constraint catalog_models_sheet_shape check (spec_sheet is null or (length(spec_sheet) <= 400 and spec_sheet ~ '^(/media/[A-Za-z0-9_./-]+|https://[^[:space:]]+)$'))
);
create index if not exists catalog_models_category_sort on public.catalog_models (category_id, subtype_id, sort, name);

-- The category is a top-level one; the sub-type, when set, is one of that category's.
create or replace function public._catalog_model_check()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  c_parent uuid;
  s_parent uuid;
begin
  select parent_id into c_parent from public.catalog_categories where id = new.category_id;
  if not found then
    raise exception 'category not found' using errcode = 'foreign_key_violation';
  end if;
  if c_parent is not null then
    raise exception 'a model belongs to a category, not directly to a sub-type' using errcode = 'check_violation';
  end if;
  if new.subtype_id is not null then
    select parent_id into s_parent from public.catalog_categories where id = new.subtype_id;
    if not found then
      raise exception 'sub-type not found' using errcode = 'foreign_key_violation';
    end if;
    if s_parent is distinct from new.category_id then
      raise exception 'the sub-type is not one of this category''s' using errcode = 'check_violation';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $function$;
revoke all on function public._catalog_model_check() from public, anon, authenticated;
drop trigger if exists catalog_model_check on public.catalog_models;
create trigger catalog_model_check before insert or update on public.catalog_models
  for each row execute function public._catalog_model_check();

alter table public.catalog_models enable row level security;
drop policy if exists "catalog models public read" on public.catalog_models;
create policy "catalog models public read" on public.catalog_models
  for select to anon, authenticated using (published or (select public.is_admin()));
drop policy if exists "catalog models admin insert" on public.catalog_models;
create policy "catalog models admin insert" on public.catalog_models
  for insert to authenticated with check ((select public.is_admin()));
drop policy if exists "catalog models admin update" on public.catalog_models;
create policy "catalog models admin update" on public.catalog_models
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "catalog models admin delete" on public.catalog_models;
create policy "catalog models admin delete" on public.catalog_models
  for delete to authenticated using ((select public.is_admin()));
revoke all on public.catalog_models from anon, authenticated;
grant select on public.catalog_models to anon;
grant select, insert, update, delete on public.catalog_models to authenticated;

-- ── 4. Colours ───────────────────────────────────────────────────────────────
create table if not exists public.catalog_colors (
  id         uuid primary key default gen_random_uuid(),
  model_id   uuid not null references public.catalog_models(id) on delete cascade,
  name_en    text not null,
  name_ar    text not null default '',
  hex        text,
  sort       integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_colors_name_size check (length(name_en) between 1 and 40 and length(name_ar) <= 40),
  constraint catalog_colors_hex_shape check (hex is null or hex ~ '^#[0-9a-fA-F]{6}$')
);
create index if not exists catalog_colors_model_sort on public.catalog_colors (model_id, sort);
drop trigger if exists catalog_colors_touch on public.catalog_colors;
create trigger catalog_colors_touch before update on public.catalog_colors
  for each row execute function public._catalog_touch();

alter table public.catalog_colors enable row level security;
drop policy if exists "catalog colors public read" on public.catalog_colors;
create policy "catalog colors public read" on public.catalog_colors
  for select to anon, authenticated
  using (exists (select 1 from public.catalog_models m where m.id = model_id and (m.published or (select public.is_admin()))));
drop policy if exists "catalog colors admin insert" on public.catalog_colors;
create policy "catalog colors admin insert" on public.catalog_colors
  for insert to authenticated with check ((select public.is_admin()));
drop policy if exists "catalog colors admin update" on public.catalog_colors;
create policy "catalog colors admin update" on public.catalog_colors
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "catalog colors admin delete" on public.catalog_colors;
create policy "catalog colors admin delete" on public.catalog_colors
  for delete to authenticated using ((select public.is_admin()));
revoke all on public.catalog_colors from anon, authenticated;
grant select on public.catalog_colors to anon;
grant select, insert, update, delete on public.catalog_colors to authenticated;

-- ── 5. Photos ────────────────────────────────────────────────────────────────
create table if not exists public.catalog_photos (
  id         uuid primary key default gen_random_uuid(),
  model_id   uuid not null references public.catalog_models(id) on delete cascade,
  color_id   uuid references public.catalog_colors(id) on delete set null,
  url        text not null,
  alt_en     text not null default '',
  alt_ar     text not null default '',
  sort       integer not null default 0,
  is_cover   boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_photos_url_shape check (length(url) <= 400 and url ~ '^(/media/[A-Za-z0-9_./-]+|https://[^[:space:]]+)$'),
  constraint catalog_photos_alt_size check (length(alt_en) <= 140 and length(alt_ar) <= 140)
);
create index if not exists catalog_photos_model_sort on public.catalog_photos (model_id, sort);

-- A photo's colour is one of its own model's colours.
create or replace function public._catalog_photo_check()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if new.color_id is not null and not exists (select 1 from public.catalog_colors c where c.id = new.color_id and c.model_id = new.model_id) then
    raise exception 'the colour is not one of this model''s' using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $function$;
revoke all on function public._catalog_photo_check() from public, anon, authenticated;
drop trigger if exists catalog_photo_check on public.catalog_photos;
create trigger catalog_photo_check before insert or update on public.catalog_photos
  for each row execute function public._catalog_photo_check();

alter table public.catalog_photos enable row level security;
drop policy if exists "catalog photos public read" on public.catalog_photos;
create policy "catalog photos public read" on public.catalog_photos
  for select to anon, authenticated
  using (exists (select 1 from public.catalog_models m where m.id = model_id and (m.published or (select public.is_admin()))));
drop policy if exists "catalog photos admin insert" on public.catalog_photos;
create policy "catalog photos admin insert" on public.catalog_photos
  for insert to authenticated with check ((select public.is_admin()));
drop policy if exists "catalog photos admin update" on public.catalog_photos;
create policy "catalog photos admin update" on public.catalog_photos
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists "catalog photos admin delete" on public.catalog_photos;
create policy "catalog photos admin delete" on public.catalog_photos
  for delete to authenticated using ((select public.is_admin()));
revoke all on public.catalog_photos from anon, authenticated;
grant select on public.catalog_photos to anon;
grant select, insert, update, delete on public.catalog_photos to authenticated;

-- ── 6. Spec sheets: the website bucket takes PDFs too, up to 10 MB ───────────
update storage.buckets
   set file_size_limit = 10485760,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'application/pdf']
 where id = 'site';

-- ── Starter rows ─────────────────────────────────────────────────────────────
-- The five rental bike types as categories (staff rename, reorder or add to them), and the
-- specifications a bike page usually lists. Nothing is overwritten: a row that exists stays.
insert into public.catalog_categories (slug, name_en, name_ar, sort)
select v.slug, v.name_en, v.name_ar, v.sort
  from (values
    ('road',     'Road',     'طريق',   1),
    ('mountain', 'Mountain', 'جبلية',  2),
    ('hybrid',   'Hybrid',   'هجينة',  3),
    ('gravel',   'Gravel',   'غرافل',  4),
    ('kids',     'Kids',     'أطفال',  5)
  ) as v(slug, name_en, name_ar, sort)
 where not exists (select 1 from public.catalog_categories c where c.parent_id is null and c.slug = v.slug);

insert into public.catalog_spec_fields (key, label_en, label_ar, group_en, group_ar, unit_en, unit_ar, sort)
values
  ('frame',     'Frame',     'الإطار',           'Frame',            'الهيكل',            '',   '',      10),
  ('fork',      'Fork',      'الشوكة',           'Frame',            'الهيكل',            '',   '',      20),
  ('sizes',     'Sizes',     'المقاسات',         'Frame',            'الهيكل',            '',   '',      30),
  ('weight',    'Weight',    'الوزن',            'Frame',            'الهيكل',            'kg', 'كجم',   40),
  ('groupset',  'Groupset',  'المجموعة',         'Drivetrain',       'نقل الحركة',        '',   '',      50),
  ('shifters',  'Shifters',  'مبدّلات السرعة',   'Drivetrain',       'نقل الحركة',        '',   '',      60),
  ('speeds',    'Speeds',    'السرعات',          'Drivetrain',       'نقل الحركة',        '',   '',      70),
  ('cassette',  'Cassette',  'الكاسيت',          'Drivetrain',       'نقل الحركة',        '',   '',      80),
  ('crankset',  'Crankset',  'الكرنك',           'Drivetrain',       'نقل الحركة',        '',   '',      90),
  ('brakes',    'Brakes',    'الفرامل',          'Wheels and brakes', 'العجلات والفرامل', '',   '',     100),
  ('wheels',    'Wheels',    'العجلات',          'Wheels and brakes', 'العجلات والفرامل', '',   '',     110),
  ('tyres',     'Tyres',     'الإطارات المطاطية', 'Wheels and brakes', 'العجلات والفرامل', '',   '',     120),
  ('handlebar', 'Handlebar', 'المقود',           'Contact points',   'نقاط التلامس',      '',   '',     130),
  ('saddle',    'Saddle',    'السرج',            'Contact points',   'نقاط التلامس',      '',   '',     140),
  ('motor',     'Motor',     'المحرك',           'Electric',         'الكهرباء',          '',   '',     150),
  ('battery',   'Battery',   'البطارية',         'Electric',         'الكهرباء',          'Wh', 'واط·س', 160),
  ('range',     'Range',     'المدى',            'Electric',         'الكهرباء',          'km', 'كم',    170)
on conflict (key) do nothing;

commit;
