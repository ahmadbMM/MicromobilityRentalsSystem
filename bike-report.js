// Report a bike problem (new features build F15, 2026-11-13; the owner marked it Build now). The ticket of a rider who is
// checked in with a bike carries one button (_brpHtml in app.src.html); this file is its pop-up: a short list of faults
// as real radios, an optional short note, and Send. A booking with several bikes asks which one first (the account's own
// riders only). bike_report (migration 20261114081500) takes it for the rider's own booking, from check-in until 3 hours
// after the session, and refuses a second one within its limits: the pop-up closes on that refusal exactly as on a report
// taken, and the ticket shows the same quiet chip. Nothing is said after sending (the owner: no bar after an action).
// A file of its own, fetched on the first tap (_brpOpen in app.src.html), with its own words in all ten languages.
// Hand-written, not generated; the build stamps its address (BRP_V).
/* global S, sb, esc, _on, _EV, _EL, getSession, getQueue */
const BRP_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
// The faults, as the database names them (bike_reports.fault).
const BRP_FAULTS = ['brakes', 'gears', 'tyre', 'chain', 'saddle', 'lights', 'other'];
const BRP_T = {
  bike: ['Bike', 'الدراجة', 'Vélo', 'Bici', 'Bicicleta', 'سائیکل', 'साइकिल', 'Bike', 'साइकल', 'সাইকেল'],
  brakes: ['Brakes', 'المكابح', 'Freins', 'Frenos', 'Travões', 'بریک', 'ब्रेक', 'Preno', 'ब्रेक', 'ব্রেক'],
  gears: ['Gears', 'ناقل السرعات', 'Vitesses', 'Cambios', 'Mudanças', 'گیئر', 'गियर', 'Gear', 'गियर', 'গিয়ার'],
  tyre: ['Tyre', 'الإطار', 'Pneu', 'Neumático', 'Pneu', 'ٹائر', 'टायर', 'Gulong', 'टायर', 'টায়ার'],
  chain: ['Chain', 'السلسلة', 'Chaîne', 'Cadena', 'Corrente', 'چین', 'चेन', 'Kadena', 'चेन', 'চেইন'],
  saddle: ['Saddle', 'المقعد', 'Selle', 'Sillín', 'Selim', 'سیٹ', 'सीट', 'Upuan', 'सिट', 'সিট'],
  lights: ['Lights', 'الأضواء', 'Éclairage', 'Luces', 'Luzes', 'لائٹس', 'लाइट', 'Ilaw', 'बत्ती', 'লাইট'],
  other: ['Other', 'أخرى', 'Autre', 'Otro', 'Outro', 'دیگر', 'अन्य', 'Iba pa', 'अन्य', 'অন্যান্য'],
  note: ['Note (optional)', 'ملاحظة (اختياري)', 'Note (facultatif)', 'Nota (opcional)', 'Nota (opcional)', 'نوٹ (اختیاری)', 'नोट (वैकल्पिक)', 'Tala (opsyonal)', 'टिप्पणी (ऐच्छिक)', 'নোট (ঐচ্ছিক)'],
  send: ['Send report', 'إرسال البلاغ', 'Envoyer le signalement', 'Enviar aviso', 'Enviar aviso', 'اطلاع بھیجیں', 'रिपोर्ट भेजें', 'Ipadala ang report', 'रिपोर्ट पठाउनुहोस्', 'রিপোর্ট পাঠান'],
  close: ['Close', 'إغلاق', 'Fermer', 'Cerrar', 'Fechar', 'بند کریں', 'बंद करें', 'Isara', 'बन्द गर्नुहोस्', 'বন্ধ করুন'],
  pick: ['Choose what is wrong.', 'اختر نوع المشكلة.', 'Choisissez le problème.', 'Elige el problema.', 'Escolha o problema.', 'خرابی منتخب کریں۔', 'समस्या चुनें।', 'Piliin ang problema.', 'समस्या छान्नुहोस्।', 'সমস্যাটি বেছে নিন।'],
  err: ['We could not send it. Please try again.', 'تعذّر الإرسال. يرجى المحاولة مرة أخرى.', 'Envoi impossible. Veuillez réessayer.', 'No se pudo enviar. Inténtalo de nuevo.', 'Não foi possível enviar. Tente novamente.', 'بھیجا نہیں جا سکا۔ دوبارہ کوشش کریں۔', 'भेजा नहीं जा सका। फिर कोशिश करें।', 'Hindi naipadala. Pakisubukang muli.', 'पठाउन सकिएन। फेरि प्रयास गर्नुहोस्।', 'পাঠানো যায়নি। আবার চেষ্টা করুন।'],
};
function _brpT(k) {
  const r = BRP_T[k] || [], i = BRP_LANGS.indexOf(S.lang);
  return r[i < 0 ? 0 : i] || r[0] || '';
}
// The pop-up's host, made on first use (a [data-host], as every dialog of the page is drawn into one).
function _brpHost() {
  let m = document.getElementById('brp-modal');
  if (!m) { m = document.createElement('div'); m.id = 'brp-modal'; m.setAttribute('data-host', ''); document.body.appendChild(m); }
  return m;
}
function _brpClose() {
  const m = document.getElementById('brp-modal');
  if (m) { m.style.display = 'none'; m.innerHTML = ''; }
  S._brp = null;
}
function _brpBack(event, el) { if (event.target === el) _brpClose(); }
function _brpErr(msg) { const el = document.getElementById('brp-err'); if (el) el.textContent = msg || ''; }
function _brpBike(i) { if (S._brp) S._brp.i = i; }
function _brpFault(k) { if (S._brp) { S._brp.fault = k; _brpErr(''); } }
// Opens the pop-up for the booking a ticket's button names: every bike the account's own riders hold on that session
// now, as the ticket reads them (dep.rows is the ticket's own rule for who may report).
function _brpShow(id) {
  const dep = window._brpDeps || {}, c = S.loggedIn || getSession();
  if (!c || !c.session_token || !dep.rows) return;
  const e0 = getQueue().find((e) => e.id === id);
  if (!e0) return;
  const rows = dep.rows(dep.sess(e0.sessionId), getQueue().filter((e) => e.customerId === c.id && e.sessionId === e0.sessionId));
  const opts = [];
  rows.forEach((e) => dep.bikes(e).forEach((b) => opts.push({ id: e.id, bike: b.id, name: b.name || '', who: e.name || '' })));
  if (!opts.length) { if (dep.paint) dep.paint(); return; }
  S._brp = { opts, i: 0, fault: '', busy: false };
  const several = new Set(opts.map((o) => o.id)).size > 1;
  const pill = (name, v, label, fn, on) => `<label class="brp-opt"><input type="radio" name="${name}" value="${esc(v)}"${on ? ' checked' : ''} data-on-change="${_on(fn, v)}"><span>${label}</span></label>`;
  const m = _brpHost();
  m.style.display = 'flex';
  m.innerHTML = `<div class="modal-backdrop" data-on-click="${_on('_brpBack', _EV, _EL)}">
    <div class="modal-box brp-box" role="dialog" aria-modal="true" aria-labelledby="brp-title">
      <div class="modal-title" id="brp-title">${esc(dep.label ? dep.label() : '')}</div>
      ${opts.length > 1 ? `<div class="brp-lbl brp-lbl-top" id="brp-bike-lbl">${_brpT('bike')}</div>
      <div class="brp-opts brp-bikes" role="radiogroup" aria-labelledby="brp-bike-lbl">${opts.map((o, i) => pill('brp-bike', i, `<bdi>${esc(o.name)}</bdi>${several && o.who ? ` · <bdi>${esc(o.who)}</bdi>` : ''}`, '_brpBike', i === 0)).join('')}</div>` : ''}
      <div class="brp-opts" role="radiogroup" aria-labelledby="brp-title">${BRP_FAULTS.map((k) => pill('brp-fault', k, _brpT(k), '_brpFault', false)).join('')}</div>
      <label class="brp-lbl" for="brp-note">${_brpT('note')}</label>
      <textarea id="brp-note" class="brp-ta" maxlength="300" rows="2"></textarea>
      <div id="brp-err" class="brp-err" role="alert"></div>
      <div class="brp-acts">
        <button type="button" class="btn-primary brp-send" data-on-click="${_on('_brpSend')}">${_brpT('send')}</button>
        <button type="button" class="btn-secondary brp-close" data-on-click="${_on('_brpClose')}">${_brpT('close')}</button>
      </div>
    </div>
  </div>`;
}
async function _brpSend() {
  const B = S._brp, dep = window._brpDeps || {}, c = S.loggedIn || getSession();
  if (!B || B.busy || !c || !c.session_token) return;
  if (!B.fault) { _brpErr(_brpT('pick')); return; }
  const o = B.opts[B.i] || B.opts[0], ta = document.getElementById('brp-note'), btn = document.querySelector('#brp-modal .brp-send');
  const note = ta ? ta.value.trim().slice(0, 300) : '';
  B.busy = true; _brpErr('');
  if (btn) btn.disabled = true;
  let r;
  try { r = await sb.rpc('bike_report', { p_id: c.id, p_token: c.session_token, p_booking: o.id, p_fault: B.fault, p_note: note || null, p_bike: o.bike }); } catch (e) { r = { error: e }; }
  if (S._brp !== B) return; // closed meanwhile
  B.busy = false;
  const d = r && !r.error ? r.data : null, row = getQueue().find((e) => e.id === o.id), now = new Date().toISOString();
  if (r && r.error && dep.absent && dep.absent(r.error)) S._brpOff = true; // a database without the function: the button goes, without a word
  else if (d && d.ok === true) { if (row) row.bikeReportAt = d.at || now; }
  else if (d && d.error === 'limit') { if (row) row.bikeReportAt = now; } // refused quietly: the same chip as after a report taken
  else if (d && (d.error === 'none' || d.error === 'closed')) {
    // the bike left the booking, or the time to report is over: what the server knows wins
    _brpClose();
    try { if (dep.reload) await dep.reload(); } catch (_) {}
    if (dep.paint) dep.paint();
    return;
  } else {
    if (btn) btn.disabled = false;
    _brpErr(_brpT('err'));
    return;
  }
  _brpClose();
  if (dep.paint) dep.paint();
}
window._brpShow = _brpShow;
