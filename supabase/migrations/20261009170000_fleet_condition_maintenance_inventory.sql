-- ============================================================================
-- Fleet condition, maintenance log, stock movements and workshop payment (2026-10-09, staff app
-- deep research items M9-M13; the fleet was deleted and a new one is coming).
--
--  1. Returns that need a look. A bike returned "Needs a check" (or, with the business setting
--     "Every returned bike needs a check" on, any bike returned OK) goes to the new bike status
--     'check' instead of 'available'. Every desk path hands out only 'available' bikes, and
--     staff_checkin / staff_swap_bike already refuse any other status (BIKE_UNAVAILABLE), so a
--     bike in 'check' cannot be assigned until a staff member clears it (Checked, OK ->
--     available; Send to maintenance -> maintenance). bikes_check_hold refuses any write that
--     takes a 'check' bike straight to 'in-use' (BIKE_NEEDS_CHECK), whichever path tries.
--     staff_return keeps its signature and attributes (header copied from 20260922124000) and
--     answers held:true when it put a bike on check. The setting is read by _return_check_all()
--     from staff_options: the 'biz' row ({return_check_all:true} or [{...}]) or a
--     'biz.return_check_all' row ([true]).
--     bike_assignments.return_photo: the URL of a photo taken at return (the photos bucket);
--     return_by_name: the operator who returned it (the desk writes both after staff_return).
--  2. bike_service_log: what was done to a bike (service / repair / inspection), the parts
--     (inventory item, qty, unit cost), labour cost, downtime from/to and the mechanic.
--     Staff read and add; admins delete. Updates and deletes are audited (_audit_row).
--  3. inventory_moves: every stock movement with its reason (received, sold, damaged, expired,
--     team_use, stock_take, correction, workshop_part, maintenance_part), unit cost, supplier,
--     expiry date, note, a reference (a workshop job, a service-log entry) and the count after.
--     Written by:
--       staff_inventory_move(item, delta, reason, note, ref, by)   - one movement, atomic
--       staff_inventory_receive(item, qty, unit_cost, supplier, expires_on, note, by)
--         - stock in; the item's cost becomes the weighted average of what was on the shelf and
--           what came in; the supplier and the nearest expiry date are kept on the item
--       staff_inventory_set_count(item, count, by)                  - a stock-take count
--     Staff may change only a movement's reason and note afterwards (the desk's reason chips).
--     inventory.supplier and inventory.expires_on are NOT readable through the table (it has
--     column grants since 20260922124000, and a new column gets none): staff read them, with
--     the cost, through staff_inventory_extras().
--  4. workshop_jobs: mechanic (a staff member's name), parts_used (items taken from stock:
--     [{id,name,qty,cost,price}]), paid_at and paid_receipt (the till receipt that took the
--     payment).
--
-- Rollback:
--   drop function if exists public.staff_inventory_extras(), public.staff_inventory_set_count(text,integer,text),
--     public.staff_inventory_receive(text,integer,numeric,text,date,text,text),
--     public.staff_inventory_move(text,integer,text,text,text,text);
--   drop table if exists public.inventory_moves; drop table if exists public.bike_service_log;
--   alter table public.inventory drop column if exists supplier, drop column if exists expires_on;
--   alter table public.workshop_jobs drop column if exists mechanic, drop column if exists parts_used,
--     drop column if exists paid_at, drop column if exists paid_receipt;
--   alter table public.bike_assignments drop column if exists return_photo, drop column if exists return_by_name;
--   drop trigger if exists bikes_check_hold on public.bikes; drop function if exists public._bikes_check_hold();
--   re-create staff_return from 20260922124000; drop function if exists public._return_check_all();
--   update public.bikes set status = 'available' where status = 'check';
-- Run supabase/checks/security-attributes.sql after applying.
-- Idempotent.
-- ============================================================================

begin;

