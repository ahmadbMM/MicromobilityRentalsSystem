-- micromobility.sa/petromin becomes one page for Petromin, Petrolube, Dukan and Petromin's invited guests (the user,
-- 2026-11-13: "merge the petromin page with dukan page all under /petromin make the first step to select the company
-- and for dukan ask them for their height and bike type too"; their answers: a guest is a fourth choice who makes a
-- MicroMobility account on that page "and go through the whole process", books through the page each time (no tag),
-- keeps the I- number and the Invitee mark, and is asked which company they are from, typed).
--
-- Petromin, Petrolube and Dukan need nothing here: rider_register already takes a Dukan employee's height and bike
-- (20261112210000 made them optional for Dukan, never refused).
--
-- A guest's booking is now an ordinary customer booking on a Petromin night, made by petromin_guest_book:
--   * through customer_create_booking, so every rule of a rider's own booking holds (a signed-in account, the answers
--     the account owes, the waiver, the fare, the places, the waitlist) and it shows in the account's bookings;
--   * numbered I-001, I-002 ... on the night's 'invite' counter as before (invite_no, written under mm.invite, which
--     is also what lets a non-member's insert onto the members-only night);
--   * one guest booking an account a night: the same account again updates its bike and company while it waits;
--   * the company the guest types is kept on the booking (invite_company) for the desk, and on the account's Company
--     (customers.workplace).
-- petromin_invite_lookup says the company and whether the booking has an account (the page offers Edit only then);
-- petromin_invite_cancel is unchanged. The bookings made without an account on micromobility.sa/petromin-invite stay
-- as they are. petromin_invite_book stays callable until the new page is live (20261113150100 closes it).
-- form_step counts the merged page: 'pmhome' (the company step), 'pmdukan' and 'pmguest' beside 'petromin'.
-- Every block skips itself once applied, so the file can be run again safely.
-- Rollback: drop petromin_guest_book; restore petromin_invite_lookup and form_step from 20261112234500; the column
-- can stay.

begin;

-- ── 1. the guest's company on the booking ───────────────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists invite_company text;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'queue_entries_invite_company_check') then
    alter table public.queue_entries add constraint queue_entries_invite_company_check
      check (invite_company is null or length(invite_company) between 2 and 120);
  end if;
end $c$;

