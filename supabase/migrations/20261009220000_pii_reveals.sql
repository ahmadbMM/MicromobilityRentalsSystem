-- ============================================================================
-- Personal data shown on purpose (PDPL Art. 19, least privilege), 2026-10-10.
--
-- The staff app hides riders' phone numbers, WhatsApp numbers, emails, emergency contacts and birth
-- dates until a staffer taps to show them, and records each look. This is a SCREEN mask: a staff
-- account can still read those columns through the API exactly as before (staff_sync, the account
-- editor and every report read them). No column grant changes here: revoking customers columns
-- broke the invoker staff_sync once already (2026-09-25).
--
--  1. pii_reveals: one row per look - who (auth.uid() and the account's name), when, which customer
--     and/or booking, which fields, and how (reveal | call | whatsapp | email | copy | edit), or, for
--     a list that left the app (export | print), what list and how many rows. Rows are written only by
--     staff_pii_reveal; admins and the Owner role read them (History > Data access). Nobody updates or
--     deletes them through the API.
--  2. staff_pii_reveal(customer, fields, via, booking, what, rows): any staffer. Also writes one
--     staff_actions line (kind 'pii'), so the Action Log shows the look beside everything else.
--  3. staff_set_caps takes a fifth cap, can_see_pii_unmasked: an account with it sees personal data
--     without the mask (nothing is recorded for what it sees, only what it exports). Default off for
--     every account, admins included: an admin taps to show like everyone else.
--  4. staff_access_reviewed(note): admins stamp the quarterly access review (who, when, how many
--     accounts) into staff_options 'biz.access_review' (admin-only by the 20261009160000 policies),
--     with a staff_actions line.
--
-- The Business setting pii_mask (staff_options 'biz', staff_set_biz) turns the mask off for everyone
-- when an admin sets it to false; unset means on.
--
-- Rollback: drop function public.staff_pii_reveal(text,text[],text,text,text,integer);
--   drop function public.staff_access_reviewed(text); drop table public.pii_reveals;
--   delete from staff_options where key = 'biz.access_review';
--   re-run the saved pg_get_functiondef of public.staff_set_caps(uuid,jsonb) (the patched line
--   carries "(20261009220000)"); update staff set caps = caps - 'can_see_pii_unmasked'.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

-- ── 1. The record of looks ──────────────────────────────────────────────────────────────────
create table if not exists public.pii_reveals (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid,
  who         text,
  customer_id text,
  booking_id  text,
  fields      text[] not null default '{}',
  via         text not null,
  what        text,
  n_rows      integer,
  constraint pii_reveals_via check (via in ('reveal', 'call', 'whatsapp', 'email', 'copy', 'edit', 'export', 'print')),
  constraint pii_reveals_fields check (cardinality(fields) <= 8
    and fields <@ array['phone', 'whatsapp', 'email', 'emergency', 'emergency2', 'birth_date']::text[]),
  constraint pii_reveals_len check (length(coalesce(who, '')) <= 120 and length(coalesce(customer_id, '')) <= 200
    and length(coalesce(booking_id, '')) <= 200 and length(coalesce(what, '')) <= 120),
  constraint pii_reveals_rows check (n_rows is null or n_rows between 0 and 1000000)
);
create index if not exists pii_reveals_at_idx on public.pii_reveals (at desc);
create index if not exists pii_reveals_customer_idx on public.pii_reveals (customer_id, at desc);
create index if not exists pii_reveals_user_idx on public.pii_reveals (user_id, at desc);

alter table public.pii_reveals enable row level security;
revoke all on table public.pii_reveals from public, anon, authenticated;
grant select on table public.pii_reveals to authenticated;
drop policy if exists pii_reveals_read on public.pii_reveals;
create policy pii_reveals_read on public.pii_reveals for select to authenticated
  using ((select is_admin()) or exists (select 1 from public.staff s
         where s.user_id = (select auth.uid()) and s.role = 'owner' and s.disabled_at is null));

-- ── 2. A look, recorded ─────────────────────────────────────────────────────────────────────
create or replace function public.staff_pii_reveal(p_customer text, p_fields text[], p_via text default 'reveal',
                                                   p_booking text default null, p_what text default null, p_rows integer default null)
returns boolean
language plpgsql security definer set search_path to 'public', 'auth'
as $$
declare
  v_fields text[];
  v_via text := lower(coalesce(p_via, 'reveal'));
  v_who text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if v_via not in ('reveal', 'call', 'whatsapp', 'email', 'copy', 'edit', 'export', 'print') then
    raise exception 'BAD_VIA' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct f order by f), '{}') into v_fields
    from unnest(coalesce(p_fields, '{}')) f
   where f in ('phone', 'whatsapp', 'email', 'emergency', 'emergency2', 'birth_date');
  if v_via in ('export', 'print') then
    if p_what is null or btrim(p_what) = '' then raise exception 'BAD_WHAT' using errcode = '22023'; end if;
  elsif nullif(btrim(coalesce(p_customer, '')), '') is null and nullif(btrim(coalesce(p_booking, '')), '') is null then
    raise exception 'NO_RECORD' using errcode = '22023';
  end if;
  select coalesce(nullif(btrim(s.display_name), ''), u.email) into v_who
    from staff s left join auth.users u on u.id = s.user_id where s.user_id = auth.uid();
  insert into pii_reveals (user_id, who, customer_id, booking_id, fields, via, what, n_rows)
  values (auth.uid(), left(coalesce(v_who, 'staff'), 120), left(nullif(btrim(coalesce(p_customer, '')), ''), 200),
          left(nullif(btrim(coalesce(p_booking, '')), ''), 200), v_fields, v_via, left(nullif(btrim(coalesce(p_what, '')), ''), 120),
          case when p_rows is null then null else greatest(0, least(p_rows, 1000000)) end);
  insert into staff_actions (at, action, who, device, view, user_id, kind, entity, entity_id)
  values (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          left('Personal data ' || v_via || ': ' || coalesce(nullif(array_to_string(v_fields, ', '), ''), '-')
               || case when v_via in ('export', 'print') then ' (' || coalesce(btrim(p_what), '') || ', ' || coalesce(p_rows, 0) || ' rows)' else '' end, 300),
          left(coalesce(v_who, 'staff'), 80), 'server', 'privacy', auth.uid(), 'pii',
          case when nullif(btrim(coalesce(p_customer, '')), '') is not null then 'customers'
               when nullif(btrim(coalesce(p_booking, '')), '') is not null then 'queue_entries' end,
          left(coalesce(nullif(btrim(coalesce(p_customer, '')), ''), nullif(btrim(coalesce(p_booking, '')), '')), 200));
  return true;
