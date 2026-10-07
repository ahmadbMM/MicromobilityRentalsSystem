-- ============================================================================
-- WhatsApp number, the rest (the owner, 2026-10-07: "add them all"), after 20261007200000:
--
--  1. customer_set_whatsapp(p_id, p_token, p_same, p_phone): My Account changes the answer. p_same true =
--     the mobile (needs one on the account); false = p_phone, +<country><number>; a number that is the
--     mobile's own is taken as "same". Refused: 'wa_phone' / 'wa_no_mobile' (22023). Answering also ends a
--     staff flag on it (fix_fields loses 'whatsapp'; the pending customer_flags row records the change).
--  2. Ask for changes on a community application offers it: staff_community_ask_changes takes 'whatsapp';
--     community_fix_get hands back {same, phone, mobile}; community_fix_submit takes whatsapp_same (+ whatsapp),
--     keeps the old answer in fix_prev, and _community_app_to_account carries it to the account.
--  3. The learn-to-ride sign-up asks it: learn_applications.whatsapp_same / whatsapp; customer_learn_apply
--     takes them (a page from before sends neither) and _learn_app_to_account copies them to the account;
--     its Ask for changes offers it as the community one does (staff_learn_ask_changes, learn_fix_get,
--     learn_fix_submit).
--
-- Every function is patched in place from its live definition (definer, search_path and grants stay);
-- each anchor must match exactly once. Idempotent: a function carrying '(20261007223000)' is skipped.
-- Rollback: drop function public.customer_set_whatsapp(text,text,boolean,text); run the patches backwards;
-- drop learn_applications.whatsapp_same / whatsapp.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

create or replace function pg_temp._patch(sig text, ab text[]) returns void language plpgsql as $f$
declare d text; i int;
begin
  d := pg_get_functiondef(sig::regprocedure);
  if position('(20261007223000)' in d) > 0 then
    raise notice '% is already patched; nothing to do', sig;
    return;
  end if;
  for i in 1 .. array_length(ab, 1) by 2 loop
    d := pg_temp._once(d, ab[i], ab[i + 1]);
  end loop;
  execute d;
end $f$;


-- ── 1. My Account ───────────────────────────────────────────────────────────────────────────
create or replace function public.customer_set_whatsapp(p_id text, p_token text, p_same boolean, p_phone text default null)
returns boolean
language plpgsql security definer
set search_path to 'public', 'extensions'
as $function$
declare
  c   customers%rowtype;
  n   customers%rowtype;
  own text;
  ph  text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
begin
  -- My Account's WhatsApp number (20261007223000).
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if p_same is null then raise exception 'wa_phone' using errcode = '22023'; end if;
  select * into c from customers where customers.id = p_id for update;
  if not found then return false; end if;
  own := regexp_replace(coalesce(c.phone, ''), '\D', '', 'g');
  if not p_same and ph is not null and own <> '' and right(regexp_replace(ph, '\D', '', 'g'), 9) = right(own, 9) then
    p_same := true;
  end if;
  if p_same then
    if own = '' then raise exception 'wa_no_mobile' using errcode = '22023'; end if;
    update customers set whatsapp_same = true, whatsapp = null where id = p_id;
  else
    if ph is null or ph !~ '^\+?[0-9]{8,15}$' then raise exception 'wa_phone' using errcode = '22023'; end if;
    update customers set whatsapp_same = false, whatsapp = ph where id = p_id;
  end if;
  -- an answer to a staff flag on it, as the check-up's would be
  if 'whatsapp' = any(coalesce(c.fix_fields, '{}'::text[])) then
    update customers set fix_fields = nullif(array_remove(fix_fields, 'whatsapp'), '{}'::text[]) where id = p_id;
    select * into n from customers where customers.id = p_id;
    update customer_flags cf set
        changes = cf.changes || jsonb_build_object('whatsapp', jsonb_build_object(
          'before', case when c.whatsapp_same is null then null
                         else jsonb_build_object('same', c.whatsapp_same, 'phone', case when c.whatsapp_same then c.phone else c.whatsapp end) end,
          'after', jsonb_build_object('same', n.whatsapp_same, 'phone', case when n.whatsapp_same then n.phone else n.whatsapp end),
          'at', now())),
        status      = case when n.fix_fields is null then 'answered' else 'pending' end,
        answered_at = case when n.fix_fields is null then now() else null end
      where cf.customer_id = p_id and cf.status = 'pending' and 'whatsapp' = any(cf.fields);
  end if;
  return true;
