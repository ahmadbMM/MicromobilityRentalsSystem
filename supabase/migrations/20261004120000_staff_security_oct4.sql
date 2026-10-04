-- ============================================================================
-- Staff security and server-side reliability (the 2026-10-04 audit, "fix them all").
--
--  1. _pin_ok_strict(p_op, p_approval): the approval rule for the account-level actions below.
--     With an operator name it is _pin_ok (a name with a PIN needs a live staff_pin_approve token;
--     a name off the team list only the account's own). With NO operator name it is true only
--     while no team member has a PIN at all - an older page that never sends the approval keeps
--     working until the first PIN is set, and no longer after. _pin_ok itself is unchanged
--     (a null p_op is still allowed there by design, for the RPCs that already use it).
--  2. staff_merge_customers and staff_delete_customer take an optional approval
--     (p_op text default null, p_approval text default null), checked with _pin_ok_strict after
--     the admin check (PIN_REQUIRED otherwise). The old signatures are dropped and recreated with
--     the extra defaulted arguments, so a deployed page calling {p_keep,p_drop,p_by} or {p_id}
--     still resolves. The bodies are copied from production (pg_get_functiondef, 2026-10-04).
--     staff_delete_customer already unlinks bookings and sales and deletes tags and push rows in
--     its one transaction; the page's own follow-up writes are gone with this release.
--  3. staff_purge_session(p_id, p_op, p_approval): deletes a session for good, admins only,
--     PIN-checked (_pin_ok_strict), and only a session already in Deleted Sessions (status
--     'deleted') that no queue_entries, cashier_sales or rider_registrations row names - cancelled
--     ones included (the owner, 2026-09-28: only EMPTY deleted sessions may be purged). Answers
--     {ok, purged:true} or {ok, purged:false, reason:'IN_USE'|'NOT_DELETED'|'NOT_FOUND'}. Replaces
--     the page's plain DELETE on sessions.
--  4. staff_checkin carries the payment: new optional arguments p_paid, p_price, p_pay_method,
--     p_card_amount, p_type, p_ride_group (null = unchanged; p_pay_method '' clears the method and
--     sets card_amount to p_card_amount; p_ride_group '' clears it), written in the same
--     transaction as the status, the bike, the assignment row and checked_in_at. p_bike_id may now
--     be null: the booking's own reserved bike(s) are claimed (available -> in-use, an assignment
--     each), or, when any of them is no longer available, the reservation is dropped and the rider
--     checks in without a bike (answer: reservation_dropped true). A null bike on a booking that is
--     already active is a no-op. The price triggers are untouched: staff updates keep the price
--     sent (as the page's own update did), and a free community ride is still forced to 0 by
--     _enforce_booking_price. The answer lists the bikes now held (bikes).
--  5. queue_entries_addons_price (BEFORE INSERT OR UPDATE OF addons): every add-on line gets the
--     price it was sold at, as "p" (the inventory price at the time), so a later price change does
--     not rewrite what a past booking cost. A "p" already on a line is never overwritten when staff
--     write it, or when the row already held that very line with that price; a "p" a customer's
--     page sends for a new line is replaced by the inventory price (a customer cannot price their
--     own add-ons). A line written as a bare id string becomes {"id","qty":1,"p"}. An item with no
--     inventory price gets no "p" (the page then reads the current price, as for older rows).
-- ============================================================================

-- ── 1. _pin_ok_strict ─────────────────────────────────────────────────────────────────────────
create or replace function public._pin_ok_strict(p_op text, p_approval text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if nullif(btrim(coalesce(p_op, '')), '') is null then
    -- No operator named: only while nobody on the team has a PIN (the page before approvals).
    return not exists (select 1 from team_members where pin_hash is not null);
  end if;
  return _pin_ok(p_op, p_approval);
end $function$;
revoke all on function public._pin_ok_strict(text, text) from public, anon, authenticated;

-- ── 2a. staff_delete_customer + approval ─────────────────────────────────────────────────────
drop function if exists public.staff_delete_customer(text);
create or replace function public.staff_delete_customer(p_id text, p_op text default null, p_approval text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_live int; v_bookings int := 0; v_sales int := 0; v_tags int := 0; v_push int := 0;
  v_flags int := 0; v_riders int := 0;
begin
  -- Admins only, as in the staff panel and in the customers table's own delete policy.
  if not is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  -- The operator's PIN approval (staff_pin_approve), 2026-10-04.
  if not _pin_ok_strict(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  -- The account row is locked first. A booking being made for it needs that row (its foreign
  -- key), so it waits here and then fails on the missing account, instead of landing between
  -- the check below and the delete.
  perform 1 from customers where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  select count(*) into v_live from queue_entries
   where customer_id = p_id and status in ('waiting', 'waitlist', 'active');
  if v_live > 0 then
    return jsonb_build_object('ok', false, 'error', 'LIVE_BOOKINGS', 'live', v_live);
  end if;
  -- Past bookings and sales stay, name and all, so rosters, close-outs and analytics read as
  -- they did; they only lose the link. Every row the server holds, not a date window.
  update queue_entries set customer_id = null where customer_id = p_id;
  get diagnostics v_bookings = row_count;
  update cashier_sales set customer_id = null where customer_id = p_id;
  get diagnostics v_sales = row_count;
  -- What was personal to the account goes with it. No key ties these two to customers.
  delete from customer_tags where customer_id = p_id;
  get diagnostics v_tags = row_count;
  delete from push_subscriptions where customer_id = p_id;
  get diagnostics v_push = row_count;
  -- The keys do the rest: customer_flags go with the account (on delete cascade) and a rider
  -- registration matched to it keeps its row with the match cleared (on delete set null).
  -- Counted first, so the answer says everything that moved.
  select count(*) into v_flags from customer_flags where customer_id = p_id;
  select count(*) into v_riders from rider_registrations where matched_customer_id = p_id;
  delete from customers where id = p_id;
  return jsonb_build_object('ok', true, 'bookings', v_bookings, 'sales', v_sales, 'tags', v_tags,
                            'push_subscriptions', v_push, 'flags', v_flags, 'rider_links', v_riders);
end $function$;
revoke all on function public.staff_delete_customer(text, text, text) from public, anon;
grant execute on function public.staff_delete_customer(text, text, text) to authenticated;

-- ── 2b. staff_merge_customers + approval ─────────────────────────────────────────────────────
drop function if exists public.staff_merge_customers(text, text, text);
create or replace function public.staff_merge_customers(p_keep text, p_drop text, p_by text default null,
                                                        p_op text default null, p_approval text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  k customers%rowtype; d customers%rowtype;
  mv jsonb := '{}'::jsonb; fl text[] := '{}'; ids text[]; m_id bigint;
  tags_moved text[] := '{}'; tags_dup text[] := '{}'; tg text;
  bd customer_badges%rowtype; bdg_moved text[] := '{}'; bdg_dup jsonb := '[]'::jsonb;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  -- The operator's PIN approval (staff_pin_approve), 2026-10-04.
  if not _pin_ok_strict(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if p_keep is null or p_drop is null or p_keep = p_drop then raise exception 'SAME_ACCOUNT' using errcode = '22023'; end if;
  -- both rows locked, lower id first, so two admins merging the same pair cannot cross
  if p_keep < p_drop then
    select * into k from customers where id = p_keep for update;
    select * into d from customers where id = p_drop for update;
  else
    select * into d from customers where id = p_drop for update;
    select * into k from customers where id = p_keep for update;
  end if;
  if k.id is null then raise exception 'NOT_FOUND: keep' using errcode = 'P0002'; end if;
  if d.id is null then raise exception 'NOT_FOUND: drop' using errcode = 'P0002'; end if;
  if k.merged_into is not null or d.merged_into is not null then raise exception 'ALREADY_MERGED' using errcode = '22023'; end if;

  with u as (update queue_entries set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('queue_entries', to_jsonb(ids));
  with u as (update cashier_sales set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('cashier_sales', to_jsonb(ids));
  with u as (update customer_notes set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('customer_notes', to_jsonb(ids));
  with u as (update customer_flags set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('customer_flags', to_jsonb(ids));
  with u as (update push_subscriptions set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('push_subscriptions', to_jsonb(ids));
  with u as (update rider_registrations set matched_customer_id = p_keep where matched_customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('rider_registrations', to_jsonb(ids));
  with u as (update ambassadors set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('ambassadors', to_jsonb(ids));
  with u as (update community_applications set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('community_applications', to_jsonb(ids));
  with u as (update learn_applications set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('learn_applications', to_jsonb(ids));
  with u as (update workshop_jobs set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('workshop_jobs', to_jsonb(ids));
  with u as (update site_messages set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('site_messages', to_jsonb(ids));
  with u as (update promo_codes set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('promo_codes', to_jsonb(ids));
  delete from customer_handoffs where customer_id = p_drop; -- two-minute sign-in codes: nothing to keep

  -- tags: a tag the keeper holds already is dropped, the others move (the primary key is (customer, tag))
  for tg in select tag_id from customer_tags where customer_id = p_drop loop
    if exists (select 1 from customer_tags where customer_id = p_keep and tag_id = tg) then
      delete from customer_tags where customer_id = p_drop and tag_id = tg;
      tags_dup := tags_dup || tg;
    else
      update customer_tags set customer_id = p_keep where customer_id = p_drop and tag_id = tg;
      tags_moved := tags_moved || tg;
    end if;
  end loop;
  mv := mv || jsonb_build_object('tags_moved', to_jsonb(tags_moved), 'tags_dup', to_jsonb(tags_dup));

  -- badges, the same way; a badge the keeper holds already is kept whole in the record for unmerge
  for bd in select * from customer_badges where customer_id = p_drop loop
    if exists (select 1 from customer_badges where customer_id = p_keep and badge_id = bd.badge_id) then
      delete from customer_badges where customer_id = p_drop and badge_id = bd.badge_id;
      bdg_dup := bdg_dup || jsonb_build_array(to_jsonb(bd));
    else
      update customer_badges set customer_id = p_keep where customer_id = p_drop and badge_id = bd.badge_id;
      bdg_moved := array_append(bdg_moved, bd.badge_id);
    end if;
  end loop;
  mv := mv || jsonb_build_object('badges_moved', to_jsonb(bdg_moved), 'badges_dup', bdg_dup);

  -- one-row-per-account records: moved only when the keeper has none
  if not exists (select 1 from customer_ig_followers where customer_id = p_keep)
     and exists (select 1 from customer_ig_followers where customer_id = p_drop) then
    update customer_ig_followers set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('ig_followers', true);
  end if;
  if not exists (select 1 from customer_owner_pwd where customer_id = p_keep)
     and exists (select 1 from customer_owner_pwd where customer_id = p_drop) then
    update customer_owner_pwd set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('owner_pwd', true);
  end if;

  -- what the keeper lacked, from the other
  if coalesce(k.height, 0) = 0 and coalesce(d.height, 0) > 0 then update customers set height = d.height where id = p_keep; fl := array_append(fl, 'height'); end if;
  if coalesce(k.gender, '') = '' and coalesce(d.gender, '') <> '' then update customers set gender = d.gender where id = p_keep; fl := array_append(fl, 'gender'); end if;
  if coalesce(k.birth_date, '') = '' and coalesce(d.birth_date, '') <> '' then update customers set birth_date = d.birth_date where id = p_keep; fl := array_append(fl, 'birth_date'); end if;
  if coalesce(k.country, '') = '' and coalesce(d.country, '') <> '' then update customers set country = d.country where id = p_keep; fl := array_append(fl, 'country'); end if;
  if coalesce(k.city, '') = '' and coalesce(d.city, '') <> '' then update customers set city = d.city where id = p_keep; fl := array_append(fl, 'city'); end if;
  if coalesce(k.nationality, '') = '' and coalesce(d.nationality, '') <> '' then update customers set nationality = d.nationality where id = p_keep; fl := array_append(fl, 'nationality'); end if;
  if coalesce(k.type_preference, '') = '' and coalesce(d.type_preference, '') <> '' then update customers set type_preference = d.type_preference where id = p_keep; fl := array_append(fl, 'type_preference'); end if;
  if coalesce(k.photo, '') = '' and coalesce(d.photo, '') <> '' then update customers set photo = d.photo where id = p_keep; fl := array_append(fl, 'photo'); end if;
  if coalesce(k.profession, '') = '' and coalesce(d.profession, '') <> '' then update customers set profession = d.profession where id = p_keep; fl := array_append(fl, 'profession'); end if;
  if coalesce(k.workplace, '') = '' and coalesce(d.workplace, '') <> '' then update customers set workplace = d.workplace where id = p_keep; fl := array_append(fl, 'workplace'); end if;
  if coalesce(k.heard_from, '') = '' and coalesce(d.heard_from, '') <> '' then update customers set heard_from = d.heard_from where id = p_keep; fl := array_append(fl, 'heard_from'); end if;
  if k.socials is null and d.socials is not null then update customers set socials = d.socials where id = p_keep; fl := array_append(fl, 'socials'); end if;

  update customers set merged_into = p_keep, session_token = null where id = p_drop;

  insert into customer_merges (keep_id, drop_id, keep_name, drop_name, moved, filled, merged_by)
    values (p_keep, p_drop, k.name, d.name, mv, to_jsonb(fl), p_by) returning id into m_id;
  return jsonb_build_object('ok', true, 'id', m_id, 'moved', mv, 'filled', to_jsonb(fl), 'keep_name', k.name, 'drop_name', d.name);
end $function$;
revoke all on function public.staff_merge_customers(text, text, text, text, text) from public, anon;
grant execute on function public.staff_merge_customers(text, text, text, text, text) to authenticated;

-- ── 3. staff_purge_session ───────────────────────────────────────────────────────────────────
create or replace function public.staff_purge_session(p_id text, p_op text default null, p_approval text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare s sessions%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if not _pin_ok_strict(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into s from sessions where id = p_id for update;
  if s.id is null then return jsonb_build_object('ok', true, 'purged', false, 'reason', 'NOT_FOUND'); end if;
  -- restored meanwhile: left alone
  if s.status is distinct from 'deleted' then return jsonb_build_object('ok', true, 'purged', false, 'reason', 'NOT_DELETED'); end if;
  -- any row naming the session, cancelled ones included, keeps it in Deleted Sessions
  if exists (select 1 from queue_entries where session_id = p_id)
     or exists (select 1 from cashier_sales where session_id = p_id)
     or exists (select 1 from rider_registrations where session_id = p_id) then
    return jsonb_build_object('ok', true, 'purged', false, 'reason', 'IN_USE');
  end if;
  delete from sessions where id = p_id;
  return jsonb_build_object('ok', true, 'purged', true, 'id', p_id);
end $function$;
revoke all on function public.staff_purge_session(text, text, text) from public, anon;
grant execute on function public.staff_purge_session(text, text, text) to authenticated;

-- ── 4. staff_checkin carries the payment ────────────────────────────────────────────────────
drop function if exists public.staff_checkin(text, text);
create or replace function public.staff_checkin(p_booking_id text, p_bike_id text default null,
    p_paid boolean default null, p_price numeric default null, p_pay_method text default null,
    p_card_amount numeric default null, p_type text default null, p_ride_group text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare q public.queue_entries%rowtype; b public.bikes%rowtype; a_id uuid; first_a uuid; holder text;
        got text[] := '{}'; rsv text[]; bid text; dropped boolean := false; st text; new_bike text;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_price is not null and (p_price < 0 or p_price > 1000) then raise exception 'PRICE_RANGE' using errcode = '22023'; end if;
  if p_card_amount is not null and (p_card_amount < 0 or p_card_amount > 100000) then raise exception 'PRICE_RANGE' using errcode = '22023'; end if;
  if p_pay_method is not null and p_pay_method !~ '^[a-z_]{0,24}$' then raise exception 'BAD_PAY_METHOD: %', p_pay_method using errcode = '22023'; end if;

  select * into q from public.queue_entries where id = p_booking_id for update;
  if not found then raise exception 'BOOKING_NOT_FOUND: no booking %', p_booking_id; end if;
  if p_bike_id is not null then
    select * into b from public.bikes where id = p_bike_id for update;
    if not found then raise exception 'BIKE_NOT_FOUND: no bike %', p_bike_id; end if;
  end if;

  if q.status = 'active' then
    if p_bike_id is null then return jsonb_build_object('ok', true, 'noop', true); end if;
    if exists (select 1 from public.bike_assignments where booking_id = q.id and bike_id = b.id and returned_at is null) then
      return jsonb_build_object('ok', true, 'noop', true);
    end if;
    if q.assigned_bike_id = b.id then
      -- checked in before assignments existed on this very bike: record it, then it is a no-op
      insert into public.bike_assignments (booking_id, bike_id, assigned_by) values (q.id, b.id, auth.uid())
      on conflict (bike_id) where returned_at is null do nothing;
      return jsonb_build_object('ok', true, 'noop', true);
    end if;
    raise exception 'BAD_BOOKING_STATE: #% is already on another bike - use staff_swap_bike', coalesce(q.queue_num::text, q.id);
  end if;
  if q.status not in ('waiting','waitlist') then
    raise exception 'BAD_BOOKING_STATE: #% is %, not waiting', coalesce(q.queue_num::text, q.id), q.status;
  end if;

  if p_bike_id is not null then
    if b.status <> 'available' then
      select e.name into holder from public.bike_assignments ba join public.queue_entries e on e.id = ba.booking_id
        where ba.bike_id = b.id and ba.returned_at is null limit 1;
      raise exception 'BIKE_UNAVAILABLE: bike % is %', coalesce(b.bike_number::text, b.name),
        b.status || case when holder is not null then ' (with ' || holder || ')' else '' end;
    end if;
    got := array[b.id];
    new_bike := b.id;
  else
    -- The booking's own reservation: every reserved bike is claimed, or (one is gone) none is.
    rsv := coalesce(public._bike_ids(q.assigned_bike_id), '{}'::text[]);
    foreach bid in array rsv loop
      select status into st from public.bikes where id = bid for update;
      if st is distinct from 'available' then dropped := true; exit; end if;
    end loop;
    if dropped then got := '{}'; new_bike := null; else got := rsv; new_bike := q.assigned_bike_id; end if;
  end if;

  if array_length(got, 1) is not null then
    update public.bikes set status = 'in-use' where id = any(got);
  end if;
  update public.queue_entries
     set status = 'active',
         assigned_bike_id = new_bike,
         checked_in_at = public._iso_now(),
         paid = coalesce(p_paid, paid),
         price = coalesce(p_price, price),
         pay_method = case when p_pay_method is null then pay_method else nullif(p_pay_method, '') end,
         card_amount = case when p_pay_method is null then card_amount else p_card_amount end,
         type_preference = coalesce(nullif(p_type, ''), type_preference),
         ride_group = case when p_ride_group is null then ride_group else nullif(p_ride_group, '') end
   where id = q.id;
  foreach bid in array got loop
    insert into public.bike_assignments (booking_id, bike_id, assigned_by)
      values (q.id, bid, auth.uid()) returning id into a_id;
    first_a := coalesce(first_a, a_id);
  end loop;
  return jsonb_build_object('ok', true, 'noop', false, 'assignment_id', first_a,
                            'bikes', to_jsonb(got), 'reservation_dropped', dropped);
end $function$;
revoke all on function public.staff_checkin(text, text, boolean, numeric, text, numeric, text, text) from public, anon;
grant execute on function public.staff_checkin(text, text, boolean, numeric, text, numeric, text, text) to authenticated;

-- ── 5. Add-on price snapshot ─────────────────────────────────────────────────────────────────
create or replace function public._addons_price_snapshot()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare j jsonb; old_j jsonb := '[]'::jsonb; x jsonb; o jsonb; outv jsonb := '[]'::jsonb;
        v_id text; pr numeric; changed boolean := false; staff boolean;
begin
  if new.addons is null or btrim(new.addons) in ('', '[]') then return new; end if;
  begin j := new.addons::jsonb; exception when others then return new; end; -- the CHECK refuses it
  if jsonb_typeof(j) <> 'array' then return new; end if;
  staff := (select is_staff());
  if tg_op = 'UPDATE' and old.addons is not null and btrim(old.addons) <> '' then
    begin old_j := old.addons::jsonb; exception when others then old_j := '[]'::jsonb; end;
    if jsonb_typeof(old_j) <> 'array' then old_j := '[]'::jsonb; end if;
  end if;
  for x in select value from jsonb_array_elements(j) loop
    if jsonb_typeof(x) = 'string' then
      o := jsonb_build_object('id', x #>> '{}', 'qty', 1); changed := true;
    elsif jsonb_typeof(x) = 'object' then
      o := x;
    else
      outv := outv || jsonb_build_array(x); continue;
    end if;
    v_id := o ->> 'id';
    if o ? 'p' then
      if jsonb_typeof(o -> 'p') <> 'number' then
        o := o - 'p'; changed := true;
      elsif not staff and not exists (
          select 1 from jsonb_array_elements(old_j) y
           where jsonb_typeof(y) = 'object' and y ->> 'id' = v_id and y -> 'p' = o -> 'p') then
        o := o - 'p'; changed := true; -- a customer's page never prices its own add-on
      end if;
    end if;
    if not (o ? 'p') then
      pr := null;
      select i.price into pr from inventory i where i.id = v_id;
      if pr is not null then o := o || jsonb_build_object('p', pr); changed := true; end if;
    end if;
    outv := outv || jsonb_build_array(o);
  end loop;
  if changed then new.addons := outv::text; end if;
  return new;
end $function$;
revoke all on function public._addons_price_snapshot() from public, anon, authenticated;
drop trigger if exists queue_entries_addons_price on public.queue_entries;
create trigger queue_entries_addons_price before insert or update of addons on public.queue_entries
  for each row execute function public._addons_price_snapshot();
