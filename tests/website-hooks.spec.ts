import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Four small pieces of the 2026-09-27 round that meet the website: a ride names its route (the
// Routes page's list), the ride leader shares a live location from Hand-over, an ambassador sees
// their own card on the account page, and an Android rider gets Add to Google Wallet.
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sessions = [{ id: 's0', day: 'Friday', session_date: today, capacity: 12, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":12}' }];
const routes = [{ key: 'routes.routes.items', value: [{ name: { en: 'The Corniche', ar: 'الكورنيش' }, km: 12 }, { slug: 'obhur-coast', name: { en: 'Obhur coast', ar: 'ساحل أبحر' }, km: 30 }] }];

test.describe('routes on a ride', () => {
  test('the picker lists the website\'s routes with a slug each, and the slug is written with the ride', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [], site_content: routes });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;renderSessions()`);
    await page.waitForFunction(`Array.isArray(S._routes)&&S._routes.length===2`);
    await page.evaluate(`renderSessions()`);
    const sel = page.locator('#ns-route');
    await expect(sel.locator('option')).toHaveCount(3);
    expect(await page.evaluate(`_routes().map(r=>r.slug)`)).toEqual(['the-corniche', 'obhur-coast']);
    await sel.selectOption('obhur-coast');
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/sessions')) { try { patches.push(r.postDataJSON()); } catch { /* */ } } }); // on the insert (2026-10-04)
    await page.evaluate(`S.newSessMode='total';S.newSessTotal='12'`); // a plain bike count: the fleet picker has no bikes here
    await page.locator('#ns-date').fill('2099-03-03');
    await page.locator('#ns-start').fill('21:00');
    await page.locator('#ns-end').fill('23:00');
    await page.evaluate(`addSession()`);
    await expect.poll(() => patches.some((p) => p.route_slug === 'obhur-coast')).toBe(true);
    expect(await page.evaluate(`_routeOf({route_slug:'obhur-coast'}).name`)).toBe('Obhur coast');
  });
});

test.describe('live location', () => {
  test('a timeout or a lost fix keeps sharing; only a refused permission stops it', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [], 'rpc:staff_live_position': { ok: true }, 'rpc:staff_live_stop': true });
    await unlockStaff(page);
    await page.addInitScript(() => {
      // a phone whose GPS errors on cue: window.__geoErr(code) reports one error to the watch
      const geo = {
        watchPosition: (_ok: unknown, err: (e: { code: number }) => void) => { (window as unknown as { __geoErr: (c: number) => void }).__geoErr = (c) => err({ code: c }); return 7; },
        clearWatch: () => { (window as unknown as { __cleared: boolean }).__cleared = true; },
      };
      Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
    });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('handover')`);
    await page.locator('#live-share-btn').click();
    await expect(page.locator('#live-share-btn')).toHaveText('Stop sharing');
    await page.evaluate(`window.__geoErr(3)`); // TIMEOUT
    await page.evaluate(`window.__geoErr(2)`); // POSITION_UNAVAILABLE
    await expect(page.locator('#live-share-btn')).toHaveText('Stop sharing');
    expect(await page.evaluate(`!!window.__cleared`)).toBe(false);
    await page.evaluate(`window.__geoErr(1)`); // PERMISSION_DENIED
    await expect(page.locator('#live-share-btn')).toHaveText('Share my location');
    expect(await page.evaluate(`window.__cleared`)).toBe(true);
  });

  test('Share my location sends the phone\'s position to staff_live_position and Stop removes it', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [], 'rpc:staff_live_position': { ok: true }, 'rpc:staff_live_stop': true });
    await unlockStaff(page);
    await page.addInitScript(() => {
      // a phone that reports one position at once
      const geo = { watchPosition: (ok: (p: unknown) => void) => { setTimeout(() => ok({ coords: { latitude: 21.5, longitude: 39.1, heading: 90, speed: 4.2 } }), 10); return 7; }, clearWatch: () => { (window as unknown as { __cleared: boolean }).__cleared = true; } };
      Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
    });
    await page.goto('/');
    await waitForSb(page);
    const calls: Array<{ fn: string; body: Record<string, unknown> }> = [];
    page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/(staff_live_\w+)/); if (m) { try { calls.push({ fn: m[1], body: r.postDataJSON() || {} }); } catch { calls.push({ fn: m[1], body: {} }); } } });
    await page.evaluate(`setStaffTab('handover')`);
    await expect(page.locator('#live-share-btn')).toHaveText('Share my location');
    await page.locator('#live-share-btn').click();
    await expect.poll(() => calls.filter((c) => c.fn === 'staff_live_position').length).toBe(1);
    expect(calls[0].body).toMatchObject({ p_session_id: 's0', p_role: 'leader', p_lat: 21.5, p_lng: 39.1, p_heading: 90, p_speed: 4.2 });
    await expect(page.locator('#live-share-btn')).toHaveText('Stop sharing');
    await page.locator('#live-share-btn').click();
    await expect.poll(() => calls.filter((c) => c.fn === 'staff_live_stop').length).toBe(1);
    expect(await page.evaluate(`window.__cleared`)).toBe(true);
    await expect(page.locator('#live-share-btn')).toHaveText('Share my location');
  });
});

