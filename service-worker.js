
const CACHE = 'mmcq-48e0ceafc8';

// The one key the app shell lives under. './index.html' is deliberately NOT precached and
// never used as a key: Cloudflare Pages answers /index.html with a 308 to /, so caching it
// stored a response that carries redirect history — and such a response cannot back a
// navigation. Safari refuses it by name ("Response served by service worker has
// redirections"), Chrome fails the load with ERR_FAILED. Because the entry was written at
// install time, every visit after the worker installed died on it, for good. './' is the
// canonical shell URL and does not redirect.
const SHELL_KEY = './';
// The app's own addresses (2026-09-27): every section and sub-view has one (/bookings/waitlist,
// /community/applications, /my-bookings...). They are answered with the shell like the root, so
// a deep link opens offline too; the same list is in functions/_middleware.js (APP_ROUTE) and
// app.src.html (STAFF_PATHS, CUST_PATHS, SUB_PATHS), and tests/paths.spec.ts checks they agree.
// On the live customer host a staff address is not the shell's: the server sends it on to the
// staff address, and the worker lets it through to the network so that it can.
const APP_ROUTE = /^\/(?:reserve|my-bookings|account|signup|bookings|dashboard|sales|inventory|workshop|customers|community|ambassadors|vendors|website|messages|analytics|history|team|settings)(?:\/[a-z0-9-]+){0,2}\/?$/;
const STAFF_ROUTE = /^\/(?:bookings|dashboard|sales|inventory|workshop|customers|community|ambassadors|vendors|website|messages|analytics|history|team|settings)(?:\/|$)/;
const LIVE_CUSTOMER_HOST = self.location.hostname === 'micromobilityrentals.pages.dev';
const shellPage = (p) => p === '/' || p === '/index.html' || (APP_ROUTE.test(p) && !(LIVE_CUSTOMER_HOST && STAFF_ROUTE.test(p)));
// The staff half of the app rides in the shell on every host but the live customer one, so the
// desk opens offline and after a deploy the new file is already on the device; its own hash is in
// the name (the build stamps it), so a new build is a new entry and the old one just ages out.
const STAFF_JS = './staff.js?v=4bf673de1d';
// The page's own script and stylesheet (2026-10-01: out of the page into files named by their hash).
// The shell cannot open offline without them. styles.css is the whole stylesheet the staff loader
// adds over app.css, so it rides with staff.js.
// The staff half's parts (staff-parts/, 2026-10-01): the build stamps the list, each by its hash.
const STAFF_PARTS = ["./staff-parts/analytics.js?v=4529142ffa","./staff-parts/community.js?v=ec8cc55e79","./staff-parts/bikes.js?v=796cc0ddb5","./staff-parts/cashier.js?v=c1ad19dc1a","./staff-parts/catalog.js?v=4509fe079a","./staff-parts/inventory.js?v=a3bb7cdee4","./staff-parts/website.js?v=db399fc2b9","./staff-parts/history.js?v=1595da51bd","./staff-parts/workshop.js?v=a7f6eff88c","./staff-parts/ambassadors.js?v=defd7101f3","./staff-parts/messages.js?v=ef3959ad79","./staff-parts/vendors.js?v=5b0c5bcf3f","./staff-parts/sela.js?v=618b38d741","./staff-parts/vlap.js?v=55ce8526c6","./staff-parts/imports.js?v=db96f3cce4","./staff-parts/team.js?v=b593dfecfc","./staff-parts/settings.js?v=f25596eb7c","./staff-parts/fleet.js?v=a85c4efcf2","./staff-parts/money.js?v=7199fa4f4c","./staff-parts/desk.js?v=0d9911ac8e","./staff-parts/deskq.js?v=fd60a446ee","./staff-parts/kiosk.js?v=83e3c36c38","./staff-parts/deposits.js?v=d1b3508fed","./staff-parts/remind.js?v=815114a4e2"];
const APP_JS = './app.js?v=2b44998a3f';
const APP_CSS = './app.css?v=94671d70e3';
const SHELL = [
  SHELL_KEY,
  APP_JS,
  APP_CSS,
  ...(LIVE_CUSTOMER_HOST ? [] : [STAFF_JS, ...STAFF_PARTS, './styles.css?v=35862bc5e9']),
  './manifest.json',
  './logo.webp', // the page's logos are lossless WebP since 2026-10-01 (the PNGs still ship, for links from elsewhere)
  './logo-dark.webp',
  './logo-mark-dark.webp',
  './jcc.webp',
  './jcc-white.webp',
  './brand.png',
  './assets/brand-mark-white.svg', // the loading state's mask - the boot screen needs it offline
  './assets/snd96-logo.svg', // the National Day lockup - on the event picker, the first screen in
  './assets/mm-pattern.svg', // the brand pattern behind the Micromobility Experiences card - same screen
  './assets/runher-partners.webp', // the partners' marks on the Run for Her card - same screen
  './assets/victory-lap-dark.webp', // Victory Lap's logo on its card and tickets - same screen (2026-10-17)
  './assets/defe-logo.svg', // the Defe run's logo on its date card, flow and ticket (2026-10-18)
  './hero.webp',
  './icon-192.png',
  './icon-512.png',
  // What a ticket needs to open with no signal (2026-10-10): the database library (the boot waits for it), the
  // QR library (loaded when a ticket draws; without it the code was an empty tile), the stylesheet of the fonts
  // and the faces a ticket is set in. A rider offline at the Corniche after a deploy had none of them.
  './vendor/supabase-js-2.117.2.min.js',
  './vendor/qrcode-generator-2.0.4.js',
  './fonts/fonts.css?v=4c46a0e230',
  './fonts/SpaceGrotesk-var-latin.woff2',
  './fonts/ChakraPetch-700-latin.woff2',
  './fonts/Riyal-400.woff2',
  './fonts/Riyal-700.woff2',
];

