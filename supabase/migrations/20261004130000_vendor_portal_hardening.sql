-- ============================================================================
-- Vendor portal hardening (the 2026-10-04 audit of the vendor portal, "do all of these").
-- Every function below was copied from production with pg_get_functiondef (2026-10-04) and changed
-- only where these notes say; headers (SECURITY DEFINER, search_path) are kept.
--
--  1. A temporary password must be changed before anything else, on the server too. Every vendor_*
--     function except vendor_me, vendor_set_password and the sign-out ones raises MUST_CHANGE while
--     the login's must_change_pwd is true (before, only the portal page held the venue back).
--     Temporary passwords expire: vendor_users.temp_expires_at is set to now()+72h wherever staff set
--     or reset one (staff_vendor_user_add / _reset); signing in with a temporary password after that
--     answers {"error":"TEMP_EXPIRED"} (the password itself was right, so no failed try is counted).
--     Staff reset it again to send a new one.
--  2. Real sessions. vendor_sessions holds one row per sign-in: the sha256 of a NEW random token
--     (never the token), created / last seen / absolute expiry (30 days) / the browser's user agent.
--     vendor_login makes a new one each time and still answers {id, token, must_change}, so the
--     portal's Worker contract (uid + token in its cookie) is unchanged. _vendor_user checks the
--     token by its hash, the absolute expiry, and the idle limit (14 days since last seen; last_seen
--     is written at most once an hour). RLS on, no grants: only these functions reach it.
--     vendor_logout(uid, token) ends that session; vendor_logout_others(uid, token) ends the login's
--     other sessions. Existing vendor_users.session_token values are moved in (hashed, 30 days) so no
--     venue is signed out by this change, then cleared; session_token is no longer read or written.
--     A password change (vendor_set_password) and a staff reset / deactivation end every session of
--     that login (the change starts a fresh one for the device that made it).
--  3. A gate secret, dormant until the owner sets it. vendor_gate holds at most one row, the sha256
--     (hex) of a secret the portal's Worker sends as the header x-vendor-gate. While a row exists,
--     vendor_login (and only it) refuses a request whose header does not hash to it (FORBIDDEN), so
--     the anon key alone cannot try passwords against the database. No row: as before.
--     To switch it on (owner):
--        1) make a long random secret, e.g.  openssl rand -hex 32
--        2) cd apps/vendors && npx wrangler secret put VENDOR_GATE_SECRET      (paste it; production)
--           and the same with --env staging for staging's database
--        3) in the SQL editor:  insert into public.vendor_gate (secret_hash)
--                                values (encode(sha256(convert_to('<the secret>', 'UTF8')), 'hex'));
--     Order: the Worker secret FIRST, then the row (the other way round refuses every sign-in
--     until the secret is in place). To switch it off: delete from public.vendor_gate;
--  4. Password policy (NIST SP 800-63B): 10 to 200 characters, no composition rules, refused when it
--     holds the login's email name or phone digits or the venue's name (COMMON_PASSWORD /
--     PERSONAL_PASSWORD, WEAK_PASSWORD for the length), or is on a short list of common passwords.
--     vendor_set_password now ANSWERS jsonb: {"token": "<new session token>"} on success, or
--     {"error":"BAD_PASSWORD"} for a wrong current password, which is counted in login_throttle
--     under the login's own key ('vendor:<login>'), the same lock sign-in uses (8 tries, 15 minutes);
--     a raise would roll the count back. The other refusals still raise. (The return type changed
--     from text, so the function is dropped and recreated; the portal reads both shapes.)
--  5. vendor_profile_save checks what it writes: contact name at most 120, contact phone normalised
--     to E.164 ("+" and 8 to 15 digits; a Saudi 05xxxxxxxx / 5xxxxxxxx becomes +9665xxxxxxxx;
--     BAD_PHONE), email shape and at most 200 (BAD_EMAIL), offers at most 1000, map link at most 500.
--     CHECK constraints on vendor_venues back the lengths (NOT VALID: they hold every new write).
--  6. The ride's breakfast stop carries the venue's Arabic name and its offer: sessions gets
--     breakfast_name_ar, breakfast_offer_en, breakfast_offer_ar; _vendor_sync_day and the insert
--     trigger copy them with the name and clear them with it. A staff edit that changes the
--     breakfast name by hand (and not these) clears them (trigger _vendor_session_bf_guard), so a
--     hand-typed stop never shows another venue's offer.
--  7. vendor_calendar adds, per date: ride_time (the Saturday ride's _time from bike_slots,
--     "gathering - start"), riders on pending AND confirmed dates (the live bookings on that
--     Saturday's social ride), decide_by on a pending request (the date less the plan's notice days,
--     the same min_lead_days vendor_preview/request judge by), others_pending (how many OTHER venues
--     wait on the same date; a number only, never a name) and declined (the venue's own latest
--     request on the date was declined or cancelled and none is live). mine carries cancelled_by,
--     cancel_reason and late_cancel.
--  8. Late cancellation: vendor_cancel on a confirmed date less than 48 hours before the date starts
--     (Riyadh midnight) needs a reason (LATE_REASON when empty) and records late_cancel = true (the
--     plan's cutoff still counts as late as before). Staff read late_cancel (VENDOR_BK_COLS).
--  9. Roles: vendor_users.role owner | manager | viewer. owner: everything (profile, cancelling a
--     whole pattern, the team list); manager: request, feedback, cancel single dates; viewer: read
--     only. Each function checks (FORBIDDEN). vendor_team(uid, token) lists the venue's logins for
--     its owners (no password, no token).
--
-- Deploy: this SQL FIRST, then the portal (apps/vendors in mm-platform), which reads the new answers.
-- The rentals staff page reads late_cancel already and the new sessions columns only through
-- select('*'), so it works before and after.
-- ============================================================================
begin;

-- ── tables ─────────────────────────────────────────────────────────────────────────────────────
alter table public.vendor_users add column if not exists temp_expires_at timestamptz;
alter table public.vendor_users drop constraint if exists vendor_users_role_check;
alter table public.vendor_users add constraint vendor_users_role_check check (role = any (array['owner','manager','viewer']));

create table if not exists public.vendor_sessions (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references public.vendor_users(id) on delete cascade,
  token_hash  bytea  not null unique,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  expires_at  timestamptz not null,
  user_agent  text not null default '' check (length(user_agent) <= 300)
);
create index if not exists vendor_sessions_user_idx on public.vendor_sessions(user_id);
alter table public.vendor_sessions enable row level security;
revoke all on table public.vendor_sessions from public, anon, authenticated;

create table if not exists public.vendor_gate (
  one         boolean primary key default true check (one),
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now()
);
alter table public.vendor_gate enable row level security;
revoke all on table public.vendor_gate from public, anon, authenticated;

alter table public.vendor_venues drop constraint if exists vendor_venues_contact_name_len;
alter table public.vendor_venues add constraint vendor_venues_contact_name_len check (length(contact_name) <= 120) not valid;
alter table public.vendor_venues drop constraint if exists vendor_venues_contact_phone_len;
alter table public.vendor_venues add constraint vendor_venues_contact_phone_len check (length(contact_phone) <= 40) not valid;
alter table public.vendor_venues drop constraint if exists vendor_venues_contact_email_len;
alter table public.vendor_venues add constraint vendor_venues_contact_email_len check (length(contact_email) <= 200) not valid;
alter table public.vendor_venues drop constraint if exists vendor_venues_map_url_len;
alter table public.vendor_venues add constraint vendor_venues_map_url_len check (length(map_url) <= 500) not valid;

alter table public.sessions add column if not exists breakfast_name_ar text;
alter table public.sessions add column if not exists breakfast_offer_en text;
alter table public.sessions add column if not exists breakfast_offer_ar text;

-- The existing sign-ins move into vendor_sessions (hashed, 30 days), then the plain tokens go.
insert into public.vendor_sessions (user_id, token_hash, expires_at)
select u.id, sha256(convert_to(u.session_token, 'UTF8')), now() + interval '30 days'
  from public.vendor_users u
 where coalesce(u.session_token, '') <> ''
on conflict (token_hash) do nothing;
update public.vendor_users set session_token = null where session_token is not null;


-- ── helpers ────────────────────────────────────────────────────────────────────────────────────
-- The signed-in login behind (uid, token), or BAD_TOKEN; MUST_CHANGE unless p_allow_must.
create or replace function public._vendor_auth(p_uid bigint, p_token text, p_allow_must boolean default false)
 returns vendor_users
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u vendor_users%rowtype; s vendor_sessions%rowtype;
begin
  if p_uid is null or coalesce(p_token, '') = '' or length(p_token) > 200 then
    raise exception 'BAD_TOKEN' using errcode = '28000';
  end if;
  select * into s from vendor_sessions x
   where x.token_hash = sha256(convert_to(p_token, 'UTF8')) and x.user_id = p_uid;
  if not found or s.expires_at <= now() or s.last_seen < now() - interval '14 days' then
    raise exception 'BAD_TOKEN' using errcode = '28000';
  end if;
  select x.* into u from vendor_users x join vendor_venues v on v.id = x.venue_id
   where x.id = p_uid and x.active and v.status <> 'ended';
  if not found then raise exception 'BAD_TOKEN' using errcode = '28000'; end if;
  if s.last_seen < now() - interval '1 hour' then
    update vendor_sessions set last_seen = now() where id = s.id;
  end if;
  if u.must_change_pwd and not coalesce(p_allow_must, false) then
    raise exception 'MUST_CHANGE' using errcode = 'P0001';
  end if;
  return u;
end $function$;
revoke all on function public._vendor_auth(bigint, text, boolean) from public, anon, authenticated;

-- Every portal function that acts on the venue's data: a real session, the password already changed.
create or replace function public._vendor_user(p_uid bigint, p_token text)
 returns vendor_users
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  return _vendor_auth(p_uid, p_token, false);
end $function$;
revoke all on function public._vendor_user(bigint, text) from public, anon, authenticated;

-- FORBIDDEN unless the login's role is one of p_roles.
create or replace function public._vendor_role(u vendor_users, p_roles text[])
 returns void
 language plpgsql
 immutable
 set search_path to 'public'
as $function$
begin
  if not (coalesce(u.role, '') = any (p_roles)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
end $function$;
revoke all on function public._vendor_role(vendor_users, text[]) from public, anon, authenticated;

-- A phone as E.164 ("+" and 8-15 digits), Saudi numbers without the country code made whole;
-- '' stays ''; anything else is null (the caller refuses it).
create or replace function public._vendor_phone(p text)
 returns text
 language plpgsql
 immutable
 set search_path to 'public'
as $function$
declare raw text := trim(coalesce(p, '')); d text;
begin
  if raw = '' then return ''; end if;
  if raw !~ '^[0-9+()\s.-]+$' then return null; end if;
  d := regexp_replace(raw, '\D', '', 'g');
  if left(raw, 1) <> '+' and left(d, 2) = '00' then d := substr(d, 3);
  elsif left(raw, 1) <> '+' and d ~ '^05[0-9]{8}$' then d := '966' || substr(d, 2);
  elsif left(raw, 1) <> '+' and d ~ '^5[0-9]{8}$' then d := '966' || d;
  end if;
  if d !~ '^[1-9][0-9]{7,14}$' then return null; end if;
  return '+' || d;
end $function$;
revoke all on function public._vendor_phone(text) from public, anon, authenticated;

-- Why a new password is refused ('' when it is fine): NIST SP 800-63B, no composition rules.
create or replace function public._vendor_pwd_problem(p_new text, p_login text, p_venue bigint)
 returns text
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
  pw text := lower(coalesce(p_new, ''));
  bare text := regexp_replace(lower(coalesce(p_new, '')), '[^[:alnum:]]', '', 'g');
  digits text := regexp_replace(coalesce(p_new, ''), '\D', '', 'g');
  lg text := lower(coalesce(p_login, ''));
  part text; v vendor_venues%rowtype;
begin
  if char_length(coalesce(p_new, '')) < 10 or char_length(p_new) > 200 then return 'WEAK_PASSWORD'; end if;
  if pw ~ '^(.)\1*$' or bare in (
       'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd',
       '123456789', '1234567890', '12345678910', '0123456789', '0987654321', '1122334455', '1111111111',
       'qwerty', 'qwerty123', 'qwertyuiop', 'qwerty12345', 'asdfghjkl', '1q2w3e4r5t', 'zaq12wsx', 'abc123456',
       'iloveyou', 'letmein', 'welcome', 'welcome123', 'welcome2026', 'admin', 'admin12345', 'administrator',
       'micromobility', 'micromobility1', 'micromobility123', 'micromobility2026', 'vendors', 'vendor123',
       'breakfast', 'breakfast123', 'restaurant', 'restaurant1', 'cafe123456', 'saudiarabia', 'riyadh123',
       'jeddah123', 'dammam123', 'khobar123', 'changeme', 'changeme123', 'temppassword', 'football',
       'princess', 'sunshine', 'dragon', 'monkey', 'master', 'superman', 'trustno1') then
    return 'COMMON_PASSWORD';
  end if;
  -- the login's own name: the email's part before @, or the phone's digits (the last nine too)
  if position('@' in lg) > 0 then
    part := split_part(lg, '@', 1);
    if length(part) >= 3 and position(part in pw) > 0 then return 'PERSONAL_PASSWORD'; end if;
  else
    part := regexp_replace(lg, '\D', '', 'g');
    if length(part) >= 7 and (position(part in digits) > 0 or position(right(part, 9) in digits) > 0) then
      return 'PERSONAL_PASSWORD';
    end if;
  end if;
  select * into v from vendor_venues where id = p_venue;
  if found then
    foreach part in array array[lower(trim(v.name)), lower(trim(v.name_ar)),
                                regexp_replace(lower(v.name), '[^[:alnum:]]', '', 'g'),
                                regexp_replace(lower(v.name_ar), '[^[:alnum:]]', '', 'g')] loop
      if length(coalesce(part, '')) >= 3 and (position(part in pw) > 0 or position(part in bare) > 0) then
        return 'PERSONAL_PASSWORD';
      end if;
    end loop;
  end if;
  return '';
end $function$;
revoke all on function public._vendor_pwd_problem(text, text, bigint) from public, anon, authenticated;

-- The Saturday social ride on a day: its _time ("gathering - start"), and its live bookings.
create or replace function public._vendor_ride_time(p_day date)
 returns text
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare raw text;
begin
  select s.bike_slots into raw from sessions s
   where s.session_date = p_day::text and s.event_kind = 'community'
     and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.status <> 'deleted'
   order by s.id limit 1;
  if raw is null then return null; end if;
  begin
    return nullif(left(regexp_replace(trim(raw::jsonb ->> '_time'), '[<>"''&`]', '', 'g'), 40), '');
  exception when others then
    return null;
  end;
end $function$;
revoke all on function public._vendor_ride_time(date) from public, anon, authenticated;

create or replace function public._vendor_riders(p_day date)
 returns integer
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select count(*)::int from queue_entries q join sessions s on s.id = q.session_id
   where s.session_date = p_day::text and s.event_kind = 'community'
     and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.status <> 'deleted'
     and q.status in ('waiting','done') and coalesce(q.approval, '') <> 'rejected'
$function$;
revoke all on function public._vendor_riders(date) from public, anon, authenticated;


-- ── 2/3. sign in, sign out ─────────────────────────────────────────────────────────────────────
create or replace function public.vendor_login(p_login text, p_pwd text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare k text := _vendor_login_key(p_login); u vendor_users%rowtype; thr login_throttle%rowtype; nf int; tok text;
        gate text; hdr text; ua text;
begin
  -- the gate (dormant while vendor_gate is empty): only the portal's Worker knows the secret
  select secret_hash into gate from vendor_gate limit 1;
  if gate is not null then
    begin
      hdr := current_setting('request.headers', true)::json ->> 'x-vendor-gate';
    exception when others then hdr := null;
    end;
    if hdr is null or encode(sha256(convert_to(hdr, 'UTF8')), 'hex') <> gate then
      raise exception 'FORBIDDEN' using errcode = '42501';
    end if;
  end if;
  if k is null or coalesce(p_pwd, '') = '' then raise exception 'BAD_LOGIN' using errcode = '28000'; end if;
  select * into thr from login_throttle where identifier = 'vendor:' || k;
  if thr.locked_until is not null and thr.locked_until > now() then raise exception 'LOCKED' using errcode = 'P0001'; end if;
  select x.* into u from vendor_users x join vendor_venues v on v.id = x.venue_id
   where x.login = k and x.active and v.status <> 'ended';
  if not found or u.password_hash is null or crypt(p_pwd, u.password_hash) <> u.password_hash then
    nf := (case when (thr.locked_until is not null and thr.locked_until <= now()) or thr.updated_at < now() - interval '1 day'
                then 0 else coalesce(thr.fails, 0) end) + 1;
    insert into login_throttle(identifier, fails, locked_until, updated_at)
      values ('vendor:' || k, nf, case when nf >= 8 then now() + interval '15 minutes' end, now())
      on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
    return jsonb_build_object('error', 'BAD_LOGIN');
  end if;
  delete from login_throttle where identifier = 'vendor:' || k;
  -- a temporary password lasts 72 hours; staff send a new one after that
  if u.must_change_pwd and u.temp_expires_at is not null and u.temp_expires_at < now() then
    return jsonb_build_object('error', 'TEMP_EXPIRED');
  end if;
  begin
    ua := left(coalesce(current_setting('request.headers', true)::json ->> 'user-agent', ''), 300);
  exception when others then ua := '';
  end;
  tok := encode(gen_random_bytes(32), 'hex');
  delete from vendor_sessions where user_id = u.id and (expires_at <= now() or last_seen < now() - interval '14 days');
  -- at most ten devices at once: the oldest goes
  delete from vendor_sessions where id in (select id from vendor_sessions where user_id = u.id order by last_seen desc offset 9);
  insert into vendor_sessions (user_id, token_hash, expires_at, user_agent)
  values (u.id, sha256(convert_to(tok, 'UTF8')), now() + interval '30 days', ua);
  update vendor_users set last_login_at = now() where id = u.id;
  return jsonb_build_object('id', u.id, 'token', tok, 'must_change', u.must_change_pwd);
end $function$;
revoke all on function public.vendor_login(text, text) from public;
grant execute on function public.vendor_login(text, text) to anon, authenticated;

create or replace function public.vendor_logout(p_uid text, p_token text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(p_uid, '') !~ '^[0-9]{1,18}$' or coalesce(p_token, '') = '' or length(p_token) > 200 then return; end if;
  delete from vendor_sessions
   where user_id = p_uid::bigint and token_hash = sha256(convert_to(p_token, 'UTF8'));
end $function$;
revoke all on function public.vendor_logout(text, text) from public;
grant execute on function public.vendor_logout(text, text) to anon, authenticated;

-- Signs the login out everywhere else; the answer is how many sessions ended.
create or replace function public.vendor_logout_others(p_uid bigint, p_token text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u vendor_users%rowtype := _vendor_auth(p_uid, p_token, true); n int;
begin
  delete from vendor_sessions where user_id = u.id and token_hash <> sha256(convert_to(p_token, 'UTF8'));
  get diagnostics n = row_count;
  return n;
end $function$;
revoke all on function public.vendor_logout_others(bigint, text) from public;
grant execute on function public.vendor_logout_others(bigint, text) to anon, authenticated;


-- ── 1/4. the signed-in login, the password ─────────────────────────────────────────────────────
create or replace function public.vendor_me(p_uid bigint, p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u vendor_users%rowtype := _vendor_auth(p_uid, p_token, true); v vendor_venues%rowtype; t vendor_tiers%rowtype;
begin
  select * into v from vendor_venues where id = u.venue_id;
  select * into t from vendor_tiers where id = v.tier_id;
  return jsonb_build_object(
    'user', jsonb_build_object('id', u.id, 'name', u.name, 'login', u.login, 'role', u.role, 'must_change', u.must_change_pwd,
                               'sessions', (select count(*) from vendor_sessions s where s.user_id = u.id and s.expires_at > now()
                                              and s.last_seen > now() - interval '14 days')),
    'venue', to_jsonb(v) - 'staff_notes' - 'created_by',
    'tier', to_jsonb(t),
    'today', _vendor_today(),
    'series', coalesce((select jsonb_agg(to_jsonb(s) - 'requested_by' order by s.starts_on) from vendor_series s
                         where s.venue_id = v.id and s.status = 'active' and s.until >= _vendor_today()), '[]'::jsonb));
end $function$;
revoke all on function public.vendor_me(bigint, text) from public;
grant execute on function public.vendor_me(bigint, text) to anon, authenticated;

drop function if exists public.vendor_set_password(bigint, text, text, text);
create function public.vendor_set_password(p_uid bigint, p_token text, p_new text, p_old text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare u vendor_users%rowtype := _vendor_auth(p_uid, p_token, true); tok text; why text;
        thr login_throttle%rowtype; nf int; ua text;
begin
  if not u.must_change_pwd then
    select * into thr from login_throttle where identifier = 'vendor:' || u.login;
    if thr.locked_until is not null and thr.locked_until > now() then raise exception 'LOCKED' using errcode = 'P0001'; end if;
    if p_old is null or crypt(p_old, u.password_hash) <> u.password_hash then
      -- answered, not raised: a raise would roll the count back
      nf := (case when (thr.locked_until is not null and thr.locked_until <= now()) or thr.updated_at < now() - interval '1 day'
                  then 0 else coalesce(thr.fails, 0) end) + 1;
      insert into login_throttle(identifier, fails, locked_until, updated_at)
        values ('vendor:' || u.login, nf, case when nf >= 8 then now() + interval '15 minutes' end, now())
        on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
      return jsonb_build_object('error', 'BAD_PASSWORD');
    end if;
    delete from login_throttle where identifier = 'vendor:' || u.login;
  end if;
  why := _vendor_pwd_problem(p_new, u.login, u.venue_id);
  if why <> '' then raise exception '%', why using errcode = '22023'; end if;
  if crypt(p_new, u.password_hash) = u.password_hash then raise exception 'SAME_PASSWORD' using errcode = '22023'; end if;
  begin
    ua := left(coalesce(current_setting('request.headers', true)::json ->> 'user-agent', ''), 300);
  exception when others then ua := '';
  end;
  -- every device is signed out; this one gets a fresh session
  delete from vendor_sessions where user_id = u.id;
  tok := encode(gen_random_bytes(32), 'hex');
  insert into vendor_sessions (user_id, token_hash, expires_at, user_agent)
  values (u.id, sha256(convert_to(tok, 'UTF8')), now() + interval '30 days', ua);
  update vendor_users set password_hash = crypt(p_new, gen_salt('bf')), session_token = null,
         must_change_pwd = false, temp_expires_at = null where id = u.id;
  return jsonb_build_object('token', tok);
end $function$;
revoke all on function public.vendor_set_password(bigint, text, text, text) from public;
grant execute on function public.vendor_set_password(bigint, text, text, text) to anon, authenticated;

-- The venue's logins, for its owners: who, which role, when they last signed in. No secrets.
create or replace function public.vendor_team(p_uid bigint, p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token);
begin
  perform _vendor_role(u, array['owner']);
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'login', x.login, 'role', x.role,
                                                        'active', x.active, 'last_login_at', x.last_login_at, 'me', x.id = u.id)
                                    order by x.active desc, x.role, x.created_at)
                     from vendor_users x where x.venue_id = u.venue_id), '[]'::jsonb);
end $function$;
revoke all on function public.vendor_team(bigint, text) from public;
grant execute on function public.vendor_team(bigint, text) to anon, authenticated;


-- ── 5. the venue's own details ─────────────────────────────────────────────────────────────────
create or replace function public.vendor_profile_save(p_uid bigint, p_token text, p_data jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token);
        cn text; cp text; ce text; oe text; oa text; mu text;
begin
  perform _vendor_role(u, array['owner']);
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  cn := case when p_data ? 'contact_name' then trim(coalesce(p_data ->> 'contact_name', '')) end;
  if length(cn) > 120 then raise exception 'TOO_LONG' using errcode = '22023'; end if;
  if p_data ? 'contact_phone' then
    cp := _vendor_phone(p_data ->> 'contact_phone');
    if cp is null or length(cp) > 20 then raise exception 'BAD_PHONE' using errcode = '22023'; end if;
  end if;
  ce := case when p_data ? 'contact_email' then lower(trim(coalesce(p_data ->> 'contact_email', ''))) end;
  if ce <> '' and (length(ce) > 200 or ce !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'BAD_EMAIL' using errcode = '22023';
  end if;
  oe := case when p_data ? 'offer_en' then trim(coalesce(p_data ->> 'offer_en', '')) end;
  oa := case when p_data ? 'offer_ar' then trim(coalesce(p_data ->> 'offer_ar', '')) end;
  if length(oe) > 1000 or length(oa) > 1000 then raise exception 'TOO_LONG' using errcode = '22023'; end if;
  mu := case when p_data ? 'map_url' then trim(coalesce(p_data ->> 'map_url', '')) end;
  if length(mu) > 500 then raise exception 'TOO_LONG' using errcode = '22023'; end if;
  update vendor_venues set
    map_url       = coalesce(mu, map_url),
    seats         = case when p_data ? 'seats' then nullif(p_data ->> 'seats', '')::int else seats end,
    contact_name  = coalesce(cn, contact_name),
    contact_phone = coalesce(cp, contact_phone),
    contact_email = coalesce(ce, contact_email),
    offer_en      = coalesce(oe, offer_en),
    offer_ar      = coalesce(oa, offer_ar),
    updated_at    = now()
   where id = u.venue_id;
  -- the offer rides on the venue's confirmed Saturdays still ahead
  perform _vendor_sync_day(b.day) from vendor_bookings b
   where b.venue_id = u.venue_id and b.status = 'confirmed' and b.day >= _vendor_today();
end $function$;
revoke all on function public.vendor_profile_save(bigint, text, jsonb) from public;
grant execute on function public.vendor_profile_save(bigint, text, jsonb) to anon, authenticated;


-- ── 6. the ride's breakfast stop: name, Arabic name, offer ─────────────────────────────────────
create or replace function public._vendor_sync_day(p_day date)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v vendor_venues%rowtype; old_name text;
begin
  perform set_config('vendor.sync', '1', true);
  select synced_name into old_name from vendor_dates where day = p_day;
  select ve.* into v from vendor_bookings b join vendor_venues ve on ve.id = b.venue_id
   where b.day = p_day and b.status = 'confirmed' order by b.decided_at nulls last, b.id limit 1;
  if found then
    update sessions s set breakfast_name = v.name, breakfast_url = nullif(v.map_url, ''),
           breakfast_name_ar = nullif(trim(v.name_ar), ''), breakfast_offer_en = nullif(trim(v.offer_en), ''),
           breakfast_offer_ar = nullif(trim(v.offer_ar), '')
     where s.session_date = p_day::text and s.event_kind = 'community'
       and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.status <> 'deleted'
       and (s.breakfast_name is distinct from v.name or s.breakfast_url is distinct from nullif(v.map_url, '')
            or s.breakfast_name_ar is distinct from nullif(trim(v.name_ar), '')
            or s.breakfast_offer_en is distinct from nullif(trim(v.offer_en), '')
            or s.breakfast_offer_ar is distinct from nullif(trim(v.offer_ar), ''));
    update vendor_dates set synced_name = v.name where day = p_day;
  elsif old_name is not null then
    update sessions s set breakfast_name = null, breakfast_url = null,
           breakfast_name_ar = null, breakfast_offer_en = null, breakfast_offer_ar = null
     where s.session_date = p_day::text and s.event_kind = 'community'
       and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.breakfast_name = old_name;
    update vendor_dates set synced_name = null where day = p_day;
  end if;
  perform set_config('vendor.sync', '', true);
end $function$;
revoke all on function public._vendor_sync_day(date) from public, anon, authenticated;

create or replace function public._vendor_session_fill()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v vendor_venues%rowtype; d date := _safe_date(new.session_date);
begin
  if new.event_kind = 'community' and coalesce(new.ride_kind, 'saturday') = 'saturday' and d is not null then
    select ve.* into v from vendor_bookings b join vendor_venues ve on ve.id = b.venue_id
     where b.day = d and b.status = 'confirmed'
     order by b.decided_at nulls last, b.id limit 1;
    if found then
      new.breakfast_name := v.name;
      new.breakfast_url := nullif(v.map_url, '');
      new.breakfast_name_ar := nullif(trim(v.name_ar), '');
      new.breakfast_offer_en := nullif(trim(v.offer_en), '');
      new.breakfast_offer_ar := nullif(trim(v.offer_ar), '');
      update vendor_dates set synced_name = v.name where day = d;
    end if;
  end if;
  return new;
end $function$;
revoke all on function public._vendor_session_fill() from public, anon, authenticated;

-- A breakfast name changed by hand (not by _vendor_sync_day, and without the Arabic name or offer
-- in the same write) drops the venue's Arabic name and offer, which belonged to the old stop.
create or replace function public._vendor_session_bf_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if new.breakfast_name is distinct from old.breakfast_name
     and coalesce(current_setting('vendor.sync', true), '') <> '1'
     and new.breakfast_name_ar is not distinct from old.breakfast_name_ar
     and new.breakfast_offer_en is not distinct from old.breakfast_offer_en
     and new.breakfast_offer_ar is not distinct from old.breakfast_offer_ar then
    new.breakfast_name_ar := null;
    new.breakfast_offer_en := null;
    new.breakfast_offer_ar := null;
  end if;
  return new;
end $function$;
revoke all on function public._vendor_session_bf_guard() from public, anon, authenticated;
drop trigger if exists sessions_vendor_bf_guard on public.sessions;
create trigger sessions_vendor_bf_guard before update of breakfast_name on public.sessions
  for each row execute function public._vendor_session_bf_guard();

-- The dates already confirmed get the Arabic name and offer now.
do $sync$
declare d date;
begin
  for d in select distinct b.day from public.vendor_bookings b where b.status = 'confirmed' and b.day >= public._vendor_today() loop
    perform public._vendor_sync_day(d);
  end loop;
end $sync$;


-- ── 7. the calendar ────────────────────────────────────────────────────────────────────────────
create or replace function public.vendor_calendar(p_uid bigint, p_token text, p_from date, p_to date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token); today date := _vendor_today(); lead int;
begin
  if p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_RANGE' using errcode = '22023'; end if;
  select t.min_lead_days into lead from vendor_venues v join vendor_tiers t on t.id = v.tier_id where v.id = u.venue_id;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'day', d.day, 'state', d.state, 'reason', case when d.state = 'closed' then d.reason else '' end,
      'mine', m.j,
      'taken', (select count(*) from vendor_bookings b where b.day = d.day and b.status = 'confirmed'
                                                       and b.venue_id <> u.venue_id) >= d.capacity,
      'riders', case when m.live then _vendor_riders(d.day) end,
      'ride_time', case when m.live then _vendor_ride_time(d.day) end,
      'decide_by', case when m.status = 'pending' then d.day - coalesce(lead, 0) end,
      'others_pending', case when m.status = 'pending'
                             then (select count(*) from vendor_bookings b where b.day = d.day and b.status = 'pending'
                                                                          and b.venue_id <> u.venue_id) end,
      'declined', coalesce(m.status in ('declined','cancelled'), false)
    ) order by d.day)
    from vendor_dates d
    left join lateral (
      select b.status, b.status in ('pending','confirmed') as live,
             jsonb_build_object('id', b.id, 'status', b.status, 'kind', b.kind, 'series_id', b.series_id,
                                'note', b.note, 'staff_note', b.staff_note,
                                'cancelled_by', b.cancelled_by, 'cancel_reason', b.cancel_reason, 'late_cancel', b.late_cancel,
                                'feedback', (select to_jsonb(f) - 'submitted_by' from vendor_feedback f where f.booking_id = b.id),
                                'feedback_open', b.status = 'confirmed' and today between b.day and b.day + 14) as j
        from vendor_bookings b where b.day = d.day and b.venue_id = u.venue_id
       order by (b.status in ('pending','confirmed')) desc, b.updated_at desc limit 1) m on true
    where d.day between p_from and p_to), '[]'::jsonb);