test.describe('ambassador card', () => {
  test('an ambassador sees their code and points on the account page; anyone else sees no card', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [], 'rpc:ambassador_mine': { ok: true, ambassador: true, first_name: 'Amal', code: 'AMAL10', status: 'active', earned: 350, pending: 100, uses: 3, balance: 250, tier: 0, next: 2000, events: [{ at: '2026-09-20T18:00:00Z', context: 'Ride booked', points: 100, status: 'confirmed' }], redemptions: [] } });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    const card = page.locator('#amb-mine');
    await expect(card).toBeVisible();
    await expect(card).toContainText('AMAL10');
    await expect(card.locator('.amb-kpi-v').first()).toHaveText('350');
    await expect(card).toContainText('Ride booked');
    // a repaint keeps the card
    await page.evaluate(`renderAccount()`);
    await expect(page.locator('#amb-mine')).toHaveCount(1);
  });
  test('no ambassador, no card', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [], 'rpc:ambassador_mine': { ok: true, ambassador: false } });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    await page.waitForFunction(`S._ambMine&&S._ambMine.ambassador===false`);
    await expect(page.locator('#amb-mine')).toHaveCount(0);
  });
});

test.describe('Google Wallet', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36' });
  test('an Android rider gets Add to Google Wallet, which asks the function for the save link', async ({ page }) => {
    const row = { id: 'gw1', session_id: 's0', session_day: 'Friday', session_date: today, queue_num: 4, name: 'Spec Rider', phone: '', customer_id: 'c1', status: 'waiting', paid: true, price: 30, registered_at: '2026-01-01T10:00:00Z' };
    await stubSupabase(page, { sessions, queue_entries: [row], bikes: [], 'rpc:my_bookings': [row] });
    await loginCustomer(page, { id: 'c1' });
    const posts: Record<string, unknown>[] = [];
    await page.route('**/api/google-wallet', (r) => { try { posts.push(r.request().postDataJSON()); } catch { /* */ } return r.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, url: 'about:blank#saved' }) }); });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('myrides')`);
    expect(await page.evaluate(`_hasGWallet()`)).toBe(true);
    expect(await page.evaluate(`_hasWallet()`)).toBe(false);
    const btn = page.locator('.btn-wallet.gwallet').first();
    await expect(btn).toBeVisible();
    await btn.click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toMatchObject({ customerId: 'c1', token: 'tok-spec', bookingId: 'gw1', groupIds: ['gw1'] });
  });
  test('while the function is not configured the button goes away', async ({ page }) => {
    const row = { id: 'gw1', session_id: 's0', session_day: 'Friday', session_date: today, queue_num: 4, name: 'Spec Rider', phone: '', customer_id: 'c1', status: 'waiting', paid: true, price: 30, registered_at: '2026-01-01T10:00:00Z' };
    await stubSupabase(page, { sessions, queue_entries: [row], bikes: [], 'rpc:my_bookings': [row] });
    await loginCustomer(page, { id: 'c1' });
    await page.route('**/api/google-wallet', (r) => r.fulfill({ status: 501, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: false, skipped: 'google wallet not configured' }) }));
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('myrides')`);
    await page.locator('.btn-wallet.gwallet').first().click();
    await expect(page.locator('.btn-wallet.gwallet')).toHaveCount(0);
  });
});
