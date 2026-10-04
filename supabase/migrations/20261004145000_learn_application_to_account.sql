-- ============================================================================
-- What a learn-to-ride sign-up says about the person lands on their account, as 20261004140000 did for
-- community applications (the owner, 2026-10-04: "yes" to doing the same for learn to ride).
--
-- Why it did not: the form makes or signs in the account first (20260930170000) and the sign-up carries
-- customer_id, but the person's answers (date of birth, nationality, profession, company, Instagram,
-- LinkedIn) reached the account only when staff first scheduled a lesson, and only into blanks; an
-- answer to "Ask for changes" stayed on the sign-up; how they heard of us never replaced 'desk'.
--
-- What it does:
--   _learn_app_to_account(app, overwrite, fields): writes one sign-up's answers about the person onto the
--     account it belongs to (customer_id, through merges; a sign-up without an account touches nothing -
--     scheduling makes or finds one and then calls this). A "Me" learner's gender and height stand in for
--     the person's on older sign-ups. Only what the account forms accept is written: a height of 100 to
--     250 cm, a date of birth at least five years back. overwrite: the person's answer replaces the
--     account's (they just gave it, signed in, on a form prefilled from the account); otherwise it fills
--     only what the account lacks ('desk' and '' count as lacking). Name, email and mobile are never
--     written from a sign-up; learners other than the person never reach the account. Definer; nobody
--     may call it directly.
--   customer_learn_apply: writes the answers onto the account (overwrite) as it links the sign-up.
--   learn_fix_submit: writes the fields the person was asked to change (overwrite, those only).
--   staff_learn_schedule: fills what the account still lacks, on every scheduling.
--   Once: every sign-up ever sent fills its account, newest first, blanks only.
--
-- Functions are patched in place from their live definitions (pg_get_functiondef keeps SECURITY DEFINER
-- and the search_path; create or replace keeps grants); each patch must change the text or it stops.
-- Rollback: re-run the three functions from 20260930170000 (customer_learn_apply, staff_learn_schedule)
-- and 20260930190000 (learn_fix_submit), drop _learn_app_to_account. The backfilled values stay (they
-- are the person's own answers). Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function public._learn_app_to_account(p_app uuid, p_overwrite boolean, p_fields text[] default null)
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  a        learn_applications%rowtype;
  c        customers%rowtype;
  f        text[];
  v_hops   int := 0;
  v_soc    jsonb;
  v_gender text;
  v_height int;
  v_birth  text;
  v_bd     date;
begin
  select * into a from learn_applications where id = p_app;
  if a.id is null or a.customer_id is null then return null; end if;
  select * into c from customers where id = a.customer_id;
  while c.id is not null and c.merged_into is not null and v_hops < 5 loop
    select * into c from customers where id = c.merged_into;
    v_hops := v_hops + 1;
  end loop;
  if c.id is null then return null; end if;

  f := coalesce(p_fields, array['birth_date','nationality','gender','height','profession','workplace',
                                'instagram','linkedin','heard_from']);

  -- The person's own answers; a "Me" learner's on sign-ups from before the person was asked.
  v_gender := coalesce(nullif(a.gender, ''), case when a.for_whom = 'self' then nullif(a.learner_gender, '') end);
  if v_gender not in ('male','female') then v_gender := null; end if;
  v_height := coalesce(a.height, case when a.for_whom = 'self' then a.learner_height end);
  if v_height is null or v_height < 100 or v_height > 250 then v_height := null; end if;
  -- A date of birth the account accepts: a real date, at least five years back.
  v_birth := btrim(coalesce(a.birth_date, ''));
  begin v_bd := v_birth::date; exception when others then v_bd := null; end;
  if v_bd is null or v_birth !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or v_bd > ((now() at time zone 'Asia/Riyadh')::date - interval '5 years')::date then
    v_birth := null;
  end if;

  v_soc := coalesce(c.socials, '{}'::jsonb);
  if 'instagram' = any(f) and coalesce(a.instagram, '') <> '' and (p_overwrite or coalesce(v_soc->>'instagram', '') = '') then
    v_soc := v_soc || jsonb_build_object('instagram', a.instagram);
  end if;
  if 'linkedin' = any(f) and coalesce(a.linkedin, '') <> '' and (p_overwrite or coalesce(v_soc->>'linkedin', '') = '') then
    v_soc := v_soc || jsonb_build_object('linkedin', a.linkedin);
  end if;

  update customers set
    birth_date  = case when 'birth_date' = any(f) and v_birth is not null
                        and (p_overwrite or coalesce(birth_date, '') = '') then v_birth else birth_date end,
    nationality = case when 'nationality' = any(f) and coalesce(a.nationality, '') <> ''
                        and (p_overwrite or coalesce(nationality, '') = '') then a.nationality else nationality end,
    gender      = case when 'gender' = any(f) and v_gender is not null
                        and (p_overwrite or coalesce(gender, '') = '') then v_gender else gender end,
    height      = case when 'height' = any(f) and v_height is not null
                        and (p_overwrite or height is null) then v_height else height end,
    profession  = case when 'profession' = any(f) and coalesce(btrim(a.profession), '') <> ''
                        and (p_overwrite or coalesce(btrim(profession), '') = '') then a.profession else profession end,
    workplace   = case when 'workplace' = any(f) and coalesce(btrim(a.workplace), '') <> ''
                        and (p_overwrite or coalesce(btrim(workplace), '') = '') then a.workplace else workplace end,
    heard_from  = case when 'heard_from' = any(f) and a.heard_from is not null
                        and (p_overwrite or heard_from is null or heard_from = 'desk') then a.heard_from else heard_from end,
    socials     = case when v_soc is distinct from coalesce(c.socials, '{}'::jsonb) then v_soc else socials end
   where id = c.id;
  return c.id;
end
$function$;

revoke all on function public._learn_app_to_account(uuid, boolean, text[]) from public, anon, authenticated;

do $patch$
declare d text; n text;
begin
  -- customer_learn_apply: the answers go onto the account as the sign-up is linked to it.
  d := pg_get_functiondef('public.customer_learn_apply(text,text,jsonb)'::regprocedure);
  if position('_learn_app_to_account' in d) = 0 then
    n := replace(d, E'  r        jsonb;\nbegin', E'  r        jsonb;\n  v_app    uuid;\nbegin');
    n := replace(n, E'                  order by x.updated_at desc limit 1);\n',
                    E'                  order by x.updated_at desc limit 1)\n'
                 || E'     returning id into v_app;\n'
                 || E'    perform _learn_app_to_account(v_app, true, null);  -- the answers are the account''s too (20261004145000)\n');
    if position(E'  v_app    uuid;\nbegin' in n) = 0 or position('returning id into v_app;' in n) = 0
       or position('perform _learn_app_to_account(v_app, true, null);' in n) = 0 then
      raise exception 'customer_learn_apply is not the definition this migration expects';
    end if;
    execute n;
  end if;

  -- learn_fix_submit: the changed fields go onto the account too.
  d := pg_get_functiondef('public.learn_fix_submit(text,jsonb)'::regprocedure);
  if position('_learn_app_to_account' in d) = 0 then
    n := replace(d, E'   where id = a.id;\n  return jsonb_build_object(''ok'', true);',
                    E'   where id = a.id;\n'
                 || E'  perform _learn_app_to_account(a.id, true, a.fix_fields);  -- 20261004145000\n'
                 || E'  return jsonb_build_object(''ok'', true);');
    if n = d then raise exception 'learn_fix_submit is not the definition this migration expects'; end if;
    execute n;
  end if;

  -- staff_learn_schedule: fill what the account still lacks, on every scheduling ('' handles, 'desk').
  d := pg_get_functiondef('public.staff_learn_schedule(uuid,timestamp with time zone,text,text)'::regprocedure);
  if position('_learn_app_to_account' in d) = 0 then
    n := replace(d, E'   returning * into a;\n  return jsonb_build_object(',
                    E'   returning * into a;\n'
                 || E'  perform _learn_app_to_account(a.id, false, null);  -- 20261004145000\n'
                 || E'  return jsonb_build_object(');
    if n = d then raise exception 'staff_learn_schedule is not the definition this migration expects'; end if;
    execute n;
  end if;
end $patch$;

-- Once: every sign-up ever sent fills its account, newest first (so the latest answer wins a blank).
do $backfill$
declare r record; n int := 0;
begin
  for r in select id from learn_applications where customer_id is not null order by updated_at desc, created_at desc loop
    if public._learn_app_to_account(r.id, false, null) is not null then n := n + 1; end if;
  end loop;
  raise notice 'learn-to-ride sign-ups written to their accounts: %', n;
end $backfill$;

do $chk$
begin
  if not (select bool_and(prosecdef) from pg_proc where oid in (
      'public._learn_app_to_account(uuid,boolean,text[])'::regprocedure,
      'public.customer_learn_apply(text,text,jsonb)'::regprocedure,
      'public.learn_fix_submit(text,jsonb)'::regprocedure,
      'public.staff_learn_schedule(uuid,timestamp with time zone,text,text)'::regprocedure)) then
    raise exception 'a learn-to-ride function lost SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', 'public._learn_app_to_account(uuid,boolean,text[])', 'execute')
     or has_function_privilege('authenticated', 'public._learn_app_to_account(uuid,boolean,text[])', 'execute') then
    raise exception '_learn_app_to_account must not be callable by clients';
  end if;
  if not has_function_privilege('anon', 'public.learn_fix_submit(text,jsonb)', 'execute')
     or not has_function_privilege('anon', 'public.customer_learn_apply(text,text,jsonb)', 'execute') then
    raise exception 'a learn-to-ride function lost its anon grant';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261004145000', 'learn_application_to_account')
on conflict (version) do nothing;

commit;
