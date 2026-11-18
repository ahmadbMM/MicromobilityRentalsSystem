-- ============================================================================
-- Bug hunt 2026-11-18, round 2, package r2a: the server halves round 1 left (the website's Members area, /club,
-- Ask, the Farmhouse and Saturday pages, the volunteer portal, the Petromin form, the community form's status page,
-- the job form). For production and staging. Contracts C1-C4 of the round-2 brief are kept exactly.
--
--  1. member_area (web-lib3-1): 'last' took the five newest done bookings of any kind and the website then dropped
--     the Blood Donation event, so the card could show four rides. The donation is left out before the limit.
--     (web-components6-1: 'booked' / 'waitlist' were split by 20261119000200; the rebuild keeps that.)
--  2. club_rides (web-components6-4): the limit of 6 was taken before /club dropped blood and farm sessions, so the
--     public list could show two or three rides, or none. They are left out on the server, before the limit.
--  3. Ask (web-lib0-1): a quiz answer's points reached the browser before staff revealed the question: ask_send's
--     'score', _ask_mine's 'score' (ask_page 'mine', ask_send 'mine') and ask_page's 'me' total and rank over
--     unrevealed questions, and _ask_result's quiz_text 'right' count (one more right after a send says it was
--     right). Each is now sent only for a revealed question (staff results keep everything: p_staff).
--     _ask_result (web-components4-2, 4-3; contract C1): the pin branch adds 'cells', 80 integers (10 columns x 8
--     rows, row by row from the top left; cell = least(7, floor(y*8))*10 + least(9, floor(x*10))) over every
--     approved answer of the round ('pins' stays the newest 400); the open/qa branch adds 'recent', the newest 50
--     approved answers in the items' own shape {id, t, v[, a]}, newest first. Clients use them when present.
--  4. farm_night, farm_book (form-farmhouse-0-2): Full, no waitlist (bike_slots._fbk) read 'over' / 'session', so
--     the page said Bookings closed. The end of the night is tested first ('over' / 'session'); then _fbk reads
--     'full', which the page shows as Fully booked.
--  5. saturday_rides (form-saturday-0-5): a ride marked Full, no waitlist (closed + _fbk, no opening timer, not a
--     draft) was left out, so /saturday said no ride was open. It is listed (code_open false); the page shows it as
--     Fully booked (mm-platform 3f0a17cd). saturday_book (form-saturday-0-2): the rider's own live booking on the
--     ride is answered ONE_PER_SESSION (the page's 'already booked') before the code's places are counted, which
--     answered CODE_USED_UP after a lost answer or on a one-place code.
--  6. volunteer_find (volunteers2-1; contract C2): a row found by search or scan now carries the caps-gated phone
--     and details exactly as volunteer_list's rows do ('visitor' was already patched in by 20261105140000 and is
--     kept). volunteer_donated refuses a visitor with BLOOD_VISITOR itself (_blood_donated_apply already did since
--     20261105140000). volunteer_counts (volunteers2-2, new): {booked, in, donated, visitors} over every booking
--     of the session (volunteer_list stops at 1,000 rows), behind volunteer_list's gate (the 'list' cap).
--  7. rider_registrations.moved_from_no / moved_from_session (new, nullable), staff_rider_party_move, rider_lookup,
--     rider_edit, _rider_moved (new helper) (forms-js2-2; contract C3): a party the desk moved to another night
--     got a new number there, and the phone's old number answered notfound. The move now keeps the number and night
--     it left on the moved rows; asked for that number on that night with the lead rider's phone, rider_lookup and
--     rider_edit answer {ok:false, error:'moved', booking_no, session_id, session_date} instead of notfound. Only
--     the last move is kept (a party moved twice answers for the night it left last).
--  8. community_track (form-community-1-2; contract C4): the 'fix' object, with the token that opens the
--     applicant's details for editing, went to anyone holding the status address (kept on a shared phone). It is
--     now sent only when the call carries the application's own account and its session (p_cid, p_ctoken, new
--     optional arguments; the old one-argument function is dropped, grants as before). Everything else is unchanged.
--  9. site_message_send (web-components9-1): a message with the same text from the same contact within 10 minutes
--     was a repeat whatever its topic, so an application for a second role came back as the first one's reference
--     and was never stored. The topic is compared too.
--
-- Not changed: web-components8-1 (customer_learn_apply). The live function already takes the height the form sends
-- when the stored one is outside 80-250 (patched in place by 20261110235400, which the extract the hunt read did not
-- show), and customers.gender only holds male, female or null (customers_gender_known, validated), so the gender
-- half cannot occur. The check block below asserts the 20261110235400 change is live.
--
-- Where each rebuilt function comes from (the newest full text, every earlier change kept):
--   member_area, farm_night, farm_book   20261119000200_bh18_db2.sql
--   club_rides                           20261028100000_session_gender_visible.sql
--   _ask_mine, ask_page, _ask_result     20261113010000_ask.sql (no later change)
--   saturday_rides, saturday_book        20261108120000_saturday_codes.sql (no later change)
--   volunteer_find                       20261105120000_volunteers.sql + 20261105140000's in-place 'visitor' line
--   volunteer_donated                    20261105120000_volunteers.sql
--   rider_lookup                         20261111235300_bh11_live_c.sql
--   community_track                      20261025210000_application_track_and_changes.sql + 20261110235400's
--                                        in-place 'pending' test
--   site_message_send                    20260924235000_site_messages_jobs.sql
-- Patched in place from their live text (pg_get_functiondef; each anchor found exactly once; header, SECURITY
-- DEFINER, search_path and grants stay): ask_send (patched in place by 20261114210000), rider_edit (by 20261112210000
-- and 20261114030000), staff_rider_party_move (by 20261110235300, 20261112210000, 20261114030000). Every changed
-- function carries '(20261119000600)'. None of them is on the Community features round's list.
--
-- Rollback: re-run each rebuilt function from the file named above (community_track: drop the three-argument one,
-- re-run 20261025210000's and 20261110235400's patch); run each in-place patch backwards (the new text back to its
-- anchor); drop function public.volunteer_counts(text,text,text) and public._rider_moved(text,text,text). The two
-- new columns are harmless left in place.
-- Idempotent: full functions are CREATE OR REPLACE, the in-place patches are skipped once their function carries
-- '(20261119000600)', the columns are added if missing. Run supabase/checks/security-attributes.sql after.
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

