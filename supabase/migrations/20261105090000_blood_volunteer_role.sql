-- ============================================================================
-- The Volunteer role (2026-11-05): a staff account that can only check donors in and mark them donated, on one Blood
-- Donation session, between two times.
--
--  1. A volunteer has a staff row (the usual sign-in, name, forced password change and switch-off), but is_staff(),
--     _staff_mod() and _staff_cap() answer false for the role. Every policy and function that trusts them refuses it:
--     no customers, money, reports, other sessions or realtime. The staff row's own reads and writes stay
--     (staff read self, staff_my_settings, staff_my_prefs, staff_mark_pwd_changed, staff_set_own_email).
--  2. volunteer_sessions: the window of a session volunteers work. staff.volunteer_session ties an account to one
--     window, stamped when the account is made a volunteer; a later event's window does not bring it back.
--  3. _volunteer_session(): the session the caller may work on right now, or null: wrong role, switched off, temporary
--     password not changed yet, or outside the window. All three functions below begin there.
--  4. staff_volunteer_find: a ticket's reference, or a whole mobile or booking number; returns name, number and marks
--     only, never a list. Typed searches 30 per 10 minutes, scans 200; every search is logged.
--  5. staff_volunteer_checkin, staff_volunteer_donated: forward on any live row, back only on the volunteer's own mark.
--     The free-ride code is made as staff_blood_donated makes it (_blood_donated_apply) and never returned.
--  6. volunteer_log: who searched and marked what. Admins read it.
--
-- The staff_ prefix is deliberate: _cact_row reads staff_ functions as staff, not as customer activity.
--
-- Rollback:
--   update public.staff set disabled_at = now() where role = 'volunteer';
--   re-create is_staff, _staff_mod and _staff_cap without the role line;
--   drop function if exists public.staff_volunteer_find(text, integer, text, integer),
--     public.staff_volunteer_checkin(text, boolean), public.staff_volunteer_donated(text, boolean);
--   then take 'volunteer' back out of staff_invite and staff_set_access (the two patches below, backwards).
--   The code path in staff_blood_donated keeps working either way. Marks made stay.
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


/* -- 2. the window, and the account's tie to it ------------------------------------------------ */
create table if not exists public.volunteer_sessions (
  session_id text primary key references public.sessions (id) on update cascade on delete cascade,
  opens_at   timestamptz not null,
  closes_at  timestamptz not null,
  check (closes_at > opens_at)
);
alter table public.volunteer_sessions enable row level security;
revoke all on public.volunteer_sessions from public, anon, authenticated;

insert into public.volunteer_sessions (session_id, opens_at, closes_at)
select s.id, '2026-11-05 16:00:00+03', '2026-11-06 00:00:00+03'
  from public.sessions s where s.id = '2026-11-05-bd'
on conflict (session_id) do nothing;

alter table public.staff add column if not exists volunteer_session text
  references public.volunteer_sessions (session_id) on update cascade on delete set null;
comment on column public.staff.volunteer_session is
  'The one session this volunteer account may work on; null on every other role (20261105090000).';


/* -- 6. the log -------------------------------------------------------------------------------- */
create table if not exists public.volunteer_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  user_id    uuid not null,
  session_id text not null,
  action     text not null check (action in ('scan', 'search', 'checkin', 'uncheckin', 'donated', 'undonated')),
  entry_id   text
);
create index if not exists volunteer_log_user_at on public.volunteer_log (user_id, at desc);
create index if not exists volunteer_log_entry on public.volunteer_log (entry_id, at desc) where entry_id is not null;
alter table public.volunteer_log enable row level security;
revoke all on public.volunteer_log from public, anon, authenticated;
grant select on public.volunteer_log to authenticated;
drop policy if exists "admin read" on public.volunteer_log;
create policy "admin read" on public.volunteer_log for select using ((select is_admin()));


/* -- 1. the role is not staff ------------------------------------------------------------------ */
create or replace function public.is_staff()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
  select exists(select 1 from staff where user_id = auth.uid() and disabled_at is null and role is distinct from 'volunteer');
