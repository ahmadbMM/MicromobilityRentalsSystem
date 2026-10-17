-- ============================================================================
-- Victory Lap by Fitness Empire (the owner, 2026-10-14 and 2026-10-17): a hybrid fitness race at the
-- Jeddah Corniche Circuit on 26 October 2026, run by Kamin Sports, booked through our app by Community
-- members and Victory Lap tag holders. Five races (Women's / Men's Singles, Women's / Men's / Mixed
-- Doubles), four divisions (Sprint Open, Sprint Elite, Open, Elite), 150 SAR per athlete VAT included
-- (Doubles: 150 for each partner, each on their own booking), the way to pay announced later, 16 and
-- over, every athlete agrees that their details go to Kamin Sports, a finisher's badge.
--
--  1. tags: tag_vlap (slug vlap, locked). An account holds the Community tag or the Victory Lap tag,
--     never both (_tag_one_of_two now keeps two pairs: Community/Petromin and Community/Victory Lap).
--  2. sessions.vl: the race's settings, staff's to change (null = everything open):
--       {races:[ws,ms,wd,md,xd], divs:[so,se,op,el], pair:true, pay:{en,ar}, share:{en,ar}}
--     races / divs: which are taken; pair: whether an athlete may ask staff for a partner; pay: the line
--     that says how to pay (until it is known: "announced soon"); share: what goes to Kamin Sports.
--  3. queue_entries.vl: an athlete's race, {race, div, shirt, t5k, team, pair}. race ws|ms|wd|md|xd,
--     div so|se|op|el, shirt XS..XXL, t5k u20|m2030|o30 (optional), team 'VL-XXXX' (Doubles), pair true
--     (Doubles, no partner yet: staff pair them). A customer's booking sends {join:'VL-XXXX'} to join a
--     team; the guard turns it into team and takes the team's race and division.
--  4. _vlap_holder / vlap_member: who may book (Community tag or Victory Lap tag); the members gate
--     (_community_booking_gate, rebuilt from 20261017120000) and the re-book in customer_booking_update
--     let a Victory Lap tag holder onto a Victory Lap session and nowhere else members-only.
--  5. _fare_now: a Victory Lap seat costs the session's own price (sessions.price, 150), like an event.
--  6. customer_create_booking copies vl and stamps data_share_at for Victory Lap as for Run for Her
--     (patched from its live definition by two anchors); customer_accept_share takes both kinds.
--  7. _vl_entry_guard (BEFORE INSERT OR UPDATE OF status, session_id, vl): a customer's live row needs a
--     race and division that are open (VL_RACE, VL_DIV), a T-shirt size (VL_SHIRT), the details on the
--     account - full name, email, birth date, gender, emergency contact (VL_DETAILS) -, 16 or over on the
--     race's day (VL_AGE), a race of their gender (VL_GENDER), the agreement to share (VL_SHARE), and at
--     most one Singles and one Doubles place (VL_ONE_EACH). Doubles: a new team gets a code; joining needs
--     a team on that session (VL_NO_TEAM) with one athlete in it (VL_TEAM_FULL), not one's own
--     (VL_TEAM_SELF), and the right partner for the race (VL_GENDER); once a partner is in, the division
--     is the team's (VL_TEAM_LOCKED). Staff are free: they set any race, division, team (team '*' = a new
--     code) and pairing; the guard only keeps the shape.
--  8. vl_team_peek / customer_vl_teams / customer_vl_update / customer_set_gender: the team a code
--     names (before joining), the partner on each of a rider's teams, a rider's own changes (division
--     while alone in the team, T-shirt, 5 km time), and the gender a race asks for.
--  9. _booking_window_guard: Victory Lap is booked from the day it is announced, outside the window.
-- 10. The finisher's badge, victory_lap: earned by a finished (done) row on a Victory Lap session, which
--     is what checking an athlete out or closing the session out leaves (computed by the app and the
--     website); staff can give and take it back like any badge.
--
-- The session itself is a separate insert, run once the app that knows the kind is live: an older
-- page reads an unknown community kind as the Saturday ride.
--
-- Rollback:
--   drop trigger if exists queue_entries_vl_guard on public.queue_entries;
--   drop function if exists public._vl_entry_guard(), public._vl_code_new(text), public.vl_team_peek(text,text,text,text),
--     public.customer_vl_teams(text,text), public.customer_vl_update(text,text,text,jsonb), public.customer_set_gender(text,text,text),
--     public.vlap_member(text,text), public._vlap_holder(text);
--   re-run _community_booking_gate of 20261017120000, _fare_now of 20261005210000, _tag_one_of_two of 20261012180000,
--   _booking_window_guard of 20260928140000, customer_accept_share of 20261006180000;
--   customer_create_booking / customer_booking_update: the two patches backwards;
--   alter table public.queue_entries drop column if exists vl; alter table public.sessions drop column if exists vl;
--   delete from public.customer_tags where tag_id = 'tag_vlap'; delete from public.tags where id = 'tag_vlap';
--   delete from public.customer_badges where badge_id = 'bd_victory_lap'; delete from public.badges where id = 'bd_victory_lap';
-- Idempotent. Run supabase/checks/security-attributes.sql after.
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


