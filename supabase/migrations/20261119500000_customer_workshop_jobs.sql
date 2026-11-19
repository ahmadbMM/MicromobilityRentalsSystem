-- ============================================================================
-- customer_workshop_jobs(p_id, p_token): the signed-in rider's own workshop appointments (the user, 2026-11-19: "make
-- sure to have a page or dedicated space for purchases and workshop appointments and unified place to have all
-- upcoming appointments for everything"). micromobility.sa/account/workshop lists them, upcoming and past, and
-- micromobility.sa/bookings puts the upcoming ones among the rider's other bookings.
--
-- Only the rows linked to the account (workshop_jobs.customer_id: a request sent while signed in, workshop_request; the
-- account merge moves them with the account). Never matched by phone: staff may reuse one phone on several accounts.
-- What a rider sees and nothing else: the reference (W-0042), the status, the service's name, the day and time asked
-- for, the time staff booked, how it is handed over (lane), the prices, when it was sent, the bike as the rider wrote it.
-- Never staff_notes, the mechanic, the parts used, the payment or who changed it.
--
-- A wrong or ended session gets BAD_TOKEN (28000), as customer_purchases does; the website then shows the page empty.
-- Read-only (stable). Newest first, at most 100.
--
-- Rollback: drop function if exists public.customer_workshop_jobs(text, text);
-- Idempotent.
-- ============================================================================

begin;

create or replace function public.customer_workshop_jobs(p_id text, p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then
    raise exception 'BAD_TOKEN' using errcode = '28000';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', j.id,
             'ref', 'W-' || lpad(j.id::text, 4, '0'),
             'status', j.status,
             'service', coalesce(j.service_label, j.service),
             'preferred_date', j.preferred_date,
             'preferred_time', j.preferred_time,
             'scheduled_for', j.scheduled_for,
             'lane', j.lane,
             'price_quoted', j.price_quoted,
             'price_final', j.price_final,
             'bike', j.bike,
             'created_at', j.created_at)
           order by j.created_at desc, j.id desc)
      from (select * from workshop_jobs w where w.customer_id = p_id order by w.created_at desc, w.id desc limit 100) j
  ), '[]'::jsonb);
end $function$;

revoke all on function public.customer_workshop_jobs(text, text) from public;
grant execute on function public.customer_workshop_jobs(text, text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name) values ('20261119500000', 'customer_workshop_jobs') on conflict do nothing;

commit;

-- Check after applying (expects: security definer true, search_path set, anon may execute):
--   select p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute')
--     from pg_proc p where p.proname = 'customer_workshop_jobs';
