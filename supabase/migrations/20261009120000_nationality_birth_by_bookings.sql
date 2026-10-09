-- ============================================================================
-- The nationality from a rider's first booking, the birth date from the fourth (the owner, 2026-10-09:
-- "force the nationality after the first booking, force the birth date after the 4th booking, no need
-- to complete the booking just reserving it counts", then "do it": the server refuses too). Every
-- booking on the account counts - ridden, no-show, upcoming or waitlisted - except a cancelled or
-- removed one, as the booking app's profile page counts them (_pgCount, app 72eab202).
--
--  _customer_asks asks 'nationality' of an account with one booking or more and none on file, and
--  'birth_date' of one with four or more and none on file. That one rule makes the booking app's page
--  open at sign-in with no way past it but Log out (customer_fix_fields), customer_fix_save take the
--  answers (it already does for both), and customer_create_booking refuse the account's next booking
--  meanwhile (FIX_FIRST): the first booking goes through, the second waits for the nationality, the
--  fifth for the birth date. Staff adds and walk-ins are not refused (staff insert their rows themselves).
--  Patched in place from the live definition, before the emergency contact's ask (20261007235800).
--
-- Rollback: replace the block below back to its anchor (the emergency contact's comment line).
-- Idempotent (skipped when _customer_asks already carries '(20261009120000)').
-- Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

do $asks$
declare d text;
begin
  d := pg_get_functiondef('public._customer_asks(text)'::regprocedure);
  if position('(20261009120000)' in d) > 0 then
    raise notice '_customer_asks already asks by bookings; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  -- The first emergency contact, of every account (20261007235800).$a$,
$b$  -- The nationality from the first booking, the birth date from the fourth; a reserved booking
  -- counts, a cancelled or removed one does not (20261009120000).
  if coalesce(btrim(c.nationality),'') = '' and not ('nationality' = any(f))
     and exists (select 1 from queue_entries q
                  where q.customer_id = p_id and q.status not in ('cancelled','removed')) then
    f := f || 'nationality'::text;
  end if;
  if coalesce(btrim(c.birth_date),'') = '' and not ('birth_date' = any(f))
     and (select count(*) from queue_entries q
           where q.customer_id = p_id and q.status not in ('cancelled','removed')) >= 4 then
    f := f || 'birth_date'::text;
  end if;
  -- The first emergency contact, of every account (20261007235800).$b$);
  execute d;
end $asks$;
revoke execute on function public._customer_asks(text) from public, anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009120000', 'nationality_birth_by_bookings')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- Check (read-only), after:
--   select prosecdef, position('(20261009120000)' in pg_get_functiondef(oid)) > 0
--     from pg_proc where oid = 'public._customer_asks(text)'::regprocedure;   -- t, t
