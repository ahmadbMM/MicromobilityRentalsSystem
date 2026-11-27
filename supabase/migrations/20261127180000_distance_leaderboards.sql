-- The distance leaderboards (the user, 2026-11-27: "create a new leaderboard badge that has the longest distance in one
-- ride, and let me put the longest distance in one ride and give badges depending on the longest distances to people and
-- put a leaderboard in the website and app for it and allow people to share them on social media apps ... change the
-- badge if someone surpassed the account badge holder so its dynamic"; then "add a leaderboard for distance lifetime and
-- distance year to date and let customers apply to it manually by add image or pdf that proves it and staff approves it").
--
-- The user's picks the same day: staff enter a rider's own distance and riders claim one with a proof that staff approve,
-- any ride anywhere; men and women apart, members only; a rider's name shows only after they switch it on; Gold, Silver
-- and Bronze go to each gender's top three longest MEASURED single rides (a distance staff typed or approved: the session
-- distances tie dozens of riders at 40 km) and move as soon as someone rides further; a share picture with a link.
--
-- Four boards (p_board):
--   longest   the longest single ride, ever          month     the longest single ride this month (Riyadh)
--   lifetime  every kilometre added up, ever         year      every kilometre added up since 1 January (Riyadh)
-- What counts:
--   * every bike session the rider finished (queue_entries status done, paid, free or on their own bike), once a session:
--     a Saturday ride is its group's distance (bike_slots._km.beg / .int, else 20 km Beginners and 40 km Intermediates),
--     any other bike ride the distance staff set on it (bike_slots._km.all), none without one (the app's _rideKm);
--   * every approved row of ride_distances: kind 'ride' is one ride on ride_date (all four boards); kind 'total' is a
--     total over date_from..ride_date, e.g. a Strava year summary (lifetime, and year when it starts this year).
-- Riders with equal distances share a rank (rank()); the list shows them in the order they got there.
--
--  1. customers.board_public (+ board_public_at): the rider's switch, off for everyone. Only with it on does a board show
--     their first name and the first letter of their last name; off, the row is "Member" on the page.
--  2. ride_distances: staff-only (RLS; staff read, editors change and delete; nobody inserts directly). The proof (a
--     picture or a PDF as a data: URL, as badge_requests) is dropped the moment staff answer (_ride_dist_drop_proof).
--  3. _lr_rides() / _lr_board(p_board): every counted distance / each eligible member's figure and rank on a board.
--     Eligible: not merged into another account, not archived, no deletion asked, an active member, male or female.
--  4. distance_board(p_board, p_gender, p_id, p_token): anon may read. The top 50 as {r, km, name, medal, mine}, name only
--     for a rider whose switch is on, medal (1-3) on the longest board for a podium holder; with a valid token also `me`.
--     Nothing else about anyone: no count of riders, no dates.
--  5. customer_distances(p_id, p_token): the caller's own best, lifetime, year, switch, medal and claims.
--     customer_distance_claim(...): one ride (1 to 300 km, a day up to today in the last five years) or a total (1 to
--     50,000 km over two days in that window); a proof required; three waiting at most.
--     customer_distance_withdraw(...): takes back a waiting claim. customer_board_public(p_id, p_token, p_on): the switch.
--  6. staff_distance_add / staff_distance_answer / staff_distance_remove (People and Community editors) and
--     staff_distance_board (the view right): full names, members only or every account.
--  7. Badges lr_gold / lr_silver / lr_bronze (Longest Ride Gold / Silver / Bronze), held only, automatic.
--     _lr_podium_sync() gives them to each gender's top three measured single rides (ties: the earlier ride) and takes
--     them from anyone who left it, with an Updates row (push_words 'lrtop' / 'lrpassed'); it runs after every write here
--     and every 15 minutes (mm-long-ride: membership changes move the podium too). _lr_clubs(p_cid): a measured ride also
--     brings the 20 / 40 / 70 / 100 km Club rows it reaches (awarded_by 'distance'), taken back if that ride goes.
--
-- The app works before this runs: without distance_board the Leaderboard part does not show.
--
-- Rollback:
--   select cron.unschedule('mm-long-ride');
--   delete from public.customer_badges where badge_id in ('bd_lr_gold', 'bd_lr_silver', 'bd_lr_bronze')
--      or (awarded_by = 'distance' and badge_id in ('bd_km20', 'bd_km40', 'bd_km70', 'bd_km100'));
--   delete from public.badges where id in ('bd_lr_gold', 'bd_lr_silver', 'bd_lr_bronze');
--   delete from public.push_words where key in ('lrtop', 'lrpassed');
--   drop function if exists public.distance_board(text, text, text, text), public.customer_distances(text, text),
--     public.customer_distance_claim(text, text, text, numeric, date, date, text, text, text),
--     public.customer_distance_withdraw(text, text, bigint), public.customer_board_public(text, text, boolean),
--     public.staff_distance_add(text, text, numeric, date, date, text, text), public.staff_distance_answer(bigint, boolean, numeric, text),
--     public.staff_distance_remove(bigint), public.staff_distance_board(text, text, boolean), public._lr_podium_sync(),
--     public._lr_podium(), public._lr_clubs(text), public._lr_board(text), public._lr_rides(), public._lr_name(text),
--     public._ride_dist_drop_proof();
--   drop table if exists public.ride_distances;
--   alter table public.customers drop column if exists board_public, drop column if exists board_public_at;

begin;
set local lock_timeout = '5s';

do $pre$
begin
  if to_regclass('public.push_words') is null or to_regprocedure('public._push_text(text, text, text[])') is null
     or to_regprocedure('public._member_active(text)') is null or to_regprocedure('public._cust_token_ok(text, text)') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'badges' and column_name = 'held_only') then
    raise exception 'this needs push_words, _push_text, _member_active, _cust_token_ok and badges.held_only';
  end if;
