-- ============================================================================
-- Members book first (the user, 2026-11-18, picked from the Community features list: "Members book first: featured or
-- limited sessions open to community members a few hours before everyone else. It isn't worth money, and it makes
-- membership mean something now that sessions sell out.").
--
-- A session staff mark "Members book first" for 3, 6, 12, 24 or 48 hours opens to active Community members first; everyone
-- else may book it from sessions.public_at on. Staff and the desk are never held. Nothing is worth money: it is a few hours'
-- head start, no price, no code.
--
-- 1. sessions.public_at (timestamptz, null = no members-first window). Riders read it with the rest of the row: list_sessions
--    returns setof sessions and anon/authenticated hold table-level SELECT on sessions; named in column grants too (as
--    20261107110000 did for opens_at), so a later move to column grants keeps it.
-- 2. _members_first_guard (BEFORE INSERT OR UPDATE OF status, session_id on queue_entries, trigger
--    queue_entries_members_first): while public_at is ahead, a rider's request (auth.role() anon or authenticated, not
--    is_staff()) that makes a place or a waitlist row on the session is refused unless the booking's account is an active
--    Community member (_member_active): MEMBERS_FIRST (P0001), detail = public_at in UTC (ISO), so the page says when
--    everyone may book. The customer paths that make a place or a waitlist row, all caught here:
--      - customer_create_booking (Reserve, the offline outbox), and through it saturday_book (micromobility.sa/saturday),
--        farm_book (the Farmhouse page), petromin_guest_book (the /petromin page's guests) and partner_book (a partner's
--        page): an INSERT;
--      - petromin_invite_book (a member's invitee on /petromin): an INSERT, and its resubmission onto another night: an
--        UPDATE of session_id;
--      - customer_booking_update: a rider's move to another date (Reschedule, an UPDATE of session_id) and a cancelled place
--        taken back (an UPDATE of status from cancelled).
--    Not judged again, as _gender_entry_guard (20261027150000) does not: a live row that stays on its session (a waitlist
--    place moving up: _promote_next_waitlist, customer_claim_spot; a payment landing: _pay_apply), and leaving, finishing
--    or a no-show. customer_accept_share hands an existing place of a party to a friend (customer_id): no new place.
--    A partner's own places come on top of everyone's (partner_book's mm.partner, as _community_booking_gate lets them in).
--    Staff writes (is_staff()), the server's own jobs, the service role and the SQL editor pass, as _approval_guard tells
--    them apart (20260922122000).
-- 3. _session_published (copied from 20261107110000, header unchanged: invoker, set search_path = public) also starts the
--    window when a session opens for booking: staff keep the hours in bike_slots._mfh (beside _few, _feat); a session that
--    becomes open or full for the FIRST time (from a draft or from a timed opening, which mm-sessions-tick or a staffer
--    opens), or one opened with no window yet, gets public_at = now() + the hours. A session closed and opened again later
--    keeps the window it had (passed or not). The app writes public_at itself for "Open now" and "Open at" and for an open
--    session it edits; this catches a draft opened by hand, a bulk Open and the timer.
--
-- Which sessions: the staff forms offer the switch only on sessions everyone may book (not a members-only Community session,
-- not tag-gated). The guard itself holds any session whose public_at is ahead.
--
-- Safe before or after the app: until a session has public_at nothing changes; an older app never writes it.
--
-- Rollback (emergency only): drop trigger if exists queue_entries_members_first on public.queue_entries;
--   drop function if exists public._members_first_guard(); run _session_published of 20261107110000 again;
--   update public.sessions set public_at = null; (the column may stay; alter table public.sessions drop column public_at
--   only once no app reads it). Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. The window ────────────────────────────────────────────────────────────────────────────────────────────────
alter table public.sessions add column if not exists public_at timestamptz;
comment on column public.sessions.public_at is
  'Members book first: until this moment only active Community members may book the session (_members_first_guard, 20261118210800). Null: no window.';

grant select (public_at) on public.sessions to anon, authenticated;
grant insert (public_at), update (public_at) on public.sessions to authenticated;

-- ── 2. Who may book before it ────────────────────────────────────────────────────────────────────────────────────
create or replace function public._members_first_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_at timestamptz; pb text[];
begin
  -- a rider's own request only: staff and the desk, the server's jobs, the service role and the SQL editor pass
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') or coalesce((select is_staff()), false) then
    return new;
  end if;
  -- leaving, finishing or being marked a no-show is never refused
  if coalesce(new.status, '') in ('cancelled', 'removed', 'noshow', 'done') then return new; end if;
  -- a live row that stays on its session is not judged again (a waitlist place moving up, a payment landing)
  if tg_op = 'UPDATE' and old.session_id is not distinct from new.session_id
     and coalesce(old.status, '') not in ('cancelled', 'removed', 'noshow') then
    return new;
  end if;
  select s.public_at into v_at from sessions s where s.id = new.session_id;
  if v_at is null or v_at <= now() then return new; end if;
  -- a partner's own places come on top of everyone's (partner_book), as the members gate lets them in
  pb := string_to_array(coalesce(current_setting('mm.partner', true), ''), '|');
  if tg_op = 'INSERT' and cardinality(pb) = 3 and pb[1] = new.session_id then return new; end if;
  if new.customer_id is not null and _member_active(new.customer_id) then return new; end if;
  raise exception 'MEMBERS_FIRST' using errcode = 'P0001',
    detail = to_char(v_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    hint = 'Community members book this session first; everyone else may book from the time in the detail.';
end $function$;
revoke all on function public._members_first_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_members_first on public.queue_entries;
create trigger queue_entries_members_first
  before insert or update of status, session_id on public.queue_entries
  for each row execute function public._members_first_guard();

-- ── 3. The window starts when the session opens ─────────────────────────────────────────────────────────────────
-- 20261107110000's function with the members-first lines added; everything it did stays.
create or replace function public._session_published()
 returns trigger language plpgsql
 set search_path = public
as $function$
declare v_h integer;
begin
  if new.status in ('open', 'full') then
    -- Members book first (20261118210800): the hours staff chose (bike_slots._mfh) count from the moment the session
    -- opens for booking: its first opening (a draft, a timed one), or any opening while it has no window yet.
    if tg_op = 'INSERT' or coalesce(old.status, '') not in ('open', 'full') then
      begin
        v_h := substring(coalesce(new.bike_slots::text, '') from '"_mfh"\s*:\s*"?([0-9]{1,2})\M')::integer;
      exception when others then v_h := null;
      end;
      if v_h in (3, 6, 12, 24, 48)
         and (new.public_at is null
              or (tg_op = 'UPDATE' and (coalesce(old.draft, false) or old.opens_at is not null))) then
        new.public_at := now() + make_interval(hours => v_h);
      end if;
    end if;
    new.draft := false;
    new.opens_at := null;
  end if;
  return new;
end $function$;
revoke execute on function public._session_published() from public, anon, authenticated;

-- ── Checks ───────────────────────────────────────────────────────────────────────────────────────────────────────
do $chk$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'sessions' and column_name = 'public_at') then
    raise exception 'sessions.public_at missing';
  end if;
  if not has_column_privilege('anon', 'public.sessions', 'public_at', 'select') then
    raise exception 'riders cannot read sessions.public_at';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public._members_first_guard()'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '_members_first_guard is missing, or lost SECURITY DEFINER or its search_path';
  end if;
  if has_function_privilege('anon', 'public._members_first_guard()', 'execute')
     or has_function_privilege('authenticated', 'public._members_first_guard()', 'execute') then
    raise exception '_members_first_guard is executable by a client role';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'queue_entries_members_first'
                  and tgrelid = 'public.queue_entries'::regclass and not tgisinternal) then
    raise exception 'the members-first trigger is missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'sessions_published' and tgrelid = 'public.sessions'::regclass) then
    raise exception 'the sessions_published trigger is missing';
  end if;
  if (select p.prosecdef from pg_proc p where p.oid = 'public._session_published()'::regprocedure)
     or not exists (select 1 from pg_proc p where p.oid = 'public._session_published()'::regprocedure
                      and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '_session_published changed its attributes (it is invoker with search_path = public)';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261118210800', 'members_first')
on conflict (version) do nothing;

commit;

-- check (read only): the column and who reads it, the guard and its trigger, the opening trigger's text, the ledger row.
-- select (select data_type from information_schema.columns
--          where table_schema = 'public' and table_name = 'sessions' and column_name = 'public_at') as col,
--        has_column_privilege('anon', 'public.sessions', 'public_at', 'select') as anon_reads,
--        (select json_build_object('definer', p.prosecdef, 'settings', p.proconfig,
--                                  'anon', has_function_privilege('anon', p.oid, 'execute'))
--           from pg_proc p where p.oid = 'public._members_first_guard()'::regprocedure) as guard,
--        (select count(*) from pg_trigger where tgname = 'queue_entries_members_first'
--          and tgrelid = 'public.queue_entries'::regclass) as trig,
--        position('_mfh' in pg_get_functiondef('public._session_published()'::regprocedure)) > 0 as opens_window,
--        (select count(*) from public.sessions where public_at > now()) as windows_running,
--        (select name from supabase_migrations.schema_migrations where version = '20261118210800') as ledger;
