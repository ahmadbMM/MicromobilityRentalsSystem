-- ============================================================================
-- The Arena Heros Hybrid Race (the owner, 2026-10-28): "create a session for this event and make it exclusive
-- for community members Arena Heros Hybrid Race * Friday 6th of November * 6am-8pm with prayer break * Teams
-- only (2 Males or 2 Females) * Gymnation Tahlia street * 140 SAR per person (Medals Included) * 7 stations *
-- Race Details https://www.instagram.com/p/Dd1Lc87CJrq/ ask them for the following and prefill already saved
-- info: First name, Lastname, Email, Mobile, Gender, Open or Elite, Consent to share data with 3rd parties".
-- The owner's answers: teams of two of the same gender only (no individual entries, no mixed); the way to pay is
-- announced later (staff mark places paid as usual); the details go to all the organisers, WeSportify, Mile and
-- Gymnation; heat times come from the organiser. Each partner books their own place from their own account with
-- a team code, as Victory Lap's Doubles do; "find me a partner" asks staff to pair. Both are Community members.
--
-- It is Victory Lap's machinery (20261017210000) for a second ride_kind, 'arena' (event_kind 'community',
-- open_to_all false: _community_booking_gate already holds it to Community members, unchanged here):
--  1. _race_code_norm(code, prefix): a team code as typed, read with its kind's prefix (VL- for Victory Lap,
--     AH- for the Arena race). _vl_code_new makes a code with the prefix of the session's kind. _vl_code_norm
--     stays as it was (no longer called).
--  2. _vl_entry_guard (rebuilt from its live definition): on an 'arena' session the races are wd / md only and
--     the race must be the account's gender (VL_GENDER), the divisions op / el, no T-shirt, no 5 km time, no
--     age rule; the details are the athlete's own first and last name, email and mobile on the entry
--     (queue_entries.vl first / last / email / phone, as typed; never written onto the account) and a gender on
--     the account (VL_DETAILS); VL_SHARE names WeSportify, Mile and Gymnation; one place per account per session
--     (VL_ONE_EACH); every place is a Doubles place, so the team rules are Victory Lap's Doubles rules with
--     AH- codes. Staff are free as before; the guard keeps the shape, and on the Arena race the athlete's
--     details too. Victory Lap's rules are unchanged.
--  3. vl_team_peek / customer_vl_teams: both kinds; the partner's first name is the one they entered for the
--     race when there is one (the Arena race), else their account's first word (Victory Lap, as before).
--  4. customer_vl_update: both kinds; on the Arena race the athlete's first and last name, email and mobile (any
--     time before race day) and the division (while alone in the team; the guard says VL_TEAM_LOCKED after).
--  5. _fare_now: an Arena seat costs the session's own price (sessions.price, 140), like Victory Lap's.
--  6. customer_create_booking copies vl and stamps data_share_at for the Arena race too (built from
--     20261028120100_bh28_public.sql, the bug hunt's version, which is to be applied before this file);
--     customer_accept_share takes the third kind.
--  7. _booking_window_guard: the Arena race is booked from the day it is announced, outside the window.
--  8. The session itself: 2026-11-06-ah, open, 100 places (athletes; 50 teams), 140 SAR, Gymnation.
-- Left Victory Lap's own: vlap_member / _vlap_holder (the tag), customer_vl_ticket and staff_vl_receipt*
-- (the ticket question and the receipts), _tag_one_of_two, the badge, _mt_core.
--
-- Apply after the app that knows the 'arena' kind is live: an older page reads an unknown community kind as the
-- Saturday ride (AGENTS.md, Run for Her), and the session row goes in with this file. Not during a ride night
-- (18:00-23:00 Riyadh). Run supabase/checks/security-attributes.sql afterwards.
--
-- Rollback: delete the session (delete from queue_entries where session_id = '2026-11-06-ah' first, if anyone
-- booked), then re-create each function from the file it came from, which is the live text these were rebuilt
-- from - 20261017210000_victory_lap.sql for _vl_code_new, _vl_entry_guard, vl_team_peek, customer_vl_teams,
-- customer_vl_update, _fare_now, customer_accept_share and _booking_window_guard, and
-- 20261028120100_bh28_public.sql for customer_create_booking (NOT live: built from that file, which the bug hunt
-- applies first) - and drop function public._race_code_norm(text, text). Live md5(prosrc) before this file
-- (production qpffkzmsfyilicwcsszz, 2026-10-28):
--   _fare_now(text,text,text)                    339e335bb74f436d81c9b7dd9b4d24d3
--   _booking_window_guard()                      f8b2a8dfca3af4952d4b18492aa3f019
--   customer_accept_share(text,text,text)        d9752c8ce62187d14c162662958c24fa
--   customer_create_booking(text,text,jsonb)     9186faaafbd51b355624221ef4c7e3ee (pre-120100; this file builds on 120100)
--   _vl_code_new(text)                           42c4f17a30d82d3d2b541590203aec50
--   _vl_code_norm(text)                          cfef707c5cef7c59d42b15f6af6ed23c (unchanged)
--   _vl_entry_guard()                            5ad8cb03a1cad71326c68a018d972b8e
--   vl_team_peek(text,text,text,text)            eed621f4a1acac2cdf57208034bd6093
--   customer_vl_teams(text,text)                 f6a8e8c264cbe46d95160ff9c36b8ee7
--   customer_vl_update(text,text,text,jsonb)     7a0ea36918b6fbc397b8a71dc6621e41
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. Team codes with their kind's prefix ──────────────────────────────────────────────────────────
create or replace function public._race_code_norm(p text, p_pfx text)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$
  select case when x = '' then null
              else p_pfx || '-' || case when left(x, length(p_pfx)) = p_pfx then substr(x, length(p_pfx) + 1) else x end end
    from (select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) x) z;