end $pre$;


/* -- 1. the rider's switch ---------------------------------------------------------------------------- */
alter table public.customers add column if not exists board_public boolean not null default false;
alter table public.customers add column if not exists board_public_at timestamptz;
comment on column public.customers.board_public is
  'The rider''s own switch: show my first name and last initial on the distance leaderboards (20261127180000). Off by default.';


/* -- 2. the distances ---------------------------------------------------------------------------------- */
create table if not exists public.ride_distances (
  id          bigint generated always as identity primary key,
  customer_id text not null references public.customers (id) on delete cascade,
  kind        text not null default 'ride',
  km          numeric(7, 1) not null,
  date_from   date,
  ride_date   date not null,
  session_id  text references public.sessions (id) on delete set null,
  source      text not null,
  status      text not null default 'pending',
  note        text,
  proof       text,
  proof_kind  text,
  proof_name  text,
  created_at  timestamptz not null default now(),
  created_by  text,
  decided_at  timestamptz,
  decided_by  text,
  reply       text,
  constraint ride_distances_kind_chk check ((kind = 'ride' and km >= 1 and km <= 300 and date_from is null)
    or (kind = 'total' and km >= 1 and km <= 50000 and date_from is not null and date_from <= ride_date)),
  constraint ride_distances_source_chk check (source in ('staff', 'claim')),
  constraint ride_distances_status_chk check (status in ('pending', 'approved', 'declined')),
  constraint ride_distances_note_chk check (note is null or char_length(note) <= 300),
  constraint ride_distances_proof_chk check (proof is null
    or (proof ~ '^data:(image/(jpeg|png|webp)|application/pdf);base64,' and length(proof) <= 3000000)),
  constraint ride_distances_pkind_chk check (proof_kind is null or proof_kind in ('image', 'pdf')),
  constraint ride_distances_name_chk check (proof_name is null or char_length(proof_name) <= 120),
  constraint ride_distances_by_chk check ((created_by is null or char_length(created_by) <= 60) and (decided_by is null or char_length(decided_by) <= 60)),
  constraint ride_distances_reply_chk check (reply is null or char_length(reply) <= 140)
);
comment on table public.ride_distances is
  'A rider''s own distance: one ride or a total over dates, typed by staff or claimed by the rider with a proof and approved by staff. The distance leaderboards read the approved rows (20261127180000).';
create index if not exists ride_distances_cust_idx on public.ride_distances (customer_id);
create index if not exists ride_distances_status_idx on public.ride_distances (status, created_at desc);

alter table public.ride_distances enable row level security;
revoke all on public.ride_distances from public, anon, authenticated;
grant select, update, delete on public.ride_distances to authenticated;
drop policy if exists ride_distances_staff_read on public.ride_distances;
create policy ride_distances_staff_read on public.ride_distances for select to authenticated using ((select is_staff()));
drop policy if exists ride_distances_staff_update on public.ride_distances;
create policy ride_distances_staff_update on public.ride_distances for update to authenticated
  using ((select _staff_mod('community', true))) with check ((select _staff_mod('community', true)));
drop policy if exists ride_distances_staff_delete on public.ride_distances;
create policy ride_distances_staff_delete on public.ride_distances for delete to authenticated using ((select _staff_mod('community', true)));

-- a proof is kept only while staff have not answered
create or replace function public._ride_dist_drop_proof()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if new.status <> 'pending' then new.proof := null; end if;
  return new;
end $function$;
revoke all on function public._ride_dist_drop_proof() from public, anon, authenticated;
drop trigger if exists ride_distances_drop_proof on public.ride_distances;
create trigger ride_distances_drop_proof before insert or update on public.ride_distances
  for each row execute function public._ride_dist_drop_proof();


