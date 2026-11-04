-- ============================================================================
-- Close one bike type instead of the whole session (the owner, 2026-11-03: "add an option to close a specific bike
-- type for reservation instead of closing the whole session").
--
--  1. sessions.closed_types: the types riders can no longer book on this session. Empty by default, so nothing changes
--     until staff close something. list_sessions returns setof sessions, so riders' pages read it with the rest.
--  2. _type_closed_guard (BEFORE INSERT OR UPDATE OF type_preference, session_id on queue_entries): a customer's row on
--     a closed type is refused with TYPE_CLOSED, through every door (customer_create_booking, customer_booking_update,
--     a move to another date). Staff pass, as they do the booking window. A row keeping its type and session passes, so
--     a booking made before the closure can still be edited, and a waitlisted rider can still be moved up.
--     Named trg_ so it runs after the triggers that rewrite the type (queue_entries_comm_no_carbon,
--     queue_entries_vip_no_carbon; triggers fire by name) and checks the type the row will really hold.
--
-- Safe before or after the app: no session has a closed type until staff close one.
-- Undo: drop trigger trg_type_closed_guard on public.queue_entries; drop function public._type_closed_guard();
--       alter table public.sessions drop column closed_types;
--
-- Verify (read only):
--   select column_default, is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'sessions' and column_name = 'closed_types';   -- '{}'::text[], NO
--   select tgname, tgenabled from pg_trigger where tgname = 'trg_type_closed_guard';                -- 1 row, O
--   select prosecdef from pg_proc where proname = '_type_closed_guard';                             -- false
--   select closed_types from public.list_sessions(null, null) limit 1;                              -- {}
-- ============================================================================
begin;

alter table public.sessions add column if not exists closed_types text[] not null default '{}';
alter table public.sessions drop constraint if exists sessions_closed_types_known;
alter table public.sessions add constraint sessions_closed_types_known
  check (closed_types <@ array['Road', 'Hybrid', 'Mountain', 'Road Carbon', 'Gravel', 'Kids', 'Own']::text[]);

create or replace function public._type_closed_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if is_staff() then return new; end if;
  if tg_op = 'UPDATE' and new.type_preference is not distinct from old.type_preference
     and new.session_id is not distinct from old.session_id then
    return new;
  end if;
  if exists (select 1 from sessions s where s.id = new.session_id and new.type_preference = any(s.closed_types)) then
    raise exception 'TYPE_CLOSED' using errcode = 'P0001', detail = new.type_preference;
  end if;
  return new;
end $function$;
revoke execute on function public._type_closed_guard() from public, anon, authenticated;

drop trigger if exists trg_type_closed_guard on public.queue_entries;
create trigger trg_type_closed_guard
  before insert or update of type_preference, session_id on public.queue_entries
  for each row execute function public._type_closed_guard();

insert into supabase_migrations.schema_migrations (version, name)
values ('20261103210000', 'close_bike_type')
on conflict (version) do nothing;

commit;
