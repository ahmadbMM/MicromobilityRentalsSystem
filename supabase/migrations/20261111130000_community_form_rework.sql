-- ============================================================================
-- The community form rework (the user, 2026-11-10: "do them all", the 25 items of reports/Community form
-- enhancement.md). Three database parts; the form and the booking app work before and after each one.
--
-- 1. The rider password rule (B10). Every rider password door asked for 8 or more characters, an upper-case
--    letter and a digit: customer_signup, customer_set_own_password, customer_change_password, customer_fix_save
--    and staff_set_customer_temp_password. NIST SP 800-63B advises against such character rules, and the
--    password is the form field people abandon most. The rule is now 8 or more characters and not one of the
--    common passwords (_pwd_common, the same list the booking app and the website check before calling). Each
--    function is rebuilt from its own live definition (pg_get_functiondef, so SECURITY DEFINER, search_path and
--    grants stay as they are) with only the two character tests swapped for _pwd_common. The vendor, food
--    partner and staff passwords (vendor_set_password, fnb_set_password, staff_reset_password, staff_invite) keep
--    their rule: they are not riders.
--    A booking app from before this change still checks the old, stricter rule first, so it is never refused.
--
-- 2. Where applicants leave the form (B1): community_form_events, anonymous counts the form sends through
--    community_form_log(p_session, p_events) - which screen was reached and passed, which question a refused
--    Continue named, the last screen and question before the page was left, and a send. Never an answer, a name,
--    an account or an address: p_session is a random id the page makes per visit. Staff read the totals through
--    staff_community_form_funnel(p_days). Rows older than 180 days are removed as calls come in.
--
-- 3. A parent or guardian for an applicant under 18 (B23). The form asks the guardian's name, relation and mobile
--    when the birth date shows someone under 18, and the guardian confirms the Privacy Notice; the form sends it
--    after the application through customer_community_guardian(...), which keeps it on the account's newest
--    pending application (community_applications.guardian). The application itself is unchanged.
--
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- Rollback: 1. re-run the five functions as they were (the previous migrations that define them: 20261007233000,
-- 20260922200000, 20261004100000, 20261028120100, 20261029150000); 2./3. drop the three new functions, the table and
-- the column.
-- ============================================================================

begin;

-- ── 1. the rider password rule ───────────────────────────────────────────────────────────────
create or replace function public._pwd_common(p text)
 returns boolean
 language sql
 immutable
 set search_path to 'public'
as $function$
  -- true for a password too easy to guess: one character over and over, or one of the common ones (lower case)
  select p is null
      or p ~ '^(.)\1*$'
      or lower(p) = any (array[
        'password','password1','password12','password123','password1234','passw0rd','p@ssw0rd','p@ssword','pa$$word',
        '12345678','123456789','1234567890','0123456789','87654321','987654321','9876543210','12344321','12341234',
        '11223344','12121212','11112222','13579246','147258369','159753456','741852963','123123123','123456123',
        '00000000','11111111','12345612','1q2w3e4r','1q2w3e4r5t','1qaz2wsx','q1w2e3r4','q1w2e3r4t5','zaq12wsx',
        'qwerty12','qwerty123','qwerty1234','qwertyui','qwertyuiop','qwer1234','1234qwer','asdf1234','asdfghjk',
        'asdfghjkl','zxcvbnm1','zxcvbnmm','abc12345','abcd1234','abcdefgh','abcdefg1','a1234567','a12345678',
        'aa123456','123456aa','123456ab','123qweasd','1234abcd','iloveyou','iloveyou1','iloveyou2','letmein1',
        'welcome1','welcome123','sunshine','sunshine1','princess','princess1','football','football1','baseball',
        'superman','starwars','trustno1','monkey123','dragon123','master123','admin123','administrator','changeme',
        'secret123','computer','internet','whatever','mustang1','shadow123','michael1','jennifer','liverpool',
        'chelsea1','arsenal1','barcelona','realmadrid','alhilal1','alnassr1','alittihad','alahli123','ronaldo7',
        'cristiano','messi123','mohammed','mohammed1','mohamed1','muhammad','muhammad1','ahmed123','ahmad123',
        'abdullah','abdullah1','saudi123','saudiarabia','ksa12345','jeddah123','riyadh123','makkah123','966966966',
        'micromobility','micromobility1','micromobility123','bicycle1','cycling1','bike1234','helloworld',
        'hello123','test1234','testtest','guest123','user1234'
      ]);
