// The route's own page (new features build F11, 2026-11-13). A ride tied to a route (sessions.route_slug, the website's
// Routes list) opens it from its ticket and from the session card's Details: the route's name, its line drawn from the
// stored points (north up, no base map), the distance, the surface, the level and the turn points in order, with a GPX
// file the rider can save for a bike computer. The GPX is written here from the stored route; nothing outside the app is
// called, and no elevation is read, drawn or stored (the owner dropped it on 2026-11-13).
// The stored route is site_content 'route.track.<slug>' = {v:1, pts:[[lat,lng]...], turns:[{km,en,ar}]}, the slug
// written as the table's keys allow (_rtpKey): public to read, admins write it, every change kept in
// site_content_history. Staff set it from the Route step of the session forms (_rtpEdit): a GPX file read in the
// browser and thinned to RTP_MAX_PTS points, and the turn points typed as a name and how many km from the start.
// A file of its own, fetched only when a route is opened (_rtLoad in app.src.html), with its own words in all ten
// languages. Hand-written, not generated; the build stamps its address (RT_V). The build's handler, inline-style and
// emoji checks do not read it: no on...= attribute, no style= attribute and no emoji may be written here.
/* global S, sb, esc, _on, toast, closeEventInfo */
const RTP_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
const RTP_T = {
  dist: ['Distance', 'المسافة', 'Distance', 'Distancia', 'Distância', 'فاصلہ', 'दूरी', 'Distansya', 'दूरी', 'দূরত্ব'],
  surface: ['Surface', 'السطح', 'Revêtement', 'Superficie', 'Piso', 'سطح', 'सतह', 'Uri ng daan', 'सतह', 'রাস্তার ধরন'],
  level: ['Level', 'المستوى', 'Niveau', 'Nivel', 'Nível', 'درجہ', 'स्तर', 'Antas', 'स्तर', 'স্তর'],
  turns: ['Turn points', 'نقاط الانعطاف', 'Points de virage', 'Puntos de giro', 'Pontos de viragem', 'موڑ کے مقامات', 'मोड़ के स्थान', 'Mga likuan', 'मोडका ठाउँहरू', 'মোড়ের স্থান'],
  gpx: ['Save GPX file', 'حفظ ملف GPX', 'Enregistrer le fichier GPX', 'Guardar archivo GPX', 'Guardar ficheiro GPX', 'GPX فائل محفوظ کریں', 'GPX फ़ाइल सहेजें', 'I-save ang GPX file', 'GPX फाइल बचत गर्नुहोस्', 'GPX ফাইল সংরক্ষণ করুন'],
  lineAlt: ['The route as a line, north at the top', 'المسار مرسومًا كخط، والشمال في الأعلى', 'Le parcours tracé, le nord en haut', 'La ruta dibujada, con el norte arriba', 'O percurso desenhado, com o norte em cima', 'راستہ لکیر کی صورت میں، شمال اوپر', 'रेखा के रूप में रूट, उत्तर ऊपर', 'Ang ruta bilang linya, hilaga sa itaas', 'रेखाको रूपमा रुट, उत्तर माथि', 'রেখা হিসেবে রুট, উত্তর উপরে'],
  edTitle: ['Line and turn points', 'الخط ونقاط الانعطاف', 'Tracé et points de virage', 'Trazado y puntos de giro', 'Traçado e pontos de viragem', 'لکیر اور موڑ کے مقامات', 'रेखा और मोड़ के स्थान', 'Linya at mga likuan', 'रेखा र मोडका ठाउँहरू', 'রেখা ও মোড়ের স্থান'],
  edFile: ['GPX file', 'ملف GPX', 'Fichier GPX', 'Archivo GPX', 'Ficheiro GPX', 'GPX فائل', 'GPX फ़ाइल', 'GPX file', 'GPX फाइल', 'GPX ফাইল'],
  edLine: ['{0} points, {1} km', '{0} نقطة، {1} كم', '{0} points, {1} km', '{0} puntos, {1} km', '{0} pontos, {1} km', '{0} نقطے، {1} کلومیٹر', '{0} बिंदु, {1} किमी', '{0} punto, {1} km', '{0} बिन्दु, {1} किमी', '{0}টি বিন্দু, {1} কিমি'],
  edNoLine: ['No line yet', 'لا يوجد خط بعد', 'Pas encore de tracé', 'Aún no hay trazado', 'Ainda sem traçado', 'ابھی کوئی لکیر نہیں', 'अभी कोई रेखा नहीं', 'Wala pang linya', 'अहिलेसम्म रेखा छैन', 'এখনও কোনো রেখা নেই'],
  edRemove: ['Remove line', 'إزالة الخط', 'Retirer le tracé', 'Quitar el trazado', 'Remover o traçado', 'لکیر ہٹائیں', 'रेखा हटाएँ', 'Alisin ang linya', 'रेखा हटाउनुहोस्', 'রেখা সরান'],
  edKm: ['At km', 'عند كم', 'Au km', 'En el km', 'Ao km', 'کلومیٹر پر', 'किमी पर', 'Sa km', 'किमीमा', 'কিমিতে'],
  edEn: ['Name (English)', 'الاسم (بالإنجليزية)', 'Nom (anglais)', 'Nombre (inglés)', 'Nome (inglês)', 'نام (انگریزی)', 'नाम (अंग्रेज़ी)', 'Pangalan (Ingles)', 'नाम (अङ्ग्रेजी)', 'নাম (ইংরেজি)'],
  edAr: ['Name (Arabic)', 'الاسم (بالعربية)', 'Nom (arabe)', 'Nombre (árabe)', 'Nome (árabe)', 'نام (عربی)', 'नाम (अरबी)', 'Pangalan (Arabe)', 'नाम (अरबी)', 'নাম (আরবি)'],
  edAdd: ['Add turn point', 'إضافة نقطة انعطاف', 'Ajouter un point de virage', 'Añadir punto de giro', 'Adicionar ponto de viragem', 'موڑ کا مقام شامل کریں', 'मोड़ का स्थान जोड़ें', 'Magdagdag ng likuan', 'मोडको ठाउँ थप्नुहोस्', 'মোড়ের স্থান যোগ করুন'],
  edDel: ['Remove turn point {0}', 'إزالة نقطة الانعطاف {0}', 'Retirer le point de virage {0}', 'Quitar el punto de giro {0}', 'Remover o ponto de viragem {0}', 'موڑ کا مقام {0} ہٹائیں', 'मोड़ का स्थान {0} हटाएँ', 'Alisin ang likuan {0}', 'मोडको ठाउँ {0} हटाउनुहोस्', 'মোড়ের স্থান {0} সরান'],
  save: ['Save', 'حفظ', 'Enregistrer', 'Guardar', 'Guardar', 'محفوظ کریں', 'सहेजें', 'I-save', 'बचत गर्नुहोस्', 'সংরক্ষণ করুন'],
  cancel: ['Cancel', 'إلغاء', 'Annuler', 'Cancelar', 'Cancelar', 'منسوخ کریں', 'रद्द करें', 'Kanselahin', 'रद्द गर्नुहोस्', 'বাতিল করুন'],
  edBadFile: ['This file has no route in it.', 'هذا الملف لا يحتوي على مسار.', 'Ce fichier ne contient aucun parcours.', 'Este archivo no contiene ninguna ruta.', 'Este ficheiro não contém nenhum percurso.', 'اس فائل میں کوئی راستہ نہیں ہے۔', 'इस फ़ाइल में कोई रूट नहीं है।', 'Walang ruta sa file na ito.', 'यो फाइलमा कुनै रुट छैन।', 'এই ফাইলে কোনো রুট নেই।'],
  edBadTurn: ['Each turn point needs a name and a distance within the route.', 'كل نقطة انعطاف تحتاج إلى اسم ومسافة ضمن المسار.', 'Chaque point de virage doit avoir un nom et une distance comprise dans le parcours.', 'Cada punto de giro necesita un nombre y una distancia dentro de la ruta.', 'Cada ponto de viragem precisa de um nome e de uma distância dentro do percurso.', 'ہر موڑ کے مقام کے لیے نام اور راستے کے اندر فاصلہ ضروری ہے۔', 'हर मोड़ के स्थान के लिए नाम और रूट के भीतर की दूरी ज़रूरी है।', 'Kailangan ng bawat likuan ng pangalan at distansyang nasa loob ng ruta.', 'हरेक मोडको ठाउँलाई नाम र रुटभित्रको दूरी चाहिन्छ।', 'প্রতিটি মোড়ের স্থানের জন্য একটি নাম এবং রুটের ভেতরের দূরত্ব প্রয়োজন।'],
  err: ['We could not do that. Please try again.', 'تعذّر ذلك. يرجى المحاولة مرة أخرى.', 'Action impossible. Veuillez réessayer.', 'No se pudo hacer. Inténtalo de nuevo.', 'Não foi possível. Tente novamente.', 'یہ نہیں ہو سکا۔ دوبارہ کوشش کریں۔', 'यह नहीं हो सका। फिर कोशिश करें।', 'Hindi ito nagawa. Pakisubukang muli.', 'यो हुन सकेन। फेरि प्रयास गर्नुहोस्।', 'এটি করা যায়নি। আবার চেষ্টা করুন।'],
  edLog: ['Route line: {0}', 'خط المسار: {0}', 'Tracé du parcours : {0}', 'Trazado de la ruta: {0}', 'Traçado do percurso: {0}', 'راستے کی لکیر: {0}', 'रूट की रेखा: {0}', 'Linya ng ruta: {0}', 'रुटको रेखा: {0}', 'রুটের রেখা: {0}'],
};
const RTP_KEY = 'route.track.', RTP_MAX_PTS = 600, RTP_MAX_TURNS = 30;
// The key a route's line is stored under. A site_content key is letters, digits and _ between dots, 80 characters at
// most (the table's site_content_key_shape), and a slug has dashes: every other character is written _<its code>_, so
// no two slugs share a key and the database takes it ('obhur-coast' is route.track.obhur_2d_coast). A slug too long
// for that is stored under two short sums of itself (h.<sums>, which no written slug can spell: a dot is written _2e_).
function _rtpKey(slug) {
  const s = String(slug), k = RTP_KEY + s.replace(/[^a-zA-Z0-9]/g, (c) => '_' + c.charCodeAt(0).toString(16) + '_');
  if (k.length <= 80) return k;
  let a = 0x811c9dc5, b = 5381;
  for (let i = 0; i < s.length; i++) { a = Math.imul(a ^ s.charCodeAt(i), 0x01000193) >>> 0; b = (Math.imul(b, 33) + s.charCodeAt(i)) >>> 0; }
  return RTP_KEY + 'h.' + a.toString(16) + b.toString(16);
}
// The dispatcher's markers (app.src.html _EL, _EV), written here so this file leans on nothing but _on itself.
const _RTP_EL = { '@': 'this' }, _RTP_EV = { '@': 'event' };
function _rtpT(k) {
  const row = RTP_T[k] || [''], i = RTP_LANGS.indexOf(S.lang);
  return row[i < 0 ? 0 : i] || row[0];
}
function _rtpF(k, ...v) { return v.reduce((s, x, i) => s.split('{' + i + '}').join(String(x)), _rtpT(k)); }
// The page's own words this file shows (Route, "{0} km", Open the map, Close), lent by _rtLoad so they stay in the riders' pack.
function _rtpW() { const d = window._rtpDeps || {}; return (d.words && d.words()) || { title: 'Route', km: '{0} km', map: 'Open the map', close: 'Close' }; }
function _rtpKmTxt(km) { return _rtpW().km.split('{0}').join(String(Math.round(km * 100) / 100)); }

