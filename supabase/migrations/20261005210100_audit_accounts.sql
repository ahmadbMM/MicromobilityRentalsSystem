-- ============================================================================
-- Accounts and sign-in: the 2026-10-05 audit, database half (the owner: "fix all but the ones you
-- need a decision from me"). Items numbered as in the audit's database list.
--
--  2. Merged accounts. An account merged into another (merged_into) signs in as its keeper, and
--     every way in now agrees:
--     - _cust_token_ok refuses the token of a merged-away account (the merge clears it; a reset
--       could set one again).
--     - customer_reset acts on the keeper: the email (and phone) that identify the person are
--       checked on the row they name, as before - the identification is unchanged - and the new
--       password and token go to the account it signs in as; the merged row takes the same
--       password so its email keeps signing in (customer_login follows it to the keeper). A
--       Google- or Apple-only keeper is not reset, as such an account never was.
--     - staff_community_approve's email / phone fallback prefers an unmerged account and follows
--       a merged match to its keeper (it updated and tagged the merged-away row).
--     - staff_learn_schedule follows a merged match to its keeper instead of making a duplicate
--       account (it skipped merged rows, found nobody, and inserted a new customer).
--     staff_community_approve also stops recording a consent the application does not carry: an
--     application whose privacy_version is empty (20261005210200, item 27) leaves the account's
--     privacy_version / privacy_at as they are, and a new account gets none.
--  3. staff_merge_customers no longer aborts (23505, customer_flags_one_pending) when both accounts
--     have a correction flag open: the dropped account's fields join the keeper's pending flag and
--     the dropped flag is withdrawn before it moves; moved.flag_fold records both, and
--     staff_unmerge_customers gives the keeper's flag its own fields back and reopens the other.
-- 18. staff_unmerge_customers refuses (KEEPER_MERGED, 22023) when the keeper has since been merged
--     into a third account: undo that merge first. Before, it re-pointed nothing (the rows had
--     moved on) and revived an empty account.
-- 21. Operator PINs (4 digits): five misses lock the name for 15 minutes (was 60 seconds), twenty
--     in a day for 24 hours; both counts are per staff account and name ('op:<name>|<user>',
--     'opday:<name>|<user>'), so one account guessing cannot lock the operator out on another
--     device. staff_set_operator_pin clears every count of the name. _pin_ok and what a null
--     operator means are unchanged.
-- 22. _client_ip uses cf-connecting-ip only, else the shared key '?'. X-Forwarded-For is written by
--     the caller, so a fresh value per request bought a fresh meter. Cloudflare sets
--     cf-connecting-ip itself on every request: the API edge logs carried it, non-empty, on all
--     15,017 requests (6,095 RPC calls) of the 24 hours before 2026-10-05, and no login_throttle
--     key ended in '?'.
-- 23. customer_login meters failed sign-ins per network too: 60 failures within 10 minutes of the
--     first lock the network out (LOCKED, as before) for 15 minutes; a sign-in that succeeds
--     counts nothing. The threshold is generous on purpose: the website signs people in from its
--     Worker's egress address, so everyone signing in there shares one network.
-- 33. anon loses INSERT, UPDATE and DELETE (keeps SELECT) on cashier_sales, push_subscriptions,
--     staff, staff_actions, staff_options, customer_tags, customer_notes, desk_waitlist and
--     login_throttle. Checked 2026-10-05: no policy lets anon write any of them (each is
--     is_staff()/is_admin()/auth.uid()-gated or has none), no invoker function writes them, and
--     neither the booking app (only staff code paths write them) nor the website writes them.
--     error_log keeps its anon INSERT (the page logs errors signed out).
--
-- Patched in place from the live definitions (each anchor must match exactly once):
-- staff_community_approve, staff_learn_schedule, staff_merge_customers, staff_unmerge_customers,
-- customer_login. Rewritten whole, headers as live: _cust_token_ok, customer_reset, _client_ip,
-- staff_check_operator_pin, staff_set_operator_pin.
--
-- Rollback: re-run the saved pg_get_functiondef of each function above (or, for the rewritten
-- ones: _client_ip 20260922121000, staff_check_operator_pin / staff_set_operator_pin
-- 20260925120000, staff_merge_customers 20261004120000, staff_unmerge_customers 20261004100000);
--   grant insert, update, delete on table public.cashier_sales, public.push_subscriptions,
--     public.staff, public.staff_actions, public.staff_options, public.customer_tags,
--     public.customer_notes, public.desk_waitlist, public.login_throttle to anon;
--   delete from public.login_throttle where identifier like 'loginip:%' or identifier like 'opday:%';
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


-- ── 2. a merged-away account's token opens nothing ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._cust_token_ok(p_id text, p_token text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
  -- An account merged into another signs in as its keeper; its own token opens nothing (20261005210100).
  select exists(select 1 from customers where id=p_id and session_token=p_token and p_token is not null
                                         and merged_into is null);
$function$;


-- ── 2. customer_reset acts on the keeper ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.customer_reset(p_email text, p_phone text, p_new_pwd text)
 RETURNS TABLE(id text, name text, email text, phone text, height integer, type_preference text, created_at text, birth_date text, country text, city text, photo text, session_token text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare r customers%rowtype; kp customers%rowtype; nx customers%rowtype; hops int := 0; h text;
        tok text; s_digits text; p_digits text; k text; thr login_throttle%rowtype; nfails int;
begin
  k := 'reset:' || lower(trim(coalesce(p_email, '')));
  select * into thr from login_throttle where identifier = k;
  if thr.locked_until is not null and thr.locked_until > now() then
    raise exception 'LOCKED' using errcode = 'P0001';
  end if;
  if not _oracle_gate() then return; end if;
  select * into r from customers where lower(customers.email)=lower(p_email) limit 1;
  -- The account the email signs in as: an account merged into another is reset as its keeper,
  -- as customer_login signs it in (20261005210100).
  if r.id is not null then
    kp := r;
    while kp.merged_into is not null and hops < 5 loop
      select * into nx from customers where customers.id = kp.merged_into;
      exit when nx.id is null;
      kp := nx; hops := hops + 1;
    end loop;
  end if;
  if r.id is not null and kp.merged_into is null
     and coalesce(r.password_hash,'') not like 'oauth:%' and coalesce(kp.password_hash,'') not like 'oauth:%' then
    s_digits := regexp_replace(coalesce(r.phone,''), '[^[:digit:]]', '', 'g');
    p_digits := regexp_replace(coalesce(p_phone,''), '[^[:digit:]]', '', 'g');
    if length(p_digits) >= 8 and length(s_digits) >= 8
       and right(s_digits, 9) = right(p_digits, 9)
       and length(coalesce(p_new_pwd,'')) >= 8 then
      delete from login_throttle where identifier = k;   -- success clears the counter
      tok := encode(gen_random_bytes(24),'hex');
      h := crypt(p_new_pwd, gen_salt('bf', 10));
      update customers set password_hash = h, session_token = tok where customers.id = kp.id;
      -- the merged row's own email keeps signing in (to the keeper) with the new password
      if kp.id <> r.id then update customers set password_hash = h where customers.id = r.id; end if;
      return query select kp.id, kp.name, kp.email, kp.phone, kp.height, kp.type_preference,
        kp.created_at, kp.birth_date, kp.country, kp.city, kp.photo, tok;
      return;
    end if;
  end if;
  nfails := (case when (thr.locked_until is not null and thr.locked_until <= now())
                    or thr.updated_at < now() - interval '1 day' then 0
                  else coalesce(thr.fails, 0) end) + 1;
  insert into login_throttle(identifier, fails, locked_until, updated_at)
    values (k, nfails, case when nfails >= 8 then now() + interval '15 minutes' else null end, now())
    on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
  return;
end $function$;


-- ── 22. the caller's address is Cloudflare's word only ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._client_ip()
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare h json;
begin
  begin h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then h := null;
  end;
  -- cf-connecting-ip only: Cloudflare sets it on every request and overwrites a caller's own.
  -- X-Forwarded-For is the caller's to write - a new value each request was a new meter - so a
  -- request without the header shares the one '?' meter (20261005210100).
  return left(coalesce(nullif(btrim(h->>'cf-connecting-ip'), ''), '?'), 60);
end $function$;


-- ── 21. operator PINs: 15 minutes after five misses, 24 hours after twenty in a day ───────────
CREATE OR REPLACE FUNCTION public.staff_check_operator_pin(p_name text, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  h text;
  who text := coalesce(auth.uid()::text, '-');
  -- Counted per staff account and name (20261005210100): one account guessing cannot lock the
  -- operator out on the other devices.
  k  text := 'op:' || lower(coalesce(p_name, '')) || '|' || who;      -- five misses: 15 minutes
  kd text := 'opday:' || lower(coalesce(p_name, '')) || '|' || who;   -- twenty in a day: 24 hours
  lt login_throttle%rowtype; ld login_throttle%rowtype;
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  select pin_hash into h from team_members where name = p_name;
  if h is null then return jsonb_build_object('ok', false, 'reason', 'no_pin'); end if;
  select * into ld from login_throttle where identifier = kd for update;
  if ld.locked_until is not null and ld.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'seconds', ceil(extract(epoch from ld.locked_until - now()))::int);
  end if;
  select * into lt from login_throttle where identifier = k for update;
  if lt.locked_until is not null and lt.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'seconds', ceil(extract(epoch from lt.locked_until - now()))::int);
  end if;
  if coalesce(p_pin, '') ~ '^[0-9]{4}$' and crypt(p_pin, h) = h then
    delete from login_throttle where identifier in (k, kd);
    return jsonb_build_object('ok', true);
  end if;
  -- the day's misses, counted from the first of them
  insert into login_throttle as l (identifier, fails, locked_until, updated_at) values (kd, 1, null, now())
  on conflict (identifier) do update
    set fails = case when l.updated_at < now() - interval '1 day' then 1 else l.fails + 1 end,
        locked_until = null,
        updated_at = case when l.updated_at < now() - interval '1 day' then now() else l.updated_at end
  returning * into ld;
  if ld.fails >= 20 then
    update login_throttle set locked_until = now() + interval '24 hours' where identifier = kd;
    delete from login_throttle where identifier = k;
    return jsonb_build_object('ok', false, 'reason', 'locked', 'seconds', 86400);
  end if;
  insert into login_throttle as l (identifier, fails, locked_until, updated_at) values (k, 1, null, now())
  on conflict (identifier) do update
    set fails = case when l.locked_until is not null and l.locked_until <= now() then 1 else l.fails + 1 end,
        locked_until = null, updated_at = now()
  returning * into lt;
  if lt.fails >= 5 then
    update login_throttle set fails = 0, locked_until = now() + interval '15 minutes' where identifier = k;
    return jsonb_build_object('ok', false, 'reason', 'locked', 'seconds', 900);
  end if;
  return jsonb_build_object('ok', false, 'reason', 'wrong', 'left', 5 - lt.fails);
end $function$;

CREATE OR REPLACE FUNCTION public.staff_set_operator_pin(p_name text, p_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if p_pin is not null and p_pin !~ '^[0-9]{4}$' then raise exception 'PIN_FORMAT' using errcode = '22023'; end if;
  update team_members set pin_hash = case when p_pin is null then null else crypt(p_pin, gen_salt('bf', 8)) end
   where name = p_name;
  if not found then raise exception 'NO_SUCH_NAME' using errcode = 'P0002'; end if;
  -- every count of the name, on every staff account (20261005210100), and the old key
  delete from login_throttle
   where identifier = 'op:' || lower(p_name)
      or left(identifier, length('op:' || lower(p_name) || '|')) = 'op:' || lower(p_name) || '|'
      or left(identifier, length('opday:' || lower(p_name) || '|')) = 'opday:' || lower(p_name) || '|';
  return true;
end $function$;


-- ── 2. staff_community_approve: the keeper, never a merged-away row (patched from live) ───────
do $sca$
declare d text;
begin
  d := pg_get_functiondef('public.staff_community_approve(uuid,text,boolean)'::regprocedure);
  if position('(20261005210100)' in d) > 0 then
    raise notice 'staff_community_approve already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$     order by (lower(trim(email)) = lower(a.email)) desc nulls last, created_at limit 1;
$a$,
$b$     order by (merged_into is null) desc, (lower(trim(email)) = lower(a.email)) desc nulls last, created_at limit 1;
$b$);
  d := pg_temp._once(d,
$a$     order by created_at limit 1;
  end if;

  if c.id is not null then
$a$,
$b$     order by (merged_into is null) desc, created_at limit 1;
  end if;
  -- A match merged into another account is that account (20261005210100).
  v_hops := 0;
  while c.id is not null and c.merged_into is not null and v_hops < 5 loop
    select * into c from customers where id = c.merged_into;
    v_hops := v_hops + 1;
  end loop;

  if c.id is not null then
$b$);
  d := pg_temp._once(d,
$a$      privacy_version = case when privacy_version is null or privacy_version < a.privacy_version then a.privacy_version else privacy_version end,
      privacy_at      = case when privacy_version is null or privacy_version < a.privacy_version then a.updated_at else privacy_at end,
$a$,
$b$      -- an application that carries no consent records none (20261005210100)
      privacy_version = case when nullif(a.privacy_version, '') is not null and (privacy_version is null or privacy_version < a.privacy_version) then a.privacy_version else privacy_version end,
      privacy_at      = case when nullif(a.privacy_version, '') is not null and (privacy_version is null or privacy_version < a.privacy_version) then a.updated_at else privacy_at end,
$b$);
  d := pg_temp._once(d,
$a$      a.privacy_version, a.updated_at, a.ride_news, a.updated_at);
$a$,
$b$      nullif(a.privacy_version, ''), case when nullif(a.privacy_version, '') is not null then a.updated_at end, a.ride_news, a.updated_at);
$b$);
  execute d;
