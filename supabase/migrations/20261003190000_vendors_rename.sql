-- ============================================================================
-- Vendors: the F&B partner objects renamed fnb_* -> vendor_* (the owner, 2026-10-03: "change the name
-- from fnb to vendors"; the visible name was already Vendors).
--
-- Renamed IN PLACE: the eight tables keep their rows, grants and row-level security; their
-- indexes, constraints, identity sequences and policies are renamed with them. Only the functions
-- are made again under their new names (a function's body names the tables, so renaming the
-- function alone would leave it pointing at fnb_*), from the final state of
-- 20261003150000_fnb_partners, 20261003170000_fnb_login_no_ip_gate and 20261003180000_fnb_feedback:
--   fnb_X -> vendor_X, _fnb_X -> _vendor_X, staff_fnb_X -> staff_vendor_X,
--   sessions_fnb_breakfast -> sessions_vendor_breakfast, fnb_bookings_audit -> vendor_bookings_audit,
--   the fnb.actor setting -> vendor.actor, login_throttle keys 'fnb:<login>' -> 'vendor:<login>'.
-- Columns are unchanged (venue_id and the rest).
--
-- Rollback: the same renames the other way, then re-run the three fnb migrations' functions.
-- ============================================================================

-- 1. The old triggers and functions come off (code only; no row is touched).
drop trigger if exists sessions_fnb_breakfast on public.sessions;
drop trigger if exists fnb_bookings_audit on public.fnb_bookings;
do $old$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'fnb\_%' or p.proname like '\_fnb\_%' or p.proname like 'staff\_fnb\_%') loop
    execute format('drop function %s', f);
  end loop;
end $old$;

-- 2. Tables renamed, then their constraints, indexes, sequences and policies.
alter table public.fnb_tiers rename to vendor_tiers;
alter table public.fnb_venues rename to vendor_venues;
alter table public.fnb_users rename to vendor_users;
alter table public.fnb_dates rename to vendor_dates;
alter table public.fnb_series rename to vendor_series;
alter table public.fnb_bookings rename to vendor_bookings;
alter table public.fnb_audit rename to vendor_audit;
alter table public.fnb_feedback rename to vendor_feedback;
do $ren$
declare r record;
begin
  -- Constraints first (a primary key or unique constraint renames its index with it).
  for r in select c.conrelid::regclass as tbl, c.conname from pg_constraint c
            join pg_class t on t.oid = c.conrelid
           where t.relnamespace = 'public'::regnamespace and t.relname like 'vendor\_%' and c.conname like 'fnb\_%' loop
    execute format('alter table %s rename constraint %I to %I', r.tbl, r.conname, 'vendor_' || substr(r.conname, 5));
  end loop;
  for r in select indexname from pg_indexes
            where schemaname = 'public' and tablename like 'vendor\_%' and indexname like 'fnb\_%' loop
    execute format('alter index public.%I rename to %I', r.indexname, 'vendor_' || substr(r.indexname, 5));
  end loop;
  for r in select relname from pg_class
            where relkind = 'S' and relnamespace = 'public'::regnamespace and relname like 'fnb\_%' loop
    execute format('alter sequence public.%I rename to %I', r.relname, 'vendor_' || substr(r.relname, 5));
  end loop;
  for r in select tablename, policyname from pg_policies
            where schemaname = 'public' and tablename like 'vendor\_%' and policyname like 'fnb\_%' loop
    execute format('alter policy %I on public.%I rename to %I', r.policyname, r.tablename, 'vendor_' || substr(r.policyname, 5));
  end loop;
end $ren$;

update public.login_throttle set identifier = 'vendor:' || substr(identifier, 5) where identifier like 'fnb:%';

-- 3. The functions under their new names.
-- Helpers ---------------------------------------------------------------------
create or replace function public._vendor_today()
returns date language sql stable set search_path to 'public'
as $$ select (now() at time zone 'Asia/Riyadh')::date $$;

create or replace function public._vendor_login_key(p text)
returns text language sql immutable set search_path to 'public'
as $$
  select case when position('@' in coalesce(p,'')) > 0 then lower(trim(p))
              else nullif(regexp_replace(coalesce(p,''), '\D', '', 'g'), '') end
$$;

