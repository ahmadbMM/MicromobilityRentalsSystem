-- ============================================================================
-- Run for Her (the owner, 2026-10-05): a running event for community members only, free, 18 and
-- over, 80 places, first come first served, one place per account, a 3 km or a 5 km run picked per
-- booking, an emergency contact on every runner's account, and a badge for finishing it.
--
--  1. queue_entries.run_km: the distance a runner picked, 3 or 5 (null on every other booking).
--     customer_create_booking copies it from the entry (patched in place: two anchors in its insert,
--     neither touched by the 2026-10-05 audit patch, so the two run in either order).
--  2. customers.emergency_name / emergency_phone / emergency_relation: who to call if a runner needs
--     help. A rider reads and saves them through customer_emergency / customer_set_emergency
--     (token-checked, definer); staff read and edit them under the table's RLS (column grants to
--     authenticated only: anon never needed customers' columns and gets none of these).
--     Relationship is a code: spouse, parent, sibling, child, relative, friend, colleague, other.
--  3. _run_entry_guard (BEFORE INSERT OR UPDATE OF status, session_id, run_km on queue_entries): on
--     a Run for Her session (ride_kind 'runher', event_kind 'community') a customer's live row needs
--     a distance (RUN_KM), an account aged 18 or over on the session's date (RUN_AGE), a full name of
--     two words or more, an email and the emergency contact on the account (RUN_DETAILS), and no
--     other live row of the same account on that session (ONE_PER_SESSION, the code the app already
--     reads). Staff are exempt, as with every ride rule. Its own trigger rather than branches in
--     _group_ride_cap / customer_booking_update, which the 2026-10-05 audit rewrites whole.
--     The members gate needs nothing: the run is event_kind 'community' with open_to_all false.
--  4. The finisher's badge, run_for_her: a pink ribbon, earned by a finished (done) row on a
--     Run for Her session and shown only to those who earned it (computed by the app and the website,
--     like National Day 96). The table holds 'red'; the app draws it pink.
--
-- The session itself (17 October, meet 06:00, start 06:30, 80 places, the Jeddah Yacht Club) is a
-- separate insert, run once the app that knows the kind is live: an older page reads an unknown
-- community kind as the Saturday ride.
--
-- Rollback: drop trigger if exists queue_entries_run_guard on public.queue_entries;
--   drop function if exists public._run_entry_guard(), public.customer_emergency(text, text),
--     public.customer_set_emergency(text, text, text, text, text);
--   re-run the customer_create_booking patch backwards (drop ", run_km" and its value);
--   alter table public.queue_entries drop column if exists run_km;
--   alter table public.customers drop column if exists emergency_name, drop column if exists emergency_phone,
--     drop column if exists emergency_relation;
--   delete from public.customer_badges where badge_id = 'bd_run_for_her'; delete from public.badges where id = 'bd_run_for_her';
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


-- ── 1. the distance a runner picked ──────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists run_km smallint;
alter table public.queue_entries drop constraint if exists queue_entries_run_km_chk;
alter table public.queue_entries add constraint queue_entries_run_km_chk
  check (run_km is null or run_km in (3, 5));
comment on column public.queue_entries.run_km is
  'Run for Her: the distance the runner picked, 3 or 5 km; null on every other booking (20261005230000).';


-- ── 2. the emergency contact on the account ──────────────────────────────────────────────────
alter table public.customers add column if not exists emergency_name text;
alter table public.customers add column if not exists emergency_phone text;
alter table public.customers add column if not exists emergency_relation text;
alter table public.customers drop constraint if exists customers_emergency_name_len;
alter table public.customers add constraint customers_emergency_name_len
  check (emergency_name is null or char_length(emergency_name) between 2 and 80);
alter table public.customers drop constraint if exists customers_emergency_phone_shape;
alter table public.customers add constraint customers_emergency_phone_shape
  check (emergency_phone is null or emergency_phone ~ '^\+?[0-9]{8,15}$');
alter table public.customers drop constraint if exists customers_emergency_relation_code;
alter table public.customers add constraint customers_emergency_relation_code
  check (emergency_relation is null
         or emergency_relation in ('spouse', 'parent', 'sibling', 'child', 'relative', 'friend', 'colleague', 'other'));
