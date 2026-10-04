-- ============================================================================
-- No booking without an agreed waiver (the owner, 2026-10-03: "you can't book anything without
-- agreeing" must be literally true).
--
-- customer_create_booking is the only way a customer makes a booking (the booking app and the
-- website both call it; customers cannot write queue_entries directly). Every rider row it is
-- given must now carry the waiver the customer agreed to (waiver_version: the ride, swim or
-- activity waiver, e.g. 2026-10-v2, swim-2026-10-v2, activity-2026-10-v1); a row without one
-- refuses the whole booking with WAIVER_REQUIRED, before anything is written. Riders added by
-- staff are unchanged (owner's decision 2026-09-02).
--
-- The live function is patched in place (pg_get_functiondef keeps SECURITY DEFINER, search_path
-- and the rest of the header): one check is added in the first pass over the entries, just
-- before the type check. The patch refuses to run if its anchor is not found exactly once.
--
-- Rollback: run the same block with the inserted lines removed (replace the new text with the
-- anchor alone).
-- Idempotent: a second run finds the check already there and does nothing.
-- ============================================================================
do $patch$
declare
  def text := pg_get_functiondef('public.customer_create_booking(text, text, jsonb)'::regprocedure);
  anchor constant text := E'    if _type = ''Any'' then   -- Any is staff''s to give (20261002160000)\n';
  check_ constant text := E'    if coalesce(it->>''waiver_version'', '''') !~ ''^[A-Za-z0-9._-]{1,40}$'' then\n'
                       || E'      raise exception ''WAIVER_REQUIRED'' using errcode = ''P0001'';   -- every booking needs an agreed waiver (20261003210000)\n'
                       || E'    end if;\n';
begin
  if position('WAIVER_REQUIRED' in def) > 0 then
    raise notice 'customer_create_booking already requires a waiver; nothing to do';
    return;
  end if;
  if (length(def) - length(replace(def, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'anchor not found exactly once in customer_create_booking; not patched';
  end if;
  execute replace(def, anchor, check_ || anchor);
end $patch$;
