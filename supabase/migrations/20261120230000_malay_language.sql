-- Malay (ms, Bahasa Melayu) for the database's own texts and language checks (the user, 2026-11-20: "make sure all
-- websites and apps include a malay language"). The booking app speaks eleven languages from this release; the database
-- holds words for four of its features in every one of them and refuses a language it does not know:
--   1. push_prefs.lang and push_words.lang: the checks list the eleven codes.
--   2. customer_push_prefs_set, _updates_text and calendar_link take a p_lang and fall back to English (or no language)
--      for a code outside their list: each list gains 'ms'. They are rewritten from their LIVE definitions
--      (pg_get_functiondef, which carries the header: security definer, search_path, volatility), so whatever another
--      migration last made of them is kept and only the language list changes; grants survive create or replace.
--   3. push_words: the Malay title and body of every key (reminders, waitlist, updates, kinds, month names).
--   4. learn_skills.name: the Malay name of each Learn to Ride skill (the ladder shows name->>lang, else English).
-- Nothing is deleted. Re-running is harmless (on conflict / jsonb merge / the lists are checked before the rewrite).
begin;

-- ── 1. the language checks ──────────────────────────────────────────────────────────────────────────────────────
alter table public.push_prefs drop constraint if exists push_prefs_lang_check;
alter table public.push_prefs add constraint push_prefs_lang_check check (lang in ('en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn', 'ms'));
alter table public.push_words drop constraint if exists push_words_lang_check;
alter table public.push_words add constraint push_words_lang_check check (lang in ('en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn', 'ms'));

-- ── 2. the three functions' language lists ──────────────────────────────────────────────────────────────────────
do $fn$
declare
  r record;
  d text;
  n int := 0;
begin
  for r in
    select p.oid from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('customer_push_prefs_set', '_updates_text', 'calendar_link')
  loop
    d := pg_get_functiondef(r.oid);
    if position('''ne'', ''bn'', ''ms'')' in d) > 0 then n := n + 1; continue; end if;
    if position('''ne'', ''bn'')' in d) = 0 then raise exception '% has no language list to extend', r.oid::regprocedure; end if;
    execute replace(d, '''ne'', ''bn'')', '''ne'', ''bn'', ''ms'')');
    n := n + 1;
  end loop;
  if n <> 3 then raise exception 'expected 3 functions with a language list, found %', n; end if;
end $fn$;

-- ── 3. the push and Updates words ───────────────────────────────────────────────────────────────────────────────
insert into public.push_words (key, lang, title, body) values
  ('bookopen', 'ms', 'Tempahan telah dibuka', '{0} · {1} {2}'),
  ('challenge', 'ms', 'Cabaran baharu anda sudah tersedia', 'Buka Komuniti untuk melihat cabaran bulan ini'),
  ('change', 'ms', 'Kayuhan anda telah berubah', '{0}: buka tiket anda untuk melihat butiran baharu'),
  ('change_s', 'ms', 'Sesi anda telah berubah', '{0}: buka tiket anda untuk melihat butiran baharu'),
  ('kind:arena', 'ms', 'Arena Heros Hybrid Race', ''),
  ('kind:blood', 'ms', 'Derma Darah Micromobility', ''),
  ('kind:defe5k', 'ms', 'DEFE 5KM Run', ''),
  ('kind:farm', 'ms', 'Malam di Ladang', ''),
  ('kind:jcc', 'ms', 'Litar Corniche Jeddah', ''),
  ('kind:petromin', 'ms', 'Malam Petromin', ''),
  ('kind:runher', 'ms', 'Run for Her', ''),
  ('kind:saturday', 'ms', 'Kayuhan Sosial Sabtu', ''),
  ('kind:swim', 'ms', 'Sesi Kolam Triatlon', ''),
  ('kind:vlap', 'ms', 'Victory Lap', ''),
  ('kind:yoga', 'ms', 'Hatha Yoga untuk Penunggang Basikal', ''),
  ('note', 'ms', 'Nota daripada pasukan', '{0}'),
  ('planopen', 'ms', 'Tempahan telah dibuka', 'Sabtu {0}: tempah tempat anda'),
  ('recap', 'ms', 'Rumusan Sabtu sudah tersedia', 'Lihat bagaimana Sabtu ini berlangsung'),
  ('remind', 'ms', 'Kayuhan esok', '{0}, berkumpul pada {1}. Jika anda tidak dapat hadir, batalkan supaya penunggang lain boleh mengambil basikal itu.'),
  ('remind:nc', 'ms', 'Sesi esok', '{0}, berkumpul pada {1}. Jika anda tidak dapat hadir, batalkan supaya orang lain boleh mengambil tempat anda.'),
  ('sugdone', 'ms', 'Kami telah merealisasikan cadangan anda', '“{0}”'),
  ('sugplan', 'ms', 'Kami sedang merancang cadangan anda', '“{0}”'),
  ('wlin', 'ms', 'Anda mendapat tempat', '{0}: anda sudah keluar dari senarai menunggu dan tempat anda telah ditempah'),
  ('wloffer', 'ms', 'Ada tempat kosong untuk anda', '{0}: ambil dalam masa {1} minit'),
  ('kind:month1', 'ms', 'Jan', ''),
  ('kind:month2', 'ms', 'Feb', ''),
  ('kind:month3', 'ms', 'Mac', ''),
  ('kind:month4', 'ms', 'Apr', ''),
  ('kind:month5', 'ms', 'Mei', ''),
  ('kind:month6', 'ms', 'Jun', ''),
  ('kind:month7', 'ms', 'Jul', ''),
  ('kind:month8', 'ms', 'Ogo', ''),
  ('kind:month9', 'ms', 'Sep', ''),
  ('kind:month10', 'ms', 'Okt', ''),
  ('kind:month11', 'ms', 'Nov', ''),
  ('kind:month12', 'ms', 'Dis', '')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;