end $sca$;


-- ── 2. staff_learn_schedule: a merged match is its keeper (patched from live) ─────────────────
do $sls$
declare d text;
begin
  d := pg_get_functiondef('public.staff_learn_schedule(uuid,timestamp with time zone,text,text)'::regprocedure);
  if position('(20261005210100)' in d) > 0 then
    raise notice 'staff_learn_schedule already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$       where (lower(trim(email)) = lower(a.email) or lower(trim(apple_email)) = lower(a.email)) and merged_into is null
       order by (lower(trim(email)) = lower(a.email)) desc nulls last, created_at limit 1;
$a$,
$b$       where (lower(trim(email)) = lower(a.email) or lower(trim(apple_email)) = lower(a.email))
       order by (merged_into is null) desc, (lower(trim(email)) = lower(a.email)) desc nulls last, created_at limit 1;
$b$);
  d := pg_temp._once(d,
$a$= v_digits and merged_into is null
         order by created_at limit 1;
      end if;
    end if;
$a$,
$b$= v_digits
         order by (merged_into is null) desc, created_at limit 1;
      end if;
      -- A match merged into another account is that account, never a new one (20261005210100).
      v_hops := 0;
      while c.id is not null and c.merged_into is not null and v_hops < 5 loop
        select * into c from customers where id = c.merged_into; v_hops := v_hops + 1;
      end loop;
    end if;
$b$);
  execute d;
