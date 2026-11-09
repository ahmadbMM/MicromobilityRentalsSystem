import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { freshModule } from './helpers/fresh-module';
import { stubSupabase, stubRealtime, waitForSb } from './helpers/supabase';

// The move from micromobilityrentals.pages.dev to experiences.micromobility.sa (2026-11-09).
// site.config.json names the address and the ones it has had; the build stamps them into the
// middleware, the worker and the page. On a former address the middleware hands a browser's visit
// over to the new one with what the app stored on the device (functions/_middleware.js,
// handOverPage), sends everything else on with a 301, keeps /api answering, and retires the old
// service worker; the page on the new address takes the hand-over in (app.src.html, its first script).

type Ctx = { request: Request; env?: Record<string, string>; next?: () => Response | Promise<Response> };
type Fn = (ctx: Ctx) => Promise<Response>;
const ROOT = resolve(__dirname, '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const site = JSON.parse(read('site.config.json')) as { origin: string; formerOrigins: string[] };
const NEW = site.origin;
const OLD = site.formerOrigins[0];
const middleware = async () => (await freshModule('functions/_middleware.js')).onRequest as Fn;
const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-site': 'none' };
const asset = () => new Response('asset');

test.describe('@build the move: one address, written everywhere from site.config.json', () => {
  test('the build stamped the new address and the old one into every place that names them', () => {
    expect(NEW).toBe('https://experiences.micromobility.sa');
    expect(OLD).toBe('https://micromobilityrentals.pages.dev');
    const mw = read('functions/_middleware.js');
    expect(mw).toContain(`const SITE_ORIGIN = '${NEW}';`);
    expect(mw).toContain("const FORMER_HOSTS = ['micromobilityrentals.pages.dev'];");
    expect(read('service-worker.js')).toContain("const LIVE_CUSTOMER_HOST = self.location.hostname === 'experiences.micromobility.sa';");
    expect(read('robots.txt')).toContain(`Sitemap: ${NEW}/sitemap.xml`);
    expect(read('sitemap.xml')).toContain(`<loc>${NEW}/</loc>`);
    const html = read('index.html');
    expect(html).toContain(`<meta property="og:url" content="${NEW}/">`);
    expect(html).toContain(`hreflang="ar" href="${NEW}/?lang=ar"`);
    // The old address is named once in the page: the hand-over's list of where a visit may come from.
    expect(html.split(OLD).length - 1).toBe(1);
    for (const f of ['index.html', 'app.js', 'staff.js']) expect(read(f), f).not.toMatch(/__SITE_(?:FORMER_)?ORIGINS?__/);
    expect(read('sitemap.xml')).not.toContain('pages.dev');
  });
});

test.describe('@build the move: the middleware on the old address', () => {
  test('a browser\'s visit is handed over: a page that goes on to the same path and query there', async () => {
    const onRequest = await middleware();
    const r = await onRequest({ request: new Request(`${OLD}/my-bookings?lang=ar&ref=RF-AB12`, { headers: NAV }), next: asset });
    expect(r.status).toBe(200);
    const to = `${NEW}/my-bookings?lang=ar&ref=RF-AB12`;
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-robots-tag')).toBe('noindex');
    expect(r.headers.get('referrer-policy')).toBe('origin');
    expect(r.headers.get('link')).toBe(`<${to}>; rel="canonical"`);
    const body = await r.text();
    expect(body).toContain(`<link rel="canonical" href="${to.replace(/&/g, '&#38;')}">`);
    expect(body).toContain(`<noscript><meta http-equiv="refresh" content="0;url=${to.replace(/&/g, '&#38;')}"></noscript>`);
    // Its one script runs under its own nonce, and nothing else does.
    const nonce = body.match(/<script nonce="([^"]+)">/)![1];
    expect(r.headers.get('content-security-policy')).toBe(`default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    const js = body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
    expect(() => new Function(js)).not.toThrow();
    // Two visits, two nonces.
    const again = await (await onRequest({ request: new Request(`${OLD}/`, { headers: NAV }), next: asset })).text();
    expect(again.match(/<script nonce="([^"]+)">/)![1]).not.toBe(nonce);
  });

  test('the old worker\'s own refresh of the shell is handed the same page, any other fetch the 301', async () => {
    const onRequest = await middleware();
    const fetchOf = (path: string) => onRequest({ request: new Request(OLD + path, { headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' } }), next: asset });
    for (const path of ['/', '/reserve']) {
      const r = await fetchOf(path);
      expect(r.status, path).toBe(200);
      expect(await r.text(), path).toContain('mm-move=');
    }
    expect((await fetchOf('/app.js?v=1')).status).toBe(301);
  });

  test('everything else goes to the same address there with a 301', async () => {
    const onRequest = await middleware();
    const go = async (path: string, init: RequestInit = {}) => {
      const r = await onRequest({ request: new Request(OLD + path, init), next: asset });
      return [r.status, r.headers.get('location')];
    };
    // A crawler or a link preview sends no Sec-Fetch-* headers.
    expect(await go('/')).toEqual([301, `${NEW}/`]);
    expect(await go('/reserve?lang=ar&ev=jcc&session=s1')).toEqual([301, `${NEW}/reserve?lang=ar&ev=jcc&session=s1`]);
    expect(await go('/signup?ref=RF-AB12&lang=en')).toEqual([301, `${NEW}/signup?ref=RF-AB12&lang=en`]);
    expect(await go('/index.html')).toEqual([301, `${NEW}/`]);
    expect(await go('/robots.txt')).toEqual([301, `${NEW}/robots.txt`]);
    expect(await go('/sitemap.xml')).toEqual([301, `${NEW}/sitemap.xml`]);
    expect(await go('/no-such-page')).toEqual([301, `${NEW}/no-such-page`]);
    // A letter past Latin-1 stays percent-encoded, so the header is always valid.
    expect(await go('/my-bookings/%D9%85?q=%D8%B3')).toEqual([301, `${NEW}/my-bookings/%D9%85?q=%D8%B3`]);
    expect(await go('/', { method: 'HEAD' })).toEqual([301, `${NEW}/`]);
    expect(await go('/x', { method: 'POST', body: '{}' })).toEqual([308, `${NEW}/x`]);
    // A frame is no visit: only a top-level page is handed over.
    expect(await go('/', { headers: { ...NAV, 'sec-fetch-dest': 'iframe' } })).toEqual([301, `${NEW}/`]);
  });

  test('/api is still answered there, for pages opened before the move and the database\'s push drain', async () => {
    const onRequest = await middleware();
    for (const init of [{}, { method: 'POST', body: '{}' }, { headers: NAV }])
      expect(await (await onRequest({ request: new Request(`${OLD}/api/push-send`, init), next: asset })).text()).toBe('asset');
  });

  test('its worker script is one that retires the old worker', async () => {
    const onRequest = await middleware();
    const r = await onRequest({ request: new Request(`${OLD}/service-worker.js`), next: asset });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const js = await r.text();
    expect(() => new Function(js)).not.toThrow();
    for (const part of ['skipWaiting()', 'caches.delete(k)', 'self.registration.unregister()', "type: 'shell-updated'"]) expect(js).toContain(part);
    // No fetch handler: from the moment it takes over, every request goes to the network.
    expect(js).not.toContain("'fetch'");
    // The new address keeps its own worker.
    expect(await (await onRequest({ request: new Request(`${NEW}/service-worker.js`), next: asset })).text()).toBe('asset');
  });

  test('a staff link there goes straight to the staff address, and internal files stay hidden', async () => {
    const onRequest = await middleware();
    const at = async (path: string) => {
      const r = await onRequest({ request: new Request(OLD + path, { headers: NAV }), next: asset });
      return [r.status, r.headers.get('location')];
    };
    expect(await at('/staff/')).toEqual([302, 'https://staff.micromobility.sa/']);
    expect(await at('/?bike=042')).toEqual([302, 'https://staff.micromobility.sa/?bike=042']);
    expect(await at('/sales?lang=ar')).toEqual([302, 'https://staff.micromobility.sa/sales?lang=ar']);
    for (const path of ['/AGENTS.md', '/site.config.json', '/app.src.html', '/.github/workflows/ci.yml'])
      expect((await onRequest({ request: new Request(OLD + path, { headers: NAV }), next: asset })).status, path).toBe(404);
  });

  test('the new address is the live one, and previews and other hosts are left alone', async () => {
    const onRequest = await middleware();
    const r = await onRequest({ request: new Request(`${NEW}/`, { headers: NAV }), next: asset });
    expect(await r.text()).toBe('asset');
    expect(r.headers.get('x-robots-tag')).toBeNull();
    const staff = await onRequest({ request: new Request(`${NEW}/?bike=7`, { headers: NAV }), next: asset });
    expect([staff.status, staff.headers.get('location')]).toEqual([302, 'https://staff.micromobility.sa/?bike=7']);
    for (const url of ['https://abc123.micromobilityrentals.pages.dev/', 'https://staff.micromobility.sa/', 'https://site.test/my-bookings'])
      expect(await (await onRequest({ request: new Request(url, { headers: NAV }), next: asset })).text(), url).toBe('asset');
  });
});

// ── In a browser ─────────────────────────────────────────────────────────────
// Both addresses are answered in the page's own network: the old one by the middleware itself (as
// Cloudflare calls it), the new one by the test server. An intercepted request's allHeaders() never
// settles, so the Sec-Fetch-* headers are the ones a browser sends for what Playwright says it is: a
// top-level navigation, or a fetch from the page. (The real worker below meets the real headers.)
async function serveOld(page: Page, onRequest: Fn) {
  await page.route(`${OLD}/**`, async (route) => {
    const req = route.request();
    const headers = new Headers(req.isNavigationRequest() && req.frame() === page.mainFrame() ? NAV
      : { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' });
    const res = await onRequest({
      request: new Request(req.url(), { method: req.method(), headers }),
      next: () => new Response('<!doctype html><title>old address</title>', { headers: { 'content-type': 'text/html' } }),
    });
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => { out[k] = v; });
    await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
  });
}
async function serveNew(page: Page, baseURL: string) {
  await page.route(`${NEW}/**`, async (route) => {
    const u = new URL(route.request().url());
    await route.fulfill({ response: await route.fetch({ url: baseURL + u.pathname + u.search }) });
  });
  // What the hand-over leaves in the address bar and writes to storage, read as it happens (the
  // app moves on after: it sends a waiting booking, writes its own boot snapshot).
  await page.addInitScript(() => {
    if (location.origin !== 'https://experiences.micromobility.sa') return;
    const rs = history.replaceState.bind(history);
    const set = Storage.prototype.setItem;
    // @ts-expect-error a probe for the spec
    window.__rs = []; window.__set = [];
    history.replaceState = (s: unknown, t: string, u?: string | URL | null) => {
      // @ts-expect-error a probe for the spec
      window.__rs.push(String(u));
      return rs(s, t, u);
    };
    Storage.prototype.setItem = function (k: string, v: string) {
      // @ts-expect-error a probe for the spec
      window.__set.push([this === localStorage ? 'l' : 's', k, v]);
      return set.call(this, k, v);
    };
  });
}
const RIDER = { id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', session_token: 'tok-spec' };
const fixtures = { sessions: [], queue_entries: [], bikes: [], customers: [RIDER] };

test.describe('@customer:move the hand-over in a browser', () => {
  test('a signed-in rider on the old address arrives signed in, in their language, on the same page', async ({ page, baseURL }) => {
    const onRequest = await middleware();
    await stubSupabase(page, fixtures);
    await serveOld(page, onRequest);
    await serveNew(page, baseURL!);
    // What the old address held. /api is still served there (by next() here), so a page of it opens.
    await page.goto(`${OLD}/api/seed`);
    await page.evaluate((r) => {
      localStorage.setItem('cq_session', JSON.stringify(r));
      localStorage.setItem('cq_lang', 'fr');
      localStorage.setItem('cq_book_outbox', '[{"id":"o1"}]');
      localStorage.setItem('cq_snapshot', 'a staff cache that stays behind');
      localStorage.setItem('other', 'not the app\'s');
    }, RIDER);

    await page.goto(`${OLD}/my-bookings#keep=1`);
    await page.waitForURL(`${NEW}/**`);
    await waitForSb(page);
    // The fragment is gone from the address at once, and the visit's own came back.
    // @ts-expect-error a probe for the spec
    expect(await page.evaluate(() => window.__rs[0])).toBe('/my-bookings#keep=1');
    expect(page.url()).not.toContain('mm-move');
    // The first writes on the new address are the hand-over's: the app's keys, nothing else.
    // @ts-expect-error a probe for the spec
    const writes = await page.evaluate(() => window.__set.slice(0, 3));
    expect(writes).toEqual(expect.arrayContaining([['l', 'cq_session', JSON.stringify(RIDER)], ['l', 'cq_lang', 'fr'], ['l', 'cq_book_outbox', '[{"id":"o1"}]']]));
    const now = await page.evaluate(() => ({
      id: JSON.parse(localStorage.getItem('cq_session') || '{}').id,
      snapshot: localStorage.getItem('cq_snapshot'),
      other: localStorage.getItem('other'),
      // @ts-expect-error app globals
      signedIn: getSession()?.id, uiLang: S.lang,
    }));
    expect(now.snapshot).not.toBe('a staff cache that stays behind');
    expect({ ...now, snapshot: undefined }).toEqual({ id: 'c1', snapshot: undefined, other: null, signedIn: 'c1', uiLang: 'fr' });

    // The old address no longer holds what it handed over, so an old link later hands nothing over twice.
    await page.goto(`${OLD}/api/seed`);
    expect(await page.evaluate(() => [localStorage.getItem('cq_session'), localStorage.getItem('cq_lang'), localStorage.getItem('cq_snapshot'), localStorage.getItem('other')]))
      .toEqual([null, null, 'a staff cache that stays behind', 'not the app\'s']);
  });

  test('a rider already signed in on the new address keeps that sign-in', async ({ page, baseURL }) => {
    const onRequest = await middleware();
    await stubSupabase(page, fixtures);
    await serveOld(page, onRequest);
    await serveNew(page, baseURL!);
    await page.goto(`${NEW}/`);
    await waitForSb(page);
    await page.evaluate(() => { localStorage.setItem('cq_session', JSON.stringify({ id: 'c2', session_token: 'tok-2' })); localStorage.setItem('cq_lang', 'ar'); });
    await page.goto(`${OLD}/api/seed`);
    await page.evaluate((r) => { localStorage.setItem('cq_session', JSON.stringify(r)); localStorage.setItem('cq_lang', 'fr'); }, RIDER);
    await page.goto(`${OLD}/`);
    await page.waitForURL(`${NEW}/**`);
    await waitForSb(page);
    expect(await page.evaluate(() => [JSON.parse(localStorage.getItem('cq_session') || '{}').id, localStorage.getItem('cq_lang')])).toEqual(['c2', 'ar']);
  });

  test('a crafted hand-over link plants nothing, sent straight or by way of the old address', async ({ page, baseURL }) => {
    const onRequest = await middleware();
    await stubSupabase(page, fixtures);
    await serveOld(page, onRequest);
    await serveNew(page, baseURL!);
    const evil = Buffer.from(JSON.stringify({ 'l:cq_session': JSON.stringify({ id: 'evil', session_token: 'x' }) })).toString('base64url');

    await page.goto(`${NEW}/#mm-move=${evil}`);
    await waitForSb(page);
    // @ts-expect-error a probe for the spec
    expect(await page.evaluate(() => window.__rs[0])).toBe('/');
    expect(await page.evaluate(() => localStorage.getItem('cq_session'))).toBeNull();

    // Through the old address, which holds nothing: the fragment is dropped on the way.
    await page.goto(`${OLD}/reserve#mm-move=${evil}`);
    await page.waitForURL(`${NEW}/**`);
    await waitForSb(page);
    expect(page.url()).not.toContain('mm-move');
    expect(await page.evaluate(() => localStorage.getItem('cq_session'))).toBeNull();
  });
});

// ── A phone that used the old address, with its real service worker ────────────
// The suite blocks workers; this one runs. A stand-in for Pages serves the repo on 127.0.0.1 as the
// old address: before the move as it is, after it through the middleware (the request named as the
// old address), with the static files of dist/_routes.json skipping it as on Cloudflare.
const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};
async function startOldHost(onRequest: Fn, state: { moved: boolean }) {
  const { routesJson } = await import(pathToFileURL(join(ROOT, 'scripts/assemble-dist.mjs')).href);
  const exclude: string[] = routesJson().exclude;
  const skips = (p: string) => exclude.some((x) => (x.endsWith('/*') ? p === x.slice(0, -2) || p.startsWith(x.slice(0, -1)) : p === x));
  const file = async (path: string): Promise<Response> => {
    if (path === '/index.html') return new Response(null, { status: 308, headers: { location: '/' } });
    const f = join(ROOT, path === '/' || /^\/(?:reserve|my-bookings|account)(?:\/|$)/.test(path) ? '/index.html' : path);
    if (!f.startsWith(ROOT)) return new Response('no', { status: 403 });
    try {
      const [body, s] = await Promise.all([readFile(f), stat(f)]);
      return new Response(body, { headers: { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache', etag: `"${s.size}-${Math.floor(s.mtimeMs)}"` } });
    } catch { return new Response('not found', { status: 404 }); }
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    let out: Response;
    if (state.moved && !skips(url.pathname)) {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && /^(sec-fetch-|accept$)/.test(k)) headers.set(k, v);
      out = await onRequest({ request: new Request(OLD + url.pathname + url.search, { method: req.method, headers }), next: () => file(decodeURIComponent(url.pathname)) });
    } else out = await file(decodeURIComponent(url.pathname));
    const h: Record<string, string> = {};
    out.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(out.status, h);
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise<void>((done) => server.close(() => done())) };
}

test.describe('@customer:move a phone with the old app cached', () => {
  test.use({ serviceWorkers: 'allow' });

  test('its worker is retired and the visit it answered from the cache is handed over', async ({ page }) => {
    test.setTimeout(90000); // a real worker installs twice here; under load that alone takes seconds
    const state = { moved: false };
    const old = await startOldHost(await middleware(), state);
    await page.route(/supabase\.co|open-meteo\.com|cloudflareinsights\.com/, (r) => r.abort());
    await stubRealtime(page);
    await page.route(`${NEW}/**`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>the new address</title>' }));
    try {
      // Before the move: the app, its worker and the rider's sign-in on the old address.
      await page.goto(old.url, { waitUntil: 'load' });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
      await page.evaluate(() => { localStorage.setItem('cq_session', JSON.stringify({ id: 'c1', session_token: 'tok' })); localStorage.setItem('cq_lang', 'ar'); });

      state.moved = true;
      // The worker answers this visit from its cache without asking the server, as it did every visit.
      // The retiring worker then says shell-updated: the app reloads by itself in its first seconds,
      // and past them shows its Refresh bar, as to a rider already using it, who taps it.
      await page.goto(`${old.url}my-bookings?x=1`, { waitUntil: 'commit' });
      const tap = page.locator('#upd-bar button').click({ timeout: 60000 }).catch(() => {});
      await page.waitForURL(`${NEW}/**`, { timeout: 60000 });
      await tap;
      const u = new URL(page.url());
      expect(u.origin + u.pathname + u.search).toBe(`${NEW}/my-bookings?x=1`);
      const carried = JSON.parse(Buffer.from(new URLSearchParams(u.hash.slice(1)).get('mm-move')!, 'base64url').toString('utf8'));
      expect(JSON.parse(carried['l:cq_session']).id).toBe('c1');
      expect(carried['l:cq_lang']).toBe('ar');

      // Nothing of the old app is left there that could answer a visit: no worker, no stored app,
      // no sign-in. (favicon.png is a static file, which skips the middleware there as on
      // Cloudflare.) What the old worker was still storing as it was retired can land after the
      // caches were emptied - a language pack, or its last refresh of the shell, which the server
      // answered with the hand-over page; with no worker nothing reads either, and the next
      // hand-over empties the caches again. The app itself is never among them.
      await page.goto(`${old.url}favicon.png`);
      await expect.poll(() => page.evaluate(async () => {
        const shell = await caches.match('/');
        return {
          workers: (await navigator.serviceWorker.getRegistrations()).length,
          app: !!shell && (await shell.text()).includes('/app.js?v='),
          session: localStorage.getItem('cq_session'),
        };
      })).toEqual({ workers: 0, app: false, session: null });
    } finally {
      await old.close();
    }
  });
});
