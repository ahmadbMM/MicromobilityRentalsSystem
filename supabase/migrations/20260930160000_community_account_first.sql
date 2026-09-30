-- ============================================================================
-- The community application makes the account first, and Google and Apple stop making accounts
-- (the owner, 2026-09-30: "let the applicant create an account first with the same sign up
-- requirements that is in the sign up landing page then take them to the next step which asks
-- them the same other fields ... remove the apple sign up and google sign up ... force them to
-- add a password if there wasn't one already linked").
--
--  1. customer_community_apply(id, token, answers): the form's second step. The applicant is
--     signed in (the account the first step just made with customer_signup, or the one the
--     booking app handed over with customer_handoff_create), so the name, email, mobile, gender
--     and height are the account's own; the answers are the community questions the sign-up does
--     not ask (date of birth, nationality, Instagram, LinkedIn, profession, company, bike type,
--     how they heard of us), checked as community_apply checks them. The application is written
--     with customer_id, so staff see which account it is and approval tags that account. A pending
--     application of the same account, email or mobile is updated, as community_apply does. A
--     member already holding the Community tag is told so ('member'). Anon and authenticated, as
--     the form calls with the public key; token-checked and _ip_gate-metered like community_apply.
--     Gender and height come from the answers only where the account has none (older accounts),
--     and are then kept on the account too.
--  2. customer_community_me(id, token): what that second step shows - who is applying, whether
--     they are a member already or have an application waiting, and the answers to start from
--     (the waiting application's, else the account's).
--  3. staff_community_approve: an application sent from an account lands on that account (merges
--     followed); the email and mobile matching stays for the applications sent before. Signature
--     and answer unchanged. Live definition otherwise (20260929150000, md5 6506d749).
--  4. _customer_asks: every account with no password (password_hash 'oauth:google'/'oauth:apple')
--     is asked to choose one; it was only accounts with a linked Apple address. The app shows the
--     check-up at sign-in and at the next event pick, and customer_create_booking refuses the
--     booking (FIX_FIRST) until the password is saved. 965 accounts on 2026-09-30.
--  5. customer_fix_save: a password saved there must be as strong as the sign-up asks (8
--     characters, an upper-case letter, a digit), and when the account had none it is recorded
--     in customer_owner_pwd - chosen by the owner of the Google or Apple sign-in, the only way
--     into an account without a password.
--  6. customer_oauth_login: such a password is kept on the next Google or Apple sign-in (with the
--     session token). Otherwise a password account that signs in with Google still has its
--     password ended, as before: it may have been made by someone else with this email, and the
--     check-up then asks the owner for their own.
--  7. customer_oauth_signup: no longer callable by the app's visitors. Google and Apple sign
--     existing accounts in; a new rider signs up with email and password.
--
-- Rollback:
--   re-run _customer_asks from 20260925170000, customer_fix_save and customer_oauth_login from
--   their live definitions of 2026-09-30 (20260929080000 for customer_oauth_login),
--   staff_community_approve from 20260929150000;
--   grant execute on function public.customer_oauth_signup(text,text,text,text,integer,text,text,text) to anon, authenticated;
--   drop function public.customer_community_apply(text,text,jsonb), public.customer_community_me(text,text);
--   drop table public.customer_owner_pwd;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

-- 5/6. The password an account's own Google or Apple sign-in chose. pwd_hash is the hash it had
-- then: a password changed any other way later no longer matches, and counts as before.
create table if not exists public.customer_owner_pwd (
  customer_id text primary key references public.customers(id) on delete cascade,
  pwd_hash    text not null,
  set_at      timestamptz not null default now()
);
alter table public.customer_owner_pwd enable row level security;
revoke all on public.customer_owner_pwd from public, anon, authenticated;
comment on table public.customer_owner_pwd is
  'A password chosen in the check-up by an account that had none (its Google or Apple owner); customer_oauth_login keeps it while the hash still matches. No policies: definer functions only.';

-- 4. Every account without a password is asked for one.
create or replace function public._customer_asks(p_id text)
 returns text[]
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare c customers%rowtype; f text[]; relay boolean;
begin
  select * into c from customers where customers.id = p_id;
  if not found then return null; end if;
  f := coalesce(c.fix_fields,'{}'::text[]);
  relay := lower(btrim(coalesce(c.email,''))) like '%@privaterelay.appleid.com';
  if relay and not ('email' = any(f)) then
    f := f || 'email'::text;
  end if;
  -- No password: Google and Apple sign-in are going away (20260930160000); was Apple accounts only.
  if coalesce(c.password_hash,'') like 'oauth:%' and not ('password' = any(f))
     and (not relay or 'email' = any(f)) then
    f := f || 'password'::text;
  end if;
  if exists (select 1 from customer_tags ct
              where ct.customer_id = p_id and ct.tag_id = 'tag_saturday'
                and _ctag_active(ct.starts_at, ct.expires_at)) then
    if coalesce(btrim(c.birth_date),'') = '' and not ('birth_date' = any(f)) then
      f := f || 'birth_date'::text;
    end if;
    if coalesce(btrim(c.nationality),'') = '' and not ('nationality' = any(f)) then
      f := f || 'nationality'::text;
    end if;
  end if;
  return f;
end $function$;

-- 5. The check-up's password: as strong as the sign-up's, and recorded as the owner's.
create or replace function public.customer_fix_save(p_id text, p_token text, p_values jsonb)
 returns text[]
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  c      customers%rowtype;
  n      customers%rowtype;
  stored text[];
  flags  text[];
  done   text[] := '{}';
  k text;
  v text;
begin
  if not _cust_token_ok(p_id,p_token) then return null; end if;
  select * into c from customers where customers.id = p_id for update;
  if not found then return null; end if;
  stored := coalesce(c.fix_fields,'{}'::text[]);
  flags := _customer_asks(p_id);
  if p_values is null or jsonb_typeof(p_values) <> 'object' then return flags; end if;

  if 'country' = any(flags) or 'city' = any(flags) then
    v := nullif(btrim(coalesce(p_values->>'country','')),'');
    if v is not null then
      update customers set country = left(v,80),
        city = left(nullif(btrim(coalesce(p_values->>'city','')),''),120)
      where id = p_id;
      done := done || array['country','city'];
    end if;
  end if;

  foreach k in array flags loop
    if not (p_values ? k) then continue; end if;
    if k = 'password' then
      v := p_values->>'password';
      if char_length(coalesce(v,'')) < 8 or v !~ '[A-Z]' or v !~ '[0-9]' then continue; end if;
      update customers set password_hash = crypt(v, gen_salt('bf')) where id = p_id;
      -- An account without a password is reached only through its Google or Apple sign-in, so
      -- this password is the owner's: customer_oauth_login keeps it (20260930160000).
      if coalesce(c.password_hash,'') like 'oauth:%' then
        insert into customer_owner_pwd (customer_id, pwd_hash)
        select x.id, x.password_hash from customers x where x.id = p_id
        on conflict (customer_id) do update set pwd_hash = excluded.pwd_hash, set_at = now();
      end if;
      done := done || k;
      continue;
    end if;
    v := nullif(btrim(coalesce(p_values->>k,'')),'');
    if v is null then continue; end if;
    case k
      when 'name' then
        if char_length(v) < 2 then continue; end if;
        if not _name_chars_ok(v) then continue; end if;
        update customers set name = left(v,120) where id = p_id;
      when 'email' then
        v := lower(v);
        if v !~ '^[^[:space:]@<>"''()]+@[^[:space:]@<>"''()]+\.[^[:space:]@<>"''()]+$' then continue; end if;
        if v like '%@privaterelay.appleid.com' then continue; end if;
        if exists(select 1 from customers o where o.id <> p_id
                    and (lower(btrim(o.email)) = v or lower(btrim(o.apple_email)) = v)) then
          raise exception 'email_taken' using errcode = '23505';
        end if;
        update customers set email = v where id = p_id;
      when 'phone' then
        if v !~ '^\+?[0-9]{8,15}$' then continue; end if;
        if exists(select 1 from customers o where o.phone = v and o.id <> p_id) then
          raise exception 'phone_taken' using errcode = '23505';
        end if;
        update customers set phone = v where id = p_id;
      when 'birth_date' then
        if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then continue; end if;
        update customers set birth_date = v where id = p_id;
      when 'gender' then
        if v not in ('male','female') then continue; end if;
        update customers set gender = v where id = p_id;
      when 'nationality' then update customers set nationality = left(v,80) where id = p_id;
      when 'country', 'city' then continue;
      when 'height' then
        if v !~ '^[0-9]{3}$' or v::int not between 100 and 250 then continue; end if;
        update customers set height = v::int where id = p_id;
      when 'photo' then
        if v !~ '^https://' then continue; end if;
        update customers set photo = v where id = p_id;
      else continue;
    end case;
    done := done || k;
  end loop;

  stored := array(select f from unnest(stored) f where f <> all(done));
  update customers set fix_fields = case when cardinality(stored) = 0 then null else stored end where id = p_id;

  if cardinality(done) > 0 then
    select * into n from customers where customers.id = p_id;
    update customer_flags cf set
        changes = cf.changes || coalesce((
          select jsonb_object_agg(k2, jsonb_build_object('before', to_jsonb(c)->k2, 'after', to_jsonb(n)->k2, 'at', now()))
          from unnest(done) k2
          where k2 <> 'password'
            and (k2 = any(cf.fields) or (k2 in ('country','city') and cf.fields && array['country','city']))), '{}'::jsonb),
        status      = case when cardinality(stored) = 0 then 'answered' else 'pending' end,
        answered_at = case when cardinality(stored) = 0 then now() else null end
      where cf.customer_id = p_id and cf.status = 'pending';
  end if;

  return array(select f from unnest(flags) f where f <> all(done));
end $function$;

-- 6. The owner's own password survives the next Google or Apple sign-in.
create or replace function public.customer_oauth_login(p_email text)
 returns table(id text, name text, email text, phone text, height integer, type_preference text, created_at text, birth_date text, country text, city text, photo text, session_token text)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare r customers%rowtype; c customers%rowtype; tok text; prov text := coalesce(auth.jwt()->'app_metadata'->>'provider',''); hops int := 0;
begin
  if auth.uid() is null or lower(coalesce(auth.jwt()->>'email','')) <> lower(p_email)
     or prov not in ('google','apple') then return; end if;
  select * into r from customers
   where lower(customers.email) = lower(p_email) or lower(customers.apple_email) = lower(p_email)
   order by coalesce(lower(customers.email) = lower(p_email), false) desc
   limit 1;
  if not found then return; end if;
  while r.merged_into is not null and hops < 5 loop
    select * into c from customers where customers.id = r.merged_into;
    exit when not found;
    r := c; hops := hops + 1;
  end loop;
  -- No password to end, an Apple account the site asks to keep one (2026-09-29), or a password
  -- this sign-in's owner chose in the check-up (20260930160000): the password and the token
  -- stay, so no other device is signed out.
  if coalesce(r.password_hash,'') like 'oauth:%' or coalesce(btrim(r.apple_email),'') <> ''
     or exists(select 1 from customer_owner_pwd o where o.customer_id = r.id and o.pwd_hash = r.password_hash) then
    tok := coalesce(nullif(r.session_token,''), encode(gen_random_bytes(24),'hex'));
    update customers set session_token = tok where customers.id = r.id;
  else
    tok := encode(gen_random_bytes(24),'hex');
    update customers set session_token = tok, password_hash = 'oauth:' || prov, must_change_pwd = false
     where customers.id = r.id;
  end if;
  return query select r.id, r.name, r.email, r.phone, r.height, r.type_preference,
    r.created_at, r.birth_date, r.country, r.city, r.photo, tok;
end $function$;

-- 7. Google and Apple no longer make accounts.
revoke execute on function public.customer_oauth_signup(text, text, text, text, integer, text, text, text) from public, anon, authenticated;

-- 1. The form's second step, from a signed-in account.
create or replace function public.customer_community_apply(p_id text, p_token text, p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  c        customers%rowtype;
  v_birth  text := trim(coalesce(p->>'birth_date',''));
  v_nat    text := trim(coalesce(p->>'nationality',''));
  v_type   text := coalesce(p->>'bike_type','');
  v_ig     text := regexp_replace(trim(coalesce(p->>'instagram','')), '^@+', '');
  v_li     text := trim(coalesce(p->>'linkedin',''));
  v_prof   text := regexp_replace(trim(coalesce(p->>'profession','')), '\s+', ' ', 'g');
  v_wp     text := regexp_replace(trim(coalesce(p->>'workplace','')), '\s+', ' ', 'g');
  v_heard  text := nullif(trim(coalesce(p->>'heard_from','')), '');
  v_lang   text := coalesce(nullif(p->>'lang',''), 'en');
  v_name   text;
  v_email  text;
  v_phone  text;
  v_gender text;
  v_height int;
  v_pv     text;
  v_today  date := (now() at time zone 'Asia/Riyadh')::date;
  v_bd     date;
  v_prev   community_applications%rowtype;
begin
  if not _ip_gate('community', 20, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then
    return jsonb_build_object('ok', false, 'error', 'signed_out');
  end if;
  select * into c from customers where customers.id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'signed_out'); end if;
  if exists (select 1 from customer_tags ct
              where ct.customer_id = p_id and ct.tag_id = 'tag_saturday'
                and _ctag_active(ct.starts_at, ct.expires_at)) then
    return jsonb_build_object('ok', false, 'error', 'member');
  end if;

  -- Who applies: the account.
  v_name  := regexp_replace(trim(coalesce(c.name,'')), '\s+', ' ', 'g');
  v_email := lower(btrim(coalesce(c.email,'')));
  v_phone := btrim(coalesce(c.phone,''));
  if v_name = '' or v_email = '' or v_phone = '' then
    return jsonb_build_object('ok', false, 'error', 'account');
  end if;
  v_gender := coalesce(nullif(c.gender,''), p->>'gender', '');
  v_height := c.height;
  if v_height is null then
    begin v_height := nullif(regexp_replace(coalesce(p->>'height',''), '\D', '', 'g'), '')::int;
    exception when others then v_height := null; end;
  end if;
  if v_gender not in ('male','female') then return jsonb_build_object('ok', false, 'error', 'gender'); end if;
  if v_height is null or v_height < 100 or v_height > 250 then
    return jsonb_build_object('ok', false, 'error', 'height'); end if;

  -- The community questions, as community_apply checks them.
  begin v_bd := v_birth::date; exception when others then v_bd := null; end;
  if v_bd is null or v_birth !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or v_bd > v_today
     or v_bd > (v_today - interval '5 years')::date or v_bd < date '1900-01-01' then
    return jsonb_build_object('ok', false, 'error', 'birth_date'); end if;
  if v_nat = '' or length(v_nat) > 60 or v_nat ~ '[<>"`]' then return jsonb_build_object('ok', false, 'error', 'nationality'); end if;
  if v_type not in ('Road','Hybrid','Mountain') then return jsonb_build_object('ok', false, 'error', 'bike_type'); end if;
  if v_ig <> '' and v_ig !~ '^[A-Za-z0-9._]{1,30}$' then return jsonb_build_object('ok', false, 'error', 'instagram'); end if;
  if v_li <> '' and v_li !~ '^[A-Za-z0-9._%-]{3,100}$' then return jsonb_build_object('ok', false, 'error', 'linkedin'); end if;
  if length(v_prof) < 2 or length(v_prof) > 80 or v_prof ~ '[<>"`{}]' then
    return jsonb_build_object('ok', false, 'error', 'profession'); end if;
  if length(v_wp) < 2 or length(v_wp) > 120 or v_wp ~ '[<>"`{}]' then
    return jsonb_build_object('ok', false, 'error', 'workplace'); end if;
  if v_heard is null or v_heard not in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp',
     'google','friend','invited','passed_by','event','hotel','school','work','community','other') then
    return jsonb_build_object('ok', false, 'error', 'heard_from'); end if;
  -- The notice the account confirmed (the first step records it with customer_consents).
  v_pv := coalesce(nullif(c.privacy_version,''), p->>'privacy_version', '');
  if v_pv !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'privacy'); end if;
  if v_lang !~ '^[a-z]{2}$' then v_lang := 'en'; end if;

  -- An older account without a gender or height keeps the ones given here.
  if c.gender is null or c.height is null then
    update customers set gender = coalesce(gender, v_gender), height = coalesce(height, v_height) where id = p_id;
  end if;

  perform pg_advisory_xact_lock(hashtext('commapp:' || v_email));
  perform pg_advisory_xact_lock(hashtext('commapp:' || v_phone));
  select * into v_prev from community_applications x
   where x.status = 'pending' and (x.customer_id = p_id or lower(x.email) = v_email or x.phone = v_phone)
   order by (x.customer_id = p_id) desc nulls last, (lower(x.email) = v_email) desc, x.created_at limit 1;
  if v_prev.id is not null then
    update community_applications set
      name = v_name, email = v_email, phone = v_phone, height = v_height, birth_date = v_birth,
      gender = v_gender, nationality = v_nat, bike_type = v_type, instagram = v_ig, linkedin = v_li,
      profession = v_prof, workplace = v_wp, heard_from = v_heard, lang = v_lang, privacy_version = v_pv,
      ride_news = coalesce(c.ride_news, false), customer_id = p_id,
      submissions = submissions + 1, updated_at = now()
     where id = v_prev.id;
  else
    insert into community_applications (name, email, phone, height, birth_date, gender, nationality,
      bike_type, instagram, linkedin, profession, workplace, heard_from, lang, privacy_version, ride_news, customer_id)
    values (v_name, v_email, v_phone, v_height, v_birth, v_gender, v_nat, v_type, v_ig, v_li,
      v_prof, v_wp, v_heard, v_lang, v_pv, coalesce(c.ride_news, false), p_id);
  end if;
  return jsonb_build_object('ok', true, 'updated', v_prev.id is not null);
