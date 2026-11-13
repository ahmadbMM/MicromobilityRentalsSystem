// The learn-to-ride ladder (new features build F21, 2026-11-13). A learner on a learn-to-ride sign-up climbs four levels:
// balance, pedal, steer and brake, ride the circuit. The instructor ticks the skills on the staff page and writes one line;
// the account the sign-up landed on sees it here, in a centred pop-up from Account > Learn to ride. A skill not ticked
// reads "Practising": nothing is marked failed. A complete level gives a certificate drawn on the phone (a PNG to save or
// share); the whole ladder also shows the way to a Saturday ride (the app's own Saturday gate: a member books, anyone
// else is shown how to apply). Only this account's own learners are ever read (learn_ladder, migration 20261114082100).
// A file of its own, fetched when the row is tapped (_llOpen in app.src.html), with its own words in all ten languages.
// Hand-written, not generated; the build stamps its address (LL_V).
/* global S, esc, _on, _EV, _EL, getSession, _cuIc, toast, closeConfirm, shortDate, _ksaYmd, selectEvent, _llMineLoad */
const LL_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
const LL_T = {
  title: ['Learn to ride', 'تعلّم ركوب الدراجة', 'Apprendre à rouler', 'Aprender a montar', 'Aprender a pedalar', 'سواری سیکھنا', 'सवारी सीखना', 'Pag-aaral magbisikleta', 'चलाउन सिक्ने', 'চালানো শেখা'],
  lv1: ['Balance', 'التوازن', 'Équilibre', 'Equilibrio', 'Equilíbrio', 'توازن', 'संतुलन', 'Balanse', 'सन्तुलन', 'ভারসাম্য'],
  lv2: ['Pedal', 'التبديل بالدواسات', 'Pédaler', 'Pedalear', 'Pedalar', 'پیڈل چلانا', 'पैडल चलाना', 'Pagpedal', 'पेडल चलाउने', 'প্যাডেল চালানো'],
  lv3: ['Steer and brake', 'التوجيه والفرملة', 'Diriger et freiner', 'Girar y frenar', 'Virar e frear', 'موڑنا اور بریک لگانا', 'मोड़ना और ब्रेक लगाना', 'Pagliko at pagpreno', 'मोड्ने र ब्रेक लगाउने', 'ঘোরানো ও ব্রেক করা'],
  lv4: ['Ride the circuit', 'الركوب في الحلبة', 'Rouler sur le circuit', 'Rodar en el circuito', 'Pedalar no circuito', 'سرکٹ پر سواری', 'सर्किट पर सवारी', 'Pagbisikleta sa circuit', 'सर्किटमा सवारी', 'সার্কিটে চালানো'],
  lvOf: ['Level {0} of {1}', 'المستوى {0} من {1}', 'Niveau {0} sur {1}', 'Nivel {0} de {1}', 'Nível {0} de {1}', '{1} میں سے سطح {0}', '{1} में से स्तर {0}', 'Antas {0} ng {1}', '{1} मध्ये तह {0}', '{1}টির মধ্যে স্তর {0}'],
  prac: ['Practising', 'قيد التمرين', 'En cours d’acquisition', 'Practicando', 'Praticando', 'مشق جاری ہے', 'अभ्यास जारी', 'Nagsasanay pa', 'अभ्यास गर्दै', 'অনুশীলন চলছে'],
  got: ['Learned', 'تم إتقانها', 'Acquis', 'Aprendido', 'Aprendido', 'سیکھ لیا', 'सीख लिया', 'Natutunan na', 'सिकिसकियो', 'শেখা হয়েছে'],
  fb: ['From your instructor', 'من مدرّبك', 'De votre moniteur', 'De tu instructor', 'Do seu instrutor', 'آپ کے انسٹرکٹر کی طرف سے', 'आपके प्रशिक्षक की ओर से', 'Mula sa iyong instructor', 'तपाईंको प्रशिक्षकबाट', 'আপনার প্রশিক্ষকের কাছ থেকে'],
  cert: ['Certificate', 'شهادة', 'Certificat', 'Certificado', 'Certificado', 'سرٹیفکیٹ', 'प्रमाणपत्र', 'Sertipiko', 'प्रमाणपत्र', 'সনদ'],
  certAlt: ['Certificate: {0}', 'شهادة: {0}', 'Certificat : {0}', 'Certificado: {0}', 'Certificado: {0}', 'سرٹیفکیٹ: {0}', 'प्रमाणपत्र: {0}', 'Sertipiko: {0}', 'प्रमाणपत्र: {0}', 'সনদ: {0}'],
  wait: ['Preparing the certificate', 'جارٍ تجهيز الشهادة', 'Préparation du certificat', 'Preparando el certificado', 'Preparando o certificado', 'سرٹیفکیٹ تیار ہو رہا ہے', 'प्रमाणपत्र तैयार हो रहा है', 'Inihahanda ang sertipiko', 'प्रमाणपत्र तयार हुँदैछ', 'সনদ তৈরি হচ্ছে'],
  save: ['Save image', 'حفظ الصورة', 'Enregistrer l’image', 'Guardar imagen', 'Salvar imagem', 'تصویر محفوظ کریں', 'इमेज सहेजें', 'I-save ang larawan', 'तस्बिर सेभ गर्नुहोस्', 'ছবি সংরক্ষণ করুন'],
  share: ['Share', 'مشاركة', 'Partager', 'Compartir', 'Compartilhar', 'شیئر کریں', 'शेयर करें', 'Ibahagi', 'सेयर गर्नुहोस्', 'শেয়ার করুন'],
  back: ['Back', 'رجوع', 'Retour', 'Volver', 'Voltar', 'واپس', 'वापस', 'Bumalik', 'फर्कनुहोस्', 'ফিরে যান'],
  close: ['Close', 'إغلاق', 'Fermer', 'Cerrar', 'Fechar', 'بند کریں', 'बंद करें', 'Isara', 'बन्द गर्नुहोस्', 'বন্ধ করুন'],
  inv: ['You are ready for an easy group on a Saturday ride', 'حان وقت الانضمام إلى مجموعة سهلة في جولة السبت', 'Vous pouvez rejoindre un groupe facile lors d’une sortie du samedi', 'Ya puedes unirte a un grupo fácil en una salida de sábado', 'Você já pode entrar em um grupo fácil em um passeio de sábado', 'اب آپ ہفتے کی سواری کے آسان گروپ میں شامل ہو سکتے ہیں', 'अब आप शनिवार राइड के आसान समूह में शामिल हो सकते हैं', 'Maaari ka nang sumali sa madaling grupo sa Saturday ride', 'अब तपाईं शनिबारे राइडको सजिलो समूहमा सामेल हुन सक्नुहुन्छ', 'এখন আপনি শনিবারের রাইডের সহজ দলে যোগ দিতে পারেন'],
  invGo: ['Join a Saturday ride', 'انضم إلى جولة السبت', 'Rejoindre une sortie du samedi', 'Unirme a una salida de sábado', 'Participar de um passeio de sábado', 'ہفتے کی سواری میں شامل ہوں', 'शनिवार राइड में शामिल हों', 'Sumali sa Saturday ride', 'शनिबारे राइडमा सामेल हुनुहोस्', 'শনিবারের রাইডে যোগ দিন'],
  who: ['Learner', 'المتعلّم', 'Apprenant', 'Alumno', 'Aluno', 'سیکھنے والا', 'शिक्षार्थी', 'Mag-aaral', 'सिक्ने व्यक्ति', 'শিক্ষার্থী'],
  learner: ['Learner {0}', 'المتعلّم {0}', 'Apprenant {0}', 'Alumno {0}', 'Aluno {0}', 'سیکھنے والا {0}', 'शिक्षार्थी {0}', 'Mag-aaral {0}', 'सिक्ने व्यक्ति {0}', 'শিক্ষার্থী {0}'],
  err: ['We could not do that. Please try again.', 'تعذّر ذلك. يرجى المحاولة مرة أخرى.', 'Action impossible. Veuillez réessayer.', 'No se pudo hacer. Inténtalo de nuevo.', 'Não foi possível. Tente novamente.', 'یہ نہیں ہو سکا۔ دوبارہ کوشش کریں۔', 'यह नहीं हो सका। फिर कोशिश करें।', 'Hindi ito nagawa. Pakisubukang muli.', 'यो हुन सकेन। फेरि प्रयास गर्नुहोस्।', 'এটি করা যায়নি। আবার চেষ্টা করুন।'],
};
const LL_LEVELS = 4;
function _lT(k) { const r = LL_T[k] || [], i = LL_LANGS.indexOf(S.lang); return r[i < 0 ? 0 : i] || r[0] || ''; }
function _lF(k, ...v) { return v.reduce((s, x, i) => s.split('{' + i + '}').join(String(x)), _lT(k)); }
function _llCust() { return S.loggedIn || getSession(); }
// The ladder in hand, when it is the signed-in account's own.
function _llD() { const c = _llCust(), m = S._llMine; return c && m && m.forId === c.id && m.d && Array.isArray(m.d.learners) && Array.isArray(m.d.skills) ? m.d : null; }
function _llSkName(s) { const n = (s && s.name) || {}; return String(n[S.lang] || n.en || ''); }
// A learner's name: the account's own for the person who signed up, the name the sign-up gave for anyone else.
function _llName(L, i) { const c = _llCust(), n = L && L.who === 'self' ? c && c.name : L && L.name; return String(n || '') || _lF('learner', i + 1); }
// A learner's four levels: the level's skills, how many are ticked, and when its last tick was given (complete when all are).
function _llLevels(d, L) {
  const tk = (L && L.ticked && typeof L.ticked === 'object' && L.ticked) || {}, out = [];
  for (let n = 1; n <= LL_LEVELS; n++) {
    const sk = d.skills.filter((s) => s && s.level === n), on = sk.filter((s) => tk[s.key]);
    const done = sk.length > 0 && on.length === sk.length;
    out.push({ n, sk, tk, on: on.length, done, at: done ? on.map((s) => String(tk[s.key])).sort().pop() : '' });
  }
  return out;
}
function _llIdx(d) { return Math.max(0, Math.min(d.learners.length - 1, Number(S._llAt) || 0)); }

