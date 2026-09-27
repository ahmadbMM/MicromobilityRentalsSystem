-- ============================================================================
-- Staff guardrails (2026-09-28): the database keeps the record and holds the line.
--
-- Until now every one of these lived only in the page. A void deleted the sale rows outright; a
-- refund, a price change, a deleted ride or bike was one PostgREST write any staff account could
-- send by hand; the operator PIN (20260925120000) was asked by the page and remembered by the page;
-- the admin-only fields (a ride's capacity, price and kind, a bike's rental price, a customer's
-- perk and hidden types, promo codes) were admin-only because the form said so; and who changed
-- what was known only when the page remembered to write staff_actions. This migration moves each
-- of those into the database, where a hand-made request meets the same answer as the page.
--
--  1. AUDIT. public.audit_log, written by triggers alone: for an UPDATE the columns that changed as
--     {col:{old,new}}, for a DELETE the whole old row. password_hash and session_token are never
--     recorded; updated_at and last_qnum are housekeeping and are left out of the diff. Staff read
--     it; nobody writes it through the API. Attached to cashier_sales, promo_codes, sessions and
--     staff (every update or delete), and to queue_entries, inventory and customers only when the
--     columns that matter change (price, paid, pay_method, card_amount, status, assigned_bike_id,
--     promo_code / price, cost, qty / default_pay, hidden_types, merged_into, email, phone, name).
--     staff_actions gains user_id (default auth.uid()) and at_server (default now()) so a client's
--     line carries the account and the server clock; existing rows keep both null.
--  2. PIN APPROVALS, server-side. staff_pin_approve(p_name, p_pin) checks the PIN through
--     staff_check_operator_pin (its five tries and 60-second lock apply) and hands back a token
--     that holds for five minutes in pin_approvals; a name without a PIN needs no token. _pin_ok
--     (internal) is what the sensitive functions ask: true when the operator name has no PIN on
--     team_members - a device with no operator gate is not held up, as the page decided on
--     2026-09-28 - or when a live token matches (token, the caller's auth.uid(), the op name).
--     A token is reusable until it expires; expired rows are swept on every check.
--  3. SENSITIVE ACTIONS as SECURITY DEFINER functions, each staff-only, PIN-checked (PIN_REQUIRED,
--     42501), returning jsonb {ok:true,...}:
--       staff_void_receipt(p_receipt_id, p_reason, p_op, p_approval)   - SOFT void: voided_at/by/reason
--       staff_refund_receipt(p_receipt_id, p_reason, p_op, p_approval) - pay='refunded' + refunded_at/by/reason
--       staff_set_price(p_booking_id, p_price, p_op, p_approval)        - queue_entries.price, 0..1000
--       staff_delete_session(p_id, p_op, p_approval)                    - admin; refuses live bookings or open sales
--       staff_delete_bike(p_id, p_op, p_approval)                       - admin; refuses in-use, an open or a past hand-over
--     A receipt is every cashier_sales row whose coalesce(receipt_id, id) is the key, as the page
--     groups them. cashier_sales gains voided_at, voided_by, void_reason, refunded_at, refunded_by,
--     refund_reason. The DELETE policy on cashier_sales is admins only from here: voids are soft.
--  4. ADMIN-ONLY COLUMNS enforced by the database. promo_codes: insert/update/delete need is_admin().
--     BEFORE UPDATE triggers raise ADMIN_ONLY (42501) for a non-admin who changes, on sessions:
--     status to 'deleted', capacity, price, paid_ride, ride_kind, event_kind, open_to_all,
--     required_tag_id, needs_approval (status among open/closed/full, bike_slots, title, addons,
--     meet_url and the rest stay staff); on bikes: rental_price; on customers: default_pay,
--     hidden_types. A database session with no JWT at all (the SQL editor, a migration, psql) is
--     not a client and passes: the guard is about what the API accepts. staff_ambassador_set is
--     rebuilt from the live definition (pg_get_functiondef, 2026-09-28; SECURITY DEFINER,
--     search_path public kept) with an is_admin() check after its is_staff() check, answering
--     {ok:false, error:'admin_only'} in its own style.
--  5. BIKE ASSIGNMENTS drift. When queue_entries.assigned_bike_id changes - a single id or a JSON
--     array text like '["a","b"]' - every open bike_assignments row of that booking whose bike is
--     no longer in the new value is closed (returned_at now(), return_condition 'reassigned').
--     The 20260911120000 trigger that closes every open row when a booking leaves 'active' stays
--     exactly as it is and runs first (alphabetical: ..._close_assignments before ..._reassign_close),
--     so a classic return still records 'auto'. The staff UPDATE policy on bike_assignments
--     (20260911120000) is re-stated here so the page's own undo write keeps working.
--  6. TIMESTAMPS the reports were inferring. queue_entries: paid_at (paid false->true),
--     cancelled_at (status -> cancelled), noshow_at (-> noshow), promoted_at (waitlist -> waiting),
--     stamped by a BEFORE UPDATE trigger; a client that sends the stamp itself keeps its value.
--     sessions: cancelled_at, cancel_reason (columns only; the page writes them).
--  7. INDEXES: cashier_sales(created_at), cashier_sales(receipt_id), staff_actions(at desc);
--     queue_entries(session_date) and cashier_sales(session_id) exist already under their old
--     names (idx_queue_session_date, idx_cashier_session) and are re-stated under those names.
--
-- CLIENT CONSEQUENCES (the page changes in the same PR): a front-desk void or refund must call
-- staff_void_receipt / staff_refund_receipt (a direct DELETE on cashier_sales is refused; a direct
-- pay='refunded' UPDATE still works but records nothing); sales lists and totals must skip rows
-- with voided_at set; the page's _pinApprove hands its answer to the functions as p_op/p_approval
-- through staff_pin_approve instead of remembering it; a front-desk write that changes a guarded
-- column is refused with ADMIN_ONLY where before the form merely hid the field. staff_sync's named
-- column lists do not yet carry the new queue_entries timestamps.
--
-- Rollback (in this order):
--   drop trigger if exists queue_entries_stamps on public.queue_entries;
--   drop function if exists public._queue_stamps();
--   drop trigger if exists queue_entries_reassign_close on public.queue_entries;
--   drop function if exists public._close_assignments_on_reassign();
--   drop function if exists public._bike_ids(text);
--   drop trigger if exists customers_admin_cols on public.customers;
--   drop trigger if exists bikes_admin_cols on public.bikes;
--   drop trigger if exists sessions_admin_cols on public.sessions;
--   drop function if exists public._customers_admin_cols(), public._bikes_admin_cols(), public._sessions_admin_cols();
--   re-create staff_ambassador_set from 20260924180000; re-create the promo_codes policies
--     "staff insert"/"staff update" (is_staff) and "staff delete" (is_admin) and drop the "admin *" ones;
--   drop policy if exists "admin delete" on public.cashier_sales;
--     create policy "staff delete" on public.cashier_sales for delete using ((select is_staff()));
--   drop function if exists public.staff_delete_bike(text,text,text), public.staff_delete_session(text,text,text),
--     public.staff_set_price(text,numeric,text,text), public.staff_refund_receipt(text,text,text,text),
--     public.staff_void_receipt(text,text,text,text);
--   drop function if exists public._pin_ok(text,text), public.staff_pin_approve(text,text);
--   drop table if exists public.pin_approvals;
--   drop the *_audit, *_audit_upd, *_audit_del triggers on the seven tables; drop function if exists public._audit_row();
--   drop table if exists public.audit_log;
--   alter table public.staff_actions drop column if exists user_id, drop column if exists at_server;
--   alter table public.cashier_sales drop column if exists voided_at, drop column if exists voided_by,
--     drop column if exists void_reason, drop column if exists refunded_at, drop column if exists refunded_by,
--     drop column if exists refund_reason;
--   alter table public.queue_entries drop column if exists paid_at, drop column if exists cancelled_at,
--     drop column if exists noshow_at, drop column if exists promoted_at;
--   alter table public.sessions drop column if exists cancelled_at, drop column if exists cancel_reason;
--   drop index if exists public.cashier_sales_created_at_idx, public.cashier_sales_receipt_idx, public.staff_actions_at_idx;
-- Run supabase/checks/security-attributes.sql after applying (or rolling back).
-- Idempotent.
-- ============================================================================


-- ── 1. AUDIT ────────────────────────────────────────────────────────────────────────────────

create table if not exists public.audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor       uuid default auth.uid(),
  actor_email text default (auth.jwt() ->> 'email'),
  tbl         text not null,
  row_id      text,
  op          text not null,
  changed     jsonb
);
create index if not exists audit_log_at_idx  on public.audit_log (at desc);
create index if not exists audit_log_row_idx on public.audit_log (tbl, row_id);

