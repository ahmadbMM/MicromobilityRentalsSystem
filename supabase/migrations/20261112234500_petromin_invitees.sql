-- Petromin invitees book a Petromin night themselves at micromobility.sa/petromin-invite (the user, 2026-11-12: "create
-- me a webpage for petromin invitees to write their names and phone numbers and bike types and add them as walk-ins ...
-- make petromin invitees have a booking number that starts with an i"). Their answers: a walk-in booking on the night's
-- Bookings list (not a registration, no account), the invitee pays the standard fare at the desk, one rider each.
--
-- An invitee's booking is an ordinary queue_entries row on a Petromin night:
--   * walk_in true, no customer_id, via 'invite', status waiting (or the waitlist when the night is full), the waiver it
--     agreed to on the page. Its fare is the standard one (_fare_now: no registration points at it, so no employee
--     fare), paid at the desk like any walk-in.
--   * invite_no: I-001, I-002 ... on the night's own counter ('invite' in rider_night_counters), unique per night.
--     Only petromin_invite_book writes it (it names the row's night and number in mm.invite, which the guard below
--     checks); a staff move to another Petromin night takes that night's next I- number, a move off Petromin drops it.
--   * one phone is one invitee booking a night: the same phone again updates its name and bike while it waits.
--   * Petromin nights are members-only (_community_booking_gate): an insert that petromin_invite_book is making on
--     that night (mm.invite names it) passes, nothing else changes there.
-- New, callable without an account (anon), all SECURITY DEFINER with search_path public:
--   petromin_invite_book(night, name, phone, type, waiver, privacy, from_no, from_session) -> the booking or {error}
--   petromin_invite_lookup(no, phone, night)  -> what the page's Find my booking and the Apple pass show
--   petromin_invite_cancel(no, phone, night)  -> cancels a booking still waiting
-- form_step counts the invitee page's steps too (form 'pminvite').
-- Every block skips itself once applied, so the file can be run again safely.
-- Rollback: drop the three RPCs, the trigger and _invite_no_guard/_invite_next; restore _community_booking_gate and
-- form_step from their live definitions before this file (20261108120000 / 20261112210000); the column can stay.

begin;

-- ── 1. the number on the booking ─────────────────────────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists invite_no text;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'queue_entries_invite_no_check') then
    alter table public.queue_entries add constraint queue_entries_invite_no_check
      check (invite_no is null or invite_no ~ '^I-[0-9]{3,6}$');
  end if;
end $c$;
create unique index if not exists queue_entries_invite_no_uq on public.queue_entries (session_id, invite_no) where invite_no is not null;

