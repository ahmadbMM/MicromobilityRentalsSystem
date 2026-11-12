-- Push notifications for riders, with consent built in (reports/Community tab reach after launch.md R16 and R18; the
-- user, 2026-11-13: Build now). Nothing here sends until the owner sets the Cloudflare Pages push secrets and the app
-- ships its public key (R15): push_outbox is drained by functions/api/push-send.js, which is a no-op until then.
--
--  1. push_prefs: two switches per rider, "My rides" (on by default once they turn push on) and "Community" (off until
--     they turn it on), and the language their messages are written in. push_consents: one row per change, with the
--     exact words the rider saw, the privacy notice version and a short device label (PDPL Art. 25 and Implementing
--     Regulations Art. 28: documented consent, an easy way out).
--  2. push_outbox.cat: 'rides' or 'community'. A trigger drops a row the rider has switched off, and a Community row
--     for a rider who never switched Community on, whoever queues it.
--  3. push_words: the messages in all ten languages, with {0}, {1} placeholders, and the session kinds' names (the
--     app's own words).
--  4. _hub_push_tick (every 10 minutes): the reminder the evening before (from 21:00 KSA, after the evening prayers in
--     every season, marking reminded_at with kind 'push' so staff skip that rider), the new month's challenge on the 1st
--     (from 10:00 KSA), and the Saturday recap to the members who rode (between 08:00 and 22:00 KSA).
--  5. _session_change_push: a booked session's start time, meeting point or ride status changing within the next week
--     tells its riders (a pass already in Wallet never updates).
--
-- Headers copied from the live definitions (function attributes trap).

begin;

-- ── 1. the switches and the consent record ─────────────────────────────────────────────────────
create table if not exists public.push_prefs (
  customer_id text primary key references public.customers (id) on update cascade on delete cascade,
  rides       boolean not null default true,
  community   boolean not null default false,
  lang        text not null default 'en' check (lang in ('en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn')),
  updated_at  timestamptz not null default now()
);
alter table public.push_prefs enable row level security;
revoke all on public.push_prefs from public, anon, authenticated;

create table if not exists public.push_consents (
  id          bigserial primary key,
  customer_id text not null references public.customers (id) on update cascade on delete cascade,
  rides       boolean not null,
  community   boolean not null,
  lang        text,
  words       text check (char_length(words) <= 800),
  notice      text check (char_length(notice) <= 40),
  device      text check (char_length(device) <= 80),
  at          timestamptz not null default now()
);
create index if not exists push_consents_customer_idx on public.push_consents (customer_id, at desc);
alter table public.push_consents enable row level security;
revoke all on public.push_consents from public, anon, authenticated;
revoke all on sequence public.push_consents_id_seq from public, anon, authenticated;
grant select on public.push_consents to authenticated;
drop policy if exists "staff read" on public.push_consents;
create policy "staff read" on public.push_consents for select to authenticated using ((select is_staff()));

