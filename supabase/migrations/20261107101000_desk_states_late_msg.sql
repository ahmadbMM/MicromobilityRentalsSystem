-- ============================================================================
-- Check-in states and the "Running late?" message (2026-11-07, the staff review of 2026-11-06: OT08, BK13).
--
--   queue_entries.staff_state   text: a check-in state staff put on the booking from its menu ("Late, on the
--                               way", "Needs size swap"), the id of one of the states an admin defines in
--                               Settings > Business > Check-in states (staff_options 'biz' -> checkin_states:
--                               [{id, label, color, counts: 'in' | 'noshow'}]). A label on top of the booking's
--                               status: it never changes the status itself. null = none.
--   queue_entries.late_msg_at   timestamptz: when staff last sent the rider the "Running late?" WhatsApp message
--                               from Bookings > Reminders (a third kind beside 24 h and 2 h). Close out names the
--                               no-shows who were messaged and never came ("messaged, no reply").
--
-- Both are staff-only: _desk_marks_guard keeps the old value when a customer or anon writes the row (RLS already
-- keeps them off booking rows; the customer RPCs are security definer and name their columns). staff_sync and
-- the staff reads return the whole row (to_jsonb), so the desk sees both with no other change.
--
-- Safe before or after the app: until this runs the booking menu's "Check-in state" says "Waiting for the
-- database update", and a "Running late?" message is remembered on the sending device only.
--
-- Rollback:
--   drop trigger if exists queue_entries_desk_marks_guard on public.queue_entries;
--   drop function if exists public._desk_marks_guard();
--   alter table public.queue_entries drop column if exists staff_state;
--   alter table public.queue_entries drop column if exists late_msg_at;
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

alter table public.queue_entries add column if not exists staff_state text;
alter table public.queue_entries add column if not exists late_msg_at timestamptz;

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'queue_entries_staff_state_chk') then
    alter table public.queue_entries add constraint queue_entries_staff_state_chk
      check (staff_state is null or staff_state ~ '^[a-z0-9_]{1,40}$');
  end if;
end $c$;

comment on column public.queue_entries.staff_state is
  'Check-in state staff set on the booking (an id from staff_options biz.checkin_states); a label over the status, null = none (20261107101000).';
comment on column public.queue_entries.late_msg_at is
  'When staff last sent this booking the "Running late?" WhatsApp message (20261107101000).';

create or replace function public._desk_marks_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if current_user in ('anon', 'authenticated') and not coalesce((select is_staff()), false) then
    if tg_op = 'UPDATE' then
      new.staff_state := old.staff_state;
      new.late_msg_at := old.late_msg_at;
    else
      new.staff_state := null;
      new.late_msg_at := null;
    end if;
  end if;
  return new;
end $function$;
revoke execute on function public._desk_marks_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_desk_marks_guard on public.queue_entries;
create trigger queue_entries_desk_marks_guard
  before insert or update of staff_state, late_msg_at on public.queue_entries
  for each row execute function public._desk_marks_guard();

do $chk$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'queue_entries'
         and column_name in ('staff_state', 'late_msg_at')) <> 2 then
    raise exception 'queue_entries.staff_state / late_msg_at missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'queue_entries_desk_marks_guard' and not tgisinternal) then
    raise exception 'queue_entries_desk_marks_guard missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261107101000', 'desk_states_late_msg')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- ── Read-only checks ────────────────────────────────────────────────────────────────────────
-- select column_name, data_type from information_schema.columns
--  where table_schema = 'public' and table_name = 'queue_entries' and column_name in ('staff_state', 'late_msg_at');
-- select tgname, tgenabled from pg_trigger where tgname = 'queue_entries_desk_marks_guard';
-- select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'queue_entries_staff_state_chk';
-- select staff_state, count(*) from public.queue_entries where staff_state is not null group by 1;
-- select count(*) from public.queue_entries where late_msg_at is not null;
