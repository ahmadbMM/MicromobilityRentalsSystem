// The lap page (new features build F25, 2026-11-13): what the poster at the start line opens. A circuit challenge is a
// named lap target for a season; its poster is a QR code (the same address can sit on a plain NFC tag) that opens
// experiences.micromobility.sa/?lap=<code>. The app takes the code off the address (_readLapParam in app.src.html), keeps
// the scan with its own key and time, and fetches this file (_lapLoad) - no other rider carries it.
// One call does everything (circuit_lap, migration 20261114082500): the database counts the lap only when the rider is
// signed in, has a checked-in booking on a circuit session running then, and the challenge's minimum time since their
// last lap has passed; otherwise it adds nothing. Either way it answers the rider's OWN count against the target, which
// is all this page shows: no reason, no times, no speeds, no ranking, nothing about anyone else.
// With no signal the scan stays kept in this tab and is sent again when the connection returns, while the page is open;
// it is sent with how long ago it was scanned, so two laps kept offline each count at their own time, and its key means a
// second send is never a second lap. Signed out, the page offers Sign in and counts the scan once the rider is in.
// The pop-up sits under the forced pages (the rating, a waiver), which cover it; the lap is sent whatever is on screen.
// Hand-written, not generated; the build stamps its address (LAP_V). Its words are here, in all ten languages.
/* global S, sb, esc, _on, getSession, _cssv, _cuIc, _bdgMedal, _sbReady, openAuthModal, _lapName, _lapStatsPaint, LAP_KEY */
const LAP_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
const LAP_T = {
  title: ['Circuit challenge', 'تحدي الحلبة', 'Défi du circuit', 'Reto del circuito', 'Desafio do circuito', 'سرکٹ چیلنج', 'सर्किट चुनौती', 'Hamon sa circuit', 'सर्किट चुनौती', 'সার্কিট চ্যালেঞ্জ'],
  laps: ['laps', 'لفة', 'tours', 'vueltas', 'voltas', 'چکر', 'लैप', 'lap', 'ल्याप', 'ল্যাপ'],
  ofLaps: ['{0} of {1} laps', '{0} من {1} لفة', '{0} tours sur {1}', '{0} de {1} vueltas', '{0} de {1} voltas', '{1} میں سے {0} چکر', '{1} में से {0} लैप', '{0} sa {1} lap', '{1} मध्ये {0} ल्याप', '{1}টির মধ্যে {0}টি ল্যাপ'],
  counted: ['Lap counted', 'تم احتساب اللفة', 'Tour compté', 'Vuelta contada', 'Volta contada', 'چکر شمار ہو گیا', 'लैप गिन लिया गया', 'Nabilang ang lap', 'ल्याप गणना भयो', 'ল্যাপ গোনা হয়েছে'],
  kept: ['Lap saved. It will be sent when you are back online.', 'تم حفظ اللفة. ستُرسل عند عودة الاتصال.', 'Tour enregistré. Il sera envoyé au retour de la connexion.', 'Vuelta guardada. Se enviará cuando vuelva la conexión.', 'Volta salva. Será enviada quando a conexão voltar.', 'چکر محفوظ ہو گیا۔ کنکشن بحال ہوتے ہی بھیج دیا جائے گا۔', 'लैप सहेज लिया गया। कनेक्शन लौटते ही भेज दिया जाएगा।', 'Na-save ang lap. Ipapadala ito kapag may koneksyon na ulit.', 'ल्याप सुरक्षित भयो। जडान फर्किएपछि पठाइनेछ।', 'ল্যাপ সংরক্ষিত হয়েছে। সংযোগ ফিরে এলে পাঠানো হবে।'],
  done: ['Challenge complete', 'اكتمل التحدي', 'Défi réussi', 'Reto completado', 'Desafio concluído', 'چیلنج مکمل', 'चुनौती पूरी', 'Tapos na ang hamon', 'चुनौती पूरा भयो', 'চ্যালেঞ্জ সম্পূর্ণ'],
  badge: ['Season badge earned', 'حصلت على شارة الموسم', 'Badge de la saison obtenu', 'Insignia de la temporada conseguida', 'Emblema da temporada conquistado', 'سیزن کا بیج حاصل ہو گیا', 'सीज़न का बैज मिल गया', 'Nakuha ang badge ng season', 'सिजनको ब्याज प्राप्त भयो', 'মৌসুমের ব্যাজ অর্জিত'],
  signIn: ['Sign in', 'تسجيل الدخول', 'Se connecter', 'Iniciar sesión', 'Entrar', 'لاگ اِن کریں', 'लॉग इन करें', 'Mag-log in', 'लग इन गर्नुहोस्', 'লগ ইন'], // the app's own words (authLoginBtn): the button opens that page
  close: ['Close', 'إغلاق', 'Fermer', 'Cerrar', 'Fechar', 'بند کریں', 'बंद करें', 'Isara', 'बन्द गर्नुहोस्', 'বন্ধ করুন'],
};
function _lpT(k) {
  const row = LAP_T[k] || [''], i = LAP_LANGS.indexOf(S.lang);
  return row[i < 0 ? 0 : i] || row[0];
}
function _lpF(k, ...v) { return v.reduce((s, x, i) => s.split('{' + i + '}').join(String(x)), _lpT(k)); }

