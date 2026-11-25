-- ============================================================================
-- Wednesday Community Ride, a kind of session inside MicroMobility Experiences (the user, 2026-11-25: "create a new
-- session called Wednesday Community Ride, a hybrid between Petromin Wednesday and Saturday Social Ride, starting point
-- is the same as the Saturday social ride but bikes are not complimentary, it is paid the same way Petromin sessions
-- are, community exclusive event, put it under MicroMobility Experiences but don't feature it, no specific distance or
-- route, it starts at 7:00 PM, meeting at 6:30 PM"). Every Wednesday from 2026-11-25; first come first served (no
-- approval); no place limit (500 places); no ride groups, distance or route; Arabic name جولة الأربعاء المجتمعية.
--
-- ride_kind 'wed', event_kind 'community', open_to_all false, paid_ride true, sessions.price null, session id suffix
-- -wc. A bike ride that gathers ("18:30 - 19:00" in bike_slots._time: meet up, then start, as the Saturday ride), at
-- the Saturday ride's meeting point (meet_url). The server learns the kind where it names kinds:
--   1. promo_codes.ride_kind may name it, and _session_kind answers it (20261123150000; it read 'saturday' before).
--   2. _vol_sess_name: a volunteer's certificate names it (20261123150000).
--   3. booking_late: "Running late?" from the meet-up time, the start being the second time, as on the Saturday ride
--      (20261123150000).
--   4. calendar_feed: the kind is its own, not the Saturday ride's (a member's club calendar listed every unknown
--      community kind as a Saturday ride); not featured by default, featured only where staff switch _feat on
--      (20261123150000).
--   5. push_words 'kind:wed': the kind's name in the evening-before reminder, in the eleven languages.
-- Nothing else needs the kind, and nothing is restated for it:
--   - The fare: _fare_now (20261123150000) gives a paid community session that is not an event, a race or the tee
--     painting _booking_fare(entry, 'wed', type) (20261118150000), which finds no rider_registrations row of source
--     'wed' and so answers ride_prices: 57.5 Hybrid / Mountain / Kids, 75 Road, as a Petromin night's website booker
--     pays. The 50 SAR employee fare stays the Petromin form's alone. Own bike: no ride_prices row, as on Petromin.
--     No carbon bike (_comm_no_carbon, as every community kind but Petromin).
--   - The caps: _group_ride_cap (20261114150000) caps a community session without approval at group_ride_max (2) per
--     account, as on a Petromin night; _solo_ride_cap (20261114130000) is for approval rides only.
--   - The waiver: staff_record_waiver (20261123150000) takes the ride waiver (no prefix) on any community kind it does
--     not list, as on the Saturday ride and Petromin.
--   - _updates_key (20261123150000): a ride's words, as for any kind it does not list.
--   - The members gate (_community_booking_gate) holds it to members: open_to_all false.
--   - Capacity: _capacity_guard / _session_has_room count places against sessions.capacity (500); an own bike takes
--     none (only Petromin's do).
-- Functions are restated from their latest text in this folder (the files named above) with the one change; SECURITY
-- DEFINER and the search_path are kept.
--
-- Safe before the app: nothing reads 'wed' until a session of that kind exists, and the sessions are a separate script
-- (supabase/checks/wednesday-community-ride-sessions.sql) run only after the app that knows the kind is live.
-- Undo: delete from public.push_words where key = 'kind:wed'; re-run sections 1, 3, 5 and 6 of
--       20261123150000_tee_painting.sql (the promo constraint, _session_kind, _vol_sess_name, booking_late,
--       calendar_feed).
-- ============================================================================
begin;
set local lock_timeout = '5s';

-- ── 1. Promo codes for the kind, and the kind itself ──────────────────────────
alter table public.promo_codes drop constraint if exists promo_codes_ride_kind_known;
alter table public.promo_codes add constraint promo_codes_ride_kind_known
  check (ride_kind is null or ride_kind in ('jcc','saturday','petromin','swim','workshop','snd96','event','runher','vlap','arena','defe5k','blood','yoga','farm','ktri','paint','wed'));

create or replace function public._session_kind(p_session text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case
           when s.ride_kind = 'snd96' then 'snd96'
           when coalesce(s.event_kind, '') <> 'community' then 'jcc'
           when s.ride_kind in ('event','petromin','swim','workshop','runher','vlap','arena','defe5k','blood','yoga','farm','ktri','paint','wed') then s.ride_kind
           else 'saturday'
         end
    from sessions s where s.id = p_session
$function$;
revoke execute on function public._session_kind(text) from public, anon, authenticated;

-- ── 2. The session's name on a volunteer's certificate ───────────────────────
create or replace function public._vol_sess_name(p_session text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when s.ride_kind in ('saturday', 'petromin', 'swim', 'workshop', 'snd96', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'blood', 'yoga', 'farm', 'ktri', 'paint', 'wed')
              then coalesce(nullif(btrim(s.title), ''),
                            case s.ride_kind when 'saturday' then 'Saturday Social Ride' when 'petromin' then 'Petromin night' /* the user's pick, 2026-11-10 (20261110235400) */
                              when 'swim' then 'Triathlon Pool Session' when 'workshop' then 'T100 Triathlon Prep'
                              when 'snd96' then 'Saudi National Day 96 Ride' when 'event' then 'Event' when 'runher' then 'Run for Her'
                              when 'vlap' then 'Victory Lap' when 'arena' then 'Arena Heros Hybrid Race' when 'defe5k' then 'DEFE 5KM Run'
                              when 'yoga' then 'Hatha Yoga for Cyclists' /* 20261112120000 */
                              when 'farm' then 'Farm House Night' /* 20261114130000 */
                              when 'ktri' then 'KAUST Triathlon' /* 20261122150000 */
                              when 'paint' then 'Tee Painting Workshop' /* 20261123150000 */
                              when 'wed' then 'Wednesday Community Ride' /* 20261125170000 */
                              else 'MicroMobility Blood Donation' end) /* 20261122120000 */
              else 'Jeddah Corniche Circuit' end
    from sessions s where s.id = p_session
$function$;
revoke all on function public._vol_sess_name(text) from public, anon, authenticated;

-- ── 3. "Running late?" from the meet-up time ─────────────────────────────────
create or replace function public.booking_late(p_id text, p_token text, p_session text, p_min integer)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare s sessions%rowtype; v_kind text; v_from timestamptz; v_to timestamptz; v_start timestamptz; v_n int; v_at timestamptz;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if p_min is not null and p_min not in (10, 20, 30) then return jsonb_build_object('ok', false, 'error', 'bad'); end if;
  select * into s from sessions where id = p_session;
  if not found or s.status = 'deleted' or s.cancelled_at is not null or s.ride_status is not distinct from 'cancelled' then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  -- a time to turn up: the kinds that gather (their times are "gathering, then start") and the ones that start together
  v_kind := _session_kind(s.id);
  if coalesce(s.ride_kind, '') = 'testride'
     or v_kind not in ('saturday', 'snd96', 'runher', 'vlap', 'farm', 'wed', 'workshop', 'event', 'yoga', 'defe5k', 'ktri', 'paint') then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  select w.starts_at, w.ends_at into v_from, v_to from _session_window(s) w;
  if v_to < v_from then v_to := v_to + interval '1 day'; end if; -- a session that runs past midnight
  v_start := case when v_kind in ('saturday', 'snd96', 'runher', 'vlap', 'farm', 'wed') then v_to else v_from end;
  if v_from is null or now() < v_from - interval '3 hours' or now() >= v_start + interval '2 hours' then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  -- a party partly (or wholly) checked in is past asking: the desk sees them (review fix)
  if exists (select 1 from queue_entries q where q.session_id = p_session and q.customer_id = p_id and q.status in ('active', 'done')) then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  v_at := case when p_min is null then null else now() end;
  -- the rider's own seated rows, all of them: one answer for the party; a late rider is a coming one
  update queue_entries q
     set late_min = p_min, late_at = v_at,
         coming_at = case when p_min is not null and (q.coming_at is null or q.coming_at < v_from - interval '48 hours')
                          then now() else q.coming_at end
   where q.session_id = p_session and q.customer_id = p_id and q.status = 'waiting'
     and coalesce(q.approval, 'approved') = 'approved';
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('ok', false, 'error', 'none'); end if;
  return jsonb_build_object('ok', true, 'late_min', p_min, 'late_at', v_at, 'n', v_n,
    'coming_at', (select min(q.coming_at) from queue_entries q
                   where q.session_id = p_session and q.customer_id = p_id and q.status = 'waiting' and q.coming_at is not null));
end $function$;

-- ── 4. The club's calendar: the kind is its own, not the Saturday ride's ─────
create or replace function public.calendar_feed(p_key text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  f       calendar_feeds%rowtype;
  v       jsonb;
  vc      jsonb := '[]'::jsonb;
  v_from  text := to_char((now() at time zone 'Asia/Riyadh')::date - 1, 'YYYY-MM-DD');
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
  v_cid   text;
  v_g     text;
  v_mem   boolean;
begin
  -- A key nobody holds answers exactly as a rider with no bookings does.
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', true, 'items', '[]'::jsonb);
  end if;
  select c.* into f from calendar_feeds c where c.feed_key = p_key;
  if not found then
    return jsonb_build_object('ok', true, 'items', '[]'::jsonb);
  end if;
  -- The address's own meter: 60 reads in an hour, then nothing more until the hour is out. Kept on the row, so the
  -- key is never an identifier in a log or throttle table.
  if f.hits_from is null or f.hits_from < now() - interval '1 hour' then
    update calendar_feeds c set hits = 1, hits_from = now(), read_at = now() where c.customer_id = f.customer_id;
  elsif f.hits >= 60 then
    return jsonb_build_object('ok', false, 'error', 'busy');
  else
    update calendar_feeds c set hits = c.hits + 1, read_at = now() where c.customer_id = f.customer_id;
  end if;
  -- One row per session the rider still holds a place on. to_jsonb reads the columns later migrations added
  -- (title_ar, archived_at), so a database without one of them answers null for it instead of failing.
  select coalesce(jsonb_agg(t.x order by t.x->>'date', t.x->>'time', t.x->>'id'), '[]'::jsonb) into v from (
    select distinct on (s.id) jsonb_build_object(
             'id', q.id,
             'date', s.session_date,
             'time', substring(coalesce(s.bike_slots, '') from '"_time"\s*:\s*"([^"]*)"'),
             'ek', a.sj->>'event_kind',
             'rk', a.sj->>'ride_kind',
             'appr', a.sj->'needs_approval',
             'title', nullif(btrim(a.sj->>'title'), ''),
             'title_ar', nullif(btrim(a.sj->>'title_ar'), ''),
             'meet', nullif(btrim(a.sj->>'meet_url'), ''),
             -- the breakfast spot's location stays unsaid until staff's time; the meeting point shows at once
             'loc', case when b.held then null else nullif(btrim(s.location), '') end,
             'held', b.held) as x
      from queue_entries q
      join sessions s on s.id = q.session_id
      cross join lateral (select to_jsonb(s) as sj) a
      cross join lateral (select (s.reveal_at is not null and s.reveal_at > now()) as held) b
     where q.customer_id = f.customer_id
       and q.status in ('waiting', 'active')
       and s.session_date >= v_from
       and exists (select 1 from customers cu where cu.id = f.customer_id and (to_jsonb(cu)->>'archived_at') is null)
     order by s.id, q.queue_num, q.id
     limit 100
  ) t;
  -- The club's sessions (20261118211000), only when the rider turned them on: the Saturday rides for a member and the
  -- featured dates, as the app shows them to this rider, less what they hold. No breakfast spot ever; while the spot is
  -- held (reveal_at ahead) no place and no meeting point either.
  if f.club then
    select cu.id, cu.gender, coalesce(_member_active(cu.id), false) into v_cid, v_g, v_mem
      from customers cu where cu.id = f.customer_id and (to_jsonb(cu)->>'archived_at') is null;
    if v_cid is not null then
      select coalesce(jsonb_agg(t.x order by t.x->>'date', t.x->>'time', t.x->>'id'), '[]'::jsonb) into vc from (
        select jsonb_build_object(
                 'id', s.id,
                 'club', true,
                 'date', s.session_date,
                 'time', substring(coalesce(s.bike_slots, '') from '"_time"\s*:\s*"([^"]*)"'),
                 'ek', a.sj->>'event_kind',
                 'rk', a.sj->>'ride_kind',
                 'appr', a.sj->'needs_approval',
                 'title', nullif(btrim(a.sj->>'title'), ''),
                 'title_ar', nullif(btrim(a.sj->>'title_ar'), ''),
                 'meet', case when b.held then null else nullif(btrim(a.sj->>'meet_url'), '') end,
                 'loc', case when b.held then null else nullif(btrim(s.location), '') end,
                 'held', b.held) as x
          from sessions s
          cross join lateral (select to_jsonb(s) as sj) a
          cross join lateral (select (s.reveal_at is not null and s.reveal_at > now()) as held,
                                     (coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') <> 'snd96') as comm,
                                     substring(coalesce(s.bike_slots, '') from '"_feat"\s*:\s*("[^"]*"|[^,}\s]+)') as feat,
                                     substring(coalesce(s.bike_slots, '') from '"_fbk"\s*:\s*("[^"]*"|[^,}\s]+)') as fbk) b
          -- the app's _rideKind: a community session by its kind (a Saturday ride when it names none), anything else the circuit
          cross join lateral (select case when not b.comm then 'jcc'
                                          when s.ride_kind in ('petromin', 'swim', 'workshop', 'runher', 'vlap', 'arena', 'defe5k',
                                                               'blood', 'yoga', 'farm', 'event', 'ktri', 'paint', 'wed') then s.ride_kind
                                          else 'saturday' end as kind) k
         where s.session_date >= to_char(v_today, 'YYYY-MM-DD')
           and s.session_date <= to_char(v_today + 60, 'YYYY-MM-DD')
           -- shown to riders: live, or closed as Full, no waitlist (_sessShown)
           and (s.status in ('open', 'full')
                or (s.status = 'closed' and b.fbk is not null and b.fbk not in ('0', 'false', 'null', '""')
                    and (a.sj->>'cancelled_at') is null and coalesce((a.sj->>'draft')::boolean, false) = false
                    and (a.sj->>'opens_at') is null))
           -- a private event only to a holder of its tag (list_sessions)
           and (s.required_tag_id is null
                or exists (select 1 from customer_tags ct where ct.customer_id = v_cid and ct.tag_id = s.required_tag_id
                             and _ctag_active(ct.starts_at, ct.expires_at)))
           -- men only or women only: that gender alone
           and (a.sj->>'gender_only' is null or a.sj->>'gender_only' = v_g)
           -- the members' gate of a community session
           and (not b.comm or coalesce((a.sj->>'open_to_all')::boolean, false) or v_mem)
           -- (a) the Saturday ride for a member, (b) a featured date (_featured)
           and ((k.kind = 'saturday' and v_mem)
                or (k.kind in ('saturday', 'petromin', 'swim', 'defe5k', 'yoga', 'farm', 'ktri', 'paint', 'wed')
                    and case when b.feat is null or b.feat = 'null' then k.kind in ('yoga', 'defe5k', 'farm', 'ktri', 'paint')
                             else b.feat not in ('0', 'false', '""') end))
           -- what the rider holds is in the feed already, as their booking
           and not exists (select 1 from queue_entries q where q.session_id = s.id and q.customer_id = v_cid
                              and q.status in ('waiting', 'active'))
         order by s.session_date, s.id
         limit 60
      ) t;
    end if;
  end if;
  v := v || vc;
  -- Nothing ahead: the same answer a key nobody holds gets, without the language.
  if v = '[]'::jsonb then return jsonb_build_object('ok', true, 'items', v); end if;
  return jsonb_build_object('ok', true, 'lang', f.lang, 'items', v);
end $function$;

-- ── 5. The kind's name for the evening-before reminder ───────────────────────
insert into public.push_words (key, lang, title, body) values
  ('kind:wed', 'en', 'Wednesday Community Ride', ''),             ('kind:wed', 'ar', 'جولة الأربعاء المجتمعية', ''),
  ('kind:wed', 'fr', 'Sortie communautaire du mercredi', ''),     ('kind:wed', 'es', 'Recorrido comunitario del miércoles', ''),
  ('kind:wed', 'pt', 'Passeio comunitário de quarta-feira', ''),  ('kind:wed', 'ur', 'بدھ کی کمیونٹی رائیڈ', ''),
  ('kind:wed', 'hi', 'बुधवार कम्युनिटी राइड', ''),                  ('kind:wed', 'tl', 'Community Ride tuwing Miyerkules', ''),
  ('kind:wed', 'ne', 'बुधबार सामुदायिक राइड', ''),                  ('kind:wed', 'bn', 'বুধবারের কমিউনিটি রাইড', ''),
  ('kind:wed', 'ms', 'Kayuhan Komuniti Rabu', '')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- ── checks ─────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['_session_kind','_vol_sess_name','booking_late','calendar_feed'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f
                     and p.prosrc like '%''wed''%') then
      raise exception '% does not know the wed kind', f;
    end if;
  end loop;
  if (select count(*) from public.push_words where key = 'kind:wed') <> 11 then
    raise exception 'the kind:wed push words are not all there';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261125170000', 'wednesday_community_ride')
on conflict (version) do nothing;

notify pgrst, 'reload schema';
commit;