create or replace function public._vendor_user(p_uid bigint, p_token text)
returns public.vendor_users
language plpgsql stable security definer set search_path to 'public'
as $$
declare u vendor_users%rowtype;
begin
  select x.* into u from vendor_users x join vendor_venues v on v.id = x.venue_id
   where x.id = p_uid and x.session_token = p_token and p_token is not null
     and x.active and v.status <> 'ended';
  if not found then raise exception 'BAD_TOKEN' using errcode = '28000'; end if;
  return u;
end $$;

create or replace function public._vendor_audit_row()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
begin
  insert into vendor_audit (booking_id, venue_id, actor, action, before, after)
  values (new.id, new.venue_id, coalesce(nullif(current_setting('vendor.actor', true), ''), 'system'),
          case when tg_op = 'INSERT' then 'request' else new.status end,
          case when tg_op = 'UPDATE' then to_jsonb(old) end, to_jsonb(new));
  return null;
end $$;

-- The Saturday social rides of a day take the confirmed venue as their breakfast stop.
create or replace function public._vendor_sync_day(p_day date)
returns void language plpgsql security definer set search_path to 'public'
as $$
declare v vendor_venues%rowtype; old_name text;
begin
  select synced_name into old_name from vendor_dates where day = p_day;
  select ve.* into v from vendor_bookings b join vendor_venues ve on ve.id = b.venue_id
   where b.day = p_day and b.status = 'confirmed' order by b.decided_at nulls last, b.id limit 1;
  if found then
    update sessions s set breakfast_name = v.name, breakfast_url = nullif(v.map_url, '')
     where s.session_date = p_day::text and s.event_kind = 'community'
       and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.status <> 'deleted'
       and (s.breakfast_name is distinct from v.name or s.breakfast_url is distinct from nullif(v.map_url, ''));
    update vendor_dates set synced_name = v.name where day = p_day;
  elsif old_name is not null then
    update sessions s set breakfast_name = null, breakfast_url = null
     where s.session_date = p_day::text and s.event_kind = 'community'
       and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.breakfast_name = old_name;
    update vendor_dates set synced_name = null where day = p_day;
  end if;
end $$;

create or replace function public._vendor_session_fill()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare v vendor_venues%rowtype;
begin
  if new.event_kind = 'community' and coalesce(new.ride_kind, 'saturday') = 'saturday'
     and new.session_date ~ '^\d{4}-\d{2}-\d{2}$' then
    select ve.* into v from vendor_bookings b join vendor_venues ve on ve.id = b.venue_id
     where b.day = new.session_date::date and b.status = 'confirmed'
     order by b.decided_at nulls last, b.id limit 1;
    if found then
      new.breakfast_name := v.name;
      new.breakfast_url := nullif(v.map_url, '');
      update vendor_dates set synced_name = v.name where day = new.session_date::date;
    end if;
  end if;
  return new;
end $$;

-- The dates of a monthly pattern: the Nth (1-4) or last (-1) Saturday, every 1-3 months.
create or replace function public._vendor_pattern_days(p_ordinal integer, p_interval integer, p_from date, p_until date)
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
create or replace function public._vendor_check(p_venue bigint, p_mode text, p_days date[], p_ordinal integer,
                                             p_interval integer, p_from date, p_until date)
returns table(day date, verdict text, reason text)
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v vendor_venues%rowtype; t vendor_tiers%rowtype; today date := _vendor_today(); d date; r vendor_dates%rowtype;
  n_conf int; n_month int; mine boolean; lst date[]; used jsonb := '{}'::jsonb; mk text;
begin
  select * into v from vendor_venues where id = p_venue;
  select * into t from vendor_tiers where id = v.tier_id;
  if p_mode = 'recurring' then
    if p_ordinal is null or p_from is null or p_until is null then raise exception 'BAD_PATTERN' using errcode = '22023'; end if;
    select array_agg(x) into lst from _vendor_pattern_days(p_ordinal, p_interval, greatest(p_from, today), least(p_until, today + t.horizon_days)) x;
  else
    select array_agg(distinct x order by x) into lst from unnest(p_days) x;
    if p_mode = 'single' and coalesce(cardinality(lst), 0) <> 1 then raise exception 'ONE_DATE' using errcode = '22023'; end if;
  end if;
  if coalesce(cardinality(lst), 0) = 0 then return; end if;
  if cardinality(lst) > 60 then raise exception 'TOO_MANY' using errcode = '22023'; end if;
  foreach d in array lst loop
    day := d; reason := '';
    select * into r from vendor_dates x where x.day = d;
    if not (p_mode = any(t.modes)) or not t.active or v.status <> 'active' then verdict := 'not_allowed';
    elsif r.day is null then verdict := 'not_open';
    elsif r.state = 'closed' then verdict := 'closed'; reason := r.reason;
    elsif d < today + t.min_lead_days then verdict := 'too_soon';
    elsif d > today + t.horizon_days then verdict := 'too_far';
    else
      select count(*) filter (where b.status = 'confirmed'),
             bool_or(b.venue_id = p_venue and b.status in ('pending','confirmed'))
        into n_conf, mine from vendor_bookings b where b.day = d;
      mk := to_char(d, 'YYYY-MM');
      select count(*) into n_month from vendor_bookings b
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

