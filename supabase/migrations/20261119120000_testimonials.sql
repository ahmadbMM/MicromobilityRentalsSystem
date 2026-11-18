-- ============================================================================
-- Testimonials (the user, 2026-11-18: "Create a testimonials page but don't make it visible, People write their
-- testimonials on our services & community rides. Then we publish them in a testimonials page").
--
-- The user's picks the same day:
--   * the pages work by direct link only (micromobility.sa/testimonials and /testimonials/write; the booking app's
--     own address) until ONE staff switch, site_content 'testimonials.on' = true, turns on everything riders see
--     unasked: the website's menu link and home page strip, the booking app's Account entry, the ask after a high
--     rating and the one-time ask about an old comment. The switch is read here by _tm_on() and returned to both apps.
--   * riders write signed in (website, booking app, after a high rating); staff may add one by hand (praise sent on
--     WhatsApp or Google) with a note of where the person agreed.
--   * the rider chooses how they are named: full name, first name and last initial, or anonymous, and must tick
--     "MicroMobility may publish this" (p_consent). The name is frozen as the rider saw it (display_name). This is
--     the one consented exception to "members see nobody" (2026-11-04): an anonymous testimonial names no one and
--     carries no "rider since" line.
--   * the form asks what it is about, stars 1-5, the words (20-800), an optional photo; a named testimonial shows
--     "Rider since <year> - <n> rides", read live from the account.
--   * staff only approve or hide: publish, reject, hide, back to waiting, feature (12 at most, the home page strip),
--     order, drop the photo. They never change the words. The rider deletes theirs whenever they like.
--   * old comments: riders whose ride comment (queue_entries.feedback, 40+ characters) came with a score of 9 or 10,
--     rated before this feature, are asked ONCE (testimonial_asks) whether it may be published.
--   * the public page shows the average stars of the published ones and how many.
--
--  1. testimonials       one row per testimonial; staff-only, read and written through the functions below.
--     testimonial_asks   one row per rider who answered the one-time ask (yes or no), so it never comes back.
--  2. For riders (anon key + the account's id and session token, _cust_token_ok): testimonial_mine,
--     testimonial_send, testimonial_delete, testimonial_old_answer.
--  3. For anyone (the public page): testimonials_public, testimonial_photo (published only).
--  4. For staff (People, _staff_mod('community')): staff_testimonials, staff_testimonial_photo,
--     staff_testimonial_set, staff_testimonial_order, staff_testimonial_add, staff_testimonial_delete.
--     The switch is site_content (admins write it, as every website switch).
--
-- Rollback:
--   drop function if exists public.staff_testimonial_delete(bigint), public.staff_testimonial_add(text, text, text, text, integer, text, text, text, boolean),
--     public.staff_testimonial_order(bigint[]), public.staff_testimonial_set(bigint[], text, text),
--     public.staff_testimonial_photo(bigint), public.staff_testimonials(text), public.testimonial_photo(bigint),
--     public.testimonials_public(text, boolean, integer, integer), public.testimonial_old_answer(text, text, text, boolean, text, boolean),
--     public.testimonial_delete(text, text, bigint), public.testimonial_send(text, text, text, integer, text, text, boolean, text, text, text, text),
--     public.testimonial_mine(text, text), public._tm_public(public.testimonials), public._tm_old_pick(text),
--     public._tm_since(text), public._tm_about(text), public._tm_name(text, text), public._tm_short(text), public._tm_on(),
--     public._tm_photo_ok(text), public._tm_stamp();
--   drop table if exists public.testimonial_asks, public.testimonials cascade;
--   delete from site_content where key = 'testimonials.on';
--   delete from supabase_migrations.schema_migrations where version = '20261119120000';
-- Idempotent. Needs _ask_text, _ask_has_link and _ask_who (20261113010000_ask).
-- ============================================================================

begin;

-- 1. tables ------------------------------------------------------------------------------------------------------

create table if not exists public.testimonials (
  id           bigint generated always as identity primary key,
  customer_id  text references public.customers(id) on delete cascade,
  entry_id     text,
  source       text not null check (source in ('web', 'app', 'rating', 'old_comment', 'staff')),
  about        text not null check (about in ('saturday', 'session', 'learn', 'event', 'workshop', 'other')),
  stars        smallint check (stars is null or stars between 1 and 5),
  body         text not null check (char_length(body) between 20 and 800),
  lang         text not null default 'en' check (lang ~ '^[a-z]{2}$'),
  name_mode    text not null check (name_mode in ('full', 'short', 'anon')),
  display_name text check (display_name is null or char_length(display_name) between 1 and 80),
  photo        text check (photo is null or (octet_length(photo) <= 600000 and photo ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$')),
  consent_at   timestamptz not null default now(),
  consent_note text check (consent_note is null or char_length(consent_note) <= 300),
  status       text not null default 'pending' check (status in ('pending', 'published', 'rejected', 'hidden')),
  featured     boolean not null default false,
  sort_order   integer,
  staff_note   text check (staff_note is null or char_length(staff_note) <= 500),
  reviewed_by  text,
  reviewed_at  timestamptz,
  published_at timestamptz,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint testimonials_named check (name_mode = 'anon' or display_name is not null),
  constraint testimonials_who check (customer_id is not null or source = 'staff'),
  constraint testimonials_staff_consent check (source <> 'staff' or char_length(btrim(coalesce(consent_note, ''))) >= 3),
  constraint testimonials_rider_stars check (source = 'staff' or stars is not null),
  constraint testimonials_entry_src check (entry_id is null or source in ('rating', 'old_comment'))
);
create unique index if not exists testimonials_entry on public.testimonials (entry_id) where entry_id is not null and status <> 'rejected';
create index if not exists testimonials_list on public.testimonials (status, sort_order, published_at desc);
create index if not exists testimonials_customer on public.testimonials (customer_id, created_at desc);
alter table public.testimonials enable row level security;
revoke all on public.testimonials from public, anon, authenticated;

create table if not exists public.testimonial_asks (
  customer_id text primary key references public.customers(id) on delete cascade,
  entry_id    text not null,
  answer      text not null check (answer in ('yes', 'no')),
  answered_at timestamptz not null default now()
);
alter table public.testimonial_asks enable row level security;
revoke all on public.testimonial_asks from public, anon, authenticated;

-- updated_at on every write; published_at the first time it is published; a rejected one keeps no photo (as a badge
-- request's proof), and only a published one can be featured.
create or replace function public._tm_stamp()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  new.updated_at := now();
  if new.status = 'published' and new.published_at is null then new.published_at := now(); end if;
  if new.status = 'rejected' then new.photo := null; end if;
  if new.status <> 'published' then new.featured := false; end if;
  return new;
end $function$;
drop trigger if exists testimonials_stamp on public.testimonials;
create trigger testimonials_stamp before insert or update on public.testimonials
  for each row execute function public._tm_stamp();

-- 2. helpers -----------------------------------------------------------------------------------------------------

-- The switch: anything but an explicit true is off.
create or replace function public._tm_on()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce((select c.value = 'true'::jsonb from site_content c where c.key = 'testimonials.on'), false)
$function$;

-- "Sara Ahmed Ali" is "Sara A."; one word stays as it is.
create or replace function public._tm_short(p text)
 returns text
 language sql
 immutable
 set search_path to 'public'
as $function$
  select case when n = '' then null
              when position(' ' in n) = 0 then left(n, 80)
              else left(split_part(n, ' ', 1) || ' ' || left(regexp_replace(n, '^.* ', ''), 1) || '.', 80) end
    from (select btrim(regexp_replace(coalesce(p, ''), '[[:space:]]+', ' ', 'g')) as n) x
$function$;

create or replace function public._tm_name(p_cust text, p_mode text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case p_mode
           when 'full' then nullif(left(btrim(regexp_replace(coalesce(c.name, ''), '[[:space:]]+', ' ', 'g')), 80), '')
           when 'short' then _tm_short(c.name)
         end
    from customers c where c.id = p_cust
$function$;

-- What a booking was: a Saturday community ride, a session (rentals, JCC), a workshop, else an event.
create or replace function public._tm_about(p_entry text)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce((
    select case when s.ride_kind = 'saturday' then 'saturday'
                when s.ride_kind = 'workshop' then 'workshop'
                when s.event_kind is null or s.event_kind = 'jcc' then 'session'
                else 'event' end
      from queue_entries e join sessions s on s.id = e.session_id
     where e.id = p_entry), 'other')
$function$;

-- "Rider since <year> - <n> rides": the year of the first ride (else of the account), and the rides done.
create or replace function public._tm_since(p_cust text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when p_cust is null then null else jsonb_build_object(
    'year', coalesce(
      (select min(left(e.session_date, 4)) from queue_entries e
        where e.customer_id = p_cust and e.status = 'done' and e.session_date ~ '^[0-9]{4}'),
      (select left(c.created_at, 4) from customers c where c.id = p_cust and c.created_at ~ '^[0-9]{4}'))::integer,
    'rides', (select count(*) from queue_entries e where e.customer_id = p_cust and e.status = 'done')) end
$function$;

-- The old comment a rider is asked about once: a done ride rated 9 or 10 before this feature, with 40+ characters
-- written, that is not a testimonial already. The best score first, then the longest, then the newest.
create or replace function public._tm_old_pick(p_cust text)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select jsonb_build_object('entry_id', e.id, 'body', left(_ask_text(e.feedback), 800), 'rating', e.rating_exp,
           'date', e.session_date, 'about', _tm_about(e.id), 'title', s.title, 'title_ar', s.title_ar)
    from queue_entries e left join sessions s on s.id = e.session_id
   where e.customer_id = p_cust and e.status = 'done' and e.rating_exp >= 9
     and char_length(_ask_text(e.feedback)) >= 40
     and (e.rated_at is null or e.rated_at < timestamptz '2026-11-19 00:00:00+03')
     and not exists (select 1 from testimonials t where t.entry_id = e.id and t.status <> 'rejected')
   order by e.rating_exp desc, char_length(e.feedback) desc, e.session_date desc nulls last, e.id desc
   limit 1
$function$;

-- A photo as the pages send it: a picture as a data: URL, 600 KB at most.
create or replace function public._tm_photo_ok(p text)
 returns boolean
 language sql
 immutable
 set search_path to 'public'
as $function$
  select p is null or (octet_length(p) <= 600000 and p ~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$')
$function$;

-- One published testimonial as the public sees it: no account id, no photo bytes, a name only when the rider chose one.
create or replace function public._tm_public(t public.testimonials)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select jsonb_build_object('id', t.id, 'about', t.about, 'stars', t.stars, 'body', t.body, 'lang', t.lang,
           'name', case when t.name_mode = 'anon' then null else t.display_name end,
           'since', case when t.name_mode = 'anon' then null else _tm_since(t.customer_id) end,
           'photo', t.photo is not null, 'featured', t.featured, 'published_at', t.published_at)
$function$;

-- 3. riders ------------------------------------------------------------------------------------------------------

-- The rider's own testimonials, the names they can choose between (exactly as they would show), their "since" line,
-- the switch, and the one-time ask about an old comment when it is due.
create or replace function public.testimonial_mine(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  return jsonb_build_object('ok', true, 'on', _tm_on(),
    'names', jsonb_build_object('full', _tm_name(p_id, 'full'), 'short', _tm_name(p_id, 'short')),
    'since', _tm_since(p_id),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'about', t.about, 'stars', t.stars, 'body', t.body, 'lang', t.lang,
               'name_mode', t.name_mode, 'display_name', t.display_name, 'status', t.status, 'photo', t.photo is not null,
               'source', t.source, 'entry_id', t.entry_id, 'created_at', t.created_at, 'published_at', t.published_at)
               order by t.created_at desc, t.id desc)
        from testimonials t where t.customer_id = p_id), '[]'::jsonb),
    'ask', case when _tm_on() and not exists (select 1 from testimonial_asks a where a.customer_id = p_id)
                then _tm_old_pick(p_id) end);
end $function$;

-- A rider's testimonial. Errors: signin, consent, invalid, body (20-800 after cleaning), link, stars, about, name,
-- photo, entry (not their done booking), dup (that booking has one), limit (3 waiting), throttled (5 a day).
create or replace function public.testimonial_send(p_id text, p_token text, p_body text, p_stars integer, p_about text,
  p_name_mode text, p_consent boolean, p_photo text default null, p_source text default 'web', p_entry text default null,
  p_lang text default 'en')
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_body text := _ask_text(p_body);
  v_lang text := case when coalesce(p_lang, '') ~ '^[a-z]{2}$' then p_lang else 'en' end;
  v_name text; v_id bigint;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  if p_consent is not true then return jsonb_build_object('ok', false, 'error', 'consent'); end if;
  if coalesce(p_source, '') not in ('web', 'app', 'rating') then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if (p_entry is null) <> (p_source <> 'rating') then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if char_length(v_body) not between 20 and 800 then return jsonb_build_object('ok', false, 'error', 'body'); end if;
  if _ask_has_link(v_body) then return jsonb_build_object('ok', false, 'error', 'link'); end if;
  if p_stars is null or p_stars not between 1 and 5 then return jsonb_build_object('ok', false, 'error', 'stars'); end if;
  if coalesce(p_about, '') not in ('saturday', 'session', 'learn', 'event', 'workshop', 'other') then return jsonb_build_object('ok', false, 'error', 'about'); end if;
  if coalesce(p_name_mode, '') not in ('full', 'short', 'anon') then return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if p_name_mode <> 'anon' then
    v_name := _tm_name(p_id, p_name_mode);
    if v_name is null then return jsonb_build_object('ok', false, 'error', 'name'); end if;
  end if;
  if not _tm_photo_ok(p_photo) then return jsonb_build_object('ok', false, 'error', 'photo'); end if;
  -- one rider's sends go in one at a time, so two taps cannot both pass the limits
  perform pg_advisory_xact_lock(hashtextextended('tm:' || p_id, 0));
  if p_entry is not null then
    if not exists (select 1 from queue_entries e where e.id = p_entry and e.customer_id = p_id and e.status = 'done') then
      return jsonb_build_object('ok', false, 'error', 'entry');
    end if;
    if exists (select 1 from testimonials t where t.entry_id = p_entry and t.status <> 'rejected') then
      return jsonb_build_object('ok', false, 'error', 'dup');
    end if;
  end if;
  if (select count(*) from testimonials t where t.customer_id = p_id and t.status = 'pending') >= 3 then
    return jsonb_build_object('ok', false, 'error', 'limit');
  end if;
  if (select count(*) from testimonials t where t.customer_id = p_id and t.created_at > now() - interval '1 day') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  -- a testimonial about a booking is about what that booking was, whatever the page sent
  insert into testimonials (customer_id, entry_id, source, about, stars, body, lang, name_mode, display_name, photo, consent_at)
  values (p_id, p_entry, p_source, case when p_entry is not null then _tm_about(p_entry) else p_about end, p_stars, v_body,
          v_lang, p_name_mode, v_name, p_photo, now())
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'status', 'pending', 'body', v_body, 'display_name', v_name);
end $function$;

-- The rider takes theirs down, whatever its state.
create or replace function public.testimonial_delete(p_id text, p_token text, p_tid bigint)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n integer;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  delete from testimonials t where t.id = p_tid and t.customer_id = p_id;
  get diagnostics n = row_count;
  return case when n > 0 then jsonb_build_object('ok', true) else jsonb_build_object('ok', false, 'error', 'gone') end;
end $function$;

-- The answer to the one-time ask. Yes (with the tick and a name choice) turns the old comment, word for word, into a
-- waiting testimonial: stars are the score halved (9 and 10 are 5). Errors: signin, off, done (already answered),
-- entry, consent, name.
create or replace function public.testimonial_old_answer(p_id text, p_token text, p_entry text, p_yes boolean,
  p_name_mode text default 'short', p_consent boolean default false)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare e queue_entries%rowtype; v_name text; v_id bigint; v_body text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'signin'); end if;
  if not _tm_on() then return jsonb_build_object('ok', false, 'error', 'off'); end if;
  perform pg_advisory_xact_lock(hashtextextended('tm:' || p_id, 0));
  if exists (select 1 from testimonial_asks a where a.customer_id = p_id) then return jsonb_build_object('ok', false, 'error', 'done'); end if;
  select * into e from queue_entries q
   where q.id = p_entry and q.customer_id = p_id and q.status = 'done' and q.rating_exp >= 9
     and char_length(_ask_text(q.feedback)) >= 40;
  if not found then return jsonb_build_object('ok', false, 'error', 'entry'); end if;
  if p_yes is true then
    if p_consent is not true then return jsonb_build_object('ok', false, 'error', 'consent'); end if;
    if coalesce(p_name_mode, '') not in ('full', 'short', 'anon') then return jsonb_build_object('ok', false, 'error', 'name'); end if;
    if p_name_mode <> 'anon' then
      v_name := _tm_name(p_id, p_name_mode);
      if v_name is null then return jsonb_build_object('ok', false, 'error', 'name'); end if;
    end if;
    v_body := left(_ask_text(e.feedback), 800);
    if not exists (select 1 from testimonials t where t.entry_id = e.id and t.status <> 'rejected') then
      insert into testimonials (customer_id, entry_id, source, about, stars, body, lang, name_mode, display_name, consent_at)
      values (p_id, e.id, 'old_comment', _tm_about(e.id), greatest(1, least(5, round(e.rating_exp / 2.0)::integer)), v_body,
              case when v_body ~ ('[' || chr(1536) || '-' || chr(1791) || ']') then 'ar' else 'en' end,
              p_name_mode, v_name, now())
      returning id into v_id;
    end if;
  end if;
  insert into testimonial_asks (customer_id, entry_id, answer) values (p_id, e.id, case when p_yes is true then 'yes' else 'no' end)
  on conflict (customer_id) do nothing;
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;

-- 4. the public page ---------------------------------------------------------------------------------------------

-- The published testimonials (works whether the switch is on or not: the page is reachable by its link), with the
-- average stars and the count over ALL published ones, and the count per kind. p_featured: the home page strip (12).
create or replace function public.testimonials_public(p_about text default null, p_featured boolean default false,
  p_limit integer default 60, p_offset integer default 0)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_lim integer := least(greatest(coalesce(p_limit, 60), 1), 100); v_off integer := greatest(coalesce(p_offset, 0), 0);
begin
  return jsonb_build_object('on', _tm_on(),
    'count', (select count(*) from testimonials t where t.status = 'published'),
    'rated', (select count(*) from testimonials t where t.status = 'published' and t.stars is not null),
    'avg', (select round(avg(t.stars)::numeric, 1) from testimonials t where t.status = 'published' and t.stars is not null),
    'by_about', coalesce((select jsonb_object_agg(x.about, x.n) from (select t.about, count(*) as n from testimonials t
                           where t.status = 'published' group by t.about) x), '{}'::jsonb),
    'items', coalesce((
      select jsonb_agg(_tm_public(t) order by t.sort_order nulls last, t.published_at desc, t.id desc)
        from (select * from testimonials t
               where t.status = 'published' and (p_about is null or t.about = p_about) and (not coalesce(p_featured, false) or t.featured)
               order by t.sort_order nulls last, t.published_at desc, t.id desc
               limit case when coalesce(p_featured, false) then 12 else v_lim end offset case when coalesce(p_featured, false) then 0 else v_off end) t), '[]'::jsonb));
end $function$;

-- A published testimonial's photo (the website serves it from its own address, cached).
create or replace function public.testimonial_photo(p_tid bigint)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select t.photo from testimonials t where t.id = p_tid and t.status = 'published'
$function$;

-- 5. staff -------------------------------------------------------------------------------------------------------

create or replace function public.staff_testimonials(p_status text default null)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not _staff_mod('community', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return jsonb_build_object('on', _tm_on(),
    'counts', (select jsonb_build_object(
                 'pending', count(*) filter (where t.status = 'pending'), 'published', count(*) filter (where t.status = 'published'),
                 'rejected', count(*) filter (where t.status = 'rejected'), 'hidden', count(*) filter (where t.status = 'hidden'),
                 'featured', count(*) filter (where t.featured)) from testimonials t),
    'asks', (select jsonb_build_object('yes', count(*) filter (where a.answer = 'yes'), 'no', count(*) filter (where a.answer = 'no'))
               from testimonial_asks a),
    'items', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc, x.id desc)
        from (select t.id, t.customer_id, t.entry_id, t.source, t.about, t.stars, t.body, t.lang, t.name_mode, t.display_name,
                     t.photo is not null as photo, t.consent_at, t.consent_note, t.status, t.featured, t.sort_order, t.staff_note,
                     t.reviewed_by, t.reviewed_at, t.published_at, t.created_by, t.created_at,
                     c.name as customer_name, c.phone as customer_phone,
                     case when t.customer_id is null then null else _tm_since(t.customer_id) end as since,
                     (select s.title from queue_entries e join sessions s on s.id = e.session_id where e.id = t.entry_id) as ride_title,
                     (select e.session_date from queue_entries e where e.id = t.entry_id) as ride_date
                from testimonials t left join customers c on c.id = t.customer_id
               where p_status is null or t.status = p_status
               order by t.created_at desc, t.id desc
               limit 1000) x), '[]'::jsonb));
end $function$;

create or replace function public.staff_testimonial_photo(p_tid bigint)
 returns text
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not _staff_mod('community', false) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  return (select t.photo from testimonials t where t.id = p_tid);
end $function$;

-- publish, reject, hide, pending (back to waiting), feature, unfeature, drop_photo. Returns the rows changed.
-- FEATURE_LIMIT when more than 12 would be featured; a testimonial that is not published cannot be featured.
create or replace function public.staff_testimonial_set(p_ids bigint[], p_action text, p_note text default null)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n integer; v_who text := _ask_who(); v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
  if not _staff_mod('community', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if coalesce(p_action, '') not in ('publish', 'reject', 'hide', 'pending', 'feature', 'unfeature', 'drop_photo') then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tm:staff', 0));
  if p_action = 'feature' then
    if (select count(*) from testimonials t where t.featured)
       + (select count(*) from testimonials t where t.id = any(coalesce(p_ids, '{}')) and t.status = 'published' and not t.featured) > 12 then
      raise exception 'FEATURE_LIMIT' using errcode = 'P0001';
    end if;
    update testimonials t set featured = true, reviewed_by = v_who, reviewed_at = now()
     where t.id = any(coalesce(p_ids, '{}')) and t.status = 'published' and not t.featured;
  elsif p_action = 'unfeature' then
    update testimonials t set featured = false, reviewed_by = v_who, reviewed_at = now()
     where t.id = any(coalesce(p_ids, '{}')) and t.featured;
  elsif p_action = 'drop_photo' then
    update testimonials t set photo = null, reviewed_by = v_who, reviewed_at = now()
     where t.id = any(coalesce(p_ids, '{}')) and t.photo is not null;
  else
    update testimonials t
       set status = case p_action when 'publish' then 'published' when 'reject' then 'rejected' when 'hide' then 'hidden' else 'pending' end,
           staff_note = coalesce(v_note, t.staff_note), reviewed_by = v_who, reviewed_at = now()
     where t.id = any(coalesce(p_ids, '{}'))
       and t.status <> case p_action when 'publish' then 'published' when 'reject' then 'rejected' when 'hide' then 'hidden' else 'pending' end;
  end if;
  get diagnostics n = row_count;
  return n;
end $function$;

-- The published ones in the order given (first = top of the page); the others keep theirs.
create or replace function public.staff_testimonial_order(p_ids bigint[])
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n integer;
begin
  if not _staff_mod('community', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  update testimonials t set sort_order = o.pos
    from unnest(coalesce(p_ids, '{}')) with ordinality as o(id, pos)
   where t.id = o.id and t.status = 'published' and t.sort_order is distinct from o.pos::integer;
  get diagnostics n = row_count;
  return n;
end $function$;

-- Staff add one by hand: praise sent on WhatsApp, Instagram or Google, with a note of where the person agreed.
-- With an account the name comes from it (as the mode says); without one, p_name is used.
create or replace function public.staff_testimonial_add(p_customer text, p_name text, p_name_mode text, p_body text,
  p_stars integer, p_about text, p_consent_note text, p_photo text default null, p_publish boolean default false)
 returns bigint
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare v_body text := _ask_text(p_body); v_name text; v_id bigint; v_cust text := nullif(btrim(coalesce(p_customer, '')), '');
begin
  if not _staff_mod('community', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if char_length(v_body) not between 20 and 800 then raise exception 'BODY' using errcode = '22023'; end if;
  if p_stars is not null and p_stars not between 1 and 5 then raise exception 'STARS' using errcode = '22023'; end if;
  if coalesce(p_about, '') not in ('saturday', 'session', 'learn', 'event', 'workshop', 'other') then raise exception 'ABOUT' using errcode = '22023'; end if;
  if coalesce(p_name_mode, '') not in ('full', 'short', 'anon') then raise exception 'NAME' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_consent_note, ''))) < 3 then raise exception 'CONSENT' using errcode = '22023'; end if;
  if not _tm_photo_ok(p_photo) then raise exception 'PHOTO' using errcode = '22023'; end if;
  if v_cust is not null and not exists (select 1 from customers c where c.id = v_cust) then raise exception 'CUSTOMER' using errcode = '22023'; end if;
  if p_name_mode <> 'anon' then
    v_name := case when v_cust is not null then _tm_name(v_cust, p_name_mode)
                   when p_name_mode = 'short' then _tm_short(_ask_text(p_name))
                   else nullif(left(_ask_text(p_name), 80), '') end;
    if v_name is null then raise exception 'NAME' using errcode = '22023'; end if;
  end if;
  insert into testimonials (customer_id, source, about, stars, body, lang, name_mode, display_name, photo, consent_note,
                            status, created_by, reviewed_by, reviewed_at)
  values (v_cust, 'staff', p_about, p_stars, v_body,
          case when v_body ~ ('[' || chr(1536) || '-' || chr(1791) || ']') then 'ar' else 'en' end,
          p_name_mode, v_name, p_photo, left(btrim(p_consent_note), 300),
          case when p_publish is true then 'published' else 'pending' end, _ask_who(),
          case when p_publish is true then _ask_who() end, case when p_publish is true then now() end)
  returning id into v_id;
  return v_id;
end $function$;

create or replace function public.staff_testimonial_delete(p_tid bigint)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n integer;
begin
  if not _staff_mod('community', true) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  delete from testimonials t where t.id = p_tid;
  get diagnostics n = row_count;
  return n;
end $function$;

-- 6. the switch: off until staff turn it on --------------------------------------------------------------------------
insert into public.site_content (key, value, updated_by) values ('testimonials.on', 'false'::jsonb, 'migration 20261119120000')
on conflict (key) do nothing;

-- 7. who may call what -----------------------------------------------------------------------------------------------
do $acl$
declare f text;
begin
  -- inside the database only
  foreach f in array array[
    '_tm_stamp()', '_tm_on()', '_tm_short(text)', '_tm_name(text, text)', '_tm_about(text)', '_tm_since(text)',
    '_tm_old_pick(text)', '_tm_photo_ok(text)', '_tm_public(public.testimonials)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  -- riders and the public page (the rider functions check the session themselves)
  foreach f in array array[
    'testimonial_mine(text, text)',
    'testimonial_send(text, text, text, integer, text, text, boolean, text, text, text, text)',
    'testimonial_delete(text, text, bigint)',
    'testimonial_old_answer(text, text, text, boolean, text, boolean)',
    'testimonials_public(text, boolean, integer, integer)', 'testimonial_photo(bigint)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  -- the staff app (each checks the section)
  foreach f in array array[
    'staff_testimonials(text)', 'staff_testimonial_photo(bigint)', 'staff_testimonial_set(bigint[], text, text)',
    'staff_testimonial_order(bigint[])',
    'staff_testimonial_add(text, text, text, text, integer, text, text, text, boolean)', 'staff_testimonial_delete(bigint)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $acl$;

-- 8. checks --------------------------------------------------------------------------------------------------------
do $chk$
declare t text; f record;
begin
  foreach t in array array['testimonials', 'testimonial_asks'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception '% has no row level security', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'insert') then
      raise exception '% is open past its functions', t;
    end if;
  end loop;
  for f in select p.oid, p.proname, p.prosecdef, p.proconfig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'testimonial%' or p.proname like 'staff\_testimonial%' or p.proname like '\_tm\_%') loop
    if not exists (select 1 from unnest(coalesce(f.proconfig, '{}')) c where c like 'search_path=%') then
      raise exception '% has no search_path', f.proname;
    end if;
    if (f.proname like 'testimonial%' or f.proname like 'staff\_testimonial%') and not f.prosecdef then
      raise exception '% is not SECURITY DEFINER', f.proname;
    end if;
    if f.proname like '\_tm\_%' and (has_function_privilege('anon', f.oid, 'execute') or has_function_privilege('authenticated', f.oid, 'execute')) then
      raise exception '% is callable from outside', f.proname;
    end if;
    if f.proname like 'staff\_testimonial%' and has_function_privilege('anon', f.oid, 'execute') then
      raise exception '% is open to anon', f.proname;
    end if;
    if f.proname like 'testimonial%' and not has_function_privilege('anon', f.oid, 'execute') then
      raise exception 'the pages cannot reach %', f.proname;
    end if;
  end loop;
  if (select value from site_content where key = 'testimonials.on') is null then raise exception 'the switch is missing'; end if;
end $chk$;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119120000', 'testimonials')
on conflict (version) do nothing;

commit;

-- Read-only check after applying (expect: 2 tables with RLS, 21 functions, switch false, ledger row):
-- select (select count(*) from pg_class where relname in ('testimonials', 'testimonial_asks') and relrowsecurity) as tables_rls,
--        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
--          and (proname like 'testimonial%' or proname like 'staff\_testimonial%' or proname like '\_tm\_%')) as functions,
--        (select value from site_content where key = 'testimonials.on') as switch,
--        (select name from supabase_migrations.schema_migrations where version = '20261119120000') as ledger;
