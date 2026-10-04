-- ─────────────────────────────────────────────────────────────────────────────
-- 20261004150000 - the staff sales outbox's RPCs answer a replay once (idempotency)
--
-- The staff app queues a receipt void or refund in its sales outbox when the call
-- cannot reach the server, and sends it again until one answer comes back. A call
-- that LANDED but whose answer was lost (a dead Wi-Fi hop, a timeout) is therefore
-- sent a second time. Today that second call:
--   * re-checks the PIN approval, which has usually expired by then - the op is
--     refused (PIN_REQUIRED) on every flush and the "pending sync" chip never clears;
--   * answers count 0 / items [] instead of what the first call did.
--
-- 1. rpc_receipts: one row per (signed-in user, op id) holding the function's
--    answer. RLS on and NO grants: only the SECURITY DEFINER functions below read
--    or write it. Rows older than 7 days are pruned from inside the functions
--    (about one call in fifty); no cron needed. An outbox op older than a week is
--    no longer retried by any device (the operator discards stuck ops).
-- 2. staff_void_receipt and staff_refund_receipt take an optional p_op_id uuid
--    (default null). When given, the function claims it first with
--    INSERT ... ON CONFLICT DO NOTHING RETURNING; when the claim already exists it
--    returns the stored answer without running again (and without the PIN check:
--    the receipt proves this same user passed it for this same op). A refusal
--    (PIN_REQUIRED, NOT_FOUND) raises and rolls the claim back with everything
--    else, so only a call that succeeded is remembered. A concurrent replay waits
--    on the primary key until the first commits, then reads its answer.
--    The old 4-argument versions are dropped, not overloaded: two candidates for a
--    4-argument call would be ambiguous to PostgREST. A client from before this
--    migration calls with 4 named arguments and gets the new function with
--    p_op_id null - exactly the old behaviour. A newer client against a database
--    without this migration gets PGRST202 for p_op_id and asks again without it.
--
-- Bodies and headers copied from production with pg_get_functiondef on
-- 2026-10-04 (SECURITY DEFINER, SET search_path TO 'public', plpgsql, volatile);
-- grants as they were: EXECUTE to authenticated only.
-- After applying: run supabase/checks/security-attributes.sql (both functions are
-- listed there as definer) - it must print nothing.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.rpc_receipts (
  user_id    uuid        not null,
  op_id      uuid        not null,
  fn         text        not null,
  result     jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, op_id)
);
alter table public.rpc_receipts enable row level security;
revoke all on table public.rpc_receipts from public, anon, authenticated;
create index if not exists rpc_receipts_created_at_idx on public.rpc_receipts (created_at);
comment on table public.rpc_receipts is
  'Answers of outbox RPCs by (auth user, op id), so a replayed call is answered once (20261004150000). No grants: written by staff_void_receipt / staff_refund_receipt only; pruned after 7 days inside them.';

drop function if exists public.staff_void_receipt(text, text, text, text);
drop function if exists public.staff_refund_receipt(text, text, text, text);

CREATE OR REPLACE FUNCTION public.staff_void_receipt(p_receipt_id text, p_reason text, p_op text, p_approval text, p_op_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  n int; items jsonb; v_uid uuid := auth.uid(); v_claimed int; v_prior jsonb; v_res jsonb;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_op_id is not null and v_uid is not null then
    insert into rpc_receipts (user_id, op_id, fn) values (v_uid, p_op_id, 'staff_void_receipt')
      on conflict do nothing returning 1 into v_claimed;
    if v_claimed is null then
      select result into v_prior from rpc_receipts where user_id = v_uid and op_id = p_op_id;
      return coalesce(v_prior, jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'count', 0, 'items', '[]'::jsonb)) || jsonb_build_object('replayed', true);
    end if;
    if random() < 0.02 then delete from rpc_receipts where created_at < now() - interval '7 days'; end if;
  end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if p_receipt_id is null or not exists (select 1 from cashier_sales where coalesce(receipt_id, id) = p_receipt_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  with u as (
    update cashier_sales
       set voided_at = now(),
           voided_by = left(nullif(btrim(coalesce(p_op, '')), ''), 40),
           void_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 300)
     where coalesce(receipt_id, id) = p_receipt_id and voided_at is null
     returning id, item_id, qty, name, category, pay, price)
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'item_id', item_id, 'qty', qty, 'name', name,
                                               'category', category, 'pay', pay, 'price', price)), '[]'::jsonb)
    into n, items from u;
  v_res := jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'count', n, 'items', items);
  if v_claimed is not null then
    update rpc_receipts set result = v_res where user_id = v_uid and op_id = p_op_id;
  end if;
  return v_res;
end $function$;

CREATE OR REPLACE FUNCTION public.staff_refund_receipt(p_receipt_id text, p_reason text, p_op text, p_approval text, p_op_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  n int; items jsonb; v_uid uuid := auth.uid(); v_claimed int; v_prior jsonb; v_res jsonb;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_op_id is not null and v_uid is not null then
    insert into rpc_receipts (user_id, op_id, fn) values (v_uid, p_op_id, 'staff_refund_receipt')
      on conflict do nothing returning 1 into v_claimed;
    if v_claimed is null then
      select result into v_prior from rpc_receipts where user_id = v_uid and op_id = p_op_id;
      return coalesce(v_prior, jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'count', 0, 'items', '[]'::jsonb)) || jsonb_build_object('replayed', true);
    end if;
    if random() < 0.02 then delete from rpc_receipts where created_at < now() - interval '7 days'; end if;
  end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if p_receipt_id is null or not exists (select 1 from cashier_sales where coalesce(receipt_id, id) = p_receipt_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  with u as (
    update cashier_sales
       set pay = 'refunded',
           refunded_at = now(),
           refunded_by = left(nullif(btrim(coalesce(p_op, '')), ''), 40),
           refund_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 300)
     where coalesce(receipt_id, id) = p_receipt_id
       and refunded_at is null and voided_at is null and pay is distinct from 'refunded'
     returning id, item_id, qty, name, category, price)
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'item_id', item_id, 'qty', qty, 'name', name,
                                               'category', category, 'price', price)), '[]'::jsonb)
    into n, items from u;
  v_res := jsonb_build_object('ok', true, 'receipt_id', p_receipt_id, 'count', n, 'items', items);
  if v_claimed is not null then
    update rpc_receipts set result = v_res where user_id = v_uid and op_id = p_op_id;
  end if;
  return v_res;
end $function$;

revoke all on function public.staff_void_receipt(text, text, text, text, uuid) from public, anon;
revoke all on function public.staff_refund_receipt(text, text, text, text, uuid) from public, anon;
grant execute on function public.staff_void_receipt(text, text, text, text, uuid) to authenticated;
grant execute on function public.staff_refund_receipt(text, text, text, text, uuid) to authenticated;

notify pgrst, 'reload schema';

commit;
