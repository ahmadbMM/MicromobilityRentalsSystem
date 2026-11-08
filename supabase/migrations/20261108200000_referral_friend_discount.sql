-- ============================================================================
-- Referrals: the friend's half (the owner, 2026-11-08: "the person who uses the referral code for the first time gets a
-- 50% discount for his booking (for one bike) if multiple bikes were booked only make the discount apply on one bike and
-- when the booking is paid and completed after that the person who gave the referral code gets a free ride"), on top of
-- 20261108160000 and 20261108180000. The owner's answers: new riders only, the friend's own bike, JCC rides and
-- Petromin nights, never a Carbon bike - for every referral code, the fifth friend's bonus too.
--
--  1. The friend's own code. A new account linked to a referrer (the link, the code typed on the Invite card or in the
--     booking's promo box, staff, or a held referral staff allow) gets one personal code: 'RW-' + the referrer's code +
--     three characters, ref_pct percent off (Settings, default 50), one use, valid ref_days
--     (promo_codes.referral_welcome_of names the friend). The app puts it on the account holder's own seat (rider 1);
--     one use is one bike, as the server counts a use on each row that carries a code and refuses a used-up code, and a
--     cancelled booking gives the use back (_promo_count). Only a rider with no finished paid ride is given one; a
--     referral held by the device check or removed by staff puts an unused one away (_ref_welcome_off), and allowing or
--     linking again brings it back (_ref_welcome).
--  2. Where referral codes pay: a JCC ride or a Petromin night, never a Carbon bike - the friend's code, the free ride
--     (RF-) and the bonus (RB-, which paid for Carbon until now) alike. _ref_code_guard refuses Carbon
--     (REF_CODE_CARBON); on any other kind of session a new booking goes without the code and a move there is refused
--     (REF_CODE_SESSION), where the scope guard used to drop it and keep its use. Their ride_kind is cleared so a
--     Petromin night takes them.
--  3. The referrer's free ride follows the friend's first paid, finished JCC ride or Petromin night (was JCC only), in
--     the trigger, staff_set_referrer and staff_referral_review.
--  4. Settings > Business: ref_pct (5-100, default 50) in staff_options 'biz' (_ref_pct).
--  5. customer_referral answers pct, the friend's code (welcome) and, per free ride, whether it is the bonus (bonus);
--     any_bike is gone with Carbon.
--  6. Linked friends who have not finished a paid ride get their code now.
--
-- Rollback:
--   drop trigger if exists queue_entries_ref_code on public.queue_entries;
--   create trigger queue_entries_ref_code before insert or update of promo_code, type_preference on public.queue_entries
--     for each row execute function public._ref_code_guard();   -- then 20261108160000's _ref_code_guard again
--   update public.promo_codes set active = false where referral_welcome_of is not null;
--   update public.promo_codes set ride_kind = 'jcc' where (referral_friend_id is not null or referral_bonus_of is not null);
--   drop function if exists public._ref_welcome(text), public._ref_welcome_off(text), public._ref_pct();
--   then 20261108180000's _ref_reward, customer_referral, customer_set_referrer, staff_referral_review and
--   _ref_expiry_tick, and 20261108160000's _ref_ride_done and staff_set_referrer, again;
--   alter table public.promo_codes drop column if exists referral_welcome_of;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';


/* -- 1. the column and the setting -------------------------------------------------------------- */
alter table public.promo_codes add column if not exists referral_welcome_of text;
comment on column public.promo_codes.referral_welcome_of is
  'The referred friend this code is for: ref_pct off their own bike, one use (20261108200000); null = any other code.';
create unique index if not exists promo_codes_referral_welcome_uq on public.promo_codes (referral_welcome_of)
  where referral_welcome_of is not null;

-- The friend's discount in percent: Settings > Business > Referrals (ref_pct), 5-100, 50 when unset.
create or replace function public._ref_pct()
 returns integer
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select case when jsonb_typeof(b -> 'ref_pct') = 'number' then least(greatest((b ->> 'ref_pct')::numeric, 5), 100)::int else 50 end
    from (select coalesce((select items from staff_options where key = 'biz'), '{}'::jsonb) as b) x
$function$;
revoke all on function public._ref_pct() from public, anon, authenticated;


