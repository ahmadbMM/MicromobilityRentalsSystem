-- ============================================================================
-- The Saturday ride's meeting point and breakfast spot, announced at a time staff choose (the owner,
-- 2026-10-06: "add an option for saturday social ride to announce/make the spot and location visible
-- at the time the staff chooses").
--
--  1. sessions.reveal_at (timestamptz; null = shown as soon as staff set them, as before). Until that
--     time riders are not told where the ride meets, where it goes or where it has breakfast. The time
--     itself is not secret: riders read it, and the app and the website say "announced <time>".
--  2. list_sessions - the riders' one read of the rides (the booking app, the website, the wallet pass)
--     - returns such a ride with location, meet_url, route_slug and the breakfast stop (breakfast_name,
--     breakfast_url, breakfast_name_ar, breakfast_offer_en, breakfast_offer_ar) blank while reveal_at
--     is ahead of now(). Its date, times and places read as before. Rebuilt from 20260929010000 (header
--     copied, not taken from prosrc): the same rows in the same order, through a loop that blanks them.
--  3. The table's read policy keeps such a ride from a direct read by anyone but staff until the time:
--     the public key can read the table itself, and the live channel delivers rows under the same
--     policy, and RLS hides rows, not columns. The website's signed-out read goes through
--     list_sessions(null, null) for that reason (mm-platform, same day); the booking app's customers
--     already read through it.
-- The values stay where they always were, written by the same hands (the desk's editor, the vendor
-- portal's confirmation, a template), and staff read the table whole as before. At the time nothing
-- has to run: the next read carries them, and the pages read again when the time comes.
--
-- Rollback: alter policy "read ungated or staff" on public.sessions
--     using (required_tag_id is null or (select is_staff()));
--   create or replace list_sessions from 20260929010000_badges_more.sql;
--   alter table public.sessions drop column if exists reveal_at;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

alter table public.sessions add column if not exists reveal_at timestamptz;
comment on column public.sessions.reveal_at is
  'Until this time riders are not told where the ride meets or has breakfast: list_sessions blanks location, meet_url, route_slug and the breakfast_* columns, and the table hides the row from everyone but staff. Null = shown at once.';

alter policy "read ungated or staff" on public.sessions
  using ((required_tag_id is null and (reveal_at is null or reveal_at <= now())) or (select is_staff()));

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
    -- where the ride meets and breakfasts stays unsaid until staff's time (sessions.reveal_at)
    if s.reveal_at is not null and s.reveal_at > now() then
      s.location := null; s.meet_url := null; s.route_slug := null;
      s.breakfast_name := null; s.breakfast_url := null; s.breakfast_name_ar := null;
      s.breakfast_offer_en := null; s.breakfast_offer_ar := null;
    end if;
    return next s;
  end loop;
end $function$;
-- (create or replace keeps the function's grants: public, anon and authenticated, as before)

do $chk$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'sessions' and column_name = 'reveal_at' and data_type = 'timestamp with time zone') then
    raise exception 'sessions.reveal_at is missing';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sessions'
                   and policyname = 'read ungated or staff' and qual ilike '%reveal_at%') then
    raise exception 'the sessions read policy does not hold back a ride before its reveal';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'list_sessions' and p.prosecdef
                    and p.proconfig @> array['search_path=public, extensions']) then
    raise exception 'list_sessions lost SECURITY DEFINER or its search_path';
  end if;
  if not has_function_privilege('anon', 'public.list_sessions(text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.list_sessions(text,text)', 'execute') then
    raise exception 'a client grant on list_sessions is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261006150000', 'spot_reveal')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
