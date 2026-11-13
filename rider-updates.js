// The Updates page (new features build F3, 2026-11-13): every message the app addressed to this rider, newest first - a
// reminder the evening before, a session that changed, a place off the waitlist, the month's challenge, the Saturday
// recap, a note from staff - each with a short title, its text, its date and where it leads. It is the in-app half of
// "in-app and web push only": the rows are there with push on or off (migration 20261114010300), kept 90 days.
// One read, customer_updates, in the page's language; the read marks every row read, so the rows that were unread show a
// dot this once. A rider reads only their own rows (the database checks their token). No bar, no toast, no hint line.
// A file of its own, fetched when Account > Updates opens (_inbShow in app.src.html), with its own words in all ten
// languages; the words it shares with the page (the tabs' names, Try again) are the page's own, which rider code names
// already. Hand-written, not generated; the build stamps its address (INB_V).
/* global S, sb, esc, t, _on, getSession, shortDate, _cuIc, _dayWord, _ksaYmd, _skelHtml, _rpcAbsent, setCustTab, _parsePath,
   _wlcOk, _wlcOpen, _commNavOn, _hubGo, VOL_PORTAL, _inbMark */
const INB_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
const INB_T = {
  empty: ['No updates yet', 'لا توجد تحديثات بعد', 'Aucune nouveauté pour le moment', 'Aún no hay novedades', 'Ainda não há novidades', 'ابھی کوئی اپ ڈیٹ نہیں', 'अभी कोई अपडेट नहीं', 'Wala pang update', 'अहिलेसम्म कुनै अपडेट छैन', 'এখনও কোনো আপডেট নেই'],
  isNew: ['New', 'جديد', 'Nouveau', 'Nuevo', 'Novo', 'نیا', 'नया', 'Bago', 'नयाँ', 'নতুন'],
  claim: ['Take your place', 'أكّد مكانك', 'Prendre votre place', 'Toma tu plaza', 'Garantir a sua vaga', 'اپنی جگہ لیں', 'अपनी जगह लें', 'Kunin ang puwesto mo', 'आफ्नो ठाउँ लिनुहोस्', 'আপনার জায়গা নিন'],
};
// Each kind of message wears a drawn glyph (the app's own icons).
const INB_IC = { reminder: 'clock', change: 'again', waitlist: 'ticket', challenge: 'flag', recap: 'chart', note: 'chat', info: 'bell' };
function _iT(k) {
  const row = INB_T[k] || [''], i = INB_LANGS.indexOf(S.lang);
  return row[i < 0 ? 0 : i] || row[0];
}
function _inbCust() { return S.loggedIn || getSession(); }
function _inbMine() { const c = _inbCust(), h = S._inbList; return c && h && h.id === c.id ? h : null; }

// ── Where a row leads ─────────────────────────────────────────────────────────────────────────────
// One of the app's own pages ('register', 'myrides', 'account', and 'members' for a member), a freed waitlist place's
// claim ('claim', the pop-up /?claim= opens), the volunteer portal ('vol', a new tab), or nowhere ('').
const INB_TO = { register: 'tabReserve', myrides: 'tabMyRides', account: 'tabAccount', members: 'mbTitle', vol: 'accVolTitle' };
function _inbWhere(url) {
  try {
    const s = String(url || ''); if (!s) return '';
    if (s === VOL_PORTAL || s.startsWith(VOL_PORTAL + '/')) return 'vol';
    const u = new URL(s, location.origin); if (u.origin !== location.origin) return '';
    if (_wlcOk((u.searchParams.get('claim') || '').toLowerCase())) return 'claim';
    const pn = _parsePath(u.pathname);
    if (pn && pn.root) return 'register';
    if (!pn || pn.view !== 'customer' || !INB_TO[pn.ctab] || (pn.ctab === 'members' && !_commNavOn())) return '';
    return pn.ctab;
  } catch (_) { return ''; }
}
function _inbNav(url) {
  const w = _inbWhere(url); if (!w || w === 'vol') return;
  const u = new URL(String(url), location.origin);
  if (w === 'claim') _wlcOpen(u.searchParams.get('claim').toLowerCase());
  else if (w === 'members') _hubGo('link');
  else setCustTab(w, w === 'account' ? (_parsePath(u.pathname) || {}).sub : undefined);
}
// The read marked every row read: the count the page holds (S._inb) goes to none, and with it the dot and the icon's badge.
function _inbSeen(c) {
  let u = S._inb && S._inb.id === c.id ? S._inb : null;
  if (!u) u = S._inb = { id: c.id, ok: false, n: 0, comm: 0, at: 0, asked: 0 };
  u.ok = true; u.n = 0; u.comm = 0; u.at = u.asked = Date.now(); // a count asked before this read lands after it: dropped (asked moved)
  _inbMark();
}

