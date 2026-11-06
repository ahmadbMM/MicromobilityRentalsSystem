-- ============================================================================
-- Volunteers, the staff review of 2026-11-06, part 2 (VL11-VL18, ST14). Only new columns, tables and functions:
-- no existing staff_volunteer_* function and not volunteer_enter is redefined here (a sibling migration changes them).
--
--  1. volunteer_shifts.briefed_at: the volunteer ticked "I have read the briefing" on the portal (volunteer_brief_ack).
--     Changing a session's briefing clears every tick on it (trigger volunteer_sessions_briefing).
--  2. volunteer_shifts.reminded_at / reminded_by: staff sent the team its reminder on WhatsApp (staff_volunteer_reminded).
--     There is no server sender for pushes (the only push sender, functions/api/push-send.js, is a staff-triggered call,
--     dormant until its keys are set), so no automatic reminder is sent from here.
--  3. volunteers.skills / days / whatsapp: the portal's "Become a volunteer" form (volunteer_apply) and the weekdays a
--     volunteer is usually free (0 Sunday .. 6 Saturday); staff edit them with staff_volunteer_profile_save.
--     volunteer_profile is what the portal reads of it, with the briefing ticks.
--  4. volunteer_certs: a certificate for a period, with a serial and a check code; volunteer_cert_check(code) is the one
--     thing anyone may ask (an employer or a university), and answers only what the certificate says.
--  5. staff_volunteer_shift_times_many / staff_volunteer_hours_add_many: many people in one call (one connection at
--     the rush), each row through the one-person function, so its checks and its records stay the same.
--
-- Rollback: drop the functions below, drop table volunteer_certs, drop trigger volunteer_sessions_briefing,
-- alter table volunteer_shifts drop column briefed_at, reminded_at, reminded_by;
-- alter table volunteers drop column skills, days, whatsapp.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

/* -- 1-3. columns ------------------------------------------------------------------------------ */
alter table public.volunteer_shifts
  add column if not exists briefed_at  timestamptz,
  add column if not exists reminded_at timestamptz,
  add column if not exists reminded_by text check (char_length(reminded_by) <= 120);
alter table public.volunteers
  add column if not exists skills   text check (char_length(skills) <= 300),
  add column if not exists days     smallint[] not null default '{}',
  add column if not exists whatsapp text check (char_length(whatsapp) <= 20);
comment on column public.volunteer_shifts.briefed_at is 'The volunteer ticked "I have read the briefing" (20261107131000); cleared when the briefing changes.';
comment on column public.volunteer_shifts.reminded_at is 'Staff sent this person the session''s reminder on WhatsApp (20261107131000).';
comment on column public.volunteers.days is 'Weekdays the volunteer is usually free, 0 = Sunday .. 6 = Saturday (20261107131000).';

-- Editing the briefing clears every "I have read it": they have not read the new one.
create or replace function public._vol_brief_reset()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  update volunteer_shifts set briefed_at = null where session_id = new.session_id and briefed_at is not null;
  return null;
end $function$;
revoke all on function public._vol_brief_reset() from public, anon, authenticated;
drop trigger if exists volunteer_sessions_briefing on public.volunteer_sessions;
create trigger volunteer_sessions_briefing after update of briefing on public.volunteer_sessions
  for each row when (old.briefing is distinct from new.briefing) execute function public._vol_brief_reset();


/* -- 4. certificates -------------------------------------------------------------------------- */
create table if not exists public.volunteer_certs (
  id          bigint generated always as identity primary key,
  serial      text not null unique,
  code        text not null unique check (code ~ '^[A-Z0-9]{12}$'),
  customer_id text references public.customers (id) on update cascade on delete set null,
  name        text not null check (char_length(name) <= 120),
  period_from date not null,
  period_to   date not null check (period_to >= period_from),
  hours       numeric(8, 2) not null,
  sessions    jsonb not null default '[]'::jsonb,
  issued_at   timestamptz not null default now(),
  issued_by   text,
  revoked_at  timestamptz,
  revoked_by  text
);
create index if not exists volunteer_certs_customer on public.volunteer_certs (customer_id, issued_at desc);
alter table public.volunteer_certs enable row level security;
revoke all on public.volunteer_certs from public, anon, authenticated;
grant select on public.volunteer_certs to authenticated;
drop policy if exists "staff read" on public.volunteer_certs;
create policy "staff read" on public.volunteer_certs for select
  using ((select _staff_mod('volunteers')) or (select _staff_mod('customers')));

