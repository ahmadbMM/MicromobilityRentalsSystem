-- The Saturday Social Ride's two groups (the owner, 2026-10-02): a rider rides with the
-- Beginners (20 km, to the Jeddah Yacht Club and back) or the Intermediates (40 km, to just before
-- the Marine Sciences roundabout and back). The rider picks one when booking; staff pick or change
-- it when adding a rider and at check-in, and the Bookings table shows it (Beg / Int).
--
-- queue_entries.ride_group: 'beg' | 'int', null where the ride has no groups (and on rows from
-- before this). Table-level grants already cover a new column, and staff_sync / my_bookings read
-- whole rows, so both carry it without a change.
--
-- customer_create_booking lists its insert columns one by one, so it learns the field here. It is
-- rebuilt from its own live definition (pg_get_functiondef keeps SECURITY DEFINER and the
-- search_path; see supabase/checks/security-attributes.sql), and refuses to run if the text it
-- edits is not there.

alter table public.queue_entries add column if not exists ride_group text;
alter table public.queue_entries drop constraint if exists queue_entries_ride_group_chk;
alter table public.queue_entries add constraint queue_entries_ride_group_chk
  check (ride_group is null or ride_group in ('beg','int'));

do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure);
  if position('ride_group' in d) > 0 then return; end if;   -- already applied
  n := replace(d,
    E'      waiver_at, waiver_version\n    ) values (',
    E'      waiver_at, waiver_version, ride_group\n    ) values (');
  if n = d then raise exception 'customer_create_booking: insert column list not found'; end if;
  d := n;
  n := replace(d,
    E'      _wv\n    )\n    returning',
    E'      _wv,\n      case when it->>''ride_group'' in (''beg'',''int'') then it->>''ride_group'' end\n    )\n    returning');
  if n = d then raise exception 'customer_create_booking: insert values not found'; end if;
  execute n;
end $mig$;


-- Check: the function still runs as its owner and now writes the group.
do $chk$
begin
  if not (select prosecdef from pg_proc where oid = 'public.customer_create_booking(text,text,jsonb)'::regprocedure) then
    raise exception 'customer_create_booking lost SECURITY DEFINER';
  end if;
  if position('ride_group' in pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'customer_create_booking does not write ride_group';
  end if;
end $chk$;
