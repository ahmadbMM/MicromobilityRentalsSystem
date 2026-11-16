-- ============================================================================
-- Staff's ratings of volunteers are out of 10, not 5 (the user, 2026-11-16: "let volunteers ratings be out of 10 not 5").
--
--  A. volunteer_ratings.rating: 1 to 10 (the check volunteer_ratings_rating_check). A rating given on the old scale is
--     doubled once (1-5 -> 2-10), so it keeps what it meant; that happens only while the check still says 5, so a second
--     run changes nothing. Prod and staging held no rating when this was written (2026-11-16).
--  B. staff_volunteer_rate: p_rating 1 to 10 (BAD_INPUT otherwise). Rebuilt from the live text of 20261115230000
--     (md5 2178c6ad138deda7048a23f66fe704fd on prod and staging, 2026-11-16); only the range changes.
--
-- The volunteers' own rating of an event (volunteer_feedback, the portal) stays 1 to 5.
--
-- Rollback: update volunteer_ratings set rating = greatest(1, round(rating / 2.0)); put the check back to 1-5; put
-- "between 1 and 5" back in staff_volunteer_rate.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';


/* -- 1. the scale -------------------------------------------------------------------------------- */
do $do$
declare d text;
begin
  select pg_get_constraintdef(oid) into d from pg_constraint
   where conrelid = 'public.volunteer_ratings'::regclass and conname = 'volunteer_ratings_rating_check';
  if d is null then
    alter table public.volunteer_ratings add constraint volunteer_ratings_rating_check check (rating between 1 and 10);
  elsif position('<= 5' in d) > 0 then
    alter table public.volunteer_ratings drop constraint volunteer_ratings_rating_check;
    update public.volunteer_ratings set rating = rating * 2 where rating between 1 and 5;
    alter table public.volunteer_ratings add constraint volunteer_ratings_rating_check check (rating between 1 and 10);
  end if;
end $do$;
comment on table public.volunteer_ratings is
  'Staff''s rating of a volunteer on an opportunity they worked, 1-10 (20261116150000; 1-5 until then) and a comment, one per shift (staff_volunteer_rate, 20261115230000). Staff read it; volunteers never see it.';


/* -- 2. staff rate ------------------------------------------------------------------------------- */
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
    if p_rating not between 1 and 10 or char_length(_c) > 500 then raise exception 'BAD_INPUT' using errcode = '22023'; end if; /* out of 10 (20261116150000) */
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


/* -- 3. checks ----------------------------------------------------------------------------------- */
do $chk$
declare f text := 'public.staff_volunteer_rate(text,text,integer,text)';
begin
  if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '% lost SECURITY DEFINER or its search_path', f;
  end if;
  if has_function_privilege('anon', f, 'execute') then raise exception 'staff_volunteer_rate is executable by anon'; end if;
  if not has_function_privilege('authenticated', f, 'execute') then raise exception 'staff_volunteer_rate is not executable by staff'; end if;
  if position('between 1 and 10' in pg_get_functiondef(f::regprocedure)) = 0 then raise exception 'staff_volunteer_rate does not take 1-10'; end if;
  if position('<= 10' in (select pg_get_constraintdef(oid) from pg_constraint
                           where conrelid = 'public.volunteer_ratings'::regclass and conname = 'volunteer_ratings_rating_check')) = 0 then
    raise exception 'volunteer_ratings does not take 1-10';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261116150000', 'volunteer_ratings_ten')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): the check and the function take 1-10, the function a definer for staff only, the ratings, the ledger.
select (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.volunteer_ratings'::regclass and conname = 'volunteer_ratings_rating_check') as rating_check,
       position('between 1 and 10' in pg_get_functiondef('public.staff_volunteer_rate(text,text,integer,text)'::regprocedure)) > 0 as rate_takes_10,
       (select prosecdef from pg_proc where oid = 'public.staff_volunteer_rate(text,text,integer,text)'::regprocedure) as rate_definer,
       has_function_privilege('anon', 'public.staff_volunteer_rate(text,text,integer,text)', 'execute') as anon_can_rate,
       (select count(*) from public.volunteer_ratings) as ratings,
       (select max(rating) from public.volunteer_ratings) as top_rating,
       (select name from supabase_migrations.schema_migrations where version = '20261116150000') as ledger;