create or replace function public.vendor_login(p_login text, p_pwd text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare k text := _vendor_login_key(p_login); u vendor_users%rowtype; thr login_throttle%rowtype; nf int; tok text;
begin
  if k is null or coalesce(p_pwd, '') = '' then raise exception 'BAD_LOGIN' using errcode = '28000'; end if;
  select * into thr from login_throttle where identifier = 'vendor:' || k;
  if thr.locked_until is not null and thr.locked_until > now() then raise exception 'LOCKED' using errcode = 'P0001'; end if;
  select x.* into u from vendor_users x join vendor_venues v on v.id = x.venue_id
   where x.login = k and x.active and v.status <> 'ended';
  if not found or u.password_hash is null or crypt(p_pwd, u.password_hash) <> u.password_hash then
    nf := (case when (thr.locked_until is not null and thr.locked_until <= now()) or thr.updated_at < now() - interval '1 day'
                then 0 else coalesce(thr.fails, 0) end) + 1;
    insert into login_throttle(identifier, fails, locked_until, updated_at)
      values ('vendor:' || k, nf, case when nf >= 8 then now() + interval '15 minutes' end, now())
      on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
    -- Answered, not raised: an exception would undo the failure count above (as customer_login does).
    return jsonb_build_object('error', 'BAD_LOGIN');
  end if;
  delete from login_throttle where identifier = 'vendor:' || k;
  tok := coalesce(nullif(u.session_token, ''), encode(gen_random_bytes(24), 'hex'));
  update vendor_users set session_token = tok, last_login_at = now() where id = u.id;
  return jsonb_build_object('id', u.id, 'token', tok, 'must_change', u.must_change_pwd);
end $$;

-- Change the password: free while a change is due, otherwise the current one is asked for.
-- A new token signs every other device out.
create or replace function public.vendor_set_password(p_uid bigint, p_token text, p_new text, p_old text default null)
returns text language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token); tok text;
begin
  if not u.must_change_pwd and (p_old is null or crypt(p_old, u.password_hash) <> u.password_hash) then
    raise exception 'BAD_PASSWORD' using errcode = '28000';
  end if;
  if length(coalesce(p_new, '')) < 8 or p_new !~ '[A-Z]' or p_new !~ '[0-9]' then
    raise exception 'WEAK_PASSWORD' using errcode = '22023';
  end if;
  if crypt(p_new, u.password_hash) = u.password_hash then raise exception 'SAME_PASSWORD' using errcode = '22023'; end if;
  tok := encode(gen_random_bytes(24), 'hex');
  update vendor_users set password_hash = crypt(p_new, gen_salt('bf')), session_token = tok, must_change_pwd = false where id = u.id;
  return tok;
end $$;

create or replace function public.vendor_me(p_uid bigint, p_token text)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token); v vendor_venues%rowtype; t vendor_tiers%rowtype;
begin
  select * into v from vendor_venues where id = u.venue_id;
  select * into t from vendor_tiers where id = v.tier_id;
  return jsonb_build_object(
    'user', jsonb_build_object('id', u.id, 'name', u.name, 'login', u.login, 'role', u.role, 'must_change', u.must_change_pwd),
    'venue', to_jsonb(v) - 'staff_notes' - 'created_by',
    'tier', to_jsonb(t),
    'today', _vendor_today(),
    'series', coalesce((select jsonb_agg(to_jsonb(s) - 'requested_by' order by s.starts_on) from vendor_series s
                         where s.venue_id = v.id and s.status = 'active' and s.until >= _vendor_today()), '[]'::jsonb));