/* -- 3. every distance, and each member's place ----------------------------------------------------------- */
-- One row per finished bike session (per account it belongs to now) and per approved entry. kind 'ride' or 'total';
-- d is the ride's day (a total's last day), d0 a total's first day; src 'session' or 'entry'.
create or replace function public._lr_rides()
 returns table (cid text, km numeric, d date, d0 date, src text, kind text)
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  with b as (
    select distinct on (coalesce(c.merged_into, c.id), s.id)
           coalesce(c.merged_into, c.id) as cid, left(s.session_date, 10) as d, s.ride_kind, q.ride_group,
           case when coalesce(nullif(s.bike_slots, ''), '') ~ '^\s*\{' then nullif(s.bike_slots, '')::jsonb -> '_km' end as k
      from queue_entries q
      join sessions s on s.id = q.session_id
      join customers c on c.id = q.customer_id
     where q.status = 'done'
       and (q.paid or q.type_preference = 'Own' or coalesce(q.price, 0) = 0)
       and coalesce(s.ride_kind, 'rental') not in ('swim', 'workshop', 'event', 'runher', 'vlap', 'arena', 'defe5k',
                                                   'blood', 'yoga', 'ktri', 'paint')
       and left(s.session_date, 10) ~ '^\d{4}-\d{2}-\d{2}$'
     order by coalesce(c.merged_into, c.id), s.id, (q.ride_group = 'int') desc),
  k as (
    select b.cid, b.d::date as d,
           case when b.ride_kind = 'saturday' then
                  coalesce(case when (b.k ->> (case when b.ride_group = 'int' then 'int' else 'beg' end)) ~ '^\d+(\.\d+)?$'
                                then nullif((b.k ->> (case when b.ride_group = 'int' then 'int' else 'beg' end))::numeric, 0) end,
                           case when b.ride_group = 'int' then 40 else 20 end)
                else case when (b.k ->> 'all') ~ '^\d+(\.\d+)?$' then nullif((b.k ->> 'all')::numeric, 0) end end as km
      from b)
  select k.cid, k.km, k.d, null::date, 'session', 'ride' from k where k.km > 0 and k.km <= 500
  union all
  select coalesce(c.merged_into, c.id), r.km, r.ride_date, r.date_from, 'entry', r.kind
    from ride_distances r join customers c on c.id = r.customer_id
   where r.status = 'approved';
$function$;
revoke all on function public._lr_rides() from public, anon, authenticated;

-- Each eligible member's figure on a board: km, d (the day they first rode that far on longest/month, their last counted
-- day on lifetime/year), gender and r, the rank among their gender (equal figures share it).
create or replace function public._lr_board(p_board text)
 returns table (cid text, km numeric, d date, gender text, r bigint)
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_today date := _ksa_today();
  v_m date := date_trunc('month', _ksa_today())::date;
  v_y date := date_trunc('year', _ksa_today())::date;
begin
  return query
  with x as (
    select distinct on (rr.cid) rr.cid, rr.km, rr.d
      from _lr_rides() rr
     where p_board in ('longest', 'month') and rr.kind = 'ride'
       and (p_board = 'longest' or (rr.d >= v_m and rr.d <= v_today))
     order by rr.cid, rr.km desc, rr.d asc),
  s as (
    select rr.cid, sum(rr.km) as km, max(rr.d) as d
      from _lr_rides() rr
     where p_board in ('lifetime', 'year')
       and (p_board = 'lifetime' or (rr.d >= v_y and rr.d <= v_today and (rr.kind = 'ride' or rr.d0 >= v_y)))
     group by rr.cid),
  a as (select * from x union all select * from s)
  select a.cid, round(a.km, 1), a.d, c.gender, rank() over (partition by c.gender order by round(a.km, 1) desc)
    from a join customers c on c.id = a.cid
   where a.km > 0 and c.merged_into is null and c.archived_at is null and c.deletion_requested_at is null
     and c.gender in ('male', 'female')
     and _member_active(a.cid);
end $function$;
revoke all on function public._lr_board(text) from public, anon, authenticated;

-- The podium: each gender's three longest measured single rides (staff typed or approved), the earlier ride first on a tie.
create or replace function public._lr_podium()
 returns table (cid text, km numeric, gender text, slot bigint)
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  with x as (
    select distinct on (rr.cid) rr.cid, rr.km, rr.d
      from _lr_rides() rr
     where rr.src = 'entry' and rr.kind = 'ride'
     order by rr.cid, rr.km desc, rr.d asc),
  y as (
    select x.cid, x.km, c.gender, row_number() over (partition by c.gender order by x.km desc, x.d asc, x.cid) as slot
      from x join customers c on c.id = x.cid
     where c.merged_into is null and c.archived_at is null and c.deletion_requested_at is null
       and c.gender in ('male', 'female') and _member_active(x.cid))
  select y.cid, y.km, y.gender, y.slot from y where y.slot <= 3;
$function$;
revoke all on function public._lr_podium() from public, anon, authenticated;

-- "Sara A.": the first name and the first letter of the last, dashes read as spaces (names carry no dashes).
create or replace function public._lr_name(p_name text)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$
  with w as (select regexp_split_to_array(btrim(regexp_replace(coalesce(p_name, ''), '[-_\s]+', ' ', 'g')), ' ') as a)
  select case when coalesce(w.a[1], '') = '' then null
              when array_length(w.a, 1) > 1 then left(w.a[1], 24) || ' ' || upper(left(w.a[array_length(w.a, 1)], 1)) || '.'
              else left(w.a[1], 24) end
    from w;
$function$;
revoke all on function public._lr_name(text) from public, anon, authenticated;


/* -- 4. the boards ------------------------------------------------------------------------------------------ */
create or replace function public.distance_board(p_board text default 'longest', p_gender text default 'male',
  p_id text default null, p_token text default null)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_b text := case when p_board in ('longest', 'month', 'lifetime', 'year') then p_board else 'longest' end;
  v_g text := case when p_gender = 'female' then 'female' else 'male' end;
  v_me text; v_rows jsonb; v_mine jsonb; c record;
