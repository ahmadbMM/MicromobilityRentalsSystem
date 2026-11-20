-- ============================================================================
-- The Marketplace, first version: the database (the user, 2026-11-20: "add a marketplace section in the main
-- website ... i want people to be able to sell products on this page").
--
-- The owner's decisions this file carries:
--   * private people, approved shops and MicroMobility itself sell; any signed-in account may list; adults only
--     (18 years by the birth date on file);
--   * the buyer pays the seller directly: nothing here takes, holds or passes on money. The one number about money is
--     the HONOUR commission a seller is shown when they mark a listing sold (site_content marketplace.commission_pct,
--     default 1, 0 switches it off); staff tick it received by hand;
--   * a listing shows at once. Two nets: its words hit the blocked list, or N different accounts report it
--     (marketplace.auto_hold_reports, default 3), and it is held until staff look. A bicycle's frame number already on
--     another listing on sale holds the newer one;
--   * the seller chooses, per listing, "first name + last initial" or no name, with a consent tick, frozen on the
--     listing. Nothing else about a person is ever returned to another customer: no id, phone, email, full name,
--     photo, date, membership or count (the one consented exception to "members see nobody", 2026-11-04);
--   * contact is an inbox on the site. After the other side has written, either person may share their own WhatsApp
--     number in that one thread;
--   * a shop's commercial registration and VAT numbers are stored and shown; no personal ID number is asked for;
--   * built apart from the store and from payments: its own tables (market_*), its own bucket (market), its own
--     switch (site_content marketplace.on, off). The same file goes on production and on staging.
--
--  1. _staff_mod gets one mapping: the staff section 'market' is checked as People ('community').
--     Rebuilt from 20261111180200_section_checks (stable, security definer, search_path public): one word added.
--  2. Tables, all with row level security and nothing granted to anon or authenticated (customers reach them only
--     through the functions of 5, staff through 20261121300100): market_categories (the one table the public key may
--     read: visible rows), market_sellers, market_shops, market_listings, market_photo_slots, market_threads,
--     market_messages, market_reports, market_blocks, market_events (the audit trail: no foreign keys, never deleted).
--  3. Settings in site_content, each inserted once (on conflict do nothing) and read with its default when missing or
--     of the wrong shape: marketplace.on, .commission_pct, .commission_how, .limits, .listing_days, .blocked_words,
--     .auto_hold_reports, .terms_version. The 15 sports and 97 product types are seeded the same way.
--  4. Storage: the public bucket market (800,000 bytes, JPEG or WebP). The public key may add a file only at a name
--     market_photo_slot issued, once (_mkt_photo_take), and may remove only a name the database marked gone
--     (_mkt_photo_gone). No update policy.
--  5. For customers (anon key + the account's id and session token, _cust_token_ok; a refusal is raised as a code,
--     P0001, which is what a bare RAISE EXCEPTION uses): market_me, market_listing_save, market_photo_slot,
--     market_listing_publish, market_listing_state, market_my_listings, market_shop_contact, market_shop_apply,
--     market_shop_mine, market_thread_open, market_thread_send, market_threads, market_thread_get,
--     market_share_whatsapp, market_unread, market_report, market_block.
--     For anyone: market_browse, market_listing_get, market_shop_get, market_shops, market_index, market_purge_take.
--  6. The daily job _mkt_tick (pg_cron mm-market-tick, 21:40 UTC = 00:40 in Riyadh): takes a closed account's
--     listings off sale, expires listings, deletes the ones expired 60 days ago, lets go of photos, deletes threads
--     12 months after their last message, and asks the website to remove the files the database let go of.
--
-- Needs: customers (id, name, phone, whatsapp, whatsapp_same, birth_date, created_at, archived_at, merged_into),
-- queue_entries, site_content, staff; _cust_token_ok, _ip_gate, _ymd_ok, _member_active, _staff_mod,
-- _staff_role_mods; _ask_text, _ask_norm, _ask_has_link, _ask_who (20261113010000_ask); _tm_short
-- (20261119120000_testimonials). Nothing from the store or the payments tables.
-- Not built: a push notification for a new message (the outbox writes into the booking app's Updates list, with its
-- own consent categories and words in ten languages: not a small addition). The unread count is the alert.
--
-- Where this file goes past the letter of the build contract (each the smaller harm; the list is also in the
-- builder's result file):
--   * market_photo_slots.customer_id is nullable and SET NULL when its account goes (the contract: NOT NULL,
--     CASCADE), so a closed account's files can still be let go of and removed;
--   * market_events.action also takes 'shop_contact': one row per account and shop per day is the count behind
--     "30 shop contacts a day" (asking the same shop again that day is not counted again);
--   * market_listings_whole: a listing that is or was on sale keeps its category, title, description, condition,
--     price, city and dates (the pages read them as never null), so an expired listing is edited whole too;
--   * a suspended shop's owner sells nothing (the account does not fall back to a private seller);
--   * an edit of a listing on sale that changes its frame number to one already on sale holds it ('serial'), as a
--     publish would; renewing reads the blocked words again;
--   * a blocked word in Arabic is also found behind its article;
--   * the listings of an account that was archived (20261111200000: "deleting" an account archives it) or merged
--     into another are deleted by the daily job, its shop taken down, and nobody can open a thread with it meanwhile;
--   * a listing expired 60 days ago is deleted AND its photos let go of the same night (not 30 days later);
--   * the service key may write market_categories (the hourly live-to-staging copy), as it does the store's catalogue;
--   * the daily job's call to the website is to micromobility.sa: from the staging database that reaches the live
--     website, which removes the live database's files, not staging's. Staging's files go when a selling route
--     removes them (the website's purgeLater), not by the night's call.
--
-- Tested on a local Postgres 17 only (stub + tests in the session's scratch folder mk/db: mkstub.sh, fixtures.sql,
-- tests_a.sql, tests_b.sql, run.sh; see the commit body). Never run against a remote database by its author.
--
-- Rollback:
--   select cron.unschedule('mm-market-tick');
--   drop policy if exists "market photos add" on storage.objects; drop policy if exists "market photos let go" on storage.objects;
--   drop policy if exists "market photos see gone" on storage.objects; drop policy if exists "market photos staff read" on storage.objects;
--   drop policy if exists "market photos staff remove" on storage.objects;
--   drop every function public.market_*, public.staff_market_* and public._mkt_* (select oid::regprocedure from pg_proc
--     where pronamespace = 'public'::regnamespace and (proname like 'market\_%' or proname like 'staff\_market\_%' or proname like '\_mkt\_%'));
--   drop table if exists public.market_events, public.market_blocks, public.market_reports, public.market_messages,
--     public.market_threads, public.market_photo_slots, public.market_listings, public.market_shops,
--     public.market_sellers, public.market_categories cascade;
--   delete from site_content where key like 'marketplace.%';
--   empty the bucket market in the dashboard, then: delete from storage.buckets where id = 'market';
--   re-run _staff_mod from 20261111180200_section_checks;
--   delete from supabase_migrations.schema_migrations where version in ('20261121300000', '20261121300100');
-- Idempotent: run twice, the second run changes nothing (a setting or a category staff changed is left as it is).
-- Apply 20261121300100_marketplace_staff next. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. _staff_mod: 'market' is People ────────────────────────────────────────────────────────────────────────────
create or replace function public._staff_mod(p_mod text, p_edit boolean default false)
 returns boolean
 language sql
 stable security definer
 set search_path = public
as $function$
  select exists(
    select 1 from staff s
     where s.user_id = auth.uid() and s.disabled_at is null
       and s.role is distinct from 'volunteer'
       and not (p_edit and s.role = 'owner')  -- the Owner role only looks
       and (s.role = 'admin'
            or (case when p_mod in ('customers', 'community', 'badgereq', 'market') then array['customers', 'community']
                     when p_mod in ('vendors', 'fnb') then array['vendors', 'fnb']
                     when p_mod in ('sessions', 'lockers', 'waitlist') then array['queue']
                     when p_mod in ('store', 'payments') then array['cashier']
                     else array[p_mod] end)
               && (case when p_edit then coalesce(s.modules_edit, s.modules_view, _staff_role_mods(s.role))
                        else coalesce(s.modules_view, _staff_role_mods(s.role)) end)))
$function$;
revoke all on function public._staff_mod(text, boolean) from public, anon;
grant execute on function public._staff_mod(text, boolean) to authenticated;

-- ── 2. Tables ────────────────────────────────────────────────────────────────────────────────────────────────────

-- The cities a listing or a shop can name (the website's SA_CITIES holds the same keys with their two names).
create or replace function public._mkt_cities() returns text[]
language sql immutable set search_path = public as $$
  select array['jeddah', 'riyadh', 'makkah', 'madinah', 'dammam', 'khobar', 'dhahran', 'taif', 'tabuk', 'buraydah',
               'unaizah', 'hail', 'abha', 'khamis-mushait', 'jazan', 'najran', 'al-bahah', 'bisha', 'yanbu', 'rabigh',
               'thuwal', 'kaec', 'jubail', 'al-ahsa', 'qatif', 'hafar-al-batin', 'al-kharj', 'arar', 'sakaka', 'alula',
               'other']
$$;
revoke all on function public._mkt_cities() from public, anon, authenticated;

create table if not exists public.market_categories (
  slug         text primary key check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 2 and 60),
  parent       text references public.market_categories(slug),
  name_en      text not null check (char_length(name_en) between 1 and 60),
  name_ar      text not null check (char_length(name_ar) between 1 and 60),
  sort         integer not null default 0,
  visible      boolean not null default true,
  tier         text not null default 'open' check (tier in ('open', 'new_only', 'declare')),
  needs_serial boolean not null default false,
  min_photos   smallint not null default 1 check (min_photos between 1 and 10),
  facts        jsonb not null default '[]'::jsonb
               check (jsonb_typeof(facts) = 'array'
                      and facts <@ '["brand", "model", "year", "frame_size", "wheel_size", "size", "for_whom"]'::jsonb),
  updated_at   timestamptz not null default now(),
  constraint market_categories_not_itself check (parent is null or parent <> slug)
);
create index if not exists market_categories_tree on public.market_categories (parent, sort);
alter table public.market_categories enable row level security;
revoke all on public.market_categories from public, anon, authenticated;
grant select on public.market_categories to anon, authenticated;
drop policy if exists "market categories read" on public.market_categories;
create policy "market categories read" on public.market_categories for select to anon, authenticated using (visible);
drop policy if exists "market categories staff read" on public.market_categories;
create policy "market categories staff read" on public.market_categories for select to authenticated
  using ((select public._staff_mod('market', false)));

-- The hourly copy from live to staging (the website's scripts/staging-sync.mjs) reads the visible categories with the
-- public key and writes staging with the service key (where the role exists), as it does the store's catalogue.
do $svc$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.market_categories to service_role;
  end if;
end $svc$;

create table if not exists public.market_sellers (
  customer_id      text primary key references public.customers(id) on delete cascade,
  terms_version    text check (terms_version is null or char_length(terms_version) <= 20),
  terms_at         timestamptz,
  status           text not null default 'ok' check (status in ('ok', 'suspended')),
  strikes          smallint not null default 0 check (strikes between 0 and 99),
  staff_note       text check (staff_note is null or char_length(staff_note) <= 1000),
  met_by_team      boolean not null default false,
  met_at           date,
  met_by           text check (met_by is null or char_length(met_by) <= 120),
  suspended_at     timestamptz,
  suspended_reason text check (suspended_reason is null or char_length(suspended_reason) <= 300),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.market_sellers enable row level security;
revoke all on public.market_sellers from public, anon, authenticated;

create table if not exists public.market_shops (
  id                bigint generated always as identity primary key,
  owner_id          text not null unique references public.customers(id) on delete cascade,
  slug              text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 40),
  name_en           text not null check (char_length(name_en) between 2 and 60),
  name_ar           text check (name_ar is null or char_length(name_ar) between 2 and 60),
  cr_no             text not null check (cr_no ~ '^[0-9]{10}$'),
  cr_activity       text not null check (char_length(cr_activity) between 2 and 120),
  vat_no            text check (vat_no is null or vat_no ~ '^3[0-9]{13}3$'),
  city              text not null check (city = any (public._mkt_cities())),
  address           text check (address is null or char_length(address) <= 200),
  map_url           text check (map_url is null or (char_length(map_url) <= 300
                      and map_url ~ '^https://(maps\.app\.goo\.gl|goo\.gl/maps|www\.google\.com/maps|maps\.google\.com)[/?][^[:space:]]*$')),
  phone             text check (phone is null or phone ~ '^966[0-9]{9}$'),
  whatsapp          text check (whatsapp is null or whatsapp ~ '^9665[0-9]{8}$'),
  about_en          text check (about_en is null or char_length(about_en) <= 600),
  about_ar          text check (about_ar is null or char_length(about_ar) <= 600),
  returns_en        text check (returns_en is null or char_length(returns_en) <= 600),
  returns_ar        text check (returns_ar is null or char_length(returns_ar) <= 600),
  sells             text check (sells is null or char_length(sells) <= 300),
  logo              text check (logo is null or logo ~ '^s[0-9]{1,12}/[0-9a-f]{32}\.(jpg|webp)$'),
  status            text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'suspended')),
  decided_by        text check (decided_by is null or char_length(decided_by) <= 120),
  decided_at        timestamptz,
  decision_note     text check (decision_note is null or char_length(decision_note) <= 300),
  approved_at       timestamptz,
  agreement_version text not null check (char_length(agreement_version) between 1 and 20),
  agreement_at      timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists market_shops_cr on public.market_shops (cr_no) where status <> 'rejected';
create index if not exists market_shops_list on public.market_shops (status, name_en);
alter table public.market_shops enable row level security;
revoke all on public.market_shops from public, anon, authenticated;

create table if not exists public.market_listings (
  id                     bigint generated always as identity primary key,
  seller_kind            text not null check (seller_kind in ('private', 'shop', 'company')),
  customer_id            text references public.customers(id) on delete cascade,
  shop_id                bigint references public.market_shops(id) on delete cascade,
  category               text references public.market_categories(slug),
  title                  text check (title is null or char_length(title) between 1 and 80),
  description            text check (description is null or char_length(description) <= 2000),
  condition              text check (condition is null or condition in ('new', 'excellent', 'good', 'fair', 'parts')),
  faults                 text check (faults is null or char_length(faults) <= 500),
  price                  integer check (price is null or price between 1 and 500000),
  negotiable             boolean not null default false,
  city                   text check (city is null or city = any (public._mkt_cities())),
  facts                  jsonb not null default '{}'::jsonb check (jsonb_typeof(facts) = 'object'),
  serial                 text check (serial is null or serial ~ '^[A-Z0-9-]{4,40}$'),
  declarations           jsonb not null default '{}'::jsonb check (jsonb_typeof(declarations) = 'object'),
  name_mode              text check (name_mode is null or name_mode in ('short', 'none')),
  display_name           text check (display_name is null or char_length(display_name) between 1 and 80),
  consent_at             timestamptz,
  photos                 jsonb not null default '[]'::jsonb check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 10),
  status                 text not null default 'draft'
                         check (status in ('draft', 'live', 'held', 'reserved', 'sold', 'expired', 'hidden', 'deleted')),
  hold_reason            text check (hold_reason is null or hold_reason in ('words', 'reports', 'serial', 'staff')),
  published_at           timestamptz,
  expires_at             timestamptz,
  sold_at                timestamptz,
  sold_price             integer check (sold_price is null or sold_price between 1 and 500000),
  commission_pct         numeric(4,2) check (commission_pct is null or commission_pct between 0 and 20),
  commission_due         integer check (commission_due is null or commission_due >= 0),
  commission_received    boolean not null default false,
  commission_received_at timestamptz,
  commission_received_by text check (commission_received_by is null or char_length(commission_received_by) <= 120),
  commission_note        text check (commission_note is null or char_length(commission_note) <= 300),
  checked_at             timestamptz,
  checked_by             text check (checked_by is null or char_length(checked_by) <= 120),
  hidden_reason          text check (hidden_reason is null or char_length(hidden_reason) <= 300),
  hidden_at              timestamptz,
  hidden_by              text check (hidden_by is null or char_length(hidden_by) <= 120),
  deleted_at             timestamptz,
  search_text            text not null default '',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint market_listings_kind check (
       (seller_kind = 'company' and customer_id is null and shop_id is null)
    or (seller_kind = 'private' and customer_id is not null and shop_id is null)
    or (seller_kind = 'shop' and customer_id is not null and shop_id is not null)),
  -- a listing on sale (or one that was) is complete: the pages read these as never null
  constraint market_listings_whole check (
    status in ('draft', 'deleted')
    or (category is not null and title is not null and description is not null and condition is not null
        and price is not null and city is not null and published_at is not null and expires_at is not null))
);
create index if not exists market_listings_new on public.market_listings (status, published_at desc, id desc);
create index if not exists market_listings_price on public.market_listings (status, price, id desc);
create index if not exists market_listings_customer on public.market_listings (customer_id, status);
create index if not exists market_listings_shop on public.market_listings (shop_id, status);
create index if not exists market_listings_category on public.market_listings (category, status);
create index if not exists market_listings_serial on public.market_listings (serial)
  where serial is not null and status in ('live', 'reserved', 'held');
create index if not exists market_listings_expiry on public.market_listings (expires_at) where status in ('live', 'reserved');
alter table public.market_listings enable row level security;
revoke all on public.market_listings from public, anon, authenticated;

create table if not exists public.market_photo_slots (
  name        text primary key check (name ~ '^[ls][0-9]{1,12}/[0-9a-f]{32}\.(jpg|webp)$'),
  -- the row outlives its account, its listing and its shop (set null), so the file it names can still be removed
  customer_id text references public.customers(id) on delete set null,
  listing_id  bigint references public.market_listings(id) on delete set null,
  shop_id     bigint references public.market_shops(id) on delete set null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  small_at    timestamptz,
  gone_at     timestamptz,
  purged_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists market_photo_slots_customer on public.market_photo_slots (customer_id, created_at);
create index if not exists market_photo_slots_listing on public.market_photo_slots (listing_id);
create index if not exists market_photo_slots_gone on public.market_photo_slots (gone_at) where gone_at is not null and purged_at is null;
alter table public.market_photo_slots enable row level security;
revoke all on public.market_photo_slots from public, anon, authenticated;

create table if not exists public.market_threads (
  id              bigint generated always as identity primary key,
  listing_id      bigint not null references public.market_listings(id) on delete cascade,
  buyer_id        text not null references public.customers(id) on delete cascade,
  seller_id       text not null references public.customers(id) on delete cascade,
  buyer_name_mode text not null check (buyer_name_mode in ('short', 'none')),
  buyer_name      text check (buyer_name is null or char_length(buyer_name) between 1 and 80),
  last_at         timestamptz not null default now(),
  last_side       text not null default 'buyer' check (last_side in ('buyer', 'seller')),
  last_body       text not null default '' check (char_length(last_body) <= 120),
  buyer_unread    integer not null default 0 check (buyer_unread >= 0),
  seller_unread   integer not null default 0 check (seller_unread >= 0),
  buyer_msgs      integer not null default 0 check (buyer_msgs >= 0),
  seller_msgs     integer not null default 0 check (seller_msgs >= 0),
  buyer_wa        text check (buyer_wa is null or buyer_wa ~ '^[0-9]{8,15}$'),
  seller_wa       text check (seller_wa is null or seller_wa ~ '^[0-9]{8,15}$'),
  buyer_wa_at     timestamptz,
  seller_wa_at    timestamptz,
  created_at      timestamptz not null default now(),
  constraint market_threads_two_people check (buyer_id <> seller_id),
  constraint market_threads_one unique (listing_id, buyer_id)
);
create index if not exists market_threads_buyer on public.market_threads (buyer_id, last_at desc);
create index if not exists market_threads_seller on public.market_threads (seller_id, last_at desc);
create index if not exists market_threads_last on public.market_threads (last_at);
alter table public.market_threads enable row level security;
revoke all on public.market_threads from public, anon, authenticated;

create table if not exists public.market_messages (
  id         bigint generated always as identity primary key,
  thread_id  bigint not null references public.market_threads(id) on delete cascade,
  side       text not null check (side in ('buyer', 'seller')),
  body       text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists market_messages_thread on public.market_messages (thread_id, id);
alter table public.market_messages enable row level security;
revoke all on public.market_messages from public, anon, authenticated;

create table if not exists public.market_reports (
  id            bigint generated always as identity primary key,
  target        text not null check (target in ('listing', 'thread')),
  listing_id    bigint references public.market_listings(id) on delete set null,
  thread_id     bigint references public.market_threads(id) on delete set null,
  reporter_id   text not null references public.customers(id) on delete cascade,
  reason        text not null check (reason in ('prohibited', 'counterfeit', 'stolen', 'misleading', 'scam', 'abuse', 'spam', 'other')),
  note          text check (note is null or char_length(note) <= 300),
  status        text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  decided_by    text check (decided_by is null or char_length(decided_by) <= 120),
  decided_at    timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 300),
  created_at    timestamptz not null default now()
);
create unique index if not exists market_reports_one_listing on public.market_reports (listing_id, reporter_id) where target = 'listing';
create unique index if not exists market_reports_one_thread on public.market_reports (thread_id, reporter_id) where target = 'thread';
create index if not exists market_reports_list on public.market_reports (status, created_at desc);
create index if not exists market_reports_thread on public.market_reports (thread_id) where thread_id is not null;
create index if not exists market_reports_reporter on public.market_reports (reporter_id, created_at);
alter table public.market_reports enable row level security;
revoke all on public.market_reports from public, anon, authenticated;

create table if not exists public.market_blocks (
  blocker_id text not null references public.customers(id) on delete cascade,
  blocked_id text not null references public.customers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint market_blocks_two_people check (blocker_id <> blocked_id)
);
create index if not exists market_blocks_blocked on public.market_blocks (blocked_id);
alter table public.market_blocks enable row level security;
revoke all on public.market_blocks from public, anon, authenticated;

-- The audit trail, and the record for a police request: plain numbers, no foreign keys, never deleted. It outlives
-- the listing, the thread and the account it is about.
create table if not exists public.market_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_kind  text not null check (actor_kind in ('system', 'staff', 'customer')),
  actor       text check (actor is null or char_length(actor) <= 120),
  subject     text not null check (subject in ('listing', 'seller', 'shop', 'thread', 'report', 'category')),
  listing_id  bigint,
  shop_id     bigint,
  thread_id   bigint,
  report_id   bigint,
  customer_id text,
  action      text not null check (action in (
                'publish', 'hold', 'release', 'hide', 'restore', 'check', 'uncheck', 'edit', 'reserve', 'unreserve', 'sold',
                'unsold', 'renew', 'expire', 'delete', 'report', 'report_set', 'thread_read', 'wa_share', 'block', 'unblock',
                'note', 'strike', 'unstrike', 'suspend', 'unsuspend', 'met', 'unmet', 'shop_apply', 'shop_approve',
                'shop_reject', 'shop_suspend', 'shop_restore', 'shop_edit', 'shop_contact', 'commission', 'category_save',
                'company_save')),
  detail      jsonb not null default '{}'::jsonb
);
create index if not exists market_events_listing on public.market_events (listing_id, at desc);
create index if not exists market_events_customer on public.market_events (customer_id, at desc);
create index if not exists market_events_shop on public.market_events (shop_id, at desc);
create index if not exists market_events_at on public.market_events (at desc);
alter table public.market_events enable row level security;
revoke all on public.market_events from public, anon, authenticated;

-- updated_at on every write (sellers, shops, categories).
create or replace function public._mkt_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;
revoke all on function public._mkt_touch() from public, anon, authenticated;
drop trigger if exists market_sellers_touch on public.market_sellers;
create trigger market_sellers_touch before update on public.market_sellers for each row execute function public._mkt_touch();
drop trigger if exists market_shops_touch on public.market_shops;
create trigger market_shops_touch before update on public.market_shops for each row execute function public._mkt_touch();

-- A category has two levels only: a sport (no parent) and its product types. A sport that has product types cannot
-- be given a parent, and a product type cannot be made a parent.
create or replace function public._mkt_category_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if new.parent is not null then
    if not exists (select 1 from market_categories p where p.slug = new.parent and p.parent is null) then
      raise exception 'BAD_INPUT' using errcode = '22023';
    end if;
    if exists (select 1 from market_categories k where k.parent = new.slug) then
      raise exception 'BAD_INPUT' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
revoke all on function public._mkt_category_guard() from public, anon, authenticated;
drop trigger if exists market_categories_guard on public.market_categories;
create trigger market_categories_guard before insert or update on public.market_categories
  for each row execute function public._mkt_category_guard();

-- A listing: updated_at on every write, and the text the search reads: each part (title, description, the facts'
-- brand and model, the category's two names) as _ask_norm keeps it (lower case, no punctuation or spaces, Arabic
-- letter forms as one), a space between the parts. _ask_norm is asked once for all of them, the parts held apart by
-- the unit separator (31), which it leaves alone and no text a customer sends can hold (_ask_text takes control
-- characters out): the same text as asking it part by part, at a fifth of the cost on every write.
create or replace function public._mkt_listing_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_en text; v_ar text;
begin
  new.updated_at := now();
  select c.name_en, c.name_ar into v_en, v_ar from market_categories c where c.slug = new.category;
  new.search_text := btrim(regexp_replace(
    replace(_ask_norm(concat_ws(chr(31), new.title, new.description, new.facts->>'brand', new.facts->>'model', v_en, v_ar)), chr(31), ' '),
    ' +', ' ', 'g'));
  return new;
end $$;
revoke all on function public._mkt_listing_stamp() from public, anon, authenticated;
drop trigger if exists market_listings_stamp on public.market_listings;
create trigger market_listings_stamp before insert or update on public.market_listings
  for each row execute function public._mkt_listing_stamp();

-- A listing's ROW removed (its account was closed: the delete cascades here): the whole row goes into the trail first.
create or replace function public._mkt_listing_removed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into market_events (actor_kind, subject, action, listing_id, shop_id, customer_id, detail)
  values ('system', 'listing', 'delete', old.id, old.shop_id, old.customer_id,
          (to_jsonb(old) - 'search_text') || jsonb_build_object('row_removed', true));
  return old;
end $$;
revoke all on function public._mkt_listing_removed() from public, anon, authenticated;
drop trigger if exists market_listings_removed on public.market_listings;
create trigger market_listings_removed before delete on public.market_listings
  for each row execute function public._mkt_listing_removed();

-- ── 3. Settings and the seed categories ──────────────────────────────────────────────────────────────────────────

-- The goods that may not be listed, as the words that hold a listing for staff (staff edit the list in Settings).
create or replace function public._mkt_words_default() returns jsonb
language sql immutable set search_path = public as $$
  select '["air rifle", "airgun", "air gun", "pellet gun", "bb gun", "rifle", "pistol", "handgun", "shotgun", "firearm",
           "ammunition", "ammo", "airsoft", "crossbow", "compound bow", "recurve bow", "longbow", "speargun", "spear gun",
           "knife", "knives", "dagger", "machete", "sword", "nunchaku", "nunchucks", "brass knuckles", "pepper spray",
           "taser", "stun gun", "drone", "steroid", "steroids", "creatine", "protein powder", "pre-workout", "fat burner",
           "counterfeit", "first copy", "master copy", "high copy",
           "بندقية", "مسدس", "سلاح", "أسلحة", "ذخيرة", "رصاص", "ايرسوفت", "قوس رماية", "نشاب", "سكين", "سكاكين", "خنجر",
           "ساطور", "سيف", "ننشاكو", "رذاذ الفلفل", "بخاخ فلفل", "صاعق", "تيزر", "درون", "طائرة بدون طيار", "منشطات",
           "ستيرويد", "كرياتين", "بروتين", "مكمل غذائي", "مكملات", "حارق دهون", "مقلد", "تقليد", "ماستر كوبي",
           "هاي كوبي"]'::jsonb
$$;
revoke all on function public._mkt_words_default() from public, anon, authenticated;

insert into public.site_content (key, value, updated_by) values
  ('marketplace.on', 'false'::jsonb, 'migration 20261121300000'),
  ('marketplace.commission_pct', '1'::jsonb, 'migration 20261121300000'),
  ('marketplace.commission_how', '{"en": "", "ar": ""}'::jsonb, 'migration 20261121300000'),
  ('marketplace.limits', '{"new_days": 14,
                           "new": {"live": 2, "price_max": 3000, "threads_day": 5, "wa_day": 0},
                           "established": {"live": 10, "threads_day": 20, "wa_day": 10},
                           "shop": {"live_first": 20, "first_days": 14, "live": 200},
                           "messages_day": 200}'::jsonb, 'migration 20261121300000'),
  ('marketplace.listing_days', '60'::jsonb, 'migration 20261121300000'),
  ('marketplace.blocked_words', public._mkt_words_default(), 'migration 20261121300000'),
  ('marketplace.auto_hold_reports', '3'::jsonb, 'migration 20261121300000'),
  ('marketplace.terms_version', '"2026-11-21"'::jsonb, 'migration 20261121300000')
on conflict (key) do nothing;

-- The sports (sort is the row's place times ten).
insert into public.market_categories (slug, parent, name_en, name_ar, sort)
select v.slug, null, v.name_en, v.name_ar, v.sort
  from (values
    (10, 'cycling', 'Cycling', 'الدراجات الهوائية'),
    (20, 'running', 'Running', 'الجري'),
    (30, 'swimming', 'Swimming', 'السباحة'),
    (40, 'triathlon', 'Triathlon', 'الترايثلون'),
    (50, 'fitness', 'Fitness and gym', 'اللياقة والنادي الرياضي'),
    (60, 'football', 'Football', 'كرة القدم'),
    (70, 'basketball', 'Basketball', 'كرة السلة'),
    (80, 'racket', 'Racket sports', 'رياضات المضرب'),
    (90, 'water', 'Water sports', 'الرياضات المائية'),
    (100, 'diving', 'Diving and snorkelling', 'الغوص والسنوركل'),
    (110, 'hiking', 'Hiking and camping', 'المشي الجبلي والتخييم'),
    (120, 'skating', 'Skating', 'التزلج'),
    (130, 'combat', 'Combat sports', 'الرياضات القتالية'),
    (140, 'golf', 'Golf', 'الغولف'),
    (150, 'other', 'Other sports', 'رياضات أخرى')
  ) as v(sort, slug, name_en, name_ar)
on conflict (slug) do nothing;

-- Cycling's product types.
insert into public.market_categories (slug, parent, name_en, name_ar, sort, tier, needs_serial, min_photos, facts)
select v.slug, 'cycling', v.name_en, v.name_ar, v.sort, v.tier, v.needs_serial, v.min_photos::smallint, v.facts::jsonb
  from (values
    (10, 'cycling-bike-road', 'Road bikes', 'دراجات الطريق', 'open', true, 3, '["brand", "model", "year", "frame_size", "wheel_size"]'),
    (20, 'cycling-bike-gravel', 'Gravel bikes', 'دراجات الغرافل', 'open', true, 3, '["brand", "model", "year", "frame_size", "wheel_size"]'),
    (30, 'cycling-bike-mountain', 'Mountain bikes', 'الدراجات الجبلية', 'open', true, 3, '["brand", "model", "year", "frame_size", "wheel_size"]'),
    (40, 'cycling-bike-tt', 'Time trial and triathlon bikes', 'دراجات سباق الزمن والترايثلون', 'open', true, 3, '["brand", "model", "year", "frame_size", "wheel_size"]'),
    (50, 'cycling-bike-city', 'City bikes', 'دراجات المدينة', 'open', true, 3, '["brand", "model", "year", "frame_size", "wheel_size"]'),
    (60, 'cycling-bike-kids', 'Kids'' bikes', 'دراجات الأطفال', 'open', true, 3, '["brand", "model", "year", "wheel_size"]'),
    (70, 'cycling-bike-folding', 'Folding bikes', 'الدراجات القابلة للطي', 'open', true, 3, '["brand", "model", "year", "wheel_size"]'),
    (80, 'cycling-bike-bmx', 'BMX bikes', 'دراجات BMX', 'open', true, 3, '["brand", "model", "year", "wheel_size"]'),
    (90, 'cycling-bike-electric', 'E-bikes', 'الدراجات الكهربائية', 'declare', true, 3, '["brand", "model", "year", "frame_size", "wheel_size"]'),
    (100, 'cycling-frames', 'Frames', 'الهياكل', 'open', true, 2, '["brand", "model", "year", "frame_size"]'),
    (110, 'cycling-wheels', 'Wheels and tyres', 'العجلات والإطارات', 'open', false, 2, '["brand", "model", "wheel_size"]'),
    (120, 'cycling-components', 'Components', 'القطع والمكونات', 'open', false, 1, '["brand", "model"]'),
    (130, 'cycling-helmets', 'Helmets', 'الخوذات', 'new_only', false, 1, '["brand", "model", "size"]'),
    (140, 'cycling-shoes', 'Shoes', 'الأحذية', 'open', false, 1, '["brand", "model", "size", "for_whom"]'),
    (150, 'cycling-clothing', 'Clothing', 'الملابس', 'open', false, 1, '["brand", "size", "for_whom"]'),
    (160, 'cycling-electronics', 'Electronics', 'الإلكترونيات', 'open', false, 1, '["brand", "model"]'),
    (170, 'cycling-accessories', 'Accessories', 'الإكسسوارات', 'open', false, 1, '["brand"]'),
    (180, 'cycling-escooters', 'E-scooters', 'السكوترات الكهربائية', 'declare', true, 3, '["brand", "model", "year"]')
  ) as v(sort, slug, name_en, name_ar, tier, needs_serial, min_photos, facts)
on conflict (slug) do nothing;

-- Every other sport but combat: the same six. Swimming's clothing is swimwear, and new only.
insert into public.market_categories (slug, parent, name_en, name_ar, sort, tier, needs_serial, min_photos, facts)
select s.slug || '-' || t.suffix, s.slug,
       case when s.slug = 'swimming' and t.suffix = 'clothing' then 'Swimwear' else t.name_en end,
       case when s.slug = 'swimming' and t.suffix = 'clothing' then 'ملابس السباحة' else t.name_ar end,
       t.sort,
       case when s.slug = 'swimming' and t.suffix = 'clothing' then 'new_only' else t.tier end,
       false, 1::smallint, t.facts::jsonb
  from unnest(array['running', 'swimming', 'triathlon', 'fitness', 'football', 'basketball', 'racket', 'water', 'diving',
                    'hiking', 'skating', 'golf', 'other']) as s(slug)
 cross join (values
    (10, 'equipment', 'Equipment', 'المعدات', 'open', '["brand", "model", "size"]'),
    (20, 'clothing', 'Clothing', 'الملابس', 'open', '["brand", "size", "for_whom"]'),
    (30, 'shoes', 'Shoes', 'الأحذية', 'open', '["brand", "model", "size", "for_whom"]'),
    (40, 'protective', 'Protective gear', 'معدات الحماية', 'new_only', '["brand", "size"]'),
    (50, 'electronics', 'Electronics', 'الإلكترونيات', 'open', '["brand", "model"]'),
    (60, 'accessories', 'Accessories', 'الإكسسوارات', 'open', '["brand"]')
  ) as t(sort, suffix, name_en, name_ar, tier, facts)
 where exists (select 1 from public.market_categories p where p.slug = s.slug and p.parent is null)
on conflict (slug) do nothing;

-- Combat sports: gloves and pads only.
insert into public.market_categories (slug, parent, name_en, name_ar, sort, tier, needs_serial, min_photos, facts)
select 'combat-gloves', 'combat', 'Gloves and pads', 'القفازات والواقيات', 10, 'open', false, 1::smallint, '["brand", "size"]'::jsonb
 where exists (select 1 from public.market_categories p where p.slug = 'combat' and p.parent is null)
on conflict (slug) do nothing;

-- ── 4. Storage: the bucket market ────────────────────────────────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('market', 'market', true, 800000, array['image/jpeg', 'image/webp'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- The public key may add a file only at a name the database issued (market_photo_slot), unexpired and not stored
-- yet: the check marks it stored, so each name holds one file once (no update policy, never an overwrite). The full
-- copy sets used_at, its small copy (<name>.w480.<ext>) small_at on the same row. Executable by the API roles because
-- a policy runs as the uploader; it answers false for any other bucket or name, and a name is 128 random bits.
create or replace function public._mkt_photo_take(p_bucket text, p_name text) returns boolean
language plpgsql volatile security definer set search_path = public as $$
begin
  if p_bucket is distinct from 'market'
     or coalesce(p_name, '') !~ '^[ls][0-9]{1,12}/[0-9a-f]{32}(\.w480)?\.(jpg|webp)$' then
    return false;
  end if;
  if p_name ~ '\.w480\.' then
    update market_photo_slots set small_at = now()
     where name = replace(p_name, '.w480.', '.') and small_at is null and gone_at is null and expires_at > now();
  else
    update market_photo_slots set used_at = now()
     where name = p_name and used_at is null and gone_at is null and expires_at > now();
  end if;
  return found;
end $$;
revoke all on function public._mkt_photo_take(text, text) from public;
grant execute on function public._mkt_photo_take(text, text) to anon, authenticated;

-- The public key may remove (and, as the Storage API reads what it removes, see) only a file the database already
-- let go of: the slot of that photo, the small copy's name read as its full one, has gone_at set.
create or replace function public._mkt_photo_gone(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from market_photo_slots s
                  where s.name = replace(coalesce(p_name, ''), '.w480.', '.') and s.gone_at is not null)
$$;
revoke all on function public._mkt_photo_gone(text) from public;
grant execute on function public._mkt_photo_gone(text) to anon, authenticated;

drop policy if exists "market photos add" on storage.objects;
create policy "market photos add" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'market' and name ~ '^[ls][0-9]{1,12}/[0-9a-f]{32}(\.w480)?\.(jpg|webp)$'
              and public._mkt_photo_take(bucket_id, name));
drop policy if exists "market photos let go" on storage.objects;
create policy "market photos let go" on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'market' and public._mkt_photo_gone(name));
drop policy if exists "market photos see gone" on storage.objects;
create policy "market photos see gone" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'market' and public._mkt_photo_gone(name));
-- Staff with the Marketplace right (change) may also remove a file there, and see what they remove.
drop policy if exists "market photos staff read" on storage.objects;
create policy "market photos staff read" on storage.objects
  for select to authenticated
  using (bucket_id = 'market' and (select public._staff_mod('market', true)));
drop policy if exists "market photos staff remove" on storage.objects;
create policy "market photos staff remove" on storage.objects
  for delete to authenticated
  using (bucket_id = 'market' and (select public._staff_mod('market', true)));

-- ── 5a. Helpers (none is executable by a client) ─────────────────────────────────────────────────────────────────

-- A setting as staff saved it; null when there is none.
create or replace function public._mkt_setting(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select c.value from site_content c where c.key = 'marketplace.' || p_key
$$;

-- A JSON number inside lo..hi (a whole one unless p_whole is false), else the default.
create or replace function public._mkt_num(v jsonb, p_default numeric, p_lo numeric, p_hi numeric, p_whole boolean default true)
returns numeric language plpgsql immutable set search_path = public as $$
declare n numeric;
begin
  if v is null or jsonb_typeof(v) <> 'number' then return p_default; end if;
  n := (v #>> '{}')::numeric;
  if n < p_lo or n > p_hi or (p_whole and n <> trunc(n)) then return p_default; end if;
  return n;
end $$;

-- The switch: anything but an explicit true is off.
create or replace function public._mkt_on() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(_mkt_setting('on') = 'true'::jsonb, false)
$$;
create or replace function public._mkt_pct() returns numeric
language sql stable security definer set search_path = public as $$
  select trim_scale(round(_mkt_num(_mkt_setting('commission_pct'), 1, 0, 20, false), 2))
$$;
create or replace function public._mkt_days() returns integer
language sql stable security definer set search_path = public as $$
  select _mkt_num(_mkt_setting('listing_days'), 60, 7, 180)::integer
$$;
create or replace function public._mkt_hold_n() returns integer
language sql stable security definer set search_path = public as $$
  select _mkt_num(_mkt_setting('auto_hold_reports'), 3, 2, 20)::integer
$$;
create or replace function public._mkt_terms() returns text
language plpgsql stable security definer set search_path = public as $$
declare v jsonb := _mkt_setting('terms_version');
begin
  if jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^[A-Za-z0-9._-]{1,20}$' then return v #>> '{}'; end if;
  return '2026-11-21';
end $$;

-- marketplace.limits, flat, each number its default when missing or out of its bounds (the website's mkSettings
-- reads the same bounds).
create or replace function public._mkt_lim() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare l jsonb := _mkt_setting('limits'); n jsonb; e jsonb; s jsonb;
begin
  if l is null or jsonb_typeof(l) <> 'object' then l := '{}'::jsonb; end if;
  n := case when jsonb_typeof(l->'new') = 'object' then l->'new' else '{}'::jsonb end;
  e := case when jsonb_typeof(l->'established') = 'object' then l->'established' else '{}'::jsonb end;
  s := case when jsonb_typeof(l->'shop') = 'object' then l->'shop' else '{}'::jsonb end;
  return jsonb_build_object(
    'new_days', _mkt_num(l->'new_days', 14, 0, 365),
    'new_live', _mkt_num(n->'live', 2, 0, 1000),
    'new_price_max', _mkt_num(n->'price_max', 3000, 1, 500000),
    'new_threads_day', _mkt_num(n->'threads_day', 5, 0, 1000),
    'new_wa_day', _mkt_num(n->'wa_day', 0, 0, 1000),
    'est_live', _mkt_num(e->'live', 10, 0, 1000),
    'est_threads_day', _mkt_num(e->'threads_day', 20, 0, 1000),
    'est_wa_day', _mkt_num(e->'wa_day', 10, 0, 1000),
    'shop_live_first', _mkt_num(s->'live_first', 20, 0, 10000),
    'shop_first_days', _mkt_num(s->'first_days', 14, 0, 365),
    'shop_live', _mkt_num(s->'live', 200, 0, 10000),
    'messages_day', _mkt_num(l->'messages_day', 200, 1, 10000));
end $$;

-- An account is NEW when none of these hold: older than new_days, a finished booking, a community member, met by
-- our team, an approved shop. customers.created_at is text (an ISO string): compared as text, never cast.
create or replace function public._mkt_established(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from customers c
                  where c.id = p_id and c.created_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                    and left(c.created_at, 10) <= to_char((now() at time zone 'utc')
                          - make_interval(days => (_mkt_lim()->>'new_days')::integer), 'YYYY-MM-DD'))
      or exists (select 1 from queue_entries e where e.customer_id = p_id and e.status = 'done')
      or coalesce(_member_active(p_id), false)
      or exists (select 1 from market_sellers s where s.customer_id = p_id and s.met_by_team)
      or exists (select 1 from market_shops h where h.owner_id = p_id and h.status = 'approved')
$$;

-- What the account may do today, and how much of it is used ("a day" is the last 24 hours).
create or replace function public._mkt_limits(p_id text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare lim jsonb := _mkt_lim(); est boolean := _mkt_established(p_id); h market_shops%rowtype; v_live integer;
begin
  select * into h from market_shops where owner_id = p_id and status = 'approved';
  if found then
    v_live := case when h.approved_at is not null
                        and h.approved_at > now() - make_interval(days => (lim->>'shop_first_days')::integer)
                   then (lim->>'shop_live_first')::integer else (lim->>'shop_live')::integer end;
  else
    v_live := case when est then (lim->>'est_live')::integer else (lim->>'new_live')::integer end;
  end if;
  return jsonb_build_object(
    'live', v_live,
    'live_used', (select count(*) from market_listings l where l.customer_id = p_id and l.status in ('live', 'reserved', 'held')),
    'drafts', 10,
    'drafts_used', (select count(*) from market_listings l where l.customer_id = p_id and l.status = 'draft'),
    'price_max', case when est then 500000 else (lim->>'new_price_max')::integer end,
    'threads_day', case when est then (lim->>'est_threads_day')::integer else (lim->>'new_threads_day')::integer end,
    'threads_used', (select count(*) from market_threads t where t.buyer_id = p_id and t.created_at > now() - interval '24 hours'),
    'wa_day', case when est then (lim->>'est_wa_day')::integer else (lim->>'new_wa_day')::integer end,
    'wa_used', (select count(*) from market_threads t
                 where (t.buyer_id = p_id and t.buyer_wa_at > now() - interval '24 hours')
                    or (t.seller_id = p_id and t.seller_wa_at > now() - interval '24 hours')),
    'messages_day', (lim->>'messages_day')::integer,
    'messages_used', (select count(*) from market_messages m join market_threads t on t.id = m.thread_id
                       where m.created_at > now() - interval '24 hours'
                         and ((m.side = 'buyer' and t.buyer_id = p_id) or (m.side = 'seller' and t.seller_id = p_id))));
end $$;

-- A phone number in a text: Arabic-Indic (1632-1641) and Persian (1776-1785) digits read as Western ones, then a
-- Saudi number with its country code, a Saudi mobile written 05 and eight more digits (a space, dot or dash allowed
-- before each), or any nine digits in a row. The website's mkHasPhone is the same test.
create or replace function public._mkt_has_phone(p text) returns boolean
language sql immutable set search_path = public as $$
  select t ~ '(\+|00)?966[ .-]?5([ .-]?[0-9]){8}' or t ~ '(^|[^0-9])05([ .-]?[0-9]){8}($|[^0-9])' or t ~ '[0-9]{9,}'
    from (select translate(coalesce(p, ''),
                 chr(1632) || chr(1633) || chr(1634) || chr(1635) || chr(1636) || chr(1637) || chr(1638) || chr(1639) || chr(1640) || chr(1641)
              || chr(1776) || chr(1777) || chr(1778) || chr(1779) || chr(1780) || chr(1781) || chr(1782) || chr(1783) || chr(1784) || chr(1785),
                 '01234567890123456789') as t) x
$$;

-- A number as WhatsApp takes it: digits, the country code first (a Saudi number written 05... or 5... gets 966);
-- null when what is left is not 8 to 15 digits.
create or replace function public._mkt_digits(p text) returns text
language plpgsql immutable set search_path = public as $$
declare d text := regexp_replace(translate(coalesce(p, ''),
                 chr(1632) || chr(1633) || chr(1634) || chr(1635) || chr(1636) || chr(1637) || chr(1638) || chr(1639) || chr(1640) || chr(1641)
              || chr(1776) || chr(1777) || chr(1778) || chr(1779) || chr(1780) || chr(1781) || chr(1782) || chr(1783) || chr(1784) || chr(1785),
                 '01234567890123456789'), '[^0-9]', '', 'g');
begin
  if d like '00%' then d := substr(d, 3); end if;
  if d ~ '^0[0-9]{9}$' then d := '966' || substr(d, 2);
  elsif d ~ '^5[0-9]{8}$' then d := '966' || d;
  end if;
  if char_length(d) between 8 and 15 then return d; end if;
  return null;
end $$;

-- The number "Share my WhatsApp" would show: the WhatsApp number when the account said it differs, else the phone.
create or replace function public._mkt_wa_of(p_id text) returns text
language sql stable security definer set search_path = public as $$
  select _mkt_digits(case when c.whatsapp_same is false then c.whatsapp else c.phone end) from customers c where c.id = p_id
$$;

-- A text as the blocked words are looked for in it: _ask_norm's reading (lower case, Arabic vowel marks and the
-- lengthening dash out, the forms of alef, the final ya and the ta marbuta as one) but with the words kept apart:
-- punctuation (the Arabic comma 1548, semicolon 1563 and question mark 1567 too) and runs of spaces as one space.
create or replace function public._mkt_norm(p text) returns text
language sql immutable set search_path = public as $$
  select btrim(regexp_replace(lower(
           translate(regexp_replace(coalesce(p, ''), '[' || chr(1611) || '-' || chr(1618) || chr(1600) || ']', '', 'g'),
                     chr(1571) || chr(1573) || chr(1570) || chr(1649) || chr(1609) || chr(1577),
                     repeat(chr(1575), 4) || chr(1610) || chr(1607))),
           '[[:punct:][:space:]' || chr(1548) || chr(1563) || chr(1567) || ']+', ' ', 'g'))
$$;

-- The first blocked word or phrase a text holds, as a whole word; null when none. An Arabic word is also read
-- without its article (1575 1604), so "the knife" is found by "knife".
create or replace function public._mkt_word_hit(p text) returns text
language plpgsql stable security definer set search_path = public as $$
declare w jsonb := _mkt_setting('blocked_words'); t text; t2 text; x text; k text;
begin
  if w is null or jsonb_typeof(w) <> 'array' then w := _mkt_words_default(); end if;
  t := ' ' || _mkt_norm(p) || ' ';
  if btrim(t) = '' then return null; end if;
  t2 := regexp_replace(t, ' ' || chr(1575) || chr(1604), ' ', 'g');
  for x in select e.val #>> '{}' from jsonb_array_elements(w) as e(val) where jsonb_typeof(e.val) = 'string' limit 300 loop
    k := _mkt_norm(left(x, 40));
    if k <> '' and (strpos(t, ' ' || k || ' ') > 0 or strpos(t2, ' ' || k || ' ') > 0) then return x; end if;
  end loop;
  return null;
end $$;

-- The same, over a listing's title, description, faults and facts.
create or replace function public._mkt_listing_hit(l public.market_listings) returns text
language sql stable security definer set search_path = public as $$
  select _mkt_word_hit(concat_ws(' . ', l.title, l.description, l.faults,
           (select string_agg(f.value #>> '{}', ' . ') from jsonb_each(coalesce(l.facts, '{}'::jsonb)) f)))
$$;

-- The start of every signed-in customer function: the session, the account's meter (600 calls in 10 minutes; per
-- account because every call reaches the database from the website's Worker), and, for a function that counts a
-- cap, the account's lock for the rest of the transaction.
create or replace function public._mkt_enter(p_id text, p_token text, p_lock boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'MKT_SIGNIN'; end if;
  if not _ip_gate('mkt:' || p_id, 600, interval '10 minutes') then raise exception 'MKT_BUSY'; end if;
  if p_lock then perform pg_advisory_xact_lock(hashtextextended('mkt:' || p_id, 0)); end if;
end $$;

-- 18 years by the birth date on file ("today" is Riyadh's); null when there is no usable date.
create or replace function public._mkt_adult(p_id text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare b text;
begin
  select c.birth_date into b from customers c where c.id = p_id;
  if b is null or not _ymd_ok(b) then return null; end if;
  return (b::date + interval '18 years')::date <= (now() at time zone 'Asia/Riyadh')::date;
end $$;
create or replace function public._mkt_need_adult(p_id text) returns void
language plpgsql stable security definer set search_path = public as $$
declare a boolean := _mkt_adult(p_id);
begin
  if a is null then raise exception 'MKT_BIRTH'; end if;
  if not a then raise exception 'MKT_ADULT'; end if;
end $$;

-- Staff suspended this account in the Marketplace.
create or replace function public._mkt_suspended(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from market_sellers s where s.customer_id = p_id and s.status = 'suspended')
$$;
-- The account may not sell: it is suspended, or its shop is (a suspended shop's owner does not list as a private
-- seller instead).
create or replace function public._mkt_sell_stopped(p_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select _mkt_suspended(p_id) or exists (select 1 from market_shops h where h.owner_id = p_id and h.status = 'suspended')
$$;
-- One of the two blocked the other.
create or replace function public._mkt_blocked(p_a text, p_b text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from market_blocks b
                  where (b.blocker_id = p_a and b.blocked_id = p_b) or (b.blocker_id = p_b and b.blocked_id = p_a))
$$;

-- One row of the trail.
create or replace function public._mkt_event(p_kind text, p_actor text, p_subject text, p_action text,
  p_listing bigint default null, p_shop bigint default null, p_thread bigint default null, p_report bigint default null,
  p_customer text default null, p_detail jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = public as $$
  insert into market_events (actor_kind, actor, subject, action, listing_id, shop_id, thread_id, report_id, customer_id, detail)
  values (p_kind, left(p_actor, 120), p_subject, p_action, p_listing, p_shop, p_thread, p_report, p_customer,
          coalesce(p_detail, '{}'::jsonb))
$$;
-- What mattered about a listing when something happened to it.
create or replace function public._mkt_snap(l public.market_listings) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object('title', l.title, 'price', l.price, 'serial', l.serial, 'status', l.status,
                            'seller_kind', l.seller_kind, 'seller_id', l.customer_id, 'seller_name', l.display_name,
                            'shop_id', l.shop_id)
$$;

-- One text value of a form: cleaned as _ask_text cleans (pictographs and direction marks out, runs of spaces as
-- one), null when empty, refused when longer than p_max or, with p_rules, when it holds a link or a phone number.
create or replace function public._mkt_text(v jsonb, p_key text, p_max integer, p_rules boolean) returns text
language plpgsql immutable set search_path = public as $$
declare s text;
begin
  if v is null or jsonb_typeof(v) = 'null' then return null; end if;
  if jsonb_typeof(v) <> 'string' then raise exception 'MKT_INPUT: %', p_key; end if;
  s := _ask_text(v #>> '{}');
  if s = '' then return null; end if;
  if char_length(s) > p_max then raise exception 'MKT_INPUT: %', p_key; end if;
  if p_rules then
    if _ask_has_link(s) then raise exception 'MKT_LINK: %', p_key; end if;
    if _mkt_has_phone(s) then raise exception 'MKT_PHONE: %', p_key; end if;
  end if;
  return s;
end $$;

-- A message's body: 1 to 1,000 characters after cleaning, no link, no phone number.
create or replace function public._mkt_body(p_body text) returns text
language plpgsql immutable set search_path = public as $$
declare s text := _ask_text(p_body);
begin
  if s = '' or char_length(s) > 1000 then raise exception 'MKT_INPUT: body'; end if;
  if _ask_has_link(s) then raise exception 'MKT_LINK'; end if;
  if _mkt_has_phone(s) then raise exception 'MKT_PHONE'; end if;
  return s;
end $$;

-- A listing's facts: only the keys the category asks for (p_allowed), each value of its shape; an empty value is
-- left out. year 1980 to next year; wheel_size and for_whom from their lists; the rest short texts.
create or replace function public._mkt_facts(p jsonb, p_allowed jsonb, p_rules boolean) returns jsonb
language plpgsql stable set search_path = public as $$
declare k text; v jsonb; s text; n numeric; o jsonb := '{}'::jsonb;
begin
  if p is null or jsonb_typeof(p) = 'null' then return o; end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'MKT_INPUT: facts'; end if;
  for k, v in select e.key, e.value from jsonb_each(p) e loop
    if not (p_allowed ? k) then raise exception 'MKT_INPUT: facts'; end if;
    if jsonb_typeof(v) = 'null' then continue; end if;
    if jsonb_typeof(v) = 'string' then s := _ask_text(v #>> '{}');
    elsif jsonb_typeof(v) = 'number' then s := v #>> '{}';
    else raise exception 'MKT_INPUT: facts';
    end if;
    if s = '' then continue; end if;
    if k = 'year' then
      if s !~ '^[0-9]{4}$' then raise exception 'MKT_INPUT: facts'; end if;
      n := s::numeric;
      if n < 1980 or n > extract(year from (now() at time zone 'Asia/Riyadh'))::integer + 1 then
        raise exception 'MKT_INPUT: facts';
      end if;
      o := o || jsonb_build_object(k, n::integer);
    else
      if k = 'wheel_size' then
        s := lower(s);
        if s not in ('12', '14', '16', '20', '24', '26', '27.5', '29', '650b', '700c', 'other') then raise exception 'MKT_INPUT: facts'; end if;
      elsif k = 'for_whom' then
        if s not in ('men', 'women', 'unisex', 'kids') then raise exception 'MKT_INPUT: facts'; end if;
      elsif char_length(s) > (case k when 'brand' then 40 when 'model' then 60 when 'frame_size' then 12 else 20 end) then
        raise exception 'MKT_INPUT: facts';
      elsif p_rules then
        if _ask_has_link(s) then raise exception 'MKT_LINK: facts'; end if;
        if _mkt_has_phone(s) then raise exception 'MKT_PHONE: facts'; end if;
      end if;
      o := o || jsonb_build_object(k, s);
    end if;
  end loop;
  return o;
end $$;

-- A listing's form values laid over the row: a key left out stays as it is, null clears it. p_staff (MicroMobility's
-- own listing): links and phone numbers are not looked for. Photos are each caller's own business.
create or replace function public._mkt_apply(l public.market_listings, p jsonb, p_staff boolean) returns public.market_listings
language plpgsql stable security definer set search_path = public as $$
declare v jsonb; s text; n numeric; v_allowed jsonb; v_cat_changed boolean := false; d jsonb; k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return l; end if;
  if p ? 'category' then
    v := p->'category';
    if jsonb_typeof(v) = 'null' then
      v_cat_changed := l.category is not null; l.category := null;
    elsif jsonb_typeof(v) = 'string' and exists (
            select 1 from market_categories c join market_categories sp on sp.slug = c.parent
             where c.slug = (v #>> '{}') and c.visible and sp.visible) then
      v_cat_changed := l.category is distinct from (v #>> '{}'); l.category := v #>> '{}';
    else
      raise exception 'MKT_INPUT: category';
    end if;
  end if;
  if p ? 'title' then l.title := _mkt_text(p->'title', 'title', 80, not p_staff); end if;
  if p ? 'description' then l.description := _mkt_text(p->'description', 'description', 2000, not p_staff); end if;
  if p ? 'faults' then l.faults := _mkt_text(p->'faults', 'faults', 500, not p_staff); end if;
  if p ? 'condition' then
    v := p->'condition';
    if jsonb_typeof(v) = 'null' then l.condition := null;
    elsif jsonb_typeof(v) = 'string' and (v #>> '{}') in ('new', 'excellent', 'good', 'fair', 'parts') then l.condition := v #>> '{}';
    else raise exception 'MKT_INPUT: condition';
    end if;
  end if;
  if p ? 'price' then
    v := p->'price';
    if jsonb_typeof(v) = 'null' then l.price := null;
    else
      n := _mkt_num(v, null, 1, 500000);
      if n is null then raise exception 'MKT_INPUT: price'; end if;
      l.price := n::integer;
    end if;
  end if;
  if p ? 'negotiable' then
    v := p->'negotiable';
    if jsonb_typeof(v) = 'null' then l.negotiable := false;
    elsif jsonb_typeof(v) = 'boolean' then l.negotiable := (v #>> '{}')::boolean;
    else raise exception 'MKT_INPUT: negotiable';
    end if;
  end if;
  if p ? 'city' then
    v := p->'city';
    if jsonb_typeof(v) = 'null' then l.city := null;
    elsif jsonb_typeof(v) = 'string' and (v #>> '{}') = any (_mkt_cities()) then l.city := v #>> '{}';
    else raise exception 'MKT_INPUT: city';
    end if;
  end if;
  if p ? 'serial' then
    v := p->'serial';
    if jsonb_typeof(v) = 'null' then l.serial := null;
    elsif jsonb_typeof(v) = 'string' then
      s := upper(regexp_replace(_ask_text(v #>> '{}'), '[[:space:]]+', '', 'g'));
      if s = '' then l.serial := null;
      elsif s ~ '^[A-Z0-9-]{4,40}$' then l.serial := s;
      else raise exception 'MKT_INPUT: serial';
      end if;
    else raise exception 'MKT_INPUT: serial';
    end if;
  end if;
  if p ? 'declarations' then
    v := p->'declarations';
    if jsonb_typeof(v) = 'null' then l.declarations := '{}'::jsonb;
    elsif jsonb_typeof(v) = 'object' then
      d := '{}'::jsonb;
      for k, v in select e.key, e.value from jsonb_each(p->'declarations') e loop
        if k not in ('complete', 'unmodified', 'speed_25', 'charger') or jsonb_typeof(v) not in ('boolean', 'null') then
          raise exception 'MKT_INPUT: declarations';
        end if;
        if v = 'true'::jsonb then d := d || jsonb_build_object(k, true); end if;
      end loop;
      l.declarations := d;
    else raise exception 'MKT_INPUT: declarations';
    end if;
  end if;
  -- the facts the category asks for (any of the seven while there is no category yet)
  select c.facts into v_allowed from market_categories c where c.slug = l.category;
  v_allowed := coalesce(v_allowed, '["brand", "model", "year", "frame_size", "wheel_size", "size", "for_whom"]'::jsonb);
  if p ? 'facts' then
    l.facts := _mkt_facts(p->'facts', v_allowed, not p_staff);
  elsif v_cat_changed then
    -- the category changed and the form sent no facts: the ones the new category does not ask for are dropped
    l.facts := coalesce((select jsonb_object_agg(e.key, e.value) from jsonb_each(l.facts) e where v_allowed ? e.key), '{}'::jsonb);
  end if;
  return l;
end $$;

-- Is the listing whole enough to be on sale: the publish rules 6 to 9, each with its code.
create or replace function public._mkt_check(l public.market_listings) returns void
language plpgsql stable security definer set search_path = public as $$
declare c market_categories%rowtype;
begin
  select x.* into c from market_categories x join market_categories sp on sp.slug = x.parent
   where x.slug = l.category and x.visible and sp.visible;
  if not found then raise exception 'MKT_INPUT: category'; end if;
  if l.title is null or char_length(l.title) not between 3 and 80 then raise exception 'MKT_INPUT: title'; end if;
  if l.description is null or char_length(l.description) not between 10 and 2000 then raise exception 'MKT_INPUT: description'; end if;
  if l.condition is null then raise exception 'MKT_INPUT: condition'; end if;
  if l.price is null then raise exception 'MKT_INPUT: price'; end if;
  if l.city is null then raise exception 'MKT_INPUT: city'; end if;
  if exists (select 1 from jsonb_object_keys(l.facts) k where not (c.facts ? k)) then raise exception 'MKT_INPUT: facts'; end if;
  if c.tier = 'new_only' and l.condition <> 'new' then raise exception 'MKT_NEW_ONLY'; end if;
  if c.tier = 'declare'
     and not (l.declarations @> '{"complete": true, "unmodified": true, "speed_25": true, "charger": true}'::jsonb) then
    raise exception 'MKT_DECLARE';
  end if;
  if c.needs_serial and l.serial is null then raise exception 'MKT_SERIAL'; end if;
  if jsonb_array_length(l.photos) < c.min_photos then raise exception 'MKT_PHOTOS'; end if;
end $$;

-- The row written: a new one when it has no id yet, else the columns a form or a move changes.
create or replace function public._mkt_store(l public.market_listings) returns public.market_listings
language plpgsql security definer set search_path = public as $$
declare o market_listings%rowtype;
begin
  if l.id is null then
    insert into market_listings (seller_kind, customer_id, shop_id, category, title, description, condition, faults, price,
                                 negotiable, city, facts, serial, declarations, photos, status)
    values (l.seller_kind, l.customer_id, l.shop_id, l.category, l.title, l.description, l.condition, l.faults, l.price,
            coalesce(l.negotiable, false), l.city, coalesce(l.facts, '{}'::jsonb), l.serial,
            coalesce(l.declarations, '{}'::jsonb), coalesce(l.photos, '[]'::jsonb), 'draft')
    returning * into o;
  else
    update market_listings m
       set seller_kind = l.seller_kind, shop_id = l.shop_id, category = l.category, title = l.title,
           description = l.description, condition = l.condition, faults = l.faults, price = l.price,
           negotiable = l.negotiable, city = l.city, facts = l.facts, serial = l.serial, declarations = l.declarations,
           photos = l.photos, name_mode = l.name_mode, display_name = l.display_name, consent_at = l.consent_at,
           status = l.status, hold_reason = l.hold_reason, published_at = l.published_at, expires_at = l.expires_at,
           sold_at = l.sold_at, sold_price = l.sold_price, commission_pct = l.commission_pct,
           commission_due = l.commission_due, deleted_at = l.deleted_at
     where m.id = l.id
    returning * into o;
  end if;
  return o;
end $$;

-- The serial is on another listing that is on sale or held.
create or replace function public._mkt_serial_taken(l public.market_listings) returns boolean
language sql stable security definer set search_path = public as $$
  select l.serial is not null
     and exists (select 1 from market_listings o
                  where o.serial = l.serial and o.id is distinct from l.id and o.status in ('live', 'reserved', 'held'))
$$;

-- A shop as a card, a listing or a thread names it.
create or replace function public._mkt_shop_ref(p_shop bigint) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('slug', h.slug, 'name_en', h.name_en, 'name_ar', h.name_ar, 'logo', h.logo)
    from market_shops h where h.id = p_shop
$$;

-- Everything another person is told about a listing's seller: the kind, the name the seller chose for this listing
-- (null: "Private seller"), a shop's trade name. Never an id, a phone, an email, a photo or a date.
create or replace function public._mkt_seller_view(l public.market_listings) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('kind', l.seller_kind,
                            'name', case when l.seller_kind = 'private' then l.display_name end,
                            'shop', case when l.seller_kind = 'shop' then _mkt_shop_ref(l.shop_id) end)
$$;

-- A listing on the browse grid.
create or replace function public._mkt_card(l public.market_listings) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', l.id, 'title', l.title, 'price', l.price, 'negotiable', l.negotiable, 'condition', l.condition, 'city', l.city,
    'category', l.category, 'sport', (select c.parent from market_categories c where c.slug = l.category),
    'size', coalesce(l.facts->>'frame_size', l.facts->>'size'), 'photo', l.photos->>0, 'status', l.status,
    'seller_kind', l.seller_kind, 'shop', case when l.seller_kind = 'shop' then _mkt_shop_ref(l.shop_id) end,
    'checked', l.checked_at is not null, 'published_at', l.published_at)
$$;

-- "renew" would be taken now: a listing on sale in its last 7 days, or an expired one, of a seller who may sell.
-- (Whether the account is at its limit is not part of it: the tap answers MKT_LIMIT, so the seller is told why.)
create or replace function public._mkt_renewable(l public.market_listings) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((l.status = 'expired' or (l.status in ('live', 'reserved') and l.expires_at <= now() + interval '7 days'))
                  and (l.customer_id is null or not _mkt_sell_stopped(l.customer_id)), false)
$$;

-- One of the seller's own listings, whole.
create or replace function public._mkt_mine(l public.market_listings) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', l.id, 'status', l.status, 'seller_kind', l.seller_kind, 'category', l.category,
    'sport', (select c.parent from market_categories c where c.slug = l.category),
    'title', l.title, 'description', l.description, 'condition', l.condition, 'faults', l.faults, 'price', l.price,
    'negotiable', l.negotiable, 'city', l.city, 'facts', l.facts, 'serial', l.serial, 'declarations', l.declarations,
    'photos', l.photos, 'name_mode', l.name_mode, 'display_name', l.display_name,
    'hold_reason', case when l.status = 'held' then l.hold_reason end,
    'hidden_reason', case when l.status = 'hidden' then l.hidden_reason end,
    'published_at', l.published_at, 'expires_at', l.expires_at, 'sold_at', l.sold_at, 'sold_price', l.sold_price,
    'commission_pct', trim_scale(l.commission_pct), 'commission_due', l.commission_due, 'commission_received', l.commission_received,
    'checked_at', l.checked_at, 'renewable', _mkt_renewable(l),
    'threads', (select count(*) from market_threads t where t.listing_id = l.id),
    'unread', (select coalesce(sum(t.seller_unread), 0) from market_threads t
                where t.listing_id = l.id
                  and not exists (select 1 from market_blocks b where b.blocker_id = t.seller_id and b.blocked_id = t.buyer_id)),
    'created_at', l.created_at, 'updated_at', l.updated_at)
$$;

-- A shop's address word from its English name: lower case, a dash for anything else, 3 to 40 characters, a number
-- added when taken.
create or replace function public._mkt_slug(p_name text, p_self bigint default null) returns text
language plpgsql stable security definer set search_path = public as $$
declare base text := btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'), '-'); s text; i integer := 1;
begin
  base := btrim(left(base, 34), '-');
  if char_length(base) < 3 then base := btrim('shop-' || base, '-'); end if;
  s := base;
  while exists (select 1 from market_shops h where h.slug = s and h.id is distinct from p_self) loop
    i := i + 1;
    s := base || '-' || i;
  end loop;
  return s;
end $$;

-- A shop's form values, cleaned: the keys p holds, each of its shape (null clears). p_rules: links and phone
-- numbers are refused in the names, the two "about", the two return terms and "what it sells". The logo is the
-- caller's business.
create or replace function public._mkt_shop_vals(p jsonb, p_rules boolean) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o jsonb := '{}'::jsonb; s text; k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return o; end if;
  foreach k in array array['name_en', 'name_ar', 'cr_activity', 'address', 'about_en', 'about_ar', 'returns_en', 'returns_ar', 'sells'] loop
    if p ? k then
      s := _mkt_text(p->k, k, case k when 'name_en' then 60 when 'name_ar' then 60 when 'cr_activity' then 120
                                     when 'address' then 200 when 'sells' then 300 else 600 end,
                     p_rules and k not in ('cr_activity', 'address'));
      if s is not null and k in ('name_en', 'name_ar', 'cr_activity') and char_length(s) < 2 then
        raise exception 'MKT_INPUT: %', k;
      end if;
      o := o || jsonb_build_object(k, s);
    end if;
  end loop;
  foreach k in array array['cr_no', 'vat_no'] loop
    if p ? k then
      if jsonb_typeof(p->k) not in ('string', 'number', 'null') then raise exception 'MKT_INPUT: %', k; end if;
      s := nullif(regexp_replace(_ask_text(p->>k), '[[:space:]]+', '', 'g'), '');
      if s is not null and s !~ (case k when 'cr_no' then '^[0-9]{10}$' else '^3[0-9]{13}3$' end) then
        raise exception 'MKT_INPUT: %', k;
      end if;
      o := o || jsonb_build_object(k, s);
    end if;
  end loop;
  if p ? 'city' then
    if jsonb_typeof(p->'city') = 'null' then o := o || jsonb_build_object('city', null);
    elsif jsonb_typeof(p->'city') = 'string' and (p->>'city') = any (_mkt_cities()) then o := o || jsonb_build_object('city', p->>'city');
    else raise exception 'MKT_INPUT: city';
    end if;
  end if;
  if p ? 'map_url' then
    if jsonb_typeof(p->'map_url') not in ('string', 'null') then raise exception 'MKT_INPUT: map_url'; end if;
    s := nullif(btrim(coalesce(p->>'map_url', '')), '');
    if s is not null and (char_length(s) > 300
         or s !~ '^https://(maps\.app\.goo\.gl|goo\.gl/maps|www\.google\.com/maps|maps\.google\.com)[/?][^[:space:]]*$') then
      raise exception 'MKT_INPUT: map_url';
    end if;
    o := o || jsonb_build_object('map_url', s);
  end if;
  foreach k in array array['phone', 'whatsapp'] loop
    if p ? k then
      if jsonb_typeof(p->k) not in ('string', 'number', 'null') then raise exception 'MKT_INPUT: %', k; end if;
      s := nullif(btrim(coalesce(p->>k, '')), '');
      if s is not null then
        s := _mkt_digits(s);
        if s is null or s !~ (case k when 'phone' then '^966[0-9]{9}$' else '^9665[0-9]{8}$' end) then
          raise exception 'MKT_INPUT: %', k;
        end if;
      end if;
      o := o || jsonb_build_object(k, s);
    end if;
  end loop;
  return o;
end $$;

-- A shop's listings that count toward its limit, and the limit (20 for its first 14 days, then 200, by the setting).
create or replace function public._mkt_shop_mine(h public.market_shops) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', h.id, 'slug', h.slug, 'status', h.status, 'name_en', h.name_en, 'name_ar', h.name_ar, 'cr_no', h.cr_no,
    'cr_activity', h.cr_activity, 'vat_no', h.vat_no, 'city', h.city, 'address', h.address, 'map_url', h.map_url,
    'phone', h.phone, 'whatsapp', h.whatsapp, 'about_en', h.about_en, 'about_ar', h.about_ar,
    'returns_en', h.returns_en, 'returns_ar', h.returns_ar, 'sells', h.sells, 'logo', h.logo,
    'decision_note', h.decision_note, 'approved_at', h.approved_at, 'agreement_version', h.agreement_version,
    'live', (select count(*) from market_listings l where l.shop_id = h.id and l.status in ('live', 'reserved', 'held')),
    'live_cap', case when h.approved_at is null
                          or h.approved_at > now() - make_interval(days => (_mkt_lim()->>'shop_first_days')::integer)
                     then (_mkt_lim()->>'shop_live_first')::integer else (_mkt_lim()->>'shop_live')::integer end,
    'created_at', h.created_at, 'updated_at', h.updated_at)
$$;

-- ── 5b. Selling ──────────────────────────────────────────────────────────────────────────────────────────────────

-- The account's threads with something unread, leaving out those with a person the account blocked.
create or replace function public._mkt_unread(p_id text) returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer from market_threads t
   where ((t.buyer_id = p_id and t.buyer_unread > 0) or (t.seller_id = p_id and t.seller_unread > 0))
     and not exists (select 1 from market_blocks b
                      where b.blocker_id = p_id
                        and b.blocked_id = case when t.buyer_id = p_id then t.seller_id else t.buyer_id end)
$$;

-- What the account may do, for the forms.
create or replace function public.market_me(p_id text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_name text; s market_sellers%rowtype; h market_shops%rowtype; v_terms text := _mkt_terms();
begin
  perform _mkt_enter(p_id, p_token);
  select c.name into v_name from customers c where c.id = p_id;
  select * into s from market_sellers where customer_id = p_id;
  select * into h from market_shops where owner_id = p_id;
  return jsonb_build_object(
    'on', _mkt_on(),
    'adult', _mkt_adult(p_id),
    'established', _mkt_established(p_id),
    'seller', jsonb_build_object('status', coalesce(s.status, 'ok'), 'terms_ok', coalesce(s.terms_version = v_terms, false)),
    'terms_version', v_terms,
    'names', jsonb_build_object('short', _tm_short(_ask_text(v_name))),
    'has_whatsapp', _mkt_wa_of(p_id) is not null,
    'shop', case when h.id is not null then jsonb_build_object('id', h.id, 'slug', h.slug, 'status', h.status,
                                                               'name_en', h.name_en, 'name_ar', h.name_ar) end,
    'limits', _mkt_limits(p_id),
    'unread', _mkt_unread(p_id),
    'commission_pct', _mkt_pct(),
    'listing_days', _mkt_days());
end $$;

-- A new draft (p_listing null) or a change to one of the caller's own listings.
create or replace function public.market_listing_save(p_id text, p_token text, p_listing bigint, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l market_listings%rowtype; o market_listings%rowtype; h market_shops%rowtype; v_ph jsonb; v_names text[];
        v_drop text[]; v_purge integer := 0; v_hit text; v_hold text; x text;
begin
  perform _mkt_enter(p_id, p_token, true);
  if _mkt_sell_stopped(p_id) then raise exception 'MKT_SUSPENDED'; end if;
  perform _mkt_need_adult(p_id);
  if p is null or jsonb_typeof(p) <> 'object' then p := '{}'::jsonb; end if;
  if p_listing is null then
    if (select count(*) from market_listings m where m.customer_id = p_id and m.status = 'draft') >= 10 then
      raise exception 'MKT_LIMIT: drafts';
    end if;
    select * into h from market_shops where owner_id = p_id and status = 'approved';
    l.seller_kind := case when h.id is not null then 'shop' else 'private' end;
    l.shop_id := h.id; l.customer_id := p_id; l.status := 'draft'; l.negotiable := false;
    l.facts := '{}'::jsonb; l.declarations := '{}'::jsonb; l.photos := '[]'::jsonb;
  else
    select * into l from market_listings where id = p_listing and customer_id = p_id for update;
    if not found then raise exception 'MKT_GONE'; end if;
    if l.status not in ('draft', 'live', 'reserved', 'expired') then raise exception 'MKT_STATE'; end if;
  end if;
  o := l;
  l := _mkt_apply(l, p, false);

  -- photos: each name is already on this listing, or a stored, unreleased slot of this caller for this listing
  if p ? 'photos' then
    v_ph := p->'photos';
    if jsonb_typeof(v_ph) = 'null' then v_ph := '[]'::jsonb; end if;
    if jsonb_typeof(v_ph) <> 'array' or jsonb_array_length(v_ph) > 10
       or exists (select 1 from jsonb_array_elements(v_ph) as e(val) where jsonb_typeof(e.val) <> 'string') then
      raise exception 'MKT_PHOTOS';
    end if;
    select coalesce(array_agg(z.n order by z.ord), '{}') into v_names
      from (select e.val #>> '{}' as n, min(e.ord) as ord
              from jsonb_array_elements(v_ph) with ordinality as e(val, ord) group by 1) z;
    foreach x in array v_names loop
      if not (o.photos ? x)
         and not exists (select 1 from market_photo_slots s
                          where s.name = x and s.customer_id = p_id and s.listing_id = l.id
                            and s.used_at is not null and s.gone_at is null) then
        raise exception 'MKT_PHOTOS';
      end if;
    end loop;
    select coalesce(array_agg(e.n), '{}') into v_drop from jsonb_array_elements_text(o.photos) as e(n) where e.n <> all (v_names);
    l.photos := to_jsonb(v_names);
  end if;

  -- a listing that is or was on sale stays whole, and a new account's keeps under its price ceiling
  if l.status <> 'draft' then
    perform _mkt_check(l);
    if l.price > (_mkt_limits(p_id)->>'price_max')::integer then raise exception 'MKT_PRICE'; end if;
  end if;
  -- on sale: its words are read again, and a changed frame number is looked for on the other listings
  if l.status in ('live', 'reserved') then
    v_hit := _mkt_listing_hit(l);
    if v_hit is not null then v_hold := 'words';
    elsif l.serial is distinct from o.serial and _mkt_serial_taken(l) then v_hold := 'serial';
    end if;
    if v_hold is not null then l.status := 'held'; l.hold_reason := v_hold; end if;
  end if;

  l := _mkt_store(l);
  if array_length(v_drop, 1) > 0 then
    update market_photo_slots s set gone_at = now() where s.name = any (v_drop) and s.gone_at is null;
    get diagnostics v_purge = row_count;
  end if;
  if o.status is distinct from 'draft' and o.id is not null then
    perform _mkt_event('customer', p_id, 'listing', 'edit', l.id, l.shop_id, null, null, p_id,
      jsonb_build_object('before', coalesce((select jsonb_object_agg(k, to_jsonb(o) -> k) from jsonb_object_keys(p) k
                                              where k in ('category', 'title', 'description', 'condition', 'faults', 'price',
                                                          'negotiable', 'city', 'facts', 'serial', 'declarations', 'photos')), '{}'::jsonb)));
  end if;
  if v_hold is not null then
    perform _mkt_event('system', null, 'listing', 'hold', l.id, l.shop_id, null, null, p_id,
                       _mkt_snap(l) || jsonb_build_object('reason', v_hold, 'word', v_hit, 'on', 'edit'));
  end if;
  return jsonb_build_object('listing', _mkt_mine(l), 'purge', v_purge);
end $$;

-- One photo's upload: the name of its full copy and of its small copy, each good once, for ten minutes.
create or replace function public.market_photo_slot(p_id text, p_token text, p_for text, p_ref bigint, p_ext text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l market_listings%rowtype; h market_shops%rowtype; v_name text; v_until timestamptz := now() + interval '10 minutes';
begin
  perform _mkt_enter(p_id, p_token, true);
  if p_for is null or p_for not in ('listing', 'shop') then raise exception 'MKT_INPUT: for'; end if;
  if p_ext is null or p_ext not in ('jpg', 'webp') then raise exception 'MKT_INPUT: ext'; end if;
  if p_for = 'listing' then
    select * into l from market_listings where id = p_ref and customer_id = p_id;
    if not found then raise exception 'MKT_GONE'; end if;
    if l.status not in ('draft', 'live', 'reserved', 'expired') then raise exception 'MKT_STATE'; end if;
    if _mkt_sell_stopped(p_id) then raise exception 'MKT_SUSPENDED'; end if;
    v_name := 'l' || l.id;
  else
    select * into h from market_shops where owner_id = p_id;
    if not found then raise exception 'MKT_GONE'; end if;
    if h.status = 'suspended' or _mkt_suspended(p_id) then raise exception 'MKT_SUSPENDED'; end if;
    v_name := 's' || h.id;
  end if;
  if (select count(*) from market_photo_slots s where s.customer_id = p_id and s.created_at > now() - interval '24 hours') >= 60 then
    raise exception 'MKT_LIMIT: photos';
  end if;
  v_name := v_name || '/' || replace(gen_random_uuid()::text, '-', '') || '.' || p_ext;
  insert into market_photo_slots (name, customer_id, listing_id, shop_id, expires_at)
  values (v_name, p_id, l.id, h.id, v_until);
  return jsonb_build_object('name', v_name, 'small', regexp_replace(v_name, '\.(jpg|webp)$', '.w480.\1'), 'expires_at', v_until);
end $$;

-- A draft goes on sale at once (or is held for staff: its words, or its frame number on another listing).
create or replace function public.market_listing_publish(p_id text, p_token text, p_listing bigint, p_name_mode text,
                                                         p_consent boolean, p_terms text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l market_listings%rowtype; h market_shops%rowtype; v_terms text := _mkt_terms(); v_name text; lim jsonb;
        v_hit text; v_hold text;
begin
  perform _mkt_enter(p_id, p_token, true);
  if _mkt_sell_stopped(p_id) then raise exception 'MKT_SUSPENDED'; end if;
  perform _mkt_need_adult(p_id);
  select * into l from market_listings where id = p_listing and customer_id = p_id for update;
  if not found then raise exception 'MKT_GONE'; end if;
  if l.status <> 'draft' then raise exception 'MKT_STATE'; end if;
  if p_consent is not true then raise exception 'MKT_CONSENT'; end if;
  -- the rules: accepted now when the page sent the version it showed, and that version is the current one
  if p_terms is not null and p_terms = v_terms then
    insert into market_sellers (customer_id, terms_version, terms_at) values (p_id, v_terms, now())
    on conflict (customer_id) do update set terms_version = excluded.terms_version, terms_at = excluded.terms_at
      where market_sellers.terms_version is distinct from excluded.terms_version;
  end if;
  if not exists (select 1 from market_sellers s where s.customer_id = p_id and s.terms_version = v_terms) then
    raise exception 'MKT_TERMS';
  end if;
  if p_name_mode is null or p_name_mode not in ('short', 'none') then raise exception 'MKT_INPUT: name_mode'; end if;
  -- an account with an approved shop lists as that shop, and a shop's listing names the shop, not a person
  select * into h from market_shops where owner_id = p_id and status = 'approved';
  if found then
    l.seller_kind := 'shop'; l.shop_id := h.id; l.name_mode := 'none'; l.display_name := null;
  else
    l.seller_kind := 'private'; l.shop_id := null; l.name_mode := p_name_mode; l.display_name := null;
    if p_name_mode = 'short' then
      select _tm_short(_ask_text(c.name)) into v_name from customers c where c.id = p_id;
      if v_name is null then raise exception 'MKT_INPUT: name_mode'; end if;
      l.display_name := v_name;
    end if;
  end if;
  perform _mkt_check(l);
  lim := _mkt_limits(p_id);
  if l.price > (lim->>'price_max')::integer then raise exception 'MKT_PRICE'; end if;
  if (lim->>'live_used')::integer >= (lim->>'live')::integer then raise exception 'MKT_LIMIT: live'; end if;

  v_hit := _mkt_listing_hit(l);
  if v_hit is not null then v_hold := 'words';
  elsif _mkt_serial_taken(l) then v_hold := 'serial';
  end if;
  l.status := case when v_hold is null then 'live' else 'held' end;
  l.hold_reason := v_hold;
  l.published_at := now();
  l.expires_at := now() + make_interval(days => _mkt_days());
  l.consent_at := now();
  l := _mkt_store(l);
  if v_hold is null then
    perform _mkt_event('customer', p_id, 'listing', 'publish', l.id, l.shop_id, null, null, p_id, _mkt_snap(l));
  else
    perform _mkt_event('system', null, 'listing', 'hold', l.id, l.shop_id, null, null, p_id,
                       _mkt_snap(l) || jsonb_build_object('reason', v_hold, 'word', v_hit, 'on', 'publish'));
  end if;
  return jsonb_build_object('listing', _mkt_mine(l));
end $$;

-- An account with an approved shop lists as that shop: a private listing that goes back on sale after the shop was
-- approved becomes the shop's (a shop's listing names the shop, not a person).
create or replace function public._mkt_as_shop(l public.market_listings) returns public.market_listings
language plpgsql stable security definer set search_path = public as $$
declare v_shop bigint;
begin
  if l.seller_kind = 'private' then
    select h.id into v_shop from market_shops h where h.owner_id = l.customer_id and h.status = 'approved';
    if v_shop is not null then
      l.seller_kind := 'shop'; l.shop_id := v_shop; l.name_mode := 'none'; l.display_name := null;
    end if;
  end if;
  return l;
end $$;

-- A listing's move, for its seller and for staff on one of MicroMobility's own (which has no caps, no suspension,
-- no blocked words and no commission): reserved, live, sold, renew, deleted. One event per move.
create or replace function public._mkt_move(l public.market_listings, p_action text, p_price integer, p_kind text, p_actor text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o market_listings%rowtype := l; v_company boolean := l.seller_kind = 'company'; v_event text; v_com jsonb;
        v_purge integer := 0; v_pct numeric; v_due integer; lim jsonb; v_hit text; v_hold text; v_detail jsonb := '{}'::jsonb;
        v_how jsonb;
begin
  if p_action is null or p_action not in ('reserved', 'live', 'sold', 'renew', 'deleted') then
    raise exception 'MKT_INPUT: action';
  end if;
  if p_action = 'reserved' then
    if l.status <> 'live' then raise exception 'MKT_STATE'; end if;
    l.status := 'reserved'; v_event := 'reserve';
  elsif p_action = 'live' then
    if l.status = 'reserved' then
      l.status := 'live'; v_event := 'unreserve';
    elsif l.status = 'sold' and not l.commission_received and l.expires_at > now() then
      -- a sale that fell through: back on sale, the sold price and the commission cleared
      if not v_company then
        if _mkt_sell_stopped(l.customer_id) then raise exception 'MKT_SUSPENDED'; end if;
        lim := _mkt_limits(l.customer_id);
        if (lim->>'live_used')::integer >= (lim->>'live')::integer then raise exception 'MKT_LIMIT: live'; end if;
        l := _mkt_as_shop(l);
      end if;
      l.status := 'live'; l.sold_at := null; l.sold_price := null; l.commission_pct := null; l.commission_due := null;
      v_event := 'unsold'; v_detail := jsonb_build_object('sold_price', o.sold_price, 'commission_due', o.commission_due);
    else
      raise exception 'MKT_STATE';
    end if;
  elsif p_action = 'sold' then
    if l.status not in ('live', 'reserved') then raise exception 'MKT_STATE'; end if;
    if p_price is null or p_price not between 1 and 500000 then raise exception 'MKT_INPUT: price'; end if;
    l.status := 'sold'; l.sold_at := now(); l.sold_price := p_price;
    if not v_company then
      -- the honour commission: the setting now, a half going up; nothing is charged
      v_pct := _mkt_pct();
      v_due := floor(p_price * v_pct / 100 + 0.5)::integer;
      l.commission_pct := v_pct; l.commission_due := v_due;
      if v_pct > 0 then
        v_how := _mkt_setting('commission_how');
        v_com := jsonb_build_object('pct', v_pct, 'due', v_due,
          'how_en', case when jsonb_typeof(v_how->'en') = 'string' then left(v_how->>'en', 600) else '' end,
          'how_ar', case when jsonb_typeof(v_how->'ar') = 'string' then left(v_how->>'ar', 600) else '' end);
      end if;
    end if;
    v_event := 'sold';
    v_detail := jsonb_build_object('sold_price', p_price, 'commission_pct', l.commission_pct, 'commission_due', l.commission_due);
  elsif p_action = 'renew' then
    if not (l.status = 'expired' or (l.status in ('live', 'reserved') and l.expires_at <= now() + interval '7 days')) then
      raise exception 'MKT_STATE';
    end if;
    if not v_company then
      if _mkt_sell_stopped(l.customer_id) then raise exception 'MKT_SUSPENDED'; end if;
      if l.status = 'expired' then
        l := _mkt_as_shop(l);
        perform _mkt_check(l);
        lim := _mkt_limits(l.customer_id);
        if l.price > (lim->>'price_max')::integer then raise exception 'MKT_PRICE'; end if;
        if (lim->>'live_used')::integer >= (lim->>'live')::integer then raise exception 'MKT_LIMIT: live'; end if;
      end if;
      v_hit := _mkt_listing_hit(l);
      if v_hit is not null then v_hold := 'words';
      elsif l.status = 'expired' and _mkt_serial_taken(l) then v_hold := 'serial';
      end if;
    elsif l.status = 'expired' then
      perform _mkt_check(l);
    end if;
    if v_hold is not null then l.status := 'held'; l.hold_reason := v_hold;
    elsif l.status = 'expired' then l.status := 'live'; l.hold_reason := null;
    end if;
    l.expires_at := now() + make_interval(days => _mkt_days());
    v_event := 'renew';
  else
    if l.status = 'deleted' then raise exception 'MKT_STATE'; end if;
    -- never on sale: its photos are let go of at once; one that was keeps them 30 days (the daily job)
    if l.published_at is null then
      update market_photo_slots s set gone_at = now()
       where s.gone_at is null and (s.listing_id = l.id or s.name in (select jsonb_array_elements_text(l.photos)));
      get diagnostics v_purge = row_count;
      l.photos := '[]'::jsonb;
    end if;
    l.status := 'deleted'; l.deleted_at := now(); l.hold_reason := null;
    v_event := 'delete'; v_detail := to_jsonb(o) - 'search_text';
  end if;
  l := _mkt_store(l);
  perform _mkt_event(p_kind, p_actor, 'listing', v_event, l.id, l.shop_id, null, null, l.customer_id,
                     case when v_event = 'delete' then v_detail else _mkt_snap(o) || v_detail end);
  if v_hold is not null then
    perform _mkt_event('system', null, 'listing', 'hold', l.id, l.shop_id, null, null, l.customer_id,
                       _mkt_snap(l) || jsonb_build_object('reason', v_hold, 'word', v_hit, 'on', 'renew'));
  end if;
  return jsonb_build_object('commission', v_com, 'purge', v_purge);
end $$;

create or replace function public.market_listing_state(p_id text, p_token text, p_listing bigint, p_action text,
                                                       p_price integer default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l market_listings%rowtype; r jsonb;
begin
  perform _mkt_enter(p_id, p_token, true);
  select * into l from market_listings where id = p_listing and customer_id = p_id for update;
  if not found then raise exception 'MKT_GONE'; end if;
  r := _mkt_move(l, p_action, p_price, 'customer', p_id);
  select * into l from market_listings where id = p_listing;
  return jsonb_build_object('listing', _mkt_mine(l), 'commission', r->'commission', 'purge', (r->>'purge')::integer);
end $$;

-- Every listing of the account but the deleted ones.
create or replace function public.market_my_listings(p_id text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _mkt_enter(p_id, p_token);
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(_mkt_mine(x.m) order by (x.m).updated_at desc, (x.m).id desc)
                         from (select m from market_listings m
                                where m.customer_id = p_id and m.status <> 'deleted'
                                order by m.updated_at desc, m.id desc limit 300) x), '[]'::jsonb),
    'limits', _mkt_limits(p_id));
end $$;

-- ── 5c. What anyone reads ────────────────────────────────────────────────────────────────────────────────────────

-- One page of the grid: listings on sale (live and reserved) only. A key that is not of its shape is ignored. No
-- seller kind is placed ahead of another.
create or replace function public.market_browse(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_sport text; v_cat text; v_kind text; v_city text; v_cond text; v_min integer; v_max integer; v_words text[];
  v_sort text := 'new'; v_limit integer; v_shop bigint; v_after text; v_has boolean := false;
  a_ts timestamptz; a_price integer; a_id bigint; v_ids bigint[]; v_next text; v_last market_listings%rowtype;
begin
  if p is null or jsonb_typeof(p) <> 'object' then p := '{}'::jsonb; end if;
  if jsonb_typeof(p->'sport') = 'string' then v_sport := p->>'sport'; end if;
  if jsonb_typeof(p->'category') = 'string' then v_cat := p->>'category'; end if;
  if jsonb_typeof(p->'kind') = 'string' and p->>'kind' in ('private', 'shop', 'company') then v_kind := p->>'kind'; end if;
  if jsonb_typeof(p->'city') = 'string' and p->>'city' = any (_mkt_cities()) then v_city := p->>'city'; end if;
  if jsonb_typeof(p->'condition') = 'string' and p->>'condition' in ('new', 'excellent', 'good', 'fair', 'parts') then
    v_cond := p->>'condition';
  end if;
  v_min := _mkt_num(p->'price_min', null, 0, 500000)::integer;
  v_max := _mkt_num(p->'price_max', null, 0, 500000)::integer;
  if jsonb_typeof(p->'sort') = 'string' and p->>'sort' in ('new', 'price_asc', 'price_desc') then v_sort := p->>'sort'; end if;
  v_limit := _mkt_num(p->'limit', 24, 1, 24)::integer;
  if jsonb_typeof(p->'q') = 'string' then
    -- up to five words, each as the search text keeps words (_ask_norm)
    select array_agg(z.w) into v_words
      from (select _ask_norm(e.w) as w
              from regexp_split_to_table(left(_ask_text(p->>'q'), 80), ' ') with ordinality as e(w, ord)
             where _ask_norm(e.w) <> '' order by e.ord limit 5) z;
  end if;
  if jsonb_typeof(p->'shop') = 'string' then
    select h.id into v_shop from market_shops h where h.slug = p->>'shop' and h.status = 'approved';
    v_shop := coalesce(v_shop, -1);   -- no such shop: nothing to list
  end if;
  -- the cursor: "<published_at in microseconds>.<id>" by date, "<price>.<id>" by price
  if jsonb_typeof(p->'after') = 'string' then
    v_after := p->>'after';
    if v_sort = 'new' and v_after ~ '^[0-9]{1,18}\.[0-9]{1,18}$' then
      a_ts := 'epoch'::timestamptz + split_part(v_after, '.', 1)::bigint * interval '1 microsecond';
      a_id := split_part(v_after, '.', 2)::bigint; v_has := true;
    elsif v_sort <> 'new' and v_after ~ '^[0-9]{1,6}\.[0-9]{1,18}$' then
      a_price := split_part(v_after, '.', 1)::integer;
      a_id := split_part(v_after, '.', 2)::bigint; v_has := true;
    end if;
  end if;

  select array_agg(x.id order by x.rn) into v_ids
    from (select l.id, row_number() over (
                   order by case when v_sort = 'price_asc' then l.price end asc,
                            case when v_sort = 'price_desc' then l.price end desc,
                            case when v_sort = 'new' then l.published_at end desc, l.id desc) as rn
            from market_listings l join market_categories c on c.slug = l.category
           where l.status in ('live', 'reserved')
             and (v_sport is null or c.parent = v_sport)
             and (v_cat is null or l.category = v_cat)
             and (v_kind is null or l.seller_kind = v_kind)
             and (v_city is null or l.city = v_city)
             and (v_cond is null or l.condition = v_cond)
             and (v_min is null or l.price >= v_min)
             and (v_max is null or l.price <= v_max)
             and (v_shop is null or l.shop_id = v_shop)
             and (v_words is null or not exists (select 1 from unnest(v_words) w where strpos(l.search_text, w) = 0))
             and (not v_has
                  or (v_sort = 'new' and (l.published_at, l.id) < (a_ts, a_id))
                  or (v_sort = 'price_asc' and (l.price > a_price or (l.price = a_price and l.id < a_id)))
                  or (v_sort = 'price_desc' and (l.price < a_price or (l.price = a_price and l.id < a_id))))
           order by rn limit v_limit + 1) x;

  if coalesce(array_length(v_ids, 1), 0) > v_limit then
    select * into v_last from market_listings where id = v_ids[v_limit];
    v_next := case when v_sort = 'new' then floor(extract(epoch from v_last.published_at) * 1000000)::bigint::text
                   else v_last.price::text end || '.' || v_last.id;
    v_ids := v_ids[1:v_limit];
  end if;

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(_mkt_card(l) order by o.ord)
                         from unnest(v_ids) with ordinality as o(id, ord) join market_listings l on l.id = o.id), '[]'::jsonb),
    'next', v_next,
    'sports', coalesce((select jsonb_agg(s.slug order by s.sort, s.slug) from market_categories s
                         where s.parent is null
                           and exists (select 1 from market_listings l join market_categories c on c.slug = l.category
                                        where c.parent = s.slug and l.status in ('live', 'reserved'))), '[]'::jsonb),
    'categories', case when v_sport is null then '[]'::jsonb else
                  coalesce((select jsonb_agg(c.slug order by c.sort, c.slug) from market_categories c
                             where c.parent = v_sport
                               and exists (select 1 from market_listings l
                                            where l.category = c.slug and l.status in ('live', 'reserved'))), '[]'::jsonb) end);
end $$;

-- A listing's page. To everyone: live, reserved, or sold in the last 14 days. To its seller (a token that passes):
-- any state but a draft or a deleted one, with their own data. A token that does not pass is read as no account.
create or replace function public.market_listing_get(p_listing bigint, p_id text default null, p_token text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare l market_listings%rowtype; v_me text; v_mine boolean := false;
begin
  if p_listing is null then return null; end if;
  if p_id is not null and p_token is not null and _cust_token_ok(p_id, p_token) then v_me := p_id; end if;
  select * into l from market_listings where id = p_listing;
  if not found then return null; end if;
  v_mine := v_me is not null and l.customer_id is not null and l.customer_id = v_me;
  if v_mine then
    if l.status in ('draft', 'deleted') then return null; end if;
  elsif not (l.status in ('live', 'reserved') or (l.status = 'sold' and l.sold_at > now() - interval '14 days')) then
    return null;
  end if;
  return jsonb_build_object(
    'id', l.id, 'status', l.status, 'title', l.title, 'description', l.description, 'condition', l.condition,
    'faults', l.faults, 'price', l.price, 'negotiable', l.negotiable, 'city', l.city, 'category', l.category,
    'sport', (select c.parent from market_categories c where c.slug = l.category),
    'facts', l.facts,
    'serial_masked', case when l.serial is not null then repeat(chr(8226), 3) || right(l.serial, 3) end,
    'declarations', coalesce((select jsonb_object_agg(e.key, true) from jsonb_each(l.declarations) e where e.value = 'true'::jsonb), '{}'::jsonb),
    'photos', l.photos,
    'seller', _mkt_seller_view(l),
    'checked_at', l.checked_at, 'published_at', l.published_at, 'sold_at', l.sold_at,
    'mine', v_mine,
    'own', case when v_mine then _mkt_mine(l) end,
    'thread_id', (select t.id from market_threads t where v_me is not null and t.listing_id = l.id and t.buyer_id = v_me),
    'reported', v_me is not null and exists (select 1 from market_reports r
                                              where r.target = 'listing' and r.listing_id = l.id and r.reporter_id = v_me),
    'can_message', l.status in ('live', 'reserved') and l.seller_kind <> 'company' and not v_mine
                   and not (v_me is not null and _mkt_blocked(v_me, l.customer_id)));
end $$;

-- An approved shop's page (its phone and WhatsApp are not here: market_shop_contact, signed in).
create or replace function public.market_shop_get(p_slug text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'slug', h.slug, 'name_en', h.name_en, 'name_ar', h.name_ar, 'logo', h.logo, 'cr_no', h.cr_no,
    'cr_activity', h.cr_activity, 'vat_no', h.vat_no, 'city', h.city, 'address', h.address, 'map_url', h.map_url,
    'about_en', h.about_en, 'about_ar', h.about_ar, 'returns_en', h.returns_en, 'returns_ar', h.returns_ar,
    'sells', h.sells, 'approved_at', h.approved_at)
    from market_shops h where h.slug = p_slug and h.status = 'approved'
$$;

-- The approved shops, by name.
create or replace function public.market_shops() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object(
           'slug', h.slug, 'name_en', h.name_en, 'name_ar', h.name_ar, 'logo', h.logo, 'city', h.city, 'sells', h.sells)
           order by h.name_en, h.id), '[]'::jsonb))
    from market_shops h where h.status = 'approved'
$$;

-- For the sitemap and the site's search: the listings on sale (newest first, 2,000 at most) and the approved shops.
create or replace function public.market_index() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'listings', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title) order by x.published_at desc, x.id desc)
                            from (select l.id, l.title, l.published_at from market_listings l
                                   where l.status in ('live', 'reserved')
                                   order by l.published_at desc, l.id desc limit 2000) x), '[]'::jsonb),
    'shops', coalesce((select jsonb_agg(jsonb_build_object('slug', h.slug, 'name_en', h.name_en, 'name_ar', h.name_ar)
                                        order by h.name_en, h.id)
                         from market_shops h where h.status = 'approved'), '[]'::jsonb))
$$;

-- The photos the database let go of, for the website to remove from the storage. First it sees for itself which
-- are already gone (neither copy is in storage.objects any more), then lists the oldest still waiting.
create or replace function public.market_purge_take(p_max integer default 100) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_max integer := least(greatest(coalesce(p_max, 100), 1), 200);
begin
  update market_photo_slots s set purged_at = now()
   where s.gone_at is not null and s.purged_at is null
     and not exists (select 1 from storage.objects o
                      where o.bucket_id = 'market'
                        and o.name in (s.name, regexp_replace(s.name, '\.(jpg|webp)$', '.w480.\1')));
  return jsonb_build_object('names', coalesce((select jsonb_agg(x.name order by x.gone_at, x.name)
                                                 from (select s.name, s.gone_at from market_photo_slots s
                                                        where s.gone_at is not null and s.purged_at is null
                                                        order by s.gone_at, s.name limit v_max) x), '[]'::jsonb));
end $$;

-- ── 5d. Shops ────────────────────────────────────────────────────────────────────────────────────────────────────

-- An approved shop's two numbers, for a signed-in account: 30 different shops in a day (one row of the trail per
-- account and shop per day is the count).
create or replace function public.market_shop_contact(p_id text, p_token text, p_slug text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h market_shops%rowtype;
begin
  perform _mkt_enter(p_id, p_token, true);
  select * into h from market_shops where slug = p_slug and status = 'approved';
  if not found then raise exception 'MKT_GONE'; end if;
  if not exists (select 1 from market_events e
                  where e.customer_id = p_id and e.action = 'shop_contact' and e.shop_id = h.id
                    and e.at > now() - interval '24 hours') then
    if (select count(*) from market_events e
         where e.customer_id = p_id and e.action = 'shop_contact' and e.at > now() - interval '24 hours') >= 30 then
      raise exception 'MKT_LIMIT: contacts';
    end if;
    perform _mkt_event('customer', p_id, 'shop', 'shop_contact', null, h.id, null, null, p_id, '{}'::jsonb);
  end if;
  return jsonb_build_object('phone', h.phone, 'whatsapp', h.whatsapp);
end $$;

-- The account's shop application, or a change to its shop. A key left out stays as it is (null clears it); a new
-- application needs the name, the CR number and activity, and the city. Once approved, the name, the CR number and
-- activity, the VAT number and the city are staff's to change.
create or replace function public.market_shop_apply(p_id text, p_token text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h market_shops%rowtype; o market_shops%rowtype; v jsonb; v_terms text := _mkt_terms(); v_new boolean; v_logo text;
        v_event text := 'shop_apply'; k text;
begin
  perform _mkt_enter(p_id, p_token, true);
  if _mkt_suspended(p_id) then raise exception 'MKT_SUSPENDED'; end if;
  perform _mkt_need_adult(p_id);
  if p is null or jsonb_typeof(p) <> 'object' then p := '{}'::jsonb; end if;
  select * into h from market_shops where owner_id = p_id for update;
  v_new := not found;
  if not v_new and h.status = 'suspended' then raise exception 'MKT_SUSPENDED'; end if;
  if jsonb_typeof(p->'agreement') is distinct from 'string' or p->>'agreement' <> v_terms then raise exception 'MKT_TERMS'; end if;
  if (select count(*) from market_events e
       where e.customer_id = p_id and e.actor_kind = 'customer' and e.action in ('shop_apply', 'shop_edit')
         and e.at > now() - interval '24 hours') >= 3 then
    raise exception 'MKT_LIMIT: shop';
  end if;
  o := h;
  v := _mkt_shop_vals(p, true);
  if not v_new and h.status = 'approved' then
    foreach k in array array['name_en', 'cr_no', 'cr_activity', 'vat_no', 'city'] loop
      if v ? k and (v->>k) is distinct from (to_jsonb(h)->>k) then raise exception 'MKT_INPUT: locked'; end if;
    end loop;
    v_event := 'shop_edit';
  else
    if v ? 'name_en' then h.name_en := v->>'name_en'; end if;
    if v ? 'cr_no' then h.cr_no := v->>'cr_no'; end if;
    if v ? 'cr_activity' then h.cr_activity := v->>'cr_activity'; end if;
    if v ? 'vat_no' then h.vat_no := v->>'vat_no'; end if;
    if v ? 'city' then h.city := v->>'city'; end if;
    if h.name_en is null then raise exception 'MKT_INPUT: name_en'; end if;
    if h.cr_no is null then raise exception 'MKT_INPUT: cr_no'; end if;
    if h.cr_activity is null then raise exception 'MKT_INPUT: cr_activity'; end if;
    if h.city is null then raise exception 'MKT_INPUT: city'; end if;
  end if;
  if v ? 'name_ar' then h.name_ar := v->>'name_ar'; end if;
  if v ? 'address' then h.address := v->>'address'; end if;
  if v ? 'map_url' then h.map_url := v->>'map_url'; end if;
  if v ? 'phone' then h.phone := v->>'phone'; end if;
  if v ? 'whatsapp' then h.whatsapp := v->>'whatsapp'; end if;
  if v ? 'about_en' then h.about_en := v->>'about_en'; end if;
  if v ? 'about_ar' then h.about_ar := v->>'about_ar'; end if;
  if v ? 'returns_en' then h.returns_en := v->>'returns_en'; end if;
  if v ? 'returns_ar' then h.returns_ar := v->>'returns_ar'; end if;
  if v ? 'sells' then h.sells := v->>'sells'; end if;
  -- the logo: a stored, unreleased photo slot of this caller's shop (so the shop is there first), or none
  if p ? 'logo' then
    if jsonb_typeof(p->'logo') = 'null' then
      h.logo := null;
    else
      v_logo := p->>'logo';
      if jsonb_typeof(p->'logo') <> 'string' or v_new
         or not (v_logo is not distinct from o.logo
                 or exists (select 1 from market_photo_slots s
                             where s.name = v_logo and s.customer_id = p_id and s.shop_id = h.id
                               and s.used_at is not null and s.gone_at is null)) then
        raise exception 'MKT_INPUT: logo';
      end if;
      h.logo := v_logo;
    end if;
  end if;
  if exists (select 1 from market_shops x where x.cr_no = h.cr_no and x.status <> 'rejected' and x.id is distinct from h.id) then
    raise exception 'MKT_DUP: cr';
  end if;

  if v_new then
    insert into market_shops (owner_id, slug, name_en, name_ar, cr_no, cr_activity, vat_no, city, address, map_url, phone,
                              whatsapp, about_en, about_ar, returns_en, returns_ar, sells, status, agreement_version, agreement_at)
    values (p_id, _mkt_slug(h.name_en), h.name_en, h.name_ar, h.cr_no, h.cr_activity, h.vat_no, h.city, h.address, h.map_url,
            h.phone, h.whatsapp, h.about_en, h.about_ar, h.returns_en, h.returns_ar, h.sells, 'pending', v_terms, now())
    returning * into h;
  else
    update market_shops m
       set name_en = h.name_en, name_ar = h.name_ar, cr_no = h.cr_no, cr_activity = h.cr_activity, vat_no = h.vat_no,
           city = h.city, address = h.address, map_url = h.map_url, phone = h.phone, whatsapp = h.whatsapp,
           about_en = h.about_en, about_ar = h.about_ar, returns_en = h.returns_en, returns_ar = h.returns_ar,
           sells = h.sells, logo = h.logo, agreement_version = v_terms, agreement_at = now(),
           -- sent again after a rejection: it waits again, and the old decision is cleared
           status = case when m.status = 'rejected' then 'pending' else m.status end,
           decided_by = case when m.status = 'rejected' then null else m.decided_by end,
           decided_at = case when m.status = 'rejected' then null else m.decided_at end,
           decision_note = case when m.status = 'rejected' then null else m.decision_note end
     where m.id = h.id
    returning * into h;
    if o.logo is not null and o.logo is distinct from h.logo then
      update market_photo_slots s set gone_at = now() where s.name = o.logo and s.gone_at is null;
    end if;
  end if;
  -- the shop agreement is the rules of the same version: the account has accepted them
  insert into market_sellers (customer_id, terms_version, terms_at) values (p_id, v_terms, now())
  on conflict (customer_id) do update set terms_version = excluded.terms_version, terms_at = excluded.terms_at
    where market_sellers.terms_version is distinct from excluded.terms_version;
  perform _mkt_event('customer', p_id, 'shop', v_event, null, h.id, null, null, p_id,
                     jsonb_build_object('name_en', h.name_en, 'cr_no', h.cr_no, 'city', h.city, 'status', h.status));
  return jsonb_build_object('shop', _mkt_shop_mine(h));
end $$;

create or replace function public.market_shop_mine(p_id text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _mkt_enter(p_id, p_token);
  return jsonb_build_object('shop', (select _mkt_shop_mine(h) from market_shops h where h.owner_id = p_id));
end $$;

-- ── 5e. Contact: the inbox ───────────────────────────────────────────────────────────────────────────────────────

-- The parts of a thread both the inbox and the open thread show: whose side the reader is on, the listing, and the
-- other person as they chose to be named (a buyer or a private seller by "first name + last initial" or no name, a
-- shop by its trade name). Never an id. A listing that is held, hidden or deleted shows its buyer no photo.
create or replace function public._mkt_thread_base(t public.market_threads, p_me text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare l market_listings%rowtype; v_role text := case when t.buyer_id = p_me then 'buyer' else 'seller' end;
begin
  select * into l from market_listings where id = t.listing_id;
  return jsonb_build_object(
    'id', t.id, 'role', v_role,
    'listing', jsonb_build_object('id', l.id, 'title', l.title, 'price', l.price,
                 'photo', case when v_role = 'seller' or l.status in ('live', 'reserved', 'sold', 'expired') then l.photos->>0 end,
                 'status', l.status, 'city', l.city),
    'other', case when v_role = 'buyer'
                  then jsonb_build_object('kind', case when l.seller_kind = 'shop' then 'shop' else 'private' end,
                                          'name', case when l.seller_kind = 'private' then l.display_name end,
                                          'shop', case when l.seller_kind = 'shop' then _mkt_shop_ref(l.shop_id) end)
                  else jsonb_build_object('kind', 'buyer', 'name', t.buyer_name, 'shop', null) end);
end $$;

-- Why "Share my WhatsApp" would be refused in this thread now (a code), or null when it would be taken.
create or replace function public._mkt_wa_why(p_id text, t public.market_threads) returns text
language plpgsql stable security definer set search_path = public as $$
declare lim jsonb;
begin
  -- only after the other side has written
  if (t.buyer_id = p_id and t.seller_msgs = 0) or (t.seller_id = p_id and t.buyer_msgs = 0) then return 'MKT_STATE'; end if;
  lim := _mkt_limits(p_id);
  if (lim->>'wa_day')::integer <= 0 and not _mkt_established(p_id) then return 'MKT_NEW'; end if;
  if _mkt_wa_of(p_id) is null then return 'MKT_NOPHONE'; end if;
  if _mkt_blocked(t.buyer_id, t.seller_id) then return 'MKT_BLOCKED'; end if;
  if _mkt_suspended(p_id) then return 'MKT_SUSPENDED'; end if;
  if (lim->>'wa_used')::integer >= (lim->>'wa_day')::integer then return 'MKT_LIMIT: whatsapp'; end if;
  return null;
end $$;

-- One more message in a thread the caller is in (the row is locked by the caller): send's rules, then the write.
create or replace function public._mkt_say(p_id text, t public.market_threads, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_side text := case when t.buyer_id = p_id then 'buyer' else 'seller' end; v_body text; lim jsonb;
        v_status text; m market_messages%rowtype;
begin
  if _mkt_suspended(p_id) then raise exception 'MKT_SUSPENDED'; end if;
  perform _mkt_need_adult(p_id);
  if _mkt_blocked(t.buyer_id, t.seller_id) then raise exception 'MKT_BLOCKED'; end if;
  select l.status into v_status from market_listings l where l.id = t.listing_id;
  if v_status is null or v_status in ('held', 'hidden', 'deleted') then raise exception 'MKT_STATE'; end if;
  v_body := _mkt_body(p_body);
  lim := _mkt_limits(p_id);
  if (lim->>'messages_used')::integer >= (lim->>'messages_day')::integer then raise exception 'MKT_LIMIT: messages'; end if;
  -- a buyer writes three times at most before the seller's first reply
  if v_side = 'buyer' and t.seller_msgs = 0 and t.buyer_msgs >= 3 then raise exception 'MKT_LIMIT: wait'; end if;
  insert into market_messages (thread_id, side, body) values (t.id, v_side, v_body) returning * into m;
  update market_threads x
     set last_at = m.created_at, last_side = v_side, last_body = left(v_body, 120),
         buyer_unread = case when v_side = 'buyer' then 0 else x.buyer_unread + 1 end,
         seller_unread = case when v_side = 'seller' then 0 else x.seller_unread + 1 end,
         buyer_msgs = x.buyer_msgs + case when v_side = 'buyer' then 1 else 0 end,
         seller_msgs = x.seller_msgs + case when v_side = 'seller' then 1 else 0 end
   where x.id = t.id;
  return jsonb_build_object('id', m.id, 'mine', true, 'body', m.body, 'at', m.created_at);
end $$;

-- The buyer's first message about a listing; one more in their thread when they already have one on it.
create or replace function public.market_thread_open(p_id text, p_token text, p_listing bigint, p_body text, p_name_mode text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l market_listings%rowtype; t market_threads%rowtype; v_body text; v_name text; lim jsonb;
begin
  perform _mkt_enter(p_id, p_token, true);
  if _mkt_suspended(p_id) then raise exception 'MKT_SUSPENDED'; end if;
  perform _mkt_need_adult(p_id);
  select * into l from market_listings where id = p_listing;
  if not found then raise exception 'MKT_GONE'; end if;
  select * into t from market_threads where listing_id = l.id and buyer_id = p_id for update;
  if found then
    perform _mkt_say(p_id, t, p_body);
    return jsonb_build_object('thread_id', t.id, 'created', false);
  end if;
  if l.status not in ('live', 'reserved') then raise exception 'MKT_GONE'; end if;
  if l.customer_id = p_id then raise exception 'MKT_OWN'; end if;
  if l.seller_kind = 'company' or l.customer_id is null then raise exception 'MKT_STATE'; end if;
  -- the seller's account was closed or merged away since (the night's job takes its listings off sale)
  if not exists (select 1 from customers c where c.id = l.customer_id and c.archived_at is null and c.merged_into is null) then
    raise exception 'MKT_GONE';
  end if;
  if _mkt_blocked(p_id, l.customer_id) then raise exception 'MKT_BLOCKED'; end if;
  if p_name_mode is null or p_name_mode not in ('short', 'none') then raise exception 'MKT_INPUT: name_mode'; end if;
  if p_name_mode = 'short' then
    select _tm_short(_ask_text(c.name)) into v_name from customers c where c.id = p_id;
    if v_name is null then raise exception 'MKT_INPUT: name_mode'; end if;
  end if;
  v_body := _mkt_body(p_body);
  lim := _mkt_limits(p_id);
  if (lim->>'threads_used')::integer >= (lim->>'threads_day')::integer then raise exception 'MKT_LIMIT: threads'; end if;
  if (lim->>'messages_used')::integer >= (lim->>'messages_day')::integer then raise exception 'MKT_LIMIT: messages'; end if;
  insert into market_threads (listing_id, buyer_id, seller_id, buyer_name_mode, buyer_name, last_at, last_side, last_body,
                              seller_unread, buyer_msgs)
  values (l.id, p_id, l.customer_id, p_name_mode, v_name, now(), 'buyer', left(v_body, 120), 1, 1)
  returning * into t;
  insert into market_messages (thread_id, side, body) values (t.id, 'buyer', v_body);
  return jsonb_build_object('thread_id', t.id, 'created', true);
end $$;

create or replace function public.market_thread_send(p_id text, p_token text, p_thread bigint, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t market_threads%rowtype;
begin
  perform _mkt_enter(p_id, p_token, true);
  select * into t from market_threads where id = p_thread and (buyer_id = p_id or seller_id = p_id) for update;
  if not found then raise exception 'MKT_GONE'; end if;
  return jsonb_build_object('message', _mkt_say(p_id, t, p_body));
end $$;

-- The account's threads as buyer and as seller, the newest first.
create or replace function public.market_threads(p_id text, p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _mkt_enter(p_id, p_token);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(_mkt_thread_base(x.t, p_id) || jsonb_build_object(
             'last_at', (x.t).last_at, 'last_body', (x.t).last_body,
             'last_mine', (x.t).last_side = case when (x.t).buyer_id = p_id then 'buyer' else 'seller' end,
             'unread', case when (x.t).buyer_id = p_id then (x.t).buyer_unread else (x.t).seller_unread end,
             'blocked_by_me', exists (select 1 from market_blocks b
                                       where b.blocker_id = p_id
                                         and b.blocked_id = case when (x.t).buyer_id = p_id then (x.t).seller_id else (x.t).buyer_id end))
           order by (x.t).last_at desc, (x.t).id desc)
      from (select t from market_threads t where t.buyer_id = p_id or t.seller_id = p_id
             order by t.last_at desc, t.id desc limit 200) x), '[]'::jsonb));
end $$;

-- One thread and its messages (the latest hundred, or the hundred before message p_before), the oldest first. It
-- clears the caller's unread count. The other person's WhatsApp number is here only once THEY shared it in this
-- thread, and not while one of the two has blocked the other.
create or replace function public.market_thread_get(p_id text, p_token text, p_thread bigint, p_before bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t market_threads%rowtype; v_buyer boolean; v_other text; v_blocked boolean; v_status text; v_city text;
        v_msgs jsonb; v_n integer; v_mine_wa text; v_other_wa text;
begin
  perform _mkt_enter(p_id, p_token);
  select * into t from market_threads where id = p_thread and (buyer_id = p_id or seller_id = p_id);
  if not found then raise exception 'MKT_GONE'; end if;
  v_buyer := t.buyer_id = p_id;
  v_other := case when v_buyer then t.seller_id else t.buyer_id end;
  if v_buyer and t.buyer_unread > 0 then update market_threads set buyer_unread = 0 where id = t.id;
  elsif not v_buyer and t.seller_unread > 0 then update market_threads set seller_unread = 0 where id = t.id;
  end if;
  v_blocked := _mkt_blocked(t.buyer_id, t.seller_id);
  select l.status, l.city into v_status, v_city from market_listings l where l.id = t.listing_id;
  v_mine_wa := case when v_buyer then t.buyer_wa else t.seller_wa end;
  v_other_wa := case when v_buyer then t.seller_wa else t.buyer_wa end;
  select count(*), coalesce(jsonb_agg(jsonb_build_object('id', z.id, 'mine', z.side = case when v_buyer then 'buyer' else 'seller' end,
                                                         'body', z.body, 'at', z.created_at) order by z.id)
                              filter (where z.rn <= 100), '[]'::jsonb)
    into v_n, v_msgs
    from (select m.*, row_number() over (order by m.id desc) as rn
            from market_messages m
           where m.thread_id = t.id and (p_before is null or m.id < p_before)
           order by m.id desc limit 101) z;
  return jsonb_build_object(
    'thread', _mkt_thread_base(t, p_id) || jsonb_build_object(
      'can_send', not v_blocked and v_status is not null and v_status not in ('held', 'hidden', 'deleted') and not _mkt_suspended(p_id),
      'blocked_by_me', exists (select 1 from market_blocks b where b.blocker_id = p_id and b.blocked_id = v_other),
      'reported', exists (select 1 from market_reports r where r.target = 'thread' and r.thread_id = t.id and r.reporter_id = p_id),
      'can_share_wa', v_mine_wa is null and _mkt_wa_why(p_id, t) is null,
      'my_wa_shared', v_mine_wa is not null,
      'other_wa', case when not v_blocked then v_other_wa end,
      'hub', coalesce(v_city = 'jeddah', false)),
    'messages', v_msgs,
    'more', v_n > 100);
end $$;

-- The caller's WhatsApp number, frozen on the thread and shown to the other person from then on. Their own choice.
create or replace function public.market_share_whatsapp(p_id text, p_token text, p_thread bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t market_threads%rowtype; v_why text; v_wa text;
begin
  perform _mkt_enter(p_id, p_token, true);
  select * into t from market_threads where id = p_thread and (buyer_id = p_id or seller_id = p_id) for update;
  if not found then raise exception 'MKT_GONE'; end if;
  -- shared before in this thread: nothing changes
  if (t.buyer_id = p_id and t.buyer_wa is not null) or (t.seller_id = p_id and t.seller_wa is not null) then
    return jsonb_build_object('shared', true);
  end if;
  v_why := _mkt_wa_why(p_id, t);
  if v_why is not null then raise exception '%', v_why; end if;
  v_wa := _mkt_wa_of(p_id);
  if t.buyer_id = p_id then update market_threads set buyer_wa = v_wa, buyer_wa_at = now() where id = t.id;
  else update market_threads set seller_wa = v_wa, seller_wa_at = now() where id = t.id;
  end if;
  perform _mkt_event('customer', p_id, 'thread', 'wa_share', t.listing_id, null, t.id, null, p_id, '{}'::jsonb);
  return jsonb_build_object('shared', true);
end $$;

-- How many of the caller's threads hold something unread (asked often: no meter, no write).
create or replace function public.market_unread(p_id text, p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'MKT_SIGNIN'; end if;
  return jsonb_build_object('n', _mkt_unread(p_id));
end $$;

-- A listing or a thread reported to staff. When the open reports on a listing come from N different accounts
-- (marketplace.auto_hold_reports) and it is on sale, it is held until staff look.
create or replace function public.market_report(p_id text, p_token text, p_target text, p_ref bigint, p_reason text,
                                                p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l market_listings%rowtype; t market_threads%rowtype; v_note text; r market_reports%rowtype;
begin
  perform _mkt_enter(p_id, p_token, true);
  if p_target = 'listing' then
    select * into l from market_listings where id = p_ref for update;
    if not found or not (l.status in ('live', 'reserved') or (l.status = 'sold' and l.sold_at > now() - interval '14 days')) then
      raise exception 'MKT_GONE';
    end if;
    if l.customer_id = p_id then raise exception 'MKT_OWN'; end if;
  elsif p_target = 'thread' then
    select * into t from market_threads where id = p_ref and (buyer_id = p_id or seller_id = p_id);
    if not found then raise exception 'MKT_GONE'; end if;
  else
    raise exception 'MKT_INPUT: target';
  end if;
  if p_reason is null or p_reason not in ('prohibited', 'counterfeit', 'stolen', 'misleading', 'scam', 'abuse', 'spam', 'other') then
    raise exception 'MKT_INPUT: reason';
  end if;
  v_note := nullif(left(_ask_text(p_note), 300), '');
  -- one report per account per thing
  if (p_target = 'listing' and exists (select 1 from market_reports x where x.target = 'listing' and x.listing_id = l.id and x.reporter_id = p_id))
     or (p_target = 'thread' and exists (select 1 from market_reports x where x.target = 'thread' and x.thread_id = t.id and x.reporter_id = p_id)) then
    return jsonb_build_object('dup', true);
  end if;
  if (select count(*) from market_reports x where x.reporter_id = p_id and x.created_at > now() - interval '24 hours') >= 10 then
    raise exception 'MKT_LIMIT: reports';
  end if;
  insert into market_reports (target, listing_id, thread_id, reporter_id, reason, note)
  values (p_target, coalesce(l.id, t.listing_id), t.id, p_id, p_reason, v_note)
  returning * into r;
  perform _mkt_event('customer', p_id, 'report', 'report', r.listing_id, null, r.thread_id, r.id, p_id,
                     jsonb_build_object('target', p_target, 'reason', p_reason));
  if p_target = 'listing' and l.status in ('live', 'reserved')
     and (select count(distinct x.reporter_id) from market_reports x
           where x.target = 'listing' and x.listing_id = l.id and x.status = 'open') >= _mkt_hold_n() then
    update market_listings set status = 'held', hold_reason = 'reports' where id = l.id;
    perform _mkt_event('system', null, 'listing', 'hold', l.id, l.shop_id, null, null, l.customer_id,
                       _mkt_snap(l) || jsonb_build_object('reason', 'reports', 'on', 'report'));
  end if;
  return jsonb_build_object('dup', false);
end $$;

-- The other person of this thread blocked (or no longer blocked): neither can open a thread with or write to the
-- other while a block stands, in either direction.
create or replace function public.market_block(p_id text, p_token text, p_thread bigint, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t market_threads%rowtype; v_other text; v_n integer;
begin
  perform _mkt_enter(p_id, p_token, true);
  select * into t from market_threads where id = p_thread and (buyer_id = p_id or seller_id = p_id);
  if not found then raise exception 'MKT_GONE'; end if;
  if p_on is null then raise exception 'MKT_INPUT: action'; end if;
  v_other := case when t.buyer_id = p_id then t.seller_id else t.buyer_id end;
  if p_on then
    insert into market_blocks (blocker_id, blocked_id) values (p_id, v_other) on conflict do nothing;
  else
    delete from market_blocks where blocker_id = p_id and blocked_id = v_other;
  end if;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform _mkt_event('customer', p_id, 'thread', case when p_on then 'block' else 'unblock' end, t.listing_id, null, t.id,
                       null, v_other, '{}'::jsonb);
  end if;
  return jsonb_build_object('blocked', p_on);
end $$;

-- ── 6. The daily job ─────────────────────────────────────────────────────────────────────────────────────────────
-- Takes a closed account's listings off sale; expires listings; deletes the ones that expired 60 days ago (their
-- photos go with them); lets go of the photos of listings deleted 30 days ago, sold 60 days ago or hidden 180 days
-- ago, and of files nothing names any more; clears photo slots never used; deletes threads 12 months after their
-- last message; and, where pg_net is installed and a photo is waiting, asks the website to remove the files (the
-- website asks market_purge_take which). It answers what it did, in numbers.
create or replace function public._mkt_tick() returns jsonb
language plpgsql security definer set search_path = public as $$
declare l market_listings%rowtype; h market_shops%rowtype; v_expired integer := 0; v_deleted integer := 0; v_gone integer := 0;
        v_slots integer := 0; v_threads integer := 0; v_closed integer := 0; n integer; v_post boolean := false;
begin
  -- 0. an account that was closed (archived, 20261111200000) or merged into another sells nothing: its listings
  --    are deleted (the whole row kept in the trail; photos follow the 30 days, a draft's go at once) and its shop
  --    is taken down. The kept account of a merge lists again itself.
  for l in select m.* from market_listings m join customers c on c.id = m.customer_id
            where m.status <> 'deleted' and (c.archived_at is not null or c.merged_into is not null) for update of m loop
    perform _mkt_event('system', null, 'listing', 'delete', l.id, l.shop_id, null, null, l.customer_id,
                       (to_jsonb(l) - 'search_text') || jsonb_build_object('account_closed', true));
    if l.published_at is null then
      update market_photo_slots s set gone_at = now()
       where s.gone_at is null and (s.listing_id = l.id or s.name in (select jsonb_array_elements_text(l.photos)));
      get diagnostics n = row_count; v_gone := v_gone + n;
      update market_listings set status = 'deleted', deleted_at = now(), hold_reason = null, photos = '[]'::jsonb where id = l.id;
    else
      update market_listings set status = 'deleted', deleted_at = now(), hold_reason = null where id = l.id;
    end if;
    v_closed := v_closed + 1;
  end loop;
  for h in select s.* from market_shops s join customers c on c.id = s.owner_id
            where s.status in ('approved', 'pending') and (c.archived_at is not null or c.merged_into is not null) for update of s loop
    update market_shops set status = case when h.status = 'approved' then 'suspended' else 'rejected' end,
                            decided_by = 'system', decided_at = now(), decision_note = 'The account was closed.'
     where id = h.id;
    perform _mkt_event('system', null, 'shop', case when h.status = 'approved' then 'shop_suspend' else 'shop_reject' end,
                       null, h.id, null, null, h.owner_id, jsonb_build_object('name_en', h.name_en, 'account_closed', true));
  end loop;

  -- 1. past its date: expired
  for l in select * from market_listings m where m.status in ('live', 'reserved') and m.expires_at <= now() for update loop
    update market_listings set status = 'expired' where id = l.id;
    perform _mkt_event('system', null, 'listing', 'expire', l.id, l.shop_id, null, null, l.customer_id, _mkt_snap(l));
    v_expired := v_expired + 1;
  end loop;

  -- 2. expired 60 days ago: deleted, the whole row kept in the trail, its photos let go of at once
  for l in select * from market_listings m where m.status = 'expired' and m.expires_at < now() - interval '60 days' for update loop
    perform _mkt_event('system', null, 'listing', 'delete', l.id, l.shop_id, null, null, l.customer_id, to_jsonb(l) - 'search_text');
    update market_photo_slots s set gone_at = now()
     where s.gone_at is null and (s.listing_id = l.id or s.name in (select jsonb_array_elements_text(l.photos)));
    get diagnostics n = row_count; v_gone := v_gone + n;
    update market_listings set status = 'deleted', deleted_at = now(), photos = '[]'::jsonb where id = l.id;
    v_deleted := v_deleted + 1;
  end loop;

  -- 3. photos kept long enough: deleted 30 days ago, sold 60 days ago, hidden by staff 180 days ago
  for l in select * from market_listings m
            where m.photos <> '[]'::jsonb
              and ((m.status = 'deleted' and m.deleted_at < now() - interval '30 days')
                or (m.status = 'sold' and m.sold_at < now() - interval '60 days')
                or (m.status = 'hidden' and m.hidden_at < now() - interval '180 days')) for update loop
    update market_photo_slots s set gone_at = now()
     where s.gone_at is null and (s.listing_id = l.id or s.name in (select jsonb_array_elements_text(l.photos)));
    get diagnostics n = row_count; v_gone := v_gone + n;
    update market_listings set photos = '[]'::jsonb where id = l.id;
  end loop;
  -- ... files whose listing and shop are no more (their account was closed)
  update market_photo_slots s set gone_at = now() where s.gone_at is null and s.listing_id is null and s.shop_id is null;
  get diagnostics n = row_count; v_gone := v_gone + n;
  -- ... and files stored a day ago that no listing's photos and no shop's logo names
  update market_photo_slots s set gone_at = now()
   where s.gone_at is null and coalesce(s.used_at, s.small_at) < now() - interval '1 day'
     and not exists (select 1 from market_listings m where m.id = s.listing_id and m.photos ? s.name)
     and not exists (select 1 from market_shops sh where sh.id = s.shop_id and sh.logo = s.name);
  get diagnostics n = row_count; v_gone := v_gone + n;

  -- 4. names issued and never used, after a day; rows of files seen gone 30 days ago
  delete from market_photo_slots s where s.used_at is null and s.small_at is null and s.created_at < now() - interval '1 day';
  get diagnostics n = row_count; v_slots := v_slots + n;
  delete from market_photo_slots s where s.purged_at < now() - interval '30 days';
  get diagnostics n = row_count; v_slots := v_slots + n;

  -- 5. threads 12 months after their last message (their messages go with them)
  delete from market_threads t where t.last_at < now() - interval '12 months';
  get diagnostics v_threads = row_count;

  -- 6. a file is waiting to be removed: the website does it
  if exists (select 1 from market_photo_slots s where s.gone_at is not null and s.purged_at is null)
     and exists (select 1 from pg_extension where extname = 'pg_net') then
    perform net.http_post(url := 'https://micromobility.sa/api/market/purge', body := '{}'::jsonb,
                          headers := '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds := 20000);
    v_post := true;
  end if;
  return jsonb_build_object('closed', v_closed, 'expired', v_expired, 'deleted', v_deleted, 'photos_gone', v_gone,
                            'slots_cleared', v_slots, 'threads_deleted', v_threads, 'purge_asked', v_post);
end $$;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- 21:40 UTC is 00:40 in Riyadh. Left alone when it is already there as written, so a second run changes nothing.
    if not exists (select 1 from cron.job where jobname = 'mm-market-tick' and schedule = '40 21 * * *'
                      and command = 'select public._mkt_tick()') then
      if exists (select 1 from cron.job where jobname = 'mm-market-tick') then perform cron.unschedule('mm-market-tick'); end if;
      perform cron.schedule('mm-market-tick', '40 21 * * *', 'select public._mkt_tick()');
    end if;
  end if;
end $cron$;

-- ── 7. Who may run what ──────────────────────────────────────────────────────────────────────────────────────────
-- Customers' and the public's functions: the public key (they check the session themselves). Every _mkt_ helper:
-- nobody outside, except the two a storage policy calls as the uploader.
do $grants$
declare f text; r record;
begin
  foreach f in array array[
    'public.market_me(text,text)', 'public.market_listing_save(text,text,bigint,jsonb)',
    'public.market_photo_slot(text,text,text,bigint,text)', 'public.market_listing_publish(text,text,bigint,text,boolean,text)',
    'public.market_listing_state(text,text,bigint,text,integer)', 'public.market_my_listings(text,text)',
    'public.market_browse(jsonb)', 'public.market_listing_get(bigint,text,text)', 'public.market_shop_get(text)',
    'public.market_shops()', 'public.market_index()', 'public.market_purge_take(integer)',
    'public.market_shop_contact(text,text,text)', 'public.market_shop_apply(text,text,jsonb)', 'public.market_shop_mine(text,text)',
    'public.market_thread_open(text,text,bigint,text,text)', 'public.market_thread_send(text,text,bigint,text)',
    'public.market_threads(text,text)', 'public.market_thread_get(text,text,bigint,bigint)',
    'public.market_share_whatsapp(text,text,bigint)', 'public.market_unread(text,text)',
    'public.market_report(text,text,text,bigint,text,text)', 'public.market_block(text,text,bigint,boolean)'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
  for r in select p.oid::regprocedure::text as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname like '\_mkt\_%'
              and p.proname not in ('_mkt_photo_take', '_mkt_photo_gone') loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $grants$;

-- ── 8. Checks ────────────────────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text; tb text; r record;
begin
  -- every function kept SECURITY DEFINER and its search_path
  foreach f in array array[
    'public._staff_mod(text,boolean)',
    'public.market_me(text,text)', 'public.market_listing_save(text,text,bigint,jsonb)',
    'public.market_photo_slot(text,text,text,bigint,text)', 'public.market_listing_publish(text,text,bigint,text,boolean,text)',
    'public.market_listing_state(text,text,bigint,text,integer)', 'public.market_my_listings(text,text)',
    'public.market_browse(jsonb)', 'public.market_listing_get(bigint,text,text)', 'public.market_shop_get(text)',
    'public.market_shops()', 'public.market_index()', 'public.market_purge_take(integer)',
    'public.market_shop_contact(text,text,text)', 'public.market_shop_apply(text,text,jsonb)', 'public.market_shop_mine(text,text)',
    'public.market_thread_open(text,text,bigint,text,text)', 'public.market_thread_send(text,text,bigint,text)',
    'public.market_threads(text,text)', 'public.market_thread_get(text,text,bigint,bigint)',
    'public.market_share_whatsapp(text,text,bigint)', 'public.market_unread(text,text)',
    'public.market_report(text,text,text,bigint,text,text)', 'public.market_block(text,text,bigint,boolean)',
    'public._mkt_photo_take(text,text)', 'public._mkt_photo_gone(text)', 'public._mkt_tick()',
    'public._mkt_enter(text,text,boolean)', 'public._mkt_limits(text)', 'public._mkt_established(text)',
    'public._mkt_listing_removed()', 'public._mkt_listing_stamp()', 'public._mkt_category_guard()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  for r in select p.oid, p.oid::regprocedure::text as sig, p.proname, p.proconfig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and (p.proname like '\_mkt\_%' or p.proname like 'market\_%') loop
    if not exists (select 1 from unnest(coalesce(r.proconfig, '{}')) c where c like 'search_path=%') then
      raise exception '% has no search_path', r.sig;
    end if;
    -- no helper is executable by a client (the two a storage policy calls are, on purpose)
    if r.proname like '\_mkt\_%' and r.proname not in ('_mkt_photo_take', '_mkt_photo_gone')
       and (has_function_privilege('anon', r.oid, 'execute') or has_function_privilege('authenticated', r.oid, 'execute')) then
      raise exception '% is executable by a client', r.sig;
    end if;
    if r.proname like 'market\_%' and not has_function_privilege('anon', r.oid, 'execute') then
      raise exception 'the website cannot reach %', r.sig;
    end if;
  end loop;
  if has_function_privilege('anon', 'public._staff_mod(text,boolean)', 'execute') then
    raise exception '_staff_mod is executable by anon';
  end if;
  if not has_function_privilege('anon', 'public._mkt_photo_take(text,text)', 'execute')
     or not has_function_privilege('anon', 'public._mkt_photo_gone(text)', 'execute') then
    raise exception 'the storage policies cannot run their checks';
  end if;
  -- every table: row level security on, nothing for a client but reading the categories
  foreach tb in array array['market_categories', 'market_sellers', 'market_shops', 'market_listings', 'market_photo_slots',
                            'market_threads', 'market_messages', 'market_reports', 'market_blocks', 'market_events'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || tb)::regclass) then
      raise exception '% has no row level security', tb;
    end if;
    if has_table_privilege('anon', 'public.' || tb, 'insert') or has_table_privilege('anon', 'public.' || tb, 'update')
       or has_table_privilege('anon', 'public.' || tb, 'delete') or has_table_privilege('authenticated', 'public.' || tb, 'insert')
       or has_table_privilege('authenticated', 'public.' || tb, 'update') or has_table_privilege('authenticated', 'public.' || tb, 'delete') then
      raise exception '% is writable by a client', tb;
    end if;
    if tb <> 'market_categories'
       and (has_table_privilege('anon', 'public.' || tb, 'select') or has_table_privilege('authenticated', 'public.' || tb, 'select')) then
      raise exception '% is readable by a client', tb;
    end if;
    if tb <> 'market_categories' and exists (select 1 from pg_policies where schemaname = 'public' and tablename = tb) then
      raise exception '% has a policy: it is reached through its functions only', tb;
    end if;
  end loop;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'market_categories') <> 2 then
    raise exception 'market_categories does not have its two read policies';
  end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'market photos %') <> 5 then
    raise exception 'the bucket does not have its five policies';
  end if;
  if not exists (select 1 from storage.buckets b where b.id = 'market' and b.public and b.file_size_limit = 800000) then
    raise exception 'the bucket market is missing';
  end if;
  -- the settings and the seed
  if (select count(*) from site_content where key in ('marketplace.on', 'marketplace.commission_pct', 'marketplace.commission_how',
        'marketplace.limits', 'marketplace.listing_days', 'marketplace.blocked_words', 'marketplace.auto_hold_reports',
        'marketplace.terms_version')) <> 8 then
    raise exception 'a marketplace setting is missing';
  end if;
  if (select count(*) from market_categories where parent is null) < 15
     or (select count(*) from market_categories where parent is not null) < 97 then
    raise exception 'the seed categories are not all there';
  end if;
  -- the mapping, and the small rules the pages share
  if position('''market''' in pg_get_functiondef('public._staff_mod(text,boolean)'::regprocedure)) = 0 then
    raise exception '_staff_mod does not map market';
  end if;
  if not _mkt_has_phone('call 0501234567') or not _mkt_has_phone('+966 50 123 4567') or _mkt_has_phone('size 54, 2021, 12500')
     or _mkt_word_hit('an elbow pad') is not null or _mkt_digits('050 123 4567') <> '966501234567'
     or floor(1250 * 1.00 / 100 + 0.5)::integer <> 13 then
    raise exception 'a small rule does not read as written';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261121300000', 'marketplace')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only): 10 tables with RLS, 2 + 5 policies, the functions, the bucket, the 8 settings, the categories,
-- the job, the ledger.
-- select (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname like 'market\_%' and relrowsecurity) as tables_rls_10,
--        (select count(*) from pg_policies where schemaname = 'public' and tablename = 'market_categories') as category_policies_2,
--        (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'market photos %') as storage_policies_5,
--        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'market\_%') as public_functions_23,
--        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '\_mkt\_%') as helpers,
--        has_function_privilege('anon', 'public.market_browse(jsonb)', 'execute') as anon_browse_true,
--        has_function_privilege('anon', 'public._mkt_limits(text)', 'execute') as anon_helper_false,
--        has_table_privilege('anon', 'public.market_listings', 'select') as anon_table_false,
--        has_table_privilege('anon', 'public.market_categories', 'select') as anon_categories_true,
--        (select public from storage.buckets where id = 'market') as bucket_public_true,
--        (select count(*) from site_content where key like 'marketplace.%') as settings_8,
--        (select value from site_content where key = 'marketplace.on') as switch,
--        (select count(*) from market_categories where parent is null) as sports_15,
--        (select count(*) from market_categories where parent is not null) as product_types_97,
--        (select count(*) from cron.job where jobname = 'mm-market-tick') as job_1,
--        (select name from supabase_migrations.schema_migrations where version = '20261121300000') as ledger;
