-- ============================================================================
-- The Talent Scout badge (2026-11-12, the user: "create a new badge for helping hire a micromobilian make only
-- visible for its holders").
--
-- Staff-given (Community > Badges, Give to a rider), like Volunteer: nothing in the data says who helped us hire
-- someone. A rider sees it only once they hold it: the app and the website leave it out of Badges to earn and
-- out of Request a badge (BDG_HELD_ONLY / HELD_ONLY), so nobody else knows it is there.
--
-- The app draws it itself (BD_SYS talent_scout: a team pass on its lanyard, a person on the card, on the gold
-- medal) and words it in every language; the columns here are the English and Arabic fallback.
--
-- Safe before or after the app. Until this runs the badge cannot be given.
--
-- Undo (only while nobody has been given it):
--   delete from public.badges where id = 'bd_talent_scout';
-- ============================================================================

begin;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort) values
  ('bd_talent_scout', 'talent_scout', 'pass', 'gold', 'Talent Scout', 'كاشف المواهب',
   'Help MicroMobility hire a new Micromobilian.', 'ساعد مايكروموبيليتي في توظيف عضو جديد في فريقها.', true, false, 86)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = false, retired = false,
  sort = excluded.sort;

do $chk$
begin
  if (select count(*) from public.badges where slug = 'talent_scout' and system and not auto and not retired) <> 1 then
    raise exception 'the Talent Scout badge is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261112160000', 'talent_scout_badge')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