end $sls$;


-- ── 3. staff_merge_customers folds two open correction flags (patched from live) ──────────────
do $smc$
declare d text;
begin
  d := pg_get_functiondef('public.staff_merge_customers(text,text,text,text,text)'::regprocedure);
  if position('(20261005210100)' in d) > 0 then
    raise notice 'staff_merge_customers already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  bd customer_badges%rowtype; bdg_moved text[] := '{}'; bdg_dup jsonb := '[]'::jsonb;
$a$,
$b$  bd customer_badges%rowtype; bdg_moved text[] := '{}'; bdg_dup jsonb := '[]'::jsonb;
  kf customer_flags%rowtype; df customer_flags%rowtype;
$b$);
  d := pg_temp._once(d,
$a$  with u as (update customer_flags set customer_id = p_keep where customer_id = p_drop returning id)
$a$,
$b$  -- Both accounts may have a correction flag open (one pending per account,
  -- customer_flags_one_pending): the dropped one's fields join the keeper's flag and it is
  -- withdrawn before it moves; unmerge puts both back (20261005210100).
  select * into kf from customer_flags where customer_id = p_keep and status = 'pending' for update;
  select * into df from customer_flags where customer_id = p_drop and status = 'pending' for update;
  if kf.id is not null and df.id is not null then
    update customer_flags
       set fields = kf.fields || array(select f from unnest(df.fields) f where f <> all(kf.fields))
     where id = kf.id;
    update customer_flags set status = 'withdrawn', answered_at = now() where id = df.id;
    mv := mv || jsonb_build_object('flag_fold',
            jsonb_build_object('keep', kf.id, 'drop', df.id, 'keep_fields', to_jsonb(kf.fields)));
  end if;
  with u as (update customer_flags set customer_id = p_keep where customer_id = p_drop returning id)
$b$);
  execute d;
