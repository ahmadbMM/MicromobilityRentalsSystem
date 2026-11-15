-- ============================================================================
-- micromobility.sa/farmhouse: the Farmhouse Night booked with a code (the user, 2026-11-15: "create a webpage for
-- booking the farmhouse session themed with the same theme of the session, make sure to ask if they have an account
-- or not and make them go through the whole process, make it through a new url and only allow reservations through a
-- code ... as i am willing to close the session and only accept bookings through the webpage").
--
-- The user's answers, the same day: anyone with the code books (no Community tag needed; someone with no account makes
-- one on the page); a booking still waits for staff's approval; closing the session stops the booking app only, the
-- page keeps booking the closed night until its places are full; the code has no limit of its own (the night's
-- capacity is the limit); a ticket made before keeps Edit in the app to drop family, never to add (that is the app's).
--
-- 1. farm_codes: the codes and the farm night each opens (staff only). The code itself is never in this repository
--    (it is public on GitHub) nor in any page's code: the row is written by hand on each database.
-- 2. queue_entries.farm_code: the code a booking came with, written only by farm_book (fill trigger reading mm.farmcode,
--    which no client can set: PostgREST exposes no set_config); staff may write one; a rider's own write is dropped.
--    The booking app shows it as it shows a Saturday ride code (chip, Ride code column, CSV).
-- 3. _farm_code_on(session): is farm_book making a booking on that night in this transaction?
-- 4. customer_create_booking: a night farm_book is booking may be closed (open and full as before for everyone).
--    _community_booking_gate: such a booking needs no Community tag. Both patched in place from their LIVE text
--    (pg_get_functiondef, md5 checked), so SECURITY DEFINER and the search_path stay.
-- 5. farm_night(code [, id, token]): the upcoming farm nights a code opens: names, date, times, place, map, Instagram,
--    state open | full | over (never a count), the most people one account brings (4) and, signed in, the names the
--    account already holds there. A code that is unknown or off is answered 'code' and metered.
-- 6. farm_book(id, token, night, code, family, waiver): the account holder (unless the account already holds a place
--    there) and up to three family members by name, through customer_create_booking (token, check-ups, the farm
--    waiver, the name rules, approval pending, the four-per-account cap), under the night's lock after the code's,
--    the night's and the places' checks. The capacity is counted here: an approval ride has no capacity guard.
--    Every refusal is a row: { ok: false, error: throttled | signin | code | session | waiver | input | name | fix
--    (+ fields) | nothing | cap (+ held) | full | room }.
-- 7. Wrong codes are metered per address (_ip_gate 'farmcode': 30 in 10 minutes, then a wait), in both functions; a
--    right code never counts. A locked address is answered 'throttled'.
--
-- Rollback (emergency only): restore customer_create_booking and _community_booking_gate from their texts before this
-- file (remove the two lines marked 20261115210000); drop function farm_book, farm_night, _farm_code_on,
-- _farmcode_locked, _farm_code_fill (with trigger queue_entries_farm_code); alter table queue_entries drop column
-- farm_code; drop table farm_codes. Idempotent.
-- ============================================================================
begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(src text, a text, b text, n integer default 1) returns text
language plpgsql as $f$
declare c integer := (length(src) - length(replace(src, a, ''))) / greatest(length(a), 1);
begin
  if c <> n then raise exception 'farmhouse_page: expected % of [%], found %', n, left(a, 80), c; end if;
  return replace(src, a, b);
end $f$;

-- ── 1. The codes ─────────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.farm_codes (
  code       text primary key check (code ~ '^[A-Za-z0-9_-]{3,40}$'),
  session_id text not null references public.sessions(id) on update cascade on delete cascade,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists farm_codes_code_ci on public.farm_codes (lower(code));
comment on table public.farm_codes is 'Codes that book a Farm House Night at micromobility.sa/farmhouse (farm_book), each for one night; staff only (20261115210000).';
alter table public.farm_codes enable row level security;
drop policy if exists "staff read" on public.farm_codes;
drop policy if exists "staff write" on public.farm_codes;
create policy "staff read" on public.farm_codes for select using ((select is_staff()));
create policy "staff write" on public.farm_codes for all using ((select is_staff())) with check ((select is_staff()));
revoke all on public.farm_codes from anon, authenticated;
grant select, insert, update, delete on public.farm_codes to authenticated;

-- ── 2. The code on a booking ──────────────────────────────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists farm_code text;
alter table public.queue_entries drop constraint if exists queue_entries_farm_code_fmt;
alter table public.queue_entries add constraint queue_entries_farm_code_fmt
  check (farm_code is null or farm_code ~ '^[A-Za-z0-9_-]{1,40}$');
comment on column public.queue_entries.farm_code is 'The code a Farm House Night booking was made with at micromobility.sa/farmhouse (farm_book; 20261115210000).';

create or replace function public._farm_code_fill()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare sc text[];
begin
  if tg_op = 'INSERT' then
    sc := string_to_array(coalesce(current_setting('mm.farmcode', true), ''), '|');
    if cardinality(sc) = 2 and sc[1] = new.session_id then
      new.farm_code := sc[2];
    elsif not is_staff() then
      new.farm_code := null;
    end if;
  elsif not is_staff() then
    new.farm_code := old.farm_code;
  end if;
  return new;
end $function$;
revoke all on function public._farm_code_fill() from public, anon, authenticated;
drop trigger if exists queue_entries_farm_code on public.queue_entries;
create trigger queue_entries_farm_code before insert or update of farm_code on public.queue_entries
  for each row execute function public._farm_code_fill();

-- ── 3. Is farm_book booking this night? ───────────────────────────────────────────────────────────────────────────
create or replace function public._farm_code_on(p_sid text)
 returns boolean
 language sql
 stable
 set search_path to 'public'
as $function$
  select p_sid is not null and split_part(coalesce(current_setting('mm.farmcode', true), ''), '|', 1) = p_sid
$function$;
revoke all on function public._farm_code_on(text) from public, anon, authenticated;

-- Has this address sent too many wrong codes? (_ip_gate's meter 'farmcode', read without counting)
create or replace function public._farmcode_locked()
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select exists (select 1 from login_throttle l
                  where l.identifier = 'farmcode:' || _client_ip() and l.locked_until > now())
$function$;
revoke all on function public._farmcode_locked() from public, anon, authenticated;

-- ── 4. The two patches ────────────────────────────────────────────────────────────────────────────────────────────
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure);
  if position('_farm_code_on' in d) > 0 then
    raise notice 'customer_create_booking already books the Farmhouse page''s closed night';
  else
    if md5(d) <> 'ae3dc73ba9bf203d038796dad755bc38' then
      raise exception 'customer_create_booking changed since 20261115210000 was written (md5 %)', md5(d);
    end if;
    d := pg_temp._once(d,
$a$where sessions.id = _sid and coalesce(sessions.status,'') in ('open','full')$a$,
$b$where sessions.id = _sid and (coalesce(sessions.status,'') in ('open','full')
     or (sessions.status = 'closed' and _farm_code_on(sessions.id)))   -- the Farmhouse page's night, closed or not (20261115210000)$b$);
    execute d;
  end if;

  d := pg_get_functiondef('public._community_booking_gate()'::regprocedure);
  if position('_farm_code_on' in d) > 0 then
    raise notice '_community_booking_gate already lets the Farmhouse page''s code in';
  else
    if md5(d) <> 'ab233268d62bd0cef34501d6f5c9ce02' then
      raise exception '_community_booking_gate changed since 20261115210000 was written (md5 %)', md5(d);
    end if;
    d := pg_temp._once(d,
$a$     and not (coalesce(s.ride_kind, '') = 'vlap' and _vlap_holder(new.customer_id))$a$,
$b$     -- the booking farm_book is making with a code (micromobility.sa/farmhouse, 20261115210000)
     and not (coalesce(s.ride_kind, '') = 'farm' and tg_op = 'INSERT' and _farm_code_on(new.session_id))
     and not (coalesce(s.ride_kind, '') = 'vlap' and _vlap_holder(new.customer_id))$b$);
    execute d;
  end if;
end $mig$;

-- ── 5. The nights a code opens ────────────────────────────────────────────────────────────────────────────────────
create or replace function public.farm_night(p_code text, p_id text default null, p_token text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_code text := btrim(coalesce(p_code, ''));
  v_today text := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  v_mine boolean; v_canon text; v_out jsonb := '[]'::jsonb;
  v_s sessions%rowtype; v_slots jsonb; v_ends timestamptz; v_live int; v_state text; v_held jsonb;
begin
  if _farmcode_locked() then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if v_code = '' then return jsonb_build_object('ok', false, 'error', 'code'); end if;
  if v_code ~ '^[A-Za-z0-9_-]{1,40}$' then
    select c.code into v_canon from farm_codes c where lower(c.code) = lower(v_code) and c.active;
  end if;
  if v_canon is null then
    perform _ip_gate('farmcode', 30, interval '10 minutes');
    return jsonb_build_object('ok', false, 'error', 'code');
  end if;
  v_mine := p_id is not null and p_token is not null and _cust_token_ok(p_id, p_token);

  for v_s in
    select s.* from farm_codes c join sessions s on s.id = c.session_id
     where c.code = v_canon and c.active
       and coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'farm'
       and coalesce(s.status, '') in ('open', 'full', 'closed') and s.cancelled_at is null
       and coalesce(s.session_date, '') >= v_today
     order by s.session_date, s.id
  loop
    begin v_slots := coalesce(nullif(btrim(v_s.bike_slots), ''), '{}')::jsonb; exception when others then v_slots := '{}'::jsonb; end;
    if jsonb_typeof(v_slots) <> 'object' then v_slots := '{}'::jsonb; end if;
    begin select w.ends_at into v_ends from _session_window(v_s) w; exception when others then v_ends := null; end;
    if coalesce(v_slots->>'_fbk', '') not in ('', '0', 'false') or (v_ends is not null and v_ends <= now()) then
      v_state := 'over';
    else
      select count(*) into v_live from queue_entries q
       where q.session_id = v_s.id and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
      v_state := case when v_s.capacity is not null and v_live >= v_s.capacity then 'full' else 'open' end;
    end if;
    v_held := null;
    if v_mine then
      select coalesce(jsonb_agg(q.name order by q.queue_num), '[]'::jsonb) into v_held from queue_entries q
       where q.session_id = v_s.id and q.customer_id = p_id
         and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_s.id, 'date', v_s.session_date, 'day', v_s.day, 'title', v_s.title, 'title_ar', v_s.title_ar,
      'time', nullif(btrim(coalesce(v_slots->>'_time', '')), ''),
      'place', coalesce(nullif(btrim(coalesce(v_s.meet_name, '')), ''), nullif(btrim(coalesce(v_s.location, '')), '')),
      'place_ar', nullif(btrim(coalesce(v_s.meet_name_ar, '')), ''),
      'map', nullif(btrim(coalesce(v_s.meet_url, '')), ''),
      'ig', nullif(btrim(coalesce(v_slots->>'_ig', '')), ''),
      'state', v_state, 'max', 4, 'held', v_held));
  end loop;

  if jsonb_array_length(v_out) = 0 then return jsonb_build_object('ok', false, 'error', 'over'); end if;
  return jsonb_build_object('ok', true, 'code', v_canon, 'signed_in', v_mine, 'nights', v_out);
end $function$;
revoke all on function public.farm_night(text, text, text) from public;
grant execute on function public.farm_night(text, text, text) to anon, authenticated;

-- ── 6. The booking ────────────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.farm_book(p_id text, p_token text, p_session text, p_code text,
                                            p_family jsonb default '[]'::jsonb, p_waiver text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_today text := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  v_cust customers%rowtype; v_s sessions%rowtype; v_slots jsonb; v_ends timestamptz; v_code text;
  v_fam text[] := '{}'::text[]; v_x jsonb; v_nm text; v_asks text[];
  v_held int; v_live int; v_new int; v_entries jsonb := '[]'::jsonb; v_err text; v_det text; v_people jsonb;
begin
  if not _rider_gate() or _farmcode_locked() then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  select * into v_cust from customers where id = p_id;

  -- The code, good on this night.
  if btrim(coalesce(p_code, '')) ~ '^[A-Za-z0-9_-]{1,40}$' then
    select c.code into v_code from farm_codes c
     where lower(c.code) = lower(btrim(p_code)) and c.active and c.session_id = coalesce(p_session, '');
  end if;
  if v_code is null then
    perform _ip_gate('farmcode', 30, interval '10 minutes');
    return jsonb_build_object('ok', false, 'error', 'code');
  end if;

  -- The night: a farm night ahead, open, full or closed, never called off or marked Full, no waitlist.
  select * into v_s from sessions s
   where s.id = p_session and coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'farm'
     and coalesce(s.status, '') in ('open', 'full', 'closed') and s.cancelled_at is null
     and coalesce(s.session_date, '') >= v_today;
  if v_s.id is null then return jsonb_build_object('ok', false, 'error', 'session'); end if;
  begin v_slots := coalesce(nullif(btrim(v_s.bike_slots), ''), '{}')::jsonb; exception when others then v_slots := '{}'::jsonb; end;
  if jsonb_typeof(v_slots) <> 'object' then v_slots := '{}'::jsonb; end if;
  if coalesce(v_slots->>'_fbk', '') not in ('', '0', 'false') then return jsonb_build_object('ok', false, 'error', 'session'); end if;
  begin select w.ends_at into v_ends from _session_window(v_s) w; exception when others then v_ends := null; end;
  if v_ends is not null and v_ends <= now() then return jsonb_build_object('ok', false, 'error', 'session'); end if;

  -- The farm night's own waiver, as it stands.
  if coalesce(p_waiver, '') !~ '^farm-[A-Za-z0-9._-]{1,35}$' or _waiver_outdated(p_waiver) then
    return jsonb_build_object('ok', false, 'error', 'waiver');
  end if;

  -- Up to three family members, each by a name the booking takes (letters and spaces, every part two letters or more).
  if p_family is null then p_family := '[]'::jsonb; end if;
  if jsonb_typeof(p_family) <> 'array' or jsonb_array_length(p_family) > 3 then
    return jsonb_build_object('ok', false, 'error', 'input');
  end if;
  for v_x in select * from jsonb_array_elements(p_family) loop
    if jsonb_typeof(v_x) <> 'string' then return jsonb_build_object('ok', false, 'error', 'input'); end if;
    v_nm := left(btrim(regexp_replace(v_x #>> '{}', '\s+', ' ', 'g')), 60);
    if v_nm = '' or not _name_chars_ok(v_nm) or not _name_parts_ok(v_nm) then
      return jsonb_build_object('ok', false, 'error', 'name', 'name', v_nm);
    end if;
    v_fam := v_fam || v_nm;
  end loop;

  -- What the account owes (an emergency contact, the nationality, a field staff flagged) is answered first.
  v_asks := coalesce(_customer_asks(p_id), '{}'::text[]);
  if cardinality(v_asks) > 0 then return jsonb_build_object('ok', false, 'error', 'fix', 'fields', to_jsonb(v_asks)); end if;

  -- The places, under the night's lock: four per account (the holder and three), the night's capacity in all.
  perform pg_advisory_xact_lock(hashtext('farmcap:' || v_s.id));
  select count(*) into v_held from queue_entries q
   where q.session_id = v_s.id and q.customer_id = p_id and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
  v_new := (case when v_held = 0 then 1 else 0 end) + cardinality(v_fam);
  if v_new = 0 then return jsonb_build_object('ok', false, 'error', 'nothing', 'held', v_held); end if;
  if v_held + v_new > 4 then return jsonb_build_object('ok', false, 'error', 'cap', 'held', v_held); end if;
  if v_s.capacity is not null then
    select count(*) into v_live from queue_entries q
     where q.session_id = v_s.id and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
    if v_live >= v_s.capacity then return jsonb_build_object('ok', false, 'error', 'full'); end if;
    if v_live + v_new > v_s.capacity then return jsonb_build_object('ok', false, 'error', 'room'); end if;
  end if;

  -- The rows: the account holder first when they hold no place there yet, then each family member, as the app books
  -- the night (no bike: type None; the farm waiver on every row).
  if v_held = 0 then
    v_entries := v_entries || jsonb_build_array(jsonb_build_object('session_id', v_s.id, 'name', coalesce(v_cust.name, ''),
                   'type_preference', 'None', 'waiver_version', p_waiver));
  end if;
  foreach v_nm in array v_fam loop
    v_entries := v_entries || jsonb_build_array(jsonb_build_object('session_id', v_s.id, 'name', v_nm,
                   'type_preference', 'None', 'waiver_version', p_waiver));
  end loop;

  begin
    perform set_config('mm.farmcode', v_s.id || '|' || v_code, true);
    perform 1 from customer_create_booking(p_id, p_token, v_entries);
    perform set_config('mm.farmcode', '', true);
  exception when others then
    get stacked diagnostics v_err = message_text, v_det = pg_exception_detail;
    perform set_config('mm.farmcode', '', true);
    if v_det = 'GROUP_CAP' then return jsonb_build_object('ok', false, 'error', 'cap', 'held', v_held); end if;
    if v_err = 'FIX_FIRST' then
      return jsonb_build_object('ok', false, 'error', 'fix', 'fields', to_jsonb(coalesce(_customer_asks(p_id), '{}'::text[])));
    end if;
    if v_err in ('STALE_SESSION', 'ACCOUNT_ARCHIVED') then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
    if v_err = 'SESSION_CLOSED' or v_err like 'NOT_OPEN_YET%' then return jsonb_build_object('ok', false, 'error', 'session'); end if;
    if v_err in ('WAIVER_REQUIRED', 'WAIVER_OUTDATED') then return jsonb_build_object('ok', false, 'error', 'waiver'); end if;
    if v_err = 'BAD_INPUT' and v_det = 'name' then return jsonb_build_object('ok', false, 'error', 'name'); end if;
    if v_err = 'RATE_LIMITED' then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
    raise;
  end;

  select coalesce(jsonb_agg(q.name order by q.queue_num), '[]'::jsonb) into v_people from queue_entries q
   where q.session_id = v_s.id and q.customer_id = p_id and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
  return jsonb_build_object('ok', true, 'added', v_new, 'people', v_people,
    'session', jsonb_build_object('id', v_s.id, 'date', v_s.session_date, 'title', v_s.title, 'title_ar', v_s.title_ar,
      'time', nullif(btrim(coalesce(v_slots->>'_time', '')), ''),
      'place', coalesce(nullif(btrim(coalesce(v_s.meet_name, '')), ''), nullif(btrim(coalesce(v_s.location, '')), '')),
      'place_ar', nullif(btrim(coalesce(v_s.meet_name_ar, '')), '')));
end $function$;
revoke all on function public.farm_book(text, text, text, text, jsonb, text) from public;
grant execute on function public.farm_book(text, text, text, text, jsonb, text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261115210000', 'farmhouse_page')
on conflict (version) do nothing;

commit;

-- Check (read only): the table with RLS on and no rider grant, the column and its trigger, both patches, the
-- functions' attributes and grants, the ledger row.
select (select relrowsecurity from pg_class where oid = 'public.farm_codes'::regclass) as codes_rls,
       has_table_privilege('anon', 'public.farm_codes', 'select') as codes_anon,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'queue_entries' and column_name = 'farm_code') as col,
       (select count(*) from pg_trigger where tgname = 'queue_entries_farm_code') as trig,
       position('_farm_code_on' in pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure)) > 0 as ccb_patched,
       position('_farm_code_on' in pg_get_functiondef('public._community_booking_gate()'::regprocedure)) > 0 as gate_patched,
       (select json_agg(json_build_object('fn', p.proname, 'definer', p.prosecdef, 'settings', p.proconfig,
                                          'anon', has_function_privilege('anon', p.oid, 'execute')) order by p.proname)
          from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('customer_create_booking', '_community_booking_gate', '_farm_code_fill', '_farm_code_on',
                             '_farmcode_locked', 'farm_night', 'farm_book')) as fns,
       (select name from supabase_migrations.schema_migrations where version = '20261115210000') as ledger;