$function$;

create or replace function public._staff_mod(p_mod text, p_edit boolean default false)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists(
    select 1 from staff s
     where s.user_id = auth.uid() and s.disabled_at is null
       and s.role is distinct from 'volunteer'  -- an empty list means every section to this function (20261105090000)
       and not (p_edit and s.role = 'owner')  -- the Owner role only looks
       and (s.role = 'admin'
            or (case when p_edit then s.modules_edit else s.modules_view end) is null
            or p_mod = any(case when p_edit then s.modules_edit else s.modules_view end)))
$function$;

create or replace function public._staff_cap(p_cap text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select exists(
    select 1 from staff s
     where s.user_id = auth.uid() and s.disabled_at is null
       and s.role is distinct from 'volunteer'  -- can_refund and can_see_costs default to true (20261105090000)
       and (s.role = 'admin'
            or case when jsonb_typeof(s.caps -> p_cap) = 'boolean' then (s.caps ->> p_cap)::boolean
                    else p_cap in ('can_refund', 'can_see_costs') end))
$function$;


/* -- the next window, for an account being made a volunteer ------------------------------------- */
create or replace function public._volunteer_next()
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select w.session_id from volunteer_sessions w where w.closes_at > now() order by w.opens_at limit 1;
$function$;
revoke all on function public._volunteer_next() from public, anon, authenticated;

do $do$
declare v text;
begin
  v := pg_get_functiondef('public.staff_invite(text,text,text,text)'::regprocedure);
  v := pg_temp._once(v, $a$('admin', 'manager', 'frontdesk', 'leader', 'mechanic', 'cashier', 'owner')$a$,
                        $b$('admin', 'manager', 'frontdesk', 'leader', 'mechanic', 'cashier', 'owner', 'volunteer')$b$);
  v := pg_temp._once(v, $a$  if length(coalesce(p_password, '')) < 8$a$,
                        $b$  if p_role = 'volunteer' and _volunteer_next() is null then raise exception 'NO_VOLUNTEER_SESSION' using errcode = 'P0001'; end if;
  if length(coalesce(p_password, '')) < 8$b$);
  v := pg_temp._once(v, $a$insert into staff (user_id, role, must_change_pwd, display_name) values (v_uid, p_role, true, v_name);$a$,
                        $b$insert into staff (user_id, role, must_change_pwd, display_name, volunteer_session)
    values (v_uid, p_role, true, v_name, case when p_role = 'volunteer' then _volunteer_next() end);$b$);
  execute v;

  v := pg_get_functiondef('public.staff_set_access(uuid,text,text[],text[])'::regprocedure);
  v := pg_temp._once(v, $a$('admin', 'manager', 'frontdesk', 'leader', 'mechanic', 'cashier', 'owner')$a$,
                        $b$('admin', 'manager', 'frontdesk', 'leader', 'mechanic', 'cashier', 'owner', 'volunteer')$b$);
  v := pg_temp._once(v, $a$  if p_view is not null and not (p_view <@ allowed)$a$,
                        $b$  if p_role = 'volunteer' and _volunteer_next() is null then raise exception 'NO_VOLUNTEER_SESSION' using errcode = 'P0001'; end if;
  if p_view is not null and not (p_view <@ allowed)$b$);
  v := pg_temp._once(v, $a$update staff set role = p_role, modules_view = p_view, modules_edit = p_edit where user_id = p_user;$a$,
                        $b$update staff set role = p_role,
         modules_view = case when p_role = 'volunteer' then '{}'::text[] else p_view end,
         modules_edit = case when p_role = 'volunteer' then '{}'::text[] else p_edit end,
         volunteer_session = case when p_role = 'volunteer' then _volunteer_next() end
   where user_id = p_user;$b$);
  execute v;
end $do$;


/* -- 3. what the caller may work on ------------------------------------------------------------ */
create or replace function public._volunteer_session()
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select s.volunteer_session
    from staff s join volunteer_sessions w on w.session_id = s.volunteer_session
   where s.user_id = auth.uid() and s.role = 'volunteer' and s.disabled_at is null
     and not coalesce(s.must_change_pwd, false)
     and now() >= w.opens_at and now() < w.closes_at;
$function$;
revoke all on function public._volunteer_session() from public, anon, authenticated;

-- Whether the latest of a pair of marks on this booking is this user's "on".
create or replace function public._volunteer_mine(p_entry text, p_on text, p_off text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce((select l.user_id = auth.uid() and l.action = p_on
    from volunteer_log l where l.entry_id = p_entry and l.action in (p_on, p_off)
   order by l.at desc, l.id desc limit 1), false);
$function$;
revoke all on function public._volunteer_mine(text, text, text) from public, anon, authenticated;

-- A mobile as one form: digits only, without 00, 966 or a leading 0.
create or replace function public._volunteer_phone(p text)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$
  select regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''), '\D', '', 'g'), '^(00)?(966)?', ''), '^0+', '');
