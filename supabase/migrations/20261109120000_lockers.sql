-- ============================================================================
-- Lockers (the owner, 2026-11-09), 2026-11-09.
--
-- One set of lockers (P1, P2, P3...) that travels between JCC and Petromin, each with an NFC tag and
-- a key that stays with staff. A locker is rented for an evening's period, never longer:
--   early 18:00-20:00 and late 21:00-23:00 (or both) on a JCC night, pm 19:00-21:00 on a Petromin night.
-- One period costs lk_price_one (10 SAR), both cost lk_price_both (15 SAR): Settings > Business.
-- Riders add one on the review of a JCC or Petromin booking (never through the Petromin form); staff give
-- the number at the desk (a tag tap or the number typed). Walk-ups rent from the staff page and pay at
-- the Sales till.
--
--  1. sessions.lockers: the session offers lockers ("Lockers offered" in the session form). Turned on here
--     for the open JCC Sunday/Tuesday rides and the Petromin nights still to come.
--  2. lockers: the units. Staff read and write them directly (RLS is_staff()); a code is unique among
--     the units not retired.
--  3. locker_rentals: one row per locker per evening. reserved (no number yet) -> in_use (number given)
--     -> returned (handed back), or cancelled. Staff read the table; every write goes through the
--     functions below. A booking holds one live rental at most.
--  4. The fee rides on the booking's bill as an add-on line {"id":"locker","qty":1,"p":<fee>} that the
--     database writes itself (zy_locker_line, after queue_entries_addons_price, before zz_wallet_follow),
--     so the desk's Due, the wallet, the reports and _mt_core count it with nothing else changed. Only a
--     rental with on_bill counts; a walk-up's fee is a Sales till sale instead.
--  5. A booking that is cancelled, removed or a no-show frees its reserved locker (a paid no-show keeps
--     the fee: the rental is marked returned). A locker in use stays in use until staff hand it back.
--  6. Rider functions (token-checked): customer_locker_offer (anon too: what a session offers and what is
--     left), customer_lockers, customer_locker_reserve, customer_locker_cancel.
--     Staff functions: staff_locker_reserve, staff_locker_walkup, staff_locker_assign, staff_locker_return,
--     staff_locker_cancel.
--
-- Rollback: drop the triggers zy_locker_line (queue_entries) and locker_rentals_follow*, the tables
--   locker_rentals and lockers, the functions named _lk_* / customer_locker* / staff_locker*, and
--   alter table sessions drop column lockers. Bookings keep a {"id":"locker"} add-on line; strip it with
--   update queue_entries set addons = ... only if the fee must go too.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

-- ── 1. A session offers lockers ─────────────────────────────────────────────────────────────
alter table public.sessions add column if not exists lockers boolean not null default false;

