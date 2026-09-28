-- ============================================================================
-- Learn to ride (micromobility.sa/experiences/learn), 2026-09-28.
--
-- Someone who cannot ride yet (or a parent, for a child) signs up on the website. Staff read the
-- sign-ups in Community > Applications > Learn to ride, pick the lesson's date and time, and send
-- the message the staff page writes - the same way as a community application: an applicant who
-- already has an account is told to sign in with it; anyone else gets an account made from the
-- sign-up, with a temporary password they must change at first sign-in (must_change_pwd, from
-- 20260922200000). No tag is added.
--
--  1. learn_applications - one row per sign-up. No anon access; staff read and write under
--     is_staff(). The website writes only through learn_apply.
--       for_whom 'self' (the applicant learns) or 'child' (learner_name is the child's name).
--       status pending -> scheduled (lesson_at set) -> done; cancelled from pending or scheduled,
--       and back to pending from cancelled.
--  2. learn_apply(p jsonb) - anon, throttled per network (_ip_gate 'learn', 20 in 10 minutes).
--     Every field checked here again (the form checks first). A second sign-up while one is still
--     pending, with the same email or phone and the same learner, updates it (submissions + 1).
--  3. staff_learn_schedule(p_id, p_at, p_place, p_by) - staff only. Sets (or moves) the lesson.
--     The first time: finds the account (email, Apple relay email, then phone - as
--     staff_community_approve does, skipping merged accounts) or makes one with a temporary
--     password, returned ONCE and never stored readable. Later calls keep that account (a merged
--     one is followed to the account it was merged into) and return no password.
--  4. staff_learn_new_password(p_id) - a fresh temporary password for the account a sign-up made,
--     while the rider has not chosen their own yet.
--  5. staff_learn_decide(p_id, p_status, p_by) - done (from scheduled), cancelled (from pending or
--     scheduled), pending (from cancelled; the lesson time goes), and scheduled again (from done, or
--     from cancelled while its lesson time is still set) - the staff page's Undo.
--
-- Rollback:
--   drop function if exists public.staff_learn_decide(uuid,text,text);
--   drop function if exists public.staff_learn_new_password(uuid);
--   drop function if exists public.staff_learn_schedule(uuid,timestamptz,text,text);
--   drop function if exists public.learn_apply(jsonb);
--   drop table if exists public.learn_applications;
-- Idempotent.
-- ============================================================================

begin;

create table if not exists public.learn_applications (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  submissions      integer not null default 1,
  status           text not null default 'pending' check (status in ('pending','scheduled','done','cancelled')),
  for_whom         text not null check (for_whom in ('self','child')),
  name             text not null,
  email            text not null,
  phone            text not null,
  learner_name     text check (learner_name is null or length(learner_name) <= 60),
  learner_age      integer not null check (learner_age between 3 and 99),
  learner_gender   text not null check (learner_gender in ('male','female')),
  learner_height   integer not null check (learner_height between 80 and 250),
  level            text not null check (level in ('never','tried','refresh')),
  days             text[] not null default '{}' check (days <@ array['weekdays','weekends']),
  times            text[] not null default '{}' check (times <@ array['morning','afternoon','evening']),
  notes            text not null default '' check (length(notes) <= 600),
  lang             text not null default 'en',
  privacy_version  text not null,
  lesson_at        timestamptz,
  lesson_place     text check (lesson_place is null or length(lesson_place) <= 120),
  decided_at       timestamptz,
  decided_by       text,
  customer_id      text references public.customers(id) on delete set null,
  existing_account boolean,
  account_oauth    boolean
);
create index if not exists learn_applications_status_idx on public.learn_applications (status, created_at desc);
create index if not exists learn_applications_email_idx  on public.learn_applications (lower(email));
create index if not exists learn_applications_phone_idx  on public.learn_applications (phone);
create index if not exists learn_applications_customer_idx on public.learn_applications (customer_id) where customer_id is not null;

alter table public.learn_applications enable row level security;
drop policy if exists "staff read learn applications"   on public.learn_applications;
drop policy if exists "staff update learn applications" on public.learn_applications;
create policy "staff read learn applications"   on public.learn_applications for select to authenticated using ((select is_staff()));
create policy "staff update learn applications" on public.learn_applications for update to authenticated using ((select is_staff())) with check ((select is_staff()));
revoke all on public.learn_applications from public, anon, authenticated;
grant select, update on public.learn_applications to authenticated;

create or replace function public.learn_apply(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_for    text := coalesce(p->>'for_whom','');
  v_name   text := regexp_replace(trim(coalesce(p->>'name','')), '\s+', ' ', 'g');
  v_email  text := lower(trim(coalesce(p->>'email','')));
  v_phone  text := trim(coalesce(p->>'phone',''));
  v_lname  text := nullif(regexp_replace(trim(coalesce(p->>'learner_name','')), '\s+', ' ', 'g'), '');
  v_age    int;
  v_height int;
  v_gender text := coalesce(p->>'learner_gender','');
  v_level  text := coalesce(p->>'level','');
  v_days   text[] := '{}';
  v_times  text[] := '{}';
  v_notes  text := trim(coalesce(p->>'notes',''));
  v_lang   text := lower(coalesce(nullif(p->>'lang',''), 'en'));
  v_pv     text := coalesce(p->>'privacy_version','');
  v_prev   learn_applications%rowtype;
begin
  if not _ip_gate('learn', 20, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  begin v_age := nullif(regexp_replace(coalesce(p->>'learner_age',''), '\D', '', 'g'), '')::int;
  exception when others then v_age := null; end;
  begin v_height := nullif(regexp_replace(coalesce(p->>'learner_height',''), '\D', '', 'g'), '')::int;
  exception when others then v_height := null; end;
  if jsonb_typeof(p->'days') = 'array' then
    select coalesce(array_agg(distinct x order by x), '{}') into v_days
      from jsonb_array_elements_text(p->'days') x where x in ('weekdays','weekends');
  end if;
  if jsonb_typeof(p->'times') = 'array' then
    select coalesce(array_agg(distinct x order by x), '{}') into v_times
      from jsonb_array_elements_text(p->'times') x where x in ('morning','afternoon','evening');
  end if;

  if v_for not in ('self','child') then return jsonb_build_object('ok', false, 'error', 'for_whom'); end if;
  -- The applicant's name becomes an account's name: the booking app's rules (first and last name,
  -- letters, spaces and periods, every part at least two letters).
  if v_name = '' or length(v_name) > 120 or v_name !~ '\s' or not _name_chars_ok(v_name) or not _name_parts_ok(v_name) then
    return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if length(v_email) > 254 or v_email !~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' then
    return jsonb_build_object('ok', false, 'error', 'email'); end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' or (v_phone like '+966%' and v_phone !~ '^\+9665[0-9]{8}$') then
    return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if v_for = 'child' then
    if v_lname is null or length(v_lname) > 60 or not _name_chars_ok(v_lname) or not _name_parts_ok(v_lname) then
      return jsonb_build_object('ok', false, 'error', 'learner_name'); end if;
    if v_age is null or v_age < 3 or v_age > 17 then return jsonb_build_object('ok', false, 'error', 'learner_age'); end if;
  else
    v_lname := null;
    -- Under 12 signs up through a parent (for_whom 'child').
    if v_age is null or v_age < 12 or v_age > 99 then return jsonb_build_object('ok', false, 'error', 'learner_age'); end if;
  end if;
  if v_gender not in ('male','female') then return jsonb_build_object('ok', false, 'error', 'learner_gender'); end if;
  if v_height is null or v_height < 80 or v_height > 250 then return jsonb_build_object('ok', false, 'error', 'learner_height'); end if;
  if v_level not in ('never','tried','refresh') then return jsonb_build_object('ok', false, 'error', 'level'); end if;
  if length(v_notes) > 600 then return jsonb_build_object('ok', false, 'error', 'notes'); end if;
  if v_pv !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'privacy'); end if;
  if v_lang !~ '^[a-z]{2}$' then v_lang := 'en'; end if;

  -- One pending sign-up per person and learner: the same email or phone, for the same learner,
  -- updates it. A parent signing up two children makes two.
  perform pg_advisory_xact_lock(hashtext('learnapp:' || v_email));
  perform pg_advisory_xact_lock(hashtext('learnapp:' || v_phone));
  select * into v_prev from learn_applications
   where status = 'pending' and (lower(email) = v_email or phone = v_phone)
     and for_whom = v_for and lower(coalesce(learner_name, '')) = lower(coalesce(v_lname, ''))
   order by (lower(email) = v_email) desc, created_at limit 1;
  if v_prev.id is not null then
    update learn_applications set
      name = v_name, email = v_email, phone = v_phone, learner_name = v_lname, learner_age = v_age,
      learner_gender = v_gender, learner_height = v_height, level = v_level, days = v_days, times = v_times,
      notes = v_notes, lang = v_lang, privacy_version = v_pv,
      submissions = submissions + 1, updated_at = now()
     where id = v_prev.id;
  else
    insert into learn_applications (for_whom, name, email, phone, learner_name, learner_age, learner_gender,
      learner_height, level, days, times, notes, lang, privacy_version)
    values (v_for, v_name, v_email, v_phone, v_lname, v_age, v_gender, v_height, v_level, v_days, v_times,
      v_notes, v_lang, v_pv);
  end if;
  -- The form learns nothing about accounts or earlier sign-ups.
  return jsonb_build_object('ok', true);
end $function$;
revoke execute on function public.learn_apply(jsonb) from public;
grant  execute on function public.learn_apply(jsonb) to anon, authenticated;

create or replace function public.staff_learn_schedule(p_id uuid, p_at timestamptz, p_place text default null, p_by text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  a learn_applications%rowtype;
  c customers%rowtype;
  v_id text; v_pwd text; v_digits text; v_hops int := 0; v_first boolean;
  v_by text := left(coalesce(nullif(trim(p_by), ''), 'staff'), 80);
  v_place text := nullif(left(trim(coalesce(p_place, '')), 120), '');
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_at is null or p_at < now() - interval '1 day' or p_at > now() + interval '1 year' then
    return jsonb_build_object('ok', false, 'error', 'when');
  end if;
  select * into a from learn_applications where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'error', 'missing'); end if;
  if a.status not in ('pending','scheduled') then return jsonb_build_object('ok', false, 'error', 'decided', 'status', a.status); end if;

  -- The account this sign-up already landed on, followed through a merge.
  if a.customer_id is not null then
    select * into c from customers where id = a.customer_id;
    while c.id is not null and c.merged_into is not null and v_hops < 5 loop
      select * into c from customers where id = c.merged_into; v_hops := v_hops + 1;
    end loop;
  end if;
  v_first := c.id is null;

  if v_first then
    v_digits := regexp_replace(a.phone, '\D', '', 'g');
    select * into c from customers
     where (lower(trim(email)) = lower(a.email) or lower(trim(apple_email)) = lower(a.email)) and merged_into is null
     order by (lower(trim(email)) = lower(a.email)) desc nulls last, created_at limit 1;
    if c.id is null then
      select * into c from customers where regexp_replace(coalesce(phone,''), '\D', '', 'g') = v_digits and merged_into is null
       order by created_at limit 1;
    end if;
    if c.id is not null then
      -- Already a rider: keep their account and password. A self sign-up fills in only what the
      -- account lacks (a child's details are not the account holder's).
      if a.for_whom = 'self' then
        update customers set
          height = coalesce(height, a.learner_height),
          gender = coalesce(gender, a.learner_gender),
          privacy_version = case when privacy_version is null or privacy_version < a.privacy_version then a.privacy_version else privacy_version end,
          privacy_at      = case when privacy_version is null or privacy_version < a.privacy_version then a.updated_at else privacy_at end
         where id = c.id;
      else
        update customers set
          privacy_version = case when privacy_version is null or privacy_version < a.privacy_version then a.privacy_version else privacy_version end,
          privacy_at      = case when privacy_version is null or privacy_version < a.privacy_version then a.updated_at else privacy_at end
         where id = c.id;
      end if;
      v_id := c.id;
      update learn_applications set existing_account = true where id = a.id;
    else
      v_id := 'la' || encode(gen_random_bytes(8), 'hex');
      v_pwd := _community_temp_pwd();
      insert into customers (id, name, email, phone, password_hash, created_at, height, gender,
        session_token, must_change_pwd, privacy_version, privacy_at)
      values (v_id, a.name, a.email, a.phone, crypt(v_pwd, gen_salt('bf')),
        to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        case when a.for_whom = 'self' then a.learner_height end,
        case when a.for_whom = 'self' then a.learner_gender end,
        encode(gen_random_bytes(24), 'hex'), true, a.privacy_version, a.updated_at);
      update learn_applications set existing_account = false where id = a.id;
    end if;
  else
    v_id := c.id;
  end if;

  select * into c from customers where id = v_id;
  update learn_applications set status = 'scheduled', lesson_at = p_at, lesson_place = v_place,
    decided_at = now(), decided_by = v_by, customer_id = v_id,
    account_oauth = coalesce(c.password_hash, '') like 'oauth:%', updated_at = now()
   where id = a.id
   returning * into a;
  -- oauth: the account signs in with Google or Apple, so the message says so instead of a password.
  return jsonb_build_object('ok', true, 'existing', a.existing_account, 'first', v_first,
    'customer_id', v_id, 'name', c.name, 'email', c.email, 'phone', c.phone, 'password', v_pwd,
    'lang', a.lang, 'oauth', a.account_oauth, 'lesson_at', a.lesson_at, 'lesson_place', a.lesson_place,
    'must_change', c.must_change_pwd);
end $function$;
revoke execute on function public.staff_learn_schedule(uuid, timestamptz, text, text) from public, anon;
grant  execute on function public.staff_learn_schedule(uuid, timestamptz, text, text) to authenticated;

create or replace function public.staff_learn_new_password(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare a learn_applications%rowtype; c customers%rowtype; v_pwd text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into a from learn_applications where id = p_id;
  if a.id is null or a.status not in ('scheduled','done') or a.customer_id is null or a.existing_account then
    return jsonb_build_object('ok', false, 'error', 'not_new');
  end if;
  select * into c from customers where id = a.customer_id for update;
  if c.id is null or c.merged_into is not null then return jsonb_build_object('ok', false, 'error', 'missing'); end if;
  -- Once the rider has chosen a password, it is theirs: staff cannot swap it from here.
  if not c.must_change_pwd then return jsonb_build_object('ok', false, 'error', 'chosen'); end if;
  v_pwd := _community_temp_pwd();
  perform set_config('mm.temp_pwd', '1', true);
  update customers set password_hash = crypt(v_pwd, gen_salt('bf')),
    session_token = encode(gen_random_bytes(24), 'hex'), must_change_pwd = true
   where id = c.id;
  perform set_config('mm.temp_pwd', '', true);
  return jsonb_build_object('ok', true, 'existing', false, 'customer_id', c.id, 'name', c.name,
    'email', c.email, 'phone', c.phone, 'password', v_pwd, 'lang', a.lang,
    'lesson_at', a.lesson_at, 'lesson_place', a.lesson_place);
end $function$;
revoke execute on function public.staff_learn_new_password(uuid) from public, anon;
grant  execute on function public.staff_learn_new_password(uuid) to authenticated;

create or replace function public.staff_learn_decide(p_id uuid, p_status text, p_by text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare a learn_applications%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_status not in ('done','cancelled','pending','scheduled') then return jsonb_build_object('ok', false, 'error', 'status'); end if;
  select * into a from learn_applications where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'error', 'missing'); end if;
  if not ((p_status = 'done' and a.status = 'scheduled')
       or (p_status = 'scheduled' and a.status in ('done','cancelled') and a.lesson_at is not null)
       or (p_status = 'cancelled' and a.status in ('pending','scheduled'))
       or (p_status = 'pending' and a.status = 'cancelled')) then
    return jsonb_build_object('ok', false, 'error', 'decided', 'status', a.status);
  end if;
  -- Back to pending: the lesson time goes (it is picked again); the account it landed on stays.
  update learn_applications set status = p_status,
    lesson_at = case when p_status = 'pending' then null else lesson_at end,
    decided_at = now(),
    decided_by = left(coalesce(nullif(trim(p_by), ''), 'staff'), 80),
    updated_at = now()
   where id = a.id;
  return jsonb_build_object('ok', true, 'status', p_status);
end $function$;
revoke execute on function public.staff_learn_decide(uuid, text, text) from public, anon;
grant  execute on function public.staff_learn_decide(uuid, text, text) to authenticated;

commit;
