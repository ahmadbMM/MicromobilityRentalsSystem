-- ============================================================================
-- Safety feedback (the user, 2026-11-21: "i dont want it to be an incident report but more of a way we can gather info
-- and feedback on how we can make our services better and safer and more responsive").
--
-- The user's picks the same day:
--   * riders only, from their own booking in the booking app (My bookings > Safety feedback, /account/safety?b=<entry>),
--     on every past ride or session, from the moment it ends until 7 days after;
--   * the account holder picks which rider on that booking it is about (the account's own entries on that session:
--     themselves and anyone they booked for), and answers for a child as their parent or guardian;
--   * what happened (nothing, a near miss, felt unsafe, a fall, a crash, an injury; with an injury where on the body and
--     how serious), before the ride (the briefing, the helmet, the bike's fit, feeling ready), the cause and what would
--     have prevented it, our response (how fast, how well we cared, first aid: stars 1-5, and a comment) and ideas;
--   * always named, with a required consent tick; one per booking entry;
--   * staff (the Bookings right, _staff_mod('queue')) mark it followed up or closed, keep a note and may reply; the rider
--     sees the status (Received / Followed up / Closed) and the reply on their booking.
--
--  1. safety_feedback   one row per booking entry; staff-only, read and written through the functions below.
--  2. For riders (anon key + the account's id and session token, _cust_token_ok): safety_mine, safety_send.
--  3. For staff (Bookings, _staff_mod('queue')): staff_safety_list, staff_safety_set.
--  4. Kept 3 years from when it was sent (pg_cron 'mm-safety-feedback-purge'), as the Privacy Notice says.
--
-- Rollback:
--   drop function if exists public.staff_safety_set(bigint, text, text, text), public.staff_safety_list(text),
--     public.safety_send(text, text, text, jsonb), public.safety_mine(text, text), public._sfy_end(text),
--     public._sfy_pick(jsonb, text, text[]), public._sfy_stamp();
--   select cron.unschedule(jobid) from cron.job where jobname = 'mm-safety-feedback-purge';
--   drop table if exists public.safety_feedback cascade;
--   delete from supabase_migrations.schema_migrations where version = '20261121400000';
-- Numbered 20261121120000 when written; that number was already collection_screens on both ledgers when this was
-- run by hand on 2026-11-21, so its ledger row was skipped and 20261121400000 was written on both instead.
-- Idempotent. Needs _cust_token_ok, _staff_mod, _session_window (20260916160000), _ask_text and _ask_who
-- (20261113010000_ask).
-- ============================================================================

begin;

-- 1. the table ---------------------------------------------------------------------------------------------------

create table if not exists public.safety_feedback (
  id              bigint generated always as identity primary key,
  customer_id     text not null references public.customers(id) on delete cascade,
  entry_id        text not null,
  session_id      text,
  rider_name      text check (rider_name is null or char_length(rider_name) <= 120),
  kind            text not null check (kind in ('none', 'near_miss', 'unsafe', 'fall', 'crash', 'injury')),
  injury_parts    text[] not null default '{}'
                  check (injury_parts <@ array['head', 'face', 'neck', 'shoulder', 'arm', 'hand', 'chest', 'back', 'hip', 'leg', 'knee', 'foot', 'other']::text[]),
  injury_severity text check (injury_severity is null or injury_severity in ('minor', 'first_aid', 'clinic', 'hospital')),
  briefing        text check (briefing is null or briefing in ('yes', 'partly', 'no', 'none')),
  helmet_ok       text check (helmet_ok is null or helmet_ok in ('yes', 'no', 'none')),
  bike_ok         text check (bike_ok is null or bike_ok in ('yes', 'no')),
  ready           text check (ready is null or ready in ('yes', 'partly', 'no')),
  causes          text[] not null default '{}'
                  check (causes <@ array['bike_condition', 'bike_size', 'route', 'other_people', 'speed', 'weather', 'other']::text[]),
  prevent         text check (prevent is null or char_length(prevent) <= 1000),
  rate_speed      smallint check (rate_speed is null or rate_speed between 1 and 5),
  rate_care       smallint check (rate_care is null or rate_care between 1 and 5),
  rate_first_aid  smallint check (rate_first_aid is null or rate_first_aid between 1 and 5), -- null: not needed or not answered
  resp_comment    text check (resp_comment is null or char_length(resp_comment) <= 1000),
  ideas           text check (ideas is null or char_length(ideas) <= 1000),
  lang            text not null default 'en' check (lang ~ '^[a-z]{2}$'),
  consent_at      timestamptz not null default now(),
  status          text not null default 'new' check (status in ('new', 'followed', 'closed')),
  staff_note      text check (staff_note is null or char_length(staff_note) <= 1000),
  staff_reply     text check (staff_reply is null or char_length(staff_reply) <= 1000),
  replied_at      timestamptz,
  handled_by      text,
  handled_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint safety_feedback_entry unique (entry_id),
  -- what only something that happened carries
  constraint safety_feedback_injury check (kind in ('fall', 'crash', 'injury') or (injury_parts = '{}' and injury_severity is null)),
  constraint safety_feedback_severity check (kind <> 'injury' or injury_severity is not null),
  constraint safety_feedback_causes check (kind <> 'none' or causes = '{}')
);
create index if not exists safety_feedback_list on public.safety_feedback (status, created_at desc);
create index if not exists safety_feedback_customer on public.safety_feedback (customer_id, created_at desc);
alter table public.safety_feedback enable row level security;
revoke all on public.safety_feedback from public, anon, authenticated;

-- updated_at on every write
create or replace function public._sfy_stamp()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  new.updated_at := now();
  return new;
end $function$;
drop trigger if exists safety_feedback_stamp on public.safety_feedback;
create trigger safety_feedback_stamp before insert or update on public.safety_feedback
  for each row execute function public._sfy_stamp();

-- 2. helpers -----------------------------------------------------------------------------------------------------

-- When a booking's session ended, on the server's clock: its window's end (Riyadh), and an end written before its start
-- (21:00 - 00:00) on the next day, as the apps read it. Null when the entry or its session is not there.
create or replace function public._sfy_end(p_entry text)
 returns timestamptz
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when w.ends_at < w.starts_at then w.ends_at + interval '1 day' else w.ends_at end
    from queue_entries e join sessions s on s.id = e.session_id cross join lateral _session_window(s) w
   where e.id = p_entry
$function$;

-- A list answer as kept: only the allowed words, each once, in the order given; null when the answer is not a list of
-- words or names one that is not allowed (the caller says invalid).
create or replace function public._sfy_pick(p jsonb, p_key text, p_allowed text[])
 returns text[]
 language plpgsql
 immutable
 set search_path to 'public'
as $function$
declare v jsonb := p -> p_key; out text[] := '{}'; x text;
begin
  if v is null or v = 'null'::jsonb then return out; end if;
  if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 20 then return null; end if;
  for x in select jsonb_array_elements_text(v) loop
    if not (x = any(p_allowed)) then return null; end if;
    if not (x = any(out)) then out := out || x; end if;
  end loop;
  return out;
end $function$;

-- 3. riders ------------------------------------------------------------------------------------------------------

-- The account's own feedback (what the rider may see of it: what it was about, the status and the team's reply) and the
-- booking entries it can still be sent about now (ended, within 7 days, not cancelled or a no-show, none sent yet).
create or replace function public.safety_mine(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  return jsonb_build_object('ok', true, 'now', now(),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'entry_id', f.entry_id, 'session_id', f.session_id, 'rider_name', f.rider_name,
               'kind', f.kind, 'status', f.status, 'staff_reply', f.staff_reply, 'replied_at', f.replied_at,
               'created_at', f.created_at, 'date', s.session_date, 'title', s.title, 'title_ar', s.title_ar)
               order by f.created_at desc, f.id desc)
        from safety_feedback f left join sessions s on s.id = f.session_id
       where f.customer_id = p_id), '[]'::jsonb),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object('entry_id', x.id, 'session_id', x.session_id, 'name', x.name, 'date', x.session_date,
               'title', x.title, 'title_ar', x.title_ar, 'ended_at', x.ended, 'until', x.ended + interval '7 days')
               order by x.ended desc, x.id)
        from (select e.id, e.session_id, e.name, s.session_date, s.title, s.title_ar,
                     case when w.ends_at < w.starts_at then w.ends_at + interval '1 day' else w.ends_at end as ended
                from queue_entries e join sessions s on s.id = e.session_id cross join lateral _session_window(s) w
               where e.customer_id = p_id and e.status in ('waiting', 'active', 'done')
                 and s.session_date >= to_char((now() at time zone 'Asia/Riyadh') - interval '9 days', 'YYYY-MM-DD')
                 and not exists (select 1 from safety_feedback f where f.entry_id = e.id)) x
       where x.ended <= now() and x.ended > now() - interval '7 days'), '[]'::jsonb));
