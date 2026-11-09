-- ============================================================================
-- The lockers page, micromobility.sa/lockers (the owner, 2026-11-09), 2026-11-09.
--
-- "customers who dont have an account to be able to sign up when scanning the qr code of ...
-- micromobility.sa/lockers to reserve a locker from, they will be able to choose the locker they want
-- from a dynamic lockers distribution that simulates how it look in real life it has 3 columns and 6 rows
-- total of 18 lockers that will be numbered from 1 to 18". The owner's answers the same evening:
--   - tonight and the upcoming evenings that offer lockers, the same periods and prices as the app;
--   - the rider pays from the wallet when reserving, or at the desk when the key is handed over;
--   - numbered across the rows (1-2-3 on top, 16-17-18 at the bottom);
--   - the booking app's review picks the exact locker too, on the same grid;
--   - no L: the lockers are 1 to 18 everywhere (L1..L15 are renamed; a tag still holding L7 reads 7);
--   - a locker reserved and never collected stays held until staff free it;
--   - up to 3 lockers per account per period from the page.
--
--  1. lockers.code may be a plain number; L1..L15 become 1..15 and 16..18 are added (one cabinet of 18).
--  2. locker_rentals.pay ('desk' | 'wallet', a rental made on the page) and receipt_id (the Sales receipt
--     that holds a wallet payment). A rental may hold its locker while still reserved: the rider picked it,
--     staff have not handed the key yet. staff_locker_assign on the same number hands the key (in_use).
--  3. A wallet payment is an ordinary Sales receipt, written here as the till writes one paid from a wallet
--     (a 'paid' line for the locker, a qty-0 'wallet' line from _wallet_post): the reports, the close-out and
--     the receipt's refund already count and give it back. Cancelling the rental (the rider before the key,
--     or staff) voids that receipt and wallet_sale_follow returns the money; Hand back keeps it.
--  4. Anon: locker_evenings (the evenings to choose from; a Petromin night only for a signed-in rider booked
--     on it), locker_board (one evening's cabinet: the units, which are taken per slot, no names).
--     Rider (token-checked): customer_locker_book, customer_locker_drop; customer_lockers lists the
--     rider's own rentals with or without a booking; customer_locker_reserve takes the picked lockers.
--     Staff: staff_locker_assign reads 7, L7 and 07 alike (_lk_code); staff_locker_cancel gives a wallet
--     payment back.
--
-- Rollback: drop the functions locker_evenings, locker_board, customer_locker_book, customer_locker_drop,
--   _lk_code, _lk_evening, _lk_ended, _lk_wallet_sale, _lk_unpay; restore customer_lockers,
--   customer_locker_reserve (4 arguments), staff_locker_assign and staff_locker_cancel from
--   20261109120000_lockers.sql; alter table locker_rentals drop column pay, drop column receipt_id.
--   The units keep their numbers (rename back with update lockers set code = 'L' || code if wanted).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. Plain numbers, 1 to 18 ───────────────────────────────────────────────────────────────
alter table public.lockers drop constraint if exists lockers_code_check;
alter table public.lockers add constraint lockers_code_check check (code ~ '^[A-Z]{0,3}[1-9][0-9]{0,3}$');

update public.lockers l set code = substring(l.code from '^L([1-9][0-9]*)$')
 where l.code ~ '^L[1-9][0-9]*$'
   and not exists (select 1 from public.lockers x
                    where x.code = substring(l.code from '^L([1-9][0-9]*)$') and x.status <> 'retired' and x.id <> l.id);

insert into public.lockers (code)
select g::text from generate_series(1, 18) g
 where not exists (select 1 from public.lockers x where x.code = g::text and x.status <> 'retired');

-- ── 2. The page's rentals ───────────────────────────────────────────────────────────────────
alter table public.locker_rentals add column if not exists pay text;
alter table public.locker_rentals drop constraint if exists locker_rentals_pay_check;
alter table public.locker_rentals add constraint locker_rentals_pay_check check (pay is null or pay in ('desk', 'wallet'));
alter table public.locker_rentals add column if not exists receipt_id text;
alter table public.locker_rentals drop constraint if exists locker_rentals_receipt_check;
alter table public.locker_rentals add constraint locker_rentals_receipt_check check (receipt_id is null or length(receipt_id) <= 64);
create index if not exists locker_rentals_customer_idx on public.locker_rentals (customer_id, day) where customer_id is not null;

-- ── Helpers ─────────────────────────────────────────────────────────────────────────────────
-- A unit's code as typed or tagged: 7, 07, L7 and "l 7" all read 7 when the unit 7 exists (a tag
-- written before the L went still opens its locker).
create or replace function public._lk_code(p text)
returns text
language plpgsql stable security definer set search_path to 'public'
as $$
declare c text; n text;
begin
  c := upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'));
  c := regexp_replace(c, '^([A-Z]{0,3})0+([1-9])', '\1\2');
  if exists (select 1 from lockers where code = c and status <> 'retired') then return c; end if;
  n := regexp_replace(regexp_replace(c, '^[A-Z]+', ''), '^0+', '');
  if n ~ '^[1-9][0-9]{0,3}$' and exists (select 1 from lockers where code = n and status <> 'retired') then return n; end if;
  return c;
