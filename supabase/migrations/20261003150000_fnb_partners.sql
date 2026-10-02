-- ============================================================================
-- F&B partners: restaurants and cafes reserve the Saturdays our riders come for breakfast.
--
-- The owner's ask (2026-10-03): each venue has an account WE make for it, signs in on its own
-- portal (separate subdomain, name decided later), sees a calendar of the dates open for
-- breakfast (Saturdays for now) and reserves one date, several dates, or a monthly pattern
-- ("the first Saturday of every month", "the last Saturday"). Venues sit in tiers by how they
-- book; each tier's benefits are decided later, so they are a list staff edit. The staff page
-- gets its own section. Owner decisions the same day:
--   * several venues may ask for the same date; every request waits as Pending until staff
--     choose one, and choosing one declines the rest;
--   * one venue per Saturday (a date's capacity can still be raised by staff for a big ride);
--   * three starting tiers: Single, Multi, Recurring.
--
--  1. fnb_tiers     - the tier rules (booking types allowed, a month's limit, how far ahead,
--                     notice needed, cancellation cutoff, priority) and the benefits list.
--                     The seeded numbers are STARTING values, all editable in the staff page.
--  2. fnb_venues    - the venue: name (EN/AR), map link, seats, contact, offer, tier, status.
--  3. fnb_users     - a venue's logins (owner, manager). Password = bcrypt like customers;
--                     a session token like customers; staff make the account with a temporary
--                     password that must be changed at first sign-in.
--  4. fnb_dates     - the dates open for breakfast: open or closed (with a reason such as
--                     Ramadan or weather) and a capacity. The next 26 Saturdays are opened.
--  5. fnb_series    - a venue's monthly pattern (which Saturday, every 1 or 2 months, until).
--  6. fnb_bookings  - one row per date asked for, including each date of a pattern.
--                     A venue can hold one live request per date; a date takes no more
--                     confirmed venues than its capacity (checked under a row lock).
--  7. fnb_audit     - every booking change, with who made it (venue login or staff name).
--  8. A confirmed venue becomes the breakfast stop of that day's Saturday social ride
--     (sessions.breakfast_name / breakfast_url, which riders already see), also when the ride
--     is created after the confirmation. Cancelling clears what this wrote, nothing else.
--  9. Portal functions (anon + token): fnb_login, fnb_set_password, fnb_me, fnb_calendar,
--     fnb_preview, fnb_request, fnb_cancel, fnb_profile_save. A venue never sees which other
--     venue asked for or holds a date, only that it is taken.
-- 10. Staff functions (is_staff; tiers is_admin): staff_fnb_venue_save, staff_fnb_user_add,
--     staff_fnb_user_reset, staff_fnb_user_active, staff_fnb_decide, staff_fnb_date_set,
--     staff_fnb_dates_open, staff_fnb_tier_save. Staff read every table (no password columns).
--
-- Rollback:
--   drop trigger if exists sessions_fnb_breakfast on public.sessions;
--   drop function if exists public._fnb_session_fill();
--   drop function if exists public.staff_fnb_tier_save(jsonb);
--   drop function if exists public.staff_fnb_dates_open(date, date, integer);
--   drop function if exists public.staff_fnb_date_set(date, text, text, integer, text);
--   drop function if exists public.staff_fnb_decide(bigint, text, text, text);
--   drop function if exists public.staff_fnb_user_active(bigint, boolean);
--   drop function if exists public.staff_fnb_user_reset(bigint);
--   drop function if exists public.staff_fnb_user_add(bigint, text, text, text);
--   drop function if exists public.staff_fnb_venue_save(jsonb);
--   drop function if exists public.fnb_profile_save(bigint, text, jsonb);
--   drop function if exists public.fnb_cancel(bigint, text, bigint, text, boolean);
--   drop function if exists public.fnb_request(bigint, text, text, date[], integer, integer, date, date, text);
--   drop function if exists public.fnb_preview(bigint, text, text, date[], integer, integer, date, date);
--   drop function if exists public.fnb_calendar(bigint, text, date, date);
--   drop function if exists public.fnb_me(bigint, text);
--   drop function if exists public.fnb_set_password(bigint, text, text, text);
--   drop function if exists public.fnb_login(text, text);
--   drop function if exists public._fnb_check(bigint, text, text, date[], integer, integer, date, date);
--   drop function if exists public._fnb_pattern_days(integer, integer, date, date);
--   drop function if exists public._fnb_sync_day(date);
--   drop function if exists public._fnb_user(bigint, text);
--   drop function if exists public._fnb_login_key(text);
--   drop function if exists public._fnb_today();
--   drop function if exists public._fnb_audit_row();
--   drop table if exists public.fnb_audit, public.fnb_bookings, public.fnb_series, public.fnb_dates,
--     public.fnb_users, public.fnb_venues, public.fnb_tiers;
--
-- Idempotent: tables and indexes `if not exists`, functions `create or replace`, seeds
-- `on conflict do nothing`, policies dropped before they are made.
-- ============================================================================

-- 1. Tiers --------------------------------------------------------------------
create table if not exists public.fnb_tiers (
  id                 text primary key check (id ~ '^[a-z][a-z0-9_]{1,30}$'),
  name_en            text not null,
  name_ar            text not null default '',
  modes              text[] not null default '{single}'
                       check (modes <@ array['single','multi','recurring']::text[] and cardinality(modes) > 0),
  max_per_month      integer check (max_per_month is null or max_per_month between 1 and 31),
  horizon_days       integer not null default 90  check (horizon_days between 7 and 730),
  min_lead_days      integer not null default 7   check (min_lead_days between 0 and 90),
  cancel_cutoff_days integer not null default 5   check (cancel_cutoff_days between 0 and 90),
  priority           integer not null default 1,
  benefits           jsonb not null default '[]'::jsonb check (jsonb_typeof(benefits) = 'array'),
  active             boolean not null default true,
  sort               integer not null default 0,
  updated_at         timestamptz not null default now()
);

insert into public.fnb_tiers (id, name_en, name_ar, modes, max_per_month, horizon_days, min_lead_days, cancel_cutoff_days, priority, sort)
values
  ('single',    'Single',    'يوم واحد', '{single}',                 1,  60, 7, 5, 1, 1),
  ('multi',     'Multi',     'عدة أيام', '{single,multi}',           2, 120, 7, 5, 2, 2),
  ('recurring', 'Recurring', 'شهري',     '{single,multi,recurring}', 2, 365, 7, 5, 3, 3)
on conflict (id) do nothing;

-- 2. Venues -------------------------------------------------------------------
create table if not exists public.fnb_venues (
  id            bigint generated always as identity primary key,
  name          text not null check (length(trim(name)) between 2 and 80),
  name_ar       text not null default '',
  kind          text not null default 'cafe' check (kind in ('cafe','restaurant','bakery','other')),
  area          text not null default '',
  map_url       text not null default '' check (map_url = '' or map_url ~* '^https://'),
  seats         integer check (seats is null or seats between 1 and 2000),
  contact_name  text not null default '',
  contact_phone text not null default '',
  contact_email text not null default '',
  offer_en      text not null default '' check (length(offer_en) <= 1000),
  offer_ar      text not null default '' check (length(offer_ar) <= 1000),
  staff_notes   text not null default '',
  tier_id       text not null default 'single' references public.fnb_tiers(id),
  status        text not null default 'active' check (status in ('active','paused','ended')),
  created_by    text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 3. Logins -------------------------------------------------------------------
create table if not exists public.fnb_users (
  id              bigint generated always as identity primary key,
  venue_id        bigint not null references public.fnb_venues(id) on delete cascade,
  login           text not null unique check (login <> ''),
  name            text not null default '',
  role            text not null default 'manager' check (role in ('owner','manager')),
  password_hash   text not null,
  session_token   text,
  must_change_pwd boolean not null default true,
  active          boolean not null default true,
  last_login_at   timestamptz,
  created_by      text not null default '',
  created_at      timestamptz not null default now()
);
create index if not exists fnb_users_venue on public.fnb_users(venue_id);

-- 4. Dates --------------------------------------------------------------------
create table if not exists public.fnb_dates (
  day         date primary key,
  state       text not null default 'open' check (state in ('open','closed')),
  reason      text not null default '',
  capacity    integer not null default 1 check (capacity between 1 and 10),
  synced_name text,
  updated_by  text not null default '',
  updated_at  timestamptz not null default now()
);

-- 5. Patterns -----------------------------------------------------------------
create table if not exists public.fnb_series (
  id              bigint generated always as identity primary key,
  venue_id        bigint not null references public.fnb_venues(id) on delete cascade,
  ordinal         integer not null check (ordinal in (1,2,3,4,-1)),
  interval_months integer not null default 1 check (interval_months in (1,2,3)),
  starts_on       date not null,
  until           date not null check (until >= starts_on),
  status          text not null default 'active' check (status in ('active','ended')),
  requested_by    bigint references public.fnb_users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists fnb_series_venue on public.fnb_series(venue_id);

-- 6. Bookings -----------------------------------------------------------------
create table if not exists public.fnb_bookings (
  id            bigint generated always as identity primary key,
  venue_id      bigint not null references public.fnb_venues(id) on delete cascade,
  day           date not null references public.fnb_dates(day),
  series_id     bigint references public.fnb_series(id) on delete set null,
  kind          text not null check (kind in ('single','multi','recurring')),
  status        text not null default 'pending' check (status in ('pending','confirmed','declined','cancelled')),
  note          text not null default '' check (length(note) <= 500),
  staff_note    text not null default '' check (length(staff_note) <= 500),
  requested_by  bigint references public.fnb_users(id) on delete set null,
  decided_by    text not null default '',
  decided_at    timestamptz,
  cancelled_by  text check (cancelled_by in ('venue','mm')),
  cancel_reason text not null default '',
  late_cancel   boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists fnb_bookings_day on public.fnb_bookings(day);
create index if not exists fnb_bookings_venue on public.fnb_bookings(venue_id, day);
create index if not exists fnb_bookings_series on public.fnb_bookings(series_id);
-- One live request per venue per date.
create unique index if not exists fnb_bookings_one_live
  on public.fnb_bookings(venue_id, day) where status in ('pending','confirmed');

-- 7. Audit --------------------------------------------------------------------
create table if not exists public.fnb_audit (
  id         bigint generated always as identity primary key,
  booking_id bigint,
  venue_id   bigint,
  actor      text not null default '',
  action     text not null,
  before     jsonb,
  after      jsonb,
  at         timestamptz not null default now()
);
create index if not exists fnb_audit_booking on public.fnb_audit(booking_id);
create index if not exists fnb_audit_venue on public.fnb_audit(venue_id, at desc);

-- Access: staff read everything (logins without password or token); every write is a function.
do $acl$
declare t text;
begin
  foreach t in array array['fnb_tiers','fnb_venues','fnb_users','fnb_dates','fnb_series','fnb_bookings','fnb_audit'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || ' staff read', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select public.is_staff()))', t || ' staff read', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    if t <> 'fnb_users' then
      execute format('grant select on public.%I to authenticated', t);
    end if;
  end loop;
end $acl$;
grant select (id, venue_id, login, name, role, must_change_pwd, active, last_login_at, created_by, created_at)
  on public.fnb_users to authenticated;

-- Helpers ---------------------------------------------------------------------
create or replace function public._fnb_today()
returns date language sql stable set search_path to 'public'
as $$ select (now() at time zone 'Asia/Riyadh')::date $$;

create or replace function public._fnb_login_key(p text)
returns text language sql immutable set search_path to 'public'
as $$
  select case when position('@' in coalesce(p,'')) > 0 then lower(trim(p))
              else nullif(regexp_replace(coalesce(p,''), '\D', '', 'g'), '') end
$$;

create or replace function public._fnb_user(p_uid bigint, p_token text)
returns public.fnb_users
language plpgsql stable security definer set search_path to 'public'
as $$
declare u fnb_users%rowtype;
begin
  select x.* into u from fnb_users x join fnb_venues v on v.id = x.venue_id
   where x.id = p_uid and x.session_token = p_token and p_token is not null
     and x.active and v.status <> 'ended';
  if not found then raise exception 'BAD_TOKEN' using errcode = '28000'; end if;
  return u;
end $$;

create or replace function public._fnb_audit_row()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  insert into fnb_audit (booking_id, venue_id, actor, action, before, after)
  values (new.id, new.venue_id, coalesce(nullif(current_setting('fnb.actor', true), ''), 'system'),
          case when tg_op = 'INSERT' then 'request' else new.status end,
          case when tg_op = 'UPDATE' then to_jsonb(old) end, to_jsonb(new));
  return null;
end $$;
drop trigger if exists fnb_bookings_audit on public.fnb_bookings;
create trigger fnb_bookings_audit after insert or update on public.fnb_bookings
  for each row execute function public._fnb_audit_row();

-- The Saturday social rides of a day take the confirmed venue as their breakfast stop.
create or replace function public._fnb_sync_day(p_day date)
returns void language plpgsql security definer set search_path to 'public'
as $$
declare v fnb_venues%rowtype; old_name text;
begin
  select synced_name into old_name from fnb_dates where day = p_day;
  select ve.* into v from fnb_bookings b join fnb_venues ve on ve.id = b.venue_id
   where b.day = p_day and b.status = 'confirmed' order by b.decided_at nulls last, b.id limit 1;
  if found then
    update sessions s set breakfast_name = v.name, breakfast_url = nullif(v.map_url, '')
     where s.session_date = p_day::text and s.event_kind = 'community'
       and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.status <> 'deleted'
       and (s.breakfast_name is distinct from v.name or s.breakfast_url is distinct from nullif(v.map_url, ''));
    update fnb_dates set synced_name = v.name where day = p_day;
  elsif old_name is not null then
    update sessions s set breakfast_name = null, breakfast_url = null
     where s.session_date = p_day::text and s.event_kind = 'community'
       and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.breakfast_name = old_name;
    update fnb_dates set synced_name = null where day = p_day;
  end if;
end $$;

create or replace function public._fnb_session_fill()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare v fnb_venues%rowtype;
begin
  if new.event_kind = 'community' and coalesce(new.ride_kind, 'saturday') = 'saturday'
     and new.session_date ~ '^\d{4}-\d{2}-\d{2}$' then
    select ve.* into v from fnb_bookings b join fnb_venues ve on ve.id = b.venue_id
     where b.day = new.session_date::date and b.status = 'confirmed'
     order by b.decided_at nulls last, b.id limit 1;
    if found then
      new.breakfast_name := v.name;
      new.breakfast_url := nullif(v.map_url, '');
      update fnb_dates set synced_name = v.name where day = new.session_date::date;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists sessions_fnb_breakfast on public.sessions;
create trigger sessions_fnb_breakfast before insert on public.sessions
  for each row execute function public._fnb_session_fill();

-- The dates of a monthly pattern: the Nth (1-4) or last (-1) Saturday, every 1-3 months.
create or replace function public._fnb_pattern_days(p_ordinal integer, p_interval integer, p_from date, p_until date)
returns setof date language sql immutable set search_path to 'public'
as $$
  with m as (
    select (date_trunc('month', p_from)::date + make_interval(months => g * greatest(coalesce(p_interval,1),1)))::date as m1
      from generate_series(0, 60) g
  ), d as (
    select case when p_ordinal = -1 then
                  ((m1 + interval '1 month')::date - 1)
                  - ((extract(dow from ((m1 + interval '1 month')::date - 1))::int - 6 + 7) % 7)
                else m1 + ((6 - extract(dow from m1)::int + 7) % 7) + (p_ordinal - 1) * 7
           end as day
      from m where m1 <= p_until
  )
  select day from d where day between p_from and p_until order by day
$$;

-- One verdict per date for a venue's request: ok, closed, not_open, too_soon, too_far, taken,
-- mine, over_quota, not_allowed. The same code checks a preview and a request.
create or replace function public._fnb_check(p_venue bigint, p_mode text, p_days date[], p_ordinal integer,
                                             p_interval integer, p_from date, p_until date)
returns table(day date, verdict text, reason text)
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v fnb_venues%rowtype; t fnb_tiers%rowtype; today date := _fnb_today(); d date; r fnb_dates%rowtype;
  n_conf int; n_month int; mine boolean; lst date[]; used jsonb := '{}'::jsonb; mk text;
begin
  select * into v from fnb_venues where id = p_venue;
  select * into t from fnb_tiers where id = v.tier_id;
  if p_mode = 'recurring' then
    if p_ordinal is null or p_from is null or p_until is null then raise exception 'BAD_PATTERN' using errcode = '22023'; end if;
    select array_agg(x) into lst from _fnb_pattern_days(p_ordinal, p_interval, greatest(p_from, today), least(p_until, today + t.horizon_days)) x;
  else
    select array_agg(distinct x order by x) into lst from unnest(p_days) x;
    if p_mode = 'single' and coalesce(cardinality(lst), 0) <> 1 then raise exception 'ONE_DATE' using errcode = '22023'; end if;
  end if;
  if coalesce(cardinality(lst), 0) = 0 then return; end if;
  if cardinality(lst) > 60 then raise exception 'TOO_MANY' using errcode = '22023'; end if;
  foreach d in array lst loop
    day := d; reason := '';
    select * into r from fnb_dates x where x.day = d;
    if not (p_mode = any(t.modes)) or not t.active or v.status <> 'active' then verdict := 'not_allowed';
    elsif r.day is null then verdict := 'not_open';
    elsif r.state = 'closed' then verdict := 'closed'; reason := r.reason;
    elsif d < today + t.min_lead_days then verdict := 'too_soon';
    elsif d > today + t.horizon_days then verdict := 'too_far';
    else
      select count(*) filter (where b.status = 'confirmed'),
             bool_or(b.venue_id = p_venue and b.status in ('pending','confirmed'))
        into n_conf, mine from fnb_bookings b where b.day = d;
      mk := to_char(d, 'YYYY-MM');
      select count(*) into n_month from fnb_bookings b
       where b.venue_id = p_venue and b.status in ('pending','confirmed') and to_char(b.day, 'YYYY-MM') = mk;
      if coalesce(mine, false) then verdict := 'mine';
      elsif n_conf >= r.capacity then verdict := 'taken';
      elsif t.max_per_month is not null and n_month + coalesce((used ->> mk)::int, 0) >= t.max_per_month then verdict := 'over_quota';
      else verdict := 'ok'; used := used || jsonb_build_object(mk, coalesce((used ->> mk)::int, 0) + 1);
      end if;
    end if;
    return next;
  end loop;
end $$;

-- 9. Portal -------------------------------------------------------------------
create or replace function public.fnb_login(p_login text, p_pwd text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare k text := _fnb_login_key(p_login); u fnb_users%rowtype; thr login_throttle%rowtype; nf int; tok text;
begin
  if k is null or coalesce(p_pwd, '') = '' then raise exception 'BAD_LOGIN' using errcode = '28000'; end if;
  if not _ip_gate('fnb_login', 30, interval '10 minutes') then raise exception 'LOCKED' using errcode = 'P0001'; end if;
  select * into thr from login_throttle where identifier = 'fnb:' || k;
  if thr.locked_until is not null and thr.locked_until > now() then raise exception 'LOCKED' using errcode = 'P0001'; end if;
  select x.* into u from fnb_users x join fnb_venues v on v.id = x.venue_id
   where x.login = k and x.active and v.status <> 'ended';
  if not found or u.password_hash is null or crypt(p_pwd, u.password_hash) <> u.password_hash then
    nf := (case when (thr.locked_until is not null and thr.locked_until <= now()) or thr.updated_at < now() - interval '1 day'
                then 0 else coalesce(thr.fails, 0) end) + 1;
    insert into login_throttle(identifier, fails, locked_until, updated_at)
      values ('fnb:' || k, nf, case when nf >= 8 then now() + interval '15 minutes' end, now())
      on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
    -- Answered, not raised: an exception would undo the failure count above (as customer_login does).
    return jsonb_build_object('error', 'BAD_LOGIN');
  end if;
  delete from login_throttle where identifier = 'fnb:' || k;
  tok := coalesce(nullif(u.session_token, ''), encode(gen_random_bytes(24), 'hex'));
  update fnb_users set session_token = tok, last_login_at = now() where id = u.id;
  return jsonb_build_object('id', u.id, 'token', tok, 'must_change', u.must_change_pwd);
end $$;

-- Change the password: free while a change is due, otherwise the current one is asked for.
-- A new token signs every other device out.
create or replace function public.fnb_set_password(p_uid bigint, p_token text, p_new text, p_old text default null)
returns text language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare u fnb_users%rowtype := _fnb_user(p_uid, p_token); tok text;
begin
  if not u.must_change_pwd and (p_old is null or crypt(p_old, u.password_hash) <> u.password_hash) then
    raise exception 'BAD_PASSWORD' using errcode = '28000';
  end if;
  if length(coalesce(p_new, '')) < 8 or p_new !~ '[A-Z]' or p_new !~ '[0-9]' then
    raise exception 'WEAK_PASSWORD' using errcode = '22023';
  end if;
  if crypt(p_new, u.password_hash) = u.password_hash then raise exception 'SAME_PASSWORD' using errcode = '22023'; end if;
  tok := encode(gen_random_bytes(24), 'hex');
  update fnb_users set password_hash = crypt(p_new, gen_salt('bf')), session_token = tok, must_change_pwd = false where id = u.id;
  return tok;
end $$;

create or replace function public.fnb_me(p_uid bigint, p_token text)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare u fnb_users%rowtype := _fnb_user(p_uid, p_token); v fnb_venues%rowtype; t fnb_tiers%rowtype;
begin
  select * into v from fnb_venues where id = u.venue_id;
  select * into t from fnb_tiers where id = v.tier_id;
  return jsonb_build_object(
    'user', jsonb_build_object('id', u.id, 'name', u.name, 'login', u.login, 'role', u.role, 'must_change', u.must_change_pwd),
    'venue', to_jsonb(v) - 'staff_notes' - 'created_by',
    'tier', to_jsonb(t),
    'today', _fnb_today(),
    'series', coalesce((select jsonb_agg(to_jsonb(s) - 'requested_by' order by s.starts_on) from fnb_series s
                         where s.venue_id = v.id and s.status = 'active' and s.until >= _fnb_today()), '[]'::jsonb));
end $$;

-- The calendar: every open/closed date in the range, this venue's own request on it, whether
-- another venue holds it (never which), and the riders booked on the ride for its confirmed dates.
create or replace function public.fnb_calendar(p_uid bigint, p_token text, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare u fnb_users%rowtype := _fnb_user(p_uid, p_token);
begin
  if p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_RANGE' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'day', d.day, 'state', d.state, 'reason', case when d.state = 'closed' then d.reason else '' end,
      'mine', (select jsonb_build_object('id', b.id, 'status', b.status, 'kind', b.kind, 'series_id', b.series_id,
                                         'note', b.note, 'staff_note', b.staff_note)
                 from fnb_bookings b where b.day = d.day and b.venue_id = u.venue_id
                 order by (b.status in ('pending','confirmed')) desc, b.updated_at desc limit 1),
      'taken', (select count(*) from fnb_bookings b where b.day = d.day and b.status = 'confirmed'
                                                       and b.venue_id <> u.venue_id) >= d.capacity,
      'riders', case when exists(select 1 from fnb_bookings b where b.day = d.day and b.venue_id = u.venue_id and b.status = 'confirmed')
                     then (select count(*) from queue_entries q join sessions s on s.id = q.session_id
                            where s.session_date = d.day::text and s.event_kind = 'community'
                              and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.status <> 'deleted'
                              and q.status in ('waiting','done') and coalesce(q.approval, '') <> 'rejected') end
    ) order by d.day)
    from fnb_dates d where d.day between p_from and p_to), '[]'::jsonb);
end $$;

create or replace function public.fnb_preview(p_uid bigint, p_token text, p_mode text, p_days date[] default null,
                                              p_ordinal integer default null, p_interval integer default 1,
                                              p_from date default null, p_until date default null)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare u fnb_users%rowtype := _fnb_user(p_uid, p_token);
begin
  if p_mode not in ('single','multi','recurring') then raise exception 'BAD_MODE' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('day', c.day, 'verdict', c.verdict, 'reason', c.reason) order by c.day)
                     from _fnb_check(u.venue_id, p_mode, p_days, p_ordinal, p_interval, p_from, p_until) c), '[]'::jsonb);
