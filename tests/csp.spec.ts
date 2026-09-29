import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff } from './helpers/supabase';

// Since 2026-09-27 the page's Content-Security-Policy allows no inline script, and since 2026-09-29
// no inline style (every look is a class; run-time values go through the CSSOM): handlers live in
// data-on-<event> attributes (one listener per event type on the document runs them, app.src.html
// _onDispatch) and the few inline <script> blocks are allowed by their hashes, written into
// _headers by the build. These checks hold that line: the policy the server sends is the strict
// one and names every inline script the page carries; nothing the app renders - the customer's
// pages, every staff section and sub-view, the roster's dialogs, the bell - trips it; and the
// dispatcher keeps the contract the markup relies on.
//
// The suite as a whole bypasses the policy in the browser (playwright.config.ts): Playwright's
// string-form evaluate() runs through eval, which the policy forbids. This file turns the policy
// back on and drives the page with function-form calls only.
test.use({ bypassCSP: false });

// The app's globals, as the page has them (const/let bindings are not window properties).
declare const S: { view: string; dataLoaded: boolean; sfSession: string };
declare const sb: unknown;
declare const _lastLoadOk: boolean | undefined;
declare const _refsLoaded: boolean | undefined;
declare function getQueue(): unknown[];
declare function openAuthModal(): void;
declare function _ntToggle(): void;
declare function showWalkinModal(): void;
declare function closeWalkinModal(): void;
declare function showCheckinModal(id: string): void;
declare function closeCheckinModal(): void;
declare function setStaffTab(tab: string): void;
declare function showCommAddModal(group: boolean): void;
declare function closeCommAddModal(): void;
declare function renderStaffQueue(): void;
type Fns = Window & { __cspv: string[] } & Record<string, unknown>;

const S1 = '2099-01-09';
const sessions = [{ id: S1, day: 'Friday', session_date: S1, capacity: 12, status: 'open', created_at: 1 }];
const bikes = [{ id: 'b1', name: 'R-11', type: 'Road', size: 'M', status: 'available', colors: [] }];
const row = (id: string, n: number, x: Record<string, unknown> = {}) => ({
  id, name: 'Rider ' + id, session_id: S1, session_day: 'Friday', session_date: S1, queue_num: n, status: 'waiting', paid: false,
  price: 75, registered_at: S1 + 'T10:00:00Z', type_preference: 'Road', size: 'M', phone: '05500000' + n, ...x });
const queue_entries = [row('q1', 1), row('q2', 2, { status: 'active', paid: true, assigned_bike_id: 'b1' }), row('q3', 3, { status: 'done', paid: true })];