/* -- 1. the tag ----------------------------------------------------------------------------- */
insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values ('tag_vlap', 'vlap', 'Victory Lap', '#0d0d0d',
        'Books Victory Lap by Fitness Empire, and no other members-only ride. Never on an account with the Community tag.',
        false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do nothing;


/* -- 2, 3. the race's settings and an athlete's race -------------------------------------------- */
alter table public.sessions add column if not exists vl jsonb;
alter table public.sessions drop constraint if exists sessions_vl_object;
alter table public.sessions add constraint sessions_vl_object
  check (vl is null or (jsonb_typeof(vl) = 'object' and pg_column_size(vl) < 8000));
comment on column public.sessions.vl is
  'Victory Lap: the race''s settings {races, divs, pair, pay:{en,ar}, share:{en,ar}}; null = all open (20261017210000).';

alter table public.queue_entries add column if not exists vl jsonb;
alter table public.queue_entries drop constraint if exists queue_entries_vl_object;
alter table public.queue_entries add constraint queue_entries_vl_object
  check (vl is null or (jsonb_typeof(vl) = 'object' and pg_column_size(vl) < 2000));
comment on column public.queue_entries.vl is
  'Victory Lap: the athlete''s {race, div, shirt, t5k, team, pair}; null on every other booking (20261017210000).';
create index if not exists queue_entries_vl_team_idx on public.queue_entries (session_id, (vl->>'team'))
  where vl is not null;


/* -- 4. who may book ------------------------------------------------------------------------ */
create or replace function public._vlap_holder(p_customer text)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select p_customer is not null and exists (
    select 1 from customer_tags ct
     where ct.customer_id = p_customer and ct.tag_id = 'tag_vlap'
       and _ctag_active(ct.starts_at, ct.expires_at));
$$;
revoke execute on function public._vlap_holder(text) from public, anon, authenticated;

-- The app's answer for the card's tap: a Community member or a Victory Lap tag holder (a bare boolean,
-- like community_member and petromin_member).
create or replace function public.vlap_member(p_id text, p_token text)
returns boolean
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then
    return false;
  end if;
  return _vlap_holder(p_id) or exists (
    select 1 from customer_tags ct join tags tg on tg.id = ct.tag_id
     where ct.customer_id = p_id and lower(tg.slug) = 'saturday'
       and _ctag_active(ct.starts_at, ct.expires_at));
end $$;
revoke execute on function public.vlap_member(text, text) from public;
grant  execute on function public.vlap_member(text, text) to anon, authenticated;

-- The members gate: rebuilt whole from 20261017120000, with the Victory Lap clause.
create or replace function public._community_booking_gate()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare s sessions%rowtype; pb text[]; _live int;
begin
  select * into s from sessions where id = new.session_id;
  -- A partner booking (partner_book, 20261017120000): marked, confirmed at once, never waitlisted.
  pb := string_to_array(coalesce(current_setting('mm.partner', true), ''), '|');
  if tg_op = 'INSERT' and cardinality(pb) = 3 and pb[1] = new.session_id then
    new.partner := pb[2];
    new.partner_code := (pb[3] = '1');
    new.approval := 'approved';
    if new.status = 'waitlist' then new.status := 'waiting'; end if;
    return new;
  end if;
  if s.id is not null
     and s.event_kind = 'community'
     and coalesce(s.open_to_all, false) = false
     and not is_staff()
     and (new.customer_id is null or not exists (
            select 1
              from customer_tags ct
              join tags tg on tg.id = ct.tag_id
             where ct.customer_id = new.customer_id
               and lower(tg.slug) = 'saturday'
               and _ctag_active(ct.starts_at, ct.expires_at)))
     -- a Petromin tag holder rides the Petromin nights (20261012180000)
     and not (coalesce(s.ride_kind, '') = 'petromin' and _petromin_holder(new.customer_id))
     -- a Victory Lap tag holder races Victory Lap (20261017210000)
     and not (coalesce(s.ride_kind, '') = 'vlap' and _vlap_holder(new.customer_id))
  then
    raise exception 'This ride is for community members only.' using detail = 'MEMBERS_ONLY';
  end if;
  -- The member cap (20261017120000): past it, a member brings their own bike. Staff too.
  if s.id is not null and s.member_cap is not null and new.partner is null
     and coalesce(new.type_preference, '') <> 'Own'
     and coalesce(new.status, '') not in ('cancelled', 'removed', 'noshow') then
    perform pg_advisory_xact_lock(hashtext('membercap:' || s.id));
    select count(*) into _live from queue_entries q
     where q.session_id = s.id and q.partner is null and q.id <> new.id
       and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
    if _live >= s.member_cap then
      raise exception 'Our bikes are taken for this ride. You can still join with your own bike.'
        using detail = 'MEMBER_BIKES_FULL';
    end if;
  end if;
  return new;
end $function$;
revoke execute on function public._community_booking_gate() from public, anon, authenticated;

-- Re-booking a cancelled booking: the same allowance (patched from the live definition by one anchor).
do $cbu$
declare d text;
begin
  d := pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure);
  if position('(20261017210000)' in d) > 0 then
    raise notice 'customer_booking_update already lets a Victory Lap tag holder back on; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$         and not (coalesce(_at.ride_kind,'') = 'petromin' and _petromin_holder(p_id))   -- (20261012180000)$a$,
