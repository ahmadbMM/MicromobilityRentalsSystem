-- ============================================================================
-- Ironman 140.6 brings Ironman 70.3 (2026-11-13, the user: "let earning the full ironman automatically award
-- the half ironman").
--
-- The app already stores the 70.3 with every 140.6 a staff member gives (_bdgWithLower, all give paths and the
-- Badge requests answer) and draws a 140.6 holder as holding both (BDG_LADDERS). This trigger makes the database
-- do it too, whoever writes the row: a 140.6 that goes into customer_badges puts the rider's 70.3 in beside it,
-- with the same note, ride, giver and time, unless the rider already holds it (then nothing changes). Taking
-- the 140.6 back leaves the 70.3, as taking back any higher level does.
--
-- It runs with the writer's rights: whoever may write the 140.6 (staff, under "staff full") may write the 70.3.
-- An AFTER trigger runs once the statement is done, so a give that already sends both rows (the app's) finds the
-- 70.3 there and adds nothing.
--
-- On 2026-11-13 nobody held the 140.6 (one rider held the 70.3), so there is nothing to backfill; the insert
-- below covers any 140.6 given between that check and this script.
--
-- Undo:
--   drop trigger if exists customer_badges_ironman_half on public.customer_badges;
--   drop function if exists public._badge_ironman_half();
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public._badge_ironman_half()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  half text;
begin
  if new.badge_id is distinct from (select id from badges where slug = 'ironman_1406') then return null; end if;
  select id into half from badges where slug = 'ironman_703' and not retired;
  if half is null then return null; end if;
  insert into customer_badges (customer_id, badge_id, note, session_id, awarded_by, awarded_at)
  values (new.customer_id, half, new.note, new.session_id, new.awarded_by, coalesce(new.awarded_at, now()))
  on conflict (customer_id, badge_id) do nothing;
  return null;
end $function$;
revoke all on function public._badge_ironman_half() from public, anon, authenticated;

drop trigger if exists customer_badges_ironman_half on public.customer_badges;
create trigger customer_badges_ironman_half after insert or update of badge_id on public.customer_badges
  for each row execute function public._badge_ironman_half();

-- A 140.6 already held brings its 70.3 now (none on 2026-11-13).
insert into public.customer_badges (customer_id, badge_id, note, session_id, awarded_by, awarded_at)
select cb.customer_id, h.id, cb.note, cb.session_id, cb.awarded_by, cb.awarded_at
  from public.customer_badges cb
  join public.badges f on f.id = cb.badge_id and f.slug = 'ironman_1406'
  join public.badges h on h.slug = 'ironman_703' and not h.retired
on conflict (customer_id, badge_id) do nothing;

do $chk$
begin
  if not exists (select 1 from pg_trigger where tgname = 'customer_badges_ironman_half' and tgrelid = 'public.customer_badges'::regclass) then
    raise exception 'the Ironman trigger is missing';
  end if;
  if exists (select 1 from public.customer_badges cb join public.badges f on f.id = cb.badge_id and f.slug = 'ironman_1406'
              where not exists (select 1 from public.customer_badges x join public.badges h on h.id = x.badge_id and h.slug = 'ironman_703'
                                 where x.customer_id = cb.customer_id)) then
    raise exception 'a 140.6 holder is without the 70.3';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114100000', 'ironman_brings_half')
on conflict (version) do nothing;

commit;

-- Check (read only):
--   select tgname, tgenabled from pg_trigger where tgrelid = 'public.customer_badges'::regclass and not tgisinternal;
--   select prosecdef, proconfig from pg_proc where proname = '_badge_ironman_half';
--   select count(*) as full_without_half from public.customer_badges cb join public.badges f on f.id = cb.badge_id and f.slug = 'ironman_1406'
--    where not exists (select 1 from public.customer_badges x join public.badges h on h.id = x.badge_id and h.slug = 'ironman_703' and x.customer_id = cb.customer_id);
--   select version, name from supabase_migrations.schema_migrations where version = '20261114100000';
