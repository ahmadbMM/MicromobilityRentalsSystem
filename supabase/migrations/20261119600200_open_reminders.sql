-- ============================================================================
-- "Remind me when booking opens" (the customer features round, 2026-11-19, item 2).
--
-- The user asked "what features for customers can we add to the booking app that will enhance their experience", was
-- offered a list and answered "do 1 2 3 5 7 9 11". Item 2, as offered: "On a date that isn't open yet, one tap adds the
-- opening time to the rider's calendar with an alarm, and puts a row in Updates when it opens. This helps on Saturdays
-- that fill fast."
--
--  1. open_reminders (customer_id, session_id, created_at, sent_at; one row per rider and session): the rider asked to
--     be told in Updates when booking opens for them. RLS on and nobody's grant, staff included: only the definer
--     functions below touch it. Both keys follow their rows (on update cascade), so staff_move_session's re-pointing
--     (bh18 db3, read from pg_constraint) carries an ask to the session's new id, and a deleted account takes its asks.
--  2. _open_at(session, member): when booking opens for a rider, as the database's own guards decide it: the booking
--     window (site_content 'booking.window': session_date - days, at 'at', midnight when none, Riyadh; none for the
--     races, as _booking_window_guard 20261028200000 and _session_published 20261119000900 read it), a timed opening
--     (a closed session's opens_at), and for anyone who is not a member, members book first's public_at
--     (20261118210800). Null: nothing holds it.
--  3. _open_remind_ok(session, rider): could this rider book the date once it opens? A tag-gated date only for a live
--     holder of its tag (list_sessions' own test); a Community session not open to all only for a member, a Petromin
--     night also for a Petromin tag holder and Victory Lap for its tag holder (_community_booking_gate, 20261108120000);
--     never a Saturday ride while staff take its places by code alone at micromobility.sa/saturday (saturday_link_only).
--  4. open_reminder_set(p_id, p_token, p_session, p_on) stores or removes the ask. Token-checked. An ask is taken only
--     for a date the rider could see on their list, could book, and cannot book yet: open (or waiting on its timer), not
--     full, not called off, its day not gone, _open_remind_ok, not booked by them already, and not open for them now
--     ('open'); twenty asks waiting at most ('limit'). However far ahead the opening is. open_reminders_mine(p_id,
--     p_token): the session ids the rider is waiting on, read when the Reserve list first shows a date that is not open.
--  5. session_opening(p_session, p_member): for the calendar file /api/ics writes on an iPhone (functions/api/ics.js,
--     kind 'o'), with no account: an ungated session's name, kind and opening (the member's or everyone's), so the file
--     is written from the database's row and never from words the page sent. 'none' for a date nobody can be reminded
--     of, 'open' once that opening has passed; both carry the session's kind when it is an ungated one, so /api/ics
--     sends the phone back to that date.
--  6. _open_remind_tick, every 5 minutes at minute 1, 6, 11 ... (mm-open-remind, a minute after the jobs that open
--     sessions; a closed session whose opens_at has passed counts as open anyway): an ask whose session was called off,
--     closed (not waiting on a timer), marked full or deleted, that the rider could no longer book (_open_remind_ok:
--     a tag lapsed, membership ended, Saturday by code), or that they booked meanwhile (the waitlist counts), is marked
--     done and says nothing; one whose session is open for that rider now (a member at the members' opening, anyone
--     else at public_at) gets one Updates row through push_outbox (key 'bookopen', args name, day, month, so
--     customer_updates says it in the page's language; tag 'open-<session>-<opening, epoch seconds>', so never twice for
--     one opening, and again when staff move the opening later; cat 'rides': the gate marks it in-app, push stays
--     dormant) leading to that date on Reserve, and is marked sent. Rows go 30 days after they were sent or marked
--     done; one never sent goes once its date has passed or its session is deleted or called off.
--  7. push_words 'bookopen' ("Booking is open" / "{ride} · {day} {month}") and the months as 'kind:monthN', in the ten
--     languages: _updates_text (20261114080300) says an argument 'kind:<key>' as that key's title, so the date reads in
--     the page's language with no function changed.
--
-- APPLY AFTER the Updates list (20261114080300: push_outbox.key / args, _updates_text) and members book first
-- (20261118210800: sessions.public_at); the first statement stops with a plain message without them.
--
-- Rollback:
--   select cron.unschedule('mm-open-remind');
--   drop function if exists public._open_remind_tick(), public.session_opening(text, boolean),
--     public.open_reminders_mine(text, text), public.open_reminder_set(text, text, text, boolean),
--     public._open_remind_ok(public.sessions, text), public._open_at(public.sessions, boolean);
--   delete from public.push_words where key = 'bookopen' or key like 'kind:month%';
--   drop table if exists public.open_reminders;
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $need$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'push_outbox' and column_name = 'key')
     or to_regprocedure('public._updates_text(text,text[],text)') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'sessions' and column_name = 'public_at')
     or to_regprocedure('public.saturday_link_only()') is null or to_regprocedure('public._petromin_holder(text)') is null
     or to_regprocedure('public._vlap_holder(text)') is null then
    raise exception 'open_reminders: apply the Updates list (20261114080300) and members book first (20261118210800) first';
  end if;
