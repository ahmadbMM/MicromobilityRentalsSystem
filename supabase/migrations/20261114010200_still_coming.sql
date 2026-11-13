-- ============================================================================
-- "Still coming?" the day before (new features build F2; the owner marked it Build now on 2026-11-13).
--
-- From 24 hours before a booked session until it starts, the rider's ticket and the Community tab's card show two
-- buttons, "I'm coming" and "Can't come". The first stamps the booking; the second opens the cancel dialog as it is.
-- Staff see a small tick on the Bookings roster beside riders who confirmed.
--
--  1. queue_entries.coming_at timestamptz: when the rider said they are coming. The rider reads it through
--     my_bookings (whole rows of their own bookings), staff through their own reads (whole rows); queue_public names
--     its columns, so no other rider ever sees it.
--  2. booking_coming(p_id, p_token, p_session): the rider's own seated bookings on that session, every rider of the
--     booking at once (the cancel dialog takes them all too). Token-checked. The first answer for the session's date
--     stands. Refused ('closed') on a session called off or deleted, earlier than 48 hours before its first time, and
--     from its last time on (the page offers it from 24 hours before the time to turn up until the start; a ride that
--     gathers names its gathering and its start, so its last time is the start). 'none' when the rider holds no seated,
--     approved booking there. Matches the volunteer portal's volunteer_coming (20261111140000).
--  3. _coming_guard: a rider's direct write can never set the column, and a booking moved to another session, or
--     cancelled, loses its answer.
--  4. The evening-before reminder the Community reach build defines (push_words 'remind', sent by _hub_push_tick):
--     its message gains one sentence, "If you can't come, cancel so another rider can take the bike." A session with
--     no bike (the pool, yoga, a run, an event) gets its own words, 'remind:nc', which never say ride or bike. Neither
--     names a waitlist, and neither uses a pay word. The notification opens that booking's ticket
--     (/my-bookings?tk=<booking id>).
--  5. queue_entries_reminded_kind_chk now allows 'push'. _hub_push_tick (push_consent) marks a reminded booking with
--     reminded_kind = 'push', but the constraint of 20261009225000 allowed only '24h' and '2h', so the reminder's
--     own write was refused and nothing could be queued. Found while reading it for this item.
--
-- Needs the Community reach build's two migrations first (community_reach: sessions.ride_status; push_consent:
-- push_words, push_prefs, _push_text, _push_sess_name, _hub_push_tick): the first statement stops with a plain message
-- without them. Nothing is sent until the owner sets the push secrets (push stays dormant, as before).
--
-- Safe before or after the app: until this runs no booking carries coming_at, so the page shows no buttons.
-- _hub_push_tick's header is copied from 20261114000200_push_consent.sql (function attributes trap).
--
-- Rollback:
--   drop trigger if exists queue_entries_coming_guard on public.queue_entries;
--   drop function if exists public._coming_guard();
--   drop function if exists public.booking_coming(text, text, text);
--   alter table public.queue_entries drop column if exists coming_at;
--   delete from public.push_words where key = 'remind:nc';
--   and run 20261114000200_push_consent.sql again for the earlier words and _hub_push_tick.
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $pre$
begin
  if to_regclass('public.push_words') is null or to_regprocedure('public._hub_push_tick()') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'sessions' and column_name = 'ride_status') then
    raise exception 'still_coming: run the Community reach migrations (community_reach, push_consent) first';
  end if;
end $pre$;

-- ── 1. the answer on the booking ───────────────────────────────────────────────────────────────
alter table public.queue_entries add column if not exists coming_at timestamptz;
comment on column public.queue_entries.coming_at is
  'When the rider answered "I''m coming" to "Still coming?" on their ticket (booking_coming, 20261114010200); cleared when the booking moves to another session or is cancelled.';