create or replace function public.customer_push_prefs(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare r push_prefs%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select * into r from push_prefs where customer_id = p_id;
  if not found then return jsonb_build_object('ok', true, 'rides', true, 'community', false, 'lang', null); end if;
  return jsonb_build_object('ok', true, 'rides', r.rides, 'community', r.community, 'lang', r.lang);
end $$;
revoke all on function public.customer_push_prefs(text, text) from public;
grant execute on function public.customer_push_prefs(text, text) to anon, authenticated;

create or replace function public.customer_push_prefs_set(p_id text, p_token text, p_rides boolean, p_community boolean,
  p_lang text, p_words text, p_notice text, p_device text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_lang text := case when p_lang in ('en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn') then p_lang else 'en' end;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if p_rides is null or p_community is null then return jsonb_build_object('ok', false, 'error', 'args'); end if;
  -- at most 30 changes a day: the record stays readable
  if (select count(*) from push_consents where customer_id = p_id and at > now() - interval '1 day') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'busy');
  end if;
  insert into push_prefs (customer_id, rides, community, lang, updated_at) values (p_id, p_rides, p_community, v_lang, now())
  on conflict (customer_id) do update set rides = excluded.rides, community = excluded.community, lang = excluded.lang, updated_at = now();
  insert into push_consents (customer_id, rides, community, lang, words, notice, device)
  values (p_id, p_rides, p_community, v_lang, left(p_words, 800), left(p_notice, 40), left(p_device, 80));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.customer_push_prefs_set(text, text, boolean, boolean, text, text, text, text) from public;
grant execute on function public.customer_push_prefs_set(text, text, boolean, boolean, text, text, text, text) to anon, authenticated;

-- ── 2. a category on every queued message, and the switches applied to it ──────────────────────
alter table public.push_outbox add column if not exists cat text not null default 'rides' check (cat in ('rides', 'community'));
-- the rider's language, for the notification's lang and dir (the drain reads it)
alter table public.push_outbox add column if not exists lang text;

create or replace function public._push_outbox_gate()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.tag like 'hub-%' then new.cat := 'community'; end if;
  if new.lang is null then select p.lang into new.lang from push_prefs p where p.customer_id = new.customer_id; end if;
  if new.cat = 'community' and not exists (select 1 from push_prefs p where p.customer_id = new.customer_id and p.community) then
    return null;
  end if;
  if new.cat = 'rides' and exists (select 1 from push_prefs p where p.customer_id = new.customer_id and not p.rides) then
    return null;
  end if;
  return new;
end $$;
revoke all on function public._push_outbox_gate() from public, anon, authenticated;
drop trigger if exists push_outbox_gate on public.push_outbox;
create trigger push_outbox_gate before insert on public.push_outbox for each row execute function public._push_outbox_gate();

-- ── 3. the words ────────────────────────────────────────────────────────────────────────────────
create table if not exists public.push_words (
  key   text not null check (char_length(key) <= 40),
  lang  text not null check (lang in ('en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn')),
  title text not null check (char_length(title) <= 120),
  body  text not null default '' check (char_length(body) <= 300),
  primary key (key, lang)
);
alter table public.push_words enable row level security;
revoke all on public.push_words from public, anon, authenticated;

insert into public.push_words (key, lang, title, body) values
  ('remind',    'en', 'Ride tomorrow', '{0}, meet at {1}'),
  ('remind',    'ar', 'رحلتك غدًا', '{0}، التجمّع الساعة {1}'),
  ('change',    'en', 'Your ride has changed', '{0}: open your ticket for the new details'),
  ('change',    'ar', 'تغيّرت تفاصيل رحلتك', '{0}: افتح تذكرتك لترى التفاصيل الجديدة'),
  ('challenge', 'en', 'Your new challenge is ready', 'Open Community to see this month''s challenge'),
  ('challenge', 'ar', 'تحدّيك الجديد جاهز', 'افتح المجتمع لترى تحدّي هذا الشهر'),
  ('recap',     'en', 'Saturday''s recap is in', '{0} riders came out this Saturday'),
  ('recap',     'ar', 'ملخّص السبت وصل', 'خرج {0} راكبًا هذا السبت'),
  ('kind:jcc',      'en', 'Jeddah Corniche Circuit', ''),        ('kind:jcc',      'ar', 'حلبة كورنيش جدة', ''),
  ('kind:saturday', 'en', 'Saturday Social Ride', ''),           ('kind:saturday', 'ar', 'جولة السبت الاجتماعية', ''),
  ('kind:petromin', 'en', 'Petromin night', ''),                 ('kind:petromin', 'ar', 'ليلة بترومين', ''),
  ('kind:swim',     'en', 'Triathlon Pool Session', ''),         ('kind:swim',     'ar', 'جلسة مسبح الترايثلون', ''),
  ('kind:yoga',     'en', 'Hatha Yoga for Cyclists', ''),        ('kind:yoga',     'ar', 'هاثا يوغا لراكبي الدراجات', ''),
  ('kind:runher',   'en', 'Run for Her', ''),                    ('kind:runher',   'ar', 'نركض لأجلها', ''),
  ('kind:vlap',     'en', 'Victory Lap', ''),                    ('kind:vlap',     'ar', 'فيكتوري لاب', ''),
  ('kind:arena',    'en', 'Arena Heros Hybrid Race', ''),        ('kind:arena',    'ar', 'سباق أرينا هيروز الهجين', ''),
  ('kind:blood',    'en', 'Micromobility Blood Donation', ''),   ('kind:blood',    'ar', 'مايكروموبيليتي التبرع بالدم', ''),
  ('kind:defe5k',   'en', 'DEFE 5KM Run', ''),                   ('kind:defe5k',   'ar', 'سباق دفء 5 كم', '')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- the same messages and the session kinds' names in the eight other languages (the kinds' names are the app's own,
-- i18n/<code>.json ev*Name); supabase/seeds/push_words_more.sql keeps the messages alone for a re-run
insert into public.push_words (key, lang, title, body) values
  ('remind',    'fr', 'Sortie demain',                     '{0}, rendez-vous à {1}'),
  ('change',    'fr', 'Votre sortie a changé',             '{0} : ouvrez votre billet pour voir les nouveaux détails'),
  ('challenge', 'fr', 'Votre nouveau défi est prêt',       'Ouvrez Communauté pour voir le défi du mois'),
  ('recap',     'fr', 'Le récap du samedi est là',         '{0} cyclistes étaient de sortie ce samedi'),

  ('remind',    'es', 'Salida mañana',                     '{0}, nos vemos a las {1}'),
  ('change',    'es', 'Tu salida ha cambiado',             '{0}: abre tu entrada para ver los nuevos detalles'),
  ('challenge', 'es', 'Tu nuevo reto está listo',          'Abre Comunidad para ver el reto de este mes'),
  ('recap',     'es', 'Ya está el resumen del sábado',     '{0} ciclistas salieron este sábado'),

  ('remind',    'pt', 'Passeio amanhã',                    '{0}, encontro às {1}'),
  ('change',    'pt', 'O seu passeio mudou',               '{0}: abra o seu ingresso para ver os novos detalhes'),
  ('challenge', 'pt', 'O seu novo desafio está pronto',    'Abra Comunidade para ver o desafio deste mês'),
  ('recap',     'pt', 'O resumo de sábado chegou',         '{0} ciclistas saíram neste sábado'),

  ('remind',    'ur', 'کل رائیڈ ہے',                        '{0}، {1} بجے ملیں'),
  ('change',    'ur', 'آپ کی رائیڈ میں تبدیلی ہوئی ہے',       '{0}: نئی تفصیلات کے لیے اپنا ٹکٹ کھولیں'),
  ('challenge', 'ur', 'آپ کا نیا چیلنج تیار ہے',              'اس مہینے کا چیلنج دیکھنے کے لیے کمیونٹی کھولیں'),
  ('recap',     'ur', 'ہفتے کے دن کا خلاصہ آ گیا ہے',          'اس ہفتے کے دن {0} رائیڈرز آئے'),

  ('remind',    'hi', 'कल राइड है',                         '{0}, {1} बजे मिलें'),
  ('change',    'hi', 'आपकी राइड बदल गई है',                 '{0}: नई जानकारी के लिए अपना टिकट खोलें'),
  ('challenge', 'hi', 'आपकी नई चुनौती तैयार है',              'इस महीने की चुनौती देखने के लिए समुदाय खोलें'),
  ('recap',     'hi', 'शनिवार का सार आ गया है',               'इस शनिवार {0} राइडर आए'),

  ('remind',    'tl', 'May ride bukas',                    '{0}, magkita tayo nang {1}'),
  ('change',    'tl', 'Nagbago ang ride mo',               '{0}: buksan ang ticket mo para sa mga bagong detalye'),
  ('challenge', 'tl', 'Handa na ang bago mong hamon',      'Buksan ang Komunidad para makita ang hamon ngayong buwan'),
  ('recap',     'tl', 'Narito na ang recap ng Sabado',     '{0} rider ang sumama ngayong Sabado'),

  ('remind',    'ne', 'भोलि राइड छ',                         '{0}, {1} मा भेटौं'),
  ('change',    'ne', 'तपाईंको राइड परिवर्तन भएको छ',            '{0}: नयाँ विवरणका लागि आफ्नो टिकट खोल्नुहोस्'),
  ('challenge', 'ne', 'तपाईंको नयाँ चुनौती तयार छ',              'यो महिनाको चुनौती हेर्न समुदाय खोल्नुहोस्'),
  ('recap',     'ne', 'शनिबारको सारांश आयो',                  'यो शनिबार {0} राइडर आए'),

  ('remind',    'bn', 'আগামীকাল রাইড',                       '{0}, {1}-এ দেখা হবে'),
  ('change',    'bn', 'আপনার রাইডে পরিবর্তন হয়েছে',            '{0}: নতুন তথ্যের জন্য আপনার টিকিট খুলুন'),
  ('challenge', 'bn', 'আপনার নতুন চ্যালেঞ্জ প্রস্তুত',            'এই মাসের চ্যালেঞ্জ দেখতে কমিউনিটি খুলুন'),
  ('recap',     'bn', 'শনিবারের সারসংক্ষেপ এসে গেছে',          'এই শনিবার {0} জন রাইডার এসেছিলেন')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

