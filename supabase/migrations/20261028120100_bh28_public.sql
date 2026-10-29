-- ============================================================================
-- Bug hunt 2026-10-28, the customer-facing side of the database (group fx-db-a).
--
-- 1. queue_public: the no-PII view had no WHERE, and as a postgres-owned view it reads past the
--    queue_entries RLS, so the anon key paged through every booking ever made (price and paid flag,
--    and the rows of tag-only, men-only / women-only and unrevealed rides). It now carries only the
--    rides from two days back on; the app reads it from yesterday on (_pubCut), so no page changes.
--    Columns, owner and grants unchanged (tagged members still read their rides' counts from it).
-- 2. customer_create_booking: (a) a ride left 'open' after it ended earlier today still took new
--    riders (the check was the date alone); it now refuses one whose _session_window has ended, as
--    customer_claim_spot and rider_register do. (b) each rider's name was stored as sent (digits,
--    dashes, markup, empty); a name other than the account's own must now pass _name_chars_ok and
--    _name_parts_ok, as every other customer door requires (BAD_INPUT, detail 'name').
-- 3. customer_booking_update: the same ended-ride check for a move and for taking a cancelled place
--    back; a name in the patch that breaks the name rule is ignored (the app never sends one).
-- 4. customer_set_photo: any https host was taken, so a rider could make every staff screen that
--    shows them fetch a tracking pixel. The https link is now this project's photos bucket
--    (any <ref>.supabase.co, as staff_my_settings takes it, so staging works) or a Google picture
--    (lhN.googleusercontent.com, what Google sign-in brings); the data URL fallback is unchanged.
-- 5. customer_fix_save: its 'photo' answer took anything starting https:// (quotes, newlines,
--    megabytes); it now follows customer_set_photo's rule above.
-- 6. ambassador_mine: an ambassador was found by the last nine digits of the account's phone, which
--    the customer sets and nobody checks, so an account given an ambassador's number saw their code
--    (with the phone, what ambassador_redeem spends on), points and history. A phone match now finds
--    only an ambassador linked to no account, and such a match shows the points without the code,
--    the events or the redemptions; a linked ambassador (customer_id) sees everything as before.
-- 7. staff_my_settings, staff_set_own_email: checked only that a staff row existed, not that it was
--    enabled, so a disabled staffer's still-valid JWT (up to an hour) renamed them across the team
--    list or changed their sign-in email. Both now require disabled_at is null, as is_staff() does.
--
-- Each function is replaced from its live definition (header copied from pg_get_functiondef, the
-- live text checked by md5 before the fix); CREATE OR REPLACE keeps the grants. Idempotent.
-- Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- 1 queue_public ----------------------------------------------------------
-- No WHERE before: anon read every booking ever made, price and paid flag included. The app reads it
-- from yesterday on (_pubCut); two days back leaves a device whose clock is a day behind the same rows.
-- Same columns in the same order; CREATE OR REPLACE VIEW keeps the owner and the grants.
CREATE OR REPLACE VIEW public.queue_public AS
 SELECT id,
    session_id,
    session_day,
    session_date,
    queue_num,
    status,
    size,
    type_preference,
    paid,
    price,
    assigned_bike_id,
    walk_in,
    ride_duration
   FROM queue_entries
  WHERE session_date >= to_char((now() AT TIME ZONE 'Asia/Riyadh')::date - 2, 'YYYY-MM-DD');

