-- ============================================================================
-- My interests (the user, 2026-11-18, picking it from the Community features list: "My interests: the member picks what
-- they want, such as Road rides, night rides, Petromin nights, women's sessions or learning. Coming up and Updates then
-- show those first, and staff can aim an Ask page or an update at one interest. It can reuse the sport answer every
-- account already has.").
--
--  1. _interest_keys(): the one list of interests (12), the same in member-hub.js (INT_KEYS) and the staff side (INT_K):
--       saturday  Saturday Social Rides (ride_kind saturday)      circuit  circuit nights (jcc)
--       road      sessions that offer Road bikes (a bike session where staff did not close the Road type)
--       petromin  Petromin nights                                 women    sessions for women only (gender_only female);
--                                                                          offered to and kept for female accounts only
--       learn     learning: the workshop kind and learn to ride   runs     Run for Her, the DEFE 5KM Run
--       races     Victory Lap, Arena Heros Hybrid Race            swim     the pool sessions (and a triathlon event)
--       yoga      yoga                                            farm     Farm House Nights
--       charity   the blood donation event
--     Which session matches which key is the app's to say (the session lists are on the phone); the database keeps the
--     keys and who picked them.
--  2. member_interests: one row per member (customer_id), the keys picked (checked against the list), when, and a small
--     meter (20 saves an hour). Staff read it under _staff_mod('community', false); riders reach it only through the two
--     functions below; nobody writes it but member_interests_set.
--  3. _interest_suggest(customer): ticks taken from the sport answer (customers.sport_competes / sport_federations,
--     20261110233000) while the member has never saved: cycling -> saturday, circuit, road; triathlon -> swim, runs, road;
--     athletics and para athletics -> runs; swimming, para swimming, water rescue -> swim; modern pentathlon -> runs, swim;
--     yoga -> yoga; sports for all -> saturday. Never 'women'. Nothing is saved until the member saves.
--  4. member_interests_get(p_id, p_token) -> {ok, saved, keys, suggested, offered} and member_interests_set(p_id, p_token,
--     p_keys) -> {ok, keys}: active Community members only ('member'); an unknown key is refused ('keys'), 'women' from an
--     account that is not female ('women'), a 21st save within an hour ('limit'). An empty list is a save too.
--  5. Ask: an audience of its own, 'interests' (ask_pages.audience), with ask_pages.interest_keys (1 to 12 keys): only an
--     active member who picked one of them sees and answers the page, and the page's other rules (a tag that shuts it,
--     one gender, an age range) still apply. _ask_sees is rebuilt from 20261113010000 (the only migration that defines
--     it; ask_list, ask_page, ask_send, ask_vote, ask_react and staff_ask_stats all ask it, and the website's /ask uses
--     the same functions, so both follow): the three audiences it knew answer exactly as before.
--  6. Updates to an interest: staff_updates_interest(p_interest, p_en, p_ar) (_staff_mod('community', true), at most 5
--     sends an hour): one row in interest_updates (who sent what to whom, and how many it reached) and one Updates row
--     (push_outbox, key 'note', args [English, Arabic], tag 'hub-note-i<id>', so customer_updates calls it a note from
--     the team and the gate decides the push, which stays dormant) for every active member who picked that interest, or
--     every active member when p_interest is null; a line in staff_actions. staff_interest_counts(): how many active
--     members, how many saved, and how many picked each key (staff's numbers; customers never see counts).
--  7. _purge_old (retention): an anonymised account's interests are deleted, patched in place after the line
--     20261115230000 added (the live text keeps every line it has).
--
-- Rollback:
--   drop function if exists public.staff_updates_interest(text, text, text), public.staff_interest_counts(),
--     public.member_interests_set(text, text, text[]), public.member_interests_get(text, text), public._interest_suggest(text);
--   create or replace public._ask_sees as in 20261113010000;
--   delete from public.ask_pages where audience = 'interests' (or move them to 'accounts');
--   alter table public.ask_pages drop constraint if exists ask_pages_interests, drop column if exists interest_keys;
--   put ask_pages_audience_check back to ('link', 'accounts', 'tags');
--   delete from public.push_outbox where tag like 'hub-note-i%';
--   take the member_interests line out of _purge_old;
--   drop table if exists public.interest_updates, public.member_interests; drop function if exists public._interest_keys();
--   delete from supabase_migrations.schema_migrations where version = '20261118210300';
-- Idempotent (a second run changes nothing). Pure ASCII. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $need$
begin
  if to_regclass('public.ask_pages') is null or to_regclass('public.push_words') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'push_outbox' and column_name = 'key')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'customers' and column_name = 'sport_federations') then
    raise exception 'member_interests: apply Ask (20261113010000), the Updates list (20261114080300) and the sport question (20261110233000) first';
  end if;