end $function$;

-- A rider's safety feedback about one booking entry of theirs. p_data carries the answers:
--   kind (required), injury_parts [], injury_severity, briefing, helmet_ok, bike_ok, ready, causes [], prevent,
--   rate_speed, rate_care, rate_first_aid (1-5 or null), resp_comment, ideas, consent (must be true), lang.
-- Errors: signin, consent, invalid (an answer outside its list or too long), kind, severity (an injury without how
-- serious), entry (not their booking, or cancelled / waitlisted / a no-show), early (the session has not ended), late
-- (more than 7 days after it ended), dup (that entry has feedback already).
create or replace function public.safety_send(p_id text, p_token text, p_entry text, p_data jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  d jsonb := coalesce(p_data, '{}'::jsonb);
  v_kind text := d ->> 'kind';
  v_parts text[]; v_causes text[];
  v_sev text := nullif(d ->> 'injury_severity', '');
  v_brief text := nullif(d ->> 'briefing', ''); v_helm text := nullif(d ->> 'helmet_ok', '');
  v_bike text := nullif(d ->> 'bike_ok', ''); v_ready text := nullif(d ->> 'ready', '');
  v_prev text := nullif(_ask_text(d ->> 'prevent'), ''); v_com text := nullif(_ask_text(d ->> 'resp_comment'), '');
  v_ideas text := nullif(_ask_text(d ->> 'ideas'), '');
  v_lang text := case when coalesce(d ->> 'lang', '') ~ '^[a-z]{2}$' then d ->> 'lang' else 'en' end;
  v_rs smallint; v_rc smallint; v_rf smallint;
  e queue_entries%rowtype; v_end timestamptz; v_id bigint;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  if jsonb_typeof(d) <> 'object' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if (d -> 'consent') is distinct from 'true'::jsonb then return jsonb_build_object('ok', false, 'error', 'consent'); end if;
  if coalesce(v_kind, '') not in ('none', 'near_miss', 'unsafe', 'fall', 'crash', 'injury') then return jsonb_build_object('ok', false, 'error', 'kind'); end if;
  v_parts := _sfy_pick(d, 'injury_parts', array['head', 'face', 'neck', 'shoulder', 'arm', 'hand', 'chest', 'back', 'hip', 'leg', 'knee', 'foot', 'other']);
  v_causes := _sfy_pick(d, 'causes', array['bike_condition', 'bike_size', 'route', 'other_people', 'speed', 'weather', 'other']);
  if v_parts is null or v_causes is null then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  -- what does not belong with the answer to "what happened" is dropped, not refused
  if v_kind not in ('fall', 'crash', 'injury') then v_parts := '{}'; v_sev := null; end if;
  if v_kind = 'none' then v_causes := '{}'; v_prev := null; end if;
  if v_sev is not null and v_sev not in ('minor', 'first_aid', 'clinic', 'hospital') then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if v_kind = 'injury' and v_sev is null then return jsonb_build_object('ok', false, 'error', 'severity'); end if;
  if (v_brief is not null and v_brief not in ('yes', 'partly', 'no', 'none')) or (v_helm is not null and v_helm not in ('yes', 'no', 'none'))
     or (v_bike is not null and v_bike not in ('yes', 'no')) or (v_ready is not null and v_ready not in ('yes', 'partly', 'no')) then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  begin
    v_rs := nullif(d ->> 'rate_speed', '')::smallint; v_rc := nullif(d ->> 'rate_care', '')::smallint; v_rf := nullif(d ->> 'rate_first_aid', '')::smallint;
  exception when others then return jsonb_build_object('ok', false, 'error', 'invalid');
  end;
  if (v_rs is not null and v_rs not between 1 and 5) or (v_rc is not null and v_rc not between 1 and 5) or (v_rf is not null and v_rf not between 1 and 5) then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if char_length(coalesce(v_prev, '')) > 1000 or char_length(coalesce(v_com, '')) > 1000 or char_length(coalesce(v_ideas, '')) > 1000 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  -- one account's sends go in one at a time, so two taps cannot both pass the checks
  perform pg_advisory_xact_lock(hashtextextended('sfy:' || p_id, 0));
  select * into e from queue_entries q where q.id = p_entry and q.customer_id = p_id;
  if not found or e.status not in ('waiting', 'active', 'done') then return jsonb_build_object('ok', false, 'error', 'entry'); end if;
  v_end := _sfy_end(e.id);
  if v_end is null then return jsonb_build_object('ok', false, 'error', 'entry'); end if;
  if v_end > now() then return jsonb_build_object('ok', false, 'error', 'early'); end if;
  if v_end <= now() - interval '7 days' then return jsonb_build_object('ok', false, 'error', 'late'); end if;
  if exists (select 1 from safety_feedback f where f.entry_id = e.id) then return jsonb_build_object('ok', false, 'error', 'dup'); end if;
  insert into safety_feedback (customer_id, entry_id, session_id, rider_name, kind, injury_parts, injury_severity, briefing, helmet_ok,
                               bike_ok, ready, causes, prevent, rate_speed, rate_care, rate_first_aid, resp_comment, ideas, lang, consent_at)
  values (p_id, e.id, e.session_id, nullif(left(btrim(coalesce(e.name, '')), 120), ''), v_kind, v_parts, v_sev, v_brief, v_helm,
          v_bike, v_ready, v_causes, v_prev, v_rs, v_rc, v_rf, v_com, v_ideas, v_lang, now())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'new');