-- ── 2. the rider's own yes ─────────────────────────────────────────────────────────────────────
create or replace function public.booking_coming(p_id text, p_token text, p_session text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare s sessions%rowtype; v_from timestamptz; v_to timestamptz; v_at timestamptz; v_n int;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select * into s from sessions where id = p_session;
  if not found or s.status = 'deleted' or s.cancelled_at is not null or s.ride_status is not distinct from 'cancelled' then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  select w.starts_at, w.ends_at into v_from, v_to from _session_window(s) w;
  if v_to < v_from then v_to := v_to + interval '1 day'; end if; -- a session that runs past midnight
  if v_from is null or now() < v_from - interval '48 hours' or now() >= greatest(v_from, coalesce(v_to, v_from)) then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  -- the rider's own seated rows; an answer already given for this date stands
  update queue_entries q
     set coming_at = case when q.coming_at >= v_from - interval '48 hours' then q.coming_at else now() end
   where q.session_id = p_session and q.customer_id = p_id and q.status = 'waiting'
     and coalesce(q.approval, 'approved') = 'approved';
  get diagnostics v_n = row_count;
  if v_n = 0 then return jsonb_build_object('ok', false, 'error', 'none'); end if;
  select min(q.coming_at) into v_at from queue_entries q
   where q.session_id = p_session and q.customer_id = p_id and q.status = 'waiting' and q.coming_at is not null;
  return jsonb_build_object('ok', true, 'coming_at', v_at, 'n', v_n);
end $$;
revoke all on function public.booking_coming(text, text, text) from public;
grant execute on function public.booking_coming(text, text, text) to anon, authenticated;

-- ── 3. the column is the function's to write, and belongs to one session ────────────────────────
create or replace function public._coming_guard()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if current_user in ('anon', 'authenticated') and not coalesce((select is_staff()), false) then
    if tg_op = 'UPDATE' then
      new.coming_at := old.coming_at;
    else
      new.coming_at := null;
    end if;
  end if;
  if tg_op = 'UPDATE' and (new.session_id is distinct from old.session_id
                           or (new.status = 'cancelled' and old.status is distinct from 'cancelled')) then
    new.coming_at := null;
  end if;
  return new;
end $function$;
revoke all on function public._coming_guard() from public, anon, authenticated;

drop trigger if exists queue_entries_coming_guard on public.queue_entries;
create trigger queue_entries_coming_guard
  before insert or update of coming_at, session_id, status on public.queue_entries
  for each row execute function public._coming_guard();

-- ── 4. the evening-before reminder: the cost of an empty bike, and a link to the ticket ─────────
-- 'remind' keeps its title and its first sentence as push_consent wrote them; the second sentence is new.
-- 'remind:nc' is the same message for a session with no bike: session words only (the owner, 2026-10-18).
insert into public.push_words (key, lang, title, body) values
  ('remind', 'en', 'Ride tomorrow',  '{0}, meet at {1}. If you can''t come, cancel so another rider can take the bike.'),
  ('remind', 'ar', 'رحلتك غدًا',      '{0}، التجمّع الساعة {1}. إن لم تستطع الحضور، ألغِ حجزك ليأخذ راكب آخر الدراجة.'),
  ('remind', 'fr', 'Sortie demain',  '{0}, rendez-vous à {1}. Si vous ne pouvez pas venir, annulez pour qu''un autre cycliste prenne le vélo.'),
  ('remind', 'es', 'Salida mañana',  '{0}, nos vemos a las {1}. Si no puedes venir, cancela para que otro ciclista use la bici.'),
  ('remind', 'pt', 'Passeio amanhã', '{0}, encontro às {1}. Se não puder vir, cancele para que outro ciclista fique com a bicicleta.'),
  ('remind', 'ur', 'کل رائیڈ ہے',     '{0}، {1} بجے ملیں۔ اگر آپ نہیں آ سکتے تو بکنگ منسوخ کریں تاکہ کوئی اور سوار سائیکل لے سکے۔'),
  ('remind', 'hi', 'कल राइड है',      '{0}, {1} बजे मिलें। अगर आप नहीं आ सकते, तो बुकिंग रद्द करें ताकि कोई और राइडर साइकिल ले सके।'),
  ('remind', 'tl', 'May ride bukas', '{0}, magkita tayo nang {1}. Kung hindi ka makakarating, i-cancel ito para magamit ng ibang rider ang bike.'),
  ('remind', 'ne', 'भोलि राइड छ',      '{0}, {1} मा भेटौं। आउन सक्नुहुन्न भने बुकिङ रद्द गर्नुहोस्, ताकि अर्को राइडरले साइकल लिन सकोस्।'),
  ('remind', 'bn', 'আগামীকাল রাইড',    '{0}, {1}-এ দেখা হবে। আসতে না পারলে বুকিং বাতিল করুন, যাতে অন্য রাইডার সাইকেলটি নিতে পারেন।'),
  ('remind:nc', 'en', 'Session tomorrow',  '{0}, meet at {1}. If you can''t come, cancel so someone else can take your place.'),
  ('remind:nc', 'ar', 'جلستك غدًا',         '{0}، التجمّع الساعة {1}. إن لم تستطع الحضور، ألغِ حجزك ليأخذ غيرك مكانك.'),
  ('remind:nc', 'fr', 'Séance demain',     '{0}, rendez-vous à {1}. Si vous ne pouvez pas venir, annulez pour qu''une autre personne prenne votre place.'),
  ('remind:nc', 'es', 'Sesión mañana',     '{0}, nos vemos a las {1}. Si no puedes venir, cancela para que otra persona ocupe tu plaza.'),
  ('remind:nc', 'pt', 'Sessão amanhã',     '{0}, encontro às {1}. Se não puder vir, cancele para que outra pessoa fique com o seu lugar.'),
  ('remind:nc', 'ur', 'کل سیشن ہے',         '{0}، {1} بجے ملیں۔ اگر آپ نہیں آ سکتے تو بکنگ منسوخ کریں تاکہ آپ کی جگہ کسی اور کو مل سکے۔'),
  ('remind:nc', 'hi', 'कल सत्र है',          '{0}, {1} बजे मिलें। अगर आप नहीं आ सकते, तो बुकिंग रद्द करें ताकि आपकी जगह किसी और को मिल सके।'),
  ('remind:nc', 'tl', 'May session bukas', '{0}, magkita tayo nang {1}. Kung hindi ka makakarating, i-cancel ito para may ibang makakuha ng puwesto mo.'),
  ('remind:nc', 'ne', 'भोलि सत्र छ',          '{0}, {1} मा भेटौं। आउन सक्नुहुन्न भने बुकिङ रद्द गर्नुहोस्, ताकि तपाईंको ठाउँ अरूले पाऊन्।'),
  ('remind:nc', 'bn', 'আগামীকাল সেশন',      '{0}, {1}-এ দেখা হবে। আসতে না পারলে বুকিং বাতিল করুন, যাতে আপনার জায়গা অন্য কেউ পান।')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- ── 5. the reminder's own mark is allowed ──────────────────────────────────────────────────────
alter table public.queue_entries drop constraint if exists queue_entries_reminded_kind_chk;
alter table public.queue_entries add constraint queue_entries_reminded_kind_chk
  check (reminded_kind is null or reminded_kind in ('24h', '2h', 'push'));
comment on column public.queue_entries.reminded_kind is 'Which reminder that was: 24h | 2h (staff, 20261009225000) | push (the evening-before notification, 20261114000200).';

-- The ten-minute job, as push_consent wrote it, with two changes in the evening-before reminder: the words follow the
-- session (a session with no bike takes 'remind:nc'; the kinds are the app's own list, KIND_TRAITS bike:false) and
-- the notification opens that booking's ticket. The new challenge and the recap are unchanged.
create or replace function public._hub_push_tick()
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_ksa timestamp := now() at time zone 'Asia/Riyadh'; v_today date := (now() at time zone 'Asia/Riyadh')::date;
  v_month date := date_trunc('month', (now() at time zone 'Asia/Riyadh'))::date; v_n int := 0; r record; t record;
begin
  -- the evening before, from 21:00: every live booking on tomorrow's sessions, for riders with a working subscription
  if extract(hour from v_ksa) >= 21 then
    for r in select q.id, q.customer_id, s.title, s.ride_kind, w.starts_at,
                    (s.event_kind = 'community' and s.ride_kind in ('swim', 'workshop', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'blood', 'yoga')) as no_bike
               from queue_entries q join sessions s on s.id = q.session_id
               cross join lateral _session_window(s) w
              where s.session_date = to_char(v_today + 1, 'YYYY-MM-DD') and s.status <> 'deleted' and s.cancelled_at is null
                and s.ride_status is distinct from 'cancelled' and not coalesce(s.draft, false)
                and q.status = 'waiting' and q.customer_id is not null and q.reminded_at is null
                and coalesce(q.approval, 'approved') = 'approved'
                and exists (select 1 from push_subscriptions ps where ps.customer_id = q.customer_id and coalesce(ps.fail_count, 0) < 3)
                and coalesce((select p.rides from push_prefs p where p.customer_id = q.customer_id), true) loop
      select * into t from _push_text(r.customer_id, case when coalesce(r.no_bike, false) then 'remind:nc' else 'remind' end,
        array[_push_sess_name(r.customer_id, r.title, r.ride_kind), to_char(r.starts_at at time zone 'Asia/Riyadh', 'HH24:MI')]);
      insert into push_outbox (customer_id, tag, title, body, url, cat)
      values (r.customer_id, 'rem-' || r.id, left(t.title, 120), left(t.body, 300), '/my-bookings?tk=' || r.id, 'rides')
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

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114010200', 'still_coming')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only).
select (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'queue_entries' and column_name = 'coming_at') as column_1,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('booking_coming', '_hub_push_tick')) as definer_2,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and not prosecdef
         and proname = '_coming_guard') as invoker_1,
       has_function_privilege('anon', 'public.booking_coming(text,text,text)', 'execute') as anon_coming_true,
       has_function_privilege('anon', 'public._hub_push_tick()', 'execute') as anon_tick_false,
       has_function_privilege('anon', 'public._coming_guard()', 'execute') as anon_guard_false,
       (select count(*) from pg_trigger where tgname = 'queue_entries_coming_guard' and not tgisinternal) as trigger_1,
       (select count(*) from public.push_words where key in ('remind', 'remind:nc')) as words_20,
       (select count(*) from public.push_words where key = 'remind' and char_length(body) > 40) as remind_with_sentence_10,
       (select pg_get_constraintdef(oid) like '%push%' from pg_constraint where conname = 'queue_entries_reminded_kind_chk') as kind_push_true,
       (select count(*) from public.queue_entries where coming_at is not null) as answers_so_far,
       (select version from supabase_migrations.schema_migrations where version = '20261114010200') as ledger;
