-- ============================================================================
-- Undo codes removed (the owner, 2026-10-04: "remove the 6digit code for the staff").
--
-- 20260928234500 had every admin confirm an undo with a 6-digit code of their own. The staff page
-- no longer asks for it: only an admin still undoes, the topbar's Undo goes ahead and History >
-- Log's asks yes or no. The codes' table, its three functions and any undo lock in login_throttle
-- ('undo:<user id>') go with it. Safe in either order with the app: the page before this change
-- treats the missing functions as a database without codes and undoes as it used to.
-- ============================================================================

drop function if exists public.staff_undo_code_state();
drop function if exists public.staff_set_undo_code(text);
drop function if exists public.staff_check_undo_code(text);
drop table if exists public.staff_undo_codes;
delete from public.login_throttle where identifier like 'undo:%';
