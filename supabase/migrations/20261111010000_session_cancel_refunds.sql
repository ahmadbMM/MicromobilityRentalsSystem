-- ============================================================================
-- 20261111010000_session_cancel_refunds
--
-- The user, 2026-11-10: "allow staff to cancel a session even if it had bookings in it, return all money
-- to customers and return all codes used and free rides used to them". Picks (AskUserQuestion, same day):
-- money taken at the desk goes back the way it was paid unless the rider picks the wallet (the Terms'
-- wording of 2026-11-04: "if we cancel, back the way paid unless they pick wallet"), chosen rider by rider
-- in the dialog; a one-person code whose end date has passed, or comes within 14 days, gets 14 more days.
--
-- staff_cancel_session(p_id, p_reason, p_wallet, p_op, p_approval) does the whole of it in one go:
--   1. The session: closed, cancelled_at stamped (its volunteers are told by sessions_vol_cancelled, its
--      waitlist offers stop), cancel_reason = the staffer's words, opens_at cleared so mm-sessions-tick
--      never opens it again. Done FIRST, so _session_fill_recount and sessions_capacity_promote, which only
--      act on an open or full night, promote nobody while its bookings are cancelled.
--   2. The money, for every live booking (waiting, waitlist, on a bike) and every booking already
--      cancelled that is still marked paid: what the desk took (_wallet_amount of the row less its wallet
--      part, as staff_wallet_refund_booking counts it) goes into the rider's wallet when its id is in
--      p_wallet (admins only, as every refund into a wallet since 20261103170000; never a race's), else it
--      is answered in by_hand for staff to give back on the card machine or from the drawer. Either way the
--      row is marked unpaid, as the desk's own refund leaves it. Not touched: the wallet's own part (it goes
--      back by itself when the row is cancelled, _wallet_follow), a booking paid online (cancelling it owes
--      a refund in Payments > Refunds, _pay_cancel_follow, staging only), money paid to a race's organiser
--      (pay_method 'transfer': the organiser's to give back).
--   3. The bookings: cancelled by staff, reason 'session_cancelled', the staffer's words as cancel_note, off
--      their bikes. Every code's use comes back by trg_promo_count_upd, a Saturday code's place by its
--      count, a locker on the bill leaves it (_lk_booking_follow).
--   4. The codes those bookings used: a one-person code (an account's, a blood donor's, a referral's, a
--      volunteer's) whose end date is before today + 14 days (Riyadh) is moved to that date. A code many
--      riders share only gets its use back.
--   5. The bikes of riders who were out on one go back to available (only a bike still in-use).
-- Checks: staff with edit rights to Bookings (sessions come with it), the operator's PIN (_pin_ok); when
-- money goes back, the refund right (CAP_REFUND) and the manager limit on the total (_mgr_ok 'refund').
-- The page restocks the add-ons and writes the Action Log; this function answers what it did.
--
-- Rollback: drop function if exists public.staff_cancel_session(text, text, text[], text, text);
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.staff_cancel_session(p_id text, p_reason text default null, p_wallet text[] default null,
                                                     p_op text default null, p_approval text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare
  s sessions%rowtype;
  q queue_entries%rowtype;
  w jsonb;
  why text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
  wl text[] := coalesce(p_wallet, '{}'::text[]);
  race boolean;
  desk numeric; held numeric; card numeric; total numeric := 0; to_w numeric := 0; wal_back numeric := 0;
  n int := 0; online int := 0; org int := 0;
  c_rows jsonb := '[]'::jsonb; wallets jsonb := '[]'::jsonb; by_hand jsonb := '[]'::jsonb; ext jsonb := '[]'::jsonb;
  ids text[] := '{}'::text[]; owed text[] := '{}'::text[]; codes text[] := '{}'::text[]; v_bikes text[] := '{}'::text[];
  freed text[] := '{}'::text[];
  till date := (now() at time zone 'Asia/Riyadh')::date + 14;
begin
  if not is_staff() or not _staff_mod('queue', true) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into s from sessions where id = p_id for update;
  if s.id is null or s.status = 'deleted' then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  race := coalesce(s.ride_kind, '') in ('vlap', 'arena');

  -- What is cancelled and what is owed, every row locked before anything is written.
  for q in
    select e.* from queue_entries e
     where e.session_id = p_id
       and (e.status in ('waiting', 'waitlist', 'active') or (e.status = 'cancelled' and coalesce(e.paid, false)))
     order by e.queue_num nulls last, e.id
     for update
  loop
    if q.status <> 'cancelled' then
      n := n + 1;
      ids := ids || q.id;
      c_rows := c_rows || jsonb_build_object('id', q.id, 'was', q.status);
      if q.status = 'active' then v_bikes := v_bikes || _bike_ids(q.assigned_bike_id); end if;
      if nullif(q.promo_code, '') is not null then codes := codes || lower(q.promo_code); end if;
      wal_back := wal_back + case when coalesce(q.paid, false) and q.pay_method = 'wallet' then _wallet_amount(q.price, q.addons)
                                  else coalesce(q.wallet_paid, 0) end;
      if coalesce(q.paid, false) and q.pay_method = 'online' then online := online + 1; end if;
      if coalesce(q.paid, false) and q.pay_method = 'transfer' then org := org + 1; end if;
    end if;
    continue when not coalesce(q.paid, false) or coalesce(q.pay_method, '') in ('wallet', 'online', 'transfer');
    -- The wallet's part is not the desk's to give back. A row cancelled before has had it back already and
    -- reads wallet_paid 0, so its part is what the ledger held for it just before that cancel.
    if q.status = 'cancelled' then
      select greatest(coalesce(-sum(l.amount), 0), 0) into held from wallet_ledger l
       where l.booking_id = q.id and l.kind in ('spend', 'return') and l.created_at < coalesce(q.cancelled_at, 'infinity'::timestamptz);
    else
      held := coalesce(q.wallet_paid, 0);
    end if;
    desk := round(_wallet_amount(q.price, q.addons) - held, 2);
    continue when desk <= 0;
    total := total + desk;
    owed := owed || q.id;
    card := case when q.card_amount is not null then least(greatest(q.card_amount, 0), desk)
                 when q.pay_method = 'card' then desk when q.pay_method = 'cash' then 0 end;
    if q.id = any(wl) then
      if q.customer_id is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
      if race then raise exception 'WALLET_RACE' using errcode = 'P0001'; end if;  -- the organiser's money
      to_w := to_w + desk;
      wallets := wallets || jsonb_build_object('id', q.id, 'customer', q.customer_id, 'amount', desk, 'card', card,
        'method', case when q.card_amount is not null then 'split' when q.pay_method in ('card', 'cash') then q.pay_method end);
    else
      by_hand := by_hand || jsonb_build_object('id', q.id, 'name', q.name, 'phone', q.phone, 'amount', desk, 'card', card,
        'method', case when q.card_amount is not null then 'split' else q.pay_method end, 'was', q.status);
    end if;
  end loop;

  if total > 0 then
    if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
    if not _mgr_ok('refund', total, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  end if;
  if to_w > 0 and not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;

  -- 1. The session, first: closed nights promote nobody and are not reopened by the fill rule.
  update sessions set status = 'closed', cancelled_at = coalesce(cancelled_at, now()),
         cancel_reason = coalesce(why, cancel_reason), opens_at = null
   where id = p_id;

  -- 2. The money.
  if to_w > 0 then
    perform set_config('mm.wallet_op', coalesce(p_op, ''), true);
    perform set_config('mm.wallet_note', left('not_given' || coalesce(': ' || why, ''), 300), true);
    for w in select x from jsonb_array_elements(wallets) x loop
      perform _wallet_post(_wallet_owner(w ->> 'customer'), (w ->> 'amount')::numeric, 'refund', w ->> 'method',
                           (w ->> 'card')::numeric, w ->> 'id', null, p_id);
    end loop;
    perform set_config('mm.wallet_note', '', true);
  end if;
  if cardinality(owed) > 0 then
    update queue_entries set paid = false, pay_method = null, card_amount = null where id = any(owed);
  end if;

  -- 3. The bookings.
  if cardinality(ids) > 0 then
    update queue_entries set status = 'cancelled', cancelled_by = 'staff', cancel_reason = 'session_cancelled',
           cancel_note = why, assigned_bike_id = null
     where id = any(ids);
  end if;

  -- 4. The codes they used: a one-person code that has ended, or ends within 14 days, gets 14 more.
  if cardinality(codes) > 0 then
    with x as (
      update promo_codes p set expires_at = till
       where lower(p.code) = any(codes)
         and p.expires_at is not null and p.expires_at < till
         and (p.customer_id is not null or p.blood_entry_id is not null or p.referral_friend_id is not null
              or p.referral_welcome_of is not null or p.referral_bonus_of is not null or p.volunteer_session_id is not null)
      returning p.code, p.expires_at)
    select coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'expires_at', x.expires_at)), '[]'::jsonb) into ext from x;
  end if;

  -- 5. The bikes riders were out on.
  if cardinality(v_bikes) > 0 then
    with b as (update bikes set status = 'available' where id = any(v_bikes) and status = 'in-use' returning id)
    select coalesce(array_agg(b.id), '{}'::text[]) into freed from b;
  end if;

  return jsonb_build_object('ok', true, 'id', p_id, 'cancelled', n, 'rows', c_rows,
    'total', total, 'to_wallet', to_w, 'wallet', wallets, 'by_hand', by_hand, 'wallet_back', wal_back,
    'online', online, 'organiser', org, 'codes', cardinality(codes), 'extended', ext, 'bikes', to_jsonb(freed),
    'previous_status', s.status);
end $$;
revoke all on function public.staff_cancel_session(text, text, text[], text, text) from public, anon;
grant execute on function public.staff_cancel_session(text, text, text[], text, text) to authenticated;

-- checks: definer with its search_path, staff may call it and anon may not, and the helpers it leans on are there
do $chk$
declare f text;
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.staff_cancel_session(text,text,text[],text,text)'::regprocedure
                   and p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'staff_cancel_session lost SECURITY DEFINER or its search_path';
  end if;
  if has_function_privilege('anon', 'public.staff_cancel_session(text,text,text[],text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_cancel_session(text,text,text[],text,text)', 'execute') then
    raise exception 'staff_cancel_session grants are wrong';
  end if;
  foreach f in array array['public._wallet_post(text,numeric,text,text,numeric,text,text,text,text)', 'public._wallet_owner(text)',
                           'public._wallet_amount(numeric,text)', 'public._mgr_ok(text,numeric,text)', 'public._staff_cap(text)',
                           'public._staff_mod(text,boolean)', 'public._pin_ok(text,text)', 'public._bike_ids(text)'] loop
    if to_regprocedure(f) is null then raise exception '% is missing', f; end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111010000', 'session_cancel_refunds')
on conflict (version) do nothing;

commit;
