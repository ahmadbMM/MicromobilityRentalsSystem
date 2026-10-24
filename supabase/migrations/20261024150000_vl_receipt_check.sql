-- ============================================================================
-- Victory Lap: staff confirm each receipt (the owner, 2026-10-24, decision sheet "vlreceipt": check).
--
-- customer_vl_ticket (20261023160000) marked a place paid by transfer the moment any receipt picture came
-- in, with no staff check (the owner's pick of 2026-10-23). The owner now wants staff to look at each one:
--   1. customer_vl_ticket keeps the picture (vl_receipts) and stamps vl_receipt_at, and no longer marks the
--      place paid. A new picture for a place staff had confirmed puts it back to be checked; a place paid
--      at the desk keeps its payment (the old function overwrote a desk payment with 'transfer').
--   2. staff_vl_receipt(p_entry_id, p_ok), new, staff only: ok marks the place paid by transfer
--      ('confirmed'); not ok sends the receipt back - vl_receipt_at cleared, the picture deleted, a
--      transfer payment undone - and the athlete is asked again ('returned'). A place already paid at the
--      desk is left as it is ('desk'); an id that is not a Victory Lap place with a receipt is 'missing'.
--   3. The places a picture alone marked paid before this wait for staff to confirm them now.
-- The app shows the athlete "Receipt sent" until staff confirm, and staff "Receipt to check" (roster chip,
-- race report, check-in panel); the website's ticket says the same.
--
-- customer_vl_ticket's body was read back from production on 2026-10-24 (md5 54bf96f64eb423b3da535d94f537f257,
-- 1504 characters) and matched 20261023160000; only the receipt branch changes. Same header and grants.
--
-- Rollback: run customer_vl_ticket from 20261023160000 again; drop function public.staff_vl_receipt(text, boolean).
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.customer_vl_ticket(p_id text, p_token text, p_entry_id text, p_answer text, p_img text default null)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_a text := lower(btrim(coalesce(p_answer, '')));
  v_img text := nullif(btrim(coalesce(p_img, '')), '');
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if v_a not in ('have', 'buy') or (v_img is not null and v_a <> 'buy') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'vl_ticket';
  end if;
  if v_img is not null and (v_img !~ '^data:image/(jpeg|png|webp);base64,' or length(v_img) > 3000000) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'vl_receipt';
  end if;
  perform 1
    from queue_entries x join sessions s on s.id = x.session_id
   where x.id = p_entry_id
     and x.customer_id = p_id
     and coalesce(s.ride_kind, '') = 'vlap'
     and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow')
   for update of x;
  if not found then return false; end if;
  if v_img is not null then
    insert into vl_receipts (entry_id, customer_id, img) values (p_entry_id, p_id, v_img)
    on conflict (entry_id) do update set img = excluded.img, customer_id = excluded.customer_id, created_at = now();
    -- the receipt waits for staff (staff_vl_receipt); a transfer they had confirmed waits again for the new picture
    update queue_entries
       set vl_ticket = 'buy', vl_ticket_at = v_now, vl_receipt_at = v_now,
           paid = case when pay_method = 'transfer' then false else paid end,
           pay_method = case when pay_method = 'transfer' then null else pay_method end
     where id = p_entry_id;
  else
    update queue_entries set vl_ticket = v_a, vl_ticket_at = v_now where id = p_entry_id;
  end if;
  return true;
end $function$;
revoke all on function public.customer_vl_ticket(text, text, text, text, text) from public;
grant execute on function public.customer_vl_ticket(text, text, text, text, text) to anon, authenticated;

create or replace function public.staff_vl_receipt(p_entry_id text, p_ok boolean)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_paid boolean;
  v_method text;
  v_rc text;
begin
  if not coalesce((select public.is_staff()), false) then
    raise exception 'STAFF_ONLY: staff only' using errcode = '42501';
  end if;
  select coalesce(x.paid, false), x.pay_method, x.vl_receipt_at
    into v_paid, v_method, v_rc
    from queue_entries x join sessions s on s.id = x.session_id
   where x.id = p_entry_id and coalesce(s.ride_kind, '') = 'vlap'
   for update of x;
  if not found or v_rc is null then return 'missing'; end if;
  if coalesce(p_ok, false) then
    if v_paid and coalesce(v_method, '') <> 'transfer' then return 'desk'; end if;
    update queue_entries set paid = true, pay_method = 'transfer', card_amount = null where id = p_entry_id;
    return 'confirmed';
  end if;
  update queue_entries
     set vl_receipt_at = null,
         paid = case when pay_method = 'transfer' then false else paid end,
         pay_method = case when pay_method = 'transfer' then null else pay_method end
   where id = p_entry_id;
  delete from vl_receipts where entry_id = p_entry_id;
  return 'returned';
end $function$;
revoke all on function public.staff_vl_receipt(text, boolean) from public, anon;
grant execute on function public.staff_vl_receipt(text, boolean) to authenticated;

-- the places a picture alone marked paid, before staff could check one, wait for staff now
update queue_entries q
   set paid = false, pay_method = null
  from sessions s
 where s.id = q.session_id
   and coalesce(s.ride_kind, '') = 'vlap'
   and q.pay_method = 'transfer';

do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.customer_vl_ticket(text,text,text,text,text)'::regprocedure
                   and p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'customer_vl_ticket is missing, or lost SECURITY DEFINER or its search_path';
  end if;
  if position('paid = true' in (select prosrc from pg_proc where oid = 'public.customer_vl_ticket(text,text,text,text,text)'::regprocedure)) > 0 then
    raise exception 'customer_vl_ticket still marks a receipt paid';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.staff_vl_receipt(text,boolean)'::regprocedure
                   and p.prosecdef and 'search_path=public' = any(coalesce(p.proconfig, '{}'))) then
    raise exception 'staff_vl_receipt is missing, or lost SECURITY DEFINER or its search_path';
  end if;
  if has_function_privilege('anon', 'public.staff_vl_receipt(text,boolean)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_vl_receipt(text,boolean)', 'execute')
     or not has_function_privilege('anon', 'public.customer_vl_ticket(text,text,text,text,text)', 'execute') then
    raise exception 'the receipt functions are open to the wrong roles';
  end if;
  if exists (select 1 from queue_entries q join sessions s on s.id = q.session_id
              where coalesce(s.ride_kind, '') = 'vlap' and q.pay_method = 'transfer') then
    raise exception 'a place a picture alone marked paid is still paid';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261024150000', 'vl_receipt_check')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
