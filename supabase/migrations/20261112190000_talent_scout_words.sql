-- ============================================================================
-- Talent Scout's words (2026-11-12, the user: "its for helping someone from the community get hired outside of
-- micromobilty, or helped him get a job"). 20261112160000 worded it as helping MicroMobility hire; the badge is for
-- a community member who helped another member get a job, anywhere. Only the English and Arabic fallback of how it
-- is earned changes; the app and the website word it themselves in every language.
--
-- Safe before or after the app. Nobody held the badge when this was written.
-- ============================================================================

begin;

update public.badges
   set description    = 'Help a fellow Micromobilian get a job.',
       description_ar = 'ساعد أحد أفراد مجتمع مايكروموبيليتي في الحصول على وظيفة.'
 where slug = 'talent_scout';

do $chk$
begin
  if (select count(*) from public.badges where slug = 'talent_scout' and description = 'Help a fellow Micromobilian get a job.') <> 1 then
    raise exception 'the Talent Scout badge is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261112190000', 'talent_scout_words')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
