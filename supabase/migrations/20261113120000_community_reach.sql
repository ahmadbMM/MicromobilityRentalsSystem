-- The Community tab reaches the members who never open it (reports/Community tab reach after launch.md; the user,
-- 2026-11-13, marked every item Build now but R19).
--
--  R1  Every active member's monthly challenge is made by the database itself (a job every quarter hour, so on the 1st
--      and for a new member within minutes), and Community badges are given after sessions finish, not only when the
--      member opens the tab. A badge's "seen" is kept on the server (customer_badges.seen_at), so the app's pop-up shows
--      it once on any tab and never again on another phone.
--  R2  The suggested level never asks for a perfect month (at most one less than the month's Saturdays) unless the member
--      rode every Saturday of one of the last three months; a challenge made after the 1st asks no more than the sessions
--      already done plus the Saturdays left.
--  R3  Each open of the tab can say where it came from (hub_open_log.src); staff_hub_numbers shows opens by entry point
--      and a six-week funnel.
--  R4  hub_pulse: a light read for the whole app (the tab's dot, the rating pop-up's last screen, "You're booked").
--  R10 sessions.ride_status: a staff-set status (start moved, shortened, cancelled) shown on the ticket and the tab.
--  R11 sessions.meet_lat / meet_lng / meet_name / meet_name_ar: the meeting point as a coordinate and a name.
--  R13 A Saturday recap written by the database about two hours after the ride closes (hub_posts.auto), counts only:
--      riders, rides, first Saturday rides, ride leads, volunteers, last Saturday's riders; staff may add a line and a
--      photo, or hide it. The member's own Saturdays this month are added for a member who rode it.
--  R20 The club goal: lowered when a Saturday is lost (cancelled, or passed with no ride); staff may set a month by hand
--      (hub_club_goals.manual), also ahead of time; from a year of history on, a month is sized from the same month a
--      year earlier; once reached, the next Saturday gets its own target.
--  R21 hub_ramadan: Ramadan's dates, set by staff after the moon sighting (2027 seeded as projected). A staff challenge
--      flagged ramadan_any (Cool Season) counts any session during Ramadan toward its Saturdays.
--
-- Headers copied from 20261111100000_community_tab.sql and the live definitions, not from prosrc (function attributes
-- trap). hub_feed gains a third argument with a default, so the two-argument version is dropped first; old pages that
-- call it with two arguments reach the new one.

begin;

-- ── tables and columns ──────────────────────────────────────────────────────────────────────────
alter table public.customer_badges add column if not exists seen_at timestamptz;
-- Every badge given before today counts as seen: the app showed those through its own pop-up already.
update public.customer_badges set seen_at = awarded_at where seen_at is null;

create table if not exists public.hub_tab_seen (
  customer_id text primary key references public.customers (id) on update cascade on delete cascade,
  tab_at      timestamptz not null default now()
);
alter table public.hub_tab_seen enable row level security;
revoke all on public.hub_tab_seen from public, anon, authenticated;

create table if not exists public.hub_open_log (
  id          bigserial primary key,
  customer_id text not null references public.customers (id) on update cascade on delete cascade,
  at          timestamptz not null default now(),
  src         text not null check (src in ('tab', 'dot', 'rating', 'booked', 'wa', 'push', 'badge', 'link'))
);
create index if not exists hub_open_log_at_idx on public.hub_open_log (at);
alter table public.hub_open_log enable row level security;
revoke all on public.hub_open_log from public, anon, authenticated;
revoke all on sequence public.hub_open_log_id_seq from public, anon, authenticated;

alter table public.hub_posts
  add column if not exists auto        boolean not null default false,
  add column if not exists first_rides integer check (first_rides >= 0),
  add column if not exists leads       integer check (leads >= 0),
  add column if not exists volunteers  integer check (volunteers >= 0),
  add column if not exists prev_riders integer check (prev_riders >= 0),
  add column if not exists hidden      boolean not null default false;
create unique index if not exists hub_posts_auto_session on public.hub_posts (session_id) where auto;

alter table public.hub_club_goals add column if not exists manual boolean not null default false;
grant select, insert, update, delete on public.hub_club_goals to authenticated;
drop policy if exists "staff full" on public.hub_club_goals;
create policy "staff full" on public.hub_club_goals for all to authenticated using ((select is_staff())) with check ((select is_staff()));

create table if not exists public.hub_ramadan (
  year      integer primary key check (year between 2020 and 2100),
  starts_on date not null,
  ends_on   date not null,
  confirmed boolean not null default false,
  check (ends_on >= starts_on and ends_on - starts_on <= 31)
);
alter table public.hub_ramadan enable row level security;
revoke all on public.hub_ramadan from public, anon, authenticated;
grant select, insert, update, delete on public.hub_ramadan to authenticated;
drop policy if exists "staff full" on public.hub_ramadan;
create policy "staff full" on public.hub_ramadan for all to authenticated using ((select is_staff())) with check ((select is_staff()));
insert into public.hub_ramadan (year, starts_on, ends_on, confirmed) values (2027, '2027-02-08', '2027-03-09', false)
on conflict (year) do nothing;

alter table public.hub_goals add column if not exists ramadan_any boolean not null default false;
update public.hub_goals set ramadan_any = true where id = 'goal_cool_season_2026';

alter table public.sessions
  add column if not exists meet_lat     double precision check (meet_lat between -90 and 90),
  add column if not exists meet_lng     double precision check (meet_lng between -180 and 180),
  add column if not exists meet_name    text check (char_length(meet_name) <= 80),
  add column if not exists meet_name_ar text check (char_length(meet_name_ar) <= 80),
  add column if not exists ride_status  text check (ride_status in ('moved', 'shortened', 'cancelled'));
do $$ begin
  alter table public.sessions add constraint sessions_meet_point_both check ((meet_lat is null) = (meet_lng is null));
exception when duplicate_object then null; end $$;

-- ── helpers ─────────────────────────────────────────────────────────────────────────────────────
-- The Community badges: the two ladders and every staff challenge's own badge.
create or replace function public._hub_badge_ids()
returns text[]
language sql stable security definer set search_path to 'public'
as $$
  select coalesce(array_agg(b.id), '{}') from badges b
   where b.id like 'bd_challenge_%' or b.id like 'bd_club_goal_%'
      or b.id in (select g.badge_id from hub_goals g where g.badge_id is not null);
$$;
revoke all on function public._hub_badge_ids() from public, anon, authenticated;

-- A staff challenge's count for one member: its own scope, plus any session during Ramadan when it is flagged for it.
create or replace function public._hub_goal_n(p_accts text[], p_goal text)
returns integer
language sql stable security definer set search_path to 'public'
as $$
  select count(distinct q.session_id)::integer
    from hub_goals g
    join queue_entries q on q.customer_id = any(p_accts) and q.status = 'done'
    join sessions s on s.id = q.session_id
   where g.id = p_goal
     and s.session_date >= to_char(g.starts_on, 'YYYY-MM-DD') and s.session_date <= to_char(g.ends_on, 'YYYY-MM-DD')
     and ((case when g.scope = 'saturday' then s.ride_kind = 'saturday' else s.event_kind = 'community' end)
          or (g.ramadan_any and exists (select 1 from hub_ramadan r
                                         where s.session_date >= to_char(r.starts_on, 'YYYY-MM-DD')
                                           and s.session_date <= to_char(r.ends_on, 'YYYY-MM-DD'))));
$$;
revoke all on function public._hub_goal_n(text[], text) from public, anon, authenticated;

-- Saturdays of a month already lost to the goal: passed with no ride, or ahead with every Saturday ride on them cancelled.
create or replace function public._hub_club_lost(p_month date)
returns integer
language sql stable security definer set search_path to 'public'
as $$
  select count(*)::integer
    from generate_series(p_month, (p_month + interval '1 month' - interval '1 day')::date, interval '1 day') g(d)
   where extract(isodow from g.d) = 6
     and ((g.d::date < _ksa_today()
           and not exists (select 1 from queue_entries q join sessions s on s.id = q.session_id
                            where q.status = 'done' and s.ride_kind = 'saturday' and s.session_date = to_char(g.d, 'YYYY-MM-DD')))
       or (g.d::date >= _ksa_today()
           and exists (select 1 from sessions s where s.ride_kind = 'saturday' and s.session_date = to_char(g.d, 'YYYY-MM-DD'))
           and not exists (select 1 from sessions s where s.ride_kind = 'saturday' and s.session_date = to_char(g.d, 'YYYY-MM-DD')
                            and s.status <> 'deleted' and s.cancelled_at is null and s.ride_status is distinct from 'cancelled')));
$$;
revoke all on function public._hub_club_lost(date) from public, anon, authenticated;

-- The month's club target as members see it: a staff target as set; the server's own lowered by the Saturdays lost;
-- null when the month has no Saturday left to count.
create or replace function public._hub_club_eff(p_month date)
returns integer
language plpgsql stable security definer set search_path to 'public'
as $$
declare r hub_club_goals%rowtype; v_sats int := _hub_sats(p_month); v_lost int;
begin
  select * into r from hub_club_goals where month = p_month;
  if not found then return null; end if;
  if r.manual then return r.target; end if;
  v_lost := _hub_club_lost(p_month);
  if v_lost <= 0 then return r.target; end if;
  if v_sats - v_lost <= 0 then return null; end if;
  return greatest(10, ceil(r.target::numeric * (v_sats - v_lost) / v_sats)::int);
end $$;
revoke all on function public._hub_club_eff(date) from public, anon, authenticated;

-- R2: the member's challenge for a month, made once, then kept.
create or replace function public._hub_level_row(p_id text, p_accts text[], p_month date)
returns public.hub_levels
language plpgsql volatile security definer set search_path to 'public'
as $$
declare r hub_levels%rowtype; v_before int; v_last int; v_typ numeric; v_s int; v_sats int := _hub_sats(p_month);
  v_today date := _ksa_today(); v_end date := (p_month + interval '1 month' - interval '1 day')::date;
  v_perfect boolean; v_cap int; v_left int; v_lv int[];
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
    -- the member's usual month (the average of the last three months they came at all), one more, at least 2
    select avg(n) into v_typ from (
      select _hub_n(p_accts, m::date, (m + interval '1 month' - interval '1 day')::date, false) as n
        from generate_series((p_month - interval '3 months')::date, (p_month - interval '1 month')::date, interval '1 month') m) x
     where n > 0;
    -- never every Saturday of the month, unless the member has ridden every Saturday of one of the last three months
    select exists (
      select 1 from (
        select (select count(distinct s.session_date) from queue_entries q join sessions s on s.id = q.session_id
                 where q.status = 'done' and s.ride_kind = 'saturday'
                   and s.session_date >= to_char(m::date, 'YYYY-MM-DD')
                   and s.session_date <= to_char((m + interval '1 month' - interval '1 day')::date, 'YYYY-MM-DD')) as held,
               _hub_n(p_accts, m::date, (m + interval '1 month' - interval '1 day')::date, true) as rode
          from generate_series((p_month - interval '3 months')::date, (p_month - interval '1 month')::date, interval '1 month') m) y
       where y.held > 0 and y.rode >= y.held) into v_perfect;
    v_cap := case when v_perfect then v_sats else greatest(v_sats - 1, 1) end;
    v_s := greatest(2, least(round(coalesce(v_typ, 1))::int + 1, v_cap));
    -- made after the 1st: no more than the sessions already done plus the Saturdays left
    if v_today > p_month and v_today <= v_end then
      v_left := (select count(*)::int from generate_series(v_today, v_end, interval '1 day') g(d) where extract(isodow from g.d) = 6);
      v_s := least(v_s, _hub_n(p_accts, p_month, v_today, false) + v_left);
    end if;
    v_s := greatest(v_s, 1);
    v_lv := array(select x from unnest(array[v_s - 1, v_s, v_s + 1]) as u(x) where x >= 1 order by x);
    insert into hub_levels (customer_id, month, kind, levels, target)
    values (p_id, p_month, 'level', v_lv, v_s) on conflict do nothing;
  end if;
  select * into r from hub_levels where customer_id = p_id and month = p_month;
  return r;
end $$;
revoke all on function public._hub_level_row(text, text[], date) from public, anon, authenticated;

-- R20: the club's goal for a month, made on its first read. From a year of history on, the same month a year earlier
-- sets the pace (heat and holidays fall alike); before that, the two months before. Null while there is no pace.
create or replace function public._hub_club_row(p_month date)
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_t int; v_n int; v_days int; v_ly date := (p_month - interval '1 year')::date; v_lyn int; v_lyd int;
begin
  select target into v_t from hub_club_goals where month = p_month;
  if found then return v_t; end if;
  v_lyn := _hub_club_n(v_ly, (v_ly + interval '1 month' - interval '1 day')::date);
  select count(distinct s.session_date)::int into v_lyd
    from queue_entries q join sessions s on s.id = q.session_id
   where q.status = 'done' and s.ride_kind = 'saturday'
     and s.session_date >= to_char(v_ly, 'YYYY-MM-DD') and s.session_date <= to_char((v_ly + interval '1 month' - interval '1 day')::date, 'YYYY-MM-DD');
  if coalesce(v_lyd, 0) > 0 and v_lyn >= 10 then
    v_n := v_lyn; v_days := v_lyd;
  else
    v_n := _hub_club_n((p_month - interval '2 months')::date, p_month - 1);
    select count(distinct s.session_date)::int into v_days
      from queue_entries q join sessions s on s.id = q.session_id
     where q.status = 'done' and s.ride_kind = 'saturday'
       and s.session_date >= to_char((p_month - interval '2 months')::date, 'YYYY-MM-DD') and s.session_date < to_char(p_month, 'YYYY-MM-DD');
  end if;
  if coalesce(v_days, 0) = 0 or v_n < 10 then return null; end if;
  v_t := ceil(v_n::numeric / v_days * _hub_sats(p_month) * 1.05)::int;
  if v_t < 10 then return null; end if;
  insert into hub_club_goals (month, target) values (p_month, v_t) on conflict (month) do nothing;
  select target into v_t from hub_club_goals where month = p_month;
  return v_t;
end $$;
revoke all on function public._hub_club_row(date) from public, anon, authenticated;

-- Gives the badges the member has reached and returns the slugs given now (as 20261111100000, with the club target as
-- members see it and a staff challenge counted by _hub_goal_n).
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
     and _hub_club_n(cg.month, (cg.month + interval '1 month' - interval '1 day')::date) >= coalesce(_hub_club_eff(cg.month), 2147483647)
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
  for g in select hg.*, bd.slug from hub_goals hg join badges bd on bd.id = hg.badge_id and not bd.retired
            where hg.starts_on <= v_today loop
    if (g.kind = 'challenge' and _hub_goal_n(p_accts, g.id) >= g.target)
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

-- R13: the Saturday recap, written once per Saturday ride. Counts only; the feed hides any under 10.
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
  on conflict (session_id) where auto do nothing
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public._hub_auto_post(text) from public, anon, authenticated;

-- R1 + R13: the job. Every quarter hour: each active member has this month's challenge; members who rode in the last
-- two days get the badges now due; the recap is written for each Saturday ride closed in the last three days. Twice a
-- day (just after midnight, and Saturday at noon after the ride) every member who rode this month or last is checked,
-- so a club goal reached by others still reaches everyone who rode toward it.
create or replace function public._hub_tick()
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_today date := _ksa_today(); v_month date := date_trunc('month', _ksa_today())::date;
  v_ksa timestamp := now() at time zone 'Asia/Riyadh'; v_wide boolean; v_n int := 0; m record; s record; v_got text[];
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

  for s in select x.id from sessions x
            where x.ride_kind = 'saturday' and x.status = 'closed' and x.cancelled_at is null
              and x.session_date >= to_char(v_today - 3, 'YYYY-MM-DD') and x.session_date <= to_char(v_today, 'YYYY-MM-DD')
              and not exists (select 1 from hub_posts p where p.session_id = x.id and p.auto) loop
    perform _hub_auto_post(s.id);
  end loop;
  return v_n;
end $$;
revoke all on function public._hub_tick() from public, anon, authenticated;

-- ── the tab's one read, with where it was opened from ───────────────────────────────────────────
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
    'year', v_year_doc);