/* -- 1. the friend's code ----------------------------------------------------------------------- */
-- Made once per friend, ever: a referral that is linked, not held, whose friend has finished no paid ride. An unused
-- code put away comes back (named after the referrer of now); a used one is never made again.
create or replace function public._ref_welcome(p_friend text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  r referrals%rowtype;
  cf record;
  c promo_codes%rowtype;
  _a constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  _b bytea;
  _who text;
  _rc text;
  _code text;
  _until date;
  _had boolean;
begin
  select * into r from referrals where friend_id = p_friend;
  if not found or r.held or r.rode_at is not null then return null; end if;
  select * into cf from _ref_conf();
  if not cf.ref_on then return null; end if;
  if not _ref_new(p_friend, 0, false) then return null; end if;   -- a new rider: no finished paid ride yet
  select * into c from promo_codes where referral_welcome_of = p_friend;
  _had := found;
  if _had and coalesce(c.uses, 0) > 0 then return c.code; end if;
  -- the referrer's own code goes in the friend's, so staff read whose invite it was
  select coalesce(x.merged_into, x.id) into _who from customers x where x.id = r.referrer_id;
  if _who is null then return null; end if;
  _rc := coalesce((select code from referral_codes where code = r.code),
                  (select code from referral_codes where customer_id = _who),
                  _ref_make_code(_who));
  _until := (now() at time zone 'Asia/Riyadh')::date + cf.ref_days;
  if _had and c.code like 'RW-' || _rc || '-%' then
    update promo_codes set active = true, expires_at = greatest(coalesce(expires_at, _until), _until)
     where id = c.id and not active;
    return c.code;
  end if;
  loop
    _b := gen_random_bytes(3);
    _code := 'RW-' || _rc || '-';
    for i in 0..2 loop
      _code := _code || substr(_a, 1 + get_byte(_b, i) % length(_a), 1);
    end loop;
    exit when not exists (select 1 from promo_codes where lower(code) = lower(_code));
  end loop;
  if _had then
    -- an unused code from an earlier referrer: the new referrer's name, a fresh term
    update promo_codes set code = _code, value = _ref_pct(), active = true, expires_at = _until where id = c.id;
    return _code;
  end if;
  insert into promo_codes (id, code, kind, value, active, created_at, applies_to, expires_at, max_uses, uses,
                           customer_id, ride_kind, referral_welcome_of)
  values ('rw-' || p_friend, _code, 'percent', _ref_pct(), true,
          to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), null, _until, 1, 0, p_friend, null, p_friend)
  on conflict (id) do nothing;
  return (select code from promo_codes where id = 'rw-' || p_friend);
end $function$;
revoke all on function public._ref_welcome(text) from public, anon, authenticated;

-- A held or removed referral puts the friend's unused code away; a booking that holds it keeps it.
create or replace function public._ref_welcome_off(p_friend text)
 returns void
 language sql
 security definer
 set search_path to 'public'
as $function$
  update promo_codes set active = false
   where referral_welcome_of = p_friend and active and coalesce(uses, 0) = 0
$function$;
revoke all on function public._ref_welcome_off(text) from public, anon, authenticated;


/* -- 2. where a referral code pays -------------------------------------------------------------- */
create or replace function public._ref_code_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(new.promo_code, '') = '' or (select is_staff()) then return new; end if;
  if not exists (select 1 from promo_codes c
                  where lower(c.code) = lower(new.promo_code)
                    and (c.referral_friend_id is not null or c.referral_bonus_of is not null
                         or c.referral_welcome_of is not null)) then
    return new;
  end if;
  -- Any other kind of session: a new booking goes without the code, so no use is counted. A booking moved there, or
  -- given the code there, is refused instead: dropping the code then would keep its use, as _promo_count follows an
  -- update only when it names promo_code or status (the move names session_id).
  if coalesce(_session_kind(new.session_id), '') not in ('jcc', 'petromin') then
    if tg_op = 'INSERT' then
      new.promo_code := null;
      return new;
    end if;
    if new.session_id is distinct from old.session_id
       or lower(new.promo_code) is distinct from lower(coalesce(old.promo_code, '')) then
      raise exception 'A referral code works on a JCC ride or a Petromin night only.' using errcode = 'P0001', detail = 'REF_CODE_SESSION';
    end if;
  end if;
  if coalesce(new.type_preference, '') ilike '%carbon%' then
    raise exception 'A referral code is not valid on a Carbon bike.' using errcode = 'P0001', detail = 'REF_CODE_CARBON';
  end if;
  return new;
