-- ============================================================================
-- Named circuit challenge (new features build F25; the owner marked it "Build now" on the decision page, 2026-11-13).
-- Staff name a challenge for a season ("100 laps this winter"): a lap target, the first and last day, and the fewest
-- seconds between two laps. Its poster at the start line is a QR code (the same address can sit on a plain NFC link tag):
-- experiences.micromobility.sa/?lap=<code>. A rider scans it on every lap and sees their own count against the target.
--
--  1. circuit_challenges   one row per challenge. Staff who open People read it (_staff_mod('community')), those who
--                          may change People write it. A trigger gives each challenge its own season badge in badges
--                          (slug lap_<12 hex>, the lap-ring glyph on gold, auto: only a rider who holds it sees it) and
--                          keeps the badge's name with the challenge's.
--  2. circuit_laps         one row per lap counted. No policy and no grant: only the functions below touch it.
--  3. circuit_lap(p_id, p_token, p_code, p_add, p_key, p_ago)   what the lap page calls. It counts ONE lap when
--                            - the caller's token is good (riders are not Auth users: _cust_token_ok),
--                            - the challenge's season holds today (Saudi calendar),
--                            - the caller has a checked-in booking (status 'active'; or 'done' with its check-out after
--                              the lap, for a lap the phone kept with no signal and sent late) on a circuit session
--                              (a circuit night, a Petromin night or the National Day kind: bikes on the circuit; never
--                              the Saturday road ride, never a bike-free kind) whose window (_session_window, with 15
--                              minutes before the start and 30 after the end) holds the lap's moment,
--                            - and none of the caller's laps lies within min_gap_s of that moment.
--                          Otherwise it adds nothing. Either way it answers the caller's OWN count, the target and
--                          whether the badge is held, and gives the badge the first time the count reaches the target.
--                          p_key is the scan's own key, so a retry is never counted twice; p_ago is how many seconds
--                          ago the scan was (at most an hour), so two laps kept offline each count at their own time.
--                          No times, no speeds, no ranking, nothing about any other rider (members see nobody).
--  4. circuit_mine(p_id, p_token)   the challenges running today with the caller's own count, for the Stats page.
--  5. staff_circuit_totals()        riders, laps and finishers per challenge (counts only), for the staff page.
--
-- The app works before this runs: it hides the Stats card and the lap page shows nothing to count (PGRST202), and the
-- staff tab says the database is not set up yet (PGRST205).
--
-- Rollback:
--   drop function if exists public.staff_circuit_totals(), public.circuit_mine(text, text),
--     public.circuit_lap(text, text, text, boolean, text, integer);
--   drop table if exists public.circuit_laps, public.circuit_challenges cascade;
--   drop function if exists public._circuit_badge(), public._circuit_badge_gone(), public._circuit_ts(text);
--   delete from public.badges b where b.slug like 'lap\_%' and b.icon = 'lapring'
--     and not exists (select 1 from public.customer_badges cb where cb.badge_id = b.id);   -- a badge someone holds stays
--   delete from supabase_migrations.schema_migrations where version = '20261114082500';
-- Idempotent.
-- ============================================================================

begin;