end $$;

-- Asks for every date the check finds free; the rest are reported back, never half-written.
create or replace function public.fnb_request(p_uid bigint, p_token text, p_mode text, p_days date[] default null,
                                              p_ordinal integer default null, p_interval integer default 1,
                                              p_from date default null, p_until date default null, p_note text default '')
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare u fnb_users%rowtype := _fnb_user(p_uid, p_token); sid bigint; res jsonb := '[]'::jsonb; c record; n int := 0;
begin
  if p_mode not in ('single','multi','recurring') then raise exception 'BAD_MODE' using errcode = '22023'; end if;
  perform 1 from fnb_venues where id = u.venue_id for update;  -- one request at a time per venue (month limits)
  perform set_config('fnb.actor', 'venue:' || u.id, true);
  if p_mode = 'recurring' then
    insert into fnb_series (venue_id, ordinal, interval_months, starts_on, until, requested_by)
    values (u.venue_id, p_ordinal, coalesce(p_interval, 1), greatest(p_from, _fnb_today()), p_until, u.id) returning id into sid;
  end if;
  for c in select * from _fnb_check(u.venue_id, p_mode, p_days, p_ordinal, p_interval, p_from, p_until) loop
    if c.verdict = 'ok' then
      insert into fnb_bookings (venue_id, day, series_id, kind, note, requested_by)
      values (u.venue_id, c.day, sid, p_mode, left(coalesce(p_note, ''), 500), u.id);
      n := n + 1;
    end if;
    res := res || jsonb_build_object('day', c.day, 'verdict', c.verdict, 'reason', c.reason);
  end loop;
  if n = 0 and sid is not null then delete from fnb_series where id = sid; sid := null; end if;
  return jsonb_build_object('requested', n, 'series_id', sid, 'days', res);
