-- ============================================================================
-- Learn-to-ride ladder (new features build F21; the owner marked it Build now on 2026-11-13).
--
-- A learner on a learn-to-ride sign-up (learn_applications.learners: the person who signed up, a child or another adult
-- the sign-up already records) climbs four levels: balance, pedal, steer and brake, ride the circuit. Each level holds
-- four skills. The instructor ticks the skills a learner has and writes one line of feedback, on the sign-up's card in
-- People > Applications > Learn to ride. A skill not ticked reads "Practising": nothing is ever marked failed, so only
-- ticks are stored. The learner's account sees its own ladder and the line in the booking app (Account > Learn to ride),
-- and nobody else's: the rider's read answers only for sign-ups on the caller's own account.
--
--  1. learn_skills - the ladder's skills, seeded here: key, level 1 to 4, sort, name in the ten languages
--     ({"en": ..., "ar": ..., "fr", "es", "pt", "ur", "hi", "tl", "ne", "bn"}), active. Staff read it; riders never
--     read the table (they get the names through learn_ladder). Nobody writes it from a page.
--  2. learn_progress - one row per learner of a sign-up: application_id + learner_idx (the learner's place in
--     learn_applications.learners, from 0; a sign-up from before that column is its one learner, 0). skills is
--     {"<skill key>": "<when it was first ticked, UTC ISO>"}; feedback is one line of at most 200 characters. Keyed by the
--     sign-up, so an account merge (which moves learn_applications.customer_id) carries the ladder with it and the merge
--     functions are untouched. learner_who and learner_name say who the row was written for (the learner at that place
--     when it was saved): a pending sign-up sent again can carry other learners, and a row is read only while the learner
--     at its place is still that person, so nobody is shown ticks given to somebody else. Staff read it; it is written
--     only by staff_learn_progress_set.
--  3. learn_ladder(p_id, p_token) - the rider's read (anon key, token-checked like every rider function): the active
--     skills, and the caller's own learners on their scheduled or done sign-ups with their ticks and feedback line. The
--     same learner (who + name) on two sign-ups of the account is one ladder: the ticks are united (the earliest time
--     kept), the line is the one written last. Returns nothing about any other account. An account with no such
--     sign-up (most riders) gets two empty lists from one indexed look-up: the skill names are not sent.
--  4. staff_learn_progress_set(p_app, p_idx, p_skills, p_feedback, p_by) - staff with the People section's edit right
--     (_staff_mod('community', true)): the learner's ticked skills (the whole set: a skill left out is un-ticked, a
--     skill kept keeps the time it was first ticked, an unknown key is dropped) and the line (trimmed, one line, 200).
--     Only on a scheduled or done sign-up. A row left by another learner at that place is started afresh.
--
-- The app works before this runs: the rider's row shows only once learn_ladder answers, and the staff button only once
-- learn_skills can be read.
--
-- Rollback:
--   drop function if exists public.staff_learn_progress_set(uuid, integer, text[], text, text);
--   drop function if exists public.learn_ladder(text, text);
--   drop table if exists public.learn_progress;
--   drop table if exists public.learn_skills;
--   delete from supabase_migrations.schema_migrations where version = '20261114012100';
-- Idempotent.
-- ============================================================================

begin;

do $$ begin
  if to_regclass('public.learn_applications') is null then
    raise exception 'Run 20260928210000_learn_to_ride first.';
  end if;
end $$;

-- ── 1. The skills ───────────────────────────────────────────────────────────────────────────────
create table if not exists public.learn_skills (
  key    text primary key check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  level  smallint not null check (level between 1 and 4),
  sort   smallint not null default 0,
  name   jsonb not null check (jsonb_typeof(name) = 'object' and coalesce(name->>'en', '') <> ''),
  active boolean not null default true
);
alter table public.learn_skills enable row level security;
drop policy if exists "staff read learn skills" on public.learn_skills;
create policy "staff read learn skills" on public.learn_skills for select to authenticated using ((select is_staff()));
revoke all on public.learn_skills from public, anon, authenticated;
grant select on public.learn_skills to authenticated;

