-- Money controls (2026-10-09, staff app research items M1-M5, M23, B2, B3).
--
-- What the page gets from this file (every part is optional for the page: it detects a missing
-- column, table or function and keeps working the old way until this is applied):
--
--  1. _staff_mod(module, edit): true for an admin, or a staff account whose section list
--     (staff.modules_view / modules_edit) is unset (= everything its role allows) or names the
--     section. The policies below ask it for 'cashier'.
--  2. staff_people(): every staff account's id, the name it goes by (display name, else email),
--     its email and role, for any staff member: the Action Log, the audit trail and the Team
--     report print a person, not a uuid. audit_log already shows every staff member actor_email.
--  3. staff_actions gains kind, entity, entity_id, amount: what a log line was about (a check-in
--     of booking X, a refund of receipt Y for SAR 40), so the Action Log can open the record and
--     the Team report can count per person. Old rows keep nulls. Indexes for the record lookup
--     and the per-person count.
--  4. audit_log: an index per table and time (the Audit search), and bikes join the audited
--     tables (update of the columns staff change by hand, and delete). The trigger function is
--     the existing _audit_row (20260928200000), untouched.
--  5. cashier_sales gains sold_by (uuid, the signed-in account, stamped by the table) and
--     sold_by_name (the operator name the device was on). A client cannot set sold_by to
--     someone else: the trigger overwrites it on insert and keeps it on update.
--  6. receipt_numbers: one sequential number per receipt (ZATCA wants a sequential invoice
--     number), given by the table when a receipt's first line is inserted. Staff read it.
--     Gaps are only possible on a concurrent first insert of one receipt from two devices,
--     which the page never does.
--  7. till_sessions + till_counts: a till opened with a float, counted during the shift,
--     closed with expected vs counted cash and the card terminal total. session_id null is a
--     shop day (no ride). Staff with the Sales section may read; with Sales editing rights may
--     open, count and close; admins only delete. Closing is final for non-admins (a closed till
--     cannot be updated except by an admin). One open till per context (ride or shop) per day.
--     Who opened / counted / closed is stamped by the table. Updates and deletes are audited.
--
-- Rollback (in this order):
--   drop table if exists public.till_counts; drop table if exists public.till_sessions;
--   drop function if exists public._till_stamp(); drop function if exists public._till_count_stamp();
--   drop trigger if exists cashier_sales_receipt_no on public.cashier_sales;
--   drop function if exists public._receipt_no_issue();
--   drop table if exists public.receipt_numbers; drop sequence if exists public.receipt_no_seq;
--   drop trigger if exists cashier_sales_seller on public.cashier_sales;
--   drop function if exists public._cashier_sales_seller();
--   alter table public.cashier_sales drop column if exists sold_by, drop column if exists sold_by_name;
--   drop trigger if exists bikes_audit_upd on public.bikes; drop trigger if exists bikes_audit_del on public.bikes;
--   drop index if exists public.audit_log_tbl_at_idx;
--   drop index if exists public.staff_actions_entity_idx, public.staff_actions_user_at_idx;
--   alter table public.staff_actions drop column if exists kind, drop column if exists entity,
--     drop column if exists entity_id, drop column if exists amount;
--   drop function if exists public.staff_people(); drop function if exists public._staff_mod(text, boolean);
--
-- Run supabase/checks/security-attributes.sql after applying. Idempotent.

begin;

-- ── 1. Section rights ─────────────────────────────────────────────────────────────────────────
create or replace function public._staff_mod(p_mod text, p_edit boolean default false)
returns boolean
language sql stable security definer set search_path to 'public'
as $fn$
  select exists(
    select 1 from staff s
     where s.user_id = auth.uid()
       and (s.role = 'admin'
            or (case when p_edit then s.modules_edit else s.modules_view end) is null
            or p_mod = any(case when p_edit then s.modules_edit else s.modules_view end)))
$fn$;
revoke all on function public._staff_mod(text, boolean) from public, anon;
grant execute on function public._staff_mod(text, boolean) to authenticated;

-- ── 2. Who is who ─────────────────────────────────────────────────────────────────────────────
create or replace function public.staff_people()
returns table(user_id uuid, name text, email text, role text)
language plpgsql stable security definer set search_path to 'public', 'auth'
as $fn$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return query
    select s.user_id, coalesce(nullif(trim(s.display_name), ''), u.email::text), u.email::text, s.role
      from staff s left join auth.users u on u.id = s.user_id
     order by 2;
end $fn$;
revoke all on function public.staff_people() from public, anon;
grant execute on function public.staff_people() to authenticated;