end $$;

-- A venue withdraws a request or cancels a confirmed date; p_series cancels every later date of
-- that date's pattern too. Inside the tier's cutoff a confirmed cancel is marked late.
create or replace function public.fnb_cancel(p_uid bigint, p_token text, p_booking bigint, p_reason text default '',
                                             p_series boolean default false)
returns integer language plpgsql security definer set search_path to 'public'
as $$
declare u fnb_users%rowtype := _fnb_user(p_uid, p_token); b fnb_bookings%rowtype; cut int; r record; n int := 0;
begin
  select * into b from fnb_bookings where id = p_booking and venue_id = u.venue_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select t.cancel_cutoff_days into cut from fnb_venues v join fnb_tiers t on t.id = v.tier_id where v.id = u.venue_id;
  perform set_config('fnb.actor', 'venue:' || u.id, true);
  for r in select * from fnb_bookings x
            where x.venue_id = u.venue_id and x.status in ('pending','confirmed') and x.day >= _fnb_today()
              and (x.id = b.id or (p_series and b.series_id is not null and x.series_id = b.series_id and x.day >= b.day))
            for update loop
    update fnb_bookings set status = 'cancelled', cancelled_by = 'venue', cancel_reason = left(coalesce(p_reason, ''), 300),
           late_cancel = (r.status = 'confirmed' and r.day < _fnb_today() + cut), updated_at = now()
     where id = r.id;
    if r.status = 'confirmed' then perform _fnb_sync_day(r.day); end if;
    n := n + 1;
  end loop;
  if p_series and b.series_id is not null then
    update fnb_series set status = 'ended', until = greatest(starts_on, least(until, b.day - 1)) where id = b.series_id;
  end if;
  return n;
