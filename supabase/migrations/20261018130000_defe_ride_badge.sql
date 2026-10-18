-- Rode with Defe (the owner, 2026-10-18: "create a badge for next saturday's social ride in collaboration with
-- defe"; picked design A, everyone who rides, this name). The app earns it for a rider checked in (on the bike or
-- done) on the Saturday ride with Defe, 24 October 2026 (session 2026-10-24, DEFE_RIDE_IDS), members and Defe's
-- riders alike. It shows only to those who rode it, drawn rose into berry (the colour here is only what the table
-- can hold), and pops up once. Staff may still give it by hand to a rider who rode without being checked in.
--
-- Undo: delete from public.customer_badges where badge_id = 'bd_defe_ride'; delete from public.badges where id = 'bd_defe_ride';

begin;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort)
values ('bd_defe_ride', 'defe_ride', 'defewheel', 'red', 'Rode with Defe', 'ركبت مع دفء',
        'Ride the Saturday social ride with Defe on 24 October 2026', 'شارك في جولة السبت الاجتماعية مع دفء يوم 24 أكتوبر 2026',
        true, true, 94)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true, retired = false,
  sort = excluded.sort;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261018130000', 'defe_ride_badge')
on conflict (version) do nothing;

commit;

-- Check: one row, defe_ride, auto, system, not retired.
select id, slug, icon, sort, system, auto, retired from public.badges where slug = 'defe_ride';