insert into public.learn_skills (key, level, sort, name) values
  -- Level 1: balance
  ('bal_walk', 1, 1, '{"en":"Walk beside the bike and steer it by the handlebars","ar":"المشي بجانب الدراجة وتوجيهها بالمقود","fr":"Marcher à côté du vélo en le guidant par le guidon","es":"Caminar junto a la bici guiándola con el manillar","pt":"Caminhar ao lado da bicicleta, guiando pelo guidão","ur":"سائیکل کے ساتھ چلتے ہوئے ہینڈل سے رخ موڑنا","hi":"साइकिल के साथ चलते हुए हैंडल से उसे मोड़ना","tl":"Maglakad sa tabi ng bisikleta habang ginagabayan ito sa manibela","ne":"साइकलसँगै हिँड्दै ह्यान्डलले मोड्नु","bn":"সাইকেলের পাশে হেঁটে হ্যান্ডেল ধরে ঘোরানো"}'::jsonb),
  ('bal_sit', 1, 2, '{"en":"Sit on the saddle with both feet flat on the ground","ar":"الجلوس على المقعد والقدمان على الأرض","fr":"S’asseoir sur la selle, les deux pieds à plat au sol","es":"Sentarse en el sillín con los dos pies apoyados en el suelo","pt":"Sentar no selim com os dois pés apoiados no chão","ur":"دونوں پاؤں زمین پر رکھ کر سیٹ پر بیٹھنا","hi":"दोनों पैर ज़मीन पर रखकर सीट पर बैठना","tl":"Umupo sa upuan nang nakalapat ang dalawang paa sa lupa","ne":"दुवै खुट्टा भुइँमा राखेर सिटमा बस्नु","bn":"দুই পা মাটিতে রেখে সিটে বসা"}'::jsonb),
  ('bal_scoot', 1, 3, '{"en":"Push along with both feet while seated","ar":"الدفع بالقدمين أثناء الجلوس على المقعد","fr":"Avancer sur la selle en poussant avec les deux pieds","es":"Avanzar en el sillín impulsándose con los dos pies","pt":"Avançar no selim, impulsionando com os dois pés","ur":"سیٹ پر بیٹھ کر دونوں پاؤں سے آگے دھکیلنا","hi":"सीट पर बैठकर दोनों पैरों से आगे धकेलना","tl":"Umusad habang nakaupo sa pagtulak ng dalawang paa","ne":"सिटमा बसेर दुवै खुट्टाले अगाडि धकेल्नु","bn":"সিটে বসে দুই পা দিয়ে ঠেলে এগোনো"}'::jsonb),
  ('bal_glide', 1, 4, '{"en":"Glide with both feet off the ground for 5 seconds","ar":"الانزلاق والقدمان مرفوعتان عن الأرض لمدة 5 ثوانٍ","fr":"Glisser les deux pieds levés pendant 5 secondes","es":"Deslizarse con los dos pies levantados durante 5 segundos","pt":"Deslizar com os dois pés fora do chão por 5 segundos","ur":"دونوں پاؤں اٹھا کر 5 سیکنڈ تک توازن سے چلتے رہنا","hi":"दोनों पैर उठाकर 5 सेकंड तक संतुलन बनाए रखना","tl":"Dumausdos nang nakaangat ang dalawang paa sa loob ng 5 segundo","ne":"दुवै खुट्टा उठाएर 5 सेकेन्डसम्म सन्तुलनमा गुड्नु","bn":"দুই পা তুলে 5 সেকেন্ড ভারসাম্য রেখে গড়িয়ে চলা"}'::jsonb),
  -- Level 2: pedal
  ('ped_start', 2, 1, '{"en":"Start off with one pedal raised","ar":"الانطلاق مع رفع إحدى الدواستين","fr":"Démarrer avec une pédale relevée","es":"Arrancar con un pedal levantado","pt":"Arrancar com um pedal levantado","ur":"ایک پیڈل اوپر رکھ کر چلنا شروع کرنا","hi":"एक पैडल ऊपर रखकर चलना शुरू करना","tl":"Magsimula nang nakataas ang isang pedal","ne":"एउटा पेडल माथि राखेर चलाउन सुरु गर्नु","bn":"একটি প্যাডেল উপরে রেখে চলা শুরু করা"}'::jsonb),
  ('ped_straight', 2, 2, '{"en":"Pedal in a straight line for 20 metres","ar":"التبديل في خط مستقيم لمسافة 20 مترًا","fr":"Pédaler en ligne droite sur 20 mètres","es":"Pedalear en línea recta 20 metros","pt":"Pedalar em linha reta por 20 metros","ur":"20 میٹر تک سیدھی لائن میں پیڈل چلانا","hi":"20 मीटर तक सीधी रेखा में पैडल चलाना","tl":"Pumedal nang tuwid sa loob ng 20 metro","ne":"20 मिटरसम्म सिधा रेखामा पेडल चलाउनु","bn":"20 মিটার সোজা লাইনে প্যাডেল চালানো"}'::jsonb),
  ('ped_look', 2, 3, '{"en":"Look ahead while pedalling","ar":"النظر إلى الأمام أثناء التبديل","fr":"Garder le regard devant soi en pédalant","es":"Mirar al frente mientras se pedalea","pt":"Olhar para a frente enquanto pedala","ur":"پیڈل چلاتے ہوئے سامنے دیکھنا","hi":"पैडल चलाते हुए सामने देखना","tl":"Tumingin sa unahan habang pumepedal","ne":"पेडल चलाउँदा अगाडि हेर्नु","bn":"প্যাডেল চালানোর সময় সামনে তাকানো"}'::jsonb),
  ('ped_stop', 2, 4, '{"en":"Stop and put a foot down without wobbling","ar":"التوقف ووضع القدم على الأرض بثبات","fr":"S’arrêter et poser un pied au sol sans vaciller","es":"Detenerse y apoyar un pie sin tambalearse","pt":"Parar e apoiar um pé no chão sem balançar","ur":"رک کر ڈگمگائے بغیر ایک پاؤں زمین پر رکھنا","hi":"रुककर बिना डगमगाए एक पैर ज़मीन पर रखना","tl":"Huminto at ibaba ang isang paa nang hindi gumegewang","ne":"रोकिएर नहल्लिई एउटा खुट्टा भुइँमा राख्नु","bn":"থেমে না টলে এক পা মাটিতে রাখা"}'::jsonb),
  -- Level 3: steer and brake
  ('sb_brake', 3, 1, '{"en":"Slow down smoothly using both brakes","ar":"تخفيف السرعة بسلاسة باستخدام المكبحين","fr":"Ralentir en douceur avec les deux freins","es":"Reducir la velocidad suavemente con los dos frenos","pt":"Reduzir a velocidade suavemente com os dois freios","ur":"دونوں بریکوں سے آہستہ آہستہ رفتار کم کرنا","hi":"दोनों ब्रेक से धीरे धीरे गति कम करना","tl":"Magbagal nang maayos gamit ang dalawang preno","ne":"दुवै ब्रेक प्रयोग गरेर बिस्तारै गति घटाउनु","bn":"দুটি ব্রেক ব্যবহার করে ধীরে ধীরে গতি কমানো"}'::jsonb),
  ('sb_line', 3, 2, '{"en":"Stop at a marked line","ar":"التوقف عند خط محدد","fr":"S’arrêter sur une ligne tracée","es":"Detenerse en una línea marcada","pt":"Parar em uma linha marcada","ur":"نشان زدہ لائن پر رکنا","hi":"चिह्नित रेखा पर रुकना","tl":"Huminto sa may markang linya","ne":"चिन्ह लगाइएको रेखामा रोकिनु","bn":"চিহ্নিত লাইনে থামা"}'::jsonb),
  ('sb_turn', 3, 3, '{"en":"Turn left and right in a wide curve","ar":"الانعطاف يمينًا ويسارًا في منحنى واسع","fr":"Tourner à gauche et à droite en courbe large","es":"Girar a izquierda y derecha en una curva amplia","pt":"Virar à esquerda e à direita em curva aberta","ur":"کھلے موڑ میں دائیں اور بائیں مڑنا","hi":"चौड़े मोड़ में बाएँ और दाएँ मुड़ना","tl":"Lumiko pakaliwa at pakanan sa maluwag na kurba","ne":"फराकिलो मोडमा बायाँ र दायाँ मोडिनु","bn":"চওড়া বাঁকে বামে ও ডানে ঘোরা"}'::jsonb),
  ('sb_cones', 3, 4, '{"en":"Weave between cones","ar":"المرور المتعرّج بين الأقماع","fr":"Slalomer entre des cônes","es":"Hacer zigzag entre conos","pt":"Fazer zigue zague entre cones","ur":"کونز کے درمیان سے بل کھاتے ہوئے گزرنا","hi":"शंकुओं के बीच से लहराते हुए निकलना","tl":"Magpasikot sikot sa pagitan ng mga cone","ne":"कोनहरूको बीचबाट घुम्दै जानु","bn":"কোনগুলোর মাঝ দিয়ে এঁকেবেঁকে চলা"}'::jsonb),
  -- Level 4: ride the circuit
  ('cir_lap', 4, 1, '{"en":"Ride a full lap of the circuit without stopping","ar":"إكمال لفة كاملة في الحلبة دون توقف","fr":"Faire un tour complet du circuit sans s’arrêter","es":"Dar una vuelta completa al circuito sin parar","pt":"Dar uma volta completa no circuito sem parar","ur":"رکے بغیر سرکٹ کا ایک پورا چکر لگانا","hi":"बिना रुके सर्किट का एक पूरा चक्कर लगाना","tl":"Makumpleto ang isang buong ikot ng circuit nang hindi humihinto","ne":"नरोकिई सर्किटको एक पूरा फन्को लगाउनु","bn":"না থেমে সার্কিটের একটি পুরো চক্কর দেওয়া"}'::jsonb),
  ('cir_side', 4, 2, '{"en":"Keep to one side of the track","ar":"الالتزام بجانب واحد من المسار","fr":"Rester d’un seul côté de la piste","es":"Mantenerse a un lado de la pista","pt":"Manter-se em um lado da pista","ur":"ٹریک کے ایک طرف رہنا","hi":"ट्रैक के एक तरफ़ रहना","tl":"Manatili sa isang gilid ng track","ne":"ट्र्याकको एक छेउमा रहनु","bn":"ট্র্যাকের এক পাশে থাকা"}'::jsonb),
  ('cir_space', 4, 3, '{"en":"Keep a safe distance from other riders","ar":"ترك مسافة آمنة عن بقية الراكبين","fr":"Garder une distance de sécurité avec les autres cyclistes","es":"Mantener una distancia segura con otros ciclistas","pt":"Manter uma distância segura dos outros ciclistas","ur":"دوسرے سواروں سے محفوظ فاصلہ رکھنا","hi":"दूसरे सवारों से सुरक्षित दूरी रखना","tl":"Panatilihin ang ligtas na distansya sa ibang siklista","ne":"अरू सवारहरूबाट सुरक्षित दूरी राख्नु","bn":"অন্য চালকদের থেকে নিরাপদ দূরত্ব রাখা"}'::jsonb),
  ('cir_signal', 4, 4, '{"en":"Signal with a hand before slowing or turning","ar":"الإشارة باليد قبل تخفيف السرعة أو الانعطاف","fr":"Signaler de la main avant de ralentir ou de tourner","es":"Señalar con la mano antes de frenar o girar","pt":"Sinalizar com a mão antes de reduzir ou virar","ur":"رفتار کم کرنے یا مڑنے سے پہلے ہاتھ سے اشارہ دینا","hi":"धीमा होने या मुड़ने से पहले हाथ से संकेत देना","tl":"Sumenyas gamit ang kamay bago bumagal o lumiko","ne":"गति घटाउनु वा मोडिनुअघि हातले संकेत दिनु","bn":"গতি কমানো বা ঘোরার আগে হাত দিয়ে সংকেত দেওয়া"}'::jsonb)
