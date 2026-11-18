-- 20261119300100_passkeys: passkeys on micromobility.sa (N06), STAGING ONLY, behind site_content 'account.passkeys'
-- = {"on": false}. Written by builder B7 of the 2026-11-18 store and Experiences build (the user: "do all"); its text
-- below is B7's file as tested on a local Postgres 17 (ALL PASSED, applied twice). It needs the payments migration
-- 20261110150000 (_pay_key_ok, the website server's key), which only the staging database has, so it refuses to run
-- anywhere else. Rollback idea: drop the two passkey tables, the passkey_*/_passkey_*/staff_passkey* functions and the
-- trigger, and delete the site_content row; nothing else reads them.

begin;
set local lock_timeout = '5s';

do $pre$ begin
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20261110150000') then
    raise exception 'STAGING ONLY: 20261110150000_online_payments is not applied here';
  end if;
end $pre$;

-- ============================================================================
-- Passkeys on micromobility.sa (builder B7 of the store and Experiences build, 2026-11-18; the user: "do all" of the
-- report "Store and Experiences mobile design", item N06: "Sign in with a passkey" beside the password, offered once
-- after a successful password sign-in). Behind ONE switch, site_content 'account.passkeys' = {"on": false}: while it is
-- not {"on": true} every website function below refuses (PASSKEY_OFF) and the website shows nothing.
-- STAGING FIRST (the website's staging branch builds against it). No begin/commit and no ledger row here: the rentals
-- builder (B8) assembles one migration from every builder's file. Names: passkey_* (tables, website functions),
-- _passkey_* (helpers), staff_passkey* (staff).
--
-- A passkey is a sign-in key a rider keeps in their own password manager (iCloud Keychain, Google Password Manager,
-- Windows Hello...), unlocked with Face ID, a fingerprint or the device's PIN. The device keeps the private key and the
-- biometrics; this database keeps the PUBLIC key and the bookkeeping WebAuthn needs, nothing else. It is not "Sign in
-- with Apple or Google" (owner rule R6): no Apple or Google account is involved and the session is the booking app's.
--
-- Trust model (as the payments' 20261110150000):
--  * Every website function takes the website server's key (p_key, checked by _pay_key_ok first): the public key alone
--    opens none of them. The website's server (a Cloudflare Worker) makes the WebAuthn checks this database cannot (the
--    signature, the origin, the rp id hash, the user-verified flag) and then asks for the session.
--  * Challenges are made HERE (32 random bytes, extensions.gen_random_bytes), kept 5 minutes, and used once: a sign-in
--    challenge is spent by passkey_take (it hands the stored public key for that one challenge and passkey) and
--    completed by passkey_sign_in within 2 minutes after; a registration challenge is spent by passkey_register and
--    names the account it was made for.
--  * passkey_sign_in issues the session: the account's own session_token, exactly what customer_login hands back (the
--    token is stable: signing in anywhere signs nobody out). It never makes a token: a passkey works only while the
--    session it was added under stands (token_hash = sha256 of the token then). Whatever signs the account out
--    everywhere - a forgotten-password reset, a password change, a temporary password from staff, a merge, the archive,
--    the retention anonymisation - also retires its passkeys (the trigger below deletes them at once; every function
--    checks again). An account archived, merged away or gone never signs in.
--  * The signature counter is judged here, under a row lock: a counter that does not move forward (when either side is
--    not 0; synced passkeys always say 0) is refused and the passkey flagged for staff (a possible copy).
--  * Visitors are metered here as well (_ip_gate per visitor, the address the website's server names, as the store's
--    _store_visitor reads it), and the table of open challenges is capped.
--
--  1. Setting: account.passkeys {"on": false}.
--  2. Tables (RLS on, no client grants at all; only the functions below read or write them):
--       passkey_credentials  one row per passkey: account, rp id, credential id (unique), user handle, COSE public key,
--                            alg, counter, backup flags, transports, AAGUID, label code, token_hash, dates, counter flag
--       passkey_challenges   open challenges: purpose, rp id, the account (register), the user handle (register),
--                            expiry, taken (sign-in), done
--  3. Website functions (server key; anon/authenticated may call them, they refuse without the key):
--       passkey_begin, passkey_take, passkey_sign_in, passkey_register, passkey_list, passkey_remove
--  4. Staff functions (is_staff): staff_passkeys(p_customer), staff_passkey_remove(p_customer, p_passkey)
--  5. Trigger customers_passkey_retire: a rotated or cleared session token, an archive or a merge deletes the account's
--     passkeys.
--  Customer activity (20261004160000 _cact_add, when present): 'signin' with {"passkey": true}, 'passkey_add',
--  'passkey_remove' (detail {"by":"staff"} from staff). A failure there never stands in the way.
--
-- Depends on: customers (session_token, merged_into, archived_at [20261111200000], name, email, phone), site_content,
-- _pay_key_ok + pay_server_keys (20261110150000_online_payments; production would need that part and the Worker secret
-- PAY_SERVER_KEY before this can be switched on there), _cust_token_ok, _ip_gate, is_staff, pgcrypto in schema
-- extensions (gen_random_bytes). Rebuilds no existing function.
--
-- Rollback idea: drop trigger customers_passkey_retire on public.customers; drop the eight functions and the helpers
-- (_passkey_on, _passkey_gate, _passkey_rand, _passkey_hash, _passkey_b64ok, _passkey_visitor, _passkey_prune, _passkey_items,
-- _passkey_log, _passkey_retire); drop table public.passkey_challenges, public.passkey_credentials;
-- delete from public.site_content where key = 'account.passkeys'. Riders' devices keep their (now useless) passkeys.
-- Idempotent.
-- ============================================================================

set local lock_timeout = '5s';

-- ── 1. The switch ─────────────────────────────────────────────────────────────────────────────────
insert into public.site_content (key, value) values ('account.passkeys', '{"on": false}'::jsonb)
on conflict (key) do nothing;

-- ── 2. Tables ─────────────────────────────────────────────────────────────────────────────────────
create table if not exists public.passkey_credentials (
  id              uuid primary key default gen_random_uuid(),
  customer_id     text not null references public.customers(id) on delete cascade,
  rp_id           text not null check (rp_id ~ '^[a-z0-9.-]{1,253}$'),
  -- base64url of 16-1023 bytes (WebAuthn's limits); one passkey, one row, whatever the account
  cred_id         text not null check (cred_id ~ '^[A-Za-z0-9_-]+$' and length(cred_id) between 22 and 1364),
  -- the WebAuthn user.id: 32 random bytes made here, the same for every passkey of one account and rp (never the
  -- account id: the password manager keeps it)
  user_handle     text not null check (user_handle ~ '^[A-Za-z0-9_-]{43}$'),
  -- the COSE_Key (RFC 9053) as the authenticator made it, base64url: ES256 about 103 characters, RSA up to 4096 bits
  public_key      text not null check (public_key ~ '^[A-Za-z0-9_-]+$' and length(public_key) between 40 and 1400),
  alg             integer not null check (alg in (-7, -257)),
  sign_count      bigint not null default 0 check (sign_count between 0 and 4294967295),
  backup_eligible boolean not null default false,
  backed_up       boolean not null default false,
  transports      text[] not null default '{}'
                  check (cardinality(transports) <= 6 and transports <@ array['usb','nfc','ble','internal','hybrid','smart-card']::text[]),
  aaguid          uuid,
  -- a code the pages word: icloud google chrome-mac windows samsung 1password bitwarden iphone ipad android chromebook
  -- mac windows-pc linux other
  label           text not null default 'other' check (label ~ '^[a-z0-9-]{1,24}$'),
  -- sha256 (hex) of the account's session token when the passkey was added: the session it lives with
  token_hash      text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz,
  -- when a sign-in was refused because the counter went back (a possible copy of the passkey); staff see it
  counter_flag_at timestamptz,
  constraint passkey_credentials_cred_unique unique (cred_id),
  constraint passkey_credentials_backup check (backup_eligible or not backed_up)
);
create index if not exists passkey_credentials_customer_idx on public.passkey_credentials (customer_id);

create table if not exists public.passkey_challenges (
  challenge   text primary key check (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  purpose     text not null check (purpose in ('signin', 'register')),
  rp_id       text not null check (rp_id ~ '^[a-z0-9.-]{1,253}$'),
  customer_id text references public.customers(id) on delete cascade,
  user_handle text check (user_handle is null or user_handle ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at  timestamptz not null,
  taken_at    timestamptz,
  cred_id     text check (cred_id is null or (cred_id ~ '^[A-Za-z0-9_-]+$' and length(cred_id) between 22 and 1364)),
  done_at     timestamptz,
  created_at  timestamptz not null default now(),
  constraint passkey_challenges_register check ((purpose = 'register') = (customer_id is not null and user_handle is not null))
);
create index if not exists passkey_challenges_expires_idx on public.passkey_challenges (expires_at);

alter table public.passkey_credentials enable row level security;
alter table public.passkey_challenges enable row level security;
revoke all on public.passkey_credentials from public, anon, authenticated;
revoke all on public.passkey_challenges from public, anon, authenticated;
-- No policies and no grants: no client reads or writes either table; staff read through staff_passkeys.

-- ── Helpers (no client may run them) ──────────────────────────────────────────────────────────────
create or replace function public._passkey_on() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select s.value -> 'on' = 'true'::jsonb from site_content s where s.key = 'account.passkeys'), false)
$$;
revoke execute on function public._passkey_on() from public, anon, authenticated;

-- Every website function first: the server key, then the switch.
create or replace function public._passkey_gate(p_key text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not _pay_key_ok(p_key) then raise exception 'NOT_AUTHORIZED' using errcode = '42501'; end if;
  if not _passkey_on() then raise exception 'PASSKEY_OFF' using errcode = 'P0001'; end if;
end $$;
revoke execute on function public._passkey_gate(text) from public, anon, authenticated;

-- 32 random bytes as base64url (43 characters).
create or replace function public._passkey_rand() returns text
language sql volatile set search_path = public as $$
  select rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), E'+/\n', '-_'), '=')