end $$;

create or replace function public.fnb_profile_save(p_uid bigint, p_token text, p_data jsonb)
returns void language plpgsql security definer set search_path to 'public'
as $$
declare u fnb_users%rowtype := _fnb_user(p_uid, p_token);
begin
  update fnb_venues set
    map_url       = coalesce(p_data ->> 'map_url', map_url),
    seats         = case when p_data ? 'seats' then nullif(p_data ->> 'seats', '')::int else seats end,
    contact_name  = coalesce(p_data ->> 'contact_name', contact_name),
    contact_phone = coalesce(p_data ->> 'contact_phone', contact_phone),
    contact_email = coalesce(p_data ->> 'contact_email', contact_email),
    offer_en      = coalesce(p_data ->> 'offer_en', offer_en),
    offer_ar      = coalesce(p_data ->> 'offer_ar', offer_ar),
    updated_at    = now()
   where id = u.venue_id;
end $$;

-- 10. Staff -------------------------------------------------------------------
create or replace function public.staff_fnb_venue_save(p jsonb)
returns bigint language plpgsql security definer set search_path to 'public'
as $$
declare vid bigint := nullif(p ->> 'id', '')::bigint;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if vid is null then
    insert into fnb_venues (name, created_by) values (trim(p ->> 'name'), coalesce(p ->> 'by', '')) returning id into vid;
  end if;
  update fnb_venues set
    name          = coalesce(trim(p ->> 'name'), name),
    name_ar       = coalesce(p ->> 'name_ar', name_ar),
    kind          = coalesce(p ->> 'kind', kind),
    area          = coalesce(p ->> 'area', area),
    map_url       = coalesce(p ->> 'map_url', map_url),
    seats         = case when p ? 'seats' then nullif(p ->> 'seats', '')::int else seats end,
    contact_name  = coalesce(p ->> 'contact_name', contact_name),
    contact_phone = coalesce(p ->> 'contact_phone', contact_phone),
    contact_email = coalesce(p ->> 'contact_email', contact_email),
    offer_en      = coalesce(p ->> 'offer_en', offer_en),
    offer_ar      = coalesce(p ->> 'offer_ar', offer_ar),
    staff_notes   = coalesce(p ->> 'staff_notes', staff_notes),
    tier_id       = coalesce(p ->> 'tier_id', tier_id),
    status        = coalesce(p ->> 'status', status),
    updated_at    = now()
   where id = vid;
  return vid;