// ── The page's state, and the scans kept in this tab ─────────────────────────────────────────────
// S._lapQ is the list the app read at boot ([{c: code, k: key, t: when}]); sessionStorage holds the same list so a reload
// keeps a scan that was not sent yet. A scan leaves the list the moment the database has answered for it.
const LAP_MAX_AGO = 3600; // seconds: the database counts a scan no older than this, and only shows the count for an older one
function _lpS() { return S._lap || (S._lap = { open: false, st: '', d: null, busy: false, addedN: 0, tick: 0 }); }
function _lpQ() { return Array.isArray(S._lapQ) ? S._lapQ : []; }
function _lpQSet(q) {
  S._lapQ = q;
  try { if (q.length) sessionStorage.setItem(LAP_KEY, JSON.stringify(q)); else sessionStorage.removeItem(LAP_KEY); } catch (_) {}
}
function _lpDrop(k) { _lpQSet(_lpQ().filter((x) => x.k !== k)); }

// While a scan waits: every two seconds a signed-out page looks for the sign-in, and a page with no signal tries again
// every twenty. The moment the connection returns it tries at once.
let _lpTimer = null;
function _lpWatch(on) {
  if (!on) { clearInterval(_lpTimer); _lpTimer = null; return; }
  if (_lpTimer) return;
  _lpTimer = setInterval(() => {
    const L = _lpS();
    if (!_lpQ().length) { _lpWatch(false); return; }
    if (L.st === 'sign') { const c = getSession(); if (c && c.session_token && c.session_token !== L.deniedTok) _lpPump(); return; }
    if (++L.tick % 10 === 0) _lpPump();
  }, 2000);
}
window.addEventListener('online', () => { if (_lpQ().length) _lpPump(); });

// Sends the oldest kept scan; the answer is the rider's own count either way.
async function _lpPump() {
  const L = _lpS();
  if (L.busy) return;
  const q = _lpQ();
  if (!q.length) { _lpWatch(false); return; }
  const c = getSession();
  if (!c || !c.id || !c.session_token || c.session_token === L.deniedTok) { L.st = 'sign'; _lpRender(); _lpWatch(true); return; }
  L.busy = true;
  const s = q[0], ago = Math.max(0, Math.round((Date.now() - s.t) / 1000));
  let r;
  try {
    await _sbReady;
    r = await sb.rpc('circuit_lap', { p_id: c.id, p_token: c.session_token, p_code: s.c, p_add: ago <= LAP_MAX_AGO, p_key: s.k, p_ago: Math.min(ago, LAP_MAX_AGO) });
  } catch (e) { r = { error: e || {} }; }
  L.busy = false;
  const d = r && !r.error ? r.data : null, code = String((r && r.error && r.error.code) || '');
  if (d && d.ok === true) {
    _lpDrop(s.k);
    L.d = d; L.st = 'ok';
    if (d.added) L.addedN++;
    if (L.reopen) { L.reopen = false; L.open = true; }
    if (d.new_badge && S._bdgMine) S._bdgMine.at = 0; // Badges reads the new badge the next time it draws
    S._lapMine = null; // and Stats asks for the count again
    try { _lapStatsPaint(); } catch (_) {}
    _lpRender();
    if (_lpQ().length) _lpPump(); else _lpWatch(false);
    return;
  }
  if (d && d.ok === false && d.error === 'denied') { // this session is no longer good: the scan waits for a sign-in
    L.deniedTok = c.session_token; L.st = 'sign'; _lpRender(); _lpWatch(true);
    return;
  }
  if ((d && d.ok === false) || code === 'PGRST202' || code === '42883' || (code && ago > LAP_MAX_AGO)) {
    // The database answered and will not take this scan (a poster it does not know, a database from before the
    // challenge): the scan is dropped and nothing is said. Any other refusal may pass (the schema cache reloading, a
    // full pool, a timeout): that scan stays kept and is sent again, until it is too old to count.
    _lpDrop(s.k);
    if (_lpQ().length) { _lpPump(); return; }
    _lpWatch(false);
    if (L.d) _lpRender(); else _lapClose();
    return;
  }
  // Not reached (no signal, a request that died), or refused for now: the scan stays kept.
  L.st = 'kept'; _lpRender(); _lpWatch(true);
}