const watch = (page: Page) => page.addInitScript(() => {
  (window as unknown as Fns).__cspv = [];
  document.addEventListener('securitypolicyviolation', (e) => (window as unknown as Fns).__cspv.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber} ${e.sample || ''}`));
});
const violations = (page: Page) => page.evaluate(() => (window as unknown as Fns).__cspv.slice());
// waitForSb, in function form (the helper's string form would need eval).
const ready = (page: Page) => page.waitForFunction(() => typeof sb !== 'undefined' && !!sb && typeof S !== 'undefined' && !!S.dataLoaded
  && (typeof _lastLoadOk === 'undefined' || _lastLoadOk === true) && (typeof _refsLoaded === 'undefined' || _refsLoaded === true), undefined, { timeout: 10000 });

test('the server sends a policy without unsafe-inline for scripts or styles, naming every inline script the page carries', async ({ page }) => {
  await stubSupabase(page);
  const res = await page.goto('/');
  const csp = res!.headers()['content-security-policy'] || '';
  const script = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src')) || '';
  expect(script).toContain("'self'");
  expect(script).not.toContain("'unsafe-inline'");
  expect(script).not.toContain("'unsafe-eval'");
  const named = [...script.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]);
  const inline = await page.evaluate(async () => {
    const out: string[] = [];
    for (const s of Array.from(document.querySelectorAll('script:not([src])')) as HTMLScriptElement[]) {
      if (s.type && s.type !== 'text/javascript' && s.type !== 'module') continue; // ld+json is data, not script
      const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s.textContent || ''));
      out.push(btoa(String.fromCharCode(...new Uint8Array(d))));
    }
    return out;
  });
  expect(inline.length).toBeGreaterThanOrEqual(4);
  for (const h of inline) expect(named).toContain(h);
  const style = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('style-src')) || '';
  expect(style).toBe("style-src 'self' 'report-sample'");
  expect(csp).toContain('report-uri /api/csp-report');
  expect(res!.headers()['reporting-endpoints']).toContain('/api/csp-report');
  expect(await page.evaluate(() => document.querySelectorAll('[onclick],[oninput],[onchange],[onkeydown],[onsubmit]').length)).toBe(0);
});

test('a customer trips nothing: landing, reserve, sign-in, my bookings, account', async ({ page }) => {
  await watch(page);
  await stubSupabase(page, { sessions, bikes, queue_entries });
  for (const path of ['/', '/reserve', '/my-bookings', '/account']) {
    await page.goto(path);
    await ready(page);
    await page.waitForTimeout(150);
    expect(await violations(page), path).toEqual([]);
  }
  await page.goto('/');
  await ready(page);
  await page.evaluate(() => { openAuthModal(); });
  await page.waitForTimeout(100);
  await page.locator('button:visible').first().click(); // a real click goes through the dispatcher
  await page.waitForTimeout(100);
  expect(await violations(page)).toEqual([]);
});

test('a staffer trips nothing: every section and sub-view by its address, the roster dialogs, the bell', async ({ page }) => {
  await watch(page);
  await stubSupabase(page, { sessions, bikes, queue_entries });
  await unlockStaff(page);
  const paths = ['/bookings', '/bookings/sessions', '/bookings/waitlist', '/bookings/riders', '/dashboard', '/sales', '/inventory', '/inventory/supplements', '/inventory/equipment',
    '/workshop', '/community', '/community/stats', '/community/accounts', '/community/flagged', '/community/applications', '/community/birthdays', '/ambassadors',
    '/website', '/website/bikes', '/website/bikes/categories', '/website/bikes/fields', '/messages', '/analytics', '/history', '/history/log', '/team'];
  for (const path of paths) {
    await page.goto(path);
    await ready(page);
    await page.waitForFunction(() => S.view === 'staff' && S.dataLoaded);
    await page.waitForTimeout(150);
    expect(await violations(page), path).toEqual([]);
  }
  await page.goto('/bookings');
  await ready(page);
  await page.waitForFunction(() => S.view === 'staff' && getQueue().length === 3);
  const steps: [string, () => void][] = [
    ['bell open', () => { _ntToggle(); }], ['bell close', () => { _ntToggle(); }],
    ['walk-in', () => { showWalkinModal(); }], ['walk-in closed', () => { closeWalkinModal(); }],
    ['check-in', () => { showCheckinModal('q1'); }], ['check-in closed', () => { closeCheckinModal(); }],
    ['community add', () => { setStaffTab('community'); showCommAddModal(false); }], ['community add closed', () => { closeCommAddModal(); }],
    ['back to the roster', () => { setStaffTab('queue'); S.sfSession = '2099-01-09'; renderStaffQueue(); }],
  ];
  for (const [label, step] of steps) {
    await page.evaluate(step);
    await page.waitForTimeout(120);
    expect(await violations(page), label).toEqual([]);
  }
  await page.locator('.queue-table tbody tr:visible, .q-card:visible').first().locator('button:visible').first().click(); // a real click on the roster
  await page.waitForTimeout(100);
  expect(await violations(page)).toEqual([]);
});

test('the receipt\'s Print button stays off the paper, and the report\'s does too', async ({ page }) => {
  // Both windows' looks live in their own sheets (a strict style-src refuses <style> and style= in a
  // window the page writes). The receipt's button rule outranked its print rule and printed on the slip.
  await page.goto('/404.html');
  await page.setContent('<link rel="stylesheet" href="/receipt.css"><button class="rcpt-print rp-rbtn">Print</button>', { waitUntil: 'load' });
  await expect(page.locator('button')).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('button')).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await page.setContent('<link rel="stylesheet" href="/report.css"><button class="rep-print">Print</button>', { waitUntil: 'load' });
  await expect(page.locator('button')).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('button')).toBeHidden();
});

test('a violation the page meets goes into error_log with the element it came from, once, silently', async ({ page }) => {
  const logged: string[] = [];
  await stubSupabase(page);
  await page.route(/\/rest\/v1\/error_log/, async (route) => {
    if (route.request().method() === 'POST') { try { const b = route.request().postDataJSON(); logged.push(...(Array.isArray(b) ? b : [b]).map((r: { msg: string; src: string }) => `${r.msg} | ${r.src}`)); } catch { /* not JSON */ } }
    return route.fulfill({ status: 201, headers: { 'access-control-allow-origin': '*' }, body: '' });
  });
  // The policy as it is once styles are strict, with 'report-sample' so the style's own text is
  // reported (a no-op when the server already sends it).
  await page.route((u) => u.pathname === '/', async (route) => {
    const res = await route.fetch();
    const headers = { ...res.headers(), 'content-security-policy': (res.headers()['content-security-policy'] || '').replace(/style-src [^;]*/, "style-src 'self' 'report-sample'") };
    await route.fulfill({ response: res, headers });
  });
  await page.goto('/');
  await ready(page);
  await page.waitForTimeout(150);
  const before = logged.length;
  await page.evaluate(() => {
    const host = document.createElement('section'); host.id = 'csp-probe-host'; document.body.appendChild(host);
    host.innerHTML = '<div class="probe x" style="color:red">a</div><div class="probe x" style="color:red">b</div>';
    host.insertAdjacentHTML('beforeend', '<i style="color:blue"></i>');
  });
  await expect.poll(() => logged.length - before).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(300);
  const mine = logged.slice(before);
  expect(mine.filter((m) => m.includes('div.probe in #csp-probe-host'))).toHaveLength(1); // the same kind twice is logged once
  expect(mine.find((m) => m.includes('div.probe'))).toMatch(/^CSP style-src-attr: color:red at div\.probe in #csp-probe-host \| csp /);
  expect(mine.some((m) => m.includes('i in #csp-probe-host'))).toBe(true);
  await expect(page.locator('.toast')).toHaveCount(0); // silent: the rider sees nothing
  // What a browser injects is not the page's: an extension's styles, and the scripts Instagram's and
  // Facebook's in-app browsers add to every page (blocked by the policy, as they should be).
  const n = logged.length;
  await page.evaluate(() => {
    const fire = (o: Record<string, string>) => document.dispatchEvent(new SecurityPolicyViolationEvent('securitypolicyviolation', { effectiveDirective: 'script-src-elem', violatedDirective: 'script-src-elem', originalPolicy: '', disposition: 'enforce', documentURI: location.href, statusCode: 200, blockedURI: '', sourceFile: '', ...o }));
    fire({ blockedURI: 'https://connect.facebook.net/en_US/pcm.js', sourceFile: location.href });
    fire({ blockedURI: 'https://connect.facebook.net/en_US/promo.v2.js', sourceFile: 'iabjs' });
    fire({ effectiveDirective: 'style-src-attr', violatedDirective: 'style-src-attr', blockedURI: 'inline', sourceFile: 'chrome-extension://abc/content.js' });
    fire({ blockedURI: 'https://evil.example/x.js', sourceFile: location.href }); // anything else still counts
  });
  await expect.poll(() => logged.length - n).toBe(1);
  await page.waitForTimeout(300);
  expect(logged.slice(n)).toHaveLength(1);
  expect(logged[n]).toContain('evil.example');
});

test('the dispatcher: one call with the element and its value, several calls in a row, stopPropagation, no eval', async ({ page }) => {
  await stubSupabase(page);
  await page.goto('/');
  await ready(page);
  const r = await page.evaluate(() => {
    const log: unknown[][] = [];
    const w = window as unknown as Fns;
    w._cspProbe = function (this: HTMLElement, a: unknown, b: unknown, c: unknown) { log.push(['probe', a, b && (b as Node).nodeType ? (b as HTMLElement).id : b, c, this && this.id]); };
    w._cspStop = function (ev: Event) { log.push(['stop']); ev.stopPropagation(); };
    document.addEventListener('click', () => log.push(['document listener']));
    const mark = (m: string) => log.push([m]);
    const box = document.createElement('div'); box.id = 'outer'; box.setAttribute('data-on-click', JSON.stringify(['_cspProbe', 'outer']));
    const inp = document.createElement('input'); inp.id = 'in'; inp.value = 'typed'; inp.setAttribute('data-on-input', JSON.stringify(['_cspProbe', { '@': 'value' }, { '@': 'this' }, 1]));
    const btn = document.createElement('button'); btn.id = 'b'; btn.setAttribute('data-on-click', JSON.stringify([['_cspProbe', 'first'], ['_cspProbe', 'second']]));
    const stop = document.createElement('button'); stop.id = 's'; stop.setAttribute('data-on-click', JSON.stringify(['_cspStop', { '@': 'event' }]));
    const evil = document.createElement('button'); evil.id = 'e'; evil.setAttribute('data-on-click', 'alert(1)');
    box.append(inp, btn, stop, evil); document.body.appendChild(box);
    mark('input'); inp.dispatchEvent(new Event('input', { bubbles: true }));
    mark('list'); btn.click();
    mark('stop'); stop.click();
    mark('not json'); evil.click();
    box.remove();
    return log;
  });
  expect(r).toEqual([
    ['input'], ['probe', 'typed', 'in', 1, 'in'],                                     // the input's value and the element itself; this = the element
    ['list'], ['probe', 'first', undefined, undefined, 'b'], ['probe', 'second', undefined, undefined, 'b'], ['probe', 'outer', undefined, undefined, 'outer'], ['document listener'],
    ['stop'], ['stop'],                                                                // stopPropagation: the outer handler and the document's own listener stay out
    ['not json'], ['probe', 'outer', undefined, undefined, 'outer'], ['document listener'], // a string that is not JSON runs nothing itself; the click still bubbles
  ]);
});