-- The certificate itself: the account's live hours between two days, and the sessions they were given for.
create or replace function public._vol_cert_make(p_customer text, p_from date, p_to date, p_by text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _name text; _h numeric; _s jsonb; _code text; _id bigint; _serial text;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to > _vol_today() or p_to - p_from > 3660 then
    raise exception 'BAD_DATE' using errcode = '22023';
  end if;
  select c.name into _name from customers c where c.id = p_customer and c.merged_into is null;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select coalesce(sum(h.hours), 0) into _h from volunteer_hours h
   where h.customer_id = p_customer and h.voided_at is null and h.worked_on between p_from and p_to;
  if _h <= 0 then raise exception 'VOL_CERT_EMPTY' using errcode = 'P0001'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('title', x.title, 'ride_kind', x.ride_kind, 'date', x.d, 'hours', x.h) order by x.d, x.title), '[]'::jsonb) into _s
    from (select s.title, s.ride_kind, min(h.worked_on) d, sum(h.hours) h
            from volunteer_hours h join sessions s on s.id = h.session_id
           where h.customer_id = p_customer and h.voided_at is null and h.worked_on between p_from and p_to
           group by s.id, s.title, s.ride_kind having sum(h.hours) > 0) x;
  _code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into volunteer_certs (serial, code, customer_id, name, period_from, period_to, hours, sessions, issued_by)
  values ('pending-' || _code, _code, p_customer, left(coalesce(nullif(btrim(_name), ''), '-'), 120), p_from, p_to, _h, _s, p_by)
  returning id into _id;
  _serial := 'MMV-' || to_char(_vol_today(), 'YYYY') || '-' || lpad(_id::text, 5, '0');
  update volunteer_certs set serial = _serial where id = _id;
  return jsonb_build_object('ok', true, 'id', _id, 'serial', _serial, 'code', _code, 'name', _name, 'from', p_from, 'to', p_to,
    'hours', _h, 'sessions', _s, 'issued_at', now());
end $function$;
revoke all on function public._vol_cert_make(text, date, date, text) from public, anon, authenticated;

create or replace function public.staff_volunteer_cert_issue(p_customer text, p_from date, p_to date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not ((select _staff_mod('volunteers', true)) or (select _staff_mod('customers', true))) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return _vol_cert_make(p_customer, p_from, p_to, _vol_op());
end $function$;

create or replace function public.staff_volunteer_cert_revoke(p_id bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not ((select _staff_mod('volunteers', true)) or (select _staff_mod('customers', true))) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update volunteer_certs set revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, _vol_op()) where id = p_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true);
end $function$;

