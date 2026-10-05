-- ============================================================================
-- Staff onboarding — add a staff member (email + phone) in ONE query.
-- Phone login stays free (no Twilio): the app resolves phone -> email, then does a
-- normal email+password sign-in. This moves the phone map into the DB so you never
-- need a code change to add a staff phone.
-- ============================================================================

-- ── SETUP (run ONCE) ────────────────────────────────────────────────────────
-- A table for staff phone -> account email, plus a lookup the app calls at login.
create table if not exists staff_phones (
  phone text primary key,          -- store E.164, e.g. +966500000000
  email text not null
);
alter table staff_phones enable row level security;
-- Login happens BEFORE auth, so the lookup must be callable by anon. It only ever
-- returns one email for one phone (same info the app already shipped publicly), and a
-- password is still required to actually sign in. Digit-compare tolerates +/no-+.
create or replace function staff_email_for_phone(p_phone text)
returns text language sql security definer set search_path = public, extensions stable as $$
  select email from staff_phones
  where regexp_replace(phone, '\D', '', 'g') = regexp_replace(p_phone, '\D', '', 'g')
  limit 1;
$$;
grant execute on function staff_email_for_phone(text) to anon, authenticated;


-- ── ADD A STAFF MEMBER — THE ONE QUERY ──────────────────────────────────────
-- First create the login in Supabase → Authentication → Users (email + a temp
-- password, Auto Confirm ON). Then edit the 3 values below and run this single query.
-- It grants staff (admin, must-set-own-password on first login) AND registers the phone.
with grant_staff as (
  insert into staff (user_id, role, must_change_pwd)
  select id, 'admin', true               -- use 'frontdesk' for limited access
  from auth.users
  where email = 'staff.name@micromobility.sa' -- ← the staff email (any domain)
  on conflict (user_id) do update set role = excluded.role
  returning user_id
)
insert into staff_phones (phone, email)
values ('+966500000000', 'staff.name@micromobility.sa')   -- ← phone (E.164) + same email
on conflict (phone) do update set email = excluded.email;

-- Done. They sign in with the email OR the phone + the temp password, then are prompted
-- to set their own. To remove a staffer's phone login later:
--   delete from staff_phones where email = 'their@email.com';
