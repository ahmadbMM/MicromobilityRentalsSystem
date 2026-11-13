-- The MicroMobility Mentorship Programme, members only (the user, 2026-11-13: "create a mentorship program exclusively
-- for community members, we put anonymous profiles of students in specific universities and cities worldwide and let
-- community members who have knowledge or can help choose the profile they can help and we match them and make them
-- contact with them").
--
-- The user's picks the same day: profiles come from staff AND from a member starting university who asks in the
-- Community tab (staff publish every one first); staff pick an offer, the student accepts it, and only then each sees the
-- other's first name and WhatsApp number; no age rule; the student may ask for a mentor of their gender, seen by staff
-- only; no cap on a mentor's students; a "Still in touch?" check for both sides two weeks after the match, then monthly.
--
--  1. mentor_profiles: a student's anonymous profile (university, field, city, country, start year, the help wanted, an
--     optional goal), its number ("Profile 7") given when staff publish it, the student's account, the gender they prefer
--     in a mentor (staff only) and their consent. Status: pending (asked, waiting for staff), open (members see it),
--     matched, closed, declined.
--  2. mentor_mentors: a member's registration as a mentor (the user, 2026-11-13: "Mentee registration", "Mentor
--     registration & choosing from mentees list"): where they studied, what, their work, the places they know, how they
--     can help, a note for staff, their consent; active, or left (they left the programme). Only a registered mentor
--     offers on a profile.
--  3. mentor_offers: a member's offer on one profile: how they know the path, how they can help, a note for staff, their
--     consent. Status: offered, proposed (staff showed it to the student with a short line, no name), matched (the
--     student accepted), declined, withdrawn, ended. A match gives the mentor the Mentor badge.
--  4. mentor_checks: one row per "Still in touch?" answer (yes, not_yet, help).
--  5. The member's reads and writes (token-checked, members only): mentor_feed, mentor_ask, mentor_join, mentor_quit,
--     mentor_offer, mentor_answer, mentor_leave, mentor_check. Members see nobody (2026-11-04) except here, by the user's request: an open profile
--     carries no name, and a name and number reach only the other side of an accepted match, while it runs.
--  6. Staff read and write the four tables directly (People > Mentorship).
--
-- Rollback: drop the eight functions, the helpers, the two trigger functions, the four tables, and the badge if nobody holds it.

begin;

-- ── 1. the tables ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.mentor_profiles (
  id           text primary key default ('mp_' || replace(gen_random_uuid()::text, '-', '')),
  num          integer unique check (num between 1 and 99999),
  customer_id  text not null references public.customers (id) on update cascade on delete cascade,
  university   text not null check (char_length(btrim(university)) between 2 and 100),
  field        text not null check (char_length(btrim(field)) between 2 and 100),
  city         text not null check (char_length(btrim(city)) between 1 and 60),
  country      text not null check (country ~ '^[A-Z]{2}$' and country <> 'IL'),
  class_year   integer not null check (class_year between 2020 and 2040),
  helps        text[] not null default '{}'
               check (helps <@ array['questions', 'subjects', 'cv', 'internship', 'job', 'unilife', 'city', 'talk']::text[]),
  goal         text check (goal is null or char_length(goal) <= 200),
  gender_pref  text not null default 'any' check (gender_pref in ('any', 'female', 'male')),
  status       text not null default 'pending' check (status in ('pending', 'open', 'matched', 'closed', 'declined')),
  source       text not null default 'self' check (source in ('self', 'staff')),
  consent_at   timestamptz,
  staff_note   text check (staff_note is null or char_length(staff_note) <= 500),
  by_staff     text check (by_staff is null or char_length(by_staff) <= 60),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  published_at timestamptz,
  closed_at    timestamptz
);
create index if not exists mentor_profiles_customer_idx on public.mentor_profiles (customer_id);
create index if not exists mentor_profiles_status_idx on public.mentor_profiles (status);
-- One live profile per account.
create unique index if not exists mentor_profiles_one_live on public.mentor_profiles (customer_id)
  where status in ('pending', 'open', 'matched');
