// A booking's calendar file, served (2026-11-10, the Bookings page research). An iPhone or iPad opens a real
// text/calendar answer with Add to Calendar; a file built inside the page did nothing in a Home Screen web app.
//
// The booking app posts a form (downloadBookingICS in app.src.html): the rider's id and session token, the booking,
// and the event's words in the rider's language. The words come from the page because the page is what speaks ten
// languages; what makes them safe to serve from this address is the check below: the token must be the rider's and
// the booking theirs and still standing (my_bookings), and its day must be the event's day. Nobody can have this
// address hand out text they wrote unless they are signed in as the rider it is about.
//
// The event's UID is the booking's, so adding it again changes the event a calendar already holds instead of
// copying it, and SEQUENCE grows with each export. _icsBody in app.src.html writes the same lines for the file the
// page saves itself: keep the two in step.
//
// The same address, asked with GET and a key, is the rider's own calendar address (onRequestGet, further down): every
// booking they still hold, one event each, written by the same lines.

const LIVE = new Set(['waiting', 'waitlist', 'active']);
const STAMP = /^\d{8}T\d{6}Z$/;

export async function onRequestPost(context) {
  const { request, env } = context;
  let form;
  try { form = await request.formData(); } catch { return text('Bad request', 400); }
  const f = (k, max) => String(form.get(k) || '').slice(0, max);
  const c = f('c', 64), k = f('k', 256), b = f('b', 64);
  const st = f('st', 16), en = f('en', 16);
  if (!c || !k || !/^[\w-]{1,64}$/.test(b) || !STAMP.test(st) || !STAMP.test(en) || en <= st) return text('Bad request', 400);

  const SUPA = env.SUPABASE_URL || 'https://qpffkzmsfyilicwcsszz.supabase.co';
  const ANON = env.SUPABASE_ANON_KEY;
  if (!ANON) return text('Not configured', 501);
  let rows;
  try {
    const r = await fetch(`${SUPA}/rest/v1/rpc/my_bookings`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_id: c, p_token: k }),
    });
    if (!r.ok) return text('Lookup failed', 502);
    rows = await r.json();
  } catch { return text('Lookup failed', 502); }
  const row = Array.isArray(rows) ? rows.find((x) => x && x.id === b) : null;
  if (!row || !LIVE.has(row.status)) return text('This booking is not on your account.', 404);
  // The event starts on the booking's day in Jeddah (UTC+3, no clock changes): a start written in UTC can be the
  // evening before, and a night past midnight ends the next day.
  const day = String(row.session_date || row.session_id || '').slice(0, 10);
  const startMs = Date.UTC(+st.slice(0, 4), +st.slice(4, 6) - 1, +st.slice(6, 8), +st.slice(9, 11), +st.slice(11, 13)) + 3 * 36e5;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || new Date(startMs).toISOString().slice(0, 10) !== day) return text('Bad request', 400);

  const origin = new URL(request.url).origin;
  const body = icsBody({
    uid: `booking-${b}@micromobility.sa`, st, en,
    ti: f('ti', 200) || 'MicroMobility', lo: f('lo', 300), de: f('de', 600), al: f('al', 200),
    url: `${origin}/my-bookings`,
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `inline; filename="micromobility-${day.replace(/-/g, '')}.ics"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

export function icsBody(ev) {
  return [...ICS_HEAD, ...icsEvent(ev, Math.floor(Date.now() / 1000), icsStamp(Date.now())), 'END:VCALENDAR'].join('\r\n');
}
const ICS_HEAD = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MicroMobility//Bookings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
function icsStamp(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''); }
// One event's lines: the booking's own file above holds one, the rider's calendar address below one per booking.
function icsEvent(ev, seq, now) {
  // RFC 5545 text: backslash, comma and semicolon escaped, a new line written as \n; no control characters.
  const esc = (s) => [...String(s).replace(/\r\n?/g, '\n')].filter((ch) => { const c = ch.charCodeAt(0); return c === 10 || (c >= 32 && c !== 127); }).join('')
    .replace(/[\\,;]/g, (x) => '\\' + x).replace(/\n/g, '\\n');
  return ['BEGIN:VEVENT',
    `UID:${ev.uid}`, `SEQUENCE:${seq}`, `DTSTAMP:${now}`,
    `DTSTART:${ev.st}`, `DTEND:${ev.en}`,
    `SUMMARY:${esc(ev.ti)}`,
    ...(ev.lo ? [`LOCATION:${esc(ev.lo)}`] : []),
    `DESCRIPTION:${esc(ev.de)}`,
    `URL:${ev.url}`,
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${esc(ev.al || ev.ti)}`, 'END:VALARM',
    'END:VEVENT'];
}

