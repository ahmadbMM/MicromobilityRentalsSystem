-- ============================================================================
-- Ride reminders and waitlist offers (staff app round 2, R7), 2026-10-09.
--
-- There is no WhatsApp Business API and no e-mail (Brevo declined): staff send every message themselves
-- from wa.me links. The database keeps what was sent and runs the waitlist's clock.
--
--  1. queue_entries.reminded_at / reminded_kind ('24h' | '2h'): when staff last sent the booking a
--     reminder and which one. Staff write them like any booking column (is_staff RLS, table grant).
--  2. waitlist_offers: a place offered to a waitlisted rider with a claim window. token (32 hex) is the
--     rider's link (/?claim=<token>); status open -> claimed | expired | declined | cancelled | closed
--     (closed: the booking left the waitlist some other way). Staff read every row and may set sent_at
--     (the WhatsApp went out) and status (cancel); rows are made only by the functions below.
--  3. _wl_mode(): Settings > Business wl_offer_mode, 'auto' | 'staff' | 'claim', default 'staff'.
--     _wl_claim_min(): wl_claim_min minutes (default 30, held to 5..720; _biz_int reads 1..1000).
--  4. _promote_next_waitlist (every server-side promotion: a rider's own cancel, a move, more places on
--     a ride) promotes only in 'auto'. In 'staff' it promotes nobody (staff choose on the desk); in
--     'claim' it offers the freed places instead (_wl_offer_fill). Approval rides, the Own-bike rule,
--     the Petromin rule and the waitlist order are untouched: the check sits after the approval-ride
--     return and the offers pick riders exactly as the promotion did.
--  5. _wl_offer_fill(session): in 'claim', one open offer per free place (capacity less the places held
--     less the offers still open), to the next eligible waitlisted riders who have not had an offer on
--     this ride expire or turned it down. Nothing on an approval ride, a cancelled ride or one that ended.
--  6. staff_offer_spot(session, booking default null): staff offer a place now (the next rider, or the
--     one named; an open offer is handed back as it is). Any mode.
--  7. customer_claim_get(token) / customer_claim_spot(token, decline default false): anon. The claim
--     checks the window and the room atomically (the promotion's advisory lock), then promotes the rider
--     the way _promote_next_waitlist does (mm.promoting, add-on stock). Declining offers the place on.
--  8. A booking that leaves the waitlist closes its open offer (trigger).
--  9. pg_cron 'mm-wl-offers' every 5 minutes: open offers past their window expire and the place goes to
--     the next rider (_wl_offer_tick).
--
-- Rollback: select cron.unschedule('mm-wl-offers'); drop trigger queue_entries_wl_offer_close on
--   public.queue_entries; drop function public._wl_offer_close(), public._wl_offer_tick(),
--   public.customer_claim_spot(text, boolean), public.customer_claim_get(text),
--   public.staff_offer_spot(text, text), public._wl_offer_fill(text), public._wl_claim_min(), public._wl_mode();
--   drop table public.waitlist_offers; re-run 20260925140000 section 8 for _promote_next_waitlist (the
--   only change is the block marked (20261009225000)). The two queue_entries columns may stay.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create extension if not exists pg_cron with schema pg_catalog;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

-- ── 1. Reminders on the booking ─────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists reminded_at timestamptz;
alter table public.queue_entries add column if not exists reminded_kind text;
do $c$ begin
  if not exists (select 1 from pg_constraint where conname = 'queue_entries_reminded_kind_chk') then
    alter table public.queue_entries add constraint queue_entries_reminded_kind_chk
      check (reminded_kind is null or reminded_kind in ('24h', '2h'));
  end if;
end $c$;
comment on column public.queue_entries.reminded_at is 'When staff last sent this booking a ride reminder on WhatsApp (20261009225000).';
comment on column public.queue_entries.reminded_kind is 'Which reminder that was: 24h | 2h (20261009225000).';

-- ── 2. The offers ───────────────────────────────────────────────────────────────────────────
create table if not exists public.waitlist_offers (
  id          uuid primary key default gen_random_uuid(),
  booking_id  text not null references public.queue_entries(id) on delete cascade,
  session_id  text not null,
  token       text not null unique check (token ~ '^[0-9a-f]{32}$'),
  offered_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  claimed_at  timestamptz,
  sent_at     timestamptz,
  offered_by  uuid,
  status      text not null default 'open'
              check (status in ('open', 'claimed', 'expired', 'declined', 'cancelled', 'closed'))
);
create unique index if not exists waitlist_offers_one_open on public.waitlist_offers (booking_id) where status = 'open';
create index if not exists waitlist_offers_session_idx on public.waitlist_offers (session_id, status);
create index if not exists waitlist_offers_open_exp_idx on public.waitlist_offers (expires_at) where status = 'open';

alter table public.waitlist_offers enable row level security;
drop policy if exists waitlist_offers_staff_read on public.waitlist_offers;
create policy waitlist_offers_staff_read on public.waitlist_offers
  for select to authenticated using ((select is_staff()));
drop policy if exists waitlist_offers_staff_upd on public.waitlist_offers;
create policy waitlist_offers_staff_upd on public.waitlist_offers
  for update to authenticated using ((select is_staff())) with check ((select is_staff()));
revoke all on public.waitlist_offers from public, anon, authenticated;
grant select on public.waitlist_offers to authenticated;
grant update (sent_at, status) on public.waitlist_offers to authenticated;

-- ── 3. The mode and the window ──────────────────────────────────────────────────────────────
create or replace function public._wl_mode()
returns text
language sql stable security definer set search_path to 'public'
as $$
  select coalesce((
    select case when o.items ->> 'wl_offer_mode' in ('auto', 'staff', 'claim') then o.items ->> 'wl_offer_mode' end
      from staff_options o where o.key = 'biz'), 'staff')
$$;
revoke execute on function public._wl_mode() from public, anon, authenticated;

create or replace function public._wl_claim_min()
returns int
language sql stable security definer set search_path to 'public'
as $$ select least(greatest(_biz_int('wl_claim_min', 30), 5), 720) $$;
revoke execute on function public._wl_claim_min() from public, anon, authenticated;

-- ── 5. Offer the free places ────────────────────────────────────────────────────────────────
create or replace function public._wl_offer_fill(p_session_id text)
returns int
language plpgsql security definer set search_path to 'public'
as $$
declare _s sessions%rowtype; _own boolean; _held int; _open int; _free int; _n int := 0; r record; _min int;
begin
  if _wl_mode() <> 'claim' then return 0; end if;
  select * into _s from sessions where id = p_session_id;
  if not found or coalesce(_s.needs_approval, false) or _s.cancelled_at is not null then return 0; end if;
  if (select w.ends_at from _session_window(_s) w) <= now() then return 0; end if;
  _own := coalesce(_s.event_kind,'') = 'community' and coalesce(_s.ride_kind,'') = 'petromin';
  select count(*) into _held from queue_entries q
   where q.session_id = p_session_id
     and coalesce(q.status,'') not in ('cancelled','removed','noshow','waitlist')
     and (_own or coalesce(q.type_preference,'') <> 'Own');
  select count(*) into _open from waitlist_offers o
   where o.session_id = p_session_id and o.status = 'open' and o.expires_at > now();
  _free := coalesce(_s.capacity, 12) - _held - _open;
  if _free <= 0 then return 0; end if;
  _min := _wl_claim_min();
  for r in
    select q.id from queue_entries q
     where q.session_id = p_session_id and q.status = 'waitlist'
       and (_own or coalesce(q.type_preference,'') <> 'Own')
       and not exists (select 1 from waitlist_offers o where o.booking_id = q.id
                        and o.status in ('open', 'expired', 'declined'))
     order by coalesce(q.waitlist_num, 2147483647), q.registered_at
     limit _free
  loop
    insert into waitlist_offers (booking_id, session_id, token, expires_at)
    values (r.id, p_session_id, replace(gen_random_uuid()::text, '-', ''), now() + make_interval(mins => _min));
    _n := _n + 1;
  end loop;
  return _n;
end $$;
revoke execute on function public._wl_offer_fill(text) from public, anon, authenticated;

-- ── 4. Server-side promotions follow the mode ───────────────────────────────────────────────
do $pm$
declare d text;
begin
  d := pg_get_functiondef('public._promote_next_waitlist(text)'::regprocedure);
  if position('(20261009225000)' in d) > 0 then
    raise notice '_promote_next_waitlist already follows the waitlist mode; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  perform pg_advisory_xact_lock(hashtext('promote:'||p_session_id));$a$,
$b$  perform pg_advisory_xact_lock(hashtext('promote:'||p_session_id));
  /* Settings > Business wl_offer_mode (20261009225000): staff choose, or the rider claims an offer */
  if _wl_mode() <> 'auto' then
    if _wl_mode() = 'claim' then perform _wl_offer_fill(p_session_id); end if;
    return null;
  end if;$b$);
  execute d;
