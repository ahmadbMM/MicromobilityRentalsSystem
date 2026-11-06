-- ============================================================================
-- Volunteers, the 2026-11-06 staff review (items VL01, VL03, VL05, VL06, VL07, VL09, VL10, VL14).
--
--  1. VL01: opening the portal's work page no longer undoes a check-out staff made, and no longer clocks anyone in
--     hours before the session: volunteer_enter clocks in the first arrival only from 30 minutes before the start time
--     staff gave the session (bike_slots._time), and never touches clock_out. The portal has an "I have arrived" button
--     (volunteer_arrive), which also brings back someone who finished by themselves; a check-out staff made stands
--     (VOL_CHECKED_OUT). volunteer_shifts.clock_out_by says who checked out: 'self' or 'staff'.
--  2. VL03: volunteer_log carries what staff did too: actor (the staffer's name), hours, and the staff_* actions. Every
--     staff_volunteer_* write logs, through _vol_slog.
--  3. VL05: accepting skips someone whose access has ended (counted as expired, and in skipped as before), and says how
--     many have not accepted the agreement yet (unagreed).
--  4. VL06: a person with live hours on a session cannot be taken off it (VOL_HAS_HOURS): cancel the hours first.
--  5. VL07: staff_volunteer_end ends a shift after its cut-off: everyone still on duty is checked out at the cut-off,
--     everyone accepted who never came is marked "did not come".
--  6. VL09: the setting noshow_stop: someone accepted automatically is asked like anyone else once they have that many
--     no-shows (volunteer_interest).
--  7. VL10: volunteer_sessions.role_needs [{name, needed}] (staff_volunteer_roles_save), shown with how many are filled
--     on the portal (volunteer_opportunities).
--  8. VL14: the Volunteer badge goes to whoever is given a session's hours, and the hours ladder Volunteer 10 / 25 / 50 /
--     100 to whoever reaches those hours (_vol_badges, from staff_volunteer_award and staff_volunteer_hours_add). The
--     answer names who reached a level (reached), so staff can say so.
--
-- Bodies copied from their latest definitions: 20261105120000 (volunteer_*, staff_volunteer_*), 20261105140000
-- (volunteer_enter's visitors count), 20261105180000 (staff_volunteer_session_save's phone and details). Each restates
-- SECURITY DEFINER and search_path.
--
-- Safe before or after the app: the staff page detects role_needs and the two new functions and falls back without them;
-- the portal shows "I have arrived" only when volunteer_enter says it has not clocked in.
--
-- Rollback: re-run the function bodies of 20261105120000 / 140000 / 180000; drop function public.volunteer_arrive(text,text,text),
-- public.staff_volunteer_end(text), public.staff_volunteer_roles_save(text,jsonb), public._vol_slog(text,text,text,numeric,text),
-- public._vol_badges(text,text,text), public._vol_session_start(text,text); restore volunteer_log_action_check of 20261105140000;
-- the new columns may stay. The badges given stay (delete from customer_badges where badge_id like 'bd_volunteer_%' to take them).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

/* -- columns ----------------------------------------------------------------------------------- */
alter table public.volunteer_log add column if not exists actor text check (char_length(actor) <= 120);
alter table public.volunteer_log add column if not exists hours numeric(6, 2);
alter table public.volunteer_log drop constraint if exists volunteer_log_action_check;
alter table public.volunteer_log add constraint volunteer_log_action_check
  check (action in ('enter', 'list', 'scan', 'search', 'checkin', 'uncheckin', 'donated', 'undonated', 'clock_in', 'clock_out', 'agree', 'interest', 'withdraw', 'role',
                    'arrive', 'staff_accept', 'staff_decline', 'staff_in', 'staff_out', 'staff_times', 'staff_status', 'staff_noshow', 'staff_remove',
                    'staff_award', 'staff_hours', 'staff_void', 'staff_save', 'staff_session', 'staff_end'));

alter table public.volunteer_shifts add column if not exists clock_out_by text check (clock_out_by in ('self', 'staff'));
-- Who finished the shifts already finished: the volunteer when they logged a clock_out, else staff.
update public.volunteer_shifts h set clock_out_by = case when exists (select 1 from public.volunteer_log l where l.customer_id = h.customer_id
                                                                         and l.session_id = h.session_id and l.action = 'clock_out') then 'self' else 'staff' end
 where h.clock_out is not null and h.clock_out_by is null;

alter table public.volunteer_sessions add column if not exists role_needs jsonb not null default '[]'::jsonb;
comment on column public.volunteer_sessions.role_needs is 'How many each role needs: [{name, needed}] (20261107130000). Roles without a number are only in roles.';


/* -- helpers ----------------------------------------------------------------------------------- */
-- A staff action in the log: who did it, on whom, and the hours when there are any.
create or replace function public._vol_slog(p_cust text, p_session text, p_action text, p_hours numeric default null, p_entry text default null)
 returns void
 language sql
 security definer
 set search_path to 'public'
as $function$
  insert into volunteer_log (customer_id, session_id, action, entry_id, actor, hours, user_id)
  values (p_cust, coalesce(p_session, ''), p_action, p_entry, left(coalesce(_vol_op(), 'staff'), 120), p_hours, auth.uid());
$function$;
revoke all on function public._vol_slog(text, text, text, numeric, text) from public, anon, authenticated;

-- The session's start as staff typed it ("17:00 - 23:00", "6:45 PM"), in Saudi time; null when there is none.
create or replace function public._vol_session_start(p_date text, p_slots text)
 returns timestamptz
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare m text[]; _h int;
begin
  if coalesce(p_date, '') !~ '^\d{4}-\d{2}-\d{2}' then return null; end if;
  m := regexp_match(coalesce(_vol_time(p_slots), ''), '(\d{1,2})[:.](\d{2})\s*([AaPp][Mm])?');
  if m is null then return null; end if;
  _h := m[1]::int;
  if m[3] is not null then _h := _h % 12 + case when lower(m[3]) = 'pm' then 12 else 0 end; end if;
  if _h > 23 or m[2]::int > 59 then return null; end if;
  return (left(p_date, 10) || ' ' || lpad(_h::text, 2, '0') || ':' || m[2] || ':00+03')::timestamptz;
end $function$;
revoke all on function public._vol_session_start(text, text) from public, anon, authenticated;

-- The Volunteer badge for a session's hours, and the hours ladder. Answers the highest level newly reached (0: none).
create or replace function public._vol_badges(p_cust text, p_session text, p_op text)
 returns int
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _tot numeric; _top int := 0; L int; _id text;
begin
  if p_session is not null and exists (select 1 from badges b where b.id = 'bd_volunteer') then
    insert into customer_badges (customer_id, badge_id, session_id, awarded_by)
    values (p_cust, 'bd_volunteer', p_session, left(coalesce(p_op, 'staff'), 60))
    on conflict do nothing;
  end if;
  select coalesce(c.volunteer_hours, 0) into _tot from customers c where c.id = p_cust;
  foreach L in array array[10, 25, 50, 100] loop
    exit when coalesce(_tot, 0) < L;
    _id := 'bd_volunteer_' || L;
    continue when not exists (select 1 from badges b where b.id = _id);
    insert into customer_badges (customer_id, badge_id, session_id, awarded_by)
    values (p_cust, _id, p_session, left(coalesce(p_op, 'staff'), 60))
    on conflict do nothing;
    if found then _top := L; end if;
  end loop;
  return _top;
end $function$;
revoke all on function public._vol_badges(text, text, text) from public, anon, authenticated;

-- The hours ladder: levels of the Volunteer badge (the app folds them into one tile, BDG_LADDERS).
insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort) values
  ('bd_volunteer_10',  'volunteer_10',  'hand', 'teal',   'Volunteer 10',  'متطوع 10',  'Give 10 hours as a volunteer.',  'تطوّع 10 ساعات.',  true, false, 82),
  ('bd_volunteer_25',  'volunteer_25',  'hand', 'purple', 'Volunteer 25',  'متطوع 25',  'Give 25 hours as a volunteer.',  'تطوّع 25 ساعة.',   true, false, 83),
  ('bd_volunteer_50',  'volunteer_50',  'hand', 'gold',   'Volunteer 50',  'متطوع 50',  'Give 50 hours as a volunteer.',  'تطوّع 50 ساعة.',   true, false, 84),
  ('bd_volunteer_100', 'volunteer_100', 'hand', 'blue',   'Volunteer 100', 'متطوع 100', 'Give 100 hours as a volunteer.', 'تطوّع 100 ساعة.',  true, false, 85)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = false, retired = false, sort = excluded.sort;