begin
  if p_id is not null and p_token is not null and _cust_token_ok(p_id, p_token) then
    v_me := coalesce((select merged_into from customers where id = p_id), p_id);
  end if;
  with b as (select * from _lr_board(v_b) x where x.gender = v_g),
  o as (select b.*, row_number() over (order by b.r, b.d, b.cid) as n from b)
  select coalesce(jsonb_agg(jsonb_build_object('r', o.r, 'km', o.km,
                    'name', case when cu.board_public then _lr_name(cu.name) end,
                    'medal', case when v_b = 'longest' then
                               (select case cb.badge_id when 'bd_lr_gold' then 1 when 'bd_lr_silver' then 2 else 3 end
                                  from customer_badges cb
                                 where cb.customer_id = o.cid and cb.badge_id in ('bd_lr_gold', 'bd_lr_silver', 'bd_lr_bronze')
                                 limit 1) end,
                    'mine', coalesce(o.cid = v_me, false)) order by o.n) filter (where o.n <= 50), '[]'::jsonb),
         (array_agg(jsonb_build_object('r', o.r, 'km', o.km)) filter (where o.cid = v_me))[1]
    into v_rows, v_mine
    from o join customers cu on cu.id = o.cid;
  if v_me is not null then
    select * into c from customers where id = v_me;
    return jsonb_build_object('ok', true, 'board', v_b, 'gender', v_g, 'rows', v_rows,
      'me', coalesce(v_mine, '{}'::jsonb) || jsonb_build_object('public', coalesce(c.board_public, false),
              'member', _member_active(v_me), 'gender', c.gender));
  end if;
  return jsonb_build_object('ok', true, 'board', v_b, 'gender', v_g, 'rows', v_rows);
end $function$;
revoke all on function public.distance_board(text, text, text, text) from public;
grant execute on function public.distance_board(text, text, text, text) to anon, authenticated;


/* -- 5. the rider's own --------------------------------------------------------------------------------- */
create or replace function public.customer_distances(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare v_me text; v_best record; v_life numeric; v_year numeric; v_pub boolean; v_medal int;
  v_y date := date_trunc('year', _ksa_today())::date;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'token'); end if;
  v_me := coalesce((select merged_into from customers where id = p_id), p_id);
  select rr.km, rr.d into v_best from _lr_rides() rr where rr.cid = v_me and rr.kind = 'ride' order by rr.km desc, rr.d asc limit 1;
  select round(sum(rr.km), 1),
         round(sum(rr.km) filter (where rr.d >= v_y and rr.d <= _ksa_today() and (rr.kind = 'ride' or rr.d0 >= v_y)), 1)
    into v_life, v_year
    from _lr_rides() rr where rr.cid = v_me;
  select board_public into v_pub from customers where id = v_me;
  select case cb.badge_id when 'bd_lr_gold' then 1 when 'bd_lr_silver' then 2 else 3 end into v_medal
    from customer_badges cb where cb.customer_id = v_me and cb.badge_id in ('bd_lr_gold', 'bd_lr_silver', 'bd_lr_bronze') limit 1;
  return jsonb_build_object('ok', true, 'best', v_best.km, 'at', v_best.d, 'lifetime', coalesce(v_life, 0),
    'year', coalesce(v_year, 0), 'public', coalesce(v_pub, false), 'member', _member_active(v_me), 'medal', v_medal,
    'claims', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'km', r.km, 'd', r.ride_date, 'from', r.date_from,
               'status', r.status, 'source', r.source, 'reply', r.reply, 'at', r.created_at) order by r.created_at desc)
        from ride_distances r join customers c on c.id = r.customer_id
       where (c.id = v_me or c.merged_into = v_me)
         and (r.status = 'pending' or r.source = 'staff' or r.decided_at > now() - interval '90 days')), '[]'::jsonb));
end $function$;
revoke all on function public.customer_distances(text, text) from public;
grant execute on function public.customer_distances(text, text) to anon, authenticated;

create or replace function public.customer_distance_claim(p_id text, p_token text, p_kind text, p_km numeric, p_date date,
  p_from date default null, p_note text default null, p_proof text default null, p_proof_name text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_me text;
  v_kind text := case when p_kind = 'total' then 'total' else 'ride' end;
  v_km numeric := round(coalesce(p_km, 0), 1);
  v_note text := left(nullif(btrim(coalesce(p_note, '')), ''), 300);
  v_p text := nullif(btrim(coalesce(p_proof, '')), '');
  v_n text := left(nullif(btrim(regexp_replace(coalesce(p_proof_name, ''), '[[:cntrl:]]', '', 'g')), ''), 120);
  v_low date := (_ksa_today() - interval '5 years')::date;
  v_k text; v_id bigint;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'token'); end if;
  v_me := coalesce((select merged_into from customers where id = p_id), p_id);
  if v_km < 1 or v_km > (case when v_kind = 'ride' then 300 else 50000 end) then return jsonb_build_object('ok', false, 'error', 'km'); end if;
  if p_date is null or p_date > _ksa_today() or p_date < v_low
     or (v_kind = 'total' and (p_from is null or p_from > p_date or p_from < v_low)) then
    return jsonb_build_object('ok', false, 'error', 'date');
  end if;
  if v_p is null or length(v_p) > 3000000 then return jsonb_build_object('ok', false, 'error', 'proof');
  elsif v_p ~ '^data:image/(jpeg|png|webp);base64,' then v_k := 'image';
  elsif v_p ~ '^data:application/pdf;base64,' then v_k := 'pdf';
  else return jsonb_build_object('ok', false, 'error', 'proof');
  end if;
  if (select count(*) from ride_distances r join customers c on c.id = r.customer_id
       where (c.id = v_me or c.merged_into = v_me) and r.status = 'pending') >= 3 then
    return jsonb_build_object('ok', false, 'error', 'limit');
  end if;
  insert into ride_distances (customer_id, kind, km, date_from, ride_date, source, status, note, proof, proof_kind, proof_name, created_by)
  values (v_me, v_kind, v_km, case when v_kind = 'total' then p_from end, p_date, 'claim', 'pending', v_note, v_p, v_k, v_n, 'rider')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;