end $function$;

-- 4. staff -------------------------------------------------------------------------------------------------------

-- Every safety feedback (the newest 1,000), with the account, the session and the counts per status.
create or replace function public.staff_safety_list(p_status text default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not _staff_mod('queue', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return jsonb_build_object(
    'counts', (select jsonb_build_object('new', count(*) filter (where f.status = 'new'), 'followed', count(*) filter (where f.status = 'followed'),
                 'closed', count(*) filter (where f.status = 'closed'),
                 'urgent', count(*) filter (where f.status = 'new' and f.kind in ('crash', 'injury'))) from safety_feedback f),
    'items', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc, x.id desc)
        from (select f.id, f.customer_id, f.entry_id, f.session_id, f.rider_name, f.kind, f.injury_parts, f.injury_severity, f.briefing,
                     f.helmet_ok, f.bike_ok, f.ready, f.causes, f.prevent, f.rate_speed, f.rate_care, f.rate_first_aid, f.resp_comment,
                     f.ideas, f.lang, f.consent_at, f.status, f.staff_note, f.staff_reply, f.replied_at, f.handled_by, f.handled_at,
                     f.created_at, c.name as customer_name, c.phone as customer_phone,
                     s.title as session_title, s.session_date, s.location as session_location, s.ride_kind, s.event_kind
                from safety_feedback f left join customers c on c.id = f.customer_id left join sessions s on s.id = f.session_id
               where p_status is null or f.status = p_status
               order by f.created_at desc, f.id desc
               limit 1000) x), '[]'::jsonb));