// ── The pop-up ────────────────────────────────────────────────────────────────────────────────────
// keep: a repaint of the pop-up that is already open (a fresh read landed, a learner picked, a certificate drawn). It
// changes only what is inside the box: the box stays the same element, so it does not settle in a second time and a
// rider reading the lower levels keeps their place.
function _llRender(keep) {
  const host = document.getElementById('confirm-modal'), d = _llD(), open = !!document.getElementById('ll-box');
  if (!host || (keep && !open)) return;
  if (!d || !d.learners.length) { if (open) _llClose(); return; }
  if (!keep) { S._llAt = 0; _llCertDrop(); }
  const i = _llIdx(d), L = d.learners[i], lv = _llLevels(d, L), c = S._llCert && S._llCert.i === i ? S._llCert : null;
  const body = c ? _llCertHtml(c, lv[c.n - 1]) : _llLadderHtml(d, i, L, lv), at = keep && document.getElementById('ll-body');
  if (at) { at.innerHTML = body; return; }
  host.style.display = 'block';
  host.innerHTML = `<div class="modal-backdrop" data-on-click="${_on('_llBackdrop', _EV, _EL)}">
    <div class="modal-box ll-box" id="ll-box" role="dialog" aria-modal="true" aria-labelledby="ll-title">
      <div class="ll-head"><h2 class="ll-title" id="ll-title" tabindex="-1">${esc(_lT('title'))}</h2>
        <button type="button" class="chrome-xt x-close ll-x" aria-label="${esc(_lT('close'))}" data-on-click="${_on('_llClose')}">&times;</button></div>
      <div id="ll-body">${body}</div>
    </div></div>`;
  if (!keep) { const h = document.getElementById('ll-title'); if (h) try { h.focus({ preventScroll: true }); } catch (_) {} }
  // What staff ticked since the Account page read it: asked again when the copy is older than a moment, painted when it lands.
  if (!keep && S._llMine && Date.now() - (S._llMine.at || 0) > 2e4) _llMineLoad(_llCust(), true);
}
function _llLadderHtml(d, i, L, lv) {
  const who = d.learners.length > 1 ? `<div class="ll-who" role="group" aria-label="${esc(_lT('who'))}">${d.learners.map((x, k) =>
    `<button type="button" class="ll-who-b${k === i ? ' on' : ''}" aria-pressed="${k === i ? 'true' : 'false'}" data-on-click="${_on('_llPick', k)}"><bdi>${esc(_llName(x, k))}</bdi></button>`).join('')}</div>` : '';
  const fb = String((L && L.feedback) || '').trim();
  const all = lv.every((x) => x.done);
  return `${who}
    ${fb ? `<div class="ll-fb"><span class="ll-k">${esc(_lT('fb'))}</span><p class="ll-fb-t"><bdi>${esc(fb)}</bdi></p></div>` : ''}
    <ol class="ll-lvs">${lv.map((x) => `<li class="ll-lv${x.done ? ' done' : ''}" data-ll-level="${x.n}">
      <div class="ll-lv-h"><span class="ll-lv-n" aria-hidden="true">${x.n}</span><strong class="ll-lv-t">${esc(_lT('lv' + x.n))}</strong><span class="ll-lv-c"><bdi dir="ltr">${x.on}/${x.sk.length}</bdi></span></div>
      <ul class="ll-sks">${x.sk.map((s) => { const on = !!x.tk[s.key]; return `<li class="ll-sk${on ? ' on' : ''}" data-ll-skill="${esc(s.key)}"><span class="ll-sk-i" aria-hidden="true">${on ? _cuIc('tick', 14) : ''}</span><span class="ll-sk-n">${esc(_llSkName(s))}</span>${on ? `<span class="sr-only">${esc(_lT('got'))}</span>` : `<span class="ll-prac">${esc(_lT('prac'))}</span>`}</li>`; }).join('')}</ul>
      ${x.done ? `<button type="button" class="btn-secondary ll-cert-b" data-on-click="${_on('_llCertOpen', x.n)}">${_cuIc('doc', 18)}<span>${esc(_lT('cert'))}</span></button>` : ''}
    </li>`).join('')}</ol>
    ${all ? `<div class="ll-inv"><strong class="ll-inv-t">${esc(_lT('inv'))}</strong><button type="button" class="btn-primary ll-inv-b" data-on-click="${_on('_llInvite')}">${esc(_lT('invGo'))}</button></div>` : ''}`;
}
function _llBackdrop(event, el) { if (event.target === el) _llClose(); }
function _llClose() { _llCertDrop(); closeConfirm(); }
function _llPick(k) { const d = _llD(); if (!d) return; S._llAt = k; _llCertDrop(); _llRender(true); }
// The whole ladder done: the Saturday ride, through the app's own gate (a member lands on the rides to book, anyone else is
// shown how to apply).
function _llInvite() { _llClose(); selectEvent('community'); }

