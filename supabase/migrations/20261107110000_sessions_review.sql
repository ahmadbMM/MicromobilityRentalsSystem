-- ============================================================================
-- The Sessions page review (2026-11-07, SS01 / SS09 / SS10).
--
--   1. sessions.series_id  text: the nights one "Repeat" made share it (SS09). The page selects a series with it and
--      the editor's "apply to this and following nights" follows it. Null for a night made alone.
--   2. sessions.draft      boolean, default false: a session made as a Draft (SS10). A draft is closed like any other
--      closed night (riders cannot see or book it); the flag only lets staff tell it from a finished night, and leaves
--      it out of the page's fill figures.
--   3. sessions.opens_at   timestamptz: "Open on a date and time" (SS10). The timer below opens the session then.
--   4. _session_published (BEFORE INSERT OR UPDATE): a session that becomes open or full is no longer a draft and has
--      no timed opening left, whoever opened it (the timer, a staffer's Open, the bulk Open, the editor).
--   5. _sessions_tick() + pg_cron 'mm-sessions-tick' every 5 minutes:
--        - closes an open or full session two hours after its window ends (_session_window, the Riyadh clock), so old
--          nights stop sitting above tonight's in every staff list (SS01). STATUS ONLY: no booking is touched;
--          settling riders stays Close out's (the owner, 2026-10-09: closing is not close-out);
--        - opens a closed, non-deleted session whose opens_at has come and whose window has not ended (SS10).
--
-- Safe before or after the app: the page writes series_id / draft / opens_at only when the rows it reads carry the
-- columns; until then Draft is a plain closed session and "Open at" says "Waiting for the database update".
--
-- Rollback:
--   select cron.unschedule('mm-sessions-tick');
--   drop trigger if exists sessions_published on public.sessions;
--   drop function if exists public._sessions_tick(); drop function if exists public._session_published();
--   alter table public.sessions drop column if exists series_id, drop column if exists draft, drop column if exists opens_at;
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create extension if not exists pg_cron with schema pg_catalog;

alter table public.sessions
  add column if not exists series_id text check (char_length(series_id) <= 64),
  add column if not exists draft boolean not null default false,
  add column if not exists opens_at timestamptz;
comment on column public.sessions.series_id is 'Nights made by one Repeat share it (20261107110000).';
comment on column public.sessions.draft is 'Made as a Draft and not opened since (20261107110000). Closed like any closed night.';
comment on column public.sessions.opens_at is 'Opened by mm-sessions-tick at this moment (20261107110000); cleared once open.';

create index if not exists sessions_series_id_idx on public.sessions (series_id) where series_id is not null;
create index if not exists sessions_opens_at_idx on public.sessions (opens_at) where opens_at is not null;

-- ── 4. Opening ends the draft and the timer ──────────────────────────────────────────────────
create or replace function public._session_published()
 returns trigger language plpgsql
 set search_path = public
as $function$
begin
  if new.status in ('open', 'full') then
    new.draft := false;
    new.opens_at := null;
  end if;
  return new;
end $function$;
revoke execute on function public._session_published() from public, anon, authenticated;

drop trigger if exists sessions_published on public.sessions;
create trigger sessions_published
  before insert or update of status, draft, opens_at on public.sessions
  for each row execute function public._session_published();

-- ── 5. The timer ─────────────────────────────────────────────────────────────────────────────
-- The first run also closes the old nights left open since July (status only); later runs find only the evening's.
create or replace function public._sessions_tick()
 returns integer language plpgsql
 security definer
 set search_path = public
as $function$
declare _n int := 0; _m int := 0;
begin
  -- Over: two hours after the later of the start and the end (a window written to end past midnight reads as ending
  -- before it starts; its start then counts).
  update sessions s set status = 'closed'
   where s.status in ('open', 'full')
     and s.session_date::date <= (now() at time zone 'Asia/Riyadh')::date
     and (select greatest(w.starts_at, w.ends_at) from _session_window(s) w) + interval '2 hours' <= now();
  get diagnostics _n = row_count;

  -- A timed opening that has come, on a session still ahead. A deleted one is never opened.
  update sessions s set status = 'open'
   where s.opens_at is not null
     and s.opens_at <= now()
     and s.status = 'closed'
     and (select greatest(w.starts_at, w.ends_at) from _session_window(s) w) > now();
  get diagnostics _m = row_count;

  -- A timed opening left on a night that has ended is dropped, so it is not shown as pending for ever.
  update sessions s set opens_at = null
   where s.opens_at is not null
     and s.opens_at <= now()
     and (select greatest(w.starts_at, w.ends_at) from _session_window(s) w) <= now();

  return _n + _m;
end $function$;
revoke execute on function public._sessions_tick() from public, anon, authenticated;

do $cron$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'mm-sessions-tick';
  perform cron.schedule('mm-sessions-tick', '*/5 * * * *', $j$select public._sessions_tick()$j$);
end $cron$;

-- Staff already hold table-level select / insert / update on sessions; named too, so a later move to column grants
-- keeps them.
grant select (series_id, draft, opens_at), insert (series_id, draft, opens_at), update (series_id, draft, opens_at)
  on public.sessions to authenticated;

-- ── Checks ───────────────────────────────────────────────────────────────────────────────────
do $chk$
begin
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'sessions'
         and column_name in ('series_id', 'draft', 'opens_at')) <> 3 then
    raise exception 'series_id / draft / opens_at missing';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public._sessions_tick()'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '_sessions_tick lost SECURITY DEFINER or its search_path';
  end if;
  if has_function_privilege('anon', 'public._sessions_tick()', 'execute')
     or has_function_privilege('authenticated', 'public._sessions_tick()', 'execute') then
    raise exception '_sessions_tick is executable by a client role';
  end if;
  if not exists (select 1 from cron.job where jobname = 'mm-sessions-tick') then
    raise exception 'the sessions timer is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261107110000', 'sessions_review')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- ── Read-only checks after applying ──────────────────────────────────────────────────────────
--   select column_name, data_type, column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'sessions' and column_name in ('series_id','draft','opens_at');
--   select jobname, schedule, command from cron.job where jobname = 'mm-sessions-tick';
--   select status, count(*) from public.sessions where session_date::date < (now() at time zone 'Asia/Riyadh')::date
--    group by status;                                                         -- no 'open' / 'full' after the first tick
--   select id, status, opens_at from public.sessions where opens_at is not null order by opens_at;
--   select * from cron.job_run_details where command like '%_sessions_tick%' order by start_time desc limit 5;
