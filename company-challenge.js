// Account > Company challenge (new features build F26; the owner marked it Build now on 2026-11-13). A company's people
// ride towards one number: staff make the challenge and hand out its code, the rider types it here (or opens a link that
// holds it, /?company=CODE, kept on the device by the page until they are signed in) and sees one card per challenge:
// how many are taking part and how many sessions they finished together, only once the people taking part reach the
// challenge's minimum team size (the database sends neither number before), and their own count. Members see nobody
// (2026-11-04): nothing here names a colleague or holds one colleague's count, and the database sends none.
// Everything comes from company_challenge_mine and company_challenge_join (migration 20261114012600), kept in S._coch.
// A file of its own, fetched only when this page opens (_cochOpen in app.src.html), with its own words in all ten
// languages. Hand-written, not generated; the build stamps its address (COCH_V).
/* global S, sb, esc, _on, _P, _EV, getSession, shortDate, _bdgMedal, _cuIc */
const COCH_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
const COCH_T = {
  code: ['Company code', 'رمز الشركة', 'Code de l’entreprise', 'Código de la empresa', 'Código da empresa', 'کمپنی کوڈ', 'कंपनी कोड', 'Code ng kumpanya', 'कम्पनी कोड', 'কোম্পানি কোড'],
  join: ['Join', 'انضم', 'Rejoindre', 'Unirme', 'Participar', 'شامل ہوں', 'जुड़ें', 'Sumali', 'सामेल हुनुहोस्', 'যোগ দিন'],
  errCode: ['We do not know this code. Check it and try again.', 'هذا الرمز غير معروف. تحقق منه وحاول مرة أخرى.', 'Ce code nous est inconnu. Vérifiez-le et réessayez.', 'No reconocemos este código. Revísalo e inténtalo de nuevo.', 'Não reconhecemos este código. Verifique e tente novamente.', 'ہم اس کوڈ کو نہیں پہچانتے۔ اسے چیک کر کے دوبارہ کوشش کریں۔', 'हम इस कोड को नहीं पहचानते। इसे जाँचकर फिर कोशिश करें।', 'Hindi namin kilala ang code na ito. Suriin ito at subukang muli.', 'हामी यो कोड चिन्दैनौँ। जाँचेर फेरि प्रयास गर्नुहोस्।', 'আমরা এই কোডটি চিনতে পারছি না। দেখে নিয়ে আবার চেষ্টা করুন।'],
  errEnded: ['This challenge has ended.', 'انتهى هذا التحدي.', 'Ce défi est terminé.', 'Este reto ha terminado.', 'Este desafio terminou.', 'یہ چیلنج ختم ہو چکا ہے۔', 'यह चुनौती खत्म हो चुकी है।', 'Tapos na ang hamong ito.', 'यो चुनौती सकिसकेको छ।', 'এই চ্যালেঞ্জ শেষ হয়ে গেছে।'],
  errBusy: ['Too many tries. Please wait ten minutes.', 'محاولات كثيرة. يرجى الانتظار عشر دقائق.', 'Trop de tentatives. Veuillez patienter dix minutes.', 'Demasiados intentos. Espera diez minutos.', 'Muitas tentativas. Aguarde dez minutos.', 'بہت زیادہ کوششیں۔ براہ کرم دس منٹ انتظار کریں۔', 'बहुत ज़्यादा कोशिशें। कृपया दस मिनट रुकें।', 'Masyadong maraming subok. Pakihintay ng sampung minuto.', 'धेरै प्रयास भयो। कृपया दस मिनेट पर्खनुहोस्।', 'অনেকবার চেষ্টা করা হয়েছে। অনুগ্রহ করে দশ মিনিট অপেক্ষা করুন।'],
  err: ['We could not do that. Please try again.', 'تعذّر ذلك. يرجى المحاولة مرة أخرى.', 'Action impossible. Veuillez réessayer.', 'No se pudo hacer. Inténtalo de nuevo.', 'Não foi possível. Tente novamente.', 'یہ نہیں ہو سکا۔ دوبارہ کوشش کریں۔', 'यह नहीं हो सका। फिर कोशिश करें।', 'Hindi ito nagawa. Pakisubukang muli.', 'यो हुन सकेन। फेरि प्रयास गर्नुहोस्।', 'এটি করা যায়নি। আবার চেষ্টা করুন।'],
  team: ['Taking part', 'المشاركون', 'Participants', 'Participantes', 'Participantes', 'شرکاء', 'प्रतिभागी', 'Mga kasali', 'सहभागी', 'অংশগ্রহণকারী'],
  together: ['Sessions together', 'جلساتكم معًا', 'Séances ensemble', 'Sesiones en conjunto', 'Sessões em conjunto', 'مل کر مکمل سیشن', 'मिलकर पूरे किए सत्र', 'Mga session nang sama-sama', 'सँगै पूरा गरेका सत्र', 'একসাথে সম্পন্ন সেশন'],
  mine: ['Your sessions', 'جلساتك', 'Vos séances', 'Tus sesiones', 'As suas sessões', 'آپ کے سیشن', 'आपके सत्र', 'Mga session mo', 'तपाईंका सत्र', 'আপনার সেশন'],
  soon: ['Upcoming', 'قريبًا', 'À venir', 'Próximamente', 'Em breve', 'جلد شروع', 'जल्द शुरू', 'Paparating', 'छिट्टै सुरु', 'শিগগিরই শুরু'],
  ended: ['Ended', 'انتهى', 'Terminé', 'Finalizado', 'Encerrado', 'ختم', 'समाप्त', 'Tapos na', 'सकियो', 'শেষ'],
  badge: ['Badge earned', 'حصلت على الوسام', 'Badge obtenu', 'Insignia conseguida', 'Conquista obtida', 'بیج حاصل ہوا', 'बैज मिला', 'Nakuha ang badge', 'ब्याज प्राप्त भयो', 'ব্যাজ অর্জিত'],
};
function _cochT(k) {
  const r = COCH_T[k] || [], i = COCH_LANGS.indexOf(S.lang);
  return r[i < 0 ? 0 : i] || r[0] || '';
}
// What the page holds between paints: the code being typed, the refusal under it, and a join on its way.
const _cochSt = { busy: false, err: '', code: '', at: null };