update public.sessions s set lockers = true
 where not s.lockers
   and coalesce(s.status, '') not in ('cancelled', 'closed')
   and s.session_date ~ '^\d{4}-\d{2}-\d{2}'
   and left(s.session_date, 10)::date >= (now() at time zone 'Asia/Riyadh')::date
   and ((coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin')
     or (coalesce(s.event_kind, '') <> 'community' and coalesce(s.ride_kind, '') <> 'snd96'
         and extract(dow from left(s.session_date, 10)::date) in (0, 2)));

-- ── 2. The lockers ──────────────────────────────────────────────────────────────────────────
create table if not exists public.lockers (
  id          uuid primary key default gen_random_uuid(),
  code        text not null check (code ~ '^[A-Z]{1,3}[1-9][0-9]{0,3}$'),
  status      text not null default 'available' check (status in ('available', 'out', 'retired')),
  note        text not null default '' check (length(note) <= 300),
  created_at  timestamptz not null default now()
);
create unique index if not exists lockers_code_uniq on public.lockers (code) where status <> 'retired';
alter table public.lockers enable row level security;
drop policy if exists lockers_staff_read on public.lockers;
create policy lockers_staff_read on public.lockers for select using ((select is_staff()));
drop policy if exists lockers_staff_ins on public.lockers;
create policy lockers_staff_ins on public.lockers for insert with check ((select is_staff()));
drop policy if exists lockers_staff_upd on public.lockers;
create policy lockers_staff_upd on public.lockers for update using ((select is_staff())) with check ((select is_staff()));
revoke all on public.lockers from anon, authenticated;
grant select, insert, update on public.lockers to authenticated;

-- ── 3. The rentals ──────────────────────────────────────────────────────────────────────────
create table if not exists public.locker_rentals (
  id             uuid primary key default gen_random_uuid(),
  day            date not null,
  period         text not null check (period in ('early', 'late', 'both', 'pm')),
  booking_id     text references public.queue_entries(id) on delete set null,
  session_id     text,
  customer_id    text,
  name           text check (name is null or length(name) <= 120),
  locker_id      uuid references public.lockers(id),
  price          numeric(10,2) not null default 0 check (price >= 0 and price <= 1000),
  on_bill        boolean not null default false,
  status         text not null default 'reserved' check (status in ('reserved', 'in_use', 'returned', 'cancelled')),
  created_at     timestamptz not null default now(),
  created_by     text check (created_by is null or length(created_by) <= 60),
  assigned_at    timestamptz,
  assigned_by    text check (assigned_by is null or length(assigned_by) <= 60),
  returned_at    timestamptz,
  returned_by    text check (returned_by is null or length(returned_by) <= 60),
  cancelled_at   timestamptz,
  cancelled_by   text check (cancelled_by is null or length(cancelled_by) <= 60),
  cancel_reason  text not null default '' check (length(cancel_reason) <= 120),
  constraint locker_rentals_in_use_has_locker check (status <> 'in_use' or locker_id is not null)
);
create index if not exists locker_rentals_day_idx on public.locker_rentals (day desc);
create index if not exists locker_rentals_booking_idx on public.locker_rentals (booking_id) where booking_id is not null;
create index if not exists locker_rentals_locker_idx on public.locker_rentals (locker_id, day) where locker_id is not null;
create unique index if not exists locker_rentals_one_live on public.locker_rentals (booking_id)
  where booking_id is not null and status in ('reserved', 'in_use');
alter table public.locker_rentals enable row level security;
drop policy if exists locker_rentals_staff_read on public.locker_rentals;
create policy locker_rentals_staff_read on public.locker_rentals for select using ((select is_staff()));
revoke all on public.locker_rentals from anon, authenticated;
grant select on public.locker_rentals to authenticated;

-- ── Helpers ─────────────────────────────────────────────────────────────────────────────────
-- The slots a period takes: e (18-20) and l (21-23). A Petromin night's 19-21 takes the whole evening.
create or replace function public._lk_slots(p text)
returns text[]
language sql immutable set search_path to 'public'
as $$
  select case p when 'early' then array['e'] when 'late' then array['l']
                when 'both' then array['e', 'l'] when 'pm' then array['e', 'l'] end
$$;
revoke execute on function public._lk_slots(text) from public, anon, authenticated;

-- What a period costs, from Settings > Business.
create or replace function public._lk_price(p text)
returns numeric
language sql stable security definer set search_path to 'public'
as $$
  select (case when p = 'both' then _biz_int('lk_price_both', 15) else _biz_int('lk_price_one', 10) end)::numeric
$$;
revoke execute on function public._lk_price(text) from public, anon, authenticated;

-- The signed-in staffer's name, as staff_set_biz writes it.
create or replace function public._lk_who()
returns text
language sql stable security definer set search_path to 'public'
as $$
  select left(coalesce((select coalesce(nullif(btrim(s.display_name), ''), u.email)
                          from staff s left join auth.users u on u.id = s.user_id
                         where s.user_id = auth.uid()), 'staff'), 60)
$$;
revoke execute on function public._lk_who() from public, anon, authenticated;

-- Lockers free on an evening, per slot: the units in service less the live rentals taking that slot.
create or replace function public._lk_left(p_day date)
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  with cap as (select count(*)::int n from lockers where status = 'available'),
       u as (select count(*) filter (where 'e' = any(_lk_slots(r.period)))::int e,
                    count(*) filter (where 'l' = any(_lk_slots(r.period)))::int l
               from locker_rentals r where r.day = p_day and r.status in ('reserved', 'in_use'))
  select jsonb_build_object('total', cap.n,
                            'early', greatest(cap.n - u.e, 0), 'late', greatest(cap.n - u.l, 0),
                            'both', greatest(least(cap.n - u.e, cap.n - u.l), 0),
                            'pm', greatest(least(cap.n - u.e, cap.n - u.l), 0))
    from cap, u
$$;
revoke execute on function public._lk_left(date) from public, anon, authenticated;

-- The periods a session offers ('' when none): pm on a Petromin night, early/late/both on any other
-- ride that has the switch on. Never on a free community ride (the desk takes no money there).
create or replace function public._lk_kind(p_session text)
returns text
language sql stable security definer set search_path to 'public'
as $$
  select case
    when s.id is null or not coalesce(s.lockers, false) or coalesce(s.status, '') = 'cancelled' then ''
    when coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin' then 'pm'
    when coalesce(s.event_kind, '') = 'community' then ''
    else 'jcc' end
    from (select 1) one left join sessions s on s.id = p_session
$$;
revoke execute on function public._lk_kind(text) from public, anon, authenticated;

create or replace function public._lk_period_ok(p_kind text, p_period text)
returns boolean
language sql immutable set search_path to 'public'
as $$
  select (p_kind = 'pm' and p_period = 'pm') or (p_kind = 'jcc' and p_period in ('early', 'late', 'both'))
$$;
revoke execute on function public._lk_period_ok(text, text) from public, anon, authenticated;

-- Room for n more rentals of a period on an evening. The caller holds the evening's lock.
create or replace function public._lk_room(p_day date, p_period text, p_n int)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select coalesce((_lk_left(p_day) ->> p_period)::int, 0) >= greatest(p_n, 1)
$$;
revoke execute on function public._lk_room(date, text, int) from public, anon, authenticated;

create or replace function public._lk_lock(p_day date)
returns void
language sql volatile set search_path to 'public'
as $$ select pg_advisory_xact_lock(hashtext('lockers:' || p_day::text)) $$;
revoke execute on function public._lk_lock(date) from public, anon, authenticated;

-- ── 4. The fee on the booking's bill ────────────────────────────────────────────────────────
-- addons with the locker line as the rentals have it: any line named 'locker' is dropped, then one is
-- added for the fee of the booking's rentals on the bill (reserved, in use or handed back).
create or replace function public._lk_line(p_booking text, p_addons text)
returns text
language plpgsql stable security definer set search_path to 'public'
as $$
declare fee numeric; j jsonb; x jsonb; outv jsonb := '[]'::jsonb;
begin
  select sum(r.price) into fee from locker_rentals r
   where r.booking_id = p_booking and r.on_bill and r.status in ('reserved', 'in_use', 'returned');
  if fee is null and (p_addons is null or position('"locker"' in p_addons) = 0) then return p_addons; end if;
  begin j := coalesce(nullif(btrim(coalesce(p_addons, '')), ''), '[]')::jsonb; exception when others then return p_addons; end;
  if jsonb_typeof(j) <> 'array' then return p_addons; end if;
  for x in select value from jsonb_array_elements(j) loop
    if not ((jsonb_typeof(x) = 'object' and x ->> 'id' = 'locker') or (jsonb_typeof(x) = 'string' and x #>> '{}' = 'locker')) then
      outv := outv || jsonb_build_array(x);
    end if;
  end loop;
  if coalesce(fee, 0) > 0 then outv := outv || jsonb_build_array(jsonb_build_object('id', 'locker', 'qty', 1, 'p', fee)); end if;
  if jsonb_array_length(outv) = 0 and p_addons is null then return null; end if;
  if outv = j then return p_addons; end if;
  return outv::text;
end $$;
revoke execute on function public._lk_line(text, text) from public, anon, authenticated;

create or replace function public._lk_line_sync()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  new.addons := _lk_line(new.id, new.addons);
  return new;
end $$;
revoke execute on function public._lk_line_sync() from public, anon, authenticated;
drop trigger if exists zy_locker_line on public.queue_entries;
create trigger zy_locker_line
  before insert or update on public.queue_entries
  for each row execute function public._lk_line_sync();

-- A rental that changes touches its booking, so the line follows (the touch writes nothing else). Not
-- the booking being deleted (mm.lk_deleting): a row a BEFORE DELETE trigger has changed cannot be deleted.
create or replace function public._lk_rental_follow()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare b text;
begin
  for b in select distinct x from unnest(array[case when tg_op <> 'INSERT' then old.booking_id end,
                                               case when tg_op <> 'DELETE' then new.booking_id end]) x
            where x is not null and x is distinct from nullif(current_setting('mm.lk_deleting', true), '') loop
    update queue_entries set addons = addons where id = b;
  end loop;
  return null;
end $$;
revoke execute on function public._lk_rental_follow() from public, anon, authenticated;
drop trigger if exists locker_rentals_follow on public.locker_rentals;
create trigger locker_rentals_follow
  after insert or delete on public.locker_rentals
  for each row execute function public._lk_rental_follow();
drop trigger if exists locker_rentals_follow_upd on public.locker_rentals;
create trigger locker_rentals_follow_upd
  after update of status, price, on_bill, booking_id on public.locker_rentals
  for each row
  when (old.status is distinct from new.status or old.price is distinct from new.price
        or old.on_bill is distinct from new.on_bill or old.booking_id is distinct from new.booking_id)
  execute function public._lk_rental_follow();

-- ── 5. The booking leads ────────────────────────────────────────────────────────────────────
create or replace function public._lk_booking_follow()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if tg_op = 'DELETE' then
    perform set_config('mm.lk_deleting', old.id, true);
    update locker_rentals set status = 'cancelled', cancelled_at = now(), cancel_reason = 'booking deleted'
     where booking_id = old.id and status = 'reserved';
    perform set_config('mm.lk_deleting', '', true);
    return old;
  end if;
  if new.session_id is distinct from old.session_id then
    update locker_rentals r set session_id = new.session_id,
           day = coalesce(case when s.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date, 10)::date end, r.day)
      from (select 1) one left join sessions s on s.id = new.session_id
     where r.booking_id = new.id and r.status in ('reserved', 'in_use');
  end if;
  if new.status is distinct from old.status then
    if new.status in ('cancelled', 'removed') or (new.status = 'noshow' and not coalesce(new.paid, false)) then
      update locker_rentals set status = 'cancelled', cancelled_at = now(), cancel_reason = 'booking ' || new.status
       where booking_id = new.id and status = 'reserved';
    elsif new.status = 'noshow' then
      update locker_rentals set status = 'returned', returned_at = now(), returned_by = 'no-show'
       where booking_id = new.id and status = 'reserved';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public._lk_booking_follow() from public, anon, authenticated;
drop trigger if exists queue_entries_lockers on public.queue_entries;
create trigger queue_entries_lockers
  after update of status, session_id on public.queue_entries
  for each row
  when (old.status is distinct from new.status or old.session_id is distinct from new.session_id)
  execute function public._lk_booking_follow();
drop trigger if exists queue_entries_lockers_del on public.queue_entries;
create trigger queue_entries_lockers_del
  before delete on public.queue_entries
  for each row execute function public._lk_booking_follow();

-- ── 6a. Riders ──────────────────────────────────────────────────────────────────────────────
-- What a session offers: its kind ('' none, 'jcc' early/late/both, 'pm'), the prices and what is left.
create or replace function public.customer_locker_offer(p_session text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare k text; d date;
begin
  k := _lk_kind(p_session);
  if k = '' then return jsonb_build_object('kind', ''); end if;
  select case when s.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date, 10)::date end into d
    from sessions s where s.id = p_session;
  if d is null then return jsonb_build_object('kind', ''); end if;
  return jsonb_build_object('kind', k, 'one', _lk_price('early'), 'both', _lk_price('both'), 'left', _lk_left(d));
end $$;
revoke execute on function public.customer_locker_offer(text) from public;
grant execute on function public.customer_locker_offer(text) to anon, authenticated;

-- The rider's own rentals still to come or tonight's (for the tickets).
create or replace function public.customer_lockers(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('booking_id', r.booking_id, 'period', r.period, 'status', r.status,
                                        'price', r.price, 'on_bill', r.on_bill, 'code', l.code) order by r.created_at)
      from locker_rentals r join queue_entries q on q.id = r.booking_id
      left join lockers l on l.id = r.locker_id
     where q.customer_id = p_id and r.status <> 'cancelled'
       and r.day >= (now() at time zone 'Asia/Riyadh')::date - 1), '[]'::jsonb);
