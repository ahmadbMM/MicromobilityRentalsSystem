-- ============================================================================
-- A note for the desk from the rider (2026-11-19, customer features round, item 9).
--
-- The user, 2026-11-19, asked "what features for customers can we add to the booking app that will enhance their
-- experience" and picked item 9: "An optional field on the review step, for things like 'first time on a bike' or
-- 'my child is nervous'. Staff see it on the booking."
--
--  1. queue_entries.rider_note text: the rider's own note on their booking, at most 200 characters (a check), null when
--     there is none. One note a booking: it sits on the booking's first row (the account holder's). The rider reads it
--     through my_bookings (whole rows of their own bookings, select *: no change needed there); staff through their own
--     reads (select * and staff_sync's to_jsonb, under the existing table-level grants: queue_entries has no column
--     grants, so nothing to add and no invoker function to break). queue_public names its columns, so no rider ever
--     reads another rider's note.
--  2. booking_note_set(p_id, p_token, p_booking, p_note): token-checked, the rider's own booking only, while it is live
--     (waiting, on the waitlist or on a bike; never a cancelled, removed, finished or no-show one). The note is trimmed,
--     runs of spaces and line breaks become one space, and an empty one is stored as null (that clears it); over 200
--     characters after that is refused ('long'). It is written on the row named and taken off every other row the account
--     has on that session, live or not (a cancelled booking's old note is not shown beside a new booking's), so a night
--     keeps one note wherever the row order moves. Answers
--     {ok, note} or {ok:false, error: denied | none | long}. The app calls it after customer_create_booking (which is
--     not rebuilt here) and from the ticket's Edit.
--
-- Safe before or after the app: until this runs the page's note is refused as 'none' / a missing function and the rider
-- is told it did not save; no booking depends on it.
--
-- Rollback:
--   drop function if exists public.booking_note_set(text, text, text, text);
--   alter table public.queue_entries drop constraint if exists queue_entries_rider_note_len;
--   alter table public.queue_entries drop column if exists rider_note;
-- Idempotent: a second run changes nothing.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. the note on the booking ─────────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists rider_note text;
alter table public.queue_entries drop constraint if exists queue_entries_rider_note_len;
alter table public.queue_entries add constraint queue_entries_rider_note_len
  check (rider_note is null or char_length(rider_note) <= 200);
comment on column public.queue_entries.rider_note is
  'The rider''s note for the desk ("first time on a bike"), 200 characters, on the booking''s first row; written by booking_note_set (20261119600300), read by the rider (my_bookings) and staff, never by other riders.';

-- ── 2. the rider writes it ─────────────────────────────────────────────────────────────────────
create or replace function public.booking_note_set(p_id text, p_token text, p_booking text, p_note text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare
  v_note text := nullif(btrim(regexp_replace(coalesce(p_note, ''), '[[:space:][:cntrl:]]+', ' ', 'g')), '');
  v_sess text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then
    return jsonb_build_object('ok', false, 'error', 'denied');
  end if;
  if char_length(coalesce(v_note, '')) > 200 then
    return jsonb_build_object('ok', false, 'error', 'long');
  end if;
  select q.session_id into v_sess from queue_entries q
   where q.id = p_booking and q.customer_id = p_id and q.status in ('waiting', 'waitlist', 'active');
  if v_sess is null then
    return jsonb_build_object('ok', false, 'error', 'none');
  end if;
  update queue_entries q
     set rider_note = case when q.id = p_booking then v_note else null end
   where q.customer_id = p_id and q.session_id = v_sess
     and (q.id = p_booking or q.rider_note is not null)
     and q.rider_note is distinct from (case when q.id = p_booking then v_note else null end);
  return jsonb_build_object('ok', true, 'note', v_note);
end $$;
revoke all on function public.booking_note_set(text, text, text, text) from public;
grant execute on function public.booking_note_set(text, text, text, text) to anon, authenticated;

do $chk$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'queue_entries' and column_name = 'rider_note') then
    raise exception 'queue_entries.rider_note missing';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.booking_note_set(text,text,text,text)'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'booking_note_set is missing, or lost SECURITY DEFINER or its search_path';
  end if;
  if not has_function_privilege('anon', 'public.booking_note_set(text,text,text,text)', 'execute') then
    raise exception 'booking_note_set is not callable by riders';
  end if;
  if not (select p.prosecdef from pg_proc p where p.oid = 'public.my_bookings(text,text)'::regprocedure) then
    raise exception 'my_bookings lost SECURITY DEFINER';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119600300', 'rider_note')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only): the column and its check, the function's attributes and grants, how many notes so far, the ledger row.
-- select (select data_type from information_schema.columns
--          where table_schema = 'public' and table_name = 'queue_entries' and column_name = 'rider_note') as col_text,
--        (select count(*) from pg_constraint where conname = 'queue_entries_rider_note_len') as check_1,
--        (select json_build_object('definer', p.prosecdef, 'settings', p.proconfig)
--           from pg_proc p where p.oid = 'public.booking_note_set(text,text,text,text)'::regprocedure) as fn,
--        has_function_privilege('anon', 'public.booking_note_set(text,text,text,text)', 'execute') as anon_true,
--        (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'queue_public'
--          and column_name = 'rider_note') as public_view_0,
--        (select count(*) from public.queue_entries where rider_note is not null) as notes_so_far,
--        (select name from supabase_migrations.schema_migrations where version = '20261119600300') as ledger;
