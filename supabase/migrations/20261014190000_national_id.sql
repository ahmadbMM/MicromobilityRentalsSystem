-- ============================================================================
-- ID or Iqama number on the account (the owner, 2026-10-14: the Blood Donation event needs from every
-- registrant their name, mobile, email, blood type, ID or Iqama number, birth date and nationality, "and add
-- all new fields in customer account info").
--
--  1. customers.national_id: a Saudi national ID (10 digits starting 1) or an Iqama number (10 digits starting
--     2); null = never given. Identity data, so the emergency contacts' grants: staff read and edit it under
--     the table's RLS (select + update to authenticated only); anon gets none of it.
--  2. customer_national_id(p_id, p_token) reads the rider's own; customer_set_national_id(p_id, p_token, p_id_no)
--     saves it (Arabic-Indic digits are read as digits, spaces dropped; blank clears it; anything else is
--     BAD_INPUT 'national_id').
--  3. _purge_old (retention) clears it with the other personal fields (patched in place after the blood type's
--     patch, 20261014180000, which must have run first).
--
-- Rollback (in this order): drop function if exists public.customer_set_national_id(text, text, text);
--   drop function if exists public.customer_national_id(text, text); run the _purge_old patch backwards;
--   alter table public.customers drop column if exists national_id;
-- Idempotent (the patch is skipped when _purge_old already carries '(20261014190000)').
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


-- ── 1. the column ────────────────────────────────────────────────────────────────────────────
alter table public.customers add column if not exists national_id text;
alter table public.customers drop constraint if exists customers_national_id_shape;
alter table public.customers add constraint customers_national_id_shape
  check (national_id is null or national_id ~ '^[12][0-9]{9}$');
comment on column public.customers.national_id is
  'The rider''s Saudi national ID (starts 1) or Iqama number (starts 2), 10 digits; null = not given (20261014190000).';

grant select (national_id) on public.customers to authenticated;
grant update (national_id) on public.customers to authenticated;


-- ── 2. the rider reads and saves their own ───────────────────────────────────────────────────
create or replace function public.customer_national_id(p_id text, p_token text)
 returns text
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare v text;
begin
  if not _cust_token_ok(p_id, p_token) then return null; end if;
  select c.national_id into v from customers c where c.id = p_id;
  return v;
end $function$;
revoke execute on function public.customer_national_id(text, text) from public;
grant  execute on function public.customer_national_id(text, text) to anon, authenticated;

create or replace function public.customer_set_national_id(p_id text, p_token text, p_id_no text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v text := nullif(regexp_replace(translate(coalesce(p_id_no, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '\s', '', 'g'), '');
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if v is not null and v !~ '^[12][0-9]{9}$' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'national_id';
  end if;
  update customers set national_id = v where id = p_id;
  return found;
end $function$;
revoke execute on function public.customer_set_national_id(text, text, text) from public;
grant  execute on function public.customer_set_national_id(text, text, text) to anon, authenticated;


-- ── 3. retention clears it ───────────────────────────────────────────────────────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = '_purge_old';
  if d is null or position('(20261014190000)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
    'blood_type = null /* (20261014180000) */,',
    'blood_type = null /* (20261014180000) */, national_id = null /* (20261014190000) */,');
  execute d;
end $do$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261014190000', 'national_id') on conflict (version) do nothing;

commit;
