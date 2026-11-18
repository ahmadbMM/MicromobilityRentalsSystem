-- ============================================================================
-- Bug hunt 2026-11-18, package db1: database fixes (applied on STAGING, then PRODUCTION).
--
-- 1. dbgrants-1, dbgrants-2 (policies): the People section's tables took writes from any staff account (is_staff():
--    the view-only Owner, the Door, an account with no People right), from the browser console. Each "staff full"
--    policy becomes "staff read" (every staff account, as before) plus insert / update / delete for the accounts with
--    People's change right (_staff_mod('community', true), as Ask): hub_posts, hub_club_goals, hub_ramadan, hub_goals,
--    hub_photos, and with them the other Community > Activities tables (rotm_rounds, member_welcome, squads), the four
--    mentorship tables and customer_badges. badge_requests' update and delete go to the Badge requests section
--    (_staff_mod('badgereq', true), People's). farm_codes (written by hand, never by the page) is written by an admin
--    only. Reads, the definer RPCs and triggers (which bypass these policies) are unchanged; the staff page already
--    shows these editors only to People editors. A session date move moves badges through staff_move_session (definer).
-- 2. ppl-rentals0-2, staff_customer_export (Download their data): it took only tables with a column named customer_id,
--    so a rider's Petromin / Dukan / Saturday registrations (rider_registrations.matched_customer_id), referrals, kudos,
--    rider-of-the-month votes and wins, mentor offers, buddy rows and squads were missing from a PDPL access answer. It
--    now also takes every column with a foreign key to customers (keyed "table.column"; customer_id tables keep their
--    key, so the page's count is unchanged), never the applications the person invited others to, and leaves out of each
--    row the OTHER accounts it names (their id columns and *_name columns): members never see other members.
-- 3. sql01-4, _hub_push_tick: the evening-before reminder went out once per booking row, so an account holding several
--    places got several. Now one per account and session (its first ticket), and all its places there are marked.
-- 4. sql01-1, _hub_tick + _hub_auto_post: the Saturday recap was written as soon as a 'closed' Saturday ride had one
--    returned rider ('closed' is also "bookings closed", Full / by hand), then never updated, so it could be frozen at a
--    handful of riders and never pushed (pushed at 10 or more). It now waits for the ride's window end + 2 hours (as
--    _sessions_tick), and its counts follow later returns for the three days it is looked at.
-- 5. sql01-5, _lk_booking_follow: moving a booking moved a locker already handed over (in_use) to the new day (tonight's
--    door showed free with the rider's things in it) and could turn it back to a reservation with no door. Only a
--    reservation moves now; a handed-over locker stays until it is handed back.
-- 6. sql02-2, _lk_kind + _lk_session_cancelled + trigger sessions_lockers_cancelled: a deleted night (status 'deleted')
--    still counted as a locker evening, so micromobility.sa/lockers kept selling it, and its reserved page lockers kept
--    their money. A deleted night is closed like a cancelled one, and deleting it cancels its page lockers with their
--    money given back ('night deleted'), as calling a night off does.
-- 7. sql03-2, _rider_reg_follow_booking: a returned booking removed (History > Remove), made a no-show or cancelled kept
--    its Petromin / Dukan registration returned, so the company bill still charged it. It is un-returned now (price
--    cleared by _rider_registration_guard), as done -> waiting already was; the month's takings already leave a removed
--    booking out (_mt_core). Undo (back to done) bills it again. Deliberate change of the 2026-10-28 rule "no-show,
--    cancel and every other move leave the registration alone", for a booking that was returned.
-- 8. sql04-2, _updates_wl_in: a booking promoted off the waitlist a second time left no new Updates entry (fixed tag,
--    ON CONFLICT DO NOTHING). The row is now written afresh and unread, same tag.
-- 9. sql05-5, _wl_offer_fill (patched in place) + new deferred trigger queue_entries_wl_offer_moved / _wl_offer_moved:
--    a waitlisted booking moved to another ride was never offered a place there if it had a lapsed or declined offer on
--    the old ride. Only this ride's offers count now; an offer left open on the ride it left is closed when the move
--    commits, and that ride's next rider is offered the place.
--
-- Not here: sql01-2 (the recap's "{0} riders came out" is the owner's call), sql04-1 (the date move's breakfast stop:
-- a client change, and staff_move_session, which package db3 rebuilds).
--
-- Copied from (newest text, only the lines named above changed): staff_customer_export 20261118210000_people_round;
-- _hub_push_tick and _updates_wl_in 20261114080300_updates_list; _hub_auto_post and _hub_tick
-- 20261114000100_community_reach; _lk_booking_follow, _lk_kind and _lk_session_cancelled 20261111235000_bh11_live_a;
-- _rider_reg_follow_booking 20261028140000_staff_review_money; _wl_offer_fill patched from its live text
-- (20261111235000_bh11_live_a + 20261111180600_type_caps). Headers kept (security definer, search_path, volatility).
--
-- Rollback: re-run those definitions from their files (and 20261111180600's _wl_offer_fill line); drop trigger
--   queue_entries_wl_offer_moved on queue_entries and function _wl_offer_moved(); recreate sessions_lockers_cancelled
--   as "after update of cancelled_at ... when (old.cancelled_at is null and new.cancelled_at is not null)"; drop the
--   "staff read" / "people insert|update|delete" policies and recreate each "staff full" (for all, is_staff()) from its
--   file, badge_requests_staff_update / _delete with is_staff(), farm_codes "staff write" (for all, is_staff()).
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. The People section's tables: written only by those who may change People (dbgrants-1, dbgrants-2) ──────────
-- Each "staff full" policy (FOR ALL, is_staff(): any staff account but a volunteer, so the view-only Owner, the Door
-- and an account with no People right) becomes "staff read" for every staff account, as before, and insert / update /
-- delete for the accounts with People's change right, as Ask does (_staff_mod('community', true); 'customers' and
-- 'badgereq' are the same section there). Only the commands each table is granted get a policy.
-- hub_posts (20261111100000_community_tab)
drop policy if exists "staff full" on public.hub_posts;
drop policy if exists "staff read" on public.hub_posts;
create policy "staff read" on public.hub_posts for select to authenticated using ((select is_staff()));
drop policy if exists "people insert" on public.hub_posts;
create policy "people insert" on public.hub_posts for insert to authenticated with check ((select _staff_mod('community', true)));
drop policy if exists "people update" on public.hub_posts;
create policy "people update" on public.hub_posts for update to authenticated using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));
drop policy if exists "people delete" on public.hub_posts;
create policy "people delete" on public.hub_posts for delete to authenticated using ((select _staff_mod('community', true)));