insert into public.push_words (key, lang, title, body) values
  ('kind:jcc', 'fr', 'Circuit de la Corniche de Djeddah', ''),
  ('kind:saturday', 'fr', 'Sortie sociale du samedi', ''),
  ('kind:petromin', 'fr', 'Soirée Petromin', ''),
  ('kind:swim', 'fr', 'Séance piscine triathlon', ''),
  ('kind:yoga', 'fr', 'Hatha yoga pour cyclistes', ''),
  ('kind:runher', 'fr', 'Run for Her', ''),
  ('kind:vlap', 'fr', 'Victory Lap', ''),
  ('kind:arena', 'fr', 'Arena Heros Hybrid Race', ''),
  ('kind:blood', 'fr', 'Micromobility Don de sang', ''),
  ('kind:defe5k', 'fr', 'DEFE 5KM Run', ''),
  ('kind:jcc', 'es', 'Circuito de la Corniche de Yeda', ''),
  ('kind:saturday', 'es', 'Recorrido social del sábado', ''),
  ('kind:petromin', 'es', 'Noche Petromin', ''),
  ('kind:swim', 'es', 'Sesión de piscina de triatlón', ''),
  ('kind:yoga', 'es', 'Hatha yoga para ciclistas', ''),
  ('kind:runher', 'es', 'Run for Her', ''),
  ('kind:vlap', 'es', 'Victory Lap', ''),
  ('kind:arena', 'es', 'Arena Heros Hybrid Race', ''),
  ('kind:blood', 'es', 'Micromobility Donación de sangre', ''),
  ('kind:defe5k', 'es', 'DEFE 5KM Run', ''),
  ('kind:jcc', 'pt', 'Circuito da Corniche de Jeddah', ''),
  ('kind:saturday', 'pt', 'Passeio social de sábado', ''),
  ('kind:petromin', 'pt', 'Noite Petromin', ''),
  ('kind:swim', 'pt', 'Sessão de piscina de triatlo', ''),
  ('kind:yoga', 'pt', 'Hatha ioga para ciclistas', ''),
  ('kind:runher', 'pt', 'Run for Her', ''),
  ('kind:vlap', 'pt', 'Victory Lap', ''),
  ('kind:arena', 'pt', 'Arena Heros Hybrid Race', ''),
  ('kind:blood', 'pt', 'Micromobility Doação de sangue', ''),
  ('kind:defe5k', 'pt', 'DEFE 5KM Run', ''),
  ('kind:jcc', 'ur', 'جدہ کورنیش سرکٹ', ''),
  ('kind:saturday', 'ur', 'ہفتے کی سوشل رائیڈ', ''),
  ('kind:petromin', 'ur', 'پیٹرومن کی رات', ''),
  ('kind:swim', 'ur', 'ٹرائیتھلون پول سیشن', ''),
  ('kind:yoga', 'ur', 'سائیکل سواروں کے لیے ہٹھ یوگا', ''),
  ('kind:runher', 'ur', 'Run for Her', ''),
  ('kind:vlap', 'ur', 'Victory Lap', ''),
  ('kind:arena', 'ur', 'Arena Heros Hybrid Race', ''),
  ('kind:blood', 'ur', 'Micromobility خون کا عطیہ', ''),
  ('kind:defe5k', 'ur', 'DEFE 5KM Run', ''),
  ('kind:jcc', 'hi', 'जेद्दाह कॉर्निश सर्किट', ''),
  ('kind:saturday', 'hi', 'शनिवार सोशल राइड', ''),
  ('kind:petromin', 'hi', 'पेट्रोमिन की रात', ''),
  ('kind:swim', 'hi', 'ट्रायथलॉन पूल सेशन', ''),
  ('kind:yoga', 'hi', 'साइकिल चालकों के लिए हठ योग', ''),
  ('kind:runher', 'hi', 'Run for Her', ''),
  ('kind:vlap', 'hi', 'Victory Lap', ''),
  ('kind:arena', 'hi', 'Arena Heros Hybrid Race', ''),
  ('kind:blood', 'hi', 'Micromobility रक्तदान', ''),
  ('kind:defe5k', 'hi', 'DEFE 5KM Run', ''),
  ('kind:jcc', 'tl', 'Jeddah Corniche Circuit', ''),
  ('kind:saturday', 'tl', 'Saturday Social Ride', ''),
  ('kind:petromin', 'tl', 'Petromin night', ''),
  ('kind:swim', 'tl', 'Triathlon Pool Session', ''),
  ('kind:yoga', 'tl', 'Hatha Yoga para sa mga Siklista', ''),
  ('kind:runher', 'tl', 'Run for Her', ''),
  ('kind:vlap', 'tl', 'Victory Lap', ''),
  ('kind:arena', 'tl', 'Arena Heros Hybrid Race', ''),
  ('kind:blood', 'tl', 'Micromobility Pagbibigay ng Dugo', ''),
  ('kind:defe5k', 'tl', 'DEFE 5KM Run', ''),
  ('kind:jcc', 'ne', 'जेद्दा कोर्निश सर्किट', ''),
  ('kind:saturday', 'ne', 'शनिबार सामाजिक राइड', ''),
  ('kind:petromin', 'ne', 'पेट्रोमिन को रात', ''),
  ('kind:swim', 'ne', 'ट्रायथलन पूल सेसन', ''),
  ('kind:yoga', 'ne', 'साइकल चालकहरूका लागि हठ योग', ''),
  ('kind:runher', 'ne', 'Run for Her', ''),
  ('kind:vlap', 'ne', 'Victory Lap', ''),
  ('kind:arena', 'ne', 'Arena Heros Hybrid Race', ''),
  ('kind:blood', 'ne', 'Micromobility रक्तदान', ''),
  ('kind:defe5k', 'ne', 'DEFE 5KM Run', ''),
  ('kind:jcc', 'bn', 'জেদ্দা কর্নিশ সার্কিট', ''),
  ('kind:saturday', 'bn', 'শনিবারের সোশ্যাল রাইড', ''),
  ('kind:petromin', 'bn', 'Petromin-এর রাত', ''),
  ('kind:swim', 'bn', 'ট্রায়াথলন পুল সেশন', ''),
  ('kind:yoga', 'bn', 'সাইক্লিস্টদের জন্য হঠ যোগ', ''),
  ('kind:runher', 'bn', 'Run for Her', ''),
  ('kind:vlap', 'bn', 'Victory Lap', ''),
  ('kind:arena', 'bn', 'Arena Heros Hybrid Race', ''),
  ('kind:blood', 'bn', 'Micromobility রক্তদান', ''),
  ('kind:defe5k', 'bn', 'DEFE 5KM Run', '')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- A message in the rider's language (English when that language has no row), placeholders filled in order.
