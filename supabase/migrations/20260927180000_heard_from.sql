-- How a new account heard of us (2026-09-27): customers.heard_from holds one code, obligatory at
-- sign-up in the app (the form and the Google completion), 'desk' for accounts the desk adds.
-- customer_signup takes it as a new trailing parameter with a default, so the desk's older
-- eight-argument calls still fit; the old signature is dropped so PostgREST never has two to
-- choose from. customer_set_heard_from writes it for an account that already exists (the Google
-- completion), token-checked like the other customer writes. staff_sync hands it to the desk.
alter table public.customers add column if not exists heard_from text;
alter table public.customers drop constraint if exists customers_heard_from_check;
alter table public.customers add constraint customers_heard_from_check
  check (heard_from is null or heard_from in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp','google','friend','invited','passed_by','event','hotel','school','work','community','other','desk'));
grant select (heard_from) on public.customers to anon, authenticated;

drop function if exists public.customer_signup(text, text, text, text, text, integer, text, text);
create or replace function public.customer_signup(p_id text, p_name text, p_email text, p_phone text, p_pwd text, p_height integer, p_type_preference text, p_gender text, p_heard_from text default null)
 returns table(id text, session_token text)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $fn$
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
  if exists(select 1 from customers
            where (coalesce(p_email,'')<>'' and lower(email)=lower(p_email))
               or (coalesce(p_phone,'')<>'' and phone=p_phone)) then
    raise exception 'DUPLICATE' using errcode = 'unique_violation';
  end if;
  tok := encode(gen_random_bytes(24),'hex');
  insert into customers(id,name,email,phone,password_hash,created_at,height,type_preference,gender,session_token,heard_from)
  values(p_id,p_name,p_email,p_phone,crypt(p_pwd, gen_salt('bf', 10)),to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         p_height,p_type_preference,p_gender,tok,p_heard_from);
  return query select p_id, tok;
end $fn$;
revoke all on function public.customer_signup(text, text, text, text, text, integer, text, text, text) from public;
grant execute on function public.customer_signup(text, text, text, text, text, integer, text, text, text) to anon, authenticated;

create or replace function public.customer_set_heard_from(p_id text, p_token text, p_value text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $fn$
begin
  p_value := nullif(btrim(coalesce(p_value, '')), '');
  if p_value is null or p_value not in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp','google','friend','invited','passed_by','event','hotel','school','work','community','other') then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'heard_from'; end if;
  update customers set heard_from = p_value, updated_at = now()
   where customers.id = p_id and coalesce(p_token,'') <> '' and customers.session_token = p_token;
  return found;
end $fn$;
revoke all on function public.customer_set_heard_from(text, text, text) from public;
grant execute on function public.customer_set_heard_from(text, text, text) to anon, authenticated;

create or replace function public.staff_sync(p_table text, p_since timestamp with time zone default null::timestamp with time zone, p_cut text default null::text)
 returns jsonb
 language plpgsql
 stable
 set search_path to 'public', 'pg_temp'
as $fn$
declare
  v_rows jsonb;
  v_del  jsonb := '[]'::jsonb;
begin
  if not is_staff() then
    raise exception 'STAFF_ONLY' using errcode = '42501';
  end if;
  if p_table = 'queue_entries' then
    select coalesce(jsonb_agg(to_jsonb(q) order by q.session_id, q.queue_num, q.id), '[]'::jsonb)
      into v_rows
      from queue_entries q
     where (p_since is null or q.updated_at > p_since)
       and (p_cut is null or q.session_date >= p_cut);
  elsif p_table = 'customers' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', c.id, 'name', c.name, 'email', c.email, 'phone', c.phone, 'height', c.height,
             'type_preference', c.type_preference, 'gender', c.gender, 'birth_date', c.birth_date,
             'country', c.country, 'city', c.city, 'nationality', c.nationality, 'socials', c.socials,
             'created_at', c.created_at, 'default_pay', c.default_pay, 'hidden_types', c.hidden_types,
             'fix_fields', c.fix_fields, 'apple_email', c.apple_email, 'ride_news_at', c.ride_news_at,
             'ride_news', c.ride_news, 'deletion_requested_at', c.deletion_requested_at, 'updated_at', c.updated_at,
             'merged_into', c.merged_into, 'heard_from', c.heard_from)
             order by c.created_at, c.id), '[]'::jsonb)
      into v_rows
      from customers c
     where p_since is null or c.updated_at > p_since;
  elsif p_table = 'customer_tags' then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.customer_id, t.tag_id), '[]'::jsonb)
      into v_rows
      from customer_tags t
     where p_since is null or t.updated_at > p_since;
  else
    raise exception 'staff_sync: unknown table %', p_table using errcode = '22023';
  end if;
  if p_since is not null then
    select coalesce(jsonb_agg(jsonb_build_object('id', d.row_id, 'at', d.deleted_at) order by d.deleted_at), '[]'::jsonb)
      into v_del
      from sync_deletions d
     where d.tbl = p_table and d.deleted_at > p_since;
  end if;
  return jsonb_build_object('now', now(), 'rows', v_rows, 'deleted', v_del);
end
$fn$;
