-- ============================================================================
-- The collection-area TVs (2026-11-21; the user: "put tv screens in both bike collection areas, we have 2 bike
-- collection areas, hybrid/mountain bikes area and road bikes area, that in realtime shows checked in bookings, shows
-- their booking number height bike type and bike size").
--
--  1. queue_entries.collect_area ('road' | 'hm', null = by its bike type): the area a Kids or Any booking is sent to,
--     picked at check-in (or moved on Bookings > Collection). A Road, Road Carbon or Gravel booking goes to 'road', a
--     Hybrid or Mountain one to 'hm' when the column is empty; a Kids or Any one with no area shows on both TVs.
--     queue_entries.handed_at / handed_by: the collection staffer's Handed tap (the bike is in the rider's hands), which
--     takes the row off the TV. The Give bike step is off (GIVE_BIKE_STEP, the owner 2026-10-12) and the fleet list is
--     empty, so a bike being assigned is not what clears a row; a bike on the booking still clears it too.
--     staff_collect_set(id, area, handed, by): the one write for those three, Bookings editors only (_staff_mod('queue',
--     true)); whole rows reach the desks through staff_sync and the live channel as before.
--  2. collection_screens: one row per TV. A TV asks for a pairing code (screen_pair_start, anon: a 6-digit code and a
--     secret it keeps), a Bookings editor types the code on Bookings > Collection > TV screens and picks the area and
--     the session (staff_screen_pair), and from then on the TV reads screen_feed with its secret. Only the secret's
--     sha256 is kept. Nobody reads the table directly: staff list it through staff_screens, edit through
--     staff_screen_set, unpair through staff_screen_unpair (the row is deleted; the TV starts pairing again).
--  3. screen_feed(token, etag): what one TV shows, and nothing else: the booking number, the first name, the party's
--     "1 of 3", the height, the type, the stored size and the check-in time of each rider checked in on its session
--     (all of today's when none is picked), not handed over, with no bike on the booking, not their own bike or none,
--     in the last 30 minutes, in its area; the sessions' names; the fitting chart and the Kids limit from Settings
--     (staff_options 'biz') so the TV sizes riders as the desk does. A TV sends the etag of what it shows and gets
--     {state:'same'} back while nothing moved (a few bytes every few seconds, not the list).
--
-- Rollback:
--   drop function if exists public.screen_feed(text,text), public.screen_pair_start(), public.staff_screens(),
--     public.staff_screen_pair(text,text,text,text,text), public.staff_screen_set(uuid,text,text,text),
--     public.staff_screen_unpair(uuid), public.staff_collect_set(text,text,boolean,text), public._screen_area(text,text);
--   drop table if exists public.collection_screens;
--   alter table public.queue_entries drop column if exists collect_area, drop column if exists handed_at,
--     drop column if exists handed_by;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';


/* -- 1. the booking's area and the Handed tap ------------------------------------------------------- */
alter table public.queue_entries
  add column if not exists collect_area text,
  add column if not exists handed_at timestamptz,
  add column if not exists handed_by text;
do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'queue_entries_collect_area_check') then
    alter table public.queue_entries add constraint queue_entries_collect_area_check
      check (collect_area is null or collect_area in ('road', 'hm'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'queue_entries_handed_by_len') then
    alter table public.queue_entries add constraint queue_entries_handed_by_len
      check (handed_by is null or char_length(handed_by) <= 80);
  end if;
end $c$;
comment on column public.queue_entries.collect_area is
  'The bike collection area a booking is sent to (20261121120000): road | hm (Hybrid/Mountain); null = by its bike type (Kids and Any then show on both TVs).';
comment on column public.queue_entries.handed_at is
  'When collection staff tapped Handed (20261121120000): the bike is in the rider''s hands, the row leaves the TV.';

-- The area a booking shows in: its own, else its bike type's; null = both (Kids, Any, a type with no area).
create or replace function public._screen_area(p_area text, p_type text)
returns text
language sql immutable set search_path to 'public'
as $$
  select coalesce(p_area,
                  case when p_type in ('Road', 'Road Carbon', 'Gravel') then 'road'
                       when p_type in ('Hybrid', 'Mountain') then 'hm' end);
$$;
revoke all on function public._screen_area(text, text) from public, anon, authenticated;

-- p_area: 'road' | 'hm' sets it, '' clears it, null leaves it. p_handed: true stamps now, false clears, null leaves it.
create or replace function public.staff_collect_set(p_id text, p_area text default null, p_handed boolean default null,
                                                    p_by text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_row queue_entries;
begin
  if not _staff_mod('queue', true) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_area is not null and p_area not in ('', 'road', 'hm') then raise exception 'BAD_AREA' using errcode = '22023'; end if;
  update queue_entries q
     set collect_area = case when p_area is null then q.collect_area else nullif(p_area, '') end,
         handed_at = case when p_handed is null then q.handed_at when p_handed then coalesce(q.handed_at, now()) end,
         handed_by = case when p_handed is null then q.handed_by when p_handed then coalesce(q.handed_by, left(nullif(trim(p_by), ''), 80)) end
   where q.id = p_id
  returning * into v_row;
  if v_row.id is null then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  return jsonb_build_object('ok', true, 'collect_area', v_row.collect_area, 'handed_at', v_row.handed_at,
                            'handed_by', v_row.handed_by, 'updated_at', v_row.updated_at);
end;
$$;
revoke all on function public.staff_collect_set(text, text, boolean, text) from public, anon;
grant execute on function public.staff_collect_set(text, text, boolean, text) to authenticated;


/* -- 2. the TVs ------------------------------------------------------------------------------------- */
create table if not exists public.collection_screens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  pair_code text,
  area text check (area is null or area in ('road', 'hm')),
  session_id text,
  label text check (label is null or char_length(label) <= 60),
  paired_at timestamptz,
  paired_by text check (paired_by is null or char_length(paired_by) <= 80),
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists collection_screens_pair_code on public.collection_screens (pair_code) where paired_at is null;
alter table public.collection_screens enable row level security;
revoke all on table public.collection_screens from public, anon, authenticated; -- read and written only through the functions below
comment on table public.collection_screens is
  'The bike collection areas'' TVs (20261121120000): one row per TV, its area (road | hm) and session (null = all of today''s). token_hash = sha256 of the secret the TV keeps; pair_code = the code it shows until staff pair it. Only security definer functions touch it.';

-- A TV with no secret (or one staff unpaired) asks for a code. Codes not used within an hour go.
create or replace function public.screen_pair_start()
returns jsonb
language plpgsql volatile security definer set search_path to 'public', 'extensions'
as $$
declare v_token text; v_code text; v_try integer := 0;
begin
  delete from collection_screens where paired_at is null and created_at < now() - interval '1 hour';
  if (select count(*) from collection_screens where paired_at is null) >= 40 then
    return jsonb_build_object('ok', false, 'error', 'busy');
  end if;
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  loop
    v_code := lpad((floor(random() * 1000000))::integer::text, 6, '0');
    exit when not exists (select 1 from collection_screens where paired_at is null and pair_code = v_code);
    v_try := v_try + 1;
    if v_try > 20 then return jsonb_build_object('ok', false, 'error', 'busy'); end if;
  end loop;
  insert into collection_screens (token_hash, pair_code) values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_code);
  return jsonb_build_object('ok', true, 'token', v_token, 'code', v_code);
end;
$$;
revoke all on function public.screen_pair_start() from public;
grant execute on function public.screen_pair_start() to anon, authenticated;

create or replace function public.staff_screen_pair(p_code text, p_area text, p_session_id text default null,
                                                    p_label text default null, p_by text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_id uuid;
begin
  if not _staff_mod('queue', true) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_area not in ('road', 'hm') then raise exception 'BAD_AREA' using errcode = '22023'; end if;
  update collection_screens
     set paired_at = now(), pair_code = null, area = p_area, session_id = nullif(trim(coalesce(p_session_id, '')), ''),
         label = left(nullif(trim(coalesce(p_label, '')), ''), 60), paired_by = left(nullif(trim(coalesce(p_by, '')), ''), 80)
   where paired_at is null and pair_code = regexp_replace(coalesce(p_code, ''), '\D', '', 'g')
     and created_at > now() - interval '1 hour'
  returning id into v_id;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'no_code'); end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
revoke all on function public.staff_screen_pair(text, text, text, text, text) from public, anon;
grant execute on function public.staff_screen_pair(text, text, text, text, text) to authenticated;

-- p_session_id '' = all of today's sessions.
create or replace function public.staff_screen_set(p_id uuid, p_area text, p_session_id text default null, p_label text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_id uuid;
begin
  if not _staff_mod('queue', true) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if p_area not in ('road', 'hm') then raise exception 'BAD_AREA' using errcode = '22023'; end if;
  update collection_screens
     set area = p_area, session_id = nullif(trim(coalesce(p_session_id, '')), ''), label = left(nullif(trim(coalesce(p_label, '')), ''), 60)
   where id = p_id and paired_at is not null
  returning id into v_id;
  return jsonb_build_object('ok', v_id is not null);
end;
$$;
revoke all on function public.staff_screen_set(uuid, text, text, text) from public, anon;
grant execute on function public.staff_screen_set(uuid, text, text, text) to authenticated;

create or replace function public.staff_screen_unpair(p_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
begin
  if not _staff_mod('queue', true) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  delete from collection_screens where id = p_id;
  return jsonb_build_object('ok', found);
end;
$$;
revoke all on function public.staff_screen_unpair(uuid) from public, anon;
grant execute on function public.staff_screen_unpair(uuid) to authenticated;

create or replace function public.staff_screens()
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not _staff_mod('queue') then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'area', c.area, 'session_id', c.session_id, 'label', c.label,
                                                       'paired_at', c.paired_at, 'paired_by', c.paired_by, 'last_seen_at', c.last_seen_at)
                                    order by c.area, c.paired_at)
                     from collection_screens c where c.paired_at is not null), '[]'::jsonb);