// ── The line's arithmetic ────────────────────────────────────────────────────────────────────────────────────
function _rtpOkPt(p) { return Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180; }
function _rtpDist(a, b) { // metres between two [lat,lng] (haversine)
  const p = Math.PI / 180, dla = (b[0] - a[0]) * p, dlo = (b[1] - a[1]) * p;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(a[0] * p) * Math.cos(b[0] * p) * Math.sin(dlo / 2) ** 2;
  return 12742017.6 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function _rtpCum(pts) { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + _rtpDist(pts[i - 1], pts[i])); return c; }
function _rtpLenKm(pts) { return pts.length > 1 ? _rtpCum(pts).pop() / 1000 : 0; }
// The point m metres along the line.
function _rtpAt(pts, cum, m) {
  if (!pts.length) return null;
  if (!(m > 0)) return pts[0];
  if (m >= cum[cum.length - 1]) return pts[pts.length - 1];
  let i = 1; while (i < cum.length - 1 && cum[i] < m) i++;
  const f = (m - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
}
function _rtpRound(p) { return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]; }
// A recorded line thinned to at most RTP_MAX_PTS points (Douglas-Peucker on a flat sheet in metres, the tolerance doubled
// from 3 m until it fits), kept to five decimals (about a metre).
function _rtpThin(pts) {
  const src = pts.filter(_rtpOkPt).map(_rtpRound).filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
  if (src.length <= 2) return src;
  const k = Math.cos(src[0][0] * Math.PI / 180), xy = src.map((p) => [p[1] * 111320 * k, p[0] * 110540]);
  const off = (p, a, b) => { // metres from p to the stretch a-b
    const dx = b[0] - a[0], dy = b[1] - a[1], d = dx * dx + dy * dy;
    const t = d ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  const pass = (tol) => {
    const keep = new Uint8Array(src.length), todo = [[0, src.length - 1]];
    keep[0] = 1; keep[src.length - 1] = 1;
    while (todo.length) {
      const [a, b] = todo.pop(); let far = -1, max = tol;
      for (let i = a + 1; i < b; i++) { const d = off(xy[i], xy[a], xy[b]); if (d > max) { max = d; far = i; } }
      if (far > 0) { keep[far] = 1; todo.push([a, far], [far, b]); }
    }
    return src.filter((_, i) => keep[i]);
  };
  let out = src;
  for (let tol = 3; out.length > RTP_MAX_PTS && tol < 5000; tol *= 2) out = pass(tol);
  return out.length > RTP_MAX_PTS ? out.filter((_, i) => i % Math.ceil(out.length / RTP_MAX_PTS) === 0 || i === out.length - 1) : out;
}
function _rtpName(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 60); }
// What is stored, read as stored: anything that is not a point or a named distance is left out.
function _rtpClean(v) {
  if (!v || typeof v !== 'object') return null;
  const pts = (Array.isArray(v.pts) ? v.pts : []).filter(_rtpOkPt).slice(0, 2000).map((p) => [Number(p[0]), Number(p[1])]);
  const turns = (Array.isArray(v.turns) ? v.turns : []).map((x) => ({ km: Number(x && x.km), en: _rtpName(x && x.en), ar: _rtpName(x && x.ar) }))
    .filter((x) => isFinite(x.km) && x.km >= 0 && (x.en || x.ar)).sort((a, b) => a.km - b.km).slice(0, RTP_MAX_TURNS);
  return (pts.length > 1 || turns.length) ? { pts: pts.length > 1 ? pts : [], turns } : null;
}
function _rtpTurnName(x) { return S.lang === 'ar' ? (x.ar || x.en) : (x.en || x.ar); }

