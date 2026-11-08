-- ============================================================================
-- Referrals (the owner, 2026-11-08): "referring a friend that completes a paid ride gets a free ride". A rider shares
-- their own link or code; a friend who makes an account with it and then completes a paid rental (a JCC ride that is
-- done, paid and priced above 0) earns the rider one free ride.
--
--  1. referral_codes: each account's own code (six letters and digits, no 0/O/1/I/L), made the first time the
--     rider's Invite friends card asks for it (customer_referral with p_make).
--  2. referrals: one row per referred friend (friend_id is the key, so an account is referred once): who referred
--     them, with which code and how (link, code typed, staff), the ride that counted and the free ride it earned.
--     Staff with People (Accounts) read both tables; nobody writes them but the functions below.
--  3. promo_codes.referral_friend_id: the friend whose ride earned this free-ride code; null = any other code.
--  4. Settings > Business keys in staff_options 'biz': ref_on (unset = on; false stops new referrals and new free
--     rides, while codes already given stay good), ref_days (how long a free ride lasts, 7-365, default 60), ref_cap
--     (free rides one account can earn in a calendar year, KSA, 1-100, default 10).
--  5. customer_referral(p_id, p_token, p_make): the rider's code, their counts (friends joined, rode, free rides
--     earned), their free-ride codes, whether they were referred and whether they may still enter a friend's code.
--     It never names a friend: members see nobody (20261104120000).
--  6. customer_set_referrer(p_id, p_token, p_code, p_via): links a new account (made in the last 30 days, no
--     completed paid ride) to the code's owner. Answers {ok} or {ok:false, reason: off|invalid|self|already|not_new}.
--  7. staff_set_referrer(p_friend, p_ref): staff link an account by the referrer's code or mobile number (no age
--     limit; at most one completed paid ride, which then counts at once), or unlink one with an empty p_ref while
--     its free ride has not been given.
--  8. _ref_reward + trigger queue_entries_ref_reward (AFTER UPDATE OF status, paid, price): the first done, paid,
--     priced JCC booking of a referred friend gives the referrer one personal code, 100% off, one use, JCC rides only
--     (ride_kind 'jcc'), valid ref_days, at most ref_cap a year (over it the referral is marked capped, no code).
--     A failure there is a warning in the log, never a refused check-out.
--  9. _ref_code_guard (BEFORE INSERT OR UPDATE OF promo_code, type_preference): a referral free ride never pays for a
--     Carbon bike (REF_CODE_CARBON), as the blood codes. Staff pass, as they do every price rule.
--
-- A merged account is followed to the one it went into, for the referrer. Safe before or after the app: the app
-- draws nothing until customer_referral answers.
--
-- Rollback:
--   drop trigger if exists queue_entries_ref_reward on public.queue_entries;
--   drop trigger if exists queue_entries_ref_code on public.queue_entries;
--   drop function if exists public._ref_ride_done(), public._ref_code_guard(), public._ref_reward(text, text),
--     public._ref_new(text, integer, boolean), public._ref_make_code(text), public._ref_norm(text),
--     public._ref_conf(), public.customer_referral(text, text, boolean),
--     public.customer_set_referrer(text, text, text, text), public.staff_set_referrer(text, text);
--   update public.promo_codes set active = false where referral_friend_id is not null;
--   alter table public.promo_codes drop column if exists referral_friend_id;
--   drop table if exists public.referrals, public.referral_codes;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';


/* -- 1, 2, 3. the tables and the column ------------------------------------------------------- */
create table if not exists public.referral_codes (
  customer_id text primary key references public.customers(id) on delete cascade,
  code        text not null unique,
  created_at  timestamptz not null default now()
);
comment on table public.referral_codes is 'Each account''s own referral code, made when the rider first asks (20261108160000).';
alter table public.referral_codes enable row level security;
revoke all on public.referral_codes from public, anon, authenticated;
grant select on public.referral_codes to authenticated;
drop policy if exists "staff read" on public.referral_codes;
create policy "staff read" on public.referral_codes for select using ((select _staff_mod('customers', false) or _staff_mod('community', false)));

create table if not exists public.referrals (
  friend_id     text primary key references public.customers(id) on delete cascade,
  referrer_id   text not null references public.customers(id) on delete cascade,
  code          text not null,
  via           text not null default 'link' check (via in ('link', 'code', 'staff')),
  created_at    timestamptz not null default now(),
  created_by    uuid,
  rode_entry_id text,
  rode_at       timestamptz,
  reward_code   text,
  rewarded_at   timestamptz,
  capped        boolean not null default false,
  constraint referrals_not_self check (friend_id <> referrer_id)
);
comment on table public.referrals is
  'One row per referred friend: who referred them, the ride that counted and the free ride it earned (20261108160000).';
