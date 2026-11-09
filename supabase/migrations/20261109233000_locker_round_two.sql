-- ============================================================================
-- Lockers, round two (the owner, 2026-11-09: customer side 1-7, staff side 1-6), 2026-11-09.
--
-- Rider: a name on each locker reserved for someone else (customer_locker_book p_names); change the locker or the
--   time before the key is handed, instead of removing it (customer_locker_change); customer_lockers says each
--   locker's name. The show-at-desk QR, staying signed in, the ride ticket / Wallet pass line, the account page and
--   the locker terms are the pages' (the terms: no food or open drinks, nothing hazardous, illegal or a weapon,
--   nothing left overnight; things left are kept 14 days - the owner's answers).
-- Staff: the end-of-night sweep (staff_locker_sweep: every locker of that evening reserved and never collected is
--   freed, a wallet payment refunded - the owner's answer); items left behind (locker_items: a note, a photo, kept
--   until 14 days after the evening, then collected or disposed of); the maintenance log (locker_events: added,
--   out of service with its reason, back, retired, a note changed, written by a trigger on lockers).
-- _lk_wallet_sale now names each receipt afresh (lk-<random>): a change of time writes a second receipt after the
--   first is voided, and the id was the rental's.
--
-- Rollback: drop table locker_items, locker_events; drop function staff_locker_sweep, customer_locker_change,
--   _lk_unit_log, _lk_items_fill; restore customer_locker_book (six arguments), customer_lockers and _lk_wallet_sale
--   from 20261109220000_locker_page.sql.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── A wallet payment: its own receipt, named afresh each time ───────────────────────────────
create or replace function public._lk_wallet_sale(p_rental uuid)
returns text
language plpgsql volatile security definer set search_path to 'public'
as $$
declare r locker_rentals%rowtype; rid text; at text; code text;
begin
  select * into r from locker_rentals where id = p_rental;
  if r.id is null or r.customer_id is null or coalesce(r.price, 0) <= 0 then raise exception 'WALLET_NOT_OPEN' using errcode = 'P0001'; end if;
  if r.receipt_id is not null then return r.receipt_id; end if;
  rid := 'lk-' || replace(gen_random_uuid()::text, '-', '');
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

-- ── 1. A name on each locker ────────────────────────────────────────────────────────────────
-- As 20261109220000, and p_names: a name for each locker in p_codes' order (someone else's locker, for the
-- desk to know whose key it is). An empty or missing one is the account's name.
drop function if exists public.customer_locker_book(text, text, date, text, text[], text);
create or replace function public.customer_locker_book(p_id text, p_token text, p_day date, p_period text,
                                                       p_codes text[], p_pay text, p_names text[] default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare ev record; codes text[]; names text[]; c text; n int; i int; held int; lk lockers%rowtype; rid uuid; fee numeric;
        nm text; who text; outv jsonb := '[]'::jsonb;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if p_pay is null or p_pay not in ('desk', 'wallet') then raise exception 'LOCKER_PAY' using errcode = 'P0001'; end if;
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
end $$;
revoke execute on function public.customer_locker_book(text, text, date, text, text[], text, text[]) from public, anon;
grant execute on function public.customer_locker_book(text, text, date, text, text[], text, text[]) to anon, authenticated;

-- customer_lockers says each locker's name too.
create or replace function public.customer_lockers(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'booking_id', r.booking_id, 'day', r.day, 'period', r.period,
                                        'status', r.status, 'price', r.price, 'on_bill', r.on_bill, 'pay', r.pay,
                                        'paid', r.receipt_id is not null, 'code', l.code, 'name', r.name) order by r.day, r.created_at)
      from locker_rentals r
      left join queue_entries q on q.id = r.booking_id
      left join lockers l on l.id = r.locker_id
     where r.status <> 'cancelled'
       and r.day >= (now() at time zone 'Asia/Riyadh')::date - 1
       and ((r.booking_id is not null and q.customer_id = p_id) or (r.booking_id is null and r.customer_id = p_id))), '[]'::jsonb);
end $$;
revoke execute on function public.customer_lockers(text, text) from public, anon;
grant execute on function public.customer_lockers(text, text) to anon, authenticated;

