-- ============================================================================
-- A rider staff put on the house rides on the house however the booking is made (the owner,
-- 2026-09-29: "whenever [a rider] is added, it must apply on him the same that applies when he
-- books himself"). customers.default_pay ('house', or 'house:Road,Hybrid' for those types only) was
-- applied by customer_create_booking when riders book themselves, and by each staff screen on its
-- own; one screen (Community > Add rider) did not, so Rozana Albanawi, on the house, was added to a
-- Petromin night unpaid and _enforce_booking_price set her the fare. Now the database applies it to
-- every new booking, with customer_create_booking's rule exactly: the account's own name on the row
-- (a friend booked under the account pays), a type the perk covers, not already paid - then paid,
-- at 0. It runs before trg_enforce_booking_price (triggers fire in name order), which leaves a paid
-- row's price alone.
-- ============================================================================

create or replace function public._apply_default_pay()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare _dp text; _nm text; _house text;
begin
  if new.customer_id is null or coalesce(new.paid, false)
     or coalesce(new.status, '') in ('cancelled', 'removed') then
    return new;
  end if;
  select c.default_pay, c.name into _dp, _nm from customers c where c.id = new.customer_id;
  if coalesce(_dp, '') not like 'house%' then return new; end if;
  _house := case when _dp = 'house' then 'all' else substring(_dp from 7) end;
  if lower(btrim(coalesce(new.name, ''))) = lower(btrim(coalesce(_nm, '')))
     and (_house = 'all' or coalesce(nullif(new.type_preference, ''), 'Any') = any(string_to_array(_house, ','))) then
    new.paid := true;
    new.price := 0;
  end if;
  return new;
end $$;

revoke execute on function public._apply_default_pay() from public, anon, authenticated;

drop trigger if exists trg_apply_default_pay on public.queue_entries;
create trigger trg_apply_default_pay
  before insert on public.queue_entries
  for each row execute function public._apply_default_pay();
