// Cloudflare Pages middleware — runs before static assets, so unlike _redirects it
// CAN stop internal files from being served. Cloudflare Pages serves the whole repo
// root; this blocks source, SQL, docs, configs, tests, dotfiles from the public.
// App assets (.html/.css/.js/.png + manifest.json) pass through to next().
const STAFF_ORIGIN = 'https://staff.micromobility.sa';
// The site's public address and the hosts it has had (2026-11-09: micromobilityrentals.pages.dev
// moved to experiences.micromobility.sa). Both lines are written by scripts/build-html.mjs from
// site.config.json: change the address there.
const SITE_ORIGIN = 'https://experiences.micromobility.sa';
const FORMER_HOSTS = ['micromobilityrentals.pages.dev'];
const SITE_HOST = new URL(SITE_ORIGIN).hostname;
// The app's own addresses (2026-09-27): one per section and sub-view - the same list as the
// router in app.src.html (STAFF_PATHS, CUST_PATHS, SUB_PATHS) and service-worker.js (APP_ROUTE);
// tests/paths.spec.ts checks the three agree. Pages has no file for /bookings/waitlist, so its
// 404 is answered with the app itself, for a GET navigation only: the app then opens on that
// section. Files always win, and anything else stays a 404.
const APP_ROUTE = /^\/(?:reserve|my-bookings|account|members|signup|bookings|waitlist|sessions|dashboard|sales|inventory|workshop|customers|community|people|badge-requests|lockers|store|payments|ambassadors|volunteers|vendors|website|messages|analytics|history|team|settings)(?:\/[a-z0-9-]+){0,2}\/?$/;
const STAFF_ROUTE = /^\/(?:bookings|waitlist|sessions|dashboard|sales|inventory|workshop|customers|community|people|badge-requests|lockers|store|payments|ambassadors|volunteers|vendors|website|messages|analytics|history|team|settings)(?:\/|$)/;
const isNavigation = (req) => {
  const mode = req.headers.get('sec-fetch-mode');
  return mode ? mode === 'navigate' : /text\/html/.test(req.headers.get('accept') || '');
};

