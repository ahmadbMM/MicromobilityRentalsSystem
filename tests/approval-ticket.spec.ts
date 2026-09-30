import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// On a ride staff approve, the rider's card holds its QR code back until the verdict is in:
// before the list is published nobody has been told the answer, and a code in hand would
// announce it. When the answer does come, it is said loudly, not as another line of note
// text. An ordinary ride is untouched — the code is the ticket from the moment it is booked.

const satur = (over: Record<string, unknown> = {}) => ({
  id: '2099-01-10', session_date: '2099-01-10', day: 'Saturday', status: 'open', capacity: 20,
  created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false,
  needs_approval: true, hide_queue: true, spots: 20, title: 'Saturday Social Ride',
  bike_slots: '{"_time":"06:30 - 07:00"}', ...over,
});
const jcc = {
  id: '2099-01-11', session_date: '2099-01-11', day: 'Sunday', status: 'open', capacity: 20,
  created_at: 1, location: 'JCC', bike_slots: '{"_time":"21:00 - 23:00","_total":20}',
};
const row = (over: Record<string, unknown> = {}) => ({
  id: 'bk1', session_id: '2099-01-10', session_day: 'Saturday', session_date: '2099-01-10',
  queue_num: 4, name: 'Spec Rider', size: 'M', type_preference: 'Any', status: 'waiting',
  paid: false, price: 0, customer_id: 'c1', approval: 'pending',
  registered_at: '2099-01-01T10:00:00Z', ...over,
});

async function myBookings(page: import('@playwright/test').Page, sessions: unknown[], queue_entries: unknown[]) {
  await stubSupabase(page, { sessions, bikes: [], queue_entries, 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`showView('customer');setCustTab('myrides')`);
  return page.locator('#tab-myrides');
}
/** The booking QR itself: the library draws an SVG labelled for screen readers (the label is
 *  translated, so the code is found by its drawing, not by the English words). */
const qr = (p: import('@playwright/test').Page) => p.locator('#tab-myrides svg[role="img"][aria-label]:has(g[shape-rendering="crispEdges"])');

test('while the list is being decided: no code, and the card says why', async ({ page }) => {
  const card = await myBookings(page, [satur()], [row()]);
  await expect(card.locator('.qr-hold')).toBeVisible();
  await expect(card.locator('.qr-hold')).toContainText(/once your place is confirmed/i);
  await expect(qr(page)).toHaveCount(0);
  await expect(card.locator('.appr-ok')).toHaveCount(0);
});

test('approved but not yet published: still no code, so the verdict is not announced early', async ({ page }) => {
  const card = await myBookings(page, [satur()], [row({ approval: 'approved' })]);
  await expect(card.locator('.qr-hold')).toBeVisible();
  await expect(qr(page)).toHaveCount(0);
  await expect(card.locator('.appr-ok')).toHaveCount(0);
});

test('published and approved: a loud confirmation, and the code appears', async ({ page }) => {
  const card = await myBookings(page, [satur({ hide_queue: false })], [row({ approval: 'approved' })]);
  const banner = card.locator('.appr-ok');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Your place is confirmed');
  await expect(banner).toContainText(/Show this code at the gathering point/i);
  await expect(banner.locator('.appr-ok-tick')).toBeVisible();
  const box = await banner.locator('.appr-ok-tick').boundingBox();
  expect(box!.height).toBeGreaterThan(30);                       // an indicator, not a sentence
  await expect(qr(page)).toHaveCount(1);
  await expect(card.locator('.qr-hold')).toHaveCount(0);
});

test('published and rejected: no code and no confirmation', async ({ page }) => {
  const card = await myBookings(page, [satur({ hide_queue: false })], [row({ approval: 'rejected' })]);
  await expect(qr(page)).toHaveCount(0);
  await expect(card.locator('.appr-ok')).toHaveCount(0);
});

test('an ordinary ride keeps its code, and no longer says Waiting at the top', async ({ page }) => {
  const card = await myBookings(page, [jcc], [row({
    id: 'bk2', session_id: '2099-01-11', session_day: 'Sunday', session_date: '2099-01-11',
    queue_num: 7, price: 57.5, approval: null,
  })]);
  await expect(qr(page)).toHaveCount(1);
  await expect(card.locator('.qr-hold')).toHaveCount(0);
  await expect(card).toContainText('#7');                        // the number still leads the card
  await expect(card.locator('.status-badge')).toHaveCount(0);    // the "Waiting" badge is gone
  await expect(card).not.toContainText('Waiting');
});

test('a booking already on a bike still shows its status at the top', async ({ page }) => {
  const card = await myBookings(page, [jcc], [row({
    id: 'bk3', session_id: '2099-01-11', session_day: 'Sunday', session_date: '2099-01-11',
    queue_num: 7, price: 57.5, approval: null, status: 'active',
  })]);
  await expect(card.locator('.status-badge')).toHaveCount(1);
  await expect(card.locator('.status-badge')).toContainText('On Bike');
});

// The wallet pass shows the booking number, which on a ride staff approve is theirs to
// announce. It follows the same line the QR code is drawn at.
const wallet = (p: import('@playwright/test').Page) => p.locator('#tab-myrides .btn-wallet');

test('the wallet pass waits for the list, then appears for an approved rider', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }));

  await myBookings(page, [satur()], [row()]);                        // pending, list not out
  await expect(wallet(page)).toHaveCount(0);

  await myBookings(page, [satur()], [row({ approval: 'approved' })]); // approved, list not out
  await expect(wallet(page)).toHaveCount(0);

  await myBookings(page, [satur({ hide_queue: false })], [row({ approval: 'rejected', status: 'cancelled' })]);
  await expect(wallet(page)).toHaveCount(0);                         // list out, but not on it

  await myBookings(page, [satur({ hide_queue: false })], [row({ approval: 'approved' })]);
  await expect(wallet(page)).toHaveCount(1);                         // list out and on it
});

test('an ordinary ride still offers the pass straight away', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }));
  await myBookings(page, [jcc], [row({
    id: 'bk9', session_id: '2099-01-11', session_day: 'Sunday', session_date: '2099-01-11',
    queue_num: 7, price: 57.5, approval: null,
  })]);
  await expect(wallet(page)).toHaveCount(1);
});
