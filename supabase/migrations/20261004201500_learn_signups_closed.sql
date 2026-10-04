-- ============================================================================
-- Learn-to-ride sign-ups can be stopped (the owner, 2026-10-04: "add an option in staff website to stop
-- taking bike learning applications, show in the website that currently we are not taking any
-- applications").
--
-- The switch is the website's: Experiences > Learn to ride > "Taking sign-ups" in the staff Website
-- editor, also in Community > Applications > Learn to ride - site_content 'experiences.learn.taking'.
-- Off, micromobility.sa/experiences/learn shows "Sign-ups are closed for now" in place of the form, and
-- the question on Home and Experiences says so instead of its button. This makes it hold in the
-- database too: while it is false - or 'experiences.learn.on' ("Offer lessons", which closes the page)
-- is false - customer_learn_apply answers {ok: false, error: 'closed'} and writes nothing, so a page
-- opened before the switch, or a call made by hand, cannot send one. The form shows the closed text on
-- that answer. Anything but an explicit false (no row, true) keeps sign-ups open, as the website reads it.
-- learn_apply itself is not callable by clients (20261004100000); Ask for changes (learn_fix_submit)
-- and everything staff do are untouched.
--
-- The function is patched in place from its live definition (pg_get_functiondef keeps SECURITY DEFINER
-- and the search_path; create or replace keeps grants); the patch must change the text or it stops.
-- Rollback: re-run this file's patch backwards - pg_get_functiondef, remove the four lines marked
-- 20261004201500, execute. Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

do $patch$
declare d text; n text;
begin
  d := pg_get_functiondef('public.customer_learn_apply(text,text,jsonb)'::regprocedure);
  if position('experiences.learn.taking' in d) = 0 then
    n := replace(d, E'\n  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then\n',
                    E'\n  -- Not taking sign-ups: staff switched the website''s Learn to ride off (20261004201500).\n'
                 || E'  if exists (select 1 from site_content where key in (''experiences.learn.taking'', ''experiences.learn.on'') and value = ''false''::jsonb) then\n'
                 || E'    return jsonb_build_object(''ok'', false, ''error'', ''closed'');\n'
                 || E'  end if;\n'
                 || E'  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then\n');
    if n = d then raise exception 'customer_learn_apply is not the definition this migration expects'; end if;
    execute n;
  end if;
end $patch$;

do $chk$
begin
  if position('experiences.learn.taking' in pg_get_functiondef('public.customer_learn_apply(text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'customer_learn_apply was not patched';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.customer_learn_apply(text,text,jsonb)'::regprocedure) then
    raise exception 'customer_learn_apply lost SECURITY DEFINER';
  end if;
  if not has_function_privilege('anon', 'public.customer_learn_apply(text,text,jsonb)', 'execute') then
    raise exception 'customer_learn_apply lost its anon grant';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261004201500', 'learn_signups_closed')
on conflict (version) do nothing;

commit;
