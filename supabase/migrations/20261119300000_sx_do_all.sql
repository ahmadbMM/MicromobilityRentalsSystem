-- ============================================================================
-- The store and Experiences "do all" build (2026-11-18; the user, on the report "Store and Experiences mobile
-- design": "do all"): the database half of the six website builders' items in one file. Builder B8 assembled it from
-- the builders' fragments (SX/sql/B1.sql ... B6.sql of the build), merged what two of them asked for twice and fixed
-- what the review found (each fix is marked "B8" where it sits and listed below).
--
-- STAGING ONLY: the online store and payments exist on staging alone (production has no store tables). This file
-- stops unless 20261110150000 (payments), 20261115235500 (the store build), 20261119000800 (bh18 r2stg: the slot days
-- and the invoice's seller, which _store_order_json reads) and 20261119120000 (testimonials, which xp_kind_ratings
-- reads) are in the ledger. When the store goes live it goes to production after them.
--
-- Parts, in the order they run (each needs only what runs before it):
--  1. Settings (site_content, seeded, never overwritten; every new feature off or harmless): store.checkup (N12; B2
--     and B4 both asked for it with the same value: seeded once), store.company.on, store.pin.on, store.learning.on,
--     store.sessionHandover (off), store.handover (off), store.ramadan (off), store.quoteDays, store.giftCardWallet.on
--     (off) (B3), store.slotChange, store.push.on (off) (B4). The xp.* keys of B5 and B6 are not seeded: the website
--     and these functions read an absent key as off (xp.gifts, xp.guardianTick, xp.earlyBird, xp.bikeCredit) or as
--     their default (xp.kit, xp.general.*).
--  2. B3: table store_quotes (N23) and the store_orders columns company (N34), pin (N07), handover (N13),
--     handover_entry and handover_session (N15), learning (N17), quote_id (N23). They come first: part 7 (B4) reads
--     store_orders.handover.
--  3. B3: hours and minutes (_store_hm, _store_hm_text, _store_days_hi), Ramadan's season (N36: _store_ramadan reads
--     store.ramadan), _store_slots rebuilt (a window may run past midnight; the season's windows join with 'season'),
--     the 20-minute handover slots of "Collect fully built" (N13): store_handover_slots(p_day) and its helpers.
--  4. B8: a Jeddah slot is checked against Ramadan's season wherever it is written (trigger store_orders_slot_season).
--  5. B3: store_checkout_plus (N23 N34 N07 N13 N15 N17 N36), the quotes (store_quote_get, staff_store_quote_save,
--     staff_store_quotes, staff_store_quote_void), staff_store_session_handovers (N15), the order JSON's new parts
--     (_store_order_sx, _store_order_json rebuilt), store_gift_card_to_wallet (N20, switch off).
--  6. B2: store_products.fleet_bike_id + store_fleet_record (N25), store_rode_type (N16).
--  7. B4, after the sale: tables store_after_builds (N29), store_after_arrivals (N14, realtime), store_after_claims
--     (N31), store_after_push (N04), store_after_slot_changes (N30), store_return_requests.photos (N08); the private
--     bucket store-claims; the website's store_after_read, store_after_arrive, store_after_slot_change,
--     store_after_claim, store_after_return_photos, store_after_push; the Wallet signer's store_order_pass (N02); staff's
--     staff_store_after_order, staff_store_after_queue, staff_store_after_build, staff_store_after_build_clear,
--     staff_store_after_seen, staff_store_after_claim_set; the "Bike owner" badge (N18), its triggers and a backfill.
--  8. B6, Experiences: payment kind 'xp'; xp_packs (EF21) and xp_purchases (EF20 EF21) with xp_packs_list,
--     staff_xp_packs, staff_xp_pack_save, xp_gift_start, xp_pack_start, _xp_pay_follow (issues the GF-/PK- codes),
--     customer_xp_purchases, xp_gift_view, staff_xp_purchases; the bike credit (EF22, xp.bikeCredit, off) with
--     xp_bike_credits; the early bird (EF29, xp.earlyBird, off, and only with the discount licence) with
--     queue_entries.xp_early.
--  9. B5: xp_kind_ratings (EF35), an anonymous average per kind.
-- 10. B1: data only (P22): seven staging products' Arabic names, the model in Latin letters and the brand once; each
--     update names the slug AND the old text, so it changes nothing on a row staff already renamed.
--
-- Rebuilt from the text in this repo (never prosrc), each keeping SECURITY DEFINER and its search_path:
--   _store_slots()                            20261115235500_store_build.sql (no later file changes it)
--   _store_order_json(store_orders, boolean)  20261119000800_bh18_r2stg_staging.sql, unchanged but for its last line
--                                             (|| _store_order_sx(o, p_staff), B3); it keeps that file's mark
-- The payments kind check is rebuilt from the live constraint with 'xp' added (B6). store_checkout is called by
-- store_checkout_plus, never changed. Only B3 rebuilds an existing function; no two builders rebuild the same one.
--
-- Fixes from the review (B8):
--  a. store_quote_no_seq: no rights for anon or authenticated (the quote numbers move only in staff_store_quote_save).
--  b. Ramadan's season held only in store_checkout_plus: an order without B3's extras goes through store_checkout
--     alone, and a Change time (B4) took any window. Now a trigger checks every Jeddah slot written (STORE_SLOT) and
--     store_after_slot_change checks it first (STORE_AFTER_SLOT).
--  c. store_after_slot_change and store_order_pass read B3's handover column and call store_handover_slots directly
--     (B4 read them through to_jsonb and a dynamic call that turned any error into STORE_AFTER_SLOT, for a database
--     without B3's part; this file always has it). staff_store_after_queue also gives each arrival's handover.
--  d. xp_gift_view meters the visitor the website names (x-mm-visitor-ip, as the store's metered functions do), not the
--     website's own address, which every visitor shares.
--  e. GF-/PK- codes: eight letters from a 32-letter alphabet (40 random bits; was eight hex digits, 32 bits).
--  f. The bike credit (EF22): one customer's bike orders take turns (an advisory lock), so two paid at once never
--     credit the same ride fees twice; a credited bike order that is cancelled or refunded takes its credit back from
--     the wallet as far as the balance goes (never below zero), once.
--  g. The early bird (EF29): it read sessions.ride_kind, which is empty on circuit nights, so "jcc" never matched: the
--     kind is now _session_kind's (the app's names, as promo codes use); it never stacks on a code (gift, pack or
--     promo); a booking moved to another session keeps the share only while that session still earns it; a share a
--     client wrote into xp_early is never taken (only this trigger stamps it).
--
-- Fixes from the independent security review of 2026-11-18 (F1, marked "F1" where they sit):
--  H1. The bike credit (EF22) is no longer paid when the bike order is paid: it is held, and the hourly job
--      mm-xp-bike-credit (_xp_bike_credit_tick) pays it only once the order was delivered or collected, 15 Riyadh days
--      have passed (the return and exchange window), no return or exchange of a bike line is open, none was approved,
--      and the money given back stays clear of the bike lines; else it is voided. A paid credit is still taken back
--      when the order is later refunded (never below zero, once). Staff read only paid credits.
--  M1. store_quote_get refuses a token that cannot be one before the visitor's meter (the website now names the visitor).
--  M2. The store-claims bucket takes a photo only at a name the database handed the website's server for a delivered
--      order (store_after_photo_tickets, store_after_photo_slot, five minutes, once, 24 a day per order); the public key
--      alone stores nothing.
--  L1. A refund staff start on a gift (GF-) or pack (PK-) is refused (XP_CODE_IN_USE) while a booking still to come
--      carries its code, and ends the code at once; a part refund voids the code as a full one does.
--  L3. store_order_pass meters only misses, per visitor the Wallet signer names (x-mm-visitor-ip), so junk never locks
--      out a pass for an order's own key.
--  L5. The checks run inside the transaction, before the ledger row and the commit.
--  B9 (the staff Store builder): build photos (N29) live under store-builds/<random uuid>/ (the review's L6), which
--      staff_store_after_build now takes instead of the order number's folder, and staff (not only admins) may add
--      them there in the site bucket ("store builds staff add", insert only, that folder only).
--
-- Rollback idea: run 20261115235500's _store_slots and 20261119000800's _store_order_json again; drop the triggers
-- store_orders_slot_season, store_orders_bike_owner, store_order_items_bike_owner, trg_xp_pay_follow,
-- trg_xp_bike_credit, trg_enforce_booking_price_xp and trg_xp_refund_guard (on payment_refunds); unschedule the job
-- mm-xp-bike-credit; drop the functions this file adds; drop store_orders.quote_id, then the tables store_quotes,
-- store_after_builds, store_after_arrivals, store_after_claims, store_after_push, store_after_slot_changes,
-- store_after_photo_tickets, xp_bike_credits, xp_purchases, xp_packs; drop the new columns (store_orders company, pin,
-- handover, handover_entry, handover_session, learning; store_products.fleet_bike_id; store_return_requests.photos;
-- queue_entries.xp_early); put the payments kind check back without 'xp' (once no 'xp' payment is left); drop the
-- store-claims policies and "store builds staff add", empty and delete the bucket; update badges set retired = true where slug = 'bike_owner';
-- delete the settings keys of part 1; B1: the seven updates with the two names swapped.
--
-- Idempotent (create ... if not exists, create or replace, constraints and policies dropped and added again, seeds on
-- conflict do nothing). Tested on a throwaway local Postgres 17: stubs, the payments and store files, this file twice,
-- every builder's rule tests and the assembly's own (SX/pg-b8).
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $pre$
declare v text;
begin
  foreach v in array array['20261110150000', '20261115235500', '20261119000800', '20261119120000'] loop
    if not exists (select 1 from supabase_migrations.schema_migrations where version = v) then
      raise exception 'sx_do_all is for staging, after % (payments, the store and testimonials): that file is not in the ledger here', v;
    end if;
  end loop;
end $pre$;

-- ═══ 1. Settings ══════════════════════════════════════════════════════════════════════════════════
-- B2 + B4 store.checkup (N12: the free first check-up, on, 12 weeks; the buy box's key-fact row and the order page's
-- "Book your free check-up" read the same key). B3: store.company.on, store.pin.on, store.learning.on (on, harmless),
-- store.sessionHandover (off: staff must bring the things to the session), store.handover (off until staff set the
-- hours), store.ramadan (off, 1448's likely dates as an example), store.quoteDays (a quote link's days, 1-30),
-- store.giftCardWallet.on (off: the accountant). B4: store.slotChange (Change time until 24 h before, twice),
-- store.push.on (off).
insert into public.site_content (key, value) values
  ('store.checkup', '{"on":true,"weeks":12}'::jsonb),
  ('store.company.on', 'true'::jsonb),
  ('store.pin.on', 'true'::jsonb),
  ('store.learning.on', 'true'::jsonb),
  ('store.sessionHandover', '{"on":false,"days":21}'::jsonb),
  ('store.handover', '{"on":false,"minutes":20,"cap":1,"ahead":6,"skip":[5],"hours":[{"from":"16:00","to":"21:00"}]}'::jsonb),
  ('store.ramadan', '{"on":false,"from":"2027-02-08","to":"2027-03-09","times":[{"id":"r1","from":"21:00","to":"01:00"}],"hours":[{"from":"21:00","to":"01:00"}]}'::jsonb),
  ('store.quoteDays', '7'::jsonb),
  ('store.giftCardWallet.on', 'false'::jsonb),
  ('store.slotChange', '{"on":true,"hours":24,"max":2}'::jsonb),
  ('store.push.on', 'false'::jsonb)
on conflict (key) do nothing;

-- ═══ 2. Quotes and what an order keeps (B3: N23 N34 N07 N13 N15 N17) ══════════════════════════════
-- ── 2a. Quotes (N23) ───────────────────────────────────────────────────────────────────────────────
create sequence if not exists public.store_quote_no_seq;
create table if not exists public.store_quotes (
  id          uuid primary key default gen_random_uuid(),
  no          bigint not null unique default nextval('public.store_quote_no_seq'),   -- "Q-12" to staff
  token       text not null unique check (token ~ '^[a-z0-9]{24,40}$'),             -- the link's secret
  items       jsonb not null check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) between 1 and 20 and pg_column_size(items) < 4000),
  fulfil      text check (fulfil is null or fulfil in ('pickup', 'jeddah', 'ksa')),
  slot        jsonb check (slot is null or (jsonb_typeof(slot) = 'object' and pg_column_size(slot) < 200)),        -- jeddah {day, time}
  handover    jsonb check (handover is null or (jsonb_typeof(handover) = 'object' and pg_column_size(handover) < 200)),  -- pickup {day, at}
  name        text check (name is null or length(name) between 2 and 60),
  phone       text check (phone is null or phone ~ '^9665[0-9]{8}$'),
  staff_note  text check (staff_note is null or length(staff_note) <= 300),
  lang        text check (lang is null or lang ~ '^[a-z]{2}$'),
  status      text not null default 'open' check (status in ('open', 'void')),
  expires_at  timestamptz not null,
  order_id    uuid references public.store_orders (id) on delete set null,   -- the last order placed from it
  created_by  text check (created_by is null or length(created_by) <= 60),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter sequence public.store_quote_no_seq owned by public.store_quotes.no;
create index if not exists store_quotes_created on public.store_quotes (created_at desc);
alter table public.store_quotes enable row level security;
revoke all on public.store_quotes from anon, authenticated;
revoke all on sequence public.store_quote_no_seq from anon, authenticated;   -- B8 (a): numbers move only in the staff function
drop policy if exists "store quotes staff read" on public.store_quotes;
create policy "store quotes staff read" on public.store_quotes for select to authenticated using ((select is_staff()));
grant select on public.store_quotes to authenticated;

-- ── 2b. What an order keeps (N34 N07 N13 N15 N17 N23) ───────────────────────────────────────────────
alter table public.store_orders add column if not exists company jsonb;           -- N34 {name, vat, cr?, address: {building, street, district, city, postal}}
alter table public.store_orders add column if not exists pin jsonb;               -- N07 {lat, lng}
alter table public.store_orders add column if not exists handover jsonb;          -- N13 {day, at, to}
alter table public.store_orders add column if not exists handover_entry text;     -- N15 the rider's booking (queue_entries.id)
alter table public.store_orders add column if not exists handover_session text;   -- N15 its session (sessions.id)
alter table public.store_orders add column if not exists learning boolean not null default false;   -- N17
alter table public.store_orders add column if not exists quote_id uuid;           -- N23
alter table public.store_orders drop constraint if exists store_orders_company_check;
alter table public.store_orders add constraint store_orders_company_check
  check (company is null or (jsonb_typeof(company) = 'object' and pg_column_size(company) < 1200 and (company ->> 'vat') ~ '^3[0-9]{13}3$'));
alter table public.store_orders drop constraint if exists store_orders_pin_check;
alter table public.store_orders add constraint store_orders_pin_check
  check (pin is null or (jsonb_typeof(pin) = 'object' and jsonb_typeof(pin -> 'lat') = 'number' and jsonb_typeof(pin -> 'lng') = 'number'
                         and (pin ->> 'lat')::numeric between 21 and 22.4 and (pin ->> 'lng')::numeric between 38.8 and 39.8));
alter table public.store_orders drop constraint if exists store_orders_handover_check;
alter table public.store_orders add constraint store_orders_handover_check
  check (handover is null or (jsonb_typeof(handover) = 'object' and pg_column_size(handover) < 200));
alter table public.store_orders drop constraint if exists store_orders_handover_entry_check;
alter table public.store_orders add constraint store_orders_handover_entry_check
  check ((handover_entry is null or length(handover_entry) <= 80) and (handover_session is null or length(handover_session) <= 80));
alter table public.store_orders drop constraint if exists store_orders_quote_id_fkey;
alter table public.store_orders add constraint store_orders_quote_id_fkey foreign key (quote_id) references public.store_quotes (id) on delete set null;
create index if not exists store_orders_handover_slot on public.store_orders ((handover ->> 'day'), (handover ->> 'at')) where handover is not null;
create index if not exists store_orders_handover_session on public.store_orders (handover_session) where handover_session is not null;


-- ═══ 3. Hours, Ramadan's season and the handover slots (B3: N13 N36) ════════════════════════════
-- ── 3a. Hours and minutes (N13 N36) ────────────────────────────────────────────────────────────────
-- "HH:MM" as minutes from midnight, or null.
create or replace function public._store_hm(p text) returns int
language sql immutable set search_path = public as $$
  select case when p ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then substr(p, 1, 2)::int * 60 + substr(p, 4, 2)::int end
$$;
revoke execute on function public._store_hm(text) from public, anon, authenticated;

-- Minutes as "HH:MM" on the clock (1470 = 00:30 the next morning).
create or replace function public._store_hm_text(p int) returns text
language sql immutable set search_path = public as $$
  select lpad(((p / 60) % 24)::text, 2, '0') || ':' || lpad((p % 60)::text, 2, '0')
$$;
revoke execute on function public._store_hm_text(int) from public, anon, authenticated;

-- A way's "days" ("1-2", "3") as its last day, as the website's daysOf reads it; null for anything else.
create or replace function public._store_days_hi(p text) returns int
language plpgsql immutable set search_path = public as $$
declare m text[];
begin
  m := regexp_match(coalesce(p, ''), '^\s*([0-9]{1,2})\s*(?:[-–—]\s*([0-9]{1,2}))?\s*$');
  if m is null then return null; end if;
  if m[2] is not null and m[2]::int < m[1]::int then return null; end if;
  if coalesce(m[2], m[1])::int > 60 then return null; end if;
  return coalesce(m[2], m[1])::int;
end $$;
revoke execute on function public._store_days_hi(text) from public, anon, authenticated;

-- store.ramadan (N36) as the website's ramadanOf reads it, or null: on, a first and a last day (45 days at most), up to
-- four delivery windows {id, from, to} and four handover windows {from, to}; a window's end at or before its start runs
-- past midnight.
create or replace function public._store_ramadan() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o jsonb := _pay_setting('store.ramadan'); f date; t date; times jsonb; hours jsonb;
begin
  if jsonb_typeof(o) is distinct from 'object' or (o -> 'on') is distinct from 'true'::jsonb then return null; end if;
  begin
    f := case when (o ->> 'from') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (o ->> 'from')::date end;
    t := case when (o ->> 'to') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (o ->> 'to')::date end;
  exception when others then return null;
  end;
  if f is null or t is null or t < f or t - f > 45 then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', y.x ->> 'id', 'from', y.x ->> 'from', 'to', y.x ->> 'to') order by y.n), '[]'::jsonb) into times
    from (select x, n from jsonb_array_elements(case when jsonb_typeof(o -> 'times') = 'array' then o -> 'times' else '[]'::jsonb end) with ordinality a(x, n)
           where jsonb_typeof(x) = 'object' and coalesce(x ->> 'id', '') ~ '^[a-z0-9]{1,12}$'
             and _store_hm(x ->> 'from') is not null and _store_hm(x ->> 'to') is not null and (x ->> 'from') <> (x ->> 'to')
           order by n limit 4) y;
  select coalesce(jsonb_agg(jsonb_build_object('from', y.x ->> 'from', 'to', y.x ->> 'to') order by y.n), '[]'::jsonb) into hours
    from (select x, n from jsonb_array_elements(case when jsonb_typeof(o -> 'hours') = 'array' then o -> 'hours' else '[]'::jsonb end) with ordinality a(x, n)
           where jsonb_typeof(x) = 'object' and _store_hm(x ->> 'from') is not null and _store_hm(x ->> 'to') is not null and (x ->> 'from') <> (x ->> 'to')
           order by n limit 4) y;
  if jsonb_array_length(times) = 0 and jsonb_array_length(hours) = 0 then return null; end if;
  return jsonb_build_object('from', to_char(f, 'YYYY-MM-DD'), 'to', to_char(t, 'YYYY-MM-DD'), 'times', times, 'hours', hours);
end $$;
revoke execute on function public._store_ramadan() from public, anon, authenticated;

-- ── 3b. Scheduled Jeddah delivery with Ramadan's evenings (N36), rebuilt from 20261115235500 ────────────
-- Scheduled Jeddah delivery (store.slots, F78) as the website's deliverySlots reads it, or null while it is off: the
-- first four well-formed times (a window may now run past midnight: its end before its start), the weekdays staff skip,
-- ahead 1-14 (6), lead 0-7 (1). While store.ramadan is on, its windows join the usual ones (an id the usual ones use is
-- left out) with 'season' {from, to, ids}: on the season's days only its windows are offered, on the others only the
-- usual ones (store_checkout_plus checks that; the website's slotTimes offers them so) (build of 2026-11-18, B3, N36).
create or replace function public._store_slots() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o jsonb := _pay_setting('store.slots'); times jsonb; skip int[]; r jsonb; extra jsonb; outv jsonb;
begin
  if jsonb_typeof(o) is distinct from 'object' or (o -> 'on') is distinct from 'true'::jsonb then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', y.t ->> 'id', 'from', y.t ->> 'from', 'to', y.t ->> 'to') order by y.n), '[]'::jsonb)
    into times
    from (select t, n from jsonb_array_elements(case when jsonb_typeof(o -> 'times') = 'array' then o -> 'times' else '[]'::jsonb end) with ordinality x(t, n)
           where jsonb_typeof(t) = 'object' and jsonb_typeof(t -> 'id') = 'string' and (t ->> 'id') ~ '^[a-z0-9]{1,12}$'
             and jsonb_typeof(t -> 'from') = 'string' and (t ->> 'from') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
             and jsonb_typeof(t -> 'to') = 'string' and (t ->> 'to') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
             and (t ->> 'to') <> (t ->> 'from')   -- (B3, N36) was: to after from
           order by n limit 4) y;
  select coalesce(array_agg(distinct _store_jint(d, -1, 0, 6)) filter (where _store_jint(d, -1, 0, 6) >= 0), '{}'::int[]) into skip
    from jsonb_array_elements(case when jsonb_typeof(o -> 'skip') = 'array' then o -> 'skip' else '[]'::jsonb end) d;
  if jsonb_array_length(times) = 0 or cardinality(skip) >= 7 then return null; end if;
  outv := jsonb_build_object('on', true, 'ahead', _store_jint(o -> 'ahead', 6, 1, 14), 'lead', _store_jint(o -> 'lead', 1, 0, 7),
                             'skip', to_jsonb(skip), 'times', times);
  r := _store_ramadan();
  if r is not null then
    select coalesce(jsonb_agg(x), '[]'::jsonb) into extra from jsonb_array_elements(r -> 'times') x
     where not exists (select 1 from jsonb_array_elements(times) y where y ->> 'id' = x ->> 'id');
    if jsonb_array_length(extra) > 0 then
      outv := outv || jsonb_build_object('times', times || extra,
        'season', jsonb_build_object('from', r ->> 'from', 'to', r ->> 'to', 'ids', (select jsonb_agg(x ->> 'id') from jsonb_array_elements(extra) x)));
    end if;
  end if;
  return outv;
end $$;
revoke execute on function public._store_slots() from public, anon, authenticated;

-- ── 3c. Handover slots (N13) ───────────────────────────────────────────────────────────────────────
-- store.handover as the website reads it, or null while it is off: minutes 10-60 (20), cap 1-10 (1), ahead 1-14 (6),
-- skip (weekdays, 0 Sunday), up to four windows of hours {from, to} (past midnight when to <= from).
create or replace function public._store_handover_cfg() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o jsonb := _pay_setting('store.handover'); hours jsonb; skip int[];
begin
  if jsonb_typeof(o) is distinct from 'object' or (o -> 'on') is distinct from 'true'::jsonb then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('from', y.x ->> 'from', 'to', y.x ->> 'to') order by y.n), '[]'::jsonb) into hours
    from (select x, n from jsonb_array_elements(case when jsonb_typeof(o -> 'hours') = 'array' then o -> 'hours' else '[]'::jsonb end) with ordinality a(x, n)
           where jsonb_typeof(x) = 'object' and _store_hm(x ->> 'from') is not null and _store_hm(x ->> 'to') is not null and (x ->> 'from') <> (x ->> 'to')
           order by n limit 4) y;
  select coalesce(array_agg(distinct _store_jint(d, -1, 0, 6)) filter (where _store_jint(d, -1, 0, 6) >= 0), '{}'::int[]) into skip
    from jsonb_array_elements(case when jsonb_typeof(o -> 'skip') = 'array' then o -> 'skip' else '[]'::jsonb end) d;
  if jsonb_array_length(hours) = 0 or cardinality(skip) >= 7 then return null; end if;
  return jsonb_build_object('minutes', _store_jint(o -> 'minutes', 20, 10, 60), 'cap', _store_jint(o -> 'cap', 1, 1, 10),
                            'ahead', _store_jint(o -> 'ahead', 6, 1, 14), 'skip', to_jsonb(skip), 'hours', hours);
end $$;
revoke execute on function public._store_handover_cfg() from public, anon, authenticated;

-- A day's handover slots: each window cut into `minutes`, in order; m is the slot's start in minutes from that day's
-- midnight (past 1440 after midnight: an evening's slot belongs to the day its window starts). Ramadan's hours on its
-- days (N36).
create or replace function public._store_handover_grid(p_cfg jsonb, p_day date)
returns table (at_hm text, to_hm text, m int)
language plpgsql stable security definer set search_path = public as $$
declare r jsonb := _store_ramadan(); hours jsonb := p_cfg -> 'hours'; w jsonb; a int; b int; s int; len int := (p_cfg ->> 'minutes')::int;
begin
  if p_cfg is null or p_day is null then return; end if;
  if r is not null and jsonb_array_length(r -> 'hours') > 0 and p_day between (r ->> 'from')::date and (r ->> 'to')::date then
    hours := r -> 'hours';
  end if;
  for w in select x from jsonb_array_elements(hours) x loop
    a := _store_hm(w ->> 'from'); b := _store_hm(w ->> 'to');
    if a is null or b is null then continue; end if;
    if b <= a then b := b + 1440; end if;
    s := a;
    while s + len <= b loop
      at_hm := _store_hm_text(s); to_hm := _store_hm_text(s + len); m := s;
      return next;
      s := s + len;
    end loop;
  end loop;
end $$;
revoke execute on function public._store_handover_grid(jsonb, date) from public, anon, authenticated;

-- The days a handover can be booked for from p_today (Riyadh): from the day pickup is ready (the last of
-- store.delivery.pickup.days as working days, the website's readyDay; the next working day when it names none), `ahead`
-- days not skipped, a day counting only while one of its slots starts after p_nowm (minutes, the Riyadh clock).
create or replace function public._store_handover_days(p_cfg jsonb, p_today date, p_nowm int) returns date[]
language plpgsql stable security definer set search_path = public as $$
declare d date; outv date[] := '{}'; g int := 0;
        skip int[] := coalesce((select array_agg((x #>> '{}')::int) from jsonb_array_elements(p_cfg -> 'skip') x), '{}');
begin
  if p_cfg is null or p_today is null then return '{}'; end if;
  d := _store_working_day(p_today, coalesce(_store_days_hi(_pay_setting('store.delivery') #>> '{pickup,days}'), 1));
  while cardinality(outv) < (p_cfg ->> 'ahead')::int and g < 60 loop
    if not (extract(dow from d)::int = any(skip))
       and exists (select 1 from _store_handover_grid(p_cfg, d) x where d > p_today or x.m > coalesce(p_nowm, -1)) then
      outv := outv || d;
    end if;
    d := d + 1; g := g + 1;
  end loop;
  return outv;
end $$;
revoke execute on function public._store_handover_days(jsonb, date, int) from public, anon, authenticated;

-- Which handover slots are free (N13), for the buy box and checkout: {on: false} while off (or the store closed), else
-- {on: true, minutes, days: [{day, slots: [{at, to, open}]}]}; p_day limits it to that day. A slot is open while it
-- has not started and fewer orders than the cap (not cancelled or refunded) hold it. Nothing personal, no counts.
create or replace function public.store_handover_slots(p_day date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cfg jsonb := _store_handover_cfg(); today date := _pay_today(); nowm int := _store_hm(to_char(now() at time zone 'Asia/Riyadh', 'HH24:MI'));
        d date; days jsonb := '[]'::jsonb; slots jsonb;
begin
  if cfg is null or not _pay_on('pay.enabled') or not _pay_on('store.open') then return jsonb_build_object('on', false); end if;
  foreach d in array _store_handover_days(cfg, today, nowm) loop
    if p_day is not null and d <> p_day then continue; end if;
    select coalesce(jsonb_agg(jsonb_build_object('at', x.at_hm, 'to', x.to_hm, 'open',
             (d > today or x.m > nowm)
             and (select count(*) from store_orders o
                   where o.handover is not null and o.handover ->> 'day' = to_char(d, 'YYYY-MM-DD') and o.handover ->> 'at' = x.at_hm
                     and o.status not in ('cancelled', 'refunded')) < (cfg ->> 'cap')::int) order by x.m), '[]'::jsonb)
      into slots from _store_handover_grid(cfg, d) x;
    if jsonb_array_length(slots) > 0 then
      days := days || jsonb_build_array(jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'), 'slots', slots));
    end if;
  end loop;
  return jsonb_build_object('on', true, 'minutes', (cfg ->> 'minutes')::int, 'days', days);
end $$;
revoke execute on function public.store_handover_slots(date) from public;
grant execute on function public.store_handover_slots(date) to anon, authenticated;

-- ═══ 4. A Jeddah slot and Ramadan's season (B8) ═══════════════════════════════════════════════════
-- While store.ramadan is on, _store_slots() lists the season's windows beside the usual ones, and store_checkout takes
-- any window on that list. store_checkout_plus (part 5) checks which windows a day may take, but an order without B3's
-- extras is placed by store_checkout alone, and a Change time (part 7) wrote any window. So the rule sits on the table:
-- a Jeddah slot written is one of the season's windows on the season's days and a usual one on the other days
-- (STORE_SLOT). A slot already kept is never checked again (only a new or changed one), so staff changing the season
-- later never touches booked orders.
create or replace function public._store_slot_season_ok(p_slot jsonb) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare sl jsonb; d date;
begin
  if jsonb_typeof(p_slot) is distinct from 'object' then return true; end if;
  sl := _store_slots();
  if sl is null or not (sl ? 'season') then return true; end if;
  begin
    d := case when (p_slot ->> 'day') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (p_slot ->> 'day')::date end;
  exception when others then d := null;
  end;
  if d is null then return false; end if;
  return coalesce((sl #> '{season,ids}') ? (p_slot ->> 'time'), false)
         = (d between (sl #>> '{season,from}')::date and (sl #>> '{season,to}')::date);
end $$;
revoke execute on function public._store_slot_season_ok(jsonb) from public, anon, authenticated;

create or replace function public._store_slot_season_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.fulfil = 'jeddah' and new.slot is not null and (tg_op = 'INSERT' or new.slot is distinct from old.slot)
     and not _store_slot_season_ok(new.slot) then
    raise exception 'STORE_SLOT' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function public._store_slot_season_guard() from public, anon, authenticated;
drop trigger if exists store_orders_slot_season on public.store_orders;
create trigger store_orders_slot_season before insert or update of slot on public.store_orders
  for each row execute function public._store_slot_season_guard();

-- ═══ 5. Checkout with the extras, quotes, the order JSON, a gift card into the wallet (B3) ═══════════
-- ── 5a. Placing an order with these (N23 N34 N07 N13 N15 N17 N36) ───────────────────────────────────
-- The website's checkout (POST /api/store/checkout) calls this in place of store_checkout when the order carries any
-- of p_order's new keys, with the server key:
--   quote:    the quote's token (N23): open, not past its date, its order not paid; the order's lines must be the
--             quote's exactly (STORE_QUOTE, STORE_QUOTE_EXPIRED, STORE_QUOTE_USED, STORE_QUOTE_CHANGED)
--   company:  {name 2-100, vat ^3\d{13}3$, cr? 10 digits, address: {building 4 digits, street, district, city, postal 5
--             digits}} (N34, STORE_COMPANY) while store.company.on
--   pin:      {lat, lng} in and around Jeddah, a Jeddah delivery only (N07, STORE_PIN) while store.pin.on
--   handover: {day, at} a free slot of store_handover_slots, pickup with a bike (N13, STORE_HANDOVER)
--   session:  the account's own booking (queue_entries.id), seated ('active'), its day from the ready day to
--             store.sessionHandover.days on, pickup, small things only (ship_ksa, never a bike or a gift card)
--             (N15, STORE_SESSION); a session wins over a handover slot
--   learning: true with a bike (N17, STORE_LEARNING) while store.learning.on
-- and checks a Jeddah slot against Ramadan's season (N36, STORE_SLOT). store_checkout places the order first, as ever;
-- anything refused here undoes all of it (one transaction). Answers what store_checkout answers, the order's JSON with
-- these parts.
create or replace function public.store_checkout_plus(p_key text, p_id text, p_token text, p_order jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; o store_orders%rowtype; q store_quotes%rowtype; c jsonb; a jsonb; nm text; lat numeric; lng numeric;
        cfg jsonb; hday date; hat text; hto text; hm int; taken int; e queue_entries%rowtype; sh jsonb; ready date;
        bikes boolean; small boolean; qitems jsonb; oitems jsonb; sl jsonb; sday date;
        today date := _pay_today(); nowm int := _store_hm(to_char(now() at time zone 'Asia/Riyadh', 'HH24:MI'));
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;

  /* N23: a quote that cannot be used refuses before anything is held */
  if p_order ? 'quote' then
    select * into q from store_quotes where token = p_order ->> 'quote' for update;
    if q.id is null or q.status <> 'open' then raise exception 'STORE_QUOTE' using errcode = 'P0001'; end if;
    if q.order_id is not null and exists (select 1 from store_orders x where x.id = q.order_id and x.status not in ('pending', 'cancelled')) then
      raise exception 'STORE_QUOTE_USED' using errcode = 'P0001';
    end if;
    if q.expires_at <= now() then raise exception 'STORE_QUOTE_EXPIRED' using errcode = 'P0001'; end if;
    select coalesce(jsonb_agg(jsonb_build_object('variant', lower(x ->> 'variant'), 'qty', (x ->> 'qty')::int) order by lower(x ->> 'variant')), '[]'::jsonb)
      into qitems from jsonb_array_elements(q.items) x;
    select coalesce(jsonb_agg(jsonb_build_object('variant', lower(coalesce(x ->> 'variant', '')),
                                                 'qty', case when (x ->> 'qty') ~ '^[0-9]{1,2}$' then (x ->> 'qty')::int end) order by lower(coalesce(x ->> 'variant', ''))), '[]'::jsonb)
      into oitems from jsonb_array_elements(case when jsonb_typeof(p_order -> 'items') = 'array' then p_order -> 'items' else '[]'::jsonb end) x;
    if qitems is distinct from oitems then raise exception 'STORE_QUOTE_CHANGED' using errcode = 'P0001'; end if;
  end if;

  r := store_checkout(p_key, p_id, p_token, p_order);
  select * into o from store_orders where id = (r #>> '{order,id}')::uuid for update;
  bikes := exists (select 1 from store_order_items i join store_products p on p.id = i.product_id where i.order_id = o.id and p.category = 'bikes');
  small := not exists (select 1 from store_order_items i left join store_products p on p.id = i.product_id
                        where i.order_id = o.id and (p.id is null or not p.ship_ksa or p.category = 'bikes' or p.kind = 'gift_card'));

  /* N34 buying for a company: a standard tax invoice names the buyer, its VAT number and its address */
  if p_order ? 'company' then
    c := p_order -> 'company'; a := c -> 'address';
    nm := btrim(regexp_replace(coalesce(c ->> 'name', ''), '\s+', ' ', 'g'));
    if not _pay_on('store.company.on') or jsonb_typeof(c) is distinct from 'object' or jsonb_typeof(a) is distinct from 'object'
       or length(nm) not between 2 and 100
       or coalesce(c ->> 'vat', '') !~ '^3[0-9]{13}3$'
       or (nullif(c ->> 'cr', '') is not null and (c ->> 'cr') !~ '^[0-9]{10}$')
       or coalesce(a ->> 'building', '') !~ '^[0-9]{4}$'
       or length(btrim(coalesce(a ->> 'street', ''))) not between 1 and 80
       or length(btrim(coalesce(a ->> 'district', ''))) not between 1 and 60
       or length(btrim(coalesce(a ->> 'city', ''))) not between 1 and 40
       or coalesce(a ->> 'postal', '') !~ '^[0-9]{5}$' then
      raise exception 'STORE_COMPANY' using errcode = 'P0001';
    end if;
    update store_orders set company = jsonb_strip_nulls(jsonb_build_object('name', nm, 'vat', c ->> 'vat', 'cr', nullif(c ->> 'cr', ''),
             'address', jsonb_build_object('building', a ->> 'building', 'street', btrim(a ->> 'street'), 'district', btrim(a ->> 'district'),
                                           'city', btrim(a ->> 'city'), 'postal', a ->> 'postal')))
     where id = o.id;
  end if;

  /* N07 the Jeddah delivery's map pin, for the driver */
  if p_order ? 'pin' then
    begin
      lat := case when jsonb_typeof(p_order #> '{pin,lat}') = 'number' then (p_order #>> '{pin,lat}')::numeric end;
      lng := case when jsonb_typeof(p_order #> '{pin,lng}') = 'number' then (p_order #>> '{pin,lng}')::numeric end;
    exception when others then lat := null;
    end;
    if not _pay_on('store.pin.on') or o.fulfil <> 'jeddah' or lat is null or lng is null
       or lat not between 21 and 22.4 or lng not between 38.8 and 39.8 then
      raise exception 'STORE_PIN' using errcode = 'P0001';
    end if;
    update store_orders set pin = jsonb_build_object('lat', round(lat, 5), 'lng', round(lng, 5)) where id = o.id;
  end if;

  /* N15 handed over at one of the account's own seated bookings */
  if p_order ? 'session' then
    sh := _pay_setting('store.sessionHandover');
    if jsonb_typeof(sh) is distinct from 'object' or (sh -> 'on') is distinct from 'true'::jsonb or o.fulfil <> 'pickup' or p_id is null or not small then
      raise exception 'STORE_SESSION' using errcode = 'P0001';
    end if;
    ready := _store_working_day(today, coalesce(_store_days_hi(_pay_setting('store.delivery') #>> '{pickup,days}'), 1));
    select * into e from queue_entries where id = p_order ->> 'session' and customer_id = p_id;
    if e.id is null or e.status is distinct from 'active' or coalesce(e.session_date::text, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or e.session_date::text < to_char(ready, 'YYYY-MM-DD')
       or e.session_date::text > to_char(today + _store_jint(sh -> 'days', 21, 1, 60), 'YYYY-MM-DD') then
      raise exception 'STORE_SESSION' using errcode = 'P0001';
    end if;
    update store_orders set handover_entry = e.id, handover_session = e.session_id where id = o.id;
  /* N13 the handover slot of "Collect fully built", under a lock so two orders never take a slot's last place */
  elsif p_order ? 'handover' then
    cfg := _store_handover_cfg();
    if cfg is null or o.fulfil <> 'pickup' or not bikes then raise exception 'STORE_HANDOVER' using errcode = 'P0001'; end if;
    begin
      hday := case when (p_order #>> '{handover,day}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (p_order #>> '{handover,day}')::date end;
    exception when others then hday := null;
    end;
    hat := p_order #>> '{handover,at}';
    if hday is null or not (hday = any(_store_handover_days(cfg, today, nowm))) then raise exception 'STORE_HANDOVER' using errcode = 'P0001'; end if;
    select x.to_hm, x.m into hto, hm from _store_handover_grid(cfg, hday) x where x.at_hm = hat and (hday > today or x.m > nowm) limit 1;
    if hto is null then raise exception 'STORE_HANDOVER' using errcode = 'P0001'; end if;
    /* the day's lock, the one B4's change of time (N30) takes too, so the two never both take a slot's last place */
    perform pg_advisory_xact_lock(hashtext('store_handover:' || to_char(hday, 'YYYY-MM-DD')));
    select count(*) into taken from store_orders x
     where x.id <> o.id and x.handover is not null and x.handover ->> 'day' = to_char(hday, 'YYYY-MM-DD') and x.handover ->> 'at' = hat
       and x.status not in ('cancelled', 'refunded');
    if taken >= (cfg ->> 'cap')::int then raise exception 'STORE_HANDOVER: full' using errcode = 'P0001'; end if;
    update store_orders set handover = jsonb_build_object('day', to_char(hday, 'YYYY-MM-DD'), 'at', hat, 'to', hto) where id = o.id;
  end if;

  /* N17 still learning to ride, with a bike */
  if p_order -> 'learning' = 'true'::jsonb then
    if not _pay_on('store.learning.on') or not bikes then raise exception 'STORE_LEARNING' using errcode = 'P0001'; end if;
    update store_orders set learning = true where id = o.id;
  end if;

  /* N36 a Jeddah slot: Ramadan's windows on its days, the usual ones on the others (store_checkout took any) */
  if o.fulfil = 'jeddah' and o.slot is not null then
    sl := _store_slots();
    if sl ? 'season' then
      begin sday := (o.slot ->> 'day')::date; exception when others then sday := null; end;
      if sday is null or ((sl #> '{season,ids}') ? (o.slot ->> 'time'))
                         is distinct from (sday between (sl #>> '{season,from}')::date and (sl #>> '{season,to}')::date) then
        raise exception 'STORE_SLOT' using errcode = 'P0001';
      end if;
    end if;
  end if;

  /* N23 the quote is this order's now (it reads as used once the order is paid) */
  if q.id is not null then
    update store_quotes set order_id = o.id, updated_at = now() where id = q.id;
    update store_orders set quote_id = q.id where id = o.id;
  end if;

  select * into o from store_orders where id = o.id;
  return jsonb_set(r, '{order}', _store_order_json(o));
end $$;
revoke execute on function public.store_checkout_plus(text, text, text, jsonb) from public;
grant execute on function public.store_checkout_plus(text, text, text, jsonb) to anon, authenticated;

-- ── 5b. Quotes for the website and for staff (N23) ─────────────────────────────────────────────────
-- A quote as staff see it: its lines named and priced as the store is now (what checkout will charge), the way and its
-- slot, the contact staff wrote, its state (open / used / expired / void) and the order placed from it.
create or replace function public._store_quote_json(q store_quotes) returns jsonb
language sql stable security definer set search_path = public as $$
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
                         'label', nullif(concat_ws(' · ', nullif(v.size, ''), nullif(v.color_en, '')), ''),
                         'unit', coalesce(v.price, p.price), 'live', coalesce(v.active and p.published, false), 'stock', v.stock) order by n)
                       from jsonb_array_elements(q.items) with ordinality y(x, n)
                       left join store_variants v on v.id = (x ->> 'variant')::uuid
                       left join store_products p on p.id = v.product_id), '[]'::jsonb),
    'subtotal', coalesce((select sum(coalesce(v.price, p.price) * (x ->> 'qty')::int)
                            from jsonb_array_elements(q.items) x
                            join store_variants v on v.id = (x ->> 'variant')::uuid join store_products p on p.id = v.product_id), 0))
  from (select 1) one left join store_orders o on o.id = q.order_id
$$;
revoke execute on function public._store_quote_json(store_quotes) from public, anon, authenticated;

-- The website's /store/q/<token> (server key): {state, no, expires_at, items (open only), fulfil, slot, handover, name
-- and phone (open only), order_no (used only)}; NOT_FOUND for a token that names none. Metered per visitor: the website
-- names the visitor (x-mm-visitor-ip, F1: the page now sends it, as payRpc's `from` does), and a token that cannot be one
-- is refused before the meter, so junk never fills it (the review's M1).
create or replace function public.store_quote_get(p_key text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q store_quotes%rowtype; j jsonb; st text;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if coalesce(p_token, '') !~ '^[a-z0-9]{24,40}$' then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not _ip_gate('storequote' || _store_visitor(), 30, interval '10 minutes') then raise exception 'STORE_BUSY' using errcode = 'P0001'; end if;
  select * into q from store_quotes where token = p_token;
  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  j := _store_quote_json(q); st := j ->> 'state';
  return jsonb_build_object('state', st, 'no', q.no, 'expires_at', q.expires_at, 'fulfil', q.fulfil, 'slot', q.slot, 'handover', q.handover,
    'items', case when st = 'open' then q.items else '[]'::jsonb end,
    'name', case when st = 'open' then q.name end, 'phone', case when st = 'open' then q.phone end,
    'order_no', case when st = 'used' then (j -> 'order_no') end);
end $$;
revoke execute on function public.store_quote_get(text, text) from public;
grant execute on function public.store_quote_get(text, text) to anon, authenticated;

-- Staff build or change a quote: p_quote {id? (to change an open, unused one), items: [{variant, qty 1-10}] 1-20 lines of
-- live, published, in-stock choices (never a gift card), fulfil? pickup/jeddah/ksa, slot? {day, time} (jeddah),
-- handover? {day, at} (pickup), name?, phone?, staff_note?, lang?, days? 1-30 (store.quoteDays, 7)}. The slot is only
-- filled in for the customer: checkout checks it again. Answers the quote (_store_quote_json), its token for the link.
create or replace function public.staff_store_quote_save(p_quote jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
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
    if v.id is null or not v.active or pr.id is null or not pr.published or pr.kind = 'gift_card' or v.stock < qty then
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
end $$;
revoke execute on function public.staff_store_quote_save(jsonb) from public, anon;
grant execute on function public.staff_store_quote_save(jsonb) to authenticated;

-- The quotes, newest first (p_limit 1-500, 100).
create or replace function public.staff_store_quotes(p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(_store_quote_json(q) order by q.created_at desc)
                     from (select * from store_quotes order by created_at desc limit greatest(1, least(coalesce(p_limit, 100), 500))) q), '[]'::jsonb);
end $$;
revoke execute on function public.staff_store_quotes(int) from public, anon;
grant execute on function public.staff_store_quotes(int) to authenticated;

-- Withdraw a quote: its link then says it is no longer valid. A quote already used stays as it is (STORE_QUOTE_USED).
create or replace function public.staff_store_quote_void(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare q store_quotes%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into q from store_quotes where id = p_id for update;
  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if q.order_id is not null and exists (select 1 from store_orders x where x.id = q.order_id and x.status not in ('pending', 'cancelled')) then
    raise exception 'STORE_QUOTE_USED' using errcode = 'P0001';
  end if;
  update store_quotes set status = 'void', updated_at = now() where id = q.id returning * into q;
  return _store_quote_json(q);
end $$;
revoke execute on function public.staff_store_quote_void(uuid) from public, anon;
grant execute on function public.staff_store_quote_void(uuid) to authenticated;

-- ── 5c. Staff: the store orders to hand over at a session (N15) ────────────────────────────────────
-- For the booking app's check-in window of a session: each paid order to hand over there (not yet handed over), with
-- the booking it goes with, the buyer, and its lines. Staff mark it handed over with staff_store_order_set(id,
-- 'delivered') as for any pickup.
create or replace function public.staff_store_session_handovers(p_session text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'no', o.no, 'status', o.status, 'entry', o.handover_entry,
                     'name', o.name, 'phone', o.phone,
                     'items', (select coalesce(jsonb_agg(jsonb_build_object('name', i.name, 'variant', i.variant, 'qty', i.qty) order by i.id), '[]'::jsonb)
                                 from store_order_items i where i.order_id = o.id)) order by o.no)
                     from store_orders o
                    where o.handover_session = p_session and o.status in ('paid', 'preparing', 'ready')), '[]'::jsonb);
end $$;
revoke execute on function public.staff_store_session_handovers(text) from public, anon;
grant execute on function public.staff_store_session_handovers(text) to authenticated;

-- ── 5d. The order's JSON with these parts ─────────────────────────────────────────────────────────
-- What an order's page and the staff order sheet read of these: the company (the invoice prints it), the pin (staff
-- only: a customer reads only 'pinned'), the handover slot, the session's day (staff also the booking and session ids),
-- still learning, the quote's number.
create or replace function public._store_order_sx(o store_orders, p_staff boolean default false) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'company', o.company,
    'pin', case when p_staff then o.pin end,
    'pinned', o.pin is not null,
    'handover', o.handover,
    'session', case when o.handover_entry is not null then
                 jsonb_build_object('date', (select e.session_date::text from queue_entries e where e.id = o.handover_entry))
                 || case when p_staff then jsonb_build_object('entry', o.handover_entry, 'session', o.handover_session) else '{}'::jsonb end end,
    'learning', o.learning,
    'quote_no', (select q.no from store_quotes q where q.id = o.quote_id))
$$;
revoke execute on function public._store_order_sx(store_orders, boolean) from public, anon, authenticated;

-- Rebuilt from 20261119000800_bh18_r2stg_staging.sql (stg11-4), unchanged but for its last line, which adds
-- _store_order_sx (B3). If another builder also rebuilds this function, keep both added lines.
create or replace function public._store_order_json(o store_orders, p_staff boolean default false) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', o.id, 'no', o.no, 'status', o.status, 'fulfil', o.fulfil, 'name', o.name,
    'phone', case when p_staff then o.phone else '•••• ' || right(o.phone, 4) end,
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
    -- X08: each line's own photo and address, kept when it was sold (the product's now, for a line sold before that)
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'variant', i.variant, 'qty', i.qty,
                         'unit_price', i.unit_price, 'product_id', i.product_id, 'variant_id', i.variant_id,
                         'image', coalesce(i.image, sp.images[1]), 'slug', coalesce(i.slug, sp.slug), 'gift_card', i.gift_card,
                         'reviewed', exists (select 1 from store_reviews rv where rv.order_id = o.id and rv.product_id = i.product_id)) order by i.id)
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
$$;
revoke execute on function public._store_order_json(store_orders, boolean) from public, anon, authenticated;


-- ── 5e. A store gift card into the account's wallet (N20, switch store.giftCardWallet.on, OFF) ──────────
-- One gift card for the store and Experiences: the card's whole balance moves into the signed-in account's wallet, which
-- already pays Saturday rides, lessons and lockers on the payment page (and takes their refunds). The card's move is a
-- 'spend' with no order (by 'wallet'); the wallet's line an 'adjust' named "Gift card" with the card's first letters.
-- Waits on the accountant (a gift card's VAT is charged when it is spent): the switch stays off until then.
create or replace function public.store_gift_card_to_wallet(p_key text, p_id text, p_token text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g store_gift_cards%rowtype; who text; take numeric; v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g')); bal numeric;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _pay_on('store.giftCardWallet.on') then raise exception 'STORE_GIFT_WALLET: off' using errcode = 'P0001'; end if;
  if p_id is null or not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _ip_gate('storegiftw' || _store_visitor(), 10, interval '10 minutes') then raise exception 'STORE_BUSY' using errcode = 'P0001'; end if;
  select * into g from store_gift_cards where code = v_code for update;
  if g.id is null or g.status <> 'active' or g.balance <= 0 then raise exception 'STORE_GIFT' using errcode = 'P0001'; end if;
  if g.expires_at <= now() then raise exception 'STORE_GIFT_EXPIRED' using errcode = 'P0001'; end if;
  take := g.balance;
  who := _wallet_owner(p_id);
  update store_gift_cards set balance = 0 where id = g.id;
  insert into store_gift_card_moves (card_id, order_id, amount, kind, by_name) values (g.id, null, -take, 'spend', 'wallet');
  perform set_config('mm.wallet_op', 'Gift card', true);
  perform set_config('mm.wallet_note', 'Gift card ' || left(g.code, 7) || '…', true);
  bal := _wallet_post(who, take, 'adjust', null, null, null, null, null);
  perform set_config('mm.wallet_op', '', true);
  perform set_config('mm.wallet_note', '', true);
  return jsonb_build_object('amount', take, 'balance', bal);
end $$;
revoke execute on function public.store_gift_card_to_wallet(text, text, text, text) from public;
grant execute on function public.store_gift_card_to_wallet(text, text, text, text) to anon, authenticated;


-- ═══ 6. The product page: an ex-rental bike's record, the rider's own rides on the type (B2: N25 N16) ═════
-- ── 6a. N25: the fleet bike an ex-rental product was ─────────────────────────────────────────────
alter table public.store_products add column if not exists fleet_bike_id text references public.bikes(id) on delete set null;
alter table public.store_products drop constraint if exists store_products_fleet_bike_check;
alter table public.store_products add constraint store_products_fleet_bike_check
  check (fleet_bike_id is null or (length(fleet_bike_id) <= 80 and condition = 'certified'));
comment on column public.store_products.fleet_bike_id is
  'N25 (2026-11-18): the fleet bike a certified pre-owned product was; its rides and months show on the product page (store_fleet_record).';
create index if not exists store_products_fleet_bike_idx on public.store_products (fleet_bike_id) where fleet_bike_id is not null;

create or replace function public.store_fleet_record(p_product uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_bike text;
  v_from date;
  v_to date;
  v_rides int;
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
begin
  if p_product is null then return null; end if;
  select sp.fleet_bike_id into v_bike
    from store_products sp
   where sp.id = p_product and sp.published and sp.condition = 'certified' and sp.fleet_bike_id is not null;
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
end $function$;
revoke execute on function public.store_fleet_record(uuid) from public;
grant execute on function public.store_fleet_record(uuid) to anon, authenticated;

-- ── 6b. N16: the signed-in rider's own Saturday rides on this bike's type ───────────────────────
create or replace function public.store_rode_type(p_id text, p_token text, p_product uuid)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_type text;
  v_n int;
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
begin
  if p_id is null or p_token is null or p_product is null or length(p_id) > 80 or length(p_token) > 200 then return null; end if;
  if not _cust_token_ok(p_id, p_token) then return null; end if;
  select cm.ride_type into v_type
    from store_products sp join catalog_models cm on cm.id = sp.catalog_model
   where sp.id = p_product and sp.published and sp.category = 'bikes';
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
end $function$;
revoke execute on function public.store_rode_type(text, text, uuid) from public;
grant execute on function public.store_rode_type(text, text, uuid) to anon, authenticated;


-- ═══ 7. After the sale (B4: N02 N04 N08 N14 N18 N29 N30 N31) ════════════════════════════════════════
-- ── 7a. Tables ─────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.store_after_builds (
  order_id  uuid primary key references public.store_orders (id) on delete cascade,
  photos    text[] not null default '{}' check (cardinality(photos) <= 3 and length(array_to_string(photos, '|')) <= 1200),
  checks    jsonb not null default '{}'::jsonb check (jsonb_typeof(checks) = 'object' and pg_column_size(checks) < 400),
  note      text check (note is null or length(note) <= 200),
  by_name   text check (by_name is null or length(by_name) <= 60),
  at        timestamptz not null default now()
);

create table if not exists public.store_after_arrivals (
  order_id  uuid primary key references public.store_orders (id) on delete cascade,
  at        timestamptz not null default now(),
  car       text check (car is null or length(car) <= 30),
  touched   timestamptz not null default now(),          -- the last tap (the car changed), metered
  seen_at   timestamptz,
  seen_by   text check (seen_by is null or length(seen_by) <= 60)
);
create index if not exists store_after_arrivals_at on public.store_after_arrivals (at desc);

create table if not exists public.store_after_claims (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references public.store_orders (id) on delete cascade,
  item_id     bigint not null references public.store_order_items (id) on delete cascade,
  body        text not null check (length(body) between 10 and 600),
  photos      text[] not null default '{}' check (cardinality(photos) <= 3),
  state       text not null default 'open' check (state in ('open', 'in_progress', 'resolved', 'refused')),
  reply       text check (reply is null or length(reply) <= 300),          -- shown to the customer
  staff_note  text check (staff_note is null or length(staff_note) <= 500), -- staff only
  decided_by  text check (decided_by is null or length(decided_by) <= 60),
  decided_at  timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists store_after_claims_open on public.store_after_claims (item_id) where state in ('open', 'in_progress');
create index if not exists store_after_claims_order on public.store_after_claims (order_id, created_at);
create index if not exists store_after_claims_list on public.store_after_claims (state, created_at desc);

create table if not exists public.store_after_push (
  order_id     uuid primary key references public.store_orders (id) on delete cascade,
  customer_id  text not null check (length(customer_id) <= 80),
  at           timestamptz not null default now()
);

create table if not exists public.store_after_slot_changes (
  id        bigserial primary key,
  order_id  uuid not null references public.store_orders (id) on delete cascade,
  old_slot  jsonb check (old_slot is null or pg_column_size(old_slot) < 400),
  new_slot  jsonb not null check (pg_column_size(new_slot) < 400),
  at        timestamptz not null default now()
);
create index if not exists store_after_slot_changes_order on public.store_after_slot_changes (order_id, id);

-- F1 (the review's M2): one photo's upload into store-claims, named by the database for a delivered order the website
-- read with its key (store_after_photo_slot): the object's name, five minutes to use it, used once. The bucket's insert
-- policy takes only a name that has one (_store_after_photo_take), so the public key alone stores nothing.
create table if not exists public.store_after_photo_tickets (
  name        text primary key check (name ~ '^o[0-9]{1,9}/[0-9a-f]{32}\.jpg$'),
  order_id    uuid not null references public.store_orders (id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists store_after_photo_tickets_order on public.store_after_photo_tickets (order_id, created_at);
create index if not exists store_after_photo_tickets_old on public.store_after_photo_tickets (expires_at);

alter table public.store_return_requests add column if not exists photos text[] not null default '{}';
alter table public.store_return_requests drop constraint if exists store_return_requests_photos_check;
alter table public.store_return_requests add constraint store_return_requests_photos_check check (cardinality(photos) <= 3);

do $rls$
declare t text;
begin
  foreach t in array array['store_after_builds', 'store_after_arrivals', 'store_after_claims', 'store_after_push', 'store_after_slot_changes',
                           'store_after_photo_tickets'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('drop policy if exists "staff read" on public.%I', t);
    execute format('create policy "staff read" on public.%I for select to authenticated using ((select is_staff()))', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $rls$;
revoke all on sequence public.store_after_slot_changes_id_seq from anon, authenticated;

-- staff see an arrival the moment it is made (the staff Store screen subscribes; RLS above decides who reads it)
do $rt$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'store_after_arrivals') then
    execute 'alter publication supabase_realtime add table public.store_after_arrivals';
  end if;
end $rt$;

-- ── 7b. Storage: claim and return photos ───────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('store-claims', 'store-claims', false, 716800, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- F1 (the review's M2): the public key may add a photo only at a name the database handed the website's server for a
-- delivered order (store_after_photo_slot), unexpired and not used yet; the check marks it used. Each name holds one
-- file (no update policy, never an overwrite), so a ticket stores one photo at most even where Storage tests the policy
-- in a transaction it rolls back. Executable by the API roles because a policy runs as the uploader; it answers false for
-- any other bucket or name, and a name it takes is 128 random bits.
create or replace function public._store_after_photo_take(p_bucket text, p_name text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
begin
  if p_bucket is distinct from 'store-claims' or coalesce(p_name, '') !~ '^o[0-9]{1,9}/[0-9a-f]{32}\.jpg$' then return false; end if;
  update store_after_photo_tickets set used_at = now() where name = p_name and used_at is null and expires_at > now();
  return found;
end $$;
revoke execute on function public._store_after_photo_take(text, text) from public;
grant execute on function public._store_after_photo_take(text, text) to anon, authenticated;

drop policy if exists "store claims add" on storage.objects;
create policy "store claims add" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'store-claims' and name ~ '^o[0-9]{1,9}/[0-9a-f]{32}\.jpg$' and public._store_after_photo_take(bucket_id, name));
drop policy if exists "store claims staff read" on storage.objects;
create policy "store claims staff read" on storage.objects
  for select to authenticated
  using (bucket_id = 'store-claims' and (select public.is_staff()));
drop policy if exists "store claims admin remove" on storage.objects;
create policy "store claims admin remove" on storage.objects
  for delete to authenticated
  using (bucket_id = 'store-claims' and (select public.is_admin()));

-- F1 (B9, the staff Store builder): build photos (N29) go to the public site bucket at store-builds/<random uuid>/
-- (the review's L6: never under the order number, which runs in sequence), and that bucket takes inserts from admins
-- only (20260924150000 "site photos upload"), so a cashier or manager preparing a bike could not add them. Staff may
-- add there and only there: a uuid folder, one safe file name, jpg/png/webp (the bucket's own size and type limits
-- still apply). Insert only: replacing, removing and listing stay admins'. Nothing for anon.
drop policy if exists "store builds staff add" on storage.objects;
create policy "store builds staff add" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'site'
              and name ~ '^store-builds/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(jpg|png|webp)$'
              and (select public.is_staff()));

-- ── 7c. Helpers ────────────────────────────────────────────────────────────────────────────────────

-- The order a website call names, by its number and its own key; NOT_FOUND otherwise. p_lock takes it for update.
create or replace function public._store_after_order(p_no bigint, p_track text, p_lock boolean default false) returns public.store_orders
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype;
begin
  if coalesce(p_track, '') !~ '^[0-9a-f]{32}$' then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_lock then select * into o from store_orders where no = p_no and track_key = p_track for update;
  else select * into o from store_orders where no = p_no and track_key = p_track; end if;
  if o.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return o;
end $$;
revoke execute on function public._store_after_order(bigint, text, boolean) from public, anon, authenticated;

-- What the order's page shows after the sale (the website's afterOf reads it): the build, the arrival, the claims
-- (never the staff note), whether its status is pushed, how often its slot was changed.
create or replace function public._store_after_json(o public.store_orders) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'build', (select jsonb_build_object('at', b.at, 'photos', to_jsonb(b.photos), 'checks', b.checks, 'note', b.note)
                from store_after_builds b where b.order_id = o.id),
    'arrival', (select jsonb_build_object('at', a.at, 'car', a.car, 'seen', a.seen_at is not null)
                  from store_after_arrivals a where a.order_id = o.id),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'item_id', c.item_id, 'state', c.state, 'created_at', c.created_at,
                                                            'photos', cardinality(c.photos), 'reply', c.reply) order by c.created_at)
                          from store_after_claims c where c.order_id = o.id), '[]'::jsonb),
    'push', exists (select 1 from store_after_push p where p.order_id = o.id),
    'changes', (select count(*) from store_after_slot_changes s where s.order_id = o.id))
$$;
revoke execute on function public._store_after_json(public.store_orders) from public, anon, authenticated;

-- Photos a customer sent, as the website stored them: in this order's own folder of store-claims, three at most.
create or replace function public._store_after_photos(p_no bigint, p_photos text[]) returns text[]
language plpgsql immutable set search_path = public as $$
begin
  if p_photos is null then return '{}'; end if;
  if cardinality(p_photos) > 3 or exists (select 1 from unnest(p_photos) x where x is null or x !~ ('^o' || p_no || '/[0-9a-f]{32}\.jpg$')) then
    raise exception 'STORE_AFTER_PHOTOS' using errcode = 'P0001';
  end if;
  return (select coalesce(array_agg(distinct x), '{}') from unnest(p_photos) x);
end $$;
revoke execute on function public._store_after_photos(bigint, text[]) from public, anon, authenticated;

-- The staffer's name, as the store's staff functions write it.
create or replace function public._store_after_staffer() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()), 'Staff')
$$;
revoke execute on function public._store_after_staffer() from public, anon, authenticated;

-- ── 7d. The website's functions (server key) ───────────────────────────────────────────────────────

-- The order's after-the-sale parts, beside store_order_get; null for no such order (as store_order_get answers).
create or replace function public.store_after_read(p_key text, p_no bigint, p_track text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o store_orders%rowtype;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into o from store_orders where no = p_no and track_key = p_track;
  if o.id is null then return null; end if;
  return _store_after_json(o);
end $$;
revoke execute on function public.store_after_read(text, bigint, text) from public;
grant execute on function public.store_after_read(text, bigint, text) to anon, authenticated;

-- "I'm here" (N14): a pickup order that is ready. The first tap keeps its time; another tap only changes the car,
-- at most every 20 seconds. Staff see it (realtime on store_after_arrivals) and in the order's history (staff only).
create or replace function public.store_after_arrive(p_key text, p_no bigint, p_track text, p_car text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; v_car text := nullif(btrim(regexp_replace(coalesce(p_car, ''), '\s+', ' ', 'g')), ''); a store_after_arrivals%rowtype;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  o := _store_after_order(p_no, p_track, true);
  if o.fulfil <> 'pickup' or o.status <> 'ready' then raise exception 'STORE_AFTER_STATE' using errcode = 'P0001'; end if;
  if v_car is not null and (length(v_car) > 30 or v_car ~ '[<>"''`{}\[\]\\;$&|=%#*^~/]' or v_car ~ '[[:cntrl:]]') then
    raise exception 'STORE_AFTER_CAR' using errcode = 'P0001';
  end if;
  select * into a from store_after_arrivals where order_id = o.id for update;
  if a.order_id is null then
    insert into store_after_arrivals (order_id, car) values (o.id, v_car);
    insert into store_order_events (order_id, status, note, public, by_name) values (o.id, 'arrived', v_car, false, 'Customer');
  else
    if a.touched > now() - interval '20 seconds' then raise exception 'STORE_AFTER_BUSY' using errcode = 'P0001'; end if;
    update store_after_arrivals set car = v_car, touched = now() where order_id = o.id;
  end if;
  return _store_after_json(o);
end $$;
revoke execute on function public.store_after_arrive(text, bigint, text, text) from public;
grant execute on function public.store_after_arrive(text, bigint, text, text) to anon, authenticated;

-- Change time (N30): the booked Jeddah delivery window (F78, store_orders.slot {day, time, from, to}) or pickup handover
-- (N13, builder B3: store_orders.handover {day, at, to}) moves to another day and window the store offers now, until
-- store.slotChange.hours before the booked one starts and store.slotChange.max times. A delivery's choice is checked
-- exactly as store_checkout checks it (20261119000800 stg11-3); a handover's against B3's store_handover_slots(p_day)
-- (the slot must be offered and open), under a lock on the day (pg_advisory_xact_lock(hashtext('store_handover:' ||
-- day)); B3's checkout should take the same lock so two last places are never both given). Each keeps any other key
-- stored with it. Staff see the change in the order's history (a staff-only event) and in store_after_slot_changes.
-- B8 (b, c): B3's handover column and store_handover_slots are read directly (part 2 and 3 run first; B4's fragment read
-- them through to_jsonb and a dynamic call that turned any error into STORE_AFTER_SLOT), and a Jeddah window is checked
-- against Ramadan's season as checkout checks it (part 4) before it is written.
create or replace function public.store_after_slot_change(p_key text, p_no bigint, p_track text, p_day date, p_time text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o store_orders%rowtype; s jsonb := _pay_setting('store.slotChange'); hrs int; mx int; starts timestamptz; sl jsonb; t jsonb;
  nowhm text := to_char(now() at time zone 'Asia/Riyadh', 'HH24:MI'); hs jsonb; cur jsonb; cur_day text; cur_from text; nw jsonb;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  o := _store_after_order(p_no, p_track, true);
  cur := case o.fulfil when 'jeddah' then o.slot when 'pickup' then o.handover end;
  cur_day := cur ->> 'day';
  cur_from := case o.fulfil when 'pickup' then cur ->> 'at' else cur ->> 'from' end;
  if (s -> 'on') = 'false'::jsonb or o.status not in ('paid', 'preparing', 'ready') or jsonb_typeof(cur) is distinct from 'object'
     or coalesce(cur_day, '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(cur_from, '') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
    raise exception 'STORE_AFTER_STATE' using errcode = 'P0001';
  end if;
  hrs := _store_jint(s -> 'hours', 24, 1, 168);
  mx := _store_jint(s -> 'max', 2, 1, 5);
  starts := (cur_day::date + cur_from::time) at time zone 'Asia/Riyadh';
  if starts - now() <= make_interval(hours => hrs) then raise exception 'STORE_AFTER_CUTOFF' using errcode = 'P0001'; end if;
  if (select count(*) from store_after_slot_changes c where c.order_id = o.id) >= mx then
    raise exception 'STORE_AFTER_SLOT_MAX' using errcode = 'P0001';
  end if;
  if p_day is null or coalesce(p_time, '') !~ '^[A-Za-z0-9:_-]{1,16}$' then raise exception 'STORE_AFTER_SLOT' using errcode = 'P0001'; end if;

  if o.fulfil = 'jeddah' then
    sl := _store_slots();
    if sl is null or not (p_day = any(_store_slot_days(sl, _pay_today(), nowhm))) then raise exception 'STORE_AFTER_SLOT' using errcode = 'P0001'; end if;
    select x into t from jsonb_array_elements(sl -> 'times') x
     where x ->> 'id' = p_time and (p_day > _pay_today() or (x ->> 'from') collate "C" > nowhm collate "C") limit 1;
    if t is null then raise exception 'STORE_AFTER_SLOT' using errcode = 'P0001'; end if;
    nw := cur || jsonb_build_object('day', to_char(p_day, 'YYYY-MM-DD'), 'time', t ->> 'id', 'from', t ->> 'from', 'to', t ->> 'to');
    if nw = cur then return _store_after_json(o); end if;
    if not _store_slot_season_ok(nw) then raise exception 'STORE_AFTER_SLOT' using errcode = 'P0001'; end if;   -- B8 (b)
    update store_orders set slot = nw, updated_at = now() where id = o.id returning * into o;
  else
    perform pg_advisory_xact_lock(hashtext('store_handover:' || to_char(p_day, 'YYYY-MM-DD')));
    -- B3's reader: {on, minutes, days: [{day, slots: [{at, to, open}]}]}; open = not started and below the cap. Read
    -- after the day's lock, in a statement of its own, so it counts every order a checkout holding the lock committed.
    hs := store_handover_slots(p_day);
    if (hs -> 'on') is distinct from 'true'::jsonb then raise exception 'STORE_AFTER_SLOT' using errcode = 'P0001'; end if;
    select x into t
      from jsonb_array_elements(case when jsonb_typeof(hs -> 'days') = 'array' then hs -> 'days' else '[]'::jsonb end) d,
           jsonb_array_elements(case when jsonb_typeof(d -> 'slots') = 'array' then d -> 'slots' else '[]'::jsonb end) x
     where d ->> 'day' = to_char(p_day, 'YYYY-MM-DD') and x ->> 'at' = p_time and coalesce(x ->> 'to', '') ~ '^([01]\d|2[0-3]):[0-5]\d$' limit 1;
    if t is null then raise exception 'STORE_AFTER_SLOT' using errcode = 'P0001'; end if;
    nw := cur || jsonb_build_object('day', to_char(p_day, 'YYYY-MM-DD'), 'at', t ->> 'at', 'to', t ->> 'to');
    if nw = cur then return _store_after_json(o); end if;
    if (t -> 'open') is distinct from 'true'::jsonb then raise exception 'STORE_AFTER_SLOT_FULL' using errcode = 'P0001'; end if;
    update store_orders set handover = nw, updated_at = now() where id = o.id returning * into o;
  end if;

  insert into store_after_slot_changes (order_id, old_slot, new_slot) values (o.id, cur, nw);
  insert into store_order_events (order_id, status, note, public, by_name)
  values (o.id, 'slot_changed', (nw ->> 'day') || ' ' || coalesce(nw ->> 'from', nw ->> 'at') || '-' || (nw ->> 'to'), false, 'Customer');
  return _store_after_json(o);
end $$;
revoke execute on function public.store_after_slot_change(text, bigint, text, date, text) from public;
grant execute on function public.store_after_slot_change(text, bigint, text, date, text) to anon, authenticated;

-- F1 (the review's M2): a name to store one claim or return photo at, for a delivered order read with its key (the
-- website's /api/store/claim-photo asks for it after checking the JPEG, then uploads to it at once): {path, expires_at},
-- path o<no>/<32 hex>.jpg, good for five minutes, once. 24 a day per order at most (a claim takes 3 photos, five claims a
-- day; a return 3). NOT_AUTHORIZED, NOT_FOUND, STORE_AFTER_STATE (not delivered, or a gift card order), STORE_AFTER_BUSY.
create or replace function public.store_after_photo_slot(p_key text, p_no bigint, p_track text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; v_name text; v_exp timestamptz := now() + interval '5 minutes';
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  o := _store_after_order(p_no, p_track, true);
  if o.status <> 'delivered' or o.fulfil = 'digital' then raise exception 'STORE_AFTER_STATE' using errcode = 'P0001'; end if;
  delete from store_after_photo_tickets where expires_at < now() - interval '2 days';
  if (select count(*) from store_after_photo_tickets t where t.order_id = o.id and t.created_at > now() - interval '1 day') >= 24 then
    raise exception 'STORE_AFTER_BUSY' using errcode = 'P0001';
  end if;
  v_name := 'o' || o.no || '/' || replace(gen_random_uuid()::text, '-', '') || '.jpg';
  insert into store_after_photo_tickets (name, order_id, expires_at) values (v_name, o.id, v_exp);
  return jsonb_build_object('path', v_name, 'expires_at', v_exp);
end $$;
revoke execute on function public.store_after_photo_slot(text, bigint, text) from public;
grant execute on function public.store_after_photo_slot(text, bigint, text) to anon, authenticated;

-- A warranty claim from an order line (N31): a handed-over order's own line, not a gift card, within its warranty
-- (the product's own months when longer than the law's: 24 new, 12 certified pre-owned; counted from the day it was
-- delivered or collected), 10-600 characters, up to three photos from the order's folder, no claim open on the line,
-- five claims a day per order at most. Staff take it from their queue (staff_store_after_queue).
create or replace function public.store_after_claim(p_key text, p_no bigint, p_track text, p_item bigint, p_text text, p_photos text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o store_orders%rowtype; i store_order_items%rowtype; sp store_products%rowtype; v_body text := btrim(coalesce(p_text, ''));
  handed date; months int; ph text[];
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  o := _store_after_order(p_no, p_track, true);
  if o.status <> 'delivered' or o.fulfil = 'digital' then raise exception 'STORE_AFTER_STATE' using errcode = 'P0001'; end if;
  select * into i from store_order_items where id = p_item and order_id = o.id;
  if i.id is null or coalesce(i.gift_card, false) then raise exception 'STORE_AFTER_CLAIM' using errcode = 'P0001'; end if;
  select (e.at at time zone 'Asia/Riyadh')::date into handed
    from store_order_events e where e.order_id = o.id and e.status = 'delivered' order by e.id limit 1;
  if handed is null then raise exception 'STORE_AFTER_STATE' using errcode = 'P0001'; end if;
  select * into sp from store_products where id = i.product_id;
  months := greatest(case when sp.condition = 'certified' then 12 else 24 end, coalesce(sp.warranty_months, 0));
  if _pay_today() > (handed + make_interval(months => months))::date then raise exception 'STORE_AFTER_WARRANTY' using errcode = 'P0001'; end if;
  if length(v_body) < 10 or length(v_body) > 600 then raise exception 'STORE_AFTER_TEXT' using errcode = 'P0001'; end if;
  ph := _store_after_photos(o.no, p_photos);
  if exists (select 1 from store_after_claims c where c.item_id = i.id and c.state in ('open', 'in_progress')) then
    raise exception 'STORE_AFTER_CLAIM_OPEN' using errcode = 'P0001';
  end if;
  if (select count(*) from store_after_claims c where c.order_id = o.id and c.created_at > now() - interval '1 day') >= 5 then
    raise exception 'STORE_AFTER_BUSY' using errcode = 'P0001';
  end if;
  insert into store_after_claims (order_id, item_id, body, photos) values (o.id, i.id, v_body, ph);
  insert into store_order_events (order_id, status, note, public, by_name) values (o.id, 'claim', left(i.name, 120), false, 'Customer');
  return _store_after_json(o);
end $$;
revoke execute on function public.store_after_claim(text, bigint, text, bigint, text, text[]) from public;
grant execute on function public.store_after_claim(text, bigint, text, bigint, text, text[]) to anon, authenticated;

-- Photos on the order's open return or exchange request (N08), right after store_return_request made it: three in all.
create or replace function public.store_after_return_photos(p_key text, p_no bigint, p_track text, p_photos text[]) returns boolean
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; r store_return_requests%rowtype; ph text[];
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  o := _store_after_order(p_no, p_track, false);
  ph := _store_after_photos(o.no, p_photos);
  select * into r from store_return_requests where order_id = o.id and status = 'open' order by created_at desc limit 1 for update;
  if r.id is null then raise exception 'STORE_AFTER_STATE' using errcode = 'P0001'; end if;
  update store_return_requests
     set photos = (select coalesce(array_agg(d.x order by d.n), '{}')
                     from (select u.x, min(u.n) n from unnest(r.photos || ph) with ordinality u(x, n) group by u.x order by min(u.n) limit 3) d)
   where id = r.id;
  return true;
end $$;
revoke execute on function public.store_after_return_photos(text, bigint, text, text[]) from public;
grant execute on function public.store_after_return_photos(text, bigint, text, text[]) to anon, authenticated;

-- Notifications for this order's status (N04), while staff have store.push.on on: the account that placed it, checked
-- with its token, turns them on or off. The browser itself is subscribed through customer_push_subscribe (as before).
create or replace function public.store_after_push(p_key text, p_no bigint, p_track text, p_on boolean, p_id text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _pay_on('store.push.on') then raise exception 'STORE_AFTER_PUSH' using errcode = 'P0001'; end if;
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  o := _store_after_order(p_no, p_track, false);
  if o.customer_id is distinct from p_id then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if coalesce(p_on, false) then
    insert into store_after_push (order_id, customer_id) values (o.id, p_id) on conflict (order_id) do update set customer_id = excluded.customer_id, at = now();
  else
    delete from store_after_push where order_id = o.id;
  end if;
  return _store_after_json(o);
end $$;
revoke execute on function public.store_after_push(text, bigint, text, boolean, text, text) from public;
grant execute on function public.store_after_push(text, bigint, text, boolean, text, text) to anon, authenticated;

-- ── 7e. The pickup pass's fields, for the booking app's Wallet signer ──────────────────────────────
-- The booking app's /api/wallet-pass and /api/google-wallet ({storeOrder: {no, key, lang}}) have the public key only:
-- the order's own key is the right to read it, exactly as the order's link is. Only what the pass prints: the number,
-- whether it is live and ready, the first name, the handover (day, from, to), up to six lines (name, variant, qty), the
-- counter code (MMO-<no>-<first six of the key>: the staff scanner opens the order with it), the order page's path and
-- the showroom's address from the site's settings. F1 (the review's L3): only misses are metered, per visitor the signer
-- names (x-mm-visitor-ip: its caller's CF-Connecting-IP; 120 misses in 10 minutes), so junk numbers and keys never
-- lock out a pass for an order's own key: a right key is answered whatever the meter says. The header is not the
-- server key's word here (the signer has the public key only); a caller who changes it only gets more misses against
-- a 128-bit key.
create or replace function public.store_order_pass(p_no bigint, p_track text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; addr jsonb := _pay_setting('site.contact.address');
begin
  if coalesce(p_track, '') ~ '^[0-9a-f]{32}$' then
    select * into o from store_orders where no = p_no and track_key = p_track;
  end if;
  if o.id is null then
    if not _ip_gate('storepass' || _store_visitor(), 120, interval '10 minutes') then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if o.fulfil <> 'pickup' then return jsonb_build_object('ok', false, 'error', 'not_pickup'); end if;
  return jsonb_build_object('ok', true, 'pass', jsonb_build_object(
    'no', o.no, 'status', o.status, 'live', o.status in ('paid', 'preparing', 'ready'), 'ready', o.status = 'ready',
    'name', split_part(btrim(o.name), ' ', 1),
    -- the handover booked (N13, B3's store_orders.handover {day, at, to}; B8 (c): the column itself, part 2 adds it)
    'slot', case when o.handover ? 'day'
                 then jsonb_build_object('day', o.handover ->> 'day', 'from', o.handover ->> 'at', 'to', o.handover ->> 'to') end,
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'variant', i.variant, 'qty', i.qty) order by i.id)
                         from (select * from store_order_items where order_id = o.id and not coalesce(gift_card, false) order by id limit 6) i), '[]'::jsonb),
    'code', 'MMO-' || o.no || '-' || left(o.track_key, 6),
    'path', '/store/order/' || o.no || '?k=' || o.track_key,
    'showroom', case jsonb_typeof(addr) when 'object' then addr when 'string' then jsonb_build_object('en', addr #>> '{}') end,
    'updated_at', o.updated_at));
end $$;
revoke execute on function public.store_order_pass(bigint, text) from public;
grant execute on function public.store_order_pass(bigint, text) to anon, authenticated;

-- ── 7f. Staff ──────────────────────────────────────────────────────────────────────────────────────

-- The order sheet's after-the-sale part: the build, the arrival (with who saw it), every claim with its photos'
-- paths and staff note, the return requests' photos, the slot changes, and where to push its status (the account and
-- the order page's path with its key) when the customer turned notifications on.
create or replace function public.staff_store_after_order(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o store_orders%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into o from store_orders where id = p_order;
  if o.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return _store_after_json(o) || jsonb_build_object(
    'arrival', (select jsonb_build_object('at', a.at, 'car', a.car, 'seen_at', a.seen_at, 'seen_by', a.seen_by) from store_after_arrivals a where a.order_id = o.id),
    'build', (select jsonb_build_object('at', b.at, 'photos', to_jsonb(b.photos), 'checks', b.checks, 'note', b.note, 'by', b.by_name) from store_after_builds b where b.order_id = o.id),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'item_id', c.item_id, 'item', i.name, 'state', c.state, 'body', c.body,
                                                            'photos', to_jsonb(c.photos), 'reply', c.reply, 'staff_note', c.staff_note,
                                                            'decided_by', c.decided_by, 'decided_at', c.decided_at, 'created_at', c.created_at) order by c.created_at)
                          from store_after_claims c left join store_order_items i on i.id = c.item_id where c.order_id = o.id), '[]'::jsonb),
    'return_photos', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'photos', to_jsonb(r.photos)) order by r.created_at)
                                 from store_return_requests r where r.order_id = o.id and cardinality(r.photos) > 0), '[]'::jsonb),
    'slot_changes', coalesce((select jsonb_agg(jsonb_build_object('old', s.old_slot, 'new', s.new_slot, 'at', s.at) order by s.id)
                                from store_after_slot_changes s where s.order_id = o.id), '[]'::jsonb),
    'push_to', (select jsonb_build_object('customer_id', p.customer_id, 'url', '/store/order/' || o.no || '?k=' || o.track_key)
                  from store_after_push p where p.order_id = o.id));
end $$;
revoke execute on function public.staff_store_after_order(uuid) from public, anon;
grant execute on function public.staff_store_after_order(uuid) to authenticated;

-- The queues: today's arrivals at the showroom (pickup orders ready, newest first, unseen first) and the warranty
-- claims still open or in progress (oldest first), each with its order's number and name. B8 (c): an arrival also
-- carries its handover slot (a pickup's time is there; 'slot' is a Jeddah delivery's and stays for the contract).
create or replace function public.staff_store_after_queue() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return jsonb_build_object(
    'arrivals', coalesce((select jsonb_agg(jsonb_build_object('order_id', o.id, 'no', o.no, 'name', o.name, 'at', a.at, 'car', a.car,
                                                              'seen_at', a.seen_at, 'seen_by', a.seen_by, 'slot', o.slot,
                                                              'handover', o.handover)
                                           order by (a.seen_at is not null), a.at desc)
                            from store_after_arrivals a join store_orders o on o.id = a.order_id
                           where o.status = 'ready' and a.at > now() - interval '18 hours'), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'order_id', o.id, 'no', o.no, 'name', o.name, 'item', i.name,
                                                            'variant', i.variant, 'state', c.state, 'body', c.body, 'photos', to_jsonb(c.photos),
                                                            'created_at', c.created_at) order by c.created_at)
                          from store_after_claims c join store_orders o on o.id = c.order_id left join store_order_items i on i.id = c.item_id
                         where c.state in ('open', 'in_progress')), '[]'::jsonb));
end $$;
revoke execute on function public.staff_store_after_queue() from public, anon;
grant execute on function public.staff_store_after_queue() to authenticated;

-- "Your bike is built" (N29): 1-3 photos the staff page shrank and stored in the site bucket at
-- store-builds/<random uuid>/<stamp>.<jpg|png|webp> (F1, B9: one unguessable folder per order's build, the review's L6;
-- the catalogue's _catUploadImage, which also writes the .w640 copy), and the check sheet {brakes, gears, torque, tyres: true|false}. Saving it again
-- replaces it. The customer sees it on the order's page at once (not on a pending, cancelled or refunded order).
create or replace function public.staff_store_after_build(p_order uuid, p_photos text[], p_checks jsonb, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; ph text[] := coalesce(p_photos, '{}'); ck jsonb := '{}'::jsonb; k text; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into o from store_orders where id = p_order for update;
  if o.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status not in ('paid', 'preparing', 'ready', 'shipped', 'out', 'delivered') then raise exception 'STORE_AFTER_STATE' using errcode = 'P0001'; end if;
  /* F1 (B9, the review's L6): store-builds/<random uuid>/<file>, never the order number's folder */
  if cardinality(ph) > 3 or exists (select 1 from unnest(ph) x where x is null
        or x !~ '^/media/store-builds/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(jpg|png|webp)$') then
    raise exception 'STORE_AFTER_PHOTOS' using errcode = 'P0001';
  end if;
  foreach k in array array['brakes', 'gears', 'torque', 'tyres'] loop
    ck := ck || jsonb_build_object(k, coalesce(p_checks -> k = 'true'::jsonb, false));
  end loop;
  if v_note is not null and length(v_note) > 200 then raise exception 'STORE_AFTER_TEXT' using errcode = 'P0001'; end if;
  insert into store_after_builds (order_id, photos, checks, note, by_name, at) values (o.id, ph, ck, v_note, _store_after_staffer(), now())
  on conflict (order_id) do update set photos = excluded.photos, checks = excluded.checks, note = excluded.note, by_name = excluded.by_name, at = now();
  insert into store_order_events (order_id, status, note, public, by_name) values (o.id, 'built', null, false, _store_after_staffer());
  return staff_store_after_order(o.id);
end $$;
revoke execute on function public.staff_store_after_build(uuid, text[], jsonb, text) from public, anon;
grant execute on function public.staff_store_after_build(uuid, text[], jsonb, text) to authenticated;

create or replace function public.staff_store_after_build_clear(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  delete from store_after_builds where order_id = p_order;
  return staff_store_after_order(p_order);
end $$;
revoke execute on function public.staff_store_after_build_clear(uuid) from public, anon;
grant execute on function public.staff_store_after_build_clear(uuid) to authenticated;

-- A staffer saw the arrival and is bringing the bike out: the customer's page says so.
create or replace function public.staff_store_after_seen(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  update store_after_arrivals set seen_at = coalesce(seen_at, now()), seen_by = coalesce(seen_by, _store_after_staffer()) where order_id = p_order;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return staff_store_after_order(p_order);
end $$;
revoke execute on function public.staff_store_after_seen(uuid) from public, anon;
grant execute on function public.staff_store_after_seen(uuid) to authenticated;

-- A claim moves: in progress, resolved or refused, with a reply the customer reads on the order's page (300) and a
-- staff note (500). A refusal needs a reply. The refund or replacement itself goes the existing ways (Payments, a
-- return or exchange).
create or replace function public.staff_store_after_claim_set(p_id uuid, p_state text, p_reply text default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c store_after_claims%rowtype; v_reply text := nullif(btrim(coalesce(p_reply, '')), ''); v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_state not in ('in_progress', 'resolved', 'refused') then raise exception 'STORE_AFTER_STATE' using errcode = 'P0001'; end if;
  select * into c from store_after_claims where id = p_id for update;
  if c.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if (v_reply is not null and length(v_reply) > 300) or (v_note is not null and length(v_note) > 500) or (p_state = 'refused' and v_reply is null and c.reply is null) then
    raise exception 'STORE_AFTER_TEXT' using errcode = 'P0001';
  end if;
  update store_after_claims
     set state = p_state, reply = coalesce(v_reply, c.reply), staff_note = coalesce(v_note, c.staff_note),
         decided_by = case when p_state in ('resolved', 'refused') then _store_after_staffer() else decided_by end,
         decided_at = case when p_state in ('resolved', 'refused') then now() else decided_at end
   where id = c.id;
  insert into store_order_events (order_id, status, note, public, by_name) values (c.order_id, 'claim_' || p_state, null, false, _store_after_staffer());
  return staff_store_after_order(c.order_id);
end $$;
revoke execute on function public.staff_store_after_claim_set(uuid, text, text, text) from public, anon;
grant execute on function public.staff_store_after_claim_set(uuid, text, text, text) to authenticated;

-- ── 7g. The "Bike owner" badge (N18) ───────────────────────────────────────────────────────────────
-- Granted when an order with a bike line (a product in the bikes category) is paid by an account; never taken back
-- (a refund does not unmake the purchase). held_only: nobody but its holder sees it, greyed or not. The apps draw the
-- existing "bike" glyph in teal.
insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort, held_only)
values ('bd_bike_owner', 'bike_owner', 'bike', 'teal', 'Bike owner', 'مالك دراجة', 'Bought a bike from the MicroMobility store',
        'اشتريت دراجة من متجر MicroMobility', true, true, 95, true)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true, retired = false, held_only = true;

-- The order's account gets the badge when the order is paid and has a bike line (idempotent: asked again at every
-- later move). Called on the order's payment or status move and on each line added (an order paid whole from the
-- wallet is inserted paid before its lines are).
create or replace function public._store_after_grant_bike(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; b text;
begin
  select * into o from store_orders where id = p_order;
  if o.id is null or o.customer_id is null or o.paid_at is null or o.status in ('pending', 'cancelled') then return; end if;
  if not exists (select 1 from store_order_items i join store_products p on p.id = i.product_id
                  where i.order_id = o.id and p.category = 'bikes' and not coalesce(i.gift_card, false)) then return; end if;
  select id into b from badges where slug = 'bike_owner' and not retired;
  if b is null or not exists (select 1 from customers c where c.id = o.customer_id) then return; end if;
  insert into customer_badges (customer_id, badge_id, note, awarded_by) values (o.customer_id, b, 'MM-' || o.no, 'store')
  on conflict (customer_id, badge_id) do nothing;
end $$;
revoke execute on function public._store_after_grant_bike(uuid) from public, anon, authenticated;

create or replace function public._store_after_bike_owner() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform _store_after_grant_bike((to_jsonb(new) ->> case when tg_table_name = 'store_order_items' then 'order_id' else 'id' end)::uuid);
  return null;
end $$;
revoke all on function public._store_after_bike_owner() from public, anon, authenticated;
drop trigger if exists store_orders_bike_owner on public.store_orders;
create trigger store_orders_bike_owner after insert or update of paid_at, status on public.store_orders
  for each row execute function public._store_after_bike_owner();
drop trigger if exists store_order_items_bike_owner on public.store_order_items;
create trigger store_order_items_bike_owner after insert on public.store_order_items
  for each row execute function public._store_after_bike_owner();

-- the accounts that already paid for a bike
insert into public.customer_badges (customer_id, badge_id, note, awarded_by)
select distinct on (o.customer_id) o.customer_id, 'bd_bike_owner', 'MM-' || o.no, 'store'
  from public.store_orders o
  join public.customers c on c.id = o.customer_id
 where o.paid_at is not null and o.status not in ('pending', 'cancelled')
   and exists (select 1 from public.store_order_items i join public.store_products p on p.id = i.product_id
                where i.order_id = o.id and p.category = 'bikes' and not coalesce(i.gift_card, false))
 order by o.customer_id, o.paid_at
on conflict (customer_id, badge_id) do nothing;


-- ═══ 8. Experiences: gifts, packs, the bike credit, the early bird (B6: EF20 EF21 EF22 EF29) ═════════
-- ── 8a. Payment kind 'xp' ────────────────────────────────────────────────────────────────────────────
do $kind$
declare c record; ks text[];
begin
  for c in select conname, pg_get_constraintdef(oid) def from pg_constraint
            where conrelid = 'public.payments'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ '\mkind\M'
              and pg_get_constraintdef(oid) ~ '''booking''' loop
    if c.def ~ '''xp''' then continue; end if;
    select array_agg(distinct m[1]) into ks from regexp_matches(c.def, '''([a-z_]+)''', 'g') m;
    execute format('alter table public.payments drop constraint %I', c.conname);
    execute format('alter table public.payments add constraint %I check (kind in (%s))', c.conname,
                   (select string_agg(quote_literal(k), ', ' order by k) from unnest(ks || array['xp']) k));
  end loop;
end $kind$;

-- ── 8b. Packs staff sell (EF21) ──────────────────────────────────────────────────────────────────────
create table if not exists public.xp_packs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('jcc', 'saturday', 'swim', 'workshop', 'snd96', 'event', 'yoga')),
  title_en    text not null check (length(btrim(title_en)) between 1 and 80),
  title_ar    text check (title_ar is null or length(title_ar) <= 80),
  lessons     int not null check (lessons between 2 and 20),
  price       numeric(10,2) not null check (price >= 1 and price <= 20000),
  bike_type   text check (bike_type is null or (length(bike_type) between 1 and 30 and bike_type <> 'Any')),
  months      int not null default 6 check (months between 1 and 24),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  text check (created_by is null or length(created_by) <= 80)
);
alter table public.xp_packs enable row level security;
revoke all on public.xp_packs from anon, authenticated;
drop policy if exists "xp_packs staff read" on public.xp_packs;
create policy "xp_packs staff read" on public.xp_packs for select to authenticated using ((select is_staff()));
grant select on public.xp_packs to authenticated;

-- ── 8c. What riders bought (EF20, EF21) ──────────────────────────────────────────────────────────────
create table if not exists public.xp_purchases (
  id           uuid primary key default gen_random_uuid(),
  what         text not null check (what in ('gift', 'pack')),
  customer_id  text not null check (length(customer_id) between 1 and 64),
  kind         text not null check (length(kind) between 2 and 20),
  bike_type    text check (bike_type is null or (length(bike_type) between 1 and 30 and bike_type <> 'Any')),
  pack_id      uuid references public.xp_packs (id) on delete set null,
  lessons      int not null default 1 check (lessons between 1 and 20),
  amount       numeric(10,2) not null check (amount >= 1 and amount <= 20000),
  for_name     text check (for_name is null or length(for_name) <= 40),
  note         text check (note is null or length(note) <= 200),
  status       text not null default 'unpaid' check (status in ('unpaid', 'paid', 'void')),
  code         text unique check (code is null or code ~ '^(GF|PK)-[A-Z0-9]{8}$'),
  payment_id   uuid,
  expires_on   date,
  created_at   timestamptz not null default now(),
  paid_at      timestamptz
);
create index if not exists xp_purchases_customer on public.xp_purchases (customer_id, created_at desc);
create index if not exists xp_purchases_payment on public.xp_purchases (payment_id);
alter table public.xp_purchases enable row level security;
revoke all on public.xp_purchases from anon, authenticated;
drop policy if exists "xp_purchases staff read" on public.xp_purchases;
create policy "xp_purchases staff read" on public.xp_purchases for select to authenticated using ((select is_staff()));
grant select on public.xp_purchases to authenticated;

-- A new code no promo code holds yet: GF- or PK- and eight capitals or digits. B8 (e): each of the eight is one of 32
-- letters and digits (no I, O, 0, 1), from a fully random byte of gen_random_uuid (bytes 0-5 and 9-10: never the
-- version or variant bits), so a code holds 40 random bits (eight hex digits held 32); a code is a ride's money.
create or replace function public._xp_code(p_prefix text) returns text
language plpgsql volatile security definer set search_path = public as $$
declare c text; b bytea; i int; a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  loop
    b := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    c := p_prefix || '-';
    foreach i in array array[0, 1, 2, 3, 4, 5, 9, 10] loop
      c := c || substr(a, (get_byte(b, i) % 32) + 1, 1);
    end loop;
    exit when not exists (select 1 from promo_codes where lower(code) = lower(c));
  end loop;
  return c;
end $$;
revoke execute on function public._xp_code(text) from public, anon, authenticated;

-- The active packs, for the Experiences page (anyone): no buyer, nothing private.
create or replace function public.xp_packs_list() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'title_en', p.title_en, 'title_ar', p.title_ar,
           'lessons', p.lessons, 'price', p.price, 'bike_type', p.bike_type, 'months', p.months) order by p.kind, p.price), '[]'::jsonb)
    from xp_packs p where p.active
$$;
revoke execute on function public.xp_packs_list() from public;
grant execute on function public.xp_packs_list() to anon, authenticated;

-- Staff: every pack with what it sold.
create or replace function public.staff_xp_packs() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
            'sold', (select count(*) from xp_purchases x where x.pack_id = p.id and x.status = 'paid')) order by p.active desc, p.created_at desc)
          from xp_packs p), '[]'::jsonb);
end $$;
revoke execute on function public.staff_xp_packs() from public, anon;
grant execute on function public.staff_xp_packs() to authenticated;

-- Admins: make or change a pack ({id?, kind, title_en, title_ar, lessons, price, bike_type, months, active}). A pack
-- already sold keeps what its buyers paid for (their codes are their own rows); a change applies to later purchases.
create or replace function public.staff_xp_pack_save(p_pack jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r xp_packs%rowtype; who text; pid uuid;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  who := (select coalesce(nullif(btrim(s.display_name), ''), 'Staff') from staff s where s.user_id = auth.uid());
  pid := nullif(p_pack ->> 'id', '')::uuid;
  if pid is null then
    insert into xp_packs (kind, title_en, title_ar, lessons, price, bike_type, months, active, created_by)
    values (p_pack ->> 'kind', btrim(p_pack ->> 'title_en'), nullif(btrim(coalesce(p_pack ->> 'title_ar', '')), ''),
            (p_pack ->> 'lessons')::int, (p_pack ->> 'price')::numeric, nullif(btrim(coalesce(p_pack ->> 'bike_type', '')), ''),
            coalesce((p_pack ->> 'months')::int, 6), coalesce((p_pack ->> 'active')::boolean, true), left(who, 80))
    returning * into r;
  else
    update xp_packs set kind = p_pack ->> 'kind', title_en = btrim(p_pack ->> 'title_en'),
                        title_ar = nullif(btrim(coalesce(p_pack ->> 'title_ar', '')), ''), lessons = (p_pack ->> 'lessons')::int,
                        price = (p_pack ->> 'price')::numeric, bike_type = nullif(btrim(coalesce(p_pack ->> 'bike_type', '')), ''),
                        months = coalesce((p_pack ->> 'months')::int, months), active = coalesce((p_pack ->> 'active')::boolean, active),
                        updated_at = now()
     where id = pid returning * into r;
    if r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  end if;
  return to_jsonb(r);
end $$;
revoke execute on function public.staff_xp_pack_save(jsonb) from public, anon;
grant execute on function public.staff_xp_pack_save(jsonb) to authenticated;

-- A gift ride (EF20): one rider, one bike type, today's fare for that type, paid now on /pay/<id>. Switched on by
-- site_content xp.gifts {on:true}. Returns {id} (the payment).
create or replace function public.xp_gift_start(p_key text, p_id text, p_token text, p_kind text, p_type text,
                                                p_for text default null, p_note text default null, p_lang text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare amt numeric; x xp_purchases%rowtype; p payments%rowtype; nm text := nullif(btrim(coalesce(p_for, '')), '');
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if coalesce(_pay_setting('xp.gifts') ->> 'on', 'false') <> 'true' or not _pay_on('pay.enabled') then
    raise exception 'XP_OFF' using errcode = 'P0001';
  end if;
  if coalesce(p_kind, '') <> 'jcc' then raise exception 'XP_KIND' using errcode = 'P0001'; end if;
  if coalesce(p_type, '') in ('', 'Any', 'Own') then raise exception 'XP_TYPE' using errcode = 'P0001'; end if;
  amt := (select rp.price from ride_prices rp where rp.type = p_type limit 1);
  if amt is null then raise exception 'XP_TYPE' using errcode = 'P0001'; end if;
  if amt < 1 then raise exception 'XP_PRICE' using errcode = 'P0001'; end if;
  /* names are letters and spaces only (the owner's names rule) */
  if nm is not null and (length(nm) > 40 or nm ~ '[0-9!-/:-@\[-`{-~]') then raise exception 'XP_NAME' using errcode = 'P0001'; end if;
  if length(coalesce(p_note, '')) > 200 then raise exception 'XP_NOTE' using errcode = 'P0001'; end if;
  if (select count(*) from xp_purchases y where y.customer_id = p_id and y.status = 'unpaid' and y.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'XP_BUSY' using errcode = 'P0001';
  end if;
  insert into xp_purchases (what, customer_id, kind, bike_type, amount, for_name, note)
  values ('gift', p_id, p_kind, p_type, amt, nm, nullif(btrim(coalesce(p_note, '')), ''))
  returning * into x;
  p := _pay_new('xp', x.id::text, array[x.id::text], jsonb_build_array(jsonb_build_object('id', x.id, 'amount', amt)), p_id, amt,
                'Gift ride · ' || p_type, _pay_int('pay.holdMinutes', 15, 5, 60), false, p_lang);
  update xp_purchases set payment_id = p.id where id = x.id;
  return jsonb_build_object('id', p.id);
end $$;
revoke execute on function public.xp_gift_start(text, text, text, text, text, text, text, text) from public;
grant execute on function public.xp_gift_start(text, text, text, text, text, text, text, text) to anon, authenticated;

-- A pack (EF21): an active pack at its price, paid now on /pay/<id>. Returns {id} (the payment).
create or replace function public.xp_pack_start(p_key text, p_id text, p_token text, p_pack uuid, p_lang text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare k xp_packs%rowtype; x xp_purchases%rowtype; p payments%rowtype;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _pay_on('pay.enabled') then raise exception 'XP_OFF' using errcode = 'P0001'; end if;
  select * into k from xp_packs where id = p_pack and active;
  if k.id is null then raise exception 'XP_PACK' using errcode = 'P0001'; end if;
  if (select count(*) from xp_purchases y where y.customer_id = p_id and y.status = 'unpaid' and y.created_at > now() - interval '1 hour') >= 5 then
    raise exception 'XP_BUSY' using errcode = 'P0001';
  end if;
  insert into xp_purchases (what, customer_id, kind, bike_type, pack_id, lessons, amount)
  values ('pack', p_id, k.kind, k.bike_type, k.id, k.lessons, k.price)
  returning * into x;
  p := _pay_new('xp', x.id::text, array[x.id::text], jsonb_build_array(jsonb_build_object('id', x.id, 'amount', k.price)), p_id, k.price,
                left(k.title_en, 100) || ' · ' || k.lessons, _pay_int('pay.holdMinutes', 15, 5, 60), false, p_lang);
  update xp_purchases set payment_id = p.id where id = x.id;
  return jsonb_build_object('id', p.id);
end $$;
revoke execute on function public.xp_pack_start(text, text, text, uuid, text) from public;
grant execute on function public.xp_pack_start(text, text, text, uuid, text) to anon, authenticated;

-- Paid: the code is issued; refunded, in full or in part (F1, the review's L1: a part refund left the code live): it is
-- voided (a used gift stays used; a pack's spent sessions stay spent and the rest go). Runs inside pay_settle / the
-- refund functions, after they set the payment's status. A refund staff start is refused while a booking still to come
-- carries the code, and ends the code at once (_xp_refund_guard, below).
create or replace function public._xp_pay_follow() returns trigger
language plpgsql security definer set search_path = public as $$
declare x xp_purchases%rowtype; c text; mo int;
begin
  if new.kind <> 'xp' or new.status is not distinct from old.status then return new; end if;
  select * into x from xp_purchases where id = new.ref::uuid for update;
  if x.id is null then return new; end if;
  if new.status = 'paid' and x.status = 'unpaid' then
    if x.what = 'gift' then
      c := _xp_code('GF');
      insert into promo_codes (id, code, kind, value, active, created_at, applies_to, expires_at, max_uses, uses, customer_id, ride_kind)
      values ('xp-' || x.id, c, 'flat', x.amount, true, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              x.bike_type, _pay_today() + 365, 1, 0, null, x.kind);
      update xp_purchases set status = 'paid', code = c, paid_at = now(), expires_on = _pay_today() + 365 where id = x.id;
    else
      c := _xp_code('PK');
      mo := coalesce((select k.months from xp_packs k where k.id = x.pack_id), 6);
      insert into promo_codes (id, code, kind, value, active, created_at, applies_to, expires_at, max_uses, uses, customer_id, ride_kind)
      values ('xp-' || x.id, c, 'percent', 100, true, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              x.bike_type, (_pay_today() + make_interval(months => mo))::date, x.lessons, 0, x.customer_id, x.kind);
      update xp_purchases set status = 'paid', code = c, paid_at = now(), expires_on = (_pay_today() + make_interval(months => mo))::date
       where id = x.id;
    end if;
  elsif new.status in ('refunded', 'partly_refunded') and x.status = 'paid' then
    update promo_codes set active = false where lower(code) = lower(x.code);
    update xp_purchases set status = 'void' where id = x.id;
  end if;
  return new;
end $$;
revoke execute on function public._xp_pay_follow() from public, anon, authenticated;
drop trigger if exists trg_xp_pay_follow on public.payments;
create trigger trg_xp_pay_follow after update of status on public.payments
  for each row when (new.kind = 'xp') execute function public._xp_pay_follow();

-- F1 (the review's L1): a booking that already carries a gift's or a pack's code keeps the price the code gave it
-- (_enforce_booking_price prices a code only when it is newly applied), so a refund of the purchase while such a booking
-- is still to come gave the money back AND the ride. Repricing those rows from here was not safe (a staff write skips
-- the price function, and a free row may already be marked paid), so the refund is refused instead: XP_CODE_IN_USE
-- while a booking that carries the code is waiting, on the waitlist or riding, on today or a later day; staff cancel
-- it first (the code's use comes back with it) and refund then. Allowed, the refund ends the code at once (no booking can
-- take it while the refund is on its way; a wallet refund never changes the payment's status) and voids the purchase.
-- Only refunds staff start on the purchase's own payment are judged: one the system owes by itself (by 'system') or
-- one on another Moyasar payment of it (paid twice) is never refused, so pay_settle never fails here.
create or replace function public._xp_refund_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare p payments%rowtype; x xp_purchases%rowtype; today text := to_char(_pay_today(), 'YYYY-MM-DD');
begin
  select * into p from payments where id = new.payment_id;
  if p.id is null or p.kind <> 'xp' then return new; end if;
  if coalesce(new.by_name, '') = 'system' or new.provider_id is distinct from p.provider_id then return new; end if;
  select * into x from xp_purchases where id::text = p.ref for update;
  if x.id is null or x.code is null then return new; end if;
  if exists (select 1 from queue_entries q
              where lower(coalesce(q.promo_code, '')) = lower(x.code)
                and coalesce(q.status, 'waiting') in ('waiting', 'waitlist', 'active')
                and left(coalesce(q.session_date, (select s.session_date from sessions s where s.id = q.session_id), '9999-12-31'), 10) >= today) then
    raise exception 'XP_CODE_IN_USE: cancel the bookings that carry % first', x.code using errcode = 'P0001';
  end if;
  update promo_codes set active = false where lower(code) = lower(x.code);
  update xp_purchases set status = 'void' where id = x.id and status = 'paid';
  return new;
end $$;
revoke execute on function public._xp_refund_guard() from public, anon, authenticated;
drop trigger if exists trg_xp_refund_guard on public.payment_refunds;
create trigger trg_xp_refund_guard before insert on public.payment_refunds
  for each row execute function public._xp_refund_guard();

-- The rider's own gifts and packs, with their codes (the account page, the payment page once paid).
create or replace function public.customer_xp_purchases(p_id text, p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
            'id', x.id, 'what', x.what, 'kind', x.kind, 'bike_type', x.bike_type, 'lessons', x.lessons, 'amount', x.amount,
            'for_name', x.for_name, 'note', x.note, 'status', x.status, 'code', x.code, 'payment_id', x.payment_id,
            'expires_on', x.expires_on, 'paid_at', x.paid_at,
            'title_en', k.title_en, 'title_ar', k.title_ar,
            'used', coalesce(pc.uses, 0), 'left', greatest(coalesce(pc.max_uses, 0) - coalesce(pc.uses, 0), 0))
            order by x.created_at desc)
          from xp_purchases x
          left join xp_packs k on k.id = x.pack_id
          left join promo_codes pc on x.code is not null and lower(pc.code) = lower(x.code)
         where x.customer_id = p_id and x.status <> 'unpaid'), '[]'::jsonb);
end $$;
revoke execute on function public.customer_xp_purchases(text, text) from public;
grant execute on function public.customer_xp_purchases(text, text) to anon, authenticated;

-- What a gift is, for whoever holds its code (the link's landing, through the website's server with the server key and
-- the visitor's address for the meter): never who bought it.
create or replace function public.xp_gift_view(p_key text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare x xp_purchases%rowtype; pc promo_codes%rowtype;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if coalesce(p_code, '') !~ '^GF-[A-Z0-9]{8}$' then return null; end if;
  /* B8 (d): the visitor the website's server names (x-mm-visitor-ip, trusted after the server key), as the store's
     metered functions count them; without it every visitor shares the website's own address */
  if not _ip_gate('xpgift' || _store_visitor(), 30, interval '10 minutes') then raise exception 'RATE_LIMIT' using errcode = 'P0001'; end if;
  select * into x from xp_purchases where code = p_code and what = 'gift';
  if x.id is null then return null; end if;
  select * into pc from promo_codes where lower(code) = lower(p_code) order by id limit 1;
  return jsonb_build_object('kind', x.kind, 'bike_type', x.bike_type, 'for_name', x.for_name, 'note', x.note,
           'status', case when x.status = 'void' or not coalesce(pc.active, false) then 'void'
                          when coalesce(pc.uses, 0) >= coalesce(pc.max_uses, 1) then 'used'
                          when x.expires_on < _pay_today() then 'expired' else 'ready' end,
           'expires_on', x.expires_on);
end $$;
revoke execute on function public.xp_gift_view(text, text) from public;
grant execute on function public.xp_gift_view(text, text) to anon, authenticated;

-- Staff: every gift and pack bought (newest first), with the buyer's name, for the staff Payments screen.
create or replace function public.staff_xp_purchases(p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(to_jsonb(x) || jsonb_build_object('customer', (select c.name from customers c where c.id = x.customer_id),
            'uses', pc.uses, 'max_uses', pc.max_uses, 'active', pc.active) order by x.created_at desc)
          from (select * from xp_purchases where status <> 'unpaid' order by created_at desc limit least(greatest(coalesce(p_limit, 200), 1), 1000)) x
          left join promo_codes pc on x.code is not null and lower(pc.code) = lower(x.code)), '[]'::jsonb);
end $$;
revoke execute on function public.staff_xp_purchases(int) from public, anon;
grant execute on function public.staff_xp_purchases(int) to authenticated;

-- ── 8d. Bike credit (EF22) ───────────────────────────────────────────────────────────────────────────
-- F1 (the review's H1): a credit is never paid while the bike can still go back. The order's payment only holds it
-- ('held': the amount and the ride fees it covers, so no other bike order counts them); it is paid into the wallet by
-- the hourly job mm-xp-bike-credit once the order was delivered or collected, the return and exchange window is over (15
-- Riyadh days after the handover: return within 7 days, exchange within 15, store_return_request), no return or exchange
-- of a bike line is still open, no return of one was approved, and the money given back on the order stays clear of its
-- bike lines. Otherwise it is voided ('void'), never paid. A credit paid and later undone (the order refunded) is taken
-- back from the wallet as before. Staff read only paid ones (the order sheet shows what went into the wallet).
create table if not exists public.xp_bike_credits (
  order_id     uuid primary key,
  customer_id  text not null check (length(customer_id) between 1 and 64),
  amount       numeric(10,2) not null check (amount > 0 and amount <= 5000),
  bookings     text[] not null default '{}',
  created_at   timestamptz not null default now(),
  state        text not null default 'held' check (state in ('held', 'paid', 'void')),                 -- F1 (H1)
  paid_at      timestamptz,                                                                              -- F1 (H1)
  reversed     numeric(10,2) check (reversed is null or (reversed >= 0 and reversed <= amount)),   -- B8 (f): taken back
  reversed_at  timestamptz
);
create index if not exists xp_bike_credits_held on public.xp_bike_credits (created_at) where state = 'held';
alter table public.xp_bike_credits enable row level security;
revoke all on public.xp_bike_credits from anon, authenticated;
drop policy if exists "xp_bike_credits staff read" on public.xp_bike_credits;
create policy "xp_bike_credits staff read" on public.xp_bike_credits for select to authenticated
  using ((select is_staff()) and state = 'paid');
grant select on public.xp_bike_credits to authenticated;

-- When a store order with a bike becomes paid (switch xp.bikeCredit on): the buyer's own paid, ridden ride fees of the
-- last N days are held for them, capped, once per order, never a fee another bike order holds or was credited for.
-- B8 (f): one customer's bike orders take turns (an advisory lock on the customer), so two bike orders paid at once
-- never hold the same fees. An order cancelled or refunded voids a held credit (nothing was paid) and takes a paid one
-- back from the wallet as far as the balance goes (never below zero), once, whether the switch is still on or not; the
-- rides of a paid credit stay counted, so they are never paid back twice, while a void one frees them. Nothing here
-- ever blocks the order's payment or refund.
create or replace function public._xp_bike_credit_follow() returns trigger
language plpgsql security definer set search_path = public as $$
declare cfg jsonb := _pay_setting('xp.bikeCredit'); days int; cap numeric; amt numeric; ids text[]; since date;
        c xp_bike_credits%rowtype; who text; bal numeric;
begin
  if new.customer_id is null or new.status is not distinct from old.status then return new; end if;
  if new.status in ('cancelled', 'refunded') then
    select * into c from xp_bike_credits where order_id = new.id and state <> 'void' and reversed is null for update;
    if c.order_id is null then return new; end if;
    if c.state = 'held' then
      update xp_bike_credits set state = 'void' where order_id = c.order_id;
      return new;
    end if;
    who := _wallet_owner(c.customer_id);
    select balance into bal from wallet_balances where customer_id = who for update;
    bal := round(least(c.amount, greatest(coalesce(bal, 0), 0)), 2);
    update xp_bike_credits set reversed = bal, reversed_at = now() where order_id = c.order_id;
    if bal > 0 then
      perform set_config('mm.wallet_op', 'Bike credit back', true);
      perform set_config('mm.wallet_note', 'Bike order ' || coalesce(new.no::text, new.id::text) || ' ' || new.status, true);
      perform _wallet_post(who, -bal, 'adjust', null, null, null, 'bkc-' || new.id, null);
      perform set_config('mm.wallet_op', '', true);
      perform set_config('mm.wallet_note', '', true);
    end if;
    return new;
  end if;
  if coalesce(cfg ->> 'on', 'false') <> 'true' or new.status <> 'paid' then return new; end if;
  if exists (select 1 from xp_bike_credits b where b.order_id = new.id) then return new; end if;
  if not exists (select 1 from store_order_items i join store_products sp on sp.id = i.product_id
                  where i.order_id = new.id and sp.category = 'bikes') then return new; end if;
  perform pg_advisory_xact_lock(hashtext('xp_bike_credit:' || new.customer_id));
  days := least(greatest(coalesce((cfg ->> 'days')::int, 30), 1), 365);
  cap := least(greatest(coalesce((cfg ->> 'max')::numeric, 300), 0), 5000);
  since := (coalesce(new.paid_at, now()) at time zone 'Asia/Riyadh')::date - days;
  /* the rider's own ridden, paid rides in the window that no other bike order holds or was credited for */
  select coalesce(sum(q.price), 0), coalesce(array_agg(q.id), '{}') into amt, ids
    from queue_entries q
   where q.customer_id = new.customer_id and q.status = 'done' and coalesce(q.paid, false) and coalesce(q.price, 0) > 0
     and left(q.session_date, 10) >= to_char(since, 'YYYY-MM-DD')
     and not exists (select 1 from xp_bike_credits b where b.customer_id = new.customer_id and b.state <> 'void' and q.id = any(b.bookings));
  amt := round(least(amt, cap), 2);
  if amt <= 0 then return new; end if;
  /* F1 (H1): held, not paid: _xp_bike_credit_tick pays it once the bike is kept past the return window */
  insert into xp_bike_credits (order_id, customer_id, amount, bookings, state) values (new.id, new.customer_id, amt, ids, 'held');
  return new;
exception when others then
  /* a credit that cannot be held or taken back never blocks the order's payment or refund */
  return new;
end $$;
revoke execute on function public._xp_bike_credit_follow() from public, anon, authenticated;
drop trigger if exists trg_xp_bike_credit on public.store_orders;
create trigger trg_xp_bike_credit after update of status on public.store_orders
  for each row execute function public._xp_bike_credit_follow();

-- F1 (H1): the money given back on a store order so far, every way: card or wallet refunds owed, being sent or done
-- (payment_refunds names the order), the wallet's own part given back (sale_back on the order's receipt, a gift card's
-- part that went to the wallet included) and a gift card's part put back on it.
create or replace function public._xp_order_given_back(o store_orders) returns numeric
language sql stable security definer set search_path = public as $$
  select round(coalesce((select sum(r.amount) from payment_refunds r where r.order_id = o.id and r.status in ('due', 'pending', 'done')), 0)
             + coalesce((select sum(l.amount) from wallet_ledger l where l.receipt_id = 'ord-' || o.no and l.kind = 'sale_back'), 0)
             + coalesce((select sum(m.amount) from store_gift_card_moves m where m.order_id = o.id and m.kind in ('back', 'refund')), 0), 2)
$$;
revoke execute on function public._xp_order_given_back(store_orders) from public, anon, authenticated;

-- F1 (H1): pays the held bike credits whose bike was kept (mm-xp-bike-credit, hourly; the switch only decides when the
-- order is paid, so a credit held while it was on is honoured after it is turned off). Per held credit:
--   the order cancelled or refunded, or gone            -> void;
--   not delivered yet, or 15 Riyadh days not yet over    -> wait;
--   a return or exchange of a bike line still open       -> wait for staff's answer;
--   a return of a bike line approved, or more given back than the order's non-bike part -> void;
--   else the rides it holds that are still ridden, paid fees (never more than held) go into the wallet -> paid.
-- Each credit is its own step: one that cannot be posted is left held and tried again next hour. Answers how many paid.
create or replace function public._xp_bike_credit_tick() returns int
language plpgsql security definer set search_path = public as $$
declare c xp_bike_credits%rowtype; o store_orders%rowtype; dat timestamptz; bikes numeric; amt numeric; n int := 0;
begin
  for c in select * from xp_bike_credits where state = 'held' order by created_at limit 200 for update skip locked loop
    begin
      select * into o from store_orders where id = c.order_id;
      if o.id is null or o.status in ('cancelled', 'refunded') then
        update xp_bike_credits set state = 'void' where order_id = c.order_id;
        continue;
      end if;
      if o.status <> 'delivered' then continue; end if;
      select e.at into dat from store_order_events e where e.order_id = o.id and e.status = 'delivered' order by e.id limit 1;
      if dat is null or _pay_today() - (dat at time zone 'Asia/Riyadh')::date <= 15 then continue; end if;
      if exists (select 1 from store_return_requests rr cross join jsonb_array_elements(rr.items) y
                   join store_order_items i on i.id = (y ->> 'item_id')::bigint and i.order_id = o.id
                   join store_products sp on sp.id = i.product_id and sp.category = 'bikes'
                  where rr.order_id = o.id and rr.status = 'open') then
        continue;
      end if;
      select coalesce(sum(i.unit_price * i.qty), 0) into bikes
        from store_order_items i join store_products sp on sp.id = i.product_id and sp.category = 'bikes'
       where i.order_id = o.id;
      if exists (select 1 from store_return_requests rr cross join jsonb_array_elements(rr.items) y
                   join store_order_items i on i.id = (y ->> 'item_id')::bigint and i.order_id = o.id
                   join store_products sp on sp.id = i.product_id and sp.category = 'bikes'
                  where rr.order_id = o.id and rr.status = 'approved' and rr.kind = 'return')
         or _xp_order_given_back(o) > greatest(o.total - bikes, 0) then
        update xp_bike_credits set state = 'void' where order_id = c.order_id;
        continue;
      end if;
      /* a ride fee refunded since the order was paid is not paid back again */
      select round(least(coalesce(sum(q.price), 0), c.amount), 2) into amt
        from queue_entries q
       where q.id = any(c.bookings) and q.customer_id = c.customer_id and q.status = 'done' and coalesce(q.paid, false)
         and coalesce(q.price, 0) > 0;
      if amt <= 0 then
        update xp_bike_credits set state = 'void' where order_id = c.order_id;
        continue;
      end if;
      update xp_bike_credits set state = 'paid', paid_at = now(), amount = amt where order_id = c.order_id;
      perform set_config('mm.wallet_op', 'Bike credit', true);
      perform set_config('mm.wallet_note', 'Ride fees back on bike order ' || coalesce(o.no::text, o.id::text), true);
      perform _wallet_post(_wallet_owner(c.customer_id), amt, 'adjust', null, null, null, 'bkc-' || o.id, null);
      perform set_config('mm.wallet_op', '', true);
      perform set_config('mm.wallet_note', '', true);
      n := n + 1;
    exception when others then
      raise warning 'xp bike credit for order %: %', c.order_id, sqlerrm;
    end;
  end loop;
  return n;
end $$;
revoke execute on function public._xp_bike_credit_tick() from public, anon, authenticated;

do $cron$ begin
  if exists (select 1 from cron.job where jobname = 'mm-xp-bike-credit') then perform cron.unschedule('mm-xp-bike-credit'); end if;
  perform cron.schedule('mm-xp-bike-credit', '23 * * * *', 'select public._xp_bike_credit_tick()');
end $cron$;

-- ── 8e. Early bird (EF29) ────────────────────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists xp_early smallint check (xp_early is null or xp_early between 1 and 50);
comment on column public.queue_entries.xp_early is 'The early-bird share (percent) this customer booking was priced with (B6 2026-11-18); null = none. Only trigger trg_enforce_booking_price_xp writes it.';

-- A customer booking made N days or more before its date pays pct less (xp.earlyBird {on, pct 1-50, days 1-120,
-- kinds}, AND the discount licence). Sorts after trg_enforce_booking_price(_upd), before trg_house_guard and
-- trg_promo_free_drop; staff writes are never touched; free and paid rows are left alone.
-- B8 (g): the kind is _session_kind's (the app's names: a circuit night is 'jcc' though its ride_kind is empty), as
-- promo codes name kinds; it never stacks on a code (gift, pack or promo: the code's price stands); a booking moved to
-- another session keeps a share only while that session still earns one (asked again as for a new booking); and only
-- this trigger stamps xp_early (a value a client sent in is dropped on insert and kept as it was on update).
create or replace function public._xp_early_bird() returns trigger
language plpgsql security definer set search_path = public as $$
declare cfg jsonb; pct int; days int; k text; d text;
begin
  if (select is_staff()) then return new; end if;
  if tg_op = 'INSERT' then new.xp_early := null; else new.xp_early := old.xp_early; end if;
  if coalesce(new.price, 0) <= 0 or coalesce(new.paid, false) or coalesce(new.status, 'waiting') not in ('waiting', 'waitlist') then return new; end if;
  if coalesce(new.promo_code, '') <> '' then
    if tg_op = 'UPDATE' and new.price is distinct from old.price then new.xp_early := null; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    /* a later change that left the price as it was keeps it; one the price function repriced takes the stamped share
       again on the same session; a move asks again below */
    if new.xp_early is null or new.price is not distinct from old.price then return new; end if;
    if new.session_id is not distinct from old.session_id then
      new.price := round(new.price * (100 - new.xp_early) / 100.0, 2);
      return new;
    end if;
    new.xp_early := null;
  end if;
  cfg := _pay_setting('xp.earlyBird');
  if coalesce(cfg ->> 'on', 'false') <> 'true' or _store_licence() is null then return new; end if;
  pct := least(greatest(coalesce((cfg ->> 'pct')::int, 10), 1), 50);
  days := least(greatest(coalesce((cfg ->> 'days')::int, 14), 1), 120);
  k := _session_kind(new.session_id);
  if k is null or not (coalesce(cfg -> 'kinds', '[]'::jsonb) ? k) then return new; end if;
  select left(coalesce(s.session_date, new.session_date, ''), 10) into d from sessions s where s.id = new.session_id;
  if coalesce(d, '') !~ '^\d{4}-\d{2}-\d{2}$' or d::date - _pay_today() < days then return new; end if;
  new.xp_early := pct;
  new.price := round(new.price * (100 - pct) / 100.0, 2);
  return new;
end $$;
revoke execute on function public._xp_early_bird() from public, anon, authenticated;
drop trigger if exists trg_enforce_booking_price_xp on public.queue_entries;
create trigger trg_enforce_booking_price_xp before insert or update on public.queue_entries
  for each row execute function public._xp_early_bird();

-- ═══ 9. An anonymous average rating per kind (B5: EF35) ═════════════════════════════════════════════
-- B5 (Experiences list and session page): one function, no table.
--
-- EF35: an anonymous average rating for each kind of session, read by anyone (the website's /experiences rows and each
-- session's page, lib/sx-B5-server.ts xpRatings, kept ten minutes per Worker). It gives per kind only the average out of
-- 5 (one decimal) and how many ratings make it: never a name, a rider, a booking, a comment or a date. A kind with fewer
-- ratings than staff's minimum (site_content xp.general.ratingMin, default 20, never under 5; the Website editor's
-- "Experiences: session facts" page) is left out, and the website hides anything under its own copy of that minimum too.
--
-- What counts: each finished booking's own score (queue_entries.status 'done', rating_exp 1-10: a session's service score
-- since 2026-11-03, the Saturday ride's overall score), halved to stars, over the last two years; and each testimonial
-- staff published with stars (testimonials.status 'published', 20261119120000), by what it is about ('saturday' the
-- Saturday ride, 'session' a circuit night, 'workshop' the workshop; 'learn', 'event' and 'other' name no one kind and
-- are left out). The kind is the website's (lib/rides.ts rideKind): snd96 first, anything not event_kind 'community' a
-- circuit night (jcc), a known ride_kind as itself, every other community row the Saturday ride.
--
-- Rights: SECURITY DEFINER with search_path public (copied from the house style of 20261110150000's helpers); executable
-- by anon and authenticated, as it says nothing about anyone. It calls _pay_int (20261110150000), which stays internal.
-- Rollback: drop function public.xp_kind_ratings();
create or replace function public.xp_kind_ratings()
 returns jsonb
 language sql
 stable security definer
 set search_path = public
as $$
  with r as (
    select case when s.ride_kind = 'snd96' then 'snd96'
                when coalesce(s.event_kind, '') <> 'community' then 'jcc'
                when s.ride_kind in ('petromin', 'swim', 'workshop', 'event', 'runher', 'vlap', 'defe5k', 'arena', 'blood', 'yoga', 'farm', 'testride') then s.ride_kind
                else 'saturday' end as kind,
           e.rating_exp::numeric / 2 as stars
      from queue_entries e
      join sessions s on s.id = e.session_id
     where e.status = 'done'
       and e.rating_exp between 1 and 10
       and e.session_date >= to_char(current_date - 730, 'YYYY-MM-DD')
    union all
    select case t.about when 'saturday' then 'saturday' when 'session' then 'jcc' when 'workshop' then 'workshop' end, t.stars::numeric
      from testimonials t
     where t.status = 'published' and t.stars between 1 and 5 and t.about in ('saturday', 'session', 'workshop')
  ), k as (
    select kind, round(avg(greatest(1, least(5, stars))), 1) as avg, count(*)::int as n
      from r
     where kind is not null
     group by kind
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'avg', avg, 'n', n) order by kind), '[]'::jsonb)
    from k
   where n >= greatest(5, _pay_int('xp.general.ratingMin', 20, 5, 1000))
$$;
revoke execute on function public.xp_kind_ratings() from public;
grant execute on function public.xp_kind_ratings() to anon, authenticated;


-- ═══ 10. Arabic product names, data only (B1: P22) ═══════════════════════════════════════════════════
-- One naming rule for Arabic product names: the model in Latin letters, the brand once (the brand line shows it; the
-- website sets each Latin run in a <bdi>). Staging's products as the audit of 2026-11-18 found them. Each update names
-- the slug AND the old Arabic name, so a row staff already renamed (or production) is untouched; safe to run twice. Only
-- name_ar changes, so store_products_guard (former price, bundle, sale dates) is not asked. Staff keep writing name_ar
-- by that rule in the product editor. Rollback: the same updates with the two names swapped.
update public.store_products set name_ar = 'TT BGP'            where slug = 'ttbgp'   and name_ar = 'ALVAS TT BGP';
update public.store_products set name_ar = 'DA54 AL'           where slug = 'da54al'  and name_ar = 'ألفاس DA54 AL';
update public.store_products set name_ar = 'STROM M50'         where slug = 'strom'   and name_ar = 'ألفاس STROM M50';
update public.store_products set name_ar = 'TOURIST'           where slug = 'tourist' and name_ar = 'ألفاس TOURIST';
update public.store_products set name_ar = 'HAPPY JUMP BMX 26' where slug = 'bmx26'   and name_ar = 'ألفاس HAPPY JUMP BMX 26';
update public.store_products set name_ar = 'Edge 850'          where slug = 'edge850' and name_ar = 'قارمن Edge 850';
update public.store_products set name_ar = 'Varia RTL515'      where slug = 'varia'   and name_ar = 'قارمن Varia RTL515';

-- Check after (expect 0 rows: no Arabic name starts with a brand's Arabic spelling or repeats the brand in Latin):
-- select slug, brand, name_ar from public.store_products
--  where name_ar ~ '^(ألفاس|الفاس|قارمن|جارمن)\s' or (brand is not null and lower(name_ar) like lower(brand) || ' %');

-- ── Checks (as 20261110235200's and every builder's own): every definer function written here is SECURITY DEFINER with
-- a search_path, the plain helpers have a search_path, no helper is a client's to run, staff functions are not anon's,
-- the website's are reachable, every new table has row level security and nothing for anon, the bucket is private,
-- the badge is there, payments take 'xp', and _store_order_json kept 20261119000800's text with B3's line. F1 (the
-- review's L5): inside the transaction, before the ledger row and the commit, so a failed check rolls the whole file back.
do $chk$
declare f text; t text;
begin
  foreach f in array array[
      -- part 3 + 5 (B3)
      'public._store_ramadan()', 'public._store_slots()', 'public._store_handover_cfg()', 'public._store_handover_grid(jsonb,date)',
      'public._store_handover_days(jsonb,date,integer)', 'public.store_handover_slots(date)', 'public.store_checkout_plus(text,text,text,jsonb)',
      'public._store_quote_json(public.store_quotes)', 'public.store_quote_get(text,text)', 'public.staff_store_quote_save(jsonb)',
      'public.staff_store_quotes(integer)', 'public.staff_store_quote_void(uuid)', 'public.staff_store_session_handovers(text)',
      'public._store_order_sx(public.store_orders,boolean)', 'public._store_order_json(public.store_orders,boolean)',
      'public.store_gift_card_to_wallet(text,text,text,text)',
      -- part 4 (B8)
      'public._store_slot_season_ok(jsonb)', 'public._store_slot_season_guard()',
      -- part 6 (B2)
      'public.store_fleet_record(uuid)', 'public.store_rode_type(text,text,uuid)',
      -- part 7 (B4)
      'public.store_after_read(text,bigint,text)', 'public.store_after_arrive(text,bigint,text,text)',
      'public.store_after_slot_change(text,bigint,text,date,text)', 'public.store_after_claim(text,bigint,text,bigint,text,text[])',
      'public.store_after_return_photos(text,bigint,text,text[])', 'public.store_after_push(text,bigint,text,boolean,text,text)',
      'public.store_order_pass(bigint,text)', 'public.staff_store_after_order(uuid)', 'public.staff_store_after_queue()',
      'public.staff_store_after_build(uuid,text[],jsonb,text)', 'public.staff_store_after_build_clear(uuid)',
      'public.staff_store_after_seen(uuid)', 'public.staff_store_after_claim_set(uuid,text,text,text)',
      'public._store_after_order(bigint,text,boolean)', 'public._store_after_json(public.store_orders)', 'public._store_after_staffer()',
      'public._store_after_bike_owner()', 'public._store_after_grant_bike(uuid)',
      'public.store_after_photo_slot(text,bigint,text)', 'public._store_after_photo_take(text,text)',
      -- part 8 (B6)
      'public._xp_code(text)', 'public.xp_packs_list()', 'public.staff_xp_packs()', 'public.staff_xp_pack_save(jsonb)',
      'public.xp_gift_start(text,text,text,text,text,text,text,text)', 'public.xp_pack_start(text,text,text,uuid,text)',
      'public._xp_pay_follow()', 'public.customer_xp_purchases(text,text)', 'public.xp_gift_view(text,text)',
      'public.staff_xp_purchases(integer)', 'public._xp_bike_credit_follow()', 'public._xp_early_bird()',
      'public._xp_refund_guard()', 'public._xp_order_given_back(public.store_orders)', 'public._xp_bike_credit_tick()',
      -- part 9 (B5)
      'public.xp_kind_ratings()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._store_hm(text)', 'public._store_hm_text(integer)', 'public._store_days_hi(text)',
                           'public._store_after_photos(bigint,text[])'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing or has no search_path', f;
    end if;
  end loop;
  -- internal helpers and trigger functions: no client runs them
  foreach f in array array['public._store_hm(text)', 'public._store_hm_text(integer)', 'public._store_days_hi(text)', 'public._store_ramadan()',
      'public._store_slots()', 'public._store_handover_cfg()', 'public._store_handover_grid(jsonb,date)',
      'public._store_handover_days(jsonb,date,integer)', 'public._store_quote_json(public.store_quotes)',
      'public._store_order_sx(public.store_orders,boolean)', 'public._store_order_json(public.store_orders,boolean)',
      'public._store_slot_season_ok(jsonb)', 'public._store_slot_season_guard()',
      'public._store_after_order(bigint,text,boolean)', 'public._store_after_json(public.store_orders)', 'public._store_after_photos(bigint,text[])',
      'public._store_after_staffer()', 'public._store_after_bike_owner()', 'public._store_after_grant_bike(uuid)',
      'public._xp_code(text)', 'public._xp_pay_follow()', 'public._xp_bike_credit_follow()', 'public._xp_early_bird()',
      'public._xp_refund_guard()', 'public._xp_order_given_back(public.store_orders)', 'public._xp_bike_credit_tick()',
      'public._pay_int(text,integer,integer,integer)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  -- staff functions: signed-in staff (each checks is_staff / is_admin), never anon
  foreach f in array array['public.staff_store_quote_save(jsonb)', 'public.staff_store_quotes(integer)', 'public.staff_store_quote_void(uuid)',
      'public.staff_store_session_handovers(text)', 'public.staff_store_after_order(uuid)', 'public.staff_store_after_queue()',
      'public.staff_store_after_build(uuid,text[],jsonb,text)', 'public.staff_store_after_build_clear(uuid)',
      'public.staff_store_after_seen(uuid)', 'public.staff_store_after_claim_set(uuid,text,text,text)',
      'public.staff_xp_packs()', 'public.staff_xp_pack_save(jsonb)', 'public.staff_xp_purchases(integer)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception 'staff cannot reach %', f; end if;
  end loop;
  -- the website's, the booking app's Wallet signer's and the public's (each checks the server key, a customer token, an
  -- order's own key, or says nothing personal)
  foreach f in array array['public.store_handover_slots(date)', 'public.store_checkout_plus(text,text,text,jsonb)',
      'public.store_quote_get(text,text)', 'public.store_gift_card_to_wallet(text,text,text,text)', 'public.store_fleet_record(uuid)',
      'public.store_rode_type(text,text,uuid)', 'public.store_after_read(text,bigint,text)', 'public.store_after_arrive(text,bigint,text,text)',
      'public.store_after_slot_change(text,bigint,text,date,text)', 'public.store_after_claim(text,bigint,text,bigint,text,text[])',
      'public.store_after_return_photos(text,bigint,text,text[])', 'public.store_after_push(text,bigint,text,boolean,text,text)',
      'public.store_order_pass(bigint,text)', 'public.store_after_photo_slot(text,bigint,text)',
      'public._store_after_photo_take(text,text)', 'public.xp_packs_list()', 'public.xp_gift_start(text,text,text,text,text,text,text,text)',
      'public.xp_pack_start(text,text,text,uuid,text)', 'public.customer_xp_purchases(text,text)', 'public.xp_gift_view(text,text)',
      'public.xp_kind_ratings()'] loop
    if not has_function_privilege('anon', f, 'execute') then raise exception 'the website cannot reach %', f; end if;
  end loop;
  -- new tables: row level security, nothing for anon, staff read through a policy
  foreach t in array array['public.store_quotes', 'public.store_after_builds', 'public.store_after_arrivals', 'public.store_after_claims',
                           'public.store_after_push', 'public.store_after_slot_changes', 'public.store_after_photo_tickets',
                           'public.xp_packs', 'public.xp_purchases', 'public.xp_bike_credits'] loop
    if not exists (select 1 from pg_class where oid = t::regclass and relrowsecurity) then raise exception '% has no row level security', t; end if;
    if has_table_privilege('anon', t, 'select') or has_table_privilege('anon', t, 'insert') or has_table_privilege('anon', t, 'update')
       or has_table_privilege('anon', t, 'delete') then
      raise exception 'anon has rights on %', t;
    end if;
    if has_table_privilege('authenticated', t, 'insert') or has_table_privilege('authenticated', t, 'update')
       or has_table_privilege('authenticated', t, 'delete') then
      raise exception 'clients may write % (every write goes through the functions)', t;
    end if;
    if not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = split_part(t, '.', 2) and p.cmd = 'SELECT') then
      raise exception '% has no read policy', t;
    end if;
  end loop;
  foreach t in array array['public.store_quote_no_seq', 'public.store_after_slot_changes_id_seq'] loop
    if has_sequence_privilege('anon', t, 'usage') or has_sequence_privilege('authenticated', t, 'usage') then
      raise exception 'a client may use %', t;
    end if;
  end loop;
  if not exists (select 1 from storage.buckets where id = 'store-claims' and not public) then raise exception 'the store-claims bucket is missing or public'; end if;
  if not exists (select 1 from public.badges where slug = 'bike_owner' and held_only and auto and not retired) then raise exception 'the Bike owner badge is missing'; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.payments'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ '''xp''') then
    raise exception 'payments do not take kind xp';
  end if;
  if position('20261119000800' in (select prosrc from pg_proc where oid = 'public._store_order_json(public.store_orders,boolean)'::regprocedure)) = 0
     or position('_store_order_sx(o, p_staff)' in (select prosrc from pg_proc where oid = 'public._store_order_json(public.store_orders,boolean)'::regprocedure)) = 0 then
    raise exception '_store_order_json lost 20261119000800''s text or B3''s line';
  end if;
  foreach t in array array['store_orders_slot_season', 'store_orders_bike_owner', 'store_order_items_bike_owner', 'trg_xp_pay_follow',
                           'trg_xp_bike_credit', 'trg_enforce_booking_price_xp', 'trg_xp_refund_guard'] loop
    if not exists (select 1 from pg_trigger where tgname = t and not tgisinternal) then raise exception 'trigger % is missing', t; end if;
  end loop;
  -- F1: the bike credit's hourly job; the claim photos' policy and the build photos' staff policy
  if not exists (select 1 from cron.job where jobname = 'mm-xp-bike-credit') then raise exception 'the job mm-xp-bike-credit is missing'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'store claims add'
                   and position('_store_after_photo_take' in coalesce(with_check, '')) > 0) then
    raise exception 'the store-claims insert policy does not ask for a ticket';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'store builds staff add'
                   and roles = '{authenticated}'::name[] and cmd = 'INSERT') then
    raise exception 'the store builds staff policy is missing or not authenticated-only';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name) values ('20261119300000', 'sx_do_all') on conflict do nothing;

commit;

-- check (read only): the settings, the ledger row, the functions' attributes, the tables' row security, the bucket, the
-- badge, the payments kind check, the queue_entries triggers in the order they fire
-- select key, value from site_content where key in ('store.checkup', 'store.company.on', 'store.pin.on', 'store.learning.on',
--   'store.sessionHandover', 'store.handover', 'store.ramadan', 'store.quoteDays', 'store.giftCardWallet.on', 'store.slotChange',
--   'store.push.on') order by key;
-- select version, name from supabase_migrations.schema_migrations where version = '20261119300000';
-- select p.proname, pg_get_function_identity_arguments(p.oid) args, p.prosecdef, p.proconfig,
--        has_function_privilege('anon', p.oid, 'execute') anon_x
--   from pg_proc p where p.pronamespace = 'public'::regnamespace
--    and (p.proname like 'store\_after\_%' or p.proname like 'staff\_store\_after\_%' or p.proname like '%xp\_%' or p.proname like '%quote%'
--         or p.proname in ('store_checkout_plus', 'store_handover_slots', 'store_order_pass', 'store_fleet_record', 'store_rode_type',
--                          'store_gift_card_to_wallet', 'staff_store_session_handovers', '_store_slots', '_store_order_json', '_store_order_sx'))
--  order by 1;
-- select relname, relrowsecurity from pg_class where relname in ('store_quotes', 'store_after_builds', 'store_after_arrivals',
--   'store_after_claims', 'store_after_push', 'store_after_slot_changes', 'xp_packs', 'xp_purchases', 'xp_bike_credits');
-- select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'store-claims';
-- select slug, held_only, auto, retired from badges where slug = 'bike_owner';
-- select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.payments'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'kind';
-- select tgname from pg_trigger where tgrelid = 'public.queue_entries'::regclass and not tgisinternal order by tgname;
-- select store_handover_slots(null);   -- {"on": false} until staff switch store.handover on