-- ── 1. Returns that need a look ──────────────────────────────────────────────────────────────
alter table public.bike_assignments add column if not exists return_photo text;
alter table public.bike_assignments add column if not exists return_by_name text;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'bike_assignments_return_by_name_check') then
    alter table public.bike_assignments add constraint bike_assignments_return_by_name_check
      check (return_by_name is null or length(return_by_name) <= 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bike_assignments_return_photo_check') then
    alter table public.bike_assignments add constraint bike_assignments_return_photo_check
      check (return_photo is null or (length(return_photo) <= 500 and return_photo ~ '^https://'));
  end if;
end $c$;

create or replace function public._return_check_all()
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select coalesce(
    (select case jsonb_typeof(items)
              when 'object' then items ->> 'return_check_all'
              when 'array' then items -> 0 ->> 'return_check_all'
            end
       from public.staff_options where key = 'biz'),
    (select items ->> 0 from public.staff_options
      where key = 'biz.return_check_all' and jsonb_typeof(items) = 'array'),
    'false') in ('true', '1');
$function$;
revoke all on function public._return_check_all() from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.staff_return(p_booking_id text, p_return_condition text DEFAULT 'ok'::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q public.queue_entries%rowtype; bid text; n int := 0; v_status text; v_held boolean := false;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_return_condition not in ('ok','needs_check','damaged') then
    raise exception 'BAD_CONDITION: % (ok | needs_check | damaged)', p_return_condition;
  end if;

  select * into q from public.queue_entries where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND: no booking %', p_booking_id; end if;
  if q.status = 'done' and not exists (select 1 from public.bike_assignments where booking_id = q.id and returned_at is null) then
    return jsonb_build_object('ok', true, 'noop', true);
  end if;
  if q.status <> 'active' then
    raise exception 'BAD_BOOKING_STATE: #% is %, not on a bike', coalesce(q.queue_num::text, q.id), q.status;
  end if;

  -- Damaged: maintenance. Needs a check (or every return, when the business says so): 'check',
  -- which nobody can hand out until staff clear it. Otherwise back in the pool.
  v_status := case
    when p_return_condition = 'damaged' then 'maintenance'
    when p_return_condition = 'needs_check' or public._return_check_all() then 'check'
    else 'available' end;

  -- The bikes to free: every open assignment, plus the legacy pointer for a ride that
  -- went out before assignments existed and was not caught by the backfill.
  for bid in
    select distinct x.bike_id from (
      select bike_id from public.bike_assignments where booking_id = q.id and returned_at is null
      union
      select q.assigned_bike_id where q.assigned_bike_id is not null and q.assigned_bike_id not like '[%'
      union
      select arr from jsonb_array_elements_text(case when q.assigned_bike_id like '[%' then q.assigned_bike_id::jsonb else '[]'::jsonb end) as arr
    ) x order by 1
  loop
    perform 1 from public.bikes where id = bid for update;
    update public.bikes
       set status = v_status,
           -- the day in Jeddah, not the server's UTC day (a return before 03:00 is still today)
           retired_date = case when v_status = 'maintenance'
                               then to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD') else retired_date end
     where id = bid;
    n := n + 1;
    if v_status = 'check' then v_held := true; end if;
  end loop;

  update public.bike_assignments
     set returned_at = now(), returned_by = auth.uid(), return_condition = p_return_condition, return_notes = p_notes
   where booking_id = q.id and returned_at is null;
  update public.queue_entries set status = 'done', checked_out_at = public._iso_now() where id = q.id;
  return jsonb_build_object('ok', true, 'noop', false, 'bikes_freed', n, 'held', v_held, 'bike_status', v_status);
end $function$;
revoke execute on function public.staff_return(text,text,text) from public, anon;
grant execute on function public.staff_return(text,text,text) to authenticated;

-- A bike on check goes out only after someone clears it, whichever write tries.
create or replace function public._bikes_check_hold()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
begin
  raise exception 'BIKE_NEEDS_CHECK: bike % needs a check before it goes out', coalesce(old.bike_number::text, old.name)
    using errcode = 'P0001';
end $function$;
revoke all on function public._bikes_check_hold() from public, anon, authenticated;
drop trigger if exists bikes_check_hold on public.bikes;
create trigger bikes_check_hold before update of status on public.bikes
  for each row when (old.status = 'check' and new.status = 'in-use')
  execute function public._bikes_check_hold();

-- ── 2. The maintenance log ───────────────────────────────────────────────────────────────────
create table if not exists public.bike_service_log (
  id           bigint generated always as identity primary key,
  bike_id      text not null references public.bikes(id) on delete cascade,
  at           timestamptz not null default now(),
  kind         text not null default 'service' check (kind in ('service','repair','inspection')),
  work         text not null default '' check (length(work) <= 1000),
  parts        jsonb not null default '[]'::jsonb
               check (jsonb_typeof(parts) = 'array' and jsonb_array_length(parts) <= 30),
  parts_cost   numeric(10,2) not null default 0 check (parts_cost between 0 and 100000),
  labour_cost  numeric(10,2) not null default 0 check (labour_cost between 0 and 100000),
  down_from    timestamptz,
  down_to      timestamptz,
  mechanic     text check (mechanic is null or length(mechanic) <= 120),
  by_name      text check (by_name is null or length(by_name) <= 120),
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  constraint bike_service_log_down_order check (down_to is null or down_from is null or down_to >= down_from)
);
create index if not exists bike_service_log_bike_idx on public.bike_service_log (bike_id, at desc);
alter table public.bike_service_log enable row level security;
drop policy if exists "service log staff read" on public.bike_service_log;
create policy "service log staff read" on public.bike_service_log for select to authenticated using ((select public.is_staff()));
drop policy if exists "service log staff insert" on public.bike_service_log;
create policy "service log staff insert" on public.bike_service_log for insert to authenticated with check ((select public.is_staff()));
drop policy if exists "service log staff update" on public.bike_service_log;
create policy "service log staff update" on public.bike_service_log for update to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "service log admin delete" on public.bike_service_log;
create policy "service log admin delete" on public.bike_service_log for delete to authenticated using ((select public.is_admin()));
revoke all on public.bike_service_log from anon, authenticated;
grant select, insert, update, delete on public.bike_service_log to authenticated;
drop trigger if exists bike_service_log_audit on public.bike_service_log;
create trigger bike_service_log_audit after update or delete on public.bike_service_log
  for each row execute function public._audit_row();

-- ── 3. Stock movements ───────────────────────────────────────────────────────────────────────
alter table public.inventory add column if not exists supplier text;
alter table public.inventory add column if not exists expires_on date;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_supplier_len') then
    alter table public.inventory add constraint inventory_supplier_len check (supplier is null or length(supplier) <= 120);
  end if;
end $c$;
-- The table has column grants (20260922124000): the new columns get none, so neither anon nor a
-- signed-in non-staff account reads them; staff_inventory_extras() does. Writes keep the table's
-- UPDATE grant and its is_staff() policy.
revoke select (supplier, expires_on) on public.inventory from anon, authenticated;

create table if not exists public.inventory_moves (
  id          bigint generated always as identity primary key,
  item_id     text not null references public.inventory(id) on delete cascade,
  at          timestamptz not null default now(),
  delta       integer not null check (delta <> 0 and abs(delta) <= 100000),
  reason      text not null check (reason in ('received','sold','damaged','expired','team_use','stock_take',
                                               'correction','workshop_part','maintenance_part')),
  unit_cost   numeric(10,2) check (unit_cost is null or unit_cost between 0 and 100000),
  supplier    text check (supplier is null or length(supplier) <= 120),
  expires_on  date,
  note        text check (note is null or length(note) <= 300),
  ref         text check (ref is null or length(ref) <= 80),
  qty_after   integer,
  by_name     text check (by_name is null or length(by_name) <= 120),
  created_by  uuid default auth.uid()
);
create index if not exists inventory_moves_item_idx on public.inventory_moves (item_id, at desc);
create index if not exists inventory_moves_at_idx on public.inventory_moves (at desc);
alter table public.inventory_moves enable row level security;
drop policy if exists "moves staff read" on public.inventory_moves;
create policy "moves staff read" on public.inventory_moves for select to authenticated using ((select public.is_staff()));
drop policy if exists "moves staff reason" on public.inventory_moves;
create policy "moves staff reason" on public.inventory_moves for update to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
revoke all on public.inventory_moves from anon, authenticated;
grant select on public.inventory_moves to authenticated;
grant update (reason, note) on public.inventory_moves to authenticated;

create or replace function public.staff_inventory_move(p_item text, p_delta integer, p_reason text,
    p_note text default null, p_ref text default null, p_by text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_qty int; v_id bigint;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_delta is null or p_delta = 0 then return jsonb_build_object('ok', true, 'noop', true); end if;
  if abs(p_delta) > 100000 then raise exception 'BAD_QTY' using errcode = '22023'; end if;
  if p_reason is null or p_reason not in ('received','sold','damaged','expired','team_use','stock_take',
                                           'correction','workshop_part','maintenance_part') then
    raise exception 'BAD_REASON: %', p_reason using errcode = '22023';
  end if;
  update public.inventory set qty = coalesce(qty, 0) + p_delta, updated_at = public._iso_now()
   where id = p_item returning qty into v_qty;
  if not found then raise exception 'ITEM_NOT_FOUND: %', p_item using errcode = 'P0002'; end if;
  insert into public.inventory_moves (item_id, delta, reason, note, ref, qty_after, by_name)
  values (p_item, p_delta, p_reason, nullif(left(btrim(coalesce(p_note, '')), 300), ''),
          nullif(left(btrim(coalesce(p_ref, '')), 80), ''), v_qty, nullif(left(btrim(coalesce(p_by, '')), 120), ''))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'qty', v_qty, 'move_id', v_id);
end $function$;
revoke all on function public.staff_inventory_move(text,integer,text,text,text,text) from public, anon;
grant execute on function public.staff_inventory_move(text,integer,text,text,text,text) to authenticated;

create or replace function public.staff_inventory_receive(p_item text, p_qty integer, p_unit_cost numeric default null,
    p_supplier text default null, p_expires_on date default null, p_note text default null, p_by text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare i public.inventory%rowtype; v_on_shelf int; v_cost numeric; v_exp date; v_id bigint; v_sup text;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_qty is null or p_qty <= 0 or p_qty > 100000 then raise exception 'BAD_QTY' using errcode = '22023'; end if;
  if p_unit_cost is not null and (p_unit_cost < 0 or p_unit_cost > 100000) then raise exception 'BAD_COST' using errcode = '22023'; end if;
  select * into i from public.inventory where id = p_item for update;
  if not found then raise exception 'ITEM_NOT_FOUND: %', p_item using errcode = 'P0002'; end if;
  v_on_shelf := greatest(coalesce(i.qty, 0), 0);
  -- The weighted average of what was on the shelf at its cost and what came in at its own.
  v_cost := case
    when p_unit_cost is null then i.cost
    when i.cost is null or v_on_shelf = 0 then round(p_unit_cost, 2)
    else round((v_on_shelf * i.cost + p_qty * p_unit_cost) / (v_on_shelf + p_qty), 2) end;
  -- The nearest expiry of what is on the shelf: an empty shelf takes the new batch's date.
  v_exp := case
    when p_expires_on is null then (case when v_on_shelf = 0 then null else i.expires_on end)
    when v_on_shelf = 0 or i.expires_on is null then p_expires_on
    else least(i.expires_on, p_expires_on) end;
  v_sup := nullif(left(btrim(coalesce(p_supplier, '')), 120), '');
  update public.inventory
     set qty = coalesce(qty, 0) + p_qty, cost = v_cost, expires_on = v_exp,
         supplier = coalesce(v_sup, supplier), updated_at = public._iso_now()
   where id = p_item returning qty into v_on_shelf;
  insert into public.inventory_moves (item_id, delta, reason, unit_cost, supplier, expires_on, note, qty_after, by_name)
  values (p_item, p_qty, 'received', p_unit_cost, v_sup, p_expires_on,
          nullif(left(btrim(coalesce(p_note, '')), 300), ''), v_on_shelf, nullif(left(btrim(coalesce(p_by, '')), 120), ''))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'qty', v_on_shelf, 'cost', v_cost, 'expires_on', v_exp, 'move_id', v_id);
end $function$;
revoke all on function public.staff_inventory_receive(text,integer,numeric,text,date,text,text) from public, anon;
grant execute on function public.staff_inventory_receive(text,integer,numeric,text,date,text,text) to authenticated;

create or replace function public.staff_inventory_set_count(p_item text, p_count integer, p_by text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_was int; v_id bigint;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_count is null or p_count < 0 or p_count > 100000 then raise exception 'BAD_QTY' using errcode = '22023'; end if;
  select coalesce(qty, 0) into v_was from public.inventory where id = p_item for update;
  if not found then raise exception 'ITEM_NOT_FOUND: %', p_item using errcode = 'P0002'; end if;
  if v_was = p_count then return jsonb_build_object('ok', true, 'noop', true, 'qty', p_count); end if;
  update public.inventory set qty = p_count, updated_at = public._iso_now() where id = p_item;
  insert into public.inventory_moves (item_id, delta, reason, qty_after, by_name)
  values (p_item, p_count - v_was, 'stock_take', p_count, nullif(left(btrim(coalesce(p_by, '')), 120), ''))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'qty', p_count, 'was', v_was, 'move_id', v_id);
end $function$;
revoke all on function public.staff_inventory_set_count(text,integer,text) from public, anon;
grant execute on function public.staff_inventory_set_count(text,integer,text) to authenticated;

create or replace function public.staff_inventory_extras()
 returns table(id text, cost numeric, supplier text, expires_on date)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return query select i.id, i.cost, i.supplier, i.expires_on from public.inventory i;
end $function$;
revoke all on function public.staff_inventory_extras() from public, anon;
grant execute on function public.staff_inventory_extras() to authenticated;

-- ── 4. The workshop: mechanic, parts from stock, payment ─────────────────────────────────────
alter table public.workshop_jobs add column if not exists mechanic text;
alter table public.workshop_jobs add column if not exists parts_used jsonb not null default '[]'::jsonb;
alter table public.workshop_jobs add column if not exists paid_at timestamptz;
alter table public.workshop_jobs add column if not exists paid_receipt text;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'workshop_jobs_mechanic_check') then
    alter table public.workshop_jobs add constraint workshop_jobs_mechanic_check check (mechanic is null or length(mechanic) <= 120);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workshop_jobs_parts_used_check') then
    alter table public.workshop_jobs add constraint workshop_jobs_parts_used_check
      check (jsonb_typeof(parts_used) = 'array' and jsonb_array_length(parts_used) <= 30);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'workshop_jobs_paid_receipt_check') then
    alter table public.workshop_jobs add constraint workshop_jobs_paid_receipt_check check (paid_receipt is null or length(paid_receipt) <= 80);
  end if;