-- hub_club_goals (20261114000100_community_reach)
drop policy if exists "staff full" on public.hub_club_goals;
drop policy if exists "staff read" on public.hub_club_goals;
create policy "staff read" on public.hub_club_goals for select to authenticated using ((select is_staff()));
drop policy if exists "people insert" on public.hub_club_goals;
create policy "people insert" on public.hub_club_goals for insert to authenticated with check ((select _staff_mod('community', true)));
drop policy if exists "people update" on public.hub_club_goals;
create policy "people update" on public.hub_club_goals for update to authenticated using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));
drop policy if exists "people delete" on public.hub_club_goals;
create policy "people delete" on public.hub_club_goals for delete to authenticated using ((select _staff_mod('community', true)));

-- hub_ramadan (20261114000100_community_reach)
drop policy if exists "staff full" on public.hub_ramadan;
drop policy if exists "staff read" on public.hub_ramadan;
create policy "staff read" on public.hub_ramadan for select to authenticated using ((select is_staff()));
drop policy if exists "people insert" on public.hub_ramadan;
create policy "people insert" on public.hub_ramadan for insert to authenticated with check ((select _staff_mod('community', true)));
drop policy if exists "people update" on public.hub_ramadan;
create policy "people update" on public.hub_ramadan for update to authenticated using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));
drop policy if exists "people delete" on public.hub_ramadan;
create policy "people delete" on public.hub_ramadan for delete to authenticated using ((select _staff_mod('community', true)));

-- hub_goals (20261103120500_member_hub)
drop policy if exists "staff full" on public.hub_goals;
drop policy if exists "staff read" on public.hub_goals;
create policy "staff read" on public.hub_goals for select to authenticated using ((select is_staff()));
drop policy if exists "people insert" on public.hub_goals;
create policy "people insert" on public.hub_goals for insert to authenticated with check ((select _staff_mod('community', true)));
drop policy if exists "people update" on public.hub_goals;
create policy "people update" on public.hub_goals for update to authenticated using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));
drop policy if exists "people delete" on public.hub_goals;
create policy "people delete" on public.hub_goals for delete to authenticated using ((select _staff_mod('community', true)));

-- rotm_rounds (20261103120500_member_hub)
drop policy if exists "staff full" on public.rotm_rounds;
drop policy if exists "staff read" on public.rotm_rounds;
create policy "staff read" on public.rotm_rounds for select to authenticated using ((select is_staff()));
drop policy if exists "people insert" on public.rotm_rounds;
create policy "people insert" on public.rotm_rounds for insert to authenticated with check ((select _staff_mod('community', true)));
drop policy if exists "people update" on public.rotm_rounds;
create policy "people update" on public.rotm_rounds for update to authenticated using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));
drop policy if exists "people delete" on public.rotm_rounds;
create policy "people delete" on public.rotm_rounds for delete to authenticated using ((select _staff_mod('community', true)));

-- member_welcome (20261103120500_member_hub)
drop policy if exists "staff full" on public.member_welcome;
drop policy if exists "staff read" on public.member_welcome;
create policy "staff read" on public.member_welcome for select to authenticated using ((select is_staff()));
drop policy if exists "people insert" on public.member_welcome;
create policy "people insert" on public.member_welcome for insert to authenticated with check ((select _staff_mod('community', true)));
drop policy if exists "people update" on public.member_welcome;
create policy "people update" on public.member_welcome for update to authenticated using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));
drop policy if exists "people delete" on public.member_welcome;
create policy "people delete" on public.member_welcome for delete to authenticated using ((select _staff_mod('community', true)));

-- squads (20261103120500_member_hub)
drop policy if exists "staff full" on public.squads;
drop policy if exists "staff read" on public.squads;
create policy "staff read" on public.squads for select to authenticated using ((select is_staff()));
drop policy if exists "people insert" on public.squads;
drop policy if exists "people update" on public.squads;
create policy "people update" on public.squads for update to authenticated using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));
drop policy if exists "people delete" on public.squads;
create policy "people delete" on public.squads for delete to authenticated using ((select _staff_mod('community', true)));

-- hub_photos (20261103120500_member_hub)
drop policy if exists "staff full" on public.hub_photos;
drop policy if exists "staff read" on public.hub_photos;
create policy "staff read" on public.hub_photos for select to authenticated using ((select is_staff()));
drop policy if exists "people insert" on public.hub_photos;
drop policy if exists "people update" on public.hub_photos;
create policy "people update" on public.hub_photos for update to authenticated using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));
drop policy if exists "people delete" on public.hub_photos;
create policy "people delete" on public.hub_photos for delete to authenticated using ((select _staff_mod('community', true)));

-- mentor_profiles (20261114050000_mentorship)
drop policy if exists "staff full" on public.mentor_profiles;
drop policy if exists "staff read" on public.mentor_profiles;
create policy "staff read" on public.mentor_profiles for select to authenticated using ((select is_staff()));
drop policy if exists "people insert" on public.mentor_profiles;
create policy "people insert" on public.mentor_profiles for insert to authenticated with check ((select _staff_mod('community', true)));
drop policy if exists "people update" on public.mentor_profiles;
create policy "people update" on public.mentor_profiles for update to authenticated using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));
drop policy if exists "people delete" on public.mentor_profiles;
create policy "people delete" on public.mentor_profiles for delete to authenticated using ((select _staff_mod('community', true)));

-- mentor_mentors (20261114050000_mentorship)
drop policy if exists "staff full" on public.mentor_mentors;
drop policy if exists "staff read" on public.mentor_mentors;
create policy "staff read" on public.mentor_mentors for select to authenticated using ((select is_staff()));
drop policy if exists "people insert" on public.mentor_mentors;
create policy "people insert" on public.mentor_mentors for insert to authenticated with check ((select _staff_mod('community', true)));
drop policy if exists "people update" on public.mentor_mentors;
create policy "people update" on public.mentor_mentors for update to authenticated using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));
drop policy if exists "people delete" on public.mentor_mentors;
create policy "people delete" on public.mentor_mentors for delete to authenticated using ((select _staff_mod('community', true)));

