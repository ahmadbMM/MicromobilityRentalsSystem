import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// How a staff screen keeps up with the database: realtime rows merged in place, the reloads
// behind them, reconnects, and the poll that stands in when realtime is down.
const SID = '2099-02-10';
const sessions = [{ id: SID, day: 'Friday', session_date: SID, capacity: 12, status: 'open', created_at: 1 }];
const row = (id: string, qn: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: SID, session_day: 'Friday', session_date: SID, queue_num: qn, name, phone: '', email: '', customer_id: null,
  group_id: null, status: 'waiting', paid: false, price: 30, walk_in: true, registered_at: '2099-01-01T10:00:00Z',
  type_preference: 'Road', size: 'M', purchases: null, addons: null, ...extra,
});

test('a realtime row that lands while a reload is in flight is not undone by that reload', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [row('e1', 1, 'First')] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length===1');
  // Hold the next queue read at the server: its answer is the database as it was BEFORE the
  // check-in below, which is exactly what a reload racing an event gets back.
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let seen = false;
  await page.route(/\/rest\/v1\/queue_entries/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    seen = true;
    await held;
    return route.fallback();
  });
  await page.evaluate("window.__noWiden=false; S.view='staff'; window.__p=loadDataLight(); 0"); // not awaited: it is held
  await expect.poll(() => seen).toBe(true);
  await page.evaluate((r) => {
    // @ts-expect-error app globals
    _onRt({ table: 'queue_entries', eventType: 'UPDATE', new: { ...r, status: 'active', checked_in_at: '2099-02-10T18:00:00Z' }, old: { id: 'e1' } });
  }, row('e1', 1, 'First'));
  expect(await page.evaluate("getQueue().find(e=>e.id==='e1').status")).toBe('active');
  release();
  await page.evaluate('window.__p');
  expect(await page.evaluate("getQueue().find(e=>e.id==='e1').status")).toBe('active');
});

test('a rider change broadcast while the customer list is being read survives the read', async ({ page }) => {
  const customers = [{ id: 'c1', name: 'Old Name', email: 'a@b.c', phone: '0500000001', created_at: '2099-01-01T00:00:00Z' }];
  await stubSupabase(page, { sessions, customers });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let seen = false;
  await page.route(/\/rest\/v1\/customers/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    seen = true;
    await held;
    return route.fallback();
  });
  await page.evaluate('refDirty(); window.__p=_refFetch(); 0'); // not awaited: it is held
  await expect.poll(() => seen).toBe(true);
  // What the staff-ref broadcast handler does with a customers event.
  await page.evaluate(() => {
    const p = { op: 'UPDATE', id: 'c1', row: { id: 'c1', name: 'New Name', email: 'a@b.c', phone: '0500000001', created_at: '2099-01-01T00:00:00Z' } };
    // @ts-expect-error app globals
    _rtRefMerge('customers', p); _rtNote('ref', { kind: 'customers', p });
  });
  release();
  await page.evaluate('window.__p');
  expect(await page.evaluate("S.customers.find(c=>c.id==='c1').name")).toBe('New Name');
});

