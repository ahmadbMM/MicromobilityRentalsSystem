-- ============================================================================
-- A community member invites a friend (the owner, 2026-11-02): the member shares a message with a
-- link to the application form carrying their personal code; when the friend's application is in,
-- it says who invited them. The form records this in a second, separate call, so a failure here
-- never touches the application itself, and customer_community_apply stays as it is.
-- The friend's details are not stored until they apply themselves.
-- ============================================================================

begin;

create table if not exists public.member_invites (
  customer_id text primary key references public.customers(id) on delete cascade,
  code        text not null unique check (code ~ '^[0-9a-f]{16}$'),
  created_at  timestamptz not null default now()
);
alter table public.member_invites enable row level security;
drop policy if exists "staff read" on public.member_invites;
create policy "staff read" on public.member_invites for select to authenticated using ((select is_staff()));
revoke all on public.member_invites from public, anon, authenticated;
grant select on public.member_invites to authenticated;

alter table public.community_applications
  add column if not exists invited_by      text references public.customers(id) on delete set null,
  add column if not exists invited_by_name text check (char_length(invited_by_name) <= 120);
grant select (invited_by, invited_by_name) on public.community_applications to authenticated;

-- The member's own code, made the first time it is asked for. Members only.
create or replace function public.member_invite_code(p_id text, p_token text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_code text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  insert into member_invites (customer_id, code)
  values (p_id, substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))
  on conflict (customer_id) do nothing;
  select code into v_code from member_invites where customer_id = p_id;
  return jsonb_build_object('ok', true, 'code', v_code);
end $$;
revoke execute on function public.member_invite_code(text, text) from public;
grant  execute on function public.member_invite_code(text, text) to anon, authenticated;

-- Marks the signed-in applicant's newest application as invited by the code's holder. A code that is
-- unknown, whose holder is no longer a member, or the applicant's own marks nothing; the first
-- inviter stays. Answers the same either way, so a guessed code learns nothing.
create or replace function public.community_app_invited(p_id text, p_token text, p_code text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_by text; v_name text; v_app uuid;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select i.customer_id, btrim(c.name) into v_by, v_name
    from member_invites i join customers c on c.id = i.customer_id
   where i.code = p_code and c.merged_into is null;
  if v_by is null or v_by = p_id or not _member_active(v_by) then return jsonb_build_object('ok', true); end if;
  select a.id into v_app from community_applications a where a.customer_id = p_id order by a.created_at desc limit 1;
  if v_app is not null then
    update community_applications set invited_by = v_by, invited_by_name = left(v_name, 120)
     where id = v_app and invited_by is null;
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.community_app_invited(text, text, text) from public;
grant  execute on function public.community_app_invited(text, text, text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261103100000', 'member_invites')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): RLS on, both functions definer, the code table closed to visitors, the columns there, the ledger row.
select (select relrowsecurity from pg_class where oid = 'public.member_invites'::regclass) as rls_on,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('member_invite_code', 'community_app_invited')) as definer_2,
       has_table_privilege('anon', 'public.member_invites', 'select') as codes_open_to_anon,
       has_column_privilege('authenticated', 'public.community_applications', 'invited_by_name', 'select') as staff_can_read_name,
       (select version from supabase_migrations.schema_migrations where version = '20261103100000') as ledger;
