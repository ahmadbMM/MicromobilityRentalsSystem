-- ============================================================================
-- The Marketplace, first version: the staff side (the user, 2026-11-20: "add a marketplace section in the main
-- website ... i want people to be able to sell products on this page"). Second of two files; apply after
-- 20261121300000_marketplace (the tables, the settings, the customers' functions, the daily job, and the one
-- mapping in _staff_mod that reads the section 'market' as People).
--
-- Staff act on reports; nothing waits for approval but a shop's application. Every function here asks
-- _staff_mod('market', <change>) first (FORBIDDEN, 42501), says BAD_INPUT (22023) for an action or a value that is
-- not one of its own, and uses the customers' codes where the same rule applies (MKT_GONE, MKT_STATE, MKT_INPUT:
-- <key>, MKT_DUP: cr | slug). Staff see personal data in full; staff never change a customer's words.
--
--  1. staff_market_mode() -> 'full' (the staff app's probe: a database without this file answers "no such function").
--  2. staff_market_counts: what waits (held listings, open reports, shop applications, commission not yet received).
--  3. Listings: staff_market_listings, staff_market_listing_get, staff_market_listing_set (hide with a reason the
--     seller reads | restore | release a held one | check | uncheck: the "Checked by our team" mark).
--  4. MicroMobility's own listings (seller_kind 'company', no customer, photos are /media/market/... paths of the
--     site bucket): staff_market_company_save, staff_market_company_state.
--  5. Reports: staff_market_reports, staff_market_report_set; staff_market_thread reads a thread ONLY when a report
--     names it, and every read is written to the trail (thread_read).
--  6. Sellers: staff_market_sellers, staff_market_seller_set (note | strike | unstrike | suspend | restore | met |
--     unmet). Suspending holds the seller's listings on sale; restoring puts those back.
--  7. Shops: staff_market_shops, staff_market_shop_set (approve | reject | suspend | restore | edit). Approving turns
--     the owner's listings on sale into the shop's.
--  8. The honour commission: staff_market_commission, staff_market_commission_set (ticked received by hand).
--  9. staff_market_category_save (nothing is ever deleted: visible false instead).
--
-- Three choices beyond the letter of the contract, each the smaller harm:
--   * restoring a hidden listing that had been sold puts it back as sold, not on sale;
--   * a listing of a suspended seller or shop cannot be released, and one restored from hidden stays held: a
--     suspended seller's listings are never on sale;
--   * the commission list and its count read every listing that was marked sold with a commission due, whatever
--     happened to the listing afterwards (hidden, deleted by its seller): the commission is still due.
-- After the review (2026-11-21), also:
--   * staff take the account's own lock before they act on it (staff_market_seller_set, staff_market_shop_set,
--     staff_market_listing_set), and the shops' lock before a shop is written: a publish cannot pass a suspension
--     being written, and a CR number or a slug sent twice in the same instant is MKT_DUP;
--   * bounded reads: staff_market_thread returns the newest 1,000 messages and "more" (the contract: all),
--     staff_market_shops 500 shops, a listing's reports the newest 200;
--   * staff_market_sellers' search does not offer an account that was deleted (archived) and never sold;
--   * a product type that listings name cannot be made a sport (BAD_INPUT): its listings would have no sport.
--
-- After the cross-check (2026-11-21), also: three storage policies on the site bucket's market/ folder for staff
--   with the Marketplace right (change), so a People editor who is not an admin can add our listings' photos.
--
-- Rollback: drop policy if exists "market media staff add" / "market media staff see" / "market media staff remove"
--   on storage.objects; drop every function public.staff_market_* and the helpers _mkt_staff_seller(text),
--   _mkt_staff_shop(public.market_shops), _mkt_staff_report(public.market_reports), _mkt_reported(public.market_reports),
--   _mkt_staff_listing(public.market_listings), _mkt_staff_commission(public.market_listings),
--   _mkt_hold_all(text, text, text), _mkt_release_all(text, text);
--   delete from supabase_migrations.schema_migrations where version = '20261121300100';
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

-- Who a report is about: a listing's seller; for a thread, the person in it who did not report.
create or replace function public._mkt_reported(r public.market_reports) returns text
language sql stable security definer set search_path = public as $$
  select case when r.target = 'thread'
              then (select case when t.buyer_id = r.reporter_id then t.seller_id else t.buyer_id end
                      from market_threads t where t.id = r.thread_id)
              else (select l.customer_id from market_listings l where l.id = r.listing_id) end
$$;

create or replace function public._mkt_staff_report(r public.market_reports) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'id', r.id, 'target', r.target, 'listing_id', r.listing_id,
    'listing_title', (select l.title from market_listings l where l.id = r.listing_id),
    'listing_status', (select l.status from market_listings l where l.id = r.listing_id),
    'thread_id', r.thread_id, 'reporter_id', r.reporter_id,
    'reporter_name', (select c.name from customers c where c.id = r.reporter_id),
    'reporter_phone', (select c.phone from customers c where c.id = r.reporter_id),
    'reported_id', _mkt_reported(r),
    'reported_name', (select c.name from customers c where c.id = _mkt_reported(r)),
    'reason', r.reason, 'note', r.note, 'status', r.status, 'decided_by', r.decided_by, 'decided_at', r.decided_at,
    'decision_note', r.decision_note, 'created_at', r.created_at)
$$;

-- A seller as staff see one: works for a customer who has no market_sellers row yet.
create or replace function public._mkt_staff_seller(p_customer text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'customer_id', c.id, 'name', c.name, 'phone', c.phone, 'account_created_at', c.created_at,
    'status', coalesce(s.status, 'ok'), 'strikes', coalesce(s.strikes, 0), 'staff_note', s.staff_note,
    'met_by_team', coalesce(s.met_by_team, false), 'met_at', s.met_at, 'met_by', s.met_by,
    'suspended_at', s.suspended_at, 'suspended_reason', s.suspended_reason, 'terms_at', s.terms_at,
    'established', _mkt_established(c.id),
    'live', (select count(*) from market_listings l where l.customer_id = c.id and l.status in ('live', 'reserved')),
    'sold', (select count(*) from market_listings l where l.customer_id = c.id and l.status = 'sold'),
    'reports_open', (select count(*) from market_reports r where r.status = 'open' and _mkt_reported(r) = c.id),
    'shop_id', h.id, 'shop_name', h.name_en)
    from customers c
    left join market_sellers s on s.customer_id = c.id
    left join market_shops h on h.owner_id = c.id
   where c.id = p_customer