end $smc$;


-- ── 3 + 18. staff_unmerge_customers (patched from live) ───────────────────────────────────────
do $suc$
declare d text;
begin
  d := pg_get_functiondef('public.staff_unmerge_customers(bigint)'::regprocedure);
  if position('(20261005210100)' in d) > 0 then
    raise notice 'staff_unmerge_customers already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  perform 1 from customers where id in (m.keep_id, m.drop_id) order by id for update;
$a$,
$b$  perform 1 from customers where id in (m.keep_id, m.drop_id) order by id for update;
  -- The keeper was merged into a third account since: that merge is undone first (20261005210100).
  if exists (select 1 from customers where id = m.keep_id and merged_into is not null) then
    raise exception 'KEEPER_MERGED' using errcode = '22023';
  end if;
$b$);
  d := pg_temp._once(d,
$a$  update customer_flags set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
$a$,
$b$  update customer_flags set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  -- Two open flags were folded at the merge: the keeper's gets its own fields back, the other
  -- is open again on its own account (20261005210100).
  if m.moved ? 'flag_fold' then
    update customer_flags
       set fields = array(select x from jsonb_array_elements_text(m.moved->'flag_fold'->'keep_fields') with ordinality t(x, o) order by o)
     where id = (m.moved->'flag_fold'->>'keep')::uuid and status = 'pending';
    update customer_flags set status = 'pending', answered_at = null
     where id = (m.moved->'flag_fold'->>'drop')::uuid and customer_id = m.drop_id and status = 'withdrawn'
       and not exists (select 1 from customer_flags x where x.customer_id = m.drop_id and x.status = 'pending');
  end if;
$b$);
  execute d;
