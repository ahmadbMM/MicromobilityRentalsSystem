-- ============================================================================
-- People review (2026-11-06 staff review, PP02 + PP07).
--
--   public.staff_customer_stats()  every account's whole riding record in one small answer, for the Accounts list,
--                                  the account window and the account report: a staff device holds only its window
--                                  of bookings, so "Never rode", "No ride in 90 days", the Rides bands, the last ride
--                                  and lifetime no-shows were wrong for older riders. Staff only (is_staff), SECURITY
--                                  DEFINER, read-only (STABLE). One compact JSON array of arrays:
--                                  [customer_id, bookings, rides, community rides, first ride, last ride, no-shows,
--                                   cancelled, minutes ridden, spent]. The page reads it at most every ten minutes and
--                                  only while Accounts or Analytics is open, and lays each figure over its own count
--                                  (the larger wins: the page may hold a booking newer than the last read).
--                                  "Spent" is the paid price of bookings not cancelled or removed, transfers to a
--                                  race's organiser left out; add-ons are the page's to add (it keeps the larger).
--
--   staff_comments.kind            takes 'customer' too (target_id = customers.id): staff notes kept on the person
--                                  ("needs the small helmet"), the newest shown on the Bookings row and at check-in.
--                                  Same table, same staff-only RLS and author stamp (20261023230000).
--
-- The page works before this is applied: without the function the list counts what the device holds, as before;
-- a note on an account says "Waiting for the database update" until the kind is allowed.
--
-- Rollback:
--   drop function if exists public.staff_customer_stats();
--   delete from public.staff_comments where kind = 'customer';
--   alter table public.staff_comments drop constraint if exists staff_comments_kind_check;
--   alter table public.staff_comments add constraint staff_comments_kind_check
--     check (kind in ('booking','community_app','learn_app'));
-- Idempotent: safe to re-run.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. Lifetime riding figures per account ─────────────────────────────────────────────────────────
create or replace function public.staff_customer_stats()
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path = public
as $function$
begin
  if not coalesce((select is_staff()), false) then
    raise exception 'STAFF_ONLY' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_array(x.cid, x.b, x.r, x.cr, x.f, x.l, x.ns, x.cx, x.mi, x.sp))
    from (
      select q.customer_id::text as cid,
             count(*)::int as b,
             (count(*) filter (where q.status = 'done'))::int as r,
             (count(*) filter (where q.status = 'done' and s.event_kind = 'community'
                                 and coalesce(s.ride_kind, '') <> 'snd96'))::int as cr,
             min(left(q.session_date::text, 10)) filter (where q.status = 'done') as f,
             max(left(q.session_date::text, 10)) filter (where q.status = 'done') as l,
             (count(*) filter (where q.status = 'noshow'))::int as ns,
             (count(*) filter (where q.status = 'cancelled'))::int as cx,
             coalesce(sum(coalesce(q.ride_duration, 0)) filter (where q.status = 'done'), 0)::int as mi,
             round(coalesce(sum(coalesce(q.price, 0)) filter (
               where q.paid and q.status not in ('cancelled', 'removed')
                 and not (coalesce(q.pay_method, '') = 'transfer' and coalesce(s.ride_kind, '') in ('vlap', 'arena'))), 0)::numeric, 2) as sp
      from queue_entries q
      left join sessions s on s.id = q.session_id
      where q.customer_id is not null and q.status <> 'removed'
      group by q.customer_id
    ) x), '[]'::jsonb);
end $function$;
revoke all on function public.staff_customer_stats() from public, anon;
grant execute on function public.staff_customer_stats() to authenticated;
comment on function public.staff_customer_stats() is
  'Staff only: per account [id, bookings, rides, community rides, first ride, last ride, no-shows, cancelled, minutes, spent] (20261107120000).';

-- ── 2. Staff notes on an account ────────────────────────────────────────────────────────────────────
alter table public.staff_comments drop constraint if exists staff_comments_kind_check;
alter table public.staff_comments add constraint staff_comments_kind_check
  check (kind in ('booking', 'community_app', 'learn_app', 'customer'));

do $chk$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'staff_customer_stats' and p.prosecdef) then
    raise exception 'staff_customer_stats missing or not SECURITY DEFINER';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'staff_comments_kind_check'
                  and pg_get_constraintdef(oid) like '%customer%') then
    raise exception 'staff_comments_kind_check does not take customer';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261107120000', 'people_review')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- Read-only checks after applying:
--   select jsonb_array_length(public.staff_customer_stats());            -- as a staff user: accounts with bookings
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'staff_comments_kind_check';
--   select proname, prosecdef, provolatile, proconfig from pg_proc where proname = 'staff_customer_stats';
