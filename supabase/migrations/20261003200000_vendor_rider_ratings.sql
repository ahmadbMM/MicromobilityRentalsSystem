-- ============================================================================
-- Vendors: share the riders' BREAKFAST ratings with the vendor that hosted the breakfast.
--
-- The owner's ask (2026-10-03): "share customers feedback on the breakfast section of the rating
-- only with the vendor". The detailed post-ride rating (queue_entries.rating_detail, live since
-- 2026-10-03) asks a Saturday social ride's riders about the breakfast: the breakfast as a whole
-- (breakfast), the restaurant (bf_restaurant), the atmosphere (bf_atmosphere), the food (bf_food) and
-- the service (bf_service), each 1-10, with a reason required for 8 or under; a rider who did not
-- stay ticks skip_bf.
--
--  1. vendor_shared_ratings - what staff chose to share for one confirmed booking: how many riders
--     rated the breakfast, the average of each breakfast question, and the reasons staff ticked.
--     NO rider names or ids, no ride or overall scores, no free comment box. Staff read it.
--  2. staff_vendor_share_ratings(booking, comments, by) - staff share (or share again) a date's
--     breakfast ratings. The database counts and averages them itself from that date's Saturday
--     social ride (riders who finished the ride and did not skip breakfast) and takes the text of
--     only the reasons staff picked ([{"e":"<queue entry id>","k":"bf_food"}...]) and only for
--     breakfast questions on that ride. staff_vendor_unshare_ratings(booking) withdraws it.
--  3. vendor_shared_ratings_mine(uid, token) - the signed-in vendor's own shared ratings.
--
-- Rollback:
--   drop function if exists public.vendor_shared_ratings_mine(bigint, text);
--   drop function if exists public.staff_vendor_unshare_ratings(bigint);
--   drop function if exists public.staff_vendor_share_ratings(bigint, jsonb, text);
--   drop table if exists public.vendor_shared_ratings;
-- Idempotent.
-- ============================================================================

create table if not exists public.vendor_shared_ratings (
  booking_id bigint primary key references public.vendor_bookings(id) on delete cascade,
  venue_id   bigint not null references public.vendor_venues(id) on delete cascade,
  day        date not null,
  riders     integer not null default 0,
  averages   jsonb not null default '{}'::jsonb,
  comments   jsonb not null default '[]'::jsonb,
  shared_by  text not null default '',
  shared_at  timestamptz not null default now()
);
create index if not exists vendor_shared_ratings_venue on public.vendor_shared_ratings(venue_id, day desc);

alter table public.vendor_shared_ratings enable row level security;
drop policy if exists "vendor_shared_ratings staff read" on public.vendor_shared_ratings;
create policy "vendor_shared_ratings staff read" on public.vendor_shared_ratings for select to authenticated using ((select public.is_staff()));
revoke all on public.vendor_shared_ratings from anon, authenticated;
grant select on public.vendor_shared_ratings to authenticated;

create or replace function public.staff_vendor_share_ratings(p_booking bigint, p_comments jsonb default '[]'::jsonb, p_by text default '')
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare b vendor_bookings%rowtype; keys constant text[] := array['breakfast','bf_restaurant','bf_atmosphere','bf_food','bf_service'];
        n int; av jsonb; cm jsonb; out vendor_shared_ratings%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into b from vendor_bookings where id = p_booking;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if b.status <> 'confirmed' then raise exception 'NOT_CONFIRMED' using errcode = 'P0001'; end if;
  if jsonb_typeof(coalesce(p_comments, '[]'::jsonb)) <> 'array' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  -- The breakfast answers of that date's Saturday social ride: counted, averaged, and the picked reasons.
  with r as (
    select q.id, q.rating_detail as d from queue_entries q join sessions s on s.id = q.session_id
     where s.session_date = b.day::text and s.event_kind = 'community'
       and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.status <> 'deleted'
       and q.status = 'done' and q.rating_detail ->> 'form' = 'social'
       and coalesce((q.rating_detail ->> 'skip_bf')::boolean, false) = false
       and q.rating_detail -> 's' ? 'breakfast')
  select (select count(*) from r),
         (select coalesce(jsonb_object_agg(x.k, x.a), '{}'::jsonb) from (
            select k, round(avg((r.d -> 's' ->> k)::numeric), 1) as a from r cross join unnest(keys) as k
             where (r.d -> 's' ->> k) ~ '^[0-9]+$' group by k) x),
         (select coalesce(jsonb_agg(jsonb_build_object('k', c.k, 'text', c.t) order by array_position(keys, c.k), c.t), '[]'::jsonb) from (
            select distinct p ->> 'k' as k, r.d -> 'why' ->> (p ->> 'k') as t
              from jsonb_array_elements(coalesce(p_comments, '[]'::jsonb)) p
              join r on r.id = p ->> 'e'
             where (p ->> 'k') = any(keys) and coalesce(r.d -> 'why' ->> (p ->> 'k'), '') <> '') c)
    into n, av, cm;
  insert into vendor_shared_ratings (booking_id, venue_id, day, riders, averages, comments, shared_by, shared_at)
  values (b.id, b.venue_id, b.day, n, av, cm, coalesce(p_by, ''), now())
  on conflict (booking_id) do update set riders = excluded.riders, averages = excluded.averages,
     comments = excluded.comments, shared_by = excluded.shared_by, shared_at = now()
  returning * into out;
  return to_jsonb(out);
end $$;

create or replace function public.staff_vendor_unshare_ratings(p_booking bigint)
returns void language plpgsql security definer set search_path to 'public'
as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  delete from vendor_shared_ratings where booking_id = p_booking;
end $$;

create or replace function public.vendor_shared_ratings_mine(p_uid bigint, p_token text)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('booking_id', r.booking_id, 'day', r.day, 'riders', r.riders,
                                                       'averages', r.averages, 'comments', r.comments, 'shared_at', r.shared_at)
                                    order by r.day desc)
                     from vendor_shared_ratings r where r.venue_id = u.venue_id), '[]'::jsonb);
end $$;

revoke all on function public.staff_vendor_share_ratings(bigint, jsonb, text) from public, anon;
grant execute on function public.staff_vendor_share_ratings(bigint, jsonb, text) to authenticated;
revoke all on function public.staff_vendor_unshare_ratings(bigint) from public, anon;
grant execute on function public.staff_vendor_unshare_ratings(bigint) to authenticated;
revoke all on function public.vendor_shared_ratings_mine(bigint, text) from public;
grant execute on function public.vendor_shared_ratings_mine(bigint, text) to anon, authenticated;
