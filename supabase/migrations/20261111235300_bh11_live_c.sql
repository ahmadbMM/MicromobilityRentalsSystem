-- ============================================================================
-- Bug hunt 2026-11-11 (bh11), the live database, part C: the database half of fixes made in the apps and forms.
-- For PROD and STAGING (every function here was the same on both on 2026-11-12). Apply after
-- 20261111235000_bh11_live_a.sql and 20261111235100_bh11_live_b.sql (neither touches these functions). Each app or
-- form works before and after this file.
--
-- 1. staff_delete_session (app18-1): a session was refused only while it held a booking still to come ('waiting',
--    'waitlist', 'active'), so a past night whose riders had all ridden ('done') could be deleted, and the app's
--    "Delete the N empty ones" judges "empty" only from the bookings a device holds (60 to 365 days). Any booking
--    that is not cancelled, removed or a no-show now holds the night (HAS_BOOKINGS, which the app already shows).
--    With it (app19-4): session_rota gets a unique index on (session, role, name without case or outer spaces), so
--    a double tap on the rota's Add cannot put the same name on a role twice (the app takes the 23505 as an
--    ordinary write error). Both projects' rota tables were empty on 2026-11-12; if duplicates have appeared since,
--    the index is not made (a notice says so) and the rest of the file still applies.
-- 2. staff_cancel_session (app26-4): the personal codes the cancel extends by 14 days came back with their new end
--    date only, so the app's Undo could not put the old one back. Each item of 'extended' is now {code, expires_at,
--    was}, 'was' being the end date before the extension; the same codes are extended as before.
-- 3. _vl_entry_guard (app33-3): a staffer putting an athlete in a Doubles team (a team code typed in Edit athlete,
--    or any write that brings the row into a team) skipped the team-size check, so two desks joining the same code
--    at once made a team of three. The staff path now takes the customer path's team lock and refuses a third
--    member (VL_TEAM_FULL, which the app already shows). It counts only when the row comes into the team (a new row,
--    another code, another session, or a cancelled, removed or no-show row taken back), never on an edit of a
--    member already in it. Race and gender stay the staff's call. No team on production had more than two live
--    members on 2026-11-12.
-- 4. customer_lockers (form-lockers-4): the Lockers page offered Change on a locker whose booking was already paid,
--    and customer_locker_change always refuses that. Each row now carries bill_paid (the booking it rides on is
--    paid), and the page hides Change for it.
-- 5. rider_lookup (form-petromin a-1, b1-1, a-4): (a) each companion in 'riders' says whether the desk added it
--    ('desk', true or false), so Edit leaves the desk's companions out of what it sends back instead of copying
--    them; (b) a night that has ended (six hours after its end, the form's rule) is picked after the nights still
--    to come; (c) a new 'more' lists the other nights (ids, by date) the same number and phone hold from yesterday
--    on, since numbers start again each night, and the form asks for each with p_session_id.
-- 6. volunteer_blood_role (web03-5): the answer now also says the role before the switch ('prev') and whether
--    nothing changed ('noop'), so the portal no longer counts a donor/visitor switch that another volunteer had
--    already made.
-- 7. workshop_request (web14-1): a second request within ten minutes with the same phone, service and day got the
--    first job's reference back (repeat) and no new job, even for another bike. The repeat now needs the whole
--    request to match (time, lane, pickup address, bike, notes and parts too), so a retry still gets its reference
--    and a second bike gets its own job.
--
-- Not changed: volunteer_cert_issue_session (web01-2): the live function already ignores p_initiative and names
-- the event from the database (_vol_sess_name, 20261110235400), which is what was asked. volunteer_apply (web02-7,
-- clearing a saved T-shirt size): an owner decision; the portal no longer offers to clear a saved size.
--
-- Each function is replaced from its live definition (header as pg_get_functiondef prints it; the live text checked
-- by md5 on both projects before the fix: staff_cancel_session is 20261111010000's text without its "--" comments,
-- workshop_request is 20260924180000's with the 20261005210200 and 20261110235400 patches, the others are their
-- latest migration's text). CREATE OR REPLACE keeps the owner and the grants. Idempotent.
-- Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- 1 staff_delete_session -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_delete_session(p_id text, p_op text, p_approval text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s sessions%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into s from sessions where id = p_id for update;
  if s.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  /* A booking that rode ('done') holds the night as well as one still to come: a past night whose riders all rode
     is not empty, and the app judges "empty" only from the bookings a device holds (bug hunt 2026-11-11,
     20261111235300). Cancelled, removed and no-show rows still leave a night empty. */
  if exists (select 1 from queue_entries where session_id = p_id and status not in ('removed', 'cancelled', 'noshow')) then
    raise exception 'HAS_BOOKINGS' using errcode = '55000';
  end if;
  if exists (select 1 from cashier_sales
              where session_id = p_id and voided_at is null and refunded_at is null and pay is distinct from 'refunded') then
    raise exception 'HAS_SALES' using errcode = '55000';
  end if;
  update sessions set status = 'deleted' where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'status', 'deleted', 'previous_status', s.status);
end $function$;

-- 1b session_rota: a name once per role on a session -----------------------------------------------------------
do $rota$
begin
  if exists (select 1 from public.session_rota group by session_id, role, lower(btrim(name)) having count(*) > 1) then
    raise notice 'session_rota holds a name twice on one role of a session: session_rota_one_name is not made. Remove the extra rows and run this file again.';
  else
    create unique index if not exists session_rota_one_name on public.session_rota (session_id, role, lower(btrim(name)));
  end if;
end $rota$;

-- 2 staff_cancel_session -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_cancel_session(p_id text, p_reason text DEFAULT NULL::text, p_wallet text[] DEFAULT NULL::text[], p_op text DEFAULT NULL::text, p_approval text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s sessions%rowtype;
  q queue_entries%rowtype;
  w jsonb;
  why text := left(nullif(btrim(coalesce(p_reason, '')), ''), 300);
  wl text[] := coalesce(p_wallet, '{}'::text[]);
  race boolean;
  desk numeric; held numeric; card numeric; total numeric := 0; to_w numeric := 0; wal_back numeric := 0;
  n int := 0; online int := 0; org int := 0;
  c_rows jsonb := '[]'::jsonb; wallets jsonb := '[]'::jsonb; by_hand jsonb := '[]'::jsonb; ext jsonb := '[]'::jsonb;
  ids text[] := '{}'::text[]; owed text[] := '{}'::text[]; codes text[] := '{}'::text[]; v_bikes text[] := '{}'::text[];
  freed text[] := '{}'::text[];
  till date := (now() at time zone 'Asia/Riyadh')::date + 14;
begin
  if not is_staff() or not _staff_mod('queue', true) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if not _pin_ok(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  select * into s from sessions where id = p_id for update;
  if s.id is null or s.status = 'deleted' then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  race := coalesce(s.ride_kind, '') in ('vlap', 'arena');

  for q in
    select e.* from queue_entries e
     where e.session_id = p_id
       and (e.status in ('waiting', 'waitlist', 'active') or (e.status = 'cancelled' and coalesce(e.paid, false)))
     order by e.queue_num nulls last, e.id
     for update
  loop
    if q.status <> 'cancelled' then
      n := n + 1;
      ids := ids || q.id;
      c_rows := c_rows || jsonb_build_object('id', q.id, 'was', q.status);
      if q.status = 'active' then v_bikes := v_bikes || _bike_ids(q.assigned_bike_id); end if;
      if nullif(q.promo_code, '') is not null then codes := codes || lower(q.promo_code); end if;
      wal_back := wal_back + case when coalesce(q.paid, false) and q.pay_method = 'wallet' then _wallet_amount(q.price, q.addons)
                                  else coalesce(q.wallet_paid, 0) end;
      if coalesce(q.paid, false) and q.pay_method = 'online' then online := online + 1; end if;
      if coalesce(q.paid, false) and q.pay_method = 'transfer' then org := org + 1; end if;
    end if;
    continue when not coalesce(q.paid, false) or coalesce(q.pay_method, '') in ('wallet', 'online', 'transfer');
    if q.status = 'cancelled' then
      select greatest(coalesce(-sum(l.amount), 0), 0) into held from wallet_ledger l
       where l.booking_id = q.id and l.kind in ('spend', 'return') and l.created_at < coalesce(q.cancelled_at, 'infinity'::timestamptz);
    else
      held := coalesce(q.wallet_paid, 0);
    end if;
    desk := round(_wallet_amount(q.price, q.addons) - held, 2);
    continue when desk <= 0;
    total := total + desk;
    owed := owed || q.id;
    card := case when q.card_amount is not null then least(greatest(q.card_amount, 0), desk)
                 when q.pay_method = 'card' then desk when q.pay_method = 'cash' then 0 end;
    if q.id = any(wl) then
      if q.customer_id is null then raise exception 'WALLET_NO_ACCOUNT' using errcode = 'P0001'; end if;
      if race then raise exception 'WALLET_RACE' using errcode = 'P0001'; end if;
      to_w := to_w + desk;
      wallets := wallets || jsonb_build_object('id', q.id, 'customer', q.customer_id, 'amount', desk, 'card', card,
        'method', case when q.card_amount is not null then 'split' when q.pay_method in ('card', 'cash') then q.pay_method end);
    else
      by_hand := by_hand || jsonb_build_object('id', q.id, 'name', q.name, 'phone', q.phone, 'amount', desk, 'card', card,
        'method', case when q.card_amount is not null then 'split' else q.pay_method end, 'was', q.status);
    end if;
  end loop;

  if total > 0 then
    if not _staff_cap('can_refund') then raise exception 'CAP_REFUND' using errcode = '42501'; end if;
    if not _mgr_ok('refund', total, p_approval) then raise exception 'MANAGER_REQUIRED' using errcode = '42501'; end if;
  end if;
  if to_w > 0 and not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;

  update sessions set status = 'closed', cancelled_at = coalesce(cancelled_at, now()),
         cancel_reason = coalesce(why, cancel_reason), opens_at = null
   where id = p_id;

  if to_w > 0 then
    perform set_config('mm.wallet_op', coalesce(p_op, ''), true);
    perform set_config('mm.wallet_note', left('not_given' || coalesce(': ' || why, ''), 300), true);
    for w in select x from jsonb_array_elements(wallets) x loop
      perform _wallet_post(_wallet_owner(w ->> 'customer'), (w ->> 'amount')::numeric, 'refund', w ->> 'method',
                           (w ->> 'card')::numeric, w ->> 'id', null, p_id);
    end loop;
    perform set_config('mm.wallet_note', '', true);
  end if;
  if cardinality(owed) > 0 then
    update queue_entries set paid = false, pay_method = null, card_amount = null where id = any(owed);
  end if;

  if cardinality(ids) > 0 then
    update queue_entries set status = 'cancelled', cancelled_by = 'staff', cancel_reason = 'session_cancelled',
           cancel_note = why, assigned_bike_id = null
     where id = any(ids);
  end if;

  if cardinality(codes) > 0 then
    /* Each code's end date before the 14 days comes back as 'was', so the app's Undo can put it back
       (bug hunt 2026-11-11, 20261111235300). The same codes as before. */
    with b4 as (
      select p.id, p.expires_at as was from promo_codes p
       where lower(p.code) = any(codes)
         and p.expires_at is not null and p.expires_at < till
         and (p.customer_id is not null or p.blood_entry_id is not null or p.referral_friend_id is not null
              or p.referral_welcome_of is not null or p.referral_bonus_of is not null or p.volunteer_session_id is not null)
       for update),
    x as (
      update promo_codes p set expires_at = till from b4 where p.id = b4.id
      returning p.code, p.expires_at, b4.was)
    select coalesce(jsonb_agg(jsonb_build_object('code', x.code, 'expires_at', x.expires_at, 'was', x.was)), '[]'::jsonb) into ext from x;
  end if;

  if cardinality(v_bikes) > 0 then
    with b as (update bikes set status = 'available' where id = any(v_bikes) and status = 'in-use' returning id)
    select coalesce(array_agg(b.id), '{}'::text[]) into freed from b;
  end if;

  return jsonb_build_object('ok', true, 'id', p_id, 'cancelled', n, 'rows', c_rows,
    'total', total, 'to_wallet', to_w, 'wallet', wallets, 'by_hand', by_hand, 'wallet_back', wal_back,
    'online', online, 'organiser', org, 'codes', cardinality(codes), 'extended', ext, 'bikes', to_jsonb(freed),
    'previous_status', s.status);
end $function$;

-- 3 _vl_entry_guard ------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._vl_entry_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s record; c record; m record; cfg jsonb; v jsonb;
  _staff boolean := (select is_staff());
  _race text; _div text; _shirt text; _t5 text; _team text; _join text; _pair boolean;
  _dbl boolean; _day date; _n int; _races text[]; _divs text[];
  _ar boolean; _pfx text; _first text; _last text; _email text; _phone text;
  _fresh boolean := false; _comes boolean := false;
begin
  select x.ride_kind, x.session_date, x.vl into s from sessions x where x.id = new.session_id;
  if not found or coalesce(s.ride_kind, '') not in ('vlap', 'arena') then return new; end if;
  -- the Arena Heros Hybrid Race (20261028200000): women's or men's Doubles, Open or Elite, the athlete's own details
  _ar := s.ride_kind = 'arena';
  _pfx := case when _ar then 'AH' else 'VL' end;

  v := case when jsonb_typeof(new.vl) = 'object' then new.vl else '{}'::jsonb end;
  _race  := nullif(lower(btrim(coalesce(v->>'race', ''))), '');
  _div   := nullif(lower(btrim(coalesce(v->>'div', ''))), '');
  _shirt := nullif(upper(btrim(coalesce(v->>'shirt', ''))), '');
  _t5    := nullif(lower(btrim(coalesce(v->>'t5k', ''))), '');
  _team  := nullif(upper(btrim(coalesce(v->>'team', ''))), '');
  _join  := _race_code_norm(v->>'join', _pfx);
  _pair  := coalesce(v->>'pair', '') = 'true';
  if _ar then
    _first := nullif(left(btrim(regexp_replace(coalesce(v->>'first', ''), '\s+', ' ', 'g')), 40), '');
    _last  := nullif(left(btrim(regexp_replace(coalesce(v->>'last', ''), '\s+', ' ', 'g')), 40), '');
    _email := nullif(left(lower(btrim(coalesce(v->>'email', ''))), 120), '');
    _phone := nullif(left(regexp_replace(coalesce(v->>'phone', ''), '[^0-9+]', '', 'g'), 16), '');
    _shirt := null; _t5 := null;
    if _race is not null and _race not in ('wd', 'md') then
      raise exception 'Pick a race.' using errcode = 'P0001', detail = 'VL_RACE';
    end if;
    if _div is not null and _div not in ('op', 'el') then
      raise exception 'Pick a division.' using errcode = 'P0001', detail = 'VL_DIV';
    end if;
  else
    if _race is not null and _race not in ('ws', 'ms', 'wd', 'md', 'xd') then
      raise exception 'Pick a race.' using errcode = 'P0001', detail = 'VL_RACE';
    end if;
    if _div is not null and _div not in ('so', 'se', 'op', 'el') then
      raise exception 'Pick a division.' using errcode = 'P0001', detail = 'VL_DIV';
    end if;
    if _shirt is not null and _shirt not in ('XS', 'S', 'M', 'L', 'XL', 'XXL') then
      raise exception 'Pick a T-shirt size.' using errcode = 'P0001', detail = 'VL_SHIRT';
    end if;
    if _t5 is not null and _t5 not in ('u20', 'm2030', 'o30') then _t5 := null; end if;
  end if;
  _dbl := coalesce(_race in ('wd', 'md', 'xd'), false);

  if _staff then
    if not _dbl then _team := null; _pair := false;
    elsif _team = '*' then _team := _vl_code_new(new.session_id); _fresh := true;
    elsif _join is not null then _team := _join;
    elsif _team is not null then _team := _race_code_norm(_team, _pfx);
    end if;
    if _team is not null then _pair := false; end if;
    /* A team the desk puts an athlete in holds two, as it does for a customer: two desks joining the same code at
       once made a team of three (bug hunt 2026-11-11, 20261111235300). The customer's lock and count; the race and
       gender rules stay the staff's call. Counted only when the row comes into the team: a new row, another code,
       another session, or a cancelled, removed or no-show row taken back; a new code ('*') has nobody yet. */
    if _team is not null and not _fresh and coalesce(new.status, '') not in ('cancelled', 'removed', 'noshow') then
      if tg_op = 'INSERT' then
        _comes := true;
      elsif old.vl->>'team' is distinct from _team or old.session_id is distinct from new.session_id
            or coalesce(old.status, '') in ('cancelled', 'removed', 'noshow') then
        _comes := true;
      end if;
      if _comes then
        perform pg_advisory_xact_lock(hashtext('vlteam:' || coalesce(new.session_id, '') || ':' || _team));
        select count(*) into _n from queue_entries q
         where q.session_id = new.session_id and q.vl->>'team' = _team and q.id <> new.id
           and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
        if _n >= 2 then
          raise exception 'This team is complete.' using errcode = 'P0001', detail = 'VL_TEAM_FULL';
        end if;
      end if;
    end if;
    new.vl := jsonb_strip_nulls(jsonb_build_object('race', _race, 'div', _div, 'shirt', _shirt, 't5k', _t5,
                'team', _team, 'pair', case when _pair then true end,
                'first', _first, 'last', _last, 'email', _email, 'phone', _phone));
    return new;
  end if;

  if new.customer_id is null then return new; end if;
  if coalesce(new.status, '') in ('cancelled', 'removed', 'noshow', 'done') then
    if v ? 'join' then new.vl := v - 'join'; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.session_id is not distinct from new.session_id
     and coalesce(old.status, '') not in ('cancelled', 'removed', 'noshow')
     and old.vl is not distinct from new.vl then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtext('ridecap:' || coalesce(new.session_id, '') || ':' || new.customer_id));

  if _join is null and _dbl and _team is not null and tg_op = 'UPDATE'
     and coalesce(old.status, '') in ('cancelled', 'removed', 'noshow') then
    _join := _team;
  end if;

  select x.name, x.email, x.birth_date, x.gender, x.emergency_name, x.emergency_phone, x.emergency_relation
    into c from customers x where x.id = new.customer_id;
  if not found then
    raise exception 'Athlete details are missing.' using errcode = 'P0001', detail = 'VL_DETAILS';
  end if;

  if _join is not null then
    perform pg_advisory_xact_lock(hashtext('vlteam:' || coalesce(new.session_id, '') || ':' || _join));
    select count(*) as n, min(q.vl->>'race') as race, min(q.vl->>'div') as div, min(cx.gender) as gender,
           bool_or(q.customer_id = new.customer_id) as self
      into m
      from queue_entries q left join customers cx on cx.id = q.customer_id
     where q.session_id = new.session_id and q.vl->>'team' = _join and q.id <> new.id
       and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
    if m.n = 0 and tg_op = 'INSERT' then
      raise exception 'No team with this code.' using errcode = 'P0001', detail = 'VL_NO_TEAM';
    end if;
    if m.n >= 2 then
      raise exception 'This team is complete.' using errcode = 'P0001', detail = 'VL_TEAM_FULL';
    end if;
    if coalesce(m.self, false) then
      raise exception 'This is your own team.' using errcode = 'P0001', detail = 'VL_TEAM_SELF';
    end if;
    if m.n = 1 then
      _race := m.race; _div := m.div; _dbl := true;
      if _race = 'xd' and c.gender is not null and c.gender = m.gender then
        raise exception 'Mixed Doubles is one woman and one man.' using errcode = 'P0001', detail = 'VL_GENDER';
      end if;
    end if;
    _team := _join; _pair := false;
  end if;

  cfg := case when jsonb_typeof(s.vl) = 'object' then s.vl else '{}'::jsonb end;
  _races := case when jsonb_typeof(cfg->'races') = 'array'
                 then array(select jsonb_array_elements_text(cfg->'races'))
                 when _ar then array['wd', 'md'] else array['ws', 'ms', 'wd', 'md', 'xd'] end;
  _divs  := case when jsonb_typeof(cfg->'divs') = 'array'
                 then array(select jsonb_array_elements_text(cfg->'divs'))
                 when _ar then array['op', 'el'] else array['so', 'se', 'op', 'el'] end;
  if _race is null or (_join is null and not (_race = any(_races))
                       and not (tg_op = 'UPDATE' and old.vl->>'race' is not distinct from _race)) then
    raise exception 'Pick a race.' using errcode = 'P0001', detail = 'VL_RACE';
  end if;
  if _div is null or (_join is null and not (_div = any(_divs))
                      and not (tg_op = 'UPDATE' and old.vl->>'div' is not distinct from _div)) then
    raise exception 'Pick a division.' using errcode = 'P0001', detail = 'VL_DIV';
  end if;

  if _ar then
    -- the details the organisers asked for, as the athlete entered them, and a gender on the account
    if _first is null or _last is null or not _name_chars_ok(_first || ' ' || _last) or not _name_parts_ok(_first || ' ' || _last)
       or coalesce(_email, '') !~ '^[^[:space:]@<>"''()]+@[^[:space:]@<>"''()]+\.[^[:space:]@<>"''()]+$'
       or coalesce(_phone, '') !~ '^\+?[0-9]{8,15}$'
       or coalesce(c.gender, '') not in ('male', 'female') then
      raise exception 'Athlete details are missing.' using errcode = 'P0001', detail = 'VL_DETAILS';
    end if;
  else
    if _shirt is null then
      raise exception 'Pick a T-shirt size.' using errcode = 'P0001', detail = 'VL_SHIRT';
    end if;
    if coalesce(array_length(array_remove(regexp_split_to_array(btrim(coalesce(c.name, '')), '\s+'), ''), 1), 0) < 2
       or nullif(btrim(coalesce(c.email, '')), '') is null
       or coalesce(c.gender, '') not in ('male', 'female')
       or nullif(btrim(coalesce(c.emergency_name, '')), '') is null
       or nullif(btrim(coalesce(c.emergency_phone, '')), '') is null
       or nullif(btrim(coalesce(c.emergency_relation, '')), '') is null then
      raise exception 'Athlete details are missing.' using errcode = 'P0001', detail = 'VL_DETAILS';
    end if;
    begin _day := nullif(s.session_date, '')::date; exception when others then _day := null; end;
    if c.birth_date is null or not _ymd_ok(c.birth_date)
       or (c.birth_date::date + interval '16 years')::date > coalesce(_day, (now() at time zone 'Asia/Riyadh')::date) then
      raise exception 'Athletes must be 16 or over on race day.' using errcode = 'P0001', detail = 'VL_AGE';
    end if;
  end if;
  if (_race in ('ws', 'wd') and c.gender <> 'female') or (_race in ('ms', 'md') and c.gender <> 'male') then
    raise exception 'This race is for another gender.' using errcode = 'P0001', detail = 'VL_GENDER';
  end if;
  if nullif(btrim(coalesce(new.data_share_at, '')), '') is null then
    if _ar then
      raise exception 'Agree to share your details with WeSportify, Mile and Gymnation.' using errcode = 'P0001', detail = 'VL_SHARE';
    end if;
    raise exception 'Agree to share your details with Kamin Sports.' using errcode = 'P0001', detail = 'VL_SHARE';
  end if;

  -- Victory Lap: one Singles and one Doubles place; the Arena race: one place
  select count(*) into _n from queue_entries q
   where q.session_id = new.session_id and q.customer_id = new.customer_id and q.id <> new.id
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
     and (_ar or coalesce(q.vl->>'race' in ('wd', 'md', 'xd'), false) = _dbl);
  if _n >= 1 then
    raise exception 'You already have a place in this race.' using errcode = 'P0001', detail = 'VL_ONE_EACH';
  end if;

  if _dbl then
    if _join is null then
      if _team is not null and tg_op = 'UPDATE' then
        if old.vl->>'div' is distinct from _div and exists (
             select 1 from queue_entries q where q.session_id = new.session_id and q.vl->>'team' = _team
               and q.id <> new.id and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')) then
          raise exception 'Your partner has joined: staff change the division now.' using errcode = 'P0001', detail = 'VL_TEAM_LOCKED';
        end if;
      elsif _pair then
        _team := null;
      else
        _team := _vl_code_new(new.session_id);
      end if;
    end if;
    if _team is not null then _pair := false; end if;
  else
    _team := null; _pair := false;
  end if;

  new.vl := jsonb_strip_nulls(jsonb_build_object('race', _race, 'div', _div, 'shirt', _shirt, 't5k', _t5,
              'team', _team, 'pair', case when _pair then true end,
              'first', _first, 'last', _last, 'email', _email, 'phone', _phone));
  return new;
end $function$;

-- 4 customer_lockers -----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_lockers(p_id text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  /* bill_paid: the booking a locker rides on is paid, so the desk changes it, not the rider (bug hunt 2026-11-11,
     20261111235300) */
  if not _cust_token_ok(p_id, p_token) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'booking_id', r.booking_id, 'day', r.day, 'period', r.period,
                                        'status', r.status, 'price', r.price, 'on_bill', r.on_bill, 'pay', r.pay,
                                        'paid', r.receipt_id is not null, 'code', l.code, 'name', r.name,
                                        'bill_paid', coalesce(q.paid, false)) order by r.day, r.created_at)
      from locker_rentals r
      left join queue_entries q on q.id = r.booking_id
      left join lockers l on l.id = r.locker_id
     where r.status <> 'cancelled'
       and r.day >= (now() at time zone 'Asia/Riyadh')::date - 1
       and ((r.booking_id is not null and q.customer_id = p_id) or (r.booking_id is null and r.customer_id = p_id))), '[]'::jsonb);
end $function$;

-- 5 rider_lookup ---------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rider_lookup(p_booking_no text, p_phone text, p_session_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_proof text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  v_no text := upper(trim(coalesce(p_booking_no, '')));
  v_row rider_registrations%rowtype;
  v_sess sessions%rowtype;
  v_start timestamptz; v_end timestamptz;
  v_more jsonb := '[]'::jsonb;
begin
  -- Twenty misses from one address in ten minutes lock it for ten more; a booking found never counts.
  if exists (select 1 from login_throttle where identifier = 'rlookup:' || _client_ip() and locked_until > now()) then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  if v_no <> '' and length(v_proof) = 9 then
    /* a night that has ended (six hours after its end, the form's own rule) comes after the nights still to come
       (bug hunt 2026-11-11, 20261111235300) */
    select r.* into v_row from rider_registrations r join sessions s on s.id = r.session_id
     cross join lateral _session_window(s) w
     where upper(r.booking_no) = v_no and r.party_no = 1
       and r.phone is not null and right(regexp_replace(r.phone, '\D', '', 'g'), 9) = v_proof
       and (p_session_id is null or r.session_id = p_session_id)
       -- tonight's or a later night's: a night over since yesterday is no longer shown
       and s.session_date >= to_char(now() at time zone 'Asia/Riyadh' - interval '1 day', 'YYYY-MM-DD')
     order by (w.ends_at + interval '6 hours' < now()), s.session_date, r.session_id
     limit 1;
  end if;
  if v_row.id is null then
    perform _ip_gate('rlookup', 20, interval '10 minutes');
    return jsonb_build_object('ok', false, 'error', 'notfound');
  end if;
  select * into v_sess from sessions where id = v_row.session_id;
  /* The other nights the same number and phone hold (numbers start again each night), so the form can offer each
     one; it asks for it with p_session_id, a hit that never counts toward the throttle. */
  select coalesce(jsonb_agg(to_jsonb(x.session_id) order by x.session_date, x.session_id), '[]'::jsonb) into v_more
    from (select distinct r.session_id, s.session_date
            from rider_registrations r join sessions s on s.id = r.session_id
           where upper(r.booking_no) = v_no and r.party_no = 1
             and r.phone is not null and right(regexp_replace(r.phone, '\D', '', 'g'), 9) = v_proof
             and r.session_id <> v_row.session_id
             and s.session_date >= to_char(now() at time zone 'Asia/Riyadh' - interval '1 day', 'YYYY-MM-DD')) x;
  select w.starts_at, w.ends_at into v_start, v_end from _session_window(v_sess) w;
  return jsonb_build_object(
    'ok', true,
    'booking_no', v_row.booking_no,
    'company', v_row.company, 'badge', v_row.badge, 'name', v_row.name, 'phone', v_row.phone,
    'height', v_row.height, 'type', v_row.type_preference,
    'checked_in', exists (select 1 from rider_registrations r
                           where r.booking_no = v_row.booking_no and r.session_id = v_row.session_id and r.checked_in_at is not null),
    'session', jsonb_build_object(
      'id', v_sess.id, 'title', v_sess.title,
      'start', to_char(v_start at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
      'end',   to_char(v_end   at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
      'collect', _rider_collect(v_sess),
      'place', nullif(trim(coalesce(v_sess.location, '')), '')),
    'more', v_more,
    /* desk: a companion the desk added; the form shows it and leaves it out of what it sends back */
    'riders', coalesce((select jsonb_agg(jsonb_build_object('name', r.name, 'height', r.height, 'type', r.type_preference,
                                                            'desk', coalesce(r.added_by_desk, false)) order by r.party_no)
                          from rider_registrations r
                         where r.booking_no = v_row.booking_no and r.session_id = v_row.session_id and r.party_no > 1), '[]'::jsonb));
end $function$;

-- 6 volunteer_blood_role -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.volunteer_blood_role(p_id text, p_token text, p_session text, p_entry_id text, p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare q queue_entries%rowtype; _prev text;
begin
  perform _vol_gate(p_id, p_token, p_session, 'checkin');
  select * into q from queue_entries where id = p_entry_id and session_id = p_session for update;
  if not found then raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001'; end if;
  if q.customer_id is not distinct from p_id then raise exception 'VOL_OWN_BOOKING' using errcode = '42501'; end if;
  if q.status not in ('waiting', 'waitlist', 'active', 'done') then raise exception 'BAD_BOOKING_STATE' using errcode = 'P0001'; end if;
  _prev := _blood_role_apply(q.id, p_role);
  perform _vol_log(p_id, p_session, 'role', q.id, p_role, _prev);
  /* prev and noop: the portal counts a switch only when the role really changed (bug hunt 2026-11-11,
     20261111235300) */
  return jsonb_build_object('ok', true, 'role', p_role, 'prev', _prev, 'noop', _prev is not distinct from p_role);
end $function$;

-- 7 workshop_request -----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.workshop_request(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_name    text := regexp_replace(trim(coalesce(p->>'name','')), '\s+', ' ', 'g');
  v_phone   text := trim(coalesce(p->>'phone',''));
  v_email   text := nullif(lower(trim(coalesce(p->>'email',''))), '');
  v_service text := coalesce(p->>'service','');
  v_label   text := nullif(trim(coalesce(p->>'service_label','')), '');
  v_price   numeric;
  v_parts   jsonb := coalesce(p->'parts', '[]'::jsonb);
  v_lane    text := coalesce(nullif(p->>'lane',''), 'dropoff');
  v_addr    text := nullif(trim(coalesce(p->>'pickup_address','')), '');
  v_date    date;
  v_time    text := nullif(p->>'preferred_time','');
  v_bike    text := nullif(trim(coalesce(p->>'bike','')), '');
  v_notes   text := nullif(trim(coalesce(p->>'notes','')), '');
  v_lang    text := coalesce(nullif(p->>'lang',''), 'en');
  v_code    text := nullif(translate(btrim(coalesce(p->>'code','')), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '');
  v_cust    text;
  v_today   date := (now() at time zone 'Asia/Riyadh')::date;
  v_part    jsonb;
  v_prev    bigint;
  v_id      bigint;
begin
  if not _ip_gate('workshop', 10, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  if v_name = '' or length(v_name) > 120 or not _name_chars_ok(v_name) then return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' or (v_phone like '+966%' and v_phone !~ '^\+9665[0-9]{8}$') then
    return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$') then
    return jsonb_build_object('ok', false, 'error', 'email'); end if;
  if v_service !~ '^[a-z0-9_-]{1,40}$' then return jsonb_build_object('ok', false, 'error', 'service'); end if;
  if v_label is not null and (length(v_label) > 80 or v_label ~ '[<>`]') then return jsonb_build_object('ok', false, 'error', 'service'); end if;
  begin v_price := nullif(p->>'price','')::numeric; exception when others then v_price := null; end;
  if v_price is not null and (v_price < 0 or v_price > 100000) then v_price := null; end if;
  if jsonb_typeof(v_parts) <> 'array' or jsonb_array_length(v_parts) > 10 then return jsonb_build_object('ok', false, 'error', 'parts'); end if;
  for v_part in select * from jsonb_array_elements(v_parts) loop
    if jsonb_typeof(v_part) <> 'object' or coalesce(v_part->>'id','') !~ '^[a-z0-9_-]{1,40}$'
       or length(coalesce(v_part->>'label','')) > 80 or coalesce(v_part->>'label','') ~ '[<>`]' then
      return jsonb_build_object('ok', false, 'error', 'parts'); end if;
  end loop;
  if v_lane not in ('dropoff','wait','pickup') then return jsonb_build_object('ok', false, 'error', 'lane'); end if;
  if v_lane = 'pickup' and (v_addr is null or length(v_addr) > 200) then return jsonb_build_object('ok', false, 'error', 'pickup_address'); end if;
  if v_lane <> 'pickup' then v_addr := null; end if;
  if nullif(p->>'preferred_date','') is not null then
    begin v_date := (p->>'preferred_date')::date; exception when others then return jsonb_build_object('ok', false, 'error', 'date'); end;
    if v_date < v_today or v_date > v_today + 60 then return jsonb_build_object('ok', false, 'error', 'date'); end if;
  end if;
  if v_time is not null and v_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return jsonb_build_object('ok', false, 'error', 'time'); end if;
  if v_bike is not null and length(v_bike) > 80 then return jsonb_build_object('ok', false, 'error', 'bike'); end if;
  if v_notes is not null and length(v_notes) > 600 then return jsonb_build_object('ok', false, 'error', 'notes'); end if;
  if v_lang !~ '^[a-z]{2}$' then v_lang := 'en'; end if;
  if coalesce(p->>'customer_id','') <> '' and coalesce(p->>'token','') <> '' and _cust_token_ok(p->>'customer_id', p->>'token') then
    v_cust := p->>'customer_id';
  end if;
  /* A code the workshop does not take is refused, never dropped in silence (20261110235400): one for rentals, one
     session or one kind of ride ('code'); one malformed, inactive, expired, used up or someone else's ('code_bad'). */
  if v_code is not null and exists (select 1 from promo_codes c where lower(c.code) = lower(v_code) and c.active
                                      and (c.applies_to is not null or c.session_id is not null or c.ride_kind is not null)) then
    return jsonb_build_object('ok', false, 'error', 'code');
  end if;
  if v_code is not null and (v_code !~ '^[A-Za-z0-9_-]{1,40}$' or not _promo_valid(v_code, v_cust)) then
    return jsonb_build_object('ok', false, 'error', 'code_bad');
  end if;

  perform pg_advisory_xact_lock(hashtext('workshop:' || v_phone));
  /* The same request again (a double tap, a lost answer) gets its reference back; another bike, time, lane,
     address, note or part list is a new job (bug hunt 2026-11-11, 20261111235300). */
  select id into v_prev from workshop_jobs
   where phone = v_phone and service = v_service and preferred_date is not distinct from v_date
     and preferred_time is not distinct from v_time and lane = v_lane and pickup_address is not distinct from v_addr
     and bike is not distinct from v_bike and notes is not distinct from v_notes and parts = v_parts
     and status = 'new' and created_at > now() - interval '10 minutes'
   order by id desc limit 1;
  if v_prev is not null then
    return jsonb_build_object('ok', true, 'id', v_prev, 'ref', 'W-' || lpad(v_prev::text, 4, '0'), 'repeat', true);
  end if;

  insert into workshop_jobs(customer_id, name, phone, email, service, service_label, price_quoted, parts, lane, pickup_address,
                            preferred_date, preferred_time, bike, notes, lang, promo_code, updated_by)
  values (v_cust, v_name, v_phone, v_email, v_service, v_label, v_price, v_parts, v_lane, v_addr,
          v_date, v_time, v_bike, v_notes, v_lang, v_code, 'website')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'ref', 'W-' || lpad(v_id::text, 4, '0'), 'code', v_code is not null);
end $function$;

-- checks: every changed function kept SECURITY DEFINER and its search_path and carries this file's change; the
-- grants and the trigger are as they were
do $chk$
declare f text;
begin
  foreach f in array array['public.staff_delete_session(text,text,text)',
                           'public.staff_cancel_session(text,text,text[],text,text)',
                           'public._vl_entry_guard()',
                           'public.customer_lockers(text,text)',
                           'public.rider_lookup(text,text,text)',
                           'public.volunteer_blood_role(text,text,text,text,text)',
                           'public.workshop_request(jsonb)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
                     and position('20261111235300' in p.prosrc) > 0) then
      raise exception '% lost SECURITY DEFINER or its search_path, or misses this file''s change', f;
    end if;
  end loop;
  if (select p.provolatile from pg_proc p where p.oid = 'public.customer_lockers(text,text)'::regprocedure) <> 's' then
    raise exception 'customer_lockers is no longer STABLE';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.workshop_request(jsonb)'::regprocedure
                   and 'search_path=public, extensions' = any (p.proconfig)) then
    raise exception 'workshop_request lost extensions from its search_path';
  end if;
  if has_function_privilege('anon', 'public.staff_delete_session(text,text,text)', 'execute')
     or has_function_privilege('anon', 'public.staff_cancel_session(text,text,text[],text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_delete_session(text,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_cancel_session(text,text,text[],text,text)', 'execute') then
    raise exception 'staff_delete_session / staff_cancel_session grants are wrong';
  end if;
  if not has_function_privilege('anon', 'public.customer_lockers(text,text)', 'execute')
     or not has_function_privilege('anon', 'public.rider_lookup(text,text,text)', 'execute')
     or not has_function_privilege('anon', 'public.volunteer_blood_role(text,text,text,text,text)', 'execute')
     or not has_function_privilege('anon', 'public.workshop_request(jsonb)', 'execute') then
    raise exception 'a customer door lost its EXECUTE grant';
  end if;
  if not exists (select 1 from pg_trigger t where t.tgfoid = 'public._vl_entry_guard()'::regprocedure
                   and t.tgrelid = 'public.queue_entries'::regclass and not t.tgisinternal) then
    raise exception 'queue_entries_vl_guard is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111235300', 'bh11_live_c')
on conflict (version) do nothing;

commit;