alter table public.audit_log enable row level security;
drop policy if exists "audit_log staff read" on public.audit_log;
create policy "audit_log staff read" on public.audit_log
  for select to authenticated using ((select public.is_staff()));
-- Written by triggers only (they run as the owner): no client role inserts, updates or deletes.
revoke all on public.audit_log from anon, authenticated;
revoke all on sequence public.audit_log_id_seq from anon, authenticated;
grant select on public.audit_log to authenticated;

-- One trigger function for every audited table. UPDATE: the columns that changed, {col:{old,new}};
-- DELETE: the whole old row. The two secrets are never written; updated_at and last_qnum are
-- housekeeping (a sync stamp, a counter every booking bumps) and are left out of the diff.
-- Definer: audit_log has no write policy for anyone, so the trigger writes it as the owner.
create or replace function public._audit_row()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
  o jsonb; n jsonb; ch jsonb := '{}'::jsonb; k text;
  hide text[] := array['password_hash', 'session_token', 'updated_at', 'last_qnum'];
begin
  if tg_op = 'DELETE' then
    o := to_jsonb(old) - hide;
    insert into audit_log (tbl, row_id, op, changed)
    values (tg_table_name, coalesce(o ->> 'id', o ->> 'user_id'), 'DELETE', o);
    return null;
  end if;
  o := to_jsonb(old) - hide;
  n := to_jsonb(new) - hide;
  for k in select key from jsonb_each(n) loop
    if n -> k is distinct from o -> k then
      ch := ch || jsonb_build_object(k, jsonb_build_object('old', o -> k, 'new', n -> k));
    end if;
  end loop;
  if ch = '{}'::jsonb then return null; end if;
  insert into audit_log (tbl, row_id, op, changed)
  values (tg_table_name, coalesce(n ->> 'id', n ->> 'user_id'), 'UPDATE', ch);
  return null;
