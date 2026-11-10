-- ============================================================================
-- Referrals give no reward any more (the user, 2026-11-10: "remove that a referral gives a discount or free ride";
-- picks: keep invites without rewards, honour the codes already given until they expire).
--
--  1. _ref_reward(): a referred friend's first paid, finished JCC ride or Petromin night is still written on the
--     referral (rode_entry_id, rode_at), which the Invite card's "Friends who rode", the Recruiter badges and
--     People > Referrals count. No RF- free ride, no RB- bonus at the fifth friend, no browser notification, and no
--     yearly limit (it only counted free rides).
--  2. _ref_welcome(): makes no RW- code and brings none back. It answers the friend's code already given while that
--     code is still on (the answer customer_set_referrer, staff_set_referrer and staff_referral_review return), so a
--     re-link or an allowed held referral gets nothing new.
--
-- Codes already given are left alone: they keep working until their own expires_at (_ref_code_guard, _promo_count,
-- customer_referral and _ref_expiry_tick's last-week reminder are unchanged). Removing a referral still puts the
-- friend's unused code away (_ref_welcome_off), as before.
--
-- SECURITY DEFINER and search_path are restated: CREATE OR REPLACE takes the attributes from this text.
-- Rollback: _ref_reward and _ref_welcome as in 20261108200000_referral_friend_discount.sql.
-- ============================================================================

begin;

create or replace function public._ref_reward(p_friend text, p_entry text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  r referrals%rowtype;
begin
  select * into r from referrals where friend_id = p_friend for update;
  -- a held referral waits for staff (staff_referral_review), its ride not used up
  if not found or r.rode_at is not null or r.held then return; end if;
  if not (select ref_on from _ref_conf()) then return; end if;
  update referrals set rode_entry_id = p_entry, rode_at = now() where friend_id = p_friend;
end $function$;
revoke all on function public._ref_reward(text, text) from public, anon, authenticated;

-- The friend's code already given, while it is on; never a new one.
create or replace function public._ref_welcome(p_friend text)
 returns text
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select c.code from promo_codes c
   where c.referral_welcome_of = p_friend and c.customer_id = p_friend and c.active
   limit 1
$function$;
revoke all on function public._ref_welcome(text) from public, anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111001000', 'referral_no_rewards')
on conflict (version) do nothing;

commit;