revoke all on function public.customer_distance_claim(text, text, text, numeric, date, date, text, text, text) from public;
grant execute on function public.customer_distance_claim(text, text, text, numeric, date, date, text, text, text) to anon, authenticated;

create or replace function public.customer_distance_withdraw(p_id text, p_token text, p_claim bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_me text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'token'); end if;
  v_me := coalesce((select merged_into from customers where id = p_id), p_id);
  delete from ride_distances r using customers c
   where r.id = p_claim and c.id = r.customer_id and (c.id = v_me or c.merged_into = v_me)
     and r.status = 'pending' and r.source = 'claim';
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.customer_distance_withdraw(text, text, bigint) from public;
grant execute on function public.customer_distance_withdraw(text, text, bigint) to anon, authenticated;

create or replace function public.customer_board_public(p_id text, p_token text, p_on boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_me text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'token'); end if;
  v_me := coalesce((select merged_into from customers where id = p_id), p_id);
  update customers set board_public = coalesce(p_on, false), board_public_at = now() where id = v_me;
  return jsonb_build_object('ok', true, 'public', coalesce(p_on, false));
end $function$;
revoke all on function public.customer_board_public(text, text, boolean) from public;
grant execute on function public.customer_board_public(text, text, boolean) to anon, authenticated;


/* -- 7. the badges (before the staff functions, which move them) ----------------------------------------- */
insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort, held_only) values
  ('bd_lr_gold', 'lr_gold', 'lr1', 'gold', 'Longest Ride Gold', 'أطول رحلة: الذهبية',
   'The longest measured single ride of all members (men and women apart); moves when someone rides further',
   'أطول رحلة واحدة مسجلة بين جميع الأعضاء (الرجال والنساء كل على حدة)؛ تنتقل حين يقطع أحد مسافة أطول', true, true, 259, true),
  ('bd_lr_silver', 'lr_silver', 'lr2', 'silver', 'Longest Ride Silver', 'أطول رحلة: الفضية',
   'The second longest measured single ride of all members (men and women apart); moves when someone rides further',
   'ثاني أطول رحلة واحدة مسجلة بين جميع الأعضاء (الرجال والنساء كل على حدة)؛ تنتقل حين يقطع أحد مسافة أطول', true, true, 260, true),
  ('bd_lr_bronze', 'lr_bronze', 'lr3', 'orange', 'Longest Ride Bronze', 'أطول رحلة: البرونزية',
   'The third longest measured single ride of all members (men and women apart); moves when someone rides further',
   'ثالث أطول رحلة واحدة مسجلة بين جميع الأعضاء (الرجال والنساء كل على حدة)؛ تنتقل حين يقطع أحد مسافة أطول', true, true, 261, true)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true,
  retired = false, sort = excluded.sort, held_only = true;

