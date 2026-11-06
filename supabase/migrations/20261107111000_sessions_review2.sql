-- ============================================================================
-- Sessions, second round of the staff review (2026-11-06; app helpers _n6r*).
--
--  1. Promo codes for one session or one kind of ride (SS18). promo_codes.session_id and promo_codes.ride_kind (both
--     nullable: every existing code stays as it is). _session_kind(id) names a session's kind the way the app's
--     _rideKind does. _promo_valid gains a three-argument form (code, customer, session) that adds the scope to the
--     two-argument checks; the two-argument form is restated unchanged (SECURITY DEFINER and the search_path kept).
--     _promo_scope_guard (BEFORE INSERT OR UPDATE OF promo_code, session_id on queue_entries) clears a code that is not
--     for the row's session or its kind, so the price trigger then charges the full fare and the use is never counted.
--     Named trg_a_ so it runs before trg_enforce_booking_price, trg_house_insert_guard and trg_promo_count_* (triggers fire
--     by name). A staff update passes, as the price trigger lets staff set prices. promo_lookup (same signature) also
--     returns the code's session_id and ride_kind, so the booking form can say why a code does not apply.
--  2. Bikes out of service (OT01). sessions.out_bikes jsonb {type: count}, default '{}'. _out_bikes_guard (BEFORE INSERT
--     on queue_entries, customers only, as _capacity_guard) waitlists a new booking when the places held reach the
--     capacity less every bike out, or, for a type the session counts by itself (bike_slots by type, or the fleet
--     picked), that type's places less its bikes out. A move between sessions goes through _session_has_room and is not
--     touched. Empty by default, so nothing changes until staff mark bikes out.
--  3. Minimum riders and a decision time (OT02). sessions.go_min (1-1000) and sessions.go_decide_at. Read by the app only
--     while Settings > Business "gonogo_on" is ticked (staff_options 'biz', off by default). Nothing here cancels anything.
--  4. The staff rota per session (OT05). session_rota (id, session_id, role lead|desk|sweep|mechanic, name), staff only
--     (RLS: is_staff() for every operation). staff_move_session is restated from 20261104160000 with one more line, so a
--     ride's rota follows it to its new date. No foreign key: a session moves by insert and delete, which would take the
--     rows with it.
--
-- Safe before or after the app: the app hides or explains each feature until its column, table or function is there,
-- and every new column is empty or null by default.
-- Undo: drop trigger trg_a_promo_scope on public.queue_entries; drop function public._promo_scope_guard();
--       drop function public._promo_valid(text, text, text); drop function public._session_kind(text);
--       drop trigger queue_entries_out_bikes on public.queue_entries; drop function public._out_bikes_guard();
--       drop table public.session_rota; re-run 20261104160000 section 1 and 20260922122000's promo_lookup;
--       alter table public.promo_codes drop column session_id, drop column ride_kind;
--       alter table public.sessions drop column out_bikes, drop column go_min, drop column go_decide_at;
-- ============================================================================
begin;

-- ── 1. Promo codes for one session or kind ─────────────────────────────────────
alter table public.promo_codes add column if not exists session_id text;
alter table public.promo_codes add column if not exists ride_kind text;
comment on column public.promo_codes.session_id is 'Only for this session (its id). NULL = any session. (20261107111000)';
comment on column public.promo_codes.ride_kind is 'Only for this kind of ride, as the app names kinds (jcc, saturday, petromin, swim, workshop, snd96, event, runher, vlap, arena, defe5k, blood). NULL = any. (20261107111000)';
alter table public.promo_codes drop constraint if exists promo_codes_ride_kind_known;
alter table public.promo_codes add constraint promo_codes_ride_kind_known
  check (ride_kind is null or ride_kind in ('jcc','saturday','petromin','swim','workshop','snd96','event','runher','vlap','arena','defe5k','blood'));

-- The app's _rideKind, read off the row.
create or replace function public._session_kind(p_session text)
 returns text
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select case
           when s.ride_kind = 'snd96' then 'snd96'
           when coalesce(s.event_kind, '') <> 'community' then 'jcc'
           when s.ride_kind in ('event','petromin','swim','workshop','runher','vlap','arena','defe5k','blood') then s.ride_kind
           else 'saturday'
         end
    from sessions s where s.id = p_session
$function$;
revoke execute on function public._session_kind(text) from public, anon, authenticated;

