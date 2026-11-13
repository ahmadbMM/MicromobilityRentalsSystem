// Share a badge, a title or a finished challenge as a picture (new features build F12, 2026-11-13; reports/Booking app new
// features and sections.md). A rider taps Share in an earned badge's pop-up, under their title on Account > Badges, or on a
// finished challenge on the Community tab. This file opens the pop-up that follows: the picture, a switch to add the
// rider's first name (off every time it opens), and one button. The picture is drawn here, on the phone, in the year
// recap's look (member-hub.js, _yrPrep): 1080 x 1920, the MicroMobility mark, the badge as the app draws it, its name,
// its level, the day it was earned when the app holds one, and for a member's club things the club's Saturday rides
// (a total of 10 or more only, as the Community tab's own read sends it). Nothing about anyone else, no ticket, no number.
// The button hands the picture alone to the phone's share sheet (no words beside it: some iPhones drop the file when
// text travels with it); where a browser cannot share files it reads Save image and saves the picture instead.
// The picture is made before the button can be tapped, because a phone only opens its share sheet from the tap itself.
// A file of its own, fetched on the first tap (_shrLoad in app.src.html), with its own words in all ten languages.
// Hand-written, not generated; the build stamps its address (SHR_V).
/* global S, esc, _on, _P, getSession, getQueue, _cuIc, _locale, _mrBadgeList, _bdgName, _bdgCol, _bdgMedal, _bdgDay,
   _bdgPopClose, _bdgRode, _ncEntry, _rideKind, _ttName, _hubBdg, BDG_COLORS, toast, _monSub */
