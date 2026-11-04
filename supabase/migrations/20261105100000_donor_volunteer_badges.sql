-- ============================================================================
-- The Blood Donor and Volunteer badges (2026-11-05, the owner: "add a badge for who donates blood and a badge
-- for volunteers", of four designs each: Blood Donor D, Volunteer A; "let staff give it by hand").
--
-- Blood Donor is earned: the app reads staff's Donated mark on the rider's own bookings (queue_entries.donated_at,
-- which my_bookings already returns), so the mark taken back takes the badge back. It is shown only to those who
-- hold it. Volunteer is staff-given (Community > Badges, Give to a rider), like Marshal or T100.
--
-- The app draws both itself (BD_SYS blood_donor: a drop with a heart on the red medal; volunteer: a raised hand on
-- its own blue special medal, which the colour check cannot hold, so the table says blue) and words them in every
-- language; the columns here are the English and Arabic fallback.
--
-- Safe before or after the app. Until this runs the Volunteer badge cannot be given, and Community > Badges does
-- not list Blood Donor; a rider marked Donated sees theirs either way.
--
-- Undo (only while nobody has been given Volunteer):
--   delete from public.badges where id in ('bd_blood_donor', 'bd_volunteer');
-- ============================================================================

begin;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort) values
  ('bd_blood_donor', 'blood_donor', 'drop', 'red',  'Blood Donor', 'متبرع بالدم', 'Donate blood at one of our events.', 'تبرّع بالدم في إحدى فعالياتنا.', true, true,  91),
  ('bd_volunteer',   'volunteer',   'hand', 'blue', 'Volunteer',   'متطوع',       'Volunteer at one of our events.',  'تطوّع في إحدى فعالياتنا.',       true, false, 81)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = excluded.auto, retired = false,
  sort = excluded.sort;

do $chk$
begin
  if (select count(*) from public.badges where (slug = 'blood_donor' and system and auto and not retired)
                                             or (slug = 'volunteer' and system and not auto and not retired)) <> 2 then
    raise exception 'the Blood Donor and Volunteer badges are missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261105100000', 'donor_volunteer_badges')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