-- mentor_offers (20261114050000_mentorship)
drop policy if exists "staff full" on public.mentor_offers;
drop policy if exists "staff read" on public.mentor_offers;
create policy "staff read" on public.mentor_offers for select to authenticated using ((select is_staff()));
drop policy if exists "people insert" on public.mentor_offers;
create policy "people insert" on public.mentor_offers for insert to authenticated with check ((select _staff_mod('community', true)));
drop policy if exists "people update" on public.mentor_offers;
create policy "people update" on public.mentor_offers for update to authenticated using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));
drop policy if exists "people delete" on public.mentor_offers;
create policy "people delete" on public.mentor_offers for delete to authenticated using ((select _staff_mod('community', true)));

-- mentor_checks (20261114050000_mentorship)
drop policy if exists "staff full" on public.mentor_checks;
drop policy if exists "staff read" on public.mentor_checks;
create policy "staff read" on public.mentor_checks for select to authenticated using ((select is_staff()));
drop policy if exists "people insert" on public.mentor_checks;
drop policy if exists "people update" on public.mentor_checks;
drop policy if exists "people delete" on public.mentor_checks;
create policy "people delete" on public.mentor_checks for delete to authenticated using ((select _staff_mod('community', true)));

-- customer_badges (20260929000000_badges)
drop policy if exists "staff full" on public.customer_badges;
drop policy if exists "staff read" on public.customer_badges;
create policy "staff read" on public.customer_badges for select to authenticated using ((select is_staff()));
drop policy if exists "people insert" on public.customer_badges;
create policy "people insert" on public.customer_badges for insert to authenticated with check ((select _staff_mod('community', true)));
drop policy if exists "people update" on public.customer_badges;
create policy "people update" on public.customer_badges for update to authenticated using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));
drop policy if exists "people delete" on public.customer_badges;
create policy "people delete" on public.customer_badges for delete to authenticated using ((select _staff_mod('community', true)));

-- badge_requests (20261108210000_badge_requests): staff read it as before; answering, hiding and deleting a request is
-- the Badge requests section's, which is People's (20261114120000 granted the hide columns on top of the table grant).
drop policy if exists badge_requests_staff_update on public.badge_requests;
create policy badge_requests_staff_update on public.badge_requests for update to authenticated
  using ((select _staff_mod('badgereq', true))) with check ((select _staff_mod('badgereq', true)));
drop policy if exists badge_requests_staff_delete on public.badge_requests;
create policy badge_requests_staff_delete on public.badge_requests for delete to authenticated
  using ((select _staff_mod('badgereq', true)));

-- farm_codes (20261115210000_farmhouse_page): every staff account reads it as before; a code is written by hand by an
-- admin (the page never writes it), so only an admin writes it.
drop policy if exists "staff write" on public.farm_codes;
drop policy if exists "admin insert" on public.farm_codes;
create policy "admin insert" on public.farm_codes for insert to authenticated with check ((select is_admin()));
drop policy if exists "admin update" on public.farm_codes;
create policy "admin update" on public.farm_codes for update to authenticated using ((select is_admin())) with check ((select is_admin()));
drop policy if exists "admin delete" on public.farm_codes;
create policy "admin delete" on public.farm_codes for delete to authenticated using ((select is_admin()));

-- ── 2. Download their data takes every table that names the person (ppl-rentals0-2) ───────────────────────────────
-- staff_customer_export from 20261118210000_people_round.sql; only the table loop changed.
create or replace function public.staff_customer_export(p_id text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  -- staff-side records that are not the person's data, or that hold nothing but secrets
  _skip   text[] := array['customer_owner_pwd', 'customer_handoffs', 'push_outbox', 'pii_reveals'];
  -- a link that names the person on someone else's record (the applications they invited people to): that record is
  -- the other person's, not theirs (bug hunt 2026-11-18)
  _other  text[] := array['community_applications.invited_by'];
  -- keys that never leave, in any table
  _secret text := '^(password_hash|pwd_hash|session_token|fix_token|track_token|account_oauth|feed_key|client_key|endpoint|auth|p256dh|keys)$';
  _acct   jsonb;
  _rows   jsonb;
  _tables jsonb := '{}'::jsonb;
  _notes  jsonb;
  l       record;
begin
  if not public.is_admin() then
    raise exception 'ADMIN_ONLY' using errcode = '42501';
  end if;
  select to_jsonb(c) into _acct from customers c where c.id = p_id;
  if _acct is null then
    raise exception 'NO_ACCOUNT' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into _acct from jsonb_each(_acct) e(k, v) where k !~ _secret;

  -- Every table that names the person: by a column called customer_id (as before), and by any other column with a
  -- foreign key to customers (bug hunt 2026-11-18): their Petromin / Dukan / Saturday registrations
  -- (rider_registrations.matched_customer_id), referrals both ways, kudos given and received, rider-of-the-month votes
  -- and wins, mentor offers, the members they welcome as a buddy, the squads they made. A customer_id table keeps its
  -- name as the key; another link is keyed table.column. In each row the OTHER accounts it names (the other columns that
  -- point at customers, and their *_name columns) are left out: who voted for them, who gave them kudos, the member they
  -- welcome. Members never see other members.
  for l in
    with links as (
      select c.relname::text as tb, a.attname::text as col
        from pg_attribute a join pg_class c on c.oid = a.attrelid
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
         and a.attname = 'customer_id' and a.attnum > 0 and not a.attisdropped
      union
      select c.relname::text, a.attname::text
        from pg_constraint k
        join pg_class c on c.oid = k.conrelid
        join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
       where k.contype = 'f' and k.confrelid = 'public.customers'::regclass and cardinality(k.conkey) = 1
         and c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not a.attisdropped
    )
    select x.tb, x.col,
           coalesce((select array_agg(z.k)
                       from links o
                       cross join lateral unnest(array[o.col, o.col || '_name', regexp_replace(o.col, '_id$', '') || '_name']) z(k)
                      where o.tb = x.tb and o.col <> x.col), '{}'::text[]) as others
      from links x
     where x.tb <> all (_skip)
       and x.tb <> 'customers'            -- the account row itself is 'account' below
       and (x.tb || '.' || x.col) <> all (_other)
     order by x.tb, x.col <> 'customer_id', x.col
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from (select * from public.%I where %I::text = $1 limit 5000) x', l.tb, l.col)
      into _rows using p_id;
    if jsonb_array_length(_rows) > 0 then
      select coalesce(jsonb_agg((select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(r) e(k, v)
                                  where k !~ _secret and k <> all (l.others))), '[]'::jsonb)
        into _rows from jsonb_array_elements(_rows) r;
      _tables := _tables || jsonb_build_object(case when l.col = 'customer_id' then l.tb else l.tb || '.' || l.col end, _rows);
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('at', s.created_at, 'by', s.author_name, 'note', s.body) order by s.created_at), '[]'::jsonb)
    into _notes from staff_comments s where s.kind = 'customer' and s.target_id = p_id;

  return jsonb_build_object(
    'account_id', p_id,
    'exported_at', now(),
    'exported_by', (select coalesce(nullif(btrim(s.display_name), ''), auth.jwt() ->> 'email') from staff s where s.user_id = auth.uid()),
    'account', _acct,
    'staff_notes', _notes,
    'tables', _tables);
