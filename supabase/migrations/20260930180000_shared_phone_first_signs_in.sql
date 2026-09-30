-- One phone number on more than one account, set by staff, and the number signs in only the
-- account that had it first (the owner, 2026-09-30: "make the staff able to add the phone number
-- on more than one account", "but only let the main account or first account that has it to be
-- able to sign with it"). A family's number on the children's accounts, say: the parent keeps
-- signing in with it, each child signs in with their own email.
--
-- customers.phone_since: when the account got the number it has now, stamped by a trigger on
-- every insert and every change of the number's digits (a save that writes the same number keeps
-- it). Accounts from before this migration have none: they had their number first, ordered
-- among themselves by when the account was made. No row is rewritten here: a backfill would
-- touch every row and send every account down every staff device's sync again.
-- _phone_main(digits) names the account that signs in with a number: the live one (not merged
-- away) that has had it longest.
-- customer_login: a phone sign-in tries only that account, and one merged into it.
-- customer_signup: staff may make an account with a number another account has; a rider signing
-- up still may not (customer_exists and the sign-up page are unchanged). The staff account
-- editor writes the table directly; its own check is lifted in the app.
-- customer_fix_save: the account's own number is never "taken", so an account holding a shared
-- number can answer a correction request with it.
-- staff_phone_accounts(phone): the live accounts on a number, the one that signs in first, for
-- the staff account editor to say so. Staff only; a read.

alter table public.customers add column if not exists phone_since timestamptz;
comment on column public.customers.phone_since is
  'When the account got the phone number it has now (trigger customers_phone_since). Null: since before 2026-09-30. The live account with the earliest (null first, then created_at) signs in with the number.';

create or replace function public._customer_phone_since()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if tg_op = 'INSERT'
     or regexp_replace(coalesce(new.phone,''), '\D', '', 'g') is distinct from regexp_replace(coalesce(old.phone,''), '\D', '', 'g') then
    new.phone_since := case when coalesce(new.phone,'') <> '' then now() end;
  end if;
  return new;
end $function$;
revoke all on function public._customer_phone_since() from public, anon, authenticated;

drop trigger if exists customers_phone_since on public.customers;
create trigger customers_phone_since before insert or update of phone on public.customers
  for each row execute function public._customer_phone_since();