-- ── 3. What a log line was about ──────────────────────────────────────────────────────────────
alter table public.staff_actions add column if not exists kind text;
alter table public.staff_actions add column if not exists entity text;
alter table public.staff_actions add column if not exists entity_id text;
alter table public.staff_actions add column if not exists amount numeric(12,2);
do $$ begin
  alter table public.staff_actions add constraint staff_actions_kind_len check (kind is null or length(kind) <= 24);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.staff_actions add constraint staff_actions_entity_len check ((entity is null or length(entity) <= 24) and (entity_id is null or length(entity_id) <= 200));
exception when duplicate_object then null; end $$;
create index if not exists staff_actions_entity_idx  on public.staff_actions (entity, entity_id);
create index if not exists staff_actions_user_at_idx on public.staff_actions (user_id, at_server desc);

-- ── 4. Audit trail: search index, bikes audited ───────────────────────────────────────────────
create index if not exists audit_log_tbl_at_idx on public.audit_log (tbl, at desc);

drop trigger if exists bikes_audit_upd on public.bikes;
create trigger bikes_audit_upd
  after update of name, status, type, size, rental_price, location, condition, notes, retired_date,
                  last_serviced_at, bike_number, tag_uid, serial_number on public.bikes
  for each row execute function public._audit_row();
drop trigger if exists bikes_audit_del on public.bikes;
create trigger bikes_audit_del after delete on public.bikes
  for each row execute function public._audit_row();

-- ── 5. The seller on every sale line ──────────────────────────────────────────────────────────
alter table public.cashier_sales add column if not exists sold_by uuid;
alter table public.cashier_sales alter column sold_by set default auth.uid();
alter table public.cashier_sales add column if not exists sold_by_name text;
do $$ begin
  alter table public.cashier_sales add constraint cashier_sales_sold_by_name_len check (sold_by_name is null or length(sold_by_name) <= 60);
exception when duplicate_object then null; end $$;
create index if not exists cashier_sales_sold_by_idx on public.cashier_sales (sold_by);

create or replace function public._cashier_sales_seller()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  if tg_op = 'INSERT' then
    new.sold_by := coalesce(auth.uid(), new.sold_by);
  else
    new.sold_by := old.sold_by;
    new.sold_by_name := coalesce(old.sold_by_name, new.sold_by_name);
  end if;
  return new;
end $fn$;
revoke all on function public._cashier_sales_seller() from public, anon, authenticated;
drop trigger if exists cashier_sales_seller on public.cashier_sales;
create trigger cashier_sales_seller before insert or update on public.cashier_sales
  for each row execute function public._cashier_sales_seller();

-- ── 6. Sequential receipt numbers ─────────────────────────────────────────────────────────────
create sequence if not exists public.receipt_no_seq;
create table if not exists public.receipt_numbers (
  receipt_id text primary key,
  no         bigint not null unique default nextval('public.receipt_no_seq'),
  issued_at  timestamptz not null default now()
);
alter sequence public.receipt_no_seq owned by public.receipt_numbers.no;
alter table public.receipt_numbers enable row level security;
drop policy if exists "receipt_numbers staff read" on public.receipt_numbers;
create policy "receipt_numbers staff read" on public.receipt_numbers
  for select to authenticated using ((select public.is_staff()));
revoke all on public.receipt_numbers from anon, authenticated;
revoke all on sequence public.receipt_no_seq from anon, authenticated;
grant select on public.receipt_numbers to authenticated;

-- Definer: nobody writes receipt_numbers through the API. The existence check first, so a
-- receipt's second, third... line takes no number from the sequence (no gaps).
create or replace function public._receipt_no_issue()
returns trigger
language plpgsql security definer set search_path to 'public'
as $fn$
declare k text := coalesce(new.receipt_id, new.id);
begin
  if k is not null and not exists (select 1 from receipt_numbers where receipt_id = k) then
    insert into receipt_numbers (receipt_id) values (k) on conflict (receipt_id) do nothing;
  end if;
  return null;
end $fn$;
revoke all on function public._receipt_no_issue() from public, anon, authenticated;
drop trigger if exists cashier_sales_receipt_no on public.cashier_sales;
create trigger cashier_sales_receipt_no after insert on public.cashier_sales
  for each row execute function public._receipt_no_issue();

-- Receipts made before this file: numbered in the order they were made.
insert into public.receipt_numbers (receipt_id)
select k
  from (select coalesce(receipt_id, id) k, created_at from public.cashier_sales) s
 where not exists (select 1 from public.receipt_numbers r where r.receipt_id = s.k)
 group by k
 order by min(created_at);

