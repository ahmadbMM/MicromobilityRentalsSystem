-- ============================================================================
-- Marks on the staff Saturday roster (new features build F4; the owner marked it Build now on 2026-11-13: "Staff
-- roster only: marks for first and second Saturday, back after three missed, milestone today; a Milestones this
-- Saturday list", and on call-outs at the briefing: "Yes, with a way for a rider to opt out").
--
-- Staff only; nothing here is read by a rider's page.
--
--  1. The tag "No call-out" (tag_no_callout): a locked system tag like Influencer (20261112235800), given by staff on
--     the account window and seen only by staff (customer_tags is staff-only, policy "staff full"; no rider-facing
--     function reads this tag). Its holder keeps the roster mark and is left out of "Milestones this Saturday".
--
--  2. staff_sat_marks(p_session): the one read a Saturday ride's Bookings makes when it is opened. For every account
--     on that session's roster: n, the Saturday rides it finished before this session's day (its own bookings and
--     those of accounts merged into it; a ride is a booking with status done that the badge ladder counts, the app's
--     _rideCompleted: paid, or on a free ride, or on the rider's own bike - so "Saturday ride N" is never ahead of the
--     rider's badge on a paid Saturday), and miss, the days a Saturday ride was held (somebody finished it) after its
--     last one and before this session. The app draws the marks from those two numbers and the badge ladder's own
--     steps. A session that is not of the Saturday kind (event_kind community, ride_kind saturday or none, as the
--     app's _rideKind) answers no riders. One statement over the roster's accounts, never one per rider. SECURITY
--     DEFINER with is_staff() first, as staff_hub_numbers; stable, it writes nothing.
--
-- The app works before this runs: without the function it shows no marks and no list, and it offers the No call-out
-- switch only once the tag row exists. Idempotent.
--
-- Rollback:
--   drop function if exists public.staff_sat_marks(text);
--   delete from public.customer_tags where tag_id = 'tag_no_callout';
--   delete from public.tags where id = 'tag_no_callout';
--   delete from supabase_migrations.schema_migrations where version = '20261114010400';
-- ============================================================================

begin;

-- ── 1: the tag ──────────────────────────────────────────────────────────────────────────────────
insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values ('tag_no_callout', 'no_callout', 'No call-out', '#5f6b7a',
        'Not named at the briefing: left out of Milestones this Saturday. Given by staff, seen only by staff.',
        false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do update set color = excluded.color, description = excluded.description;

-- ── 2: the roster's read ────────────────────────────────────────────────────────────────────────
create or replace function public.staff_sat_marks(p_session text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_date text; v_rows jsonb;
begin
  if not coalesce(is_staff(), false) then raise exception 'not staff' using errcode = '42501'; end if;
  select s.session_date into v_date
    from sessions s
   where s.id = p_session and s.event_kind = 'community' and coalesce(s.ride_kind, 'saturday') = 'saturday';
  if v_date is null then
    return jsonb_build_object('ok', true, 'riders', '[]'::jsonb);
  end if;
  with me as (            -- the accounts on this session's roster
    select distinct q.customer_id as cid
      from queue_entries q
     where q.session_id = p_session and q.customer_id is not null
       and coalesce(q.status, '') not in ('cancelled', 'removed')
  ), acct as (            -- each one's own account and the accounts merged into it
    select m.cid, m.cid as aid from me m
    union
    select m.cid, x.id from me m join customers x on x.merged_into = m.cid
  ), rode as (            -- the Saturday rides each finished before this session's day
    select a.cid, q.session_id, max(s.session_date) as d
      from acct a
      join queue_entries q on q.customer_id = a.aid and q.status = 'done'
      join sessions s on s.id = q.session_id
     where s.event_kind = 'community' and coalesce(s.ride_kind, 'saturday') = 'saturday'
       and s.session_date < v_date
       and (coalesce(q.paid, false) or not coalesce(s.paid_ride, false) or coalesce(q.type_preference, '') = 'Own')
     group by a.cid, q.session_id
  ), held as (            -- the days a Saturday ride was held: somebody finished it
    select distinct s.session_date as d
      from sessions s
     where s.event_kind = 'community' and coalesce(s.ride_kind, 'saturday') = 'saturday'
       and s.session_date < v_date
       and exists (select 1 from queue_entries q where q.session_id = s.id and q.status = 'done')
  ), agg as (
    select m.cid, count(r.session_id)::integer as n, max(r.d) as last_d
      from me m left join rode r on r.cid = m.cid
     group by m.cid
  )
  select coalesce(jsonb_agg(jsonb_build_object('c', a.cid, 'n', a.n,
           'miss', case when a.last_d is null then 0
                        else (select count(*)::integer from held h where h.d > a.last_d) end)), '[]'::jsonb)
    into v_rows
    from agg a;
  return jsonb_build_object('ok', true, 'riders', v_rows);
end $$;
revoke all on function public.staff_sat_marks(text) from public, anon;
grant execute on function public.staff_sat_marks(text) to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114010400', 'saturday_roster_marks')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): the tag is in and locked, and the function is a definer staff alone may call.
select (select count(*) from public.tags where id = 'tag_no_callout' and locked and not auto_grant) as tag_locked_1,
       (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'staff_sat_marks' and p.prosecdef) as definer_1,
       has_function_privilege('anon', 'public.staff_sat_marks(text)', 'execute') as anon_can_false,
       has_function_privilege('authenticated', 'public.staff_sat_marks(text)', 'execute') as staff_can_true,
       (select count(*) from supabase_migrations.schema_migrations where version = '20261114010400') as ledger_1;