end $$;
revoke all on function public._audit_row() from public, anon, authenticated;

-- Every update or delete.
drop trigger if exists cashier_sales_audit on public.cashier_sales;
create trigger cashier_sales_audit after update or delete on public.cashier_sales
  for each row execute function public._audit_row();
drop trigger if exists promo_codes_audit on public.promo_codes;
create trigger promo_codes_audit after update or delete on public.promo_codes
  for each row execute function public._audit_row();
drop trigger if exists sessions_audit on public.sessions;
create trigger sessions_audit after update or delete on public.sessions
  for each row execute function public._audit_row();
drop trigger if exists staff_audit on public.staff;
create trigger staff_audit after update or delete on public.staff
  for each row execute function public._audit_row();

-- Only when the columns that matter change (a DELETE trigger's WHEN cannot read NEW, so two).
drop trigger if exists queue_entries_audit_upd on public.queue_entries;
create trigger queue_entries_audit_upd
  after update of price, paid, pay_method, card_amount, status, assigned_bike_id, promo_code on public.queue_entries
  for each row
  when (old.price is distinct from new.price or old.paid is distinct from new.paid
        or old.pay_method is distinct from new.pay_method or old.card_amount is distinct from new.card_amount
        or old.status is distinct from new.status or old.assigned_bike_id is distinct from new.assigned_bike_id
        or old.promo_code is distinct from new.promo_code)
  execute function public._audit_row();
drop trigger if exists queue_entries_audit_del on public.queue_entries;
create trigger queue_entries_audit_del after delete on public.queue_entries
  for each row execute function public._audit_row();

drop trigger if exists inventory_audit_upd on public.inventory;
create trigger inventory_audit_upd
  after update of price, cost, qty on public.inventory
  for each row
  when (old.price is distinct from new.price or old.cost is distinct from new.cost or old.qty is distinct from new.qty)
  execute function public._audit_row();
drop trigger if exists inventory_audit_del on public.inventory;
create trigger inventory_audit_del after delete on public.inventory
  for each row execute function public._audit_row();

drop trigger if exists customers_audit_upd on public.customers;
create trigger customers_audit_upd
  after update of default_pay, hidden_types, merged_into, email, phone, name on public.customers
  for each row
  when (old.default_pay is distinct from new.default_pay or old.hidden_types is distinct from new.hidden_types
        or old.merged_into is distinct from new.merged_into or old.email is distinct from new.email
        or old.phone is distinct from new.phone or old.name is distinct from new.name)
  execute function public._audit_row();
drop trigger if exists customers_audit_del on public.customers;
create trigger customers_audit_del after delete on public.customers
  for each row execute function public._audit_row();

-- The page's own action log carries the account and the server clock from here. The defaults
-- are set after the columns exist so the 8,700 existing rows keep null rather than the
-- migration's moment.
alter table public.staff_actions add column if not exists user_id uuid;
alter table public.staff_actions alter column user_id set default auth.uid();
alter table public.staff_actions add column if not exists at_server timestamptz;
alter table public.staff_actions alter column at_server set default now();


-- ── 2. PIN APPROVALS ────────────────────────────────────────────────────────────────────────

create table if not exists public.pin_approvals (
  token      text primary key,
  user_id    uuid not null,
  op_name    text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.pin_approvals enable row level security;
-- No policies: the two functions below are the only readers and writers.
revoke all on public.pin_approvals from anon, authenticated;

-- Ask for approval under an operator's name. {ok:true, required:false, token:null} when the name
-- has no PIN; {ok:true, required:true, token, expires_at} on a right PIN; otherwise
-- staff_check_operator_pin's own answer ({ok:false, reason:'wrong', left} | {ok:false,
-- reason:'locked', seconds}). A call with no PIN at all for a name that has one is a question,
-- not a guess: {ok:false, required:true, reason:'pin_needed'} and no try is spent.
create or replace function public.staff_pin_approve(p_name text, p_pin text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare
  h text; r jsonb; tok text; exp timestamptz;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select pin_hash into h from team_members where name = p_name;
  if h is null then return jsonb_build_object('ok', true, 'required', false, 'token', null); end if;
  if p_pin is null then return jsonb_build_object('ok', false, 'required', true, 'reason', 'pin_needed'); end if;
  r := staff_check_operator_pin(p_name, p_pin);
  if not coalesce((r ->> 'ok')::boolean, false) then return r; end if;
  delete from pin_approvals where expires_at < now();
  tok := encode(gen_random_bytes(24), 'hex');
  exp := now() + interval '5 minutes';
  insert into pin_approvals (token, user_id, op_name, expires_at) values (tok, auth.uid(), p_name, exp);
  return jsonb_build_object('ok', true, 'required', true, 'token', tok, 'expires_at', exp);
end $$;
revoke all on function public.staff_pin_approve(text, text) from public, anon;
grant execute on function public.staff_pin_approve(text, text) to authenticated;

-- Does this call carry the approval its operator needs? True when the name has no PIN on the
-- team list (no name, or a name not on it, included - the page's rule), or when a live token
-- was issued to this account for this name. Internal: only the functions below call it.
create or replace function public._pin_ok(p_op text, p_approval text)
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
begin
  delete from pin_approvals where expires_at < now();
  if not exists (select 1 from team_members where name = p_op and pin_hash is not null) then return true; end if;
  return exists (select 1 from pin_approvals
                  where token = p_approval and user_id = auth.uid() and op_name = p_op and expires_at >= now());
end $$;
revoke all on function public._pin_ok(text, text) from public, anon, authenticated;


-- ── 3. SENSITIVE ACTIONS ────────────────────────────────────────────────────────────────────

alter table public.cashier_sales
  add column if not exists voided_at     timestamptz,
  add column if not exists voided_by     text,
  add column if not exists void_reason   text,
  add column if not exists refunded_at   timestamptz,
  add column if not exists refunded_by   text,
  add column if not exists refund_reason text;

-- Void a receipt: every row of it that is not voided yet is marked, nothing is deleted. Returns
-- the rows' item_id/qty so the page can put the stock back (pay is included: a row already
-- refunded was restocked then).
create or replace function public.staff_void_receipt(p_receipt_id text, p_reason text, p_op text, p_approval text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  n int; items jsonb;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if p_receipt_id is null or not exists (select 1 from cashier_sales where coalesce(receipt_id, id) = p_receipt_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  with u as (
    update cashier_sales
       set voided_at = now(),
           voided_by = left(nullif(btrim(coalesce(p_op, '')), ''), 40),
           void_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 300)
     where coalesce(receipt_id, id) = p_receipt_id and voided_at is null
     returning id, item_id, qty, name, category, pay, price)
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'item_id', item_id, 'qty', qty, 'name', name,
                                               'category', category, 'pay', pay, 'price', price)), '[]'::jsonb)
    into n, items from u;
  return jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'count', n, 'items', items);