end $function$;
revoke all on function public.staff_customer_export(text) from public, anon;
grant execute on function public.staff_customer_export(text) to authenticated;

-- ── 3. The evening-before reminder: one per account and session (sql01-4) ─────────────────────────────────────────
-- _hub_push_tick from 20261114080300_updates_list.sql (which kept 20261114080200_still_coming's changes); only the
-- reminder's loop and its mark changed. The challenge and the recap are as they were.
create or replace function public._hub_push_tick()
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_ksa timestamp := now() at time zone 'Asia/Riyadh'; v_today date := (now() at time zone 'Asia/Riyadh')::date;
  v_month date := date_trunc('month', (now() at time zone 'Asia/Riyadh'))::date; v_n int := 0; r record; t record;
  v_sess text; v_at text; v_sent timestamptz; v_key text;
begin
  -- the evening before, from 21:00: every live booking on tomorrow's sessions, with push or without
  if extract(hour from v_ksa) >= 21 then
    -- One reminder per account and session (bug hunt 2026-11-18, sql01-4): an account holding several places there (a
    -- friend on a group ride, a party on the Farm House night) got one per place, all alike. It opens the account's
    -- first ticket there, and none is written while any of its places there already has one.
    for r in select distinct on (q.customer_id, s.id)
                    q.id, q.customer_id, q.reminded_at, s.id as sid, s.title, s.ride_kind, w.starts_at
               from queue_entries q join sessions s on s.id = q.session_id
               cross join lateral _session_window(s) w
              where s.session_date = to_char(v_today + 1, 'YYYY-MM-DD') and s.status <> 'deleted' and s.cancelled_at is null
                and s.ride_status is distinct from 'cancelled' and not coalesce(s.draft, false)
                and q.status = 'waiting' and q.customer_id is not null
                and coalesce(q.approval, 'approved') = 'approved'
                and not exists (select 1 from queue_entries q2
                                  join push_outbox o on o.customer_id = q2.customer_id and o.tag = 'rem-' || q2.id
                                 where q2.session_id = q.session_id and q2.customer_id = q.customer_id)
              order by q.customer_id, s.id, q.registered_at nulls last, q.id loop
      v_sess := coalesce(nullif(trim(r.title), ''), 'kind:' || coalesce(r.ride_kind, 'jcc'));
      v_at := to_char(r.starts_at at time zone 'Asia/Riyadh', 'HH24:MI');
      v_key := _updates_key('remind', r.sid); -- a session with no bike is not a ride
      -- its reminder has the words 20261114080200_still_coming wrote, with the sentence about cancelling
      if v_key = 'remind_s' then v_key := 'remind:nc'; end if;
      select * into t from _push_text(r.customer_id, v_key, array[_push_sess_name(r.customer_id, r.title, r.ride_kind), v_at]);
      -- staff already reminded this booking by hand: its row is for the list only
      insert into push_outbox (customer_id, tag, title, body, url, cat, key, args, sent_at, result)
      values (r.customer_id, 'rem-' || r.id, left(t.title, 120), left(t.body, 300), '/my-bookings?tk=' || r.id, 'rides', v_key, array[v_sess, v_at],
              case when r.reminded_at is not null then now() end, case when r.reminded_at is not null then 'inapp' end)
      on conflict (customer_id, tag) do nothing
      returning sent_at into v_sent;
      if found then
        -- going out as a push (the gate left it waiting): staff skip that rider
        if v_sent is null then
          begin
            -- every place the account holds there: staff skip them all
            update queue_entries set reminded_at = now(), reminded_kind = 'push'
             where session_id = r.sid and customer_id = r.customer_id and status = 'waiting'
               and coalesce(approval, 'approved') = 'approved' and reminded_at is null;
          exception when others then
            null; -- a mark the table refuses never undoes the run's rows
          end;
        end if;
        v_n := v_n + 1;
      end if;
    end loop;
  end if;

  -- the 1st, from 10:00 to 21:59: the month's challenge is ready, to every active member
  if extract(day from v_ksa) = 1 and extract(hour from v_ksa) between 10 and 21 then
    for r in select h.customer_id from hub_levels h
              where h.month = v_month and _member_active(h.customer_id)
                and not exists (select 1 from push_outbox o
                                 where o.customer_id = h.customer_id and o.tag = 'hub-ch-' || to_char(v_month, 'YYYYMM')) loop
      select * into t from _push_text(r.customer_id, 'challenge', '{}');
      insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
      values (r.customer_id, 'hub-ch-' || to_char(v_month, 'YYYYMM'), left(t.title, 120), left(t.body, 300), '/members?src=push', 'community',
              'challenge', '{}')
      on conflict (customer_id, tag) do nothing;
      if found then v_n := v_n + 1; end if;
    end loop;
  end if;

  -- the Saturday recap, written in the last 12 hours, to the members who rode it (08:00 to 21:59)
  if extract(hour from v_ksa) between 8 and 21 then
    for r in select distinct p.id as pid, p.riders, q.customer_id
               from hub_posts p join queue_entries q on q.session_id = p.session_id and q.status = 'done'
              where p.auto and not p.hidden and p.created_at > now() - interval '12 hours' and coalesce(p.riders, 0) >= 10
                and q.customer_id is not null and _member_active(q.customer_id)
                and not exists (select 1 from push_outbox o where o.customer_id = q.customer_id and o.tag = 'hub-rc-' || p.id) loop
      select * into t from _push_text(r.customer_id, 'recap', array[r.riders::text]);
      insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
      values (r.customer_id, 'hub-rc-' || r.pid, left(t.title, 120), left(t.body, 300), '/members?src=push', 'community',
              'recap', array[r.riders::text])
      on conflict (customer_id, tag) do nothing;
      if found then v_n := v_n + 1; end if;
    end loop;
  end if;
  return v_n;
end $$;
revoke all on function public._hub_push_tick() from public, anon, authenticated;

-- ── 4. The Saturday recap: written once the ride is over, and kept up to date (sql01-1) ───────────────────────────
-- _hub_auto_post and _hub_tick from 20261114000100_community_reach.sql; only the recap's insert and the recap loop
-- changed.
create or replace function public._hub_auto_post(p_session text)
returns text
language plpgsql volatile security definer set search_path to 'public'
as $$
declare s sessions%rowtype; v_riders int; v_rides int; v_first int; v_leads int; v_vols int; v_first_lead int; v_prev int; v_prev_date text; v_id text;
begin
  select * into s from sessions where id = p_session;
  if not found or s.ride_kind is distinct from 'saturday' then return null; end if;
  select count(distinct coalesce(q.customer_id, q.id)), count(*), count(*) filter (where q.led_at is not null)
    into v_riders, v_rides, v_leads
    from queue_entries q where q.session_id = s.id and q.status = 'done';
  if coalesce(v_rides, 0) = 0 then return null; end if;
  select count(*) into v_first from (
    select distinct q.customer_id from queue_entries q
     where q.session_id = s.id and q.status = 'done' and q.customer_id is not null
       and not exists (select 1 from queue_entries q2 join sessions s2 on s2.id = q2.session_id
                        where q2.customer_id = q.customer_id and q2.status = 'done' and s2.ride_kind = 'saturday'
                          and s2.session_date < s.session_date)) z;
  -- volunteers who clocked in; a volunteer team lead counts as a ride lead too
  select count(*) filter (where vs.clock_in is not null), count(*) filter (where vs.clock_in is not null and vs.lead)
    into v_vols, v_first_lead from volunteer_shifts vs where vs.session_id = s.id;
  v_leads := coalesce(v_leads, 0) + coalesce(v_first_lead, 0);
  -- the Saturday ride before this one that was ridden
  select max(s2.session_date) into v_prev_date from queue_entries q2 join sessions s2 on s2.id = q2.session_id
   where q2.status = 'done' and s2.ride_kind = 'saturday' and s2.session_date < s.session_date;
  if v_prev_date is not null then
    select count(distinct coalesce(q3.customer_id, q3.id)) into v_prev from queue_entries q3 join sessions s3 on s3.id = q3.session_id
     where q3.status = 'done' and s3.ride_kind = 'saturday' and s3.session_date = v_prev_date;
  end if;
  insert into hub_posts (session_id, riders, rides, first_rides, leads, volunteers, prev_riders, shows_from, shows_until, created_by, auto)
  values (s.id, v_riders, v_rides, v_first, v_leads, v_vols, v_prev, s.session_date::date, s.session_date::date + 6, 'system', true)
  -- the counts follow the riders returned after it was first written (bug hunt 2026-11-18, sql01-1); the staff line,
  -- photo, dates and hidden switch stay
  on conflict (session_id) where auto do update
     set riders = excluded.riders, rides = excluded.rides, first_rides = excluded.first_rides, leads = excluded.leads,
         volunteers = excluded.volunteers, prev_riders = excluded.prev_riders
   where (hub_posts.riders, hub_posts.rides, hub_posts.first_rides, hub_posts.leads, hub_posts.volunteers, hub_posts.prev_riders)
         is distinct from (excluded.riders, excluded.rides, excluded.first_rides, excluded.leads, excluded.volunteers, excluded.prev_riders)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public._hub_auto_post(text) from public, anon, authenticated;

create or replace function public._hub_tick()
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_today date := _ksa_today(); v_month date := date_trunc('month', _ksa_today())::date;
  v_ksa timestamp := now() at time zone 'Asia/Riyadh'; v_wide boolean; v_n int := 0; m record; s record; v_got text[];
  x sessions%rowtype; v_end timestamptz;
begin
  for m in select distinct ct.customer_id as id
             from customer_tags ct join customers c on c.id = ct.customer_id
            where ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at) and c.merged_into is null
              and not exists (select 1 from hub_levels h where h.customer_id = ct.customer_id and h.month = v_month) loop
    perform _hub_level_row(m.id, _accts_of(m.id), v_month);
    v_n := v_n + 1;
  end loop;

  v_wide := (extract(hour from v_ksa) = 0 and extract(minute from v_ksa) < 15)
         or (extract(isodow from v_ksa) = 6 and extract(hour from v_ksa) = 12 and extract(minute from v_ksa) < 15);
  for m in select distinct ct.customer_id as id
             from customer_tags ct join customers c on c.id = ct.customer_id
            where ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at) and c.merged_into is null
              and exists (select 1 from queue_entries q join sessions s2 on s2.id = q.session_id
                           where q.customer_id = any(_accts_of(ct.customer_id)) and q.status = 'done'
                             and s2.session_date >= to_char(case when v_wide then (v_month - interval '1 month')::date else v_today - 2 end, 'YYYY-MM-DD')) loop
    v_got := _hub_award(m.id, _accts_of(m.id));
  end loop;

  -- The recap waits for the ride to be over: its window's end and two hours, as _sessions_tick closes a ride. 'closed'
  -- alone is also a ride closed for bookings (Full, no waitlist, or by hand) before or while it runs, and the recap was
  -- written, and frozen, from its first returns. Each pass in the three days writes the counts again when they changed
  -- (_hub_auto_post), so riders returned late still count (bug hunt 2026-11-18, sql01-1).
  for x in select * from sessions y
            where y.ride_kind = 'saturday' and y.status = 'closed' and y.cancelled_at is null
              and y.session_date >= to_char(v_today - 3, 'YYYY-MM-DD') and y.session_date <= to_char(v_today, 'YYYY-MM-DD') loop
    begin
      v_end := (select greatest(w.starts_at, w.ends_at) from _session_window(x) w);
    exception when others then
      v_end := null;
    end;
    if v_end is null then -- a time the window cannot read: the end of the ride's day
      begin
        v_end := (left(x.session_date, 10)::date + 1)::timestamp at time zone 'Asia/Riyadh';
      exception when others then
        v_end := null;
      end;
    end if;
    continue when v_end is null or v_end + interval '2 hours' > now();
    perform _hub_auto_post(x.id);
  end loop;
  return v_n;