/* -- the portal -------------------------------------------------------------------------------- */
-- What anyone signed in may read: the opportunities, now with each role's need and how many are on it.
create or replace function public.volunteer_opportunities()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'title', s.title, 'ride_kind', s.ride_kind, 'event_kind', s.event_kind, 'date', s.session_date,
           'day', s.day, 'time', _vol_time(s.bike_slots),
           'location', case when s.reveal_at is null or s.reveal_at <= now() then s.location end, -- as list_sessions
           'about', w.about, 'needed', w.needed, 'roles', w.roles, 'min_age', w.min_age,
           'hours_mode', w.hours_mode, 'fixed_hours', w.fixed_hours, 'signup_open', w.signup_open,
           'opens_at', w.opens_at, 'closes_at', w.closes_at,
           'accepted', (select count(*) from volunteer_shifts x where x.session_id = w.session_id and x.status in ('accepted', 'done')),
           'role_needs', (select coalesce(jsonb_agg(jsonb_build_object('name', e ->> 'name', 'needed', (e ->> 'needed')::int,
                            'filled', (select count(*) from volunteer_shifts x where x.session_id = w.session_id and x.status in ('accepted', 'done') and x.role = e ->> 'name'))), '[]'::jsonb)
                            from jsonb_array_elements(w.role_needs) e)
         ) order by s.session_date, s.id), '[]'::jsonb)
    from volunteer_sessions w join sessions s on s.id = w.session_id
   where w.enabled and now() < w.closes_at and s.cancelled_at is null;
$function$;