function _cochRows() {
  const c = S.loggedIn || getSession(), m = S._coch;
  return c && m && m.id === c.id && Array.isArray(m.rows) ? m.rows : null;
}
function _cochClean(v) { return String(v == null ? '' : v).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12); }
function _cochNum(n, label, k) {
  return `<div class="coch-num" data-coch-n="${k}"><strong><bdi>${esc(String(n))}</bdi></strong><span>${esc(label)}</span></div>`;
}
// One challenge. The two totals are drawn only when the database sent them (it does from the minimum team size up); the
// rider's own count always. The badge every finisher gets at the end is shown from the start, in full once it is theirs.
function _cochCardHtml(r) {
  const tot = typeof r.team === 'number' && typeof r.sessions === 'number';
  const st = r.state === 'ended' ? _cochT('ended') : r.state === 'soon' ? _cochT('soon') : '';
  const name = window._cochDeps && window._cochDeps.badge ? window._cochDeps.badge() : '';
  const medal = typeof _bdgMedal === 'function' ? _bdgMedal('briefcase', 'blue', 'coch-medal') : '';
  return `<section class="form-section acc-pg-card coch-card" data-coch="${esc(String(r.id))}" aria-labelledby="coch-n-${esc(String(r.id))}">
    <div class="coch-head"><h3 class="coch-name" id="coch-n-${esc(String(r.id))}" tabindex="-1"><bdi>${esc(r.company || '')}</bdi></h3>${st ? `<span class="coch-st">${esc(st)}</span>` : ''}</div>
    <div class="coch-dates"><bdi>${esc(shortDate(r.starts_on))} – ${esc(shortDate(r.ends_on))}</bdi></div>
    <div class="coch-nums">${tot ? _cochNum(r.team, _cochT('team'), 'team') + _cochNum(r.sessions, _cochT('together'), 'sessions') : ''}${_cochNum(Number(r.mine) || 0, _cochT('mine'), 'mine')}</div>
    <div class="coch-badge${r.badge ? ' coch-won' : ''}">${medal}<span class="coch-badge-n">${esc(name)}</span>${r.badge ? `<span class="coch-badge-ok">${_cuIc('tick', 14)}${esc(_cochT('badge'))}</span>` : ''}</div>
  </section>`;
}
function _cochJoinHtml() {
  const st = _cochSt;
  return `<div class="form-section acc-pg-card coch-join">
    <div class="form-group"><label for="coch-code">${esc(_cochT('code'))}</label>
      <input type="text" id="coch-code" maxlength="12" dir="ltr" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(st.code)}" data-on-input="${_on('_cochCodeIn', _P('value'))}" data-on-keydown="${_on('_cochKey', _EV)}"></div>
    <div id="coch-err" class="cu-acc-err" role="alert">${esc(st.err)}</div>
    <button type="button" class="btn-primary acc-save" id="coch-join"${st.busy ? ' disabled' : ''} data-on-click="${_on('_cochJoin')}">${esc(_cochT('join'))}</button>
  </div>`;
}
function _cochCodeIn(v) { _cochSt.code = String(v == null ? '' : v); }
function _cochKey(ev) { if (ev && ev.key === 'Enter') { ev.preventDefault(); _cochJoin(); } }
async function _cochJoin(code) {
  const c = S.loggedIn || getSession(), st = _cochSt;
  if (!c || !c.session_token || !sb || st.busy) return;
  const k = _cochClean(code == null ? st.code : code);
  if (k.length < 4) { st.err = _cochT('errCode'); _cochRender(); return; }
  st.busy = true; st.err = ''; st.code = k; _cochRender();
  let r;
  try { r = await sb.rpc('company_challenge_join', { p_id: c.id, p_token: c.session_token, p_code: k }); } catch (e) { r = { error: e }; }
  st.busy = false;
  const d = r && !r.error ? r.data : null, now = S.loggedIn || getSession();
  if (!now || now.id !== c.id) return; // signed out, or another account, meanwhile
  if (d && d.ok === true && Array.isArray(d.rows)) {
    S._coch = { id: c.id, busy: false, at: Date.now(), rows: d.rows, open: d.open === true };
    st.code = ''; st.err = ''; st.at = d.joined == null ? null : d.joined;
    if (window._cochDeps && window._cochDeps.rows) window._cochDeps.rows(); // the menu row's company
  } else {
    const e = d && d.error;
    st.err = _cochT(e === 'ended' ? 'errEnded' : e === 'busy' ? 'errBusy' : e === 'code' ? 'errCode' : 'err');
  }
  _cochRender();
}
function _cochRender() {
  const h = document.getElementById('acc-co-host'), rows = _cochRows(), st = _cochSt, D = window._cochDeps || {};
  if (!h || !rows) return;
  // a join link's code, kept by the page until now: joined at once, and off the device whatever the answer
  const parked = D.parked ? D.parked() : '';
  if (parked && !st.busy) { D.park(''); _cochJoin(parked); return; }
  const a = document.activeElement, typing = !!a && a.id === 'coch-code';
  h.innerHTML = rows.map(_cochCardHtml).join('') + _cochJoinHtml();
  if (st.at != null) { // just joined: its card takes the focus, so a screen reader says the company
    const n = document.getElementById('coch-n-' + st.at); st.at = null;
    if (n) try { n.focus({ preventScroll: true }); } catch (_) { /* focus is a courtesy */ }
  } else if (typing) {
    const i = document.getElementById('coch-code');
    if (i) try { i.focus({ preventScroll: true }); i.setSelectionRange(i.value.length, i.value.length); } catch (_) { /* as above */ }
  }
}
window._cochRender = _cochRender;
