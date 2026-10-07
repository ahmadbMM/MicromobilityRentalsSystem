-- ============================================================================
-- Reserve bike without choosing one, and by the bike's number (the owner, 2026-10-07: "change the
-- reserve bike to not force the staff to choose a bike and add a bike number option when choosing
-- a bike").
--
-- A reservation was only ever a fleet bike held on the booking (assigned_bike_id), so Reserve bike
-- refused a booking with no bike picked: with the fleet empty, nothing could be reserved at all.
-- Two staff columns let a waiting booking be reserved without one:
--   reserved          - a bike is held for this booking, none of the fleet's chosen;
--   reserved_bike_no  - the number staff typed for it (the bike's sticker) when that number is not
--                       a bike in the fleet. A number that IS a fleet bike goes on assigned_bike_id
--                       as before, so check-in still claims it.
-- Staff-only, like to_reserve: read and written straight off the table under the staff policies;
-- customers never see them (queue_public and my_bookings are not widened). staff_sync sends whole
-- rows (to_jsonb), so the new columns reach every desk without a change there.
--
-- Rollback: alter table public.queue_entries drop constraint if exists queue_entries_reserved_bike_no_check,
--           drop column if exists reserved_bike_no, drop column if exists reserved;
-- Idempotent: safe to re-run.
-- ============================================================================

begin;

alter table public.queue_entries add column if not exists reserved boolean not null default false;
alter table public.queue_entries add column if not exists reserved_bike_no integer;
comment on column public.queue_entries.reserved is 'staff: a bike is held for this booking, no fleet bike chosen (assigned_bike_id holds a chosen one)';
comment on column public.queue_entries.reserved_bike_no is 'staff: the bike number typed for the reservation when it is not a fleet bike (1-9999, as bike numbers are)';

alter table public.queue_entries drop constraint if exists queue_entries_reserved_bike_no_check;
alter table public.queue_entries add constraint queue_entries_reserved_bike_no_check
  check (reserved_bike_no is null or (reserved and reserved_bike_no between 1 and 9999));

do $chk$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'queue_entries'
         and column_name in ('reserved', 'reserved_bike_no')) <> 2 then
    raise exception 'queue_entries.reserved / reserved_bike_no missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261007160000', 'reserve_without_bike')
on conflict (version) do nothing;

commit;

-- Verify (expect 2 rows: reserved boolean false, reserved_bike_no integer null):
--   select column_name, data_type, column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'queue_entries' and column_name in ('reserved', 'reserved_bike_no');
