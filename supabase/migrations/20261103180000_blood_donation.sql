-- ============================================================================
-- The Blood Donation event (the owner, 2026-10-13, moved 2026-11-03 to Thursday 5 November 2026, 17:00-23:00):
-- run by MoD Health Services and the Ministry of Sport at the Jeddah Corniche Circuit, open to everyone, free,
-- no bikes. ride_kind 'blood' (event_kind 'community', open_to_all true), session id suffix -bd.
--
--  1. queue_entries.donated_at: when staff confirmed this person donated. RLS keeps booking rows to staff; the
--     rider hears through customer_blood_rewards.
--  2. promo_codes.blood_entry_id: the booking a free-ride code was earned on (null = any other code).
--  3. _blood_entry_guard (BEFORE INSERT OR UPDATE OF status, session_id): a customer's live row needs 18 or over on
--     the event's date (BLOOD_AGE), name, mobile, email, blood type, birth date and nationality on the account
--     (BLOOD_DETAILS), the agreement to share them (BLOOD_SHARE), and no other live row of theirs (ONE_PER_SESSION).
--  4. customer_create_booking stamps data_share_at and customer_accept_share accepts it for 'blood' too;
--     staff_record_waiver knows its own agreement, 'blood-<year>-<month>-v<n>' (the app's BLD_WAIVER_VERSION). A booking and
--     customer_accept_waiver take that version as they are: _waiver_outdated never refuses a kind it does not know, so
--     a later rewording that must refuse the old one adds 'blood' to _waiver_outdated and _waiver_min.
--  5. staff_blood_donated(p_entry_id, p_on): staff confirm a checked-in donor; that makes one personal code,
--     100% off, one use, valid one calendar month. Taking it back retires the code, unless it was already used.
--  6. customer_blood_rewards(p_id, p_token): the rider's own codes.
--  7. _blood_code_guard: a reward code never pays for Carbon (BLOOD_CODE_CARBON), and is good only on circuit rides,
--     or Petromin nights for an account tagged Community or Petromin (BLOOD_CODE_SESSION). It runs before
--     trg_enforce_booking_price (triggers fire by name). Staff pass, as they do every price rule.
--
-- No ID or Iqama number is stored (the owner, 2026-10-23): donors show theirs to the hospital in person.
-- Safe before or after the app: every rule here asks for ride_kind 'blood', and no such session exists until
-- supabase/checks/blood-donation-session-2026-11-05.sql is run, which is the moment the event becomes visible.
--
-- Rollback:
--   drop trigger if exists queue_entries_blood_guard on public.queue_entries;
--   drop trigger if exists queue_entries_blood_code on public.queue_entries;
--   drop function if exists public._blood_entry_guard(), public._blood_code_guard(),
--     public.staff_blood_donated(text, boolean), public.customer_blood_rewards(text, text);
--   update public.promo_codes set active = false where blood_entry_id is not null;
--   alter table public.promo_codes drop column if exists blood_entry_id;
--   alter table public.queue_entries drop column if exists donated_at;
--   then run the three patches below backwards.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if position(b in def) > 0 then return def; end if;
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


/* -- 1, 2. the columns ------------------------------------------------------------------------ */
alter table public.queue_entries add column if not exists donated_at text;
comment on column public.queue_entries.donated_at is
  'Blood Donation event: when staff confirmed this person donated, ISO UTC; null = not confirmed (20261103180000).';
alter table public.promo_codes add column if not exists blood_entry_id text;
comment on column public.promo_codes.blood_entry_id is
  'The Blood Donation booking this free-ride code was earned on; null = any other code (20261103180000).';
create unique index if not exists promo_codes_blood_entry_uq on public.promo_codes (blood_entry_id)
  where blood_entry_id is not null;


/* -- 3. a donor's row -------------------------------------------------------------------------- */
create or replace function public._blood_entry_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  s record;
  c record;
  _live int;
  _dob date;
begin
  select x.ride_kind, x.session_date into s from sessions x where x.id = new.session_id;
  if not found or coalesce(s.ride_kind, '') <> 'blood' then return new; end if;
  if new.customer_id is null or (select is_staff()) then return new; end if;
  if coalesce(new.status, '') in ('cancelled', 'removed', 'noshow', 'done') then return new; end if;
  if tg_op = 'UPDATE' and old.session_id is not distinct from new.session_id
     and coalesce(old.status, '') not in ('cancelled', 'removed', 'noshow') then
    return new;
  end if;

  select x.name, x.email, x.phone, x.blood_type, x.birth_date, x.nationality
    into c from customers x where x.id = new.customer_id;
  if not found
     or coalesce(array_length(array_remove(regexp_split_to_array(btrim(coalesce(c.name, '')), '\s+'), ''), 1), 0) < 2
     or nullif(btrim(coalesce(c.email, '')), '') is null
     or nullif(btrim(coalesce(c.phone, '')), '') is null
     or nullif(btrim(coalesce(c.blood_type, '')), '') is null
     or nullif(btrim(coalesce(c.nationality, '')), '') is null
     or coalesce(c.birth_date, '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Donor details are missing.' using errcode = 'P0001', detail = 'BLOOD_DETAILS';
  end if;
  _dob := c.birth_date::date;
  if _dob + interval '18 years' > s.session_date::date then
    raise exception 'Donors must be 18 or over.' using errcode = 'P0001', detail = 'BLOOD_AGE';
  end if;
  if nullif(btrim(coalesce(new.data_share_at, '')), '') is null then
    raise exception 'The agreement to share details is missing.' using errcode = 'P0001', detail = 'BLOOD_SHARE';
  end if;

  perform pg_advisory_xact_lock(hashtext('ridecap:' || coalesce(new.session_id, '') || ':' || new.customer_id));
  select count(*) into _live
    from queue_entries q
   where q.session_id = new.session_id
     and q.customer_id = new.customer_id
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
     and q.id <> new.id;
  if _live >= 1 then
    raise exception 'One place per person on this session.' using detail = 'ONE_PER_SESSION';
  end if;
  return new;
end $function$;
revoke execute on function public._blood_entry_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_blood_guard on public.queue_entries;
create trigger queue_entries_blood_guard
  before insert or update of status, session_id on public.queue_entries
  for each row execute function public._blood_entry_guard();


/* -- 4. the agreement and the waiver know the kind (each patched in place) ---------------------- */
do $do$
declare v text;
begin
  select pg_get_functiondef(p.oid) into v from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'customer_create_booking';
  execute pg_temp._once(v, $a$in ('runher', 'vlap', 'arena')$a$, $b$in ('runher', 'vlap', 'arena', 'blood')$b$);

  select pg_get_functiondef('public.customer_accept_share'::regproc) into v;
  execute pg_temp._once(v, $a$in ('runher', 'vlap', 'arena')$a$, $b$in ('runher', 'vlap', 'arena', 'blood')$b$);

  select pg_get_functiondef('public.staff_record_waiver'::regproc) into v;
  v := pg_temp._once(v, $a$'^((swim|activity)-)?[0-9]{4}-[0-9]{2}-v[0-9]{1,6}$'$a$, $b$'^((swim|activity|blood)-)?[0-9]{4}-[0-9]{2}-v[0-9]{1,6}$'$b$);
  v := pg_temp._once(v, $a$'^(swim|activity)-'$a$, $b$'^(swim|activity|blood)-'$b$);
  v := pg_temp._once(v, $a$when r.ride_kind = 'swim' then 'swim'$a$, $b$when r.ride_kind = 'swim' then 'swim' when r.ride_kind = 'blood' then 'blood'$b$);
  execute v;
end $do$;


/* -- 5. staff confirm a donor ------------------------------------------------------------------ */
create or replace function public.staff_blood_donated(p_entry_id text, p_on boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  q record;
  c promo_codes%rowtype;
  _code text;
  _exp date;
begin
  if not (select is_staff()) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select x.id, x.customer_id, x.status, x.donated_at, s.ride_kind into q
    from queue_entries x join sessions s on s.id = x.session_id
   where x.id = p_entry_id for update of x;
  if not found or coalesce(q.ride_kind, '') <> 'blood' then
    raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001';
  end if;
  select * into c from promo_codes where blood_entry_id = q.id for update;

  if not coalesce(p_on, false) then
    if c.id is not null and coalesce(c.uses, 0) > 0 then
      raise exception 'BLOOD_CODE_USED' using errcode = 'P0001';
    end if;
    update promo_codes set active = false where blood_entry_id = q.id;
    update queue_entries set donated_at = null where id = q.id;
    return jsonb_build_object('ok', true, 'donated', false);
  end if;

  -- Only someone who was checked in, on an account the code can belong to.
  if coalesce(q.status, '') not in ('active', 'done') then
    raise exception 'BLOOD_NOT_CHECKED_IN' using errcode = 'P0001';
  end if;
  if q.customer_id is null then
    raise exception 'BLOOD_NO_ACCOUNT' using errcode = 'P0001';
  end if;

  _exp := ((now() at time zone 'Asia/Riyadh')::date + interval '1 month')::date;
  if c.id is not null then
    -- Confirmed again after being taken back: the same code, the month counted from now.
    update promo_codes set active = true, expires_at = _exp where id = c.id returning code into _code;
  else
    loop
      _code := 'BD-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8));
      exit when not exists (select 1 from promo_codes where lower(code) = lower(_code));
    end loop;
    insert into promo_codes (id, code, kind, value, active, created_at, applies_to, expires_at, max_uses, uses, customer_id, blood_entry_id)
    values ('bd-' || q.id, _code, 'percent', 100, true,
            to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), null, _exp, 1, 0, q.customer_id, q.id);
  end if;
  update queue_entries
     set donated_at = coalesce(donated_at, to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
   where id = q.id;
  return jsonb_build_object('ok', true, 'donated', true, 'code', _code, 'expires_at', _exp);
end $function$;
revoke all on function public.staff_blood_donated(text, boolean) from public, anon;
grant execute on function public.staff_blood_donated(text, boolean) to authenticated;


/* -- 6. the rider's codes ---------------------------------------------------------------------- */
create or replace function public.customer_blood_rewards(p_id text, p_token text)
 returns table(entry_id text, code text, expires_at date, used boolean)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not _cust_token_ok(p_id, p_token) then return; end if;
  return query
    select c.blood_entry_id, c.code, c.expires_at, coalesce(c.uses, 0) > 0
      from promo_codes c
     where c.customer_id = p_id and c.blood_entry_id is not null and c.active = true;
end $function$;
revoke all on function public.customer_blood_rewards(text, text) from public;
grant execute on function public.customer_blood_rewards(text, text) to anon, authenticated;


/* -- 7. where a reward code is good ------------------------------------------------------------ */
create or replace function public._blood_code_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  s record;
begin
  if coalesce(new.promo_code, '') = '' or (select is_staff()) then return new; end if;
  if not exists (select 1 from promo_codes c
                  where lower(c.code) = lower(new.promo_code) and c.blood_entry_id is not null) then
    return new;
  end if;
  if coalesce(new.type_preference, '') ilike '%carbon%' then
    raise exception 'This free ride is not valid on a Carbon bike.' using errcode = 'P0001', detail = 'BLOOD_CODE_CARBON';
  end if;
  select x.event_kind, x.ride_kind into s from sessions x where x.id = new.session_id;
  if coalesce(s.event_kind, '') <> 'community' then return new; end if; -- a circuit ride
  if coalesce(s.ride_kind, '') = 'petromin'
     and (_petromin_holder(new.customer_id)
          or exists (select 1 from customer_tags ct join tags tg on tg.id = ct.tag_id
                      where ct.customer_id = new.customer_id and lower(tg.slug) = 'saturday'
                        and _ctag_active(ct.starts_at, ct.expires_at))) then
    return new;
  end if;
  raise exception 'This free ride is not valid on this session.' using errcode = 'P0001', detail = 'BLOOD_CODE_SESSION';
end $function$;
revoke execute on function public._blood_code_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_blood_code on public.queue_entries;
create trigger queue_entries_blood_code
  before insert or update of promo_code, type_preference, session_id on public.queue_entries
  for each row execute function public._blood_code_guard();

insert into supabase_migrations.schema_migrations (version, name)
values ('20261103180000', 'blood_donation')
on conflict (version) do nothing;

commit;
