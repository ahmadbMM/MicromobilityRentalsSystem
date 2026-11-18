-- ============================================================================
-- Dukan pays 57.5 per bike, not 50 (the user, 2026-11-18: "change dukan billing report to pay 57.5 per bike not 50").
--
-- Dukan's employees ride the Petromin nights and were billed like Petromin's (20261112210000): _rider_price, 50 a bike,
-- Road 75. From now on a Dukan ride is 57.5 a bike (Road stays 75, as for every company's rider).
--
-- 1. _dukan_fare(type): 57.5, Road as _rider_price('Road').
-- 2. _rider_registration_guard: a Dukan registration's fare, fixed when the bike is returned, is _dukan_fare; it is
--    worked out again when the company is changed to or from Dukan after the return (as on a corrected bike type).
-- 3. _booking_fare: a booking linked to a Dukan registration costs _dukan_fare on the types that carry an employee fare,
--    so the booking on Bookings shows what Dukan is billed.
-- 4. _report_month_bill (month-end billing): Dukan is a company of its own; its rides were counted as having none.
-- 5. Dukan's returned rides already priced (prod: the 7 rides of 2026-11-16, 50 each) take 57.5; a linked booking
--    still waiting, unpaid, at the employee fare takes the new fare (none on prod).
--
-- Each function is replaced only if its live text is the one this file was written from (md5 of prosrc), so a change
-- made since by another session is not lost. Their attributes (STABLE, search_path, SECURITY DEFINER) and grants stay.
--
-- Rollback (emergency only): put back the previous bodies, as in 20260917100000_rider_price_follows_type.sql
-- (_rider_registration_guard), 20260921190000_petromin_fare_is_the_employees.sql (_booking_fare) and
-- 20261113120000_reports_rework.sql (_report_month_bill); drop function _dukan_fare(text); set the rides back with
--   update rider_registrations set price = 50 where lower(btrim(company)) = 'dukan' and session_id = '2026-11-16-pw';
-- ============================================================================
begin;
set local lock_timeout = '5s';

do $chk$
declare m record;
begin
  for m in
    select p.proname, md5(p.prosrc) as h,
           case p.proname when '_booking_fare' then '8b37d7720262abeaa1489a7c5230a702'
                          when '_rider_registration_guard' then '97d2526c2ee4eb34ef3fbf4c1fb47670'
                          when '_report_month_bill' then 'b0909904e69be93314ff09b3cc66f340' end as want
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('_booking_fare', '_rider_registration_guard', '_report_month_bill')
  loop
    if m.h <> m.want then
      raise exception 'dukan_fare: % changed since 20261118150000 was written (md5 %)', m.proname, m.h;
    end if;
  end loop;
end $chk$;

-- 1. Dukan's fare per bike.
create or replace function public._dukan_fare(p_type text)
 returns numeric
 language sql
 stable
 set search_path to 'public'
as $function$
  select case when p_type = 'Road' then _rider_price('Road') else 57.5 end
$function$;

-- 2. The registration's fare, fixed at the return.
create or replace function public._rider_registration_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  -- a return implies a check-in
  if new.checked_out_at is not null and new.checked_in_at is null then new.checked_in_at := new.checked_out_at; end if;
  -- price is fixed the moment the bike is returned, follows a corrected bike type (or a company changed to or from
  -- Dukan, which has its own fare, 20261118150000), and is cleared if the return is undone
  if new.checked_out_at is not null and (old.checked_out_at is null or new.price is null
       or new.type_preference is distinct from old.type_preference
       or (lower(btrim(coalesce(new.company, ''))) = 'dukan') <> (lower(btrim(coalesce(old.company, ''))) = 'dukan')) then
    new.price := case when lower(btrim(coalesce(new.company, ''))) = 'dukan' then _dukan_fare(new.type_preference)
                      else _rider_price(new.type_preference) end;
  end if;
  if new.checked_out_at is null then new.price := null; end if;
  new.updated_at := now();
  return new;
end $function$;

-- 3. A booking linked to a registration: the employee fare, or Dukan's.
create or replace function public._booking_fare(p_entry_id text, p_ride_kind text, p_type text)
 returns numeric
 language sql
 stable
 set search_path to 'public'
as $function$
  select coalesce(
    (select case when lower(btrim(coalesce(r.company, ''))) = 'dukan'
                 then case when _employee_fare(p_type) is not null then _dukan_fare(p_type) end
                 else _employee_fare(p_type) end
       from rider_registrations r
      where r.matched_entry_id = p_entry_id
        and r.source = p_ride_kind
      order by r.id
      limit 1),
    (select price from ride_prices where type = p_type))
$function$;

-- 4. Month-end billing: Dukan is billed on its own.
create or replace function public._report_month_bill(p_from date, p_to date)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with r as (
    select rr.session_id, rr.badge, rr.party_no, rr.name, rr.type_preference as type,
           coalesce(rr.price, case when lower(btrim(coalesce(rr.company, ''))) = 'dukan' then _dukan_fare(rr.type_preference)
                                   else _rider_price(rr.type_preference) end) as fare,
           case lower(btrim(coalesce(rr.company, ''))) when 'petromin' then 'Petromin' when 'petrolube' then 'Petrolube'
                                                       when 'dukan' then 'Dukan' else '' end as co
      from rider_registrations rr
     where rr.checked_out_at is not null
       and left(rr.session_id, 10) between to_char(p_from, 'YYYY-MM-DD') and to_char(p_to, 'YYYY-MM-DD')
  )
  select jsonb_build_object(
    'companies', coalesce((
      select jsonb_agg(x.c order by x.co)
        from (select r1.co,
                     jsonb_build_object(
                       'name', r1.co, 'rides', count(*), 'total', coalesce(sum(r1.fare), 0),
                       'by_fare', (select coalesce(jsonb_agg(jsonb_build_object('type', f.type, 'fare', f.fare, 'n', f.n) order by f.type, f.fare), '[]'::jsonb)
                                     from (select r2.type, r2.fare, count(*) as n from r r2 where r2.co = r1.co group by r2.type, r2.fare) f),
                       'rows', jsonb_agg(jsonb_build_object('session_id', r1.session_id, 'badge', r1.badge, 'party_no', r1.party_no,
                                                            'name', r1.name, 'type', r1.type, 'fare', r1.fare)
                                         order by r1.session_id, r1.badge, r1.party_no)) as c
                from r r1 where r1.co <> '' group by r1.co) x), '[]'::jsonb),
    'no_company', (select count(*) from r where r.co = ''));
$function$;

-- 5. Dukan's rides already returned, and a linked booking still waiting at the employee fare.
update public.rider_registrations
   set price = _dukan_fare(type_preference)
 where lower(btrim(coalesce(company, ''))) = 'dukan'
   and checked_out_at is not null
   and price is distinct from _dukan_fare(type_preference);

update public.queue_entries q
   set price = _booking_fare(q.id, s.ride_kind, q.type_preference)
  from public.rider_registrations r, public.sessions s
 where r.matched_entry_id = q.id
   and lower(btrim(coalesce(r.company, ''))) = 'dukan'
   and s.id = q.session_id
   and r.source = s.ride_kind
   and q.price = _employee_fare(q.type_preference)
   and q.price is distinct from _booking_fare(q.id, s.ride_kind, q.type_preference)
   and coalesce(q.paid, false) = false
   and q.assigned_bike_id is null
   and q.status in ('waiting', 'waitlist')
   and coalesce(q.promo_code, '') = '';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261118150000', 'dukan_fare')
on conflict (version) do nothing;

commit;

-- Check (read only): the fares, Dukan's rides by price, the functions' attributes, the ledger row.
select public._dukan_fare('Hybrid') as dukan_hybrid, public._dukan_fare('Mountain') as dukan_mountain,
       public._dukan_fare('Road') as dukan_road, public._rider_price('Hybrid') as petromin_hybrid,
       (select json_agg(json_build_object('price', x.price, 'n', x.n) order by x.price)
          from (select price, count(*) as n from public.rider_registrations
                 where lower(btrim(coalesce(company, ''))) = 'dukan' and checked_out_at is not null group by price) x) as dukan_rides,
       (select json_agg(json_build_object('fn', p.proname, 'definer', p.prosecdef, 'volatile', p.provolatile,
                                          'settings', p.proconfig) order by p.proname)
          from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('_dukan_fare', '_rider_registration_guard', '_booking_fare', '_report_month_bill')) as fns,
       (select name from supabase_migrations.schema_migrations where version = '20261118150000') as ledger;
