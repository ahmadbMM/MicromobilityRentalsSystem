// The bike collection areas' TVs (display.html, 2026-11-21; migration 20261121120000). A TV has no staff login: it pairs
// with a 6-digit code that a Bookings editor types on Bookings > Collection > TV screens, then reads screen_feed with the
// secret it keeps, every few seconds. Nothing on it is tapped. Plain ES2017, no libraries: an old Fire TV stick's WebView
// runs it. SUPABASE_URL and SUPABASE_KEY are stamped by scripts/build-html.mjs from app.src.html (the staging build's
// copy then names the staging database); never edit them by hand.
(function () {
  'use strict';
const SUPABASE_URL = 'https://qpffkzmsfyilicwcsszz.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFwZmZrem1zZnlpbGljd2Nzc3p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNDQwODAsImV4cCI6MjEwNTgyMDA4MH0.K6qZpK0oR4MXIaFk4DRJGy-H_m6BYnJ-S31swTiHMhQ';

  var TOKEN_KEY = 'mm_tv_token';
  var POLL_MS = 3000;          // paired: a few bytes per tick while nothing moves (the etag)
  var PAIR_POLL_MS = 3000;     // waiting for staff to type the code
  var OFFLINE_AFTER_MS = 15000;
  var NEW_FOR_MS = 25000;      // a new card stays marked this long
  var MAX_CARDS = 42;

  var AREA = {
    road: { en: 'Road bikes', ar: 'دراجات الطريق' },
    hm: { en: 'Hybrid & Mountain bikes', ar: 'الدراجات الهجينة والجبلية' }
  };
  var TYPE = {
    'Road': ['Road', 'طريق'], 'Road Carbon': ['Road Carbon', 'طريق كربون'], 'Hybrid': ['Hybrid', 'هجين'],
    'Mountain': ['Mountain', 'جبلي'], 'Kids': ['Kids', 'أطفال'], 'Gravel': ['Gravel', 'حصى'], 'Any': ['Any', 'أي نوع']
  };
  // The owner's chart (2026-09-29), as app.src.html's SIZE_CHART; Settings' own copy replaces it when the feed has one.
  var CHART = { Road: [[159, 'XS'], [172, 'S'], [179, 'M'], [189, 'L'], [Infinity, 'XL']], Hybrid: [[159, 'XS'], [170, 'S'], [185, 'M'], [Infinity, 'L']] };
  var KIDS_MAX = 144;

  var token = read(TOKEN_KEY);
  var etag = null, last = null, lastOk = Date.now(), clockSkew = 0, seen = null, newAt = {}, timer = 0, audio = null;

  function read(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function write(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) { /* storage off: pairs again after a reload */ } }
  function esc(s) { return s == null ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function $(id) { return document.getElementById(id); }

  function rpc(fn, body) {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctl) ctl.abort(); }, 10000);
    return fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST', cache: 'no-store', signal: ctl ? ctl.signal : undefined,
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      clearTimeout(to);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }, function (e) { clearTimeout(to); throw e; });
  }

  function later(fn, ms) { clearTimeout(timer); timer = setTimeout(fn, ms); }

  // ── pairing ──────────────────────────────────────────────────────────────────────────────────
  function startPairing() {
    rpc('screen_pair_start').then(function (d) {
      if (!d || !d.ok || !d.token) { paintPairErr(); later(startPairing, 30000); return; }
      token = d.token; write(TOKEN_KEY, token); etag = null;
      paintPair(d.code);
      later(tick, PAIR_POLL_MS);
    }, function () { offline(); later(startPairing, 10000); });
  }
  function paintPair(code) {
    document.body.className = 'tv-pairing';
    $('tv').innerHTML = '<section class="tv-pair">' +
      '<h1>Pair this TV<span lang="ar" dir="rtl">ربط هذه الشاشة</span></h1>' +
      '<div class="tv-code" aria-label="Pairing code">' + esc(String(code || '').replace(/(\d{3})(\d{3})/, '$1 $2')) + '</div>' +
      '<p class="tv-how">On a staff device open Bookings, then Collection, then TV screens, choose Pair a TV and enter this code.</p>' +
      '<p class="tv-how" lang="ar" dir="rtl">من جهاز الموظفين افتح الحجوزات ثم الاستلام ثم الشاشات، واختر ربط شاشة وأدخل هذا الرمز.</p>' +
      '</section>';
  }
  function paintPairErr() {
    document.body.className = 'tv-pairing';
    $('tv').innerHTML = '<section class="tv-pair"><p class="tv-err">Could not get a pairing code. Trying again shortly.</p>' +
      '<p class="tv-err" lang="ar" dir="rtl">تعذر الحصول على رمز الربط. ستتم المحاولة مرة أخرى قريباً.</p></section>';
  }

  // ── the feed ─────────────────────────────────────────────────────────────────────────────────
  function tick() {
    if (!token) { startPairing(); return; }
    rpc('screen_feed', { p_token: token, p_etag: etag }).then(function (d) {
      lastOk = Date.now(); document.body.classList.remove('tv-offline');
      if (!d || d.state === 'unknown') { token = ''; write(TOKEN_KEY, ''); last = null; seen = null; startPairing(); return; }
      if (d.now) clockSkew = Date.parse(d.now) - Date.now();
      if (d.state === 'pairing') { paintPair(d.code); later(tick, PAIR_POLL_MS); return; }
      if (d.state === 'paired') { etag = d.etag; last = d; applyChart(d); paint(d); }
      else if (last) paintClock();
      later(tick, POLL_MS);
    }, function () { offline(); later(tick, POLL_MS * 2); });
  }
  function offline() {
    if (Date.now() - lastOk > OFFLINE_AFTER_MS) document.body.classList.add('tv-offline');
  }

  function applyChart(d) {
    KIDS_MAX = typeof d.kids_max === 'number' && d.kids_max >= 80 && d.kids_max <= 200 ? d.kids_max : 144;
    var c = d.chart, ok = function (r) { return Array.isArray(r) && r.length > 0 && r.every(function (x) { return Array.isArray(x) && typeof x[1] === 'string'; }); };
    if (c && ok(c.Road) && ok(c.Hybrid)) {
      var inn = function (r) { return r.map(function (x) { return [x[0] == null ? Infinity : Number(x[0]), x[1]]; }); };
      CHART = { Road: inn(c.Road), Hybrid: inn(c.Hybrid) };
    }
  }
  // as app.src.html's bikeFit: 'Kids' at or under the limit, else the type's chart (Mountain reads Hybrid's, a type with
  // no chart reads Road's)
  function fit(h, ty) {
    h = Number(h); if (!(h > 0)) return '';
    if (h <= KIDS_MAX) return 'Kids';
    var base = ty === 'Road Carbon' ? 'Road' : ty === 'Mountain' ? 'Hybrid' : ty;
    var rows = CHART[base] || CHART.Road;
    for (var i = 0; i < rows.length; i++) if (h <= rows[i][0]) return rows[i][1];
    return rows[rows.length - 1][1];
  }
  function sizeHtml(r, area) {
    var ty = r.type || 'Any';
    if (!(Number(r.h) > 0)) return r.size ? '<div class="tv-size">' + esc(r.size) + '</div>' : '';
    if (ty === 'Any' && !r.area) { // an Any booking still to be sent to one area: both charts' sizes
      var a = fit(r.h, 'Road'), b = fit(r.h, 'Hybrid');
      if (a === b) return '<div class="tv-size">' + sizeWord(a) + '</div>';
      return '<div class="tv-size tv-two"><small>Road</small>' + sizeWord(a) + '<br><small>Hybrid</small>' + sizeWord(b) + '</div>';
    }
    var z = fit(r.h, ty === 'Any' ? (area === 'road' ? 'Road' : 'Hybrid') : ty);
    return '<div class="tv-size' + (z === 'Kids' ? ' tv-two' : '') + '">' + sizeWord(z) + '</div>';
  }
  function sizeWord(z) { return z === 'Kids' ? 'Kids<br><span lang="ar">أطفال</span>' : esc(z); }

  function sessLine(d) {
    var s = d.sessions || [];
    if (!s.length) return 'No session today · <span lang="ar" dir="rtl">لا توجد جلسة اليوم</span>';
    return s.map(function (x) { return esc(x.title || x.day || '') + (x.title_ar ? ' · <span lang="ar" dir="rtl">' + esc(x.title_ar) + '</span>' : ''); }).join('  |  ');
  }

  function paint(d) {
    var area = d.area === 'road' ? 'road' : 'hm', A = AREA[area];
    var rows = (d.rows || []).slice();
    var now = Date.now();
    // a card that was not there on the last paint is new (not on the first paint after a load)
    var ids = {}, fresh = false;
    rows.forEach(function (r) {
      ids[r.id] = 1;
      if (seen && !seen[r.id]) { newAt[r.id] = now; fresh = true; }
    });
    Object.keys(newAt).forEach(function (k) { if (!ids[k] || now - newAt[k] > NEW_FOR_MS) delete newAt[k]; });
    seen = ids;
    if (fresh) chime();

    var many = rows.length > MAX_CARDS ? rows.length - MAX_CARDS : 0;
    var shown = many ? rows.slice(0, MAX_CARDS) : rows;
    var dens = shown.length <= 12 ? '' : shown.length <= 20 ? ' tv-d2' : ' tv-d3';
    var multi = (d.sessions || []).length > 1;
    document.body.className = 'tv-' + area + dens;

    var head = '<header class="tv-top"><div class="tv-area"><div class="tv-area-en">' + esc(A.en) + (d.label ? ' · ' + esc(d.label) : '') + '</div>' +
      '<div class="tv-area-ar" lang="ar" dir="rtl">' + esc(A.ar) + '</div>' +
      '<div class="tv-sess">' + sessLine(d) + '</div></div>' +
      '<div class="tv-side"><div class="tv-clock" id="tv-clock">' + clock() + '</div>' +
      '<div class="tv-count">' + rows.length + ' waiting · <span lang="ar" dir="rtl">' + rows.length + ' بالانتظار</span></div>' +
      '<div class="tv-off">Reconnecting… · <span lang="ar" dir="rtl">جارٍ إعادة الاتصال…</span></div></div></header>';

    var body;
    if (!rows.length) {
      body = '<section class="tv-empty"><div class="tv-empty-en">No riders waiting for a bike</div>' +
        '<div class="tv-empty-ar" lang="ar" dir="rtl">لا يوجد أحد بانتظار دراجته</div></section>';
    } else {
      body = '<ol class="tv-grid">' + shown.map(function (r) {
        var ty = TYPE[r.type] || [r.type || 'Any', ''];
        var of = Number(r.of) > 1 ? ' <span class="tv-of">· ' + Number(r.pos) + ' of ' + Number(r.of) + '</span>' : '';
        var sess = multi ? (function () { var s = (d.sessions || []).filter(function (x) { return x.id === r.sid; })[0]; return s ? '<span>' + esc(s.title || '') + '</span>' : ''; })() : '';
        var either = !r.area ? '<span class="tv-tag">Either area · <span lang="ar" dir="rtl">أي منطقة</span></span>' : '';
        return '<li class="tv-card' + (newAt[r.id] ? ' tv-new' : '') + '">' +
          '<div class="tv-num">#' + esc(r.n == null ? '' : r.n) + '</div>' +
          sizeHtml(r, area) +
          '<div class="tv-who"><bdi>' + esc(r.name || '') + '</bdi>' + of + '</div>' +
          '<div class="tv-spec">' + (Number(r.h) > 0 ? '<span><b>' + Number(r.h) + '</b> cm</span>' : '') +
          '<span><b>' + esc(ty[0]) + '</b>' + (ty[1] ? ' <span lang="ar" dir="rtl">' + esc(ty[1]) + '</span>' : '') + '</span>' + either + sess + '</div>' +
          '</li>';
      }).join('') + (many ? '<li class="tv-more">+' + many + ' more · <span lang="ar" dir="rtl">+' + many + ' آخرون</span></li>' : '') + '</ol>';
    }
    $('tv').innerHTML = head + body;
  }

  // the Riyadh time by the database's clock (a TV's own clock is often wrong)
  function clock() {
    var t = new Date(Date.now() + clockSkew + 3 * 3600000);
    var h = t.getUTCHours(), m = t.getUTCMinutes();
    return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? ' AM' : ' PM');
  }
  function paintClock() { var c = $('tv-clock'); if (c) c.textContent = clock(); }
  setInterval(function () { paintClock(); if (last) { var n = Date.now(); if (Object.keys(newAt).some(function (k) { return n - newAt[k] > NEW_FOR_MS; })) paint(last); } }, 5000);

  // two short notes (the calling screen's chime, app.src.html _qclChime); a TV that refuses sound stays silent
  function chime() {
    try {
      var C = window.AudioContext || window.webkitAudioContext; if (!C) return;
      if (!audio) audio = new C();
      if (audio.state === 'suspended' && audio.resume) audio.resume();
      var t0 = audio.currentTime + 0.05;
      [[880, 0], [1320, 0.22]].forEach(function (p) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = p[0];
        g.gain.setValueAtTime(0.0001, t0 + p[1]);
        g.gain.exponentialRampToValueAtTime(0.35, t0 + p[1] + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + p[1] + 0.5);
        o.connect(g); g.connect(audio.destination); o.start(t0 + p[1]); o.stop(t0 + p[1] + 0.55);
      });
    } catch (e) { /* no sound on this TV */ }
  }

  // a page left open for days: read again whole once a night (04:00 Riyadh), so a deploy reaches the TV
  setInterval(function () {
    var t = new Date(Date.now() + clockSkew + 3 * 3600000);
    if (t.getUTCHours() === 4 && t.getUTCMinutes() < 1 && performance.now() > 3600000) location.reload();
  }, 50000);

  tick();
})();