end $$;
revoke execute on function public.customer_lockers(text, text) from public, anon;
grant execute on function public.customer_lockers(text, text) to anon, authenticated;

-- A locker on each of these bookings (the rider's own, not paid yet, still to come), for one period.
create or replace function public.customer_locker_reserve(p_id text, p_token text, p_booking_ids text[], p_period text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; bid text; k text; d date; n int; ids text[];
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  select array_agg(distinct x order by x) into ids from unnest(p_booking_ids) x where x is not null;
  n := coalesce(array_length(ids, 1), 0);
  if n = 0 or n > 20 then raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001'; end if;
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
  insert into locker_rentals (day, period, booking_id, session_id, customer_id, name, price, on_bill, status, created_by)
  select d, p_period, e.id, e.session_id, e.customer_id, left(e.name, 120), _lk_price(p_period), true, 'reserved', 'rider'
    from queue_entries e where e.id = any(ids);
  return jsonb_build_object('ok', true, 'left', _lk_left(d),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'addons', e.addons, 'paid', e.paid, 'pay_method', e.pay_method,
                                                          'wallet_paid', e.wallet_paid)), '[]'::jsonb)
               from queue_entries e where e.id = any(ids)));
end $$;
revoke execute on function public.customer_locker_reserve(text, text, text[], text) from public, anon;
grant execute on function public.customer_locker_reserve(text, text, text[], text) to anon, authenticated;

