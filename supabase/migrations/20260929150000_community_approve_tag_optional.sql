-- Approving a community application gives the Community tag unless staff untick it (the owner,
-- 2026-09-29: "dont force the community tag selection when approving a community form
-- registration, pre select it but give the staff the choice to unselect it").
--
-- staff_community_approve gains p_community boolean default true: the Approve dialog passes false
-- when the Community chip is unticked, and the tag is not inserted. Everything else is the live
-- definition (20260929110000_workplace, pg_get_functiondef md5 f68453b7 on 2026-09-29).
--
-- The two-argument function is dropped first: beside a three-argument one whose third has a
-- default, a call naming p_id and p_by would be ambiguous (PostgREST PGRST203). A caller that
-- names only p_id and p_by gets the three-argument one with p_community true, as before.
-- SECURITY DEFINER and search_path are declared again below; the grants are given again.

begin;

drop function if exists public.staff_community_approve(uuid, text);

create or replace function public.staff_community_approve(p_id uuid, p_by text default null, p_community boolean default true)
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

revoke execute on function public.staff_community_approve(uuid, text, boolean) from public, anon;
grant  execute on function public.staff_community_approve(uuid, text, boolean) to authenticated;

commit;
