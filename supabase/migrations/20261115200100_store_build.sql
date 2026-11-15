-- ============================================================================
-- The store build (2026-11-15): the database half of the store items the owner picked from the research report
-- "Website store best practices" (reports/Website store best practices.md; the owner answered every decision on its
-- page). STAGING ONLY: the online store and payments of 20261110150000 exist on staging alone (production has no store
-- tables), and this file stops unless 20261110150000, 20261110235200, 20261110235500 and 20261111235200 are in the
-- ledger. When the store goes live it goes to production right after those four.
--
-- The website (mm-platform, staging) and the staff page (Store and Payments) code against the names here; the build's
-- CONTRACTS.md is their one source.
--
--  1. Settings (site_content; staff edit them in Payments > Settings), seeded and never overwritten:
--     store.tabby.on, store.smsa.on, store.addressLookup.on (built but off until their keys exist; off means absent),
--     store.slots (scheduled Jeddah delivery, F78), store.districts (the Jeddah districts served, F79), store.lowStock
--     (F105), and store.complaintsDays = 5 (L12; the owner, 2026-11-15: a complaint is answered within 5 working days).
--  2. X01: the staff "pickup on" switch did nothing. _store_delivery_fee answered 0 for pickup whatever
--     store.delivery.pickup.on said, so a shopper could still pick showroom pickup after staff switched it off. Pickup is
--     now offered unless that is exactly false (missing = on, as before) and a pickup checkout while it is off is
--     refused (STORE_FULFIL). A gift card alone ('digital') costs nothing.
--  3. Products (store_products): kind (item | gift_card, F57), condition (new | certified pre-owned, F53),
--     warranty_months (L09: never under the legal two years for a new product), key_specs (F24), box (F37), fit (F38),
--     faq (F41), sizes (rider height per size, F20-F22), image_meta (a description per photo, which is its alt text, and
--     the colour it shows: X10, F104, F18, D15-B), goes_with / compare_with (F109 for F30, F60, F66, F10), bundle (F31)
--     and sale_from / sale_to (F107); up to 24 photos (F18). Trigger store_products_guard: a former price, a bundle or
--     sale dates need the Ministry of Commerce discount licence number (store.discountLicence; owner rule: without it a
--     "sale", a code or a bundle price is refused), STORE_LICENCE without it; a gift card sits in the gift category
--     (STORE_KIND); a bundle names one to three other products and a price (STORE_BUNDLE).
--  4. Orders (store_orders): status 'out' (out for delivery, F96), fulfil 'digital' (gift cards alone, F57), discount and
--     discounts (bundle F31, code F67), promo_code, gift_paid and gift_card_id (paid by a gift card), gift and gift_note
--     (F58), slot (F78). An order line keeps its own photo and address (X08: it read the product's, so a deleted
--     product stripped old orders of both; the lines already sold get theirs now) and says whether it is a gift card.
--     Invoices (L06; the owner, 2026-11-15): the store's own unbroken series, INV-000001 on, separate from the desk's
--     receipt numbers. invoice_no is given when the order is paid (the invoice is issued), in that transaction, from one
--     locked counter row (store_invoice_counter), never a sequence (a sequence skips numbers on a rollback); an order
--     never paid has none. The orders paid on staging before this file are numbered once, in the order they were paid.
--     A product's address may not be one of the store's pages (cart, checkout, order, track, saved, category; gift-card
--     for a gift card only).
--  5. New tables, each with row security, explicit revokes and grants: store_stock_requests (back in stock, F34; staff
--     call them on WhatsApp, no email or SMS), store_return_requests (F93), store_reviews (verified buyers only, F42 and
--     F94; no name, phone or account on a review, and the public reads only a shown review's own words, not its order
--     or the staffer who showed it), store_promo_codes (F67, licence only), store_gift_cards and
--     store_gift_card_moves (F57), store_invoice_counter (L06). A gift card expires a year after it is issued (the owner,
--     2026-11-15): past expires_at it is refused (STORE_GIFT_EXPIRED) and its balance can no longer be spent; staff may
--     extend it (staff_store_gift_card_extend).
--  6. The order JSON (_store_order_json) adds discount, discounts, promo_code, gift_paid, gift, gift_note, slot,
--     delivered_at, each line's id, own photo and address, gift card and reviewed marks, the returns asked for, the gift
--     cards the order bought (once paid) and every refund with where it went (X09: to the card, the wallet or the gift
--     card, including one the system made for money that came after the order was let go). VAT (L06) leaves out what
--     gift cards cost: a gift card is a voucher, its VAT is charged when it is spent.
--  7. store_checkout: pickup only while it is on (X01), the Jeddah district check (STORE_DISTRICT) and delivery slot
--     (STORE_SLOT) while staff have them on, gift cards alone as 'digital' (STORE_DIGITAL), the bundle discount and a
--     code (licence only, never on gift cards), a gift card paying first and then the wallet, the gift note, each line's
--     photo and address kept; an order paid at once gets its invoice number and issues its gift cards (_store_paid).
--  8. New for the website's server (the server key, as store_checkout): store_promo_check, store_gift_card_check,
--     store_stock_request, store_return_request, store_review_add. The three metered ones count the shopper's address
--     the website's server names (x-mm-visitor-ip, trusted only after the server key), else the caller's.
--  9. New for staff: staff_store_stock_requests and staff_store_stock_request_set (F34), staff_store_returns and
--     staff_store_return_decide (F93: a refund goes to the card first, as a refund owed in Payments > Refunds, then the
--     wallet, then the gift card), staff_store_review_set (F42, F94; admins), staff_store_gift_card_issue,
--     staff_store_gift_card_void and staff_store_gift_card_extend (F57). Approving a return's refund and issuing a gift
--     card take a manager's word over the shop's manager limit (_mgr_ok 'refund'), as every other refund staff make and
--     as the staff page asks for it. staff_store_order_set takes 'out' (F96) and staff_store_orders counts it open.
--     staff_store_order_cancel gives a gift card's part back, a never-paid order's code use back, and voids the gift
--     cards the order bought; what those cards already paid for elsewhere is kept back from its refund (the card's
--     part owed first, then the wallet's).
-- 10. Payments: pay_settle records the provider (moyasar | tabby, F84); pay_view gives an order's subtotal, discount,
--     gift_paid, total and provider, and (for the instalments provider's session, server only) its buyer and where it
--     goes; _pay_apply takes a late order's gift card part and code use again and issues its
--     gift cards; _pay_release gives them back; pay_refund_done and staff_pay_refund_begin count a gift card's part when
--     they decide an order is refunded whole.
-- 11. Gift card codes stay with the buyer. A code is the money (anyone who types it spends it), and the order JSON gave
--     every code an order bought to anyone holding its track key, which store_order_track hands out for the order
--     number (sequential) and the buyer's phone. Now an order that buys gift cards gets its own random gift_key
--     (gen_random_uuid's bytes), returned by store_checkout to the buyer's checkout only; every customer read masks the
--     codes (GC-••••-••••-<last 4>, masked true; amount, balance, status and expiry as before) unless
--     store_order_get gets that key (new last argument p_gift, default null) or the signed-in account that placed the
--     order reads customer_orders. Staff reads keep the whole codes, to send a lost one on WhatsApp.
-- 12. Void cards and refund (the owner, 2026-11-15): a gift card order is delivered at once and has no Cancel, and a
--     refund of an order's payment left the cards it bought spendable (paid twice). staff_store_order_gift_refund
--     voids every card the order bought that still holds a balance and refunds only that unspent value, no more than is
--     left of what the order paid (the card's part owed in Payments > Refunds, the wallet's at once), with the refund
--     right, the PIN and a manager over the limit; a second call changes nothing. The staff copy of the order says what
--     it would void and refund (gift_refund).
--
-- Rebuilt from the text in this repo (never prosrc): store_checkout 20261110235200 (6); _pay_apply 20261111235200 (2);
-- _pay_release 20261110235200 (2); staff_store_order_cancel 20261110150000 with 20261110235500's patch (1);
-- staff_pay_refund_begin 20261110235200 with 20261110235500's patch (3b); pay_refund_done 20261110235200 with
-- 20261110235500's patch (3a); _store_order_json, _store_delivery_fee, staff_store_order_set, staff_store_orders,
-- pay_settle, pay_view, store_order_get (one argument added, so the three-argument one is dropped) and customer_orders
-- 20261110150000. Each keeps SECURITY DEFINER and its search_path (the check at the end says so); the texts
-- 20261110235500 patched keep its mark, so a re-run of that file still changes nothing.
--
-- Idempotent (create ... if not exists, create or replace, constraints dropped and added again, seeds on conflict do
-- nothing). Tested on a throwaway local Postgres 17 with stubs of what it reads, applied twice.
-- Rollback idea: re-run 20261110150000's, 20261110235200's, 20261110235500's and 20261111235200's definitions of the
-- rebuilt functions in that order (dropping store_order_get(text,bigint,text,text) first); drop the functions this
-- file adds, the triggers store_products_guard and store_promo_codes_guard, the tables store_gift_card_moves,
-- store_gift_cards, store_promo_codes, store_reviews, store_return_requests, store_stock_requests and
-- store_invoice_counter, and the columns added in 3 and 4 (no order may be 'out' or 'digital' then); put back the
-- 12-photo, slug and status/fulfil checks.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $pre$
declare v text;
begin
  foreach v in array array['20261110150000', '20261110235200', '20261110235500', '20261111235200'] loop
    if not exists (select 1 from supabase_migrations.schema_migrations where version = v) then
      raise exception 'store_build is for staging, after % (the online store and payments): that file is not in the ledger here', v;
    end if;
  end loop;
end $pre$;

-- ── 1. Settings ───────────────────────────────────────────────────────────────────────────────────
insert into public.site_content (key, value) values
  ('store.tabby.on', 'false'::jsonb),
  ('store.smsa.on', 'false'::jsonb),
  ('store.addressLookup.on', 'false'::jsonb),
  ('store.slots', '{"on":false,"ahead":6,"lead":1,"skip":[5],"times":[{"id":"am","from":"09:00","to":"13:00"},{"id":"pm","from":"16:00","to":"21:00"}]}'::jsonb),
  ('store.districts', '{"on":false,"list":[]}'::jsonb),
  ('store.lowStock', '3'::jsonb),
  ('store.complaintsDays', '5'::jsonb)
on conflict (key) do nothing;

-- The discount licence number (store.discountLicence): a written string, trimmed, or null. Without it a former price, a
-- sale, a code or a bundle price is refused (writes) or left out (reads), as the website's discountLicence() reads it.
create or replace function public._store_licence() returns text
language sql stable security definer set search_path = public as $$
  select case when jsonb_typeof(v) = 'string' then left(nullif(btrim(v #>> '{}'), ''), 40) end
    from (select _pay_setting('store.discountLicence') v) x
$$;
revoke execute on function public._store_licence() from public, anon, authenticated;

-- A whole number kept in a setting, in range, or its default (the website's int()).
create or replace function public._store_jint(v jsonb, p_default int, p_min int, p_max int) returns int
language sql immutable set search_path = public as $$
  select case when jsonb_typeof(v) = 'number' then
           case when (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric) and (v #>> '{}')::numeric between p_min and p_max
                then (v #>> '{}')::int else p_default end
         else p_default end
$$;
revoke execute on function public._store_jint(jsonb, int, int, int) from public, anon, authenticated;

-- The day p_n working days after p_from (Fridays are not counted; day 0 is p_from, moved to Saturday from a Friday),
-- as the website's workingDay counts it.
create or replace function public._store_working_day(p_from date, p_n int) returns date
language plpgsql immutable set search_path = public as $$
declare d date := p_from; i int := 0;
begin
  while extract(dow from d) = 5 loop d := d + 1; end loop;
  while i < coalesce(p_n, 0) loop
    d := d + 1;
    if extract(dow from d) <> 5 then i := i + 1; end if;
  end loop;
  return d;
end $$;
revoke execute on function public._store_working_day(date, int) from public, anon, authenticated;

-- Scheduled Jeddah delivery (store.slots, F78) as the website's deliverySlots reads it, or null while it is off: the
-- first four well-formed times, the weekdays staff skip, ahead 1-14 (6), lead 0-7 (1).
create or replace function public._store_slots() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o jsonb := _pay_setting('store.slots'); times jsonb; skip int[];
begin
  if jsonb_typeof(o) is distinct from 'object' or (o -> 'on') is distinct from 'true'::jsonb then return null; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', y.t ->> 'id', 'from', y.t ->> 'from', 'to', y.t ->> 'to') order by y.n), '[]'::jsonb)
    into times
    from (select t, n from jsonb_array_elements(case when jsonb_typeof(o -> 'times') = 'array' then o -> 'times' else '[]'::jsonb end) with ordinality x(t, n)
           where jsonb_typeof(t) = 'object' and jsonb_typeof(t -> 'id') = 'string' and (t ->> 'id') ~ '^[a-z0-9]{1,12}$'
             and jsonb_typeof(t -> 'from') = 'string' and (t ->> 'from') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
             and jsonb_typeof(t -> 'to') = 'string' and (t ->> 'to') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
             and (t ->> 'to') collate "C" > (t ->> 'from') collate "C"
           order by n limit 4) y;
  select coalesce(array_agg(distinct _store_jint(d, -1, 0, 6)) filter (where _store_jint(d, -1, 0, 6) >= 0), '{}'::int[]) into skip
    from jsonb_array_elements(case when jsonb_typeof(o -> 'skip') = 'array' then o -> 'skip' else '[]'::jsonb end) d;
  if jsonb_array_length(times) = 0 or cardinality(skip) >= 7 then return null; end if;
  return jsonb_build_object('on', true, 'ahead', _store_jint(o -> 'ahead', 6, 1, 14), 'lead', _store_jint(o -> 'lead', 1, 0, 7),
                            'skip', to_jsonb(skip), 'times', times);
end $$;
revoke execute on function public._store_slots() from public, anon, authenticated;

-- The days a scheduled delivery can be booked for from p_today (Riyadh): from `lead` working days on, `ahead` days that
-- are not skipped, as the website's slotDays.
create or replace function public._store_slot_days(p_slots jsonb, p_today date) returns date[]
language plpgsql immutable set search_path = public as $$
declare d date; outv date[] := '{}'; g int := 0; ahead int := _store_jint(p_slots -> 'ahead', 6, 1, 14);
        skip int[] := coalesce((select array_agg(_store_jint(x, -1, 0, 6)) from jsonb_array_elements(coalesce(p_slots -> 'skip', '[]'::jsonb)) x), '{}');
begin
  if p_slots is null or p_today is null then return '{}'; end if;
  d := _store_working_day(p_today, _store_jint(p_slots -> 'lead', 1, 0, 7));
  while cardinality(outv) < ahead and g < 60 loop
    if not (extract(dow from d)::int = any(skip)) then outv := outv || d; end if;
    d := d + 1; g := g + 1;
  end loop;
  return outv;
end $$;
revoke execute on function public._store_slot_days(jsonb, date) from public, anon, authenticated;

-- Whether the shop delivers to a Jeddah district (store.districts, F79): true while the check is off or its list is
-- empty; else the district's English or Arabic name, compared as the website's districtServed compares it.
create or replace function public._store_district_ok(p_name text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare o jsonb := _pay_setting('store.districts'); nm text := lower(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')));
        listed int; hit boolean;
begin
  if jsonb_typeof(o) is distinct from 'object' or (o -> 'on') is distinct from 'true'::jsonb or jsonb_typeof(o -> 'list') is distinct from 'array' then
    return true;
  end if;
  with l as (select lower(btrim(regexp_replace(left(btrim(d ->> 'en'), 60), '\s+', ' ', 'g'))) en,
                    case when jsonb_typeof(d -> 'ar') = 'string' and btrim(d ->> 'ar') <> ''
                         then lower(btrim(regexp_replace(left(btrim(d ->> 'ar'), 60), '\s+', ' ', 'g'))) end ar
               from jsonb_array_elements(o -> 'list') with ordinality x(d, i)
              where jsonb_typeof(d) = 'object' and jsonb_typeof(d -> 'en') = 'string' and btrim(d ->> 'en') <> ''
              order by i limit 150)
  select count(*), coalesce(bool_or(nm <> '' and (l.en = nm or l.ar = nm)), false) into listed, hit from l;
  return listed = 0 or hit;
end $$;
revoke execute on function public._store_district_ok(text) from public, anon, authenticated;

-- The shopper the website's server calls for (x-mm-visitor-ip), as ':<address>' for a meter's key, or ''. Read only in
-- functions that checked the server key first: only the website's server holds it, so the header is its word.
create or replace function public._store_visitor() returns text
language plpgsql stable set search_path = public as $$
declare h json; v text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then h := null;
  end;
  v := btrim(coalesce(h ->> 'x-mm-visitor-ip', ''));
  return case when v ~ '^[0-9A-Fa-f:.]{2,45}$' then ':' || v else '' end;
end $$;
revoke execute on function public._store_visitor() from public, anon, authenticated;

-- ── 2. X01: delivery fees; pickup honours its switch ──────────────────────────────────────────────
create or replace function public._store_delivery_fee(p_fulfil text, p_subtotal numeric) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare d jsonb := coalesce(_pay_setting('store.delivery'), '{}'::jsonb); f numeric; free numeric;
begin
  /* a gift card alone is never delivered (store build 2026-11-15 (20261115200100)) */
  if p_fulfil = 'digital' then return 0; end if;
  /* pickup is offered unless staff switched it off: an explicit false (X01: it answered 0 whatever the switch said) */
  if p_fulfil = 'pickup' then
    if (d #> '{pickup,on}') is not distinct from 'false'::jsonb then return null; end if;
    return 0;
  end if;
  if coalesce((d -> p_fulfil ->> 'on')::boolean, false) is not true then return null; end if;
  f := coalesce((d -> p_fulfil ->> 'fee')::numeric, 0);
  free := (d ->> 'freeOver')::numeric;
  if free is not null and free > 0 and p_subtotal >= free then return 0; end if;
  return greatest(f, 0);
end $$;
revoke execute on function public._store_delivery_fee(text, numeric) from public, anon, authenticated;

-- ── 3. Products ───────────────────────────────────────────────────────────────────────────────────
alter table public.store_products add column if not exists kind text not null default 'item';
alter table public.store_products add column if not exists condition text not null default 'new';
alter table public.store_products add column if not exists warranty_months int;
alter table public.store_products add column if not exists key_specs jsonb not null default '[]'::jsonb;
alter table public.store_products add column if not exists box jsonb not null default '[]'::jsonb;
alter table public.store_products add column if not exists fit jsonb;
alter table public.store_products add column if not exists faq jsonb not null default '[]'::jsonb;
alter table public.store_products add column if not exists sizes jsonb not null default '[]'::jsonb;
alter table public.store_products add column if not exists image_meta jsonb not null default '{}'::jsonb;
alter table public.store_products add column if not exists goes_with uuid[] not null default '{}';
alter table public.store_products add column if not exists compare_with uuid[] not null default '{}';
alter table public.store_products add column if not exists bundle jsonb;
alter table public.store_products add column if not exists sale_from date;
alter table public.store_products add column if not exists sale_to date;

alter table public.store_products drop constraint if exists store_products_kind_check;
alter table public.store_products add constraint store_products_kind_check
  check (kind in ('item', 'gift_card') and (kind <> 'gift_card' or category = 'gift'));
alter table public.store_products drop constraint if exists store_products_condition_check;
alter table public.store_products add constraint store_products_condition_check check (condition in ('new', 'certified'));
alter table public.store_products drop constraint if exists store_products_warranty_months_check;
alter table public.store_products add constraint store_products_warranty_months_check
  check (warranty_months is null or (warranty_months between 12 and 120 and (condition <> 'new' or warranty_months >= 24)));
alter table public.store_products drop constraint if exists store_products_key_specs_check;
alter table public.store_products add constraint store_products_key_specs_check
  check (case when jsonb_typeof(key_specs) = 'array' then jsonb_array_length(key_specs) <= 6 and pg_column_size(key_specs) < 4000 else false end);
alter table public.store_products drop constraint if exists store_products_box_check;
alter table public.store_products add constraint store_products_box_check
  check (case when jsonb_typeof(box) = 'array' then jsonb_array_length(box) <= 12 and pg_column_size(box) < 4000 else false end);
alter table public.store_products drop constraint if exists store_products_fit_check;
alter table public.store_products add constraint store_products_fit_check
  check (fit is null or (jsonb_typeof(fit) = 'object' and pg_column_size(fit) < 2000));
alter table public.store_products drop constraint if exists store_products_faq_check;
alter table public.store_products add constraint store_products_faq_check
  check (case when jsonb_typeof(faq) = 'array' then jsonb_array_length(faq) <= 8 and pg_column_size(faq) < 12000 else false end);
alter table public.store_products drop constraint if exists store_products_sizes_check;
alter table public.store_products add constraint store_products_sizes_check
  check (case when jsonb_typeof(sizes) = 'array' then jsonb_array_length(sizes) <= 12 and pg_column_size(sizes) < 3000 else false end);
alter table public.store_products drop constraint if exists store_products_image_meta_check;
alter table public.store_products add constraint store_products_image_meta_check
  check (jsonb_typeof(image_meta) = 'object' and pg_column_size(image_meta) < 12000);
alter table public.store_products drop constraint if exists store_products_goes_with_check;
alter table public.store_products add constraint store_products_goes_with_check check (cardinality(goes_with) <= 8);
alter table public.store_products drop constraint if exists store_products_compare_with_check;
alter table public.store_products add constraint store_products_compare_with_check check (cardinality(compare_with) <= 3);
alter table public.store_products drop constraint if exists store_products_bundle_check;
alter table public.store_products add constraint store_products_bundle_check
  check (bundle is null or (jsonb_typeof(bundle) = 'object' and pg_column_size(bundle) < 1000));
alter table public.store_products drop constraint if exists store_products_sale_check;
alter table public.store_products add constraint store_products_sale_check
  check (sale_from is null or sale_to is null or sale_to >= sale_from);
/* F18: a photo per colour as well as the gallery (was 12) */
alter table public.store_products drop constraint if exists store_products_images_check;
alter table public.store_products add constraint store_products_images_check check (coalesce(array_length(images, 1), 0) <= 24);
/* a product's address is never one of the store's own pages: /store/saved and /store/category/<cat> (w2) join cart,
   checkout, order and track; /store/gift-card is the gift card's own page */
alter table public.store_products drop constraint if exists store_products_slug_check;
alter table public.store_products add constraint store_products_slug_check
  check (slug ~ '^[a-z][a-z0-9-]{1,60}$' and slug not in ('cart', 'checkout', 'order', 'track', 'saved', 'category')
         and (slug <> 'gift-card' or kind = 'gift_card'));

-- What a product row may say. A former price, a bundle and sale dates are discounts: set or changed only while the
-- discount licence number is set (STORE_LICENCE); cleared any time. A gift card is in the gift category (STORE_KIND).
-- A bundle is {items: 1-3 other products, none a gift card, each once; price > 0} (STORE_BUNDLE), kept tidy.
create or replace function public._store_product_guard() returns trigger
language plpgsql security definer set search_path = public as $$
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
end $$;
revoke execute on function public._store_product_guard() from public, anon, authenticated;
drop trigger if exists store_products_guard on public.store_products;
create trigger store_products_guard before insert or update on public.store_products
  for each row execute function _store_product_guard();

-- ── 5. New tables ─────────────────────────────────────────────────────────────────────────────────
-- Back in stock (F34): a shopper asks to be told when a sold-out choice is back; staff call them on WhatsApp.
create table if not exists public.store_stock_requests (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.store_products (id) on delete cascade,
  variant_id uuid references public.store_variants (id) on delete set null,
  label      text check (label is null or length(label) <= 60),          -- "M · Black" when asked
  name       text not null check (length(name) between 2 and 60),
  phone      text not null check (phone ~ '^9665[0-9]{8}$'),
  lang       text check (lang is null or lang ~ '^[a-z]{2}$'),
  status     text not null default 'open' check (status in ('open', 'done', 'dropped')),
  created_at timestamptz not null default now(),
  done_at    timestamptz,
  done_by    text check (done_by is null or length(done_by) <= 60)
);
create unique index if not exists store_stock_requests_open on public.store_stock_requests (variant_id, phone) where status = 'open';
create index if not exists store_stock_requests_list on public.store_stock_requests (status, created_at desc);

-- Returns and exchanges asked for on the order's page (F93); staff approve or refuse them.
create table if not exists public.store_return_requests (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.store_orders (id) on delete cascade,
  kind       text not null default 'return' check (kind in ('return', 'exchange')),
  items      jsonb not null check (case when jsonb_typeof(items) = 'array' then jsonb_array_length(items) between 1 and 20 else false end),  -- [{"item_id":123,"qty":1}]
  reason     text not null check (reason in ('wrong_size', 'changed_mind', 'damaged', 'not_as_described', 'other')),
  note       text check (note is null or length(note) <= 300),
  status     text not null default 'open' check (status in ('open', 'approved', 'refused')),
  amount     numeric(10,2) check (amount is null or amount >= 0),         -- what staff refunded on approving
  staff_note text check (staff_note is null or length(staff_note) <= 300),
  decided_by text check (decided_by is null or length(decided_by) <= 60),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists store_return_requests_open on public.store_return_requests (order_id) where status = 'open';
create index if not exists store_return_requests_order on public.store_return_requests (order_id, created_at);
create index if not exists store_return_requests_list on public.store_return_requests (status, created_at desc);

-- Reviews (F42, F94): only from an order that bought the product and was delivered; shown once staff show them. No
-- name, phone or account (owner rule: nobody's name).
create table if not exists public.store_reviews (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.store_products (id) on delete cascade,
  order_id     uuid not null references public.store_orders (id) on delete cascade,
  rating       int not null check (rating between 1 and 5),
  body         text check (body is null or length(body) <= 1000),
  lang         text check (lang is null or lang ~ '^[a-z]{2}$'),
  bought_month text not null check (bought_month ~ '^[0-9]{4}-[0-9]{2}$'),   -- the order's paid month, Riyadh
  status       text not null default 'pending' check (status in ('pending', 'shown', 'hidden')),
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   text check (decided_by is null or length(decided_by) <= 60),
  unique (order_id, product_id)
);
create index if not exists store_reviews_product on public.store_reviews (product_id, status, created_at desc);

-- Codes (F67): only while the discount licence number is set. Admins write them; uses move only in the functions.
create table if not exists public.store_promo_codes (
  code         text primary key check (code ~ '^[A-Z0-9-]{3,24}$'),
  kind         text not null check (kind in ('percent', 'amount')),
  value        numeric(10,2) not null check (value > 0 and value <= 100000 and (kind <> 'percent' or value <= 90)),
  min_subtotal numeric(10,2) not null default 0 check (min_subtotal >= 0),
  starts_on    date,
  ends_on      date,
  max_uses     int check (max_uses is null or max_uses >= 1),
  uses         int not null default 0 check (uses >= 0),
  active       boolean not null default true,
  note         text check (note is null or length(note) <= 120),
  created_by   text check (created_by is null or length(created_by) <= 60),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (starts_on is null or ends_on is null or ends_on >= starts_on)
);

-- Gift cards (F57): bought in the store (one per unit of a gift card line, once paid) or issued by staff. A card is a
-- code and a balance; every change of the balance is a move.
create table if not exists public.store_gift_cards (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique check (code ~ '^GC-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  amount        numeric(10,2) not null check (amount between 10 and 5000),
  balance       numeric(10,2) not null check (balance >= 0 and balance <= amount),
  status        text not null default 'active' check (status in ('active', 'void')),
  order_id      uuid references public.store_orders (id) on delete set null,   -- bought with this order (null: issued by staff)
  order_item_id bigint,
  note          text check (note is null or length(note) <= 120),
  issued_by     text check (issued_by is null or length(issued_by) <= 60),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '1 year'),   -- a year after it is issued (the owner)
  voided_at     timestamptz,
  void_reason   text check (void_reason is null or length(void_reason) <= 120)
);
alter table public.store_gift_cards add column if not exists expires_at timestamptz not null default (now() + interval '1 year');
create index if not exists store_gift_cards_order on public.store_gift_cards (order_id) where order_id is not null;
create index if not exists store_gift_cards_item on public.store_gift_cards (order_item_id) where order_item_id is not null;

create table if not exists public.store_gift_card_moves (
  id       bigserial primary key,
  card_id  uuid not null references public.store_gift_cards (id) on delete cascade,
  order_id uuid,
  amount   numeric(10,2) not null,     -- + issue / back / refund, - spend / void
  kind     text not null check (kind in ('issue', 'spend', 'back', 'refund', 'void')),
  at       timestamptz not null default now(),
  by_name  text check (by_name is null or length(by_name) <= 60)
);
create index if not exists store_gift_card_moves_card on public.store_gift_card_moves (card_id, id);
create index if not exists store_gift_card_moves_order on public.store_gift_card_moves (order_id) where order_id is not null;

-- The store's invoice numbers (L06): one row, locked by the update that takes the next number, so two orders paid at
-- once take turns and a rolled-back payment gives its number back (no gaps, unlike a sequence).
create table if not exists public.store_invoice_counter (
  id      boolean primary key default true check (id),
  last_no bigint not null default 0 check (last_no >= 0)
);
insert into public.store_invoice_counter (id, last_no) values (true, 0) on conflict (id) do nothing;

-- Who reads what: staff read every one of them; the public reads shown reviews; admins write codes. Customers and
-- guests reach the rest only through the functions below.
alter table public.store_stock_requests enable row level security;
alter table public.store_return_requests enable row level security;
alter table public.store_reviews enable row level security;
alter table public.store_promo_codes enable row level security;
alter table public.store_gift_cards enable row level security;
alter table public.store_gift_card_moves enable row level security;
alter table public.store_invoice_counter enable row level security;

revoke all on public.store_stock_requests, public.store_return_requests, public.store_reviews, public.store_promo_codes,
              public.store_gift_cards, public.store_gift_card_moves from anon, authenticated;
revoke all on public.store_invoice_counter from anon, authenticated;   -- only the functions below take a number
revoke all on sequence public.store_gift_card_moves_id_seq from anon, authenticated;

drop policy if exists "store stock requests staff read" on public.store_stock_requests;
create policy "store stock requests staff read" on public.store_stock_requests for select to authenticated using ((select is_staff()));
grant select on public.store_stock_requests to authenticated;

drop policy if exists "store return requests staff read" on public.store_return_requests;
create policy "store return requests staff read" on public.store_return_requests for select to authenticated using ((select is_staff()));
grant select on public.store_return_requests to authenticated;

drop policy if exists "store reviews shown read" on public.store_reviews;
create policy "store reviews shown read" on public.store_reviews for select to anon, authenticated
  using (status = 'shown' or (select is_staff()));
/* the public reads a shown review's own words, not the order it came from or who on staff showed it (decided_by is a
   staffer's name; owner rule: nobody's name). These are the columns the website reads, filters and sorts on
   (lib/store.ts readReviews); staff read every column. No view or invoker function reads this table (store build
   review 2026-11-15) */
grant select (id, product_id, rating, body, lang, bought_month, status, created_at) on public.store_reviews to anon;
grant select on public.store_reviews to authenticated;

drop policy if exists "store promo codes staff read" on public.store_promo_codes;
create policy "store promo codes staff read" on public.store_promo_codes for select to authenticated using ((select is_staff()));
drop policy if exists "store promo codes admin insert" on public.store_promo_codes;
create policy "store promo codes admin insert" on public.store_promo_codes for insert to authenticated with check ((select is_admin()));
drop policy if exists "store promo codes admin update" on public.store_promo_codes;
create policy "store promo codes admin update" on public.store_promo_codes for update to authenticated
  using ((select is_admin())) with check ((select is_admin()));
drop policy if exists "store promo codes admin delete" on public.store_promo_codes;
create policy "store promo codes admin delete" on public.store_promo_codes for delete to authenticated using ((select is_admin()));
grant select, insert, update, delete on public.store_promo_codes to authenticated;

drop policy if exists "store gift cards staff read" on public.store_gift_cards;
create policy "store gift cards staff read" on public.store_gift_cards for select to authenticated using ((select is_staff()));
grant select on public.store_gift_cards to authenticated;

drop policy if exists "store gift card moves staff read" on public.store_gift_card_moves;
create policy "store gift card moves staff read" on public.store_gift_card_moves for select to authenticated using ((select is_staff()));
grant select on public.store_gift_card_moves to authenticated;

-- A code's row: upper case; on insert, or on a change that keeps it on, only with the licence (STORE_LICENCE); switching
-- it off or deleting it is always allowed. Its uses move only inside the functions (they set mm.store_ok); a client's
-- write keeps them as they were.
create or replace function public._store_promo_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare fn boolean := coalesce(current_setting('mm.store_ok', true), '') = '1';
begin
  new.code := upper(btrim(coalesce(new.code, '')));
  if tg_op = 'INSERT' then
    if not fn then new.uses := 0; end if;
    new.created_by := coalesce(new.created_by,
      (select left(coalesce(nullif(btrim(s.display_name), ''), 'Staff'), 60) from staff s where s.user_id = auth.uid()));
    if _store_licence() is null then raise exception 'STORE_LICENCE' using errcode = 'P0001'; end if;
  else
    if not fn then new.uses := old.uses; new.created_at := old.created_at; new.created_by := old.created_by; end if;
    new.updated_at := now();
    if new.active and _store_licence() is null
       and (new.code, new.kind, new.value, new.min_subtotal, new.starts_on, new.ends_on, new.max_uses, new.active, new.note)
           is distinct from (old.code, old.kind, old.value, old.min_subtotal, old.starts_on, old.ends_on, old.max_uses, old.active, old.note) then
      raise exception 'STORE_LICENCE' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public._store_promo_guard() from public, anon, authenticated;
drop trigger if exists store_promo_codes_guard on public.store_promo_codes;
create trigger store_promo_codes_guard before insert or update on public.store_promo_codes
  for each row execute function _store_promo_guard();

-- ── 4. Orders ─────────────────────────────────────────────────────────────────────────────────────
alter table public.store_orders drop constraint if exists store_orders_status_check;
alter table public.store_orders add constraint store_orders_status_check
  check (status in ('pending', 'paid', 'preparing', 'ready', 'shipped', 'out', 'delivered', 'cancelled', 'refunded'));
alter table public.store_orders drop constraint if exists store_orders_fulfil_check;
alter table public.store_orders add constraint store_orders_fulfil_check check (fulfil in ('pickup', 'jeddah', 'ksa', 'digital'));

alter table public.store_orders add column if not exists discount numeric(10,2) not null default 0;
alter table public.store_orders add column if not exists discounts jsonb not null default '[]'::jsonb;
alter table public.store_orders add column if not exists promo_code text;
alter table public.store_orders add column if not exists gift_paid numeric(10,2) not null default 0;
alter table public.store_orders add column if not exists gift_card_id uuid references public.store_gift_cards (id);
alter table public.store_orders add column if not exists gift boolean not null default false;
alter table public.store_orders add column if not exists gift_note text;
alter table public.store_orders add column if not exists slot jsonb;
alter table public.store_orders add column if not exists invoice_no bigint unique;
-- the secret that shows the codes of the gift cards an order bought (section 6): only an order that buys gift cards has one
alter table public.store_orders add column if not exists gift_key text;

alter table public.store_orders drop constraint if exists store_orders_discount_check;
alter table public.store_orders add constraint store_orders_discount_check check (discount >= 0);
alter table public.store_orders drop constraint if exists store_orders_discounts_check;
alter table public.store_orders add constraint store_orders_discounts_check
  check (case when jsonb_typeof(discounts) = 'array' then pg_column_size(discounts) < 2000 else false end);
alter table public.store_orders drop constraint if exists store_orders_promo_code_check;
alter table public.store_orders add constraint store_orders_promo_code_check check (promo_code is null or promo_code ~ '^[A-Z0-9-]{3,24}$');
alter table public.store_orders drop constraint if exists store_orders_gift_paid_check;
alter table public.store_orders add constraint store_orders_gift_paid_check check (gift_paid >= 0);
alter table public.store_orders drop constraint if exists store_orders_gift_note_check;
alter table public.store_orders add constraint store_orders_gift_note_check check (gift_note is null or length(gift_note) <= 200);
alter table public.store_orders drop constraint if exists store_orders_gift_key_check;
alter table public.store_orders add constraint store_orders_gift_key_check check (gift_key is null or gift_key ~ '^[0-9a-f]{32}$');
alter table public.store_orders drop constraint if exists store_orders_slot_check;
alter table public.store_orders add constraint store_orders_slot_check
  check (slot is null or (jsonb_typeof(slot) = 'object' and pg_column_size(slot) < 200));

alter table public.store_order_items add column if not exists image text;
alter table public.store_order_items add column if not exists slug text;
alter table public.store_order_items add column if not exists gift_card boolean not null default false;
alter table public.store_order_items drop constraint if exists store_order_items_image_check;
alter table public.store_order_items add constraint store_order_items_image_check check (image is null or length(image) <= 300);
alter table public.store_order_items drop constraint if exists store_order_items_slug_check;
alter table public.store_order_items add constraint store_order_items_slug_check check (slug is null or length(slug) <= 80);

-- L06: the orders paid before this file get their invoice numbers once, in the order they were paid.
do $inv$
declare r record; n bigint;
begin
  for r in select o.id from store_orders o where o.paid_at is not null and o.invoice_no is null order by o.paid_at, o.no loop
    update store_invoice_counter set last_no = last_no + 1 where id returning last_no into n;
    update store_orders set invoice_no = n where id = r.id;
  end loop;
end $inv$;

-- X08: the lines already sold keep the photo and address their product has today (a product deleted later no longer
-- strips them).
update public.store_order_items i
   set image = coalesce(i.image, left(sp.images[1], 300)), slug = coalesce(i.slug, sp.slug)
  from public.store_products sp
 where sp.id = i.product_id and (i.image is null or i.slug is null);

-- ── 6. The order as its pages and the staff page read it ──────────────────────────────────────────
-- The gift cards an order bought, once it is paid. A card's code is the money itself (anyone who types it spends it), so
-- the whole code goes only to staff (p_staff, who send a lost code on WhatsApp) and to the buyer (p_full: the order's
-- gift key, which store_checkout gives the buyer's checkout alone, or the signed-in account that placed the order). The
-- track key is not enough: store_order_track hands it to anyone with the order number (sequential) and the phone.
-- Everyone else reads GC-••••-••••-<the last 4> with masked true, beside the amount, balance, status and expiry.
create or replace function public._store_order_gifts(o store_orders, p_full boolean, p_staff boolean) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when o.paid_at is null then '[]'::jsonb else
    coalesce((select jsonb_agg(jsonb_build_object('code', case when (p_full or p_staff) is true then g.code else 'GC-••••-••••-' || right(g.code, 4) end,
                                                  'masked', (p_full or p_staff) is not true,
                                                  'amount', g.amount, 'balance', g.balance, 'status', g.status, 'expires_at', g.expires_at)
                               || case when p_staff then jsonb_build_object('id', g.id) else '{}'::jsonb end
                               order by g.created_at, g.code)
                from store_gift_cards g where g.order_id = o.id), '[]'::jsonb) end
$$;
revoke execute on function public._store_order_gifts(store_orders, boolean, boolean) from public, anon, authenticated;

-- What "Void cards and refund" (staff_store_order_gift_refund, section 9) would do to an order now: the cards it bought
-- that still hold a balance (cards), what is left on them (unspent), and the refund, which is that unspent value and no
-- more than is left of what the order paid (its card payment less what came back or is on its way, as
-- staff_store_return_decide counts it, and the wallet's part less what went back): card first, then wallet. The staff
-- copy of the order carries it (gift_refund), so the sheet shows the figure before staff confirm.
create or replace function public._store_gift_refund_plan(o store_orders) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p payments%rowtype; n int; unspent numeric; card_room numeric := 0; wal_room numeric := 0; amt numeric; c numeric;
begin
  select count(*), coalesce(sum(g.balance), 0) into n, unspent
    from store_gift_cards g where g.order_id = o.id and g.status = 'active' and g.balance > 0;
  select * into p from payments where id = o.payment_id;
  if p.id is not null and p.status in ('paid', 'partly_refunded') then
    card_room := greatest(round(p.amount - p.refunded - coalesce((select sum(x.amount) from payment_refunds x
                   where x.payment_id = p.id and x.provider_id is not distinct from p.provider_id
                     and ((x.status = 'pending' and x.dest = 'card') or (x.status = 'done' and x.dest = 'wallet')
                          or x.status in ('due', 'failed'))), 0), 2), 0);
  end if;
  if o.wallet_paid > 0 and o.customer_id is not null then
    select greatest(coalesce(-sum(l.amount), 0), 0) into wal_room from wallet_ledger l
     where l.receipt_id = 'ord-' || o.no and l.kind in ('sale', 'sale_back');
  end if;
  amt := round(least(unspent, card_room + wal_room), 2);
  c := least(amt, card_room);
  return jsonb_build_object('cards', n, 'unspent', unspent, 'refund', amt, 'card', c, 'wallet', amt - c);
end $$;
revoke execute on function public._store_gift_refund_plan(store_orders) from public, anon, authenticated;

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
$$;
revoke execute on function public._store_order_json(store_orders, boolean) from public, anon, authenticated;

-- The order's page for the website's server, by its number and track key (rebuilt from 20261110150000): p_gift, the
-- order's gift key, shows the whole codes of the gift cards it bought; without it, or with any other, they are masked.
-- Its three arguments keep their names and order; the three-argument function goes first, so a call never finds two.
drop function if exists public.store_order_get(text, bigint, text);
create or replace function public.store_order_get(p_key text, p_no bigint, p_track text, p_gift text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare o store_orders%rowtype; j jsonb;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into o from store_orders where no = p_no and track_key = p_track;
  if o.id is null then return null; end if;
  j := _store_order_json(o);
  if o.gift_key is not null and p_gift = o.gift_key then
    j := j || jsonb_build_object('gift_cards', _store_order_gifts(o, true, false));
  end if;
  return j;
end $$;
revoke execute on function public.store_order_get(text, bigint, text, text) from public;
grant execute on function public.store_order_get(text, bigint, text, text) to anon, authenticated;

-- A signed-in account's orders (rebuilt from 20261110150000): each one is the account's own (placed signed in, so
-- store_checkout tied it to the account), so the account sees the whole codes of the gift cards it bought.
-- store_order_track (by number and phone) is not rebuilt: it answers the masked JSON above.
create or replace function public.customer_orders(p_id text, p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _cust_token_ok(p_id, p_token) then return null; end if;
  return coalesce((select jsonb_agg(_store_order_json(o) || jsonb_build_object('key', o.track_key, 'gift_cards', _store_order_gifts(o, true, false))
                                    order by o.created_at desc)
                     from (select * from store_orders where customer_id = p_id order by created_at desc limit 50) o), '[]'::jsonb);
end $$;
revoke execute on function public.customer_orders(text, text) from public;
grant execute on function public.customer_orders(text, text) to anon, authenticated;

-- ── 7. Discounts and gift cards: the shared rules ─────────────────────────────────────────────────
-- The bundle prices (F31) a set of lines earns, only with the licence: p_lines = [{product, unit, qty}] (never gift
-- cards). For each product with a bundle, in staff's order: as many sets as the product and every item of its bundle are
-- each in the lines (a unit counts in one set only); a set saves the lowest unit of each less the bundle's price.
-- Answers [{kind:'bundle', ref:<slug>, amount}], as the website's bundleDiscount.
create or replace function public._store_bundle_off(p_lines jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare lft jsonb := '{}'::jsonb; unit jsonb := '{}'::jsonb; l jsonb; pr record; ids text[]; sets int; per numeric; s numeric;
        id text; outv jsonb := '[]'::jsonb; k text;
begin
  if _store_licence() is null then return '[]'::jsonb; end if;
  for l in select x from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) x loop
    k := l ->> 'product';
    lft := jsonb_set(lft, array[k], to_jsonb(coalesce((lft ->> k)::int, 0) + (l ->> 'qty')::int));
    unit := jsonb_set(unit, array[k], to_jsonb(least(coalesce((unit ->> k)::numeric, (l ->> 'unit')::numeric), (l ->> 'unit')::numeric)));
  end loop;
  for pr in select p.id, p.slug, p.bundle from store_products p
             where p.id::text in (select jsonb_object_keys(lft)) and p.bundle is not null and p.kind <> 'gift_card'
             order by p.sort, p.name_en loop
    ids := array[pr.id::text] || array(select jsonb_array_elements_text(pr.bundle -> 'items'));
    if exists (select 1 from unnest(ids) x where not lft ? x) then continue; end if;
    select min((lft ->> x)::int), sum((unit ->> x)::numeric) into sets, s from unnest(ids) x;
    per := round(s - (pr.bundle ->> 'price')::numeric, 2);
    if sets < 1 or per <= 0 then continue; end if;
    foreach id in array ids loop lft := jsonb_set(lft, array[id], to_jsonb((lft ->> id)::int - sets)); end loop;
    outv := outv || jsonb_build_array(jsonb_build_object('kind', 'bundle', 'ref', pr.slug, 'amount', round(per * sets, 2)));
  end loop;
  return outv;
end $$;
revoke execute on function public._store_bundle_off(jsonb) from public, anon, authenticated;

-- What a code takes off p_eligible (the order's goods that are not gift cards, after the bundle prices): only with the
-- licence (STORE_LICENCE); known, on and within its dates (STORE_PROMO); eligible above zero and at least its minimum
-- (STORE_PROMO_MIN); under its most uses (STORE_PROMO_USED). p_take counts the use (checkout). Answers
-- {code, kind, value, discount, eligible}.
create or replace function public._store_promo_off(p_code text, p_eligible numeric, p_take boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c store_promo_codes%rowtype; d numeric; e numeric := round(greatest(coalesce(p_eligible, 0), 0), 2); today date := _pay_today();
begin
  if _store_licence() is null then raise exception 'STORE_LICENCE' using errcode = 'P0001'; end if;
  if coalesce(p_code, '') !~ '^[A-Z0-9-]{3,24}$' then raise exception 'STORE_PROMO' using errcode = 'P0001'; end if;
  if p_take then
    select * into c from store_promo_codes where code = p_code for update;
  else
    select * into c from store_promo_codes where code = p_code;
  end if;
  if c.code is null or not c.active or (c.starts_on is not null and today < c.starts_on) or (c.ends_on is not null and today > c.ends_on) then
    raise exception 'STORE_PROMO' using errcode = 'P0001';
  end if;
  if e <= 0 or e < c.min_subtotal then raise exception 'STORE_PROMO_MIN' using errcode = 'P0001'; end if;
  if c.max_uses is not null and c.uses >= c.max_uses then raise exception 'STORE_PROMO_USED' using errcode = 'P0001'; end if;
  d := case when c.kind = 'percent' then round(e * c.value / 100, 2) else least(c.value, e) end;
  if p_take then
    perform set_config('mm.store_ok', '1', true);
    update store_promo_codes set uses = uses + 1 where code = c.code;
    perform set_config('mm.store_ok', '', true);
  end if;
  return jsonb_build_object('code', c.code, 'kind', c.kind, 'value', c.value, 'discount', d, 'eligible', e);
end $$;
revoke execute on function public._store_promo_off(text, numeric, boolean) from public, anon, authenticated;

-- A new gift card code: GC- and three groups of four from 32 letters and digits that cannot be misread (no I, O, 0, 1),
-- drawn from the random bytes of a version-4 uuid (its fixed version and variant bytes left out), again on a clash.
create or replace function public._store_gift_code() returns text
language plpgsql volatile security definer set search_path = public as $$
declare a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; b bytea; s text; t int := 0; pos int;
begin
  loop
    b := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    s := '';
    foreach pos in array array[0, 1, 2, 3, 4, 5, 9, 10, 11, 12, 13, 14] loop
      s := s || substr(a, (get_byte(b, pos) % 32) + 1, 1);
    end loop;
    s := 'GC-' || substr(s, 1, 4) || '-' || substr(s, 5, 4) || '-' || substr(s, 9, 4);
    exit when not exists (select 1 from store_gift_cards g where g.code = s);
    t := t + 1;
    if t > 20 then raise exception 'STORE_GIFT_CODE' using errcode = 'P0001'; end if;
  end loop;
  return s;
end $$;
revoke execute on function public._store_gift_code() from public, anon, authenticated;

-- The next invoice number for an order now paid (L06): from the one counter row, locked by its update, in the paying
-- transaction, so the series has no gaps; an order that has one keeps it.
create or replace function public._store_invoice(p_order uuid) returns bigint
language plpgsql security definer set search_path = public as $$
declare cur bigint; n bigint;
begin
  select o.invoice_no into cur from store_orders o where o.id = p_order for update;
  if cur is not null then return cur; end if;
  insert into store_invoice_counter (id, last_no) values (true, 0) on conflict (id) do nothing;
  update store_invoice_counter set last_no = last_no + 1 where id returning last_no into n;
  update store_orders set invoice_no = n where id = p_order;
  return n;
end $$;
revoke execute on function public._store_invoice(uuid) from public, anon, authenticated;

-- An order just paid: its invoice number (L06), one gift card per unit of each gift card line (its price, move 'issue',
-- a year to spend it), and an order of gift cards alone is delivered at once (its codes are on its page). Called wherever
-- an order becomes paid (store_checkout, _pay_apply). Idempotent: the number is kept and a line's cards already issued
-- are counted first.
create or replace function public._store_paid(o store_orders) returns void
language plpgsql security definer set search_path = public as $$
declare i store_order_items%rowtype; have int; k int; c store_gift_cards%rowtype;
begin
  select * into o from store_orders where id = o.id for update;
  if o.id is null or o.paid_at is null or o.status not in ('paid', 'preparing', 'ready', 'shipped', 'out', 'delivered') then return; end if;
  perform _store_invoice(o.id);
  for i in select * from store_order_items where order_id = o.id and gift_card order by id loop
    select count(*) into have from store_gift_cards g where g.order_item_id = i.id;
    for k in have + 1 .. i.qty loop
      insert into store_gift_cards (code, amount, balance, order_id, order_item_id, issued_by)
      values (_store_gift_code(), i.unit_price, i.unit_price, o.id, i.id, 'system')
      returning * into c;
      insert into store_gift_card_moves (card_id, order_id, amount, kind, by_name) values (c.id, o.id, c.amount, 'issue', 'system');
    end loop;
  end loop;
  if o.fulfil = 'digital' and o.status = 'paid' then
    update store_orders set status = 'delivered' where id = o.id;
    insert into store_order_events (order_id, status, note) values (o.id, 'delivered', 'gift_card');
  end if;
end $$;
revoke execute on function public._store_paid(store_orders) from public, anon, authenticated;

-- An order let go (unpaid) or cancelled: what a gift card paid of it goes back onto the card (move 'back'; only what the
-- order still holds of it, so a second call gives back nothing), and, with p_promo, its code's use.
create or replace function public._store_give_back(o store_orders, p_by text, p_promo boolean) returns void
language plpgsql security definer set search_path = public as $$
declare net numeric;
begin
  if o.gift_card_id is not null and o.gift_paid > 0 then
    select coalesce(-sum(m.amount), 0) into net from store_gift_card_moves m
     where m.card_id = o.gift_card_id and m.order_id = o.id and m.kind in ('spend', 'back', 'refund');
    if net > 0 then
      update store_gift_cards set balance = least(amount, balance + net) where id = o.gift_card_id;
      insert into store_gift_card_moves (card_id, order_id, amount, kind, by_name) values (o.gift_card_id, o.id, net, 'back', left(p_by, 60));
    end if;
  end if;
  if p_promo and o.promo_code is not null then
    perform set_config('mm.store_ok', '1', true);
    update store_promo_codes set uses = greatest(uses - 1, 0) where code = o.promo_code;
    perform set_config('mm.store_ok', '', true);
  end if;
end $$;
revoke execute on function public._store_give_back(store_orders, text, boolean) from public, anon, authenticated;

-- ── 7. store_checkout (rebuilt from 20261110235200, item 6) ────────────────────────────────────────
-- p_order adds (store build 2026-11-15): promo, gift_card (a code to pay with), gift and gift_note, slot {day, time};
-- fulfil 'digital' for gift cards alone.
CREATE OR REPLACE FUNCTION public.store_checkout(p_key text, p_id text, p_token text, p_order jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare it jsonb; v store_variants%rowtype; pr store_products%rowtype; n int := 0; qty int; sub numeric := 0; fee numeric;
        fulfil text := p_order ->> 'fulfil'; name text; phone text; email text; addr jsonb; o store_orders%rowtype;
        p payments%rowtype; due numeric; bal numeric; take numeric := 0; who text; lang text := p_order ->> 'lang';
        mins int := _pay_int('store.orderMinutes', 30, 10, 120); city text; label text;
        ngift int := 0; lines jsonb := '[]'::jsonb; elig numeric := 0; img text; unit numeric; offs jsonb; disc numeric;
        promo text; pc jsonb; gc text; g store_gift_cards%rowtype; sl jsonb; sday date; slot jsonb; rest numeric;
        gift boolean := coalesce(p_order -> 'gift' = 'true'::jsonb, false); gnote text;
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
      addr := addr || jsonb_build_object('short', translate(addr ->> 'short', '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'));
      if (addr ->> 'short') !~ '^[A-Z]{4}[0-9]{4}$' then raise exception 'STORE_ADDRESS' using errcode = 'P0001'; end if;
    end if;
    -- a courier may not take a parcel without the national address since 2026-01-01 (TGA): its short code
    if fulfil = 'ksa' and not addr ? 'short' then raise exception 'STORE_ADDRESS' using errcode = 'P0001'; end if;
    if fulfil = 'jeddah' and city not in ('jeddah', 'jiddah', 'jedda', 'جدة', 'جده') then raise exception 'STORE_CITY' using errcode = 'P0001'; end if;
    /* the Jeddah districts the shop delivers to, while staff keep that list on (F79, store build 2026-11-15) */
    if fulfil = 'jeddah' and not _store_district_ok(addr ->> 'district') then raise exception 'STORE_DISTRICT' using errcode = 'P0001'; end if;
    /* scheduled Jeddah delivery (F78): while it is on, a day and a time it offers; a slot sent otherwise is ignored */
    sl := case when fulfil = 'jeddah' then _store_slots() end;
    if sl is not null then
      begin
        sday := case when (p_order #>> '{slot,day}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (p_order #>> '{slot,day}')::date end;
      exception when others then sday := null;
      end;
      if sday is null or not (sday = any(_store_slot_days(sl, _pay_today())))
         or not exists (select 1 from jsonb_array_elements(sl -> 'times') t where t ->> 'id' = p_order #>> '{slot,time}') then
        raise exception 'STORE_SLOT' using errcode = 'P0001';
      end if;
      slot := jsonb_build_object('day', to_char(sday, 'YYYY-MM-DD'), 'time', p_order #>> '{slot,time}');
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
    if v.id is null or not v.active or pr.id is null or not pr.published then raise exception 'STORE_GONE: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if v.stock < qty then raise exception 'STORE_STOCK: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if fulfil = 'ksa' and not pr.ship_ksa and pr.kind <> 'gift_card' then raise exception 'STORE_NO_SHIP: %', it ->> 'variant' using errcode = 'P0001'; end if;
    if exists (select 1 from store_order_items i where i.order_id = o.id and i.variant_id = v.id) then raise exception 'STORE_ITEM' using errcode = 'P0001'; end if;
    unit := coalesce(v.price, pr.price);
    /* a gift card is one face value, 10 to 5000 SAR (store_gift_cards) */
    if pr.kind = 'gift_card' and (unit < 10 or unit > 5000) then raise exception 'STORE_ITEM' using errcode = 'P0001'; end if;
    update store_variants set stock = stock - qty where id = v.id;
    label := nullif(concat_ws(' · ', nullif(v.size, ''), nullif(case when lang = 'ar' then coalesce(v.color_ar, v.color_en) else v.color_en end, '')), '');
    /* X08: the line keeps its own photo (the first one staff tagged with its colour, else the cover) and address */
    img := coalesce((select u.x from unnest(pr.images) with ordinality u(x, k)
                      where v.color_en is not null and pr.image_meta -> u.x ->> 'colour' = v.color_en order by u.k limit 1), pr.images[1]);
    insert into store_order_items (order_id, product_id, variant_id, name, variant, unit_price, qty, image, slug, gift_card)
    values (o.id, pr.id, v.id, case when lang = 'ar' then coalesce(pr.name_ar, pr.name_en) else pr.name_en end, label, unit, qty,
            left(img, 300), pr.slug, pr.kind = 'gift_card');
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
end $function$;
revoke execute on function public.store_checkout(text, text, text, jsonb) from public;
grant execute on function public.store_checkout(text, text, text, jsonb) to anon, authenticated;

-- ── 8. For the website's server (the server key) ──────────────────────────────────────────────────
-- What a code takes off the cart's lines (F67; route /api/store/promo). The database prices the lines itself; a line
-- gone, out of stock or a gift card is left out. Changes nothing but the meter.
create or replace function public.store_promo_check(p_key text, p_code text, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
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
    continue when v.id is null or not v.active or v.stock < qty or v.id = any(seen);
    select * into pr from store_products where id = v.product_id;
    continue when pr.id is null or not pr.published or pr.kind = 'gift_card';
    seen := seen || v.id;
    lines := lines || jsonb_build_array(jsonb_build_object('product', pr.id, 'unit', coalesce(v.price, pr.price), 'qty', qty));
    elig := elig + coalesce(v.price, pr.price) * qty;
  end loop;
  disc := coalesce((select sum((x ->> 'amount')::numeric) from jsonb_array_elements(_store_bundle_off(lines)) x), 0);
  return _store_promo_off(upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g')), round(elig - disc, 2), false);
end $$;
revoke execute on function public.store_promo_check(text, text, jsonb) from public;
grant execute on function public.store_promo_check(text, text, jsonb) to anon, authenticated;

-- What a gift card still holds and until when (F57; route /api/store/gift-card): unknown, void or empty is STORE_GIFT,
-- past its expiry STORE_GIFT_EXPIRED.
create or replace function public.store_gift_card_check(p_key text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare g store_gift_cards%rowtype;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _ip_gate('storegift' || _store_visitor(), 10, interval '10 minutes') then raise exception 'STORE_BUSY' using errcode = 'P0001'; end if;
  select * into g from store_gift_cards where code = upper(regexp_replace(coalesce(p_code, ''), '\s+', '', 'g'));
  if g.id is null or g.status <> 'active' or g.balance <= 0 then raise exception 'STORE_GIFT' using errcode = 'P0001'; end if;
  if g.expires_at <= now() then raise exception 'STORE_GIFT_EXPIRED' using errcode = 'P0001'; end if;
  return jsonb_build_object('code', g.code, 'balance', g.balance, 'expires_at', g.expires_at);
end $$;
revoke execute on function public.store_gift_card_check(text, text) from public;
grant execute on function public.store_gift_card_check(text, text) to anon, authenticated;

-- A shopper asks to be told when a sold-out choice is back (F34; route /api/store/stock-request): a name and a Saudi
-- mobile, for staff to call on WhatsApp. The same choice and phone asked again while open answers the open one.
create or replace function public.store_stock_request(p_key text, p_variant uuid, p_name text, p_phone text, p_lang text) returns jsonb
language plpgsql security definer set search_path = public as $$
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
  if v.id is null or not v.active or pr.id is null or not pr.published then raise exception 'STORE_GONE' using errcode = 'P0001'; end if;
  insert into store_stock_requests (product_id, variant_id, label, name, phone, lang)
  values (pr.id, v.id, left(nullif(concat_ws(' · ', nullif(v.size, ''), nullif(v.color_en, '')), ''), 60), nm, ph,
          case when p_lang ~ '^[a-z]{2}$' then p_lang end)
  on conflict (variant_id, phone) where status = 'open' do nothing
  returning * into r;
  if r.id is null then
    select * into r from store_stock_requests where variant_id = v.id and phone = ph and status = 'open';
  end if;
  return jsonb_build_object('id', r.id);
end $$;
revoke execute on function public.store_stock_request(text, uuid, text, text, text) from public;
grant execute on function public.store_stock_request(text, uuid, text, text, text) to anon, authenticated;

-- A return or an exchange asked for on the order's page (F93; route /api/store/return), by the order's number and its
-- key: a delivered order, within 7 days of delivery for a return and 15 for an exchange (Riyadh days, as the policy
-- says), none open, its own lines that are not gift cards and no more than were bought (less those already returned).
-- Writes the request and a public order event; answers the customer's order.
create or replace function public.store_return_request(p_key text, p_no bigint, p_track text, p_kind text, p_items jsonb,
                                                       p_reason text, p_note text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; dat timestamptz; x jsonb; iid bigint; q int; i store_order_items%rowtype; back int;
        items jsonb := '[]'::jsonb; seen bigint[] := '{}';
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into o from store_orders where no = p_no and track_key = p_track for update;
  if o.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_kind is null or p_kind not in ('return', 'exchange')
     or p_reason is null or p_reason not in ('wrong_size', 'changed_mind', 'damaged', 'not_as_described', 'other') then
    raise exception 'STORE_RETURN_ITEMS' using errcode = 'P0001';
  end if;
  select e.at into dat from store_order_events e where e.order_id = o.id and e.status = 'delivered' order by e.id limit 1;
  if o.status <> 'delivered' or dat is null
     or _pay_today() - (dat at time zone 'Asia/Riyadh')::date > (case when p_kind = 'exchange' then 15 else 7 end) then
    raise exception 'STORE_RETURN_WINDOW' using errcode = 'P0001';
  end if;
  if exists (select 1 from store_return_requests r where r.order_id = o.id and r.status = 'open') then
    raise exception 'STORE_RETURN_OPEN' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 20 then
    raise exception 'STORE_RETURN_ITEMS' using errcode = 'P0001';
  end if;
  for x in select e from jsonb_array_elements(p_items) e loop
    iid := case when (x ->> 'item_id') ~ '^[0-9]{1,18}$' then (x ->> 'item_id')::bigint end;
    q := case when (x ->> 'qty') ~ '^[0-9]{1,2}$' then (x ->> 'qty')::int end;
    if iid is null or q is null or q < 1 or iid = any(seen) then raise exception 'STORE_RETURN_ITEMS' using errcode = 'P0001'; end if;
    select * into i from store_order_items where id = iid and order_id = o.id;
    if i.id is null or i.gift_card then raise exception 'STORE_RETURN_ITEMS' using errcode = 'P0001'; end if;
    select coalesce(sum((y ->> 'qty')::int), 0) into back
      from store_return_requests rr cross join jsonb_array_elements(rr.items) y
     where rr.order_id = o.id and rr.status = 'approved' and rr.kind = 'return' and (y ->> 'item_id')::bigint = iid;
    if q > i.qty - back then raise exception 'STORE_RETURN_ITEMS' using errcode = 'P0001'; end if;
    seen := seen || iid;
    items := items || jsonb_build_array(jsonb_build_object('item_id', iid, 'qty', q));
  end loop;
  begin
    insert into store_return_requests (order_id, kind, items, reason, note)
    values (o.id, p_kind, items, p_reason, left(nullif(btrim(coalesce(p_note, '')), ''), 300));
  exception when unique_violation then raise exception 'STORE_RETURN_OPEN' using errcode = 'P0001';
  end;
  insert into store_order_events (order_id, status, note) values (o.id, 'return_requested', p_kind);
  return _store_order_json(o);
end $$;
revoke execute on function public.store_return_request(text, bigint, text, text, jsonb, text, text) from public;
grant execute on function public.store_return_request(text, bigint, text, text, jsonb, text, text) to anon, authenticated;

-- A verified buyer's review (F94; route /api/store/review): the order by its number and key, delivered, the product
-- one of its lines that is not a gift card, 1-5 stars, one review per product of an order. Pending until staff show it.
create or replace function public.store_review_add(p_key text, p_no bigint, p_track text, p_product uuid, p_rating int,
                                                   p_body text, p_lang text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; rid uuid;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into o from store_orders where no = p_no and track_key = p_track;
  if o.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status <> 'delivered' then raise exception 'STORE_REVIEW_STATE' using errcode = 'P0001'; end if;
  if p_product is null or not exists (select 1 from store_order_items i where i.order_id = o.id and i.product_id = p_product and not i.gift_card)
     or not exists (select 1 from store_products sp where sp.id = p_product) then
    raise exception 'STORE_REVIEW_ITEM' using errcode = 'P0001';
  end if;
  if p_rating is null or p_rating not between 1 and 5 then raise exception 'STORE_REVIEW_RATING' using errcode = 'P0001'; end if;
  insert into store_reviews (product_id, order_id, rating, body, lang, bought_month)
  values (p_product, o.id, p_rating, left(nullif(btrim(coalesce(p_body, '')), ''), 1000), case when p_lang ~ '^[a-z]{2}$' then p_lang end,
          to_char(coalesce(o.paid_at, o.created_at) at time zone 'Asia/Riyadh', 'YYYY-MM'))
  on conflict (order_id, product_id) do nothing
  returning id into rid;
  if rid is null then raise exception 'STORE_REVIEW_DONE' using errcode = 'P0001'; end if;
  return jsonb_build_object('id', rid);
end $$;
revoke execute on function public.store_review_add(text, bigint, text, uuid, int, text, text) from public;
grant execute on function public.store_review_add(text, bigint, text, uuid, int, text, text) to anon, authenticated;

-- ── 10. Payments (rebuilt) ─────────────────────────────────────────────────────────────────────────
-- The page that takes a payment (20261110150000): an order's also gives its subtotal, discount, gift card part, total
-- and the payment's provider (store build 2026-11-15, w4's pay page), and its buyer and where it goes for the
-- instalments provider's session (F84; read by the website's server alone, never drawn: w4's addition 2).
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
                                'items', (_store_order_json(o)) -> 'items', 'delivery_fee', o.delivery_fee, 'wallet_paid', o.wallet_paid,
                                'subtotal', o.subtotal, 'discount', o.discount, 'gift_paid', o.gift_paid, 'total', o.total,
                                'provider', p.provider,
                                'buyer', case when o.id is not null then jsonb_build_object('name', o.name, 'phone', o.phone, 'email', o.email) end,
                                'ship', case when o.fulfil in ('jeddah', 'ksa') and jsonb_typeof(o.address) = 'object' then
                                          jsonb_strip_nulls(jsonb_build_object('city', o.address ->> 'city', 'district', o.address ->> 'district',
                                                                               'street', o.address ->> 'street', 'postal', o.address ->> 'postal')) end);
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

-- The one way a payment becomes paid (20261110150000); it now records who took the money: p_info.provider 'moyasar'
-- (the default) or 'tabby' (F84, store build 2026-11-15).
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
  /* the provider that took it: Moyasar unless the server says Tabby (F84, store build 2026-11-15 (20261115200100)) */
  update payments set status = 'paid', provider_id = p_provider_id, paid_at = now(), message = null,
         provider = case when p_info ->> 'provider' in ('moyasar', 'tabby') then p_info ->> 'provider' else 'moyasar' end,
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

-- _pay_apply (rebuilt from 20261111235200, item 2): an order paid after its hold ran out also takes its gift card part
-- and its code's use again (or its payment is refunded, as for stock), and every order it marks paid issues its gift
-- cards (_store_paid).
CREATE OR REPLACE FUNCTION public._pay_apply(p payments)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare l jsonb; q queue_entries%rowtype; amt numeric; back numeric := 0; o store_orders%rowtype; i store_order_items%rowtype;
        r locker_rentals%rowtype; j workshop_jobs%rowtype; ok boolean; w numeric; due numeric;
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
          /* the room counted as for a new booking (bug hunt 2026-11-10): no trigger counts places on a change of status */
          if not _pay_place_free(q) then raise exception 'SESSION_FULL'; end if;
          update queue_entries set status = 'waiting', cancel_reason = null, cancelled_at = null, cancelled_by = null where id = q.id;
          /* the wallet's part went back to the wallet when the place was let go: taken again, as the order's branch
             below does - all of it or none, and only from a rider who let the wallet pay this booking; else the card
             is refunded and the booking stays cancelled (bug hunt 2026-11-10) */
          select * into q from queue_entries where id = q.id;
          w := round(_wallet_amount(q.price, q.addons) - coalesce(q.wallet_paid, 0) - amt, 2);
          if w > 0 then
            if not exists (select 1 from wallet_ledger x where x.booking_id = q.id and x.kind = 'spend') then
              raise exception 'PAY_SHORT';
            end if;
            perform _wallet_post(_wallet_owner(q.customer_id), -w, 'spend', null, null, q.id, null, q.session_id);
            perform set_config('mm.wallet_ok', '1', true);
            update queue_entries set wallet_paid = coalesce(wallet_paid, 0) + w where id = q.id;
            perform set_config('mm.wallet_ok', '', true);
          end if;
        exception when others then ok := false;
        end;
        if not ok then back := back + amt; continue; end if;
      end if;
      /* what the booking owes now against what this payment brings for it: while the card payment was open the wallet
         may have paid part of it, its wallet part may have been taken back, or staff may have changed its price, and it
         was marked paid at the amount frozen when the payment started (100 by card on top of 40 from the wallet: 140
         for a 100 SAR ride). A payment bringing more than is owed now pays what is owed and the rest is refunded; one
         bringing less, or a booking owing nothing, is refunded whole and the booking stays to pay (no longer held by
         this payment), as a workshop job's payment is (bug hunt 2026-11-11 (20261111235200)) */
      select * into q from queue_entries where id = q.id;
      due := _pay_due(q);
      if due <= 0 or due > round(amt, 2) then
        back := back + amt;
        update queue_entries set pay_hold_until = null where id = q.id and payment_id = p.id and pay_hold_until is not null;
        continue;
      end if;
      if due < round(amt, 2) then
        back := back + (amt - due);
        amt := due;
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
        /* the gift card's part went back onto it on the cancel: taken again while the card still holds it and has not
           expired, else the payment is refunded; the code's use is counted again (store build 2026-11-15 (20261115200100)) */
        if o.gift_card_id is not null and o.gift_paid > 0 then
          update store_gift_cards set balance = balance - o.gift_paid
           where id = o.gift_card_id and status = 'active' and balance >= o.gift_paid and expires_at > now();
          if not found then raise exception 'STORE_GIFT'; end if;
          insert into store_gift_card_moves (card_id, order_id, amount, kind, by_name) values (o.gift_card_id, o.id, -o.gift_paid, 'spend', 'system');
        end if;
        if o.promo_code is not null then
          perform set_config('mm.store_ok', '1', true);
          update store_promo_codes set uses = uses + 1 where code = o.promo_code;
          perform set_config('mm.store_ok', '', true);
        end if;
      exception when others then ok := false;
      end;
      if not ok then return p.amount; end if;
    else
      return p.amount;
    end if;
    update store_orders set status = 'paid', paid_at = now(), expires_at = null, cancel_reason = null where id = o.id returning * into o;
    insert into store_order_events (order_id, status, note) values (o.id, 'paid', null);
    insert into receipt_numbers (receipt_id) values ('ord-' || o.no) on conflict (receipt_id) do nothing;
    /* its gift cards, and a gift card order delivered at once (store build 2026-11-15 (20261115200100)) */
    perform _store_paid(o);
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
    /* a payment started before staff changed the price pays the old price: refunded, the job stays to pay
       (bug hunt 2026-11-10) */
    if j.id is null or j.paid_at is not null or p.amount is distinct from round(j.price_final, 2) then return p.amount; end if;
    update workshop_jobs set paid_at = now(), paid_receipt = 'pay-' || p.id, payment_id = p.id where id = j.id;
  end if;
  perform set_config('mm.pay_ok', '', true);
  return round(back, 2);
end $function$;
revoke execute on function public._pay_apply(payments) from public, anon, authenticated;

-- _pay_release (rebuilt from 20261110235200, item 2): an order let go unpaid also gives back its gift card part and its
-- code's use.
CREATE OR REPLACE FUNCTION public._pay_release(p payments, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare o store_orders%rowtype; sids text[]; sid text; s sessions%rowtype; n int;
begin
  if p.kind = 'booking' and p.hold then
    perform set_config('mm.pay_ok', '1', true);
    with gone as (
      update queue_entries set status = 'cancelled', cancel_reason = 'unpaid', cancelled_by = 'system', cancelled_at = now(),
                               pay_hold_until = null
       where id = any(p.refs) and payment_id = p.id and not coalesce(paid, false) and pay_hold_until is not null
         and coalesce(status, '') in ('waiting', 'waitlist')
      returning session_id)
    select array_agg(distinct session_id) into sids from gone;
    perform set_config('mm.pay_ok', '', true);
    /* the places let go go to the waitlist in its order, as when a rider cancels (bug hunt 2026-11-10: the fill rule
       counts the waitlist, so the night stayed 'full' and nobody moved up). As _session_capacity_promote: an open
       night or one full by the count; never an approval ride, a full staff set or a night gone */
    foreach sid in array coalesce(sids, '{}'::text[]) loop
      select * into s from sessions where id = sid;
      if s.id is null or coalesce(s.needs_approval, false)
         or coalesce(s.session_date, '') < to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
         or not (coalesce(s.status, '') = 'open' or (s.status = 'full' and coalesce(s.auto_full, false))) then
        continue;
      end if;
      n := 0;
      while n < 500 and _promote_next_waitlist(sid) is not null loop
        n := n + 1;
      end loop;
    end loop;
  elsif p.kind = 'order' then
    select * into o from store_orders where id = p.ref::uuid for update;
    if o.status = 'pending' then
      perform _store_restock(o.id);
      if o.wallet_paid > 0 then
        perform _wallet_post(_wallet_owner(o.customer_id), o.wallet_paid, 'sale_back', null, null, null, 'ord-' || o.no, null);
      end if;
      /* the gift card's part back onto it and the code's use back (store build 2026-11-15 (20261115200100)) */
      perform _store_give_back(o, 'system', true);
      update store_orders set status = 'cancelled', cancel_reason = 'unpaid', expires_at = null where id = o.id;
      insert into store_order_events (order_id, status, note) values (o.id, 'cancelled', p_reason);
    end if;
  elsif p.kind = 'locker' then
    update locker_rentals set status = 'cancelled', cancel_reason = 'unpaid', cancelled_by = 'system', cancelled_at = now()
     where id::text = any(p.refs) and payment_id = p.id and status = 'reserved' and receipt_id is null and pay = 'card';
  end if;
end $function$;
revoke execute on function public._pay_release(payments, text) from public, anon, authenticated;

-- pay_refund_done (rebuilt from 20261110235200 item 4 with 20261110235500's patch 3a): an order paid in part by a gift
-- card is refunded whole once the card's and wallet's refunds cover what neither the wallet nor the gift card paid (the
-- gift card's part went back onto it on the cancel).
CREATE OR REPLACE FUNCTION public.pay_refund_done(p_key text, p_refund uuid, p_ok boolean, p_refunded_halalas integer, p_error text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r payment_refunds%rowtype; p payments%rowtype; tot numeric; done_sum numeric; late boolean := false; topup boolean;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into r from payment_refunds where id = p_refund for update;
  if r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into p from payments where id = r.payment_id for update;
  /* a wallet top-up's own refund took its money out of the wallet when it was sent (staff_pay_refund_begin); one owed
     on another Moyasar payment of it (paid twice) never was in the wallet */
  topup := p.kind = 'topup' and r.provider_id is not distinct from p.provider_id;
  if r.status <> 'pending' then
    /* the reconcile run marked it failed while this server was still sending it, and Moyasar took it: done after all
       (bug hunt 2026-11-10) */
    if not (coalesce(p_ok, false) and r.status = 'failed' and r.dest = 'card') then
      return jsonb_build_object('ok', true, 'status', r.status);
    end if;
    late := true;
  end if;
  if not p_ok then
    update payment_refunds set status = 'failed', error = left(p_error, 300) where id = r.id;
    if topup then  /* its money goes back into the wallet, for a retry to take out again */
      perform set_config('mm.wallet_note', 'card refund failed', true);
      perform _wallet_post(_wallet_owner(p.customer_id), r.amount, 'adjust', null, null, null, 'pay-' || p.id, null);
      perform set_config('mm.wallet_note', '', true);
    end if;
    perform _pay_event(r.payment_id, 'refund', 'failed', r.provider_id, p_error);
    return jsonb_build_object('ok', false, 'status', 'failed');
  end if;
  /* what this database counts done on that Moyasar payment, this refund aside */
  select coalesce(sum(x.amount), 0) into done_sum from payment_refunds x
   where x.payment_id = r.payment_id and x.provider_id is not distinct from r.provider_id and x.dest = 'card'
     and x.status = 'done' and x.id <> r.id;
  if late then
    if coalesce(p_refunded_halalas, 0) / 100.0 < done_sum + r.amount then
      return jsonb_build_object('ok', true, 'status', r.status);  /* Moyasar's total does not show it */
    end if;
    if topup then  /* the failure put its money back into the wallet: out again */
      perform set_config('mm.wallet_note', 'card refund went through', true);
      perform _wallet_post(_wallet_owner(p.customer_id), -r.amount, 'takeout', 'online', null, null, 'pay-' || p.id, null);
      perform set_config('mm.wallet_note', '', true);
    end if;
  end if;
  update payment_refunds set status = 'done', done_at = now(), error = null where id = r.id;
  if r.provider_id is not distinct from p.provider_id then
    /* Moyasar's total, or the refunds done with this one, whichever is more (bug hunt 2026-11-10: the old total plus
       this refund counted it twice when Moyasar's earlier answer already held it) */
    tot := greatest(coalesce(p_refunded_halalas, 0) / 100.0, done_sum + r.amount);
    update payments set refunded = least(tot, amount),
                        status = case when least(tot, amount) >= amount then 'refunded' else 'partly_refunded' end
     where id = p.id;
    /* a workshop job this payment paid is to pay again once the payment is refunded whole (card and wallet), as a
       till receipt voided or refunded leaves it; a part refund leaves it paid (bug hunt 2026-11-10 (20261110235500)) */
    if p.kind = 'workshop' then
      update workshop_jobs set paid_at = null, paid_receipt = null
       where paid_receipt = 'pay-' || p.id
         and (select x.refunded from payments x where x.id = p.id)
             + coalesce((select sum(w.amount) from payment_refunds w where w.payment_id = p.id and w.dest = 'wallet'
                           and w.status = 'done' and w.provider_id is not distinct from p.provider_id), 0) >= p.amount;
    end if;
  end if;
  if r.order_id is not null then
    insert into store_order_events (order_id, status, note, by_name) values (r.order_id, 'refund', r.amount::text || ' SAR', r.by_name);
    /* what neither the wallet nor a gift card paid (both went back on the cancel) (store build 2026-11-15 (20261115200100)) */
    update store_orders set status = 'refunded'
     where id = r.order_id and status = 'cancelled'
       and (select coalesce(sum(x.amount), 0) from payment_refunds x where x.order_id = r.order_id and x.status = 'done' and x.dest in ('card', 'wallet'))
           >= total - wallet_paid - gift_paid;
  end if;
  perform _pay_event(r.payment_id, 'refund', 'done', r.provider_id, r.amount::text);
  return jsonb_build_object('ok', true, 'status', 'done');
end $function$;
revoke execute on function public.pay_refund_done(text, uuid, boolean, integer, text) from public;
grant execute on function public.pay_refund_done(text, uuid, boolean, integer, text) to anon, authenticated;

-- staff_pay_refund_begin (rebuilt from 20261110235200 item 5 with 20261110235500's patch 3b): the same gift card rule
-- when a wallet refund makes an order whole.
CREATE OR REPLACE FUNCTION public.staff_pay_refund_begin(p_payment uuid, p_amount numeric, p_dest text, p_reason text, p_refund uuid DEFAULT NULL::uuid, p_op text DEFAULT NULL::text, p_approval text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  /* a wallet top-up put its money in the wallet: that money is refunded to the card only, out of the wallet (bug hunt
     2026-11-10: 'To wallet' credited it a second time); one owed on another Moyasar payment of it (paid twice) may go
     either way */
  if p.kind = 'topup' and p_dest = 'wallet' and coalesce(r.provider_id, p.provider_id) is not distinct from p.provider_id then
    raise exception 'PAY_DEST' using errcode = 'P0001';
  end if;
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
      /* refunded whole: 'refunded', as the card's answer does it in pay_refund_done (bug hunt 2026-11-10); what neither
         the wallet nor a gift card paid (store build 2026-11-15 (20261115200100)) */
      update store_orders set status = 'refunded'
       where id = r.order_id and status = 'cancelled'
         and (select coalesce(sum(x.amount), 0) from payment_refunds x where x.order_id = r.order_id and x.status = 'done' and x.dest in ('card', 'wallet'))
             >= total - wallet_paid - gift_paid;
    end if;
    /* a workshop job this payment paid is to pay again once the payment is refunded whole (card and wallet), as
       pay_refund_done does (bug hunt 2026-11-10 (20261110235500)) */
    if p.kind = 'workshop' and r.provider_id is not distinct from p.provider_id then
      update workshop_jobs set paid_at = null, paid_receipt = null
       where paid_receipt = 'pay-' || p.id
         and p.refunded + coalesce((select sum(w.amount) from payment_refunds w where w.payment_id = p.id and w.dest = 'wallet'
                                      and w.status = 'done' and w.provider_id is not distinct from p.provider_id), 0) >= p.amount;
    end if;
    perform _pay_event(p.id, 'staff', 'refund_wallet', null, amt::text);
  else
    /* a top-up's own money leaves the wallet now (WALLET_SHORT when it is spent); a failed send puts it back
       (pay_refund_done). A refund owed on another Moyasar payment of it (paid twice) was never in the wallet
       (bug hunt 2026-11-10: the card got the money back and the wallet kept it) */
    if p.kind = 'topup' and coalesce(r.provider_id, p.provider_id) is not distinct from p.provider_id then
      perform set_config('mm.wallet_op', left(coalesce(p_op, who), 40), true);
      perform set_config('mm.wallet_note', coalesce(p_reason, ''), true);
      perform _wallet_post(_wallet_owner(p.customer_id), -amt, 'takeout', 'online', null, null, 'pay-' || p.id, null);
      perform set_config('mm.wallet_op', '', true);
      perform set_config('mm.wallet_note', '', true);
    end if;
    /* sent now, so the reconcile run's two-minute grace starts now (a refund owed for days, or a failed one retried,
       was in its list at once and could be marked failed while being sent); a refund owed on another Moyasar payment
       goes to that one (bug hunt 2026-11-10) */
    update payment_refunds set amount = amt, dest = 'card', status = 'pending', provider_id = coalesce(provider_id, p.provider_id),
                               created_at = now(),
                               reason = coalesce(left(p_reason, 200), reason), by_user = auth.uid(), by_name = left(coalesce(p_op, who), 60), error = null
     where id = r.id returning * into r;
    perform _pay_event(p.id, 'staff', 'refund_card', r.provider_id, amt::text);
  end if;
  return jsonb_build_object('id', r.id, 'status', r.status, 'dest', r.dest, 'amount', r.amount, 'provider_id', r.provider_id);
end $function$;
revoke execute on function public.staff_pay_refund_begin(uuid, numeric, text, text, uuid, text, text) from public, anon;
grant execute on function public.staff_pay_refund_begin(uuid, numeric, text, text, uuid, text, text) to authenticated;

-- ── 9. Staff: orders (rebuilt) ─────────────────────────────────────────────────────────────────────
-- 'open' includes out for delivery (F96).
create or replace function public.staff_store_orders(p_status text default null, p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(_store_order_json(o, true) order by o.created_at desc)
                     from (select * from store_orders
                            where (p_status is null and status <> 'pending') or status = p_status
                               or (p_status = 'open' and status in ('paid', 'preparing', 'ready', 'shipped', 'out'))
                            order by created_at desc limit least(greatest(coalesce(p_limit, 200), 1), 500)) o), '[]'::jsonb);
end $$;
revoke execute on function public.staff_store_orders(text, int) from public, anon;
grant execute on function public.staff_store_orders(text, int) to authenticated;

-- Moves an order along: paid -> preparing -> ready (pickup) / shipped or out for delivery (Jeddah, the rest of Saudi
-- Arabia) -> delivered. Out for delivery (F96) is from paid, preparing or shipped; delivered from out too. A gift card
-- order ('digital') is delivered when paid and takes only 'delivered'. Any staff.
create or replace function public.staff_store_order_set(p_order uuid, p_status text, p_note text default null,
                                                        p_courier text default null, p_tracking text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; who text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into o from store_orders where id = p_order for update;
  if o.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_status is null or p_status not in ('preparing', 'ready', 'shipped', 'out', 'delivered') then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  if o.status not in ('paid', 'preparing', 'ready', 'shipped', 'out') then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  if o.fulfil = 'digital' and p_status <> 'delivered' then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  if p_status = 'ready' and o.fulfil <> 'pickup' then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  if p_status in ('shipped', 'out') and o.fulfil not in ('jeddah', 'ksa') then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  if p_status = 'out' and o.status not in ('paid', 'preparing', 'shipped') then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
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

-- Cancels an order (not yet delivered): its stock goes back, the wallet's part goes back, a gift card's part goes back
-- onto it, a never-paid order gives its code's use back, the gift cards it bought are voided, and what was paid by card
-- is owed as a refund 'due' (Refunds), decided there. What the gift cards it bought have already paid for elsewhere is
-- not given back: it comes off the card's part owed first, then off the wallet's part. Managers and admins. (Rebuilt
-- from 20261110150000 with 20261110235500's patch.)
create or replace function public.staff_store_order_cancel(p_order uuid, p_reason text, p_op text default null, p_approval text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; p payments%rowtype; who text; owed numeric; g store_gift_cards%rowtype; kept numeric := 0; cut numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() and not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into o from store_orders where id = p_order for update;
  if o.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if o.status in ('delivered', 'cancelled', 'refunded') then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  select coalesce(nullif(btrim(s.display_name), ''), 'Staff') into who from staff s where s.user_id = auth.uid();
  perform _store_restock(o.id);
  /* the gift cards this order bought are issued once it is paid, so they may be spent before the goods go out: what
     they paid for elsewhere stays spent and is kept back from the refund (store build review 2026-11-15: a 100 SAR card
     spent in full and its order cancelled still owed the 100 SAR by card) */
  select greatest(coalesce(-sum(m.amount), 0), 0) into kept
    from store_gift_card_moves m join store_gift_cards gc on gc.id = m.card_id
   where gc.order_id = o.id and m.kind in ('spend', 'back', 'refund');
  select * into p from payments where id = o.payment_id;
  /* owed: the card's money less what came back or is on its way, on the order's own Moyasar payment, as
     staff_pay_refund_begin counts it: card refunds done (p.refunded), being sent, failed (for a retry), wallet
     refunds done, and refunds already owed. Nothing when nothing is left; an order refunded whole before the cancel
     is 'refunded', as pay_refund_done and staff_pay_refund_begin leave it (bug hunt 2026-11-10 (20261110235500): it
     was p.amount - p.refunded, so those were owed a second time) */
  if p.status in ('paid', 'partly_refunded') then
    owed := round(p.amount - p.refunded - coalesce((select sum(x.amount) from payment_refunds x
              where x.payment_id = p.id and x.provider_id is not distinct from p.provider_id
                and ((x.status = 'pending' and x.dest = 'card') or (x.status = 'done' and x.dest = 'wallet')
                     or x.status in ('due', 'failed'))), 0), 2);
    cut := least(greatest(owed, 0), kept);
    owed := owed - cut;
    kept := kept - cut;
  end if;
  if o.wallet_paid - kept > 0 then
    perform set_config('mm.wallet_op', left(coalesce(p_op, who), 40), true);
    perform _wallet_post(_wallet_owner(o.customer_id), o.wallet_paid - kept, 'sale_back', null, null, null, 'ord-' || o.no, null);
    perform set_config('mm.wallet_op', '', true);
  end if;
  /* a gift card's part back onto it; a code's use back for an order never paid; the gift cards it bought are no longer
     sold, so what is left on them is voided (store build 2026-11-15 (20261115200100)) */
  perform _store_give_back(o, left(coalesce(p_op, who), 60), o.status = 'pending');
  for g in select * from store_gift_cards where order_id = o.id and status = 'active' order by created_at for update loop
    update store_gift_cards set status = 'void', balance = 0, voided_at = now(), void_reason = 'order cancelled' where id = g.id;
    insert into store_gift_card_moves (card_id, order_id, amount, kind, by_name) values (g.id, o.id, -g.balance, 'void', left(coalesce(p_op, who), 60));
  end loop;
  if o.status = 'pending' then
    update payments set status = 'cancelled' where id = o.payment_id and status = 'initiated';
  end if;
  update store_orders set status = 'cancelled', cancel_reason = 'staff', expires_at = null where id = o.id returning * into o;
  insert into store_order_events (order_id, status, note, by_name) values (o.id, 'cancelled', left(nullif(btrim(coalesce(p_reason, '')), ''), 300), left(who, 60));
  if p.status in ('paid', 'partly_refunded') then
    if owed > 0 then
      insert into payment_refunds (payment_id, provider_id, amount, status, reason, order_id, by_user, by_name)
      values (p.id, p.provider_id, owed, 'due', left(coalesce(p_reason, 'order cancelled'), 200), o.id, auth.uid(), left(who, 60));
    elsif (select coalesce(sum(x.amount), 0) from payment_refunds x where x.order_id = o.id and x.status = 'done' and x.dest in ('card', 'wallet'))
          >= o.total - o.wallet_paid - o.gift_paid then
      update store_orders set status = 'refunded' where id = o.id and status = 'cancelled' returning * into o;
    end if;
  end if;
  return _store_order_json(o, true);
end $$;
revoke execute on function public.staff_store_order_cancel(uuid, text, text, text) from public, anon;
grant execute on function public.staff_store_order_cancel(uuid, text, text, text) to authenticated;

-- ── 9. Staff: back in stock (F34) ─────────────────────────────────────────────────────────────────
create or replace function public._store_stock_req_json(r store_stock_requests) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', r.id, 'product_id', r.product_id, 'product_name', p.name_en, 'slug', p.slug, 'variant_id', r.variant_id,
                            'label', r.label, 'name', r.name, 'phone', r.phone, 'lang', r.lang, 'status', r.status,
                            'created_at', r.created_at, 'done_at', r.done_at, 'done_by', r.done_by)
    from (select 1) x left join store_products p on p.id = r.product_id
$$;
revoke execute on function public._store_stock_req_json(store_stock_requests) from public, anon, authenticated;

-- The requests, newest first (p_status null: all of them).
create or replace function public.staff_store_stock_requests(p_status text default 'open') returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(_store_stock_req_json(r) order by r.created_at desc)
                     from (select * from store_stock_requests where p_status is null or status = p_status
                            order by created_at desc limit 500) r), '[]'::jsonb);
end $$;
revoke execute on function public.staff_store_stock_requests(text) from public, anon;
grant execute on function public.staff_store_stock_requests(text) to authenticated;

-- Called (done), dropped, or open again.
create or replace function public.staff_store_stock_request_set(p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r store_stock_requests%rowtype; who text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('open', 'done', 'dropped') then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  select coalesce(nullif(btrim(s.display_name), ''), 'Staff') into who from staff s where s.user_id = auth.uid();
  begin
    update store_stock_requests set status = p_status,
           done_at = case when p_status = 'open' then null else now() end,
           done_by = case when p_status = 'open' then null else left(coalesce(who, 'Staff'), 60) end
     where id = p_id returning * into r;
  exception when unique_violation then raise exception 'STORE_STATUS' using errcode = 'P0001';  -- the same ask is open again already
  end;
  if r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return _store_stock_req_json(r);
end $$;
revoke execute on function public.staff_store_stock_request_set(uuid, text) from public, anon;
grant execute on function public.staff_store_stock_request_set(uuid, text) to authenticated;

-- ── 9. Staff: returns (F93) ───────────────────────────────────────────────────────────────────────
create or replace function public._store_return_json(r store_return_requests) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', r.id, 'order_id', r.order_id, 'order_no', o.no, 'name', o.name, 'phone', o.phone, 'kind', r.kind,
    'items', coalesce((select jsonb_agg(jsonb_build_object('item_id', i.id, 'name', i.name, 'variant', i.variant,
                                                           'qty', (t.x ->> 'qty')::int, 'unit_price', i.unit_price) order by t.k)
                         from jsonb_array_elements(r.items) with ordinality t(x, k)
                         join store_order_items i on i.order_id = r.order_id and i.id::text = t.x ->> 'item_id'), '[]'::jsonb),
    'reason', r.reason, 'note', r.note, 'status', r.status, 'amount', r.amount, 'staff_note', r.staff_note,
    'created_at', r.created_at, 'decided_at', r.decided_at, 'decided_by', r.decided_by)
    from (select 1) x left join store_orders o on o.id = r.order_id
$$;
revoke execute on function public._store_return_json(store_return_requests) from public, anon, authenticated;

create or replace function public.staff_store_returns(p_status text default 'open') returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(_store_return_json(r) order by r.created_at desc)
                     from (select * from store_return_requests where p_status is null or status = p_status
                            order by created_at desc limit 500) r), '[]'::jsonb);
end $$;
revoke execute on function public.staff_store_returns(text) from public, anon;
grant execute on function public.staff_store_returns(text) to authenticated;

-- Approve or refuse a return asked for. Admins or the refund right, with the PIN (as a cancel), and a manager over the
-- manager limit for a refund. Approving a return with
-- an amount refunds that much, no more than is left of what the order paid: the card's part first, as a refund owed on
-- the order's payment (Payments > Refunds sends it, the existing flow), then the wallet's at once, then the gift card's
-- (its balance back). An exchange refunds nothing. A public order event says the answer (X09 lists the refunds).
create or replace function public.staff_store_return_decide(p_id uuid, p_approve boolean, p_amount numeric, p_note text,
                                                           p_op text default null, p_approval text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare rq store_return_requests%rowtype; o store_orders%rowtype; p payments%rowtype; who text; amt numeric;
        card_room numeric := 0; wal_room numeric := 0; gift_room numeric := 0; c numeric := 0; w numeric := 0; g numeric := 0;
        nt text := left(nullif(btrim(coalesce(p_note, '')), ''), 300);
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() and not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into rq from store_return_requests where id = p_id for update;
  if rq.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if rq.status <> 'open' then raise exception 'STORE_RETURN_STATE' using errcode = 'P0001'; end if;
  select * into o from store_orders where id = rq.order_id for update;
  select left(coalesce(p_op, nullif(btrim(s.display_name), ''), 'Staff'), 60) into who from staff s where s.user_id = auth.uid();
  who := coalesce(who, left(coalesce(p_op, 'Staff'), 60));
  if not coalesce(p_approve, false) then
    update store_return_requests set status = 'refused', staff_note = nt, decided_by = who, decided_at = now() where id = rq.id;
    insert into store_order_events (order_id, status, note, by_name) values (o.id, 'return_refused', rq.kind, who);
    return _store_order_json(o, true);
  end if;
  amt := case when rq.kind = 'return' then round(coalesce(p_amount, 0), 2) end;
  if amt < 0 then raise exception 'PAY_AMOUNT' using errcode = 'P0001'; end if;
  if amt > 0 then
    -- what is left of each way the order was paid
    select * into p from payments where id = o.payment_id;
    if p.id is not null and p.status in ('paid', 'partly_refunded') then
      card_room := greatest(round(p.amount - p.refunded - coalesce((select sum(x.amount) from payment_refunds x
                     where x.payment_id = p.id and x.provider_id is not distinct from p.provider_id
                       and ((x.status = 'pending' and x.dest = 'card') or (x.status = 'done' and x.dest = 'wallet')
                            or x.status in ('due', 'failed'))), 0), 2), 0);
    end if;
    if o.wallet_paid > 0 and o.customer_id is not null then
      select greatest(coalesce(-sum(l.amount), 0), 0) into wal_room from wallet_ledger l
       where l.receipt_id = 'ord-' || o.no and l.kind in ('sale', 'sale_back');
    end if;
    if o.gift_card_id is not null and o.gift_paid > 0 then
      select greatest(coalesce(-sum(m.amount), 0), 0) into gift_room from store_gift_card_moves m
       where m.card_id = o.gift_card_id and m.order_id = o.id and m.kind in ('spend', 'back', 'refund');
    end if;
    if amt > card_room + wal_room + gift_room then raise exception 'PAY_TOO_MUCH' using errcode = 'P0001'; end if;
    /* over the shop's manager limit a manager's word, as every refund staff make (staff_pay_refund_begin, lockers): the
       wallet's and the gift card's parts are given back here at once, and the staff page asks for that word on approving
       (store build integration 2026-11-15) */
    if not _mgr_ok('refund', amt, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
    c := least(amt, card_room);
    w := least(amt - c, wal_room);
    g := least(amt - c - w, gift_room);
    if c > 0 then
      insert into payment_refunds (payment_id, provider_id, amount, status, reason, order_id, by_user, by_name)
      values (p.id, p.provider_id, c, 'due', 'return ' || rq.id, o.id, auth.uid(), who);
      perform _pay_event(p.id, 'staff', 'refund_due', null, c::text);
    end if;
    if w > 0 then
      perform set_config('mm.wallet_op', left(who, 40), true);
      perform set_config('mm.wallet_note', 'return MM-' || o.no, true);
      perform _wallet_post(_wallet_owner(o.customer_id), w, 'sale_back', null, null, null, 'ord-' || o.no, null);
      perform set_config('mm.wallet_op', '', true);
      perform set_config('mm.wallet_note', '', true);
      insert into store_order_events (order_id, status, note, by_name) values (o.id, 'refund', w::text || ' SAR · wallet', who);
    end if;
    if g > 0 then
      update store_gift_cards set balance = least(amount, balance + g) where id = o.gift_card_id;
      insert into store_gift_card_moves (card_id, order_id, amount, kind, by_name) values (o.gift_card_id, o.id, g, 'refund', who);
      insert into store_order_events (order_id, status, note, by_name) values (o.id, 'refund', g::text || ' SAR · gift card', who);
    end if;
  end if;
  update store_return_requests set status = 'approved', amount = amt, staff_note = nt, decided_by = who, decided_at = now() where id = rq.id;
  insert into store_order_events (order_id, status, note, by_name) values (o.id, 'return_approved', rq.kind, who);
  return _store_order_json(o, true);
end $$;
revoke execute on function public.staff_store_return_decide(uuid, boolean, numeric, text, text, text) from public, anon;
grant execute on function public.staff_store_return_decide(uuid, boolean, numeric, text, text, text) to authenticated;

-- ── 9. Staff: reviews (F42, F94) ──────────────────────────────────────────────────────────────────
-- Staff list reviews by reading store_reviews (row security); an admin shows, hides or holds one.
create or replace function public.staff_store_review_set(p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r store_reviews%rowtype; who text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('pending', 'shown', 'hidden') then raise exception 'STORE_STATUS' using errcode = 'P0001'; end if;
  select coalesce(nullif(btrim(s.display_name), ''), 'Staff') into who from staff s where s.user_id = auth.uid();
  update store_reviews set status = p_status, decided_at = now(), decided_by = left(coalesce(who, 'Staff'), 60)
   where id = p_id returning * into r;
  if r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return to_jsonb(r);
end $$;
revoke execute on function public.staff_store_review_set(uuid, text) from public, anon;
grant execute on function public.staff_store_review_set(uuid, text) to authenticated;

-- ── 9. Staff: gift cards (F57) ────────────────────────────────────────────────────────────────────
create or replace function public._store_gift_json(g store_gift_cards) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', g.id, 'code', g.code, 'amount', g.amount, 'balance', g.balance, 'status', g.status,
                            'created_at', g.created_at, 'expires_at', g.expires_at, 'order_id', g.order_id, 'note', g.note, 'issued_by', g.issued_by,
                            'voided_at', g.voided_at, 'void_reason', g.void_reason)
$$;
revoke execute on function public._store_gift_json(store_gift_cards) from public, anon, authenticated;

-- A card by hand (a prize, a goodwill gesture): 10-5000 SAR (STORE_GIFT_AMOUNT). Admins or the refund right, the PIN,
-- and a manager over the manager limit.
create or replace function public.staff_store_gift_card_issue(p_amount numeric, p_note text, p_op text default null, p_approval text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare g store_gift_cards%rowtype; who text; amt numeric := round(p_amount, 2);
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() and not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if amt is null or amt < 10 or amt > 5000 then raise exception 'STORE_GIFT_AMOUNT' using errcode = 'P0001'; end if;
  /* a card is money to spend: over the shop's manager limit a manager's word, as for a refund (the staff page asks for it
     as one; store build integration 2026-11-15) */
  if not _mgr_ok('refund', amt, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  select left(coalesce(p_op, nullif(btrim(s.display_name), ''), 'Staff'), 60) into who from staff s where s.user_id = auth.uid();
  who := coalesce(who, left(coalesce(p_op, 'Staff'), 60));
  insert into store_gift_cards (code, amount, balance, note, issued_by)
  values (_store_gift_code(), amt, amt, left(nullif(btrim(coalesce(p_note, '')), ''), 120), who)
  returning * into g;
  insert into store_gift_card_moves (card_id, amount, kind, by_name) values (g.id, g.amount, 'issue', who);
  return _store_gift_json(g);
end $$;
revoke execute on function public.staff_store_gift_card_issue(numeric, text, text, text) from public, anon;
grant execute on function public.staff_store_gift_card_issue(numeric, text, text, text) to authenticated;

-- A card voided: nothing left on it (move 'void'); STORE_GIFT_STATE when it is void already.
create or replace function public.staff_store_gift_card_void(p_id uuid, p_reason text, p_op text default null, p_approval text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare g store_gift_cards%rowtype; who text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() and not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into g from store_gift_cards where id = p_id for update;
  if g.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if g.status = 'void' then raise exception 'STORE_GIFT_STATE' using errcode = 'P0001'; end if;
  select left(coalesce(p_op, nullif(btrim(s.display_name), ''), 'Staff'), 60) into who from staff s where s.user_id = auth.uid();
  who := coalesce(who, left(coalesce(p_op, 'Staff'), 60));
  insert into store_gift_card_moves (card_id, amount, kind, by_name) values (g.id, -g.balance, 'void', who);
  update store_gift_cards set status = 'void', balance = 0, voided_at = now(),
         void_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 120)
   where id = g.id returning * into g;
  return _store_gift_json(g);
end $$;
revoke execute on function public.staff_store_gift_card_void(uuid, text, text, text) from public, anon;
grant execute on function public.staff_store_gift_card_void(uuid, text, text, text) to authenticated;

-- A card's expiry moved (a card bought a year ago and not spent, a goodwill extension): to the end of p_until, a Riyadh
-- day from tomorrow up to five years on (STORE_GIFT_DATE otherwise); a void card stays void (STORE_GIFT_STATE). Same
-- rights as issuing one.
create or replace function public.staff_store_gift_card_extend(p_id uuid, p_until date, p_op text default null, p_approval text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare g store_gift_cards%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() and not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into g from store_gift_cards where id = p_id for update;
  if g.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if g.status = 'void' then raise exception 'STORE_GIFT_STATE' using errcode = 'P0001'; end if;
  if p_until is null or p_until <= _pay_today() or p_until > _pay_today() + interval '5 years' then
    raise exception 'STORE_GIFT_DATE' using errcode = 'P0001';
  end if;
  update store_gift_cards set expires_at = ((p_until + 1)::timestamp at time zone 'Asia/Riyadh') where id = g.id returning * into g;
  return _store_gift_json(g);
end $$;
revoke execute on function public.staff_store_gift_card_extend(uuid, date, text, text) from public, anon;
grant execute on function public.staff_store_gift_card_extend(uuid, date, text, text) to authenticated;

-- Void cards and refund (the owner, 2026-11-15), for an order that bought gift cards: a gift card order is delivered at
-- once, so it has no Cancel, and refunding its payment while its codes still work pays twice. One step instead: every card
-- the order bought that still holds a balance is voided (balance zeroed, as staff_store_gift_card_void does; its 'void'
-- move keeps the amount), and only that unspent value is refunded, never more than is left of what the order paid
-- (_store_gift_refund_plan): the card's part as a refund owed on the order's payment (Payments > Refunds sends it, the
-- existing flow), the wallet's at once, as a return's refund. What the cards already paid for elsewhere stays spent; of a
-- mixed order only the gift cards' unspent value goes back. Admins or the refund right, the PIN, and a manager over the
-- manager limit. A second call finds nothing to void and changes nothing. A staff-only order event 'gift_void' says the
-- value voided (the customer reads the cards as void and the refunds as every refund).
create or replace function public.staff_store_order_gift_refund(p_order uuid, p_op text default null, p_approval text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare o store_orders%rowtype; p payments%rowtype; g store_gift_cards%rowtype; plan jsonb; who text; amt numeric; c numeric; w numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() and not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into o from store_orders where id = p_order for update;
  if o.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  /* the cards locked first: a checkout spending one waits, and this reads what is left once it is done */
  perform 1 from store_gift_cards where order_id = o.id and status = 'active' order by id for update;
  plan := _store_gift_refund_plan(o);
  if (plan ->> 'cards')::int = 0 then return _store_order_json(o, true); end if;
  amt := (plan ->> 'refund')::numeric; c := (plan ->> 'card')::numeric; w := (plan ->> 'wallet')::numeric;
  if amt > 0 and not _mgr_ok('refund', amt, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  select left(coalesce(p_op, nullif(btrim(s.display_name), ''), 'Staff'), 60) into who from staff s where s.user_id = auth.uid();
  who := coalesce(who, left(coalesce(p_op, 'Staff'), 60));
  for g in select * from store_gift_cards where order_id = o.id and status = 'active' and balance > 0 order by created_at, code loop
    insert into store_gift_card_moves (card_id, order_id, amount, kind, by_name) values (g.id, o.id, -g.balance, 'void', who);
    update store_gift_cards set status = 'void', balance = 0, voided_at = now(), void_reason = 'voided and refunded' where id = g.id;
  end loop;
  if c > 0 then
    select * into p from payments where id = o.payment_id;
    insert into payment_refunds (payment_id, provider_id, amount, status, reason, order_id, by_user, by_name)
    values (p.id, p.provider_id, c, 'due', 'gift cards voided', o.id, auth.uid(), who);
    perform _pay_event(p.id, 'staff', 'refund_due', null, c::text);
  end if;
  if w > 0 then
    perform set_config('mm.wallet_op', left(who, 40), true);
    perform set_config('mm.wallet_note', 'gift cards voided MM-' || o.no, true);
    perform _wallet_post(_wallet_owner(o.customer_id), w, 'sale_back', null, null, null, 'ord-' || o.no, null);
    perform set_config('mm.wallet_op', '', true);
    perform set_config('mm.wallet_note', '', true);
    insert into store_order_events (order_id, status, note, by_name) values (o.id, 'refund', w::text || ' SAR · wallet', who);
  end if;
  insert into store_order_events (order_id, status, note, public, by_name)
  values (o.id, 'gift_void', (plan ->> 'unspent') || ' SAR', false, who);
  return _store_order_json(o, true);
end $$;
revoke execute on function public.staff_store_order_gift_refund(uuid, text, text) from public, anon;
grant execute on function public.staff_store_order_gift_refund(uuid, text, text) to authenticated;

-- ── Checks ────────────────────────────────────────────────────────────────────────────────────────
-- every definer function written here is still SECURITY DEFINER with its search_path; the inner ones no client may
-- run; the staff ones not anon; the website's ones reachable; every new table under row security
do $chk$
declare f text; t text;
begin
  foreach f in array array[
      'public._store_licence()', 'public._store_slots()', 'public._store_district_ok(text)',
      'public._store_delivery_fee(text,numeric)', 'public._store_product_guard()', 'public._store_promo_guard()',
      'public._store_order_json(public.store_orders,boolean)', 'public._store_bundle_off(jsonb)',
      'public._store_promo_off(text,numeric,boolean)', 'public._store_gift_code()', 'public._store_paid(public.store_orders)',
      'public._store_give_back(public.store_orders,text,boolean)', 'public._store_stock_req_json(public.store_stock_requests)',
      'public._store_return_json(public.store_return_requests)', 'public._store_gift_json(public.store_gift_cards)',
      'public._pay_apply(public.payments)', 'public._pay_release(public.payments,text)',
      'public._store_order_gifts(public.store_orders,boolean,boolean)', 'public.store_order_get(text,bigint,text,text)',
      'public.customer_orders(text,text)', 'public._store_gift_refund_plan(public.store_orders)',
      'public.staff_store_order_gift_refund(uuid,text,text)',
      'public.store_checkout(text,text,text,jsonb)', 'public.store_promo_check(text,text,jsonb)',
      'public.store_gift_card_check(text,text)', 'public.store_stock_request(text,uuid,text,text,text)',
      'public.store_return_request(text,bigint,text,text,jsonb,text,text)',
      'public.store_review_add(text,bigint,text,uuid,integer,text,text)',
      'public.pay_settle(text,uuid,text,text,integer,text,jsonb,text)', 'public.pay_view(text,uuid)',
      'public.pay_refund_done(text,uuid,boolean,integer,text)',
      'public.staff_pay_refund_begin(uuid,numeric,text,text,uuid,text,text)',
      'public.staff_store_orders(text,integer)', 'public.staff_store_order_set(uuid,text,text,text,text)',
      'public.staff_store_order_cancel(uuid,text,text,text)', 'public.staff_store_stock_requests(text)',
      'public.staff_store_stock_request_set(uuid,text)', 'public.staff_store_returns(text)',
      'public.staff_store_return_decide(uuid,boolean,numeric,text,text,text)', 'public.staff_store_review_set(uuid,text)',
      'public.staff_store_gift_card_issue(numeric,text,text,text)', 'public.staff_store_gift_card_void(uuid,text,text,text)',
      'public.staff_store_gift_card_extend(uuid,date,text,text)', 'public._store_invoice(uuid)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array[
      'public._store_licence()', 'public._store_jint(jsonb,integer,integer,integer)', 'public._store_working_day(date,integer)',
      'public._store_slots()', 'public._store_slot_days(jsonb,date)', 'public._store_district_ok(text)', 'public._store_visitor()',
      'public._store_delivery_fee(text,numeric)', 'public._store_product_guard()', 'public._store_promo_guard()',
      'public._store_order_json(public.store_orders,boolean)', 'public._store_bundle_off(jsonb)',
      'public._store_promo_off(text,numeric,boolean)', 'public._store_gift_code()', 'public._store_paid(public.store_orders)',
      'public._store_give_back(public.store_orders,text,boolean)', 'public._store_stock_req_json(public.store_stock_requests)',
      'public._store_return_json(public.store_return_requests)', 'public._store_gift_json(public.store_gift_cards)',
      'public._pay_apply(public.payments)', 'public._pay_release(public.payments,text)', 'public._store_invoice(uuid)',
      'public._store_order_gifts(public.store_orders,boolean,boolean)', 'public._store_gift_refund_plan(public.store_orders)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  foreach f in array array[
      'public.staff_pay_refund_begin(uuid,numeric,text,text,uuid,text,text)', 'public.staff_store_orders(text,integer)',
      'public.staff_store_order_set(uuid,text,text,text,text)', 'public.staff_store_order_cancel(uuid,text,text,text)',
      'public.staff_store_stock_requests(text)', 'public.staff_store_stock_request_set(uuid,text)', 'public.staff_store_returns(text)',
      'public.staff_store_return_decide(uuid,boolean,numeric,text,text,text)', 'public.staff_store_review_set(uuid,text)',
      'public.staff_store_gift_card_issue(numeric,text,text,text)', 'public.staff_store_gift_card_void(uuid,text,text,text)',
      'public.staff_store_gift_card_extend(uuid,date,text,text)', 'public.staff_store_order_gift_refund(uuid,text,text)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception 'staff cannot reach %', f; end if;
  end loop;
  foreach f in array array[
      'public.store_checkout(text,text,text,jsonb)', 'public.store_promo_check(text,text,jsonb)', 'public.store_gift_card_check(text,text)',
      'public.store_stock_request(text,uuid,text,text,text)', 'public.store_return_request(text,bigint,text,text,jsonb,text,text)',
      'public.store_review_add(text,bigint,text,uuid,integer,text,text)', 'public.pay_settle(text,uuid,text,text,integer,text,jsonb,text)',
      'public.pay_view(text,uuid)', 'public.pay_refund_done(text,uuid,boolean,integer,text)',
      'public.store_order_get(text,bigint,text,text)', 'public.customer_orders(text,text)'] loop
    if not has_function_privilege('anon', f, 'execute') then raise exception 'the website cannot reach %', f; end if;
  end loop;
  if to_regprocedure('public.store_order_get(text,bigint,text)') is not null then
    raise exception 'store_order_get(text,bigint,text) is still there beside the four-argument one';
  end if;
  foreach t in array array['store_stock_requests', 'store_return_requests', 'store_reviews', 'store_promo_codes',
                           'store_gift_cards', 'store_gift_card_moves', 'store_invoice_counter'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      raise exception '% has no row security', t;
    end if;
  end loop;
  if has_table_privilege('anon', 'public.store_gift_cards', 'select') or has_table_privilege('anon', 'public.store_promo_codes', 'select')
     or has_table_privilege('anon', 'public.store_stock_requests', 'select') or has_table_privilege('anon', 'public.store_return_requests', 'select')
     or has_table_privilege('authenticated', 'public.store_invoice_counter', 'update') then
    raise exception 'a store table that holds codes or phones is readable by anon';
  end if;
  if has_column_privilege('anon', 'public.store_reviews', 'decided_by', 'select') or has_column_privilege('anon', 'public.store_reviews', 'order_id', 'select')
     or not has_column_privilege('anon', 'public.store_reviews', 'bought_month', 'select') then
    raise exception 'anon reads more of a review than its own words, or not those';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name) values ('20261115200100', 'store_build') on conflict do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only), after applying:
-- select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'store_products'
--           and column_name in ('kind','condition','warranty_months','key_specs','box','fit','faq','sizes','image_meta','goes_with',
--                               'compare_with','bundle','sale_from','sale_to')) as product_columns_14,
--        (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'store_orders'
--           and column_name in ('discount','discounts','promo_code','gift_paid','gift_card_id','gift','gift_note','slot','invoice_no','gift_key')) as order_columns_10,
--        to_regprocedure('public.store_order_get(text,bigint,text,text)') is not null
--          and to_regprocedure('public.store_order_get(text,bigint,text)') is null as order_get_gift_key_true,
--        (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relrowsecurity
--           and c.relname in ('store_stock_requests','store_return_requests','store_reviews','store_promo_codes',
--                             'store_gift_cards','store_gift_card_moves','store_invoice_counter')) as secured_tables_7,
--        (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
--           and p.proname in ('store_promo_check','store_gift_card_check','store_stock_request','store_return_request',
--                             'store_review_add','staff_store_stock_requests','staff_store_stock_request_set','staff_store_returns',
--                             'staff_store_return_decide','staff_store_review_set','staff_store_gift_card_issue',
--                             'staff_store_gift_card_void','staff_store_gift_card_extend','staff_store_order_gift_refund')) as new_definer_functions_14,
--        (select count(*) from store_orders where paid_at is not null and invoice_no is null) as paid_without_invoice_0,
--        (select last_no from store_invoice_counter) = (select coalesce(max(invoice_no), 0) from store_orders) as invoice_counter_true,
--        public._store_delivery_fee('digital', 100) as digital_fee_0,
--        (select count(*) from site_content where key in ('store.tabby.on','store.smsa.on','store.addressLookup.on','store.slots',
--                                                         'store.districts','store.lowStock','store.complaintsDays')) as settings_7,
--        (select count(*) from supabase_migrations.schema_migrations where version = '20261115200100') as ledger_1;
