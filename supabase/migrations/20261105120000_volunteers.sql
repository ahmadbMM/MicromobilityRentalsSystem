-- ============================================================================
-- Volunteers (2026-11-05, the owner: "add volunteering hours field for every account and allow staff to add them ... a
-- volunteering switch on each session ... the time the volunteers wont be able to enter ... a new volunteers section",
-- then "make a whole new portal for volunteers under volunteer.micromobility.sa and put the opportunities there available
-- to register their interest and then they can work from there too when they are accepted"; each opportunity is a session
-- with the switch on; anyone with an account may register; staff accept one at a time or all at once).
--
-- A volunteer is a customer account: no Auth user, no staff row, so is_staff() stays false and every staff policy and
-- function keeps refusing them. They reach data only through the volunteer_* functions below, called by the portal's Worker
-- (mm-platform apps/volunteers), each starting at the rider's session token.
--
--  1. customers.volunteer_hours: every account's total, kept by a trigger from the ledger volunteer_hours. Nobody writes
--     the column directly.
--  2. volunteers: everyone who has registered or been added: applied (registered, not accepted yet), active, paused,
--     removed; staff's tags, notes, an expiry date, the agreement they accepted (the portal's words), and auto_accept (a
--     trusted volunteer's interest is accepted by itself).
--  3. volunteer_sessions (from 20261105090000) is the switch on a session: enabled makes it an opportunity; closes_at is
--     the time volunteers can no longer register or work (required); opens_at the time accepted volunteers can start
--     (optional: empty means from the start of the session's day). It is its own table because sessions is public. volunteer_opportunities() is what
--     anyone may read of it, with no names.
--  4. volunteer_shifts: one person on one opportunity: interested, accepted, declined, withdrawn, blocked, no_show, done;
--     their role, and clock in and out. volunteer_log: every search and mark.
--  5. _vol_gate: token, active volunteer, account in good order, agreement, session open now, ACCEPTED on it, the capability.
--     A volunteer never marks their own booking (VOL_OWN_BOOKING: Donated makes a free-ride code). What needs the desk
--     (money, a reserved bike, a missing waiver or approval) is refused with the reason (VOL_ASK_DESK); a volunteer never
--     touches money, bikes or the free-ride code.
--  6. staff_volunteer_*: the Volunteers section's writes. Reads go through the tables' staff policies.
--  7. Patches: staff_move_session (a date move deletes the old session row, so these rows move first), the merge and its
--     undo, _purge_old, and staff_set_access (the section 'volunteers').
--
-- The staff-row Volunteer role of 20261105090000 is left working: it may be used on the night of 2026-11-05. A later
-- migration retires it.
--
-- Rollback: drop the volunteer_* and staff_volunteer_{save,hours_*,session_save,shift_*,decide,award,settings_save} and
-- staff_volunteers_bulk functions and _vol_*; drop volunteer_shifts, volunteer_hours, volunteers, volunteer_settings;
-- alter table customers drop column volunteer_hours; run the patches backwards.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- A patch: an anchor to its new text. Run again, the new text is there (it may hold the anchor) or the anchor is gone, and
-- nothing changes; the checks at the end say whether it landed.
create or replace function pg_temp._swap(def text, a text, b text) returns text language plpgsql as $f$
begin
  if b <> '' and position(b in def) > 0 then return def; end if;
  if position(a in def) = 0 then return def; end if;
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor found more than once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


/* -- 1. the hours ----------------------------------------------------------------------------- */
alter table public.customers add column if not exists volunteer_hours numeric(8, 2) not null default 0;
comment on column public.customers.volunteer_hours is
  'Total volunteering hours: the sum of the account''s live volunteer_hours rows, kept by a trigger (20261105120000). Do not write it.';
grant select (volunteer_hours) on public.customers to authenticated;

create table if not exists public.volunteer_hours (
  id          bigint generated always as identity primary key,
  customer_id text not null references public.customers (id) on update cascade on delete cascade,
  session_id  text references public.sessions (id) on update cascade on delete set null,
  hours       numeric(6, 2) not null check (hours <> 0 and hours between -500 and 500),
  worked_on   date not null default ((now() at time zone 'Asia/Riyadh')::date),
  source      text not null default 'staff' check (source in ('staff', 'session')),
  note        text check (char_length(note) <= 300),
  added_by    text,
  added_uid   uuid,
  created_at  timestamptz not null default now(),
  voided_at   timestamptz,
  voided_by   text
);
create index if not exists volunteer_hours_customer on public.volunteer_hours (customer_id, worked_on desc);
create index if not exists volunteer_hours_session on public.volunteer_hours (session_id) where session_id is not null;
create unique index if not exists volunteer_hours_one_award on public.volunteer_hours (session_id, customer_id)
  where source = 'session' and voided_at is null;
alter table public.volunteer_hours enable row level security;
revoke all on public.volunteer_hours from public, anon, authenticated;
grant select on public.volunteer_hours to authenticated;
drop policy if exists "staff read" on public.volunteer_hours;
create policy "staff read" on public.volunteer_hours for select
  using ((select _staff_mod('volunteers')) or (select _staff_mod('customers')));

create or replace function public._vol_hours_sum()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare ids text[];
begin
  ids := array_remove(array[case when tg_op <> 'DELETE' then new.customer_id end,
                            case when tg_op <> 'INSERT' then old.customer_id end], null);
  -- The lock first, in its own statement: the sum below then reads what a concurrent award has committed.
  perform 1 from customers where id = any(ids) order by id for update;
  update customers c
     set volunteer_hours = coalesce((select sum(h.hours) from volunteer_hours h where h.customer_id = c.id and h.voided_at is null), 0)
   where c.id = any(ids);
  return null;
end $function$;
revoke all on function public._vol_hours_sum() from public, anon, authenticated;
drop trigger if exists volunteer_hours_sum on public.volunteer_hours;
create trigger volunteer_hours_sum after insert or update or delete on public.volunteer_hours
  for each row execute function public._vol_hours_sum();


-- The older staff-row role (20261105090000) reads the same table until it is retired: only ever a blood night, never a
-- ride a session's switch has opened, since it has no desk checks.
create or replace function public._volunteer_next()
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select w.session_id from volunteer_sessions w join sessions s on s.id = w.session_id
   where w.closes_at > now() and s.ride_kind = 'blood' order by w.opens_at limit 1;
$function$;
revoke all on function public._volunteer_next() from public, anon, authenticated;


/* -- 2. the volunteers ------------------------------------------------------------------------ */
create table if not exists public.volunteers (
  customer_id    text primary key references public.customers (id) on update cascade on delete cascade,
  status         text not null default 'active' check (status in ('applied', 'active', 'paused', 'removed')),
  auto_accept    boolean not null default false,
  tags           text[] not null default '{}',
  notes          text check (char_length(notes) <= 2000),
  shirt          text check (char_length(shirt) <= 10),
  expires_on     date,
  agreed_version text,
  agreed_at      timestamptz,
  applied_at     timestamptz,
  decided_at     timestamptz,
  decided_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists volunteers_status on public.volunteers (status);
alter table public.volunteers enable row level security;
revoke all on public.volunteers from public, anon, authenticated;
grant select on public.volunteers to authenticated;
drop policy if exists "staff read" on public.volunteers;
create policy "staff read" on public.volunteers for select
  using ((select _staff_mod('volunteers')) or (select _staff_mod('customers')));

create table if not exists public.volunteer_settings (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.volunteer_settings (id, data) values (1, jsonb_build_object('agreement_v', '2026-11-05'))
on conflict (id) do nothing;
alter table public.volunteer_settings enable row level security;
revoke all on public.volunteer_settings from public, anon, authenticated;
grant select on public.volunteer_settings to authenticated;
drop policy if exists "staff read" on public.volunteer_settings;
create policy "staff read" on public.volunteer_settings for select using ((select is_staff()));


/* -- 3. the switch on a session --------------------------------------------------------------- */
alter table public.volunteer_sessions alter column opens_at drop not null;
alter table public.volunteer_sessions
  add column if not exists enabled       boolean not null default false,
  add column if not exists needed        int check (needed between 1 and 1000),
  add column if not exists about         text check (char_length(about) <= 2000),
  add column if not exists briefing      text check (char_length(briefing) <= 2000),
  add column if not exists signup_open   boolean not null default true,
  add column if not exists caps          jsonb not null default '{"checkin":true,"undo":true,"donated":true,"list":false,"counts":true}'::jsonb,
  add column if not exists hours_mode    text not null default 'clock' check (hours_mode in ('clock', 'fixed', 'none')),
  add column if not exists fixed_hours   numeric(5, 2) check (fixed_hours > 0 and fixed_hours <= 24),
  add column if not exists roles         text[] not null default '{}',
  add column if not exists min_age       int check (min_age between 1 and 99),
  add column if not exists updated_at    timestamptz not null default now(),
  add column if not exists updated_by    text;
grant select on public.volunteer_sessions to authenticated;
drop policy if exists "staff read" on public.volunteer_sessions;
create policy "staff read" on public.volunteer_sessions for select using ((select is_staff()));


/* -- 4. who works what, and what they did -------------------------------------------------------- */
create table if not exists public.volunteer_shifts (
  id          bigint generated always as identity primary key,
  session_id  text not null references public.sessions (id) on update cascade on delete cascade,
  customer_id text not null references public.customers (id) on update cascade on delete cascade,
  status      text not null default 'interested' check (status in ('interested', 'accepted', 'declined', 'withdrawn', 'blocked', 'no_show', 'done')),
  role        text check (char_length(role) <= 40),
  pref_role   text check (char_length(pref_role) <= 40),
  message     text check (char_length(message) <= 300),
  note        text check (char_length(note) <= 300),
  decided_at  timestamptz,
  decided_by  text,
  clock_in    timestamptz,
  clock_out   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  text,
  unique (session_id, customer_id)
);
create index if not exists volunteer_shifts_customer on public.volunteer_shifts (customer_id);
alter table public.volunteer_shifts enable row level security;
revoke all on public.volunteer_shifts from public, anon, authenticated;
grant select on public.volunteer_shifts to authenticated;
drop policy if exists "staff read" on public.volunteer_shifts;
create policy "staff read" on public.volunteer_shifts for select using ((select _staff_mod('volunteers')));

alter table public.volunteer_log alter column user_id drop not null;
alter table public.volunteer_log add column if not exists customer_id text references public.customers (id) on update cascade on delete set null;
-- What a mark set and what it replaced: an undo restores the status, and only the same mark can be undone (the desk's later one has another stamp).
alter table public.volunteer_log add column if not exists mark_at text;
alter table public.volunteer_log add column if not exists prev_status text;
alter table public.volunteer_log drop constraint if exists volunteer_log_action_check;
alter table public.volunteer_log add constraint volunteer_log_action_check
  check (action in ('enter', 'list', 'scan', 'search', 'checkin', 'uncheckin', 'donated', 'undonated', 'clock_in', 'clock_out', 'agree', 'interest', 'withdraw'));
create index if not exists volunteer_log_customer_at on public.volunteer_log (customer_id, at desc) where customer_id is not null;
create index if not exists volunteer_log_session_at on public.volunteer_log (session_id, at desc);
revoke all on public.volunteer_log from public, anon, authenticated;
grant select on public.volunteer_log to authenticated;
drop policy if exists "admin read" on public.volunteer_log;
drop policy if exists "staff read" on public.volunteer_log;
create policy "staff read" on public.volunteer_log for select using ((select _staff_mod('volunteers')));


/* -- Team may give the section ---------------------------------------------------------------- */
do $do$
declare v text;
begin
  v := pg_get_functiondef('public.staff_set_access(uuid,text,text[],text[])'::regprocedure);
  v := pg_temp._swap(v, $a$'history','team'];$a$, $b$'history','team','volunteers'];$b$);
  execute v;
end $do$;


/* -- 5. the gate ------------------------------------------------------------------------------ */
create or replace function public._vol_today()
 returns date
 language sql
 stable
 set search_path to 'public'
as $function$ select (now() at time zone 'Asia/Riyadh')::date; $function$;
revoke all on function public._vol_today() from public, anon, authenticated;

create or replace function public._vol_settings()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$ select coalesce((select s.data from volunteer_settings s where s.id = 1), '{}'::jsonb); $function$;
revoke all on function public._vol_settings() from public, anon, authenticated;

create or replace function public._vol_agreement_v()
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$ select coalesce(nullif(_vol_settings() ->> 'agreement_v', ''), '2026-11-05'); $function$;
revoke all on function public._vol_agreement_v() from public, anon, authenticated;

-- May this account volunteer at all, now? (not the session: that is _vol_gate). Raises the reason.
create or replace function public._vol_account(p_id text, p_token text)
 returns void
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v volunteers%rowtype; c record;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then
    raise exception 'VOL_TOKEN' using errcode = '42501';
  end if;
  select * into v from volunteers where customer_id = p_id;
  if not found or v.status <> 'active' or (v.expires_on is not null and v.expires_on < _vol_today()) then
    raise exception 'VOL_NOT_VOLUNTEER' using errcode = '42501';
  end if;
  select x.must_change_pwd, x.deletion_requested_at into c from customers x where x.id = p_id;
  if coalesce(c.must_change_pwd, false) or c.deletion_requested_at is not null then
    raise exception 'VOL_ACCOUNT' using errcode = '42501';
  end if;
  if v.agreed_version is distinct from _vol_agreement_v() then
    raise exception 'VOL_AGREE' using errcode = '42501';
  end if;
end $function$;
revoke all on function public._vol_account(text, text) from public, anon, authenticated;

-- When an accepted volunteer may start: staff's time, or else midnight of the session's day in Saudi time. Accepted on
-- Monday for a Saturday ride does not open it on Monday; the desk's camera refuses other days' tickets the same way.
create or replace function public._vol_starts(p_opens timestamptz, p_date text)
 returns timestamptz
 language sql
 stable
 set search_path to 'public'
as $function$
  select coalesce(p_opens, case when p_date ~ '^\d{4}-\d{2}-\d{2}$' then (p_date || ' 00:00:00+03')::timestamptz end);
$function$;
revoke all on function public._vol_starts(timestamptz, text) from public, anon, authenticated;

create or replace function public._vol_gate(p_id text, p_token text, p_session text, p_cap text default null)
 returns public.volunteer_sessions
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare w volunteer_sessions%rowtype; sh volunteer_shifts%rowtype; s record;
begin
  perform _vol_account(p_id, p_token);
  select * into w from volunteer_sessions where session_id = p_session;
  if not found or not w.enabled or now() >= w.closes_at then raise exception 'VOL_CLOSED' using errcode = '42501'; end if;
  select x.session_date, x.cancelled_at into s from sessions x where x.id = p_session;
  if s.cancelled_at is not null or now() < _vol_starts(w.opens_at, s.session_date) then
    raise exception 'VOL_CLOSED' using errcode = '42501';
  end if;
  select * into sh from volunteer_shifts where session_id = p_session and customer_id = p_id;
  if not found or sh.status not in ('accepted', 'done') then
    raise exception 'VOL_NOT_ACCEPTED' using errcode = '42501';
  end if;
  if p_cap is not null and not coalesce((w.caps ->> p_cap)::boolean, false) then
    raise exception 'VOL_CAP' using errcode = '42501';
  end if;
  return w;
end $function$;
revoke all on function public._vol_gate(text, text, text, text) from public, anon, authenticated;

create or replace function public._vol_log(p_cust text, p_session text, p_action text, p_entry text default null,
                                             p_mark text default null, p_prev text default null)
 returns void
 language sql
 security definer
 set search_path to 'public'
as $function$
  insert into volunteer_log (customer_id, session_id, action, entry_id, mark_at, prev_status)
  values (p_cust, p_session, p_action, p_entry, p_mark, p_prev);
$function$;
revoke all on function public._vol_log(text, text, text, text, text, text) from public, anon, authenticated;

-- Whether the mark on this booking now (p_mark, its stamp) is this volunteer's own "on".
create or replace function public._vol_mine(p_cust text, p_entry text, p_on text, p_off text, p_mark text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce((select l.customer_id = p_cust and l.action = p_on and l.mark_at is not distinct from p_mark
    from volunteer_log l where l.entry_id = p_entry and l.action in (p_on, p_off)
   order by l.at desc, l.id desc limit 1), false);
$function$;
revoke all on function public._vol_mine(text, text, text, text, text) from public, anon, authenticated;

-- Why this booking must go to the desk, or null. A volunteer never takes money or hands out a bike. Money due reads only
-- 'desk': the Privacy Notice says volunteers never see payments, and "payment is due" is one.
create or replace function public._vol_desk_reason(q public.queue_entries, s public.sessions)
 returns text
 language sql
 stable
 set search_path to 'public'
as $function$
  select case
    when _wallet_amount(coalesce(q.price, 0), q.addons) > 0 and not coalesce(q.paid, false) then 'desk'
    when coalesce(s.ride_kind, '') <> 'blood' and nullif(btrim(coalesce(q.assigned_bike_id, '')), '') is not null then 'bike'
    when coalesce(q.approval, 'pending') <> 'approved' and coalesce(s.event_kind, '') = 'community'
         and coalesce(s.ride_kind, '') <> 'snd96' and coalesce(s.needs_approval, false) then 'approval'
    when coalesce(s.ride_kind, '') = 'blood' and nullif(btrim(coalesce(q.data_share_at, '')), '') is null then 'share'
    when nullif(btrim(coalesce(q.waiver_at, '')), '') is null then 'waiver'
    when coalesce(s.ride_kind, '') <> 'blood' and q.status = 'waitlist' then 'waitlist'
  end;
$function$;
revoke all on function public._vol_desk_reason(public.queue_entries, public.sessions) from public, anon, authenticated;

-- A session's start as staff typed it (bike_slots._time), or null.
create or replace function public._vol_time(p text)
 returns text
 language plpgsql
 immutable
 set search_path to 'public'
as $function$
begin
  if coalesce(p, '') !~ '^\s*\{' then return null; end if;
  return p::jsonb ->> '_time';
exception when others then
  return null;
end $function$;
revoke all on function public._vol_time(text) from public, anon, authenticated;


/* -- what a signed-in rider sees of all this ---------------------------------------------------- */
-- What anyone may read: the opportunities. No names, no counts of who but how many are accepted.
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
           'accepted', (select count(*) from volunteer_shifts x where x.session_id = w.session_id and x.status in ('accepted', 'done'))
         ) order by s.session_date, s.id), '[]'::jsonb)
    from volunteer_sessions w join sessions s on s.id = w.session_id
   where w.enabled and now() < w.closes_at and s.cancelled_at is null;
$function$;

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
           'status', sh.status, 'role', sh.role,
           'clock_in', sh.clock_in, 'clock_out', sh.clock_out, 'opens_at', _vol_starts(w.opens_at, s.session_date), 'closes_at', w.closes_at,
           'briefing', case when sh.status in ('accepted', 'done') then w.briefing end,
           'can_work', _ok and w.enabled and s.cancelled_at is null and sh.status in ('accepted', 'done') and now() < w.closes_at and now() >= _vol_starts(w.opens_at, s.session_date)
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
    'agreed', v.agreed_version is not distinct from _vol_agreement_v() and v.customer_id is not null,
    'promote', coalesce((_cfg ->> 'promote')::boolean, false),
    'open_count', (select count(*) from volunteer_sessions w join sessions s on s.id = w.session_id where w.enabled and now() < w.closes_at and s.cancelled_at is null),
    'mine', _mine, 'record', _rec, 'first_on', _sum.first_on, 'last_on', _sum.last_on, 'sessions', _sum.sessions,
    'cert_signer', _cfg ->> 'cert_signer', 'cert_title', _cfg ->> 'cert_title');
