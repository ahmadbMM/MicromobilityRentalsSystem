-- ============================================================================
-- Staff comments on bookings and applications (2026-10-23; the owner: "add the ability for staff to add
-- comments on customers bookings and applications that are visible only to staff themselves").
--
--   public.staff_comments  one row per comment: what it is on (kind + target_id), the text, who wrote it
--                          and when. kind: 'booking' (queue_entries.id), 'community_app'
--                          (community_applications.id), 'learn_app' (learn_applications.id).
--
-- A table of its own, not a column on queue_entries: nothing a customer reads (queue_public, my_bookings,
-- staff_sync's whole rows) can ever carry it. Staff only: RLS under is_staff(); anon has no grant at all.
-- Every staffer reads every comment; a staffer deletes their own, an admin any. No edits (delete and
-- write again). The author is stamped by the database (auth.uid() and staff.display_name, else the
-- sign-in email), never taken from the page.
--
-- The page works before this is applied: the comments button says "Waiting for the database update".
--
-- Rollback: drop table if exists public.staff_comments; drop function if exists public._staff_comments_stamp();
-- Idempotent: safe to re-run.
-- ============================================================================

begin;

create table if not exists public.staff_comments (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  kind         text not null check (kind in ('booking','community_app','learn_app')),
  target_id    text not null check (length(target_id) between 1 and 80),
  body         text not null check (length(btrim(body)) between 1 and 2000),
  author_id    uuid default auth.uid(),
  author_name  text check (author_name is null or length(author_name) <= 120)
);
create index if not exists staff_comments_target on public.staff_comments (kind, target_id, created_at);
create index if not exists staff_comments_created on public.staff_comments (created_at desc);
comment on table public.staff_comments is 'staff-only comments on bookings and applications; never shown to customers';

alter table public.staff_comments enable row level security;

drop policy if exists "staff comments staff read" on public.staff_comments;
create policy "staff comments staff read" on public.staff_comments for select to authenticated
  using ((select public.is_staff()));
drop policy if exists "staff comments staff insert" on public.staff_comments;
create policy "staff comments staff insert" on public.staff_comments for insert to authenticated
  with check ((select public.is_staff()));
drop policy if exists "staff comments own or admin delete" on public.staff_comments;
create policy "staff comments own or admin delete" on public.staff_comments for delete to authenticated
  using ((select public.is_staff()) and (author_id = (select auth.uid()) or (select public.is_admin())));

revoke all on public.staff_comments from anon, authenticated;
grant select, insert, delete on public.staff_comments to authenticated;

-- Who wrote it and when come from the session, whatever the page sent.
create or replace function public._staff_comments_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  new.created_at := now();
  new.author_id := auth.uid();
  new.author_name := left(coalesce(
    (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()),
    auth.jwt() ->> 'email',
    'staff'), 120);
  new.body := btrim(new.body);
  return new;
end $function$;
revoke all on function public._staff_comments_stamp() from public, anon, authenticated;
drop trigger if exists staff_comments_stamp on public.staff_comments;
create trigger staff_comments_stamp before insert on public.staff_comments
  for each row execute function public._staff_comments_stamp();

insert into supabase_migrations.schema_migrations (version, name)
values ('20261023230000', 'staff_comments')
on conflict (version) do nothing;

commit;