$function$;
revoke execute on function public._race_code_norm(text, text) from public, anon, authenticated;

create or replace function public._vl_code_new(p_session text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare a text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; c text; i int; n int := 0; pfx text;
begin
  -- the Arena Heros race's codes are AH-, Victory Lap's VL- (20261028200000)
  pfx := case when (select x.ride_kind from sessions x where x.id = p_session) = 'arena' then 'AH-' else 'VL-' end;
  loop
    c := pfx;
    for i in 1..4 loop c := c || substr(a, 1 + floor(random() * length(a))::int, 1); end loop;
    exit when not exists (select 1 from queue_entries q where q.session_id = p_session and q.vl->>'team' = c);
    n := n + 1;
    if n > 60 then raise exception 'no free team code' using errcode = 'P0001'; end if;
  end loop;
  return c;
end $function$;

-- ── 2. The guard: Victory Lap as it was, the Arena race by its own rules ─────────────────────────────
create or replace function public._vl_entry_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  s record; c record; m record; cfg jsonb; v jsonb;
  _staff boolean := (select is_staff());
  _race text; _div text; _shirt text; _t5 text; _team text; _join text; _pair boolean;
  _dbl boolean; _day date; _n int; _races text[]; _divs text[];
  _ar boolean; _pfx text; _first text; _last text; _email text; _phone text;
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
    elsif _team = '*' then _team := _vl_code_new(new.session_id);
    elsif _join is not null then _team := _join;
    elsif _team is not null then _team := _race_code_norm(_team, _pfx);
    end if;
    if _team is not null then _pair := false; end if;
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

-- ── 3. The team a code names, and the partner on each of a rider's teams ─────────────────────────────
create or replace function public.vl_team_peek(p_id text, p_token text, p_session_id text, p_code text)
 returns table(team text, race text, div text, partner text, need text, is_full boolean)
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare _code text; m record;
begin
  if p_id is null or not _cust_token_ok(p_id, p_token) then return; end if;
  -- the code read with the prefix of the session's kind: AH- on the Arena race, VL- on Victory Lap (20261028200000)
  _code := _race_code_norm(p_code, case when (select x.ride_kind from sessions x where x.id = p_session_id) = 'arena' then 'AH' else 'VL' end);
  if _code is null then return; end if;
  select count(*) as n, min(q.vl->>'race') as race, min(q.vl->>'div') as div,
         min(coalesce(nullif(btrim(q.vl->>'first'), ''), split_part(btrim(coalesce(cx.name, '')), ' ', 1))) as first, min(cx.gender) as gender
    into m
    from queue_entries q join sessions s on s.id = q.session_id
    left join customers cx on cx.id = q.customer_id
   where q.session_id = p_session_id and coalesce(s.ride_kind, '') in ('vlap', 'arena')
     and q.vl->>'team' = _code and coalesce(q.customer_id, '') <> p_id
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
  if m.n = 0 then return; end if;
  team := _code; race := m.race; div := m.div; is_full := m.n >= 2;
  partner := case when m.n = 1 then nullif(m.first, '') end;
  need := case m.race when 'wd' then 'female' when 'md' then 'male'
                      when 'xd' then case m.gender when 'male' then 'female' when 'female' then 'male' else '' end
                      else '' end;
  return next;
end $function$;

create or replace function public.customer_vl_teams(p_id text, p_token text)
 returns table(entry_id text, team text, partner text)
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if p_id is null or not _cust_token_ok(p_id, p_token) then return; end if;
  return query
    select q.id, q.vl->>'team',
           (select coalesce(nullif(btrim(o.vl->>'first'), ''), nullif(split_part(btrim(coalesce(cx.name, '')), ' ', 1), ''))
              from queue_entries o left join customers cx on cx.id = o.customer_id
             where o.session_id = q.session_id and o.vl->>'team' = q.vl->>'team' and o.id <> q.id
               and coalesce(o.status, '') not in ('cancelled', 'removed', 'noshow')
             order by o.registered_at limit 1)
      from queue_entries q join sessions s on s.id = q.session_id
     where q.customer_id = p_id and coalesce(s.ride_kind, '') in ('vlap', 'arena') and q.vl->>'team' is not null
       and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
end $function$;

-- ── 4. A rider's own changes ─────────────────────────────────────────────────────────────────────────
create or replace function public.customer_vl_update(p_id text, p_token text, p_entry_id text, p_patch jsonb)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare q queue_entries%rowtype; v jsonb; _k text; f text;
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'patch';
  end if;
  select x.* into q from queue_entries x join sessions s on s.id = x.session_id
   where x.id = p_entry_id and x.customer_id = p_id and coalesce(s.ride_kind, '') in ('vlap', 'arena')
     and coalesce(x.status, '') in ('waiting', 'waitlist')
     and coalesce(x.session_date, '') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
   for update of x;
  if q.id is null then return false; end if;
  select x.ride_kind into _k from sessions x where x.id = q.session_id;
  v := coalesce(q.vl, '{}'::jsonb);
  if p_patch ? 'div' then v := v || jsonb_build_object('div', p_patch->>'div'); end if;
  if _k = 'arena' then
    -- the Arena race: the athlete's details as entered for the race (_vl_entry_guard checks them, VL_DETAILS)
    foreach f in array array['first', 'last', 'email', 'phone'] loop
      if p_patch ? f then v := v || jsonb_build_object(f, p_patch->>f); end if;
    end loop;
  else
    if p_patch ? 'shirt' then v := v || jsonb_build_object('shirt', p_patch->>'shirt'); end if;
    if p_patch ? 't5k' then
      v := case when nullif(p_patch->>'t5k', '') is null then v - 't5k' else v || jsonb_build_object('t5k', p_patch->>'t5k') end;
    end if;
  end if;
  update queue_entries set vl = v where id = q.id;
  return found;
end $function$;

-- ── 5. The price: the session's own, per athlete ─────────────────────────────────────────────────────
create or replace function public._fare_now(p_session_id text, p_entry_id text, p_type text)
 returns numeric
 language sql
 stable
 set search_path to 'public'
as $function$
  select case
    when coalesce(s.event_kind, '') = 'community' and not coalesce(s.paid_ride, false) then 0
    when coalesce(s.ride_kind, '') in ('event', 'vlap', 'arena') then least(greatest(coalesce(s.price, 0), 0), 5000)
    else coalesce(_booking_fare(p_entry_id, coalesce(s.ride_kind, ''), p_type),
                  case when coalesce(p_type, '') = 'Own' then null
                       else (select max(price) from ride_prices) end)
  end
  from sessions s where s.id = p_session_id
$function$;

-- ── 6. Booking: the race's details and the agreement to share go on the row ─────────────────────────
-- Built from 20261028120100_bh28_public.sql (the bug hunt's version), not from the live text: two lines change,
-- the share stamp and the copy of vl, which now take 'arena' beside 'vlap'.
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

create or replace function public.customer_accept_share(p_id text, p_token text, p_session_id text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare _n int;
begin
  if not _cust_token_ok(p_id, p_token) then return -1; end if;
  update queue_entries x
     set data_share_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    from sessions s
   where s.id = x.session_id
     and coalesce(s.ride_kind, '') in ('runher', 'vlap', 'arena')
     and x.customer_id = p_id
     and x.session_id = p_session_id
     and coalesce(x.data_share_at, '') = ''
     and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow')
     and coalesce(x.session_date, '') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  get diagnostics _n = row_count;
  return _n;
end $function$;

-- ── 7. Booked from the day it is announced ───────────────────────────────────────────────────────────
create or replace function public._booking_window_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare w jsonb; days int; at_t text; sd date; today date; open_day date; now_t text;
begin
  if is_staff() then return new; end if;
  if new.status is distinct from 'waiting' and new.status is distinct from 'waitlist' then return new; end if;
  if exists (select 1 from sessions x where x.id = new.session_id and coalesce(x.ride_kind, '') in ('vlap', 'arena')) then
    return new;
  end if;
  select value into w from site_content where key = 'booking.window';
  if w is null or jsonb_typeof(w) <> 'object' then return new; end if;
  begin days := (w->>'days')::int; exception when others then days := null; end;
  if days is null or days < 0 then return new; end if;
  at_t := nullif(w->>'at', '');
  begin sd := new.session_date::date; exception when others then return new; end;
  today := (now() at time zone 'Asia/Riyadh')::date;
  open_day := sd - days;
  if open_day > today then
    raise exception 'NOT_OPEN_YET: booking for % opens on %', new.session_date, open_day using errcode = 'P0001';
  end if;
  if open_day = today and at_t ~ '^\d{2}:\d{2}$' then
    now_t := to_char(now() at time zone 'Asia/Riyadh', 'HH24:MI');
    if now_t < at_t then
      raise exception 'NOT_OPEN_YET: booking for % opens at %', new.session_date, at_t using errcode = 'P0001';
    end if;
  end if;
  return new;
end $function$;

-- ── 8. The session: Friday 6 November, 6 am to 8 pm, Gymnation on Tahlia Street ──────────────────────
-- As the staff form writes an Arena session: no title (each reader sees the race's name in their language),
-- the queue hidden, first come first served (no approval), 100 places (athletes; 50 teams), 140 SAR each,
-- Community members only; bike_slots carries the times alone, as for every seated session.
insert into public.sessions (id, day, session_date, capacity, spots, status, created_at, bike_slots, location, meet_url,
                             title, description, event_kind, ride_kind, open_to_all, paid_ride, price, needs_approval,
                             hide_queue, required_tag_id, vl)
values ('2026-11-06-ah', 'Friday', '2026-11-06', 100, 100, 'open',
        to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        '{"_time":"06:00 - 20:00"}', 'Gymnation, Tahlia Street',
        'https://www.google.com/maps/search/?api=1&query=Gymnation%20Tahlia%20Street%20Jeddah',
        null,
        'Teams of 2 only: two men or two women, each partner booking their own place. Open or Elite division, 7 stations. '
        || '140 SAR per athlete, medals included. 6:00 am to 8:00 pm with a prayer break; the organisers give each team its '
        || 'heat time. Race details from the organisers (WeSportify, Mile and Gymnation): https://www.instagram.com/p/Dd1Lc87CJrq/',
        'community', 'arena', false, true, 140, false,
        true, null, '{"races":["wd","md"],"divs":["op","el"],"pair":true}'::jsonb)
on conflict (id) do nothing;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261028200000', 'arena_race')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): every function kept its header, the new kind is in each one, the session is in.
select (select bool_and(prosecdef) from pg_proc
         where oid in ('public._vl_entry_guard()'::regprocedure, 'public._vl_code_new(text)'::regprocedure,
                       'public.vl_team_peek(text,text,text,text)'::regprocedure, 'public.customer_vl_teams(text,text)'::regprocedure,
                       'public.customer_vl_update(text,text,text,jsonb)'::regprocedure,
                       'public.customer_create_booking(text,text,jsonb)'::regprocedure,
                       'public.customer_accept_share(text,text,text)'::regprocedure)) as definers_kept,
       (select bool_or(prosecdef) from pg_proc
         where oid in ('public._fare_now(text,text,text)'::regprocedure, 'public._booking_window_guard()'::regprocedure,
                       'public._race_code_norm(text,text)'::regprocedure)) as invoker_became_definer,
       (select count(*) from pg_proc
         where oid in ('public._vl_entry_guard()'::regprocedure, 'public.vl_team_peek(text,text,text,text)'::regprocedure,
                       'public.customer_vl_teams(text,text)'::regprocedure, 'public.customer_vl_update(text,text,text,jsonb)'::regprocedure,
                       'public._fare_now(text,text,text)'::regprocedure, 'public.customer_create_booking(text,text,jsonb)'::regprocedure,
                       'public.customer_accept_share(text,text,text)'::regprocedure, 'public._booking_window_guard()'::regprocedure,
                       'public._vl_code_new(text)'::regprocedure)
           and prosrc ~ 'arena') as know_arena_of_9,
       public._race_code_norm('ah 4k7q', 'AH') as code_ah, public._race_code_norm('vl-4k7q', 'VL') as code_vl,
       (select ride_kind || ' ' || status || ' ' || spots || ' ' || price from sessions where id = '2026-11-06-ah') as session_row,
       (select version from supabase_migrations.schema_migrations where version = '20261028200000') as ledger;
