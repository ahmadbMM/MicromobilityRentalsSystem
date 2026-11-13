-- ============================================================================
-- Reports rework: monthly reports, money for admins, team setups, report numbers and history.
-- For PROD and STAGING.
--
-- The user, 2026-11-12/13 (the reports rework decision page): Size 3 with every piece now; Q10 money for admins only;
-- F1 the reports that are all money are for admins only; Q12 add monthly reports; S3 team setups; S6 report numbers
-- and history; F4 a reprint is an exact copy for money reports and today's data for the rest.
--
-- 1. Monthly reports (S8). report_snapshots takes two more kinds:
--      'monthly_kpi'  one calendar month: the weekly report's figures over the month (totals, occupancy, each day),
--                     with 'prev' the calendar month before (not the 31 days before) and 'last_year' the same month;
--      'month_bill'   one calendar month of company nights: per company every returned ride with its fare (the fare
--                     charged, or _rider_price for a ride with none, as the Billing report does), the fares grouped,
--                     and how many returned rides carry no company (they are on no invoice).
--    report_month_tick() writes both for the month just ended. pg_cron calls it every night at 22:30 UTC (01:30 KSA);
--    it acts only when the KSA date is the 1st.
-- 2. The snapshots are all money, so only admins read them now (they were open to any staff account).
-- 3. report_setups: a report builder's choices saved under a name, for the team (every staff account sees it) or for
--    oneself. Anyone on staff saves; the one who saved it or an admin changes or deletes it.
-- 4. report_log: one line for each report printed, saved, shared or exported, with its own number
--    MM-<prefix>-<year>-<00001> (counted per prefix and KSA year in report_counters), what was picked to make it
--    (opts, so it can be made again with today's data), who and when. report_copies keeps the page of a money report
--    as printed, for 12 months (pg_cron 'mm-report-copies'). Both are written only through report_log_add(), which
--    refuses a money report to anyone but an admin; a money line and its copy are read by admins only.
--
-- No live table's rows change. Rollback at the end of the file.
-- ============================================================================
begin;

-- ── 1. Monthly reports ─────────────────────────────────────────────────────────────────────────────────────────────
alter table public.report_snapshots drop constraint if exists report_snapshots_kind_check;
alter table public.report_snapshots add constraint report_snapshots_kind_check
  check (kind in ('daily_closeout', 'weekly_kpi', 'monthly_kpi', 'month_bill'));

-- One calendar month of company nights. The rides are rider_registrations rows returned on a night of the month
-- (left(session_id, 10) is the night's date); the company is matched as the client's _riderCo does.
create or replace function public._report_month_bill(p_from date, p_to date)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $fn$
  with r as (
    select rr.session_id, rr.badge, rr.party_no, rr.name, rr.type_preference as type,
           coalesce(rr.price, _rider_price(rr.type_preference)) as fare,
           case lower(btrim(coalesce(rr.company, ''))) when 'petromin' then 'Petromin' when 'petrolube' then 'Petrolube' else '' end as co
      from rider_registrations rr
     where rr.checked_out_at is not null
       and left(rr.session_id, 10) between to_char(p_from, 'YYYY-MM-DD') and to_char(p_to, 'YYYY-MM-DD')
  )
  select jsonb_build_object(
    'companies', coalesce((
      select jsonb_agg(x.c order by x.co)
        from (select r1.co,
                     jsonb_build_object(
                       'name', r1.co, 'rides', count(*), 'total', coalesce(sum(r1.fare), 0),
                       'by_fare', (select coalesce(jsonb_agg(jsonb_build_object('type', f.type, 'fare', f.fare, 'n', f.n) order by f.type, f.fare), '[]'::jsonb)
                                     from (select r2.type, r2.fare, count(*) as n from r r2 where r2.co = r1.co group by r2.type, r2.fare) f),
                       'rows', jsonb_agg(jsonb_build_object('session_id', r1.session_id, 'badge', r1.badge, 'party_no', r1.party_no,
                                                            'name', r1.name, 'type', r1.type, 'fare', r1.fare)
                                         order by r1.session_id, r1.badge, r1.party_no)) as c
                from r r1 where r1.co <> '' group by r1.co) x), '[]'::jsonb),
    'no_company', (select count(*) from r where r.co = ''));
$fn$;
revoke all on function public._report_month_bill(date, date) from public, anon, authenticated;

-- report_snapshot_make: the definition on prod (20261009181000) with the two monthly kinds added. A monthly kind
-- writes the calendar month before the one p_day falls in.
create or replace function public.report_snapshot_make(p_kind text default 'daily_closeout'::text, p_day date default null::date)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_today date := coalesce(p_day, (now() at time zone 'Asia/Riyadh')::date);
  v_from date; v_to date; v_id bigint; v_data jsonb;
begin
  if auth.uid() is not null and not coalesce((select is_admin()), false) then
    raise exception 'ADMIN_ONLY: admins only' using errcode = '42501';
  end if;
  if p_kind = 'daily_closeout' then
    v_from := v_today - 1; v_to := v_from;
    if not exists (select 1 from sessions where status is distinct from 'deleted' and left(session_date, 10) = to_char(v_from, 'YYYY-MM-DD')) then
      return null;
    end if;
    v_data := _report_snapshot_data(p_kind, v_from, v_to);
  elsif p_kind = 'weekly_kpi' then
    v_to := v_today - 1; v_from := v_to - 6;
    v_data := _report_snapshot_data(p_kind, v_from, v_to);
  elsif p_kind in ('monthly_kpi', 'month_bill') then
    v_from := (date_trunc('month', v_today) - interval '1 month')::date;
    v_to := (date_trunc('month', v_today) - interval '1 day')::date;
    if p_kind = 'monthly_kpi' then
      v_data := _report_snapshot_data('weekly_kpi', v_from, v_to)
        || jsonb_build_object('prev', coalesce((select to_jsonb(t) - 'month' from _mt_core((v_from - interval '1 month')::date, v_from - 1) t where t.month = 'total'), '{}'::jsonb));
    else
      v_data := _report_month_bill(v_from, v_to);
    end if;
  else
    raise exception 'BAD_KIND: unknown report' using errcode = '22023';
  end if;
  insert into report_snapshots (kind, period_from, period_to, data)
  values (p_kind, v_from, v_to, v_data)
  on conflict (kind, period_from, period_to) do update set data = excluded.data, created_at = now()
  returning id into v_id;
  return v_id;
end
$function$;
revoke all on function public.report_snapshot_make(text, date) from public, anon;
grant execute on function public.report_snapshot_make(text, date) to authenticated;

-- The nightly tick: on the 1st (KSA) it writes the month just ended. Run by pg_cron only.
create or replace function public.report_month_tick()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
begin
  if extract(day from v_today) <> 1 then
    return;
  end if;
  perform report_snapshot_make('monthly_kpi', v_today);
  perform report_snapshot_make('month_bill', v_today);
end
$fn$;
revoke all on function public.report_month_tick() from public, anon, authenticated;

-- ── 2. The snapshots are money: admins read them ──────────────────────────────────────────────────────────────────
drop policy if exists "report_snapshots staff read" on public.report_snapshots;
drop policy if exists "report_snapshots admin read" on public.report_snapshots;
create policy "report_snapshots admin read" on public.report_snapshots
  for select to authenticated using ((select is_admin()));

-- ── 3. Team setups ───────────────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.report_setups (
  id          uuid primary key default gen_random_uuid(),
  report      text not null check (report ~ '^[a-z][a-z0-9_]{0,39}$'),
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  scope       text not null default 'team' check (scope in ('team', 'mine')),
  opts        jsonb not null default '{}'::jsonb check (jsonb_typeof(opts) = 'object' and pg_column_size(opts) <= 32768),
  created_by  uuid not null default auth.uid(),
  by_name     text check (char_length(by_name) <= 80),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists report_setups_team_name on public.report_setups (report, lower(btrim(name))) where scope = 'team';
create unique index if not exists report_setups_mine_name on public.report_setups (report, created_by, lower(btrim(name))) where scope = 'mine';
alter table public.report_setups enable row level security;
drop policy if exists "report_setups read" on public.report_setups;
create policy "report_setups read" on public.report_setups
  for select to authenticated using ((select is_staff()) and (scope = 'team' or created_by = (select auth.uid())));
drop policy if exists "report_setups add" on public.report_setups;
create policy "report_setups add" on public.report_setups
  for insert to authenticated with check ((select is_staff()) and created_by = (select auth.uid()));
drop policy if exists "report_setups change" on public.report_setups;
create policy "report_setups change" on public.report_setups
  for update to authenticated
  using ((select is_staff()) and (created_by = (select auth.uid()) or (select is_admin())))
  with check ((select is_staff()) and (created_by = (select auth.uid()) or (select is_admin())));
drop policy if exists "report_setups remove" on public.report_setups;
create policy "report_setups remove" on public.report_setups
  for delete to authenticated using ((select is_staff()) and (created_by = (select auth.uid()) or (select is_admin())));
revoke all on public.report_setups from anon;
grant select, insert, update, delete on public.report_setups to authenticated;

-- ── 4. Report numbers and history ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.report_counters (
  prefix  text not null check (prefix ~ '^[A-Z]{2,4}$'),
  yr      int not null,
  n       int not null default 0,
  primary key (prefix, yr)
);
alter table public.report_counters enable row level security; -- no policy: only report_log_add touches it
revoke all on public.report_counters from anon, authenticated;

create table if not exists public.report_log (
  id       bigint generated always as identity primary key,
  no       text not null unique,
  report   text not null check (report ~ '^[a-z][a-z0-9_]{0,39}$'),
  title    text not null default '' check (char_length(title) <= 200),
  opts     jsonb not null default '{}'::jsonb check (jsonb_typeof(opts) = 'object' and pg_column_size(opts) <= 32768),
  money    boolean not null default false,
  via      text not null default 'print' check (via in ('print', 'pdf', 'share', 'xlsx', 'csv')),
  rows     int,
  by_user  uuid default auth.uid(),
  by_name  text check (char_length(by_name) <= 80),
  at       timestamptz not null default now()
);
create index if not exists report_log_at_idx on public.report_log (at desc);
alter table public.report_log enable row level security;
drop policy if exists "report_log read" on public.report_log;
create policy "report_log read" on public.report_log
  for select to authenticated using ((select is_staff()) and (not money or (select is_admin())));
drop policy if exists "report_log admin delete" on public.report_log;
create policy "report_log admin delete" on public.report_log
  for delete to authenticated using ((select is_admin()));
revoke all on public.report_log from anon;
revoke insert, update on public.report_log from authenticated;
grant select, delete on public.report_log to authenticated;

create table if not exists public.report_copies (
  log_id  bigint primary key references public.report_log(id) on delete cascade,
  html    text not null check (octet_length(html) <= 3000000),
  at      timestamptz not null default now()
);
alter table public.report_copies enable row level security;
drop policy if exists "report_copies admin read" on public.report_copies;
create policy "report_copies admin read" on public.report_copies
  for select to authenticated using ((select is_admin()));
revoke all on public.report_copies from anon;
revoke insert, update, delete on public.report_copies from authenticated;
grant select on public.report_copies to authenticated;

-- A report's number and its history line. p_copy (the printed page) is kept only for a money report.
create or replace function public.report_log_add(
  p_report text, p_prefix text, p_title text default '', p_opts jsonb default '{}'::jsonb, p_money boolean default false,
  p_via text default 'print', p_rows integer default null, p_copy text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_yr int := extract(year from (now() at time zone 'Asia/Riyadh'))::int;
  v_n int; v_no text; v_id bigint;
begin
  if not coalesce((select is_staff()), false) then
    raise exception 'STAFF_ONLY: staff only' using errcode = '42501';
  end if;
  if coalesce(p_money, false) and not coalesce((select is_admin()), false) then
    raise exception 'ADMIN_ONLY: money reports are for admins' using errcode = '42501';
  end if;
  if p_prefix is null or p_prefix !~ '^[A-Z]{2,4}$' then
    raise exception 'BAD_PREFIX: unknown report prefix' using errcode = '22023';
  end if;
  insert into report_counters (prefix, yr, n) values (p_prefix, v_yr, 1)
  on conflict (prefix, yr) do update set n = report_counters.n + 1
  returning n into v_n;
  v_no := 'MM-' || p_prefix || '-' || v_yr || '-' || lpad(v_n::text, 5, '0');
  insert into report_log (no, report, title, opts, money, via, rows, by_user, by_name)
  values (v_no, p_report, left(coalesce(p_title, ''), 200), coalesce(p_opts, '{}'::jsonb), coalesce(p_money, false),
          coalesce(p_via, 'print'), p_rows, auth.uid(),
          left((select nullif(btrim(display_name), '') from staff where user_id = auth.uid()), 80))
  returning id into v_id;
  if p_copy is not null and coalesce(p_money, false) then
    insert into report_copies (log_id, html) values (v_id, p_copy);
  end if;
  return jsonb_build_object('id', v_id, 'no', v_no);
end
$fn$;
revoke all on function public.report_log_add(text, text, text, jsonb, boolean, text, integer, text) from public, anon;
grant execute on function public.report_log_add(text, text, text, jsonb, boolean, text, integer, text) to authenticated;

-- ── The timers (named, so running this file again replaces them) ─────────────────────────────────────────────────
do $cron$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('mm-monthly-reports', 'mm-report-copies');
  perform cron.schedule('mm-monthly-reports', '30 22 * * *', $j$select public.report_month_tick()$j$);
  perform cron.schedule('mm-report-copies', '50 0 * * *', $j$delete from public.report_copies where at < now() - interval '12 months'$j$);
end $cron$;

-- ── Checks ───────────────────────────────────────────────────────────────────────────────────────────────────────
do $chk$
begin
  if exists (select 1 from pg_class where relnamespace = 'public'::regnamespace
              and relname in ('report_setups', 'report_counters', 'report_log', 'report_copies') and not relrowsecurity) then
    raise exception 'a new report table has row level security off';
  end if;
  if has_table_privilege('anon', 'public.report_snapshots', 'select')
     or has_table_privilege('anon', 'public.report_setups', 'select')
     or has_table_privilege('anon', 'public.report_log', 'select')
     or has_table_privilege('authenticated', 'public.report_log', 'insert')
     or has_table_privilege('authenticated', 'public.report_copies', 'insert')
     or has_table_privilege('authenticated', 'public.report_counters', 'select') then
    raise exception 'a report table is open to the wrong roles';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.report_snapshot_make(text, date)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.report_log_add(text, text, text, jsonb, boolean, text, integer, text)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public._report_month_bill(date, date)'::regprocedure)
     or has_function_privilege('authenticated', 'public._report_month_bill(date, date)', 'execute')
     or has_function_privilege('authenticated', 'public.report_month_tick()', 'execute')
     or has_function_privilege('anon', 'public.report_log_add(text, text, text, jsonb, boolean, text, integer, text)', 'execute') then
    raise exception 'the report functions carry the wrong attributes';
  end if;
  if (select count(*) from cron.job where jobname in ('mm-daily-closeout', 'mm-weekly-kpi', 'mm-monthly-reports', 'mm-report-copies')) <> 4 then
    raise exception 'the report timers are missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261113120000', 'reports_rework')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- ============================================================================
-- Rollback (run by hand if this has to come out):
--   select cron.unschedule('mm-monthly-reports'); select cron.unschedule('mm-report-copies');
--   drop function public.report_month_tick(); drop function public._report_month_bill(date, date);
--   drop function public.report_log_add(text, text, text, jsonb, boolean, text, integer, text);
--   drop table public.report_copies, public.report_log, public.report_counters, public.report_setups;
--   delete from public.report_snapshots where kind in ('monthly_kpi', 'month_bill');
--   alter table public.report_snapshots drop constraint report_snapshots_kind_check;
--   alter table public.report_snapshots add constraint report_snapshots_kind_check check (kind in ('daily_closeout', 'weekly_kpi'));
--   drop policy "report_snapshots admin read" on public.report_snapshots;
--   create policy "report_snapshots staff read" on public.report_snapshots for select to authenticated using ((select is_staff()));
--   report_snapshot_make: its block in 20261009181000_report_snapshots.sql.
-- ============================================================================