on conflict (key) do nothing;

-- ── 2. A learner's ticks and feedback line ──────────────────────────────────────────────────────
create table if not exists public.learn_progress (
  application_id uuid not null references public.learn_applications(id) on delete cascade,
  learner_idx    smallint not null check (learner_idx between 0 and 5),
  learner_who    text not null default 'self',
  learner_name   text not null default '',
  skills         jsonb not null default '{}'::jsonb check (jsonb_typeof(skills) = 'object'),
  feedback       text not null default '' check (char_length(feedback) <= 200 and feedback !~ '[\r\n]'),
  updated_at     timestamptz not null default now(),
  updated_by     text,
  primary key (application_id, learner_idx)
);
alter table public.learn_progress enable row level security;
drop policy if exists "staff read learn progress" on public.learn_progress;
create policy "staff read learn progress" on public.learn_progress for select to authenticated using ((select is_staff()));
revoke all on public.learn_progress from public, anon, authenticated;
grant select on public.learn_progress to authenticated;

-- ── 3. The rider's own ladder ───────────────────────────────────────────────────────────────────
create or replace function public.learn_ladder(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_learners jsonb;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then
    return jsonb_build_object('ok', false, 'error', 'denied');
  end if;
  -- Most accounts have no lesson: no ladder, and no skill names to send.
  if not exists (select 1 from learn_applications a where a.customer_id = p_id and a.status in ('scheduled', 'done')) then
    return jsonb_build_object('ok', true, 'skills', '[]'::jsonb, 'learners', '[]'::jsonb);
  end if;
  with lrn as (
    -- every learner on the caller's own scheduled or done sign-ups
    select a.id, a.lesson_at, a.created_at, l.ord,
           coalesce(nullif(l.item->>'who', ''), 'self') as who,
           regexp_replace(trim(coalesce(l.item->>'name', '')), '\s+', ' ', 'g') as name
      from learn_applications a
      cross join lateral jsonb_array_elements(
        case when jsonb_array_length(a.learners) > 0 then a.learners
             else jsonb_build_array(jsonb_build_object('who', a.for_whom, 'name', a.learner_name)) end
      ) with ordinality as l(item, ord)
     where a.customer_id = p_id and a.status in ('scheduled', 'done')
  ), mine as (
    -- with the row of ticks at that place, when it was written for that same learner
    select n.who, case when n.who = 'self' then '' else lower(n.name) end as nkey, nullif(n.name, '') as name,
           n.lesson_at, n.created_at, n.ord, p.skills, p.feedback, p.updated_at
      from lrn n
      left join learn_progress p
        on p.application_id = n.id and p.learner_idx = n.ord - 1
       and p.learner_who = n.who and (n.who = 'self' or lower(p.learner_name) = lower(n.name))
  ), ppl as (
    -- the same learner on two sign-ups is one ladder: the line written last, the latest lesson
    select m.who, m.nkey,
           (array_agg(m.name order by m.created_at desc))[1] as name,
           max(m.lesson_at) as lesson_at, min(m.created_at) as first_at, min(m.ord) as ord,
           (array_agg(coalesce(m.feedback, '') order by m.updated_at desc nulls last))[1] as feedback,
           max(m.updated_at) as updated_at
      from mine m group by m.who, m.nkey
  ), tick as (
    -- its ticks united, each with the earliest time it was given (ISO text sorts by time)
    select m.who, m.nkey, e.key, min(e.value) as tick_at
      from mine m cross join lateral jsonb_each_text(coalesce(m.skills, '{}'::jsonb)) e
     group by m.who, m.nkey, e.key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'who', w.who,
           'name', case when w.who = 'self' then null else w.name end,
           'lesson_at', w.lesson_at,
           'ticked', coalesce((select jsonb_object_agg(t.key, t.tick_at) from tick t
                                where t.who = w.who and t.nkey = w.nkey), '{}'::jsonb),
           'feedback', coalesce(w.feedback, ''),
           'updated_at', w.updated_at)
         order by w.first_at, w.ord, w.who, w.nkey), '[]'::jsonb)
    into v_learners
    from ppl w;
  return jsonb_build_object('ok', true,
    'skills', coalesce((select jsonb_agg(jsonb_build_object('key', s.key, 'level', s.level, 'name', s.name)
                                         order by s.level, s.sort, s.key)
                          from learn_skills s where s.active), '[]'::jsonb),
    'learners', v_learners);
