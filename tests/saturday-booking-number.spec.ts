import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The Saturday Social Ride's booking number (the owner, 2026-10-25: "add a booking number to saturday social
// rides bookings but only show them after publish"): once staff publish the list, a rider on it sees the
// number staff see at the desk; before Publish, and to anyone not on the list, the card shows none. Other
// rides staff approve are unchanged, and the QR keeps carrying no number (bookingRef).

const satur = (over: Record<string, unknown> = {}) => ({
  id: '2099-01-10', session_date: '2099-01-10', day: 'Saturday', status: 'open', capacity: 20,
  created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false,
  needs_approval: true, hide_queue: true, spots: 20, title: 'Saturday Social Ride',
  bike_slots: '{"_time":"06:30 - 07:00"}', ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  id: 'bk1', session_id: '2099-01-10', session_day: 'Saturday', session_date: '2099-01-10',
  queue_num: 12, name: 'Spec Rider', size: 'M', type_preference: 'Any', status: 'waiting',
  paid: false, price: 0, customer_id: 'c1', approval: 'approved',
  registered_at: '2099-01-01T10:00:00Z', ...over,
});

async function myBookings(page: import('@playwright/test').Page, sessions: unknown[], queue_entries: unknown[]) {
  await stubSupabase(page, { sessions, bikes: [], queue_entries, 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`showView('customer');setCustTab('myrides')`);
  return page.locator('#tab-myrides .ticket-card');
}

test('before Publish: no booking number, even for a rider staff already approved', async ({ page }) => {
  const card = await myBookings(page, [satur()], [row()]);
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('#12');
  await expect(card.locator('.ticket-num-label')).toHaveCount(0);
});

test('after Publish: a rider on the list sees their booking number, under "Booking number"', async ({ page }) => {
  const card = await myBookings(page, [satur({ hide_queue: false })], [row()]);
  await expect(card.locator('.ticket-num')).toHaveText('#12');
  await expect(card.locator('.ticket-num-label')).toHaveText('Booking number');
  await expect(card.locator('.cu-tr-num')).toHaveText('#12');
  expect(await page.evaluate(`bookingRef(getQueue().find(e=>e.id==='bk1'))`)).toBe('MMC-bk1'); // the QR stays number-free
});

test('after Publish: a rider not on the list (pending, rejected or waitlisted) still sees no number', async ({ page }) => {
  for (const over of [{ approval: 'pending' }, { approval: 'rejected' }, { status: 'waitlist', approval: 'approved' }]) {
    const card = await myBookings(page, [satur({ hide_queue: false })], [row(over)]);
    await expect(card).toBeVisible();
    await expect(card).not.toContainText('#12');
  }
});

test('another ride staff approve (the pool) keeps no number after Publish', async ({ page }) => {
  const card = await myBookings(page, [satur({ hide_queue: false, ride_kind: 'swim', title: 'Swim' })], [row()]);
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('#12');
});