end $function$;
revoke all on function public.vendor_calendar(bigint, text, date, date) from public;
grant execute on function public.vendor_calendar(bigint, text, date, date) to anon, authenticated;

-- (VOLATILE now, like vendor_calendar and vendor_me: the session check may write last_seen, and
-- PostgREST runs a STABLE function in a read-only transaction.)
create or replace function public.vendor_preview(p_uid bigint, p_token text, p_mode text, p_days date[] default null::date[], p_ordinal integer default null::integer, p_interval integer default 1, p_from date default null::date, p_until date default null::date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token);
begin
  perform _vendor_role(u, array['owner','manager']);
  if p_mode not in ('single','multi','recurring') then raise exception 'BAD_MODE' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('day', c.day, 'verdict', c.verdict, 'reason', c.reason) order by c.day)
                     from _vendor_check(u.venue_id, p_mode, p_days, p_ordinal, p_interval, p_from, p_until) c), '[]'::jsonb);
end $function$;
revoke all on function public.vendor_preview(bigint, text, text, date[], integer, integer, date, date) from public;
grant execute on function public.vendor_preview(bigint, text, text, date[], integer, integer, date, date) to anon, authenticated;

create or replace function public.vendor_shared_ratings_mine(p_uid bigint, p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('booking_id', r.booking_id, 'day', r.day, 'riders', r.riders,
                                                       'averages', r.averages, 'comments', r.comments, 'shared_at', r.shared_at)
                                    order by r.day desc)
                     from vendor_shared_ratings r where r.venue_id = u.venue_id), '[]'::jsonb);
