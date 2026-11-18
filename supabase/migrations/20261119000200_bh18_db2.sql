-- ============================================================================
-- Bug hunt 2026-11-18, package db2: the rider-facing RPCs (laps, booking moves, the community form, birth dates,
-- photos, the farm night, the Community tab, the website Members area). Signatures and grants unchanged.
--
--  1. circuit_lap (mods0-4): the season was decided by the day the call came, so a lap ridden on the season's last
--     evening and sent after midnight by a phone that had no signal was dropped as out of season. The season now
--     holds the lap's own day in Riyadh (now() less p_ago); 'live' in the answer stays today's.
--  2. circuit_lap (mods0-3, sql05-6): each call back-dated by p_ago (0..3600 s) with a new key passed the gap test
--     on its own back-dated moment, so a rider checked in for an hour could make a whole season of laps in one
--     second. Now at most three of the rider's laps may ARRIVE within the challenge's minimum time
--     (circuit_laps.created_at is when a lap arrived; no new column): a phone's kept scans (one or two) still go
--     in when the signal returns, while a burst of back-dated calls is answered 'gap'. The hour that p_ago may
--     reach stays, as the lap page sends kept scans up to an hour old.
--  3. customer_booking_update (sql05-1): a move checked only the ride moved to, so a paid booking (desk, card,
--     wallet) still 'waiting' on a ride that had ended moved to a later ride with the same fare and kept its
--     payment, while a cancel of it is refused (20261110235000). A move off a ride that has ended (by its date or
--     its window) is now refused for a paid or wallet-paid row, as the cancel is.
--  4. customer_booking_update (sql05-3): a move took 'waiting' whenever the ride's status read open, with no lock
--     and no count, so two riders moving onto the last place at once both took it. The ride moved to is now read
--     FOR UPDATE and its places counted under the 'cap:' lock exactly as _capacity_guard counts a new booking's
--     (an own bike takes no place but on the Petromin ride); past the capacity the move lands on the waitlist,
--     as a new booking does. The members limit stays _community_booking_gate's (it refuses MEMBER_BIKES_FULL).
--  5. customer_booking_update (sql05-4): in claim mode a waitlisted rider who cancelled (or moved) while holding an
--     open offer left that place unoffered: the trigger closed the offer and nothing filled. Such a row now closes
--     its offer (a move onto another ride's waitlist left it open) and calls _wl_offer_fill for the ride it left,
--     as a Decline does. _wl_offer_fill does nothing outside claim mode.
--  6. customer_community_me, customer_community_apply (sql06-3): an application with no account, matched by an
--     email or a number the account shares, filled the form with that person's birth date, nationality, handles,
--     workplace and WhatsApp and the address of their status page, and a send took the application over. Staff
--     may put one number on several accounts. customer_community_me now reads only the account's own
--     application; customer_community_apply links one with no account by its email only, never by the number.
--  7. _dob_ok (new helper), customer_set_birth_nat, customer_update_profile, customer_fix_save (sql07-5): a birth
--     date was checked only as a real date up to today (_ymd_ok), so a rider of 0-4 could be stored, against the
--     owner's rule (5 or older) that community_apply, community_fix_submit, customer_community_apply and
--     _learn_app_to_account keep. _dob_ok(v) = _ymd_ok(v) and v <= today in Riyadh less 5 years, the same
--     boundary as those doors; a younger date leaves the stored one as an impossible date does.
--  8. customer_set_photo, customer_fix_save (sql07-4): the https photo had to be ANY Supabase project's photos
--     bucket, so a rider's own project passed and every staff screen fetched the rider's image from the rider's
--     server. It is now this project's bucket, by its address (qpffkzmsfyilicwcsszz, the production ref the app
--     already carries). The app sends only data: URLs here, so nothing it does changes; on staging an https link
--     to staging's own bucket is refused too (no client sends one).
--  9. farm_night, farm_book (sql07-2, form-farmhouse-0-1): a farm night staff marked Full read 'Places open' on
--     micromobility.sa/farmhouse, and farm_book answered ok while customer_create_booking put every row on the
--     waitlist (the page has none). farm_night now says 'full' for it and farm_book refuses it with 'full', which
--     the page already shows ("The Farmhouse Night is fully booked.").
-- 10. hub_post_img (sql07-3): the photo of a post staff had hidden was still handed out by id until shows_until.
--     A hidden post now gives none, as hub_feed shows it to no one.
-- 11. member_area (sql08-2): 'booked' was true for a waitlist booking, so the website Members area said Booked to a
--     member who held no place. 'booked' is now a place held (waiting, active); a new 'waitlist' says the member
--     is only on the waitlist (never a place in the line). The website needs MembersArea.tsx to show it (see the
--     package notes); until then such a ride shows the Book link instead of Booked.
--
-- Not changed: sql07-1 (customer_update_profile taking another account's email). The live function refuses it:
-- 20261007120000 patched it in place to raise 'email_taken' (23505) for a changed email another account holds,
-- which the extract the hunt read did not show. The check block below asserts that it is still there.
--
-- Where each rebuilt function comes from (the newest full text, every earlier change kept):
--   circuit_lap               20261114082500_circuit_challenge.sql
--   customer_booking_update   20261111235000_bh11_live_a.sql
--   customer_community_me     20261025210000_application_track_and_changes.sql (it carries 20261007120000's change)
--   customer_set_birth_nat    20260922150000_account_delete_narrow_saves_refusal_codes.sql
--   customer_set_photo        20261028120100_bh28_public.sql
--   farm_night, farm_book     20261115210000_farmhouse_page.sql
--   hub_post_img              20261111100000_community_tab.sql
--   member_area               20261028100000_session_gender_visible.sql (it carries 20261007120000's change)
-- Patched in place from their live text (pg_get_functiondef: each anchor must be found exactly once; header,
-- SECURITY DEFINER, search_path and grants stay): customer_community_apply (patched in place before by
-- 20261109200000 and 20261110235400), customer_update_profile (by 20261007120000), customer_fix_save (by
-- 20261109200000, 20261110233000, 20261111130000). Every changed function carries '(20261119000200)'.
--
-- Rollback: re-run the eight full functions from the files above; run each in-place patch backwards (the new text
-- back to its anchor); drop function public._dob_ok(text) after the four birth-date doors are back on _ymd_ok.
-- Idempotent: the full functions are CREATE OR REPLACE, each patch is skipped once its function carries
-- '(20261119000200)'. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


-- ── 1, 2. circuit_lap: the lap's own day; no burst of back-dated laps ──────────────────────────────
create or replace function public.circuit_lap(p_id text, p_token text, p_code text, p_add boolean default true,
                                              p_key text default null, p_ago integer default 0)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare
  c circuit_challenges%rowtype;
  v_today date := _ksa_today();
  v_accts text[]; v_key text; v_at timestamptz; v_sess text;
  v_n integer; v_live boolean; v_added boolean := false; v_why text; v_held boolean := false; v_new boolean := false;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select * into c from circuit_challenges where code = lower(btrim(coalesce(p_code, '')));
  if not found then return jsonb_build_object('ok', false, 'error', 'none'); end if;
  v_accts := _accts_of(p_id);
  v_live := v_today between c.starts_on and c.ends_on;
  v_key := case when p_key ~ '^[a-z0-9]{8,40}$' then p_key end;

  if coalesce(p_add, false) then
    -- one call at a time per rider and challenge: two taps of one scan must not both pass the interval check
    perform pg_advisory_xact_lock(hashtext('circuitlap:' || c.id || ':' || p_id));
    -- the lap's own moment: a scan kept with no signal comes later with its age, at most an hour
    v_at := now() - make_interval(secs => least(greatest(coalesce(p_ago, 0), 0), 3600));
    if v_key is not null and exists (select 1 from circuit_laps l where l.customer_id = p_id and l.client_key = v_key) then
      v_added := true;   -- this very scan is already counted: its first answer was lost on the way back
    /* The season holds the lap's own day in Riyadh, not the day the call came: a scan from the season's last
       evening that a phone with no signal sent after midnight was dropped as out of season (bug hunt 2026-11-18,
       mods0-4) (20261119000200). 'live' in the answer stays today's. */
    elsif (v_at at time zone 'Asia/Riyadh')::date not between c.starts_on and c.ends_on then
      v_why := 'season';
    /* At most three of the rider's laps arrive within the challenge's minimum time (created_at is when each one
       arrived): kept scans still go in when the signal comes back, but calls back-dated one after another (p_ago
       0, g, 2g, ...) no longer make a whole season of laps at once (bug hunt 2026-11-18, mods0-3, sql05-6). */
    elsif (select count(*) from circuit_laps l
            where l.challenge_id = c.id and l.customer_id = any(v_accts)
              and l.created_at > now() - make_interval(secs => c.min_gap_s)) >= 3 then
      v_why := 'gap';
    else
      select q.session_id into v_sess
        from queue_entries q
        join sessions s on s.id = q.session_id
        cross join lateral _session_window(s) w
       where q.customer_id = any(v_accts)
         and (q.status = 'active' or (q.status = 'done' and _circuit_ts(q.checked_out_at::text) >= v_at))
         and coalesce(_circuit_ts(q.checked_in_at::text), v_at) <= v_at + interval '5 minutes'
         and (coalesce(s.event_kind, '') <> 'community' or s.ride_kind in ('petromin', 'snd96'))
         and v_at >= w.starts_at - interval '15 minutes' and v_at <= w.ends_at + interval '30 minutes'
       order by w.starts_at desc
       limit 1;
      if v_sess is null then
        v_why := 'booking';
      elsif exists (select 1 from circuit_laps l
                     where l.challenge_id = c.id and l.customer_id = any(v_accts)
                       and l.at > v_at - make_interval(secs => c.min_gap_s)
                       and l.at < v_at + make_interval(secs => c.min_gap_s)) then
        v_why := 'gap';
      else
        insert into circuit_laps (challenge_id, customer_id, session_id, at, client_key)
        values (c.id, p_id, v_sess, v_at, v_key) on conflict do nothing;
        v_added := found;
      end if;
    end if;
  end if;

  select count(*)::integer into v_n from circuit_laps l where l.challenge_id = c.id and l.customer_id = any(v_accts);
  if c.badge_id is not null then
    v_held := exists (select 1 from customer_badges cb where cb.badge_id = c.badge_id and cb.customer_id = any(v_accts));
    if not v_held and v_n >= c.target and exists (select 1 from badges b where b.id = c.badge_id and not b.retired) then
      insert into customer_badges (customer_id, badge_id, awarded_by, note)
      values (p_id, c.badge_id, 'system', left(c.name, 140)) on conflict do nothing;
      v_new := found; v_held := true;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'name', c.name, 'name_ar', c.name_ar, 'names', c.names, 'target', c.target,
    'n', v_n, 'added', v_added, 'why', v_why, 'live', v_live, 'starts_on', c.starts_on, 'ends_on', c.ends_on,
    'gap', c.min_gap_s, 'badge', v_held, 'new_badge', v_new,
    'badge_slug', (select b.slug from badges b where b.id = c.badge_id));
end $$;
revoke all on function public.circuit_lap(text, text, text, boolean, text, integer) from public;
grant execute on function public.circuit_lap(text, text, text, boolean, text, integer) to anon, authenticated;


-- ── 3, 4, 5. customer_booking_update: moves and a waitlisted row's open offer ──────────────────────
CREATE OR REPLACE FUNCTION public.customer_booking_update(p_id text, p_token text, p_entry_id text, p_patch jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  q queue_entries%rowtype; _to sessions%rowtype; _at sessions%rowtype; _p jsonb; _today text;
  _want text; _new_status text; _move boolean := false; _qnum int; _live int;
  _type text; _size text; _h int; _name text; _addons text; _set_addons boolean := false;
  _code text; _unpay boolean := false; _rb int; _re int; _cancelling boolean;
  _cu customers%rowtype; _dp text; _house text; _reapprove boolean := false; _to_own boolean := false;
  _rt text[]; _rd jsonb; _ended boolean;
  _ended_at boolean; _mt text; _ownc boolean; _had_offer boolean := false;   -- (20261119000200)
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  _p := coalesce(p_patch, '{}'::jsonb);
  if jsonb_typeof(_p) <> 'object' then return false; end if;
  select * into q from queue_entries x where x.id = p_entry_id and x.customer_id = p_id for update;
  if not found then return false; end if;
  select * into _cu from customers where customers.id = p_id;
  _today := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  _want := nullif(_p->>'status', '');
  if _want = q.status then _want := null; end if;
  if _want is not null and _want not in ('cancelled','waiting','waitlist') then return false; end if;
  if _p ? 'session_id' and (_p->>'session_id') is distinct from q.session_id then
    if q.status not in ('waiting','waitlist') or _want = 'cancelled' then return false; end if;
    select * into _at from sessions where sessions.id = q.session_id;
    /* A paid ride that has ended is settled at close-out, not moved by the rider: the cancel's rule (20261110235000),
       which a move did not follow, so a missed paid ride became a paid place on a later one with the same fare (bug
       hunt 2026-11-18, sql05-1) (20261119000200). A time the window cannot read closes nothing, as there. */
    if coalesce(q.paid, false) or coalesce(q.wallet_paid, 0) > 0 then
      begin _ended_at := (select w.ends_at from _session_window(_at) w) <= now();
      exception when others then _ended_at := false; end;
      if left(coalesce(_at.session_date, q.session_date, ''), 10) < _today or coalesce(_ended_at, false) then
        return false;
      end if;
    end if;
    -- the ride moved to is held while its places are counted below (sql05-3)
    select * into _to from sessions where sessions.id = _p->>'session_id' for update;
    -- a ride that ended earlier today takes no one, as a new booking (bug hunt 2026-10-28); a time the
    -- window cannot read closes nothing
    begin _ended := (select w.ends_at from _session_window(_to) w) <= now();
    exception when others then _ended := false; end;
    if _to.id is null
       or coalesce(_to.status,'') not in ('open','full')
       or coalesce(_to.needs_approval,false) or coalesce(_at.needs_approval,false)
       or coalesce(_to.ride_kind,'') = 'snd96' or coalesce(_at.ride_kind,'') = 'snd96'
       or _to.session_date < _today or coalesce(_ended, false)
       or (_to.required_tag_id is not null and not exists (
             select 1 from customer_tags ct
              where ct.customer_id = p_id and ct.tag_id = _to.required_tag_id
                and _ctag_active(ct.starts_at, ct.expires_at))) then
      return false;
    end if;
    _move := true;
    _new_status := case when coalesce(_to.status,'') = 'full' or _want = 'waitlist' then 'waitlist' else 'waiting' end;
    /* The places, counted under the ride's lock as _capacity_guard counts a new booking's: two riders moving onto
       the last place at once both took it, as the status read said open (bug hunt 2026-11-18, sql05-3). An own
       bike takes no place but on the Petromin ride; the members limit stays _community_booking_gate's. */
    if _new_status = 'waiting' then
      _mt := case when _p ? 'type_preference' and _type_ok(_p->>'type_preference') and (_p->>'type_preference') <> 'Any'
                  then _p->>'type_preference' else q.type_preference end;
      _ownc := coalesce(_to.event_kind, '') = 'community' and coalesce(_to.ride_kind, '') = 'petromin';
      if coalesce(_mt, '') <> 'Own' or _ownc then
        perform pg_advisory_xact_lock(hashtext('cap:' || _to.id));
        select count(*) into _live from queue_entries x
         where x.session_id = _to.id and x.id <> q.id
           and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow')
           and (_ownc or coalesce(x.type_preference, '') <> 'Own');
        if _live >= coalesce(_to.capacity, 12) then _new_status := 'waitlist'; end if;
      end if;
    end if;
    update sessions
       set last_qnum = greatest(coalesce(last_qnum, 0),
                                coalesce((select max(x.queue_num) from queue_entries x where x.session_id = _to.id), 0)) + 1
     where sessions.id = _to.id
     returning last_qnum into _qnum;
  elsif _want = 'cancelled' then
    if q.status not in ('waiting','waitlist') then return false; end if;
    /* A paid ride that has ended is settled at close-out, not by the rider: cancelled afterwards it gave
       its wallet money back for a ride missed (bug hunt 2026-11-10, 20261110235000). */
    if coalesce(q.paid, false) or coalesce(q.wallet_paid, 0) > 0 then
      select * into _at from sessions where sessions.id = q.session_id;
      begin _ended := (select w.ends_at from _session_window(_at) w) <= now();
      exception when others then _ended := false; end;
      if left(coalesce(_at.session_date, q.session_date, ''), 10) < _today or coalesce(_ended, false) then
        return false;
      end if;
    end if;
    _new_status := 'cancelled';
  elsif _want in ('waiting','waitlist') then
    if q.status <> 'cancelled' or coalesce(q.cancelled_by,'') <> 'customer' then return false; end if;
    select * into _at from sessions where sessions.id = q.session_id;
    begin _ended := (select w.ends_at from _session_window(_at) w) <= now();   -- (bug hunt 2026-10-28)
    exception when others then _ended := false; end;
    if _at.id is null or coalesce(_at.status,'') not in ('open','full') or _at.session_date < _today
       or coalesce(_ended, false) then   -- ended earlier today, as a new booking
      return false;
    end if;
    -- a private ride takes a rider back only while they hold its tag, as a new booking would (20261014120000)
    if _at.required_tag_id is not null and not exists (
         select 1 from customer_tags ct
          where ct.customer_id = p_id and ct.tag_id = _at.required_tag_id
            and _ctag_active(ct.starts_at, ct.expires_at)) then
      return false;
    end if;
    if coalesce(_at.event_kind,'') = 'community' then
      if not coalesce(_at.open_to_all,false)
         and not (coalesce(_at.ride_kind,'') = 'petromin' and _petromin_holder(p_id))   -- (20261012180000)
         and not (coalesce(_at.ride_kind,'') = 'vlap' and _vlap_holder(p_id))           -- (20261017210000)
         and not exists (
           select 1 from customer_tags ct join tags tg on tg.id = ct.tag_id
            where ct.customer_id = p_id and lower(tg.slug) = 'saturday'
              and _ctag_active(ct.starts_at, ct.expires_at)) then
        return false;
      end if;
      select count(*) into _live from queue_entries x
       where x.session_id = q.session_id and x.customer_id = p_id and x.id <> q.id
         and coalesce(x.status,'') not in ('cancelled','removed','noshow');
      -- the cap _group_ride_cap applies: an event takes five per booker (20261004100000)
      if _live >= (case when coalesce(_at.needs_approval,false) then 1
                        when coalesce(_at.ride_kind,'') = 'snd96' then _biz_int('jcc_account_cap', 3)
                        when coalesce(_at.ride_kind,'') = 'event' then _biz_int('event_seat_max', 5)
                        else _biz_int('group_ride_max', 2) end) then return false; end if;   -- Settings > Business, as _group_ride_cap (20261014120000)
    else
      -- Every other ride: three per account, as _group_ride_cap counts them (20261005210000).
      select count(*) into _live from queue_entries x
       where x.session_id = q.session_id and x.customer_id = p_id and x.id <> q.id
         and coalesce(x.status,'') in ('waiting','active','waitlist');
      if _live >= _biz_int('jcc_account_cap', 3) then return false; end if;
    end if;
    _new_status := case when _want = 'waiting' and _session_has_room(q.session_id, q.type_preference, q.id)
                        then 'waiting' else 'waitlist' end;
    _reapprove := coalesce(_at.needs_approval, false);
    if exists (select 1 from queue_entries x
                where x.session_id = q.session_id and x.queue_num = q.queue_num and x.id <> q.id
                  and x.status not in ('cancelled','removed','noshow')) then
      update sessions
         set last_qnum = greatest(coalesce(last_qnum, 0),
                                  coalesce((select max(x.queue_num) from queue_entries x where x.session_id = q.session_id), 0)) + 1
       where sessions.id = q.session_id
       returning last_qnum into _qnum;
    end if;
    /* The holder's free row (the house rule, VIP) comes back free only while they have no other free row on
       the ride: one booked after the cancel took the one free place, so this one comes back to pay
       (bug hunt 2026-11-11, sql03-5). _enforce_booking_price prices it as it leaves paid. A friend's row
       staff put on the house is not the holder's and keeps what staff gave. */
    if coalesce(q.paid, false) and coalesce(q.price, 0) = 0 and coalesce(q.promo_code, '') = ''
       and coalesce(_fare_now(q.session_id, q.id, q.type_preference), 0) > 0
       and (lower(btrim(coalesce(q.name, ''))) = lower(btrim(coalesce(_cu.name, '')))
            or (btrim(coalesce(q.name, '')) <> '' and exists (
                  select 1 from audit_log a
                   where a.tbl = 'customers' and a.row_id = p_id and a.op = 'UPDATE' and a.changed ? 'name'
                     and lower(btrim(coalesce(a.changed -> 'name' ->> 'old', ''))) = lower(btrim(q.name)))))
       and _house_taken(p_id, q.session_id, q.id) then
      _unpay := true;
    end if;
  end if;
  if q.status in ('waiting','waitlist') and coalesce(_new_status,'') <> 'cancelled' then
    if _p ? 'type_preference' and _type_ok(_p->>'type_preference') and (_p->>'type_preference') <> 'Any' then _type := _p->>'type_preference'; end if;
    if _p ? 'size' and coalesce(_p->>'size','') in ('','XS','S','M','L','XL') then _size := coalesce(_p->>'size',''); end if;
    if (_p->>'height') ~ '^[0-9]{3}$' and (_p->>'height')::int between 100 and 250 then _h := (_p->>'height')::int; end if;
    if _p ? 'name' then
      _name := nullif(left(btrim(regexp_replace(coalesce(_p->>'name',''), '\s+', ' ', 'g')), 60), '');
      -- letters and spaces only, as every other customer door takes a name: else the name stays (bug hunt 2026-10-28)
      if _name is not null and (not _name_chars_ok(_name) or not _name_parts_ok(_name)) then _name := null; end if;
    end if;
    if _p ? 'promo_code' then
      _code := nullif(btrim(coalesce(_p->>'promo_code','')), '');
      -- A paid row takes no new code: there is nothing left to discount (20261005210000).
      if _code is null or _code !~ '^[A-Za-z0-9_-]{1,40}$' or coalesce(q.promo_code,'') <> '' or q.paid then _code := null; end if;
    end if;
    if q.paid and coalesce(q.price,0) = 0 and coalesce(q.promo_code,'') = '' then
      if _type is not null and _type is distinct from q.type_preference then
        _dp := coalesce(_cu.default_pay, '');
        _house := case when _is_vip(p_id) then 'all'   -- a VIP rides free on every type (20261005210000)
                       when _dp = 'house' then 'all' when _dp like 'house:%' then substring(_dp from 7) end;
        if _house is null or not (_house = 'all' or _type = any(string_to_array(_house, ','))) then _unpay := true; end if;
      end if;
      if _name is not null and lower(btrim(coalesce(q.name,''))) = lower(btrim(coalesce(_cu.name,'')))
         and lower(_name) <> lower(btrim(coalesce(_cu.name,''))) then
        _unpay := true;
      end if;
    /* A paid row takes another type only at no higher fare: fare against fare, as a move compares them (a
       code or a party's share left the price paid under the fare, and every change was refused), and a code
       kept to one type does not go with the row to another (bug hunt 2026-11-11, sql03-4). */
    elsif q.paid and _type is not null and _type is distinct from q.type_preference
          and (coalesce(_fare_now(q.session_id, q.id, _type), 0)
                 > greatest(coalesce(_fare_now(q.session_id, q.id, q.type_preference), 0), coalesce(q.price, 0))
               or (coalesce(q.promo_code, '') <> '' and exists (
                     select 1 from promo_codes c
                      where lower(c.code) = lower(q.promo_code)
                        and c.applies_to is not null and c.applies_to is distinct from _type))) then
      return false;
    end if;
  end if;
  if _p ? 'addons' and q.status in ('waiting','waitlist','active') and coalesce(_new_status,'') <> 'cancelled' then
    _addons := nullif(_p->>'addons','');
    _set_addons := _addons is null or _addons_ok(_addons);
    if _set_addons and _addons is not null and (
         jsonb_array_length(_addons::jsonb) > 20
         or exists (select 1 from jsonb_each_text(_addon_map(_addons)) m where m.value::int > 20)) then
      _set_addons := false;
    end if;
    if _set_addons and q.status = 'active' and exists (
         select 1 from jsonb_each_text(_addon_map(q.addons)) o
          where coalesce((_addon_map(_addons)->>o.key)::int, 0) < o.value::int) then
      _set_addons := false;
    end if;
    /* A booking paid at the desk, by card or online takes no more of a priced add-on: it stayed paid, so
       nobody collected it (bug hunt 2026-11-10). The wallet's own rows follow in _wallet_follow; a ride
       on the house as before. */
    if _set_addons and coalesce(q.paid, false) and coalesce(q.pay_method, '') <> 'wallet'
       and not (coalesce(q.price, 0) = 0 and coalesce(q.promo_code, '') = '')
       and exists (select 1 from jsonb_each_text(_addon_map(_addons)) n join inventory i on i.id = n.key
                    where coalesce(i.price, 0) > 0
                      and n.value::int > coalesce((_addon_map(q.addons)->>n.key)::int, 0)) then
      return false;
    end if;
  end if;
  -- A ride still ahead is not rated (20261004100000).
  if coalesce(q.session_date, '') > _today then
    _p := _p - 'rating_bike' - 'rating_exp' - 'rating_tags' - 'rating_detail' - 'feedback';
  end if;
  if _p ? 'rating_bike' then
    _rb := case when (_p->>'rating_bike') ~ '^[0-9]{1,2}$' and (_p->>'rating_bike')::int between 1 and 10 then (_p->>'rating_bike')::int end;
  end if;
  if _p ? 'rating_exp' then
    _re := case when (_p->>'rating_exp') ~ '^[0-9]{1,2}$' and (_p->>'rating_exp')::int between 1 and 10 then (_p->>'rating_exp')::int end;
  end if;
  if _p ? 'rating_tags' and jsonb_typeof(_p->'rating_tags') = 'array' then
    select array_agg(x order by o) into _rt
      from (select x, o from jsonb_array_elements_text(_p->'rating_tags') with ordinality as e(x, o)
             where x ~ '^[a-z_]{1,24}$' limit 8) s;
  end if;
  if _p ? 'rating_detail' and jsonb_typeof(_p->'rating_detail') = 'object' then
    _rd := jsonb_strip_nulls(jsonb_build_object(
      'form', case when (_p->'rating_detail'->>'form') in ('rental','social') then _p->'rating_detail'->>'form' end,
      's', (select coalesce(jsonb_object_agg(k, case when v ~ '^[0-9]{1,2}$' then v::int end), '{}'::jsonb)
              from (select k, v from jsonb_each_text(case when jsonb_typeof(_p->'rating_detail'->'s') = 'object'
                                                          then _p->'rating_detail'->'s' else '{}'::jsonb end) e(k, v)
                     where k ~ '^[a-z_]{1,24}$'
                       and (case when v ~ '^[0-9]{1,2}$' then v::int end) between 1 and 10
                     limit 20) s1),
      'why', (select coalesce(jsonb_object_agg(k, left(btrim(v), 300)), '{}'::jsonb)
                from (select k, v from jsonb_each_text(case when jsonb_typeof(_p->'rating_detail'->'why') = 'object'
                                                            then _p->'rating_detail'->'why' else '{}'::jsonb end) e(k, v)
                       where k ~ '^[a-z_]{1,24}$' and btrim(v) <> ''
                       limit 20) w1),
      'skip_bf', case when (_p->'rating_detail'->>'skip_bf') = 'true' then true end));
  end if;
  -- A paid booking keeps what it paid: it moves only to a ride with the same fare for its type.
  -- A free row the account's house rule (or VIP) still covers moves as before (20261005210000).
  if _move and q.paid and not _unpay
     and coalesce(_fare_now(_to.id, q.id, coalesce(_type, q.type_preference)), 0)
         <> coalesce(_fare_now(q.session_id, q.id, coalesce(_type, q.type_preference)), 0)
     and not (coalesce(q.price, 0) = 0 and coalesce(q.promo_code, '') = ''
              and (_is_vip(p_id) or coalesce(_cu.default_pay, '') = 'house'
                   or (coalesce(_cu.default_pay, '') like 'house:%'
                       and coalesce(_type, q.type_preference) = any(string_to_array(substring(_cu.default_pay from 7), ','))))) then
    raise exception 'PAID_MOVE' using errcode = 'P0001';
  end if;
  _cancelling := coalesce(_p->>'status','') = 'cancelled'
                 and (_new_status = 'cancelled' or (q.status = 'cancelled' and coalesce(q.cancelled_by,'') = 'customer'));
  if q.status = 'waiting' and not _move and coalesce(_new_status, 'waiting') = 'waiting'
     and coalesce(q.type_preference, '') = 'Own' and _type is not null and _type <> 'Own'
     and not exists (select 1 from sessions s where s.id = q.session_id
                      and coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin')
     and not _session_has_room(q.session_id, _type, q.id) then
    return false;
  end if;
  /* A switch between two of our bikes needs a working bike of the new type, as a new booking, a promotion
     and a claim count them; only a switch from an own bike was checked (bug hunt 2026-11-11, sql03-3). */
  if q.status = 'waiting' and not _move and coalesce(_new_status, 'waiting') = 'waiting'
     and coalesce(q.type_preference, '') <> 'Own' and _type is not null and _type <> 'Own'
     and _type is distinct from q.type_preference
     and not _out_bikes_room(q.session_id, _type, q.id, true) then
    return false;
  end if;
  _to_own := q.status = 'waiting' and not _move and coalesce(_new_status, 'waiting') = 'waiting'
             and coalesce(q.type_preference, '') <> 'Own' and _type = 'Own';
  -- a waitlisted booking leaving its ride while it holds an open offer (sql05-4), read before it leaves
  _had_offer := coalesce(q.status = 'waitlist' and (_new_status = 'cancelled' or _move), false)
                and exists (select 1 from waitlist_offers o where o.booking_id = q.id and o.status = 'open');
  update queue_entries x set
    type_preference  = coalesce(_type, x.type_preference),
    size             = coalesce(_size, x.size),
    height           = coalesce(_h, x.height),
    name             = coalesce(_name, x.name),
    paid             = case when _unpay then false else x.paid end,
    status           = coalesce(_new_status, x.status),
    approval         = case when _reapprove then 'pending' else x.approval end,
    queue_num        = coalesce(_qnum, x.queue_num),
    promo_code       = coalesce(_code, x.promo_code),
    session_id       = case when _move then _to.id else x.session_id end,
    session_day      = case when _move then _to.day else x.session_day end,
    session_date     = case when _move then _to.session_date else x.session_date end,
    waitlist_num     = case when _move then null else x.waitlist_num end,
    rating_bike      = case when _p ? 'rating_bike' then _rb else x.rating_bike end,
    rating_exp       = case when _p ? 'rating_exp'  then _re else x.rating_exp end,
    rating_tags      = case when _p ? 'rating_tags' then _rt else x.rating_tags end,
    rating_detail    = case when _p ? 'rating_detail' then _rd else x.rating_detail end,
    feedback         = case when _p ? 'feedback'    then left(nullif(_p->>'feedback',''), 1000) else x.feedback end,
    addons           = case when _set_addons then _addons else x.addons end,
    assigned_bike_id = case when _new_status = 'cancelled' then null else x.assigned_bike_id end,
    cancelled_by     = case when _new_status = 'cancelled' then 'customer'
                            when x.status = 'cancelled' and _new_status in ('waiting','waitlist') then null
                            else x.cancelled_by end,
    cancel_reason    = case
                         when q.status = 'cancelled' and coalesce(q.cancelled_by,'') <> 'customer' then x.cancel_reason   -- staff's stays (20261005210000)
                         when _cancelling then case when (_p->>'cancel_reason') ~ '^[a-z_]{1,24}$' then _p->>'cancel_reason' else null end
                         when _p ? 'status' then null
                         else x.cancel_reason end,
    cancel_note      = case
                         when q.status = 'cancelled' and coalesce(q.cancelled_by,'') <> 'customer' then x.cancel_note
                         when _cancelling then left(nullif(btrim(coalesce(_p->>'cancel_note','')),''), 300)
                         when _p ? 'status' then null
                         else x.cancel_note end
  where x.id = q.id;
  if (q.status = 'waiting' and (_new_status = 'cancelled' or _move)) or _to_own then
    perform _promote_next_waitlist(q.session_id);
  end if;
  /* The place an open offer held comes back: the offer closes (a move onto another ride's waitlist left it open)
     and the place is offered to the next in line, as a Decline does. A cancel only closed it, and nothing offered
     the place again (claim mode; bug hunt 2026-11-18, sql05-4). */
  if _had_offer then
    update waitlist_offers set status = 'closed' where booking_id = q.id and status = 'open';
    perform _wl_offer_fill(q.session_id);
  end if;
  return true;
end $function$;
revoke all on function public.customer_booking_update(text,text,text,jsonb) from public;
grant execute on function public.customer_booking_update(text,text,text,jsonb) to anon, authenticated;


-- ── 6. the community form: another person's application stays theirs ──────────────────────────────
CREATE OR REPLACE FUNCTION public.customer_community_me(p_id text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare c customers%rowtype; a community_applications%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return null; end if;
  select * into c from customers where customers.id = p_id;
  if not found then return null; end if;
  select * into a from community_applications x
   where x.status = 'pending'
     -- another account's application stays its own, whatever number or email it shares (20261007120000)
     /* and so does one with no account: an email or a number this account shares (staff may put one number on
        several accounts, and an email is never proven) handed it that person's answers and the address of their
        status page. Only the account's own application fills the form; an older one with no account is linked
        when this account sends the form, by its email (customer_community_apply) (bug hunt 2026-11-18, sql06-3)
        (20261119000200). */
     and x.customer_id = p_id
   order by x.created_at desc limit 1;
  return jsonb_build_object(
    'name', c.name, 'email', c.email, 'phone', c.phone,
    'member', exists (select 1 from customer_tags ct
                       where ct.customer_id = p_id and ct.tag_id = 'tag_saturday'
                         and _ctag_active(ct.starts_at, ct.expires_at)),
    'pending', a.id is not null,
    'gender', c.gender, 'height', c.height,
    'birth_date', coalesce(nullif(a.birth_date,''), nullif(c.birth_date,'')),
    'nationality', coalesce(nullif(a.nationality,''), nullif(c.nationality,'')),
    'instagram', coalesce(nullif(a.instagram,''), nullif(c.socials->>'instagram','')),
    'linkedin', coalesce(nullif(a.linkedin,''), nullif(c.socials->>'linkedin','')),
    'profession', coalesce(nullif(a.profession,''), nullif(c.profession,'')),
    'workplace', coalesce(nullif(a.workplace,''), nullif(c.workplace,'')),
    'bike_type', coalesce(nullif(a.bike_type,''), case when c.type_preference in ('Road','Hybrid','Mountain','Own') then c.type_preference end),
    'heard_from', coalesce(a.heard_from, case when c.heard_from <> 'desk' then c.heard_from end),
    'own_bike', coalesce(a.own_bike, case when c.type_preference = 'Own' then true end),
    -- WhatsApp (20261007200000)
    'whatsapp_same', coalesce(a.whatsapp_same, c.whatsapp_same),
    'whatsapp', case when coalesce(a.whatsapp_same, c.whatsapp_same) = false then coalesce(a.whatsapp, c.whatsapp) end,
    -- the fields staff flagged on the account: asked again even when filled (20261025180000)
    'flags', to_jsonb(coalesce(c.fix_fields, '{}'::text[])),
    -- the waiting application's own address for the status page (20261025210000)
    'track', a.track_token);
end $function$;
revoke all on function public.customer_community_me(text, text) from public;
grant execute on function public.customer_community_me(text, text) to anon, authenticated;

do $do$
declare d text;
begin
  d := pg_get_functiondef('public.customer_community_apply(text,text,jsonb)'::regprocedure);
  if position('(20261119000200)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$   -- another account's application stays its own, whatever number or email it shares (20261005210200)
   where x.status = 'pending' and (x.customer_id = p_id or (x.customer_id is null and (lower(x.email) = v_email or x.phone = v_phone)))
   order by (x.customer_id = p_id) desc nulls last, (lower(x.email) = v_email) desc, x.created_at limit 1;$a$,
$b$   -- another account's application stays its own, whatever number or email it shares (20261005210200); one with
   -- no account is linked by its email only, never by a number staff may have put on several accounts (bug hunt
   -- 2026-11-18, sql06-3) (20261119000200)
   where x.status = 'pending' and (x.customer_id = p_id or (x.customer_id is null and lower(x.email) = v_email))
   order by (x.customer_id = p_id) desc nulls last, x.created_at limit 1;$b$);
  execute d;
end $do$;


-- ── 7. a birth date: a rider is 5 or older at every door ───────────────────────────────────────────
-- A real date (_ymd_ok) no later than today in Riyadh less five years: the boundary community_apply,
-- community_fix_submit, customer_community_apply and _learn_app_to_account keep (bug hunt 2026-11-18, sql07-5).
create or replace function public._dob_ok(v text)
 returns boolean
 language plpgsql
 stable
 set search_path to 'public'
as $function$
begin
  if not _ymd_ok(v) then return false; end if;
  return v::date <= ((now() at time zone 'Asia/Riyadh')::date - interval '5 years')::date;
exception when others then
  return false;
end $function$;
revoke all on function public._dob_ok(text) from public, anon, authenticated;

create or replace function public.customer_set_birth_nat(p_id text, p_token text, p_birth_date text, p_nationality text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  update customers
     set birth_date  = case when nullif(p_birth_date, '') is null then null
                            -- a rider is 5 or older, as every other door takes a birth date (bug hunt 2026-11-18,
                            -- sql07-5) (20261119000200)
                            when _dob_ok(p_birth_date) then p_birth_date
                            else birth_date end,
         nationality = left(p_nationality, 80)
   where id = p_id;
  return found;
end $function$;
revoke execute on function public.customer_set_birth_nat(text, text, text, text) from public;
grant  execute on function public.customer_set_birth_nat(text, text, text, text) to anon, authenticated;

do $do$
declare d text;
begin
  d := pg_get_functiondef('public.customer_update_profile(text,text,text,text,text,integer,text,text,text,text,text)'::regprocedure);
  if position('(20261119000200)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$    birth_date      = case when nullif(p_birth_date,'') is null then null when _ymd_ok(p_birth_date) then p_birth_date else c.birth_date end,$a$,
$b$    -- 5 or older, as every other door takes a birth date (bug hunt 2026-11-18, sql07-5) (20261119000200)
    birth_date      = case when nullif(p_birth_date,'') is null then null when _dob_ok(p_birth_date) then p_birth_date else c.birth_date end,$b$);
  execute d;
end $do$;


-- ── 7, 8. customer_fix_save: the same birth date rule and the same photo bucket ────────────────────
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.customer_fix_save(text,text,jsonb)'::regprocedure);
  if position('(20261119000200)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$        if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or not _ymd_ok(v) then continue; end if;$a$,
$b$        -- 5 or older, as every other door takes it (bug hunt 2026-11-18, sql07-5) (20261119000200)
        if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or not _dob_ok(v) then continue; end if;$b$);
  d := pg_temp._once(d,
$a$           or v !~ '^https://([a-z0-9]+\.supabase\.co/storage/v1/object/public/photos/|lh[0-9]+\.googleusercontent\.com/)' then continue; end if;$a$,
$b$           -- this project's own photos bucket, as customer_set_photo takes it (sql07-4)
           or v !~ '^https://(qpffkzmsfyilicwcsszz\.supabase\.co/storage/v1/object/public/photos/|lh[0-9]+\.googleusercontent\.com/)' then continue; end if;$b$);
  execute d;
end $do$;


-- ── 8. customer_set_photo: this project's photos bucket only ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.customer_set_photo(p_id text, p_token text, p_photo text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not _cust_token_ok(p_id,p_token) then return false; end if;
  -- A photo is a Storage (or provider) https link, or the small data URL the app falls back to.
  -- Anything else - a script URL, markup, a multi-megabyte blob - is refused. The https link is this
  -- project's photos bucket or the Google picture a sign-in brings: a link to any other host had every
  -- staff screen that shows the rider fetch it (bug hunt 2026-10-28). The bucket is this project's own, by its
  -- address: any project's photos bucket passed, a rider's own among them (bug hunt 2026-11-18, sql07-4)
  -- (20261119000200).
  if p_photo is not null
     and not ((length(p_photo) <= 2000 and p_photo ~ '^https://[^[:space:]"''<>`\\]+$'
               and p_photo ~ '^https://(qpffkzmsfyilicwcsszz\.supabase\.co/storage/v1/object/public/photos/|lh[0-9]+\.googleusercontent\.com/)')
              or (length(p_photo) <= 700000 and p_photo ~ '^data:image/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$')) then
    return false;
  end if;
  update customers set photo=p_photo where id=p_id;
  return true;
end $function$;


-- ── 9. the farm night: one staff marked Full is full on the page too ───────────────────────────────
create or replace function public.farm_night(p_code text, p_id text default null, p_token text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_code text := btrim(coalesce(p_code, ''));
  v_today text := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  v_mine boolean; v_canon text; v_out jsonb := '[]'::jsonb;
  v_s sessions%rowtype; v_slots jsonb; v_ends timestamptz; v_live int; v_state text; v_held jsonb;
begin
  if _farmcode_locked() then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if v_code = '' then return jsonb_build_object('ok', false, 'error', 'code'); end if;
  if v_code ~ '^[A-Za-z0-9_-]{1,40}$' then
    select c.code into v_canon from farm_codes c where lower(c.code) = lower(v_code) and c.active;
  end if;
  if v_canon is null then
    perform _ip_gate('farmcode', 30, interval '10 minutes');
    return jsonb_build_object('ok', false, 'error', 'code');
  end if;
  v_mine := p_id is not null and p_token is not null and _cust_token_ok(p_id, p_token);

  for v_s in
    select s.* from farm_codes c join sessions s on s.id = c.session_id
     where c.code = v_canon and c.active
       and coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'farm'
       and coalesce(s.status, '') in ('open', 'full', 'closed') and s.cancelled_at is null
       and coalesce(s.session_date, '') >= v_today
     order by s.session_date, s.id
  loop
    begin v_slots := coalesce(nullif(btrim(v_s.bike_slots), ''), '{}')::jsonb; exception when others then v_slots := '{}'::jsonb; end;
    if jsonb_typeof(v_slots) <> 'object' then v_slots := '{}'::jsonb; end if;
    begin select w.ends_at into v_ends from _session_window(v_s) w; exception when others then v_ends := null; end;
    if coalesce(v_slots->>'_fbk', '') not in ('', '0', 'false') or (v_ends is not null and v_ends <= now()) then
      v_state := 'over';
    else
      select count(*) into v_live from queue_entries q
       where q.session_id = v_s.id and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
      -- a night staff marked Full is full here too: farm_book takes no one on it (bug hunt 2026-11-18,
      -- form-farmhouse-0-1) (20261119000200)
      v_state := case when coalesce(v_s.status, '') = 'full'
                        or (v_s.capacity is not null and v_live >= v_s.capacity) then 'full' else 'open' end;
    end if;
    v_held := null;
    if v_mine then
      select coalesce(jsonb_agg(q.name order by q.queue_num), '[]'::jsonb) into v_held from queue_entries q
       where q.session_id = v_s.id and q.customer_id = p_id
         and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_s.id, 'date', v_s.session_date, 'day', v_s.day, 'title', v_s.title, 'title_ar', v_s.title_ar,
      'time', nullif(btrim(coalesce(v_slots->>'_time', '')), ''),
      'place', coalesce(nullif(btrim(coalesce(v_s.meet_name, '')), ''), nullif(btrim(coalesce(v_s.location, '')), '')),
      'place_ar', nullif(btrim(coalesce(v_s.meet_name_ar, '')), ''),
      'map', nullif(btrim(coalesce(v_s.meet_url, '')), ''),
      'ig', nullif(btrim(coalesce(v_slots->>'_ig', '')), ''),
      'state', v_state, 'max', 4, 'held', v_held));
  end loop;

  if jsonb_array_length(v_out) = 0 then return jsonb_build_object('ok', false, 'error', 'over'); end if;
  return jsonb_build_object('ok', true, 'code', v_canon, 'signed_in', v_mine, 'nights', v_out);
end $function$;
revoke all on function public.farm_night(text, text, text) from public;
grant execute on function public.farm_night(text, text, text) to anon, authenticated;

create or replace function public.farm_book(p_id text, p_token text, p_session text, p_code text,
                                            p_family jsonb default '[]'::jsonb, p_waiver text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_today text := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  v_cust customers%rowtype; v_s sessions%rowtype; v_slots jsonb; v_ends timestamptz; v_code text;
  v_fam text[] := '{}'::text[]; v_x jsonb; v_nm text; v_asks text[];
  v_held int; v_live int; v_new int; v_entries jsonb := '[]'::jsonb; v_err text; v_det text; v_people jsonb;
begin
  if not _rider_gate() or _farmcode_locked() then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  select * into v_cust from customers where id = p_id;

  -- The code, good on this night.
  if btrim(coalesce(p_code, '')) ~ '^[A-Za-z0-9_-]{1,40}$' then
    select c.code into v_code from farm_codes c
     where lower(c.code) = lower(btrim(p_code)) and c.active and c.session_id = coalesce(p_session, '');
  end if;
  if v_code is null then
    perform _ip_gate('farmcode', 30, interval '10 minutes');
    return jsonb_build_object('ok', false, 'error', 'code');
  end if;

  -- The night: a farm night ahead, open, full or closed, never called off or marked Full, no waitlist.
  select * into v_s from sessions s
   where s.id = p_session and coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'farm'
     and coalesce(s.status, '') in ('open', 'full', 'closed') and s.cancelled_at is null
     and coalesce(s.session_date, '') >= v_today;
  if v_s.id is null then return jsonb_build_object('ok', false, 'error', 'session'); end if;
  begin v_slots := coalesce(nullif(btrim(v_s.bike_slots), ''), '{}')::jsonb; exception when others then v_slots := '{}'::jsonb; end;
  if jsonb_typeof(v_slots) <> 'object' then v_slots := '{}'::jsonb; end if;
  if coalesce(v_slots->>'_fbk', '') not in ('', '0', 'false') then return jsonb_build_object('ok', false, 'error', 'session'); end if;
  begin select w.ends_at into v_ends from _session_window(v_s) w; exception when others then v_ends := null; end;
  if v_ends is not null and v_ends <= now() then return jsonb_build_object('ok', false, 'error', 'session'); end if;

  -- The farm night's own waiver, as it stands.
  if coalesce(p_waiver, '') !~ '^farm-[A-Za-z0-9._-]{1,35}$' or _waiver_outdated(p_waiver) then
    return jsonb_build_object('ok', false, 'error', 'waiver');
  end if;

  -- Up to three family members, each by a name the booking takes (letters and spaces, every part two letters or more).
  if p_family is null then p_family := '[]'::jsonb; end if;
  if jsonb_typeof(p_family) <> 'array' or jsonb_array_length(p_family) > 3 then
    return jsonb_build_object('ok', false, 'error', 'input');
  end if;
  for v_x in select * from jsonb_array_elements(p_family) loop
    if jsonb_typeof(v_x) <> 'string' then return jsonb_build_object('ok', false, 'error', 'input'); end if;
    v_nm := left(btrim(regexp_replace(v_x #>> '{}', '\s+', ' ', 'g')), 60);
    if v_nm = '' or not _name_chars_ok(v_nm) or not _name_parts_ok(v_nm) then
      return jsonb_build_object('ok', false, 'error', 'name', 'name', v_nm);
    end if;
    v_fam := v_fam || v_nm;
  end loop;

  -- What the account owes (an emergency contact, the nationality, a field staff flagged) is answered first.
  v_asks := coalesce(_customer_asks(p_id), '{}'::text[]);
  if cardinality(v_asks) > 0 then return jsonb_build_object('ok', false, 'error', 'fix', 'fields', to_jsonb(v_asks)); end if;

  -- The places, under the night's lock: four per account (the holder and three), the night's capacity in all.
  perform pg_advisory_xact_lock(hashtext('farmcap:' || v_s.id));
  select count(*) into v_held from queue_entries q
   where q.session_id = v_s.id and q.customer_id = p_id and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
  v_new := (case when v_held = 0 then 1 else 0 end) + cardinality(v_fam);
  if v_new = 0 then return jsonb_build_object('ok', false, 'error', 'nothing', 'held', v_held); end if;
  if v_held + v_new > 4 then return jsonb_build_object('ok', false, 'error', 'cap', 'held', v_held); end if;
  /* A night staff marked Full takes no one from this page: customer_create_booking puts every booking on such a
     night on its waitlist, and this page answered "Your request is in" for rows that were only waitlisted (bug hunt
     2026-11-18, sql07-2, form-farmhouse-0-1) (20261119000200). farm_night says 'full' for it. */
  if coalesce(v_s.status, '') = 'full' then return jsonb_build_object('ok', false, 'error', 'full'); end if;
  if v_s.capacity is not null then
    select count(*) into v_live from queue_entries q
     where q.session_id = v_s.id and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
    if v_live >= v_s.capacity then return jsonb_build_object('ok', false, 'error', 'full'); end if;
    if v_live + v_new > v_s.capacity then return jsonb_build_object('ok', false, 'error', 'room'); end if;
  end if;

  -- The rows: the account holder first when they hold no place there yet, then each family member, as the app books
  -- the night (no bike: type None; the farm waiver on every row).
  if v_held = 0 then
    v_entries := v_entries || jsonb_build_array(jsonb_build_object('session_id', v_s.id, 'name', coalesce(v_cust.name, ''),
                   'type_preference', 'None', 'waiver_version', p_waiver));
  end if;
  foreach v_nm in array v_fam loop
    v_entries := v_entries || jsonb_build_array(jsonb_build_object('session_id', v_s.id, 'name', v_nm,
                   'type_preference', 'None', 'waiver_version', p_waiver));
  end loop;

  begin
    perform set_config('mm.farmcode', v_s.id || '|' || v_code, true);
    perform 1 from customer_create_booking(p_id, p_token, v_entries);
    perform set_config('mm.farmcode', '', true);
  exception when others then
    get stacked diagnostics v_err = message_text, v_det = pg_exception_detail;
    perform set_config('mm.farmcode', '', true);
    if v_det = 'GROUP_CAP' then return jsonb_build_object('ok', false, 'error', 'cap', 'held', v_held); end if;
    if v_err = 'FIX_FIRST' then
      return jsonb_build_object('ok', false, 'error', 'fix', 'fields', to_jsonb(coalesce(_customer_asks(p_id), '{}'::text[])));
    end if;
    if v_err in ('STALE_SESSION', 'ACCOUNT_ARCHIVED') then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
    if v_err = 'SESSION_CLOSED' or v_err like 'NOT_OPEN_YET%' then return jsonb_build_object('ok', false, 'error', 'session'); end if;
    if v_err in ('WAIVER_REQUIRED', 'WAIVER_OUTDATED') then return jsonb_build_object('ok', false, 'error', 'waiver'); end if;
    if v_err = 'BAD_INPUT' and v_det = 'name' then return jsonb_build_object('ok', false, 'error', 'name'); end if;
    if v_err = 'RATE_LIMITED' then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
    raise;
  end;

  select coalesce(jsonb_agg(q.name order by q.queue_num), '[]'::jsonb) into v_people from queue_entries q
   where q.session_id = v_s.id and q.customer_id = p_id and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
  return jsonb_build_object('ok', true, 'added', v_new, 'people', v_people,
    'session', jsonb_build_object('id', v_s.id, 'date', v_s.session_date, 'title', v_s.title, 'title_ar', v_s.title_ar,
      'time', nullif(btrim(coalesce(v_slots->>'_time', '')), ''),
      'place', coalesce(nullif(btrim(coalesce(v_s.meet_name, '')), ''), nullif(btrim(coalesce(v_s.location, '')), '')),
      'place_ar', nullif(btrim(coalesce(v_s.meet_name_ar, '')), '')));
end $function$;
revoke all on function public.farm_book(text, text, text, text, jsonb, text) from public;
grant execute on function public.farm_book(text, text, text, text, jsonb, text) to anon, authenticated;


-- ── 10. hub_post_img: a hidden post's photo goes to no one ─────────────────────────────────────────
create or replace function public.hub_post_img(p_id text, p_token text, p_post text)
returns text
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) or not _member_active(p_id) then return null; end if;
  -- a post staff hid gives its photo to no one, as hub_feed shows it to no one (bug hunt 2026-11-18, sql07-3)
  -- (20261119000200)
  return (select p.img from hub_posts p
           where p.id = p_post and not coalesce(p.hidden, false)
             and _ksa_today() between p.shows_from and p.shows_until);
end $$;
revoke all on function public.hub_post_img(text, text, text) from public;
grant execute on function public.hub_post_img(text, text, text) to anon, authenticated;


-- ── 11. member_area: booked is a place held; the waitlist told apart ───────────────────────────────
create or replace function public.member_area(p_id text, p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  c customers%rowtype; v_since bigint; v_spend numeric; v_group int; v_rated int; v_rides int; v_credits int; v_tier int;
  v_pro numeric := _site_num('club.rules.proAt', 150); v_leg numeric := _site_num('club.rules.legendAt', 500);
  v_last jsonb; v_next jsonb; v_ann jsonb; v_today text := to_char((now() at time zone 'Asia/Riyadh')::date, 'YYYY-MM-DD');
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select * into c from customers where id = p_id;
  select ct.added_at into v_since from customer_tags ct
   where ct.customer_id = p_id and ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at) limit 1;
  if not found then return jsonb_build_object('ok', true, 'member', false, 'first_name', split_part(coalesce(c.name,''), ' ', 1)); end if;
  select coalesce(sum(q.price) filter (where q.status = 'done' and q.paid), 0),
         count(*) filter (where q.status = 'done' and s.event_kind = 'community'),
         count(*) filter (where q.status = 'done' and (q.rating_exp is not null or q.rating_bike is not null)),
         count(*) filter (where q.status = 'done')
    into v_spend, v_group, v_rated, v_rides
    from queue_entries q left join sessions s on s.id = q.session_id where q.customer_id = p_id;
  v_credits := floor(v_spend / 10 * _site_num('club.rules.perTen', 1))::int + (v_group * _site_num('club.rules.groupRidePts', 200))::int + (v_rated * _site_num('club.rules.reviewPts', 50))::int;
  v_tier := case when v_credits >= v_leg then 2 when v_credits >= v_pro then 1 else 0 end;
  select coalesce(jsonb_agg(x order by x->>'date' desc), '[]'::jsonb) into v_last from (
    select jsonb_build_object('date', q.session_date, 'title', coalesce(nullif(btrim(s.title), ''), ''), 'kind', s.ride_kind, 'rated', (q.rating_exp is not null or q.rating_bike is not null)) as x
      from queue_entries q left join sessions s on s.id = q.session_id
     where q.customer_id = p_id and q.status = 'done' order by q.session_date desc limit 5) t;
  select coalesce(jsonb_agg(x order by x->>'date', x->>'time'), '[]'::jsonb) into v_next from (
    select jsonb_build_object('id', s.id, 'date', s.session_date, 'title', coalesce(nullif(btrim(s.title), ''), ''), 'kind', s.ride_kind,
             'time', substring(coalesce(s.bike_slots, '') from '"_time"\s*:\s*"([^"]*)"'),
             -- a place held; a booking only on the waitlist is told apart, never with its place in the line, as the
             -- booking app tells them apart (bug hunt 2026-11-18, sql08-2) (20261119000200)
             'booked', exists (select 1 from queue_entries q where q.session_id = s.id and q.customer_id = p_id and q.status in ('waiting','active')),
             'waitlist', exists (select 1 from queue_entries q where q.session_id = s.id and q.customer_id = p_id and q.status = 'waitlist')
                         and not exists (select 1 from queue_entries q where q.session_id = s.id and q.customer_id = p_id and q.status in ('waiting','active'))) as x
      from sessions s
     where s.event_kind = 'community' and s.status in ('open','full') and coalesce(s.ride_kind, '') <> 'petromin'
       -- a private (tag-gated) ride only to an account holding its tag or a booking on it, as
       -- list_sessions shows them (20261007120000)
       and (s.required_tag_id is null
            or exists (select 1 from customer_tags ct
                        where ct.customer_id = p_id and ct.tag_id = s.required_tag_id
                          and _ctag_active(ct.starts_at, ct.expires_at))
            or exists (select 1 from queue_entries q2
                        where q2.session_id = s.id and q2.customer_id = p_id
                          and q2.status in ('waiting','waitlist','active','done')))
       and s.session_date >= v_today order by s.session_date limit 8) t;
  select value into v_ann from site_content where key = 'site.announce.messages';
  return jsonb_build_object('ok', true, 'member', true, 'first_name', split_part(coalesce(c.name,''), ' ', 1),
    'since', case when v_since is not null then to_timestamp(v_since / 1000.0) end,
    'credits', v_credits, 'tier', v_tier, 'next', case v_tier when 0 then v_pro when 1 then v_leg end,
    'rides', v_rides, 'group_rides', v_group, 'last', v_last, 'upcoming', v_next,
    'birth_date', c.birth_date, 'announcements', coalesce(v_ann, '[]'::jsonb));
end $function$;
revoke all on function public.member_area(text, text) from public;
grant execute on function public.member_area(text, text) to anon, authenticated;


-- ── checks ──────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array[
    'public.circuit_lap(text,text,text,boolean,text,integer)',
    'public.customer_booking_update(text,text,text,jsonb)',
    'public.customer_community_me(text,text)',
    'public.customer_community_apply(text,text,jsonb)',
    'public.customer_set_birth_nat(text,text,text,text)',
    'public.customer_update_profile(text,text,text,text,text,integer,text,text,text,text,text)',
    'public.customer_fix_save(text,text,jsonb)',
    'public.customer_set_photo(text,text,text)',
    'public.farm_night(text,text,text)',
    'public.farm_book(text,text,text,text,jsonb,text)',
    'public.hub_post_img(text,text,text)',
    'public.member_area(text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if position('(20261119000200)' in pg_get_functiondef(f::regprocedure)) = 0 then
      raise exception '% was not changed', f;
    end if;
    if not has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% lost a client grant', f;
    end if;
  end loop;
  -- sql07-1 is left as it is because 20261007120000's check is live: make sure it is
  if position('email_taken' in pg_get_functiondef('public.customer_update_profile(text,text,text,text,text,integer,text,text,text,text,text)'::regprocedure)) = 0 then
    raise exception 'customer_update_profile does not refuse an email another account has (the 20261007120000 patch is missing)';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public._dob_ok(text)'::regprocedure
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))
     or has_function_privilege('anon', 'public._dob_ok(text)', 'execute')
     or has_function_privilege('authenticated', 'public._dob_ok(text)', 'execute') then
    raise exception '_dob_ok has no search_path or is open to clients';
  end if;
  if public._dob_ok(to_char(((now() at time zone 'Asia/Riyadh')::date - interval '5 years' + interval '1 day')::date, 'YYYY-MM-DD'))
     or not public._dob_ok(to_char(((now() at time zone 'Asia/Riyadh')::date - interval '5 years')::date, 'YYYY-MM-DD'))
     or public._dob_ok('2020-02-31') or public._dob_ok(null) then
    raise exception '_dob_ok answers wrongly';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119000200', 'bh18_db2')
on conflict (version) do nothing;

commit;

-- Read-only check after applying (expect: 12, t, t, f, 1):
-- select (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
--           and position('(20261119000200)' in pg_get_functiondef(p.oid)) > 0) as changed_12,
--        position('email_taken' in pg_get_functiondef('public.customer_update_profile(text,text,text,text,text,integer,text,text,text,text,text)'::regprocedure)) > 0 as email_taken_kept,
--        position('lower(x.email) = v_email))' in pg_get_functiondef('public.customer_community_apply(text,text,jsonb)'::regprocedure)) > 0 as apply_email_only,
--        has_function_privilege('anon', 'public._dob_ok(text)', 'execute') as dob_helper_open,
--        (select count(*) from supabase_migrations.schema_migrations where version = '20261119000200') as ledger;