alter table public.mentor_profiles enable row level security;
revoke all on public.mentor_profiles from public, anon, authenticated;
grant select, insert, update, delete on public.mentor_profiles to authenticated;
drop policy if exists "staff full" on public.mentor_profiles;
create policy "staff full" on public.mentor_profiles for all to authenticated
  using ((select is_staff())) with check ((select is_staff()));

create table if not exists public.mentor_mentors (
  customer_id text primary key references public.customers (id) on update cascade on delete cascade,
  university  text not null check (char_length(btrim(university)) between 2 and 160),
  field       text not null check (char_length(btrim(field)) between 2 and 120),
  work        text check (work is null or char_length(work) <= 120),
  places      text check (places is null or char_length(places) <= 160),
  helps       text[] not null default '{}'
              check (helps <@ array['questions', 'subjects', 'cv', 'internship', 'job', 'unilife', 'city', 'talk']::text[]),
  about       text not null check (char_length(btrim(about)) between 1 and 500),
  status      text not null default 'active' check (status in ('active', 'left')),
  consent_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  left_at     timestamptz
);
alter table public.mentor_mentors enable row level security;
revoke all on public.mentor_mentors from public, anon, authenticated;
grant select, insert, update, delete on public.mentor_mentors to authenticated;
drop policy if exists "staff full" on public.mentor_mentors;
create policy "staff full" on public.mentor_mentors for all to authenticated
  using ((select is_staff())) with check ((select is_staff()));

create table if not exists public.mentor_offers (
  id          text primary key default ('mo_' || replace(gen_random_uuid()::text, '-', '')),
  profile_id  text not null references public.mentor_profiles (id) on update cascade on delete cascade,
  mentor_id   text not null references public.customers (id) on update cascade on delete cascade,
  links       text[] not null default '{}'
              check (links <@ array['uni', 'field', 'city', 'industry', 'experience']::text[]),
  helps       text[] not null default '{}'
              check (helps <@ array['questions', 'subjects', 'cv', 'internship', 'job', 'unilife', 'city', 'talk']::text[]),
  note        text not null check (char_length(btrim(note)) between 1 and 500),
  summary     text check (summary is null or char_length(summary) <= 160),
  status      text not null default 'offered'
              check (status in ('offered', 'proposed', 'matched', 'declined', 'withdrawn', 'ended')),
  ended_by    text check (ended_by is null or ended_by in ('mentor', 'student', 'staff')),
  consent_at  timestamptz,
  by_staff    text check (by_staff is null or char_length(by_staff) <= 60),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  proposed_at timestamptz,
  matched_at  timestamptz,
  ended_at    timestamptz
);
create index if not exists mentor_offers_profile_idx on public.mentor_offers (profile_id);
create index if not exists mentor_offers_mentor_idx on public.mentor_offers (mentor_id);
-- One live offer per member per profile.
create unique index if not exists mentor_offers_one_live on public.mentor_offers (profile_id, mentor_id)
  where status in ('offered', 'proposed', 'matched');
alter table public.mentor_offers enable row level security;
revoke all on public.mentor_offers from public, anon, authenticated;
grant select, insert, update, delete on public.mentor_offers to authenticated;
drop policy if exists "staff full" on public.mentor_offers;
create policy "staff full" on public.mentor_offers for all to authenticated
  using ((select is_staff())) with check ((select is_staff()));

create table if not exists public.mentor_checks (
  id          bigserial primary key,
  offer_id    text not null references public.mentor_offers (id) on update cascade on delete cascade,
  customer_id text not null references public.customers (id) on update cascade on delete cascade,
  side        text not null check (side in ('mentor', 'student')),
  answer      text not null check (answer in ('yes', 'not_yet', 'help')),
  at          timestamptz not null default now()
);
create index if not exists mentor_checks_offer_idx on public.mentor_checks (offer_id, side, at desc);
alter table public.mentor_checks enable row level security;
revoke all on public.mentor_checks from public, anon, authenticated;
revoke all on sequence public.mentor_checks_id_seq from public, anon, authenticated;
grant select, delete on public.mentor_checks to authenticated;
drop policy if exists "staff full" on public.mentor_checks;
create policy "staff full" on public.mentor_checks for all to authenticated
  using ((select is_staff())) with check ((select is_staff()));