comment on column public.customers.emergency_name is 'Who to call if the rider needs help at an event (20261005230000).';
comment on column public.customers.emergency_phone is 'The emergency contact''s mobile number, digits with an optional + (20261005230000).';
comment on column public.customers.emergency_relation is
  'The emergency contact to the rider: spouse, parent, sibling, child, relative, friend, colleague or other (20261005230000).';

-- Staff read them on the roster and in the account editor, and correct them there.
grant select (emergency_name, emergency_phone, emergency_relation) on public.customers to authenticated;
grant update (emergency_name, emergency_phone, emergency_relation) on public.customers to authenticated;

-- The rider reads them...
create or replace function public.customer_emergency(p_id text, p_token text)
 returns table(emergency_name text, emergency_phone text, emergency_relation text)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not _cust_token_ok(p_id, p_token) then return; end if;
  return query select c.emergency_name, c.emergency_phone, c.emergency_relation from customers c where c.id = p_id;
end $function$;
revoke execute on function public.customer_emergency(text, text) from public;
grant  execute on function public.customer_emergency(text, text) to anon, authenticated;

-- ...and saves them: all three, or none (all blank clears the contact).
create or replace function public.customer_set_emergency(p_id text, p_token text, p_name text, p_phone text, p_relation text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_name text := nullif(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'), '');
  v_ph   text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
  v_rel  text := nullif(lower(btrim(coalesce(p_relation, ''))), '');
  v_own  text;
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if v_name is null and v_ph is null and v_rel is null then
    update customers set emergency_name = null, emergency_phone = null, emergency_relation = null where id = p_id;
    return found;
  end if;
  if v_name is null or char_length(v_name) < 2 or char_length(v_name) > 80
     or not _name_chars_ok(v_name) or not _name_parts_ok(v_name) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_name';
  end if;
  if v_ph is null or v_ph !~ '^\+?[0-9]{8,15}$' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_phone';
  end if;
  if v_rel is null or v_rel not in ('spouse', 'parent', 'sibling', 'child', 'relative', 'friend', 'colleague', 'other') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_relation';
  end if;
  -- someone else's number: the rider's own phone cannot be who we call when the rider needs help
  select regexp_replace(coalesce(c.phone, ''), '\D', '', 'g') into v_own from customers c where c.id = p_id;
  if v_own <> '' and right(regexp_replace(v_ph, '\D', '', 'g'), 9) = right(v_own, 9) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'em_self';
  end if;
  update customers set emergency_name = v_name, emergency_phone = v_ph, emergency_relation = v_rel where id = p_id;
  return found;
end $function$;
revoke execute on function public.customer_set_emergency(text, text, text, text, text) from public;
grant  execute on function public.customer_set_emergency(text, text, text, text, text) to anon, authenticated;


-- ── 1 (cont.). customer_create_booking copies run_km (patched from its live definition) ──────
do $ccb$
declare d text;
begin
  d := pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure);
  if position('(20261005230000)' in d) > 0 then
    raise notice 'customer_create_booking already copies run_km; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$      waiver_at, waiver_version, ride_group
    ) values ($a$,
$b$      waiver_at, waiver_version, ride_group, run_km   -- Run for Her's distance (20261005230000)
    ) values ($b$);
  d := pg_temp._once(d,
$a$case when it->>'ride_group' in ('beg','int') then it->>'ride_group' end
    )
    returning$a$,
$b$case when it->>'ride_group' in ('beg','int') then it->>'ride_group' end,
      case when it->>'run_km' in ('3','5') then (it->>'run_km')::smallint end
    )
    returning$b$);
  execute d;
end $ccb$;


-- ── 3. a runner's row on a Run for Her session ───────────────────────────────────────────────
create or replace function public._run_entry_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  s record;
  c record;
  _day date;
  _live int;
