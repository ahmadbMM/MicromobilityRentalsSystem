-- ============================================================================
-- People, second review (2026-11-06, PP14 and OT09).
--
--  1. customer_contacts: one row each time a staffer opens a WhatsApp chat with an account from the staff screens
--     ("Messaged 3 days ago by Huda", the "Not messaged in 30 days" filter, the line in a message run). Staff-only
--     under RLS: staff read and add, an admin deletes. The database stamps who and when (_customer_contacts_stamp),
--     whatever the page sent.
--  2. Wallet fees (OT09): a late cancel or a no-show can cost a set amount from the rider's wallet, never a card.
--     The amounts and the switch are Settings > Business keys in staff_options 'biz' (late_fee_on, late_fee_cancel,
--     late_fee_noshow, late_fee_hours); the switch starts off. Nothing is taken by itself: an admin charges one booking
--     from the account window (staff_wallet_fee), with the PIN, and gives it back the same way (p_waive). Ledger kinds
--     'fee' and 'fee_back'. Takes what the balance holds, up to the amount; refuses an empty wallet (WALLET_SHORT).
--     A race's money is the organiser's (WALLET_RACE). staff_wallet_fees(p_customer) says what each booking holds.
--     No-show strikes (OT03) need nothing here: Settings keys ns_strikes_on / _n / _days, counted on the page.
--
-- Safe before or after the app: until this runs the page draws no "last messaged" line and the fee buttons say
-- "Waiting for the database update".
--
-- Rollback (give back any fee first: select booking_id, -sum(amount) from wallet_ledger where kind in ('fee','fee_back')
-- group by 1 having sum(amount) <> 0, then staff_wallet_fee(id, true) for each):
--   drop function if exists public.staff_wallet_fee(text, boolean, text, text);
--   drop function if exists public.staff_wallet_fees(text);
--   drop table if exists public.customer_contacts; drop function if exists public._customer_contacts_stamp();
--   restore wallet_ledger_kind_check without 'fee', 'fee_back' (20261103170000).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. Last contacted ───────────────────────────────────────────────────────────────────────────
create table if not exists public.customer_contacts (
  id           bigint generated always as identity primary key,
  customer_id  text not null check (length(customer_id) between 1 and 80),
  channel      text not null default 'whatsapp' check (channel in ('whatsapp', 'call', 'email')),
  at           timestamptz not null default now(),
  by_user      uuid default auth.uid(),
  by_name      text check (by_name is null or length(by_name) <= 120)
);
create index if not exists customer_contacts_cust on public.customer_contacts (customer_id, at desc);
create index if not exists customer_contacts_at on public.customer_contacts (at desc);
comment on table public.customer_contacts is 'staff-only: when staff opened a chat with an account (20261107121000); never shown to customers';

alter table public.customer_contacts enable row level security;

drop policy if exists "customer contacts staff read" on public.customer_contacts;
create policy "customer contacts staff read" on public.customer_contacts for select to authenticated
  using ((select public.is_staff()));
drop policy if exists "customer contacts staff insert" on public.customer_contacts;
create policy "customer contacts staff insert" on public.customer_contacts for insert to authenticated
  with check ((select public.is_staff()));
drop policy if exists "customer contacts admin delete" on public.customer_contacts;
create policy "customer contacts admin delete" on public.customer_contacts for delete to authenticated
  using ((select public.is_admin()));

revoke all on public.customer_contacts from anon, authenticated;
grant select, insert, delete on public.customer_contacts to authenticated;

create or replace function public._customer_contacts_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  new.at := now();
  new.by_user := auth.uid();
  new.by_name := left(coalesce(
    (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()),
    auth.jwt() ->> 'email',
    'staff'), 120);
  return new;
end $function$;
revoke all on function public._customer_contacts_stamp() from public, anon, authenticated;
drop trigger if exists customer_contacts_stamp on public.customer_contacts;
create trigger customer_contacts_stamp before insert on public.customer_contacts
  for each row execute function public._customer_contacts_stamp();

-- ── 2. Wallet fees ──────────────────────────────────────────────────────────────────────────────
alter table public.wallet_ledger drop constraint if exists wallet_ledger_kind_check;
alter table public.wallet_ledger add constraint wallet_ledger_kind_check
  check (kind in ('topup', 'adjust', 'takeout', 'refund', 'spend', 'return', 'merge_in', 'merge_out', 'unmerge', 'sale', 'sale_back', 'fee', 'fee_back'));