end $function$;
revoke all on function public.learn_ladder(text, text) from public;
grant execute on function public.learn_ladder(text, text) to anon, authenticated;

-- ── 4. The instructor's ticks and line ──────────────────────────────────────────────────────────
create or replace function public.staff_learn_progress_set(p_app uuid, p_idx integer, p_skills text[], p_feedback text, p_by text default null)
 returns jsonb
 language plpgsql
 volatile security definer
 set search_path to 'public'
as $function$
declare
  a     learn_applications%rowtype;
  v_n   int;
  v_l   jsonb;
  v_who text;
  v_nm  text;
  v_old jsonb;
  v_new jsonb;
  v_fb  text := left(trim(regexp_replace(coalesce(p_feedback, ''), '\s+', ' ', 'g')), 200);
  v_now text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  if not coalesce(_staff_mod('community', true), false) then
    raise exception 'not staff' using errcode = '42501';
  end if;
  select * into a from learn_applications where id = p_app for update;
  if a.id is null then return jsonb_build_object('ok', false, 'error', 'missing'); end if;
  if a.status not in ('scheduled', 'done') then return jsonb_build_object('ok', false, 'error', 'status', 'status', a.status); end if;
  v_n := case when jsonb_array_length(a.learners) > 0 then jsonb_array_length(a.learners) else 1 end;
  if p_idx is null or p_idx < 0 or p_idx >= v_n then return jsonb_build_object('ok', false, 'error', 'learner'); end if;
  -- The learner at that place: a sign-up from before the learners column is its one learner.
  v_l := case when jsonb_array_length(a.learners) > 0 then a.learners -> p_idx
              else jsonb_build_object('who', a.for_whom, 'name', a.learner_name) end;
  v_who := coalesce(nullif(v_l->>'who', ''), 'self');
  v_nm := case when v_who = 'self' then '' else regexp_replace(trim(coalesce(v_l->>'name', '')), '\s+', ' ', 'g') end;
  if coalesce(array_length(p_skills, 1), 0) > 60 then return jsonb_build_object('ok', false, 'error', 'skills'); end if;

  -- What this same learner already has; a row another learner left at this place counts for nothing.
  select skills into v_old from learn_progress
   where application_id = p_app and learner_idx = p_idx
     and learner_who = v_who and (v_who = 'self' or lower(learner_name) = lower(v_nm));
  -- The whole set: a skill left out is un-ticked (it reads "Practising" again), one kept keeps its first time,
  -- a key that is not an active skill is dropped.
  select coalesce(jsonb_object_agg(s.key, coalesce(v_old->>s.key, v_now)), '{}'::jsonb) into v_new
    from learn_skills s
   where s.active and s.key = any(coalesce(p_skills, '{}'::text[]));

  insert into learn_progress (application_id, learner_idx, learner_who, learner_name, skills, feedback, updated_at, updated_by)
  values (p_app, p_idx, v_who, v_nm, v_new, v_fb, now(), left(coalesce(nullif(trim(p_by), ''), 'staff'), 80))
  on conflict (application_id, learner_idx) do update
    set learner_who = excluded.learner_who, learner_name = excluded.learner_name, skills = excluded.skills,
        feedback = excluded.feedback, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

  return jsonb_build_object('ok', true, 'who', v_who, 'name', v_nm, 'skills', v_new, 'feedback', v_fb, 'updated_at', now());
end $function$;
revoke all on function public.staff_learn_progress_set(uuid, integer, text[], text, text) from public, anon;
grant execute on function public.staff_learn_progress_set(uuid, integer, text[], text, text) to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114012100', 'learn_ladder')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): the column names state the expected value.
select
  (select count(*) from public.learn_skills where active)                                             as skills_16,
  (select count(distinct level) from public.learn_skills where active)                                as levels_4,
  (select count(*) from public.learn_skills s
     where not (s.name ?& array['en','ar','fr','es','pt','ur','hi','tl','ne','bn']))                  as names_short_of_ten_languages_0,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname in ('learn_skills', 'learn_progress') and not c.relrowsecurity) as no_rls_0,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('learn_ladder', 'staff_learn_progress_set') and p.prosecdef) as definer_2,
  has_function_privilege('anon', 'public.learn_ladder(text, text)', 'execute')                         as rider_may_read_true,
  has_function_privilege('anon', 'public.staff_learn_progress_set(uuid, integer, text[], text, text)', 'execute') as anon_may_write_false,
  has_table_privilege('anon', 'public.learn_progress', 'select')                                       as anon_reads_progress_false,
  (select count(*) from supabase_migrations.schema_migrations where version = '20261114012100')        as ledger_1;
