-- ============================================================================
-- Deleting an account archives it (the user, 2026-11-11: "when deleting an account i want you to keep his data
-- archived and all trace and his history to stay under his name"). For PROD and STAGING.
--
-- Before this, staff_delete_customer unlinked the account's bookings and sales (customer_id -> null) and deleted the
-- row, and the foreign keys wiped what hung off it: badges, titles, volunteer hours and shifts, referrals, invites,
-- squads, hub photos, badge requests, tags. Now nothing is deleted:
--
--  1. customers gets the archive: archived_at (null = live), archived_by (the operator), archived_root (the account
--     whose archive took this row: itself, or the account it was merged into), archived_email / archived_apple_email /
--     archived_phone (the sign-in addresses, moved here), archived_codes (the codes the archive turned off) and
--     archived_tags (the tags, moved here).
--  2. staff_delete_customer (same name and answer, so every app version still calls it) archives the account and the
--     accounts merged into it: bookings, sales, wallet, badges, hours, history all stay linked, under the name. It
--     still refuses a live booking. Its sign-in addresses move into the archive, so the same email or phone can open
--     a NEW account (the user's pick: start fresh, never joined back), and no sign-in, sign-up, phone match or
--     application match finds it. Its session token is cleared, its push subscriptions, unsent pushes and sign-in
--     hand-offs go (we stop contacting it), its own codes stop, its tags move into the archive.
--  3. staff_restore_customer(p_id, p_op, p_approval): admin + PIN. Gives the account back: addresses (an email
--     another account holds now stays out, and the answer says so), phone (phone_since restarts, so a newer account
--     on the same number keeps signing in), tags, codes. The rider signs in again with their password.
--  4. staff_archived_list() and staff_archived_account(p_id): admin only, the Archived accounts list and one
--     account's read-only history (bookings, sales, wallet, badges, tags, volunteer hours).
--  5. Staff never see an archived account in their lists: the customers policies "staff read" / "staff update" add
--     archived_at is null; staff_sync leaves archived rows out and hands the desk's copy their ids as deleted; the
--     staff-ref broadcast sends an archive as a DELETE and a restore as an INSERT. "admin delete" is dropped and a
--     trigger refuses any delete of an account from the app (only the SQL editor or the service role can).
--  6. An archived account cannot be signed in to, booked, merged or unmerged: _cust_token_ok, customer_token_ok and
--     customer_pwd_state add archived_at is null (a temp password staff set on it still opens nothing);
--     queue_entries refuses a booking for it (ACCOUNT_ARCHIVED); staff_merge_customers and staff_unmerge_customers
--     refuse it (ARCHIVED); _member_by_ref skips it.
--
-- Rollback: restore every archived account first (Customers > Archived > Restore, or staff_restore_customer), then
--   restore staff_delete_customer from 20261110235300 (its definition on prod 2026-11-11 is that file's patch of the
--   20261014120100 one); remove "and archived_at is null /* 20261111200000 */" from _cust_token_ok, customer_token_ok,
--   customer_pwd_state, _member_by_ref and staff_sync, and the blocks marked 20261111200000 from staff_sync,
--   _staff_ref_broadcast, _customer_email_alias, staff_merge_customers, staff_unmerge_customers (pg_get_functiondef +
--   replace, as here); put the two policies back to ((select is_staff())) and recreate
--   create policy "admin delete" on public.customers for delete using ((select is_admin()));
--   drop trigger customers_no_delete on customers; drop trigger queue_archived_guard on queue_entries;
--   drop function staff_restore_customer(text,text,text), staff_archived_list(), staff_archived_account(text),
--   _staff_archived_since(timestamptz), _customers_no_delete(), _queue_archived_guard().
--   The archived_* columns hold the archive and stay.
-- Idempotent: each patched function carries this file's number and is skipped when it does.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

-- 1 the archive's columns ---------------------------------------------------------------------------------------------
alter table public.customers
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by text,
  add column if not exists archived_root text,
  add column if not exists archived_email text,
  add column if not exists archived_apple_email text,
  add column if not exists archived_phone text,
  add column if not exists archived_codes text[],
  add column if not exists archived_tags jsonb;
create index if not exists customers_archived_idx on public.customers (archived_at) where archived_at is not null;
-- the staff policies below name archived_at: staff may read that one column (rows stay staff-only by the policy)
grant select (archived_at) on public.customers to authenticated;

-- 2 staff_delete_customer: archive, never delete -----------------------------------------------------------------------
create or replace function public.staff_delete_customer(p_id text, p_op text default null, p_approval text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_live int; v_bookings int := 0; v_sales int := 0; v_push int := 0; v_ids text[]; v_codes text[]; v_tags jsonb;
  v_by text; v_now timestamptz := now();
begin
  -- Admins only, with the operator's PIN approval (staff_pin_approve), as before.
  if not is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not _pin_ok_strict(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  -- An account is never deleted: it is archived, with everything linked to it, under its name (20261111200000).
  -- Locked first, so a booking being made for it waits and then meets the archive guard on queue_entries.
  perform 1 from customers where id = p_id and archived_at is null for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  -- The accounts merged into this one, at any depth, are the same person: they are archived with it.
  with recursive m(id) as (
    select p_id
    union
    select c.id from customers c join m on c.merged_into = m.id
  )
  select array_agg(id) into v_ids from m;
  perform 1 from customers where id = any(v_ids) and id <> p_id order by id for update;
  select count(*) into v_live from queue_entries
   where customer_id = any(v_ids) and status in ('waiting', 'waitlist', 'active');
  if v_live > 0 then
    return jsonb_build_object('ok', false, 'error', 'LIVE_BOOKINGS', 'live', v_live);
  end if;
  -- Bookings and sales stay linked to the account: counted for the answer, never touched.
  select count(*) into v_bookings from queue_entries where customer_id = any(v_ids);
  select count(*) into v_sales from cashier_sales where customer_id = any(v_ids);
  -- We stop contacting it: push subscriptions, pushes not sent yet, sign-in hand-offs.
  delete from push_subscriptions where customer_id = any(v_ids);
  get diagnostics v_push = row_count;
  delete from push_outbox where customer_id = any(v_ids) and sent_at is null;
  delete from customer_handoffs where customer_id = any(v_ids);
  -- Its own codes stop (RF-, RW-, VL-, BD-, a code made for it); a restore turns the same ones back on.
  with u as (update promo_codes set active = false where customer_id = any(v_ids) and active returning id)
    select array_agg(id) into v_codes from u;
  -- Its tags move into the archive (a restore puts them back). Deleted as rows, so the desk's lists, counts and
  -- copies drop them the way they always have (sync tombstones, the staff-ref broadcast).
  select jsonb_agg(to_jsonb(ct) order by ct.customer_id, ct.tag_id) into v_tags
    from customer_tags ct where ct.customer_id = any(v_ids);
  delete from customer_tags where customer_id = any(v_ids);
  v_by := coalesce(nullif(btrim(p_op), ''), (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()));
  -- The sign-in addresses move into the archive: the email and phone are free for a new account, and nothing that
  -- signs in, signs up or matches by email or phone finds this one. The token goes: it is signed out everywhere.
  update customers c set
      archived_at = v_now, archived_by = v_by, archived_root = p_id,
      archived_email = nullif(btrim(c.email), ''), archived_apple_email = nullif(btrim(c.apple_email), ''),
      archived_phone = nullif(btrim(c.phone), ''),
      archived_codes = case when c.id = p_id then v_codes end,
      archived_tags = case when c.id = p_id then v_tags end,
      email = null, apple_email = null, phone = null, session_token = null
   where c.id = any(v_ids) and c.archived_at is null;
  return jsonb_build_object('ok', true, 'archived', true, 'bookings', v_bookings, 'sales', v_sales,
                            'tags', coalesce(jsonb_array_length(v_tags), 0), 'push_subscriptions', v_push,
                            'flags', 0, 'rider_links', 0, 'codes', coalesce(array_length(v_codes, 1), 0),
                            'merged_accounts', coalesce(array_length(v_ids, 1), 1) - 1);
end $function$;
revoke all on function public.staff_delete_customer(text, text, text) from public, anon;
grant execute on function public.staff_delete_customer(text, text, text) to authenticated;

-- 3 staff_restore_customer ----------------------------------------------------------------------------------------------
create or replace function public.staff_restore_customer(p_id text, p_op text default null, p_approval text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  r customers%rowtype; x customers%rowtype; t customer_tags%rowtype; v_ids text[]; e text; a text;
  v_email_back boolean := true; v_tags int := 0; v_tags_skipped int := 0;
begin
  if not is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not _pin_ok_strict(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into r from customers where id = p_id for update;
  if not found or r.archived_at is null then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  -- An account merged into another comes back only with it.
  if r.archived_root is distinct from r.id then
    return jsonb_build_object('ok', false, 'error', 'NOT_ROOT', 'root', r.archived_root);
  end if;
  select array_agg(id order by id) into v_ids from customers where archived_root = p_id and archived_at is not null;
  perform 1 from customers where id = any(v_ids) order by id for update;
  for x in select * from customers where id = any(v_ids) order by id loop
    e := lower(btrim(coalesce(x.archived_email, '')));
    a := lower(btrim(coalesce(x.archived_apple_email, '')));
    -- An address another account holds now (the rider started afresh with it) stays with that account.
    if e <> '' and exists (select 1 from customers c where c.id <> all(v_ids)
                             and (lower(btrim(c.email)) = e or lower(btrim(c.apple_email)) = e)) then
      e := '';
      if x.id = p_id then v_email_back := false; end if;
    end if;
    if a <> '' and exists (select 1 from customers c where c.id <> all(v_ids)
                             and (lower(btrim(c.email)) = a or lower(btrim(c.apple_email)) = a)) then
      a := '';
    end if;
    -- One update per account, so the staff-ref broadcast hands the desk the whole row, live again. The phone's
    -- trigger restarts phone_since: a newer account on the same number keeps signing in with it.
    update customers set
        email = case when e <> '' then x.archived_email end,
        apple_email = case when a <> '' then x.archived_apple_email end,
        phone = x.archived_phone,
        archived_at = null, archived_by = null, archived_root = null, archived_email = null,
        archived_apple_email = null, archived_phone = null, archived_codes = null, archived_tags = null
     where id = x.id;
  end loop;
  -- The tags it held, as they were (dates and notes); one the rules refuse now is left out and counted.
  for t in select * from jsonb_populate_recordset(null::customer_tags, coalesce(r.archived_tags, '[]'::jsonb)) loop
    begin
      insert into customer_tags (customer_id, tag_id, added_by, added_at, note, starts_at, expires_at)
      values (t.customer_id, t.tag_id, t.added_by, t.added_at, t.note, t.starts_at, t.expires_at)
      on conflict do nothing;
      v_tags := v_tags + 1;
    exception when others then
      v_tags_skipped := v_tags_skipped + 1;
    end;
  end loop;
  update promo_codes set active = true where id = any(coalesce(r.archived_codes, '{}')) and not active;
  return jsonb_build_object('ok', true, 'email_back', v_email_back, 'tags', v_tags, 'tags_skipped', v_tags_skipped,
                            'merged_accounts', coalesce(array_length(v_ids, 1), 1) - 1);
end $function$;
revoke all on function public.staff_restore_customer(text, text, text) from public, anon;
grant execute on function public.staff_restore_customer(text, text, text) to authenticated;

-- 4 the Archived accounts list and one account's history (admins) -------------------------------------------------------
create or replace function public.staff_archived_list()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'name', c.name, 'email', c.archived_email, 'phone', c.archived_phone,
             'archived_at', c.archived_at, 'archived_by', c.archived_by, 'asked_at', c.deletion_requested_at,
             'created_at', c.created_at,
             'bookings', (select count(*) from queue_entries q where q.customer_id = c.id),
             'wallet', coalesce((select w.balance from wallet_balances w where w.customer_id = c.id), 0))
           order by c.archived_at desc, c.id)
      from customers c
     where c.archived_at is not null and c.archived_root = c.id), '[]'::jsonb);
end $function$;
revoke all on function public.staff_archived_list() from public, anon;
grant execute on function public.staff_archived_list() to authenticated;

create or replace function public.staff_archived_account(p_id text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare r customers%rowtype;
begin
  if not is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into r from customers where id = p_id and archived_at is not null;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true,
    'account', jsonb_build_object('id', r.id, 'name', r.name, 'email', r.archived_email, 'apple_email', r.archived_apple_email,
       'phone', r.archived_phone, 'gender', r.gender, 'birth_date', r.birth_date, 'nationality', r.nationality,
       'country', r.country, 'city', r.city, 'profession', r.profession, 'workplace', r.workplace, 'height', r.height,
       'created_at', r.created_at, 'archived_at', r.archived_at, 'archived_by', r.archived_by,
       'asked_at', r.deletion_requested_at, 'root', r.archived_root),
    'merged', (select count(*) from customers c where c.archived_root = r.id and c.id <> r.id),
    'wallet', coalesce((select w.balance from wallet_balances w where w.customer_id = r.id), 0),
    'bookings_n', (select count(*) from queue_entries q where q.customer_id = r.id),
    'bookings', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'date', q.session_date, 'session', q.session_id,
                     'status', q.status, 'price', q.price, 'paid', q.paid, 'bike', q.type_preference, 'num', q.queue_num)
                     order by q.session_date desc, q.queue_num)
                   from (select * from queue_entries where customer_id = r.id order by session_date desc, queue_num limit 300) q),
                 '[]'::jsonb),
    'sales', (select jsonb_build_object('n', count(*), 'total', coalesce(sum(s.price * s.qty), 0))
                from cashier_sales s where s.customer_id = r.id and s.voided_at is null and s.refunded_at is null),
    'badges', coalesce((select jsonb_agg(jsonb_build_object('name', b.name, 'name_ar', b.name_ar, 'at', cb.awarded_at)
                          order by cb.awarded_at desc)
                          from customer_badges cb join badges b on b.id = cb.badge_id where cb.customer_id = r.id), '[]'::jsonb),
    'tags', coalesce((select jsonb_agg(jsonb_build_object('name', tg.name, 'color', tg.color) order by tg.name)
                        from jsonb_populate_recordset(null::customer_tags, coalesce(r.archived_tags, '[]'::jsonb)) x
                        join tags tg on tg.id = x.tag_id), '[]'::jsonb),
    'volunteer_hours', (select coalesce(sum(h.hours), 0) from volunteer_hours h where h.customer_id = r.id and h.voided_at is null));
