-- Going and first-timer counts on the Community tab's next-session card (new features build F19; the owner marked it
-- Build now on 2026-11-13).
--
-- The card says "34 going" and "12 first-timers" for the session it shows. Each number only at 10 or more; under 10 that
-- number is absent. Totals only: no name, no list, nothing about any one rider (members see nobody, 2026-11-04). The
-- owner refused any count on the Experiences card and the Reserve screens, so nothing else reads these numbers.
--
--  1. _hub_going(): one object keyed by session id, {"<session id>": {"n": 34, "first": 12}}, for every community
--     session that is
--       published          hide_queue is false: staff pressed Publish on a ride they approve (the Saturday Social Ride,
--                          the pool session, a workshop), or the session was made with its list open (a paid community
--                          ride). The app's own meaning of published (_commPublished). A session whose list stays
--                          hidden (an event, a run, yoga, a race) answers nothing.
--       open for booking   status 'open', not cancelled, dated today or later in Riyadh, and inside the booking window
--                          (site_content 'booking.window', read as _booking_window_guard reads it; the races are booked
--                          from the day they are announced, as there).
--     n      bookings holding a place (waiting, checked in or finished; never waitlisted, cancelled, removed or a
--            no-show): approved ones where the session needs approval, every one not turned down where it does not.
--     first  the accounts among them with no finished booking on any community session dated before this one, an
--            account once (as the Saturday recap counts first Saturday rides, _hub_auto_post). A booking with no
--            account is never one.
--     A number under 10 is left out of its object; a session with neither number is left out whole.
--  2. hub_feed(p_id, p_token, p_src): the Community tab's one read answers them as 'going'. The function is the one in
--     20261113120000_community_reach.sql, copied whole from that file (function attributes trap: header and body from
--     the migration, not from prosrc) with ONE change: the answer's last key, 'going', _hub_going(). Anyone merging
--     another change to hub_feed keeps that one line.
--
-- Run after 20261113120000_community_reach.sql. The app works before this runs: without 'going' in the answer the card
-- is as it was, with no count and no error.
--
-- Rollback: run the hub_feed block of 20261113120000_community_reach.sql again, then
--   drop function if exists public._hub_going();

begin;

-- ── the counts: totals of 10 or more, published and open sessions only ──────────────────────────
create or replace function public._hub_going()
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_today text := to_char(_ksa_today(), 'YYYY-MM-DD');
  v_now_t text := to_char(now() at time zone 'Asia/Riyadh', 'HH24:MI');
  w jsonb; v_days integer; v_at text; v_last text;
  v_out jsonb;
begin
  -- The booking window: a session opens v_days days before its date, at v_at on that day when a time is set. No row, or
  -- a value that is not a whole number of days, is no window (every date is open), as _booking_window_guard has it.
  select value into w from site_content where key = 'booking.window';
  if w is not null and jsonb_typeof(w) = 'object' then
    if (w->>'days') ~ '^\d{1,4}$' then v_days := (w->>'days')::integer; end if;
    if (w->>'at') ~ '^\d{2}:\d{2}$' then v_at := w->>'at'; end if;
  end if;
  -- the last date already open: session_date is text, so the window is compared as text and no date is cast
  if v_days is not null then v_last := to_char(_ksa_today() + v_days, 'YYYY-MM-DD'); end if;

  select jsonb_object_agg(z.id, jsonb_strip_nulls(jsonb_build_object(
           'n', case when z.n >= 10 then z.n end,
           'first', case when z.f >= 10 then z.f end)))
    into v_out
    from (
      select g.id, count(*)::integer as n, (count(distinct g.customer_id) filter (where g.is_first))::integer as f
        from (
          select s.id, q.customer_id,
                 (q.customer_id is not null and not exists (
                    select 1 from queue_entries q2 join sessions s2 on s2.id = q2.session_id
                     where q2.customer_id = q.customer_id and q2.status = 'done' and s2.event_kind = 'community'
                       and s2.session_date < s.session_date)) as is_first
            from sessions s join queue_entries q on q.session_id = s.id
           where s.event_kind = 'community' and s.ride_kind is distinct from 'snd96'
             and s.hide_queue is false
             and s.status = 'open' and s.cancelled_at is null and s.ride_status is distinct from 'cancelled'
             and s.session_date >= v_today
             and (v_last is null or coalesce(s.ride_kind, '') in ('vlap', 'arena')
                  or s.session_date < v_last
                  or (s.session_date = v_last and (v_at is null or v_now_t >= v_at)))
             and q.status in ('waiting', 'active', 'done')
             and (case when s.needs_approval is distinct from false then q.approval is not distinct from 'approved'
                       else q.approval is distinct from 'rejected' end)) g
       group by g.id) z
   where z.n >= 10 or z.f >= 10;
  return coalesce(v_out, '{}'::jsonb);
