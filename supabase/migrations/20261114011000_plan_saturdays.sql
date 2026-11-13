-- Plan my Saturdays (new features build F10; the owner marked it Build now on 2026-11-13): on the Community tab, beside
-- the monthly challenge, the current month's Saturdays as tick boxes. A tick books nothing and holds no place: it stores
-- that the member plans to come. When booking opens for a ticked Saturday's ride the member gets one "booking is open"
-- message through the message store (push_outbox), so it is on their Updates list and, for a member who switched
-- Community notifications on, goes out as a push. Never for a member who has already booked it; never twice.
--
-- APPLY AFTER the Community reach migrations (community_reach, push_consent) and the Updates list (20261114010300):
-- this file writes push_outbox.key / args and push_words, and refuses to run without them.
--
--  1. hub_plans: one row per member and ticked Saturday. Nobody reads the table: no policy, no grant, staff included.
--     A member's ticks come back only from their own token-checked read.
--  2. hub_plan(p_id, p_token): the current month's Saturdays (Riyadh), each with whether the member ticked it and whether
--     it is already gone. hub_plan_set(p_id, p_token, p_date, p_on): ticks or unticks one; a Saturday before today, or
--     outside the current month, is refused.
--  3. _hub_plan_window_open(p_day): is that day inside the booking window (site_content 'booking.window'), read as
--     _booking_window_guard reads it.
--  4. _hub_plan_tick, every 10 minutes (mm-hub-plan), between 07:00 and 22:59 Riyadh: for each ticked Saturday not yet
--     told whose Saturday ride (ride_kind 'saturday') is open to riders now (status open, not a draft, not cancelled,
--     not started, inside the booking window): a member with a booking on it is marked told and gets nothing; every
--     other active member gets one push_outbox row (tag hub-plan-YYYYMMDD, so Community's switch decides the push) and
--     is marked told. One row per member and Saturday whatever happens after (push_outbox's own unique tag), so an
--     untick and a new tick say nothing again. Ticks of a month that is over are deleted.
--  5. push_words 'planopen' in all ten languages.
--
-- Nothing of the reach build or the Updates list is redefined here (hub_feed, _hub_push_tick, customer_updates stay as
-- they are): the message is of kind 'info' on the Updates list and leads to the Community tab.
--
-- Rollback:
--   select cron.unschedule('mm-hub-plan');
--   drop function if exists public.hub_plan(text, text), public.hub_plan_set(text, text, text, boolean),
--     public._hub_plan_tick(), public._hub_plan_window_open(date);
--   delete from public.push_outbox where tag like 'hub-plan-%';
--   delete from public.push_words where key = 'planopen';
--   drop table if exists public.hub_plans;

begin;

do $need$
begin
  if to_regclass('public.push_words') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'push_outbox' and column_name = 'key') then
    raise exception 'plan_saturdays: apply the Community reach migrations and the Updates list (20261114010300) first';
  end if;
end $need$;

-- ── 1. the ticks ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.hub_plans (
  customer_id text not null references public.customers (id) on update cascade on delete cascade,
  plan_date   date not null check (extract(isodow from plan_date) = 6),
  created_at  timestamptz not null default now(),
  told_at     timestamptz,
  primary key (customer_id, plan_date)
);
comment on table public.hub_plans is
  'Plan my Saturdays (20261114011000): a member ticked this Saturday. It books nothing. told_at: the "booking is open" message was sent, or was not needed (already booked). Read only by hub_plan for the member themselves.';
create index if not exists hub_plans_wait_idx on public.hub_plans (plan_date) where told_at is null;
alter table public.hub_plans enable row level security;
revoke all on public.hub_plans from public, anon, authenticated;

-- ── 2. the member's own read and write ─────────────────────────────────────────────────────────
create or replace function public.hub_plan(p_id text, p_token text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_today date := _ksa_today(); v_month date := date_trunc('month', _ksa_today())::date; v_accts text[];
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  v_accts := _accts_of(p_id);
  return jsonb_build_object('ok', true, 'today', to_char(v_today, 'YYYY-MM-DD'), 'month', to_char(v_month, 'YYYY-MM'),
    'days', (select coalesce(jsonb_agg(jsonb_build_object(
                      'date', to_char(g.d, 'YYYY-MM-DD'),
                      'on', exists (select 1 from hub_plans p where p.customer_id = any(v_accts) and p.plan_date = g.d),
                      'past', g.d < v_today) order by g.d), '[]'::jsonb)
               from (select s.x::date as d
                       from generate_series(v_month::timestamp, v_month::timestamp + interval '1 month' - interval '1 day', interval '1 day') as s(x)) g
              where extract(isodow from g.d) = 6));
end $$;
revoke all on function public.hub_plan(text, text) from public;
grant execute on function public.hub_plan(text, text) to anon, authenticated;

create or replace function public.hub_plan_set(p_id text, p_token text, p_date text, p_on boolean)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_today date := _ksa_today(); v_month date := date_trunc('month', _ksa_today())::date; v_day date;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  if p_on is null or p_date is null or p_date !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'date'); end if;
  begin v_day := p_date::date; exception when others then return jsonb_build_object('ok', false, 'error', 'date'); end;
  -- a Saturday of the current month only
  if extract(isodow from v_day) <> 6 or v_day < v_month or v_day >= (v_month + interval '1 month')::date then
    return jsonb_build_object('ok', false, 'error', 'date');
  end if;
  -- a Saturday already gone is shown, never changed
  if v_day < v_today then return jsonb_build_object('ok', false, 'error', 'past'); end if;
  if p_on then
    if not exists (select 1 from hub_plans p where p.customer_id = any(_accts_of(p_id)) and p.plan_date = v_day) then
      insert into hub_plans (customer_id, plan_date) values (p_id, v_day) on conflict (customer_id, plan_date) do nothing;
    end if;
  else
    delete from hub_plans where customer_id = any(_accts_of(p_id)) and plan_date = v_day;
  end if;
  return jsonb_build_object('ok', true, 'date', to_char(v_day, 'YYYY-MM-DD'), 'on', p_on);
end $$;
revoke all on function public.hub_plan_set(text, text, text, boolean) from public;
grant execute on function public.hub_plan_set(text, text, text, boolean) to anon, authenticated;

-- ── 3. is a day inside the booking window ──────────────────────────────────────────────────────
-- site_content 'booking.window' = {"days": N, "at": "HH:MM"}: a ride more than N days ahead is not open to riders; on
-- the day it comes within reach it opens at the hour given (Riyadh). No window, or a malformed one, holds nobody. The
-- same reading as _booking_window_guard (20261028200000), which refuses the booking itself.
create or replace function public._hub_plan_window_open(p_day date)
returns boolean
language plpgsql stable security definer set search_path to 'public'
as $$
declare w jsonb; days int; at_t text; today date := (now() at time zone 'Asia/Riyadh')::date; open_day date;
begin
  if p_day is null then return false; end if;
  select value into w from site_content where key = 'booking.window';
  if w is null or jsonb_typeof(w) <> 'object' then return true; end if;
  begin days := (w->>'days')::int; exception when others then days := null; end;
  if days is null or days < 0 then return true; end if;
  at_t := nullif(w->>'at', '');
  open_day := p_day - days;
  if open_day > today then return false; end if;
  if open_day = today and at_t ~ '^\d{2}:\d{2}$' and to_char(now() at time zone 'Asia/Riyadh', 'HH24:MI') < at_t then
    return false;
  end if;
  return true;
end $$;
revoke all on function public._hub_plan_window_open(date) from public, anon, authenticated;

-- ── 4. the words ────────────────────────────────────────────────────────────────────────────────
-- {0} is the day of the month: with "Saturday" it names one day, in every language, with no month to translate.
insert into public.push_words (key, lang, title, body) values
  ('planopen', 'en', 'Booking is open', 'Saturday {0}: book your place'),
  ('planopen', 'ar', 'الحجز مفتوح', 'السبت {0}: احجز مكانك'),
  ('planopen', 'fr', 'Les réservations sont ouvertes', 'Samedi {0} : réservez votre place'),
  ('planopen', 'es', 'Reservas abiertas', 'Sábado {0}: reserva tu plaza'),
  ('planopen', 'pt', 'Reservas abertas', 'Sábado {0}: reserve a sua vaga'),
  ('planopen', 'ur', 'بکنگ کھل گئی ہے', 'ہفتہ {0}: اپنی جگہ بک کریں'),
  ('planopen', 'hi', 'बुकिंग खुल गई है', 'शनिवार {0}: अपनी जगह बुक करें'),
  ('planopen', 'tl', 'Bukas na ang booking', 'Sabado {0}: i-book ang puwesto mo'),
  ('planopen', 'ne', 'बुकिङ खुल्यो', 'शनिबार {0}: आफ्नो ठाउँ बुक गर्नुहोस्'),
  ('planopen', 'bn', 'বুকিং খোলা হয়েছে', 'শনিবার {0}: আপনার জায়গা বুক করুন')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- ── 5. booking opened for a ticked Saturday: one message ───────────────────────────────────────
create or replace function public._hub_plan_tick()
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_ksa timestamp := now() at time zone 'Asia/Riyadh'; v_today date := (now() at time zone 'Asia/Riyadh')::date;
  v_n int := 0; d record; r record; t record; v_date text; v_day text;
begin
  -- a month that is over has nothing left to tell
  delete from hub_plans where plan_date < date_trunc('month', v_today)::date;
  -- waking hours only: a ride opened at night is told in the morning
  if extract(hour from v_ksa) < 7 or extract(hour from v_ksa) >= 23 then return 0; end if;

  for d in select distinct p.plan_date from hub_plans p where p.told_at is null and p.plan_date >= v_today loop
    if not _hub_plan_window_open(d.plan_date) then continue; end if;
    v_date := to_char(d.plan_date, 'YYYY-MM-DD');
    -- that Saturday's ride, open to riders now and not yet started
    if not exists (select 1 from sessions x cross join lateral _session_window(x) w
                    where x.ride_kind = 'saturday' and x.session_date = v_date
                      and x.status = 'open' and not coalesce(x.draft, false)
                      and x.cancelled_at is null and x.ride_status is distinct from 'cancelled'
                      and w.starts_at > now()) then
      continue;
    end if;
    v_day := extract(day from d.plan_date)::int::text;

    for r in select p.customer_id, coalesce(c.merged_into, c.id) as to_id
               from hub_plans p join customers c on c.id = p.customer_id
              where p.plan_date = d.plan_date and p.told_at is null loop
      -- a member whose membership lapsed is told nothing; the tick waits for them
      if not _member_active(r.to_id) then continue; end if;
      -- already booked (the waitlist counts): nothing to tell, now or later
      if exists (select 1 from queue_entries q join sessions x on x.id = q.session_id
                  where x.ride_kind = 'saturday' and x.session_date = v_date
                    and q.customer_id = any(_accts_of(r.to_id))
                    and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')) then
        update hub_plans set told_at = now() where customer_id = r.customer_id and plan_date = d.plan_date;
        continue;
      end if;
      select * into t from _push_text(r.to_id, 'planopen', array[v_day]);
      insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
      values (r.to_id, 'hub-plan-' || to_char(d.plan_date, 'YYYYMMDD'), left(coalesce(t.title, 'Booking is open'), 120), left(coalesce(t.body, ''), 300),
              '/members?src=push', 'community', 'planopen', array[v_day])
      on conflict (customer_id, tag) do nothing;
      if found then v_n := v_n + 1; end if;
      update hub_plans set told_at = now() where customer_id = r.customer_id and plan_date = d.plan_date;
    end loop;
  end loop;
  return v_n;
end $$;
revoke all on function public._hub_plan_tick() from public, anon, authenticated;

select cron.schedule('mm-hub-plan', '*/10 * * * *', 'select public._hub_plan_tick()');

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114011000', 'plan_saturdays')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity) as no_rls_0,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('hub_plan', 'hub_plan_set', '_hub_plan_window_open', '_hub_plan_tick')) as definer_4,
       has_function_privilege('anon', 'public.hub_plan(text,text)', 'execute') as anon_read_true,
       has_function_privilege('anon', 'public.hub_plan_set(text,text,text,boolean)', 'execute') as anon_set_true,
       has_function_privilege('anon', 'public._hub_plan_tick()', 'execute') as anon_tick_false,
       has_table_privilege('anon', 'public.hub_plans', 'select') as anon_table_false,
       has_table_privilege('authenticated', 'public.hub_plans', 'select') as staff_table_false,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'hub_plans') as policies_0,
       (select count(*) from public.push_words where key = 'planopen') as words_10,
       (select count(*) from cron.job where jobname = 'mm-hub-plan') as cron_1,
       (select version from supabase_migrations.schema_migrations where version = '20261114011000') as ledger;
