-- ============================================================================
-- Merging two accounts for one person (2026-09-28). Admins only, from Community > Duplicates.
--
--  1. customers.merged_into - the account this one was merged into. A merged account is off every
--     staff list; it exists so its holder can still sign in: customer_login and customer_oauth_login
--     follow merged_into to the keeper and hand back the keeper's session. Nothing is deleted.
--  2. customer_merges - one row per merge: who stayed, who moved, every id moved (per table) and the
--     keeper's columns filled from the other, who did it and when, and when it was undone.
--     Staff read it (the recent merges); only the two functions write it.
--  3. staff_merge_customers(p_keep, p_drop, p_by) - moves every booking, sale, note, flag, push
--     subscription, registration match, ambassador row, community application, workshop job, site
--     message and promo code from the dropped account to the keeper; a tag the keeper already
--     holds is dropped, the others move; the keeper's empty profile fields (height, gender, birth
--     date, country, city, nationality, bike type, photo, profession, socials) are filled from the
--     other; the other's sign-in codes go, its session token is cleared, and it is marked merged.
--  4. staff_unmerge_customers(p_id) - within 30 days: every recorded id moves back, the dropped
--     tags come back, the filled columns go back to empty, merged_into is cleared.
--  5. staff_sync hands the desk merged_into with the other customer columns, so a merged account
--     leaves the lists the moment it is merged.
--
-- customer_login / customer_oauth_login: rebuilt from the live definitions (pg_get_functiondef,
-- 2026-09-28) with the merged_into hop added after the account is found; attributes kept: SECURITY
-- DEFINER, search_path public, extensions. staff_sync rebuilt likewise (invoker, STABLE,
-- search_path public, pg_temp) with one more key.
--
-- Rollback:
--   drop function if exists public.staff_unmerge_customers(bigint);
--   drop function if exists public.staff_merge_customers(text, text, text);
--   drop table if exists public.customer_merges;
--   alter table public.customers drop column if exists merged_into;
--   re-create customer_login, customer_oauth_login and staff_sync from 20260925150000 / 20260921*.
-- Idempotent.
-- ============================================================================

alter table public.customers add column if not exists merged_into text references public.customers(id) on delete set null;
create index if not exists customers_merged_into_idx on public.customers (merged_into) where merged_into is not null;
-- customers is read column by column (the PII lockdown): the new column joins the readable ones.
grant select (merged_into) on public.customers to anon, authenticated;

create table if not exists public.customer_merges (
  id         bigserial primary key,
  keep_id    text not null,
  drop_id    text not null,
  keep_name  text,
  drop_name  text,
  moved      jsonb not null default '{}'::jsonb,
  filled     jsonb not null default '[]'::jsonb,
  merged_at  timestamptz not null default now(),
  merged_by  text,
  undone_at  timestamptz
);
alter table public.customer_merges enable row level security;
drop policy if exists "merges staff read" on public.customer_merges;
create policy "merges staff read" on public.customer_merges for select to authenticated using ((select public.is_staff()));
revoke all on public.customer_merges from anon, authenticated;
grant select on public.customer_merges to authenticated;

