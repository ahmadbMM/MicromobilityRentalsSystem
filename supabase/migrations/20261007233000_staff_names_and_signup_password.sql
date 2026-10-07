-- ============================================================================
-- Two of the owner's "fix those" of 2026-10-07, after the bug hunt's open questions:
--
--  1. site_content.updated_by named the staff member who saved each row (the desk operator's name, or the
--     staff email), and anyone may read site_content - a rider signed in with Google is `authenticated`
--     like staff, and anon reads it too. A column grant cannot hide it: every staff save is an upsert
--     whose `updated_by = excluded.updated_by` counts as reading the column, so a revoke would refuse
--     the Website editor, the message templates, the booking window and the learn switch. So the row
--     names nobody: _site_content_stamp keeps who saved it for this transaction only (mm.site_content_by)
--     and clears the column; _site_content_log writes that name to site_content_history.changed_by, which
--     only admins read (the staff Website editor's History), as before. The 13 rows' names go, with the
--     triggers held off for that one update so no row looks saved today and nothing is logged or resynced.
--     An app from before this change still saves (the name it sends is simply not kept on the row).
--  2. customer_signup stored any password: the rule every other password door keeps (8 or more, an
--     upper-case letter and a digit: customer_change_password, customer_set_own_password,
--     customer_fix_save, staff_set_customer_temp_password) was the sign-up pages' alone. The booking
--     app's sign-up, the staff account editor, the website's learn form and the community form all check
--     it before calling, so none of them is refused; any other call now is, as 'WEAK_PASSWORD' (22023).
--     (The password reset the question named is gone already: customer_reset refuses, 20261007140000.)
--
-- Rollback: re-run the two trigger functions and customer_signup as pg_get_functiondef gave them before
-- this migration (the stamp wrote coalesce(updated_by, jwt email, 'unknown') onto the row, the log took
-- new.updated_by; customer_signup had no WEAK_PASSWORD line). The cleared names are not restored (they
-- stay in site_content_history).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

-- ── 1. site_content names nobody ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._site_content_stamp()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  new.updated_at := now();
  -- (20261007233000) The row names nobody: anyone may read site_content. Who saved it is kept for this
  -- transaction only, for _site_content_log to write into site_content_history (admins only).
  perform set_config('mm.site_content_by',
    left(coalesce(nullif(btrim(new.updated_by), ''), auth.jwt() ->> 'email', 'unknown'), 120), true);
  new.updated_by := null;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public._site_content_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'DELETE' then
    insert into public.site_content_history(key, old_value, new_value, changed_by)
    values (old.key, old.value, null, left(coalesce(auth.jwt() ->> 'email', 'unknown'), 120));
    return old;
  end if;
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then return new; end if;
  insert into public.site_content_history(key, old_value, new_value, changed_by)
  values (new.key, case when tg_op = 'UPDATE' then old.value end, new.value,
          -- (20261007233000) the name _site_content_stamp kept: the row itself no longer carries one
          coalesce(nullif(current_setting('mm.site_content_by', true), ''),
                   left(coalesce(auth.jwt() ->> 'email', 'unknown'), 120)));
  return new;
end $function$;

-- The names already on the rows go; their dates, the history and the ambassador discount stay as they are.
alter table public.site_content disable trigger site_content_stamp;
alter table public.site_content disable trigger site_content_log;
alter table public.site_content disable trigger site_content_amb_discount;
update public.site_content set updated_by = null where updated_by is not null;
alter table public.site_content enable trigger site_content_stamp;
alter table public.site_content enable trigger site_content_log;
alter table public.site_content enable trigger site_content_amb_discount;


-- ── 2. customer_signup: the password rule every other door keeps ────────────────────────────
create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

do $su$
declare d text;
begin
  d := pg_get_functiondef('public.customer_signup(text,text,text,text,text,integer,text,text,text)'::regprocedure);
  if position('(20261007233000)' in d) > 0 then
    raise notice 'customer_signup already keeps the password rule; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  if not _type_ok(p_type_preference) then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'type_preference'; end if;$a$,
$b$  if not _type_ok(p_type_preference) then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'type_preference'; end if;
  -- the password rule every other password door keeps: 8 or more, an upper-case letter and a digit (20261007233000)
  if length(coalesce(p_pwd, '')) < 8 or p_pwd !~ '[A-Z]' or p_pwd !~ '[0-9]' then
    raise exception 'WEAK_PASSWORD' using errcode = '22023';
  end if;$b$);
  execute d;
end $su$;


-- ── checks ────────────────────────────────────────────────────────────────────────────────────
do $chk$
begin
  if (select count(*) from public.site_content where updated_by is not null) > 0 then
    raise exception 'site_content still carries a name';
  end if;
  if (select prosecdef from pg_proc where oid = 'public._site_content_stamp()'::regprocedure) then
    raise exception '_site_content_stamp became a definer (it is invoker on purpose)';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public._site_content_log()'::regprocedure) then
    raise exception '_site_content_log lost SECURITY DEFINER';
  end if;
  if position('(20261007233000)' in pg_get_functiondef('public.customer_signup(text,text,text,text,text,integer,text,text,text)'::regprocedure)) = 0 then
    raise exception 'customer_signup was not patched';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.customer_signup(text,text,text,text,text,integer,text,text,text)'::regprocedure
                   and p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'customer_signup lost SECURITY DEFINER or its search_path';
  end if;
  if not has_function_privilege('anon', 'public.customer_signup(text,text,text,text,text,integer,text,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.customer_signup(text,text,text,text,text,integer,text,text,text)', 'execute') then
    raise exception 'customer_signup lost a client grant';
  end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.site_content'::regclass and not tgisinternal and tgenabled = 'D') then
    raise exception 'a site_content trigger was left disabled';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261007233000', 'staff_names_and_signup_password')
on conflict (version) do nothing;

commit;