-- ── 2. the stamps ────────────────────────────────────────────────────────────────────────────────
-- A profile gets the next number the first time it is published (staff may type one instead), and its times.
create or replace function public._mentor_profile_stamp()
returns trigger
language plpgsql volatile security definer set search_path to 'public'
as $$
begin
  new.updated_at := now();
  if new.status in ('open', 'matched') then
    if new.num is null then
      perform pg_advisory_xact_lock(hashtext('mentor_profiles.num'));
      new.num := coalesce((select max(num) from mentor_profiles), 0) + 1;
    end if;
    new.published_at := coalesce(new.published_at, now());
    new.closed_at := null;
  elsif new.status in ('closed', 'declined') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    new.closed_at := now();
  end if;
  return new;
end $$;
revoke all on function public._mentor_profile_stamp() from public, anon, authenticated;
drop trigger if exists mentor_profile_stamp on public.mentor_profiles;
create trigger mentor_profile_stamp before insert or update on public.mentor_profiles
  for each row execute function public._mentor_profile_stamp();

-- An offer's times follow its status; a match gives the mentor the Mentor badge (once) and marks the profile matched.
create or replace function public._mentor_offer_stamp()
returns trigger
language plpgsql volatile security definer set search_path to 'public'
as $$
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    new.updated_at := now();
    return new;
  end if;
  new.updated_at := now();
  if new.status = 'proposed' then new.proposed_at := now();
  elsif new.status = 'matched' then
    new.matched_at := now(); new.ended_at := null;
    insert into customer_badges (customer_id, badge_id, awarded_by, note)
      values (new.mentor_id, 'bd_mentor', 'system', 'Mentorship match')
      on conflict do nothing;
    update mentor_profiles set status = 'matched' where id = new.profile_id and status = 'open';
  elsif new.status in ('declined', 'withdrawn', 'ended') then new.ended_at := now();
  end if;
  return new;
end $$;
revoke all on function public._mentor_offer_stamp() from public, anon, authenticated;
drop trigger if exists mentor_offer_stamp on public.mentor_offers;
create trigger mentor_offer_stamp before insert or update on public.mentor_offers
  for each row execute function public._mentor_offer_stamp();

-- ── 3. the badge ─────────────────────────────────────────────────────────────────────────────────
insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort) values
  ('bd_mentor', 'mentor', 'beacon', 'teal', 'Mentor', 'مرشد',
   'Matched with a member starting university.', 'أصبحت مرشدًا لعضو يبدأ دراسته الجامعية.', true, true, 96)
on conflict (id) do nothing;

-- ── 4. the member's side ─────────────────────────────────────────────────────────────────────────
-- Digits for wa.me: the WhatsApp number when the account gave one apart, else the mobile; 05… and 00… made international.
create or replace function public._mentor_wa(p_customer text)
returns text
language plpgsql stable security definer set search_path to 'public'
as $$
declare v text;
begin
  select regexp_replace(coalesce(case when c.whatsapp_same is false and nullif(btrim(c.whatsapp), '') is not null
                                      then c.whatsapp else c.phone end, ''), '\D', '', 'g')
    into v from customers c where c.id = p_customer;
  v := coalesce(v, '');
  if v like '00%' then v := substr(v, 3); end if;
  if v ~ '^05\d{8}$' then v := '966' || substr(v, 2); end if;
  if v ~ '^5\d{8}$' then v := '966' || v; end if;
  return nullif(v, '');
end $$;
revoke all on function public._mentor_wa(text) from public, anon, authenticated;

create or replace function public._mentor_first(p_customer text)
returns text
language sql stable security definer set search_path to 'public'
as $$ select nullif(split_part(btrim(coalesce(name, '')), ' ', 1), '') from customers where id = p_customer $$;
revoke all on function public._mentor_first(text) from public, anon, authenticated;