$b$         and not (coalesce(_at.ride_kind,'') = 'petromin' and _petromin_holder(p_id))   -- (20261012180000)
         and not (coalesce(_at.ride_kind,'') = 'vlap' and _vlap_holder(p_id))           -- (20261017210000)$b$);
  execute d;
end $cbu$;

-- One of the two, now for two pairs: Community/Petromin (20261012180000) and Community/Victory Lap.
create or replace function public._tag_one_of_two()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare rivals text[];
begin
  rivals := case new.tag_id when 'tag_saturday' then array['tag_petromin', 'tag_vlap']
                            when 'tag_petromin' then array['tag_saturday']
                            when 'tag_vlap'     then array['tag_saturday'] end;
  if rivals is null then return new; end if;
  if new.expires_at is not null and new.expires_at <= (extract(epoch from now()) * 1000)::bigint then return new; end if;
  if exists (select 1 from customer_tags ct
              where ct.customer_id = new.customer_id and ct.tag_id = any(rivals)
                and (ct.expires_at is null or ct.expires_at > (extract(epoch from now()) * 1000)::bigint)) then
    raise exception 'An account holds the Community tag, or the Petromin or Victory Lap tag, never both.'
      using errcode = 'P0001', detail = 'TAG_EXCLUSIVE';
  end if;
  return new;
end $$;
revoke execute on function public._tag_one_of_two() from public, anon, authenticated;


