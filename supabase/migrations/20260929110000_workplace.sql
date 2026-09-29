-- ============================================================================
-- Workplace, and the community form's questions on the rider's own profile (the owner,
-- 2026-09-29: "add a field that asks for workplace in community and learning forms and add every
-- field that is asked in community form in the profile info page in my account page so it gets
-- filled automatically").
--
--  1. customers.workplace, community_applications.workplace, learn_applications.workplace: where
--     the person works or studies, 2 to 120 characters, as typed (spaces folded). customers gets a
--     column SELECT grant like its other readable columns (its SELECT is per column since
--     20260928180000, and a column nobody may read breaks any whole-row read).
--  2. community_apply(p) - the live definition (20260928220000's), plus workplace: required once a
--     page sends it, checked as profession is; a page from before sends none and is still read (a
--     resend from one keeps the workplace already on the application).
--  3. staff_community_approve(...) - the live definition, plus workplace: a new account takes it;
--     an existing one gains it only when it has none, as with profession.
--  4. learn_apply(p) - 20260928235900's definition, plus workplace, asked of the person signing up
--     with the rest of the community form's questions (same rule as 2).
--  5. staff_learn_schedule(...) - 20260928235900's definition, plus workplace (same rule as 3).
--  6. customer_about(p_id, p_token): the signed-in rider's own profession, workplace and how they
--     heard of us, for the account page (customer_profile is left as it is: another change,
--     20260929090000_vip_tag, rebuilds it, and its columns stay its own).
--  7. customer_set_about(p_id, p_token, p_profession, p_workplace, p_heard_from, p_gender): the
--     account page saves them, with gender. Profession and workplace are written as given (empty
--     clears), checked as the forms check them; heard_from and gender only change to a valid
--     answer (null leaves them).
--
-- Rollback:
--   drop function if exists public.customer_set_about(text, text, text, text, text, text);
--   drop function if exists public.customer_about(text, text);
--   re-run community_apply and staff_community_approve from 20260928220000, learn_apply and
--   staff_learn_schedule from 20260928235900;
--   alter table public.customers drop column if exists workplace;
--   alter table public.community_applications drop column if exists workplace;
--   alter table public.learn_applications drop column if exists workplace;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

do $$ begin
  if not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'learn_applications' and column_name = 'profession')
     or not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'community_applications' and column_name = 'heard_from') then
    raise exception 'Run 20260928220000_community_heard_from and 20260928235900_learn_account_details first.';
  end if;
end $$;

alter table public.customers add column if not exists workplace text;
alter table public.customers drop constraint if exists customers_workplace_check;
alter table public.customers add constraint customers_workplace_check
  check (workplace is null or (length(workplace) <= 120 and workplace !~ '[<>"`{}]'));
grant select (workplace) on public.customers to anon, authenticated;

alter table public.community_applications add column if not exists workplace text;
alter table public.community_applications drop constraint if exists community_applications_workplace_check;
alter table public.community_applications add constraint community_applications_workplace_check
  check (workplace is null or length(workplace) <= 120);

alter table public.learn_applications add column if not exists workplace text;
alter table public.learn_applications drop constraint if exists learn_applications_workplace_check;
alter table public.learn_applications add constraint learn_applications_workplace_check
  check (workplace is null or length(workplace) <= 120);