$$;

create or replace function public._mkt_staff_shop(h public.market_shops) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(h) || jsonb_build_object(
    'owner_name', (select c.name from customers c where c.id = h.owner_id),
    'owner_phone', (select c.phone from customers c where c.id = h.owner_id),
    'live', (select count(*) from market_listings l where l.shop_id = h.id and l.status in ('live', 'reserved')))
$$;

create or replace function public._mkt_staff_listing(l public.market_listings) returns jsonb
language sql stable security definer set search_path = public as $$
  select (to_jsonb(l) - 'search_text') || jsonb_build_object(
    'customer_name', (select c.name from customers c where c.id = l.customer_id),
    'customer_phone', (select c.phone from customers c where c.id = l.customer_id),
    -- what buyers see as the seller: the chosen name (null: "Private seller"), a shop's trade name
    'display_as', case l.seller_kind when 'private' then l.display_name
                                     when 'shop' then (select h.name_en from market_shops h where h.id = l.shop_id) end,
    'seller', case when l.customer_id is not null then _mkt_staff_seller(l.customer_id) end,
    'shop', (select _mkt_staff_shop(h) from market_shops h where h.id = l.shop_id),
    'category_name_en', (select c.name_en from market_categories c where c.slug = l.category),
    'category_name_ar', (select c.name_ar from market_categories c where c.slug = l.category),
    'reports', coalesce((select jsonb_agg(_mkt_staff_report(x.r) order by (x.r).created_at desc, (x.r).id desc)
                           from (select r from market_reports r where r.listing_id = l.id
                                  order by r.created_at desc, r.id desc limit 200) x), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'at', e.at, 'actor_kind', e.actor_kind, 'actor', e.actor,
                                                            'action', e.action, 'detail', e.detail) order by e.at desc, e.id desc)
                          from (select * from market_events x where x.listing_id = l.id order by x.at desc, x.id desc limit 100) e), '[]'::jsonb),
    'threads', (select count(*) from market_threads t where t.listing_id = l.id))
$$;

create or replace function public._mkt_staff_commission(l public.market_listings) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'listing_id', l.id, 'title', l.title, 'seller_kind', l.seller_kind, 'customer_id', l.customer_id,
    'customer_name', (select c.name from customers c where c.id = l.customer_id),
    'customer_phone', (select c.phone from customers c where c.id = l.customer_id),
    'shop_name', (select h.name_en from market_shops h where h.id = l.shop_id),
    'sold_at', l.sold_at, 'sold_price', l.sold_price, 'commission_pct', trim_scale(l.commission_pct), 'commission_due', l.commission_due,
    'received', l.commission_received, 'received_at', l.commission_received_at, 'received_by', l.commission_received_by,
    'note', l.commission_note)
$$;

-- An account's listings on sale are held for staff (its seller or its shop was suspended); how many.
create or replace function public._mkt_hold_all(p_customer text, p_who text, p_why text) returns integer
language plpgsql security definer set search_path = public as $$
declare l market_listings%rowtype; n integer := 0;
begin
  for l in select * from market_listings m where m.customer_id = p_customer and m.status in ('live', 'reserved') for update loop
    update market_listings set status = 'held', hold_reason = 'staff' where id = l.id;
    perform _mkt_event('staff', p_who, 'listing', 'hold', l.id, l.shop_id, null, null, l.customer_id,
                       _mkt_snap(l) || jsonb_build_object('reason', 'staff', 'on', p_why));
    n := n + 1;
  end loop;
  return n;
end $$;
-- ... and go back on sale (or to expired when their date has passed), unless the account is still stopped (its
-- shop, or the seller, is suspended too). Only the ones held for that reason: a listing held for its words, its
-- reports or its frame number waits for staff to release it.
create or replace function public._mkt_release_all(p_customer text, p_who text) returns integer
language plpgsql security definer set search_path = public as $$
declare l market_listings%rowtype; n integer := 0; v_to text;
begin
  if _mkt_sell_stopped(p_customer) then return 0; end if;
  for l in select * from market_listings m
            where m.customer_id = p_customer and m.status = 'held' and m.hold_reason = 'staff' for update loop
    v_to := case when l.expires_at <= now() then 'expired' else 'live' end;
    update market_listings set status = v_to, hold_reason = null where id = l.id;
    perform _mkt_event('staff', p_who, 'listing', 'release', l.id, l.shop_id, null, null, l.customer_id,
                       _mkt_snap(l) || jsonb_build_object('to', v_to));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ── 1, 2. The probe and the counts ───────────────────────────────────────────────────────────────────────────────
create or replace function public.staff_market_mode() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return 'full';
end $$;

