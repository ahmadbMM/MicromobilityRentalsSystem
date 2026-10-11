import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { AddressInfo } from 'node:net';
import { stubSupabase, stubRealtime } from './helpers/supabase';

// A rider offline at the Corniche after a deploy (2026-10-10 audit): every deploy deleted the old cache with
// the QR library, the fonts and the database library in it, so the ticket waited 7 s for a library that was not
// coming and then showed an empty white tile where the code should be. Three fixes, one test each.

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain',
};
async function serveRepo(): Promise<{ url: string; close: () => Promise<void> }> {
  const root = process.cwd();
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname);
    const file = join(root, path === '/' ? '/index.html' : path);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    readFile(file).then(
      (body) => { res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(body); },
      () => { res.writeHead(404); res.end('not found'); },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test.describe('@customer:offline a ticket with no signal', () => {
  test.describe('the worker', () => {
    test.use({ serviceWorkers: 'allow' });

    test('stores what a ticket needs, and carries what an older version stored across the update', async ({ page }) => {
      const site = await serveRepo();
      await page.route(/supabase\.co|open-meteo\.com|cloudflareinsights\.com/, (r) => r.abort());
      await stubRealtime(page);
      try {
        // An older version's cache, as a phone holds it after earlier visits: a language pack and the scanner's
        // library (named by version), and an unversioned image.
        await page.goto(site.url + 'robots.txt');
        await page.evaluate(() => caches.open('mmcq-oldversion0').then((c) => Promise.all([
          c.put('/lang/ar.json?v=abcdef0123', new Response('{"kept":1}')),
          c.put('/vendor/jsqr-1.4.0.min.js', new Response('/* kept */')),
          c.put('/not-versioned.png', new Response('x')),
        ])));
        await page.goto(site.url, { waitUntil: 'load' });
        await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
        // The older cache makes this an update, so the worker tells the page and it reloads itself in the first
        // seconds (fix5-sw-update): the read is retried until the page holds still.
        const read = () => page.evaluate(async () => {
          const keys = await caches.keys();
          const name = keys.find((k) => k.startsWith('mmcq-') && k !== 'mmcq-oldversion0') || '';
          const c = await caches.open(name);
          const has = async (u: string) => !!(await c.match(u, { ignoreSearch: false }));
          return {
            keys,
            qr: await has('/vendor/qrcode-generator-2.0.4.js'),
            db: await has('/vendor/supabase-js-2.117.2.min.js'),
            riyal: await has('/fonts/Riyal-400.woff2'),
            face: await has('/fonts/SpaceGrotesk-var-latin.woff2'),
            pack: await has('/lang/ar.json?v=abcdef0123'),
            scanner: await has('/vendor/jsqr-1.4.0.min.js'),
            img: await has('/not-versioned.png'),
          };
        });
        await expect.poll(async () => { try { return await read(); } catch { return null; } }, { timeout: 10000 })
          .toMatchObject({ qr: true, db: true, riyal: true, face: true, pack: true, scanner: true, img: false });
        const r = await read();
        expect(r.keys).not.toContain('mmcq-oldversion0'); // the old version still goes
      } finally {
        await site.close();
      }
    });
  });

  test('with the database library unreachable, the boot stops waiting once the page has loaded, not after 7 s', async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [] });
    await page.route(/\/vendor\/supabase-js-/, (r) => r.abort());
    await page.goto('/');
    const ms = await page.evaluate('_sbReady.then(()=>performance.now())');
    expect(Number(ms)).toBeLessThan(5000);
  });

  test('the QR library unreachable: the code is shown in words, then drawn once back online', async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [] });
    let block = true;
    await page.route(/\/vendor\/qrcode-generator-/, (r) => (block ? r.abort() : r.fallback()));
    await page.goto('/');
    await page.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="tk-spec">'+ticketQR('MMC-7-abc123',112)+'</div>')`);
    const fb = page.locator('#tk-spec .qr-fb');
    await expect(fb).toBeVisible();
    await expect(fb).toContainText('No signal to draw the code');
    await expect(fb.locator('.qr-fb-c')).toHaveText('MMC-7-abc123');
    block = false;
    await page.evaluate(`window.dispatchEvent(new Event('online'))`);
    await expect(page.locator('#tk-spec .cu-qr-box')).toHaveCount(1);
    await expect(page.locator('#tk-spec .qr-fb')).toHaveCount(0);
  });
});
