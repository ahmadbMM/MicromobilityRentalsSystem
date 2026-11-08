-- ============================================================================
-- Saturday ride codes and micromobility.sa/saturday (the owner, 2026-11-08: "add a new feature to
-- create codes and names for these codes to add to saturday social rides so people can only register
-- for saturday social rides through a new link called micromobility.sa/saturday").
--
-- The owner's answers, the same day: a valid code is needed and is enough (no Community tag needed,
-- members bring a code too); a code booking still waits for staff's selection and Publish; a code may
-- have its own number of places, counted on each ride; one list of codes for every Saturday ride, and
-- each ride can change it.
--
-- 1. saturday_codes: the list (staff only). code: as staff typed it, matched without regard to case
--    (two codes cannot differ only by case); name: what staff call it, shown beside its bookings;
--    places: how many bookings the code may make on ONE ride (null = no limit); active: on for every
--    ride unless the ride says otherwise.
-- 2. saturday_code_rides: one ride's own setting for a code (staff only). active null = as the list;
--    own_places true = places is this ride's limit (null = no limit), false = the list's places.
--    A code only one ride takes is a code off in the list and on for that ride.
-- 3. saturday_settings: one row. link_only = a rider's own booking on a Saturday ride comes only
--    through micromobility.sa/saturday. Off until staff switch it on (once the codes are made and
--    shared); until then the booking app books Saturday rides as before.
-- 4. queue_entries.ride_code: the code a booking came with. A rider's booking carries one only when
--    saturday_book makes it (the fill trigger reads mm.satcode); staff may write one. A code that has
--    bookings cannot be deleted (restrict): staff switch it off instead.
-- 5. _community_booking_gate: a booking saturday_book is making (mm.satcode = '<ride>|<code>', set for
--    one transaction, which no client can set: PostgREST exposes no set_config) needs no Community tag;
--    with link_only on, a rider's own booking on a Saturday ride must be one (SATURDAY_LINK). Staff
--    adds and partner bookings (partner_book) are untouched. Rewritten whole from its live definition
--    (20261018140000, md5 of the body checked below), SECURITY DEFINER and search_path kept.
-- 6. saturday_rides(p_code): the upcoming Saturday rides the page may show (open or full, or closed
--    with a set opening time still to come; not ended; no private ride) and, given a code, whether it
--    is good on each ride (code_ok) and still has a place there (code_open). Never a count.
-- 7. saturday_book(id, token, ride, code, entry): one booking for the signed-in account through
--    customer_create_booking (token, check-ups, waiver, bike type, one place per person, approval
--    pending, the waitlist when the ride is full), after the code's checks under a lock. A code that
--    is unknown or off on that ride, or whose places there are taken, is answered as a row
--    (refused = 'BAD_CODE' | 'CODE_USED_UP'), not an error, so the meter below survives the call.
--    Every other refusal is an error, as customer_create_booking raises it (STALE_SESSION, FIX_FIRST,
--    SESSION_CLOSED, ONE_PER_SESSION, WAIVER_REQUIRED, ...).
-- 8. Wrong codes are metered per address (_ip_gate 'satcode': 30 in 10 minutes, then a wait), in
--    saturday_rides and saturday_book alike; a right code never counts. A locked address is answered
--    RATE_LIMITED.
-- 9. saturday_link_only(): the switch, for the booking app (a bare boolean).
-- 10. staff_move_session carries a ride's own code settings to its new id (patched in place).
--
-- Rollback (emergency only): the gate as 20261018140000 has it; drop trigger queue_entries_ride_code;
-- drop function saturday_rides, saturday_book, saturday_link_only, _satcode_on, _satcode_live,
-- _satcode_locked, _ride_code_fill; alter table queue_entries drop column ride_code; drop table
-- saturday_code_rides, saturday_codes, saturday_settings; remove the staff_move_session line marked
-- 20261108120000. Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- The gate must still be the one this file was written against (or this file's own).
do $pre$
declare m text;
begin
  select md5(p.prosrc) into m from pg_proc p where p.oid = 'public._community_booking_gate()'::regprocedure;
  if m <> '126946841a1989bf340a6610fae5da7c'
     and position('mm.satcode' in pg_get_functiondef('public._community_booking_gate()'::regprocedure)) = 0 then
    raise exception '_community_booking_gate changed since 2026-11-08 (md5 %): rebuild this file from the live definition', m;
  end if;
end $pre$;

-- 1 ─────────────────────────────────────────────────────────────────────────
create table if not exists public.saturday_codes (
  code       text primary key check (code ~ '^[A-Za-z0-9_-]{3,40}$'),
  name       text not null default '' check (length(name) <= 60),
  places     integer check (places is null or places between 0 and 1000),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists saturday_codes_ci on public.saturday_codes (lower(code));
alter table public.saturday_codes enable row level security;
drop policy if exists "staff read" on public.saturday_codes;
drop policy if exists "staff write" on public.saturday_codes;
create policy "staff read" on public.saturday_codes for select using ((select is_staff()));
create policy "staff write" on public.saturday_codes for all using ((select is_staff())) with check ((select is_staff()));
revoke all on public.saturday_codes from anon, authenticated;
grant select, insert, update, delete on public.saturday_codes to authenticated;
comment on table public.saturday_codes is
  'Saturday ride codes (20261108120000): the list every Saturday ride takes; saturday_code_rides changes it for one ride.';

-- 2 ─────────────────────────────────────────────────────────────────────────
create table if not exists public.saturday_code_rides (
  session_id text not null references public.sessions(id) on update cascade on delete cascade,
  code       text not null references public.saturday_codes(code) on update cascade on delete cascade,
  active     boolean,
  own_places boolean not null default false,
  places     integer check (places is null or places between 0 and 1000),
  primary key (session_id, code)
);
alter table public.saturday_code_rides enable row level security;
drop policy if exists "staff read" on public.saturday_code_rides;
drop policy if exists "staff write" on public.saturday_code_rides;
create policy "staff read" on public.saturday_code_rides for select using ((select is_staff()));
create policy "staff write" on public.saturday_code_rides for all using ((select is_staff())) with check ((select is_staff()));
revoke all on public.saturday_code_rides from anon, authenticated;
grant select, insert, update, delete on public.saturday_code_rides to authenticated;
comment on table public.saturday_code_rides is
  'One Saturday ride''s own setting for a code (20261108120000): active null = as the list; own_places = places is this ride''s limit.';

-- 3 ─────────────────────────────────────────────────────────────────────────
create table if not exists public.saturday_settings (
  id         boolean primary key default true check (id),
  link_only  boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.saturday_settings (id) values (true) on conflict (id) do nothing;
alter table public.saturday_settings enable row level security;
drop policy if exists "staff read" on public.saturday_settings;
drop policy if exists "staff write" on public.saturday_settings;
create policy "staff read" on public.saturday_settings for select using ((select is_staff()));
create policy "staff write" on public.saturday_settings for update using ((select is_staff())) with check ((select is_staff()));
revoke all on public.saturday_settings from anon, authenticated;
grant select, update on public.saturday_settings to authenticated;
comment on column public.saturday_settings.link_only is
  'Saturday rides take a rider''s own booking only through micromobility.sa/saturday (saturday_book), 20261108120000.';

-- 4 ─────────────────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists ride_code text
  references public.saturday_codes(code) on update cascade on delete restrict;
comment on column public.queue_entries.ride_code is
  'The Saturday ride code this booking came with (saturday_codes.code, 20261108120000); null otherwise.';
create index if not exists queue_entries_ride_code_idx
  on public.queue_entries (session_id, ride_code) where ride_code is not null;

-- Only the booking saturday_book is making carries its code from a rider; staff may write one.
create or replace function public._ride_code_fill()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare sc text[];
begin
  sc := string_to_array(coalesce(current_setting('mm.satcode', true), ''), '|');
  if cardinality(sc) = 2 and sc[1] = new.session_id then
    new.ride_code := sc[2];
  elsif not is_staff() then
    new.ride_code := null;
  end if;
  return new;
end $function$;
revoke all on function public._ride_code_fill() from public, anon, authenticated;
drop trigger if exists queue_entries_ride_code on public.queue_entries;
create trigger queue_entries_ride_code before insert on public.queue_entries
  for each row execute function public._ride_code_fill();

-- 9 (the gate reads it) ─────────────────────────────────────────────────────
create or replace function public.saturday_link_only()
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select coalesce((select st.link_only from saturday_settings st where st.id), false)
$function$;
revoke all on function public.saturday_link_only() from public;
grant execute on function public.saturday_link_only() to anon, authenticated;

-- 5 ─────────────────────────────────────────────────────────────────────────
create or replace function public._community_booking_gate()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare s sessions%rowtype; pb text[]; sc text[]; _live int; _wl int; _code boolean := false;
begin
  select * into s from sessions where id = new.session_id;
  pb := string_to_array(coalesce(current_setting('mm.partner', true), ''), '|');
  if tg_op = 'INSERT' and cardinality(pb) = 3 and pb[1] = new.session_id then
    new.partner := pb[2];
    new.partner_code := (pb[3] = '1');
    new.approval := 'approved';
    if new.status = 'waitlist' then new.status := 'waiting'; end if;
    return new;
  end if;
  -- A Saturday Social Ride (20261108120000): the booking saturday_book is making came with a code, and the
  -- code lets the rider in, member or not. While staff have switched micromobility.sa/saturday on, that is
  -- the only way a rider's own booking comes onto a Saturday ride.
  if s.id is not null and s.event_kind = 'community' and coalesce(nullif(s.ride_kind, ''), 'saturday') = 'saturday' then
    sc := string_to_array(coalesce(current_setting('mm.satcode', true), ''), '|');
    _code := tg_op = 'INSERT' and cardinality(sc) = 2 and sc[1] = new.session_id;
    if not _code and not is_staff() and saturday_link_only() then
      raise exception 'Saturday Social Ride places are booked at micromobility.sa/saturday.'
        using detail = 'SATURDAY_LINK';
    end if;
  end if;
  if s.id is not null
     and s.event_kind = 'community'
     and coalesce(s.open_to_all, false) = false
     and not is_staff()
     and not _code
     and (new.customer_id is null or not exists (
            select 1
              from customer_tags ct
              join tags tg on tg.id = ct.tag_id
             where ct.customer_id = new.customer_id
               and lower(tg.slug) = 'saturday'
               and _ctag_active(ct.starts_at, ct.expires_at)))
     and not (coalesce(s.ride_kind, '') = 'petromin' and _petromin_holder(new.customer_id))
     and not (coalesce(s.ride_kind, '') = 'vlap' and _vlap_holder(new.customer_id))
  then
    raise exception 'This ride is for community members only.' using detail = 'MEMBERS_ONLY';
  end if;
  -- The members limit (20261017120000) and its waitlist (20261018140000). Own bikes are never limited.
  if s.id is not null and s.member_cap is not null and new.partner is null
     and coalesce(new.type_preference, '') <> 'Own'
     and coalesce(new.status, '') not in ('cancelled', 'removed', 'noshow') then
    perform pg_advisory_xact_lock(hashtext('membercap:' || s.id));
    if coalesce(new.status, '') <> 'waitlist' then
      select count(*) into _live from queue_entries q
       where q.session_id = s.id and q.partner is null and q.id <> new.id
         and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow', 'waitlist');
      if _live < s.member_cap then
        return new;
      end if;
    end if;
    -- Past the limit (or a booking sent as waitlist): the members' waitlist while it has room.
    if tg_op = 'INSERT' and s.member_wl is not null then
      select count(*) into _wl from queue_entries q
       where q.session_id = s.id and q.partner is null and q.id <> new.id and q.status = 'waitlist';
      if _wl < s.member_wl then
        new.status := 'waitlist';
        return new;
      end if;
      raise exception 'Our bikes are taken for this ride. You can still join with your own bike.'
        using detail = 'MEMBER_BIKES_FULL';
    end if;
    if coalesce(new.status, '') <> 'waitlist' then
      raise exception 'Our bikes are taken for this ride. You can still join with your own bike.'
        using detail = 'MEMBER_BIKES_FULL';
    end if;
  end if;
  return new;
end $function$;

-- 6, 7, 8 ───────────────────────────────────────────────────────────────────
-- A code's setting on one ride: whether it is on there, and its places there (null = no limit).
create or replace function public._satcode_on(p_session text, p_code text)
 returns table(code text, on_ride boolean, places integer)
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select c.code,
         coalesce(r.active, c.active),
         case when coalesce(r.own_places, false) then r.places else c.places end
    from saturday_codes c
    left join saturday_code_rides r on r.code = c.code and r.session_id = p_session
   where lower(c.code) = lower(btrim(coalesce(p_code, '')))
$function$;
revoke all on function public._satcode_on(text, text) from public, anon, authenticated;

-- How many live bookings a code holds on one ride (a cancelled, removed or no-show one gives its place back).
create or replace function public._satcode_live(p_session text, p_code text)
 returns integer
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select count(*)::int from queue_entries q
   where q.session_id = p_session and q.ride_code = p_code
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
$function$;
revoke all on function public._satcode_live(text, text) from public, anon, authenticated;

-- Has this address sent too many wrong codes? (_ip_gate's meter 'satcode', read without counting)
create or replace function public._satcode_locked()
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select exists (select 1 from login_throttle l
                  where l.identifier = 'satcode:' || _client_ip() and l.locked_until > now())
$function$;
revoke all on function public._satcode_locked() from public, anon, authenticated;

create or replace function public.saturday_rides(p_code text default null)
 returns table(session_id text, session_date text, day text, bike_slots text, meet_url text, title text,
               status text, opens_at timestamptz, code_ok boolean, code_open boolean)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare s sessions%rowtype; _code text := nullif(btrim(coalesce(p_code, '')), '');
        _c text; _on boolean; _pl integer; _ended boolean; _any boolean := false;
begin
  if _code is not null then
    if _satcode_locked() then
      raise exception 'RATE_LIMITED' using errcode = 'P0001';
    end if;
    if _code !~ '^[A-Za-z0-9_-]{3,40}$' then _code := '-'; end if;   -- matches nothing, and is counted
  end if;
  for s in
    select x.* from sessions x
     where x.event_kind = 'community' and coalesce(nullif(x.ride_kind, ''), 'saturday') = 'saturday'
       and x.required_tag_id is null and x.cancelled_at is null
       and coalesce(x.session_date, '') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
       and (coalesce(x.status, '') in ('open', 'full')
            or (coalesce(x.status, '') = 'closed' and x.opens_at is not null and x.opens_at > now()))
     order by x.session_date, x.id
  loop
    begin _ended := (select w.ends_at from _session_window(s) w) <= now();
    exception when others then _ended := false; end;
    continue when coalesce(_ended, false);
    session_id := s.id; session_date := s.session_date; day := s.day; bike_slots := s.bike_slots::text;
    meet_url := s.meet_url; title := s.title; status := s.status; opens_at := s.opens_at;
    code_ok := null; code_open := null;
    if _code is not null then
      select o.code, o.on_ride, o.places into _c, _on, _pl from _satcode_on(s.id, _code) o;
      code_ok := _c is not null and coalesce(_on, false);
      code_open := code_ok and (_pl is null or _satcode_live(s.id, _c) < _pl);
      _any := _any or code_ok;
    end if;
    return next;
  end loop;
  -- A code good on no ride counts against the address (a right one never does).
  if _code is not null and not _any then
    perform _ip_gate('satcode', 30, interval '10 minutes');
  end if;
end $function$;
revoke all on function public.saturday_rides(text) from public;
grant execute on function public.saturday_rides(text) to anon, authenticated;

create or replace function public.saturday_book(p_id text, p_token text, p_session text, p_code text, p_entry jsonb)
 returns table(id text, queue_num integer, status text, refused text)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare s sessions%rowtype; r record; _c text; _on boolean; _pl integer; _name text;
begin
  if not _cust_token_ok(p_id, p_token) then
    raise exception 'STALE_SESSION' using errcode = 'P0001';
  end if;
  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'entry';
  end if;
  if _satcode_locked() then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;
  -- The details staff choose riders by: a date of birth, a nationality and an Instagram, as on the Defe
  -- page (20261023170000). The page asks them of every rider and saves them first.
  if not exists (select 1 from customers x
                  where x.id = p_id
                    and nullif(btrim(coalesce(x.birth_date, '')), '') is not null
                    and nullif(btrim(coalesce(x.nationality, '')), '') is not null
                    and nullif(btrim(coalesce(x.socials->>'instagram', '')), '') is not null) then
    raise exception 'FIX_FIRST' using errcode = 'P0001', detail = 'birth_date,nationality,instagram';
  end if;
  select * into s from sessions x
   where x.id = p_session and x.event_kind = 'community'
     and coalesce(nullif(x.ride_kind, ''), 'saturday') = 'saturday' and x.required_tag_id is null
     and coalesce(x.status, '') in ('open', 'full');
  if s.id is null then
    raise exception 'SESSION_CLOSED' using errcode = 'P0001';
  end if;
  -- Every Saturday rider rides with a group: Beginners 20 km or Intermediates 40 km (20261002120000).
  if coalesce(p_entry->>'ride_group', '') not in ('beg', 'int') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'ride_group';
  end if;
  -- One booking at a time per ride: each code's places there are counted under it.
  perform pg_advisory_xact_lock(hashtext('satcode:' || s.id));
  select o.code, o.on_ride, o.places into _c, _on, _pl from _satcode_on(s.id, p_code) o;
  if _c is null or not coalesce(_on, false) then
    perform _ip_gate('satcode', 30, interval '10 minutes');
    id := null; queue_num := null; status := null; refused := 'BAD_CODE';
    return next;
    return;
  end if;
  if _pl is not null and _satcode_live(s.id, _c) >= _pl then
    id := null; queue_num := null; status := null; refused := 'CODE_USED_UP';
    return next;
    return;
  end if;
  select x.name into _name from customers x where x.id = p_id;
  perform set_config('mm.satcode', s.id || '|' || _c, true);
  for r in
    select * from customer_create_booking(p_id, p_token, jsonb_build_array(
      (p_entry - 'promo_code' - 'group_id' - 'run_km' - 'share_ok' - 'ask' - 'vl' - 'blood_role' - 'blood_club')
      || jsonb_build_object('session_id', s.id, 'name', coalesce(_name, ''))))
  loop
    id := r.id; queue_num := r.queue_num; status := r.status; refused := null;
    return next;
  end loop;
  perform set_config('mm.satcode', '', true);
end $function$;
revoke all on function public.saturday_book(text, text, text, text, jsonb) from public;
grant execute on function public.saturday_book(text, text, text, text, jsonb) to anon, authenticated;

-- 10 ────────────────────────────────────────────────────────────────────────
do $patch$
declare d text; n text;
begin
  d := pg_get_functiondef('public.staff_move_session(text,text,text,boolean)'::regprocedure);
  if position('saturday_code_rides' in d) = 0 then
    n := replace(d, E'\n  update session_partners set session_id = v_to where session_id = p_from;\n',
                    E'\n  update session_partners set session_id = v_to where session_id = p_from;\n'
                 || E'  update saturday_code_rides set session_id = v_to where session_id = p_from;   -- 20261108120000\n');
    if n = d then raise exception 'staff_move_session is not the definition this migration expects'; end if;
    execute n;
  end if;
end $patch$;

do $chk$
begin
  if position('mm.satcode' in pg_get_functiondef('public._community_booking_gate()'::regprocedure)) = 0 then
    raise exception '_community_booking_gate was not rewritten';
  end if;
  if position('saturday_code_rides' in pg_get_functiondef('public.staff_move_session(text,text,text,boolean)'::regprocedure)) = 0 then
    raise exception 'staff_move_session was not patched';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.staff_move_session(text,text,text,boolean)'::regprocedure) then
    raise exception 'staff_move_session lost SECURITY DEFINER';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261108120000', 'saturday_codes')
on conflict (version) do nothing;

commit;

-- Check (read only): the tables with RLS on, the column, the trigger, the functions' attributes, the
-- grants, the patches and the ledger row.
select (select json_agg(json_build_object('t', c.relname, 'rls', c.relrowsecurity) order by c.relname)
          from pg_class c where c.relnamespace = 'public'::regnamespace
           and c.relname in ('saturday_codes', 'saturday_code_rides', 'saturday_settings')) as tables,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'queue_entries' and column_name = 'ride_code') as col,
       (select count(*) from pg_trigger where tgname = 'queue_entries_ride_code') as trig,
       (select json_agg(json_build_object('fn', p.proname, 'definer', p.prosecdef, 'settings', p.proconfig,
                                          'anon', has_function_privilege('anon', p.oid, 'execute')) order by p.proname)
          from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('_community_booking_gate', '_ride_code_fill', '_satcode_on', '_satcode_live',
                             '_satcode_locked', 'saturday_rides', 'saturday_book', 'saturday_link_only',
                             'staff_move_session')) as fns,
       (select link_only from public.saturday_settings) as link_only,
       (select name from supabase_migrations.schema_migrations where version = '20261108120000') as ledger;