end $function$;
revoke execute on function public._ref_code_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_ref_code on public.queue_entries;
create trigger queue_entries_ref_code
  before insert or update of promo_code, type_preference, session_id on public.queue_entries
  for each row execute function public._ref_code_guard();

-- the free rides already given: a Petromin night takes them too, and _ref_code_guard keeps them off Carbon
update public.promo_codes set ride_kind = null
 where (referral_friend_id is not null or referral_bonus_of is not null) and ride_kind = 'jcc';


/* -- 3. the free ride follows a JCC ride or a Petromin night ------------------------------------ */
create or replace function public._ref_ride_done()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- Most riders were never referred: one look at the key and out, before any sub-transaction.
  if not exists (select 1 from referrals where friend_id = new.customer_id and rode_at is null) then return null; end if;
  if coalesce(_session_kind(new.session_id), '') not in ('jcc', 'petromin') then return null; end if;
  begin
    perform _ref_reward(new.customer_id, new.id);
  exception when others then
    raise warning 'referral reward skipped for booking %: %', new.id, sqlerrm;
  end;
  return null;
end $function$;
revoke all on function public._ref_ride_done() from public, anon, authenticated;

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
  _bonus text;
begin
  select * into r from referrals where friend_id = p_friend for update;
  -- a held referral waits for staff (staff_referral_review), its ride not used up
  if not found or r.rode_at is not null or r.held then return; end if;
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
  else
    -- One free ride per friend, ever: a code this friend earned before (for a referrer since deleted) is not made again.
    select code, customer_id into _code, _owner from promo_codes where referral_friend_id = p_friend;
    if found and _owner is distinct from _who then
      update referrals set rode_entry_id = p_entry, rode_at = now() where friend_id = p_friend;
    else
      if _code is null then
        loop
          _code := 'RF-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8));
          exit when not exists (select 1 from promo_codes where lower(code) = lower(_code));
        end loop;
        -- ride_kind null: a JCC ride or a Petromin night, which _ref_code_guard holds it to
        insert into promo_codes (id, code, kind, value, active, created_at, applies_to, expires_at, max_uses, uses,
                                 customer_id, ride_kind, referral_friend_id)
        values ('rf-' || p_friend, _code, 'percent', 100, true,
                to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), null,
                (now() at time zone 'Asia/Riyadh')::date + cf.ref_days, 1, 0, _who, null, p_friend);
      end if;
      update referrals set rode_entry_id = p_entry, rode_at = now(), reward_code = _code, rewarded_at = now()
       where friend_id = p_friend;
      perform _push_queue(_who, 'ref-' || p_friend, 'MicroMobility',
        'A friend you invited rode, so your free ride is ready. | ركب صديق دعوته، وركوبتك المجانية جاهزة.', '/');
    end if;
  end if;
  -- The fifth friend who rode (over the yearly limit too): one bonus free ride, once per account; not on Carbon
  -- since 20261108200000, as every referral code.
  if (select count(*) from referrals x where x.referrer_id = r.referrer_id and x.rode_at is not null) >= 5
     and not exists (select 1 from promo_codes where referral_bonus_of = _who) then
    loop
      _bonus := 'RB-' || upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 8));
      exit when not exists (select 1 from promo_codes where lower(code) = lower(_bonus));
    end loop;
    insert into promo_codes (id, code, kind, value, active, created_at, applies_to, expires_at, max_uses, uses,
                             customer_id, ride_kind, referral_bonus_of)
    values ('rb-' || _who, _bonus, 'percent', 100, true,
            to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), null,
            (now() at time zone 'Asia/Riyadh')::date + cf.ref_days, 1, 0, _who, null, _who)
    on conflict (id) do nothing;
    perform _push_queue(_who, 'ref-bonus', 'MicroMobility',
      'Five friends rode with your invite: a bonus free ride is yours. | ركب خمسة أصدقاء بدعوتك: لك ركوبة مجانية إضافية.', '/');
  end if;
