-- ============================================================================
-- The wallet (the owner, 2026-11-02: "add a wallet section for all accounts that staff can add money
-- to accounts or when refunding and allow customers to use it").
--
-- Every account has a balance in SAR. Staff add money (taken by card, cash or transfer, or given with
-- no money taken), take it out, and refund a paid booking or a sales receipt into it. The rider, or
-- staff for them, pays a booking from it, only when it covers the whole amount.
--
--  1. wallet_ledger: one line per movement, never changed. wallet_balances: the sum, one locked row per
--     account, never below zero. Neither table can be read or written through the API: every door is a
--     function here, and _wallet_post is the only writer.
--  2. A booking paid from the wallet is paid = true, pay_method = 'wallet'. zz_wallet_follow (the last
--     BEFORE trigger on queue_entries, so it sees the row as the others leave it) keeps the money and the
--     row together whichever way the row moves: un-paid, marked card, put on the house, cancelled, removed
--     or deleted, the money goes back; a lower price gives the difference back; a higher one (an add-on
--     added after paying) gives all of it back and leaves the booking to pay, so nothing is ever taken
--     without being asked. A no-show keeps the money, as a card payment does. Staff who write
--     pay_method = 'wallet' directly (the desk's Undo) charge the wallet the same way, or are refused.
--  3. A merge carries the balance to the kept account and an unmerge brings it back: a trigger on
--     customers.merged_into, so staff_merge_customers and staff_unmerge_customers stay as they are. An
--     account with money in its wallet cannot be deleted.
--
-- Money: a top-up is in the drawer (the till reads staff_wallet_moves) and is not revenue; a booking paid
-- from the wallet is revenue when spent and is neither card nor cash. _mt_core needs no change: rev_rides
-- counts it, and rev_card and rev_cash do not. The race kinds (vlap, arena) are refused: that money
-- belongs to the race's organiser.
--
-- The page finds out by asking: until this is applied staff_wallet_balances answers "no such function"
-- and nothing about the wallet is drawn.
--
-- Rollback (loses every balance; read wallet_balances first):
--   drop trigger if exists zz_wallet_follow on public.queue_entries;
--   drop trigger if exists zz_wallet_follow_del on public.queue_entries;
--   drop trigger if exists wallet_merge_follow on public.customers;
--   drop trigger if exists wallet_delete_guard on public.customers;
--   drop function public.customer_wallet_pay(text, text, text[]); drop function public.customer_wallet(text, text);
--   drop function public.staff_wallet_refund_receipt(text, text, text, text, uuid);
--   drop function public.staff_wallet_refund_booking(text, text, text, text);
--   drop function public.staff_wallet_pay_booking(text[], text);
--   drop function public.staff_wallet_change(text, numeric, text, text, text, text, text, uuid);
--   drop function public.staff_wallet_moves(date); drop function public.staff_wallet_balances();
--   drop function public.staff_wallet(text); drop function public._wallet_delete_guard();
--   drop function public._wallet_merge_follow(); drop function public._wallet_follow();
--   drop function public._wallet_pay_row(public.queue_entries, numeric);
--   drop function public._wallet_amount(numeric, text); drop function public._wallet_post(text, numeric, text, text, numeric, text, text, text, text);
--   drop function public._wallet_owner(text); drop table public.wallet_ledger; drop table public.wallet_balances;
--   update public.queue_entries set paid = false, pay_method = null where pay_method = 'wallet';  (before the drops)
--
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. The tables ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.wallet_balances (
  customer_id text primary key,
  balance     numeric(10,2) not null default 0 check (balance >= 0),
  updated_at  timestamptz not null default now()
);
create index if not exists wallet_balances_held_idx on public.wallet_balances (balance) where balance > 0;

create table if not exists public.wallet_ledger (
  id             bigint generated always as identity primary key,
  customer_id    text not null,
  amount         numeric(10,2) not null check (amount <> 0),   -- plus goes in, minus comes out
  balance_after  numeric(10,2) not null check (balance_after >= 0),
  kind           text not null check (kind in ('topup', 'adjust', 'takeout', 'refund', 'spend', 'return', 'merge_in', 'merge_out', 'unmerge')),
  method         text check (method is null or method in ('card', 'cash', 'transfer', 'split')),
  card_part      numeric(10,2),                                -- of a refund: what was taken by card (the rest was cash)
  note           text check (note is null or length(note) <= 300),
  booking_id     text,
  receipt_id     text,
  session_id     text,
  other_customer text,                                         -- of a merge: the other account
  by_user        uuid,                                         -- the signed-in staff account; null is the rider
  by_name        text check (by_name is null or length(by_name) <= 40),
  created_at     timestamptz not null default now()
);
create index if not exists wallet_ledger_customer_idx on public.wallet_ledger (customer_id, id desc);
create index if not exists wallet_ledger_booking_idx on public.wallet_ledger (booking_id) where booking_id is not null;
create index if not exists wallet_ledger_till_idx on public.wallet_ledger (created_at) where kind in ('topup', 'takeout', 'refund');

alter table public.wallet_balances enable row level security;
alter table public.wallet_ledger enable row level security;
revoke all on public.wallet_balances from public, anon, authenticated;
revoke all on public.wallet_ledger from public, anon, authenticated;

-- ── 2. The one writer ───────────────────────────────────────────────────────────────────────────
-- The account that holds the money now: a merged account's keeper.
create or replace function public._wallet_owner(p_customer text)
returns text
language plpgsql stable security definer set search_path to 'public'
as $$
declare cur text := p_customer; nxt text; i int := 0;
begin
  loop
    select merged_into into nxt from customers where id = cur;
    exit when nxt is null or i >= 8;
    cur := nxt; i := i + 1;
  end loop;
  return cur;
end $$;
revoke execute on function public._wallet_owner(text) from public, anon, authenticated;

-- Moves the balance and writes the line together. Taking more than is there raises WALLET_SHORT, and
-- the row lock makes two desks spending at once take their turns. The operator's name and the reason
-- come from mm.wallet_op and mm.wallet_note when a function set them.
create or replace function public._wallet_post(p_customer text, p_amount numeric, p_kind text,
                                               p_method text default null, p_card_part numeric default null,
                                               p_booking text default null, p_receipt text default null,
                                               p_session text default null, p_other text default null)
returns numeric
language plpgsql volatile security definer set search_path to 'public'
as $$
declare b numeric;
begin
  if p_customer is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
  insert into wallet_balances (customer_id, balance) values (p_customer, 0) on conflict (customer_id) do nothing;
  select balance into b from wallet_balances where customer_id = p_customer for update;
  b := round(b + p_amount, 2);
  if b < 0 then raise exception 'WALLET_SHORT' using errcode = 'P0001'; end if;
  update wallet_balances set balance = b, updated_at = now() where customer_id = p_customer;
  insert into wallet_ledger (customer_id, amount, balance_after, kind, method, card_part, note,
                             booking_id, receipt_id, session_id, other_customer, by_user, by_name)
  values (p_customer, round(p_amount, 2), b, p_kind, p_method, p_card_part,
          left(nullif(btrim(coalesce(current_setting('mm.wallet_note', true), '')), ''), 300),
          p_booking, p_receipt, p_session, p_other, auth.uid(),
          left(nullif(btrim(coalesce(current_setting('mm.wallet_op', true), '')), ''), 40));
  return b;
end $$;
revoke execute on function public._wallet_post(text, numeric, text, text, numeric, text, text, text, text) from public, anon, authenticated;

-- What a booking costs: its price and its add-ons, as _mt_core and the page's _bookingAmount count it.
create or replace function public._wallet_amount(p_price numeric, p_addons text)
returns numeric
language sql stable security definer set search_path to 'public'
as $$
  select round(coalesce(p_price, 57.5) + coalesce((
    select sum(coalesce(case when jsonb_typeof(a) = 'object' and (a->>'p') ~ '^-?[0-9]+(\.[0-9]+)?$' then (a->>'p')::numeric end, i.price, 0)
               * greatest(coalesce(case when jsonb_typeof(a) = 'object' and (a->>'qty') ~ '^[0-9]+$' then (a->>'qty')::numeric end, 1), 1))
      from jsonb_array_elements(_mt_json(p_addons)) a
      left join inventory i on i.id = case when jsonb_typeof(a) = 'object' then a->>'id' else a #>> '{}' end
  ), 0), 2)
$$;
revoke execute on function public._wallet_amount(numeric, text) from public, anon, authenticated;

-- ── 3. The booking and its money stay together ──────────────────────────────────────────────────
create or replace function public._wallet_follow()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare net numeric; who text; amt numeric; want boolean;
begin
  if tg_op = 'INSERT' then
    -- A booking is born unpaid in this sense: only paying it charges a wallet.
    if new.pay_method = 'wallet' then new.pay_method := null; new.paid := false; end if;
    return new;
  end if;

  if tg_op = 'UPDATE' and old.pay_method is distinct from 'wallet' and new.pay_method is distinct from 'wallet' then
    return new;  -- nearly every write to this table
  end if;
  if tg_op = 'DELETE' and old.pay_method is distinct from 'wallet' then return old; end if;

  -- What this booking holds of a wallet now, and whose it was (a merge moves it to the keeper).
  select coalesce(-sum(l.amount), 0) into net from wallet_ledger l
   where l.booking_id = (case when tg_op = 'DELETE' then old.id else new.id end) and l.kind in ('spend', 'return');
  select _wallet_owner(l.customer_id) into who from wallet_ledger l
   where l.booking_id = (case when tg_op = 'DELETE' then old.id else new.id end) and l.kind = 'spend'
   order by l.id desc limit 1;

  if tg_op = 'DELETE' then
    if net > 0 then perform _wallet_post(who, net, 'return', null, null, old.id, null, old.session_id); end if;
    return old;
  end if;

  want := coalesce(new.paid, false) and new.pay_method = 'wallet' and coalesce(new.status, '') not in ('cancelled', 'removed');
  amt := _wallet_amount(new.price, new.addons);

  if not want or amt <= 0 then
    if net > 0 then perform _wallet_post(who, net, 'return', null, null, new.id, null, new.session_id); end if;
    if new.pay_method = 'wallet' then
      -- cancelled or removed: nothing is held for it any more, and bringing it back does not charge again
      new.pay_method := null;
      if amt > 0 then new.paid := false; end if;
    end if;
    return new;
  end if;

  new.card_amount := null;
  if net = amt then return new; end if;
  if net = 0 then
    if new.customer_id is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
    perform _wallet_post(_wallet_owner(new.customer_id), -amt, 'spend', null, null, new.id, null, new.session_id);
    return new;
  end if;
  if net > amt then
    perform _wallet_post(who, net - amt, 'return', null, null, new.id, null, new.session_id);
    return new;
  end if;
  -- It costs more than was paid: the money goes back and the booking is to pay again.
  perform _wallet_post(who, net, 'return', null, null, new.id, null, new.session_id);
  new.paid := false; new.pay_method := null;
  return new;
end $$;
revoke execute on function public._wallet_follow() from public, anon, authenticated;

drop trigger if exists zz_wallet_follow on public.queue_entries;
create trigger zz_wallet_follow before insert or update on public.queue_entries
  for each row execute function public._wallet_follow();
drop trigger if exists zz_wallet_follow_del on public.queue_entries;
create trigger zz_wallet_follow_del before delete on public.queue_entries
  for each row execute function public._wallet_follow();

-- ── 4. Merges and deletes ───────────────────────────────────────────────────────────────────────
create or replace function public._wallet_merge_follow()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare b numeric; keep text; moved numeric;
begin
  if old.merged_into is null and new.merged_into is not null then
    select balance into b from wallet_balances where customer_id = new.id for update;
    if coalesce(b, 0) > 0 then
      keep := _wallet_owner(new.merged_into);
      perform _wallet_post(new.id, -b, 'merge_out', null, null, null, null, null, keep);
      perform _wallet_post(keep, b, 'merge_in', null, null, null, null, null, new.id);
    end if;
  elsif old.merged_into is not null and new.merged_into is null then
    keep := _wallet_owner(old.merged_into);
    select coalesce(sum(l.amount), 0) into moved from wallet_ledger l
     where l.customer_id = keep and l.other_customer = new.id and l.kind in ('merge_in', 'unmerge');
    select least(moved, coalesce((select balance from wallet_balances where customer_id = keep for update), 0)) into moved;
    if moved > 0 then  -- what was brought over and is still there; what was spent since stays spent
      perform _wallet_post(keep, -moved, 'unmerge', null, null, null, null, null, new.id);
      perform _wallet_post(new.id, moved, 'unmerge', null, null, null, null, null, keep);
    end if;
  end if;
  return null;
end $$;
revoke execute on function public._wallet_merge_follow() from public, anon, authenticated;
drop trigger if exists wallet_merge_follow on public.customers;
create trigger wallet_merge_follow after update of merged_into on public.customers
  for each row when (old.merged_into is distinct from new.merged_into)
  execute function public._wallet_merge_follow();

create or replace function public._wallet_delete_guard()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if exists (select 1 from wallet_balances where customer_id = old.id and balance > 0) then
    raise exception 'WALLET_HAS_MONEY' using errcode = 'P0001';
  end if;
  return old;
end $$;
revoke execute on function public._wallet_delete_guard() from public, anon, authenticated;
drop trigger if exists wallet_delete_guard on public.customers;
create trigger wallet_delete_guard before delete on public.customers
  for each row execute function public._wallet_delete_guard();

-- ── 5. Staff ────────────────────────────────────────────────────────────────────────────────────
-- One account's wallet: the balance and its last 200 lines.
create or replace function public.staff_wallet(p_customer text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare who text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  who := _wallet_owner(p_customer);
  return jsonb_build_object(
    'customer_id', who,
    'balance', coalesce((select balance from wallet_balances where customer_id = who), 0),
    'rows', coalesce((select jsonb_agg(x order by x.id desc) from (
       select l.id, l.amount, l.balance_after, l.kind, l.method, l.note, l.booking_id, l.receipt_id, l.session_id, l.created_at,
              coalesce(l.by_name, nullif(btrim(s.display_name), '')) as by_name
         from wallet_ledger l left join staff s on s.user_id = l.by_user
        where l.customer_id = who order by l.id desc limit 200) x), '[]'::jsonb));
end $$;
revoke all on function public.staff_wallet(text) from public, anon;
grant execute on function public.staff_wallet(text) to authenticated;

-- Every account holding money: the Accounts list's chips, and Customers > Wallets.
create or replace function public.staff_wallet_balances()
returns table(customer_id text, balance numeric)
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return query select b.customer_id, b.balance from wallet_balances b where b.balance > 0;
end $$;
revoke all on function public.staff_wallet_balances() from public, anon;
grant execute on function public.staff_wallet_balances() to authenticated;

-- What moved real money, for the till.
create or replace function public.staff_wallet_moves(p_from date)
returns table(id bigint, kind text, amount numeric, method text, card_part numeric, session_id text, created_at timestamptz)
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return query select l.id, l.kind, l.amount, l.method, l.card_part, l.session_id, l.created_at from wallet_ledger l
    where l.kind in ('topup', 'takeout', 'refund') and l.created_at >= (coalesce(p_from, current_date - 60)::timestamp at time zone 'Asia/Riyadh');
end $$;
revoke all on function public.staff_wallet_moves(date) from public, anon;
grant execute on function public.staff_wallet_moves(date) to authenticated;

-- Add money (a plus) or take it out (a minus). p_method: card, cash or transfer for money that moved,
-- 'none' for money that did not (a gift, a correction), which must say why.
create or replace function public.staff_wallet_change(p_customer text, p_amount numeric, p_method text, p_note text,
                                                      p_session text default null, p_op text default null,
                                                      p_approval text default null, p_op_id uuid default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_uid uuid := auth.uid(); v_claimed int; v_prior jsonb; v_res jsonb; who text; amt numeric := round(p_amount, 2); b numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if amt is null or amt = 0 or abs(amt) > 10000 then raise exception 'WALLET_AMOUNT' using errcode = 'P0001'; end if;
  if p_method is null or p_method not in ('card', 'cash', 'transfer', 'none') then raise exception 'WALLET_METHOD' using errcode = 'P0001'; end if;
  if p_method = 'none' and nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'WALLET_NOTE' using errcode = 'P0001'; end if;
  if p_op_id is not null and v_uid is not null then
    insert into rpc_receipts (user_id, op_id, fn) values (v_uid, p_op_id, 'staff_wallet_change')
      on conflict do nothing returning 1 into v_claimed;
    if v_claimed is null then
      select result into v_prior from rpc_receipts where user_id = v_uid and op_id = p_op_id;
      return coalesce(v_prior, jsonb_build_object('ok', true)) || jsonb_build_object('replayed', true);
    end if;
  end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if not _mgr_ok('refund', abs(amt), p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  who := _wallet_owner(p_customer);
  if who is null or not exists (select 1 from customers where id = who) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform set_config('mm.wallet_op', coalesce(p_op, ''), true);
  perform set_config('mm.wallet_note', coalesce(p_note, ''), true);
  b := _wallet_post(who, amt, case when p_method = 'none' then 'adjust' when amt > 0 then 'topup' else 'takeout' end,
                    nullif(p_method, 'none'), null, null, null, nullif(btrim(coalesce(p_session, '')), ''));
  perform set_config('mm.wallet_note', '', true);
  v_res := jsonb_build_object('ok', true, 'customer_id', who, 'balance', b);
  if v_claimed is not null then
    update rpc_receipts set result = v_res where user_id = v_uid and op_id = p_op_id;
  end if;
  return v_res;
end $$;
revoke all on function public.staff_wallet_change(text, numeric, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.staff_wallet_change(text, numeric, text, text, text, text, text, uuid) to authenticated;

-- One booking onto the wallet, row locked by the caller. Paying twice is a no-op; the trigger charges.
create or replace function public._wallet_pay_row(q public.queue_entries, p_amount numeric)
returns boolean
language plpgsql volatile security definer set search_path to 'public'
as $$
begin
  if coalesce(q.paid, false) then return false; end if;
  if p_amount <= 0 then raise exception 'WALLET_NOTHING_DUE' using errcode = 'P0001'; end if;
  if q.customer_id is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
  if coalesce(q.status, '') in ('cancelled', 'removed') then raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001'; end if;
  if exists (select 1 from sessions s where s.id = q.session_id and coalesce(s.ride_kind, '') in ('vlap', 'arena')) then
    raise exception 'WALLET_RACE' using errcode = 'P0001';  -- the organiser's money
  end if;
  update queue_entries set paid = true, pay_method = 'wallet', card_amount = null where id = q.id;
  return true;
end $$;
revoke execute on function public._wallet_pay_row(public.queue_entries, numeric) from public, anon, authenticated;

-- The desk pays bookings from the rider's wallet: all of them or none (WALLET_SHORT).
create or replace function public.staff_wallet_pay_booking(p_booking_ids text[], p_op text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; bid text; total numeric := 0; paid_ids text[] := '{}'; amt numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  perform set_config('mm.wallet_op', coalesce(p_op, ''), true);
  foreach bid in array (select coalesce(array_agg(x order by x), '{}') from unnest(p_booking_ids) x) loop
    select * into q from queue_entries where id = bid for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    amt := _wallet_amount(q.price, q.addons);
    if _wallet_pay_row(q, amt) then total := total + amt; paid_ids := array_append(paid_ids, bid); end if;
  end loop;
  return jsonb_build_object('ok', true, 'paid', to_jsonb(paid_ids), 'amount', total,
    'balance', coalesce((select balance from wallet_balances where customer_id = _wallet_owner(q.customer_id)), 0));
end $$;
revoke all on function public.staff_wallet_pay_booking(text[], text) from public, anon;
grant execute on function public.staff_wallet_pay_booking(text[], text) to authenticated;

-- Refund a paid booking into the wallet. The booking is left to pay; cancelling it is a separate act.
create or replace function public.staff_wallet_refund_booking(p_booking_id text, p_reason text default null,
                                                              p_op text default null, p_approval text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; amt numeric; b numeric; who text; card numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into q from queue_entries where id = p_booking_id for update;
  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not coalesce(q.paid, false) then raise exception 'WALLET_NOT_PAID' using errcode = 'P0001'; end if;
  if q.pay_method = 'transfer' then raise exception 'WALLET_RACE' using errcode = 'P0001'; end if;
  if q.customer_id is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
  amt := _wallet_amount(q.price, q.addons);
  if amt <= 0 then raise exception 'WALLET_NOTHING_DUE' using errcode = 'P0001'; end if;
  if not _mgr_ok('refund', amt, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  perform set_config('mm.wallet_op', coalesce(p_op, ''), true);
  perform set_config('mm.wallet_note', coalesce(p_reason, ''), true);
  who := _wallet_owner(q.customer_id);
  if q.pay_method is distinct from 'wallet' then  -- on the wallet already, the trigger gives it back
    card := case when q.card_amount is not null then least(greatest(q.card_amount, 0), amt)
                 when q.pay_method = 'card' then amt when q.pay_method = 'cash' then 0 end;
    perform _wallet_post(who, amt, 'refund', case when q.card_amount is not null then 'split' when q.pay_method in ('card', 'cash') then q.pay_method end,
                         card, q.id, null, q.session_id);
  end if;
  update queue_entries set paid = false, pay_method = null, card_amount = null where id = q.id;
  perform set_config('mm.wallet_note', '', true);
  select balance into b from wallet_balances where customer_id = who;
  return jsonb_build_object('ok', true, 'id', q.id, 'amount', amt, 'balance', coalesce(b, 0));
end $$;
revoke all on function public.staff_wallet_refund_booking(text, text, text, text) from public, anon;
grant execute on function public.staff_wallet_refund_booking(text, text, text, text) to authenticated;

-- Refund a sales receipt into the wallet of the account it was sold to: staff_refund_receipt does the
-- refund (and every check of its own), then what the receipt took is credited, in one transaction.
create or replace function public.staff_wallet_refund_receipt(p_receipt_id text, p_reason text, p_op text,
                                                              p_approval text, p_op_id uuid default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare who text; took numeric; card numeric; sess text; res jsonb; b numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select _wallet_owner(max(c.customer_id)), max(c.session_id) into who, sess from cashier_sales c
   where coalesce(c.receipt_id, c.id) = p_receipt_id and c.customer_id is not null;
  if who is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
  select coalesce(sum(coalesce(c.qty, 0) * coalesce(c.price, 0)) filter (where c.pay = 'paid' and c.category is distinct from '__cardmeta__'), 0),
         coalesce(max(c.price) filter (where c.category = '__cardmeta__'), 0)
    into took, card from cashier_sales c
   where coalesce(c.receipt_id, c.id) = p_receipt_id and c.refunded_at is null and c.voided_at is null;
  took := round(took, 2);
  res := staff_refund_receipt(p_receipt_id, p_reason, p_op, p_approval, p_op_id);
  if coalesce((res->>'replayed')::boolean, false) or coalesce((res->>'count')::int, 0) = 0 then return res; end if;
  if took > 0 then
    perform set_config('mm.wallet_op', coalesce(p_op, ''), true);
    perform set_config('mm.wallet_note', coalesce(p_reason, ''), true);
    card := least(greatest(card, 0), took);
    b := _wallet_post(who, took, 'refund', case when card = 0 then 'cash' when card = took then 'card' else 'split' end, card, null, p_receipt_id, sess);
    perform set_config('mm.wallet_note', '', true);
  end if;
  res := res || jsonb_build_object('wallet', greatest(took, 0), 'balance',
           coalesce(b, (select balance from wallet_balances where customer_id = who), 0));
  if p_op_id is not null then
    update rpc_receipts set result = res where user_id = auth.uid() and op_id = p_op_id;
  end if;
  return res;
end $$;
revoke all on function public.staff_wallet_refund_receipt(text, text, text, text, uuid) from public, anon;
grant execute on function public.staff_wallet_refund_receipt(text, text, text, text, uuid) to authenticated;

-- ── 6. The rider ────────────────────────────────────────────────────────────────────────────────
-- The rider's own wallet. Not the staff's note, which was never written for them.
create or replace function public.customer_wallet(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not _cust_token_ok(p_id, p_token) then return null; end if;
  return jsonb_build_object(
    'balance', coalesce((select balance from wallet_balances where customer_id = p_id), 0),
    'rows', coalesce((select jsonb_agg(x order by x.id desc) from (
       select l.id, l.amount, l.balance_after, l.kind, l.session_id, l.created_at
         from wallet_ledger l where l.customer_id = p_id order by l.id desc limit 50) x), '[]'::jsonb));
end $$;
revoke all on function public.customer_wallet(text, text) from public;
grant execute on function public.customer_wallet(text, text) to anon, authenticated;

-- The rider pays their own bookings: all of them or none. Not a waitlisted place (nothing is held yet,
-- and the desk takes no money for one), not a night gone by, not a company's night, not a race.
create or replace function public.customer_wallet_pay(p_id text, p_token text, p_booking_ids text[])
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; bid text; total numeric := 0; paid_ids text[] := '{}'; amt numeric; s sessions%rowtype;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if coalesce(array_length(p_booking_ids, 1), 0) = 0 or array_length(p_booking_ids, 1) > 20 then
    raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001';
  end if;
  foreach bid in array (select array_agg(x order by x) from unnest(p_booking_ids) x) loop
    select * into q from queue_entries where id = bid and customer_id = p_id for update;
    if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if coalesce(q.paid, false) then continue; end if;
    select * into s from sessions where id = q.session_id;
    if coalesce(q.status, '') not in ('waiting', 'active') then raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001'; end if;
    if coalesce(s.ride_kind, '') = 'petromin' then raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001'; end if;
    if left(coalesce(s.session_date, q.session_id, ''), 10) < to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD') then
      raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001';
    end if;
    amt := _wallet_amount(q.price, q.addons);
    if _wallet_pay_row(q, amt) then total := total + amt; paid_ids := array_append(paid_ids, bid); end if;
  end loop;
  return jsonb_build_object('ok', true, 'paid', to_jsonb(paid_ids), 'amount', total,
    'balance', coalesce((select balance from wallet_balances where customer_id = p_id), 0));
end $$;
revoke all on function public.customer_wallet_pay(text, text, text[]) from public;
grant execute on function public.customer_wallet_pay(text, text, text[]) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261102210000', 'customer_wallet')
on conflict (version) do nothing;

commit;