-- Is this side's "Still in touch?" due: two weeks after the match, then 30 days after its last answer.
create or replace function public._mentor_due(p_offer text, p_side text, p_matched timestamptz)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select case when p_matched is null then false
              else now() >= coalesce((select max(k.at) from mentor_checks k where k.offer_id = p_offer and k.side = p_side)
                                       + interval '30 days', p_matched + interval '14 days') end
$$;
revoke all on function public._mentor_due(text, text, timestamptz) from public, anon, authenticated;

-- The whole Mentorship page in one read: the open profiles (never the member's own), the member's own request with the
-- offers staff proposed to them and their matches, and the member's own offers. A name and number only across a match.
create or replace function public.mentor_feed(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_mine mentor_profiles%rowtype; v_ask jsonb := null;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;

  select * into v_mine from mentor_profiles where customer_id = p_id and status in ('pending', 'open', 'matched')
   order by created_at desc limit 1;
  if found then
    v_ask := jsonb_build_object(
      'num', v_mine.num, 'status', v_mine.status, 'university', v_mine.university, 'field', v_mine.field,
      'city', v_mine.city, 'country', v_mine.country, 'class_year', v_mine.class_year, 'helps', to_jsonb(v_mine.helps),
      'goal', v_mine.goal, 'gender_pref', v_mine.gender_pref,
      'proposed', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'links', to_jsonb(o.links), 'helps', to_jsonb(o.helps),
                                                                'summary', o.summary) order by o.proposed_at)
                              from mentor_offers o where o.profile_id = v_mine.id and o.status = 'proposed'), '[]'::jsonb),
      'matches', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', _mentor_first(o.mentor_id),
                                                               'wa', _mentor_wa(o.mentor_id), 'at', o.matched_at,
                                                               'links', to_jsonb(o.links), 'helps', to_jsonb(o.helps),
                                                               'summary', o.summary,
                                                               'due', _mentor_due(o.id, 'student', o.matched_at)) order by o.matched_at)
                             from mentor_offers o where o.profile_id = v_mine.id and o.status = 'matched'), '[]'::jsonb));
  end if;

  return jsonb_build_object(
    'ok', true,
    'ask', v_ask,
    'mentor', (select jsonb_build_object('university', m.university, 'field', m.field, 'work', m.work, 'places', m.places,
                                         'helps', to_jsonb(m.helps), 'about', m.about)
                 from mentor_mentors m where m.customer_id = p_id and m.status = 'active'),
    'profiles', coalesce((select jsonb_agg(jsonb_build_object(
                   'num', p.num, 'university', p.university, 'field', p.field, 'city', p.city, 'country', p.country,
                   'class_year', p.class_year, 'helps', to_jsonb(p.helps), 'goal', p.goal,
                   'offered', (select o.status from mentor_offers o where o.profile_id = p.id and o.mentor_id = p_id
                                 and o.status in ('offered', 'proposed', 'matched') limit 1)) order by p.num)
                 from mentor_profiles p where p.status = 'open' and p.customer_id <> p_id and p.num is not null), '[]'::jsonb),
    'offers', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', o.id, 'num', p.num, 'university', p.university, 'field', p.field, 'city', p.city, 'country', p.country,
                 'class_year', p.class_year, 'status', o.status,
                 'name', case when o.status = 'matched' then _mentor_first(p.customer_id) end,
                 'wa', case when o.status = 'matched' then _mentor_wa(p.customer_id) end,
                 'at', o.matched_at,
                 'due', case when o.status = 'matched' then _mentor_due(o.id, 'mentor', o.matched_at) else false end)
                 order by (o.status = 'matched') desc, o.created_at desc)
               from mentor_offers o join mentor_profiles p on p.id = o.profile_id
              where o.mentor_id = p_id
                and (o.status in ('offered', 'proposed', 'matched')
                     or (o.status in ('declined', 'ended') and o.ended_at > now() - interval '14 days'))), '[]'::jsonb));
end $$;
revoke all on function public.mentor_feed(text, text) from public;
grant execute on function public.mentor_feed(text, text) to anon, authenticated;

