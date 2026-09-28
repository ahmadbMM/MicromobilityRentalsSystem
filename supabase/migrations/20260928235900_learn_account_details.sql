-- ============================================================================
-- Learn to ride: the person signing up gives what the community form asks (the owner, 2026-09-28).
--
-- Their details become their booking-app account (staff_learn_schedule), so the sign-up asks the
-- person signing up what a community membership application asks: date of birth, gender,
-- nationality, height and profession (required), Instagram and LinkedIn (may be left empty - the
-- form does not say so) and ride news (optional). The bike type is not asked: the account's
-- preference is 'Any'. A "Me" learner takes their age, gender and height from these. And a
-- learner may be any age up to 99 - no minimum any more.
--
--  1. learn_applications: birth_date, gender, nationality, height, profession, instagram,
--     linkedin, ride_news - the person signing up; null (ride_news false) on sign-ups from before.
--     learner_age (learner #1's mirror) is checked 1 to 99.
--  2. learn_apply(p) - 20260928235500's definition, plus those fields, checked as community_apply
--     checks them (the date of birth: never in the future, at most 99 years ago). A page from
--     before this sends none of them and is still read. With them, a self learner's age, gender
--     and height are the person's own. Every learner: 1 to 99.
--  3. staff_learn_schedule(...) - 20260928210000's definition. A new account takes the person's
--     details (date of birth, gender, nationality, height, profession, Instagram and LinkedIn when
--     given, ride news, bike preference 'Any'); an existing one gains only what it lacks, and the
--     ride news answer when it is newer, as staff_community_approve does. A sign-up from before
--     keeps the old rule (a self learner's height and gender).
--
-- Rollback:
--   re-run learn_apply from 20260928235500 and staff_learn_schedule from 20260928210000;
--   alter table public.learn_applications drop column if exists birth_date, drop column if exists gender,
--     drop column if exists nationality, drop column if exists height, drop column if exists profession,
--     drop column if exists instagram, drop column if exists linkedin, drop column if exists ride_news;
--   (and put back check (learner_age between 3 and 99) once no row is younger)
-- Idempotent.
-- ============================================================================

begin;

do $$ begin
  if to_regclass('public.learn_applications') is null or not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'learn_applications' and column_name = 'learners') then
    raise exception 'Run 20260928210000_learn_to_ride and 20260928235500_learn_many_learners first.';
  end if;
end $$;

alter table public.learn_applications add column if not exists birth_date  text;
alter table public.learn_applications add column if not exists gender      text;
alter table public.learn_applications add column if not exists nationality text;
alter table public.learn_applications add column if not exists height      integer;
alter table public.learn_applications add column if not exists profession  text;
alter table public.learn_applications add column if not exists instagram   text;
alter table public.learn_applications add column if not exists linkedin    text;
alter table public.learn_applications add column if not exists ride_news   boolean not null default false;
alter table public.learn_applications drop constraint if exists learn_applications_person_check;
alter table public.learn_applications add constraint learn_applications_person_check check (
  (birth_date is null or birth_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
  and (gender is null or gender in ('male','female'))
  and (nationality is null or length(nationality) <= 60)
  and (height is null or height between 80 and 250)
  and (profession is null or length(profession) <= 80)
  and (instagram is null or instagram ~ '^[A-Za-z0-9._]{1,30}$')
  and (linkedin is null or linkedin ~ '^[A-Za-z0-9._%-]{3,100}$'));
alter table public.learn_applications drop constraint if exists learn_applications_learner_age_check;
alter table public.learn_applications add constraint learn_applications_learner_age_check check (learner_age between 1 and 99);

create or replace function public.learn_apply(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_name   text := regexp_replace(trim(coalesce(p->>'name','')), '\s+', ' ', 'g');
  v_email  text := lower(trim(coalesce(p->>'email','')));
  v_phone  text := trim(coalesce(p->>'phone',''));
  v_notes  text := trim(coalesce(p->>'notes',''));
  v_heard  text := nullif(trim(coalesce(p->>'heard_from','')), '');
  v_lang   text := lower(coalesce(nullif(p->>'lang',''), 'en'));
  v_pv     text := coalesce(p->>'privacy_version','');
  v_in     jsonb := p->'learners';
  v_list   jsonb := '[]'::jsonb;
  v_l      jsonb;
  v_i      int := 0;
  v_selves int := 0;
  v_who    text;
  v_lname  text;
  v_age    int;
  v_height int;
  v_gender text;
  v_level  text;
  v_one    jsonb;
  v_prev   learn_applications%rowtype;
  -- The person signing up: what a community membership application asks (a page from before this
  -- sends none of it).
  v_new    boolean := p ?| array['birth_date','nationality','profession'];
  v_birth  text := trim(coalesce(p->>'birth_date',''));
  v_bd     date;
  v_cage   int;
  v_cgend  text := coalesce(p->>'gender','');
  v_cheight int;
  v_nat    text := trim(coalesce(p->>'nationality',''));
  v_prof   text := regexp_replace(trim(coalesce(p->>'profession','')), '\s+', ' ', 'g');
  v_ig     text := regexp_replace(trim(coalesce(p->>'instagram','')), '^@+', '');
  v_li     text := trim(coalesce(p->>'linkedin',''));
  v_news   boolean := false;
  v_today  date := (now() at time zone 'Asia/Riyadh')::date;
begin
  if not _ip_gate('learn', 20, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;

  -- A page from before several learners sends its one learner in the old fields.
  if v_in is null or jsonb_typeof(v_in) <> 'array' then
    v_in := case when coalesce(p->>'for_whom', '') = '' then '[]'::jsonb
      else jsonb_build_array(jsonb_build_object('who', p->>'for_whom', 'name', p->>'learner_name',
        'age', p->>'learner_age', 'gender', p->>'learner_gender', 'height', p->>'learner_height', 'level', p->>'level')) end;
  end if;
  if jsonb_array_length(v_in) < 1 or jsonb_array_length(v_in) > 5 then
    return jsonb_build_object('ok', false, 'error', 'learners'); end if;

  -- The person signing up, checked as community_apply checks a membership application; the date
  -- of birth never in the future and at most 99 years ago. Instagram and LinkedIn may be empty.
  if v_new then
    begin v_bd := v_birth::date; exception when others then v_bd := null; end;
    if v_bd is null or v_birth !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or v_bd > v_today or v_bd <= (v_today - interval '100 years')::date then
      return jsonb_build_object('ok', false, 'error', 'birth_date'); end if;
    v_cage := extract(year from age(v_today::timestamp, v_bd::timestamp))::int;
    if v_cgend not in ('male','female') then return jsonb_build_object('ok', false, 'error', 'gender'); end if;
    if v_nat = '' or length(v_nat) > 60 or v_nat ~ '[<>"`]' then return jsonb_build_object('ok', false, 'error', 'nationality'); end if;
    begin v_cheight := nullif(regexp_replace(coalesce(p->>'height', ''), '\D', '', 'g'), '')::int;
    exception when others then v_cheight := null; end;
    if v_cheight is null or v_cheight < 80 or v_cheight > 250 then return jsonb_build_object('ok', false, 'error', 'height'); end if;
    if v_ig <> '' and v_ig !~ '^[A-Za-z0-9._]{1,30}$' then return jsonb_build_object('ok', false, 'error', 'instagram'); end if;
    if v_li <> '' and v_li !~ '^[A-Za-z0-9._%-]{3,100}$' then return jsonb_build_object('ok', false, 'error', 'linkedin'); end if;
    if length(v_prof) < 2 or length(v_prof) > 80 or v_prof ~ '[<>"`{}]' then
      return jsonb_build_object('ok', false, 'error', 'profession'); end if;
    begin v_news := coalesce((p->>'ride_news')::boolean, false); exception when others then v_news := false; end;
  end if;

  -- The learners, in the form's order: each is checked, and an error names its place.
  for v_l in select value from jsonb_array_elements(v_in) loop
    if jsonb_typeof(v_l) <> 'object' then return jsonb_build_object('ok', false, 'error', 'learner_who', 'index', v_i); end if;
    v_who    := coalesce(v_l->>'who', '');
    v_lname  := nullif(regexp_replace(trim(coalesce(v_l->>'name', '')), '\s+', ' ', 'g'), '');
    v_gender := coalesce(v_l->>'gender', '');
    v_level  := coalesce(v_l->>'level', '');
    begin v_age := nullif(regexp_replace(coalesce(v_l->>'age', ''), '\D', '', 'g'), '')::int;
    exception when others then v_age := null; end;
    begin v_height := nullif(regexp_replace(coalesce(v_l->>'height', ''), '\D', '', 'g'), '')::int;
    exception when others then v_height := null; end;

    if v_who not in ('self','child','other') then return jsonb_build_object('ok', false, 'error', 'learner_who', 'index', v_i); end if;
    -- "Me" is the person signing up: their own age, gender and height.
    if v_who = 'self' and v_new then v_age := v_cage; v_gender := v_cgend; v_height := v_cheight; end if;
    if v_who = 'self' then
      v_selves := v_selves + 1;
      if v_selves > 1 then return jsonb_build_object('ok', false, 'error', 'learners', 'index', v_i); end if;
      v_lname := null;
    elsif v_lname is null or length(v_lname) > 60 or not _name_chars_ok(v_lname) or not _name_parts_ok(v_lname) then
      return jsonb_build_object('ok', false, 'error', 'learner_name', 'index', v_i);
    end if;
    -- Any age up to 99, whoever is learning (the owner, 2026-09-28).
    if v_age is null or v_age < 1 or v_age > 99 then
      return jsonb_build_object('ok', false, 'error', 'learner_age', 'index', v_i); end if;
    if v_gender not in ('male','female') then return jsonb_build_object('ok', false, 'error', 'learner_gender', 'index', v_i); end if;
    if v_height is null or v_height < 80 or v_height > 250 then return jsonb_build_object('ok', false, 'error', 'learner_height', 'index', v_i); end if;
    if v_level not in ('never','tried','refresh') then return jsonb_build_object('ok', false, 'error', 'level', 'index', v_i); end if;
    -- The same learner twice (who + name).
    if exists (select 1 from jsonb_array_elements(v_list) x
                where x->>'who' = v_who and lower(coalesce(x->>'name', '')) = lower(coalesce(v_lname, ''))) then
      return jsonb_build_object('ok', false, 'error', 'learners', 'index', v_i); end if;
    v_list := v_list || jsonb_build_array(jsonb_build_object('who', v_who, 'name', v_lname, 'age', v_age,
      'gender', v_gender, 'height', v_height, 'level', v_level));
    v_i := v_i + 1;
  end loop;

  -- The applicant's name becomes an account's name: the booking app's rules (first and last name,
  -- letters, spaces and periods, every part at least two letters).
  if v_name = '' or length(v_name) > 120 or v_name !~ '\s' or not _name_chars_ok(v_name) or not _name_parts_ok(v_name) then
    return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if length(v_email) > 254 or v_email !~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' then
    return jsonb_build_object('ok', false, 'error', 'email'); end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' or (v_phone like '+966%' and v_phone !~ '^\+9665[0-9]{8}$') then
    return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if length(v_notes) > 600 then return jsonb_build_object('ok', false, 'error', 'notes'); end if;
  if v_heard is not null and v_heard not in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp',
     'google','friend','invited','passed_by','event','hotel','school','work','community','other') then
    return jsonb_build_object('ok', false, 'error', 'heard_from'); end if;
  if v_pv !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'privacy'); end if;
  if v_lang !~ '^[a-z]{2}$' then v_lang := 'en'; end if;

  -- One pending sign-up per person: the same email or phone adds its learners to it (one already
  -- on it, by who and name, is replaced by the new details), up to six in all.
  perform pg_advisory_xact_lock(hashtext('learnapp:' || v_email));
  perform pg_advisory_xact_lock(hashtext('learnapp:' || v_phone));
  select * into v_prev from learn_applications
   where status = 'pending' and (lower(email) = v_email or phone = v_phone)
   order by (lower(email) = v_email) desc, created_at limit 1;
  if v_prev.id is not null then
    select coalesce(jsonb_agg(m.value order by m.value->>'who' = 'self' desc, m.pos), '[]'::jsonb) into v_list
      from (
        select o.value, o.pos from jsonb_array_elements(v_prev.learners) with ordinality as o(value, pos)
         where not exists (select 1 from jsonb_array_elements(v_list) n
                            where n->>'who' = o.value->>'who'
                              and lower(coalesce(n->>'name', '')) = lower(coalesce(o.value->>'name', '')))
        union all
        select n.value, 100 + n.pos from jsonb_array_elements(v_list) with ordinality as n(value, pos)
      ) m;
    if jsonb_array_length(v_list) > 6 then return jsonb_build_object('ok', false, 'error', 'learners'); end if;
  else
    select coalesce(jsonb_agg(x.value order by x.value->>'who' = 'self' desc, x.pos), '[]'::jsonb) into v_list
      from jsonb_array_elements(v_list) with ordinality as x(value, pos);
  end if;
  -- The old columns keep learner #1 (self when there is one) for pages from before.
  v_one := v_list->0;

  if v_prev.id is not null then
    update learn_applications set
      name = v_name, email = v_email, phone = v_phone, learners = v_list,
      for_whom = v_one->>'who', learner_name = v_one->>'name', learner_age = (v_one->>'age')::int,
      learner_gender = v_one->>'gender', learner_height = (v_one->>'height')::int, level = v_one->>'level',
      notes = v_notes, heard_from = coalesce(v_heard, heard_from), lang = v_lang, privacy_version = v_pv,
      birth_date  = case when v_new then v_birth   else birth_date end,
      gender      = case when v_new then v_cgend   else gender end,
      nationality = case when v_new then v_nat     else nationality end,
      height      = case when v_new then v_cheight else height end,
      profession  = case when v_new then v_prof    else profession end,
      instagram   = case when v_new then nullif(v_ig, '') else instagram end,
      linkedin    = case when v_new then nullif(v_li, '') else linkedin end,
      ride_news   = case when v_new then v_news    else ride_news end,
      submissions = submissions + 1, updated_at = now()
     where id = v_prev.id;
  else
    insert into learn_applications (for_whom, name, email, phone, learners, learner_name, learner_age, learner_gender,
      learner_height, level, notes, heard_from, lang, privacy_version,
      birth_date, gender, nationality, height, profession, instagram, linkedin, ride_news)
    values (v_one->>'who', v_name, v_email, v_phone, v_list, v_one->>'name', (v_one->>'age')::int, v_one->>'gender',
      (v_one->>'height')::int, v_one->>'level', v_notes, v_heard, v_lang, v_pv,
      case when v_new then v_birth end, case when v_new then v_cgend end, case when v_new then v_nat end,
      case when v_new then v_cheight end, case when v_new then v_prof end,
      case when v_new then nullif(v_ig, '') end, case when v_new then nullif(v_li, '') end, v_new and v_news);
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
  v_id text; v_pwd text; v_digits text; v_hops int := 0; v_first boolean; v_socials jsonb;
  -- A sign-up from this form on carries the person's own details (their date of birth marks it).
  v_mine boolean;
  v_by text := left(coalesce(nullif(trim(p_by), ''), 'staff'), 80);
  v_place text := nullif(left(trim(coalesce(p_place, '')), 120), '');
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_at is null or p_at < now() - interval '1 day' or p_at > now() + interval '1 year' then
    return jsonb_build_object('ok', false, 'error', 'when');
  end if;
  select * into a from learn_applications where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'error', 'missing'); end if;
  v_mine := a.birth_date is not null;
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
      -- Already a rider: keep their account and password, and fill in only what it lacks - as
      -- staff_community_approve does - from the person's own details. A sign-up from before those
      -- gives a self learner's height and gender (a child's details are not the account holder's).
      v_socials := coalesce(c.socials, '{}'::jsonb);
      if coalesce(a.instagram, '') <> '' and not (v_socials ? 'instagram') then v_socials := v_socials || jsonb_build_object('instagram', a.instagram); end if;
      if coalesce(a.linkedin, '') <> '' and not (v_socials ? 'linkedin') then v_socials := v_socials || jsonb_build_object('linkedin', a.linkedin); end if;
      update customers set
        height      = coalesce(height, a.height, case when a.for_whom = 'self' then a.learner_height end),
        gender      = coalesce(gender, a.gender, case when a.for_whom = 'self' then a.learner_gender end),
        birth_date  = coalesce(nullif(birth_date, ''), a.birth_date),
        nationality = coalesce(nullif(nationality, ''), a.nationality),
        profession  = coalesce(nullif(trim(profession), ''), a.profession),
        socials     = case when v_socials = '{}'::jsonb then socials else v_socials end,
        privacy_version = case when privacy_version is null or privacy_version < a.privacy_version then a.privacy_version else privacy_version end,
        privacy_at      = case when privacy_version is null or privacy_version < a.privacy_version then a.updated_at else privacy_at end,
        ride_news       = case when v_mine and (ride_news_at is null or ride_news_at < a.updated_at) then a.ride_news else ride_news end,
        ride_news_at    = case when v_mine and (ride_news_at is null or ride_news_at < a.updated_at) then a.updated_at else ride_news_at end
       where id = c.id;
      v_id := c.id;
      update learn_applications set existing_account = true where id = a.id;
    else
      v_id := 'la' || encode(gen_random_bytes(8), 'hex');
      v_pwd := _community_temp_pwd();
      -- The account is made from the person's own details; its bike preference is 'Any' (the owner,
      -- 2026-09-28: the form does not ask it).
      v_socials := jsonb_strip_nulls(jsonb_build_object('instagram', nullif(a.instagram, ''), 'linkedin', nullif(a.linkedin, '')));
      insert into customers (id, name, email, phone, password_hash, created_at, height, gender,
        type_preference, birth_date, nationality, socials, profession,
        session_token, must_change_pwd, privacy_version, privacy_at, ride_news, ride_news_at)
      values (v_id, a.name, a.email, a.phone, crypt(v_pwd, gen_salt('bf')),
        to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        coalesce(a.height, case when a.for_whom = 'self' then a.learner_height end),
        coalesce(a.gender, case when a.for_whom = 'self' then a.learner_gender end),
        'Any', a.birth_date, a.nationality, nullif(v_socials, '{}'::jsonb), a.profession,
        encode(gen_random_bytes(24), 'hex'), true, a.privacy_version, a.updated_at,
        v_mine and a.ride_news, case when v_mine then a.updated_at end);
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

commit;
