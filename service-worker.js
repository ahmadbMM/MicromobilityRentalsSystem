
const CACHE = 'mmcq-fb03874362';

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
const STAFF_JS = './staff.js?v=1d63ebe0a7';
// The page's own script and stylesheet (2026-10-01: out of the page into files named by their hash).
// The shell cannot open offline without them. styles.css is the whole stylesheet the staff loader
// adds over app.css, so it rides with staff.js.
// The staff half's parts (staff-parts/, 2026-10-01): the build stamps the list, each by its hash.
const STAFF_PARTS = ["./staff-parts/analytics.js?v=eb86c24864","./staff-parts/community.js?v=204267e61a","./staff-parts/bikes.js?v=551169c2f9","./staff-parts/cashier.js?v=6e188a5349","./staff-parts/catalog.js?v=913472dbf5","./staff-parts/inventory.js?v=496d339d7a","./staff-parts/website.js?v=00080e780b","./staff-parts/history.js?v=d69d3e345a","./staff-parts/workshop.js?v=fda9a87321","./staff-parts/logs.js?v=130656d2d9","./staff-parts/ambassadors.js?v=dcc95b4310","./staff-parts/messages.js?v=048e106a1e","./staff-parts/vendors.js?v=3386361580","./staff-parts/team.js?v=fcdd45cdee","./staff-parts/settings.js?v=be2caec70a"];
const APP_JS = './app.js?v=5b5b632f8f';
const APP_CSS = './app.css?v=91e9c2874a';
const SHELL = [
  SHELL_KEY,
  APP_JS,
  APP_CSS,
  ...(LIVE_CUSTOMER_HOST ? [] : [STAFF_JS, ...STAFF_PARTS, './styles.css?v=3ab98d2d74']),
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
  './hero.webp',
  './icon-192.png',
  './icon-512.png',
];

// Checked against the server, never taken from the browser's HTTP cache as it is: the images here
// are cached for a week without a version in their names, so a new version's cache could be
// filled with the image the last deploy replaced, and keep it until the next version. 'no-cache'
// asks the server with the copy's ETag and takes the copy only when the server says it is still
// right. It used to be 'reload', which ignored the copy the page had just downloaded and fetched
// index.html, styles.css and every image a second time on every first visit - about 690 KB - and
// again after every deploy that changed this file (2026-09-27 review).
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'no-cache' })))).then(() => self.skipWaiting()));
});

// Named by version (vendor/, fonts/, lang/, a ?v= hash): whatever the HTTP cache holds is right.
const PINNED = /^\/(?:vendor|fonts|lang)\//;

self.addEventListener('activate', (e) => {
  // An older version's cache means this activation is an UPDATE, not a first install (2026-10-05).
  // The hourly reg.update() of a tab left open installs, activates and claims a new worker, but
  // only the navigation refresh below ever said 'shell-updated', and an open tab never navigates:
  // it ran the old build until someone reloaded it. So the open windows are told here as well.
  let updated = false;
  e.waitUntil(
    // Everything but this version's cache goes, including the old 'mmcq-img' photo cache (see the
    // note at the end of the fetch handler).
    caches.keys().then((keys) => {
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
function pageFiles(cache, res) {
  return res.text().then((html) => Promise.all(
    [...new Set(html.match(/\/(?:app\.js|app\.css)\?v=[a-f0-9]{10}/g) || [])].map((u) => {
      const req = new Request('.' + u);
      return cache.match(req).then((hit) => hit || fetch(req).then((r) => (r.ok ? cache.put(req, r) : null)));
    })
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
        const refresh = fetch(new Request(SHELL_KEY, { cache: 'no-cache' })).then((res) => {
          const safe = navSafe(res); // never store redirect history under the shell key
          if (isHold(safe)) {
            // The site is on hold (functions/_middleware.js, MM_HOLD): remember it, so the next
            // navigation shows the hold page instead of the cached app, and tell open pages to
            // reload into it - an open app would otherwise go on writing to the database.
            caches.open(CACHE).then((c) => c.put(HOLD_KEY, new Response('1'))).catch(() => {});
            if (!held) self.clients.matchAll({ type: 'window' }).then((cs) => cs.forEach((c) => c.postMessage({ type: 'mm-hold' })));
            return safe;
          }
          if (safe && safe.ok && held) caches.open(CACHE).then((c) => c.delete(HOLD_KEY)).catch(() => {});
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
        if (held) return refresh.catch(() => (cached ? navSafe(cached) : Response.error()));
        // The refresh outlives the answer, so the worker is kept alive until it is stored: once the
        // cached shell has answered, nothing else held the worker, and the browser may stop an idle
        // one before the new shell was written (2026-10-07).
        if (cached) {
          const kept = refresh.then(() => stored).catch(() => {});
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