end $$;

-- A new login with a temporary password; the password is returned once, for staff to send.
create or replace function public.staff_fnb_user_add(p_venue bigint, p_login text, p_name text, p_role text default 'manager')
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare k text := _fnb_login_key(p_login); pw text := _community_temp_pwd(); uid bigint;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if k is null then raise exception 'BAD_LOGIN' using errcode = '22023'; end if;
  if exists(select 1 from fnb_users where login = k) then raise exception 'LOGIN_TAKEN' using errcode = '23505'; end if;
  insert into fnb_users (venue_id, login, name, role, password_hash, must_change_pwd)
  values (p_venue, k, coalesce(trim(p_name), ''), coalesce(p_role, 'manager'), crypt(pw, gen_salt('bf')), true)
  returning id into uid;
  return jsonb_build_object('id', uid, 'login', k, 'password', pw);
end $$;

create or replace function public.staff_fnb_user_reset(p_user bigint)
returns text language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare pw text := _community_temp_pwd(); k text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  update fnb_users set password_hash = crypt(pw, gen_salt('bf')), must_change_pwd = true, session_token = null
   where id = p_user returning login into k;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  delete from login_throttle where identifier = 'fnb:' || k;
  return pw;
end $$;

create or replace function public.staff_fnb_user_active(p_user bigint, p_active boolean)
returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  update fnb_users set active = p_active, session_token = case when p_active then session_token end where id = p_user;
end $$;