end $$;
revoke all on function public._hub_going() from public, anon, authenticated;

-- ── the tab's one read, with the counts (the one added line is its last key) ────────────────────
drop function if exists public.hub_feed(text, text);
create or replace function public.hub_feed(p_id text, p_token text, p_src text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare
  v_today date := _ksa_today();
  v_month date := date_trunc('month', _ksa_today())::date;
  v_end date := (date_trunc('month', _ksa_today()) + interval '1 month' - interval '1 day')::date;
  v_accts text[];
  lv hub_levels%rowtype;
  v_club jsonb; v_ct int; v_cn int; sg hub_goals%rowtype; v_te int; v_nd text; v_held int;
  v_got text[];
  v_last text; v_lr int; v_lp int; v_mn int; v_all int;
  v_post jsonb; v_ann jsonb; v_vol text; v_bday boolean := false;
  v_year int; v_year_doc jsonb; v_first text;
  v_bd text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  v_accts := _accts_of(p_id);
  insert into hub_opens (customer_id, day) values (p_id, v_today) on conflict do nothing;
  -- R3: an open (not a refresh) says where it came from; R4: reading the tab clears the dot
  if p_src is not null then
    insert into hub_open_log (customer_id, src)
    values (p_id, case when p_src in ('tab', 'dot', 'rating', 'booked', 'wa', 'push', 'badge', 'link') then p_src else 'tab' end);
  end if;
  insert into hub_tab_seen (customer_id, tab_at) values (p_id, now())
  on conflict (customer_id) do update set tab_at = excluded.tab_at;

  lv := _hub_level_row(p_id, v_accts, v_month);

  -- the club goal: a staff goal running now, else the month's own
  select * into sg from hub_goals where kind = 'goal' and v_today between starts_on and ends_on order by ends_on limit 1;
  if found then
    v_cn := (select count(*) from (select distinct q.customer_id, q.session_id
                from queue_entries q join sessions s on s.id = q.session_id
                join customer_tags ct on ct.customer_id = q.customer_id and ct.tag_id = 'tag_saturday'
               where q.status = 'done'
                 and s.session_date >= to_char(sg.starts_on, 'YYYY-MM-DD') and s.session_date <= to_char(sg.ends_on, 'YYYY-MM-DD')
                 and (case when sg.scope = 'saturday' then s.ride_kind = 'saturday' else s.event_kind = 'community' end)) z);
    v_club := jsonb_build_object('name', sg.name, 'name_ar', sg.name_ar, 'scope', sg.scope, 'target', sg.target, 'n', v_cn,
      'mine', _hub_count(v_accts, sg.scope, sg.starts_on, sg.ends_on), 'from', sg.starts_on, 'ends_on', sg.ends_on);
  else
    v_ct := _hub_club_row(v_month);
    v_te := case when v_ct is not null then _hub_club_eff(v_month) end;
    if v_te is not null then
      v_cn := _hub_club_n(v_month, v_end);
      v_club := jsonb_build_object('scope', 'saturday', 'target', v_te, 'n', v_cn,
        'manual', coalesce((select manual from hub_club_goals where month = v_month), false),
        'mine', _hub_n(v_accts, v_month, v_end, true), 'from', v_month, 'ends_on', v_end);
      -- R20: reached before the month is out: the next Saturday's own target, this month's pace per Saturday plus 5%
      if v_cn >= v_te then
        select min(s.session_date) into v_nd from sessions s
         where s.ride_kind = 'saturday' and s.status <> 'deleted' and s.cancelled_at is null and s.ride_status is distinct from 'cancelled'
           and s.session_date >= to_char(v_today, 'YYYY-MM-DD') and s.session_date <= to_char(v_end, 'YYYY-MM-DD')
           and not exists (select 1 from queue_entries q where q.session_id = s.id and q.status = 'done');
        select count(distinct s.session_date)::int into v_held from queue_entries q join sessions s on s.id = q.session_id
         where q.status = 'done' and s.ride_kind = 'saturday'
           and s.session_date >= to_char(v_month, 'YYYY-MM-DD') and s.session_date <= to_char(v_end, 'YYYY-MM-DD');
        if v_nd is not null and v_held > 0 then
          v_club := v_club || jsonb_build_object('next', jsonb_build_object('date', v_nd, 'target', ceil(v_cn::numeric / v_held * 1.05)::int));
        end if;
      end if;
    end if;
  end if;

  v_got := _hub_award(p_id, v_accts);

  -- club numbers, all riders, totals of 10 or more only
  select max(s.session_date) into v_last from queue_entries q join sessions s on s.id = q.session_id
   where q.status = 'done' and s.ride_kind = 'saturday' and s.session_date <= to_char(v_today, 'YYYY-MM-DD');
  if v_last is not null then
    select count(distinct q.customer_id), count(*) into v_lr, v_lp from queue_entries q join sessions s on s.id = q.session_id
     where q.status = 'done' and s.ride_kind = 'saturday' and s.session_date = v_last;
  end if;
  select count(*) into v_mn from queue_entries q join sessions s on s.id = q.session_id
   where q.status = 'done' and s.ride_kind = 'saturday' and s.session_date >= to_char(v_month, 'YYYY-MM-DD') and s.session_date <= to_char(v_end, 'YYYY-MM-DD');
  select count(*), min(s.session_date) into v_all, v_first from queue_entries q join sessions s on s.id = q.session_id
   where q.status = 'done' and s.ride_kind = 'saturday';

  -- the staff card: the newest Saturday report showing today, hidden ones never; R13's counts and the member's own part
  select jsonb_build_object('id', p.id, 'line', p.line, 'line_ar', p.line_ar,
           'riders', case when p.riders >= 10 then p.riders end, 'rides', case when p.rides >= 10 then p.rides end,
           'first_rides', case when p.first_rides >= 10 then p.first_rides end,
           'leads', case when p.leads >= 10 then p.leads end,
           'volunteers', case when p.volunteers >= 10 then p.volunteers end,
           'prev_riders', case when p.prev_riders >= 10 then p.prev_riders end,
           'auto', p.auto, 'kind', s.ride_kind,
           'mine', case when s.session_date is not null and exists (select 1 from queue_entries q
                                  where q.session_id = p.session_id and q.customer_id = any(v_accts) and q.status = 'done')
                        then _hub_n(v_accts, date_trunc('month', s.session_date::date)::date,
                                    (date_trunc('month', s.session_date::date) + interval '1 month' - interval '1 day')::date, true) end,
           'date', s.session_date, 'img', p.img is not null)
    into v_post from hub_posts p left join sessions s on s.id = p.session_id
   where not p.hidden and v_today between p.shows_from and p.shows_until order by p.shows_from desc, p.created_at desc limit 1;
  select value into v_ann from site_content where key = 'site.announce.messages';
  select vs.session_id into v_vol from volunteer_sessions vs join sessions s on s.id = vs.session_id
   where vs.enabled and vs.signup_open
     and now() between vs.opens_at and vs.closes_at and s.session_date >= to_char(v_today, 'YYYY-MM-DD')
   order by vs.closes_at limit 1;
  select c.birth_date into v_bd from customers c where c.id = p_id;
  /* a 29 February birthday falls on 28 February in a year with no 29th, as the website greets it (bh11 hub-8) */
  if v_bd ~ '^\d{4}-\d{2}-\d{2}$'
     and (right(v_bd, 5) = to_char(v_today, 'MM-DD')
          or (right(v_bd, 5) = '02-29' and to_char(v_today, 'MM-DD') = '02-28'
              and extract(day from make_date(extract(year from v_today)::int, 3, 1) - 1) = 28)) then
    v_bday := true;
  end if;

  -- December and January: the year that is ending or has just ended; in full from 27 December
  if extract(month from v_today) in (12, 1) then
    v_year := extract(year from v_today)::integer - (case when extract(month from v_today) = 1 then 1 else 0 end);
    with mine as (
      select distinct q.session_id, s.session_date, coalesce(s.ride_kind, 'rental') as kind
        from queue_entries q join sessions s on s.id = q.session_id
       where q.customer_id = any(v_accts) and q.status = 'done' and left(s.session_date, 4) = v_year::text)
    select case when count(*) = 0 then null else jsonb_build_object('year', v_year,
             'full', not (extract(month from v_today) = 12 and extract(day from v_today) < 27),
             'sessions', count(*),
             'saturdays', count(*) filter (where kind = 'saturday'),
             'first', min(session_date),
             'kinds', (select jsonb_agg(distinct m2.kind) from mine m2),
             'busiest', (select left(m3.session_date, 7) from mine m3 group by left(m3.session_date, 7) order by count(*) desc, left(m3.session_date, 7) limit 1),
             'sats_held', (select count(distinct s2.session_date) from queue_entries q2 join sessions s2 on s2.id = q2.session_id
                            where q2.status = 'done' and s2.ride_kind = 'saturday' and left(s2.session_date, 4) = v_year::text
                              and s2.session_date >= min(mine.session_date)),
             'club', (select count(*) from queue_entries q3 join sessions s3 on s3.id = q3.session_id
                       where q3.status = 'done' and left(s3.session_date, 4) = v_year::text),
             'club_first', (select min(s4.session_date) from queue_entries q4 join sessions s4 on s4.id = q4.session_id
                             where q4.status = 'done' and left(s4.session_date, 4) = v_year::text),
             'badges', (select count(*) from customer_badges cb where cb.customer_id = any(v_accts)
                          and extract(year from cb.awarded_at at time zone 'Asia/Riyadh') = v_year)) end
      into v_year_doc from mine;
  end if;

  return jsonb_build_object('ok', true,
    'today', v_today,
    'me', jsonb_build_object('kind', lv.kind, 'levels', to_jsonb(lv.levels), 'target', lv.target, 'chosen', lv.chosen,
            'n', _hub_n(v_accts, v_month, v_end, false), 'ends_on', v_end, 'sats', _hub_sats(v_month)),
    'club', v_club,
    'goals', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'name_ar', g.name_ar, 'scope', g.scope, 'target', g.target,
               'n', _hub_goal_n(v_accts, g.id), 'ends_on', g.ends_on,
               'badge', case when bd.id is not null then jsonb_build_object('slug', bd.slug, 'icon', bd.icon, 'color', bd.color) end)
               order by g.ends_on)
        from hub_goals g left join badges bd on bd.id = g.badge_id and not bd.retired
       where g.kind = 'challenge' and v_today between g.starts_on and g.ends_on), '[]'::jsonb),
    'numbers', jsonb_build_object(
      'last', v_last, 'last_riders', case when v_lr >= 10 then v_lr end, 'last_rides', case when v_lp >= 10 then v_lp end,
      'month', case when v_mn >= 10 then v_mn end, 'all', case when v_all >= 10 then v_all end, 'since', v_first),
    'post', v_post,
    'announce', coalesce(v_ann, '[]'::jsonb),
    'volunteer', v_vol,
    'birthday', v_bday,
    'awarded', to_jsonb(v_got),
    'year', v_year_doc,
    'going', _hub_going());
