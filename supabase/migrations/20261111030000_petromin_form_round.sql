-- The Petromin form's round of 2026-11-11 (research report "Petromin form design and function"; the user: "implement
-- everything mentioned"). The form at micromobility.sa/petromin gets:
--
--   1. rider_registrations.waiver_lang: the language the waiver was read and ticked in, beside its version and time.
--      rider_register and rider_edit take p_lang (the page's language) and store it when the waiver is ticked.
--   2. rider_sessions: each night also says when bikes are handed out (bike_slots._collect, 18:45 on Petromin nights)
--      and where (sessions.location, empty on Petromin nights: the form then names the circuit).
--   3. rider_lookup: "Find my booking" on any phone - the booking number and the mobile number it was made with (the
--      proof rider_edit already asks for) bring the booking back to the screen. A miss counts toward a lock per network
--      address (20 in 10 minutes); a hit does not.
--   4. rider_cancel: "Cancel my booking" from the ticket - the whole party, while nobody on it is checked in and the
--      desk has not tied it to a booking of its own. The same proof as rider_edit.
--   5. form_step_counts + form_step(): how far riders get on the form, counted per day, step, event, field and
--      language - no person, no device, no address. Staff read it on the Petromin page.
--
-- rider_register is rebuilt from its LIVE definition with exact-once text replaces (pg_temp._once), as 20261005210200
-- did: the header keeps SECURITY DEFINER and its search_path, and a text that does not match stops everything.
-- Rollback: drop function public.rider_lookup(text,text,text), public.rider_cancel(text,text,text),
-- public.form_step(text,integer,text,text,text); drop table public.form_step_counts; restore rider_register /
-- rider_edit / rider_sessions from 20261110235400 and 20261027150000; alter table public.rider_registrations drop
-- column waiver_lang.

begin;

-- ── 1. waiver_lang ───────────────────────────────────────────────────────────────────────────────────────────────
alter table public.rider_registrations add column if not exists waiver_lang text;
alter table public.rider_registrations drop constraint if exists rider_registrations_waiver_lang_shape;
alter table public.rider_registrations add constraint rider_registrations_waiver_lang_shape
  check (waiver_lang is null or waiver_lang ~ '^[a-z]{2,3}$');
comment on column public.rider_registrations.waiver_lang is
  'The language the Petromin form showed the waiver in when it was ticked (rider_register p_lang, 20261111030000).';

create or replace function pg_temp._once(src text, a text, b text, n integer default 1) returns text
language plpgsql as $f$
declare c integer := (length(src) - length(replace(src, a, ''))) / greatest(length(a), 1);
begin
  if c <> n then raise exception 'petromin_form_round: expected % of [%], found %', n, left(a, 80), c; end if;
  return replace(src, a, b);
end $f$;

do $mig$
declare d text;
begin
  if to_regprocedure('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,text)') is not null then
    raise notice 'rider_register already takes p_lang; nothing to do';
    return;
  end if;
  d := pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)'::regprocedure);
  d := pg_temp._once(d,
$a$p_privacy text DEFAULT NULL::text)$a$,
$b$p_privacy text DEFAULT NULL::text, p_lang text DEFAULT NULL::text)$b$);
  d := pg_temp._once(d,
$a$  if coalesce(p_privacy, '') !~ '^[A-Za-z0-9._-]{1,40}$' then p_privacy := null; end if;$a$,
$b$  if coalesce(p_privacy, '') !~ '^[A-Za-z0-9._-]{1,40}$' then p_privacy := null; end if;
  -- The language the waiver was read in (20261111030000): a two- or three-letter code, else nothing.
  if coalesce(p_lang, '') !~ '^[a-z]{2,3}$' then p_lang := null; end if;$b$);
  d := pg_temp._once(d,
$a$party_no, waiver_version, waiver_at, privacy_version, privacy_at)$a$,
$b$party_no, waiver_version, waiver_at, privacy_version, privacy_at, waiver_lang)$b$, 2);
  d := pg_temp._once(d,
$a$p_privacy, case when p_privacy is not null then now() end)$a$,
$b$p_privacy, case when p_privacy is not null then now() end, case when p_waiver is not null then p_lang end)$b$, 2);
  d := pg_temp._once(d,
$a$privacy_at = coalesce(excluded.privacy_at, rider_registrations.privacy_at),$a$,
$b$privacy_at = coalesce(excluded.privacy_at, rider_registrations.privacy_at),
        waiver_lang = case when excluded.waiver_version is not null then excluded.waiver_lang else rider_registrations.waiver_lang end,$b$, 2);
  execute d;
  drop function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text);
