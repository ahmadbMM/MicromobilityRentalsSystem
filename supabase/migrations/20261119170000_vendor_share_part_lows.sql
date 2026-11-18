-- ============================================================================
-- 20261119170000_vendor_share_part_lows
--
-- The Saturday rating is shorter (the owner, 2026-11-18: "shorten the rating of the saturday social ride as it is too
-- long"): the breakfast's restaurant, atmosphere, food and service are asked only of a rider who scored the breakfast
-- RG_LOW or under (8 unless Settings > Business rg_low says otherwise). Averaged over those riders alone, a part would
-- reach the restaurant as the whole morning's ("Food 6.5" on a 9.7 breakfast). So what staff share with a venue
-- (staff_vendor_share_ratings, 20261003200000, rebuilt from its live text, the same on prod and staging):
--   * averages: the breakfast's, and a part's only where every rider counted answered it (a day rated on the old form);
--   * lows (new column): for a part without an average, how many riders scored it low, when any did.
-- vendor_shared_ratings_mine returns lows beside the averages. Shares made before keep their averages and no lows.
-- ============================================================================
begin;

alter table public.vendor_shared_ratings add column if not exists lows jsonb not null default '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.staff_vendor_share_ratings(p_booking bigint, p_comments jsonb DEFAULT '[]'::jsonb, p_by text DEFAULT ''::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b vendor_bookings%rowtype; keys constant text[] := array['breakfast','bf_restaurant','bf_atmosphere','bf_food','bf_service'];
        n int; av jsonb; lw jsonb; cm jsonb; lo int; out vendor_shared_ratings%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not ((_staff_mod('vendors', true) or _staff_mod('fnb', true))
          and exists (select 1 from staff s where s.user_id = auth.uid() and s.disabled_at is null and s.role in ('admin', 'manager'))) then
    raise exception 'STAFF_ONLY' using errcode = '42501';   -- Vendors' own staff only (bug hunt 2026-10-28)
  end if;
  select * into b from vendor_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if b.status <> 'confirmed' then raise exception 'NOT_CONFIRMED' using errcode = 'P0001'; end if;
  if jsonb_typeof(coalesce(p_comments, '[]'::jsonb)) <> 'array' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  -- A low score, as the rating page reads it: the booking app's RG_LOW (Settings > Business rg_low, 1-9), else 8.
  select case when (c.value ->> 'rg_low') ~ '^[1-9]$' then (c.value ->> 'rg_low')::int end into lo
    from site_content c where c.key = 'biz.public';
  lo := coalesce(lo, 8);
  with r as (
    select q.id, q.rating_detail as d from queue_entries q join sessions s on s.id = q.session_id
     where s.session_date = b.day::text and s.event_kind = 'community'
       and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.status <> 'deleted'
       and q.status = 'done' and q.rating_detail ->> 'form' = 'social'
       and coalesce((q.rating_detail ->> 'skip_bf')::boolean, false) = false
       and q.rating_detail -> 's' ? 'breakfast'),
  st as (
    select k, round(avg((r.d -> 's' ->> k)::numeric), 1) as a, count(*) as c,
           count(*) filter (where (r.d -> 's' ->> k)::int <= lo) as l
      from r cross join unnest(keys) as k
     where (r.d -> 's' ->> k) ~ '^[0-9]+$' group by k)
  select (select count(*) from r),
         -- every rider counted scored the breakfast; a part is averaged only when each of them scored it too
         (select coalesce(jsonb_object_agg(st.k, st.a), '{}'::jsonb) from st
           where st.k = 'breakfast' or st.c = (select count(*) from r)),
         (select coalesce(jsonb_object_agg(st.k, st.l), '{}'::jsonb) from st
           where st.k <> 'breakfast' and st.c < (select count(*) from r) and st.l > 0),
         (select coalesce(jsonb_agg(jsonb_build_object('k', c.k, 'text', c.t) order by array_position(keys, c.k), c.t), '[]'::jsonb) from (
            select distinct p ->> 'k' as k, r.d -> 'why' ->> (p ->> 'k') as t
              from jsonb_array_elements(coalesce(p_comments, '[]'::jsonb)) p
              join r on r.id = p ->> 'e'
             where (p ->> 'k') = any(keys) and coalesce(r.d -> 'why' ->> (p ->> 'k'), '') <> '') c)
    into n, av, lw, cm;
  insert into vendor_shared_ratings (booking_id, venue_id, day, riders, averages, lows, comments, shared_by, shared_at)
  values (b.id, b.venue_id, b.day, n, av, lw, cm, coalesce(p_by, ''), now())
  on conflict (booking_id) do update set riders = excluded.riders, averages = excluded.averages, lows = excluded.lows,
     comments = excluded.comments, shared_by = excluded.shared_by, shared_at = now()
  returning * into out;
  return to_jsonb(out);
end $function$;
revoke all on function public.staff_vendor_share_ratings(bigint, jsonb, text) from public, anon;
grant execute on function public.staff_vendor_share_ratings(bigint, jsonb, text) to authenticated;

CREATE OR REPLACE FUNCTION public.vendor_shared_ratings_mine(p_uid bigint, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('booking_id', r.booking_id, 'day', r.day, 'riders', r.riders,
                                                       'averages', r.averages, 'lows', r.lows, 'comments', r.comments,
                                                       'shared_at', r.shared_at)
                                    order by r.day desc)
                     from vendor_shared_ratings r where r.venue_id = u.venue_id), '[]'::jsonb);
end $function$;
revoke all on function public.vendor_shared_ratings_mine(bigint, text) from public;
grant execute on function public.vendor_shared_ratings_mine(bigint, text) to anon, authenticated;

do $chk$
begin
  if exists (select 1 from pg_proc p where p.oid in ('public.staff_vendor_share_ratings(bigint, jsonb, text)'::regprocedure,
                                                    'public.vendor_shared_ratings_mine(bigint, text)'::regprocedure)
               and not (p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))) then
    raise exception 'a vendor ratings function lost SECURITY DEFINER or its search_path';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119170000', 'vendor_share_part_lows')
on conflict (version) do nothing;

commit;

-- check: select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'vendor_shared_ratings'
--                 and column_name = 'lows') as lows_col,
--          (select bool_and(p.prosecdef) from pg_proc p where p.proname in ('staff_vendor_share_ratings', 'vendor_shared_ratings_mine')) as definer,
--          (select pg_get_functiondef('public.vendor_shared_ratings_mine(bigint, text)'::regprocedure) like '%''lows''%') as mine_returns_lows,
--          has_function_privilege('anon', 'public.staff_vendor_share_ratings(bigint, jsonb, text)'::regprocedure, 'execute') as anon_can_share,
--          (select count(*) from supabase_migrations.schema_migrations where version = '20261119170000') as ledger;