create or replace function public._push_text(p_customer text, p_key text, p_args text[], out title text, out body text)
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_lang text; i int;
begin
  select p.lang into v_lang from push_prefs p where p.customer_id = p_customer;
  select w.title, w.body into title, body from push_words w where w.key = p_key and w.lang = coalesce(v_lang, 'en');
  if title is null then select w.title, w.body into title, body from push_words w where w.key = p_key and w.lang = 'en'; end if;
  for i in 1 .. coalesce(array_length(p_args, 1), 0) loop
    title := replace(title, '{' || (i - 1) || '}', coalesce(p_args[i], ''));
    body := replace(body, '{' || (i - 1) || '}', coalesce(p_args[i], ''));
  end loop;
end $$;
revoke all on function public._push_text(text, text, text[]) from public, anon, authenticated;

-- A session's name in the rider's language: the title staff gave it, else its kind's name.
create or replace function public._push_sess_name(p_customer text, p_title text, p_kind text)
returns text
language sql stable security definer set search_path to 'public'
as $$
  select coalesce(nullif(trim(p_title), ''), nullif((_push_text(p_customer, 'kind:' || coalesce(p_kind, 'jcc'), '{}')).title, ''), 'MicroMobility');
$$;
revoke all on function public._push_sess_name(text, text, text) from public, anon, authenticated;

