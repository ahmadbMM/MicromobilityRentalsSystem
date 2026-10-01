import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { AddressInfo } from 'node:net';
import { stubRealtime } from './helpers/supabase';

// Service workers are blocked suite-wide (playwright.config.ts), so the worker itself has
// never been exercised. This file is the exception: it runs a real one.
//
// Cloudflare Pages answers /index.html with a 308 to /. The worker precached './index.html'
// at install, which stored a response carrying redirect history — and such a response cannot
// back a navigation: Safari refuses it ("Response served by service worker has redirections")
// and Chrome fails the load with ERR_FAILED. Because the entry was written at INSTALL time,
// every visit after the worker installed died, permanently, for every customer.
// The plain test server never redirects, so nothing here caught it.
test.use({ serviceWorkers: 'allow' });

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};

/** A stand-in for Cloudflare Pages: serves the repo, and 308s /index.html to /. */
async function startPagesMimic(): Promise<{ url: string; close: () => Promise<void> }> {
  const root = process.cwd();
  const server: Server = createServer((req, res) => {
    let path: string;
    try { path = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname); }
    catch { res.writeHead(400); res.end(); return; }
    if (path === '/index.html') { res.writeHead(308, { location: '/' }); res.end(); return; }
    // Cloudflare serves <dir>/index.html for a trailing slash, which is how /staff/ works; and
    // functions/_middleware.js answers the app's own addresses (/bookings, /sales...) with the app.
    const APP = /^\/(?:reserve|my-bookings|account|bookings|dashboard|sales|inventory|workshop|community|ambassadors|website|messages|analytics|history|team)(?:\/[a-z0-9-]+){0,2}\/?$/;
    const file = join(root, path === '/' || APP.test(path) ? '/index.html' : (path.endsWith('/') ? path + 'index.html' : path));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    // A stable ETag, as Cloudflare sends: without one the worker reports every shell as
    // changed and open pages reload themselves mid-navigation.
    Promise.all([readFile(file), stat(file)]).then(
      ([body, s]) => {
        res.writeHead(200, {
          'content-type': TYPES[extname(file)] || 'application/octet-stream',
          'cache-control': 'no-cache',
          etag: `"${s.size}-${Math.floor(s.mtimeMs)}"`,
        });
        res.end(body);
      },
      () => { res.writeHead(404); res.end('not found'); },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('the site still opens on the second visit when /index.html redirects', async ({ page }) => {
  const site = await startPagesMimic();
  // Keep the suite off the network: this spec does not stub Supabase, it just blocks it.
  // page.route() does not see websockets, so realtime is answered locally too.
  await page.route(/supabase\.co|open-meteo\.com|cloudflareinsights\.com/, (r) => r.abort());
  await stubRealtime(page);
  try {
    await page.goto(site.url, { waitUntil: 'load' });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });

    // The visits that used to fail: answered by the worker, from its cached shell.
    for (const visit of [2, 3]) {
      const res = await page.goto(site.url, { waitUntil: 'domcontentloaded' });
      expect(res?.status(), `visit ${visit} must load`).toBe(200);
    }

    // The shell is never stored under the URL that redirects.
    const keys = await page.evaluate(async () => {
      const names = await caches.keys();
      const out: string[] = [];
      for (const n of names) {
        const c = await caches.open(n);
        for (const r of await c.keys()) out.push(new URL(r.url).pathname);
      }
      return out;
    });
    expect(keys).toContain('/');
    expect(keys).not.toContain('/index.html');
  } finally {
    await site.close();
  }
});

test('a page that is not the root is never answered from, or stored as, the shell', async ({ page }) => {
  // /staff/ is a real page whose only job is to set the staff-entry flag and bounce to /.
  // The worker used to answer EVERY in-scope navigation from the one root cache entry, so
  // that page was served the customer app and never ran - and the background refresh then
  // wrote the ~500-byte stub UNDER the root key, so the next visitor to / got a page that
  // bounces them into the staff entry instead of the app.
  const site = await startPagesMimic();
  await page.route(/supabase\.co|open-meteo\.com|cloudflareinsights\.com/, (r) => r.abort());
  await stubRealtime(page);
  try {
    await page.goto(site.url, { waitUntil: 'load' });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });

    await page.goto(`${site.url}staff/`, { waitUntil: 'domcontentloaded' });
    // Give the worker's background refresh time to write whatever it is going to write.
    await page.waitForTimeout(1500);

    // The root shell must still be the app: the page that loads app.js (2026-10-01: the app's
    // script is its own file, so the page alone is no longer told apart by its size). The stub
    // loads no app.js.
    const shellIsApp = await page.evaluate(async () => {
      for (const n of await caches.keys()) {
        const hit = await (await caches.open(n)).match('./');
        if (hit) return (await hit.text()).includes('<script src="/app.js?v=');
      }
      return null;
    });
    expect(shellIsApp).toBe(true);

    // And a fresh visit to the root really does land on the app.
    await page.goto(site.url, { waitUntil: 'domcontentloaded' });
    expect(await page.locator('script[src^="/app.js?v="]').count()).toBe(1);
  } finally {
    await site.close();
  }
});

test('a section\'s own address is answered from the shell, and never stored as it', async ({ page }) => {
  // /sales and the other app addresses (2026-09-27) get the cached shell like the root, so a deep
  // link opens offline too; what is written back under the shell key is a fetch of the root itself.
  const site = await startPagesMimic();
  await page.route(/supabase\.co|open-meteo\.com|cloudflareinsights\.com/, (r) => r.abort());
  await stubRealtime(page);
  try {
    await page.goto(site.url, { waitUntil: 'load' });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });

    const res = await page.goto(`${site.url}bookings/waitlist`, { waitUntil: 'domcontentloaded' });
    expect(res?.status()).toBe(200);
    expect(await page.locator('script[src^="/app.js?v="]').count()).toBe(1); // the app's page, not a stub
    await page.waitForTimeout(1500);

    const keys = await page.evaluate(async () => {
      const out: string[] = [];
      for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) out.push(new URL(r.url).pathname);
      return out;
    });
    expect(keys).toContain('/');
    expect(keys).not.toContain('/bookings/waitlist');
    // The page's script and stylesheet ride in the shell, so it opens offline (2026-10-01).
    expect(keys).toContain('/app.js');
    expect(keys).toContain('/app.css');
    expect(keys).not.toContain('/index.html');
    // The root shell is still the app, not the page that was asked for.
    const shellIsApp = await page.evaluate(async () => {
      for (const n of await caches.keys()) { const hit = await (await caches.open(n)).match('./'); if (hit) return (await hit.text()).includes('<script src="/app.js?v='); }
      return null;
    });
    expect(shellIsApp).toBe(true);
  } finally {
    await site.close();
  }
});