end $function$;
revoke all on function public.vendor_shared_ratings_mine(bigint, text) from public;
grant execute on function public.vendor_shared_ratings_mine(bigint, text) to anon, authenticated;


-- ── 9. roles on the writes ─────────────────────────────────────────────────────────────────────
create or replace function public.vendor_request(p_uid bigint, p_token text, p_mode text, p_days date[] default null::date[], p_ordinal integer default null::integer, p_interval integer default 1, p_from date default null::date, p_until date default null::date, p_note text default ''::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token); sid bigint; res jsonb := '[]'::jsonb; c record; n int := 0;
begin
  perform _vendor_role(u, array['owner','manager']);
  if p_mode not in ('single','multi','recurring') then raise exception 'BAD_MODE' using errcode = '22023'; end if;
  perform 1 from vendor_venues where id = u.venue_id for update;
  perform set_config('vendor.actor', 'venue:' || u.id, true);
  if p_mode = 'recurring' then
    insert into vendor_series (venue_id, ordinal, interval_months, starts_on, until, requested_by)
    values (u.venue_id, p_ordinal, coalesce(p_interval, 1), greatest(p_from, _vendor_today()), p_until, u.id) returning id into sid;
  end if;
  for c in select * from _vendor_check(u.venue_id, p_mode, p_days, p_ordinal, p_interval, p_from, p_until) loop
    if c.verdict = 'ok' then
      insert into vendor_bookings (venue_id, day, series_id, kind, note, requested_by)
      values (u.venue_id, c.day, sid, p_mode, left(coalesce(p_note, ''), 500), u.id);
      n := n + 1;
    end if;
    res := res || jsonb_build_object('day', c.day, 'verdict', c.verdict, 'reason', c.reason);
  end loop;
  if n = 0 and sid is not null then delete from vendor_series where id = sid; sid := null; end if;
  return jsonb_build_object('requested', n, 'series_id', sid, 'days', res);