end $need$;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


/* -- 1. the list --------------------------------------------------------------------------------- */
create or replace function public._interest_keys()
 returns text[]
 language sql
 immutable
 set search_path to 'public'
as $function$
  select array['saturday', 'circuit', 'road', 'petromin', 'women', 'learn', 'runs', 'races', 'swim', 'yoga', 'farm', 'charity']::text[]
$function$;
revoke all on function public._interest_keys() from public, anon, authenticated;


/* -- 2. what each member picked ------------------------------------------------------------------- */
create table if not exists public.member_interests (
  customer_id text primary key references public.customers (id) on update cascade on delete cascade,
  keys        text[] not null default '{}',
  updated_at  timestamptz not null default now(),
  writes      integer not null default 0 check (writes >= 0),
  writes_from timestamptz,
  constraint member_interests_keys check (cardinality(keys) <= 12 and keys <@ public._interest_keys())
);
comment on table public.member_interests is
  'My interests (20261118210300): the interests a Community member picked (keys from _interest_keys()). Written only by member_interests_set; staff read it. writes/writes_from: the save meter (20 an hour).';
alter table public.member_interests enable row level security;
revoke all on public.member_interests from public, anon, authenticated;
drop policy if exists member_interests_staff_read on public.member_interests;
create policy member_interests_staff_read on public.member_interests for select to authenticated
  using ((select public._staff_mod('community', false)));
grant select on public.member_interests to authenticated;

-- what staff sent to an interest (or to every member), and how many it reached
create table if not exists public.interest_updates (
  id           bigint generated always as identity primary key,
  interest     text check (interest is null or interest = any (public._interest_keys())),
  body_en      text not null check (char_length(btrim(body_en)) between 1 and 300),
  body_ar      text not null check (char_length(btrim(body_ar)) between 1 and 300),
  reach        integer not null default 0 check (reach >= 0),
  sent_at      timestamptz not null default now(),
  sent_by      uuid,
  sent_by_name text check (sent_by_name is null or char_length(sent_by_name) <= 80)
);
comment on table public.interest_updates is
  'Updates staff sent to the members who picked an interest (interest null: every member), 20261118210300. Written only by staff_updates_interest; staff read it.';
create index if not exists interest_updates_sent_idx on public.interest_updates (sent_at desc);
alter table public.interest_updates enable row level security;
revoke all on public.interest_updates from public, anon, authenticated;
drop policy if exists interest_updates_staff_read on public.interest_updates;
create policy interest_updates_staff_read on public.interest_updates for select to authenticated
  using ((select public._staff_mod('community', false)));
grant select on public.interest_updates to authenticated;


/* -- 3. the sport answer's suggestions ----------------------------------------------------------- */
create or replace function public._interest_suggest(p_cust text)
 returns text[]
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(array(
    select k.k from unnest(_interest_keys()) with ordinality k(k, n)
     where exists (
       select 1 from customers c, unnest(coalesce(c.sport_federations, '{}'::text[])) f(code)
        where c.id = p_cust and c.sport_competes is true
          and ((f.code = 'cycling' and k.k in ('saturday', 'circuit', 'road'))
            or (f.code = 'triathlon' and k.k in ('swim', 'runs', 'road'))
            or (f.code in ('athletics', 'para_athletics') and k.k = 'runs')
            or (f.code in ('swimming', 'para_swimming', 'water_rescue') and k.k = 'swim')
            or (f.code = 'modern_pentathlon' and k.k in ('runs', 'swim'))
            or (f.code = 'yoga' and k.k = 'yoga')
            or (f.code = 'sports_for_all' and k.k = 'saturday')))
     order by k.n), '{}'::text[])
$function$;
revoke all on function public._interest_suggest(text) from public, anon, authenticated;


