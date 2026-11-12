-- ============================================================================
-- Who sees a badge, and the Swimming Instructor badge (2026-11-12, the user: "create a swimming instructor
-- badge to only be [visible] to it's holders, add a switch to all badges that has to do with the visibility
-- of the badges to customers and members").
--
-- badges.held_only: every badge now has a "Customers and members see it" switch in Community > Badges. On
-- (held_only false), every rider sees the badge on their account page, greyed under Badges to earn until
-- they have it, and can ask for it. Off (held_only true), only a rider who holds it sees it. Admins set it,
-- like the rest of the catalogue ("admin update" policy). The badges that were already kept out of sight
-- start switched off: the event and surprise badges (National Day 96, Run for Her, DEFE 5KM Run, Victory
-- Lap, Rode with Defe, Blood Donor, Blood Donation Visitor, Back on Track) and Talent Scout. A database
-- without the column leaves the app and the website to that same list (BDG_HELD_ONLY / HELD_ONLY).
--
-- badge_catalog: the same badges as before (every one not retired), now with held_only, which the riders'
-- app and the website read. Same attributes as the live function (stable, security definer, search_path).
--
-- Swimming Instructor (swim_instructor): staff-given (Give to a rider), switched off from the start. The
-- app draws it itself (a swimmer's front crawl above the water, glyph swim, on the blue medal) and words it
-- in every language; the columns here are the English and Arabic fallback.
--
-- Safe before or after the app: the app reads held_only only where the catalogue carries it.
--
-- Undo:
--   delete from public.badges where id = 'bd_swim_instructor';   -- only while nobody holds it
--   (re-create badge_catalog from 20260929030000_badge_catalog.sql)
--   alter table public.badges drop column held_only;
-- ============================================================================

begin;

alter table public.badges add column if not exists held_only boolean not null default false;
grant select (held_only), insert (held_only), update (held_only) on public.badges to authenticated;

insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort, held_only) values
  ('bd_swim_instructor', 'swim_instructor', 'swim', 'blue', 'Swimming Instructor', 'مدرّب سباحة',
   'Teach swimming in our community.', 'علّم السباحة في مجتمعنا.', true, false, 87, true)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = false, retired = false,
  sort = excluded.sort, held_only = true;

update public.badges set held_only = true
 where slug in ('talent_scout', 'swim_instructor', 'national_day_96', 'run_for_her', 'defe_5k', 'victory_lap',
                'defe_ride', 'blood_donor', 'blood_visitor', 'back_on_track')
   and not held_only;

create or replace function public.badge_catalog()
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'slug', slug, 'icon', icon, 'color', color, 'name', name, 'name_ar', name_ar,
           'description', description, 'description_ar', description_ar,
           'system', system, 'auto', auto, 'sort', sort, 'held_only', held_only)
         order by sort, slug), '[]'::jsonb)
    from badges
   where not retired
$$;

revoke execute on function public.badge_catalog() from public;
grant  execute on function public.badge_catalog() to anon, authenticated;

do $chk$
begin
  if (select count(*) from public.badges where slug = 'swim_instructor' and system and not auto and not retired and held_only) <> 1 then
    raise exception 'the Swimming Instructor badge is missing';
  end if;
  if exists (select 1 from public.badges where slug in ('talent_scout', 'national_day_96', 'run_for_her', 'back_on_track') and not held_only) then
    raise exception 'a badge kept out of sight came out switched on';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.badge_catalog()'::regprocedure) then
    raise exception 'badge_catalog lost security definer';
  end if;
  if not exists (select 1 from jsonb_array_elements(public.badge_catalog()) x where x ? 'held_only') then
    raise exception 'badge_catalog does not carry held_only';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261112223000', 'badge_visibility')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
