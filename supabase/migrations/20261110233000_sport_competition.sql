-- ============================================================================
-- Competing in a sport, on every account (the user, 2026-11-10: "add a question and keep as a field in all
-- accounts and force it on community members the next time they open or sign in the website, Do you compete
-- in a professional/amateur capacity in a sport? yes or no and the answers if yes be" the 74 Saudi sports
-- federations and committees; the same day: "add an option called other that opens a text field to allow them to
-- write their choice and add this choice later on to the list and make it to be visible in the database and add to
-- reports as an option called sports we have and graphs and stats on it").
--
--  1. customers.sport_competes (null = not answered, true, false), customers.sport_federations (the codes a "yes"
--     competes under, one or more; null with anything but yes) and customers.sport_other (what a "yes" wrote under
--     Other: there exactly when 'other' is one of the codes). The codes: the user's 74 (_sport_feds(), never
--     renamed: answers keep them), the ones staff add to the list (sport_options, 'x_...'), and 'other'
--     (_sport_codes()). A trigger refuses a code outside them and stamps customers.sport_answered_at whenever the
--     answer is given or changed (for Analytics > Sports we have: answers over time); the check keeps the columns
--     coherent. Grants as the blood type's: staff read and edit them under the table's RLS; a rider through the
--     functions below. (The user's third message that day: "add as much analytics options as you can for it".)
--  2. sport_options: a sport staff added to the list, usually from what riders wrote under Other; everyone reads it
--     (sport_option_list(), or the table), staff add one through staff_sport_option_add(p_name_en, p_name_ar,
--     p_from), which also moves every account that wrote p_from under Other onto it.
--  3. customer_sport(p_id, p_token) -> (competes, federations, other, asked): the rider's own answer, and whether the
--     account must still give it (asked: a live Community member with no answer). customer_set_sport(p_id, p_token,
--     p_competes, p_federations, p_other) saves it; BAD_INPUT detail 'sport' (no answer), 'sport_feds' (yes with no
--     code or one not in the list) or 'sport_other' (Other with no text, or text outside 2-60 characters).
--  4. _customer_asks (patched in place) asks 'sport' of every live Community member (tag_saturday) with no answer:
--     the check-up opens at sign-in and when the site opens signed in, and customer_create_booking refuses the
--     member's bookings meanwhile (FIX_FIRST). customer_fix_save (patched in place) takes {"sport": {"competes":
--     true, "federations": [codes], "other": "..."}} or {"sport": {"competes": false}}.
--  5. _purge_old (retention) clears the three with the other personal fields.
--
-- Ship the booking app that knows the 'sport' ask BEFORE this runs (the WhatsApp lesson, 2026-10-07: a live app
-- that cannot draw a new ask leaves members with a bare FIX_FIRST).
--
-- Rollback (in this order): run the three patches backwards (each carries '(20261110233000)');
--   drop function if exists public.staff_sport_option_add(text, text, text);
--   drop function if exists public.sport_option_list();
--   drop function if exists public.customer_set_sport(text, text, boolean, text[], text);
--   drop function if exists public.customer_sport(text, text);
--   drop trigger if exists customers_sport_answer on public.customers; drop function if exists public._sport_answer_check();
--   alter table public.customers drop constraint if exists customers_sport_answer,
--     drop column if exists sport_answered_at, drop column if exists sport_other, drop column if exists sport_federations, drop column if exists sport_competes;
--   drop function if exists public._sport_other_clean(text); drop function if exists public._sport_clean(text[]);
--   drop function if exists public._sport_codes(); drop table if exists public.sport_options;
--   drop function if exists public._sport_feds();
-- Idempotent (each patch is skipped when its function already carries '(20261110233000)').
-- Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


-- ── 1. the lists ─────────────────────────────────────────────────────────────────────────────
-- The federations and committees, in the order the user gave them (their groups: endurance, cycling and
-- water sports 1-10; team 11-21; racket 22-26; combat 27-40; strength, gymnastics and adventure 41-46;
-- individual and precision 47-54; equestrian, motorsports and aviation 55-60; winter 61-62; Paralympic and
-- disability 63-68; esports, technology and community 69-74). A code is never renamed: answers keep it.
create or replace function public._sport_feds()
 returns text[]
 language sql
 immutable
 set search_path to 'public'