-- ── 1, 2: tables ─────────────────────────────────────────────────────────────────────────────────
create table if not exists public.circuit_challenges (
  id         text primary key default ('cc_' || replace(gen_random_uuid()::text, '-', '')),
  code       text not null unique default substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)
             check (code ~ '^[a-z0-9]{6,16}$'),
  name       text not null check (char_length(btrim(name)) between 1 and 40),
  name_ar    text check (char_length(name_ar) <= 40),
  names      jsonb not null default '{}'::jsonb check (jsonb_typeof(names) = 'object' and char_length(names::text) <= 1200),
  target     integer not null check (target between 1 and 100000),
  starts_on  date not null,
  ends_on    date not null,
  min_gap_s  integer not null default 300 check (min_gap_s between 10 and 86400),
  badge_id   text references public.badges (id) on update cascade on delete set null,
  created_by text check (char_length(created_by) <= 60),
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
alter table public.circuit_challenges enable row level security;
revoke all on public.circuit_challenges from public, anon, authenticated;
grant select, insert, update, delete on public.circuit_challenges to authenticated;
drop policy if exists circuit_challenges_staff_read on public.circuit_challenges;
create policy circuit_challenges_staff_read on public.circuit_challenges for select to authenticated using ((select public._staff_mod('community', false)));
drop policy if exists circuit_challenges_staff_ins on public.circuit_challenges;
create policy circuit_challenges_staff_ins on public.circuit_challenges for insert to authenticated with check ((select public._staff_mod('community', true)));
drop policy if exists circuit_challenges_staff_upd on public.circuit_challenges;
create policy circuit_challenges_staff_upd on public.circuit_challenges for update to authenticated using ((select public._staff_mod('community', true))) with check ((select public._staff_mod('community', true)));
drop policy if exists circuit_challenges_staff_del on public.circuit_challenges;
create policy circuit_challenges_staff_del on public.circuit_challenges for delete to authenticated using ((select public._staff_mod('community', true)));

create table if not exists public.circuit_laps (
  id           text primary key default ('lap_' || replace(gen_random_uuid()::text, '-', '')),
  challenge_id text not null references public.circuit_challenges (id) on update cascade on delete cascade,
  customer_id  text not null references public.customers (id) on update cascade on delete cascade,
  session_id   text references public.sessions (id) on update cascade on delete set null,
  at           timestamptz not null default now(),
  client_key   text check (client_key is null or client_key ~ '^[a-z0-9]{8,40}$'),
  created_at   timestamptz not null default now()
);
create unique index if not exists circuit_laps_key_idx on public.circuit_laps (customer_id, client_key) where client_key is not null;
create index if not exists circuit_laps_who_idx on public.circuit_laps (challenge_id, customer_id, at desc);
alter table public.circuit_laps enable row level security;
revoke all on public.circuit_laps from public, anon, authenticated;

-- ── helpers ─────────────────────────────────────────────────────────────────────────────────────
-- queue_entries keeps its check-in and check-out as ISO text; one that cannot be read is no time at all.
create or replace function public._circuit_ts(p text)
returns timestamptz
language plpgsql stable set search_path to 'public'
as $$
begin
  if p is null or btrim(p) = '' then return null; end if;
  return p::timestamptz;
exception when others then return null;
end $$;
revoke all on function public._circuit_ts(text) from public, anon, authenticated;

-- A challenge's own season badge: made with it, renamed with it. system (admins cannot delete it from under the
-- challenge) and auto (a rider sees it only once they hold it), as the Cool Season badge of 20261111100000; held_only
-- starts true, so its "Customers and members see it" switch (20261112223000) reads off, as the app shows it, and a
-- later change of that switch by an admin is kept. The description names the target with no noun to make plural.
create or replace function public._circuit_badge()
returns trigger
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_hex text := substr(md5(new.id), 1, 12); v_id text;
begin
  v_id := 'bd_lap_' || v_hex;
  new.name := btrim(new.name);
  new.name_ar := nullif(btrim(coalesce(new.name_ar, '')), '');
  new.code := lower(new.code);
  insert into badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort, held_only)
  values (v_id, 'lap_' || v_hex, 'lapring', 'gold', new.name, new.name_ar,
          'Laps of the circuit in one season: ' || new.target,
          'لفات الحلبة في موسم واحد: ' || new.target, true, true, 99, true)
  on conflict (id) do update set name = excluded.name, name_ar = excluded.name_ar,
    description = excluded.description, description_ar = excluded.description_ar;
  new.badge_id := v_id;
  return new;
end $$;
revoke all on function public._circuit_badge() from public, anon, authenticated;
drop trigger if exists circuit_challenges_badge on public.circuit_challenges;
create trigger circuit_challenges_badge before insert or update on public.circuit_challenges
  for each row execute function public._circuit_badge();

