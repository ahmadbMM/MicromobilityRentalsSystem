-- ============================================================================
-- Pricing screen (Staff app research 2026-10-09, M6), 2026-10-09.
--
-- The fares were the booking app's constants (RIDE_PRICES, RIDE_PRICES_MAX, EMPLOYEE_PRICES) and
-- ride_prices, which only a migration changed. Admins change them on Settings > Pricing now.
--
--  1. ride_prices gains max_price (the highest a booking that may become this type is quoted:
--     RIDE_PRICES_MAX; null = the fare itself, Any = the dearest everyday type) and employee_price
--     (a Petromin employee's fare on this type: EMPLOYEE_PRICES; null = the standard fare). Today's
--     numbers are written in: 50 on Mountain, Hybrid, Kids and Any, none on Road (an employee on a
--     Road bike pays the standard fare, as before).
--  2. _employee_fare and _rider_price read employee_price, with today's numbers as the fallback.
--     Who pays it does not change: _booking_fare still applies it only to a booking a registration
--     from the ride's own form points at (the owner's rule: form-registered employees only).
--     Both become STABLE (they read a table now); no index or default uses them.
--  3. staff_set_ride_price(type, price, max, employee, op, approval): admins only, with the
--     operator's PIN approval (_pin_ok), 0..5000, max >= price; logged in staff_actions; audited
--     by ride_prices_audit (20261009160000). Riders read ride_prices as before (public read).
--
-- Rollback: drop function public.staff_set_ride_price(text,numeric,numeric,numeric,text,text);
--   create or replace _employee_fare / _rider_price from their earlier definitions (IMMUTABLE,
--   the literal 50 / 75); alter table ride_prices drop column max_price, drop column employee_price.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

alter table public.ride_prices add column if not exists max_price numeric;
alter table public.ride_prices add column if not exists employee_price numeric;
alter table public.ride_prices drop constraint if exists ride_prices_range;
alter table public.ride_prices add constraint ride_prices_range check (
  price >= 0 and price <= 5000
  and (max_price is null or (max_price >= price and max_price <= 5000))
  and (employee_price is null or (employee_price >= 0 and employee_price <= 5000)));

update public.ride_prices set employee_price = 50
 where type in ('Mountain', 'Hybrid', 'Kids', 'Any') and employee_price is null;
update public.ride_prices set max_price = 75 where type = 'Any' and max_price is null;

-- The employee fare: the row's employee_price, else what it always was.
create or replace function public._employee_fare(p_type text)
returns numeric
language sql stable set search_path to 'public'
as $$
  select case when p_type in ('Hybrid','Mountain','Kids','Any','Road') then _rider_price(p_type) end
$$;

-- A registration's fare (the Petromin form): the type's employee fare, else the standard fare
-- on Road (75) and the old 50 elsewhere, as before (20261009161000).
create or replace function public._rider_price(p_type text)
returns numeric
language sql stable set search_path to 'public'
as $$
  select coalesce(
    (select r.employee_price from ride_prices r where r.type = p_type),
    case when p_type = 'Road' then coalesce((select r.price from ride_prices r where r.type = 'Road'), 75) else 50 end)
$$;

create or replace function public.staff_set_ride_price(p_type text, p_price numeric, p_max numeric, p_employee numeric,
                                                       p_op text default null, p_approval text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare old ride_prices%rowtype; who text;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if p_type is null or p_type !~ '^[A-Za-z][A-Za-z ]{0,30}$' or p_type = 'Own' then raise exception 'BAD_TYPE' using errcode = '22023'; end if;
  if p_price is null or p_price < 0 or p_price > 5000
     or (p_max is not null and (p_max < p_price or p_max > 5000))
     or (p_employee is not null and (p_employee < 0 or p_employee > 5000)) then
    raise exception 'PRICE_RANGE' using errcode = '22023';
  end if;
  select * into old from ride_prices where type = p_type;
  insert into ride_prices (type, price, max_price, employee_price) values (p_type, p_price, p_max, p_employee)
    on conflict (type) do update set price = excluded.price, max_price = excluded.max_price, employee_price = excluded.employee_price;
  select coalesce(nullif(btrim(s.display_name), ''), u.email) into who
    from staff s left join auth.users u on u.id = s.user_id where s.user_id = auth.uid();
  insert into staff_actions (at, action, who, device, view, user_id)
    values (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            left(format('Fare %s: %s -> %s (highest %s, employee %s)', p_type, coalesce(old.price::text, '-'), p_price,
                        coalesce(p_max::text, '-'), coalesce(p_employee::text, '-')), 300),
            left(coalesce(nullif(btrim(coalesce(p_op, '')), ''), who, 'admin'), 80), 'server', 'settings', auth.uid());
  return jsonb_build_object('ok', true, 'type', p_type, 'price', p_price, 'max_price', p_max, 'employee_price', p_employee);
end $$;
revoke execute on function public.staff_set_ride_price(text, numeric, numeric, numeric, text, text) from public, anon;
grant execute on function public.staff_set_ride_price(text, numeric, numeric, numeric, text, text) to authenticated;

do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.staff_set_ride_price(text,numeric,numeric,numeric,text,text)'::regprocedure
                   and p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'staff_set_ride_price is not SECURITY DEFINER with a search_path';
  end if;
  if _employee_fare('Hybrid') <> 50 or _employee_fare('Road') <> 75 or _rider_price('Road Carbon') <> 50 then
    raise exception 'the employee fares moved: %, %, %', _employee_fare('Hybrid'), _employee_fare('Road'), _rider_price('Road Carbon');
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009161000', 'ride_prices_admin')
on conflict (version) do nothing;

commit;