end $pm$;

-- ── 6. Staff offer a place ──────────────────────────────────────────────────────────────────
create or replace function public.staff_offer_spot(p_session_id text, p_booking_id text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare _s sessions%rowtype; _own boolean; _bid text; o waitlist_offers%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select * into _s from sessions where id = p_session_id;
  if not found then raise exception 'NO_SESSION' using errcode = 'P0001'; end if;
  if coalesce(_s.needs_approval, false) then raise exception 'APPROVAL_RIDE' using errcode = 'P0001'; end if;
  if (select w.ends_at from _session_window(_s) w) <= now() then raise exception 'ENDED' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtext('promote:'||p_session_id));
  _own := coalesce(_s.event_kind,'') = 'community' and coalesce(_s.ride_kind,'') = 'petromin';
  if p_booking_id is not null then
    select q.id into _bid from queue_entries q
     where q.id = p_booking_id and q.session_id = p_session_id and q.status = 'waitlist';
    if _bid is null then raise exception 'NOT_WAITLISTED' using errcode = 'P0001'; end if;
  else
    select q.id into _bid from queue_entries q
     where q.session_id = p_session_id and q.status = 'waitlist'
       and (_own or coalesce(q.type_preference,'') <> 'Own')
       and not exists (select 1 from waitlist_offers o where o.booking_id = q.id
                        and o.status in ('open', 'expired', 'declined'))
     order by coalesce(q.waitlist_num, 2147483647), q.registered_at
     limit 1;
    if _bid is null then raise exception 'NOBODY_WAITING' using errcode = 'P0001'; end if;
  end if;
  update waitlist_offers set status = 'expired' where booking_id = _bid and status = 'open' and expires_at <= now();
  select * into o from waitlist_offers where booking_id = _bid and status = 'open';
  if not found then
    insert into waitlist_offers (booking_id, session_id, token, expires_at, offered_by)
    values (_bid, p_session_id, replace(gen_random_uuid()::text, '-', ''), now() + make_interval(mins => _wl_claim_min()), auth.uid())
    returning * into o;
  end if;
  return jsonb_build_object('id', o.id, 'booking_id', o.booking_id, 'session_id', o.session_id, 'token', o.token,
                            'offered_at', o.offered_at, 'expires_at', o.expires_at, 'status', o.status);