create or replace function public.staff_merge_customers(p_keep text, p_drop text, p_by text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  k customers%rowtype; d customers%rowtype;
  mv jsonb := '{}'::jsonb; fl text[] := '{}'; ids text[]; m_id bigint;
  tags_moved text[] := '{}'; tags_dup text[] := '{}'; tg text;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if p_keep is null or p_drop is null or p_keep = p_drop then raise exception 'SAME_ACCOUNT' using errcode = '22023'; end if;
  -- both rows locked, lower id first, so two admins merging the same pair cannot cross
  if p_keep < p_drop then
    select * into k from customers where id = p_keep for update;
    select * into d from customers where id = p_drop for update;
  else
    select * into d from customers where id = p_drop for update;
    select * into k from customers where id = p_keep for update;
  end if;
  if k.id is null then raise exception 'NOT_FOUND: keep' using errcode = 'P0002'; end if;
  if d.id is null then raise exception 'NOT_FOUND: drop' using errcode = 'P0002'; end if;
  if k.merged_into is not null or d.merged_into is not null then raise exception 'ALREADY_MERGED' using errcode = '22023'; end if;

  with u as (update queue_entries set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('queue_entries', to_jsonb(ids));
  with u as (update cashier_sales set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('cashier_sales', to_jsonb(ids));
  with u as (update customer_notes set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('customer_notes', to_jsonb(ids));
  with u as (update customer_flags set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('customer_flags', to_jsonb(ids));
  with u as (update push_subscriptions set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('push_subscriptions', to_jsonb(ids));
  with u as (update rider_registrations set matched_customer_id = p_keep where matched_customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('rider_registrations', to_jsonb(ids));
  with u as (update ambassadors set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('ambassadors', to_jsonb(ids));
  with u as (update community_applications set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('community_applications', to_jsonb(ids));
  with u as (update workshop_jobs set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('workshop_jobs', to_jsonb(ids));
  with u as (update site_messages set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('site_messages', to_jsonb(ids));
  with u as (update promo_codes set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('promo_codes', to_jsonb(ids));
  delete from customer_handoffs where customer_id = p_drop; -- two-minute sign-in codes: nothing to keep

  -- tags: a tag the keeper holds already is dropped, the others move (the primary key is (customer, tag))
  for tg in select tag_id from customer_tags where customer_id = p_drop loop
    if exists (select 1 from customer_tags where customer_id = p_keep and tag_id = tg) then
      delete from customer_tags where customer_id = p_drop and tag_id = tg;
      tags_dup := tags_dup || tg;
    else
      update customer_tags set customer_id = p_keep where customer_id = p_drop and tag_id = tg;
      tags_moved := tags_moved || tg;
    end if;
  end loop;
  mv := mv || jsonb_build_object('tags_moved', to_jsonb(tags_moved), 'tags_dup', to_jsonb(tags_dup));

  -- what the keeper lacked, from the other
  if coalesce(k.height, 0) = 0 and coalesce(d.height, 0) > 0 then update customers set height = d.height where id = p_keep; fl := fl || 'height'; end if;
  if coalesce(k.gender, '') = '' and coalesce(d.gender, '') <> '' then update customers set gender = d.gender where id = p_keep; fl := fl || 'gender'; end if;
  if coalesce(k.birth_date, '') = '' and coalesce(d.birth_date, '') <> '' then update customers set birth_date = d.birth_date where id = p_keep; fl := fl || 'birth_date'; end if;
  if coalesce(k.country, '') = '' and coalesce(d.country, '') <> '' then update customers set country = d.country where id = p_keep; fl := fl || 'country'; end if;
  if coalesce(k.city, '') = '' and coalesce(d.city, '') <> '' then update customers set city = d.city where id = p_keep; fl := fl || 'city'; end if;
  if coalesce(k.nationality, '') = '' and coalesce(d.nationality, '') <> '' then update customers set nationality = d.nationality where id = p_keep; fl := fl || 'nationality'; end if;
  if coalesce(k.type_preference, '') = '' and coalesce(d.type_preference, '') <> '' then update customers set type_preference = d.type_preference where id = p_keep; fl := fl || 'type_preference'; end if;
  if coalesce(k.photo, '') = '' and coalesce(d.photo, '') <> '' then update customers set photo = d.photo where id = p_keep; fl := fl || 'photo'; end if;
  if coalesce(k.profession, '') = '' and coalesce(d.profession, '') <> '' then update customers set profession = d.profession where id = p_keep; fl := fl || 'profession'; end if;
  if k.socials is null and d.socials is not null then update customers set socials = d.socials where id = p_keep; fl := fl || 'socials'; end if;

  update customers set merged_into = p_keep, session_token = null where id = p_drop;

  insert into customer_merges (keep_id, drop_id, keep_name, drop_name, moved, filled, merged_by)
    values (p_keep, p_drop, k.name, d.name, mv, to_jsonb(fl), p_by) returning id into m_id;
  return jsonb_build_object('ok', true, 'id', m_id, 'moved', mv, 'filled', to_jsonb(fl), 'keep_name', k.name, 'drop_name', d.name);
end $$;
revoke all on function public.staff_merge_customers(text, text, text) from public, anon;
grant execute on function public.staff_merge_customers(text, text, text) to authenticated;

create or replace function public.staff_unmerge_customers(p_id bigint)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  m customer_merges%rowtype; ids text[]; col text; tg text;
  cols text[] := array['height','gender','birth_date','country','city','nationality','type_preference','photo','profession','socials'];
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  select * into m from customer_merges where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if m.undone_at is not null then raise exception 'ALREADY_UNDONE' using errcode = '22023'; end if;
  if m.merged_at < now() - interval '30 days' then raise exception 'TOO_LATE' using errcode = '22023'; end if;
  perform 1 from customers where id in (m.keep_id, m.drop_id) order by id for update;

  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'queue_entries', '[]')) x;
  update queue_entries set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'cashier_sales', '[]')) x;
  update cashier_sales set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'customer_notes', '[]')) x;
  update customer_notes set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'customer_flags', '[]')) x;
  update customer_flags set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'push_subscriptions', '[]')) x;
  update push_subscriptions set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'rider_registrations', '[]')) x;
  update rider_registrations set matched_customer_id = m.drop_id where matched_customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'ambassadors', '[]')) x;
  update ambassadors set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'community_applications', '[]')) x;
  update community_applications set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'workshop_jobs', '[]')) x;
  update workshop_jobs set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'site_messages', '[]')) x;
  update site_messages set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'promo_codes', '[]')) x;
  update promo_codes set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);

  for tg in select x from jsonb_array_elements_text(coalesce(m.moved->'tags_moved', '[]')) x loop
    update customer_tags set customer_id = m.drop_id where customer_id = m.keep_id and tag_id = tg
      and not exists (select 1 from customer_tags where customer_id = m.drop_id and tag_id = tg);
  end loop;
  for tg in select x from jsonb_array_elements_text(coalesce(m.moved->'tags_dup', '[]')) x loop
    insert into customer_tags (customer_id, tag_id, added_by, added_at)
      values (m.drop_id, tg, 'unmerge', (extract(epoch from now()) * 1000)::bigint)
      on conflict do nothing;
  end loop;
  for col in select x from jsonb_array_elements_text(coalesce(m.filled, '[]')) x loop
    if col = any(cols) then execute format('update customers set %I = null where id = $1', col) using m.keep_id; end if;
  end loop;

  update customers set merged_into = null where id = m.drop_id and merged_into = m.keep_id;
  update customer_merges set undone_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'keep_name', m.keep_name, 'drop_name', m.drop_name);
