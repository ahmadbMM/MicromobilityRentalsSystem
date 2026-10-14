-- ============================================================================
-- Bug hunt 2026-10-14, the public (customer, form and vendor) database surface.
--
-- 1. customer_booking_update: re-booking a booking the rider cancelled counted against the caps
--    the owner can no longer change: five per booker on an event, two on a community ride, three
--    on every other ride were typed in, while _group_ride_cap reads them from Settings > Business
--    (event_seat_max, group_ride_max, jcc_account_cap; 20261009160000). A National Day (snd96) ride
--    was held to the community two, where a new booking on it is held to the account cap. The
--    re-book now reads the same settings as a new booking.
-- 2. customer_booking_update: a rider whose tag had lapsed could re-book a cancelled booking on a
--    private (tag-gated) ride that a new booking refuses (SESSION_CLOSED in customer_create_booking).
--    The re-book now asks for the tag in force, as moving to another ride already did.
-- 3. _apply_default_pay: two bookings one house (or VIP) account sent at once for the same ride each
--    came out with a free row: customer_create_booking judged "one free row per ride" before either
--    was written. The second insert waits on the ride-cap lock (_group_ride_cap, _solo_ride_cap and
--    _run_entry_guard take it and fire first), so here it sees the first and pays instead.
-- 4. customer_claim_get: the waitlist offer page was told the ride's location before the reveal
--    time staff set (sessions.reveal_at), which list_sessions and the sessions policy keep back.
-- 5. customer_set_heard_from and customer_pwd_state compared the token by hand and so still
--    answered to the token of an account merged into another, which every other door refuses
--    (_cust_token_ok, 20261005210100).
-- 6. customer_fix_save: a number another account holds was refused only when typed exactly as
--    stored (+9665... against 9665... passed); customer_update_profile compares the digits. The
--    check-up now compares the digits too.
-- 7. vendor_profile_save: seats took any number (negative, 0, 10 million) and a non-number raised a
--    bare cast error; vendor_feedback_save took any turnout. The portal's form allows seats 1-2000
--    and a turnout 0-1000; the database now refuses the rest (BAD_INPUT).
--
-- Every change keeps the function's header (SECURITY DEFINER, search_path, volatility) and its grants.
-- customer_booking_update, customer_fix_save and vendor_profile_save are patched in place from their
-- live definitions by exact anchors (pg_temp._once), as 20261012180000 did; re-running is a no-op.
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


/* -- 1 + 2. re-booking a cancelled booking ------------------------------------------------- */
do $cbu$
declare d text;
begin
  d := pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure);
  if position('(20261014120000)' in d) > 0 then
    raise notice 'customer_booking_update already patched by 20261014120000; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$                        when coalesce(_at.ride_kind,'') = 'event' then 5 else 2 end) then return false; end if;$a$,
$b$                        when coalesce(_at.ride_kind,'') = 'snd96' then _biz_int('jcc_account_cap', 3)
                        when coalesce(_at.ride_kind,'') = 'event' then _biz_int('event_seat_max', 5)
                        else _biz_int('group_ride_max', 2) end) then return false; end if;   -- Settings > Business, as _group_ride_cap (20261014120000)$b$);
  d := pg_temp._once(d,
$a$      if _live >= 3 then return false; end if;$a$,
$b$      if _live >= _biz_int('jcc_account_cap', 3) then return false; end if;$b$);
  d := pg_temp._once(d,
$a$    if _at.id is null or coalesce(_at.status,'') not in ('open','full') or _at.session_date < _today then
      return false;
    end if;$a$,
$b$    if _at.id is null or coalesce(_at.status,'') not in ('open','full') or _at.session_date < _today then
      return false;
    end if;
    -- a private ride takes a rider back only while they hold its tag, as a new booking would (20261014120000)
    if _at.required_tag_id is not null and not exists (
         select 1 from customer_tags ct
          where ct.customer_id = p_id and ct.tag_id = _at.required_tag_id
            and _ctag_active(ct.starts_at, ct.expires_at)) then
      return false;
    end if;$b$);
  execute d;
end $cbu$;