// ── A level's certificate ─────────────────────────────────────────────────────────────────────────
// Drawn when it opens (sharing a file must follow the tap at once): 1080 x 1350, the learner's own name, the level and the
// day its last skill was ticked. Arabic and Urdu draw right to left.
function _llCertDrop() { const c = S._llCert; S._llCert = null; if (c && c.url) try { URL.revokeObjectURL(c.url); } catch (_) {} }
// A view the rider asked for (a certificate, the ladder again) starts at its top; every other repaint keeps the place.
function _llTop() { const b = document.getElementById('ll-box'); if (b) b.scrollTop = 0; }
function _llCertOpen(n) {
  const d = _llD(); if (!d) return;
  const i = _llIdx(d), L = d.learners[i], x = _llLevels(d, L)[n - 1];
  if (!x || !x.done) return;
  _llCertDrop();
  const c = S._llCert = { i, n, file: null, url: '', err: false };
  _llRender(true); _llTop();
  _llCertDraw(c, _llName(L, i), x);
}
function _llCertBack() { _llCertDrop(); _llRender(true); _llTop(); }
function _llCanShare(f) { try { return !!(f && navigator.share && navigator.canShare && navigator.canShare({ files: [f] })); } catch (_) { return false; } }
function _llCertHtml(c, x) {
  const nm = _lT('lv' + c.n);
  return `<div class="ll-certv" data-ll-cert="${c.n}">
    ${c.url ? `<img class="ll-cert-img" src="${esc(c.url)}" width="1080" height="1350" alt="${esc(_lF('certAlt', nm))}">`
      : c.err ? `<p class="ll-err" role="alert">${esc(_lT('err'))}</p>`
        : `<div class="ll-cert-ph" role="status" aria-label="${esc(_lT('wait'))}"></div>`}
    ${c.url ? `<div class="ll-cert-acts"><a class="btn-primary ll-save" href="${esc(c.url)}" download="micromobility-learn-to-ride-level-${c.n}.png">${esc(_lT('save'))}</a>${_llCanShare(c.file) ? `<button type="button" class="btn-secondary ll-share" data-on-click="${_on('_llCertShare')}">${esc(_lT('share'))}</button>` : ''}</div>` : ''}
    <button type="button" class="btn-secondary ll-wide ll-back" data-on-click="${_on('_llCertBack')}">${esc(_lT('back'))}</button></div>`;
}
// One line, made smaller until it fits the width.
function _llFit(x, text, y, weight, size, fam, max) {
  let px = size;
  do { x.font = `${weight} ${px}px ${fam}`; px -= 4; } while (px > 24 && x.measureText(text).width > max);
  x.fillText(text, 540, y);
}
async function _llCertDraw(c, name, lv) {
  try {
    const cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1350;
    const x = cv.getContext('2d'); if (!x) throw new Error('2d');
    const fam = getComputedStyle(document.body).fontFamily || 'sans-serif', rtl = S.lang === 'ar' || S.lang === 'ur';
    const lri = String.fromCharCode(0x2066), pdi = String.fromCharCode(0x2069); // a number keeps its own direction
    try { await Promise.all(['700 96px', '600 48px', '400 40px'].map((w) => document.fonts.load(`${w} ${fam}`))); } catch (_) {}
    x.direction = rtl ? 'rtl' : 'ltr'; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
    x.fillStyle = '#0b0e0a'; x.fillRect(0, 0, 1080, 1350);
    x.strokeStyle = '#03ff89'; x.lineWidth = 4; x.strokeRect(48, 48, 984, 1254);
    x.fillStyle = '#03ff89'; x.font = `600 48px ${fam}`; x.fillText('MicroMobility', 540, 200);
    x.fillStyle = '#b8c2bb'; _llFit(x, _lT('title'), 270, 400, 40, fam, 880);
    x.fillStyle = '#ffffff'; _llFit(x, _lT('cert'), 480, 700, 96, fam, 880);
    x.fillStyle = '#b8c2bb'; _llFit(x, _lF('lvOf', lri + lv.n + pdi, lri + LL_LEVELS + pdi), 600, 600, 44, fam, 880);
    x.fillStyle = '#03ff89'; _llFit(x, _lT('lv' + lv.n), 730, 700, 88, fam, 880);
    x.fillStyle = '#ffffff'; _llFit(x, name, 940, 700, 72, fam, 880);
    const day = lv.at && isFinite(Date.parse(lv.at)) ? shortDate(_ksaYmd(lv.at)) : '';
    if (day) { x.fillStyle = '#d7ded9'; _llFit(x, day, 1030, 400, 40, fam, 880); }
    x.fillStyle = '#7f8a83'; x.font = `400 34px ${fam}`; x.fillText('experiences.micromobility.sa', 540, 1230);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    if (!blob) throw new Error('toBlob');
    if (S._llCert !== c) return; // closed, or another one opened, while it was drawn
    try { c.file = new File([blob], `micromobility-learn-to-ride-level-${c.n}.png`, { type: 'image/png' }); } catch (_) { c.file = null; }
    c.url = URL.createObjectURL(blob);
  } catch (_) { if (S._llCert === c) c.err = true; }
  if (S._llCert === c) _llRender(true);
}
// Inside the tap, with the file already made: no await before navigator.share.
function _llCertShare() {
  const c = S._llCert; if (!c || !c.file) return;
  try { navigator.share({ files: [c.file] }).catch((e) => { if (!e || e.name !== 'AbortError') toast(_lT('err'), 'error'); }); } catch (_) { toast(_lT('err'), 'error'); }
}
window._llRender = _llRender;
