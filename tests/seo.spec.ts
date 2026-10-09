import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stubSupabase, waitForSb } from './helpers/supabase';

// The built page is almost entirely JavaScript. These pin the parts a crawler can actually
// see, and the language addressing that makes the Arabic site reachable at all.

test.describe('crawlable surface', () => {
  test('the built page carries static prose about the business in both languages', async () => {
    const html = await readFile(resolve(__dirname, '../index.html'), 'utf8');
    // the longest <noscript>: the <head> carries one of its own, the customer stylesheet (2026-10-09)
    const noscript = [...html.matchAll(/<noscript>[\s\S]*?<\/noscript>/g)].map((m) => m[0]).sort((a, b) => b.length - a.length)[0] ?? '';
    expect(noscript).toContain('Jeddah Corniche Circuit');
    expect(noscript).toContain('Road carbon');
    expect(noscript).toContain('Saturday Social Ride');
    expect(noscript).toContain('حلبة كورنيش جدة'); // the Arabic half
    // Enough words to describe a business, not the 48 the page used to expose.
    const words = noscript.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).length;
    expect(words).toBeGreaterThan(150);
  });

  test('every language has an address, declared with hreflang', async () => {
    const html = await readFile(resolve(__dirname, '../index.html'), 'utf8');
    for (const lang of ['en', 'ar']) {
      expect(html).toMatch(new RegExp(`hreflang="${lang}"[^>]*\\?lang=${lang}`));
    }
    expect(html).toContain('hreflang="x-default"');
  });

  test('the structured data names the phone, the map and the socials', async () => {
    const html = await readFile(resolve(__dirname, '../index.html'), 'utf8');
    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '';
    const data = JSON.parse(ld);
    expect(data['@type']).toBe('LocalBusiness');
    expect(data.telephone).toBe('+966566668818');
    expect(data.hasMap).toContain('maps.app.goo.gl');
    expect(data.sameAs).toContain('https://www.instagram.com/MicroMobilitySA/');
    expect(data.address.addressLocality).toBe('Jeddah');
    expect(data.makesOffer.priceCurrency).toBe('SAR');
  });

  test('no build-time placeholder survives into the served page', async () => {
    const html = await readFile(resolve(__dirname, '../index.html'), 'utf8');
    expect(html).not.toContain('__SITE_ORIGIN__');
  });

  test('the sitemap lists each language and cross-links the alternates', async () => {
    const xml = await readFile(resolve(__dirname, '../sitemap.xml'), 'utf8');
    for (const code of ['ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']) expect(xml).toContain(`?lang=${code}</loc>`);
    expect(xml).toContain('hreflang="x-default"');
  });

  test('robots keeps the staff stub and the design bundle out of the index', async () => {
    const txt = await readFile(resolve(__dirname, '../robots.txt'), 'utf8');
    expect(txt).toContain('Disallow: /staff/');
    expect(txt).toContain('Disallow: /design_handoff_erp_reskin/');
  });
});

