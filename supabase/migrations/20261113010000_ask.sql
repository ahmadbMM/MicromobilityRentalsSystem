-- ============================================================================
-- Ask: MicroMobility's own audience-question tool, at micromobility.sa/ask (the owner, 2026-11-13: "create me a
-- page to get people's suggestions ... let the answers be approved, only show answers that were approved and force
-- everyone to sign in before answering so we know who wrote what, create a link that has the whole new idea under
-- one unified domain ... let us add questions and specify who we want it to be visible for and for how much time
-- ... add all the features ... with all the questions types"). First use: ideas for the community farm day.
--
--  1. Tables, all staff-only under RLS - read by staff who open People (_staff_mod('community')), written by those
--     who may change it - while riders and the website go through the functions:
--       ask_pages      one shareable link (micromobility.sa/ask/<slug>, or its 6-digit code): who sees it
--                      (anyone with the link / signed-in accounts / accounts holding a tag), the window it is open
--                      in, its pace, its round ("Reset results" starts a new one; older answers stay).
--       ask_questions  a page's questions: a kind (word cloud, open answers, Q&A, multiple choice, scales, ranking,
--                      100 points, 2x2 grid, a number, a pin on a picture, a short form, two quiz kinds, a text
--                      slide), its settings (config, checked on save), whether written answers wait for approval,
--                      who sees the results, whether it takes answers, whether the right answer is shown.
--       ask_answers    one row per answer, always under the account that sent it. A written answer to a moderated
--                      question is 'pending' until staff approve it; only approved answers reach anyone else.
--       ask_votes      an upvote on an approved written answer.   ask_reactions   a reaction to a question.
--       ask_secret     the key the results links are signed with (no policy, no grant: functions only).
--  2. For riders (anon key; an answer needs the account's id and session token, checked by _cust_token_ok):
--       ask_list, ask_code, ask_page, ask_live (results, polled with the page's key and last version),
--       ask_screen (the big screen), ask_send, ask_unsend, ask_vote, ask_react.
--     Nothing they answer names another person: results are texts and totals (members see nobody, 2026-11-04).
--  3. For staff (the same section check): staff_ask_pages, staff_ask_page, staff_ask_answers (who wrote what),
--     staff_ask_review (approve / reject), staff_ask_control (start, end, reset, show, open, close, reveal, hide),
--     staff_ask_pending, staff_ask_stats (how many, when, who by group) and staff_ask_segment (a question's
--     results group by group). Pages and questions are written straight to their tables.
--  4. A page narrows who sees it by tag, excluded tag, gender and age; it holds its look (theme, colours, layout)
--     and each question its own (the chart, its colours) as jsonb the pages read; and it may list blocked words,
--     which hold a written answer for staff even on a question that does not wait for approval.
--
-- Rollback:
--   drop function if exists public.staff_ask_pending(), public.staff_ask_stats(bigint, integer),
--     public.staff_ask_segment(bigint, text, integer), public.staff_ask_control(bigint, text, bigint),
--     public.staff_ask_review(bigint[], text), public.staff_ask_answers(bigint, text, integer, bigint, integer),
--     public.staff_ask_page(bigint, integer), public.staff_ask_pages(), public.ask_react(bigint, text, text, text, boolean),
--     public.ask_vote(bigint, text, text, boolean), public.ask_unsend(bigint, text, text),
--     public.ask_send(bigint, text, text, jsonb, text), public.ask_screen(text, text),
--     public.ask_live(text, text, bigint), public.ask_page(text, text, text, text), public.ask_code(text),
--     public.ask_list(text, text);
--   drop table if exists public.ask_reactions, public.ask_votes, public.ask_answers, public.ask_questions,
--     public.ask_pages, public.ask_secret cascade;
--   drop function if exists public._ask_side_bump(), public._ask_answers_bump(), public._ask_answers_stamp(),
--     public._ask_questions_bump(), public._ask_questions_stamp(), public._ask_pages_stamp(), public._ask_who(),
--     public._ask_text(text), public._ask_norm(text), public._ask_has_link(text),
--     public._ask_num_ok(jsonb, numeric, numeric, boolean), public._ask_opts_ok(jsonb, integer, integer),
--     public._ask_ids(jsonb), public._ask_int(jsonb, text, integer), public._ask_config_err(text, jsonb, text),
--     public._ask_key(bigint, text, bigint), public._ask_key_ok(bigint, text), public._ask_age(text),
--     public._ask_band(integer), public._ask_n(numeric, integer);
--   (the functions that take a page or a question go with their tables' "cascade")
--   delete from supabase_migrations.schema_migrations where version = '20261113010000';
-- Idempotent.
-- ============================================================================

begin;

-- 1. tables ------------------------------------------------------------------------------------------------------

create table if not exists public.ask_secret (
  id     integer primary key default 1 check (id = 1),
  secret text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
insert into public.ask_secret (id) values (1) on conflict (id) do nothing;
alter table public.ask_secret enable row level security;
revoke all on public.ask_secret from public, anon, authenticated;

create table if not exists public.ask_pages (
  id          bigint generated always as identity primary key,
  slug        text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 40),
  code        text not null check (code ~ '^[0-9]{6}$'),
  title_en    text not null default '' check (char_length(title_en) <= 120),
  title_ar    text not null default '' check (char_length(title_ar) <= 120),
  intro_en    text not null default '' check (char_length(intro_en) <= 600),
  intro_ar    text not null default '' check (char_length(intro_ar) <= 600),
  audience    text not null default 'link' check (audience in ('link', 'accounts', 'tags')),
  tag_ids     text[] not null default '{}',
  status      text not null default 'draft' check (status in ('draft', 'live', 'ended')),
  opens_at    timestamptz,
  closes_at   timestamptz,
  after_close text not null default 'results' check (after_close in ('results', 'hidden')),
  pace        text not null default 'self' check (pace in ('self', 'live')),
  current_q   bigint,
  listed      boolean not null default true,
  round       integer not null default 1 check (round >= 1),
  notes       text not null default '' check (char_length(notes) <= 2000),
  look        jsonb not null default '{}'::jsonb check (jsonb_typeof(look) = 'object' and length(look::text) <= 4000),
  not_tag_ids text[] not null default '{}',
  only_gender text check (only_gender is null or only_gender in ('male', 'female')),
  min_age     integer check (min_age is null or min_age between 1 and 120),
  max_age     integer check (max_age is null or max_age between 1 and 120),
  block_words text[] not null default '{}',
  ver         bigint not null default 1,
  created_at  timestamptz not null default now(),
  created_by  text,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  constraint ask_pages_slug_key unique (slug),
  constraint ask_pages_code_key unique (code),
  constraint ask_pages_title check (btrim(title_en) <> '' or btrim(title_ar) <> ''),
  constraint ask_pages_window check (opens_at is null or closes_at is null or closes_at > opens_at),
  constraint ask_pages_tags check (audience <> 'tags' or cardinality(tag_ids) between 1 and 20),
  constraint ask_pages_rules check (audience <> 'link' or (only_gender is null and min_age is null and max_age is null and cardinality(not_tag_ids) = 0)),
  constraint ask_pages_ages check (min_age is null or max_age is null or max_age >= min_age),
  constraint ask_pages_block check (cardinality(block_words) <= 200 and cardinality(not_tag_ids) <= 20)
);
alter table public.ask_pages enable row level security;
drop policy if exists ask_pages_staff_read on public.ask_pages;
create policy ask_pages_staff_read on public.ask_pages for select to authenticated using ((select public._staff_mod('community', false)));
drop policy if exists ask_pages_staff_ins on public.ask_pages;
create policy ask_pages_staff_ins on public.ask_pages for insert to authenticated with check ((select public._staff_mod('community', true)));
drop policy if exists ask_pages_staff_upd on public.ask_pages;
create policy ask_pages_staff_upd on public.ask_pages for update to authenticated using ((select public._staff_mod('community', true))) with check ((select public._staff_mod('community', true)));
drop policy if exists ask_pages_staff_del on public.ask_pages;
create policy ask_pages_staff_del on public.ask_pages for delete to authenticated using ((select public._staff_mod('community', true)));
revoke all on public.ask_pages from public, anon, authenticated;
grant select, insert, update, delete on public.ask_pages to authenticated;

create table if not exists public.ask_questions (
  id          bigint generated always as identity primary key,
  page_id     bigint not null references public.ask_pages(id) on delete cascade,
  pos         integer not null default 0,
  kind        text not null check (kind in ('cloud', 'open', 'qa', 'choice', 'scales', 'ranking', 'points', 'grid',
                                            'number', 'pin', 'form', 'quiz', 'quiz_text', 'info')),
  title_en    text not null default '' check (char_length(title_en) <= 300),
  title_ar    text not null default '' check (char_length(title_ar) <= 300),
  help_en     text not null default '' check (char_length(help_en) <= 300),
  help_ar     text not null default '' check (char_length(help_ar) <= 300),
  image       text check (image is null or (image ~ '^https://' and char_length(image) <= 500)),
  config      jsonb not null default '{}'::jsonb,
  look        jsonb not null default '{}'::jsonb check (jsonb_typeof(look) = 'object' and length(look::text) <= 4000),
  moderated   boolean not null default true,
  results     text not null default 'live' check (results in ('live', 'answered', 'closed', 'staff')),
  open        boolean not null default true,
  reveal      boolean not null default false,
  started_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ask_questions_title check (btrim(title_en) <> '' or btrim(title_ar) <> '')
);
create index if not exists ask_questions_page on public.ask_questions (page_id, pos, id);
alter table public.ask_questions enable row level security;
drop policy if exists ask_questions_staff_read on public.ask_questions;
create policy ask_questions_staff_read on public.ask_questions for select to authenticated using ((select public._staff_mod('community', false)));
drop policy if exists ask_questions_staff_ins on public.ask_questions;
create policy ask_questions_staff_ins on public.ask_questions for insert to authenticated with check ((select public._staff_mod('community', true)));
drop policy if exists ask_questions_staff_upd on public.ask_questions;
create policy ask_questions_staff_upd on public.ask_questions for update to authenticated using ((select public._staff_mod('community', true))) with check ((select public._staff_mod('community', true)));
drop policy if exists ask_questions_staff_del on public.ask_questions;
create policy ask_questions_staff_del on public.ask_questions for delete to authenticated using ((select public._staff_mod('community', true)));
revoke all on public.ask_questions from public, anon, authenticated;
grant select, insert, update, delete on public.ask_questions to authenticated;

do $fk$
begin
  if not exists (select 1 from pg_constraint where conname = 'ask_pages_current_q_fkey' and conrelid = 'public.ask_pages'::regclass) then
    alter table public.ask_pages add constraint ask_pages_current_q_fkey
      foreign key (current_q) references public.ask_questions(id) on delete set null;
  end if;
end $fk$;

create table if not exists public.ask_answers (
  id          bigint generated always as identity primary key,
  question_id bigint not null references public.ask_questions(id) on delete cascade,
  page_id     bigint not null references public.ask_pages(id) on delete cascade,
  round       integer not null default 1,
  customer_id text not null references public.customers(id),
  value       jsonb not null,
  body        text check (body is null or char_length(body) between 1 and 500),
  norm        text,
  status      text not null default 'approved' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  answered    boolean not null default false,
  flagged     boolean not null default false,
  score       integer,
  ms          integer,
  lang        text not null default 'en' check (lang ~ '^[a-z]{2}$'),
  created_at  timestamptz not null default now()
);
create index if not exists ask_answers_question on public.ask_answers (question_id, round, status);
create index if not exists ask_answers_customer on public.ask_answers (customer_id, created_at desc);
create index if not exists ask_answers_pending on public.ask_answers (page_id) where status = 'pending';
create index if not exists ask_answers_page on public.ask_answers (page_id, round, id desc);
alter table public.ask_answers enable row level security;
drop policy if exists ask_answers_staff_read on public.ask_answers;
create policy ask_answers_staff_read on public.ask_answers for select to authenticated using ((select public._staff_mod('community', false)));
drop policy if exists ask_answers_staff_upd on public.ask_answers;
create policy ask_answers_staff_upd on public.ask_answers for update to authenticated using ((select public._staff_mod('community', true))) with check ((select public._staff_mod('community', true)));
drop policy if exists ask_answers_staff_del on public.ask_answers;
create policy ask_answers_staff_del on public.ask_answers for delete to authenticated using ((select public._staff_mod('community', true)));
revoke all on public.ask_answers from public, anon, authenticated;
grant select, update, delete on public.ask_answers to authenticated;

create table if not exists public.ask_votes (
  answer_id   bigint not null references public.ask_answers(id) on delete cascade,
  customer_id text not null references public.customers(id),
  created_at  timestamptz not null default now(),
  primary key (answer_id, customer_id)
);
alter table public.ask_votes enable row level security;
drop policy if exists ask_votes_staff_read on public.ask_votes;
create policy ask_votes_staff_read on public.ask_votes for select to authenticated using ((select public._staff_mod('community', false)));
revoke all on public.ask_votes from public, anon, authenticated;
grant select on public.ask_votes to authenticated;

create table if not exists public.ask_reactions (
  question_id bigint not null references public.ask_questions(id) on delete cascade,
  round       integer not null default 1,
  customer_id text not null references public.customers(id),
  kind        text not null check (kind in ('like', 'love', 'clap', 'wow', 'think')),
  created_at  timestamptz not null default now(),
  primary key (question_id, round, customer_id, kind)
);
alter table public.ask_reactions enable row level security;
drop policy if exists ask_reactions_staff_read on public.ask_reactions;
create policy ask_reactions_staff_read on public.ask_reactions for select to authenticated using ((select public._staff_mod('community', false)));
revoke all on public.ask_reactions from public, anon, authenticated;
grant select on public.ask_reactions to authenticated;

-- 2. small helpers -------------------------------------------------------------------------------------------------

-- The signed-in staff member's name, for the stamps.
create or replace function public._ask_who()
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select left(coalesce((select coalesce(nullif(btrim(s.display_name), ''), u.email)
                          from staff s left join auth.users u on u.id = s.user_id
                         where s.user_id = auth.uid()), 'staff'), 60)
$function$;

-- A written answer as it is kept: runs of spaces as one, no control or direction characters, no pictographs.
-- The characters are named by number (chr), so this file stays plain ASCII and a copy and paste cannot lose one:
-- 8203-8207 zero-width and direction marks, 8234-8238 and 8294-8297 direction embeddings and isolates, 65279 the
-- byte-order mark, 65039 and 8205 the emoji joiners; 9728-10175 and 126976-129791 the pictographs.
create or replace function public._ask_text(p text)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$
  select btrim(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''), '[[:space:]]+', ' ', 'g'),
           '[[:cntrl:]' || chr(8203) || '-' || chr(8207) || chr(8234) || '-' || chr(8238) || chr(8294) || '-' || chr(8297)
             || chr(65279) || chr(65039) || chr(8205) || ']', '', 'g'),
           '[' || chr(9728) || '-' || chr(10175) || chr(126976) || '-' || chr(129791) || ']', '', 'g'))