-- confirm (declines the date's other requests once it is full), decline, cancel (a confirmed date, by us).
create or replace function public.staff_fnb_decide(p_booking bigint, p_action text, p_note text default '', p_by text default '')
returns void language plpgsql security definer set search_path to 'public'
as $$
declare b fnb_bookings%rowtype; cap int; n int;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  perform set_config('fnb.actor', 'staff:' || coalesce(p_by, ''), true);
  select * into b from fnb_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select capacity into cap from fnb_dates where day = b.day for update;
  if p_action = 'confirm' then
    if b.status <> 'pending' then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
    select count(*) into n from fnb_bookings where day = b.day and status = 'confirmed';
    if n >= cap then raise exception 'DATE_FULL' using errcode = 'P0001'; end if;
    update fnb_bookings set status = 'confirmed', staff_note = left(coalesce(p_note, ''), 500),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now() where id = b.id;
    if n + 1 >= cap then
      update fnb_bookings set status = 'declined', staff_note = 'another_venue', decided_by = coalesce(p_by, ''),
             decided_at = now(), updated_at = now()
       where day = b.day and status = 'pending' and id <> b.id;
    end if;
  elsif p_action = 'decline' then
    if b.status <> 'pending' then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
    update fnb_bookings set status = 'declined', staff_note = left(coalesce(p_note, ''), 500),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now() where id = b.id;
  elsif p_action = 'cancel' then
    if b.status not in ('pending','confirmed') then raise exception 'NOT_LIVE' using errcode = 'P0001'; end if;
    update fnb_bookings set status = 'cancelled', cancelled_by = 'mm', cancel_reason = left(coalesce(p_note, ''), 300),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now() where id = b.id;
  else
    raise exception 'BAD_ACTION' using errcode = '22023';
  end if;
  perform _fnb_sync_day(b.day);
end $$;

-- Open, close (cancels the date's live requests, by us, with the reason) or resize one date.
create or replace function public.staff_fnb_date_set(p_day date, p_state text, p_reason text default '',
                                                     p_capacity integer default null, p_by text default '')
returns integer language plpgsql security definer set search_path to 'public'
as $$
declare n int := 0;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_state not in ('open','closed','remove') then raise exception 'BAD_STATE' using errcode = '22023'; end if;
  perform set_config('fnb.actor', 'staff:' || coalesce(p_by, ''), true);
  if p_state = 'remove' then
    if exists(select 1 from fnb_bookings where day = p_day) then raise exception 'HAS_BOOKINGS' using errcode = 'P0001'; end if;
    delete from fnb_dates where day = p_day;
    return 0;
  end if;
  insert into fnb_dates (day, state, reason, capacity, updated_by)
  values (p_day, p_state, coalesce(p_reason, ''), coalesce(p_capacity, 1), coalesce(p_by, ''))
  on conflict (day) do update set state = excluded.state, reason = excluded.reason,
     capacity = coalesce(p_capacity, fnb_dates.capacity), updated_by = excluded.updated_by, updated_at = now();
  if p_state = 'closed' then
    update fnb_bookings set status = 'cancelled', cancelled_by = 'mm', cancel_reason = coalesce(nullif(p_reason, ''), 'closed'),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now()
     where day = p_day and status in ('pending','confirmed');
    get diagnostics n = row_count;
    perform _fnb_sync_day(p_day);
  end if;
  return n;
end $$;

-- Open every given weekday (6 = Saturday) in a range that has no row yet.
create or replace function public.staff_fnb_dates_open(p_from date, p_to date, p_weekday integer default 6)
returns integer language plpgsql security definer set search_path to 'public'
as $$
declare n int;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_RANGE' using errcode = '22023'; end if;
  insert into fnb_dates (day) select g::date from generate_series(p_from, p_to, interval '1 day') g
   where extract(dow from g)::int = p_weekday on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.staff_fnb_tier_save(p jsonb)
returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  insert into fnb_tiers (id, name_en) values (p ->> 'id', coalesce(p ->> 'name_en', p ->> 'id')) on conflict (id) do nothing;
  update fnb_tiers set
    name_en            = coalesce(p ->> 'name_en', name_en),
    name_ar            = coalesce(p ->> 'name_ar', name_ar),
    modes              = coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'modes') x), modes),
    max_per_month      = case when p ? 'max_per_month' then nullif(p ->> 'max_per_month', '')::int else max_per_month end,
    horizon_days       = coalesce((p ->> 'horizon_days')::int, horizon_days),
    min_lead_days      = coalesce((p ->> 'min_lead_days')::int, min_lead_days),
    cancel_cutoff_days = coalesce((p ->> 'cancel_cutoff_days')::int, cancel_cutoff_days),
    priority           = coalesce((p ->> 'priority')::int, priority),
    benefits           = coalesce(p -> 'benefits', benefits),
    active             = coalesce((p ->> 'active')::boolean, active),
    sort               = coalesce((p ->> 'sort')::int, sort),
    updated_at         = now()
   where id = p ->> 'id';
