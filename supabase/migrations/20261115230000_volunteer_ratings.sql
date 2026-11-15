-- ============================================================================
-- Staff rate volunteers (the user, 2026-11-15: "add a feature that allows staff to rate volunteers and for them to have an
-- average rating and add comments with the rating, request a rating for each volunteer after each volunteering
-- experience").
--
--  A. volunteer_ratings: staff's rating of one volunteer on one opportunity they worked, 1 to 5 stars and an optional
--     comment (up to 500 characters), one per shift. Staff read it (policy "staff read", the Volunteers section); nothing
--     writes it but staff_volunteer_rate. Volunteers never see it: no volunteer_* function reads it. A volunteer's
--     average is worked out from these rows where it is shown, so there is no total to keep in step.
--  B. staff_volunteer_rate(p_session, p_customer, p_rating, p_comment): the change right on Volunteers. The shift must be
--     one they worked (done, or checked in: VOL_NOT_WORKED otherwise). A second call rewrites the rating in place with
--     who and when; p_rating null removes it. Each call goes in volunteer_log as 'staff_rate'. Answers the rating and
--     the volunteer's average and count.
--  C. A rating follows its shift when a session moves or accounts merge or unmerge (trigger
--     volunteer_shifts_rating_follow, as volunteer_feedback's _vol_feedback_follow).
--  D. _purge_old deletes an anonymised account's staff ratings (patched in place after the line that clears their own
--     ratings' comments, as 20261111140000 patched it).
--
-- The staff section (staff-parts/volunteers.js) asks for a rating once an opportunity's day is over, for everyone who
-- worked it; a database without this table hides the ratings and asks nothing.
--
-- Rollback: drop function public.staff_volunteer_rate(text,text,integer,text); drop trigger volunteer_shifts_rating_follow
-- on public.volunteer_shifts; drop function public._vol_rating_follow(); take the volunteer_ratings line out of
-- _purge_old; drop table public.volunteer_ratings; delete from volunteer_log where action = 'staff_rate' and restore
-- volunteer_log_action_check without it.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


/* -- 1. the table -------------------------------------------------------------------------------- */
create table if not exists public.volunteer_ratings (
  id            bigint generated always as identity primary key,
  shift_id      bigint not null unique references public.volunteer_shifts (id) on delete cascade,
  session_id    text not null references public.sessions (id) on update cascade on delete cascade,
  customer_id   text not null references public.customers (id) on update cascade on delete cascade,
  rating        smallint not null check (rating between 1 and 5),
  comment       text check (char_length(comment) <= 500),
  rated_by      text check (char_length(rated_by) <= 120),
  rated_by_user uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.volunteer_ratings is
  'Staff''s rating of a volunteer on an opportunity they worked, 1-5 and a comment, one per shift (staff_volunteer_rate, 20261115230000). Staff read it; volunteers never see it.';
create index if not exists volunteer_ratings_session on public.volunteer_ratings (session_id);
create index if not exists volunteer_ratings_customer on public.volunteer_ratings (customer_id);
alter table public.volunteer_ratings enable row level security;
revoke all on public.volunteer_ratings from public, anon, authenticated;
grant select on public.volunteer_ratings to authenticated;
drop policy if exists "staff read" on public.volunteer_ratings;
create policy "staff read" on public.volunteer_ratings for select using ((select _staff_mod('volunteers')));

alter table public.volunteer_log drop constraint if exists volunteer_log_action_check;
alter table public.volunteer_log add constraint volunteer_log_action_check
  check (action in ('enter', 'list', 'scan', 'search', 'checkin', 'uncheckin', 'donated', 'undonated', 'clock_in', 'clock_out', 'agree', 'interest', 'withdraw', 'role',
                    'arrive', 'staff_accept', 'staff_decline', 'staff_in', 'staff_out', 'staff_times', 'staff_status', 'staff_noshow', 'staff_remove',
                    'staff_award', 'staff_hours', 'staff_void', 'staff_save', 'staff_session', 'staff_end',
                    'profile', 'team', 'lead_in', 'lead_out', 'lead_undo', 'staff_lead', 'reward', 'ended',
                    'plan', 'coming', 'feedback', 'motive', 'thanks', 'reason', 'details', 'staff_rate'));


/* -- 2. a rating follows its shift --------------------------------------------------------------- */
-- staff_move_session moves shifts before deleting the old session; a merge moves them to the account kept, an unmerge back.
create or replace function public._vol_rating_follow()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  update volunteer_ratings r set session_id = new.session_id, customer_id = new.customer_id
   where r.shift_id = new.id and (r.session_id is distinct from new.session_id or r.customer_id is distinct from new.customer_id);
  return null;
end $function$;
revoke all on function public._vol_rating_follow() from public, anon, authenticated;
drop trigger if exists volunteer_shifts_rating_follow on public.volunteer_shifts;
create trigger volunteer_shifts_rating_follow after update of session_id, customer_id on public.volunteer_shifts
  for each row when (old.session_id is distinct from new.session_id or old.customer_id is distinct from new.customer_id)
  execute function public._vol_rating_follow();


/* -- 3. staff rate ------------------------------------------------------------------------------- */
create or replace function public.staff_volunteer_rate(p_session text, p_customer text, p_rating integer, p_comment text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _op text := left(coalesce(_vol_op(), 'staff'), 120); _sh record; _c text := nullif(btrim(coalesce(p_comment, '')), '');
        _r record; _avg numeric; _n int;
begin
  if not (select _staff_mod('volunteers', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select sh.id, sh.status, sh.clock_in into _sh from volunteer_shifts sh where sh.session_id = p_session and sh.customer_id = p_customer;
  if _sh.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_rating is null then
    delete from volunteer_ratings where shift_id = _sh.id;
    if found then perform _vol_slog(p_customer, p_session, 'staff_rate'); end if;
  else
    if _sh.status <> 'done' and _sh.clock_in is null then raise exception 'VOL_NOT_WORKED' using errcode = '22023'; end if;
    if p_rating not between 1 and 5 or char_length(_c) > 500 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
    insert into volunteer_ratings (shift_id, session_id, customer_id, rating, comment, rated_by, rated_by_user)
    values (_sh.id, p_session, p_customer, p_rating, _c, _op, auth.uid())
    on conflict (shift_id) do update set rating = excluded.rating, comment = excluded.comment, rated_by = excluded.rated_by,
                                         rated_by_user = excluded.rated_by_user, updated_at = now();
    perform _vol_slog(p_customer, p_session, 'staff_rate');
  end if;
  select r.id, r.rating, r.comment, r.rated_by, r.created_at, r.updated_at into _r from volunteer_ratings r where r.shift_id = _sh.id;
  select round(avg(r.rating), 2), count(*) into _avg, _n from volunteer_ratings r where r.customer_id = p_customer;
  return jsonb_build_object('ok', true, 'id', _r.id, 'shift_id', _sh.id, 'rating', _r.rating, 'comment', _r.comment, 'rated_by', _r.rated_by,
                            'created_at', _r.created_at, 'updated_at', _r.updated_at, 'avg', _avg, 'n', _n);
end $function$;
revoke all on function public.staff_volunteer_rate(text, text, integer, text) from public, anon;
grant execute on function public.staff_volunteer_rate(text, text, integer, text) to authenticated;


/* -- 4. an anonymised account loses staff's ratings of it ---------------------------------------- */
-- Patched in place, after the line 20261111140000 added: the live text keeps every line it has.
do $do$
declare d text;
begin
  select pg_get_functiondef('public._purge_old(boolean)'::regprocedure) into d;
  if position('(20261115230000)' in d) > 0 then return; end if;
  execute pg_temp._once(d,
    $a$update volunteer_feedback set comment = null where customer_id = any(ids) and comment is not null; /* a rating's comment (20261111140000) */$a$,
    $b$update volunteer_feedback set comment = null where customer_id = any(ids) and comment is not null; /* a rating's comment (20261111140000) */
      delete from volunteer_ratings where customer_id = any(ids); /* staff's ratings of the volunteer (20261115230000) */$b$);
end $do$;


/* -- 5. checks ----------------------------------------------------------------------------------- */
do $chk$
declare f text;
begin
  foreach f in array array['public.staff_volunteer_rate(text,text,integer,text)', 'public._vol_rating_follow()', 'public._purge_old(boolean)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.staff_volunteer_rate(text,text,integer,text)', 'execute') then raise exception 'staff_volunteer_rate is executable by anon'; end if;
  if not has_function_privilege('authenticated', 'public.staff_volunteer_rate(text,text,integer,text)', 'execute') then raise exception 'staff_volunteer_rate is not executable by staff'; end if;
  if has_function_privilege('anon', 'public._vol_rating_follow()', 'execute') or has_function_privilege('authenticated', 'public._vol_rating_follow()', 'execute') then
    raise exception '_vol_rating_follow is executable by a client';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.volunteer_ratings'::regclass) then raise exception 'volunteer_ratings has no RLS'; end if;
  if has_table_privilege('anon', 'public.volunteer_ratings', 'select') or has_table_privilege('authenticated', 'public.volunteer_ratings', 'insert')
     or has_table_privilege('authenticated', 'public.volunteer_ratings', 'update') or has_table_privilege('authenticated', 'public.volunteer_ratings', 'delete') then
    raise exception 'volunteer_ratings is writable by a client, or readable by anon';
  end if;
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.volunteer_shifts'::regclass and t.tgname = 'volunteer_shifts_rating_follow') then
    raise exception 'the trigger volunteer_shifts_rating_follow is missing';
  end if;
  if position('volunteer_ratings' in pg_get_functiondef('public._purge_old(boolean)'::regprocedure)) = 0 then
    raise exception '_purge_old does not delete staff''s ratings';
  end if;
  if position('''staff_rate''' in (select pg_get_constraintdef(oid) from pg_constraint where conname = 'volunteer_log_action_check')) = 0 then
    raise exception 'volunteer_log does not take staff_rate';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261115230000', 'volunteer_ratings')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): the table with RLS and its policy, the function a definer for staff only, the trigger, the purge, the ledger.
select (select relrowsecurity from pg_class where oid = 'public.volunteer_ratings'::regclass) as rls,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'volunteer_ratings') as policies,
       (select prosecdef from pg_proc where oid = 'public.staff_volunteer_rate(text,text,integer,text)'::regprocedure) as rate_definer,
       has_function_privilege('anon', 'public.staff_volunteer_rate(text,text,integer,text)', 'execute') as anon_can_rate,
       (select count(*) from pg_trigger where tgname = 'volunteer_shifts_rating_follow') as follow_trigger,
       position('volunteer_ratings' in pg_get_functiondef('public._purge_old(boolean)'::regprocedure)) > 0 as purge_patched,
       (select name from supabase_migrations.schema_migrations where version = '20261115230000') as ledger;
