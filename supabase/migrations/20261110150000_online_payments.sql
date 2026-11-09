-- Online payments (Moyasar) and the online store (2026-11-10).
--
-- The user, 2026-11-10: "implement the store and experiences in the staging website and anything that
-- has payment" (staging first; Moyasar test keys). Answers: paid rides on the website are PAID NOW
-- (the place is held while the rider pays and released by itself when unpaid), wallet top-up by card
-- behind a switch (off), store delivery = showroom pickup + Jeddah + the rest of Saudi Arabia, and a
-- staff side in the staff app.
--
-- How the money moves (trust model):
--  * The browser shows Moyasar's own form with the PUBLISHABLE key. It never decides an amount or that
--    something is paid: the amount is written here, from rows the database priced, when a payment starts.
--  * The website's server (mm-platform, a Cloudflare Worker) holds Moyasar's SECRET key and a server key
--    whose sha256 is in pay_server_keys. Every pay_* / store_checkout function below that changes money
--    takes that key (p_key) and refuses without it, so a visitor calling them with the public key gets
--    nothing. The server fetches each Moyasar payment itself (never trusting the redirect or the webhook
--    body), checks amount, currency and metadata, then calls pay_settle, which is idempotent.
--  * Staff refund to a card through the website's server (it holds the secret key): staff_pay_refund_begin
--    (admin, can_refund, PIN, manager limit) writes a pending refund, the server asks Moyasar, and
--    pay_refund_done records the answer. A refund into the wallet is done here at once.
--
-- One table of payments for every kind: order (store), booking (rides), locker, topup (wallet), workshop.
-- A payment is 'initiated' until settled; its expires_at is the hold. pg_cron (mm-pay-tick, every minute)
-- expires unpaid payments two minutes after their hold and releases what they held: bookings are
-- cancelled (cancel_reason 'unpaid'), a store order is cancelled and its stock put back, a locker freed.
-- Money that arrives after a release is applied when the place / stock / locker is still free, else it is
-- refunded (pay_settle answers action 'refund').
--
-- Amounts are SAR, VAT included (the store's and the rides' prices are VAT-inclusive, as the fares are).

begin;

-- ── Settings (site_content: public read, admin write; the staff page's Website editor edits them) ──────
-- pay.enabled false here: production gets nothing until staff switch it on. Staging is switched on by the
-- separate staging block handed with this migration.
insert into public.site_content (key, value) values
  ('pay.enabled', 'false'::jsonb),
  ('pay.bookings', '"required"'::jsonb),        -- required | optional | off (pay at the desk only)
  ('pay.holdMinutes', '15'::jsonb),            -- a place held while the rider pays
  ('pay.refundDays', '1'::jsonb),              -- cancel at least this many days before the ride for a refund
  ('pay.topup', 'false'::jsonb),               -- wallet top-up by card (SAMA/legal check before live)
  ('pay.topupMin', '20'::jsonb),
  ('pay.topupMax', '1000'::jsonb),
  ('store.open', 'false'::jsonb),
  ('store.orderMinutes', '30'::jsonb),         -- stock held for an unpaid order
  -- delivery as the store states it today (free to every region, pickup in Jeddah); days are placeholders the owner sets
  ('store.delivery', '{"pickup":{"on":true,"fee":0},"jeddah":{"on":true,"fee":0,"days":"1-2"},"ksa":{"on":true,"fee":0,"days":"4-7"},"freeOver":null}'::jsonb)
on conflict (key) do nothing;

create or replace function public._pay_setting(p_key text) returns jsonb
language sql stable security definer set search_path = public as $$
  select value from site_content where key = p_key
$$;
revoke execute on function public._pay_setting(text) from public, anon, authenticated;

create or replace function public._pay_int(p_key text, p_default int, p_min int, p_max int) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select case when jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric)
                                    and (v #>> '{}')::numeric between p_min and p_max then (v #>> '{}')::int end
                     from (select _pay_setting(p_key) v) x), p_default)
$$;
revoke execute on function public._pay_int(text, int, int, int) from public, anon, authenticated;

