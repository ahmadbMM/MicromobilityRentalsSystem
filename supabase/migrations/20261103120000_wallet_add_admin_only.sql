-- ============================================================================
-- Only an admin adds money to a wallet (the owner, 2026-11-03: "allow only admins from staff to add money to the
-- wallet"). staff_wallet_change refuses a plus from anyone else with ADMIN_ONLY, whichever way it is written:
-- money taken or none. A minus (taking out) and a refund into a wallet keep what they ask: can_refund, the PIN and
-- the manager limit. Header as in 20261102210000. The body otherwise as applied (md5 c44ebad4acda2d1f8d813b2ba1bc787f).
-- Rollback: re-run the staff_wallet_change block of 20261102210000. Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.staff_wallet_change(p_customer text, p_amount numeric, p_method text, p_note text,
                                                      p_session text default null, p_op text default null,
                                                      p_approval text default null, p_op_id uuid default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_uid uuid := auth.uid(); v_claimed int; v_prior jsonb; v_res jsonb; who text; amt numeric := round(p_amount, 2); b numeric;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
  if amt > 0 and not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;  -- the owner, 2026-11-03
  if amt is null or amt = 0 or abs(amt) > 10000 then raise exception 'WALLET_AMOUNT' using errcode = 'P0001'; end if;
  if p_method is null or p_method not in ('card', 'cash', 'transfer', 'none') then raise exception 'WALLET_METHOD' using errcode = 'P0001'; end if;
  if p_method = 'none' and nullif(btrim(coalesce(p_note, '')), '') is null then raise exception 'WALLET_NOTE' using errcode = 'P0001'; end if;
  if p_op_id is not null and v_uid is not null then
    insert into rpc_receipts (user_id, op_id, fn) values (v_uid, p_op_id, 'staff_wallet_change')
      on conflict do nothing returning 1 into v_claimed;
    if v_claimed is null then
      select result into v_prior from rpc_receipts where user_id = v_uid and op_id = p_op_id;
      return coalesce(v_prior, jsonb_build_object('ok', true)) || jsonb_build_object('replayed', true);
    end if;
  end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if not _mgr_ok('refund', abs(amt), p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  who := _wallet_owner(p_customer);
  if who is null or not exists (select 1 from customers where id = who) then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  perform set_config('mm.wallet_op', coalesce(p_op, ''), true);
  perform set_config('mm.wallet_note', coalesce(p_note, ''), true);
  b := _wallet_post(who, amt, case when p_method = 'none' then 'adjust' when amt > 0 then 'topup' else 'takeout' end,
                    nullif(p_method, 'none'), null, null, null, nullif(btrim(coalesce(p_session, '')), ''));
  perform set_config('mm.wallet_note', '', true);
  v_res := jsonb_build_object('ok', true, 'customer_id', who, 'balance', b);
  if v_claimed is not null then
    update rpc_receipts set result = v_res where user_id = v_uid and op_id = p_op_id;
  end if;
  return v_res;
end $$;
revoke all on function public.staff_wallet_change(text, numeric, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.staff_wallet_change(text, numeric, text, text, text, text, text, uuid) to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261103120000', 'wallet_add_admin_only')
on conflict (version) do nothing;

commit;
