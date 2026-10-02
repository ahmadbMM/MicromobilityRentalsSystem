-- ============================================================================
-- MicroMobility — NEW Supabase project setup (amyqxovbnlreassrqihr)
-- HISTORICAL (July 2026): written for the project that was production until 2026-10-02. The move to
-- qpffkzmsfyilicwcsszz copied the whole schema with its grants; do not run this on today's database.
-- Run this ENTIRE file once in the new project → SQL Editor → New query.
-- Idempotent: safe to re-run, safe whether or not supabase_schema.sql was
-- already applied.
--
-- WHY THIS FILE EXISTS: Supabase projects created after the 2025 platform
-- change no longer grant the anon/authenticated roles any access to the
-- `public` schema by default. supabase_schema.sql only creates tables and RLS
-- policies — it assumes the old default grants, so on this project every app
-- request fails with 42501 "permission denied for schema public".
-- Section F below is the actual fix; the rest guarantees the schema is the
-- complete, current column set the app uses.
-- ============================================================================


-- ── A. TABLES (full current column set) ──────────────────────────────────────

create table if not exists customers (
  id            text primary key,
  name          text not null,
  email         text,
  phone         text,
  password_hash text not null,
  created_at    text not null,
  height        integer,
  type_preference text,
  gender        text,
  birth_date    text,
  country       text,
  city          text,
  photo         text
);

create table if not exists bikes (
  id          text primary key,
  name        text not null,
  size        text not null,
  type        text not null,
  colors      jsonb not null default '[]',
  color_names jsonb not null default '[]',
  status      text not null default 'available',
  brand       text,
  model       text,
  groupset    text,
  speeds      integer,
  rental_price numeric,
  location    text,
  frame_type  text,
  bike_number integer,
  in_service_date text,
  retired_date    text,
  photo           text
);

create table if not exists sessions (
  id           text primary key,
  day          text not null,
  session_date text not null,
  capacity     integer not null default 12,
  status       text not null default 'closed',
  created_at   bigint not null,
  bike_slots   text,
  location     text,
  addons       text
);

create table if not exists queue_entries (
  id               text primary key,
  name             text not null,
  email            text,
  phone            text,
  size             text not null,
  type_preference  text not null,
  paid             boolean not null default false,
  price            numeric not null default 30,
  assigned_bike_id text references bikes(id),
  session_id       text not null,
  session_day      text not null,
  session_date     text not null,
  queue_num        integer not null,
  status           text not null default 'waiting',
  registered_at    text not null,
  walk_in          boolean not null default false,
  customer_id      text references customers(id),
  height           integer,
  ride_duration    integer,
  rating_bike      integer,
  rating_exp       integer,
  feedback         text,
  addons           text,
  promo_code       text,
  purchases        text,
  pay_method       text,
  card_amount      numeric,
  checked_in_at    text,
  checked_out_at   text
);

create table if not exists cashier_sales (
  id            text primary key,
  session_id    text,
  customer_name text,
  item_id       text,
  receipt_id    text,
  name          text not null,
  category      text,
  qty           integer not null default 1,
  price         numeric not null default 0,
  pay           text not null default 'paid',
  team_name     text,
  created_at    text,
  customer_id   text
);

create table if not exists promo_codes (
  id         text primary key,
  code       text not null,
  kind       text not null default 'percent',
  value      numeric not null default 0,
  active     boolean not null default true,
  created_at text
);

create table if not exists inventory (
  id            text primary key,
  name          text not null,
  brand         text,
  category      text not null default 'Other',
  qty           integer not null default 0,
  low_threshold integer not null default 0,
  price         numeric,
  updated_at    text,
  photo         text,
  flavour       text,
  volume_ml     integer,
  nutrition     text
);

create table if not exists error_log (
  id  bigint generated always as identity primary key,
  at  text,
  msg text,
  src text,
  ua  text
);

create table if not exists staff_actions (
  id      bigint generated always as identity primary key,
  at      text,
  action  text,
  who     text,
  device  text,
  view    text
);


-- ── B. COLUMN BACKFILL (covers a table created from an older schema copy) ────
-- Every backfillable column: a pre-existing table may be missing any of them.
-- (NOT NULL columns without defaults are omitted — they cannot be added to a
-- populated table and are all original v1 columns that always exist.)

alter table customers add column if not exists email text;
alter table customers add column if not exists phone text;
alter table customers add column if not exists height integer;
alter table customers add column if not exists type_preference text;
alter table customers add column if not exists gender text;
alter table customers add column if not exists birth_date text;
alter table customers add column if not exists country text;
alter table customers add column if not exists city text;
alter table customers add column if not exists photo text;

alter table bikes add column if not exists colors jsonb not null default '[]';
alter table bikes add column if not exists status text not null default 'available';
alter table bikes add column if not exists color_names jsonb not null default '[]';
alter table bikes add column if not exists brand text;
alter table bikes add column if not exists model text;
alter table bikes add column if not exists groupset text;
alter table bikes add column if not exists speeds integer;
alter table bikes add column if not exists rental_price numeric;
alter table bikes add column if not exists location text;
alter table bikes add column if not exists frame_type text;
alter table bikes add column if not exists bike_number integer;
alter table bikes add column if not exists in_service_date text;
alter table bikes add column if not exists retired_date text;
alter table bikes add column if not exists photo text;

