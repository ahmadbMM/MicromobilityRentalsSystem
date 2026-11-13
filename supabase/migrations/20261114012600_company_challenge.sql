-- ============================================================================
-- Company challenge, totals only (new features build F26; the owner marked it Build now on 2026-11-13).
--
-- A company's people ride towards one number. Staff make a challenge (the company's name, a join code, a first and a
-- last day, a minimum team size, 5 unless they say otherwise); a rider joins it with the code, typed on Account >
-- Company challenge or carried by a link (experiences.micromobility.sa/?company=CODE). A rider who joined sees how
-- many are taking part and how many sessions they finished together, only once the people taking part reach the
-- minimum team size, and their own count. Members see nobody (2026-11-04): nothing a rider can read names a
-- colleague, lists one or holds one colleague's count, and the minimum is never under 3, so a total is never one
-- other person's number. Once the last day has passed, everyone who took part with at least one finished session
-- holds the Company Challenge badge. A reward is a badge only.
--
--  1. Tables, with row level security on and no grant: every read and write goes through the functions below.
--       company_challenges         one challenge: company, code (4 to 12 capital letters and digits, one challenge
--                                  each), starts_on, ends_on, min_team (3 to 500, default 5), who made it, and when
--                                  its badges were last given (awarded_at).
--       company_challenge_members  who joined: one row per challenge and account.
--     Companies are not a table today: the corporate nights name theirs in rider_registrations.company and
--     corporate_roster.company, from the staff list (settings 'rider_companies'). A challenge keeps the name as
--     text too, and the staff dialog offers that list.
--  2. The badge: bd_company_challenge (slug company_challenge), the app's own (it draws and words it in every
--     language; the columns here are the English and Arabic fallback), seen only by its holders (held_only).
--  3. Helpers no client can call:
--       _cc_people(challenge)  each person in a challenge once (an account merged into another reads as the one
--                              that kept it), with the sessions they finished (status done, any kind, a session
--                              once) on session dates from the first day to the last.
--       _cc_award(challenge)   gives the badge to everyone with one finished session or more in each challenge
--                              whose last day has passed in Riyadh; run again for 45 days, so a night closed out
--                              late still counts. null = every such challenge. Run daily by pg_cron where the
--                              extension is installed, and by the reads below.
--  4. For riders (anon key; the account's id and session token, checked by _cust_token_ok):
--       company_challenge_mine(p_id, p_token)          {ok, open, rows: [{id, company, starts_on, ends_on, state,
--                                                      team, sessions, mine, badge}]}; team and sessions are null
--                                                      while fewer than min_team are taking part. A challenge
--                                                      leaves the answer 60 days after its last day. open says
--                                                      only whether any challenge can still be joined: the app
--                                                      shows its row then, or when the rider has a challenge.
--       company_challenge_join(p_id, p_token, p_code)  the same answer with joined (the challenge's id), or
--                                                      {ok: false, error: 'code' | 'ended' | 'busy' | 'denied'}.
--                                                      Wrong codes are metered per network (20 in ten minutes).
--  5. For staff who open People (_staff_mod('community'); the writes need its edit right):
--       staff_company_challenges()                     every challenge with its totals and the riders who joined
--                                                      (name, mobile, joined, sessions, badge).
--       staff_company_challenge_save(p_id, p_company, p_code, p_starts, p_ends, p_min)
--                                                      makes one (p_id null) or changes one; {ok, id} or
--                                                      {ok: false, error: 'fields' | 'taken' | 'gone'}.
--       staff_company_challenge_delete(p_id)           deletes one and who joined it; badges given stay.
--       staff_company_challenge_remove(p_challenge, p_customer)   takes one rider out of one challenge.
--
-- Safe before or after the app: until this runs the app shows no Company challenge row and staff read "Waiting for
-- the database update". After it, riders see the row only once staff have made a first challenge.
--
-- Rollback:
--   select cron.unschedule(jobid) from cron.job where jobname = 'mm-company-challenge';
--   drop function if exists public.staff_company_challenge_remove(bigint, text), public.staff_company_challenge_delete(bigint),
--     public.staff_company_challenge_save(bigint, text, text, date, date, integer), public.staff_company_challenges(),
--     public.company_challenge_join(text, text, text), public.company_challenge_mine(text, text),
--     public._cc_award(bigint), public._cc_people(bigint);
--   drop table if exists public.company_challenge_members, public.company_challenges;
--   delete from public.customer_badges where badge_id = 'bd_company_challenge';
--   delete from public.badges where id = 'bd_company_challenge';
--   delete from supabase_migrations.schema_migrations where version = '20261114012600';
-- Idempotent.
-- ============================================================================

begin;

-- 1. tables ------------------------------------------------------------------------------------------------------

create table if not exists public.company_challenges (
  id          bigint generated always as identity primary key,
  company     text not null check (char_length(btrim(company)) between 1 and 80),
  code        text not null check (code ~ '^[A-Z0-9]{4,12}$'),
  starts_on   date not null,
  ends_on     date not null,
  min_team    integer not null default 5 check (min_team between 3 and 500),
  created_at  timestamptz not null default now(),
  created_by  text check (char_length(created_by) <= 60),
  awarded_at  timestamptz,
  constraint company_challenges_dates check (ends_on >= starts_on)
);
create unique index if not exists company_challenges_code_uq on public.company_challenges (code);

create table if not exists public.company_challenge_members (
  challenge_id bigint not null references public.company_challenges(id) on delete cascade,
  customer_id  text not null references public.customers(id) on delete cascade,
  joined_at    timestamptz not null default now(),
  primary key (challenge_id, customer_id)
);
create index if not exists company_challenge_members_customer on public.company_challenge_members (customer_id);

alter table public.company_challenges enable row level security;
alter table public.company_challenge_members enable row level security;
revoke all on public.company_challenges from public, anon, authenticated;
revoke all on public.company_challenge_members from public, anon, authenticated;
revoke all on sequence public.company_challenges_id_seq from public, anon, authenticated;

-- 2. the badge ---------------------------------------------------------------------------------------------------

alter table public.badges add column if not exists held_only boolean not null default false; -- 20261112223000's, for a database without it

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort, held_only) values
  ('bd_company_challenge', 'company_challenge', 'briefcase', 'blue', 'Company Challenge', 'تحدي الشركة',
   'Take part in your company''s challenge.', 'شارك في تحدي شركتك.', true, false, 275, true)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = false, retired = false,
  sort = excluded.sort, held_only = true;

-- 3. helpers -----------------------------------------------------------------------------------------------------

create or replace function public._cc_people(p_challenge bigint)
 returns table (pid text, joined_at timestamptz, n integer)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with ch as (select c.starts_on, c.ends_on from company_challenges c where c.id = p_challenge),
  ppl as (
    select coalesce(u.merged_into, u.id) as pid, min(m.joined_at) as joined_at
      from company_challenge_members m join customers u on u.id = m.customer_id
     where m.challenge_id = p_challenge
     group by 1),
  done as (
    select p.pid, count(distinct q.session_id)::integer as n
      from ppl p
      join customers a on a.id = p.pid or a.merged_into = p.pid
      join queue_entries q on q.customer_id = a.id and q.status = 'done'
      join sessions s on s.id = q.session_id
      cross join ch
     where s.session_date >= to_char(ch.starts_on, 'YYYY-MM-DD') and s.session_date <= to_char(ch.ends_on, 'YYYY-MM-DD')
     group by p.pid)
  select p.pid, p.joined_at, coalesce(d.n, 0)
    from ppl p left join done d on d.pid = p.pid
$function$;
revoke all on function public._cc_people(bigint) from public, anon, authenticated;

create or replace function public._cc_award(p_challenge bigint default null)
 returns integer
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
  ch record; v_all integer := 0; v_got integer;
begin
  if not exists (select 1 from badges where id = 'bd_company_challenge' and not retired) then return 0; end if;
  for ch in select c.id, c.company from company_challenges c
             where c.ends_on < v_today and c.ends_on >= v_today - 45
               and (p_challenge is null or c.id = p_challenge) loop
    insert into customer_badges (customer_id, badge_id, note, awarded_by)
    select p.pid, 'bd_company_challenge', left(ch.company, 140), 'system'
      from _cc_people(ch.id) p
     where p.n >= 1
    on conflict do nothing;
    get diagnostics v_got = row_count;
    v_all := v_all + v_got;
    update company_challenges set awarded_at = now() where id = ch.id;
  end loop;
  return v_all;
end $function$;
revoke all on function public._cc_award(bigint) from public, anon, authenticated;

-- 4. riders ------------------------------------------------------------------------------------------------------
-- What a rider reads: their own challenges, their own count, and the two totals from the minimum team size up.
-- No name, no list, nobody else's count.

create or replace function public.company_challenge_mine(p_id text, p_token text)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
  v_me text; v_accts text[]; ch record; v_rows jsonb := '[]'::jsonb;
  v_team integer; v_sum integer; v_mine integer;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  v_me := coalesce((select u.merged_into from customers u where u.id = p_id), p_id);
  v_accts := array_append(coalesce((select array_agg(x.id) from customers x where x.merged_into = v_me), '{}'::text[]), v_me);
  for ch in select c.* from company_challenges c
             where c.ends_on >= v_today - 60
               and exists (select 1 from company_challenge_members m where m.challenge_id = c.id and m.customer_id = any(v_accts))
             order by c.ends_on, c.id loop
    if ch.ends_on < v_today and ch.ends_on >= v_today - 45
       and (ch.awarded_at is null or ch.awarded_at < now() - interval '6 hours') then
      perform _cc_award(ch.id);
    end if;
    select count(*)::integer, coalesce(sum(p.n), 0)::integer, coalesce(max(p.n) filter (where p.pid = v_me), 0)::integer
      into v_team, v_sum, v_mine
      from _cc_people(ch.id) p;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'id', ch.id, 'company', ch.company, 'starts_on', ch.starts_on, 'ends_on', ch.ends_on,
      'state', case when v_today < ch.starts_on then 'soon' when v_today > ch.ends_on then 'ended' else 'on' end,
      'team', case when v_team >= ch.min_team then v_team end,
      'sessions', case when v_team >= ch.min_team then v_sum end,
      'mine', v_mine,
      'badge', v_today > ch.ends_on and v_mine >= 1
               and exists (select 1 from customer_badges b where b.customer_id = any(v_accts) and b.badge_id = 'bd_company_challenge')));
  end loop;
  return jsonb_build_object('ok', true, 'rows', v_rows,
    'open', exists (select 1 from company_challenges c where c.ends_on >= v_today));
