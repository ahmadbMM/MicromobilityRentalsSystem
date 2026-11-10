// The Community page's activities (the owner, 2026-11-03; 2026-11-04: members see nothing of each other, so the
// list, kudos, Rider of the Month, squads, the photo wall and the welcome buddy left the page; migration
// 20261104120000): the member's challenges, the community goal and the year in review. A file of its own, loaded
// when a member opens the page (_hubLoad in app.src.html), so no other rider carries it: it holds its own words in
// all ten languages. Hand-written, not generated; the build stamps its address (HUB_V).
/* global S, sb, esc, _on, getSession, _cssv, shortDate */
const HUB_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
const HUB_T = {
  tabGoals: ['Challenges', 'التحديات', 'Défis', 'Retos', 'Desafios', 'چیلنج', 'चुनौतियाँ', 'Mga hamon', 'चुनौती', 'চ্যালেঞ্জ'],
  tabYear: ['Your year', 'عامك', 'Votre année', 'Tu año', 'O seu ano', 'آپ کا سال', 'आपका साल', 'Ang taon mo', 'तपाईंको वर्ष', 'আপনার বছর'],
  err: ['We could not do that. Please try again.', 'تعذّر ذلك. يرجى المحاولة مرة أخرى.', 'Action impossible. Veuillez réessayer.', 'No se pudo hacer. Inténtalo de nuevo.', 'Não foi possível. Tente novamente.', 'یہ نہیں ہو سکا۔ دوبارہ کوشش کریں۔', 'यह नहीं हो सका। फिर कोशिश करें।', 'Hindi ito nagawa. Pakisubukang muli.', 'यो हुन सकेन। फेरि प्रयास गर्नुहोस्।', 'এটি করা যায়নি। আবার চেষ্টা করুন।'],
  retry: ['Try again', 'حاول مرة أخرى', 'Réessayer', 'Reintentar', 'Tentar novamente', 'دوبارہ کوشش کریں', 'फिर कोशिश करें', 'Subukang muli', 'फेरि प्रयास गर्नुहोस्', 'আবার চেষ্টা করুন'],
  loading: ['Loading...', 'جارٍ التحميل...', 'Chargement...', 'Cargando...', 'A carregar...', 'لوڈ ہو رہا ہے...', 'लोड हो रहा है...', 'Nilo-load...', 'लोड हुँदै...', 'লোড হচ্ছে...'],
  goalYou: ['Your challenge', 'تحديك', 'Votre défi', 'Tu reto', 'O seu desafio', 'آپ کا چیلنج', 'आपकी चुनौती', 'Hamon mo', 'तपाईंको चुनौती', 'আপনার চ্যালেঞ্জ'],
  goalAll: ['Community goal', 'هدف المجتمع', 'Objectif de la communauté', 'Meta de la comunidad', 'Objetivo da comunidade', 'کمیونٹی کا ہدف', 'समुदाय का लक्ष्य', 'Layunin ng komunidad', 'समुदायको लक्ष्य', 'কমিউনিটির লক্ষ্য'],
  goalsNone: ['No challenge is running right now.', 'لا يوجد تحدٍ جارٍ الآن.', 'Aucun défi en cours.', 'No hay ningún reto en marcha.', 'Não há nenhum desafio a decorrer.', 'ابھی کوئی چیلنج جاری نہیں۔', 'अभी कोई चुनौती नहीं चल रही।', 'Walang hamon ngayon.', 'अहिले कुनै चुनौती चलिरहेको छैन।', 'এখন কোনো চ্যালেঞ্জ চলছে না।'],
  goalOf: ['{0} of {1}, until {2}', '{0} من {1}، حتى {2}', '{0} sur {1}, jusqu’au {2}', '{0} de {1}, hasta el {2}', '{0} de {1}, até {2}', '{1} میں سے {0}، {2} تک', '{1} में से {0}, {2} तक', '{0} sa {1}, hanggang {2}', '{1} मध्ये {0}, {2} सम्म', '{1}টির মধ্যে {0}টি, {2} পর্যন্ত'],
  goalDone: ['Done', 'تم', 'Terminé', 'Hecho', 'Concluído', 'مکمل', 'पूरा', 'Tapos na', 'पूरा भयो', 'সম্পন্ন'],
  reward: ['Reward: {0}', 'الجائزة: {0}', 'Récompense : {0}', 'Premio: {0}', 'Prémio: {0}', 'انعام: {0}', 'इनाम: {0}', 'Gantimpala: {0}', 'पुरस्कार: {0}', 'পুরস্কার: {0}'],
  yrTitle: ['Your {0} with MicroMobility', 'عامك {0} مع مايكروموبيليتي', 'Votre année {0} avec MicroMobility', 'Tu {0} con MicroMobility', 'O seu {0} com a MicroMobility', 'MicroMobility کے ساتھ آپ کا {0}', 'MicroMobility के साथ आपका {0}', 'Ang {0} mo kasama ang MicroMobility', 'MicroMobility सँग तपाईंको {0}', 'MicroMobility-র সাথে আপনার {0}'],
  yrSessions: ['Sessions', 'الأنشطة', 'Sessions', 'Sesiones', 'Sessões', 'سیشن', 'सत्र', 'Mga session', 'सत्र', 'সেশন'],
  yrSat: ['Saturday rides', 'رحلات السبت', 'Sorties du samedi', 'Salidas de sábado', 'Passeios de sábado', 'ہفتے کی سواریاں', 'शनिवार राइड', 'Saturday ride', 'शनिबारे राइड', 'শনিবারের রাইড'],
  yrKinds: ['Kinds of event', 'أنواع الفعاليات', 'Types d’événements', 'Tipos de evento', 'Tipos de evento', 'تقریبات کی اقسام', 'कार्यक्रमों के प्रकार', 'Uri ng event', 'कार्यक्रमका प्रकार', 'ইভেন্টের ধরন'],
  yrKudos: ['Kudos received', 'التقدير المستلم', 'Bravos reçus', 'Aplausos recibidos', 'Aplausos recebidos', 'ملی داد', 'मिली शाबाशी', 'Natanggap na kudos', 'पाएको स्याबासी', 'পাওয়া বাহবা'],
  yrBadges: ['Badges from our staff', 'شارات من فريقنا', 'Badges de notre équipe', 'Insignias de nuestro equipo', 'Emblemas da nossa equipa', 'ہمارے عملے کے بیج', 'हमारे स्टाफ़ के बैज', 'Mga badge mula sa staff', 'हाम्रा कर्मचारीका ब्याज', 'আমাদের স্টাফের ব্যাজ'],
  yrFirst: ['First of the year: {0}', 'الأول هذا العام: {0}', 'Première de l’année : {0}', 'La primera del año: {0}', 'A primeira do ano: {0}', 'سال کا پہلا: {0}', 'साल का पहला: {0}', 'Una sa taon: {0}', 'वर्षको पहिलो: {0}', 'বছরের প্রথম: {0}'],
  yrShare: ['Share my year', 'شارك عامي', 'Partager mon année', 'Compartir mi año', 'Partilhar o meu ano', 'میرا سال شیئر کریں', 'मेरा साल साझा करें', 'Ibahagi ang taon ko', 'मेरो वर्ष साझा गर्नुहोस्', 'আমার বছর শেয়ার করুন'],
  yrShareMsg: ['My {0} with MicroMobility: {1} sessions, {2} Saturday rides, {3} kudos.', 'عامي {0} مع مايكروموبيليتي: {1} نشاط، {2} رحلة سبت، {3} تقدير.', 'Mon année {0} avec MicroMobility : {1} sessions, {2} sorties du samedi, {3} bravos.', 'Mi {0} con MicroMobility: {1} sesiones, {2} salidas de sábado, {3} aplausos.', 'O meu {0} com a MicroMobility: {1} sessões, {2} passeios de sábado, {3} aplausos.', 'MicroMobility کے ساتھ میرا {0}: {1} سیشن، ہفتے کی {2} سواریاں، {3} داد۔', 'MicroMobility के साथ मेरा {0}: {1} सत्र, {2} शनिवार राइड, {3} शाबाशी।', 'Ang {0} ko kasama ang MicroMobility: {1} session, {2} Saturday ride, {3} kudos.', 'MicroMobility सँग मेरो {0}: {1} सत्र, {2} शनिबारे राइड, {3} स्याबासी।', 'MicroMobility-র সাথে আমার {0}: {1}টি সেশন, {2}টি শনিবারের রাইড, {3}টি বাহবা।'],
};
function _hT(k) {
  const row = HUB_T[k] || [''], i = HUB_LANGS.indexOf(S.lang);
  return row[i < 0 ? 0 : i] || row[0];
}
function _hF(k, ...v) { return v.reduce((s, x, i) => s.split('{' + i + '}').join(String(x)), _hT(k)); }
function _hPick(x, en, ar) { return String((x && ((S.lang === 'ar' && x[ar]) || x[en])) || ''); }
function _hCust() { return S.loggedIn || getSession(); }
function _hDate(d) { const s = String(d || '').slice(0, 10); return /^\d{4}-\d\d-\d\d$/.test(s) ? shortDate(s) : ''; }
function _hTok(c) { return { p_id: c.id, p_token: c.session_token }; }

