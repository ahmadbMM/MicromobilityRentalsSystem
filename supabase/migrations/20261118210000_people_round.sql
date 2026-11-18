-- ============================================================================
-- 20261118210000_people_round
--
-- People section, the user's picks of 2026-11-18 ("2 3 5 6 7 8" from the list of new People features):
--
--   public.account_family   Family links (3): accounts that belong to one family share a family_id; each may say
--                           whether it is a parent or a child there. Staff only: members never see each other
--                           (the rule of 2026-11-04). Shown in the account window, used by "Book for the family".
--   public.account_owners   Account owner (8): one staffer looks after an account (a VIP, a company contact, a
--                           mentee). People's "Owner" filter has "My people"; a follow-up made on the account goes to
--                           its owner unless staff pick someone else.
--   account_followups.assignee
--                           Who a follow-up is for (8). Empty: everyone with People, as before. The bell shows a
--                           follow-up to the staffer it is for, and to everyone when it is for nobody.
--   public.staff_customer_export(p_id)
--                           Download their data (7), admins only: the account row and every row of every table that
--                           carries the account's customer_id, plus the staff notes on the person, as one JSON
--                           object, for a request under the Personal Data Protection Law to see what is held.
--                           Secrets never leave: password and owner-password hashes, session and form tokens, the
--                           calendar feed key, push endpoints and keys, the sign-in hand-off codes, and the staff's
--                           own audit of who looked at the person's data.
--
-- Watch a person (2), rides with (5) and the last bike (6) need nothing here: a watch list is the staffer's own
-- preference (staff.prefs 'state.watch', through staff_my_prefs, which accepts state.<name> since 20261009190000), and
-- the other two are worked out from the bookings a staff device holds.
--
-- Rights on both tables: staff who may open People (_staff_mod('community', false)) read; staff who may change People
-- insert, update and delete. anon has no grant at all. The database stamps who linked or set it and when.
-- The foreign keys remove a link or an owner with the account (a delete-account request).
--
-- Safe before or after the app: until this is applied the window's Family, Owner and Download their data say
-- "Waiting for the database update", and nothing else changes.
--
--   public.staff_owner_choices()
--                           The staff an owner or a follow-up's staffer is picked from: accounts that are on.
--
-- Rollback: drop table if exists public.account_family, public.account_owners;
--           drop function if exists public._account_family_stamp(), public._account_owners_stamp(),
--             public.staff_customer_export(text), public.staff_owner_choices();
--           alter table public.account_followups drop column if exists assignee;
-- Idempotent: safe to re-run. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- ── 1. Family links ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.account_family (
  customer_id    text primary key references public.customers (id) on delete cascade,
  family_id      uuid not null,
  role           text check (role is null or role in ('parent', 'child')),
  added_by       uuid default auth.uid(),
  added_by_name  text check (added_by_name is null or length(added_by_name) <= 120),
  added_at       timestamptz not null default now()
);
create index if not exists account_family_family on public.account_family (family_id);
comment on table public.account_family is 'Family links staff make between accounts (20261118210000); staff only, never shown to customers';

alter table public.account_family enable row level security;
drop policy if exists "account family people read" on public.account_family;
create policy "account family people read" on public.account_family for select to authenticated
  using ((select public._staff_mod('community', false)));
drop policy if exists "account family people insert" on public.account_family;
create policy "account family people insert" on public.account_family for insert to authenticated
  with check ((select public._staff_mod('community', true)));
drop policy if exists "account family people update" on public.account_family;
create policy "account family people update" on public.account_family for update to authenticated
  using ((select public._staff_mod('community', true)))
  with check ((select public._staff_mod('community', true)));
drop policy if exists "account family people delete" on public.account_family;
create policy "account family people delete" on public.account_family for delete to authenticated
  using ((select public._staff_mod('community', true)));
revoke all on public.account_family from anon, authenticated;
grant select, insert, update, delete on public.account_family to authenticated;

