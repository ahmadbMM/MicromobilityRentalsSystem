-- ============================================================================
-- Bug hunt 2026-11-10 (bh10), the live database, part D: the rider forms, the volunteers' portal and the website.
-- For PROD and STAGING (every function here was the same on both on 2026-11-10). Runs after 20261110235000-235300.
-- The website, form and portal code that calls these works before and after each change.
--
-- 1. customer_learn_apply (web11-1): an account whose stored height is outside 80-250 cm (0, 30, 300) could never
--    send a learn-to-ride sign-up: the stored height was kept, the one typed in was ignored, and learn_apply refused
--    it. Such a height now counts as missing: the one sent is taken, and the account keeps it after a sign-up that
--    went through.
-- 2. customer_community_apply (form-community-2): the same for the Community form, whose range is 100-250 cm.
--    community_track also gives the "please fix" request only while the application is pending: a decided one no
--    longer shows a request it can no longer act on.
-- 3. rider_edit (form-petromin-a-1, b1-1): booking numbers start again at P-001 every night, so an edit looked up by
--    number alone could open the same number on another night. It takes the night of the confirmation being edited
--    (p_from_session, a 12th argument, optional); without it the lookup is as before. The 11-argument function is
--    dropped (two would make PostgREST answer PGRST203) and the new one granted as the old one was.
-- 4. rider_registrations.added_by_desk, rider_party_add, rider_register (form-petromin-a-3): a companion the desk
--    added to a Petromin party was overwritten or deleted the next time the employee edited the party on the phone.
--    The desk's rows are marked now (rider_party_add), and a phone's resubmission leaves them alone: its own
--    companions take the party numbers from 2 up that are not the desk's, and only its own rows it did not send
--    again go. Its limit (four companions) counts its own rows only, so no new refusal. Staff calls of
--    rider_register work as before and never mark a row as the desk's.
-- 5. volunteer_cert_issue_session (web01-1): the portal's certificate took the event's name from the browser
--    (p_initiative), so a hand-made request could print any text on a certificate. It names the event as the
--    database knows it (_vol_sess_name); p_initiative stays in the signature and is not read.
-- 6. volunteer_me, _vol_note, volunteer_updates, sessions (web01-2): a cancelled night still showed in the portal as
--    the volunteer's next shift. Each of the volunteer's shifts now says 'cancelled'; when a session's cancelled_at
--    is set, its interested and accepted volunteers get an Update (kind 'cancelled', with its push text), and when
--    it is cleared again (an undo) that Update goes.
-- 7. volunteer_me (web01-7): the certificates and free rides list was built from the newest 30 hour rows only, so
--    an older event lost its Get certificate and one cut across lost hours. 'events' now lists every event worked,
--    its hours added up, uncapped; 'record' stays capped for display.
-- 8. workshop_request (web12-3): a promo code the workshop does not take was dropped in silence and the request
--    went in at full price. Now a code for rentals, one session or one kind of ride answers 'code', and a code that
--    is malformed, inactive, expired, used up or someone else's answers 'code_bad'; nothing is saved.
-- 9. customer_set_referrer (web05-1): an address over the try limit was told 'invalid' (the code not found); it is
--    told 'busy' now.
-- 10. customer_wallet_pay (web20-1): one row with nothing left to pay (free, or already paid by the wallet) raised
--    WALLET_NOTHING_DUE and failed the whole list. Such a row is passed over, as a paid one is.
-- 11. customer_accept_waiver (app13-3): on a Blood Donation session one call stamped every unsigned row with one
--    version, so a visitor's row could carry the donor's wording or the other way round. The visitor's version
--    (blood-2026-11-v2) now stamps only visitor rows, the donor's (blood-2026-11-v1) only the others; any other
--    version stamps as before.
-- 12. _vol_sess_name: an untitled Petromin night was "Petromin's Wednesdays" (wrong on a Monday); the portal and the
--    booking app say "Petromin night" since the user's pick of 2026-11-10, and with 5 the database names the
--    portal's certificates, so it says the same now.
--
-- Not changed: web01-1's optional refusal of a portal re-issue after staff withdrew the certificate: it needs an
-- error code the portal does not know yet (its Worker would answer it as a server fault).
--
-- Every function is patched in place from its live definition (pg_get_functiondef: each anchor must be found
-- exactly once, else the file stops), so lines added by other migrations survive; each carries '(20261110235400)'
-- and is skipped when it already does. Idempotent.
-- Rollback: take the patches out by hand (each is marked); recreate the 11-argument rider_edit from its text before
-- this file; drop trigger sessions_vol_cancelled and function _vol_session_cancelled; the column and the constraint
-- value can stay.
-- Run supabase/checks/security-attributes.sql after.
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