end $$;
revoke all on function public.hub_feed(text, text, text) from public;
grant execute on function public.hub_feed(text, text, text) to anon, authenticated;

-- ── R4: the light read for the whole app ────────────────────────────────────────────────────────
create or replace function public.hub_pulse(p_id text, p_token text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare
  v_today date := _ksa_today();
  v_month date := date_trunc('month', _ksa_today())::date;
  v_end date := (date_trunc('month', _ksa_today()) + interval '1 month' - interval '1 day')::date;
  v_accts text[]; lv hub_levels%rowtype; v_seen timestamptz; v_ids text[]; v_dot boolean;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', true, 'member', false); end if;
  v_accts := _accts_of(p_id);
  lv := _hub_level_row(p_id, v_accts, v_month);
  perform _hub_award(p_id, v_accts);
  v_ids := _hub_badge_ids();
  select tab_at into v_seen from hub_tab_seen where customer_id = p_id;
  v_dot := v_seen is null
    or lv.created_at > v_seen
    or exists (select 1 from customer_badges cb where cb.customer_id = any(v_accts) and cb.badge_id = any(v_ids) and cb.awarded_at > v_seen)
    or exists (select 1 from hub_posts p join queue_entries q on q.session_id = p.session_id
                where not p.hidden and v_today between p.shows_from and p.shows_until and p.created_at > v_seen
                  and q.customer_id = any(v_accts) and q.status = 'done')
    or exists (select 1 from hub_goals g where g.kind = 'challenge' and v_today between g.starts_on and g.ends_on and g.created_at > v_seen);
  return jsonb_build_object('ok', true, 'member', true, 'dot', v_dot,
    'me', jsonb_build_object('kind', lv.kind, 'levels', to_jsonb(lv.levels), 'target', lv.target, 'chosen', lv.chosen,
            'n', _hub_n(v_accts, v_month, v_end, false), 'ends_on', v_end, 'sats', _hub_sats(v_month)),
    'goals', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'name_ar', g.name_ar, 'target', g.target,
               'n', _hub_goal_n(v_accts, g.id), 'ends_on', g.ends_on,
               'badge', case when bd.id is not null then jsonb_build_object('slug', bd.slug, 'icon', bd.icon, 'color', bd.color) end)
               order by g.ends_on)
        from hub_goals g left join badges bd on bd.id = g.badge_id and not bd.retired
       where g.kind = 'challenge' and v_today between g.starts_on and g.ends_on), '[]'::jsonb),
    'fresh', coalesce((
      select jsonb_agg(jsonb_build_object('slug', b.slug, 'at', x.at) order by x.at)
        from (select cb.badge_id, min(cb.awarded_at) as at from customer_badges cb
               where cb.customer_id = any(v_accts) and cb.badge_id = any(v_ids) and cb.seen_at is null
               group by cb.badge_id) x
        join badges b on b.id = x.badge_id), '[]'::jsonb));