-- ── 4. the reminders, the new challenge and the recap ──────────────────────────────────────────
create or replace function public._hub_push_tick()
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_ksa timestamp := now() at time zone 'Asia/Riyadh'; v_today date := (now() at time zone 'Asia/Riyadh')::date;
  v_month date := date_trunc('month', (now() at time zone 'Asia/Riyadh'))::date; v_n int := 0; r record; t record;
begin
  -- the evening before, from 21:00: every live booking on tomorrow's sessions, for riders with a working subscription
  if extract(hour from v_ksa) >= 21 then
    for r in select q.id, q.customer_id, s.title, s.ride_kind, w.starts_at
               from queue_entries q join sessions s on s.id = q.session_id
               cross join lateral _session_window(s) w
              where s.session_date = to_char(v_today + 1, 'YYYY-MM-DD') and s.status <> 'deleted' and s.cancelled_at is null
                and s.ride_status is distinct from 'cancelled' and not coalesce(s.draft, false)
                and q.status = 'waiting' and q.customer_id is not null and q.reminded_at is null
                and coalesce(q.approval, 'approved') = 'approved'
                and exists (select 1 from push_subscriptions ps where ps.customer_id = q.customer_id and coalesce(ps.fail_count, 0) < 3)
                and coalesce((select p.rides from push_prefs p where p.customer_id = q.customer_id), true) loop
      select * into t from _push_text(r.customer_id, 'remind',
        array[_push_sess_name(r.customer_id, r.title, r.ride_kind), to_char(r.starts_at at time zone 'Asia/Riyadh', 'HH24:MI')]);
      insert into push_outbox (customer_id, tag, title, body, url, cat)
      values (r.customer_id, 'rem-' || r.id, left(t.title, 120), left(t.body, 300), '/my-bookings', 'rides')
      on conflict (customer_id, tag) do nothing;
      if found then
        update queue_entries set reminded_at = now(), reminded_kind = 'push' where id = r.id and reminded_at is null;
        v_n := v_n + 1;
      end if;
    end loop;
  end if;

  -- the 1st, from 10:00 to 21:59: the month's challenge is ready (Community switch only)
  if extract(day from v_ksa) = 1 and extract(hour from v_ksa) between 10 and 21 then
    for r in select h.customer_id from hub_levels h join push_prefs p on p.customer_id = h.customer_id and p.community
              where h.month = v_month and _member_active(h.customer_id)
                and exists (select 1 from push_subscriptions ps where ps.customer_id = h.customer_id and coalesce(ps.fail_count, 0) < 3) loop
      select * into t from _push_text(r.customer_id, 'challenge', '{}');
      insert into push_outbox (customer_id, tag, title, body, url, cat)
      values (r.customer_id, 'hub-ch-' || to_char(v_month, 'YYYYMM'), left(t.title, 120), left(t.body, 300), '/members?src=push', 'community')
      on conflict (customer_id, tag) do nothing;
      if found then v_n := v_n + 1; end if;
    end loop;
  end if;

  -- the Saturday recap, written in the last 12 hours, to the members who rode it (08:00 to 21:59)
  if extract(hour from v_ksa) between 8 and 21 then
    for r in select distinct p.id as pid, p.riders, q.customer_id
               from hub_posts p join queue_entries q on q.session_id = p.session_id and q.status = 'done'
               join push_prefs pp on pp.customer_id = q.customer_id and pp.community
              where p.auto and not p.hidden and p.created_at > now() - interval '12 hours' and coalesce(p.riders, 0) >= 10
                and _member_active(q.customer_id)
                and exists (select 1 from push_subscriptions ps where ps.customer_id = q.customer_id and coalesce(ps.fail_count, 0) < 3) loop
      select * into t from _push_text(r.customer_id, 'recap', array[r.riders::text]);
      insert into push_outbox (customer_id, tag, title, body, url, cat)
      values (r.customer_id, 'hub-rc-' || r.pid, left(t.title, 120), left(t.body, 300), '/members?src=push', 'community')
      on conflict (customer_id, tag) do nothing;
      if found then v_n := v_n + 1; end if;
    end loop;
  end if;
  return v_n;
