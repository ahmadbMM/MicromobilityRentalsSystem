-- ============================================================================
-- The tag redesign (the user's picks on the tag redesign page, 2026-11-15): three staff tags change colour. The app
-- draws them from TAG_BRANDS, so this only keeps the tags rows (the Tags page's colour field, anything that reads
-- tags.color) in step with what staff see:
--   influencer    #c2255c magenta  -> #862e9c plum   (a white star, was a megaphone)
--   food blogger  #6f2dbd aubergine -> #0b7285 teal  (a fork and knife cut out of a speech bubble)
--   food worker   #8a4b1f chocolate -> #475569 slate (a worker in a chef's hat)
-- Data only: no function, no grant, no policy changes. Idempotent.
--
-- Rollback:
--   update public.tags set color = '#c2255c' where id = 'tag_influencer';
--   update public.tags set color = '#6f2dbd' where id = 'tag_food_blogger';
--   update public.tags set color = '#8a4b1f' where id = 'tag_food_worker';
-- ============================================================================

begin;

update public.tags set color = '#862e9c' where id = 'tag_influencer';
update public.tags set color = '#0b7285' where id = 'tag_food_blogger';
update public.tags set color = '#475569' where id = 'tag_food_worker';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261115235900', 'tag_redesign_colours')
on conflict (version) do nothing;

commit;

-- Check (read only): the three colours.
select id, color from public.tags where id in ('tag_influencer', 'tag_food_blogger', 'tag_food_worker') order by id;