// Checked against the server, never taken from the browser's HTTP cache as it is: the images here
// are cached for a week without a version in their names, so a new version's cache could be
// filled with the image the last deploy replaced, and keep it until the next version. 'no-cache'
// asks the server with the copy's ETag and takes the copy only when the server says it is still
// right. It used to be 'reload', which ignored the copy the page had just downloaded and fetched
// index.html, styles.css and every image a second time on every first visit - about 690 KB - and
// again after every deploy that changed this file (2026-09-27 review).
// A file named by its own hash (?v=) is the same file whichever deploy names it (2026-10-09): one the last
// version's cache already holds is copied over instead of downloaded again. A deploy that changed one part
// of the staff half used to send every device the whole half, the stylesheet and app.js once more.
// Named by version (vendor/, fonts/, lang/, a ?v= hash): whatever the HTTP cache holds is right.
const PINNED = /^\/(?:vendor|fonts|lang)\//;
const versioned = (u) => /[?&]v=[a-f0-9]{10}\b/.test(u) || PINNED.test(new URL(u, self.location.href).pathname);
function precache(c, u) {
  const fresh = () => c.add(new Request(u, { cache: 'no-cache' }));
  if (!versioned(u)) return fresh();
  return caches.match(u).then((hit) => (hit && hit.ok ? c.put(u, hit) : fresh())).catch(fresh);
}
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => precache(c, u)))).then(() => self.skipWaiting()));
});

// Before the old version's caches go, whatever they hold that is named by its version (a font, a library, a
// translation pack, a file with its ?v= hash) moves into this one (2026-10-10). Every deploy used to delete the
// QR library, the fonts and the packs a phone had stored, so an offline rider after a deploy met a blank code,
// system fonts and a 7-second wait. A file this version already holds is left as it is.
// One copy per file (2026-10-14): every older ?v= of a file came along too, so app.js, staff.js, the staff
// parts and the packs of every deploy piled up in the cache for good (megabytes a deploy on a staff device).
// A file this version precached under its own ?v= (the halves, the stylesheets) takes nothing from the old
// caches, and of anything else only the newest copy (its Date) comes over.
function carryOver() {
  const pathOf = (u) => new URL(u, self.location.href).pathname;
  return caches.keys().then((keys) => caches.open(CACHE).then((c) => c.keys().then((own) => {
    const have = new Set(own.map((r) => pathOf(r.url)));
    const best = new Map();
    return Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('mmcq-') && k !== 'mmcq-img').map((k) =>
      caches.open(k).then((old) => old.keys().then((reqs) => Promise.all(reqs.filter((r) => versioned(r.url) && !have.has(pathOf(r.url))).map((r) =>
        old.match(r).then((res) => {
          if (!res || !res.ok) return;
          const p = pathOf(r.url), at = Date.parse(res.headers.get('date') || '') || 0, cur = best.get(p);
          if (!cur || at >= cur.at) best.set(p, { r, res, at });
        })))))))
      .then(() => Promise.all([...best.values()].map(({ r, res }) => c.put(r, res))));
  }))).catch(() => {});
}