end $$;
revoke all on function public.staff_void_receipt(text, text, text, text) from public, anon;
grant execute on function public.staff_void_receipt(text, text, text, text) to authenticated;

-- Refund a receipt: every row not yet refunded or voided goes to pay='refunded' with the stamp
-- and the reason; the receipt stays in the ledger. Returns the rows for restocking.
create or replace function public.staff_refund_receipt(p_receipt_id text, p_reason text, p_op text, p_approval text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  n int; items jsonb;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if p_receipt_id is null or not exists (select 1 from cashier_sales where coalesce(receipt_id, id) = p_receipt_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  with u as (
    update cashier_sales
       set pay = 'refunded',
           refunded_at = now(),
           refunded_by = left(nullif(btrim(coalesce(p_op, '')), ''), 40),
           refund_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 300)
     where coalesce(receipt_id, id) = p_receipt_id
       and refunded_at is null and voided_at is null and pay is distinct from 'refunded'
     returning id, item_id, qty, name, category, price)
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'item_id', item_id, 'qty', qty, 'name', name,
                                               'category', category, 'price', price)), '[]'::jsonb)
    into n, items from u;
  return jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'count', n, 'items', items);
end $$;
revoke all on function public.staff_refund_receipt(text, text, text, text) from public, anon;
grant execute on function public.staff_refund_receipt(text, text, text, text) to authenticated;