end $$;

-- vendor_calendar, as in 20261003150000, with mine.feedback and mine.feedback_open added.
create or replace function public.vendor_calendar(p_uid bigint, p_token text, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token); today date := _vendor_today();
begin
  if p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_RANGE' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'day', d.day, 'state', d.state, 'reason', case when d.state = 'closed' then d.reason else '' end,
      'mine', (select jsonb_build_object('id', b.id, 'status', b.status, 'kind', b.kind, 'series_id', b.series_id,
                                         'note', b.note, 'staff_note', b.staff_note,
                                         'feedback', (select to_jsonb(f) - 'submitted_by' from vendor_feedback f where f.booking_id = b.id),
                                         'feedback_open', b.status = 'confirmed' and today between b.day and b.day + 14)
                 from vendor_bookings b where b.day = d.day and b.venue_id = u.venue_id
                 order by (b.status in ('pending','confirmed')) desc, b.updated_at desc limit 1),
      'taken', (select count(*) from vendor_bookings b where b.day = d.day and b.status = 'confirmed'
                                                       and b.venue_id <> u.venue_id) >= d.capacity,
      'riders', case when exists(select 1 from vendor_bookings b where b.day = d.day and b.venue_id = u.venue_id and b.status = 'confirmed')
                     then (select count(*) from queue_entries q join sessions s on s.id = q.session_id
                            where s.session_date = d.day::text and s.event_kind = 'community'
                              and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.status <> 'deleted'
                              and q.status in ('waiting','done') and coalesce(q.approval, '') <> 'rejected') end
    ) order by d.day)
    from vendor_dates d where d.day between p_from and p_to), '[]'::jsonb);
end $$;

create or replace function public.vendor_preview(p_uid bigint, p_token text, p_mode text, p_days date[] default null,
                                              p_ordinal integer default null, p_interval integer default 1,
                                              p_from date default null, p_until date default null)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token);
begin
  if p_mode not in ('single','multi','recurring') then raise exception 'BAD_MODE' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('day', c.day, 'verdict', c.verdict, 'reason', c.reason) order by c.day)
                     from _vendor_check(u.venue_id, p_mode, p_days, p_ordinal, p_interval, p_from, p_until) c), '[]'::jsonb);
end $$;

-- Asks for every date the check finds free; the rest are reported back, never half-written.
create or replace function public.vendor_request(p_uid bigint, p_token text, p_mode text, p_days date[] default null,
                                              p_ordinal integer default null, p_interval integer default 1,
                                              p_from date default null, p_until date default null, p_note text default '')
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token); sid bigint; res jsonb := '[]'::jsonb; c record; n int := 0;
begin
  if p_mode not in ('single','multi','recurring') then raise exception 'BAD_MODE' using errcode = '22023'; end if;
  perform 1 from vendor_venues where id = u.venue_id for update;  -- one request at a time per venue (month limits)
  perform set_config('vendor.actor', 'venue:' || u.id, true);
  if p_mode = 'recurring' then
    insert into vendor_series (venue_id, ordinal, interval_months, starts_on, until, requested_by)
    values (u.venue_id, p_ordinal, coalesce(p_interval, 1), greatest(p_from, _vendor_today()), p_until, u.id) returning id into sid;
  end if;
  for c in select * from _vendor_check(u.venue_id, p_mode, p_days, p_ordinal, p_interval, p_from, p_until) loop
    if c.verdict = 'ok' then
      insert into vendor_bookings (venue_id, day, series_id, kind, note, requested_by)
      values (u.venue_id, c.day, sid, p_mode, left(coalesce(p_note, ''), 500), u.id);
      n := n + 1;
    end if;
    res := res || jsonb_build_object('day', c.day, 'verdict', c.verdict, 'reason', c.reason);
  end loop;
  if n = 0 and sid is not null then delete from vendor_series where id = sid; sid := null; end if;
  return jsonb_build_object('requested', n, 'series_id', sid, 'days', res);
end $$;

-- A venue withdraws a request or cancels a confirmed date; p_series cancels every later date of
-- that date's pattern too. Inside the tier's cutoff a confirmed cancel is marked late.
create or replace function public.vendor_cancel(p_uid bigint, p_token text, p_booking bigint, p_reason text default '',
                                             p_series boolean default false)
