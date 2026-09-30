-- ============================================================================
-- Learn to ride makes (or signs in to) the account first, like the community application (the
-- owner, 2026-09-30: "apply the 2 steps registration on learn to ride too and add a question asking
-- if the learner has an account or not, if he has skip the sign up procedure, only for learning
-- form").
--
--  1. customer_learn_apply(id, token, answers): the sign-up's second step, from a signed-in account
--     (made by the first step with customer_signup, signed in with customer_login, or handed over by
--     the booking app with customer_handoff_create). The person's name, email, mobile, ride-news
--     answer and confirmed Privacy Notice are the account's own; gender and height too, taken from
--     the answers only where the account has none (and then kept on it). The rest - the learners,
--     date of birth, nationality, Instagram, LinkedIn, profession, company, how they heard of us,
--     notes - is checked by learn_apply itself (same codes, same throttle), and the application
--     it writes is linked to the account (learn_applications.customer_id). An account the database
--     would not take as a sign-up contact (no email or mobile, a mobile in an old format) answers
--     'account'.
--  2. staff_learn_schedule: a sign-up linked to its account at the start has never been scheduled
--     (existing_account is still null): its first scheduling fills the account's blanks from it and
--     reads as a first scheduling ('first', existing account), not as a new time. Live definition
--     otherwise (20260928235900).
--
-- Rollback:
--   re-run staff_learn_schedule from its live definition of 2026-09-30 (20260928235900);
--   drop function public.customer_learn_apply(text, text, jsonb);
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

-- 1. The second step, from a signed-in account.
create or replace function public.customer_learn_apply(p_id text, p_token text, p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  c        customers%rowtype;
  v_email  text;
  v_phone  text;
  v_gender text;
  v_height int;
  v_pv     text;
  r        jsonb;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'error', 'learners'); end if;
  select * into c from customers where customers.id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'signed_out'); end if;
  v_email := lower(btrim(coalesce(c.email, '')));
  v_phone := btrim(coalesce(c.phone, ''));
  if coalesce(btrim(c.name), '') = '' or v_email = '' or v_phone = '' then
    return jsonb_build_object('ok', false, 'error', 'account');
  end if;
  v_gender := coalesce(nullif(c.gender, ''), p->>'gender', '');
  v_height := c.height;
  if v_height is null then
    begin v_height := nullif(regexp_replace(coalesce(p->>'height', ''), '\D', '', 'g'), '')::int;
    exception when others then v_height := null; end;
  end if;
  v_pv := coalesce(nullif(c.privacy_version, ''), p->>'privacy_version', '');

  -- learn_apply checks everything and writes the application (it throttles, too).
  r := learn_apply((p - 'name' - 'email' - 'phone' - 'gender' - 'height' - 'ride_news' - 'privacy_version')
    || jsonb_build_object('name', c.name, 'email', v_email, 'phone', v_phone, 'gender', v_gender,
         'height', v_height, 'ride_news', coalesce(c.ride_news, false), 'privacy_version', v_pv));
  if coalesce((r->>'ok')::boolean, false) then
    update learn_applications set customer_id = p_id
     where id = (select x.id from learn_applications x
                  where x.status = 'pending' and (lower(x.email) = v_email or x.phone = v_phone)
                  order by x.updated_at desc limit 1);
    if c.gender is null or c.height is null then
      update customers set gender = coalesce(gender, v_gender), height = coalesce(height, v_height) where id = p_id;
    end if;
  elsif r->>'error' in ('name', 'email', 'phone') then
    return jsonb_build_object('ok', false, 'error', 'account');  -- the account's own details, not the answers
  end if;
  return r;
end $function$;

revoke all on function public.customer_learn_apply(text, text, jsonb) from public;
grant execute on function public.customer_learn_apply(text, text, jsonb) to anon, authenticated;

-- 2. A sign-up linked at the start: its first scheduling is a first scheduling.
create or replace function public.staff_learn_schedule(p_id uuid, p_at timestamp with time zone, p_place text default null, p_by text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  a learn_applications%rowtype;
  c customers%rowtype;
  v_id text; v_pwd text; v_digits text; v_hops int := 0; v_first boolean; v_socials jsonb;
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

  if a.customer_id is not null then
    select * into c from customers where id = a.customer_id;
    while c.id is not null and c.merged_into is not null and v_hops < 5 loop
      select * into c from customers where id = c.merged_into; v_hops := v_hops + 1;
    end loop;
  end if;
  -- Never scheduled: no account yet, or the account the sign-up came from (customer_learn_apply,
  -- 20260930170000), whose existing_account is still null.
  v_first := c.id is null or a.existing_account is null;

  if v_first then
    if c.id is null then
      v_digits := regexp_replace(a.phone, '\D', '', 'g');
      select * into c from customers
       where (lower(trim(email)) = lower(a.email) or lower(trim(apple_email)) = lower(a.email)) and merged_into is null
       order by (lower(trim(email)) = lower(a.email)) desc nulls last, created_at limit 1;
      if c.id is null then
        select * into c from customers where regexp_replace(coalesce(phone,''), '\D', '', 'g') = v_digits and merged_into is null
         order by created_at limit 1;
      end if;
    end if;
    if c.id is not null then
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
  return jsonb_build_object('ok', true, 'existing', a.existing_account, 'first', v_first,
    'customer_id', v_id, 'name', c.name, 'email', c.email, 'phone', c.phone, 'password', v_pwd,
    'lang', a.lang, 'oauth', a.account_oauth, 'lesson_at', a.lesson_at, 'lesson_place', a.lesson_place,
    'must_change', c.must_change_pwd);
end $function$;

commit;
