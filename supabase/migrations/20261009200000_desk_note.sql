-- ============================================================================
-- A desk note on a booking (2026-10-09, front desk round 2, D13): one line staff leave for each other on a
-- booking ("left ID", "pays on return"), shown on the roster row, in the check-in and on the scan banner.
--
--   queue_entries.desk_note  text, at most 200 characters, null when there is none.
--
-- Staff read and write it straight off the table under the existing staff policies (table-level grants;
-- no column grants on queue_entries), and staff_sync sends whole rows (to_jsonb(q)), so it reaches every
-- desk without a change there. Customers must never see it: queue_public names its columns (not
-- widened), and my_bookings (select *) is replaced to blank the note on every row it returns. Its header
-- is copied from the live definition (pg_get_functiondef on 2026-10-09: plpgsql, SECURITY DEFINER,
-- search_path public, extensions), not from prosrc.
--
-- The page works before this is applied: the note's editor says "Waiting for the database update"
-- while the rows it reads carry no desk_note.
--
-- Rollback: alter table public.queue_entries drop constraint if exists queue_entries_desk_note_len,
--           drop column if exists desk_note; then re-create my_bookings as before (select * ... where
--           customer_id = p_id, same header).
-- Idempotent: safe to re-run.
-- ============================================================================

begin;

alter table public.queue_entries add column if not exists desk_note text;
alter table public.queue_entries drop constraint if exists queue_entries_desk_note_len;
alter table public.queue_entries add constraint queue_entries_desk_note_len
  check (desk_note is null or char_length(desk_note) <= 200);
comment on column public.queue_entries.desk_note is 'staff: the desk''s note on the booking (200 characters); never sent to the rider (my_bookings blanks it)';

create or replace function public.my_bookings(p_id text, p_token text)
 returns setof queue_entries
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare r queue_entries;
begin
  if not _cust_token_ok(p_id,p_token) then return; end if;
  /* the staff's desk note stays with staff */
  for r in select * from queue_entries where customer_id = p_id loop
    r.desk_note := null;
    return next r;
  end loop;
end $function$;

-- create or replace keeps the function's grants as they are (anon, authenticated).

do $chk$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'queue_entries' and column_name = 'desk_note') then
    raise exception 'queue_entries.desk_note missing';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.my_bookings(text,text)'::regprocedure) then
    raise exception 'my_bookings lost SECURITY DEFINER';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009200000', 'desk_note')
on conflict (version) do nothing;

commit;

-- Verify (expect 1 row: desk_note text):
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'queue_entries' and column_name = 'desk_note';
-- Then run supabase/checks/security-attributes.sql (my_bookings must stay SECURITY DEFINER).
