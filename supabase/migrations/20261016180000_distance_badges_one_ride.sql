-- ============================================================================
-- The distance badges count the longest single ride, not the kilometres added up (the owner, 2026-10-16:
-- "make it a badge for the distance in one ride not the total of kilometers"). The app works it out
-- (_mrBadges); this rewords the catalogue rows to "Cycled N km in one ride".
-- ============================================================================

begin;

update public.badges set description = 'Cycled 20 km in one ride', description_ar = 'قطعت 20 كم على الدراجة في جولة واحدة' where slug = 'km20';
update public.badges set description = 'Cycled 40 km in one ride', description_ar = 'قطعت 40 كم على الدراجة في جولة واحدة' where slug = 'km40';
update public.badges set description = 'Cycled 70 km in one ride', description_ar = 'قطعت 70 كم على الدراجة في جولة واحدة' where slug = 'km70';
update public.badges set description = 'Cycled 100 km in one ride', description_ar = 'قطعت 100 كم على الدراجة في جولة واحدة' where slug = 'km100';

do $chk$
begin
  if (select count(*) from public.badges where slug in ('km20', 'km40', 'km70', 'km100') and description like '% in one ride') <> 4 then
    raise exception 'the distance badges were not reworded';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261016180000', 'distance_badges_one_ride')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
