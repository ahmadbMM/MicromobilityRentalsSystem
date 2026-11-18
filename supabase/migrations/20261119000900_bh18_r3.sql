-- ============================================================================
-- Bug hunt 2026-11-18, round 3 (the Community features round, now on main): the database halves. BOTH databases (staging,
-- then production). Needs 20261118210300 (member_interests), 20261118210800 (members book first) and 20261119000700
-- (r2b's staff_merge_customers / staff_unmerge_customers) first.
--
--  1. cf-rentals0-1  Members book first counted its hours from the moment the session opened for booking and never looked
--              at the site's booking window (site_content 'booking.window' = {days, at}, which _booking_window_guard
--              enforces: no rider, member or not, books before session_date - days at 'at', Riyadh). A session opened
--              before its window opened spent its members-only hours while nobody could book, and members and everyone
--              else then started together. _session_published now starts the hours at the later of now and the window's
--              opening for that date (none without a window, a malformed one, or for the races vlap/arena, as the guard
--              has it), and moves a window the app writes (a new session's, or one changed on an open session) that
--              starts before that opening to it. Without a booking.window row (production today) nothing changes.
--              The app does the same sum (_bwOpenMs in _mfPlan and the New session write); an older app's value is
--              corrected here. The website only shows public_at, so it follows.
--  2. cf-rentals1-2  staff_merge_customers did not move member_interests (one row per account): the keeper's Community
--              tab showed the interests chooser again, empty, and Ask pages and staff updates aimed at those interests
--              missed the member. The row now moves to a keeper that has none; when both have one, the keeper's list
--              takes the other's keys too (in _interest_keys() order; 'women' only when the keeper is, or becomes, a
--              female account), and the other row is deleted, kept whole in the merge record (moved.member_interests:
--              drop, keep_keys, keys). staff_unmerge_customers puts the keeper's list back (while it is still the one
--              the merge left) and restores the other row.
--
-- Copied from (newest text, only the named lines changed, headers kept): _session_published 20261118210800 (invoker,
-- set search_path = public, as before); staff_merge_customers and staff_unmerge_customers 20261119000700 (definer,
-- search_path public, grants as there). A pre-check stops the file when any of them is no longer that text (md5 of the
-- body) nor this file's.
--
-- Rollback: run the _session_published block of 20261118210800 and the staff_merge_customers / staff_unmerge_customers
-- blocks of 20261119000700 again. The interests a merge already joined stay on the keeper (the record keeps the other's).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- Every function rebuilt below must still be the text it was copied from (md5 of the body), or already this file's (a
-- re-run): else stop, rather than undo a change made since.
do $pre$
declare f record; m text;
begin
  if to_regclass('public.member_interests') is null then
    raise exception 'apply 20261118210300_member_interests first';
  end if;
  for f in select * from (values
    ('public._session_published()', '7aa374eb1ed4e21e4a6e5fd3610f117b', '321c20477cd052ad28282a21577c9c3f'),
    ('public.staff_merge_customers(text,text,text,text,text)', 'c4debc47c9ae92eca50a9546a5aef9e8', '32249d13681ed3ebfd59eef0c3e16fda'),
    ('public.staff_unmerge_customers(bigint)', '02acbe15c3d42864e5a5682b90e8ea7e', '88148659e320accefd0c4e81c5f6d65a')
  ) v(fn, was, now_) loop
    select md5(p.prosrc) into m from pg_proc p where p.oid = to_regprocedure(f.fn);
    if m is distinct from f.was and m is distinct from f.now_ then
      raise exception '% changed since this file was written (md5 %): rebuild it from the live definition', f.fn, m;
    end if;
  end loop;
end $pre$;

-- ── 1. cf-rentals0-1 the members' hours start when the booking window opens the date ──────────────────────────────
create or replace function public._session_published()
 returns trigger language plpgsql
 set search_path = public
as $function$
declare v_h integer; v_open timestamptz; w jsonb; v_days integer; v_at text;
begin
  if new.status in ('open', 'full') then
    -- Members book first (20261118210800): the hours staff chose (bike_slots._mfh) count from the moment the session
    -- opens for booking: its first opening (a draft, a timed one), or any opening while it has no window yet.
    -- And never from before the booking window (site_content 'booking.window') opens the date to riders (bug hunt
    -- 2026-11-18, cf-rentals0-1) (20261119000900): the hours ran out while nobody could book. A window the app writes
    -- (on a new session, or changed on one) that starts before that opening is moved to it.
    if tg_op = 'INSERT' or coalesce(old.status, '') not in ('open', 'full') or new.public_at is distinct from old.public_at then
      begin
        v_h := substring(coalesce(new.bike_slots::text, '') from '"_mfh"\s*:\s*"?([0-9]{1,2})\M')::integer;
      exception when others then v_h := null;
      end;
      if v_h in (3, 6, 12, 24, 48) then
        -- the booking window's opening for this date, as _booking_window_guard reads it: session_date - days, at 'at'
        -- (from midnight when none) in Riyadh; none without a window, and none for the races (vlap, arena)
        if coalesce(new.ride_kind, '') not in ('vlap', 'arena') then
          select value into w from site_content where key = 'booking.window';
          if w is not null and jsonb_typeof(w) = 'object' and (w->>'days') ~ '^\d{1,4}$' then
            v_days := (w->>'days')::integer;
            v_at := case when (w->>'at') ~ '^\d{2}:\d{2}$' then w->>'at' else '00:00' end;
            begin
              v_open := ((left(new.session_date::text, 10)::date - v_days)::text || ' ' || v_at)::timestamp at time zone 'Asia/Riyadh';
            exception when others then v_open := null;
            end;
          end if;
        end if;
        if (tg_op = 'INSERT' or coalesce(old.status, '') not in ('open', 'full'))
           and (new.public_at is null
                or (tg_op = 'UPDATE' and (coalesce(old.draft, false) or old.opens_at is not null))) then
          new.public_at := greatest(now(), v_open) + make_interval(hours => v_h);
        elsif new.public_at is not null and v_open is not null and new.public_at < v_open + make_interval(hours => v_h) then
          new.public_at := v_open + make_interval(hours => v_h);
        end if;
      end if;
    end if;
    new.draft := false;
    new.opens_at := null;
  end if;
  return new;
end $function$;
revoke execute on function public._session_published() from public, anon, authenticated;

-- ── 2. cf-rentals1-2 a merge moves the member's interests, and an unmerge moves them back ────────────────────────────
CREATE OR REPLACE FUNCTION public.staff_merge_customers(p_keep text, p_drop text, p_by text DEFAULT NULL::text, p_op text DEFAULT NULL::text, p_approval text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  k customers%rowtype; d customers%rowtype;
  mv jsonb := '{}'::jsonb; fl text[] := '{}'; ids text[]; m_id bigint;
  tags_moved text[] := '{}'; tags_dup jsonb := '[]'::jsonb; ct customer_tags%rowtype;
  bd customer_badges%rowtype; bdg_moved text[] := '{}'; bdg_dup jsonb := '[]'::jsonb;
  kf customer_flags%rowtype; df customer_flags%rowtype;
  ki member_interests%rowtype; di member_interests%rowtype; v_fem boolean; v_keys text[];
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  -- The operator's PIN approval (staff_pin_approve), 2026-10-04.
  if not _pin_ok_strict(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if p_keep is null or p_drop is null or p_keep = p_drop then raise exception 'SAME_ACCOUNT' using errcode = '22023'; end if;
  -- both rows locked, lower id first, so two admins merging the same pair cannot cross
  if p_keep < p_drop then
    select * into k from customers where id = p_keep for update;
    select * into d from customers where id = p_drop for update;
  else
    select * into d from customers where id = p_drop for update;
    select * into k from customers where id = p_keep for update;
  end if;
  if k.id is null then raise exception 'NOT_FOUND: keep' using errcode = 'P0002'; end if;
  if d.id is null then raise exception 'NOT_FOUND: drop' using errcode = 'P0002'; end if;
  if k.merged_into is not null or d.merged_into is not null then raise exception 'ALREADY_MERGED' using errcode = '22023'; end if;
  -- an archived account is never joined to another (the user, 2026-11-11; 20261111200000)
  if k.archived_at is not null or d.archived_at is not null then raise exception 'ARCHIVED' using errcode = '22023'; end if;

  with u as (update queue_entries set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('queue_entries', to_jsonb(ids));
  with u as (update cashier_sales set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('cashier_sales', to_jsonb(ids));
  with u as (update customer_notes set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('customer_notes', to_jsonb(ids));
  -- Both accounts may have a correction flag open (one pending per account,
  -- customer_flags_one_pending): the dropped one's fields join the keeper's flag and it is
  -- withdrawn before it moves; unmerge puts both back (20261005210100).
  select * into kf from customer_flags where customer_id = p_keep and status = 'pending' for update;
  select * into df from customer_flags where customer_id = p_drop and status = 'pending' for update;
  if kf.id is not null and df.id is not null then
    update customer_flags
       set fields = kf.fields || array(select f from unnest(df.fields) f where f <> all(kf.fields))
     where id = kf.id;
    update customer_flags set status = 'withdrawn', answered_at = now() where id = df.id;
    mv := mv || jsonb_build_object('flag_fold',
            jsonb_build_object('keep', kf.id, 'drop', df.id, 'keep_fields', to_jsonb(kf.fields)));
  end if;
  with u as (update customer_flags set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('customer_flags', to_jsonb(ids));
  with u as (update push_subscriptions set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('push_subscriptions', to_jsonb(ids));
  with u as (update rider_registrations set matched_customer_id = p_keep where matched_customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('rider_registrations', to_jsonb(ids));
  with u as (update ambassadors set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('ambassadors', to_jsonb(ids));
  with u as (update community_applications set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('community_applications', to_jsonb(ids));
  with u as (update learn_applications set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('learn_applications', to_jsonb(ids));
  with u as (update workshop_jobs set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('workshop_jobs', to_jsonb(ids));
  with u as (update site_messages set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('site_messages', to_jsonb(ids));
  with u as (update promo_codes set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('promo_codes', to_jsonb(ids));
  -- One live award per person per session: the keeper's stands, the other waits voided for an unmerge.
  with u as (update volunteer_hours dup set voided_at = now(), voided_by = 'merge'
              where dup.customer_id = p_drop and dup.source = 'session' and dup.voided_at is null
                and exists (select 1 from volunteer_hours kept where kept.customer_id = p_keep and kept.session_id = dup.session_id
                             and kept.source = 'session' and kept.voided_at is null) returning dup.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_hours_void', to_jsonb(ids));
  with u as (update volunteer_hours set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_hours', to_jsonb(ids));
  with u as (update volunteer_shifts h set customer_id = p_keep where h.customer_id = p_drop
              and not exists (select 1 from volunteer_shifts x where x.customer_id = p_keep and x.session_id = h.session_id) returning h.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_shifts', to_jsonb(ids));
  update volunteer_log set customer_id = p_keep where customer_id = p_drop;
  if not exists (select 1 from volunteers where customer_id = p_keep)
     and exists (select 1 from volunteers where customer_id = p_drop) then
    update volunteers set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('volunteer', true);
  end if;
  /* What else names the account (bh11 sql07-2): its lockers (a Lockers-page rental has no booking to follow, so the
     keeper's My lockers never showed it), its volunteer certificates, portal Updates and the feedback on the shifts
     that moved. A certificate or Update the keeper already has for the same session stays where it is, as a shift
     does; unmerge moves back what moved. */
  with u as (update locker_rentals set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('locker_rentals', to_jsonb(ids));
  with u as (update volunteer_certs c set customer_id = p_keep where c.customer_id = p_drop
              and not (c.kind = 'session' and c.revoked_at is null
                       and exists (select 1 from volunteer_certs x where x.customer_id = p_keep and x.session_id = c.session_id
                                    and x.kind = 'session' and x.revoked_at is null)) returning c.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_certs', to_jsonb(ids));
  with u as (update volunteer_updates w set customer_id = p_keep where w.customer_id = p_drop
              and not exists (select 1 from volunteer_updates x where x.customer_id = p_keep
                               and coalesce(x.session_id, '') = coalesce(w.session_id, '') and x.kind = w.kind) returning w.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_updates', to_jsonb(ids));
  with u as (update volunteer_feedback f set customer_id = p_keep where f.customer_id = p_drop
              and exists (select 1 from volunteer_shifts h where h.id = f.shift_id and h.customer_id = p_keep) returning f.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_feedback', to_jsonb(ids));
  /* The mentorship records (bh18 sql10-6) (20261119000300): the member-side pages read them by the account signed in,
     so on the keeper the student's mentee profile and match, or the mentor's card and offers, were gone and they could
     register again. The profiles, the mentor card, the offers made as a mentor and the check-ins move. A live profile
     (pending, open, matched) moves only while the keeper has none, a mentor card only when the keeper has none, and
     an offer only when the keeper has no live one on the same profile (one each, as the tables keep it); what stays
     is still seen by staff on the merged account. Unmerge moves back what moved. */
  with u as (update mentor_profiles p set customer_id = p_keep where p.customer_id = p_drop
              and not (p.status in ('pending', 'open', 'matched')
                       and exists (select 1 from mentor_profiles x where x.customer_id = p_keep
                                    and x.status in ('pending', 'open', 'matched'))) returning p.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('mentor_profiles', to_jsonb(ids));
  with u as (update mentor_offers o set mentor_id = p_keep where o.mentor_id = p_drop
              and not (o.status in ('offered', 'proposed', 'matched')
                       and exists (select 1 from mentor_offers x where x.mentor_id = p_keep and x.profile_id = o.profile_id
                                    and x.status in ('offered', 'proposed', 'matched'))) returning o.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('mentor_offers', to_jsonb(ids));
  with u as (update mentor_checks set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('mentor_checks', to_jsonb(ids));
  if not exists (select 1 from mentor_mentors where customer_id = p_keep)
     and exists (select 1 from mentor_mentors where customer_id = p_drop) then
    update mentor_mentors set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('mentor_mentor', true);
  end if;
  delete from customer_handoffs where customer_id = p_drop; -- two-minute sign-in codes: nothing to keep

  -- tags: a tag the keeper holds already is dropped, the others move (the primary key is (customer, tag))
  /* A dropped one is kept whole in the record, as a badge is, so unmerge gives it back with its window and who
     gave it when, not as a grant with no end (bh10). */
  for ct in select * from customer_tags where customer_id = p_drop loop
    if exists (select 1 from customer_tags where customer_id = p_keep and tag_id = ct.tag_id) then
      delete from customer_tags where customer_id = p_drop and tag_id = ct.tag_id;
      tags_dup := tags_dup || jsonb_build_array(to_jsonb(ct));
    else
      update customer_tags set customer_id = p_keep where customer_id = p_drop and tag_id = ct.tag_id;
      tags_moved := tags_moved || ct.tag_id;
    end if;
  end loop;
  mv := mv || jsonb_build_object('tags_moved', to_jsonb(tags_moved), 'tags_dup', tags_dup);

  -- badges, the same way; a badge the keeper holds already is kept whole in the record for unmerge
  for bd in select * from customer_badges where customer_id = p_drop loop
    if exists (select 1 from customer_badges where customer_id = p_keep and badge_id = bd.badge_id) then
      delete from customer_badges where customer_id = p_drop and badge_id = bd.badge_id;
      bdg_dup := bdg_dup || jsonb_build_array(to_jsonb(bd));
    else
      update customer_badges set customer_id = p_keep where customer_id = p_drop and badge_id = bd.badge_id;
      bdg_moved := array_append(bdg_moved, bd.badge_id);
    end if;
  end loop;
  mv := mv || jsonb_build_object('badges_moved', to_jsonb(bdg_moved), 'badges_dup', bdg_dup);

  -- one-row-per-account records: moved only when the keeper has none
  if not exists (select 1 from customer_ig_followers where customer_id = p_keep)
     and exists (select 1 from customer_ig_followers where customer_id = p_drop) then
    update customer_ig_followers set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('ig_followers', true);
  end if;
  if not exists (select 1 from customer_owner_pwd where customer_id = p_keep)
     and exists (select 1 from customer_owner_pwd where customer_id = p_drop) then
    update customer_owner_pwd set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('owner_pwd', true);
  end if;
  /* The interests a member picked (bug hunt 2026-11-18, cf-rentals1-2) (20261119000900): the Community tab, Ask pages and
     staff updates read them by the account signed in, so on the keeper the chooser came back empty. They move when the
     keeper has none; when both have some, the keeper's list takes the other's too, in the list's order, and the other
     row goes, kept whole in the record. 'women' comes over only to a female account (its own gender, or the one it takes
     from the other below), as member_interests_set has it. Unmerge puts both back. */
  select * into di from member_interests where customer_id = p_drop for update;
  if di.customer_id is not null then
    select * into ki from member_interests where customer_id = p_keep for update;
    v_fem := coalesce(nullif(k.gender, ''), d.gender) = 'female';
    v_keys := array(select x.k from unnest(_interest_keys()) with ordinality x(k, n)
                     where x.k = any(coalesce(ki.keys, '{}'::text[])) or (x.k = any(di.keys) and (x.k <> 'women' or v_fem))
                     order by x.n);
    if ki.customer_id is null then
      update member_interests set customer_id = p_keep, keys = v_keys where customer_id = p_drop;
    else
      update member_interests set keys = v_keys where customer_id = p_keep;
      delete from member_interests where customer_id = p_drop;
    end if;
    mv := mv || jsonb_build_object('member_interests', jsonb_build_object(
            'drop', to_jsonb(di), 'keep_keys', case when ki.customer_id is null then null else to_jsonb(ki.keys) end,
            'keys', to_jsonb(v_keys)));
  end if;
  /* The staff-side links (bug hunt 2026-11-18, ppl-rentals0-1) (20261119000700): the account's owner and its family link
     go to the keeper when it has none (one row per account), and its follow-ups go with it, so the keeper's window shows
     them and a family's list never names the merged-away account. A family link of the dropped account while the
     keeper has one of its own is kept whole in the record and taken off (unmerge puts it back). The stamp triggers keep
     who made each row while mm.merge says this is a merge. */
  perform set_config('mm.merge', '1', true);
  if not exists (select 1 from account_owners where customer_id = p_keep)
     and exists (select 1 from account_owners where customer_id = p_drop) then
    update account_owners set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('account_owner', true);
  end if;
  if exists (select 1 from account_family where customer_id = p_drop) then
    if not exists (select 1 from account_family where customer_id = p_keep) then
      update account_family set customer_id = p_keep where customer_id = p_drop;
      mv := mv || jsonb_build_object('account_family', true);
    else
      mv := mv || jsonb_build_object('account_family_dup', (select to_jsonb(f) from account_family f where f.customer_id = p_drop));
      delete from account_family where customer_id = p_drop;
    end if;
  end if;
  with u as (update account_followups set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('account_followups', to_jsonb(ids));
  perform set_config('mm.merge', '', true);

  -- what the keeper lacked, from the other
  if coalesce(k.height, 0) = 0 and coalesce(d.height, 0) > 0 then update customers set height = d.height where id = p_keep; fl := array_append(fl, 'height'); end if;
  if coalesce(k.gender, '') = '' and coalesce(d.gender, '') <> '' then update customers set gender = d.gender where id = p_keep; fl := array_append(fl, 'gender'); end if;
  if coalesce(k.birth_date, '') = '' and coalesce(d.birth_date, '') <> '' then update customers set birth_date = d.birth_date where id = p_keep; fl := array_append(fl, 'birth_date'); end if;
  if coalesce(k.country, '') = '' and coalesce(d.country, '') <> '' then update customers set country = d.country where id = p_keep; fl := array_append(fl, 'country'); end if;
  if coalesce(k.city, '') = '' and coalesce(d.city, '') <> '' then update customers set city = d.city where id = p_keep; fl := array_append(fl, 'city'); end if;
  if coalesce(k.nationality, '') = '' and coalesce(d.nationality, '') <> '' then update customers set nationality = d.nationality where id = p_keep; fl := array_append(fl, 'nationality'); end if;
  if coalesce(k.type_preference, '') = '' and coalesce(d.type_preference, '') <> '' then update customers set type_preference = d.type_preference where id = p_keep; fl := array_append(fl, 'type_preference'); end if;
  if coalesce(k.photo, '') = '' and coalesce(d.photo, '') <> '' then update customers set photo = d.photo where id = p_keep; fl := array_append(fl, 'photo'); end if;
  if coalesce(k.profession, '') = '' and coalesce(d.profession, '') <> '' then update customers set profession = d.profession where id = p_keep; fl := array_append(fl, 'profession'); end if;
  if coalesce(k.workplace, '') = '' and coalesce(d.workplace, '') <> '' then update customers set workplace = d.workplace where id = p_keep; fl := array_append(fl, 'workplace'); end if;
  if coalesce(k.heard_from, '') = '' and coalesce(d.heard_from, '') <> '' then update customers set heard_from = d.heard_from where id = p_keep; fl := array_append(fl, 'heard_from'); end if;
  if k.socials is null and d.socials is not null then update customers set socials = d.socials where id = p_keep; fl := array_append(fl, 'socials'); end if;

  update customers set merged_into = p_keep, session_token = null where id = p_drop;

  insert into customer_merges (keep_id, drop_id, keep_name, drop_name, moved, filled, merged_by)
    values (p_keep, p_drop, k.name, d.name, mv, to_jsonb(fl), p_by) returning id into m_id;
  return jsonb_build_object('ok', true, 'id', m_id, 'moved', mv, 'filled', to_jsonb(fl), 'keep_name', k.name, 'drop_name', d.name);
end $function$;
revoke all on function public.staff_merge_customers(text, text, text, text, text) from public, anon;
grant execute on function public.staff_merge_customers(text, text, text, text, text) to authenticated;

CREATE OR REPLACE FUNCTION public.staff_unmerge_customers(p_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  m customer_merges%rowtype; ids text[]; col text; tg text; bj jsonb;
  cols text[] := array['height','gender','birth_date','country','city','nationality','type_preference','photo','profession','workplace','heard_from','socials'];
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  select * into m from customer_merges where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if m.undone_at is not null then raise exception 'ALREADY_UNDONE' using errcode = '22023'; end if;
  if m.merged_at < now() - interval '30 days' then raise exception 'TOO_LATE' using errcode = '22023'; end if;
  perform 1 from customers where id in (m.keep_id, m.drop_id) order by id for update;
  -- Either account deleted since: nothing to give back to (it failed on a foreign key half way; bh14).
  if (select count(*) from customers where id in (m.keep_id, m.drop_id)) < 2 then
    raise exception 'NOT_FOUND: account' using errcode = 'P0002';
  end if;
  -- Either account archived since: restore it first (20261111200000).
  if exists (select 1 from customers where id in (m.keep_id, m.drop_id) and archived_at is not null) then
    raise exception 'ARCHIVED' using errcode = '22023';
  end if;
  -- The keeper was merged into a third account since: that merge is undone first (20261005210100).
  if exists (select 1 from customers where id = m.keep_id and merged_into is not null) then
    raise exception 'KEEPER_MERGED' using errcode = '22023';
  end if;

  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'queue_entries', '[]')) x;
  update queue_entries set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'cashier_sales', '[]')) x;
  update cashier_sales set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'customer_notes', '[]')) x;
  update customer_notes set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'customer_flags', '[]')) x;
  update customer_flags set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  -- Two open flags were folded at the merge: the keeper's gets its own fields back, the other
  -- is open again on its own account (20261005210100).
  if m.moved ? 'flag_fold' then
    update customer_flags
       set fields = array(select x from jsonb_array_elements_text(m.moved->'flag_fold'->'keep_fields') with ordinality t(x, o) order by o)
     where id = (m.moved->'flag_fold'->>'keep')::uuid and status = 'pending';
    update customer_flags set status = 'pending', answered_at = null
     where id = (m.moved->'flag_fold'->>'drop')::uuid and customer_id = m.drop_id and status = 'withdrawn'
       and not exists (select 1 from customer_flags x where x.customer_id = m.drop_id and x.status = 'pending');
  end if;
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'push_subscriptions', '[]')) x;
  update push_subscriptions set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'rider_registrations', '[]')) x;
  update rider_registrations set matched_customer_id = m.drop_id where matched_customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'ambassadors', '[]')) x;
  update ambassadors set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'community_applications', '[]')) x;
  update community_applications set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'learn_applications', '[]')) x;
  update learn_applications set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'workshop_jobs', '[]')) x;
  update workshop_jobs set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'site_messages', '[]')) x;
  update site_messages set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'promo_codes', '[]')) x;
  update promo_codes set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);

  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_hours', '[]')) x;
  update volunteer_hours set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_hours_void', '[]')) x;
  update volunteer_hours set voided_at = null, voided_by = null where id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_shifts', '[]')) x;
  update volunteer_shifts set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  if coalesce((m.moved->>'volunteer')::boolean, false)
     and not exists (select 1 from volunteers where customer_id = m.drop_id) then
    update volunteers set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;
  /* lockers, certificates, portal Updates and feedback the merge moved (bh11 sql07-2) */
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'locker_rentals', '[]')) x;
  update locker_rentals set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_certs', '[]')) x;
  update volunteer_certs c set customer_id = m.drop_id where c.customer_id = m.keep_id and c.id::text = any(ids)
    and not (c.kind = 'session' and c.revoked_at is null
             and exists (select 1 from volunteer_certs y where y.customer_id = m.drop_id and y.session_id = c.session_id
                          and y.kind = 'session' and y.revoked_at is null));
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_updates', '[]')) x;
  update volunteer_updates w set customer_id = m.drop_id where w.customer_id = m.keep_id and w.id::text = any(ids)
    and not exists (select 1 from volunteer_updates y where y.customer_id = m.drop_id
                     and coalesce(y.session_id, '') = coalesce(w.session_id, '') and y.kind = w.kind);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_feedback', '[]')) x;
  update volunteer_feedback set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  /* the mentorship records the merge moved (bh18 sql10-6) (20261119000300); a live one only while the account it goes
     back to has none */
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'mentor_profiles', '[]')) x;
  update mentor_profiles p set customer_id = m.drop_id where p.customer_id = m.keep_id and p.id::text = any(ids)
    and not (p.status in ('pending', 'open', 'matched')
             and exists (select 1 from mentor_profiles y where y.customer_id = m.drop_id and y.status in ('pending', 'open', 'matched')));
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'mentor_offers', '[]')) x;
  update mentor_offers o set mentor_id = m.drop_id where o.mentor_id = m.keep_id and o.id::text = any(ids)
    and not (o.status in ('offered', 'proposed', 'matched')
             and exists (select 1 from mentor_offers y where y.mentor_id = m.drop_id and y.profile_id = o.profile_id
                          and y.status in ('offered', 'proposed', 'matched')));
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'mentor_checks', '[]')) x;
  update mentor_checks set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  if coalesce((m.moved->>'mentor_mentor')::boolean, false)
     and not exists (select 1 from mentor_mentors where customer_id = m.drop_id) then
    update mentor_mentors set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;

  for tg in select x from jsonb_array_elements_text(coalesce(m.moved->'tags_moved', '[]')) x loop
    update customer_tags set customer_id = m.drop_id where customer_id = m.keep_id and tag_id = tg
      and not exists (select 1 from customer_tags where customer_id = m.drop_id and tag_id = tg);
  end loop;
  /* The dropped account's own copy of a tag both held comes back as it was: its window, who gave it and when
     (bh10; zz_sync_touch stamps updated_at, so the staff pages see it). A record from before kept the tag's id
     alone, and that comes back as before. */
  for bj in select x from jsonb_array_elements(coalesce(m.moved->'tags_dup', '[]')) x loop
    if jsonb_typeof(bj) = 'object' then
      insert into customer_tags select (jsonb_populate_record(null::customer_tags, bj || jsonb_build_object('customer_id', m.drop_id))).*
        on conflict do nothing;
    elsif jsonb_typeof(bj) = 'string' then
      insert into customer_tags (customer_id, tag_id, added_by, added_at)
        values (m.drop_id, bj #>> '{}', 'unmerge', (extract(epoch from now()) * 1000)::bigint)
        on conflict do nothing;
    end if;
  end loop;

  for tg in select x from jsonb_array_elements_text(coalesce(m.moved->'badges_moved', '[]')) x loop
    update customer_badges set customer_id = m.drop_id where customer_id = m.keep_id and badge_id = tg
      and not exists (select 1 from customer_badges where customer_id = m.drop_id and badge_id = tg);
  end loop;
  for bj in select x from jsonb_array_elements(coalesce(m.moved->'badges_dup', '[]')) x loop
    insert into customer_badges select (jsonb_populate_record(null::customer_badges, bj || jsonb_build_object('customer_id', m.drop_id))).*
      on conflict do nothing;
  end loop;
  if coalesce((m.moved->>'ig_followers')::boolean, false)
     and not exists (select 1 from customer_ig_followers where customer_id = m.drop_id) then
    update customer_ig_followers set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;
  if coalesce((m.moved->>'owner_pwd')::boolean, false)
     and not exists (select 1 from customer_owner_pwd where customer_id = m.drop_id) then
    update customer_owner_pwd set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;
  /* the interests the merge moved or joined (bug hunt 2026-11-18, cf-rentals1-2) (20261119000900): while the keeper's
     list is still the one the merge left, it goes back to what it was (none, or its own list); one the member saved
     since stays. The other account's row comes back whole. */
  if jsonb_typeof(m.moved->'member_interests') = 'object' then
    if exists (select 1 from member_interests where customer_id = m.keep_id
                and to_jsonb(keys) = m.moved->'member_interests'->'keys') then
      if jsonb_typeof(m.moved->'member_interests'->'keep_keys') = 'array' then
        update member_interests
           set keys = array(select x from jsonb_array_elements_text(m.moved->'member_interests'->'keep_keys') with ordinality t(x, o) order by o)
         where customer_id = m.keep_id;
      else
        delete from member_interests where customer_id = m.keep_id;
      end if;
    end if;
    if jsonb_typeof(m.moved->'member_interests'->'drop') = 'object' then
      insert into member_interests
        select (jsonb_populate_record(null::member_interests, (m.moved->'member_interests'->'drop') || jsonb_build_object('customer_id', m.drop_id))).*
        on conflict (customer_id) do nothing;
    end if;
  end if;
  /* the owner, the family link and the follow-ups the merge moved (bug hunt 2026-11-18, ppl-rentals0-1) (20261119000700) */
  perform set_config('mm.merge', '1', true);
  if coalesce((m.moved->>'account_owner')::boolean, false)
     and not exists (select 1 from account_owners where customer_id = m.drop_id) then
    update account_owners set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;
  if coalesce((m.moved->>'account_family')::boolean, false)
     and not exists (select 1 from account_family where customer_id = m.drop_id) then
    update account_family set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;
  if jsonb_typeof(m.moved->'account_family_dup') = 'object'
     and not exists (select 1 from account_family where customer_id = m.drop_id) then
    insert into account_family select (jsonb_populate_record(null::account_family, (m.moved->'account_family_dup') || jsonb_build_object('customer_id', m.drop_id))).*
      on conflict do nothing;
  end if;
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'account_followups', '[]')) x;
  update account_followups set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  perform set_config('mm.merge', '', true);

  for col in select x from jsonb_array_elements_text(coalesce(m.filled, '[]')) x loop
    -- only while the keeper still holds the value it was given: one it set since is its own (20261007120100)
    if col = any(cols) then
      execute format('update customers k set %I = null from customers d where k.id = $1 and d.id = $2 and k.%I is not distinct from d.%I',
                     col, col, col)
        using m.keep_id, m.drop_id;
    end if;
  end loop;

  update customers set merged_into = null where id = m.drop_id and merged_into = m.keep_id;
  update customer_merges set undone_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'keep_name', m.keep_name, 'drop_name', m.drop_name);
