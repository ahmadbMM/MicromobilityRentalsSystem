-- The Updates list (new features build F3; the owner marked it Build now on 2026-11-13): a rider's page listing every
-- message the app addressed to them, newest first, kept 90 days, with an unread state. It is the in-app half of "in-app
-- and web push only", so a message must be on record for every rider it is addressed to, with push on or off.
--
-- APPLY AFTER the Community reach migrations (community_reach and push_consent): this file builds on their push_prefs,
-- push_words, push_outbox.cat / lang, hub_tab_seen, _push_text and _push_sess_name, and refuses to run without them.
--
-- What the reach build did, and what changes here:
--  * push_outbox was written for push subscribers only: _hub_push_tick and _session_change_push filtered on
--    push_subscriptions and push_prefs, and the trigger _push_outbox_gate DROPPED a row the rider had switched off.
--    A rider with push off had no rows at all.
--  * Now the row is written for everyone addressed and the push is a separate step. The gate keeps every row; one that
--    must not be pushed (switch off, Community never switched on, no working browser) is marked sent_at = now(),
--    result = 'inapp', so the drain (/api/push-send reads sent_at is null) never sees it. Consent decides exactly what
--    it decided before; nothing more is pushed.
--
--  1. push_outbox.key + args: what the message is, so the list can say it in the language the page is in (the server
--     knows a rider's language only once they set the push switches). push_outbox.read_at: when the rider opened the list.
--     Rows already in the table are marked read once, when the column is first added.
--     queue_entries.reminded_kind may say 'push': its check (20261009225000) named '24h' and '2h' alone, so the
--     reminder's own mark was refused and, with it, the whole run of _hub_push_tick, as soon as one rider booked for
--     tomorrow had a working push subscription (found in review, 2026-11-13).
--  2. push_words: 'note' (a line from staff), 'wlin' (a place given off the waitlist), 'wloffer' (a freed place to
--     take), and 'remind_s' / 'change_s' (the reminder and the change notice of a session with no bike: "session",
--     never "ride"), in all ten languages.
--  3. _updates_text: a stored message in a given language. _updates_key: the words' key for a session, the '_s' one
--     for a pool, yoga, run or event session.
--  4. _push_outbox_gate, _hub_push_tick, _session_change_push: redefined as above. The evening-before reminder marks
--     reminded_at (kind 'push') only when it really goes out as a push; a booking staff already reminded by hand gets
--     its row in the list and no push. A mark the table refuses never undoes the run's rows.
--  5. Three new writers: _updates_wl_in (a booking leaving the waitlist), _updates_wl_offer (a freed place offered),
--     _updates_note (the line staff write on a Community post: one row per active member; an edit corrects the rows,
--     hiding or deleting the post takes them away).
--  6. customer_updates_unread and customer_updates: the rider's own rows only (their token, their accounts). A
--     Community message older than the member's last open of the Community tab counts as read, as that tab's own read
--     clears its dot. customer_updates marks what it returned as read.
--  7. _updates_sweep, daily (mm-updates-sweep): rows older than 90 days go.
--
-- Headers of the three redefined functions copied from 20261114000200_push_consent.sql (function attributes trap).
--
-- Rollback: run sections 2, 4 and 5 of 20261114000200_push_consent.sql again (the three functions as they were), then
--   select cron.unschedule('mm-updates-sweep');
--   drop trigger if exists queue_entries_updates_wl on public.queue_entries;
--   drop trigger if exists waitlist_offers_updates on public.waitlist_offers;
--   drop trigger if exists hub_posts_updates_note on public.hub_posts;
--   drop function if exists public.customer_updates(text, text, text), public.customer_updates_unread(text, text),
--     public._updates_wl_in(), public._updates_wl_offer(), public._updates_note(), public._updates_sweep(),
--     public._updates_text(text, text[], text), public._updates_key(text, text);
--   delete from public.push_words where key in ('note', 'wlin', 'wloffer', 'remind_s', 'change_s');
--   alter table public.push_outbox drop column if exists key, drop column if exists args, drop column if exists read_at;
-- queue_entries_reminded_kind_chk stays as widened here: the reach build's own reminder writes 'push' too.

begin;

do $need$
begin
  if to_regclass('public.push_prefs') is null or to_regclass('public.push_words') is null or to_regclass('public.hub_tab_seen') is null then
    raise exception 'updates_list: apply the Community reach migrations (community_reach, push_consent) first';
  end if;
end $need$;

-- ── 1. what a message is, and when its rider read it ───────────────────────────────────────────
alter table public.push_outbox add column if not exists key text check (key is null or char_length(key) <= 40);
alter table public.push_outbox add column if not exists args text[];
do $read$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'push_outbox' and column_name = 'read_at') then
    alter table public.push_outbox add column read_at timestamptz;
    -- what was sent before the list existed is not news
    update public.push_outbox set read_at = created_at;
  end if;
