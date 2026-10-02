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
const APP_ROUTE = /^\/(?:reserve|my-bookings|account|signup|bookings|dashboard|sales|inventory|workshop|community|ambassadors|website|messages|analytics|history|team|settings)(?:\/[a-z0-9-]+){0,2}\/?$/;
const STAFF_ROUTE = /^\/(?:bookings|dashboard|sales|inventory|workshop|community|ambassadors|website|messages|analytics|history|team|settings)(?:\/|$)/;
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

  const blocked =
    /\.(sql|md|ts|mjs|lock|yml|yaml|toml|map|cjs|env|sh)$/.test(path) || // source / config / docs / data
    // Local databases: wrangler's dev state (.wrangler/state/**.sqlite plus its -wal/-shm
    // journals) is tracked in git, and a repo-root deploy would otherwise serve it.
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
    // The ERP design bundle is 1.8 MB of internal reference and one of its files carries a
    // real staff mobile number. It is a .html prototype, so the extension allow-list let it
    // through — block the whole directory by path instead.
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

  // The live customer address keeps no way into staff: the /staff/ stub, /?staff and an NFC
  // tag's /?bike= all go on to the staff address. Previews and other hosts are untouched.
  const reqUrl = new URL(context.request.url);
  if (reqUrl.hostname.toLowerCase() === 'micromobilityrentals.pages.dev') {
    const bike = (reqUrl.searchParams.get('bike') || '').trim();
    if (path === '/staff' || path.startsWith('/staff/') || STAFF_ROUTE.test(path) || reqUrl.searchParams.has('staff') || reqUrl.searchParams.has('bike')) {
      // A staff section's own address keeps its path and query on the way over.
      const to = STAFF_ROUTE.test(path) && !reqUrl.searchParams.has('bike')
        ? STAFF_ORIGIN + path.replace(/\/+$/, '') + reqUrl.search
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
