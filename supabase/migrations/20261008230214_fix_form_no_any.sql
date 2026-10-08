-- Any is staff's to give, never a rider's (the owner, 2026-10-09: "remove the any choice from
-- everywhere for the customers ... make sure they can never choose any"; first ruled 2026-10-02,
-- 20261002160000 closed customer_create_booking / customer_booking_update).
--
--   customer_fix_save  the "fix your details" form staff send (correction requests) offered Any in
--                      its bike-type list; the app no longer does, and the server now skips a
--                      type_preference of Any the same way it skips any other value it refuses.
--
-- Rebuilt from its own live definition (pg_get_functiondef keeps SECURITY DEFINER and the
-- search_path); refuses to run if the text it edits is not there.

do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.customer_fix_save(text,text,jsonb)'::regprocedure);
  if position('if not _type_ok(v) or v = ''Any'' then continue; end if;' in d) = 0 then
    n := replace(d,
      E'      when ''type_preference'' then\n        if not _type_ok(v) then continue; end if;\n',
      E'      when ''type_preference'' then\n        if not _type_ok(v) or v = ''Any'' then continue; end if;\n');
    if n = d then raise exception 'customer_fix_save: type check not found'; end if;
    execute n;
  end if;
end
$mig$;