$function$;

do $pw$
declare r record; d text; n text; cnt int := 0;
begin
  for r in select p.oid
             from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('customer_signup', 'customer_set_own_password', 'customer_change_password',
                                'customer_fix_save', 'staff_set_customer_temp_password') loop
    d := pg_get_functiondef(r.oid);
    n := regexp_replace(d, '([A-Za-z_][A-Za-z0-9_]*) !~ ''\[A-Z\]'' or \1 !~ ''\[0-9\]''', 'public._pwd_common(\1)', 'g');
    if n <> d then execute n; cnt := cnt + 1; end if;
  end loop;
  raise notice '% rider password functions now keep the rule of 8 or more characters, not a common password', cnt;
end $pw$;


-- ── 2. where applicants leave the form ───────────────────────────────────────────────────────
create table if not exists public.community_form_events (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  session text not null,  -- a random id the page makes per visit; never an account
  lang    text,
  device  text,           -- 'phone' (narrower than 700 px) or 'desktop'
  kind    text not null,  -- open | screen (reached) | done (passed) | error (a refused Continue's question) | leave | made (account made) | sent
  screen  text,
  field   text,
  code    text
);
comment on table public.community_form_events is
  'Anonymous counts of the community form (2026-11-11): screens reached and passed, the question a refused Continue named, the last screen and question before leaving, sends. Never an answer, a name or an account. Written only through community_form_log; read only through staff_community_form_funnel; kept 180 days.';
alter table public.community_form_events enable row level security;
revoke all on public.community_form_events from public, anon, authenticated;
create index if not exists community_form_events_at on public.community_form_events (at);

create or replace function public.community_form_log(p_session text, p_events jsonb)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare e jsonb; k text;
begin
  if coalesce(p_session, '') !~ '^[a-z0-9]{8,32}$' or jsonb_typeof(p_events) is distinct from 'array'
     or jsonb_array_length(p_events) > 40 then
    return false;
  end if;
  if not _ip_gate('cflog', 400, interval '10 minutes') then return false; end if;
  for e in select value from jsonb_array_elements(p_events) loop
    if jsonb_typeof(e) <> 'object' then continue; end if;
    k := e->>'kind';
    if k is null or k !~ '^(open|screen|done|error|leave|made|sent)$' then continue; end if;
    insert into community_form_events (session, lang, device, kind, screen, field, code)
    values (p_session,
            case when coalesce(e->>'lang', '') ~ '^[a-z]{2}$' then e->>'lang' end,
            case when e->>'device' in ('phone', 'desktop') then e->>'device' end,
            k,
            case when coalesce(e->>'screen', '') ~ '^[a-z0-9_-]{1,24}$' then e->>'screen' end,
            case when coalesce(e->>'field', '') ~ '^[a-z0-9_-]{1,32}$' then e->>'field' end,
            case when coalesce(e->>'code', '') ~ '^[A-Za-z0-9_ .-]{1,48}$' then e->>'code' end);
  end loop;
  if random() < 0.01 then delete from community_form_events where at < now() - interval '180 days'; end if;
  return true;
end $function$;
revoke execute on function public.community_form_log(text, jsonb) from public;
grant  execute on function public.community_form_log(text, jsonb) to anon, authenticated;

create or replace function public.staff_community_form_funnel(p_days integer default 30)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 180)));
begin
  if not is_staff() then raise exception 'not staff' using errcode = '42501'; end if;
  return jsonb_build_object(
    'days', greatest(1, least(coalesce(p_days, 30), 180)),
    'visits', (select count(distinct session) from community_form_events where at >= since),
    'made',   (select count(distinct session) from community_form_events where at >= since and kind = 'made'),
    'sent',   (select count(distinct session) from community_form_events where at >= since and kind = 'sent'),
    'screens', coalesce((select jsonb_agg(jsonb_build_object('screen', screen, 'reached', reached, 'passed', passed) order by first_at)
                 from (select screen, min(at) first_at,
                              count(distinct session) filter (where kind = 'screen') reached,
                              count(distinct session) filter (where kind = 'done') passed
                         from community_form_events where at >= since and screen is not null and kind in ('screen', 'done')
                        group by screen) s), '[]'::jsonb),
    'left_at', coalesce((select jsonb_agg(jsonb_build_object('screen', screen, 'field', field, 'n', n) order by n desc)
                 from (select screen, field, count(*) n from community_form_events
                        where at >= since and kind = 'leave' group by screen, field order by n desc limit 15) l), '[]'::jsonb),
    'errors',  coalesce((select jsonb_agg(jsonb_build_object('field', field, 'code', code, 'n', n) order by n desc)
                 from (select field, code, count(*) n from community_form_events
                        where at >= since and kind = 'error' group by field, code order by n desc limit 15) x), '[]'::jsonb),
    'devices', coalesce((select jsonb_object_agg(coalesce(device, '?'), n)
                 from (select device, count(distinct session) n from community_form_events
                        where at >= since group by device) dv), '{}'::jsonb)
  );