-- ── 7. Till sessions and counts ───────────────────────────────────────────────────────────────
create table if not exists public.till_sessions (
  id                  uuid primary key default gen_random_uuid(),
  day                 date not null default ((now() at time zone 'Asia/Riyadh')::date),
  session_id          text references public.sessions(id) on delete set null,  -- null: a shop day, no ride
  opened_at           timestamptz not null default now(),
  opened_by           uuid,
  opened_by_name      text check (opened_by_name is null or length(opened_by_name) <= 60),
  float               numeric(10,2) not null default 0 check (float >= 0 and float <= 100000),
  closed_at           timestamptz,
  closed_by           uuid,
  closed_by_name      text check (closed_by_name is null or length(closed_by_name) <= 60),
  expected_cash       numeric(10,2),
  counted_cash        numeric(10,2) check (counted_cash is null or (counted_cash >= 0 and counted_cash <= 1000000)),
  card_expected       numeric(10,2),
  card_terminal_total numeric(10,2) check (card_terminal_total is null or (card_terminal_total >= 0 and card_terminal_total <= 1000000)),
  notes               text not null default '' check (length(notes) <= 500)
);
create index if not exists till_sessions_day_idx on public.till_sessions (day desc);
create unique index if not exists till_sessions_one_open on public.till_sessions (day, (coalesce(session_id, ''))) where closed_at is null;

create table if not exists public.till_counts (
  id              bigint generated always as identity primary key,
  till_id         uuid not null references public.till_sessions(id) on delete cascade,
  at              timestamptz not null default now(),
  counted_by      uuid,
  counted_by_name text check (counted_by_name is null or length(counted_by_name) <= 60),
  counted_cash    numeric(10,2) not null check (counted_cash >= 0 and counted_cash <= 1000000),
  expected_cash   numeric(10,2),
  note            text not null default '' check (length(note) <= 300)
);
create index if not exists till_counts_till_idx on public.till_counts (till_id, at);

-- Who opened, counted and closed is the signed-in account, whatever the request says.
create or replace function public._till_stamp()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  if tg_op = 'INSERT' then
    new.opened_by := coalesce(auth.uid(), new.opened_by);
    new.opened_at := now();
    new.closed_at := null; new.closed_by := null;
  else
    new.opened_by := old.opened_by; new.opened_at := old.opened_at;
    if new.closed_at is not null and old.closed_at is null then
      new.closed_at := now();
      new.closed_by := coalesce(auth.uid(), new.closed_by);
    elsif old.closed_at is not null then
      new.closed_at := old.closed_at; new.closed_by := old.closed_by;
    end if;
  end if;
  return new;
end $fn$;
revoke all on function public._till_stamp() from public, anon, authenticated;
drop trigger if exists till_sessions_stamp on public.till_sessions;
create trigger till_sessions_stamp before insert or update on public.till_sessions
  for each row execute function public._till_stamp();

create or replace function public._till_count_stamp()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  new.counted_by := coalesce(auth.uid(), new.counted_by);
  new.at := now();
  return new;
end $fn$;
revoke all on function public._till_count_stamp() from public, anon, authenticated;
drop trigger if exists till_counts_stamp on public.till_counts;
create trigger till_counts_stamp before insert on public.till_counts
  for each row execute function public._till_count_stamp();

drop trigger if exists till_sessions_audit on public.till_sessions;
create trigger till_sessions_audit after update or delete on public.till_sessions
  for each row execute function public._audit_row();

alter table public.till_sessions enable row level security;
alter table public.till_counts enable row level security;
revoke all on public.till_sessions from anon, authenticated;
revoke all on public.till_counts from anon, authenticated;
grant select, insert, update, delete on public.till_sessions to authenticated;
grant select, insert, delete on public.till_counts to authenticated;

drop policy if exists "till read" on public.till_sessions;
create policy "till read" on public.till_sessions
  for select to authenticated using ((select public._staff_mod('cashier', false)));
drop policy if exists "till open" on public.till_sessions;
create policy "till open" on public.till_sessions
  for insert to authenticated with check ((select public._staff_mod('cashier', true)));
drop policy if exists "till change" on public.till_sessions;
create policy "till change" on public.till_sessions
  for update to authenticated
  using ((select public._staff_mod('cashier', true)) and (closed_at is null or (select public.is_admin())))
  with check ((select public._staff_mod('cashier', true)));
drop policy if exists "till delete" on public.till_sessions;
create policy "till delete" on public.till_sessions
  for delete to authenticated using ((select public.is_admin()));

drop policy if exists "till counts read" on public.till_counts;
create policy "till counts read" on public.till_counts
  for select to authenticated using ((select public._staff_mod('cashier', false)));
drop policy if exists "till counts add" on public.till_counts;
create policy "till counts add" on public.till_counts
  for insert to authenticated with check (
    (select public._staff_mod('cashier', true))
    and exists (select 1 from public.till_sessions ts where ts.id = till_id and ts.closed_at is null));
drop policy if exists "till counts delete" on public.till_counts;
create policy "till counts delete" on public.till_counts
  for delete to authenticated using ((select public.is_admin()));


insert into supabase_migrations.schema_migrations (version, name)
values ('20261009150000', 'money_controls') on conflict (version) do nothing;
commit;
