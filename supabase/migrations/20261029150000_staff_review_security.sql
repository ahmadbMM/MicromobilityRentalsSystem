-- ============================================================================
-- Free-ride doors and account security, from the staff panel review (2026-10-29, batch 2 P09/P15).
--
-- P09: every free-ride door behind the same approval as one ride on the house (operator PIN, and over
-- Settings' manager limit a manager: _pin_ok + _mgr_ok, as staff_set_house does).
--
-- 1. VIP (S07-community2-01). The tag makes every ride of its holder free, every bike type, for good;
--    any staff account could give it with one tap, to hundreds at once from Act on selection, with no PIN,
--    no manager and no record of who did it.
--    a. staff_set_vip(customers[], on, starts_at, expires_at, op, approval): gives the tag (permanent, or
--       for a window, a lapsed grant of it giving way) or takes it back, for one account or many. Any
--       staff account; PIN for both; a grant over Settings' limit needs a manager. The amount is the
--       dearest ride the tag makes free (the highest fare in ride_prices, Own aside): a VIP rides every
--       type free. Sets the transaction flag mm.vip_ok around its writes; added_by is the operator.
--    b. _vip_tag_guard (BEFORE INSERT, UPDATE, DELETE on customer_tags): a signed-in non-admin staff write
--       of tag_vip without that flag is refused (VIP_APPROVAL, P0001 with a sentence: a page loaded before
--       this change shows it as written). An update that changes only a note passes.
--       Admins, the service role, cron, migrations and customers (who cannot write the table) pass, as
--       they did; so does every other tag.
--    c. _tag_audit_row (AFTER INSERT, UPDATE, DELETE on customer_tags): every grant, change and take-back
--       of any tag goes to audit_log in _audit_row's shape (tbl 'customer_tags', row_id = the account,
--       changed = {column: {old, new}}; a delete the old row; actor and actor_email by their defaults: the
--       signed-in account). _audit_row itself does not fit: the table has no id column and it would write
--       an insert as an update. The tag note is left out (_purge_old clears notes when it anonymises an
--       account; logging that update would keep the note it clears), and so is updated_at.
-- 2. Default payment on the house (S02-core2-02). customers_admin_cols (20260928200000) already refuses a
--    non-admin change of default_pay or hidden_types (ADMIN_ONLY); admins set an account free for good with
--    no PIN.
--    a. staff_set_default_pay(customer, value, op, approval): admins and managers (ROLE_REFUSED otherwise);
--       PIN for any change, and into 'house' / 'house:<types>' the manager rule, the amount being the
--       dearest fare the value makes free. Sets mm.defpay_ok around its update.
--    b. _customers_admin_cols, rebuilt: a default_pay change made under mm.defpay_ok passes; everything
--       else as before (hidden_types stays admins' alone). This is the BEFORE UPDATE OF default_pay
--       guard: a non-admin staff change into 'house%' without the flag is refused, as any other was.
--    c. _default_pay_insert_guard (BEFORE INSERT on customers): the other door - a staff insert of an
--       account already on the house - is refused for a non-admin (HOUSE_APPROVAL).
-- 3. The walk-up waitlist (S01-core1-07). Give bike inserted the booking already paid at 0, and
--    _house_guard watches updates only. _house_insert_guard (BEFORE INSERT on queue_entries, named after
--    trg_enforce_booking_price and trg_apply_default_pay so it sees the row as they leave it) refuses a
--    signed-in non-admin staff insert of a ride on the house over Settings' limit (MANAGER_REQUIRED), with
--    _house_guard's exemptions: the staff_set_house flag, earned (VIP or default payment, own row:
--    _house_earned), type Own, a free community ride, a fare of 0, and on an insert "free by its code" is
--    a valid code that takes the whole fare off (100%, or a flat amount at least the fare). _house_guard
--    itself is not touched (20261028120200, pending, rebuilds it). The page now inserts the booking
--    Pending at its fare and asks staff_set_house, so the PIN and the manager are checked on the server.
--
-- P15: account and staff security.
--
-- 4. Customer temporary password (S03-core3-13). staff_set_customer_temp_password checked is_staff()
--    alone: a cashier or mechanic token could set any rider's password and sign in as them. Rebuilt: an
--    admin, or a manager, front desk or ride leader whose edit list holds Bookings (_staff_mod('queue',
--    true); the Owner role only looks), else ROLE_REFUSED. A reset now writes a staff_actions line that
--    names the account (kind 'pwd', entity 'customer', its id) whatever page or call made it. The session
--    token still rotates, so every device signed in to the account is signed out (it already did).
--    staff_set_customer_password calls it, so it takes the same check.
-- 5. A staff password reset signs that account out everywhere (S13-open-items-10, S12-team-settings-07).
--    _staff_reset_signout (AFTER UPDATE OF must_change_pwd on staff, when it is set true - only
--    staff_reset_password does that) deletes the account's auth.sessions rows (their refresh tokens go
--    with them), as staff_set_disabled does. staff_reset_password itself is not touched. A JWT already
--    issued stays valid until it expires (about an hour).
-- 6. No ID documents for deposits (S03-core3-17, S10-money-11, S13-open-items-11; the owner's rule of
--    2026-10-23). _deposit_no_id (BEFORE INSERT on deposits) refuses method 'id_document'; rows already
--    held keep it (a settle updates them, so this is no CHECK). Skipped when the table is not there.
-- 7. Gender is audited (S07-community2-04): customers_audit_upd also fires on gender (gender decides who
--    may book men-only and women-only sessions since 20261027150000). Same _audit_row.
--
-- Proof these are the live definitions (md5 of the body between `as $$` and `$$` read from production,
-- against the repo text, Python hashlib):
--   staff_set_customer_temp_password(text,text)  7c04b1ea989d7ce4fb7b2c4152ebd972 = the body of
--                                                20260929120000_staff_temp_password.sql (542 characters)
--   _customers_admin_cols()                      559f6e3ec0ad4be553f02fd20070a6a8 = the body of
--                                                20260928200000_staff_guardrails.sql (315 characters), invoker
--   Called, not changed: _mgr_ok b8d7aae61c669c761642a5b28ea7930f (20261028120000), _house_earned
--   9431fd4f14b7eea10d674fc4fe818a55 (20261009205000), _audit_row 236de1eec1ffcfc8fd9c521e3a0c04e7
--   (20260928200000), _pin_ok, _fare_now, _promo_valid, _staff_mod, is_staff, is_admin.
-- Once applied, the bodies read (md5 of prosrc; the check at the end compares them; no body has a whole-line
-- comment, so a copy pasted through an editor that drops those still matches): staff_set_vip
-- 2cc4ab2b81900778df998285b2a6e832, staff_set_default_pay e354cc85f2021820fab3daaf27f99eeb, _vip_tag_guard
-- cba4f9300a963babd755c6c92cf0bc97, _tag_audit_row c5d5d970746ed0c9c5251b49bd0e9cff, _default_pay_insert_guard
-- 823e6fbbed90def256129977dab219f7, _house_insert_guard 35f543d29b9c9d1b6502de2dda361cef,
-- staff_set_customer_temp_password 2c34b756c3ac7cc1f108309119205af3, _staff_reset_signout
-- 5297dce3ca9d6b854cc5ab94988eed0b, _deposit_no_id ea3395f11df40875ab78782c7a08fff7, _customers_admin_cols
-- 8de281a9e809dfc777ee2ddc1be76afa. Tried on a local PostgreSQL 17 with stand-ins for the tables and the
-- functions above: every refusal and pass described here came out as written, a second run changes nothing,
-- and a database without the deposits table takes it too.
-- Headers are copied from those migrations; every new definer function has search_path public, is
-- revoked from public/anon/authenticated, and only the two RPCs the page calls are granted to
-- authenticated (each checks is_staff() and its role itself). All listed in
-- supabase/checks/security-attributes.sql.
--
-- Rollback (in this order):
--   drop trigger if exists customer_tags_vip_guard on public.customer_tags;
--   drop trigger if exists customer_tags_audit on public.customer_tags;
--   drop trigger if exists customers_default_pay_insert_guard on public.customers;
--   drop trigger if exists trg_house_insert_guard on public.queue_entries;
--   drop trigger if exists deposits_no_id_document on public.deposits;
--   drop trigger if exists staff_reset_signout on public.staff;
--   drop function if exists public.staff_set_vip(text[], boolean, bigint, bigint, text, text);
--   drop function if exists public.staff_set_default_pay(text, text, text, text);
--   drop function if exists public._vip_tag_guard(), public._tag_audit_row(), public._default_pay_insert_guard(),
--     public._house_insert_guard(), public._deposit_no_id(), public._staff_reset_signout();
--   re-run the _customers_admin_cols block of 20260928200000_staff_guardrails.sql, the function of
--   20260929120000_staff_temp_password.sql, and the customers_audit_upd trigger of 20260928200000;
--   take the new lines out of supabase/checks/security-attributes.sql. audit_log rows stay.
-- Deploy the page first (it falls back to the old writes until the functions exist). Not during a ride
-- night (about 18:00-23:00 Riyadh): the triggers take short locks on queue_entries and customers.
-- Idempotent. Then run supabase/checks/security-attributes.sql.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1a. staff_set_vip ─────────────────────────────────────────────────────────────────────────
create or replace function public.staff_set_vip(p_customers text[], p_on boolean default true,
                                                p_starts_at bigint default null, p_expires_at bigint default null,
                                                p_op text default null, p_approval text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $fn$
declare
  v_ids text[]; v_amt numeric := 0; v_by text; v_rows jsonb; v_gone text[];
  v_now bigint := (extract(epoch from now()) * 1000)::bigint;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if coalesce(cardinality(p_customers), 0) > 5000 then raise exception 'TOO_MANY' using errcode = '22023'; end if;
  select array_agg(distinct c.id) into v_ids from customers c where c.id = any(coalesce(p_customers, '{}'::text[]));
  if v_ids is null then return jsonb_build_object('ok', true, 'rows', '[]'::jsonb, 'ids', '[]'::jsonb); end if;
  if coalesce(p_on, true) and p_expires_at is not null and p_expires_at <= greatest(coalesce(p_starts_at, v_now), v_now) then
    raise exception 'BAD_WINDOW' using errcode = '22023';
  end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if coalesce(p_on, true) then
    select coalesce(max(r.price), 0) into v_amt from ride_prices r where r.type <> 'Own';
    if not _mgr_ok('house', v_amt, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
    v_by := left(coalesce(nullif(btrim(coalesce(p_op, '')), ''),
                          (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()), 'staff'), 60);
    perform set_config('mm.vip_ok', '1', true);
    delete from customer_tags
     where tag_id = 'tag_vip' and customer_id = any(v_ids) and expires_at is not null and expires_at <= v_now;
    with ins as (
      insert into customer_tags (customer_id, tag_id, added_by, added_at, starts_at, expires_at)
      select i, 'tag_vip', v_by, v_now, p_starts_at, p_expires_at from unnest(v_ids) i
      on conflict (customer_id, tag_id) do nothing
      returning *)
    select coalesce(jsonb_agg(to_jsonb(ins)), '[]'::jsonb) into v_rows from ins;
    perform set_config('mm.vip_ok', '', true);
    return jsonb_build_object('ok', true, 'amount', v_amt, 'rows', v_rows);
  end if;
  perform set_config('mm.vip_ok', '1', true);
  with del as (delete from customer_tags where tag_id = 'tag_vip' and customer_id = any(v_ids) returning customer_id)
  select coalesce(array_agg(customer_id), '{}'::text[]) into v_gone from del;
  perform set_config('mm.vip_ok', '', true);
  return jsonb_build_object('ok', true, 'ids', to_jsonb(v_gone));
end $fn$;
revoke all on function public.staff_set_vip(text[], boolean, bigint, bigint, text, text) from public, anon, authenticated;
grant execute on function public.staff_set_vip(text[], boolean, bigint, bigint, text, text) to authenticated;

-- ── 1b. the VIP tag is written through staff_set_vip ──────────────────────────────────────────
create or replace function public._vip_tag_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare v boolean;
begin
  if tg_op = 'INSERT' then
    v := new.tag_id = 'tag_vip';
  elsif tg_op = 'DELETE' then
    v := old.tag_id = 'tag_vip';
  else
    v := (new.tag_id = 'tag_vip' or old.tag_id = 'tag_vip')
         and (new.customer_id is distinct from old.customer_id or new.tag_id is distinct from old.tag_id
              or new.starts_at is distinct from old.starts_at or new.expires_at is distinct from old.expires_at);
  end if;
  if coalesce(v, false)
     and coalesce(current_setting('mm.vip_ok', true), '') <> '1'      -- staff_set_vip
     and coalesce(auth.role(), '') = 'authenticated' then             -- not the service role, cron or a migration
    if is_staff() and not is_admin() then
      raise exception 'VIP_APPROVAL: giving or taking the VIP tag asks the on-the-house approval now. Reload the page and try again.'
        using errcode = 'P0001', hint = 'staff_set_vip';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $fn$;
revoke all on function public._vip_tag_guard() from public, anon, authenticated;
drop trigger if exists customer_tags_vip_guard on public.customer_tags;
create trigger customer_tags_vip_guard
  before insert or update or delete on public.customer_tags
  for each row execute function public._vip_tag_guard();

-- ── 1c. every tag change in the audit trail ───────────────────────────────────────────────────
create or replace function public._tag_audit_row()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare o jsonb := '{}'::jsonb; n jsonb; ch jsonb := '{}'::jsonb; k text;
  hide text[] := array['note', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    insert into audit_log (tbl, row_id, op, changed)
    values ('customer_tags', old.customer_id, 'DELETE', to_jsonb(old) - hide);
    return null;
  end if;
  if tg_op = 'UPDATE' then
    o := to_jsonb(old) - hide;
    n := to_jsonb(new) - hide;
  else
    n := jsonb_strip_nulls(to_jsonb(new)) - hide;
  end if;
  for k in select key from jsonb_each(n) loop
    if n -> k is distinct from o -> k then
      ch := ch || jsonb_build_object(k, jsonb_build_object('old', o -> k, 'new', n -> k));
    end if;
  end loop;
  if ch = '{}'::jsonb then return null; end if;
  if not ch ? 'tag_id' then
    ch := ch || jsonb_build_object('tag_id', jsonb_build_object('old', o -> 'tag_id', 'new', n -> 'tag_id'));
  end if;
  insert into audit_log (tbl, row_id, op, changed) values ('customer_tags', new.customer_id, tg_op, ch);
  return null;
end $fn$;
revoke all on function public._tag_audit_row() from public, anon, authenticated;
drop trigger if exists customer_tags_audit on public.customer_tags;
create trigger customer_tags_audit
  after insert or update or delete on public.customer_tags
  for each row execute function public._tag_audit_row();

-- ── 2a. staff_set_default_pay ─────────────────────────────────────────────────────────────────
create or replace function public.staff_set_default_pay(p_customer_id text, p_value text,
                                                        p_op text default null, p_approval text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $fn$
declare c customers%rowtype; v text := nullif(btrim(coalesce(p_value, '')), ''); v_amt numeric := 0;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null
                   and s.role in ('admin', 'manager')) then
    raise exception 'ROLE_REFUSED' using errcode = '42501';
  end if;
  if v is not null and v <> 'house' and v !~ '^house:[A-Za-z][A-Za-z ]{0,30}(,[A-Za-z][A-Za-z ]{0,30})*$' then
    raise exception 'BAD_VALUE' using errcode = '22023';
  end if;
  select * into c from customers where id = p_customer_id for update;
  if c.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if c.default_pay is not distinct from v then return jsonb_build_object('ok', true, 'id', c.id, 'noop', true); end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if v like 'house%' then
    select coalesce(max(r.price), 0) into v_amt from ride_prices r
     where r.type <> 'Own' and (v = 'house' or r.type = any(string_to_array(substring(v from 7), ',')));
    if not _mgr_ok('house', v_amt, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  end if;
  perform set_config('mm.defpay_ok', '1', true);
  update customers set default_pay = v where id = c.id;
  perform set_config('mm.defpay_ok', '', true);
  return jsonb_build_object('ok', true, 'id', c.id, 'default_pay', v, 'amount', v_amt);
end $fn$;
revoke all on function public.staff_set_default_pay(text, text, text, text) from public, anon, authenticated;
grant execute on function public.staff_set_default_pay(text, text, text, text) to authenticated;

-- ── 2b. _customers_admin_cols: the change staff_set_default_pay makes passes ─────────────────
-- Rebuilt from 20260928200000 (live md5 559f6e3ec0ad4be553f02fd20070a6a8); header copied (invoker,
-- search_path public, pg_temp). The trigger customers_admin_cols keeps pointing at it.
create or replace function public._customers_admin_cols()
returns trigger
language plpgsql set search_path to 'public', 'pg_temp'
as $$
begin
  if (new.default_pay is distinct from old.default_pay
      and coalesce(current_setting('mm.defpay_ok', true), '') <> '1')
     or new.hidden_types is distinct from old.hidden_types then
    if coalesce(current_setting('request.jwt.claims', true), '') <> '' and not is_admin() then
      raise exception 'ADMIN_ONLY' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public._customers_admin_cols() from public, anon, authenticated;
-- the trigger as 20260928200000 made it, stated again so the guard is there whatever happened since
drop trigger if exists customers_admin_cols on public.customers;
create trigger customers_admin_cols before update of default_pay, hidden_types on public.customers
  for each row execute function public._customers_admin_cols();

-- ── 2c. an account inserted on the house ──────────────────────────────────────────────────────
create or replace function public._default_pay_insert_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  if coalesce(new.default_pay, '') like 'house%'
     and coalesce(current_setting('mm.defpay_ok', true), '') <> '1'
     and coalesce(auth.role(), '') = 'authenticated' then
    if is_staff() and not is_admin() then
      raise exception 'HOUSE_APPROVAL: an account on the house is set in its editor, with the on-the-house approval.'
        using errcode = 'P0001', hint = 'staff_set_default_pay';
    end if;
  end if;
  return new;
end $fn$;
revoke all on function public._default_pay_insert_guard() from public, anon, authenticated;
drop trigger if exists customers_default_pay_insert_guard on public.customers;
create trigger customers_default_pay_insert_guard
  before insert on public.customers
  for each row execute function public._default_pay_insert_guard();

-- ── 3. a booking inserted on the house ────────────────────────────────────────────────────────
create or replace function public._house_insert_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare k text; pr boolean; amt numeric;
begin
  if not (coalesce(new.paid, false) and coalesce(new.price, 0) = 0) then return new; end if;   -- not on the house
  if coalesce(current_setting('mm.house_ok', true), '') = '1' then return new; end if;         -- staff_set_house
  if coalesce(auth.role(), '') <> 'authenticated' then return new; end if;                     -- service role, cron, customers
  if not is_staff() or is_admin() then return new; end if;
  if coalesce(new.type_preference, '') = 'Own' then return new; end if;                        -- a bike owner rides free
  select coalesce(s.event_kind, ''), coalesce(s.paid_ride, false) into k, pr from sessions s where s.id = new.session_id;
  if k = 'community' and not pr then return new; end if;                                        -- a free ride
  if _house_earned(new.customer_id, new.name, new.type_preference) then return new; end if;    -- VIP / default payment
  amt := coalesce(_fare_now(new.session_id, new.id, new.type_preference), 0);
  if amt <= 0 then return new; end if;                                                          -- a fare of 0
  if coalesce(new.promo_code, '') <> '' and _promo_valid(new.promo_code, new.customer_id)
     and exists (select 1 from promo_codes c
                  where lower(c.code) = lower(new.promo_code)
                    and (c.applies_to is null or c.applies_to = new.type_preference)
                    and ((c.kind = 'flat' and c.value >= amt) or (c.kind is distinct from 'flat' and c.value >= 100))) then
    return new;                                                                                 -- free by its code
  end if;
  if _mgr_ok('house', amt, null) then return new; end if;
  raise exception 'MANAGER_REQUIRED' using errcode = '42501',
    hint = 'A ride on the house over the limit in Settings > Business needs an approver: insert it pending, then staff_set_house.';
end $fn$;
revoke all on function public._house_insert_guard() from public, anon, authenticated;
drop trigger if exists trg_house_insert_guard on public.queue_entries;
create trigger trg_house_insert_guard
  before insert on public.queue_entries
  for each row execute function public._house_insert_guard();

-- ── 4. staff_set_customer_temp_password: the roles that change Bookings, and a line naming the account ──
-- Rebuilt from 20260929120000 (live md5 7c04b1ea989d7ce4fb7b2c4152ebd972); header copied.
create or replace function public.staff_set_customer_temp_password(p_customer_id text, p_new_pwd text)
returns boolean
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare n int; v_name text; v_who text;
begin
  if not is_staff() then return false; end if;
  if not (is_admin() or (_staff_mod('queue', true)
          and exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null
                        and s.role in ('manager', 'frontdesk', 'leader')))) then
    raise exception 'ROLE_REFUSED' using errcode = '42501';
  end if;
  if length(coalesce(p_new_pwd, '')) < 8 or p_new_pwd !~ '[A-Z]' or p_new_pwd !~ '[0-9]' then return false; end if;
  perform set_config('mm.temp_pwd', '1', true);
  update customers
     set password_hash   = crypt(p_new_pwd, gen_salt('bf', 10)),
         session_token   = encode(gen_random_bytes(24), 'hex'),
         must_change_pwd = true
   where id = p_customer_id
  returning name into v_name;
  get diagnostics n = row_count;
  perform set_config('mm.temp_pwd', '', true);
  if n > 0 then
    select coalesce(nullif(btrim(s.display_name), ''), u.email) into v_who
      from staff s left join auth.users u on u.id = s.user_id where s.user_id = auth.uid();
    insert into staff_actions (at, action, who, device, view, user_id, kind, entity, entity_id)
    values (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            left('Temporary password set for ' || coalesce(nullif(btrim(v_name), ''), p_customer_id), 300),
            left(coalesce(v_who, 'staff'), 80), 'server', 'customers', auth.uid(), 'pwd', 'customer', left(p_customer_id, 200));
  end if;
  return n > 0;
end $$;
revoke all on function public.staff_set_customer_temp_password(text, text) from public, anon;
grant execute on function public.staff_set_customer_temp_password(text, text) to authenticated;

-- ── 5. a staff password reset signs the account out everywhere ────────────────────────────────
create or replace function public._staff_reset_signout()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
begin
  delete from auth.sessions where user_id = new.user_id;
  return null;
end $fn$;
revoke all on function public._staff_reset_signout() from public, anon, authenticated;
drop trigger if exists staff_reset_signout on public.staff;
create trigger staff_reset_signout
  after update of must_change_pwd on public.staff
  for each row when (new.must_change_pwd is true)
  execute function public._staff_reset_signout();

-- ── 6. no ID document taken as a deposit ──────────────────────────────────────────────────────
create or replace function public._deposit_no_id()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  if new.method = 'id_document' then
    raise exception 'NO_ID_DOCUMENT: MicroMobility does not keep ID documents or their numbers. Take the deposit as a card hold or cash.'
      using errcode = 'P0001';
  end if;
  return new;
end $fn$;
revoke all on function public._deposit_no_id() from public, anon, authenticated;
do $dep$
begin
  if to_regclass('public.deposits') is not null then
    execute 'drop trigger if exists deposits_no_id_document on public.deposits';
    execute 'create trigger deposits_no_id_document before insert on public.deposits
               for each row execute function public._deposit_no_id()';
  end if;
end $dep$;

-- ── 7. gender changes in the audit trail ──────────────────────────────────────────────────────
drop trigger if exists customers_audit_upd on public.customers;
create trigger customers_audit_upd
  after update of default_pay, hidden_types, merged_into, email, phone, name, gender on public.customers
  for each row
  when (old.default_pay is distinct from new.default_pay or old.hidden_types is distinct from new.hidden_types
        or old.merged_into is distinct from new.merged_into or old.email is distinct from new.email
        or old.phone is distinct from new.phone or old.name is distinct from new.name
        or old.gender is distinct from new.gender)
  execute function public._audit_row();

-- ── checks, inside the transaction ────────────────────────────────────────────────────────────
do $chk$
declare f regprocedure;
begin
  foreach f in array array['public.staff_set_vip(text[],boolean,bigint,bigint,text,text)'::regprocedure,
                           'public.staff_set_default_pay(text,text,text,text)'::regprocedure,
                           'public.staff_set_customer_temp_password(text,text)'::regprocedure,
                           'public._vip_tag_guard()'::regprocedure, 'public._tag_audit_row()'::regprocedure,
                           'public._default_pay_insert_guard()'::regprocedure, 'public._house_insert_guard()'::regprocedure,
                           'public._staff_reset_signout()'::regprocedure] loop
    if not exists (select 1 from pg_proc p where p.oid = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=public%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then
      raise exception '% is open to anon', f;
    end if;
  end loop;
  foreach f in array array['public._vip_tag_guard()'::regprocedure, 'public._tag_audit_row()'::regprocedure,
                           'public._default_pay_insert_guard()'::regprocedure, 'public._house_insert_guard()'::regprocedure,
                           'public._staff_reset_signout()'::regprocedure, 'public._deposit_no_id()'::regprocedure,
                           'public._customers_admin_cols()'::regprocedure] loop
    if has_function_privilege('authenticated', f, 'execute') or has_function_privilege('anon', f, 'execute') then
      raise exception '% is open to the wrong roles', f;
    end if;
  end loop;
  -- the two kept invoker on purpose, with their search_path
  foreach f in array array['public._customers_admin_cols()'::regprocedure, 'public._deposit_no_id()'::regprocedure] loop
    if exists (select 1 from pg_proc p where p.oid = f and p.prosecdef)
       or not exists (select 1 from pg_proc p where p.oid = f
                        and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=public%')) then
      raise exception '% is not invoker with its search_path', f;
    end if;
  end loop;
  if position('mm.defpay_ok' in (select prosrc from pg_proc where oid = 'public._customers_admin_cols()'::regprocedure)) = 0 then
    raise exception '_customers_admin_cols is not the 20261029150000 definition';
  end if;
  if position('ROLE_REFUSED' in (select prosrc from pg_proc where oid = 'public.staff_set_customer_temp_password(text,text)'::regprocedure)) = 0
     or position('session_token' in (select prosrc from pg_proc where oid = 'public.staff_set_customer_temp_password(text,text)'::regprocedure)) = 0 then
    raise exception 'staff_set_customer_temp_password is not the 20261029150000 definition';
  end if;
  if (select count(*) from pg_trigger t
       where not t.tgisinternal and t.tgenabled <> 'D'
         and ((t.tgrelid = 'public.customer_tags'::regclass and t.tgname in ('customer_tags_vip_guard', 'customer_tags_audit'))
           or (t.tgrelid = 'public.customers'::regclass and t.tgname in ('customers_default_pay_insert_guard', 'customers_admin_cols', 'customers_audit_upd'))
           or (t.tgrelid = 'public.queue_entries'::regclass and t.tgname = 'trg_house_insert_guard')
           or (t.tgrelid = 'public.staff'::regclass and t.tgname = 'staff_reset_signout'))) <> 7 then
    raise exception 'a trigger of 20261029150000 is missing';
  end if;
  if position('gender' in (select pg_get_triggerdef(t.oid) from pg_trigger t
                             where t.tgrelid = 'public.customers'::regclass and t.tgname = 'customers_audit_upd')) = 0 then
    raise exception 'customers_audit_upd does not watch gender';
  end if;
  if to_regclass('public.deposits') is not null then
    if not exists (select 1 from pg_trigger t where t.tgrelid = to_regclass('public.deposits') and t.tgname = 'deposits_no_id_document') then
      raise exception 'deposits_no_id_document is missing';
    end if;
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261029150000', 'staff_review_security')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- ── Check (read-only), after the commit: every line ok = true ─────────────────────────────────
select 'the two RPCs are definer, staff can call them, anon cannot' as what,
       (select bool_and(p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute')
                        and not has_function_privilege('anon', p.oid, 'execute'))
          from pg_proc p
         where p.oid in ('public.staff_set_vip(text[],boolean,bigint,bigint,text,text)'::regprocedure,
                         'public.staff_set_default_pay(text,text,text,text)'::regprocedure)) as ok
union all
select 'the trigger functions are closed to clients',
       (select bool_and(not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
          from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.proname in ('_vip_tag_guard', '_tag_audit_row', '_default_pay_insert_guard', '_house_insert_guard',
                             '_staff_reset_signout', '_deposit_no_id', '_customers_admin_cols'))
union all
select 'the temporary password asks the role and names the account',
       (select position('ROLE_REFUSED' in p.prosrc) > 0 and position('staff_actions' in p.prosrc) > 0 and p.prosecdef
          from pg_proc p where p.oid = 'public.staff_set_customer_temp_password(text,text)'::regprocedure)
union all
select 'the triggers are on',
       (select count(*) = 7 from pg_trigger t
         where not t.tgisinternal and t.tgenabled <> 'D'
           and t.tgname in ('customer_tags_vip_guard', 'customer_tags_audit', 'customers_default_pay_insert_guard',
                            'customers_admin_cols', 'customers_audit_upd', 'trg_house_insert_guard', 'staff_reset_signout'))
union all
select 'bodies are this file''s',
       (select count(*) = 10 from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and (p.proname, md5(p.prosrc)) in (('staff_set_vip', '2cc4ab2b81900778df998285b2a6e832'),
                                              ('staff_set_default_pay', 'e354cc85f2021820fab3daaf27f99eeb'),
                                              ('_vip_tag_guard', 'cba4f9300a963babd755c6c92cf0bc97'),
                                              ('_tag_audit_row', 'c5d5d970746ed0c9c5251b49bd0e9cff'),
                                              ('_default_pay_insert_guard', '823e6fbbed90def256129977dab219f7'),
                                              ('_house_insert_guard', '35f543d29b9c9d1b6502de2dda361cef'),
                                              ('staff_set_customer_temp_password', '2c34b756c3ac7cc1f108309119205af3'),
                                              ('_staff_reset_signout', '5297dce3ca9d6b854cc5ab94988eed0b'),
                                              ('_deposit_no_id', 'ea3395f11df40875ab78782c7a08fff7'),
                                              ('_customers_admin_cols', '8de281a9e809dfc777ee2ddc1be76afa')))
union all
select 'no deposit taken as an ID document since',
       to_regclass('public.deposits') is null
       or exists (select 1 from pg_trigger t where t.tgrelid = to_regclass('public.deposits') and t.tgname = 'deposits_no_id_document');
-- Who holds VIP now and who gave it (the audit trail fills from here on):
-- select ct.customer_id, c.name, ct.added_by, to_timestamp(ct.added_at / 1000) as given, ct.expires_at
--   from public.customer_tags ct join public.customers c on c.id = ct.customer_id where ct.tag_id = 'tag_vip' order by ct.added_at desc;
-- Accounts on the house by their default payment:
-- select id, name, default_pay from public.customers where default_pay like 'house%' order by name;