alter table sessions add column if not exists capacity integer not null default 12;
alter table sessions add column if not exists status text not null default 'closed';
alter table sessions add column if not exists bike_slots text;
alter table sessions add column if not exists location text;
alter table sessions add column if not exists addons text;

alter table queue_entries add column if not exists email text;
alter table queue_entries add column if not exists phone text;
alter table queue_entries add column if not exists paid boolean not null default false;
alter table queue_entries add column if not exists price numeric not null default 30;
alter table queue_entries add column if not exists assigned_bike_id text references bikes(id);
alter table queue_entries add column if not exists status text not null default 'waiting';
alter table queue_entries add column if not exists walk_in boolean not null default false;
alter table queue_entries add column if not exists customer_id text references customers(id);
alter table queue_entries add column if not exists height integer;
alter table queue_entries add column if not exists ride_duration integer;
alter table queue_entries add column if not exists rating_bike integer;
alter table queue_entries add column if not exists rating_exp integer;
alter table queue_entries add column if not exists feedback text;
alter table queue_entries add column if not exists addons text;
alter table queue_entries add column if not exists promo_code text;
alter table queue_entries add column if not exists purchases text;
alter table queue_entries add column if not exists pay_method text;
alter table queue_entries add column if not exists card_amount numeric;
alter table queue_entries add column if not exists checked_in_at text;
alter table queue_entries add column if not exists checked_out_at text;

alter table cashier_sales add column if not exists session_id text;
alter table cashier_sales add column if not exists customer_name text;
alter table cashier_sales add column if not exists item_id text;
alter table cashier_sales add column if not exists receipt_id text;
alter table cashier_sales add column if not exists category text;
alter table cashier_sales add column if not exists qty integer not null default 1;
alter table cashier_sales add column if not exists price numeric not null default 0;
alter table cashier_sales add column if not exists pay text not null default 'paid';
alter table cashier_sales add column if not exists team_name text;
alter table cashier_sales add column if not exists created_at text;
alter table cashier_sales add column if not exists customer_id text;

alter table promo_codes add column if not exists code text;
alter table promo_codes add column if not exists kind text not null default 'percent';
alter table promo_codes add column if not exists value numeric not null default 0;
alter table promo_codes add column if not exists active boolean not null default true;
alter table promo_codes add column if not exists created_at text;

alter table inventory add column if not exists brand text;
alter table inventory add column if not exists category text not null default 'Other';
alter table inventory add column if not exists qty integer not null default 0;
alter table inventory add column if not exists low_threshold integer not null default 0;
alter table inventory add column if not exists updated_at text;
alter table inventory add column if not exists photo text;
alter table inventory add column if not exists price numeric;
alter table inventory add column if not exists flavour text;
alter table inventory add column if not exists volume_ml integer;
alter table inventory add column if not exists nutrition text;


-- ── C. UNIQUE INDEXES (old prod data verified duplicate-free on 2026-07-04) ──

create unique index if not exists bikes_bike_number_uniq
  on bikes (bike_number) where bike_number is not null;

create unique index if not exists queue_entries_session_qnum_uniq
  on queue_entries (session_id, queue_num)
  where status not in ('cancelled','removed','noshow');


-- ── D. ROW LEVEL SECURITY (same demo policies as current production; the
--       staged lockdown in SECURITY-RUNBOOK.md replaces these later) ─────────

alter table customers     enable row level security;
alter table bikes         enable row level security;
alter table sessions      enable row level security;
alter table queue_entries enable row level security;
alter table inventory     enable row level security;
alter table promo_codes   enable row level security;
alter table cashier_sales enable row level security;
alter table error_log     enable row level security;
alter table staff_actions enable row level security;

drop policy if exists "public access" on customers;
drop policy if exists "public access" on bikes;
drop policy if exists "public access" on sessions;
drop policy if exists "public access" on queue_entries;
drop policy if exists "public access" on inventory;
drop policy if exists "public access" on promo_codes;
drop policy if exists "public access" on cashier_sales;
drop policy if exists "error insert"  on error_log;
drop policy if exists "audit insert"  on staff_actions;
drop policy if exists "audit read"    on staff_actions;

create policy "public access" on customers     for all using (true) with check (true);
create policy "public access" on bikes         for all using (true) with check (true);
create policy "public access" on sessions      for all using (true) with check (true);
create policy "public access" on queue_entries for all using (true) with check (true);
create policy "public access" on inventory     for all using (true) with check (true);
create policy "public access" on promo_codes   for all using (true) with check (true);
create policy "public access" on cashier_sales for all using (true) with check (true);
create policy "error insert"  on error_log     for insert with check (true);
create policy "audit insert"  on staff_actions for insert with check (true);
create policy "audit read"    on staff_actions for select using (true);


-- ── E. GRANTS — the actual fix for 42501 "permission denied for schema public"
--       (2025+ projects no longer grant these by default) ────────────────────

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on all tables in schema public
  to anon, authenticated, service_role;

grant usage, select on all sequences in schema public
  to anon, authenticated, service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;

alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;


-- ── F. CLEANUP: remove the probe object left by the migration checker ───────
do $$
begin
  delete from storage.objects
   where bucket_id = 'photos' and name = '__sync_check__/probe.txt';
exception when others then
  raise notice 'storage cleanup skipped: %', sqlerrm;
end $$;
