-- ============================================================================
-- Perfect Week and Perfect Month (the owner, 2026-09-29: "a badge for whoever participates in all
-- sessions in a week and a badge for who does that for 4 weeks in a row"; every session counts -
-- circuit nights, the Petromin night, the Saturday ride, swims, workshops, special rides).
--
-- The app earns them from the rider's own rides (_mrBadges), but a rider's page knows only the
-- sessions they rode, so it reads each week's sessions through badge_weeks(): per week (Sunday to
-- Saturday, the KSA week), the ids of every session not deleted, up to the end of this week. The
-- schedule only; nothing about any rider. A week of fewer than two sessions is left out by the app.
-- ============================================================================

create or replace function public.badge_weeks()
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  with today as (select (now() at time zone 'Asia/Riyadh')::date as d),
  s as (
    select id, session_date::date as d
      from sessions
     where coalesce(status, '') <> 'deleted'
       and session_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  )
  select coalesce(jsonb_agg(jsonb_build_object('w', w, 'ids', ids) order by w), '[]'::jsonb)
    from (select to_char(s.d - extract(dow from s.d)::int, 'YYYY-MM-DD') as w,
                 jsonb_agg(s.id order by s.d, s.id) as ids
            from s, today
           where s.d <= today.d + (6 - extract(dow from today.d)::int)
           group by 1) x
$$;

revoke execute on function public.badge_weeks() from public;
grant  execute on function public.badge_weeks() to anon, authenticated;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort, rule) values
  ('bd_perfect_week', 'perfect_week', 'calstar', 'purple', 'Perfect Week', 'الأسبوع المثالي',
   'Every session in one week, Sunday to Saturday', 'كل جلسات الأسبوع، من الأحد إلى السبت', true, true, 272, null),
  ('bd_perfect_month', 'perfect_month', 'calcrown', 'gold', 'Perfect Month', 'الشهر المثالي',
   'A Perfect Week four weeks in a row', 'أسبوع مثالي أربعة أسابيع متتالية', true, true, 274, null)
on conflict (id) do nothing;
