-- ============================================================================
-- Partner places on a ride: Defe x MicroMobility, Saturday Social Ride 24 Oct 2026 (the owner,
-- 2026-10-17: "a registration page under micromobility.sa/defe that allows people who create an
-- account or sign in ... to book for the next saturday social ride").
--
-- 1. session_partners: a partner's own places on one session (staff only). places = how many
--    bookings the partner gets ON TOP of the members; code / code_needed / code_limit = while
--    code_needed is on, a booking needs the code, and at most code_limit bookings may use it
--    (null = every place). Staff flip code_needed off to open the page to anyone with the link.
-- 2. queue_entries.partner ('defe') + partner_code (booked with the code): set only by
--    partner_book, never by a customer's own insert (customer_create_booking does not copy them).
-- 3. sessions.member_cap: on a members ride, after this many live member bookings (partner null)
--    a further member booking must bring its own bike (type 'Own'): MEMBER_BIKES_FULL. Applies to
--    staff adds as well (the owner: "for micromobility community members only allow bike owners
--    to book after 70 spots").
-- 4. partner_status(partner): what the partner page may know - which ride, whether places are
--    open, whether a code is needed and still takes bookings. Booleans only: the owner,
--    2026-10-17, "don't show the number of bookings or total bookings for customers only that
--    its full or not".
-- 5. partner_book(id, token, partner, code, entry): one booking for the signed-in account through
--    customer_create_booking (every rule it has: token, check-ups, waiver, bike type, one place per
--    person), with the partner's checks first under a lock: places left (PARTNER_FULL - no
--    waitlist), the code (BAD_CODE), the code's limit (CODE_USED_UP). The row comes out
--    approved (confirmed at once), never on the waitlist, marked with the partner.
--    It tells _community_booking_gate and _approval_guard through a transaction-local setting
--    (mm.partner = '<session>|<partner>|<1 if code>'), the way customer_create_booking hands
--    the promo base to its trigger (mm.promo_code). Customers cannot set it: PostgREST exposes
--    no set_config, and it lasts one transaction.
-- 6. member_bikes_open(session): whether a member may still book one of our bikes (true/false).
--
-- _community_booking_gate and _approval_guard are rewritten whole from their live definitions
-- (2026-10-17), keeping SECURITY DEFINER and search_path. Run supabase/checks/security-attributes.sql after.
-- The session's own settings (Defe's 80 places, the code, the 70-member cap, spots 150) are a
-- separate script, run after the booking app and the page are live.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- 1 ─────────────────────────────────────────────────────────────────────────
create table if not exists public.session_partners (
  session_id  text not null references public.sessions(id) on delete cascade,
  partner     text not null check (partner ~ '^[a-z0-9]{2,20}$'),
  label       text not null default '' check (length(label) <= 60),
  places      integer not null default 0 check (places between 0 and 1000),
  code        text check (code is null or code ~ '^[A-Za-z0-9_-]{3,40}$'),
  code_needed boolean not null default true,
  code_limit  integer check (code_limit is null or code_limit between 0 and 1000),
  created_at  timestamptz not null default now(),
  primary key (session_id, partner)
);
alter table public.session_partners enable row level security;
drop policy if exists "staff read" on public.session_partners;
drop policy if exists "staff write" on public.session_partners;
create policy "staff read" on public.session_partners for select using ((select is_staff()));
create policy "staff write" on public.session_partners for all using ((select is_staff())) with check ((select is_staff()));
revoke all on public.session_partners from anon;
grant select, insert, update, delete on public.session_partners to authenticated;

-- 2, 3 ──────────────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists partner text
  check (partner is null or partner ~ '^[a-z0-9]{2,20}$');
alter table public.queue_entries add column if not exists partner_code boolean;
alter table public.sessions add column if not exists member_cap integer
  check (member_cap is null or member_cap between 0 and 10000);
create index if not exists queue_entries_partner_idx on public.queue_entries (session_id, partner) where partner is not null;