-- Restated unchanged (20260816120000): SECURITY DEFINER and the search_path written out again.
create or replace function public._promo_valid(p_code text, p_customer text)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $function$
  select exists (
    select 1 from promo_codes c
     where lower(c.code) = lower(p_code)
       and c.active = true
       and (c.expires_at  is null or c.expires_at >= (now() at time zone 'Asia/Riyadh')::date)
       and (c.max_uses    is null or coalesce(c.uses, 0) < c.max_uses)
       and (c.customer_id is null or c.customer_id = p_customer)
  );
$function$;
revoke execute on function public._promo_valid(text, text) from public, anon, authenticated;

-- The same, for a booking on one session: also its session and its kind.
create or replace function public._promo_valid(p_code text, p_customer text, p_session text)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $function$
  select exists (
    select 1 from promo_codes c
     where lower(c.code) = lower(p_code)
       and c.active = true
       and (c.expires_at  is null or c.expires_at >= (now() at time zone 'Asia/Riyadh')::date)
       and (c.max_uses    is null or coalesce(c.uses, 0) < c.max_uses)
       and (c.customer_id is null or c.customer_id = p_customer)
       and (c.session_id  is null or c.session_id = p_session)
       and (c.ride_kind   is null or c.ride_kind = _session_kind(p_session))
  );
$function$;
revoke execute on function public._promo_valid(text, text, text) from public, anon, authenticated;

create or replace function public._promo_scope_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(new.promo_code, '') = '' then return new; end if;
  if tg_op = 'UPDATE' then
    if new.promo_code is not distinct from old.promo_code and new.session_id is not distinct from old.session_id then return new; end if;
    if (select is_staff()) then return new; end if;   -- staff set prices deliberately, as in _enforce_booking_price
  end if;
  -- Only the scope is judged here; expiry, limits and the customer stay the price trigger's.
  if exists (select 1 from promo_codes c
              where lower(c.code) = lower(new.promo_code)
                and ((c.session_id is not null and c.session_id is distinct from new.session_id)
                  or (c.ride_kind is not null and c.ride_kind is distinct from _session_kind(new.session_id)))) then
    new.promo_code := null;
  end if;
  return new;
end $function$;
revoke execute on function public._promo_scope_guard() from public, anon, authenticated;

drop trigger if exists trg_a_promo_scope on public.queue_entries;
create trigger trg_a_promo_scope
  before insert or update of promo_code, session_id on public.queue_entries
  for each row execute function public._promo_scope_guard();