/* -- 5. the fare --------------------------------------------------------------------------- */
CREATE OR REPLACE FUNCTION public._fare_now(p_session_id text, p_entry_id text, p_type text)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case
    when coalesce(s.event_kind, '') = 'community' and not coalesce(s.paid_ride, false) then 0
    when coalesce(s.ride_kind, '') in ('event', 'vlap') then least(greatest(coalesce(s.price, 0), 0), 5000)
    else coalesce(_booking_fare(p_entry_id, coalesce(s.ride_kind, ''), p_type),
                  case when coalesce(p_type, '') = 'Own' then null
                       else (select max(price) from ride_prices) end)
  end
  from sessions s where s.id = p_session_id
$function$;
revoke all on function public._fare_now(text, text, text) from public, anon, authenticated;


/* -- 6. a customer's booking carries the race ---------------------------------------------------- */
do $ccb$
declare d text;
begin
  d := pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure);
  if position('(20261017210000)' in d) > 0 then
    raise notice 'customer_create_booking already copies vl; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$      data_share_at                                   -- and the runner's agreement to share (20261006180000)
    ) values ($a$,
$b$      data_share_at,                                  -- and the runner's agreement to share (20261006180000)
      vl                                              -- Victory Lap: race, division, team (20261017210000)
    ) values ($b$);
  d := pg_temp._once(d,
$a$      case when it->>'share_ok' = 'true' and coalesce(s.ride_kind, '') = 'runher'
           then to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') end
    )
    returning$a$,
$b$      case when it->>'share_ok' = 'true' and coalesce(s.ride_kind, '') in ('runher', 'vlap')
           then to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
      case when coalesce(s.ride_kind, '') = 'vlap' and jsonb_typeof(it->'vl') = 'object'
           then it->'vl' end
    )
    returning$b$);
  execute d;
end $ccb$;

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
     and coalesce(s.ride_kind, '') in ('runher', 'vlap')   -- Victory Lap too (20261017210000)
     and x.customer_id = p_id
     and x.session_id = p_session_id
     and coalesce(x.data_share_at, '') = ''
     and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow')
     and coalesce(x.session_date, '') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  get diagnostics _n = row_count;
  return _n;
end $function$;
revoke all on function public.customer_accept_share(text, text, text) from public;
grant execute on function public.customer_accept_share(text, text, text) to anon, authenticated;


/* -- 7. an athlete's row ---------------------------------------------------------------------- */
-- A team code: VL- and four letters or digits that cannot be misread (no 0/O, 1/I/L), not yet used on
-- the session.
create or replace function public._vl_code_new(p_session text)
returns text
language plpgsql volatile security definer set search_path to 'public'
as $$
declare a text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; c text; i int; n int := 0;
begin
  loop
    c := 'VL-';
    for i in 1..4 loop c := c || substr(a, 1 + floor(random() * length(a))::int, 1); end loop;
    exit when not exists (select 1 from queue_entries q where q.session_id = p_session and q.vl->>'team' = c);
    n := n + 1;
    if n > 60 then raise exception 'no free team code' using errcode = 'P0001'; end if;
  end loop;
  return c;
end $$;
revoke execute on function public._vl_code_new(text) from public, anon, authenticated;

-- A code as typed: letters and digits only, upper case, VL- in front.
create or replace function public._vl_code_norm(p text)
returns text
language sql immutable set search_path to 'public'
as $$
  select case when x = '' then null else 'VL-' || regexp_replace(x, '^VL', '') end
    from (select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) x) z;