$$;
revoke execute on function public._passkey_rand() from public, anon, authenticated;

-- base64url text of lo..hi characters (Postgres regular expressions count to 255 at most, so the length apart).
create or replace function public._passkey_b64ok(p_text text, p_lo integer, p_hi integer) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(p_text ~ '^[A-Za-z0-9_-]+$' and length(p_text) between p_lo and p_hi, false)
$$;
revoke execute on function public._passkey_b64ok(text, integer, integer) from public, anon, authenticated;

create or replace function public._passkey_hash(p_text text) returns text
language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(p_text, 'UTF8')), 'hex')
$$;
revoke execute on function public._passkey_hash(text) from public, anon, authenticated;

-- The visitor the website's server calls for (x-mm-visitor-ip), as ':<address>' for a meter's key, or ''. Read only
-- after the server key was checked: only the website's server holds it, so the header is its word.
create or replace function public._passkey_visitor() returns text
language plpgsql stable set search_path = public as $$
declare h json; v text;
begin
  begin h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then h := null;
  end;
  v := btrim(coalesce(h ->> 'x-mm-visitor-ip', ''));
  return case when v ~ '^[0-9A-Fa-f:.]{2,45}$' then ':' || v else '' end;
end $$;
revoke execute on function public._passkey_visitor() from public, anon, authenticated;