create or replace function public._phone_main(p_digits text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select c.id from customers c
   where c.merged_into is null and coalesce(c.phone,'') <> ''
     and regexp_replace(c.phone, '\D', '', 'g') = p_digits
   order by c.phone_since nulls first, c.created_at, c.id
   limit 1
$function$;
revoke all on function public._phone_main(text) from public, anon, authenticated;

create or replace function public.staff_phone_accounts(p_phone text)
 returns table(id text, name text, signs_in boolean)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare d text := regexp_replace(coalesce(p_phone,''), '\D', '', 'g'); m text;
begin
  if not (select is_staff()) or length(d) < 6 then return; end if;
  m := _phone_main(d);
  return query select c.id, c.name, c.id = m from customers c
    where c.merged_into is null and regexp_replace(coalesce(c.phone,''), '\D', '', 'g') = d
    order by c.id = m desc, c.created_at, c.id;
end $function$;
revoke all on function public.staff_phone_accounts(text) from public, anon;
grant execute on function public.staff_phone_accounts(text) to authenticated;

CREATE OR REPLACE FUNCTION public.customer_login(p_identifier text, p_pwd text)
 RETURNS TABLE(id text, name text, email text, phone text, height integer, type_preference text, created_at text, birth_date text, country text, city text, photo text, session_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare r customers%rowtype; c customers%rowtype; tok text; ident text; digits text; k text;
        thr login_throttle%rowtype; athr login_throttle%rowtype; nfails int; ok boolean := false;
        tried text[] := '{}'; aid text; hops int := 0; main_id text; root text; nxt text; n2 int;
begin
  ident := lower(trim(coalesce(p_identifier, '')));
  digits := regexp_replace(coalesce(p_identifier, ''), '\D', '', 'g');
  k := case when position('@' in ident) > 0 or digits = '' then ident else 'phone:' || digits end;
  select * into thr from login_throttle where identifier = k;
  if thr.locked_until is not null and thr.locked_until > now() then
    raise exception 'LOCKED' using errcode = 'P0001';
  end if;
  if position('@' in ident) > 0 then
    for c in select * from customers
              where lower(customers.email) = ident or lower(customers.apple_email) = ident
              order by (lower(customers.email) = ident) desc nulls last, customers.created_at
              limit 2 loop
      select * into athr from login_throttle where identifier = 'acct:' || c.id;
      if athr.locked_until is not null and athr.locked_until > now() then
        raise exception 'LOCKED' using errcode = 'P0001';
      end if;
      tried := tried || c.id;
      if _cust_pwd_ok(c.password_hash, p_pwd) then r := c; ok := true; exit; end if;
    end loop;
  elsif length(digits) >= 6 then
    -- A number on several accounts signs in only the one that has had it longest, and an account
    -- merged into that one (20260930180000). With no live account on the number, only merged
    -- ones, those sign in as before.
    main_id := _phone_main(digits);
    for c in select * from customers
              where regexp_replace(customers.phone, '\D', '', 'g') = digits
                and (main_id is null or customers.id = main_id or customers.merged_into is not null)
              order by (customers.id = main_id) desc nulls last, customers.created_at
              limit 5 loop
      if main_id is not null and c.id <> main_id then
        root := c.id; n2 := 0;
        loop
          nxt := null;
          select x.merged_into into nxt from customers x where x.id = root;
          exit when nxt is null or n2 >= 5;
          root := nxt; n2 := n2 + 1;
        end loop;
        if root is distinct from main_id then continue; end if;
      end if;
      select * into athr from login_throttle where identifier = 'acct:' || c.id;
      if athr.locked_until is not null and athr.locked_until > now() then continue; end if;
      tried := tried || c.id;
      if _cust_pwd_ok(c.password_hash, p_pwd) then r := c; ok := true; exit; end if;
    end loop;
  end if;
  if not ok then
    nfails := (case when (thr.locked_until is not null and thr.locked_until <= now())
                      or thr.updated_at < now() - interval '1 day' then 0
                    else coalesce(thr.fails, 0) end) + 1;
    insert into login_throttle(identifier, fails, locked_until, updated_at)
      values (k, nfails, case when nfails >= 8 then now() + interval '15 minutes' else null end, now())
      on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
    foreach aid in array tried loop
      select * into athr from login_throttle where identifier = 'acct:' || aid;
      nfails := (case when (athr.locked_until is not null and athr.locked_until <= now())
                        or athr.updated_at < now() - interval '1 day' then 0
                      else coalesce(athr.fails, 0) end) + 1;
      insert into login_throttle(identifier, fails, locked_until, updated_at)
        values ('acct:' || aid, nfails, case when nfails >= 8 then now() + interval '15 minutes' else null end, now())
        on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
    end loop;
    return;
  end if;
  delete from login_throttle where identifier in (k, 'acct:' || r.id);
  if left(r.password_hash, 7) = 'sha256:' then
    update customers set password_hash = crypt(p_pwd, gen_salt('bf')) where customers.id = r.id;
  end if;
  while r.merged_into is not null and hops < 5 loop
    select * into c from customers where customers.id = r.merged_into;
    exit when not found;
    r := c; hops := hops + 1;
  end loop;
  tok := coalesce(nullif(r.session_token,''), encode(gen_random_bytes(24), 'hex'));
  update customers set session_token = tok where customers.id = r.id;
  return query select r.id, r.name, r.email, r.phone, r.height, r.type_preference,
    r.created_at, r.birth_date, r.country, r.city, r.photo, tok;
end $function$;

CREATE OR REPLACE FUNCTION public.customer_signup(p_id text, p_name text, p_email text, p_phone text, p_pwd text, p_height integer, p_type_preference text, p_gender text, p_heard_from text DEFAULT NULL::text)
 RETURNS TABLE(id text, session_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare tok text;
begin
  if not (select is_staff()) and not _ip_gate('signup', 20, interval '10 minutes') then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;
  p_gender := nullif(p_gender, '');
  p_type_preference := coalesce(nullif(p_type_preference, ''), 'Any');
  p_heard_from := nullif(btrim(coalesce(p_heard_from, '')), '');
  if coalesce(p_id,'') !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'id'; end if;
  if not _type_ok(p_type_preference) then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'type_preference'; end if;
  if p_gender is not null and p_gender not in ('male','female') then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'gender'; end if;
  if p_height is not null and (p_height < 100 or p_height > 250) then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'height'; end if;
  if coalesce(p_phone,'') <> '' and p_phone !~ '^\+?[0-9]{6,15}$' then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'phone'; end if;
  if p_heard_from is not null and p_heard_from not in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp','google','friend','invited','passed_by','event','hotel','school','work','community','other','desk') then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'heard_from'; end if;
  -- Staff may give a new account a number another account has (20260930180000); the account
  -- that had it first keeps signing in with it (customer_login). A rider signing up may not.
  if exists(select 1 from customers
            where (coalesce(p_email,'')<>'' and lower(email)=lower(p_email))
               or (coalesce(p_phone,'')<>'' and phone=p_phone and not (select is_staff()))) then
    raise exception 'DUPLICATE' using errcode = 'unique_violation';
  end if;
  tok := encode(gen_random_bytes(24),'hex');
  insert into customers(id,name,email,phone,password_hash,created_at,height,type_preference,gender,session_token,heard_from)
  values(p_id,p_name,p_email,p_phone,crypt(p_pwd, gen_salt('bf', 10)),to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         p_height,p_type_preference,p_gender,tok,p_heard_from);
  return query select p_id, tok;
end $function$;

CREATE OR REPLACE FUNCTION public.customer_fix_save(p_id text, p_token text, p_values jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
