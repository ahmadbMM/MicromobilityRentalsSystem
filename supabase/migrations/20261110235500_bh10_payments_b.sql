-- ============================================================================
-- Bug hunt 2026-11-10 (bh10), round two: online payments and the store. STAGING ONLY for now, like
-- 20261110235200_bh10_payments.sql, which must be applied first (this file patches three of its functions and
-- stops if it is not in the ledger). When payments go live, both go to production in order.
--
-- 1. staff_store_order_cancel: the refund it left owed for a card-paid order was the payment less its card refunds
--    done. A refund already made into the wallet, one on its way to the card, one that failed (for a retry) or one
--    already owed was owed a second time, so the order sheet and Payments > Owed showed more than
--    staff_pay_refund_begin lets go (PAY_TOO_MUCH until staff typed a lower amount). It now owes what is left after
--    all of those, counted on the order's own Moyasar payment as staff_pay_refund_begin counts them, and owes nothing
--    when nothing is left; an order already refunded whole before the cancel is marked 'refunded', as the other two
--    refund paths do.
-- 2. pay_booking_start: when the wallet left the card less than Moyasar's 1 SAR (199.50 in the wallet against two
--    rides of 100), the start failed with PAY_TOO_SMALL every time, and the website then undid a booking whose payment
--    is required. The wallet now gives back, from the bookings it paid in part, what makes the card's part 1 SAR, as
--    store_checkout does since 20261110235200. customer_wallet_pay and _wallet_pay_row (shared with production) are
--    not changed.
-- 3. pay_refund_done and staff_pay_refund_begin: a workshop job paid online stayed 'paid' after its payment was
--    refunded, so Take payment stayed hidden and the tracker refused a new payment. When the payment is refunded
--    whole (card and wallet together), the job is to pay again, as a voided or refunded till receipt leaves it
--    (20261110235300). A part refund leaves it paid.
-- 4. pay_reconcile_list: it listed every pending card refund of a Moyasar payment at once, each with its own
--    'already' that counts the pending ones before it. The website now confirms a payment's listed refunds together
--    from the largest 'already' upwards, so a refund that went through was marked failed (two of 100, one sent:
--    both failed, and a retry pays twice). It now lists one pending refund per Moyasar payment, the oldest, so its
--    'already' is only the refunds done and every reading of it agrees; the next is judged on the next run. It also
--    waits while another refund of that payment is still being sent (younger than the two-minute grace), so
--    Moyasar's total is never read with a refund in flight in it.
--
-- Every change is a patch of the definition in force (pg_get_functiondef): each anchor must occur exactly once,
-- and a function already holding this file's mark (20261110235500) is left alone, so a re-run changes nothing.
-- CREATE OR REPLACE keeps the grants. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $pre$
begin
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261110235200') then
    raise exception 'apply 20261110235200_bh10_payments.sql first: this file patches its pay_refund_done, staff_pay_refund_begin and pay_reconcile_list';
  end if;
end $pre$;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


-- ── 1. staff_store_order_cancel: owes only what is still owed ────────────────────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef('public.staff_store_order_cancel(uuid,text,text,text)'::regprocedure) into d;
  if position('(20261110235500)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$declare o store_orders%rowtype; p payments%rowtype; who text;
$a$,
$b$declare o store_orders%rowtype; p payments%rowtype; who text; owed numeric;
$b$);
  d := pg_temp._once(d,
$a$  select * into p from payments where id = o.payment_id;
  if p.status in ('paid', 'partly_refunded') and p.amount - p.refunded > 0 then
    insert into payment_refunds (payment_id, provider_id, amount, status, reason, order_id, by_user, by_name)
    values (p.id, p.provider_id, p.amount - p.refunded, 'due', left(coalesce(p_reason, 'order cancelled'), 200), o.id, auth.uid(), left(who, 60));
  end if;
$a$,
$b$  select * into p from payments where id = o.payment_id;
  /* owed: the card's money less what came back or is on its way, on the order's own Moyasar payment, as
     staff_pay_refund_begin counts it: card refunds done (p.refunded), being sent, failed (for a retry), wallet
     refunds done, and refunds already owed. Nothing when nothing is left; an order refunded whole before the cancel
     is 'refunded', as pay_refund_done and staff_pay_refund_begin leave it (bug hunt 2026-11-10 (20261110235500): it
     was p.amount - p.refunded, so those were owed a second time) */
  if p.status in ('paid', 'partly_refunded') then
    owed := round(p.amount - p.refunded - coalesce((select sum(x.amount) from payment_refunds x
              where x.payment_id = p.id and x.provider_id is not distinct from p.provider_id
                and ((x.status = 'pending' and x.dest = 'card') or (x.status = 'done' and x.dest = 'wallet')
                     or x.status in ('due', 'failed'))), 0), 2);
    if owed > 0 then
      insert into payment_refunds (payment_id, provider_id, amount, status, reason, order_id, by_user, by_name)
      values (p.id, p.provider_id, owed, 'due', left(coalesce(p_reason, 'order cancelled'), 200), o.id, auth.uid(), left(who, 60));
    elsif (select coalesce(sum(x.amount), 0) from payment_refunds x where x.order_id = o.id and x.status = 'done' and x.dest in ('card', 'wallet'))
          >= o.total - o.wallet_paid then
      update store_orders set status = 'refunded' where id = o.id and status = 'cancelled' returning * into o;
    end if;
  end if;
$b$);
  execute d;
