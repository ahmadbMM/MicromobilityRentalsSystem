-- The "My month" card on the Community tab (new features build F13; the owner marked it Build now on 2026-11-13).
--
-- From the 26th to the end of each month, a member with two or more finished sessions that month sees one card of their
-- own month: the Saturdays they rode, their sessions by kind, the badges they earned this month, and one comparison
-- with their own month before. Private: every number is the caller's own; nothing compares them with anyone, and no
-- club number is read.
--
--  1. site_content 'hub.month.from': the first day the card may appear, a date as a JSON string. Seeded as
--     "2026-12-26", so the weekly Saturday recap (20261114000100, R13) has run for a month first. An admin can change
--     the row (site_content's own admin policies) and so can a later migration:
--       update public.site_content set value = '"2027-01-26"'::jsonb, updated_by = 'migration' where key = 'hub.month.from';
--     A missing row, or a value that is not a date, reads as 26 December 2026.
--  2. hub_month(p_id, p_token): the card's one read. The rider's own token is checked first; a rider who is not an
--     active member, a day before the first day, a day before the 26th (Riyadh's calendar) and a month with fewer
--     than two finished sessions all answer {ok: true, show: false} and nothing else. Otherwise:
--       today, from, month   the day, the first day, the month's first day
--       sessions             finished sessions this month, a session once across the member's merged accounts (_hub_n)
--       saturdays            the days of the Saturday rides among them
--       kinds                [{k, n}]: sessions by ride kind, 'rental' for a circuit night, as the year recap names them
--       badges               badges whose first award falls in this month (customer_badges, a badge once)
--       prev                 {month, sessions}: the whole month before; null for a member with no finished session
--                            before this month (there is no previous month of theirs to compare with)
--     It reads only; nothing is written.
--
-- The app works before this runs: without the function the Community tab shows no card and no error.
-- New function, so no earlier header to copy; its attributes are those of customer_my_titles (stable, security definer).
--
-- Rollback:
--   drop function if exists public.hub_month(text, text);
--   delete from public.site_content where key = 'hub.month.from';

begin;

insert into public.site_content (key, value, updated_by)
values ('hub.month.from', '"2026-12-26"'::jsonb, 'migration')
on conflict (key) do nothing;

create or replace function public.hub_month(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_today date := _ksa_today();
  v_month date := date_trunc('month', _ksa_today())::date;
  v_end date := (date_trunc('month', _ksa_today()) + interval '1 month' - interval '1 day')::date;
  v_prev date := (date_trunc('month', _ksa_today()) - interval '1 month')::date;
  v_raw text; v_from date;
  v_accts text[];
  v_n int; v_sats int; v_kinds jsonb; v_badges int;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', true, 'show', false); end if;

  -- the first day the card may appear
  select sc.value #>> '{}' into v_raw from site_content sc where sc.key = 'hub.month.from';
  begin
    v_from := v_raw::date;
  exception when others then
    v_from := null;
  end;
  v_from := coalesce(v_from, date '2026-12-26');
  if v_today < v_from or extract(day from v_today) < 26 then return jsonb_build_object('ok', true, 'show', false); end if;

  v_accts := _accts_of(p_id);
  with mine as (
    select distinct q.session_id, left(s.session_date, 10) as d, coalesce(s.ride_kind, 'rental') as kind
      from queue_entries q join sessions s on s.id = q.session_id
     where q.customer_id = any(v_accts) and q.status = 'done'
       and s.session_date >= to_char(v_month, 'YYYY-MM-DD') and s.session_date <= to_char(v_end, 'YYYY-MM-DD'))
  select count(*)::int,
         (count(distinct m.d) filter (where m.kind = 'saturday'))::int,
         (select jsonb_agg(jsonb_build_object('k', k.kind, 'n', k.n) order by k.n desc, k.kind)
            from (select m2.kind, count(*)::int as n from mine m2 group by m2.kind) k)
    into v_n, v_sats, v_kinds
    from mine m;
  if coalesce(v_n, 0) < 2 then return jsonb_build_object('ok', true, 'show', false); end if;

  select count(*)::int into v_badges
    from (select cb.badge_id, min(cb.awarded_at) as at from customer_badges cb
           where cb.customer_id = any(v_accts) group by cb.badge_id) x
   where (x.at at time zone 'Asia/Riyadh')::date between v_month and v_end;

  return jsonb_build_object('ok', true, 'show', true,
    'today', v_today, 'from', v_from, 'month', v_month,
    'sessions', v_n, 'saturdays', coalesce(v_sats, 0), 'kinds', coalesce(v_kinds, '[]'::jsonb), 'badges', coalesce(v_badges, 0),
    'prev', case when _hub_n(v_accts, date '2000-01-01', v_month - 1, false) > 0
                 then jsonb_build_object('month', v_prev, 'sessions', _hub_n(v_accts, v_prev, v_month - 1, false)) end);
end $$;
revoke all on function public.hub_month(text, text) from public;
grant execute on function public.hub_month(text, text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114081300', 'hub_month')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select (select p.prosecdef from pg_proc p where p.oid = 'public.hub_month(text, text)'::regprocedure) as definer_true,
       (select p.provolatile from pg_proc p where p.oid = 'public.hub_month(text, text)'::regprocedure) as volatility_s,
       has_function_privilege('anon', 'public.hub_month(text, text)', 'execute') as anon_can_run_true,
       (select sc.value #>> '{}' from public.site_content sc where sc.key = 'hub.month.from') as first_day_2026_12_26,
       (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity) as no_rls_0,
       (select version from supabase_migrations.schema_migrations where version = '20261114081300') as ledger;
