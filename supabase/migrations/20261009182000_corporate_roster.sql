-- Partner companies' employee lists (staff app research 2026-10-09, M20). Petromin (and Petrolube, and any
-- partner after them) send a list of their employees; staff import it as a CSV and the Petromin page then
-- says, beside each registration, whether its employee id is on the company's list.
--
-- corporate_roster: one row per employee of a partner company. employee_id is the number on the staff
--   card (rider_registrations.badge); a company and an employee id are one person whatever the case or the
--   spaces (the unique index). active false = the employee left the list on a later import (kept, so a
--   past night's registration still reads who they were). Staff read it; no client writes it.
-- staff_roster_import(p_company, p_rows, p_replace): admins only. p_rows is a JSON array of
--   {employee_id, name, phone}; each row is added or brought up to date (and made active again). With
--   p_replace, the company's employees not in the file are made inactive. Answers
--   {added, updated, deactivated, skipped}; a row with no employee id or no name is skipped (the page
--   already showed it as an error row).
--
-- Rollback: drop function public.staff_roster_import(text, jsonb, boolean); drop table public.corporate_roster;

begin;

create table if not exists public.corporate_roster (
  id           bigint generated always as identity primary key,
  company      text not null check (length(btrim(company)) between 1 and 80),
  employee_id  text not null check (length(btrim(employee_id)) between 1 and 40),
  name         text not null check (length(btrim(name)) between 1 and 120),
  phone        text check (phone is null or length(phone) <= 30),
  active       boolean not null default true,
  imported_at  timestamptz not null default now(),
  imported_by  uuid,
  updated_at   timestamptz not null default now()
);
create unique index if not exists corporate_roster_person_uq
  on public.corporate_roster (lower(btrim(company)), upper(btrim(employee_id)));
create index if not exists corporate_roster_phone_idx on public.corporate_roster (phone);

alter table public.corporate_roster enable row level security;
drop policy if exists "corporate_roster staff read" on public.corporate_roster;
create policy "corporate_roster staff read" on public.corporate_roster
  for select to authenticated using ((select is_staff()));
revoke all on public.corporate_roster from anon, authenticated;
grant select on public.corporate_roster to authenticated;

create or replace function public.staff_roster_import(p_company text, p_rows jsonb, p_replace boolean default false)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $fn$
declare
  v_co text := btrim(coalesce(p_company, ''));
  r jsonb; v_eid text; v_name text; v_phone text;
  v_add int := 0; v_upd int := 0; v_skip int := 0; v_off int := 0;
  v_seen text[] := '{}';
begin
  if not coalesce((select is_admin()), false) then
    raise exception 'ADMIN_ONLY: admins only' using errcode = '42501';
  end if;
  if v_co = '' or length(v_co) > 80 then
    raise exception 'BAD_COMPANY: name the company' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'BAD_ROWS: a list of at most 5000 employees' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_eid := left(btrim(coalesce(r->>'employee_id', '')), 40);
    v_name := left(regexp_replace(btrim(coalesce(r->>'name', '')), '\s+', ' ', 'g'), 120);
    v_phone := nullif(left(btrim(coalesce(r->>'phone', '')), 30), '');
    if v_eid = '' or v_name = '' or upper(v_eid) = any (v_seen) then v_skip := v_skip + 1; continue; end if;
    v_seen := v_seen || upper(v_eid);
    update corporate_roster set name = v_name, phone = coalesce(v_phone, phone), active = true,
           imported_at = now(), imported_by = auth.uid(), updated_at = now()
     where lower(btrim(company)) = lower(v_co) and upper(btrim(employee_id)) = upper(v_eid);
    if found then v_upd := v_upd + 1;
    else
      insert into corporate_roster (company, employee_id, name, phone, imported_by)
      values (v_co, v_eid, v_name, v_phone, auth.uid());
      v_add := v_add + 1;
    end if;
  end loop;
  if coalesce(p_replace, false) then
    update corporate_roster set active = false, updated_at = now()
     where lower(btrim(company)) = lower(v_co) and active and not (upper(btrim(employee_id)) = any (v_seen));
    get diagnostics v_off = row_count;
  end if;
  return jsonb_build_object('added', v_add, 'updated', v_upd, 'deactivated', v_off, 'skipped', v_skip);
end
$fn$;
revoke all on function public.staff_roster_import(text, jsonb, boolean) from public, anon;
grant execute on function public.staff_roster_import(text, jsonb, boolean) to authenticated;

do $chk$
begin
  if has_table_privilege('anon', 'public.corporate_roster', 'select')
     or has_table_privilege('authenticated', 'public.corporate_roster', 'insert') then
    raise exception 'corporate_roster is open to the wrong roles';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.staff_roster_import(text, jsonb, boolean)'::regprocedure)
     or has_function_privilege('anon', 'public.staff_roster_import(text, jsonb, boolean)', 'execute') then
    raise exception 'staff_roster_import carries the wrong attributes';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009182000', 'corporate_roster')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