// The overview: read when the page opens and after a change, kept two minutes otherwise.
async function _hubFetch(force) {
  const c = _hCust(); if (!c || !sb || S._hubBusy) return;
  const h = S._hub;
  if (!force && h && h.forId === c.id && h.d && Date.now() - h.at < 12e4) return;
  S._hubBusy = true;
  let r; try { r = await sb.rpc('hub_overview', _hTok(c)); } catch (e) { r = { error: e }; }
  S._hubBusy = false;
  // Signed out, or another account signed in, while it was asked: the answer is not theirs (a shared phone).
  // The page asks again for whoever is signed in now.
  const now = _hCust();
  if (!now || now.id !== c.id) { if (S.custTab === 'members') _hubRender(); return; }
  const d = r && !r.error && r.data && r.data.ok === true ? r.data : null;
  S._hub = { forId: c.id, at: Date.now(), d };
  if (S.custTab === 'members') _hubRender();
}
const _HUB_TABS = ['goals', 'year'];
function _hubTab(k) {
  S._hubTab = _HUB_TABS.includes(k) ? k : 'goals';
  _hubRender();
}
function _hubRender() {
  const nav = document.getElementById('hub-nav'), body = document.getElementById('hub-body');
  if (!nav || !body) return;
  // Only the signed-in account's own overview shows: another member's, left from earlier on this phone, is
  // dropped and read again (bug hunt 2026-11-10). One older than two minutes is read again too; a failed
  // read waits for Try again, so a failure never asks in a loop.
  const c = _hCust();
  if (S._hub && (!c || S._hub.forId !== c.id)) S._hub = null;
  const h = S._hub, d = h && h.d;
  if (!h || (d && Date.now() - h.at >= 12e4)) _hubFetch();
  const tabs = _HUB_TABS.filter((k) => k !== 'year' || (d && d.year && Number(d.year.rides) > 0)), tab = tabs.includes(S._hubTab) ? S._hubTab : 'goals';
  nav.innerHTML = tabs.map((k) => `<button type="button" class="hub-tab${k === tab ? ' on' : ''}" aria-pressed="${k === tab}" data-on-click="${_on('_hubTab', k)}">${_hT('tab' + k[0].toUpperCase() + k.slice(1))}</button>`).join('');
  if (!d) {
    body.innerHTML = h ? `<div class="am-meta">${_hT('err')}</div><button type="button" class="btn-primary hub-wide" data-on-click="${_on('_hubRetry')}">${_hT('retry')}</button>` : `<div class="am-meta">${_hT('loading')}</div>`;
    return;
  }
  body.innerHTML = tab === 'year' ? _yrHtml(d) : _goHtml(d);
}
function _hubRetry() { S._hub = null; _hubRender(); _hubFetch(true); }
// ── Challenges and the community goal ──────────────────────────────────
function _goHtml(d) {
  const list = Array.isArray(d.goals) ? d.goals : [];
  if (!list.length) return `<div class="am-meta">${_hT('goalsNone')}</div>`;
  return list.map((g) => {
    const n = Number(g.progress) || 0, tg = Number(g.target) || 1, pct = Math.min(100, Math.round(n / tg * 100)), rw = _hPick(g, 'reward', 'reward_ar');
    return `<div class="hub-card"><div class="am-meta">${_hT(g.kind === 'goal' ? 'goalAll' : 'goalYou')}</div>
      <strong class="hub-name"><bdi>${esc(_hPick(g, 'name', 'name_ar'))}</bdi></strong>
      <div class="hub-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${tg}" aria-valuenow="${Math.min(n, tg)}" aria-label="${esc(_hPick(g, 'name', 'name_ar'))}"><span data-cssv="${_cssv({ '--w': pct + '%' })}"></span></div>
      <div class="am-meta">${n >= tg ? _hT('goalDone') + ' · ' : ''}${_hF('goalOf', n, tg, _hDate(g.ends_on))}</div>
      ${rw ? `<div class="am-meta">${_hF('reward', esc(rw))}</div>` : ''}</div>`;
  }).join('');
}

async function _hShare(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
}
// ── The year in review (December and January) ──────────────────────────
function _yrHtml(d) {
  const y = d.year; if (!y) return '';
  const st = (k, v) => `<div class="hub-stat"><strong>${Number(v) || 0}</strong><span>${_hT(k)}</span></div>`;
  return `<div class="hub-card"><h2 class="hub-h">${_hF('yrTitle', y.year)}</h2><div class="hub-stats">${st('yrSessions', y.rides)}${st('yrSat', y.saturdays)}${st('yrKinds', y.kinds)}${st('yrKudos', y.kudos)}${st('yrBadges', y.badges)}</div>
    ${y.first ? `<div class="am-meta">${_hF('yrFirst', _hDate(y.first))}</div>` : ''}
    <button type="button" class="btn-primary hub-wide" data-on-click="${_on('_yrShare')}">${_hT('yrShare')}</button></div>`;
}
function _yrShare() { const h = S._hub, c = _hCust(), y = h && c && h.forId === c.id && h.d && h.d.year; if (y) _hShare(_hF('yrShareMsg', y.year, Number(y.rides) || 0, Number(y.saturdays) || 0, Number(y.kudos) || 0)); }