end $do$;


-- ── 2. pay_booking_start: the wallet leaves the card 1 SAR ───────────────────────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef('public.pay_booking_start(text,text,text,text[],boolean,boolean,text)'::regprocedure) into d;
  if position('(20261110235500)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
    'mins int; bid text; days text; kinds text;',
    'mins int; bid text; days text; kinds text; give numeric; g numeric; who text;');
  d := pg_temp._once(d,
$a$  if total < 1 then raise exception 'PAY_TOO_SMALL' using errcode = 'P0001'; end if;
$a$,
$b$  /* the wallet left the card less than Moyasar's 1 SAR (199.50 against two rides of 100): it gives back, from the
     bookings it paid in part, what makes the card's part 1 SAR, rather than PAY_TOO_SMALL undoing them, as
     store_checkout does (bug hunt 2026-11-10 (20261110235500)). Not enough to give back: PAY_TOO_SMALL as before. */
  if total > 0 and total < 1 then
    give := round(1 - total, 2);
    for q in select e.* from queue_entries e
              where e.id in (select l ->> 'id' from jsonb_array_elements(lines) l)
                and coalesce(e.wallet_paid, 0) > 0 and not coalesce(e.paid, false)
              order by e.wallet_paid desc, e.id loop
      exit when give <= 0;
      g := least(give, q.wallet_paid);
      select _wallet_owner(l.customer_id) into who from wallet_ledger l
       where l.booking_id = q.id and l.kind = 'spend' order by l.id desc limit 1;
      perform _wallet_post(coalesce(who, _wallet_owner(q.customer_id)), g, 'return', null, null, q.id, null, q.session_id);
      perform set_config('mm.wallet_ok', '1', true);
      update queue_entries set wallet_paid = wallet_paid - g where id = q.id;
      perform set_config('mm.wallet_ok', '', true);
      give := give - g;
    end loop;
    if give <= 0 then  /* the lines again, at what the card pays now */
      select jsonb_agg(jsonb_build_object('id', e.id, 'amount', _pay_due(e)) order by t.o), sum(_pay_due(e))
        into lines, total
        from jsonb_array_elements(lines) with ordinality t(l, o) join queue_entries e on e.id = t.l ->> 'id';
    end if;
  end if;
  if total < 1 then raise exception 'PAY_TOO_SMALL' using errcode = 'P0001'; end if;
$b$);
  execute d;
end $do$;


-- ── 3a. pay_refund_done: a workshop payment refunded whole leaves its job to pay ───────────────
do $do$
declare d text;
begin
  select pg_get_functiondef('public.pay_refund_done(text,uuid,boolean,integer,text)'::regprocedure) into d;
  if position('(20261110235500)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$                        status = case when least(tot, amount) >= amount then 'refunded' else 'partly_refunded' end
     where id = p.id;
  end if;
$a$,
$b$                        status = case when least(tot, amount) >= amount then 'refunded' else 'partly_refunded' end
     where id = p.id;
    /* a workshop job this payment paid is to pay again once the payment is refunded whole (card and wallet), as a
       till receipt voided or refunded leaves it; a part refund leaves it paid (bug hunt 2026-11-10 (20261110235500)) */
    if p.kind = 'workshop' then
      update workshop_jobs set paid_at = null, paid_receipt = null
       where paid_receipt = 'pay-' || p.id
         and (select x.refunded from payments x where x.id = p.id)
             + coalesce((select sum(w.amount) from payment_refunds w where w.payment_id = p.id and w.dest = 'wallet'
                           and w.status = 'done' and w.provider_id is not distinct from p.provider_id), 0) >= p.amount;
    end if;
  end if;
$b$);
  execute d;