end $function$;

-- 2. What the second step shows a signed-in applicant.
create or replace function public.customer_community_me(p_id text, p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare c customers%rowtype; a community_applications%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return null; end if;
  select * into c from customers where customers.id = p_id;
  if not found then return null; end if;
  select * into a from community_applications x
   where x.status = 'pending'
     and (x.customer_id = p_id or lower(x.email) = lower(btrim(coalesce(c.email,''))) or x.phone = c.phone)
   order by (x.customer_id = p_id) desc nulls last, x.created_at desc limit 1;
  return jsonb_build_object(
    'name', c.name, 'email', c.email, 'phone', c.phone,
    'member', exists (select 1 from customer_tags ct
                       where ct.customer_id = p_id and ct.tag_id = 'tag_saturday'
                         and _ctag_active(ct.starts_at, ct.expires_at)),
    'pending', a.id is not null,
    'gender', c.gender, 'height', c.height,
    'birth_date', coalesce(nullif(a.birth_date,''), nullif(c.birth_date,'')),
    'nationality', coalesce(nullif(a.nationality,''), nullif(c.nationality,'')),
    'instagram', coalesce(nullif(a.instagram,''), nullif(c.socials->>'instagram','')),
    'linkedin', coalesce(nullif(a.linkedin,''), nullif(c.socials->>'linkedin','')),
    'profession', coalesce(nullif(a.profession,''), nullif(c.profession,'')),
    'workplace', coalesce(nullif(a.workplace,''), nullif(c.workplace,'')),
    'bike_type', coalesce(nullif(a.bike_type,''), case when c.type_preference in ('Road','Hybrid','Mountain') then c.type_preference end),
    'heard_from', coalesce(a.heard_from, case when c.heard_from <> 'desk' then c.heard_from end));
end $function$;

revoke all on function public.customer_community_apply(text, text, jsonb) from public;
revoke all on function public.customer_community_me(text, text) from public;
grant execute on function public.customer_community_apply(text, text, jsonb) to anon, authenticated;
grant execute on function public.customer_community_me(text, text) to anon, authenticated;

-- 3. An application sent from an account lands on that account.
create or replace function public.staff_community_approve(p_id uuid, p_by text default null, p_community boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  a community_applications%rowtype;
  c customers%rowtype;
  v_id text; v_pwd text; v_digits text; v_socials jsonb; v_ms bigint; v_hops int := 0;
  v_by text := left(coalesce(nullif(trim(p_by), ''), 'staff'), 80);
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into a from community_applications where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'error', 'missing'); end if;
  if a.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'decided', 'status', a.status); end if;

  v_digits := regexp_replace(a.phone, '\D', '', 'g');
  v_ms := (extract(epoch from now()) * 1000)::bigint;
  -- Sent from an account (the form makes it first since 20260930160000): that account, through a merge.
  if a.customer_id is not null then
    select * into c from customers where id = a.customer_id;
    while c.id is not null and c.merged_into is not null and v_hops < 5 loop
      select * into c from customers where id = c.merged_into;
      v_hops := v_hops + 1;
    end loop;
  end if;
  if c.id is null then
    select * into c from customers
     where lower(trim(email)) = lower(a.email) or lower(trim(apple_email)) = lower(a.email)
     order by (lower(trim(email)) = lower(a.email)) desc nulls last, created_at limit 1;
  end if;
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

  -- The Community tag, unless staff unticked it in the Approve dialog (p_community false).
  if coalesce(p_community, true) then
    insert into customer_tags (customer_id, tag_id, added_by, added_at, note)
    values (v_id, 'tag_saturday', v_by, v_ms, 'Community application')
    on conflict (customer_id, tag_id) do nothing;
  end if;

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