end $need$;

-- ── 1. the asks ─────────────────────────────────────────────────────────────────────────────────
create table if not exists public.open_reminders (
  customer_id text not null references public.customers (id) on update cascade on delete cascade
              check (char_length(customer_id) <= 64),
  session_id  text not null references public.sessions (id) on update cascade on delete cascade
              check (char_length(session_id) <= 64),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  primary key (customer_id, session_id)
);
comment on table public.open_reminders is
  'Remind me when booking opens (20261119600200): the rider asked to be told in Updates when booking opens for them. sent_at: told, or nothing to tell (called off, closed, booked, no longer bookable for them). Only definer functions read or write it; a row goes 30 days after sent_at, or unsent once its date has passed or its session is gone.';
create index if not exists open_reminders_wait_idx on public.open_reminders (session_id) where sent_at is null;
alter table public.open_reminders enable row level security;
revoke all on public.open_reminders from public, anon, authenticated;

-- ── 2. when booking opens for a rider ───────────────────────────────────────────────────────────
create or replace function public._open_at(s public.sessions, p_member boolean)
returns timestamptz
language plpgsql stable security definer set search_path to 'public'
as $$
declare w jsonb; v_days integer; v_at text; v_open timestamptz;
begin
  if s.id is null then return null; end if;
  -- the booking window, as _booking_window_guard and _session_published read it; none for the races
  if coalesce(s.ride_kind, '') not in ('vlap', 'arena') then
    select value into w from site_content where key = 'booking.window';
    if w is not null and jsonb_typeof(w) = 'object' and (w->>'days') ~ '^\d{1,4}$' then
      v_days := (w->>'days')::integer;
      v_at := case when (w->>'at') ~ '^\d{2}:\d{2}$' then w->>'at' else '00:00' end;
      begin
        v_open := ((left(s.session_date::text, 10)::date - v_days)::text || ' ' || v_at)::timestamp at time zone 'Asia/Riyadh';
      exception when others then v_open := null;
      end;
    end if;
  end if;
  -- a session waiting on its timer opens at it
  if s.status = 'closed' and s.opens_at is not null then v_open := greatest(v_open, s.opens_at); end if;
  -- members book first: everyone else from public_at
  if not coalesce(p_member, false) and s.public_at is not null then v_open := greatest(v_open, s.public_at); end if;
  return v_open;
end $$;
revoke all on function public._open_at(public.sessions, boolean) from public, anon, authenticated;

-- ── 3. could this rider book the date once it opens ─────────────────────────────────────────────
create or replace function public._open_remind_ok(s public.sessions, p_id text)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select s.id is not null and p_id is not null
     -- a tag-gated date: a live holder of its tag (list_sessions, 20261028100000)
     and (s.required_tag_id is null
          or exists (select 1 from customer_tags ct
                      where ct.customer_id = p_id and ct.tag_id = s.required_tag_id and _ctag_active(ct.starts_at, ct.expires_at)))
     -- members only (_community_booking_gate, 20261108120000): a member, or a Petromin / Victory Lap tag holder on theirs
     and not (s.event_kind = 'community' and not coalesce(s.open_to_all, false) and not _member_active(p_id)
              and not (coalesce(s.ride_kind, '') = 'petromin' and _petromin_holder(p_id))
              and not (coalesce(s.ride_kind, '') = 'vlap' and _vlap_holder(p_id)))
     -- a Saturday ride taken by code alone at micromobility.sa/saturday while staff have that on
     and not (s.event_kind = 'community' and coalesce(nullif(s.ride_kind, ''), 'saturday') = 'saturday' and saturday_link_only());
