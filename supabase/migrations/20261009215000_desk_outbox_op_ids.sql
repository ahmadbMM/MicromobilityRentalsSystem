-- ─────────────────────────────────────────────────────────────────────────────
-- 20261009215000 - the desk outbox: staff_checkin and staff_return answer a replay once
--
-- The staff app now keeps check-ins and returns made while the booth is offline in a
-- desk outbox (IndexedDB) and sends them when the connection comes back, again and
-- again until one answer arrives. A call that LANDED but whose answer was lost is
-- therefore sent a second time, sometimes after another desk has moved the rider on
-- (returned them, undone the check-in): the second call then raised
-- BAD_BOOKING_STATE and the row read "Needs attention" for a check-in that had worked.
--
-- Both functions take an optional p_op_id uuid (default null), exactly as
-- staff_void_receipt / staff_refund_receipt do since 20261004150000: the op id is
-- claimed first in rpc_receipts (insert ... on conflict do nothing); a claim that
-- already exists answers the stored answer (or {ok, noop}) with replayed:true and runs
-- nothing. A refusal raises and rolls the claim back with everything else, so only a
-- call that succeeded is remembered and a conflict (bike taken meanwhile) is said on
-- every replay.
--
-- The live definitions are patched as text (pg_get_functiondef keeps SECURITY DEFINER,
-- SET search_path and the volatility; any body change another migration made is kept).
-- The parameter list grows by one, so the old signature is dropped after the new one is
-- made: two candidates for the same named call would be ambiguous to PostgREST. A client
-- from before this calls with its named arguments and gets p_op_id null - the old
-- behaviour; this client against a database without it gets PGRST202 / 42883 for
-- p_op_id and asks again without it (_rpcOp).
-- Grants as they were (2026-10-09, read-only check of production): EXECUTE to
-- authenticated (and service_role for staff_checkin), nothing for anon/public.
-- Replacement text carries only /* */ comments (a line comment could swallow the rest
-- of a live line).
-- After applying: run supabase/checks/security-attributes.sql - it must print nothing.
-- ─────────────────────────────────────────────────────────────────────────────

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

-- ── staff_checkin ───────────────────────────────────────────────────────────────
do $ci$
declare d text;
begin
  if to_regprocedure('public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid)') is not null then
    raise notice 'staff_checkin already takes p_op_id'; return;
  end if;
  d := pg_get_functiondef('public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text)'::regprocedure);
  d := pg_temp._once(d,
$a$p_ride_group text DEFAULT NULL::text)$a$,
$b$p_ride_group text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)$b$);
  d := pg_temp._once(d,
$a$declare q public.queue_entries%rowtype;$a$,
$b$declare v_uid uuid := auth.uid(); v_claimed int; v_prior jsonb; v_res jsonb; q public.queue_entries%rowtype;$b$);
  d := pg_temp._once(d,
$a$  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;$a$,
$b$  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  /* the desk outbox's op id (20261009215000): a replay of a call that landed is answered from its receipt */
  if p_op_id is not null and v_uid is not null then
    insert into rpc_receipts (user_id, op_id, fn) values (v_uid, p_op_id, 'staff_checkin')
      on conflict do nothing returning 1 into v_claimed;
    if v_claimed is null then
      select result into v_prior from rpc_receipts where user_id = v_uid and op_id = p_op_id;
      return coalesce(v_prior, jsonb_build_object('ok', true, 'noop', true)) || jsonb_build_object('replayed', true);
    end if;
    if random() < 0.02 then delete from rpc_receipts where created_at < now() - interval '7 days'; end if;
  end if;$b$);
  d := pg_temp._once(d,
$a$  return jsonb_build_object('ok', true, 'noop', false, 'assignment_id', first_a,$a$,
$b$  v_res := jsonb_build_object('ok', true, 'noop', false, 'assignment_id', first_a,$b$);
  d := pg_temp._once(d,
$a$'reservation_dropped', dropped);$a$,
$b$'reservation_dropped', dropped);
  if v_claimed is not null then update rpc_receipts set result = v_res where user_id = v_uid and op_id = p_op_id; end if;
  return v_res;$b$);
  execute d;
  drop function public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text);
end $ci$;

-- ── staff_return ────────────────────────────────────────────────────────────────
do $rt$
declare d text;
begin
  if to_regprocedure('public.staff_return(text,text,text,uuid)') is not null then
    raise notice 'staff_return already takes p_op_id'; return;
  end if;
  d := pg_get_functiondef('public.staff_return(text,text,text)'::regprocedure);
  d := pg_temp._once(d,
$a$p_notes text DEFAULT NULL::text)$a$,
$b$p_notes text DEFAULT NULL::text, p_op_id uuid DEFAULT NULL::uuid)$b$);
  d := pg_temp._once(d,
$a$declare q public.queue_entries%rowtype;$a$,
$b$declare v_uid uuid := auth.uid(); v_claimed int; v_prior jsonb; v_res jsonb; q public.queue_entries%rowtype;$b$);
  d := pg_temp._once(d,
$a$  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;$a$,
$b$  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  /* the desk outbox's op id (20261009215000), as staff_checkin */
  if p_op_id is not null and v_uid is not null then
    insert into rpc_receipts (user_id, op_id, fn) values (v_uid, p_op_id, 'staff_return')
      on conflict do nothing returning 1 into v_claimed;
    if v_claimed is null then
      select result into v_prior from rpc_receipts where user_id = v_uid and op_id = p_op_id;
      return coalesce(v_prior, jsonb_build_object('ok', true, 'noop', true)) || jsonb_build_object('replayed', true);
    end if;
    if random() < 0.02 then delete from rpc_receipts where created_at < now() - interval '7 days'; end if;
  end if;$b$);
  d := pg_temp._once(d,
$a$  return jsonb_build_object('ok', true, 'noop', false, 'bikes_freed', n, 'held', v_held, 'bike_status', v_status);$a$,
$b$  v_res := jsonb_build_object('ok', true, 'noop', false, 'bikes_freed', n, 'held', v_held, 'bike_status', v_status);
  if v_claimed is not null then update rpc_receipts set result = v_res where user_id = v_uid and op_id = p_op_id; end if;
  return v_res;$b$);
  execute d;
  drop function public.staff_return(text,text,text);
end $rt$;

revoke all on function public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid) from public, anon;
revoke all on function public.staff_return(text,text,text,uuid) from public, anon;
grant execute on function public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid) to authenticated, service_role;
grant execute on function public.staff_return(text,text,text,uuid) to authenticated;

-- ── Checks ──────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public.staff_checkin(text,text,boolean,numeric,text,numeric,text,text,uuid)', 'public.staff_return(text,text,text,uuid)'] loop
    if not (select prosecdef from pg_proc where oid = f::regprocedure) then raise exception '% lost SECURITY DEFINER', f; end if;
    if not exists (select 1 from pg_proc where oid = f::regprocedure and proconfig @> array['search_path=public']) then raise exception '% lost its search_path', f; end if;
    if has_function_privilege('anon', f, 'execute') then raise exception '% is callable by anon', f; end if;
  end loop;
end $chk$;

comment on table public.rpc_receipts is
  'Answers of outbox RPCs by (auth user, op id), so a replayed call is answered once (20261004150000; staff_checkin / staff_return since 20261009215000). No grants: written by the definer RPCs only; pruned after 7 days inside them.';

notify pgrst, 'reload schema';


insert into supabase_migrations.schema_migrations (version, name)
values ('20261009215000', 'desk_outbox_op_ids') on conflict (version) do nothing;
commit;