const SHR_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
const SHR_T = {
  kBadge: ['Badge earned', 'وسام مكتسب', 'Badge obtenu', 'Insignia conseguida', 'Conquista obtida','بیج حاصل کیا', 'बैज अर्जित', 'Nakuhang badge', 'ब्याज कमाइयो', 'ব্যাজ অর্জিত'],
  kTitle: ['Title', 'لقب', 'Titre', 'Título', 'Título', 'خطاب', 'खिताब', 'Titulo', 'उपाधि', 'উপাধি'],
  kMile: ['Challenge completed', 'تحدٍّ مكتمل', 'Défi réussi', 'Reto completado', 'Desafio concluído', 'چیلنج مکمل', 'चुनौती पूरी', 'Natapos na hamon', 'चुनौती पूरा', 'চ্যালেঞ্জ সম্পন্ন'],
  mFirst: ['First session', 'الجلسة الأولى', 'Première séance', 'Primera sesión', 'Primeira sessão', 'پہلا سیشن', 'पहला सत्र', 'Unang session', 'पहिलो सत्र', 'প্রথম সেশন'],
  mSecond: ['Second session', 'الجلسة الثانية', 'Deuxième séance', 'Segunda sesión', 'Segunda sessão', 'دوسرا سیشن', 'दूसरा सत्र', 'Ikalawang session', 'दोस्रो सत्र', 'দ্বিতীয় সেশন'],
  mBack: ['Back with the club', 'عودة إلى النادي', 'De retour au club', 'De vuelta al club', 'De volta ao clube', 'کلب میں واپسی', 'क्लब में वापसी', 'Balik sa club', 'क्लबमा फिर्ता', 'ক্লাবে ফিরে আসা'],
  mLevel: ['{0} sessions in a month', '{0} جلسات في شهر', '{0} séances en un mois', '{0} sesiones en un mes', '{0} sessões num mês', 'ایک مہینے میں {0} سیشن', 'एक महीने में {0} सत्र', '{0} session sa isang buwan', 'एक महिनामा {0} सत्र', 'এক মাসে {0}টি সেশন'],
  club: ['The club: {0} Saturday rides since {1}', 'النادي: {0} رحلة سبت منذ {1}', 'Le club : {0} sorties du samedi depuis {1}', 'El club: {0} salidas de sábado desde {1}', 'O clube: {0} passeios de sábado desde {1}', 'کلب: {1} سے ہفتے کی {0} سواریاں', 'क्लब: {1} से {0} शनिवार राइड', 'Ang club: {0} Saturday ride mula {1}', 'क्लब: {1} देखि {0} शनिबारे राइड', 'ক্লাব: {1} থেকে শনিবারের {0}টি রাইড'],
  clubN: ['The club: {0} Saturday rides', 'النادي: {0} رحلة سبت', 'Le club : {0} sorties du samedi', 'El club: {0} salidas de sábado', 'O clube: {0} passeios de sábado', 'کلب: ہفتے کی {0} سواریاں', 'क्लब: {0} शनिवार राइड', 'Ang club: {0} Saturday ride', 'क्लब: {0} शनिबारे राइड', 'ক্লাব: শনিবারের {0}টি রাইড'],
  nameSw: ['Include my first name', 'إضافة اسمي الأول', 'Ajouter mon prénom', 'Incluir mi nombre', 'Incluir o meu primeiro nome', 'میرا پہلا نام شامل کریں', 'मेरा पहला नाम जोड़ें', 'Isama ang unang pangalan ko', 'मेरो पहिलो नाम राख्नुहोस्', 'আমার প্রথম নাম যোগ করুন'],
  save: ['Save image', 'حفظ الصورة', 'Enregistrer l’image', 'Guardar imagen', 'Guardar imagem', 'تصویر محفوظ کریں', 'चित्र सहेजें', 'I-save ang larawan', 'तस्बिर सेभ गर्नुहोस्', 'ছবি সেভ করুন'],
  saved: ['Image saved', 'تم حفظ الصورة', 'Image enregistrée', 'Imagen guardada', 'Imagem guardada', 'تصویر محفوظ ہو گئی', 'चित्र सहेजा गया', 'Na-save ang larawan', 'तस्बिर सेभ भयो', 'ছবি সেভ হয়েছে'],
  making: ['Making the image', 'جارٍ تجهيز الصورة', 'Création de l’image', 'Creando la imagen', 'A criar a imagem', 'تصویر تیار ہو رہی ہے', 'चित्र बन रहा है', 'Ginagawa ang larawan', 'तस्बिर बन्दैछ', 'ছবি তৈরি হচ্ছে'],
  err: ['We could not make the image. Please try again.', 'تعذّر تجهيز الصورة. يرجى المحاولة مرة أخرى.', 'Impossible de créer l’image. Veuillez réessayer.', 'No se pudo crear la imagen. Inténtalo de nuevo.', 'Não foi possível criar a imagem. Tente novamente.', 'تصویر نہیں بن سکی۔ دوبارہ کوشش کریں۔', 'चित्र नहीं बन सका। फिर कोशिश करें।', 'Hindi nagawa ang larawan. Pakisubukang muli.', 'तस्बिर बन्न सकेन। फेरि प्रयास गर्नुहोस्।', 'ছবি তৈরি করা যায়নি। আবার চেষ্টা করুন।'],
  retry: ['Try again', 'حاول مرة أخرى', 'Réessayer', 'Reintentar', 'Tentar novamente', 'دوبارہ کوشش کریں', 'फिर कोशिश करें', 'Subukang muli', 'फेरि प्रयास गर्नुहोस्', 'আবার চেষ্টা করুন'],
};
function _sT(k) {
  const row = SHR_T[k] || [''], i = SHR_LANGS.indexOf(S.lang);
  return row[i < 0 ? 0 : i] || row[0];
}
function _sF(k, ...v) { return v.reduce((s, x, i) => s.split('{' + i + '}').join(String(x)), _sT(k)); }
function _sCust() { return S.loggedIn || getSession(); }
// The page's own words for Share, Close and "Level 2 of 4" (lent by _shrDeps.words: the build keeps a word only where
// rider code names it).
function _sWords() { const dep = window._shrDeps || {}; let w = null; try { w = dep.words && dep.words(); } catch (_) {} return w || {}; }
// A number keeps its order inside a right-to-left line: held between the two isolate marks, built from their codes so
// this file carries no invisible character. The picture's alternative text leaves them out.
const _SHR_LRI = String.fromCharCode(0x2066), _SHR_PDI = String.fromCharCode(0x2069);
function _sLtr(v) { return _SHR_LRI + String(v) + _SHR_PDI; }
function _sPlain(s) { return String(s || '').split(_SHR_LRI).join('').split(_SHR_PDI).join(''); }
function _sMonth(ymd) { // "2026-11-30" -> "November 2026" in the page's language
  try { return new Intl.DateTimeFormat(_locale(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(String(ymd).slice(0, 7) + '-15T00:00:00Z')); } catch (_) { return String(ymd).slice(0, 7); }
}

// ── What is shared ──────────────────────────────────────────────────────────────────────────────
// The club's Saturday rides, for a member's club things: from the Community tab's read (hub_feed sends the total only
// at 10 or more; checked again here), the copy in memory, else the one that tab keeps on the phone. A rider who is not
// a member has neither, so their picture carries no club line.
function _shrClub(c) {
  let d = S._hub && S._hub.forId === c.id ? S._hub.d : null;
  if (!d) { try { const x = JSON.parse(localStorage.getItem('cq_hub_' + c.id) || 'null'); d = x && x.d && x.d.ok ? x.d : null; } catch (_) { d = null; } }
  const nb = d && d.numbers, n = nb && nb.all != null ? Math.floor(Number(nb.all)) : NaN;
  if (!Number.isFinite(n) || n < 10) return '';
  return /^\d{4}-\d\d/.test(String(nb.since || '')) ? _sF('club', _sLtr(n), _sMonth(nb.since)) : _sF('clubN', _sLtr(n));
}
// The day a badge earned by riding was reached, for the two ladders that count nights: the rider's bike rides (First Lap
// to Corniche 25) and their Saturday social rides (Rolling Start to Hall of Fame). The nights are counted as the badge
// list counts them (_mrBadges in app.src.html), from the rider's own bookings on the phone, and the day is that of the
// night that made the count. A night without a day leaves it out rather than guess. Any other badge earned by riding (a
// streak, a distance, a place in the queue) has no one day the app can name: its picture carries none.
const SHR_NIGHTS = { first_lap: 1, regular: 5, podium: 10, corniche25: 25 };
const SHR_SATS = { rolling_start: 1, slipstream: 5, paceline: 10, peloton: 25, grand_tour: 50, hall_of_fame: 100 };
function _shrRodeOn(c, slug) {
  const sat = SHR_SATS[slug], n = SHR_NIGHTS[slug] || sat;
  if (!n) return '';
  try {
    const ses = new Map((S.sessions || []).map((x) => [x.id, x])), by = new Map();
    getQueue().forEach((e) => {
      if (!e || e.customerId !== c.id || _ncEntry(e) || !_bdgRode(e)) return;
      if (sat) { const x = ses.get(e.sessionId); if (!x || _rideKind(x) !== 'saturday') return; }
      const d = String(e.sessionDate || e.sessionId || '').slice(0, 10);
      by.set(e.sessionId, /^\d{4}-\d\d-\d\d$/.test(d) ? d : '');
    });
    const days = [...by.values()].sort();
    return days.length < n || days[0] === '' ? '' : days[n - 1];
  } catch (_) { return ''; }
}
// { label, name, level, date, club, medal: {icon, color} or chip: {color}, file }, or null when there is nothing earned
// to share (the list changed under the pop-up, another account signed in).
function _shrSubject(job, c) {
  const w = _sWords();
  if (job.kind === 'badge') {
    const x = _mrBadgeList(c)[job.i];
    if (!x || !x.on || !x.b) return null;
    const at = x.g ? x.g.at : x.at || _shrRodeOn(c, x.b.slug);
    return {
      label: _sT('kBadge'), name: _bdgName(x.b),
      level: x.lv && x.lvN && w.level ? w.level.replace('{0}', _sLtr(x.lvN)).replace('{1}', _sLtr(x.lv.length)) : '',
      date: at ? _bdgDay(at) : '',
      club: typeof _hubBdg === 'function' && _hubBdg(x.b.slug) ? _shrClub(c) : '',
      medal: { icon: x.b.icon, color: _bdgCol(x.b) },
      file: 'micromobility-' + (String(x.b.slug || '').replace(/[^a-z0-9_]+/gi, '-') || 'badge'),
    };
  }
  if (job.kind === 'title') {
    const a = S._ttMine, x = a && a.forId === c.id && Array.isArray(a.titles) ? a.titles.find((y) => y && y.id === job.id) : null;
    if (!x) return null;
    // at: the day it was given or reached (customer_my_titles from migration 20261114011200 on; none before it)
    return { label: _sT('kTitle'), name: _ttName(x), level: '', date: x.at ? _bdgDay(x.at) : '', club: _shrClub(c), chip: { color: x.color }, file: 'micromobility-title' };
  }
  if (job.kind === 'mile') {
    const h = S._hub, d = h && h.forId === c.id ? h.d : null;
    if (!d) return null;
    if (job.k === 'me') {
      const me = d.me, n = me ? Number(me.n) || 0 : 0, tg = me ? Number(me.target) || 1 : 1;
      if (!me || !me.kind || n < tg) return null;
      const name = me.kind === 'first' ? _sT('mFirst') : me.kind === 'second' ? _sT('mSecond') : me.kind === 'back' ? _sT('mBack') : _sF('mLevel', _sLtr(tg));
      return { label: _sT('kMile'), name, level: '', date: /^\d{4}-\d\d/.test(String(me.ends_on || '')) ? _sMonth(me.ends_on) : '', club: _shrClub(c), medal: { icon: 'calcheck', color: 'green' }, file: 'micromobility-challenge' };
    }
    const g = (Array.isArray(d.goals) ? d.goals : []).find((y) => y && y.id === job.id);
    if (!g || (Number(g.n) || 0) < (Number(g.target) || 1)) return null;
    const name = String((S.lang === 'ar' && g.name_ar) || g.name || '');
    return { label: _sT('kMile'), name, level: '', date: '', club: _shrClub(c), medal: g.badge ? { icon: g.badge.icon, color: g.badge.color } : { icon: 'flag', color: 'gold' }, file: 'micromobility-challenge' };
  }
  // A member's "My month" card (new features build F13): worded where the card is drawn (member-hub.js, _monSub), with
  // its numbers as `lines` under the month's name.
  if (job.kind === 'month') return typeof _monSub === 'function' ? _monSub(c, _sLtr) : null;
  return null;
}

// ── The picture ─────────────────────────────────────────────────────────────────────────────────
const SHR_W = 1080, SHR_H = 1920, SHR_MX = 540;
const SHR_INK = { bg: '#0b0e0a', go: '#03ff89', hi: '#ffffff', mid: '#d7ded9', low: '#b8c2bb', foot: '#7f8a83' };
function _shrImg(src) {
  if (!src) return Promise.resolve(null);
  return new Promise((res) => {
    const im = new Image(); let done = false;
    const end = (v) => { if (!done) { done = true; res(v); } };
    im.onload = () => end(im.naturalWidth ? im : null); im.onerror = () => end(null);
    setTimeout(() => end(null), 4000);
    im.src = src;
  });
}
// The medal as the app draws it (_bdgMedal's svg). Its colours come from the stylesheet, which a picture of the svg
// cannot read: a copy is put on the page for a moment, each shape's computed paint is written onto it as attributes,
// and the copy goes as a data: address (a picture from one does not close the canvas to reading). The page's green is
// the one for its light paper, and a session's own colour on some pages: on the picture's dark ground a green badge is
// the brand green, whatever page it is shared from.
const _SHR_PAINT = ['fill', 'fill-opacity', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-weight'];
function _shrMedalSrc(icon, color) {
  const box = document.createElement('div'); box.className = 'shr-probe'; box.setAttribute('aria-hidden', 'true');
  box.style.setProperty('--green', SHR_INK.go);
  box.innerHTML = _bdgMedal(icon, color);
  document.body.appendChild(box);
  try {
    const svg = box.querySelector('svg'); if (!svg) return '';
    svg.querySelectorAll('*').forEach((el) => {
      if (el.closest('defs')) return;
      const cs = getComputedStyle(el);
      _SHR_PAINT.forEach((p) => { const v = cs.getPropertyValue(p); if (v && v.indexOf('url(') < 0) el.setAttribute(p, v); }); // a gradient keeps its own attribute
      el.removeAttribute('class');
    });
    svg.removeAttribute('class'); svg.setAttribute('width', '520'); svg.setAttribute('height', '520');
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
  } catch (_) { return ''; } finally { box.remove(); }
}
// One of the eight badge colours as the stylesheet holds it (a title's chip is drawn in it).
function _shrColor(color) {
  const el = document.createElement('span'); el.className = 'bdg-m shr-probe bdc-' + (BDG_COLORS.includes(color) ? color : 'green');
  el.style.setProperty('--green', SHR_INK.go);
  document.body.appendChild(el);
  try { return getComputedStyle(el).color || SHR_INK.go; } catch (_) { return SHR_INK.go; } finally { el.remove(); }
}
// The MicroMobility mark (the page's own, white), given a size and the brand green. Without it the name stands alone.
let _shrMarkP = null;
function _shrMark() {
  if (!_shrMarkP) {
    _shrMarkP = fetch('/assets/brand-mark-white.svg').then((r) => (r.ok ? r.text() : '')).then((s) => {
      if (s.indexOf('<svg ') !== 0) return null;
      return _shrImg('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s.replace('<svg ', '<svg width="408" height="360" ').replace('fill="#fff"', 'fill="' + SHR_INK.go + '"')));
    }).catch(() => null).then((im) => { if (!im) _shrMarkP = null; return im; });
  }
  return _shrMarkP;
}
function _shrBox(x, X, Y, W, H, R) {
  x.beginPath(); x.moveTo(X + R, Y); x.arcTo(X + W, Y, X + W, Y + H, R); x.arcTo(X + W, Y + H, X, Y + H, R); x.arcTo(X, Y + H, X, Y, R); x.arcTo(X, Y, X + W, Y, R); x.closePath();
}
// The largest size from `size` down to `min` at which the words fit `max`; the font is left set to it.
function _shrFit(x, text, weight, size, min, fam, max) {
  let s = size;
  for (;;) { x.font = `${weight} ${s}px ${fam}`; if (s <= min || x.measureText(text).width <= max) return s; s -= 4; }
}
function _shrWrap(x, text, max) { // two lines at most, broken at a space
  if (x.measureText(text).width <= max) return [text];
  const w = text.split(/\s+/); let a = '', i = 0;
  for (; i < w.length; i++) { const nx = a ? a + ' ' + w[i] : w[i]; if (a && x.measureText(nx).width > max) break; a = nx; }
  const b = w.slice(i).join(' ');
  return b ? [a, b] : [a];
}
// What every picture of one subject shares: the body font with its weights loaded, the mark, the medal or the chip's colour.
async function _shrAssets(sub) {
  const fam = getComputedStyle(document.body).fontFamily || 'sans-serif';
  try { await Promise.all(['700 84px', '600 48px', '400 44px'].map((w) => document.fonts.load(`${w} ${fam}`, sub.label + sub.name))); } catch (_) {}
  const [mark, medal] = await Promise.all([_shrMark(), sub.medal ? _shrImg(_shrMedalSrc(sub.medal.icon, sub.medal.color)) : null]);
  return { fam, mark, medal, tint: _shrColor(sub.medal ? sub.medal.color : sub.chip.color) };
}
// first: the rider's first name, or '' to leave it out. Answers { file, url, alt }.
async function _shrDraw(sub, first, a) {
  const cv = document.createElement('canvas'); cv.width = SHR_W; cv.height = SHR_H;
  const x = cv.getContext('2d'); if (!x) return null;
  const fam = a.fam, rtl = S.lang === 'ar' || S.lang === 'ur', said = ['MicroMobility'];
  const put = (text, y, max) => x.fillText(text, SHR_MX, y, max || 980);
  x.direction = rtl ? 'rtl' : 'ltr'; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
  x.fillStyle = SHR_INK.bg; x.fillRect(0, 0, SHR_W, SHR_H);
  const glow = x.createRadialGradient(SHR_MX, 720, 40, SHR_MX, 720, 620);
  glow.addColorStop(0, 'rgba(3,255,137,.13)'); glow.addColorStop(1, 'rgba(3,255,137,0)');
  x.fillStyle = glow; x.fillRect(0, 100, SHR_W, 1240);
  // the mark and the name
  if (a.mark) x.drawImage(a.mark, SHR_MX - 68, 140, 136, 120);
  x.fillStyle = a.mark ? SHR_INK.hi : SHR_INK.go; x.font = `600 48px ${fam}`; put('MicroMobility', a.mark ? 336 : 260);
  if (sub.medal) {
    if (a.medal) x.drawImage(a.medal, SHR_MX - 260, 460, 520, 520);
    else { // the medal could not be made into a picture: its six-sided shape in the badge's colour
      x.save(); x.translate(SHR_MX - 260, 460); x.scale(13, 13);
      const hex = new Path2D('M20 2.2 35.4 11.1v17.8L20 37.8 4.6 28.9V11.1z');
      x.fillStyle = a.tint; x.globalAlpha = 0.16; x.fill(hex); x.globalAlpha = 1; x.strokeStyle = a.tint; x.lineWidth = 1.8; x.lineJoin = 'round'; x.stroke(hex);
      x.restore();
    }
  } else { // a title: what it is, then its chip in its own colour, the bar on the side the line starts from
    x.fillStyle = SHR_INK.go; x.font = `600 44px ${fam}`; put(sub.label, 580); said.push(sub.label);
    _shrFit(x, sub.name, 700, 76, 44, fam, 760);
    const W = Math.max(520, Math.min(900, x.measureText(sub.name).width + 150)), X = SHR_MX - W / 2, Y = 640, H = 210;
    _shrBox(x, X, Y, W, H, 30); x.fillStyle = a.tint; x.globalAlpha = 0.16; x.fill(); x.globalAlpha = 1;
    x.strokeStyle = a.tint; x.lineWidth = 4; x.stroke();
    x.save(); _shrBox(x, X, Y, W, H, 30); x.clip(); x.fillStyle = a.tint; x.fillRect(rtl ? X + W - 20 : X, Y, 20, H); x.restore();
    x.fillStyle = SHR_INK.hi; put(sub.name, Y + 132, W - 90); said.push(sub.name);
  }
  // the words under it, as one block centred between the medal and the club line
  const rows = [];
  if (first) rows.push({ t: first, w: 600, s: 60, c: SHR_INK.hi, h: 92 });
  if (sub.medal) {
    rows.push({ t: sub.label, w: 600, s: 44, c: SHR_INK.go, h: 84 });
    const s = _shrFit(x, sub.name, 700, 84, 60, fam, 940);
    _shrWrap(x, sub.name, 940).forEach((t) => rows.push({ t, w: 700, s, c: SHR_INK.hi, h: Math.round(s * 1.22) }));
  }
  if (sub.level) rows.push({ t: sub.level, w: 400, s: 44, c: SHR_INK.low, h: 76 });
  if (sub.date) rows.push({ t: sub.date, w: 400, s: 44, c: SHR_INK.mid, h: 76 });
  if (Array.isArray(sub.lines)) sub.lines.forEach((t) => rows.push({ t, w: 400, s: 40, c: SHR_INK.mid, h: 60 })); // a month's numbers (F13)
  let y = (sub.medal ? 1290 : 1010) - rows.reduce((n, r) => n + r.h, 0) / 2;
  if (Array.isArray(sub.lines)) y = Math.max(y, 1000); // a long month stays clear of the medal above it
  rows.forEach((r) => { x.fillStyle = r.c; x.font = `${r.w} ${r.s}px ${fam}`; put(r.t, y + r.h * 0.72); y += r.h; });
  if (first) said.push(first);
  if (sub.medal) said.push(sub.label, sub.name);
  if (sub.level) said.push(sub.level);
  if (sub.date) said.push(sub.date);
  if (Array.isArray(sub.lines)) said.push(...sub.lines);
  if (sub.club) {
    x.fillStyle = SHR_INK.low; x.font = `400 40px ${fam}`;
    const L = _shrWrap(x, sub.club, 960);
    L.forEach((t, i) => put(t, 1660 - (L.length - 1 - i) * 56));
    said.push(sub.club);
  }
  x.fillStyle = SHR_INK.foot; x.font = `400 40px ${fam}`; put('experiences.micromobility.sa', 1790);
  let blob = null;
  try { blob = await new Promise((res) => cv.toBlob(res, 'image/png')); } catch (_) { blob = null; }
  if (!blob) { // a browser that will not read back a canvas holding the svg pictures: drawn again without them
    if (a.mark || a.medal) return _shrDraw(sub, first, { ...a, mark: null, medal: null });
    return null;
  }
  const file = new File([blob], sub.file + '.png', { type: 'image/png' });
  return { file, url: URL.createObjectURL(blob), alt: said.map(_sPlain).join(' · ') };
}

// ── The pop-up ──────────────────────────────────────────────────────────────────────────────────
// Can this browser hand a picture file to its share sheet (asked with the file itself once it is made).
function _shrCan(f) {
  try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [f || new File([new Blob([''], { type: 'image/png' })], 'x.png', { type: 'image/png' })] })); } catch (_) { return false; }
}
// The pictures of the pop-up that closed: their addresses go a minute later, so a save still starting keeps its file.
let _shrHeld = [];
function _shrDrop() {
  const L = _shrHeld; _shrHeld = [];
  if (L.length) setTimeout(() => L.forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) {} }), 60000);
}
function _shrRender() {
  const job = S._shr, c = _sCust();
  _shrDrop();
  if (!job || !c || job.forId !== c.id) { S._shr = null; return; }
  const sub = _shrSubject(job, c);
  if (!sub) { S._shr = null; return; }
  job.sub = sub; job.name = false; job.files = [null, null]; job.err = false;
  job.first = String(c.name || '').trim().split(/\s+/)[0] || '';
  const w = _sWords(), can = _shrCan(), share = w.share || 'Share';
  const old = document.getElementById('badge-pop'); if (old) old.remove(); // the badge's own pop-up: this one takes its place
  const el = document.createElement('div'); el.id = 'badge-pop'; el.className = 'badge-pop shr-pop';
  el.innerHTML = `<div class="badge-pop-box shr-box" role="dialog" aria-modal="true" aria-label="${esc(share)}">
    <div class="shr-view" id="shr-view"></div>
    ${job.first ? `<label class="cw-sw shr-sw" for="shr-name"><input type="checkbox" role="switch" id="shr-name" data-on-change="${_on('_shrName', _P('checked'))}"><span class="cw-sw-box" aria-hidden="true"></span><span class="cw-sw-txt"><b>${esc(_sT('nameSw'))}</b></span></label>` : ''}
    <div class="badge-pop-acts">
      <button type="button" class="btn-primary shr-btn" id="shr-go" data-shr="${can ? 'share' : 'save'}" data-on-click="${_on('_shrSend')}" disabled>${can ? _cuIc('share', 16) : ''}<span>${esc(can ? share : _sT('save'))}</span></button>
      <button type="button" class="btn-secondary" id="shr-x" data-on-click="${_on('_shrClose')}">${esc(w.close || 'Close')}</button>
    </div></div>`;
  el.addEventListener('click', (e) => { if (e.target === el) _shrClose(); }); // the backdrop, and Escape (the page clicks the top dialog)
  document.body.appendChild(el);
  _shrShow();
  const b = document.getElementById('shr-x'); if (b) try { b.focus({ preventScroll: true }); } catch (_) {}
  _shrMake(job);
}
// Both pictures are made as the pop-up opens, without the name first: the one the switch asks for is then there at once.
async function _shrMake(job) {
  try {
    const a = await _shrAssets(job.sub);
    for (let i = 0; i < (job.first ? 2 : 1); i++) {
      const f = await _shrDraw(job.sub, i ? job.first : '', a);
      if (f) _shrHeld.push(f.url);
      if (S._shr !== job) return; // closed, or another one opened, meanwhile
      if (!f) throw new Error('no picture');
      job.files[i] = f;
      if (!!job.name === !!i) _shrShow();
    }
  } catch (_) { if (S._shr === job) { job.err = true; _shrShow(); } }
}
// The picture for the switch as it stands, or what stands in for it; the button waits for the picture.
function _shrShow() {
  const job = S._shr, v = document.getElementById('shr-view'), go = document.getElementById('shr-go');
  if (!job || !v) return;
  const f = job.files[job.name ? 1 : 0];
  if (job.err) v.innerHTML = `<div class="shr-err" role="alert"><span>${esc(_sT('err'))}</span><button type="button" class="btn-secondary" data-on-click="${_on('_shrAgain')}">${esc(_sT('retry'))}</button></div>`;
  else if (!f) v.innerHTML = `<div class="shr-wait" role="status" aria-label="${esc(_sT('making'))}"></div>`;
  else { v.innerHTML = `<img id="shr-img" width="${SHR_W}" height="${SHR_H}" alt="${esc(f.alt)}">`; v.firstChild.src = f.url; }
  if (go) go.disabled = !f || !!job.err;
}
function _shrName(on) { const job = S._shr; if (!job) return; job.name = !!on; _shrShow(); }
function _shrAgain() { const job = S._shr; if (!job) return; job.err = false; job.files = [null, null]; _shrShow(); _shrMake(job); }
// Inside the tap, with the file already made: nothing is awaited before navigator.share. The picture goes alone.
function _shrSend() {
  const job = S._shr, f = job && job.files[job.name ? 1 : 0];
  if (!f) return;
  if (_shrCan(f.file)) {
    try { navigator.share({ files: [f.file] }).catch((e) => { if (e && e.name === 'AbortError') return; _shrSave(f); }); return; } catch (_) {} // they closed the sheet: nothing; a share that failed: saved instead
  }
  _shrSave(f);
}
function _shrSave(f) {
  const a = document.createElement('a'); a.href = f.url; a.download = f.file.name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  if (typeof toast === 'function') toast(_sT('saved'));
}
function _shrClose() { S._shr = null; _shrDrop(); _bdgPopClose(); }
window._shrRender = _shrRender;