-- A challenge deleted: its badge goes with it unless a rider holds it (theirs to keep).
create or replace function public._circuit_badge_gone()
returns trigger
language plpgsql volatile security definer set search_path to 'public'
as $$
begin
  if old.badge_id is not null then
    begin
      delete from badges b where b.id = old.badge_id and b.slug like 'lap\_%'
         and not exists (select 1 from customer_badges cb where cb.badge_id = b.id);
    exception when others then null;   -- something else still points at it: the badge stays
    end;
  end if;
  return old;
end $$;
revoke all on function public._circuit_badge_gone() from public, anon, authenticated;
drop trigger if exists circuit_challenges_badge_gone on public.circuit_challenges;
create trigger circuit_challenges_badge_gone after delete on public.circuit_challenges
  for each row execute function public._circuit_badge_gone();

-- ── 3: the lap page's one call ──────────────────────────────────────────────────────────────────
create or replace function public.circuit_lap(p_id text, p_token text, p_code text, p_add boolean default true,
                                              p_key text default null, p_ago integer default 0)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare
  c circuit_challenges%rowtype;
  v_today date := _ksa_today();
  v_accts text[]; v_key text; v_at timestamptz; v_sess text;
  v_n integer; v_live boolean; v_added boolean := false; v_why text; v_held boolean := false; v_new boolean := false;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select * into c from circuit_challenges where code = lower(btrim(coalesce(p_code, '')));
  if not found then return jsonb_build_object('ok', false, 'error', 'none'); end if;
  v_accts := _accts_of(p_id);
  v_live := v_today between c.starts_on and c.ends_on;
  v_key := case when p_key ~ '^[a-z0-9]{8,40}$' then p_key end;

  if coalesce(p_add, false) then
    -- one call at a time per rider and challenge: two taps of one scan must not both pass the interval check
    perform pg_advisory_xact_lock(hashtext('circuitlap:' || c.id || ':' || p_id));
    if v_key is not null and exists (select 1 from circuit_laps l where l.customer_id = p_id and l.client_key = v_key) then
      v_added := true;   -- this very scan is already counted: its first answer was lost on the way back
    elsif not v_live then
      v_why := 'season';
    else
      v_at := now() - make_interval(secs => least(greatest(coalesce(p_ago, 0), 0), 3600));
      select q.session_id into v_sess
        from queue_entries q
        join sessions s on s.id = q.session_id
        cross join lateral _session_window(s) w
       where q.customer_id = any(v_accts)
         and (q.status = 'active' or (q.status = 'done' and _circuit_ts(q.checked_out_at::text) >= v_at))
         and coalesce(_circuit_ts(q.checked_in_at::text), v_at) <= v_at + interval '5 minutes'
         and (coalesce(s.event_kind, '') <> 'community' or s.ride_kind in ('petromin', 'snd96'))
         and v_at >= w.starts_at - interval '15 minutes' and v_at <= w.ends_at + interval '30 minutes'
       order by w.starts_at desc
       limit 1;
      if v_sess is null then
        v_why := 'booking';
      elsif exists (select 1 from circuit_laps l
                     where l.challenge_id = c.id and l.customer_id = any(v_accts)
                       and l.at > v_at - make_interval(secs => c.min_gap_s)
                       and l.at < v_at + make_interval(secs => c.min_gap_s)) then
        v_why := 'gap';
      else
        insert into circuit_laps (challenge_id, customer_id, session_id, at, client_key)
        values (c.id, p_id, v_sess, v_at, v_key) on conflict do nothing;
        v_added := found;
      end if;
    end if;
  end if;

  select count(*)::integer into v_n from circuit_laps l where l.challenge_id = c.id and l.customer_id = any(v_accts);
  if c.badge_id is not null then
    v_held := exists (select 1 from customer_badges cb where cb.badge_id = c.badge_id and cb.customer_id = any(v_accts));
    if not v_held and v_n >= c.target and exists (select 1 from badges b where b.id = c.badge_id and not b.retired) then
      insert into customer_badges (customer_id, badge_id, awarded_by, note)
      values (p_id, c.badge_id, 'system', left(c.name, 140)) on conflict do nothing;
      v_new := found; v_held := true;
    end if;
  end if;

  return jsonb_build_object('ok', true, 'name', c.name, 'name_ar', c.name_ar, 'names', c.names, 'target', c.target,
    'n', v_n, 'added', v_added, 'why', v_why, 'live', v_live, 'starts_on', c.starts_on, 'ends_on', c.ends_on,
    'gap', c.min_gap_s, 'badge', v_held, 'new_badge', v_new,
    'badge_slug', (select b.slug from badges b where b.id = c.badge_id));