end $$;
revoke all on function public._hub_push_tick() from public, anon, authenticated;

-- ── 5. a booked session that changes tells its riders ──────────────────────────────────────────
create or replace function public._session_change_push()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
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
      insert into push_outbox (customer_id, tag, title, body, url, cat)
      select q.customer_id, left('chg-' || new.id || '-' || to_char(now() at time zone 'Asia/Riyadh', 'YYYYMMDDHH24MI'), 64),
             left(t.title, 120), left(t.body, 300), '/my-bookings', 'rides'
        from (select distinct x.customer_id from queue_entries x
               where x.session_id = new.id and x.status = 'waiting' and x.customer_id is not null
                 and coalesce(x.approval, 'approved') = 'approved') q
        cross join lateral _push_text(q.customer_id, 'change',
                     array[_push_sess_name(q.customer_id, new.title, new.ride_kind)]) t
       where exists (select 1 from push_subscriptions ps where ps.customer_id = q.customer_id and coalesce(ps.fail_count, 0) < 3)
      on conflict (customer_id, tag) do nothing;
    end if;
  exception when others then
    null; -- a staff edit is never refused for a notification
  end;
  return null;
end $$;
revoke all on function public._session_change_push() from public, anon, authenticated;
drop trigger if exists session_change_push on public.sessions;
create trigger session_change_push after update of bike_slots, meet_url, meet_lat, meet_lng, ride_status on public.sessions
  for each row execute function public._session_change_push();

select cron.schedule('mm-hub-push', '*/10 * * * *', 'select public._hub_push_tick()');

insert into supabase_migrations.schema_migrations (version, name)
values ('20261113130000', 'push_consent')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relrowsecurity) as no_rls_0,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('customer_push_prefs', 'customer_push_prefs_set', '_push_outbox_gate', '_push_text', '_push_sess_name',
                         '_hub_push_tick', '_session_change_push')) as definer_7,
       has_function_privilege('anon', 'public.customer_push_prefs_set(text,text,boolean,boolean,text,text,text,text)', 'execute') as anon_set_true,
       has_function_privilege('anon', 'public._hub_push_tick()', 'execute') as anon_tick_false,
       (select count(*) from public.push_words) as words_140,
       (select count(*) from cron.job where jobname = 'mm-hub-push') as cron_1,
       (select count(*) from pg_trigger where tgname in ('push_outbox_gate', 'session_change_push')) as triggers_2,
       (select version from supabase_migrations.schema_migrations where version = '20261113130000') as ledger;
