import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Riders staff add (add rider, add group, a walk-in) carry no waiver. The owner, 2026-10-04: "force them
// to accept the waiver of the session as a pop up that they are forced to accept in order to use the
// website, show them the details of the session so they know the waiver is for which session". A page
// shows the ride and its waiver and stays up until they agree: no close, no Escape, moving about keeps
// it, Log out is the only way off. Agreeing calls customer_accept_waiver (20261004173000). It comes
// before the post-ride rating. And every ticket QR has a line running round it, so a screenshot shows
// itself by standing still ("for us to know that its live and not a screenshot").
test.describe('@customer:waiver desk-added booking waiver', () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  const FUT = '2099-02-01';
  const sess = (date: string, extra: Record<string, unknown> = {}) => ({
    id: 's-' + date, day: 'Sunday', session_date: date, capacity: 12, status: 'open', created_at: 1, location: 'JCC',
    bike_slots: '{"_time":"21:00 - 23:00","_total":12}', ...extra,
  });
  const row = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
    id, name: 'Spec Rider', customer_id: 'c1', session_id: 's-' + date, session_day: 'Sunday', session_date: date, queue_num: 3,
    status: 'waiting', paid: false, price: 75, registered_at: today + 'T10:00:00Z', waiver_version: null, waiver_at: null, ...extra,
  });
  const open = (page: Page) => page.evaluate(`!!S._wg&&document.getElementById('waiver-gate').style.display==='block'`);
  async function boot(page: Page, sessions: unknown[], queue: unknown[], extra: Record<string, unknown> = {}) {
    await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: queue, 'rpc:my_bookings': queue,
      'rpc:customer_accept_waiver': 2, 'rpc:customer_booking_update': true, ...extra });
    await loginCustomer(page, { id: 'c1' });
    const calls: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.url().includes('/rest/v1/rpc/customer_accept_waiver')) { try { calls.push(r.postDataJSON()); } catch { /* */ } } });
    await page.goto('/');
    await waitForSb(page);
    return calls;
  }

  test('a booking staff made opens an unskippable page with the ride and its waiver; agreeing stamps it', async ({ page }) => {
    const calls = await boot(page, [sess(FUT)], [row('q1', FUT), row('q2', FUT, { name: 'Friend Rider', queue_num: 4 })]);
    await expect.poll(() => open(page)).toBe(true);
    const m = page.locator('#waiver-gate');
    await expect(m.locator('#wg-title')).toHaveText('Ride waiver');
    await expect(m.locator('.wg-ev')).toHaveText('Jeddah Corniche Circuit');
    await expect(m.locator('.wg-ln').nth(0)).toContainText('Sunday');
    await expect(m.locator('.wg-ln').nth(1)).toContainText('9 PM');
    await expect(m.locator('.wg-ln')).toHaveCount(2); // the circuit is the ride's name and its place: said once
    await expect(m.locator('.wg-riders li')).toHaveText(['#3Spec Rider', '#4Friend Rider']);
    await expect(m.locator('.wg-text')).toContainText('at my own risk');
    await expect(m.locator('.gate-out')).toHaveText('Log out'); // the only way off: no close
    const btn = m.locator('.pg-btn');
    await expect(btn).toBeDisabled();
    // Escape, a tab change and the backdrop leave it up
    await page.keyboard.press('Escape');
    await page.evaluate(`S.view='customer';setCustTab('myrides')`);
    await m.locator('.auth-backdrop').click({ position: { x: 3, y: 3 } });
    expect(await open(page)).toBe(true);
    await m.locator('.wg-cb').check();
    await expect(btn).toBeEnabled();
    await btn.click();
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_session_id: 's-' + FUT, p_version: '2026-10-v3' });
    await expect.poll(() => open(page)).toBe(false);
    expect(await page.evaluate(`getQueue().filter(e=>e.customerId==='c1').map(e=>e.waiverVersion)`)).toEqual(['2026-10-v3', '2026-10-v3']);
    // Moving about after agreeing does not ask again
    await page.evaluate(`setCustTab('register');setCustTab('myrides')`);
    expect(await open(page)).toBe(false);
  });

  test('not asked: a booking with a waiver, a past ride, a cancelled one, someone else\'s, a row read without the column', async ({ page }) => {
    const { waiver_version: _drop, ...noColumn } = row('q5', FUT, { id: 'q5' });
    void _drop;
    await boot(page, [sess(FUT), sess('2020-01-05')], [
      row('q1', FUT, { waiver_version: '2026-10-v3', waiver_at: today + 'T09:00:00Z' }),
      row('q2', '2020-01-05'),
      row('q3', FUT, { status: 'cancelled' }),
      row('q4', FUT, { customer_id: 'c2' }),
      noColumn,
    ]);
    await page.evaluate(`S.view='customer';setCustTab('myrides')`);
    expect(await open(page)).toBe(false);
  });

  test('a swim session asks the swim waiver, an event the activity waiver, one ride at a time, soonest first', async ({ page }) => {
    const swim = sess('2099-01-10', { event_kind: 'community', ride_kind: 'swim', open_to_all: true, title: 'Pool Night' });
    const ev = sess('2099-01-20', { event_kind: 'community', ride_kind: 'event', open_to_all: true, title: 'Talk Night' });
    const calls = await boot(page, [ev, swim], [row('q1', '2099-01-20'), row('q2', '2099-01-10')]);
    await expect.poll(() => open(page)).toBe(true);
    const m = page.locator('#waiver-gate');
    await expect(m.locator('#wg-title')).toHaveText('Swim waiver');
    await expect(m.locator('.wg-ev')).toHaveText('Pool Night');
    await expect(m.locator('.wg-ln').nth(2)).toContainText('Jeddah Corniche Circuit'); // a named ride says where it is
    await m.locator('.wg-cb').check();
    await m.locator('.pg-btn').click();
    await expect(m.locator('#wg-title')).toHaveText('Activity waiver');
    await expect(m.locator('.wg-ev')).toHaveText('Talk Night');
    await m.locator('.wg-cb').check();
    await m.locator('.pg-btn').click();
    await expect.poll(() => open(page)).toBe(false);
    expect(calls.map((c) => [c.p_session_id, c.p_version])).toEqual([['s-2099-01-10', 'swim-2026-10-v3'], ['s-2099-01-20', 'activity-2026-10-v2']]);
  });

  test('the waiver comes before the post-ride rating, which opens once it is agreed', async ({ page }) => {
    await boot(page, [sess(today), sess(FUT)], [
      row('q1', today, { status: 'done', paid: true, checked_out_at: today + 'T11:00:00Z', waiver_version: '2026-10-v3' }),
      row('q2', FUT),
    ]);
    await expect.poll(() => open(page)).toBe(true);
    expect(await page.evaluate(`!!S._rg`)).toBe(false);
    await page.locator('#waiver-gate .wg-cb').check();
    await page.locator('#waiver-gate .pg-btn').click();
    await expect.poll(() => open(page)).toBe(false);
    await expect.poll(() => page.evaluate(`!!S._rg`)).toBe(true);
  });

  test('a failed save keeps the page up and says so; a database without the function lets the rider through', async ({ page }) => {
    const calls = await boot(page, [sess(FUT)], [row('q1', FUT)], { 'rpc:customer_accept_waiver': -1 });
    await expect.poll(() => open(page)).toBe(true);
    const m = page.locator('#waiver-gate');
    await m.locator('.wg-cb').check();
    await m.locator('.pg-btn').click();
    await expect(m.locator('.pg-net')).toBeVisible();
    expect(await open(page)).toBe(true);
    expect(calls.length).toBe(1);

    await page.route('**/rest/v1/rpc/customer_accept_waiver', (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.customer_accept_waiver in the schema cache' }) }));
    await m.locator('.pg-btn').click();
    await expect.poll(() => open(page)).toBe(false);
  });

  test('Log out takes the page down with the account', async ({ page }) => {
    await boot(page, [sess(FUT)], [row('q1', FUT)]);
    await expect.poll(() => open(page)).toBe(true);
    await page.locator('#waiver-gate .gate-out').click();
    await expect.poll(() => open(page)).toBe(false);
    expect(await page.evaluate(`S.loggedIn`)).toBe(null);
  });

  test('the ticket QR has a line running round it, still moving under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await boot(page, [sess(FUT)], [row('q1', FUT, { waiver_version: '2026-10-v3' })]);
    await page.evaluate(`goCustomer('myrides')`);
    const line = page.locator('#tab-myrides .cu-qr-box .qr-live path').first();
    await expect(line).toBeVisible();
    const a = await line.evaluate((el) => { const cs = getComputedStyle(el); return { name: cs.animationName, dur: cs.animationDuration, n: cs.animationIterationCount, stroke: cs.stroke }; });
    expect(a).toEqual({ name: 'qrLive', dur: '2.4s', n: 'infinite', stroke: 'rgb(0, 180, 103)' });
    // It moves: the dash offset changes from one moment to the next.
    const off = () => line.evaluate((el) => getComputedStyle(el).strokeDashoffset);
    const first = await off();
    await expect.poll(off).not.toBe(first);
    // It sits on the tile's edge, never over the code: the overlay covers exactly the box.
    const fit = await page.locator('#tab-myrides .cu-qr-box').first().evaluate((b) => {
      const o = b.querySelector('.qr-live')!.getBoundingClientRect(), q = b.querySelector('canvas.qr-cv')!.getBoundingClientRect(); // the painted code (ticket-qr-canvas.spec.ts)
      return Math.abs(o.width - q.width) < 2 && Math.abs(o.height - q.height) < 2 && Math.abs(o.left - q.left) < 2 && Math.abs(o.top - q.top) < 2;
    });
    expect(fit).toBe(true);
  });
});
