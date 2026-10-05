-- ============================================================================
-- Stable customer session tokens (multi-device sign-in) + token validity RPC.
--
-- Problem found 2026-08-14: customer_login / customer_oauth_login ROTATED
-- session_token on every sign-in. A rider signed in on two devices (or helped
-- at the desk) left every older device with a dead token: still "signed in",
-- but my_bookings() silently returns nothing -> My Rides looks empty with no
-- error (reported for a rider's Saturday booking).
--
-- Change:
--   A. Logins REUSE the account's existing token; one is minted only when the
--      account has none. Being signed in on phone + laptop now just works.
--   B. Password change and reset STILL rotate (unchanged) — that is the point
--      where invalidating every other device is the wanted behaviour.
--   C. New customer_token_ok(p_id, p_token) lets the app validate its stored
--      token at boot and sign out cleanly when it has gone stale, instead of
--      showing an empty My Rides forever. (Boolean only; guessing a 48-hex
--      token is infeasible, so this exposes nothing.)
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ── A1. Password login: reuse the existing token ────────────────────────────
create or replace function customer_login(p_identifier text, p_pwd text)
returns table(
  id text, name text, email text, phone text, height int, type_preference text,
  created_at text, birth_date text, country text, city text, photo text, session_token text
) language plpgsql security definer set search_path = public, extensions as $$
declare r customers%rowtype; tok text; ident text; thr login_throttle%rowtype; nfails int;
begin
  ident := lower(trim(p_identifier));
  select * into thr from login_throttle where identifier = ident;
  if thr.locked_until is not null and thr.locked_until > now() then
    raise exception 'LOCKED' using errcode = 'P0001';   -- too many attempts; the app shows a wait message
  end if;
  -- Columns qualified with customers.*: bare email/phone would be ambiguous
  -- against this function's RETURNS TABLE(... email, phone ...) output names.
  select * into r from customers
   where lower(customers.email) = ident
      or regexp_replace(customers.phone,'\D','','g') = regexp_replace(p_identifier,'\D','','g')
   limit 1;
  if not found or not _cust_pwd_ok(r.password_hash, p_pwd) then
    -- record the failure; a just-expired lock resets the counter first
    nfails := (case when thr.locked_until is not null and thr.locked_until <= now() then 0 else coalesce(thr.fails,0) end) + 1;
    insert into login_throttle(identifier, fails, locked_until)
      values (ident, nfails, case when nfails >= 8 then now() + interval '15 minutes' else null end)
      on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until;
    return;
  end if;
  delete from login_throttle where identifier = ident;   -- success clears the counter

  -- Reuse the live token so other signed-in devices stay valid; mint only when absent.
  tok := coalesce(nullif(r.session_token,''), encode(gen_random_bytes(24), 'hex'));
  -- Transparent upgrade: re-hash a legacy sha256 password to bcrypt on login.
  if left(r.password_hash, 7) = 'sha256:' then
    update customers set session_token = tok, password_hash = crypt(p_pwd, gen_salt('bf')) where customers.id = r.id;
  else
    update customers set session_token = tok where customers.id = r.id; -- qualified: id is also a RETURNS TABLE output name
  end if;
  return query select r.id, r.name, r.email, r.phone, r.height, r.type_preference,
    r.created_at, r.birth_date, r.country, r.city, r.photo, tok;
end $$;

-- ── A2. Google login: same reuse ────────────────────────────────────────────
create or replace function customer_oauth_login(p_email text)
returns table(
  id text, name text, email text, phone text, height int, type_preference text,
  created_at text, birth_date text, country text, city text, photo text, session_token text
) language plpgsql security definer set search_path = public, extensions as $$
declare r customers%rowtype; tok text;
begin
  if auth.uid() is null or lower(coalesce(auth.jwt()->>'email','')) <> lower(p_email) then return; end if;
  select * into r from customers where lower(customers.email) = lower(p_email) limit 1;
  if not found then return; end if;
  tok := coalesce(nullif(r.session_token,''), encode(gen_random_bytes(24),'hex'));
  update customers set session_token = tok where customers.id = r.id;
  return query select r.id, r.name, r.email, r.phone, r.height, r.type_preference,
    r.created_at, r.birth_date, r.country, r.city, r.photo, tok;
end $$;

-- ── C. Token validity check (app boot: detect a stale stored session) ───────
create or replace function customer_token_ok(p_id text, p_token text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists(select 1 from customers where id = p_id and session_token = p_token and p_token is not null);
$$;
grant execute on function customer_token_ok(text,text) to anon, authenticated;

-- ── Bookkeeping for the Supabase CLI ─────────────────────────────────────────
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version    text primary key,
  statements text[],
  name       text
);
insert into supabase_migrations.schema_migrations (version, name)
values ('20260814150000', 'stable_session_tokens')
on conflict (version) do nothing;
