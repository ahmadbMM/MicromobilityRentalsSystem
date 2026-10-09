-- ============================================================================
-- Data retention (Staff app research 2026-10-09, M19), 2026-10-09.
--
-- How long each log is kept is a setting (Settings > Business, staff_options 'biz' -> 'retention'):
--   staff_actions, customer_activity, audit_log, site_content_history: months (default 24)
--   error_log: days (default 90)
--   anon_years: anonymise rider accounts with no activity for that many years (default 0 = off)
-- A row older than its table's limit is deleted once a day by pg_cron (job 'mm-retention',
-- 00:30 UTC = 03:30 in Jeddah), and when an admin presses Purge now (staff_purge_old) after
-- seeing what it would remove (staff_purge_preview).
--
-- Anonymising (only when anon_years is set): an account created that long ago with no booking,
-- sale or activity since, not merged, with nothing live, keeps its id and the facts the reports
-- count (gender, nationality, country, city, type, created_at) and loses everything that names or
-- reaches the person: name -> 'Former Rider', email, phone, WhatsApp, photo, birth date, emergency
-- contacts, socials, workplace, profession, Apple relay address, the sign-in (password and session);
-- its old bookings' name, phone and email go the same way. The audit_log rows that still hold the
-- old values fall to the audit_log limit like every other row.
--
-- The privacy notice is NOT changed here (the booking app's text says backups are kept 7 days);
-- whether it should name these periods is the owner's call.
--
-- Rollback: select cron.unschedule('mm-retention'); drop function public.staff_purge_old(),
--   public.staff_purge_preview(), public._purge_old(boolean), public._ret_cut(text,text,int).
--   (pg_cron itself may stay installed.)
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create extension if not exists pg_cron;

-- The cut-off for one table: now less its setting, else less its default.
create or replace function public._ret_cut(p_key text, p_unit text, p_default int)
returns timestamptz
language sql stable security definer set search_path to 'public'
as $$
  select now() - make_interval(
    months => case when p_unit = 'm' then n else 0 end,
    days   => case when p_unit = 'd' then n else 0 end)
  from (select coalesce((
          select case when jsonb_typeof(o.items -> 'retention' -> p_key) = 'number'
                       and (o.items -> 'retention' ->> p_key)::numeric between (case when p_unit = 'm' then 1 else 7 end)
                                                                          and (case when p_unit = 'm' then 120 else 3650 end)
                      then (o.items -> 'retention' ->> p_key)::numeric::int end
            from staff_options o where o.key = 'biz'), p_default) as n) x
$$;
revoke execute on function public._ret_cut(text, text, int) from public, anon, authenticated;

-- Does the work, or only counts it (p_dry). Not for clients: the cron job and the two RPCs below.
create or replace function public._purge_old(p_dry boolean)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  c_sa timestamptz := _ret_cut('staff_actions', 'm', 24);
  c_ca timestamptz := _ret_cut('customer_activity', 'm', 24);
  c_al timestamptz := _ret_cut('audit_log', 'm', 24);
  c_sh timestamptz := _ret_cut('site_content_history', 'm', 24);
  c_el timestamptz := _ret_cut('error_log', 'd', 90);
  yrs int := coalesce((select case when jsonb_typeof(o.items -> 'retention' -> 'anon_years') = 'number'
                                    and (o.items -> 'retention' ->> 'anon_years')::numeric between 1 and 20
                                   then (o.items -> 'retention' ->> 'anon_years')::numeric::int end
                         from staff_options o where o.key = 'biz'), 0);
  n_sa int; n_ca int; n_al int; n_sh int; n_el int; n_an int := 0; ids text[];
begin
  if p_dry then
    select count(*) into n_sa from staff_actions
     where coalesce(at_server, case when at ~ '^\d{4}-\d{2}-\d{2}' then left(at, 10)::date::timestamptz end) < c_sa;
    select count(*) into n_ca from customer_activity where at < c_ca;
    select count(*) into n_al from audit_log where at < c_al;
    select count(*) into n_sh from site_content_history where changed_at < c_sh;
    select count(*) into n_el from error_log where case when at ~ '^\d{4}-\d{2}-\d{2}' then left(at, 10)::date::timestamptz end < c_el;
  else
    delete from staff_actions
     where coalesce(at_server, case when at ~ '^\d{4}-\d{2}-\d{2}' then left(at, 10)::date::timestamptz end) < c_sa;
    get diagnostics n_sa = row_count;
    delete from customer_activity where at < c_ca;              get diagnostics n_ca = row_count;
    delete from audit_log where at < c_al;                      get diagnostics n_al = row_count;
    delete from site_content_history where changed_at < c_sh;   get diagnostics n_sh = row_count;
    delete from error_log where case when at ~ '^\d{4}-\d{2}-\d{2}' then left(at, 10)::date::timestamptz end < c_el;
    get diagnostics n_el = row_count;
  end if;

  if yrs >= 1 then
    select array_agg(c.id) into ids
      from customers c
     where c.merged_into is null
       and c.created_at ~ '^\d{4}-\d{2}-\d{2}' and left(c.created_at, 10)::date < (now() - make_interval(years => yrs))::date
       and not (c.name = 'Former Rider' and c.email is null and c.phone is null)
       and not exists (select 1 from queue_entries q where q.customer_id = c.id
                        and (q.status in ('waiting', 'waitlist', 'active')
                             or (q.session_date ~ '^\d{4}-\d{2}-\d{2}' and left(q.session_date, 10)::date > (now() - make_interval(years => yrs))::date)))
       and not exists (select 1 from cashier_sales s where s.customer_id = c.id
                        and (s.created_at !~ '^\d{4}-\d{2}-\d{2}' or left(s.created_at, 10)::date > (now() - make_interval(years => yrs))::date))
       and not exists (select 1 from customer_activity a where a.customer_id = c.id and a.at > now() - make_interval(years => yrs));
    n_an := coalesce(array_length(ids, 1), 0);
    if not p_dry and n_an > 0 then
      update customers set name = 'Former Rider', email = null, phone = null, whatsapp = null, whatsapp_same = null,
             photo = null, birth_date = null, emergency_name = null, emergency_phone = null, emergency_relation = null,
             emergency2_name = null, emergency2_phone = null, emergency2_relation = null, socials = null,
             workplace = null, profession = null, apple_email = null, session_token = null,
             password_hash = 'anonymised'
       where id = any(ids);
      update queue_entries set name = 'Former Rider', phone = null, email = null where customer_id = any(ids);
    end if;
  end if;

  if not p_dry then
    insert into staff_actions (at, action, who, device, view, user_id)
      values (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              format('Retention purge: actions %s, customer activity %s, audit %s, website history %s, errors %s, anonymised %s',
                     n_sa, n_ca, n_al, n_sh, n_el, n_an),
              'server', 'server', 'settings', auth.uid());
  end if;
  return jsonb_build_object('staff_actions', n_sa, 'customer_activity', n_ca, 'audit_log', n_al,
                            'site_content_history', n_sh, 'error_log', n_el, 'anon', n_an);
end $$;
revoke execute on function public._purge_old(boolean) from public, anon, authenticated;

create or replace function public.staff_purge_preview()
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  return _purge_old(true);
end $$;
revoke execute on function public.staff_purge_preview() from public, anon;
grant execute on function public.staff_purge_preview() to authenticated;

create or replace function public.staff_purge_old()
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  return _purge_old(false);
end $$;
revoke execute on function public.staff_purge_old() from public, anon;
grant execute on function public.staff_purge_old() to authenticated;

-- Once a day, 00:30 UTC (03:30 in Jeddah, when no ride is on).
do $cr$
begin
  if exists (select 1 from cron.job where jobname = 'mm-retention') then
    perform cron.unschedule('mm-retention');
  end if;
  perform cron.schedule('mm-retention', '30 0 * * *', 'select public._purge_old(false)');
end $cr$;

do $chk$
declare f text;
begin
  foreach f in array array['public._purge_old(boolean)', 'public.staff_purge_preview()', 'public.staff_purge_old()', 'public._ret_cut(text,text,integer)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public._purge_old(boolean)', 'execute') then
    raise exception '_purge_old is executable by a client';
  end if;
  if not exists (select 1 from cron.job where jobname = 'mm-retention') then raise exception 'mm-retention is not scheduled'; end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009165000', 'retention')
on conflict (version) do nothing;

commit;