$$;
revoke all on function public._open_remind_ok(public.sessions, text) from public, anon, authenticated;

-- ── 4. the rider's own asks ─────────────────────────────────────────────────────────────────────
create or replace function public.open_reminder_set(p_id text, p_token text, p_session text, p_on boolean)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare s sessions%rowtype; v_at timestamptz;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if p_on is null or p_session is null then return jsonb_build_object('ok', false, 'error', 'bad'); end if;
  if not p_on then
    delete from open_reminders where customer_id = any(_accts_of(p_id)) and session_id = p_session;
    return jsonb_build_object('ok', true, 'on', false);
  end if;
  select * into s from sessions where id = p_session;
  if not found or s.status = 'deleted' or s.cancelled_at is not null or s.ride_status is not distinct from 'cancelled'
     or not (s.status = 'open' or (s.status = 'closed' and s.opens_at is not null))
     or s.session_date < to_char(_ksa_today(), 'YYYY-MM-DD')
     or not _open_remind_ok(s, p_id) then
    return jsonb_build_object('ok', false, 'error', 'none');
  end if;
  if exists (select 1 from queue_entries q where q.session_id = s.id and q.customer_id = any(_accts_of(p_id))
               and q.status in ('waiting', 'waitlist', 'active', 'done')) then
    return jsonb_build_object('ok', false, 'error', 'booked');
  end if;
  v_at := _open_at(s, _member_active(p_id));
  if v_at is null or v_at <= now() then return jsonb_build_object('ok', false, 'error', 'open'); end if;
  if (select count(*) from open_reminders o where o.customer_id = any(_accts_of(p_id)) and o.sent_at is null and o.session_id <> s.id) >= 20 then
    return jsonb_build_object('ok', false, 'error', 'limit');
  end if;
  insert into open_reminders (customer_id, session_id) values (p_id, s.id)
  on conflict (customer_id, session_id) do update set created_at = now(), sent_at = null;
  return jsonb_build_object('ok', true, 'on', true, 'at', v_at);
end $$;
revoke all on function public.open_reminder_set(text, text, text, boolean) from public;
grant execute on function public.open_reminder_set(text, text, text, boolean) to anon, authenticated;