create or replace function public.staff_market_counts() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _staff_mod('market', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return jsonb_build_object(
    'on', _mkt_on(),
    'held', (select count(*) from market_listings l where l.status = 'held'),
    'reports', (select count(*) from market_reports r where r.status = 'open'),
    'shops_pending', (select count(*) from market_shops h where h.status = 'pending'),
    'commission_due', (select count(*) from market_listings l
                        where l.sold_at is not null and l.commission_due > 0 and not l.commission_received),
    'live', (select count(*) from market_listings l where l.status in ('live', 'reserved')));
end $$;

-- ── 3. Listings ──────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.staff_market_listings(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_status text; v_kind text; v_q text; v_like text; v_qd text; v_limit integer; v_offset integer; v_out jsonb;
begin
  if not _staff_mod('market', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then p := '{}'::jsonb; end if;
  v_status := coalesce(nullif(p->>'status', ''), 'live');
  v_kind := nullif(p->>'kind', '');
  if v_status not in ('all', 'draft', 'live', 'held', 'reserved', 'sold', 'expired', 'hidden', 'deleted')
     or (v_kind is not null and v_kind not in ('private', 'shop', 'company')) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  v_q := nullif(btrim(left(coalesce(p->>'q', ''), 80)), '');
  v_like := '%' || replace(replace(replace(coalesce(v_q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_qd := regexp_replace(coalesce(v_q, ''), '[^0-9]', '', 'g');
  v_limit := least(greatest(_mkt_num(p->'limit', 100, -1000000000, 1000000000)::integer, 1), 200);
  v_offset := greatest(_mkt_num(p->'offset', 0, 0, 1000000000)::integer, 0);
  with f as (
    select l.id, l.updated_at
      from market_listings l
      left join customers c on c.id = l.customer_id
      left join market_shops h on h.id = l.shop_id
     where (v_status = 'all' or l.status = v_status)
       and (v_kind is null or l.seller_kind = v_kind)
       and (v_q is null or l.title ilike v_like or l.id::text = v_q or l.serial ilike v_like or c.name ilike v_like
            or h.name_en ilike v_like or c.id = v_q
            or (char_length(v_qd) >= 4 and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || v_qd || '%')))
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
               'id', l.id, 'title', l.title, 'price', l.price, 'status', l.status, 'hold_reason', l.hold_reason,
               'seller_kind', l.seller_kind, 'customer_id', l.customer_id,
               'customer_name', (select c.name from customers c where c.id = l.customer_id),
               'customer_phone', (select c.phone from customers c where c.id = l.customer_id),
               'shop_id', l.shop_id, 'shop_name', (select h.name_en from market_shops h where h.id = l.shop_id),
               'category', l.category, 'city', l.city, 'photo', l.photos->>0, 'photos', jsonb_array_length(l.photos),
               'reports_open', (select count(*) from market_reports r where r.listing_id = l.id and r.status = 'open'),
               'checked_at', l.checked_at, 'published_at', l.published_at, 'expires_at', l.expires_at,
               'updated_at', l.updated_at) order by l.updated_at desc, l.id desc)
             from (select f.id from f order by f.updated_at desc, f.id desc limit v_limit offset v_offset) pg
             join market_listings l on l.id = pg.id), '[]'::jsonb),
    'total', (select count(*) from f)) into v_out;
  return v_out;
end $$;

create or replace function public.staff_market_listing_get(p_listing bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _staff_mod('market', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return (select _mkt_staff_listing(l) from market_listings l where l.id = p_listing);
end $$;

create or replace function public.staff_market_listing_set(p_listing bigint, p_action text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l market_listings%rowtype; v_who text; v_note text := nullif(_ask_text(p_note), ''); v_to text;
        v_stopped boolean; v_cust text;
begin
  if not _staff_mod('market', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_action is null or p_action not in ('hide', 'restore', 'release', 'check', 'uncheck') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  v_who := _ask_who();
  -- the seller's own lock before the row (see _mkt_account_lock): a restore or a release reads whether the seller
  -- is suspended, and must not pass a suspension being written at the same moment
  select m.customer_id into v_cust from market_listings m where m.id = p_listing;
  if not found then raise exception 'MKT_GONE'; end if;
  perform _mkt_account_lock(v_cust);
  select * into l from market_listings where id = p_listing for update;
  if not found then raise exception 'MKT_GONE'; end if;
  v_stopped := l.customer_id is not null and _mkt_sell_stopped(l.customer_id);
  if p_action = 'hide' then
    if l.status in ('draft', 'deleted', 'hidden') then raise exception 'MKT_STATE'; end if;
    if v_note is null or char_length(v_note) not between 3 and 300 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
    update market_listings set status = 'hidden', hold_reason = null, hidden_reason = v_note, hidden_at = now(), hidden_by = v_who
     where id = l.id;
    perform _mkt_event('staff', v_who, 'listing', 'hide', l.id, l.shop_id, null, null, l.customer_id,
                       _mkt_snap(l) || jsonb_build_object('reason', v_note));
  elsif p_action = 'restore' then
    if l.status <> 'hidden' then raise exception 'MKT_STATE'; end if;
    v_to := case when l.sold_at is not null then 'sold' when v_stopped then 'held'
                 when l.expires_at <= now() then 'expired' else 'live' end;
    update market_listings set status = v_to, hold_reason = case when v_to = 'held' then 'staff' end,
                               hidden_reason = null, hidden_at = null, hidden_by = null
     where id = l.id;
    perform _mkt_event('staff', v_who, 'listing', 'restore', l.id, l.shop_id, null, null, l.customer_id,
                       _mkt_snap(l) || jsonb_build_object('to', v_to, 'note', v_note));
  elsif p_action = 'release' then
    if l.status <> 'held' or v_stopped then raise exception 'MKT_STATE'; end if;
    v_to := case when l.expires_at <= now() then 'expired' else 'live' end;
    update market_listings set status = v_to, hold_reason = null where id = l.id;
    perform _mkt_event('staff', v_who, 'listing', 'release', l.id, l.shop_id, null, null, l.customer_id,
                       _mkt_snap(l) || jsonb_build_object('to', v_to, 'held_for', l.hold_reason, 'note', v_note));
  elsif p_action = 'check' then
    if l.status in ('draft', 'deleted') then raise exception 'MKT_STATE'; end if;
    update market_listings set checked_at = now(), checked_by = v_who where id = l.id;
    perform _mkt_event('staff', v_who, 'listing', 'check', l.id, l.shop_id, null, null, l.customer_id,
                       _mkt_snap(l) || jsonb_build_object('note', v_note));
  else
    if l.checked_at is null then raise exception 'MKT_STATE'; end if;
    update market_listings set checked_at = null, checked_by = null where id = l.id;
    perform _mkt_event('staff', v_who, 'listing', 'uncheck', l.id, l.shop_id, null, null, l.customer_id,
                       _mkt_snap(l) || jsonb_build_object('note', v_note));
  end if;
  return jsonb_build_object('listing', (select _mkt_staff_listing(m) from market_listings m where m.id = l.id));
end $$;

-- ── 4. MicroMobility's own listings ──────────────────────────────────────────────────────────────────────────────
create or replace function public.staff_market_company_save(p_listing bigint, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l market_listings%rowtype; v_ph jsonb; v_who text;
begin
  if not _staff_mod('market', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then p := '{}'::jsonb; end if;
  v_who := _ask_who();
  if p_listing is null then
    l.seller_kind := 'company'; l.status := 'draft'; l.negotiable := false;
    l.facts := '{}'::jsonb; l.declarations := '{}'::jsonb; l.photos := '[]'::jsonb;
  else
    select * into l from market_listings where id = p_listing and seller_kind = 'company' for update;
    if not found then raise exception 'MKT_GONE'; end if;
    if l.status not in ('draft', 'live', 'reserved', 'expired') then raise exception 'MKT_STATE'; end if;
  end if;
  l := _mkt_apply(l, p, true);
  if p ? 'photos' then
    v_ph := p->'photos';
    if jsonb_typeof(v_ph) = 'null' then v_ph := '[]'::jsonb; end if;
    if jsonb_typeof(v_ph) <> 'array' or jsonb_array_length(v_ph) > 10
       or exists (select 1 from jsonb_array_elements(v_ph) as e(val)
                   where jsonb_typeof(e.val) <> 'string'
                      or (e.val #>> '{}') !~ '^/media/market/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*\.(jpe?g|png|webp)$'
                      or (e.val #>> '{}') like '%..%') then
      raise exception 'MKT_INPUT: photos';
    end if;
    l.photos := v_ph;
  end if;
  if l.status <> 'draft' then perform _mkt_check(l); end if;
  l := _mkt_store(l);
  perform _mkt_event('staff', v_who, 'listing', 'company_save', l.id, null, null, null, null, _mkt_snap(l));
  return jsonb_build_object('listing', _mkt_staff_listing(l));
end $$;

create or replace function public.staff_market_company_state(p_listing bigint, p_action text, p_price integer default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l market_listings%rowtype; v_who text;
begin
  if not _staff_mod('market', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_action is null or p_action not in ('publish', 'reserved', 'live', 'sold', 'renew', 'deleted') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  v_who := _ask_who();
  select * into l from market_listings where id = p_listing and seller_kind = 'company' for update;
  if not found then raise exception 'MKT_GONE'; end if;
  if p_action = 'publish' then
    if l.status <> 'draft' then raise exception 'MKT_STATE'; end if;
    perform _mkt_check(l);
    l.status := 'live'; l.hold_reason := null; l.name_mode := 'none'; l.display_name := null;
    l.published_at := now(); l.expires_at := now() + make_interval(days => _mkt_days());
    l := _mkt_store(l);
    perform _mkt_event('staff', v_who, 'listing', 'publish', l.id, null, null, null, null, _mkt_snap(l));
  else
    perform _mkt_move(l, p_action, p_price, 'staff', v_who);
  end if;
  return jsonb_build_object('listing', (select _mkt_staff_listing(m) from market_listings m where m.id = p_listing));
end $$;

-- ── 5. Reports, and the one way staff read a thread ──────────────────────────────────────────────────────────────
create or replace function public.staff_market_reports(p_status text default 'open') returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _staff_mod('market', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_status is not null and p_status not in ('open', 'actioned', 'dismissed') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(_mkt_staff_report(x.r) order by (x.r).created_at desc, (x.r).id desc)
                         from (select r from market_reports r where p_status is null or r.status = p_status
                                order by r.created_at desc, r.id desc limit 500) x), '[]'::jsonb),
    'total', (select count(*) from market_reports r where p_status is null or r.status = p_status));
end $$;

create or replace function public.staff_market_report_set(p_report bigint, p_action text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r market_reports%rowtype; v_who text; v_note text := nullif(left(_ask_text(p_note), 300), '');
begin
  if not _staff_mod('market', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_action is null or p_action not in ('actioned', 'dismissed', 'open') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  v_who := _ask_who();
  select * into r from market_reports where id = p_report for update;
  if not found then raise exception 'MKT_GONE'; end if;
  update market_reports m
     set status = p_action,
         decided_by = case when p_action = 'open' then null else v_who end,
         decided_at = case when p_action = 'open' then null else now() end,
         decision_note = case when p_action = 'open' then null else v_note end
   where m.id = r.id
  returning * into r;
  perform _mkt_event('staff', v_who, 'report', 'report_set', r.listing_id, null, r.thread_id, r.id, _mkt_reported(r),
                     jsonb_build_object('status', p_action, 'note', v_note));
  return jsonb_build_object('report', _mkt_staff_report(r));
end $$;

-- A thread, whole, with both people named: readable ONLY when a report names it (whatever the report's state).
-- Any other thread, and one that does not exist, answers FORBIDDEN alike. Every read is written to the trail.
create or replace function public.staff_market_thread(p_thread bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t market_threads%rowtype; l market_listings%rowtype; v_who text;
begin
  if not _staff_mod('market', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_thread is null or not exists (select 1 from market_reports r where r.thread_id = p_thread) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into t from market_threads where id = p_thread;
  if not found then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into l from market_listings where id = t.listing_id;
  v_who := _ask_who();
  perform _mkt_event('staff', v_who, 'thread', 'thread_read', t.listing_id, null, t.id, null, null, '{}'::jsonb);
  return jsonb_build_object(
    'id', t.id, 'listing_id', t.listing_id, 'listing_title', l.title,
    'buyer', (select jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'shown_as', t.buyer_name)
                from customers c where c.id = t.buyer_id),
    'seller', (select jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone,
                        'shown_as', case l.seller_kind when 'shop' then (select h.name_en from market_shops h where h.id = l.shop_id)
                                                       else l.display_name end)
                 from customers c where c.id = t.seller_id),
    'buyer_wa_at', t.buyer_wa_at, 'seller_wa_at', t.seller_wa_at,
    'blocked', _mkt_blocked(t.buyer_id, t.seller_id), 'created_at', t.created_at,
    -- the newest 1,000, oldest first (a thread can hold 400 a day for a year); more: older ones were left out
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', z.id, 'side', z.side, 'body', z.body, 'at', z.created_at) order by z.id)
                            from (select m.id, m.side, m.body, m.created_at from market_messages m
                                   where m.thread_id = t.id order by m.id desc limit 1000) z), '[]'::jsonb),
    'more', (select count(*) > 1000 from (select 1 from market_messages m where m.thread_id = t.id limit 1001) z));
end $$;

-- ── 6. Sellers ───────────────────────────────────────────────────────────────────────────────────────────────────
-- The accounts with a market_sellers row; with q (a name, a phone or an account id) also accounts that have none
-- yet, so staff can mark one "met by our team" before it lists.
create or replace function public.staff_market_sellers(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_status text; v_q text; v_like text; v_qd text; v_limit integer; v_offset integer; v_out jsonb;
begin
  if not _staff_mod('market', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then p := '{}'::jsonb; end if;
  v_status := coalesce(nullif(p->>'status', ''), 'all');
  if v_status not in ('all', 'ok', 'suspended') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  v_q := nullif(btrim(left(coalesce(p->>'q', ''), 80)), '');
  v_like := '%' || replace(replace(replace(coalesce(v_q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_qd := regexp_replace(coalesce(v_q, ''), '[^0-9]', '', 'g');
  v_limit := least(greatest(_mkt_num(p->'limit', 100, -1000000000, 1000000000)::integer, 1), 200);
  v_offset := greatest(_mkt_num(p->'offset', 0, 0, 1000000000)::integer, 0);
  with f as (
    select c.id, c.name, s.updated_at
      from customers c left join market_sellers s on s.customer_id = c.id
     where (s.customer_id is not null or (v_q is not null and c.merged_into is null and c.archived_at is null))
       and (v_status = 'all' or coalesce(s.status, 'ok') = v_status)
       and (v_q is null or c.name ilike v_like or c.id = v_q
            or (char_length(v_qd) >= 4 and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || v_qd || '%')))
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(_mkt_staff_seller(pg.id) order by pg.updated_at desc nulls last, pg.name, pg.id)
                         from (select f.* from f order by f.updated_at desc nulls last, f.name, f.id
                                limit v_limit offset v_offset) pg), '[]'::jsonb),
    'total', (select count(*) from f)) into v_out;
  return v_out;
end $$;

create or replace function public.staff_market_seller_set(p_customer text, p_action text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s market_sellers%rowtype; v_who text; v_note text := nullif(_ask_text(p_note), ''); v_n integer := 0;
begin
  if not _staff_mod('market', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_action is null or p_action not in ('note', 'strike', 'unstrike', 'suspend', 'restore', 'met', 'unmet') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if (p_action = 'note' and char_length(coalesce(v_note, '')) > 1000)
     or (p_action in ('strike', 'suspend') and (v_note is null or char_length(v_note) not between 3 and 300)) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if p_customer is null or not exists (select 1 from customers c where c.id = p_customer) then raise exception 'MKT_GONE'; end if;
  v_who := _ask_who();
  -- the account's own lock (see _mkt_account_lock): a suspension holds what is on sale, and a publish of the same
  -- moment must wait for it and then be refused, not slip between the two
  perform _mkt_account_lock(p_customer);
  insert into market_sellers (customer_id) values (p_customer) on conflict (customer_id) do nothing;
  select * into s from market_sellers where customer_id = p_customer for update;
  if p_action = 'note' then
    update market_sellers set staff_note = v_note where customer_id = p_customer;
    perform _mkt_event('staff', v_who, 'seller', 'note', null, null, null, null, p_customer, jsonb_build_object('note', v_note));
  elsif p_action = 'strike' then
    if s.strikes >= 99 then raise exception 'MKT_STATE'; end if;
    update market_sellers set strikes = strikes + 1 where customer_id = p_customer;
    perform _mkt_event('staff', v_who, 'seller', 'strike', null, null, null, null, p_customer,
                       jsonb_build_object('reason', v_note, 'strikes', s.strikes + 1));
  elsif p_action = 'unstrike' then
    if s.strikes <= 0 then raise exception 'MKT_STATE'; end if;
    update market_sellers set strikes = strikes - 1 where customer_id = p_customer;
    perform _mkt_event('staff', v_who, 'seller', 'unstrike', null, null, null, null, p_customer,
                       jsonb_build_object('note', v_note, 'strikes', s.strikes - 1));
  elsif p_action = 'suspend' then
    if s.status = 'suspended' then raise exception 'MKT_STATE'; end if;
    update market_sellers set status = 'suspended', suspended_at = now(), suspended_reason = v_note where customer_id = p_customer;
    v_n := _mkt_hold_all(p_customer, v_who, 'suspend');
    perform _mkt_event('staff', v_who, 'seller', 'suspend', null, null, null, null, p_customer,
                       jsonb_build_object('reason', v_note, 'listings_held', v_n));
  elsif p_action = 'restore' then
    if s.status <> 'suspended' then raise exception 'MKT_STATE'; end if;
    update market_sellers set status = 'ok', suspended_at = null, suspended_reason = null where customer_id = p_customer;
    v_n := _mkt_release_all(p_customer, v_who);
    perform _mkt_event('staff', v_who, 'seller', 'unsuspend', null, null, null, null, p_customer,
                       jsonb_build_object('note', v_note, 'listings_released', v_n));
  elsif p_action = 'met' then
    update market_sellers set met_by_team = true, met_at = (now() at time zone 'Asia/Riyadh')::date, met_by = v_who
     where customer_id = p_customer;
    perform _mkt_event('staff', v_who, 'seller', 'met', null, null, null, null, p_customer, jsonb_build_object('note', v_note));
  else
    update market_sellers set met_by_team = false, met_at = null, met_by = null where customer_id = p_customer;
    perform _mkt_event('staff', v_who, 'seller', 'unmet', null, null, null, null, p_customer, jsonb_build_object('note', v_note));
  end if;
  return jsonb_build_object('seller', _mkt_staff_seller(p_customer));
end $$;

-- ── 7. Shops ─────────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.staff_market_shops(p_status text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not _staff_mod('market', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected', 'suspended') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(_mkt_staff_shop(x.h) order by ((x.h).status = 'pending') desc, (x.h).updated_at desc, (x.h).id desc)
                         from (select h from market_shops h where p_status is null or h.status = p_status
                                order by (h.status = 'pending') desc, h.updated_at desc, h.id desc limit 500) x), '[]'::jsonb),
    'total', (select count(*) from market_shops h where p_status is null or h.status = p_status));
end $$;

create or replace function public.staff_market_shop_set(p_shop bigint, p_action text, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h market_shops%rowtype; o market_shops%rowtype; v jsonb; v_who text; v_note text; v_n integer := 0; v_slug text; k text;
        v_owner text;
begin
  if not _staff_mod('market', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_action is null or p_action not in ('approve', 'reject', 'suspend', 'restore', 'edit') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then p := '{}'::jsonb; end if;
  v_note := nullif(_ask_text(p->>'note'), '');
  if char_length(coalesce(v_note, '')) > 300
     or (p_action in ('reject', 'suspend') and (v_note is null or char_length(v_note) < 3)) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  v_who := _ask_who();
  -- the owner's own lock (an approval or a suspension moves or holds the owner's listings: a publish of the same
  -- moment waits for it), then the shops' lock (one shop is written at a time, so a CR number or a slug sent twice
  -- in the same instant is MKT_DUP, not a bare unique-violation), then the row: the order market_shop_apply takes
  select m.owner_id into v_owner from market_shops m where m.id = p_shop;
  if not found then raise exception 'MKT_GONE'; end if;
  perform _mkt_account_lock(v_owner);
  perform pg_advisory_xact_lock(hashtextextended('mkt:shops', 0));
  select * into h from market_shops where id = p_shop for update;
  if not found then raise exception 'MKT_GONE'; end if;
  o := h;
  if p_action = 'approve' then
    if h.status not in ('pending', 'rejected') then raise exception 'MKT_STATE'; end if;
    if exists (select 1 from market_shops x where x.cr_no = h.cr_no and x.status <> 'rejected' and x.id <> h.id) then
      raise exception 'MKT_DUP: cr';
    end if;
    update market_shops set status = 'approved', decided_by = v_who, decided_at = now(), decision_note = v_note,
                            approved_at = coalesce(approved_at, now())
     where id = h.id;
    -- the owner's listings on sale (and held) become the shop's: a shop's listing names the shop, not a person
    update market_listings set seller_kind = 'shop', shop_id = h.id, name_mode = 'none', display_name = null
     where customer_id = h.owner_id and seller_kind = 'private' and status in ('live', 'reserved', 'held');
    get diagnostics v_n = row_count;
    perform _mkt_event('staff', v_who, 'shop', 'shop_approve', null, h.id, null, null, h.owner_id,
                       jsonb_build_object('name_en', h.name_en, 'cr_no', h.cr_no, 'note', v_note, 'listings_moved', v_n));
  elsif p_action = 'reject' then
    if h.status <> 'pending' then raise exception 'MKT_STATE'; end if;
    update market_shops set status = 'rejected', decided_by = v_who, decided_at = now(), decision_note = v_note where id = h.id;
    perform _mkt_event('staff', v_who, 'shop', 'shop_reject', null, h.id, null, null, h.owner_id,
                       jsonb_build_object('name_en', h.name_en, 'cr_no', h.cr_no, 'note', v_note));
  elsif p_action = 'suspend' then
    if h.status <> 'approved' then raise exception 'MKT_STATE'; end if;
    update market_shops set status = 'suspended', decided_by = v_who, decided_at = now(), decision_note = v_note where id = h.id;
    v_n := _mkt_hold_all(h.owner_id, v_who, 'shop_suspend');
    perform _mkt_event('staff', v_who, 'shop', 'shop_suspend', null, h.id, null, null, h.owner_id,
                       jsonb_build_object('name_en', h.name_en, 'note', v_note, 'listings_held', v_n));
  elsif p_action = 'restore' then
    if h.status <> 'suspended' then raise exception 'MKT_STATE'; end if;
    update market_shops set status = 'approved', decided_by = v_who, decided_at = now(), decision_note = v_note where id = h.id;
    v_n := _mkt_release_all(h.owner_id, v_who);
    perform _mkt_event('staff', v_who, 'shop', 'shop_restore', null, h.id, null, null, h.owner_id,
                       jsonb_build_object('name_en', h.name_en, 'note', v_note, 'listings_released', v_n));
  else
    -- edit: any column the owner writes, and the slug; values of their shapes (links and phone numbers are staff's call)
    v := _mkt_shop_vals(p, false);
    foreach k in array array['name_en', 'cr_no', 'cr_activity', 'city'] loop
      if v ? k and v->>k is null then raise exception 'MKT_INPUT: %', k; end if;
    end loop;
    if v ? 'name_en' then h.name_en := v->>'name_en'; end if;
    if v ? 'name_ar' then h.name_ar := v->>'name_ar'; end if;
    if v ? 'cr_no' then h.cr_no := v->>'cr_no'; end if;
    if v ? 'cr_activity' then h.cr_activity := v->>'cr_activity'; end if;
    if v ? 'vat_no' then h.vat_no := v->>'vat_no'; end if;
    if v ? 'city' then h.city := v->>'city'; end if;
    if v ? 'address' then h.address := v->>'address'; end if;
    if v ? 'map_url' then h.map_url := v->>'map_url'; end if;
    if v ? 'phone' then h.phone := v->>'phone'; end if;
    if v ? 'whatsapp' then h.whatsapp := v->>'whatsapp'; end if;
    if v ? 'about_en' then h.about_en := v->>'about_en'; end if;
    if v ? 'about_ar' then h.about_ar := v->>'about_ar'; end if;
    if v ? 'returns_en' then h.returns_en := v->>'returns_en'; end if;
    if v ? 'returns_ar' then h.returns_ar := v->>'returns_ar'; end if;
    if v ? 'sells' then h.sells := v->>'sells'; end if;
    -- the logo: staff can only take it off (a new one is the owner's upload)
    if p ? 'logo' then
      if jsonb_typeof(p->'logo') = 'null' then h.logo := null;
      elsif p->>'logo' is distinct from o.logo then raise exception 'MKT_INPUT: logo';
      end if;
    end if;
    if p ? 'slug' then
      v_slug := p->>'slug';
      if jsonb_typeof(p->'slug') <> 'string' or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_slug) not between 3 and 40 then
        raise exception 'MKT_INPUT: slug';
      end if;
      if exists (select 1 from market_shops x where x.slug = v_slug and x.id <> h.id) then raise exception 'MKT_DUP: slug'; end if;
      h.slug := v_slug;
    end if;
    if h.status <> 'rejected'
       and exists (select 1 from market_shops x where x.cr_no = h.cr_no and x.status <> 'rejected' and x.id <> h.id) then
      raise exception 'MKT_DUP: cr';
    end if;
    update market_shops m
       set slug = h.slug, name_en = h.name_en, name_ar = h.name_ar, cr_no = h.cr_no, cr_activity = h.cr_activity,
           vat_no = h.vat_no, city = h.city, address = h.address, map_url = h.map_url, phone = h.phone, whatsapp = h.whatsapp,
           about_en = h.about_en, about_ar = h.about_ar, returns_en = h.returns_en, returns_ar = h.returns_ar,
           sells = h.sells, logo = h.logo
     where m.id = h.id;
    if o.logo is not null and h.logo is null then
      update market_photo_slots s set gone_at = now() where s.name = o.logo and s.gone_at is null;
    end if;
    perform _mkt_event('staff', v_who, 'shop', 'shop_edit', null, h.id, null, null, h.owner_id,
      jsonb_build_object('before', coalesce((select jsonb_object_agg(x.key, to_jsonb(o) -> x.key) from jsonb_each(to_jsonb(h)) x
                                              where x.value is distinct from (to_jsonb(o) -> x.key)), '{}'::jsonb)));
  end if;
  return jsonb_build_object('shop', (select _mkt_staff_shop(m) from market_shops m where m.id = h.id));
end $$;

-- ── 8. The honour commission ─────────────────────────────────────────────────────────────────────────────────────
create or replace function public.staff_market_commission(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_state text; v_limit integer; v_offset integer;
begin
  if not _staff_mod('market', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' then p := '{}'::jsonb; end if;
  v_state := coalesce(nullif(p->>'state', ''), 'due');
  if v_state not in ('due', 'received', 'all') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  v_limit := least(greatest(_mkt_num(p->'limit', 100, -1000000000, 1000000000)::integer, 1), 200);
  v_offset := greatest(_mkt_num(p->'offset', 0, 0, 1000000000)::integer, 0);
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(_mkt_staff_commission(x.l) order by (x.l).sold_at desc, (x.l).id desc)
                         from (select l from market_listings l
                                where l.sold_at is not null and l.commission_due > 0
                                  and (v_state = 'all' or l.commission_received = (v_state = 'received'))
                                order by l.sold_at desc, l.id desc limit v_limit offset v_offset) x), '[]'::jsonb),
    'total', (select count(*) from market_listings l
               where l.sold_at is not null and l.commission_due > 0
                 and (v_state = 'all' or l.commission_received = (v_state = 'received'))),
    'due_sum', (select coalesce(sum(l.commission_due), 0) from market_listings l
                 where l.sold_at is not null and l.commission_due > 0 and not l.commission_received),
    'received_sum', (select coalesce(sum(l.commission_due), 0) from market_listings l
                      where l.sold_at is not null and l.commission_due > 0 and l.commission_received));
end $$;

create or replace function public.staff_market_commission_set(p_listing bigint, p_received boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare l market_listings%rowtype; v_who text; v_note text := nullif(left(_ask_text(p_note), 300), '');
begin
  if not _staff_mod('market', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_received is null then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  v_who := _ask_who();
  select * into l from market_listings where id = p_listing for update;
  if not found then raise exception 'MKT_GONE'; end if;
  if l.sold_at is null or coalesce(l.commission_due, 0) <= 0 then raise exception 'MKT_STATE'; end if;
  update market_listings m
     set commission_received = p_received,
         commission_received_at = case when p_received then now() end,
         commission_received_by = case when p_received then v_who end,
         commission_note = v_note
   where m.id = l.id
  returning * into l;
  perform _mkt_event('staff', v_who, 'listing', 'commission', l.id, l.shop_id, null, null, l.customer_id,
                     jsonb_build_object('received', p_received, 'due', l.commission_due, 'sold_price', l.sold_price, 'note', v_note));
  return jsonb_build_object('row', _mkt_staff_commission(l));
end $$;

-- ── 9. Categories ────────────────────────────────────────────────────────────────────────────────────────────────
-- Upsert by slug. Two levels only: a parent is a sport (a row with no parent), and a sport that has product types
-- stays a sport. Nothing is deleted: visible false takes a category out of the forms and the filters.
create or replace function public.staff_market_category_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c market_categories%rowtype; v_slug text; v_new boolean; v_who text; n numeric; v_was text;
begin
  if not _staff_mod('market', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p is null or jsonb_typeof(p) <> 'object' or jsonb_typeof(p->'slug') is distinct from 'string' then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  v_slug := p->>'slug';
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(v_slug) not between 2 and 60 then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  v_who := _ask_who();
  select * into c from market_categories where slug = v_slug for update;
  v_new := not found;
  v_was := c.parent;
  if v_new then
    c.slug := v_slug; c.sort := 0; c.visible := true; c.tier := 'open'; c.needs_serial := false; c.min_photos := 1;
    c.facts := '[]'::jsonb;
  end if;
  if p ? 'parent' then
    if jsonb_typeof(p->'parent') not in ('string', 'null') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
    c.parent := nullif(p->>'parent', '');
  end if;
  if p ? 'name_en' then c.name_en := nullif(_ask_text(p->>'name_en'), ''); end if;
  if p ? 'name_ar' then c.name_ar := nullif(_ask_text(p->>'name_ar'), ''); end if;
  if p ? 'sort' then
    n := _mkt_num(p->'sort', null, -1000000, 1000000);
    if n is null then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
    c.sort := n::integer;
  end if;
  if p ? 'visible' then
    if jsonb_typeof(p->'visible') <> 'boolean' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
    c.visible := (p->>'visible')::boolean;
  end if;
  if p ? 'tier' then c.tier := p->>'tier'; end if;
  if p ? 'needs_serial' then
    if jsonb_typeof(p->'needs_serial') <> 'boolean' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
    c.needs_serial := (p->>'needs_serial')::boolean;
  end if;
  if p ? 'min_photos' then
    n := _mkt_num(p->'min_photos', null, 1, 10);
    if n is null then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
    c.min_photos := n::smallint;
  end if;
  if p ? 'facts' then c.facts := p->'facts'; end if;
  if c.name_en is null or char_length(c.name_en) > 60 or c.name_ar is null or char_length(c.name_ar) > 60
     or c.tier is null or c.tier not in ('open', 'new_only', 'declare')
     or jsonb_typeof(c.facts) is distinct from 'array'
     or not (c.facts <@ '["brand", "model", "year", "frame_size", "wheel_size", "size", "for_whom"]'::jsonb)
     or (c.parent is not null and (c.parent = c.slug
           or not exists (select 1 from market_categories s where s.slug = c.parent and s.parent is null)
           or exists (select 1 from market_categories k where k.parent = c.slug))) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  -- a product type that listings name stays a product type: made a sport, its listings would have no sport (the
  -- pages read a listing's sport as never null) and could not be edited
  if not v_new and v_was is not null and c.parent is null
     and exists (select 1 from market_listings l where l.category = c.slug) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  insert into market_categories (slug, parent, name_en, name_ar, sort, visible, tier, needs_serial, min_photos, facts)
  values (c.slug, c.parent, c.name_en, c.name_ar, c.sort, c.visible, c.tier, c.needs_serial, c.min_photos, c.facts)
  on conflict (slug) do update
    set parent = excluded.parent, name_en = excluded.name_en, name_ar = excluded.name_ar, sort = excluded.sort,
        visible = excluded.visible, tier = excluded.tier, needs_serial = excluded.needs_serial,
        min_photos = excluded.min_photos, facts = excluded.facts
  returning * into c;
  perform _mkt_event('staff', v_who, 'category', 'category_save', null, null, null, null, null,
                     to_jsonb(c) || jsonb_build_object('new', v_new));
  return jsonb_build_object('category', to_jsonb(c));
end $$;

-- ── Who may run what ─────────────────────────────────────────────────────────────────────────────────────────────
do $grants$
declare f text; r record;
begin
  foreach f in array array[
    'public.staff_market_mode()', 'public.staff_market_counts()', 'public.staff_market_listings(jsonb)',
    'public.staff_market_listing_get(bigint)', 'public.staff_market_listing_set(bigint,text,text)',
    'public.staff_market_company_save(bigint,jsonb)', 'public.staff_market_company_state(bigint,text,integer)',
    'public.staff_market_reports(text)', 'public.staff_market_report_set(bigint,text,text)',
    'public.staff_market_thread(bigint)', 'public.staff_market_sellers(jsonb)',
    'public.staff_market_seller_set(text,text,text)', 'public.staff_market_shops(text)',
    'public.staff_market_shop_set(bigint,text,jsonb)', 'public.staff_market_commission(jsonb)',
    'public.staff_market_commission_set(bigint,boolean,text)', 'public.staff_market_category_save(jsonb)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  for r in select p.oid::regprocedure::text as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and p.proname like '\_mkt\_%'
              loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $grants$;

-- ── Our listings' photos (the cross-check, 2026-11-21) ──────────────────────────────────────────────────────────────
-- Staff who may change the Marketplace (_staff_mod('market', true): People edit) make MicroMobility's own listings
-- (staff_market_company_save / _state), and those need a photo to go on sale. Their photos go into market/ of the
-- site bucket through the staff app's uploader (<base36 time>-<up to 6 base36>.jpg|.png, and its .w640 / .w1280
-- WebP copies), which took files from admins only ("site photos upload", 20260924150000): a manager with People
-- edit could save a draft but never add a photo, so never publish it. These three let them add, see (the Storage
-- API reads what it removes) and remove files there, and nowhere else in the bucket. No update policy: upload is
-- never an overwrite (upsert false).
drop policy if exists "market media staff add" on storage.objects;
create policy "market media staff add" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'site' and name ~ '^market/[a-z0-9]{1,12}-[a-z0-9]{0,6}(\.(jpg|png)|\.w(640|1280)\.webp)$'
              and (select public._staff_mod('market', true)));
drop policy if exists "market media staff see" on storage.objects;
create policy "market media staff see" on storage.objects
  for select to authenticated
  using (bucket_id = 'site' and name like 'market/%' and (select public._staff_mod('market', true)));
drop policy if exists "market media staff remove" on storage.objects;
create policy "market media staff remove" on storage.objects
  for delete to authenticated
  using (bucket_id = 'site' and name like 'market/%' and (select public._staff_mod('market', true)));

-- ── Checks ───────────────────────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text; r record;
begin
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'market media staff %') <> 3 then
    raise exception 'our listings'' photos do not have their three policies';
  end if;
  foreach f in array array[
    'public.staff_market_mode()', 'public.staff_market_counts()', 'public.staff_market_listings(jsonb)',
    'public.staff_market_listing_get(bigint)', 'public.staff_market_listing_set(bigint,text,text)',
    'public.staff_market_company_save(bigint,jsonb)', 'public.staff_market_company_state(bigint,text,integer)',
    'public.staff_market_reports(text)', 'public.staff_market_report_set(bigint,text,text)',
    'public.staff_market_thread(bigint)', 'public.staff_market_sellers(jsonb)',
    'public.staff_market_seller_set(text,text,text)', 'public.staff_market_shops(text)',
    'public.staff_market_shop_set(bigint,text,jsonb)', 'public.staff_market_commission(jsonb)',
    'public.staff_market_commission_set(bigint,boolean,text)', 'public.staff_market_category_save(jsonb)',
    'public._mkt_staff_seller(text)', 'public._mkt_staff_shop(public.market_shops)',
    'public._mkt_staff_report(public.market_reports)', 'public._mkt_reported(public.market_reports)',
    'public._mkt_staff_listing(public.market_listings)', 'public._mkt_staff_commission(public.market_listings)',
    'public._mkt_hold_all(text,text,text)', 'public._mkt_release_all(text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  for r in select p.oid, p.oid::regprocedure::text as sig, p.proname from pg_proc p
            where p.pronamespace = 'public'::regnamespace and (p.proname like 'staff\_market\_%' or p.proname like '\_mkt\_%') loop
    if r.proname like 'staff\_market\_%' and (has_function_privilege('anon', r.oid, 'execute')
                                              or not has_function_privilege('authenticated', r.oid, 'execute')) then
      raise exception '% is executable by anon, or not by staff', r.sig;
    end if;
    if r.proname like '\_mkt\_%'
       and (has_function_privilege('anon', r.oid, 'execute') or has_function_privilege('authenticated', r.oid, 'execute')) then
      raise exception '% is executable by a client', r.sig;
    end if;
  end loop;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'staff\_market\_%') <> 17 then
    raise exception 'the staff functions are not 17';
  end if;
  if to_regclass('public.market_listings') is null or to_regprocedure('public._mkt_move(public.market_listings,text,integer,text,text)') is null then
    raise exception '20261121300000_marketplace is not applied';
  end if;
  -- the staff functions take the account's lock through a helper of the first file as it stands after the review
  if to_regprocedure('public._mkt_account_lock(text)') is null then
    raise exception '20261121300000_marketplace is an older copy (no _mkt_account_lock): apply the current one first';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261121300100', 'marketplace_staff')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only): the 17 staff functions, definers, none for anon; the helpers closed; the ledger.
-- select (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'staff\_market\_%' and prosecdef) as staff_functions_17,
--        (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'staff\_market\_%'
--           and has_function_privilege('anon', p.oid, 'execute')) as open_to_anon_0,
--        (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like '\_mkt\_%'
--           and p.proname <> '_mkt_photo_take'
--           and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) as open_helpers_0,
--        has_function_privilege('authenticated', 'public.staff_market_counts()', 'execute') as staff_counts_true,
--        (select name from supabase_migrations.schema_migrations where version = '20261121300100') as ledger;