-- Set a booking's price (0..1000). The price trigger keeps its say: a free community ride stays 0.
create or replace function public.staff_set_price(p_booking_id text, p_price numeric, p_op text, p_approval text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  q queue_entries%rowtype; np numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if p_price is null or p_price < 0 or p_price > 1000 then raise exception 'PRICE_RANGE' using errcode = '22023'; end if;
  select * into q from queue_entries where id = p_booking_id for update;
  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  update queue_entries set price = p_price where id = p_booking_id returning price into np;
  return jsonb_build_object('ok', true, 'id', p_booking_id, 'old_price', q.price, 'price', np);
end $$;
revoke all on function public.staff_set_price(text, numeric, text, text) from public, anon;
grant execute on function public.staff_set_price(text, numeric, text, text) to authenticated;

-- Delete a ride (status 'deleted', as the page has always done). Admins only. Refused while a
-- booking is waiting, waitlisted or active on it (HAS_BOOKINGS) or a sale on it is neither
-- refunded nor voided (HAS_SALES).
create or replace function public.staff_delete_session(p_id text, p_op text, p_approval text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  s sessions%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into s from sessions where id = p_id for update;
  if s.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if exists (select 1 from queue_entries where session_id = p_id and status in ('waiting', 'waitlist', 'active')) then
    raise exception 'HAS_BOOKINGS' using errcode = '55000';
  end if;
  if exists (select 1 from cashier_sales
              where session_id = p_id and voided_at is null and refunded_at is null and pay is distinct from 'refunded') then
    raise exception 'HAS_SALES' using errcode = '55000';
  end if;
  update sessions set status = 'deleted' where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'status', 'deleted', 'previous_status', s.status);
end $$;
revoke all on function public.staff_delete_session(text, text, text) from public, anon;
grant execute on function public.staff_delete_session(text, text, text) to authenticated;

-- Delete a bike. Admins only. Refused while it is in use (BIKE_IN_USE), while a hand-over is open
-- on it (BIKE_ASSIGNED), and when it has ever been handed out (BIKE_HAS_HISTORY: bike_assignments
-- references bikes with no ON DELETE, so the row cannot go without taking the record with it;
-- retire the bike instead). Returns the row for the page's undo.
create or replace function public.staff_delete_bike(p_id text, p_op text, p_approval text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  b bikes%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into b from bikes where id = p_id for update;
  if b.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if b.status = 'in-use' then raise exception 'BIKE_IN_USE' using errcode = '55000'; end if;
  if exists (select 1 from bike_assignments where bike_id = p_id and returned_at is null) then
    raise exception 'BIKE_ASSIGNED' using errcode = '55000';
  end if;
  if exists (select 1 from bike_assignments where bike_id = p_id) then
    raise exception 'BIKE_HAS_HISTORY' using errcode = '55000';
  end if;
  delete from bikes where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'name', b.name, 'bike', to_jsonb(b));
end $$;
revoke all on function public.staff_delete_bike(text, text, text) from public, anon;
grant execute on function public.staff_delete_bike(text, text, text) to authenticated;

-- Voids are soft now: only an admin removes a sale row outright.
drop policy if exists "staff delete" on public.cashier_sales;
drop policy if exists "admin delete" on public.cashier_sales;
create policy "admin delete" on public.cashier_sales for delete using ((select public.is_admin()));


-- ── 4. ADMIN-ONLY COLUMNS ───────────────────────────────────────────────────────────────────

-- Promo codes: admins write them (the page has only ever shown the form to admins).
drop policy if exists "staff insert" on public.promo_codes;
drop policy if exists "staff update" on public.promo_codes;
drop policy if exists "staff delete" on public.promo_codes;
drop policy if exists "admin insert" on public.promo_codes;
drop policy if exists "admin update" on public.promo_codes;
drop policy if exists "admin delete" on public.promo_codes;
create policy "admin insert" on public.promo_codes for insert with check ((select public.is_admin()));
create policy "admin update" on public.promo_codes for update using ((select public.is_admin())) with check ((select public.is_admin()));
create policy "admin delete" on public.promo_codes for delete using ((select public.is_admin()));

-- The three column guards. Invoker on purpose: they inspect NEW/OLD, and is_admin() does its own
-- privileged read. A session with no JWT claims at all is not an API client (the SQL editor, a
-- migration) and passes; the fill-status and queue-number writers touch none of these columns.
create or replace function public._sessions_admin_cols()
returns trigger
language plpgsql set search_path to 'public', 'pg_temp'
as $$
begin
  if (new.status = 'deleted' and old.status is distinct from 'deleted')
     or new.capacity        is distinct from old.capacity
     or new.price           is distinct from old.price
     or new.paid_ride       is distinct from old.paid_ride
     or new.ride_kind       is distinct from old.ride_kind
     or new.event_kind      is distinct from old.event_kind
     or new.open_to_all     is distinct from old.open_to_all
     or new.required_tag_id is distinct from old.required_tag_id
     or new.needs_approval  is distinct from old.needs_approval then
    if coalesce(current_setting('request.jwt.claims', true), '') <> '' and not is_admin() then
      raise exception 'ADMIN_ONLY' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public._sessions_admin_cols() from public, anon, authenticated;
drop trigger if exists sessions_admin_cols on public.sessions;
create trigger sessions_admin_cols before update on public.sessions
  for each row execute function public._sessions_admin_cols();

create or replace function public._bikes_admin_cols()
returns trigger
language plpgsql set search_path to 'public', 'pg_temp'
as $$
begin
  if new.rental_price is distinct from old.rental_price then
    if coalesce(current_setting('request.jwt.claims', true), '') <> '' and not is_admin() then
      raise exception 'ADMIN_ONLY' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public._bikes_admin_cols() from public, anon, authenticated;
drop trigger if exists bikes_admin_cols on public.bikes;
create trigger bikes_admin_cols before update of rental_price on public.bikes
  for each row execute function public._bikes_admin_cols();

create or replace function public._customers_admin_cols()
returns trigger
language plpgsql set search_path to 'public', 'pg_temp'
as $$
begin
  if new.default_pay is distinct from old.default_pay or new.hidden_types is distinct from old.hidden_types then
    if coalesce(current_setting('request.jwt.claims', true), '') <> '' and not is_admin() then
      raise exception 'ADMIN_ONLY' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public._customers_admin_cols() from public, anon, authenticated;
drop trigger if exists customers_admin_cols on public.customers;
create trigger customers_admin_cols before update of default_pay, hidden_types on public.customers
  for each row execute function public._customers_admin_cols();

-- staff_ambassador_set: live definition (pg_get_functiondef, 2026-09-28) plus the admin check
-- after the staff check. Header kept: SECURITY DEFINER, search_path public.
create or replace function public.staff_ambassador_set(p_id bigint, p_status text, p_code text default null, p_by text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  a ambassadors%rowtype;
  v_code text; v_base text; v_n int := 1;
  v_by text := left(nullif(btrim(coalesce(p_by, '')), ''), 120);
begin
  if not (select is_staff()) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if not (select is_admin()) then return jsonb_build_object('ok', false, 'error', 'admin_only'); end if;
  if p_status not in ('active','paused','rejected','pending') then return jsonb_build_object('ok', false, 'error', 'status'); end if;
  select * into a from ambassadors where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if p_status = 'active' then
    v_code := upper(regexp_replace(coalesce(nullif(btrim(coalesce(p_code, '')), ''), a.code, ''), '[^A-Za-z0-9]', '', 'g'));
    if v_code = '' then
      v_base := left(upper(regexp_replace(split_part(a.name, ' ', 1), '[^A-Za-z]', '', 'g')), 14);
      if length(v_base) < 3 then v_base := 'RIDER'; end if;
      v_code := v_base || '10';
      while exists (select 1 from ambassadors where code = v_code and id <> a.id)
         or exists (select 1 from promo_codes where lower(code) = lower(v_code) and id <> 'amb_' || a.id) loop
        v_n := v_n + 1;
        v_code := v_base || (10 * v_n)::text;
      end loop;
    end if;
    if v_code !~ '^[A-Z0-9]{3,20}$' then return jsonb_build_object('ok', false, 'error', 'code'); end if;
    if exists (select 1 from ambassadors where code = v_code and id <> a.id)
       or exists (select 1 from promo_codes where lower(code) = lower(v_code) and id <> 'amb_' || a.id) then
      return jsonb_build_object('ok', false, 'error', 'code_taken');
    end if;
    update ambassadors set status = 'active', code = v_code, decided_at = coalesce(decided_at, now()), updated_by = v_by where id = a.id;
    insert into promo_codes(id, code, kind, value, active, created_at)
    values ('amb_' || a.id, v_code, 'percent', greatest(0, least(100, _site_num('ambassadors.rules.discount', 10))), true,
            to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    on conflict (id) do update set code = excluded.code, value = excluded.value, active = true;
  else
    update ambassadors set status = p_status, decided_at = case when p_status = 'pending' then null else now() end, updated_by = v_by where id = a.id;
    update promo_codes set active = false where id = 'amb_' || a.id;
  end if;
  return jsonb_build_object('ok', true, 'code', (select code from ambassadors where id = a.id),
    'discount', (select value from promo_codes where id = 'amb_' || a.id));
end $function$;
revoke all on function public.staff_ambassador_set(bigint, text, text, text) from public, anon;
grant execute on function public.staff_ambassador_set(bigint, text, text, text) to authenticated;


-- ── 5. BIKE ASSIGNMENTS DRIFT ───────────────────────────────────────────────────────────────

-- assigned_bike_id as a set: null or blank is none, '[...]' is a JSON array of ids, anything else
-- one id. Malformed JSON is treated as one id rather than raising inside a trigger.
create or replace function public._bike_ids(p text)
returns text[]
language plpgsql immutable set search_path to 'public', 'pg_temp'
as $$
begin
  if p is null or btrim(p) = '' then return '{}'::text[]; end if;
  if left(btrim(p), 1) = '[' then
    begin
      return coalesce((select array_agg(x) from jsonb_array_elements_text(btrim(p)::jsonb) as t(x)), '{}'::text[]);
    exception when others then
      return array[p];
    end;
  end if;
  return array[p];
end $$;
revoke all on function public._bike_ids(text) from public, anon, authenticated;

-- When the bikes on a booking change, an open hand-over of a bike no longer on it is closed as
-- 'reassigned'. Definer like _close_assignments_on_leave_active: the change may come from a path
-- with no bike_assignments rights of its own.
create or replace function public._close_assignments_on_reassign()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  update public.bike_assignments
     set returned_at = now(),
         returned_by = coalesce(returned_by, auth.uid()),
         return_condition = coalesce(return_condition, 'reassigned')
   where booking_id = new.id and returned_at is null
     and not (bike_id = any (_bike_ids(new.assigned_bike_id)));
  return null;
end $$;
revoke all on function public._close_assignments_on_reassign() from public, anon, authenticated;
drop trigger if exists queue_entries_reassign_close on public.queue_entries;
create trigger queue_entries_reassign_close
  after update of assigned_bike_id on public.queue_entries
  for each row when (old.assigned_bike_id is distinct from new.assigned_bike_id)
  execute function public._close_assignments_on_reassign();

-- Staff may update hand-over rows (the page's undo closes one by hand). Same as 20260911120000.
drop policy if exists "staff update" on public.bike_assignments;
create policy "staff update" on public.bike_assignments
  for update using ((select public.is_staff())) with check ((select public.is_staff()));


-- ── 6. TIMESTAMPS ───────────────────────────────────────────────────────────────────────────

alter table public.queue_entries
  add column if not exists paid_at      timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists noshow_at    timestamptz,
  add column if not exists promoted_at  timestamptz;
alter table public.sessions
  add column if not exists cancelled_at  timestamptz,
  add column if not exists cancel_reason text;

-- Invoker on purpose: it only stamps NEW. A client that sets the stamp itself in the same write
-- keeps its value; otherwise the transition is stamped with the server clock.
create or replace function public._queue_stamps()
returns trigger
language plpgsql set search_path to 'public', 'pg_temp'
as $$
begin
  if not coalesce(old.paid, false) and coalesce(new.paid, false) then
    new.paid_at := case when new.paid_at is distinct from old.paid_at then new.paid_at else now() end;
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    new.cancelled_at := case when new.cancelled_at is distinct from old.cancelled_at then new.cancelled_at else now() end;
  end if;
  if new.status = 'noshow' and old.status is distinct from 'noshow' then
    new.noshow_at := case when new.noshow_at is distinct from old.noshow_at then new.noshow_at else now() end;
  end if;
  if old.status = 'waitlist' and new.status = 'waiting' then
    new.promoted_at := case when new.promoted_at is distinct from old.promoted_at then new.promoted_at else now() end;
  end if;
  return new;
end $$;
revoke all on function public._queue_stamps() from public, anon, authenticated;
drop trigger if exists queue_entries_stamps on public.queue_entries;
create trigger queue_entries_stamps before update of paid, status on public.queue_entries
  for each row execute function public._queue_stamps();


-- ── 7. INDEXES ──────────────────────────────────────────────────────────────────────────────

create index if not exists idx_queue_session_date        on public.queue_entries (session_date);   -- exists under this name
create index if not exists idx_cashier_session           on public.cashier_sales (session_id);     -- exists under this name
create index if not exists cashier_sales_created_at_idx  on public.cashier_sales (created_at);
create index if not exists cashier_sales_receipt_idx     on public.cashier_sales (receipt_id);
create index if not exists staff_actions_at_idx          on public.staff_actions (at desc);
