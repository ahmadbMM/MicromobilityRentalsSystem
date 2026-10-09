-- ============================================================================
-- Approvals (Staff app research 2026-10-09, B10), 2026-10-09.
--
-- Two switches in Settings > Business (staff_options 'biz', 20261009160000), checked here so the
-- page cannot skip them:
--  1. pin_all = true: every operator needs a PIN to approve. _pin_ok answered true for an operator
--     with no PIN (and for a device naming nobody, and for an account's own name off the team
--     list); with pin_all those answer false, so the void, refund, price change and deletes are
--     refused with PIN_REQUIRED until the operator has a PIN.
--  2. mgr_over (SAR) + mgr_for {refund, house, price} + approvers [operator names]: a refund or a
--     price cut over that amount needs the approval token of an approver (staff_pin_approve with an
--     approver's name and PIN), not the operator's own. _mgr_ok(kind, amount, approval) is checked
--     by staff_refund_receipt (the receipt's unrefunded lines) and staff_set_price (old price less
--     the new one) and raises MANAGER_REQUIRED. An approver's token also satisfies _pin_ok, so the
--     operator is not asked a second time. On-the-house is a plain table write today (no RPC), so
--     its manager rule is the booking app's alone.
--
-- Rollback: re-run the saved pg_get_functiondef of _pin_ok, staff_refund_receipt and staff_set_price
--   (every patched line carries "(20261009163000)"); drop function public._mgr_ok(text,numeric,text),
--   public._mgr_token(text), public._biz_bool(text).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

create or replace function public._biz_bool(p_key text)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select coalesce((select (o.items ->> p_key)::boolean from staff_options o
                    where o.key = 'biz' and jsonb_typeof(o.items -> p_key) = 'boolean'), false)
$$;
revoke execute on function public._biz_bool(text) from public, anon, authenticated;

-- An approval token this sign-in holds from one of the approvers Settings names (with a PIN).
create or replace function public._mgr_token(p_approval text)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select p_approval is not null and exists (
    select 1 from pin_approvals a
      join team_members t on t.name = a.op_name and t.pin_hash is not null
      join staff_options o on o.key = 'biz' and jsonb_typeof(o.items -> 'approvers') = 'array'
     where a.token = p_approval and a.user_id = auth.uid() and a.expires_at >= now()
       and (o.items -> 'approvers') ? a.op_name)
$$;
revoke execute on function public._mgr_token(text) from public, anon, authenticated;

-- true when no manager is needed for this kind and amount, or the approval is an approver's
create or replace function public._mgr_ok(p_kind text, p_amount numeric, p_approval text)
returns boolean
language plpgsql stable security definer set search_path to 'public'
as $$
declare b jsonb; lim numeric;
begin
  select items into b from staff_options where key = 'biz';
  if b is null or jsonb_typeof(b -> 'mgr_over') <> 'number' then return true; end if;
  lim := (b ->> 'mgr_over')::numeric;
  if lim <= 0 then return true; end if;
  if jsonb_typeof(b -> 'mgr_for') <> 'object' or jsonb_typeof(b -> 'mgr_for' -> p_kind) <> 'boolean'
     or not (b -> 'mgr_for' ->> p_kind)::boolean then return true; end if;
  if coalesce(p_amount, 0) <= lim then return true; end if;
  return _mgr_token(p_approval);
end $$;
revoke execute on function public._mgr_ok(text, numeric, text) from public, anon, authenticated;

-- ── _pin_ok: PIN for everyone, and an approver's token counts ───────────────────────────────
do $po$
declare d text;
begin
  d := pg_get_functiondef('public._pin_ok(text,text)'::regprocedure);
  if position('(20261009163000)' in d) > 0 then raise notice '_pin_ok already patched'; return; end if;
  d := pg_temp._once(d,
$a$  if op is null then return true; end if;$a$,
$b$  if _mgr_token(p_approval) then return true; end if;  -- an approver's approval (20261009163000)
  if op is null then return not _biz_bool('pin_all'); end if;  -- pin_all: a device naming nobody may not approve (20261009163000)$b$);
  d := pg_temp._once(d,
$a$    return own is not null and lower(own) = lower(op);$a$,
$b$    return own is not null and lower(own) = lower(op) and not _biz_bool('pin_all');  -- pin_all: no PIN, no approval (20261009163000)$b$);
  d := pg_temp._once(d,
$a$  if h is null then return true; end if;$a$,
$b$  if h is null then return not _biz_bool('pin_all'); end if;  -- pin_all (20261009163000)$b$);
  execute d;
end $po$;

-- ── The manager's approval on refunds and price changes ─────────────────────────────────────
do $rr$
declare d text;
begin
  d := pg_get_functiondef('public.staff_refund_receipt(text,text,text,text,uuid)'::regprocedure);
  if position('(20261009163000)' in d) > 0 then raise notice 'staff_refund_receipt already asks for a manager'; return; end if;
  d := pg_temp._once(d,
$a$  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;$a$,
$b$  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if not _mgr_ok('refund', (select coalesce(sum(coalesce(c.qty, 0) * coalesce(c.price, 0)), 0) from cashier_sales c
                             where coalesce(c.receipt_id, c.id) = p_receipt_id and c.refunded_at is null and c.voided_at is null
                               and c.pay is distinct from 'house' and c.pay is distinct from 'refunded'
                               and c.category is distinct from '__cardmeta__'), p_approval) then
    raise exception 'MANAGER_REQUIRED' using errcode = '42501';  -- Settings > Business, approvals (20261009163000)
  end if;$b$);
  execute d;
end $rr$;

do $sp$
declare d text;
begin
  d := pg_get_functiondef('public.staff_set_price(text,numeric,text,text)'::regprocedure);
  if position('(20261009163000)' in d) > 0 then raise notice 'staff_set_price already asks for a manager'; return; end if;
  d := pg_temp._once(d,
$a$  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;$a$,
$b$  if q.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if not _mgr_ok('price', coalesce(q.price, 0) - p_price, p_approval) then
    raise exception 'MANAGER_REQUIRED' using errcode = '42501';  -- a cut over Settings' limit (20261009163000)
  end if;$b$);
  execute d;
end $sp$;

do $chk$
declare f text;
begin
  foreach f in array array['public._pin_ok(text,text)', 'public.staff_refund_receipt(text,text,text,text,uuid)',
                           'public.staff_set_price(text,numeric,text,text)'] loop
    if position('(20261009163000)' in pg_get_functiondef(f::regprocedure)) = 0 then raise exception '% was not patched', f; end if;
  end loop;
  foreach f in array array['public._pin_ok(text,text)', 'public.staff_refund_receipt(text,text,text,text,uuid)',
                           'public.staff_set_price(text,numeric,text,text)', 'public._mgr_ok(text,numeric,text)',
                           'public._mgr_token(text)', 'public._biz_bool(text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009163000', 'approvals')
on conflict (version) do nothing;

commit;