end $mig$;
alter function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,text) owner to postgres;
revoke all on function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,text) from public;
grant execute on function public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,text) to anon, authenticated, service_role;

-- rider_edit: the same as 20261110235400, with p_lang handed to rider_register.
drop function if exists public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text);
create or replace function public.rider_edit(p_booking_no text, p_proof_phone text, p_badge text, p_name text, p_height integer, p_type text, p_session_id text DEFAULT NULL::text, p_company text DEFAULT NULL::text, p_phone text DEFAULT NULL::text, p_riders jsonb DEFAULT NULL::jsonb, p_waiver text DEFAULT NULL::text, p_from_session text DEFAULT NULL::text, p_lang text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row rider_registrations%rowtype;
  v_proof text := right(regexp_replace(coalesce(p_proof_phone,''), '\D', '', 'g'), 9);
  v_newkey text := lower(regexp_replace(trim(coalesce(p_badge,'')), '[^a-zA-Z0-9]', '', 'g'));
  v_sess_id text;
  v_r jsonb;
  v_seq integer; v_bno text;
begin
  if not _rider_gate() then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  select r.* into v_row from rider_registrations r left join sessions s on s.id = r.session_id
   where upper(r.booking_no) = upper(trim(coalesce(p_booking_no,''))) and r.party_no = 1
     /* the night of the confirmation being edited, when the form sends it: numbers start again every night
        (20261110235400) */
     and (p_from_session is null or coalesce(r.session_id, '') = p_from_session)
   order by (r.phone is not null and right(regexp_replace(r.phone, '\D', '', 'g'), 9) = v_proof) desc,
            (r.checked_in_at is null) desc,
            (coalesce(s.status, '') in ('open', 'full')) desc,
            r.session_id desc nulls last
   limit 1;
  if v_row.id is null then return jsonb_build_object('ok', false, 'error', 'notfound'); end if;
  if v_row.phone is null or length(v_proof) < 9 or right(regexp_replace(v_row.phone, '\D', '', 'g'), 9) <> v_proof then
    return jsonb_build_object('ok', false, 'error', 'notfound');
  end if;
  if v_row.checked_in_at is not null then return jsonb_build_object('ok', false, 'error', 'checked_in'); end if;
  if exists (select 1 from rider_registrations r
              where r.booking_no = v_row.booking_no and coalesce(r.session_id, '') = coalesce(v_row.session_id, '')
                and r.checked_in_at is not null) then
    return jsonb_build_object('ok', false, 'error', 'checked_in');
  end if;
  v_sess_id := coalesce(p_session_id, v_row.session_id);
  if v_newkey = '' then return jsonb_build_object('ok', false, 'error', 'badge'); end if;
  if exists (select 1 from rider_registrations r
              where r.badge_key = v_newkey and coalesce(r.session_id,'') = coalesce(v_sess_id,'') and (r.booking_no is distinct from v_row.booking_no or coalesce(r.session_id, '') is distinct from coalesce(v_row.session_id, ''))) then
    return jsonb_build_object('ok', false, 'error', 'duplicate');
  end if;
  begin
    v_bno := v_row.booking_no;
    if coalesce(v_sess_id, '') <> coalesce(v_row.session_id, '') then
      insert into rider_night_counters(session_key, source, n) values (coalesce(v_sess_id, ''), coalesce(v_row.source, 'petromin'), 1)
        on conflict (session_key, source) do update set n = rider_night_counters.n + 1 returning n into v_seq;
      v_bno := upper(left(coalesce(v_row.source, 'petromin'), 1)) || '-' || lpad(v_seq::text, 3, '0');
    end if;
    perform set_config('mm.rider_proved', v_bno, true);
    update rider_registrations
       set badge = trim(p_badge), session_id = v_sess_id, booking_no = v_bno
     where booking_no = v_row.booking_no and coalesce(session_id, '') = coalesce(v_row.session_id, '');   -- the whole party moves together
    v_r := rider_register(p_badge, p_name, p_height, p_type, coalesce(v_row.source, 'petromin'), p_phone, v_sess_id, p_company, p_riders, p_waiver, p_lang => p_lang);
    perform set_config('mm.rider_proved', '', true);
    if not coalesce((v_r->>'ok')::boolean, false) then
      raise exception using errcode = 'MM001', message = v_r::text;
    end if;
  exception when sqlstate 'MM001' then
    perform set_config('mm.rider_proved', '', true);
    return sqlerrm::jsonb;
  end;
  return v_r;
end $function$;
revoke all on function public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text,text) from public;
grant execute on function public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text,text) to anon, authenticated, service_role;