-- 2. The community membership application ------------------------------------------------------
create or replace function public.community_apply(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_name   text := regexp_replace(trim(coalesce(p->>'name','')), '\s+', ' ', 'g');
  v_email  text := lower(trim(coalesce(p->>'email','')));
  v_phone  text := trim(coalesce(p->>'phone',''));
  v_height int;
  v_birth  text := trim(coalesce(p->>'birth_date',''));
  v_gender text := coalesce(p->>'gender','');
  v_nat    text := trim(coalesce(p->>'nationality',''));
  v_type   text := coalesce(p->>'bike_type','');
  v_ig     text := regexp_replace(trim(coalesce(p->>'instagram','')), '^@+', '');
  v_li     text := trim(coalesce(p->>'linkedin',''));
  v_prof   text := regexp_replace(trim(coalesce(p->>'profession','')), '\s+', ' ', 'g');
  -- Where they work or study (20260929110000): required once the page asks it; a page from
  -- before sends no key at all.
  v_wp     text := regexp_replace(trim(coalesce(p->>'workplace','')), '\s+', ' ', 'g');
  v_wp_on  boolean := p ? 'workplace';
  v_heard  text := nullif(trim(coalesce(p->>'heard_from','')), '');
  v_lang   text := coalesce(nullif(p->>'lang',''), 'en');
  v_pv     text := coalesce(p->>'privacy_version','');
  v_news   boolean := coalesce((p->>'ride_news')::boolean, false);
  v_today  date := (now() at time zone 'Asia/Riyadh')::date;
  v_bd     date;
  v_prev   community_applications%rowtype;
begin
  if not _ip_gate('community', 20, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  begin v_height := nullif(regexp_replace(coalesce(p->>'height',''), '\D', '', 'g'), '')::int;
  exception when others then v_height := null; end;

  if v_name = '' or length(v_name) > 120 or v_name !~ '\s' or not _name_chars_ok(v_name) then
    return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if length(v_email) > 254 or v_email !~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' then
    return jsonb_build_object('ok', false, 'error', 'email'); end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' or (v_phone like '+966%' and v_phone !~ '^\+9665[0-9]{8}$') then
    return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if v_height is null or v_height < 100 or v_height > 250 then
    return jsonb_build_object('ok', false, 'error', 'height'); end if;
  begin v_bd := v_birth::date; exception when others then v_bd := null; end;
  if v_bd is null or v_birth !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or v_bd > v_today
     or v_bd > (v_today - interval '5 years')::date or v_bd < date '1900-01-01' then
    return jsonb_build_object('ok', false, 'error', 'birth_date'); end if;
  if v_gender not in ('male','female') then return jsonb_build_object('ok', false, 'error', 'gender'); end if;
  if v_nat = '' or length(v_nat) > 60 or v_nat ~ '[<>"`]' then return jsonb_build_object('ok', false, 'error', 'nationality'); end if;
  if v_type not in ('Road','Hybrid','Mountain') then return jsonb_build_object('ok', false, 'error', 'bike_type'); end if;
  if v_ig <> '' and v_ig !~ '^[A-Za-z0-9._]{1,30}$' then return jsonb_build_object('ok', false, 'error', 'instagram'); end if;
  if v_li <> '' and v_li !~ '^[A-Za-z0-9._%-]{3,100}$' then return jsonb_build_object('ok', false, 'error', 'linkedin'); end if;
  if length(v_prof) < 2 or length(v_prof) > 80 or v_prof ~ '[<>"`{}]' then
    return jsonb_build_object('ok', false, 'error', 'profession'); end if;
  if v_wp_on and (length(v_wp) < 2 or length(v_wp) > 120 or v_wp ~ '[<>"`{}]') then
    return jsonb_build_object('ok', false, 'error', 'workplace'); end if;
  if v_heard is not null and v_heard not in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp',
     'google','friend','invited','passed_by','event','hotel','school','work','community','other') then
    return jsonb_build_object('ok', false, 'error', 'heard_from'); end if;
  if v_pv !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'privacy'); end if;
  if v_lang !~ '^[a-z]{2}$' then v_lang := 'en'; end if;

  perform pg_advisory_xact_lock(hashtext('commapp:' || v_email));
  perform pg_advisory_xact_lock(hashtext('commapp:' || v_phone));
  select * into v_prev from community_applications
   where status = 'pending' and (lower(email) = v_email or phone = v_phone)
   order by (lower(email) = v_email) desc, created_at limit 1;
  if v_prev.id is not null then
    update community_applications set
      name = v_name, email = v_email, phone = v_phone, height = v_height, birth_date = v_birth,
      gender = v_gender, nationality = v_nat, bike_type = v_type, instagram = v_ig, linkedin = v_li,
      profession = v_prof, workplace = case when v_wp_on then v_wp else workplace end,
      heard_from = coalesce(v_heard, heard_from), lang = v_lang, privacy_version = v_pv, ride_news = v_news,
      submissions = submissions + 1, updated_at = now()
     where id = v_prev.id;
  else
    insert into community_applications (name, email, phone, height, birth_date, gender, nationality,
      bike_type, instagram, linkedin, profession, workplace, heard_from, lang, privacy_version, ride_news)
    values (v_name, v_email, v_phone, v_height, v_birth, v_gender, v_nat, v_type, v_ig, v_li,
      v_prof, nullif(v_wp, ''), v_heard, v_lang, v_pv, v_news);
  end if;
  return jsonb_build_object('ok', true);
end $function$;
revoke execute on function public.community_apply(jsonb) from public;
grant  execute on function public.community_apply(jsonb) to anon, authenticated;

