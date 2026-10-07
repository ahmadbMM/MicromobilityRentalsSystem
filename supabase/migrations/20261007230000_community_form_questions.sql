-- ============================================================================
-- The membership form's questions, as admins set them (the owner, 2026-10-07: "add more customization in it" to
-- the applications, form questions among the choices: on or off, required or optional, the wording).
--
-- Staff keep the settings in site_content 'community.form' as {q:{<question>:{on,req,label:{<lang>:text}}}};
-- the website's form reads them as it opens. Here the server learns them too: customer_community_apply refused
-- an application with any of these left empty, so a question turned off or made optional could never be sent.
--   birth_date, nationality, profession, workplace, bike_type, heard_from: required unless set otherwise;
--   own_bike: optional unless set required (a form from before it sends nothing);
--   instagram, linkedin: optional unless set required.
-- A question that is answered is checked as before, whatever its setting.
--
-- The function is patched, not rewritten: its text is read back (pg_get_functiondef keeps SECURITY DEFINER and
-- search_path) and each change replaces one known line, so another session's change to the same function
-- (the WhatsApp number, 20261007200000) is kept. Every line must be found once, or nothing is saved.
-- Four answers the application must now be able to leave empty lose NOT NULL; their checks already pass NULL.
--
-- Idempotent: a function already patched (it names _community_q_req) is left as it is.
-- ============================================================================

begin;

-- What the settings say of one question: off -> not required; else its own req, else the default.
create or replace function public._community_q_req(p_cfg jsonb, p_key text, p_default boolean)
returns boolean language sql immutable set search_path = public as $$
  select case
    when p_cfg is null or jsonb_typeof(p_cfg -> p_key) is distinct from 'object' then p_default
    when (p_cfg -> p_key ->> 'on') = 'false' then false
    when (p_cfg -> p_key ->> 'req') in ('true', 'false') then (p_cfg -> p_key ->> 'req')::boolean
    else p_default end
$$;
revoke all on function public._community_q_req(jsonb, text, boolean) from public, anon, authenticated;

alter table public.community_applications alter column birth_date drop not null;
alter table public.community_applications alter column nationality drop not null;
alter table public.community_applications alter column bike_type drop not null;
alter table public.community_applications alter column profession drop not null;

do $mig$
declare
  d text := pg_get_functiondef('public.customer_community_apply(text,text,jsonb)'::regprocedure);
  n text;
  a text[];
  i int;
begin
  if position('_community_q_req' in d) > 0 then
    raise notice 'customer_community_apply already reads the form settings';
    return;
  end if;
  n := d;
  -- pairs: the line as it is, the line it becomes
  a := array[
    -- the settings, read once
    $x$  v_name   text;
$x$,
    $x$  v_cfg    jsonb := coalesce((select sc.value -> 'q' from site_content sc where sc.key = 'community.form'), '{}'::jsonb);
  v_name   text;
$x$,
    -- birth date: empty and not required -> none
    $x$  begin v_bd := v_birth::date; exception when others then v_bd := null; end;
$x$,
    $x$  if v_birth = '' and not _community_q_req(v_cfg, 'birth_date', true) then v_birth := null; else
  begin v_bd := v_birth::date; exception when others then v_bd := null; end;
$x$,
    $x$    return jsonb_build_object('ok', false, 'error', 'birth_date'); end if;
$x$,
    $x$    return jsonb_build_object('ok', false, 'error', 'birth_date'); end if;
  end if;
$x$,
    $x$  if v_nat = '' or length(v_nat) > 60$x$,
    $x$  if v_nat = '' and not _community_q_req(v_cfg, 'nationality', true) then v_nat := null;
  elsif v_nat = '' or length(v_nat) > 60$x$,
    $x$  if v_type not in ('Road','Hybrid','Mountain','Own') then$x$,
    $x$  if v_type = '' and not _community_q_req(v_cfg, 'bike_type', true) then v_type := null;
  elsif v_type not in ('Road','Hybrid','Mountain','Own') then$x$,
    $x$  if v_ig <> '' and v_ig !~$x$,
    $x$  if v_ig = '' and _community_q_req(v_cfg, 'instagram', false) then return jsonb_build_object('ok', false, 'error', 'instagram'); end if;
  if v_ig <> '' and v_ig !~$x$,
    $x$  if v_li <> '' and v_li !~$x$,
    $x$  if v_li = '' and _community_q_req(v_cfg, 'linkedin', false) then return jsonb_build_object('ok', false, 'error', 'linkedin'); end if;
  if v_li <> '' and v_li !~$x$,
    $x$  if length(v_prof) < 2 or length(v_prof) > 80$x$,
    $x$  if v_prof = '' and not _community_q_req(v_cfg, 'profession', true) then v_prof := null;
  elsif length(v_prof) < 2 or length(v_prof) > 80$x$,
    $x$  if length(v_wp) < 2 or length(v_wp) > 120$x$,
    $x$  if v_wp = '' and not _community_q_req(v_cfg, 'workplace', true) then v_wp := null;
  elsif length(v_wp) < 2 or length(v_wp) > 120$x$,
    $x$  if v_heard is null or v_heard not in ($x$,
    $x$  if v_heard is null and not _community_q_req(v_cfg, 'heard_from', true) then null;
  elsif v_heard is null or v_heard not in ($x$,
    $x$  if p ? 'own_bike' then$x$,
    $x$  if not (p ? 'own_bike') and _community_q_req(v_cfg, 'own_bike', false) then
    return jsonb_build_object('ok', false, 'error', 'own_bike'); end if;
  if p ? 'own_bike' then$x$
  ];
  for i in 1 .. array_length(a, 1) by 2 loop
    if (length(n) - length(replace(n, a[i], ''))) / length(a[i]) <> 1 then
      raise exception 'customer_community_apply: expected exactly one of: %', left(a[i], 70);
    end if;
    n := replace(n, a[i], a[i + 1]);
  end loop;
  execute n;
end $mig$;

do $chk$
begin
  if position('_community_q_req' in pg_get_functiondef('public.customer_community_apply(text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'customer_community_apply was not patched';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.customer_community_apply(text,text,jsonb)'::regprocedure) then
    raise exception 'customer_community_apply lost SECURITY DEFINER';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261007230000', 'community_form_questions')
on conflict (version) do nothing;

commit;

-- Verify (read-only):
--   select position('_community_q_req' in pg_get_functiondef('public.customer_community_apply(text,text,jsonb)'::regprocedure)) > 0 as patched,
--          (select prosecdef from pg_proc where oid = 'public.customer_community_apply(text,text,jsonb)'::regprocedure) as definer,
--          (select count(*) from information_schema.columns where table_name = 'community_applications'
--             and column_name in ('birth_date','nationality','bike_type','profession') and is_nullable = 'YES') as nullable_4;