function text(msg, status) {
  return new Response(msg, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

// ── The rider's own calendar address (new features build F27, 2026-11-13) ────────────────────────────────────
// GET /api/ics?k=<key>: the bookings a rider still holds on sessions not yet over, as one calendar that a phone or a
// calendar service subscribes to (the Account row "Calendar" hands out webcal://<this address>, calendar-feed.js).
// The key is the rider's alone (calendar_feeds, migration 20261114082700); they replace it from the same pop-up, and
// the old address finds nobody from then on.
// - Nothing here writes the address or its key anywhere: no log line, no shared cache (private, no-store), no
//   redirect that would carry it on.
// - Metered per caller before anything is looked at (FEED_MAX in FEED_WINDOW_MS, per isolate, the way log-error.js
//   meters its senders) and per key by the database (calendar_feed answers 'busy'). Over either is a 429, which a
//   calendar takes as "keep what you have". The database cannot meter the caller: it sees this function's address.
// - A key of the wrong shape, or one nobody holds, gets an empty calendar: the answer a rider with no bookings gets,
//   so the address says nothing about a key. The database out of reach is a 503 for every key alike (an empty
//   calendar there would wipe a rider's events from their phone).
// - The events are written here, not by the page: no page is open when a calendar asks. The words are the app's own
//   (FEED_WORDS: the strings the ticket and the booking's file use, held equal by tests/calendar-feed.spec.ts), in
//   the language the rider had when they last opened the pop-up. What a session is called, when it starts and ends
//   and where it meets follow the page (app.src.html: _rideKind, KIND_TRAITS, downloadBookingICS, _venueName, fmt12h):
//   keep them in step. No price, no name, nobody else's booking.
const FEED_KEY = /^[0-9a-f]{64}$/;
const FEED_MAX = 60, FEED_WINDOW_MS = 5 * 60000;
const _feedBy = new Map(); // caller -> { at, n }

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url), now = Date.now();
  if (!feedGate(request.headers.get('cf-connecting-ip') || 'unknown', now)) return feedLater(429);
  const k = url.searchParams.get('k') || '';
  if (!FEED_KEY.test(k)) return feedAnswer(feedBody([], 'en', url.origin, now));
  const SUPA = env.SUPABASE_URL || 'https://qpffkzmsfyilicwcsszz.supabase.co';
  const ANON = env.SUPABASE_ANON_KEY;
  if (!ANON) return feedLater(503);
  let data;
  try {
    // The key travels in the body, as the rider's token does above: never in an address the database logs.
    const r = await fetch(`${SUPA}/rest/v1/rpc/calendar_feed`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: k }),
    });
    if (!r.ok) return feedLater(503);
    data = await r.json();
  } catch { return feedLater(503); }
  if (data && data.ok === false) return feedLater(429); // the address's own hourly budget is spent
  if (!data || data.ok !== true) return feedLater(503);
  return feedAnswer(feedBody(Array.isArray(data.items) ? data.items : [], data.lang, url.origin, now));
}

