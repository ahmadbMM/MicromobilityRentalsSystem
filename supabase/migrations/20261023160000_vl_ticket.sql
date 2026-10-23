-- ============================================================================
-- Victory Lap: a ticket, or buy one (the owner, 2026-10-23). Once a Victory Lap place is booked the
-- athlete is asked "Do you already have a ticket, or would you like to buy one?". Have one: nothing
-- more is asked. Buy one: the organiser's bank details (Sports Fitness Unit Company, Riyad Bank) and
-- their bank letter, then a picture of the transfer receipt; the receipt marks the booking paid
-- (pay_method 'transfer'), no staff check (the owner's pick). Places booked before this are asked on
-- their ticket only.
--
--  1. queue_entries.vl_ticket: 'have' | 'buy' (null = not answered), vl_ticket_at when answered,
--     vl_receipt_at when a receipt came in.
--  2. vl_receipts: the receipt picture (a data: URL, JPEG/PNG/WebP, under 3 MB), one per booking, read
--     by staff only (RLS); a customer writes it only through the RPC below.
--  3. customer_vl_ticket(p_id, p_token, p_entry_id, p_answer, p_img): the athlete answers for their
--     own live booking on a Victory Lap session (token-checked, definer). With a picture (answer
--     'buy') the receipt is stored and the booking marked paid by transfer.
--
-- Rollback:
--   drop function if exists public.customer_vl_ticket(text, text, text, text, text);
--   drop table if exists public.vl_receipts;
--   alter table public.queue_entries drop column if exists vl_ticket, drop column if exists vl_ticket_at,
--     drop column if exists vl_receipt_at;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';


/* -- 1. the athlete's answer ----------------------------------------------------------------- */
alter table public.queue_entries add column if not exists vl_ticket text;
alter table public.queue_entries add column if not exists vl_ticket_at text;
alter table public.queue_entries add column if not exists vl_receipt_at text;
alter table public.queue_entries drop constraint if exists queue_entries_vl_ticket_chk;
alter table public.queue_entries add constraint queue_entries_vl_ticket_chk
  check (vl_ticket is null or vl_ticket in ('have', 'buy'));
comment on column public.queue_entries.vl_ticket is
  'Victory Lap: the athlete already has a ticket (have) or buys one by bank transfer (buy); null = not answered (20261023160000).';
comment on column public.queue_entries.vl_ticket_at is 'When vl_ticket was answered, ISO UTC (20261023160000).';
comment on column public.queue_entries.vl_receipt_at is 'When the transfer receipt came in (vl_receipts), ISO UTC (20261023160000).';


/* -- 2. the receipt pictures ----------------------------------------------------------------- */
create table if not exists public.vl_receipts (
  entry_id text primary key references public.queue_entries (id) on delete cascade,
  customer_id text,
  img text not null,
  created_at timestamptz not null default now(),
  constraint vl_receipts_img_chk check (img ~ '^data:image/(jpeg|png|webp);base64,' and length(img) <= 3000000)
);
comment on table public.vl_receipts is
  'Victory Lap transfer receipts, one picture per booking; staff read them, customers write through customer_vl_ticket (20261023160000).';
alter table public.vl_receipts enable row level security;
revoke all on public.vl_receipts from anon, authenticated;
grant select, delete on public.vl_receipts to authenticated;
drop policy if exists vl_receipts_staff_read on public.vl_receipts;
create policy vl_receipts_staff_read on public.vl_receipts for select to authenticated using (is_staff());
drop policy if exists vl_receipts_staff_delete on public.vl_receipts;
create policy vl_receipts_staff_delete on public.vl_receipts for delete to authenticated using (is_staff());


/* -- 3. an athlete answers ------------------------------------------------------------------- */
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
    update queue_entries
       set vl_ticket = 'buy', vl_ticket_at = v_now, vl_receipt_at = v_now,
           paid = true, pay_method = 'transfer', card_amount = null
     where id = p_entry_id;
  else
    update queue_entries set vl_ticket = v_a, vl_ticket_at = v_now where id = p_entry_id;
  end if;
  return true;
end $function$;
revoke all on function public.customer_vl_ticket(text, text, text, text, text) from public;
grant execute on function public.customer_vl_ticket(text, text, text, text, text) to anon, authenticated;


/* -- checks ------------------------------------------------------------------------------------ */
do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.customer_vl_ticket(text,text,text,text,text)'::regprocedure
                   and p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'customer_vl_ticket is missing, or lost SECURITY DEFINER or its search_path';
  end if;
  if not has_function_privilege('anon', 'public.customer_vl_ticket(text,text,text,text,text)', 'execute') then
    raise exception 'a client grant is missing';
  end if;
  if has_table_privilege('anon', 'public.vl_receipts', 'select') or has_table_privilege('anon', 'public.vl_receipts', 'insert')
     or has_table_privilege('authenticated', 'public.vl_receipts', 'insert') then
    raise exception 'vl_receipts is open to a client';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.vl_receipts'::regclass) then
    raise exception 'vl_receipts has no RLS';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261023160000', 'vl_ticket')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