create or replace function public._pay_on(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(_pay_setting(p_key) = 'true'::jsonb, false)
$$;
revoke execute on function public._pay_on(text) from public, anon, authenticated;

-- ── The server key ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.pay_server_keys (
  key_hash   text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  label      text check (label is null or length(label) <= 60),
  created_at timestamptz not null default now()
);
alter table public.pay_server_keys enable row level security;
revoke all on public.pay_server_keys from anon, authenticated;

create or replace function public._pay_key_ok(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(length(p_key) between 32 and 200, false)
     and exists (select 1 from pay_server_keys k where k.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex'))
$$;
revoke execute on function public._pay_key_ok(text) from public, anon, authenticated;

-- ── Payments ──────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.payments (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('order', 'booking', 'locker', 'topup', 'workshop')),
  ref         text not null check (length(ref) <= 80),          -- what it pays: order id, first booking, job...
  refs        text[] not null default '{}',                      -- every booking / rental it pays
  lines       jsonb not null default '[]'::jsonb,                -- [{id, amount}] per ref, as started
  customer_id text,                                              -- null for a guest's store order
  amount      numeric(10,2) not null check (amount >= 1 and amount <= 100000),
  currency    text not null default 'SAR' check (currency = 'SAR'),
  description text not null check (length(description) between 1 and 120),
  hold        boolean not null default false,                    -- releases what it pays when it expires
  status      text not null default 'initiated'
              check (status in ('initiated', 'paid', 'expired', 'cancelled', 'refunded', 'partly_refunded')),
  provider    text not null default 'moyasar',
  provider_id text,                                              -- the Moyasar payment that paid it
  method      text check (method is null or length(method) <= 20),   -- creditcard applepay stcpay samsungpay
  brand       text check (brand is null or length(brand) <= 20),     -- mada visa mastercard amex
  last4       text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  message     text check (message is null or length(message) <= 200), -- the last refusal, as the gateway said it
  refunded    numeric(10,2) not null default 0 check (refunded >= 0),  -- refunded to the card at the gateway
  expires_at  timestamptz not null,
  paid_at     timestamptz,
  receipt_id  text unique,                                       -- 'pay-<id>': its number in receipt_numbers
  lang        text check (lang is null or lang ~ '^[a-z]{2}$'),
  checked_at  timestamptz,                                       -- the server last asked Moyasar about it
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists payments_customer on public.payments (customer_id, created_at desc);
create index if not exists payments_open on public.payments (expires_at) where status = 'initiated';
create index if not exists payments_ref on public.payments (kind, ref);
create index if not exists payments_provider on public.payments (provider_id);

-- Every Moyasar payment tried for one of ours (a declined card, then another): the paid one settles it.
create table if not exists public.payment_attempts (
  provider_id text primary key check (length(provider_id) between 8 and 80),
  payment_id  uuid not null references public.payments (id) on delete cascade,
  status      text not null check (length(status) <= 20),
  amount      numeric(10,2) not null,
  method      text,
  message     text check (message is null or length(message) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists payment_attempts_payment on public.payment_attempts (payment_id);

create table if not exists public.payment_events (
  id          bigserial primary key,
  payment_id  uuid not null references public.payments (id) on delete cascade,
  at          timestamptz not null default now(),
  source      text not null check (source in ('start', 'attach', 'return', 'webhook', 'reconcile', 'tick', 'staff', 'refund', 'customer')),
  status      text check (status is null or length(status) <= 30),
  provider_id text,
  note        text check (note is null or length(note) <= 300)
);
create index if not exists payment_events_payment on public.payment_events (payment_id, id);

create table if not exists public.payment_refunds (
  id          uuid primary key default gen_random_uuid(),
  payment_id  uuid not null references public.payments (id) on delete cascade,
  provider_id text,                                              -- the Moyasar payment to refund (card)
  amount      numeric(10,2) not null check (amount > 0),
  dest        text check (dest is null or dest in ('card', 'wallet', 'none')),  -- null while due
  status      text not null default 'due' check (status in ('due', 'pending', 'done', 'failed', 'declined')),
  reason      text check (reason is null or length(reason) <= 200),
  booking_id  text,
  order_id    uuid,
  by_user     uuid,
  by_name     text check (by_name is null or length(by_name) <= 60),
  error       text check (error is null or length(error) <= 300),
  created_at  timestamptz not null default now(),
  done_at     timestamptz
);
create index if not exists payment_refunds_open on public.payment_refunds (status, created_at) where status in ('due', 'pending', 'failed');
create index if not exists payment_refunds_payment on public.payment_refunds (payment_id);

-- Bookings, lockers, the workshop: what holds them and what paid them.
alter table public.queue_entries add column if not exists pay_hold_until timestamptz;
alter table public.queue_entries add column if not exists payment_id uuid;
create index if not exists queue_entries_pay_hold on public.queue_entries (pay_hold_until) where pay_hold_until is not null;
create index if not exists queue_entries_payment on public.queue_entries (payment_id) where payment_id is not null;

alter table public.locker_rentals add column if not exists payment_id uuid;
alter table public.locker_rentals drop constraint if exists locker_rentals_pay_check;
alter table public.locker_rentals add constraint locker_rentals_pay_check check (pay is null or pay in ('desk', 'wallet', 'card'));

alter table public.workshop_jobs add column if not exists payment_id uuid;

alter table public.wallet_ledger drop constraint if exists wallet_ledger_method_check;
alter table public.wallet_ledger add constraint wallet_ledger_method_check
  check (method is null or method in ('card', 'cash', 'transfer', 'split', 'online'));

-- ── The store ─────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.store_products (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique check (slug ~ '^[a-z][a-z0-9-]{1,60}$'),
  category       text not null check (category in ('bikes', 'accessories', 'apparel', 'parts', 'nutrition', 'gift')),
  brand          text check (brand is null or length(brand) <= 40),
  name_en        text not null check (length(name_en) between 1 and 80),
  name_ar        text check (name_ar is null or length(name_ar) <= 80),
  tagline_en     text check (tagline_en is null or length(tagline_en) <= 140),
  tagline_ar     text check (tagline_ar is null or length(tagline_ar) <= 140),
  description_en text check (description_en is null or length(description_en) <= 4000),
  description_ar text check (description_ar is null or length(description_ar) <= 4000),
  specs          jsonb not null default '[]'::jsonb check (jsonb_typeof(specs) = 'array' and pg_column_size(specs) < 8000),  -- [{en:[k,v], ar:[k,v]}]
  images         text[] not null default '{}' check (coalesce(array_length(images, 1), 0) <= 12),
  price          numeric(10,2) not null check (price > 0 and price <= 100000),   -- VAT included
  compare_at     numeric(10,2) check (compare_at is null or compare_at > price), -- a real former price only
  ship_ksa       boolean not null default true,     -- false: pickup or Jeddah delivery only (bikes)
  catalog_model  uuid,                              -- the bike catalogue's model, when it is one
  published      boolean not null default false,
  sort           int not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create table if not exists public.store_variants (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.store_products (id) on delete cascade,
  sku         text unique check (sku is null or sku ~ '^[A-Za-z0-9._-]{1,40}$'),
  size        text check (size is null or length(size) <= 20),
  color_en    text check (color_en is null or length(color_en) <= 30),
  color_ar    text check (color_ar is null or length(color_ar) <= 30),
  color_hex   text check (color_hex is null or color_hex ~ '^#[0-9a-fA-F]{6}$'),
  price       numeric(10,2) check (price is null or (price > 0 and price <= 100000)),  -- null: the product's
  stock       int not null default 0 check (stock >= 0),     -- what can still be sold (orders hold theirs)
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists store_variants_product on public.store_variants (product_id, sort);

create sequence if not exists public.store_order_no_seq start 1001;
create table if not exists public.store_orders (
  id           uuid primary key default gen_random_uuid(),
  no           bigint not null unique default nextval('public.store_order_no_seq'),
  track_key    text not null default replace(gen_random_uuid()::text, '-', ''),
  customer_id  text,
  status       text not null default 'pending'
               check (status in ('pending', 'paid', 'preparing', 'ready', 'shipped', 'delivered', 'cancelled', 'refunded')),
  fulfil       text not null check (fulfil in ('pickup', 'jeddah', 'ksa')),
  name         text not null check (length(name) between 2 and 60),
  phone        text not null check (phone ~ '^9665[0-9]{8}$'),
  email        text check (email is null or (length(email) <= 120 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  address      jsonb check (address is null or (jsonb_typeof(address) = 'object' and pg_column_size(address) < 2000)),
  note         text check (note is null or length(note) <= 300),
  subtotal     numeric(10,2) not null,
  delivery_fee numeric(10,2) not null default 0,
  total        numeric(10,2) not null,
  wallet_paid  numeric(10,2) not null default 0,
  payment_id   uuid,
  lang         text,
  courier      text check (courier is null or length(courier) <= 30),
  tracking_no  text check (tracking_no is null or length(tracking_no) <= 60),
  staff_note   text check (staff_note is null or length(staff_note) <= 500),
  cancel_reason text check (cancel_reason is null or cancel_reason ~ '^[a-z_]{1,24}$'),
  expires_at   timestamptz,
  paid_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists store_orders_customer on public.store_orders (customer_id, created_at desc);
create index if not exists store_orders_status on public.store_orders (status, created_at desc);

create table if not exists public.store_order_items (
  id          bigserial primary key,
  order_id    uuid not null references public.store_orders (id) on delete cascade,
  product_id  uuid,
  variant_id  uuid,
  name        text not null,              -- as sold: the product's name then
  variant     text,                       -- "M · Black"
  unit_price  numeric(10,2) not null,
  qty         int not null check (qty between 1 and 10),
  held        boolean not null default true   -- its stock is out of store_variants.stock
);
create index if not exists store_order_items_order on public.store_order_items (order_id);

create table if not exists public.store_order_events (
  id        bigserial primary key,
  order_id  uuid not null references public.store_orders (id) on delete cascade,
  at        timestamptz not null default now(),
  status    text not null,
  note      text check (note is null or length(note) <= 300),
  public    boolean not null default true,   -- shown to the customer on the order's page
  by_name   text
);
create index if not exists store_order_events_order on public.store_order_events (order_id, id);

-- Who reads what. Customers and guests reach their own orders and payments only through the functions.
alter table public.payments enable row level security;
alter table public.payment_attempts enable row level security;
alter table public.payment_events enable row level security;
alter table public.payment_refunds enable row level security;
alter table public.store_products enable row level security;
alter table public.store_variants enable row level security;
alter table public.store_orders enable row level security;
alter table public.store_order_items enable row level security;
alter table public.store_order_events enable row level security;

revoke all on public.payments, public.payment_attempts, public.payment_events, public.payment_refunds,
              public.store_orders, public.store_order_items, public.store_order_events,
              public.store_products, public.store_variants from anon, authenticated;
revoke all on sequence public.store_order_no_seq from anon, authenticated;

drop policy if exists "payments staff read" on public.payments;
create policy "payments staff read" on public.payments for select to authenticated using ((select is_staff()));
drop policy if exists "payment attempts staff read" on public.payment_attempts;
create policy "payment attempts staff read" on public.payment_attempts for select to authenticated using ((select is_staff()));
drop policy if exists "payment events staff read" on public.payment_events;
create policy "payment events staff read" on public.payment_events for select to authenticated using ((select is_staff()));
drop policy if exists "payment refunds staff read" on public.payment_refunds;
create policy "payment refunds staff read" on public.payment_refunds for select to authenticated using ((select is_staff()));
drop policy if exists "store orders staff read" on public.store_orders;
create policy "store orders staff read" on public.store_orders for select to authenticated using ((select is_staff()));
drop policy if exists "store order items staff read" on public.store_order_items;
create policy "store order items staff read" on public.store_order_items for select to authenticated using ((select is_staff()));
drop policy if exists "store order events staff read" on public.store_order_events;
create policy "store order events staff read" on public.store_order_events for select to authenticated using ((select is_staff()));
grant select on public.payments, public.payment_attempts, public.payment_events, public.payment_refunds,
                public.store_orders, public.store_order_items, public.store_order_events to authenticated;

-- Products: anyone reads what is published; admins write (the staff page's Store > Products).
drop policy if exists "store products public read" on public.store_products;
create policy "store products public read" on public.store_products for select to anon, authenticated
  using (published or (select is_staff()));
drop policy if exists "store products admin insert" on public.store_products;
create policy "store products admin insert" on public.store_products for insert to authenticated with check ((select is_admin()));
drop policy if exists "store products admin update" on public.store_products;
create policy "store products admin update" on public.store_products for update to authenticated using ((select is_admin())) with check ((select is_admin()));
drop policy if exists "store products admin delete" on public.store_products;
create policy "store products admin delete" on public.store_products for delete to authenticated using ((select is_admin()));
drop policy if exists "store variants public read" on public.store_variants;
create policy "store variants public read" on public.store_variants for select to anon, authenticated
  using ((select is_staff()) or (active and exists (select 1 from store_products p where p.id = product_id and p.published)));
drop policy if exists "store variants admin insert" on public.store_variants;
create policy "store variants admin insert" on public.store_variants for insert to authenticated with check ((select is_admin()));
drop policy if exists "store variants admin update" on public.store_variants;
create policy "store variants admin update" on public.store_variants for update to authenticated using ((select is_admin())) with check ((select is_admin()));
drop policy if exists "store variants admin delete" on public.store_variants;
create policy "store variants admin delete" on public.store_variants for delete to authenticated using ((select is_admin()));
grant select on public.store_products, public.store_variants to anon;
grant select, insert, update, delete on public.store_products, public.store_variants to authenticated;

create or replace function public._store_touch() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
revoke all on function public._store_touch() from public, anon, authenticated;
drop trigger if exists store_products_touch on public.store_products;
create trigger store_products_touch before update on public.store_products for each row execute function _store_touch();
drop trigger if exists store_variants_touch on public.store_variants;
create trigger store_variants_touch before update on public.store_variants for each row execute function _store_touch();
drop trigger if exists store_orders_touch on public.store_orders;
create trigger store_orders_touch before update on public.store_orders for each row execute function _store_touch();
drop trigger if exists payments_touch on public.payments;
create trigger payments_touch before update on public.payments for each row execute function _store_touch();

-- ── Small helpers ─────────────────────────────────────────────────────────────────────────────────
create or replace function public._pay_today() returns date
language sql stable set search_path = public as $$ select (now() at time zone 'Asia/Riyadh')::date $$;
revoke execute on function public._pay_today() from public, anon, authenticated;

create or replace function public._pay_due(q queue_entries) returns numeric
language sql stable security definer set search_path = public as $$
  select greatest(round(_wallet_amount(q.price, q.addons) - coalesce(q.wallet_paid, 0), 2), 0)
$$;
revoke execute on function public._pay_due(queue_entries) from public, anon, authenticated;

create or replace function public._pay_event(p_pay uuid, p_source text, p_status text, p_provider text, p_note text) returns void
language sql security definer set search_path = public as $$
  insert into payment_events (payment_id, source, status, provider_id, note)
  values (p_pay, p_source, left(p_status, 30), left(p_provider, 80), left(p_note, 300))
$$;
revoke execute on function public._pay_event(uuid, text, text, text, text) from public, anon, authenticated;

-- A Saudi mobile, written any way (05.., 5.., +9665.., 009665.., Arabic-Indic digits) -> 9665XXXXXXXX, or null.
create or replace function public._pay_phone(p text) returns text
language sql immutable set search_path = public as $$
  select case when d ~ '^(00966|966|0)?5[0-9]{8}$' then '966' || right(d, 9) end
    from (select regexp_replace(translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '\D', '', 'g') d) x
$$;
revoke execute on function public._pay_phone(text) from public, anon, authenticated;

create or replace function public._pay_new(p_kind text, p_ref text, p_refs text[], p_lines jsonb, p_customer text,
                                           p_amount numeric, p_desc text, p_minutes int, p_hold boolean, p_lang text)
returns payments
language plpgsql security definer set search_path = public as $$
declare p payments%rowtype;
begin
  insert into payments (kind, ref, refs, lines, customer_id, amount, description, hold, expires_at, lang)
  values (p_kind, left(p_ref, 80), coalesce(p_refs, '{}'), coalesce(p_lines, '[]'::jsonb), p_customer, round(p_amount, 2),
          left(p_desc, 120), p_hold, now() + make_interval(mins => p_minutes),
          case when p_lang ~ '^[a-z]{2}$' then p_lang end)
  returning * into p;
  perform _pay_event(p.id, 'start', 'initiated', null, p_desc);
  return p;
end $$;
revoke execute on function public._pay_new(text, text, text[], jsonb, text, numeric, text, int, boolean, text) from public, anon, authenticated;

-- What a payment looks like to the page that takes it and to the account.
create or replace function public._pay_json(p payments) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', p.id, 'kind', p.kind, 'ref', p.ref, 'amount', p.amount, 'currency', p.currency,
    'description', p.description, 'status', p.status, 'hold', p.hold, 'expires_at', p.expires_at, 'paid_at', p.paid_at,
    'method', p.method, 'brand', p.brand, 'last4', p.last4, 'message', p.message, 'refunded', p.refunded,
    'receipt_no', (select r.no from receipt_numbers r where r.receipt_id = p.receipt_id), 'created_at', p.created_at)
$$;
revoke execute on function public._pay_json(payments) from public, anon, authenticated;

-- ── Starting a payment: rides ─────────────────────────────────────────────────────────────────────
-- The rider's own unpaid bookings (waiting or on a bike; never a waitlisted place, a race, a Petromin
-- night, a free ride). p_hold: the places are held for pay.holdMinutes and released when unpaid (a
-- booking just made on the website); without it (paying an older booking from its ticket) nothing is
-- released. p_wallet: the wallet pays what it can first (the rider's switch). A payment already open for
-- exactly these bookings is handed back instead of a second one.
create or replace function public.pay_booking_start(p_key text, p_id text, p_token text, p_ids text[],
                                                    p_hold boolean default false, p_wallet boolean default false,
                                                    p_lang text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare q queue_entries%rowtype; s sessions%rowtype; ids text[]; lines jsonb := '[]'::jsonb; total numeric := 0;
        due numeric; p payments%rowtype; mins int; bid text; days text; kinds text;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _pay_on('pay.enabled') then raise exception 'PAY_OFF' using errcode = 'P0001'; end if;
  select array_agg(distinct x order by x) into ids from unnest(coalesce(p_ids, '{}'::text[])) x where x ~ '^[A-Za-z0-9_-]{1,64}$';
  if coalesce(array_length(ids, 1), 0) = 0 or array_length(ids, 1) > 20 then raise exception 'PAY_NOTHING' using errcode = 'P0001'; end if;

  -- these bookings already being paid: that payment again (a reload, a second tap); a payment open for
  -- some of them and others is refused rather than charging a booking twice
  select * into p from payments
   where kind = 'booking' and status = 'initiated' and customer_id = p_id and expires_at > now() and refs && ids
   order by created_at desc limit 1;
  if p.id is not null then
    if p.refs <@ ids then return _pay_json(p); end if;
    raise exception 'PAY_IN_PROGRESS' using errcode = 'P0001';
  end if;

  if p_wallet then
    begin  -- the wallet pays what it can (the rider's switch); what it may not pay is left to the card
      perform customer_wallet_pay(p_id, p_token, ids);
    exception when others then null;
    end;
  end if;

  foreach bid in array ids loop
    select * into q from queue_entries where id = bid and customer_id = p_id for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    select * into s from sessions where id = q.session_id;
    if coalesce(q.paid, false) then continue; end if;
    if coalesce(q.status, '') not in ('waiting', 'active') then raise exception 'PAY_NOT_OPEN' using errcode = 'P0001'; end if;
    if coalesce(s.ride_kind, '') in ('petromin', 'vlap', 'arena') then raise exception 'PAY_NOT_OPEN' using errcode = 'P0001'; end if;
    if left(coalesce(s.session_date, q.session_date), 10) < to_char(_pay_today(), 'YYYY-MM-DD') then
      raise exception 'PAY_NOT_OPEN' using errcode = 'P0001';
    end if;
    due := _pay_due(q);
    if due <= 0 then continue; end if;
    lines := lines || jsonb_build_array(jsonb_build_object('id', q.id, 'amount', due));
    total := total + due;
  end loop;

  if total <= 0 then
    return jsonb_build_object('id', null, 'amount', 0, 'status', 'paid');  -- nothing left to pay (the wallet covered it)
  end if;
  if total < 1 then raise exception 'PAY_TOO_SMALL' using errcode = 'P0001'; end if;

  mins := case when p_hold then _pay_int('pay.holdMinutes', 15, 5, 60) else 60 end;
  select string_agg(distinct coalesce(nullif(btrim(se.title), ''), 'Ride'), ', '),
         string_agg(distinct left(coalesce(se.session_date, e.session_date), 10), ', ')
    into kinds, days
    from queue_entries e left join sessions se on se.id = e.session_id
   where e.id in (select l ->> 'id' from jsonb_array_elements(lines) l);
  p := _pay_new('booking', lines -> 0 ->> 'id',
                array(select l ->> 'id' from jsonb_array_elements(lines) l order by 1), lines, p_id, total,
                left(coalesce(kinds, 'Ride') || ' · ' || coalesce(days, ''), 120), mins, p_hold, p_lang);
  update queue_entries set payment_id = p.id,
         pay_hold_until = case when p_hold then p.expires_at else pay_hold_until end
   where id = any(p.refs);
  return _pay_json(p);
end $$;
revoke execute on function public.pay_booking_start(text, text, text, text[], boolean, boolean, text) from public;
grant execute on function public.pay_booking_start(text, text, text, text[], boolean, boolean, text) to anon, authenticated;

-- ── Starting a payment: lockers (micromobility.sa/lockers, "Pay by card") ─────────────────────────
-- customer_locker_book(..., 'card', ...) reserved them; this asks for the money and holds them meanwhile.
create or replace function public.pay_locker_start(p_key text, p_id text, p_token text, p_rentals uuid[], p_lang text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r locker_rentals%rowtype; lines jsonb := '[]'::jsonb; total numeric := 0; p payments%rowtype; d date; codes text;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _pay_on('pay.enabled') then raise exception 'PAY_OFF' using errcode = 'P0001'; end if;
  if coalesce(array_length(p_rentals, 1), 0) = 0 or array_length(p_rentals, 1) > 3 then raise exception 'PAY_NOTHING' using errcode = 'P0001'; end if;
  for r in select * from locker_rentals where id = any(p_rentals) order by id for update loop
    if r.customer_id is distinct from p_id or r.status <> 'reserved' or r.pay is distinct from 'card'
       or r.receipt_id is not null or coalesce(r.price, 0) <= 0 then
      raise exception 'PAY_NOT_OPEN' using errcode = 'P0001';
    end if;
    lines := lines || jsonb_build_array(jsonb_build_object('id', r.id, 'amount', r.price));
    total := total + r.price; d := r.day;
  end loop;
  if jsonb_array_length(lines) <> array_length(p_rentals, 1) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select string_agg(l.code, ', ' order by l.code) into codes from locker_rentals x join lockers l on l.id = x.locker_id where x.id = any(p_rentals);
  p := _pay_new('locker', p_rentals[1]::text, array(select x::text from unnest(p_rentals) x order by 1), lines, p_id, total,
                left('Locker ' || coalesce(codes, '') || ' · ' || d::text, 120), _pay_int('pay.holdMinutes', 15, 5, 60), true, p_lang);
  update locker_rentals set payment_id = p.id where id = any(p_rentals);
  return _pay_json(p);
end $$;
revoke execute on function public.pay_locker_start(text, text, text, uuid[], text) from public;
grant execute on function public.pay_locker_start(text, text, text, uuid[], text) to anon, authenticated;

-- ── Starting a payment: wallet top-up (behind pay.topup) ──────────────────────────────────────────
create or replace function public.pay_topup_start(p_key text, p_id text, p_token text, p_amount numeric, p_lang text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare p payments%rowtype; lo int := _pay_int('pay.topupMin', 20, 1, 5000); hi int := _pay_int('pay.topupMax', 1000, 1, 10000);
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _pay_on('pay.enabled') or not _pay_on('pay.topup') then raise exception 'PAY_OFF' using errcode = 'P0001'; end if;
  if p_amount is null or p_amount <> trunc(p_amount) or p_amount < lo or p_amount > hi then
    raise exception 'PAY_AMOUNT' using errcode = 'P0001';
  end if;
  p := _pay_new('topup', p_id, '{}', '[]'::jsonb, p_id, p_amount, 'Wallet top-up', 60, false, p_lang);
  return _pay_json(p);
end $$;
revoke execute on function public.pay_topup_start(text, text, text, numeric, text) from public;
grant execute on function public.pay_topup_start(text, text, text, numeric, text) to anon, authenticated;

-- ── Starting a payment: a workshop job (the tracker's reference and phone, as workshop_track reads) ─
-- Open once staff set a final price and the job is ready or completed, and only while it is unpaid.
create or replace function public.pay_workshop_start(p_key text, p_ref text, p_phone text, p_lang text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_digits text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9); j workshop_jobs%rowtype; p payments%rowtype;
        v_ref text;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _pay_on('pay.enabled') then raise exception 'PAY_OFF' using errcode = 'P0001'; end if;
  if coalesce(p_ref, '') !~* '^\s*W-?0*([0-9]{1,9})\s*$' or length(v_digits) < 9 then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into j from workshop_jobs
   where id = (regexp_match(p_ref, '([0-9]{1,9})'))[1]::bigint and right(regexp_replace(phone, '\D', '', 'g'), 9) = v_digits
   for update;
  if j.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if j.paid_at is not null or coalesce(j.price_final, 0) < 1 or j.status not in ('ready', 'completed') then
    raise exception 'PAY_NOT_OPEN' using errcode = 'P0001';
  end if;
  v_ref := 'W-' || lpad(j.id::text, 4, '0');
  select * into p from payments x where x.kind = 'workshop' and x.ref = j.id::text and x.status = 'initiated' and x.expires_at > now()
     and x.amount = j.price_final order by created_at desc limit 1;
  if p.id is null then
    p := _pay_new('workshop', j.id::text, array[j.id::text], jsonb_build_array(jsonb_build_object('id', j.id::text, 'amount', j.price_final)),
                  j.customer_id, j.price_final, 'Workshop ' || v_ref || coalesce(' · ' || nullif(j.service_label, ''), ''), 60, false, p_lang);
    update workshop_jobs set payment_id = p.id where id = j.id;
  end if;
  return _pay_json(p);
end $$;
revoke execute on function public.pay_workshop_start(text, text, text, text) from public;
grant execute on function public.pay_workshop_start(text, text, text, text) to anon, authenticated;

-- ── The store: checkout ───────────────────────────────────────────────────────────────────────────
-- p_order: {items:[{variant, qty}], fulfil: pickup|jeddah|ksa, contact:{name, phone, email},
--           address:{city, district, street, building, postal, extra, short, notes} (delivery only),
--           note, wallet: bool, lang}. A guest (no account) gives a name and a Saudi mobile.
-- Prices are the database's. Stock is taken now and held store.orderMinutes for the payment.
create or replace function public._store_delivery_fee(p_fulfil text, p_subtotal numeric) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare d jsonb := coalesce(_pay_setting('store.delivery'), '{}'::jsonb); f numeric; free numeric;
begin
  if p_fulfil = 'pickup' then return 0; end if;
  if coalesce((d -> p_fulfil ->> 'on')::boolean, false) is not true then return null; end if;
  f := coalesce((d -> p_fulfil ->> 'fee')::numeric, 0);
  free := (d ->> 'freeOver')::numeric;
  if free is not null and free > 0 and p_subtotal >= free then return 0; end if;
  return greatest(f, 0);
end $$;
revoke execute on function public._store_delivery_fee(text, numeric) from public, anon, authenticated;

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
    'vat', round(o.total * 15 / 115, 2),
    'courier', o.courier, 'tracking_no', o.tracking_no, 'expires_at', o.expires_at, 'paid_at', o.paid_at,
    'created_at', o.created_at, 'cancel_reason', o.cancel_reason, 'payment_id', o.payment_id,
    'payment', (select _pay_json(p) from payments p where p.id = o.payment_id),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'variant', i.variant, 'qty', i.qty,
                         'unit_price', i.unit_price, 'product_id', i.product_id, 'variant_id', i.variant_id,
                         'image', (select sp.images[1] from store_products sp where sp.id = i.product_id),
                         'slug', (select sp.slug from store_products sp where sp.id = i.product_id)) order by i.id)
                       from store_order_items i where i.order_id = o.id), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('at', e.at, 'status', e.status, 'note', e.note, 'by', case when p_staff then e.by_name end,
                          'public', e.public) order by e.id)
                        from store_order_events e where e.order_id = o.id and (p_staff or e.public)), '[]'::jsonb),
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'dest', r.dest, 'status', r.status, 'at', coalesce(r.done_at, r.created_at)) order by r.created_at)
                         from payment_refunds r where r.order_id = o.id and (p_staff or r.status in ('pending', 'done'))), '[]'::jsonb))
$$;
revoke execute on function public._store_order_json(store_orders, boolean) from public, anon, authenticated;

create or replace function public._store_restock(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare i store_order_items%rowtype;
begin
  for i in select * from store_order_items where order_id = p_order and held order by id for update loop
    update store_variants set stock = stock + i.qty where id = i.variant_id;
    update store_order_items set held = false where id = i.id;
  end loop;
end $$;
revoke execute on function public._store_restock(uuid) from public, anon, authenticated;

create or replace function public.store_checkout(p_key text, p_id text, p_token text, p_order jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare it jsonb; v store_variants%rowtype; pr store_products%rowtype; n int := 0; qty int; sub numeric := 0; fee numeric;
        fulfil text := p_order ->> 'fulfil'; name text; phone text; email text; addr jsonb; o store_orders%rowtype;
        p payments%rowtype; due numeric; bal numeric; take numeric := 0; who text; lang text := p_order ->> 'lang';
        mins int := _pay_int('store.orderMinutes', 30, 10, 120); city text; label text;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _pay_on('pay.enabled') or not _pay_on('store.open') then raise exception 'STORE_CLOSED' using errcode = 'P0001'; end if;
  if p_id is not null and not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if fulfil is null or fulfil not in ('pickup', 'jeddah', 'ksa') then raise exception 'STORE_FULFIL' using errcode = 'P0001'; end if;

  name := left(btrim(regexp_replace(coalesce(p_order #>> '{contact,name}', ''), '\s+', ' ', 'g')), 60);
  phone := _pay_phone(p_order #>> '{contact,phone}');
  email := nullif(lower(btrim(coalesce(p_order #>> '{contact,email}', ''))), '');
  if length(name) < 2 then raise exception 'STORE_NAME' using errcode = 'P0001'; end if;
  if phone is null then raise exception 'STORE_PHONE' using errcode = 'P0001'; end if;
  if email is not null and (length(email) > 120 or email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then raise exception 'STORE_EMAIL' using errcode = 'P0001'; end if;

  if fulfil <> 'pickup' then
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
      addr := addr || jsonb_build_object('short', translate(addr ->> 'short', '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'));
      if (addr ->> 'short') !~ '^[A-Z]{4}[0-9]{4}$' then raise exception 'STORE_ADDRESS' using errcode = 'P0001'; end if;
    end if;
    -- a courier may not take a parcel without the national address since 2026-01-01 (TGA): its short code
    if fulfil = 'ksa' and not addr ? 'short' then raise exception 'STORE_ADDRESS' using errcode = 'P0001'; end if;
    if fulfil = 'jeddah' and city not in ('jeddah', 'jiddah', 'jedda', 'جدة', 'جده') then raise exception 'STORE_CITY' using errcode = 'P0001'; end if;
  end if;

  if jsonb_typeof(p_order -> 'items') <> 'array' or jsonb_array_length(p_order -> 'items') = 0 or jsonb_array_length(p_order -> 'items') > 20 then
    raise exception 'STORE_EMPTY' using errcode = 'P0001';
  end if;

  insert into store_orders (customer_id, fulfil, name, phone, email, address, note, subtotal, total, lang, expires_at)
  values (p_id, fulfil, name, phone, email, addr, left(nullif(btrim(coalesce(p_order ->> 'note', '')), ''), 300), 0, 0,
          case when lang ~ '^[a-z]{2}$' then lang end, now() + make_interval(mins => mins))
  returning * into o;

  -- each line: the variant locked, live and in stock, at the database's price
  for it in select x from jsonb_array_elements(p_order -> 'items') x order by x ->> 'variant' loop
    qty := case when (it ->> 'qty') ~ '^[0-9]{1,2}$' then (it ->> 'qty')::int else 0 end;
    if qty < 1 or qty > 10 or coalesce(it ->> 'variant', '') !~ '^[0-9a-f-]{36}$' then raise exception 'STORE_ITEM' using errcode = 'P0001'; end if;
    select * into v from store_variants where id = (it ->> 'variant')::uuid for update;
    select * into pr from store_products where id = v.product_id;
    if v.id is null or not v.active or pr.id is null or not pr.published then raise exception 'STORE_GONE: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if v.stock < qty then raise exception 'STORE_STOCK: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if fulfil = 'ksa' and not pr.ship_ksa then raise exception 'STORE_NO_SHIP: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if exists (select 1 from store_order_items i where i.order_id = o.id and i.variant_id = v.id) then raise exception 'STORE_ITEM' using errcode = 'P0001'; end if;
    update store_variants set stock = stock - qty where id = v.id;
    label := nullif(concat_ws(' · ', nullif(v.size, ''), nullif(case when lang = 'ar' then coalesce(v.color_ar, v.color_en) else v.color_en end, '')), '');
    insert into store_order_items (order_id, product_id, variant_id, name, variant, unit_price, qty)
    values (o.id, pr.id, v.id, case when lang = 'ar' then coalesce(pr.name_ar, pr.name_en) else pr.name_en end, label, coalesce(v.price, pr.price), qty);
    sub := sub + coalesce(v.price, pr.price) * qty; n := n + 1;
  end loop;

  fee := _store_delivery_fee(fulfil, sub);
  if fee is null then raise exception 'STORE_FULFIL' using errcode = 'P0001'; end if;
  update store_orders set subtotal = round(sub, 2), delivery_fee = fee, total = round(sub + fee, 2) where id = o.id returning * into o;

  -- the account's wallet pays what it can first, when the customer chose it
  if p_id is not null and coalesce((p_order ->> 'wallet')::boolean, false) then
    who := _wallet_owner(p_id);
    select coalesce(balance, 0) into bal from wallet_balances where customer_id = who for update;
    take := least(coalesce(bal, 0), o.total);
    if take > 0 then
      perform set_config('mm.wallet_op', 'Online store', true);
      perform _wallet_post(who, -take, 'sale', null, null, null, 'ord-' || o.no, null);
      perform set_config('mm.wallet_op', '', true);
      update store_orders set wallet_paid = take where id = o.id returning * into o;
    end if;
  end if;

  insert into store_order_events (order_id, status, note) values (o.id, 'pending', null);
  due := round(o.total - o.wallet_paid, 2);
  if due <= 0 then
    update store_orders set status = 'paid', paid_at = now(), expires_at = null where id = o.id returning * into o;
    insert into store_order_events (order_id, status, note) values (o.id, 'paid', 'wallet');
    insert into receipt_numbers (receipt_id) values ('ord-' || o.no) on conflict (receipt_id) do nothing;
    return jsonb_build_object('order', _store_order_json(o), 'key', o.track_key, 'payment', null);
  end if;
  if due < 1 then raise exception 'PAY_TOO_SMALL' using errcode = 'P0001'; end if;
  p := _pay_new('order', o.id::text, array[o.id::text], jsonb_build_array(jsonb_build_object('id', o.id, 'amount', due)),
                p_id, due, 'Order MM-' || o.no, mins, true, lang);
  update store_orders set payment_id = p.id, expires_at = p.expires_at where id = o.id returning * into o;
  return jsonb_build_object('order', _store_order_json(o), 'key', o.track_key, 'payment', _pay_json(p));
end $$;
revoke execute on function public.store_checkout(text, text, text, jsonb) from public;
grant execute on function public.store_checkout(text, text, text, jsonb) to anon, authenticated;

-- The order's page for the server (the link with its key, right after paying) ...
create or replace function public.store_order_get(p_key text, p_no bigint, p_track text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o store_orders%rowtype;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into o from store_orders where no = p_no and track_key = p_track;
  if o.id is null then return null; end if;
  return _store_order_json(o);
end $$;
revoke execute on function public.store_order_get(text, bigint, text) from public;
grant execute on function public.store_order_get(text, bigint, text) to anon, authenticated;

-- ... and for anyone with the order number and the phone it was placed with (Track order, metered per visitor).
create or replace function public.store_order_track(p_no text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; n bigint; ph text := _pay_phone(p_phone);
begin
  if not _ip_gate('storetrack', 30, interval '10 minutes') then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if coalesce(p_no, '') !~* '^\s*(MM-?)?0*([0-9]{1,9})\s*$' or ph is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  n := (regexp_match(p_no, '([0-9]{1,9})'))[1]::bigint;
  select * into o from store_orders where no = n and phone = ph;
  if o.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'order', _store_order_json(o), 'key', o.track_key);
end $$;
revoke execute on function public.store_order_track(text, text) from public;
grant execute on function public.store_order_track(text, text) to anon, authenticated;

create or replace function public.customer_orders(p_id text, p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _cust_token_ok(p_id, p_token) then return null; end if;
  return coalesce((select jsonb_agg(_store_order_json(o) || jsonb_build_object('key', o.track_key) order by o.created_at desc)
                     from (select * from store_orders where customer_id = p_id order by created_at desc limit 50) o), '[]'::jsonb);
end $$;
revoke execute on function public.customer_orders(text, text) from public;
grant execute on function public.customer_orders(text, text) to anon, authenticated;

create or replace function public.customer_payments(p_id text, p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _cust_token_ok(p_id, p_token) then return null; end if;
  return coalesce((select jsonb_agg(_pay_json(p) order by p.created_at desc)
                     from (select * from payments where customer_id = p_id and status <> 'initiated' order by created_at desc limit 50) p), '[]'::jsonb);
end $$;
revoke execute on function public.customer_payments(text, text) from public;
grant execute on function public.customer_payments(text, text) to anon, authenticated;

-- ── The page that takes a payment ─────────────────────────────────────────────────────────────────
-- Its address is the payment's id (unguessable); it shows what is paid, how much and until when.
create or replace function public.pay_view(p_key text, p_pay uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p payments%rowtype; o store_orders%rowtype; extra jsonb := '{}'::jsonb;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into p from payments where id = p_pay;
  if p.id is null then return null; end if;
  if p.kind = 'order' then
    select * into o from store_orders where id = p.ref::uuid;
    extra := jsonb_build_object('order_no', o.no, 'order_key', o.track_key, 'order_status', o.status,
                                'items', (_store_order_json(o)) -> 'items', 'delivery_fee', o.delivery_fee, 'wallet_paid', o.wallet_paid);
  elsif p.kind = 'booking' then
    extra := jsonb_build_object('rides', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'type', e.type_preference,
               'date', e.session_date, 'title', s.title, 'kind', s.ride_kind, 'status', e.status, 'paid', e.paid) order by e.id)
             from queue_entries e left join sessions s on s.id = e.session_id where e.id = any(p.refs)), '[]'::jsonb));
  elsif p.kind = 'locker' then
    extra := jsonb_build_object('lockers', coalesce((select jsonb_agg(jsonb_build_object('code', l.code, 'day', r.day, 'period', r.period, 'status', r.status) order by l.code)
             from locker_rentals r left join lockers l on l.id = r.locker_id where r.id::text = any(p.refs)), '[]'::jsonb));
  elsif p.kind = 'workshop' then
    extra := jsonb_build_object('job', 'W-' || lpad(p.ref, 4, '0'));
  end if;
  return _pay_json(p) || extra || jsonb_build_object('provider_ids',
           coalesce((select jsonb_agg(a.provider_id order by a.created_at) from payment_attempts a where a.payment_id = p.id), '[]'::jsonb));
end $$;
revoke execute on function public.pay_view(text, uuid) from public;
grant execute on function public.pay_view(text, uuid) to anon, authenticated;

-- The form made a Moyasar payment for one of ours (on_completed, before 3-D Secure): the server fetched
-- it from Moyasar and checked its metadata and amount before calling this. Nothing is paid by it.
create or replace function public.pay_attach(p_key text, p_pay uuid, p_provider_id text, p_status text, p_amount_halalas int, p_method text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare p payments%rowtype;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into p from payments where id = p_pay;
  if p.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if coalesce(p_provider_id, '') !~ '^[A-Za-z0-9_-]{8,80}$' then raise exception 'PAY_PROVIDER' using errcode = 'P0001'; end if;
  insert into payment_attempts (provider_id, payment_id, status, amount, method)
  values (p_provider_id, p.id, left(coalesce(p_status, 'initiated'), 20), coalesce(p_amount_halalas, 0) / 100.0, left(p_method, 20))
  on conflict (provider_id) do update set status = excluded.status, updated_at = now()
    where payment_attempts.payment_id = excluded.payment_id;
  perform _pay_event(p.id, 'attach', p_status, p_provider_id, null);
  return jsonb_build_object('ok', true, 'status', p.status);
end $$;
revoke execute on function public.pay_attach(text, uuid, text, text, int, text) from public;
grant execute on function public.pay_attach(text, uuid, text, text, int, text) to anon, authenticated;

-- ── Applying a payment that came in ───────────────────────────────────────────────────────────────
-- Returns what could not be applied (to refund): 0 when everything it paid for was still there.
create or replace function public._pay_apply(p payments) returns numeric
language plpgsql security definer set search_path = public as $$
declare l jsonb; q queue_entries%rowtype; amt numeric; back numeric := 0; o store_orders%rowtype; i store_order_items%rowtype;
        r locker_rentals%rowtype; j workshop_jobs%rowtype; ok boolean;
begin
  perform set_config('mm.pay_ok', '1', true);
  if p.kind = 'booking' then
    for l in select x from jsonb_array_elements(p.lines) x order by x ->> 'id' loop
      amt := (l ->> 'amount')::numeric;
      select * into q from queue_entries where id = l ->> 'id' for update;
      if q.id is null or coalesce(q.paid, false) then back := back + amt; continue; end if;
      if q.status in ('cancelled', 'removed') then
        if q.cancel_reason is distinct from 'unpaid' then back := back + amt; continue; end if;
        ok := true;
        begin  -- the place was let go when the hold ran out: back on it when there is still room
          update queue_entries set status = 'waiting', cancel_reason = null, cancelled_at = null, cancelled_by = null where id = q.id;
        exception when others then ok := false;
        end;
        if not ok then back := back + amt; continue; end if;
      end if;
      update queue_entries set paid = true, pay_method = 'online', card_amount = amt, paid_at = now(),
                               pay_hold_until = null, payment_id = p.id
       where id = q.id;
    end loop;
  elsif p.kind = 'order' then
    select * into o from store_orders where id = p.ref::uuid for update;
    if o.id is null then return p.amount; end if;
    if o.status = 'pending' then
      null;
    elsif o.status = 'cancelled' and o.cancel_reason = 'unpaid' then
      ok := true;
      begin  -- the stock was put back when the hold ran out: taken again when it is still there
        for i in select * from store_order_items where order_id = o.id and not held order by variant_id loop
          update store_variants set stock = stock - i.qty where id = i.variant_id and stock >= i.qty;
          if not found then raise exception 'STORE_STOCK'; end if;
          update store_order_items set held = true where id = i.id;
        end loop;
        if o.wallet_paid > 0 then  -- the wallet's part went back on the cancel: taken again
          perform _wallet_post(_wallet_owner(o.customer_id), -o.wallet_paid, 'sale', null, null, null, 'ord-' || o.no, null);
        end if;
      exception when others then ok := false;
      end;
      if not ok then return p.amount; end if;
    else
      return p.amount;
    end if;
    update store_orders set status = 'paid', paid_at = now(), expires_at = null, cancel_reason = null where id = o.id;
    insert into store_order_events (order_id, status, note) values (o.id, 'paid', null);
    insert into receipt_numbers (receipt_id) values ('ord-' || o.no) on conflict (receipt_id) do nothing;
  elsif p.kind = 'locker' then
    for l in select x from jsonb_array_elements(p.lines) x loop
      amt := (l ->> 'amount')::numeric;
      select * into r from locker_rentals where id = (l ->> 'id')::uuid for update;
      if r.id is null or r.receipt_id is not null then back := back + amt; continue; end if;
      if r.status = 'cancelled' then
        if r.cancel_reason is distinct from 'unpaid'
           or exists (select 1 from locker_rentals x where x.locker_id = r.locker_id and x.day = r.day and x.id <> r.id
                        and x.status in ('reserved', 'in_use') and _lk_slots(x.period) && _lk_slots(r.period)) then
          back := back + amt; continue;
        end if;
        update locker_rentals set status = 'reserved', cancelled_at = null, cancelled_by = null, cancel_reason = null where id = r.id;
      elsif r.status not in ('reserved', 'in_use', 'returned') then
        back := back + amt; continue;
      end if;
      update locker_rentals set receipt_id = 'pay-' || p.id, payment_id = p.id where id = r.id;
    end loop;
  elsif p.kind = 'topup' then
    perform set_config('mm.wallet_op', 'Online top-up', true);
    perform _wallet_post(_wallet_owner(p.customer_id), p.amount, 'topup', 'online', p.amount, null, 'pay-' || p.id, null);
    perform set_config('mm.wallet_op', '', true);
  elsif p.kind = 'workshop' then
    select * into j from workshop_jobs where id = p.ref::bigint for update;
    if j.id is null or j.paid_at is not null then return p.amount; end if;
    update workshop_jobs set paid_at = now(), paid_receipt = 'pay-' || p.id, payment_id = p.id where id = j.id;
  end if;
  perform set_config('mm.pay_ok', '', true);
  return round(back, 2);
end $$;
revoke execute on function public._pay_apply(payments) from public, anon, authenticated;

-- A refund the system owes (money that came for nothing it could still give): written pending, for the
-- server to send to Moyasar at once.
create or replace function public._pay_refund_auto(p_pay uuid, p_provider text, p_amount numeric, p_reason text) returns payment_refunds
language plpgsql security definer set search_path = public as $$
declare r payment_refunds%rowtype;
begin
  insert into payment_refunds (payment_id, provider_id, amount, dest, status, reason, by_name)
  values (p_pay, p_provider, round(p_amount, 2), 'card', 'pending', left(p_reason, 200), 'system')
  returning * into r;
  perform _pay_event(p_pay, 'refund', 'pending', p_provider, p_reason);
  return r;
end $$;
revoke execute on function public._pay_refund_auto(uuid, text, numeric, text) from public, anon, authenticated;

-- The one way a payment becomes paid. The server calls it with what it fetched from Moyasar itself
-- (the return page, the webhook, the reconcile run), in any order and any number of times.
-- Answers {ok, status, refund: {id, provider_id, amount} | null}: a refund here is for the server to send.
create or replace function public.pay_settle(p_key text, p_pay uuid, p_provider_id text, p_status text, p_amount_halalas int,
                                             p_currency text, p_info jsonb default '{}'::jsonb, p_source text default 'return')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare p payments%rowtype; back numeric; rf payment_refunds%rowtype; amt numeric := coalesce(p_amount_halalas, 0) / 100.0;
        src text := case when p_source in ('return', 'webhook', 'reconcile', 'attach') then p_source else 'return' end;
        st text := lower(coalesce(p_status, ''));
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if coalesce(p_provider_id, '') !~ '^[A-Za-z0-9_-]{8,80}$' then raise exception 'PAY_PROVIDER' using errcode = 'P0001'; end if;
  select * into p from payments where id = p_pay for update;
  if p.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  insert into payment_attempts (provider_id, payment_id, status, amount, method, message)
  values (p_provider_id, p.id, left(st, 20), amt, left(p_info ->> 'method', 20), left(p_info ->> 'message', 200))
  on conflict (provider_id) do update set status = excluded.status, message = excluded.message, updated_at = now()
    where payment_attempts.payment_id = excluded.payment_id;
  if not found then raise exception 'PAY_PROVIDER' using errcode = 'P0001'; end if;  -- that Moyasar payment is another one's
  perform _pay_event(p.id, src, st, p_provider_id, nullif(left(coalesce(p_info ->> 'message', ''), 300), ''));

  if st not in ('paid', 'captured') then
    if st = 'failed' and p.status = 'initiated' then
      update payments set message = left(p_info ->> 'message', 200) where id = p.id;
    end if;
    return jsonb_build_object('ok', true, 'status', p.status, 'refund', null);
  end if;

  -- money came in: is it ours, whole, in riyals?
  if upper(coalesce(p_currency, '')) <> 'SAR' or p_amount_halalas is distinct from round(p.amount * 100)::int then
    if exists (select 1 from payment_refunds x where x.provider_id = p_provider_id) then
      return jsonb_build_object('ok', false, 'status', p.status, 'error', 'amount', 'refund', null);
    end if;
    rf := _pay_refund_auto(p.id, p_provider_id, amt, 'amount did not match');
    return jsonb_build_object('ok', false, 'status', p.status, 'error', 'amount',
                              'refund', jsonb_build_object('id', rf.id, 'provider_id', rf.provider_id, 'amount', rf.amount));
  end if;

  if p.status in ('paid', 'refunded', 'partly_refunded') then
    if p.provider_id = p_provider_id or exists (select 1 from payment_refunds x where x.provider_id = p_provider_id) then
      return jsonb_build_object('ok', true, 'status', p.status, 'refund', null);  -- seen before
    end if;
    rf := _pay_refund_auto(p.id, p_provider_id, amt, 'paid twice');
    return jsonb_build_object('ok', true, 'status', p.status,
                              'refund', jsonb_build_object('id', rf.id, 'provider_id', rf.provider_id, 'amount', rf.amount));
  end if;

  -- initiated, expired or cancelled: apply it
  back := _pay_apply(p);
  perform set_config('mm.pay_ok', '', true);
  -- its invoice number: a store order's is the order's own ('ord-<no>', also the wallet-only order's)
  update payments set status = 'paid', provider_id = p_provider_id, paid_at = now(), message = null,
         method = left(p_info ->> 'method', 20), brand = left(lower(p_info ->> 'brand'), 20),
         last4 = case when (p_info ->> 'last4') ~ '^[0-9]{4}$' then p_info ->> 'last4' end,
         receipt_id = case when p.kind = 'order' then 'ord-' || (select o.no from store_orders o where o.id = p.ref::uuid) else 'pay-' || p.id end
   where id = p.id returning * into p;
  insert into receipt_numbers (receipt_id) values (p.receipt_id) on conflict (receipt_id) do nothing;
  if back > 0 then
    rf := _pay_refund_auto(p.id, p_provider_id, least(back, p.amount), case when p.kind = 'booking' then 'place no longer held'
                                                                             when p.kind = 'order' then 'order no longer held'
                                                                             else 'no longer held' end);
    return jsonb_build_object('ok', true, 'status', 'paid',
                              'refund', jsonb_build_object('id', rf.id, 'provider_id', rf.provider_id, 'amount', rf.amount));
  end if;
  return jsonb_build_object('ok', true, 'status', 'paid', 'refund', null);
end $$;
revoke execute on function public.pay_settle(text, uuid, text, text, int, text, jsonb, text) from public;
grant execute on function public.pay_settle(text, uuid, text, text, int, text, jsonb, text) to anon, authenticated;

-- Moyasar answered a refund the server sent (p_refunded_halalas: the payment's whole refunded amount, as Moyasar says).
create or replace function public.pay_refund_done(p_key text, p_refund uuid, p_ok boolean, p_refunded_halalas int, p_error text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare r payment_refunds%rowtype; p payments%rowtype; tot numeric;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into r from payment_refunds where id = p_refund for update;
  if r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then return jsonb_build_object('ok', true, 'status', r.status); end if;
  if not p_ok then
    update payment_refunds set status = 'failed', error = left(p_error, 300) where id = r.id;
    perform _pay_event(r.payment_id, 'refund', 'failed', r.provider_id, p_error);
    return jsonb_build_object('ok', false, 'status', 'failed');
  end if;
  update payment_refunds set status = 'done', done_at = now(), error = null where id = r.id;
  select * into p from payments where id = r.payment_id for update;
  if r.provider_id is not distinct from p.provider_id then
    tot := greatest(coalesce(p_refunded_halalas, 0) / 100.0, p.refunded + r.amount);
    update payments set refunded = least(tot, amount),
                        status = case when least(tot, amount) >= amount then 'refunded' else 'partly_refunded' end
     where id = p.id;
  end if;
  if r.order_id is not null then
    insert into store_order_events (order_id, status, note, by_name) values (r.order_id, 'refund', r.amount::text || ' SAR', r.by_name);
    update store_orders set status = 'refunded'
     where id = r.order_id and status = 'cancelled'
       and (select coalesce(sum(x.amount), 0) from payment_refunds x where x.order_id = r.order_id and x.status = 'done' and x.dest in ('card', 'wallet'))
           >= total - wallet_paid;
  end if;
  perform _pay_event(r.payment_id, 'refund', 'done', r.provider_id, r.amount::text);
  return jsonb_build_object('ok', true, 'status', 'done');
end $$;
revoke execute on function public.pay_refund_done(text, uuid, boolean, int, text) from public;
grant execute on function public.pay_refund_done(text, uuid, boolean, int, text) to anon, authenticated;

-- For the server's reconcile run (every few minutes): payments not yet paid that Moyasar may hold money
-- for (it lists every Moyasar payment carrying our id in its metadata), and card refunds that never
-- reached Moyasar (to confirm, never to resend). pay_checked stamps the ones asked about, so each is asked again only minutes later.
create or replace function public.pay_reconcile_list(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  return jsonb_build_object(
    'payments', coalesce((select jsonb_agg(x.id) from (
                   select p.id from payments p
                    where p.status in ('initiated', 'expired') and p.created_at > now() - interval '3 days'
                      and p.created_at < now() - interval '2 minutes'
                      and coalesce(p.checked_at, p.created_at) < now() - case when p.status = 'initiated' then interval '3 minutes' else interval '30 minutes' end
                    order by coalesce(p.checked_at, p.created_at) limit 20) x), '[]'::jsonb),
    -- a card refund still pending minutes later: confirmed against Moyasar's refunded total ('already' = what this
    -- database counted for that Moyasar payment before it), never sent twice
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'provider_id', r.provider_id, 'amount', r.amount,
                                                             'already', case when r.provider_id = p.provider_id then p.refunded else 0 end))
                           from (select * from payment_refunds where status = 'pending' and dest = 'card'
                                   and created_at < now() - interval '2 minutes' order by created_at limit 10) r
                           join payments p on p.id = r.payment_id), '[]'::jsonb));
end $$;
revoke execute on function public.pay_reconcile_list(text) from public;
grant execute on function public.pay_reconcile_list(text) to anon, authenticated;

create or replace function public.pay_checked(p_key text, p_pays uuid[]) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  update payments set checked_at = now() where id = any(coalesce(p_pays, '{}'::uuid[]));
end $$;
revoke execute on function public.pay_checked(text, uuid[]) from public;
grant execute on function public.pay_checked(text, uuid[]) to anon, authenticated;

-- ── Releasing what an unpaid payment held (pg_cron, every minute) ─────────────────────────────────
create or replace function public._pay_release(p payments, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype;
begin
  if p.kind = 'booking' and p.hold then
    perform set_config('mm.pay_ok', '1', true);
    update queue_entries set status = 'cancelled', cancel_reason = 'unpaid', cancelled_by = 'system', cancelled_at = now(),
                             pay_hold_until = null
     where id = any(p.refs) and payment_id = p.id and not coalesce(paid, false) and pay_hold_until is not null
       and coalesce(status, '') in ('waiting', 'waitlist');
    perform set_config('mm.pay_ok', '', true);
  elsif p.kind = 'order' then
    select * into o from store_orders where id = p.ref::uuid for update;
    if o.status = 'pending' then
      perform _store_restock(o.id);
      if o.wallet_paid > 0 then
        perform _wallet_post(_wallet_owner(o.customer_id), o.wallet_paid, 'sale_back', null, null, null, 'ord-' || o.no, null);
      end if;
      update store_orders set status = 'cancelled', cancel_reason = 'unpaid', expires_at = null where id = o.id;
      insert into store_order_events (order_id, status, note) values (o.id, 'cancelled', p_reason);
    end if;
  elsif p.kind = 'locker' then
    update locker_rentals set status = 'cancelled', cancel_reason = 'unpaid', cancelled_by = 'system', cancelled_at = now()
     where id::text = any(p.refs) and payment_id = p.id and status = 'reserved' and receipt_id is null and pay = 'card';
  end if;
end $$;
revoke execute on function public._pay_release(payments, text) from public, anon, authenticated;

create or replace function public._pay_tick() returns int
language plpgsql security definer set search_path = public as $$
declare p payments%rowtype; n int := 0;
begin
  for p in select * from payments where status = 'initiated' and expires_at < now() - interval '2 minutes'
            order by expires_at limit 200 for update skip locked loop
    update payments set status = 'expired' where id = p.id;
    perform _pay_event(p.id, 'tick', 'expired', null, null);
    perform _pay_release(p, 'unpaid');
    n := n + 1;
  end loop;
  -- a locker reserved for "Pay by card" whose payment never started (the page lost its connection) is let go
  update locker_rentals set status = 'cancelled', cancel_reason = 'unpaid', cancelled_by = 'system', cancelled_at = now()
   where pay = 'card' and status = 'reserved' and receipt_id is null and payment_id is null
     and created_at < now() - interval '20 minutes';
  return n;
end $$;
revoke execute on function public._pay_tick() from public, anon, authenticated;

do $cron$ begin
  if exists (select 1 from cron.job where jobname = 'mm-pay-tick') then perform cron.unschedule('mm-pay-tick'); end if;
  perform cron.schedule('mm-pay-tick', '* * * * *', 'select public._pay_tick()');
end $cron$;

-- ── Rides paid online ─────────────────────────────────────────────────────────────────────────────
-- Paid online, a booking's paid / pay method change only through these functions: the desk's pay menu
-- cannot quietly mark it unpaid or card (a refund goes through Payments).
create or replace function public._pay_online_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.pay_method = 'online' and coalesce(current_setting('mm.pay_ok', true), '') <> '1'
     and (new.paid is distinct from old.paid or new.pay_method is distinct from old.pay_method or new.card_amount is distinct from old.card_amount) then
    raise exception 'PAID_ONLINE' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and new.pay_hold_until is distinct from old.pay_hold_until and coalesce(current_setting('mm.pay_ok', true), '') <> '1'
     and current_user in ('anon', 'authenticated') then
    new.pay_hold_until := old.pay_hold_until;  -- nobody moves a hold but these functions
  end if;
  return new;
end $$;
revoke execute on function public._pay_online_guard() from public, anon, authenticated;
drop trigger if exists queue_entries_pay_guard on public.queue_entries;
create trigger queue_entries_pay_guard before update on public.queue_entries for each row execute function _pay_online_guard();

-- A booking paid online that is cancelled or removed some other way (the booking app, the desk) owes
-- the rider a decision: a refund row 'due' for staff (Payments > Refunds), never money moved unasked.
create or replace function public._pay_cancel_follow() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.pay_method = 'online' and new.payment_id is not null and coalesce(new.card_amount, 0) > 0
     and coalesce(new.status, '') in ('cancelled', 'removed') and coalesce(old.status, '') not in ('cancelled', 'removed')
     and coalesce(current_setting('mm.pay_refund_dest', true), '') = ''
     and not exists (select 1 from payment_refunds r where r.booking_id = new.id and r.status <> 'failed') then
    insert into payment_refunds (payment_id, provider_id, amount, status, reason, booking_id)
    select new.payment_id, p.provider_id, new.card_amount, 'due', 'booking ' || new.status, new.id
      from payments p where p.id = new.payment_id;
  end if;
  return null;
end $$;
revoke execute on function public._pay_cancel_follow() from public, anon, authenticated;
drop trigger if exists queue_entries_pay_cancel on public.queue_entries;
create trigger queue_entries_pay_cancel after update on public.queue_entries for each row execute function _pay_cancel_follow();

-- A locker paid online that is let go before its key was given (the rider's Remove, staff's Cancel) owes the
-- rider its money back: a refund row 'due' for staff, as a booking's (a key handed back keeps the fee).
create or replace function public._pay_locker_follow() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.pay = 'card' and new.payment_id is not null and coalesce(new.receipt_id, '') like 'pay-%'
     and new.status = 'cancelled' and old.status is distinct from 'cancelled' and coalesce(new.cancel_reason, '') <> 'unpaid'
     and not exists (select 1 from payment_refunds r where r.payment_id = new.payment_id and r.reason = 'locker ' || new.id::text) then
    insert into payment_refunds (payment_id, provider_id, amount, status, reason)
    select new.payment_id, p.provider_id, new.price, 'due', 'locker ' || new.id::text
      from payments p where p.id = new.payment_id and p.status in ('paid', 'partly_refunded');
  end if;
  return null;
end $$;
revoke execute on function public._pay_locker_follow() from public, anon, authenticated;
drop trigger if exists locker_rentals_pay_cancel on public.locker_rentals;
create trigger locker_rentals_pay_cancel after update on public.locker_rentals for each row execute function _pay_locker_follow();

-- The rider cancels their own bookings from the website. One paid online is refunded when cancelled at
-- least pay.refundDays before the ride day: into the wallet at once (p_dest 'wallet') or back to the card
-- (p_dest 'card': written pending for the server to send). Later than that, nothing is refunded (the
-- Terms; the page says so before the rider confirms). Answers the card refunds to send.
create or replace function public.pay_booking_cancel(p_key text, p_id text, p_token text, p_ids text[], p_dest text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare q queue_entries%rowtype; s sessions%rowtype; dest text; late boolean; rf payment_refunds%rowtype; outv jsonb := '[]'::jsonb;
        days int := _pay_int('pay.refundDays', 1, 0, 30); bid text;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_dest is null or p_dest not in ('wallet', 'card') then raise exception 'PAY_DEST' using errcode = 'P0001'; end if;
  if coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 20 then raise exception 'PAY_NOTHING' using errcode = 'P0001'; end if;
  foreach bid in array (select array_agg(distinct x order by x) from unnest(p_ids) x) loop
    select * into q from queue_entries where id = bid and customer_id = p_id for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if coalesce(q.status, '') not in ('waiting', 'waitlist') then raise exception 'PAY_NOT_OPEN' using errcode = 'P0001'; end if;
    select * into s from sessions where id = q.session_id;
    late := (_pay_today() + days) > left(coalesce(s.session_date, q.session_date), 10)::date;
    dest := case when q.pay_method = 'online' and coalesce(q.card_amount, 0) > 0 then case when late then 'none' else p_dest end end;
    perform set_config('mm.pay_refund_dest', coalesce(dest, 'none'), true);
    update queue_entries set status = 'cancelled', cancel_reason = 'customer', cancelled_by = 'customer', cancelled_at = now(),
                             pay_hold_until = null
     where id = q.id;
    perform set_config('mm.pay_refund_dest', '', true);
    if dest = 'wallet' then
      perform set_config('mm.wallet_op', 'Cancelled online booking', true);
      perform _wallet_post(_wallet_owner(p_id), q.card_amount, 'refund', 'online', q.card_amount, q.id, 'pay-' || q.payment_id, q.session_id);
      perform set_config('mm.wallet_op', '', true);
      insert into payment_refunds (payment_id, provider_id, amount, dest, status, reason, booking_id, by_name, done_at)
      select q.payment_id, p.provider_id, q.card_amount, 'wallet', 'done', 'rider cancelled', q.id, 'customer', now()
        from payments p where p.id = q.payment_id;
      perform _pay_event(q.payment_id, 'customer', 'refund_wallet', null, q.id);
    elsif dest = 'card' then
      insert into payment_refunds (payment_id, provider_id, amount, dest, status, reason, booking_id, by_name)
      select q.payment_id, p.provider_id, q.card_amount, 'card', 'pending', 'rider cancelled', q.id, 'customer'
        from payments p where p.id = q.payment_id
      returning * into rf;
      perform _pay_event(q.payment_id, 'customer', 'refund_card', rf.provider_id, q.id);
      outv := outv || jsonb_build_array(jsonb_build_object('id', rf.id, 'provider_id', rf.provider_id, 'amount', rf.amount));
    elsif dest = 'none' then
      insert into payment_refunds (payment_id, provider_id, amount, dest, status, reason, booking_id, by_name)
      select q.payment_id, p.provider_id, q.card_amount, 'none', 'declined', 'cancelled too late for a refund', q.id, 'customer'
        from payments p where p.id = q.payment_id;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'refunds', outv);
end $$;
revoke execute on function public.pay_booking_cancel(text, text, text, text[], text) from public;
grant execute on function public.pay_booking_cancel(text, text, text, text[], text) to anon, authenticated;

-- ── Lockers: "Pay by card" on micromobility.sa/lockers ────────────────────────────────────────────
-- customer_locker_book (20261109233000) rebuilt from its live definition with one change: p_pay may be
-- 'card' (reserved now, paid by pay_locker_start's payment; let go by mm-pay-tick when unpaid).
create or replace function public.customer_locker_book(p_id text, p_token text, p_day date, p_period text, p_codes text[], p_pay text, p_names text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare ev record; codes text[]; names text[]; c text; n int; i int; held int; lk lockers%rowtype; rid uuid; fee numeric;
        nm text; who text; outv jsonb := '[]'::jsonb;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_pay is null or p_pay not in ('desk', 'wallet', 'card') then raise exception 'LOCKER_PAY' using errcode = 'P0001'; end if;
  if p_pay = 'card' and not _pay_on('pay.enabled') then raise exception 'PAY_OFF' using errcode = 'P0001'; end if;
  -- the lockers in the order given, each once, with the name given beside it
  select array_agg(z.c order by z.o), array_agg(z.nm order by z.o) into codes, names
    from (select distinct on (_lk_code(u.x)) _lk_code(u.x) as c, u.o,
                 left(nullif(btrim(regexp_replace(coalesce(p_names[u.o::int], ''), '\s+', ' ', 'g')), ''), 60) as nm
            from unnest(coalesce(p_codes, '{}'::text[])) with ordinality u(x, o)
           where nullif(btrim(coalesce(u.x, '')), '') is not null
           order by _lk_code(u.x), u.o) z;
  n := coalesce(array_length(codes, 1), 0);
  if n = 0 then raise exception 'LOCKER_PICK' using errcode = 'P0001'; end if;
  if n > 3 then raise exception 'LOCKER_LIMIT' using errcode = 'P0001'; end if;
  select * into ev from _lk_evening(p_day);
  if ev.session_id is null or not _lk_period_ok(ev.kind, p_period) or _lk_ended(p_day, p_period) then
    raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';
  end if;
  if ev.kind = 'pm' then
    if not exists (select 1 from queue_entries q join sessions s on s.id = q.session_id
                    where q.customer_id = p_id and q.status in ('waiting', 'waitlist', 'active', 'done')
                      and left(s.session_date, 10) = p_day::text and _lk_kind(s.id) = 'pm') then
      raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';
    end if;
    if p_pay = 'wallet' then raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001'; end if;
  end if;
  select left(coalesce(nullif(btrim(cu.name), ''), '?'), 120) into who from customers cu where cu.id = p_id;
  perform _lk_lock(p_day);
  select count(*) into held from locker_rentals r
   where r.day = p_day and r.customer_id = p_id and r.booking_id is null and r.status in ('reserved', 'in_use')
     and _lk_slots(r.period) && _lk_slots(p_period);
  if held + n > 3 then raise exception 'LOCKER_LIMIT' using errcode = 'P0001'; end if;
  if not _lk_room(p_day, p_period, n) then raise exception 'LOCKERS_FULL' using errcode = 'P0001'; end if;
  fee := _lk_price(p_period);
  if p_pay = 'wallet' and coalesce((select b.balance from wallet_balances b where b.customer_id = _wallet_owner(p_id)), 0) < fee * n then
    raise exception 'WALLET_SHORT' using errcode = 'P0001';
  end if;
  for i in 1 .. n loop
    c := codes[i]; nm := coalesce(names[i], who);
    select * into lk from lockers where code = c and status <> 'retired';
    if lk.id is null then raise exception 'LOCKER_UNKNOWN: %', c using errcode = 'P0002'; end if;
    if lk.status <> 'available' then raise exception 'LOCKER_OUT: %', c using errcode = 'P0001'; end if;
    if exists (select 1 from locker_rentals x where x.locker_id = lk.id and x.day = p_day and x.status in ('reserved', 'in_use')
                 and _lk_slots(x.period) && _lk_slots(p_period)) then
      raise exception 'LOCKER_TAKEN: %', c using errcode = 'P0001';
    end if;
    insert into locker_rentals (day, period, session_id, customer_id, name, locker_id, price, on_bill, status, created_by, pay)
    values (p_day, p_period, ev.session_id, p_id, nm, lk.id, fee, false, 'reserved', 'page', p_pay)
    returning id into rid;
    if p_pay = 'wallet' then perform _lk_wallet_sale(rid); end if;
    outv := outv || jsonb_build_array(jsonb_build_object('id', rid, 'code', c, 'name', nm));
  end loop;
  return jsonb_build_object('ok', true, 'rentals', outv, 'left', _lk_left(p_day));
end $function$;

-- ── The workshop tracker says whether a job is paid (for its Pay button) ─────────────────────────
-- workshop_track rebuilt from its live definition with one key added: 'paid'.
CREATE OR REPLACE FUNCTION public.workshop_track(p_ref text, p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id bigint;
  v_digits text := right(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), 9);
  j workshop_jobs%rowtype;
begin
  if not _ip_gate('wstrack', 30, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  if coalesce(p_ref,'') !~* '^\s*W-?0*([0-9]{1,9})\s*$' or length(v_digits) < 9 then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  v_id := (regexp_match(p_ref, '([0-9]{1,9})'))[1]::bigint;
  select * into j from workshop_jobs where id = v_id and right(regexp_replace(phone, '\D', '', 'g'), 9) = v_digits;
  if j.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'ref', 'W-' || lpad(j.id::text, 4, '0'), 'status', j.status,
    'service', j.service_label, 'preferred_date', j.preferred_date, 'preferred_time', j.preferred_time,
    'scheduled_for', j.scheduled_for, 'lane', j.lane, 'price', j.price_final, 'paid', j.paid_at is not null);
end $function$;

-- ── Staff: the store and the money ────────────────────────────────────────────────────────────────
create or replace function public.staff_store_orders(p_status text default null, p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(_store_order_json(o, true) order by o.created_at desc)
                     from (select * from store_orders
                            where (p_status is null and status <> 'pending') or status = p_status
                               or (p_status = 'open' and status in ('paid', 'preparing', 'ready', 'shipped'))
                            order by created_at desc limit least(greatest(coalesce(p_limit, 200), 1), 500)) o), '[]'::jsonb);
end $$;
revoke execute on function public.staff_store_orders(text, int) from public, anon;
grant execute on function public.staff_store_orders(text, int) to authenticated;

-- Moves an order along: paid -> preparing -> ready (pickup) / shipped (delivery) -> delivered. Any staff.
create or replace function public.staff_store_order_set(p_order uuid, p_status text, p_note text default null,
                                                        p_courier text default null, p_tracking text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; who text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into o from store_orders where id = p_order for update;
  if o.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_status not in ('preparing', 'ready', 'shipped', 'delivered') then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  if o.status not in ('paid', 'preparing', 'ready', 'shipped') then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  if p_status = 'ready' and o.fulfil <> 'pickup' then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  if p_status = 'shipped' and o.fulfil = 'pickup' then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  select coalesce(nullif(btrim(s.display_name), ''), 'Staff') into who from staff s where s.user_id = auth.uid();
  update store_orders set status = p_status,
         courier = coalesce(left(nullif(btrim(p_courier), ''), 30), courier),
         tracking_no = coalesce(left(nullif(btrim(p_tracking), ''), 60), tracking_no)
   where id = o.id returning * into o;
  insert into store_order_events (order_id, status, note, by_name) values (o.id, p_status, left(nullif(btrim(coalesce(p_note, '')), ''), 300), left(who, 60));
  return _store_order_json(o, true);
end $$;
revoke execute on function public.staff_store_order_set(uuid, text, text, text, text) from public, anon;
grant execute on function public.staff_store_order_set(uuid, text, text, text, text) to authenticated;

create or replace function public.staff_store_order_note(p_order uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  update store_orders set staff_note = left(nullif(btrim(coalesce(p_note, '')), ''), 500) where id = p_order returning * into o;
  if o.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return _store_order_json(o, true);
end $$;
revoke execute on function public.staff_store_order_note(uuid, text) from public, anon;
grant execute on function public.staff_store_order_note(uuid, text) to authenticated;

-- Cancels an order (not yet delivered): its stock goes back, the wallet's part goes back, and what was
-- paid by card is owed as a refund 'due' (Refunds), decided there. Managers and admins.
create or replace function public.staff_store_order_cancel(p_order uuid, p_reason text, p_op text default null, p_approval text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; p payments%rowtype; who text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() and not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into o from store_orders where id = p_order for update;
  if o.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status in ('delivered', 'cancelled', 'refunded') then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  select coalesce(nullif(btrim(s.display_name), ''), 'Staff') into who from staff s where s.user_id = auth.uid();
  perform _store_restock(o.id);
  if o.wallet_paid > 0 then
    perform set_config('mm.wallet_op', left(coalesce(p_op, who), 40), true);
    perform _wallet_post(_wallet_owner(o.customer_id), o.wallet_paid, 'sale_back', null, null, null, 'ord-' || o.no, null);
    perform set_config('mm.wallet_op', '', true);
  end if;
  if o.status = 'pending' then
    update payments set status = 'cancelled' where id = o.payment_id and status = 'initiated';
  end if;
  update store_orders set status = 'cancelled', cancel_reason = 'staff', expires_at = null where id = o.id returning * into o;
  insert into store_order_events (order_id, status, note, by_name) values (o.id, 'cancelled', left(nullif(btrim(coalesce(p_reason, '')), ''), 300), left(who, 60));
  select * into p from payments where id = o.payment_id;
  if p.status in ('paid', 'partly_refunded') and p.amount - p.refunded > 0 then
    insert into payment_refunds (payment_id, provider_id, amount, status, reason, order_id, by_user, by_name)
    values (p.id, p.provider_id, p.amount - p.refunded, 'due', left(coalesce(p_reason, 'order cancelled'), 200), o.id, auth.uid(), left(who, 60));
  end if;
  return _store_order_json(o, true);
end $$;
revoke execute on function public.staff_store_order_cancel(uuid, text, text, text) from public, anon;
grant execute on function public.staff_store_order_cancel(uuid, text, text, text) to authenticated;

-- Stock counted or received: a change by so many (never below what is held for orders).
create or replace function public.staff_store_stock(p_variant uuid, p_delta int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v store_variants%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_delta is null or abs(p_delta) > 10000 then raise exception 'STORE_STOCK' using errcode = 'P0001'; end if;
  update store_variants set stock = stock + p_delta where id = p_variant and stock + p_delta >= 0 returning * into v;
  if v.id is null then raise exception 'STORE_STOCK' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', v.id, 'stock', v.stock);
end $$;
revoke execute on function public.staff_store_stock(uuid, int) from public, anon;
grant execute on function public.staff_store_stock(uuid, int) to authenticated;

create or replace function public.staff_payments(p_from date default null, p_to date default null, p_kind text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(_pay_json(p) || jsonb_build_object('customer_id', p.customer_id, 'provider_id', p.provider_id,
            'customer', (select c.name from customers c where c.id = p.customer_id), 'refs', p.refs,
            'refunds', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'dest', r.dest, 'status', r.status,
                                   'reason', r.reason, 'by', r.by_name, 'at', coalesce(r.done_at, r.created_at), 'booking_id', r.booking_id,
                                   'order_id', r.order_id, 'error', r.error) order by r.created_at)
                                 from payment_refunds r where r.payment_id = p.id), '[]'::jsonb))
            order by p.created_at desc)
          from (select * from payments
                 where status <> 'initiated'
                   and (p_from is null or (created_at at time zone 'Asia/Riyadh')::date >= p_from)
                   and (p_to is null or (created_at at time zone 'Asia/Riyadh')::date <= p_to)
                   and (p_kind is null or kind = p_kind)
                 order by created_at desc limit 500) p), '[]'::jsonb);
end $$;
revoke execute on function public.staff_payments(date, date, text) from public, anon;
grant execute on function public.staff_payments(date, date, text) to authenticated;

-- A refund staff decide: of a refund already owed (p_refund) or of any paid payment (p_payment), to the
-- card (pending: the website's server sends it to Moyasar and records the answer) or into the account's
-- wallet (at once). Admins with the refund right, the PIN and the manager limit, as every refund.
create or replace function public.staff_pay_refund_begin(p_payment uuid, p_amount numeric, p_dest text, p_reason text,
                                                         p_refund uuid default null, p_op text default null, p_approval text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare p payments%rowtype; r payment_refunds%rowtype; room numeric; who text; amt numeric; owner text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if p_dest is null or p_dest not in ('card', 'wallet') then raise exception 'PAY_DEST' using errcode = 'P0001'; end if;
  if p_refund is not null then
    select * into r from payment_refunds where id = p_refund for update;
    if r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if r.status not in ('due', 'failed') then raise exception 'PAY_REFUND_STATE' using errcode = 'P0001'; end if;
    p_payment := r.payment_id;
  end if;
  select * into p from payments where id = p_payment for update;
  if p.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p.status not in ('paid', 'partly_refunded') then raise exception 'PAY_NOT_PAID' using errcode = 'P0001'; end if;
  amt := round(coalesce(p_amount, r.amount), 2);
  if amt is null or amt <= 0 then raise exception 'PAY_AMOUNT' using errcode = 'P0001'; end if;
  room := p.amount - p.refunded - coalesce((select sum(x.amount) from payment_refunds x where x.payment_id = p.id
                                              and ((x.status = 'pending' and x.dest = 'card') or (x.status = 'done' and x.dest = 'wallet'))
                                              and x.id is distinct from r.id), 0);
  if amt > room then raise exception 'PAY_TOO_MUCH' using errcode = 'P0001'; end if;
  if not _mgr_ok('refund', amt, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  select coalesce(nullif(btrim(s.display_name), ''), 'Staff') into who from staff s where s.user_id = auth.uid();
  if r.id is null then
    insert into payment_refunds (payment_id, provider_id, amount, status, reason, by_user, by_name,
                                 order_id, booking_id)
    values (p.id, p.provider_id, amt, 'due', left(p_reason, 200), auth.uid(), left(coalesce(p_op, who), 60),
            case when p.kind = 'order' then p.ref::uuid end, case when p.kind = 'booking' and array_length(p.refs, 1) = 1 then p.refs[1] end)
    returning * into r;
  end if;
  if p_dest = 'wallet' then
    owner := coalesce(p.customer_id, (select o.customer_id from store_orders o where o.id = r.order_id));
    if owner is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
    perform set_config('mm.wallet_op', left(coalesce(p_op, who), 40), true);
    perform set_config('mm.wallet_note', coalesce(p_reason, ''), true);
    perform _wallet_post(_wallet_owner(owner), amt, 'refund', 'online', amt, r.booking_id, 'pay-' || p.id, null);
    perform set_config('mm.wallet_op', '', true);
    perform set_config('mm.wallet_note', '', true);
    update payment_refunds set amount = amt, dest = 'wallet', status = 'done', done_at = now(), reason = coalesce(left(p_reason, 200), reason),
                               by_user = auth.uid(), by_name = left(coalesce(p_op, who), 60), error = null
     where id = r.id returning * into r;
    if r.order_id is not null then
      insert into store_order_events (order_id, status, note, by_name) values (r.order_id, 'refund', amt::text || ' SAR · wallet', r.by_name);
    end if;
    perform _pay_event(p.id, 'staff', 'refund_wallet', null, amt::text);
  else
    update payment_refunds set amount = amt, dest = 'card', status = 'pending', provider_id = p.provider_id,
                               reason = coalesce(left(p_reason, 200), reason), by_user = auth.uid(), by_name = left(coalesce(p_op, who), 60), error = null
     where id = r.id returning * into r;
    perform _pay_event(p.id, 'staff', 'refund_card', p.provider_id, amt::text);
  end if;
  return jsonb_build_object('id', r.id, 'status', r.status, 'dest', r.dest, 'amount', r.amount, 'provider_id', r.provider_id);
end $$;
revoke execute on function public.staff_pay_refund_begin(uuid, numeric, text, text, uuid, text, text) from public, anon;
grant execute on function public.staff_pay_refund_begin(uuid, numeric, text, text, uuid, text, text) to authenticated;

-- A refund owed that the policy says no to (cancelled too late, a no-show): closed with a reason.
create or replace function public.staff_pay_refund_decline(p_refund uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r payment_refunds%rowtype; who text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() and not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  select coalesce(nullif(btrim(s.display_name), ''), 'Staff') into who from staff s where s.user_id = auth.uid();
  update payment_refunds set status = 'declined', dest = 'none', reason = left(coalesce(nullif(btrim(p_reason), ''), reason), 200),
                             by_user = auth.uid(), by_name = left(who, 60), done_at = now()
   where id = p_refund and status in ('due', 'failed') returning * into r;
  if r.id is null then raise exception 'PAY_REFUND_STATE' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', r.id, 'status', r.status);
end $$;
revoke execute on function public.staff_pay_refund_decline(uuid, text) from public, anon;
grant execute on function public.staff_pay_refund_decline(uuid, text) to authenticated;

-- The staff page asks whether the store exists here (production keeps it hidden until it does).
create or replace function public.staff_store_ready() returns boolean
language sql stable security definer set search_path = public as $$
  select is_staff()
$$;
revoke execute on function public.staff_store_ready() from public, anon;
grant execute on function public.staff_store_ready() to authenticated;

insert into supabase_migrations.schema_migrations (version, name) values ('20261110150000', 'online_payments') on conflict do nothing;
commit;
