-- Scheduled reports, kept in the app (staff app research 2026-10-09, M15). There is no e-mail channel (the
-- owner declined Brevo), so the database writes the reports on a timer and staff read them in Analytics >
-- Reports, print them or send them on WhatsApp; the bell says "Daily close-out ready".
--
-- report_snapshots: one row per report and period. kind 'daily_closeout' (one ride day: period_from =
--   period_to) or 'weekly_kpi' (Saturday to Friday). data is the report itself (jsonb, below). Staff read
--   it (is_staff()); no client writes it: report_snapshot_make() does, and an admin may delete a row.
-- _report_snapshot_data(kind, from, to)  builds data from _mt_core (20261009180000) and the session rows:
--   daily_closeout {totals, sessions:[{id,title,time,capacity,booked,rides,noshows,cancelled,fares,unpaid,
--                    sales}], till:{paid,house,team,refunded,voided,discount}}
--   weekly_kpi     {totals, prev (the week before), last_year (the same dates a year earlier),
--                    occupancy, by_day:[{date,rides}]}
-- report_snapshot_make(kind, day)  writes (or rewrites) the snapshot for the ride day before p_day (KSA)
--   or, weekly, the seven days before it; nothing for a day with no session. The timer calls it with no
--   arguments; an admin may call it from the app (a signed-in non-admin is refused; anon cannot execute it).
-- pg_cron (installed here): 'mm-daily-closeout' at 22:00 UTC = 01:00 KSA, the ride day just ended;
--   'mm-weekly-kpi' Saturdays 05:00 UTC = 08:00 KSA, the week Saturday to Friday just ended.
--
-- Rollback: select cron.unschedule('mm-daily-closeout'); select cron.unschedule('mm-weekly-kpi');
--   drop function public.report_snapshot_make(text, date); drop function public._report_snapshot_data(text, date, date);
--   drop function public._rs_time(text);
--   drop table public.report_snapshots;

begin;

create extension if not exists pg_cron with schema pg_catalog;

create table if not exists public.report_snapshots (
  id           bigint generated always as identity primary key,
  kind         text not null check (kind in ('daily_closeout', 'weekly_kpi')),
  period_from  date not null,
  period_to    date not null check (period_to >= period_from),
  data         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  unique (kind, period_from, period_to)
);
create index if not exists report_snapshots_created_idx on public.report_snapshots (created_at desc);

alter table public.report_snapshots enable row level security;
drop policy if exists "report_snapshots staff read" on public.report_snapshots;
create policy "report_snapshots staff read" on public.report_snapshots
  for select to authenticated using ((select is_staff()));
drop policy if exists "report_snapshots admin delete" on public.report_snapshots;
create policy "report_snapshots admin delete" on public.report_snapshots
  for delete to authenticated using ((select is_admin()));
revoke all on public.report_snapshots from anon, authenticated;
grant select, delete on public.report_snapshots to authenticated;

-- a session's start time off its bike_slots text ('' when it has none or does not parse)
create or replace function public._rs_time(p text)
returns text
language plpgsql
immutable
set search_path to 'public'
as $fn$
begin
  return coalesce(p::jsonb->>'_time', '');
exception when others then
  return '';
end
$fn$;
revoke all on function public._rs_time(text) from public, anon, authenticated;