$function$;
revoke all on function public._volunteer_phone(text) from public, anon, authenticated;


/* -- 4. finding one donor ---------------------------------------------------------------------- */
create or replace function public.staff_volunteer_find(p_ref text default null, p_ref_num integer default null,
                                                       p_mobile text default null, p_number integer default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  _sess text := _volunteer_session();
  _scan boolean := p_ref is not null;
  _mobile text := _volunteer_phone(p_mobile);
begin
  if _sess is null then raise exception 'VOL_CLOSED' using errcode = '42501'; end if;
  if (_scan::int + (p_mobile is not null)::int + (p_number is not null)::int) <> 1
     or (_scan and p_ref !~ '^[0-9A-Za-z-]{4,8}$')
     or (p_mobile is not null and length(_mobile) < 7) then
    raise exception 'VOL_BAD_SEARCH' using errcode = '22023';
  end if;
  if (select count(*) from volunteer_log l
       where l.user_id = auth.uid() and l.action = case when _scan then 'scan' else 'search' end
         and l.at > now() - interval '10 minutes') >= (case when _scan then 200 else 30 end) then
    raise exception 'VOL_SLOW' using errcode = 'P0001';
  end if;
  insert into volunteer_log (user_id, session_id, action) values (auth.uid(), _sess, case when _scan then 'scan' else 'search' end);

  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'name', r.name, 'number', r.queue_num,
             'checked_in', r.status in ('active', 'done'),
             'donated', r.donated_at is not null,
             'mine_in', _volunteer_mine(r.id, 'checkin', 'uncheckin'),
             'mine_donated', _volunteer_mine(r.id, 'donated', 'undonated')) order by r.queue_num)
      from (select q.id, q.name, q.queue_num, q.status, q.donated_at
              from queue_entries q left join customers c on c.id = q.customer_id
             where q.session_id = _sess
               and q.status in ('waiting', 'waitlist', 'active', 'done')
               and ((_scan and lower(q.id) like lower(replace(replace(p_ref, '\', ''), '%', '')) || '%'
                           and (p_ref_num is null or q.queue_num = p_ref_num))
                 or (p_mobile is not null and _volunteer_phone(c.phone) = _mobile)
                 or (p_number is not null and q.queue_num = p_number))
             order by q.queue_num limit 5) r), '[]'::jsonb);
end $function$;
revoke all on function public.staff_volunteer_find(text, integer, text, integer) from public, anon;
grant execute on function public.staff_volunteer_find(text, integer, text, integer) to authenticated;


/* -- 5. check-in ------------------------------------------------------------------------------- */
create or replace function public.staff_volunteer_checkin(p_entry_id text, p_on boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  _sess text := _volunteer_session();
  q queue_entries%rowtype;
begin
  if _sess is null then raise exception 'VOL_CLOSED' using errcode = '42501'; end if;
  select * into q from queue_entries where id = p_entry_id and session_id = _sess for update;
  if not found then raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001'; end if;

  if coalesce(p_on, false) then
    if q.status in ('active', 'done') then return jsonb_build_object('ok', true, 'noop', true); end if;
    if q.status not in ('waiting', 'waitlist') then raise exception 'BAD_BOOKING_STATE' using errcode = 'P0001'; end if;
    update queue_entries set status = 'active', checked_in_at = _iso_now() where id = q.id;
    insert into volunteer_log (user_id, session_id, action, entry_id) values (auth.uid(), _sess, 'checkin', q.id);
    return jsonb_build_object('ok', true);
  end if;

  if q.status in ('waiting', 'waitlist') then return jsonb_build_object('ok', true, 'noop', true); end if;
  if q.status <> 'active' then raise exception 'BAD_BOOKING_STATE' using errcode = 'P0001'; end if;
  if q.donated_at is not null then raise exception 'VOL_DONATED_FIRST' using errcode = 'P0001'; end if;
  if not _volunteer_mine(q.id, 'checkin', 'uncheckin') then raise exception 'VOL_NOT_YOURS' using errcode = '42501'; end if;
  update queue_entries set status = 'waiting', checked_in_at = null where id = q.id;
  insert into volunteer_log (user_id, session_id, action, entry_id) values (auth.uid(), _sess, 'uncheckin', q.id);
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.staff_volunteer_checkin(text, boolean) from public, anon;
grant execute on function public.staff_volunteer_checkin(text, boolean) to authenticated;


/* -- 5. donated: staff_blood_donated's body moves as it was, behind each caller's own gate --------- */
create or replace function public._blood_donated_apply(p_entry_id text, p_on boolean)
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
revoke all on function public._blood_donated_apply(text, boolean) from public, anon, authenticated;

create or replace function public.staff_blood_donated(p_entry_id text, p_on boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not (select is_staff()) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return _blood_donated_apply(p_entry_id, p_on);
end $function$;
revoke all on function public.staff_blood_donated(text, boolean) from public, anon;
grant execute on function public.staff_blood_donated(text, boolean) to authenticated;

create or replace function public.staff_volunteer_donated(p_entry_id text, p_on boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  _sess text := _volunteer_session();
  q queue_entries%rowtype;
begin
  if _sess is null then raise exception 'VOL_CLOSED' using errcode = '42501'; end if;
  select * into q from queue_entries where id = p_entry_id and session_id = _sess for update;
  if not found then raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001'; end if;

  if coalesce(p_on, false) then
    if q.donated_at is not null then return jsonb_build_object('ok', true, 'noop', true); end if;
    perform _blood_donated_apply(q.id, true);
    insert into volunteer_log (user_id, session_id, action, entry_id) values (auth.uid(), _sess, 'donated', q.id);
    return jsonb_build_object('ok', true);
  end if;

  if q.donated_at is null then return jsonb_build_object('ok', true, 'noop', true); end if;
  if not _volunteer_mine(q.id, 'donated', 'undonated') then raise exception 'VOL_NOT_YOURS' using errcode = '42501'; end if;
  perform _blood_donated_apply(q.id, false);
  insert into volunteer_log (user_id, session_id, action, entry_id) values (auth.uid(), _sess, 'undonated', q.id);
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.staff_volunteer_donated(text, boolean) from public, anon;
grant execute on function public.staff_volunteer_donated(text, boolean) to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261105090000', 'blood_volunteer_role')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): definer functions 11, the role refused by the three gates, both new tables with RLS, the window, the ledger row.
select (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('is_staff', '_staff_mod', '_staff_cap', '_volunteer_next', '_volunteer_session', '_volunteer_mine',
                         '_blood_donated_apply', 'staff_blood_donated', 'staff_volunteer_find', 'staff_volunteer_checkin', 'staff_volunteer_donated')) as definer_11,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
         and proname in ('is_staff', '_staff_mod', '_staff_cap') and prosrc like '%''volunteer''%') as gates_3,
       (select count(*) from pg_class where oid in ('public.volunteer_sessions'::regclass, 'public.volunteer_log'::regclass) and relrowsecurity) as rls_2,
       (select opens_at || ' to ' || closes_at from public.volunteer_sessions where session_id = '2026-11-05-bd') as window_prod,
       (select version from supabase_migrations.schema_migrations where version = '20261105090000') as ledger;
