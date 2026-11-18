-- ============================================================================
-- Ramadan season 2027 (the user, 2026-11-18, picked from the Community features list: "Ramadan season (about 8 Feb
-- to 8 Mar 2027): a Ramadan challenge from the existing template, a season badge, an Eid ride and a Ramadan look for
-- the tab").
--
--  1. Two badges the database gives (both held_only: only a member who holds one sees it, as the event badges):
--       bd_ramadan_2027  "Ramadan 2027" / "رمضان 2027", the app's own crescent (BDG_GLYPH.crescent), blue
--       bd_eid_2027      "Eid 2027" / "عيد 2027", the app's own lantern (BDG_GLYPH.lantern), gold
--  2. goal_ramadan_2027: a staff season challenge made from the staff template "Ramadan Rhythm: 2 Sessions"
--     (AC_TEMPLATES 'ramadan' in app.src.html: kind challenge, scope community, target 2, its English and Arabic
--     names), dated from hub_ramadan's 2027 row (seeded as projected by 20261114000100: 8 February to 9 March 2027;
--     the template's own expected dates if the row is gone), ramadan_any on (any session during Ramadan counts,
--     _hub_goal_n), its badge bd_ramadan_2027.
--  3. goal_eid_2027: "Eid Ride" / "رحلة العيد", target 1, any community session from Eid al-Fitr day (the day after
--     hub_ramadan's last day) to the following Saturday inclusive (a Saturday Eid runs to the next one), scope
--     community, ramadan_any off, its badge bd_eid_2027. No session is made: staff make the Eid ride in the session
--     editor.
--     Both rows are seeded once (on conflict do nothing). If staff later move hub_ramadan (the moon sighting), these
--     two keep their dates: staff change them in Community > Activities > Challenges (Edit on the challenge's row).
--     created_at is the first day's midnight in Riyadh, so the tab's dot (hub_pulse: a running challenge made after
--     the member's last open) lights when each one starts, as a challenge staff make on its first day does.
--     hub_feed and hub_pulse show a staff challenge only while today is between its first and last day, and
--     _hub_award looks only at challenges already started: neither appears before Ramadan, and there is no
--     "starts on" state.
--  4. hub_season(p_id, p_token): the tab's one read of the dates, for its Ramadan look (a "Ramadan Kareem" card and a
--     night-blue and gold accent while Ramadan runs; "Eid Mubarak" on Eid al-Fitr's first three days). hub_ramadan is
--     staff-only, and hub_feed is not rebuilt for it: a small token-checked, members-only definer function answers
--     {ok, today, ramadan: {year, starts_on, ends_on, eid_on} | null}: the Ramadan running now or the next one, kept
--     until its third Eid day is over. Gregorian dates only (no Hijri anywhere: the owner declined them). It reads
--     only. New function, so no earlier header to copy; its attributes are hub_month's (20261114081300: plpgsql,
--     stable, security definer, search_path public).
--
-- Safe before or after the app: without hub_season the tab has no Ramadan look and says nothing; the badges and the
-- challenges reach members through hub_feed as any staff challenge does, and the crescent draws as the medal on a page
-- that does not know it yet.
--
-- Rollback:
--   delete from public.hub_goals where id in ('goal_ramadan_2027', 'goal_eid_2027');
--   drop function if exists public.hub_season(text, text);
--   (the two badges stay while anyone holds one: customer_badges restricts their delete; retire them instead)
--   update public.badges set retired = true where id in ('bd_ramadan_2027', 'bd_eid_2027');
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. the badges ────────────────────────────────────────────────────────────────────────────────
insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort, held_only) values
  ('bd_ramadan_2027', 'ramadan_2027', 'crescent', 'blue', 'Ramadan 2027', 'رمضان 2027',
   'Two sessions during Ramadan 2027.', 'مشاركتان خلال رمضان 2027.', true, true, 99, true),
  ('bd_eid_2027', 'eid_2027', 'lantern', 'gold', 'Eid 2027', 'عيد 2027',
   'A session in the Eid al-Fitr week 2027.', 'مشاركة في أسبوع عيد الفطر 2027.', true, true, 100, true)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true, retired = false,
  sort = excluded.sort, held_only = true;

-- ── 2 and 3. the two challenges, from hub_ramadan's 2027 row ─────────────────────────────────────
insert into public.hub_goals (id, kind, name, name_ar, scope, target, starts_on, ends_on, badge_id, ramadan_any, created_at)
select 'goal_ramadan_2027', 'challenge', 'Ramadan Rhythm: 2 Sessions', 'إيقاع رمضان: مشاركتان', 'community', 2,
       r.starts_on, r.ends_on, 'bd_ramadan_2027', true, r.starts_on::timestamp at time zone 'Asia/Riyadh'
  from (select coalesce((select starts_on from public.hub_ramadan where year = 2027), date '2027-02-08') as starts_on,
               coalesce((select ends_on from public.hub_ramadan where year = 2027), date '2027-03-09') as ends_on) r
on conflict (id) do nothing;

insert into public.hub_goals (id, kind, name, name_ar, scope, target, starts_on, ends_on, badge_id, ramadan_any, created_at)
select 'goal_eid_2027', 'challenge', 'Eid Ride', 'رحلة العيد', 'community', 1,
       e.eid, e.eid + ((5 - extract(isodow from e.eid)::int + 7) % 7) + 1, 'bd_eid_2027', false,
       e.eid::timestamp at time zone 'Asia/Riyadh'
  from (select coalesce((select ends_on from public.hub_ramadan where year = 2027), date '2027-03-09') + 1 as eid) e
on conflict (id) do nothing;

-- ── 4. the tab's read of Ramadan's dates ─────────────────────────────────────────────────────────
create or replace function public.hub_season(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_today date := _ksa_today();
  r hub_ramadan%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  -- the Ramadan running now, or the next one; kept until its third Eid day is over
  select h.* into r from hub_ramadan h where h.ends_on + 3 >= v_today order by h.starts_on limit 1;
  return jsonb_build_object('ok', true, 'today', v_today,
    'ramadan', case when r.year is not null then jsonb_build_object('year', r.year, 'starts_on', r.starts_on,
                 'ends_on', r.ends_on, 'eid_on', r.ends_on + 1) end);
end $$;
revoke all on function public.hub_season(text, text) from public;
grant execute on function public.hub_season(text, text) to anon, authenticated;

-- ── checks ─────────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public.hub_season(text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if not has_function_privilege('anon', 'public.hub_season(text,text)', 'execute') then
    raise exception 'the page cannot reach hub_season';
  end if;
  if (select count(*) from public.badges where id in ('bd_ramadan_2027', 'bd_eid_2027') and system and auto and held_only and not retired) <> 2 then
    raise exception 'a Ramadan season badge is missing';
  end if;
  if (select count(*) from public.hub_goals g join public.badges b on b.id = g.badge_id
       where g.id in ('goal_ramadan_2027', 'goal_eid_2027') and g.kind = 'challenge') <> 2 then
    raise exception 'a Ramadan season challenge is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261118210900', 'ramadan_season')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only): the two challenges with their dates, badges and Ramadan flag; the function is definer; the ledger row.
--   select g.id, g.starts_on, g.ends_on, g.target, g.scope, g.ramadan_any, b.slug, b.icon, b.held_only
--     from public.hub_goals g join public.badges b on b.id = g.badge_id
--    where g.id in ('goal_ramadan_2027', 'goal_eid_2027') order by g.starts_on;
--   -- expect goal_ramadan_2027 2027-02-08 2027-03-09 2 community t ramadan_2027 crescent t
--   --        goal_eid_2027     2027-03-10 2027-03-13 1 community f eid_2027     lantern  t
--   select prosecdef from pg_proc where oid = 'public.hub_season(text,text)'::regprocedure;   -- t
--   select version, name from supabase_migrations.schema_migrations where version = '20261118210900';