-- ── 2. a guest books with their account ─────────────────────────────────────────────────────────────────────────
-- p_from_no / p_from_session: the page's Edit of a booking this account holds. The same night updates it; another
-- night books there and cancels the old one, in one go.
create or replace function public.petromin_guest_book(p_id text, p_token text, p_session_id text, p_type text,
  p_company text, p_waiver text default null, p_from_no text default null, p_from_session text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $$
declare
  v_type text := coalesce(p_type, '');
  v_company text := left(btrim(regexp_replace(coalesce(p_company, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), 120);
  v_today text := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  v_stamp text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_from_no text := upper(trim(coalesce(p_from_no, '')));
  v_cust customers%rowtype;
  v_sess sessions%rowtype; v_win record;
  v_from queue_entries%rowtype; v_prev queue_entries%rowtype; v_row queue_entries%rowtype;
  v_asks text[]; v_no text; v_new_id text; v_err text;
begin
  if not _rider_gate() then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  select * into v_cust from customers where id = p_id;
  if coalesce(p_waiver, '') !~ '^[A-Za-z0-9._-]{1,40}$' then return jsonb_build_object('ok', false, 'error', 'waiver'); end if;
  if _waiver_outdated(p_waiver) then raise exception 'WAIVER_OUTDATED' using errcode = 'P0001'; end if;
  -- The company as typed: two characters or more, not punctuation alone.
  if length(v_company) < 2 or v_company !~ '[^[:punct:][:space:]]' then
    return jsonb_build_object('ok', false, 'error', 'company');
  end if;
  if v_type not in ('Road', 'Hybrid', 'Mountain') then return jsonb_build_object('ok', false, 'error', 'type'); end if;
  -- What the account owes (an emergency contact, the nationality from the second booking on, a field staff
  -- flagged) is answered first, as before any booking of its own.
  v_asks := coalesce(_customer_asks(p_id), '{}'::text[]);
  if cardinality(v_asks) > 0 then
    return jsonb_build_object('ok', false, 'error', 'fix', 'fields', to_jsonb(v_asks));
  end if;

  -- An open Petromin night that has not ended, open to everyone (never one for men or women only).
  select * into v_sess from sessions where id = p_session_id;
  if v_sess.id is null or coalesce(v_sess.ride_kind, '') <> 'petromin' or not _rider_session_open(v_sess)
     or v_sess.session_date < v_today or v_sess.gender_only is not null then
    return jsonb_build_object('ok', false, 'error', 'session');
  end if;
  select * into v_win from _session_window(v_sess);
  if v_win.ends_at <= now() then return jsonb_build_object('ok', false, 'error', 'session'); end if;

  -- The booking being edited: this account's, by its number on its night, still waiting.
  if v_from_no <> '' then
    select * into v_from from queue_entries q
     where q.invite_no = v_from_no and q.session_id = coalesce(p_from_session, '') and q.customer_id = p_id
       and q.status in ('waiting', 'waitlist', 'active', 'done')
     order by q.queue_num limit 1;
    if v_from.id is null then return jsonb_build_object('ok', false, 'error', 'notfound'); end if;
    if v_from.status in ('active', 'done') then
      return jsonb_build_object('ok', false, 'error', 'checked_in', 'invite_no', v_from.invite_no);
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('invite:' || v_sess.id || ':' || p_id));
  if v_from.id is not null and v_from.session_id = v_sess.id then
    v_prev := v_from;
  else
    select * into v_prev from queue_entries q
     where q.session_id = v_sess.id and q.invite_no is not null and q.customer_id = p_id
       and q.status in ('waiting', 'waitlist', 'active', 'done')
     order by q.queue_num limit 1;
  end if;
  if v_prev.id is not null and v_prev.status in ('active', 'done') then
    return jsonb_build_object('ok', false, 'error', 'checked_in', 'invite_no', v_prev.invite_no);
  end if;
  -- The account already rides this night on a booking of its own (a member's, a Petromin tag holder's): not twice.
  if v_prev.id is null and exists (
       select 1 from queue_entries q
        where q.session_id = v_sess.id and q.customer_id = p_id and q.invite_no is null
          and q.status in ('waiting', 'waitlist', 'active', 'done')
          and lower(btrim(coalesce(q.name, ''))) = lower(btrim(coalesce(v_cust.name, '')))) then
    return jsonb_build_object('ok', false, 'error', 'booked');
  end if;

  begin
    if v_prev.id is not null then
      update queue_entries
         set type_preference = v_type, invite_company = v_company, waiver_version = p_waiver, waiver_at = v_stamp
       where id = v_prev.id
      returning * into v_row;
    else
      v_no := _invite_next(v_sess.id);
      perform set_config('mm.invite', v_sess.id || '|' || v_no, true);
      select b.id into v_new_id
        from customer_create_booking(p_id, p_token, jsonb_build_array(jsonb_build_object(
               'session_id', v_sess.id, 'name', coalesce(v_cust.name, ''), 'type_preference', v_type,
               'waiver_version', p_waiver, 'height', v_cust.height))) b
       limit 1;
      if v_new_id is null then raise exception 'GUEST_NO_ROW'; end if;
      update queue_entries set invite_no = v_no, invite_company = v_company, via = 'invite'
       where id = v_new_id
      returning * into v_row;
      perform set_config('mm.invite', '', true);
    end if;
  exception when others then
    get stacked diagnostics v_err = message_text;
    perform set_config('mm.invite', '', true);
    if v_err = 'TYPE_CLOSED' then return jsonb_build_object('ok', false, 'error', 'type_closed'); end if;
    if v_err = 'TYPE_FULL' then return jsonb_build_object('ok', false, 'error', 'type_full'); end if;
    if v_err = 'FIX_FIRST' then
      return jsonb_build_object('ok', false, 'error', 'fix', 'fields', to_jsonb(coalesce(_customer_asks(p_id), '{}'::text[])));
    end if;
    if v_err in ('STALE_SESSION', 'ACCOUNT_ARCHIVED') then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
    if v_err = 'SESSION_CLOSED' then return jsonb_build_object('ok', false, 'error', 'session'); end if;
    raise;
  end;

  -- Edited onto another night: the old booking goes.
  if v_from.id is not null and v_from.id <> v_row.id then
    update queue_entries set status = 'cancelled', cancelled_by = 'customer' where id = v_from.id;
  end if;
  -- The company is the account's too.
  update customers set workplace = v_company where id = p_id and coalesce(workplace, '') <> v_company;

  return jsonb_build_object(
    'ok', true, 'resubmitted', v_prev.id is not null, 'booking_no', v_row.invite_no, 'invite_no', v_row.invite_no,
    'ref', 'MMC-' || v_row.queue_num || '-' || left(v_row.id, 6),
    'status', v_row.status, 'name', v_row.name, 'phone', v_row.phone, 'type', v_row.type_preference,
    'company', v_row.invite_company, 'price', v_row.price,
    'session', jsonb_build_object('id', v_sess.id, 'title', v_sess.title,
      'start', to_char(v_win.starts_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
      'end',   to_char(v_win.ends_at   at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
      'collect', _rider_collect(v_sess),
      'place', nullif(trim(coalesce(v_sess.location, '')), '')));
end $$;
revoke all on function public.petromin_guest_book(text, text, text, text, text, text, text, text) from public;
grant execute on function public.petromin_guest_book(text, text, text, text, text, text, text, text) to anon, authenticated;

-- ── 3. Find my booking says the company and whether the booking has an account ──────────────────────────────────
create or replace function pg_temp._once(src text, a text, b text, n integer default 1) returns text
language plpgsql as $f$
declare c integer := (length(src) - length(replace(src, a, ''))) / greatest(length(a), 1);
begin
  if c <> n then raise exception 'petromin_merged_page: expected % of [%], found %', n, left(a, 80), c; end if;
  return replace(src, a, b);
end $f$;

do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.petromin_invite_lookup(text,text,text)'::regprocedure);
  if position('invite_company' in d) > 0 then raise notice 'petromin_invite_lookup already says the company; nothing to do'; return; end if;
  d := pg_temp._once(d,
$a$'company', null, 'name', v_row.name,$a$,
$b$'company', v_row.invite_company, 'account', v_row.customer_id is not null, 'name', v_row.name,$b$);
  execute d;
end $mig$;

-- ── 4. form_step: the merged page's steps ───────────────────────────────────────────────────────────────────────
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.form_step(text,integer,text,text,text)'::regprocedure);
  if position('pmhome' in d) > 0 then raise notice 'form_step already counts the merged page; nothing to do'; return; end if;
  d := pg_temp._once(d,
$a$p_form not in ('petromin', 'dukan', 'pminvite')$a$,
$b$p_form not in ('petromin', 'dukan', 'pminvite', 'pmhome', 'pmdukan', 'pmguest')$b$);
  execute d;
end $mig$;

do $chk$
begin
  if not (select prosecdef from pg_proc where oid = 'public.petromin_invite_lookup(text,text,text)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.form_step(text,integer,text,text,text)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.petromin_guest_book(text,text,text,text,text,text,text,text)'::regprocedure) then
    raise exception 'petromin_merged_page: a function lost SECURITY DEFINER';
  end if;
end $chk$;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261113150000', 'petromin_merged_page')
on conflict (version) do nothing;

commit;
