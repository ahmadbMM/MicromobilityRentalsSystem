-- ============================================================================
-- Ride lead (2026-11-06, the owner: "add a way to assign ride lead on customers that already have a bookings so it
-- counts towards their account"; picked "Lead tally + Marshal badge", set from the booking on Bookings).
--
--   queue_entries.led_at  text, ISO UTC: when staff marked this rider as the ride's lead; null = not the lead.
--
-- Staff set and clear it from the booking's menu (a plain update, as desk_note). The rider reads it on their own
-- bookings through my_bookings (it returns the whole row), and the app counts the nights led where the rider was
-- checked in (on the bike or done): "Rides led" on the account, and the Marshal ladder (Marshal 1, Senior Marshal
-- 10, Chief Marshal 25, Clerk of the Course 50, Race Director 100) earned from that count. Staff can still give
-- those badges by hand, as before.
--
-- _led_at_guard: only staff write it. A customer or anon writing the table (RLS already keeps them off booking
-- rows) keeps the old value; the customer RPCs (security definer) name their columns and never touch it.
--
-- Safe before or after the app: until this runs the menu says "Waiting for the database update".
--
-- Rollback:
--   drop trigger if exists queue_entries_led_at_guard on public.queue_entries;
--   drop function if exists public._led_at_guard();
--   alter table public.queue_entries drop column if exists led_at;
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

alter table public.queue_entries add column if not exists led_at text;
comment on column public.queue_entries.led_at is
  'Ride lead: when staff marked this rider as the ride''s lead, ISO UTC; null = not the lead (20261106130000).';

create or replace function public._led_at_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if current_user in ('anon', 'authenticated') and not coalesce((select is_staff()), false) then
    new.led_at := case when tg_op = 'UPDATE' then old.led_at else null end;
  end if;
  return new;
end $function$;
revoke execute on function public._led_at_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_led_at_guard on public.queue_entries;
create trigger queue_entries_led_at_guard
  before insert or update of led_at on public.queue_entries
  for each row execute function public._led_at_guard();

do $chk$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'queue_entries' and column_name = 'led_at') then
    raise exception 'queue_entries.led_at missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'queue_entries_led_at_guard' and not tgisinternal) then
    raise exception 'queue_entries_led_at_guard missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261106130000', 'ride_lead')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
