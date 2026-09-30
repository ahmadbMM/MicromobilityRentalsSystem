-- ============================================================================
-- A community application can be asked for its company (workplace) too (the owner, 2026-09-30,
-- after learn-to-ride got Ask for changes with it). The form asks the company since 20260929110000,
-- but staff_community_ask_changes, community_fix_get and community_fix_submit (20260929100000) did
-- not know the field. Each is its live definition (md5 checked against production before editing:
-- 1f3c77c6, 5d021c92, 69d24c76) with workplace added: asked for, it must be 2 to 120 characters
-- without <>"`{} (community_apply's rule), and what it replaces is kept in fix_prev. Security
-- definer, search_path and grants are unchanged (create or replace keeps the grants).
--
-- Rollback: re-run the three functions from 20260929100000_application_changes.sql.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

-- Staff only. Fields outside the list are dropped; the rest are kept in the page's order.
create or replace function public.staff_community_ask_changes(p_id uuid, p_fields text[], p_note text default null, p_by text default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare
  a      community_applications%rowtype;
  v_all  text[] := array['name','email','phone','birth_date','gender','nationality','height','bike_type','profession','workplace','instagram','linkedin'];
  v_f    text[];
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_tok  text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select array_agg(f order by array_position(v_all, f)) into v_f
    from (select distinct unnest(coalesce(p_fields, '{}'::text[])) as f) x
   where f = any(v_all);
  if v_f is null then return jsonb_build_object('ok', false, 'error', 'fields'); end if;
  if length(coalesce(v_note, '')) > 500 then return jsonb_build_object('ok', false, 'error', 'note'); end if;
  select * into a from community_applications where id = p_id for update;
  if a.id is null then return jsonb_build_object('ok', false, 'error', 'missing'); end if;
  if a.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'decided', 'status', a.status); end if;
  v_tok := encode(gen_random_bytes(18), 'hex');
  update community_applications set
    fix_token = v_tok, fix_fields = v_f, fix_note = v_note, fix_asked_at = now(),
    fix_asked_by = left(coalesce(nullif(trim(p_by), ''), 'staff'), 80),
    fix_done_at = null, fix_prev = null, updated_at = now()
   where id = a.id;
  return jsonb_build_object('ok', true, 'token', v_tok, 'fields', to_jsonb(v_f), 'note', v_note);
end $$;

