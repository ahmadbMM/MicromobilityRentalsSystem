-- Every field of an application is a field of the account (the owner, 2026-10-02: "when i edit an account
-- where are the company and profession fields, the bike owning question must put the bike type preference on
-- bike owner on default and make it changeable if the applicant was a bike owner", then "i want to have every
-- field in the applications to be as a field in the account info or staff editing account page").
--
--   customers: staff may now update profession, workplace (Company) and heard_from from the account editor.
--     UPDATE on customers is granted column by column; these three were never in the list. The row policy
--     ("staff update", is_staff()) is unchanged, so only staff write them.
--   customer_community_apply: a bike type of Own ("Bike owner") is accepted. The form picks it when the
--     applicant says they have their own bike, and they may change it.
--   staff_community_approve: an account that already exists takes the application's bike type when its own
--     is still Any (the form makes accounts with Any); every other field it already copies when blank.
--
-- Both functions are rebuilt from their live definitions (pg_get_functiondef keeps SECURITY DEFINER and the
-- search_path), and refuse to run if the text they edit is not there.

grant update (profession, workplace, heard_from) on public.customers to authenticated;

do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.customer_community_apply(text,text,jsonb)'::regprocedure);
  if position('''Mountain'',''Own''' in d) = 0 then
    n := replace(d, E'if v_type not in (''Road'',''Hybrid'',''Mountain'') then',
                    E'if v_type not in (''Road'',''Hybrid'',''Mountain'',''Own'') then');
    if n = d then raise exception 'customer_community_apply: bike type check not found'; end if;
    execute n;
  end if;

  d := pg_get_functiondef('public.staff_community_approve(uuid,text,boolean)'::regprocedure);
  if position('type_preference = case' in d) = 0 then
    n := replace(d, E'      heard_from  = coalesce(heard_from, a.heard_from),\n',
                    E'      heard_from  = coalesce(heard_from, a.heard_from),\n'
                 || E'      type_preference = case when coalesce(nullif(type_preference, ''''), ''Any'') = ''Any'' and coalesce(a.bike_type, '''') <> ''''\n'
                 || E'                             then a.bike_type else type_preference end,\n');
    if n = d then raise exception 'staff_community_approve: account update not found'; end if;
    execute n;
  end if;
end $mig$;

do $chk$
begin
  if not (select bool_and(prosecdef) from pg_proc where oid in
      ('public.customer_community_apply(text,text,jsonb)'::regprocedure, 'public.staff_community_approve(uuid,text,boolean)'::regprocedure)) then
    raise exception 'an application function lost SECURITY DEFINER';
  end if;
  if not has_column_privilege('authenticated', 'public.customers', 'workplace', 'UPDATE') then
    raise exception 'workplace is not updatable by staff';
  end if;
end $chk$;