-- ── 2. rider_sessions: the hand-out time and the place ────────────────────────────────────────────────────────────
-- bike_slots is text holding JSON; its _collect is read with a pattern, so a row whose JSON is broken still lists.
create or replace function public._rider_collect(s sessions) returns text
language sql immutable set search_path to 'public' as $$
  select substring(coalesce(s.bike_slots, '') from '"_collect"\s*:\s*"([0-9]{1,2}:[0-9]{2})"')
$$;
revoke all on function public._rider_collect(sessions) from public, anon, authenticated;

create or replace function public.rider_sessions(p_source text DEFAULT 'petromin'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_kind text := lower(regexp_replace(coalesce(p_source,''), '[^a-zA-Z0-9_-]', '', 'g'));
        v_today text := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'title', s.title,
             'start', to_char(w.starts_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
             'end',   to_char(w.ends_at   at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
             -- when bikes are handed out, and where (20261111030000)
             'collect', _rider_collect(s),
             'place', nullif(trim(coalesce(s.location, '')), '')
           ) order by s.session_date)
    from sessions s cross join lateral _session_window(s) w
    where s.ride_kind = v_kind and _rider_session_open(s) and s.session_date >= v_today and w.ends_at > now()
      and s.gender_only is null   -- one for men only or women only is never listed to everyone (20261027150000)
  ), '[]'::jsonb);
end $function$;

-- ── 3. rider_lookup: Find my booking ─────────────────────────────────────────────────────────────────────────────
create or replace function public.rider_lookup(p_booking_no text, p_phone text, p_session_id text default null)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_proof text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  v_no text := upper(trim(coalesce(p_booking_no, '')));
  v_row rider_registrations%rowtype;
  v_sess sessions%rowtype;
  v_start timestamptz; v_end timestamptz;