end $function$;
revoke all on function public._ref_reward(text, text) from public, anon, authenticated;


/* -- 5. the rider's card: the friend's code and the percent -------------------------------------- */
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
    'ok', true, 'on', cf.ref_on, 'code', _code, 'days', cf.ref_days, 'cap', cf.ref_cap, 'pct', _ref_pct(),
    'joined', (select count(*) from referrals where referrer_id = p_id),
    'rode', (select count(*) from referrals where referrer_id = p_id and rode_at is not null),
    'earned', (select count(*) from referrals where referrer_id = p_id and reward_code is not null),
    'referred', _ref,
    'can_enter', cf.ref_on and not _ref and _ref_new(p_id, 0, true),
    'welcome', (select jsonb_build_object('code', c.code, 'expires_at', c.expires_at, 'used', coalesce(c.uses, 0) > 0,
                                          'pct', c.value)
                  from promo_codes c
                 where c.referral_welcome_of = p_id and c.customer_id = p_id and c.active = true
                 limit 1),
    'rewards', coalesce((select jsonb_agg(jsonb_build_object('code', c.code, 'expires_at', c.expires_at,
                                                             'used', coalesce(c.uses, 0) > 0,
                                                             'bonus', c.referral_bonus_of is not null) order by c.expires_at)
                           from promo_codes c
                          where c.customer_id = p_id and c.active = true
                            and (c.referral_friend_id is not null or c.referral_bonus_of is not null)),
                        '[]'::jsonb));
end $function$;
revoke all on function public.customer_referral(text, text, boolean) from public;
grant execute on function public.customer_referral(text, text, boolean) to anon, authenticated;


