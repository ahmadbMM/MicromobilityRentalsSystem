import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, captureBookingRows } from './helpers/supabase';

// Staff reject a reservation when a ride is full, and the booking is cancelled. Nothing used
// to stop that rider reserving the same ride again, which handed staff the same decision
// twice. The ride they were turned down for is closed to them; every other ride, including
// next week's, is untouched.

const ride = (over: Record<string, unknown> = {}) => ({
  id: '2099-01-10', session_date: '2099-01-10', day: 'Saturday', status: 'open', capacity: 20,
  created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false,
  needs_approval: true, hide_queue: false, spots: 20, title: 'Saturday Social Ride',
  bike_slots: '{"_time":"06:30 - 07:00"}', ...over,
});
const thisWeek = ride();
const nextWeek = ride({ id: '2099-01-17', session_date: '2099-01-17' });
const booking = (over: Record<string, unknown> = {}) => ({
  id: 'bk1', session_id: '2099-01-10', session_day: 'Saturday', session_date: '2099-01-10',
  queue_num: 4, name: 'Spec Rider', size: 'M', type_preference: 'Any', status: 'cancelled',
  cancelled_by: 'staff', approval: 'rejected', paid: false, price: 0, customer_id: 'c1',
  registered_at: '2099-01-01T10:00:00Z', ...over,
});

async function sessionList(page: import('@playwright/test').Page, rows: unknown[]) {
  await stubSupabase(page, { sessions: [thisWeek, nextWeek], bikes: [], queue_entries: rows, 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.selEvent='community';setCustTab('register')`);
  const cards = page.locator('.sess-card');
  await expect(cards).toHaveCount(2);        // both rides painted before anything is clicked
  return cards;
}
// The date is the day's heading (2026-10-10), so a session is found under its day.
const dayRow = (p: import('@playwright/test').Page, d: string) => p.locator('.sess-day').filter({ hasText: d }).locator('.sess-card');
const modal = (p: import('@playwright/test').Page) => p.locator('#confirm-modal .confirm-box');

test('the ride they were turned down for is marked, and tapping it explains instead of opening the form', async ({ page }) => {
  await sessionList(page, [booking()]);
  const turned = dayRow(page, '10 Jan');
  await expect(turned).toHaveClass(/sess-card-rej/);
  await expect(turned).toContainText('Full for this week');

  await turned.click();
  await expect(modal(page)).toBeVisible();
  await expect(modal(page)).toContainText('This week is full');
  await expect(modal(page)).toContainText("Your reservation for this ride wasn’t confirmed");
  await expect(modal(page)).toContainText('Spots are limited');
  await expect(modal(page)).toContainText("We’d love to see you on the next ride.");
  expect(await page.evaluate('S.selSession')).toBeNull();          // the form never opened
  await page.locator('#rej-ok').click();
  await expect(modal(page)).toBeHidden();
});

test("next week's ride is untouched", async ({ page }) => {
  await sessionList(page, [booking()]);
  const open = dayRow(page, '17 Jan');
  await expect(open).not.toHaveClass(/sess-card-rej/);
  await open.scrollIntoViewIfNeeded();
  await open.click();
  await expect(modal(page)).toBeHidden();
  await page.waitForFunction(`S.selSession==='2099-01-17'`);
});

test('a rider who was approved, or never asked, sees an ordinary card', async ({ page }) => {
  await sessionList(page, [booking({ approval: 'approved', status: 'waiting' })]);
  await expect(dayRow(page, '10 Jan')).not.toHaveClass(/sess-card-rej/);
});

test('a wizard left open from before the rejection cannot submit', async ({ page }) => {
  await stubSupabase(page, { sessions: [thisWeek, nextWeek], bikes: [], queue_entries: [], 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  const rows = await captureBookingRows(page);
  await page.evaluate(`S.selEvent='community';setCustTab('register')`);
  await dayRow(page, '10 Jan').click();   // opened while still allowed
  await page.waitForFunction(`S.selSession==='2099-01-10'`);

  // staff reject them while the page sits open
  await page.evaluate(`S.queue=[...getQueue(), entryFromDB(${JSON.stringify(booking())})]`);
  await page.evaluate(`S.regQty=1;S.regBikeHeights=[175];S.regBikeTypes=['Road'];S.regRideGroup='beg';S.regRiderNames=['Spec Rider'];submitReg()`);
  await expect(modal(page)).toContainText('This week is full');
  expect(rows).toHaveLength(0);
});