-- The gate: members only, except a partner booking partner_book is making; and the member cap.
create or replace function public._community_booking_gate()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare s sessions%rowtype; pb text[]; _live int;
begin
  select * into s from sessions where id = new.session_id;
  -- A partner booking (partner_book, 20261017120000): marked, confirmed at once, never waitlisted.
  pb := string_to_array(coalesce(current_setting('mm.partner', true), ''), '|');
  if tg_op = 'INSERT' and cardinality(pb) = 3 and pb[1] = new.session_id then
    new.partner := pb[2];
    new.partner_code := (pb[3] = '1');
    new.approval := 'approved';
    if new.status = 'waitlist' then new.status := 'waiting'; end if;
    return new;
  end if;
  if s.id is not null
     and s.event_kind = 'community'
     and coalesce(s.open_to_all, false) = false
     and not is_staff()
     and (new.customer_id is null or not exists (
            select 1
              from customer_tags ct
              join tags tg on tg.id = ct.tag_id
             where ct.customer_id = new.customer_id
               and lower(tg.slug) = 'saturday'
               and _ctag_active(ct.starts_at, ct.expires_at)))
     -- a Petromin tag holder rides the Petromin nights (20261012180000)
     and not (coalesce(s.ride_kind, '') = 'petromin' and _petromin_holder(new.customer_id))
  then
    raise exception 'This ride is for community members only.' using detail = 'MEMBERS_ONLY';
  end if;
  -- The member cap (20261017120000): past it, a member brings their own bike. Staff too.
  if s.id is not null and s.member_cap is not null and new.partner is null
     and coalesce(new.type_preference, '') <> 'Own'
     and coalesce(new.status, '') not in ('cancelled', 'removed', 'noshow') then
    perform pg_advisory_xact_lock(hashtext('membercap:' || s.id));
    select count(*) into _live from queue_entries q
     where q.session_id = s.id and q.partner is null and q.id <> new.id
       and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
    if _live >= s.member_cap then
      raise exception 'Our bikes are taken for this ride. You can still join with your own bike.'
        using detail = 'MEMBER_BIKES_FULL';
    end if;
  end if;
  return new;
end $function$;

-- A customer's insert stays pending, except the partner booking partner_book is making.
create or replace function public._approval_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare pb text[];
begin
  if coalesce(auth.role(), '') not in ('anon','authenticated') then return new; end if;
  if tg_op = 'INSERT' then
    pb := string_to_array(coalesce(current_setting('mm.partner', true), ''), '|');
    if cardinality(pb) = 3 and pb[1] = new.session_id and new.partner = pb[2] then
      return new;   -- partner_book (20261017120000)
    end if;
    if new.approval is not null and new.approval <> 'pending' and not is_staff() then
      new.approval := 'pending';
    end if;
  else
    if new.approval is distinct from old.approval and new.approval is distinct from 'pending' and not is_staff() then
      new.approval := old.approval;
    end if;
  end if;
  return new;
end $function$;

-- The partner's next ride: the soonest upcoming open one carrying its places.
create or replace function public._partner_session(p_partner text)
 returns public.session_partners
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select sp.* from session_partners sp join sessions x on x.id = sp.session_id
   where sp.partner = lower(btrim(coalesce(p_partner, '')))
     and coalesce(x.status, '') in ('open', 'full')
     and coalesce(x.session_date, '9999-12-31') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD')
   order by x.session_date
   limit 1
$function$;
revoke all on function public._partner_session(text) from public, anon, authenticated;

create or replace function public._partner_live(p_session text, p_partner text, p_code_only boolean)
 returns integer
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select count(*)::int from queue_entries q
   where q.session_id = p_session and q.partner = p_partner
     and (not p_code_only or coalesce(q.partner_code, false))
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
$function$;
revoke all on function public._partner_live(text, text, boolean) from public, anon, authenticated;