end $$;
revoke execute on function public._lk_code(text) from public, anon, authenticated;

-- An evening's locker session: the first session that day offering lockers (a JCC ride before a
-- Petromin night; the one set of lockers is at one place an evening).
create or replace function public._lk_evening(p_day date)
returns table (session_id text, kind text)
language sql stable security definer set search_path to 'public'
as $$
  select s.id, _lk_kind(s.id)
    from sessions s
   where s.session_date ~ '^\d{4}-\d{2}-\d{2}' and left(s.session_date, 10) = p_day::text
     and coalesce(s.lockers, false) and not coalesce(s.draft, false) and _lk_kind(s.id) <> ''
   order by (_lk_kind(s.id) = 'jcc') desc, s.session_date, s.id
   limit 1
$$;
revoke execute on function public._lk_evening(date) from public, anon, authenticated;

-- A period that is over (Riyadh time): early ends at 20:00, pm at 21:00, late and both at 23:00.
create or replace function public._lk_ended(p_day date, p_period text)
returns boolean
language sql stable set search_path to 'public'
as $$
  select p_day < (now() at time zone 'Asia/Riyadh')::date
      or (p_day = (now() at time zone 'Asia/Riyadh')::date
          and (now() at time zone 'Asia/Riyadh')::time
              >= (case p_period when 'early' then '20:00' when 'pm' then '21:00' else '23:00' end)::time)
$$;
revoke execute on function public._lk_ended(date, text) from public, anon, authenticated;

-- A rental paid from the rider's wallet: its own Sales receipt, written as the till writes a sale paid from
-- a wallet (staff_wallet_pay_sale): the money out through _wallet_post, the qty-0 'wallet' line, then the
-- locker's 'paid' line linked to the account. The caller holds the evening's lock.
create or replace function public._lk_wallet_sale(p_rental uuid)
returns text
language plpgsql volatile security definer set search_path to 'public'
as $$
declare r locker_rentals%rowtype; rid text; at text; code text;
begin
  select * into r from locker_rentals where id = p_rental;
  if r.id is null or r.customer_id is null or coalesce(r.price, 0) <= 0 then raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001'; end if;
  if r.receipt_id is not null then return r.receipt_id; end if;
  rid := 'lk-' || replace(r.id::text, '-', '');
  select l.code into code from lockers l where l.id = r.locker_id;
  at := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  perform set_config('mm.wallet_op', 'Lockers page', true);
  perform _wallet_post(_wallet_owner(r.customer_id), -r.price, 'sale', null, null, null, rid, r.session_id);
  perform set_config('mm.wallet_op', '', true);
  perform set_config('mm.wallet_ok', '1', true);
  insert into cashier_sales (id, receipt_id, session_id, customer_name, item_id, name, category, qty, price, pay, team_name, created_at, sold_by_name)
  values ('wal-' || rid, rid, r.session_id, r.name, null, 'Wallet', '__cardmeta__', 0, r.price, 'wallet', null, at, 'Lockers page');
  perform set_config('mm.wallet_ok', '', true);
  insert into cashier_sales (id, receipt_id, session_id, customer_name, customer_id, item_id, name, category, qty, price, pay, team_name, created_at, sold_by_name)
  values (rid, rid, r.session_id, r.name, r.customer_id, null,
          left('Locker ' || coalesce(code, '') || ' · ' || case r.period when 'early' then '6-8 PM' when 'late' then '9-11 PM'
                                                                     when 'both' then '6-11 PM' else '7-9 PM' end, 120),
          'Other', 1, r.price, 'paid', null, at, 'Lockers page');
  update locker_rentals set receipt_id = rid where id = r.id;
  return rid;