returns integer language plpgsql security definer set search_path to 'public'
as $$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token); b vendor_bookings%rowtype; cut int; r record; n int := 0;
begin
  select * into b from vendor_bookings where id = p_booking and venue_id = u.venue_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select t.cancel_cutoff_days into cut from vendor_venues v join vendor_tiers t on t.id = v.tier_id where v.id = u.venue_id;
  perform set_config('vendor.actor', 'venue:' || u.id, true);
  for r in select * from vendor_bookings x
            where x.venue_id = u.venue_id and x.status in ('pending','confirmed') and x.day >= _vendor_today()
              and (x.id = b.id or (p_series and b.series_id is not null and x.series_id = b.series_id and x.day >= b.day))
            for update loop
    update vendor_bookings set status = 'cancelled', cancelled_by = 'venue', cancel_reason = left(coalesce(p_reason, ''), 300),
           late_cancel = (r.status = 'confirmed' and r.day < _vendor_today() + cut), updated_at = now()
     where id = r.id;
    if r.status = 'confirmed' then perform _vendor_sync_day(r.day); end if;
    n := n + 1;
  end loop;
  if p_series and b.series_id is not null then
    update vendor_series set status = 'ended', until = greatest(starts_on, least(until, b.day - 1)) where id = b.series_id;
  end if;
  return n;
end $$;

create or replace function public.vendor_profile_save(p_uid bigint, p_token text, p_data jsonb)
returns void language plpgsql security definer set search_path to 'public'
as $$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token);
begin
  update vendor_venues set
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

create or replace function public.vendor_feedback_save(p_uid bigint, p_token text, p_booking bigint, p_rating integer,
                                                    p_turnout integer default null, p_went_well text default '',
                                                    p_improve text default '')
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token); b vendor_bookings%rowtype; today date := _vendor_today(); f vendor_feedback%rowtype;
begin
  select * into b from vendor_bookings where id = p_booking and venue_id = u.venue_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if b.status <> 'confirmed' then raise exception 'NOT_CONFIRMED' using errcode = 'P0001'; end if;
  if today < b.day then raise exception 'TOO_EARLY' using errcode = 'P0001'; end if;
  if today > b.day + 14 then raise exception 'TOO_LATE' using errcode = 'P0001'; end if;
  if p_rating is null or p_rating not between 1 and 5 then raise exception 'BAD_RATING' using errcode = '22023'; end if;
  insert into vendor_feedback as x (booking_id, venue_id, day, rating, turnout, went_well, improve, submitted_by)
  values (b.id, b.venue_id, b.day, p_rating, p_turnout, left(coalesce(p_went_well, ''), 1000), left(coalesce(p_improve, ''), 1000), u.id)
  on conflict (booking_id) do update set rating = excluded.rating, turnout = excluded.turnout,
     went_well = excluded.went_well, improve = excluded.improve, submitted_by = excluded.submitted_by, updated_at = now()
  returning * into f;
  return to_jsonb(f) - 'submitted_by';
end $$;

-- 10. Staff -------------------------------------------------------------------
create or replace function public.staff_vendor_venue_save(p jsonb)
returns bigint language plpgsql security definer set search_path to 'public'
as $$
declare vid bigint := nullif(p ->> 'id', '')::bigint;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if vid is null then
    insert into vendor_venues (name, created_by) values (trim(p ->> 'name'), coalesce(p ->> 'by', '')) returning id into vid;
  end if;
  update vendor_venues set
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
create or replace function public.staff_vendor_user_add(p_venue bigint, p_login text, p_name text, p_role text default 'manager')
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare k text := _vendor_login_key(p_login); pw text := _community_temp_pwd(); uid bigint;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if k is null then raise exception 'BAD_LOGIN' using errcode = '22023'; end if;
  if exists(select 1 from vendor_users where login = k) then raise exception 'LOGIN_TAKEN' using errcode = '23505'; end if;
  insert into vendor_users (venue_id, login, name, role, password_hash, must_change_pwd)
  values (p_venue, k, coalesce(trim(p_name), ''), coalesce(p_role, 'manager'), crypt(pw, gen_salt('bf')), true)
  returning id into uid;
  return jsonb_build_object('id', uid, 'login', k, 'password', pw);
end $$;

