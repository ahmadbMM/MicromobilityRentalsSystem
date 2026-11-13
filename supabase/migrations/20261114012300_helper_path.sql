-- ============================================================================
-- Helper path (new features build F23; the owner marked it "Build now" on the decision page, 2026-11-13).
--
-- A path of four steps for community members: rider, helper, trainee ride leader, ride leader. Staff move a member
-- along it with the titles they already give (Community > Titles), and a member's helper days, the days of the
-- volunteer shifts they attended, are counted and shown to that member like their rides.
--
--   titles.path_step       1 helper, 2 trainee ride leader, 3 ride leader; null for every other title. One title per
--                          step, never an automatic one. Three titles are seeded with them (ttl_path_helper,
--                          ttl_path_trainee, ttl_path_leader). A member holding none of them is on the first step, rider.
--   _title_path_one        trigger on customer_titles: giving a path title takes the member's other path titles back,
--                          so a member holds one step and staff can move them either way.
--   _helper_shift_days()   the one rule for an attended shift, as the volunteer portal's own "worked": the session was
--                          not called off, and the shift is done, or accepted with a clock-in. One row per account and
--                          day: interested, accepted without a clock-in, declined, withdrawn, blocked, ended and
--                          no_show never count, and two shifts on one day are one helper day.
--   _helper_days(text[])   helper days of one person's accounts (a keeper and those merged into it).
--   customer_helper_path   the member's own step and helper days, by their id and token. It answers about the caller
--                          alone: no argument names another account, and nothing in the answer does either (members
--                          see nobody). Not a member: {ok, member: false}.
--   staff_helper_days      staff only: helper days by account, for Community > Titles.
--
-- Nothing new is stored about anyone: shifts and titles are already kept.
--
-- Safe before or after the app. Until this runs the app shows no Helper path anywhere: a member's Account has no card
-- (the read is missing) and Community > Titles has no Helper path section (no title carries a step).
--
-- Rollback:
--   drop function if exists public.customer_helper_path(text, text);
--   drop function if exists public.staff_helper_days();
--   drop function if exists public._helper_days(text[]);
--   drop function if exists public._helper_shift_days();
--   drop trigger if exists customer_titles_path_one on public.customer_titles;
--   drop function if exists public._title_path_one();
--   delete from public.customer_titles where title_id in ('ttl_path_helper', 'ttl_path_trainee', 'ttl_path_leader');
--   delete from public.titles where id in ('ttl_path_helper', 'ttl_path_trainee', 'ttl_path_leader');
--   drop index if exists public.titles_path_step_one;
--   alter table public.titles drop constraint if exists titles_path_not_auto, drop constraint if exists titles_path_step_check,
--     drop column if exists path_step;
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

/* -- 1. the steps are titles ------------------------------------------------------------------- */
alter table public.titles add column if not exists path_step smallint;
comment on column public.titles.path_step is
  'Helper path: 1 helper, 2 trainee ride leader, 3 ride leader; null for every other title (20261114012300).';
alter table public.titles drop constraint if exists titles_path_step_check;
alter table public.titles add constraint titles_path_step_check check (path_step between 1 and 3);
alter table public.titles drop constraint if exists titles_path_not_auto;
alter table public.titles add constraint titles_path_not_auto check (path_step is null or auto_rides is null);
create unique index if not exists titles_path_step_one on public.titles (path_step) where path_step is not null;