self.addEventListener('activate', (e) => {
  // An older version's cache means this activation is an UPDATE, not a first install (2026-10-05).
  // The hourly reg.update() of a tab left open installs, activates and claims a new worker, but
  // only the navigation refresh below ever said 'shell-updated', and an open tab never navigates:
  // it ran the old build until someone reloaded it. So the open windows are told here as well.
  let updated = false;
  e.waitUntil(
    // Everything but this version's cache goes, including the old 'mmcq-img' photo cache (see the
    // note at the end of the fetch handler), once what is named by its version has been carried over.
    carryOver().then(() => caches.keys()).then((keys) => {
      updated = keys.some((k) => k !== CACHE && k !== 'mmcq-img' && k.startsWith('mmcq-'));
      return Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    })
      // Evict the poisoned shell entry left by earlier versions. The cache NAME is a hash of
      // the files the site ships (scripts/build-html.mjs), so a worker-only fix does not
      // rotate it — without this delete, a device already broken by the redirected
      // './index.html' entry would stay broken even after installing this worker.
      .then(() => caches.open(CACHE).then((c) => c.delete('./index.html')).catch(() => {}))
      .then(() => self.clients.claim())
      .then(() => updated && self.clients.matchAll({ type: 'window' }).then((cs) => cs.forEach((c) => c.postMessage({ type: 'shell-updated' }))))
  );
});

// A response that followed a redirect cannot be handed to a navigation — the browser rejects
// the whole load rather than the response. Rebuilding it drops the redirect history while
// keeping the body, status and headers.
// The hold page (functions/_middleware.js) is a 503 marked x-mm-hold. Its mark is kept in this cache
// under a key that is no file of the site (the build checks every './' entry here ships).
const HOLD_KEY = '/__mm-hold';
const isHold = (res) => !!res && res.status === 503 && res.headers.get('x-mm-hold') === '1';