end $function$;
revoke all on function public.staff_archived_account(text) from public, anon;
grant execute on function public.staff_archived_account(text) to authenticated;

-- 5 staff never see an archived account; nobody deletes one from the app ------------------------------------------------
alter policy "staff read" on public.customers using ((select is_staff()) and archived_at is null);
alter policy "staff update" on public.customers
  using ((select is_staff()) and archived_at is null)
  with check ((select is_staff()) and archived_at is null);
drop policy if exists "admin delete" on public.customers;

create or replace function public._customers_no_delete()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  -- An account is archived (staff_delete_customer), never deleted from the app (20261111200000). The SQL editor,
  -- a migration and the service role are not stopped.
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    raise exception 'ACCOUNTS_ARE_ARCHIVED' using errcode = '42501';
  end if;
  return old;
end $function$;
revoke all on function public._customers_no_delete() from public, anon, authenticated;
drop trigger if exists customers_no_delete on public.customers;
create trigger customers_no_delete before delete on public.customers
  for each row execute function public._customers_no_delete();

-- the accounts archived since a desk's last read, as staff_sync hands deleted rows over (staff only)
create or replace function public._staff_archived_since(p_since timestamptz)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when not is_staff() or p_since is null then '[]'::jsonb else
    coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'at', c.updated_at) order by c.updated_at)
                from customers c where c.archived_at is not null and c.updated_at > p_since), '[]'::jsonb) end;