test.describe('?lang addressing', () => {
  test('a lang parameter picks the language and sets direction, whatever this device used', async ({ page }) => {
    await stubSupabase(page, {});
    await page.addInitScript(() => localStorage.setItem('cq_lang', 'en'));
    await page.goto('/?lang=ar');
    await waitForSb(page);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  });

  test('an unknown lang falls back to the remembered choice', async ({ page }) => {
    await stubSupabase(page, {});
    await page.addInitScript(() => localStorage.setItem('cq_lang', 'ar'));
    await page.goto('/?lang=zz');
    await waitForSb(page);
    expect(await page.evaluate('S.lang')).toBe('ar');
  });

  // A remembered code the app does not carry (here a made-up one) lands on English rather
  // than on nothing — the boot only accepts a remembered code that is still in LANGS.
  test('a device that remembers an unknown language falls back to English', async ({ page }) => {
    await stubSupabase(page, {});
    await page.addInitScript(() => localStorage.setItem('cq_lang', 'xx'));
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate('S.lang')).toBe('en');
  });

  test('every language has an address: ?lang=es opens Spanish', async ({ page }) => {
    await stubSupabase(page, {});
    await page.goto('/?lang=es');
    await waitForSb(page);
    expect(await page.evaluate('S.lang')).toBe('es');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  });

  // One static canonical of "/" told search engines every ?lang address was a copy of the
  // English root, which voids the hreflang set. Each address must name itself, and only by
  // ?lang: other parameters and a remembered language do not change what the URL is.
  test('each language address is its own canonical, and there is only ever one', async ({ page }) => {
    const html = await readFile(resolve(__dirname, '../index.html'), 'utf8');
    expect(html).not.toMatch(/<link rel="canonical"/); // written by the head script alone
    await stubSupabase(page, {});
    await page.addInitScript(() => localStorage.setItem('cq_lang', 'ar'));
    for (const [path, search] of [['/?lang=ar', '?lang=ar'], ['/?lang=fr&bike=7', '?lang=fr'], ['/?lang=en', '?lang=en'], ['/', ''], ['/?lang=zz', '']] as const) {
      await page.goto(path);
      const hrefs = await page.evaluate(() => [...document.querySelectorAll('link[rel="canonical"]')].map((l) => (l as HTMLLinkElement).href));
      expect(hrefs, path).toHaveLength(1);
      const u = new URL(hrefs[0]);
      expect(u.origin, path).toMatch(/^https:\/\//); // the public origin, not the test server
      expect(u.pathname + u.search, path).toBe('/' + search);
    }
  });

  test('switching language writes it back into the URL so the page stays shareable', async ({ page }) => {
    await stubSupabase(page, {});
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setLang('ar')`);
    expect(new URL(page.url()).searchParams.get('lang')).toBe('ar');
  });
});

// One mark on every tab. The app pointed at logo.png - the wordmark lockup, 241x256 - so the
// tab squashed it and the word under the mark was a smudge at 16 px, while the partner form
// and the new site carried no icon at all and fell back to whatever the origin answered.
// favicon.png is the mark alone, square, and the same bytes on every Micromobility site.
test.describe('the tab icon', () => {
  test('every page this site serves points at the shared square mark', async ({ page }) => {
    for (const [file, href] of [['../index.html', '/favicon.png'], ['../404.html', '/favicon.png'], ['../staff/index.html', '/favicon.png']] as const) {
      const html = await readFile(resolve(__dirname, file), 'utf8');
      expect(html, file).toContain(`<link rel="icon" type="image/png" href="${href}">`);
    }
    // It is served, it is a PNG, and it is square: a tab stretches whatever shape it is given.
    const res = await page.request.get('/favicon.png');
    expect(res.status()).toBe(200);
    const png = Buffer.from(await res.body());
    expect(png.subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    expect(png.readUInt32BE(16)).toBe(png.readUInt32BE(20)); // IHDR width === height
  });

  test('it is the file the dist build ships', async () => {
    const dist = await readFile(resolve(__dirname, '../scripts/assemble-dist.mjs'), 'utf8');
    expect(dist).toContain("'favicon.png'"); // left out, the tab 404s in production only
  });
});

test.describe('installed app chrome', () => {
  // black-translucent draws white status-bar icons over the page; the header is white.
  test('the iPhone status bar keeps its own light ground with dark icons', async () => {
    const html = await readFile(resolve(__dirname, '../index.html'), 'utf8');
    expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default">');
  });

  // Chromium only hands a preload to a request with the same SRI metadata; a bare preload
  // was discarded and the library downloaded twice.
  test('the supabase-js preload carries the same integrity as its script tag', async () => {
    const html = await readFile(resolve(__dirname, '../index.html'), 'utf8');
    const pre = html.match(/<link rel="preload" as="script" href="\/vendor\/supabase-js[^"]*"[^>]*integrity="([^"]+)"/)?.[1];
    const tag = html.match(/<script[^>]* src="\/vendor\/supabase-js[^"]*"[^>]*integrity="([^"]+)"/)?.[1];
    expect(pre).toBeTruthy();
    expect(pre).toBe(tag);
  });

  // The loading-screen mark had the same problem from the other side: it is a CSS mask, and
  // masks are fetched in CORS mode, so a preload without crossorigin never matched either.
  test('no preload is thrown away and fetched a second time', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (m) => { if (/preload .* is found, but is not used/i.test(m.text())) warnings.push(m.text()); });
    await stubSupabase(page, {});
    await page.goto('/');
    await waitForSb(page);
    await page.waitForTimeout(500); // the unused-preload warning lands a moment after load
    expect(warnings).toEqual([]);
  });

  // iOS shows a launch image only when it is exactly the screen's pixel size; the dark set
  // was exported at twice that and every one was silently ignored.
  test('every launch image is exactly the pixel size of the screen it is declared for', async () => {
    const html = await readFile(resolve(__dirname, '../index.html'), 'utf8');
    const links = [...html.matchAll(/<link rel="apple-touch-startup-image" media="([^"]+)" href="([^"]+)"/g)];
    expect(links.length).toBeGreaterThan(10);
    for (const [, media, href] of links) {
      const n = (k: string) => Number(media.match(new RegExp(`${k}:\\s*([\\d.]+)`))?.[1]);
      const ratio = n('-webkit-device-pixel-ratio');
      const png = await readFile(resolve(__dirname, '..', href.replace(/\?.*$/, '').replace(/^\//, '')));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], href).toEqual([n('device-width') * ratio, n('device-height') * ratio]);
    }
  });
});