-- 3. Approving it -----------------------------------------------------------------------------
create or replace function public.staff_community_approve(p_id uuid, p_by text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  a community_applications%rowtype;
  c customers%rowtype;
  v_id text; v_pwd text; v_digits text; v_socials jsonb; v_ms bigint;
  v_by text := left(coalesce(nullif(trim(p_by), ''), 'staff'), 80);
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into a from community_applications where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'error', 'missing'); end if;
  if a.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'decided', 'status', a.status); end if;

  v_digits := regexp_replace(a.phone, '\D', '', 'g');
  v_ms := (extract(epoch from now()) * 1000)::bigint;
  select * into c from customers
   where lower(trim(email)) = lower(a.email) or lower(trim(apple_email)) = lower(a.email)
   order by (lower(trim(email)) = lower(a.email)) desc nulls last, created_at limit 1;
  if c.id is null then
    select * into c from customers where regexp_replace(coalesce(phone,''), '\D', '', 'g') = v_digits
     order by created_at limit 1;
  end if;

  if c.id is not null then
    v_socials := coalesce(c.socials, '{}'::jsonb);
    if a.instagram <> '' and not (v_socials ? 'instagram') then v_socials := v_socials || jsonb_build_object('instagram', a.instagram); end if;
    if a.linkedin <> '' and not (v_socials ? 'linkedin')  then v_socials := v_socials || jsonb_build_object('linkedin',  a.linkedin);  end if;
    update customers set
      profession  = coalesce(nullif(trim(profession), ''), a.profession),
      workplace   = coalesce(nullif(trim(workplace), ''), nullif(a.workplace, '')),
      socials     = v_socials,
      birth_date  = coalesce(nullif(birth_date, ''), a.birth_date),
      nationality = coalesce(nullif(nationality, ''), a.nationality),
      height      = coalesce(height, a.height),
      gender      = coalesce(gender, a.gender),
      heard_from  = coalesce(heard_from, a.heard_from),
      privacy_version = case when privacy_version is null or privacy_version < a.privacy_version then a.privacy_version else privacy_version end,
      privacy_at      = case when privacy_version is null or privacy_version < a.privacy_version then a.updated_at else privacy_at end,
      ride_news       = case when ride_news_at is null or ride_news_at < a.updated_at then a.ride_news else ride_news end,
      ride_news_at    = case when ride_news_at is null or ride_news_at < a.updated_at then a.updated_at else ride_news_at end
     where id = c.id;
    v_id := c.id;
  else
    v_id := 'ca' || encode(gen_random_bytes(8), 'hex');
    v_pwd := _community_temp_pwd();
    insert into customers (id, name, email, phone, password_hash, created_at, height, type_preference,
      gender, birth_date, nationality, socials, profession, workplace, heard_from, session_token, must_change_pwd,
      privacy_version, privacy_at, ride_news, ride_news_at)
    values (v_id, a.name, a.email, a.phone, crypt(v_pwd, gen_salt('bf')),
      to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), a.height, a.bike_type,
      a.gender, a.birth_date, a.nationality,
      nullif(jsonb_strip_nulls(jsonb_build_object('instagram', nullif(a.instagram, ''), 'linkedin', nullif(a.linkedin, ''))), '{}'::jsonb), a.profession,
      nullif(a.workplace, ''), a.heard_from, encode(gen_random_bytes(24), 'hex'), true,
      a.privacy_version, a.updated_at, a.ride_news, a.updated_at);
  end if;

  insert into customer_tags (customer_id, tag_id, added_by, added_at, note)
  values (v_id, 'tag_saturday', v_by, v_ms, 'Community application')
  on conflict (customer_id, tag_id) do nothing;

  update community_applications set status = 'approved', decided_at = now(), decided_by = v_by,
    customer_id = v_id, existing_account = (c.id is not null), updated_at = now()
   where id = a.id;

  select * into c from customers where id = v_id;
  update community_applications set account_oauth = coalesce(c.password_hash, '') like 'oauth:%' where id = a.id;
  return jsonb_build_object('ok', true, 'existing', v_pwd is null, 'customer_id', v_id,
    'name', c.name, 'email', c.email, 'phone', c.phone, 'password', v_pwd, 'lang', a.lang,
    'oauth', coalesce(c.password_hash, '') like 'oauth:%');
end $function$;
revoke execute on function public.staff_community_approve(uuid, text) from public, anon;
grant  execute on function public.staff_community_approve(uuid, text) to authenticated;