end $$;

-- Seed: the next 26 Saturdays are open.
insert into public.fnb_dates (day)
select g::date from generate_series(public._fnb_today(), public._fnb_today() + 182, interval '1 day') g
 where extract(dow from g)::int = 6
on conflict do nothing;

-- Grants ----------------------------------------------------------------------
revoke all on function public._fnb_today() from public, anon, authenticated;
revoke all on function public._fnb_login_key(text) from public, anon, authenticated;
revoke all on function public._fnb_user(bigint, text) from public, anon, authenticated;
revoke all on function public._fnb_audit_row() from public, anon, authenticated;
revoke all on function public._fnb_sync_day(date) from public, anon, authenticated;
revoke all on function public._fnb_session_fill() from public, anon, authenticated;
revoke all on function public._fnb_pattern_days(integer, integer, date, date) from public, anon, authenticated;
revoke all on function public._fnb_check(bigint, text, date[], integer, integer, date, date) from public, anon, authenticated;

revoke all on function public.fnb_login(text, text) from public;
revoke all on function public.fnb_set_password(bigint, text, text, text) from public;
revoke all on function public.fnb_me(bigint, text) from public;
revoke all on function public.fnb_calendar(bigint, text, date, date) from public;
revoke all on function public.fnb_preview(bigint, text, text, date[], integer, integer, date, date) from public;
revoke all on function public.fnb_request(bigint, text, text, date[], integer, integer, date, date, text) from public;
revoke all on function public.fnb_cancel(bigint, text, bigint, text, boolean) from public;
revoke all on function public.fnb_profile_save(bigint, text, jsonb) from public;
grant execute on function public.fnb_login(text, text) to anon, authenticated;
grant execute on function public.fnb_set_password(bigint, text, text, text) to anon, authenticated;
grant execute on function public.fnb_me(bigint, text) to anon, authenticated;
grant execute on function public.fnb_calendar(bigint, text, date, date) to anon, authenticated;
grant execute on function public.fnb_preview(bigint, text, text, date[], integer, integer, date, date) to anon, authenticated;
grant execute on function public.fnb_request(bigint, text, text, date[], integer, integer, date, date, text) to anon, authenticated;
grant execute on function public.fnb_cancel(bigint, text, bigint, text, boolean) to anon, authenticated;
grant execute on function public.fnb_profile_save(bigint, text, jsonb) to anon, authenticated;