-- The night's next I- number.
create or replace function public._invite_next(p_session text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare v_seq int;
begin
  insert into rider_night_counters (session_key, source, n) values (coalesce(p_session, ''), 'invite', 1)
    on conflict (session_key, source) do update set n = rider_night_counters.n + 1
  returning n into v_seq;
  return 'I-' || lpad(v_seq::text, 3, '0');
end $$;
revoke all on function public._invite_next(text) from public, anon, authenticated;

-- Only petromin_invite_book writes a number; a move keeps the number in step with the night.
create or replace function public._invite_no_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare v_ok text := coalesce(current_setting('mm.invite', true), '');
begin
  if tg_op = 'INSERT' then
    if new.invite_no is not null and v_ok is distinct from (new.session_id || '|' || new.invite_no) then
      new.invite_no := null;
    end if;
    return new;
  end if;
  if new.invite_no is distinct from old.invite_no and v_ok is distinct from (new.session_id || '|' || coalesce(new.invite_no, '')) then
    new.invite_no := old.invite_no;
  end if;
  -- Moved to another night: that night's next I- number on a Petromin night, none on any other ride.
  if new.session_id is distinct from old.session_id and new.invite_no is not null then
    if exists (select 1 from sessions s where s.id = new.session_id and coalesce(s.ride_kind, '') = 'petromin') then
      new.invite_no := _invite_next(new.session_id);
    else
      new.invite_no := null;
    end if;
  end if;
  return new;
end $$;
revoke all on function public._invite_no_guard() from public, anon, authenticated;
drop trigger if exists queue_entries_invite_no on public.queue_entries;
create trigger queue_entries_invite_no before insert or update of invite_no, session_id on public.queue_entries
  for each row execute function public._invite_no_guard();

-- ── 2. the members-only gate lets the invitee's own booking onto its Petromin night ─────────────────────────────
create or replace function pg_temp._once(src text, a text, b text, n integer default 1) returns text
language plpgsql as $f$
declare c integer := (length(src) - length(replace(src, a, ''))) / greatest(length(a), 1);
begin
  if c <> n then raise exception 'petromin_invitees: expected % of [%], found %', n, left(a, 80), c; end if;
  return replace(src, a, b);
end $f$;

do $mig$
declare d text;
begin
  d := pg_get_functiondef('public._community_booking_gate()'::regprocedure);
  if position('mm.invite' in d) > 0 then raise notice '_community_booking_gate already lets invitees in; nothing to do'; return; end if;
  d := pg_temp._once(d,
$a$     and not (coalesce(s.ride_kind, '') = 'petromin' and _petromin_holder(new.customer_id))$a$,
$b$     and not (coalesce(s.ride_kind, '') = 'petromin' and _petromin_holder(new.customer_id))
     -- the booking petromin_invite_book is making on this Petromin night (20261112234500)
     and not (coalesce(s.ride_kind, '') = 'petromin' and tg_op = 'INSERT'
              and split_part(coalesce(current_setting('mm.invite', true), ''), '|', 1) = new.session_id)$b$);
  execute d;
end $mig$;

-- ── 3. booking from the page ─────────────────────────────────────────────────────────────────────────────────────
-- p_from_no / p_from_session: the page's Edit of a booking it holds (proved by the same phone). The same night updates
-- that booking; another night books there and cancels the old one, in one go.
create or replace function public.petromin_invite_book(p_session_id text, p_name text, p_phone text, p_type text,
  p_waiver text default null, p_privacy text default null, p_from_no text default null, p_from_session text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  -- dashes of every script read as a space, as rider_register reads them (built from code points: no escapes here)
  v_dash text := '[-' || chr(1418) || chr(1470) || chr(5120) || chr(6150) || chr(8208) || '-' || chr(8213) || chr(8722)
                 || chr(11799) || chr(11802) || chr(11834) || chr(11835) || chr(11840) || chr(12316) || chr(12336)
                 || chr(12448) || chr(65073) || chr(65074) || chr(65112) || chr(65123) || chr(65293) || ']';
  v_name text;
  v_type text := coalesce(p_type, '');
  v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_phone text; v_last9 text;
  v_today text := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  v_now text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_sess sessions%rowtype; v_win record;
  v_from queue_entries%rowtype; v_prev queue_entries%rowtype; v_row queue_entries%rowtype;
  v_no text; v_id text; v_err text;
begin
  v_name := regexp_replace(trim(regexp_replace(coalesce(p_name, ''), v_dash, ' ', 'g')), '\s+', ' ', 'g');
  if not _rider_gate() then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if coalesce(p_waiver, '') !~ '^[A-Za-z0-9._-]{1,40}$' then return jsonb_build_object('ok', false, 'error', 'waiver'); end if;
  if _waiver_outdated(p_waiver) then raise exception 'WAIVER_OUTDATED' using errcode = 'P0001'; end if;
  if coalesce(p_privacy, '') !~ '^[A-Za-z0-9._-]{1,40}$' then return jsonb_build_object('ok', false, 'error', 'privacy'); end if;
  if v_name = '' or length(v_name) > 120 or v_name !~ '\s' then return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if not _name_chars_ok(v_name) then return jsonb_build_object('ok', false, 'error', 'name_chars'); end if;
  if not _name_parts_ok(v_name) then return jsonb_build_object('ok', false, 'error', 'name_chars', 'why', 'short'); end if;
  if v_type not in ('Road', 'Hybrid', 'Mountain') then return jsonb_build_object('ok', false, 'error', 'type'); end if;

  if v_digits ~ '^009665\d{8}$' then v_digits := substr(v_digits, 3); end if;
  if v_digits ~ '^05\d{8}$' then v_phone := '+966' || substr(v_digits, 2);
  elsif v_digits ~ '^5\d{8}$' then v_phone := '+966' || v_digits;
  elsif v_digits ~ '^9665\d{8}$' then v_phone := '+' || v_digits;
  elsif coalesce(p_phone, '') ~ '^\+\d{8,15}$' then v_phone := p_phone;
  else return jsonb_build_object('ok', false, 'error', 'phone');
  end if;
  v_last9 := right(v_phone, 9);

  -- An open Petromin night that has not ended, open to everyone (never one for men or women only).
  select * into v_sess from sessions where id = p_session_id;
  if v_sess.id is null or coalesce(v_sess.ride_kind, '') <> 'petromin' or not _rider_session_open(v_sess)
     or v_sess.session_date < v_today or v_sess.gender_only is not null then
    return jsonb_build_object('ok', false, 'error', 'session');
  end if;
  select * into v_win from _session_window(v_sess);
  if v_win.ends_at <= now() then return jsonb_build_object('ok', false, 'error', 'session'); end if;

  -- The booking being edited: the same number on its night, made with this phone, still waiting.
  if coalesce(p_from_no, '') <> '' then
    select * into v_from from queue_entries q
     where q.invite_no = upper(trim(p_from_no)) and q.session_id = coalesce(p_from_session, '')
       and q.status in ('waiting', 'waitlist')
       and right(regexp_replace(coalesce(q.phone, ''), '\D', '', 'g'), 9) = v_last9;
    if v_from.id is null then return jsonb_build_object('ok', false, 'error', 'notfound'); end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('invite:' || v_sess.id || ':' || v_last9));
  if v_from.id is not null and v_from.session_id = v_sess.id then
    v_prev := v_from;
  else
    select * into v_prev from queue_entries q
     where q.session_id = v_sess.id and q.invite_no is not null and q.status in ('waiting', 'waitlist', 'active', 'done')
       and right(regexp_replace(coalesce(q.phone, ''), '\D', '', 'g'), 9) = v_last9
     order by q.queue_num limit 1;
  end if;
  if v_prev.id is not null and v_prev.status in ('active', 'done') then
    return jsonb_build_object('ok', false, 'error', 'checked_in', 'invite_no', v_prev.invite_no);
  end if;
  -- A new booking takes a place on the night: thirty an hour from one network address at most.
  if v_prev.id is null and not _ip_gate('pminvite', 30, interval '1 hour') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;

  begin
    if v_prev.id is not null then
      update queue_entries
         set name = v_name, type_preference = v_type, waiver_version = p_waiver, waiver_at = to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
       where id = v_prev.id
      returning * into v_row;
    else
      v_no := _invite_next(v_sess.id);
      v_id := (select string_agg(chr(97 + floor(random() * 26)::int), '') from generate_series(1, 15));
      perform set_config('mm.invite', v_sess.id || '|' || v_no, true);
      insert into queue_entries (id, name, email, phone, size, height, type_preference, paid, price, session_id, session_day,
                                 session_date, queue_num, status, registered_at, walk_in, customer_id, waiver_version,
                                 waiver_at, via, invite_no)
      values (v_id, v_name, null, v_phone, '', null, v_type, false, 0, v_sess.id, coalesce(v_sess.day, ''),
              v_sess.session_date, 0, 'waiting', v_now, true, null, p_waiver,
              to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'invite', v_no)
      returning * into v_row;
      perform set_config('mm.invite', '', true);
    end if;
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform set_config('mm.invite', '', true);
    if v_err = 'TYPE_CLOSED' then return jsonb_build_object('ok', false, 'error', 'type_closed'); end if;
    if v_err = 'TYPE_FULL' then return jsonb_build_object('ok', false, 'error', 'type_full'); end if;
    raise;
  end;

  -- Edited onto another night: the old booking goes.
  if v_from.id is not null and v_from.id <> v_row.id then
    update queue_entries set status = 'cancelled', cancelled_by = 'customer' where id = v_from.id;
  end if;

  return jsonb_build_object(
    'ok', true, 'resubmitted', v_prev.id is not null, 'booking_no', v_row.invite_no, 'invite_no', v_row.invite_no,
    'ref', 'MMC-' || v_row.queue_num || '-' || left(v_row.id, 6),
    'status', v_row.status, 'name', v_row.name, 'phone', v_row.phone, 'type', v_row.type_preference, 'price', v_row.price,
    'session', jsonb_build_object('id', v_sess.id, 'title', v_sess.title,
      'start', to_char(v_win.starts_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
      'end',   to_char(v_win.ends_at   at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
      'collect', _rider_collect(v_sess),
      'place', nullif(trim(coalesce(v_sess.location, '')), '')));
end $$;
revoke all on function public.petromin_invite_book(text, text, text, text, text, text, text, text) from public;
grant execute on function public.petromin_invite_book(text, text, text, text, text, text, text, text) to anon, authenticated;

-- ── 4. Find my booking (and the Apple pass) ─────────────────────────────────────────────────────────────────────
-- The number and the phone it was made with, tonight's or a later night's (a night over since yesterday is no longer
-- shown), as rider_lookup answers the Petromin form; misses count toward the same lock per address.
create or replace function public.petromin_invite_lookup(p_invite_no text, p_phone text, p_session_id text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  v_proof text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  v_no text := upper(trim(coalesce(p_invite_no, '')));
  v_row queue_entries%rowtype;
  v_sess sessions%rowtype;
  v_start timestamptz; v_end timestamptz;
  v_more jsonb := '[]'::jsonb;
begin
  if exists (select 1 from login_throttle where identifier = 'rlookup:' || _client_ip() and locked_until > now()) then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  if v_no ~ '^I-[0-9]{3,6}$' and length(v_proof) = 9 then
    select q.* into v_row from queue_entries q join sessions s on s.id = q.session_id
     cross join lateral _session_window(s) w
     where q.invite_no = v_no and q.status in ('waiting', 'waitlist', 'active', 'done')
       and q.phone is not null and right(regexp_replace(q.phone, '\D', '', 'g'), 9) = v_proof
       and (p_session_id is null or q.session_id = p_session_id)
       and s.session_date >= to_char(now() at time zone 'Asia/Riyadh' - interval '1 day', 'YYYY-MM-DD')
     order by (w.ends_at + interval '6 hours' < now()), s.session_date, q.session_id
     limit 1;
  end if;
  if v_row.id is null then
    perform _ip_gate('rlookup', 20, interval '10 minutes');
    return jsonb_build_object('ok', false, 'error', 'notfound');
  end if;
  select * into v_sess from sessions where id = v_row.session_id;
  select coalesce(jsonb_agg(to_jsonb(x.session_id) order by x.session_date, x.session_id), '[]'::jsonb) into v_more
    from (select distinct q.session_id, s.session_date
            from queue_entries q join sessions s on s.id = q.session_id
           where q.invite_no = v_no and q.status in ('waiting', 'waitlist', 'active', 'done')
             and q.phone is not null and right(regexp_replace(q.phone, '\D', '', 'g'), 9) = v_proof
             and q.session_id <> v_row.session_id
             and s.session_date >= to_char(now() at time zone 'Asia/Riyadh' - interval '1 day', 'YYYY-MM-DD')) x;
  select w.starts_at, w.ends_at into v_start, v_end from _session_window(v_sess) w;
  return jsonb_build_object(
    'ok', true,
    'booking_no', v_row.invite_no, 'invite_no', v_row.invite_no,
    'ref', 'MMC-' || v_row.queue_num || '-' || left(v_row.id, 6),
    'company', null, 'name', v_row.name, 'phone', v_row.phone, 'type', v_row.type_preference,
    'status', v_row.status, 'checked_in', v_row.status in ('active', 'done'),
    'price', v_row.price, 'paid', coalesce(v_row.paid, false),
    'session', jsonb_build_object(
      'id', v_sess.id, 'title', v_sess.title,
      'start', to_char(v_start at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
      'end',   to_char(v_end   at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
      'collect', _rider_collect(v_sess),
      'place', nullif(trim(coalesce(v_sess.location, '')), '')),
    'more', v_more,
    'riders', '[]'::jsonb);
end $$;
revoke all on function public.petromin_invite_lookup(text, text, text) from public;
grant execute on function public.petromin_invite_lookup(text, text, text) to anon, authenticated;

-- ── 5. Cancel my booking ────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.petromin_invite_cancel(p_invite_no text, p_phone text, p_session_id text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  v_proof text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  v_row queue_entries%rowtype;
  v_sess sessions%rowtype;
  v_end timestamptz;
begin
  if not _rider_gate() then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if length(v_proof) = 9 and coalesce(p_session_id, '') <> '' then
    select q.* into v_row from queue_entries q
     where q.invite_no = upper(trim(coalesce(p_invite_no, ''))) and q.session_id = p_session_id
       and q.status in ('waiting', 'waitlist', 'active', 'done')
       and q.phone is not null and right(regexp_replace(q.phone, '\D', '', 'g'), 9) = v_proof
     limit 1;
  end if;
  if v_row.id is null then return jsonb_build_object('ok', false, 'error', 'notfound'); end if;
  if v_row.status in ('active', 'done') then return jsonb_build_object('ok', false, 'error', 'checked_in'); end if;
  select * into v_sess from sessions where id = v_row.session_id;
  select w.ends_at into v_end from _session_window(v_sess) w;
  if v_end is not null and v_end < now() then return jsonb_build_object('ok', false, 'error', 'session'); end if;
  update queue_entries set status = 'cancelled', cancelled_by = 'customer' where id = v_row.id;
  return jsonb_build_object('ok', true, 'booking_no', v_row.invite_no, 'session_id', v_row.session_id);
end $$;
revoke all on function public.petromin_invite_cancel(text, text, text) from public;
grant execute on function public.petromin_invite_cancel(text, text, text) to anon, authenticated;

-- ── 6. form_step: the invitee page's steps are counted too ───────────────────────────────────────────────────────
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.form_step(text,integer,text,text,text)'::regprocedure);
  if position('pminvite' in d) > 0 then raise notice 'form_step already counts the invitee page; nothing to do'; return; end if;
  d := pg_temp._once(d,
$a$p_form not in ('petromin', 'dukan')$a$,
$b$p_form not in ('petromin', 'dukan', 'pminvite')$b$);
  execute d;
end $mig$;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261112234500', 'petromin_invitees')
on conflict (version) do nothing;

commit;