export async function onRequest(context) {
  const raw = new URL(context.request.url).pathname;

  // Match on the DECODED path: Cloudflare decodes percent-encoding before serving a
  // static file, so a raw regex would miss "security-migration%2Esql" (%2E = '.').
  // Decode fully (handle double-encoding), lowercase, and normalise backslashes.
  let path = raw;
  try {
    let prev;
    do { prev = path; path = decodeURIComponent(path); } while (path !== prev && path.length < 4096);
  } catch {
    return notFound(); // malformed encoding — refuse
  }
  path = path.replace(/\\/g, '/').toLowerCase();
  // A control character (CR, LF, NUL...) has no place in any of our addresses. Decoded, one reached
  // the Location header of the staff redirect below, where a CR/LF made the Response constructor
  // throw: an uncaught exception, answered as a 500.
  if ([...path].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) return notFound();

  const blocked =
    /\.(sql|md|ts|mjs|lock|yml|yaml|toml|map|cjs|env|sh)$/.test(path) || // source / config / docs / data
    // Local databases: wrangler's dev state (.wrangler/state/**.sqlite plus its -wal/-shm
    // journals) was tracked in git until 2026-10-05 (now .gitignore'd), and a repo-root deploy
    // from a checkout that has it would otherwise serve it.
    /\.(sqlite3?|db)(-wal|-shm|-journal)?$/.test(path) ||
    // configs stay blocked; the PWA manifest, the translation packs, the city lists and the
    // phone-number rules the staff "Looks off" check reads are app assets. The rules file was
    // blocked with the configs, so production answered it 404 and every phone passed the check.
    (/\.json$/.test(path) && path !== '/manifest.json' && path !== '/assets/phone-rules.json' && path !== '/assets/blood-info.json' &&
      !/^\/lang\/[a-z-]{2,24}\.json$/.test(path) && !/^\/cities\/[a-z]{2}\.json$/.test(path)) ||
    path === '/app.src' || /\/app\.src\.html$/.test(path) ||            // the readable app source
    path.startsWith('/tests/') ||
    path.startsWith('/visual/') ||                                     // the local screenshot harness (playwright.visual.config.ts)
    path.startsWith('/scripts/') ||
    path.startsWith('/functions/') ||
    // The ERP design bundle is 1.8 MB of internal reference, and one of its files carried a
    // real staff mobile number (replaced with invented ones 2026-10-05). It is a .html prototype,
    // so the extension allow-list let it through — block the whole directory by path instead.
    path.startsWith('/design_handoff_erp_reskin/') ||
    // The volunteer certificate's design source: its template, stylesheet, brand vectors and the
    // approved render. What the apps serve is built from it (assets/certificate.html and
    // certificate.css); the folder itself is internal, and .svg would otherwise pass.
    path.startsWith('/certificate/') ||
    path.startsWith('/.github/') ||
    path.startsWith('/.claude/') ||
    path.startsWith('/.wrangler/') ||
    // Anything inside a hidden directory, at any depth. The dotfile rule below only looks at the
    // last segment, so /.wrangler/state/v3/… walked straight past it. /.well-known/ stays open
    // for the files browsers and platforms fetch from there.
    /(^|\/)\.(?!well-known\/)[^/]+\//.test(path) ||
    /(^|\/)\.[^/]+$/.test(path);                                        // dotfiles (.gitignore, .prettierrc, …)

  if (blocked) return notFound();

  // The hold (2026-10-02, for the database move): with MM_HOLD=on among the Pages variables,
  // every page answers a short "back soon" page and every /api call a 503, so nobody books into a
  // database that is being copied. Files still load. A variable reaches the site with its next
  // deploy, so the hold goes up with one deploy and comes down with the next one without it.
  if (context.env && context.env.MM_HOLD === 'on') {
    if (path.startsWith('/api/')) {
      return new Response(JSON.stringify({ ok: false, error: 'hold' }), {
        status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'retry-after': '900', 'x-mm-hold': '1' },
      });
    }
    if (isNavigation(context.request)) return holdPage();
    // The app's shell, however it is asked for. The service worker answers an installed device's
    // navigations from its cache and refreshes the shell with a plain fetch of / (sec-fetch-mode
    // cors, not navigate), so the check above never saw it: every returning rider and every staff
    // device kept the app, writing straight to the database being copied. That fetch now gets the
    // hold page too, marked x-mm-hold, which the worker reads as "serve the hold page from now on"
    // (service-worker.js), and an open page's own probe of /api/hold gets the 503 above.
    if ((context.request.method === 'GET' || context.request.method === 'HEAD') &&
        (path === '/' || path === '/index.html' || APP_ROUTE.test(path))) return holdPage();
  }

  // The live customer address keeps no way into staff: the /staff/ stub, /?staff and an NFC
  // tag's /?bike= all go on to the staff address. A former address sends them there in one hop,
  // not by way of the new one. Previews and other hosts are untouched.
  const reqUrl = new URL(context.request.url);
  const host = reqUrl.hostname.toLowerCase();
  const former = FORMER_HOSTS.includes(host);
  // A copy whose staff address is its own (the staging copy, scripts/staging-build.mjs) sends nothing on to itself.
  if ((host === SITE_HOST || former) && new URL(STAFF_ORIGIN).hostname !== SITE_HOST) {
    const bike = (reqUrl.searchParams.get('bike') || '').trim();
    if (path === '/staff' || path.startsWith('/staff/') || STAFF_ROUTE.test(path) || reqUrl.searchParams.has('staff') || reqUrl.searchParams.has('bike')) {
      // A staff section's own address keeps its path and query on the way over. The path is the
      // decoded one, so it is encoded again: a header value holds no character past U+00FF, and an
      // Arabic letter in the address made the Response constructor throw - a 500 (2026-10-07).
      const to = STAFF_ROUTE.test(path) && !reqUrl.searchParams.has('bike')
        ? STAFF_ORIGIN + encodeURI(path.replace(/\/+$/, '')) + reqUrl.search
        : STAFF_ORIGIN + '/' + (/^[0-9A-Za-z-]{1,40}$/.test(bike) ? '?bike=' + bike : '');
      return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store' } });
    }
  }

  if (former) return moved(context, reqUrl, path);

  // staff.micromobility.sa serves the same app, and nothing on it is for search engines: its
  // robots.txt shuts every crawler out and every answer carries noindex.
  const staffHost = /^staff\./i.test(new URL(context.request.url).hostname);
  if (staffHost && path === '/robots.txt') {
    return new Response('User-agent: *\nDisallow: /\n', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  let res = await context.next();
  if (res.status === 404 && context.request.method === 'GET' && APP_ROUTE.test(path) && isNavigation(context.request) && context.env && context.env.ASSETS) {
    // The app shell, asked for as / (never /index.html, which Pages answers with a 308).
    res = await context.env.ASSETS.fetch(new URL('/', context.request.url));
  }
  if (!staffHost) return res;
  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return out;
}

// ── A former address (2026-11-09) ─────────────────────────────────────────────
// Everything on it goes to the same path and query on SITE_ORIGIN, with three exceptions:
// - /api/* is still answered here. Pages opened before the move call it by a relative path, and
//   the database's push drain (_push_drain_call) posts to it; a redirect would break both (a
//   cross-origin redirect of a fetch fails CORS, and a POST would arrive as a GET).
// - /service-worker.js is a worker that retires the old one. A phone that opened the app here has
//   its worker answer every visit from the cache without asking the server, so a redirect alone
//   would never reach it; and a browser refuses a worker script that redirects, keeping the old
//   worker for good. This one replaces it, empties the caches, unregisters itself and tells the
//   open pages to reload, which then come to the server and are handed over.
// - A browser's visit gets the hand-over page instead of the 301. What the app keeps on the device
//   (the rider's sign-in, language, bookings waiting to be sent) is stored per address, so a bare
//   redirect would sign every rider out. The page carries it to SITE_ORIGIN in the address's
//   fragment, which no server sees, and the app there takes it in (app.src.html, the first script).
//   So does the old worker's own refresh of the shell (a same-origin fetch of /): it stores the
//   page, and the next visit it answers from the cache is handed over too.
// Crawlers, link previews and anything else send no Sec-Fetch-* headers and get the 301 itself.
const SHELL_PATH = (p) => p === '/' || p === '/index.html' || APP_ROUTE.test(p);
function moved(context, url, path) {
  const req = context.request;
  if (path.startsWith('/api/')) return context.next();
  if (path === '/service-worker.js') return retiredWorker();
  // The raw path and query, as the URL parser keeps them: percent-encoded, so always a valid header.
  const to = SITE_ORIGIN + (path === '/index.html' ? '/' : url.pathname) + url.search;
  const h = req.headers;
  const page = (h.get('sec-fetch-mode') === 'navigate' && h.get('sec-fetch-dest') === 'document') ||
    (h.get('sec-fetch-site') === 'same-origin' && h.get('sec-fetch-dest') === 'empty' && SHELL_PATH(path));
  if (req.method === 'GET' && page) return handOverPage(to);
  const keep = req.method === 'GET' || req.method === 'HEAD';
  return new Response(null, { status: keep ? 301 : 308, headers: { location: to, 'cache-control': 'public, max-age=3600' } });
}

// Runs on the former address, in the visitor's browser. It reads what the app stored there, takes
// it off that address (so a later visit to an old link hands over nothing a second time, and never
// overwrites a sign-in made since), retires any worker and cache left there, and goes on to the
// same path and query on SITE_ORIGIN. The original fragment rides along as mm-hash (a sign-in
// return carries #access_token=...). A fragment that is itself a hand-over is dropped: only this
// page writes one, from this device's own storage. Kept to what the app stores (cq_*, mm_*, and
// supabase-js's sb-*), per value and in all, so the address stays short enough for every browser.
const HAND_OVER_JS = `(function(){
var TO=${JSON.stringify(SITE_ORIGIN)},KEEP=/^(cq_|mm_|sb-)/,SKIP=/^(cq_snapshot|cq_staff|cq_role|cq_team|cq_access|cq_op_|cq_kiosk|cq_booth|cq_desk_|cq_sales_|cq_ct_|cq_ho$|cq_weather|cq_errors|cq_full_log)/,FIRST=/^(cq_session|sb-|cq_lang|mm_lang|cq_book_outbox|cq_ref|cq_device_id)/;
var hash=location.hash.replace(/^#/,'');if(/^mm-move=/.test(hash))hash='';
var path=location.pathname==='/index.html'?'/':location.pathname,dest=TO+path+location.search,list=[],data={},size=0,taken=[];
function read(st,tag){try{for(var i=0;i<st.length;i++){var k=st.key(i),v=st.getItem(k);if(k&&v!=null&&KEEP.test(k)&&!SKIP.test(k)&&v.length<=16384)list.push([tag,k,v,st]);}}catch(e){}}
read(window.localStorage,'l');read(window.sessionStorage,'s');
list.sort(function(a,b){return (FIRST.test(b[1])?1:0)-(FIRST.test(a[1])?1:0);});
for(var i=0;i<list.length;i++){var e=list[i];if(size+e[1].length+e[2].length>24000)continue;data[e[0]+':'+e[1]]=e[2];size+=e[1].length+e[2].length;taken.push(e);}
var frag=hash;
if(taken.length){try{
var b=btoa(unescape(encodeURIComponent(JSON.stringify(data)))).split('+').join('-').split('/').join('_').replace(/=+$/,'');
frag='mm-move='+b+(hash?'&mm-hash='+encodeURIComponent(hash):'');
for(var j=0;j<taken.length;j++)try{taken[j][3].removeItem(taken[j][1]);}catch(e){}
}catch(e){frag=hash;}}
var gone=false;function go(){if(gone)return;gone=true;location.replace(dest+(frag?'#'+frag:''));}
setTimeout(go,700);
var jobs=[];
try{if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations)jobs.push(navigator.serviceWorker.getRegistrations().then(function(rs){return Promise.all(rs.map(function(r){return r.unregister();}));}));}catch(e){}
try{if(window.caches)jobs.push(caches.keys().then(function(ks){return Promise.all(ks.map(function(k){return caches.delete(k);}));}));}catch(e){}
if(jobs.length&&window.Promise)Promise.all(jobs).then(go,go);else go();
})();`;

function handOverPage(to) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const where = esc(SITE_HOST);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="origin"><meta name="color-scheme" content="light dark">
<link rel="canonical" href="${esc(to)}"><title>MicroMobility Experiences</title>
<noscript><meta http-equiv="refresh" content="0;url=${esc(to)}"></noscript>
<script nonce="${nonce}">${HAND_OVER_JS}</script>
</head><body><noscript>
<p>MicroMobility Experiences has moved to <a href="${esc(to)}">${where}</a>.</p>
<p dir="rtl" lang="ar">انتقلت تجارب MicroMobility إلى <a href="${esc(to)}">${where}</a>.</p>
</noscript></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex',
      // The app on SITE_ORIGIN takes a hand-over only from a page whose origin the browser names as
      // a former address: no third party can plant a sign-in on a rider's phone with a crafted link.
      'referrer-policy': 'origin', 'link': `<${to}>; rel="canonical"`, 'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
}

