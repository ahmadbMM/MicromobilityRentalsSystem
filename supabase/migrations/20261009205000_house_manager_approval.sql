-- ============================================================================
-- On the house, approved on the server (staff app round 2, 2026-10-09).
--
-- Until now a ride on the house was a plain table write from the page (paid = true, price = 0), so the
-- manager rule of Settings > Business (mgr_over + mgr_for.house + approvers, 20261009163000) and the
-- operator's PIN were the page's alone. This migration adds:
--
--  1. staff_set_house(p_booking_id, p_on, p_op, p_approval): the desk's door for a ride on the house.
--     Checks _pin_ok (the operator's PIN approval, as void/refund/price do) and _mgr_ok('house', fare,
--     approval) (MANAGER_REQUIRED when the fare is over Settings' limit and the approval is not an
--     approver's), then writes paid = true, price = 0, pay_method/card_amount cleared. p_on = false puts
--     a house ride back to Pending at its fare (_fare_now). The fare is the row's price, or the fare the
--     ride would cost now when the row has none stored.
--  2. _house_guard(): BEFORE UPDATE trigger on queue_entries. A signed-in non-admin staff account whose
--     direct update (or a definer RPC acting for it, e.g. staff_checkin) turns a row INTO "on the house"
--     (paid and price 0, from anything else) is refused with MANAGER_REQUIRED when Settings' manager rule
--     covers that fare - unless the change came through staff_set_house, which sets the transaction-local
--     flag mm.house_ok. Nothing else is refused:
--       - below the limit, or with the manager rule off, the write goes through as before (the page still
--         asks the operator's PIN; the RPC checks it on the server);
--       - admins, the service role, cron, anon/customers (customer_create_booking etc.) are untouched;
--       - INSERTs are untouched (_apply_default_pay makes VIP and default-pay riders free on insert);
--       - EARNED free rides pass deliberately (memory: vip-tag, house-on-every-add): the VIP tag and an
--         account's default payment "on the house" (all types, or the row's type), for the holder's own
--         row (same name), via _house_earned(customer, name, type). They never need a manager each time.
--       - a bike owner's ride (type Own), a free community ride (event_kind community, not paid_ride),
--         a row already at 0 by its promo code (unchanged), and a fare of 0 pass too.
--     Re-saving a row that is already on the house is not a change into it and passes.
--
-- The page calls staff_set_house for every hand-chosen on-the-house (the pay menu, the booking modal's
-- buttons, the check-in's House choice, an Undo that puts a house ride back) and keeps its direct write
-- when the function is missing (before this migration). Deploy the page first, then apply this.
--
-- Rollback: drop trigger trg_house_guard on public.queue_entries; drop function public._house_guard();
--   drop function public.staff_set_house(text, boolean, text, text); drop function public._house_earned(text, text, text).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

-- VIP or an account whose default payment covers this type, for the holder's own row (the rule
-- _apply_default_pay applies on insert; the once-per-ride check is left to that trigger).
create or replace function public._house_earned(p_customer text, p_name text, p_type text)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select p_customer is not null and exists (
    select 1 from customers c
     where c.id = p_customer
       and lower(btrim(coalesce(c.name, ''))) = lower(btrim(coalesce(p_name, '')))
       and (_is_vip(c.id)
            or coalesce(c.default_pay, '') = 'house'
            or (coalesce(c.default_pay, '') like 'house:%'
                and coalesce(nullif(p_type, ''), 'Any') = any(string_to_array(substring(c.default_pay from 7), ',')))))
$$;
revoke execute on function public._house_earned(text, text, text) from public, anon, authenticated;

create or replace function public._house_guard()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare k text; pr boolean; amt numeric;
begin
  if not (coalesce(new.paid, false) and coalesce(new.price, 0) = 0) then return new; end if;   -- not on the house
  if coalesce(old.paid, false) and coalesce(old.price, 0) = 0 then return new; end if;        -- it already was
  if coalesce(current_setting('mm.house_ok', true), '') = '1' then return new; end if;         -- staff_set_house
  if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;                     -- service role, cron
  if not is_staff() or is_admin() then return new; end if;
  if coalesce(new.type_preference, '') = 'Own' then return new; end if;                        -- a bike owner rides free
  select coalesce(s.event_kind, ''), coalesce(s.paid_ride, false) into k, pr from sessions s where s.id = new.session_id;
  if k = 'community' and not pr then return new; end if;                                        -- a free ride
  if _house_earned(new.customer_id, new.name, new.type_preference) then return new; end if;    -- VIP / default payment
  if coalesce(new.promo_code, '') <> '' and old.price = 0
     and lower(new.promo_code) = lower(coalesce(old.promo_code, '')) then return new; end if;    -- free by its code
  amt := greatest(coalesce(old.price, 0), coalesce(_fare_now(new.session_id, new.id, new.type_preference), 0));
  if amt <= 0 or _mgr_ok('house', amt, null) then return new; end if;
  raise exception 'MANAGER_REQUIRED' using errcode = '42501',
    hint = 'A ride on the house over the limit in Settings > Business needs an approver: staff_set_house.';
end $$;
revoke execute on function public._house_guard() from public, anon, authenticated;

drop trigger if exists trg_house_guard on public.queue_entries;
-- named after trg_enforce_booking_price_upd so it sees the row as that trigger leaves it
create trigger trg_house_guard before update on public.queue_entries
  for each row execute function public._house_guard();

create or replace function public.staff_set_house(p_booking_id text, p_on boolean default true,
                                                  p_op text default null, p_approval text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; amt numeric; f numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into q from queue_entries where id = p_booking_id for update;
  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if coalesce(p_on, true) then
    if coalesce(q.paid, false) and coalesce(q.price, 0) = 0 then
      return jsonb_build_object('ok', true, 'id', q.id, 'noop', true);
    end if;
    amt := greatest(coalesce(q.price, 0), coalesce(_fare_now(q.session_id, q.id, q.type_preference), 0));
    if not _mgr_ok('house', amt, p_approval) then
      raise exception 'MANAGER_REQUIRED' using errcode = '42501';
    end if;
    perform set_config('mm.house_ok', '1', true);
    update queue_entries set paid = true, price = 0, pay_method = null, card_amount = null where id = q.id;
    perform set_config('mm.house_ok', '', true);
    return jsonb_build_object('ok', true, 'id', q.id, 'amount', amt, 'old_price', q.price, 'old_paid', q.paid);
  end if;
  if not (coalesce(q.paid, false) and coalesce(q.price, 0) = 0) then
    return jsonb_build_object('ok', true, 'id', q.id, 'noop', true);
  end if;
  f := coalesce(_fare_now(q.session_id, q.id, q.type_preference), 0);
  update queue_entries set paid = false, price = f, pay_method = null, card_amount = null where id = q.id;
  return jsonb_build_object('ok', true, 'id', q.id, 'price', f);
end $$;
revoke execute on function public.staff_set_house(text, boolean, text, text) from public, anon;
grant execute on function public.staff_set_house(text, boolean, text, text) to authenticated;

do $chk$
declare f text;
begin
  foreach f in array array['public._house_earned(text,text,text)', 'public._house_guard()',
                           'public.staff_set_house(text,boolean,text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.staff_set_house(text,boolean,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public._house_earned(text,text,text)', 'execute') then
    raise exception 'the house functions are open to the wrong roles';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_house_guard' and tgrelid = 'public.queue_entries'::regclass) then
    raise exception 'trg_house_guard is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009205000', 'house_manager_approval')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