-- The rider takes it back, while no number has been given.
create or replace function public.customer_locker_cancel(p_id text, p_token text, p_booking_ids text[])
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare n int;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  update locker_rentals r set status = 'cancelled', cancelled_at = now(), cancelled_by = 'rider', cancel_reason = 'rider'
    from queue_entries q
   where q.id = r.booking_id and q.customer_id = p_id and r.booking_id = any(p_booking_ids) and r.status = 'reserved'
     and not coalesce(q.paid, false);
  get diagnostics n = row_count;
  if n = 0 then raise exception 'LOCKER_NOT_OPEN' using errcode = 'P0001'; end if;
  return jsonb_build_object('ok', true,
    'rows', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'addons', e.addons, 'paid', e.paid, 'pay_method', e.pay_method,
                                                          'wallet_paid', e.wallet_paid)), '[]'::jsonb)
               from queue_entries e where e.id = any(p_booking_ids) and e.customer_id = p_id));
end $$;
revoke execute on function public.customer_locker_cancel(text, text, text[]) from public, anon;
grant execute on function public.customer_locker_cancel(text, text, text[]) to anon, authenticated;

-- ── 6b. Staff ───────────────────────────────────────────────────────────────────────────────
-- A locker for a booking, for one period of its night. On its bill while it is not paid (p_on_bill);
-- a paid booking's locker is rung up at the Sales till (p_on_bill false). Waitlisted places too.
create or replace function public.staff_locker_reserve(p_booking_id text, p_period text, p_on_bill boolean)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; k text; d date; rid uuid;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into q from queue_entries where id = p_booking_id for update;
  if q.id is null then raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0002'; end if;
  if coalesce(q.status, '') not in ('waiting', 'waitlist', 'active') then raise exception 'LOCKER_NOT_OPEN: the booking is %', q.status using errcode = 'P0001'; end if;
  if p_on_bill and coalesce(q.paid, false) then raise exception 'BOOKING_PAID' using errcode = 'P0001'; end if;
  k := _lk_kind(q.session_id);
  if not _lk_period_ok(k, p_period) then raise exception 'LOCKER_NOT_OPEN: this session offers no such period' using errcode = 'P0001'; end if;
  select case when s.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date, 10)::date end into d
    from sessions s where s.id = q.session_id;
  if d is null then raise exception 'LOCKER_NOT_OPEN: the session has no date' using errcode = 'P0001'; end if;
  perform _lk_lock(d);
  if exists (select 1 from locker_rentals r where r.booking_id = q.id and r.status in ('reserved', 'in_use')) then
    raise exception 'LOCKER_HELD' using errcode = 'P0001';
  end if;
  if not _lk_room(d, p_period, 1) then raise exception 'LOCKERS_FULL' using errcode = 'P0001'; end if;
  insert into locker_rentals (day, period, booking_id, session_id, customer_id, name, price, on_bill, status, created_by)
  values (d, p_period, q.id, q.session_id, q.customer_id, left(q.name, 120), _lk_price(p_period), coalesce(p_on_bill, false), 'reserved', _lk_who())
  returning id into rid;
  -- the booking's add-ons as the line now has them, for the desk to draw at once
  return jsonb_build_object('ok', true, 'id', rid, 'booking_id', q.id, 'addons', (select e.addons from queue_entries e where e.id = q.id));