end $$;
revoke all on function public.staff_unmerge_customers(bigint) from public, anon;
grant execute on function public.staff_unmerge_customers(bigint) to authenticated;

-- ── sign-in follows a merged account to its keeper ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.customer_login(p_identifier text, p_pwd text)
 RETURNS TABLE(id text, name text, email text, phone text, height integer, type_preference text, created_at text, birth_date text, country text, city text, photo text, session_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare r customers%rowtype; c customers%rowtype; tok text; ident text; digits text; k text;
        thr login_throttle%rowtype; athr login_throttle%rowtype; nfails int; ok boolean := false;
        tried text[] := '{}'; aid text; hops int := 0;
begin
  ident := lower(trim(coalesce(p_identifier, '')));
  digits := regexp_replace(coalesce(p_identifier, ''), '\D', '', 'g');
  -- The meter follows what the lookup matches on: the email as typed, or the phone's digits.
  k := case when position('@' in ident) > 0 or digits = '' then ident else 'phone:' || digits end;
  select * into thr from login_throttle where identifier = k;
  if thr.locked_until is not null and thr.locked_until > now() then
    raise exception 'LOCKED' using errcode = 'P0001';   -- too many attempts; the app shows a wait message
  end if;

  -- Columns qualified with customers.*: bare email/phone would be ambiguous
  -- against this function's RETURNS TABLE(... email, phone ...) output names.
  -- apple_email: an Apple relay address signs in to the same account as its real email.
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
    -- A phone shared by two accounts signs in to the one whose password this is.
    for c in select * from customers
              where regexp_replace(customers.phone, '\D', '', 'g') = digits
              order by customers.created_at
              limit 5 loop
      select * into athr from login_throttle where identifier = 'acct:' || c.id;
      if athr.locked_until is not null and athr.locked_until > now() then continue; end if;
      tried := tried || c.id;
      if _cust_pwd_ok(c.password_hash, p_pwd) then r := c; ok := true; exit; end if;
    end loop;
  end if;

  if not ok then
    -- record the failure on the identifier and on every account it was tried against;
    -- a just-expired lock, or a day without failures, starts the count again
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
  delete from login_throttle where identifier in (k, 'acct:' || r.id);   -- success clears both counters

  -- Transparent upgrade: re-hash a legacy sha256 password to bcrypt on login (on the row that holds it).
  if left(r.password_hash, 7) = 'sha256:' then
    update customers set password_hash = crypt(p_pwd, gen_salt('bf')) where customers.id = r.id;
  end if;
  -- An account merged into another (2026-09-28) signs in to the keeper: its bookings live there now.
  while r.merged_into is not null and hops < 5 loop
    select * into c from customers where customers.id = r.merged_into;
    exit when not found;
    r := c; hops := hops + 1;
  end loop;

  -- Reuse the live token so other signed-in devices stay valid; mint only when absent.
  tok := coalesce(nullif(r.session_token,''), encode(gen_random_bytes(24), 'hex'));
  update customers set session_token = tok where customers.id = r.id; -- qualified: id is also a RETURNS TABLE output name
  return query select r.id, r.name, r.email, r.phone, r.height, r.type_preference,
    r.created_at, r.birth_date, r.country, r.city, r.photo, tok;
end $function$;

CREATE OR REPLACE FUNCTION public.customer_oauth_login(p_email text)
 RETURNS TABLE(id text, name text, email text, phone text, height integer, type_preference text, created_at text, birth_date text, country text, city text, photo text, session_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare r customers%rowtype; c customers%rowtype; tok text; prov text := coalesce(auth.jwt()->'app_metadata'->>'provider',''); hops int := 0;
begin
  if auth.uid() is null or lower(coalesce(auth.jwt()->>'email','')) <> lower(p_email)
     or prov not in ('google','apple') then return; end if;
  select * into r from customers
   where lower(customers.email) = lower(p_email) or lower(customers.apple_email) = lower(p_email)
   order by coalesce(lower(customers.email) = lower(p_email), false) desc
   limit 1;
  if not found then return; end if;
  -- An account merged into another (2026-09-28) signs in to the keeper.
  while r.merged_into is not null and hops < 5 loop
    select * into c from customers where customers.id = r.merged_into;
    exit when not found;
    r := c; hops := hops + 1;
  end loop;
  if coalesce(r.password_hash,'') like 'oauth:%' then
    tok := coalesce(nullif(r.session_token,''), encode(gen_random_bytes(24),'hex'));
    update customers set session_token = tok where customers.id = r.id;
  else
    tok := encode(gen_random_bytes(24),'hex');
    update customers set session_token = tok, password_hash = 'oauth:' || prov, must_change_pwd = false
     where customers.id = r.id;
  end if;
  return query select r.id, r.name, r.email, r.phone, r.height, r.type_preference,
    r.created_at, r.birth_date, r.country, r.city, r.photo, tok;
end $function$;

-- ── the desk's sync carries merged_into ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.staff_sync(p_table text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cut text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    -- Column by column: this runs as the staff member, and the API may not read password_hash or
    -- session_token, so a whole-row read is refused. Never the photo either.
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', c.id, 'name', c.name, 'email', c.email, 'phone', c.phone, 'height', c.height,
             'type_preference', c.type_preference, 'gender', c.gender, 'birth_date', c.birth_date,
             'country', c.country, 'city', c.city, 'nationality', c.nationality, 'socials', c.socials,
             'created_at', c.created_at, 'default_pay', c.default_pay, 'hidden_types', c.hidden_types,
             'fix_fields', c.fix_fields, 'apple_email', c.apple_email, 'ride_news_at', c.ride_news_at,
             'ride_news', c.ride_news, 'deletion_requested_at', c.deletion_requested_at, 'updated_at', c.updated_at,
             'merged_into', c.merged_into)
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
$function$;