end $$;
revoke execute on function public.staff_pii_reveal(text, text[], text, text, text, integer) from public, anon;
grant execute on function public.staff_pii_reveal(text, text[], text, text, text, integer) to authenticated;

-- ── 3. A fifth cap ──────────────────────────────────────────────────────────────────────────
do $sc$
declare d text;
begin
  d := pg_get_functiondef('public.staff_set_caps(uuid,jsonb)'::regprocedure);
  if position('(20261009220000)' in d) > 0 then raise notice 'staff_set_caps already takes can_see_pii_unmasked'; return; end if;
  d := pg_temp._once(d,
$a$'can_refund', 'can_undo'$a$,
$b$'can_refund', 'can_undo', 'can_see_pii_unmasked' /* personal data unmasked (20261009220000) */$b$);
  execute d;
end $sc$;

-- ── 4. The quarterly access review ──────────────────────────────────────────────────────────
create or replace function public.staff_access_reviewed(p_note text default null)
returns jsonb
language plpgsql security definer set search_path to 'public', 'auth'
as $$
declare v_who text; v_n int; v jsonb;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  select coalesce(nullif(btrim(s.display_name), ''), u.email) into v_who
    from staff s left join auth.users u on u.id = s.user_id where s.user_id = auth.uid();
  select count(*) into v_n from staff where disabled_at is null;
  v := jsonb_build_object('at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                          'by', left(coalesce(v_who, 'admin'), 120), 'uid', auth.uid(), 'accounts', v_n,
                          'note', left(nullif(btrim(coalesce(p_note, '')), ''), 500));
  insert into staff_options (key, items, updated_at) values ('biz.access_review', v, now())
    on conflict (key) do update set items = excluded.items, updated_at = excluded.updated_at;
  insert into staff_actions (at, action, who, device, view, user_id, kind)
  values (v ->> 'at', left('Access review recorded (' || v_n || ' accounts)', 300), left(coalesce(v_who, 'admin'), 80),
          'server', 'privacy', auth.uid(), 'review');
  return v;
end $$;
revoke execute on function public.staff_access_reviewed(text) from public, anon;
grant execute on function public.staff_access_reviewed(text) to authenticated;

-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public.staff_pii_reveal(text,text[],text,text,text,integer)', 'public.staff_access_reviewed(text)',
                           'public.staff_set_caps(uuid,jsonb)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
    if not has_function_privilege('authenticated', f, 'execute') then raise exception '% lost its authenticated grant', f; end if;
  end loop;
  if position('(20261009220000)' in pg_get_functiondef('public.staff_set_caps(uuid,jsonb)'::regprocedure)) = 0 then
    raise exception 'staff_set_caps was not patched';
  end if;
  if has_table_privilege('anon', 'public.pii_reveals', 'select') then raise exception 'pii_reveals is readable by anon'; end if;
  if has_table_privilege('authenticated', 'public.pii_reveals', 'insert') then raise exception 'pii_reveals is writable through the API'; end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009220000', 'pii_reveals')
on conflict (version) do nothing;

commit;
