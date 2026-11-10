-- ============================================================================
-- Keep my place: a rider still paying can ask for more time before the held place lets go (the Reserve research,
-- 2026-11-10, WCAG 2.2.1 Timing Adjustable; the user, 2026-11-11: "do them all").
--
-- A website booking paid now holds its places for pay.holdMinutes (15) while the rider pays (pay_booking_start,
-- 20261110150000); _pay_tick lets them go two minutes after the hold. The pay page warns before that and offers
-- Keep my place, which calls this:
--
--   pay_hold_extend(p_key, p_pay) -> the payment as pay_view gives it (_pay_json)
--     * the server key, as every pay_* function; payments on, the payment still 'initiated' and its hold not run out;
--     * the hold starts again from now, for pay.holdMinutes, but never past twice that from when the payment began
--       (a place is not held for ever): PAY_HOLD_MAX once that is reached;
--     * what the payment holds follows: the bookings' pay_hold_until, a store order's expires_at (a locker's hold is
--       the payment's own); the payment's log gets a 'customer' row with status 'extended' and the new time.
--
-- STAGING ONLY for now: production has no payments yet (20261110150000 is applied on staging alone). On a database
-- without the payments table this file does nothing but write its ledger row; run it again after 20261110150000.
-- Rollback: drop function if exists public.pay_hold_extend(text, uuid);
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $do$
begin
  if to_regclass('public.payments') is null then
    raise notice 'no payments table here (production before online payments): pay_hold_extend not created';
    return;
  end if;
  execute $f$
create or replace function public.pay_hold_extend(p_key text, p_pay uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare p payments%rowtype; mins int; until timestamptz;
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _pay_on('pay.enabled') then raise exception 'PAY_OFF' using errcode = 'P0001'; end if;
  select * into p from payments where id = p_pay for update;
  if p.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p.status <> 'initiated' or not coalesce(p.hold, false) or p.expires_at <= now() then
    raise exception 'PAY_NOT_OPEN' using errcode = 'P0001';
  end if;
  mins := _pay_int('pay.holdMinutes', 15, 5, 60);
  until := least(now() + make_interval(mins => mins), p.created_at + make_interval(mins => 2 * mins));
  if until <= p.expires_at then raise exception 'PAY_HOLD_MAX' using errcode = 'P0001'; end if;
  update payments set expires_at = until where id = p.id returning * into p;
  if p.kind = 'booking' then
    update queue_entries set pay_hold_until = until
     where id = any(p.refs) and payment_id = p.id and pay_hold_until is not null and not coalesce(paid, false);
  elsif p.kind = 'order' then
    update store_orders set expires_at = until where id::text = p.ref and status = 'pending';
  end if;
  perform _pay_event(p.id, 'customer', 'extended', null, 'held until ' || to_char(until at time zone 'Asia/Riyadh', 'HH24:MI:SS'));
  return _pay_json(p);
end $function$;
$f$;
  execute 'revoke all on function public.pay_hold_extend(text, uuid) from public';
  execute 'grant execute on function public.pay_hold_extend(text, uuid) to anon, authenticated';
  if not (select prosecdef from pg_proc where oid = 'public.pay_hold_extend(text,uuid)'::regprocedure) then
    raise exception 'pay_hold_extend is not SECURITY DEFINER';
  end if;
end $do$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111163000', 'pay_hold_extend')
on conflict (version) do nothing;

commit;