end $$;
revoke all on function public._hub_tick() from public, anon, authenticated;

-- ── 5. A booking moved: a locker already handed over stays where it is (sql01-5) ───────────────────────────────────
-- _lk_booking_follow from 20261111235000_bh11_live_a.sql; only the two updates that move the rental changed.
create or replace function public._lk_booking_follow()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare nd date; fr record; k text; who text;
begin
  -- who gives a locker's money back when its booking goes (bug hunt 2026-11-11)
  who := case when (select is_staff()) then _lk_who()
              when coalesce(auth.role(), '') in ('anon', 'authenticated') then 'rider' else 'system' end;
  if tg_op = 'DELETE' then
    perform set_config('mm.lk_deleting', old.id, true);
    -- what the locker took outside the ride's bill comes back, as on a cancel (below)
    for fr in select r.id from locker_rentals r where r.booking_id = old.id and r.status = 'reserved' loop
      perform _lk_money_back(fr.id, who, 'booking deleted');
    end loop;
    update locker_rentals set status = 'cancelled', cancelled_at = now(), cancel_reason = 'booking deleted'
     where booking_id = old.id and status = 'reserved';
    perform set_config('mm.lk_deleting', '', true);
    return old;
  end if;
  if new.session_id is distinct from old.session_id then
    select case when s.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date, 10)::date end into nd
      from sessions s where s.id = new.session_id;
    if nd is not null then perform _lk_lock(nd); end if;
    -- A ride that offers no locker, or none for the locker's time (a community ride, a night with lockers
    -- off or called off, a Petromin night for a JCC time), takes none along: a reservation is cancelled with
    -- its money given back, as when the booking is cancelled, and a locker already handed over stays on the
    -- evening it was given (bug hunt 2026-11-11, sql01-5).
    k := _lk_kind(new.session_id);
    for fr in select r.id from locker_rentals r
               where r.booking_id = new.id and r.status = 'reserved' and not _lk_period_ok(k, r.period) loop
      perform _lk_money_back(fr.id, who, 'booking moved');
      update locker_rentals set status = 'cancelled', cancelled_at = now(), cancel_reason = 'booking moved: no locker there'
       where id = fr.id;
    end loop;
    -- A locker already handed over (in_use) stays on the evening and the door it was given, with the rider's things
    -- in it, until it is handed back: it moved to the new day, which showed tonight's door free, and could be turned
    -- back to a reservation with no door (bug hunt 2026-11-18, sql01-5). Only a reservation moves.
    update locker_rentals r set session_id = new.session_id, day = coalesce(nd, r.day)
     where r.booking_id = new.id and r.status = 'reserved' and _lk_period_ok(k, r.period);
    -- the locker goes along only when nobody holds it there for an overlapping time
    update locker_rentals r set locker_id = null, status = 'reserved', assigned_at = null, assigned_by = null
     where r.booking_id = new.id and r.session_id = new.session_id and r.status = 'reserved' and r.locker_id is not null
       and exists (select 1 from locker_rentals x
                    where x.locker_id = r.locker_id and x.day = r.day and x.id <> r.id
                      and x.status in ('reserved', 'in_use') and _lk_slots(x.period) && _lk_slots(r.period));
    -- ...and one without a locker there is given a free one, so it stays reserved for the rider (the user, 2026-11-10)
    if nd is not null then
      for fr in select r.id, r.day, r.period from locker_rentals r
                 where r.booking_id = new.id and r.status = 'reserved' and r.locker_id is null order by r.created_at loop
        update locker_rentals set locker_id = _lk_free_unit(fr.day, fr.period, fr.id) where id = fr.id;
      end loop;
    end if;
  end if;
  if new.status is distinct from old.status then
    if new.status in ('cancelled', 'removed') or (new.status = 'noshow' and not coalesce(new.paid, false)) then
      -- What the locker took outside the ride's bill (its wallet or card receipt, its till lines) comes back,
      -- as a cancel from the locker tools gives it back: cancelled with the booking, it stayed taken and
      -- the locker tools could no longer refund it (bug hunt 2026-11-11, sql01-2). A no-show keeps it.
      if new.status in ('cancelled', 'removed') then
        for fr in select r.id from locker_rentals r where r.booking_id = new.id and r.status = 'reserved' loop
          perform _lk_money_back(fr.id, who, 'booking ' || new.status);
        end loop;
      end if;
      update locker_rentals set status = 'cancelled', cancelled_at = now(), cancel_reason = 'booking ' || new.status
       where booking_id = new.id and status = 'reserved';
    elsif new.status = 'noshow' then
      update locker_rentals set status = 'returned', returned_at = now(), returned_by = 'no-show'
       where booking_id = new.id and status = 'reserved';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public._lk_booking_follow() from public, anon, authenticated;

