
const CACHE = 'mmcq-212c4cf722';

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
const APP_ROUTE = /^\/(?:reserve|my-bookings|account|signup|bookings|dashboard|sales|inventory|workshop|community|ambassadors|website|messages|analytics|history|team)(?:\/[a-z0-9-]+){0,2}\/?$/;
const STAFF_ROUTE = /^\/(?:bookings|dashboard|sales|inventory|workshop|community|ambassadors|website|messages|analytics|history|team)(?:\/|$)/;
const LIVE_CUSTOMER_HOST = self.location.hostname === 'micromobilityrentals.pages.dev';
const shellPage = (p) => p === '/' || p === '/index.html' || (APP_ROUTE.test(p) && !(LIVE_CUSTOMER_HOST && STAFF_ROUTE.test(p)));
// The staff half of the app rides in the shell on every host but the live customer one, so the
// desk opens offline and after a deploy the new file is already on the device; its own hash is in
// the name (the build stamps it), so a new build is a new entry and the old one just ages out.
const STAFF_JS = './staff.js?v=f030e47c31';
const SHELL = [
  SHELL_KEY,
  ...(LIVE_CUSTOMER_HOST ? [] : [STAFF_JS]),
  './styles.css?v=cce424b445',
  './manifest.json',
  './logo.png',
  './logo-dark.png',
  './jcc.png',
  './jcc-white.png',
  './brand.png',
  './assets/brand-mark-white.svg', // the loading state's mask - the boot screen needs it offline
  './assets/snd96-logo.svg', // the National Day lockup - on the event picker, the first screen in
  './assets/mm-pattern.svg', // the brand pattern behind the Micromobility Experiences card - same screen
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
  e.waitUntil(
    // Everything but this version's cache goes, including the old 'mmcq-img' photo cache (see the
    // note at the end of the fetch handler).
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      // Evict the poisoned shell entry left by earlier versions. The cache NAME is a hash of
      // the files the site ships (scripts/build-html.mjs), so a worker-only fix does not
      // rotate it — without this delete, a device already broken by the redirected
      // './index.html' entry would stay broken even after installing this worker.
      .then(() => caches.open(CACHE).then((c) => c.delete('./index.html')).catch(() => {}))
      .then(() => self.clients.claim())
  );
});

// A response that followed a redirect cannot be handed to a navigation — the browser rejects
// the whole load rather than the response. Rebuilding it drops the redirect history while
// keeping the body, status and headers.
function navSafe(res) {
  if (!res || !res.redirected) return res;
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
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
      caches.match(SHELL_KEY).then((cached) => {
        const refresh = fetch(new Request(SHELL_KEY, { cache: 'no-cache' })).then((res) => {
          const safe = navSafe(res); // never store redirect history under the shell key
          if (safe && safe.ok) {
            const copy = safe.clone();
            // If the shell actually changed (new deploy), tell open pages so they can refresh
            // themselves — otherwise a stale (possibly buggy) build keeps running for a full visit.
            const newTag = safe.headers.get('etag');
            const oldTag = cached && cached.headers.get('etag');
            const changed = !!cached && (!newTag || !oldTag || newTag !== oldTag);
            caches.open(CACHE).then((c) => c.put(SHELL_KEY, copy)).then(() => {
              if (changed) self.clients.matchAll({ type: 'window' }).then((cs) => cs.forEach((c) => c.postMessage({ type: 'shell-updated' })));
            });
          }
          return safe;
        });
        // The cached shell answers instantly; the refresh keeps running for next time. With
        // nothing cached yet, the navigation waits on the network as any first visit does.
        if (cached) { refresh.catch(() => {}); return navSafe(cached); }
        return refresh;
      })
    );
    return;
  }

  
  // Same-origin (incl. the self-hosted vendor/ libraries): cache-first, then network.
  // Nothing here is revalidated, so a cached copy has to be right for as long as this cache
  // lives: the cache NAME hashes every file the site ships (scripts/build-html.mjs), and the
  // translation packs and city lists are asked for by their own content hash.
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
  const target = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) { try { w.navigate(new URL(target, self.location.origin).href); } catch (_) { /* older browsers */ } return w.focus(); }
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
