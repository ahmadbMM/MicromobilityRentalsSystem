-- ============================================================================
-- Referrals, the extras (the owner, 2026-11-08: "in more ideas do 2 3 6 8"), on top of 20261108160000.
--
--  2. Telling the referrer. push_outbox holds a browser notification waiting to go out (one per account and tag); the
--     free ride queues "your friend rode", _ref_expiry_tick (pg_cron mm-ref-expiry, 06:00 UTC = 09:00 KSA) queues
--     "your free ride ends on ..." once in its last seven days, and _push_drain_call (mm-push-drain, every two
--     minutes, only while something waits) asks /api/push-send to send them ({drain:true}). Push is off until the app
--     has its VAPID key and Pages its secrets: until then nothing is sent, and a message three days old is dropped,
--     never sent late. The app also says both itself (the free ride once on the device, the last days on the card).
--  3. The Recruiter badge: badges recruiter, recruiter_3, recruiter_5, recruiter_10 (auto; the app counts the friends
--     who rode, customer_referral's rode). The fifth friend who rode brings a bonus: one free ride on any bike, Carbon
--     too (promo_codes.referral_bonus_of, one per account ever), and customer_referral lists it with any_bike.
--  6. The staff report (People > Referrals) reads referrals, promo_codes and bookings under RLS: nothing here.
--  8. A device check. customer_set_referrer takes p_device (the app's id for its browser, kept only as a hash): a third
--     account linked to one code from one device within 24 hours holds that device's referrals for the code
--     (referrals.held). A held referral earns nothing until staff allow it (staff_referral_review, which also gives the
--     free ride when the ride is already done) or remove it; People staff see them on the bell and People > Referrals.
--
-- Rollback:
--   select cron.unschedule(jobid) from cron.job where jobname in ('mm-ref-expiry', 'mm-push-drain');
--   drop function if exists public._push_drain_call(), public._ref_expiry_tick(), public._push_queue(text, text, text, text, text),
--     public.staff_referral_review(text, boolean), public.customer_set_referrer(text, text, text, text, text);
--   then 20261108160000's customer_set_referrer, customer_referral and _ref_reward again;
--   update public.promo_codes set active = false where referral_bonus_of is not null;
--   delete from public.badges where slug in ('recruiter', 'recruiter_3', 'recruiter_5', 'recruiter_10');
--   alter table public.promo_codes drop column if exists referral_bonus_of;
--   alter table public.referrals drop column if exists device, drop column if exists held,
--     drop column if exists reviewed_by, drop column if exists reviewed_at;
--   drop table if exists public.push_outbox;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';


/* -- the columns and the outbox ----------------------------------------------------------------- */
alter table public.promo_codes add column if not exists referral_bonus_of text;
comment on column public.promo_codes.referral_bonus_of is
  'The account whose fifth referred friend to ride earned this bonus free ride (any bike); null = any other code (20261108180000).';
create unique index if not exists promo_codes_referral_bonus_uq on public.promo_codes (referral_bonus_of)
  where referral_bonus_of is not null;

alter table public.referrals add column if not exists device text;
alter table public.referrals add column if not exists held boolean not null default false;
alter table public.referrals add column if not exists reviewed_by uuid;
alter table public.referrals add column if not exists reviewed_at timestamptz;
comment on column public.referrals.device is 'A hash of the app''s id for the browser the link was used in; null = none sent (20261108180000).';
comment on column public.referrals.held is 'One device linked three accounts to the code in a day: no free ride until staff allow it (20261108180000).';

create table if not exists public.push_outbox (
  id          bigint generated always as identity primary key,
  customer_id text not null references public.customers(id) on delete cascade,
  tag         text not null,
  title       text not null,
  body        text not null,
  url         text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  result      text,
  unique (customer_id, tag)
);
comment on table public.push_outbox is
  'Browser notifications waiting to go out, sent by /api/push-send with {drain:true}; one per account and tag (20261108180000).';
create index if not exists push_outbox_waiting_idx on public.push_outbox (id) where sent_at is null;
alter table public.push_outbox enable row level security;
revoke all on public.push_outbox from public, anon, authenticated;


/* -- 2. queueing a notification ------------------------------------------------------------------- */
create or replace function public._push_queue(p_customer text, p_tag text, p_title text, p_body text, p_url text)
 returns void
 language sql
 security definer
 set search_path to 'public'
as $function$
  insert into push_outbox (customer_id, tag, title, body, url)
  values (p_customer, left(p_tag, 64), left(p_title, 120), left(p_body, 300), p_url)
  on conflict (customer_id, tag) do nothing
$function$;
revoke all on function public._push_queue(text, text, text, text, text) from public, anon, authenticated;


/* -- 3, 8. the free ride, now with the held check, the bonus and the notification ---------------- */
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
        insert into promo_codes (id, code, kind, value, active, created_at, applies_to, expires_at, max_uses, uses,
                                 customer_id, ride_kind, referral_friend_id)
        values ('rf-' || p_friend, _code, 'percent', 100, true,
                to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), null,
                (now() at time zone 'Asia/Riyadh')::date + cf.ref_days, 1, 0, _who, 'jcc', p_friend);
      end if;
      update referrals set rode_entry_id = p_entry, rode_at = now(), reward_code = _code, rewarded_at = now()
       where friend_id = p_friend;
      perform _push_queue(_who, 'ref-' || p_friend, 'MicroMobility',
        'A friend you invited rode, so your free ride is ready. | ركب صديق دعوته، وركوبتك المجانية جاهزة.', '/');
    end if;
  end if;
  -- The fifth friend who rode (over the yearly limit too): one bonus free ride on any bike, once per account.
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
            (now() at time zone 'Asia/Riyadh')::date + cf.ref_days, 1, 0, _who, 'jcc', _who)
    on conflict (id) do nothing;
    perform _push_queue(_who, 'ref-bonus', 'MicroMobility',
      'Five friends rode with your invite: a bonus free ride on any bike is yours, Carbon too. | ركب خمسة أصدقاء بدعوتك: لك ركوبة مجانية إضافية على أي دراجة، حتى الكربون.', '/');
  end if;
