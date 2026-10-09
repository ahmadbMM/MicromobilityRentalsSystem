-- ============================================================================
-- Messages: who has it, and how long the first answer took (Staff app research 2026-10-09, M22).
--
--  1. site_messages.assigned_to: the operator name a message is with (any staffer sets it, as
--     they set its status and notes; staff update policy unchanged).
--  2. site_messages.first_reply_at: stamped by the database the first time a message leaves
--     New (Replied or Closed); never moved afterwards, so a reopened message keeps its first time.
--     Messages already answered get their last change as the best guess.
--
-- Rollback: drop trigger site_messages_first_reply on public.site_messages;
--   drop function public._sm_first_reply(); alter table public.site_messages
--   drop column assigned_to, drop column first_reply_at.
-- Idempotent.
-- ============================================================================

begin;

alter table public.site_messages add column if not exists assigned_to text;
alter table public.site_messages add column if not exists first_reply_at timestamptz;
alter table public.site_messages drop constraint if exists site_messages_assigned_len;
alter table public.site_messages add constraint site_messages_assigned_len check (assigned_to is null or length(assigned_to) <= 40);

update public.site_messages set first_reply_at = coalesce(updated_at, created_at)
 where first_reply_at is null and status in ('replied', 'closed');

create or replace function public._sm_first_reply()
returns trigger
language plpgsql set search_path to 'public'
as $$
begin
  if new.first_reply_at is null and coalesce(new.status, 'new') <> 'new'
     and (tg_op = 'INSERT' or coalesce(old.status, 'new') = 'new') then
    new.first_reply_at := now();
  end if;
  if tg_op = 'UPDATE' and old.first_reply_at is not null then new.first_reply_at := old.first_reply_at; end if;
  return new;
end $$;
revoke execute on function public._sm_first_reply() from public, anon, authenticated;

drop trigger if exists site_messages_first_reply on public.site_messages;
create trigger site_messages_first_reply
  before insert or update on public.site_messages
  for each row execute function public._sm_first_reply();

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009164000', 'messages_assign')
on conflict (version) do nothing;

commit;