end $function$;
revoke all on function public.vendor_request(bigint, text, text, date[], integer, integer, date, date, text) from public;
grant execute on function public.vendor_request(bigint, text, text, date[], integer, integer, date, date, text) to anon, authenticated;

create or replace function public.vendor_feedback_save(p_uid bigint, p_token text, p_booking bigint, p_rating integer, p_turnout integer default null::integer, p_went_well text default ''::text, p_improve text default ''::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token); b vendor_bookings%rowtype; today date := _vendor_today(); f vendor_feedback%rowtype;
begin
  perform _vendor_role(u, array['owner','manager']);
  select * into b from vendor_bookings where id = p_booking and venue_id = u.venue_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if b.status <> 'confirmed' then raise exception 'NOT_CONFIRMED' using errcode = 'P0001'; end if;
  if today < b.day then raise exception 'TOO_EARLY' using errcode = 'P0001'; end if;
  if today > b.day + 14 then raise exception 'TOO_LATE' using errcode = 'P0001'; end if;
  if p_rating is null or p_rating not between 1 and 5 then raise exception 'BAD_RATING' using errcode = '22023'; end if;
  insert into vendor_feedback as x (booking_id, venue_id, day, rating, turnout, went_well, improve, submitted_by)
  values (b.id, b.venue_id, b.day, p_rating, p_turnout, left(coalesce(p_went_well, ''), 1000), left(coalesce(p_improve, ''), 1000), u.id)
  on conflict (booking_id) do update set rating = excluded.rating, turnout = excluded.turnout,
     went_well = excluded.went_well, improve = excluded.improve, submitted_by = excluded.submitted_by, updated_at = now()
  returning * into f;
  return to_jsonb(f) - 'submitted_by';
