-- ============================================================================
-- Staff can flag every field of an account (the owner, 2026-10-06: "when flagging a customer make the
-- staff be able to flag every single field").
--
-- The ten fields a flag could name (name, email, phone, birth_date, gender, nationality, country, city,
-- height, photo) gain the rest of what an account holds about its rider:
--   type_preference                      the bike type they usually ride
--   profession, workplace, heard_from    the about fields (customer_set_about's rules)
--   instagram, x, tiktok, linkedin       each social handle on its own (customer_set_socials' rules)
--   emergency                            the emergency contact, name + phone + relationship as one
--                                        answer (customer_set_emergency's rules, own number refused)
-- The optional ones (profession, workplace, the four handles, the emergency contact) can also be
-- answered "I don't have one": p_values.none lists them, and the field is cleared.
--
--  1. customers_fix_fields_known and customer_flags_fields_known take the new names.
--  2. staff_flag_customer keeps them (it dropped every name it did not know).
--  3. customer_fix_save saves them, under the same rules as the account page's own saves, and the
--     flag's history (customer_flags.changes) records each one's before and after: a handle reads
--     from socials, the emergency contact as {name, phone, relation}.
-- Everything else in the three is as it was (prod's definitions, read 2026-10-06).
--
-- Rollback: re-run the previous definitions (20260921140000 and the later staff_flag_customer) and
-- put the two checks back to the ten names, once no row holds a new one.
-- ============================================================================
begin;

alter table public.customers drop constraint if exists customers_fix_fields_known;
alter table public.customers add constraint customers_fix_fields_known check (
  fix_fields is null or fix_fields <@ array['name','email','phone','birth_date','gender','nationality','country','city',
    'height','photo','type_preference','profession','workplace','heard_from','instagram','x','tiktok','linkedin','emergency']::text[]);

alter table public.customer_flags drop constraint if exists customer_flags_fields_known;
alter table public.customer_flags add constraint customer_flags_fields_known check (
  cardinality(fields) > 0 and fields <@ array['name','email','phone','birth_date','gender','nationality','country','city',
    'height','photo','type_preference','profession','workplace','heard_from','instagram','x','tiktok','linkedin','emergency']::text[]);

create or replace function public.staff_flag_customer(p_customer_id text, p_fields text[], p_by text)
 returns customer_flags
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  f text[];
  r public.customer_flags;
begin
  if not is_staff() then raise exception 'not_staff' using errcode = '42501'; end if;
  f := array(select x from unnest(coalesce(p_fields,'{}'::text[])) with ordinality u(x,o)
             where x = any(array['name','email','phone','birth_date','gender','nationality','country','city','height','photo',
                                 'type_preference','profession','workplace','heard_from','instagram','x','tiktok','linkedin','emergency'])
             group by x order by min(o));
  update customers set fix_fields = case when cardinality(f) = 0 then null else f end where id = p_customer_id;
  if not found then raise exception 'no_customer' using errcode = 'P0002'; end if;

  if cardinality(f) = 0 then
    update customer_flags set status = 'withdrawn', answered_at = now()
      where customer_id = p_customer_id and status = 'pending' returning * into r;
    return r;
  end if;

  update customer_flags cf set
      fields = array(select distinct x from unnest(f || array(select jsonb_object_keys(cf.changes))) x),
      flagged_by = coalesce(nullif(btrim(p_by),''), cf.flagged_by)
    where cf.customer_id = p_customer_id and cf.status = 'pending' returning * into r;
  if not found then
    insert into customer_flags (customer_id, fields, flagged_by)
      values (p_customer_id, f, nullif(btrim(p_by),'')) returning * into r;
  end if;
  return r;
end $function$;

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
  none   text[] := '{}';
  k text;
  v text;
  rule text;
  em jsonb;
  em_name text;
  em_ph text;
  em_rel text;
  own text;
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

  -- "I don't have one" (2026-10-06): an optional field staff flagged is answered by clearing it.
  if jsonb_typeof(p_values->'none') = 'array' then
    none := array(select jsonb_array_elements_text(p_values->'none'));
    foreach k in array none loop
      if not (k = any(flags)) or k = any(done) then continue; end if;
      case k
        when 'profession' then update customers set profession = null where id = p_id;
        when 'workplace' then update customers set workplace = null where id = p_id;
        when 'instagram', 'x', 'tiktok', 'linkedin' then
          update customers set socials = nullif(coalesce(socials,'{}'::jsonb) - k, '{}'::jsonb) where id = p_id;
        when 'emergency' then
          update customers set emergency_name = null, emergency_phone = null, emergency_relation = null where id = p_id;
        else continue;
      end case;
      done := done || k;
    end loop;
  end if;

  foreach k in array flags loop
    if k = any(done) then continue; end if;
    -- The emergency contact is one answer of three parts, under customer_set_emergency's rules.
    if k = 'emergency' then
      em := p_values->'emergency';
      if em is null or jsonb_typeof(em) <> 'object' then continue; end if;
      em_name := nullif(regexp_replace(btrim(coalesce(em->>'name','')), '\s+', ' ', 'g'), '');
      em_ph := nullif(regexp_replace(coalesce(em->>'phone',''), '[^0-9+]', '', 'g'), '');
      em_rel := nullif(lower(btrim(coalesce(em->>'relation',''))), '');
      if em_name is null or char_length(em_name) < 2 or char_length(em_name) > 80
         or not _name_chars_ok(em_name) or not _name_parts_ok(em_name) then continue; end if;
      if em_ph is null or em_ph !~ '^\+?[0-9]{8,15}$' then continue; end if;
      if em_rel is null or em_rel not in ('spouse','parent','sibling','child','relative','friend','colleague','other') then continue; end if;
      own := regexp_replace(coalesce(c.phone,''), '\D', '', 'g');
      if own <> '' and right(regexp_replace(em_ph, '\D', '', 'g'), 9) = right(own, 9) then continue; end if;
      update customers set emergency_name = em_name, emergency_phone = em_ph, emergency_relation = em_rel where id = p_id;
      done := done || k;
      continue;
    end if;
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
        -- The account's own number is never taken, though staff put it on another account too
        if v is distinct from c.phone and exists(select 1 from customers o where o.phone = v and o.id <> p_id) then
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
      when 'type_preference' then
        if not _type_ok(v) then continue; end if;
        update customers set type_preference = v where id = p_id;
      when 'profession' then
        v := regexp_replace(v, '\s+', ' ', 'g');
        if char_length(v) < 2 or char_length(v) > 80 or v ~ '[<>"`{}]' then continue; end if;
        update customers set profession = v where id = p_id;
      when 'workplace' then
        v := regexp_replace(v, '\s+', ' ', 'g');
        if char_length(v) < 2 or char_length(v) > 120 or v ~ '[<>"`{}]' then continue; end if;
        update customers set workplace = v where id = p_id;
      when 'heard_from' then
        if v not in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp','google','friend','invited',
                     'passed_by','event','hotel','school','work','community','other') then continue; end if;
        update customers set heard_from = v where id = p_id;
      when 'instagram', 'x', 'tiktok', 'linkedin' then
        v := left(regexp_replace(v, '^[[:space:]@/]+|[[:space:]/]+$', '', 'g'), 100);
        rule := case k when 'x' then '^[A-Za-z0-9_]{1,15}$'
                       when 'linkedin' then '^[A-Za-z0-9._%-]{3,100}$'
                       else '^[A-Za-z0-9._]{1,30}$' end;
        if v !~ rule then continue; end if;
        update customers set socials = coalesce(socials,'{}'::jsonb) || jsonb_build_object(k, v) where id = p_id;
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
          select jsonb_object_agg(k2, jsonb_build_object(
            'before', case when k2 in ('instagram','x','tiktok','linkedin') then to_jsonb(c)->'socials'->k2
                           when k2 = 'emergency' then case when c.emergency_name is null then null
                             else jsonb_build_object('name', c.emergency_name, 'phone', c.emergency_phone, 'relation', c.emergency_relation) end
                           else to_jsonb(c)->k2 end,
            'after',  case when k2 in ('instagram','x','tiktok','linkedin') then to_jsonb(n)->'socials'->k2
                           when k2 = 'emergency' then case when n.emergency_name is null then null
                             else jsonb_build_object('name', n.emergency_name, 'phone', n.emergency_phone, 'relation', n.emergency_relation) end
                           else to_jsonb(n)->k2 end,
            'at', now()))
          from unnest(done) k2
          where k2 <> 'password'
            and (k2 = any(cf.fields) or (k2 in ('country','city') and cf.fields && array['country','city']))), '{}'::jsonb),
        status      = case when cardinality(stored) = 0 then 'answered' else 'pending' end,
        answered_at = case when cardinality(stored) = 0 then now() else null end
      where cf.customer_id = p_id and cf.status = 'pending';
  end if;

  return array(select f from unnest(flags) f where f <> all(done));
end $function$;

-- Checks: the new names are known everywhere, and both functions kept their attributes.
do $chk$
declare d text;
begin
  select pg_get_constraintdef(oid) into d from pg_constraint where conname = 'customers_fix_fields_known' and conrelid = 'public.customers'::regclass;
  if d is null or position('emergency' in d) = 0 or position('linkedin' in d) = 0 then raise exception 'customers_fix_fields_known lacks the new names'; end if;
  select pg_get_constraintdef(oid) into d from pg_constraint where conname = 'customer_flags_fields_known' and conrelid = 'public.customer_flags'::regclass;
  if d is null or position('emergency' in d) = 0 or position('type_preference' in d) = 0 then raise exception 'customer_flags_fields_known lacks the new names'; end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.customer_fix_save(text,text,jsonb)'::regprocedure and p.prosecdef
                   and array_to_string(p.proconfig, ',') like '%search_path=%') then
    raise exception 'customer_fix_save lost security definer or its search_path';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.staff_flag_customer(text,text[],text)'::regprocedure and p.prosecdef
                   and position('''emergency''' in p.prosrc) > 0) then
    raise exception 'staff_flag_customer lost security definer or does not keep the new names';
  end if;
  if not has_function_privilege('anon', 'public.customer_fix_save(text,text,jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_flag_customer(text,text[],text)', 'execute') then
    raise exception 'a client grant is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261006021500', 'flag_every_field')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