-- {0} is the place (1, 2 or 3), {1} the distance in km.
insert into public.push_words (key, lang, title, body) values
  ('lrtop', 'en', 'Longest ride: you are #{0}', 'Your {1} km ride puts you on the podium. Share it from the Leaderboard.'),
  ('lrtop', 'ar', 'أطول رحلة: أنت رقم {0}', 'رحلتك بطول {1} كم تضعك على منصة التتويج. شاركها من لوحة المتصدرين.'),
  ('lrtop', 'fr', 'Plus longue sortie : vous êtes n° {0}', 'Votre sortie de {1} km vous place sur le podium. Partagez-la depuis le classement.'),
  ('lrtop', 'es', 'Ruta más larga: eres el n.º {0}', 'Tu ruta de {1} km te sube al podio. Compártela desde la clasificación.'),
  ('lrtop', 'pt', 'Pedalada mais longa: você é o n.º {0}', 'A sua pedalada de {1} km coloca você no pódio. Partilhe-a na classificação.'),
  ('lrtop', 'ur', 'سب سے لمبی سواری: آپ نمبر {0} ہیں', 'آپ کی {1} کلومیٹر کی سواری آپ کو پوڈیم پر لے آئی۔ لیڈر بورڈ سے شیئر کریں۔'),
  ('lrtop', 'hi', 'सबसे लंबी सवारी: आप नंबर {0} हैं', 'आपकी {1} किमी की सवारी आपको पोडियम पर ले आई। लीडरबोर्ड से शेयर करें।'),
  ('lrtop', 'tl', 'Pinakamahabang biyahe: ikaw ang #{0}', 'Ang {1} km mong biyahe ang naglagay sa iyo sa podium. I-share ito mula sa Leaderboard.'),
  ('lrtop', 'ne', 'सबैभन्दा लामो सवारी: तपाईं नम्बर {0}', 'तपाईंको {1} किमीको सवारीले तपाईंलाई पोडियममा पुर्‍यायो। लिडरबोर्डबाट सेयर गर्नुहोस्।'),
  ('lrtop', 'bn', 'দীর্ঘতম রাইড: আপনি {0} নম্বরে', 'আপনার {1} কিমি রাইড আপনাকে পোডিয়ামে এনেছে। লিডারবোর্ড থেকে শেয়ার করুন।'),
  ('lrtop', 'ms', 'Kayuhan terpanjang: anda #{0}', 'Kayuhan {1} km anda membawa anda ke podium. Kongsikan dari Papan Pendahulu.'),
  ('lrpassed', 'en', 'Your longest ride place was passed', 'Another member rode further. Ride longer to take your place back.'),
  ('lrpassed', 'ar', 'تجاوز أحدهم مركزك في أطول رحلة', 'قطع عضو آخر مسافة أطول. اركب مسافة أطول لتستعيد مركزك.'),
  ('lrpassed', 'fr', 'Votre place de plus longue sortie a été prise', 'Un autre membre a roulé plus loin. Roulez plus longtemps pour la reprendre.'),
  ('lrpassed', 'es', 'Te han superado en la ruta más larga', 'Otro miembro ha rodado más lejos. Rueda más para recuperar tu puesto.'),
  ('lrpassed', 'pt', 'Passaram o seu lugar na pedalada mais longa', 'Outro membro pedalou mais longe. Pedale mais para recuperar o seu lugar.'),
  ('lrpassed', 'ur', 'سب سے لمبی سواری میں آپ کی جگہ لے لی گئی', 'ایک اور رکن نے زیادہ فاصلہ طے کیا۔ اپنی جگہ واپس لینے کے لیے لمبی سواری کریں۔'),
  ('lrpassed', 'hi', 'सबसे लंबी सवारी में आपका स्थान किसी ने ले लिया', 'किसी और सदस्य ने ज़्यादा दूरी तय की। अपना स्थान वापस पाने के लिए लंबी सवारी करें।'),
  ('lrpassed', 'tl', 'Nalampasan ang puwesto mo sa pinakamahabang biyahe', 'May ibang miyembrong mas malayo ang narating. Bumiyahe nang mas mahaba para mabawi ito.'),
  ('lrpassed', 'ne', 'सबैभन्दा लामो सवारीमा तपाईंको स्थान कसैले लियो', 'अर्को सदस्यले बढी दूरी पार गर्नुभयो। आफ्नो स्थान फिर्ता लिन लामो सवारी गर्नुहोस्।'),
  ('lrpassed', 'bn', 'দীর্ঘতম রাইডে আপনার স্থান কেউ নিয়েছে', 'অন্য একজন সদস্য আরও বেশি দূরত্ব চালিয়েছেন। স্থান ফিরে পেতে আরও লম্বা রাইড করুন।'),
  ('lrpassed', 'ms', 'Tempat kayuhan terpanjang anda telah dipintas', 'Ahli lain mengayuh lebih jauh. Kayuh lebih panjang untuk merebut kembali tempat anda.')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- Gold, Silver and Bronze follow _lr_podium(), moved the moment the order changes.
create or replace function public._lr_podium_sync()
 returns integer
 language plpgsql
 volatile
 security definer
 set search_path to 'public'
as $function$
declare
  v_n int := 0; b record; t record; v_had text[]; v_km text;
  v_ids text[] := array['bd_lr_gold', 'bd_lr_silver', 'bd_lr_bronze'];
  v_stamp text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');
begin
  create temporary table if not exists _lr_top (cid text, km numeric, gender text, slot bigint) on commit drop;
  truncate _lr_top;
  insert into _lr_top select * from _lr_podium();
  select coalesce(array_agg(distinct cb.customer_id), '{}') into v_had from customer_badges cb where cb.badge_id = any(v_ids);

  -- a holder who no longer holds that place loses that badge
  delete from customer_badges cb
   where cb.badge_id = any(v_ids)
     and not exists (select 1 from _lr_top x where x.cid = cb.customer_id and v_ids[x.slot] = cb.badge_id);

  -- every place gets its holder, who is told
  for b in select x.cid, x.km, x.slot from _lr_top x order by x.gender, x.slot loop
    v_km := trim(trailing '.' from trim(trailing '0' from to_char(b.km, 'FM99990.0')));
    insert into customer_badges (customer_id, badge_id, note, awarded_by)
    values (b.cid, v_ids[b.slot], left('Longest single ride ' || v_km || ' km', 140), 'record')
    on conflict (customer_id, badge_id) do nothing;
    if found then
      v_n := v_n + 1;
      select * into t from _push_text(b.cid, 'lrtop', array[b.slot::text, v_km]);
      insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
      values (b.cid, 'lr-top-' || b.slot || '-' || v_stamp, left(coalesce(t.title, 'Longest ride'), 120),
              left(coalesce(t.body, ''), 300), '/leaderboard?src=push', 'community', 'lrtop', array[b.slot::text, v_km])
      on conflict (customer_id, tag) do nothing;
    end if;
  end loop;

  -- whoever held a place and holds none now is told once
  for b in select h as cid from unnest(v_had) h where not exists (select 1 from _lr_top x where x.cid = h) loop
    select * into t from _push_text(b.cid, 'lrpassed', array[]::text[]);
    insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
    values (b.cid, 'lr-passed-' || v_stamp, left(coalesce(t.title, 'Longest ride'), 120),
            left(coalesce(t.body, ''), 300), '/leaderboard?src=push', 'community', 'lrpassed', array[]::text[])
    on conflict (customer_id, tag) do nothing;
  end loop;
  return v_n;