end $function$;
revoke execute on function public.customer_set_whatsapp(text, text, boolean, text) from public;
grant  execute on function public.customer_set_whatsapp(text, text, boolean, text) to anon, authenticated;


-- ── 2. Ask for changes on a community application ───────────────────────────────────────────
select pg_temp._patch('public.staff_community_ask_changes(uuid,text[],text,text)', array[
$a$'profession','workplace','instagram','linkedin'];$a$,
$b$'profession','workplace','instagram','linkedin','whatsapp'];  -- WhatsApp (20261007223000)$b$]);

select pg_temp._patch('public.community_fix_get(text)', array[
$a$      when 'linkedin' then to_jsonb(a.linkedin)       when 'workplace' then to_jsonb(a.workplace) end);$a$,
$b$      when 'linkedin' then to_jsonb(a.linkedin)       when 'workplace' then to_jsonb(a.workplace)
      -- WhatsApp (20261007223000): {same, phone}, phone the number WhatsApp is on
      when 'whatsapp' then jsonb_build_object('same', a.whatsapp_same, 'phone', case when a.whatsapp_same then a.phone else a.whatsapp end,
                                              'mobile', a.phone) end);$b$]);

select pg_temp._patch('public.community_fix_submit(text,jsonb)', array[
$a$  v_today  date := (now() at time zone 'Asia/Riyadh')::date;
begin$a$,
$b$  v_today  date := (now() at time zone 'Asia/Riyadh')::date;
  -- WhatsApp (20261007223000)
  v_wa_same boolean := case when jsonb_typeof(p->'whatsapp_same') = 'boolean' then (p->>'whatsapp_same')::boolean end;
  v_wa     text := nullif(regexp_replace(coalesce(p->>'whatsapp', ''), '[^0-9+]', '', 'g'), '');
begin$b$,
$a$

  v_prev := jsonb_strip_nulls(jsonb_build_object($a$,
$b$
  if 'whatsapp' = any(a.fix_fields) then
    if v_wa_same is null or (not v_wa_same and (v_wa is null or v_wa !~ '^\+?[0-9]{8,15}$')) then
      return jsonb_build_object('ok', false, 'error', 'whatsapp'); end if;
    if not v_wa_same and right(regexp_replace(v_wa, '\D', '', 'g'), 9) = right(regexp_replace(coalesce(a.phone, ''), '\D', '', 'g'), 9) then
      v_wa_same := true; end if;
    if v_wa_same then v_wa := null; end if;
  end if;

  v_prev := jsonb_strip_nulls(jsonb_build_object($b$,
$a$    'workplace',   case when 'workplace'   = any(a.fix_fields) then to_jsonb(coalesce(a.workplace, '')) end));$a$,
$b$    'workplace',   case when 'workplace'   = any(a.fix_fields) then to_jsonb(coalesce(a.workplace, '')) end,
    'whatsapp',    case when 'whatsapp'    = any(a.fix_fields) and a.whatsapp_same is not null then
                     jsonb_build_object('same', a.whatsapp_same, 'phone', case when a.whatsapp_same then a.phone else a.whatsapp end) end));$b$,
$a$    fix_done_at = now(), fix_prev = v_prev, updated_at = now()$a$,
$b$    whatsapp_same = case when 'whatsapp' = any(a.fix_fields) then v_wa_same else whatsapp_same end,
    whatsapp      = case when 'whatsapp' = any(a.fix_fields) then v_wa      else whatsapp end,
    fix_done_at = now(), fix_prev = v_prev, updated_at = now()$b$]);