-- Who linked it and when come from the session, whatever the page sent. A link moved to another family (two
-- families joined) or given a role keeps the account and who first linked it.
create or replace function public._account_family_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if tg_op = 'INSERT' or new.customer_id is distinct from old.customer_id then
    new.added_at := now();
    new.added_by := auth.uid();
    new.added_by_name := left(coalesce(
      (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()),
      auth.jwt() ->> 'email',
      'staff'), 120);
    return new;
  end if;
  new.added_at := old.added_at;
  new.added_by := old.added_by;
  new.added_by_name := old.added_by_name;
  return new;
end $function$;
revoke all on function public._account_family_stamp() from public, anon, authenticated;
drop trigger if exists account_family_stamp on public.account_family;
create trigger account_family_stamp before insert or update on public.account_family
  for each row execute function public._account_family_stamp();

-- ── 2. Account owner ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.account_owners (
  customer_id   text primary key references public.customers (id) on delete cascade,
  owner_id      uuid not null,
  owner_name    text check (owner_name is null or length(owner_name) <= 120),
  set_by        uuid default auth.uid(),
  set_by_name   text check (set_by_name is null or length(set_by_name) <= 120),
  set_at        timestamptz not null default now()
);
create index if not exists account_owners_owner on public.account_owners (owner_id);
comment on table public.account_owners is 'The staffer who looks after an account (20261118210000); staff only, never shown to customers';

alter table public.account_owners enable row level security;
drop policy if exists "account owners people read" on public.account_owners;
create policy "account owners people read" on public.account_owners for select to authenticated
  using ((select public._staff_mod('community', false)));
drop policy if exists "account owners people insert" on public.account_owners;
create policy "account owners people insert" on public.account_owners for insert to authenticated
  with check ((select public._staff_mod('community', true)));
drop policy if exists "account owners people update" on public.account_owners;
create policy "account owners people update" on public.account_owners for update to authenticated
  using ((select public._staff_mod('community', true)))
  with check ((select public._staff_mod('community', true)));
drop policy if exists "account owners people delete" on public.account_owners;
create policy "account owners people delete" on public.account_owners for delete to authenticated
  using ((select public._staff_mod('community', true)));
revoke all on public.account_owners from anon, authenticated;
grant select, insert, update, delete on public.account_owners to authenticated;

-- The owner is a staff account that is not switched off; its name (display name, else the sign-in email) is kept with
-- the row, so a list names the owner without reading the staff; who set it and when come from the session.
create or replace function public._account_owners_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'auth'
as $function$
begin
  if not exists (select 1 from staff s where s.user_id = new.owner_id and s.disabled_at is null) then
    raise exception 'OWNER_NOT_STAFF' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' then new.customer_id := old.customer_id; end if;
  new.owner_name := left(coalesce(
    (select nullif(btrim(s.display_name), '') from staff s where s.user_id = new.owner_id),
    (select u.email::text from auth.users u where u.id = new.owner_id),
    'staff'), 120);
  new.set_at := now();
  new.set_by := auth.uid();
  new.set_by_name := left(coalesce(
    (select nullif(btrim(s.display_name), '') from staff s where s.user_id = auth.uid()),
    auth.jwt() ->> 'email',
    'staff'), 120);
  return new;
end $function$;
revoke all on function public._account_owners_stamp() from public, anon, authenticated;
drop trigger if exists account_owners_stamp on public.account_owners;
create trigger account_owners_stamp before insert or update on public.account_owners
  for each row execute function public._account_owners_stamp();

-- Who can be picked as an owner, or as the staffer a follow-up is for: staff accounts that are on, not the volunteer
-- and door roles (staff_people, 20261009150000, also lists switched-off accounts, for old log lines).
create or replace function public.staff_owner_choices()
 returns table(user_id uuid, name text)
 language sql
 stable
 security definer
 set search_path to 'public', 'auth'
as $function$
  select s.user_id, coalesce(nullif(btrim(s.display_name), ''), u.email::text)
    from staff s left join auth.users u on u.id = s.user_id
   where public.is_staff() and s.disabled_at is null and coalesce(s.role, '') not in ('volunteer', 'door')
   order by 2;
$function$;
revoke all on function public.staff_owner_choices() from public, anon;
grant execute on function public.staff_owner_choices() to authenticated;