end $function$;
revoke all on function public.company_challenge_mine(text, text) from public;
grant execute on function public.company_challenge_mine(text, text) to anon, authenticated;

-- A wrong code counts against the network (20 in ten minutes, then locked for ten); a right one does not, so an
-- office joining from one address is not locked out. While locked, no code is tried at all.
create or replace function public.company_challenge_join(p_id text, p_token text, p_code text)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_id bigint; v_ends date;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if exists (select 1 from login_throttle t where t.identifier = 'cojoin:' || _client_ip() and t.locked_until > now()) then
    return jsonb_build_object('ok', false, 'error', 'busy');
  end if;
  if v_code ~ '^[A-Z0-9]{4,12}$' then
    select c.id, c.ends_on into v_id, v_ends from company_challenges c where c.code = v_code;
  end if;
  if v_id is null then
    if not _ip_gate('cojoin', 20, interval '10 minutes') then return jsonb_build_object('ok', false, 'error', 'busy'); end if;
    return jsonb_build_object('ok', false, 'error', 'code');
  end if;
  if v_ends < v_today then return jsonb_build_object('ok', false, 'error', 'ended'); end if;
  insert into company_challenge_members (challenge_id, customer_id) values (v_id, p_id) on conflict do nothing;
  return company_challenge_mine(p_id, p_token) || jsonb_build_object('joined', v_id);