end $suc$;


-- ── 23. customer_login meters failures per network (patched from live) ────────────────────────
do $cl$
declare d text;
begin
  d := pg_get_functiondef('public.customer_login(text,text)'::regprocedure);
  if position('(20261005210100)' in d) > 0 then
    raise notice 'customer_login already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$        tried text[] := '{}'; aid text; hops int := 0; main_id text; root text; nxt text; n2 int;
$a$,
$b$        tried text[] := '{}'; aid text; hops int := 0; main_id text; root text; nxt text; n2 int;
        ipk text; ithr login_throttle%rowtype;
$b$);
  d := pg_temp._once(d,
$a$    raise exception 'LOCKED' using errcode = 'P0001';
  end if;
  if position('@' in ident) > 0 then
$a$,
$b$    raise exception 'LOCKED' using errcode = 'P0001';
  end if;
  -- Failed sign-ins per network (20261005210100): 60 within 10 minutes lock the network out for
  -- 15. Generous on purpose: the website signs everyone in from its Worker's one egress address.
  ipk := 'loginip:' || _client_ip();
  select * into ithr from login_throttle where identifier = ipk;
  if ithr.locked_until is not null and ithr.locked_until > now() then
    raise exception 'LOCKED' using errcode = 'P0001';
  end if;
  if position('@' in ident) > 0 then
$b$);
  d := pg_temp._once(d,
$a$  if not ok then
$a$,
$b$  if not ok then
    insert into login_throttle as l (identifier, fails, locked_until, updated_at) values (ipk, 1, null, now())
      on conflict (identifier) do update
        set fails = case when (l.locked_until is not null and l.locked_until <= now()) or l.updated_at < now() - interval '10 minutes'
                         then 1 else l.fails + 1 end,
            locked_until = null,
            updated_at = case when (l.locked_until is not null and l.locked_until <= now()) or l.updated_at < now() - interval '10 minutes'
                              then now() else l.updated_at end
      returning * into ithr;
    if ithr.fails >= 60 then
      update login_throttle set locked_until = now() + interval '15 minutes' where identifier = ipk;
    end if;
$b$);
  execute d;