-- The volunteer's own, from the portal: any period of their own hours.
create or replace function public.volunteer_cert_issue(p_id text, p_token text, p_from date, p_to date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  if (select count(*) from volunteer_certs c where c.customer_id = p_id and c.issued_at > now() - interval '1 day') >= 10 then
    raise exception 'VOL_SLOW' using errcode = 'P0001';
  end if;
  return _vol_cert_make(p_id, p_from, p_to, 'portal');
end $function$;

-- Anyone holding the code: what the certificate says, and whether it still stands. Nothing else about the person.
create or replace function public.volunteer_cert_check(p_code text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce((select jsonb_build_object('ok', true, 'serial', c.serial, 'name', c.name, 'from', c.period_from, 'to', c.period_to,
                                              'hours', c.hours, 'sessions', c.sessions, 'issued_at', c.issued_at, 'revoked', c.revoked_at is not null)
                     from volunteer_certs c where c.code = upper(btrim(coalesce(p_code, ''))) and coalesce(p_code, '') ~* '^\s*[a-z0-9]{12}\s*$'),
                  jsonb_build_object('ok', false));
$function$;


/* -- 1-3. the portal's own calls ---------------------------------------------------------------- */
create or replace function public.volunteer_brief_ack(p_id text, p_token text, p_session text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _at timestamptz;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  update volunteer_shifts sh set briefed_at = coalesce(sh.briefed_at, now())
   where sh.session_id = p_session and sh.customer_id = p_id and sh.status in ('accepted', 'done')
     and exists (select 1 from volunteer_sessions w where w.session_id = sh.session_id and nullif(btrim(coalesce(w.briefing, '')), '') is not null)
  returning sh.briefed_at into _at;
  if not found then raise exception 'VOL_NOT_ACCEPTED' using errcode = '42501'; end if;
  return jsonb_build_object('ok', true, 'briefed_at', _at);
end $function$;

-- What the portal shows beside volunteer_me: the application's fields and which briefings were read.
create or replace function public.volunteer_profile(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v volunteers%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return null; end if;
  select * into v from volunteers where customer_id = p_id;
  return jsonb_build_object(
    'status', v.status, 'applied_at', v.applied_at, 'skills', v.skills, 'days', coalesce(to_jsonb(v.days), '[]'::jsonb),
    'shirt', v.shirt, 'whatsapp', v.whatsapp,
    'briefed', coalesce((select jsonb_object_agg(sh.session_id, sh.briefed_at) from volunteer_shifts sh
                          where sh.customer_id = p_id and sh.briefed_at is not null), '{}'::jsonb));
end $function$;

-- "Become a volunteer", and later the same fields kept up to date. A first application is 'applied' until staff
-- accept it; a paused or removed volunteer is refused as everywhere else.
create or replace function public.volunteer_apply(p_id text, p_token text, p_skills text default null, p_days int[] default null,
                                                  p_shirt text default null, p_whatsapp text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v volunteers%rowtype; c record; _days smallint[]; _wa text; _shirt text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  select x.must_change_pwd, x.deletion_requested_at into c from customers x where x.id = p_id;
  if coalesce(c.must_change_pwd, false) or c.deletion_requested_at is not null then raise exception 'VOL_ACCOUNT' using errcode = '42501'; end if;
  select * into v from volunteers where customer_id = p_id for update;
  if found and v.status in ('paused', 'removed') then raise exception 'VOL_NOT_VOLUNTEER' using errcode = '42501'; end if;
  _days := array(select distinct d::smallint from unnest(coalesce(p_days, '{}')) d where d between 0 and 6 order by 1);
  _wa := nullif(regexp_replace(coalesce(p_whatsapp, ''), '[^0-9+]', '', 'g'), '');
  if _wa is not null and _wa !~ '^\+?[0-9]{7,15}$' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  _shirt := nullif(btrim(coalesce(p_shirt, '')), '');
  if _shirt is not null and _shirt not in ('XS', 'S', 'M', 'L', 'XL', 'XXL') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  insert into volunteers (customer_id, status, applied_at, skills, days, shirt, whatsapp)
  values (p_id, 'applied', now(), nullif(left(btrim(coalesce(p_skills, '')), 300), ''), _days, _shirt, _wa)
  on conflict (customer_id) do update set
    skills = excluded.skills, days = excluded.days, shirt = coalesce(excluded.shirt, volunteers.shirt),
    whatsapp = excluded.whatsapp, applied_at = coalesce(volunteers.applied_at, now()), updated_at = now();
  return jsonb_build_object('ok', true, 'status', coalesce(v.status, 'applied'));
end $function$;


/* -- staff ------------------------------------------------------------------------------------- */
create or replace function public.staff_volunteer_profile_save(p_customer text, p_days int[] default null, p_skills text default null, p_whatsapp text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _wa text;
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  _wa := nullif(regexp_replace(coalesce(p_whatsapp, ''), '[^0-9+]', '', 'g'), '');
  if _wa is not null and _wa !~ '^\+?[0-9]{7,15}$' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  update volunteers set
    days = case when p_days is null then days else array(select distinct d::smallint from unnest(p_days) d where d between 0 and 6 order by 1) end,
    skills = case when p_skills is null then skills else nullif(left(btrim(p_skills), 300), '') end,
    whatsapp = case when p_whatsapp is null then whatsapp else _wa end,
    updated_at = now()
   where customer_id = p_customer;
  if not found then raise exception 'VOL_NOT_VOLUNTEER' using errcode = 'P0001'; end if;
  return jsonb_build_object('ok', true);
end $function$;

-- The team was sent its reminder (Message team, one by one on WhatsApp).
create or replace function public.staff_volunteer_reminded(p_session text, p_customers text[])
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _n int;
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update volunteer_shifts set reminded_at = now(), reminded_by = _vol_op()
   where session_id = p_session and customer_id = any(coalesce(p_customers, '{}'));
  get diagnostics _n = row_count;
  return jsonb_build_object('ok', true, 'n', _n);
end $function$;

-- Check-in and check-out for many people in one call: [{customer_id, in, out}], each through
-- staff_volunteer_shift_times. A row it refuses is named in failed; the others stand.
create or replace function public.staff_volunteer_shift_times_many(p_session text, p_rows jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r jsonb; _n int := 0; _bad jsonb := '[]'::jsonb;
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    begin
      perform staff_volunteer_shift_times(p_session, r ->> 'customer_id', nullif(r ->> 'in', '')::timestamptz, nullif(r ->> 'out', '')::timestamptz);
      _n := _n + 1;
    exception when others then
      _bad := _bad || jsonb_build_array(jsonb_build_object('customer_id', r ->> 'customer_id', 'error', sqlerrm));
    end;
  end loop;
  return jsonb_build_object('ok', true, 'n', _n, 'failed', _bad);
end $function$;

-- The same hours for many people in one call, each through staff_volunteer_hours_add.
create or replace function public.staff_volunteer_hours_add_many(p_customers text[], p_hours numeric, p_on date default null, p_session text default null, p_note text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _c text; _n int := 0; _bad jsonb := '[]'::jsonb;
begin
  if not ((select _staff_mod('volunteers', true)) or (select _staff_mod('customers', true))) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if coalesce(array_length(p_customers, 1), 0) > 500 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  foreach _c in array coalesce(p_customers, '{}') loop
    begin
      perform staff_volunteer_hours_add(_c, p_hours, p_on, p_session, p_note);
      _n := _n + 1;
    exception when others then
      _bad := _bad || jsonb_build_array(jsonb_build_object('customer_id', _c, 'error', sqlerrm));
    end;
  end loop;
  return jsonb_build_object('ok', true, 'n', _n, 'failed', _bad);
end $function$;


do $do$
declare f text;
begin
  foreach f in array array['volunteer_brief_ack(text,text,text)', 'volunteer_profile(text,text)', 'volunteer_apply(text,text,text,integer[],text,text)',
                           'volunteer_cert_issue(text,text,date,date)', 'volunteer_cert_check(text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  foreach f in array array['staff_volunteer_profile_save(text,integer[],text,text)', 'staff_volunteer_reminded(text,text[])',
                           'staff_volunteer_shift_times_many(text,jsonb)', 'staff_volunteer_hours_add_many(text[],numeric,date,text,text)',
                           'staff_volunteer_cert_issue(text,date,date)', 'staff_volunteer_cert_revoke(bigint)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $do$;

do $chk$
begin
  if (select count(*) from information_schema.columns where table_schema = 'public'
       and ((table_name = 'volunteer_shifts' and column_name in ('briefed_at', 'reminded_at', 'reminded_by'))
         or (table_name = 'volunteers' and column_name in ('skills', 'days', 'whatsapp')))) <> 6 then
    raise exception 'a column is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.volunteer_certs'::regclass) then
    raise exception 'volunteer_certs has no RLS';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261107131000', 'volunteers_review2')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): the columns, RLS on the certificates, the definer functions, the trigger, the ledger row.
select (select count(*) from information_schema.columns where table_schema = 'public'
          and ((table_name = 'volunteer_shifts' and column_name in ('briefed_at', 'reminded_at', 'reminded_by'))
            or (table_name = 'volunteers' and column_name in ('skills', 'days', 'whatsapp')))) as columns_6,
       (select relrowsecurity from pg_class where oid = 'public.volunteer_certs'::regclass) as certs_rls,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('volunteer_brief_ack', 'volunteer_profile', 'volunteer_apply', 'volunteer_cert_issue', 'volunteer_cert_check',
                         'staff_volunteer_profile_save', 'staff_volunteer_reminded', 'staff_volunteer_shift_times_many',
                         'staff_volunteer_hours_add_many', 'staff_volunteer_cert_issue', 'staff_volunteer_cert_revoke',
                         '_vol_cert_make', '_vol_brief_reset')) as definer_13,
       (select count(*) from pg_trigger where tgname = 'volunteer_sessions_briefing') as trigger_1,
       (select version from supabase_migrations.schema_migrations where version = '20261107131000') as ledger;