end $function$;
revoke all on function public.company_challenge_join(text, text, text) from public;
grant execute on function public.company_challenge_join(text, text, text) to anon, authenticated;

-- 5. staff -------------------------------------------------------------------------------------------------------

create or replace function public.staff_company_challenges()
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
begin
  if not _staff_mod('community', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  perform _cc_award(null);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'company', c.company, 'code', c.code, 'starts_on', c.starts_on, 'ends_on', c.ends_on,
             'min_team', c.min_team, 'created_at', c.created_at, 'created_by', c.created_by, 'awarded_at', c.awarded_at,
             'team', (select count(*) from _cc_people(c.id)),
             'sessions', (select coalesce(sum(p.n), 0) from _cc_people(c.id) p),
             'riders', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id', p.pid, 'name', btrim(u.name), 'phone', u.phone, 'joined_at', p.joined_at, 'n', p.n,
                        'badge', exists (select 1 from customer_badges b where b.customer_id = p.pid and b.badge_id = 'bd_company_challenge'))
                        order by p.n desc, p.joined_at, p.pid)
                 from _cc_people(c.id) p join customers u on u.id = p.pid), '[]'::jsonb))
             order by c.ends_on desc, c.id desc)
      from company_challenges c), '[]'::jsonb);
end $function$;
revoke all on function public.staff_company_challenges() from public, anon;
grant execute on function public.staff_company_challenges() to authenticated;

create or replace function public.staff_company_challenge_save(p_id bigint, p_company text, p_code text, p_starts date, p_ends date, p_min integer default 5)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
declare
  v_co text := btrim(regexp_replace(coalesce(p_company, ''), '\s+', ' ', 'g'));
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_min integer := coalesce(p_min, 5);
  v_id bigint;