/* -- 3. one free row per ride, also when two bookings race ---------------------------------- */
create or replace function public._apply_default_pay()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _dp text; _nm text; _house text;
begin
  -- customer_create_booking sends the holder's own free row already paid, having judged the one free
  -- row per ride before the insert. A second booking sent at the same moment judged it too; it has
  -- waited on the ride-cap lock (the cap triggers fire before this one) and now sees the first, so
  -- it pays (20261014120000).
  if new.customer_id is not null and coalesce(new.paid, false) and coalesce(new.price, 0) = 0
     and coalesce(auth.role(), '') in ('anon', 'authenticated') and not is_staff()
     and coalesce(new.status, '') not in ('cancelled', 'removed')
     and _house_taken(new.customer_id, new.session_id, new.id) then
    new.paid := false;
    new.price := null;
  end if;
  if new.customer_id is null or coalesce(new.paid, false)
     or coalesce(new.status, '') in ('cancelled', 'removed') then
    return new;
  end if;
  select c.default_pay, c.name into _dp, _nm from customers c where c.id = new.customer_id;
  if _is_vip(new.customer_id) then
    _house := 'all';                                   -- VIP: every type, whatever default_pay says
  elsif coalesce(_dp, '') like 'house%' then
    _house := case when _dp = 'house' then 'all' else substring(_dp from 7) end;
  else
    return new;
  end if;
  if lower(btrim(coalesce(new.name, ''))) = lower(btrim(coalesce(_nm, '')))
     and (_house = 'all' or coalesce(nullif(new.type_preference, ''), 'Any') = any(string_to_array(_house, ',')))
     -- The holder rides once: one free row in their own name per ride (20261005210000).
     and not _house_taken(new.customer_id, new.session_id, new.id) then
    new.paid := true;
    new.price := 0;
    new.promo_code := null;   -- a free row spends no code (20261005210000)
  end if;
  return new;
end $function$;
revoke execute on function public._apply_default_pay() from public, anon, authenticated;