/* -- 4. the member's own read and save ------------------------------------------------------------ */
create or replace function public.member_interests_get(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_keys text[]; v_fem boolean;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  select mi.keys into v_keys from member_interests mi where mi.customer_id = p_id;
  v_fem := exists (select 1 from customers c where c.id = p_id and c.gender = 'female');
  return jsonb_build_object(
    'ok', true,
    'saved', v_keys is not null,
    'keys', to_jsonb(coalesce(v_keys, '{}'::text[])),
    'suggested', to_jsonb(case when v_keys is null then _interest_suggest(p_id) else '{}'::text[] end),
    -- the keys this account may pick: 'women' for a female account only
    'offered', to_jsonb(array(select k.k from unnest(_interest_keys()) with ordinality k(k, n) where k.k <> 'women' or v_fem order by k.n)));
end $function$;
revoke all on function public.member_interests_get(text, text) from public;
grant execute on function public.member_interests_get(text, text) to anon, authenticated;

create or replace function public.member_interests_set(p_id text, p_token text, p_keys text[])
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
declare v_keys text[]; v_row member_interests%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  if p_keys is null or cardinality(p_keys) > 24 or not (p_keys <@ _interest_keys()) then return jsonb_build_object('ok', false, 'error', 'keys'); end if;
  if 'women' = any(p_keys) and not exists (select 1 from customers c where c.id = p_id and c.gender = 'female') then
    return jsonb_build_object('ok', false, 'error', 'women');
  end if;
  -- once each, in the list's order
  v_keys := array(select k.k from unnest(_interest_keys()) with ordinality k(k, n) where k.k = any(p_keys) order by k.n);
  select * into v_row from member_interests where customer_id = p_id for update;
  if found and v_row.writes_from > now() - interval '1 hour' and v_row.writes >= 20 then
    return jsonb_build_object('ok', false, 'error', 'limit');
  end if;
  insert into member_interests as mi (customer_id, keys, updated_at, writes, writes_from)
  values (p_id, v_keys, now(), 1, now())
  on conflict (customer_id) do update
     set keys = excluded.keys, updated_at = now(),
         writes = case when mi.writes_from > now() - interval '1 hour' then mi.writes + 1 else 1 end,
         writes_from = case when mi.writes_from > now() - interval '1 hour' then mi.writes_from else now() end;
  return jsonb_build_object('ok', true, 'keys', to_jsonb(v_keys));
end $function$;
revoke all on function public.member_interests_set(text, text, text[]) from public;
grant execute on function public.member_interests_set(text, text, text[]) to anon, authenticated;


/* -- 5. Ask: an audience by interest ------------------------------------------------------------- */
alter table public.ask_pages add column if not exists interest_keys text[] not null default '{}';
alter table public.ask_pages drop constraint if exists ask_pages_audience_check;
alter table public.ask_pages add constraint ask_pages_audience_check check (audience in ('link', 'accounts', 'tags', 'interests'));
-- The list is written out here, not read from _interest_keys(): staff write ask_pages as themselves (the table's RLS
-- policies), and a CHECK runs its functions as the writing role, which may not execute _interest_keys() (revoked from
-- clients above); every staff save of an Ask page would fail with 42501. Keep this list the same as _interest_keys().
alter table public.ask_pages drop constraint if exists ask_pages_interests;
alter table public.ask_pages add constraint ask_pages_interests
  check (cardinality(interest_keys) <= 12
         and interest_keys <@ array['saturday', 'circuit', 'road', 'petromin', 'women', 'learn', 'runs', 'races', 'swim', 'yoga', 'farm', 'charity']::text[]
         and (audience <> 'interests' or cardinality(interest_keys) >= 1));

-- Whether this account (null: nobody signed in) may see the page: its audience, then the rules that narrow it
-- (a tag that shuts it, one gender, an age range; an account with no birth date does not pass an age rule).
-- Rebuilt from 20261113010000: 'accounts' and 'tags' answer as they did; 'interests' (20261118210300) takes an active
-- Community member who picked one of the page's interests.
create or replace function public._ask_sees(p public.ask_pages, p_cust text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case
    when p.audience = 'link' then true
    when p_cust is null then false
    else (case p.audience
            when 'accounts' then true
            when 'interests' then _member_active(p_cust)
                                  and exists (select 1 from member_interests mi where mi.customer_id = p_cust and mi.keys && p.interest_keys)
            else exists (select 1 from customer_tags ct where ct.customer_id = p_cust and ct.tag_id = any(p.tag_ids)
                            and _ctag_active(ct.starts_at, ct.expires_at)) end)
     and not exists (select 1 from customer_tags ct where ct.customer_id = p_cust and ct.tag_id = any(p.not_tag_ids)
                        and _ctag_active(ct.starts_at, ct.expires_at))
     and (p.only_gender is null or exists (select 1 from customers c where c.id = p_cust and c.gender = p.only_gender))
     and ((p.min_age is null and p.max_age is null)
          or exists (select 1 from customers c where c.id = p_cust
                        and _ask_age(c.birth_date) between coalesce(p.min_age, 0) and coalesce(p.max_age, 200)))
  end
$function$;


/* -- 6. staff: the numbers, and an update to an interest ----------------------------------------- */
create or replace function public.staff_interest_counts()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare r jsonb;
begin
  if not _staff_mod('community', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  with m as (select distinct ct.customer_id as id
               from customer_tags ct join customers c on c.id = ct.customer_id
              where ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at) and c.merged_into is null),
       i as (select mi.keys from member_interests mi join m on m.id = mi.customer_id)
  select jsonb_build_object(
    'members', (select count(*) from m),
    'saved', (select count(*) from i),
    'keys', (select jsonb_object_agg(k.k, (select count(*) from i where k.k = any(i.keys))) from unnest(_interest_keys()) k(k)))
    into r;
  return r;
end $function$;
revoke all on function public.staff_interest_counts() from public, anon;
grant execute on function public.staff_interest_counts() to authenticated;

create or replace function public.staff_updates_interest(p_interest text, p_en text, p_ar text)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
declare v_key text := nullif(btrim(coalesce(p_interest, '')), ''); v_en text := btrim(coalesce(p_en, ''));
  v_ar text := btrim(coalesce(p_ar, '')); v_id bigint; v_n integer; v_who text;
begin
  if not _staff_mod('community', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if v_key is not null and not (v_key = any (_interest_keys())) then raise exception 'INTEREST_UNKNOWN' using errcode = 'P0001'; end if;
  if v_en = '' or v_ar = '' then raise exception 'TEXT_REQUIRED' using errcode = 'P0001'; end if;
  if char_length(v_en) > 300 or char_length(v_ar) > 300 then raise exception 'TEXT_LONG' using errcode = 'P0001'; end if;
  -- five an hour, whoever sends them
  perform pg_advisory_xact_lock(hashtext('staff_updates_interest'));
  if (select count(*) from interest_updates u where u.sent_at > now() - interval '1 hour') >= 5 then
    raise exception 'RATE_LIMIT' using errcode = 'P0001';
  end if;
  select left(coalesce(nullif(btrim(s.display_name), ''), u.email, 'staff'), 80) into v_who
    from staff s left join auth.users u on u.id = s.user_id where s.user_id = auth.uid();
  insert into interest_updates (interest, body_en, body_ar, sent_by, sent_by_name)
  values (v_key, v_en, v_ar, auth.uid(), v_who) returning id into v_id;
  -- one Updates row per member, said as the line staff write on a Community post is (_updates_note, 20261114080300)
  insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
  select m.id, 'hub-note-i' || v_id, left(t.title, 120), left(t.body, 300), '/members?src=push', 'community', 'note', array[v_en, v_ar]
    from (select distinct ct.customer_id as id
            from customer_tags ct join customers c on c.id = ct.customer_id
           where ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at) and c.merged_into is null
             and (v_key is null or exists (select 1 from member_interests mi where mi.customer_id = c.id and v_key = any(mi.keys)))) m
    cross join lateral _push_text(m.id, 'note',
                 array[case when (select p.lang from push_prefs p where p.customer_id = m.id) = 'ar' then v_ar else v_en end]) t
  on conflict (customer_id, tag) do nothing;
  get diagnostics v_n = row_count;
  update interest_updates set reach = v_n where id = v_id;
  insert into staff_actions (at, action, who, device, view, user_id, kind, entity, entity_id)
  values (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          left('Update sent to ' || coalesce(v_key, 'all members') || ' (' || v_n || '): ' || v_en, 300),
          coalesce(v_who, 'staff'), 'server', 'community', auth.uid(), 'update', 'interest_update', v_id::text);
  return jsonb_build_object('ok', true, 'id', v_id, 'reach', v_n);
end $function$;
revoke all on function public.staff_updates_interest(text, text, text) from public, anon;
grant execute on function public.staff_updates_interest(text, text, text) to authenticated;


/* -- 7. an anonymised account loses its interests ------------------------------------------------ */
do $do$
declare d text;
begin
  select pg_get_functiondef('public._purge_old(boolean)'::regprocedure) into d;
  if position('(20261118210300)' in d) > 0 then return; end if;
  execute pg_temp._once(d,
    $a$delete from volunteer_ratings where customer_id = any(ids); /* staff's ratings of the volunteer (20261115230000) */$a$,
    $b$delete from volunteer_ratings where customer_id = any(ids); /* staff's ratings of the volunteer (20261115230000) */
      delete from member_interests where customer_id = any(ids); /* the interests a member picked (20261118210300) */$b$);
end $do$;


/* -- 8. checks ----------------------------------------------------------------------------------- */
do $chk$
declare f text;
begin
  foreach f in array array['public._interest_suggest(text)', 'public.member_interests_get(text,text)',
                           'public.member_interests_set(text,text,text[])', 'public._ask_sees(public.ask_pages,text)',
                           'public.staff_interest_counts()', 'public.staff_updates_interest(text,text,text)',
                           'public._purge_old(boolean)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._interest_keys()', 'public._interest_suggest(text)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  foreach f in array array['public.staff_interest_counts()', 'public.staff_updates_interest(text,text,text)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
  end loop;
  if not has_function_privilege('anon', 'public.member_interests_set(text,text,text[])', 'execute') then
    raise exception 'member_interests_set is not executable by riders';
  end if;
  if has_table_privilege('anon', 'public.member_interests', 'select') or has_table_privilege('authenticated', 'public.member_interests', 'insert')
     or has_table_privilege('authenticated', 'public.member_interests', 'update') or has_table_privilege('authenticated', 'public.interest_updates', 'insert') then
    raise exception 'member_interests or interest_updates is writable by a client, or readable by anon';
  end if;
  if position('member_interests' in pg_get_functiondef('public._purge_old(boolean)'::regprocedure)) = 0 then
    raise exception '_purge_old does not delete interests';
  end if;
  -- staff write ask_pages as themselves: none of its CHECKs may call a function clients cannot execute
  if exists (select 1 from pg_constraint c where c.conrelid = 'public.ask_pages'::regclass and c.contype = 'c'
              and position('_interest_keys(' in pg_get_constraintdef(c.oid)) > 0) then
    raise exception 'an ask_pages CHECK calls _interest_keys(), which staff cannot execute';
  end if;
  if (select array_agg(x order by x) from unnest(public._interest_keys()) x)
     is distinct from (select array_agg(x order by x) from unnest(array['saturday', 'circuit', 'road', 'petromin', 'women', 'learn', 'runs', 'races', 'swim', 'yoga', 'farm', 'charity']::text[]) x) then
    raise exception 'ask_pages_interests lists other keys than _interest_keys()';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261118210300', 'member_interests')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check: select cardinality(public._interest_keys()) = 12 as list_12,
--   (select relrowsecurity from pg_class where oid = 'public.member_interests'::regclass) as rls_interests,
--   (select relrowsecurity from pg_class where oid = 'public.interest_updates'::regclass) as rls_updates,
--   position('interests' in (select pg_get_constraintdef(oid) from pg_constraint where conname = 'ask_pages_audience_check')) > 0 as ask_audience,
--   position('member_interests' in pg_get_functiondef('public._ask_sees(public.ask_pages,text)'::regprocedure)) > 0 as ask_sees,
--   position('(20261118210300)' in pg_get_functiondef('public._purge_old(boolean)'::regprocedure)) > 0 as purge,
--   has_function_privilege('anon', 'public.member_interests_get(text,text)', 'execute') as rider_read,
--   not has_function_privilege('anon', 'public.staff_updates_interest(text,text,text)', 'execute') as staff_only,
--   (select name from supabase_migrations.schema_migrations where version = '20261118210300') as ledger;