-- ── 3. Learn to ride ────────────────────────────────────────────────────────────────────────
alter table public.learn_applications add column if not exists whatsapp_same boolean;
alter table public.learn_applications add column if not exists whatsapp text;
alter table public.learn_applications drop constraint if exists learn_applications_whatsapp_shape;
alter table public.learn_applications add constraint learn_applications_whatsapp_shape
  check (whatsapp is null or whatsapp ~ '^\+?[0-9]{8,15}$');

select pg_temp._patch('public.customer_learn_apply(text,text,jsonb)', array[
$a$  v_app    uuid;
begin$a$,
$b$  v_app    uuid;
  v_wa_same boolean;  -- WhatsApp (20261007223000)
  v_wa     text;
begin$b$,
$a$  v_pv := coalesce(nullif(c.privacy_version, ''), p->>'privacy_version', '');$a$,
$b$  v_pv := coalesce(nullif(c.privacy_version, ''), p->>'privacy_version', '');
  -- Is the mobile their WhatsApp too, or which number is; a page from before sends nothing.
  if p ? 'whatsapp_same' then
    if jsonb_typeof(p->'whatsapp_same') <> 'boolean' then return jsonb_build_object('ok', false, 'error', 'whatsapp'); end if;
    v_wa_same := (p->>'whatsapp_same')::boolean;
    if not v_wa_same then
      v_wa := nullif(regexp_replace(coalesce(p->>'whatsapp', ''), '[^0-9+]', '', 'g'), '');
      if v_wa is null or v_wa !~ '^\+?[0-9]{8,15}$' then return jsonb_build_object('ok', false, 'error', 'whatsapp'); end if;
      if right(regexp_replace(v_wa, '\D', '', 'g'), 9) = right(regexp_replace(v_phone, '\D', '', 'g'), 9) then
        v_wa_same := true; v_wa := null;
      end if;
    end if;
  end if;$b$,
$a$- 'ride_news' - 'privacy_version')$a$,
$b$- 'ride_news' - 'privacy_version' - 'whatsapp_same' - 'whatsapp')$b$,
$a$     returning id into v_app;$a$,
$b$     returning id into v_app;
    if v_wa_same is not null then
      update learn_applications set whatsapp_same = v_wa_same, whatsapp = v_wa where id = v_app;
    end if;$b$]);

select pg_temp._patch('public._learn_app_to_account(uuid,boolean,text[])', array[
$a$'instagram','linkedin','heard_from']);$a$,
$b$'instagram','linkedin','heard_from','whatsapp']);  -- WhatsApp (20261007223000)$b$,
$a$    socials     = case when v_soc$a$,
$b$    whatsapp_same = case when 'whatsapp' = any(f) and a.whatsapp_same is not null
                          and (a.whatsapp_same or a.whatsapp is not null)
                          and (p_overwrite or whatsapp_same is null) then a.whatsapp_same else whatsapp_same end,
    whatsapp      = case when 'whatsapp' = any(f) and a.whatsapp_same is not null
                          and (a.whatsapp_same or a.whatsapp is not null)
                          and (p_overwrite or whatsapp_same is null)
                         then case when a.whatsapp_same then null else a.whatsapp end else whatsapp end,
    socials     = case when v_soc$b$]);

select pg_temp._patch('public.staff_learn_ask_changes(uuid,text[],text,text)', array[
$a$'profession','workplace','instagram','linkedin'];$a$,
$b$'profession','workplace','instagram','linkedin','whatsapp'];  -- WhatsApp (20261007223000)$b$]);

select pg_temp._patch('public.learn_fix_get(text)', array[
$a$      when 'linkedin' then to_jsonb(a.linkedin) end);$a$,
$b$      when 'linkedin' then to_jsonb(a.linkedin)
      -- WhatsApp (20261007223000): {same, phone}, phone the number WhatsApp is on
      when 'whatsapp' then jsonb_build_object('same', a.whatsapp_same, 'phone', case when a.whatsapp_same then a.phone else a.whatsapp end,
                                              'mobile', a.phone) end);$b$]);

