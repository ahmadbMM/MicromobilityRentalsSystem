-- ============================================================================
-- Volunteers, the enhancements of 2026-11-11 (the owner on the research round's report "Volunteer portal enhancements":
-- "implement them all"; the report's recommended option for each decision). The database half: the portal
-- (mm-platform apps/volunteers) and the staff section (staff-parts/volunteers.js) build against what is here.
--
--  A. What to know before the day: volunteer_sessions.meet_point, meet_map (an https:// link), bring, provided,
--     shirt_pickup, demands, contact_name / contact_phone (a STAFF contact, decision 7), partner / partner_ar,
--     skills / skills_ar, and gender ('female' or 'male' for a women-only or men-only opportunity, decision 12).
--     Staff write them with staff_volunteer_details_save; volunteer_opportunities() shows them (not the contact; the
--     meeting point is hidden before the session's reveal_at, like its location).
--  B. Before the day: volunteer_shifts.plan_leave ("what time will you leave?", volunteer_plan) and coming_at ("Still
--     coming?", volunteer_coming). Answering No withdraws an accepted shift with an optional withdraw_reason, until the
--     session starts. volunteer_interest(..., false) still withdraws an offer staff have not answered.
--  C. After the day: volunteer_feedback, one optional rating per shift (decision 6: it never holds back a certificate).
--  D. volunteers.motive: the one motive question (volunteer_motive), private to the volunteer.
--  E. Decline reasons (decision 9): volunteer_shifts.decline_reason and volunteers.decline_reason, from a fixed list,
--     set by staff_volunteer_reason after the decline. An application declined (applied -> removed) now tells the person
--     (Update kind 'not_approved'); declined / ended / not_approved Updates carry data.reason.
--  F. Settings (decisions 3 and 10): min_age (absent = 18) is checked on a new profile (volunteer_apply) and on a new
--     offer (volunteer_interest, with the opportunity's own min_age when that is higher); auto_returning (absent = on)
--     accepts at once anyone with a shift done, through the auto_accept path and its no-show limit. An opportunity with a
--     gender refuses anyone else (VOL_GENDER).
--  G. Health data (report fix 8): volunteer_find and volunteer_list already carry blood type only on a blood donation
--     session (ride_kind 'blood') and the phone only under caps.phone; nothing else hands booking rows to the Work page.
--     Unchanged here; the tests hold them to it.
--  H. volunteer_me: team totals for this year without names, hours given with no event (extra_hours), and per shift the
--     plan, the answer to "Still coming?", the reasons, the rating given, staff's thank-you, the event's impact once it is
--     over, and for the team the contact, the meeting point, what to bring and the end time.
--  I. staff_volunteer_thanks: one line of thanks per event to everyone who worked it (Update kind 'thanks'); sending it
--     again changes the line, never adds a second Update.
--  J. volunteer_certs.role / skills / skills_ar / partner / partner_ar, stamped on an event's certificate when it is
--     issued (the shift's role, the session's skills and partner) and returned wherever a certificate is printed;
--     volunteer_cert_check adds role and partner. Certificates already issued keep what they said (all five null).
--  K. The log takes the new actions; grants; supabase/checks/security-attributes.sql lists every function here.
--
-- Also: a status change on a shift clears the reasons and the plan of the shift's earlier round (trigger
-- volunteer_shifts_reset), a rating follows its shift when a session moves or accounts merge (trigger
-- volunteer_shifts_feedback_follow), and _purge_old clears a rating's comment with the rest of an anonymised account
-- (patched in place).
--
-- Rebuilt from their latest definitions in this repo, each header copied from there (never from prosrc):
-- volunteer_opportunities, staff_volunteer_settings_save (20261107130000); volunteer_interest, volunteer_apply,
-- volunteer_profile, volunteer_updates, _vol_shift_notes, _vol_person_notes (20261109120000); volunteer_me and _vol_note
-- (20261109120000 with the patches of 20261110235400 written in); _vol_cert_make, _vol_cert_make_session,
-- staff_volunteer_cert_issue_custom, volunteer_cert_check (20261108220000). No signature changes.
--
-- Rollback: re-run those definitions; drop the functions added here (staff_volunteer_details_save, volunteer_plan,
-- volunteer_coming, volunteer_feedback(text,text,text,integer,text,text), volunteer_motive, staff_volunteer_reason,
-- staff_volunteer_thanks, _vol_session_end, _vol_min_age, _vol_shift_reset, _vol_feedback_follow) and the triggers
-- volunteer_shifts_reset and volunteer_shifts_feedback_follow; take the volunteer_feedback line out of _purge_old; drop
-- table volunteer_feedback; restore volunteer_updates_kind_check and volunteer_log_action_check without the new values
-- (after deleting the rows that use them). The new columns may stay.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


/* -- 1. columns and the new table --------------------------------------------------------------- */
alter table public.volunteer_sessions
  add column if not exists meet_point    text check (char_length(meet_point) <= 200),
  add column if not exists meet_map      text check (char_length(meet_map) <= 500 and meet_map ~ '^https://'),
  add column if not exists bring         text check (char_length(bring) <= 500),
  add column if not exists provided      text check (char_length(provided) <= 300),
  add column if not exists shirt_pickup  text check (char_length(shirt_pickup) <= 200),
  add column if not exists demands       text check (char_length(demands) <= 300),
  add column if not exists contact_name  text check (char_length(contact_name) <= 80),
  add column if not exists contact_phone text check (char_length(contact_phone) <= 20),
  add column if not exists partner       text check (char_length(partner) <= 120),
  add column if not exists partner_ar    text check (char_length(partner_ar) <= 120),
  add column if not exists skills        text check (char_length(skills) <= 200),
  add column if not exists skills_ar     text check (char_length(skills_ar) <= 200),
  add column if not exists gender        text check (gender in ('female', 'male')),
  add column if not exists thanks_note   text check (char_length(thanks_note) <= 300),
  add column if not exists thanks_at     timestamptz,
  add column if not exists thanks_by     text check (char_length(thanks_by) <= 120);
comment on column public.volunteer_sessions.contact_name is 'The STAFF contact volunteers see on the day (decision 7), never another volunteer (20261111140000).';
comment on column public.volunteer_sessions.gender is 'female / male: only that gender may offer help (volunteer_interest refuses VOL_GENDER); null = anyone (20261111140000).';
comment on column public.volunteer_sessions.thanks_note is 'Staff''s line of thanks after the event, sent to everyone who worked it (staff_volunteer_thanks, 20261111140000).';

alter table public.volunteer_shifts
  add column if not exists plan_leave      text check (plan_leave ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column if not exists coming_at       timestamptz,
  add column if not exists withdraw_reason text check (withdraw_reason in ('sick', 'clash', 'travel', 'transport', 'other')),
  add column if not exists decline_reason  text check (decline_reason in ('full', 'age', 'timing', 'profile', 'other'));
comment on column public.volunteer_shifts.plan_leave is 'When the volunteer plans to leave for the event, HH:MM (volunteer_plan, 20261111140000).';
comment on column public.volunteer_shifts.coming_at is 'When the volunteer answered Yes to "Still coming?" (volunteer_coming, 20261111140000).';

alter table public.volunteers
  add column if not exists motive         text check (motive in ('community', 'learn', 'cv', 'people', 'active')),
  add column if not exists decline_reason text check (decline_reason in ('full', 'age', 'timing', 'profile', 'other'));
comment on column public.volunteers.decline_reason is 'Why the application was declined, shown to the person (staff_volunteer_reason, 20261111140000).';

alter table public.volunteer_certs
  add column if not exists role       text check (char_length(role) <= 40),
  add column if not exists skills     text check (char_length(skills) <= 200),
  add column if not exists skills_ar  text check (char_length(skills_ar) <= 200),
  add column if not exists partner    text check (char_length(partner) <= 120),
  add column if not exists partner_ar text check (char_length(partner_ar) <= 120);
comment on column public.volunteer_certs.role is 'The role on the event, stamped when an event''s certificate is issued; with skills and partner (20261111140000).';

create table if not exists public.volunteer_feedback (
  id          bigint generated always as identity primary key,
  shift_id    bigint not null unique references public.volunteer_shifts (id) on delete cascade,
  session_id  text not null references public.sessions (id) on update cascade on delete cascade,
  customer_id text not null references public.customers (id) on update cascade on delete cascade,
  rating      smallint not null check (rating between 1 and 5),
  again       text check (again in ('yes', 'maybe', 'no')),
  comment     text check (char_length(comment) <= 500),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.volunteer_feedback is
  'A volunteer''s optional rating of an event they worked, one per shift (volunteer_feedback(), 20261111140000). Staff read it.';
create index if not exists volunteer_feedback_session on public.volunteer_feedback (session_id);
alter table public.volunteer_feedback enable row level security;
revoke all on public.volunteer_feedback from public, anon, authenticated;
grant select on public.volunteer_feedback to authenticated;
drop policy if exists "staff read" on public.volunteer_feedback;
create policy "staff read" on public.volunteer_feedback for select using ((select _staff_mod('volunteers')));

alter table public.volunteer_updates drop constraint if exists volunteer_updates_kind_check;
alter table public.volunteer_updates add constraint volunteer_updates_kind_check
  check (kind in ('approved', 'accepted', 'declined', 'ended', 'briefing', 'reminder_day', 'reminder_soon', 'lead', 'reward', 'cancelled',
                  'not_approved', 'thanks'));

alter table public.volunteer_log drop constraint if exists volunteer_log_action_check;
alter table public.volunteer_log add constraint volunteer_log_action_check
  check (action in ('enter', 'list', 'scan', 'search', 'checkin', 'uncheckin', 'donated', 'undonated', 'clock_in', 'clock_out', 'agree', 'interest', 'withdraw', 'role',
                    'arrive', 'staff_accept', 'staff_decline', 'staff_in', 'staff_out', 'staff_times', 'staff_status', 'staff_noshow', 'staff_remove',
                    'staff_award', 'staff_hours', 'staff_void', 'staff_save', 'staff_session', 'staff_end',
                    'profile', 'team', 'lead_in', 'lead_out', 'lead_undo', 'staff_lead', 'reward', 'ended',
                    'plan', 'coming', 'feedback', 'motive', 'thanks', 'reason', 'details'));


/* -- 2. helpers and triggers --------------------------------------------------------------------- */
-- The session's end as staff typed it ("17:00 - 23:00" ends 23:00, "6:00 PM - 9:30 PM" 21:30), in Saudi time; past
-- midnight when it is not after the start; null when only a start is given. The start is _vol_session_start's.
create or replace function public._vol_session_end(p_date text, p_slots text)
 returns timestamptz
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare m text[]; _h int; _start timestamptz; _end timestamptz;
begin
  _start := _vol_session_start(p_date, p_slots);
  if _start is null then return null; end if;
  select r.hit into m from regexp_matches(coalesce(_vol_time(p_slots), ''), '(\d{1,2})[:.](\d{2})\s*([AaPp][Mm])?', 'g') as r(hit) offset 1 limit 1;
  if m is null then return null; end if;
  _h := m[1]::int;
  if m[3] is not null then _h := _h % 12 + case when lower(m[3]) = 'pm' then 12 else 0 end; end if;
  if _h > 23 or m[2]::int > 59 then return null; end if;
  _end := (left(p_date, 10) || ' ' || lpad(_h::text, 2, '0') || ':' || m[2] || ':00+03')::timestamptz;
  if _end <= _start then _end := _end + interval '1 day'; end if;
  return _end;
end $function$;
revoke all on function public._vol_session_end(text, text) from public, anon, authenticated;

-- The youngest age that may volunteer: the setting min_age, 18 when it is not set (decision 3). 0 = no limit.
create or replace function public._vol_min_age()
 returns integer
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(case when (_vol_settings() ->> 'min_age') ~ '^\d{1,2}$' then (_vol_settings() ->> 'min_age')::int end, 18);
$function$;
revoke all on function public._vol_min_age() from public, anon, authenticated;

-- A shift that changes status starts a new round: the reasons and the plan of the last one go, unless the same update
-- writes them (volunteer_coming's No writes the withdraw reason with the status).
create or replace function public._vol_shift_reset()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if new.status is distinct from old.status then
    if new.decline_reason is not distinct from old.decline_reason then new.decline_reason := null; end if;
    if new.withdraw_reason is not distinct from old.withdraw_reason then new.withdraw_reason := null; end if;
    if new.status in ('interested', 'accepted') and old.status not in ('interested', 'accepted') then
      if new.plan_leave is not distinct from old.plan_leave then new.plan_leave := null; end if;
      if new.coming_at is not distinct from old.coming_at then new.coming_at := null; end if;
    end if;
  end if;
  return new;
end $function$;
revoke all on function public._vol_shift_reset() from public, anon, authenticated;
drop trigger if exists volunteer_shifts_reset on public.volunteer_shifts;
create trigger volunteer_shifts_reset before update of status on public.volunteer_shifts
  for each row execute function public._vol_shift_reset();

-- A rating belongs to its shift: when the shift moves (staff_move_session moves shifts before deleting the old session;
-- a merge moves them to the account kept, an unmerge back), the rating goes with it.
create or replace function public._vol_feedback_follow()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  update volunteer_feedback f set session_id = new.session_id, customer_id = new.customer_id
   where f.shift_id = new.id and (f.session_id is distinct from new.session_id or f.customer_id is distinct from new.customer_id);
  return null;
end $function$;
revoke all on function public._vol_feedback_follow() from public, anon, authenticated;
drop trigger if exists volunteer_shifts_feedback_follow on public.volunteer_shifts;
create trigger volunteer_shifts_feedback_follow after update of session_id, customer_id on public.volunteer_shifts
  for each row when (old.session_id is distinct from new.session_id or old.customer_id is distinct from new.customer_id)
  execute function public._vol_feedback_follow();

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
    /* a session called off (20261110235400) */
    when 'cancelled'     then 'The opportunity on ' || _d || ' has been cancelled. Thank you for offering. | أُلغيت فرصة يوم ' || _dm || '. شكرًا لعرضك المساعدة.'
    when 'lead'          then 'You lead the volunteer team on ' || _d || '. | أنت قائد فريق المتطوعين يوم ' || _dm || '.'
    when 'reward'        then 'Thank you for volunteering. Your certificate and free ride are ready. | شكرًا لتطوعك. شهادتك وجولتك المجانية جاهزتان.'
    /* an application declined, and staff's thanks after an event (20261111140000) */
    when 'not_approved'  then 'Thank you for applying to volunteer with MicroMobility. We cannot take you on this time. | شكرًا لتقديمك للتطوع مع مايكروموبيليتي. لا يمكننا قبولك هذه المرة.'
    when 'thanks'        then 'Thank you for volunteering on ' || _d || '. Our team has a note for you. | شكرًا لتطوعك يوم ' || _dm || '. لديك رسالة من فريقنا.'
  end;
  if _b is not null then
    perform _push_queue(p_cust, 'vol-' || _id || '-' || to_char(now(), 'YYYYMMDDHH24MISS'), 'MicroMobility Volunteers', _b,
                        'https://volunteer.micromobility.sa/#updates');
  end if;
end $function$;
revoke all on function public._vol_note(text, text, text, jsonb) from public, anon, authenticated;

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
    -- a decline or an end carries staff's reason, null until they give one (staff_volunteer_reason, 20261111140000)
    perform _vol_note(new.customer_id, new.session_id, new.status,
                      jsonb_build_object('role', new.role)
                      || case when new.status in ('declined', 'ended') then jsonb_build_object('reason', new.decline_reason) else '{}'::jsonb end);
  end if;
  if new.lead and not coalesce(_lead, false) then
    perform _vol_note(new.customer_id, new.session_id, 'lead');
  end if;
  return null;
end $function$;
revoke all on function public._vol_shift_notes() from public, anon, authenticated;

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
  -- An application declined is said too, with staff's reason when they gave one (20261111140000).
  if new.status = 'removed' and _was = 'applied' then
    perform _vol_note(new.customer_id, null, 'not_approved', jsonb_build_object('reason', new.decline_reason));
  end if;
  return null;
end $function$;
revoke all on function public._vol_person_notes() from public, anon, authenticated;


/* -- 3. the portal ------------------------------------------------------------------------------- */
-- What anyone signed in may read: the opportunities, with each role's need and how many are on it, and what to know
-- before the day (20261111140000; the staff contact is for the team only, volunteer_me).
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
                            from jsonb_array_elements(w.role_needs) e),
           'meet_point', case when s.reveal_at is null or s.reveal_at <= now() then w.meet_point end, -- as the location
           'meet_map', case when s.reveal_at is null or s.reveal_at <= now() then w.meet_map end,
           'bring', w.bring, 'provided', w.provided, 'shirt_pickup', w.shirt_pickup, 'demands', w.demands,
           'partner', w.partner, 'partner_ar', w.partner_ar, 'skills', w.skills, 'skills_ar', w.skills_ar, 'gender', w.gender
         ) order by s.session_date, s.id), '[]'::jsonb)
    from volunteer_sessions w join sessions s on s.id = w.session_id
   where w.enabled and now() < w.closes_at and s.cancelled_at is null;
$function$;

-- The profile: the days usually free (at least one), skills and T-shirt size; the account's birth date and emergency contact
-- must be there already. Saving it again keeps it up to date and never changes the status. A first profile needs the age
-- (20261111140000: min_age, 18 unless staff set another).
create or replace function public.volunteer_apply(p_id text, p_token text, p_skills text default null::text, p_days integer[] default null::integer[], p_shirt text default null::text, p_whatsapp text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v volunteers%rowtype; c record; _days smallint[]; _wa text; _shirt text; _min int := _vol_min_age();
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  select x.must_change_pwd, x.deletion_requested_at, x.birth_date, x.emergency_name, x.emergency_phone into c from customers x where x.id = p_id;
  if coalesce(c.must_change_pwd, false) or c.deletion_requested_at is not null then raise exception 'VOL_ACCOUNT' using errcode = '42501'; end if;
  select * into v from volunteers where customer_id = p_id for update;
  if found and v.status in ('paused', 'removed') then raise exception 'VOL_NOT_VOLUNTEER' using errcode = '42501'; end if;
  if coalesce(c.birth_date, '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'VOL_DOB' using errcode = 'P0001'; end if;
  if coalesce(btrim(c.emergency_name), '') = '' or coalesce(btrim(c.emergency_phone), '') = '' then raise exception 'VOL_EMERGENCY' using errcode = 'P0001'; end if;
  -- Old enough, on a first profile only: someone who already has one keeps it (decision 3, 20261111140000).
  if v.profile_at is null and _min > 0 and left(c.birth_date, 10)::date + make_interval(years => _min) > _vol_today() then
    raise exception 'VOL_AGE' using errcode = 'P0001';
  end if;
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
        _cfg jsonb := _vol_settings(); _min int;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  select x.must_change_pwd, x.deletion_requested_at, x.birth_date, x.gender into c from customers x where x.id = p_id;
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
  -- Old enough on the day: the settings' min_age (18 unless staff set another, decision 3) or the opportunity's own,
  -- whichever is higher (20261111140000).
  _min := greatest(_vol_min_age(), coalesce(w.min_age, 0));
  if _min > 0 then
    if coalesce(c.birth_date, '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'VOL_DOB' using errcode = 'P0001'; end if;
    select x.session_date into _day from sessions x where x.id = p_session;
    if left(c.birth_date, 10)::date + make_interval(years => _min)
       > coalesce(case when coalesce(_day, '') ~ '^\d{4}-\d{2}-\d{2}' then left(_day, 10)::date end, _vol_today()) then
      raise exception 'VOL_AGE' using errcode = 'P0001';
    end if;
  end if;
  -- A women-only or men-only opportunity (decision 12): anyone else, or an account with no gender, is refused.
  if w.gender is not null and _vol_gender(c.gender) is distinct from w.gender then raise exception 'VOL_GENDER' using errcode = 'P0001'; end if;
  _stop := coalesce(nullif(_cfg ->> 'noshow_stop', '')::numeric, 0)::int;
  -- Accepted at once: someone staff trust, or (auto_returning, on unless staff turn it off; decision 10) anyone who has
  -- already worked an event. The no-show limit holds for both.
  _auto := (coalesce(v.auto_accept, false)
            or (coalesce(_cfg ->> 'auto_returning', 'true') <> 'false'
                and exists (select 1 from volunteer_shifts x where x.customer_id = p_id and x.status = 'done')))
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

-- "What time will you leave?" on an accepted shift: HH:MM (24 h), or nothing to take it back.
create or replace function public.volunteer_plan(p_id text, p_token text, p_session text, p_leave text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare sh volunteer_shifts%rowtype; _t text := nullif(btrim(coalesce(p_leave, '')), ''); m text[];
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  if _t is not null then
    m := regexp_match(_t, '^(\d{1,2}):(\d{2})$');
    if m is null or m[1]::int > 23 or m[2]::int > 59 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
    _t := lpad(m[1], 2, '0') || ':' || m[2];
  end if;
  select * into sh from volunteer_shifts where session_id = p_session and customer_id = p_id for update;
  if not found or sh.status <> 'accepted' then raise exception 'VOL_NOT_ACCEPTED' using errcode = '42501'; end if;
  update volunteer_shifts set plan_leave = _t, updated_at = now() where id = sh.id;
  perform _vol_log(p_id, p_session, 'plan');
  return jsonb_build_object('ok', true, 'plan_leave', _t);
end $function$;

-- "Still coming?" on an accepted shift, until the session starts. Yes stamps coming_at (the first answer stands);
-- No withdraws, with an optional reason, and gives up the lead, as volunteer_interest's withdraw does.
create or replace function public.volunteer_coming(p_id text, p_token text, p_session text, p_yes boolean, p_reason text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare sh volunteer_shifts%rowtype; w volunteer_sessions%rowtype; s record; _start timestamptz; _at timestamptz;
        _r text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  if p_yes is null or (_r is not null and _r not in ('sick', 'clash', 'travel', 'transport', 'other')) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  select * into sh from volunteer_shifts where session_id = p_session and customer_id = p_id for update;
  if found and sh.status = 'withdrawn' and not p_yes then return jsonb_build_object('ok', true, 'noop', true, 'status', 'withdrawn'); end if;
  if sh.id is null or sh.status <> 'accepted' then raise exception 'VOL_NOT_ACCEPTED' using errcode = '42501'; end if;
  if sh.clock_in is not null then raise exception 'VOL_ALREADY_IN' using errcode = 'P0001'; end if;
  select * into w from volunteer_sessions where session_id = p_session;
  select x.session_date, x.bike_slots, x.cancelled_at into s from sessions x where x.id = p_session;
  -- the start as _vol_tick reads it: the time staff gave the session, else when volunteers may start
  _start := coalesce(_vol_session_start(s.session_date, s.bike_slots), _vol_starts(w.opens_at, s.session_date));
  if s.cancelled_at is not null or now() >= coalesce(_start, 'infinity'::timestamptz) or now() >= coalesce(w.closes_at, 'infinity'::timestamptz) then
    raise exception 'VOL_CLOSED' using errcode = '42501';
  end if;
  if p_yes then
    update volunteer_shifts set coming_at = coalesce(coming_at, now()), updated_at = now() where id = sh.id returning coming_at into _at;
    perform _vol_log(p_id, p_session, 'coming');
    return jsonb_build_object('ok', true, 'coming_at', _at);
  end if;
  update volunteer_shifts set status = 'withdrawn', withdraw_reason = _r, lead = false, updated_at = now() where id = sh.id;
  perform _vol_log(p_id, p_session, 'withdraw');
  return jsonb_build_object('ok', true, 'status', 'withdrawn');
end $function$;

-- "How was it?": a shift done, or accepted on a session whose day has passed. One per shift; sending again changes it.
-- Optional: nothing waits on it, the certificate least of all (decision 6).
create or replace function public.volunteer_feedback(p_id text, p_token text, p_session text, p_rating integer, p_again text default null::text, p_comment text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare sh volunteer_shifts%rowtype; s record; _again text := nullif(btrim(coalesce(p_again, '')), ''); _c text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  if p_rating is null or p_rating not between 1 and 5 or (_again is not null and _again not in ('yes', 'maybe', 'no'))
     or char_length(_c) > 500 then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  select * into sh from volunteer_shifts where session_id = p_session and customer_id = p_id;
  select x.session_date, x.cancelled_at into s from sessions x where x.id = p_session;
  if sh.id is null or not (sh.status = 'done'
       or (sh.status = 'accepted' and s.cancelled_at is null
           and coalesce(case when coalesce(s.session_date, '') ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date, 10)::date < _vol_today() end, false))) then
    raise exception 'VOL_NOT_ACCEPTED' using errcode = '42501';
  end if;
  insert into volunteer_feedback (shift_id, session_id, customer_id, rating, again, comment)
  values (sh.id, sh.session_id, sh.customer_id, p_rating, _again, _c)
  on conflict (shift_id) do update set rating = excluded.rating, again = excluded.again, comment = excluded.comment, updated_at = now();
  perform _vol_log(p_id, p_session, 'feedback');
  return jsonb_build_object('ok', true);
end $function$;

-- The one motive question: what the volunteer most wants from it. Private to them; null takes it back.
create or replace function public.volunteer_motive(p_id text, p_token text, p_motive text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _m text := nullif(btrim(coalesce(p_motive, '')), '');
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  if _m is not null and _m not in ('community', 'learn', 'cv', 'people', 'active') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  update volunteers set motive = _m, updated_at = now() where customer_id = p_id;
  if not found then raise exception 'VOL_PROFILE' using errcode = 'P0001'; end if;
  perform _vol_log(p_id, '', 'motive');
  return jsonb_build_object('ok', true, 'motive', _m);
end $function$;

create or replace function public.volunteer_me(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v volunteers%rowtype; c record; _cfg jsonb := _vol_settings(); _ok boolean; _mine jsonb; _rec jsonb; _sum record; _ev jsonb;
        _today date := _vol_today(); _y int; _team jsonb; _extra jsonb;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return null; end if;
  _y := extract(year from _today)::int;
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
           'cancelled', s.cancelled_at is not null,
           'can_work', _ok and w.enabled and s.cancelled_at is null and sh.status in ('accepted', 'done') and now() < w.closes_at and now() >= _vol_starts(w.opens_at, s.session_date),
           -- what the event gave (20261109120000)
           'reward', (select jsonb_build_object('code', p.code, 'expires_at', p.expires_at, 'used', coalesce(p.uses, 0) > 0)
                        from promo_codes p where p.customer_id = p_id and p.volunteer_session_id = sh.session_id and p.active limit 1),
           'cert', (select jsonb_build_object('serial', vc.serial, 'hours', vc.hours) from volunteer_certs vc
                     where vc.customer_id = p_id and vc.session_id = sh.session_id and vc.kind = 'session' and vc.revoked_at is null
                     order by vc.issued_at desc limit 1)
         ) || jsonb_build_object(
           -- the volunteer's own answers, staff's reasons and thanks, and what the event did (20261111140000)
           'plan_leave', sh.plan_leave, 'coming_at', sh.coming_at, 'withdraw_reason', sh.withdraw_reason,
           'reason', case when sh.status in ('declined', 'ended') then sh.decline_reason end,
           'feedback', (select jsonb_build_object('rating', f.rating, 'again', f.again) from volunteer_feedback f where f.shift_id = sh.id),
           'thanks', case when sh.status = 'done' and w.thanks_note is not null then jsonb_build_object('note', w.thanks_note, 'at', w.thanks_at) end,
           'impact', case when a.worked and a.over then jsonb_build_object(
                        'checked_in', (select count(*) from queue_entries q where q.session_id = s.id and q.status in ('active', 'done')),
                        'donated', case when coalesce(s.ride_kind, '') = 'blood'
                                        then (select count(*) from queue_entries q where q.session_id = s.id and q.donated_at is not null) end) end,
           -- for the team only: who to call, where to meet, what to bring, when it ends (20261111140000)
           'contact_name', case when a.team then w.contact_name end,
           'contact_phone', case when a.team then w.contact_phone end,
           'meet_point', case when a.team and (s.reveal_at is null or s.reveal_at <= now()) then w.meet_point end,
           'meet_map', case when a.team and (s.reveal_at is null or s.reveal_at <= now()) then w.meet_map end,
           'bring', case when a.team then w.bring end,
           'provided', case when a.team then w.provided end,
           'shirt_pickup', case when a.team then w.shirt_pickup end,
           'demands', case when a.team then w.demands end,
           'ends_at', case when a.team then a.ends_at end)
         order by s.session_date desc, s.id), '[]'::jsonb)
    into _mine
    from volunteer_shifts sh
    join sessions s on s.id = sh.session_id
    join volunteer_sessions w on w.session_id = sh.session_id
    cross join lateral (select sh.status in ('accepted', 'done') as team,
                               s.cancelled_at is null and (sh.status = 'done' or (sh.status = 'accepted' and sh.clock_in is not null)) as worked,
                               _vol_session_end(s.session_date, s.bike_slots) as ends_at) a0
    cross join lateral (select a0.team, a0.worked, a0.ends_at,
                               now() >= w.closes_at or now() >= coalesce(a0.ends_at, 'infinity'::timestamptz)
                               or coalesce(case when s.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date, 10)::date < _today end, false) as over) a
   where sh.customer_id = p_id and sh.status <> 'blocked';
  select coalesce(jsonb_agg(x.j order by x.d desc, x.i desc), '[]'::jsonb) into _rec
    from (select h.id i, h.worked_on d,
                 jsonb_build_object('id', h.id, 'hours', h.hours, 'on', h.worked_on, 'note', h.note, 'session_id', h.session_id,
                                    'title', s.title, 'ride_kind', s.ride_kind, 'event_kind', s.event_kind) j
            from volunteer_hours h left join sessions s on s.id = h.session_id
           where h.customer_id = p_id and h.voided_at is null
           order by h.worked_on desc, h.id desc limit 30) x;
  /* every event worked, its hours added up, uncapped: one certificate and one free ride each (20261110235400) */
  select coalesce(jsonb_agg(jsonb_build_object('session_id', e.session_id, 'hours', e.hours, 'on', e.on_,
                                               'title', s.title, 'ride_kind', s.ride_kind) order by e.on_ desc, e.session_id), '[]'::jsonb)
    into _ev
    from (select h.session_id, sum(h.hours) hours, min(h.worked_on) on_
            from volunteer_hours h
           where h.customer_id = p_id and h.voided_at is null and h.session_id is not null
           group by h.session_id having sum(h.hours) > 0) e
    left join sessions s on s.id = e.session_id;
  select min(h.worked_on) first_on, max(h.worked_on) last_on, count(distinct h.session_id) sessions into _sum
    from volunteer_hours h where h.customer_id = p_id and h.voided_at is null;
  -- What the whole team gave this year, in Saudi time: totals only, never a name or a rank (20261111140000).
  select jsonb_build_object('hours', coalesce(sum(t.h), 0), 'volunteers', count(*) filter (where t.h > 0),
                            'events', (select count(distinct sh.session_id) from volunteer_shifts sh join sessions s on s.id = sh.session_id
                                        where sh.status = 'done' and left(s.session_date, 4) = _y::text))
    into _team
    from (select h.customer_id, sum(h.hours) h from volunteer_hours h
           where h.voided_at is null and h.worked_on >= make_date(_y, 1, 1) and h.worked_on < make_date(_y + 1, 1, 1)
           group by h.customer_id) t;
  -- Hours staff gave with no event, so the cards add up to the total; never staff's note (20261111140000).
  select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'on', h.worked_on, 'hours', h.hours) order by h.worked_on desc, h.id desc), '[]'::jsonb)
    into _extra
    from volunteer_hours h where h.customer_id = p_id and h.voided_at is null and h.session_id is null;
  return jsonb_build_object(
    'id', p_id, 'name', c.name, 'hours', c.hours, 'account', c.account,
    'status', case when v.customer_id is null then null when v.status = 'active' and not _ok then 'expired' else v.status end,
    'profile', v.profile_at is not null,
    'agreed', v.agreed_version is not distinct from _vol_agreement_v() and v.customer_id is not null,
    'promote', coalesce((_cfg ->> 'promote')::boolean, false),
    'open_count', (select count(*) from volunteer_sessions w join sessions s on s.id = w.session_id where w.enabled and now() < w.closes_at and s.cancelled_at is null),
    'unread', (select count(*) from volunteer_updates u where u.customer_id = p_id and u.read_at is null),
    'mine', _mine, 'record', _rec, 'events', _ev, 'first_on', _sum.first_on, 'last_on', _sum.last_on, 'sessions', _sum.sessions,
    'cert_signer', _cfg ->> 'cert_signer', 'cert_title', _cfg ->> 'cert_title',
    'team', _team, 'extra_hours', _extra);
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
                          where sh.customer_id = p_id and sh.briefed_at is not null), '{}'::jsonb),
    -- the motive question, and staff's reason when the application was declined (20261111140000)
    'motive', v.motive,
    'reason', case when v.status = 'removed' then v.decline_reason end);
