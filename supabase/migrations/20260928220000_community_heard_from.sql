-- ============================================================================
-- "How did you hear about us?" on the community application (the owner, 2026-09-28).
--
-- The booking app's own sign-up stopped asking it (it asked from 2026-09-27, 20260927180000); the
-- website's community form (micromobility.sa/community/registration) and the learn-to-ride form
-- ask it instead, and the answer reaches customers.heard_from when staff act on the application.
--
--  1. community_applications.heard_from - one of customers.heard_from's codes, never 'desk'.
--  2. community_apply(p) - reads p->>'heard_from'. The form requires it; the function lets an empty
--     answer through (a page loaded before the form's update sends none) and refuses a code it does
--     not know with 'heard_from'.
--  3. staff_community_approve - a new account gets the answer; an existing one keeps its own and
--     takes the application's only where it has none.
-- Both functions are their live definitions (pg_get_functiondef, 2026-09-28) with only the
-- heard_from lines added: SECURITY DEFINER and search_path as they were, and CREATE OR REPLACE
-- keeps their grants (community_apply: anon + authenticated; the approve: authenticated).
--
-- Rollback:
--   re-run the two functions from 20260922200000 / 20260924120000 (or their live definitions minus
--   the heard_from lines), then: alter table public.community_applications drop column if exists heard_from;
-- Idempotent.
-- ============================================================================

begin;

alter table public.community_applications add column if not exists heard_from text;
alter table public.community_applications drop constraint if exists community_applications_heard_from_check;
alter table public.community_applications add constraint community_applications_heard_from_check
  check (heard_from is null or heard_from in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp',
    'google','friend','invited','passed_by','event','hotel','school','work','community','other'));

CREATE OR REPLACE FUNCTION public.community_apply(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
      profession = v_prof, heard_from = coalesce(v_heard, heard_from), lang = v_lang, privacy_version = v_pv, ride_news = v_news,
      submissions = submissions + 1, updated_at = now()
     where id = v_prev.id;
  else
    insert into community_applications (name, email, phone, height, birth_date, gender, nationality,
      bike_type, instagram, linkedin, profession, heard_from, lang, privacy_version, ride_news)
    values (v_name, v_email, v_phone, v_height, v_birth, v_gender, v_nat, v_type, v_ig, v_li,
      v_prof, v_heard, v_lang, v_pv, v_news);
  end if;
  return jsonb_build_object('ok', true);
end $function$;

CREATE OR REPLACE FUNCTION public.staff_community_approve(p_id uuid, p_by text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
      gender, birth_date, nationality, socials, profession, heard_from, session_token, must_change_pwd,
      privacy_version, privacy_at, ride_news, ride_news_at)
    values (v_id, a.name, a.email, a.phone, crypt(v_pwd, gen_salt('bf')),
      to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), a.height, a.bike_type,
      a.gender, a.birth_date, a.nationality,
      nullif(jsonb_strip_nulls(jsonb_build_object('instagram', nullif(a.instagram, ''), 'linkedin', nullif(a.linkedin, ''))), '{}'::jsonb), a.profession,
      a.heard_from, encode(gen_random_bytes(24), 'hex'), true,
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

commit;
