-- ============================================================================
-- Referrals: a free ride lasts 30 days, and a friend's account may be any age (the user, 2026-11-08: "a free ride
-- lasts 30 days, a new friend account doesn't need to be less than 30 days old, it can be as old as possible").
--
--  1. _ref_conf(): ref_days, while Settings > Business has no number of its own, is 30 (was 60). Prod and staging
--     have none saved, so every free ride given from now on lasts 30 days, and so does the friend's welcome code
--     (20261108200000), which reads the same setting. Codes already given keep their dates.
--  2. _ref_new(): a friend's account no longer has to be made in the last 30 days. What still counts: not merged
--     away, and no completed paid ride (staff: at most one). p_age stays in the signature so its callers
--     (customer_referral, customer_set_referrer, staff_set_referrer, _ref_welcome) stay as they are; it is no longer
--     read. An older account that opens a friend's link and signs in is linked by the app as a new one is (_refLoad
--     sends a parked link whenever customer_referral says can_enter).
--
-- SECURITY DEFINER and search_path are restated: CREATE OR REPLACE takes the attributes from this text.
-- Rollback: the two definitions in 20261108160000_referrals.sql.
-- ============================================================================

begin;

create or replace function public._ref_conf(out ref_on boolean, out ref_days integer, out ref_cap integer)
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select coalesce(b ->> 'ref_on', '') <> 'false',
         case when jsonb_typeof(b -> 'ref_days') = 'number' then least(greatest((b ->> 'ref_days')::numeric, 7), 365)::int else 30 end,
         case when jsonb_typeof(b -> 'ref_cap') = 'number' then least(greatest((b ->> 'ref_cap')::numeric, 1), 100)::int else 10 end
    from (select coalesce((select items from staff_options where key = 'biz'), '{}'::jsonb) as b) x
$function$;
revoke all on function public._ref_conf() from public, anon, authenticated;

-- An account that may still be referred: not merged away, and with at most p_rides completed paid rides on any kind
-- of ride, however long ago it was made. p_age is no longer read.
create or replace function public._ref_new(p_id text, p_rides integer, p_age boolean)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select exists (select 1 from customers c where c.id = p_id and c.merged_into is null)
     and (select count(*) from queue_entries q
           where q.customer_id = p_id and q.status = 'done' and q.paid is true and q.price > 0) <= p_rides
$function$;
revoke all on function public._ref_new(text, integer, boolean) from public, anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261108235000', 'referral_any_age')
on conflict (version) do nothing;

commit;