-- ── 1. member_area (web-lib3-1; web-components6-1 is 20261119000200's waitlist flag, kept) ─────────────────────
create or replace function public.member_area(p_id text, p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  c customers%rowtype; v_since bigint; v_spend numeric; v_group int; v_rated int; v_rides int; v_credits int; v_tier int;
  v_pro numeric := _site_num('club.rules.proAt', 150); v_leg numeric := _site_num('club.rules.legendAt', 500);
  v_last jsonb; v_next jsonb; v_ann jsonb; v_today text := to_char((now() at time zone 'Asia/Riyadh')::date, 'YYYY-MM-DD');
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select * into c from customers where id = p_id;
  select ct.added_at into v_since from customer_tags ct
   where ct.customer_id = p_id and ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at) limit 1;
  if not found then return jsonb_build_object('ok', true, 'member', false, 'first_name', split_part(coalesce(c.name,''), ' ', 1)); end if;
  select coalesce(sum(q.price) filter (where q.status = 'done' and q.paid), 0),
         count(*) filter (where q.status = 'done' and s.event_kind = 'community'),
         count(*) filter (where q.status = 'done' and (q.rating_exp is not null or q.rating_bike is not null)),
         count(*) filter (where q.status = 'done')
    into v_spend, v_group, v_rated, v_rides
    from queue_entries q left join sessions s on s.id = q.session_id where q.customer_id = p_id;
  v_credits := floor(v_spend / 10 * _site_num('club.rules.perTen', 1))::int + (v_group * _site_num('club.rules.groupRidePts', 200))::int + (v_rated * _site_num('club.rules.reviewPts', 50))::int;
  v_tier := case when v_credits >= v_leg then 2 when v_credits >= v_pro then 1 else 0 end;
  select coalesce(jsonb_agg(x order by x->>'date' desc), '[]'::jsonb) into v_last from (
    select jsonb_build_object('date', q.session_date, 'title', coalesce(nullif(btrim(s.title), ''), ''), 'kind', s.ride_kind, 'rated', (q.rating_exp is not null or q.rating_bike is not null)) as x
      from queue_entries q left join sessions s on s.id = q.session_id
     where q.customer_id = p_id and q.status = 'done'
       -- the Blood Donation event is no ride: left out before the five are counted, not after (bug hunt 2026-11-18,
       -- web-lib3-1) (20261119000600)
       and coalesce(s.ride_kind, '') <> 'blood'
     order by q.session_date desc limit 5) t;
  select coalesce(jsonb_agg(x order by x->>'date', x->>'time'), '[]'::jsonb) into v_next from (
    select jsonb_build_object('id', s.id, 'date', s.session_date, 'title', coalesce(nullif(btrim(s.title), ''), ''), 'kind', s.ride_kind,
             'time', substring(coalesce(s.bike_slots, '') from '"_time"\s*:\s*"([^"]*)"'),
             -- a place held; a booking only on the waitlist is told apart, never with its place in the line, as the
             -- booking app tells them apart (bug hunt 2026-11-18, sql08-2) (20261119000200)
             'booked', exists (select 1 from queue_entries q where q.session_id = s.id and q.customer_id = p_id and q.status in ('waiting','active')),
             'waitlist', exists (select 1 from queue_entries q where q.session_id = s.id and q.customer_id = p_id and q.status = 'waitlist')
                         and not exists (select 1 from queue_entries q where q.session_id = s.id and q.customer_id = p_id and q.status in ('waiting','active'))) as x
      from sessions s
     where s.event_kind = 'community' and s.status in ('open','full') and coalesce(s.ride_kind, '') <> 'petromin'
       -- a private (tag-gated) ride only to an account holding its tag or a booking on it, as
       -- list_sessions shows them (20261007120000)
       and (s.required_tag_id is null
            or exists (select 1 from customer_tags ct
                        where ct.customer_id = p_id and ct.tag_id = s.required_tag_id
                          and _ctag_active(ct.starts_at, ct.expires_at))
            or exists (select 1 from queue_entries q2
                        where q2.session_id = s.id and q2.customer_id = p_id
                          and q2.status in ('waiting','waitlist','active','done')))
       and s.session_date >= v_today order by s.session_date limit 8) t;
  select value into v_ann from site_content where key = 'site.announce.messages';
  return jsonb_build_object('ok', true, 'member', true, 'first_name', split_part(coalesce(c.name,''), ' ', 1),
    'since', case when v_since is not null then to_timestamp(v_since / 1000.0) end,
    'credits', v_credits, 'tier', v_tier, 'next', case v_tier when 0 then v_pro when 1 then v_leg end,
    'rides', v_rides, 'group_rides', v_group, 'last', v_last, 'upcoming', v_next,
    'birth_date', c.birth_date, 'announcements', coalesce(v_ann, '[]'::jsonb));
end $function$;
revoke all on function public.member_area(text, text) from public;
grant execute on function public.member_area(text, text) to anon, authenticated;

-- ── 2. club_rides (web-components6-4) ───────────────────────────────────────────────────────────────────────────
create or replace function public.club_rides()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v jsonb;
begin
  if not _ip_gate('clubrides', 60, interval '10 minutes') then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(x order by x->>'date', x->>'time'), '[]'::jsonb) into v from (
    select jsonb_build_object('title', coalesce(nullif(btrim(s.title), ''), ''), 'date', s.session_date,
             'time', substring(coalesce(s.bike_slots, '') from '"_time"\s*:\s*"([^"]*)"'), 'kind', s.ride_kind) as x
      from sessions s
     -- the Blood Donation event and the Farm House nights are not listed on /club: left out before the six are
     -- counted, not after (bug hunt 2026-11-18, web-components6-4) (20261119000600)
     where s.event_kind = 'community' and s.status = 'open' and coalesce(s.ride_kind, '') not in ('petromin', 'blood', 'farm')
       and s.required_tag_id is null   -- a private event is listed only to its members (list_sessions)
       and s.session_date >= to_char((now() at time zone 'Asia/Riyadh')::date, 'YYYY-MM-DD')
     order by s.session_date
     limit 6) t;
  return v;
end $function$;
revoke all on function public.club_rides() from public;
grant execute on function public.club_rides() to anon, authenticated;

-- ── 3. Ask (web-lib0-1; web-components4-2, 4-3: contract C1) ──────────────────────────────────────────────────
create or replace function public._ask_mine(p_question bigint, p_round integer, p_cust text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  -- a quiz answer's points (right or wrong) stay back until staff reveal the question (bug hunt 2026-11-18,
  -- web-lib0-1) (20261119000600)
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'value', a.value, 'body', a.body, 'status', a.status,
           'answered', a.answered, 'score', case when q.reveal then a.score end, 'created_at', a.created_at,
           'votes', (select count(*) from ask_votes v where v.answer_id = a.id)::integer) order by a.id desc), '[]'::jsonb)
    from ask_answers a join ask_questions q on q.id = a.question_id
   where a.question_id = p_question and a.round = p_round and a.customer_id = p_cust
$function$;
revoke all on function public._ask_mine(bigint, integer, text) from public, anon, authenticated;