-- Registering interest. A trusted volunteer is accepted by itself, unless they have reached the no-show limit staff set.
create or replace function public.volunteer_interest(p_id text, p_token text, p_session text, p_on boolean, p_role text default null, p_message text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare w volunteer_sessions%rowtype; sh volunteer_shifts%rowtype; v volunteers%rowtype; c record; _st text; _day text; _stop int; _auto boolean;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  select x.must_change_pwd, x.deletion_requested_at, x.birth_date into c from customers x where x.id = p_id;
  if coalesce(c.must_change_pwd, false) or c.deletion_requested_at is not null then raise exception 'VOL_ACCOUNT' using errcode = '42501'; end if;
  select * into v from volunteers where customer_id = p_id;
  if found and (v.status in ('paused', 'removed') or (v.expires_on is not null and v.expires_on < _vol_today())) then
    raise exception 'VOL_NOT_VOLUNTEER' using errcode = '42501';
  end if;
  select * into w from volunteer_sessions where session_id = p_session;
  if not found or not w.enabled or now() >= w.closes_at
     or exists (select 1 from sessions x where x.id = p_session and x.cancelled_at is not null) then
    raise exception 'VOL_CLOSED' using errcode = '42501';
  end if;
  select * into sh from volunteer_shifts where session_id = p_session and customer_id = p_id for update;
  if found and sh.status = 'blocked' then raise exception 'VOL_NOT_ACCEPTED' using errcode = '42501'; end if;

  if not coalesce(p_on, false) then
    if sh.id is null or sh.status = 'withdrawn' then return jsonb_build_object('ok', true, 'noop', true, 'status', 'withdrawn'); end if;
    if sh.clock_in is not null then raise exception 'VOL_ALREADY_IN' using errcode = 'P0001'; end if;
    -- Staff's answer stands: withdrawing and asking again must not wipe a decline or a no-show.
    if sh.status in ('declined', 'no_show', 'done') then raise exception 'VOL_DECLINED' using errcode = 'P0001'; end if;
    update volunteer_shifts set status = 'withdrawn', updated_at = now() where id = sh.id;
    perform _vol_log(p_id, p_session, 'withdraw');
    return jsonb_build_object('ok', true, 'status', 'withdrawn');
  end if;

  if sh.id is not null and sh.status in ('interested', 'accepted', 'done') then return jsonb_build_object('ok', true, 'noop', true, 'status', sh.status); end if;
  if sh.id is not null and sh.status in ('declined', 'no_show') then raise exception 'VOL_DECLINED' using errcode = 'P0001'; end if;
  if not w.signup_open then raise exception 'VOL_SIGNUP_CLOSED' using errcode = 'P0001'; end if;
  if w.min_age is not null then
    if coalesce(c.birth_date, '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'VOL_DOB' using errcode = 'P0001'; end if;
    select x.session_date into _day from sessions x where x.id = p_session;
    if c.birth_date::date + make_interval(years => w.min_age) > coalesce(_day::date, _vol_today()) then raise exception 'VOL_AGE' using errcode = 'P0001'; end if;
  end if;
  insert into volunteers (customer_id, status, applied_at) values (p_id, 'applied', now())
  on conflict (customer_id) do nothing;
  _stop := coalesce(nullif(_vol_settings() ->> 'noshow_stop', '')::numeric, 0)::int;
  _auto := coalesce(v.auto_accept, false) and v.status = 'active'
           and not (_stop > 0 and (select count(*) from volunteer_shifts x where x.customer_id = p_id and x.status = 'no_show') >= _stop);
  _st := case when _auto then 'accepted' else 'interested' end;
  insert into volunteer_shifts (session_id, customer_id, status, pref_role, message, decided_at, decided_by)
  values (p_session, p_id, _st, nullif(left(btrim(coalesce(p_role, '')), 40), ''), nullif(left(btrim(coalesce(p_message, '')), 300), ''),
          case when _st = 'accepted' then now() end, case when _st = 'accepted' then 'auto' end)
  on conflict (session_id, customer_id) do update set status = excluded.status, pref_role = excluded.pref_role, message = excluded.message,
    decided_at = excluded.decided_at, decided_by = excluded.decided_by, updated_at = now();
  perform _vol_log(p_id, p_session, 'interest');
  return jsonb_build_object('ok', true, 'status', _st);
end $function$;

-- Opening the work page: the gate and the session's counts. The first arrival is clocked in only from 30 minutes before
-- the session's start, and a check-out is never undone here (VL01): "I have arrived" is volunteer_arrive.
create or replace function public.volunteer_enter(p_id text, p_token text, p_session text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare w volunteer_sessions%rowtype; sh volunteer_shifts%rowtype; _n record; s record; _start timestamptz;
begin
  w := _vol_gate(p_id, p_token, p_session);
  perform _vol_log(p_id, p_session, 'enter');
  select * into sh from volunteer_shifts where session_id = p_session and customer_id = p_id for update;
  select x.session_date, x.bike_slots into s from sessions x where x.id = p_session;
  _start := _vol_session_start(s.session_date, s.bike_slots);
  if sh.clock_in is null and sh.clock_out is null and _start is not null and now() >= _start - interval '30 minutes' then
    update volunteer_shifts set clock_in = now(), updated_at = now() where id = sh.id returning * into sh;
    perform _vol_log(p_id, p_session, 'clock_in');
  end if;
  select count(*) filter (where q.status in ('waiting', 'waitlist', 'active', 'done')) booked,
         count(*) filter (where q.status in ('active', 'done')) arrived,
         count(*) filter (where q.donated_at is not null) donated,
         count(*) filter (where q.status in ('waiting', 'waitlist', 'active', 'done') and q.blood_role = 'visitor') visitors
    into _n from queue_entries q where q.session_id = p_session;
  return jsonb_build_object('ok', true, 'closes_at', w.closes_at, 'caps', w.caps, 'briefing', w.briefing, 'hours_mode', w.hours_mode,
    'clock_in', sh.clock_in, 'clock_out', sh.clock_out, 'clock_out_by', sh.clock_out_by, 'starts_at', _start, 'role', sh.role,
    'counts', case when coalesce((w.caps ->> 'counts')::boolean, false) then jsonb_build_object('booked', _n.booked, 'in', _n.arrived, 'donated', _n.donated, 'visitors', _n.visitors) end,
    'mine', (select count(*) filter (where l.action = 'checkin') - count(*) filter (where l.action = 'uncheckin')
               from volunteer_log l where l.customer_id = p_id and l.session_id = p_session));
end $function$;

-- "I have arrived": clocks in, or brings back someone who finished by themselves. A check-out staff made stands.
create or replace function public.volunteer_arrive(p_id text, p_token text, p_session text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare w volunteer_sessions%rowtype; sh volunteer_shifts%rowtype;
begin
  w := _vol_gate(p_id, p_token, p_session);
  select * into sh from volunteer_shifts where session_id = p_session and customer_id = p_id for update;
  if sh.clock_out is not null then
    if coalesce(sh.clock_out_by, 'staff') <> 'self' then raise exception 'VOL_CHECKED_OUT' using errcode = 'P0001'; end if;
    update volunteer_shifts set clock_out = null, clock_out_by = null, updated_at = now() where id = sh.id returning * into sh;
    perform _vol_log(p_id, p_session, 'clock_in');
  elsif sh.clock_in is null then
    update volunteer_shifts set clock_in = now(), updated_at = now() where id = sh.id returning * into sh;
    perform _vol_log(p_id, p_session, 'arrive');
  else
    return jsonb_build_object('ok', true, 'noop', true, 'clock_in', sh.clock_in);
  end if;
  return jsonb_build_object('ok', true, 'clock_in', sh.clock_in, 'clock_out', sh.clock_out);
end $function$;

-- Leaving: works after the cut-off too, so the last person out can still say so. Hours are staff's to award.
create or replace function public.volunteer_clock_out(p_id text, p_token text, p_session text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  update volunteer_shifts set clock_out = now(), clock_out_by = 'self', updated_at = now()
   where session_id = p_session and customer_id = p_id and clock_in is not null and clock_out is null;
  if found then perform _vol_log(p_id, p_session, 'clock_out'); end if;
  return jsonb_build_object('ok', true);
end $function$;


/* -- the section's writes, each in the log ------------------------------------------------------- */
create or replace function public.staff_volunteer_save(p_customer text, p_status text default null, p_tags text[] default null,
                                                       p_notes text default null, p_shirt text default null, p_expires date default null,
                                                       p_clear_expiry boolean default false, p_auto_accept boolean default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _tags text[];
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_status is not null and p_status not in ('applied', 'active', 'paused', 'removed') then raise exception 'BAD_STATUS' using errcode = '22023'; end if;
  if not exists (select 1 from customers c where c.id = p_customer and c.merged_into is null) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  _tags := case when p_tags is null then null else
    array(select distinct left(btrim(t), 30) from unnest(p_tags) t where btrim(t) <> '' limit 30) end;
  insert into volunteers (customer_id, status, auto_accept, tags, notes, shirt, expires_on, decided_at, decided_by)
  values (p_customer, coalesce(p_status, 'active'), coalesce(p_auto_accept, false), coalesce(_tags, '{}'), nullif(btrim(coalesce(p_notes, '')), ''), nullif(btrim(coalesce(p_shirt, '')), ''), p_expires, now(), _vol_op())
  on conflict (customer_id) do update set
    status = coalesce(p_status, volunteers.status),
    auto_accept = coalesce(p_auto_accept, volunteers.auto_accept),
    tags = coalesce(_tags, volunteers.tags),
    notes = case when p_notes is null then volunteers.notes else nullif(btrim(p_notes), '') end,
    shirt = case when p_shirt is null then volunteers.shirt else nullif(btrim(p_shirt), '') end,
    expires_on = case when p_clear_expiry then null else coalesce(p_expires, volunteers.expires_on) end,
    decided_at = case when p_status is distinct from volunteers.status and p_status is not null then now() else volunteers.decided_at end,
    decided_by = case when p_status is distinct from volunteers.status and p_status is not null then _vol_op() else volunteers.decided_by end,
    updated_at = now();
  perform _vol_slog(p_customer, null, 'staff_save');
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.staff_volunteers_bulk(p_ids text[], p_status text default null, p_add_tag text default null, p_remove_tag text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _n int;
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_status is not null and p_status not in ('applied', 'active', 'paused', 'removed') then raise exception 'BAD_STATUS' using errcode = '22023'; end if;
  update volunteers v set
    status = coalesce(p_status, v.status),
    tags = array(select distinct t from unnest(array_remove(v.tags, p_remove_tag) || case when nullif(btrim(coalesce(p_add_tag, '')), '') is null then '{}'::text[] else array[left(btrim(p_add_tag), 30)] end) t),
    decided_at = case when p_status is distinct from v.status and p_status is not null then now() else v.decided_at end,
    decided_by = case when p_status is distinct from v.status and p_status is not null then _vol_op() else v.decided_by end,
    updated_at = now()
   where v.customer_id = any(p_ids);
  get diagnostics _n = row_count;
  insert into volunteer_log (customer_id, session_id, action, actor, user_id)
  select v.customer_id, '', 'staff_save', left(coalesce(_vol_op(), 'staff'), 120), auth.uid() from volunteers v where v.customer_id = any(p_ids);
  return jsonb_build_object('ok', true, 'n', _n);
end $function$;

-- Hours: anyone who edits Volunteers or Accounts. Taking hours off may not leave the account below zero.
create or replace function public.staff_volunteer_hours_add(p_customer text, p_hours numeric, p_on date default null, p_session text default null, p_note text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _h numeric := round(coalesce(p_hours, 0), 2); _id bigint; _tot numeric; _lvl int := 0;
begin
  if not ((select _staff_mod('volunteers', true)) or (select _staff_mod('customers', true))) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if _h = 0 or abs(_h) > 500 then raise exception 'BAD_HOURS' using errcode = '22023'; end if;
  perform 1 from customers c where c.id = p_customer and c.merged_into is null for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_session is not null and not exists (select 1 from sessions s where s.id = p_session) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_on is not null and p_on > _vol_today() then raise exception 'BAD_DATE' using errcode = '22023'; end if;
  select coalesce(c.volunteer_hours, 0) into _tot from customers c where c.id = p_customer;
  if _tot + _h < 0 then raise exception 'VOL_HOURS_NEGATIVE' using errcode = 'P0001'; end if;
  insert into volunteer_hours (customer_id, session_id, hours, worked_on, source, note, added_by, added_uid)
  values (p_customer, p_session, _h, coalesce(p_on, _vol_today()), 'staff', nullif(left(btrim(coalesce(p_note, '')), 300), ''), _vol_op(), auth.uid())
  returning id into _id;
  perform _vol_slog(p_customer, p_session, 'staff_hours', _h);
  if _h > 0 then _lvl := _vol_badges(p_customer, null, _vol_op()); end if;
  return jsonb_build_object('ok', true, 'id', _id, 'total', _tot + _h, 'reached', _lvl);
end $function$;

create or replace function public.staff_volunteer_hours_void(p_id bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare h volunteer_hours%rowtype; _tot numeric;
begin
  if not ((select _staff_mod('volunteers', true)) or (select _staff_mod('customers', true))) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into h from volunteer_hours where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if h.voided_at is not null then return jsonb_build_object('ok', true, 'noop', true); end if;
  select coalesce(c.volunteer_hours, 0) into _tot from customers c where c.id = h.customer_id for update;
  if _tot - h.hours < 0 then raise exception 'VOL_HOURS_NEGATIVE' using errcode = 'P0001'; end if;
  update volunteer_hours set voided_at = now(), voided_by = _vol_op() where id = p_id;
  perform _vol_slog(h.customer_id, h.session_id, 'staff_void', h.hours);
  return jsonb_build_object('ok', true, 'total', _tot - h.hours);
end $function$;

-- The switch and everything under it. Whoever edits Volunteers or Bookings (the session form).
create or replace function public.staff_volunteer_session_save(p_session text, p_enabled boolean, p_closes timestamptz default null, p_opens timestamptz default null,
                                                               p_needed int default null, p_about text default null, p_briefing text default null,
                                                               p_signup_open boolean default true, p_caps jsonb default null, p_hours_mode text default 'clock',
                                                               p_fixed_hours numeric default null, p_roles text[] default null, p_min_age int default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _caps jsonb;
begin
  if not ((select _staff_mod('volunteers', true)) or (select _staff_mod('queue', true))) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not exists (select 1 from sessions s where s.id = p_session) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not coalesce(p_enabled, false) then
    update volunteer_sessions set enabled = false, updated_at = now(), updated_by = _vol_op() where session_id = p_session;
    if found then perform _vol_slog(null, p_session, 'staff_session'); end if;
    return jsonb_build_object('ok', true, 'enabled', false);
  end if;
  if p_closes is null then raise exception 'VOL_CUTOFF_REQUIRED' using errcode = '22023'; end if;
  if p_opens is not null and p_opens >= p_closes then raise exception 'VOL_CUTOFF_BEFORE_OPEN' using errcode = '22023'; end if;
  if p_hours_mode not in ('clock', 'fixed', 'none') then raise exception 'BAD_HOURS_MODE' using errcode = '22023'; end if;
  if p_hours_mode = 'fixed' and (p_fixed_hours is null or p_fixed_hours <= 0 or p_fixed_hours > 24) then raise exception 'BAD_HOURS' using errcode = '22023'; end if;
  _caps := jsonb_build_object(
    'checkin', coalesce((p_caps ->> 'checkin')::boolean, true), 'undo', coalesce((p_caps ->> 'undo')::boolean, true),
    'donated', coalesce((p_caps ->> 'donated')::boolean, true), 'list', coalesce((p_caps ->> 'list')::boolean, false),
    'counts', coalesce((p_caps ->> 'counts')::boolean, true),
    'phone', coalesce((p_caps ->> 'phone')::boolean, (select (x.caps ->> 'phone')::boolean from volunteer_sessions x where x.session_id = p_session), false),
    'details', coalesce((p_caps ->> 'details')::boolean, (select (x.caps ->> 'details')::boolean from volunteer_sessions x where x.session_id = p_session), false));
  insert into volunteer_sessions (session_id, enabled, opens_at, closes_at, needed, about, briefing, signup_open, caps, hours_mode, fixed_hours, roles, min_age, updated_at, updated_by)
  values (p_session, true, p_opens, p_closes, p_needed, nullif(left(btrim(coalesce(p_about, '')), 2000), ''), nullif(left(btrim(coalesce(p_briefing, '')), 2000), ''), coalesce(p_signup_open, true), _caps,
          p_hours_mode, case when p_hours_mode = 'fixed' then p_fixed_hours end, coalesce(array(select left(btrim(r), 40) from unnest(p_roles) r where btrim(r) <> '' limit 20), '{}'), p_min_age, now(), _vol_op())
  on conflict (session_id) do update set enabled = true, opens_at = excluded.opens_at, closes_at = excluded.closes_at, needed = excluded.needed,
    about = excluded.about, briefing = excluded.briefing, signup_open = excluded.signup_open, caps = excluded.caps, hours_mode = excluded.hours_mode,
    fixed_hours = excluded.fixed_hours, roles = excluded.roles, min_age = excluded.min_age, updated_at = now(), updated_by = excluded.updated_by;
  perform _vol_slog(null, p_session, 'staff_session');
  return jsonb_build_object('ok', true, 'enabled', true);
end $function$;

-- How many each role needs: [{name, needed}], up to 20 roles.
create or replace function public.staff_volunteer_roles_save(p_session text, p_needs jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not ((select _staff_mod('volunteers', true)) or (select _staff_mod('queue', true))) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_needs, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_needs, '[]'::jsonb)) > 20 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  update volunteer_sessions set role_needs = coalesce((
      select jsonb_agg(jsonb_build_object('name', left(btrim(e ->> 'name'), 40), 'needed', (e ->> 'needed')::int))
        from jsonb_array_elements(coalesce(p_needs, '[]'::jsonb)) e
       where btrim(coalesce(e ->> 'name', '')) <> '' and coalesce(e ->> 'needed', '') ~ '^\d{1,4}$' and (e ->> 'needed')::int between 1 and 1000), '[]'::jsonb),
    updated_at = now(), updated_by = _vol_op()
   where session_id = p_session;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true);
end $function$;

-- Accepting or declining: one person or everyone at once. Someone paused or removed is skipped, someone whose access has
-- ended too (expired, also counted in skipped). unagreed: how many accepted have not accepted the agreement yet.
create or replace function public.staff_volunteer_decide(p_session text, p_customers text[], p_status text, p_role text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _c text; _n int := 0; _skip int := 0; _exp int := 0; _unag int := 0; _op text := _vol_op(); v volunteers%rowtype; _av text := _vol_agreement_v();
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_status not in ('accepted', 'declined') then raise exception 'BAD_STATUS' using errcode = '22023'; end if;
  if not exists (select 1 from volunteer_sessions w where w.session_id = p_session) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  foreach _c in array coalesce(p_customers, '{}') loop
    v := null;
    select * into v from volunteers x where x.customer_id = _c for update;
    if v.status is null and not exists (select 1 from customers c where c.id = _c and c.merged_into is null) then _skip := _skip + 1; continue; end if;
    if p_status = 'accepted' and v.status in ('paused', 'removed') then _skip := _skip + 1; continue; end if;
    if p_status = 'accepted' and v.expires_on is not null and v.expires_on < _vol_today() then _exp := _exp + 1; continue; end if;
    if p_status = 'accepted' and v.agreed_version is distinct from _av then _unag := _unag + 1; end if;
    if p_status = 'accepted' then
      insert into volunteers (customer_id, status, decided_at, decided_by) values (_c, 'active', now(), _op)
      on conflict (customer_id) do update set status = 'active', decided_at = now(), decided_by = _op, updated_at = now()
        where volunteers.status = 'applied';
    end if;
    insert into volunteer_shifts (session_id, customer_id, status, role, decided_at, decided_by, updated_by)
    values (p_session, _c, p_status, nullif(left(btrim(coalesce(p_role, '')), 40), ''), now(), _op, _op)
    on conflict (session_id, customer_id) do update set status = p_status,
      role = case when p_role is null then volunteer_shifts.role else excluded.role end,
      decided_at = now(), decided_by = _op, updated_at = now(), updated_by = _op
      where volunteer_shifts.clock_in is null or p_status = 'accepted';
    perform _vol_slog(_c, p_session, case when p_status = 'accepted' then 'staff_accept' else 'staff_decline' end);
    _n := _n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'n', _n, 'skipped', _skip + _exp, 'expired', _exp, 'unagreed', _unag);
end $function$;

-- Everything else about one person on one session. p_status null takes the row away, unless they already clocked in or
-- have hours for the session (VOL_HAS_HOURS: cancel those first).
create or replace function public.staff_volunteer_shift_save(p_session text, p_customer text, p_status text, p_role text default null, p_note text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _old text; _n int;
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_status is null then
    if exists (select 1 from volunteer_hours h where h.session_id = p_session and h.customer_id = p_customer and h.voided_at is null) then
      raise exception 'VOL_HAS_HOURS' using errcode = 'P0001';
    end if;
    delete from volunteer_shifts where session_id = p_session and customer_id = p_customer and clock_in is null;
    get diagnostics _n = row_count;
    if _n = 0 and exists (select 1 from volunteer_shifts where session_id = p_session and customer_id = p_customer) then
      raise exception 'VOL_ALREADY_IN' using errcode = 'P0001';
    end if;
    if _n > 0 then perform _vol_slog(p_customer, p_session, 'staff_remove'); end if;
    return jsonb_build_object('ok', true);
  end if;
  if p_status not in ('interested', 'accepted', 'declined', 'withdrawn', 'blocked', 'no_show', 'done') then raise exception 'BAD_STATUS' using errcode = '22023'; end if;
  if not exists (select 1 from volunteers v where v.customer_id = p_customer) then raise exception 'VOL_NOT_VOLUNTEER' using errcode = 'P0001'; end if;
  select x.status into _old from volunteer_shifts x where x.session_id = p_session and x.customer_id = p_customer;
  insert into volunteer_shifts (session_id, customer_id, status, role, note, updated_by)
  values (p_session, p_customer, p_status, nullif(left(btrim(coalesce(p_role, '')), 40), ''), nullif(left(btrim(coalesce(p_note, '')), 300), ''), _vol_op())
  on conflict (session_id, customer_id) do update set status = excluded.status,
    role = case when p_role is null then volunteer_shifts.role else excluded.role end,
    note = case when p_note is null then volunteer_shifts.note else excluded.note end,
    updated_at = now(), updated_by = excluded.updated_by;
  if _old is distinct from p_status then perform _vol_slog(p_customer, p_session, case when p_status = 'no_show' then 'staff_noshow' else 'staff_status' end); end if;
  return jsonb_build_object('ok', true);
end $function$;

-- Staff correct the clock. A check-out staff make is theirs: the portal cannot undo it.
create or replace function public.staff_volunteer_shift_times(p_session text, p_customer text, p_in timestamptz, p_out timestamptz)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare sh volunteer_shifts%rowtype;
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_in is not null and p_out is not null and p_out <= p_in then raise exception 'BAD_TIMES' using errcode = '22023'; end if;
  select * into sh from volunteer_shifts where session_id = p_session and customer_id = p_customer for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  update volunteer_shifts set clock_in = p_in, clock_out = p_out,
         clock_out_by = case when p_out is null then null when p_out is not distinct from sh.clock_out then sh.clock_out_by else 'staff' end,
         updated_at = now(), updated_by = _vol_op()
   where id = sh.id;
  if sh.clock_in is distinct from p_in or sh.clock_out is distinct from p_out then
    perform _vol_slog(p_customer, p_session,
      case when sh.clock_in is null and p_in is not null and p_out is null then 'staff_in'
           when sh.clock_out is null and p_out is not null and p_in is not distinct from sh.clock_in then 'staff_out'
           else 'staff_times' end);
  end if;
  return jsonb_build_object('ok', true);
end $function$;

-- Hours for a session's people, in one go: [{customer_id, hours}]. One award per person per session; a second is skipped.
-- The Volunteer badge and the hours ladder follow (reached: [{customer_id, hours}] for each level newly reached).
create or replace function public.staff_volunteer_award(p_session text, p_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r jsonb; _h numeric; _c text; _on date; _add int := 0; _skip int := 0; _op text := _vol_op(); _lvl int; _reached jsonb := '[]'::jsonb;
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  select least(case when s.session_date ~ '^\d{4}-\d{2}-\d{2}$' then s.session_date::date end, _vol_today()) into _on from sessions s where s.id = p_session;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    _c := r ->> 'customer_id';
    _h := round(coalesce((r ->> 'hours')::numeric, 0), 2);
    if _h <= 0 or _h > 24 then raise exception 'BAD_HOURS' using errcode = '22023'; end if;
    if not exists (select 1 from customers c where c.id = _c and c.merged_into is null) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if exists (select 1 from volunteer_hours h where h.session_id = p_session and h.customer_id = _c and h.source = 'session' and h.voided_at is null) then
      _skip := _skip + 1;
      continue;
    end if;
    insert into volunteer_hours (customer_id, session_id, hours, worked_on, source, added_by, added_uid)
    values (_c, p_session, _h, coalesce(_on, _vol_today()), 'session', _op, auth.uid());
    insert into volunteer_shifts (session_id, customer_id, status, updated_by) values (p_session, _c, 'done', _op)
    on conflict (session_id, customer_id) do update set status = 'done', updated_at = now(), updated_by = _op;
    perform _vol_slog(_c, p_session, 'staff_award', _h);
    _lvl := _vol_badges(_c, p_session, _op);
    if _lvl > 0 then _reached := _reached || jsonb_build_array(jsonb_build_object('customer_id', _c, 'hours', _lvl)); end if;
    _add := _add + 1;
  end loop;
  return jsonb_build_object('ok', true, 'added', _add, 'skipped', _skip, 'reached', _reached);
end $function$;

-- End the shift (after its cut-off): everyone still on duty out at the cut-off, everyone accepted who never came "did not
-- come". Changes nothing before the cut-off.
create or replace function public.staff_volunteer_end(p_session text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare w volunteer_sessions%rowtype; _out int := 0; _ns int := 0; _op text := left(coalesce(_vol_op(), 'staff'), 120);
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into w from volunteer_sessions where session_id = p_session;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if now() < w.closes_at then raise exception 'VOL_NOT_ENDED' using errcode = 'P0001'; end if;
  with u as (update volunteer_shifts set clock_out = greatest(w.closes_at, clock_in + interval '1 minute'), clock_out_by = 'staff', updated_at = now(), updated_by = _op
              where session_id = p_session and clock_in is not null and clock_out is null returning customer_id)
  insert into volunteer_log (customer_id, session_id, action, actor, user_id) select u.customer_id, p_session, 'staff_out', _op, auth.uid() from u;
  get diagnostics _out = row_count;
  with u as (update volunteer_shifts set status = 'no_show', updated_at = now(), updated_by = _op
              where session_id = p_session and status = 'accepted' and clock_in is null returning customer_id)
  insert into volunteer_log (customer_id, session_id, action, actor, user_id) select u.customer_id, p_session, 'staff_noshow', _op, auth.uid() from u;
  get diagnostics _ns = row_count;
  perform _vol_slog(null, p_session, 'staff_end');
  return jsonb_build_object('ok', true, 'out', _out, 'no_show', _ns);
end $function$;

-- The section's settings. Only the known keys, within their shapes. noshow_stop: VL09.
create or replace function public.staff_volunteer_settings_save(p_data jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _d jsonb := '{}'::jsonb; k text;
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if jsonb_typeof(p_data) <> 'object' or length(p_data::text) > 8000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  foreach k in array array['promote', 'agreement_v', 'cut_after_min', 'caps', 'hours_mode', 'fixed_hours', 'milestones',
                           'roles', 'tags', 'cert_signer', 'cert_title', 'wa_tpl', 'needed', 'noshow_stop'] loop
    if p_data ? k then _d := _d || jsonb_build_object(k, p_data -> k); end if;
  end loop;
  update volunteer_settings set data = data || _d, updated_at = now(), updated_by = _vol_op() where id = 1;
  return jsonb_build_object('ok', true);
end $function$;

do $do$
declare f text;
begin
  foreach f in array array['volunteer_opportunities()', 'volunteer_interest(text,text,text,boolean,text,text)', 'volunteer_enter(text,text,text)',
                           'volunteer_arrive(text,text,text)', 'volunteer_clock_out(text,text,text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  foreach f in array array['staff_volunteer_save(text,text,text[],text,text,date,boolean,boolean)', 'staff_volunteers_bulk(text[],text,text,text)', 'staff_volunteer_decide(text,text[],text,text)',
                           'staff_volunteer_hours_add(text,numeric,date,text,text)', 'staff_volunteer_hours_void(bigint)',
                           'staff_volunteer_session_save(text,boolean,timestamptz,timestamptz,integer,text,text,boolean,jsonb,text,numeric,text[],integer)',
                           'staff_volunteer_roles_save(text,jsonb)', 'staff_volunteer_end(text)',
                           'staff_volunteer_shift_save(text,text,text,text,text)', 'staff_volunteer_shift_times(text,text,timestamptz,timestamptz)',
                           'staff_volunteer_award(text,jsonb)', 'staff_volunteer_settings_save(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $do$;

do $chk$
begin
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef and proconfig is not null
        and proname in ('volunteer_enter', 'volunteer_arrive', 'volunteer_clock_out', 'volunteer_interest', 'volunteer_opportunities',
                        'staff_volunteer_save', 'staff_volunteers_bulk', 'staff_volunteer_hours_add', 'staff_volunteer_hours_void',
                        'staff_volunteer_session_save', 'staff_volunteer_roles_save', 'staff_volunteer_decide', 'staff_volunteer_shift_save',
                        'staff_volunteer_shift_times', 'staff_volunteer_award', 'staff_volunteer_end', 'staff_volunteer_settings_save',
                        '_vol_slog', '_vol_badges')) <> 19 then
    raise exception 'a volunteer function lost SECURITY DEFINER or its search_path';
  end if;
  if pg_get_functiondef('public.volunteer_enter(text,text,text)'::regprocedure) like '%clock_out = null%' then
    raise exception 'volunteer_enter still undoes a check-out';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261107130000', 'volunteers_review')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- Check (read only): the new columns, the functions' attributes, the ladder's four badges, the ledger row.
select (select count(*) from information_schema.columns where table_schema = 'public'
          and (table_name, column_name) in (('volunteer_log', 'actor'), ('volunteer_log', 'hours'), ('volunteer_shifts', 'clock_out_by'), ('volunteer_sessions', 'role_needs'))) as columns_4,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
          and proname in ('volunteer_arrive', 'staff_volunteer_end', 'staff_volunteer_roles_save')) as new_definer_3,
       (select count(*) from public.badges where slug in ('volunteer_10', 'volunteer_25', 'volunteer_50', 'volunteer_100') and not retired) as ladder_4,
       (select count(*) from public.volunteer_shifts where clock_out is not null and clock_out_by is null) as unknown_checkouts_0,
       (select version from supabase_migrations.schema_migrations where version = '20261107130000') as ledger;
