-- ============================================================================
-- An account with only finished bookings can be deleted (archived). For PROD and STAGING.
--
-- The user, 2026-11-12: a rider's delete was refused for "2 active sessions while there are none active for him, fix
-- it". staff_delete_customer refused any account holding a booking in waiting, waitlist or
-- active, whatever its date. Closing a session never settles its riders (only Close out does), so nights closed
-- without a close-out leave bookings Waiting or on the waitlist for ever: on 2026-11-12 prod held 145 waiting and
-- 128 waitlist bookings on sessions that ended days or weeks ago, across about 190 riders, and every one of those
-- riders could never be deleted. That rider's two were Waiting on two closed nights, one five and one four weeks old.
--
-- Now a booking is live only while its ride is still to come or under way:
--   waiting / waitlist  until the session's window ends (_session_window, the clock rider_register uses);
--   active (bike out)   through the day after the session's date, so a night that runs late still holds them;
--   no session row      not live.
-- Nothing else in the function changes (copied from 20261111200000, the definition on prod). The bookings themselves
-- are not touched: they stay as they are, under the rider's name, like every other booking of an archived account.
--
-- Rollback: run the staff_delete_customer block of 20261111200000_account_archive.sql again.
-- ============================================================================

create or replace function public.staff_delete_customer(p_id text, p_op text default null, p_approval text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_live int; v_bookings int := 0; v_sales int := 0; v_push int := 0; v_ids text[]; v_codes text[]; v_tags jsonb;
  v_by text; v_now timestamptz := now();
begin
  -- Admins only, with the operator's PIN approval (staff_pin_approve), as before.
  if not is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if not _pin_ok_strict(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  -- An account is never deleted: it is archived, with everything linked to it, under its name (20261111200000).
  -- Locked first, so a booking being made for it waits and then meets the archive guard on queue_entries.
  perform 1 from customers where id = p_id and archived_at is null for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  -- The accounts merged into this one, at any depth, are the same person: they are archived with it.
  with recursive m(id) as (
    select p_id
    union
    select c.id from customers c join m on c.merged_into = m.id
  )
  select array_agg(id) into v_ids from m;
  perform 1 from customers where id = any(v_ids) and id <> p_id order by id for update;
  -- Live = the ride is still to come or under way (20261113000500). A Waiting or waitlist booking counts until its
  -- session's window ends; one left that way on a night closed without a close-out is history and no longer stops
  -- the archive. A rider out on a bike counts through the day after the session. A booking whose session is gone
  -- is not live. The desk's _delLiveBk reads it the same way.
  select count(*) into v_live
    from queue_entries q
    join sessions s on s.id = q.session_id
    cross join lateral _session_window(s) w
   where q.customer_id = any(v_ids)
     and (   (q.status in ('waiting', 'waitlist') and w.ends_at > v_now)
          or (q.status = 'active' and s.session_date >= to_char(_ksa_today() - 1, 'YYYY-MM-DD')));
  if v_live > 0 then
    return jsonb_build_object('ok', false, 'error', 'LIVE_BOOKINGS', 'live', v_live);
  end if;
  -- Bookings and sales stay linked to the account: counted for the answer, never touched.
  select count(*) into v_bookings from queue_entries where customer_id = any(v_ids);
  select count(*) into v_sales from cashier_sales where customer_id = any(v_ids);
  -- We stop contacting it: push subscriptions, pushes not sent yet, sign-in hand-offs.
  delete from push_subscriptions where customer_id = any(v_ids);
  get diagnostics v_push = row_count;
  delete from push_outbox where customer_id = any(v_ids) and sent_at is null;
  delete from customer_handoffs where customer_id = any(v_ids);
  -- Its own codes stop (RF-, RW-, VL-, BD-, a code made for it); a restore turns the same ones back on.
  with u as (update promo_codes set active = false where customer_id = any(v_ids) and active returning id)
    select array_agg(id) into v_codes from u;
  -- Its tags move into the archive (a restore puts them back). Deleted as rows, so the desk's lists, counts and
  -- copies drop them the way they always have (sync tombstones, the staff-ref broadcast).
  select jsonb_agg(to_jsonb(ct) order by ct.customer_id, ct.tag_id) into v_tags
    from customer_tags ct where ct.customer_id = any(v_ids);
  delete from customer_tags where customer_id = any(v_ids);
  v_by := coalesce(nullif(btrim(p_op), ''), (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()));
  -- The sign-in addresses move into the archive: the email and phone are free for a new account, and nothing that
  -- signs in, signs up or matches by email or phone finds this one. The token goes: it is signed out everywhere.
  update customers c set
      archived_at = v_now, archived_by = v_by, archived_root = p_id,
      archived_email = nullif(btrim(c.email), ''), archived_apple_email = nullif(btrim(c.apple_email), ''),
      archived_phone = nullif(btrim(c.phone), ''),
      archived_codes = case when c.id = p_id then v_codes end,
      archived_tags = case when c.id = p_id then v_tags end,
      email = null, apple_email = null, phone = null, session_token = null
   where c.id = any(v_ids) and c.archived_at is null;
  return jsonb_build_object('ok', true, 'archived', true, 'bookings', v_bookings, 'sales', v_sales,
                            'tags', coalesce(jsonb_array_length(v_tags), 0), 'push_subscriptions', v_push,
                            'flags', 0, 'rider_links', 0, 'codes', coalesce(array_length(v_codes, 1), 0),
                            'merged_accounts', coalesce(array_length(v_ids, 1), 1) - 1);
end $function$;
revoke all on function public.staff_delete_customer(text, text, text) from public, anon;
grant execute on function public.staff_delete_customer(text, text, text) to authenticated;

-- checks ------------------------------------------------------------------------------------------------------------------
do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.staff_delete_customer(text,text,text)'::regprocedure
                   and p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'staff_delete_customer lost SECURITY DEFINER or its search_path';
  end if;
  if has_function_privilege('anon', 'public.staff_delete_customer(text,text,text)', 'execute') then
    raise exception 'staff_delete_customer is open to anon';
  end if;
  if not has_function_privilege('authenticated', 'public.staff_delete_customer(text,text,text)', 'execute') then
    raise exception 'staff_delete_customer is closed to staff';
  end if;
end $chk$;