as $function$
  select array[
    'cycling','triathlon','athletics','swimming','rowing','canoe_kayak','sailing','marine_diving','surfing','water_rescue',
    'football','basketball','volleyball','handball','rugby','hockey','cricket','baseball_softball','dodgeball','lacrosse','american_football',
    'tennis','table_tennis','badminton','squash','padel',
    'boxing','judo','karate','taekwondo','wrestling','jiu_jitsu','muay_thai','mma','kickboxing','sambo','wushu','kurash','kyokushin','aikido',
    'weightlifting','bodybuilding','gymnastics','climbing_hiking','adventure','powerlifting',
    'shooting','archery','fencing','golf','bowling','billiards_snooker','chess','modern_pentathlon',
    'equestrian','polo','camel_racing','auto_moto','paragliding','ballooning',
    'snow_sports','ice_sports',
    'para_athletics','para_swimming','boccia','wheelchair_seated','blind_sports','deaf_sports',
    'esports','rc_robotics','cyber_drones','sports_for_all','yoga','masters'
  ]::text[]
$function$;
revoke execute on function public._sport_feds() from public, anon, authenticated;

-- The sports staff add to the list: everyone reads them (the pickers offer them after the user's list), nobody
-- writes them but staff_sport_option_add.
create table if not exists public.sport_options (
  code       text primary key check (code ~ '^x_[a-z0-9_]{1,40}$'),
  name_en    text not null check (char_length(name_en) between 2 and 80),
  name_ar    text check (name_ar is null or char_length(name_ar) between 2 and 80),
  added_at   timestamptz not null default now(),
  added_by   uuid
);
comment on table public.sport_options is
  'Sports staff added to the sport question''s list, usually from what riders wrote under Other (20261110233000).';
alter table public.sport_options enable row level security;
drop policy if exists sport_options_read on public.sport_options;
create policy sport_options_read on public.sport_options for select using (true);
revoke all on public.sport_options from anon, authenticated;
grant select on public.sport_options to anon, authenticated;

-- Every code an answer may hold: the user's list, the ones added, and 'other'.
create or replace function public._sport_codes()
 returns text[]
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select _sport_feds() || coalesce((select array_agg(o.code order by o.added_at, o.code) from sport_options o), '{}'::text[]) || array['other']
$function$;
revoke execute on function public._sport_codes() from public, anon, authenticated;

-- A "yes" answer's codes as stored: each once, in _sport_codes() order (the user's list, the added ones, Other last);
-- null when there is none or one is not a code.
create or replace function public._sport_clean(p text[])
 returns text[]
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  with l as (select _sport_codes() a)
  select case
    when p is null or cardinality(p) = 0 then null
    when exists (select 1 from unnest(p) x, l where x is null or not (x = any (l.a))) then null
    else (select array(select f from unnest(l.a) with ordinality u(f, i) where f = any (p) order by i) from l)
  end
$function$;
revoke execute on function public._sport_clean(text[]) from public, anon, authenticated;

