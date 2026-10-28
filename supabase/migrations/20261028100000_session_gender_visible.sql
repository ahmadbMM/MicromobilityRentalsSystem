-- ============================================================================
-- Men-only and women-only sessions are shown to everyone; only booking them is held to that gender (the owner,
-- 2026-10-28: "make all pool sessions visible to all genders but only male can book male sessions and female can
-- book female sessions"). This takes back the visibility half of 20261027150000 and keeps the rest of it.
--
--  1. list_sessions hands out a session with sessions.gender_only set to everyone, signed in or not, of either
--     gender, as it hands out a mixed one (the gender clause and the _g variable go).
--  2. The table's own read ("read ungated or staff") no longer hides it.
--  3. club_rides (the club page's public list) and member_area (members' upcoming rides) list it too.
--  Unchanged: _gender_entry_guard still refuses a customer's booking on it, a move onto it and taking a cancelled
--  place back, for the other gender or none on file (GENDER_ONLY, detail = the gender it is for); badge_weeks
--  (Perfect Week) still leaves out every gendered session, which half the riders could never attend; and
--  rider_sessions (the rider form's list, where anyone registers) still never lists one.
--
-- Rollback: run sections 2 and 4 of 20261027150000_session_gender.sql again (list_sessions, the policy,
-- club_rides and member_area as they were; live md5(prosrc) before this file: list_sessions
-- 361a03c723b72bf0c6965d86649e6abc, club_rides 6e628606ed871bd01ac20b845520074a, member_area
-- db03ebf689b619dfcf5362737f305a4d).
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. list_sessions: every session for everyone, as before 20261027150000 ─────────────────────────
create or replace function public.list_sessions(p_id text, p_token text)
 returns setof sessions
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  s sessions%rowtype;
  mine boolean := p_id is not null and p_token is not null and _cust_token_ok(p_id, p_token);
begin
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
       -- men only or women only is shown to everyone; booking it is held to that gender (_gender_entry_guard,
       -- 20261028100000)
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

-- ── 2. the table's own read ────────────────────────────────────────────────────────────────────
alter policy "read ungated or staff" on public.sessions
  using ((((required_tag_id is null) and ((reveal_at is null) or (reveal_at <= now())))
          or (select is_staff())));

-- ── 3. the club page's list and the members' upcoming rides ───────────────────────────────────
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
       and s.session_date >= v_today order by s.session_date limit 8) t;
  select value into v_ann from site_content where key = 'site.announce.messages';
  return jsonb_build_object('ok', true, 'member', true, 'first_name', split_part(coalesce(c.name,''), ' ', 1),
    'since', case when v_since is not null then to_timestamp(v_since / 1000.0) end,
    'credits', v_credits, 'tier', v_tier, 'next', case v_tier when 0 then v_pro when 1 then v_leg end,
    'rides', v_rides, 'group_rides', v_group, 'last', v_last, 'upcoming', v_next,
    'birth_date', c.birth_date, 'announcements', coalesce(v_ann, '[]'::jsonb));
end $function$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261028100000', 'session_gender_visible')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): definer kept on all three, no gender clause left in them or in the policy, the guard still there.
select (select bool_and(prosecdef) from pg_proc
         where oid in ('public.list_sessions(text,text)'::regprocedure, 'public.club_rides()'::regprocedure,
                       'public.member_area(text,text)'::regprocedure)) as all_definer,
       (select count(*) from pg_proc
         where oid in ('public.list_sessions(text,text)'::regprocedure, 'public.club_rides()'::regprocedure,
                       'public.member_area(text,text)'::regprocedure)
           and prosrc ~ 'gender_only') as still_gendered,
       (select qual from pg_policies where schemaname = 'public' and tablename = 'sessions'
         and policyname = 'read ungated or staff') as read_policy,
       (select count(*) from pg_trigger where tgname = 'queue_entries_gender_guard') as guard_kept,
       (select version from supabase_migrations.schema_migrations where version = '20261028100000') as ledger;
