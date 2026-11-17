-- ============================================================================
-- Mentees are anonymous: a member sees a mentee's profile number, university and field of study, nothing else (the
-- user, 2026-11-18: "i want mentees to be anonymous, only show their university and major").
--
--  mentor_feed: an open profile ('profiles') and a mentor's own offers ('offers') no longer carry the mentee's city,
--  country, class year, the help they want or their goal. Those stay in mentor_profiles for staff, who match on them.
--  The mentee's own request ('ask') is unchanged: it is their own data. After a match the student accepted, the mentor
--  still gets the student's first name and WhatsApp number, as before.
--  Rebuilt from the live text of 20261114050000 (md5 92f309c2b48254df405f8e4008b64e8d on prod and staging, 2026-11-18);
--  only the two lists change. Prod held no open profile and no live offer when this was written.
--
-- Rollback: put 'city', 'country', 'class_year', 'helps', 'goal' back in 'profiles' and 'city', 'country', 'class_year'
-- in 'offers' (the text in 20261114050000).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.mentor_feed(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_mine mentor_profiles%rowtype; v_ask jsonb := null;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;

  select * into v_mine from mentor_profiles where customer_id = p_id and status in ('pending', 'open', 'matched')
   order by created_at desc limit 1;
  if found then
    v_ask := jsonb_build_object(
      'num', v_mine.num, 'status', v_mine.status, 'university', v_mine.university, 'field', v_mine.field,
      'city', v_mine.city, 'country', v_mine.country, 'class_year', v_mine.class_year, 'helps', to_jsonb(v_mine.helps),
      'goal', v_mine.goal, 'gender_pref', v_mine.gender_pref,
      'proposed', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'links', to_jsonb(o.links), 'helps', to_jsonb(o.helps),
                                                                'summary', o.summary) order by o.proposed_at)
                              from mentor_offers o where o.profile_id = v_mine.id and o.status = 'proposed'), '[]'::jsonb),
      'matches', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', _mentor_first(o.mentor_id),
                                                               'wa', _mentor_wa(o.mentor_id), 'at', o.matched_at,
                                                               'links', to_jsonb(o.links), 'helps', to_jsonb(o.helps),
                                                               'summary', o.summary,
                                                               'due', _mentor_due(o.id, 'student', o.matched_at)) order by o.matched_at)
                             from mentor_offers o where o.profile_id = v_mine.id and o.status = 'matched'), '[]'::jsonb));
  end if;

  return jsonb_build_object(
    'ok', true,
    'ask', v_ask,
    'mentor', (select jsonb_build_object('university', m.university, 'field', m.field, 'work', m.work, 'places', m.places,
                                         'helps', to_jsonb(m.helps), 'about', m.about)
                 from mentor_mentors m where m.customer_id = p_id and m.status = 'active'),
    -- another member's profile: its number, university and field only (2026-11-18)
    'profiles', coalesce((select jsonb_agg(jsonb_build_object(
                   'num', p.num, 'university', p.university, 'field', p.field,
                   'offered', (select o.status from mentor_offers o where o.profile_id = p.id and o.mentor_id = p_id
                                 and o.status in ('offered', 'proposed', 'matched') limit 1)) order by p.num)
                 from mentor_profiles p where p.status = 'open' and p.customer_id <> p_id and p.num is not null), '[]'::jsonb),
    'offers', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', o.id, 'num', p.num, 'university', p.university, 'field', p.field, 'status', o.status,
                 'name', case when o.status = 'matched' then _mentor_first(p.customer_id) end,
                 'wa', case when o.status = 'matched' then _mentor_wa(p.customer_id) end,
                 'at', o.matched_at,
                 'due', case when o.status = 'matched' then _mentor_due(o.id, 'mentor', o.matched_at) else false end)
                 order by (o.status = 'matched') desc, o.created_at desc)
               from mentor_offers o join mentor_profiles p on p.id = o.profile_id
              where o.mentor_id = p_id
                and (o.status in ('offered', 'proposed', 'matched')
                     or (o.status in ('declined', 'ended') and o.ended_at > now() - interval '14 days'))), '[]'::jsonb));
end $$;
revoke all on function public.mentor_feed(text, text) from public;
grant execute on function public.mentor_feed(text, text) to anon, authenticated;

do $chk$
declare f text := 'public.mentor_feed(text,text)'; d text;
begin
  d := pg_get_functiondef(f::regprocedure);
  if not (select prosecdef from pg_proc where oid = f::regprocedure) then raise exception 'mentor_feed is not a definer'; end if;
  if position('''city'', p.city' in d) > 0 or position('''goal'', p.goal' in d) > 0 or position('p.class_year' in d) > 0
     or position('to_jsonb(p.helps)' in d) > 0 or position('p.country' in d) > 0 then
    raise exception 'mentor_feed still sends a mentee''s details to other members';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261118120000', 'mentee_anonymous')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): a definer, executable by anon (the token decides), no mentee detail but number, university and
-- field in another member's lists, the ledger.
select (select prosecdef from pg_proc where oid = 'public.mentor_feed(text,text)'::regprocedure) as feed_definer,
       (select proconfig from pg_proc where oid = 'public.mentor_feed(text,text)'::regprocedure) as feed_config,
       has_function_privilege('anon', 'public.mentor_feed(text,text)', 'execute') as anon_can_call,
       position('p.city' in pg_get_functiondef('public.mentor_feed(text,text)'::regprocedure)) = 0 as no_city,
       position('p.goal' in pg_get_functiondef('public.mentor_feed(text,text)'::regprocedure)) = 0 as no_goal,
       md5(pg_get_functiondef('public.mentor_feed(text,text)'::regprocedure)) as feed_md5,
       (select name from supabase_migrations.schema_migrations where version = '20261118120000') as ledger;