-- A member starting university asks for a mentor: a pending profile staff check and publish (a pending one is
-- replaced by the newer answers; a published one stays as it is).
create or replace function public.mentor_ask(p_id text, p_token text, p_university text, p_field text, p_city text,
                                             p_country text, p_class_year integer, p_helps text[], p_goal text,
                                             p_gender_pref text, p_ok boolean)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_live mentor_profiles%rowtype; v_helps text[];
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  if p_ok is not true then return jsonb_build_object('ok', false, 'error', 'consent'); end if;
  v_helps := array(select distinct x from unnest(coalesce(p_helps, '{}'::text[])) x
                    where x in ('questions', 'subjects', 'cv', 'internship', 'job', 'unilife', 'city', 'talk'));
  if char_length(btrim(coalesce(p_university, ''))) not between 2 and 100
     or char_length(btrim(coalesce(p_field, ''))) not between 2 and 100
     or char_length(btrim(coalesce(p_city, ''))) not between 1 and 60
     or coalesce(p_country, '') !~ '^[A-Z]{2}$' or p_country = 'IL'
     or coalesce(p_class_year, 0) not between 2020 and 2040
     or cardinality(v_helps) = 0
     or char_length(coalesce(p_goal, '')) > 200
     or coalesce(p_gender_pref, 'any') not in ('any', 'female', 'male') then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  select * into v_live from mentor_profiles where customer_id = p_id and status in ('pending', 'open', 'matched') limit 1;
  if found and v_live.status <> 'pending' then return jsonb_build_object('ok', false, 'error', 'exists'); end if;
  if found then
    update mentor_profiles set university = btrim(p_university), field = btrim(p_field), city = btrim(p_city),
           country = p_country, class_year = p_class_year, helps = v_helps, goal = nullif(btrim(coalesce(p_goal, '')), ''),
           gender_pref = coalesce(p_gender_pref, 'any'), consent_at = now()
     where id = v_live.id;
  else
    insert into mentor_profiles (customer_id, university, field, city, country, class_year, helps, goal, gender_pref,
                                 status, source, consent_at)
    values (p_id, btrim(p_university), btrim(p_field), btrim(p_city), p_country, p_class_year, v_helps,
            nullif(btrim(coalesce(p_goal, '')), ''), coalesce(p_gender_pref, 'any'), 'pending', 'self', now());
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.mentor_ask(text, text, text, text, text, text, integer, text[], text, text, boolean) from public;
grant execute on function public.mentor_ask(text, text, text, text, text, text, integer, text[], text, text, boolean) to anon, authenticated;

-- A registered mentor offers to help one open profile (never their own); at most 10 offers a day.
create or replace function public.mentor_offer(p_id text, p_token text, p_num integer, p_links text[], p_helps text[],
                                               p_note text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_p mentor_profiles%rowtype; v_links text[]; v_helps text[];
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  if not exists (select 1 from mentor_mentors where customer_id = p_id and status = 'active') then
    return jsonb_build_object('ok', false, 'error', 'register');
  end if;
  v_links := array(select distinct x from unnest(coalesce(p_links, '{}'::text[])) x
                    where x in ('uni', 'field', 'city', 'industry', 'experience'));
  v_helps := array(select distinct x from unnest(coalesce(p_helps, '{}'::text[])) x
                    where x in ('questions', 'subjects', 'cv', 'internship', 'job', 'unilife', 'city', 'talk'));
  if cardinality(v_links) = 0 or cardinality(v_helps) = 0
     or char_length(btrim(coalesce(p_note, ''))) not between 1 and 500 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  select * into v_p from mentor_profiles where num = p_num and status = 'open';
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if v_p.customer_id = p_id then return jsonb_build_object('ok', false, 'error', 'own'); end if;
  if exists (select 1 from mentor_offers where profile_id = v_p.id and mentor_id = p_id and status in ('offered', 'proposed', 'matched')) then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if (select count(*) from mentor_offers where mentor_id = p_id and created_at > now() - interval '1 day') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'limit');
  end if;
  insert into mentor_offers (profile_id, mentor_id, links, helps, note, consent_at)
  values (v_p.id, p_id, v_links, v_helps, btrim(p_note), (select consent_at from mentor_mentors where customer_id = p_id));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.mentor_offer(text, text, integer, text[], text[], text) from public;