end $function$;
revoke all on function public._ref_reward(text, text) from public, anon, authenticated;


/* -- 3. the rider's card lists the bonus, which pays for any bike -------------------------------- */
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
                                                             'used', coalesce(c.uses, 0) > 0,
                                                             'any_bike', c.referral_bonus_of is not null) order by c.expires_at)
                           from promo_codes c
                          where c.customer_id = p_id and c.active = true
                            and (c.referral_friend_id is not null or c.referral_bonus_of is not null)),
                        '[]'::jsonb));
end $function$;
revoke all on function public.customer_referral(text, text, boolean) from public;
grant execute on function public.customer_referral(text, text, boolean) to anon, authenticated;


/* -- 8. the device check ------------------------------------------------------------------------ */
drop function if exists public.customer_set_referrer(text, text, text, text);
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
  -- A third account for one code from one device in a day: that device's referrals for the code wait for staff.
  if _dev is not null
     and (select count(*) from referrals where referrer_id = _who and device = _dev and created_at > now() - interval '24 hours') >= 3 then
    update referrals set held = true
     where referrer_id = _who and device = _dev and created_at > now() - interval '24 hours'
       and reward_code is null and reviewed_at is null;
  end if;
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.customer_set_referrer(text, text, text, text, text) from public;
grant execute on function public.customer_set_referrer(text, text, text, text, text) to anon, authenticated;

-- Staff allow a held referral (its free ride then follows the ride already done, if any) or remove it.
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
    return jsonb_build_object('ok', true);
  end if;
  update referrals set held = false, reviewed_by = auth.uid(), reviewed_at = now() where friend_id = p_friend;
  select x.id into q from queue_entries x
   where x.customer_id = p_friend and x.status = 'done' and x.paid is true and x.price > 0
     and _session_kind(x.session_id) = 'jcc'
   order by x.registered_at limit 1;
  if q.id is not null then perform _ref_reward(p_friend, q.id); end if;
  return jsonb_build_object('ok', true, 'rewarded', exists (select 1 from referrals where friend_id = p_friend and reward_code is not null));
end $function$;
revoke all on function public.staff_referral_review(text, boolean) from public, anon;
grant execute on function public.staff_referral_review(text, boolean) to authenticated;


/* -- 2. the week's reminder and the sender's call ----------------------------------------------- */
-- Once per code in its last seven days, and the waiting ones older than three days dropped.
create or replace function public._ref_expiry_tick()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  n integer;
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
  update push_outbox set sent_at = now(), result = 'stale' where sent_at is null and created_at < now() - interval '3 days';
  return n;
end $function$;
revoke all on function public._ref_expiry_tick() from public, anon, authenticated;

create or replace function public._push_drain_call()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if exists (select 1 from push_outbox where sent_at is null and created_at > now() - interval '3 days') then
    perform net.http_post(url := 'https://micromobilityrentals.pages.dev/api/push-send', body := '{"drain":true}'::jsonb,
                          headers := '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds := 20000);
  end if;
end $function$;
revoke all on function public._push_drain_call() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname in ('mm-ref-expiry', 'mm-push-drain');
    perform cron.schedule('mm-ref-expiry', '0 6 * * *', $j$select public._ref_expiry_tick()$j$);
    perform cron.schedule('mm-push-drain', '*/2 * * * *', $j$select public._push_drain_call()$j$);
  end if;
end $cron$;


/* -- 3. the Recruiter badge's levels -------------------------------------------------------------- */
insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort) values
  ('bd_recruiter',    'recruiter',    'people', 'green',  'Recruiter',    'مستقطب',    'A friend you invited finished their first paid ride.',  'أكمل صديق دعوته أول جولة مدفوعة له.',  true, true, 90),
  ('bd_recruiter_3',  'recruiter_3',  'people', 'teal',   'Recruiter 3',  'مستقطب 3',  'Three friends you invited finished a paid ride.',      'أكمل ثلاثة أصدقاء دعوتهم جولة مدفوعة.', true, true, 91),
  ('bd_recruiter_5',  'recruiter_5',  'people', 'purple', 'Recruiter 5',  'مستقطب 5',  'Five friends you invited finished a paid ride.',       'أكمل خمسة أصدقاء دعوتهم جولة مدفوعة.',  true, true, 92),
  ('bd_recruiter_10', 'recruiter_10', 'people', 'gold',   'Recruiter 10', 'مستقطب 10', 'Ten friends you invited finished a paid ride.',        'أكمل عشرة أصدقاء دعوتهم جولة مدفوعة.',  true, true, 93)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true, retired = false, sort = excluded.sort;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261108180000', 'referral_extras')
on conflict (version) do nothing;

commit;
