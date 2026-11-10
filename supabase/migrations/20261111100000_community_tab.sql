-- The members' Community tab, rebuilt (reports/Booking app Community tab.md, M1-M33; the user, 2026-11-10: "do them all").
--
--  1. hub_levels: each member's own challenge for a month, made the first time they open the tab that month and kept, so the
--     month's target never moves under them. First session, second session, back this month (none last month), or a level
--     the member picks from three (hub_pick_level); every kind of session counts.
--  2. hub_club_goals: the club's goal for a month, made on the month's first read from the members' own pace (their Saturday
--     rides per Saturday over the two months before, times the month's Saturdays, plus 5%). A staff goal running that month
--     takes its place. Counted on members' Saturday rides, as the staff goals are.
--  3. Badges the database gives by itself, never a prize: a challenge ladder (1, 3, 6, 12 months with the own challenge met),
--     a club-goal ladder (1, 3, 6, 12 months of a goal reached that the member rode towards) and a staff challenge's own badge
--     (hub_goals.badge_id; the staff form no longer writes reward text, so nothing else is promised). Given when the member
--     opens the tab (_hub_award), as staff would give them, so the app's new-badge pop-up shows them.
--  4. hub_posts: the staff "Saturday report" (one line from the ride leader, the ride's counts, one photo with no members in it)
--     shown between two dates. The photo is JPEG text read on its own (hub_post_img), as the member wall's photos were.
--  5. hub_feed: everything the tab shows, in one read. Totals under 10 are left out (a small session's count says who came).
--     Kudos are gone from the year (they left members on 2026-11-04). The year shows from 1 December ("so far") and in full
--     from 27 December (after the last Saturday) to the end of January.
--  6. hub_opens: one row per member per day the tab was opened, for the staff numbers (staff_hub_numbers).
--  7. club_card (the website's email + mobile lookup) no longer answers anyone: it gave a member's first name, tier and rides
--     to whoever knew both. The website shows a signed-in member their card from member_area.
-- hub_overview stays for an app still holding the old page; the new page does not call it.
--
-- Headers copied from the previous migrations, not from prosrc (function attributes trap).

begin;

-- ── 1-4, 6: tables ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.hub_levels (
  customer_id text not null references public.customers (id) on update cascade on delete cascade,
  month       date not null check (extract(day from month) = 1),
  kind        text not null check (kind in ('first', 'second', 'back', 'level')),
  levels      integer[] not null,
  target      integer not null check (target between 1 and 31),
  chosen      boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (customer_id, month)
);
alter table public.hub_levels enable row level security;
revoke all on public.hub_levels from public, anon, authenticated;

create table if not exists public.hub_club_goals (
  month      date primary key check (extract(day from month) = 1),
  target     integer not null check (target between 1 and 100000),
  created_at timestamptz not null default now()
);
alter table public.hub_club_goals enable row level security;
revoke all on public.hub_club_goals from public, anon, authenticated;

create table if not exists public.hub_opens (
  customer_id text not null references public.customers (id) on update cascade on delete cascade,
  day         date not null,
  primary key (customer_id, day)
);
alter table public.hub_opens enable row level security;
revoke all on public.hub_opens from public, anon, authenticated;

create table if not exists public.hub_posts (
  id          text primary key default ('post_' || replace(gen_random_uuid()::text, '-', '')),
  session_id  text references public.sessions (id) on update cascade on delete set null,
  line        text check (char_length(line) <= 200),
  line_ar     text check (char_length(line_ar) <= 200),
  riders      integer check (riders >= 0),
  rides       integer check (rides >= 0),
  img         text check (img is null or (img like 'data:image/jpeg;base64,%' and char_length(img) <= 400000)),
  shows_from  date not null,
  shows_until date not null,
  created_by  text check (char_length(created_by) <= 60),
  created_at  timestamptz not null default now(),
  check (shows_until >= shows_from)
);
alter table public.hub_posts enable row level security;
revoke all on public.hub_posts from public, anon, authenticated;
grant select, insert, update, delete on public.hub_posts to authenticated;
drop policy if exists "staff full" on public.hub_posts;
create policy "staff full" on public.hub_posts for all to authenticated using ((select is_staff())) with check ((select is_staff()));

alter table public.hub_goals add column if not exists badge_id text references public.badges (id) on update cascade on delete set null;

-- ── 3: the badges ────────────────────────────────────────────────────────────────────────────────
-- auto: shown to a rider only once held, so a non-member never sees a badge they cannot earn.
insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort) values
  ('bd_challenge_1',  'challenge_1',  'target', 'orange', 'Challenge Met',     'تحدٍّ مُنجز',      'Meet your monthly challenge.',             'أنجز تحديك الشهري.',               true, true, 90),
  ('bd_challenge_3',  'challenge_3',  'target', 'teal',   'Challenge Met 3',   'تحدٍّ مُنجز 3',    'Meet your monthly challenge 3 times.',     'أنجز تحديك الشهري 3 مرات.',         true, true, 91),
  ('bd_challenge_6',  'challenge_6',  'target', 'purple', 'Challenge Met 6',   'تحدٍّ مُنجز 6',    'Meet your monthly challenge 6 times.',     'أنجز تحديك الشهري 6 مرات.',         true, true, 92),
  ('bd_challenge_12', 'challenge_12', 'target', 'gold',   'Challenge Met 12',  'تحدٍّ مُنجز 12',   'Meet your monthly challenge 12 times.',    'أنجز تحديك الشهري 12 مرة.',         true, true, 93),
  ('bd_club_goal_1',  'club_goal_1',  'people', 'blue',   'Club Goal',         'هدف النادي',       'Ride towards a club goal that is reached.', 'شارك في هدف للنادي تحقّق.',        true, true, 94),
  ('bd_club_goal_3',  'club_goal_3',  'people', 'teal',   'Club Goal 3',       'هدف النادي 3',     'Help reach 3 club goals.',                 'ساهم في تحقيق 3 أهداف للنادي.',     true, true, 95),
  ('bd_club_goal_6',  'club_goal_6',  'people', 'purple', 'Club Goal 6',       'هدف النادي 6',     'Help reach 6 club goals.',                 'ساهم في تحقيق 6 أهداف للنادي.',     true, true, 96),
  ('bd_club_goal_12', 'club_goal_12', 'people', 'gold',   'Club Goal 12',      'هدف النادي 12',    'Help reach 12 club goals.',                'ساهم في تحقيق 12 هدفاً للنادي.',    true, true, 97),
  ('bd_cool_season_26', 'cool_season_26', 'wind', 'teal', 'Cool Season 2026',  'موسم الأجواء الباردة 2026', '8 Saturday rides between November 2026 and February 2027.', '8 رحلات سبت بين نوفمبر 2026 وفبراير 2027.', true, true, 98)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true, retired = false, sort = excluded.sort;

-- M2: the season's challenge, from the staff template, with its badge and no reward text.
insert into public.hub_goals (id, kind, name, name_ar, scope, target, starts_on, ends_on, badge_id)
values ('goal_cool_season_2026', 'challenge', 'Cool Season: 8 Saturdays', 'موسم الأجواء الباردة: 8 رحلات سبت', 'saturday', 8, '2026-11-01', '2027-02-28', 'bd_cool_season_26')
on conflict (id) do nothing;

-- ── helpers ─────────────────────────────────────────────────────────────────────────────────────
create or replace function public._hub_sats(p_month date)
returns integer
language sql immutable set search_path to 'public'
as $$
  select count(*)::integer from generate_series(p_month, (p_month + interval '1 month' - interval '1 day')::date, interval '1 day') d
   where extract(isodow from d) = 6;
$$;
revoke all on function public._hub_sats(date) from public, anon, authenticated;

-- Finished sessions of one person's accounts between two days; only the Saturday rides when p_sat.
create or replace function public._hub_n(p_accts text[], p_from date, p_to date, p_sat boolean)
returns integer
language sql stable security definer set search_path to 'public'
as $$
  select count(distinct q.session_id)::integer
    from queue_entries q join sessions s on s.id = q.session_id
   where q.customer_id = any(p_accts) and q.status = 'done'
     and s.session_date >= to_char(p_from, 'YYYY-MM-DD') and s.session_date <= to_char(p_to, 'YYYY-MM-DD')
     and (not p_sat or s.ride_kind = 'saturday');
$$;
revoke all on function public._hub_n(text[], date, date, boolean) from public, anon, authenticated;

-- Members' Saturday rides between two days (a member and a ride counted once), as the staff goals count them.
create or replace function public._hub_club_n(p_from date, p_to date)
returns integer
language sql stable security definer set search_path to 'public'
as $$
  select count(*)::integer from (
    select distinct q.customer_id, q.session_id
      from queue_entries q join sessions s on s.id = q.session_id
      join customer_tags ct on ct.customer_id = q.customer_id and ct.tag_id = 'tag_saturday'
     where q.status = 'done' and s.ride_kind = 'saturday'
       and s.session_date >= to_char(p_from, 'YYYY-MM-DD') and s.session_date <= to_char(p_to, 'YYYY-MM-DD')) z;
$$;
revoke all on function public._hub_club_n(date, date) from public, anon, authenticated;

-- The member's challenge for a month: made once, then kept.
create or replace function public._hub_level_row(p_id text, p_accts text[], p_month date)
returns public.hub_levels
language plpgsql volatile security definer set search_path to 'public'
as $$
declare r hub_levels%rowtype; v_before int; v_last int; v_typ numeric; v_s int; v_sats int := _hub_sats(p_month);
begin
  select * into r from hub_levels where customer_id = p_id and month = p_month;
  if found then return r; end if;
  v_before := _hub_n(p_accts, date '2000-01-01', p_month - 1, false);
  v_last := _hub_n(p_accts, (p_month - interval '1 month')::date, p_month - 1, false);
  if v_before = 0 then
    insert into hub_levels (customer_id, month, kind, levels, target) values (p_id, p_month, 'first', array[1], 1) on conflict do nothing;
  elsif v_before = 1 then
    insert into hub_levels (customer_id, month, kind, levels, target) values (p_id, p_month, 'second', array[1], 1) on conflict do nothing;
  elsif v_last = 0 then
    insert into hub_levels (customer_id, month, kind, levels, target) values (p_id, p_month, 'back', array[1], 1) on conflict do nothing;
  else
    -- the member's usual month (the average of the last three months they came at all), one more, at least 2,
    -- at most the month's Saturdays; offered with one under and one over
    select avg(n) into v_typ from (
      select _hub_n(p_accts, m::date, (m + interval '1 month' - interval '1 day')::date, false) as n
        from generate_series((p_month - interval '3 months')::date, (p_month - interval '1 month')::date, interval '1 month') m) x
     where n > 0;
    v_s := greatest(2, least(round(coalesce(v_typ, 1))::int + 1, v_sats));
    insert into hub_levels (customer_id, month, kind, levels, target)
    values (p_id, p_month, 'level', array[v_s - 1, v_s, v_s + 1], v_s) on conflict do nothing;
  end if;
  select * into r from hub_levels where customer_id = p_id and month = p_month;
  return r;
end $$;
revoke all on function public._hub_level_row(text, text[], date) from public, anon, authenticated;

-- The club's goal for a month, made on its first read. Null while the club has no pace to go on.
create or replace function public._hub_club_row(p_month date)
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_t int; v_n int; v_days int;
begin
  select target into v_t from hub_club_goals where month = p_month;
  if found then return v_t; end if;
  v_n := _hub_club_n((p_month - interval '2 months')::date, p_month - 1);
  select count(distinct s.session_date)::int into v_days
    from queue_entries q join sessions s on s.id = q.session_id
   where q.status = 'done' and s.ride_kind = 'saturday'
     and s.session_date >= to_char((p_month - interval '2 months')::date, 'YYYY-MM-DD') and s.session_date < to_char(p_month, 'YYYY-MM-DD');
  if coalesce(v_days, 0) = 0 or v_n < 10 then return null; end if;
  v_t := ceil(v_n::numeric / v_days * _hub_sats(p_month) * 1.05)::int;
  if v_t < 10 then return null; end if;
  insert into hub_club_goals (month, target) values (p_month, v_t) on conflict (month) do nothing;
  select target into v_t from hub_club_goals where month = p_month;
  return v_t;
end $$;
revoke all on function public._hub_club_row(date) from public, anon, authenticated;

-- Gives the badges the member has reached and returns the slugs given now. Each lower level of a ladder is stored too, as
-- staff giving a level does (_bdgWithLower). Badges missing from the catalogue are skipped.
create or replace function public._hub_award(p_id text, p_accts text[])
returns text[]
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_today date := _ksa_today(); v_got text[] := '{}'; v_mine int; v_club int; L int; b text; g record;
begin
  select count(*) into v_mine from hub_levels h
   where h.customer_id = p_id and h.month <= v_today
     and _hub_n(p_accts, h.month, (h.month + interval '1 month' - interval '1 day')::date, false) >= h.target;
  select count(*) into v_club from hub_club_goals cg
   where cg.month <= v_today
     and not exists (select 1 from hub_goals sg where sg.kind = 'goal' and sg.starts_on <= (cg.month + interval '1 month' - interval '1 day')::date and sg.ends_on >= cg.month)
     and _hub_club_n(cg.month, (cg.month + interval '1 month' - interval '1 day')::date) >= cg.target
     and _hub_n(p_accts, cg.month, (cg.month + interval '1 month' - interval '1 day')::date, true) > 0;
  foreach L in array array[1, 3, 6, 12] loop
    if v_mine >= L then
      b := 'bd_challenge_' || L;
      if exists (select 1 from badges where id = b and not retired) then
        insert into customer_badges (customer_id, badge_id, awarded_by, note) values (p_id, b, 'system', 'Monthly challenge') on conflict do nothing;
        if found then v_got := v_got || ('challenge_' || L); end if;
      end if;
    end if;
    if v_club >= L then
      b := 'bd_club_goal_' || L;
      if exists (select 1 from badges where id = b and not retired) then
        insert into customer_badges (customer_id, badge_id, awarded_by, note) values (p_id, b, 'system', 'Club goal') on conflict do nothing;
        if found then v_got := v_got || ('club_goal_' || L); end if;
      end if;
    end if;
  end loop;
  -- a staff challenge or goal with a badge: the member's own count reached (a challenge), or the goal reached and the member
  -- rode towards it (a goal)
  for g in select hg.*, bd.slug from hub_goals hg join badges bd on bd.id = hg.badge_id and not bd.retired
            where hg.starts_on <= v_today loop
    if (g.kind = 'challenge' and _hub_count(p_accts, g.scope, g.starts_on, g.ends_on) >= g.target)
       or (g.kind = 'goal' and _hub_count(p_accts, g.scope, g.starts_on, least(g.ends_on, v_today)) > 0
           and (select count(*) from (select distinct q.customer_id, q.session_id
                  from queue_entries q join sessions s on s.id = q.session_id
                  join customer_tags ct on ct.customer_id = q.customer_id and ct.tag_id = 'tag_saturday'
                 where q.status = 'done'
                   and s.session_date >= to_char(g.starts_on, 'YYYY-MM-DD') and s.session_date <= to_char(g.ends_on, 'YYYY-MM-DD')
                   and (case when g.scope = 'saturday' then s.ride_kind = 'saturday' else s.event_kind = 'community' end)) z) >= g.target) then
      insert into customer_badges (customer_id, badge_id, awarded_by, note) values (p_id, g.badge_id, 'system', left(g.name, 140)) on conflict do nothing;
      if found then v_got := v_got || g.slug; end if;
    end if;
  end loop;
  return v_got;
end $$;
revoke all on function public._hub_award(text, text[]) from public, anon, authenticated;

-- ── 5: the tab's one read ───────────────────────────────────────────────────────────────────────
create or replace function public.hub_feed(p_id text, p_token text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare
  v_today date := _ksa_today();
  v_month date := date_trunc('month', _ksa_today())::date;
  v_end date := (date_trunc('month', _ksa_today()) + interval '1 month' - interval '1 day')::date;
  v_accts text[];
  lv hub_levels%rowtype;
  v_club jsonb; v_ct int; v_cn int; sg hub_goals%rowtype;
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
    if v_ct is not null then
      v_club := jsonb_build_object('scope', 'saturday', 'target', v_ct, 'n', _hub_club_n(v_month, v_end),
        'mine', _hub_n(v_accts, v_month, v_end, true), 'from', v_month, 'ends_on', v_end);
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

  -- the staff card: the newest Saturday report showing today
  select jsonb_build_object('id', p.id, 'line', p.line, 'line_ar', p.line_ar,
           'riders', case when p.riders >= 10 then p.riders end, 'rides', case when p.rides >= 10 then p.rides end,
           'date', s.session_date, 'img', p.img is not null)
    into v_post from hub_posts p left join sessions s on s.id = p.session_id
   where v_today between p.shows_from and p.shows_until order by p.shows_from desc, p.created_at desc limit 1;
  select value into v_ann from site_content where key = 'site.announce.messages';
  select vs.session_id into v_vol from volunteer_sessions vs join sessions s on s.id = vs.session_id
   where vs.enabled and vs.signup_open
     and now() between vs.opens_at and vs.closes_at and s.session_date >= to_char(v_today, 'YYYY-MM-DD')
   order by vs.closes_at limit 1;
  select c.birth_date into v_bd from customers c where c.id = p_id;
  if v_bd ~ '^\d{4}-\d{2}-\d{2}$' and right(v_bd, 5) = to_char(v_today, 'MM-DD') then v_bday := true; end if;

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
               'n', _hub_count(v_accts, g.scope, g.starts_on, g.ends_on), 'ends_on', g.ends_on,
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
    'year', v_year_doc);
end $$;
revoke all on function public.hub_feed(text, text) from public;
grant execute on function public.hub_feed(text, text) to anon, authenticated;

-- The member picks one of the month's three levels; the challenge counts it at once.
create or replace function public.hub_pick_level(p_id text, p_token text, p_level integer)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_month date := date_trunc('month', _ksa_today())::date;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  update hub_levels set target = p_level, chosen = true
   where customer_id = p_id and month = v_month and kind = 'level' and p_level = any(levels);
  if not found then return jsonb_build_object('ok', false, 'error', 'level'); end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.hub_pick_level(text, text, integer) from public;
grant execute on function public.hub_pick_level(text, text, integer) to anon, authenticated;

-- A Saturday report's photo, read on its own while the report shows.
create or replace function public.hub_post_img(p_id text, p_token text, p_post text)
returns text
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) or not _member_active(p_id) then return null; end if;
  return (select p.img from hub_posts p where p.id = p_post and _ksa_today() between p.shows_from and p.shows_until);
end $$;
revoke all on function public.hub_post_img(text, text, text) from public;
grant execute on function public.hub_post_img(text, text, text) to anon, authenticated;

-- ── 6: the staff numbers (Community > Activities) ───────────────────────────────────────────────
-- For one month: riders whose first Saturday ride fell in it and how many came to another session within 28 days; members who
-- opened the tab and on how many days; challenges made, levels picked, challenges met; the club goal.
create or replace function public.staff_hub_numbers(p_month date)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_m date := date_trunc('month', p_month)::date; v_e date := (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date;
  v_first int; v_back int; v_t int;
begin
  if not coalesce(is_staff(), false) then raise exception 'not staff' using errcode = '42501'; end if;
  with firsts as (
    select q.customer_id, min(s.session_date) as d
      from queue_entries q join sessions s on s.id = q.session_id
     where q.status = 'done' and s.ride_kind = 'saturday' group by q.customer_id)
  select count(*), count(*) filter (where exists (
           select 1 from queue_entries q2 join sessions s2 on s2.id = q2.session_id
            where q2.customer_id = f.customer_id and q2.status = 'done'
              and s2.session_date > f.d and s2.session_date <= to_char(f.d::date + 28, 'YYYY-MM-DD')))
    into v_first, v_back
    from firsts f where f.d >= to_char(v_m, 'YYYY-MM-DD') and f.d <= to_char(v_e, 'YYYY-MM-DD');
  select target into v_t from hub_club_goals where month = v_m;
  return jsonb_build_object('month', v_m,
    'first', v_first, 'back', v_back,
    'openers', (select count(distinct customer_id) from hub_opens where day between v_m and v_e),
    'open_days', (select count(*) from hub_opens where day between v_m and v_e),
    'members', (select count(distinct ct.customer_id) from customer_tags ct where ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at)),
    'challenges', (select count(*) from hub_levels where month = v_m),
    'picked', (select count(*) from hub_levels where month = v_m and chosen),
    'met', (select count(*) from hub_levels h where h.month = v_m
             and _hub_n(_accts_of(h.customer_id), v_m, v_e, false) >= h.target),
    'club_target', v_t, 'club_n', _hub_club_n(v_m, v_e));
end $$;
revoke all on function public.staff_hub_numbers(date) from public, anon;
grant execute on function public.staff_hub_numbers(date) to authenticated;

-- ── 7: the website's email + mobile card lookup answers no one ─────────────────────────────────
revoke execute on function public.club_card(text, text) from public, anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111100000', 'community_tab')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): every new table has RLS on; the definer functions; who may call what; the badges; the season's challenge.
select (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity) as no_rls_0,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('hub_feed', 'hub_pick_level', 'hub_post_img', 'staff_hub_numbers', '_hub_award', '_hub_level_row', '_hub_club_row', '_hub_n', '_hub_club_n')) as definer_9,
       has_function_privilege('anon', 'public.hub_feed(text,text)', 'execute') as anon_feed_true,
       has_function_privilege('anon', 'public._hub_award(text,text[])', 'execute') as anon_award_false,
       has_function_privilege('anon', 'public.club_card(text,text)', 'execute') as anon_card_false,
       (select count(*) from public.badges where id like 'bd_challenge_%' or id like 'bd_club_goal_%' or id = 'bd_cool_season_26') as badges_9,
       (select badge_id from public.hub_goals where id = 'goal_cool_season_2026') as season_badge,
       (select version from supabase_migrations.schema_migrations where version = '20261111100000') as ledger;