-- ── 1. customer_learn_apply: a stored height outside 80-250 counts as missing ────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef('public.customer_learn_apply(text,text,jsonb)'::regprocedure) into d;
  if position('(20261110235400)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$  if v_height is null or v_hflag then$a$,
$b$  /* a stored height outside 80-250 counts as missing: the one sent is taken (20261110235400) */
  if v_height is null or v_height not between 80 and 250 or v_hflag then$b$);
  d := pg_temp._once(d,
$a$    if c.gender is null or c.height is null or v_hflag then
      update customers set gender = coalesce(gender, v_gender), height = case when v_hflag then v_height else coalesce(height, v_height) end where id = p_id;$a$,
$b$    if c.gender is null or c.height is null or c.height not between 80 and 250 or v_hflag then
      update customers set gender = coalesce(gender, v_gender), height = case when v_hflag or height is null or height not between 80 and 250 then v_height else height end where id = p_id;$b$);
  execute d;
end $do$;


-- ── 2. customer_community_apply: the same with 100-250; community_track's fix only while pending ─
do $do$
declare d text;
begin
  select pg_get_functiondef('public.customer_community_apply(text,text,jsonb)'::regprocedure) into d;
  if position('(20261110235400)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$  if v_height is null or v_hflag then$a$,
$b$  /* a stored height outside 100-250 counts as missing: the one sent is taken (20261110235400) */
  if v_height is null or v_height < 100 or v_height > 250 or v_hflag then$b$);
  d := pg_temp._once(d,
$a$  if c.gender is null or c.height is null or v_hflag then
    update customers set gender = coalesce(gender, v_gender), height = case when v_hflag then v_height else coalesce(height, v_height) end where id = p_id;$a$,
$b$  if c.gender is null or c.height is null or c.height < 100 or c.height > 250 or v_hflag then
    update customers set gender = coalesce(gender, v_gender), height = case when v_hflag or height is null or height < 100 or height > 250 then v_height else height end where id = p_id;$b$);
  execute d;
end $do$;

do $do$
declare d text;
begin
  select pg_get_functiondef('public.community_track(text)'::regprocedure) into d;
  if position('(20261110235400)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$'fix', case when a.fix_token is not null$a$,
$b$'fix', /* only while the application is pending (20261110235400) */ case when a.status = 'pending' and a.fix_token is not null$b$);
  execute d;
end $do$;


-- ── 3. rider_edit takes the night being edited ─────────────────────────────────────────────────
do $do$
declare d text;
begin
  if to_regprocedure('public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text)') is null then
    select pg_get_functiondef('public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text)'::regprocedure) into d;
    d := pg_temp._once(d,
$a$p_waiver text DEFAULT NULL::text)
 RETURNS jsonb$a$,
$b$p_waiver text DEFAULT NULL::text, p_from_session text DEFAULT NULL::text)
 RETURNS jsonb$b$);
    d := pg_temp._once(d,
$a$   where upper(r.booking_no) = upper(trim(coalesce(p_booking_no,''))) and r.party_no = 1
$a$,
$b$   where upper(r.booking_no) = upper(trim(coalesce(p_booking_no,''))) and r.party_no = 1
     /* the night of the confirmation being edited, when the form sends it: numbers start again every night
        (20261110235400) */
     and (p_from_session is null or coalesce(r.session_id, '') = p_from_session)
$b$);
    execute d;
  end if;
  drop function if exists public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text);
end $do$;

revoke all on function public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text) from public;
grant execute on function public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text) to anon, authenticated, service_role;


-- ── 4. the desk's companions survive a phone edit ───────────────────────────────────────────────
-- The table is granted whole (no column grants), so the new column is read and written as the others are.
alter table public.rider_registrations add column if not exists added_by_desk boolean not null default false;
comment on column public.rider_registrations.added_by_desk is
  'A companion the desk added to the party (rider_party_add): a phone resubmission (rider_register, not staff) leaves it alone.';

do $do$
declare d text;
begin
  select pg_get_functiondef('public.rider_party_add(bigint,jsonb)'::regprocedure) into d;
  if position('(20261110235400)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$company, booking_no, party_no)
    values (v_row.badge, v_name, v_row.phone, v_h, v_type, null, null, 'none', v_row.source, v_row.session_id, v_row.company, v_row.booking_no, v_next)$a$,
$b$company, booking_no, party_no, added_by_desk)
    values (v_row.badge, v_name, v_row.phone, v_h, v_type, null, null, 'none', v_row.source, v_row.session_id, v_row.company, v_row.booking_no, v_next,
            true /* the desk's: a phone edit leaves it alone (20261110235400) */)$b$);
  execute d;