function feedGate(who, now) {
  const m = _feedBy.get(who);
  if (!m || now - m.at >= FEED_WINDOW_MS) {
    if (_feedBy.size > 5000) for (const [k, v] of _feedBy) if (now - v.at >= FEED_WINDOW_MS) _feedBy.delete(k);
    _feedBy.set(who, { at: now, n: 1 });
    return true;
  }
  m.n++;
  return m.n <= FEED_MAX;
}
function feedLater(status) {
  return new Response('', { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store', 'retry-after': '600' } });
}
function feedAnswer(body) {
  return new Response(body, {
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="micromobility.ics"',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex, nofollow',
      'referrer-policy': 'no-referrer',
    },
  });
}

export const FEED_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
// Each row is the app's own string of that name, in FEED_LANGS order: ride = icsRideTitle; the kinds = ev...Name;
// jcc, jyc, gym = evJccName, venueJyc, venueGymnation; meet = meetPointLbl; gather, start = commGatherShort,
// commStartShort; doors, heat = vlDoorsShort, vlHeatShort; arrive, dinner = fhArrive, fhDinner (the Farm House Night); dRide, dMeet, dBike, dVisit = icsDesc...; alarm = icsAlarm.
export const FEED_WORDS = {
  ride: ['MicroMobility Ride', 'جولة MicroMobility', 'Sortie MicroMobility', 'Recorrido MicroMobility', 'Passeio MicroMobility', 'MicroMobility رائیڈ', 'MicroMobility राइड', 'Ride sa MicroMobility', 'MicroMobility राइड', 'MicroMobility রাইড'],
  petromin: ['Petromin night', 'ليلة بترومين', 'Soirée Petromin', 'Noche Petromin', 'Noite Petromin', 'پیٹرومن کی رات', 'पेट्रोमिन की रात', 'Petromin night', 'पेट्रोमिन को रात', 'Petromin-এর রাত'],
  swim: ['Triathlon Pool Session', 'جلسة مسبح الترايثلون', 'Séance piscine triathlon', 'Sesión de piscina de triatlón', 'Sessão de piscina de triatlo', 'ٹرائیتھلون پول سیشن', 'ट्रायथलॉन पूल सेशन', 'Triathlon Pool Session', 'ट्रायथलन पूल सेसन', 'ট্রায়াথলন পুল সেশন'],
  workshop: ['T100 Triathlon Prep', 'T100 التحضير للترايثلون', 'Préparation triathlon T100', 'Preparación de triatlón T100', 'Preparação para triatlo T100', 'T100 ٹرائیتھلون تیاری', 'T100 ट्रायथलॉन तैयारी', 'T100 Triathlon Prep', 'T100 ट्रायथलन तयारी', 'T100 ট্রায়াথলন প্রস্তুতি'],
  snd96: ['Saudi National Day 96 Ride', 'جولة اليوم الوطني السعودي 96', 'Sortie Fête nationale saoudienne 96', 'Ruta del Día Nacional Saudí 96', 'Passeio do Dia Nacional Saudita 96', 'سعودی قومی دن 96 رائیڈ', 'सऊदी राष्ट्रीय दिवस 96 राइड', 'Saudi National Day 96 Ride', 'साउदी राष्ट्रिय दिवस 96 राइड', 'সৌদি জাতীয় দিবস 96 রাইড'],
  event: ['Event', 'فعالية', 'Événement', 'Evento', 'Evento', 'ایونٹ', 'इवेंट', 'Event', 'इभेन्ट', 'ইভেন্ট'],
  runher: ['Run for Her', 'نركض لأجلها', 'Run for Her', 'Run for Her', 'Run for Her', 'Run for Her', 'Run for Her', 'Run for Her', 'Run for Her', 'Run for Her'],
  vlap: ['Victory Lap', 'فيكتوري لاب', 'Victory Lap', 'Victory Lap', 'Victory Lap', 'Victory Lap', 'Victory Lap', 'Victory Lap', 'Victory Lap', 'Victory Lap'],
  arena: ['Arena Heros Hybrid Race', 'سباق أرينا هيروز الهجين', 'Arena Heros Hybrid Race', 'Arena Heros Hybrid Race', 'Arena Heros Hybrid Race', 'Arena Heros Hybrid Race', 'Arena Heros Hybrid Race', 'Arena Heros Hybrid Race', 'Arena Heros Hybrid Race', 'Arena Heros Hybrid Race'],
  defe5k: ['DEFE 5KM Run', 'سباق دفء 5 كم', 'DEFE 5KM Run', 'DEFE 5KM Run', 'DEFE 5KM Run', 'DEFE 5KM Run', 'DEFE 5KM Run', 'DEFE 5KM Run', 'DEFE 5KM Run', 'DEFE 5KM Run'],
  blood: ['Micromobility Blood Donation', 'مايكروموبيليتي التبرع بالدم', 'Micromobility Don de sang', 'Micromobility Donación de sangre', 'Micromobility Doação de sangue', 'Micromobility خون کا عطیہ', 'Micromobility रक्तदान', 'Micromobility Pagbibigay ng Dugo', 'Micromobility रक्तदान', 'Micromobility রক্তদান'],
  yoga: ['Hatha Yoga for Cyclists', 'هاثا يوغا لراكبي الدراجات', 'Hatha yoga pour cyclistes', 'Hatha yoga para ciclistas', 'Hatha ioga para ciclistas', 'سائیکل سواروں کے لیے ہٹھ یوگا', 'साइकिल चालकों के लिए हठ योग', 'Hatha Yoga para sa mga Siklista', 'साइकल चालकहरूका लागि हठ योग', 'সাইক্লিস্টদের জন্য হঠ যোগ'],
  farm: ['Farm House Night', 'ليلة المزرعة', 'Soirée à la ferme', 'Noche en la granja', 'Noite na fazenda', 'فارم ہاؤس نائٹ', 'फ़ार्म हाउस नाइट', 'Farm House Night', 'फार्म हाउस नाइट', 'ফার্ম হাউস নাইট'],
  saturday: ['Saturday Social Ride', 'جولة السبت الاجتماعية', 'Sortie sociale du samedi', 'Recorrido social del sábado', 'Passeio social de sábado', 'ہفتے کی سوشل رائیڈ', 'शनिवार सोशल राइड', 'Saturday Social Ride', 'शनिबार सामाजिक राइड', 'শনিবারের সোশ্যাল রাইড'],
  jcc: ['Jeddah Corniche Circuit', 'حلبة كورنيش جدة', 'Circuit de la Corniche de Djeddah', 'Circuito de la Corniche de Yeda', 'Circuito da Corniche de Jeddah', 'جدہ کورنیش سرکٹ', 'जेद्दाह कॉर्निश सर्किट', 'Jeddah Corniche Circuit', 'जेद्दा कोर्निश सर्किट', 'জেদ্দা কর্নিশ সার্কিট'],
  jyc: ['Jeddah Yacht Club', 'نادي جدة لليخوت', 'Jeddah Yacht Club', 'Jeddah Yacht Club', 'Jeddah Yacht Club', 'جدہ یاٹ کلب', 'जेद्दाह यॉट क्लब', 'Jeddah Yacht Club', 'जेद्दा याट क्लब', 'জেদ্দা ইয়ট ক্লাব'],
  gym: ['Gymnation, Tahlia Street', 'Gymnation، شارع التحلية', 'Gymnation, rue Tahlia', 'Gymnation, calle Tahlia', 'Gymnation, rua Tahlia', 'Gymnation، تحلیہ اسٹریٹ', 'Gymnation, तहलिया स्ट्रीट', 'Gymnation, Tahlia Street', 'Gymnation, तहलिया स्ट्रिट', 'Gymnation, তাহলিয়া স্ট্রিট'],
  meet: ['Meeting point', 'نقطة التجمع', 'Point de rendez-vous', 'Punto de encuentro', 'Ponto de encontro', 'ملاقات کی جگہ', 'मिलने की जगह', 'Tagpuan', 'भेट्ने ठाउँ', 'মিলনস্থল'],
  gather: ['Gathering', 'التجمع', 'Rassemblement', 'Encuentro', 'Encontro', 'اجتماع', 'एकत्रण', 'Pagtitipon', 'भेला', 'জড়ো হওয়া'],
  start: ['Start', 'الانطلاق', 'Départ', 'Salida', 'Saída', 'آغاز', 'शुरू', 'Simula', 'सुरु', 'শুরু'],
  doors: ['Doors open', 'فتح الأبواب', 'Ouverture des portes', 'Apertura de puertas', 'Abertura dos portões', 'دروازے کھلنے کا وقت', 'दरवाज़े खुलेंगे', 'Bukas ang pinto', 'ढोका खुल्ने', 'দরজা খুলবে'],
  arrive: ['Arrival', 'الوصول', 'Arrivée', 'Llegada', 'Chegada', 'آمد', 'आगमन', 'Pagdating', 'आगमन', 'আগমন'],
  dinner: ['Dinner', 'العشاء', 'Dîner', 'Cena', 'Jantar', 'رات کا کھانا', 'रात का खाना', 'Hapunan', 'बेलुकीको खाना', 'রাতের খাবার'],
  heat: ['First heat', 'أول دفعة', 'Première vague', 'Primera tanda', 'Primeira bateria', 'پہلی ہیٹ', 'पहली हीट', 'Unang heat', 'पहिलो हिट', 'প্রথম হিট'],
  dRide: ['Your MicroMobility ride. Be at the meeting point by the gathering time and show your ticket there.', 'جولتك مع MicroMobility. كن في نقطة التجمع بحلول وقت التجمع واعرض تذكرتك هناك.', 'Votre sortie MicroMobility. Soyez au point de rendez-vous à l’heure de rassemblement et présentez-y votre billet.', 'Tu recorrido con MicroMobility. Llega al punto de encuentro a la hora de encuentro y muestra allí tu entrada.', 'O seu passeio MicroMobility. Esteja no ponto de encontro no horário de encontro e mostre lá o seu bilhete.', 'آپ کی MicroMobility رائیڈ۔ اجتماع کے وقت تک ملاقات کی جگہ پر پہنچیں اور وہاں اپنا ٹکٹ دکھائیں۔', 'आपकी MicroMobility राइड। एकत्र होने के समय तक मिलने की जगह पर पहुँचें और वहाँ अपना टिकट दिखाएँ।', 'Ang iyong ride sa MicroMobility. Pumunta sa meeting point bago ang oras ng pagtitipon at ipakita roon ang iyong ticket.', 'तपाईंको MicroMobility राइड। भेला हुने समयसम्म भेट्ने ठाउँमा आइपुग्नुहोस् र त्यहाँ आफ्नो टिकट देखाउनुहोस्।', 'আপনার MicroMobility রাইড। জড়ো হওয়ার সময়ের মধ্যে মিলনস্থলে পৌঁছান এবং সেখানে আপনার টিকিট দেখান।'],
  dMeet: ['Your MicroMobility booking. Be at the meeting point by the gathering time and show your ticket there.', 'حجزك مع MicroMobility. كن في نقطة التجمع بحلول وقت التجمع واعرض تذكرتك هناك.', 'Votre réservation MicroMobility. Soyez au point de rendez-vous à l’heure de rassemblement et présentez-y votre billet.', 'Tu reserva de MicroMobility. Llega al punto de encuentro a la hora de encuentro y muestra allí tu entrada.', 'A sua reserva MicroMobility. Esteja no ponto de encontro no horário de encontro e mostre lá o seu bilhete.', 'آپ کی MicroMobility بکنگ۔ اجتماع کے وقت تک ملاقات کی جگہ پر پہنچیں اور وہاں اپنا ٹکٹ دکھائیں۔', 'आपकी MicroMobility बुकिंग। एकत्र होने के समय तक मिलने की जगह पर पहुँचें और वहाँ अपना टिकट दिखाएँ।', 'Ang iyong booking sa MicroMobility. Pumunta sa meeting point bago ang oras ng pagtitipon at ipakita roon ang iyong ticket.', 'तपाईंको MicroMobility बुकिङ। भेला हुने समयसम्म भेट्ने ठाउँमा आइपुग्नुहोस् र त्यहाँ आफ्नो टिकट देखाउनुहोस्।', 'আপনার MicroMobility বুকিং। জড়ো হওয়ার সময়ের মধ্যে মিলনস্থলে পৌঁছান এবং সেখানে আপনার টিকিট দেখান।'],
  dBike: ['Your MicroMobility bike rental. Arrive 10 minutes early and show your ticket at the booth.', 'حجز دراجتك من MicroMobility. احضر قبل الموعد بـ 10 دقائق واعرض تذكرتك عند الكشك.', 'Votre location de vélo MicroMobility. Arrivez 10 minutes en avance et présentez votre billet au stand.', 'Tu alquiler de bicicleta de MicroMobility. Llega 10 minutos antes y muestra tu entrada en el puesto.', 'O seu aluguel de bicicleta MicroMobility. Chegue 10 minutos antes e mostre o seu bilhete no estande.', 'آپ کی MicroMobility سائیکل کرایہ کی بکنگ۔ 10 منٹ پہلے پہنچیں اور بوتھ پر اپنا ٹکٹ دکھائیں۔', 'आपकी MicroMobility साइकिल किराये की बुकिंग। 10 मिनट पहले पहुँचें और बूथ पर अपना टिकट दिखाएँ।', 'Ang iyong pag-upa ng bisikleta sa MicroMobility. Dumating nang 10 minuto nang maaga at ipakita ang iyong ticket sa booth.', 'तपाईंको MicroMobility साइकल भाडाको बुकिङ। 10 मिनेट अगाडि आइपुग्नुहोस् र बुथमा आफ्नो टिकट देखाउनुहोस्।', 'আপনার MicroMobility সাইকেল ভাড়ার বুকিং। 10 মিনিট আগে পৌঁছান এবং বুথে আপনার টিকিট দেখান।'],
  dVisit: ['Your MicroMobility booking. Arrive 10 minutes early and show your ticket when you arrive.', 'حجزك مع MicroMobility. احضر قبل الموعد بـ 10 دقائق واعرض تذكرتك عند وصولك.', 'Votre réservation MicroMobility. Arrivez 10 minutes en avance et présentez votre billet à votre arrivée.', 'Tu reserva de MicroMobility. Llega 10 minutos antes y muestra tu entrada al llegar.', 'A sua reserva MicroMobility. Chegue 10 minutos antes e mostre o seu bilhete ao chegar.', 'آپ کی MicroMobility بکنگ۔ 10 منٹ پہلے پہنچیں اور پہنچنے پر اپنا ٹکٹ دکھائیں۔', 'आपकी MicroMobility बुकिंग। 10 मिनट पहले पहुँचें और पहुँचने पर अपना टिकट दिखाएँ।', 'Ang iyong booking sa MicroMobility. Dumating nang 10 minuto nang maaga at ipakita ang iyong ticket pagdating mo.', 'तपाईंको MicroMobility बुकिङ। 10 मिनेट अगाडि आइपुग्नुहोस् र आइपुग्दा आफ्नो टिकट देखाउनुहोस्।', 'আপনার MicroMobility বুকিং। 10 মিনিট আগে পৌঁছান এবং পৌঁছে আপনার টিকিট দেখান।'],
  alarm: ['Reminder: {0}', 'تذكير: {0}', 'Rappel : {0}', 'Recordatorio: {0}', 'Lembrete: {0}', 'یاد دہانی: {0}', 'रिमाइंडर: {0}', 'Paalala: {0}', 'सम्झना: {0}', 'অনুস্মারক: {0}'],
};
const FEED_KINDS = ['petromin', 'swim', 'workshop', 'runher', 'vlap', 'arena', 'defe5k', 'blood', 'yoga', 'farm'];
const FEED_NO_BIKE = new Set(['swim', 'workshop', 'event', 'runher', 'vlap', 'arena', 'defe5k', 'blood', 'yoga', 'farm']);
const FEED_GATHERS = new Set(['saturday', 'snd96', 'runher', 'vlap', 'farm']); // their times are "gathering, then start" (the Farm House Night: arrival, then dinner)
const FEED_VENUE = { JCC: 'jcc', JYC: 'jyc', 'Gymnation, Tahlia Street': 'gym' };

// The calendar: one event per row the database answered with, less what has already ended.
export function feedBody(items, lang, origin, nowMs) {
  const li = FEED_LANGS.indexOf(lang), L = li < 0 ? 0 : li;
  const w = (k) => { const row = FEED_WORDS[k] || ['']; return row[L] || row[0]; };
  const out = [...ICS_HEAD, 'X-WR-CALNAME:MicroMobility', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  const seq = Math.floor(nowMs / 1000), now = icsStamp(nowMs), seen = new Set();
  for (const r of Array.isArray(items) ? items : []) {
    const ev = feedEvent(r, w, FEED_LANGS[L], origin);
    if (!ev || ev.endMs <= nowMs || seen.has(ev.uid)) continue;
    seen.add(ev.uid);
    out.push(...icsEvent(ev, seq, now));
  }
  out.push('END:VCALENDAR');
  return out.join('\r\n');
}

// Which ride a session is (_rideKind): the National Day ride by its own mark, every other community session by its
// kind (a Saturday ride when it carries none), and anything else a night on the circuit.
function feedKind(r) {
  const k = r.rk, comm = r.ek === 'community' && k !== 'snd96';
  if (k === 'snd96') return 'snd96';
  if (!comm) return 'jcc';
  if (k === 'event') return 'event';
  return FEED_KINDS.includes(k) ? k : 'saturday';
}
function feedText(v) { return String(v == null ? '' : v).trim().slice(0, 200); }
// A stored link is served only as a plain http(s) address (_safeUrl); marks nobody can see are dropped first.
function feedUrl(v) {
  const s = String(v == null ? '' : v).replace(/\p{Cf}/gu, '').trim().slice(0, 500);
  return /^https?:\/\/[^\s"<>`]+$/i.test(s) ? s : '';
}
// "6:30 AM", "7 PM" (fmt12h): Arabic marks the half of the day its own way, Urdu names the part of the day.
function feedTime(h, mm, lang) {
  const hr = +h % 24, h12 = hr % 12 || 12;
  const suf = lang === 'ur' ? (hr < 4 || hr >= 20 ? 'رات' : hr < 12 ? 'صبح' : hr < 16 ? 'دوپہر' : hr < 18 ? 'سہ پہر' : 'شام')
    : hr >= 12 ? (lang === 'ar' ? 'م' : 'PM') : (lang === 'ar' ? 'ص' : 'AM');
  return mm === '00' ? `${h12} ${suf}` : `${h12}:${mm} ${suf}`;
}
function feedEvent(r, w, lang, origin) {
  if (!r || typeof r !== 'object') return null;
  const day = String(r.date || '').slice(0, 10), id = String(r.id || '').replace(/[^\w-]/g, '').slice(0, 64);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !id) return null;
  const kind = feedKind(r), gathers = FEED_GATHERS.has(kind), bike = !FEED_NO_BIKE.has(kind);
  // The times as the booking's own file writes them (downloadBookingICS): a session that gathers stores "gathering,
  // then start", so it begins at the gathering and ends two hours after the start; every other stores "start, end".
  // An end at or before the start is the next day's. Written in UTC from Jeddah's clock (UTC+3, no clock changes).
  const m = String(r.time || '').match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
  let s = 540, e = 660;
  if (m) { s = +m[1] * 60 + +m[2]; e = (+m[3] + (gathers ? 2 : 0)) * 60 + +m[4]; if (e <= s) e += 1440; }
  const base = Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) - 3 * 36e5;
  // The name staff gave it (its Arabic one on an Arabic calendar), else the kind's own; a circuit night has none.
  const name = kind === 'jcc' ? w('ride') : (lang === 'ar' && feedText(r.title_ar)) || feedText(r.title) || w(kind);
  // Where: the meeting point's own link where the session has one (_ownMapUrl), else the venue by name (_venueName).
  // A ride whose spot is not told yet comes without its location (calendar_feed blanks it): it names none.
  const comm = r.ek === 'community' && r.rk !== 'snd96';
  const meetsAt = (comm && r.appr !== false) || kind === 'runher' || kind === 'defe5k' || kind === 'arena';
  const link = feedUrl(r.meet), meet = (meetsAt || kind === 'yoga' || kind === 'farm') && link ? link : '';
  let lo = meet;
  if (!lo && !r.held) {
    const loc = feedText(r.loc) || (kind === 'runher' ? 'JYC' : kind === 'vlap' || kind === 'defe5k' || kind === 'blood' ? 'JCC' : '');
    lo = Object.prototype.hasOwnProperty.call(FEED_VENUE, loc) ? w(FEED_VENUE[loc]) : loc || w('jcc');
  }
  const de = [];
  if (gathers && m) de.push(`${w(kind === 'vlap' ? 'doors' : kind === 'farm' ? 'arrive' : 'gather')} ${feedTime(m[1], m[2], lang)} · ${w(kind === 'vlap' ? 'heat' : kind === 'farm' ? 'dinner' : 'start')} ${feedTime(m[3], m[4], lang)}`);
  de.push(w(gathers ? (bike ? 'dRide' : 'dMeet') : bike ? 'dBike' : 'dVisit'));
  if (meet) de.push(`${w('meet')}: ${meet}`);
  const endMs = base + e * 6e4;
  return {
    uid: `booking-${id}@micromobility.sa`, st: icsStamp(base + s * 6e4), en: icsStamp(endMs), endMs,
    ti: name, lo, de: de.join('\n'), al: w('alarm').replace('{0}', () => name), url: `${origin}/my-bookings`,
  };
}