end $$;
revoke execute on function public.staff_locker_reserve(text, text, boolean) from public, anon;
grant execute on function public.staff_locker_reserve(text, text, boolean) to authenticated;

-- A walk-up (no booking that night): an account or a name, tonight unless a day is given.
create or replace function public.staff_locker_walkup(p_customer text, p_name text, p_period text, p_day date)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare d date := coalesce(p_day, (now() at time zone 'Asia/Riyadh')::date); nm text; rid uuid;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_period not in ('early', 'late', 'both', 'pm') then raise exception 'LOCKER_NOT_OPEN: no such period' using errcode = 'P0001'; end if;
  nm := nullif(btrim(coalesce(p_name, '')), '');
  if p_customer is not null then
    select coalesce(nm, c.name) into nm from customers c where c.id = p_customer;
    if not found then raise exception 'NOT_FOUND: no such account' using errcode = 'P0002'; end if;
  end if;
  if nm is null then raise exception 'LOCKER_NO_NAME' using errcode = 'P0001'; end if;
  perform _lk_lock(d);
  if not _lk_room(d, p_period, 1) then raise exception 'LOCKERS_FULL' using errcode = 'P0001'; end if;
  insert into locker_rentals (day, period, customer_id, name, price, on_bill, status, created_by)
  values (d, p_period, p_customer, left(nm, 120), _lk_price(p_period), false, 'reserved', _lk_who())
  returning id into rid;
  return jsonb_build_object('ok', true, 'id', rid, 'price', _lk_price(p_period));
