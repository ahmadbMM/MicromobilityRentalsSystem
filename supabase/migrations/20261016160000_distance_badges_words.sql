-- ============================================================================
-- The distance badges' words (the owner, 2026-10-16: "don't include community rides in the badges that
-- include a distance"): "Rode 20 km on community rides" becomes "Cycled 20 km" - the badges are for cycling.
-- How they are earned is unchanged (20261016120000).
-- ============================================================================

begin;

update public.badges set description = 'Cycled 20 km', description_ar = 'قطعت 20 كم على الدراجة' where slug = 'km20';
update public.badges set description = 'Cycled 40 km', description_ar = 'قطعت 40 كم على الدراجة' where slug = 'km40';
update public.badges set description = 'Cycled 70 km', description_ar = 'قطعت 70 كم على الدراجة' where slug = 'km70';
update public.badges set description = 'Cycled 100 km', description_ar = 'قطعت 100 كم على الدراجة' where slug = 'km100';

do $chk$
begin
  if (select count(*) from public.badges where slug in ('km20', 'km40', 'km70', 'km100') and description like 'Cycled %') <> 4 then
    raise exception 'the distance badges were not reworded';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261016160000', 'distance_badges_words')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