-- Retires (deletes) an account's passkeys that no longer belong to its live session: the token changed or was
-- cleared, or the account was archived or merged away. Answers how many went.
create or replace function public._passkey_prune(p_customer text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from passkey_credentials p
   where p.customer_id = p_customer
     and not exists (select 1 from customers c
                      where c.id = p.customer_id and c.archived_at is null and c.merged_into is null
                        and coalesce(c.session_token, '') <> '' and _passkey_hash(c.session_token) = p.token_hash);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public._passkey_prune(text) from public, anon, authenticated;

-- What My Account lists: never a key, a credential id or a user handle.
create or replace function public._passkey_items(p_customer text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'label', p.label, 'created_at', p.created_at, 'last_used_at', p.last_used_at, 'backed_up', p.backed_up)
           order by p.created_at), '[]'::jsonb))
    from passkey_credentials p where p.customer_id = p_customer
$$;
revoke execute on function public._passkey_items(text) from public, anon, authenticated;

-- One line in the customer activity log (20261004160000), when there is one; never in the way.
create or replace function public._passkey_log(p_customer text, p_action text, p_detail jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform _cact_add(p_customer, (select c.name from customers c where c.id = p_customer), p_action, coalesce(p_detail, '{}'::jsonb), p_customer);
  exception when others then null;
  end;
end $$;
revoke execute on function public._passkey_log(text, text, jsonb) from public, anon, authenticated;

-- ── 3. Website functions ──────────────────────────────────────────────────────────────────────────

-- A challenge. p_purpose 'signin': for any passkey of this rp. 'register': for a new passkey of the account the
-- session names (p_id, p_token), answered with the user handle the passkey is made with, the name and display name the
-- password manager shows (email, else phone, else name; the name), and the credential ids it already has (the browser
-- then never makes a second one on a device that holds one).
-- Answers {challenge, expires_at} (+ {user: {handle, name, display}, exclude: [...]} for 'register').
-- Refuses: NOT_AUTHORIZED (42501), PASSKEY_OFF, PASSKEY_INPUT: purpose|rp, PASSKEY_SIGNIN (the session is not the
-- account's), RATE_LIMITED (60 challenges per visitor in 10 minutes), PASSKEY_BUSY (20,000 open challenges),
-- PASSKEY_LIMIT (10 passkeys on the account already).
create or replace function public.passkey_begin(p_key text, p_purpose text, p_rp_id text, p_id text default null, p_token text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ch text; v_handle text; c customers%rowtype; v_ex jsonb := '[]'::jsonb; v_exp timestamptz := now() + interval '5 minutes';
begin
  perform _passkey_gate(p_key);
  if p_purpose is null or p_purpose not in ('signin', 'register') then raise exception 'PASSKEY_INPUT: purpose' using errcode = 'P0001'; end if;
  if coalesce(p_rp_id, '') !~ '^[a-z0-9.-]{1,253}$' then raise exception 'PASSKEY_INPUT: rp' using errcode = 'P0001'; end if;
  if p_purpose = 'register' and not _cust_token_ok(p_id, p_token) then raise exception 'PASSKEY_SIGNIN' using errcode = 'P0001'; end if;
  if not _ip_gate('passkey' || _passkey_visitor(), 60, interval '10 minutes') then
    raise exception 'RATE_LIMITED' using errcode = 'P0001';
  end if;
  delete from passkey_challenges where expires_at < now() - interval '10 minutes';
  if (select count(*) from passkey_challenges where expires_at > now()) >= 20000 then
    raise exception 'PASSKEY_BUSY' using errcode = 'P0001';
  end if;
  v_ch := _passkey_rand();
  if p_purpose = 'register' then
    perform _passkey_prune(p_id);
    if (select count(*) from passkey_credentials where customer_id = p_id) >= 10 then
      raise exception 'PASSKEY_LIMIT' using errcode = 'P0001';
    end if;
    select * into c from customers where id = p_id;
    select p.user_handle into v_handle from passkey_credentials p
     where p.customer_id = p_id and p.rp_id = p_rp_id order by p.created_at limit 1;
    v_handle := coalesce(v_handle, _passkey_rand());
    select coalesce(jsonb_agg(p.cred_id order by p.created_at), '[]'::jsonb) into v_ex
      from passkey_credentials p where p.customer_id = p_id and p.rp_id = p_rp_id;
  end if;
  insert into passkey_challenges (challenge, purpose, rp_id, customer_id, user_handle, expires_at)
  values (v_ch, p_purpose, p_rp_id, case when p_purpose = 'register' then p_id end, v_handle, v_exp);
  if p_purpose = 'signin' then
    return jsonb_build_object('challenge', v_ch, 'expires_at', v_exp);
  end if;
  return jsonb_build_object('challenge', v_ch, 'expires_at', v_exp, 'exclude', v_ex,
    'user', jsonb_build_object('handle', v_handle,
      'name', left(coalesce(nullif(btrim(c.email), ''), nullif(btrim(c.phone), ''), nullif(btrim(c.name), ''), 'MicroMobility'), 120),
      'display', left(coalesce(nullif(btrim(c.name), ''), nullif(btrim(c.email), ''), nullif(btrim(c.phone), ''), 'MicroMobility'), 120)));
end $$;
revoke execute on function public.passkey_begin(text, text, text, text, text) from public;
grant execute on function public.passkey_begin(text, text, text, text, text) to anon, authenticated;

-- Sign-in, step one, before the website checks the signature: SPENDS the sign-in challenge (marks it taken for this
-- passkey; a challenge is taken once, whatever happens next) and hands the stored public key.
-- Answers {ok: true, public_key, alg, user_handle, backup_eligible}, or {ok: false, error: 'PASSKEY_UNKNOWN'} (no such
-- passkey here: the challenge stays spent, so this is answered, not raised).
-- Refuses: NOT_AUTHORIZED, PASSKEY_OFF, PASSKEY_INPUT, PASSKEY_CHALLENGE (unknown, expired, already taken, or not a
-- sign-in challenge of this rp).
create or replace function public.passkey_take(p_key text, p_challenge text, p_rp_id text, p_cred_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare ch passkey_challenges%rowtype; p passkey_credentials%rowtype;
begin
  perform _passkey_gate(p_key);
  if coalesce(p_challenge, '') !~ '^[A-Za-z0-9_-]{43}$' or coalesce(p_rp_id, '') !~ '^[a-z0-9.-]{1,253}$'
     or not _passkey_b64ok(p_cred_id, 22, 1364) then
    raise exception 'PASSKEY_INPUT' using errcode = 'P0001';
  end if;
  update passkey_challenges set taken_at = now(), cred_id = p_cred_id
   where challenge = p_challenge and purpose = 'signin' and rp_id = p_rp_id and taken_at is null and expires_at > now()
  returning * into ch;
  if ch.challenge is null then raise exception 'PASSKEY_CHALLENGE' using errcode = 'P0001'; end if;
  select * into p from passkey_credentials where cred_id = p_cred_id and rp_id = p_rp_id;
  if p.id is null then return jsonb_build_object('ok', false, 'error', 'PASSKEY_UNKNOWN'); end if;
  return jsonb_build_object('ok', true, 'public_key', p.public_key, 'alg', p.alg, 'user_handle', p.user_handle,
                            'backup_eligible', p.backup_eligible);
end $$;
revoke execute on function public.passkey_take(text, text, text, text) from public;
grant execute on function public.passkey_take(text, text, text, text) to anon, authenticated;

-- Sign-in, step two, after the website verified the assertion (signature, origin, rp id hash, user present AND
-- verified - p_user_verified must be true - and the user handle) for the challenge passkey_take spent for this passkey,
-- within 2 minutes of it, once. Judges the counter, checks the account, and hands the account's session.
-- Answers {ok: true, id, name, email, session_token} (the account's own token, as customer_login hands it), or
-- {ok: false, error}: PASSKEY_UNKNOWN (the passkey is gone), PASSKEY_RETIRED (the session it was added under has ended,
-- or the account was archived or merged away: the passkey is deleted), PASSKEY_COUNTER (the counter did not move
-- forward: refused and flagged). Answered rather than raised from there on, so the challenge stays completed.
-- Refuses: NOT_AUTHORIZED, PASSKEY_OFF, PASSKEY_INPUT, PASSKEY_CHALLENGE.
create or replace function public.passkey_sign_in(p_key text, p_challenge text, p_rp_id text, p_cred_id text, p_sign_count bigint,
                                                  p_backed_up boolean, p_user_verified boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare ch passkey_challenges%rowtype; p passkey_credentials%rowtype; c customers%rowtype;
begin
  perform _passkey_gate(p_key);
  if coalesce(p_challenge, '') !~ '^[A-Za-z0-9_-]{43}$' or coalesce(p_rp_id, '') !~ '^[a-z0-9.-]{1,253}$'
     or not _passkey_b64ok(p_cred_id, 22, 1364)
     or p_sign_count is null or p_sign_count < 0 or p_sign_count > 4294967295 or p_user_verified is not true then
    raise exception 'PASSKEY_INPUT' using errcode = 'P0001';
  end if;
  update passkey_challenges set done_at = now()
   where challenge = p_challenge and purpose = 'signin' and rp_id = p_rp_id and cred_id = p_cred_id
     and taken_at is not null and taken_at > now() - interval '2 minutes' and done_at is null
  returning * into ch;
  if ch.challenge is null then raise exception 'PASSKEY_CHALLENGE' using errcode = 'P0001'; end if;
  select * into p from passkey_credentials where cred_id = p_cred_id and rp_id = p_rp_id for update;
  if p.id is null then return jsonb_build_object('ok', false, 'error', 'PASSKEY_UNKNOWN'); end if;
  select * into c from customers where id = p.customer_id for share;
  if c.id is null or c.archived_at is not null or c.merged_into is not null or coalesce(c.session_token, '') = ''
     or _passkey_hash(c.session_token) <> p.token_hash then
    delete from passkey_credentials where id = p.id;
    return jsonb_build_object('ok', false, 'error', 'PASSKEY_RETIRED');
  end if;
  if (p_sign_count > 0 or p.sign_count > 0) and p_sign_count <= p.sign_count then
    update passkey_credentials set counter_flag_at = now() where id = p.id;
    return jsonb_build_object('ok', false, 'error', 'PASSKEY_COUNTER');
  end if;
  update passkey_credentials
     set sign_count = p_sign_count, backed_up = coalesce(p_backed_up, backed_up) and backup_eligible, last_used_at = now()
   where id = p.id;
  perform _passkey_log(c.id, 'signin', jsonb_build_object('passkey', true));
  return jsonb_build_object('ok', true, 'id', c.id, 'name', c.name, 'email', c.email, 'session_token', c.session_token);
end $$;
revoke execute on function public.passkey_sign_in(text, text, text, text, bigint, boolean, boolean) from public;
grant execute on function public.passkey_sign_in(text, text, text, text, bigint, boolean, boolean) to anon, authenticated;

-- A new passkey for the signed-in account, after the website verified the registration (challenge, origin, rp id hash,
-- user present AND verified, the key imports): SPENDS the register challenge made for this account, keeps the public
-- key with the user handle made with the challenge and the hash of the session it lives with.
-- Answers {ok: true, id, items: [...]} (the account's passkeys, as passkey_list), or {ok: false, error}: PASSKEY_TAKEN
-- (that credential id is already kept), PASSKEY_LIMIT (10 already).
-- Refuses: NOT_AUTHORIZED, PASSKEY_OFF, PASSKEY_SIGNIN, PASSKEY_INPUT: <field>, PASSKEY_CHALLENGE.
create or replace function public.passkey_register(p_key text, p_id text, p_token text, p_challenge text, p_rp_id text,
                                                   p_cred_id text, p_public_key text, p_alg integer, p_sign_count bigint,
                                                   p_backup_eligible boolean, p_backed_up boolean, p_transports text[],
                                                   p_aaguid text, p_label text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare ch passkey_challenges%rowtype; v_id uuid;
begin
  perform _passkey_gate(p_key);
  if not _cust_token_ok(p_id, p_token) then raise exception 'PASSKEY_SIGNIN' using errcode = 'P0001'; end if;
  if coalesce(p_challenge, '') !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'PASSKEY_INPUT: challenge' using errcode = 'P0001'; end if;
  if coalesce(p_rp_id, '') !~ '^[a-z0-9.-]{1,253}$' then raise exception 'PASSKEY_INPUT: rp' using errcode = 'P0001'; end if;
  if not _passkey_b64ok(p_cred_id, 22, 1364) then raise exception 'PASSKEY_INPUT: cred_id' using errcode = 'P0001'; end if;
  if not _passkey_b64ok(p_public_key, 40, 1400) then raise exception 'PASSKEY_INPUT: public_key' using errcode = 'P0001'; end if;
  if p_alg is null or p_alg not in (-7, -257) then raise exception 'PASSKEY_INPUT: alg' using errcode = 'P0001'; end if;
  if p_sign_count is null or p_sign_count < 0 or p_sign_count > 4294967295 then raise exception 'PASSKEY_INPUT: sign_count' using errcode = 'P0001'; end if;
  if p_backup_eligible is null or p_backed_up is null or (p_backed_up and not p_backup_eligible) then
    raise exception 'PASSKEY_INPUT: backup' using errcode = 'P0001';
  end if;
  if cardinality(coalesce(p_transports, '{}')) > 6
     or not coalesce(p_transports, '{}') <@ array['usb','nfc','ble','internal','hybrid','smart-card']::text[] then
    raise exception 'PASSKEY_INPUT: transports' using errcode = 'P0001';
  end if;
  if p_aaguid is not null and p_aaguid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'PASSKEY_INPUT: aaguid' using errcode = 'P0001';
  end if;
  if coalesce(p_label, '') !~ '^[a-z0-9-]{1,24}$' then raise exception 'PASSKEY_INPUT: label' using errcode = 'P0001'; end if;
  delete from passkey_challenges
   where challenge = p_challenge and purpose = 'register' and rp_id = p_rp_id and customer_id = p_id and expires_at > now()
  returning * into ch;
  if ch.challenge is null then raise exception 'PASSKEY_CHALLENGE' using errcode = 'P0001'; end if;
  -- the challenge is spent: from here on a refusal is answered, not raised
  perform _passkey_prune(p_id);
  if (select count(*) from passkey_credentials where customer_id = p_id) >= 10 then
    return jsonb_build_object('ok', false, 'error', 'PASSKEY_LIMIT');
  end if;
  insert into passkey_credentials (customer_id, rp_id, cred_id, user_handle, public_key, alg, sign_count, backup_eligible,
                                   backed_up, transports, aaguid, label, token_hash)
  values (p_id, p_rp_id, p_cred_id, ch.user_handle, p_public_key, p_alg, p_sign_count, p_backup_eligible, p_backed_up,
          coalesce(p_transports, '{}'), p_aaguid::uuid, p_label, _passkey_hash(p_token))
  on conflict (cred_id) do nothing
  returning id into v_id;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'PASSKEY_TAKEN'); end if;
  perform _passkey_log(p_id, 'passkey_add', jsonb_build_object('label', p_label));
  return jsonb_build_object('ok', true, 'id', v_id) || _passkey_items(p_id);
end $$;
revoke execute on function public.passkey_register(text, text, text, text, text, text, text, integer, bigint, boolean, boolean, text[], text, text) from public;
grant execute on function public.passkey_register(text, text, text, text, text, text, text, integer, bigint, boolean, boolean, text[], text, text) to anon, authenticated;

-- The signed-in account's passkeys (retired ones are removed first). Answers {ok: true, items: [{id, label,
-- created_at, last_used_at, backed_up}]}. Refuses: NOT_AUTHORIZED, PASSKEY_OFF, PASSKEY_SIGNIN.
create or replace function public.passkey_list(p_key text, p_id text, p_token text)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _passkey_gate(p_key);
  if not _cust_token_ok(p_id, p_token) then raise exception 'PASSKEY_SIGNIN' using errcode = 'P0001'; end if;
  perform _passkey_prune(p_id);
  return jsonb_build_object('ok', true) || _passkey_items(p_id);
end $$;
revoke execute on function public.passkey_list(text, text, text) from public;
grant execute on function public.passkey_list(text, text, text) to anon, authenticated;

-- Removes one of the signed-in account's own passkeys. Answers {ok: true, removed: true|false, items: [...]}.
-- Refuses: NOT_AUTHORIZED, PASSKEY_OFF, PASSKEY_SIGNIN, PASSKEY_INPUT.
create or replace function public.passkey_remove(p_key text, p_id text, p_token text, p_passkey uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform _passkey_gate(p_key);
  if not _cust_token_ok(p_id, p_token) then raise exception 'PASSKEY_SIGNIN' using errcode = 'P0001'; end if;
  if p_passkey is null then raise exception 'PASSKEY_INPUT' using errcode = 'P0001'; end if;
  delete from passkey_credentials where id = p_passkey and customer_id = p_id;
  get diagnostics n = row_count;
  if n > 0 then perform _passkey_log(p_id, 'passkey_remove', '{}'::jsonb); end if;
  perform _passkey_prune(p_id);
  return jsonb_build_object('ok', true, 'removed', n > 0) || _passkey_items(p_id);
end $$;
revoke execute on function public.passkey_remove(text, text, text, uuid) from public;
grant execute on function public.passkey_remove(text, text, text, uuid) to anon, authenticated;

-- ── 4. Staff ──────────────────────────────────────────────────────────────────────────────────────

-- An account's passkeys for the staff account sheet, whatever the switch says (staff help a rider either way).
-- Answers {on: <the switch>, items: [{id, label, created_at, last_used_at, backed_up, counter_flag_at, live}]}: live is
-- false for one whose session has ended (it is deleted at the next use or by the trigger). Refuses: STAFF_ONLY (42501).
create or replace function public.staff_passkeys(p_customer text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not (select is_staff()) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return jsonb_build_object('on', _passkey_on(), 'items', coalesce((
    select jsonb_agg(jsonb_build_object('id', p.id, 'label', p.label, 'created_at', p.created_at, 'last_used_at', p.last_used_at,
             'backed_up', p.backed_up, 'counter_flag_at', p.counter_flag_at,
             'live', c.archived_at is null and c.merged_into is null and coalesce(c.session_token, '') <> ''
                     and _passkey_hash(c.session_token) = p.token_hash) order by p.created_at)
      from passkey_credentials p join customers c on c.id = p.customer_id
     where p.customer_id = p_customer), '[]'::jsonb));
end $$;
revoke execute on function public.staff_passkeys(text) from public, anon;
grant execute on function public.staff_passkeys(text) to authenticated;

-- Removes one passkey of an account (p_passkey), or all of them (null): a lost phone, a rider who asks at the desk.
-- Answers {removed: <how many>}. Refuses: STAFF_ONLY (42501).
create or replace function public.staff_passkey_remove(p_customer text, p_passkey uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not (select is_staff()) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  delete from passkey_credentials where customer_id = p_customer and (p_passkey is null or id = p_passkey);
  get diagnostics n = row_count;
  if n > 0 then perform _passkey_log(p_customer, 'passkey_remove', jsonb_build_object('by', 'staff', 'n', n)); end if;
  return jsonb_build_object('removed', n);
end $$;
revoke execute on function public.staff_passkey_remove(text, uuid) from public, anon;
grant execute on function public.staff_passkey_remove(text, uuid) to authenticated;

-- ── 5. Signing out everywhere retires the account's passkeys ─────────────────────────────────────
create or replace function public._passkey_retire() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform _passkey_prune(new.id);
  return null;
end $$;
revoke execute on function public._passkey_retire() from public, anon, authenticated;

drop trigger if exists customers_passkey_retire on public.customers;
create trigger customers_passkey_retire
  after update of session_token, archived_at, merged_into on public.customers
  for each row
  when (old.session_token is distinct from new.session_token
        or old.archived_at is distinct from new.archived_at
        or old.merged_into is distinct from new.merged_into)
  execute function public._passkey_retire();

-- ── Checks: every definer function kept SECURITY DEFINER and its search_path; the helpers no client may run ──
do $chk$
declare f text;
begin
  foreach f in array array['public._passkey_on()', 'public._passkey_gate(text)', 'public._passkey_prune(text)',
                           'public._passkey_items(text)', 'public._passkey_log(text,text,jsonb)', 'public._passkey_retire()',
                           'public.passkey_begin(text,text,text,text,text)', 'public.passkey_take(text,text,text,text)',
                           'public.passkey_sign_in(text,text,text,text,bigint,boolean,boolean)',
                           'public.passkey_register(text,text,text,text,text,text,text,integer,bigint,boolean,boolean,text[],text,text)',
                           'public.passkey_list(text,text,text)', 'public.passkey_remove(text,text,text,uuid)',
                           'public.staff_passkeys(text)', 'public.staff_passkey_remove(text,uuid)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._passkey_on()', 'public._passkey_gate(text)', 'public._passkey_rand()', 'public._passkey_hash(text)', 'public._passkey_b64ok(text,integer,integer)',
                           'public._passkey_visitor()', 'public._passkey_prune(text)', 'public._passkey_items(text)',
                           'public._passkey_log(text,text,jsonb)', 'public._passkey_retire()'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  foreach f in array array['public.staff_passkeys(text)', 'public.staff_passkey_remove(text,uuid)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
  end loop;
  if has_table_privilege('anon', 'public.passkey_credentials', 'select') or has_table_privilege('authenticated', 'public.passkey_credentials', 'select')
     or has_table_privilege('anon', 'public.passkey_challenges', 'select') or has_table_privilege('authenticated', 'public.passkey_challenges', 'select') then
    raise exception 'a passkey table is readable by a client';
  end if;
end $chk$;

-- check: select key, value from site_content where key = 'account.passkeys';
-- check: select count(*) from passkey_credentials; select count(*) from passkey_challenges where expires_at > now();

insert into supabase_migrations.schema_migrations (version, name) values ('20261119300100', 'passkeys') on conflict (version) do nothing;
commit;