// The worker a phone that used the former address finds on its next update check (any visit, and
// the open app's hourly reg.update()). It answers nothing (no fetch handler), so from the moment
// it takes over every request goes to the network. Activating, it empties every cache the old
// worker kept, unregisters, and says 'shell-updated': the app's own update path then reloads the
// page (at once if it only just opened, else from its Refresh bar or when it is next hidden), and
// that load is handed over. Never cached, so the browser always sees this exact script.
const RETIRED_WORKER = `// ${FORMER_HOSTS.join(', ')} moved to ${SITE_ORIGIN} (2026-11-09). This worker retires the old one.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim().catch(function () {})
    .then(function () { return caches.keys(); })
    .then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); })
    .catch(function () {})
    .then(function () { return self.registration.unregister(); })
    .catch(function () {})
    .then(function () { return self.clients.matchAll({ type: 'window' }); })
    .then(function (cs) { cs.forEach(function (c) { c.postMessage({ type: 'shell-updated' }); }); })
    .catch(function () {}));
});
`;
function retiredWorker() {
  return new Response(RETIRED_WORKER, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function holdPage() {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta http-equiv="refresh" content="60">
<title>MicroMobility - back soon</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#16181d;--mute:#5d6470;--card:#fff;--line:#e3e1dc}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--fg:#eef0f3;--mute:#a3aab5;--card:#1b1e23;--line:#2c3038}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Arabic",sans-serif;padding:16px;box-sizing:border-box}
main{box-sizing:border-box;max-width:440px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 24px}
h1{font-size:20px;margin:0 0 8px}p{margin:0;color:var(--mute)}
section+section{margin-top:22px;padding-top:22px;border-top:1px solid var(--line)}
</style></head><body><main>
<section><h1>We'll be back in a few minutes</h1>
<p>We're moving MicroMobility to a new home, so booking is paused for a short while. Your bookings are safe. This page opens the site again by itself when it's ready.</p></section>
<section dir="rtl" lang="ar"><h1>سنعود خلال دقائق</h1>
<p>ننقل MicroMobility إلى مكان جديد، لذا توقّف الحجز لفترة قصيرة. حجوزاتك محفوظة، وستفتح هذه الصفحة الموقع من جديد تلقائياً حين يجهز.</p></section>
</main></body></html>`;
  return new Response(html, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '900', 'x-mm-hold': '1',
      'x-robots-tag': 'noindex', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
