-- ============================================================================
-- No ID or Iqama numbers (the owner, 2026-10-23: "dont save customers ids numbers in our system").
-- Undoes 20261014190000_national_id.sql and deletes every number stored with it:
--  1. _purge_old (retention) stops naming national_id (its 20261014190000 line, patched out in place).
--  2. customer_national_id / customer_set_national_id are dropped (the app and the website stopped calling
--     them; the website's card was already left out when the function is missing).
--  3. customers.national_id is dropped with its shape check and column grants - the numbers are gone.
-- No rollback: the numbers can't come back, and the owner's rule is that they never do.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

-- ── 1. retention no longer names the column ──────────────────────────────────────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = '_purge_old';
  if d is null or position('(20261014190000)' in d) = 0 then return; end if;
  d := pg_temp._once(d, ' national_id = null /* (20261014190000) */,', '');
  execute d;
end $do$;

-- ── 2. the functions ─────────────────────────────────────────────────────────────────────────
drop function if exists public.customer_set_national_id(text, text, text);
drop function if exists public.customer_national_id(text, text);

-- ── 3. the column and every number in it ─────────────────────────────────────────────────────
alter table public.customers drop constraint if exists customers_national_id_shape;
alter table public.customers drop column if exists national_id;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261023180000', 'drop_national_id') on conflict (version) do nothing;

commit;
