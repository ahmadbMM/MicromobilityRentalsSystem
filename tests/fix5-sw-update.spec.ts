import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { AddressInfo } from 'node:net';
import { stubRealtime } from './helpers/supabase';

// A deploy reaches a tab left open (2026-10-05). The page asks for a new service worker once an hour
// (a booth tab never navigates); a new one installed, activated and took the tab over, but only a
// navigation's refresh ever said 'shell-updated', so the tab ran the old build until someone reloaded
// it. The worker now says it as it activates over an older version's cache, and the page also reads
// 'controllerchange' that way. Like tests/sw-navigation.spec.ts, this runs a real worker.
test.use({ serviceWorkers: 'allow' });

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
};

type State = { deploy?: boolean; quiet?: boolean };
/** Cloudflare Pages, stood in for. With state.deploy the worker is a new version (another cache
 *  name); with state.quiet too, that version does not post 'shell-updated' itself, so only the
 *  browser's controllerchange is left to tell the page. */
async function startSite(state: State): Promise<{ url: string; close: () => Promise<void> }> {
  const root = process.cwd();
  const server: Server = createServer((req, res) => {
    let path: string;
    try { path = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname); }
    catch { res.writeHead(400); res.end(); return; }
    if (path === '/index.html') { res.writeHead(308, { location: '/' }); res.end(); return; }
    const file = join(root, path === '/' ? '/index.html' : (path.endsWith('/') ? path + 'index.html' : path));
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    Promise.all([readFile(file), stat(file)]).then(
      ([body, s]) => {
        let out: Buffer | string = body;
        if (path === '/service-worker.js' && state.deploy) {
          let sw = body.toString('utf8').replace(/const CACHE = '([^']*)';/, "const CACHE = '$1next';");
          if (state.quiet) sw = sw.replace(/\n\s*\.then\(\(\) => updated && [^\n]*/, '');
          out = sw;
        }
        res.writeHead(200, {
          'content-type': TYPES[extname(file)] || 'application/octet-stream',
          'cache-control': 'no-cache',
          etag: `"${s.size}-${Math.floor(s.mtimeMs)}${path === '/service-worker.js' && state.deploy ? '-next' : ''}"`,
        });
        res.end(out);
      },
      () => { res.writeHead(404); res.end('not found'); },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function openControlled(page: Page, url: string) {
  await page.route(/supabase\.co|open-meteo\.com|cloudflareinsights\.com/, (r) => r.abort());
  await stubRealtime(page);
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(() => { (window as unknown as { __mark?: number }).__mark = 1; }); // gone if the page reloads
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
}
const marked = (page: Page) => page.evaluate(() => (window as unknown as { __mark?: number }).__mark === 1);
const update = (page: Page) => page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r!.update(); });

test.describe('@staff:reliability a deploy reaches a tab left open', () => {
  test('the first install is not an update; a worker the hourly check installs brings the Refresh bar', async ({ page }) => {
    const state: State = {};
    const site = await startSite(state);
    try {
      await openControlled(page, site.url);
      // The first install took the page over (controllerchange, no older cache): nothing to say.
      await page.waitForTimeout(1500);
      await expect(page.locator('#upd-bar')).toHaveCount(0);
      expect(await marked(page)).toBe(true);
      // Someone is using the page, so the update is offered, not forced (a reload comes when it is hidden).
      await page.keyboard.press('Shift');
      // what the worker itself says, apart from the browser's controllerchange
      await page.evaluate(() => navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'shell-updated') (window as unknown as { __heard?: boolean }).__heard = true; }));
      state.deploy = true;
      await update(page);
      await expect(page.locator('#upd-bar')).toBeVisible({ timeout: 20000 });
      await expect.poll(() => page.evaluate(() => (window as unknown as { __heard?: boolean }).__heard === true)).toBe(true);
      expect(await marked(page)).toBe(true); // offered, never yanked away
    } finally {
      await site.close();
    }
  });

  test('controllerchange alone is heard: a new worker that says nothing still brings the bar', async ({ page }) => {
    const state: State = {};
    const site = await startSite(state);
    try {
      await openControlled(page, site.url);
      await page.keyboard.press('Shift');
      Object.assign(state, { deploy: true, quiet: true });
      await update(page);
      await expect(page.locator('#upd-bar')).toBeVisible({ timeout: 20000 });
      expect(await marked(page)).toBe(true);
    } finally {
      await site.close();
    }
  });
});