-- ── 6. A night deleted sells no lockers, and gives back the ones reserved on it (sql02-2) ─────────────────────────
-- _lk_kind and _lk_session_cancelled from 20261111235000_bh11_live_a.sql. The trigger also fires when the night's status
-- becomes 'deleted'.
create or replace function public._lk_kind(p_session text)
returns text
language sql stable security definer set search_path to 'public'
as $$
  select case
    /* a night called off is closed with cancelled_at (staff_cancel_session, Cancel night); no cancel path
       writes status 'cancelled', so the Lockers page sold lockers for it (bug hunt 2026-11-11, sql04-1); a night
       deleted (staff_delete_session: status 'deleted') is closed too, the page kept selling it (bug hunt 2026-11-18,
       sql02-2) */
    when s.id is null or not coalesce(s.lockers, false) or coalesce(s.status, '') in ('cancelled', 'deleted')
         or s.cancelled_at is not null then ''
    when coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin' then 'pm'
    when coalesce(s.event_kind, '') = 'community' then ''
    else 'jcc' end
    from (select 1) one left join sessions s on s.id = p_session
$$;
revoke execute on function public._lk_kind(text) from public, anon, authenticated;

create or replace function public._lk_session_cancelled()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
/* A night called off (cancelled_at set: staff_cancel_session, Cancel night) takes no more lockers (_lk_kind),
   and the lockers reserved on it from the Lockers page (booking_id null, this session) are cancelled with
   their money given back, as the evening's sweep gives it back. Its rides' lockers follow their bookings
   (_lk_booking_follow); a locker already handed over and a desk walk-up are left to staff; another locker
   evening the same day keeps them (bug hunt 2026-11-11, sql04-1). A night deleted (status 'deleted',
   staff_delete_session) does the same (bug hunt 2026-11-18, sql02-2). */
