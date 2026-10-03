import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// After a ride is checked out or its bike returned (status done), the next time the rider opens the
// site a rating page takes the screen and cannot be skipped, like a correction request (the owner,
// 2026-10-03): no Cancel, no backdrop, no Escape, moving about keeps it, Log out is the only way off.
// A circuit / Petromin ride asks service, bike and experience; a Saturday social ride asks the ride
// (check-in, staff, bike, route), the breakfast (restaurant, atmosphere, food, service) and overall.
// Every score is required, and one of 8 or under needs a reason.
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const open = (page: Page) => page.evaluate(`!!S._rg&&document.getElementById('rate-modal').style.display==='block'`);
const qs = (page: Page) => page.locator('#rate-modal .rg-q').evaluateAll((els) => els.map((e) => e.id.replace('rgq-', '')));
const row = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, name: 'Spec Rider', customer_id: 'c1', session_id: 's-' + date, session_day: 'Friday', session_date: date, queue_num: 1,
  status: 'done', paid: true, price: 30, checked_out_at: date + 'T11:00:00Z', registered_at: date + 'T10:00:00Z', ...extra,
});
const sess = (date: string, extra: Record<string, unknown> = {}) => ({ id: 's-' + date, day: 'Friday', session_date: date, capacity: 12, status: 'open', created_at: 1, ...extra });
async function boot(page: Page, sessions: unknown[], queue: unknown[]) {
  await stubSupabase(page, { sessions, queue_entries: queue, 'rpc:my_bookings': queue, 'rpc:customer_booking_update': true });
  await loginCustomer(page, { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
  const calls: { p_patch: Record<string, unknown> }[] = [];
  page.on('request', (r) => { if (r.url().includes('/rest/v1/rpc/customer_booking_update')) { try { calls.push(r.postDataJSON()); } catch { /* */ } } });
  await page.evaluate(`S.view='customer'; setCustTab('myrides')`);
  return calls;
}

test('a circuit ride: an unskippable page asks service, bike and experience, and why for 8 or under', async ({ page }) => {
  const calls = await boot(page, [sess(today)], [row('q1', today)]);
  expect(await open(page)).toBe(true);
  expect(await qs(page)).toEqual(['service', 'bike', 'experience']);
  const m = page.locator('#rate-modal');
  await expect(m.locator('.gate-out')).toHaveText('Log out'); // the only way off: no Cancel
  // Escape, a tab change and the backdrop leave it up
  await page.keyboard.press('Escape');
  await page.evaluate(`setCustTab('register')`);
  await m.locator('.auth-backdrop').click({ position: { x: 3, y: 3 } });
  expect(await open(page)).toBe(true);
  // nothing picked: every question asks for a score
  await m.locator('.pg-btn').click();
  await expect(m.locator('.rg-q.err')).toHaveCount(3);
  await m.locator('#rgq-service .rg-b[data-v="9"]').click();
  await m.locator('#rgq-bike .rg-b[data-v="7"]').click();
  await m.locator('#rgq-experience .rg-b[data-v="10"]').click();
  await expect(m.locator('.rg-why')).toHaveCount(1); // only the 7 asks why
  await expect(m.locator('#rgq-bike .rg-why-l')).toContainText('7');
  await m.locator('.pg-btn').click();
  await expect(m.locator('.rg-q.err')).toHaveCount(1);
  await expect(m.locator('#rgq-bike.err')).toBeVisible();
  expect(calls.length).toBe(0);
  await m.locator('#rgw-bike').fill('Gears slipped');
  await m.locator('#rate-note').fill('Lovely night');
  await m.locator('.pg-btn').click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].p_patch).toEqual({ rating_bike: 7, rating_exp: 10, feedback: 'Lovely night',
    rating_detail: { form: 'rental', s: { service: 9, bike: 7, experience: 10 }, why: { bike: 'Gears slipped' } } });
  await expect.poll(() => open(page)).toBe(false);
});

test('a Saturday social ride asks the ride and the breakfast with their parts, and overall', async ({ page }) => {
  const s = sess(today, { day: 'Saturday', event_kind: 'community', ride_kind: 'saturday' });
  const calls = await boot(page, [s], [row('q1', today, { session_day: 'Saturday', type_preference: 'Own', paid: false, price: 0 })]);
  expect(await open(page)).toBe(true);
  // an own bike: no bike question under the ride
  expect(await qs(page)).toEqual(['ride', 'ride_checkin', 'ride_staff', 'ride_route', 'breakfast', 'bf_restaurant', 'bf_atmosphere', 'bf_food', 'bf_service', 'overall']);
  const m = page.locator('#rate-modal');
  // The breakfast's answers may go to the restaurant (Vendors, 2026-10-03): one quiet line says so, under its heading.
  await expect(m.locator('#rgq-breakfast .rg-bfn')).toHaveText('Your breakfast answers may be shared with the restaurant, without your name.');
  await expect(m.locator('.rg-bfn')).toHaveCount(1);
  await m.locator('.rg-skip').click(); // did not stay for breakfast
  expect(await qs(page)).toEqual(['ride', 'ride_checkin', 'ride_staff', 'ride_route', 'overall']);
  for (const k of ['ride', 'ride_checkin', 'ride_route', 'overall']) await m.locator(`#rgq-${k} .rg-b[data-v="10"]`).click();
  await m.locator('#rgq-ride_staff .rg-b[data-v="8"]').click(); // 8 counts as low
  await m.locator('#rgw-ride_staff').fill('Hard to find at the start');
  await m.locator('.pg-btn').click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0].p_patch).toMatchObject({ rating_bike: null, rating_exp: 10, feedback: null,
    rating_detail: { form: 'social', skip_bf: true, why: { ride_staff: 'Hard to find at the start' },
      s: { ride: 10, ride_checkin: 10, ride_staff: 8, ride_route: 10, overall: 10 } } });
  await expect.poll(() => open(page)).toBe(false);
});

test('it waits for the next visit: a ride from an earlier day is asked about', async ({ page }) => {
  await page.clock.setSystemTime(new Date('2026-10-06T09:00:00+03:00'));
  await boot(page, [sess('2026-10-04')], [row('q1', '2026-10-04')]);
  expect(await open(page)).toBe(true);
});

test('not asked: a rated ride, a ride still out, a ride before the page went live', async ({ page }) => {
  await boot(page, [sess(today), sess('2026-09-30')], [
    row('q1', today, { rating_exp: 9 }),
    row('q2', today, { id: 'q2', session_id: 's-' + today, queue_num: 2, status: 'active', checked_out_at: null, customer_id: 'c2' }),
    row('q3', '2026-09-30'),
  ]);
  expect(await open(page)).toBe(false);
});

test('a ride still out does not ask', async ({ page }) => {
  await boot(page, [sess(today)], [row('q1', today, { status: 'active', checked_out_at: null })]);
  expect(await open(page)).toBe(false);
});