$function$;

-- The key written answers are grouped by: case, punctuation and spaces ignored; in Arabic also the vowel marks
-- (1611-1618), the lengthening dash (1600), the forms of alef (1571, 1573, 1570, 1649 read as 1575), the final ya
-- (1609 as 1610) and the ta marbuta (1577 as 1607).
create or replace function public._ask_norm(p text)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$
  select lower(regexp_replace(
           translate(regexp_replace(coalesce(p, ''), '[' || chr(1611) || '-' || chr(1618) || chr(1600) || ']', '', 'g'),
                     chr(1571) || chr(1573) || chr(1570) || chr(1649) || chr(1609) || chr(1577),
                     repeat(chr(1575), 4) || chr(1610) || chr(1607)),
           '[[:punct:][:space:]]+', '', 'g'))
$function$;

create or replace function public._ask_has_link(p text)
 returns boolean
 language sql
 immutable
 set search_path to 'public'
as $function$
  select coalesce(p, '') ~* '(https?:|www\.|[a-z0-9-]+\.(com|net|org|sa|io|me|ly|co|app|xyz|info|link)(\W|$))'
$function$;

-- A setting that is left out, or a number inside lo..hi (a whole one when p_int).
create or replace function public._ask_num_ok(v jsonb, lo numeric, hi numeric, p_int boolean)
 returns boolean
 language plpgsql
 immutable
 set search_path to 'public'
as $function$
declare n numeric;
begin
  if v is null or jsonb_typeof(v) = 'null' then return true; end if;
  if jsonb_typeof(v) <> 'number' then return false; end if;
  n := (v #>> '{}')::numeric;
  return n between lo and hi and (not p_int or n = trunc(n));
end $function$;

-- A list of options: p_min..p_max objects, each with its own short id and a text in English or Arabic.
create or replace function public._ask_opts_ok(p jsonb, p_min integer, p_max integer)
 returns boolean
 language plpgsql
 immutable
 set search_path to 'public'
as $function$
declare o jsonb; seen text[] := '{}';
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) not between p_min and p_max then return false; end if;
  for o in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(o) <> 'object' or coalesce(o->>'id', '') !~ '^[a-z0-9]{1,12}$' or (o->>'id') = any(seen) then return false; end if;
    if btrim(coalesce(o->>'en', '')) = '' and btrim(coalesce(o->>'ar', '')) = '' then return false; end if;
    if char_length(coalesce(o->>'en', '')) > 80 or char_length(coalesce(o->>'ar', '')) > 80 then return false; end if;
    seen := seen || (o->>'id');
  end loop;
  return true;
end $function$;

-- The ids of a list of options, in order.
create or replace function public._ask_ids(p jsonb)
 returns text[]
 language sql
 immutable
 set search_path to 'public'
as $function$
  select case when jsonb_typeof(p) = 'array'
              then coalesce((select array_agg(o.v->>'id' order by o.n) from jsonb_array_elements(p) with ordinality o(v, n)), '{}')
              else '{}'::text[] end
$function$;

-- A number as the pages get it: rounded, with no trailing zeros.
create or replace function public._ask_n(p numeric, p_places integer)
 returns numeric
 language sql
 immutable
 set search_path to 'public'
as $function$
  select trim_scale(round(p, p_places))
$function$;

create or replace function public._ask_int(c jsonb, k text, d integer)
 returns integer
 language sql
 immutable
 set search_path to 'public'
as $function$
  select case when jsonb_typeof(c->k) = 'number' then ((c->>k)::numeric)::integer else d end
$function$;

-- An account's age in whole years from its birth date (kept as text, YYYY-MM-DD), or null.
create or replace function public._ask_age(p text)
 returns integer
 language plpgsql
 stable
 set search_path to 'public'
as $function$
begin
  if p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then return null; end if;
  return date_part('year', age((now() at time zone 'Asia/Riyadh')::date, left(p, 10)::date))::integer;
exception when others then
  return null;
end $function$;

create or replace function public._ask_band(p integer)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$
  select case when p is null then 'none' when p < 18 then '<18' when p <= 24 then '18-24' when p <= 34 then '25-34'
              when p <= 44 then '35-44' when p <= 54 then '45-54' when p <= 64 then '55-64' else '65+' end
$function$;

-- What is wrong with a question's settings, or null. The pages read a saved config without checking it again.
create or replace function public._ask_config_err(p_kind text, c jsonb, p_image text)
 returns text
 language plpgsql
 immutable
 set search_path to 'public'
