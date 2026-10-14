-- ============================================================================
-- Blood type on the account (the owner, 2026-10-14: "create a field for the accounts ... and allow people to
-- add their blood type in my accounts section"; asked first for the Blood Donation event's registration).
--
--  1. customers.blood_type: one of A+, A-, B+, B-, AB+, AB-, O+, O-, or 'unknown' ("I don't know my blood
--     type"); null = never answered. Health data, so the emergency contacts' grants: staff read and edit it
--     under the table's RLS (select + update to authenticated only); anon gets none of it.
--  2. customer_blood_type(p_id, p_token) reads the rider's own; customer_set_blood_type(p_id, p_token, p_type)
--     saves it (blank clears it, anything outside the nine codes is BAD_INPUT 'blood_type').
--  3. _purge_old (retention) clears it with the other personal fields (patched in place; the anchor must
--     match exactly once).
--
-- Rollback (in this order): drop function if exists public.customer_set_blood_type(text, text, text);
--   drop function if exists public.customer_blood_type(text, text); run the _purge_old patch backwards;
--   alter table public.customers drop column if exists blood_type;
-- Idempotent (the patch is skipped when _purge_old already carries '(20261014180000)').
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
alter table public.customers add column if not exists blood_type text;
alter table public.customers drop constraint if exists customers_blood_type_code;
alter table public.customers add constraint customers_blood_type_code
  check (blood_type is null or blood_type in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'));
comment on column public.customers.blood_type is
  'The rider''s blood type: A+, A-, B+, B-, AB+, AB-, O+, O-, or unknown (said they do not know); null = not asked yet (20261014180000).';

grant select (blood_type) on public.customers to authenticated;
grant update (blood_type) on public.customers to authenticated;


-- ── 2. the rider reads and saves their own ───────────────────────────────────────────────────
create or replace function public.customer_blood_type(p_id text, p_token text)
 returns text
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare v text;
begin
  if not _cust_token_ok(p_id, p_token) then return null; end if;
  select c.blood_type into v from customers c where c.id = p_id;
  return v;
end $function$;
revoke execute on function public.customer_blood_type(text, text) from public;
grant  execute on function public.customer_blood_type(text, text) to anon, authenticated;

create or replace function public.customer_set_blood_type(p_id text, p_token text, p_type text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v text := nullif(upper(btrim(coalesce(p_type, ''))), '');
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if v = 'UNKNOWN' then v := 'unknown'; end if;
  if v is not null and v not in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'blood_type';
  end if;
  update customers set blood_type = v where id = p_id;
  return found;
end $function$;
revoke execute on function public.customer_set_blood_type(text, text, text) from public;
grant  execute on function public.customer_set_blood_type(text, text, text) to anon, authenticated;


-- ── 3. retention clears it ───────────────────────────────────────────────────────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = '_purge_old';
  if d is null or position('(20261014180000)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
    'emergency2_name = null, emergency2_phone = null, emergency2_relation = null,',
    'emergency2_name = null, emergency2_phone = null, emergency2_relation = null, blood_type = null /* (20261014180000) */,');
  execute d;
end $do$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261014180000', 'blood_type') on conflict (version) do nothing;

commit;
