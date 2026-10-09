-- ============================================================================
-- The self-service kiosk and the deposit ledger (2026-10-09, staff app round 2, builder R8).
--
--  1. queue_entries.via: how a booking came in, when it is worth saying. 'kiosk' = a walk-in
--     registered themselves on a desk tablet in kiosk mode (Settings > This device). The kiosk
--     is a signed-in staff device: it writes through the staff session exactly as the desk's
--     walk-in does (customer_signup for a new account, a staff insert into queue_entries), so no
--     new anonymous endpoint is opened. The roster shows a "Kiosk" badge and the bell a line.
--     staff_sync returns whole rows (to_jsonb(q)), so the column reaches every staff device with
--     no change there. The page sends the column only on a kiosk row and drops it when the
--     database answers that it has no such column (before this migration).
--  2. deposits: a deposit taken at check-in for a premium bike (Settings > Business: the types
--     that need one and how much), with how it was taken (card hold, cash, an ID document left)
--     and a reference, and when and by whom it was handed back or how much was kept and why.
--     No payment gateway: this is a ledger of what the desk holds. A cash deposit is not revenue
--     (it never touches queue_entries.price/paid or cashier_sales) but sits in the drawer's
--     expected cash while held (the till adds it apart from the takings).
--     Who took and returned it is the signed-in account, stamped here whatever the request says;
--     what was taken (booking, amount, method) cannot change after; a returned deposit cannot be
--     taken back into "held" except by an admin. One held deposit per booking.
--     Staff with Bookings or Sales rights read; Bookings or Sales edit rights take and return;
--     admins delete. Changes and deletes go to the audit trail (_audit_row).
--
-- Rollback:
--   drop table if exists public.deposits;  drop function if exists public._deposit_stamp();
--   alter table public.queue_entries drop constraint if exists queue_entries_via_check;
--   alter table public.queue_entries drop column if exists via;
-- Run supabase/checks/security-attributes.sql after applying. Idempotent.
-- ============================================================================

begin;

-- ── 1. queue_entries.via ───────────────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists via text;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'queue_entries_via_check') then
    alter table public.queue_entries add constraint queue_entries_via_check
      check (via is null or via in ('kiosk'));
  end if;
end $c$;

-- ── 2. deposits ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.deposits (
  id                uuid primary key default gen_random_uuid(),
  booking_id        text not null,
  bike_id           text,
  session_id        text,
  day               date not null default ((now() at time zone 'Asia/Riyadh')::date),
  customer_name     text check (customer_name is null or length(customer_name) <= 120),
  amount            numeric(10,2) not null check (amount > 0 and amount <= 100000),
  method            text not null check (method in ('card_hold', 'cash', 'id_document')),
  ref               text not null default '' check (length(ref) <= 120),
  taken_at          timestamptz not null default now(),
  taken_by          uuid,
  taken_by_name     text check (taken_by_name is null or length(taken_by_name) <= 60),
  returned_at       timestamptz,
  returned_by       uuid,
  returned_by_name  text check (returned_by_name is null or length(returned_by_name) <= 60),
  kept_amount       numeric(10,2) not null default 0,
  kept_reason       text not null default '' check (length(kept_reason) <= 300),
  constraint deposits_kept_range check (kept_amount >= 0 and kept_amount <= amount),
  constraint deposits_kept_when_returned check (returned_at is not null or kept_amount = 0),
  constraint deposits_kept_why check (kept_amount = 0 or length(btrim(kept_reason)) > 0)
);
create index if not exists deposits_booking_idx on public.deposits (booking_id);
create index if not exists deposits_day_idx on public.deposits (day desc);
create index if not exists deposits_held_idx on public.deposits (taken_at) where returned_at is null;
create unique index if not exists deposits_one_held on public.deposits (booking_id) where returned_at is null;

create or replace function public._deposit_stamp()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  if tg_op = 'INSERT' then
    new.taken_by := coalesce(auth.uid(), new.taken_by);
    new.taken_at := now();
    new.returned_at := null; new.returned_by := null; new.returned_by_name := null;
    new.kept_amount := 0; new.kept_reason := '';
    return new;
  end if;
  /* what was taken stays as taken */
  new.booking_id := old.booking_id; new.amount := old.amount; new.method := old.method;
  new.taken_at := old.taken_at; new.taken_by := old.taken_by; new.taken_by_name := old.taken_by_name;
  if new.returned_at is not null and old.returned_at is null then
    new.returned_at := now();
    new.returned_by := coalesce(auth.uid(), new.returned_by);
  elsif old.returned_at is not null and not (select public.is_admin()) then
    /* settled: only an admin may change how */
    new.returned_at := old.returned_at; new.returned_by := old.returned_by; new.returned_by_name := old.returned_by_name;
    new.kept_amount := old.kept_amount; new.kept_reason := old.kept_reason;
  end if;
  return new;
end $fn$;
revoke all on function public._deposit_stamp() from public, anon, authenticated;
drop trigger if exists deposits_stamp on public.deposits;
create trigger deposits_stamp before insert or update on public.deposits
  for each row execute function public._deposit_stamp();

drop trigger if exists deposits_audit on public.deposits;
create trigger deposits_audit after update or delete on public.deposits
  for each row execute function public._audit_row();

alter table public.deposits enable row level security;
revoke all on public.deposits from anon, authenticated;
grant select, insert, update, delete on public.deposits to authenticated;

drop policy if exists "deposits read" on public.deposits;
create policy "deposits read" on public.deposits
  for select to authenticated
  using ((select public._staff_mod('queue', false)) or (select public._staff_mod('cashier', false)));
drop policy if exists "deposits take" on public.deposits;
create policy "deposits take" on public.deposits
  for insert to authenticated
  with check ((select public._staff_mod('queue', true)) or (select public._staff_mod('cashier', true)));
drop policy if exists "deposits settle" on public.deposits;
create policy "deposits settle" on public.deposits
  for update to authenticated
  using ((select public._staff_mod('queue', true)) or (select public._staff_mod('cashier', true)))
  with check ((select public._staff_mod('queue', true)) or (select public._staff_mod('cashier', true)));
drop policy if exists "deposits delete" on public.deposits;
create policy "deposits delete" on public.deposits
  for delete to authenticated using ((select public.is_admin()));

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009230000', 'kiosk_and_deposits') on conflict (version) do nothing;
commit;