$$;
revoke execute on function public._vl_code_norm(text) from public, anon, authenticated;

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
begin
  select x.ride_kind, x.session_date, x.vl into s from sessions x where x.id = new.session_id;
  if not found or coalesce(s.ride_kind, '') <> 'vlap' then return new; end if;

  v := case when jsonb_typeof(new.vl) = 'object' then new.vl else '{}'::jsonb end;
  _race  := nullif(lower(btrim(coalesce(v->>'race', ''))), '');
  _div   := nullif(lower(btrim(coalesce(v->>'div', ''))), '');
  _shirt := nullif(upper(btrim(coalesce(v->>'shirt', ''))), '');
  _t5    := nullif(lower(btrim(coalesce(v->>'t5k', ''))), '');
  _team  := nullif(upper(btrim(coalesce(v->>'team', ''))), '');
  _join  := _vl_code_norm(v->>'join');
  _pair  := coalesce(v->>'pair', '') = 'true';
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
  _dbl := coalesce(_race in ('wd', 'md', 'xd'), false);

  -- Staff set what they like; the row only keeps its shape. A team of '*' is a new code.
  if _staff then
    if not _dbl then _team := null; _pair := false;
    elsif _team = '*' then _team := _vl_code_new(new.session_id);
    elsif _join is not null then _team := _join;
    elsif _team is not null then _team := _vl_code_norm(_team);
    end if;
    if _team is not null then _pair := false; end if;
    new.vl := jsonb_strip_nulls(jsonb_build_object('race', _race, 'div', _div, 'shirt', _shirt, 't5k', _t5,
                'team', _team, 'pair', case when _pair then true end));
    return new;
  end if;

  if new.customer_id is null then return new; end if;
  -- leaving the race, finishing it or a no-show is never refused
  if coalesce(new.status, '') in ('cancelled', 'removed', 'noshow', 'done') then
    if v ? 'join' then new.vl := v - 'join'; end if;
    return new;
  end if;
  -- a live row that stays where it is with the same race is not judged again
  if tg_op = 'UPDATE' and old.session_id is not distinct from new.session_id
     and coalesce(old.status, '') not in ('cancelled', 'removed', 'noshow')
     and old.vl is not distinct from new.vl then
    return new;
  end if;

  -- One athlete at a time per account and session: the lock _solo_ride_cap and _run_entry_guard take.
  perform pg_advisory_xact_lock(hashtext('ridecap:' || coalesce(new.session_id, '') || ':' || new.customer_id));

  -- a cancelled Doubles booking taken back rejoins its team, if the team has room
  if _join is null and _dbl and _team is not null and tg_op = 'UPDATE'
     and coalesce(old.status, '') in ('cancelled', 'removed', 'noshow') then
    _join := _team;
  end if;

  select x.name, x.email, x.birth_date, x.gender, x.emergency_name, x.emergency_phone, x.emergency_relation
    into c from customers x where x.id = new.customer_id;
  if not found then
    raise exception 'Athlete details are missing.' using errcode = 'P0001', detail = 'VL_DETAILS';
  end if;

  -- joining a team: its race and division are the team's
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
                 then array(select jsonb_array_elements_text(cfg->'races')) else array['ws', 'ms', 'wd', 'md', 'xd'] end;
  _divs  := case when jsonb_typeof(cfg->'divs') = 'array'
                 then array(select jsonb_array_elements_text(cfg->'divs')) else array['so', 'se', 'op', 'el'] end;
  -- a team already on the books, or a booking keeping its race and division, is not held to what staff
  -- closed since
  if _race is null or (_join is null and not (_race = any(_races))
                       and not (tg_op = 'UPDATE' and old.vl->>'race' is not distinct from _race)) then
    raise exception 'Pick a race.' using errcode = 'P0001', detail = 'VL_RACE';
  end if;
  if _div is null or (_join is null and not (_div = any(_divs))
                      and not (tg_op = 'UPDATE' and old.vl->>'div' is not distinct from _div)) then
    raise exception 'Pick a division.' using errcode = 'P0001', detail = 'VL_DIV';
  end if;
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
  if (_race in ('ws', 'wd') and c.gender <> 'female') or (_race in ('ms', 'md') and c.gender <> 'male') then
    raise exception 'This race is for another gender.' using errcode = 'P0001', detail = 'VL_GENDER';
  end if;
  if nullif(btrim(coalesce(new.data_share_at, '')), '') is null then
    raise exception 'Agree to share your details with Kamin Sports.' using errcode = 'P0001', detail = 'VL_SHARE';
  end if;

  -- one Singles place and one Doubles place at most
  select count(*) into _n from queue_entries q
   where q.session_id = new.session_id and q.customer_id = new.customer_id and q.id <> new.id
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
     and coalesce(q.vl->>'race' in ('wd', 'md', 'xd'), false) = _dbl;
  if _n >= 1 then
    raise exception 'You already have a place in this race.' using errcode = 'P0001', detail = 'VL_ONE_EACH';
  end if;

  if _dbl then
    if _join is null then
      if _team is not null and tg_op = 'UPDATE' then
        -- the division is the team's once a partner is in
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
              'team', _team, 'pair', case when _pair then true end));
  return new;