end $$;
revoke execute on function public.staff_locker_walkup(text, text, text, date) from public, anon;
grant execute on function public.staff_locker_walkup(text, text, text, date) to authenticated;

-- Give (or move to) a locker by its code. The unit must be in service and not taken for an
-- overlapping slot that evening.
create or replace function public.staff_locker_assign(p_rental uuid, p_code text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare r locker_rentals%rowtype; l lockers%rowtype; c text; who text;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  c := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  c := regexp_replace(c, '^([A-Z]{1,3})0+', '\1');
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
         assigned_at = case when r.locker_id is distinct from l.id then now() else assigned_at end,
         assigned_by = case when r.locker_id is distinct from l.id then _lk_who() else assigned_by end
   where id = r.id;
  return jsonb_build_object('ok', true, 'code', l.code);
end $$;
revoke execute on function public.staff_locker_assign(uuid, text) from public, anon;
grant execute on function public.staff_locker_assign(uuid, text) to authenticated;

-- Handed back: the locker is free again; the fee stays.
create or replace function public.staff_locker_return(p_rental uuid)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare n int;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update locker_rentals set status = 'returned', returned_at = now(), returned_by = _lk_who()
   where id = p_rental and status in ('reserved', 'in_use');
  get diagnostics n = row_count;
  if n = 0 then raise exception 'LOCKER_NOT_OPEN: already handed back or cancelled' using errcode = 'P0001'; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.staff_locker_return(uuid) from public, anon;
grant execute on function public.staff_locker_return(uuid) to authenticated;

-- Cancelled: the locker is free and a fee on the bill comes off it. p_undo puts a handed-back rental
-- back in use (a Hand back tapped by mistake).
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
  if r.booking_id is null then return jsonb_build_object('ok', true); end if;
  return jsonb_build_object('ok', true, 'booking_id', r.booking_id, 'addons', (select e.addons from queue_entries e where e.id = r.booking_id));
end $$;
revoke execute on function public.staff_locker_cancel(uuid, text, boolean) from public, anon;
grant execute on function public.staff_locker_cancel(uuid, text, boolean) to authenticated;

-- ── Live updates for the staff screens ──────────────────────────────────────────────────────
do $rt$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'locker_rentals') then
      alter publication supabase_realtime add table public.locker_rentals;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'lockers') then
      alter publication supabase_realtime add table public.lockers;
    end if;
  end if;