declare d date; fr record; who text; why text;
begin
  d := case when new.session_date ~ '^\d{4}-\d{2}-\d{2}' then left(new.session_date, 10)::date end;
  if d is null then return null; end if;
  perform _lk_lock(d);
  if exists (select 1 from _lk_evening(d) e where e.session_id is not null and e.session_id is distinct from new.id) then
    return null;
  end if;
  who := case when (select is_staff()) then _lk_who() else 'system' end;
  why := case when new.status = 'deleted' then 'night deleted' else 'night cancelled' end;
  for fr in select r.id from locker_rentals r
             where r.session_id = new.id and r.booking_id is null and r.status = 'reserved'
             order by r.created_at loop
    perform _lk_money_back(fr.id, who, why);
    update locker_rentals set status = 'cancelled', cancelled_at = now(), cancelled_by = left(who, 60), cancel_reason = why
     where id = fr.id and status = 'reserved';
  end loop;
  return null;
end $$;
revoke execute on function public._lk_session_cancelled() from public, anon, authenticated;
drop trigger if exists sessions_lockers_cancelled on public.sessions;
create trigger sessions_lockers_cancelled after update of cancelled_at, status on public.sessions
  for each row when ((old.cancelled_at is null and new.cancelled_at is not null)
                     or (new.status = 'deleted' and old.status is distinct from 'deleted'))
  execute function public._lk_session_cancelled();

-- ── 7. A returned booking removed: its Petromin / Dukan registration is no longer billed (sql03-2) ─────────────────
-- _rider_reg_follow_booking from 20261028140000_staff_review_money.sql; one branch added.
create or replace function public._rider_reg_follow_booking()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_by text;
begin
  if not exists (select 1 from rider_registrations r where r.matched_entry_id = new.id) then
    return null;
  end if;
  select left(nullif(btrim(s.display_name), ''), 120) into v_by from staff s where s.user_id = auth.uid();
  if new.status = 'active' and old.status = 'done' then
    update rider_registrations r set checked_out_at = null, checked_out_by = null
     where r.matched_entry_id = new.id and r.checked_out_at is not null;
  elsif new.status = 'active' then
    update rider_registrations r set checked_in_at = now(), checked_in_by = coalesce(r.checked_in_by, v_by)
     where r.matched_entry_id = new.id and r.checked_in_at is null;
  elsif new.status = 'done' then
    update rider_registrations r
       set checked_in_at = coalesce(r.checked_in_at, now()),
           checked_in_by = case when r.checked_in_at is null then coalesce(r.checked_in_by, v_by) else r.checked_in_by end,
           checked_out_at = now(),
           checked_out_by = coalesce(r.checked_out_by, v_by)
     where r.matched_entry_id = new.id and r.checked_out_at is null;
  elsif new.status in ('removed', 'noshow', 'cancelled') and old.status = 'done' then
    -- A returned booking taken off (History > Remove, a correction) is no ride: its registration is no longer
    -- returned, so the company is not billed for it, as the month's takings already leave a removed booking out
    -- (_mt_core). Undoing it (back to done) returns it again (bug hunt 2026-11-18, sql03-2).
    update rider_registrations r set checked_out_at = null, checked_out_by = null
     where r.matched_entry_id = new.id and r.checked_out_at is not null;
  elsif new.status in ('waiting', 'waitlist') and old.status = 'done' then
    update rider_registrations r set checked_out_at = null, checked_out_by = null
     where r.matched_entry_id = new.id and r.checked_out_at is not null;
  elsif new.status in ('waiting', 'waitlist') and old.status = 'active' then
    update rider_registrations r set checked_in_at = null, checked_in_by = null
     where r.matched_entry_id = new.id and r.checked_in_at is not null and r.checked_out_at is null;
  end if;
  return null;
end
$fn$;
revoke all on function public._rider_reg_follow_booking() from public, anon, authenticated;