-- ── 3. Who a follow-up is for ────────────────────────────────────────────────────────────────────
-- _account_followups_stamp (20261111180700) stamps only its own columns, so the page's assignee passes through on
-- insert and on update (staff may hand a follow-up to someone else).
alter table public.account_followups add column if not exists assignee uuid;
create index if not exists account_followups_assignee on public.account_followups (assignee) where done_at is null;

-- ── 4. Download their data ───────────────────────────────────────────────────────────────────────
create or replace function public.staff_customer_export(p_id text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  -- staff-side records that are not the person's data, or that hold nothing but secrets
  _skip   text[] := array['customer_owner_pwd', 'customer_handoffs', 'push_outbox', 'pii_reveals'];
  -- keys that never leave, in any table
  _secret text := '^(password_hash|pwd_hash|session_token|fix_token|track_token|account_oauth|feed_key|client_key|endpoint|auth|p256dh|keys)$';
  _acct   jsonb;
  _rows   jsonb;
  _tables jsonb := '{}'::jsonb;
  _notes  jsonb;
  _tb     text;
begin
  if not public.is_admin() then
    raise exception 'ADMIN_ONLY' using errcode = '42501';
  end if;
  select to_jsonb(c) into _acct from customers c where c.id = p_id;
  if _acct is null then
    raise exception 'NO_ACCOUNT' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into _acct from jsonb_each(_acct) e(k, v) where k !~ _secret;

  for _tb in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'customer_id' and t.table_type = 'BASE TABLE'
       and c.table_name <> all (_skip)
     order by c.table_name
  loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from (select * from public.%I where customer_id::text = $1 limit 5000) x', _tb)
      into _rows using p_id;
    if jsonb_array_length(_rows) > 0 then
      select coalesce(jsonb_agg((select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(r) e(k, v) where k !~ _secret)), '[]'::jsonb)
        into _rows from jsonb_array_elements(_rows) r;
      _tables := _tables || jsonb_build_object(_tb, _rows);
    end if;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('at', s.created_at, 'by', s.author_name, 'note', s.body) order by s.created_at), '[]'::jsonb)
    into _notes from staff_comments s where s.kind = 'customer' and s.target_id = p_id;

  return jsonb_build_object(
    'account_id', p_id,
    'exported_at', now(),
    'exported_by', (select coalesce(nullif(btrim(s.display_name), ''), auth.jwt() ->> 'email') from staff s where s.user_id = auth.uid()),
    'account', _acct,
    'staff_notes', _notes,
    'tables', _tables);
end $function$;
revoke all on function public.staff_customer_export(text) from public, anon;
grant execute on function public.staff_customer_export(text) to authenticated;

-- ── Checks ───────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._account_family_stamp()', 'public._account_owners_stamp()', 'public.staff_customer_export(text)', 'public.staff_owner_choices()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public.account_family', 'public.account_owners'] loop
    if not (select relrowsecurity from pg_class where oid = f::regclass) then
      raise exception 'row level security is off on %', f;
    end if;
    if has_table_privilege('anon', f, 'select') then
      raise exception 'anon can read %', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.staff_customer_export(text)', 'execute')
     or has_function_privilege('anon', 'public.staff_owner_choices()', 'execute') then
    raise exception 'anon can run a people round function';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'account_followups' and column_name = 'assignee') then
    raise exception 'account_followups.assignee is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261118210000', 'people_round')
on conflict (version) do nothing;

commit;

-- Read-only check after applying (expect: t, t, t, t, f, f, 1):
-- select to_regclass('public.account_family') is not null, to_regclass('public.account_owners') is not null,
--        (select prosecdef from pg_proc where oid = 'public.staff_customer_export(text)'::regprocedure),
--        exists (select 1 from information_schema.columns where table_name = 'account_followups' and column_name = 'assignee'),
--        has_table_privilege('anon', 'public.account_family', 'select'),
--        has_function_privilege('anon', 'public.staff_customer_export(text)', 'execute'),
--        (select count(*) from supabase_migrations.schema_migrations where version = '20261118210000');