/* -- 1. linking gives the friend their code ----------------------------------------------------- */
create or replace function public.customer_set_referrer(p_id text, p_token text, p_code text, p_via text default 'link',
                                                        p_device text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v text := _ref_norm(p_code);
  _who text;
  -- the browser's id, never kept as it came
  _dev text := case when coalesce(p_device, '') ~ '^[A-Za-z0-9_-]{8,64}$'
                    then encode(digest('mm-ref:' || p_device, 'sha256'), 'hex') end;
  _held boolean := false;
  f record;
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
  insert into referrals (friend_id, referrer_id, code, via, device)
  values (p_id, _who, v, case when p_via = 'code' then 'code' else 'link' end, _dev)
  on conflict (friend_id) do nothing;
  -- A third account for one code from one device in a day: that device's referrals for the code wait for staff, and
  -- their friends' unused codes with them.
  if _dev is not null
     and (select count(*) from referrals where referrer_id = _who and device = _dev and created_at > now() - interval '24 hours') >= 3 then
    for f in update referrals set held = true
              where referrer_id = _who and device = _dev and created_at > now() - interval '24 hours'
                and reward_code is null and reviewed_at is null
             returning friend_id loop
      perform _ref_welcome_off(f.friend_id);
    end loop;
    _held := exists (select 1 from referrals where friend_id = p_id and held);
  end if;
  return jsonb_build_object('ok', true, 'held', _held, 'welcome', case when _held then null else _ref_welcome(p_id) end);
end $function$;
revoke all on function public.customer_set_referrer(text, text, text, text, text) from public;
grant execute on function public.customer_set_referrer(text, text, text, text, text) to anon, authenticated;


/* -- 1, 3. staff link or unlink ------------------------------------------------------------------ */
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
    perform _ref_welcome_off(p_friend);
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
  -- The desk may link a friend after their first paid ride: a JCC ride or a Petromin night counts now. A friend with
  -- no paid ride yet gets their own code instead.
  select x.id into q from queue_entries x
   where x.customer_id = p_friend and x.status = 'done' and x.paid is true and x.price > 0
     and coalesce(_session_kind(x.session_id), '') in ('jcc', 'petromin')
   order by x.registered_at limit 1;
  if q.id is not null then perform _ref_reward(p_friend, q.id); end if;
  return jsonb_build_object('ok', true,
    'rewarded', exists (select 1 from referrals where friend_id = p_friend and reward_code is not null),
    'welcome', _ref_welcome(p_friend));
end $function$;
revoke all on function public.staff_set_referrer(text, text) from public, anon;
grant execute on function public.staff_set_referrer(text, text) to authenticated;

-- Staff allow a held referral (its free ride then follows the ride already done, if any, else the friend's code comes
-- back) or remove it (the friend's unused code goes with it).
create or replace function public.staff_referral_review(p_friend text, p_allow boolean)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  r referrals%rowtype;
  q record;
begin
  -- People is the section's id since 2026-11-06 (the client reads 'customers' as 'community'): either name lets in.
  if not (select _staff_mod('customers', true) or _staff_mod('community', true)) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  select * into r from referrals where friend_id = p_friend for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid'); end if;
  if not coalesce(p_allow, false) then
    if r.reward_code is not null then return jsonb_build_object('ok', false, 'reason', 'rewarded'); end if;
    delete from referrals where friend_id = p_friend;
    perform _ref_welcome_off(p_friend);
    return jsonb_build_object('ok', true);
  end if;
  update referrals set held = false, reviewed_by = auth.uid(), reviewed_at = now() where friend_id = p_friend;
  select x.id into q from queue_entries x
   where x.customer_id = p_friend and x.status = 'done' and x.paid is true and x.price > 0
     and coalesce(_session_kind(x.session_id), '') in ('jcc', 'petromin')
   order by x.registered_at limit 1;
  if q.id is not null then perform _ref_reward(p_friend, q.id); end if;
  return jsonb_build_object('ok', true,
    'rewarded', exists (select 1 from referrals where friend_id = p_friend and reward_code is not null),
    'welcome', _ref_welcome(p_friend));
end $function$;
revoke all on function public.staff_referral_review(text, boolean) from public, anon;
grant execute on function public.staff_referral_review(text, boolean) to authenticated;


/* -- the week's reminder names the friend's code too ------------------------------------------- */
create or replace function public._ref_expiry_tick()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  n integer;
  m integer;
  td date := (now() at time zone 'Asia/Riyadh')::date;
begin
  insert into push_outbox (customer_id, tag, title, body, url)
  select c.customer_id, 'ref-exp-' || lower(c.code), 'MicroMobility',
         'Your free ride ' || c.code || ' ends on ' || to_char(c.expires_at, 'DD Mon') || '. Book a ride to use it. | ركوبتك المجانية '
           || c.code || ' تنتهي في ' || to_char(c.expires_at, 'DD/MM') || '. احجز جولة لتستخدمها.', '/'
    from promo_codes c
   where (c.referral_friend_id is not null or c.referral_bonus_of is not null)
     and c.active and coalesce(c.uses, 0) = 0 and c.customer_id is not null
     and c.expires_at between td and td + 7
  on conflict (customer_id, tag) do nothing;
  get diagnostics n = row_count;
  insert into push_outbox (customer_id, tag, title, body, url)
  select c.customer_id, 'ref-exp-' || lower(c.code), 'MicroMobility',
         'Your ' || round(c.value)::text || '% off ' || c.code || ' ends on ' || to_char(c.expires_at, 'DD Mon')
           || '. Book a ride to use it. | خصمك ' || round(c.value)::text || '% بالرمز ' || c.code || ' ينتهي في '
           || to_char(c.expires_at, 'DD/MM') || '. احجز جولة لتستخدمه.', '/'
    from promo_codes c
   where c.referral_welcome_of is not null
     and c.active and coalesce(c.uses, 0) = 0 and c.customer_id is not null
     and c.expires_at between td and td + 7
  on conflict (customer_id, tag) do nothing;
  get diagnostics m = row_count;
  update push_outbox set sent_at = now(), result = 'stale' where sent_at is null and created_at < now() - interval '3 days';
  return n + m;
end $function$;
revoke all on function public._ref_expiry_tick() from public, anon, authenticated;


/* -- 6. the friends already linked ------------------------------------------------------------- */
do $welcome$
declare f record;
begin
  for f in select friend_id from referrals where rode_at is null and not held loop
    perform _ref_welcome(f.friend_id);
  end loop;
end $welcome$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261108200000', 'referral_friend_discount')
on conflict (version) do nothing;

commit;