begin
  if not _staff_mod('community', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if v_co = '' or char_length(v_co) > 80 or v_code !~ '^[A-Z0-9]{4,12}$' or p_starts is null or p_ends is null
     or p_ends < p_starts or v_min not between 3 and 500 then
    return jsonb_build_object('ok', false, 'error', 'fields');
  end if;
  if exists (select 1 from company_challenges c where c.code = v_code and c.id is distinct from p_id) then
    return jsonb_build_object('ok', false, 'error', 'taken');
  end if;
  if p_id is null then
    insert into company_challenges (company, code, starts_on, ends_on, min_team, created_by)
    values (v_co, v_code, p_starts, p_ends, v_min,
            left(coalesce((select coalesce(nullif(btrim(s.display_name), ''), a.email)
                             from staff s left join auth.users a on a.id = s.user_id
                            where s.user_id = auth.uid()), 'staff'), 60))
    returning id into v_id;
  else
    update company_challenges
       set company = v_co, code = v_code, starts_on = p_starts, ends_on = p_ends, min_team = v_min
     where id = p_id
    returning id into v_id;
    if v_id is null then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'taken');
end $function$;
revoke all on function public.staff_company_challenge_save(bigint, text, text, date, date, integer) from public, anon;
grant execute on function public.staff_company_challenge_save(bigint, text, text, date, date, integer) to authenticated;

create or replace function public.staff_company_challenge_delete(p_id bigint)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
begin
  if not _staff_mod('community', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  delete from company_challenges where id = p_id;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.staff_company_challenge_delete(bigint) from public, anon;
grant execute on function public.staff_company_challenge_delete(bigint) to authenticated;

create or replace function public.staff_company_challenge_remove(p_challenge bigint, p_customer text)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
begin
  if not _staff_mod('community', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  delete from company_challenge_members m
   where m.challenge_id = p_challenge
     and m.customer_id in (select u.id from customers u where u.id = p_customer or u.merged_into = p_customer);
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.staff_company_challenge_remove(bigint, text) from public, anon;
grant execute on function public.staff_company_challenge_remove(bigint, text) to authenticated;

-- 6. the daily run (00:20 in Riyadh), where pg_cron is installed -------------------------------------------------

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'mm-company-challenge';
    perform cron.schedule('mm-company-challenge', '20 21 * * *', $j$select public._cc_award(null)$j$);
  end if;
end $cron$;

-- checks ---------------------------------------------------------------------------------------------------------

do $chk$
declare t text; f record;
begin
  foreach t in array array['company_challenges', 'company_challenge_members'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      raise exception '% has no row level security', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select') then
      raise exception '% is readable past its functions', t;
    end if;
  end loop;
  for f in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'company\_challenge\_%' or p.proname like 'staff\_company\_challenge%' or p.proname like '\_cc\_%') loop
    if not f.prosecdef then raise exception '% is not SECURITY DEFINER', f.proname; end if;
    if not exists (select 1 from unnest(coalesce(f.proconfig, '{}')) c where c like 'search_path=%') then
      raise exception '% has no search_path', f.proname;
    end if;
    if f.proname like '\_cc\_%' and (has_function_privilege('anon', f.oid, 'execute') or has_function_privilege('authenticated', f.oid, 'execute')) then
      raise exception '% is callable from outside', f.proname;
    end if;
    if f.proname like 'staff\_company\_challenge%' and has_function_privilege('anon', f.oid, 'execute') then
      raise exception '% is open to anon', f.proname;
    end if;
    if f.proname like 'company\_challenge\_%' and not has_function_privilege('anon', f.oid, 'execute') then
      raise exception 'the page cannot reach %', f.proname;
    end if;
  end loop;
  if (select count(*) from public.badges where slug = 'company_challenge' and system and not auto and not retired and held_only) <> 1 then
    raise exception 'the Company Challenge badge is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114012600', 'company_challenge')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Read-only check: each column's name says the value it must show.
select
  (select count(*) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relname in ('company_challenges', 'company_challenge_members')
      and c.relrowsecurity) as rls_on_2,
  (select count(*) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.prosecdef
      and p.proname in ('_cc_people', '_cc_award', 'company_challenge_mine', 'company_challenge_join', 'staff_company_challenges',
                        'staff_company_challenge_save', 'staff_company_challenge_delete', 'staff_company_challenge_remove')) as definer_8,
  (select count(*) from public.badges where slug = 'company_challenge' and system and held_only) as badge_1,
  (select count(*) from supabase_migrations.schema_migrations where version = '20261114012600') as ledger_1;
