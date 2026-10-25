-- ============================================================================
-- Victory Lap: staff upload a booking's receipt (the owner, 2026-10-25: "add a way staff can upload the
-- receipt of the bookings for victory lap").
--
-- staff_vl_receipt_put(p_entry_id, p_img), new, staff only: keeps the picture in vl_receipts (one per
-- booking, the same shape customer_vl_ticket stores) and stamps vl_ticket 'buy' / vl_receipt_at. Staff
-- looked at the transfer themselves, so the place is marked paid by transfer straight away ('confirmed'),
-- except a place already paid at the desk, which keeps its payment and only gains the picture ('desk').
-- An id that is not a live Victory Lap place is 'missing'.
--
-- Rollback: drop function public.staff_vl_receipt_put(text, text);
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.staff_vl_receipt_put(p_entry_id text, p_img text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_img text := nullif(btrim(coalesce(p_img, '')), '');
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_paid boolean;
  v_method text;
  v_cust text;
begin
  if not coalesce((select public.is_staff()), false) then
    raise exception 'STAFF_ONLY: staff only' using errcode = '42501';
  end if;
  if v_img is null or v_img !~ '^data:image/(jpeg|png|webp);base64,' or length(v_img) > 3000000 then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'vl_receipt';
  end if;
  select coalesce(x.paid, false), x.pay_method, x.customer_id
    into v_paid, v_method, v_cust
    from queue_entries x join sessions s on s.id = x.session_id
   where x.id = p_entry_id
     and coalesce(s.ride_kind, '') = 'vlap'
     and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow')
   for update of x;
  if not found then return 'missing'; end if;
  insert into vl_receipts (entry_id, customer_id, img) values (p_entry_id, v_cust, v_img)
  on conflict (entry_id) do update set img = excluded.img, customer_id = excluded.customer_id, created_at = now();
  if v_paid and coalesce(v_method, '') <> 'transfer' then
    update queue_entries set vl_ticket = 'buy', vl_ticket_at = v_now, vl_receipt_at = v_now where id = p_entry_id;
    return 'desk';
  end if;
  update queue_entries
     set vl_ticket = 'buy', vl_ticket_at = v_now, vl_receipt_at = v_now,
         paid = true, pay_method = 'transfer', card_amount = null
   where id = p_entry_id;
  return 'confirmed';
end $function$;
revoke all on function public.staff_vl_receipt_put(text, text) from public, anon;
grant execute on function public.staff_vl_receipt_put(text, text) to authenticated;

do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.staff_vl_receipt_put(text,text)'::regprocedure
                   and p.prosecdef and 'search_path=public' = any(coalesce(p.proconfig, '{}'))) then
    raise exception 'staff_vl_receipt_put is missing, or lost SECURITY DEFINER or its search_path';
  end if;
  if has_function_privilege('anon', 'public.staff_vl_receipt_put(text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_vl_receipt_put(text,text)', 'execute') then
    raise exception 'staff_vl_receipt_put is open to the wrong roles';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261025150000', 'vl_staff_receipt')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