$function$;
revoke all on function public._staff_archived_since(timestamptz) from public, anon;
grant execute on function public._staff_archived_since(timestamptz) to authenticated;

do $do$
declare d text;
begin
  -- _customer_email_alias: an archived row is left as the archive wrote it. Its old address on an Apple relay was
  -- otherwise copied back into apple_email, where sign-in found it and a new account could not take it.
  select pg_get_functiondef('public._customer_email_alias()'::regprocedure) into d;
  if position('20261111200000' in d) = 0 then
    execute pg_temp._once(d,
$a$  e := lower(btrim(coalesce(new.email,'')));$a$,
$b$  if new.archived_at is not null then return new; end if;  -- archived: no aliasing (20261111200000)
  e := lower(btrim(coalesce(new.email,'')));$b$);
  end if;

  -- staff_sync: archived rows stay out of the desk's copy, and one archived since its last read is handed over as deleted
  select pg_get_functiondef('public.staff_sync(text,timestamptz,text)'::regprocedure) into d;
  if position('20261111200000' in d) = 0 then
    d := pg_temp._once(d,
$a$     where p_since is null or c.updated_at > p_since;$a$,
$b$     where (p_since is null or c.updated_at > p_since) and c.archived_at is null;  -- archived: not on the desk (20261111200000)$b$);
    d := pg_temp._once(d,
$a$     where d.tbl = p_table and d.deleted_at > p_since;
  end if;$a$,
$b$     where d.tbl = p_table and d.deleted_at > p_since;
    -- an account archived since goes from the desk's copy as a deleted one does (20261111200000); read through a
    -- definer, as this function runs as the staffer and the staff policy no longer shows archived rows
    if p_table = 'customers' then
      v_del := v_del || _staff_archived_since(p_since);
    end if;
  end if;$b$);
    execute d;
  end if;

  -- _staff_ref_broadcast: an archive reaches the desks as a DELETE, a restore as an INSERT
  select pg_get_functiondef('public._staff_ref_broadcast()'::regprocedure) into d;
  if position('20261111200000' in d) = 0 then
    d := pg_temp._once(d,
$a$  n jsonb;
  o jsonb;
begin$a$,
$b$  n jsonb;
  o jsonb;
  op text;  -- (20261111200000)
begin$b$);
    d := pg_temp._once(d,
$a$  if TG_OP = 'UPDATE' and n = o then$a$,
$b$  -- An account archived leaves the desks as a deleted one; restored, it comes back as a new one (20261111200000).
  if TG_TABLE_NAME = 'customers' and TG_OP = 'UPDATE' then
    if NEW.archived_at is not null then
      if OLD.archived_at is not null then return null; end if;
      op := 'DELETE'; n := null;
    elsif OLD.archived_at is not null then
      op := 'INSERT';
    end if;
  end if;

  if TG_OP = 'UPDATE' and n = o then$b$);
    d := pg_temp._once(d,
$a$      'op',  TG_OP,$a$,
$b$      'op',  coalesce(op, TG_OP),$b$);
    execute d;
  end if;

  -- 6 an archived account opens nothing, is never booked, merged or unmerged, never found by its member reference
  select pg_get_functiondef('public._cust_token_ok(text,text)'::regprocedure) into d;
  if position('20261111200000' in d) = 0 then
    execute pg_temp._once(d, $a$and merged_into is null);$a$,
                             $b$and merged_into is null and archived_at is null /* 20261111200000 */);$b$);
  end if;
  select pg_get_functiondef('public.customer_token_ok(text,text)'::regprocedure) into d;
  if position('20261111200000' in d) = 0 then
    execute pg_temp._once(d, $a$and merged_into is null);$a$,
                             $b$and merged_into is null and archived_at is null /* 20261111200000 */);$b$);
  end if;
  select pg_get_functiondef('public.customer_pwd_state(text,text)'::regprocedure) into d;
  if position('20261111200000' in d) = 0 then
    execute pg_temp._once(d, $a$and merged_into is null), false);$a$,
                             $b$and merged_into is null and archived_at is null /* 20261111200000 */), false);$b$);
  end if;
  select pg_get_functiondef('public._member_by_ref(text)'::regprocedure) into d;
  if position('20261111200000' in d) = 0 then
    execute pg_temp._once(d, $a$where c.merged_into is null and c.deletion_requested_at is null$a$,
                             $b$where c.merged_into is null and c.deletion_requested_at is null and c.archived_at is null /* 20261111200000 */$b$);
  end if;
  select pg_get_functiondef('public.staff_merge_customers(text,text,text,text,text)'::regprocedure) into d;
  if position('20261111200000' in d) = 0 then
    execute pg_temp._once(d,
$a$  if k.merged_into is not null or d.merged_into is not null then raise exception 'ALREADY_MERGED' using errcode = '22023'; end if;$a$,
$b$  if k.merged_into is not null or d.merged_into is not null then raise exception 'ALREADY_MERGED' using errcode = '22023'; end if;
  -- an archived account is never joined to another (the user, 2026-11-11; 20261111200000)
  if k.archived_at is not null or d.archived_at is not null then raise exception 'ARCHIVED' using errcode = '22023'; end if;$b$);
  end if;
  select pg_get_functiondef('public.staff_unmerge_customers(bigint)'::regprocedure) into d;
  if position('20261111200000' in d) = 0 then
    execute pg_temp._once(d,
$a$  -- The keeper was merged into a third account since: that merge is undone first (20261005210100).$a$,
$b$  -- Either account archived since: restore it first (20261111200000).
  if exists (select 1 from customers where id in (m.keep_id, m.drop_id) and archived_at is not null) then
    raise exception 'ARCHIVED' using errcode = '22023';
  end if;
  -- The keeper was merged into a third account since: that merge is undone first (20261005210100).$b$);
  end if;