-- ── 8. A second promotion off the waitlist is a new Updates entry (sql04-2) ───────────────────────────────────────
-- _updates_wl_in from 20261114080300_updates_list.sql; only its ON CONFLICT changed.
create or replace function public._updates_wl_in()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare s sessions%rowtype; t record;
begin
  begin
    if new.customer_id is null then return null; end if;
    if exists (select 1 from waitlist_offers o
                where o.booking_id = new.id and o.status = 'claimed' and o.claimed_at > now() - interval '5 minutes') then
      return null;
    end if;
    select * into s from sessions where id = new.session_id;
    if not found or s.status = 'deleted' or s.session_date < to_char(_ksa_today(), 'YYYY-MM-DD') then return null; end if;
    select * into t from _push_text(new.customer_id, 'wlin', array[_push_sess_name(new.customer_id, s.title, s.ride_kind)]);
    insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
    values (new.customer_id, left('booking-' || new.id, 64), left(t.title, 120), left(t.body, 300), '/my-bookings', 'rides',
            'wlin', array[coalesce(nullif(trim(s.title), ''), 'kind:' || coalesce(s.ride_kind, 'jcc'))])
    -- A booking given a place a second time (staff put it back on the waitlist) is new again: the row is written
    -- afresh, unread, with what the gate decided for it now (EXCLUDED carries the gate's sent_at / result / lang), and
    -- keeps its tag, so a phone still shows one notification for it (bug hunt 2026-11-18, sql04-2).
    on conflict (customer_id, tag) do update
       set title = excluded.title, body = excluded.body, url = excluded.url, cat = excluded.cat, lang = excluded.lang,
           key = excluded.key, args = excluded.args, sent_at = excluded.sent_at, result = excluded.result,
           created_at = now(), read_at = null;
  exception when others then
    null; -- a booking is never refused for a message
  end;
  return null;
end $$;
revoke all on function public._updates_wl_in() from public, anon, authenticated;

-- ── 9. A waitlisted booking moved to another ride is offered places there (sql05-5) ─────────────────────────────────
-- _wl_offer_fill: the live text (20261111235000_bh11_live_a.sql, with 20261111180600_type_caps's line put back by that
-- file's 11b) is patched in place, one condition: the offers that bar a booking from another offer are the ones it had
-- on THIS ride. An offer it let lapse or declined on the ride it was moved from barred it on every ride after, and riders
-- behind it were offered the places. pg_get_functiondef keeps the header (SECURITY DEFINER, search_path) and the grants.
do $wl$
declare
  d text;
  a text := $a$       and not exists (select 1 from waitlist_offers o where o.booking_id = q.id
                        and o.status in ('open', 'expired', 'declined'))$a$;
  b text := $b$       and not exists (select 1 from waitlist_offers o where o.booking_id = q.id and o.session_id = p_session_id
                        and o.status in ('open', 'expired', 'declined'))   /* this ride's own offers (20261119000100) */$b$;
begin
  select pg_get_functiondef('public._wl_offer_fill(text)'::regprocedure) into d;
  if position('(20261119000100)' in d) > 0 then return; end if; /* already patched: a re-run */
  if (length(d) - length(replace(d, a, ''))) <> length(a) then
    raise exception '_wl_offer_fill: the offers condition was not found exactly once';
  end if;
  execute replace(d, a, b);
end $wl$;

-- An offer left open on the ride a booking moved away from is closed, and that ride's next rider is offered the place.
-- The offer kept counting against the old ride's free places until it lapsed, and, open, it stopped the booking being
-- offered a place on its new ride (one open offer per booking). Checked when the transaction commits, against where the
-- booking is then: a whole session moved by date (staff_move_session moves its bookings first and their offers after)
-- keeps its offers. Never refuses the move.
create or replace function public._wl_offer_moved()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare cur text; sid text;
begin
  begin
    select q.session_id into cur from queue_entries q where q.id = new.id;
    if not found then return null; end if; -- the booking is gone, and its offers with it (on delete cascade)
    for sid in
      with x as (update waitlist_offers set status = 'closed'
                  where booking_id = new.id and status = 'open' and session_id is distinct from cur
                  returning session_id)
      select distinct session_id from x
    loop
      begin
        perform _wl_offer_fill(sid);
      exception when others then
        null; -- the place is offered at the next pass instead
      end;
    end loop;
  exception when others then
    null; -- a booking is never refused for an offer
  end;
  return null;
end $$;
revoke all on function public._wl_offer_moved() from public, anon, authenticated;
drop trigger if exists queue_entries_wl_offer_moved on public.queue_entries;
create constraint trigger queue_entries_wl_offer_moved
  after update of session_id on public.queue_entries
  deferrable initially deferred
  for each row when (old.session_id is distinct from new.session_id)
  execute function public._wl_offer_moved();

-- ── checks ─────────────────────────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text; t text;
begin
  foreach f in array array['public.staff_customer_export(text)', 'public._hub_push_tick()', 'public._hub_auto_post(text)',
                           'public._hub_tick()', 'public._lk_booking_follow()', 'public._lk_kind(text)',
                           'public._lk_session_cancelled()', 'public._rider_reg_follow_booking()', 'public._updates_wl_in()',
                           'public._wl_offer_fill(text)', 'public._wl_offer_moved()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then
      raise exception '% is open to anon', f;
    end if;
    if f <> 'public.staff_customer_export(text)' and has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is open to authenticated', f;
    end if;
  end loop;
  if position('(20261119000100)' in (select prosrc from pg_proc where oid = 'public._wl_offer_fill(text)'::regprocedure)) = 0 then
    raise exception '_wl_offer_fill was not patched';
  end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('staff_customer_export', '_hub_push_tick', '_hub_auto_post', '_hub_tick', '_lk_booking_follow', '_lk_kind',
                        '_lk_session_cancelled', '_rider_reg_follow_booking', '_updates_wl_in', '_wl_offer_fill', '_wl_offer_moved')) <> 11 then
    raise exception 'a replaced function gained a second overload';
  end if;
  foreach t in array array['sessions_lockers_cancelled', 'queue_entries_wl_offer_moved', 'queue_entries_wl_offer_close',
                           'queue_entries_updates_wl', 'queue_entries_rider_sync'] loop
    if not exists (select 1 from pg_trigger where tgname = t and not tgisinternal and tgenabled <> 'D') then
      raise exception 'trigger % missing', t;
    end if;
  end loop;
  -- no table of the People section is left writable by any staff account
  if exists (select 1 from pg_policies where schemaname = 'public'
               and tablename in ('hub_posts', 'hub_club_goals', 'hub_ramadan', 'hub_goals', 'rotm_rounds', 'member_welcome', 'squads',
                                 'hub_photos', 'mentor_profiles', 'mentor_mentors', 'mentor_offers', 'mentor_checks', 'customer_badges',
                                 'badge_requests', 'farm_codes')
               and cmd <> 'SELECT' and position('_staff_mod' in coalesce(qual, '') || coalesce(with_check, '')) = 0
               and position('is_admin' in coalesce(qual, '') || coalesce(with_check, '')) = 0) then
    raise exception 'a People table still has a write policy on is_staff() alone';
  end if;
  foreach f in array array['public.is_staff()', 'public.is_admin()', 'public._staff_mod(text,boolean)'] loop
    if to_regprocedure(f) is null then raise exception '% is missing', f; end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119000100', 'bh18_db1')
on conflict do nothing;

commit;

-- check: select p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') as anon,
-- check:        position('(20261119000100)' in p.prosrc) > 0 as patched
-- check:   from pg_proc p where p.pronamespace = 'public'::regnamespace
-- check:    and p.proname in ('staff_customer_export', '_hub_push_tick', '_hub_auto_post', '_hub_tick', '_lk_booking_follow', '_lk_kind',
-- check:                      '_lk_session_cancelled', '_rider_reg_follow_booking', '_updates_wl_in', '_wl_offer_fill', '_wl_offer_moved')
-- check:  order by 1;
-- check: select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname = 'public'
-- check:    and tablename in ('hub_posts', 'hub_club_goals', 'hub_ramadan', 'hub_goals', 'rotm_rounds', 'member_welcome', 'squads', 'hub_photos',
-- check:                      'mentor_profiles', 'mentor_mentors', 'mentor_offers', 'mentor_checks', 'customer_badges', 'badge_requests', 'farm_codes')
-- check:  order by 1, 2;
-- check: select tgname, tgdeferrable, tginitdeferred from pg_trigger
-- check:  where tgname in ('sessions_lockers_cancelled', 'queue_entries_wl_offer_moved') order by 1;
-- check: select name from supabase_migrations.schema_migrations where version = '20261119000100';