end $cl$;


-- ── 33. anon writes nothing in these tables (SELECT is left as it is) ─────────────────────────
revoke insert, update, delete on table
  public.cashier_sales, public.push_subscriptions, public.staff, public.staff_actions, public.staff_options,
  public.customer_tags, public.customer_notes, public.desk_waitlist, public.login_throttle
  from anon;


-- ── checks ────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text; t text;
begin
  foreach f in array array['_cust_token_ok','customer_reset','customer_login','staff_community_approve',
                           'staff_learn_schedule','staff_merge_customers','staff_unmerge_customers',
                           'staff_check_operator_pin','staff_set_operator_pin'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef) then
      raise exception '% is missing or lost SECURITY DEFINER', f;
    end if;
  end loop;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_client_ip' and p.prosecdef) then
    raise exception '_client_ip became SECURITY DEFINER';
  end if;
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
               and p.proname in ('_cust_token_ok','customer_reset','customer_login','staff_community_approve',
                                 'staff_learn_schedule','staff_merge_customers','staff_unmerge_customers',
                                 'staff_check_operator_pin','staff_set_operator_pin','_client_ip')
               and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'a function lost its search_path';
  end if;
  if position('(20261005210100)' in pg_get_functiondef('public.staff_community_approve(uuid,text,boolean)'::regprocedure)) = 0
     or position('(20261005210100)' in pg_get_functiondef('public.staff_learn_schedule(uuid,timestamp with time zone,text,text)'::regprocedure)) = 0
     or position('(20261005210100)' in pg_get_functiondef('public.staff_merge_customers(text,text,text,text,text)'::regprocedure)) = 0
     or position('(20261005210100)' in pg_get_functiondef('public.staff_unmerge_customers(bigint)'::regprocedure)) = 0
     or position('(20261005210100)' in pg_get_functiondef('public.customer_login(text,text)'::regprocedure)) = 0 then
    raise exception 'a patch did not take';
  end if;
  if not has_function_privilege('anon', 'public.customer_reset(text,text,text)', 'execute')
     or not has_function_privilege('anon', 'public.customer_login(text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_check_operator_pin(text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_set_operator_pin(text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_merge_customers(text,text,text,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_unmerge_customers(bigint)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_community_approve(uuid,text,boolean)', 'execute')
     or not has_function_privilege('authenticated', 'public.staff_learn_schedule(uuid,timestamp with time zone,text,text)', 'execute') then
    raise exception 'a client grant is missing';
  end if;
  if has_function_privilege('anon', 'public.staff_check_operator_pin(text,text)', 'execute')
     or has_function_privilege('anon', 'public._cust_token_ok(text,text)', 'execute')
     or has_function_privilege('anon', 'public._client_ip()', 'execute') then
    raise exception 'an internal or staff function is executable by anon';
  end if;
  foreach t in array array['cashier_sales','push_subscriptions','staff','staff_actions','staff_options',
                           'customer_tags','customer_notes','desk_waitlist','login_throttle'] loop
    if has_table_privilege('anon', 'public.' || t, 'insert') or has_table_privilege('anon', 'public.' || t, 'update')
       or has_table_privilege('anon', 'public.' || t, 'delete') then
      raise exception 'anon can still write %', t;
    end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'insert') then
      raise exception 'authenticated lost its grant on %', t;
    end if;
  end loop;
  if not has_table_privilege('anon', 'public.error_log', 'insert') then
    raise exception 'error_log lost its anon insert';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261005210100', 'audit_accounts')
on conflict (version) do nothing;

commit;
