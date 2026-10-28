-- ============================================================================
-- Bug hunt 2026-10-28: _mgr_ok asked for a manager when no manager rule was set.
--
-- _mgr_ok (20261009163000) decides whether a refund, a price change or an on-the-house needs an
-- approver's PIN. Its guards were written `jsonb_typeof(...) <> 'number'`: when the key is missing
-- that is NULL, PL/pgSQL skips the IF, and the function fell through to _mgr_token(p_approval),
-- which is false without an approver. Production's staff_options 'biz' row (saved 2026-10-25 20:42
-- Riyadh, holding only return_check_all) therefore made staff_refund_receipt, staff_set_price and
-- staff_set_house raise MANAGER_REQUIRED for everyone, admins included, and the desk had no approver
-- to offer. A kind left unticked in mgr_for (the page saves only the ticked ones) also needed a
-- manager over the limit, against the page's own _mgrNeeded.
--
-- Now: no limit (no row, no key, not a number, or 0) needs nobody; only a kind ticked true in mgr_for
-- needs an approver over the limit. Header as live (plpgsql, STABLE, SECURITY DEFINER,
-- search_path public); CREATE OR REPLACE keeps the grants, and the revoke is repeated.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public._mgr_ok(p_kind text, p_amount numeric, p_approval text)
returns boolean
language plpgsql stable security definer set search_path to 'public'
as $$
declare b jsonb; lim numeric;
begin
  select items into b from staff_options where key = 'biz';
  -- no limit set (no row, no key, not a number): nothing needs a manager
  if b is null or jsonb_typeof(b -> 'mgr_over') is distinct from 'number' then return true; end if;
  lim := (b ->> 'mgr_over')::numeric;
  if lim <= 0 then return true; end if;
  -- only the kinds ticked true in mgr_for need a manager; a kind left out does not
  if jsonb_typeof(b -> 'mgr_for') is distinct from 'object'
     or (b -> 'mgr_for' -> p_kind) is distinct from 'true'::jsonb then return true; end if;
  if coalesce(p_amount, 0) <= lim then return true; end if;
  return _mgr_token(p_approval);
end $$;
revoke execute on function public._mgr_ok(text, numeric, text) from public, anon, authenticated;

-- check: SECURITY DEFINER and search_path kept
do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public._mgr_ok(text,numeric,text)'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '_mgr_ok lost SECURITY DEFINER or its search_path';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261028120000', 'mgr_ok_null_safe')
on conflict (version) do nothing;

commit;
