-- ============================================================================
-- "Running late" on the ticket (the customer features round, 2026-11-19, item 1).
--
-- The user asked "what features for customers can we add to the booking app that will enhance their experience", was
-- offered a list and answered "do 1 2 3 5 7 9 11". Item 1, as offered: "'Still coming?' gets a third answer next to
-- I'm coming / Can't come: Running late (10, 20 or 30 min). The desk sees it in the Late arrivals filter that went live
-- yesterday, so staff stop chasing riders who already said so. Right now only staff can send a 'Running late?'
-- message; riders can't tell the desk."
--
--  1. queue_entries.late_min smallint (10, 20 or 30) and late_at timestamptz: the rider said they are running about
--     that late, and when. The rider reads them through my_bookings (whole rows of their own bookings, as coming_at,
--     20261114080200 and 20261119000300), staff through their own reads and staff_sync (whole rows); queue_public
--     names its columns, so no other rider ever sees them. No column grants on queue_entries, so nothing to grant.
--  2. booking_late(p_id, p_token, p_session, p_min): the rider's own seated bookings on that session, every rider of
--     the booking at once (as booking_coming: the party has one answer). p_min null clears it ("I'm on time").
--     Token-checked. Only on a session with a time to turn up (the app's Late arrivals set, _ltrAt: a ride that gathers,
--     or a workshop, event, yoga or the Defe run; never the circuit, Petromin, the pool, blood, the Arena race or a test
--     ride), and loosely in time: from 3 hours before its first time until 2 hours after its start (the app offers it
--     from 2 hours before the time to turn up until an hour after the start), else 'closed'; a session called off or
--     deleted is 'closed' too, and so is a party one of whose riders is already checked in (active or done). 'none' when the rider holds no seated, approved booking there; 'bad' for any other
--     number. Running late counts as coming: it stamps coming_at when the booking has no answer for this date.
--     booking_coming keeps its arguments (micromobility.sa calls it): this is a new function beside it.
--  3. _coming_guard (from 20261114080200_still_coming.sql, its only definition): a rider's direct write can set neither
--     column either, and a booking moved to another session, or cancelled, loses them with coming_at.
--
-- Safe before or after the app: until this runs no booking carries late_min, so the page shows no Running late.
--
-- Rollback:
--   drop function if exists public.booking_late(text, text, text, integer);
--   run section 3 of 20261114080200_still_coming.sql again (_coming_guard and its trigger as they were);
--   alter table public.queue_entries drop constraint if exists queue_entries_late_min_chk,
--     drop column if exists late_min, drop column if exists late_at;
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $pre$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'queue_entries' and column_name = 'coming_at')
     or to_regprocedure('public._coming_guard()') is null then
    raise exception 'running_late: run 20261114080200_still_coming first';
  end if;
end $pre$;

-- ── 1. the answer on the booking ───────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists late_min smallint;
alter table public.queue_entries add column if not exists late_at timestamptz;
alter table public.queue_entries drop constraint if exists queue_entries_late_min_chk;
alter table public.queue_entries add constraint queue_entries_late_min_chk check (late_min is null or late_min in (10, 20, 30));
comment on column public.queue_entries.late_min is
  'Running late: the rider said they will be about this many minutes late, 10 | 20 | 30 (booking_late, 20261119600100); cleared with coming_at when the booking moves or is cancelled.';
comment on column public.queue_entries.late_at is
  'When the rider said they are running late (booking_late, 20261119600100).';

