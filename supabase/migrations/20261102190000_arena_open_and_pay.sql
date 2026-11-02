-- ============================================================================
-- The Arena Heros Hybrid Race: paid by transfer, open to everyone, a partner required (the owner, 2026-11-02: "do
-- what you did with victory lap payment wise to arena heroes ... make the event open to everyone not only community
-- members and clearly tell them that they have to have a partner in order to participate, dont show them a qr code or
-- number of booking until they pay").
--
--  1. customer_vl_ticket: the athlete's receipt on an Arena place too (kept in vl_receipts, waiting for staff, as on
--     Victory Lap). The Arena race has no 'have': a place is paid or it is not, so that answer is refused.
--  2. staff_vl_receipt, staff_vl_receipt_put: staff confirm, send back or upload a receipt on an Arena place too.
--  3. The session 2026-11-06-ah: open_to_all (_community_booking_gate then lets every account book, unchanged) and
--     vl.pair false (no "Find me a partner": the race settings' own switch, staff can turn it back on).
-- _mt_core already leaves pay_method 'transfer' out of the takings, of any kind. The QR code and the number are held
-- back by the app and the website (_arHold), which read queue_entries.paid.
--
-- Each function is its live body (read back from production 2026-11-02: customer_vl_ticket md5
-- 7486074a9443d2a74df1e8a72df338a7, staff_vl_receipt 1f2eee6d1d21439fe7a3daf3e015fbd3, staff_vl_receipt_put
-- 432cf91d42a5f579d9d787ed5364c5e2) with only the lines above changed. Same headers and grants.
--
-- Rollback: run the functions from 20261024150000 (customer_vl_ticket, staff_vl_receipt) and 20261025150000
-- (staff_vl_receipt_put) again, and
--   update sessions set open_to_all = false, vl = vl || '{"pair":true}' where id = '2026-11-06-ah';
-- Run supabase/checks/security-attributes.sql after.
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
  v_kind text;
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if v_a not in ('have', 'buy') or (v_img is not null and v_a <> 'buy') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'vl_ticket';
  end if;
  if v_img is not null and (v_img !~ '^data:image/(jpeg|png|webp);base64,' or length(v_img) > 3000000) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'vl_receipt';
  end if;
  select s.ride_kind into v_kind
    from queue_entries x join sessions s on s.id = x.session_id
   where x.id = p_entry_id
     and x.customer_id = p_id
     and coalesce(s.ride_kind, '') in ('vlap', 'arena')
     and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow')
   for update of x;
  if not found then return false; end if;
  -- the Arena race has no "I already have a ticket": the QR code and the number wait for the payment
  if v_kind = 'arena' and v_a = 'have' then return false; end if;
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
   where x.id = p_entry_id and coalesce(s.ride_kind, '') in ('vlap', 'arena')
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
     and coalesce(s.ride_kind, '') in ('vlap', 'arena')
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

update public.sessions
   set open_to_all = true,
       vl = coalesce(vl, '{}'::jsonb) || '{"pair":false}'::jsonb
 where id = '2026-11-06-ah' and ride_kind = 'arena';

do $chk$
declare f text;
begin
  foreach f in array array['customer_vl_ticket(text,text,text,text,text)', 'staff_vl_receipt(text,boolean)', 'staff_vl_receipt_put(text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = ('public.' || f)::regprocedure
                     and p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
                     and position('''arena''' in p.prosrc) > 0) then
      raise exception '% is missing, lost SECURITY DEFINER or its search_path, or does not take the Arena race', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.staff_vl_receipt(text,boolean)', 'execute')
     or has_function_privilege('anon', 'public.staff_vl_receipt_put(text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_vl_receipt(text,boolean)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_vl_receipt_put(text,text)', 'execute')
     or not has_function_privilege('anon', 'public.customer_vl_ticket(text,text,text,text,text)', 'execute') then
    raise exception 'the receipt functions are open to the wrong roles';
  end if;
  if not exists (select 1 from sessions where id = '2026-11-06-ah' and open_to_all is true and (vl->>'pair') = 'false') then
    raise exception 'the Arena session is not open to all, or still offers a partner';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261102190000', 'arena_open_and_pay')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