-- What a rider wrote under Other: its spaces tidied, 2 to 60 characters, no markup; null when it is not.
create or replace function public._sport_other_clean(p text)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$
  select case when v is null or char_length(v) < 2 or char_length(v) > 60 or v ~ '[<>"`{}\\]' then null else v end
    from (select nullif(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'), '') v) x
$function$;
revoke execute on function public._sport_other_clean(text) from public, anon, authenticated;


-- ── 2. the columns ───────────────────────────────────────────────────────────────────────────
alter table public.customers add column if not exists sport_competes boolean;
alter table public.customers add column if not exists sport_federations text[];
alter table public.customers add column if not exists sport_other text;
alter table public.customers add column if not exists sport_answered_at timestamptz;
alter table public.customers drop constraint if exists customers_sport_answer;
alter table public.customers add constraint customers_sport_answer check (
  (sport_competes is true and sport_federations is not null and cardinality(sport_federations) >= 1
     and ('other' = any (sport_federations)) = (sport_other is not null)
     and (sport_other is null or char_length(sport_other) between 2 and 60))
  or (sport_competes is not true and sport_federations is null and sport_other is null));
comment on column public.customers.sport_competes is
  'Competes in a sport, as a professional or an amateur: true, false; null = not answered yet (20261110233000).';
comment on column public.customers.sport_federations is
  'With sport_competes true: the codes they compete under (_sport_codes(): the user''s list, sport_options, other), one or more (20261110233000).';
comment on column public.customers.sport_answered_at is
  'When the sport answer was last given or changed; set by the customers_sport_answer trigger (20261110233000).';
comment on column public.customers.sport_other is
  'What they wrote under Other (with ''other'' among sport_federations); staff can add it to the list (20261110233000).';

-- Codes outside the lists are refused, whoever writes them (staff edit the columns directly), and the moment an
-- answer is given or changed is kept (sport_answered_at; cleared with the answer).
create or replace function public._sport_answer_check()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if new.sport_federations is not null
     and exists (select 1 from unnest(new.sport_federations) x where x is null or not (x = any (_sport_codes()))) then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'sport_feds';
  end if;
  -- staff_sport_option_add moving written answers onto a new code is not the rider answering again
  if coalesce(current_setting('mm.sport_move', true), '') = '1' then return new; end if;
  if tg_op = 'INSERT' or new.sport_competes is distinct from old.sport_competes
     or new.sport_federations is distinct from old.sport_federations or new.sport_other is distinct from old.sport_other then
    new.sport_answered_at := case when new.sport_competes is null then null else now() end;
  end if;
  return new;
end $function$;
revoke execute on function public._sport_answer_check() from public, anon, authenticated;
drop trigger if exists customers_sport_answer on public.customers;
create trigger customers_sport_answer before insert or update of sport_competes, sport_federations, sport_other on public.customers
  for each row execute function public._sport_answer_check();

grant select (sport_competes, sport_federations, sport_other, sport_answered_at) on public.customers to authenticated;
grant update (sport_competes, sport_federations, sport_other) on public.customers to authenticated;


-- ── 3. reading and saving ────────────────────────────────────────────────────────────────────
-- The sports added to the list, for every picker (the user's 74 are the apps' own).
create or replace function public.sport_option_list()
 returns table(code text, name_en text, name_ar text)
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select o.code, o.name_en, o.name_ar from sport_options o order by o.added_at, o.code
$function$;
revoke execute on function public.sport_option_list() from public;
grant  execute on function public.sport_option_list() to anon, authenticated;

create or replace function public.customer_sport(p_id text, p_token text)
 returns table(competes boolean, federations text[], other text, asked boolean)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  -- My Account's card, the check-up's "On your account" and the website's pop-up (20261110233000).
  if not _cust_token_ok(p_id, p_token) then return; end if;
  return query
    select c.sport_competes, c.sport_federations, c.sport_other,
           c.sport_competes is null and exists (select 1 from customer_tags ct
                                                 where ct.customer_id = c.id and ct.tag_id = 'tag_saturday'
                                                   and _ctag_active(ct.starts_at, ct.expires_at))
      from customers c where c.id = p_id;
end $function$;
revoke execute on function public.customer_sport(text, text) from public;
grant  execute on function public.customer_sport(text, text) to anon, authenticated;

create or replace function public.customer_set_sport(p_id text, p_token text, p_competes boolean, p_federations text[] default null, p_other text default null)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare f text[]; o text;
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if p_competes is null then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'sport'; end if;
  if p_competes then
    f := _sport_clean(p_federations);
    if f is null then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'sport_feds'; end if;
    if 'other' = any (f) then
      o := _sport_other_clean(p_other);
      if o is null then raise exception 'BAD_INPUT' using errcode = '22023', detail = 'sport_other'; end if;
    end if;
  end if;
  update customers set sport_competes = p_competes, sport_federations = f, sport_other = o where id = p_id;
  return found;
end $function$;
revoke execute on function public.customer_set_sport(text, text, boolean, text[], text) from public;
grant  execute on function public.customer_set_sport(text, text, boolean, text[], text) to anon, authenticated;

-- Staff add a sport to the list (Analytics > Sports we have): its English name (and Arabic, if given). With p_from,
-- what riders wrote under Other: every account that wrote it (any case, spaces tidied) moves onto the new code. A
-- name already on the added list gets that code back (its Arabic name filled in when it had none). Returns the code.
create or replace function public.staff_sport_option_add(p_name_en text, p_name_ar text default null, p_from text default null)
 returns text
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  en   text := regexp_replace(btrim(coalesce(p_name_en, '')), '\s+', ' ', 'g');
  ar   text := nullif(regexp_replace(btrim(coalesce(p_name_ar, '')), '\s+', ' ', 'g'), '');
  frm  text := _sport_other_clean(p_from);
  v_code text;
  slug text;
begin
  if not coalesce(is_staff(), false) then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  if char_length(en) < 2 or char_length(en) > 80 or en ~ '[<>"`{}\\]' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'sport_name';
  end if;
  if ar is not null and (char_length(ar) < 2 or char_length(ar) > 80 or ar ~ '[<>"`{}\\]') then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'sport_name_ar';
  end if;
  select o.code into v_code from sport_options o where lower(o.name_en) = lower(en);
  if v_code is null then
    slug := btrim(left(regexp_replace(lower(en), '[^a-z0-9]+', '_', 'g'), 30), '_');
    v_code := 'x_' || coalesce(nullif(slug, ''), substr(md5(en), 1, 10));
    if exists (select 1 from sport_options o where o.code = v_code) then v_code := v_code || '_' || substr(md5(en || clock_timestamp()::text), 1, 4); end if;
    insert into sport_options (code, name_en, name_ar, added_by) values (v_code, en, ar, auth.uid());
  elsif ar is not null then
    update sport_options set name_ar = coalesce(name_ar, ar) where sport_options.code = v_code;
  end if;
  if frm is not null then
    perform set_config('mm.sport_move', '1', true); -- keeps their sport_answered_at (_sport_answer_check)
    update customers c
       set sport_federations = _sport_clean(array_remove(c.sport_federations, 'other') || v_code), sport_other = null
     where c.sport_competes is true and 'other' = any (c.sport_federations)
       and lower(regexp_replace(btrim(c.sport_other), '\s+', ' ', 'g')) = lower(frm);
    perform set_config('mm.sport_move', '', true);
  end if;
  return v_code;
end $function$;
revoke execute on function public.staff_sport_option_add(text, text, text) from public, anon;
grant  execute on function public.staff_sport_option_add(text, text, text) to authenticated;


-- ── 4. the Community's check-up asks it ──────────────────────────────────────────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef('public._customer_asks(text)'::regprocedure) into d;
  if position('(20261110233000)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$      f := f || 'instagram'::text;
    end if;
  end if;$a$,
$b$      f := f || 'instagram'::text;
    end if;
    -- and whether they compete in a sport (20261110233000)
    if c.sport_competes is null and not ('sport' = any(f)) then
      f := f || 'sport'::text;
    end if;
  end if;$b$);
  execute d;
end $do$;

do $do$
declare d text;
begin
  select pg_get_functiondef('public.customer_fix_save(text,text,jsonb)'::regprocedure) into d;
  if position('(20261110233000)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
$a$      done := done || k;
      continue;
    end if;
    if not (p_values ? k) then continue; end if;$a$,
$b$      done := done || k;
      continue;
    end if;
    -- Competing in a sport (20261110233000): {competes: true, federations: [codes], other: text with 'other'} or
    -- {competes: false}.
    if k = 'sport' then
      em := p_values->'sport';
      if em is null or jsonb_typeof(em) <> 'object' or jsonb_typeof(em->'competes') <> 'boolean' then continue; end if;
      if (em->>'competes')::boolean then
        if jsonb_typeof(em->'federations') <> 'array' then continue; end if;
        declare
          sf text[] := _sport_clean(array(select jsonb_array_elements_text(em->'federations')));
          so text := _sport_other_clean(em->>'other');
        begin
          if sf is null or ('other' = any(sf) and so is null) then continue; end if;
          update customers set sport_competes = true, sport_federations = sf,
                               sport_other = case when 'other' = any(sf) then so end where id = p_id;
        end;
      else
        update customers set sport_competes = false, sport_federations = null, sport_other = null where id = p_id;
      end if;
      done := done || k;
      continue;
    end if;
    if not (p_values ? k) then continue; end if;$b$);
  execute d;
end $do$;


-- ── 5. retention clears it ───────────────────────────────────────────────────────────────────
do $do$
declare d text;
begin
  select pg_get_functiondef(p.oid) into d from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = '_purge_old';
  if d is null or position('(20261110233000)' in d) > 0 then return; end if;
  d := pg_temp._once(d,
    'blood_type = null /* (20261014180000) */,',
    'blood_type = null /* (20261014180000) */, sport_competes = null, sport_federations = null, sport_other = null, sport_answered_at = null /* (20261110233000) */,');
  execute d;
end $do$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261110233000', 'sport_competition') on conflict (version) do nothing;

commit;

-- Check (one row, every value true):
-- select
--   (select count(*) = 4 from information_schema.columns where table_schema = 'public' and table_name = 'customers'
--      and column_name in ('sport_competes', 'sport_federations', 'sport_other', 'sport_answered_at')) as columns,
--   cardinality(public._sport_feds()) = 74 as list,
--   (select relrowsecurity from pg_class where oid = 'public.sport_options'::regclass) as options_rls,
--   position('(20261110233000)' in pg_get_functiondef('public._customer_asks(text)'::regprocedure)) > 0 as asks,
--   position('(20261110233000)' in pg_get_functiondef('public.customer_fix_save(text,text,jsonb)'::regprocedure)) > 0 as fix_save,
--   position('(20261110233000)' in (select pg_get_functiondef(oid) from pg_proc where proname = '_purge_old' and pronamespace = 'public'::regnamespace)) > 0 as purge,
--   (select bool_and(prosecdef) from pg_proc where pronamespace = 'public'::regnamespace
--      and proname in ('customer_sport', 'customer_set_sport', 'sport_option_list', 'staff_sport_option_add', '_customer_asks', 'customer_fix_save')) as definer,
--   exists (select 1 from supabase_migrations.schema_migrations where version = '20261110233000') as ledger;