-- ── 4. the Learn to Ride skills ─────────────────────────────────────────────────────────────────────────────────
update public.learn_skills s set name = s.name || jsonb_build_object('ms', v.ms)
  from (values
    ('bal_walk', 'Berjalan di sebelah basikal dan kemudikannya dengan memegang hendal'),
    ('bal_sit', 'Duduk di atas tempat duduk dengan kedua-dua kaki rata di atas tanah'),
    ('bal_scoot', 'Tolak basikal ke hadapan dengan kedua-dua kaki sambil duduk'),
    ('bal_glide', 'Meluncur dengan kedua-dua kaki terangkat dari tanah selama 5 saat'),
    ('ped_start', 'Mula bergerak dengan satu pedal diangkat'),
    ('ped_straight', 'Kayuh dalam garisan lurus sejauh 20 meter'),
    ('ped_look', 'Pandang ke hadapan semasa mengayuh'),
    ('ped_stop', 'Berhenti dan jejakkan sebelah kaki ke tanah tanpa terhuyung-hayang'),
    ('sb_brake', 'Perlahankan basikal dengan lancar menggunakan kedua-dua brek'),
    ('sb_line', 'Berhenti di garisan yang ditanda'),
    ('sb_turn', 'Belok ke kiri dan ke kanan dalam lengkungan yang lebar'),
    ('sb_cones', 'Kayuh meliuk-liuk di antara kon'),
    ('cir_lap', 'Kayuh satu pusingan penuh litar tanpa berhenti'),
    ('cir_side', 'Kekal di satu sisi trek'),
    ('cir_space', 'Jaga jarak selamat daripada penunggang lain'),
    ('cir_signal', 'Beri isyarat tangan sebelum memperlahankan atau membelok')
  ) as v(key, ms)
 where s.key = v.key and s.name->>'ms' is distinct from v.ms;

-- ── checks ──────────────────────────────────────────────────────────────────────────────────────────────────────
do $chk$
begin
  if (select count(*) from public.push_words where lang = 'ms') <> (select count(*) from public.push_words where lang = 'en') then
    raise exception 'push_words: Malay rows do not match the English ones';
  end if;
  if exists (select 1 from public.learn_skills where not (name ? 'ms')) then raise exception 'a learn_skills row has no Malay name'; end if;
  if (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('customer_push_prefs_set', '_updates_text', 'calendar_link') and prosrc like '%''ms''%') <> 3 then
    raise exception 'a function did not take Malay';
  end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
        and proname in ('customer_push_prefs_set', '_updates_text', 'calendar_link') and not prosecdef) then
    raise exception 'a function lost security definer';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261120230000', 'malay_language')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only): Malay accepted by both checks, words for every key, the skills named, the functions' lists, the ledger.
-- select (select count(*) from public.push_words where lang = 'ms') as ms_words,
--        (select count(*) from public.push_words where lang = 'en') as en_words,
--        (select count(*) from public.learn_skills where name ? 'ms') as skills_ms,
--        (select count(*) from public.learn_skills) as skills_all,
--        (select count(*) from pg_constraint where conname in ('push_prefs_lang_check', 'push_words_lang_check')
--          and pg_get_constraintdef(oid) like '%''ms''%') as checks_2,
--        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
--          and proname in ('customer_push_prefs_set', '_updates_text', 'calendar_link') and prosrc like '%''ms''%') as functions_3,
--        (select name from supabase_migrations.schema_migrations where version = '20261120230000') as ledger;