end $rt$;

-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._lk_price(text)', 'public._lk_who()', 'public._lk_left(date)', 'public._lk_kind(text)',
                           'public._lk_room(date,text,integer)', 'public._lk_line(text,text)', 'public._lk_line_sync()',
                           'public._lk_rental_follow()', 'public._lk_booking_follow()',
                           'public.customer_locker_offer(text)', 'public.customer_lockers(text,text)',
                           'public.customer_locker_reserve(text,text,text[],text)', 'public.customer_locker_cancel(text,text,text[])',
                           'public.staff_locker_reserve(text,text,boolean)', 'public.staff_locker_walkup(text,text,text,date)',
                           'public.staff_locker_assign(uuid,text)', 'public.staff_locker_return(uuid)',
                           'public.staff_locker_cancel(uuid,text,boolean)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._lk_price(text)', 'public._lk_left(date)', 'public._lk_line(text,text)',
                           'public.staff_locker_assign(uuid,text)', 'public.staff_locker_walkup(text,text,text,date)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.lockers'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.locker_rentals'::regclass) then
    raise exception 'RLS is off on lockers or locker_rentals';
  end if;
  if has_table_privilege('anon', 'public.locker_rentals', 'select') or has_table_privilege('authenticated', 'public.locker_rentals', 'insert') then
    raise exception 'locker_rentals is open to direct writes or anon reads';
  end if;
  -- The locker line is written after the price snapshot (queue_entries_addons_price) and before the
  -- wallet follows the amount (zz_wallet_follow): BEFORE triggers run in name order.
  if not exists (select 1 from pg_trigger where tgrelid = 'public.queue_entries'::regclass and tgname = 'zy_locker_line')
     or not exists (select 1 from pg_trigger where tgrelid = 'public.queue_entries'::regclass and tgname = 'queue_entries_lockers') then
    raise exception 'the locker triggers on queue_entries are missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261109120000', 'lockers')
on conflict (version) do nothing;

commit;