end $c$;

-- ── Checks ───────────────────────────────────────────────────────────────────────────────────
do $chk$
begin
  if has_table_privilege('anon', 'public.bike_service_log', 'select')
     or has_table_privilege('anon', 'public.inventory_moves', 'select') then
    raise exception 'anon can read the fleet tables';
  end if;
  if has_table_privilege('authenticated', 'public.inventory_moves', 'insert') then
    raise exception 'inventory_moves must be written by the functions only';
  end if;
  if has_column_privilege('anon', 'public.inventory', 'supplier', 'select')
     or has_column_privilege('authenticated', 'public.inventory', 'supplier', 'select') then
    raise exception 'inventory.supplier is readable through the table';
  end if;
  if not (select bool_and(prosecdef) from pg_proc where pronamespace = 'public'::regnamespace
            and proname in ('staff_return','staff_inventory_move','staff_inventory_receive',
                            'staff_inventory_set_count','staff_inventory_extras','_return_check_all')) then
    raise exception 'a fleet function lost SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', 'public.staff_inventory_move(text,integer,text,text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.staff_return(text,text,text)', 'execute') then
    raise exception 'anon can call a staff function';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'bikes_check_hold' and not tgisinternal) then
    raise exception 'bikes_check_hold is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009170000', 'fleet_condition_maintenance_inventory')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