end $function$;
revoke all on function public._lr_podium_sync() from public, anon, authenticated;

-- A measured single ride brings the km Clubs it reaches; taken back when that ride goes.
create or replace function public._lr_clubs(p_cid text)
 returns void
 language plpgsql
 volatile
 security definer
 set search_path to 'public'
as $function$
declare v_me text := coalesce((select merged_into from customers where id = p_cid), p_cid); v_best numeric; n int;
begin
  select max(r.km) into v_best from ride_distances r join customers c on c.id = r.customer_id
   where (c.id = v_me or c.merged_into = v_me) and r.status = 'approved' and r.kind = 'ride';
  v_best := coalesce(v_best, 0);
  delete from customer_badges cb
   where cb.customer_id = v_me and cb.awarded_by = 'distance'
     and cb.badge_id in ('bd_km20', 'bd_km40', 'bd_km70', 'bd_km100')
     and substring(cb.badge_id from 6)::int > v_best;
  foreach n in array array[20, 40, 70, 100] loop
    if v_best >= n then
      insert into customer_badges (customer_id, badge_id, note, awarded_by)
      values (v_me, 'bd_km' || n, left('Cycled ' || trim(trailing '.' from trim(trailing '0' from to_char(v_best, 'FM99990.0'))) || ' km in one ride', 140), 'distance')
      on conflict (customer_id, badge_id) do nothing;
    end if;
  end loop;
end $function$;
revoke all on function public._lr_clubs(text) from public, anon, authenticated;