end;
$$;
revoke all on function public.staff_screens() from public, anon;
grant execute on function public.staff_screens() to authenticated;


/* -- 3. what a TV shows ----------------------------------------------------------------------------- */
create or replace function public.screen_feed(p_token text, p_etag text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public', 'extensions'
as $$
declare v_s collection_screens; v_today text; v_sids text[]; v_body jsonb; v_etag text; v_biz jsonb;
begin
  if p_token is null or length(p_token) < 20 then return jsonb_build_object('state', 'unknown'); end if;
  select * into v_s from collection_screens where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if v_s.id is null then return jsonb_build_object('state', 'unknown'); end if;
  if v_s.paired_at is null then
    if v_s.created_at < now() - interval '1 hour' then
      delete from collection_screens where id = v_s.id;
      return jsonb_build_object('state', 'unknown');
    end if;
    return jsonb_build_object('state', 'pairing', 'code', v_s.pair_code);
  end if;
  if v_s.last_seen_at is null or v_s.last_seen_at < now() - interval '1 minute' then
    update collection_screens set last_seen_at = now() where id = v_s.id;
  end if;

  v_today := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  if v_s.session_id is not null then
    v_sids := array[v_s.session_id];
  else
    select coalesce(array_agg(s.id), '{}') into v_sids from sessions s
     where s.session_date = v_today and s.cancelled_at is null and s.draft is not true;
  end if;
  select items into v_biz from staff_options where key = 'biz';

  v_body := jsonb_build_object(
    'area', v_s.area,
    'label', v_s.label,
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', coalesce(nullif(s.title, ''), s.day),
                                                              'title_ar', s.title_ar, 'date', s.session_date, 'day', s.day)
                                           order by s.session_date, s.id)
                            from sessions s where s.id = any(v_sids)), '[]'::jsonb),
    'chart', case when jsonb_typeof(v_biz -> 'size_chart') = 'object' then v_biz -> 'size_chart' end,
    'kids_max', case when jsonb_typeof(v_biz -> 'kids_max_cm') = 'number' then v_biz -> 'kids_max_cm' end,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('id', left(x.id, 12), 'n', x.queue_num, 'name', x.first_name, 'h', x.height,
                                          'type', x.type_preference, 'size', x.size, 'at', x.checked_in_at,
                                          'pos', x.pos, 'of', x.party_n, 'area', x.eff_area, 'sid', x.session_id)
                       order by x.checked_in_at, x.queue_num)
        from (
          select q.*, split_part(trim(coalesce(q.name, '')), ' ', 1) as first_name,
                 _screen_area(q.collect_area, q.type_preference) as eff_area,
                 p.pos, p.party_n
            from queue_entries q
            left join lateral (
              select count(*) filter (where o.queue_num < q.queue_num or (o.queue_num = q.queue_num and o.id <= q.id)) as pos,
                     count(*) as party_n
                from queue_entries o
               where o.session_id = q.session_id
                 and o.status in ('waiting', 'waitlist', 'active', 'done')
                 and ((q.group_id is not null and o.group_id = q.group_id)
                      or (q.group_id is null and q.customer_id is not null and o.group_id is null and o.customer_id = q.customer_id))
            ) p on true
           where q.session_id = any(v_sids)
             and q.status = 'active'
             and q.checked_in_at is not null and q.checked_in_at <> ''
             and q.checked_in_at::timestamptz > now() - interval '30 minutes'
             and q.handed_at is null
             and coalesce(q.assigned_bike_id, '') = ''
             and coalesce(q.type_preference, 'Any') not in ('Own', 'None')
        ) x
       where x.eff_area is null or x.eff_area = v_s.area), '[]'::jsonb));
  v_etag := md5(v_body::text);
  if p_etag is not null and p_etag = v_etag then
    return jsonb_build_object('state', 'same', 'etag', v_etag, 'now', now());
  end if;
  return v_body || jsonb_build_object('state', 'paired', 'etag', v_etag, 'now', now());