end $$;
revoke execute on function public._lk_wallet_sale(uuid) from public, anon, authenticated;

-- A cancelled rental's wallet payment back: its receipt voided, and wallet_sale_follow returns the money.
create or replace function public._lk_unpay(p_rental uuid, p_who text)
returns void
language plpgsql volatile security definer set search_path to 'public'
as $$
declare rid text;
begin
  select receipt_id into rid from locker_rentals where id = p_rental;
  if rid is null then return; end if;
  update cashier_sales set voided_at = now(), voided_by = left(coalesce(nullif(btrim(p_who), ''), 'rider'), 60),
         void_reason = 'locker cancelled'
   where receipt_id = rid and voided_at is null and refunded_at is null;
end $$;
revoke execute on function public._lk_unpay(uuid, text) from public, anon, authenticated;

-- ── 3. Anyone: the evenings and the cabinet ─────────────────────────────────────────────────
-- The evenings still to come (today and the next 30 days) that offer lockers, with the prices. A
-- Petromin night is listed only to a rider signed in (p_id, p_token) who is booked on it.
create or replace function public.locker_evenings(p_id text default null, p_token text default null)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare t date := (now() at time zone 'Asia/Riyadh')::date; me text;
begin
  if p_id is not null and _cust_token_ok(p_id, p_token) then me := p_id; end if;
  return jsonb_build_object('one', _lk_price('early'), 'both', _lk_price('both'), 'evenings', coalesce((
    select jsonb_agg(jsonb_build_object('day', ev.day, 'kind', ev.kind) order by ev.day)
      from (select g::date as day, e.kind, e.session_id
              from generate_series(t, t + 30, interval '1 day') g
              cross join lateral _lk_evening(g::date) e) ev
     where not _lk_ended(ev.day, case ev.kind when 'pm' then 'pm' else 'late' end)  -- tonight, until its last period ends
       and (ev.kind = 'jcc'
        or (ev.kind = 'pm' and me is not null and exists (
              select 1 from queue_entries q join sessions s on s.id = q.session_id
               where q.customer_id = me and q.status in ('waiting', 'waitlist', 'active', 'done')
                 and left(s.session_date, 10) = ev.day::text and _lk_kind(s.id) = 'pm')))), '[]'::jsonb));
end $$;
revoke execute on function public.locker_evenings(text, text) from public;
grant execute on function public.locker_evenings(text, text) to anon, authenticated;

-- One evening's cabinet: its kind and prices, what is left per period, which periods are over, the units
-- (code, out of service) and the codes taken per slot (e 18-20, l 21-23). Never who holds them.
create or replace function public.locker_board(p_day date)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare ev record;
begin
  select * into ev from _lk_evening(p_day);
  if ev.session_id is null or p_day < (now() at time zone 'Asia/Riyadh')::date then
    return jsonb_build_object('kind', '');
  end if;
  return jsonb_build_object(
    'day', p_day, 'kind', ev.kind, 'one', _lk_price('early'), 'both', _lk_price('both'), 'left', _lk_left(p_day),
    'ended', jsonb_build_object('early', _lk_ended(p_day, 'early'), 'late', _lk_ended(p_day, 'late'),
                                'both', _lk_ended(p_day, 'both'), 'pm', _lk_ended(p_day, 'pm')),
    'units', coalesce((select jsonb_agg(jsonb_build_object('code', l.code, 'out', l.status <> 'available')
                                        order by regexp_replace(l.code, '[0-9]+$', ''), (regexp_replace(l.code, '^[A-Z]+', ''))::int)
                         from lockers l where l.status <> 'retired'), '[]'::jsonb),
    'taken', jsonb_build_object(
      'e', coalesce((select jsonb_agg(distinct l.code) from locker_rentals r join lockers l on l.id = r.locker_id
                      where r.day = p_day and r.status in ('reserved', 'in_use') and 'e' = any(_lk_slots(r.period))), '[]'::jsonb),
      'l', coalesce((select jsonb_agg(distinct l.code) from locker_rentals r join lockers l on l.id = r.locker_id
                      where r.day = p_day and r.status in ('reserved', 'in_use') and 'l' = any(_lk_slots(r.period))), '[]'::jsonb)));
end $$;
revoke execute on function public.locker_board(date) from public;
grant execute on function public.locker_board(date) to anon, authenticated;