-- 2 customer_create_booking -----------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_create_booking(p_id text, p_token text, p_entries jsonb)
 RETURNS TABLE(id text, queue_num integer, status text, waitlist_num integer, price numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  it jsonb; cust customers%rowtype; s sessions%rowtype; _i int;
  _appr boolean; _house text; _house_first boolean := false; _paid boolean;
  _sid text; _status text; _day text; _wv text; _eid text; _gid text; _type text; _size text; _h int;
  _reg text; _ph text; _em text; _code text; _rc text; _pc promo_codes%rowtype; _base numeric := 0;
  _ids text[] := '{}'; _petro boolean; _nm text; _ended boolean;
begin
  if not _cust_token_ok(p_id, p_token) then
    raise exception 'STALE_SESSION' using errcode = 'P0001';
  end if;
  select * into cust from customers where customers.id = p_id;
  if not found then
    raise exception 'STALE_SESSION' using errcode = 'P0001';
  end if;
  if cardinality(coalesce(_customer_asks(p_id), '{}'::text[])) > 0 then
    raise exception 'FIX_FIRST' using errcode = 'P0001';
  end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) = 0 or jsonb_array_length(p_entries) > 10 then
    return;
  end if;
  _sid := p_entries->0->>'session_id';
  select * into s from sessions where sessions.id = _sid and coalesce(sessions.status,'') in ('open','full')
     and coalesce(sessions.session_date, '9999-12-31') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  if not found then
    raise exception 'SESSION_CLOSED' using errcode = 'P0001';
  end if;
  -- A ride that ended earlier today takes no new rider, as customer_claim_spot and rider_register
  -- refuse one; a ride under way still does. A time the window cannot read closes nothing (bug hunt 2026-10-28).
  begin _ended := (select w.ends_at from _session_window(s) w) <= now();
  exception when others then _ended := false; end;
  if coalesce(_ended, false) then
    raise exception 'SESSION_CLOSED' using errcode = 'P0001';
  end if;
  if s.required_tag_id is not null and not exists (
       select 1 from customer_tags ct
        where ct.customer_id = p_id and ct.tag_id = s.required_tag_id
          and _ctag_active(ct.starts_at, ct.expires_at)) then
    raise exception 'SESSION_CLOSED' using errcode = 'P0001';
  end if;
  _appr := coalesce(s.needs_approval,false);
  -- Only a full a person set (Mark Full) waitlists a new booker on sight; the fill rule's own
  -- full is left to _capacity_guard, which counts the places (20261005210000).
  _status := case when coalesce(s.status,'') = 'full' and (_appr or not coalesce(s.auto_full, false))
                  then 'waitlist' else 'waiting' end;
  _petro := coalesce(s.event_kind,'') = 'community' and coalesce(s.ride_kind,'') = 'petromin';
  _day := case when s.day in ('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday') then s.day
               else to_char(s.session_date::date, 'FMDay') end;
  if _is_vip(p_id) then
    _house := 'all';                                   -- VIP (20260929090000): every type
  elsif coalesce(cust.default_pay,'') like 'house%' then
    _house := case when cust.default_pay = 'house' then 'all'
                   else substring(cust.default_pay from 7) end;
  end if;
  _i := 0;
  for it in select * from jsonb_array_elements(p_entries) loop
    if jsonb_typeof(it) <> 'object' or it->>'session_id' is distinct from _sid then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'session_id';   -- one session per call
    end if;
    _eid := nullif(it->>'id','');
    if _eid is not null and (_eid !~ '^[A-Za-z0-9_-]{1,64}$' or _eid = any(_ids)) then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'id';
    end if;
    if _eid is not null then _ids := _ids || _eid; end if;
    _gid := nullif(it->>'group_id','');
    if _gid is not null and _gid !~ '^[A-Za-z0-9_-]{1,64}$' then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'group_id';
    end if;
    _type := coalesce(nullif(it->>'type_preference',''), 'Any');
    if not _type_ok(_type) then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'type_preference';
    end if;
    if coalesce(it->>'waiver_version', '') !~ '^[A-Za-z0-9._-]{1,40}$' then
      raise exception 'WAIVER_REQUIRED' using errcode = 'P0001';   -- every booking needs an agreed waiver (20261003210000)
    end if;
    if _waiver_outdated(it->>'waiver_version') then
      raise exception 'WAIVER_OUTDATED' using errcode = 'P0001';   -- a superseded waiver (20261005210000)
    end if;
    if _type = 'Any' then   -- Any is staff's to give (20261002160000)
      raise exception 'PICK_TYPE' using errcode = '22023', detail = 'type_preference';
    end if;
    -- A rider's name is letters and spaces, as every other customer door takes it; the account's own
    -- name passes as it stands (bug hunt 2026-10-28).
    _nm := left(btrim(regexp_replace(coalesce(it->>'name',''), '\s+', ' ', 'g')), 60);
    if lower(_nm) <> lower(left(btrim(regexp_replace(coalesce(cust.name,''), '\s+', ' ', 'g')), 60))
       and (_nm = '' or not _name_chars_ok(_nm) or not _name_parts_ok(_nm)) then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'name';
    end if;
    if _i = 0 and _house is not null
       and lower(btrim(coalesce(it->>'name',''))) = lower(btrim(coalesce(cust.name,'')))
       and (_house = 'all' or _type = any(string_to_array(_house, ',')))
       and not _house_taken(p_id, _sid, null) then   -- one free row per ride (20261005210000)
      _house_first := true;
    end if;
    if _code is null and nullif(it->>'promo_code','') is not null then _code := it->>'promo_code'; end if;
    _i := _i + 1;
  end loop;
  if _code is not null then
    select * into _pc from promo_codes c where lower(c.code) = lower(_code) order by c.id limit 1;
    if _pc.id is not null and _pc.kind = 'flat' and _pc.applies_to is null then
      _i := 0;
      for it in select * from jsonb_array_elements(p_entries) loop
        if not (_i = 0 and _house_first) and lower(coalesce(it->>'promo_code','')) = lower(_code) then
          _base := _base + coalesce(_fare_now(_sid, coalesce(nullif(it->>'id',''), '-'),
                                              coalesce(nullif(it->>'type_preference',''), 'Any')), 0);
        end if;
        _i := _i + 1;
      end loop;
      perform set_config('mm.promo_code', lower(_code), true);
      perform set_config('mm.promo_base', _base::text, true);
    end if;
  end if;
  _i := 0;
  for it in select * from jsonb_array_elements(p_entries) loop
    _paid := (_i = 0 and _house_first);
    _type := coalesce(nullif(it->>'type_preference',''), 'Any');
    _size := coalesce(it->>'size', '');
    if _size not in ('','XS','S','M','L','XL') then _size := ''; end if;
    _h := case when (it->>'height') ~ '^[0-9]{3}$' and (it->>'height')::int between 100 and 250
               then (it->>'height')::int end;
    -- An approval ride's roster runs by the server's clock, not the page's (20261005210000).
    _reg := case when _appr then null else it->>'registered_at' end;
    begin
      if _reg is null or _reg !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
         or _reg::timestamptz not between now() - interval '7 days' and now() + interval '10 minutes' then
        _reg := null;
      end if;
    exception when others then _reg := null;
    end;
    _reg := coalesce(_reg, to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    _ph := nullif(btrim(coalesce(it->>'phone','')), '');
    if _ph is null or _ph !~ '^\+?[0-9]{6,15}$' then _ph := coalesce(cust.phone, ''); end if;
    _em := nullif(btrim(coalesce(it->>'email','')), '');
    if _em is null or _em !~ '^[^[:space:]@<>"''()]+@[^[:space:]@<>"''()]+\.[^[:space:]@<>"''()]+$' then
      _em := coalesce(cust.email, '');
    end if;
    _wv := left(nullif(it->>'waiver_version',''), 40);
    if _wv is not null and _wv !~ '^[A-Za-z0-9._-]{1,40}$' then _wv := null; end if;
    _rc := nullif(btrim(coalesce(it->>'promo_code','')), '');
    if _rc is not null and _rc !~ '^[A-Za-z0-9_-]{1,40}$' then _rc := null; end if;
    if _paid then _rc := null; end if;   -- the free first rider spends no code (20261005210000)
    return query
    insert into queue_entries (
      id, name, size, height, type_preference, session_id, session_day, session_date,
      queue_num, registered_at, phone, email, status, paid, price, promo_code,
      customer_id, walk_in, group_id, approval, assigned_bike_id,
      waiver_at, waiver_version, ride_group, run_km,  -- Run for Her's distance (20261005230000)
      data_share_at,                                  -- and the runner's agreement to share (20261006180000)
      vl                                              -- Victory Lap and the Arena race: race, division, team (20261017210000, 20261028200000)
    ) values (
      coalesce(nullif(it->>'id',''), encode(gen_random_bytes(12),'hex')),
      left(btrim(regexp_replace(coalesce(it->>'name',''), '\s+', ' ', 'g')), 60),
      _size,
      _h,
      _type,
      _sid,
      _day,
      s.session_date,
      0,                                  -- queue_entries_assign_qnum issues the number
      _reg,
      left(_ph, 30),
      left(_em, 120),
      case when _type = 'Own' and not _petro then 'waiting' else _status end,   -- an own bike takes no place (20261005210000)
      _paid,
      case when _paid then 0 end,         -- _enforce_booking_price decides every other price
      _rc,
      p_id,
      false,
      nullif(it->>'group_id',''),
      case when _appr then 'pending' else null end,
      null,
      case when _wv is not null
           then to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') else null end,
      _wv,
      case when it->>'ride_group' in ('beg','int') then it->>'ride_group' end,
      case when it->>'run_km' in ('3','5') then (it->>'run_km')::smallint end,
      case when it->>'share_ok' = 'true' and coalesce(s.ride_kind, '') in ('runher', 'vlap', 'arena')
           then to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
      case when coalesce(s.ride_kind, '') in ('vlap', 'arena') and jsonb_typeof(it->'vl') = 'object'
           then it->'vl' end
    )
    returning queue_entries.id, queue_entries.queue_num, queue_entries.status,
              queue_entries.waitlist_num, queue_entries.price;
    _i := _i + 1;
  end loop;
  perform set_config('mm.promo_code', '', true);
  perform set_config('mm.promo_base', '', true);
end $function$;

-- 3 customer_booking_update -----------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_booking_update(p_id text, p_token text, p_entry_id text, p_patch jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  q queue_entries%rowtype; _to sessions%rowtype; _at sessions%rowtype; _p jsonb; _today text;
  _want text; _new_status text; _move boolean := false; _qnum int; _live int;
  _type text; _size text; _h int; _name text; _addons text; _set_addons boolean := false;
  _code text; _unpay boolean := false; _rb int; _re int; _cancelling boolean;
  _cu customers%rowtype; _dp text; _house text; _reapprove boolean := false; _to_own boolean := false;
  _rt text[]; _rd jsonb; _ended boolean;
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  _p := coalesce(p_patch, '{}'::jsonb);
  if jsonb_typeof(_p) <> 'object' then return false; end if;
  select * into q from queue_entries x where x.id = p_entry_id and x.customer_id = p_id for update;
  if not found then return false; end if;
  select * into _cu from customers where customers.id = p_id;
  _today := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  _want := nullif(_p->>'status', '');
  if _want = q.status then _want := null; end if;
  if _want is not null and _want not in ('cancelled','waiting','waitlist') then return false; end if;
  if _p ? 'session_id' and (_p->>'session_id') is distinct from q.session_id then
    if q.status not in ('waiting','waitlist') or _want = 'cancelled' then return false; end if;
    select * into _at from sessions where sessions.id = q.session_id;
    select * into _to from sessions where sessions.id = _p->>'session_id';
    -- a ride that ended earlier today takes no one, as a new booking (bug hunt 2026-10-28); a time the
    -- window cannot read closes nothing
    begin _ended := (select w.ends_at from _session_window(_to) w) <= now();
    exception when others then _ended := false; end;
    if _to.id is null
       or coalesce(_to.status,'') not in ('open','full')
       or coalesce(_to.needs_approval,false) or coalesce(_at.needs_approval,false)
       or coalesce(_to.ride_kind,'') = 'snd96' or coalesce(_at.ride_kind,'') = 'snd96'
       or _to.session_date < _today or coalesce(_ended, false)
       or (_to.required_tag_id is not null and not exists (
             select 1 from customer_tags ct
              where ct.customer_id = p_id and ct.tag_id = _to.required_tag_id
                and _ctag_active(ct.starts_at, ct.expires_at))) then
      return false;
    end if;
    _move := true;
    _new_status := case when coalesce(_to.status,'') = 'full' or _want = 'waitlist' then 'waitlist' else 'waiting' end;
    update sessions
       set last_qnum = greatest(coalesce(last_qnum, 0),
                                coalesce((select max(x.queue_num) from queue_entries x where x.session_id = _to.id), 0)) + 1
     where sessions.id = _to.id
     returning last_qnum into _qnum;
  elsif _want = 'cancelled' then
    if q.status not in ('waiting','waitlist') then return false; end if;
    _new_status := 'cancelled';
  elsif _want in ('waiting','waitlist') then
    if q.status <> 'cancelled' or coalesce(q.cancelled_by,'') <> 'customer' then return false; end if;
    select * into _at from sessions where sessions.id = q.session_id;
    begin _ended := (select w.ends_at from _session_window(_at) w) <= now();   -- (bug hunt 2026-10-28)
    exception when others then _ended := false; end;
    if _at.id is null or coalesce(_at.status,'') not in ('open','full') or _at.session_date < _today
       or coalesce(_ended, false) then   -- ended earlier today, as a new booking
      return false;
    end if;
    -- a private ride takes a rider back only while they hold its tag, as a new booking would (20261014120000)
    if _at.required_tag_id is not null and not exists (
         select 1 from customer_tags ct
          where ct.customer_id = p_id and ct.tag_id = _at.required_tag_id
            and _ctag_active(ct.starts_at, ct.expires_at)) then
      return false;
    end if;
    if coalesce(_at.event_kind,'') = 'community' then
      if not coalesce(_at.open_to_all,false)
         and not (coalesce(_at.ride_kind,'') = 'petromin' and _petromin_holder(p_id))   -- (20261012180000)
         and not (coalesce(_at.ride_kind,'') = 'vlap' and _vlap_holder(p_id))           -- (20261017210000)
         and not exists (
           select 1 from customer_tags ct join tags tg on tg.id = ct.tag_id
            where ct.customer_id = p_id and lower(tg.slug) = 'saturday'
              and _ctag_active(ct.starts_at, ct.expires_at)) then
        return false;
      end if;
      select count(*) into _live from queue_entries x
       where x.session_id = q.session_id and x.customer_id = p_id and x.id <> q.id
         and coalesce(x.status,'') not in ('cancelled','removed','noshow');
      -- the cap _group_ride_cap applies: an event takes five per booker (20261004100000)
      if _live >= (case when coalesce(_at.needs_approval,false) then 1
                        when coalesce(_at.ride_kind,'') = 'snd96' then _biz_int('jcc_account_cap', 3)
                        when coalesce(_at.ride_kind,'') = 'event' then _biz_int('event_seat_max', 5)
                        else _biz_int('group_ride_max', 2) end) then return false; end if;   -- Settings > Business, as _group_ride_cap (20261014120000)
    else
      -- Every other ride: three per account, as _group_ride_cap counts them (20261005210000).
      select count(*) into _live from queue_entries x
       where x.session_id = q.session_id and x.customer_id = p_id and x.id <> q.id
         and coalesce(x.status,'') in ('waiting','active','waitlist');
      if _live >= _biz_int('jcc_account_cap', 3) then return false; end if;
    end if;
    _new_status := case when _want = 'waiting' and _session_has_room(q.session_id, q.type_preference, q.id)
                        then 'waiting' else 'waitlist' end;
    _reapprove := coalesce(_at.needs_approval, false);
    if exists (select 1 from queue_entries x
                where x.session_id = q.session_id and x.queue_num = q.queue_num and x.id <> q.id
                  and x.status not in ('cancelled','removed','noshow')) then
      update sessions
         set last_qnum = greatest(coalesce(last_qnum, 0),
                                  coalesce((select max(x.queue_num) from queue_entries x where x.session_id = q.session_id), 0)) + 1
       where sessions.id = q.session_id
       returning last_qnum into _qnum;
    end if;
  end if;
  if q.status in ('waiting','waitlist') and coalesce(_new_status,'') <> 'cancelled' then
    if _p ? 'type_preference' and _type_ok(_p->>'type_preference') and (_p->>'type_preference') <> 'Any' then _type := _p->>'type_preference'; end if;
    if _p ? 'size' and coalesce(_p->>'size','') in ('','XS','S','M','L','XL') then _size := coalesce(_p->>'size',''); end if;
    if (_p->>'height') ~ '^[0-9]{3}$' and (_p->>'height')::int between 100 and 250 then _h := (_p->>'height')::int; end if;
    if _p ? 'name' then
      _name := nullif(left(btrim(regexp_replace(coalesce(_p->>'name',''), '\s+', ' ', 'g')), 60), '');
      -- letters and spaces only, as every other customer door takes a name: else the name stays (bug hunt 2026-10-28)
      if _name is not null and (not _name_chars_ok(_name) or not _name_parts_ok(_name)) then _name := null; end if;
    end if;
    if _p ? 'promo_code' then
      _code := nullif(btrim(coalesce(_p->>'promo_code','')), '');
      -- A paid row takes no new code: there is nothing left to discount (20261005210000).
      if _code is null or _code !~ '^[A-Za-z0-9_-]{1,40}$' or coalesce(q.promo_code,'') <> '' or q.paid then _code := null; end if;
    end if;
    if q.paid and coalesce(q.price,0) = 0 and coalesce(q.promo_code,'') = '' then
      if _type is not null and _type is distinct from q.type_preference then
        _dp := coalesce(_cu.default_pay, '');
        _house := case when _is_vip(p_id) then 'all'   -- a VIP rides free on every type (20261005210000)
                       when _dp = 'house' then 'all' when _dp like 'house:%' then substring(_dp from 7) end;
        if _house is null or not (_house = 'all' or _type = any(string_to_array(_house, ','))) then _unpay := true; end if;
      end if;
      if _name is not null and lower(btrim(coalesce(q.name,''))) = lower(btrim(coalesce(_cu.name,'')))
         and lower(_name) <> lower(btrim(coalesce(_cu.name,''))) then
        _unpay := true;
      end if;
    elsif q.paid and _type is not null and _type is distinct from q.type_preference
          and coalesce(_fare_now(q.session_id, q.id, _type), 0) > coalesce(q.price, 0) then
      return false;
    end if;
  end if;
  if _p ? 'addons' and q.status in ('waiting','waitlist','active') and coalesce(_new_status,'') <> 'cancelled' then
    _addons := nullif(_p->>'addons','');
    _set_addons := _addons is null or _addons_ok(_addons);
    if _set_addons and _addons is not null and (
         jsonb_array_length(_addons::jsonb) > 20
         or exists (select 1 from jsonb_each_text(_addon_map(_addons)) m where m.value::int > 20)) then
      _set_addons := false;
    end if;
    if _set_addons and q.status = 'active' and exists (
         select 1 from jsonb_each_text(_addon_map(q.addons)) o
          where coalesce((_addon_map(_addons)->>o.key)::int, 0) < o.value::int) then
      _set_addons := false;
    end if;
  end if;
  -- A ride still ahead is not rated (20261004100000).
  if coalesce(q.session_date, '') > _today then
    _p := _p - 'rating_bike' - 'rating_exp' - 'rating_tags' - 'rating_detail' - 'feedback';
  end if;
  if _p ? 'rating_bike' then
    _rb := case when (_p->>'rating_bike') ~ '^[0-9]{1,2}$' and (_p->>'rating_bike')::int between 1 and 10 then (_p->>'rating_bike')::int end;
  end if;
  if _p ? 'rating_exp' then
    _re := case when (_p->>'rating_exp') ~ '^[0-9]{1,2}$' and (_p->>'rating_exp')::int between 1 and 10 then (_p->>'rating_exp')::int end;
  end if;
  if _p ? 'rating_tags' and jsonb_typeof(_p->'rating_tags') = 'array' then
    select array_agg(x order by o) into _rt
      from (select x, o from jsonb_array_elements_text(_p->'rating_tags') with ordinality as e(x, o)
             where x ~ '^[a-z_]{1,24}$' limit 8) s;
  end if;
  if _p ? 'rating_detail' and jsonb_typeof(_p->'rating_detail') = 'object' then
    _rd := jsonb_strip_nulls(jsonb_build_object(
      'form', case when (_p->'rating_detail'->>'form') in ('rental','social') then _p->'rating_detail'->>'form' end,
      's', (select coalesce(jsonb_object_agg(k, case when v ~ '^[0-9]{1,2}$' then v::int end), '{}'::jsonb)
              from (select k, v from jsonb_each_text(case when jsonb_typeof(_p->'rating_detail'->'s') = 'object'
                                                          then _p->'rating_detail'->'s' else '{}'::jsonb end) e(k, v)
                     where k ~ '^[a-z_]{1,24}$'
                       and (case when v ~ '^[0-9]{1,2}$' then v::int end) between 1 and 10
                     limit 20) s1),
      'why', (select coalesce(jsonb_object_agg(k, left(btrim(v), 300)), '{}'::jsonb)
                from (select k, v from jsonb_each_text(case when jsonb_typeof(_p->'rating_detail'->'why') = 'object'
                                                            then _p->'rating_detail'->'why' else '{}'::jsonb end) e(k, v)
                       where k ~ '^[a-z_]{1,24}$' and btrim(v) <> ''
                       limit 20) w1),
      'skip_bf', case when (_p->'rating_detail'->>'skip_bf') = 'true' then true end));
  end if;
  -- A paid booking keeps what it paid: it moves only to a ride with the same fare for its type.
  -- A free row the account's house rule (or VIP) still covers moves as before (20261005210000).
  if _move and q.paid and not _unpay
     and coalesce(_fare_now(_to.id, q.id, coalesce(_type, q.type_preference)), 0)
         <> coalesce(_fare_now(q.session_id, q.id, coalesce(_type, q.type_preference)), 0)
     and not (coalesce(q.price, 0) = 0 and coalesce(q.promo_code, '') = ''
              and (_is_vip(p_id) or coalesce(_cu.default_pay, '') = 'house'
                   or (coalesce(_cu.default_pay, '') like 'house:%'
                       and coalesce(_type, q.type_preference) = any(string_to_array(substring(_cu.default_pay from 7), ','))))) then
    raise exception 'PAID_MOVE' using errcode = 'P0001';
  end if;
  _cancelling := coalesce(_p->>'status','') = 'cancelled'
                 and (_new_status = 'cancelled' or (q.status = 'cancelled' and coalesce(q.cancelled_by,'') = 'customer'));
  if q.status = 'waiting' and not _move and coalesce(_new_status, 'waiting') = 'waiting'
     and coalesce(q.type_preference, '') = 'Own' and _type is not null and _type <> 'Own'
     and not exists (select 1 from sessions s where s.id = q.session_id
                      and coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'petromin')
     and not _session_has_room(q.session_id, _type, q.id) then
    return false;
  end if;
  _to_own := q.status = 'waiting' and not _move and coalesce(_new_status, 'waiting') = 'waiting'
             and coalesce(q.type_preference, '') <> 'Own' and _type = 'Own';
  update queue_entries x set
    type_preference  = coalesce(_type, x.type_preference),
    size             = coalesce(_size, x.size),
    height           = coalesce(_h, x.height),
    name             = coalesce(_name, x.name),
    paid             = case when _unpay then false else x.paid end,
    status           = coalesce(_new_status, x.status),
    approval         = case when _reapprove then 'pending' else x.approval end,
    queue_num        = coalesce(_qnum, x.queue_num),
    promo_code       = coalesce(_code, x.promo_code),
    session_id       = case when _move then _to.id else x.session_id end,
    session_day      = case when _move then _to.day else x.session_day end,
    session_date     = case when _move then _to.session_date else x.session_date end,
    waitlist_num     = case when _move then null else x.waitlist_num end,
    rating_bike      = case when _p ? 'rating_bike' then _rb else x.rating_bike end,
    rating_exp       = case when _p ? 'rating_exp'  then _re else x.rating_exp end,
    rating_tags      = case when _p ? 'rating_tags' then _rt else x.rating_tags end,
    rating_detail    = case when _p ? 'rating_detail' then _rd else x.rating_detail end,
    feedback         = case when _p ? 'feedback'    then left(nullif(_p->>'feedback',''), 1000) else x.feedback end,
    addons           = case when _set_addons then _addons else x.addons end,
    assigned_bike_id = case when _new_status = 'cancelled' then null else x.assigned_bike_id end,
    cancelled_by     = case when _new_status = 'cancelled' then 'customer'
                            when x.status = 'cancelled' and _new_status in ('waiting','waitlist') then null
                            else x.cancelled_by end,
    cancel_reason    = case
                         when q.status = 'cancelled' and coalesce(q.cancelled_by,'') <> 'customer' then x.cancel_reason   -- staff's stays (20261005210000)
                         when _cancelling then case when (_p->>'cancel_reason') ~ '^[a-z_]{1,24}$' then _p->>'cancel_reason' else null end
                         when _p ? 'status' then null
                         else x.cancel_reason end,
    cancel_note      = case
                         when q.status = 'cancelled' and coalesce(q.cancelled_by,'') <> 'customer' then x.cancel_note
                         when _cancelling then left(nullif(btrim(coalesce(_p->>'cancel_note','')),''), 300)
                         when _p ? 'status' then null
                         else x.cancel_note end
  where x.id = q.id;
  if (q.status = 'waiting' and (_new_status = 'cancelled' or _move)) or _to_own then
    perform _promote_next_waitlist(q.session_id);
  end if;
  return true;
end $function$;

-- 4 customer_set_photo ----------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_set_photo(p_id text, p_token text, p_photo text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not _cust_token_ok(p_id,p_token) then return false; end if;
  -- A photo is a Storage (or provider) https link, or the small data URL the app falls back to.
  -- Anything else - a script URL, markup, a multi-megabyte blob - is refused. The https link is this
  -- project's photos bucket or the Google picture a sign-in brings: a link to any other host had every
  -- staff screen that shows the rider fetch it (bug hunt 2026-10-28).
  if p_photo is not null
     and not ((length(p_photo) <= 2000 and p_photo ~ '^https://[^[:space:]"''<>`\\]+$'
               and p_photo ~ '^https://([a-z0-9]+\.supabase\.co/storage/v1/object/public/photos/|lh[0-9]+\.googleusercontent\.com/)')
              or (length(p_photo) <= 700000 and p_photo ~ '^data:image/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$')) then
    return false;
  end if;
  update customers set photo=p_photo where id=p_id;
  return true;
end $function$;

-- 5 customer_fix_save -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.customer_fix_save(p_id text, p_token text, p_values jsonb)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  c      customers%rowtype;
  n      customers%rowtype;
  stored text[];
  flags  text[];
  done   text[] := '{}';
  none   text[] := '{}';
  k text;
  v text;
  rule text;
  em jsonb;
  em_name text;
  em_ph text;
  em_rel text;
  own text;
begin
  if not _cust_token_ok(p_id,p_token) then return null; end if;
  select * into c from customers where customers.id = p_id for update;
  if not found then return null; end if;
  stored := coalesce(c.fix_fields,'{}'::text[]);
  flags := _customer_asks(p_id);
  if p_values is null or jsonb_typeof(p_values) <> 'object' then return flags; end if;

  if 'country' = any(flags) or 'city' = any(flags) then
    v := nullif(btrim(coalesce(p_values->>'country','')),'');
    if v is not null then
      update customers set country = left(v,80),
        city = left(nullif(btrim(coalesce(p_values->>'city','')),''),120)
      where id = p_id;
      done := done || array['country','city'];
    end if;
  end if;

  -- "I don't have one" (2026-10-06): an optional field staff flagged is answered by clearing it.
  if jsonb_typeof(p_values->'none') = 'array' then
    none := array(select jsonb_array_elements_text(p_values->'none'));
    foreach k in array none loop
      if not (k = any(flags)) or k = any(done) then continue; end if;
      case k
        when 'profession' then update customers set profession = null where id = p_id;
        when 'workplace' then update customers set workplace = null where id = p_id;
        when 'instagram', 'x', 'tiktok', 'linkedin' then
          -- a community member's Instagram is required: never cleared here (20261009235000)
          if k = 'instagram' and exists (select 1 from customer_tags ct
                                          where ct.customer_id = p_id and ct.tag_id = 'tag_saturday'
                                            and _ctag_active(ct.starts_at, ct.expires_at)) then
            continue;
          end if;
          update customers set socials = nullif(coalesce(socials,'{}'::jsonb) - k, '{}'::jsonb) where id = p_id;
        when 'emergency' then continue;  -- the first contact is required: never cleared here (20261007235800)
        when 'emergency2' then  -- the second emergency contact (20261007150000)
          update customers set emergency2_name = null, emergency2_phone = null, emergency2_relation = null where id = p_id;
        else continue;
      end case;
      done := done || k;
    end loop;
  end if;

  foreach k in array flags loop
    if k = any(done) then continue; end if;
    -- The emergency contact is one answer of three parts, under customer_set_emergency's rules.
    if k = 'emergency' then
      em := p_values->'emergency';
      if em is null or jsonb_typeof(em) <> 'object' then continue; end if;
      em_name := nullif(regexp_replace(btrim(coalesce(em->>'name','')), '\s+', ' ', 'g'), '');
      em_ph := nullif(regexp_replace(coalesce(em->>'phone',''), '[^0-9+]', '', 'g'), '');
      em_rel := nullif(lower(btrim(coalesce(em->>'relation',''))), '');
      if em_name is null or char_length(em_name) < 2 or char_length(em_name) > 80
         or not _name_chars_ok(em_name) or not _name_parts_ok(em_name) then continue; end if;
      if em_ph is null or em_ph !~ '^\+?[0-9]{8,15}$' then continue; end if;
      if em_rel is null or em_rel not in ('spouse','parent','sibling','child','relative','friend','colleague','other') then continue; end if;
      own := regexp_replace(coalesce(c.phone,''), '\D', '', 'g');
      if own <> '' and right(regexp_replace(em_ph, '\D', '', 'g'), 9) = right(own, 9) then continue; end if;
      -- nor the second contact's number, while that one is not asked too; when it is, the pair is judged
      -- after this loop, where the second contact is answered (20261007150000)
      if not ('emergency2' = any(flags)) and coalesce(c.emergency2_phone,'') <> ''
         and right(regexp_replace(em_ph, '\D', '', 'g'), 9) = right(regexp_replace(c.emergency2_phone, '\D', '', 'g'), 9) then
        continue;
      end if;
      update customers set emergency_name = em_name, emergency_phone = em_ph, emergency_relation = em_rel where id = p_id;
      done := done || k;
      continue;
    end if;
    -- WhatsApp (20261007200000): {same: true} - the mobile - or {same: false, phone}. A number that is
    -- the mobile's own is "same"; "same" needs a mobile on the account.
    if k = 'whatsapp' then
      em := p_values->'whatsapp';
      if em is null or jsonb_typeof(em) <> 'object' or jsonb_typeof(em->'same') <> 'boolean' then continue; end if;
      own := regexp_replace(coalesce(c.phone,''), '\D', '', 'g');
      em_ph := nullif(regexp_replace(coalesce(em->>'phone',''), '[^0-9+]', '', 'g'), '');
      if (em->>'same')::boolean or (em_ph is not null and own <> ''
           and right(regexp_replace(em_ph, '\D', '', 'g'), 9) = right(own, 9)) then
        if own = '' then continue; end if;
        update customers set whatsapp_same = true, whatsapp = null where id = p_id;
      else
        if em_ph is null or em_ph !~ '^\+?[0-9]{8,15}$' then continue; end if;
        update customers set whatsapp_same = false, whatsapp = em_ph where id = p_id;
      end if;
      done := done || k;
      continue;
    end if;
    if not (p_values ? k) then continue; end if;
    if k = 'password' then
      v := p_values->>'password';
      if char_length(coalesce(v,'')) < 8 or v !~ '[A-Z]' or v !~ '[0-9]' then continue; end if;
      update customers set password_hash = crypt(v, gen_salt('bf')) where id = p_id;
      -- An account without a password is reached only through its Google or Apple sign-in, so
      -- this password is the owner's: customer_oauth_login keeps it (20260930160000).
      if coalesce(c.password_hash,'') like 'oauth:%' then
        insert into customer_owner_pwd (customer_id, pwd_hash)
        select x.id, x.password_hash from customers x where x.id = p_id
        on conflict (customer_id) do update set pwd_hash = excluded.pwd_hash, set_at = now();
      end if;
      done := done || k;
      continue;
    end if;
    v := nullif(btrim(coalesce(p_values->>k,'')),'');
    if v is null then continue; end if;
    case k
      when 'name' then
        if char_length(v) < 2 then continue; end if;
        if not _name_chars_ok(v) then continue; end if;
        update customers set name = left(v,120) where id = p_id;
      when 'email' then
        v := lower(v);
        if v !~ '^[^[:space:]@<>"''()]+@[^[:space:]@<>"''()]+\.[^[:space:]@<>"''()]+$' then continue; end if;
        if v like '%@privaterelay.appleid.com' then continue; end if;
        if exists(select 1 from customers o where o.id <> p_id
                    and (lower(btrim(o.email)) = v or lower(btrim(o.apple_email)) = v)) then
          raise exception 'email_taken' using errcode = '23505';
        end if;
        update customers set email = v where id = p_id;
      when 'phone' then
        if v !~ '^\+?[0-9]{8,15}$' then continue; end if;
        -- The account's own number is never taken, though staff put it on another account too
        -- by the digits, as customer_update_profile compares them (20261014120000)
        if regexp_replace(v, '\D', '', 'g') is distinct from regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')
           and exists(select 1 from customers o where o.id <> p_id
                        and regexp_replace(coalesce(o.phone, ''), '\D', '', 'g') = regexp_replace(v, '\D', '', 'g')) then
          raise exception 'phone_taken' using errcode = '23505';
        end if;
        update customers set phone = v where id = p_id;
      when 'birth_date' then
        -- a real date up to today, as customer_set_birth_nat takes it (20261007120000)
        if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or not _ymd_ok(v) then continue; end if;
        update customers set birth_date = v where id = p_id;
      when 'gender' then
        if v not in ('male','female') then continue; end if;
        update customers set gender = v where id = p_id;
      when 'nationality' then update customers set nationality = left(v,80) where id = p_id;
      when 'country', 'city' then continue;
      when 'height' then
        if v !~ '^[0-9]{3}$' or v::int not between 100 and 250 then continue; end if;
        update customers set height = v::int where id = p_id;
      when 'photo' then
        -- customer_set_photo's rule: the photos bucket or a Google picture, no quotes, markup or
        -- whitespace, 2000 characters at most (bug hunt 2026-10-28)
        if length(v) > 2000 or v !~ '^https://[^[:space:]"''<>`\\]+$'
           or v !~ '^https://([a-z0-9]+\.supabase\.co/storage/v1/object/public/photos/|lh[0-9]+\.googleusercontent\.com/)' then continue; end if;
        update customers set photo = v where id = p_id;
      when 'type_preference' then
        if not _type_ok(v) or v = 'Any' then continue; end if;
        update customers set type_preference = v where id = p_id;
      when 'profession' then
        v := regexp_replace(v, '\s+', ' ', 'g');
        if char_length(v) < 2 or char_length(v) > 80 or v ~ '[<>"`{}]' then continue; end if;
        update customers set profession = v where id = p_id;
      when 'workplace' then
        v := regexp_replace(v, '\s+', ' ', 'g');
        if char_length(v) < 2 or char_length(v) > 120 or v ~ '[<>"`{}]' then continue; end if;
        update customers set workplace = v where id = p_id;
      when 'heard_from' then
        if v not in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp','google','friend','invited',
                     'passed_by','event','hotel','school','work','community','other') then continue; end if;
        update customers set heard_from = v where id = p_id;
      when 'instagram', 'x', 'tiktok', 'linkedin' then
        v := left(regexp_replace(v, '^[[:space:]@/]+|[[:space:]/]+$', '', 'g'), 100);
        rule := case k when 'x' then '^[A-Za-z0-9_]{1,15}$'
                       when 'linkedin' then '^[A-Za-z0-9._%-]{3,100}$'
                       else '^[A-Za-z0-9._]{1,30}$' end;
        if v !~ rule then continue; end if;
        update customers set socials = coalesce(socials,'{}'::jsonb) || jsonb_build_object(k, v) where id = p_id;
      else continue;
    end case;
    done := done || k;
  end loop;

  -- The second emergency contact (20261007150000): one answer of three parts, under
  -- customer_set_emergency2's rules, against the rider's own number and the first contact's as they
  -- stand now (the loop may just have changed either). "I don't have one" cleared it above.
  if 'emergency2' = any(flags) and not ('emergency2' = any(done)) and jsonb_typeof(p_values->'emergency2') = 'object' then
    declare
      e2      jsonb := p_values->'emergency2';
      e2_name text := nullif(regexp_replace(btrim(coalesce(e2->>'name','')), '\s+', ' ', 'g'), '');
      e2_ph   text := nullif(regexp_replace(coalesce(e2->>'phone',''), '[^0-9+]', '', 'g'), '');
      e2_rel  text := nullif(lower(btrim(coalesce(e2->>'relation',''))), '');
      e2_own  text;
      e2_one  text;
    begin
      select regexp_replace(coalesce(x.phone,''), '\D', '', 'g'), regexp_replace(coalesce(x.emergency_phone,''), '\D', '', 'g')
        into e2_own, e2_one from customers x where x.id = p_id;
      if e2_name is not null and char_length(e2_name) between 2 and 80
         and _name_chars_ok(e2_name) and _name_parts_ok(e2_name)
         and coalesce(e2_ph ~ '^\+?[0-9]{8,15}$', false)
         and coalesce(e2_rel in ('spouse','parent','sibling','child','relative','friend','colleague','other'), false)
         and (e2_own = '' or right(regexp_replace(e2_ph, '\D', '', 'g'), 9) <> right(e2_own, 9))
         and (e2_one = '' or right(regexp_replace(e2_ph, '\D', '', 'g'), 9) <> right(e2_one, 9)) then
        update customers set emergency2_name = e2_name, emergency2_phone = e2_ph, emergency2_relation = e2_rel where id = p_id;
        done := array_append(done, 'emergency2');
      end if;
    end;
  end if;
  -- A first contact just answered with the number a still-asked second contact keeps goes back to what
  -- it was and stays asked: two contacts are two people.
  if 'emergency' = any(done) and 'emergency2' = any(flags) and not ('emergency2' = any(done))
     and exists (select 1 from customers x
                  where x.id = p_id and coalesce(x.emergency_phone,'') <> '' and coalesce(x.emergency2_phone,'') <> ''
                    and right(regexp_replace(x.emergency_phone, '\D', '', 'g'), 9)
                        = right(regexp_replace(x.emergency2_phone, '\D', '', 'g'), 9)) then
    update customers set emergency_name = c.emergency_name, emergency_phone = c.emergency_phone,
                         emergency_relation = c.emergency_relation where id = p_id;
    done := array_remove(done, 'emergency');
  end if;
  -- A second contact never stands alone: without a first, it moves up into the first place.
  update customers set emergency_name = emergency2_name, emergency_phone = emergency2_phone,
                       emergency_relation = emergency2_relation,
                       emergency2_name = null, emergency2_phone = null, emergency2_relation = null
   where id = p_id and emergency_name is null and emergency2_name is not null;

  stored := array(select f from unnest(stored) f where f <> all(done));
  update customers set fix_fields = case when cardinality(stored) = 0 then null else stored end where id = p_id;

  if cardinality(done) > 0 then
    select * into n from customers where customers.id = p_id;
    update customer_flags cf set
        changes = cf.changes || coalesce((
          select jsonb_object_agg(k2, jsonb_build_object(
            'before', case when k2 = 'whatsapp' then case when c.whatsapp_same is null then null
                             else jsonb_build_object('same', c.whatsapp_same, 'phone', case when c.whatsapp_same then c.phone else c.whatsapp end) end
                           when k2 in ('instagram','x','tiktok','linkedin') then to_jsonb(c)->'socials'->k2
                           when k2 = 'emergency' then case when c.emergency_name is null then null
                             else jsonb_build_object('name', c.emergency_name, 'phone', c.emergency_phone, 'relation', c.emergency_relation) end
                           when k2 = 'emergency2' then case when c.emergency2_name is null then null  -- (20261007150000)
                             else jsonb_build_object('name', c.emergency2_name, 'phone', c.emergency2_phone, 'relation', c.emergency2_relation) end
                           else to_jsonb(c)->k2 end,
            'after',  case when k2 = 'whatsapp' then case when n.whatsapp_same is null then null
                             else jsonb_build_object('same', n.whatsapp_same, 'phone', case when n.whatsapp_same then n.phone else n.whatsapp end) end
                           when k2 in ('instagram','x','tiktok','linkedin') then to_jsonb(n)->'socials'->k2
                           when k2 = 'emergency' then case when n.emergency_name is null then null
                             else jsonb_build_object('name', n.emergency_name, 'phone', n.emergency_phone, 'relation', n.emergency_relation) end
                           when k2 = 'emergency2' then case when n.emergency2_name is null then null
                             else jsonb_build_object('name', n.emergency2_name, 'phone', n.emergency2_phone, 'relation', n.emergency2_relation) end
                           else to_jsonb(n)->k2 end,
            'at', now()))
          from unnest(done) k2
          where k2 <> 'password'
            and (k2 = any(cf.fields) or (k2 in ('country','city') and cf.fields && array['country','city']))), '{}'::jsonb),
        status      = case when cardinality(stored) = 0 then 'answered' else 'pending' end,
        answered_at = case when cardinality(stored) = 0 then now() else null end
      where cf.customer_id = p_id and cf.status = 'pending';
  end if;

  return array(select f from unnest(flags) f where f <> all(done));
end $function$;

-- 6 ambassador_mine -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ambassador_mine(p_id text, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare a ambassadors%rowtype; c customers%rowtype; v_digits text; v_ev jsonb; v_red jsonb;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select * into c from customers where id = p_id;
  v_digits := right(regexp_replace(coalesce(c.phone,''), '\D', '', 'g'), 9);
  select * into a from ambassadors
   where status in ('active','paused')
     and (customer_id = p_id or (customer_id is null   -- never another account's ambassador (bug hunt 2026-10-28)
                                 and length(v_digits) >= 9 and right(regexp_replace(coalesce(phone,''), '\D', '', 'g'), 9) = v_digits))
   order by (customer_id = p_id) desc nulls last, id limit 1;   -- a null sorts first under desc (20261007120000)
  if a.id is null then return jsonb_build_object('ok', true, 'ambassador', false); end if;
  -- Found by the account's phone alone: that number is the account's own word, never checked, and the
  -- code with the phone is what ambassador_redeem spends on. The card shows the points, not the code
  -- or the history, until staff link the account (bug hunt 2026-10-28).
  if a.customer_id is null then
    return jsonb_build_object('ok', true, 'ambassador', true, 'first_name', split_part(a.name, ' ', 1), 'code', '', 'status', a.status)
      || _amb_summary(a.id) || jsonb_build_object('events', '[]'::jsonb, 'redemptions', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'context', e.context, 'points', e.points, 'status', e.status) order by e.at desc), '[]'::jsonb)
    into v_ev from (select * from _amb_events(a.code) order by at desc limit 12) e;
  select coalesce(jsonb_agg(jsonb_build_object('at', r.created_at, 'item', r.item, 'points', r.points, 'status', r.status) order by r.created_at desc), '[]'::jsonb)
    into v_red from (select * from ambassador_redemptions where ambassador_id = a.id and status <> 'cancelled' order by created_at desc limit 10) r;
  return jsonb_build_object('ok', true, 'ambassador', true, 'first_name', split_part(a.name, ' ', 1), 'code', a.code, 'status', a.status)
    || _amb_summary(a.id) || jsonb_build_object('events', v_ev, 'redemptions', v_red);
end $function$;

-- 7 staff_my_settings -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_my_settings(p_name text DEFAULT NULL::text, p_photo text DEFAULT NULL::text, p_set_photo boolean DEFAULT false, p_nt_off text[] DEFAULT NULL::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  _uid uuid := auth.uid(); _old text; _new text; _off text[];
begin
  -- a disabled staffer's still-valid sign-in changes nothing (bug hunt 2026-10-28)
  if _uid is null or not exists (select 1 from staff where user_id = _uid and disabled_at is null) then
    raise exception 'NOT_STAFF' using errcode = '42501';
  end if;
  if p_name is not null then
    _new := left(btrim(regexp_replace(p_name, '\s+', ' ', 'g')), 40);
    if length(_new) < 2 then raise exception 'BAD_NAME' using errcode = '22023'; end if;
    -- The account's own name only: op_name in the auth metadata is the user's to write, so it
    -- must not say which team-list entry (and PIN) moves (20261004100000).
    select nullif(btrim(s.display_name), '') into _old from staff s where s.user_id = _uid;
    update staff set display_name = _new where user_id = _uid;
    update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('op_name', _new)
     where id = _uid;
    if _old is not null and _old <> _new
       and not exists (select 1 from team_members where lower(name) = lower(_new)) then
      update team_members set name = _new where name = _old;
    end if;
  end if;
  if p_set_photo then
    if p_photo is not null
       and p_photo !~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/photos/p/[A-Za-z0-9_-]{1,64}\.jpg$'
       and (p_photo !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' or length(p_photo) > 200000) then
      raise exception 'BAD_PHOTO' using errcode = '22023';
    end if;
    update staff set photo = p_photo where user_id = _uid;
  end if;
  if p_nt_off is not null then
    select coalesce(array_agg(distinct k), '{}') into _off
      from unnest(p_nt_off) k where k in ('long','ws','apps','learn','bday','msgs','attn','lowrate','stock','vlate');  -- vlate: a venue's late cancellation (20261007120100)
    update staff set nt_off = _off where user_id = _uid;
  end if;
  return (select jsonb_build_object('display_name', display_name, 'photo', photo, 'nt_off', nt_off)
            from staff where user_id = _uid);
end $function$;

-- 8 staff_set_own_email ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_set_own_email(p_password text, p_email text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  _uid uuid := auth.uid(); _hash text; _email text := lower(btrim(coalesce(p_email, '')));
begin
  -- a disabled staffer's still-valid sign-in changes nothing (bug hunt 2026-10-28)
  if _uid is null or not exists (select 1 from staff where user_id = _uid and disabled_at is null) then
    raise exception 'NOT_STAFF' using errcode = '42501';
  end if;
  select encrypted_password into _hash from auth.users where id = _uid;
  if _hash is null or coalesce(p_password, '') = '' or extensions.crypt(p_password, _hash) <> _hash then
    raise exception 'BAD_PASSWORD' using errcode = '28P01';
  end if;
  if _email !~ '^[^[:space:]@<>"''()]+@[^[:space:]@<>"''()]+\.[^[:space:]@<>"''()]+$' or length(_email) > 120 then
    raise exception 'BAD_EMAIL' using errcode = '22023';
  end if;
  if exists (select 1 from auth.users where lower(email) = _email and id <> _uid) then
    raise exception 'EMAIL_TAKEN' using errcode = '23505';
  end if;
  update auth.users set email = _email, email_confirmed_at = coalesce(email_confirmed_at, now()),
         email_change = '', email_change_token_new = '', email_change_token_current = '', updated_at = now()
   where id = _uid;
  update auth.identities set identity_data = coalesce(identity_data, '{}'::jsonb) || jsonb_build_object('email', _email),
         updated_at = now()
   where user_id = _uid and provider = 'email';
  return _email;
end $function$;

-- checks: every function kept SECURITY DEFINER and its search_path; the view is still there
do $chk$
declare f text;
begin
  foreach f in array array['customer_create_booking','customer_booking_update','customer_set_photo','customer_fix_save',
                           'ambassador_mine','staff_my_settings','staff_set_own_email'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if not has_table_privilege('anon', 'public.queue_public', 'SELECT') then
    raise exception 'queue_public lost its anon SELECT';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261028120100', 'bh28_public')
on conflict (version) do nothing;

commit;