function navSafe(res) {
  if (!res || !res.redirected) return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// The page names its script and stylesheet by hash, and the server answers any ?v= with today's file.
// A page stored here by the refresh below, under a worker that has not yet updated, would ask for
// files this cache never held, and a deploy later the network would hand it NEWER ones than it was
// built with. So the refresh stores the files the new page names alongside it, fetched while they
// are still the ones it was built with.
// On a staff device that holds the staff half too: the shell's styles.css, the staff.js its app.js names and
// the parts staff.js names (STAFF_PARTS_V). Only app.js/app.css were kept, so a later deploy handed the stored
// app.js NEWER staff code, and offline the staff half did not load (bug hunt 2026-10-28). A rider's phone,
// which never loaded staff.js, is not made to download it.
function pageFiles(cache, res) {
  const keep = (u) => {
    const req = new Request('.' + u);
    return cache.match(req).then((hit) => hit || fetch(req).then((r) => (r.ok ? cache.put(req, r.clone()).then(() => r) : null)));
  };
  const parts = (r) => r.clone().text().then((sj) => {
    const m = sj.match(/STAFF_PARTS_V=(\{[^}]*\})/);
    let v = {};
    try { v = m ? JSON.parse(m[1]) : {}; } catch (_) { v = {}; }
    return Promise.all(Object.keys(v).filter((n) => /^[a-z-]+$/.test(n) && /^[a-f0-9]{10}$/.test(String(v[n]))).map((n) => keep(`/staff-parts/${n}.js?v=${v[n]}`)));
  });
  const staffJs = (r) => r.clone().text().then((js) => {
    const m = js.match(/\/staff\.js\?v=[a-f0-9]{10}/);
    return m ? keep(m[0]).then((sr) => (sr ? parts(sr) : null)) : null;
  });
  const staffDevice = /^staff\./i.test(self.location.hostname) ? Promise.resolve(true)
    : cache.keys().then((ks) => ks.some((k) => /\/staff\.js\?v=/.test(k.url)), () => false);
  return Promise.all([res.text(), staffDevice]).then(([html, staff]) => Promise.all(
    [...new Set(html.match(staff ? /\/(?:app\.js|app\.css|styles\.css)\?v=[a-f0-9]{10}/g : /\/(?:app\.js|app\.css)\?v=[a-f0-9]{10}/g) || [])].map((u) =>
      keep(u).then((r) => (staff && r && /^\/app\.js\?/.test(u) ? staffJs(r) : null)))
  )).catch(() => {});
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; 
  const url = new URL(req.url);

  // Auth callbacks (Google OAuth PKCE "?code=", magic-link / recovery, "?error=") come back
  // as a navigation to our origin carrying auth params. Safari refuses a service-worker
  // response that has redirect history for a navigation ("Response served by service worker
  // has redirections"), which breaks Google sign-in. Don't intercept these — let the browser
  // navigate natively so supabase-js can read the params.
  if (req.mode === 'navigate' &&
      /[?&](code|state|error|error_description|error_code|access_token|refresh_token|provider_token|token_hash)=/.test(url.search)) {
    return;
  }


  // The page shell: serve the cached index.html INSTANTLY (no network wait), and refresh
  // it in the background for next time (stale-while-revalidate). A new deploy therefore
  // applies on the next load rather than blocking this one. First-ever visit (nothing
  // cached) falls back to the network.
  // ...but ONLY for the root and the app's own addresses (shellPage). Every in-scope navigation
  // used to be answered from this one cache entry and written back to it, so /staff/ - a real
  // page whose whole job is to set the staff-entry flag and bounce to / - was served the
  // customer app instead and never ran, and the background refresh then stored that stub UNDER
  // the root key, handing the next visitor to / a page that bounces them into the staff entry.
  // Anything else goes to the network and is never cached as the shell; and what IS stored
  // under the shell key is always a fetch of the root itself, never of the page asked for.
  if (req.mode === 'navigate' && url.origin === self.location.origin && !shellPage(url.pathname)) {
    return;
  }
  if (req.mode === 'navigate') {
    e.respondWith(
      Promise.all([caches.match(SHELL_KEY), caches.match(HOLD_KEY)]).then(([cached, held]) => {
        let stored = Promise.resolve(); // the refresh's write to the cache, for waitUntil below
        let mark = Promise.resolve(); // the hold mark's write or removal, kept alive the same way (bug hunt 2026-10-28)
        const refresh = fetch(new Request(SHELL_KEY, { cache: 'no-cache' })).then((res) => {
          const safe = navSafe(res); // never store redirect history under the shell key
          if (isHold(safe)) {
            // The site is on hold (functions/_middleware.js, MM_HOLD): remember it, so the next
            // navigation shows the hold page instead of the cached app, and tell open pages to
            // reload into it - an open app would otherwise go on writing to the database.
            mark = caches.open(CACHE).then((c) => c.put(HOLD_KEY, new Response('1'))).catch(() => {});
            if (!held) self.clients.matchAll({ type: 'window' }).then((cs) => cs.forEach((c) => c.postMessage({ type: 'mm-hold' })));
            return safe;
          }
          if (safe && safe.ok && held) mark = caches.open(CACHE).then((c) => c.delete(HOLD_KEY)).catch(() => {});
          if (safe && safe.ok) {
            const copy = safe.clone();
            // If the shell actually changed (new deploy), tell open pages so they can refresh
            // themselves — otherwise a stale (possibly buggy) build keeps running for a full visit.
            const newTag = safe.headers.get('etag');
            const oldTag = cached && cached.headers.get('etag');
            const changed = !!cached && (!newTag || !oldTag || newTag !== oldTag);
            const page = safe.clone();
            stored = caches.open(CACHE).then((c) => c.put(SHELL_KEY, copy).then(() => pageFiles(c, page))).then(() => {
              if (changed) self.clients.matchAll({ type: 'window' }).then((cs) => cs.forEach((c) => c.postMessage({ type: 'shell-updated' })));
            });
          }
          return safe;
        });
        // The cached shell answers instantly; the refresh keeps running for next time. With
        // nothing cached yet, the navigation waits on the network as any first visit does.
        // On hold, the network answers first: the hold page while it lasts, the app once it is over
        // (the hold page reloads itself every minute). Offline, the cached app is all there is.
        // A 5xx or a 522 while the mark is set (the hold lifted by a deploy that is still landing) is not the
        // page: the cached app answers it, as it does a network failure (bug hunt 2026-10-28).
        if (held) {
          try { e.waitUntil(refresh.then(() => Promise.all([stored, mark])).catch(() => {})); } catch (_) { /* the refresh still runs */ }
          return refresh.then((r) => (isHold(r) || (r && r.ok) || !cached ? r : navSafe(cached)), () => (cached ? navSafe(cached) : Response.error()));
        }
        // The refresh outlives the answer, so the worker is kept alive until it is stored: once the
        // cached shell has answered, nothing else held the worker, and the browser may stop an idle
        // one before the new shell was written (2026-10-07).
        if (cached) {
          const kept = refresh.then(() => Promise.all([stored, mark])).catch(() => {});
          try { e.waitUntil(kept); } catch (_) { /* the event is over: the refresh still runs */ }
          return navSafe(cached);
        }
        return refresh;
      })
    );
    return;
  }

  
  // Same-origin (incl. the self-hosted vendor/ libraries): cache-first, then network.
  // Nothing here is revalidated, so a cached copy has to be right for as long as this cache
  // lives: the cache NAME hashes every file the site ships (scripts/build-html.mjs), and the
  // translation packs and city lists are asked for by their own content hash.
  // The Pages Functions are never cached: an answer from /api is about now, not about this version.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;
  if (url.origin === self.location.origin) {
    // Anything else is asked of the server again (a 304 when it has not changed), for the same
    // reason as at install: this copy is kept for the life of the cache.
    const pinned = PINNED.test(url.pathname) || url.searchParams.has('v');
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req, pinned ? undefined : { cache: 'no-cache' }).then((res) => {
        // Only cache successes: caching a 404 (e.g. an image that ships in a later deploy)
        // would pin the failure until the next cache-version bump.
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // Supabase Storage photos are left to the browser. The worker used to keep them in a cache of
  // its own, but an <img> fetches cross-origin in no-cors mode, so every answer was opaque
  // (res.ok false) and nothing was ever stored - it only added a hop. Storing opaque answers is
  // no fix (each one counts megabytes against the origin's quota), and none is needed: photos
  // are uploaded with a one-year Cache-Control and content-addressed names, so the HTTP cache
  // already serves repeat views.
});

// ── Web Push ────────────────────────────────────────────────────────────────
// Waitlist promotion used to depend on a 25-second banner appearing on whichever staff
// phone happened to be awake. This is the other end of that: the rider's own device gets
// told, whether or not the site is open.
//
// The payload is JSON: { title, body, url, tag }. A push that arrives without a decodable
// payload still shows something rather than nothing — a silent push that shows no
// notification gets the site's push permission revoked by the browser.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { /* keep the fallback */ }
  const title = d.title || 'MicroMobility';
  const opts = {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    // Same tag replaces an earlier notification for the same booking instead of stacking.
    tag: d.tag || 'mm-general',
    renotify: true,
    data: { url: d.url || './' },
    dir: d.dir || 'auto',
    lang: d.lang || 'en',
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

// Tapping the notification focuses an open tab if there is one — opening a second copy of
// an installed PWA is disorienting — and otherwise opens the app at the given URL.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // Only an address on this site is opened; anything else (another origin, javascript:, a
  // malformed value) opens the app's start page instead.
  let target = new URL('./', self.location.origin + '/').href;
  try {
    const u = new URL((e.notification.data && e.notification.data.url) || './', self.location.origin + '/');
    if (u.origin === self.location.origin) target = u.href;
  } catch (_) { /* keep the start page */ }
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        // navigate() answers a promise, and rejects for a window this worker does not control
        // (includeUncontrolled above); a rejection there must not go unhandled. Such a window is
        // left alone and the target opened in a window of its own instead.
        if ('focus' in w) {
          const href = target;
          let nav = null;
          try { nav = w.navigate ? w.navigate(href) : null; } catch (_) { nav = null; }
          return Promise.resolve(nav).then((r) => (r || w).focus(), () => self.clients.openWindow(href));
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

// The push service can rotate a subscription out from under us. Tell any open tab so it
// re-subscribes and re-registers; if none is open, the next visit's subscribe() call does it.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((wins) => wins.forEach((w) => w.postMessage({ type: 'push-resubscribe' })))
  );
});
