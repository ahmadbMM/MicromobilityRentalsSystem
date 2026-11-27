-- The distance leaderboards, three changes from the user (2026-11-28), on top of 20261127180000:
--   "show all full names on the leaderboard": distance_board gives every row's full name (dashes and underscores read
--     as spaces, names carry none), not only for riders who switched it on; customers.board_public stays, unused.
--   "dont put a maximum limit for kms per one ride": no 300 km cap for one ride or 50,000 km for a total, for staff and
--     for riders' claims (staff approve every claim); 99,999 km is only the column's own room (numeric(7,1)).
--   "dont force me to add a date": a distance staff enter may have no date. It counts on Longest ride and Lifetime;
--     This month and This year need a day, so it is not on those. Riders' claims still give the day of the ride.
-- The four functions are the 20261127180000 copies with only those lines changed (same attributes and grants).
--
-- Rollback: run 20261127180000's four functions again; then, only while no row has a null ride_date or a km over the
-- old caps, put back the old check and `alter table public.ride_distances alter column ride_date set not null`.

begin;
set local lock_timeout = '5s';

alter table public.ride_distances alter column ride_date drop not null;
alter table public.ride_distances drop constraint if exists ride_distances_kind_chk;
alter table public.ride_distances add constraint ride_distances_kind_chk check (km >= 1 and (
  (kind = 'ride' and date_from is null)
  or (kind = 'total' and (date_from is null or (ride_date is not null and date_from <= ride_date)))));

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
  if v_km < 1 or v_km > 99999 then return jsonb_build_object('ok', false, 'error', 'km'); end if;
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
  if v_km < 1 or v_km > 99999 then return jsonb_build_object('ok', false, 'error', 'km'); end if;
  -- the dates are optional (the user, 2026-11-28): none, or a day not after today; a total's first day needs its last
  if p_date > _ksa_today() or (v_kind = 'total' and p_from is not null and (p_date is null or p_from > p_date)) then
    return jsonb_build_object('ok', false, 'error', 'date');
  end if;
  insert into ride_distances (customer_id, kind, km, date_from, ride_date, session_id, source, status, note, created_by, decided_at, decided_by)
  values (v_me, v_kind, v_km, case when v_kind = 'total' and p_date is not null then p_from end, p_date, (select id from sessions where id = p_session),
          'staff', 'approved', left(nullif(btrim(coalesce(p_note, '')), ''), 300), v_by, now(), v_by)
  returning id into v_id;
  perform _lr_clubs(v_me);
  perform _lr_podium_sync();
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;
revoke all on function public.staff_distance_add(text, text, numeric, date, date, text, text) from public, anon;
grant execute on function public.staff_distance_add(text, text, numeric, date, date, text, text) to authenticated;

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
  if v_km is not null and (v_km < 1 or v_km > 99999) then
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

insert into supabase_migrations.schema_migrations (version, name)
values ('20261128150000', 'distance_full_names_no_limits')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select (select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'ride_distances' and column_name = 'ride_date') as nullable_yes,
       (select count(*) from jsonb_array_elements(public.distance_board('longest', 'female') -> 'rows') r where r->>'name' is null) as rows_without_name_0,
       (select prosecdef from pg_proc where oid = 'public.staff_distance_add(text, text, numeric, date, date, text, text)'::regprocedure) as definer_true,
       has_function_privilege('anon', 'public.staff_distance_add(text, text, numeric, date, date, text, text)', 'execute') as anon_staff_false,
       (select version from supabase_migrations.schema_migrations where version = '20261128150000') as ledger;