/* -- 4. the waitlist offer keeps the reveal --------------------------------------------------- */
create or replace function public.customer_claim_get(p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare o waitlist_offers%rowtype; q queue_entries%rowtype; _s sessions%rowtype; st text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND'); end if;
  select * into o from waitlist_offers where token = p_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND'); end if;
  select * into q from queue_entries where id = o.booking_id;
  select * into _s from sessions where id = o.session_id;
  st := case when o.status = 'open' and o.expires_at <= now() then 'expired' else o.status end;
  return jsonb_build_object(
    'ok', true, 'status', st, 'expires_at', o.expires_at, 'now', now(),
    'first_name', split_part(btrim(coalesce(q.name, '')), ' ', 1),
    'booking_status', q.status, 'queue_num', q.queue_num,
    'session', jsonb_build_object('id', _s.id, 'date', _s.session_date, 'time', _rs_time(_s.bike_slots),
                                  'title', _s.title, 'ride_kind', _s.ride_kind, 'event_kind', _s.event_kind,
                                  -- unsaid until staff's reveal time, as list_sessions keeps it (20261014120000)
                                  'location', case when _s.reveal_at is not null and _s.reveal_at > now()
                                                   then null else _s.location end));
end $function$;
revoke execute on function public.customer_claim_get(text) from public;
grant  execute on function public.customer_claim_get(text) to anon, authenticated;


/* -- 5. a merged account's token opens nothing ------------------------------------------------ */
create or replace function public.customer_set_heard_from(p_id text, p_token text, p_value text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  p_value := nullif(btrim(coalesce(p_value, '')), '');
  if p_value is null or p_value not in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp','google','friend','invited','passed_by','event','hotel','school','work','community','other') then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'heard_from'; end if;
  -- the token as every other door checks it: a merged account's own opens nothing (20261014120000)
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  update customers set heard_from = p_value, updated_at = now()
   where customers.id = p_id;
  return found;
end $function$;
revoke execute on function public.customer_set_heard_from(text, text, text) from public;
grant  execute on function public.customer_set_heard_from(text, text, text) to anon, authenticated;

create or replace function public.customer_pwd_state(p_id text, p_token text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  -- merged_into: a merged account's own token opens nothing, as _cust_token_ok (20261014120000)
  select coalesce((select must_change_pwd from customers
                    where id = p_id and session_token = p_token and p_token is not null
                      and merged_into is null), false);
$function$;
revoke execute on function public.customer_pwd_state(text, text) from public;
grant  execute on function public.customer_pwd_state(text, text) to anon, authenticated;


/* -- 6. the check-up's phone: another account's number by its digits ------------------------- */
do $cfs$
declare d text;
begin
  d := pg_get_functiondef('public.customer_fix_save(text,text,jsonb)'::regprocedure);
  if position('(20261014120000)' in d) > 0 then
    raise notice 'customer_fix_save already patched by 20261014120000; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$        if v is distinct from c.phone and exists(select 1 from customers o where o.phone = v and o.id <> p_id) then$a$,
$b$        -- by the digits, as customer_update_profile compares them (20261014120000)
        if regexp_replace(v, '\D', '', 'g') is distinct from regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')
           and exists(select 1 from customers o where o.id <> p_id
                        and regexp_replace(coalesce(o.phone, ''), '\D', '', 'g') = regexp_replace(v, '\D', '', 'g')) then$b$);
  execute d;
end $cfs$;


/* -- 7. the vendor portal's numbers ----------------------------------------------------------- */
do $vps$
declare d text;
begin
  d := pg_get_functiondef('public.vendor_profile_save(bigint,text,jsonb)'::regprocedure);
  if position('(20261014120000)' in d) > 0 then
    raise notice 'vendor_profile_save already patched by 20261014120000; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  select * into o from vendor_venues where id = u.venue_id;$a$,
$b$  -- seats 1 to 2000, as the portal's form allows; empty clears it (20261014120000)
  if p_data ? 'seats' and coalesce(p_data ->> 'seats', '') <> ''
     and ((p_data ->> 'seats') !~ '^[0-9]{1,4}$' or (p_data ->> 'seats')::int not between 1 and 2000) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  select * into o from vendor_venues where id = u.venue_id;$b$);
  execute d;
end $vps$;

create or replace function public.vendor_feedback_save(p_uid bigint, p_token text, p_booking bigint, p_rating integer, p_turnout integer default null::integer, p_went_well text default ''::text, p_improve text default ''::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token); b vendor_bookings%rowtype; today date := _vendor_today(); f vendor_feedback%rowtype;
begin
  perform _vendor_role(u, array['owner','manager']);
  select * into b from vendor_bookings where id = p_booking and venue_id = u.venue_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if b.status <> 'confirmed' then raise exception 'NOT_CONFIRMED' using errcode = 'P0001'; end if;
  if today < b.day then raise exception 'TOO_EARLY' using errcode = 'P0001'; end if;
  if today > b.day + 14 then raise exception 'TOO_LATE' using errcode = 'P0001'; end if;
  if p_rating is null or p_rating not between 1 and 5 then raise exception 'BAD_RATING' using errcode = '22023'; end if;
  -- a turnout of 0 to 1000, or none, as the portal's form allows (20261014120000)
  if p_turnout is not null and p_turnout not between 0 and 1000 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  insert into vendor_feedback as x (booking_id, venue_id, day, rating, turnout, went_well, improve, submitted_by)
  values (b.id, b.venue_id, b.day, p_rating, p_turnout, left(coalesce(p_went_well, ''), 1000), left(coalesce(p_improve, ''), 1000), u.id)
  on conflict (booking_id) do update set rating = excluded.rating, turnout = excluded.turnout,
     went_well = excluded.went_well, improve = excluded.improve, submitted_by = excluded.submitted_by, updated_at = now()
  returning * into f;
  return to_jsonb(f) - 'submitted_by';
end $function$;
revoke execute on function public.vendor_feedback_save(bigint, text, bigint, integer, integer, text, text) from public;
grant  execute on function public.vendor_feedback_save(bigint, text, bigint, integer, integer, text, text) to anon, authenticated;


/* -- checks ------------------------------------------------------------------------------------ */
do $chk$
declare f text;
begin
  foreach f in array array['customer_booking_update','_apply_default_pay','customer_claim_get','customer_set_heard_from',
                           'customer_pwd_state','customer_fix_save','vendor_profile_save','vendor_feedback_save'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if position('(20261014120000)' in pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure)) = 0
     or position('(20261014120000)' in pg_get_functiondef('public.customer_fix_save(text,text,jsonb)'::regprocedure)) = 0
     or position('(20261014120000)' in pg_get_functiondef('public.vendor_profile_save(bigint,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'a 20261014120000 patch did not take';
  end if;
  if not has_function_privilege('anon', 'public.customer_booking_update(text,text,text,jsonb)', 'execute')
     or not has_function_privilege('anon', 'public.customer_fix_save(text,text,jsonb)', 'execute')
     or not has_function_privilege('anon', 'public.vendor_profile_save(bigint,text,jsonb)', 'execute')
     or not has_function_privilege('anon', 'public.customer_claim_get(text)', 'execute')
     or not has_function_privilege('anon', 'public.customer_set_heard_from(text,text,text)', 'execute')
     or not has_function_privilege('anon', 'public.customer_pwd_state(text,text)', 'execute')
     or not has_function_privilege('anon', 'public.vendor_feedback_save(bigint,text,bigint,integer,integer,text,text)', 'execute') then
    raise exception 'a client grant is missing';
  end if;
  if has_function_privilege('anon', 'public._apply_default_pay()', 'execute')
     or has_function_privilege('authenticated', 'public._apply_default_pay()', 'execute') then
    raise exception '_apply_default_pay is executable by a client';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261014120000', 'bh14_public')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';
