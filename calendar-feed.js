// A calendar address of the rider's own (new features build F27, 2026-11-13). The Account row "Calendar" opens this
// pop-up: Add to my calendar (a webcal link the phone's calendar subscribes to), Copy the address (for a calendar
// that takes an address by hand) and Replace the address (a new key; the old address then answers with an empty
// calendar). The address is this site's /api/ics?k=<key> (functions/api/ics.js), which lists the bookings the rider
// still holds on sessions not yet over; the key is the rider's alone (calendar_link, migration 20261114012700) and
// is never put in the page's own address, in storage or in a log.
// A file of its own, fetched only when the row is opened (_calfLoad in app.src.html), with its own words in all ten
// languages. Hand-written, not generated; the build stamps its address (CALF_V). The build's handler, inline-style and
// emoji checks do not read it: no on...= attribute, no style= attribute and no emoji may be written here.
/* global S, sb, esc, _on */
const CALF_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
const CALF_T = {
  title: ['Your bookings in your calendar', 'حجوزاتك في تقويمك', 'Vos réservations dans votre calendrier', 'Tus reservas en tu calendario', 'As suas reservas no seu calendário', 'آپ کی بکنگز آپ کے کیلنڈر میں', 'आपकी बुकिंग आपके कैलेंडर में', 'Ang mga booking mo sa kalendaryo mo', 'तपाईंका बुकिङहरू तपाईंको पात्रोमा', 'আপনার ক্যালেন্ডারে আপনার বুকিং'],
  add: ['Add to my calendar', 'أضف إلى تقويمي', 'Ajouter à mon calendrier', 'Añadir a mi calendario', 'Adicionar ao meu calendário', 'میرے کیلنڈر میں شامل کریں', 'मेरे कैलेंडर में जोड़ें', 'Idagdag sa kalendaryo ko', 'मेरो पात्रोमा थप्नुहोस्', 'আমার ক্যালেন্ডারে যোগ করুন'],
  copy: ['Copy the address', 'نسخ العنوان', 'Copier l’adresse', 'Copiar la dirección', 'Copiar o endereço', 'پتہ کاپی کریں', 'पता कॉपी करें', 'Kopyahin ang address', 'ठेगाना कपी गर्नुहोस्', 'ঠিকানা কপি করুন'],
  copied: ['Address copied', 'تم نسخ العنوان', 'Adresse copiée', 'Dirección copiada', 'Endereço copiado', 'پتہ کاپی ہو گیا', 'पता कॉपी हो गया', 'Nakopya ang address', 'ठेगाना कपी भयो', 'ঠিকানা কপি হয়েছে'],
  replace: ['Replace the address', 'استبدال العنوان', 'Remplacer l’adresse', 'Reemplazar la dirección', 'Substituir o endereço', 'پتہ تبدیل کریں', 'पता बदलें', 'Palitan ang address', 'ठेगाना बदल्नुहोस्', 'ঠিকানা বদলান'],
  askTitle: ['Replace the address?', 'استبدال العنوان؟', 'Remplacer l’adresse ?', '¿Reemplazar la dirección?', 'Substituir o endereço?', 'پتہ تبدیل کریں؟', 'पता बदलें?', 'Palitan ang address?', 'ठेगाना बदल्ने?', 'ঠিকানা বদলাবেন?'],
  askBody: ['The old address stops working. A calendar that uses it will no longer update.', 'سيتوقف العنوان القديم عن العمل، ولن يتحدّث أي تقويم يستخدمه بعد الآن.', 'L’ancienne adresse cessera de fonctionner. Un calendrier qui l’utilise ne se mettra plus à jour.', 'La dirección anterior dejará de funcionar. Un calendario que la use ya no se actualizará.', 'O endereço antigo deixa de funcionar. Um calendário que o utilize deixará de ser atualizado.', 'پرانا پتہ کام کرنا بند کر دے گا۔ جو کیلنڈر اسے استعمال کرتا ہے وہ مزید اپ ڈیٹ نہیں ہوگا۔', 'पुराना पता काम करना बंद कर देगा। जो कैलेंडर उसका इस्तेमाल करता है, वह आगे अपडेट नहीं होगा।', 'Hindi na gagana ang lumang address. Hindi na mag-a-update ang kalendaryong gumagamit nito.', 'पुरानो ठेगानाले काम गर्न छोड्नेछ। त्यो प्रयोग गर्ने पात्रो अब अपडेट हुने छैन।', 'পুরোনো ঠিকানা আর কাজ করবে না। যে ক্যালেন্ডার সেটি ব্যবহার করে, তা আর আপডেট হবে না।'],
  replaced: ['The address is replaced. Add the new one to your calendar.', 'تم استبدال العنوان. أضف العنوان الجديد إلى تقويمك.', 'L’adresse est remplacée. Ajoutez la nouvelle à votre calendrier.', 'La dirección se ha reemplazado. Añade la nueva a tu calendario.', 'O endereço foi substituído. Adicione o novo ao seu calendário.', 'پتہ تبدیل ہو گیا۔ نیا پتہ اپنے کیلنڈر میں شامل کریں۔', 'पता बदल दिया गया। नया पता अपने कैलेंडर में जोड़ें।', 'Napalitan na ang address. Idagdag ang bago sa kalendaryo mo.', 'ठेगाना बदलियो। नयाँ ठेगाना आफ्नो पात्रोमा थप्नुहोस्।', 'ঠিকানা বদলানো হয়েছে। নতুনটি আপনার ক্যালেন্ডারে যোগ করুন।'],
  err: ['We could not do that. Please try again.', 'تعذّر ذلك. يرجى المحاولة مرة أخرى.', 'Action impossible. Veuillez réessayer.', 'No se pudo hacer. Inténtalo de nuevo.', 'Não foi possível. Tente novamente.', 'یہ نہیں ہو سکا۔ دوبارہ کوشش کریں۔', 'यह नहीं हो सका। फिर कोशिश करें।', 'Hindi ito nagawa. Pakisubukang muli.', 'यो हुन सकेन। फेरि प्रयास गर्नुहोस्।', 'এটি করা যায়নি। আবার চেষ্টা করুন।'],
};
const CALF_KEY = /^[0-9a-f]{64}$/;
// The dispatcher's markers (app.src.html _EL, _EV), written here so this file leans on nothing but _on itself.
const _CALF_EL = { '@': 'this' }, _CALF_EV = { '@': 'event' };
function _calfT(k) {
  const row = CALF_T[k] || [''], i = CALF_LANGS.indexOf(S.lang);
  return row[i < 0 ? 0 : i] || row[0];
}
// What the page lends (_calfLoad): its own words this pop-up shows, the signed-in rider, the icons and the centred question.
function _calfDep() { return window._calfDeps || {}; }
function _calfW() { const d = _calfDep(); return (d.words && d.words()) || { kicker: 'Calendar', close: 'Close', retry: 'Try again', loading: 'Loading' }; }
function _calfIc(k, px) { const d = _calfDep(); return d.ic ? d.ic(k, px) : ''; }
// The pop-up is drawn in the Account's own pop-up host, in its box (the Change password pop-up's).
function _calfHost() { return document.getElementById('acc-pwd-modal'); }
// The address without its scheme: this site's /api/ics with the rider's key.
function _calfAddr(key) { return location.host + '/api/ics?k=' + encodeURIComponent(key); }
// The rider's key from the database: 'get' answers it (made on the first ask), 'new' replaces it. '' when it did not come.
function _calfAsk(op) {
  const d = _calfDep(), c = d.cust ? d.cust() : null;
  if (!c || !c.id || !c.session_token || !sb) return Promise.resolve('');
  return Promise.resolve(sb.rpc('calendar_link', { p_id: c.id, p_token: c.session_token, p_lang: S.lang, p_op: op }))
    .then((r) => { const k = r && !r.error && r.data && r.data.ok === true ? String(r.data.key || '') : ''; return CALF_KEY.test(k) ? k : ''; }, () => '');
}
function _calfPaint() {
  const P = S._calfP, m = _calfHost(); if (!P || !m) return;
  const w = _calfW();
  const body = P.key
    ? `<a class="pg-btn" id="calf-add" href="${esc('webcal://' + _calfAddr(P.key))}">${_calfIc('cal', 18)}<span>${esc(_calfT('add'))}</span></a>
      <div class="calf-acts">
        <button type="button" class="btn-secondary" id="calf-copy" data-on-click="${_on('_calfCopy')}">${esc(_calfT('copy'))}</button>
        <button type="button" class="btn-secondary" id="calf-new" data-on-click="${_on('_calfNew')}">${esc(_calfT('replace'))}</button>
      </div>
      <div class="pg-sub calf-note" id="calf-note" role="status"></div>
      <div class="pg-msg" id="calf-err" role="alert"></div>`
    : P.err
      ? `<div class="pg-msg" id="calf-err" role="alert">${esc(_calfT('err'))}</div>
      <button type="button" class="pg-btn" id="calf-retry" data-on-click="${_on('_calfOpen')}">${esc(w.retry)}</button>`
      : `<p class="pg-sub" role="status">${esc(w.loading)}…</p>`;
  m.innerHTML = `<div class="modal-backdrop" data-on-click="${_on('_on_backdropOnly', _CALF_EV, _CALF_EL, '_calfClose')}">
    <div class="pg-box calf-box" role="dialog" aria-modal="true" aria-labelledby="calf-title"${P.key || P.err ? '' : ' aria-busy="true"'}>
      <button type="button" class="ap-x" aria-label="${esc(w.close)}" data-on-click="${_on('_calfClose')}">${_calfIc('close', 20)}</button>
      <div class="pg-kicker">${esc(w.kicker)}</div>
      <h2 id="calf-title" class="pg-title">${esc(_calfT('title'))}</h2>
      ${body}
    </div>
  </div>`;
  m.style.display = 'block';
}
async function _calfOpen() {
  if (!_calfHost()) return;
  const P = { key: '', err: false, busy: false }; S._calfP = P;
  _calfPaint();
  const key = await _calfAsk('get');
  if (S._calfP !== P) return; // closed meanwhile, or opened again
  P.key = key; P.err = !key;
  _calfPaint();
  try { const b = document.getElementById(key ? 'calf-add' : 'calf-retry'); if (b) b.focus({ preventScroll: true }); } catch (_) {}
}
function _calfClose() {
  const m = _calfHost();
  if (m && S._calfP) { m.style.display = 'none'; m.innerHTML = ''; }
  S._calfP = null;
  try { const b = document.getElementById('acc-cal-btn'); if (b) b.focus(); } catch (_) {}
}
// What an action did, said under the buttons. An address that could not be put on the clipboard is shown instead, to copy by hand.
function _calfNote(text, addr) {
  const n = document.getElementById('calf-note'); if (!n) return;
  n.textContent = text || '';
  n.classList.toggle('calf-addr', !!addr);
  if (addr) n.setAttribute('dir', 'ltr'); else n.removeAttribute('dir');
}
function _calfErr(text) { const e = document.getElementById('calf-err'); if (e) e.textContent = text || ''; }
async function _calfCopy() {
  const P = S._calfP; if (!P || !P.key) return;
  const url = location.protocol + '//' + _calfAddr(P.key);
  let ok = false;
  try { await navigator.clipboard.writeText(url); ok = true; } catch (_) {}
  if (S._calfP !== P) return;
  _calfErr('');
  _calfNote(ok ? _calfT('copied') : url, !ok);
}
async function _calfNew() {
  const P = S._calfP, d = _calfDep(); if (!P || !P.key || P.busy || !d.ask) return;
  // the question's title is escaped by the dialog; its body and its button are written as markup, so they are escaped here
  const yes = await d.ask({ title: _calfT('askTitle'), body: esc(_calfT('askBody')), confirmLabel: esc(_calfT('replace')), confirmClass: 'btn-primary' });
  if (!yes || S._calfP !== P) return;
  const lock = (on) => { P.busy = on; ['calf-copy', 'calf-new'].forEach((id) => { const b = document.getElementById(id); if (b) b.disabled = on; }); };
  lock(true); _calfErr(''); _calfNote('');
  const key = await _calfAsk('new');
  if (S._calfP !== P) return;
  lock(false);
  if (!key) { _calfErr(_calfT('err')); return; }
  P.key = key;
  const a = document.getElementById('calf-add'); if (a) a.setAttribute('href', 'webcal://' + _calfAddr(key));
  _calfNote(_calfT('replaced'));
  try { const b = document.getElementById('calf-new'); if (b) b.focus({ preventScroll: true }); } catch (_) {}
}
window._calfOpen = _calfOpen;