create or replace function public.staff_vendor_user_reset(p_user bigint)
returns text language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare pw text := _community_temp_pwd(); k text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  update vendor_users set password_hash = crypt(pw, gen_salt('bf')), must_change_pwd = true, session_token = null
   where id = p_user returning login into k;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  delete from login_throttle where identifier = 'vendor:' || k;
  return pw;
end $$;

create or replace function public.staff_vendor_user_active(p_user bigint, p_active boolean)
returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  update vendor_users set active = p_active, session_token = case when p_active then session_token end where id = p_user;
end $$;

-- confirm (declines the date's other requests once it is full), decline, cancel (a confirmed date, by us).
create or replace function public.staff_vendor_decide(p_booking bigint, p_action text, p_note text default '', p_by text default '')
returns void language plpgsql security definer set search_path to 'public'
as $$
declare b vendor_bookings%rowtype; cap int; n int;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  perform set_config('vendor.actor', 'staff:' || coalesce(p_by, ''), true);
  select * into b from vendor_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select capacity into cap from vendor_dates where day = b.day for update;
  if p_action = 'confirm' then
    if b.status <> 'pending' then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
    select count(*) into n from vendor_bookings where day = b.day and status = 'confirmed';
    if n >= cap then raise exception 'DATE_FULL' using errcode = 'P0001'; end if;
    update vendor_bookings set status = 'confirmed', staff_note = left(coalesce(p_note, ''), 500),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now() where id = b.id;
    if n + 1 >= cap then
      update vendor_bookings set status = 'declined', staff_note = 'another_venue', decided_by = coalesce(p_by, ''),
             decided_at = now(), updated_at = now()
       where day = b.day and status = 'pending' and id <> b.id;
    end if;
  elsif p_action = 'decline' then
    if b.status <> 'pending' then raise exception 'NOT_PENDING' using errcode = 'P0001'; end if;
    update vendor_bookings set status = 'declined', staff_note = left(coalesce(p_note, ''), 500),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now() where id = b.id;
  elsif p_action = 'cancel' then
    if b.status not in ('pending','confirmed') then raise exception 'NOT_LIVE' using errcode = 'P0001'; end if;
    update vendor_bookings set status = 'cancelled', cancelled_by = 'mm', cancel_reason = left(coalesce(p_note, ''), 300),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now() where id = b.id;
  else
    raise exception 'BAD_ACTION' using errcode = '22023';
  end if;
  perform _vendor_sync_day(b.day);
end $$;

-- Open, close (cancels the date's live requests, by us, with the reason) or resize one date.
create or replace function public.staff_vendor_date_set(p_day date, p_state text, p_reason text default '',
                                                     p_capacity integer default null, p_by text default '')
returns integer language plpgsql security definer set search_path to 'public'
as $$
declare n int := 0;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_state not in ('open','closed','remove') then raise exception 'BAD_STATE' using errcode = '22023'; end if;
  perform set_config('vendor.actor', 'staff:' || coalesce(p_by, ''), true);
  if p_state = 'remove' then
    if exists(select 1 from vendor_bookings where day = p_day) then raise exception 'HAS_BOOKINGS' using errcode = 'P0001'; end if;
    delete from vendor_dates where day = p_day;
    return 0;
  end if;
  insert into vendor_dates (day, state, reason, capacity, updated_by)
  values (p_day, p_state, coalesce(p_reason, ''), coalesce(p_capacity, 1), coalesce(p_by, ''))
  on conflict (day) do update set state = excluded.state, reason = excluded.reason,
     capacity = coalesce(p_capacity, vendor_dates.capacity), updated_by = excluded.updated_by, updated_at = now();
  if p_state = 'closed' then
    update vendor_bookings set status = 'cancelled', cancelled_by = 'mm', cancel_reason = coalesce(nullif(p_reason, ''), 'closed'),
           decided_by = coalesce(p_by, ''), decided_at = now(), updated_at = now()
     where day = p_day and status in ('pending','confirmed');
    get diagnostics n = row_count;
    perform _vendor_sync_day(p_day);
  end if;
  return n;
end $$;

-- Open every given weekday (6 = Saturday) in a range that has no row yet.
create or replace function public.staff_vendor_dates_open(p_from date, p_to date, p_weekday integer default 6)
returns integer language plpgsql security definer set search_path to 'public'
as $$
declare n int;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_RANGE' using errcode = '22023'; end if;
  insert into vendor_dates (day) select g::date from generate_series(p_from, p_to, interval '1 day') g
   where extract(dow from g)::int = p_weekday on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.staff_vendor_tier_save(p jsonb)
returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  insert into vendor_tiers (id, name_en) values (p ->> 'id', coalesce(p ->> 'name_en', p ->> 'id')) on conflict (id) do nothing;
  update vendor_tiers set
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

-- 4. The triggers again.
create trigger vendor_bookings_audit after insert or update on public.vendor_bookings
  for each row execute function public._vendor_audit_row();
create trigger sessions_vendor_breakfast before insert on public.sessions
  for each row execute function public._vendor_session_fill();

-- 5. Who may run them, as before: helpers nobody, the portal's functions anon, the staff ones signed-in staff.
revoke all on function public._vendor_today() from public, anon, authenticated;
revoke all on function public._vendor_login_key(text) from public, anon, authenticated;
revoke all on function public._vendor_user(bigint, text) from public, anon, authenticated;
revoke all on function public._vendor_audit_row() from public, anon, authenticated;
revoke all on function public._vendor_sync_day(date) from public, anon, authenticated;
revoke all on function public._vendor_session_fill() from public, anon, authenticated;
revoke all on function public._vendor_pattern_days(integer, integer, date, date) from public, anon, authenticated;
revoke all on function public._vendor_check(bigint, text, date[], integer, integer, date, date) from public, anon, authenticated;
revoke all on function public.vendor_login(text, text) from public;
revoke all on function public.vendor_set_password(bigint, text, text, text) from public;
revoke all on function public.vendor_me(bigint, text) from public;
revoke all on function public.vendor_calendar(bigint, text, date, date) from public;
revoke all on function public.vendor_preview(bigint, text, text, date[], integer, integer, date, date) from public;
revoke all on function public.vendor_request(bigint, text, text, date[], integer, integer, date, date, text) from public;
revoke all on function public.vendor_cancel(bigint, text, bigint, text, boolean) from public;
revoke all on function public.vendor_profile_save(bigint, text, jsonb) from public;
grant execute on function public.vendor_login(text, text) to anon, authenticated;
grant execute on function public.vendor_set_password(bigint, text, text, text) to anon, authenticated;
grant execute on function public.vendor_me(bigint, text) to anon, authenticated;
grant execute on function public.vendor_calendar(bigint, text, date, date) to anon, authenticated;
grant execute on function public.vendor_preview(bigint, text, text, date[], integer, integer, date, date) to anon, authenticated;
grant execute on function public.vendor_request(bigint, text, text, date[], integer, integer, date, date, text) to anon, authenticated;
grant execute on function public.vendor_cancel(bigint, text, bigint, text, boolean) to anon, authenticated;
grant execute on function public.vendor_profile_save(bigint, text, jsonb) to anon, authenticated;
revoke all on function public.staff_vendor_venue_save(jsonb) from public, anon;
revoke all on function public.staff_vendor_user_add(bigint, text, text, text) from public, anon;
revoke all on function public.staff_vendor_user_reset(bigint) from public, anon;
revoke all on function public.staff_vendor_user_active(bigint, boolean) from public, anon;
revoke all on function public.staff_vendor_decide(bigint, text, text, text) from public, anon;
revoke all on function public.staff_vendor_date_set(date, text, text, integer, text) from public, anon;
revoke all on function public.staff_vendor_dates_open(date, date, integer) from public, anon;
revoke all on function public.staff_vendor_tier_save(jsonb) from public, anon;
grant execute on function public.staff_vendor_venue_save(jsonb) to authenticated;
grant execute on function public.staff_vendor_user_add(bigint, text, text, text) to authenticated;
grant execute on function public.staff_vendor_user_reset(bigint) to authenticated;
grant execute on function public.staff_vendor_user_active(bigint, boolean) to authenticated;
grant execute on function public.staff_vendor_decide(bigint, text, text, text) to authenticated;
grant execute on function public.staff_vendor_date_set(date, text, text, integer, text) to authenticated;
grant execute on function public.staff_vendor_dates_open(date, date, integer) to authenticated;
grant execute on function public.staff_vendor_tier_save(jsonb) to authenticated;
revoke all on function public.vendor_feedback_save(bigint, text, bigint, integer, integer, text, text) from public;
grant execute on function public.vendor_feedback_save(bigint, text, bigint, integer, integer, text, text) to anon, authenticated;