end $do$;


-- ── 3b. staff_pay_refund_begin: the same when the wallet takes the refund ──────────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef('public.staff_pay_refund_begin(uuid,numeric,text,text,uuid,text,text)'::regprocedure) into d;
  if position('(20261110235500)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$    perform _pay_event(p.id, 'staff', 'refund_wallet', null, amt::text);
$a$,
$b$    /* a workshop job this payment paid is to pay again once the payment is refunded whole (card and wallet), as
       pay_refund_done does (bug hunt 2026-11-10 (20261110235500)) */
    if p.kind = 'workshop' and r.provider_id is not distinct from p.provider_id then
      update workshop_jobs set paid_at = null, paid_receipt = null
       where paid_receipt = 'pay-' || p.id
         and p.refunded + coalesce((select sum(w.amount) from payment_refunds w where w.payment_id = p.id and w.dest = 'wallet'
                                      and w.status = 'done' and w.provider_id is not distinct from p.provider_id), 0) >= p.amount;
    end if;
    perform _pay_event(p.id, 'staff', 'refund_wallet', null, amt::text);
$b$);
  execute d;
end $do$;


-- ── 4. pay_reconcile_list: one pending refund per Moyasar payment, never one in flight ──────────
do $do$
declare d text;
begin
  select pg_get_functiondef('public.pay_reconcile_list(text)'::regprocedure) into d;
  if position('(20261110235500)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$                           from (select * from payment_refunds where status = 'pending' and dest = 'card'
                                   and created_at < now() - interval '2 minutes' order by created_at limit 10) r), '[]'::jsonb));
$a$,
$b$                           /* one per Moyasar payment, its oldest pending, so its 'already' is the refunds done alone,
                              and none while another of that payment is still being sent (younger than the grace),
                              so Moyasar's total never holds a refund in flight; the next is judged on the next run
                              (bug hunt 2026-11-10 (20261110235500): the website confirmed a payment's listed refunds
                              together from the largest 'already', and marked failed refunds that went through) */
                           from (select o.* from (select distinct on (x.payment_id, x.provider_id) x.* from payment_refunds x
                                                   where x.status = 'pending' and x.dest = 'card'
                                                   order by x.payment_id, x.provider_id, x.created_at, x.id) o
                                  where o.created_at < now() - interval '2 minutes'
                                    and not exists (select 1 from payment_refunds y
                                                     where y.payment_id = o.payment_id and y.provider_id is not distinct from o.provider_id
                                                       and y.status = 'pending' and y.dest = 'card'
                                                       and y.created_at >= now() - interval '2 minutes')
                                  order by o.created_at, o.id limit 10) r), '[]'::jsonb));
$b$);
  execute d;
end $do$;


-- checks: every function patched, still SECURITY DEFINER with its search_path, and the staff one not open to anon
do $chk$
declare f text;
begin
  foreach f in array array['public.staff_store_order_cancel(uuid,text,text,text)',
                           'public.pay_booking_start(text,text,text,text[],boolean,boolean,text)',
                           'public.pay_refund_done(text,uuid,boolean,integer,text)',
                           'public.staff_pay_refund_begin(uuid,numeric,text,text,uuid,text,text)',
                           'public.pay_reconcile_list(text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
    if position('(20261110235500)' in (select p.prosrc from pg_proc p where p.oid = f::regprocedure)) = 0 then
      raise exception '% was not patched', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.staff_store_order_cancel(uuid,text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.staff_pay_refund_begin(uuid,numeric,text,text,uuid,text,text)', 'execute') then
    raise exception 'a staff refund function is executable by anon';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261110235500', 'bh10_payments_b')
on conflict (version) do nothing;

commit;
