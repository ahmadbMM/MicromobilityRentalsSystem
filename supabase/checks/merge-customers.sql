-- Merge accounts: is the live staff_merge_customers the fixed one (20260928190000)?
-- Read-only. Prints one row per drift and nothing when clean.
--   fill_by_concat   the body still appends field names with || 'name' (malformed array literal)
--   fill_count       fewer than ten array_append(fl, ...) lines
--   not_definer      lost SECURITY DEFINER (is_admin/customers reads would fail for the desk)
--   search_path      lost SET search_path
--   anon_execute     anon may call it
select 'fill_by_concat' as drift, count(*)::text as detail
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'staff_merge_customers' and p.prosrc ~ 'fl := fl \|\| '''
having count(*) > 0
union all
select 'fill_count', (select count(*) from regexp_matches(p.prosrc, 'array_append\(fl, ''', 'g'))::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'staff_merge_customers'
   and (select count(*) from regexp_matches(p.prosrc, 'array_append\(fl, ''', 'g')) <> 10
union all
select 'not_definer', p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('staff_merge_customers', 'staff_unmerge_customers') and not p.prosecdef
union all
select 'search_path', p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('staff_merge_customers', 'staff_unmerge_customers')
   and coalesce(array_to_string(p.proconfig, ','), '') not like 'search_path=%'
union all
select 'anon_execute', p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('staff_merge_customers', 'staff_unmerge_customers')
   and has_function_privilege('anon', p.oid, 'execute');