// ── The pop-up ───────────────────────────────────────────────────────────────────────────────────
function _lpRender() {
  const L = _lpS();
  let m = document.getElementById('lap-pop');
  if (!L.open) { if (m) m.remove(); return; }
  if (!m) { m = document.createElement('div'); m.id = 'lap-pop'; m.className = 'lap-pop'; document.body.appendChild(m); }
  const d = L.d, sign = L.st === 'sign', kept = L.st === 'kept' && _lpQ().length > 0;
  const n = d ? Math.max(0, Number(d.n) || 0) : 0, tg = d ? Math.max(1, Number(d.target) || 1) : 1;
  const head = d
    ? `<div class="fx-kicker">${_cuIc('flag', 14)}${esc(_lpT('title'))}</div>
      <h2 id="lap-title" class="pg-title"><bdi>${esc(_lapName(d))}</bdi></h2>
      <div class="lap-n"><bdi class="lap-n-v" id="lap-n">${n}</bdi><span class="lap-n-of"><bdi>/ ${tg}</bdi> ${esc(_lpT('laps'))}</span></div>
      <div class="lap-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${tg}" aria-valuenow="${Math.min(n, tg)}" aria-label="${esc(_lpF('ofLaps', n, tg))}"><i data-cssv="${_cssv({ '--w': Math.min(100, Math.round(n / tg * 100)) + '%' })}"></i></div>
      ${d.badge ? `<div class="lap-badge" id="lap-badge">${_bdgMedal('lapring', 'gold')}<span><b>${esc(_lpT('done'))}</b><small>${esc(_lpT('badge'))}</small></span></div>` : ''}`
    : `<h2 id="lap-title" class="pg-title">${esc(_lpT('title'))}</h2>`;
  const state = kept ? _lpT('kept') : d && L.addedN > 0 ? _lpT('counted') : '';
  m.innerHTML = `<div class="auth-backdrop"><div class="pg-box fx-box lap-box" role="dialog" aria-modal="true" aria-labelledby="lap-title" tabindex="-1">
      ${head}
      <p class="lap-state" id="lap-state" role="status">${esc(state)}</p>
      ${sign ? `<button type="button" class="pg-btn" id="lap-signin" data-on-click="${_on('_lapSignIn')}">${esc(_lpT('signIn'))}</button>` : ''}
      <button type="button" class="${sign ? 'afx-link' : 'pg-btn'}" id="lap-close" data-on-click="${_on('_lapClose')}">${esc(_lpT('close'))}</button>
    </div></div>`;
  if (!L.shown) { L.shown = 1; try { m.querySelector('.lap-box').focus({ preventScroll: true }); } catch (_) {} }
}
// Closed, a kept scan is still sent when the connection returns; it changes Stats and opens nothing.
function _lapClose() { const L = _lpS(); L.open = false; L.shown = 0; _lpRender(); }
// The sign-in takes the screen; the scan is counted, and this page opens again, once the rider is in.
function _lapSignIn() {
  const L = _lpS(); L.open = false; L.shown = 0; L.reopen = true; _lpRender(); _lpWatch(true);
  try { openAuthModal(); } catch (_) {}
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && _lpS().open) _lapClose(); });

// What the app calls when a scan arrives, and once this file has landed.
function _lapOpen() {
  const L = _lpS();
  if (!_lpQ().length && !L.d) return;
  L.open = true;
  _lpRender();
  _lpPump();
}
window._lapOpen = _lapOpen;
