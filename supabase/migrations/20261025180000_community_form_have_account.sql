-- ============================================================================
-- Community form: "Do you already have an account?" (the owner, 2026-10-25: "if yes don't ask him for the
-- fields he already have filled only if flagged ask him").
--
--   1. customer_community_me also answers 'flags': the account's staff-flagged fields (customers.fix_fields),
--      so the form asks again only what staff flagged and skips what the account already holds.
--   2. customer_community_apply, once the application is saved, clears from fix_fields every flagged field
--      the form answered (birth_date, nationality, instagram, linkedin, profession, workplace, whatsapp,
--      height, and emergency when the form saved a contact this time: p.emergency_saved), so the booking
--      site's check-up does not ask them a second time. A flagged height is taken from the form (it was
--      only ever filled when the account had none).
-- Both bodies read back from production on 2026-10-25 (md5 customer_community_me 81cff2d9...,
-- customer_community_apply df6d6255...); only the marked lines change. Same headers and grants.
--
-- Rollback: run both functions from 20261007200000 / 20261009235000 (as read back above) again.
-- ============================================================================

begin;
set local lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.customer_community_me(p_id text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare c customers%rowtype; a community_applications%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return null; end if;
  select * into c from customers where customers.id = p_id;
  if not found then return null; end if;
  select * into a from community_applications x
   where x.status = 'pending'
     -- another account's application stays its own, whatever number or email it shares (20261007120000)
     and (x.customer_id = p_id
          or (x.customer_id is null and (lower(x.email) = lower(btrim(coalesce(c.email,''))) or x.phone = c.phone)))
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
    'bike_type', coalesce(nullif(a.bike_type,''), case when c.type_preference in ('Road','Hybrid','Mountain','Own') then c.type_preference end),
    'heard_from', coalesce(a.heard_from, case when c.heard_from <> 'desk' then c.heard_from end),
    'own_bike', coalesce(a.own_bike, case when c.type_preference = 'Own' then true end),
    -- WhatsApp (20261007200000)
    'whatsapp_same', coalesce(a.whatsapp_same, c.whatsapp_same),
    'whatsapp', case when coalesce(a.whatsapp_same, c.whatsapp_same) = false then coalesce(a.whatsapp, c.whatsapp) end,
    -- the fields staff flagged on the account: asked again even when filled (20261025180000)
    'flags', to_jsonb(coalesce(c.fix_fields, '{}'::text[])));
end $function$;

