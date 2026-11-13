-- ============================================================================
-- The Little Farmhouse Night: four people per booking, the account holder and three with them (the user, 2026-11-13:
-- "put a limit for each booking to include the account owner in addition to 3 with them").
--
-- 20261114130000 capped a farm night at Settings > Business event_seat_max (five), the same setting an event reads.
-- The farm night now has a cap of its own, 4, which the booking app's FARM_SEAT_MAX matches; an event keeps
-- event_seat_max. Staff are exempt, as everywhere.
-- _group_ride_cap is restated from its LIVE definition (pg_get_functiondef on production, 2026-11-13, equal to
-- 20261114130000's) with that one change; SECURITY DEFINER and the search_path are kept.
--
-- Safe before the app: an older page offers up to five, and the fifth is refused here with GROUP_CAP, which the app
-- words as "Up to 4 ...". On production, 2026-11-13, the farm night (2026-11-19-fh) held no booking, so no account
-- is over the new cap.
-- Undo: re-run section 6 of 20261114130000_farm_kind.sql.
-- ============================================================================
begin;

create or replace function public._group_ride_cap()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _live int; _cap int; _jcc boolean;
begin
  if new.customer_id is null or (select is_staff()) then return new; end if;

  -- A community ride: four per booker on the Farm House Night (the member and three with them, 20261114150000),
  -- five on an event, two on the others (an approval ride is _solo_ride_cap's). Every other ride - the circuit,
  -- the National Day ride - three per account, the booking app's JCC_ACCOUNT_CAP (20261005210000).
  select case when coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') <> 'snd96'
              then case when coalesce(s.ride_kind, '') = 'farm' then 4
                        when coalesce(s.needs_approval, false) then null
                        when coalesce(s.ride_kind, '') = 'event' then _biz_int('event_seat_max', 5)
                        else _biz_int('group_ride_max', 2) end
              else _biz_int('jcc_account_cap', 3) end,  -- Settings > Business (20261009160000)
         not (coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') <> 'snd96')
    into _cap, _jcc
    from sessions s
   where s.id = new.session_id;
  if _cap is null then return new; end if;

  -- Two bookings sent at once by one account take turns (20261004100000).
  perform pg_advisory_xact_lock(hashtext('ridecap:' || coalesce(new.session_id, '') || ':' || new.customer_id));
  select count(*) into _live
    from queue_entries q
   where q.session_id = new.session_id
     and q.customer_id = new.customer_id
     and q.id <> new.id
     and case when _jcc then coalesce(q.status, '') in ('waiting', 'active', 'waitlist')   -- as the app counts
              else coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow') end;

  if _live >= _cap then
    raise exception 'Up to % riders per booking on this ride.', _cap using detail = 'GROUP_CAP';
  end if;

  return new;
end $function$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114150000', 'farm_cap_four')
on conflict (version) do nothing;

commit;

-- Check (expect: SECURITY DEFINER, search_path=public, the farm capped at 4, the ledger row named farm_cap_four):
-- select p.prosecdef, p.proconfig, p.prosrc like '%''farm'' then 4%' as farm_four
--   from pg_proc p where p.proname = '_group_ride_cap' and p.pronamespace = 'public'::regnamespace;
-- select version, name from supabase_migrations.schema_migrations where version = '20261114150000';
