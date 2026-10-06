-- ============================================================================
-- Run for Her: a runner agrees before their details go to Sela and JYC (the owner, 2026-10-06: "add a
-- pop up for all customers that are booking or already have booked or even added to the run for her
-- and force them to approve it, that we will share the following info about them with Sela/JYC in
-- order to participate in the race": full name, email address, birth date, distance chosen, emergency
-- contact; "its for the run for her participants only").
--
--  1. queue_entries.data_share_at: when the runner agreed, in the format waiver_at is written
--     ('YYYY-MM-DDTHH:MM:SSZ', UTC); null while they have not. Only ever set on a Run for Her row.
--  2. customer_create_booking stamps it on a run's row whose entry carries share_ok = true: the booking
--     app asks on the runner step, once the details are saved (patched in place from the live
--     definition, two anchors next to the 20261005230000 run_km ones).
--  3. _run_entry_guard refuses a customer's new live row on the run without it (RUN_SHARE), after the
--     distance, age and details checks; staff are exempt, as with every ride rule (a rider staff add is
--     asked on their next visit instead). A live row that stays as it is is not judged again, so the
--     runners booked before this keep their places.
--  4. customer_accept_share: the runner agrees from the page the app and the website put up, which
--     nobody can close, for a run still ahead that holds a live row of theirs without the stamp (booked
--     before this change, or added at the desk). Stamps every such row of the account on that session;
--     returns how many (0 when another device got there first), -1 for a bad token.
--
-- Rollback: drop function if exists public.customer_accept_share(text, text, text);
--   re-run the two patches backwards (customer_create_booking: drop ", data_share_at" and its value;
--   _run_entry_guard: drop the RUN_SHARE block);
--   alter table public.queue_entries drop column if exists data_share_at;
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


-- ── 1. when the runner agreed ────────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists data_share_at text;
comment on column public.queue_entries.data_share_at is
  'Run for Her: when the runner agreed that MicroMobility shares their full name, email, birth date, distance and '
  'emergency contact with Sela and Jeddah Yacht Club for the race (UTC, as waiver_at); null until then (20261006180000).';


-- ── 2. customer_create_booking stamps it (patched from its live definition) ──────────────────
do $ccb$
declare d text;
begin
  d := pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure);
  if position('(20261006180000)' in d) > 0 then
    raise notice 'customer_create_booking already stamps data_share_at; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$      waiver_at, waiver_version, ride_group, run_km   -- Run for Her's distance (20261005230000)
    ) values ($a$,
$b$      waiver_at, waiver_version, ride_group, run_km,  -- Run for Her's distance (20261005230000)
      data_share_at                                   -- and the runner's agreement to share (20261006180000)
    ) values ($b$);
  d := pg_temp._once(d,
$a$case when it->>'run_km' in ('3','5') then (it->>'run_km')::smallint end
    )
    returning$a$,
$b$case when it->>'run_km' in ('3','5') then (it->>'run_km')::smallint end,
      case when it->>'share_ok' = 'true' and coalesce(s.ride_kind, '') = 'runher'
           then to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"') end
    )
    returning$b$);
  execute d;
end $ccb$;


-- ── 3. the run's guard asks for it (patched from its live definition) ────────────────────────
do $grd$
declare d text;
begin
  d := pg_get_functiondef('public._run_entry_guard()'::regprocedure);
  if position('RUN_SHARE' in d) > 0 then
    raise notice '_run_entry_guard already asks for the agreement; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  -- one place per account: the same lock _solo_ride_cap takes$a$,
$b$  -- the runner agreed that their details go to Sela and JYC for the race (20261006180000)
  if nullif(btrim(coalesce(new.data_share_at, '')), '') is null then
    raise exception 'Agree to share your details for the race.' using errcode = 'P0001', detail = 'RUN_SHARE';
  end if;

  -- one place per account: the same lock _solo_ride_cap takes$b$);
  execute d;
end $grd$;


-- ── 4. a runner agrees from the page ─────────────────────────────────────────────────────────
create or replace function public.customer_accept_share(p_id text, p_token text, p_session_id text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare _n int;
begin
  if not _cust_token_ok(p_id, p_token) then return -1; end if;
  update queue_entries x
     set data_share_at = to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    from sessions s
   where s.id = x.session_id
     and coalesce(s.ride_kind, '') = 'runher'
     and x.customer_id = p_id
     and x.session_id = p_session_id
     and coalesce(x.data_share_at, '') = ''
     and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow')
     and coalesce(x.session_date, '') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  get diagnostics _n = row_count;
  return _n;
end $function$;
revoke all on function public.customer_accept_share(text, text, text) from public;
grant execute on function public.customer_accept_share(text, text, text) to anon, authenticated;


-- ── checks ────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['customer_create_booking','_run_entry_guard','customer_accept_share'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if position('(20261006180000)' in pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'the customer_create_booking patch did not take';
  end if;
  if position('RUN_SHARE' in pg_get_functiondef('public._run_entry_guard()'::regprocedure)) = 0 then
    raise exception 'the _run_entry_guard patch did not take';
  end if;
  if not has_function_privilege('anon', 'public.customer_accept_share(text,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.customer_accept_share(text,text,text)', 'execute') then
    raise exception 'a client grant is missing';
  end if;
  if has_function_privilege('anon', 'public._run_entry_guard()', 'execute')
     or has_function_privilege('authenticated', 'public._run_entry_guard()', 'execute') then
    raise exception '_run_entry_guard is executable by a client';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'queue_entries' and column_name = 'data_share_at') then
    raise exception 'queue_entries.data_share_at is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261006180000', 'run_share_consent')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