end $$;
revoke all on function public.hub_feed(text, text, text) from public;
grant execute on function public.hub_feed(text, text, text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114011900', 'hub_going')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select (select p.prosecdef from pg_proc p where p.oid = 'public._hub_going()'::regprocedure) as definer_true,
       (select p.provolatile from pg_proc p where p.oid = 'public._hub_going()'::regprocedure) as going_volatility_s,
       has_function_privilege('anon', 'public._hub_going()', 'execute') as anon_going_false,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'hub_feed') as hub_feed_one,
       (select p.prosecdef from pg_proc p where p.oid = 'public.hub_feed(text,text,text)'::regprocedure) as feed_definer_true,
       (select p.provolatile from pg_proc p where p.oid = 'public.hub_feed(text,text,text)'::regprocedure) as feed_volatility_v,
       has_function_privilege('anon', 'public.hub_feed(text,text,text)', 'execute') as anon_feed_true,
       (select position('_hub_going()' in p.prosrc) > 0 from pg_proc p where p.oid = 'public.hub_feed(text,text,text)'::regprocedure) as feed_has_going_true,
       jsonb_typeof(public._hub_going()) as going_object,
       (select count(*) from jsonb_each(public._hub_going()) e
         where coalesce((e.value->>'n')::int, 10) < 10 or coalesce((e.value->>'first')::int, 10) < 10) as under_ten_0,
       (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity) as no_rls_0,
       (select version from supabase_migrations.schema_migrations where version = '20261114011900') as ledger;
