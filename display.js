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
  var NEW_FOR_MS = 25000;      // a new row stays marked this long
  var MAX_ROWS = 42;
  var LATE_MIN = 10;           // waiting this many minutes turns amber

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
  var etag = null, last = null, lastOk = Date.now(), clockSkew = 0, seen = null, newAt = {}, timer = 0, audio = null, paintedAt = 0, paintedMin = -1;

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
    if (Date.now() - lastOk > OFFLINE_AFTER_MS) {
      document.body.classList.add('tv-offline');
      var at = $('tv-off-at'); if (at) at.textContent = clock(lastOk);
    }
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
      if (a === b) return '<div class="tv-size' + (a === 'Kids' ? ' tv-kids' : '') + '">' + sizeWord(a) + '</div>';
      return '<div class="tv-size tv-two"><span>Road ' + esc(a) + '</span><span>Hybrid ' + esc(b) + '</span></div>';
    }
    var z = fit(r.h, ty === 'Any' ? (area === 'road' ? 'Road' : 'Hybrid') : ty);
    return '<div class="tv-size' + (z === 'Kids' ? ' tv-kids' : '') + '">' + sizeWord(z) + '</div>';
  }
  function sizeWord(z) { return z === 'Kids' ? 'Kids <span lang="ar">أطفال</span>' : esc(z); }

  // the sessions' English names on one line, their Arabic names on the next (one line held both and cut the Arabic off)
  function sessLine(d) {
    var s = d.sessions || [];
    if (!s.length) return 'No session today';
    return s.map(function (x) { return esc(x.title || x.day || ''); }).join('  |  ');
  }
  function sessLineAr(d) {
    var s = d.sessions || [];
    if (!s.length) return 'لا توجد جلسة اليوم';
    return s.map(function (x) { return esc(x.title_ar || ''); }).filter(Boolean).join('  |  ');
  }

  // the board (the user's pick, 2026-11-28): one row per rider, oldest first, a party's rows kept together at its first
  // check-in (the feed's 'g', 20261128120000; without it every row stands alone). Up to 10 rows fill the screen; more
  // split into two columns (26), then three (42) with height and type left out; past that "+N more".
  function order(rows) {
    var groups = [], at = {};
    rows.forEach(function (r) {
      var k = r.g ? 'g' + r.g : 'r' + r.id;
      if (!at[k]) { at[k] = { list: [] }; groups.push(at[k]); }
      at[k].list.push(r);
    });
    var out = [];
    groups.forEach(function (g, gi) {
      g.list.sort(function (a, b) { return (Number(a.pos) || 0) - (Number(b.pos) || 0); });
      g.list.forEach(function (r, i) {
        var n = g.list.length;
        out.push({ r: r, gi: gi, join: n < 2 ? '' : i === 0 ? ' tv-pf' : i === n - 1 ? ' tv-pl' : ' tv-pm' });
      });
    });
    return out;
  }
  function waitMins(r) {
    var t = Date.parse(r.at || '');
    if (!(t > 0)) return null;
    return Math.max(0, Math.floor((Date.now() + clockSkew - t) / 60000));
  }
  function rowHtml(x, d, multi) {
    var r = x.r, ty = TYPE[r.type] || [r.type || 'Any', ''], isNew = !!newAt[r.id], m = waitMins(r);
    var of = Number(r.of) > 1 ? '<span class="tv-of">' + Number(r.pos) + ' of ' + Number(r.of) + '</span>' : '';
    var sess = '';
    if (multi) { var s = (d.sessions || []).filter(function (y) { return y.id === r.sid; })[0]; if (s) sess = '<span class="tv-of">' + esc(s.title || '') + '</span>'; }
    var tags = (isNew ? '<span class="tv-newtag">NEW · <span lang="ar">جديد</span></span>' : '') +
      (!r.area ? '<span class="tv-tag">Either area · <span lang="ar" dir="rtl">أي منطقة</span></span>' : '');
    var wait = isNew || m === 0 ? 'Just now' : m == null ? '' : m + ' min';
    return '<li class="tv-row' + x.join + (x.gi % 2 ? ' tv-alt' : '') + (isNew ? ' tv-new' : '') + '">' +
      '<div class="tv-num">#' + esc(r.n == null ? '' : r.n) + '</div>' +
      '<div class="tv-who"><bdi class="tv-name">' + esc(r.name || '') + '</bdi>' + of + sess + tags + '</div>' +
      '<div class="tv-h">' + (Number(r.h) > 0 ? Number(r.h) + ' <span>cm</span>' : '') + '</div>' +
      '<div class="tv-type">' + esc(ty[0]) + (ty[1] ? ' <span lang="ar" dir="rtl">' + esc(ty[1]) + '</span>' : '') + '</div>' +
      '<div class="tv-sz">' + sizeHtml(r, d.area === 'road' ? 'road' : 'hm') + '</div>' +
      '<div class="tv-wait' + (m != null && m >= LATE_MIN && !isNew ? ' tv-late' : '') + '">' + wait + '</div>' +
      '</li>';
  }
  var HEADS = '<div class="tv-heads"><div>BOOKING <span lang="ar">الحجز</span></div><div>RIDER <span lang="ar">الراكب</span></div>' +
    '<div class="tv-h">HEIGHT <span lang="ar">الطول</span></div><div class="tv-type">BIKE <span lang="ar">الدراجة</span></div>' +
    '<div class="tv-c">SIZE <span lang="ar">المقاس</span></div><div class="tv-r">WAITING <span lang="ar">الانتظار</span></div></div>';

  function paint(d) {
    var area = d.area === 'road' ? 'road' : 'hm', A = AREA[area];
    var rows = (d.rows || []).slice();
    var now = Date.now();
    // a row that was not there on the last paint is new (not on the first paint after a load)
    var ids = {}, fresh = false;
    rows.forEach(function (r) {
      ids[r.id] = 1;
      if (seen && !seen[r.id]) { newAt[r.id] = now; fresh = true; }
    });
    Object.keys(newAt).forEach(function (k) { if (!ids[k] || now - newAt[k] > NEW_FOR_MS) delete newAt[k]; });
    seen = ids;
    if (fresh) chime();

    var list = order(rows);
    var many = list.length > MAX_ROWS ? list.length - MAX_ROWS : 0;
    var shown = many ? list.slice(0, MAX_ROWS) : list;
    var cols = shown.length <= 10 ? 1 : shown.length <= 26 ? 2 : 3;
    var multi = (d.sessions || []).length > 1;
    document.body.className = 'tv-' + area + (cols > 1 ? ' tv-d' + cols : '');
    paintedAt = now;

    var head = '<header class="tv-top"><div class="tv-area"><span class="tv-area-en">' + esc(A.en) + '</span>' +
      '<span class="tv-area-ar" lang="ar" dir="rtl">' + esc(A.ar) + '</span></div>' +
      '<div class="tv-mid"><div class="tv-sess">' + sessLine(d) + (d.label ? ' · ' + esc(d.label) : '') + '</div>' +
      '<div class="tv-sub">' + (sessLineAr(d) ? '<span lang="ar" dir="rtl">' + sessLineAr(d) + '</span> · ' : '') + 'Oldest first</div></div>' +
      '<div class="tv-side"><div class="tv-count"><b>' + rows.length + '</b> waiting<br><span lang="ar" dir="rtl">بالانتظار</span></div>' +
      '<div class="tv-clock" id="tv-clock">' + clock() + '</div></div></header>' +
      '<div class="tv-off" role="status"><span>Reconnecting · this list is from <b id="tv-off-at">' + clock(paintedAt) + '</b> and may be out of date</span>' +
      '<span lang="ar" dir="rtl">جارٍ إعادة الاتصال · القائمة قد لا تكون محدّثة</span></div>';

    var body;
    if (!rows.length) {
      body = '<section class="tv-empty"><svg class="tv-bike" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5.5" cy="17" r="3.5"></circle><circle cx="18.5" cy="17" r="3.5"></circle><path d="M5.5 17 9 9h6l3.5 8M9 9 12 17h1.5M15 9l-1-3h-2.5"></path></svg>' +
        '<div class="tv-empty-en">Nobody waiting for a bike</div>' +
        '<div class="tv-empty-ar" lang="ar" dir="rtl">لا يوجد أحد بانتظار دراجته</div></section>';
    } else {
      var per = Math.ceil(shown.length / cols), parts = [];
      for (var c = 0; c < cols; c++) {
        var chunk = shown.slice(c * per, (c + 1) * per);
        if (chunk.length) parts.push('<div class="tv-col">' + HEADS + '<ol class="tv-list">' + chunk.map(function (x) { return rowHtml(x, d, multi); }).join('') + '</ol></div>');
      }
      body = '<section class="tv-board">' + parts.join('') + '</section>' +
        (many ? '<div class="tv-more">+' + many + ' more · <span lang="ar" dir="rtl">+' + many + ' آخرون</span></div>' : '');
    }
    $('tv').innerHTML = head + body;
  }

  // the Riyadh time by the database's clock (a TV's own clock is often wrong)
  function clock(ms) {
    var t = new Date((ms || Date.now()) + clockSkew + 3 * 3600000);
    var h = t.getUTCHours(), m = t.getUTCMinutes();
    return (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m + (h < 12 ? ' AM' : ' PM');
  }
  function paintClock() { var c = $('tv-clock'); if (c) c.textContent = clock(); }
  setInterval(function () {
    paintClock();
    if (!last || document.body.classList.contains('tv-offline')) return;
    var n = Date.now(), mi = Math.floor((n + clockSkew) / 60000);
    if (mi !== paintedMin || Object.keys(newAt).some(function (k) { return n - newAt[k] > NEW_FOR_MS; })) { paintedMin = mi; paint(last); }
  }, 5000);

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
