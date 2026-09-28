-- ============================================================================
-- Badges staff give (2026-09-29).
--
-- Until now every badge on a rider's account page was worked out on their device from their ride
-- history, and nothing was stored, so staff had no way to give one. Now:
--   badges           the catalogue: the app's own badges (system; their names and how-to-earn
--                    lines come from the app's translations, the columns here are the English
--                    fallback) and the ones admins make (their own English and Arabic words).
--                    A badge is drawn, never an emoji (the owner, 2026-09-29): `icon` names one of
--                    the app's badge icons (BDG_GLYPH) and `color` one of its eight colours.
--                    `auto` marks the nine the app also awards for riding; staff may still give
--                    any of them by hand (rides from before the account existed, for one).
--   customer_badges  who holds which: one row per rider and badge, with an optional note the
--                    rider reads, the ride it was given for and who gave it.
-- Both are staff-only (RLS). Any staff member gives and takes back badges; only admins change the
-- catalogue. A badge somebody holds cannot be deleted (on delete restrict): it is retired, which
-- takes it off the Give list while its holders keep it.
-- The rider reads their own badges through customer_my_badges (token-checked). An account merged
-- into another keeps its rows, and the keeper's read includes them: nothing moves on a merge, so
-- an unmerge needs nothing either.
-- ============================================================================

create table if not exists public.badges (
  id             text primary key,
  slug           text not null unique check (slug ~ '^[a-z][a-z0-9_]{1,39}$'),
  icon           text not null check (icon ~ '^[a-z][a-z0-9_]{1,23}$'),
  color          text not null default 'green'
                 check (color in ('green', 'gold', 'blue', 'red', 'purple', 'orange', 'teal', 'silver')),
  name           text not null check (char_length(btrim(name)) between 1 and 40),
  name_ar        text check (char_length(name_ar) <= 40),
  description    text check (char_length(description) <= 140),
  description_ar text check (char_length(description_ar) <= 140),
  system         boolean not null default false,
  auto           boolean not null default false,
  retired        boolean not null default false,
  sort           integer not null default 500,
  created_at     timestamptz not null default now()
);

create table if not exists public.customer_badges (
  customer_id text not null references public.customers(id) on delete cascade,
  badge_id    text not null references public.badges(id) on delete restrict,
  note        text check (char_length(note) <= 140),
  session_id  text,
  awarded_by  text check (char_length(awarded_by) <= 60),
  awarded_at  timestamptz not null default now(),
  primary key (customer_id, badge_id)
);
create index if not exists customer_badges_badge_idx on public.customer_badges (badge_id);

alter table public.badges enable row level security;
alter table public.customer_badges enable row level security;

drop policy if exists "staff read" on public.badges;
drop policy if exists "admin insert" on public.badges;
drop policy if exists "admin update" on public.badges;
drop policy if exists "admin delete" on public.badges;
create policy "staff read"   on public.badges for select to authenticated using ((select is_staff()));
create policy "admin insert" on public.badges for insert to authenticated with check ((select is_admin()));
create policy "admin update" on public.badges for update to authenticated using ((select is_admin())) with check ((select is_admin()));
create policy "admin delete" on public.badges for delete to authenticated using ((select is_admin()) and not system);

drop policy if exists "staff full" on public.customer_badges;
create policy "staff full" on public.customer_badges for all to authenticated
  using ((select is_staff())) with check ((select is_staff()));

revoke all on public.badges, public.customer_badges from public, anon;
grant select, insert, update, delete on public.badges, public.customer_badges to authenticated;

-- The app's own badges. The first nine are the ones it has always worked out from ride history.
insert into public.badges (id, slug, icon, color, name, description, system, auto, sort) values
  ('bd_first_lap', 'first_lap', 'flag', 'green', 'First Lap', 'Completed your first circuit ride', true, true, 100),
  ('bd_regular', 'regular', 'wheel', 'teal', 'Grid Regular', '5 rides on the grid', true, true, 110),
  ('bd_podium', 'podium', 'podium', 'purple', 'Podium Pace', '10 rides strong', true, true, 120),
  ('bd_front_row', 'front_row', 'one', 'gold', 'Front Row', 'Held booking #1 in a session', true, true, 130),
  ('bd_carbon', 'carbon', 'bike', 'silver', 'Carbon Club', 'Rode the Road Carbon', true, true, 140),
  ('bd_streak', 'streak', 'flame', 'orange', 'Hot Streak', 'Rode 3 weeks in a row', true, true, 150),
  ('bd_squad', 'squad', 'people', 'blue', 'Squad Captain', 'Booked for 3+ riders at once', true, true, 160),
  ('bd_fuel', 'fuel', 'bottle', 'red', 'Fuel Stop', 'Added extras to a booking', true, true, 170),
  ('bd_corniche25', 'corniche25', 'wave', 'blue', 'Corniche 25', '25 rides on the corniche', true, true, 180),
  -- Given by hand only.
  ('bd_marshal', 'marshal', 'shield', 'orange', 'Marshal', 'Led or swept a group ride, or helped run an event', true, false, 10),
  ('bd_pit_crew', 'pit_crew', 'wrench', 'silver', 'Pit Crew', 'Helped another rider out on a ride', true, false, 20),
  ('bd_green_flag', 'green_flag', 'wflag', 'green', 'Green Flag', 'Rode with care for the people around you', true, false, 30),
  ('bd_super_licence', 'super_licence', 'card', 'purple', 'Super Licence', 'Finished Learn to ride and now rides on your own', true, false, 40),
  ('bd_scrutineer', 'scrutineer', 'search', 'teal', 'Scrutineer', 'Reported a bike fault the team confirmed', true, false, 50),
  ('bd_champion', 'champion', 'trophy', 'gold', 'Champion', 'Won a MicroMobility challenge or event', true, false, 60),
  ('bd_spirit', 'spirit', 'heart', 'red', 'Race Spirit', 'Showed great sportsmanship on a ride', true, false, 70)
on conflict (id) do nothing;

-- The signed-in rider's badges given by staff, each once (an account merged into this one brings
-- its own; the earliest of two copies of the same badge stands).
-- [{slug, icon, color, name, name_ar, description, description_ar, system, note, at}], null on a bad token.
create or replace function public.customer_my_badges(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not _cust_token_ok(p_id, p_token) then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'slug', b.slug, 'icon', b.icon, 'color', b.color, 'name', b.name, 'name_ar', b.name_ar,
             'description', b.description, 'description_ar', b.description_ar, 'system', b.system,
             'note', x.note, 'at', x.awarded_at) order by x.awarded_at)
      from (select distinct on (cb.badge_id) cb.badge_id, cb.note, cb.awarded_at
              from customer_badges cb join customers c on c.id = cb.customer_id
             where c.id = p_id or c.merged_into = p_id
             order by cb.badge_id, cb.awarded_at) x
      join badges b on b.id = x.badge_id), '[]'::jsonb);
end $$;

revoke execute on function public.customer_my_badges(text, text) from public;
grant  execute on function public.customer_my_badges(text, text) to anon, authenticated;