end $$;
revoke execute on function public.staff_offer_spot(text, text) from public, anon;
grant execute on function public.staff_offer_spot(text, text) to authenticated;

-- ── 7. The rider's side ─────────────────────────────────────────────────────────────────────
create or replace function public.customer_claim_get(p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare o waitlist_offers%rowtype; q queue_entries%rowtype; _s sessions%rowtype; st text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND'); end if;
  select * into o from waitlist_offers where token = p_token;
  if not found then return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND'); end if;
  select * into q from queue_entries where id = o.booking_id;
  select * into _s from sessions where id = o.session_id;
  st := case when o.status = 'open' and o.expires_at <= now() then 'expired' else o.status end;
  return jsonb_build_object(
    'ok', true, 'status', st, 'expires_at', o.expires_at, 'now', now(),
    'first_name', split_part(btrim(coalesce(q.name, '')), ' ', 1),
    'booking_status', q.status, 'queue_num', q.queue_num,
    'session', jsonb_build_object('id', _s.id, 'date', _s.session_date, 'time', _rs_time(_s.bike_slots),
                                  'title', _s.title, 'ride_kind', _s.ride_kind, 'event_kind', _s.event_kind,
                                  'location', _s.location));
end $$;
revoke execute on function public.customer_claim_get(text) from public;
grant execute on function public.customer_claim_get(text) to anon, authenticated;

create or replace function public.customer_claim_spot(p_token text, p_decline boolean default false)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare o waitlist_offers%rowtype; q queue_entries%rowtype; _s sessions%rowtype; _own boolean; _held int; _n int; _a jsonb; k text;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{32}$' then return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND'); end if;
  select * into o from waitlist_offers where token = p_token for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'NOT_FOUND'); end if;
  if o.status = 'claimed' then return jsonb_build_object('ok', true, 'already', true); end if;
  if o.status <> 'open' then return jsonb_build_object('ok', false, 'reason', upper(o.status)); end if;
  if o.expires_at <= now() then
    update waitlist_offers set status = 'expired' where id = o.id;
    perform _wl_offer_fill(o.session_id);
    return jsonb_build_object('ok', false, 'reason', 'EXPIRED');
  end if;
  select * into _s from sessions where id = o.session_id;
  perform pg_advisory_xact_lock(hashtext('promote:'||o.session_id));
  select * into q from queue_entries where id = o.booking_id for update;
  if q.id is null or q.status <> 'waitlist' then
    update waitlist_offers set status = 'closed' where id = o.id;
    if q.status in ('waiting', 'active', 'done') then return jsonb_build_object('ok', true, 'already', true); end if;
    return jsonb_build_object('ok', false, 'reason', 'CLOSED');
  end if;
  if _s.id is null or _s.cancelled_at is not null or (select w.ends_at from _session_window(_s) w) <= now() then
    update waitlist_offers set status = 'closed' where id = o.id;
    return jsonb_build_object('ok', false, 'reason', 'ENDED');
  end if;
  if p_decline then
    update waitlist_offers set status = 'declined' where id = o.id;
    perform _wl_offer_fill(o.session_id);
    return jsonb_build_object('ok', true, 'declined', true);
  end if;
  -- the place must really be free now: counted as _promote_next_waitlist counts it
  _own := coalesce(_s.event_kind,'') = 'community' and coalesce(_s.ride_kind,'') = 'petromin';
  select count(*) into _held from queue_entries x
   where x.session_id = o.session_id
     and coalesce(x.status,'') not in ('cancelled','removed','noshow','waitlist')
     and (_own or coalesce(x.type_preference,'') <> 'Own');
  if _held >= coalesce(_s.capacity, 12) and (_own or coalesce(q.type_preference,'') <> 'Own') then
    return jsonb_build_object('ok', false, 'reason', 'FULL');
  end if;
  update waitlist_offers set status = 'claimed', claimed_at = now() where id = o.id;
  perform set_config('mm.promoting','1',true);
  update queue_entries set status = 'waiting' where id = q.id and status = 'waitlist';
  get diagnostics _n = row_count;
  perform set_config('mm.promoting','',true);
  if _n = 0 then raise exception 'CHANGED' using errcode = 'P0001'; end if;
  begin
    _a := _addon_map(q.addons);
    for k in select jsonb_object_keys(_a) loop
      update inventory i
         set qty = i.qty - greatest((_a->>k)::int - coalesce((coalesce(q.addons_held, '{}'::jsonb)->>k)::int, 0), 0)
       where i.id = k;
    end loop;
    update queue_entries set addons_held = _a where id = q.id;
  exception when others then null;
  end;
  return jsonb_build_object('ok', true, 'queue_num', q.queue_num);
