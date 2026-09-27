-- ============================================================================
-- Routes on rides, the live ride map, the members' area and the ambassador's own card (2026-09-28).
--
--  1. sessions.route_slug - the route a ride follows (the Routes page's list, site_content
--     routes.routes.items, each item with a slug); the card, the pass and the website name it.
--  2. live_positions - where the ride leader (and the sweeper) is during a ride: one row per
--     session and role, written by staff through staff_live_position every few seconds while
--     they share their location, removed by staff_live_stop or read as stale after ten minutes.
--     live_positions_for hands the rows to a rider with a live booking on that session (id and
--     session token), and to staff. Nobody else reads the table.
--  3. member_area(p_id, p_token) - what a signed-in community member sees on the website's
--     members' area: membership and since when, credits and tier (the Club's rules), rides done
--     and the last five, the upcoming members' rides, their own birthday, and the announcements.
--     Members never see each other here.
--  4. ambassador_mine(p_id, p_token) - the ambassador card for the signed-in account (matched by
--     customer id, else by phone), the same shape ambassador_portal gives the website.
--
-- Rollback:
--   drop function if exists public.ambassador_mine(text, text);
--   drop function if exists public.member_area(text, text);
--   drop function if exists public.live_positions_for(text, text, text);
--   drop function if exists public.staff_live_stop(text, text);
--   drop function if exists public.staff_live_position(text, text, double precision, double precision, real, real);
--   drop table if exists public.live_positions;
--   alter table public.sessions drop column if exists route_slug;
-- Idempotent.
-- ============================================================================
alter table public.sessions add column if not exists route_slug text;

create table if not exists public.live_positions (
  session_id text not null,
  role       text not null check (role in ('leader','sweeper')),
  lat        double precision not null,
  lng        double precision not null,
  heading    real,
  speed      real,
  at         timestamptz not null default now(),
  by         text,
  primary key (session_id, role)
);
alter table public.live_positions enable row level security;
drop policy if exists "live staff read" on public.live_positions;
create policy "live staff read" on public.live_positions for select to authenticated using ((select public.is_staff()));
revoke all on public.live_positions from anon, authenticated;
grant select on public.live_positions to authenticated;

create or replace function public.staff_live_position(p_session_id text, p_role text, p_lat double precision, p_lng double precision, p_heading real default null, p_speed real default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_role not in ('leader','sweeper') then raise exception 'ROLE' using errcode = '22023'; end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 90 or abs(p_lng) > 180 then raise exception 'POSITION' using errcode = '22023'; end if;
  if not exists (select 1 from sessions s where s.id = p_session_id) then raise exception 'NO_SESSION' using errcode = 'P0002'; end if;
  insert into live_positions (session_id, role, lat, lng, heading, speed, at, by)
    values (p_session_id, p_role, p_lat, p_lng, p_heading, p_speed, now(), coalesce(auth.jwt()->>'email', ''))
  on conflict (session_id, role) do update
    set lat = excluded.lat, lng = excluded.lng, heading = excluded.heading, speed = excluded.speed, at = now(), by = excluded.by;
  return jsonb_build_object('ok', true, 'at', now());
end $$;
revoke all on function public.staff_live_position(text, text, double precision, double precision, real, real) from public, anon;
grant execute on function public.staff_live_position(text, text, double precision, double precision, real, real) to authenticated;

create or replace function public.staff_live_stop(p_session_id text, p_role text)
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  delete from live_positions where session_id = p_session_id and (p_role is null or role = p_role);
  return true;
end $$;
revoke all on function public.staff_live_stop(text, text) from public, anon;
grant execute on function public.staff_live_stop(text, text) to authenticated;

-- A rider with a live booking on the ride (or staff) reads where the leader is: rows from the
-- last ten minutes only, so a phone that stopped sharing does not leave a dot behind.
create or replace function public.live_positions_for(p_session_id text, p_id text default null, p_token text default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare v jsonb;
begin
  if not is_staff() then
    if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
    if not exists (select 1 from queue_entries q where q.session_id = p_session_id and q.customer_id = p_id and q.status in ('waiting','waitlist','active','done')) then
      return jsonb_build_object('ok', false, 'error', 'not_booked');
    end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('role', l.role, 'lat', l.lat, 'lng', l.lng, 'heading', l.heading, 'speed', l.speed, 'at', l.at) order by l.role), '[]'::jsonb)
    into v from live_positions l where l.session_id = p_session_id and l.at > now() - interval '10 minutes';
  return jsonb_build_object('ok', true, 'positions', v, 'now', now());
end $$;
revoke all on function public.live_positions_for(text, text, text) from public;
grant execute on function public.live_positions_for(text, text, text) to anon, authenticated;

create or replace function public.member_area(p_id text, p_token text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
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
             'booked', exists (select 1 from queue_entries q where q.session_id = s.id and q.customer_id = p_id and q.status in ('waiting','waitlist','active'))) as x
      from sessions s
     where s.event_kind = 'community' and s.status in ('open','full') and coalesce(s.ride_kind, '') <> 'petromin'
       and s.session_date >= v_today order by s.session_date limit 8) t;
  select value into v_ann from site_content where key = 'site.announce.messages';
  return jsonb_build_object('ok', true, 'member', true, 'first_name', split_part(coalesce(c.name,''), ' ', 1),
    'since', case when v_since is not null then to_timestamp(v_since / 1000.0) end,
    'credits', v_credits, 'tier', v_tier, 'next', case v_tier when 0 then v_pro when 1 then v_leg end,
    'rides', v_rides, 'group_rides', v_group, 'last', v_last, 'upcoming', v_next,
    'birth_date', c.birth_date, 'announcements', coalesce(v_ann, '[]'::jsonb));
end $$;
revoke all on function public.member_area(text, text) from public;
grant execute on function public.member_area(text, text) to anon, authenticated;

create or replace function public.ambassador_mine(p_id text, p_token text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare a ambassadors%rowtype; c customers%rowtype; v_digits text; v_ev jsonb; v_red jsonb;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select * into c from customers where id = p_id;
  v_digits := right(regexp_replace(coalesce(c.phone,''), '\D', '', 'g'), 9);
  select * into a from ambassadors
   where status in ('active','paused')
     and (customer_id = p_id or (length(v_digits) >= 9 and right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 9) = v_digits))
   order by (customer_id = p_id) desc, id limit 1;
  if a.id is null then return jsonb_build_object('ok', true, 'ambassador', false); end if;
  select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'context', e.context, 'points', e.points, 'status', e.status) order by e.at desc), '[]'::jsonb)
    into v_ev from (select * from _amb_events(a.code) order by at desc limit 12) e;
  select coalesce(jsonb_agg(jsonb_build_object('at', r.created_at, 'item', r.item, 'points', r.points, 'status', r.status) order by r.created_at desc), '[]'::jsonb)
    into v_red from (select * from ambassador_redemptions where ambassador_id = a.id and status <> 'cancelled' order by created_at desc limit 10) r;
  return jsonb_build_object('ok', true, 'ambassador', true, 'first_name', split_part(a.name, ' ', 1), 'code', a.code, 'status', a.status)
    || _amb_summary(a.id) || jsonb_build_object('events', v_ev, 'redemptions', v_red);
end $$;
revoke all on function public.ambassador_mine(text, text) from public;
grant execute on function public.ambassador_mine(text, text) to anon, authenticated;
