-- A community application whose account already holds the Community tag, given outside the applications (staff
-- tagged the account in Accounts, or another application of the same account was approved), moves to Approved by
-- itself, with the reason 'outside' that the staff card shows as "Already approved outside the applications" (the
-- user, 2026-11-12: "any applications that contain accounts that were added outside the applications automatically
-- move them to approved and write the reason already approved outside the applications").
--
-- Only pending applications move: a rejection stays a staff decision. The form cannot send one for a member
-- (customer_community_apply refuses 'member'), so a pending application turns into a member's only when the tag
-- comes after it was sent. Three ways in:
--   1. now, once, for every pending application whose account is a member (15 on prod on 2026-11-12);
--   2. a tag given or renewed later: a constraint trigger on customer_tags, deferred to the end of the
--      transaction, so staff_community_approve (which gives the tag, then approves) has approved its own
--      application by then and only that account's OTHER pending applications move;
--   3. merged accounts: an application on an account merged into the member counts as the member's.
-- decided_by stays empty (no person decided it); decided_at is when it moved.

begin;

alter table public.community_applications add column if not exists decided_reason text;
comment on column public.community_applications.decided_reason is
  'Why the application was decided without staff: outside = its account already held the Community tag, given outside the applications (20261112183000)';

-- The application's account, or the account it was merged into (up to six hops), is an active community member.
create or replace function public._community_app_member(p_cid text)
returns boolean
language plpgsql stable security definer set search_path to 'public'
as $$
declare v text := p_cid; i int := 0;
begin
  while v is not null and i < 6 loop
    if _member_active(v) then return true; end if;
    select c.merged_into into v from customers c where c.id = v;
    i := i + 1;
  end loop;
  return false;
end $$;
revoke all on function public._community_app_member(text) from public, anon, authenticated;

-- Moves the pending applications of these accounts whose account is a member; returns how many moved.
create or replace function public._community_app_outside(p_cids text[])
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare n int;
begin
  update community_applications a
     set status = 'approved', decided_at = now(), decided_by = null, decided_reason = 'outside',
         existing_account = true, updated_at = now()
   where a.status = 'pending' and a.customer_id = any (p_cids) and _community_app_member(a.customer_id);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public._community_app_outside(text[]) from public, anon, authenticated;

-- The Community tag given or changed on an account: that account's pending applications, and those of the accounts
-- merged into it, move if the tag is in force by the end of the transaction.
create or replace function public._community_app_outside_trg()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  perform _community_app_outside(array(select new.customer_id
                                       union select c.id from customers c where c.merged_into = new.customer_id));
  return null;
end $$;
revoke all on function public._community_app_outside_trg() from public, anon, authenticated;

drop trigger if exists customer_tags_ca_outside on public.customer_tags;
create constraint trigger customer_tags_ca_outside
  after insert or update on public.customer_tags
  deferrable initially deferred
  for each row when (new.tag_id = 'tag_saturday')
  execute function public._community_app_outside_trg();

-- 1. The applications waiting now.
select public._community_app_outside(array(select distinct a.customer_id from public.community_applications a
                                            where a.status = 'pending' and a.customer_id is not null));

insert into supabase_migrations.schema_migrations (version, name)
values ('20261112183000', 'community_app_outside') on conflict do nothing;

commit;

-- Check (read-only), after it ran:
-- select count(*) filter (where status = 'pending' and public._community_app_member(customer_id)) as still_pending_members,
--        count(*) filter (where decided_reason = 'outside') as moved
--   from public.community_applications;
-- expected: still_pending_members 0, moved 15 (the count on 2026-11-12)