-- An admin's later change of a name or colour stays: a second run only puts the step back.
-- Sorted after the catalogue (its titles start at 500): a member who never picked the title to show sees the first one
-- held by sort (customer_my_titles), so a step given does not go ahead of another title staff gave them. (Any given
-- title goes ahead of an automatic one; that rule is the catalogue's and is not changed here.)
insert into public.titles (id, name, name_ar, color, path_step, sort) values
  ('ttl_path_helper',  'Helper',              'مساعد',            'teal', 1, 9001),
  ('ttl_path_trainee', 'Trainee ride leader', 'قائد جولة متدرّب', 'blue', 2, 9002),
  ('ttl_path_leader',  'Ride leader',         'قائد الجولة',      'gold', 3, 9003)
on conflict (id) do update set path_step = excluded.path_step, auto_rides = null;

-- One step at a time: the path title just given is the member's step, the others go back.
create or replace function public._title_path_one()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if exists (select 1 from titles t where t.id = new.title_id and t.path_step is not null) then
    delete from customer_titles ct
     where ct.customer_id = new.customer_id and ct.title_id <> new.title_id
       and ct.title_id in (select t.id from titles t where t.path_step is not null);
  end if;
  return null;
end $function$;
revoke all on function public._title_path_one() from public, anon, authenticated;

drop trigger if exists customer_titles_path_one on public.customer_titles;
create trigger customer_titles_path_one
  after insert or update on public.customer_titles
  for each row execute function public._title_path_one();


/* -- 2. helper days ---------------------------------------------------------------------------- */
-- Attended shifts only, one row per account and day.
create or replace function public._helper_shift_days()
 returns table (customer_id text, day text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select distinct sh.customer_id, coalesce(nullif(left(s.session_date, 10), ''), s.id)
    from volunteer_shifts sh
    join sessions s on s.id = sh.session_id
   where s.cancelled_at is null
     and (sh.status = 'done' or (sh.status = 'accepted' and sh.clock_in is not null));
$function$;
revoke all on function public._helper_shift_days() from public, anon, authenticated;

create or replace function public._helper_days(p_accts text[])
 returns integer
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select count(distinct d.day)::integer from _helper_shift_days() d where d.customer_id = any(p_accts);
$function$;
revoke all on function public._helper_days(text[]) from public, anon, authenticated;


/* -- 3. the member's own step and helper days -------------------------------------------------- */
create or replace function public.customer_helper_path(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_accts text[]; v_step integer;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', true, 'member', false); end if;
  select array_agg(c.id) into v_accts from customers c where c.id = p_id or c.merged_into = p_id;
  -- The path title held, not past its last day (Riyadh's calendar); the newest when merged accounts brought two.
  select t.path_step into v_step
    from customer_titles ct join titles t on t.id = ct.title_id
   where ct.customer_id = any(v_accts) and t.path_step is not null
     and (ct.expires_on is null or ct.expires_on >= (now() at time zone 'Asia/Riyadh')::date)
   order by ct.given_at desc, t.path_step desc limit 1;
  return jsonb_build_object('ok', true, 'member', true, 'step', coalesce(v_step, 0), 'days', _helper_days(v_accts));
end $function$;
revoke all on function public.customer_helper_path(text, text) from public;
grant execute on function public.customer_helper_path(text, text) to anon, authenticated;


/* -- 4. staff: helper days per account ---------------------------------------------------------- */
create or replace function public.staff_helper_days()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not coalesce(is_staff(), false) then raise exception 'not staff' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('customer_id', y.keeper, 'days', y.n) order by y.n desc, y.keeper)
      from (select coalesce(c.merged_into, c.id) as keeper, count(distinct d.day)::integer as n
              from _helper_shift_days() d join customers c on c.id = d.customer_id
             group by 1) y), '[]'::jsonb);
end $function$;
revoke all on function public.staff_helper_days() from public, anon;
grant execute on function public.staff_helper_days() to authenticated;


do $chk$
declare f record;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'titles' and column_name = 'path_step') then
    raise exception 'titles.path_step missing';
  end if;
  if (select count(*) from public.titles where path_step is not null and auto_rides is null) <> 3 then
    raise exception 'the three path titles are missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'customer_titles_path_one' and not tgisinternal) then
    raise exception 'customer_titles_path_one missing';
  end if;
  for f in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('_title_path_one', '_helper_shift_days', '_helper_days', 'customer_helper_path', 'staff_helper_days') loop
    if not f.prosecdef then raise exception '% is not SECURITY DEFINER', f.proname; end if;
    if not exists (select 1 from unnest(coalesce(f.proconfig, '{}')) c where c like 'search_path=%') then
      raise exception '% has no search_path', f.proname;
    end if;
    if f.proname like '\_%' and (has_function_privilege('anon', f.oid, 'execute') or has_function_privilege('authenticated', f.oid, 'execute')) then
      raise exception '% is callable from outside', f.proname;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.staff_helper_days()', 'execute') then raise exception 'staff_helper_days is open to anon'; end if;
  if not has_function_privilege('anon', 'public.customer_helper_path(text, text)', 'execute') then raise exception 'the page cannot reach customer_helper_path'; end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114012300', 'helper_path')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): the three steps, the five functions all definer, the helpers closed, the staff read closed to
-- visitors, the member's read open to the page, the trigger, the ledger row.
select (select count(*) from public.titles where path_step is not null) as path_titles_3,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
          and proname in ('_title_path_one', '_helper_shift_days', '_helper_days', 'customer_helper_path', 'staff_helper_days')) as definer_5,
       has_function_privilege('anon', 'public._helper_days(text[])', 'execute') as helper_open_to_anon_false,
       has_function_privilege('anon', 'public.staff_helper_days()', 'execute') as staff_read_open_to_anon_false,
       has_function_privilege('anon', 'public.customer_helper_path(text, text)', 'execute') as member_read_open_true,
       (select count(*) from pg_trigger where tgname = 'customer_titles_path_one' and not tgisinternal) as trigger_1,
       (select version from supabase_migrations.schema_migrations where version = '20261114012300') as ledger;