end;
$$;
revoke all on function public.screen_feed(text, text) from public;
grant execute on function public.screen_feed(text, text) to anon, authenticated;


/* -- checks ----------------------------------------------------------------------------------------- */
do $chk$
declare f text;
begin
  foreach f in array array['public.screen_feed(text,text)', 'public.screen_pair_start()', 'public.staff_screens()',
                           'public.staff_screen_pair(text,text,text,text,text)', 'public.staff_screen_set(uuid,text,text,text)',
                           'public.staff_screen_unpair(uuid)', 'public.staff_collect_set(text,text,boolean,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public.screen_feed(text,text)', 'public.screen_pair_start()'] loop
    if not has_function_privilege('anon', f, 'execute') then raise exception '% is not executable by anon', f; end if;
  end loop;
  foreach f in array array['public.staff_screens()', 'public.staff_screen_pair(text,text,text,text,text)',
                           'public.staff_screen_set(uuid,text,text,text)', 'public.staff_screen_unpair(uuid)',
                           'public.staff_collect_set(text,text,boolean,text)', 'public._screen_area(text,text)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
  end loop;
  if has_table_privilege('anon', 'public.collection_screens', 'select') or has_table_privilege('authenticated', 'public.collection_screens', 'select') then
    raise exception 'collection_screens is readable by a client';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261121120000', 'collection_screens')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only): the columns, the table closed, the functions, the ledger.
-- select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'queue_entries'
--           and column_name in ('collect_area', 'handed_at', 'handed_by')) as cols_3,
--        has_table_privilege('anon', 'public.collection_screens', 'select') as anon_table_false,
--        has_function_privilege('anon', 'public.screen_feed(text,text)', 'execute') as anon_feed_true,
--        has_function_privilege('anon', 'public.staff_collect_set(text,text,boolean,text)', 'execute') as anon_set_false,
--        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
--          and proname in ('screen_feed', 'screen_pair_start', 'staff_screens', 'staff_screen_pair', 'staff_screen_set',
--                          'staff_screen_unpair', 'staff_collect_set')) as definer_7,
--        (select public.screen_feed('x'))::text as feed_unknown,
--        (select name from supabase_migrations.schema_migrations where version = '20261121120000') as ledger;