-- ── 2. the rider's own answer ──────────────────────────────────────────────────────────────────
create or replace function public.booking_late(p_id text, p_token text, p_session text, p_min integer)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare s sessions%rowtype; v_kind text; v_from timestamptz; v_to timestamptz; v_start timestamptz; v_n int; v_at timestamptz;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if p_min is not null and p_min not in (10, 20, 30) then return jsonb_build_object('ok', false, 'error', 'bad'); end if;
  select * into s from sessions where id = p_session;
  if not found or s.status = 'deleted' or s.cancelled_at is not null or s.ride_status is not distinct from 'cancelled' then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  -- a time to turn up: the kinds that gather (their times are "gathering, then start") and the ones that start together
  v_kind := _session_kind(s.id);
  if coalesce(s.ride_kind, '') = 'testride'
     or v_kind not in ('saturday', 'snd96', 'runher', 'vlap', 'farm', 'workshop', 'event', 'yoga', 'defe5k') then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  select w.starts_at, w.ends_at into v_from, v_to from _session_window(s) w;
  if v_to < v_from then v_to := v_to + interval '1 day'; end if; -- a session that runs past midnight
  v_start := case when v_kind in ('saturday', 'snd96', 'runher', 'vlap', 'farm') then v_to else v_from end;
  if v_from is null or now() < v_from - interval '3 hours' or now() >= v_start + interval '2 hours' then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  -- a party partly (or wholly) checked in is past asking: the desk sees them (review fix)
  if exists (select 1 from queue_entries q where q.session_id = p_session and q.customer_id = p_id and q.status in ('active', 'done')) then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  v_at := case when p_min is null then null else now() end;
  -- the rider's own seated rows, all of them: one answer for the party; a late rider is a coming one
  update queue_entries q
     set late_min = p_min, late_at = v_at,
         coming_at = case when p_min is not null and (q.coming_at is null or q.coming_at < v_from - interval '48 hours')
                          then now() else q.coming_at end
   where q.session_id = p_session and q.customer_id = p_id and q.status = 'waiting'
     and coalesce(q.approval, 'approved') = 'approved';
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('ok', false, 'error', 'none'); end if;
  return jsonb_build_object('ok', true, 'late_min', p_min, 'late_at', v_at, 'n', v_n,
    'coming_at', (select min(q.coming_at) from queue_entries q
                   where q.session_id = p_session and q.customer_id = p_id and q.status = 'waiting' and q.coming_at is not null));
end $$;
revoke all on function public.booking_late(text, text, text, integer) from public;
grant execute on function public.booking_late(text, text, text, integer) to anon, authenticated;

-- ── 3. the columns are the function's to write, and belong to one session ───────────────────────
-- 20261114080200's text with late_min and late_at beside coming_at (header unchanged: invoker, search_path public).
create or replace function public._coming_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if current_user in ('anon', 'authenticated') and not coalesce((select is_staff()), false) then
    if tg_op = 'UPDATE' then
      new.coming_at := old.coming_at;
      new.late_min := old.late_min; new.late_at := old.late_at; -- (20261119600100)
    else
      new.coming_at := null;
      new.late_min := null; new.late_at := null; -- (20261119600100)
    end if;
  end if;
  if tg_op = 'UPDATE' and (new.session_id is distinct from old.session_id
                           or (new.status = 'cancelled' and old.status is distinct from 'cancelled')) then
    new.coming_at := null;
    new.late_min := null; new.late_at := null; -- (20261119600100)
  end if;
  return new;
end $function$;
revoke all on function public._coming_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_coming_guard on public.queue_entries;
create trigger queue_entries_coming_guard
  before insert or update of coming_at, late_min, late_at, session_id, status on public.queue_entries
  for each row execute function public._coming_guard();

do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.booking_late(text,text,text,integer)'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'booking_late lost SECURITY DEFINER or its search_path';
  end if;
  if not has_function_privilege('anon', 'public.booking_late(text,text,text,integer)', 'execute') then
    raise exception 'riders cannot reach booking_late';
  end if;
  if (select p.prosecdef from pg_proc p where p.oid = 'public._coming_guard()'::regprocedure)
     or not exists (select 1 from pg_proc p, unnest(coalesce(p.proconfig, '{}')) c
                     where p.oid = 'public._coming_guard()'::regprocedure and c like 'search_path=%') then
    raise exception '_coming_guard changed its attributes';
  end if;
  if has_function_privilege('anon', 'public._coming_guard()', 'execute') then raise exception '_coming_guard is executable by anon'; end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119600100', 'running_late')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check: select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'queue_entries'
--          and column_name in ('late_min', 'late_at')) as columns_2,
--        has_function_privilege('anon', 'public.booking_late(text,text,text,integer)', 'execute') as anon_late_true,
--        (select prosecdef from pg_proc where oid = 'public.booking_late(text,text,text,integer)'::regprocedure) as definer_true,
--        (select pg_get_triggerdef(oid) like '%late_min%' from pg_trigger where tgname = 'queue_entries_coming_guard') as trigger_true,
--        position('late_min' in pg_get_functiondef('public._coming_guard()'::regprocedure)) > 0 as guard_true,
--        (select version from supabase_migrations.schema_migrations where version = '20261119600100') as ledger;