create index if not exists referrals_referrer_idx on public.referrals (referrer_id);
alter table public.referrals enable row level security;
revoke all on public.referrals from public, anon, authenticated;
grant select on public.referrals to authenticated;
drop policy if exists "staff read" on public.referrals;
create policy "staff read" on public.referrals for select using ((select _staff_mod('customers', false) or _staff_mod('community', false)));

alter table public.promo_codes add column if not exists referral_friend_id text;
comment on column public.promo_codes.referral_friend_id is
  'The referred friend whose first paid ride earned this free-ride code; null = any other code (20261108160000).';
create unique index if not exists promo_codes_referral_friend_uq on public.promo_codes (referral_friend_id)
  where referral_friend_id is not null;


/* -- 4. the settings ---------------------------------------------------------------------------- */
create or replace function public._ref_conf(out ref_on boolean, out ref_days integer, out ref_cap integer)
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select coalesce(b ->> 'ref_on', '') <> 'false',
         case when jsonb_typeof(b -> 'ref_days') = 'number' then least(greatest((b ->> 'ref_days')::numeric, 7), 365)::int else 60 end,
         case when jsonb_typeof(b -> 'ref_cap') = 'number' then least(greatest((b ->> 'ref_cap')::numeric, 1), 100)::int else 10 end
    from (select coalesce((select items from staff_options where key = 'biz'), '{}'::jsonb) as b) x
$function$;
revoke all on function public._ref_conf() from public, anon, authenticated;

