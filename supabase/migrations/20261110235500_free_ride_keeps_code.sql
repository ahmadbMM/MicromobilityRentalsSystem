-- ============================================================================
-- A booking that is free anyway never spends a code (the user, 2026-11-10: "make sure that an on the house or
-- free booking or bike owner doesn't count as a free ride if the code was used, check the old used codes and make
-- sure everyone who used the code for a free or owner ride return the free ride code to them"). For PROD and
-- STAGING.
--
-- 1. _promo_free_drop + trg_promo_free_drop (new, BEFORE INSERT OR UPDATE on queue_entries): a live booking carrying
--    a code loses it when the ride costs nothing without it:
--      - a bike owner's row (type Own);
--      - a ride whose fare is 0 (a free community ride, an event seat at 0);
--      - a row paid at 0 by the rider's own terms (VIP, a house default payment: _house_earned, the holder's one
--        free row per ride: not _house_taken), or paid at 0 when the code alone would still leave a price (staff
--        put it on the house).
--    A row the code itself made free (a 100% free-ride code, then marked paid at the desk) keeps it. The trigger
--    sorts after _apply_default_pay, _enforce_booking_price and the house guards, so it judges the row they leave.
--    It runs on an insert and on an update that changes the code, the bike type, the session, the account, the
--    name, paid, the price or the status, whoever writes (staff too: staff updates skip _enforce_booking_price).
--    The holes it closes: the customer and _apply_default_pay paths already dropped a code on the holder's free
--    row and on a free ride, but a row made on the house AFTER it was booked kept it (the desk's VIP tag and
--    default-payment repricing, staff_set_house, staff marking a row paid at 0), and so did a staff switch to an
--    own bike.
-- 2. trg_promo_count_upd now follows every update that changes the code or the status, not only one that names
--    those columns: a code a BEFORE trigger took off during an update naming other columns (a type switch, a
--    move, the house repricing marking paid) kept its use for good.
-- 3. The old uses: every live booking that is free anyway gives its code back. On prod, 2026-11-10, that is ONE
--    booking: jakjcmlmw8636s5 (2026-11-10, Road, BD-89E0AB7D): the rider was given the VIP tag on 2026-11-09 after
--    booking with her blood-donation free ride, and the desk's repricing marked the row paid at 0 with the code
--    still on it. The other nine bookings with a free-ride or referral code were paid by the code. A cancelled
--    booking already gave its use back; every code's count matched its live bookings.
--
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- 1 ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._promo_free_drop()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _f numeric; _left numeric;
begin
  if coalesce(new.promo_code, '') = '' or coalesce(new.status, '') in ('cancelled', 'removed') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.promo_code      is not distinct from old.promo_code
     and new.type_preference is not distinct from old.type_preference
     and new.session_id      is not distinct from old.session_id
     and new.customer_id     is not distinct from old.customer_id
     and new.name            is not distinct from old.name
     and new.paid            is not distinct from old.paid
     and new.price           is not distinct from old.price
     and new.status          is not distinct from old.status then
    return new;   -- nothing that makes a ride free changed (a rating, a check-in stamp)
  end if;
  _f := _fare_now(new.session_id, new.id, new.type_preference);
  if coalesce(new.type_preference, '') = 'Own' or coalesce(_f, 0) <= 0 then
    new.promo_code := null;   -- a bike owner, a free ride, a fare of 0 (20261110235500)
    return new;
  end if;
  if coalesce(new.paid, false) and coalesce(new.price, 0) = 0 then
    if _house_earned(new.customer_id, new.name, new.type_preference)
       and not _house_taken(new.customer_id, new.session_id, new.id) then
      new.promo_code := null;   -- on the house by the rider's own terms (VIP, default payment)
      return new;
    end if;
    select _promo_fare(c, new.type_preference, _f, _f) into _left
      from promo_codes c where lower(c.code) = lower(new.promo_code) order by c.id limit 1;
    if _left > 0 then
      new.promo_code := null;   -- the code alone leaves a price: staff gave the ride free
    end if;
  end if;
  return new;
end $function$;

revoke all on function public._promo_free_drop() from public, anon, authenticated;

drop trigger if exists trg_promo_free_drop on public.queue_entries;
create trigger trg_promo_free_drop
  before insert or update on public.queue_entries
  for each row execute function public._promo_free_drop();

-- 2 ---------------------------------------------------------------------------------------------------
drop trigger if exists trg_promo_count_upd on public.queue_entries;
create trigger trg_promo_count_upd
  after update on public.queue_entries
  for each row
  when (old.status is distinct from new.status or old.promo_code is distinct from new.promo_code)
  execute function public._promo_count();

-- 3 ---------------------------------------------------------------------------------------------------
-- The same test as the trigger's, on every live row with a code. Setting promo_code names the column, so the
-- count trigger gives each code its use back.
update queue_entries q
   set promo_code = null
 where coalesce(q.promo_code, '') <> ''
   and coalesce(q.status, '') not in ('cancelled', 'removed')
   and (coalesce(q.type_preference, '') = 'Own'
        or coalesce(_fare_now(q.session_id, q.id, q.type_preference), 0) <= 0
        or (coalesce(q.paid, false) and coalesce(q.price, 0) = 0
            and ((_house_earned(q.customer_id, q.name, q.type_preference)
                  and not _house_taken(q.customer_id, q.session_id, q.id))
                 or (select _promo_fare(c, q.type_preference, _fare_now(q.session_id, q.id, q.type_preference),
                                        _fare_now(q.session_id, q.id, q.type_preference))
                       from promo_codes c where lower(c.code) = lower(q.promo_code) order by c.id limit 1) > 0)));

-- checks: definer + search_path, closed to callers, both triggers in place, no live row left that is free anyway
-- with a code, every limited code's count matches its live bookings
do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public._promo_free_drop()'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '_promo_free_drop lost SECURITY DEFINER or its search_path';
  end if;
  if has_function_privilege('anon', 'public._promo_free_drop()', 'execute')
     or has_function_privilege('authenticated', 'public._promo_free_drop()', 'execute') then
    raise exception '_promo_free_drop is open to anon or authenticated';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.queue_entries'::regclass and tgname = 'trg_promo_free_drop')
     or not exists (select 1 from pg_trigger where tgrelid = 'public.queue_entries'::regclass and tgname = 'trg_promo_count_upd'
                      and pg_get_triggerdef(oid) like '%WHEN%' and pg_get_triggerdef(oid) not like '%UPDATE OF%') then
    raise exception 'a trigger of this file is missing or not as written';
  end if;
  if exists (select 1 from queue_entries q
              where coalesce(q.promo_code, '') <> '' and coalesce(q.status, '') not in ('cancelled', 'removed')
                and (coalesce(q.type_preference, '') = 'Own' or coalesce(_fare_now(q.session_id, q.id, q.type_preference), 0) <= 0)) then
    raise exception 'an own-bike or free booking still holds a code';
  end if;
  if exists (select 1 from promo_codes c
              where c.max_uses is not null
                and coalesce(c.uses, 0) <> (select count(*) from queue_entries q
                                             where lower(q.promo_code) = lower(c.code)
                                               and coalesce(q.status, '') not in ('cancelled', 'removed'))) then
    raise exception 'a limited code''s uses no longer match its live bookings';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261110235500', 'free_ride_keeps_code')
on conflict (version) do nothing;

commit;

-- After: the codes given back (expect BD-89E0AB7D on prod, uses 0)
-- select code, uses, max_uses, expires_at from promo_codes where lower(code) = 'bd-89e0ab7d';