begin
  -- Twenty misses from one address in ten minutes lock it for ten more; a booking found never counts.
  if exists (select 1 from login_throttle where identifier = 'rlookup:' || _client_ip() and locked_until > now()) then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  if v_no <> '' and length(v_proof) = 9 then
    select r.* into v_row from rider_registrations r join sessions s on s.id = r.session_id
     where upper(r.booking_no) = v_no and r.party_no = 1
       and r.phone is not null and right(regexp_replace(r.phone, '\D', '', 'g'), 9) = v_proof
       and (p_session_id is null or r.session_id = p_session_id)
       -- tonight's or a later night's: a night over since yesterday is no longer shown
       and s.session_date >= to_char(now() at time zone 'Asia/Riyadh' - interval '1 day', 'YYYY-MM-DD')
     order by s.session_date, r.session_id
     limit 1;
  end if;
  if v_row.id is null then
    perform _ip_gate('rlookup', 20, interval '10 minutes');
    return jsonb_build_object('ok', false, 'error', 'notfound');
  end if;
  select * into v_sess from sessions where id = v_row.session_id;
  select w.starts_at, w.ends_at into v_start, v_end from _session_window(v_sess) w;
  return jsonb_build_object(
    'ok', true,
    'booking_no', v_row.booking_no,
    'company', v_row.company, 'badge', v_row.badge, 'name', v_row.name, 'phone', v_row.phone,
    'height', v_row.height, 'type', v_row.type_preference,
    'checked_in', exists (select 1 from rider_registrations r
                           where r.booking_no = v_row.booking_no and r.session_id = v_row.session_id and r.checked_in_at is not null),
    'session', jsonb_build_object(
      'id', v_sess.id, 'title', v_sess.title,
      'start', to_char(v_start at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
      'end',   to_char(v_end   at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
      'collect', _rider_collect(v_sess),
      'place', nullif(trim(coalesce(v_sess.location, '')), '')),
    'riders', coalesce((select jsonb_agg(jsonb_build_object('name', r.name, 'height', r.height, 'type', r.type_preference) order by r.party_no)
                          from rider_registrations r
                         where r.booking_no = v_row.booking_no and r.session_id = v_row.session_id and r.party_no > 1), '[]'::jsonb));
end $function$;
revoke all on function public.rider_lookup(text,text,text) from public;
grant execute on function public.rider_lookup(text,text,text) to anon, authenticated, service_role;

-- ── 4. rider_cancel: Cancel my booking ───────────────────────────────────────────────────────────────────────────
create or replace function public.rider_cancel(p_booking_no text, p_proof_phone text, p_session_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_proof text := right(regexp_replace(coalesce(p_proof_phone, ''), '\D', '', 'g'), 9);
  v_row rider_registrations%rowtype;
  v_sess sessions%rowtype;
  v_end timestamptz;
begin
  if not _rider_gate() then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if length(v_proof) = 9 and coalesce(p_session_id, '') <> '' then
    select r.* into v_row from rider_registrations r
     where upper(r.booking_no) = upper(trim(coalesce(p_booking_no, ''))) and r.party_no = 1
       and r.session_id = p_session_id
       and r.phone is not null and right(regexp_replace(r.phone, '\D', '', 'g'), 9) = v_proof
     limit 1;
  end if;
  if v_row.id is null then return jsonb_build_object('ok', false, 'error', 'notfound'); end if;
  if exists (select 1 from rider_registrations r
              where r.booking_no = v_row.booking_no and r.session_id = v_row.session_id and r.checked_in_at is not null) then
    return jsonb_build_object('ok', false, 'error', 'checked_in');
  end if;
  -- A party the desk tied to a booking of its own is the desk's to cancel: it holds a bike in the Queue.
  if exists (select 1 from rider_registrations r
              where r.booking_no = v_row.booking_no and r.session_id = v_row.session_id and r.matched_entry_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'desk');
  end if;
  select * into v_sess from sessions where id = v_row.session_id;
  select w.ends_at into v_end from _session_window(v_sess) w;
  if v_end is not null and v_end < now() then return jsonb_build_object('ok', false, 'error', 'session'); end if;
  delete from rider_registrations r where r.booking_no = v_row.booking_no and r.session_id = v_row.session_id;
  return jsonb_build_object('ok', true, 'booking_no', v_row.booking_no, 'session_id', v_row.session_id);
end $function$;
revoke all on function public.rider_cancel(text,text,text) from public;
grant execute on function public.rider_cancel(text,text,text) to anon, authenticated, service_role;

-- ── 5. form_step_counts: how far riders get ──────────────────────────────────────────────────────────────────────
create table if not exists public.form_step_counts (
  day   date     not null,
  form  text     not null,
  step  smallint not null,
  event text     not null,
  field text     not null default '',
  lang  text     not null default '',
  n     integer  not null default 0,
  primary key (day, form, step, event, field, lang)
);
comment on table public.form_step_counts is
  'Counts of what riders do on a registration form, per KSA day, step, event (view, error, done, fail), field and language. No person, device or address (20261111030000).';
alter table public.form_step_counts enable row level security;
revoke all on public.form_step_counts from public, anon, authenticated;
grant select on public.form_step_counts to authenticated;
drop policy if exists "staff read" on public.form_step_counts;
create policy "staff read" on public.form_step_counts for select to authenticated using ((select is_staff()));

create or replace function public.form_step(p_form text, p_step integer, p_event text, p_field text default '', p_lang text default '')
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- Only shapes the form sends are counted, so the table stays a few rows a day whatever arrives.
  if p_form is distinct from 'petromin' or p_step is null or p_step < 1 or p_step > 9
     or p_event is null or p_event not in ('view', 'error', 'done', 'fail', 'found', 'cancel') then return; end if;
  if coalesce(p_field, '') !~ '^[a-z_]{0,24}$' then p_field := ''; end if;
  if coalesce(p_lang, '') !~ '^[a-z]{2,3}$' then p_lang := ''; end if;
  insert into form_step_counts as c (day, form, step, event, field, lang, n)
  values ((now() at time zone 'Asia/Riyadh')::date, p_form, p_step, p_event, coalesce(p_field, ''), coalesce(p_lang, ''), 1)
  on conflict (day, form, step, event, field, lang) do update set n = c.n + 1;
end $function$;
revoke all on function public.form_step(text,integer,text,text,text) from public;
grant execute on function public.form_step(text,integer,text,text,text) to anon, authenticated, service_role;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111030000', 'petromin_form_round')
on conflict (version) do nothing;

commit;