end $function$;

-- The portal's Updates: the newest 50, and how many are unread. A signed-out call answers VOL_TOKEN. A decline, an end and
-- an application declined always carry data.reason, a code or null (20261111140000).
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
                                                           'ride_kind', s.ride_kind, 'date', s.session_date,
                                                           'data', case when u.kind in ('declined', 'ended', 'not_approved')
                                                                        then jsonb_build_object('reason', null::text) || u.data else u.data end,
                                                           'at', u.created_at, 'read', u.read_at is not null)
                                        order by u.created_at desc, u.id desc), '[]'::jsonb)
                from (select * from volunteer_updates x where x.customer_id = p_id order by x.created_at desc, x.id desc limit 50) u
                left join sessions s on s.id = u.session_id),
    'unread', (select count(*) from volunteer_updates x where x.customer_id = p_id and x.read_at is null));
end $function$;


/* -- 4. staff ------------------------------------------------------------------------------------ */
-- What to know before the day, for one opportunity. A key left out keeps its value; null or '' clears it; text is trimmed.
-- Answers all thirteen as they now stand.
create or replace function public.staff_volunteer_details_save(p_session text, p_data jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare w volunteer_sessions%rowtype; i int; k text; j jsonb; _t text; _d jsonb := '{}'::jsonb;
        _keys text[] := array['meet_point', 'meet_map', 'bring', 'provided', 'shirt_pickup', 'demands', 'contact_name', 'contact_phone',
                              'partner', 'partner_ar', 'skills', 'skills_ar', 'gender'];
        _max int[] := array[200, 500, 500, 300, 200, 300, 80, 20, 120, 120, 200, 200, 6];
begin
  if not ((select _staff_mod('volunteers', true)) or (select _staff_mod('queue', true))) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  select * into w from volunteer_sessions where session_id = p_session for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  for i in 1 .. array_length(_keys, 1) loop
    k := _keys[i];
    continue when not (p_data ? k);
    j := p_data -> k;
    if jsonb_typeof(j) not in ('string', 'null') then raise exception 'BAD_INPUT' using errcode = '22023', detail = k; end if;
    _t := nullif(btrim(coalesce(j #>> '{}', '')), '');
    if char_length(_t) > _max[i] then raise exception 'BAD_INPUT' using errcode = '22023', detail = k; end if;
    if k = 'meet_map' and _t !~ '^https://[^\s<>"]+$' then raise exception 'BAD_INPUT' using errcode = '22023', detail = k; end if;
    if k = 'contact_phone' and (_t !~ '^[0-9+() -]+$' or length(regexp_replace(_t, '[^0-9]', '', 'g')) < 7) then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = k;
    end if;
    if k = 'gender' and _t is not null then
      _t := _vol_gender(_t);
      if _t is null then raise exception 'BAD_INPUT' using errcode = '22023', detail = k; end if;
    end if;
    _d := _d || jsonb_build_object(k, _t);
  end loop;
  update volunteer_sessions set
    meet_point    = case when _d ? 'meet_point'    then _d ->> 'meet_point'    else meet_point end,
    meet_map      = case when _d ? 'meet_map'      then _d ->> 'meet_map'      else meet_map end,
    bring         = case when _d ? 'bring'         then _d ->> 'bring'         else bring end,
    provided      = case when _d ? 'provided'      then _d ->> 'provided'      else provided end,
    shirt_pickup  = case when _d ? 'shirt_pickup'  then _d ->> 'shirt_pickup'  else shirt_pickup end,
    demands       = case when _d ? 'demands'       then _d ->> 'demands'       else demands end,
    contact_name  = case when _d ? 'contact_name'  then _d ->> 'contact_name'  else contact_name end,
    contact_phone = case when _d ? 'contact_phone' then _d ->> 'contact_phone' else contact_phone end,
    partner       = case when _d ? 'partner'       then _d ->> 'partner'       else partner end,
    partner_ar    = case when _d ? 'partner_ar'    then _d ->> 'partner_ar'    else partner_ar end,
    skills        = case when _d ? 'skills'        then _d ->> 'skills'        else skills end,
    skills_ar     = case when _d ? 'skills_ar'     then _d ->> 'skills_ar'     else skills_ar end,
    gender        = case when _d ? 'gender'        then _d ->> 'gender'        else gender end,
    updated_at = now(), updated_by = _vol_op()
   where session_id = p_session
  returning * into w;
  perform _vol_slog(null, p_session, 'details');
  return jsonb_build_object('ok', true, 'details', jsonb_build_object(
    'meet_point', w.meet_point, 'meet_map', w.meet_map, 'bring', w.bring, 'provided', w.provided, 'shirt_pickup', w.shirt_pickup,
    'demands', w.demands, 'contact_name', w.contact_name, 'contact_phone', w.contact_phone, 'partner', w.partner, 'partner_ar', w.partner_ar,
    'skills', w.skills, 'skills_ar', w.skills_ar, 'gender', w.gender));
end $function$;

-- Why staff said no (decision 9), from a fixed list; null takes it back. With a session: that person's declined or ended
-- offer. Without: their declined application (status removed). The Update that told them gets the reason too.
create or replace function public.staff_volunteer_reason(p_customer text, p_session text default null::text, p_reason text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _r text := nullif(btrim(coalesce(p_reason, '')), ''); sh volunteer_shifts%rowtype; v volunteers%rowtype; _u bigint;
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if _r is not null and _r not in ('full', 'age', 'timing', 'profile', 'other') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  if p_session is not null then
    select * into sh from volunteer_shifts where session_id = p_session and customer_id = p_customer for update;
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if sh.status not in ('declined', 'ended') then raise exception 'BAD_STATUS' using errcode = '22023'; end if;
    update volunteer_shifts set decline_reason = _r, updated_at = now(), updated_by = _vol_op() where id = sh.id;
    select u.id into _u from volunteer_updates u
     where u.customer_id = p_customer and u.session_id = p_session and u.kind in ('declined', 'ended')
     order by u.created_at desc, u.id desc limit 1;
  else
    select * into v from volunteers where customer_id = p_customer for update;
    if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
    if v.status <> 'removed' then raise exception 'BAD_STATUS' using errcode = '22023'; end if;
    update volunteers set decline_reason = _r, updated_at = now() where customer_id = p_customer;
    select u.id into _u from volunteer_updates u
     where u.customer_id = p_customer and u.session_id is null and u.kind = 'not_approved'
     order by u.created_at desc, u.id desc limit 1;
  end if;
  if _u is not null then
    update volunteer_updates set data = data || jsonb_build_object('reason', _r) where id = _u;
  end if;
  perform _vol_slog(p_customer, p_session, 'reason');
  return jsonb_build_object('ok', true, 'reason', _r);
end $function$;

-- The close-out thanks: one line from staff to everyone who worked the event (a done shift), as an Update. Sent again,
-- the line changes on the session and in the Updates already sent; nobody gets a second one.
create or replace function public.staff_volunteer_thanks(p_session text, p_note text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _n text := nullif(btrim(coalesce(p_note, '')), ''); _op text := left(coalesce(_vol_op(), 'staff'), 120); r record;
        _sent int := 0; _new int := 0;
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if _n is null or char_length(_n) > 300 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  update volunteer_sessions set thanks_note = _n, thanks_at = now(), thanks_by = _op, updated_at = now(), updated_by = _op
   where session_id = p_session;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  for r in select sh.customer_id from volunteer_shifts sh where sh.session_id = p_session and sh.status = 'done' loop
    update volunteer_updates u set data = jsonb_build_object('note', _n)
     where u.customer_id = r.customer_id and u.session_id = p_session and u.kind = 'thanks';
    if not found then
      perform _vol_note(r.customer_id, p_session, 'thanks', jsonb_build_object('note', _n));
      _new := _new + 1;
    end if;
    _sent := _sent + 1;
  end loop;
  perform _vol_slog(null, p_session, 'thanks');
  return jsonb_build_object('ok', true, 'sent', _sent, 'new', _new);
end $function$;

-- The section's settings. Only the known keys, within their shapes. noshow_stop: VL09. min_age (0-99, null = 18) and
-- auto_returning (true / false, null = on) since 20261111140000.
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
  if p_data ? 'min_age' then
    if jsonb_typeof(p_data -> 'min_age') = 'null' then
      _d := _d || jsonb_build_object('min_age', null::int);
    elsif jsonb_typeof(p_data -> 'min_age') in ('number', 'string') and (p_data ->> 'min_age') ~ '^\s*\d{1,2}\s*$' then
      _d := _d || jsonb_build_object('min_age', btrim(p_data ->> 'min_age')::int);
    else
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'min_age';
    end if;
  end if;
  if p_data ? 'auto_returning' then
    if jsonb_typeof(p_data -> 'auto_returning') = 'null' then
      _d := _d || jsonb_build_object('auto_returning', null::boolean);
    elsif jsonb_typeof(p_data -> 'auto_returning') = 'boolean' or (p_data ->> 'auto_returning') in ('true', 'false') then
      _d := _d || jsonb_build_object('auto_returning', (p_data ->> 'auto_returning')::boolean);
    else
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'auto_returning';
    end if;
  end if;
  update volunteer_settings set data = data || _d, updated_at = now(), updated_by = _vol_op() where id = 1;
  return jsonb_build_object('ok', true);
end $function$;


/* -- 5. certificates: the role, the skills and the partner -------------------------------------- */
-- The certificate for a period: unchanged but for the five keys every printed certificate now answers (null here).
create or replace function public._vol_cert_make(p_customer text, p_from date, p_to date, p_by text, p_gender text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _name text; _name_ar text; _gender text; _h numeric; _s jsonb; _code text; _id bigint; _serial text; _w jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to > _vol_today() or p_to - p_from > 3660 then
    raise exception 'BAD_DATE' using errcode = '22023';
  end if;
  select c.name, c.name_ar, c.gender into _name, _name_ar, _gender
    from customers c where c.id = p_customer and c.merged_into is null;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  -- What staff said wins over what the account holds: they are looking at the person.
  _gender := _vol_gender(coalesce(nullif(btrim(coalesce(p_gender, '')), ''), _gender));
  _w := _vol_cert_words(_gender);
  select coalesce(sum(h.hours), 0) into _h from volunteer_hours h
   where h.customer_id = p_customer and h.voided_at is null and h.worked_on between p_from and p_to;
  if _h <= 0 then raise exception 'VOL_CERT_EMPTY' using errcode = 'P0001'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('title', x.title, 'ride_kind', x.ride_kind, 'date', x.d, 'hours', x.h) order by x.d, x.title), '[]'::jsonb) into _s
    from (select s.title, s.ride_kind, min(h.worked_on) d, sum(h.hours) h
            from volunteer_hours h join sessions s on s.id = h.session_id
           where h.customer_id = p_customer and h.voided_at is null and h.worked_on between p_from and p_to
           group by s.id, s.title, s.ride_kind having sum(h.hours) > 0) x;
  _code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into volunteer_certs (serial, code, customer_id, name, name_ar, gender, words, period_from, period_to, hours, sessions, issued_by)
  values ('pending-' || _code, _code, p_customer, left(coalesce(nullif(btrim(_name), ''), '-'), 120),
          left(nullif(btrim(coalesce(_name_ar, '')), ''), 120), _gender, _w, p_from, p_to, _h, _s, p_by)
  returning id into _id;
  _serial := 'MMV-' || to_char(_vol_today(), 'YYYY') || '-' || lpad(_id::text, 5, '0');
  update volunteer_certs set serial = _serial where id = _id;
  return jsonb_build_object('ok', true, 'id', _id, 'kind', 'period', 'serial', _serial, 'code', _code,
    'name', _name, 'name_ar', nullif(btrim(coalesce(_name_ar, '')), ''), 'gender', _gender, 'words', _w,
    'from', p_from, 'to', p_to, 'hours', _h, 'sessions', _s, 'issued_at', now(),
    'role', null::text, 'skills', null::text, 'skills_ar', null::text, 'partner', null::text, 'partner_ar', null::text);
end $function$;
revoke all on function public._vol_cert_make(text, date, date, text, text) from public, anon, authenticated;

-- The certificate for one event, now stamped with the volunteer's role on it and the event's skills and partner, as they
-- are when it is issued (20261111140000). One issued before keeps what it said.
create or replace function public._vol_cert_make_session(p_customer text, p_session text, p_initiative text, p_by text, p_gender text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _name text; _name_ar text; _gender text; _title text; _date date; _kind text; _h numeric;
        _code text; _id bigint; _serial text; _s jsonb; _w jsonb; _old volunteer_certs%rowtype;
        _role text; _sk text; _sk_ar text; _pa text; _pa_ar text;
begin
  select c.name, c.name_ar, c.gender into _name, _name_ar, _gender
    from customers c where c.id = p_customer and c.merged_into is null;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  -- Asked for twice, it is the same certificate: the one they already have, so a second press of
  -- "make one for the team" prints rather than issues.
  select * into _old from volunteer_certs c
   where c.customer_id = p_customer and c.session_id = p_session and c.kind = 'session' and c.revoked_at is null
   order by c.issued_at desc limit 1;
  if found then
    return jsonb_build_object('ok', true, 'id', _old.id, 'kind', 'session', 'serial', _old.serial, 'code', _old.code,
      'name', _old.name, 'name_ar', _old.name_ar, 'gender', _old.gender, 'words', _old.words, 'session_id', _old.session_id,
      'initiative', _old.initiative, 'event_date', _old.event_date, 'from', _old.period_from, 'to', _old.period_to,
      'hours', _old.hours, 'sessions', _old.sessions, 'issued_at', _old.issued_at, 'again', true,
      'role', _old.role, 'skills', _old.skills, 'skills_ar', _old.skills_ar, 'partner', _old.partner, 'partner_ar', _old.partner_ar);
  end if;
  _gender := _vol_gender(coalesce(nullif(btrim(coalesce(p_gender, '')), ''), _gender));
  _w := _vol_cert_words(_gender);
  select s.title, s.session_date, s.ride_kind into _title, _date, _kind from sessions s where s.id = p_session;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if _date is null or _date > _vol_today() then raise exception 'BAD_DATE' using errcode = '22023'; end if;
  -- They must have been on it: an hour recorded, or a shift that finished.
  select coalesce(sum(h.hours), 0) into _h from volunteer_hours h
   where h.customer_id = p_customer and h.session_id = p_session and h.voided_at is null;
  if _h <= 0 and not exists (select 1 from volunteer_shifts sh
                              where sh.session_id = p_session and sh.customer_id = p_customer and sh.status = 'done') then
    raise exception 'VOL_CERT_EMPTY' using errcode = 'P0001';
  end if;
  _title := left(coalesce(nullif(btrim(coalesce(p_initiative, '')), ''), nullif(btrim(coalesce(_title, '')), ''), p_session), 80);
  _s := jsonb_build_array(jsonb_build_object('title', _title, 'ride_kind', _kind, 'date', _date, 'hours', _h));
  -- the role they had, the skills and the partner the event names (20261111140000)
  select left(nullif(btrim(coalesce(sh.role, '')), ''), 40) into _role
    from volunteer_shifts sh where sh.session_id = p_session and sh.customer_id = p_customer;
  select left(nullif(btrim(coalesce(w.skills, '')), ''), 200), left(nullif(btrim(coalesce(w.skills_ar, '')), ''), 200),
         left(nullif(btrim(coalesce(w.partner, '')), ''), 120), left(nullif(btrim(coalesce(w.partner_ar, '')), ''), 120)
    into _sk, _sk_ar, _pa, _pa_ar
    from volunteer_sessions w where w.session_id = p_session;
  _code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into volunteer_certs (serial, code, customer_id, name, name_ar, gender, words, kind, session_id, initiative, event_date,
                               period_from, period_to, hours, sessions, issued_by, role, skills, skills_ar, partner, partner_ar)
  values ('pending-' || _code, _code, p_customer, left(coalesce(nullif(btrim(_name), ''), '-'), 120),
          left(nullif(btrim(coalesce(_name_ar, '')), ''), 120), _gender, _w, 'session', p_session, _title, _date,
          _date, _date, _h, _s, p_by, _role, _sk, _sk_ar, _pa, _pa_ar)
  returning id into _id;
  _serial := 'MMV-' || to_char(_vol_today(), 'YYYY') || '-' || lpad(_id::text, 5, '0');
  update volunteer_certs set serial = _serial where id = _id;
  return jsonb_build_object('ok', true, 'id', _id, 'kind', 'session', 'serial', _serial, 'code', _code,
    'name', _name, 'name_ar', nullif(btrim(coalesce(_name_ar, '')), ''), 'gender', _gender, 'words', _w,
    'session_id', p_session, 'initiative', _title, 'event_date', _date,
    'from', _date, 'to', _date, 'hours', _h, 'sessions', _s, 'issued_at', now(),
    'role', _role, 'skills', _sk, 'skills_ar', _sk_ar, 'partner', _pa, 'partner_ar', _pa_ar);
end $function$;
revoke all on function public._vol_cert_make_session(text, text, text, text, text) from public, anon, authenticated;

-- A certificate staff write themselves: unchanged but for the five keys (null: staff write its whole line themselves).
create or replace function public.staff_volunteer_cert_issue_custom(
  p_name text, p_initiative text, p_name_ar text default null, p_gender text default null,
  p_event_date date default null, p_hours numeric default null,
  p_lead text default null, p_recognition text default null, p_arabic_line text default null,
  p_customer text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _name text; _ar text; _g text; _init text; _date date; _h numeric; _w jsonb;
        _code text; _id bigint; _serial text;
begin
  if not ((select _staff_mod('volunteers', true)) or (select _staff_mod('customers', true))) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  _name := left(nullif(btrim(coalesce(p_name, '')), ''), 120);
  _init := left(nullif(btrim(coalesce(p_initiative, '')), ''), 80);
  if _name is null or _init is null then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  _ar := left(nullif(btrim(coalesce(p_name_ar, '')), ''), 120);
  _g := _vol_gender(p_gender);
  _date := coalesce(p_event_date, _vol_today());
  if _date > _vol_today() + 365 or _date < _vol_today() - 3660 then raise exception 'BAD_DATE' using errcode = '22023'; end if;
  _h := case when p_hours is null or p_hours <= 0 then null else round(least(p_hours, 9999), 2) end;
  if p_customer is not null and not exists (select 1 from customers c where c.id = p_customer and c.merged_into is null) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  -- The wording for that gender, with whatever staff replaced on top of it.
  _w := _vol_cert_words(_g);
  _w := jsonb_build_object(
    'lead', left(coalesce(nullif(btrim(coalesce(p_lead, '')), ''), _w ->> 'lead'), 160),
    'recognition', left(coalesce(nullif(btrim(coalesce(p_recognition, '')), ''), _w ->> 'recognition'), 240),
    'arabic_line', left(coalesce(nullif(btrim(coalesce(p_arabic_line, '')), ''), _w ->> 'arabic_line'), 240));
  _code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into volunteer_certs (serial, code, customer_id, name, name_ar, gender, words, kind, initiative, event_date,
                               period_from, period_to, hours, sessions, issued_by)
  values ('pending-' || _code, _code, p_customer, _name, _ar, _g, _w, 'custom', _init, _date,
          _date, _date, coalesce(_h, 0), '[]'::jsonb, _vol_op())
  returning id into _id;
  _serial := 'MMV-' || to_char(_vol_today(), 'YYYY') || '-' || lpad(_id::text, 5, '0');
  update volunteer_certs set serial = _serial where id = _id;
  return jsonb_build_object('ok', true, 'id', _id, 'kind', 'custom', 'serial', _serial, 'code', _code,
    'name', _name, 'name_ar', _ar, 'gender', _g, 'words', _w, 'initiative', _init, 'event_date', _date,
    'from', _date, 'to', _date, 'hours', _h, 'sessions', '[]'::jsonb, 'issued_at', now(),
    'role', null::text, 'skills', null::text, 'skills_ar', null::text, 'partner', null::text, 'partner_ar', null::text);
end $function$;

-- The public check: what the certificate says, now with the role and the partner (20261111140000).
create or replace function public.volunteer_cert_check(p_code text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce((select jsonb_build_object('ok', true, 'serial', c.serial, 'name', c.name, 'name_ar', c.name_ar,
                                              'gender', c.gender, 'words', c.words, 'kind', c.kind, 'initiative', c.initiative, 'event_date', c.event_date,
                                              'from', c.period_from, 'to', c.period_to,
                                              'hours', c.hours, 'sessions', c.sessions, 'issued_at', c.issued_at, 'revoked', c.revoked_at is not null,
                                              'role', c.role, 'partner', c.partner)
                     from volunteer_certs c where c.code = upper(btrim(coalesce(p_code, ''))) and coalesce(p_code, '') ~* '^\s*[a-z0-9]{12}\s*$'),
                  jsonb_build_object('ok', false));
$function$;


/* -- 6. an anonymised account loses its ratings' comments -------------------------------------- */
-- Patched in place, as 20261105120000, 20261110233000 and 20261110235100 patched it: the live text keeps every line it has.
do $do$
declare d text;
begin
  select pg_get_functiondef('public._purge_old(boolean)'::regprocedure) into d;
  if position('(20261111140000)' in d) > 0 then return; end if;
  execute pg_temp._once(d,
    $a$delete from volunteers where customer_id = any(ids);$a$,
    $b$delete from volunteers where customer_id = any(ids);
      update volunteer_feedback set comment = null where customer_id = any(ids) and comment is not null; /* a rating's comment (20261111140000) */$b$);
end $do$;


/* -- 7. who may call what ------------------------------------------------------------------------ */
do $do$
declare f text;
begin
  foreach f in array array['volunteer_plan(text,text,text,text)', 'volunteer_coming(text,text,text,boolean,text)',
                           'volunteer_feedback(text,text,text,integer,text,text)', 'volunteer_motive(text,text,text)',
                           'volunteer_opportunities()', 'volunteer_apply(text,text,text,integer[],text,text)',
                           'volunteer_interest(text,text,text,boolean,text,text)', 'volunteer_me(text,text)', 'volunteer_profile(text,text)',
                           'volunteer_updates(text,text)', 'volunteer_cert_check(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  foreach f in array array['staff_volunteer_details_save(text,jsonb)', 'staff_volunteer_reason(text,text,text)', 'staff_volunteer_thanks(text,text)',
                           'staff_volunteer_settings_save(jsonb)',
                           'staff_volunteer_cert_issue_custom(text,text,text,text,date,numeric,text,text,text,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $do$;


/* -- 8. checks ----------------------------------------------------------------------------------- */
do $chk$
declare f text;
begin
  foreach f in array array['public.staff_volunteer_details_save(text,jsonb)', 'public.volunteer_plan(text,text,text,text)',
                           'public.volunteer_coming(text,text,text,boolean,text)', 'public.volunteer_feedback(text,text,text,integer,text,text)',
                           'public.volunteer_motive(text,text,text)', 'public.staff_volunteer_reason(text,text,text)',
                           'public.staff_volunteer_thanks(text,text)', 'public._vol_min_age()', 'public._vol_feedback_follow()',
                           'public._vol_note(text,text,text,jsonb)', 'public._vol_shift_notes()', 'public._vol_person_notes()',
                           'public.volunteer_opportunities()', 'public.volunteer_apply(text,text,text,integer[],text,text)',
                           'public.volunteer_interest(text,text,text,boolean,text,text)', 'public.volunteer_me(text,text)',
                           'public.volunteer_profile(text,text)', 'public.volunteer_updates(text,text)',
                           'public.staff_volunteer_settings_save(jsonb)', 'public._vol_cert_make(text,date,date,text,text)',
                           'public._vol_cert_make_session(text,text,text,text,text)',
                           'public.staff_volunteer_cert_issue_custom(text,text,text,text,date,numeric,text,text,text,text)',
                           'public.volunteer_cert_check(text)', 'public._purge_old(boolean)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._vol_session_end(text,text)', 'public._vol_shift_reset()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and not p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% should be a plain function with its search_path', f;
    end if;
  end loop;
  foreach f in array array['public.volunteer_me(text,text)', 'public.volunteer_profile(text,text)', 'public.volunteer_updates(text,text)',
                           'public.volunteer_opportunities()', 'public.volunteer_cert_check(text)'] loop
    if (select p.provolatile from pg_proc p where p.oid = f::regprocedure) <> 's' then raise exception '% is no longer STABLE', f; end if;
  end loop;
  foreach f in array array['public._vol_session_end(text,text)', 'public._vol_min_age()', 'public._vol_shift_reset()', 'public._vol_feedback_follow()',
                           'public._vol_note(text,text,text,jsonb)', 'public._vol_cert_make_session(text,text,text,text,text)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  foreach f in array array['public.volunteer_plan(text,text,text,text)', 'public.volunteer_coming(text,text,text,boolean,text)',
                           'public.volunteer_feedback(text,text,text,integer,text,text)', 'public.volunteer_motive(text,text,text)'] loop
    if not has_function_privilege('anon', f, 'execute') then raise exception '% is not open to the portal', f; end if;
  end loop;
  foreach f in array array['public.staff_volunteer_details_save(text,jsonb)', 'public.staff_volunteer_reason(text,text,text)',
                           'public.staff_volunteer_thanks(text,text)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception '% is not executable by staff', f; end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.volunteer_feedback'::regclass) then
    raise exception 'volunteer_feedback has no RLS';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public'
       and ((table_name = 'volunteer_sessions' and column_name in ('meet_point', 'meet_map', 'bring', 'provided', 'shirt_pickup', 'demands',
              'contact_name', 'contact_phone', 'partner', 'partner_ar', 'skills', 'skills_ar', 'gender', 'thanks_note', 'thanks_at', 'thanks_by'))
         or (table_name = 'volunteer_shifts' and column_name in ('plan_leave', 'coming_at', 'withdraw_reason', 'decline_reason'))
         or (table_name = 'volunteers' and column_name in ('motive', 'decline_reason'))
         or (table_name = 'volunteer_certs' and column_name in ('role', 'skills', 'skills_ar', 'partner', 'partner_ar')))) <> 27 then
    raise exception 'a column is missing';
  end if;
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.volunteer_shifts'::regclass and t.tgname = 'volunteer_shifts_reset')
     or not exists (select 1 from pg_trigger t where t.tgrelid = 'public.volunteer_shifts'::regclass and t.tgname = 'volunteer_shifts_feedback_follow') then
    raise exception 'a trigger on volunteer_shifts is missing';
  end if;
  if position('volunteer_feedback' in pg_get_functiondef('public._purge_old(boolean)'::regprocedure)) = 0 then
    raise exception '_purge_old does not clear the ratings'' comments';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111140000', 'volunteer_enhancements')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