end $function$;

create or replace function public.volunteer_agree(p_id text, p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  update volunteers set agreed_version = _vol_agreement_v(), agreed_at = now(), updated_at = now()
   where customer_id = p_id and status = 'active';
  if not found then raise exception 'VOL_NOT_VOLUNTEER' using errcode = '42501'; end if;
  perform _vol_log(p_id, '', 'agree');
  return jsonb_build_object('ok', true);
end $function$;

-- Anyone with an account: I want to help on this opportunity, or I no longer can. A first registration makes the volunteer
-- record (applied). A trusted volunteer's interest is accepted by itself. Someone declined stays declined.
create or replace function public.volunteer_interest(p_id text, p_token text, p_session text, p_on boolean, p_role text default null, p_message text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare w volunteer_sessions%rowtype; sh volunteer_shifts%rowtype; v volunteers%rowtype; c record; _st text; _day text;
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
  _st := case when coalesce(v.auto_accept, false) and v.status = 'active' then 'accepted' else 'interested' end;
  insert into volunteer_shifts (session_id, customer_id, status, pref_role, message, decided_at, decided_by)
  values (p_session, p_id, _st, nullif(left(btrim(coalesce(p_role, '')), 40), ''), nullif(left(btrim(coalesce(p_message, '')), 300), ''),
          case when _st = 'accepted' then now() end, case when _st = 'accepted' then 'auto' end)
  on conflict (session_id, customer_id) do update set status = excluded.status, pref_role = excluded.pref_role, message = excluded.message,
    decided_at = excluded.decided_at, decided_by = excluded.decided_by, updated_at = now();
  perform _vol_log(p_id, p_session, 'interest');
  return jsonb_build_object('ok', true, 'status', _st);
end $function$;

-- Opening the work page: the gate, the first arrival clocks in, the session's counts.
create or replace function public.volunteer_enter(p_id text, p_token text, p_session text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare w volunteer_sessions%rowtype; sh volunteer_shifts%rowtype; _n record;
begin
  w := _vol_gate(p_id, p_token, p_session);
  perform _vol_log(p_id, p_session, 'enter');
  select * into sh from volunteer_shifts where session_id = p_session and customer_id = p_id for update;
  if sh.clock_in is null or sh.clock_out is not null then
    -- back after finishing: the shift runs on, from the first arrival
    update volunteer_shifts set clock_in = coalesce(clock_in, now()), clock_out = null, updated_at = now()
     where id = sh.id returning * into sh;
    perform _vol_log(p_id, p_session, 'clock_in');
  end if;
  select count(*) filter (where q.status in ('waiting', 'waitlist', 'active', 'done')) booked,
         count(*) filter (where q.status in ('active', 'done')) arrived,
         count(*) filter (where q.donated_at is not null) donated
    into _n from queue_entries q where q.session_id = p_session;
  return jsonb_build_object('ok', true, 'closes_at', w.closes_at, 'caps', w.caps, 'briefing', w.briefing, 'hours_mode', w.hours_mode,
    'clock_in', sh.clock_in, 'role', sh.role,
    'counts', case when coalesce((w.caps ->> 'counts')::boolean, false) then jsonb_build_object('booked', _n.booked, 'in', _n.arrived, 'donated', _n.donated) end,
    'mine', (select count(*) filter (where l.action = 'checkin') - count(*) filter (where l.action = 'uncheckin')
               from volunteer_log l where l.customer_id = p_id and l.session_id = p_session));
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
  update volunteer_shifts set clock_out = now(), updated_at = now()
   where session_id = p_session and customer_id = p_id and clock_in is not null and clock_out is null;
  if found then perform _vol_log(p_id, p_session, 'clock_out'); end if;
  return jsonb_build_object('ok', true);
end $function$;

-- One person at a time: a ticket, or a whole mobile or booking number. Name, number and marks, never contact details.
create or replace function public.volunteer_find(p_id text, p_token text, p_session text, p_ref text default null,
                                                 p_ref_num integer default null, p_mobile text default null, p_number integer default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  _scan boolean := p_ref is not null;
  _mobile text := _volunteer_phone(p_mobile);
  s sessions%rowtype;
begin
  perform _vol_gate(p_id, p_token, p_session);
  if (_scan::int + (p_mobile is not null)::int + (p_number is not null)::int) <> 1
     or (_scan and p_ref !~ '^[0-9A-Za-z-]{4,8}$')
     or (p_mobile is not null and length(_mobile) < 7) then
    raise exception 'VOL_BAD_SEARCH' using errcode = '22023';
  end if;
  if (select count(*) from volunteer_log l
       where l.customer_id = p_id and l.action = case when _scan then 'scan' else 'search' end
         and l.at > now() - interval '10 minutes') >= (case when _scan then 200 else 30 end) then
    raise exception 'VOL_SLOW' using errcode = 'P0001';
  end if;
  perform _vol_log(p_id, p_session, case when _scan then 'scan' else 'search' end);
  select * into s from sessions where id = p_session;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'name', r.name, 'number', r.queue_num,
             'checked_in', r.status in ('active', 'done'),
             'donated', r.donated_at is not null,
             'own', r.customer_id is not distinct from p_id,
             'desk', _vol_desk_reason(r, s),
             'mine_in', _vol_mine(p_id, r.id, 'checkin', 'uncheckin', r.checked_in_at::text),
             'mine_donated', _vol_mine(p_id, r.id, 'donated', 'undonated', r.donated_at::text)) order by r.queue_num)
      from (select q.* from queue_entries q left join customers c on c.id = q.customer_id
             where q.session_id = p_session
               and q.status in ('waiting', 'waitlist', 'active', 'done')
               and ((_scan and lower(q.id) like lower(replace(replace(replace(p_ref, '\', ''), '%', ''), '_', '')) || '%'
                           and (p_ref_num is null or q.queue_num = p_ref_num))
                 or (p_mobile is not null and (_volunteer_phone(c.phone) = _mobile or _volunteer_phone(q.phone) = _mobile))
                 or (p_number is not null and q.queue_num = p_number))
             order by q.queue_num limit 5) r), '[]'::jsonb);
end $function$;

-- The whole list, only where staff switched it on for this session (caps.list). Names and marks.
create or replace function public.volunteer_list(p_id text, p_token text, p_session text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare s sessions%rowtype;
begin
  perform _vol_gate(p_id, p_token, p_session, 'list');
  perform _vol_log(p_id, p_session, 'list');
  select * into s from sessions where id = p_session;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'name', r.name, 'number', r.queue_num,
             'checked_in', r.status in ('active', 'done'),
             'donated', r.donated_at is not null,
             'own', r.customer_id is not distinct from p_id,
             'desk', _vol_desk_reason(r, s),
             'mine_in', _vol_mine(p_id, r.id, 'checkin', 'uncheckin', r.checked_in_at::text),
             'mine_donated', _vol_mine(p_id, r.id, 'donated', 'undonated', r.donated_at::text)) order by r.queue_num)
      from (select q.* from queue_entries q where q.session_id = p_session
              and q.status in ('waiting', 'waitlist', 'active', 'done') order by q.queue_num limit 1000) r), '[]'::jsonb);
end $function$;

create or replace function public.volunteer_checkin(p_id text, p_token text, p_session text, p_entry_id text, p_on boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare q queue_entries%rowtype; s sessions%rowtype; _why text; _at text; _prev text;
begin
  perform _vol_gate(p_id, p_token, p_session, case when coalesce(p_on, false) then 'checkin' else 'undo' end);
  select * into q from queue_entries where id = p_entry_id and session_id = p_session for update;
  if not found then raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001'; end if;
  if q.customer_id is not distinct from p_id then raise exception 'VOL_OWN_BOOKING' using errcode = '42501'; end if;

  if coalesce(p_on, false) then
    if q.status in ('active', 'done') then return jsonb_build_object('ok', true, 'noop', true); end if;
    if q.status not in ('waiting', 'waitlist') then raise exception 'BAD_BOOKING_STATE' using errcode = 'P0001'; end if;
    select * into s from sessions where id = p_session;
    _why := _vol_desk_reason(q, s);
    if _why is not null then raise exception 'VOL_ASK_DESK' using errcode = 'P0001', detail = _why; end if;
    update queue_entries set status = 'active', checked_in_at = _iso_now() where id = q.id returning checked_in_at::text into _at;
    perform _vol_log(p_id, p_session, 'checkin', q.id, _at, q.status);
    return jsonb_build_object('ok', true);
  end if;

  if q.status in ('waiting', 'waitlist') then return jsonb_build_object('ok', true, 'noop', true); end if;
  if q.status <> 'active' then raise exception 'BAD_BOOKING_STATE' using errcode = 'P0001'; end if;
  if q.donated_at is not null then raise exception 'VOL_DONATED_FIRST' using errcode = 'P0001'; end if;
  if not _vol_mine(p_id, q.id, 'checkin', 'uncheckin', q.checked_in_at::text) then raise exception 'VOL_NOT_YOURS' using errcode = '42501'; end if;
  -- The desk has given a bike since: taking it back is the desk's (_undoCheckinWrite frees the bike too).
  if nullif(btrim(coalesce(q.assigned_bike_id, '')), '') is not null then
    raise exception 'VOL_ASK_DESK' using errcode = 'P0001', detail = 'bike';
  end if;
  select l.prev_status into _prev from volunteer_log l where l.entry_id = q.id and l.action = 'checkin' order by l.at desc, l.id desc limit 1;
  update queue_entries set status = coalesce(_prev, 'waiting'), checked_in_at = null where id = q.id;
  perform _vol_log(p_id, p_session, 'uncheckin', q.id);
  return jsonb_build_object('ok', true);
end $function$;

create or replace function public.volunteer_donated(p_id text, p_token text, p_session text, p_entry_id text, p_on boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare q queue_entries%rowtype; _at text;
begin
  perform _vol_gate(p_id, p_token, p_session, case when coalesce(p_on, false) then 'donated' else 'undo' end);
  select * into q from queue_entries where id = p_entry_id and session_id = p_session for update;
  if not found then raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001'; end if;
  if q.customer_id is not distinct from p_id then raise exception 'VOL_OWN_BOOKING' using errcode = '42501'; end if;

  if coalesce(p_on, false) then
    if q.donated_at is not null then return jsonb_build_object('ok', true, 'noop', true); end if;
    perform _blood_donated_apply(q.id, true); -- the free-ride code is made there and never returned here
    select x.donated_at::text into _at from queue_entries x where x.id = q.id;
    perform _vol_log(p_id, p_session, 'donated', q.id, _at);
    return jsonb_build_object('ok', true);
  end if;

  if q.donated_at is null then return jsonb_build_object('ok', true, 'noop', true); end if;
  if not _vol_mine(p_id, q.id, 'donated', 'undonated', q.donated_at::text) then raise exception 'VOL_NOT_YOURS' using errcode = '42501'; end if;
  perform _blood_donated_apply(q.id, false);
  perform _vol_log(p_id, p_session, 'undonated', q.id);
  return jsonb_build_object('ok', true);
end $function$;


/* -- 6. the section's writes ------------------------------------------------------------------- */
create or replace function public._vol_op()
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$ select s.display_name from staff s where s.user_id = auth.uid(); $function$;
revoke all on function public._vol_op() from public, anon, authenticated;

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
  return jsonb_build_object('ok', true, 'n', _n);
end $function$;

-- Hours: anyone who edits Volunteers or Accounts. Taking hours off may not leave the account below zero.
create or replace function public.staff_volunteer_hours_add(p_customer text, p_hours numeric, p_on date default null, p_session text default null, p_note text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _h numeric := round(coalesce(p_hours, 0), 2); _id bigint; _tot numeric;
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
  return jsonb_build_object('ok', true, 'id', _id, 'total', _tot + _h);
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
    return jsonb_build_object('ok', true, 'enabled', false);
  end if;
  if p_closes is null then raise exception 'VOL_CUTOFF_REQUIRED' using errcode = '22023'; end if;
  if p_opens is not null and p_opens >= p_closes then raise exception 'VOL_CUTOFF_BEFORE_OPEN' using errcode = '22023'; end if;
  if p_hours_mode not in ('clock', 'fixed', 'none') then raise exception 'BAD_HOURS_MODE' using errcode = '22023'; end if;
  if p_hours_mode = 'fixed' and (p_fixed_hours is null or p_fixed_hours <= 0 or p_fixed_hours > 24) then raise exception 'BAD_HOURS' using errcode = '22023'; end if;
  _caps := jsonb_build_object(
    'checkin', coalesce((p_caps ->> 'checkin')::boolean, true), 'undo', coalesce((p_caps ->> 'undo')::boolean, true),
    'donated', coalesce((p_caps ->> 'donated')::boolean, true), 'list', coalesce((p_caps ->> 'list')::boolean, false),
    'counts', coalesce((p_caps ->> 'counts')::boolean, true));
  insert into volunteer_sessions (session_id, enabled, opens_at, closes_at, needed, about, briefing, signup_open, caps, hours_mode, fixed_hours, roles, min_age, updated_at, updated_by)
  values (p_session, true, p_opens, p_closes, p_needed, nullif(left(btrim(coalesce(p_about, '')), 2000), ''), nullif(left(btrim(coalesce(p_briefing, '')), 2000), ''), coalesce(p_signup_open, true), _caps,
          p_hours_mode, case when p_hours_mode = 'fixed' then p_fixed_hours end, coalesce(array(select left(btrim(r), 40) from unnest(p_roles) r where btrim(r) <> '' limit 20), '{}'), p_min_age, now(), _vol_op())
  on conflict (session_id) do update set enabled = true, opens_at = excluded.opens_at, closes_at = excluded.closes_at, needed = excluded.needed,
    about = excluded.about, briefing = excluded.briefing, signup_open = excluded.signup_open, caps = excluded.caps, hours_mode = excluded.hours_mode,
    fixed_hours = excluded.fixed_hours, roles = excluded.roles, min_age = excluded.min_age, updated_at = now(), updated_by = excluded.updated_by;
  return jsonb_build_object('ok', true, 'enabled', true);
end $function$;

-- Accepting or declining: one person or everyone at once (p_customers). Someone paused or removed is left as they are and
-- counted as skipped. Accepting makes an applicant an active volunteer.
create or replace function public.staff_volunteer_decide(p_session text, p_customers text[], p_status text, p_role text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _c text; _n int := 0; _skip int := 0; _op text := _vol_op(); _st text;
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_status not in ('accepted', 'declined') then raise exception 'BAD_STATUS' using errcode = '22023'; end if;
  if not exists (select 1 from volunteer_sessions w where w.session_id = p_session) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  foreach _c in array coalesce(p_customers, '{}') loop
    select v.status into _st from volunteers v where v.customer_id = _c for update;
    if _st is null and not exists (select 1 from customers c where c.id = _c and c.merged_into is null) then _skip := _skip + 1; continue; end if;
    if p_status = 'accepted' and _st in ('paused', 'removed') then _skip := _skip + 1; continue; end if;
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
    _n := _n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'n', _n, 'skipped', _skip);
end $function$;

-- Everything else about one person on one session. p_status null takes the row away, unless they already clocked in.
create or replace function public.staff_volunteer_shift_save(p_session text, p_customer text, p_status text, p_role text default null, p_note text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_status is null then
    delete from volunteer_shifts where session_id = p_session and customer_id = p_customer and clock_in is null;
    if not found and exists (select 1 from volunteer_shifts where session_id = p_session and customer_id = p_customer) then
      raise exception 'VOL_ALREADY_IN' using errcode = 'P0001';
    end if;
    return jsonb_build_object('ok', true);
  end if;
  if p_status not in ('interested', 'accepted', 'declined', 'withdrawn', 'blocked', 'no_show', 'done') then raise exception 'BAD_STATUS' using errcode = '22023'; end if;
  if not exists (select 1 from volunteers v where v.customer_id = p_customer) then raise exception 'VOL_NOT_VOLUNTEER' using errcode = 'P0001'; end if;
  insert into volunteer_shifts (session_id, customer_id, status, role, note, updated_by)
  values (p_session, p_customer, p_status, nullif(left(btrim(coalesce(p_role, '')), 40), ''), nullif(left(btrim(coalesce(p_note, '')), 300), ''), _vol_op())
  on conflict (session_id, customer_id) do update set status = excluded.status,
    role = case when p_role is null then volunteer_shifts.role else excluded.role end,
    note = case when p_note is null then volunteer_shifts.note else excluded.note end,
    updated_at = now(), updated_by = excluded.updated_by;
  return jsonb_build_object('ok', true);
end $function$;

-- Staff correct the clock.
create or replace function public.staff_volunteer_shift_times(p_session text, p_customer text, p_in timestamptz, p_out timestamptz)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_in is not null and p_out is not null and p_out <= p_in then raise exception 'BAD_TIMES' using errcode = '22023'; end if;
  update volunteer_shifts set clock_in = p_in, clock_out = p_out, updated_at = now(), updated_by = _vol_op()
   where session_id = p_session and customer_id = p_customer;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true);
end $function$;

-- Hours for a session's people, in one go: [{customer_id, hours}]. One award per person per session; a second is skipped.
create or replace function public.staff_volunteer_award(p_session text, p_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r jsonb; _h numeric; _c text; _on date; _add int := 0; _skip int := 0; _op text := _vol_op();
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
    _add := _add + 1;
  end loop;
  return jsonb_build_object('ok', true, 'added', _add, 'skipped', _skip);
end $function$;

-- The section's settings. Only the known keys, within their shapes.
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
                           'roles', 'tags', 'cert_signer', 'cert_title', 'wa_tpl', 'needed'] loop
    if p_data ? k then _d := _d || jsonb_build_object(k, p_data -> k); end if;
  end loop;
  update volunteer_settings set data = data || _d, updated_at = now(), updated_by = _vol_op() where id = 1;
  return jsonb_build_object('ok', true);
end $function$;

do $do$
declare f text;
begin
  foreach f in array array['volunteer_opportunities()', 'volunteer_me(text,text)', 'volunteer_agree(text,text)', 'volunteer_interest(text,text,text,boolean,text,text)',
                           'volunteer_enter(text,text,text)', 'volunteer_clock_out(text,text,text)', 'volunteer_find(text,text,text,text,integer,text,integer)',
                           'volunteer_list(text,text,text)', 'volunteer_checkin(text,text,text,text,boolean)', 'volunteer_donated(text,text,text,text,boolean)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  foreach f in array array['staff_volunteer_save(text,text,text[],text,text,date,boolean,boolean)', 'staff_volunteers_bulk(text[],text,text,text)', 'staff_volunteer_decide(text,text[],text,text)',
                           'staff_volunteer_hours_add(text,numeric,date,text,text)', 'staff_volunteer_hours_void(bigint)',
                           'staff_volunteer_session_save(text,boolean,timestamptz,timestamptz,integer,text,text,boolean,jsonb,text,numeric,text[],integer)',
                           'staff_volunteer_shift_save(text,text,text,text,text)', 'staff_volunteer_shift_times(text,text,timestamptz,timestamptz)',
                           'staff_volunteer_award(text,jsonb)', 'staff_volunteer_settings_save(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $do$;


/* -- 7. the patches ---------------------------------------------------------------------------- */
do $do$
declare v text;
begin
  -- A date move inserts the new session and deletes the old: these rows go across first, or the cascade takes them.
  v := pg_get_functiondef('public.staff_move_session(text,text,text,boolean)'::regprocedure);
  v := pg_temp._swap(v, $a$  delete from sessions where id = p_from;
  return jsonb_build_object('ok', true, 'id', v_to, 'day', v_day);$a$,
    $b$  -- Volunteers (20261105120000).
  update volunteer_sessions w set session_id = v_to,
         opens_at = w.opens_at + make_interval(days => d - s.session_date::date),
         closes_at = w.closes_at + make_interval(days => d - s.session_date::date)
   where w.session_id = p_from and not exists (select 1 from volunteer_sessions x where x.session_id = v_to);
  update volunteer_shifts h set session_id = v_to where h.session_id = p_from
    and not exists (select 1 from volunteer_shifts x where x.session_id = v_to and x.customer_id = h.customer_id);
  update volunteer_hours set session_id = v_to where session_id = p_from;
  update volunteer_log set session_id = v_to where session_id = p_from;

  delete from sessions where id = p_from;
  return jsonb_build_object('ok', true, 'id', v_to, 'day', v_day);$b$);
  execute v;

  -- The merge: the keeper takes the hours; a shift or the volunteer record when it has none of its own.
  v := pg_get_functiondef('public.staff_merge_customers(text,text,text,text,text)'::regprocedure);
  v := pg_temp._swap(v, $a$  delete from customer_handoffs where customer_id = p_drop; -- two-minute sign-in codes: nothing to keep$a$,
    $b$  -- One live award per person per session: the keeper's stands, the other waits voided for an unmerge.
  with u as (update volunteer_hours dup set voided_at = now(), voided_by = 'merge'
              where dup.customer_id = p_drop and dup.source = 'session' and dup.voided_at is null
                and exists (select 1 from volunteer_hours kept where kept.customer_id = p_keep and kept.session_id = dup.session_id
                             and kept.source = 'session' and kept.voided_at is null) returning dup.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_hours_void', to_jsonb(ids));
  with u as (update volunteer_hours set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_hours', to_jsonb(ids));
  with u as (update volunteer_shifts h set customer_id = p_keep where h.customer_id = p_drop
              and not exists (select 1 from volunteer_shifts x where x.customer_id = p_keep and x.session_id = h.session_id) returning h.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_shifts', to_jsonb(ids));
  update volunteer_log set customer_id = p_keep where customer_id = p_drop;
  if not exists (select 1 from volunteers where customer_id = p_keep)
     and exists (select 1 from volunteers where customer_id = p_drop) then
    update volunteers set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('volunteer', true);
  end if;
  delete from customer_handoffs where customer_id = p_drop; -- two-minute sign-in codes: nothing to keep$b$);
  execute v;

  v := pg_get_functiondef('public.staff_unmerge_customers(bigint)'::regprocedure);
  v := pg_temp._swap(v, $a$  for tg in select x from jsonb_array_elements_text(coalesce(m.moved->'tags_moved', '[]')) x loop$a$,
    $b$  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_hours', '[]')) x;
  update volunteer_hours set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_hours_void', '[]')) x;
  update volunteer_hours set voided_at = null, voided_by = null where id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_shifts', '[]')) x;
  update volunteer_shifts set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  if coalesce((m.moved->>'volunteer')::boolean, false)
     and not exists (select 1 from volunteers where customer_id = m.drop_id) then
    update volunteers set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;

  for tg in select x from jsonb_array_elements_text(coalesce(m.moved->'tags_moved', '[]')) x loop$b$);
  execute v;

  -- An anonymised account keeps its totals and nothing that names or describes the person.
  v := pg_get_functiondef('public._purge_old(boolean)'::regprocedure);
  v := pg_temp._swap(v, $a$      delete from customer_notes where customer_id = any(ids);$a$,
    $b$      delete from customer_notes where customer_id = any(ids);
      delete from volunteers where customer_id = any(ids);
      update volunteer_hours set note = null where customer_id = any(ids) and note is not null;
      update volunteer_shifts set note = null, message = null, pref_role = null where customer_id = any(ids);$b$);
  execute v;
end $do$;

do $chk$
begin
  if pg_get_functiondef('public.staff_set_access(uuid,text,text[],text[])'::regprocedure) not like '%''volunteers''%' then
    raise exception 'the section is not in staff_set_access';
  end if;
  if pg_get_functiondef('public.staff_move_session(text,text,text,boolean)'::regprocedure) not like '%volunteer_sessions%'
     or pg_get_functiondef('public.staff_merge_customers(text,text,text,text,text)'::regprocedure) not like '%volunteer_hours%'
     or pg_get_functiondef('public.staff_unmerge_customers(bigint)'::regprocedure) not like '%volunteer_hours%'
     or pg_get_functiondef('public._purge_old(boolean)'::regprocedure) not like '%volunteer_hours%' then
    raise exception 'a patch did not land';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261105120000', 'volunteers')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): RLS on all six tables, definer functions, nothing switched on yet, the ledger row.
select (select count(*) from pg_class where oid in ('public.volunteers'::regclass, 'public.volunteer_sessions'::regclass, 'public.volunteer_shifts'::regclass,
          'public.volunteer_hours'::regclass, 'public.volunteer_settings'::regclass, 'public.volunteer_log'::regclass) and relrowsecurity) as rls_6,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and (proname like 'volunteer\_%' or proname like 'staff\_volunteer%')
         and proname not in ('staff_volunteer_find', 'staff_volunteer_checkin', 'staff_volunteer_donated')) as definer_20,
       (select count(*) from public.volunteer_sessions where enabled) as switched_on,
       (select version from supabase_migrations.schema_migrations where version = '20261105120000') as ledger;
