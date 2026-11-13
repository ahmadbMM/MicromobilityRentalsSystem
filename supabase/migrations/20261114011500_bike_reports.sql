-- ============================================================================
-- Report a bike problem (new features build F15; the owner marked it Build now on 2026-11-13).
--
-- Once a rider is checked in and a bike is on their booking, their ticket shows one button, "Report a bike problem".
-- It opens a centred pop-up with a short list of faults (brakes, gears, tyre, chain, saddle, lights, other) and an
-- optional short note. Sending it makes a row staff see in the Workshop section, behind a "Bike reports" pill in the
-- list that is already there: bike, rider, booking, fault, note, time, open or resolved.
--
--  1. bike_reports: one row per report. Nobody but staff reads it; nobody inserts into it but bike_report below.
--     It keeps no name: the rider is the booking's (or the account's), which staff already hold. A deleted account or
--     booking unlinks the report; a deleted bike takes its reports with it.
--     Staff with Workshop edit rights (_staff_mod('workshop', true), as workshop_jobs since 20261111180200) mark a report resolved or open it
--     again: they may write status and resolved_by, nothing else. _bike_report_stamp dates the change.
--  2. queue_entries.bike_report_at timestamptz: when the rider last reported on this booking. The ticket shows a quiet
--     "Problem reported" chip from it, and a booking row that carries the column is how the page knows this migration
--     has run (until then no button shows). It decides nothing: the limits below are counted from bike_reports.
--     The rider reads it through my_bookings (whole rows of their own bookings); queue_public names its columns, so
--     no other rider ever sees it.
--  3. bike_report(p_id, p_token, p_booking, p_fault, p_note, p_bike): the rider's own booking only. Token-checked.
--     'none'   the booking is not theirs, is not checked in (active or done), or holds no such bike;
--     'closed' more than 3 hours after the session's last time (an end before its start is the next day's);
--     'limit'  a report on this booking in the last 10 minutes, 5 on it already, or 8 from the account in 24 hours.
--     The page closes the pop-up on 'limit' exactly as on a report taken: the rider sees no error.
--
-- Safe before or after the app: until this runs no booking carries bike_report_at, so the ticket shows no button,
-- and the Workshop shows no pill while the table is missing.
--
-- Privacy: a report holds what the rider picked and typed about a bike, linked to their booking and account. The
-- Privacy Notice has no row for it yet (owner's words needed).
--
-- Rollback:
--   drop function if exists public.bike_report(text, text, text, text, text, text);
--   alter table public.queue_entries drop column if exists bike_report_at;
--   drop table if exists public.bike_reports;
--   drop function if exists public._bike_report_stamp();
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $pre$
begin
  if to_regprocedure('public._staff_mod(text, boolean)') is null or to_regprocedure('public._session_window(public.sessions)') is null
     or to_regprocedure('public._cust_token_ok(text, text)') is null then
    raise exception 'bike_reports: _staff_mod (20261009150000), _session_window or _cust_token_ok is missing on this database';
  end if;
end $pre$;

-- ── 1. the reports ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.bike_reports (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  bike_id     text not null references public.bikes(id) on delete cascade,
  booking_id  text references public.queue_entries(id) on delete set null,
  customer_id text references public.customers(id) on delete set null,
  session_id  text,
  fault       text not null check (fault in ('brakes', 'gears', 'tyre', 'chain', 'saddle', 'lights', 'other')),
  note        text check (note is null or char_length(note) <= 300),
  status      text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at timestamptz,
  resolved_by text check (resolved_by is null or char_length(resolved_by) <= 120),
  updated_at  timestamptz not null default now()
);
comment on table public.bike_reports is
  'A rider''s report of a fault on the bike of their own booking (bike_report, 20261114011500). Staff read it in the Workshop section and mark it resolved.';
create index if not exists bike_reports_status_created on public.bike_reports (status, created_at desc);
create index if not exists bike_reports_booking on public.bike_reports (booking_id) where booking_id is not null;
create index if not exists bike_reports_customer_created on public.bike_reports (customer_id, created_at) where customer_id is not null;
create index if not exists bike_reports_bike on public.bike_reports (bike_id);

alter table public.bike_reports enable row level security;
drop policy if exists "bike reports staff read" on public.bike_reports;
create policy "bike reports staff read" on public.bike_reports for select to authenticated
  using ((select public.is_staff()));
drop policy if exists "bike reports staff update" on public.bike_reports;
create policy "bike reports staff update" on public.bike_reports for update to authenticated
  using ((select public._staff_mod('workshop', true))) with check ((select public._staff_mod('workshop', true)));
revoke all on public.bike_reports from public, anon, authenticated;
grant select on public.bike_reports to authenticated;
grant update (status, resolved_by) on public.bike_reports to authenticated;
revoke all on sequence public.bike_reports_id_seq from public, anon, authenticated;

-- Dates a change, and a resolution: when, and by whom when the page named nobody.
create or replace function public._bike_report_stamp()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  new.updated_at := now();
  if new.status = 'resolved' and old.status is distinct from 'resolved' then
    new.resolved_at := now();
    if coalesce(new.resolved_by, '') = '' then
      new.resolved_by := left(coalesce(auth.jwt() ->> 'email', 'staff'), 120);
    end if;
  elsif new.status = 'open' then
    new.resolved_at := null;
    new.resolved_by := null;
  end if;
  return new;
end $function$;
revoke all on function public._bike_report_stamp() from public, anon, authenticated;

drop trigger if exists bike_reports_stamp on public.bike_reports;
create trigger bike_reports_stamp before update on public.bike_reports
  for each row execute function public._bike_report_stamp();

-- ── 2. the booking remembers its last report ────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists bike_report_at timestamptz;
comment on column public.queue_entries.bike_report_at is
  'When the rider last reported a problem with this booking''s bike (bike_report, 20261114011500). For the ticket''s chip only; the limits are counted from bike_reports.';

-- ── 3. the rider's report ──────────────────────────────────────────────────────────────────────
create or replace function public.bike_report(p_id text, p_token text, p_booking text, p_fault text,
                                              p_note text default null, p_bike text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; s sessions%rowtype; v_from timestamptz; v_to timestamptz;
  v_bikes text[] := '{}'; v_bike text; v_note text; v_last timestamptz; v_at timestamptz;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if p_fault is null or p_fault not in ('brakes', 'gears', 'tyre', 'chain', 'saddle', 'lights', 'other') then
    return jsonb_build_object('ok', false, 'error', 'fault');
  end if;
  -- the caller's own booking, checked in; locked, so two sends at once are counted one after the other
  select * into q from queue_entries where id = p_booking and customer_id = p_id for update;
  if not found or q.status not in ('active', 'done') then return jsonb_build_object('ok', false, 'error', 'none'); end if;
  -- the booking's bike, or bikes (assigned_bike_id is one id, or a JSON array of them)
  begin
    if q.assigned_bike_id like '[%' then
      select coalesce(array_agg(x), '{}') into v_bikes from jsonb_array_elements_text(q.assigned_bike_id::jsonb) x;
    elsif nullif(trim(q.assigned_bike_id), '') is not null then
      v_bikes := array[q.assigned_bike_id];
    end if;
  exception when others then v_bikes := '{}';
  end;
  v_bike := coalesce(nullif(trim(p_bike), ''), v_bikes[1]);
  if v_bike is null or not (v_bike = any(v_bikes)) or not exists (select 1 from bikes b where b.id = v_bike) then
    return jsonb_build_object('ok', false, 'error', 'none');
  end if;
  -- until 3 hours after the session's last time
  select * into s from sessions where id = q.session_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  select w.starts_at, w.ends_at into v_from, v_to from _session_window(s) w;
  if v_to < v_from then v_to := v_to + interval '1 day'; end if; -- a session that runs past midnight
  if v_from is null or now() >= greatest(v_from, coalesce(v_to, v_from)) + interval '3 hours' then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  -- the limits: one report on a booking every 10 minutes, 5 on a booking, 8 from an account in 24 hours
  select max(r.created_at) into v_last from bike_reports r where r.booking_id = q.id;
  if v_last > now() - interval '10 minutes'
     or (select count(*) from bike_reports r where r.booking_id = q.id) >= 5
     or (select count(*) from bike_reports r where r.customer_id = p_id and r.created_at > now() - interval '24 hours') >= 8 then
    return jsonb_build_object('ok', false, 'error', 'limit', 'at', v_last);
  end if;
  v_note := nullif(left(trim(regexp_replace(coalesce(p_note, ''), '\s+', ' ', 'g')), 300), '');
  insert into bike_reports (bike_id, booking_id, customer_id, session_id, fault, note)
  values (v_bike, q.id, p_id, q.session_id, p_fault, v_note)
  returning created_at into v_at;
  -- the ticket's chip; the report stands whatever a trigger on the booking says about this stamp
  begin
    update queue_entries set bike_report_at = v_at where id = q.id;
  exception when others then null;
  end;
  return jsonb_build_object('ok', true, 'at', v_at);
end $$;
revoke all on function public.bike_report(text, text, text, text, text, text) from public;
grant execute on function public.bike_report(text, text, text, text, text, text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114011500', 'bike_reports')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = 'bike_reports' and c.relrowsecurity) as rls_on_1,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'bike_reports') as policies_2,
       has_table_privilege('anon', 'public.bike_reports', 'select') as anon_read_false,
       has_table_privilege('authenticated', 'public.bike_reports', 'insert') as staff_insert_false,
       has_column_privilege('authenticated', 'public.bike_reports', 'status', 'update') as staff_status_true,
       has_column_privilege('authenticated', 'public.bike_reports', 'note', 'update') as staff_note_false,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'queue_entries' and column_name = 'bike_report_at') as column_1,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef and proname = 'bike_report') as definer_1,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and not prosecdef and proname = '_bike_report_stamp') as invoker_1,
       has_function_privilege('anon', 'public.bike_report(text,text,text,text,text,text)', 'execute') as anon_report_true,
       has_function_privilege('anon', 'public._bike_report_stamp()', 'execute') as anon_stamp_false,
       (select count(*) from pg_trigger where tgname = 'bike_reports_stamp' and not tgisinternal) as trigger_1,
       (select count(*) from public.bike_reports) as reports_so_far,
       (select version from supabase_migrations.schema_migrations where version = '20261114011500') as ledger;