end $do$;

create or replace function public._queue_archived_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- No booking is made for, or moved onto, an archived account (20261111200000).
  if new.customer_id is not null and (tg_op = 'INSERT' or new.customer_id is distinct from old.customer_id)
     and exists (select 1 from customers c where c.id = new.customer_id and c.archived_at is not null) then
    raise exception 'ACCOUNT_ARCHIVED' using errcode = 'P0001';
  end if;
  return new;
end $function$;
revoke all on function public._queue_archived_guard() from public, anon, authenticated;
drop trigger if exists queue_archived_guard on public.queue_entries;
create trigger queue_archived_guard before insert or update of customer_id on public.queue_entries
  for each row execute function public._queue_archived_guard();

-- checks ------------------------------------------------------------------------------------------------------------------
do $chk$
declare f text;
begin
  foreach f in array array['public.staff_delete_customer(text,text,text)', 'public.staff_restore_customer(text,text,text)',
                           'public.staff_archived_list()', 'public.staff_archived_account(text)',
                           'public._staff_archived_since(timestamptz)', 'public._cust_token_ok(text,text)',
                           'public.customer_token_ok(text,text)', 'public.customer_pwd_state(text,text)',
                           'public._member_by_ref(text)', 'public.staff_merge_customers(text,text,text,text,text)',
                           'public.staff_unmerge_customers(bigint)', 'public._staff_ref_broadcast()',
                           'public._customer_email_alias()', 'public._queue_archived_guard()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  -- staff_sync is the staffer's own (invoker, as it was): only its search_path is checked
  if not exists (select 1 from pg_proc p where p.oid = 'public.staff_sync(text,timestamptz,text)'::regprocedure and not p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'staff_sync changed its rights or lost its search_path';
  end if;
  foreach f in array array['public.staff_delete_customer(text,text,text)', 'public.staff_restore_customer(text,text,text)',
                           'public.staff_archived_list()', 'public.staff_archived_account(text)',
                           'public._staff_archived_since(timestamptz)', 'public.staff_sync(text,timestamptz,text)',
                           'public._cust_token_ok(text,text)', 'public._member_by_ref(text)',
                           'public.staff_merge_customers(text,text,text,text,text)', 'public.staff_unmerge_customers(bigint)',
                           'public._staff_ref_broadcast()', 'public._customer_email_alias()', 'public._queue_archived_guard()',
                           'public._customers_no_delete()'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is open to anon', f; end if;
  end loop;
  foreach f in array array['public.staff_sync(text,timestamptz,text)', 'public._cust_token_ok(text,text)',
                           'public.customer_token_ok(text,text)', 'public.customer_pwd_state(text,text)',
                           'public._member_by_ref(text)', 'public.staff_merge_customers(text,text,text,text,text)',
                           'public.staff_unmerge_customers(bigint)', 'public._staff_ref_broadcast()',
                           'public._customer_email_alias()'] loop
    if position('20261111200000' in pg_get_functiondef(f::regprocedure)) = 0 then
      raise exception '% lacks this file''s change', f;
    end if;
  end loop;
  foreach f in array array['public.staff_delete_customer(text,text,text)', 'public.staff_restore_customer(text,text,text)',
                           'public.staff_archived_list()', 'public.staff_archived_account(text)',
                           'public._staff_archived_since(timestamptz)',
                           'public.staff_sync(text,timestamptz,text)', 'public.customer_token_ok(text,text)',
                           'public.customer_pwd_state(text,text)', 'public.staff_merge_customers(text,text,text,text,text)',
                           'public.staff_unmerge_customers(bigint)'] loop
    if not has_function_privilege('authenticated', f, 'execute') then raise exception '% lost its grant', f; end if;
  end loop;
  if not has_function_privilege('anon', 'public.customer_token_ok(text,text)', 'execute')
     or not has_function_privilege('anon', 'public.customer_pwd_state(text,text)', 'execute') then
    raise exception 'customer_token_ok / customer_pwd_state lost the riders'' grant';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'customers' and policyname = 'admin delete') then
    raise exception 'admin delete policy still there';
  end if;
  if position('archived_at' in (select qual from pg_policies where schemaname = 'public' and tablename = 'customers'
                                  and policyname = 'staff read')) = 0 then
    raise exception 'staff read policy lacks the archive';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111200000', 'account_archive')
on conflict (version) do nothing;

commit;