end $function$;
revoke all on function public.vendor_feedback_save(bigint, text, bigint, integer, integer, text, text) from public;
grant execute on function public.vendor_feedback_save(bigint, text, bigint, integer, integer, text, text) to anon, authenticated;

-- ── 8. late cancellation ───────────────────────────────────────────────────────────────────────
create or replace function public.vendor_cancel(p_uid bigint, p_token text, p_booking bigint, p_reason text default ''::text, p_series boolean default false)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare u vendor_users%rowtype := _vendor_user(p_uid, p_token); b vendor_bookings%rowtype; cut int; r record; n int := 0;
        why text := left(trim(coalesce(p_reason, '')), 300);
begin
  perform _vendor_role(u, case when p_series then array['owner'] else array['owner','manager'] end);
  select * into b from vendor_bookings where id = p_booking and venue_id = u.venue_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select t.cancel_cutoff_days into cut from vendor_venues v join vendor_tiers t on t.id = v.tier_id where v.id = u.venue_id;
  perform set_config('vendor.actor', 'venue:' || u.id, true);
  -- a confirmed breakfast less than 48 hours away is only cancelled with a reason
  if why = '' and exists (
       select 1 from vendor_bookings x
        where x.venue_id = u.venue_id and x.status = 'confirmed' and x.day >= _vendor_today()
          and (x.id = b.id or (p_series and b.series_id is not null and x.series_id = b.series_id and x.day >= b.day))
          and (x.day::timestamp at time zone 'Asia/Riyadh') < now() + interval '48 hours') then
    raise exception 'LATE_REASON' using errcode = 'P0001';
  end if;
  for r in select * from vendor_bookings x
            where x.venue_id = u.venue_id and x.status in ('pending','confirmed') and x.day >= _vendor_today()
              and (x.id = b.id or (p_series and b.series_id is not null and x.series_id = b.series_id and x.day >= b.day))
            for update loop
    update vendor_bookings set status = 'cancelled', cancelled_by = 'venue', cancel_reason = why,
           late_cancel = (r.status = 'confirmed' and (r.day < _vendor_today() + cut
                          or (r.day::timestamp at time zone 'Asia/Riyadh') < now() + interval '48 hours')),
           updated_at = now()
     where id = r.id;
    if r.status = 'confirmed' then perform _vendor_sync_day(r.day); end if;
    n := n + 1;
  end loop;
  if p_series and b.series_id is not null then
    update vendor_series set status = 'ended', until = greatest(starts_on, least(until, b.day - 1)) where id = b.series_id;
  end if;
  return n;
