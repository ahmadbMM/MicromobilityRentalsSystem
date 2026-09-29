-- ============================================================================
-- Every badge a rider can see (the owner, 2026-09-29: "why aren't all the badges showing in my
-- account page"). The account page now shows the whole catalogue - the badges not earned greyed,
-- with how to earn them - except National Day 96 and Back on Track, which wait until earned. badges
-- is staff-only, so the page reads the catalogue through this: every badge that is not retired, its
-- look and its words. Nothing about any rider. Without it the app shows its own built-in badges,
-- which leaves out the ones an admin makes and keeps a retired built-in one on show.
-- ============================================================================

create or replace function public.badge_catalog()
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'slug', slug, 'icon', icon, 'color', color, 'name', name, 'name_ar', name_ar,
           'description', description, 'description_ar', description_ar,
           'system', system, 'auto', auto, 'sort', sort)
         order by sort, slug), '[]'::jsonb)
    from badges
   where not retired
$$;

revoke execute on function public.badge_catalog() from public;
grant  execute on function public.badge_catalog() to anon, authenticated;
