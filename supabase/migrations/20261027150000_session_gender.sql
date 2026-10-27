-- ============================================================================
-- Men only, women only or mixed (the owner, 2026-10-27: "i want the triathlon pool sessions to be for male
-- only or female only or mixed and to be mentioned on the card and event everywhere and only allow the
-- gender selected to book it and make it visible only for the gender it is for").
--
-- sessions.gender_only: 'male' (men only), 'female' (women only) or null (mixed: every session before this).
-- Staff set it on the Triathlon Pool Session's form; the rules below hold for any session that carries it.
--  1. list_sessions gives a men-only or women-only session only to a signed-in account of that gender. An
--     account holding a booking on it keeps seeing it, as a rider keeps a tag-gated ride after the tag
--     lapses. A visitor who is not signed in does not see it.
--  2. The table's own read ("read ungated or staff") hides it from everyone but staff, as it hides a
--     tag-gated ride: only list_sessions hands it out.
--  3. _gender_entry_guard refuses a customer's booking on it, a move onto it and taking a cancelled place
--     back, when the account's gender is the other one or none is on file (GENDER_ONLY, detail = the
--     gender the session is for). A row that stays where it is is not judged again. Staff are not refused
--     here: the staff screens refuse the other gender themselves.
--  4. The other lists follow suit: club_rides (public) and member_area (members' upcoming rides) leave out a
--     session for the other gender; badge_weeks (Perfect Week) and rider_sessions leave out every gendered one.
--
-- Rollback:
--   drop trigger if exists queue_entries_gender_guard on public.queue_entries;
--   drop function if exists public._gender_entry_guard();
--   alter policy "read ungated or staff" on public.sessions using ((((required_tag_id is null)
--     and ((reveal_at is null) or (reveal_at <= now()))) or (select is_staff())));
--   list_sessions as it was before (pg_get_functiondef md5(prosrc) 6d66b9796384522c00acedf937e9f80a: this
--   file's version without the gender_only clause and the _g variable);
--   club_rides, member_area, badge_weeks and rider_sessions as before (md5(prosrc) fd143f5e6a577686f30244e471c14dd0,
--   c4aa160abf1c1dbba5d2267bc2d4d04e, c1e44de2051dea21c1e351f5ea022c05, 5f9f6aa4554c823b22a986aa876b4954): this
--   file's versions without the gender_only lines;
--   alter table public.sessions drop column gender_only;
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. the column ──────────────────────────────────────────────────────────────────────────────
alter table public.sessions add column if not exists gender_only text;
alter table public.sessions drop constraint if exists sessions_gender_only_check;
alter table public.sessions add constraint sessions_gender_only_check
  check (gender_only is null or gender_only in ('male', 'female'));

-- ── 2. who sees it ─────────────────────────────────────────────────────────────────────────────
create or replace function public.list_sessions(p_id text, p_token text)
 returns setof sessions
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  s sessions%rowtype;
  mine boolean := p_id is not null and p_token is not null and _cust_token_ok(p_id, p_token);
  _g text;
begin
  if mine then
    select c.gender into _g from customers c where c.id = p_id;
  end if;
  for s in
    select x.* from sessions x
     where (x.required_tag_id is null
        or (mine and (
             exists (select 1 from customer_tags ct
                      where ct.customer_id = p_id and ct.tag_id = x.required_tag_id
                        and _ctag_active(ct.starts_at, ct.expires_at))
             -- a booking the rider still holds, or a night they rode, keeps it visible after the tag lapses
             or exists (select 1 from queue_entries q
                         where q.session_id = x.id and q.customer_id = p_id
                           and q.status in ('waiting','waitlist','active','done')))))
       -- men only or women only (20261027150000): that gender alone, or an account holding a booking on it
       and (x.gender_only is null
        or (mine and (
             x.gender_only = _g
             or exists (select 1 from queue_entries q
                         where q.session_id = x.id and q.customer_id = p_id
                           and q.status in ('waiting','waitlist','active','done')))))
     order by x.session_date
  loop
    -- the breakfast stop and where the ride goes stay unsaid until staff's time (sessions.reveal_at); the
    -- meeting point shows at once (2026-10-06)
    if s.reveal_at is not null and s.reveal_at > now() then
      s.location := null; s.route_slug := null;
      s.breakfast_name := null; s.breakfast_url := null; s.breakfast_name_ar := null;
      s.breakfast_offer_en := null; s.breakfast_offer_ar := null;
    end if;
    return next s;
  end loop;
end $function$;

alter policy "read ungated or staff" on public.sessions
  using ((((required_tag_id is null) and ((reveal_at is null) or (reveal_at <= now())) and (gender_only is null))
          or (select is_staff())));

-- ── 3. who books it ────────────────────────────────────────────────────────────────────────────
create or replace function public._gender_entry_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  _only text;
  _g text;
begin
  if new.customer_id is null or (select is_staff()) then return new; end if;
  -- leaving, finishing or being marked a no-show is never refused
  if coalesce(new.status, '') in ('cancelled', 'removed', 'noshow', 'done') then return new; end if;
  -- a live row that stays on its session is not judged again
  if tg_op = 'UPDATE' and old.session_id is not distinct from new.session_id
     and coalesce(old.status, '') not in ('cancelled', 'removed', 'noshow') then
    return new;
  end if;
  select x.gender_only into _only from sessions x where x.id = new.session_id;
  if _only is null then return new; end if;
  select c.gender into _g from customers c where c.id = new.customer_id;
  if _g is distinct from _only then
    raise exception 'GENDER_ONLY' using errcode = 'P0001', detail = _only;
  end if;
  return new;
end $function$;
revoke execute on function public._gender_entry_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_gender_guard on public.queue_entries;
create trigger queue_entries_gender_guard
  before insert or update of status, session_id on public.queue_entries
  for each row execute function public._gender_entry_guard();

-- ── 4. the other lists of sessions ─────────────────────────────────────────────────────────────
-- Every other function that lists sessions to customers or to anyone (each as it is live, with one clause
-- more): the club page's public list (club_rides) and the members' upcoming rides (member_area) leave out
-- a session for the other gender as list_sessions does; the Perfect Week badge's weeks (badge_weeks) and
-- the rider form's list (rider_sessions, Petromin's) leave out every men-only or women-only session.
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
     where s.event_kind = 'community' and s.status = 'open' and coalesce(s.ride_kind, '') <> 'petromin'
       and s.required_tag_id is null   -- a private event is listed only to its members (list_sessions)
       and s.gender_only is null       -- nor one for men only or women only (20261027150000)
       and s.session_date >= to_char((now() at time zone 'Asia/Riyadh')::date, 'YYYY-MM-DD')
     order by s.session_date
     limit 6) t;
  return v;
