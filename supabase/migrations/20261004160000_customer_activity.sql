-- Customer activity log (the owner, 2026-10-04: "in staff website add a log for all actions done in
-- the website by customers"). Staff see it in History > Customer activity (/history/customers).
--
-- Written by the DATABASE, not the page: one AFTER trigger on every table a customer's request
-- writes (accounts, bookings, applications, messages, the rider forms, push, failed sign-ins). So it
-- holds every customer action whichever front end made it - the booking app, the website, the
-- Petromin/community forms, an old cached build - and a visitor cannot write, forge or erase a line
-- (no client has INSERT/UPDATE/DELETE on the table; the trigger is the only writer). No customer
-- function is rebuilt (the 2026-09-04 attributes trap), and the RPCs' own checks are untouched.
--
-- Who: a write made by a staff session (is_staff()) is never logged here - staff actions have
-- staff_actions. A write with no PostgREST request behind it (pg_cron, a migration, the SQL editor,
-- a staging clone's data load) is skipped too: every customer path - the app, the website's server,
-- the forms, Google sign-up - arrives as a PostgREST request. What: the
-- row change itself says what happened (a booking row went to cancelled, a password hash moved); the
-- RPC's name from request.path is kept as `fn` and only breaks ties (a customers update from
-- customer_login is a sign-in). Changes the SYSTEM makes inside a customer's request - a cancel
-- moving the next rider up from the waitlist, numbers renumbered - are not customer actions and are
-- left out (only the transitions a customer can ask for are named).
--
-- Rollback: drop the triggers listed at the end, then
--           drop function if exists public._cact_row(); drop function if exists public._cact_add(text,text,text,jsonb,text);
--           drop table if exists public.customer_activity;
-- Idempotent.

begin;

create table if not exists public.customer_activity (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  customer_id text,                       -- null for a form sent without an account
  who         text,                       -- the name at the time (an account renamed later keeps the old line)
  action      text not null,              -- a code the staff page translates: book, cancel, signin...
  detail      jsonb not null default '{}'::jsonb,
  ref         text,                       -- the row it touched: booking id, application id...
  fn          text,                       -- the RPC the request called (request.path), when there was one
  origin      text                        -- the site the request came from (Origin header host)
);
create index if not exists customer_activity_at_idx on public.customer_activity (at desc);
create index if not exists customer_activity_cust_idx on public.customer_activity (customer_id, at desc);
create index if not exists customer_activity_action_idx on public.customer_activity (action, at desc);

alter table public.customer_activity enable row level security;
revoke all on public.customer_activity from public, anon, authenticated;
grant select on public.customer_activity to authenticated;
drop policy if exists "customer activity read" on public.customer_activity;
create policy "customer activity read" on public.customer_activity
  for select to authenticated using ((select is_staff()));

-- One line. Sign-ins are folded: one per account per 30 minutes, since a Google session is
-- re-checked on every app open.
create or replace function public._cact_add(p_cust text, p_who text, p_action text, p_detail jsonb, p_ref text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare _fn text; _org text; _h json;
begin
  if p_action = 'signin' and p_cust is not null and exists (
       select 1 from customer_activity a
        where a.customer_id = p_cust and a.action = 'signin' and a.at > now() - interval '30 minutes') then
    return;
  end if;
  _fn := substring(coalesce(current_setting('request.path', true), '') from '/rpc/([A-Za-z0-9_]+)$');
  -- The page's site from its Origin header; the website's server-side calls send none, and say
  -- so in their user agent (Node's fetch).
  begin
    _h := nullif(current_setting('request.headers', true), '')::json;
    _org := substring(coalesce(_h->>'origin', '') from '^https?://([^/:]+)');
    if coalesce(_org, '') = '' and coalesce(_h->>'user-agent', '') ~* '(node|undici|next\.js)' then _org := 'server'; end if;
  exception when others then _org := null;
  end;
  insert into customer_activity (customer_id, who, action, detail, ref, fn, origin)
  values (p_cust, left(nullif(btrim(coalesce(p_who, '')), ''), 80), p_action,
          coalesce(p_detail, '{}'::jsonb), p_ref, _fn, nullif(_org, ''));
end $fn$;
revoke all on function public._cact_add(text,text,text,jsonb,text) from public, anon, authenticated;

create or replace function public._cact_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  _fn text; _req boolean; _role text; o jsonb; n jsonb; k text; _ch jsonb := '{}'::jsonb; _fields text[] := '{}';
  _s sessions%rowtype; _s2 sessions%rowtype; _d jsonb; _cid text; _who text;
  _prof text[] := array['name','email','phone','height','type_preference','gender','birth_date','country','city',
                        'photo','nationality','socials','profession','heard_from','workplace','hidden_types'];
begin
  -- A staff session's writes are staff actions, never customer activity.
  if (select is_staff()) then return null; end if;
  _fn := substring(coalesce(current_setting('request.path', true), '') from '/rpc/([A-Za-z0-9_]+)$');
  begin _role := nullif(current_setting('request.jwt.claims', true), '')::json->>'role';
  exception when others then _role := null; end;
  _req := _fn is not null or _role is not null;
  if not _req then return null; end if;
  -- Staff, vendor and partner functions run through service keys too: not a customer.
  if _fn ~ '^(staff_|vendor_|fnb_|admin_)' then return null; end if;

  -- The log never stands in a customer's way: anything below that fails loses its one line and
  -- the booking, the sign-in or the form goes through as before.
  begin

  -- ── accounts ─────────────────────────────────────────────────────────────────────────────
  if tg_table_name = 'customers' then
    if tg_op = 'INSERT' then
      perform _cact_add(new.id, new.name, 'signup',
        jsonb_strip_nulls(jsonb_build_object('google', case when coalesce(new.password_hash,'') like 'oauth:%' then true end)), new.id);
      return null;
    end if;
    if tg_op <> 'UPDATE' then return null; end if;
    o := to_jsonb(old); n := to_jsonb(new);
    foreach k in array _prof loop
      if n -> k is distinct from o -> k then
        _fields := _fields || k;
        if k <> 'photo' then
          _ch := _ch || jsonb_build_object(k, jsonb_build_array(left(o ->> k, 80), left(n ->> k, 80)));
        end if;
      end if;
    end loop;
    if _fn in ('customer_login', 'customer_oauth_login') then
      perform _cact_add(new.id, new.name, 'signin',
        jsonb_strip_nulls(jsonb_build_object('google', case when _fn = 'customer_oauth_login' then true end)), new.id);
      return null;
    end if;
    if new.password_hash is distinct from old.password_hash then
      perform _cact_add(new.id, new.name, case when _fn = 'customer_reset' then 'pwd_reset' else 'pwd_change' end, '{}'::jsonb, new.id);
    end if;
    if new.deletion_requested_at is distinct from old.deletion_requested_at and new.deletion_requested_at is not null then
      perform _cact_add(new.id, new.name, 'delete_req', '{}'::jsonb, new.id);
    end if;
    if new.privacy_version is distinct from old.privacy_version and new.privacy_version is not null then
      perform _cact_add(new.id, new.name, 'consent', jsonb_build_object('v', new.privacy_version), new.id);
    end if;
    if new.ride_news is distinct from old.ride_news then
      perform _cact_add(new.id, new.name, 'ride_news', jsonb_build_object('on', coalesce(new.ride_news, false)), new.id);
    end if;
    if cardinality(_fields) > 0 then
      perform _cact_add(new.id, new.name, 'profile', jsonb_build_object('fields', to_jsonb(_fields), 'ch', _ch), new.id);
    end if;
    return null;
  end if;

  -- ── bookings ─────────────────────────────────────────────────────────────────────────────
  if tg_table_name = 'queue_entries' then
    -- Only a visitor's request (the anon/authenticated key); a service key or no request is the system.
    if coalesce(_role, '') not in ('anon', 'authenticated') then return null; end if;
    select * into _s from sessions where id = new.session_id;
    _d := jsonb_strip_nulls(jsonb_build_object('sid', new.session_id, 'date', coalesce(_s.session_date, new.session_date),
            'title', nullif(_s.title, ''), 'kind', nullif(coalesce(_s.ride_kind, _s.event_kind), ''),
            'rider', new.name, 'bike', nullif(new.type_preference, ''), 'status', new.status));
    _cid := new.customer_id; _who := coalesce((select name from customers where id = new.customer_id), new.name);
    if tg_op = 'INSERT' then
      perform _cact_add(_cid, _who, 'book', _d || jsonb_strip_nulls(jsonb_build_object('price', new.price,
        'promo', nullif(new.promo_code, ''), 'party', nullif(new.group_name, ''))), new.id);
      return null;
    end if;
    if new.session_id is distinct from old.session_id then
      select * into _s2 from sessions where id = old.session_id;
      perform _cact_add(_cid, _who, 'reschedule', _d || jsonb_strip_nulls(jsonb_build_object('from_sid', old.session_id,
        'from_date', coalesce(_s2.session_date, old.session_date), 'from_title', nullif(_s2.title, ''))), new.id);
    elsif new.status = 'cancelled' and old.status is distinct from 'cancelled' then
      perform _cact_add(_cid, _who, 'cancel', _d || jsonb_strip_nulls(jsonb_build_object('reason', nullif(new.cancel_reason, ''),
        'note', left(nullif(new.cancel_note, ''), 200))), new.id);
    elsif old.status = 'cancelled' and new.status in ('waiting', 'waitlist') then
      perform _cact_add(_cid, _who, 'rebook', _d, new.id);
    end if;
    if (new.rating_exp is distinct from old.rating_exp or new.rating_bike is distinct from old.rating_bike
        or new.rating_detail is distinct from old.rating_detail or new.feedback is distinct from old.feedback)
       and (new.rating_exp is not null or new.rating_bike is not null or new.rating_detail is not null or new.feedback is not null) then
      perform _cact_add(_cid, _who, 'rate', _d || jsonb_strip_nulls(jsonb_build_object('exp', new.rating_exp,
        'bike_r', new.rating_bike, 'feedback', left(nullif(new.feedback, ''), 300))), new.id);
    end if;
    if new.waiver_at is distinct from old.waiver_at and new.waiver_at is not null then
      perform _cact_add(_cid, _who, 'waiver', _d || jsonb_strip_nulls(jsonb_build_object('v', new.waiver_version)), new.id);
    end if;
    if new.addons is distinct from old.addons or new.purchases is distinct from old.purchases then
      perform _cact_add(_cid, _who, 'addons', _d, new.id);
    end if;
    if new.status not in ('cancelled') and new.session_id is not distinct from old.session_id
       and (new.name is distinct from old.name or new.type_preference is distinct from old.type_preference
            or new.size is distinct from old.size or new.height is distinct from old.height
            or new.promo_code is distinct from old.promo_code) then
      perform _cact_add(_cid, _who, 'booking_edit', _d || jsonb_strip_nulls(jsonb_build_object(
        'from_rider', case when new.name is distinct from old.name then old.name end,
        'from_bike', case when new.type_preference is distinct from old.type_preference then old.type_preference end,
        'promo', case when new.promo_code is distinct from old.promo_code then new.promo_code end)), new.id);
    end if;
    return null;
  end if;

  -- ── applications and forms ───────────────────────────────────────────────────────────────
  if tg_table_name in ('community_applications', 'learn_applications') then
    _d := jsonb_strip_nulls(jsonb_build_object('email', new.email, 'phone', new.phone));
    if tg_op = 'INSERT' then
      perform _cact_add(new.customer_id, new.name,
        case when tg_table_name = 'community_applications' then 'apply_community' else 'apply_learn' end, _d, new.id::text);
    elsif new.fix_done_at is distinct from old.fix_done_at and new.fix_done_at is not null then
      perform _cact_add(new.customer_id, new.name, 'apply_fix',
        _d || jsonb_build_object('form', case when tg_table_name = 'community_applications' then 'community' else 'learn' end), new.id::text);
    elsif new.submissions is distinct from old.submissions then
      perform _cact_add(new.customer_id, new.name,
        case when tg_table_name = 'community_applications' then 'apply_community' else 'apply_learn' end,
        _d || jsonb_build_object('again', true), new.id::text);
    end if;
    return null;
  end if;

  if tg_table_name = 'site_messages' and tg_op = 'INSERT' then
    perform _cact_add(new.customer_id, new.name, 'message',
      jsonb_strip_nulls(jsonb_build_object('kind', new.kind, 'topic', new.topic, 'text', left(new.message, 200),
        'email', new.email, 'phone', new.phone)), new.id::text);
    return null;
  end if;

  if tg_table_name = 'workshop_jobs' and tg_op = 'INSERT' then
    perform _cact_add(new.customer_id, new.name, 'workshop',
      jsonb_strip_nulls(jsonb_build_object('service', coalesce(nullif(new.service_label, ''), new.service),
        'date', new.preferred_date, 'phone', new.phone)), new.id::text);
    return null;
  end if;

  if tg_table_name = 'ambassadors' and tg_op = 'INSERT' then
    perform _cact_add(new.customer_id, new.name, 'ambassador', jsonb_strip_nulls(jsonb_build_object('phone', new.phone)), new.id::text);
    return null;
  end if;

  if tg_table_name = 'ambassador_redemptions' and tg_op = 'INSERT' then
    select customer_id, name into _cid, _who from ambassadors where id = new.ambassador_id;
    perform _cact_add(_cid, _who, 'redeem', jsonb_strip_nulls(jsonb_build_object('item', new.item, 'points', new.points)), new.id::text);
    return null;
  end if;

  if tg_table_name = 'rider_registrations' then
    if tg_op = 'INSERT' then
      perform _cact_add(new.matched_customer_id, new.name, 'rider_form',
        jsonb_strip_nulls(jsonb_build_object('sid', new.session_id, 'company', new.company, 'badge', new.badge,
          'booking_no', new.booking_no, 'source', new.source)), new.id::text);
    elsif _fn = 'rider_edit' then
      perform _cact_add(new.matched_customer_id, new.name, 'rider_form_edit',
        jsonb_strip_nulls(jsonb_build_object('sid', new.session_id, 'company', new.company, 'badge', new.badge)), new.id::text);
    end if;
    return null;
  end if;

  if tg_table_name = 'push_subscriptions' then
    if tg_op = 'INSERT' then
      perform _cact_add(new.customer_id, (select name from customers where id = new.customer_id), 'push_on', '{}'::jsonb, new.id::text);
    elsif tg_op = 'DELETE' then
      perform _cact_add(old.customer_id, (select name from customers where id = old.customer_id), 'push_off', '{}'::jsonb, old.id::text);
    end if;
    return null;
  end if;

  -- (a row's fields are read only inside its own table's IF: PL/pgSQL does not short-circuit AND,
  -- so `tg_table_name = 'x' and new.col ...` fails on every other table)
  if tg_table_name = 'customer_flags' then
    if tg_op = 'UPDATE' and new.answered_at is distinct from old.answered_at and new.answered_at is not null then
      perform _cact_add(new.customer_id, (select name from customers where id = new.customer_id), 'flag_answered',
        jsonb_build_object('fields', to_jsonb(new.fields)), new.id::text);
    end if;
    return null;
  end if;

  -- A wrong password on an account (the per-account counter; a bare identifier has no account).
  if tg_table_name = 'login_throttle' then
    if new.identifier like 'acct:%' and coalesce(new.fails, 0) > 0 then
      -- Every failure stamps updated_at; after a lock or a quiet day the count restarts at 1,
      -- so "the count went up" alone would miss that one.
      if tg_op = 'INSERT' then _cid := substring(new.identifier from 6);
      elsif new.fails is distinct from old.fails or new.updated_at is distinct from old.updated_at then
        _cid := substring(new.identifier from 6);
      end if;
      if _cid is not null then
        perform _cact_add(_cid, (select name from customers where id = _cid), 'signin_fail',
          jsonb_strip_nulls(jsonb_build_object('fails', new.fails, 'locked', case when new.locked_until > now() then true end)), _cid);
      end if;
    end if;
    return null;
  end if;

  exception when others then
    return null;
  end;

  return null;
end $fn$;
revoke all on function public._cact_row() from public, anon, authenticated;

drop trigger if exists cact_customers on public.customers;
create trigger cact_customers after insert or update on public.customers
  for each row execute function public._cact_row();
drop trigger if exists cact_queue_entries on public.queue_entries;
create trigger cact_queue_entries after insert or update on public.queue_entries
  for each row execute function public._cact_row();
drop trigger if exists cact_community_applications on public.community_applications;
create trigger cact_community_applications after insert or update on public.community_applications
  for each row execute function public._cact_row();
drop trigger if exists cact_learn_applications on public.learn_applications;
create trigger cact_learn_applications after insert or update on public.learn_applications
  for each row execute function public._cact_row();
drop trigger if exists cact_site_messages on public.site_messages;
create trigger cact_site_messages after insert on public.site_messages
  for each row execute function public._cact_row();
drop trigger if exists cact_workshop_jobs on public.workshop_jobs;
create trigger cact_workshop_jobs after insert on public.workshop_jobs
  for each row execute function public._cact_row();
drop trigger if exists cact_ambassadors on public.ambassadors;
create trigger cact_ambassadors after insert on public.ambassadors
  for each row execute function public._cact_row();
drop trigger if exists cact_ambassador_redemptions on public.ambassador_redemptions;
create trigger cact_ambassador_redemptions after insert on public.ambassador_redemptions
  for each row execute function public._cact_row();
drop trigger if exists cact_rider_registrations on public.rider_registrations;
create trigger cact_rider_registrations after insert or update on public.rider_registrations
  for each row execute function public._cact_row();
drop trigger if exists cact_push_subscriptions on public.push_subscriptions;
create trigger cact_push_subscriptions after insert or delete on public.push_subscriptions
  for each row execute function public._cact_row();
drop trigger if exists cact_customer_flags on public.customer_flags;
create trigger cact_customer_flags after update on public.customer_flags
  for each row execute function public._cact_row();
drop trigger if exists cact_login_throttle on public.login_throttle;
create trigger cact_login_throttle after insert or update on public.login_throttle
  for each row execute function public._cact_row();

insert into supabase_migrations.schema_migrations (version, name)
values ('20261004160000', 'customer_activity')
on conflict do nothing;

commit;
