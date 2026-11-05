-- ============================================================================
-- Blood Donation visitors: their details and their free ride (the owner, 2026-11-05: "give visitors a free ride too not
-- only donors"; "we want from the visitor to give us his name phone number gender dob nationality and add them to his
-- account directly and prefill already given info").
--
--  1. _blood_entry_guard: a visitor's account needs a name, mobile, gender, birth date and nationality, and 18 or over and
--     the agreement to share as before. No email and no blood type. A donor's rules are unchanged.
--  2. _blood_visitor_code (AFTER UPDATE OF status, blood_role, only on a row that is or was a visitor): a checked-in visitor
--     gets the same personal code a marked donor gets: 100% off, one use, one calendar month, Carbon and off-circuit refused
--     by _blood_code_guard. Every way in counts, the desk, the scanner and the volunteers. No longer a checked-in visitor
--     (check-in undone, switched to donor, cancelled) and no donation marked: the code is retired, unless it was used.
--     A visitor never gets donated_at, so no Blood Donor badge, and _blood_donated_apply still refuses them (BLOOD_VISITOR).
--
-- Safe before the app: no booking is a visitor until it ships. Touches no existing row.
--
-- Rollback:
--   drop trigger if exists queue_entries_blood_visitor_code on public.queue_entries;
--   drop function if exists public._blood_visitor_code();
--   then run the patch below backwards, and retire any code it made.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if position(b in def) > 0 then return def; end if;
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

do $do$
declare v text;
begin
  select pg_get_functiondef('public._blood_entry_guard'::regproc) into v;
  v := pg_temp._once(v,
    $a$select x.name, x.email, x.phone, x.blood_type, x.birth_date, x.nationality$a$,
    $b$select x.name, x.email, x.phone, x.blood_type, x.birth_date, x.nationality, x.gender$b$);
  v := pg_temp._once(v,
    $a$or nullif(btrim(coalesce(c.email, '')), '') is null$a$,
    $b$or (coalesce(new.blood_role, '') <> 'visitor' and nullif(btrim(coalesce(c.email, '')), '') is null)$b$);
  v := pg_temp._once(v,
    $a$or (coalesce(new.blood_role, '') <> 'visitor' and nullif(btrim(coalesce(c.blood_type, '')), '') is null)$a$,
    $b$or (coalesce(new.blood_role, '') <> 'visitor' and nullif(btrim(coalesce(c.blood_type, '')), '') is null)
     or (coalesce(new.blood_role, '') = 'visitor' and nullif(btrim(coalesce(c.gender, '')), '') is null)$b$);
  execute v;
end $do$;

create or replace function public._blood_visitor_code()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  _kind text;
  c promo_codes%rowtype;
  _code text;
  _exp date;
begin
  select s.ride_kind into _kind from sessions s where s.id = new.session_id;
  if coalesce(_kind, '') <> 'blood' then return null; end if;
  select * into c from promo_codes where blood_entry_id = new.id for update;
  _exp := ((now() at time zone 'Asia/Riyadh')::date + interval '1 month')::date;

  if coalesce(new.blood_role, '') = 'visitor' and coalesce(new.status, '') in ('active', 'done') and new.customer_id is not null then
    if c.id is null then
      loop
        _code := 'BD-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8));
        exit when not exists (select 1 from promo_codes where lower(code) = lower(_code));
      end loop;
      insert into promo_codes (id, code, kind, value, active, created_at, applies_to, expires_at, max_uses, uses, customer_id, blood_entry_id)
      values ('bd-' || new.id, _code, 'percent', 100, true,
              to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), null, _exp, 1, 0, new.customer_id, new.id);
    elsif not coalesce(c.active, false) then
      update promo_codes set active = true, expires_at = _exp where id = c.id;
    end if;
  elsif c.id is not null and coalesce(c.active, false) and new.donated_at is null and coalesce(c.uses, 0) = 0 then
    update promo_codes set active = false where id = c.id;
  end if;
  return null;
end $function$;
revoke execute on function public._blood_visitor_code() from public, anon, authenticated;

drop trigger if exists queue_entries_blood_visitor_code on public.queue_entries;
create trigger queue_entries_blood_visitor_code
  after update of status, blood_role on public.queue_entries
  for each row
  when (new.blood_role = 'visitor' or old.blood_role = 'visitor')
  execute function public._blood_visitor_code();

insert into supabase_migrations.schema_migrations (version, name)
values ('20261105160000', 'blood_visitor_details_ride')
on conflict (version) do nothing;

commit;