-- ── 2. Change the locker or the time, before the key ────────────────────────────────────────
-- The rider's own rental (theirs, or on their booking not yet paid), still reserved: another locker, another time
-- of the same evening, or both. The fee follows the time: on the bill it moves with the line; paid from the wallet,
-- the first receipt is voided (its money back) and a new one taken for the new fee, refused WALLET_SHORT (nothing
-- changes) when the wallet cannot.
create or replace function public.customer_locker_change(p_id text, p_token text, p_rental uuid, p_period text, p_code text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare r locker_rentals%rowtype; q queue_entries%rowtype; k text; c text; lk lockers%rowtype; fee numeric; cap int; s text;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select * into r from locker_rentals where id = p_rental;
  if r.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if r.booking_id is not null then
    select * into q from queue_entries where id = r.booking_id;
    if q.id is null or q.customer_id is distinct from p_id then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  elsif r.customer_id is distinct from p_id then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  perform _lk_lock(r.day);
  select * into r from locker_rentals where id = p_rental for update;
  if r.status <> 'reserved' then raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001'; end if;
  if r.booking_id is not null and coalesce((select e.paid from queue_entries e where e.id = r.booking_id), false) then
    raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001';  -- a paid bill keeps its fee: the desk changes it
  end if;
  k := _lk_kind(r.session_id);
  if not _lk_period_ok(k, p_period) or _lk_ended(r.day, p_period) then raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001'; end if;
  c := _lk_code(p_code);
  select * into lk from lockers where code = c and status <> 'retired';
  if lk.id is null then raise exception 'LOCKER_UNKNOWN: %', c using errcode = 'P0002'; end if;
  if lk.status <> 'available' then raise exception 'LOCKER_OUT: %', c using errcode = 'P0001'; end if;
  if exists (select 1 from locker_rentals x where x.locker_id = lk.id and x.day = r.day and x.id <> r.id
               and x.status in ('reserved', 'in_use') and _lk_slots(x.period) && _lk_slots(p_period)) then
    raise exception 'LOCKER_TAKEN: %', c using errcode = 'P0001';
  end if;
  -- room in each slot the new time adds, this rental aside
  select count(*) into cap from lockers where status = 'available';
  foreach s in array _lk_slots(p_period) loop
    if not (s = any(_lk_slots(r.period)))
       and (select count(*) from locker_rentals x where x.day = r.day and x.id <> r.id
              and x.status in ('reserved', 'in_use') and s = any(_lk_slots(x.period))) >= cap then
      raise exception 'LOCKERS_FULL' using errcode = 'P0001';
    end if;
  end loop;
  fee := _lk_price(p_period);
  if r.receipt_id is not null and fee <> r.price then
    perform _lk_unpay(r.id, 'rider: changed');
    update locker_rentals set receipt_id = null, period = p_period, locker_id = lk.id, price = fee where id = r.id;
    perform _lk_wallet_sale(r.id);
  else
    update locker_rentals set period = p_period, locker_id = lk.id, price = fee where id = r.id;
    if r.receipt_id is not null then  -- the receipt's line says the locker it now is
      update cashier_sales set name = left('Locker ' || lk.code || ' · ' || case p_period when 'early' then '6-8 PM' when 'late' then '9-11 PM'
                                                                                when 'both' then '6-11 PM' else '7-9 PM' end, 120)
       where id = r.receipt_id;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'id', r.id, 'code', lk.code, 'period', p_period, 'price', fee,
                            'paid', (select x.receipt_id is not null from locker_rentals x where x.id = r.id), 'left', _lk_left(r.day));
end $$;
revoke execute on function public.customer_locker_change(text, text, uuid, text, text) from public, anon;
grant execute on function public.customer_locker_change(text, text, uuid, text, text) to anon, authenticated;

-- ── 3. The end of the night ─────────────────────────────────────────────────────────────────
-- Every locker of that evening reserved with no booking and never collected is freed, a wallet payment refunded
-- (the owner's answer). Tonight or an evening gone, never one to come. Says how many, and the lockers still out.
create or replace function public.staff_locker_sweep(p_day date)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare r record; n int := 0; who text;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_day is null or p_day > (now() at time zone 'Asia/Riyadh')::date then
    raise exception 'LOCKER_NOT_OPEN: only tonight or an evening gone' using errcode = 'P0001';
  end if;
  who := _lk_who();
  perform _lk_lock(p_day);
  for r in select id from locker_rentals where day = p_day and status = 'reserved' and booking_id is null for update loop
    update locker_rentals set status = 'cancelled', cancelled_at = now(), cancelled_by = who, cancel_reason = 'not collected'
     where id = r.id;
    perform _lk_unpay(r.id, who);
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'freed', n,
    'out', coalesce((select jsonb_agg(l.code order by (regexp_replace(l.code, '^[A-Z]+', ''))::int)
                       from locker_rentals x join lockers l on l.id = x.locker_id
                      where x.day = p_day and x.status = 'in_use'), '[]'::jsonb));
end $$;
revoke execute on function public.staff_locker_sweep(date) from public, anon;
grant execute on function public.staff_locker_sweep(date) to authenticated;