-- ── 4. The rider on the page ────────────────────────────────────────────────────────────────
-- Up to 3 lockers picked on an evening's cabinet, for one period, with no booking needed. p_pay 'wallet'
-- takes the whole fee from the wallet now (refused WALLET_SHORT when it cannot; never on a Petromin night,
-- the company's bill); 'desk' is paid when staff hand the key.
create or replace function public.customer_locker_book(p_id text, p_token text, p_day date, p_period text,
                                                       p_codes text[], p_pay text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare ev record; codes text[]; c text; n int; held int; lk lockers%rowtype; rid uuid; fee numeric; nm text;
        outv jsonb := '[]'::jsonb;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_pay is null or p_pay not in ('desk', 'wallet') then raise exception 'LOCKER_PAY' using errcode = 'P0001'; end if;
  select array_agg(distinct _lk_code(x)) into codes from unnest(coalesce(p_codes, '{}'::text[])) x
   where nullif(btrim(coalesce(x, '')), '') is not null;
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
  select left(coalesce(nullif(btrim(cu.name), ''), '?'), 120) into nm from customers cu where cu.id = p_id;
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
  foreach c in array codes loop
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
    outv := outv || jsonb_build_array(jsonb_build_object('id', rid, 'code', c));
  end loop;
  return jsonb_build_object('ok', true, 'rentals', outv, 'left', _lk_left(p_day));
end $$;
revoke execute on function public.customer_locker_book(text, text, date, text, text[], text) from public, anon;
grant execute on function public.customer_locker_book(text, text, date, text, text[], text) to anon, authenticated;

-- The rider takes back a locker that has no booking behind it, before the key was handed over. A wallet
-- payment comes back.
create or replace function public.customer_locker_drop(p_id text, p_token text, p_rental uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare r locker_rentals%rowtype;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into r from locker_rentals where id = p_rental and customer_id = p_id and booking_id is null;
  if r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform _lk_lock(r.day);
  select * into r from locker_rentals where id = p_rental for update;
  if r.status <> 'reserved' then raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001'; end if;
  update locker_rentals set status = 'cancelled', cancelled_at = now(), cancelled_by = 'rider', cancel_reason = 'rider'
   where id = r.id;
  perform _lk_unpay(r.id, 'rider');
  return jsonb_build_object('ok', true, 'left', _lk_left(r.day));
end $$;
revoke execute on function public.customer_locker_drop(text, text, uuid) from public, anon;
grant execute on function public.customer_locker_drop(text, text, uuid) to anon, authenticated;

-- The rider's own rentals from yesterday on: on a booking of theirs, or with none (the page, or staff
-- renting one to their account).
create or replace function public.customer_lockers(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'booking_id', r.booking_id, 'day', r.day, 'period', r.period,
                                        'status', r.status, 'price', r.price, 'on_bill', r.on_bill, 'pay', r.pay,
                                        'paid', r.receipt_id is not null, 'code', l.code) order by r.day, r.created_at)
      from locker_rentals r
      left join queue_entries q on q.id = r.booking_id
      left join lockers l on l.id = r.locker_id
     where r.status <> 'cancelled'
       and r.day >= (now() at time zone 'Asia/Riyadh')::date - 1
       and ((r.booking_id is not null and q.customer_id = p_id) or (r.booking_id is null and r.customer_id = p_id))), '[]'::jsonb);
end $$;
revoke execute on function public.customer_lockers(text, text) from public, anon;
grant execute on function public.customer_lockers(text, text) to anon, authenticated;

