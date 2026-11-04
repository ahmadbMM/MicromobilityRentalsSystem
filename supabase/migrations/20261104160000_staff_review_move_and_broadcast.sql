-- ============================================================================
-- Two of the staff review's picks (2026-10-28, marked Build now; built 2026-11-04).
--
--  1. staff_move_session (S02-core2-01): a ride's new date in one transaction. The phone did it in eight or more writes, each a
--     point where a dropped connection left the move half done, and it never carried deposits, waitlist offers, kudos, the wallet
--     ledger, the live positions or a Petromin night's number counter, which kept the dead id. The id is what the app asks for,
--     or the next free one on that date (-2, -3...). p_exact (Undo) refuses instead of taking another id. Any staff member, as
--     the writes it replaces: the sessions table lets any staff member insert and update, and only its last step, deleting the
--     old row, was an admin's, so a non-admin's move used to stop there with the bookings moved and the old row left behind.
--  2. customer_badges and customer_ig_followers join the staff-ref broadcast (S07-community2-16), so every device hears of a
--     change as it does a tag's, and the app can stop re-reading both tables in full every five minutes. Rows are few: 64 badges,
--     660 follower rows of which about 17 change a day (2026-11-04). _staff_ref_broadcast itself is not touched.
--
-- Safe before or after the app: an older app does not call the function, and the broadcasts go unheard.
-- Undo: drop function public.staff_move_session(text, text, text, boolean);
--       drop trigger staff_ref_broadcast on public.customer_badges;
--       drop trigger staff_ref_broadcast on public.customer_ig_followers;
--
-- Verify (read only):
--   select prosecdef, proconfig from pg_proc where proname = 'staff_move_session';         -- true, {search_path=public}
--   select has_function_privilege('anon', 'public.staff_move_session(text,text,text,boolean)', 'execute');           -- false
--   select has_function_privilege('authenticated', 'public.staff_move_session(text,text,text,boolean)', 'execute');  -- true
--   select tgrelid::regclass, tgenabled from pg_trigger where tgname = 'staff_ref_broadcast' order by 1;             -- 5 rows, O
-- ============================================================================
begin;

create or replace function public.staff_move_session(p_from text, p_to_id text, p_date text, p_exact boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  s sessions%rowtype;
  d date;
  v_to text := p_to_id;
  v_day text;
  n int := 1;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  begin
    d := p_date::date;
  exception when others then
    raise exception 'BAD_DATE' using errcode = '22007';
  end;
  -- Undo names the ride's own old id, which an older ride may have kept through an edit of its date.
  if coalesce(p_to_id, '') = '' or (not p_exact and left(p_to_id, 10) <> to_char(d, 'YYYY-MM-DD')) then
    raise exception 'BAD_SESSION_ID' using errcode = '22023';
  end if;
  select * into s from sessions where id = p_from for update;
  if s.id is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_to_id = p_from then raise exception 'BAD_SESSION_ID' using errcode = '22023'; end if;

  -- The date may already hold a session: the next number after it, as the app did.
  while exists (select 1 from sessions where id = v_to) loop
    if p_exact then raise exception 'SESSION_ID_TAKEN' using errcode = '23505'; end if;
    n := n + 1;
    if n > 25 then raise exception 'SESSION_ID_TAKEN' using errcode = '23505'; end if;
    v_to := p_to_id || '-' || n;
  end loop;

  v_day := to_char(d, 'FMDay');
  insert into sessions
    select (jsonb_populate_record(s, jsonb_build_object('id', v_to, 'session_date', to_char(d, 'YYYY-MM-DD'), 'day', v_day))).*;

  update queue_entries set session_id = v_to, session_date = to_char(d, 'YYYY-MM-DD'), session_day = v_day where session_id = p_from;
  update cashier_sales set session_id = v_to where session_id = p_from;
  update community_applications set invited_session = v_to where invited_session = p_from;
  update customer_badges set session_id = v_to where session_id = p_from;
  update rider_registrations set session_id = v_to where session_id = p_from;
  update session_partners set session_id = v_to where session_id = p_from; -- its codes follow by ON UPDATE CASCADE
  update part_timer_shifts set session_id = v_to where session_id = p_from;
  update till_sessions set session_id = v_to where session_id = p_from;
  update deposits set session_id = v_to where session_id = p_from;
  update waitlist_offers set session_id = v_to where session_id = p_from;
  update wallet_ledger set session_id = v_to where session_id = p_from;
  -- Keyed with the session: a leftover row on the id it moves to (a ride purged from that date) stays, and is not worth the move.
  update member_kudos k set session_id = v_to where k.session_id = p_from
    and not exists (select 1 from member_kudos x where x.from_id = k.from_id and x.to_id = k.to_id and x.session_id = v_to);
  update live_positions l set session_id = v_to where l.session_id = p_from
    and not exists (select 1 from live_positions x where x.session_id = v_to and x.role = l.role);
  update rider_night_counters c set session_key = v_to where c.session_key = p_from
    and not exists (select 1 from rider_night_counters x where x.session_key = v_to and x.source = c.source);

  delete from sessions where id = p_from;
  return jsonb_build_object('ok', true, 'id', v_to, 'day', v_day);
end $function$;
revoke all on function public.staff_move_session(text, text, text, boolean) from public, anon;
grant execute on function public.staff_move_session(text, text, text, boolean) to authenticated;

drop trigger if exists staff_ref_broadcast on public.customer_badges;
create trigger staff_ref_broadcast
  after insert or delete or update on public.customer_badges
  for each row execute function public._staff_ref_broadcast();

drop trigger if exists staff_ref_broadcast on public.customer_ig_followers;
create trigger staff_ref_broadcast
  after insert or delete or update on public.customer_ig_followers
  for each row execute function public._staff_ref_broadcast();

insert into supabase_migrations.schema_migrations (version, name)
values ('20261104160000', 'staff_review_move_and_broadcast')
on conflict (version) do nothing;

commit;
