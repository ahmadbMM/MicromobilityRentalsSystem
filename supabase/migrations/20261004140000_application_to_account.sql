-- ============================================================================
-- What a community application says lands on the applicant's account (the owner, 2026-10-04: "why isnt
-- all info entered in community application not reflected in the account of the applicant for example
-- own bike does not reflect as bike owner and company and profession doesnt reflect too ... make sure to
-- reflect everyone who has ever filled the form to his account even previous applications").
--
-- Why it did not:
--   1. The form makes the account first (20260930160000) and the application carries customer_id, but
--      nothing reached the account until staff approved it - 41 pending applicants' accounts had no
--      profession, company, birth date, nationality, handles or how they heard of us.
--   2. "Do you have your own bike?" (own_bike) was never written anywhere on the account; only the
--      bike type was, and only at approval, and only from 2026-10-02 (20261002180000).
--   3. staff_sync never handed staff the profession or the company, so the account editor showed them
--      empty - and saving the editor wrote them back empty (the app side is fixed with this migration).
--   4. An approval kept a desk-made account's heard_from 'desk', and skipped a handle stored as ''.
--   5. An applicant's answer to "Ask for changes" stayed on the application.
--
-- What it does:
--   _community_app_to_account(app, overwrite, fields): writes one application's answers onto the account
--     it belongs to (customer_id, through merges; an application without an account touches nothing -
--     approval makes or finds one and then calls this). own_bike yes = bike type Bike owner (Own).
--     overwrite: the applicant's answer replaces the account's (they just gave it, signed in as that
--     account); otherwise it fills only what the account lacks ('desk' and '' count as lacking, and a
--     bike type still Any or still the application's own type becomes Bike owner when they own one).
--     Name, email and mobile are never written from an application. Definer; nobody may call it directly.
--   customer_community_apply: writes the answers onto the account (overwrite) as it stores them.
--   community_fix_submit: writes the fields the applicant was asked to change (overwrite, those only).
--   staff_community_approve: fills the account the same way after its own copy (fill only).
--   customer_community_me: an account already on Bike owner offers it back to the form.
--   staff_sync: hands staff profession and workplace (the app bumps its sync copy to read them).
--   Once: every application ever sent, newest first, fills its account (fill only, so nothing a rider
--     or staff typed on the account since is overwritten).
--
-- Functions are patched in place from their live definitions (pg_get_functiondef keeps SECURITY DEFINER
-- and the search_path; create or replace keeps grants); each patch must change the text or it stops.
-- Rollback: re-run the four functions from 20261002180000 / 20260930210000 / 20260929100000 /
-- 20260924230000 (staff_sync), drop _community_app_to_account. The backfilled values stay (they are the
-- riders' own answers). Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function public._community_app_to_account(p_app uuid, p_overwrite boolean, p_fields text[] default null)
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  a      community_applications%rowtype;
  c      customers%rowtype;
  f      text[];
  v_hops int := 0;
  v_soc  jsonb;
  v_type text;
begin
  select * into a from community_applications where id = p_app;
  if a.id is null or a.customer_id is null then return null; end if;
  select * into c from customers where id = a.customer_id;
  while c.id is not null and c.merged_into is not null and v_hops < 5 loop
    select * into c from customers where id = c.merged_into;
    v_hops := v_hops + 1;
  end loop;
  if c.id is null then return null; end if;

  f := coalesce(p_fields, array['birth_date','nationality','gender','height','profession','workplace',
                                'instagram','linkedin','heard_from','bike_type','own_bike']);

  v_soc := coalesce(c.socials, '{}'::jsonb);
  if 'instagram' = any(f) and coalesce(a.instagram, '') <> '' and (p_overwrite or coalesce(v_soc->>'instagram', '') = '') then
    v_soc := v_soc || jsonb_build_object('instagram', a.instagram);
  end if;
  if 'linkedin' = any(f) and coalesce(a.linkedin, '') <> '' and (p_overwrite or coalesce(v_soc->>'linkedin', '') = '') then
    v_soc := v_soc || jsonb_build_object('linkedin', a.linkedin);
  end if;

  -- Their own bike is the Bike owner type; otherwise the type they picked.
  if 'own_bike' = any(f) and a.own_bike is true then v_type := 'Own';
  elsif 'bike_type' = any(f) or 'own_bike' = any(f) then
    v_type := case when a.bike_type in ('Road','Hybrid','Mountain','Own') then a.bike_type end;
  end if;

  update customers set
    birth_date  = case when 'birth_date' = any(f) and coalesce(a.birth_date, '') <> ''
                        and (p_overwrite or coalesce(birth_date, '') = '') then a.birth_date else birth_date end,
    nationality = case when 'nationality' = any(f) and coalesce(a.nationality, '') <> ''
                        and (p_overwrite or coalesce(nationality, '') = '') then a.nationality else nationality end,
    gender      = case when 'gender' = any(f) and a.gender in ('male','female')
                        and (p_overwrite or coalesce(gender, '') = '') then a.gender else gender end,
    height      = case when 'height' = any(f) and a.height between 100 and 250
                        and (p_overwrite or height is null) then a.height else height end,
    profession  = case when 'profession' = any(f) and coalesce(btrim(a.profession), '') <> ''
                        and (p_overwrite or coalesce(btrim(profession), '') = '') then a.profession else profession end,
    workplace   = case when 'workplace' = any(f) and coalesce(btrim(a.workplace), '') <> ''
                        and (p_overwrite or coalesce(btrim(workplace), '') = '') then a.workplace else workplace end,
    heard_from  = case when 'heard_from' = any(f) and a.heard_from is not null
                        and (p_overwrite or heard_from is null or heard_from = 'desk') then a.heard_from else heard_from end,
    socials     = case when v_soc is distinct from coalesce(c.socials, '{}'::jsonb) then v_soc else socials end,
    type_preference = case
      when v_type is null then type_preference
      when p_overwrite and not (type_preference = 'Road Carbon' and v_type = 'Road') then v_type
      when coalesce(nullif(type_preference, ''), 'Any') = 'Any' then v_type
      when v_type = 'Own' and type_preference = a.bike_type then 'Own'
      else type_preference end
   where id = c.id;
  return c.id;
end
$function$;

revoke all on function public._community_app_to_account(uuid, boolean, text[]) from public, anon, authenticated;

do $patch$
declare d text; n text;
begin
  -- customer_community_apply: the answers go onto the account as they are stored.
  d := pg_get_functiondef('public.customer_community_apply(text,text,jsonb)'::regprocedure);
  if position('_community_app_to_account' in d) = 0 then
    n := replace(d, E'  return jsonb_build_object(''ok'', true, ''updated'', v_prev.id is not null);',
                    E'  -- The answers are the account''s too (20261004140000).\n'
                 || E'  perform _community_app_to_account((select x.id from community_applications x\n'
                 || E'     where x.customer_id = p_id and x.status = ''pending'' order by x.updated_at desc limit 1), true, null);\n'
                 || E'  return jsonb_build_object(''ok'', true, ''updated'', v_prev.id is not null);');
    if n = d then raise exception 'customer_community_apply is not the definition this migration expects'; end if;
    execute n;
  end if;

  -- community_fix_submit: the changed fields go onto the account too.
  d := pg_get_functiondef('public.community_fix_submit(text,jsonb)'::regprocedure);
  if position('_community_app_to_account' in d) = 0 then
    n := replace(d, E'   where id = a.id;\n  return jsonb_build_object(''ok'', true);',
                    E'   where id = a.id;\n'
                 || E'  perform _community_app_to_account(a.id, true, a.fix_fields);  -- 20261004140000\n'
                 || E'  return jsonb_build_object(''ok'', true);');
    if n = d then raise exception 'community_fix_submit is not the definition this migration expects'; end if;
    execute n;
  end if;

  -- staff_community_approve: fill what the account still lacks (own bike, '' handles, 'desk').
  d := pg_get_functiondef('public.staff_community_approve(uuid,text,boolean)'::regprocedure);
  if position('_community_app_to_account' in d) = 0 then
    n := replace(d, E'\n  select * into c from customers where id = v_id;\n',
                    E'\n  perform _community_app_to_account(a.id, false, null);  -- 20261004140000\n'
                 || E'  select * into c from customers where id = v_id;\n');
    if n = d then raise exception 'staff_community_approve is not the definition this migration expects'; end if;
    execute n;
  end if;

  -- customer_community_me: an account on Bike owner hands it back to the form.
  d := pg_get_functiondef('public.customer_community_me(text,text)'::regprocedure);
  if position('''Mountain'',''Own'')' in d) = 0 then
    n := replace(d, E'c.type_preference in (''Road'',''Hybrid'',''Mountain'') then',
                    E'c.type_preference in (''Road'',''Hybrid'',''Mountain'',''Own'') then');
    n := replace(n, E'''own_bike'', a.own_bike);',
                    E'''own_bike'', coalesce(a.own_bike, case when c.type_preference = ''Own'' then true end));');
    if position('''Mountain'',''Own'')' in n) = 0 or position('when c.type_preference = ''Own'' then true' in n) = 0 then
      raise exception 'customer_community_me is not the definition this migration expects';
    end if;
    execute n;
  end if;

  -- staff_sync: staff see profession and company (the editor read them as empty and saved them empty).
  d := pg_get_functiondef('public.staff_sync(text,timestamp with time zone,text)'::regprocedure);
  if position('''profession'', c.profession' in d) = 0 then
    n := replace(d, E'''heard_from'', c.heard_from)',
                    E'''heard_from'', c.heard_from, ''profession'', c.profession, ''workplace'', c.workplace)');
    if n = d then raise exception 'staff_sync is not the definition this migration expects'; end if;
    execute n;
  end if;
end $patch$;

-- Once: every application ever sent fills its account, newest first (so the latest answer wins a blank).
do $backfill$
declare r record; n int := 0;
begin
  for r in select id from community_applications where customer_id is not null order by updated_at desc, created_at desc loop
    if public._community_app_to_account(r.id, false, null) is not null then n := n + 1; end if;
  end loop;
  raise notice 'applications written to their accounts: %', n;
end $backfill$;

do $chk$
begin
  if not (select bool_and(prosecdef) from pg_proc where oid in (
      'public._community_app_to_account(uuid,boolean,text[])'::regprocedure,
      'public.customer_community_apply(text,text,jsonb)'::regprocedure,
      'public.community_fix_submit(text,jsonb)'::regprocedure,
      'public.staff_community_approve(uuid,text,boolean)'::regprocedure,
      'public.customer_community_me(text,text)'::regprocedure)) then
    raise exception 'an application function lost SECURITY DEFINER';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.staff_sync(text,timestamp with time zone,text)'::regprocedure) then
    raise exception 'staff_sync must stay invoker';
  end if;
  if has_function_privilege('anon', 'public._community_app_to_account(uuid,boolean,text[])', 'execute')
     or has_function_privilege('authenticated', 'public._community_app_to_account(uuid,boolean,text[])', 'execute') then
    raise exception '_community_app_to_account must not be callable by clients';
  end if;
  if not has_function_privilege('anon', 'public.community_fix_submit(text,jsonb)', 'execute') then
    raise exception 'community_fix_submit lost its anon grant';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261004140000', 'application_to_account')
on conflict (version) do nothing;

commit;