-- ── 5. The rider on the booking review: the picked lockers ──────────────────────────────────
-- As before, a locker on each of these bookings for one period; with p_codes (one per booking, in the
-- same order) each holds the locker picked on the grid. A cached page calling with four arguments still
-- reserves "a locker" with no number.
drop function if exists public.customer_locker_reserve(text, text, text[], text);
create or replace function public.customer_locker_reserve(p_id text, p_token text, p_booking_ids text[], p_period text,
                                                          p_codes text[] default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; bid text; k text; d date; n int; ids text[]; codes text[]; c text; lk lockers%rowtype; i int := 0;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select array_agg(x order by o) into ids
    from (select distinct on (x) x, o from unnest(p_booking_ids) with ordinality u(x, o) where x is not null order by x, o) z;
  n := coalesce(array_length(ids, 1), 0);
  if n = 0 or n > 20 then raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001'; end if;
  if p_codes is not null then
    select array_agg(_lk_code(x) order by o) into codes from unnest(p_codes) with ordinality u(x, o);
    if coalesce(array_length(codes, 1), 0) <> n or (select count(distinct x) from unnest(codes) x) <> n then
      raise exception 'LOCKER_PICK' using errcode = 'P0001';
    end if;
  end if;
  foreach bid in array ids loop
    select * into q from queue_entries where id = bid and customer_id = p_id for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if coalesce(q.status, '') not in ('waiting', 'waitlist') or coalesce(q.paid, false) then
      raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';
    end if;
    if exists (select 1 from rider_registrations rr where rr.matched_entry_id = q.id) then
      raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';  -- the Petromin form's riders take none (the owner, 2026-11-09)
    end if;
    if k is null then
      k := _lk_kind(q.session_id);
      select case when s.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date, 10)::date end into d
        from sessions s where s.id = q.session_id;
    elsif _lk_kind(q.session_id) is distinct from k
       or (select left(s.session_date, 10) from sessions s where s.id = q.session_id) is distinct from d::text then
      raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';
    end if;
  end loop;
  if not _lk_period_ok(k, p_period) or d is null or d < (now() at time zone 'Asia/Riyadh')::date then
    raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';
  end if;
  perform _lk_lock(d);
  if exists (select 1 from locker_rentals r where r.booking_id = any(ids) and r.status in ('reserved', 'in_use')) then
    raise exception 'LOCKER_HELD' using errcode = 'P0001';
  end if;
  if not _lk_room(d, p_period, n) then raise exception 'LOCKERS_FULL' using errcode = 'P0001'; end if;
  foreach bid in array ids loop
    i := i + 1; lk := null;
    if codes is not null then
      c := codes[i];
      select * into lk from lockers where code = c and status <> 'retired';
      if lk.id is null then raise exception 'LOCKER_UNKNOWN: %', c using errcode = 'P0002'; end if;
      if lk.status <> 'available' then raise exception 'LOCKER_OUT: %', c using errcode = 'P0001'; end if;
      if exists (select 1 from locker_rentals x where x.locker_id = lk.id and x.day = d and x.status in ('reserved', 'in_use')
                   and _lk_slots(x.period) && _lk_slots(p_period)) then
        raise exception 'LOCKER_TAKEN: %', c using errcode = 'P0001';
      end if;
    end if;
    insert into locker_rentals (day, period, booking_id, session_id, customer_id, name, locker_id, price, on_bill, status, created_by)
    select d, p_period, e.id, e.session_id, e.customer_id, left(e.name, 120), lk.id, _lk_price(p_period), true, 'reserved', 'rider'
      from queue_entries e where e.id = bid;
  end loop;
  return jsonb_build_object('ok', true, 'left', _lk_left(d),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'addons', e.addons, 'paid', e.paid, 'pay_method', e.pay_method,
                                                          'wallet_paid', e.wallet_paid)), '[]'::jsonb)
               from queue_entries e where e.id = any(ids)));
end $$;
revoke execute on function public.customer_locker_reserve(text, text, text[], text, text[]) from public, anon;
grant execute on function public.customer_locker_reserve(text, text, text[], text, text[]) to anon, authenticated;