end $do$;

do $do$
declare d text;
begin
  select pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)'::regprocedure) into d;
  if position('(20261110235400)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$  v_staff boolean := is_staff(); v_prev rider_registrations%rowtype;
$a$,
$b$  v_staff boolean := is_staff(); v_prev rider_registrations%rowtype;
  v_desk int[] := '{}'; v_pno int := 1; v_wrote int[] := '{}';
$b$);
  d := pg_temp._once(d,
$a$  -- The companions, rows 2..N of the same booking.
  for v_i in 0 .. v_n_extra - 1 loop
    v_c := v_riders -> v_i;
$a$,
$b$  -- The companions, rows 2..N of the same booking.
  /* A phone's resubmission leaves the companions the desk added alone (added_by_desk, rider_party_add)
     (20261110235400): its own companions take the party numbers from 2 up that are not the desk's, and only its own
     rows it did not write again go below. The desk's own calls work as before (v_desk stays empty). The party's
     lock, as rider_party_add takes it, so a desk row cannot land between the read and the writes. */
  if not v_staff then
    perform pg_advisory_xact_lock(hashtext('rider-party:' || coalesce(v_sess.id, '') || ':' || v_bno));
    select coalesce(array_agg(r.party_no), '{}') into v_desk from rider_registrations r
     where r.badge_key = lower(regexp_replace(v_badge, '[^a-zA-Z0-9]', '', 'g')) and coalesce(r.session_id,'') = coalesce(v_sess.id,'')
       and r.added_by_desk;
  end if;
  for v_i in 0 .. v_n_extra - 1 loop
    v_c := v_riders -> v_i;
    v_pno := v_pno + 1;
    while v_pno = any (v_desk) loop v_pno := v_pno + 1; end loop;
    v_wrote := v_wrote || v_pno;
$b$);
  d := pg_temp._once(d,
$a$v_company, v_bno, v_i + 2, p_waiver$a$,
$b$v_company, v_bno, v_pno, p_waiver$b$);
  d := pg_temp._once(d,
$a$     and party_no > v_n_extra + 1 and checked_in_at is null;$a$,
$b$     and party_no > 1 and checked_in_at is null
     and case when v_staff then party_no > v_n_extra + 1 else not added_by_desk and party_no <> all (v_wrote) end;$b$);
  execute d;
end $do$;


-- ── 5. the portal's certificate names the event itself ──────────────────────────────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef('public.volunteer_cert_issue_session(text,text,text,text)'::regprocedure) into d;
  if position('(20261110235400)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$  return _vol_cert_make_session(p_id, p_session, p_initiative, 'portal', null);$a$,
$b$  /* the event as the database knows it, never the browser's text; p_initiative stays so calls still match
     (20261110235400) */
  return _vol_cert_make_session(p_id, p_session, _vol_sess_name(p_session), 'portal', null);$b$);
  execute d;
end $do$;


-- ── 6. a cancelled session tells its volunteers ─────────────────────────────────────────────────
do $do$
declare d text;
begin
  select pg_get_constraintdef(c.oid) into d from pg_constraint c
   where c.conrelid = 'public.volunteer_updates'::regclass and c.conname = 'volunteer_updates_kind_check';
  if d is null then raise exception 'volunteer_updates_kind_check is missing'; end if;
  if position('''cancelled''' in d) > 0 then return; end if;
  d := pg_temp._once(d, '::text])', '::text, ''cancelled''::text])');
  execute 'alter table public.volunteer_updates drop constraint volunteer_updates_kind_check, add constraint volunteer_updates_kind_check ' || d;
end $do$;

