-- ============================================================================
-- The Blood Donation Visitor badge (2026-11-06, the owner: "add a badge for yesterday's blood donation event for
-- visitors who visited and were checked out").
--
-- Earned: the app reads the rider's own bookings (my_bookings returns blood_role and status) and gives it for a
-- visitor's booking on a Blood Donation session that staff checked out (status done). Undoing the check-out takes
-- it back. Shown only to those who hold it, like Blood Donor.
--
-- The app draws it itself (BD_SYS blood_visitor: the drop's outline with a heart inside, on the teal medal) and
-- words it in every language; the columns here are the English and Arabic fallback.
--
-- Safe before or after the app. Until this runs Community > Badges does not list it; a rider who earned it sees
-- theirs either way.
--
-- Undo:
--   delete from public.badges where id = 'bd_blood_visitor';
-- ============================================================================

begin;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort) values
  ('bd_blood_visitor', 'blood_visitor', 'dropo', 'teal', 'Blood Donation Visitor', 'زائر حملة التبرع بالدم', 'Visit one of our blood donation events.', 'زُر إحدى فعالياتنا للتبرع بالدم.', true, true, 92)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true, retired = false,
  sort = excluded.sort;

do $chk$
begin
  if not exists (select 1 from public.badges where slug = 'blood_visitor' and system and auto and not retired) then
    raise exception 'the Blood Donation Visitor badge is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261106100000', 'blood_visitor_badge')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