grant execute on function public.mentor_offer(text, text, integer, text[], text[], text) to anon, authenticated;

-- A member registers as a mentor (or changes their registration); registering again after leaving rejoins.
create or replace function public.mentor_join(p_id text, p_token text, p_university text, p_field text, p_work text,
                                              p_places text, p_helps text[], p_about text, p_ok boolean)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_helps text[];
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  if p_ok is not true then return jsonb_build_object('ok', false, 'error', 'consent'); end if;
  v_helps := array(select distinct x from unnest(coalesce(p_helps, '{}'::text[])) x
                    where x in ('questions', 'subjects', 'cv', 'internship', 'job', 'unilife', 'city', 'talk'));
  if char_length(btrim(coalesce(p_university, ''))) not between 2 and 160
     or char_length(btrim(coalesce(p_field, ''))) not between 2 and 120
     or char_length(coalesce(p_work, '')) > 120 or char_length(coalesce(p_places, '')) > 160
     or cardinality(v_helps) = 0
     or char_length(btrim(coalesce(p_about, ''))) not between 1 and 500 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  insert into mentor_mentors (customer_id, university, field, work, places, helps, about, status, consent_at)
  values (p_id, btrim(p_university), btrim(p_field), nullif(btrim(coalesce(p_work, '')), ''), nullif(btrim(coalesce(p_places, '')), ''),
          v_helps, btrim(p_about), 'active', now())
  on conflict (customer_id) do update set university = excluded.university, field = excluded.field, work = excluded.work,
     places = excluded.places, helps = excluded.helps, about = excluded.about, status = 'active', consent_at = now(),
     updated_at = now(), left_at = null;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.mentor_join(text, text, text, text, text, text, text[], text, boolean) from public;
grant execute on function public.mentor_join(text, text, text, text, text, text, text[], text, boolean) to anon, authenticated;

