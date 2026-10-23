-- ============================================================================
-- A partner's ride takes several codes, each with its own number of places (the owner, 2026-10-23:
-- "change the defe spots to include multiple codes not defe24, let me be able to choose the number
-- of spots and the code itself, no waitlist is permissible").
--
-- 1. session_partner_codes: one row per code on a partner's ride (staff only), places = how many
--    bookings that code may make. Codes are matched without regard to case; two codes on one
--    partner ride cannot differ only by case. The single code on session_partners (code /
--    code_limit, 20261017120000) is copied in once and is no longer read.
-- 2. queue_entries.partner_code_used: the code a partner booking came with (as staff typed it),
--    written by the partner_ask trigger from mm.partner_code, which only partner_book sets.
-- 3. partner_book: with code_needed on, the code must be one of the ride's codes (BAD_CODE) and that
--    code must have a place left (CODE_USED_UP); the partner's total places still hold
--    (PARTNER_FULL). A partner booking never waits: if anything put it on the waitlist the whole
--    booking is refused with PARTNER_FULL and nothing is written.
-- 4. partner_status.code_open: some code still has a place (or no code is needed).
--
-- Rollback: drop table session_partner_codes; alter table queue_entries drop column
-- partner_code_used; partner_book / partner_status / _partner_ask_fill as 20261018120000 and
-- 20261017120000 have them.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- 1 ─────────────────────────────────────────────────────────────────────────
create table if not exists public.session_partner_codes (
  session_id  text not null,
  partner     text not null,
  code        text not null check (code ~ '^[A-Za-z0-9_-]{3,40}$'),
  places      integer not null default 0 check (places between 0 and 1000),
  created_at  timestamptz not null default now(),
  primary key (session_id, partner, code),
  foreign key (session_id, partner) references public.session_partners (session_id, partner)
    on update cascade on delete cascade
);
create unique index if not exists session_partner_codes_ci
  on public.session_partner_codes (session_id, partner, lower(code));
alter table public.session_partner_codes enable row level security;
drop policy if exists "staff read" on public.session_partner_codes;
drop policy if exists "staff write" on public.session_partner_codes;
create policy "staff read" on public.session_partner_codes for select using ((select is_staff()));
create policy "staff write" on public.session_partner_codes for all using ((select is_staff())) with check ((select is_staff()));
revoke all on public.session_partner_codes from anon;
grant select, insert, update, delete on public.session_partner_codes to authenticated;

-- The old single code becomes the ride's first code: its limit, or every place when it had none.
insert into public.session_partner_codes (session_id, partner, code, places)
select sp.session_id, sp.partner, sp.code, coalesce(sp.code_limit, sp.places)
  from public.session_partners sp
 where sp.code is not null
on conflict do nothing;
comment on column public.session_partners.code is 'Unused since 20261023120000: codes live in session_partner_codes.';
comment on column public.session_partners.code_limit is 'Unused since 20261023120000: each code has its places in session_partner_codes.';

-- 2 ─────────────────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists partner_code_used text
  check (partner_code_used is null or length(partner_code_used) <= 40);
comment on column public.queue_entries.partner_code_used is
  'The partner code this booking came with (session_partner_codes.code, 20261023120000); null otherwise.';
update public.queue_entries q set partner_code_used = sp.code
  from public.session_partners sp
 where q.session_id = sp.session_id and q.partner = sp.partner
   and coalesce(q.partner_code, false) and q.partner_code_used is null and sp.code is not null;

-- Only the booking partner_book is making carries its answers and its code; any other insert gets null.
create or replace function public._partner_ask_fill()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare pb text[]; a text; c text;
begin
  pb := string_to_array(coalesce(current_setting('mm.partner', true), ''), '|');
  a := nullif(current_setting('mm.partner_ask', true), '');
  c := nullif(current_setting('mm.partner_code', true), '');
  if cardinality(pb) = 3 and pb[1] = new.session_id and new.partner = pb[2] then
    new.partner_ask := a::jsonb;
    new.partner_code_used := c;
  else
    new.partner_ask := null;
    new.partner_code_used := null;
  end if;
  return new;
end $function$;

create or replace function public._partner_code_live(p_session text, p_partner text, p_code text)
 returns integer
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select count(*)::int from queue_entries q
   where q.session_id = p_session and q.partner = p_partner
     and lower(coalesce(q.partner_code_used, '')) = lower(p_code)
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
$function$;
revoke all on function public._partner_code_live(text, text, text) from public, anon, authenticated;

