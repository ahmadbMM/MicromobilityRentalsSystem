-- ============================================================================
-- The volunteer certificate on the approved design (certificate/SPEC.md), 2026-11-08.
-- The design is one page per certificate with one line for what it was given for, so a
-- certificate now says which kind it is and carries what the page prints:
--
--  1. volunteer_certs.kind: 'period' (what staff and the portal already make: every hour
--     between two days) or 'session' (one event). A session certificate is the same row with
--     session_id, initiative and event_date filled; a period certificate leaves them null and
--     the page prints the period in their place.
--  2. volunteer_certs.name_ar / gender: what the page needs besides the name, taken from the
--     account when the certificate is made, never read live - a certificate says what it said
--     on the day it was issued.
--  3. customers.name_ar: the volunteer's name in Arabic, which nothing stored before. They type
--     it on the portal (volunteer_name_ar_save) and it goes on their next certificate; blank is
--     normal and the design drops the line.
--  4. _vol_cert_make_session + staff_volunteer_cert_issue_session (one person),
--     staff_volunteer_cert_issue_session_many (a whole team, each row through the one-person
--     function) and volunteer_cert_issue_session (the volunteer's own, from the portal).
--  5. volunteer_cert_check answers the new fields too, so the check page can say whether the
--     certificate is for an event or for a period.
--  6. volunteer_certs.words: the three lines the page prints, stamped when the certificate is made.
--     _vol_cert_words(gender) is where they come from, and it says the gender in both languages
--     (the owner, 2026-11-08: "make sure current certs be given and worded based on gender"):
--     his / her in English, the male or female form in Arabic, and a wording that names neither
--     when the gender is not known. Storing them means a reprint years later says what it said.
--  7. kind 'custom' + staff_volunteer_cert_issue_custom: staff write the three lines and the line
--     in the green box themselves, for anyone - the name is typed and an account is optional
--     (the owner, 2026-11-08). It is a certificate like any other: a serial, a code, revocable.
--  8. staff_volunteer_cert_issue / _session take p_gender, for an account that has none on it.
--
-- Nothing here changes what an already issued certificate says: kind defaults to 'period',
-- which is what every existing row is.
--
-- Asking twice for the same person and event gives back the certificate they already have ('again'
-- in the answer), and a unique index holds that even if two calls race.
--
-- Rollback: drop the functions added below (incl. _vol_cert_words, _vol_gender and
-- staff_volunteer_cert_issue_custom), drop index volunteer_certs_one_per_session, restore
-- _vol_cert_make (four arguments), staff_volunteer_cert_issue (three) and volunteer_cert_check
-- from 20261107131000, then
--   alter table public.volunteer_certs drop column kind, session_id, initiative, event_date, name_ar, gender;
--   alter table public.customers drop column name_ar;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

/* -- 1-3. columns ------------------------------------------------------------------------------ */
alter table public.volunteer_certs
  add column if not exists kind       text not null default 'period',
  add column if not exists session_id text references public.sessions (id) on update cascade on delete set null,
  add column if not exists initiative text check (char_length(initiative) <= 80),
  add column if not exists event_date date,
  add column if not exists name_ar    text check (char_length(name_ar) <= 120),
  add column if not exists gender     text check (gender is null or gender in ('male', 'female')),
  add column if not exists words      jsonb;
do $$ begin
  alter table public.volunteer_certs add constraint volunteer_certs_kind check (kind in ('period', 'session', 'custom'));
exception when duplicate_object then null; end $$;
create index if not exists volunteer_certs_session on public.volunteer_certs (session_id) where session_id is not null;
-- One certificate per person per event, while it stands: "make one for the whole team" is a button
-- staff can press twice, and the portal has its own. Revoking one makes room for another.
create unique index if not exists volunteer_certs_one_per_session on public.volunteer_certs (customer_id, session_id)
  where kind = 'session' and revoked_at is null;
do $$ begin
  alter table public.volunteer_certs add constraint volunteer_certs_who check (customer_id is not null or kind = 'custom');
exception when duplicate_object then null; end $$;
comment on column public.volunteer_certs.kind is '''period'' (every hour between two days), ''session'' (one event) or ''custom'' (staff wrote it) (20261108220000).';
comment on column public.volunteer_certs.words is 'The three lines the page printed, as they were when it was issued: lead, recognition, arabic_line (20261108220000).';
comment on column public.volunteer_certs.initiative is 'The event''s name as the certificate prints it, taken when it was issued (20261108220000).';

alter table public.customers add column if not exists name_ar text check (char_length(name_ar) <= 120);
comment on column public.customers.name_ar is 'The person''s name in Arabic, for the volunteer certificate. Typed by them on the volunteer portal (20261108220000).';

/* -- 6. the wording, said by gender ------------------------------------------------------------ */
-- 'male', 'female', or null for anything else - a blank, a typo, or a gender the app does not know.
-- Everything below reads a gender through this, so one spelling reaches the wording and the row.
create or replace function public._vol_gender(p text)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$ select case lower(btrim(coalesce(p, ''))) when 'male' then 'male' when 'female' then 'female' else null end; $function$;

-- The three lines the certificate prints. English names the gender with his or her and Arabic with
-- the verb's form; with no gender on the account neither is named, rather than guessing at one.
-- The apps carry the same three sets, to prefill the custom form and to print a row issued before
-- this migration: tests/certificate-template.spec.ts holds this function and app.src.html together.
create or replace function public._vol_cert_words(p_gender text)
 returns jsonb
 language sql
 immutable
 set search_path to 'public'
as $function$
  select jsonb_build_object(
    'lead', 'This certificate is proudly presented to',
    'recognition', case lower(coalesce(p_gender, ''))
      when 'male'   then 'in recognition of his time, energy and commitment as a volunteer in'
      when 'female' then 'in recognition of her time, energy and commitment as a volunteer in'
      else 'in recognition of their time, energy and commitment as a volunteer in' end,
    'arabic_line', case lower(coalesce(p_gender, ''))
      when 'male'   then 'تقديرًا لعطائه ومشاركته التطوعية في المبادرة'
      when 'female' then 'تقديرًا لعطائها ومشاركتها التطوعية في المبادرة'
      else 'تقديرًا للعطاء والمشاركة التطوعية في المبادرة' end);
$function$;

/* -- 4a. the certificate for a period: the same row, now with the name in Arabic and the gender -- */
-- The four-argument one is dropped, not left beside this: a default argument would make an overload
-- of it, and both would answer calls (20261107131000 is where it came from).
drop function if exists public._vol_cert_make(text, date, date, text);
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
    'from', p_from, 'to', p_to, 'hours', _h, 'sessions', _s, 'issued_at', now());
end $function$;
revoke all on function public._vol_cert_make(text, date, date, text, text) from public, anon, authenticated;

/* -- 4b. the certificate for one event ---------------------------------------------------------- */
-- p_initiative is what the apps already call the session on screen (a Saturday ride has no title of
-- its own); the session's own title stands in, and failing that the session's id. The hours are the
-- ones the ledger holds for that session, so a certificate never claims hours nobody recorded.
create or replace function public._vol_cert_make_session(p_customer text, p_session text, p_initiative text, p_by text, p_gender text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _name text; _name_ar text; _gender text; _title text; _date date; _kind text; _h numeric;
        _code text; _id bigint; _serial text; _s jsonb; _w jsonb; _old volunteer_certs%rowtype;
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
      'hours', _old.hours, 'sessions', _old.sessions, 'issued_at', _old.issued_at, 'again', true);
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
  _code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into volunteer_certs (serial, code, customer_id, name, name_ar, gender, words, kind, session_id, initiative, event_date,
                               period_from, period_to, hours, sessions, issued_by)
  values ('pending-' || _code, _code, p_customer, left(coalesce(nullif(btrim(_name), ''), '-'), 120),
          left(nullif(btrim(coalesce(_name_ar, '')), ''), 120), _gender, _w, 'session', p_session, _title, _date,
          _date, _date, _h, _s, p_by)
  returning id into _id;
  _serial := 'MMV-' || to_char(_vol_today(), 'YYYY') || '-' || lpad(_id::text, 5, '0');
  update volunteer_certs set serial = _serial where id = _id;
  return jsonb_build_object('ok', true, 'id', _id, 'kind', 'session', 'serial', _serial, 'code', _code,
    'name', _name, 'name_ar', nullif(btrim(coalesce(_name_ar, '')), ''), 'gender', _gender, 'words', _w,
    'session_id', p_session, 'initiative', _title, 'event_date', _date,
    'from', _date, 'to', _date, 'hours', _h, 'sessions', _s, 'issued_at', now());
end $function$;
revoke all on function public._vol_cert_make_session(text, text, text, text, text) from public, anon, authenticated;

create or replace function public.staff_volunteer_cert_issue_session(p_customer text, p_session text, p_initiative text default null, p_gender text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not ((select _staff_mod('volunteers', true)) or (select _staff_mod('customers', true))) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return _vol_cert_make_session(p_customer, p_session, p_initiative, _vol_op(), p_gender);
end $function$;

-- A whole team in one call, each row through the one-person function so its checks and its record
-- stay the same (the pattern of staff_volunteer_hours_add_many). It answers which rows failed.
create or replace function public.staff_volunteer_cert_issue_session_many(p_session text, p_customers text[], p_initiative text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _c text; _failed text[] := '{}'; _made jsonb := '[]'::jsonb; _r jsonb;
begin
  if not ((select _staff_mod('volunteers', true)) or (select _staff_mod('customers', true))) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if coalesce(array_length(p_customers, 1), 0) > 200 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  foreach _c in array coalesce(p_customers, '{}') loop
    begin
      _r := _vol_cert_make_session(_c, p_session, p_initiative, _vol_op(), null);
      _made := _made || _r;
    exception when others then _failed := _failed || _c;
    end;
  end loop;
  return jsonb_build_object('ok', true, 'made', _made, 'failed', to_jsonb(_failed));
end $function$;

-- The volunteer's own, from the portal: a session they worked.
create or replace function public.volunteer_cert_issue_session(p_id text, p_token text, p_session text, p_initiative text default null)
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
  return _vol_cert_make_session(p_id, p_session, p_initiative, 'portal', null);
end $function$;

-- Both callers of _vol_cert_make are written again here: the four-argument one they were compiled
-- against is gone (20261107131000 made them). staff_volunteer_cert_issue takes a gender with it;
-- the portal's does not, because a volunteer's own account is the only word on it.
drop function if exists public.staff_volunteer_cert_issue(text, date, date);
create or replace function public.staff_volunteer_cert_issue(p_customer text, p_from date, p_to date, p_gender text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not ((select _staff_mod('volunteers', true)) or (select _staff_mod('customers', true))) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return _vol_cert_make(p_customer, p_from, p_to, _vol_op(), p_gender);
end $function$;

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
  return _vol_cert_make(p_id, p_from, p_to, 'portal', null);
end $function$;

/* -- 7. a certificate staff write themselves, for anyone --------------------------------------- */
-- The name is typed, so this is the one certificate that needs no account; p_customer links it to
-- one when there is one, and then it shows up in that person's list like the others. The three
-- lines default to the wording for the gender given, and each may be replaced.
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
    'from', _date, 'to', _date, 'hours', _h, 'sessions', '[]'::jsonb, 'issued_at', now());
end $function$;

/* -- 3b. the name in Arabic, typed by the volunteer --------------------------------------------- */
create or replace function public.volunteer_name_ar_save(p_id text, p_token text, p_name_ar text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _v text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then raise exception 'VOL_TOKEN' using errcode = '42501'; end if;
  _v := left(nullif(btrim(coalesce(p_name_ar, '')), ''), 120);
  -- A name in Arabic carries no Latin letter and no Western digit. Written as a refusal rather than
  -- an Arabic range: a range in a regex is read by the collation, and this database's is not C.
  if _v is not null and _v ~ '[A-Za-z0-9]' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  update customers set name_ar = _v where id = p_id and merged_into is null;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object('ok', true, 'name_ar', _v);
end $function$;

/* -- 5. the check answers what kind of certificate it is ---------------------------------------- */
create or replace function public.volunteer_cert_check(p_code text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce((select jsonb_build_object('ok', true, 'serial', c.serial, 'name', c.name, 'name_ar', c.name_ar,
                                              'gender', c.gender, 'words', c.words, 'kind', c.kind, 'initiative', c.initiative, 'event_date', c.event_date,
                                              'from', c.period_from, 'to', c.period_to,
                                              'hours', c.hours, 'sessions', c.sessions, 'issued_at', c.issued_at, 'revoked', c.revoked_at is not null)
                     from volunteer_certs c where c.code = upper(btrim(coalesce(p_code, ''))) and coalesce(p_code, '') ~* '^\s*[a-z0-9]{12}\s*$'),
                  jsonb_build_object('ok', false));
$function$;

-- The portal reads the name it last saved beside the rest of the application's fields.
create or replace function public.volunteer_profile(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v volunteers%rowtype; _ar text; _g text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return null; end if;
  select * into v from volunteers where customer_id = p_id;
  -- The gender too: the portal prints a certificate for the hours as they stand, before any row is
  -- made, and the design's Arabic line is the male or the female one.
  select c.name_ar, c.gender into _ar, _g from customers c where c.id = p_id;
  return jsonb_build_object(
    'status', v.status, 'applied_at', v.applied_at, 'skills', v.skills, 'days', coalesce(to_jsonb(v.days), '[]'::jsonb),
    'shirt', v.shirt, 'whatsapp', v.whatsapp, 'name_ar', _ar, 'gender', _g,
    'briefed', coalesce((select jsonb_object_agg(sh.session_id, sh.briefed_at) from volunteer_shifts sh
                          where sh.customer_id = p_id and sh.briefed_at is not null), '{}'::jsonb));
end $function$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261108220000', 'volunteer_cert_template')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): the new columns, the definer functions, that only one _vol_cert_make is left,
-- the wording in both languages, and that no certificate changed kind.
select (select count(*) from information_schema.columns where table_schema = 'public'
          and ((table_name = 'volunteer_certs' and column_name in ('kind', 'session_id', 'initiative', 'event_date', 'name_ar', 'gender', 'words'))
            or (table_name = 'customers' and column_name = 'name_ar'))) as columns_8,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('_vol_cert_make', '_vol_cert_make_session', 'staff_volunteer_cert_issue', 'staff_volunteer_cert_issue_session',
                         'staff_volunteer_cert_issue_session_many', 'staff_volunteer_cert_issue_custom', 'volunteer_cert_issue',
                         'volunteer_cert_issue_session', 'volunteer_name_ar_save', 'volunteer_cert_check', 'volunteer_profile')) as definer_11,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = '_vol_cert_make') as make_1,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'staff_volunteer_cert_issue') as issue_1,
       (_vol_cert_words('female') ->> 'recognition') as her_line,
       (_vol_cert_words(null) ->> 'arabic_line') as neutral_ar,
       (select count(*) from volunteer_certs where kind <> 'period') as not_period,
       (select version from supabase_migrations.schema_migrations where version = '20261108220000') as ledger;