-- A mentor leaves the programme: their offers are withdrawn, their matches end, and each student left without a mentor
-- is looking again.
create or replace function public.mentor_quit(p_id text, p_token text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_profiles text[];
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  update mentor_mentors set status = 'left', left_at = now(), updated_at = now() where customer_id = p_id and status = 'active';
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  v_profiles := array(select profile_id from mentor_offers where mentor_id = p_id and status = 'matched');
  update mentor_offers set status = case when status = 'matched' then 'ended' else 'withdrawn' end, ended_by = 'mentor'
   where mentor_id = p_id and status in ('offered', 'proposed', 'matched');
  update mentor_profiles p set status = 'open'
   where p.id = any(v_profiles) and p.status = 'matched'
     and not exists (select 1 from mentor_offers o where o.profile_id = p.id and o.status = 'matched');
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.mentor_quit(text, text) from public;
grant execute on function public.mentor_quit(text, text) to anon, authenticated;

-- The student accepts (contacts shown to both) or turns down an offer staff proposed to them.
create or replace function public.mentor_answer(p_id text, p_token text, p_offer text, p_yes boolean)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_o mentor_offers%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  select o.* into v_o from mentor_offers o join mentor_profiles p on p.id = o.profile_id
   where o.id = p_offer and p.customer_id = p_id and o.status = 'proposed' and p.status in ('open', 'matched')
   for update of o;
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if p_yes is true then
    update mentor_offers set status = 'matched' where id = v_o.id;
  else
    update mentor_offers set status = 'declined', ended_by = 'student' where id = v_o.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.mentor_answer(text, text, text, boolean) from public;
grant execute on function public.mentor_answer(text, text, text, boolean) to anon, authenticated;

-- Stepping back. A mentor withdraws an offer, or either side leaves a running match; with no offer, the student closes
-- their own request. When a mentor leaves, the student's profile opens again for another mentor; when the student leaves
-- or closes, their profile closes and every live offer on it ends.
create or replace function public.mentor_leave(p_id text, p_token text, p_offer text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_o mentor_offers%rowtype; v_p mentor_profiles%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if p_offer is null then
    select * into v_p from mentor_profiles where customer_id = p_id and status in ('pending', 'open', 'matched') for update;
    if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
    update mentor_offers set status = case when status = 'matched' then 'ended' else 'declined' end, ended_by = 'student'
     where profile_id = v_p.id and status in ('offered', 'proposed', 'matched');
    update mentor_profiles set status = 'closed' where id = v_p.id;
    return jsonb_build_object('ok', true);
  end if;
  select * into v_o from mentor_offers where id = p_offer and status in ('offered', 'proposed', 'matched') for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  select * into v_p from mentor_profiles where id = v_o.profile_id;
  if v_o.mentor_id = p_id then
    update mentor_offers set status = case when status = 'matched' then 'ended' else 'withdrawn' end, ended_by = 'mentor'
     where id = v_o.id;
    if v_o.status = 'matched' and v_p.status = 'matched'
       and not exists (select 1 from mentor_offers where profile_id = v_p.id and status = 'matched') then
      update mentor_profiles set status = 'open' where id = v_p.id;
    end if;
  elsif v_p.customer_id = p_id and v_o.status = 'matched' then
    update mentor_offers set status = 'ended', ended_by = 'student' where id = v_o.id;
    if not exists (select 1 from mentor_offers where profile_id = v_p.id and status = 'matched') then
      update mentor_offers set status = 'declined', ended_by = 'student' where profile_id = v_p.id and status in ('offered', 'proposed');
      update mentor_profiles set status = 'closed' where id = v_p.id;
    end if;
  else
    return jsonb_build_object('ok', false, 'error', 'gone');
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.mentor_leave(text, text, text) from public;
grant execute on function public.mentor_leave(text, text, text) to anon, authenticated;

-- "Still in touch?": one answer per side of a running match, at most one a day.
create or replace function public.mentor_check(p_id text, p_token text, p_offer text, p_answer text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_o mentor_offers%rowtype; v_side text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if coalesce(p_answer, '') not in ('yes', 'not_yet', 'help') then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  select * into v_o from mentor_offers where id = p_offer and status = 'matched';
  if not found then return jsonb_build_object('ok', false, 'error', 'gone'); end if;
  if v_o.mentor_id = p_id then v_side := 'mentor';
  elsif exists (select 1 from mentor_profiles where id = v_o.profile_id and customer_id = p_id) then v_side := 'student';
  else return jsonb_build_object('ok', false, 'error', 'gone');
  end if;
  if exists (select 1 from mentor_checks where offer_id = v_o.id and side = v_side and at > now() - interval '1 day') then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  insert into mentor_checks (offer_id, customer_id, side, answer) values (v_o.id, p_id, v_side, p_answer);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.mentor_check(text, text, text, text) from public;
grant execute on function public.mentor_check(text, text, text, text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114050000', 'mentorship')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity) as no_rls_0,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('mentor_feed', 'mentor_ask', 'mentor_join', 'mentor_quit', 'mentor_offer', 'mentor_answer', 'mentor_leave',
                         'mentor_check', '_mentor_profile_stamp', '_mentor_offer_stamp', '_mentor_wa', '_mentor_first',
                         '_mentor_due')) as definer_13,
       has_function_privilege('anon', 'public.mentor_feed(text,text)', 'execute') as anon_feed_true,
       has_function_privilege('anon', 'public._mentor_wa(text)', 'execute') as anon_wa_false,
       has_table_privilege('anon', 'public.mentor_profiles', 'select') as anon_profiles_false,
       has_table_privilege('anon', 'public.mentor_mentors', 'select') as anon_mentors_false,
       (select count(*) from pg_policies where tablename in ('mentor_profiles', 'mentor_mentors', 'mentor_offers', 'mentor_checks')) as policies_4,
       (select count(*) from pg_trigger where tgname in ('mentor_profile_stamp', 'mentor_offer_stamp')) as triggers_2,
       (select count(*) from public.badges where id = 'bd_mentor') as badge_1,
       (select version from supabase_migrations.schema_migrations where version = '20261114050000') as ledger;