end $$;
revoke all on function public.circuit_lap(text, text, text, boolean, text, integer) from public;
grant execute on function public.circuit_lap(text, text, text, boolean, text, integer) to anon, authenticated;

-- ── 4: the Stats card ───────────────────────────────────────────────────────────────────────────
create or replace function public.circuit_mine(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_today date := _ksa_today(); v_accts text[];
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  v_accts := _accts_of(p_id);
  return jsonb_build_object('ok', true, 'list', coalesce((
    select jsonb_agg(jsonb_build_object('name', c.name, 'name_ar', c.name_ar, 'names', c.names, 'target', c.target,
             'n', (select count(*)::integer from circuit_laps l where l.challenge_id = c.id and l.customer_id = any(v_accts)),
             'starts_on', c.starts_on, 'ends_on', c.ends_on,
             'badge', exists (select 1 from customer_badges cb where cb.badge_id = c.badge_id and cb.customer_id = any(v_accts)))
           order by c.ends_on, c.created_at)
      from circuit_challenges c
     where v_today between c.starts_on and c.ends_on), '[]'::jsonb));
end $$;
revoke all on function public.circuit_mine(text, text) from public;
grant execute on function public.circuit_mine(text, text) to anon, authenticated;

-- ── 5: the staff page's counts ──────────────────────────────────────────────────────────────────
create or replace function public.staff_circuit_totals()
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not coalesce(_staff_mod('community', false), false) then raise exception 'not staff' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id,
             'riders', (select count(distinct l.customer_id)::integer from circuit_laps l where l.challenge_id = c.id),
             'laps', (select count(*)::integer from circuit_laps l where l.challenge_id = c.id),
             'done', (select count(*)::integer from customer_badges cb where cb.badge_id = c.badge_id)))
      from circuit_challenges c), '[]'::jsonb);
end $$;
revoke all on function public.staff_circuit_totals() from public, anon;
grant execute on function public.staff_circuit_totals() to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114082500', 'circuit_challenge')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Read-only check: each column's name says the value expected.
select
  (select count(*) from pg_class k where k.relnamespace = 'public'::regnamespace
     and k.relname in ('circuit_challenges', 'circuit_laps') and k.relrowsecurity) as rls_on_2,
  (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = 'circuit_challenges') as policies_4,
  (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = 'circuit_laps') as lap_policies_0,
  has_table_privilege('anon', 'public.circuit_laps', 'select') as anon_reads_laps_false,
  has_table_privilege('authenticated', 'public.circuit_laps', 'select') as staff_reads_laps_false,
  (select count(*) from pg_proc f where f.pronamespace = 'public'::regnamespace and f.prosecdef
     and f.proname in ('circuit_lap', 'circuit_mine', 'staff_circuit_totals', '_circuit_badge', '_circuit_badge_gone')) as definer_5,
  has_function_privilege('anon', 'public.circuit_lap(text,text,text,boolean,text,integer)', 'execute') as anon_lap_true,
  has_function_privilege('anon', 'public.staff_circuit_totals()', 'execute') as anon_totals_false,
  has_function_privilege('anon', 'public._circuit_badge()', 'execute') as anon_badge_trigger_false,
  (select count(*) from pg_trigger g where g.tgrelid = 'public.circuit_challenges'::regclass and not g.tgisinternal) as triggers_2,
  (select count(*) from supabase_migrations.schema_migrations where version = '20261114082500') as ledger_1;
