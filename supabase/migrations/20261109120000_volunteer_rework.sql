-- ============================================================================
-- Volunteers, the rework of 2026-11-09 (the owner's answers on the decision sheet, claude.ai/artifact/J7mD5BambE6e8LyHyB1AhT:
-- a standing volunteer team; sign-in first as before; a short profile and staff's yes before the first opportunity; one
-- block per opportunity as before; updates in the portal and on the phone; check-in and the blood night's marks as before;
-- a team lead; online only; a free ride, a certificate and the Volunteer badge for each event worked, the hours levels kept).
--
--  1. Joining. volunteers.profile_at: the volunteer filled in the portal's profile (volunteer_apply: the days they are
--     usually free, at least one; skills and T-shirt size optional). The account must already hold a birth date (VOL_DOB)
--     and an emergency contact (VOL_EMERGENCY): the profile shows them, the booking app keeps them. volunteer_interest
--     takes only someone staff approved (status active): no profile yet is VOL_PROFILE, a profile waiting for staff is
--     VOL_PENDING. Someone staff trust (auto_accept) is still accepted by themselves.
--  2. An offer nobody answered before its opportunity closed ends by itself, with a thank-you: shift status 'ended'
--     (_vol_tick, every ten minutes).
--  3. Team leads. volunteer_shifts.lead, one per opportunity (staff_volunteer_lead). The lead sees the team's names and who
--     has arrived (volunteer_team) and checks them in and out (volunteer_team_clock); staff still give the hours.
--     volunteer_shifts.clock_in_by is new ('lead' when the lead checked someone in); clock_out_by takes 'lead'.
--  4. Updates. volunteer_updates is what the portal lists: approved, accepted, declined, ended, briefing, the day-before and
--     two-hour reminders, lead, reward. Triggers on volunteers / volunteer_shifts / volunteer_sessions and _vol_tick write
--     them (_vol_note), one row per person, session and kind, brought back to the top when it happens again. Each also
--     queues a phone notification in push_outbox, which mm-push-drain sends once the push keys are set in Cloudflare.
--     volunteer_updates(p_id, p_token) reads them, volunteer_updates_seen marks them read.
--  5. Rewards for each event worked (_vol_reward), given with a session's hours (staff_volunteer_award, or
--     staff_volunteer_hours_add with a session): the Volunteer badge and the hours levels (_vol_badges, as before), the
--     event's certificate made by itself (issued_by 'auto'), and a free ride code VL-XXXXXXXX on the blood donors' rules:
--     100% off one ride, the account holder's own, one month from the day it is given, never Carbon, circuit nights, and
--     Petromin nights for holders (_blood_code_guard now covers it). promo_codes.volunteer_session_id ties the code to the
--     event, one per person and event. customer_blood_rewards lists the VL codes too, so the booking app shows and redeems
--     them. Cancelling the last live hours of an event takes back its code (unless used) and its automatic certificate.
--  6. volunteer_me / volunteer_profile / volunteer_enter say more: per shift the lead flag, the free ride and the
--     certificate; the events worked; unread updates; the profile and the account's birth date and emergency contact.
--  7. Back-fill: the nine volunteers of 2026-11-05 get their Volunteer badge, the night's certificate and a free ride
--     (the owner, 2026-11-09); the six offers left open from that night end with a thank-you.
--
-- Bodies copied from the LIVE definitions on prod (pg_get_functiondef, 2026-11-09) and changed only where this header
-- says. Each restates SECURITY DEFINER and search_path.
--
-- Rollback: re-run the bodies of volunteer_interest, volunteer_apply, volunteer_me, volunteer_profile, volunteer_enter,
-- staff_volunteer_award, staff_volunteer_hours_add, staff_volunteer_hours_void, customer_blood_rewards and _blood_code_guard
-- from their last migrations; drop the triggers volunteer_shifts_notes, volunteers_notes, volunteer_sessions_brief_notes;
-- select cron.unschedule('mm-vol-tick'); drop the functions added below and table volunteer_updates; restore the three check
-- constraints (status without 'ended', clock_out_by without 'lead', the log's actions); the new columns may stay. The
-- codes, certificates and badges given stay: take them back by hand if needed
-- (promo_codes where volunteer_session_id is not null; volunteer_certs where issued_by = 'auto').
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

/* -- 1. columns and tables ---------------------------------------------------------------------- */
alter table public.volunteers add column if not exists profile_at timestamptz;
comment on column public.volunteers.profile_at is 'The volunteer filled in the portal''s profile (volunteer_apply, 20261109120000). Staff approve the person after it.';

alter table public.volunteer_shifts drop constraint if exists volunteer_shifts_status_check;
alter table public.volunteer_shifts add constraint volunteer_shifts_status_check
  check (status in ('interested', 'accepted', 'declined', 'withdrawn', 'blocked', 'no_show', 'done', 'ended'));
comment on column public.volunteer_shifts.status is
  'interested, accepted, declined, withdrawn, blocked, no_show, done; ended = the opportunity closed before staff answered (set by _vol_tick, 20261109120000).';

alter table public.volunteer_shifts add column if not exists lead boolean not null default false;
alter table public.volunteer_shifts add column if not exists clock_in_by text;
alter table public.volunteer_shifts drop constraint if exists volunteer_shifts_clock_in_by_check;
alter table public.volunteer_shifts add constraint volunteer_shifts_clock_in_by_check check (clock_in_by in ('self', 'staff', 'lead'));
alter table public.volunteer_shifts drop constraint if exists volunteer_shifts_clock_out_by_check;
alter table public.volunteer_shifts add constraint volunteer_shifts_clock_out_by_check check (clock_out_by in ('self', 'staff', 'lead'));
create unique index if not exists volunteer_shifts_one_lead on public.volunteer_shifts (session_id) where lead;
comment on column public.volunteer_shifts.lead is 'The team lead of this opportunity (staff_volunteer_lead, 20261109120000): sees the team and checks them in and out.';

alter table public.volunteer_log drop constraint if exists volunteer_log_action_check;
alter table public.volunteer_log add constraint volunteer_log_action_check
  check (action in ('enter', 'list', 'scan', 'search', 'checkin', 'uncheckin', 'donated', 'undonated', 'clock_in', 'clock_out', 'agree', 'interest', 'withdraw', 'role',
                    'arrive', 'staff_accept', 'staff_decline', 'staff_in', 'staff_out', 'staff_times', 'staff_status', 'staff_noshow', 'staff_remove',
                    'staff_award', 'staff_hours', 'staff_void', 'staff_save', 'staff_session', 'staff_end',
                    'profile', 'team', 'lead_in', 'lead_out', 'lead_undo', 'staff_lead', 'reward', 'ended'));

alter table public.promo_codes add column if not exists volunteer_session_id text references public.sessions (id) on update cascade on delete set null;
create unique index if not exists promo_codes_volunteer_one on public.promo_codes (customer_id, volunteer_session_id) where volunteer_session_id is not null;
comment on column public.promo_codes.volunteer_session_id is
  'A volunteer''s free ride for working this event (VL- code, _vol_free_ride, 20261109120000): the blood donors'' rules (_blood_code_guard).';

create table if not exists public.volunteer_updates (
  id          bigint generated always as identity primary key,
  customer_id text not null references public.customers (id) on update cascade on delete cascade,
  session_id  text references public.sessions (id) on update cascade on delete cascade,
  kind        text not null check (kind in ('approved', 'accepted', 'declined', 'ended', 'briefing', 'reminder_day', 'reminder_soon', 'lead', 'reward')),
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
comment on table public.volunteer_updates is
  'What the volunteer portal lists under Updates (20261109120000): one row per person, session and kind, written by _vol_note.';
create unique index if not exists volunteer_updates_one on public.volunteer_updates (customer_id, (coalesce(session_id, '')), kind);
create index if not exists volunteer_updates_customer on public.volunteer_updates (customer_id, created_at desc);
alter table public.volunteer_updates enable row level security;
revoke all on public.volunteer_updates from public, anon, authenticated;
grant select on public.volunteer_updates to authenticated;
drop policy if exists "staff read" on public.volunteer_updates;
create policy "staff read" on public.volunteer_updates for select using ((select _staff_mod('volunteers')));


/* -- 2. helpers --------------------------------------------------------------------------------- */
-- A session's name as the portal says it (its sessionName, the booking app's _evName), for the automatic certificate.
create or replace function public._vol_sess_name(p_session text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when s.ride_kind in ('saturday', 'petromin', 'swim', 'workshop', 'snd96', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'blood')
              then coalesce(nullif(btrim(s.title), ''),
                            case s.ride_kind when 'saturday' then 'Saturday Social Ride' when 'petromin' then 'Petromin''s Wednesdays'
                              when 'swim' then 'Triathlon Pool Session' when 'workshop' then 'T100 Triathlon Prep'
                              when 'snd96' then 'Saudi National Day 96 Ride' when 'event' then 'Event' when 'runher' then 'Run for Her'
                              when 'vlap' then 'Victory Lap' when 'arena' then 'Arena Heros Hybrid Race' when 'defe5k' then 'DEFE 5KM Run'
                              else 'Micromobility Blood Donation' end)
              else 'Jeddah Corniche Circuit' end
    from sessions s where s.id = p_session
$function$;
revoke all on function public._vol_sess_name(text) from public, anon, authenticated;

-- One update for the portal, and its phone notification. Reminders and the reward are said once; anything else that happens
-- again (accepted after a decline, a new briefing) comes back to the top, unread, with a new notification.
create or replace function public._vol_note(p_cust text, p_session text, p_kind text, p_data jsonb default '{}'::jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _id bigint; _d text; _dm text; _b text;
begin
  if p_cust is null then return; end if;
  if p_kind in ('reminder_day', 'reminder_soon', 'reward') then
    insert into volunteer_updates (customer_id, session_id, kind, data) values (p_cust, p_session, p_kind, coalesce(p_data, '{}'::jsonb))
    on conflict (customer_id, (coalesce(session_id, '')), kind) do nothing
    returning id into _id;
    if _id is null then return; end if;
  else
    insert into volunteer_updates (customer_id, session_id, kind, data) values (p_cust, p_session, p_kind, coalesce(p_data, '{}'::jsonb))
    on conflict (customer_id, (coalesce(session_id, '')), kind) do update set data = excluded.data, created_at = now(), read_at = null
    returning id into _id;
  end if;
  select to_char(s.session_date::date, 'FMDD Mon'), to_char(s.session_date::date, 'DD/MM') into _d, _dm
    from sessions s where s.id = p_session and s.session_date ~ '^\d{4}-\d{2}-\d{2}$';
  _d := coalesce(_d, ''); _dm := coalesce(_dm, '');
  -- English | Arabic, as the other notifications (_ref_expiry_tick): the database does not know the reader's language.
  _b := case p_kind
    when 'approved'      then 'You are a MicroMobility volunteer. Pick an opportunity to help at. | أصبحت متطوعًا في مايكروموبيليتي. اختر فرصة تطوع.'
    when 'accepted'      then 'You are on the volunteer team for ' || _d || '. | تم قبولك في فريق المتطوعين ليوم ' || _dm || '.'
    when 'declined'      then 'Not this time for ' || _d || '. Thank you for offering. | ليس هذه المرة ليوم ' || _dm || '. شكرًا لعرضك المساعدة.'
    when 'ended'         then 'The opportunity on ' || _d || ' has ended. Thank you for offering. | انتهت فرصة يوم ' || _dm || '. شكرًا لعرضك المساعدة.'
    when 'briefing'      then 'The briefing for ' || _d || ' has changed. Please read it. | تغيّرت التوجيهات ليوم ' || _dm || '. يرجى قراءتها.'
    when 'reminder_day'  then 'Reminder: you volunteer on ' || _d || '. | تذكير: موعد تطوعك يوم ' || _dm || '.'
    when 'reminder_soon' then 'Your volunteer shift starts soon. Tap I have arrived when you get there. | يبدأ تطوعك قريبًا. اضغط وصلت عند وصولك.'
    when 'lead'          then 'You lead the volunteer team on ' || _d || '. | أنت قائد فريق المتطوعين يوم ' || _dm || '.'
    when 'reward'        then 'Thank you for volunteering. Your certificate and free ride are ready. | شكرًا لتطوعك. شهادتك وجولتك المجانية جاهزتان.'
  end;
  if _b is not null then
    perform _push_queue(p_cust, 'vol-' || _id || '-' || to_char(now(), 'YYYYMMDDHH24MISS'), 'MicroMobility Volunteers', _b,
                        'https://volunteer.micromobility.sa/#updates');
  end if;
end $function$;
revoke all on function public._vol_note(text, text, text, jsonb) from public, anon, authenticated;

-- A volunteer's free ride for an event: one per person and event, 100% off one ride, one month from today.
create or replace function public._vol_free_ride(p_cust text, p_session text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare c promo_codes%rowtype; _code text; _exp date := ((now() at time zone 'Asia/Riyadh')::date + interval '1 month')::date;
begin
  select * into c from promo_codes where customer_id = p_cust and volunteer_session_id = p_session for update;
  if found then
    -- given again after being taken back: the same code, the month counted from now
    if not c.active and coalesce(c.uses, 0) = 0 then
      update promo_codes set active = true, expires_at = _exp where id = c.id;
      c.expires_at := _exp;
    end if;
    return jsonb_build_object('code', c.code, 'expires_at', c.expires_at, 'again', true);
  end if;
  loop
    _code := 'VL-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8));
    exit when not exists (select 1 from promo_codes where lower(code) = lower(_code));
  end loop;
  insert into promo_codes (id, code, kind, value, active, created_at, applies_to, expires_at, max_uses, uses, customer_id, volunteer_session_id)
  values ('vl-' || left(md5(p_session || '|' || p_cust), 20), _code, 'percent', 100, true,
          to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), null, _exp, 1, 0, p_cust, p_session);
  return jsonb_build_object('code', _code, 'expires_at', _exp);
end $function$;
revoke all on function public._vol_free_ride(text, text) from public, anon, authenticated;

-- Everything an event worked gives: the badges, the certificate, the free ride, and the update that says so. Safe to repeat.
create or replace function public._vol_reward(p_cust text, p_session text, p_op text)
 returns int
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _lvl int; _fr jsonb; _cert jsonb;
begin
  _lvl := _vol_badges(p_cust, p_session, p_op);
  if p_session is null then return _lvl; end if;
  begin
    _cert := _vol_cert_make_session(p_cust, p_session, _vol_sess_name(p_session), 'auto');
  exception when others then
    _cert := null; -- an event dated ahead of today: its certificate is made when the volunteer asks for it
  end;
  _fr := _vol_free_ride(p_cust, p_session);
  if not coalesce((_fr ->> 'again')::boolean, false) then
    insert into volunteer_log (customer_id, session_id, action, actor) values (p_cust, p_session, 'reward', left(coalesce(p_op, 'auto'), 120));
  end if;
  perform _vol_note(p_cust, p_session, 'reward', jsonb_build_object('code', _fr ->> 'code', 'expires_at', _fr ->> 'expires_at', 'cert', _cert ->> 'serial'));
  return _lvl;
end $function$;
revoke all on function public._vol_reward(text, text, text) from public, anon, authenticated;


/* -- 3. the updates' triggers and the timer ------------------------------------------------------ */
create or replace function public._vol_shift_notes()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _st text; _lead boolean := false;
begin
  if tg_op = 'UPDATE' then _st := old.status; _lead := old.lead; end if; -- OLD is never read on an insert
  if new.status in ('accepted', 'declined', 'ended') and new.status is distinct from _st then
    perform _vol_note(new.customer_id, new.session_id, new.status, jsonb_build_object('role', new.role));
  end if;
  if new.lead and not coalesce(_lead, false) then
    perform _vol_note(new.customer_id, new.session_id, 'lead');
  end if;
  return null;
end $function$;
revoke all on function public._vol_shift_notes() from public, anon, authenticated;
drop trigger if exists volunteer_shifts_notes on public.volunteer_shifts;
create trigger volunteer_shifts_notes after insert or update of status, lead on public.volunteer_shifts
  for each row execute function public._vol_shift_notes();

create or replace function public._vol_person_notes()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _was text;
begin
  if tg_op = 'UPDATE' then _was := old.status; end if; -- OLD is never read on an insert
  if new.status = 'active' and (_was is null or _was = 'applied') then
    perform _vol_note(new.customer_id, null, 'approved');
  end if;
  return null;
end $function$;
revoke all on function public._vol_person_notes() from public, anon, authenticated;
drop trigger if exists volunteers_notes on public.volunteers;
create trigger volunteers_notes after insert or update of status on public.volunteers
  for each row execute function public._vol_person_notes();

-- A new briefing: everyone accepted hears of it (volunteer_sessions_briefing already clears their "I have read it").
create or replace function public._vol_brief_notes()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(btrim(new.briefing), '') <> '' and new.briefing is distinct from old.briefing and now() < new.closes_at then
    perform _vol_note(sh.customer_id, new.session_id, 'briefing')
       from volunteer_shifts sh where sh.session_id = new.session_id and sh.status = 'accepted';
  end if;
  return null;
end $function$;
revoke all on function public._vol_brief_notes() from public, anon, authenticated;
drop trigger if exists volunteer_sessions_brief_notes on public.volunteer_sessions;
create trigger volunteer_sessions_brief_notes after update of briefing on public.volunteer_sessions
  for each row execute function public._vol_brief_notes();

-- Every ten minutes: offers nobody answered before the opportunity closed end, with a thank-you; the accepted hear the day
-- before (from 24 hours ahead) and again two hours ahead. Returns how many offers ended.
create or replace function public._vol_tick()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n int := 0; r record; _start timestamptz;
begin
  with u as (update volunteer_shifts sh set status = 'ended', updated_at = now(), updated_by = 'auto'
               from volunteer_sessions w
              where w.session_id = sh.session_id and sh.status = 'interested' and now() >= w.closes_at
             returning sh.customer_id, sh.session_id)
  insert into volunteer_log (customer_id, session_id, action, actor) select u.customer_id, u.session_id, 'ended', 'auto' from u;
  get diagnostics n = row_count;
  for r in select sh.customer_id, sh.session_id, s.session_date, s.bike_slots, w.opens_at
             from volunteer_shifts sh
             join volunteer_sessions w on w.session_id = sh.session_id
             join sessions s on s.id = sh.session_id
            where sh.status = 'accepted' and sh.clock_in is null and w.enabled and now() < w.closes_at and s.cancelled_at is null
              and s.session_date ~ '^\d{4}-\d{2}-\d{2}$' and s.session_date::date between _vol_today() and _vol_today() + 2 loop
    _start := coalesce(_vol_session_start(r.session_date, r.bike_slots), _vol_starts(r.opens_at, r.session_date));
    continue when _start is null or now() >= _start + interval '1 hour';
    if now() >= _start - interval '2 hours' then
      perform _vol_note(r.customer_id, r.session_id, 'reminder_soon');
    elsif now() >= _start - interval '24 hours' then
      perform _vol_note(r.customer_id, r.session_id, 'reminder_day');
    end if;
  end loop;
  return n;
end $function$;
revoke all on function public._vol_tick() from public, anon, authenticated;


/* -- 4. the free ride follows the blood donors' rules -------------------------------------------- */
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
  -- the blood donors' free ride, and since 20261109120000 a volunteer's (VL-) on the same rules
  if not exists (select 1 from promo_codes c
                  where lower(c.code) = lower(new.promo_code)
                    and (c.blood_entry_id is not null or c.volunteer_session_id is not null or c.code ilike 'VL-%')) then
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

-- The rider's own free ride codes: the blood donation's, and a volunteer's for each event worked (entry_id 'vl-<session>').
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
     where c.customer_id = p_id and c.blood_entry_id is not null and c.active = true
    union all
    select 'vl-' || c.volunteer_session_id, c.code, c.expires_at, coalesce(c.uses, 0) > 0
      from promo_codes c
     where c.customer_id = p_id and c.volunteer_session_id is not null and c.active = true;
end $function$;


/* -- 5. staff: rewards with the hours, and the lead ---------------------------------------------- */
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
    -- the badges, the certificate and the free ride (20261109120000)
    _lvl := _vol_reward(_c, p_session, _op);
    if _lvl > 0 then _reached := _reached || jsonb_build_array(jsonb_build_object('customer_id', _c, 'hours', _lvl)); end if;
    _add := _add + 1;
  end loop;
  return jsonb_build_object('ok', true, 'added', _add, 'skipped', _skip, 'reached', _reached);
end $function$;

create or replace function public.staff_volunteer_hours_add(p_customer text, p_hours numeric, p_on date default null::date, p_session text default null::text, p_note text default null::text)
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
  -- hours on an event are that event worked: its rewards too (20261109120000); hours on no event, the levels alone
  if _h > 0 then
    _lvl := case when p_session is null then _vol_badges(p_customer, null, _vol_op()) else _vol_reward(p_customer, p_session, _vol_op()) end;
  end if;
  return jsonb_build_object('ok', true, 'id', _id, 'total', _tot + _h, 'reached', _lvl);
end $function$;

create or replace function public.staff_volunteer_hours_void(p_id bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare h volunteer_hours%rowtype; _tot numeric; _back boolean := false;
begin
  if not ((select _staff_mod('volunteers', true)) or (select _staff_mod('customers', true))) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into h from volunteer_hours where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if h.voided_at is not null then return jsonb_build_object('ok', true, 'noop', true); end if;
  select coalesce(c.volunteer_hours, 0) into _tot from customers c where c.id = h.customer_id for update;
  if _tot - h.hours < 0 then raise exception 'VOL_HOURS_NEGATIVE' using errcode = 'P0001'; end if;
  update volunteer_hours set voided_at = now(), voided_by = _vol_op() where id = p_id;
  perform _vol_slog(h.customer_id, h.session_id, 'staff_void', h.hours);
  -- The event's last live hours gone: its unused free ride and its automatic certificate go too (20261109120000).
  if h.session_id is not null and not exists (select 1 from volunteer_hours x where x.customer_id = h.customer_id and x.session_id = h.session_id
                                                and x.voided_at is null and x.hours > 0) then
    update promo_codes set active = false
     where customer_id = h.customer_id and volunteer_session_id = h.session_id and active and coalesce(uses, 0) = 0;
    update volunteer_certs set revoked_at = now(), revoked_by = _vol_op()
     where customer_id = h.customer_id and session_id = h.session_id and kind = 'session' and issued_by = 'auto' and revoked_at is null;
    _back := true;
  end if;
  return jsonb_build_object('ok', true, 'total', _tot - h.hours, 'rewards_back', _back);
end $function$;

-- The team lead: one per opportunity, someone accepted on it. Marking another moves it.
create or replace function public.staff_volunteer_lead(p_session text, p_customer text, p_on boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _op text := _vol_op();
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if coalesce(p_on, false) and not exists (select 1 from volunteer_shifts where session_id = p_session and customer_id = p_customer and status in ('accepted', 'done')) then
    raise exception 'VOL_NOT_ACCEPTED' using errcode = 'P0001';
  end if;
  if coalesce(p_on, false) then
    update volunteer_shifts set lead = false, updated_at = now(), updated_by = _op where session_id = p_session and lead and customer_id <> p_customer;
    update volunteer_shifts set lead = true, updated_at = now(), updated_by = _op where session_id = p_session and customer_id = p_customer and not lead;
  else
    update volunteer_shifts set lead = false, updated_at = now(), updated_by = _op where session_id = p_session and customer_id = p_customer and lead;
  end if;
  perform _vol_slog(p_customer, p_session, 'staff_lead');
  return jsonb_build_object('ok', true, 'lead', coalesce(p_on, false));
end $function$;


/* -- 6. the portal ------------------------------------------------------------------------------- */
-- The profile: the days usually free (at least one), skills and T-shirt size; the account's birth date and emergency contact
-- must be there already. Saving it again keeps it up to date and never changes the status.
create or replace function public.volunteer_apply(p_id text, p_token text, p_skills text default null::text, p_days integer[] default null::integer[], p_shirt text default null::text, p_whatsapp text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v volunteers%rowtype; c record; _days smallint[]; _wa text; _shirt text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  select x.must_change_pwd, x.deletion_requested_at, x.birth_date, x.emergency_name, x.emergency_phone into c from customers x where x.id = p_id;
  if coalesce(c.must_change_pwd, false) or c.deletion_requested_at is not null then raise exception 'VOL_ACCOUNT' using errcode = '42501'; end if;
  select * into v from volunteers where customer_id = p_id for update;
  if found and v.status in ('paused', 'removed') then raise exception 'VOL_NOT_VOLUNTEER' using errcode = '42501'; end if;
  if coalesce(c.birth_date, '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'VOL_DOB' using errcode = 'P0001'; end if;
  if coalesce(btrim(c.emergency_name), '') = '' or coalesce(btrim(c.emergency_phone), '') = '' then raise exception 'VOL_EMERGENCY' using errcode = 'P0001'; end if;
  _days := array(select distinct d::smallint from unnest(coalesce(p_days, '{}')) d where d between 0 and 6 order by 1);
  if cardinality(_days) = 0 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  _wa := nullif(regexp_replace(coalesce(p_whatsapp, ''), '[^0-9+]', '', 'g'), '');
  if _wa is not null and _wa !~ '^\+?[0-9]{7,15}$' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  _shirt := nullif(btrim(coalesce(p_shirt, '')), '');
  if _shirt is not null and _shirt not in ('XS', 'S', 'M', 'L', 'XL', 'XXL') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  insert into volunteers (customer_id, status, applied_at, profile_at, skills, days, shirt, whatsapp)
  values (p_id, 'applied', now(), now(), nullif(left(btrim(coalesce(p_skills, '')), 300), ''), _days, _shirt, _wa)
  on conflict (customer_id) do update set
    skills = excluded.skills, days = excluded.days, shirt = coalesce(excluded.shirt, volunteers.shirt),
    whatsapp = excluded.whatsapp, applied_at = coalesce(volunteers.applied_at, now()),
    profile_at = coalesce(volunteers.profile_at, now()), updated_at = now();
  return jsonb_build_object('ok', true, 'status', coalesce(v.status, 'applied'));
end $function$;

create or replace function public.volunteer_interest(p_id text, p_token text, p_session text, p_on boolean, p_role text default null::text, p_message text default null::text)
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
    if sh.status in ('declined', 'no_show', 'done', 'ended') then raise exception 'VOL_DECLINED' using errcode = 'P0001'; end if;
    update volunteer_shifts set status = 'withdrawn', lead = false, updated_at = now() where id = sh.id;
    perform _vol_log(p_id, p_session, 'withdraw');
    return jsonb_build_object('ok', true, 'status', 'withdrawn');
  end if;

  if sh.id is not null and sh.status in ('interested', 'accepted', 'done') then return jsonb_build_object('ok', true, 'noop', true, 'status', sh.status); end if;
  if sh.id is not null and sh.status in ('declined', 'no_show', 'ended') then raise exception 'VOL_DECLINED' using errcode = 'P0001'; end if;
  -- The profile first, then staff's yes on the person; after that one tap per opportunity (20261109120000).
  if v.customer_id is null or v.status <> 'active' then
    raise exception '%', case when v.profile_at is null then 'VOL_PROFILE' else 'VOL_PENDING' end using errcode = 'P0001';
  end if;
  if not w.signup_open then raise exception 'VOL_SIGNUP_CLOSED' using errcode = 'P0001'; end if;
  if w.min_age is not null then
    if coalesce(c.birth_date, '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'VOL_DOB' using errcode = 'P0001'; end if;
    select x.session_date into _day from sessions x where x.id = p_session;
    if c.birth_date::date + make_interval(years => w.min_age) > coalesce(_day::date, _vol_today()) then raise exception 'VOL_AGE' using errcode = 'P0001'; end if;
  end if;
  _stop := coalesce(nullif(_vol_settings() ->> 'noshow_stop', '')::numeric, 0)::int;
  _auto := coalesce(v.auto_accept, false)
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

create or replace function public.volunteer_me(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v volunteers%rowtype; c record; _cfg jsonb := _vol_settings(); _ok boolean; _mine jsonb; _rec jsonb; _sum record;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return null; end if;
  select x.name, coalesce(x.volunteer_hours, 0) hours,
         case when coalesce(x.must_change_pwd, false) then 'pwd' when x.deletion_requested_at is not null then 'delete' end account
    into c from customers x where x.id = p_id;
  select * into v from volunteers where customer_id = p_id;
  _ok := found and v.status = 'active' and (v.expires_on is null or v.expires_on >= _vol_today());
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'title', s.title, 'ride_kind', s.ride_kind, 'event_kind', s.event_kind, 'date', s.session_date,
           'day', s.day, 'time', _vol_time(s.bike_slots),
           'location', case when s.reveal_at is null or s.reveal_at <= now() then s.location end,
           'status', sh.status, 'role', sh.role, 'lead', sh.lead,
           'clock_in', sh.clock_in, 'clock_out', sh.clock_out, 'opens_at', _vol_starts(w.opens_at, s.session_date), 'closes_at', w.closes_at,
           'starts_at', _vol_session_start(s.session_date, s.bike_slots),
           'briefing', case when sh.status in ('accepted', 'done') then w.briefing end,
           'can_work', _ok and w.enabled and s.cancelled_at is null and sh.status in ('accepted', 'done') and now() < w.closes_at and now() >= _vol_starts(w.opens_at, s.session_date),
           -- what the event gave (20261109120000)
           'reward', (select jsonb_build_object('code', p.code, 'expires_at', p.expires_at, 'used', coalesce(p.uses, 0) > 0)
                        from promo_codes p where p.customer_id = p_id and p.volunteer_session_id = sh.session_id and p.active limit 1),
           'cert', (select jsonb_build_object('serial', vc.serial, 'hours', vc.hours) from volunteer_certs vc
                     where vc.customer_id = p_id and vc.session_id = sh.session_id and vc.kind = 'session' and vc.revoked_at is null
                     order by vc.issued_at desc limit 1)
         ) order by s.session_date desc, s.id), '[]'::jsonb)
    into _mine
    from volunteer_shifts sh
    join sessions s on s.id = sh.session_id
    join volunteer_sessions w on w.session_id = sh.session_id
   where sh.customer_id = p_id and sh.status <> 'blocked';
  select coalesce(jsonb_agg(x.j order by x.d desc, x.i desc), '[]'::jsonb) into _rec
    from (select h.id i, h.worked_on d,
                 jsonb_build_object('id', h.id, 'hours', h.hours, 'on', h.worked_on, 'note', h.note, 'session_id', h.session_id,
                                    'title', s.title, 'ride_kind', s.ride_kind, 'event_kind', s.event_kind) j
            from volunteer_hours h left join sessions s on s.id = h.session_id
           where h.customer_id = p_id and h.voided_at is null
           order by h.worked_on desc, h.id desc limit 30) x;
  select min(h.worked_on) first_on, max(h.worked_on) last_on, count(distinct h.session_id) sessions into _sum
    from volunteer_hours h where h.customer_id = p_id and h.voided_at is null;
  return jsonb_build_object(
    'id', p_id, 'name', c.name, 'hours', c.hours, 'account', c.account,
    'status', case when v.customer_id is null then null when v.status = 'active' and not _ok then 'expired' else v.status end,
    'profile', v.profile_at is not null,
    'agreed', v.agreed_version is not distinct from _vol_agreement_v() and v.customer_id is not null,
    'promote', coalesce((_cfg ->> 'promote')::boolean, false),
    'open_count', (select count(*) from volunteer_sessions w join sessions s on s.id = w.session_id where w.enabled and now() < w.closes_at and s.cancelled_at is null),
    'unread', (select count(*) from volunteer_updates u where u.customer_id = p_id and u.read_at is null),
    'mine', _mine, 'record', _rec, 'first_on', _sum.first_on, 'last_on', _sum.last_on, 'sessions', _sum.sessions,
    'cert_signer', _cfg ->> 'cert_signer', 'cert_title', _cfg ->> 'cert_title');
end $function$;

create or replace function public.volunteer_profile(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v volunteers%rowtype; c record;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return null; end if;
  select * into v from volunteers where customer_id = p_id;
  select x.name_ar, x.gender, x.birth_date, x.emergency_name, x.emergency_phone, x.emergency_relation into c from customers x where x.id = p_id;
  return jsonb_build_object(
    'status', v.status, 'applied_at', v.applied_at, 'profile_at', v.profile_at, 'skills', v.skills, 'days', coalesce(to_jsonb(v.days), '[]'::jsonb),
    'shirt', v.shirt, 'whatsapp', v.whatsapp, 'name_ar', c.name_ar, 'gender', c.gender, 'auto', coalesce(v.auto_accept, false),
    -- the account's own, shown on the profile (20261109120000): the booking app is where they change
    'birth_date', case when coalesce(c.birth_date, '') ~ '^\d{4}-\d{2}-\d{2}$' then c.birth_date end,
    'emergency', case when coalesce(btrim(c.emergency_name), '') <> '' and coalesce(btrim(c.emergency_phone), '') <> ''
                      then jsonb_build_object('name', c.emergency_name, 'phone', c.emergency_phone, 'relation', c.emergency_relation) end,
    'briefed', coalesce((select jsonb_object_agg(sh.session_id, sh.briefed_at) from volunteer_shifts sh
                          where sh.customer_id = p_id and sh.briefed_at is not null), '{}'::jsonb));
end $function$;

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
    'lead', sh.lead,
    'counts', case when coalesce((w.caps ->> 'counts')::boolean, false) then jsonb_build_object('booked', _n.booked, 'in', _n.arrived, 'donated', _n.donated, 'visitors', _n.visitors) end,
    'mine', (select count(*) filter (where l.action = 'checkin') - count(*) filter (where l.action = 'uncheckin')
               from volunteer_log l where l.customer_id = p_id and l.session_id = p_session));
end $function$;

-- The lead's team: everyone accepted on the opportunity, by name, with who has arrived. Names only, no contact details:
-- the one exception to "members see nobody" the owner allowed (2026-11-09), for the lead and while the session is open.
create or replace function public.volunteer_team(p_id text, p_token text, p_session text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare w volunteer_sessions%rowtype;
begin
  w := _vol_gate(p_id, p_token, p_session);
  if not exists (select 1 from volunteer_shifts where session_id = p_session and customer_id = p_id and lead) then
    raise exception 'VOL_NOT_LEAD' using errcode = '42501';
  end if;
  perform _vol_log(p_id, p_session, 'team');
  return (select coalesce(jsonb_agg(jsonb_build_object(
            'shift', sh.id, 'name', c.name, 'role', sh.role, 'status', sh.status, 'me', sh.customer_id = p_id, 'lead', sh.lead,
            'clock_in', sh.clock_in, 'clock_out', sh.clock_out, 'clock_in_by', sh.clock_in_by, 'clock_out_by', sh.clock_out_by,
            'briefed', sh.briefed_at is not null)
          order by (sh.clock_in is not null and sh.clock_out is null) desc, c.name), '[]'::jsonb)
    from volunteer_shifts sh join customers c on c.id = sh.customer_id
   where sh.session_id = p_session and sh.status in ('accepted', 'done'));
end $function$;

-- The lead checks a teammate in or out, or undoes their own mark. A check-out staff made stands (VOL_CHECKED_OUT).
create or replace function public.volunteer_team_clock(p_id text, p_token text, p_session text, p_shift bigint, p_action text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare w volunteer_sessions%rowtype; sh volunteer_shifts%rowtype;
begin
  w := _vol_gate(p_id, p_token, p_session);
  if not exists (select 1 from volunteer_shifts where session_id = p_session and customer_id = p_id and lead) then
    raise exception 'VOL_NOT_LEAD' using errcode = '42501';
  end if;
  if p_action not in ('in', 'out', 'undo_in', 'undo_out') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  select * into sh from volunteer_shifts where id = p_shift and session_id = p_session and status in ('accepted', 'done') for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_action = 'in' then
    if sh.clock_in is not null and sh.clock_out is null then return jsonb_build_object('ok', true, 'noop', true); end if;
    if sh.clock_out is not null and sh.clock_out_by = 'staff' then raise exception 'VOL_CHECKED_OUT' using errcode = 'P0001'; end if;
    update volunteer_shifts set clock_in = coalesce(clock_in, now()), clock_in_by = case when clock_in is null then 'lead' else clock_in_by end,
           clock_out = null, clock_out_by = null, updated_at = now(), updated_by = 'lead'
     where id = sh.id returning * into sh;
    perform _vol_log(p_id, p_session, 'lead_in', sh.id::text);
  elsif p_action = 'out' then
    if sh.clock_in is null or sh.clock_out is not null then return jsonb_build_object('ok', true, 'noop', true); end if;
    update volunteer_shifts set clock_out = greatest(now(), clock_in + interval '1 minute'), clock_out_by = 'lead', updated_at = now(), updated_by = 'lead'
     where id = sh.id returning * into sh;
    perform _vol_log(p_id, p_session, 'lead_out', sh.id::text);
  elsif p_action = 'undo_in' then
    if sh.clock_in_by is distinct from 'lead' or sh.clock_out is not null then raise exception 'VOL_NOT_YOURS' using errcode = '42501'; end if;
    update volunteer_shifts set clock_in = null, clock_in_by = null, updated_at = now(), updated_by = 'lead' where id = sh.id returning * into sh;
    perform _vol_log(p_id, p_session, 'lead_undo', sh.id::text);
  else
    if sh.clock_out_by is distinct from 'lead' then raise exception 'VOL_NOT_YOURS' using errcode = '42501'; end if;
    update volunteer_shifts set clock_out = null, clock_out_by = null, updated_at = now(), updated_by = 'lead' where id = sh.id returning * into sh;
    perform _vol_log(p_id, p_session, 'lead_undo', sh.id::text);
  end if;
  return jsonb_build_object('ok', true, 'shift', sh.id, 'clock_in', sh.clock_in, 'clock_out', sh.clock_out,
                            'clock_in_by', sh.clock_in_by, 'clock_out_by', sh.clock_out_by);
end $function$;

-- The portal's Updates: the newest 50, and how many are unread. A signed-out call answers VOL_TOKEN.
create or replace function public.volunteer_updates(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  return jsonb_build_object(
    'items', (select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'kind', u.kind, 'session_id', u.session_id, 'title', s.title,
                                                           'ride_kind', s.ride_kind, 'date', s.session_date, 'data', u.data,
                                                           'at', u.created_at, 'read', u.read_at is not null)
                                        order by u.created_at desc, u.id desc), '[]'::jsonb)
                from (select * from volunteer_updates x where x.customer_id = p_id order by x.created_at desc, x.id desc limit 50) u
                left join sessions s on s.id = u.session_id),
    'unread', (select count(*) from volunteer_updates x where x.customer_id = p_id and x.read_at is null));
end $function$;

create or replace function public.volunteer_updates_seen(p_id text, p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n int;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  update volunteer_updates set read_at = now() where customer_id = p_id and read_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'n', n);
end $function$;


/* -- 7. who may call what ------------------------------------------------------------------------ */
do $do$
declare f text;
begin
  foreach f in array array['volunteer_team(text,text,text)', 'volunteer_team_clock(text,text,text,bigint,text)',
                           'volunteer_updates(text,text)', 'volunteer_updates_seen(text,text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  foreach f in array array['staff_volunteer_lead(text,text,boolean)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $do$;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'mm-vol-tick';
    perform cron.schedule('mm-vol-tick', '*/10 * * * *', $j$select public._vol_tick()$j$);
  end if;
end $cron$;


/* -- 8. back-fill: the volunteers of 2026-11-05 get what an event worked now gives; open offers from past nights end -- */
do $fill$
declare r record;
begin
  for r in select distinct h.customer_id, h.session_id
             from volunteer_hours h join customers c on c.id = h.customer_id and c.merged_into is null
            where h.voided_at is null and h.session_id is not null and h.hours > 0 loop
    perform _vol_reward(r.customer_id, r.session_id, 'auto');
  end loop;
  perform _vol_tick();
end $fill$;


do $chk$
begin
  if (select count(*) from information_schema.columns where table_schema = 'public'
       and ((table_name = 'volunteers' and column_name = 'profile_at')
         or (table_name = 'volunteer_shifts' and column_name in ('lead', 'clock_in_by'))
         or (table_name = 'promo_codes' and column_name = 'volunteer_session_id'))) <> 4 then
    raise exception 'a column is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.volunteer_updates'::regclass) then
    raise exception 'volunteer_updates has no RLS';
  end if;
  if exists (select 1 from volunteer_hours h where h.voided_at is null and h.session_id is not null and h.hours > 0
               and not exists (select 1 from customer_badges b where b.customer_id = h.customer_id and b.badge_id = 'bd_volunteer')
               and exists (select 1 from badges b where b.id = 'bd_volunteer')) then
    raise exception 'someone with event hours has no Volunteer badge';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261109120000', 'volunteer_rework')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): the columns, the definer functions, the triggers, the timer, what the back-fill gave, the ledger row.
select (select count(*) from information_schema.columns where table_schema = 'public'
          and ((table_name = 'volunteers' and column_name = 'profile_at')
            or (table_name = 'volunteer_shifts' and column_name in ('lead', 'clock_in_by'))
            or (table_name = 'promo_codes' and column_name = 'volunteer_session_id'))) as columns_4,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('_vol_sess_name', '_vol_note', '_vol_free_ride', '_vol_reward', '_vol_shift_notes', '_vol_person_notes', '_vol_brief_notes',
                         '_vol_tick', '_blood_code_guard', 'customer_blood_rewards', 'staff_volunteer_award', 'staff_volunteer_hours_add',
                         'staff_volunteer_hours_void', 'staff_volunteer_lead', 'volunteer_apply', 'volunteer_interest', 'volunteer_me',
                         'volunteer_profile', 'volunteer_enter', 'volunteer_team', 'volunteer_team_clock', 'volunteer_updates',
                         'volunteer_updates_seen')) as definer_23,
       (select count(*) from pg_trigger where tgname in ('volunteer_shifts_notes', 'volunteers_notes', 'volunteer_sessions_brief_notes')) as triggers_3,
       (select count(*) from cron.job where jobname = 'mm-vol-tick') as timer_1,
       (select count(*) from promo_codes where volunteer_session_id is not null) as free_rides,
       (select count(*) from volunteer_certs where issued_by = 'auto' and revoked_at is null) as auto_certs,
       (select count(*) from volunteer_shifts where status = 'interested') as offers_still_open,
       (select version from supabase_migrations.schema_migrations where version = '20261109120000') as ledger;