end $function$;

-- Status ('new', 'followed', 'closed'), the team's note and the reply to the rider, each kept when null and cleared when
-- ''. A new reply stamps replied_at. Returns the rows changed (0: nothing was different, or the row is gone).
create or replace function public.staff_safety_set(p_id bigint, p_status text default null, p_note text default null, p_reply text default null)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n integer; v_note text := case when p_note is null then null else left(_ask_text(p_note), 1000) end;
        v_reply text := case when p_reply is null then null else left(_ask_text(p_reply), 1000) end;
begin
  if not _staff_mod('queue', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_status is not null and p_status not in ('new', 'followed', 'closed') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  update safety_feedback f
     set status = coalesce(p_status, f.status),
         staff_note = case when v_note is null then f.staff_note else nullif(v_note, '') end,
         staff_reply = case when v_reply is null then f.staff_reply else nullif(v_reply, '') end,
         replied_at = case when v_reply is null or nullif(v_reply, '') is not distinct from f.staff_reply then f.replied_at
                           when v_reply = '' then null else now() end,
         handled_by = _ask_who(), handled_at = now()
   where f.id = p_id
     and (f.status is distinct from coalesce(p_status, f.status)
          or (v_note is not null and f.staff_note is distinct from nullif(v_note, ''))
          or (v_reply is not null and f.staff_reply is distinct from nullif(v_reply, '')));
  get diagnostics n = row_count;
  return n;
end $function$;

-- 5. who may call what -----------------------------------------------------------------------------------------------
do $acl$
declare f text;
begin
  -- inside the database only
  foreach f in array array['_sfy_stamp()', '_sfy_end(text)', '_sfy_pick(jsonb, text, text[])'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- riders (the functions check the session themselves)
  foreach f in array array['safety_mine(text, text)', 'safety_send(text, text, text, jsonb)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  -- the staff app (each checks the Bookings right)
  foreach f in array array['staff_safety_list(text)', 'staff_safety_set(bigint, text, text, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $acl$;

-- 6. kept 3 years (the Privacy Notice says so): a daily timer, named, so running this file again replaces it -----------
do $cron$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'mm-safety-feedback-purge';
  perform cron.schedule('mm-safety-feedback-purge', '40 0 * * *', $j$delete from public.safety_feedback where created_at < now() - interval '3 years'$j$);
end $cron$;

-- 7. checks --------------------------------------------------------------------------------------------------------
do $chk$
declare f record;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.safety_feedback'::regclass) then
    raise exception 'safety_feedback has no row level security';
  end if;
  if has_table_privilege('anon', 'public.safety_feedback', 'select') or has_table_privilege('authenticated', 'public.safety_feedback', 'select')
     or has_table_privilege('authenticated', 'public.safety_feedback', 'insert') then
    raise exception 'safety_feedback is open past its functions';
  end if;
  for f in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'safety\_%' or p.proname like 'staff\_safety\_%' or p.proname like '\_sfy\_%') loop
    if not exists (select 1 from unnest(coalesce(f.proconfig, '{}')) c where c like 'search_path=%') then
      raise exception '% has no search_path', f.proname;
    end if;
    if (f.proname like 'safety\_%' or f.proname like 'staff\_safety\_%') and not f.prosecdef then
      raise exception '% is not SECURITY DEFINER', f.proname;
    end if;
    if f.proname like '\_sfy\_%' and (has_function_privilege('anon', f.oid, 'execute') or has_function_privilege('authenticated', f.oid, 'execute')) then
      raise exception '% is callable from outside', f.proname;
    end if;
    if f.proname like 'staff\_safety\_%' and has_function_privilege('anon', f.oid, 'execute') then
      raise exception '% is open to anon', f.proname;
    end if;
    if f.proname like 'safety\_%' and not has_function_privilege('anon', f.oid, 'execute') then
      raise exception 'the booking app cannot reach %', f.proname;
    end if;
  end loop;
end $chk$;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261121400000', 'safety_feedback')
on conflict (version) do nothing;

commit;

-- Read-only check after applying (expect: 1 table with RLS, 7 functions, the purge timer, ledger row):
-- select (select count(*) from pg_class where relname = 'safety_feedback' and relrowsecurity) as table_rls,
--        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
--          and (proname like 'safety\_%' or proname like 'staff\_safety\_%' or proname like '\_sfy\_%')) as functions,
--        (select count(*) from cron.job where jobname = 'mm-safety-feedback-purge') as purge_timer,
--        (select name from supabase_migrations.schema_migrations where version = '20261121400000') as ledger;
