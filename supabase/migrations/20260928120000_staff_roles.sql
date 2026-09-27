-- ============================================================================
-- Staff roles beyond admin and front desk (2026-09-28): ride leader, mechanic, cashier and
-- owner (a read-only viewer). The database keeps enforcing one thing, is_admin() (role = 'admin'):
-- every other role is is_staff() and reaches the sections the app gives its role, narrowed by
-- the account's own lists (modules_view / modules_edit, 20260925120000). Only staff_set_access,
-- which the admin's Team page calls, needs to take the new names.
--
-- Also: 'catalog' (Website > Bikes catalog, 20260927100000) joins the sections an account may be
-- limited to - the app listed it, the function did not, so a view list naming it was refused.
--
-- Rollback: re-create staff_set_access from 20260925120000 (roles admin/frontdesk only).
-- Idempotent.
-- ============================================================================
create or replace function public.staff_set_access(p_user uuid, p_role text, p_view text[], p_edit text[])
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
declare
  allowed text[] := array['queue','dashboard','cashier','inventory','workshop','community','ambassadors','website','catalog','messages','analytics','history','team'];
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'NOT_YOURSELF' using errcode = '42501'; end if;
  if p_role is null or p_role not in ('admin', 'frontdesk', 'leader', 'mechanic', 'cashier', 'owner') then raise exception 'ROLE' using errcode = '22023'; end if;
  if p_view is not null and not (p_view <@ allowed) then raise exception 'SECTION' using errcode = '22023'; end if;
  if p_edit is not null and not (p_edit <@ coalesce(p_view, allowed)) then raise exception 'EDIT_NOT_VIEW' using errcode = '22023'; end if;
  update staff set role = p_role, modules_view = p_view, modules_edit = p_edit where user_id = p_user;
  if not found then raise exception 'NO_SUCH_STAFF' using errcode = 'P0002'; end if;
  return true;
end $$;
revoke all on function public.staff_set_access(uuid, text, text[], text[]) from public, anon;
grant execute on function public.staff_set_access(uuid, text, text[], text[]) to authenticated;