as $function$
declare ids text[]; f jsonb; seen text[] := '{}'; a jsonb;
begin
  if c is null or jsonb_typeof(c) <> 'object' then return 'config'; end if;
  if p_kind in ('cloud', 'open', 'qa') then
    if not _ask_num_ok(c->'max_len', case when p_kind = 'cloud' then 5 else 20 end, case when p_kind = 'cloud' then 40 else 500 end, true) then return 'max_len'; end if;
    if not _ask_num_ok(c->'per_person', 1, 10, true) then return 'per_person'; end if;
    if c ? 'votes' and jsonb_typeof(c->'votes') <> 'boolean' then return 'votes'; end if;
  elsif p_kind in ('choice', 'ranking', 'points', 'quiz', 'scales', 'grid') then
    if not _ask_opts_ok(c->'options',
                        case when p_kind in ('scales', 'grid') then 1 else 2 end,
                        case p_kind when 'choice' then 12 when 'quiz' then 6 when 'scales' then 8 else 10 end) then return 'options'; end if;
    ids := _ask_ids(c->'options');
    if p_kind = 'choice' then
      if not _ask_num_ok(c->'max_picks', 1, cardinality(ids), true) then return 'max_picks'; end if;
      if c ? 'change' and jsonb_typeof(c->'change') <> 'boolean' then return 'change'; end if;
    end if;
    if p_kind in ('choice', 'quiz') and (c ? 'correct' or p_kind = 'quiz') then
      if jsonb_typeof(c->'correct') is distinct from 'array' or jsonb_array_length(c->'correct') not between 1 and cardinality(ids) then return 'correct'; end if;
      if exists (select 1 from jsonb_array_elements(c->'correct') x where jsonb_typeof(x) <> 'string' or not ((x #>> '{}') = any(ids))) then return 'correct'; end if;
    end if;
    if p_kind = 'quiz' then
      if not _ask_num_ok(c->'seconds', 5, 120, true) then return 'seconds'; end if;
      if c ? 'speed' and jsonb_typeof(c->'speed') <> 'boolean' then return 'speed'; end if;
    end if;
    if p_kind = 'scales' then
      if not _ask_num_ok(c->'min', 0, 1, true) or not _ask_num_ok(c->'max', 3, 10, true) then return 'range'; end if;
      if char_length(coalesce(c->>'lo_en', '')) > 40 or char_length(coalesce(c->>'lo_ar', '')) > 40
         or char_length(coalesce(c->>'hi_en', '')) > 40 or char_length(coalesce(c->>'hi_ar', '')) > 40 then return 'labels'; end if;
      if c ? 'skip' and jsonb_typeof(c->'skip') <> 'boolean' then return 'skip'; end if;
    end if;
    if p_kind = 'points' and not _ask_num_ok(c->'total', 10, 1000, true) then return 'total'; end if;
    if p_kind = 'grid' then
      if not _ask_num_ok(c->'max', 3, 10, true) then return 'range'; end if;
      if char_length(coalesce(c->>'x_en', '')) > 40 or char_length(coalesce(c->>'x_ar', '')) > 40
         or char_length(coalesce(c->>'y_en', '')) > 40 or char_length(coalesce(c->>'y_ar', '')) > 40 then return 'labels'; end if;
    end if;
  elsif p_kind = 'number' then
    if not _ask_num_ok(c->'min', -1000000000, 1000000000, false) or not _ask_num_ok(c->'max', -1000000000, 1000000000, false) then return 'range'; end if;
    if coalesce((c->>'max')::numeric, 100) <= coalesce((c->>'min')::numeric, 0) then return 'range'; end if;
    if not _ask_num_ok(c->'step', 0.001, 1000000, false) then return 'step'; end if;
    if char_length(coalesce(c->>'unit_en', '')) > 12 or char_length(coalesce(c->>'unit_ar', '')) > 12 then return 'unit'; end if;
    if not _ask_num_ok(c->'correct', coalesce((c->>'min')::numeric, 0), coalesce((c->>'max')::numeric, 100), false) then return 'correct'; end if;
  elsif p_kind = 'pin' then
    if p_image is null then return 'image'; end if;
    if c ? 'correct' and jsonb_typeof(c->'correct') <> 'null' then
      if jsonb_typeof(c->'correct') <> 'object' or not (c->'correct' ? 'x' and c->'correct' ? 'y' and c->'correct' ? 'r')
         or not _ask_num_ok(c->'correct'->'x', 0, 1, false) or not _ask_num_ok(c->'correct'->'y', 0, 1, false)
         or not _ask_num_ok(c->'correct'->'r', 0.01, 0.5, false) then return 'correct'; end if;
    end if;
  elsif p_kind = 'form' then
    if jsonb_typeof(c->'fields') is distinct from 'array' or jsonb_array_length(c->'fields') not between 1 and 8 then return 'fields'; end if;
    for f in select * from jsonb_array_elements(c->'fields') loop
      if jsonb_typeof(f) <> 'object' or coalesce(f->>'id', '') !~ '^[a-z0-9]{1,12}$' or (f->>'id') = any(seen) then return 'fields'; end if;
      if btrim(coalesce(f->>'en', '')) = '' and btrim(coalesce(f->>'ar', '')) = '' then return 'fields'; end if;
      if char_length(coalesce(f->>'en', '')) > 80 or char_length(coalesce(f->>'ar', '')) > 80 then return 'fields'; end if;
      if coalesce(f->>'type', '') not in ('text', 'number', 'choice') then return 'fields'; end if;
      if f->>'type' = 'choice' and not _ask_opts_ok(f->'options', 2, 12) then return 'fields'; end if;
      if f ? 'required' and jsonb_typeof(f->'required') <> 'boolean' then return 'fields'; end if;
      seen := seen || (f->>'id');
    end loop;
  elsif p_kind = 'quiz_text' then
    if jsonb_typeof(c->'accept') is distinct from 'array' or jsonb_array_length(c->'accept') not between 1 and 10 then return 'accept'; end if;
    for a in select * from jsonb_array_elements(c->'accept') loop
      if jsonb_typeof(a) <> 'string' or _ask_norm(a #>> '{}') = '' or char_length(a #>> '{}') > 80 then return 'accept'; end if;
    end loop;
    if not _ask_num_ok(c->'seconds', 5, 120, true) then return 'seconds'; end if;
    if c ? 'speed' and jsonb_typeof(c->'speed') <> 'boolean' then return 'speed'; end if;
    if not _ask_num_ok(c->'max_len', 5, 80, true) then return 'max_len'; end if;
  end if;
  return null;
end $function$;

-- A page's results key: p_kind 'rk' changes every six hours (p_bucket), 'screen' is the big screen's and stays.
create or replace function public._ask_key(p_page bigint, p_kind text, p_bucket bigint)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select substr(md5((select secret from ask_secret where id = 1) || ':' || p_kind || ':' || p_page || ':' || coalesce(p_bucket, 0)), 1, 24)
$function$;

-- 'screen' for the big screen's key, 'rk' for a key ask_page gave in the last 6 to 12 hours, else null.
create or replace function public._ask_key_ok(p_page bigint, p_key text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when p_key is null or char_length(p_key) <> 24 then null
              when p_key = _ask_key(p_page, 'screen', 0) then 'screen'
              when p_key in (_ask_key(p_page, 'rk', floor(extract(epoch from now()) / 21600)::bigint),
                             _ask_key(p_page, 'rk', floor(extract(epoch from now()) / 21600)::bigint - 1)) then 'rk'
              else null end
$function$;

-- 3. what the database keeps in step -------------------------------------------------------------------------------

-- A page: its code on insert, the stamps, and its version (ver), which moves on every staff edit. The database's
-- own bumps (an approved answer, a vote) move ver themselves and leave the stamps alone.
create or replace function public._ask_pages_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_code text; i integer := 0;
begin
  new.slug := lower(btrim(new.slug));
  new.block_words := coalesce((select array_agg(distinct w.w) from (select left(btrim(x), 40) as w from unnest(new.block_words) x) w
                                where _ask_norm(w.w) <> ''), '{}');
  if tg_op = 'INSERT' then
    if new.code is null or new.code !~ '^[0-9]{6}$' or exists (select 1 from ask_pages where code = new.code) then
      loop
        v_code := (100000 + floor(random() * 900000)::integer)::text;
        exit when not exists (select 1 from ask_pages where code = v_code);
        i := i + 1;
        if i > 200 then raise exception 'ASK_CODE'; end if;
      end loop;
      new.code := v_code;
    end if;
    new.created_at := now();
    new.created_by := _ask_who();
    new.updated_at := new.created_at;
    new.updated_by := new.created_by;
    new.ver := 1;
    new.round := 1;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.code := old.code;
    -- a round only moves forward, and so does the version: an edit that carries an older copy of either (a staff
    -- screen saving the row it read a minute ago) cannot take the page back
    if new.round is null or new.round < old.round then new.round := old.round; end if;
    if new.ver is null or new.ver <= old.ver then
      new.ver := old.ver + 1;
      new.updated_at := now();
      if auth.uid() is not null then new.updated_by := _ask_who(); end if;
    end if;
  end if;
  return new;
end $function$;
drop trigger if exists ask_pages_stamp on public.ask_pages;
create trigger ask_pages_stamp before insert or update on public.ask_pages
  for each row execute function public._ask_pages_stamp();

-- A question: its settings are checked, and a change moves its page's version.
create or replace function public._ask_questions_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_err text;
begin
  if tg_op = 'UPDATE' then
    new.page_id := old.page_id;
    new.created_at := old.created_at;
    if new.kind <> old.kind and exists (select 1 from ask_answers where question_id = old.id) then
      raise exception 'ASK_KIND_LOCKED' using errcode = '23514';
    end if;
  end if;
  new.updated_at := now();
  v_err := _ask_config_err(new.kind, new.config, new.image);
  if v_err is not null then raise exception 'ASK_CONFIG %', v_err using errcode = '23514'; end if;
  return new;
end $function$;
drop trigger if exists ask_questions_stamp on public.ask_questions;
create trigger ask_questions_stamp before insert or update on public.ask_questions
  for each row execute function public._ask_questions_stamp();

create or replace function public._ask_questions_bump()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  update ask_pages set ver = ver + 1 where id = coalesce(new.page_id, old.page_id);
  return null;
end $function$;
drop trigger if exists ask_questions_bump on public.ask_questions;
create trigger ask_questions_bump after insert or update or delete on public.ask_questions
  for each row execute function public._ask_questions_bump();

-- An answer: its grouping key, and who reviewed it when its status moves.
create or replace function public._ask_answers_stamp()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if tg_op = 'UPDATE' then
    new.question_id := old.question_id;
    new.page_id := old.page_id;
    new.round := old.round;
    new.customer_id := old.customer_id;
    new.value := old.value;
    new.created_at := old.created_at;
    if new.body is distinct from old.body then
      if old.body is null then new.body := null; else new.body := nullif(_ask_text(new.body), ''); end if;
      if old.body is not null and new.body is null then raise exception 'ASK_EMPTY' using errcode = '23514'; end if;
    end if;
    if new.status is distinct from old.status then
      new.reviewed_at := now();
      new.reviewed_by := _ask_who();
    end if;
  end if;
  new.norm := case when new.body is null then null else _ask_norm(new.body) end;
  return new;
end $function$;
drop trigger if exists ask_answers_stamp on public.ask_answers;
create trigger ask_answers_stamp before insert or update on public.ask_answers
  for each row execute function public._ask_answers_stamp();

-- A page's version moves once per statement that changes what riders can see: an approved answer added, changed
-- or removed. An answer still waiting changes nothing for them.
create or replace function public._ask_answers_bump()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if tg_op = 'INSERT' then
    update ask_pages p set ver = p.ver + 1 where p.id in (select n.page_id from new_rows n where n.status = 'approved');
  elsif tg_op = 'DELETE' then
    update ask_pages p set ver = p.ver + 1 where p.id in (select o.page_id from old_rows o where o.status = 'approved');
  else
    update ask_pages p set ver = p.ver + 1
     where p.id in (select n.page_id from new_rows n join old_rows o on o.id = n.id
                     where (o.status = 'approved' or n.status = 'approved')
                       and (o.status, o.body, o.answered) is distinct from (n.status, n.body, n.answered));
  end if;
  return null;
end $function$;
drop trigger if exists ask_answers_bump_ins on public.ask_answers;
create trigger ask_answers_bump_ins after insert on public.ask_answers
  referencing new table as new_rows for each statement execute function public._ask_answers_bump();
drop trigger if exists ask_answers_bump_upd on public.ask_answers;
create trigger ask_answers_bump_upd after update on public.ask_answers
  referencing old table as old_rows new table as new_rows for each statement execute function public._ask_answers_bump();
drop trigger if exists ask_answers_bump_del on public.ask_answers;
create trigger ask_answers_bump_del after delete on public.ask_answers
  referencing old table as old_rows for each statement execute function public._ask_answers_bump();

-- A vote or a reaction moves its page's version too.
create or replace function public._ask_side_bump()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if tg_table_name = 'ask_votes' then
    update ask_pages p set ver = p.ver + 1
     where p.id = (select a.page_id from ask_answers a where a.id = coalesce(new.answer_id, old.answer_id));
  else
    update ask_pages p set ver = p.ver + 1
     where p.id = (select q.page_id from ask_questions q where q.id = coalesce(new.question_id, old.question_id));
  end if;
  return null;
end $function$;
drop trigger if exists ask_votes_bump on public.ask_votes;
create trigger ask_votes_bump after insert or delete on public.ask_votes
  for each row execute function public._ask_side_bump();
drop trigger if exists ask_reactions_bump on public.ask_reactions;
create trigger ask_reactions_bump after insert or delete on public.ask_reactions
  for each row execute function public._ask_side_bump();

-- 4. reading a page ------------------------------------------------------------------------------------------------

-- 'none' (a draft), 'soon', 'ok' or 'closed'.
create or replace function public._ask_state(p public.ask_pages)
 returns text
 language sql
 stable
 set search_path to 'public'
as $function$
  select case when p.status = 'draft' then 'none'
              when p.status = 'ended' then 'closed'
              when p.opens_at is not null and p.opens_at > now() then 'soon'
              when p.closes_at is not null and p.closes_at <= now() then 'closed'
              else 'ok' end
$function$;

-- Whether this account (null: nobody signed in) may see the page: its audience, then the rules that narrow it
-- (a tag that shuts it, one gender, an age range; an account with no birth date does not pass an age rule).
create or replace function public._ask_sees(p public.ask_pages, p_cust text)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case
    when p.audience = 'link' then true
    when p_cust is null then false
    else (p.audience = 'accounts'
          or exists (select 1 from customer_tags ct where ct.customer_id = p_cust and ct.tag_id = any(p.tag_ids)
                        and _ctag_active(ct.starts_at, ct.expires_at)))
     and not exists (select 1 from customer_tags ct where ct.customer_id = p_cust and ct.tag_id = any(p.not_tag_ids)
                        and _ctag_active(ct.starts_at, ct.expires_at))
     and (p.only_gender is null or exists (select 1 from customers c where c.id = p_cust and c.gender = p.only_gender))
     and ((p.min_age is null and p.max_age is null)
          or exists (select 1 from customers c where c.id = p_cust
                        and _ask_age(c.birth_date) between coalesce(p.min_age, 0) and coalesce(p.max_age, 200)))
  end
$function$;

-- A question's approved answers of a round; p_only narrows them to some accounts (staff's breakdowns).
create or replace function public._ask_rows(p_question bigint, p_round integer, p_only text[])
 returns setof public.ask_answers
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select a.* from ask_answers a
   where a.question_id = p_question and a.round = p_round and a.status = 'approved'
     and (p_only is null or a.customer_id = any(p_only))
$function$;

-- A question's results. p_staff: with the right answers and the typed quiz answers, whatever `reveal` says.
create or replace function public._ask_result(q public.ask_questions, p_round integer, p_staff boolean, p_only text[])
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  r jsonb; c jsonb := q.config; v_n integer; v_min numeric; v_max numeric; v_show boolean := p_staff or q.reveal;
begin
  if q.kind = 'info' then return null; end if;
  select count(*) into v_n from _ask_rows(q.id, p_round, p_only) a where true;

  if q.kind = 'cloud' then
    select jsonb_build_object('n', v_n,
             'people', (select count(distinct a.customer_id) from _ask_rows(q.id, p_round, p_only) a where true),
             'words', coalesce(jsonb_agg(jsonb_build_object('w', g.w, 'n', g.n) order by g.n desc, g.last desc), '[]'::jsonb))
      into r
      from (select mode() within group (order by a.body) as w, count(*)::integer as n, max(a.id) as last
              from _ask_rows(q.id, p_round, p_only) a
             where true and coalesce(a.norm, '') <> ''
             group by a.norm order by count(*) desc, max(a.id) desc limit 150) g;

  elsif q.kind in ('open', 'qa') then
    select jsonb_build_object('n', v_n, 'items', coalesce(jsonb_agg(
             case when q.kind = 'qa' then jsonb_build_object('id', x.id, 't', x.body, 'v', x.v, 'a', x.answered)
                  else jsonb_build_object('id', x.id, 't', x.body, 'v', x.v) end
             order by (q.kind = 'qa' and x.answered), x.v desc, x.id desc), '[]'::jsonb))
      into r
      from (select a.id, a.body, a.answered, (select count(*) from ask_votes v where v.answer_id = a.id)::integer as v
              from _ask_rows(q.id, p_round, p_only) a
             where true
             order by (q.kind = 'qa' and a.answered), 4 desc, a.id desc limit 100) x;

  elsif q.kind in ('choice', 'quiz') then
    select jsonb_build_object('n', v_n, 'counts', coalesce(jsonb_object_agg(o.id,
             (select count(*) from _ask_rows(q.id, p_round, p_only) a where true and a.value->'o' ? o.id)::integer), '{}'::jsonb))
      into r from unnest(_ask_ids(c->'options')) o(id);
    if v_show and c ? 'correct' then r := r || jsonb_build_object('correct', c->'correct'); end if;

  elsif q.kind = 'scales' then
    v_min := _ask_int(c, 'min', 1); v_max := _ask_int(c, 'max', 5);
    select jsonb_build_object('n', v_n,
             'avg', coalesce(jsonb_object_agg(o.id, (select _ask_n(avg((a.value->'s'->>o.id)::numeric), 2) from _ask_rows(q.id, p_round, p_only) a
                      where true and a.value->'s' ? o.id)), '{}'::jsonb),
             'dist', coalesce(jsonb_object_agg(o.id, (select jsonb_agg((select count(*) from _ask_rows(q.id, p_round, p_only) a
                      where true and (a.value->'s'->>o.id)::numeric = g.x)::integer order by g.x)
                      from generate_series(v_min::integer, v_max::integer) g(x))), '{}'::jsonb))
      into r from unnest(_ask_ids(c->'options')) o(id);

  elsif q.kind = 'ranking' then
    with pl as (select e.id, e.ord::integer as ord, jsonb_array_length(a.value->'r') as k
                  from _ask_rows(q.id, p_round, p_only) a cross join lateral jsonb_array_elements_text(a.value->'r') with ordinality e(id, ord))
    select jsonb_build_object('n', v_n,
             'score', coalesce((select jsonb_object_agg(s.id, s.pts) from (select id, sum(k - ord + 1)::integer as pts from pl group by id) s), '{}'::jsonb),
             'pos', coalesce((select jsonb_object_agg(s.id, s.p) from (select id, _ask_n(avg(ord), 2) as p from pl group by id) s), '{}'::jsonb))
      into r;

  elsif q.kind = 'points' then
    with kv as (select e.key as id, (e.value #>> '{}')::numeric as v
                  from _ask_rows(q.id, p_round, p_only) a cross join lateral jsonb_each(a.value->'p') e)
    select jsonb_build_object('n', v_n,
             'sum', coalesce((select jsonb_object_agg(s.id, s.t) from (select id, sum(v)::integer as t from kv group by id) s), '{}'::jsonb),
             'avg', coalesce((select jsonb_object_agg(s.id, s.m) from (select id, _ask_n(sum(v) / greatest(v_n, 1), 1) as m from kv group by id) s), '{}'::jsonb))
      into r;

  elsif q.kind = 'grid' then
    with kv as (select e.key as id, (e.value->>0)::numeric as x, (e.value->>1)::numeric as y
                  from _ask_rows(q.id, p_round, p_only) a cross join lateral jsonb_each(a.value->'g') e)
    select jsonb_build_object('n', v_n,
             'pts', coalesce((select jsonb_object_agg(s.id, jsonb_build_array(s.x, s.y)) from (select id, _ask_n(avg(x), 2) as x, _ask_n(avg(y), 2) as y from kv group by id) s), '{}'::jsonb))
      into r;

  elsif q.kind = 'number' then
    v_min := coalesce((c->>'min')::numeric, 0); v_max := coalesce((c->>'max')::numeric, 100);
    with vals as (select (a.value->>'n')::numeric as v from _ask_rows(q.id, p_round, p_only) a)
    select jsonb_build_object('n', v_n, 'avg', (select _ask_n(avg(v), 2) from vals), 'min', (select _ask_n(min(v), 4) from vals), 'max', (select _ask_n(max(v), 4) from vals),
             'bins', (select jsonb_agg(jsonb_build_object('lo', _ask_n(v_min + (v_max - v_min) * g.i / 10, 4), 'hi', _ask_n(v_min + (v_max - v_min) * (g.i + 1) / 10, 4),
                        'n', (select count(*) from vals where least(9, floor((v - v_min) * 10 / (v_max - v_min))) = g.i)::integer) order by g.i)
                        from generate_series(0, 9) g(i)))
      into r;
    if v_show and jsonb_typeof(c->'correct') = 'number' then r := r || jsonb_build_object('correct', c->'correct'); end if;

  elsif q.kind = 'pin' then
    select jsonb_build_object('n', v_n, 'pins', coalesce(jsonb_agg(jsonb_build_array(_ask_n((x.value->>'x')::numeric, 3), _ask_n((x.value->>'y')::numeric, 3)) order by x.id desc), '[]'::jsonb))
      into r
      from (select a.id, a.value from _ask_rows(q.id, p_round, p_only) a where true order by a.id desc limit 400) x;
    if v_show and jsonb_typeof(c->'correct') = 'object' then r := r || jsonb_build_object('correct', c->'correct'); end if;

  elsif q.kind = 'quiz_text' then
    r := jsonb_build_object('n', v_n, 'right', (select count(*) from _ask_rows(q.id, p_round, p_only) a
           where coalesce(a.score, 0) > 0)::integer);
    if v_show then r := r || jsonb_build_object('correct', c->'accept'); end if;
    -- what people typed is free text nobody approved: staff only
    if p_staff then
      r := r || jsonb_build_object('top', coalesce((select jsonb_agg(jsonb_build_object('w', g.w, 'n', g.n) order by g.n desc)
                 from (select mode() within group (order by a.body) as w, count(*)::integer as n from _ask_rows(q.id, p_round, p_only) a
                        where coalesce(a.norm, '') <> ''
                        group by a.norm order by count(*) desc limit 20) g), '[]'::jsonb));
    end if;

  else  -- form
    r := jsonb_build_object('n', v_n);
  end if;
  return r;
end $function$;

-- A question as riders get it: the right answers stay out until staff reveal them.
create or replace function public._ask_public_q(q public.ask_questions)
 returns jsonb
 language sql
 stable
 set search_path to 'public'
as $function$
  select jsonb_build_object('id', q.id, 'pos', q.pos, 'kind', q.kind, 'title_en', q.title_en, 'title_ar', q.title_ar,
           'help_en', q.help_en, 'help_ar', q.help_ar, 'image', q.image, 'look', q.look,
           'config', case when q.reveal then q.config else q.config - 'correct' - 'accept' end,
           'moderated', q.moderated, 'results', q.results, 'open', q.open, 'reveal', q.reveal, 'started_at', q.started_at)
$function$;

create or replace function public._ask_public_page(p public.ask_pages)
 returns jsonb
 language sql
 stable
 set search_path to 'public'
as $function$
  select jsonb_build_object('id', p.id, 'slug', p.slug, 'code', p.code, 'title_en', p.title_en, 'title_ar', p.title_ar,
           'intro_en', p.intro_en, 'intro_ar', p.intro_ar, 'audience', p.audience, 'pace', p.pace, 'current_q', p.current_q,
           'opens_at', p.opens_at, 'closes_at', p.closes_at, 'round', p.round, 'look', p.look,
           'open', _ask_state(p) = 'ok')
$function$;

-- The questions riders see: all of them at a pace of their own, only those staff have put on screen when live.
create or replace function public._ask_public_qs(p public.ask_pages)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(_ask_public_q(q) order by q.pos, q.id), '[]'::jsonb)
    from ask_questions q
   where q.page_id = p.id and (p.pace = 'self' or q.id = p.current_q or q.started_at is not null)
$function$;

-- What changes while a page is open: each question's state, the results riders may see, the reactions.
create or replace function public._ask_live(p public.ask_pages)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  q ask_questions%rowtype; v_state text := _ask_state(p);
  v_q jsonb := '{}'::jsonb; v_res jsonb := '{}'::jsonb; v_re jsonb;
begin
  if v_state = 'none' then v_state := 'soon'; end if;  -- a draft, opened by staff with the screen key
  for q in select * from ask_questions x where x.page_id = p.id and (p.pace = 'self' or x.id = p.current_q or x.started_at is not null) order by x.pos, x.id loop
    v_q := v_q || jsonb_build_object(q.id::text, jsonb_build_object('open', q.open, 'reveal', q.reveal, 'started_at', q.started_at));
    if q.kind <> 'info' and (q.results in ('live', 'answered') or (q.results = 'closed' and (not q.open or v_state = 'closed'))) then
      v_res := v_res || jsonb_build_object(q.id::text, _ask_result(q, p.round, false, null));
    end if;
  end loop;
  select coalesce(jsonb_object_agg(x.qid, x.counts), '{}'::jsonb) into v_re
    from (select r.question_id::text as qid, jsonb_object_agg(r.kind, r.n) as counts
            from (select rc.question_id, rc.kind, count(*)::integer as n from ask_reactions rc
                   where rc.round = p.round and rc.question_id in (select id from ask_questions where page_id = p.id)
                   group by rc.question_id, rc.kind) r
           group by r.question_id) x;
  return jsonb_build_object('ok', true, 'ver', p.ver, 'now', now(), 'state', v_state, 'open', v_state = 'ok',
           'pace', p.pace, 'current_q', p.current_q, 'round', p.round, 'q', v_q, 'results', v_res, 'reactions', v_re,
           'stats', jsonb_build_object(
             'answers', (select count(*) from ask_answers a where a.page_id = p.id and a.round = p.round and a.status = 'approved'),
             'people', (select count(distinct a.customer_id) from ask_answers a where a.page_id = p.id and a.round = p.round and a.status = 'approved')));
end $function$;

-- An account's own answers to a question, newest first.
create or replace function public._ask_mine(p_question bigint, p_round integer, p_cust text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'value', a.value, 'body', a.body, 'status', a.status,
           'answered', a.answered, 'score', a.score, 'created_at', a.created_at,
           'votes', (select count(*) from ask_votes v where v.answer_id = a.id)::integer) order by a.id desc), '[]'::jsonb)
    from ask_answers a
   where a.question_id = p_question and a.round = p_round and a.customer_id = p_cust
$function$;

-- 5. for riders ------------------------------------------------------------------------------------------------------

create or replace function public.ask_list(p_id text default null, p_token text default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_cust text := case when p_id is not null and p_token is not null and _cust_token_ok(p_id, p_token) then p_id end;
begin
  return jsonb_build_object('signed', v_cust is not null, 'pages', coalesce((
    select jsonb_agg(jsonb_build_object('slug', p.slug, 'title_en', p.title_en, 'title_ar', p.title_ar,
             'intro_en', p.intro_en, 'intro_ar', p.intro_ar, 'opens_at', p.opens_at, 'closes_at', p.closes_at,
             'questions', (select count(*) from ask_questions q where q.page_id = p.id and q.kind <> 'info'),
             'answered', case when v_cust is null then 0 else
               (select count(distinct a.question_id) from ask_answers a where a.page_id = p.id and a.round = p.round and a.customer_id = v_cust) end)
             order by p.closes_at nulls last, p.id desc)
      from ask_pages p
     where p.listed and _ask_state(p) = 'ok' and _ask_sees(p, v_cust)), '[]'::jsonb));
end $function$;

-- The page a 6-digit code opens. Metered per network, so the codes cannot be run through.
create or replace function public.ask_code(p_code text)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  -- Arabic-Indic (1632-1641) and Persian (1776-1785) digits read as 0-9
  v text := regexp_replace(translate(coalesce(p_code, ''),
              (select string_agg(chr(1632 + i), '' order by i) || string_agg(chr(1776 + i), '' order by i) from generate_series(0, 9) i),
              '01234567890123456789'), '[^0-9]', '', 'g');
begin
  if v !~ '^[0-9]{6}$' then return null; end if;
  if not _ip_gate('askcode', 30, interval '10 minutes') then return null; end if;
  return (select p.slug from ask_pages p where p.code = v and _ask_state(p) in ('ok', 'soon'));
end $function$;

create or replace function public.ask_page(p_slug text, p_id text default null, p_token text default null, p_key text default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  p ask_pages%rowtype; v_state text; v_preview boolean;
  v_cust text := case when p_id is not null and p_token is not null and _cust_token_ok(p_id, p_token) then p_id end;
  v_brief jsonb; v_mine jsonb; v_me jsonb;
begin
  select * into p from ask_pages where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then return jsonb_build_object('state', 'none'); end if;
  -- staff look at a page before it opens with its screen key: nothing can be answered that way
  v_preview := _ask_key_ok(p.id, p_key) is not distinct from 'screen';
  v_state := _ask_state(p);
  v_brief := jsonb_build_object('slug', p.slug, 'title_en', p.title_en, 'title_ar', p.title_ar);
  if not v_preview then
    if v_state = 'none' then return jsonb_build_object('state', 'none'); end if;
    -- a page for accounts says nothing of itself, not even its title, to a visitor who is not signed in
    if p.audience <> 'link' and v_cust is null then return jsonb_build_object('state', 'signin'); end if;
    if not _ask_sees(p, v_cust) then return jsonb_build_object('state', 'audience'); end if;
    if v_state = 'soon' then return jsonb_build_object('state', 'soon', 'page', v_brief || jsonb_build_object('opens_at', p.opens_at)); end if;
    if v_state = 'closed' and p.after_close = 'hidden' then return jsonb_build_object('state', 'closed', 'page', v_brief); end if;
  end if;

  select coalesce(jsonb_object_agg(q.id::text, _ask_mine(q.id, p.round, v_cust)), '{}'::jsonb) into v_mine
    from ask_questions q
   where v_cust is not null and q.page_id = p.id
     and exists (select 1 from ask_answers a where a.question_id = q.id and a.round = p.round and a.customer_id = v_cust);

  if v_cust is not null and exists (select 1 from ask_questions q where q.page_id = p.id and q.kind in ('quiz', 'quiz_text')) then
    with tot as (select a.customer_id, sum(coalesce(a.score, 0))::integer as score
                   from ask_answers a join ask_questions q on q.id = a.question_id
                  where a.page_id = p.id and a.round = p.round and q.kind in ('quiz', 'quiz_text')
                  group by a.customer_id)
    select jsonb_build_object('score', t.score, 'rank', 1 + (select count(*) from tot o where o.score > t.score), 'players', (select count(*) from tot))
      into v_me from tot t where t.customer_id = v_cust;
  end if;

  return jsonb_build_object(
    'state', case when v_preview and v_state in ('none', 'soon') then 'ok' else v_state end,
    'preview', v_preview,
    'signed', v_cust is not null,
    'can_answer', v_cust is not null and v_state = 'ok' and not v_preview,
    'now', now(),
    'rk', _ask_key(p.id, 'rk', floor(extract(epoch from now()) / 21600)::bigint),
    'page', _ask_public_page(p),
    'questions', _ask_public_qs(p),
    'mine', v_mine,
    'voted', coalesce((select jsonb_agg(v.answer_id) from ask_votes v join ask_answers a on a.id = v.answer_id
                        where v_cust is not null and v.customer_id = v_cust and a.page_id = p.id and a.round = p.round), '[]'::jsonb),
    'reacted', coalesce((select jsonb_object_agg(x.qid, x.kinds) from (select r.question_id::text as qid, jsonb_agg(r.kind) as kinds
                           from ask_reactions r join ask_questions q on q.id = r.question_id
                          where v_cust is not null and r.customer_id = v_cust and q.page_id = p.id and r.round = p.round
                          group by r.question_id) x), '{}'::jsonb),
    'me', v_me,
    'live', _ask_live(p));
end $function$;

-- Polled by every open page, straight from the browser: the page's key and the last version it holds.
create or replace function public.ask_live(p_slug text, p_key text, p_ver bigint default 0)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare p ask_pages%rowtype; v_kind text; v_state text;
begin
  select * into p from ask_pages where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then return jsonb_build_object('ok', false); end if;
  v_kind := _ask_key_ok(p.id, p_key);
  if v_kind is null then return jsonb_build_object('ok', false); end if;
  v_state := _ask_state(p);
  if v_kind <> 'screen' and (v_state in ('none', 'soon') or (v_state = 'closed' and p.after_close = 'hidden')) then
    return jsonb_build_object('ok', false);
  end if;
  if v_state = 'none' then v_state := 'soon'; end if;
  -- the state rides along even when nothing was written: a page closes by the clock, with no change of version
  if p_ver is not null and p_ver = p.ver then
    return jsonb_build_object('ok', true, 'ver', p.ver, 'same', true, 'state', v_state, 'open', v_state = 'ok', 'now', now());
  end if;
  return _ask_live(p);
end $function$;

-- The big screen: a page with its questions and results, for the key staff's link carries (or a rider's own).
create or replace function public.ask_screen(p_slug text, p_key text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare p ask_pages%rowtype; v_kind text; v_state text;
begin
  select * into p from ask_pages where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then return jsonb_build_object('ok', false); end if;
  v_kind := _ask_key_ok(p.id, p_key);
  if v_kind is null then return jsonb_build_object('ok', false); end if;
  v_state := _ask_state(p);
  if v_kind <> 'screen' and (v_state in ('none', 'soon') or (v_state = 'closed' and p.after_close = 'hidden')) then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'page', _ask_public_page(p), 'questions', _ask_public_qs(p), 'live', _ask_live(p));
end $function$;

create or replace function public.ask_send(p_question bigint, p_id text, p_token text, p_value jsonb, p_lang text default 'en')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  q ask_questions%rowtype; p ask_pages%rowtype; c jsonb; v jsonb := p_value;
  v_lang text := case when coalesce(p_lang, '') ~ '^[a-z]{2}$' then p_lang else 'en' end;
  v_status text := 'approved'; v_text text; v_clean jsonb; v_body text;
  v_ids text[]; v_pick text[]; v_mine integer; v_all integer; v_per integer; v_max numeric; v_min numeric; v_num numeric;
  v_ms integer; v_score integer; v_secs integer; v_right boolean; k text; x jsonb; f jsonb; v_sum numeric := 0; v_flag boolean := false;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  select * into q from ask_questions where id = p_question;
  if not found then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  select * into p from ask_pages where id = q.page_id;
  if _ask_state(p) <> 'ok' then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if not _ask_sees(p, p_id) then return jsonb_build_object('ok', false, 'error', 'audience'); end if;
  if not q.open or q.kind = 'info' or (p.pace = 'live' and q.started_at is null) then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if v is null or jsonb_typeof(v) <> 'object' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if (select count(*) from ask_answers a where a.customer_id = p_id and a.created_at > now() - interval '10 minutes') >= 60 then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  -- one person's answers to one question go in one at a time, so two taps cannot both pass the limit
  perform pg_advisory_xact_lock(hashtextextended('ask:' || q.id || ':' || p_id, 0));
  c := q.config;
  select count(*) filter (where a.status <> 'rejected'), count(*) into v_mine, v_all
    from ask_answers a where a.question_id = q.id and a.round = p.round and a.customer_id = p_id;

  if q.kind in ('cloud', 'open', 'qa') then
    v_text := _ask_text(v->>'t');
    -- a cloud's entry is drawn as it is kept: without the marks typed around it ("BBQ!!" is "BBQ")
    if q.kind = 'cloud' then v_text := regexp_replace(v_text, '^[[:punct:][:space:]]+|[[:punct:][:space:]]+$', '', 'g'); end if;
    if _ask_norm(v_text) = '' then return jsonb_build_object('ok', false, 'error', 'empty'); end if;
    if char_length(v_text) > _ask_int(c, 'max_len', case when q.kind = 'cloud' then 25 else 200 end) then return jsonb_build_object('ok', false, 'error', 'long'); end if;
    if _ask_has_link(v_text) then return jsonb_build_object('ok', false, 'error', 'link'); end if;
    v_per := _ask_int(c, 'per_person', case q.kind when 'cloud' then 3 when 'qa' then 3 else 1 end);
    -- the same words again from the same person add nothing: answered as sent, no second row
    if exists (select 1 from ask_answers a where a.question_id = q.id and a.round = p.round and a.customer_id = p_id
                  and a.status <> 'rejected' and a.norm = _ask_norm(v_text)) then
      return jsonb_build_object('ok', true, 'status', case when q.moderated then 'pending' else 'approved' end, 'score', null,
               'repeat', true, 'mine', _ask_mine(q.id, p.round, p_id));
    end if;
    if v_mine >= v_per or v_all >= v_per * 3 then return jsonb_build_object('ok', false, 'error', 'limit'); end if;
    -- one of the page's blocked words in it: held for staff, whatever the question's own rule
    v_flag := exists (select 1 from unnest(p.block_words) w(w) where _ask_norm(w.w) <> '' and _ask_norm(v_text) like '%' || _ask_norm(w.w) || '%');
    v_status := case when q.moderated or v_flag then 'pending' else 'approved' end;
    v_clean := jsonb_build_object('t', v_text);
    v_body := v_text;

  else
    if v_mine > 0 or v_all > 0 then
      if q.kind = 'choice' and coalesce((c->>'change')::boolean, false) then
        delete from ask_answers a where a.question_id = q.id and a.round = p.round and a.customer_id = p_id;
      else
        return jsonb_build_object('ok', false, 'error', 'answered');
      end if;
    end if;
    v_ids := _ask_ids(c->'options');

    if q.kind in ('choice', 'quiz') then
      if jsonb_typeof(v->'o') is distinct from 'array' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
      select coalesce(array_agg(distinct e.id), '{}') into v_pick from jsonb_array_elements_text(v->'o') e(id);
      if cardinality(v_pick) < 1 or cardinality(v_pick) > (case when q.kind = 'quiz' then 1 else _ask_int(c, 'max_picks', 1) end)
         or not (v_pick <@ v_ids) or cardinality(v_pick) <> jsonb_array_length(v->'o') then
        return jsonb_build_object('ok', false, 'error', 'invalid');
      end if;
      v_clean := jsonb_build_object('o', to_jsonb(v_pick));
      if q.kind = 'quiz' then v_right := c->'correct' ? v_pick[1]; end if;

    elsif q.kind = 'quiz_text' then
      v_text := _ask_text(v->>'t');
      if _ask_norm(v_text) = '' then return jsonb_build_object('ok', false, 'error', 'empty'); end if;
      if char_length(v_text) > _ask_int(c, 'max_len', 40) then return jsonb_build_object('ok', false, 'error', 'long'); end if;
      v_clean := jsonb_build_object('t', v_text);
      v_body := v_text;
      v_right := exists (select 1 from jsonb_array_elements_text(c->'accept') a(t) where _ask_norm(a.t) = _ask_norm(v_text));

    elsif q.kind = 'scales' then
      if jsonb_typeof(v->'s') is distinct from 'object' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
      v_min := _ask_int(c, 'min', 1); v_max := _ask_int(c, 'max', 5);
      for k, x in select * from jsonb_each(v->'s') loop
        if not (k = any(v_ids)) or jsonb_typeof(x) <> 'number' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
        v_num := (x #>> '{}')::numeric;
        if v_num <> trunc(v_num) or v_num not between v_min and v_max then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
        v_sum := v_sum + 1;
      end loop;
      if v_sum < 1 or (not coalesce((c->>'skip')::boolean, false) and v_sum < cardinality(v_ids)) then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
      v_clean := jsonb_build_object('s', v->'s');

    elsif q.kind = 'ranking' then
      if jsonb_typeof(v->'r') is distinct from 'array' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
      select coalesce(array_agg(e.id order by e.n), '{}') into v_pick from jsonb_array_elements_text(v->'r') with ordinality e(id, n);
      if cardinality(v_pick) <> cardinality(v_ids) or not (v_pick <@ v_ids) or not (v_ids <@ v_pick) then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
      v_clean := jsonb_build_object('r', to_jsonb(v_pick));

    elsif q.kind = 'points' then
      if jsonb_typeof(v->'p') is distinct from 'object' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
      v_clean := '{}'::jsonb;
      for k, x in select * from jsonb_each(v->'p') loop
        if not (k = any(v_ids)) or jsonb_typeof(x) <> 'number' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
        v_num := (x #>> '{}')::numeric;
        if v_num <> trunc(v_num) or v_num < 0 then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
        v_sum := v_sum + v_num;
        if v_num > 0 then v_clean := v_clean || jsonb_build_object(k, v_num::integer); end if;
      end loop;
      if v_sum < 1 or v_sum > _ask_int(c, 'total', 100) then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
      v_clean := jsonb_build_object('p', v_clean);

    elsif q.kind = 'grid' then
      if jsonb_typeof(v->'g') is distinct from 'object' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
      v_max := _ask_int(c, 'max', 10);
      for k, x in select * from jsonb_each(v->'g') loop
        if not (k = any(v_ids)) or jsonb_typeof(x) <> 'array' or jsonb_array_length(x) <> 2
           or jsonb_typeof(x->0) <> 'number' or jsonb_typeof(x->1) <> 'number'
           or (x->>0)::numeric not between 0 and v_max or (x->>1)::numeric not between 0 and v_max then
          return jsonb_build_object('ok', false, 'error', 'invalid');
        end if;
        v_sum := v_sum + 1;
      end loop;
      if v_sum < cardinality(v_ids) then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
      v_clean := jsonb_build_object('g', v->'g');

    elsif q.kind = 'number' then
      if jsonb_typeof(v->'n') is distinct from 'number' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
      v_num := (v->>'n')::numeric;
      if v_num not between coalesce((c->>'min')::numeric, 0) and coalesce((c->>'max')::numeric, 100) then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
      v_clean := jsonb_build_object('n', v_num);

    elsif q.kind = 'pin' then
      if jsonb_typeof(v->'x') is distinct from 'number' or jsonb_typeof(v->'y') is distinct from 'number'
         or (v->>'x')::numeric not between 0 and 1 or (v->>'y')::numeric not between 0 and 1 then
        return jsonb_build_object('ok', false, 'error', 'invalid');
      end if;
      v_clean := jsonb_build_object('x', _ask_n((v->>'x')::numeric, 4), 'y', _ask_n((v->>'y')::numeric, 4));

    elsif q.kind = 'form' then
      if jsonb_typeof(v->'f') is distinct from 'object' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
      v_clean := '{}'::jsonb;
      for f in select * from jsonb_array_elements(c->'fields') loop
        k := f->>'id';
        x := v->'f'->k;
        if x is null or jsonb_typeof(x) = 'null' or (jsonb_typeof(x) = 'string' and _ask_text(x #>> '{}') = '') then
          if coalesce((f->>'required')::boolean, true) then return jsonb_build_object('ok', false, 'error', 'empty'); end if;
          continue;
        end if;
        if f->>'type' = 'number' then
          if jsonb_typeof(x) <> 'number' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
          v_clean := v_clean || jsonb_build_object(k, x);
        elsif f->>'type' = 'choice' then
          if jsonb_typeof(x) <> 'string' or not ((x #>> '{}') = any(_ask_ids(f->'options'))) then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
          v_clean := v_clean || jsonb_build_object(k, x);
        else
          if jsonb_typeof(x) <> 'string' then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
          if char_length(_ask_text(x #>> '{}')) > 200 then return jsonb_build_object('ok', false, 'error', 'long'); end if;
          v_clean := v_clean || jsonb_build_object(k, _ask_text(x #>> '{}'));
        end if;
      end loop;
      if v_clean = '{}'::jsonb then return jsonb_build_object('ok', false, 'error', 'empty'); end if;
      v_clean := jsonb_build_object('f', v_clean);

    else
      return jsonb_build_object('ok', false, 'error', 'invalid');
    end if;

    -- a quiz answer: the time it took from the moment the question went on screen, and its points
    if q.kind in ('quiz', 'quiz_text') then
      v_secs := _ask_int(c, 'seconds', case when q.kind = 'quiz' then 20 else 30 end);
      if q.started_at is not null then
        v_ms := greatest(0, (extract(epoch from (clock_timestamp() - q.started_at)) * 1000)::integer);
        if v_ms > v_secs * 1000 + 1500 then return jsonb_build_object('ok', false, 'error', 'late'); end if;
      end if;
      v_score := case when not v_right then 0
                      when v_ms is not null and coalesce((c->>'speed')::boolean, true)
                        then 500 + round(500 * greatest(0, 1 - v_ms / (v_secs * 1000.0)))::integer
                      else 1000 end;
    end if;
  end if;

  insert into ask_answers (question_id, page_id, round, customer_id, value, body, status, flagged, score, ms, lang)
  values (q.id, p.id, p.round, p_id, v_clean, v_body, v_status, v_flag, v_score, v_ms, v_lang);
  return jsonb_build_object('ok', true, 'status', v_status, 'score', v_score, 'mine', _ask_mine(q.id, p.round, p_id));
end $function$;

-- Takes back the account's own answer while it still waits for approval.
create or replace function public.ask_unsend(p_answer bigint, p_id text, p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n integer;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  delete from ask_answers a where a.id = p_answer and a.customer_id = p_id and a.status = 'pending';
  get diagnostics n = row_count;
  return case when n > 0 then jsonb_build_object('ok', true) else jsonb_build_object('ok', false, 'error', 'closed') end;
end $function$;

-- An upvote on an approved written answer of a question that takes votes; never on one's own.
create or replace function public.ask_vote(p_answer bigint, p_id text, p_token text, p_on boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare a ask_answers%rowtype; q ask_questions%rowtype; p ask_pages%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  select * into a from ask_answers where id = p_answer and status = 'approved';
  if not found then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  select * into q from ask_questions where id = a.question_id;
  select * into p from ask_pages where id = a.page_id;
  if _ask_state(p) <> 'ok' or a.round <> p.round or q.kind not in ('open', 'qa')
     or not coalesce((q.config->>'votes')::boolean, q.kind = 'qa') then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if not _ask_sees(p, p_id) then return jsonb_build_object('ok', false, 'error', 'audience'); end if;
  if a.customer_id = p_id then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if coalesce(p_on, true) then
    insert into ask_votes (answer_id, customer_id) values (a.id, p_id) on conflict do nothing;
  else
    delete from ask_votes v where v.answer_id = a.id and v.customer_id = p_id;
  end if;
  return jsonb_build_object('ok', true, 'votes', (select count(*) from ask_votes v where v.answer_id = a.id)::integer);
end $function$;

create or replace function public.ask_react(p_question bigint, p_id text, p_token text, p_kind text, p_on boolean default true)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare q ask_questions%rowtype; p ask_pages%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  if coalesce(p_kind, '') not in ('like', 'love', 'clap', 'wow', 'think') then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  select * into q from ask_questions where id = p_question;
  if not found then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  select * into p from ask_pages where id = q.page_id;
  if _ask_state(p) <> 'ok' then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
  if not _ask_sees(p, p_id) then return jsonb_build_object('ok', false, 'error', 'audience'); end if;
  if coalesce(p_on, true) then
    insert into ask_reactions (question_id, round, customer_id, kind) values (q.id, p.round, p_id, p_kind) on conflict do nothing;
  else
    delete from ask_reactions r where r.question_id = q.id and r.round = p.round and r.customer_id = p_id and r.kind = p_kind;
  end if;
  return jsonb_build_object('ok', true);
end $function$;

-- 6. for staff -----------------------------------------------------------------------------------------------------
-- Ask opens for whoever opens People (the section 'community': _staff_mod, 20261111180200), and is changed by
-- whoever may change it; the Owner role only looks, a Door or volunteer account has neither.

create or replace function public.staff_ask_pages()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not _staff_mod('community', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(to_jsonb(p) || jsonb_build_object(
             'open', _ask_state(p) = 'ok',
             'questions', (select count(*) from ask_questions q where q.page_id = p.id),
             'answers', (select count(*) from ask_answers a where a.page_id = p.id and a.round = p.round),
             'people', (select count(distinct a.customer_id) from ask_answers a where a.page_id = p.id and a.round = p.round),
             'pending', (select count(*) from ask_answers a where a.page_id = p.id and a.round = p.round and a.status = 'pending'))
             order by p.created_at desc, p.id desc)
      from ask_pages p), '[]'::jsonb);
end $function$;

create or replace function public.staff_ask_page(p_page bigint, p_round integer default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare p ask_pages%rowtype; v_round integer;
begin
  if not _staff_mod('community', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into p from ask_pages where id = p_page;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  v_round := coalesce(p_round, p.round);  -- an older round's results stay readable after a reset
  return jsonb_build_object(
    'page', to_jsonb(p) || jsonb_build_object('open', _ask_state(p) = 'ok', 'screen_key', _ask_key(p.id, 'screen', 0), 'shown_round', v_round),
    'questions', coalesce((select jsonb_agg(to_jsonb(q) || jsonb_build_object(
                    'answers', (select count(*) from ask_answers a where a.question_id = q.id and a.round = v_round),
                    'pending', (select count(*) from ask_answers a where a.question_id = q.id and a.round = v_round and a.status = 'pending'),
                    'result', _ask_result(q, v_round, true, null)) order by q.pos, q.id)
                  from ask_questions q where q.page_id = p.id), '[]'::jsonb),
    'board', coalesce((select jsonb_agg(jsonb_build_object('customer_id', t.customer_id, 'name', t.name, 'score', t.score, 'answers', t.n) order by t.score desc, t.ms)
                 from (select a.customer_id, btrim(c.name) as name, sum(coalesce(a.score, 0))::integer as score, count(*)::integer as n, sum(coalesce(a.ms, 0)) as ms
                         from ask_answers a join ask_questions q on q.id = a.question_id join customers c on c.id = a.customer_id
                        where a.page_id = p.id and a.round = v_round and q.kind in ('quiz', 'quiz_text')
                        group by a.customer_id, c.name order by 3 desc, 5 limit 50) t), '[]'::jsonb));
end $function$;

-- Who wrote what, newest first; p_before (an answer's id) and p_limit read on past the first rows.
create or replace function public.staff_ask_answers(p_page bigint, p_status text default null, p_round integer default null,
                                                    p_before bigint default null, p_limit integer default 3000)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_round integer;
begin
  if not _staff_mod('community', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select coalesce(p_round, p.round) into v_round from ask_pages p where p.id = p_page;
  if v_round is null then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'question_id', x.question_id, 'round', x.round, 'customer_id', x.customer_id,
             'name', x.name, 'phone', x.phone, 'value', x.value, 'body', x.body, 'status', x.status, 'answered', x.answered, 'flagged', x.flagged,
             'score', x.score, 'ms', x.ms, 'votes', x.votes, 'lang', x.lang, 'created_at', x.created_at,
             'reviewed_by', x.reviewed_by, 'reviewed_at', x.reviewed_at) order by x.id desc)
      from (select a.*, btrim(c.name) as name, c.phone, (select count(*) from ask_votes v where v.answer_id = a.id)::integer as votes
              from ask_answers a join customers c on c.id = a.customer_id
             where a.page_id = p_page and a.round = v_round and (p_status is null or a.status = p_status)
               and (p_before is null or a.id < p_before)
             order by a.id desc limit least(greatest(coalesce(p_limit, 3000), 1), 5000)) x), '[]'::jsonb);
end $function$;

-- A page's numbers: how many, when, and who by group. The groups count people (accounts), never one person's answers.
create or replace function public.staff_ask_stats(p_page bigint, p_round integer default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare p ask_pages%rowtype; v_round integer; r jsonb;
begin
  if not _staff_mod('community', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into p from ask_pages where id = p_page;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  v_round := coalesce(p_round, p.round);
  with a as (select x.*, (x.created_at at time zone 'Asia/Riyadh') as at_ksa from ask_answers x where x.page_id = p.id and x.round = v_round),
       who as (select c.id, c.gender, _ask_band(_ask_age(c.birth_date)) as band, coalesce(upper(nullif(btrim(c.nationality), '')), 'none') as nat, btrim(c.name) as name,
                      exists (select 1 from customer_tags ct where ct.customer_id = c.id and ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at)) as member
                 from customers c where c.id in (select a.customer_id from a)),
       nat as (select w.nat, count(*)::integer as n, row_number() over (order by count(*) desc, w.nat) as rn from who w group by w.nat)
  select jsonb_build_object(
    'answers', (select count(*) from a),
    'people', (select count(*) from who),
    'approved', (select count(*) from a where a.status = 'approved'),
    'pending', (select count(*) from a where a.status = 'pending'),
    'rejected', (select count(*) from a where a.status = 'rejected'),
    'flagged', (select count(*) from a where a.flagged),
    'audience', case when p.audience = 'link' then null else
                  (select count(*) from customers c where c.archived_at is null and c.merged_into is null and _ask_sees(p, c.id)) end,
    'first_at', (select min(a.created_at) from a),
    'last_at', (select max(a.created_at) from a),
    'by_day', coalesce((select jsonb_agg(jsonb_build_object('d', d.d, 'n', d.n, 'people', d.people) order by d.d)
                 from (select to_char(a.at_ksa, 'YYYY-MM-DD') as d, count(*)::integer as n, count(distinct a.customer_id)::integer as people from a group by 1) d), '[]'::jsonb),
    'by_hour', (select jsonb_agg((select count(*) from a where extract(hour from a.at_ksa)::integer = h.h)::integer order by h.h) from generate_series(0, 23) h(h)),
    'by_gender', jsonb_build_object('male', (select count(*) from who w where w.gender = 'male'), 'female', (select count(*) from who w where w.gender = 'female'),
                   'none', (select count(*) from who w where w.gender is null or w.gender not in ('male', 'female'))),
    'by_age', (select jsonb_object_agg(b.k, (select count(*) from who w where w.band = b.k))
                 from unnest(array['<18', '18-24', '25-34', '35-44', '45-54', '55-64', '65+', 'none']) b(k)),
    'by_member', jsonb_build_object('member', (select count(*) from who w where w.member), 'other', (select count(*) from who w where not w.member)),
    'by_nationality', coalesce((select jsonb_agg(jsonb_build_object('code', t.code, 'n', t.n) order by t.ord, t.n desc, t.code)
                 from (select n.nat as code, n.n, 0 as ord from nat n where n.rn <= 10
                       union all
                       select 'other', sum(n.n)::integer, 1 from nat n where n.rn > 10 having count(*) > 0) t), '[]'::jsonb),
    'by_lang', coalesce((select jsonb_object_agg(l.lang, l.n) from (select a.lang, count(*)::integer as n from a group by a.lang) l), '{}'::jsonb),
    'by_question', coalesce((select jsonb_agg(jsonb_build_object('id', q.id,
                   'answers', (select count(*) from a where a.question_id = q.id),
                   'people', (select count(distinct a.customer_id) from a where a.question_id = q.id),
                   'pending', (select count(*) from a where a.question_id = q.id and a.status = 'pending')) order by q.pos, q.id)
                 from ask_questions q where q.page_id = p.id), '[]'::jsonb),
    'top_people', coalesce((select jsonb_agg(jsonb_build_object('customer_id', t.customer_id, 'name', t.name, 'answers', t.n, 'approved', t.ok) order by t.n desc, t.name)
                 from (select a.customer_id, w.name, count(*)::integer as n, (count(*) filter (where a.status = 'approved'))::integer as ok
                         from a join who w on w.id = a.customer_id group by a.customer_id, w.name order by 3 desc, 2 limit 10) t), '[]'::jsonb))
    into r;
  return r;
end $function$;

-- A question's results, group by group: by gender, age band, Community membership, the answer's language, or the
-- option each person picked in another multiple-choice question of the page ('q:<its id>').
create or replace function public.staff_ask_segment(p_question bigint, p_by text, p_round integer default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare q ask_questions%rowtype; p ask_pages%rowtype; v_round integer; v_other bigint; r jsonb := '[]'::jsonb; s record;
begin
  if not _staff_mod('community', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into q from ask_questions where id = p_question;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  select * into p from ask_pages where id = q.page_id;
  v_round := coalesce(p_round, p.round);
  if coalesce(p_by, '') ~ '^q:[0-9]{1,18}$' then
    v_other := substr(p_by, 3)::bigint;
    if not exists (select 1 from ask_questions o where o.id = v_other and o.page_id = p.id and o.kind in ('choice', 'quiz') and o.id <> q.id) then
      raise exception 'BAD_INPUT' using errcode = '22023';
    end if;
  elsif coalesce(p_by, '') not in ('gender', 'age', 'member', 'lang') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  for s in
    select k.key, array_agg(k.customer_id) as custs
      from (select d.customer_id,
                   case
                     when p_by = 'gender' then coalesce(case when c.gender in ('male', 'female') then c.gender end, 'none')
                     when p_by = 'age' then _ask_band(_ask_age(c.birth_date))
                     when p_by = 'member' then case when exists (select 1 from customer_tags ct where ct.customer_id = c.id and ct.tag_id = 'tag_saturday'
                                                                  and _ctag_active(ct.starts_at, ct.expires_at)) then 'member' else 'other' end
                     when p_by = 'lang' then (select a2.lang from ask_answers a2 where a2.question_id = q.id and a2.round = v_round
                                                and a2.customer_id = d.customer_id and a2.status = 'approved' order by a2.id desc limit 1)
                     else coalesce((select o.value->'o'->>0 from ask_answers o where o.question_id = v_other and o.round = v_round
                                      and o.customer_id = d.customer_id and o.status = 'approved' order by o.id desc limit 1), 'none')
                   end as key
              from (select distinct a.customer_id from ask_answers a where a.question_id = q.id and a.round = v_round and a.status = 'approved') d
              join customers c on c.id = d.customer_id) k
     group by k.key order by k.key
  loop
    r := r || jsonb_build_object('key', s.key, 'n', cardinality(s.custs), 'result', _ask_result(q, v_round, true, s.custs));
  end loop;
  return jsonb_build_object('by', p_by, 'segments', r);
end $function$;

create or replace function public.staff_ask_review(p_ids bigint[], p_status text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n integer;
begin
  if not _staff_mod('community', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if coalesce(p_status, '') not in ('approved', 'rejected', 'pending') then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  update ask_answers a set status = p_status where a.id = any(coalesce(p_ids, '{}')) and a.status <> p_status;
  get diagnostics n = row_count;
  return n;
end $function$;

create or replace function public.staff_ask_control(p_page bigint, p_action text, p_question bigint default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare p ask_pages%rowtype;
begin
  if not _staff_mod('community', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  select * into p from ask_pages where id = p_page for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_action in ('show', 'open', 'close', 'reveal', 'hide')
     and not exists (select 1 from ask_questions q where q.id = p_question and q.page_id = p.id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_action = 'start' then
    update ask_pages set status = 'live' where id = p.id;
  elsif p_action = 'end' then
    update ask_pages set status = 'ended' where id = p.id;
  elsif p_action = 'reset' then
    update ask_questions set started_at = null, reveal = false, open = true where page_id = p.id;
    update ask_pages set round = round + 1, current_q = null where id = p.id;
  elsif p_action = 'show' then
    update ask_questions set started_at = now(), open = true, reveal = false where id = p_question;
    update ask_pages set current_q = p_question where id = p.id;
  elsif p_action = 'open' then
    update ask_questions set open = true where id = p_question;
  elsif p_action = 'close' then
    update ask_questions set open = false where id = p_question;
  elsif p_action = 'reveal' then
    update ask_questions set reveal = true, open = false where id = p_question;
  elsif p_action = 'hide' then
    update ask_questions set reveal = false where id = p_question;
  else
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  return jsonb_build_object('ok', true);
end $function$;

-- Answers waiting for approval, for the section's badge.
create or replace function public.staff_ask_pending()
 returns integer
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not _staff_mod('community', false) then return 0; end if;  -- asked by every staff device for its badge
  return (select count(*) from ask_answers a join ask_pages p on p.id = a.page_id
           where a.status = 'pending' and a.round = p.round)::integer;
end $function$;

-- 7. who may call what ---------------------------------------------------------------------------------------------

do $acl$
declare f text;
begin
  -- inside the database only
  foreach f in array array[
    '_ask_who()', '_ask_text(text)', '_ask_norm(text)', '_ask_has_link(text)', '_ask_num_ok(jsonb, numeric, numeric, boolean)',
    '_ask_opts_ok(jsonb, integer, integer)', '_ask_ids(jsonb)', '_ask_int(jsonb, text, integer)', '_ask_n(numeric, integer)', '_ask_config_err(text, jsonb, text)',
    '_ask_key(bigint, text, bigint)', '_ask_key_ok(bigint, text)', '_ask_pages_stamp()', '_ask_questions_stamp()',
    '_ask_questions_bump()', '_ask_answers_stamp()', '_ask_answers_bump()', '_ask_side_bump()',
    '_ask_state(public.ask_pages)', '_ask_sees(public.ask_pages, text)', '_ask_result(public.ask_questions, integer, boolean, text[])',
    '_ask_rows(bigint, integer, text[])', '_ask_age(text)', '_ask_band(integer)',
    '_ask_public_q(public.ask_questions)', '_ask_public_page(public.ask_pages)', '_ask_public_qs(public.ask_pages)',
    '_ask_live(public.ask_pages)', '_ask_mine(bigint, integer, text)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- riders' pages (the functions check the session themselves)
  foreach f in array array[
    'ask_list(text, text)', 'ask_code(text)', 'ask_page(text, text, text, text)', 'ask_live(text, text, bigint)',
    'ask_screen(text, text)', 'ask_send(bigint, text, text, jsonb, text)', 'ask_unsend(bigint, text, text)',
    'ask_vote(bigint, text, text, boolean)', 'ask_react(bigint, text, text, text, boolean)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  -- the staff app (each checks the section)
  foreach f in array array[
    'staff_ask_pages()', 'staff_ask_page(bigint, integer)', 'staff_ask_answers(bigint, text, integer, bigint, integer)',
    'staff_ask_review(bigint[], text)', 'staff_ask_control(bigint, text, bigint)', 'staff_ask_pending()',
    'staff_ask_stats(bigint, integer)', 'staff_ask_segment(bigint, text, integer)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $acl$;

-- 8. checks --------------------------------------------------------------------------------------------------------
do $chk$
declare t text; f record;
begin
  foreach t in array array['ask_secret', 'ask_pages', 'ask_questions', 'ask_answers', 'ask_votes', 'ask_reactions'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '% has no row level security', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'insert') then
      raise exception '% is open to anon', t;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.ask_secret', 'select') then raise exception 'ask_secret is readable'; end if;
  if has_table_privilege('authenticated', 'public.ask_answers', 'insert') then raise exception 'answers can be written past ask_send'; end if;
  for f in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p
            where p.pronamespace = 'public'::regnamespace and (p.proname like 'ask\_%' or p.proname like 'staff\_ask\_%' or p.proname like '\_ask\_%') loop
    if not exists (select 1 from unnest(coalesce(f.proconfig, '{}')) c where c like 'search_path=%') then
      raise exception '% has no search_path', f.proname;
    end if;
    if (f.proname like 'ask\_%' or f.proname like 'staff\_ask\_%') and not f.prosecdef then
      raise exception '% is not SECURITY DEFINER', f.proname;
    end if;
    if f.proname like '\_ask\_%' and (has_function_privilege('anon', f.oid, 'execute') or has_function_privilege('authenticated', f.oid, 'execute')) then
      raise exception '% is callable from outside', f.proname;
    end if;
    if f.proname like 'staff\_ask\_%' and has_function_privilege('anon', f.oid, 'execute') then
      raise exception '% is open to anon', f.proname;
    end if;
    if f.proname like 'ask\_%' and not has_function_privilege('anon', f.oid, 'execute') then
      raise exception 'the page cannot reach %', f.proname;
    end if;
  end loop;
end $chk$;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261113010000', 'ask')
on conflict (version) do nothing;

commit;