create or replace function public.open_reminders_mine(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  return jsonb_build_object('ok', true, 'ids',
    (select coalesce(jsonb_agg(distinct o.session_id), '[]'::jsonb) from open_reminders o
      where o.customer_id = any(_accts_of(p_id)) and o.sent_at is null));
end $$;
revoke all on function public.open_reminders_mine(text, text) from public;
grant execute on function public.open_reminders_mine(text, text) to anon, authenticated;

-- ── 5. the opening, for a calendar file written on the server ───────────────────────────────────
create or replace function public.session_opening(p_session text, p_member boolean default false)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare s sessions%rowtype; v_at timestamptz;
begin
  select * into s from sessions where id = p_session;
  if not found or s.required_tag_id is not null then return jsonb_build_object('ok', false, 'error', 'none'); end if;
  -- an ungated date says its kind with a refusal too: the phone is sent back to it
  if s.status = 'deleted' or s.cancelled_at is not null or s.ride_status is not distinct from 'cancelled'
     or not (s.status = 'open' or (s.status = 'closed' and s.opens_at is not null))
     or s.session_date < to_char(_ksa_today(), 'YYYY-MM-DD') then
    return jsonb_build_object('ok', false, 'error', 'none', 'rk', s.ride_kind, 'ek', s.event_kind);
  end if;
  v_at := _open_at(s, coalesce(p_member, false));
  if v_at is null or v_at <= now() then return jsonb_build_object('ok', false, 'error', 'open', 'rk', s.ride_kind, 'ek', s.event_kind); end if;
  return jsonb_build_object('ok', true, 'id', s.id, 'date', s.session_date, 'title', s.title, 'title_ar', s.title_ar,
    'rk', s.ride_kind, 'ek', s.event_kind, 'at', v_at);
end $$;
revoke all on function public.session_opening(text, boolean) from public;
grant execute on function public.session_opening(text, boolean) to anon, authenticated;

-- ── 7. the words ────────────────────────────────────────────────────────────────────────────────
insert into public.push_words (key, lang, title, body) values
  ('bookopen', 'en', 'Booking is open', '{0} · {1} {2}'),
  ('bookopen', 'ar', 'الحجز مفتوح', '{0} · {1} {2}'),
  ('bookopen', 'fr', 'Les réservations sont ouvertes', '{0} · {1} {2}'),
  ('bookopen', 'es', 'Reservas abiertas', '{0} · {1} {2}'),
  ('bookopen', 'pt', 'Reservas abertas', '{0} · {1} {2}'),
  ('bookopen', 'ur', 'بکنگ کھل گئی ہے', '{0} · {1} {2}'),
  ('bookopen', 'hi', 'बुकिंग खुल गई है', '{0} · {1} {2}'),
  ('bookopen', 'tl', 'Bukas na ang booking', '{0} · {2} {1}'),
  ('bookopen', 'ne', 'बुकिङ खुल्यो', '{0} · {1} {2}'),
  ('bookopen', 'bn', 'বুকিং খোলা হয়েছে', '{0} · {1} {2}')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

insert into public.push_words (key, lang, title, body)
select 'kind:month' || m.n, l.lang, l.names[m.n], ''
  from generate_series(1, 12) as m(n)
  cross join (values
    ('en', array['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']),
    ('ar', array['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر']),
    ('fr', array['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']),
    ('es', array['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic']),
    ('pt', array['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']),
    ('ur', array['جنوری', 'فروری', 'مارچ', 'اپریل', 'مئی', 'جون', 'جولائی', 'اگست', 'ستمبر', 'اکتوبر', 'نومبر', 'دسمبر']),
    ('hi', array['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्तूबर', 'नवंबर', 'दिसंबर']),
    ('tl', array['Ene', 'Peb', 'Mar', 'Abr', 'May', 'Hun', 'Hul', 'Ago', 'Set', 'Okt', 'Nob', 'Dis']),
    ('ne', array['जनवरी', 'फेब्रुअरी', 'मार्च', 'अप्रिल', 'मे', 'जुन', 'जुलाई', 'अगस्ट', 'सेप्टेम्बर', 'अक्टोबर', 'नोभेम्बर', 'डिसेम्बर']),
    ('bn', array['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'])
  ) as l(lang, names)
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- ── 6. booking opened: one row in Updates ───────────────────────────────────────────────────────
create or replace function public._open_remind_tick()
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_today text := to_char(_ksa_today(), 'YYYY-MM-DD'); v_n int := 0; r record; s sessions%rowtype; t record;
  v_at timestamptz; v_name text; v_day text; v_mon text; v_ev text; v_lang text;
begin
  -- a row 30 days after it was sent (or marked done); one never sent once its date has passed or its session is gone
  delete from open_reminders o
   where (o.sent_at is not null and o.sent_at < now() - interval '30 days')
      or (o.sent_at is null and not exists (select 1 from sessions x where x.id = o.session_id and x.status <> 'deleted'
                                               and x.cancelled_at is null and x.ride_status is distinct from 'cancelled'
                                               and x.session_date >= v_today));
  for r in select o.customer_id, o.session_id, coalesce(c.merged_into, c.id) as to_id
             from open_reminders o join customers c on c.id = o.customer_id
            where o.sent_at is null
            order by o.created_at loop
    select * into s from sessions where id = r.session_id;
    -- called off, closed (not waiting on its timer), marked full, deleted, its day gone, no longer the rider's to book, or
    -- booked meanwhile: nothing to tell
    if not found or s.status in ('deleted', 'full') or s.cancelled_at is not null or s.ride_status is not distinct from 'cancelled'
       or (s.status = 'closed' and s.opens_at is null) or s.session_date < v_today or not _open_remind_ok(s, r.to_id)
       or exists (select 1 from queue_entries q where q.session_id = s.id and q.customer_id = any(_accts_of(r.to_id))
                    and q.status in ('waiting', 'waitlist', 'active', 'done')) then
      update open_reminders set sent_at = now() where customer_id = r.customer_id and session_id = r.session_id;
      continue;
    end if;
    -- a draft, still waiting on its timer, or not open for this rider yet. A timer that has passed counts as open whether or
    -- not the job that opens sessions has run yet this minute.
    if not ((s.status = 'open' and not coalesce(s.draft, false)) or (s.status = 'closed' and s.opens_at is not null and s.opens_at <= now())) then
      continue;
    end if;
    v_at := _open_at(s, _member_active(r.to_id));
    if v_at is not null and v_at > now() then continue; end if;

    v_name := coalesce(nullif(trim(s.title), ''), 'kind:' || coalesce(s.ride_kind, 'jcc'));
    v_day := extract(day from left(s.session_date, 10)::date)::int::text;
    v_mon := 'kind:month' || extract(month from left(s.session_date, 10)::date)::int;
    -- the Reserve list opens on the date: the event card it lives under, as the app's _evOf reads it
    v_ev := case when s.ride_kind = 'snd96' then 'snd96'
                 when coalesce(s.event_kind, '') <> 'community' then 'jcc'
                 when s.ride_kind in ('event', 'workshop', 'runher', 'vlap', 'arena', 'blood', 'testride') then s.ride_kind
                 else 'community' end;
    -- the stored title and body (what a push would say) in the rider's own language; the list says it in the page's
    select p.lang into v_lang from push_prefs p where p.customer_id = r.to_id;
    select * into t from _push_text(r.to_id, 'bookopen', array[_push_sess_name(r.to_id, s.title, s.ride_kind), v_day,
      coalesce((select w.title from push_words w where w.key = v_mon and w.lang = coalesce(v_lang, 'en')),
               (select w.title from push_words w where w.key = v_mon and w.lang = 'en'), '')]);
    insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
    values (r.to_id, 'open-' || s.id || '-' || coalesce(floor(extract(epoch from v_at))::bigint, 0), left(coalesce(t.title, 'Booking is open'), 120), left(coalesce(t.body, ''), 300),
            '/?ev=' || v_ev || '&session=' || s.id, 'rides', 'bookopen', array[v_name, v_day, v_mon])
    on conflict (customer_id, tag) do nothing;
    if found then v_n := v_n + 1; end if;
    update open_reminders set sent_at = now() where customer_id = r.customer_id and session_id = r.session_id;
  end loop;
  return v_n;
end $$;
revoke all on function public._open_remind_tick() from public, anon, authenticated;

do $cron$ begin
  if exists (select 1 from cron.job where jobname = 'mm-open-remind') then perform cron.unschedule('mm-open-remind'); end if;
  perform cron.schedule('mm-open-remind', '1-59/5 * * * *', 'select public._open_remind_tick()');
end $cron$;

do $chk$
declare f text;
begin
  foreach f in array array['public._open_at(public.sessions,boolean)', 'public._open_remind_ok(public.sessions,text)', 'public.open_reminder_set(text,text,text,boolean)',
                           'public.open_reminders_mine(text,text)', 'public.session_opening(text,boolean)', 'public._open_remind_tick()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._open_at(public.sessions,boolean)', 'public._open_remind_ok(public.sessions,text)', 'public._open_remind_tick()'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  foreach f in array array['public.open_reminder_set(text,text,text,boolean)', 'public.open_reminders_mine(text,text)',
                           'public.session_opening(text,boolean)'] loop
    if not has_function_privilege('anon', f, 'execute') then raise exception 'riders cannot reach %', f; end if;
  end loop;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.open_reminders'::regclass) then
    raise exception 'open_reminders has no row security';
  end if;
  if has_table_privilege('anon', 'public.open_reminders', 'select') or has_table_privilege('authenticated', 'public.open_reminders', 'select') then
    raise exception 'a client can read open_reminders';
  end if;
  if not exists (select 1 from cron.job where jobname = 'mm-open-remind') then raise exception 'the job mm-open-remind is missing'; end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119600200', 'open_reminders')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check: select (select relrowsecurity from pg_class where oid = 'public.open_reminders'::regclass) as rls_true,
--        has_table_privilege('anon', 'public.open_reminders', 'select') as anon_table_false,
--        has_function_privilege('anon', 'public.open_reminder_set(text,text,text,boolean)', 'execute') as anon_set_true,
--        has_function_privilege('anon', 'public.session_opening(text,boolean)', 'execute') as anon_opening_true,
--        has_function_privilege('anon', 'public._open_remind_tick()', 'execute') as anon_tick_false,
--        (select count(*) from public.push_words where key = 'bookopen') as words_10,
--        (select count(*) from public.push_words where key like 'kind:month%') as months_120,
--        (select count(*) from cron.job where jobname = 'mm-open-remind') as cron_1,
--        (select version from supabase_migrations.schema_migrations where version = '20261119600200') as ledger;