end $function$;
revoke all on function public.staff_unmerge_customers(bigint) from public, anon;
grant execute on function public.staff_unmerge_customers(bigint) to authenticated;

-- ── Checks ─────────────────────────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public.staff_merge_customers(text,text,text,text,text)', 'public.staff_unmerge_customers(bigint)'] loop
    if not exists (select 1 from pg_proc p where p.oid = to_regprocedure(f) and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
    if position('(20261119000900)' in pg_get_functiondef(to_regprocedure(f))) = 0 then
      raise exception '% does not carry this file''s change', f;
    end if;
    if has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% grants are wrong', f;
    end if;
  end loop;
  -- _session_published stays an invoker trigger with its search_path, as 20261107110000 made it
  if not exists (select 1 from pg_proc p where p.oid = 'public._session_published()'::regprocedure and not p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
                   and position('(20261119000900)' in p.prosrc) > 0) then
    raise exception '_session_published is missing, became a definer, lost its search_path or lacks this change';
  end if;
  if has_function_privilege('anon', 'public._session_published()', 'execute')
     or has_function_privilege('authenticated', 'public._session_published()', 'execute') then
    raise exception '_session_published can be run by a client';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'sessions_published' and tgrelid = 'public.sessions'::regclass) then
    raise exception 'the sessions_published trigger is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119000900', 'bh18_r3')
on conflict (version) do nothing;

commit;

-- check (read only): each function carries this file's change and kept its attributes; the merges that moved interests.
-- select p.proname, p.prosecdef, p.proconfig, md5(p.prosrc) as md5, position('(20261119000900)' in p.prosrc) > 0 as r3,
--        has_function_privilege('anon', p.oid, 'execute') as anon
--   from pg_proc p
--  where p.oid in ('public._session_published()'::regprocedure,
--                  'public.staff_merge_customers(text,text,text,text,text)'::regprocedure,
--                  'public.staff_unmerge_customers(bigint)'::regprocedure)
-- union all
-- select 'merges with interests', null, null, count(*)::text, null, null from public.customer_merges where moved ? 'member_interests';
