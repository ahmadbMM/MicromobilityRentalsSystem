-- ============================================================================
-- A reserved locker is nobody else's (the owner, 2026-11-09: "whenever a locker is reserved dont allow other
-- customers to choose it or reserve it"), 2026-11-09.
--
-- Every way in already refuses a locker taken for an overlapping time (customer_locker_book,
-- customer_locker_reserve, staff_locker_assign, the undo of a Hand back), under the evening's lock. One way
-- round it was left: a booking moved to another evening (staff_move_session, the rider changing the date)
-- carried its rental there with its locker, and since 20261109220000 a rider picks the locker when booking,
-- so the locker could land on an evening where someone else holds it. Now the locker goes along only when it
-- is free there for that time; else the rental stays reserved with no number (the desk gives one).
--
-- _lk_booking_follow, rebuilt from 20261109120000 (the live body matched it on 2026-11-09).
-- Rollback: re-run section 5 of 20261109120000_lockers.sql.
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public._lk_booking_follow()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare nd date;
begin
  if tg_op = 'DELETE' then
    perform set_config('mm.lk_deleting', old.id, true);
    update locker_rentals set status = 'cancelled', cancelled_at = now(), cancel_reason = 'booking deleted'
     where booking_id = old.id and status = 'reserved';
    perform set_config('mm.lk_deleting', '', true);
    return old;
  end if;
  if new.session_id is distinct from old.session_id then
    select case when s.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date, 10)::date end into nd
      from sessions s where s.id = new.session_id;
    if nd is not null then perform _lk_lock(nd); end if;
    update locker_rentals r set session_id = new.session_id, day = coalesce(nd, r.day)
     where r.booking_id = new.id and r.status in ('reserved', 'in_use');
    -- the locker goes along only when nobody holds it there for an overlapping time
    update locker_rentals r set locker_id = null, status = 'reserved', assigned_at = null, assigned_by = null
     where r.booking_id = new.id and r.status in ('reserved', 'in_use') and r.locker_id is not null
       and exists (select 1 from locker_rentals x
                    where x.locker_id = r.locker_id and x.day = r.day and x.id <> r.id
                      and x.status in ('reserved', 'in_use') and _lk_slots(x.period) && _lk_slots(r.period));
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

do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public._lk_booking_follow()'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '_lk_booking_follow lost SECURITY DEFINER or its search_path';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.queue_entries'::regclass and tgname = 'queue_entries_lockers') then
    raise exception 'the locker trigger on queue_entries is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261109230000', 'locker_move_guard')
on conflict (version) do nothing;

commit;
