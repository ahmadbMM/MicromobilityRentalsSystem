-- When a rating was given (the owner, 2026-10-03: "show all ratings by date and time and sort them in
-- order of most recent"). queue_entries.rated_at is stamped by a trigger whenever a rating is saved -
-- rating_exp, rating_bike or rating_detail changes to something - whichever way it arrives (the rider's
-- customer_booking_update from the app or the website, or a staff device's direct write), so no
-- function is rebuilt. Ratings given before this have no time; staff see their ride's checkout time
-- instead, marked as approximate.
--
-- Rollback: drop trigger if exists trg_stamp_rated_at on public.queue_entries;
--           drop function if exists public._stamp_rated_at();
--           alter table public.queue_entries drop column if exists rated_at;
-- Idempotent.

alter table public.queue_entries add column if not exists rated_at timestamptz;

create or replace function public._stamp_rated_at()
returns trigger
language plpgsql
set search_path = public
as $fn$
begin
  if (new.rating_exp is distinct from old.rating_exp
      or new.rating_bike is distinct from old.rating_bike
      or new.rating_detail is distinct from old.rating_detail)
     and (new.rating_exp is not null or new.rating_bike is not null or new.rating_detail is not null) then
    new.rated_at := now();
  end if;
  return new;
end $fn$;

revoke all on function public._stamp_rated_at() from public, anon, authenticated;

drop trigger if exists trg_stamp_rated_at on public.queue_entries;
create trigger trg_stamp_rated_at
  before update of rating_exp, rating_bike, rating_detail on public.queue_entries
  for each row execute function public._stamp_rated_at();
