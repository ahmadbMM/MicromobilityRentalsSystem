-- ============================================================================
-- Staff may change a rider's profile, not their identity (2026-09-28, from the staff security review).
--
-- The customers UPDATE grant was table-wide for authenticated, so any staff account - front desk,
-- mechanic, a read-only owner - could write session_token, password_hash, merged_into or
-- must_change_pwd straight through PostgREST and hold, or redirect, a rider's session (merged_into is
-- followed by customer_login since 20260928130000). Those columns belong to the SECURITY DEFINER
-- functions alone; the desk keeps exactly the columns its screens edit.
--
-- Rollback: grant update on public.customers to authenticated;
-- Idempotent.
-- ============================================================================
revoke update on public.customers from authenticated;
grant update (name, email, phone, height, type_preference, gender, birth_date, country, city, nationality,
              socials, photo, hidden_types, default_pay, ride_news, ride_news_at, deletion_requested_at)
  on public.customers to authenticated;