end $function$;
revoke execute on function public._vl_entry_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_vl_guard on public.queue_entries;
create trigger queue_entries_vl_guard
  before insert or update of status, session_id, vl on public.queue_entries
  for each row execute function public._vl_entry_guard();


/* -- 8. teams for the rider ----------------------------------------------------------------- */
-- What a code names before a rider joins it: the race, the division, the partner's first name, and the
-- gender the team still needs ('' = either). Nothing when there is no such team; is_full = true when the team
-- already has two.
create or replace function public.vl_team_peek(p_id text, p_token text, p_session_id text, p_code text)
 returns table(team text, race text, div text, partner text, need text, is_full boolean)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare _code text := _vl_code_norm(p_code); m record;
begin
  if p_id is null or not _cust_token_ok(p_id, p_token) or _code is null then return; end if;
  select count(*) as n, min(q.vl->>'race') as race, min(q.vl->>'div') as div,
         min(split_part(btrim(coalesce(cx.name, '')), ' ', 1)) as first, min(cx.gender) as gender
    into m
    from queue_entries q join sessions s on s.id = q.session_id
    left join customers cx on cx.id = q.customer_id
   where q.session_id = p_session_id and coalesce(s.ride_kind, '') = 'vlap'
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
revoke all on function public.vl_team_peek(text, text, text, text) from public;
grant execute on function public.vl_team_peek(text, text, text, text) to anon, authenticated;

-- The partner on each of a rider's live Doubles bookings: first name, or none while the team waits.
create or replace function public.customer_vl_teams(p_id text, p_token text)
 returns table(entry_id text, team text, partner text)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if p_id is null or not _cust_token_ok(p_id, p_token) then return; end if;
  return query
    select q.id, q.vl->>'team',
           (select nullif(split_part(btrim(coalesce(cx.name, '')), ' ', 1), '')
              from queue_entries o left join customers cx on cx.id = o.customer_id
             where o.session_id = q.session_id and o.vl->>'team' = q.vl->>'team' and o.id <> q.id
               and coalesce(o.status, '') not in ('cancelled', 'removed', 'noshow')
             order by o.registered_at limit 1)
      from queue_entries q join sessions s on s.id = q.session_id
     where q.customer_id = p_id and coalesce(s.ride_kind, '') = 'vlap' and q.vl->>'team' is not null
       and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
end $function$;
revoke all on function public.customer_vl_teams(text, text) from public;
grant execute on function public.customer_vl_teams(text, text) to anon, authenticated;

-- A rider's own changes to a live Victory Lap booking: the division (Singles, or Doubles while no
-- partner has joined - the guard says VL_TEAM_LOCKED after), the T-shirt size, the 5 km time.
create or replace function public.customer_vl_update(p_id text, p_token text, p_entry_id text, p_patch jsonb)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare q queue_entries%rowtype; v jsonb;
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'patch';
  end if;
  select x.* into q from queue_entries x join sessions s on s.id = x.session_id
   where x.id = p_entry_id and x.customer_id = p_id and coalesce(s.ride_kind, '') = 'vlap'
     and coalesce(x.status, '') in ('waiting', 'waitlist')
     and coalesce(x.session_date, '') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
   for update of x;
  if q.id is null then return false; end if;
  v := coalesce(q.vl, '{}'::jsonb);
  if p_patch ? 'div' then v := v || jsonb_build_object('div', p_patch->>'div'); end if;
  if p_patch ? 'shirt' then v := v || jsonb_build_object('shirt', p_patch->>'shirt'); end if;
  if p_patch ? 't5k' then
    v := case when nullif(p_patch->>'t5k', '') is null then v - 't5k' else v || jsonb_build_object('t5k', p_patch->>'t5k') end;
  end if;
  update queue_entries set vl = v where id = q.id;
  return found;
