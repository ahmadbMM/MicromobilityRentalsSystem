-- ============================================================================
-- 20261111180700_account_followups
--
-- Staff website round s10, second batch ("extras", 2026-11-11), the report's follow-up reminders:
--
--   public.account_followups  A reminder staff set on a person: a due date and a note ("call about the Petromin
--                             invoice", "ask for the waiver photo again"). Made from the account window's More
--                             actions (Follow up); listed in People > Activity > Follow-ups with Mark done, on the
--                             account window (its open ones), as a bell line for the ones due today or overdue and
--                             as a count in the Dashboard's "Waiting on the office". In-app only: no email, no SMS.
--
-- Rights: staff who may open People (_staff_mod('community'), the page's section id; the database also reads it as
-- 'customers') read; staff who may change People insert and update (mark done, reopen, change the date or the note);
-- admins delete. anon has no grant at all. The database stamps who made it and when (auth.uid() and
-- staff.display_name, else the sign-in email) and who marked it done and when; the page never sends those.
--
-- The foreign key removes an account's follow-ups with the account (a delete-account request); a merge keeps the
-- merged row, so its follow-ups stay readable on it.
--
-- Safe before or after the app: until this is applied Follow up and the Follow-ups list say "Waiting for the database
-- update", and the bell and the Dashboard count nothing.
--
-- Rollback: drop table if exists public.account_followups; drop function if exists public._account_followups_stamp();
-- Idempotent: safe to re-run. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create table if not exists public.account_followups (
  id               bigint generated always as identity primary key,
  customer_id      text not null references public.customers (id) on delete cascade,
  due_on           date not null,
  note             text not null check (length(btrim(note)) between 1 and 500),
  created_by       uuid default auth.uid(),
  created_by_name  text check (created_by_name is null or length(created_by_name) <= 120),
  created_at       timestamptz not null default now(),
  done_at          timestamptz,
  done_by          uuid,
  done_by_name     text check (done_by_name is null or length(done_by_name) <= 120)
);
-- the bell's and the Dashboard's read: open ones due by today; the account window's: one account's
create index if not exists account_followups_open on public.account_followups (due_on) where done_at is null;
create index if not exists account_followups_customer on public.account_followups (customer_id, due_on);
comment on table public.account_followups is 'Follow-up reminders staff set on an account (20261111180700); staff only, never shown to customers';

alter table public.account_followups enable row level security;

drop policy if exists "account followups people read" on public.account_followups;
create policy "account followups people read" on public.account_followups for select to authenticated
  using ((select public._staff_mod('community', false)));
drop policy if exists "account followups people insert" on public.account_followups;
create policy "account followups people insert" on public.account_followups for insert to authenticated
  with check ((select public._staff_mod('community', true)));
drop policy if exists "account followups people update" on public.account_followups;
create policy "account followups people update" on public.account_followups for update to authenticated
  using ((select public._staff_mod('community', true)))
  with check ((select public._staff_mod('community', true)));
drop policy if exists "account followups admin delete" on public.account_followups;
create policy "account followups admin delete" on public.account_followups for delete to authenticated
  using ((select public.is_admin()));

revoke all on public.account_followups from anon, authenticated;
grant select, insert, update, delete on public.account_followups to authenticated;

-- Who made it and when, and who marked it done and when, come from the session, whatever the page sent. An edit keeps
-- the account and the maker; done_at going from empty to set stamps now() and the staffer, back to empty clears both.
create or replace function public._account_followups_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare me text := left(coalesce(
    (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()),
    auth.jwt() ->> 'email',
    'staff'), 120);
begin
  new.note := btrim(new.note);
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
    new.created_by_name := me;
    new.done_at := null;
    new.done_by := null;
    new.done_by_name := null;
    return new;
  end if;
  new.customer_id := old.customer_id;
  new.created_at := old.created_at;
  new.created_by := old.created_by;
  new.created_by_name := old.created_by_name;
  if new.done_at is null then
    new.done_by := null;
    new.done_by_name := null;
  elsif old.done_at is null then
    new.done_at := now();
    new.done_by := auth.uid();
    new.done_by_name := me;
  else
    new.done_at := old.done_at;
    new.done_by := old.done_by;
    new.done_by_name := old.done_by_name;
  end if;
  return new;
end $function$;
revoke all on function public._account_followups_stamp() from public, anon, authenticated;
drop trigger if exists account_followups_stamp on public.account_followups;
create trigger account_followups_stamp before insert or update on public.account_followups
  for each row execute function public._account_followups_stamp();

-- ── Checks ───────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public._account_followups_stamp()'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception '_account_followups_stamp lost SECURITY DEFINER or its search_path';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.account_followups'::regclass) then
    raise exception 'row level security is off on account_followups';
  end if;
  if has_table_privilege('anon', 'public.account_followups', 'select') then
    raise exception 'anon can read account_followups';
  end if;
  foreach f in array array['public.is_staff()', 'public.is_admin()', 'public._staff_mod(text,boolean)'] loop
    if to_regprocedure(f) is null then raise exception '% is missing', f; end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111180700', 'account_followups')
on conflict (version) do nothing;

commit;