-- 4 ─────────────────────────────────────────────────────────────────────────
create or replace function public.partner_status(p_partner text)
 returns table(session_id text, session_date text, bike_slots text, meet_url text,
               open boolean, code_needed boolean, code_open boolean)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare sp session_partners%rowtype; s sessions%rowtype;
begin
  sp := _partner_session(p_partner);
  if sp.session_id is null then return; end if;
  select * into s from sessions where sessions.id = sp.session_id;
  return query select s.id, s.session_date, s.bike_slots::text, s.meet_url,
    _partner_live(sp.session_id, sp.partner, false) < sp.places,
    sp.code_needed,
    not sp.code_needed or sp.code_limit is null
      or _partner_live(sp.session_id, sp.partner, true) < sp.code_limit;
end $function$;
revoke all on function public.partner_status(text) from public;
grant execute on function public.partner_status(text) to anon, authenticated;

-- 5 ─────────────────────────────────────────────────────────────────────────
create or replace function public.partner_book(p_id text, p_token text, p_partner text, p_code text, p_entry jsonb)
 returns table(id text, queue_num integer, status text)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare sp session_partners%rowtype; r record; _code boolean; _name text;
begin
  if not _cust_token_ok(p_id, p_token) then
    raise exception 'STALE_SESSION' using errcode = 'P0001';
  end if;
  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'entry';
  end if;
  sp := _partner_session(p_partner);
  if sp.session_id is null then
    raise exception 'PARTNER_CLOSED' using errcode = 'P0001';
  end if;
  -- One booking at a time per partner ride: the places and the code's limit are counted under it.
  perform pg_advisory_xact_lock(hashtext('partner:' || sp.session_id || ':' || sp.partner));
  if _partner_live(sp.session_id, sp.partner, false) >= sp.places then
    raise exception 'PARTNER_FULL' using errcode = 'P0001';
  end if;
  _code := sp.code_needed;
  if _code then
    if sp.code is null or lower(btrim(coalesce(p_code, ''))) <> lower(sp.code) then
      raise exception 'BAD_CODE' using errcode = 'P0001';
    end if;
    if sp.code_limit is not null and _partner_live(sp.session_id, sp.partner, true) >= sp.code_limit then
      raise exception 'CODE_USED_UP' using errcode = 'P0001';
    end if;
  end if;
  select c.name into _name from customers c where c.id = p_id;
  perform set_config('mm.partner', sp.session_id || '|' || sp.partner || '|' || case when _code then '1' else '0' end, true);
  for r in
    select * from customer_create_booking(p_id, p_token, jsonb_build_array(
      (p_entry - 'promo_code' - 'group_id' - 'run_km' - 'share_ok')
      || jsonb_build_object('session_id', sp.session_id, 'name', coalesce(_name, ''))))
  loop
    id := r.id; queue_num := r.queue_num; status := r.status;
    return next;
  end loop;
  perform set_config('mm.partner', '', true);
end $function$;
revoke all on function public.partner_book(text, text, text, text, jsonb) from public;
grant execute on function public.partner_book(text, text, text, text, jsonb) to anon, authenticated;

-- 6 ─────────────────────────────────────────────────────────────────────────
create or replace function public.member_bikes_open(p_session_id text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select coalesce((
    select s.member_cap is null or (
      select count(*) from queue_entries q
       where q.session_id = s.id and q.partner is null
         and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')) < s.member_cap
      from sessions s where s.id = p_session_id), true)
$function$;
revoke all on function public.member_bikes_open(text) from public;
grant execute on function public.member_bikes_open(text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261017120000', 'partner_places')
on conflict (version) do nothing;

commit;

-- Check (read only): every new piece is there and the attributes held.
select p.proname, p.prosecdef as definer, p.proconfig as settings
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('_community_booking_gate','_approval_guard','_partner_session','_partner_live',
                     'partner_status','partner_book','member_bikes_open')
 order by 1;