create or replace function public.staff_wallet_fee(p_booking_id text, p_waive boolean default false,
                                                   p_op text default null, p_approval text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare
  q queue_entries%rowtype; biz jsonb; k text; amt numeric; held numeric; who text; b numeric; took numeric;
  hrs int; st_txt text; start_at timestamptz; rk text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;  -- money out of a wallet is an admin's (2026-11-03)
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into q from queue_entries where id = p_booking_id for update;
  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if q.customer_id is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
  select coalesce(-sum(l.amount), 0) into held from wallet_ledger l where l.booking_id = q.id and l.kind in ('fee', 'fee_back');
  perform set_config('mm.wallet_op', coalesce(p_op, ''), true);

  if coalesce(p_waive, false) then
    if held <= 0 then raise exception 'FEE_NONE' using errcode = 'P0001'; end if;
    select _wallet_owner(l.customer_id) into who from wallet_ledger l
     where l.booking_id = q.id and l.kind = 'fee' order by l.id desc limit 1;
    perform set_config('mm.wallet_note', 'waived', true);
    b := _wallet_post(who, held, 'fee_back', null, null, q.id, null, q.session_id);
    perform set_config('mm.wallet_note', '', true);
    return jsonb_build_object('ok', true, 'id', q.id, 'amount', held, 'balance', b, 'waived', true);
  end if;

  if held > 0 then raise exception 'FEE_ALREADY' using errcode = 'P0001'; end if;
  select items into biz from staff_options where key = 'biz';
  if coalesce(biz ->> 'late_fee_on', '') <> 'true' then raise exception 'FEE_OFF' using errcode = 'P0001'; end if;
  select s.ride_kind, _rs_time(s.bike_slots::text) into rk, st_txt from sessions s where s.id = q.session_id;
  if rk in ('vlap', 'arena') then raise exception 'WALLET_RACE' using errcode = 'P0001'; end if;

  if q.status = 'noshow' then
    k := 'noshow';
    amt := case when jsonb_typeof(biz -> 'late_fee_noshow') = 'number' then (biz ->> 'late_fee_noshow')::numeric end;
  elsif q.status = 'cancelled' and q.cancelled_by = 'customer' and q.cancelled_at is not null then
    k := 'late_cancel';
    amt := case when jsonb_typeof(biz -> 'late_fee_cancel') = 'number' then (biz ->> 'late_fee_cancel')::numeric end;
    hrs := case when jsonb_typeof(biz -> 'late_fee_hours') = 'number' then least(greatest((biz ->> 'late_fee_hours')::numeric, 1), 72)::int else 24 end;
    -- the start: the session's date at the first time in its bike_slots (_time), Riyadh; 18:00 when it has none
    st_txt := coalesce(substring(coalesce(st_txt, '') from '(\d{1,2}:\d{2})'), '18:00');
    start_at := (q.session_date::date + st_txt::time) at time zone 'Asia/Riyadh';
    if q.cancelled_at < start_at - make_interval(hours => hrs) then raise exception 'FEE_NOT_LATE' using errcode = 'P0001'; end if;
  else
    raise exception 'FEE_NOT_DUE' using errcode = 'P0001';
  end if;
  if amt is null or amt <= 0 or amt > 1000 then raise exception 'FEE_NO_AMOUNT' using errcode = 'P0001'; end if;

  who := _wallet_owner(q.customer_id);
  select balance into b from wallet_balances where customer_id = who;
  took := least(round(amt, 2), coalesce(b, 0));
  if took <= 0 then raise exception 'WALLET_SHORT' using errcode = 'P0001'; end if;
  perform set_config('mm.wallet_note', k, true);
  b := _wallet_post(who, -took, 'fee', null, null, q.id, null, q.session_id);
  perform set_config('mm.wallet_note', '', true);
  return jsonb_build_object('ok', true, 'id', q.id, 'kind', k, 'amount', took, 'balance', b);
end $$;
revoke all on function public.staff_wallet_fee(text, boolean, text, text) from public, anon;
grant execute on function public.staff_wallet_fee(text, boolean, text, text) to authenticated;

-- What each of an account's bookings holds in fees now (charged less given back), for the account window.
create or replace function public.staff_wallet_fees(p_customer text)
returns table(booking_id text, held numeric)
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return query
    select l.booking_id, -sum(l.amount)
      from wallet_ledger l
     where l.kind in ('fee', 'fee_back')
       and l.booking_id in (select e.id from queue_entries e where e.customer_id = p_customer)
     group by l.booking_id
    having sum(l.amount) <> 0;
end $$;
revoke all on function public.staff_wallet_fees(text) from public, anon;
grant execute on function public.staff_wallet_fees(text) to authenticated;

do $chk$
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'customer_contacts' and c.relrowsecurity) then
    raise exception 'customer_contacts missing or RLS off';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'staff_wallet_fee' and p.prosecdef) then
    raise exception 'staff_wallet_fee missing or not SECURITY DEFINER';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261107121000', 'people_review2')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- Read-only checks after applying:
--   select relrowsecurity from pg_class where relname = 'customer_contacts';                       -- true
--   select polname, polcmd from pg_policy where polrelid = 'public.customer_contacts'::regclass;   -- read, insert, delete
--   select proname, prosecdef, proconfig from pg_proc where proname in ('staff_wallet_fee', 'staff_wallet_fees', '_customer_contacts_stamp');
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'wallet_ledger_kind_check';  -- lists 'fee', 'fee_back'
--   select customer_id, at, by_name from customer_contacts order by id desc limit 10;
--   select booking_id, -sum(amount) from wallet_ledger where kind in ('fee', 'fee_back') group by 1 having sum(amount) <> 0;