test('an incomplete realtime row is read back, not merged over the fields it left out', async ({ page }) => {
  const purchases = JSON.stringify([{ id: 'gel', name: 'Gel', qty: 1, price: 10, pay: 'paid' }]);
  await stubSupabase(page, { sessions, queue_entries: [row('e1', 1, 'First', { purchases })] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length===1');
  await page.evaluate("window.__noWiden=false; S.view='staff'");
  await page.evaluate('loadDataLight()'); // learns the whole row's columns
  expect(await page.evaluate("entryPurchases(getQueue()[0]).length")).toBe(1);
  const gets: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/queue_entries')) gets.push(decodeURIComponent(r.url())); });
  // An UPDATE that left the purchases column out (unchanged, stored out of line).
  await page.evaluate(() => {
    // @ts-expect-error app globals
    _onRt({ table: 'queue_entries', eventType: 'UPDATE', new: { id: 'e1', session_id: '2099-02-10', status: 'active', queue_num: 1, name: 'First' }, old: { id: 'e1' } });
  });
  expect(await page.evaluate("entryPurchases(getQueue()[0]).length")).toBe(1);
  await expect.poll(() => gets.some((u) => u.includes('id=in.(e1)'))).toBe(true);
  // A row the server cut down for size says so; it is read back as well.
  gets.length = 0;
  await page.evaluate(() => {
    // @ts-expect-error app globals
    _onRt({ table: 'queue_entries', eventType: 'UPDATE', errors: ['Error 413: Payload Too Large'], new: { ...JSON.parse(JSON.stringify(getQueue()[0])), id: 'e1' }, old: { id: 'e1' } });
  });
  await expect.poll(() => gets.some((u) => u.includes('id=in.(e1)'))).toBe(true);
});

test('realtime errors schedule one rebuild at a time, and a rejoin catches up', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [row('e1', 1, 'First')] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  // Fake channels: removing one that never joined reports CLOSED at once, as supabase-js does.
  await page.evaluate(() => {
    const w = window as unknown as { __chans: { cb: ((s: string) => void) | null }[] };
    w.__chans = [];
    // @ts-expect-error app globals
    sb.channel = () => { const ch = { cb: null as ((s: string) => void) | null, on() { return ch; }, subscribe(cb: (s: string) => void) { ch.cb = cb; return ch; } }; w.__chans.push(ch); return ch; };
    // @ts-expect-error app globals
    sb.removeChannel = (c: { cb: ((s: string) => void) | null }) => { if (c.cb) c.cb('CLOSED'); return Promise.resolve('ok'); };
    // @ts-expect-error app globals
    _rtChannel = null; _rtRetry = 0; if (_rtRetryT) { clearTimeout(_rtRetryT); _rtRetryT = null; }
    // @ts-expect-error app globals
    setupRealtime();
  });
  // A staff device's channel joins once its session has been read (2026-10-04), a tick later.
  await page.waitForFunction('window.__chans.length===1');
  await page.evaluate(() => {
    const ch = (window as unknown as { __chans: { cb: ((s: string) => void) | null }[] }).__chans[0];
    ch.cb!('CHANNEL_ERROR'); ch.cb!('CHANNEL_ERROR'); ch.cb!('TIMED_OUT');
  });
  // Three error reports, then the rebuild at 1s whose removal reports CLOSED: one rebuild only.
  await page.waitForTimeout(3200);
  expect(await page.evaluate('window.__chans.length')).toBe(2);
  // The new channel joins after the old one had been live: that is a rejoin, and it reloads once.
  const gets: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/queue_entries')) gets.push(r.url()); });
  await page.evaluate("window.__noWiden=false; S.view='staff'; _rtWasLive=true; window.__chans[1].cb('SUBSCRIBED')");
  await expect.poll(() => gets.length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(await page.evaluate('S._rtConnected')).toBe(true);
});

test('an edit that keeps the row count still repaints the tab (sales, desk waitlist)', async ({ page }) => {
  const sale = { id: 's1', receipt_id: 'r1', session_id: SID, name: 'Gel', category: 'Food', qty: 1, price: 10, pay: 'pending', created_at: '2099-02-10T18:00:00Z' };
  await stubSupabase(page, { sessions, queue_entries: [row('e1', 1, 'First')], cashier_sales: [sale] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate("window.__noWiden=false; S.view='staff'; S.staffTab='cashier'");
  await page.evaluate('_autoRefresh(false)'); // settles the fingerprint of what is on screen
  // Another till takes the payment: same number of rows, one field changed.
  await page.route(/\/rest\/v1\/cashier_sales/, (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json', 'content-range': '0-1/1' }, body: JSON.stringify([{ ...sale, pay: 'paid' }]) })
    : route.fallback());
  await page.evaluate("window.__paints=0; const f=window.renderCashier; window.renderCashier=function(){window.__paints++;return f.apply(this,arguments);}");
  await page.evaluate((r) => {
    // @ts-expect-error app globals
    _onRt({ table: 'cashier_sales', eventType: 'UPDATE', new: r, old: { id: 's1' } });
  }, { ...sale, pay: 'paid' });
  await expect.poll(() => page.evaluate('window.__paints'), { timeout: 5000 }).toBeGreaterThan(0);
  expect(await page.evaluate("S.cashSales.find(r=>r.id==='s1').pay")).toBe('paid');
  // The print sees a waitlist status change and a sale's pay change, not only counts.
  const moved = await page.evaluate(() => {
    // @ts-expect-error app globals
    S.deskWaitlist = [{ id: 'w1', status: 'waiting' }]; const a = _staffFingerprint();
    // @ts-expect-error app globals
    S.deskWaitlist = [{ id: 'w1', status: 'done' }]; const b = _staffFingerprint();
    return a !== b;
  });
  expect(moved).toBe(true);
});

test('a poll that cannot reach the server says so and does not call the screen fresh', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [row('e1', 1, 'First')] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.route(/\/rest\/v1\/(queue_entries|sessions)/, (route) => route.abort('failed'));
  const out = await page.evaluate(async () => {
    // @ts-expect-error app globals
    window.__noWiden = false; S.view = 'staff'; _lastRefresh = 0;
    // @ts-expect-error app globals
    await _autoRefresh(false);
    // @ts-expect-error app globals
    return { down: S._netDown, last: _lastRefresh, queue: getQueue().length, banner: !!document.getElementById('conn-banner') };
  });
  expect(out.down).toBe(true);
  expect(out.last).toBe(0);
  expect(out.queue).toBe(1); // state kept
  expect(out.banner).toBe(true);
});

test('a bike event on a customer device reloads the light set, never the photos', async ({ page }) => {
  await stubSupabase(page, { sessions, bikes: [{ id: 'b1', name: 'B1', status: 'available', type: 'Road', size: 'M' }] });
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  const urls: string[] = [];
  page.on('request', (r) => { if (r.method() === 'GET' && r.url().includes('/rest/v1/')) urls.push(decodeURIComponent(r.url())); });
  await page.evaluate("window.__noWiden=false; S.view='customer'; S.custTab='myrides'");
  await page.evaluate("_onRt({table:'bikes',eventType:'UPDATE',new:{id:'b1',status:'active'},old:{id:'b1'}})");
  await expect.poll(() => urls.some((u) => u.includes('/rest/v1/bikes')), { timeout: 5000 }).toBe(true);
  await page.waitForTimeout(400);
  expect(urls.some((u) => u.includes('/rest/v1/inventory'))).toBe(false);
  expect(urls.some((u) => u.includes('/rest/v1/bikes') && u.includes('photo'))).toBe(false);
});