begin
  if new.customer_id is null or (select is_staff()) then return new; end if;
  select x.ride_kind, x.event_kind, x.session_date into s from sessions x where x.id = new.session_id;
  if not found or coalesce(s.ride_kind, '') <> 'runher' or coalesce(s.event_kind, '') <> 'community' then
    return new;
  end if;
  -- leaving the run, finishing it or being marked a no-show is never refused
  if coalesce(new.status, '') in ('cancelled', 'removed', 'noshow', 'done') then return new; end if;
  -- a live row that stays where it is, at the distance it had, is not judged again
  if tg_op = 'UPDATE' and old.session_id is not distinct from new.session_id
     and coalesce(old.status, '') not in ('cancelled', 'removed', 'noshow')
     and old.run_km is not distinct from new.run_km then
    return new;
  end if;

  if new.run_km is null or new.run_km not in (3, 5) then
    raise exception 'Pick 3 km or 5 km.' using errcode = 'P0001', detail = 'RUN_KM';
  end if;

  select x.name, x.email, x.birth_date, x.emergency_name, x.emergency_phone, x.emergency_relation
    into c from customers x where x.id = new.customer_id;
  if not found then
    raise exception 'Runner details are missing.' using errcode = 'P0001', detail = 'RUN_DETAILS';
  end if;
  begin _day := nullif(s.session_date, '')::date; exception when others then _day := null; end;
  if c.birth_date is null or not _ymd_ok(c.birth_date)
     or (c.birth_date::date + interval '18 years')::date > coalesce(_day, (now() at time zone 'Asia/Riyadh')::date) then
    raise exception 'Runners must be 18 or over.' using errcode = 'P0001', detail = 'RUN_AGE';
  end if;
  if coalesce(array_length(array_remove(regexp_split_to_array(btrim(coalesce(c.name, '')), '\s+'), ''), 1), 0) < 2
     or nullif(btrim(coalesce(c.email, '')), '') is null
     or nullif(btrim(coalesce(c.emergency_name, '')), '') is null
     or nullif(btrim(coalesce(c.emergency_phone, '')), '') is null
     or nullif(btrim(coalesce(c.emergency_relation, '')), '') is null then
    raise exception 'Runner details are missing.' using errcode = 'P0001', detail = 'RUN_DETAILS';
  end if;

  -- one place per account: the same lock _solo_ride_cap takes, so two bookings sent at once take turns
  perform pg_advisory_xact_lock(hashtext('ridecap:' || coalesce(new.session_id, '') || ':' || new.customer_id));
  select count(*) into _live
    from queue_entries q
   where q.session_id = new.session_id
     and q.customer_id = new.customer_id
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
     and q.id <> new.id;
  if _live >= 1 then
    raise exception 'One place per person on this session.' using detail = 'ONE_PER_SESSION';
  end if;
  return new;
end $function$;
revoke execute on function public._run_entry_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_run_guard on public.queue_entries;
create trigger queue_entries_run_guard
  before insert or update of status, session_id, run_km on public.queue_entries
  for each row execute function public._run_entry_guard();


-- ── 4. the finisher's badge ──────────────────────────────────────────────────────────────────
insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort)
values ('bd_run_for_her', 'run_for_her', 'ribbon', 'red', 'Run for Her', 'نركض لأجلها',
        'Finish the Run for Her', 'أكمل سباق نركض لأجلها', true, true, 92)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true, retired = false,
  sort = excluded.sort;


-- ── checks ────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['customer_create_booking','customer_emergency','customer_set_emergency','_run_entry_guard'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if position('(20261005230000)' in pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'the customer_create_booking patch did not take';
  end if;
  if not has_function_privilege('anon', 'public.customer_create_booking(text,text,jsonb)', 'execute')
     or not has_function_privilege('anon', 'public.customer_emergency(text,text)', 'execute')
     or not has_function_privilege('anon', 'public.customer_set_emergency(text,text,text,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.customer_set_emergency(text,text,text,text,text)', 'execute') then
    raise exception 'a client grant is missing';
  end if;
  if has_function_privilege('anon', 'public._run_entry_guard()', 'execute')
     or has_function_privilege('authenticated', 'public._run_entry_guard()', 'execute') then
    raise exception '_run_entry_guard is executable by a client';
  end if;
  if not has_column_privilege('authenticated', 'public.customers', 'emergency_phone', 'select')
     or not has_column_privilege('authenticated', 'public.customers', 'emergency_phone', 'update')
     or has_column_privilege('anon', 'public.customers', 'emergency_phone', 'select') then
    raise exception 'the emergency columns carry the wrong grants';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'queue_entries_run_guard'
                   and tgrelid = 'public.queue_entries'::regclass and not tgisinternal) then
    raise exception 'queue_entries_run_guard is missing';
  end if;
  if not exists (select 1 from public.badges where slug = 'run_for_her' and auto and system and not retired) then
    raise exception 'the run_for_her badge is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261005230000', 'run_for_her')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