/* -- 6. staff ---------------------------------------------------------------------------------------------- */
create or replace function public.staff_distance_add(p_customer text, p_kind text, p_km numeric, p_date date,
  p_from date default null, p_note text default null, p_session text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_id bigint; v_km numeric := round(coalesce(p_km, 0), 1); v_me text;
  v_kind text := case when p_kind = 'total' then 'total' else 'ride' end;
  v_by text := left(coalesce((select display_name from staff where user_id = auth.uid()), 'staff'), 60);
begin
  if not _staff_mod('community', true) then raise exception 'not allowed' using errcode = '42501'; end if;
  v_me := coalesce((select merged_into from customers where id = p_customer), p_customer);
  if not exists (select 1 from customers where id = v_me) then return jsonb_build_object('ok', false, 'error', 'customer'); end if;
  if v_km < 1 or v_km > (case when v_kind = 'ride' then 300 else 50000 end) then return jsonb_build_object('ok', false, 'error', 'km'); end if;
  if p_date is null or p_date > _ksa_today() or (v_kind = 'total' and (p_from is null or p_from > p_date)) then
    return jsonb_build_object('ok', false, 'error', 'date');
  end if;
  insert into ride_distances (customer_id, kind, km, date_from, ride_date, session_id, source, status, note, created_by, decided_at, decided_by)
  values (v_me, v_kind, v_km, case when v_kind = 'total' then p_from end, p_date, (select id from sessions where id = p_session),
          'staff', 'approved', left(nullif(btrim(coalesce(p_note, '')), ''), 300), v_by, now(), v_by)
  returning id into v_id;
  perform _lr_clubs(v_me);
  perform _lr_podium_sync();
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;
revoke all on function public.staff_distance_add(text, text, numeric, date, date, text, text) from public, anon;
grant execute on function public.staff_distance_add(text, text, numeric, date, date, text, text) to authenticated;

-- Approve (optionally with the km staff read on the proof) or decline a waiting claim.
create or replace function public.staff_distance_answer(p_id bigint, p_ok boolean, p_km numeric default null, p_reply text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_c text; v_km numeric := case when p_km is null then null else round(p_km, 1) end; v_kind text;
begin
  if not _staff_mod('community', true) then raise exception 'not allowed' using errcode = '42501'; end if;
  select kind into v_kind from ride_distances where id = p_id and status = 'pending';
  if v_kind is null then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if v_km is not null and (v_km < 1 or v_km > case when v_kind = 'ride' then 300 else 50000 end) then
    return jsonb_build_object('ok', false, 'error', 'km');
  end if;
  update ride_distances
     set status = case when p_ok then 'approved' else 'declined' end,
         km = coalesce(v_km, km),
         reply = left(nullif(btrim(coalesce(p_reply, '')), ''), 140),
         decided_at = now(),
         decided_by = left(coalesce((select display_name from staff where user_id = auth.uid()), 'staff'), 60)
   where id = p_id and status = 'pending'
  returning customer_id into v_c;
  if v_c is null then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  perform _lr_clubs(v_c);
  perform _lr_podium_sync();
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.staff_distance_answer(bigint, boolean, numeric, text) from public, anon;
grant execute on function public.staff_distance_answer(bigint, boolean, numeric, text) to authenticated;

create or replace function public.staff_distance_remove(p_id bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_c text;
begin
  if not _staff_mod('community', true) then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from ride_distances where id = p_id returning customer_id into v_c;
  if v_c is null then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  perform _lr_clubs(v_c);
  perform _lr_podium_sync();
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.staff_distance_remove(bigint) from public, anon;
grant execute on function public.staff_distance_remove(bigint) to authenticated;

-- Staff see a whole board with full names: members only (as riders see it) or every account.
create or replace function public.staff_distance_board(p_board text default 'longest', p_gender text default 'male',
  p_members boolean default true)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  v_b text := case when p_board in ('longest', 'month', 'lifetime', 'year') then p_board else 'longest' end;
  v_g text := case when p_gender = 'female' then 'female' else 'male' end;
  v_m date := date_trunc('month', _ksa_today())::date; v_y date := date_trunc('year', _ksa_today())::date;
begin
  if not _staff_mod('community', false) then raise exception 'not allowed' using errcode = '42501'; end if;
  return coalesce((
    with x as (
      select distinct on (rr.cid) rr.cid, rr.km, rr.d, rr.src
        from _lr_rides() rr
       where v_b in ('longest', 'month') and rr.kind = 'ride' and (v_b = 'longest' or (rr.d >= v_m and rr.d <= _ksa_today()))
       order by rr.cid, rr.km desc, rr.d asc),
    s as (
      select rr.cid, sum(rr.km) as km, max(rr.d) as d, case when bool_or(rr.src = 'entry') then 'entry' else 'session' end as src
        from _lr_rides() rr
       where v_b in ('lifetime', 'year')
         and (v_b = 'lifetime' or (rr.d >= v_y and rr.d <= _ksa_today() and (rr.kind = 'ride' or rr.d0 >= v_y)))
       group by rr.cid),
    a as (select * from x union all select * from s),
    y as (
      select a.cid, round(a.km, 1) as km, a.d, a.src, c.name, c.board_public, _member_active(a.cid) as member,
             rank() over (order by round(a.km, 1) desc) as r,
             row_number() over (order by round(a.km, 1) desc, a.d asc, a.cid) as n
        from a join customers c on c.id = a.cid
       where a.km > 0 and c.merged_into is null and c.archived_at is null and c.gender = v_g
         and (not coalesce(p_members, true) or _member_active(a.cid)))
    select jsonb_agg(jsonb_build_object('r', y.r, 'id', y.cid, 'name', y.name, 'km', y.km, 'd', y.d, 'src', y.src,
             'public', y.board_public, 'member', y.member) order by y.n)
      from y where y.n <= 200), '[]'::jsonb);
end $function$;
revoke all on function public.staff_distance_board(text, text, boolean) from public, anon;
grant execute on function public.staff_distance_board(text, text, boolean) to authenticated;


/* -- the podium follows every 15 minutes, and is set now (empty until staff enter or approve a ride) ------- */
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'mm-long-ride';
    perform cron.schedule('mm-long-ride', '7-59/15 * * * *', $j$select public._lr_podium_sync()$j$);
  end if;
end $cron$;

select public._lr_podium_sync();


/* -- checks ------------------------------------------------------------------------------------------------ */
do $chk$
declare f text;
begin
  foreach f in array array['public.distance_board(text,text,text,text)', 'public.customer_distances(text,text)',
      'public.customer_distance_claim(text,text,text,numeric,date,date,text,text,text)', 'public.customer_distance_withdraw(text,text,bigint)',
      'public.customer_board_public(text,text,boolean)', 'public.staff_distance_add(text,text,numeric,date,date,text,text)',
      'public.staff_distance_answer(bigint,boolean,numeric,text)', 'public.staff_distance_remove(bigint)',
      'public.staff_distance_board(text,text,boolean)', 'public._lr_podium_sync()', 'public._lr_podium()', 'public._lr_clubs(text)',
      'public._lr_board(text)', 'public._lr_rides()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if (select count(*) from public.push_words where key in ('lrtop', 'lrpassed')) <> 22 then raise exception 'the words are missing'; end if;
  if (select count(*) from public.badges where id in ('bd_lr_gold', 'bd_lr_silver', 'bd_lr_bronze') and held_only and auto) <> 3 then
    raise exception 'the badges are missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261127180000', 'distance_leaderboards')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select (select count(*) from public.badges where id in ('bd_lr_gold', 'bd_lr_silver', 'bd_lr_bronze')) as badges_3,
       (select relrowsecurity from pg_class where oid = 'public.ride_distances'::regclass) as rls_true,
       has_function_privilege('anon', 'public.distance_board(text, text, text, text)', 'execute') as anon_board_true,
       has_function_privilege('anon', 'public.staff_distance_add(text, text, numeric, date, date, text, text)', 'execute') as anon_staff_false,
       has_table_privilege('anon', 'public.ride_distances', 'select') as anon_read_false,
       jsonb_array_length(public.distance_board('longest', 'female') -> 'rows') as board_rows_50,
       (select count(*) from cron.job where jobname = 'mm-long-ride') as cron_1,
       (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity) as no_rls_0,
       (select version from supabase_migrations.schema_migrations where version = '20261127180000') as ledger;
