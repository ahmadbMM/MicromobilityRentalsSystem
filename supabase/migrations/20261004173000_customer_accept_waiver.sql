-- ============================================================================
-- Riders staff add, and walk-ins, agree to the waiver themselves (the owner, 2026-10-04: "for the
-- added riders and walked in ... force them to accept the waiver of the session as a pop up").
--
-- A booking made in the booking wizard carries the waiver it was agreed under (customer_create_booking
-- refuses one without, 20261003210001). A rider added at the desk (add rider, add group, walk-in, the
-- Waiting dialog) has none: waiver_version and waiver_at stay null. Since this change the booking app
-- and the website open a page the rider cannot close (Log out is the only way off) for each ride still
-- ahead of them that holds such a row, showing that ride and its waiver; agreeing calls this function.
--
-- customer_accept_waiver stamps the agreed version and the time, in the format customer_create_booking
-- writes, on every row of that ride that belongs to the account and has no waiver yet: the account
-- holder agrees for everyone on their booking, as the wizard's tick says. Only live rows (not
-- cancelled, removed or no-show) on a ride today or later; a row that already carries a waiver keeps
-- it. Returns how many rows it stamped (0 when another device got there first), -1 for a bad token.
--
-- Rollback: drop function public.customer_accept_waiver(text, text, text, text);
-- ============================================================================
create or replace function public.customer_accept_waiver(p_id text, p_token text, p_session_id text, p_version text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare _n int;
begin
  if not _cust_token_ok(p_id, p_token) then return -1; end if;
  if coalesce(p_version, '') !~ '^[A-Za-z0-9._-]{1,40}$' then
    raise exception 'WAIVER_REQUIRED' using errcode = 'P0001';
  end if;
  update queue_entries x
     set waiver_at      = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         waiver_version = p_version
   where x.customer_id = p_id
     and x.session_id = p_session_id
     and coalesce(x.waiver_version, '') = ''
     and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow')
     and coalesce(x.session_date, '') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  get diagnostics _n = row_count;
  return _n;
end $function$;

revoke all on function public.customer_accept_waiver(text, text, text, text) from public;
grant execute on function public.customer_accept_waiver(text, text, text, text) to anon, authenticated;