CREATE OR REPLACE FUNCTION public.customer_community_apply(p_id text, p_token text, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
  v_cfg    jsonb := coalesce((select sc.value -> 'q' from site_content sc where sc.key = 'community.form'), '{}'::jsonb);
  v_name   text;
  v_email  text;
  v_phone  text;
  v_gender text;
  v_height int;
  v_pv     text;
  v_today  date := (now() at time zone 'Asia/Riyadh')::date;
  v_bd     date;
  v_prev   community_applications%rowtype;
  v_own    boolean;
  v_wa_same boolean;  -- WhatsApp (20261007200000)
  v_wa     text;
  v_hflag  boolean;   -- staff flagged the height (20261025180000)
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
  v_hflag := 'height' = any(coalesce(c.fix_fields, '{}'::text[])) and coalesce(p->>'height','') <> '';
  if v_height is null or v_hflag then
    begin v_height := nullif(regexp_replace(coalesce(p->>'height',''), '\D', '', 'g'), '')::int;
    exception when others then v_height := null; end;
  end if;
  if v_gender not in ('male','female') then return jsonb_build_object('ok', false, 'error', 'gender'); end if;
  if v_height is null or v_height < 100 or v_height > 250 then
    return jsonb_build_object('ok', false, 'error', 'height'); end if;

  -- The community questions, as community_apply checks them.
  if v_birth = '' and not _community_q_req(v_cfg, 'birth_date', true) then v_birth := null; else
  begin v_bd := v_birth::date; exception when others then v_bd := null; end;
  if v_bd is null or v_birth !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or v_bd > v_today
     or v_bd > (v_today - interval '5 years')::date or v_bd < date '1900-01-01' then
    return jsonb_build_object('ok', false, 'error', 'birth_date'); end if;
  end if;
  if v_nat = '' and not _community_q_req(v_cfg, 'nationality', true) then v_nat := null;
  elsif v_nat = '' or length(v_nat) > 60 or v_nat ~ '[<>"`]' then return jsonb_build_object('ok', false, 'error', 'nationality'); end if;
  if v_type = '' and not _community_q_req(v_cfg, 'bike_type', true) then v_type := null;
  elsif v_type not in ('Road','Hybrid','Mountain','Own') then return jsonb_build_object('ok', false, 'error', 'bike_type'); end if;
  if v_ig = '' and _community_q_req(v_cfg, 'instagram', false) then return jsonb_build_object('ok', false, 'error', 'instagram'); end if;
  if v_ig <> '' and v_ig !~ '^[A-Za-z0-9._]{1,30}$' then return jsonb_build_object('ok', false, 'error', 'instagram'); end if;
  if v_li = '' and _community_q_req(v_cfg, 'linkedin', false) then return jsonb_build_object('ok', false, 'error', 'linkedin'); end if;
  if v_li <> '' and v_li !~ '^[A-Za-z0-9._%-]{3,100}$' then return jsonb_build_object('ok', false, 'error', 'linkedin'); end if;
  if v_prof = '' and not _community_q_req(v_cfg, 'profession', true) then v_prof := null;
  elsif length(v_prof) < 2 or length(v_prof) > 80 or v_prof ~ '[<>"`{}]' then
    return jsonb_build_object('ok', false, 'error', 'profession'); end if;
  if v_wp = '' and not _community_q_req(v_cfg, 'workplace', true) then v_wp := null;
  elsif length(v_wp) < 2 or length(v_wp) > 120 or v_wp ~ '[<>"`{}]' then
    return jsonb_build_object('ok', false, 'error', 'workplace'); end if;
  if v_heard is null and not _community_q_req(v_cfg, 'heard_from', true) then null;
  elsif v_heard is null or v_heard not in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp',
     'google','friend','invited','passed_by','event','hotel','school','work','community','other') then
    return jsonb_build_object('ok', false, 'error', 'heard_from'); end if;
  -- Their own bike (20260930210000): yes or no; a form from before it sends nothing.
  if not (p ? 'own_bike') and _community_q_req(v_cfg, 'own_bike', false) then
    return jsonb_build_object('ok', false, 'error', 'own_bike'); end if;
  if p ? 'own_bike' then
    if jsonb_typeof(p->'own_bike') <> 'boolean' then return jsonb_build_object('ok', false, 'error', 'own_bike'); end if;
    v_own := (p->>'own_bike')::boolean;
  end if;
  -- Is the mobile their WhatsApp too, or which number is (20261007200000); a form from before sends nothing.
  if p ? 'whatsapp_same' then
    if jsonb_typeof(p->'whatsapp_same') <> 'boolean' then return jsonb_build_object('ok', false, 'error', 'whatsapp'); end if;
    v_wa_same := (p->>'whatsapp_same')::boolean;
    if not v_wa_same then
      v_wa := nullif(regexp_replace(coalesce(p->>'whatsapp',''), '[^0-9+]', '', 'g'), '');
      if v_wa is null or v_wa !~ '^\+?[0-9]{8,15}$' then return jsonb_build_object('ok', false, 'error', 'whatsapp'); end if;
      if right(regexp_replace(v_wa, '\D', '', 'g'), 9) = right(regexp_replace(c.phone, '\D', '', 'g'), 9) then
        v_wa_same := true; v_wa := null;
      end if;
    end if;
  end if;
  -- The notice the account confirmed (the first step records it with customer_consents).
  -- The form's notice only when the form showed it and the rider ticked it (privacy_ack); else
  -- the account's own, which may be none: no consent is recorded that was not given (20261005210200).
  v_pv := case when p->>'privacy_ack' = 'true' and coalesce(p->>'privacy_version', '') <> '' then p->>'privacy_version'
               else coalesce(nullif(c.privacy_version,''), '') end;
  if v_pv <> '' and v_pv !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'privacy'); end if;
  if v_lang !~ '^[a-z]{2}$' then v_lang := 'en'; end if;

  -- An older account without a gender or height keeps the ones given here; a flagged height takes the new one.
  if c.gender is null or c.height is null or v_hflag then
    update customers set gender = coalesce(gender, v_gender), height = case when v_hflag then v_height else coalesce(height, v_height) end where id = p_id;
  end if;

  perform pg_advisory_xact_lock(hashtext('commapp:' || v_email));
  perform pg_advisory_xact_lock(hashtext('commapp:' || v_phone));
  select * into v_prev from community_applications x
   -- another account's application stays its own, whatever number or email it shares (20261005210200)
   where x.status = 'pending' and (x.customer_id = p_id or (x.customer_id is null and (lower(x.email) = v_email or x.phone = v_phone)))
   order by (x.customer_id = p_id) desc nulls last, (lower(x.email) = v_email) desc, x.created_at limit 1;
  if v_prev.id is not null then
    update community_applications set
      name = v_name, email = v_email, phone = v_phone, height = v_height, birth_date = v_birth,
      gender = v_gender, nationality = v_nat, bike_type = v_type, instagram = v_ig, linkedin = v_li,
      profession = v_prof, workplace = v_wp, heard_from = v_heard, own_bike = coalesce(v_own, own_bike),
      whatsapp_same = coalesce(v_wa_same, whatsapp_same), whatsapp = case when v_wa_same is null then whatsapp else v_wa end, lang = v_lang, privacy_version = v_pv,
      ride_news = coalesce(c.ride_news, false), customer_id = p_id,
      submissions = submissions + 1, updated_at = now()
     where id = v_prev.id;
  else
    insert into community_applications (name, email, phone, height, birth_date, gender, nationality,
      bike_type, instagram, linkedin, profession, workplace, heard_from, lang, privacy_version, ride_news, customer_id, own_bike, whatsapp_same, whatsapp)
    values (v_name, v_email, v_phone, v_height, v_birth, v_gender, v_nat, v_type, v_ig, v_li,
      v_prof, v_wp, v_heard, v_lang, v_pv, coalesce(c.ride_news, false), p_id, v_own, v_wa_same, v_wa);
  end if;
  -- The answers are the account's too (20261004140000).
  perform _community_app_to_account((select x.id from community_applications x
     where x.customer_id = p_id and x.status = 'pending' order by x.updated_at desc limit 1), true, null);
  -- The flagged fields the form answered are flags no more (20261025180000).
  if coalesce(array_length(c.fix_fields, 1), 0) > 0 then
    update customers set fix_fields = array(select f from unnest(fix_fields) f where not (f = any (array_remove(array[
        case when coalesce(v_birth,'') <> '' then 'birth_date' end,
        case when coalesce(v_nat,'') <> '' then 'nationality' end,
        case when v_ig <> '' then 'instagram' end,
        case when v_li <> '' then 'linkedin' end,
        case when coalesce(v_prof,'') <> '' then 'profession' end,
        case when coalesce(v_wp,'') <> '' then 'workplace' end,
        case when v_wa_same is not null then 'whatsapp' end,
        case when v_hflag then 'height' end,
        case when p->>'emergency_saved' = 'true' and coalesce(btrim(emergency_phone),'') <> '' then 'emergency' end
      ]::text[], null))))
     where id = p_id;
  end if;
  return jsonb_build_object('ok', true, 'updated', v_prev.id is not null);
end $function$;

do $chk$
declare f text;
begin
  foreach f in array array['public.customer_community_me(text,text)', 'public.customer_community_apply(text,text,jsonb)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and 'search_path=public, extensions' = any(coalesce(p.proconfig, '{}'))) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if not has_function_privilege('anon', f, 'execute') then raise exception '% lost its anon execute', f; end if;
  end loop;
  if position('''flags''' in (select prosrc from pg_proc where oid = 'public.customer_community_me(text,text)'::regprocedure)) = 0 then
    raise exception 'customer_community_me does not answer flags';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261025180000', 'community_form_have_account')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