-- The page's question: the fields asked, the note, and what the applicant sent for each.
create or replace function public.community_fix_get(p_token text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare a community_applications%rowtype; v jsonb := '{}'::jsonb; f text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{36}$' then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if not _ip_gate('commfix', 60, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  select * into a from community_applications where fix_token = p_token;
  if a.id is null or a.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if a.fix_done_at is not null then return jsonb_build_object('ok', false, 'error', 'done', 'lang', a.lang); end if;
  foreach f in array a.fix_fields loop
    v := v || jsonb_build_object(f, case f
      when 'name' then to_jsonb(a.name)               when 'email' then to_jsonb(a.email)
      when 'phone' then to_jsonb(a.phone)             when 'birth_date' then to_jsonb(a.birth_date)
      when 'gender' then to_jsonb(a.gender)           when 'nationality' then to_jsonb(a.nationality)
      when 'height' then to_jsonb(a.height)           when 'bike_type' then to_jsonb(a.bike_type)
      when 'profession' then to_jsonb(a.profession)   when 'instagram' then to_jsonb(a.instagram)
      when 'linkedin' then to_jsonb(a.linkedin)       when 'workplace' then to_jsonb(a.workplace) end);
  end loop;
  return jsonb_build_object('ok', true, 'first', split_part(btrim(a.name), ' ', 1), 'lang', a.lang,
    'fields', to_jsonb(a.fix_fields), 'note', a.fix_note, 'values', v);
end $$;

-- The applicant's answers: every field asked must come back valid (community_apply's rules; a
-- handle asked for may not be left empty), then they replace what was there.
create or replace function public.community_fix_submit(p_token text, p jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  a        community_applications%rowtype;
  v_prev   jsonb := '{}'::jsonb;
  v_name   text := regexp_replace(trim(coalesce(p->>'name', '')), '\s+', ' ', 'g');
  v_email  text := lower(trim(coalesce(p->>'email', '')));
  v_phone  text := trim(coalesce(p->>'phone', ''));
  v_height int;
  v_birth  text := trim(coalesce(p->>'birth_date', ''));
  v_bd     date;
  v_gender text := coalesce(p->>'gender', '');
  v_nat    text := trim(coalesce(p->>'nationality', ''));
  v_type   text := coalesce(p->>'bike_type', '');
  v_ig     text := regexp_replace(trim(coalesce(p->>'instagram', '')), '^@+', '');
  v_li     text := trim(coalesce(p->>'linkedin', ''));
  v_prof   text := regexp_replace(trim(coalesce(p->>'profession', '')), '\s+', ' ', 'g');
  v_wp     text := regexp_replace(trim(coalesce(p->>'workplace', '')), '\s+', ' ', 'g');
  v_today  date := (now() at time zone 'Asia/Riyadh')::date;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{36}$' then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if not _ip_gate('commfix', 20, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  if p is null or jsonb_typeof(p) <> 'object' then return jsonb_build_object('ok', false, 'error', 'input'); end if;
  select * into a from community_applications where fix_token = p_token for update;
  if a.id is null or a.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if a.fix_done_at is not null then return jsonb_build_object('ok', false, 'error', 'done'); end if;

  if 'name' = any(a.fix_fields) and (v_name = '' or length(v_name) > 120 or v_name !~ '\s'
      or not _name_chars_ok(v_name) or not _name_parts_ok(v_name)) then
    return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if 'email' = any(a.fix_fields) and (length(v_email) > 254
      or v_email !~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$') then
    return jsonb_build_object('ok', false, 'error', 'email'); end if;
  if 'phone' = any(a.fix_fields) and (v_phone !~ '^\+[1-9][0-9]{7,14}$'
      or (v_phone like '+966%' and v_phone !~ '^\+9665[0-9]{8}$')) then
    return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if 'height' = any(a.fix_fields) then
    begin v_height := nullif(regexp_replace(coalesce(p->>'height', ''), '\D', '', 'g'), '')::int;
    exception when others then v_height := null; end;
    if v_height is null or v_height < 100 or v_height > 250 then
      return jsonb_build_object('ok', false, 'error', 'height'); end if;
  end if;
  if 'birth_date' = any(a.fix_fields) then
    begin v_bd := v_birth::date; exception when others then v_bd := null; end;
    if v_bd is null or v_birth !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or v_bd > v_today
       or v_bd > (v_today - interval '5 years')::date or v_bd < date '1900-01-01' then
      return jsonb_build_object('ok', false, 'error', 'birth_date'); end if;
  end if;
  if 'gender' = any(a.fix_fields) and v_gender not in ('male', 'female') then
    return jsonb_build_object('ok', false, 'error', 'gender'); end if;
  if 'nationality' = any(a.fix_fields) and (v_nat = '' or length(v_nat) > 60 or v_nat ~ '[<>"`]') then
    return jsonb_build_object('ok', false, 'error', 'nationality'); end if;
  if 'bike_type' = any(a.fix_fields) and v_type not in ('Road', 'Hybrid', 'Mountain') then
    return jsonb_build_object('ok', false, 'error', 'bike_type'); end if;
  if 'instagram' = any(a.fix_fields) and v_ig !~ '^[A-Za-z0-9._]{1,30}$' then
    return jsonb_build_object('ok', false, 'error', 'instagram'); end if;
  if 'linkedin' = any(a.fix_fields) and v_li !~ '^[A-Za-z0-9._%-]{3,100}$' then
    return jsonb_build_object('ok', false, 'error', 'linkedin'); end if;
  if 'profession' = any(a.fix_fields) and (length(v_prof) < 2 or length(v_prof) > 80 or v_prof ~ '[<>"`{}]') then
    return jsonb_build_object('ok', false, 'error', 'profession'); end if;
  if 'workplace' = any(a.fix_fields) and (length(v_wp) < 2 or length(v_wp) > 120 or v_wp ~ '[<>"`{}]') then
    return jsonb_build_object('ok', false, 'error', 'workplace'); end if;

  v_prev := jsonb_strip_nulls(jsonb_build_object(
    'name',        case when 'name'        = any(a.fix_fields) then to_jsonb(a.name) end,
    'email',       case when 'email'       = any(a.fix_fields) then to_jsonb(a.email) end,
    'phone',       case when 'phone'       = any(a.fix_fields) then to_jsonb(a.phone) end,
    'birth_date',  case when 'birth_date'  = any(a.fix_fields) then to_jsonb(a.birth_date) end,
    'gender',      case when 'gender'      = any(a.fix_fields) then to_jsonb(a.gender) end,
    'nationality', case when 'nationality' = any(a.fix_fields) then to_jsonb(a.nationality) end,
    'height',      case when 'height'      = any(a.fix_fields) then to_jsonb(a.height) end,
    'bike_type',   case when 'bike_type'   = any(a.fix_fields) then to_jsonb(a.bike_type) end,
    'profession',  case when 'profession'  = any(a.fix_fields) then to_jsonb(a.profession) end,
    'instagram',   case when 'instagram'   = any(a.fix_fields) then to_jsonb(coalesce(a.instagram, '')) end,
    'linkedin',    case when 'linkedin'    = any(a.fix_fields) then to_jsonb(coalesce(a.linkedin, '')) end,
    'workplace',   case when 'workplace'   = any(a.fix_fields) then to_jsonb(coalesce(a.workplace, '')) end));

  update community_applications set
    name        = case when 'name'        = any(a.fix_fields) then v_name   else name end,
    email       = case when 'email'       = any(a.fix_fields) then v_email  else email end,
    phone       = case when 'phone'       = any(a.fix_fields) then v_phone  else phone end,
    birth_date  = case when 'birth_date'  = any(a.fix_fields) then v_birth  else birth_date end,
    gender      = case when 'gender'      = any(a.fix_fields) then v_gender else gender end,
    nationality = case when 'nationality' = any(a.fix_fields) then v_nat    else nationality end,
    height      = case when 'height'      = any(a.fix_fields) then v_height else height end,
    bike_type   = case when 'bike_type'   = any(a.fix_fields) then v_type   else bike_type end,
    profession  = case when 'profession'  = any(a.fix_fields) then v_prof   else profession end,
    instagram   = case when 'instagram'   = any(a.fix_fields) then v_ig     else instagram end,
    linkedin    = case when 'linkedin'    = any(a.fix_fields) then v_li     else linkedin end,
    workplace   = case when 'workplace'   = any(a.fix_fields) then v_wp     else workplace end,
    fix_done_at = now(), fix_prev = v_prev, updated_at = now()
   where id = a.id;
  return jsonb_build_object('ok', true);
end $$;

commit;