-- 3 ─────────────────────────────────────────────────────────────────────────
create or replace function public.partner_book(p_id text, p_token text, p_partner text, p_code text, p_entry jsonb)
 returns table(id text, queue_num integer, status text)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare sp session_partners%rowtype; pc session_partner_codes%rowtype; r record; _code boolean;
        _name text; _ask jsonb; _got text; _size text;
begin
  if not _cust_token_ok(p_id, p_token) then
    raise exception 'STALE_SESSION' using errcode = 'P0001';
  end if;
  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'entry';
  end if;
  -- The partner page's question (Defe shirt, 20261018120000): had one on 22 October, or the size wanted.
  if p_entry ? 'ask' and jsonb_typeof(p_entry->'ask') <> 'null' then
    if jsonb_typeof(p_entry->'ask') <> 'object' then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'ask';
    end if;
    _got := p_entry->'ask'->>'shirt_got';
    if _got is null or _got not in ('true', 'false') then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'ask';
    end if;
    if _got = 'true' then
      _ask := jsonb_build_object('shirt_got', true);
    else
      _size := upper(btrim(coalesce(p_entry->'ask'->>'shirt', '')));
      if _size not in ('XS', 'S', 'M', 'L', 'XL', 'XXL') then
        raise exception 'SHIRT_SIZE' using errcode = 'P0001';
      end if;
      _ask := jsonb_build_object('shirt_got', false, 'shirt', _size);
    end if;
  end if;
  sp := _partner_session(p_partner);
  if sp.session_id is null then
    raise exception 'PARTNER_CLOSED' using errcode = 'P0001';
  end if;
  -- One booking at a time per partner ride: the places and each code's places are counted under it.
  perform pg_advisory_xact_lock(hashtext('partner:' || sp.session_id || ':' || sp.partner));
  if _partner_live(sp.session_id, sp.partner, false) >= sp.places then
    raise exception 'PARTNER_FULL' using errcode = 'P0001';
  end if;
  _code := sp.code_needed;
  if _code then
    -- One of the ride's codes (20261023120000), each with its own places.
    select * into pc from session_partner_codes c
     where c.session_id = sp.session_id and c.partner = sp.partner
       and lower(c.code) = lower(btrim(coalesce(p_code, '')));
    if pc.code is null then
      raise exception 'BAD_CODE' using errcode = 'P0001';
    end if;
    if _partner_code_live(sp.session_id, sp.partner, pc.code) >= pc.places then
      raise exception 'CODE_USED_UP' using errcode = 'P0001';
    end if;
  end if;
  select c.name into _name from customers c where c.id = p_id;
  perform set_config('mm.partner', sp.session_id || '|' || sp.partner || '|' || case when _code then '1' else '0' end, true);
  perform set_config('mm.partner_ask', coalesce(_ask::text, ''), true);
  perform set_config('mm.partner_code', case when _code then pc.code else '' end, true);
  for r in
    select * from customer_create_booking(p_id, p_token, jsonb_build_array(
      (p_entry - 'promo_code' - 'group_id' - 'run_km' - 'share_ok' - 'ask')
      || jsonb_build_object('session_id', sp.session_id, 'name', coalesce(_name, ''))))
  loop
    -- No waitlist for a partner (the owner, 2026-10-23): a place, or nothing at all.
    if r.status = 'waitlist' then
      raise exception 'PARTNER_FULL' using errcode = 'P0001';
    end if;
    id := r.id; queue_num := r.queue_num; status := r.status;
    return next;
  end loop;
  perform set_config('mm.partner', '', true);
  perform set_config('mm.partner_ask', '', true);
  perform set_config('mm.partner_code', '', true);
end $function$;
revoke all on function public.partner_book(text, text, text, text, jsonb) from public;
grant execute on function public.partner_book(text, text, text, text, jsonb) to anon, authenticated;

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
    not sp.code_needed or exists (
      select 1 from session_partner_codes c
       where c.session_id = sp.session_id and c.partner = sp.partner
         and _partner_code_live(sp.session_id, sp.partner, c.code) < c.places);
end $function$;
revoke all on function public.partner_status(text) from public;
grant execute on function public.partner_status(text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261023120000', 'partner_codes')
on conflict (version) do nothing;

commit;

-- Check (read only): the codes, the column, and the functions' attributes.
select (select json_agg(c order by c.code) from public.session_partner_codes c) as codes,
       (select count(*) from information_schema.columns
         where table_name = 'queue_entries' and column_name = 'partner_code_used') as col,
       (select json_agg(json_build_object('fn', p.proname, 'definer', p.prosecdef, 'settings', p.proconfig) order by p.proname)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('partner_book', 'partner_status', '_partner_code_live', '_partner_ask_fill')) as fns;