end $read$;
comment on column public.push_outbox.read_at is
  'When the rider opened their Updates list with this row on it; null = unread (20261114010300).';
comment on column public.push_outbox.key is
  'The push_words key this message was written from, with args: the Updates list says it in the page''s language; null = title and body as stored (20261114010300).';

-- The evening-before reminder marks its booking reminded_kind = 'push' (_hub_push_tick, below and in 20261114000200).
-- The check of 20261009225000 allowed '24h' and '2h' alone and refused it, which rolled the whole run back. Dropped and
-- added again with the three kinds; every value on file is one of the first two.
alter table public.queue_entries drop constraint if exists queue_entries_reminded_kind_chk;
alter table public.queue_entries add constraint queue_entries_reminded_kind_chk
  check (reminded_kind is null or reminded_kind in ('24h', '2h', 'push'));
comment on column public.queue_entries.reminded_kind is
  'Which reminder that was: 24h | 2h (staff, by WhatsApp), push (the evening-before reminder, when it went out as a push) (20261009225000, 20261114010300).';

-- ── 2. the words ────────────────────────────────────────────────────────────────────────────────
insert into public.push_words (key, lang, title, body) values
  ('note',    'en', 'A note from the team', '{0}'),
  ('note',    'ar', 'رسالة من الفريق', '{0}'),
  ('note',    'fr', 'Un mot de l''équipe', '{0}'),
  ('note',    'es', 'Una nota del equipo', '{0}'),
  ('note',    'pt', 'Uma mensagem da equipe', '{0}'),
  ('note',    'ur', 'ٹیم کی طرف سے پیغام', '{0}'),
  ('note',    'hi', 'टीम की ओर से संदेश', '{0}'),
  ('note',    'tl', 'Mensahe mula sa team', '{0}'),
  ('note',    'ne', 'टिमको तर्फबाट सन्देश', '{0}'),
  ('note',    'bn', 'টিমের পক্ষ থেকে বার্তা', '{0}'),
  ('wlin',    'en', 'You have a place', '{0}: you are off the waitlist and booked'),
  ('wlin',    'ar', 'أصبح لك مكان', '{0}: خرجت من قائمة الانتظار وتم تأكيد حجزك'),
  ('wlin',    'fr', 'Vous avez une place', '{0} : vous quittez la liste d''attente, votre réservation est confirmée'),
  ('wlin',    'es', 'Tienes plaza', '{0}: sales de la lista de espera y tu reserva está confirmada'),
  ('wlin',    'pt', 'Você tem uma vaga', '{0}: você saiu da lista de espera e a sua reserva está confirmada'),
  ('wlin',    'ur', 'آپ کو جگہ مل گئی', '{0}: آپ انتظار کی فہرست سے نکل گئے ہیں اور آپ کی بکنگ کنفرم ہے'),
  ('wlin',    'hi', 'आपको जगह मिल गई', '{0}: आप प्रतीक्षा सूची से बाहर हैं और आपकी बुकिंग पक्की है'),
  ('wlin',    'tl', 'May puwesto ka na', '{0}: wala ka na sa waitlist at kumpirmado na ang booking mo'),
  ('wlin',    'ne', 'तपाईंले ठाउँ पाउनुभयो', '{0}: तपाईं प्रतीक्षा सूचीबाट बाहिर हुनुभयो र तपाईंको बुकिङ पक्का भयो'),
  ('wlin',    'bn', 'আপনি জায়গা পেয়েছেন', '{0}: আপনি অপেক্ষার তালিকা থেকে বেরিয়ে এসেছেন এবং আপনার বুকিং নিশ্চিত'),
  ('wloffer', 'en', 'A place is free for you', '{0}: take it within {1} minutes'),
  ('wloffer', 'ar', 'يوجد مكان شاغر لك', '{0}: أكّده خلال {1} دقيقة'),
  ('wloffer', 'fr', 'Une place est libre pour vous', '{0} : prenez-la dans les {1} minutes'),
  ('wloffer', 'es', 'Hay una plaza libre para ti', '{0}: tómala en los próximos {1} minutos'),
  ('wloffer', 'pt', 'Há uma vaga livre para você', '{0}: garanta-a em até {1} minutos'),
  ('wloffer', 'ur', 'آپ کے لیے ایک جگہ خالی ہے', '{0}: {1} منٹ کے اندر اسے لے لیں'),
  ('wloffer', 'hi', 'आपके लिए एक जगह खाली है', '{0}: {1} मिनट के अंदर इसे ले लें'),
  ('wloffer', 'tl', 'May bakanteng puwesto para sa iyo', '{0}: kunin ito sa loob ng {1} minuto'),
  ('wloffer', 'ne', 'तपाईंका लागि एउटा ठाउँ खाली छ', '{0}: {1} मिनेटभित्र लिनुहोस्'),
  ('wloffer', 'bn', 'আপনার জন্য একটি জায়গা খালি আছে', '{0}: {1} মিনিটের মধ্যে নিয়ে নিন'),
  -- A session with no bike (pool, yoga, a run, an event) is never called a ride (the owner's rule, 2026-10-18): the
  -- reach build's 'remind' and 'change' say "ride", and since this file their rows are on every booked rider's list.
  -- The same two messages with "session"; the text under the title is the reach build's own.
  ('remind_s', 'en', 'Session tomorrow', '{0}, meet at {1}'),
  ('remind_s', 'ar', 'فعاليتك غدًا', '{0}، التجمّع الساعة {1}'),
  ('remind_s', 'fr', 'Séance demain', '{0}, rendez-vous à {1}'),
  ('remind_s', 'es', 'Sesión mañana', '{0}, nos vemos a las {1}'),
  ('remind_s', 'pt', 'Sessão amanhã', '{0}, encontro às {1}'),
  ('remind_s', 'ur', 'کل سیشن ہے', '{0}، {1} بجے ملیں'),
  ('remind_s', 'hi', 'कल सत्र है', '{0}, {1} बजे मिलें'),
  ('remind_s', 'tl', 'May session bukas', '{0}, magkita tayo nang {1}'),
  ('remind_s', 'ne', 'भोलि सत्र छ', '{0}, {1} मा भेटौं'),
  ('remind_s', 'bn', 'আগামীকাল সেশন', '{0}, {1}-এ দেখা হবে'),
  ('change_s', 'en', 'Your session has changed', '{0}: open your ticket for the new details'),
  ('change_s', 'ar', 'تغيّرت تفاصيل فعاليتك', '{0}: افتح تذكرتك لترى التفاصيل الجديدة'),
  ('change_s', 'fr', 'Votre séance a changé', '{0} : ouvrez votre billet pour voir les nouveaux détails'),
  ('change_s', 'es', 'Tu sesión ha cambiado', '{0}: abre tu entrada para ver los nuevos detalles'),
  ('change_s', 'pt', 'A sua sessão mudou', '{0}: abra o seu ingresso para ver os novos detalhes'),
  ('change_s', 'ur', 'آپ کے سیشن میں تبدیلی ہوئی ہے', '{0}: نئی تفصیلات کے لیے اپنا ٹکٹ کھولیں'),
  ('change_s', 'hi', 'आपका सत्र बदल गया है', '{0}: नई जानकारी के लिए अपना टिकट खोलें'),
  ('change_s', 'tl', 'Nagbago ang session mo', '{0}: buksan ang ticket mo para sa mga bagong detalye'),
  ('change_s', 'ne', 'तपाईंको सत्र परिवर्तन भएको छ', '{0}: नयाँ विवरणका लागि आफ्नो टिकट खोल्नुहोस्'),
  ('change_s', 'bn', 'আপনার সেশনে পরিবর্তন হয়েছে', '{0}: নতুন তথ্যের জন্য আপনার টিকিট খুলুন')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- ── 3. a stored message in one language ────────────────────────────────────────────────────────
-- English when that language has no row; placeholders filled in order. An argument 'kind:<ride kind>' is that kind's
-- name in the language (a session staff gave no title). A note carries its two lines: Arabic for Arabic, else English.
create or replace function public._updates_text(p_key text, p_args text[], p_lang text, out title text, out body text)
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_lang text := case when p_lang in ('en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn') then p_lang else 'en' end;
  i int; a text;
begin
  select w.title, w.body into title, body from push_words w where w.key = p_key and w.lang = v_lang;
  if title is null then select w.title, w.body into title, body from push_words w where w.key = p_key and w.lang = 'en'; end if;
  if title is null then return; end if;
  if p_key = 'note' then
    body := case when v_lang = 'ar' then coalesce(nullif(p_args[2], ''), p_args[1], '')
                 else coalesce(nullif(p_args[1], ''), p_args[2], '') end;
    return;
  end if;
  for i in 1 .. coalesce(array_length(p_args, 1), 0) loop
    a := coalesce(p_args[i], '');
    if a like 'kind:%' then
      a := coalesce((select w.title from push_words w where w.key = a and w.lang = v_lang),
                    (select w.title from push_words w where w.key = a and w.lang = 'en'), 'MicroMobility');
    end if;
    title := replace(title, '{' || (i - 1) || '}', a);
    body := replace(body, '{' || (i - 1) || '}', a);
  end loop;
end $$;
revoke all on function public._updates_text(text, text[], text) from public, anon, authenticated;

-- The words' key for a session's message: 'remind' or 'change' as given for a ride, the '_s' one ("session") for a
-- session with no bike. The kinds are the app's own (KIND_TRAITS with bike: false, read through _session_kind, which
-- answers as the app's _rideKind does): a new kind without a bike joins this list.
create or replace function public._updates_key(p_key text, p_session text)
returns text
language sql stable security definer set search_path to 'public'
as $$
  select case when _session_kind(p_session) in ('swim', 'workshop', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'blood', 'yoga')
              then p_key || '_s' else p_key end;
$$;
revoke all on function public._updates_key(text, text) from public, anon, authenticated;

-- ── 4. the row is always kept; only its push is decided ────────────────────────────────────────
create or replace function public._push_outbox_gate()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.tag like 'hub-%' then new.cat := 'community'; end if;
  if new.lang is null then select p.lang into new.lang from push_prefs p where p.customer_id = new.customer_id; end if;
  -- The Updates list holds every row. No push: the rider switched its kind off, never switched Community on, or has no
  -- browser that still takes one. Marked sent, so the drain never reads it.
  if new.sent_at is null and (
       (new.cat = 'community' and not exists (select 1 from push_prefs p where p.customer_id = new.customer_id and p.community))
    or (new.cat = 'rides' and exists (select 1 from push_prefs p where p.customer_id = new.customer_id and not p.rides))
    or not exists (select 1 from push_subscriptions ps where ps.customer_id = new.customer_id and coalesce(ps.fail_count, 0) < 3)) then
    new.sent_at := now();
    new.result := 'inapp';
  end if;
  return new;
end $$;
revoke all on function public._push_outbox_gate() from public, anon, authenticated;
drop trigger if exists push_outbox_gate on public.push_outbox;
create trigger push_outbox_gate before insert on public.push_outbox for each row execute function public._push_outbox_gate();

create or replace function public._hub_push_tick()
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_ksa timestamp := now() at time zone 'Asia/Riyadh'; v_today date := (now() at time zone 'Asia/Riyadh')::date;
  v_month date := date_trunc('month', (now() at time zone 'Asia/Riyadh'))::date; v_n int := 0; r record; t record;
  v_sess text; v_at text; v_sent timestamptz; v_key text;
begin
  -- the evening before, from 21:00: every live booking on tomorrow's sessions, with push or without
  if extract(hour from v_ksa) >= 21 then
    for r in select q.id, q.customer_id, q.reminded_at, s.id as sid, s.title, s.ride_kind, w.starts_at
               from queue_entries q join sessions s on s.id = q.session_id
               cross join lateral _session_window(s) w
              where s.session_date = to_char(v_today + 1, 'YYYY-MM-DD') and s.status <> 'deleted' and s.cancelled_at is null
                and s.ride_status is distinct from 'cancelled' and not coalesce(s.draft, false)
                and q.status = 'waiting' and q.customer_id is not null
                and coalesce(q.approval, 'approved') = 'approved'
                and not exists (select 1 from push_outbox o where o.customer_id = q.customer_id and o.tag = 'rem-' || q.id) loop
      v_sess := coalesce(nullif(trim(r.title), ''), 'kind:' || coalesce(r.ride_kind, 'jcc'));
      v_at := to_char(r.starts_at at time zone 'Asia/Riyadh', 'HH24:MI');
      v_key := _updates_key('remind', r.sid); -- a session with no bike is not a ride
      select * into t from _push_text(r.customer_id, v_key, array[_push_sess_name(r.customer_id, r.title, r.ride_kind), v_at]);
      -- staff already reminded this booking by hand: its row is for the list only
      insert into push_outbox (customer_id, tag, title, body, url, cat, key, args, sent_at, result)
      values (r.customer_id, 'rem-' || r.id, left(t.title, 120), left(t.body, 300), '/my-bookings', 'rides', v_key, array[v_sess, v_at],
              case when r.reminded_at is not null then now() end, case when r.reminded_at is not null then 'inapp' end)
      on conflict (customer_id, tag) do nothing
      returning sent_at into v_sent;
      if found then
        -- going out as a push (the gate left it waiting): staff skip that rider
        if v_sent is null then
          begin
            update queue_entries set reminded_at = now(), reminded_kind = 'push' where id = r.id and reminded_at is null;
          exception when others then
            null; -- a mark the table refuses never undoes the run's rows
          end;
        end if;
        v_n := v_n + 1;
      end if;
    end loop;
  end if;

  -- the 1st, from 10:00 to 21:59: the month's challenge is ready, to every active member
  if extract(day from v_ksa) = 1 and extract(hour from v_ksa) between 10 and 21 then
    for r in select h.customer_id from hub_levels h
              where h.month = v_month and _member_active(h.customer_id)
                and not exists (select 1 from push_outbox o
                                 where o.customer_id = h.customer_id and o.tag = 'hub-ch-' || to_char(v_month, 'YYYYMM')) loop
      select * into t from _push_text(r.customer_id, 'challenge', '{}');
      insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
      values (r.customer_id, 'hub-ch-' || to_char(v_month, 'YYYYMM'), left(t.title, 120), left(t.body, 300), '/members?src=push', 'community',
              'challenge', '{}')
      on conflict (customer_id, tag) do nothing;
      if found then v_n := v_n + 1; end if;
    end loop;
  end if;

  -- the Saturday recap, written in the last 12 hours, to the members who rode it (08:00 to 21:59)
  if extract(hour from v_ksa) between 8 and 21 then
    for r in select distinct p.id as pid, p.riders, q.customer_id
               from hub_posts p join queue_entries q on q.session_id = p.session_id and q.status = 'done'
              where p.auto and not p.hidden and p.created_at > now() - interval '12 hours' and coalesce(p.riders, 0) >= 10
                and q.customer_id is not null and _member_active(q.customer_id)
                and not exists (select 1 from push_outbox o where o.customer_id = q.customer_id and o.tag = 'hub-rc-' || p.id) loop
      select * into t from _push_text(r.customer_id, 'recap', array[r.riders::text]);
      insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
      values (r.customer_id, 'hub-rc-' || r.pid, left(t.title, 120), left(t.body, 300), '/members?src=push', 'community',
              'recap', array[r.riders::text])
      on conflict (customer_id, tag) do nothing;
      if found then v_n := v_n + 1; end if;
    end loop;
  end if;
  return v_n;
end $$;
revoke all on function public._hub_push_tick() from public, anon, authenticated;

create or replace function public._session_change_push()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare v_key text;
begin
  begin
    if new.session_date < to_char(_ksa_today(), 'YYYY-MM-DD') or new.session_date > to_char(_ksa_today() + 7, 'YYYY-MM-DD')
       or new.status = 'deleted' then
      return null;
    end if;
    if (case when new.bike_slots ~ '^\s*\{' then (new.bike_slots::jsonb ->> '_time') end)
         is distinct from (case when old.bike_slots ~ '^\s*\{' then (old.bike_slots::jsonb ->> '_time') end)
       or new.meet_url is distinct from old.meet_url
       or new.meet_lat is distinct from old.meet_lat or new.meet_lng is distinct from old.meet_lng
       or new.ride_status is distinct from old.ride_status then
      v_key := _updates_key('change', new.id); -- a session with no bike is not a ride
      -- everyone booked, with push or without (the gate decides the push)
      insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
      select q.customer_id, left('chg-' || new.id || '-' || to_char(now() at time zone 'Asia/Riyadh', 'YYYYMMDDHH24MI'), 64),
             left(t.title, 120), left(t.body, 300), '/my-bookings', 'rides',
             v_key, array[coalesce(nullif(trim(new.title), ''), 'kind:' || coalesce(new.ride_kind, 'jcc'))]
        from (select distinct x.customer_id from queue_entries x
               where x.session_id = new.id and x.status = 'waiting' and x.customer_id is not null
                 and coalesce(x.approval, 'approved') = 'approved') q
        cross join lateral _push_text(q.customer_id, v_key,
                     array[_push_sess_name(q.customer_id, new.title, new.ride_kind)]) t
      on conflict (customer_id, tag) do nothing;
    end if;
  exception when others then
    null; -- a staff edit is never refused for a notification
  end;
  return null;
end $$;
revoke all on function public._session_change_push() from public, anon, authenticated;

-- ── 5. the messages nothing wrote down yet ─────────────────────────────────────────────────────
-- A booking leaves the waitlist for a place (the fill rule, staff, or the database's own promotion). Not when the rider
-- has just taken an offered place themselves. The tag is the one a staff device's own push uses, so a phone shows one
-- notification for it.
create or replace function public._updates_wl_in()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare s sessions%rowtype; t record;
begin
  begin
    if new.customer_id is null then return null; end if;
    if exists (select 1 from waitlist_offers o
                where o.booking_id = new.id and o.status = 'claimed' and o.claimed_at > now() - interval '5 minutes') then
      return null;
    end if;
    select * into s from sessions where id = new.session_id;
    if not found or s.status = 'deleted' or s.session_date < to_char(_ksa_today(), 'YYYY-MM-DD') then return null; end if;
    select * into t from _push_text(new.customer_id, 'wlin', array[_push_sess_name(new.customer_id, s.title, s.ride_kind)]);
    insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
    values (new.customer_id, left('booking-' || new.id, 64), left(t.title, 120), left(t.body, 300), '/my-bookings', 'rides',
            'wlin', array[coalesce(nullif(trim(s.title), ''), 'kind:' || coalesce(s.ride_kind, 'jcc'))])
    on conflict (customer_id, tag) do nothing;
  exception when others then
    null; -- a booking is never refused for a message
  end;
  return null;
end $$;
revoke all on function public._updates_wl_in() from public, anon, authenticated;
drop trigger if exists queue_entries_updates_wl on public.queue_entries;
create trigger queue_entries_updates_wl after update of status on public.queue_entries
  for each row when (old.status = 'waitlist' and new.status = 'waiting') execute function public._updates_wl_in();

-- A freed place offered to a waitlisted rider (waitlist_offers): the row opens the claim itself (/?claim=<token>, the
-- address staff send by WhatsApp), and says how long the offer holds.
create or replace function public._updates_wl_offer()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare q queue_entries%rowtype; s sessions%rowtype; t record; v_min text;
begin
  begin
    if new.status is distinct from 'open' then return null; end if;
    select * into q from queue_entries where id = new.booking_id;
    if not found or q.customer_id is null then return null; end if;
    select * into s from sessions where id = new.session_id;
    if not found then return null; end if;
    v_min := greatest(1, round(extract(epoch from (new.expires_at - coalesce(new.offered_at, now()))) / 60.0))::int::text;
    select * into t from _push_text(q.customer_id, 'wloffer', array[_push_sess_name(q.customer_id, s.title, s.ride_kind), v_min]);
    insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
    values (q.customer_id, left('offer-' || new.id, 64), left(t.title, 120), left(t.body, 300), '/?claim=' || new.token, 'rides',
            'wloffer', array[coalesce(nullif(trim(s.title), ''), 'kind:' || coalesce(s.ride_kind, 'jcc')), v_min])
    on conflict (customer_id, tag) do nothing;
  exception when others then
    null; -- an offer is never refused for a message
  end;
  return null;
end $$;
revoke all on function public._updates_wl_offer() from public, anon, authenticated;
drop trigger if exists waitlist_offers_updates on public.waitlist_offers;
create trigger waitlist_offers_updates after insert on public.waitlist_offers
  for each row execute function public._updates_wl_offer();

-- The line staff write on a Community post (the staff card on the Community tab): one row for every active member
-- while the post shows. An edited line corrects the rows already written (not pushed, not unread, again); a post hidden,
-- emptied or deleted takes its rows away, the recap's too.
create or replace function public._updates_note()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare v_en text; v_ar text;
begin
  begin
    if tg_op = 'DELETE' then
      delete from push_outbox where tag in ('hub-note-' || old.id, 'hub-rc-' || old.id);
      return null;
    end if;
    v_en := nullif(trim(coalesce(new.line, '')), '');
    v_ar := nullif(trim(coalesce(new.line_ar, '')), '');
    if new.hidden then
      delete from push_outbox where tag in ('hub-note-' || new.id, 'hub-rc-' || new.id);
      return null;
    end if;
    if v_en is null and v_ar is null then
      delete from push_outbox where tag = 'hub-note-' || new.id;
      return null;
    end if;
    update push_outbox o
       set args = array[coalesce(v_en, ''), coalesce(v_ar, '')],
           body = left(case when o.lang = 'ar' then coalesce(v_ar, v_en) else coalesce(v_en, v_ar) end, 300)
     where o.tag = 'hub-note-' || new.id
       and o.args is distinct from array[coalesce(v_en, ''), coalesce(v_ar, '')];
    if _ksa_today() between new.shows_from and new.shows_until then
      insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
      select m.id, 'hub-note-' || new.id, left(t.title, 120), left(t.body, 300), '/members?src=push', 'community',
             'note', array[coalesce(v_en, ''), coalesce(v_ar, '')]
        from (select distinct ct.customer_id as id
                from customer_tags ct join customers c on c.id = ct.customer_id
               where ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at) and c.merged_into is null) m
        cross join lateral _push_text(m.id, 'note',
                     array[case when (select p.lang from push_prefs p where p.customer_id = m.id) = 'ar'
                                then coalesce(v_ar, v_en) else coalesce(v_en, v_ar) end]) t
      on conflict (customer_id, tag) do nothing;
    end if;
  exception when others then
    null; -- a staff post is never refused for a message
  end;
  return null;
end $$;
revoke all on function public._updates_note() from public, anon, authenticated;
drop trigger if exists hub_posts_updates_note on public.hub_posts;
create trigger hub_posts_updates_note after insert or update of line, line_ar, hidden or delete on public.hub_posts
  for each row execute function public._updates_note();

-- ── 6. the rider's reads: their own rows only ──────────────────────────────────────────────────
-- How many are unread (the Community tab's dot, the app icon's badge). comm: how many of them are Community's.
create or replace function public.customer_updates_unread(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_seen timestamptz; v_n int; v_c int;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select tab_at into v_seen from hub_tab_seen where customer_id = p_id;
  select count(*), count(*) filter (where o.cat = 'community') into v_n, v_c
    from push_outbox o
   where o.customer_id = any(_accts_of(p_id)) and o.read_at is null and o.created_at > now() - interval '90 days'
     and not (o.cat = 'community' and v_seen is not null and o.created_at <= v_seen);
  return jsonb_build_object('ok', true, 'n', coalesce(v_n, 0), 'comm', coalesce(v_c, 0));
end $$;
revoke all on function public.customer_updates_unread(text, text) from public;
grant execute on function public.customer_updates_unread(text, text) to anon, authenticated;

-- The list, newest first, said in the page's language, 90 days, at most 200 rows. Opening it marks every row read.
create or replace function public.customer_updates(p_id text, p_token text, p_lang text default 'en')
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_accts text[]; v_seen timestamptz; v_rows jsonb;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  v_accts := _accts_of(p_id);
  select tab_at into v_seen from hub_tab_seen where customer_id = p_id;
  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id desc), '[]'::jsonb) into v_rows
    from (select o.created_at, o.id, jsonb_build_object(
                   'id', o.id,
                   'kind', case when o.tag like 'rem-%' then 'reminder'
                                when o.tag like 'chg-%' then 'change'
                                when o.tag like 'booking-%' or o.tag like 'offer-%' then 'waitlist'
                                when o.tag like 'hub-ch-%' then 'challenge'
                                when o.tag like 'hub-rc-%' then 'recap'
                                when o.tag like 'hub-note-%' then 'note'
                                else 'info' end,
                   'title', coalesce(nullif(w.title, ''), o.title),
                   'body', case when nullif(w.title, '') is not null then coalesce(w.body, '')
                                -- the older messages hold both languages, "English | Arabic"
                                when o.key is null and position(' | ' in o.body) > 0
                                  then case when p_lang = 'ar' then split_part(o.body, ' | ', 2) else split_part(o.body, ' | ', 1) end
                                else o.body end,
                   'at', o.created_at,
                   'url', o.url,
                   'unread', (o.read_at is null and not (o.cat = 'community' and v_seen is not null and o.created_at <= v_seen))) as j
            from push_outbox o
            left join lateral (select t.title, t.body from _updates_text(o.key, o.args, p_lang) t where o.key is not null) w on true
           where o.customer_id = any(v_accts) and o.created_at > now() - interval '90 days'
           order by o.created_at desc, o.id desc
           limit 200) x;
  update push_outbox set read_at = now() where customer_id = any(v_accts) and read_at is null;
  return jsonb_build_object('ok', true, 'rows', v_rows);