select pg_temp._patch('public.learn_fix_submit(text,jsonb)', array[
$a$  v_today  date := (now() at time zone 'Asia/Riyadh')::date;
begin$a$,
$b$  v_today  date := (now() at time zone 'Asia/Riyadh')::date;
  -- WhatsApp (20261007223000)
  v_wa_same boolean := case when jsonb_typeof(p->'whatsapp_same') = 'boolean' then (p->>'whatsapp_same')::boolean end;
  v_wa     text := nullif(regexp_replace(coalesce(p->>'whatsapp', ''), '[^0-9+]', '', 'g'), '');
begin$b$,
$a$

  v_prev := jsonb_strip_nulls(jsonb_build_object($a$,
$b$
  if 'whatsapp' = any(v_f) then
    if v_wa_same is null or (not v_wa_same and (v_wa is null or v_wa !~ '^\+?[0-9]{8,15}$')) then
      return jsonb_build_object('ok', false, 'error', 'whatsapp'); end if;
    if not v_wa_same and right(regexp_replace(v_wa, '\D', '', 'g'), 9) = right(regexp_replace(coalesce(a.phone, ''), '\D', '', 'g'), 9) then
      v_wa_same := true; end if;
    if v_wa_same then v_wa := null; end if;
  end if;

  v_prev := jsonb_strip_nulls(jsonb_build_object($b$,
$a$    'linkedin',    case when 'linkedin'    = any(v_f) then to_jsonb(coalesce(a.linkedin, '')) end));$a$,
$b$    'linkedin',    case when 'linkedin'    = any(v_f) then to_jsonb(coalesce(a.linkedin, '')) end,
    'whatsapp',    case when 'whatsapp'    = any(v_f) and a.whatsapp_same is not null then
                     jsonb_build_object('same', a.whatsapp_same, 'phone', case when a.whatsapp_same then a.phone else a.whatsapp end) end));$b$,
$a$    fix_done_at = now(), fix_prev = v_prev, updated_at = now()$a$,
$b$    whatsapp_same = case when 'whatsapp' = any(v_f) then v_wa_same else whatsapp_same end,
    whatsapp      = case when 'whatsapp' = any(v_f) then v_wa      else whatsapp end,
    fix_done_at = now(), fix_prev = v_prev, updated_at = now()$b$]);


-- ── checks ──────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public.staff_community_ask_changes(uuid,text[],text,text)', 'public.community_fix_get(text)',
                           'public.community_fix_submit(text,jsonb)', 'public.customer_learn_apply(text,text,jsonb)',
                           'public._learn_app_to_account(uuid,boolean,text[])', 'public.staff_learn_ask_changes(uuid,text[],text,text)',
                           'public.learn_fix_get(text)', 'public.learn_fix_submit(text,jsonb)'] loop
    if position('(20261007223000)' in pg_get_functiondef(f::regprocedure)) = 0 then
      raise exception '% was not patched', f;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public.community_fix_get(text)', 'public.community_fix_submit(text,jsonb)',
                           'public.customer_learn_apply(text,text,jsonb)', 'public.learn_fix_get(text)',
                           'public.learn_fix_submit(text,jsonb)', 'public.customer_set_whatsapp(text,text,boolean,text)'] loop
    if not has_function_privilege('anon', f, 'execute') then raise exception '% lost its client grant', f; end if;
  end loop;
  if has_function_privilege('anon', 'public._learn_app_to_account(uuid,boolean,text[])', 'execute') then
    raise exception '_learn_app_to_account must stay closed to clients';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'learn_applications'
        and column_name in ('whatsapp_same', 'whatsapp')) <> 2 then
    raise exception 'learn_applications lacks a WhatsApp column';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261007223000', 'whatsapp_everywhere')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
