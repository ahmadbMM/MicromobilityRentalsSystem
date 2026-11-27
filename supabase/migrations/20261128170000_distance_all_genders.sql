-- The distance leaderboards: an all-genders board (the user, 2026-11-28: "add a all genders leaderboard").
-- distance_board and staff_distance_board take p_gender 'all' as well as 'male' / 'female': everyone together, ranked as
-- one (equal figures share a place). Gold / Silver / Bronze stay per gender (_lr_podium untouched); a row's medal is
-- the rider's own. The two functions are the 20261128150000 / 20261127180000 copies with only those lines changed.
-- Rollback: run distance_board from 20261128150000 and staff_distance_board from 20261127180000 again.

begin;
set local lock_timeout = '5s';

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
  v_g text := case when p_gender in ('female', 'all') then p_gender else 'male' end;
  v_me text; v_rows jsonb; v_mine jsonb; c record;
begin
  if p_id is not null and p_token is not null and _cust_token_ok(p_id, p_token) then
    v_me := coalesce((select merged_into from customers where id = p_id), p_id);
  end if;
  -- 'all' ranks everyone together; a gender keeps the rank _lr_board gives within it
  with b as (select x.cid, x.km, x.d, x.gender,
                    case when v_g = 'all' then rank() over (order by x.km desc) else x.r end as r
               from _lr_board(v_b) x where v_g = 'all' or x.gender = v_g),
  o as (select b.*, row_number() over (order by b.r, b.d, b.cid) as n from b)
  select coalesce(jsonb_agg(jsonb_build_object('r', o.r, 'km', o.km,
                    'name', nullif(btrim(regexp_replace(coalesce(cu.name, ''), '[-_\s]+', ' ', 'g')), ''),
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
  v_g text := case when p_gender in ('female', 'all') then p_gender else 'male' end;
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
       where a.km > 0 and c.merged_into is null and c.archived_at is null and (v_g = 'all' or c.gender = v_g)
         and (not coalesce(p_members, true) or _member_active(a.cid)))
    select jsonb_agg(jsonb_build_object('r', y.r, 'id', y.cid, 'name', y.name, 'km', y.km, 'd', y.d, 'src', y.src,
             'public', y.board_public, 'member', y.member) order by y.n)
      from y where y.n <= 200), '[]'::jsonb);
end $function$;
revoke all on function public.staff_distance_board(text, text, boolean) from public, anon;
grant execute on function public.staff_distance_board(text, text, boolean) to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261128170000', 'distance_all_genders')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select public.distance_board('lifetime', 'all') ->> 'gender' as gender_all,
       jsonb_array_length(public.distance_board('lifetime', 'all') -> 'rows') as rows_up_to_50,
       (select version from supabase_migrations.schema_migrations where version = '20261128170000') as ledger;