end $$;
revoke all on function public.hub_pulse(text, text) from public;
grant execute on function public.hub_pulse(text, text) to anon, authenticated;

-- R1: the member has seen these Community badges (the pop-up showed them).
create or replace function public.hub_seen(p_id text, p_token text, p_slugs text[])
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare n int;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if p_slugs is null or cardinality(p_slugs) = 0 or cardinality(p_slugs) > 40 then return jsonb_build_object('ok', true, 'n', 0); end if;
  update customer_badges cb set seen_at = now()
    from badges b
   where b.id = cb.badge_id and b.slug = any(p_slugs) and cb.badge_id = any(_hub_badge_ids())
     and cb.customer_id = any(_accts_of(p_id)) and cb.seen_at is null;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'n', n);
end $$;
revoke all on function public.hub_seen(text, text, text[]) from public;
grant execute on function public.hub_seen(text, text, text[]) to anon, authenticated;

-- ── R3: the staff numbers, with entry points and a six-week funnel ──────────────────────────────
create or replace function public.staff_hub_numbers(p_month date)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_m date := date_trunc('month', p_month)::date; v_e date := (date_trunc('month', p_month) + interval '1 month' - interval '1 day')::date;
  v_first int; v_back int; v_t int; v_today date := _ksa_today(); v_sat date;
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
  -- the latest Saturday on or before today: weeks run Saturday to Friday
  v_sat := v_today - ((extract(isodow from v_today)::int + 1) % 7);
  return jsonb_build_object('month', v_m,
    'first', v_first, 'back', v_back,
    'openers', (select count(distinct customer_id) from hub_opens where day between v_m and v_e),
    'open_days', (select count(*) from hub_opens where day between v_m and v_e),
    'members', (select count(distinct ct.customer_id) from customer_tags ct where ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at)),
    'challenges', (select count(*) from hub_levels where month = v_m),
    'picked', (select count(*) from hub_levels where month = v_m and chosen),
    'met', (select count(*) from hub_levels h where h.month = v_m
             and _hub_n(_accts_of(h.customer_id), v_m, v_e, false) >= h.target),
    'club_target', v_t, 'club_eff', _hub_club_eff(v_m), 'club_manual', coalesce((select manual from hub_club_goals where month = v_m), false),
    'club_n', _hub_club_n(v_m, v_e),
    'src', (select jsonb_build_object(
              'tab', count(*) filter (where src = 'tab'), 'dot', count(*) filter (where src = 'dot'),
              'rating', count(*) filter (where src = 'rating'), 'booked', count(*) filter (where src = 'booked'),
              'wa', count(*) filter (where src = 'wa'), 'push', count(*) filter (where src = 'push'),
              'badge', count(*) filter (where src = 'badge'), 'link', count(*) filter (where src = 'link'))
              from hub_open_log where (at at time zone 'Asia/Riyadh')::date between v_m and v_e),
    'weeks', (select jsonb_agg(w.doc order by w.f desc) from (
       select f, jsonb_build_object('from', f, 'to', f + 6,
         'openers', (select count(distinct o.customer_id) from hub_opens o where o.day between f and f + 6),
         'booked', (select count(distinct q.customer_id) from queue_entries q join sessions s on s.id = q.session_id
                     where s.ride_kind = 'saturday' and s.status <> 'deleted' and s.session_date = to_char(f, 'YYYY-MM-DD')
                       and q.status <> 'cancelled' and _member_active(q.customer_id)),
         'booked_openers', (select count(distinct q.customer_id) from queue_entries q join sessions s on s.id = q.session_id
                     where s.ride_kind = 'saturday' and s.status <> 'deleted' and s.session_date = to_char(f, 'YYYY-MM-DD')
                       and q.status <> 'cancelled' and _member_active(q.customer_id)
                       and exists (select 1 from hub_opens o where o.customer_id = q.customer_id and o.day between f and f + 6)),
         'back', (select count(distinct o.customer_id) from hub_opens o where o.day between f and f + 6
                   and exists (select 1 from hub_opens o2 where o2.customer_id = o.customer_id and o2.day between f - 7 and f - 1))) as doc
         from (select (v_sat - 7 * i) as f from generate_series(0, 5) i) z) w));