-- 4. The learn-to-ride sign-up ----------------------------------------------------------------
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
  -- Where they work or study (20260929110000): required once the page asks it.
  v_wp     text := regexp_replace(trim(coalesce(p->>'workplace','')), '\s+', ' ', 'g');
  v_wp_on  boolean := p ? 'workplace';
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
    if v_wp_on and (length(v_wp) < 2 or length(v_wp) > 120 or v_wp ~ '[<>"`{}]') then
      return jsonb_build_object('ok', false, 'error', 'workplace'); end if;
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
      workplace   = case when v_new and v_wp_on then v_wp else workplace end,
      instagram   = case when v_new then nullif(v_ig, '') else instagram end,
      linkedin    = case when v_new then nullif(v_li, '') else linkedin end,
      ride_news   = case when v_new then v_news    else ride_news end,
      submissions = submissions + 1, updated_at = now()
     where id = v_prev.id;
  else
    insert into learn_applications (for_whom, name, email, phone, learners, learner_name, learner_age, learner_gender,
      learner_height, level, notes, heard_from, lang, privacy_version,
      birth_date, gender, nationality, height, profession, workplace, instagram, linkedin, ride_news)
    values (v_one->>'who', v_name, v_email, v_phone, v_list, v_one->>'name', (v_one->>'age')::int, v_one->>'gender',
      (v_one->>'height')::int, v_one->>'level', v_notes, v_heard, v_lang, v_pv,
      case when v_new then v_birth end, case when v_new then v_cgend end, case when v_new then v_nat end,
      case when v_new then v_cheight end, case when v_new then v_prof end,
      case when v_new and v_wp_on then nullif(v_wp, '') end,
      case when v_new then nullif(v_ig, '') end, case when v_new then nullif(v_li, '') end, v_new and v_news);
  end if;
  -- The form learns nothing about accounts or earlier sign-ups.
  return jsonb_build_object('ok', true);
end $function$;
revoke execute on function public.learn_apply(jsonb) from public;
grant  execute on function public.learn_apply(jsonb) to anon, authenticated;

-- 5. Scheduling it (the account is found or made here) ------------------------------------------
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
        workplace   = coalesce(nullif(trim(workplace), ''), nullif(a.workplace, '')),
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
        type_preference, birth_date, nationality, socials, profession, workplace,
        session_token, must_change_pwd, privacy_version, privacy_at, ride_news, ride_news_at)
      values (v_id, a.name, a.email, a.phone, crypt(v_pwd, gen_salt('bf')),
        to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        coalesce(a.height, case when a.for_whom = 'self' then a.learner_height end),
        coalesce(a.gender, case when a.for_whom = 'self' then a.learner_gender end),
        'Any', a.birth_date, a.nationality, nullif(v_socials, '{}'::jsonb), a.profession, nullif(a.workplace, ''),
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

-- 6. The account page reads them --------------------------------------------------------------
create or replace function public.customer_about(p_id text, p_token text)
 returns table(profession text, workplace text, heard_from text)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not _cust_token_ok(p_id, p_token) then return; end if;
  return query select c.profession, c.workplace, c.heard_from from customers c where c.id = p_id;
end $function$;
revoke execute on function public.customer_about(text, text) from public;
grant  execute on function public.customer_about(text, text) to anon, authenticated;

-- 7. ... and saves them -----------------------------------------------------------------------
create or replace function public.customer_set_about(p_id text, p_token text, p_profession text,
  p_workplace text, p_heard_from text default null, p_gender text default null)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_prof  text := nullif(regexp_replace(btrim(coalesce(p_profession, '')), '\s+', ' ', 'g'), '');
  v_wp    text := nullif(regexp_replace(btrim(coalesce(p_workplace, '')), '\s+', ' ', 'g'), '');
  v_heard text := nullif(btrim(coalesce(p_heard_from, '')), '');
  v_gend  text := nullif(btrim(coalesce(p_gender, '')), '');
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if v_prof is not null and (length(v_prof) < 2 or length(v_prof) > 80 or v_prof ~ '[<>"`{}]') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'profession'; end if;
  if v_wp is not null and (length(v_wp) < 2 or length(v_wp) > 120 or v_wp ~ '[<>"`{}]') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'workplace'; end if;
  if v_heard is not null and v_heard not in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp',
     'google','friend','invited','passed_by','event','hotel','school','work','community','other') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'heard_from'; end if;
  if v_gend is not null and v_gend not in ('male','female') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'gender'; end if;
  update customers set profession = v_prof, workplace = v_wp,
    heard_from = coalesce(v_heard, heard_from), gender = coalesce(v_gend, gender), updated_at = now()
   where id = p_id;
  return found;
end $function$;
revoke execute on function public.customer_set_about(text, text, text, text, text, text) from public;
grant  execute on function public.customer_set_about(text, text, text, text, text, text) to anon, authenticated;

commit;
