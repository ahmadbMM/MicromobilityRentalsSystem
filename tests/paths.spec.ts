import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Every section and sub-view has its own address (owner, 2026-09-27): the staff sections are the
// rail's words (/bookings, /sales, /website/bikes...), a sub-view is a second segment, the customer
// pages are /reserve, /my-bookings and /account. The address follows the page, a deep link opens
// on that page, Back and Forward walk the addresses, and the old ?tab= / ?staff links still work.
// The test server (scripts/serve.mjs) answers these addresses with the app, as functions/_middleware.js
// does on Cloudflare, so a deep link and a reload behave here as they do there.

const sessions = [
  { id: '2099-05-05', day: 'Tuesday', session_date: '2099-05-05', capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00"}' },
  { id: '2099-05-12', day: 'Tuesday', session_date: '2099-05-12', capacity: 40, status: 'open', created_at: 2, bike_slots: '{"_time":"21:00 - 23:00"}' },
];
const base = { sessions, queue_entries: [], bikes: [], catalog_categories: [], catalog_spec_fields: [], catalog_models: [], catalog_colors: [], catalog_photos: [] };

async function staff(page: Page, path = '/') {
  await stubSupabase(page, base);
  await unlockStaff(page);
  await page.goto(path);
  await waitForSb(page);
}
const at = (page: Page) => { const u = new URL(page.url()); return u.pathname + u.search; };

test.describe('the three lists of addresses agree', () => {
  const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
  const names = (src: string, re: RegExp) => { const m = src.match(re); if (!m) throw new Error('list not found'); return m[1].split('|').sort(); };
  test('router, middleware and service worker name the same sections', () => {
    const app = read('app.src.html');
    const staffPaths = [...app.match(/const STAFF_PATHS=\{([^}]+)\}/)![1].matchAll(/:'([a-z/-]+)'/g)].map((m) => m[1].split('/')[0]);
    const custPaths = [...app.match(/const CUST_PATHS=\{([^}]+)\}/)![1].matchAll(/:'([a-z-]+)'/g)].map((m) => m[1]);
    const router = [...new Set([...staffPaths, ...custPaths])].sort();
    const mw = names(read('functions/_middleware.js'), /const APP_ROUTE = \/\^\\\/\(\?:([a-z|-]+)\)/);
    const sw = names(read('service-worker.js'), /const APP_ROUTE = \/\^\\\/\(\?:([a-z|-]+)\)/);
    expect(mw).toEqual(router);
    expect(sw).toEqual(router);
    expect(names(read('scripts/serve.mjs'), /const APP_ROUTE = \/\^\\\/\(\?:([a-z|-]+)\)/)).toEqual(router);
    const staffOnly = [...new Set(staffPaths)].sort();
    expect(names(read('functions/_middleware.js'), /const STAFF_ROUTE = \/\^\\\/\(\?:([a-z|-]+)\)/)).toEqual(staffOnly);
    expect(names(read('service-worker.js'), /const STAFF_ROUTE = \/\^\\\/\(\?:([a-z|-]+)\)/)).toEqual(staffOnly);
  });
  test('the built page loads its files from the root, so a deep address still finds them', () => {
    const html = read('index.html');
    expect(html).not.toMatch(/(?:href|src)="\.\//);
    expect(html).toContain('href="/styles.css?v=');
    expect(html).toMatch(/register\(["']\/service-worker\.js["']\)/); // the minifier picks the quotes
    // Addresses built at run time too: the printed reports' logo used to be new URL('logo.png', location.href),
    // which from /bookings/riders asked for /bookings/logo.png.
    expect(html).not.toMatch(/new URL\(["'][a-z][^"']*["'],\s*location/);
  });
});

test.describe('the server', () => {
  const mw = async (url: string, opts: { status?: number; headers?: Record<string, string>; assets?: boolean } = {}) => {
    const mod = await import(pathToFileURL(resolve(__dirname, '..', 'functions/_middleware.js')).href + '?p=' + Math.random());
    const ctx = {
      request: new Request(url, { headers: opts.headers || { 'sec-fetch-mode': 'navigate', accept: 'text/html' } }),
      next: () => new Response(opts.status === 404 ? 'not found' : 'asset', { status: opts.status || 200 }),
      env: opts.assets === false ? {} : { ASSETS: { fetch: async (u: URL) => new Response('shell ' + new URL(String(u)).pathname, { headers: { 'content-type': 'text/html' } }) } },
    };
    return mod.onRequest(ctx) as Promise<Response>;
  };
  test('answers a deep address with the app when Pages has no file for it', async () => {
    for (const path of ['/bookings', '/bookings/waitlist', '/community/applications', '/website/bikes/fields', '/my-bookings', '/sales/']) {
      const r = await mw('https://staff.micromobility.sa' + path, { status: 404 });
      expect(r.status, path).toBe(200);
      expect(await r.text(), path).toBe('shell /'); // the root, never /index.html (a 308 on Pages)
    }
  });
  test('leaves a real file, an unknown address and a non-page request alone', async () => {
    expect(await (await mw('https://staff.micromobility.sa/bookings', { status: 200 })).text()).toBe('asset');
    expect((await mw('https://staff.micromobility.sa/nope', { status: 404 })).status).toBe(404);
    expect((await mw('https://staff.micromobility.sa/bookings/a/b/c', { status: 404 })).status).toBe(404);
    expect((await mw('https://staff.micromobility.sa/bookings', { status: 404, headers: { 'sec-fetch-mode': 'cors', accept: '*/*' } })).status).toBe(404);
    expect((await mw('https://staff.micromobility.sa/bookings', { status: 404, headers: { accept: 'application/json' } })).status).toBe(404);
  });
  test('sends a staff address on the live customer host to the staff address, path and query kept', async () => {
    const live = 'https://micromobilityrentals.pages.dev';
    for (const [path, to] of [['/sales', '/sales'], ['/bookings/waitlist?lang=ar', '/bookings/waitlist?lang=ar'], ['/website/bikes/', '/website/bikes'], ['/team', '/team']]) {
      const r = await mw(live + path);
      expect(r.status, path).toBe(302);
      expect(r.headers.get('location'), path).toBe('https://staff.micromobility.sa' + to);
    }
    // The customer's own pages stay where they are.
    for (const path of ['/reserve', '/my-bookings', '/account', '/']) expect((await mw(live + path)).status, path).toBe(200);
  });
});

test.describe('staff', () => {
  test('opens on /bookings, and the address follows the section and its sub-view', async ({ page }) => {
    await staff(page);
    expect(at(page)).toBe('/bookings');
    await page.evaluate(`setStaffTab('cashier')`);
    expect(at(page)).toBe('/sales');
    await page.evaluate(`setStaffTab('waitlist')`);
    expect(at(page)).toBe('/bookings/waitlist');
    await page.evaluate(`S.queueView='sessions';renderStaffQueue()`);
    expect(at(page)).toBe('/bookings/sessions');
    await page.evaluate(`setStaffTab('community');setCommTab('applications')`);
    expect(at(page)).toBe('/community/applications');
    await page.evaluate(`setStaffTab('catalog');_cat().view='fields';renderCatalog()`);
    expect(at(page)).toBe('/website/bikes/fields');
    await page.evaluate(`setStaffTab('history');S.histView='log';renderHistory()`);
    expect(at(page)).toBe('/history/log');
    // Back walks the addresses and the pages together.
    await page.goBack();
    await page.waitForFunction(`S.staffTab==='history'&&S.histView==='rides'`);
    expect(at(page)).toBe('/history');
    await page.goBack();
    await page.waitForFunction(`S.staffTab==='catalog'`);
    expect(at(page)).toBe('/website/bikes/fields');
    await page.goForward();
    await page.waitForFunction(`S.staffTab==='history'`);
  });

  test('a deep link opens on that section and sub-view', async ({ page }) => {
    await staff(page, '/website/bikes/categories');
    expect(await page.evaluate('S.staffTab')).toBe('catalog');
    expect(await page.evaluate('_cat().view')).toBe('categories');
    await expect(page.locator('#tab-catalog .cat-pills .filter-pill.active')).toContainText('Categories');
    expect(at(page)).toBe('/website/bikes/categories');
  });

  test('/bookings/riders opens the Petromin page; an unknown sub-view opens the section itself', async ({ page }) => {
    await staff(page, '/bookings/riders');
    expect(await page.evaluate('[S.staffTab,S.queueView]')).toEqual(['queue', 'petromin']);
    expect(at(page)).toBe('/bookings/riders');
    await staff(page, '/bookings/nope');
    expect(await page.evaluate('[S.staffTab,S.queueView]')).toEqual(['queue', 'bookings']);
    expect(at(page)).toBe('/bookings');
  });

  test('a picked ride goes in the address; a plain /bookings still opens on the current ride', async ({ page }) => {
    await staff(page);
    expect(at(page)).toBe('/bookings'); // the current ride, unnamed
    await page.evaluate(`setSfSession('2099-05-12')`);
    expect(at(page)).toBe('/bookings?session=2099-05-12');
    await page.evaluate(`setStaffTab('cashier')`);
    expect(at(page)).toBe('/sales'); // Bookings' own query leaves with it
    // The shared link names the ride.
    await staff(page, '/bookings?session=2099-05-12');
    expect(await page.evaluate('S.sfSession')).toBe('2099-05-12');
    expect(at(page)).toBe('/bookings?session=2099-05-12');
    // A ride that does not exist is ignored: the current one, and a clean address.
    await staff(page, '/bookings?session=2099-09-09');
    expect(await page.evaluate('S.sfSession')).not.toBe('2099-09-09');
    expect(at(page)).toBe('/bookings');
  });

  test('the old ?staff link still opens staff, and comes off the address; ?lang stays', async ({ page }) => {
    await staff(page, '/?staff&lang=en');
    expect(await page.evaluate('S.view')).toBe('staff');
    expect(at(page)).toBe('/bookings?lang=en');
  });

  test('an address that is not one of the app\'s is a 404 on the server, and inside the app opens as / does', async ({ page, request }) => {
    expect((await request.get('/no-such-section')).status()).toBe(404);
    await staff(page);
    await page.evaluate(`history.pushState(null,'','/no-such-section');dispatchEvent(new PopStateEvent('popstate',{state:null}))`);
    await page.waitForFunction(`S.view==='staff'`);
    expect(at(page)).toBe('/bookings');
  });
});

test.describe('customers', () => {
  test('a signed-in rider opens My Bookings and My Account by their addresses', async ({ page }) => {
    await stubSupabase(page, base);
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
      await page.goto('/my-bookings');
    await waitForSb(page);
    await page.waitForFunction(`S.view==='customer'&&S.custTab==='myrides'`);
    expect(at(page)).toBe('/my-bookings');
    await page.goto('/account');
    await waitForSb(page);
    await page.waitForFunction(`S.view==='customer'&&S.custTab==='account'`);
    expect(at(page)).toBe('/account');
    // Moving between the tabs moves the address; /reserve is the event picker, at /.
    await page.evaluate(`setCustTab('myrides')`);
    expect(at(page)).toBe('/my-bookings');
    await page.evaluate(`goLanding()`);
    expect(at(page)).toBe('/');
    await page.goBack();
    await page.waitForFunction(`S.view==='customer'&&S.custTab==='myrides'`);
    expect(at(page)).toBe('/my-bookings');
  });

  test('/reserve is the event picker', async ({ page }) => {
    await stubSupabase(page, base);
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
      await page.goto('/reserve?lang=en');
    await waitForSb(page);
    expect(await page.evaluate('S.view')).toBe('landing');
    expect(at(page)).toBe('/?lang=en');
  });

  test('a signed-out visitor keeps /my-bookings for after signing in', async ({ page }) => {
    await stubSupabase(page, base);
      await page.goto('/my-bookings');
    await waitForSb(page);
    expect(await page.evaluate(`sessionStorage.getItem('cq_open_tab')`)).toBe('myrides');
    expect(await page.evaluate('S.view')).toBe('landing');
    expect(at(page)).toBe('/');
  });

  test('the old ?tab=bookings link becomes /my-bookings', async ({ page }) => {
    await stubSupabase(page, base);
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/?lang=en&tab=bookings');
    await waitForSb(page);
    await page.waitForFunction(`S.view==='customer'&&S.custTab==='myrides'`);
    expect(at(page)).toBe('/my-bookings?lang=en');
  });
});