create or replace function public._report_snapshot_data(p_kind text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
declare
  v_tot jsonb; v_prev jsonb; v_ly jsonb; v_sess jsonb; v_till jsonb; v_days jsonb;
  d1 text := to_char(p_from, 'YYYY-MM-DD'); d2 text := to_char(p_to, 'YYYY-MM-DD');
  v_len int := p_to - p_from + 1;
begin
  select to_jsonb(t) - 'month' into v_tot from _mt_core(p_from, p_to) t where t.month = 'total';
  if p_kind = 'daily_closeout' then
    select coalesce(jsonb_agg(x order by x->>'time', x->>'id'), '[]'::jsonb) into v_sess from (
      select jsonb_build_object(
        'id', s.id, 'title', coalesce(nullif(s.title, ''), s.ride_kind, s.day), 'time', _rs_time(s.bike_slots),
        'capacity', coalesce(s.capacity, 12),
        'booked', count(q.id) filter (where q.status in ('waiting', 'active', 'done', 'noshow')),
        'rides', count(q.id) filter (where q.status = 'done'),
        'noshows', count(q.id) filter (where q.status = 'noshow'),
        'cancelled', count(q.id) filter (where q.status = 'cancelled'),
        -- the fares taken (paid and still standing; add-ons are in the day's totals)
        'fares', coalesce(sum(coalesce(q.price, 57.5)) filter (where q.paid and q.status not in ('cancelled', 'removed')), 0),
        'unpaid', count(q.id) filter (where q.status = 'done' and not coalesce(q.paid, false)),
        'sales', coalesce((select sum(coalesce(c.qty, 0) * coalesce(c.price, 0)) from cashier_sales c
                           where c.session_id = s.id and c.pay = 'paid' and c.voided_at is null
                             and c.category is distinct from '__cardmeta__'), 0)
      ) as x
      from sessions s left join queue_entries q on q.session_id = s.id
      where s.status is distinct from 'deleted' and left(s.session_date, 10) between d1 and d2
      group by s.id
    ) z;
    select jsonb_build_object(
      'paid', coalesce(sum(coalesce(qty, 0) * coalesce(price, 0)) filter (where pay = 'paid' and category is distinct from '__cardmeta__' and category is distinct from '__discount__' and voided_at is null), 0),
      'house', coalesce(sum(coalesce(qty, 0) * coalesce(price, 0)) filter (where pay = 'house' and voided_at is null), 0),
      'team', coalesce(sum(coalesce(qty, 0) * coalesce(price, 0)) filter (where pay = 'team' and voided_at is null), 0),
      'refunded', coalesce(sum(coalesce(qty, 0) * coalesce(price, 0)) filter (where pay = 'refunded' and category is distinct from '__cardmeta__'), 0),
      'voided', count(distinct coalesce(receipt_id, id)) filter (where voided_at is not null),
      'discount', coalesce(-sum(coalesce(qty, 0) * coalesce(price, 0)) filter (where category = '__discount__' and pay = 'paid' and voided_at is null), 0)
    ) into v_till
    from cashier_sales c
    where c.session_id in (select id from sessions where status is distinct from 'deleted' and left(session_date, 10) between d1 and d2)
       or (c.session_id is null and left(c.created_at, 10) between d1 and d2);
    return jsonb_build_object('totals', coalesce(v_tot, '{}'::jsonb), 'sessions', v_sess, 'till', v_till);
  end if;
  -- weekly
  select to_jsonb(t) - 'month' into v_prev from _mt_core(p_from - v_len, p_from - 1) t where t.month = 'total';
  select to_jsonb(t) - 'month' into v_ly from _mt_core((p_from - interval '1 year')::date, (p_to - interval '1 year')::date) t where t.month = 'total';
  select coalesce(jsonb_agg(jsonb_build_object('date', d, 'rides', r) order by d), '[]'::jsonb) into v_days from (
    select left(s.session_date, 10) as d, count(q.id) filter (where q.status = 'done') as r
    from sessions s left join queue_entries q on q.session_id = s.id
    where s.status is distinct from 'deleted' and left(s.session_date, 10) between d1 and d2
    group by 1
  ) z;
  return jsonb_build_object('totals', coalesce(v_tot, '{}'::jsonb), 'prev', coalesce(v_prev, '{}'::jsonb), 'last_year', coalesce(v_ly, '{}'::jsonb),
    'occupancy', case when coalesce((v_tot->>'seats')::int, 0) > 0 then round(100.0 * (v_tot->>'rides')::int / (v_tot->>'seats')::int) else 0 end,
    'by_day', v_days);
end
$fn$;
revoke all on function public._report_snapshot_data(text, date, date) from public, anon, authenticated;

create or replace function public.report_snapshot_make(p_kind text default 'daily_closeout', p_day date default null)
returns bigint
language plpgsql
volatile
security definer
set search_path to 'public'
as $fn$
declare
  v_today date := coalesce(p_day, (now() at time zone 'Asia/Riyadh')::date);
  v_from date; v_to date; v_id bigint;
begin
  if auth.uid() is not null and not coalesce((select is_admin()), false) then
    raise exception 'ADMIN_ONLY: admins only' using errcode = '42501';
  end if;
  if p_kind = 'daily_closeout' then
    v_from := v_today - 1; v_to := v_from;
    if not exists (select 1 from sessions where status is distinct from 'deleted' and left(session_date, 10) = to_char(v_from, 'YYYY-MM-DD')) then
      return null; -- no ride that day: no close-out
    end if;
  elsif p_kind = 'weekly_kpi' then
    v_to := v_today - 1; v_from := v_to - 6;
  else
    raise exception 'BAD_KIND: unknown report' using errcode = '22023';
  end if;
  insert into report_snapshots (kind, period_from, period_to, data)
  values (p_kind, v_from, v_to, _report_snapshot_data(p_kind, v_from, v_to))
  on conflict (kind, period_from, period_to) do update set data = excluded.data, created_at = now()
  returning id into v_id;
  return v_id;
end
$fn$;
revoke all on function public.report_snapshot_make(text, date) from public, anon;
grant execute on function public.report_snapshot_make(text, date) to authenticated;

-- the timers (named, so running this file again replaces them)
do $cron$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('mm-daily-closeout', 'mm-weekly-kpi');
  perform cron.schedule('mm-daily-closeout', '0 22 * * *', $j$select public.report_snapshot_make('daily_closeout')$j$);
  perform cron.schedule('mm-weekly-kpi', '0 5 * * 6', $j$select public.report_snapshot_make('weekly_kpi')$j$);
end $cron$;

do $chk$
begin
  if has_table_privilege('anon', 'public.report_snapshots', 'select')
     or has_table_privilege('authenticated', 'public.report_snapshots', 'insert') then
    raise exception 'report_snapshots is open to the wrong roles';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.report_snapshot_make(text, date)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public._report_snapshot_data(text, date, date)'::regprocedure)
     or has_function_privilege('anon', 'public.report_snapshot_make(text, date)', 'execute') then
    raise exception 'the report functions carry the wrong attributes';
  end if;
  if (select count(*) from cron.job where jobname in ('mm-daily-closeout', 'mm-weekly-kpi')) <> 2 then
    raise exception 'the report timers are missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009181000', 'report_snapshots')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