end $$;
revoke all on function public.customer_updates(text, text, text) from public;
grant execute on function public.customer_updates(text, text, text) to anon, authenticated;

-- ── 7. ninety days ──────────────────────────────────────────────────────────────────────────────
create or replace function public._updates_sweep()
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare n int;
begin
  delete from push_outbox where created_at < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public._updates_sweep() from public, anon, authenticated;

select cron.schedule('mm-updates-sweep', '20 1 * * *', 'select public._updates_sweep()');

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114010300', 'updates_list')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity) as no_rls_0,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('_updates_text', '_updates_key', '_push_outbox_gate', '_hub_push_tick', '_session_change_push', '_updates_wl_in',
                         '_updates_wl_offer', '_updates_note', 'customer_updates_unread', 'customer_updates', '_updates_sweep')) as definer_11,
       has_function_privilege('anon', 'public.customer_updates(text,text,text)', 'execute') as anon_list_true,
       has_function_privilege('anon', 'public.customer_updates_unread(text,text)', 'execute') as anon_unread_true,
       has_function_privilege('anon', 'public._updates_sweep()', 'execute') as anon_sweep_false,
       has_table_privilege('anon', 'public.push_outbox', 'select') as anon_store_false,
       (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'push_outbox'
         and column_name in ('key', 'args', 'read_at')) as columns_3,
       (select count(*) from public.push_words where key in ('note', 'wlin', 'wloffer', 'remind_s', 'change_s')) as words_50,
       (select pg_get_constraintdef(oid) like '%push%' from pg_constraint
         where conname = 'queue_entries_reminded_kind_chk' and conrelid = 'public.queue_entries'::regclass) as reminded_push_true,
       (select count(*) from pg_trigger where tgname in ('push_outbox_gate', 'queue_entries_updates_wl', 'waitlist_offers_updates', 'hub_posts_updates_note')) as triggers_4,
       (select count(*) from cron.job where jobname = 'mm-updates-sweep') as cron_1,
       (select version from supabase_migrations.schema_migrations where version = '20261114010300') as ledger;
