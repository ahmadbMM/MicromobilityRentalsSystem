-- Any is staff's to give (the owner, 2026-10-02: "remove the any option from the customers from
-- everywhere from now on only allow staff to use it", then "let's do 1": refuse it on the server too).
-- The rider app stopped offering Any the same day; a copy of the app cached from before could still
-- send it until it updates. Staff add bookings with direct inserts (is_staff RLS), not through these
-- functions, so they keep Any.
--
--   customer_create_booking  refuses a booking whose bike type is Any (or missing, which read as Any)
--                            with PICK_TYPE; the app takes the rider back to choose a type. A ride
--                            without bikes books 'None', which stays allowed.
--   customer_booking_update  ignores a change of type to Any; the booking keeps the type it had.
--
-- Both are rebuilt from their own live definitions (pg_get_functiondef keeps SECURITY DEFINER and the
-- search_path), and refuse to run if the text they edit is not there.

do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure);
  if position('PICK_TYPE' in d) = 0 then
    n := replace(d,
      E'    if not _type_ok(_type) then\n      raise exception ''BAD_INPUT'' using errcode = ''22023'', detail = ''type_preference'';\n    end if;\n',
      E'    if not _type_ok(_type) then\n      raise exception ''BAD_INPUT'' using errcode = ''22023'', detail = ''type_preference'';\n    end if;\n    if _type = ''Any'' then   -- Any is staff''s to give (20261002160000)\n      raise exception ''PICK_TYPE'' using errcode = ''22023'', detail = ''type_preference'';\n    end if;\n');
    if n = d then raise exception 'customer_create_booking: type check not found'; end if;
    execute n;
  end if;

  d := pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure);
  if position('<> ''Any''' in d) = 0 then
    n := replace(d,
      E'if _p ? ''type_preference'' and _type_ok(_p->>''type_preference'') then',
      E'if _p ? ''type_preference'' and _type_ok(_p->>''type_preference'') and (_p->>''type_preference'') <> ''Any'' then');
    if n = d then raise exception 'customer_booking_update: type line not found'; end if;
    execute n;
  end if;
end $mig$;

do $chk$
begin
  if not (select bool_and(prosecdef) from pg_proc where oid in
      ('public.customer_create_booking(text,text,jsonb)'::regprocedure, 'public.customer_booking_update(text,text,text,jsonb)'::regprocedure)) then
    raise exception 'a rider booking function lost SECURITY DEFINER';
  end if;
  if position('PICK_TYPE' in pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure)) = 0
     or position('<> ''Any''' in pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'Any is not refused';
  end if;
end $chk$;