end $$;
revoke execute on function public.customer_claim_spot(text, boolean) from public;
grant execute on function public.customer_claim_spot(text, boolean) to anon, authenticated;

-- ── 8. A booking off the waitlist closes its offer ──────────────────────────────────────────
create or replace function public._wl_offer_close()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  update waitlist_offers set status = 'closed' where booking_id = new.id and status = 'open';
  return null;
end $$;
revoke execute on function public._wl_offer_close() from public, anon, authenticated;
drop trigger if exists queue_entries_wl_offer_close on public.queue_entries;
create trigger queue_entries_wl_offer_close
  after update of status on public.queue_entries
  for each row
  when (old.status = 'waitlist' and new.status is distinct from 'waitlist')
  execute function public._wl_offer_close();

-- ── 9. The clock ────────────────────────────────────────────────────────────────────────────
create or replace function public._wl_offer_tick()
returns int
language plpgsql security definer set search_path to 'public'
as $$
declare sid text; _n int := 0;
begin
  for sid in
    with x as (update waitlist_offers set status = 'expired'
                where status = 'open' and expires_at <= now() returning session_id)
    select distinct session_id from x
  loop
    _n := _n + _wl_offer_fill(sid);
  end loop;
  return _n;
end $$;
revoke execute on function public._wl_offer_tick() from public, anon, authenticated;

do $cron$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'mm-wl-offers';
  perform cron.schedule('mm-wl-offers', '*/5 * * * *', $j$select public._wl_offer_tick()$j$);
end $cron$;

-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._wl_mode()', 'public._wl_claim_min()', 'public._wl_offer_fill(text)',
    'public.staff_offer_spot(text,text)', 'public.customer_claim_get(text)', 'public.customer_claim_spot(text,boolean)',
    'public._wl_offer_close()', 'public._wl_offer_tick()', 'public._promote_next_waitlist(text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._wl_mode()', 'public._wl_claim_min()', 'public._wl_offer_fill(text)',
    'public._wl_offer_tick()', 'public.staff_offer_spot(text,text)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
  end loop;
  if not has_function_privilege('anon', 'public.customer_claim_spot(text,boolean)', 'execute') then
    raise exception 'customer_claim_spot is not open to riders';
  end if;
  if position('(20261009225000)' in pg_get_functiondef('public._promote_next_waitlist(text)'::regprocedure)) = 0 then
    raise exception '_promote_next_waitlist was not patched';
  end if;
  if has_table_privilege('anon', 'public.waitlist_offers', 'select')
     or has_table_privilege('authenticated', 'public.waitlist_offers', 'insert') then
    raise exception 'waitlist_offers is open to the wrong roles';
  end if;
  if not exists (select 1 from cron.job where jobname = 'mm-wl-offers') then
    raise exception 'the offer timer is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009225000', 'reminders_waitlist_offers')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