revoke all on function public.staff_fnb_venue_save(jsonb) from public, anon;
revoke all on function public.staff_fnb_user_add(bigint, text, text, text) from public, anon;
revoke all on function public.staff_fnb_user_reset(bigint) from public, anon;
revoke all on function public.staff_fnb_user_active(bigint, boolean) from public, anon;
revoke all on function public.staff_fnb_decide(bigint, text, text, text) from public, anon;
revoke all on function public.staff_fnb_date_set(date, text, text, integer, text) from public, anon;
revoke all on function public.staff_fnb_dates_open(date, date, integer) from public, anon;
revoke all on function public.staff_fnb_tier_save(jsonb) from public, anon;
grant execute on function public.staff_fnb_venue_save(jsonb) to authenticated;
grant execute on function public.staff_fnb_user_add(bigint, text, text, text) to authenticated;
grant execute on function public.staff_fnb_user_reset(bigint) to authenticated;
grant execute on function public.staff_fnb_user_active(bigint, boolean) to authenticated;
grant execute on function public.staff_fnb_decide(bigint, text, text, text) to authenticated;
grant execute on function public.staff_fnb_date_set(date, text, text, integer, text) to authenticated;
grant execute on function public.staff_fnb_dates_open(date, date, integer) to authenticated;
grant execute on function public.staff_fnb_tier_save(jsonb) to authenticated;