// ── The stored route, read once per slug while the app is open ───────────────────────────────────────────────
const _rtpCache = {};
// ok false: the read did not come back (said to staff, who must not edit from a blank; never said to a rider).
async function _rtpRead(slug) {
  try {
    const key = _rtpKey(slug), r = await sb.from('site_content').select('key,value').eq('key', key);
    if (!r || r.error) return { ok: false, v: null };
    const row = (r.data || []).find((x) => x && x.key === key);
    return { ok: true, v: row ? _rtpClean(row.value) : null };
  } catch (_) { return { ok: false, v: null }; }
}
async function _rtpTrack(slug) {
  if (Object.prototype.hasOwnProperty.call(_rtpCache, slug)) return _rtpCache[slug];
  const r = await _rtpRead(slug);
  if (!r.ok) return null; // asked again at the next open
  _rtpCache[slug] = r.v;
  return r.v;
}
// The route as the Routes list names it: its name, distance, level, surface and map link in the reader's language.
function _rtpRoute(slug) {
  const d = window._rtpDeps || {}, raw = (Array.isArray(S._routes) ? S._routes : []).find((x) => d.slugOf && d.slugOf(x) === slug) || null;
  if (!raw) return { slug, name: slug, km: 0, level: '', surface: '', href: '' };
  const L = (v) => String((v && typeof v === 'object') ? (v[S.lang] || v.en || '') : (v || '')).trim();
  const h = raw.href && typeof raw.href === 'object' ? raw.href.href : raw.href;
  return { slug, name: L(raw.name) || slug, km: Math.max(0, Number(raw.km) || 0), level: L(raw.level), surface: L(raw.surface), href: /^https?:\/\/[^\s"<>`]+$/i.test(String(h || '').trim()) ? String(h).trim() : '' };
}

// ── The GPX file (GPX 1.1): the line as one track, the turn points as waypoints set on the line ─────────────
function _rtpXml(s) { return String(s == null ? '' : s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c])); }
function _rtpGpx(name, tr) {
  const f = (n) => (Math.round(n * 1e5) / 1e5).toFixed(5), cum = _rtpCum(tr.pts), nm = _rtpXml(name);
  const wpt = tr.turns.map((x, i) => { const p = _rtpAt(tr.pts, cum, x.km * 1000); return `<wpt lat="${f(p[0])}" lon="${f(p[1])}"><name>${_rtpXml((i + 1) + '. ' + _rtpTurnName(x))}</name></wpt>`; });
  return ['<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="MicroMobility" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${nm}</name></metadata>`, ...wpt,
    `<trk><name>${nm}</name><trkseg>`, ...tr.pts.map((p) => `<trkpt lat="${f(p[0])}" lon="${f(p[1])}"/>`), '</trkseg></trk>', '</gpx>', ''].join('\n');
}
// Saved through the phone's own sheet where it takes a file (an iPhone's Home Screen app has no downloads), else as a download.
async function _rtpSave() {
  const P = S._rtp, tr = P && P.tr; if (!tr || tr.pts.length < 2) return;
  const xml = _rtpGpx(_rtpRoute(P.slug).name, tr), file = String(P.slug).replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '') || 'route';
  const d = window._rtpDeps || {};
  if (d.apple && d.apple() && navigator.canShare) {
    try {
      const f = new File([xml], file + '.gpx', { type: 'application/gpx+xml' });
      if (navigator.canShare({ files: [f] })) { await navigator.share({ files: [f] }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/gpx+xml' })), a = document.createElement('a');
  a.href = url; a.download = file + '.gpx';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// ── The page ─────────────────────────────────────────────────────────────────────────────────────────────────
// The line on a flat sheet, north up whatever the page's direction (a map does not turn round for Arabic): the start
// as a filled dot, each turn point as its number.
function _rtpSvg(tr) {
  if (tr.pts.length < 2) return '';
  const la = tr.pts.map((p) => p[0]), lo = tr.pts.map((p) => p[1]), k = Math.cos(((Math.min(...la) + Math.max(...la)) / 2) * Math.PI / 180);
  const x0 = Math.min(...lo) * k, y0 = Math.max(...la), dx = (Math.max(...lo) * k - x0) || 1e-9, dy = (y0 - Math.min(...la)) || 1e-9;
  const W = 320, pad = 18, H = Math.round(Math.max(120, Math.min(300, (W - 2 * pad) * dy / dx + 2 * pad)));
  const sc = Math.min((W - 2 * pad) / dx, (H - 2 * pad) / dy), ox = (W - dx * sc) / 2, oy = (H - dy * sc) / 2;
  const xy = (p) => [Math.round((ox + (p[1] * k - x0) * sc) * 10) / 10, Math.round((oy + (y0 - p[0]) * sc) * 10) / 10];
  const cum = _rtpCum(tr.pts), st = xy(tr.pts[0]);
  const marks = tr.turns.map((x, i) => { const c = xy(_rtpAt(tr.pts, cum, x.km * 1000)); return `<circle class="rtp-tn" cx="${c[0]}" cy="${c[1]}" r="8"/><text x="${c[0]}" y="${c[1] + 3.5}" text-anchor="middle">${i + 1}</text>`; }).join('');
  return `<svg class="rtp-map" viewBox="0 0 ${W} ${H}" direction="ltr" role="img" aria-label="${esc(_rtpT('lineAlt'))}" focusable="false"><path d="M${tr.pts.map((p) => xy(p).join(' ')).join('L')}"/><circle class="rtp-st" cx="${st[0]}" cy="${st[1]}" r="5.5"/>${marks}</svg>`;
}
function _rtpPaint() {
  const P = S._rtp, m = document.getElementById('bike-info-modal'); if (!P || !m) return;
  const r = _rtpRoute(P.slug), tr = P.tr || { pts: [], turns: [] }, w = _rtpW();
  const km = r.km || _rtpLenKm(tr.pts), facts = [];
  if (km) facts.push([_rtpT('dist'), `<bdi>${esc(_rtpKmTxt(km))}</bdi>`]);
  if (r.surface) facts.push([_rtpT('surface'), esc(r.surface)]);
  if (r.level) facts.push([_rtpT('level'), esc(r.level)]);
  m.innerHTML = `<div class="modal-backdrop" data-on-click="${_on('_on_backdropOnly', _RTP_EV, _RTP_EL, '_rtpClose')}">
    <div class="modal-box bike-info-box ev-info rtp-box" role="dialog" aria-modal="true" aria-labelledby="rtp-title" tabindex="-1"${P.tr === undefined ? ' aria-busy="true"' : ''}>
      <div class="bike-info-body">
        <div class="bike-info-kicker">${esc(w.title)}</div>
        <div class="modal-title" id="rtp-title">${esc(r.name)}</div>
        ${_rtpSvg(tr)}
        ${facts.length ? `<dl class="ev-info-facts rtp-facts">${facts.map(([a, b]) => `<div><dt>${esc(a)}</dt><dd>${b}</dd></div>`).join('')}</dl>` : ''}
        ${tr.turns.length ? `<h3 class="rtp-h" id="rtp-turns-h">${esc(_rtpT('turns'))}</h3><ol class="rtp-turns" aria-labelledby="rtp-turns-h">${tr.turns.map((x, i) => `<li><span class="rtp-n" aria-hidden="true">${i + 1}</span><span class="rtp-tn-name" dir="auto">${esc(_rtpTurnName(x))}</span><bdi class="rtp-km">${esc(_rtpKmTxt(x.km))}</bdi></li>`).join('')}</ol>` : ''}
        <div class="modal-footer">
          <button type="button" class="btn-secondary" data-on-click="${_on('_rtpClose')}">${esc(w.close)}</button>
          ${r.href ? `<a class="btn-secondary" href="${esc(r.href)}" target="_blank" rel="noopener">${esc(w.map)}</a>` : ''}
          ${tr.pts.length > 1 ? `<button type="button" class="btn-primary" id="rtp-gpx" data-on-click="${_on('_rtpSave')}">${esc(_rtpT('gpx'))}</button>` : ''}
        </div>
      </div>
    </div>
  </div>`;
  m.style.display = 'block';
}
let _rtpFrom = null;
async function _rtpOpen(slug) {
  slug = String(slug || '').trim(); if (!slug) return;
  try { if (S._info && typeof closeEventInfo === 'function') closeEventInfo(); } catch (_) {} // opened from the Details sheet: this takes its place
  _rtpFrom = document.activeElement;
  S._rtp = { slug, tr: Object.prototype.hasOwnProperty.call(_rtpCache, slug) ? _rtpCache[slug] : undefined };
  _rtpPaint();
  // The sheet itself takes the focus, without a scroll: the page's own pass would pick the first button, which a phone
  // draws last, and the sheet would open at its foot. A repaint gives the focus back to the same place (_popStill).
  try { const b = document.querySelector('#bike-info-modal .rtp-box'); if (b) b.focus({ preventScroll: true }); } catch (_) {}
  const d = window._rtpDeps || {};
  if (S._routes === undefined && d.load) { // the Routes list names the route: asked for here when no ticket has yet
    try { await d.load(); } catch (_) {}
    for (let i = 0; i < 40 && S._routes === undefined; i++) await new Promise((ok) => setTimeout(ok, 150));
    if (S._rtp && S._rtp.slug === slug) _rtpPaint();
  }
  if (S._rtp && S._rtp.slug === slug && S._rtp.tr === undefined) {
    const tr = await _rtpTrack(slug);
    if (S._rtp && S._rtp.slug === slug) { S._rtp.tr = tr; _rtpPaint(); }
  }
}
function _rtpClose() {
  const m = document.getElementById('bike-info-modal');
  if (m && S._rtp) { m.style.display = 'none'; m.innerHTML = ''; }
  S._rtp = null;
  const from = _rtpFrom; _rtpFrom = null;
  try { if (from && from.isConnected) from.focus(); } catch (_) {}
}

// ── Staff: a route's line and turn points (opened from the Route step of the session forms, admins) ─────────
// dep: what the staff page lends (_rtLineOpen): wr = _wr, op = _opName, log = logAction, done = after a save.
function _rtpNum(v) { // a typed distance: Arabic and Persian digits and a comma for the point are read too
  const s = String(v == null ? '' : v).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776)).replace(/[٫,]/g, '.').trim();
  return /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
}
// A GPX file's line (its track, else its route) and its named waypoints. null: not a GPX file, or no line in it.
function _rtpParse(text) {
  let doc = null;
  try { doc = new DOMParser().parseFromString(String(text || ''), 'application/xml'); } catch (_) { return null; }
  if (!doc || doc.getElementsByTagName('parsererror').length) return null;
  const all = (n) => Array.from(doc.getElementsByTagNameNS('*', n)), ll = (el) => [parseFloat(el.getAttribute('lat')), parseFloat(el.getAttribute('lon'))];
  let pts = all('trkpt').map(ll).filter(_rtpOkPt);
  if (pts.length < 2) pts = all('rtept').map(ll).filter(_rtpOkPt);
  if (pts.length < 2) return null;
  const wpts = all('wpt').map((el) => ({ p: ll(el), name: _rtpName((el.getElementsByTagNameNS('*', 'name')[0] || {}).textContent) })).filter((x) => _rtpOkPt(x.p) && x.name);
  return { pts, wpts };
}
async function _rtpEdit(slug, dep) {
  slug = String(slug || '').trim(); if (!slug || !dep || !dep.wr) return;
  const got = await _rtpRead(slug); // read fresh: what is saved replaces the whole stored route
  if (!got.ok) { toast(_rtpT('err'), 'error'); return; }
  _rtpCache[slug] = got.v;
  const tr = got.v || { pts: [], turns: [] };
  S._rtpEd = { slug, dep, pts: tr.pts.slice(), turns: tr.turns.map((x) => ({ km: String(x.km), en: x.en, ar: x.ar })), busy: false };
  _rtpEdPaint();
}
function _rtpEdMax(E) { const r = _rtpRoute(E.slug); return E.pts.length > 1 ? _rtpLenKm(E.pts) : (r.km || 1000); }
function _rtpEdPaint() {
  const E = S._rtpEd, m = document.getElementById('confirm-modal'); if (!E || !m) return;
  const r = _rtpRoute(E.slug), has = E.pts.length > 1;
  const fld = (i, k, lbl, val, attr) => `<div class="form-group"><label for="rtp-${k}-${i}">${esc(lbl)}</label><input id="rtp-${k}-${i}" ${attr} value="${esc(val)}" data-on-input="${_on('_rtpEdIn', i, k, _RTP_EL)}"></div>`;
  m.style.display = 'block';
  m.innerHTML = `<div class="modal-backdrop" data-on-click="${_on('_on_backdropOnly', _RTP_EV, _RTP_EL, '_rtpEdClose')}">
    <div class="confirm-box rtp-ed" role="dialog" aria-modal="true" aria-labelledby="rtp-ed-title">
      <div class="chrome-dh18"><div class="chrome-dt" id="rtp-ed-title">${esc(_rtpT('edTitle'))} · ${esc(r.name)}</div><button type="button" data-on-click="${_on('_rtpEdClose')}" aria-label="${esc(_rtpW().close)}" class="chrome-xt x-close">&times;</button></div>
      <div class="form-group"><label for="rtp-file">${esc(_rtpT('edFile'))}</label><input type="file" id="rtp-file" accept=".gpx,application/gpx+xml,application/xml,text/xml" data-on-change="${_on('_rtpEdFile', _RTP_EL)}"></div>
      <div class="rtp-line"><span id="rtp-line-txt">${esc(has ? _rtpF('edLine', E.pts.length, Math.round(_rtpLenKm(E.pts) * 100) / 100) : _rtpT('edNoLine'))}</span>${has ? `<button type="button" class="btn-sm btn-secondary" id="rtp-line-rm" data-on-click="${_on('_rtpEdNoLine')}">${esc(_rtpT('edRemove'))}</button>` : ''}</div>
      <div class="modal-title" id="rtp-ed-turns">${esc(_rtpT('turns'))}</div>
      <div role="group" aria-labelledby="rtp-ed-turns">${E.turns.map((x, i) => `<div class="rtp-row">${fld(i, 'km', _rtpT('edKm'), x.km, 'type="text" inputmode="decimal" maxlength="7" dir="ltr"')}${fld(i, 'en', _rtpT('edEn'), x.en, 'type="text" maxlength="60" dir="ltr"')}${fld(i, 'ar', _rtpT('edAr'), x.ar, 'type="text" maxlength="60" dir="rtl" lang="ar"')}<button type="button" class="btn-sm btn-secondary rtp-del" aria-label="${esc(_rtpF('edDel', i + 1))}" data-on-click="${_on('_rtpEdDel', i)}">&times;</button></div>`).join('')}</div>
      ${E.turns.length < RTP_MAX_TURNS ? `<button type="button" class="btn-sm btn-secondary" id="rtp-add" data-on-click="${_on('_rtpEdAdd')}">${esc(_rtpT('edAdd'))}</button>` : ''}
      <div class="modal-footer">
        <button type="button" class="btn-secondary" data-on-click="${_on('_rtpEdClose')}">${esc(_rtpT('cancel'))}</button>
        <button type="button" class="btn-primary" id="rtp-save" data-on-click="${_on('_rtpEdSave')}"${E.busy ? ' disabled' : ''}>${esc(_rtpT('save'))}</button>
      </div>
    </div>
  </div>`;
}
// A keystroke is kept and nothing is repainted, so the caret stays where it is.
function _rtpEdIn(i, k, el) { const E = S._rtpEd, x = E && E.turns[i]; if (x && (k === 'km' || k === 'en' || k === 'ar')) x[k] = String(el.value || ''); }
function _rtpEdAdd() { const E = S._rtpEd; if (!E || E.turns.length >= RTP_MAX_TURNS) return; E.turns.push({ km: '', en: '', ar: '' }); _rtpEdPaint(); const f = document.getElementById('rtp-km-' + (E.turns.length - 1)); if (f) try { f.focus(); } catch (_) {} }
function _rtpEdDel(i) { const E = S._rtpEd; if (!E) return; E.turns.splice(i, 1); _rtpEdPaint(); }
function _rtpEdNoLine() { const E = S._rtpEd; if (!E) return; E.pts = []; _rtpEdPaint(); }
async function _rtpEdFile(el) {
  const E = S._rtpEd, f = el && el.files && el.files[0]; if (!E || !f) return;
  let got = null;
  try { got = f.size > 20e6 ? null : _rtpParse(await f.text()); } catch (_) { got = null; }
  if (S._rtpEd !== E) return;
  if (!got) { toast(_rtpT('edBadFile'), 'error'); el.value = ''; return; }
  E.pts = _rtpThin(got.pts);
  // The file's own named waypoints become turn points where none are typed yet, each at the nearest point of the line.
  if (!E.turns.some((x) => x.en || x.ar || String(x.km).trim()) && got.wpts.length) {
    const cum = _rtpCum(E.pts);
    E.turns = got.wpts.slice(0, RTP_MAX_TURNS).map((w) => {
      let best = 0, bd = Infinity; E.pts.forEach((p, i) => { const d = _rtpDist(p, w.p); if (d < bd) { bd = d; best = i; } });
      return { km: String(Math.round(cum[best] / 100) / 10), en: w.name, ar: '' };
    }).sort((a, b) => Number(a.km) - Number(b.km));
  }
  _rtpEdPaint();
}
async function _rtpEdSave() {
  const E = S._rtpEd; if (!E || E.busy) return;
  const max = _rtpEdMax(E), turns = [];
  for (const x of E.turns) {
    const en = _rtpName(x.en), ar = _rtpName(x.ar), raw = String(x.km == null ? '' : x.km).trim();
    if (!en && !ar && !raw) continue; // a row left empty is not a turn point
    const km = _rtpNum(raw);
    if ((!en && !ar) || !isFinite(km) || km > max + 0.05) { toast(_rtpT('edBadTurn'), 'error'); return; }
    turns.push({ km: Math.round(Math.min(km, max) * 100) / 100, en, ar });
  }
  turns.sort((a, b) => a.km - b.km);
  const key = _rtpKey(E.slug), value = { v: 1, pts: E.pts.length > 1 ? E.pts : [], turns }, none = !value.pts.length && !turns.length;
  E.busy = true; _rtpEdPaint();
  // _wr says a refusal itself (the staff page's checked write) and answers true when the write did not land.
  const bad = await E.dep.wr(none ? sb.from('site_content').delete().eq('key', key) : sb.from('site_content').upsert({ key, value, updated_by: (E.dep.op && E.dep.op()) || null }), 'route line');
  E.busy = false;
  if (S._rtpEd !== E) return;
  if (bad) { _rtpEdPaint(); return; }
  _rtpCache[E.slug] = none ? null : _rtpClean(value);
  try { if (E.dep.log) E.dep.log(_rtpF('edLog', _rtpRoute(E.slug).name), { k: 'settings', e: 'site_content', id: key }); } catch (_) {}
  try { if (E.dep.done) E.dep.done(); } catch (_) {}
  _rtpEdClose();
}
function _rtpEdClose() {
  const m = document.getElementById('confirm-modal');
  if (m && S._rtpEd) { m.style.display = 'none'; m.innerHTML = ''; }
  S._rtpEd = null;
}
window._rtpOpen = _rtpOpen;
window._rtpEdit = _rtpEdit;