end $$;
revoke all on function public.staff_hub_numbers(date) from public, anon;
grant execute on function public.staff_hub_numbers(date) to authenticated;

-- ── the job, every quarter hour ─────────────────────────────────────────────────────────────────
select cron.schedule('mm-hub-tick', '*/15 * * * *', 'select public._hub_tick()');

insert into supabase_migrations.schema_migrations (version, name)
values ('20261113120000', 'community_reach')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity) as no_rls_0,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('hub_feed', 'hub_pulse', 'hub_seen', 'staff_hub_numbers', '_hub_award', '_hub_level_row', '_hub_club_row',
                         '_hub_club_eff', '_hub_club_lost', '_hub_goal_n', '_hub_badge_ids', '_hub_auto_post', '_hub_tick')) as definer_13,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'hub_feed') as hub_feed_one,
       has_function_privilege('anon', 'public.hub_feed(text,text,text)', 'execute') as anon_feed_true,
       has_function_privilege('anon', 'public.hub_pulse(text,text)', 'execute') as anon_pulse_true,
       has_function_privilege('anon', 'public._hub_tick()', 'execute') as anon_tick_false,
       (select count(*) from cron.job where jobname = 'mm-hub-tick') as cron_1,
       (select count(*) from public.customer_badges where seen_at is null) as unseen_0,
       (select ramadan_any from public.hub_goals where id = 'goal_cool_season_2026') as season_ramadan_true,
       (select version from supabase_migrations.schema_migrations where version = '20261113120000') as ledger;