-- A code as typed: Arabic and Persian digits as Latin ones, the code out of a pasted link, nothing but letters and
-- digits, in capitals.
create or replace function public._ref_norm(p text)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$
  select upper(regexp_replace(coalesce(substring(x from '[?&]ref=([A-Za-z0-9]+)'), x), '[^A-Za-z0-9]', '', 'g'))
    from (select translate(btrim(coalesce(p, '')), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789') as x) y
$function$;
revoke all on function public._ref_norm(text) from public, anon, authenticated;

-- An account that may still be referred: not merged away, made in the last 30 days (p_age), and with at most
-- p_rides completed paid rides on any kind of ride.
create or replace function public._ref_new(p_id text, p_rides integer, p_age boolean)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select exists (select 1 from customers c
                  where c.id = p_id and c.merged_into is null
                    and (not p_age or (c.created_at ~ '^\d{4}-\d{2}-\d{2}'
                                       and left(c.created_at, 10)::date >= (now() at time zone 'Asia/Riyadh')::date - 30)))
     and (select count(*) from queue_entries q
           where q.customer_id = p_id and q.status = 'done' and q.paid is true and q.price > 0) <= p_rides
$function$;
revoke all on function public._ref_new(text, integer, boolean) from public, anon, authenticated;

-- The account's code, made once: six characters a person can read out without mixing up 0/O or 1/I/L.
create or replace function public._ref_make_code(p_id text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  _a constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  _b bytea;
  _c text;
begin
  select code into _c from referral_codes where customer_id = p_id;
  if _c is not null then return _c; end if;
  loop
    _b := gen_random_bytes(6);
    _c := '';
    for i in 0..5 loop
      _c := _c || substr(_a, 1 + get_byte(_b, i) % length(_a), 1);
    end loop;
    begin
      insert into referral_codes (customer_id, code) values (p_id, _c);
      return _c;
    exception when unique_violation then
      -- the code was taken, or another tab made this account's code first
      select code into _c from referral_codes where customer_id = p_id;
      if _c is not null then return _c; end if;
    end;
  end loop;
end $function$;
revoke all on function public._ref_make_code(text) from public, anon, authenticated;


/* -- 5. the rider's own card -------------------------------------------------------------------- */
create or replace function public.customer_referral(p_id text, p_token text, p_make boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  cf record;
  _code text;
  _ref boolean;
begin
  if not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false); end if;
  select * into cf from _ref_conf();
  select code into _code from referral_codes where customer_id = p_id;
  if _code is null and cf.ref_on and coalesce(p_make, false) then _code := _ref_make_code(p_id); end if;
  _ref := exists (select 1 from referrals where friend_id = p_id);
  return jsonb_build_object(
    'ok', true, 'on', cf.ref_on, 'code', _code, 'days', cf.ref_days, 'cap', cf.ref_cap,
    'joined', (select count(*) from referrals where referrer_id = p_id),
    'rode', (select count(*) from referrals where referrer_id = p_id and rode_at is not null),
    'earned', (select count(*) from referrals where referrer_id = p_id and reward_code is not null),
    'referred', _ref,
    'can_enter', cf.ref_on and not _ref and _ref_new(p_id, 0, true),
    'rewards', coalesce((select jsonb_agg(jsonb_build_object('code', c.code, 'expires_at', c.expires_at,
                                                             'used', coalesce(c.uses, 0) > 0) order by c.expires_at)
                           from promo_codes c
                          where c.customer_id = p_id and c.referral_friend_id is not null and c.active = true),
                        '[]'::jsonb));
end $function$;
revoke all on function public.customer_referral(text, text, boolean) from public;
grant execute on function public.customer_referral(text, text, boolean) to anon, authenticated;


/* -- 6. a new account names who sent it --------------------------------------------------------- */
create or replace function public.customer_set_referrer(p_id text, p_token text, p_code text, p_via text default 'link')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v text := _ref_norm(p_code);
  _who text;
begin
  if not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if not _ip_gate('referral', 30, interval '10 minutes') then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if not (select ref_on from _ref_conf()) then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  if v = '' or length(v) > 12 then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  select coalesce(c.merged_into, c.id) into _who
    from referral_codes rc join customers c on c.id = rc.customer_id
   where rc.code = v;
  if _who is null then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  -- Not one's own code, not an account on the same mobile, and not back to a friend one referred.
  if _who = p_id
     or exists (select 1 from customers a join customers b on b.id = _who
                 where a.id = p_id and coalesce(a.phone, '') <> '' and a.phone = b.phone)
     or exists (select 1 from referrals where friend_id = _who and referrer_id = p_id) then
    return jsonb_build_object('ok', false, 'reason', 'self');
  end if;
  if exists (select 1 from referrals where friend_id = p_id) then
    return jsonb_build_object('ok', false, 'reason', 'already');
  end if;
  if not _ref_new(p_id, 0, true) then return jsonb_build_object('ok', false, 'reason', 'not_new'); end if;
  insert into referrals (friend_id, referrer_id, code, via)
  values (p_id, _who, v, case when p_via = 'code' then 'code' else 'link' end)
  on conflict (friend_id) do nothing;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.customer_set_referrer(text, text, text, text) from public;
grant execute on function public.customer_set_referrer(text, text, text, text) to anon, authenticated;


/* -- 8. the free ride --------------------------------------------------------------------------- */
create or replace function public._ref_reward(p_friend text, p_entry text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  r referrals%rowtype;
  cf record;
  _who text;
  _owner text;
  _n integer;
  _code text;
begin
  select * into r from referrals where friend_id = p_friend for update;
  if not found or r.rode_at is not null then return; end if;
  select * into cf from _ref_conf();
  if not cf.ref_on then return; end if;
  select coalesce(c.merged_into, c.id) into _who from customers c where c.id = r.referrer_id;
  if _who is null or _who = p_friend then
    update referrals set rode_entry_id = p_entry, rode_at = now() where friend_id = p_friend;
    return;
  end if;
  select count(*) into _n from referrals x
   where x.referrer_id = r.referrer_id and x.reward_code is not null
     and (x.rewarded_at at time zone 'Asia/Riyadh')::date >= date_trunc('year', now() at time zone 'Asia/Riyadh')::date;
  if _n >= cf.ref_cap then
    update referrals set rode_entry_id = p_entry, rode_at = now(), capped = true where friend_id = p_friend;
    return;
  end if;
  -- One free ride per friend, ever: a code this friend earned before (for a referrer since deleted) is not made again.
  select code, customer_id into _code, _owner from promo_codes where referral_friend_id = p_friend;
  if found and _owner is distinct from _who then
    update referrals set rode_entry_id = p_entry, rode_at = now() where friend_id = p_friend;
    return;
  end if;
  if _code is null then
    loop
      _code := 'RF-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8));
      exit when not exists (select 1 from promo_codes where lower(code) = lower(_code));
    end loop;
    insert into promo_codes (id, code, kind, value, active, created_at, applies_to, expires_at, max_uses, uses,
                             customer_id, ride_kind, referral_friend_id)
    values ('rf-' || p_friend, _code, 'percent', 100, true,
            to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), null,
            (now() at time zone 'Asia/Riyadh')::date + cf.ref_days, 1, 0, _who, 'jcc', p_friend);
  end if;
  update referrals set rode_entry_id = p_entry, rode_at = now(), reward_code = _code, rewarded_at = now()
   where friend_id = p_friend;
end $function$;
revoke all on function public._ref_reward(text, text) from public, anon, authenticated;

create or replace function public._ref_ride_done()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- Most riders were never referred: one look at the key and out, before any sub-transaction.
  if not exists (select 1 from referrals where friend_id = new.customer_id and rode_at is null) then return null; end if;
  if _session_kind(new.session_id) is distinct from 'jcc' then return null; end if;
  begin
    perform _ref_reward(new.customer_id, new.id);
  exception when others then
    raise warning 'referral reward skipped for booking %: %', new.id, sqlerrm;
  end;
  return null;
end $function$;
revoke all on function public._ref_ride_done() from public, anon, authenticated;

drop trigger if exists queue_entries_ref_reward on public.queue_entries;
create trigger queue_entries_ref_reward
  after update of status, paid, price on public.queue_entries
  for each row
  when (new.status = 'done' and new.paid is true and new.price > 0 and new.customer_id is not null)
  execute function public._ref_ride_done();


/* -- 7. staff link or unlink -------------------------------------------------------------------- */
create or replace function public.staff_set_referrer(p_friend text, p_ref text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  r referrals%rowtype;
  v text := _ref_norm(p_ref);
  _d text := regexp_replace(translate(coalesce(p_ref, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '\D', '', 'g');
  _who text;
  _n integer;
  q record;
begin
  -- People is the section's id since 2026-11-06 (the client reads 'customers' as 'community'): either name lets in.
  if not (select _staff_mod('customers', true) or _staff_mod('community', true)) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into r from referrals where friend_id = p_friend for update;
  if v = '' then
    if not found then return jsonb_build_object('ok', true); end if;
    if r.reward_code is not null then return jsonb_build_object('ok', false, 'reason', 'rewarded'); end if;
    delete from referrals where friend_id = p_friend;
    return jsonb_build_object('ok', true);
  end if;
  if found then return jsonb_build_object('ok', false, 'reason', 'already'); end if;
  if not exists (select 1 from customers where id = p_friend) then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  -- the referrer's code, else their mobile number (its last nine digits)
  select coalesce(c.merged_into, c.id) into _who
    from referral_codes rc join customers c on c.id = rc.customer_id
   where rc.code = v;
  if _who is null and length(_d) >= 8 then
    select count(*), min(c.id) into _n, _who from customers c
     where c.merged_into is null and right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 9) = right(_d, 9);
    if _n > 1 then return jsonb_build_object('ok', false, 'reason', 'many'); end if;
  end if;
  if _who is null then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if _who = p_friend
     or exists (select 1 from customers a join customers b on b.id = _who
                 where a.id = p_friend and coalesce(a.phone, '') <> '' and a.phone = b.phone)
     or exists (select 1 from referrals where friend_id = _who and referrer_id = p_friend) then
    return jsonb_build_object('ok', false, 'reason', 'self');
  end if;
  if not _ref_new(p_friend, 1, false) then return jsonb_build_object('ok', false, 'reason', 'not_new'); end if;
  insert into referrals (friend_id, referrer_id, code, via, created_by)
  values (p_friend, _who, coalesce((select code from referral_codes where customer_id = _who), v), 'staff', auth.uid());
  -- The desk may link a friend after their first paid ride: that ride counts now.
  select x.id, x.session_id into q from queue_entries x
   where x.customer_id = p_friend and x.status = 'done' and x.paid is true and x.price > 0
   order by x.registered_at limit 1;
  if q.id is not null and _session_kind(q.session_id) = 'jcc' then perform _ref_reward(p_friend, q.id); end if;
  return jsonb_build_object('ok', true, 'rewarded', exists (select 1 from referrals where friend_id = p_friend and reward_code is not null));
end $function$;
revoke all on function public.staff_set_referrer(text, text) from public, anon;
grant execute on function public.staff_set_referrer(text, text) to authenticated;


/* -- 9. where a referral free ride is good ------------------------------------------------------ */
create or replace function public._ref_code_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(new.promo_code, '') = '' or (select is_staff()) then return new; end if;
  if coalesce(new.type_preference, '') ilike '%carbon%'
     and exists (select 1 from promo_codes c
                  where lower(c.code) = lower(new.promo_code) and c.referral_friend_id is not null) then
    raise exception 'This free ride is not valid on a Carbon bike.' using errcode = 'P0001', detail = 'REF_CODE_CARBON';
  end if;
  return new;
end $function$;
revoke execute on function public._ref_code_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_ref_code on public.queue_entries;
create trigger queue_entries_ref_code
  before insert or update of promo_code, type_preference on public.queue_entries
  for each row execute function public._ref_code_guard();

insert into supabase_migrations.schema_migrations (version, name)
values ('20261108160000', 'referrals')
on conflict (version) do nothing;

commit;