-- As 20260922122000, and the code's scope in the answer.
create or replace function public.promo_lookup(p_code text, p_id text default null, p_token text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare c promo_codes%rowtype;
        v text := translate(btrim(coalesce(p_code, '')), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
begin
  if v = '' or length(v) > 40 then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if not _ip_gate('promo', 60, interval '10 minutes') then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select * into c from promo_codes where lower(code) = lower(v) and active = true order by id limit 1;
  if c.id is null then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if c.expires_at is not null and c.expires_at < (now() at time zone 'Asia/Riyadh')::date then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if c.max_uses is not null and coalesce(c.uses, 0) >= c.max_uses then
    return jsonb_build_object('ok', false, 'reason', 'used_up');
  end if;
  if c.customer_id is not null and (p_id is null or c.customer_id <> p_id or not _cust_token_ok(p_id, p_token)) then
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;
  return jsonb_build_object('ok', true, 'code', c.code, 'kind', c.kind, 'value', c.value, 'applies_to', c.applies_to,
                            'session_id', c.session_id, 'ride_kind', c.ride_kind);
end $function$;
revoke all on function public.promo_lookup(text, text, text) from public;
grant execute on function public.promo_lookup(text, text, text) to anon, authenticated;

-- ── 2. Bikes out of service ───────────────────────────────────────────────────
alter table public.sessions add column if not exists out_bikes jsonb not null default '{}'::jsonb;
alter table public.sessions drop constraint if exists sessions_out_bikes_object;
alter table public.sessions add constraint sessions_out_bikes_object check (jsonb_typeof(out_bikes) = 'object');
comment on column public.sessions.out_bikes is 'Bikes out of service on this session, {type: count}. Each takes a place off the capacity and off its type''s count. (20261107111000)';

create or replace function public._out_bikes_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare s sessions%rowtype; _own boolean; _out int := 0; _n int; _live int; _slots jsonb; _places int;
begin
  if coalesce(current_setting('mm.promoting', true), '') = '1' then return new; end if;
  if coalesce(new.status, '') <> 'waiting' or (select is_staff()) then return new; end if;
  select * into s from sessions where id = new.session_id;
  if not found or coalesce(s.needs_approval, false) or s.out_bikes is null or s.out_bikes = '{}'::jsonb then return new; end if;
  _own := coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin';
  if coalesce(new.type_preference, '') = 'Own' and not _own then return new; end if;
  select coalesce(sum(greatest(0, floor((value #>> '{}')::numeric))), 0)::int into _out
    from jsonb_each(s.out_bikes) where jsonb_typeof(value) = 'number';
  if _out <= 0 then return new; end if;
  perform pg_advisory_xact_lock(hashtext('cap:' || new.session_id));
  select count(*) into _live from queue_entries q
   where q.session_id = new.session_id
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
     and (_own or coalesce(q.type_preference, '') <> 'Own');
  if _live >= greatest(0, coalesce(s.capacity, 12) - _out) then new.status := 'waitlist'; return new; end if;
  -- The type's own places, where the session counts them.
  if jsonb_typeof(s.out_bikes -> new.type_preference) <> 'number' then return new; end if;
  _n := greatest(0, floor((s.out_bikes ->> new.type_preference)::numeric))::int;
  if _n <= 0 then return new; end if;
  begin
    _slots := coalesce(nullif(s.bike_slots, '')::jsonb, '{}'::jsonb);
  exception when others then return new;
  end;
  if jsonb_typeof(_slots -> '_bikes') = 'array' then
    select count(*) into _places from bikes b
     where b.type = new.type_preference
       and b.id::text in (select jsonb_array_elements_text(_slots -> '_bikes'));
  elsif jsonb_typeof(_slots -> new.type_preference) = 'number' then
    _places := (_slots ->> new.type_preference)::numeric::int;
  elsif jsonb_typeof(_slots -> new.type_preference) = 'object' then
    select coalesce(sum((value #>> '{}')::numeric), 0)::int into _places
      from jsonb_each(_slots -> new.type_preference) where jsonb_typeof(value) = 'number';
  else
    return new;
  end if;
  select count(*) into _live from queue_entries q
   where q.session_id = new.session_id and q.type_preference = new.type_preference
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
  if _live >= greatest(0, _places - _n) then new.status := 'waitlist'; end if;
  return new;
end $function$;
revoke execute on function public._out_bikes_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_out_bikes on public.queue_entries;
create trigger queue_entries_out_bikes
  before insert on public.queue_entries
  for each row execute function public._out_bikes_guard();

-- ── 3. Minimum riders and a decision time ─────────────────────────────────────
alter table public.sessions add column if not exists go_min integer;
alter table public.sessions add column if not exists go_decide_at timestamptz;
alter table public.sessions drop constraint if exists sessions_go_min_range;
alter table public.sessions add constraint sessions_go_min_range check (go_min is null or go_min between 1 and 1000);
comment on column public.sessions.go_min is 'Minimum riders for the session to run; NULL = none. Staff decide; nothing cancels by itself. (20261107111000)';
comment on column public.sessions.go_decide_at is 'When staff decide whether the session runs, if short of go_min. (20261107111000)';

-- ── 4. The staff rota per session ─────────────────────────────────────────────
create table if not exists public.session_rota (
  id          text primary key,
  session_id  text not null,
  role        text not null check (role in ('lead', 'desk', 'sweep', 'mechanic')),
  name        text not null check (length(btrim(name)) between 1 and 80),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
create index if not exists session_rota_session on public.session_rota (session_id);
alter table public.session_rota enable row level security;
drop policy if exists session_rota_read on public.session_rota;
drop policy if exists session_rota_ins on public.session_rota;
drop policy if exists session_rota_upd on public.session_rota;
drop policy if exists session_rota_del on public.session_rota;
create policy session_rota_read on public.session_rota for select using ((select is_staff()));
create policy session_rota_ins on public.session_rota for insert with check ((select is_staff()));
create policy session_rota_upd on public.session_rota for update using ((select is_staff())) with check ((select is_staff()));
create policy session_rota_del on public.session_rota for delete using ((select is_staff()));
revoke all on public.session_rota from anon;
grant select, insert, update, delete on public.session_rota to authenticated;

-- staff_move_session as 20261104160000, and the rota follows the ride (the one added line is marked).
create or replace function public.staff_move_session(p_from text, p_to_id text, p_date text, p_exact boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  s sessions%rowtype;
  d date;
  v_to text := p_to_id;
  v_day text;
  n int := 1;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  begin
    d := p_date::date;
  exception when others then
    raise exception 'BAD_DATE' using errcode = '22007';
  end;
  if coalesce(p_to_id, '') = '' or (not p_exact and left(p_to_id, 10) <> to_char(d, 'YYYY-MM-DD')) then
    raise exception 'BAD_SESSION_ID' using errcode = '22023';
  end if;
  select * into s from sessions where id = p_from for update;
  if s.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_to_id = p_from then raise exception 'BAD_SESSION_ID' using errcode = '22023'; end if;

  while exists (select 1 from sessions where id = v_to) loop
    if p_exact then raise exception 'SESSION_ID_TAKEN' using errcode = '23505'; end if;
    n := n + 1;
    if n > 25 then raise exception 'SESSION_ID_TAKEN' using errcode = '23505'; end if;
    v_to := p_to_id || '-' || n;
  end loop;

  v_day := to_char(d, 'FMDay');
  insert into sessions
    select (jsonb_populate_record(s, jsonb_build_object('id', v_to, 'session_date', to_char(d, 'YYYY-MM-DD'), 'day', v_day))).*;

  update queue_entries set session_id = v_to, session_date = to_char(d, 'YYYY-MM-DD'), session_day = v_day where session_id = p_from;
  update cashier_sales set session_id = v_to where session_id = p_from;
  update community_applications set invited_session = v_to where invited_session = p_from;
  update customer_badges set session_id = v_to where session_id = p_from;
  update rider_registrations set session_id = v_to where session_id = p_from;
  update session_partners set session_id = v_to where session_id = p_from;
  update part_timer_shifts set session_id = v_to where session_id = p_from;
  update till_sessions set session_id = v_to where session_id = p_from;
  update deposits set session_id = v_to where session_id = p_from;
  update waitlist_offers set session_id = v_to where session_id = p_from;
  update wallet_ledger set session_id = v_to where session_id = p_from;
  update session_rota set session_id = v_to where session_id = p_from;   -- 20261107111000
  update member_kudos k set session_id = v_to where k.session_id = p_from
    and not exists (select 1 from member_kudos x where x.from_id = k.from_id and x.to_id = k.to_id and x.session_id = v_to);
  update live_positions l set session_id = v_to where l.session_id = p_from
    and not exists (select 1 from live_positions x where x.session_id = v_to and x.role = l.role);
  update rider_night_counters c set session_key = v_to where c.session_key = p_from
    and not exists (select 1 from rider_night_counters x where x.session_key = v_to and x.source = c.source);

  delete from sessions where id = p_from;
  return jsonb_build_object('ok', true, 'id', v_to, 'day', v_day);
end $function$;
revoke all on function public.staff_move_session(text, text, text, boolean) from public, anon;
grant execute on function public.staff_move_session(text, text, text, boolean) to authenticated;

do $chk$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'promo_codes' and column_name = 'session_id') then
    raise exception 'promo_codes.session_id missing';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sessions' and column_name = 'out_bikes') then
    raise exception 'sessions.out_bikes missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_a_promo_scope' and not tgisinternal) then
    raise exception 'trg_a_promo_scope missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'queue_entries_out_bikes' and not tgisinternal) then
    raise exception 'queue_entries_out_bikes missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.session_rota'::regclass) then
    raise exception 'session_rota without RLS';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261107111000', 'sessions_review2')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- Read-only checks:
--   select column_name, data_type, column_default from information_schema.columns
--    where table_schema = 'public' and ((table_name = 'promo_codes' and column_name in ('session_id','ride_kind'))
--       or (table_name = 'sessions' and column_name in ('out_bikes','go_min','go_decide_at')));        -- 5 rows
--   select proname, prosecdef, proconfig from pg_proc
--    where proname in ('_promo_valid','_session_kind','_promo_scope_guard','_out_bikes_guard','promo_lookup','staff_move_session');
--                                                                       -- every row prosecdef true, {search_path=public}
--   select tgname, tgenabled from pg_trigger where tgname in ('trg_a_promo_scope','queue_entries_out_bikes');   -- 2 rows, O
--   select relrowsecurity from pg_class where oid = 'public.session_rota'::regclass;                             -- true
--   select has_function_privilege('anon', 'public._promo_valid(text,text,text)', 'execute');                      -- false
--   select has_table_privilege('anon', 'public.session_rota', 'select');                                          -- false
--   select promo_lookup('NO-SUCH-CODE');                                                                          -- {"ok": false, ...}