end $function$;
revoke execute on function public.staff_community_form_funnel(integer) from public, anon;
grant  execute on function public.staff_community_form_funnel(integer) to authenticated;


-- ── 3. a parent or guardian for an applicant under 18 ────────────────────────────────────────
alter table public.community_applications add column if not exists guardian jsonb;
comment on column public.community_applications.guardian is
  'The parent or legal guardian who confirmed an under-18 application (2026-11-11): {name, relation (parent|guardian), phone, privacy_version, at}. Null for an adult.';

create or replace function public.customer_community_guardian(p_id text, p_token text, p_name text, p_relation text, p_phone text, p_privacy text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_app uuid;
        n  text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
        ph text := regexp_replace(coalesce(p_phone, ''), '[\s()-]', '', 'g');
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then
    return jsonb_build_object('ok', false, 'error', 'denied');
  end if;
  if char_length(n) < 3 or char_length(n) > 80 or n ~ '[0-9<>"`{}@#$%^&*=+_|\\/~:;!?,]' or n !~ ' ' then
    return jsonb_build_object('ok', false, 'error', 'name');
  end if;
  if coalesce(p_relation, '') not in ('parent', 'guardian') then return jsonb_build_object('ok', false, 'error', 'relation'); end if;
  if ph !~ '^\+?[0-9]{8,15}$' then return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if coalesce(p_privacy, '') !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'privacy'); end if;
  select a.id into v_app from community_applications a
   where a.customer_id = p_id and a.status = 'pending' order by a.created_at desc limit 1;
  if v_app is null then return jsonb_build_object('ok', false, 'error', 'none'); end if;
  update community_applications
     set guardian = jsonb_build_object('name', n, 'relation', p_relation, 'phone', ph, 'privacy_version', p_privacy, 'at', now())
   where id = v_app;
  return jsonb_build_object('ok', true);
end $function$;
revoke execute on function public.customer_community_guardian(text, text, text, text, text, text) from public;
grant  execute on function public.customer_community_guardian(text, text, text, text, text, text) to anon, authenticated;


-- ── checks ────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare r record; f text;
begin
  for r in select p.oid::regprocedure::text sig, p.prosecdef, pg_get_functiondef(p.oid) d
             from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('customer_signup', 'customer_set_own_password', 'customer_change_password',
                                'customer_fix_save', 'staff_set_customer_temp_password') loop
    if position('!~ ''[A-Z]''' in r.d) > 0 then raise exception '% still asks for an upper-case letter', r.sig; end if;
    if not r.prosecdef then raise exception '% lost SECURITY DEFINER', r.sig; end if;
  end loop;
  if not exists (select 1 from pg_proc where proname = 'customer_signup' and pronamespace = 'public'::regnamespace
                  and position('_pwd_common' in pg_get_functiondef(oid)) > 0) then
    raise exception 'customer_signup does not check _pwd_common';
  end if;
  if not public._pwd_common('Password1') or public._pwd_common('Corniche ride') or not public._pwd_common('aaaaaaaa') then
    raise exception '_pwd_common answers wrongly';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.community_form_events'::regclass) then
    raise exception 'community_form_events has no row level security';
  end if;
  if has_table_privilege('anon', 'public.community_form_events', 'select') or has_table_privilege('anon', 'public.community_form_events', 'insert') then
    raise exception 'anon can reach community_form_events';
  end if;
  foreach f in array array['public.community_form_log(text,jsonb)', 'public.customer_community_guardian(text,text,text,text,text,text)'] loop
    if not has_function_privilege('anon', f, 'execute') then raise exception '% is not executable by the form', f; end if;
  end loop;
  if has_function_privilege('anon', 'public.staff_community_form_funnel(integer)', 'execute') then
    raise exception 'anon can read the form totals';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111130000', 'community_form_rework')
on conflict (version) do nothing;

commit;
