-- ============================================================================
-- Session templates that reach their rides, and the booking window (2026-09-28).
--
--  1. sessions.template_id - the staff template (staff_options session_templates) a ride was made
--     from. A template saved again offers to bring its future rides into line; the app does that
--     with ordinary session updates, this column only says which rides.
--  2. The booking window: site_content 'booking.window' = {"days": N, "at": "HH:MM"} (Riyadh),
--     set by admins on Sessions. A rider may not book a ride more than N days ahead, and on the day
--     a ride comes within reach only from the hour given. _booking_window_guard refuses the insert
--     (NOT_OPEN_YET) for anyone but staff; no window, or a malformed one, holds nobody.
--
-- Rollback:
--   drop trigger if exists queue_entries_booking_window on public.queue_entries;
--   drop function if exists public._booking_window_guard();
--   alter table public.sessions drop column if exists template_id;
-- Idempotent.
-- ============================================================================
alter table public.sessions add column if not exists template_id text;

create or replace function public._booking_window_guard()
returns trigger
language plpgsql set search_path to 'public'
as $$
declare w jsonb; days int; at_t text; sd date; today date; open_day date; now_t text;
begin
  if is_staff() then return new; end if;
  if new.status is distinct from 'waiting' and new.status is distinct from 'waitlist' then return new; end if;
  select value into w from site_content where key = 'booking.window';
  if w is null or jsonb_typeof(w) <> 'object' then return new; end if;
  begin days := (w->>'days')::int; exception when others then days := null; end;
  if days is null or days < 0 then return new; end if;
  at_t := nullif(w->>'at', '');
  begin sd := new.session_date::date; exception when others then return new; end;
  today := (now() at time zone 'Asia/Riyadh')::date;
  open_day := sd - days;
  if open_day > today then
    raise exception 'NOT_OPEN_YET: booking for % opens on %', new.session_date, open_day using errcode = 'P0001';
  end if;
  if open_day = today and at_t ~ '^\d{2}:\d{2}$' then
    now_t := to_char(now() at time zone 'Asia/Riyadh', 'HH24:MI');
    if now_t < at_t then
      raise exception 'NOT_OPEN_YET: booking for % opens at %', new.session_date, at_t using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
revoke all on function public._booking_window_guard() from public, anon, authenticated;
drop trigger if exists queue_entries_booking_window on public.queue_entries;
create trigger queue_entries_booking_window before insert on public.queue_entries
  for each row execute function public._booking_window_guard();
