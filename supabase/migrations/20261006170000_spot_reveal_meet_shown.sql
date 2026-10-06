-- ============================================================================
-- The Saturday ride's meeting point shows at once; only the breakfast spot (and where the ride goes) waits for
-- the time staff chose (the owner, 2026-10-06: "show the meeting point immediately only hide the breakfast spot
-- and location").
--
-- list_sessions (rebuilt from 20261006150000, header copied) no longer blanks meet_url before sessions.reveal_at;
-- it still blanks location, route_slug and the breakfast stop (breakfast_name, breakfast_url, breakfast_name_ar,
-- breakfast_offer_en, breakfast_offer_ar). The table's read policy is unchanged: until the time a direct read by
-- anyone but staff still does not see the row, which holds the breakfast stop; riders read through list_sessions.
--
-- Rollback: re-run the list_sessions of 20261006150000_spot_reveal.sql.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

CREATE OR REPLACE FUNCTION public.list_sessions(p_id text, p_token text)
 RETURNS SETOF sessions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  s sessions%rowtype;
  mine boolean := p_id is not null and p_token is not null and _cust_token_ok(p_id, p_token);
begin
  for s in
    select x.* from sessions x
     where x.required_tag_id is null
        or (mine and (
             exists (select 1 from customer_tags ct
                      where ct.customer_id = p_id and ct.tag_id = x.required_tag_id
                        and _ctag_active(ct.starts_at, ct.expires_at))
             -- a booking the rider still holds, or a night they rode, keeps it visible after the tag lapses
             or exists (select 1 from queue_entries q
                         where q.session_id = x.id and q.customer_id = p_id
                           and q.status in ('waiting','waitlist','active','done'))))
     order by x.session_date
  loop
    -- the breakfast stop and where the ride goes stay unsaid until staff's time (sessions.reveal_at); the
    -- meeting point shows at once (2026-10-06)
    if s.reveal_at is not null and s.reveal_at > now() then
      s.location := null; s.route_slug := null;
      s.breakfast_name := null; s.breakfast_url := null; s.breakfast_name_ar := null;
      s.breakfast_offer_en := null; s.breakfast_offer_ar := null;
    end if;
    return next s;
  end loop;
end $function$;
-- (create or replace keeps the function's grants: public, anon and authenticated, as before)

comment on column public.sessions.reveal_at is
  'Until this time riders are not told where the ride has breakfast: list_sessions blanks location, route_slug and the breakfast_* columns (the meeting point shows at once, 2026-10-06), and the table hides the row from everyone but staff. Null = shown at once.';

do $chk$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'list_sessions' and p.prosecdef
                    and p.proconfig @> array['search_path=public, extensions']
                    and p.prosrc not ilike '%s.meet_url := null%' and p.prosrc ilike '%s.breakfast_name := null%') then
    raise exception 'list_sessions is not the one that shows the meeting point and holds the breakfast stop';
  end if;
  if not has_function_privilege('anon', 'public.list_sessions(text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.list_sessions(text,text)', 'execute') then
    raise exception 'a client grant on list_sessions is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261006170000', 'spot_reveal_meet_shown')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