end $function$;
revoke all on function public.customer_vl_update(text, text, text, jsonb) from public;
grant execute on function public.customer_vl_update(text, text, text, jsonb) to anon, authenticated;

-- The gender a race asks for, saved alone (customer_set_about rewrites profession and workplace too).
create or replace function public.customer_set_gender(p_id text, p_token text, p_gender text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare v text := nullif(lower(btrim(coalesce(p_gender, ''))), '');
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if v is null or v not in ('male', 'female') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'gender';
  end if;
  update customers set gender = v, updated_at = now() where id = p_id;
  return found;
end $function$;
revoke all on function public.customer_set_gender(text, text, text) from public;
grant execute on function public.customer_set_gender(text, text, text) to anon, authenticated;


/* -- 9. the booking window ---------------------------------------------------------------------- */
create or replace function public._booking_window_guard()
returns trigger
language plpgsql set search_path to 'public'
as $$
declare w jsonb; days int; at_t text; sd date; today date; open_day date; now_t text;
begin
  if is_staff() then return new; end if;
  if new.status is distinct from 'waiting' and new.status is distinct from 'waitlist' then return new; end if;
  -- Victory Lap is booked from the day it is announced (20261017210000)
  if exists (select 1 from sessions x where x.id = new.session_id and coalesce(x.ride_kind, '') = 'vlap') then
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
end $$;
revoke all on function public._booking_window_guard() from public, anon, authenticated;


/* -- 10. the finisher's badge --------------------------------------------------------------- */
insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort)
values ('bd_victory_lap', 'victory_lap', 'lapring', 'purple', 'Victory Lap', 'فيكتوري لاب',
        'Finish Victory Lap by Fitness Empire', 'أكمل سباق فيكتوري لاب من فيتنس إمباير', true, true, 93)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true, retired = false,
  sort = excluded.sort;


/* -- checks ------------------------------------------------------------------------------- */
do $chk$
declare f text;
begin
  foreach f in array array['_vlap_holder','vlap_member','_community_booking_gate','customer_booking_update','_tag_one_of_two',
                           'customer_create_booking','customer_accept_share','_vl_code_new','_vl_entry_guard',
                           'vl_team_peek','customer_vl_teams','customer_vl_update','customer_set_gender'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if position('(20261017210000)' in pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure)) = 0
     or position('(20261017210000)' in pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'a 20261017210000 patch did not take';
  end if;
  if not has_function_privilege('anon', 'public.vlap_member(text,text)', 'execute')
     or not has_function_privilege('anon', 'public.vl_team_peek(text,text,text,text)', 'execute')
     or not has_function_privilege('anon', 'public.customer_vl_teams(text,text)', 'execute')
     or not has_function_privilege('anon', 'public.customer_vl_update(text,text,text,jsonb)', 'execute')
     or not has_function_privilege('anon', 'public.customer_set_gender(text,text,text)', 'execute')
     or not has_function_privilege('anon', 'public.customer_accept_share(text,text,text)', 'execute') then
    raise exception 'a client grant is missing';
  end if;
  if has_function_privilege('anon', 'public._vlap_holder(text)', 'execute')
     or has_function_privilege('anon', 'public._vl_entry_guard()', 'execute')
     or has_function_privilege('anon', 'public._vl_code_new(text)', 'execute')
     or has_function_privilege('authenticated', 'public._vl_code_new(text)', 'execute') then
    raise exception 'a server-only function is executable by a client';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'queue_entries_vl_guard'
                   and tgrelid = 'public.queue_entries'::regclass and not tgisinternal) then
    raise exception 'queue_entries_vl_guard is missing';
  end if;
  if not exists (select 1 from public.tags where id = 'tag_vlap' and slug = 'vlap' and locked) then
    raise exception 'tag_vlap is missing';
  end if;
  if not exists (select 1 from public.badges where slug = 'victory_lap' and auto and system and not retired) then
    raise exception 'the victory_lap badge is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261017210000', 'victory_lap')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