// ── The read ──────────────────────────────────────────────────────────────────────────────────────
// S._inbList: {id, lang, at, rows, fail}. Asked when the page opens, again when its language changes or the copy is a
// minute old. A database before the list answers "no such function": the page is empty, never an error.
async function _inbFetch() {
  const c = _inbCust(); if (!c || !c.session_token || !sb || S._inbBusy) return;
  const lang = S.lang || 'en';
  S._inbBusy = true;
  let r; try { r = await sb.rpc('customer_updates', { p_id: c.id, p_token: c.session_token, p_lang: lang }); } catch (e) { r = { error: e }; }
  S._inbBusy = false;
  const now = _inbCust(); if (!now || now.id !== c.id) return; // signed out, or another account, meanwhile: not theirs
  const d = r && !r.error && r.data, had = _inbMine();
  if (d && d.ok === true && Array.isArray(d.rows)) {
    S._inbList = { id: c.id, lang, at: Date.now(), rows: d.rows };
    _inbSeen(c);
  } else if (r && r.error && _rpcAbsent(r.error)) {
    S._inbList = { id: c.id, lang, at: Date.now(), rows: [] };
  } else {
    S._inbList = { id: c.id, lang: had ? had.lang : lang, at: Date.now(), rows: had ? had.rows : null, fail: true };
  }
  _inbDraw();
}
function _inbRetry() { const h = _inbMine(); if (h) h.fail = false; _inbDraw(); _inbFetch(); }

// ── The page ──────────────────────────────────────────────────────────────────────────────────────
function _inbRender() {
  const c = _inbCust(); if (!c) return;
  if (S._inbList && S._inbList.id !== c.id) S._inbList = null;
  const h = _inbMine();
  _inbDraw();
  if (!h || h.lang !== (S.lang || 'en') || Date.now() - h.at >= 6e4) _inbFetch();
}
function _inbDraw() {
  const body = document.getElementById('inb-body'); if (!body) return;
  const h = _inbMine();
  if (!h || !h.rows) {
    body.innerHTML = h && h.fail
      ? `<div class="inb-card" role="status"><strong>${esc(t('mbErr'))}</strong><button type="button" class="btn-primary" data-on-click="${_on('_inbRetry')}">${esc(t('mbRetry'))}</button></div>`
      : _skelHtml(3, 'inb-skel');
    return;
  }
  if (!h.rows.length) { body.innerHTML = `<div class="inb-card inb-empty" role="status">${_cuIc('bell', 24)}<strong>${esc(_iT('empty'))}</strong></div>`; return; }
  // Keep the focused row across a repaint, found again by what it does.
  const key = (x) => x.getAttribute('data-on-click') || x.getAttribute('href');
  const was = document.activeElement && body.contains(document.activeElement) ? key(document.activeElement) : null;
  body.innerHTML = `<ul class="inb-list">${h.rows.map(_inbRowHtml).join('')}</ul>`;
  if (was) { const el = [...body.querySelectorAll('[data-on-click],a[href]')].find((x) => key(x) === was); if (el) try { el.focus({ preventScroll: true }); } catch (_) {} }
}
// One message: its glyph, its title (with a dot while it is new), its text, then its date and where a tap leads.
function _inbRowHtml(m, i) {
  m = m || {};
  const where = _inbWhere(m.url);
  const day = m.at ? _ksaYmd(m.at) : '', date = /^\d{4}-\d\d-\d\d$/.test(day) ? (_dayWord(day) || shortDate(day)) : '';
  const to = where === 'claim' ? _iT('claim') : where ? t(INB_TO[where]) : '';
  const cls = `inb-row${m.unread ? ' inb-unread' : ''}`;
  const inner = `<span class="inb-ic">${_cuIc(INB_IC[m.kind] || 'bell', 20)}</span>
    <span class="inb-main"><strong class="inb-t"><bdi>${esc(m.title || '')}</bdi>${m.unread ? `<span class="inb-new"><span class="sr-only">${esc(_iT('isNew'))}</span></span>` : ''}</strong>
      ${m.body ? `<span class="inb-b"><bdi>${esc(m.body)}</bdi></span>` : ''}
      <span class="inb-m">${date ? `<bdi>${esc(date)}</bdi>` : ''}${date && to ? ' · ' : ''}${esc(to)}${where === 'vol' ? `<span class="sr-only"> ${esc(t('opensNewTab'))}</span>` : ''}</span></span>
    ${where ? _cuIc('go', 16, 1) : ''}`;
  if (where === 'vol') return `<li><a class="${cls}" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${inner}</a></li>`;
  return where ? `<li><button type="button" class="${cls}" data-on-click="${_on('_inbGo', i)}">${inner}</button></li>` : `<li><div class="${cls}">${inner}</div></li>`;
}
function _inbGo(i) { const h = _inbMine(), m = h && h.rows && h.rows[i]; if (m) _inbNav(m.url); }

window._inbRender = _inbRender;