-- ── 4. Items left behind ────────────────────────────────────────────────────────────────────
-- One record per rental: a note, a photo (a small picture as a data: URL, read only when opened), kept until 14
-- days after the evening (the owner's answer), then collected or disposed of. Staff only.
create table if not exists public.locker_items (
  rental_id   uuid primary key references public.locker_rentals(id) on delete cascade,
  note        text not null default '' check (length(note) <= 500),
  photo       text check (photo is null or (length(photo) <= 1500000 and photo ~ '^data:image/(jpeg|png|webp);base64,')),
  state       text not null default 'kept' check (state in ('kept', 'collected', 'disposed')),
  keep_until  date,
  created_at  timestamptz not null default now(),
  created_by  text check (created_by is null or length(created_by) <= 60),
  updated_at  timestamptz not null default now(),
  updated_by  text check (updated_by is null or length(updated_by) <= 60)
);
alter table public.locker_items enable row level security;
drop policy if exists locker_items_staff_read on public.locker_items;
create policy locker_items_staff_read on public.locker_items for select to authenticated using ((select is_staff()));
drop policy if exists locker_items_staff_ins on public.locker_items;
create policy locker_items_staff_ins on public.locker_items for insert to authenticated with check ((select is_staff()));
drop policy if exists locker_items_staff_upd on public.locker_items;
create policy locker_items_staff_upd on public.locker_items for update to authenticated using ((select is_staff())) with check ((select is_staff()));
revoke all on public.locker_items from anon, authenticated;
grant select, insert, update on public.locker_items to authenticated;

-- who and when, and the date it is kept until, filled by the database whatever the page sends
create or replace function public._lk_items_fill()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now(); new.created_by := _lk_who();
    new.keep_until := coalesce((select r.day from locker_rentals r where r.id = new.rental_id), (now() at time zone 'Asia/Riyadh')::date) + 14;
  else
    new.created_at := old.created_at; new.created_by := old.created_by; new.keep_until := old.keep_until;
  end if;
  new.updated_at := now(); new.updated_by := _lk_who();
  return new;
end $$;
revoke execute on function public._lk_items_fill() from public, anon, authenticated;
drop trigger if exists locker_items_fill on public.locker_items;
create trigger locker_items_fill before insert or update on public.locker_items
  for each row execute function public._lk_items_fill();

-- ── 5. The maintenance log ──────────────────────────────────────────────────────────────────
create table if not exists public.locker_events (
  id         bigint generated always as identity primary key,
  locker_id  uuid not null references public.lockers(id) on delete cascade,
  at         timestamptz not null default now(),
  by_name    text check (by_name is null or length(by_name) <= 60),
  kind       text not null check (kind in ('added', 'out', 'back', 'retired', 'note')),
  reason     text not null default '' check (length(reason) <= 300)
);
create index if not exists locker_events_locker_idx on public.locker_events (locker_id, at desc);
alter table public.locker_events enable row level security;
drop policy if exists locker_events_staff_read on public.locker_events;
create policy locker_events_staff_read on public.locker_events for select to authenticated using ((select is_staff()));
revoke all on public.locker_events from anon, authenticated;
grant select on public.locker_events to authenticated;

create or replace function public._lk_unit_log()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    insert into locker_events (locker_id, by_name, kind, reason) values (new.id, _lk_who(), 'added', '');
  elsif new.status is distinct from old.status then
    insert into locker_events (locker_id, by_name, kind, reason)
    values (new.id, _lk_who(), case new.status when 'out' then 'out' when 'available' then 'back' else 'retired' end,
            left(case when new.status = 'out' then coalesce(new.note, '') else '' end, 300));
  elsif new.note is distinct from old.note then
    insert into locker_events (locker_id, by_name, kind, reason) values (new.id, _lk_who(), 'note', left(coalesce(new.note, ''), 300));
  end if;
  return null;
end $$;
revoke execute on function public._lk_unit_log() from public, anon, authenticated;
drop trigger if exists lockers_log on public.lockers;
create trigger lockers_log after insert or update of status, note on public.lockers
  for each row execute function public._lk_unit_log();

-- ── Live updates for the staff screens ──────────────────────────────────────────────────────
do $rt$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'locker_items') then
    alter publication supabase_realtime add table public.locker_items;
  end if;
end $rt$;

-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._lk_wallet_sale(uuid)', 'public.customer_locker_book(text,text,date,text,text[],text,text[])',
                           'public.customer_lockers(text,text)', 'public.customer_locker_change(text,text,uuid,text,text)',
                           'public.staff_locker_sweep(date)', 'public._lk_items_fill()', 'public._lk_unit_log()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._lk_wallet_sale(uuid)', 'public._lk_items_fill()', 'public._lk_unit_log()',
                           'public.staff_locker_sweep(date)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
  end loop;
  foreach f in array array['public.customer_locker_book(text,text,date,text,text[],text,text[])',
                           'public.customer_locker_change(text,text,uuid,text,text)'] loop
    if not has_function_privilege('anon', f, 'execute') then raise exception '% is not executable by anon', f; end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.locker_items'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.locker_events'::regclass) then
    raise exception 'RLS is off on locker_items or locker_events';
  end if;
  if has_table_privilege('anon', 'public.locker_items', 'select') or has_table_privilege('anon', 'public.locker_events', 'select') then
    raise exception 'locker_items or locker_events is open to anon';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261109233000', 'locker_round_two')
on conflict (version) do nothing;

commit;
