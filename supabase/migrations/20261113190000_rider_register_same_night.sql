-- A Petromin / Petrolube / Dukan registration is linked only to a booking on its own night (the user, 2026-11-13:
-- "malik anas alnajjar has a booking on saturday social ride 14/11 he has a booking but it doesnt show on the staff
-- panel").
--
-- What happened: Dukan D-001 (rider_registrations 387) was made for the Petromin night 2026-11-16-pw. The rider had no
-- booking that night, so rider_register fell through to its any-night lookup ("the phone's next booking from today")
-- and linked his Saturday Social Ride booking 1rl7zikmw64vcih (2026-11-14). The desk's Bookings roster hides every
-- booking a registration stands for (it is counted on the Petromin page), so his Saturday booking vanished from the
-- roster. On Saturday its check-in would also have marked Monday's registration checked in (_rider_reg_follow_booking).
--
-- 1. rider_register: the two any-night lookups (by phone; the desk's by name) run only for a registration with no
--    night. A registration for a night that finds no booking on that night is matched to the customer instead
--    (match_kind 'customer'), as it already was when the rider had no later booking at all.
--    Patched from the LIVE definition with exact-count text replaces (pg_temp._once, as 20261112210000 did), so the
--    header keeps SECURITY DEFINER and the search_path, and a text that does not match stops everything.
-- 2. Every registration for a night now linked to a booking on ANOTHER night, not checked in, is unlinked and keeps
--    its customer (on 2026-11-13 that is registration 387 only). The reprice trigger finds no fare to change: the
--    Saturday booking is free and stays at 0.
-- Every block skips itself once applied, so the file can be run again safely.
-- Rollback: restore rider_register from 20261112210000's result (re-add the two lookups without "v_sess.id is null").

begin;

create or replace function pg_temp._once(src text, a text, b text, n integer default 1) returns text
language plpgsql as $f$
declare c integer := (length(src) - length(replace(src, a, ''))) / greatest(length(a), 1);
begin
  if c <> n then raise exception 'rider_register_same_night: expected % of [%], found %', n, left(a, 80), c; end if;
  return replace(src, a, b);
end $f$;

-- ── 1. rider_register: a night's registration matches a booking on that night only ─────────────────────────────
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,text)'::regprocedure);
  if position('(20261113190000)' in d) > 0 then raise notice 'rider_register already matches on its own night; nothing to do'; return; end if;
  d := pg_temp._once(d,
$a$  if v_entry.id is null and v_last9 is not null then$a$,
$b$  -- Any night only for a registration with no night of its own: one for a night links a booking on that night or
  -- none, never the rider's Saturday ride or another night's booking (20261113190000).
  if v_entry.id is null and v_sess.id is null and v_last9 is not null then$b$);
  d := pg_temp._once(d,
$a$  if v_entry.id is null and v_staff then   -- by name: the desk only$a$,
$b$  if v_entry.id is null and v_sess.id is null and v_staff then   -- by name: the desk only$b$);
  execute d;
end $mig$;

-- ── 2. unlink the registrations already tied to another night's booking ────────────────────────────────────────────
update public.rider_registrations r
   set matched_entry_id = null,
       match_kind = case when r.matched_customer_id is not null then 'customer' else 'none' end
  from public.queue_entries q
 where q.id = r.matched_entry_id
   and r.session_id is not null
   and q.session_id is distinct from r.session_id
   and r.checked_in_at is null;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261113190000', 'rider_register_same_night')
on conflict (version) do nothing;

commit;

-- Check (read-only): expect fixed = true, cross_links = 0, ledger = rider_register_same_night,
-- and Malik's Saturday booking with no registration on it (reg_on_booking = 0).
select position('(20261113190000)' in pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text,text)'::regprocedure)) > 0 as fixed,
       (select count(*) from public.rider_registrations r join public.queue_entries q on q.id = r.matched_entry_id
         where r.session_id is not null and q.session_id is distinct from r.session_id) as cross_links,
       (select name from supabase_migrations.schema_migrations where version = '20261113190000') as ledger,
       (select count(*) from public.rider_registrations where matched_entry_id = '1rl7zikmw64vcih') as reg_on_booking;
