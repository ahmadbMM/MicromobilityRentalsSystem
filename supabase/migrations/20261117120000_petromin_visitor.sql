-- ============================================================================
-- A Petromin night's visitor (the user, 2026-11-17: "add a visitor choice in petromin nights that only staff can see
-- and give to members and consider it free 0 sar").
--
-- A visitor is a member's booking on a Petromin night that staff marked Visitor: it rides free (paid, 0 SAR), on no
-- company's bill (it is a booking, not a registration). Only staff give it and take it away; the rider never picks it
-- and never reads it.
--
-- 1. queue_entries.pm_visitor (boolean, false by default).
-- 2. _pm_visitor_guard (BEFORE INSERT OR UPDATE, trigger queue_entries_pm_visitor; it sorts before trg_enforce_booking_price
--    and the two house guards, so they see the row as it will be written):
--    - a write by anyone but staff keeps what the row had (a new booking is no visitor);
--    - only on a Petromin night (ride_kind 'petromin'): a booking moved to another kind of session stops being one, and
--      so does one the rider moves to another night themselves (it was given for that night); staff may move it from one
--      Petromin night to another and it stays;
--    - a visitor is paid at 0 (no pay method, no split) and loses its code, which goes back to its owner as on any free
--      ride (the use count trigger sees promo_code change);
--    - a booking already paid with money (paid at a price, or with wallet money on it) is refused: VISITOR_PAID (P0001),
--      so the desk sets it back to Pending first and no taken money disappears from the close-out;
--    - taken away: the ride owes its fare again (_fare_now), or rides on the house by the account's own terms
--      (_house_earned: VIP, default payment).
-- 3. _house_guard and _house_insert_guard (the manager's approval for a ride on the house) let a visitor through: the
--    visitor mark is the staff's choice and the ride is free by it. Patched in place from their LIVE text (md5 checked),
--    so SECURITY DEFINER and the search_path stay.
-- 4. my_bookings: the rider's own rows carry pm_visitor false, as the desk note is nulled (patched in place, md5 checked).
--
-- Rollback (emergency only): drop trigger queue_entries_pm_visitor on queue_entries; drop function _pm_visitor_guard;
-- remove the lines marked 20261117120000 from _house_guard, _house_insert_guard and my_bookings; alter table
-- queue_entries drop column pm_visitor. Idempotent.
-- ============================================================================
begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(src text, a text, b text, n integer default 1) returns text
language plpgsql as $f$
declare c integer := (length(src) - length(replace(src, a, ''))) / greatest(length(a), 1);
begin
  if c <> n then raise exception 'petromin_visitor: expected % of [%], found %', n, left(a, 80), c; end if;
  return replace(src, a, b);
end $f$;

-- ── 1. The mark ──────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists pm_visitor boolean not null default false;
comment on column public.queue_entries.pm_visitor is
  'A Petromin night''s visitor: staff marked this member''s booking free (paid, 0). Staff only; riders read false (20261117120000).';

-- ── 2. Who gives it, where, and what it costs ───────────────────────────────────────────────────────────────────
create or replace function public._pm_visitor_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_was boolean := tg_op = 'UPDATE' and coalesce(old.pm_visitor, false);
        v_staff boolean;
        v_pm boolean;
begin
  new.pm_visitor := coalesce(new.pm_visitor, false);
  if not new.pm_visitor and not v_was then return new; end if;            -- almost every row
  v_staff := coalesce((select is_staff()), false);
  if new.pm_visitor is distinct from v_was and not v_staff then
    new.pm_visitor := v_was;                                              -- staff give it and take it away
  end if;
  if new.pm_visitor then
    select coalesce(s.ride_kind, '') = 'petromin' into v_pm from sessions s where s.id = new.session_id;
    if not coalesce(v_pm, false)
       or (tg_op = 'UPDATE' and new.session_id is distinct from old.session_id and not v_staff) then
      new.pm_visitor := false;                                            -- a Petromin night's, the night it was given
    end if;
  end if;
  if new.pm_visitor then
    if not v_was and tg_op = 'UPDATE'
       and ((coalesce(old.paid, false) and coalesce(old.price, 0) > 0) or coalesce(old.wallet_paid, 0) > 0) then
      raise exception 'VISITOR_PAID' using errcode = 'P0001',
        hint = 'The booking is paid: set it back to Pending (or give the wallet money back) before making it a visitor.';
    end if;
    new.paid := true;
    new.price := 0;
    new.pay_method := null;
    new.card_amount := null;
    if not v_was then new.promo_code := null; end if;                     -- a free ride spends no code
  elsif v_was then
    if _house_earned(new.customer_id, new.name, new.type_preference) then
      new.paid := true;
      new.price := 0;
    else
      new.paid := false;
      new.price := coalesce(_fare_now(new.session_id, new.id, new.type_preference), 0);
    end if;
    new.pay_method := null;
    new.card_amount := null;
  end if;
  return new;
end $function$;
revoke all on function public._pm_visitor_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_pm_visitor on public.queue_entries;
create trigger queue_entries_pm_visitor
  before insert or update on public.queue_entries
  for each row execute function public._pm_visitor_guard();

-- ── 3 and 4. The patches ─────────────────────────────────────────────────────────────────────────────────────────
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public._house_guard()'::regprocedure);
  if position('pm_visitor' in d) > 0 then
    raise notice '_house_guard already lets a visitor through';
  else
    if md5(d) <> '4b51370e022e94fa4fbb3d6831b3a9f3' then
      raise exception '_house_guard changed since 20261117120000 was written (md5 %)', md5(d);
    end if;
    d := pg_temp._once(d,
$a$  if coalesce(current_setting('mm.house_ok', true), '') = '1' then return new; end if;$a$,
$b$  if coalesce(new.pm_visitor, false) then return new; end if;   -- a Petromin night's visitor: staff's pick, free (20261117120000)
  if coalesce(current_setting('mm.house_ok', true), '') = '1' then return new; end if;$b$);
    execute d;
  end if;

  d := pg_get_functiondef('public._house_insert_guard()'::regprocedure);
  if position('pm_visitor' in d) > 0 then
    raise notice '_house_insert_guard already lets a visitor through';
  else
    if md5(d) <> 'f045df04f09f33d7d3f90aeadf7b1db8' then
      raise exception '_house_insert_guard changed since 20261117120000 was written (md5 %)', md5(d);
    end if;
    d := pg_temp._once(d,
$a$  if coalesce(current_setting('mm.house_ok', true), '') = '1' then return new; end if;$a$,
$b$  if coalesce(new.pm_visitor, false) then return new; end if;   -- a Petromin night's visitor: staff's pick, free (20261117120000)
  if coalesce(current_setting('mm.house_ok', true), '') = '1' then return new; end if;$b$);
    execute d;
  end if;

  d := pg_get_functiondef('public.my_bookings(text,text)'::regprocedure);
  if position('pm_visitor' in d) > 0 then
    raise notice 'my_bookings already hides the visitor mark';
  else
    if md5(d) <> '910a3a3b3372f00a52aa063afb5c0a3d' then
      raise exception 'my_bookings changed since 20261117120000 was written (md5 %)', md5(d);
    end if;
    d := pg_temp._once(d,
$a$    r.desk_note := null;$a$,
$b$    r.desk_note := null;
    r.pm_visitor := false;   /* the visitor mark is staff's too (20261117120000) */$b$);
    execute d;
  end if;
end $mig$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261117120000', 'petromin_visitor')
on conflict (version) do nothing;

commit;

-- Check (read only): the column, the trigger, the three patches, the functions' attributes and grants, the ledger row.
select (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'queue_entries' and column_name = 'pm_visitor') as col,
       (select count(*) from pg_trigger where tgname = 'queue_entries_pm_visitor'
         and tgrelid = 'public.queue_entries'::regclass) as trig,
       position('pm_visitor' in pg_get_functiondef('public._house_guard()'::regprocedure)) > 0 as house_patched,
       position('pm_visitor' in pg_get_functiondef('public._house_insert_guard()'::regprocedure)) > 0 as house_ins_patched,
       position('pm_visitor' in pg_get_functiondef('public.my_bookings(text,text)'::regprocedure)) > 0 as my_bookings_patched,
       (select json_agg(json_build_object('fn', p.proname, 'definer', p.prosecdef, 'settings', p.proconfig,
                                          'anon', has_function_privilege('anon', p.oid, 'execute')) order by p.proname)
          from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('_pm_visitor_guard', '_house_guard', '_house_insert_guard', 'my_bookings')) as fns,
       (select count(*) from public.queue_entries where pm_visitor) as visitors,
       (select name from supabase_migrations.schema_migrations where version = '20261117120000') as ledger;