create or replace function public.ask_page(p_slug text, p_id text default null, p_token text default null, p_key text default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  p ask_pages%rowtype; v_state text; v_preview boolean;
  v_cust text := case when p_id is not null and p_token is not null and _cust_token_ok(p_id, p_token) then p_id end;
  v_brief jsonb; v_mine jsonb; v_me jsonb;
begin
  select * into p from ask_pages where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then return jsonb_build_object('state', 'none'); end if;
  -- staff look at a page before it opens with its screen key: nothing can be answered that way
  v_preview := _ask_key_ok(p.id, p_key) is not distinct from 'screen';
  v_state := _ask_state(p);
  v_brief := jsonb_build_object('slug', p.slug, 'title_en', p.title_en, 'title_ar', p.title_ar);
  if not v_preview then
    if v_state = 'none' then return jsonb_build_object('state', 'none'); end if;
    -- a page for accounts says nothing of itself, not even its title, to a visitor who is not signed in
    if p.audience <> 'link' and v_cust is null then return jsonb_build_object('state', 'signin'); end if;
    if not _ask_sees(p, v_cust) then return jsonb_build_object('state', 'audience'); end if;
    if v_state = 'soon' then return jsonb_build_object('state', 'soon', 'page', v_brief || jsonb_build_object('opens_at', p.opens_at)); end if;
    if v_state = 'closed' and p.after_close = 'hidden' then return jsonb_build_object('state', 'closed', 'page', v_brief); end if;
  end if;

  select coalesce(jsonb_object_agg(q.id::text, _ask_mine(q.id, p.round, v_cust)), '{}'::jsonb) into v_mine
    from ask_questions q
   where v_cust is not null and q.page_id = p.id
     and exists (select 1 from ask_answers a where a.question_id = q.id and a.round = p.round and a.customer_id = v_cust);

  if v_cust is not null and exists (select 1 from ask_questions q where q.page_id = p.id and q.kind in ('quiz', 'quiz_text')) then
    with tot as (select a.customer_id, sum(coalesce(a.score, 0))::integer as score
                   from ask_answers a join ask_questions q on q.id = a.question_id
                  where a.page_id = p.id and a.round = p.round and q.kind in ('quiz', 'quiz_text')
                    -- only the questions staff have revealed: a total that moves says whether an answer was right
                    -- (bug hunt 2026-11-18, web-lib0-1) (20261119000600)
                    and q.reveal
                  group by a.customer_id)
    select jsonb_build_object('score', t.score, 'rank', 1 + (select count(*) from tot o where o.score > t.score), 'players', (select count(*) from tot))
      into v_me from tot t where t.customer_id = v_cust;
  end if;

  return jsonb_build_object(
    'state', case when v_preview and v_state in ('none', 'soon') then 'ok' else v_state end,
    'preview', v_preview,
    'signed', v_cust is not null,
    'can_answer', v_cust is not null and v_state = 'ok' and not v_preview,
    'now', now(),
    'rk', _ask_key(p.id, 'rk', floor(extract(epoch from now()) / 21600)::bigint),
    'page', _ask_public_page(p),
    'questions', _ask_public_qs(p),
    'mine', v_mine,
    'voted', coalesce((select jsonb_agg(v.answer_id) from ask_votes v join ask_answers a on a.id = v.answer_id
                        where v_cust is not null and v.customer_id = v_cust and a.page_id = p.id and a.round = p.round), '[]'::jsonb),
    'reacted', coalesce((select jsonb_object_agg(x.qid, x.kinds) from (select r.question_id::text as qid, jsonb_agg(r.kind) as kinds
                           from ask_reactions r join ask_questions q on q.id = r.question_id
                          where v_cust is not null and r.customer_id = v_cust and q.page_id = p.id and r.round = p.round
                          group by r.question_id) x), '{}'::jsonb),
    'me', v_me,
    'live', _ask_live(p));
end $function$;
revoke all on function public.ask_page(text, text, text, text) from public;
grant execute on function public.ask_page(text, text, text, text) to anon, authenticated;

create or replace function public._ask_result(q public.ask_questions, p_round integer, p_staff boolean, p_only text[])
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  r jsonb; c jsonb := q.config; v_n integer; v_min numeric; v_max numeric; v_show boolean := p_staff or q.reveal;
begin
  if q.kind = 'info' then return null; end if;
  select count(*) into v_n from _ask_rows(q.id, p_round, p_only) a where true;

  if q.kind = 'cloud' then
    select jsonb_build_object('n', v_n,
             'people', (select count(distinct a.customer_id) from _ask_rows(q.id, p_round, p_only) a where true),
             'words', coalesce(jsonb_agg(jsonb_build_object('w', g.w, 'n', g.n) order by g.n desc, g.last desc), '[]'::jsonb))
      into r
      from (select mode() within group (order by a.body) as w, count(*)::integer as n, max(a.id) as last
              from _ask_rows(q.id, p_round, p_only) a
             where true and coalesce(a.norm, '') <> ''
             group by a.norm order by count(*) desc, max(a.id) desc limit 150) g;

  elsif q.kind in ('open', 'qa') then
    select jsonb_build_object('n', v_n, 'items', coalesce(jsonb_agg(
             case when q.kind = 'qa' then jsonb_build_object('id', x.id, 't', x.body, 'v', x.v, 'a', x.answered)
                  else jsonb_build_object('id', x.id, 't', x.body, 'v', x.v) end
             order by (q.kind = 'qa' and x.answered), x.v desc, x.id desc), '[]'::jsonb))
      into r
      from (select a.id, a.body, a.answered, (select count(*) from ask_votes v where v.answer_id = a.id)::integer as v
              from _ask_rows(q.id, p_round, p_only) a
             where true
             order by (q.kind = 'qa' and a.answered), 4 desc, a.id desc limit 100) x;
    /* and the newest 50, newest first, in the same shape: the 100 above are the most voted, so a new answer with no
       vote could be left out of the newest-first stream (bug hunt 2026-11-18, web-components4-3) (20261119000600) */
    r := r || jsonb_build_object('recent', coalesce((
      select jsonb_agg(case when q.kind = 'qa' then jsonb_build_object('id', x.id, 't', x.body, 'v', x.v, 'a', x.answered)
                            else jsonb_build_object('id', x.id, 't', x.body, 'v', x.v) end
                       order by x.id desc)
        from (select a.id, a.body, a.answered, (select count(*) from ask_votes v where v.answer_id = a.id)::integer as v
                from _ask_rows(q.id, p_round, p_only) a
               order by a.id desc limit 50) x), '[]'::jsonb));

  elsif q.kind in ('choice', 'quiz') then
    select jsonb_build_object('n', v_n, 'counts', coalesce(jsonb_object_agg(o.id,
             (select count(*) from _ask_rows(q.id, p_round, p_only) a where true and a.value->'o' ? o.id)::integer), '{}'::jsonb))
      into r from unnest(_ask_ids(c->'options')) o(id);
    if v_show and c ? 'correct' then r := r || jsonb_build_object('correct', c->'correct'); end if;

  elsif q.kind = 'scales' then
    v_min := _ask_int(c, 'min', 1); v_max := _ask_int(c, 'max', 5);
    select jsonb_build_object('n', v_n,
             'avg', coalesce(jsonb_object_agg(o.id, (select _ask_n(avg((a.value->'s'->>o.id)::numeric), 2) from _ask_rows(q.id, p_round, p_only) a
                      where true and a.value->'s' ? o.id)), '{}'::jsonb),
             'dist', coalesce(jsonb_object_agg(o.id, (select jsonb_agg((select count(*) from _ask_rows(q.id, p_round, p_only) a
                      where true and (a.value->'s'->>o.id)::numeric = g.x)::integer order by g.x)
                      from generate_series(v_min::integer, v_max::integer) g(x))), '{}'::jsonb))
      into r from unnest(_ask_ids(c->'options')) o(id);

  elsif q.kind = 'ranking' then
    with pl as (select e.id, e.ord::integer as ord, jsonb_array_length(a.value->'r') as k
                  from _ask_rows(q.id, p_round, p_only) a cross join lateral jsonb_array_elements_text(a.value->'r') with ordinality e(id, ord))
    select jsonb_build_object('n', v_n,
             'score', coalesce((select jsonb_object_agg(s.id, s.pts) from (select id, sum(k - ord + 1)::integer as pts from pl group by id) s), '{}'::jsonb),
             'pos', coalesce((select jsonb_object_agg(s.id, s.p) from (select id, _ask_n(avg(ord), 2) as p from pl group by id) s), '{}'::jsonb))
      into r;

  elsif q.kind = 'points' then
    with kv as (select e.key as id, (e.value #>> '{}')::numeric as v
                  from _ask_rows(q.id, p_round, p_only) a cross join lateral jsonb_each(a.value->'p') e)
    select jsonb_build_object('n', v_n,
             'sum', coalesce((select jsonb_object_agg(s.id, s.t) from (select id, sum(v)::integer as t from kv group by id) s), '{}'::jsonb),
             'avg', coalesce((select jsonb_object_agg(s.id, s.m) from (select id, _ask_n(sum(v) / greatest(v_n, 1), 1) as m from kv group by id) s), '{}'::jsonb))
      into r;

  elsif q.kind = 'grid' then
    with kv as (select e.key as id, (e.value->>0)::numeric as x, (e.value->>1)::numeric as y
                  from _ask_rows(q.id, p_round, p_only) a cross join lateral jsonb_each(a.value->'g') e)
    select jsonb_build_object('n', v_n,
             'pts', coalesce((select jsonb_object_agg(s.id, jsonb_build_array(s.x, s.y)) from (select id, _ask_n(avg(x), 2) as x, _ask_n(avg(y), 2) as y from kv group by id) s), '{}'::jsonb))
      into r;

  elsif q.kind = 'number' then
    v_min := coalesce((c->>'min')::numeric, 0); v_max := coalesce((c->>'max')::numeric, 100);
    with vals as (select (a.value->>'n')::numeric as v from _ask_rows(q.id, p_round, p_only) a)
    select jsonb_build_object('n', v_n, 'avg', (select _ask_n(avg(v), 2) from vals), 'min', (select _ask_n(min(v), 4) from vals), 'max', (select _ask_n(max(v), 4) from vals),
             'bins', (select jsonb_agg(jsonb_build_object('lo', _ask_n(v_min + (v_max - v_min) * g.i / 10, 4), 'hi', _ask_n(v_min + (v_max - v_min) * (g.i + 1) / 10, 4),
                        'n', (select count(*) from vals where least(9, floor((v - v_min) * 10 / (v_max - v_min))) = g.i)::integer) order by g.i)
                        from generate_series(0, 9) g(i)))
      into r;
    if v_show and jsonb_typeof(c->'correct') = 'number' then r := r || jsonb_build_object('correct', c->'correct'); end if;

  elsif q.kind = 'pin' then
    select jsonb_build_object('n', v_n, 'pins', coalesce(jsonb_agg(jsonb_build_array(_ask_n((x.value->>'x')::numeric, 3), _ask_n((x.value->>'y')::numeric, 3)) order by x.id desc), '[]'::jsonb))
      into r
      from (select a.id, a.value from _ask_rows(q.id, p_round, p_only) a where true order by a.id desc limit 400) x;
    /* every answer of the round in 10 columns by 8 rows, row by row from the top left, for the heat view: the pins
       above are only the newest 400 (bug hunt 2026-11-18, web-components4-2) (20261119000600) */
    r := r || jsonb_build_object('cells', (
      select jsonb_agg(coalesce(k.n, 0) order by g.i)
        from generate_series(0, 79) g(i)
        left join (select least(7, greatest(0, floor((a.value->>'y')::numeric * 8)))::integer * 10
                            + least(9, greatest(0, floor((a.value->>'x')::numeric * 10)))::integer as i,
                          count(*)::integer as n
                     from _ask_rows(q.id, p_round, p_only) a
                    where jsonb_typeof(a.value->'x') = 'number' and jsonb_typeof(a.value->'y') = 'number'
                    group by 1) k on k.i = g.i));
    if v_show and jsonb_typeof(c->'correct') = 'object' then r := r || jsonb_build_object('correct', c->'correct'); end if;

  elsif q.kind = 'quiz_text' then
    -- how many got it right tells a rider whether the answer they just sent was: kept back until staff reveal the
    -- question, as the accepted answers are (bug hunt 2026-11-18, web-lib0-1) (20261119000600)
    r := jsonb_build_object('n', v_n);
    if v_show then
      r := r || jsonb_build_object('right', (select count(*) from _ask_rows(q.id, p_round, p_only) a
                                              where coalesce(a.score, 0) > 0)::integer,
                                   'correct', c->'accept');
    end if;
    -- what people typed is free text nobody approved: staff only
    if p_staff then
      r := r || jsonb_build_object('top', coalesce((select jsonb_agg(jsonb_build_object('w', g.w, 'n', g.n) order by g.n desc)
                 from (select mode() within group (order by a.body) as w, count(*)::integer as n from _ask_rows(q.id, p_round, p_only) a
                        where coalesce(a.norm, '') <> ''
                        group by a.norm order by count(*) desc limit 20) g), '[]'::jsonb));
    end if;

  else  -- form
    r := jsonb_build_object('n', v_n);
  end if;
  return r;
end $function$;
revoke all on function public._ask_result(public.ask_questions, integer, boolean, text[]) from public, anon, authenticated;

-- ask_send: patched in place (20261114210000 patched its length line in place; a full copy would drop it).
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.ask_send(bigint,text,text,jsonb,text)'::regprocedure);
  if position('(20261119000600)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$  return jsonb_build_object('ok', true, 'status', v_status, 'score', v_score, 'mine', _ask_mine(q.id, p.round, p_id));$a$,
$b$  -- a quiz answer's points (right or wrong) stay back until staff reveal the question (bug hunt 2026-11-18, web-lib0-1)
  -- (20261119000600)
  return jsonb_build_object('ok', true, 'status', v_status, 'score', case when q.reveal then v_score end,
           'mine', _ask_mine(q.id, p.round, p_id));$b$);
  execute d;
end $do$;

-- ── 4. farm_night, farm_book (form-farmhouse-0-2) ───────────────────────────────────────────────────────────────
create or replace function public.farm_night(p_code text, p_id text default null, p_token text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_code text := btrim(coalesce(p_code, ''));
  v_today text := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  v_mine boolean; v_canon text; v_out jsonb := '[]'::jsonb;
  v_s sessions%rowtype; v_slots jsonb; v_ends timestamptz; v_live int; v_state text; v_held jsonb;
begin
  if _farmcode_locked() then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if v_code = '' then return jsonb_build_object('ok', false, 'error', 'code'); end if;
  if v_code ~ '^[A-Za-z0-9_-]{1,40}$' then
    select c.code into v_canon from farm_codes c where lower(c.code) = lower(v_code) and c.active;
  end if;
  if v_canon is null then
    perform _ip_gate('farmcode', 30, interval '10 minutes');
    return jsonb_build_object('ok', false, 'error', 'code');
  end if;
  v_mine := p_id is not null and p_token is not null and _cust_token_ok(p_id, p_token);

  for v_s in
    select s.* from farm_codes c join sessions s on s.id = c.session_id
     where c.code = v_canon and c.active
       and coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'farm'
       and coalesce(s.status, '') in ('open', 'full', 'closed') and s.cancelled_at is null
       and coalesce(s.session_date, '') >= v_today
     order by s.session_date, s.id
  loop
    begin v_slots := coalesce(nullif(btrim(v_s.bike_slots), ''), '{}')::jsonb; exception when others then v_slots := '{}'::jsonb; end;
    if jsonb_typeof(v_slots) <> 'object' then v_slots := '{}'::jsonb; end if;
    begin select w.ends_at into v_ends from _session_window(v_s) w; exception when others then v_ends := null; end;
    /* a night that has ended is over; one staff marked Full, no waitlist is full, as the booking app and the website
       say it, not closed: the end is tested first (bug hunt 2026-11-18, form-farmhouse-0-2) (20261119000600) */
    if v_ends is not null and v_ends <= now() then
      v_state := 'over';
    elsif coalesce(v_slots->>'_fbk', '') not in ('', '0', 'false') then
      v_state := 'full';
    else
      select count(*) into v_live from queue_entries q
       where q.session_id = v_s.id and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
      -- a night staff marked Full is full here too: farm_book takes no one on it (bug hunt 2026-11-18,
      -- form-farmhouse-0-1) (20261119000200)
      v_state := case when coalesce(v_s.status, '') = 'full'
                        or (v_s.capacity is not null and v_live >= v_s.capacity) then 'full' else 'open' end;
    end if;
    v_held := null;
    if v_mine then
      select coalesce(jsonb_agg(q.name order by q.queue_num), '[]'::jsonb) into v_held from queue_entries q
       where q.session_id = v_s.id and q.customer_id = p_id
         and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_s.id, 'date', v_s.session_date, 'day', v_s.day, 'title', v_s.title, 'title_ar', v_s.title_ar,
      'time', nullif(btrim(coalesce(v_slots->>'_time', '')), ''),
      'place', coalesce(nullif(btrim(coalesce(v_s.meet_name, '')), ''), nullif(btrim(coalesce(v_s.location, '')), '')),
      'place_ar', nullif(btrim(coalesce(v_s.meet_name_ar, '')), ''),
      'map', nullif(btrim(coalesce(v_s.meet_url, '')), ''),
      'ig', nullif(btrim(coalesce(v_slots->>'_ig', '')), ''),
      'state', v_state, 'max', 4, 'held', v_held));
  end loop;

  if jsonb_array_length(v_out) = 0 then return jsonb_build_object('ok', false, 'error', 'over'); end if;
  return jsonb_build_object('ok', true, 'code', v_canon, 'signed_in', v_mine, 'nights', v_out);
end $function$;
revoke all on function public.farm_night(text, text, text) from public;
grant execute on function public.farm_night(text, text, text) to anon, authenticated;

create or replace function public.farm_book(p_id text, p_token text, p_session text, p_code text,
                                            p_family jsonb default '[]'::jsonb, p_waiver text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_today text := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  v_cust customers%rowtype; v_s sessions%rowtype; v_slots jsonb; v_ends timestamptz; v_code text;
  v_fam text[] := '{}'::text[]; v_x jsonb; v_nm text; v_asks text[];
  v_held int; v_live int; v_new int; v_entries jsonb := '[]'::jsonb; v_err text; v_det text; v_people jsonb;
begin
  if not _rider_gate() or _farmcode_locked() then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  select * into v_cust from customers where id = p_id;

  -- The code, good on this night.
  if btrim(coalesce(p_code, '')) ~ '^[A-Za-z0-9_-]{1,40}$' then
    select c.code into v_code from farm_codes c
     where lower(c.code) = lower(btrim(p_code)) and c.active and c.session_id = coalesce(p_session, '');
  end if;
  if v_code is null then
    perform _ip_gate('farmcode', 30, interval '10 minutes');
    return jsonb_build_object('ok', false, 'error', 'code');
  end if;

  -- The night: a farm night ahead, open, full or closed, never called off or marked Full, no waitlist.
  select * into v_s from sessions s
   where s.id = p_session and coalesce(s.event_kind, '') = 'community' and coalesce(s.ride_kind, '') = 'farm'
     and coalesce(s.status, '') in ('open', 'full', 'closed') and s.cancelled_at is null
     and coalesce(s.session_date, '') >= v_today;
  if v_s.id is null then return jsonb_build_object('ok', false, 'error', 'session'); end if;
  begin v_slots := coalesce(nullif(btrim(v_s.bike_slots), ''), '{}')::jsonb; exception when others then v_slots := '{}'::jsonb; end;
  if jsonb_typeof(v_slots) <> 'object' then v_slots := '{}'::jsonb; end if;
  begin select w.ends_at into v_ends from _session_window(v_s) w; exception when others then v_ends := null; end;
  if v_ends is not null and v_ends <= now() then return jsonb_build_object('ok', false, 'error', 'session'); end if;
  /* Full, no waitlist: answered 'full' (the page says Fully booked), after the end is tested (bug hunt 2026-11-18,
     form-farmhouse-0-2) (20261119000600) */
  if coalesce(v_slots->>'_fbk', '') not in ('', '0', 'false') then return jsonb_build_object('ok', false, 'error', 'full'); end if;

  -- The farm night's own waiver, as it stands.
  if coalesce(p_waiver, '') !~ '^farm-[A-Za-z0-9._-]{1,35}$' or _waiver_outdated(p_waiver) then
    return jsonb_build_object('ok', false, 'error', 'waiver');
  end if;

  -- Up to three family members, each by a name the booking takes (letters and spaces, every part two letters or more).
  if p_family is null then p_family := '[]'::jsonb; end if;
  if jsonb_typeof(p_family) <> 'array' or jsonb_array_length(p_family) > 3 then
    return jsonb_build_object('ok', false, 'error', 'input');
  end if;
  for v_x in select * from jsonb_array_elements(p_family) loop
    if jsonb_typeof(v_x) <> 'string' then return jsonb_build_object('ok', false, 'error', 'input'); end if;
    v_nm := left(btrim(regexp_replace(v_x #>> '{}', '\s+', ' ', 'g')), 60);
    if v_nm = '' or not _name_chars_ok(v_nm) or not _name_parts_ok(v_nm) then
      return jsonb_build_object('ok', false, 'error', 'name', 'name', v_nm);
    end if;
    v_fam := v_fam || v_nm;
  end loop;

  -- What the account owes (an emergency contact, the nationality, a field staff flagged) is answered first.
  v_asks := coalesce(_customer_asks(p_id), '{}'::text[]);
  if cardinality(v_asks) > 0 then return jsonb_build_object('ok', false, 'error', 'fix', 'fields', to_jsonb(v_asks)); end if;

  -- The places, under the night's lock: four per account (the holder and three), the night's capacity in all.
  perform pg_advisory_xact_lock(hashtext('farmcap:' || v_s.id));
  select count(*) into v_held from queue_entries q
   where q.session_id = v_s.id and q.customer_id = p_id and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
  v_new := (case when v_held = 0 then 1 else 0 end) + cardinality(v_fam);
  if v_new = 0 then return jsonb_build_object('ok', false, 'error', 'nothing', 'held', v_held); end if;
  if v_held + v_new > 4 then return jsonb_build_object('ok', false, 'error', 'cap', 'held', v_held); end if;
  /* A night staff marked Full takes no one from this page: customer_create_booking puts every booking on such a
     night on its waitlist, and this page answered "Your request is in" for rows that were only waitlisted (bug hunt
     2026-11-18, sql07-2, form-farmhouse-0-1) (20261119000200). farm_night says 'full' for it. */
  if coalesce(v_s.status, '') = 'full' then return jsonb_build_object('ok', false, 'error', 'full'); end if;
  if v_s.capacity is not null then
    select count(*) into v_live from queue_entries q
     where q.session_id = v_s.id and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
    if v_live >= v_s.capacity then return jsonb_build_object('ok', false, 'error', 'full'); end if;
    if v_live + v_new > v_s.capacity then return jsonb_build_object('ok', false, 'error', 'room'); end if;
  end if;

  -- The rows: the account holder first when they hold no place there yet, then each family member, as the app books
  -- the night (no bike: type None; the farm waiver on every row).
  if v_held = 0 then
    v_entries := v_entries || jsonb_build_array(jsonb_build_object('session_id', v_s.id, 'name', coalesce(v_cust.name, ''),
                   'type_preference', 'None', 'waiver_version', p_waiver));
  end if;
  foreach v_nm in array v_fam loop
    v_entries := v_entries || jsonb_build_array(jsonb_build_object('session_id', v_s.id, 'name', v_nm,
                   'type_preference', 'None', 'waiver_version', p_waiver));
  end loop;

  begin
    perform set_config('mm.farmcode', v_s.id || '|' || v_code, true);
    perform 1 from customer_create_booking(p_id, p_token, v_entries);
    perform set_config('mm.farmcode', '', true);
  exception when others then
    get stacked diagnostics v_err = message_text, v_det = pg_exception_detail;
    perform set_config('mm.farmcode', '', true);
    if v_det = 'GROUP_CAP' then return jsonb_build_object('ok', false, 'error', 'cap', 'held', v_held); end if;
    if v_err = 'FIX_FIRST' then
      return jsonb_build_object('ok', false, 'error', 'fix', 'fields', to_jsonb(coalesce(_customer_asks(p_id), '{}'::text[])));
    end if;
    if v_err in ('STALE_SESSION', 'ACCOUNT_ARCHIVED') then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
    if v_err = 'SESSION_CLOSED' or v_err like 'NOT_OPEN_YET%' then return jsonb_build_object('ok', false, 'error', 'session'); end if;
    if v_err in ('WAIVER_REQUIRED', 'WAIVER_OUTDATED') then return jsonb_build_object('ok', false, 'error', 'waiver'); end if;
    if v_err = 'BAD_INPUT' and v_det = 'name' then return jsonb_build_object('ok', false, 'error', 'name'); end if;
    if v_err = 'RATE_LIMITED' then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
    raise;
  end;

  select coalesce(jsonb_agg(q.name order by q.queue_num), '[]'::jsonb) into v_people from queue_entries q
   where q.session_id = v_s.id and q.customer_id = p_id and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
  return jsonb_build_object('ok', true, 'added', v_new, 'people', v_people,
    'session', jsonb_build_object('id', v_s.id, 'date', v_s.session_date, 'title', v_s.title, 'title_ar', v_s.title_ar,
      'time', nullif(btrim(coalesce(v_slots->>'_time', '')), ''),
      'place', coalesce(nullif(btrim(coalesce(v_s.meet_name, '')), ''), nullif(btrim(coalesce(v_s.location, '')), '')),
      'place_ar', nullif(btrim(coalesce(v_s.meet_name_ar, '')), '')));
end $function$;
revoke all on function public.farm_book(text, text, text, text, jsonb, text) from public;
grant execute on function public.farm_book(text, text, text, text, jsonb, text) to anon, authenticated;

-- ── 5. saturday_rides (form-saturday-0-5), saturday_book (form-saturday-0-2) ───────────────────────────────────
create or replace function public.saturday_rides(p_code text default null)
 returns table(session_id text, session_date text, day text, bike_slots text, meet_url text, title text,
               status text, opens_at timestamptz, code_ok boolean, code_open boolean)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare s sessions%rowtype; _code text := nullif(btrim(coalesce(p_code, '')), '');
        _c text; _on boolean; _pl integer; _ended boolean; _any boolean := false; _fbk boolean;
begin
  if _code is not null then
    if _satcode_locked() then
      raise exception 'RATE_LIMITED' using errcode = 'P0001';
    end if;
    if _code !~ '^[A-Za-z0-9_-]{3,40}$' then _code := '-'; end if;   -- matches nothing, and is counted
  end if;
  for s in
    select x.* from sessions x
     where x.event_kind = 'community' and coalesce(nullif(x.ride_kind, ''), 'saturday') = 'saturday'
       and x.required_tag_id is null and x.cancelled_at is null
       and coalesce(x.session_date, '') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
       and (coalesce(x.status, '') in ('open', 'full')
            or (coalesce(x.status, '') = 'closed' and x.opens_at is not null and x.opens_at > now())
            /* a ride staff marked Full, no waitlist (closed, bike_slots._fbk) is listed too, so the page says Fully
               booked rather than that no ride is open; nothing books it (bug hunt 2026-11-18, form-saturday-0-5)
               (20261119000600) */
            or (coalesce(x.status, '') = 'closed' and (x.opens_at is null or x.opens_at <= now())
                and not coalesce(x.draft, false) and position('"_fbk"' in coalesce(x.bike_slots, '')) > 0))
     order by x.session_date, x.id
  loop
    begin _ended := (select w.ends_at from _session_window(s) w) <= now();
    exception when others then _ended := false; end;
    continue when coalesce(_ended, false);
    -- a closed ride comes here only marked Full, no waitlist (above); its mark is read whole (20261119000600)
    _fbk := false;
    if coalesce(s.status, '') = 'closed' and (s.opens_at is null or s.opens_at <= now()) then
      begin _fbk := coalesce((nullif(btrim(coalesce(s.bike_slots, '')), '')::jsonb) ->> '_fbk', '') not in ('', '0', 'false');
      exception when others then _fbk := false; end;
      continue when not _fbk;
    end if;
    session_id := s.id; session_date := s.session_date; day := s.day; bike_slots := s.bike_slots::text;
    meet_url := s.meet_url; title := s.title; status := s.status; opens_at := s.opens_at;
    code_ok := null; code_open := null;
    if _code is not null then
      select o.code, o.on_ride, o.places into _c, _on, _pl from _satcode_on(s.id, _code) o;
      code_ok := _c is not null and coalesce(_on, false);
      code_open := code_ok and not _fbk and (_pl is null or _satcode_live(s.id, _c) < _pl);
      _any := _any or code_ok;
    end if;
    return next;
  end loop;
  -- A code good on no ride counts against the address (a right one never does).
  if _code is not null and not _any then
    perform _ip_gate('satcode', 30, interval '10 minutes');
  end if;
end $function$;
revoke all on function public.saturday_rides(text) from public;
grant execute on function public.saturday_rides(text) to anon, authenticated;

create or replace function public.saturday_book(p_id text, p_token text, p_session text, p_code text, p_entry jsonb)
 returns table(id text, queue_num integer, status text, refused text)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare s sessions%rowtype; r record; _c text; _on boolean; _pl integer; _name text;
begin
  if not _cust_token_ok(p_id, p_token) then
    raise exception 'STALE_SESSION' using errcode = 'P0001';
  end if;
  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'entry';
  end if;
  if _satcode_locked() then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;
  -- The details staff choose riders by: a date of birth, a nationality and an Instagram, as on the Defe
  -- page (20261023170000). The page asks them of every rider and saves them first.
  if not exists (select 1 from customers x
                  where x.id = p_id
                    and nullif(btrim(coalesce(x.birth_date, '')), '') is not null
                    and nullif(btrim(coalesce(x.nationality, '')), '') is not null
                    and nullif(btrim(coalesce(x.socials->>'instagram', '')), '') is not null) then
    raise exception 'FIX_FIRST' using errcode = 'P0001', detail = 'birth_date,nationality,instagram';
  end if;
  select * into s from sessions x
   where x.id = p_session and x.event_kind = 'community'
     and coalesce(nullif(x.ride_kind, ''), 'saturday') = 'saturday' and x.required_tag_id is null
     and coalesce(x.status, '') in ('open', 'full');
  if s.id is null then
    raise exception 'SESSION_CLOSED' using errcode = 'P0001';
  end if;
  -- Every Saturday rider rides with a group: Beginners 20 km or Intermediates 40 km (20261002120000).
  if coalesce(p_entry->>'ride_group', '') not in ('beg', 'int') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'ride_group';
  end if;
  -- One booking at a time per ride: each code's places there are counted under it.
  perform pg_advisory_xact_lock(hashtext('satcode:' || s.id));
  /* The rider's own live booking on this ride is answered as booked before the code's places are counted (they count
     it too): a retry after a lost answer, or a one-place code, was told the code's places were all booked (bug hunt
     2026-11-18, form-saturday-0-2) (20261119000600). The same words as the one-booking guard's. */
  if exists (select 1 from queue_entries q where q.session_id = s.id and q.customer_id = p_id
                and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')) then
    raise exception 'One place per person on this session.' using detail = 'ONE_PER_SESSION';
  end if;
  select o.code, o.on_ride, o.places into _c, _on, _pl from _satcode_on(s.id, p_code) o;
  if _c is null or not coalesce(_on, false) then
    perform _ip_gate('satcode', 30, interval '10 minutes');
    id := null; queue_num := null; status := null; refused := 'BAD_CODE';
    return next;
    return;
  end if;
  if _pl is not null and _satcode_live(s.id, _c) >= _pl then
    id := null; queue_num := null; status := null; refused := 'CODE_USED_UP';
    return next;
    return;
  end if;
  select x.name into _name from customers x where x.id = p_id;
  perform set_config('mm.satcode', s.id || '|' || _c, true);
  for r in
    select * from customer_create_booking(p_id, p_token, jsonb_build_array(
      (p_entry - 'promo_code' - 'group_id' - 'run_km' - 'share_ok' - 'ask' - 'vl' - 'blood_role' - 'blood_club')
      || jsonb_build_object('session_id', s.id, 'name', coalesce(_name, ''))))
  loop
    id := r.id; queue_num := r.queue_num; status := r.status; refused := null;
    return next;
  end loop;
  perform set_config('mm.satcode', '', true);
end $function$;
revoke all on function public.saturday_book(text, text, text, text, jsonb) from public;
grant execute on function public.saturday_book(text, text, text, text, jsonb) to anon, authenticated;

-- ── 6. volunteer_find (volunteers2-1), volunteer_donated (volunteers2-1), volunteer_counts (volunteers2-2): C2 ──
create or replace function public.volunteer_find(p_id text, p_token text, p_session text, p_ref text default null,
                                                 p_ref_num integer default null, p_mobile text default null, p_number integer default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  _scan boolean := p_ref is not null;
  _mobile text := _volunteer_phone(p_mobile);
  s sessions%rowtype;
  w volunteer_sessions%rowtype; _phone boolean; _details boolean; _blood boolean;
begin
  w := _vol_gate(p_id, p_token, p_session);
  if (_scan::int + (p_mobile is not null)::int + (p_number is not null)::int) <> 1
     or (_scan and p_ref !~ '^[0-9A-Za-z-]{4,8}$')
     or (p_mobile is not null and length(_mobile) < 7) then
    raise exception 'VOL_BAD_SEARCH' using errcode = '22023';
  end if;
  if (select count(*) from volunteer_log l
       where l.customer_id = p_id and l.action = case when _scan then 'scan' else 'search' end
         and l.at > now() - interval '10 minutes') >= (case when _scan then 200 else 30 end) then
    raise exception 'VOL_SLOW' using errcode = 'P0001';
  end if;
  perform _vol_log(p_id, p_session, case when _scan then 'scan' else 'search' end);
  select * into s from sessions where id = p_session;
  /* A row found by search or scan carries what a row of the list carries (volunteer_list, 20261105180000): whether
     the booking is a blood-drive visitor, and the phone and details the session's caps give (bug hunt 2026-11-18,
     volunteers2-1) (20261119000600). 'visitor' was patched in by 20261105140000 and is kept. */
  _phone := coalesce((w.caps ->> 'phone')::boolean, false);
  _details := coalesce((w.caps ->> 'details')::boolean, false);
  _blood := coalesce(s.ride_kind, '') = 'blood';
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'name', r.name, 'number', r.queue_num,
             'checked_in', r.status in ('active', 'done'),
             'donated', r.donated_at is not null,
             'visitor', coalesce(r.blood_role, '') = 'visitor',
             'own', r.customer_id is not distinct from p_id,
             'desk', _vol_desk_reason(r, s),
             'mine_in', _vol_mine(p_id, r.id, 'checkin', 'uncheckin', r.checked_in_at::text),
             'mine_donated', _vol_mine(p_id, r.id, 'donated', 'undonated', r.donated_at::text))
           || case when _phone then jsonb_build_object('phone', coalesce(nullif(btrim(r.phone), ''), nullif(btrim(c.phone), ''))) else '{}'::jsonb end
           || case when _details then jsonb_build_object('status', r.status) || case when _blood
                then jsonb_build_object('blood_type', nullif(btrim(coalesce(c.blood_type, '')), ''), 'club', nullif(btrim(coalesce(r.blood_club, '')), ''))
                else jsonb_build_object('bike', nullif(btrim(coalesce(r.type_preference, '')), ''), 'size', nullif(btrim(coalesce(r.size, '')), ''), 'height', nullif(btrim(coalesce(r.height::text, '')), ''))
              end else '{}'::jsonb end
           order by r.queue_num)
      from (select q.* from queue_entries q left join customers c on c.id = q.customer_id
             where q.session_id = p_session
               and q.status in ('waiting', 'waitlist', 'active', 'done')
               and ((_scan and lower(q.id) like lower(replace(replace(replace(p_ref, '\', ''), '%', ''), '_', '')) || '%'
                           and (p_ref_num is null or q.queue_num = p_ref_num))
                 or (p_mobile is not null and (_volunteer_phone(c.phone) = _mobile or _volunteer_phone(q.phone) = _mobile))
                 or (p_number is not null and q.queue_num = p_number))
             order by q.queue_num limit 5) r
      left join customers c on c.id = r.customer_id), '[]'::jsonb);
end $function$;
revoke all on function public.volunteer_find(text, text, text, text, integer, text, integer) from public;
grant execute on function public.volunteer_find(text, text, text, text, integer, text, integer) to anon, authenticated;

create or replace function public.volunteer_donated(p_id text, p_token text, p_session text, p_entry_id text, p_on boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare q queue_entries%rowtype; _at text;
begin
  perform _vol_gate(p_id, p_token, p_session, case when coalesce(p_on, false) then 'donated' else 'undo' end);
  select * into q from queue_entries where id = p_entry_id and session_id = p_session for update;
  if not found then raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001'; end if;
  if q.customer_id is not distinct from p_id then raise exception 'VOL_OWN_BOOKING' using errcode = '42501'; end if;

  if coalesce(p_on, false) then
    if q.donated_at is not null then return jsonb_build_object('ok', true, 'noop', true); end if;
    -- a visitor gave no blood: switched to donor first (BLOOD_VISITOR, which the portal words); _blood_donated_apply
    -- refuses it too since 20261105140000 (bug hunt 2026-11-18, volunteers2-1) (20261119000600)
    if coalesce(q.blood_role, '') = 'visitor' then raise exception 'BLOOD_VISITOR' using errcode = 'P0001'; end if;
    perform _blood_donated_apply(q.id, true); -- the free-ride code is made there and never returned here
    select x.donated_at::text into _at from queue_entries x where x.id = q.id;
    perform _vol_log(p_id, p_session, 'donated', q.id, _at);
    return jsonb_build_object('ok', true);
  end if;

  if q.donated_at is null then return jsonb_build_object('ok', true, 'noop', true); end if;
  if not _vol_mine(p_id, q.id, 'donated', 'undonated', q.donated_at::text) then raise exception 'VOL_NOT_YOURS' using errcode = '42501'; end if;
  perform _blood_donated_apply(q.id, false);
  perform _vol_log(p_id, p_session, 'undonated', q.id);
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.volunteer_donated(text, text, text, text, boolean) from public;
grant execute on function public.volunteer_donated(text, text, text, text, boolean) to anon, authenticated;

-- The session's head counts over every booking, as volunteer_enter counts them: volunteer_list stops at 1,000 rows, so
-- counts taken from it fall short on a larger session (bug hunt 2026-11-18, volunteers2-2) (20261119000600). The same
-- gate as volunteer_list (the 'list' cap): whoever may read the list may count it.
create or replace function public.volunteer_counts(p_id text, p_token text, p_session text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare _n record;
begin
  -- volunteers2-2 (20261119000600)
  perform _vol_gate(p_id, p_token, p_session, 'list');
  select count(*) filter (where q.status in ('waiting', 'waitlist', 'active', 'done')) booked,
         count(*) filter (where q.status in ('active', 'done')) arrived,
         count(*) filter (where q.donated_at is not null) donated,
         count(*) filter (where q.status in ('waiting', 'waitlist', 'active', 'done') and q.blood_role = 'visitor') visitors
    into _n from queue_entries q where q.session_id = p_session;
  return jsonb_build_object('booked', _n.booked, 'in', _n.arrived, 'donated', _n.donated, 'visitors', _n.visitors);
end $function$;
revoke all on function public.volunteer_counts(text, text, text) from public;
grant execute on function public.volunteer_counts(text, text, text) to anon, authenticated;

-- ── 7. a Petromin party the desk moved to another night (forms-js2-2): contract C3 ────────────────────────────
alter table public.rider_registrations add column if not exists moved_from_no text;
alter table public.rider_registrations add column if not exists moved_from_session text;
comment on column public.rider_registrations.moved_from_no is
  'The booking number this party had before the desk last moved it to another night (staff_rider_party_move); rider_lookup and rider_edit answer moved for it, 20261119000600.';
comment on column public.rider_registrations.moved_from_session is
  'The night (sessions.id) this party was on before the desk last moved it, with moved_from_no, 20261119000600.';

-- The party's new number and night for the number, night and phone a rider's phone kept, when the desk moved it
-- (null when it did not). The same proof as rider_lookup's (the last 9 digits of the lead rider's phone) and the same
-- nights (tonight's or later). Called only by the definer functions below.
create or replace function public._rider_moved(p_no text, p_phone text, p_session text)
 returns jsonb
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare
  v_no text := upper(trim(coalesce(p_no, '')));
  v_proof text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 9);
  v record;
begin
  -- forms-js2-2 (20261119000600)
  if v_no = '' or length(v_proof) < 9 then return null; end if;
  select r.booking_no, r.session_id, s.session_date into v
    from rider_registrations r join sessions s on s.id = r.session_id
   where upper(r.moved_from_no) = v_no and r.party_no = 1
     and r.phone is not null and right(regexp_replace(r.phone, '\D', '', 'g'), 9) = v_proof
     and (p_session is null or r.moved_from_session = p_session)
     and s.session_date >= to_char(now() at time zone 'Asia/Riyadh' - interval '1 day', 'YYYY-MM-DD')
   order by s.session_date, r.session_id
   limit 1;
  if v.booking_no is null then return null; end if;
  return jsonb_build_object('ok', false, 'error', 'moved', 'booking_no', v.booking_no, 'session_id', v.session_id,
                            'session_date', v.session_date);
end $function$;
revoke all on function public._rider_moved(text, text, text) from public, anon, authenticated;

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
  v_moved jsonb;
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
    /* a party the desk moved to another night is found by the number and night the phone kept: answered with its new
       number and night, not as a miss (bug hunt 2026-11-18, forms-js2-2) (20261119000600) */
    v_moved := _rider_moved(v_no, p_phone, p_session_id);
    if v_moved is not null then return v_moved; end if;
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
revoke all on function public.rider_lookup(text, text, text) from public;
grant execute on function public.rider_lookup(text, text, text) to anon, authenticated, service_role;

-- rider_edit and staff_rider_party_move: patched in place (each was patched in place by 20261112210000 and
-- 20261114030000, staff_rider_party_move also by 20261110235300; a full copy would drop those).
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text,text)'::regprocedure);
  if position('(20261119000600)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$  if v_row.id is null then return jsonb_build_object('ok', false, 'error', 'notfound'); end if;$a$,
$b$  /* a party the desk moved to another night answers with its new number and night, not notfound (bug hunt
     2026-11-18, forms-js2-2) (20261119000600) */
  if v_row.id is null then
    return coalesce(_rider_moved(p_booking_no, p_proof_phone, p_from_session), jsonb_build_object('ok', false, 'error', 'notfound'));
  end if;$b$);
  d := pg_temp._once(d,
$a$  if v_row.phone is null or length(v_proof) < 9 or right(regexp_replace(v_row.phone, '\D', '', 'g'), 9) <> v_proof then
    return jsonb_build_object('ok', false, 'error', 'notfound');
  end if;$a$,
$b$  if v_row.phone is null or length(v_proof) < 9 or right(regexp_replace(v_row.phone, '\D', '', 'g'), 9) <> v_proof then
    return coalesce(_rider_moved(p_booking_no, p_proof_phone, p_from_session), jsonb_build_object('ok', false, 'error', 'notfound'));
  end if;$b$);
  execute d;
end $do$;

do $do$
declare d text;
begin
  d := pg_get_functiondef('public.staff_rider_party_move(bigint,text)'::regprocedure);
  if position('(20261119000600)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$  update rider_registrations set session_id = p_session, booking_no = bno
   where case when old_bno is null then id = r.id$a$,
$b$  -- the number and night the riders' phones still hold, for rider_lookup and rider_edit to answer moved (bug hunt
  -- 2026-11-18, forms-js2-2) (20261119000600)
  update rider_registrations set session_id = p_session, booking_no = bno,
         moved_from_no = old_bno, moved_from_session = old_sess
   where case when old_bno is null then id = r.id$b$);
  execute d;
end $do$;

-- ── 8. community_track (form-community-1-2): contract C4 ─────────────────────────────────────────────────────────
drop function if exists public.community_track(text);
CREATE OR REPLACE FUNCTION public.community_track(p_token text, p_cid text DEFAULT NULL::text, p_ctoken text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a community_applications%rowtype; s sessions%rowtype; v_st text; v_time text; v_own boolean;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{48}$' then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if not _ip_gate('commtrack', 60, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  select * into a from community_applications where track_token = p_token;
  if a.id is null then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  v_st := case when a.status = 'approved' and a.invited_session is not null then 'invited' else a.status end;
  if a.invited_session is not null then
    select * into s from sessions where id = a.invited_session;
    begin v_time := nullif(btrim(coalesce(s.bike_slots::jsonb ->> '_time', '')), '');
    exception when others then v_time := null; end;
  end if;
  /* The fix link opens the applicant's details to be changed: it goes only to the applicant's own signed-in account,
     never to whoever holds the status address (a link kept on a shared phone) (bug hunt 2026-11-18,
     form-community-1-2) (20261119000600) */
  v_own := a.customer_id is not null and p_cid is not null and p_ctoken is not null
           and a.customer_id = p_cid and _cust_token_ok(p_cid, p_ctoken);
  return jsonb_build_object('ok', true,
    'first', split_part(btrim(coalesce(a.name, '')), ' ', 1), 'lang', a.lang, 'status', v_st,
    'sent_at', a.created_at, 'updated_at', case when a.submissions > 1 then a.updated_at end,
    'decided_at', case when a.status <> 'pending' then a.decided_at end,
    'fix', /* only while the application is pending (20261110235400) */ case when v_own and a.status = 'pending' and a.fix_token is not null and a.fix_asked_at is not null and a.fix_done_at is null
                then jsonb_build_object('asked_at', a.fix_asked_at, 'fields', to_jsonb(a.fix_fields), 'note', a.fix_note, 'token', a.fix_token) end,
    'fix_done_at', a.fix_done_at,
    'ride', case when s.id is not null
                 then jsonb_build_object('date', s.session_date, 'day', s.day, 'title', s.title, 'time', v_time,
                                         'cancelled', s.cancelled_at is not null) end);
end $function$;
revoke all on function public.community_track(text, text, text) from public;
grant execute on function public.community_track(text, text, text) to anon, authenticated;

-- ── 9. site_message_send (web-components9-1) ────────────────────────────────────────────────────────────────────
create or replace function public.site_message_send(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_kind    text := coalesce(p->>'kind','');
  v_topic   text := nullif(trim(coalesce(p->>'topic','')), '');
  v_name    text := regexp_replace(trim(coalesce(p->>'name','')), '\s+', ' ', 'g');
  v_company text := nullif(regexp_replace(trim(coalesce(p->>'company','')), '\s+', ' ', 'g'), '');
  v_email   text := nullif(lower(trim(coalesce(p->>'email',''))), '');
  v_phone   text := nullif(trim(coalesce(p->>'phone','')), '');
  v_msg     text := trim(coalesce(p->>'message',''));
  v_lang    text := coalesce(nullif(p->>'lang',''), 'en');
  v_cust    text;
  v_prev    bigint;
  v_id      bigint;
begin
  if not _ip_gate('sitemsg', 5, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  if v_kind not in ('business','help','jobs') then return jsonb_build_object('ok', false, 'error', 'kind'); end if;
  if v_topic is not null and v_topic !~ '^[a-z0-9_-]{1,40}$' then v_topic := null; end if;
  if v_name = '' or length(v_name) > 120 or not _name_chars_ok(v_name) then return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if v_company is not null and length(v_company) > 120 then return jsonb_build_object('ok', false, 'error', 'company'); end if;
  if v_email is not null and (length(v_email) > 254 or v_email !~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$') then
    return jsonb_build_object('ok', false, 'error', 'email'); end if;
  if v_phone is not null and (v_phone !~ '^\+[1-9][0-9]{7,14}$' or (v_phone like '+966%' and v_phone !~ '^\+9665[0-9]{8}$')) then
    return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if v_email is null and v_phone is null then return jsonb_build_object('ok', false, 'error', 'contact'); end if;
  if v_msg = '' or length(v_msg) > 2000 then return jsonb_build_object('ok', false, 'error', 'message'); end if;
  if v_lang !~ '^[a-z]{2}$' then v_lang := 'en'; end if;
  if coalesce(p->>'customer_id','') <> '' and coalesce(p->>'token','') <> '' and _cust_token_ok(p->>'customer_id', p->>'token') then
    v_cust := p->>'customer_id';
  end if;

  -- A double tap (or a retry after a lost answer) gets the same reference back.
  perform pg_advisory_xact_lock(hashtext('sitemsg:' || coalesce(v_phone, '') || '|' || coalesce(v_email, '')));
  select id into v_prev from site_messages
   where phone is not distinct from v_phone and email is not distinct from v_email and kind = v_kind
     and md5(message) = md5(v_msg) and created_at > now() - interval '10 minutes'
     -- the same words for another role (the jobs form's topic) are an application of their own (bug hunt 2026-11-18,
     -- web-components9-1) (20261119000600)
     and topic is not distinct from v_topic
   order by id desc limit 1;
  if v_prev is not null then
    return jsonb_build_object('ok', true, 'id', v_prev, 'ref', 'M-' || lpad(v_prev::text, 4, '0'), 'repeat', true);
  end if;

  insert into site_messages(kind, topic, name, company, email, phone, message, lang, customer_id, updated_by)
  values (v_kind, v_topic, v_name, v_company, v_email, v_phone, v_msg, v_lang, v_cust, 'website')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'ref', 'M-' || lpad(v_id::text, 4, '0'));
end $function$;
revoke all on function public.site_message_send(jsonb) from public;
grant execute on function public.site_message_send(jsonb) to anon, authenticated;

-- ── checks: every function carries this file's change, is still SECURITY DEFINER with its search_path, and its grants
do $chk$
declare f text;
begin
  foreach f in array array[
    'public.member_area(text,text)',
    'public.club_rides()',
    'public._ask_mine(bigint,integer,text)',
    'public.ask_page(text,text,text,text)',
    'public._ask_result(public.ask_questions,integer,boolean,text[])',
    'public.ask_send(bigint,text,text,jsonb,text)',
    'public.farm_night(text,text,text)',
    'public.farm_book(text,text,text,text,jsonb,text)',
    'public.saturday_rides(text)',
    'public.saturday_book(text,text,text,text,jsonb)',
    'public.volunteer_find(text,text,text,text,integer,text,integer)',
    'public.volunteer_donated(text,text,text,text,boolean)',
    'public.volunteer_counts(text,text,text)',
    'public.rider_lookup(text,text,text)',
    'public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text,text)',
    'public.staff_rider_party_move(bigint,text)',
    'public.community_track(text,text,text)',
    'public.site_message_send(jsonb)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
    if position('(20261119000600)' in pg_get_functiondef(f::regprocedure)) = 0 then
      raise exception '% was not changed', f;
    end if;
  end loop;
  -- the riders' and the forms' doors: open to anon and authenticated
  foreach f in array array[
    'public.member_area(text,text)', 'public.club_rides()', 'public.ask_page(text,text,text,text)',
    'public.ask_send(bigint,text,text,jsonb,text)', 'public.farm_night(text,text,text)',
    'public.farm_book(text,text,text,text,jsonb,text)', 'public.saturday_rides(text)',
    'public.saturday_book(text,text,text,text,jsonb)', 'public.volunteer_find(text,text,text,text,integer,text,integer)',
    'public.volunteer_donated(text,text,text,text,boolean)', 'public.volunteer_counts(text,text,text)',
    'public.rider_lookup(text,text,text)', 'public.rider_edit(text,text,text,text,integer,text,text,text,text,jsonb,text,text,text)',
    'public.community_track(text,text,text)', 'public.site_message_send(jsonb)'] loop
    if not has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% lost a client grant', f;
    end if;
  end loop;
  -- inside the database only
  foreach f in array array['public._ask_mine(bigint,integer,text)', 'public._ask_result(public.ask_questions,integer,boolean,text[])',
                           'public._rider_moved(text,text,text)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  if not exists (select 1 from pg_proc p where p.oid = 'public._rider_moved(text,text,text)'::regprocedure
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '_rider_moved has no search_path';
  end if;
  -- the desk's move stays staff-only
  if has_function_privilege('anon', 'public.staff_rider_party_move(bigint,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_rider_party_move(bigint,text)', 'execute') then
    raise exception 'staff_rider_party_move is open to anon or lost its grant';
  end if;
  -- one community_track, one rider_edit: PostgREST must not see two signatures (PGRST203)
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'community_track') <> 1
     or (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'rider_edit') <> 1 then
    raise exception 'community_track or rider_edit has more than one signature';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'rider_registrations'
        and column_name in ('moved_from_no', 'moved_from_session')) <> 2 then
    raise exception 'rider_registrations lacks moved_from_no or moved_from_session';
  end if;
  -- web-components8-1 is left as it is because 20261110235400's change is live: make sure it is
  if position('v_height not between 80 and 250' in pg_get_functiondef('public.customer_learn_apply(text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'customer_learn_apply does not take the form''s height over a stored one outside 80-250 (20261110235400 is missing)';
  end if;
  -- volunteers2-1: 'visitor' on found rows and the BLOOD_VISITOR refusal in _blood_donated_apply (20261105140000)
  if position('BLOOD_VISITOR' in pg_get_functiondef('public._blood_donated_apply(text,boolean)'::regprocedure)) = 0 then
    raise exception '_blood_donated_apply does not refuse a visitor (20261105140000 is missing)';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119000600', 'bh18_r2a')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Read-only check after applying (expect: 19, 2, 1, f, t, 1):
-- select (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
--           and position('(20261119000600)' in pg_get_functiondef(p.oid)) > 0) as changed_19,
--        (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'rider_registrations'
--           and column_name in ('moved_from_no', 'moved_from_session')) as moved_columns,
--        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'community_track') as one_track,
--        has_function_privilege('anon', 'public._rider_moved(text,text,text)', 'execute') as moved_helper_open,
--        has_function_privilege('anon', 'public.volunteer_counts(text,text,text)', 'execute') as counts_open,
--        (select count(*) from supabase_migrations.schema_migrations where version = '20261119000600') as ledger;