end $function$;

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
     where q.customer_id = p_id and q.status = 'done' order by q.session_date desc limit 5) t;
  select coalesce(jsonb_agg(x order by x->>'date', x->>'time'), '[]'::jsonb) into v_next from (
    select jsonb_build_object('id', s.id, 'date', s.session_date, 'title', coalesce(nullif(btrim(s.title), ''), ''), 'kind', s.ride_kind,
             'time', substring(coalesce(s.bike_slots, '') from '"_time"\s*:\s*"([^"]*)"'),
             'booked', exists (select 1 from queue_entries q where q.session_id = s.id and q.customer_id = p_id and q.status in ('waiting','waitlist','active'))) as x
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
       -- one for men only or women only to that gender alone, or an account holding a booking on it (20261027150000)
       and (s.gender_only is null or s.gender_only = c.gender
            or exists (select 1 from queue_entries q3
                        where q3.session_id = s.id and q3.customer_id = p_id
                          and q3.status in ('waiting','waitlist','active','done')))
       and s.session_date >= v_today order by s.session_date limit 8) t;
  select value into v_ann from site_content where key = 'site.announce.messages';
  return jsonb_build_object('ok', true, 'member', true, 'first_name', split_part(coalesce(c.name,''), ' ', 1),
    'since', case when v_since is not null then to_timestamp(v_since / 1000.0) end,
    'credits', v_credits, 'tier', v_tier, 'next', case v_tier when 0 then v_pro when 1 then v_leg end,
    'rides', v_rides, 'group_rides', v_group, 'last', v_last, 'upcoming', v_next,
    'birth_date', c.birth_date, 'announcements', coalesce(v_ann, '[]'::jsonb));
end $function$;

create or replace function public.badge_weeks()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  with today as (select (now() at time zone 'Asia/Riyadh')::date as d),
  s as (
    select id, _safe_date(session_date) as d
      from sessions
     where coalesce(status, '') <> 'deleted'
       and required_tag_id is null          -- private events are nobody else's business (20261004100000)
       and gender_only is null              -- nor is one for men only or women only, which half could never attend (20261027150000)
  )
  select coalesce(jsonb_agg(jsonb_build_object('w', w, 'ids', ids) order by w), '[]'::jsonb)
    from (select to_char(s.d - extract(dow from s.d)::int, 'YYYY-MM-DD') as w,
                 jsonb_agg(s.id order by s.d, s.id) as ids
            from s, today
           where s.d is not null
             and s.d <= today.d + (6 - extract(dow from today.d)::int)
           group by 1) x
$function$;

create or replace function public.rider_sessions(p_source text default 'petromin'::text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_kind text := lower(regexp_replace(coalesce(p_source,''), '[^a-zA-Z0-9_-]', '', 'g'));
        v_today text := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'title', s.title,
             'start', to_char(w.starts_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00',
             'end',   to_char(w.ends_at   at time zone 'Asia/Riyadh', 'YYYY-MM-DD"T"HH24:MI:SS') || '+03:00'
           ) order by s.session_date)
    from sessions s cross join lateral _session_window(s) w
    where s.ride_kind = v_kind and _rider_session_open(s) and s.session_date >= v_today and w.ends_at > now()
      and s.gender_only is null   -- one for men only or women only is never listed to everyone (20261027150000)
  ), '[]'::jsonb);
end $function$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261027150000', 'session_gender')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): the column, the guard (definer) and the policy.
select (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'sessions' and column_name = 'gender_only') as has_column,
       (select prosecdef from pg_proc where oid = 'public._gender_entry_guard()'::regprocedure) as guard_definer,
       (select prosecdef from pg_proc where oid = 'public.list_sessions(text,text)'::regprocedure) as list_definer,
       (select count(*) from pg_trigger where tgname = 'queue_entries_gender_guard') as has_trigger,
       (select qual from pg_policies where schemaname = 'public' and tablename = 'sessions'
         and policyname = 'read ungated or staff') as read_policy;
