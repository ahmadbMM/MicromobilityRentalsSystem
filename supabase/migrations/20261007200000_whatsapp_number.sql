-- ============================================================================
-- WhatsApp number (the owner, 2026-10-07: "for all community members and in community application form
-- ask the users if the phone number typed in is their whatsapp phone number too ... if the answer is no
-- open a new field called whatsapp number ... add it in the flagging too").
--
--  1. customers.whatsapp_same (null = not answered yet, true = the mobile is their WhatsApp too, false =
--     another number) and customers.whatsapp (that other number, kept only with false). The same two on
--     community_applications, so the form's answer reaches the account as the other answers do.
--     Staff read and change them (column grants, as the emergency contact); anon reads neither.
--  2. _customer_asks asks every community member (tag_saturday) for it while whatsapp_same is null, as it
--     asks for their birth date and nationality: the check-up opens at sign-in and customer_create_booking
--     refuses (FIX_FIRST) until it is answered.
--  3. Staff can flag it: 'whatsapp' joins customers_fix_fields_known and customer_flags_fields_known (each
--     rebuilt from the list that is live, so a name another migration added stays) and
--     staff_flag_customer's list.
--  4. customer_fix_save answers it: p_values.whatsapp = {same: true} or {same: false, phone: '+9665...'};
--     a number that is the mobile's own is taken as "same"; true needs a mobile on the account. The flag's
--     history records it as {same, phone} (phone = the number WhatsApp is on).
--  5. customer_whatsapp(p_id, p_token): what the account holds, for the check-up's "On your account".
--  6. customer_community_apply takes whatsapp_same / whatsapp from the form (a form from before sends
--     neither, and the app asks later); _community_app_to_account copies them to the account;
--     customer_community_me hands them back to the form's step 2.
--  7. staff_sync and _staff_ref_broadcast carry the two columns to the desk.
--
-- Every function is patched in place from its live definition (pg_get_functiondef: SECURITY DEFINER,
-- search_path, volatility and grants stay); each anchor must match exactly once, and none is one that
-- 20261007120000 (bug hunt) or 20261007150000 (second emergency contact) patches, so they run in any order.
-- Idempotent: a function already carrying '(20261007200000)' is skipped.
--
-- Rollback: put the two checks back without 'whatsapp' (after clearing it from customers.fix_fields and
-- customer_flags.fields), drop function public.customer_whatsapp(text,text), re-run each patch backwards,
-- then drop the four columns.
-- Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

-- Applies the patches [a1, b1, a2, b2, ...] to one function, unless it carries this migration's mark.
create or replace function pg_temp._patch(sig text, ab text[]) returns void language plpgsql as $f$
declare d text; i int;
begin
  d := pg_get_functiondef(sig::regprocedure);
  if position('(20261007200000)' in d) > 0 then
    raise notice '% is already patched; nothing to do', sig;
    return;
  end if;
  for i in 1 .. array_length(ab, 1) by 2 loop
    d := pg_temp._once(d, ab[i], ab[i + 1]);
  end loop;
  execute d;
end $f$;


-- ── 1. the columns ──────────────────────────────────────────────────────────────────────────
alter table public.customers add column if not exists whatsapp_same boolean;
alter table public.customers add column if not exists whatsapp text;
alter table public.customers drop constraint if exists customers_whatsapp_shape;
alter table public.customers add constraint customers_whatsapp_shape
  check ((whatsapp is null or whatsapp ~ '^\+?[0-9]{8,15}$') and (whatsapp_same is distinct from false or whatsapp is not null));
comment on column public.customers.whatsapp_same is
  'Is the mobile (phone) the rider''s WhatsApp too: null = not answered, true = yes, false = see whatsapp (20261007200000).';
comment on column public.customers.whatsapp is
  'The rider''s WhatsApp number when it is not their mobile (whatsapp_same false), as +<country><number> (20261007200000).';
grant select (whatsapp_same, whatsapp) on public.customers to authenticated;
grant update (whatsapp_same, whatsapp) on public.customers to authenticated;

alter table public.community_applications add column if not exists whatsapp_same boolean;
alter table public.community_applications add column if not exists whatsapp text;
alter table public.community_applications drop constraint if exists community_applications_whatsapp_shape;
alter table public.community_applications add constraint community_applications_whatsapp_shape
  check (whatsapp is null or whatsapp ~ '^\+?[0-9]{8,15}$');


-- ── 2. community members are asked ──────────────────────────────────────────────────────────
select pg_temp._patch('public._customer_asks(text)', array[
$a$    if coalesce(btrim(c.nationality),'') = '' and not ('nationality' = any(f)) then
      f := f || 'nationality'::text;
    end if;$a$,
$b$    if coalesce(btrim(c.nationality),'') = '' and not ('nationality' = any(f)) then
      f := f || 'nationality'::text;
    end if;
    -- and whether their mobile is their WhatsApp too, or which number is (20261007200000)
    if c.whatsapp_same is null and not ('whatsapp' = any(f)) then
      f := f || 'whatsapp'::text;
    end if;$b$]);


-- ── 3. staff can flag it ────────────────────────────────────────────────────────────────────
-- Each check is rebuilt from its live list plus 'whatsapp', so a name another migration added stays.
do $ck$
declare r record; names text[]; d text;
begin
  for r in select * from (values ('public.customers'::regclass, 'customers_fix_fields_known'),
                                 ('public.customer_flags'::regclass, 'customer_flags_fields_known')) v(rel, con) loop
    select pg_get_constraintdef(oid) into d from pg_constraint where conrelid = r.rel and conname = r.con;
    if d is null then raise exception '% is missing', r.con; end if;
    names := array(select m[1] from regexp_matches(substring(d from 'ARRAY\[(.*)\]'), '''([a-z_0-9]+)''::text', 'g') m);
    if cardinality(names) < 19 then raise exception 'could not read the names of %', r.con; end if;
    if 'whatsapp' = any(names) then continue; end if;
    names := names || 'whatsapp'::text;
    -- written as array['a','b',...]::text[], so pg_get_constraintdef prints ARRAY['a'::text, ...] as before
    -- (the form this parser, and 20261007150000's, read back)
    d := 'array[' || (select string_agg(quote_literal(x), ',' order by o) from unnest(names) with ordinality u(x, o)) || ']::text[]';
    execute format('alter table %s drop constraint %I', r.rel, r.con);
    if r.con = 'customers_fix_fields_known' then
      execute format('alter table %s add constraint %I check (fix_fields is null or fix_fields <@ %s)', r.rel, r.con, d);
    else
      execute format('alter table %s add constraint %I check (cardinality(fields) > 0 and fields <@ %s)', r.rel, r.con, d);
    end if;
  end loop;
end $ck$;

select pg_temp._patch('public.staff_flag_customer(text,text[],text)', array[
$a$'heard_from','instagram','x'$a$,
$b$'heard_from','whatsapp'  /* (20261007200000) */,'instagram','x'$b$]);


-- ── 4. customer_fix_save answers it ─────────────────────────────────────────────────────────
select pg_temp._patch('public.customer_fix_save(text,text,jsonb)', array[
$a$    if not (p_values ? k) then continue; end if;$a$,
$b$    -- WhatsApp (20261007200000): {same: true} - the mobile - or {same: false, phone}. A number that is
    -- the mobile's own is "same"; "same" needs a mobile on the account.
    if k = 'whatsapp' then
      em := p_values->'whatsapp';
      if em is null or jsonb_typeof(em) <> 'object' or jsonb_typeof(em->'same') <> 'boolean' then continue; end if;
      own := regexp_replace(coalesce(c.phone,''), '\D', '', 'g');
      em_ph := nullif(regexp_replace(coalesce(em->>'phone',''), '[^0-9+]', '', 'g'), '');
      if (em->>'same')::boolean or (em_ph is not null and own <> ''
           and right(regexp_replace(em_ph, '\D', '', 'g'), 9) = right(own, 9)) then
        if own = '' then continue; end if;
        update customers set whatsapp_same = true, whatsapp = null where id = p_id;
      else
        if em_ph is null or em_ph !~ '^\+?[0-9]{8,15}$' then continue; end if;
        update customers set whatsapp_same = false, whatsapp = em_ph where id = p_id;
      end if;
      done := done || k;
      continue;
    end if;
    if not (p_values ? k) then continue; end if;$b$,
$a$            'before', case when k2 in ('instagram','x','tiktok','linkedin') then$a$,
$b$            'before', case when k2 = 'whatsapp' then case when c.whatsapp_same is null then null
                             else jsonb_build_object('same', c.whatsapp_same, 'phone', case when c.whatsapp_same then c.phone else c.whatsapp end) end
                           when k2 in ('instagram','x','tiktok','linkedin') then$b$,
$a$            'after',  case when k2 in ('instagram','x','tiktok','linkedin') then$a$,
$b$            'after',  case when k2 = 'whatsapp' then case when n.whatsapp_same is null then null
                             else jsonb_build_object('same', n.whatsapp_same, 'phone', case when n.whatsapp_same then n.phone else n.whatsapp end) end
                           when k2 in ('instagram','x','tiktok','linkedin') then$b$]);


-- ── 5. what the account holds ───────────────────────────────────────────────────────────────
create or replace function public.customer_whatsapp(p_id text, p_token text)
returns table(phone text, whatsapp_same boolean, whatsapp text)
language plpgsql stable security definer
set search_path to 'public', 'extensions'
as $function$
begin
  -- The check-up's "On your account" (20261007200000).
  if not _cust_token_ok(p_id, p_token) then return; end if;
  return query select c.phone, c.whatsapp_same, c.whatsapp from customers c where c.id = p_id;
end $function$;
revoke execute on function public.customer_whatsapp(text, text) from public;
grant  execute on function public.customer_whatsapp(text, text) to anon, authenticated;


-- ── 6. the community form ───────────────────────────────────────────────────────────────────
select pg_temp._patch('public.customer_community_apply(text,text,jsonb)', array[
$a$  v_own    boolean;
begin$a$,
$b$  v_own    boolean;
  v_wa_same boolean;  -- WhatsApp (20261007200000)
  v_wa     text;
begin$b$,
$a$    v_own := (p->>'own_bike')::boolean;
  end if;$a$,
$b$    v_own := (p->>'own_bike')::boolean;
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
  end if;$b$,
$a$own_bike = coalesce(v_own, own_bike), lang$a$,
$b$own_bike = coalesce(v_own, own_bike),
      whatsapp_same = coalesce(v_wa_same, whatsapp_same), whatsapp = case when v_wa_same is null then whatsapp else v_wa end, lang$b$,
$a$privacy_version, ride_news, customer_id, own_bike)$a$,
$b$privacy_version, ride_news, customer_id, own_bike, whatsapp_same, whatsapp)$b$,
$a$coalesce(c.ride_news, false), p_id, v_own);$a$,
$b$coalesce(c.ride_news, false), p_id, v_own, v_wa_same, v_wa);$b$]);

select pg_temp._patch('public._community_app_to_account(uuid,boolean,text[])', array[
$a$'heard_from','bike_type','own_bike']);$a$,
$b$'heard_from','bike_type','own_bike','whatsapp']);  -- WhatsApp (20261007200000)$b$,
$a$    socials     = case when v_soc$a$,
$b$    whatsapp_same = case when 'whatsapp' = any(f) and a.whatsapp_same is not null
                          and (a.whatsapp_same or a.whatsapp is not null)
                          and (p_overwrite or whatsapp_same is null) then a.whatsapp_same else whatsapp_same end,
    whatsapp      = case when 'whatsapp' = any(f) and a.whatsapp_same is not null
                          and (a.whatsapp_same or a.whatsapp is not null)
                          and (p_overwrite or whatsapp_same is null)
                         then case when a.whatsapp_same then null else a.whatsapp end else whatsapp end,
    socials     = case when v_soc$b$]);

select pg_temp._patch('public.customer_community_me(text,text)', array[
$a$    'own_bike', coalesce(a.own_bike, case when c.type_preference = 'Own' then true end));$a$,
$b$    'own_bike', coalesce(a.own_bike, case when c.type_preference = 'Own' then true end),
    -- WhatsApp (20261007200000)
    'whatsapp_same', coalesce(a.whatsapp_same, c.whatsapp_same),
    'whatsapp', case when coalesce(a.whatsapp_same, c.whatsapp_same) = false then coalesce(a.whatsapp, c.whatsapp) end);$b$]);


-- ── 7. the desk ─────────────────────────────────────────────────────────────────────────────
select pg_temp._patch('public.staff_sync(text,timestamp with time zone,text)', array[
$a$'profession', c.profession, 'workplace', c.workplace)$a$,
$b$'profession', c.profession, 'workplace', c.workplace,
             'whatsapp_same', c.whatsapp_same, 'whatsapp', c.whatsapp)  -- (20261007200000)$b$]);

select pg_temp._patch('public._staff_ref_broadcast()', array[
$a$'hidden_types','fix_fields','apple_email'$a$,
$b$'whatsapp_same','whatsapp' /* (20261007200000) */,'hidden_types','fix_fields','apple_email'$b$]);


-- ── checks ──────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text; d text;
begin
  foreach f in array array['public._customer_asks(text)', 'public.staff_flag_customer(text,text[],text)',
                           'public.customer_fix_save(text,text,jsonb)', 'public.customer_community_apply(text,text,jsonb)',
                           'public._community_app_to_account(uuid,boolean,text[])', 'public.customer_community_me(text,text)',
                           'public.staff_sync(text,timestamp with time zone,text)', 'public._staff_ref_broadcast()'] loop
    if position('(20261007200000)' in pg_get_functiondef(f::regprocedure)) = 0 then
      raise exception '% was not patched', f;
    end if;
  end loop;
  foreach f in array array['public._customer_asks(text)', 'public.staff_flag_customer(text,text[],text)',
                           'public.customer_fix_save(text,text,jsonb)', 'public.customer_community_apply(text,text,jsonb)',
                           'public._community_app_to_account(uuid,boolean,text[])', 'public.customer_community_me(text,text)',
                           'public.customer_whatsapp(text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if exists (select 1 from pg_proc where oid = 'public.staff_sync(text,timestamp with time zone,text)'::regprocedure and prosecdef) then
    raise exception 'staff_sync must stay invoker';
  end if;
  foreach f in array array['public.customer_fix_save(text,text,jsonb)', 'public.customer_community_apply(text,text,jsonb)',
                           'public.customer_community_me(text,text)', 'public.customer_whatsapp(text,text)'] loop
    if not has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% lost a client grant', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public._community_app_to_account(uuid,boolean,text[])', 'execute') then
    raise exception '_community_app_to_account must stay closed to clients';
  end if;
  foreach f in array array['customers_fix_fields_known', 'customer_flags_fields_known'] loop
    select pg_get_constraintdef(oid) into d from pg_constraint where conname = f;
    if d is null or position('''whatsapp''' in d) = 0 then raise exception '% lacks whatsapp', f; end if;
  end loop;
  if not has_column_privilege('authenticated', 'public.customers', 'whatsapp', 'select')
     or not has_column_privilege('authenticated', 'public.customers', 'whatsapp_same', 'update')
     or has_column_privilege('anon', 'public.customers', 'whatsapp', 'select') then
    raise exception 'the WhatsApp columns carry the wrong grants';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261007200000', 'whatsapp_number')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
