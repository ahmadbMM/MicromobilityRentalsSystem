-- ============================================================================
-- The T100 races in Jeddah (2026-10-08, the owner: "do badges for completing the t100 races that
-- will take place in jeddah, T100 T50 T25").
--
-- Three staff-given badges, one per race distance. The races are not ours, so nothing in the
-- bookings says who finished: staff give each badge by hand (Community > Badges, Give to a rider),
-- like Champion. The app draws them itself (BD_SYS t100 / t50 / t25: the distance in figures over
-- a swim wave, gold / silver / orange) and words them in every language; the columns here are the
-- English and Arabic fallback.
--
-- Undo (only while nobody holds one):
--   delete from public.badges where id in ('bd_t100', 'bd_t50', 'bd_t25');
-- ============================================================================

begin;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort) values
  ('bd_t100', 't100', 't100', 'gold',   'T100 Finisher', 'إنجاز T100', 'Finished the T100 race in Jeddah', 'أنهيت سباق T100 في جدة', true, false, 75),
  ('bd_t50',  't50',  't50',  'silver', 'T50 Finisher',  'إنجاز T50',  'Finished the T50 race in Jeddah',  'أنهيت سباق T50 في جدة',  true, false, 76),
  ('bd_t25',  't25',  't25',  'orange', 'T25 Finisher',  'إنجاز T25',  'Finished the T25 race in Jeddah',  'أنهيت سباق T25 في جدة',  true, false, 77)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = false, retired = false,
  sort = excluded.sort;

do $chk$
begin
  if (select count(*) from public.badges where slug in ('t100', 't50', 't25') and system and not auto and not retired) <> 3 then
    raise exception 'the T100 badges are missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261008120000', 't100_badges')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
