-- A member's own titles say the day each one was earned (new features build F12 "Share a badge or milestone"; the owner
-- marked it Build now on 2026-11-13). The share picture of a title shows that day, as a badge's does.
--
-- customer_my_titles answered id, name, name_ar, color, auto and expires_on for each title the member holds. It now also
-- answers "at", a day on Riyadh's calendar (YYYY-MM-DD):
--   a title staff gave    the day it was given (customer_titles.given_at; the earliest, where merged accounts both hold it)
--   an automatic title    the day of the Saturday ride night that reached its count (titles.auto_rides), the nights
--                         counted as _saturday_nights counts them: finished bookings on Saturday rides, a night once
-- Nothing else changes: the same caller check (the rider's own token), the same member check, the same titles in the
-- same order, and still nothing about anyone else. No table, column, grant or policy is touched.
--
-- The app works before this runs: without "at" the picture leaves the day out.
-- Header copied from 20261102200000_member_titles.sql (function attributes trap).
--
-- Rollback: run the customer_my_titles definition from 20261102200000_member_titles.sql again.

begin;

create or replace function public.customer_my_titles(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_accts text[]; v_pref member_prefs%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', true, 'member', false); end if;
  select array_agg(c.id) into v_accts from customers c where c.id = p_id or c.merged_into = p_id;
  select * into v_pref from member_prefs where customer_id = p_id;
  return jsonb_build_object('ok', true, 'member', true, 'hidden', coalesce(v_pref.hidden, false), 'shown', v_pref.shown_title_id,
    'titles', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name, 'name_ar', h.name_ar, 'color', h.color,
                                 'auto', h.auto, 'expires_on', h.expires_on,
                                 'at', case when h.auto then
                                         (select z.d from (select distinct s.id, left(s.session_date, 10) as d
                                                             from queue_entries q join sessions s on s.id = q.session_id
                                                            where q.customer_id = any(v_accts) and q.status = 'done' and s.ride_kind = 'saturday') z
                                           order by z.d, z.id offset greatest(h.auto_rides, 1) - 1 limit 1)
                                       else
                                         (select to_char(min(ct.given_at) at time zone 'Asia/Riyadh', 'YYYY-MM-DD') from customer_titles ct
                                           where ct.title_id = h.id and ct.customer_id = any(v_accts))
                                       end)
                                 order by h.auto, h.sort, h.auto_rides desc nulls last, h.name)
                         from _titles_held(v_accts, _saturday_nights(v_accts)) h), '[]'::jsonb));
end $$;
revoke execute on function public.customer_my_titles(text, text) from public;
grant  execute on function public.customer_my_titles(text, text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114081200', 'title_earned_date')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select (select p.prosecdef from pg_proc p where p.oid = 'public.customer_my_titles(text, text)'::regprocedure) as definer_true,
       (select p.provolatile from pg_proc p where p.oid = 'public.customer_my_titles(text, text)'::regprocedure) as volatility_s,
       has_function_privilege('anon', 'public.customer_my_titles(text, text)', 'execute') as anon_can_run_true,
       position('''at''' in pg_get_functiondef('public.customer_my_titles(text, text)'::regprocedure)) > 0 as answers_at_true,
       (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity) as no_rls_0,
       (select version from supabase_migrations.schema_migrations where version = '20261114081200') as ledger;
