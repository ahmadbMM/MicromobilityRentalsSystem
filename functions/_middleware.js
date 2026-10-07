// Cloudflare Pages middleware — runs before static assets, so unlike _redirects it
// CAN stop internal files from being served. Cloudflare Pages serves the whole repo
// root; this blocks source, SQL, docs, configs, tests, dotfiles from the public.
// App assets (.html/.css/.js/.png + manifest.json) pass through to next().
const STAFF_ORIGIN = 'https://staff.micromobility.sa';
// The app's own addresses (2026-09-27): one per section and sub-view - the same list as the
// router in app.src.html (STAFF_PATHS, CUST_PATHS, SUB_PATHS) and service-worker.js (APP_ROUTE);
// tests/paths.spec.ts checks the three agree. Pages has no file for /bookings/waitlist, so its
// 404 is answered with the app itself, for a GET navigation only: the app then opens on that
// section. Files always win, and anything else stays a 404.
const APP_ROUTE = /^\/(?:reserve|my-bookings|account|signup|bookings|dashboard|sales|inventory|workshop|customers|community|ambassadors|vendors|website|messages|analytics|history|team|settings)(?:\/[a-z0-9-]+){0,2}\/?$/;
const STAFF_ROUTE = /^\/(?:bookings|dashboard|sales|inventory|workshop|customers|community|ambassadors|vendors|website|messages|analytics|history|team|settings)(?:\/|$)/;
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
    (/\.json$/.test(path) && path !== '/manifest.json' && path !== '/assets/phone-rules.json' &&
      !/^\/lang\/[a-z-]{2,8}\.json$/.test(path) && !/^\/cities\/[a-z]{2}\.json$/.test(path)) ||
    path === '/app.src' || /\/app\.src\.html$/.test(path) ||            // the readable app source
    path.startsWith('/tests/') ||
    path.startsWith('/visual/') ||                                     // the local screenshot harness (playwright.visual.config.ts)
    path.startsWith('/scripts/') ||
    path.startsWith('/functions/') ||
    // The ERP design bundle is 1.8 MB of internal reference, and one of its files carried a
    // real staff mobile number (replaced with invented ones 2026-10-05). It is a .html prototype,
    // so the extension allow-list let it through — block the whole directory by path instead.
    path.startsWith('/design_handoff_erp_reskin/') ||
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
  // tag's /?bike= all go on to the staff address. Previews and other hosts are untouched.
  const reqUrl = new URL(context.request.url);
  if (reqUrl.hostname.toLowerCase() === 'micromobilityrentals.pages.dev') {
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