do $do$
declare d text;
begin
  select pg_get_functiondef('public._vol_note(text,text,text,jsonb)'::regprocedure) into d;
  if position('(20261110235400)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$    when 'lead'          then 'You lead$a$,
$b$    /* a session called off (20261110235400) */
    when 'cancelled'     then 'The opportunity on ' || _d || ' has been cancelled. Thank you for offering. | أُلغيت فرصة يوم ' || _dm || '. شكرًا لعرضك المساعدة.'
    when 'lead'          then 'You lead$b$);
  execute d;
end $do$;

create or replace function public._vol_session_cancelled()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare sh record;
begin
  /* A session called off tells its interested and accepted volunteers (an Update and its push); an undo takes the
     Update back (20261110235400). */
  if old.cancelled_at is null and new.cancelled_at is not null then
    for sh in select x.customer_id from volunteer_shifts x
               where x.session_id = new.id and x.status in ('interested', 'accepted') loop
      perform _vol_note(sh.customer_id, new.id, 'cancelled');
    end loop;
  elsif old.cancelled_at is not null and new.cancelled_at is null then
    delete from volunteer_updates u where u.session_id = new.id and u.kind = 'cancelled';
  end if;
  return null;
end $function$;
revoke execute on function public._vol_session_cancelled() from public, anon, authenticated;

drop trigger if exists sessions_vol_cancelled on public.sessions;
create trigger sessions_vol_cancelled after update of cancelled_at on public.sessions
  for each row when (old.cancelled_at is distinct from new.cancelled_at)
  execute function public._vol_session_cancelled();


-- ── 6, 7. volunteer_me: 'cancelled' on each shift, 'events' uncapped ─────────────────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef('public.volunteer_me(text,text)'::regprocedure) into d;
  if position('(20261110235400)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$_rec jsonb; _sum record;$a$,
$b$_rec jsonb; _sum record; _ev jsonb;$b$);
  d := pg_temp._once(d,
$a$           'can_work', _ok and w.enabled$a$,
$b$           'cancelled', s.cancelled_at is not null,
           'can_work', _ok and w.enabled$b$);
  d := pg_temp._once(d,
$a$  select min(h.worked_on) first_on, max(h.worked_on) last_on$a$,
$b$  /* every event worked, its hours added up, uncapped: one certificate and one free ride each (20261110235400) */
  select coalesce(jsonb_agg(jsonb_build_object('session_id', e.session_id, 'hours', e.hours, 'on', e.on_,
                                               'title', s.title, 'ride_kind', s.ride_kind) order by e.on_ desc, e.session_id), '[]'::jsonb)
    into _ev
    from (select h.session_id, sum(h.hours) hours, min(h.worked_on) on_
            from volunteer_hours h
           where h.customer_id = p_id and h.voided_at is null and h.session_id is not null
           group by h.session_id having sum(h.hours) > 0) e
    left join sessions s on s.id = e.session_id;
  select min(h.worked_on) first_on, max(h.worked_on) last_on$b$);
  d := pg_temp._once(d,
$a$'mine', _mine, 'record', _rec,$a$,
$b$'mine', _mine, 'record', _rec, 'events', _ev,$b$);
  execute d;
end $do$;


-- ── 8. workshop_request refuses a code it does not take ─────────────────────────────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef('public.workshop_request(jsonb)'::regprocedure) into d;
  if position('(20261110235400)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$  if v_code is not null and (v_code !~ '^[A-Za-z0-9_-]{1,40}$' or not _promo_valid(v_code, v_cust)) then v_code := null; end if;
$a$,
$b$  /* A code the workshop does not take is refused, never dropped in silence (20261110235400): one for rentals, one
     session or one kind of ride ('code'); one malformed, inactive, expired, used up or someone else's ('code_bad'). */
  if v_code is not null and exists (select 1 from promo_codes c where lower(c.code) = lower(v_code) and c.active
                                      and (c.applies_to is not null or c.session_id is not null or c.ride_kind is not null)) then
    return jsonb_build_object('ok', false, 'error', 'code');
  end if;
  if v_code is not null and (v_code !~ '^[A-Za-z0-9_-]{1,40}$' or not _promo_valid(v_code, v_cust)) then
    return jsonb_build_object('ok', false, 'error', 'code_bad');
  end if;
$b$);
  d := pg_temp._once(d,
$a$  -- A code for one rental bike type discounts no workshop job (20261005210200).
  if v_code is not null and exists (select 1 from promo_codes c where lower(c.code) = lower(v_code) and c.applies_to is not null) then
    v_code := null;
  end if;
$a$,
'');
  execute d;
end $do$;


-- ── 9. customer_set_referrer: an address over the limit is told 'busy' ──────────────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef('public.customer_set_referrer(text,text,text,text,text)'::regprocedure) into d;
  if position('(20261110235400)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$  if not _ip_gate('referral', 30, interval '10 minutes') then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;$a$,
$b$  if not _ip_gate('referral', 30, interval '10 minutes') then return jsonb_build_object('ok', false, 'reason', 'busy' /* (20261110235400) */); end if;$b$);
  execute d;
end $do$;


-- ── 10. customer_wallet_pay passes over a row with nothing due ──────────────────────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef('public.customer_wallet_pay(text,text,text[])'::regprocedure) into d;
  if position('(20261110235400)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$    took := _wallet_pay_row(q, _wallet_amount(q.price, q.addons));$a$,
$b$    /* nothing left to pay on this row: passed over, as a paid one is, so it cannot fail the list (20261110235400) */
    if _wallet_amount(q.price, q.addons) - coalesce(q.wallet_paid, 0) <= 0 then continue; end if;
    took := _wallet_pay_row(q, _wallet_amount(q.price, q.addons));$b$);
  execute d;
end $do$;


-- ── 11. customer_accept_waiver: a Blood Donation version stamps its own role's rows ─────────────
do $do$
declare d text;
begin
  select pg_get_functiondef('public.customer_accept_waiver(text,text,text,text)'::regprocedure) into d;
  if position('(20261110235400)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$     and coalesce(x.session_date, '') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  get diagnostics _n = row_count;$a$,
$b$     and coalesce(x.session_date, '') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
     /* On a Blood Donation session a donor and a visitor each read their own wording: the visitor's version stamps
        visitor rows only, the donor's the others; any other version, every row as before (20261110235400). */
     and case p_version when 'blood-2026-11-v2' then coalesce(x.blood_role, '') = 'visitor'
                        when 'blood-2026-11-v1' then coalesce(x.blood_role, '') <> 'visitor'
                        else true end;
  get diagnostics _n = row_count;$b$);
  execute d;
end $do$;


-- checks: every changed function kept SECURITY DEFINER and its search_path and carries this file's change; one
-- rider_edit, the new one, open to the forms; volunteer_me still STABLE; the trigger, the kind and the column are there
-- 12 _vol_sess_name ---------------------------------------------------------------------------------
do $do$
declare d text; a text := $a$when 'petromin' then 'Petromin''s Wednesdays'$a$;
begin
  select pg_get_functiondef('public._vol_sess_name(text)'::regprocedure) into d;
  if position('(20261110235400)' in d) > 0 then return; end if;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then
    raise exception '_vol_sess_name: anchor not found exactly once: rebuild this step from the live definition';
  end if;
  execute replace(d, a, $b$when 'petromin' then 'Petromin night' /* the user's pick, 2026-11-10 (20261110235400) */$b$);
end $do$;

do $chk$
declare f text;
begin
  foreach f in array array['public.customer_learn_apply(text,text,jsonb)', 'public.customer_community_apply(text,text,jsonb)',
                           'public.community_track(text)',
                           'public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text)',
                           'public.rider_party_add(bigint,jsonb)',
                           'public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text,text)',
                           'public.volunteer_cert_issue_session(text,text,text,text)', 'public._vol_note(text,text,text,jsonb)',
                           'public._vol_session_cancelled()', 'public.volunteer_me(text,text)', 'public.workshop_request(jsonb)',
                           'public.customer_set_referrer(text,text,text,text,text)', 'public.customer_wallet_pay(text,text,text[])',
                           'public.customer_accept_waiver(text,text,text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if position('(20261110235400)' in (select p.prosrc from pg_proc p where p.oid = f::regprocedure)) = 0 then
      raise exception '% does not carry this file''s change', f;
    end if;
  end loop;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'rider_edit') <> 1 then
    raise exception 'rider_edit: the 11-argument function is still there (PostgREST would answer PGRST203)';
  end if;
  if not has_function_privilege('anon', 'public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text)', 'execute') then
    raise exception 'rider_edit is not open to the forms';
  end if;
  if (select p.provolatile from pg_proc p where p.oid = 'public.volunteer_me(text,text)'::regprocedure) <> 's' then
    raise exception 'volunteer_me is no longer STABLE';
  end if;
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.sessions'::regclass and t.tgname = 'sessions_vol_cancelled') then
    raise exception 'sessions_vol_cancelled is missing';
  end if;
  if position('''cancelled''' in (select pg_get_constraintdef(c.oid) from pg_constraint c
                                    where c.conrelid = 'public.volunteer_updates'::regclass and c.conname = 'volunteer_updates_kind_check')) = 0 then
    raise exception 'volunteer_updates_kind_check does not take cancelled';
  end if;
  if position('Petromin night' in (select p.prosrc from pg_proc p where p.oid = 'public._vol_sess_name(text)'::regprocedure)) = 0 then
    raise exception '_vol_sess_name still names an untitled Petromin night otherwise';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'rider_registrations' and column_name = 'added_by_desk') then
    raise exception 'rider_registrations.added_by_desk is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261110235400', 'bh10_live_d')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