-- ── 6. Staff ────────────────────────────────────────────────────────────────────────────────
-- Give (or move to) a locker by its number. 7, 07 and L7 all read 7 (_lk_code). A rental already
-- holding this locker (the rider picked it) gets its key: in_use.
create or replace function public.staff_locker_assign(p_rental uuid, p_code text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare r locker_rentals%rowtype; l lockers%rowtype; c text; who text;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  c := _lk_code(p_code);
  select * into r from locker_rentals where id = p_rental;
  if r.id is null then raise exception 'NOT_FOUND: no such rental' using errcode = 'P0002'; end if;
  perform _lk_lock(r.day);
  select * into r from locker_rentals where id = p_rental for update;
  if r.status not in ('reserved', 'in_use') then raise exception 'LOCKER_NOT_OPEN: the rental is %', r.status using errcode = 'P0001'; end if;
  select * into l from lockers where code = c and status <> 'retired';
  if l.id is null then raise exception 'LOCKER_UNKNOWN: %', c using errcode = 'P0002'; end if;
  if l.status <> 'available' then raise exception 'LOCKER_OUT: %', c using errcode = 'P0001'; end if;
  select x.name into who from locker_rentals x
   where x.locker_id = l.id and x.day = r.day and x.id <> r.id and x.status in ('reserved', 'in_use')
     and _lk_slots(x.period) && _lk_slots(r.period)
   limit 1;
  if found then raise exception 'LOCKER_TAKEN: % is with %', c, coalesce(who, '?') using errcode = 'P0001'; end if;
  update locker_rentals set locker_id = l.id, status = 'in_use',
         assigned_at = case when r.locker_id is distinct from l.id or r.status <> 'in_use' then now() else assigned_at end,
         assigned_by = case when r.locker_id is distinct from l.id or r.status <> 'in_use' then _lk_who() else assigned_by end
   where id = r.id;
  return jsonb_build_object('ok', true, 'code', l.code);
end $$;
revoke execute on function public.staff_locker_assign(uuid, text) from public, anon;
grant execute on function public.staff_locker_assign(uuid, text) to authenticated;

-- Cancelled: the locker is free, a fee on the bill comes off it and a wallet payment goes back. p_undo puts
-- a handed-back rental back in use (a Hand back tapped by mistake).
create or replace function public.staff_locker_cancel(p_rental uuid, p_reason text, p_undo boolean)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare r locker_rentals%rowtype; who text;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into r from locker_rentals where id = p_rental;
  if r.id is null then raise exception 'NOT_FOUND: no such rental' using errcode = 'P0002'; end if;
  perform _lk_lock(r.day);
  select * into r from locker_rentals where id = p_rental for update;
  if coalesce(p_undo, false) then
    if r.status <> 'returned' or r.locker_id is null then raise exception 'LOCKER_NOT_OPEN: nothing to undo' using errcode = 'P0001'; end if;
    select x.name into who from locker_rentals x
     where x.locker_id = r.locker_id and x.day = r.day and x.id <> r.id and x.status in ('reserved', 'in_use')
       and _lk_slots(x.period) && _lk_slots(r.period) limit 1;
    if found then raise exception 'LOCKER_TAKEN: the locker is with %', coalesce(who, '?') using errcode = 'P0001'; end if;
    update locker_rentals set status = 'in_use', returned_at = null, returned_by = null where id = r.id;
    return jsonb_build_object('ok', true);
  end if;
  if r.status not in ('reserved', 'in_use', 'returned') then raise exception 'LOCKER_NOT_OPEN: already cancelled' using errcode = 'P0001'; end if;
  update locker_rentals set status = 'cancelled', cancelled_at = now(), cancelled_by = _lk_who(),
         cancel_reason = left(coalesce(nullif(btrim(p_reason), ''), 'staff'), 120)
   where id = r.id;
  perform _lk_unpay(r.id, _lk_who());
  if r.booking_id is null then return jsonb_build_object('ok', true); end if;
  return jsonb_build_object('ok', true, 'booking_id', r.booking_id, 'addons', (select e.addons from queue_entries e where e.id = r.booking_id));
end $$;
revoke execute on function public.staff_locker_cancel(uuid, text, boolean) from public, anon;
grant execute on function public.staff_locker_cancel(uuid, text, boolean) to authenticated;

-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._lk_code(text)', 'public._lk_evening(date)', 'public._lk_wallet_sale(uuid)',
                           'public._lk_unpay(uuid,text)', 'public.locker_evenings(text,text)', 'public.locker_board(date)',
                           'public.customer_locker_book(text,text,date,text,text[],text)', 'public.customer_locker_drop(text,text,uuid)',
                           'public.customer_lockers(text,text)', 'public.customer_locker_reserve(text,text,text[],text,text[])',
                           'public.staff_locker_assign(uuid,text)', 'public.staff_locker_cancel(uuid,text,boolean)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._lk_code(text)', 'public._lk_evening(date)', 'public._lk_ended(date,text)',
                           'public._lk_wallet_sale(uuid)', 'public._lk_unpay(uuid,text)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  foreach f in array array['public.locker_evenings(text,text)', 'public.locker_board(date)',
                           'public.customer_locker_book(text,text,date,text,text[],text)', 'public.customer_locker_drop(text,text,uuid)',
                           'public.customer_locker_reserve(text,text,text[],text,text[])'] loop
    if not has_function_privilege('anon', f, 'execute') then raise exception '% is not executable by anon', f; end if;
  end loop;
  if exists (select 1 from public.lockers where code ~ '^L[0-9]+$' and status <> 'retired') then
    raise exception 'a locker still carries the L';
  end if;
  if (select count(*) from public.lockers where status <> 'retired' and code ~ '^([1-9]|1[0-8])$') <> 18 then
    raise exception 'lockers 1 to 18 are not all there';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261109220000', 'locker_page')
on conflict (version) do nothing;

commit;
