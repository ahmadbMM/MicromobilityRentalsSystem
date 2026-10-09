-- ============================================================================
-- Free-text search in History > Audit trail (staff app round 2, 2026-10-09).
--
-- staff_audit_search(p_q, p_tbl, p_row, p_actor, p_from, p_to, p_before, p_limit): the audit rows whose
-- record id or changed values (changed::text: field names, old and new values, a deleted row's columns)
-- contain p_q, case-insensitive, with the panel's other filters, newest first. Admins only (the panel is
-- theirs; audit_log itself stays staff-readable as before). p_q is 2-100 characters, taken literally
-- (% and _ are escaped). At most 200 rows a call; p_before (an id) pages back.
--
-- No trigram index: audit_log holds about 1,300 rows (750 kB) with 24 months' retention, the panel always
-- sends a date range (audit_log_at_idx), and pg_trgm is not installed here. Revisit past ~200k rows.
--
-- Rollback: drop function public.staff_audit_search(text, text, text, uuid, timestamptz, timestamptz, bigint, int).
-- Idempotent.
-- ============================================================================

begin;

create or replace function public.staff_audit_search(
  p_q text, p_tbl text default null, p_row text default null, p_actor uuid default null,
  p_from timestamptz default null, p_to timestamptz default null, p_before bigint default null,
  p_limit int default 100)
returns table (id bigint, at timestamptz, actor uuid, actor_email text, tbl text, row_id text, op text, changed jsonb)
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_q text := btrim(coalesce(p_q, '')); v_pat text;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if length(v_q) < 2 or length(v_q) > 100 then raise exception 'BAD_QUERY' using errcode = '22023'; end if;
  v_pat := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return query
    select a.id, a.at, a.actor, a.actor_email, a.tbl, a.row_id, a.op, a.changed
      from audit_log a
     where (p_tbl is null or p_tbl = '' or a.tbl = p_tbl)
       and (p_row is null or p_row = '' or a.row_id = p_row)
       and (p_actor is null or a.actor = p_actor)
       and (p_from is null or a.at >= p_from)
       and (p_to is null or a.at < p_to)
       and (p_before is null or a.id < p_before)
       and (coalesce(a.row_id, '') ilike v_pat or a.changed::text ilike v_pat)
     order by a.id desc
     limit least(greatest(coalesce(p_limit, 100), 1), 200);
end $$;
revoke execute on function public.staff_audit_search(text, text, text, uuid, timestamptz, timestamptz, bigint, int) from public, anon;
grant execute on function public.staff_audit_search(text, text, text, uuid, timestamptz, timestamptz, bigint, int) to authenticated;

do $chk$
begin
  if not exists (select 1 from pg_proc p
                  where p.oid = 'public.staff_audit_search(text,text,text,uuid,timestamptz,timestamptz,bigint,int)'::regprocedure
                    and p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))
     or has_function_privilege('anon', 'public.staff_audit_search(text,text,text,uuid,timestamptz,timestamptz,bigint,int)', 'execute') then
    raise exception 'staff_audit_search carries the wrong attributes';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009206000', 'audit_search_text')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