end $function$;
revoke all on function public.vendor_cancel(bigint, text, bigint, text, boolean) from public;
grant execute on function public.vendor_cancel(bigint, text, bigint, text, boolean) to anon, authenticated;


-- ── staff: logins (temporary passwords expire, sessions end) ───────────────────────────────────
create or replace function public.staff_vendor_user_add(p_venue bigint, p_login text, p_name text, p_role text default 'manager'::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare k text := _vendor_login_key(p_login); pw text := _community_temp_pwd(); uid bigint;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if k is null then raise exception 'BAD_LOGIN' using errcode = '22023'; end if;
  if exists(select 1 from vendor_users where login = k) then raise exception 'LOGIN_TAKEN' using errcode = '23505'; end if;
  insert into vendor_users (venue_id, login, name, role, password_hash, must_change_pwd, temp_expires_at)
  values (p_venue, k, coalesce(trim(p_name), ''), coalesce(p_role, 'manager'), crypt(pw, gen_salt('bf')), true, now() + interval '72 hours')
  returning id into uid;
  return jsonb_build_object('id', uid, 'login', k, 'password', pw);
end $function$;
revoke all on function public.staff_vendor_user_add(bigint, text, text, text) from public, anon;
grant execute on function public.staff_vendor_user_add(bigint, text, text, text) to authenticated;

create or replace function public.staff_vendor_user_reset(p_user bigint)
 returns text
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare pw text := _community_temp_pwd(); k text;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  update vendor_users set password_hash = crypt(pw, gen_salt('bf')), must_change_pwd = true, session_token = null,
         temp_expires_at = now() + interval '72 hours'
   where id = p_user returning login into k;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  delete from vendor_sessions where user_id = p_user;
  delete from login_throttle where identifier = 'vendor:' || k;
  return pw;
end $function$;
revoke all on function public.staff_vendor_user_reset(bigint) from public, anon;
grant execute on function public.staff_vendor_user_reset(bigint) to authenticated;

create or replace function public.staff_vendor_user_active(p_user bigint, p_active boolean)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  update vendor_users set active = p_active, session_token = null where id = p_user;
  if not p_active then delete from vendor_sessions where user_id = p_user; end if;
end $function$;
revoke all on function public.staff_vendor_user_active(bigint, boolean) from public, anon;
grant execute on function public.staff_vendor_user_active(bigint, boolean) to authenticated;

-- Staff read the new column with the others (VENDOR_USER_COLS in the rentals app).
grant select (temp_expires_at) on public.vendor_users to authenticated;


-- ── checks ─────────────────────────────────────────────────────────────────────────────────────
do $chk$
begin
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and not p.prosecdef
               and p.proname in ('_vendor_auth','_vendor_user','_vendor_pwd_problem','_vendor_ride_time','_vendor_riders',
                                 'vendor_login','vendor_logout','vendor_logout_others','vendor_me','vendor_set_password',
                                 'vendor_team','vendor_profile_save','_vendor_sync_day','_vendor_session_fill',
                                 '_vendor_session_bf_guard','vendor_calendar','vendor_preview','vendor_shared_ratings_mine',
                                 'vendor_request','vendor_feedback_save','vendor_cancel','staff_vendor_user_add',
                                 'staff_vendor_user_reset','staff_vendor_user_active')) then
    raise exception 'a function lost SECURITY DEFINER';
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.provolatile <> 'v'
               and p.proname in ('_vendor_auth','_vendor_user','vendor_me','vendor_calendar','vendor_preview','vendor_shared_ratings_mine')) then
    raise exception 'a session-checking function is not volatile (PostgREST would run it read-only)';
  end if;
  if has_function_privilege('anon', 'public._vendor_auth(bigint,text,boolean)', 'execute')
     or has_function_privilege('anon', 'public._vendor_pwd_problem(text,text,bigint)', 'execute')
     or has_table_privilege('anon', 'public.vendor_sessions', 'select')
     or has_table_privilege('authenticated', 'public.vendor_sessions', 'select')
     or has_table_privilege('anon', 'public.vendor_gate', 'select')
     or has_table_privilege('authenticated', 'public.vendor_gate', 'select') then
    raise exception 'a vendor secret is reachable';
  end if;
  if public._vendor_phone('0501234567') <> '+966501234567' or public._vendor_phone('+44 20 7946 0958') <> '+442079460958'
     or public._vendor_phone('abc') is not null or public._vendor_phone('') <> '' then
    raise exception '_vendor_phone is wrong';
  end if;
  if public._vendor_pwd_problem('short', 'a@b.co', null) <> 'WEAK_PASSWORD'
     or public._vendor_pwd_problem('Password123', 'a@b.co', null) <> 'COMMON_PASSWORD'
     or public._vendor_pwd_problem('harbourcafe-2026!', 'harbourcafe@x.sa', null) <> 'PERSONAL_PASSWORD'
     or public._vendor_pwd_problem('my 0501234567 pin', '0501234567', null) <> 'PERSONAL_PASSWORD'
     or public._vendor_pwd_problem('long quiet morning ride', 'a@b.co', null) <> '' then
    raise exception '_vendor_pwd_problem is wrong';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name) values
  ('20261004130000', 'vendor_portal_hardening')
on conflict do nothing;

commit;
