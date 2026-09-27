import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Two small desk fixes. The queue used to open on "All Sessions" — the same tap every shift,
// and the one view with a 150-row cap. And on approval rides the # column showed only a
// reservation time forever, even after publish made the numbers public.

const KSA_TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const OLD = '2099-01-01';
const sessions = [
  { id: OLD, session_date: OLD, day: 'Sunday', status: 'open', capacity: 10, created_at: 1 },
  { id: KSA_TODAY, session_date: KSA_TODAY, day: 'Today', status: 'open', capacity: 10, created_at: 2 },
];
const sat = (published: boolean) => ({
  id: 'sat-1', session_date: KSA_TODAY, day: 'Saturday', status: 'open', capacity: 20, created_at: 3,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: !published,
  paid_ride: false, spots: 20 });
const rider = (id: string, sid: string, st: string, x: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Saturday', session_date: KSA_TODAY, queue_num: 7,
  name: 'R ' + id, phone: '0550000001', type_preference: 'Road', size: 'M', status: st,
  paid: false, price: 0, registered_at: '2099-01-01T10:00:00Z', approval: 'approved', ...x });

test('the queue opens on tonight, not on All Sessions', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true`);
  await page.evaluate(`setStaffTab('queue')`);
  await page.waitForTimeout(250);
  expect(await page.evaluate('S.sfSession')).toBe(KSA_TODAY);
});

test('with no session today and none run yet it opens on the next ride, and a made choice is never overridden', async ({ page }) => {
  await stubSupabase(page, { sessions: [sessions[0]], queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true`);
  await page.evaluate(`setStaffTab('queue')`);
  await page.waitForTimeout(250);
  expect(await page.evaluate('S.sfSession')).toBe(OLD);
  await page.evaluate(`setSfSession('all');renderStaffQueue();renderStaffQueue()`);
  expect(await page.evaluate('S.sfSession')).toBe('all');
});

test('before publish: reservation time, and a W-number for the waitlisted', async ({ page }) => {
  await stubSupabase(page, { sessions: [sat(false)], bikes: [],
    queue_entries: [rider('a', 'sat-1', 'waiting'), rider('w', 'sat-1', 'waitlist', { waitlist_num: 2, approval: 'pending' })] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='sat-1';renderStaffQueue()`);
  await page.waitForTimeout(250);
  const txt = await page.evaluate(`document.getElementById('q-results').innerText`) as string;
  expect(txt).not.toContain('#7');            // numbers stay hidden pre-publish
  expect(txt).toContain('W2');                // but the line position shows
});

test('after publish the numbers are public, so the roster shows them too', async ({ page }) => {
  await stubSupabase(page, { sessions: [sat(true)], bikes: [],
    queue_entries: [rider('a', 'sat-1', 'waiting')] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='sat-1';renderStaffQueue()`);
  await page.waitForTimeout(250);
  await expect(page.locator('#q-results')).toContainText('#7');
});

// The row menu: a booking used to carry up to seven buttons over two lines. The two the desk
// actually presses during an arrival rush stay large; the rest fold into one ⋯ menu.
test('a waiting row shows Check In and one menu — the rest are inside it', async ({ page }) => {
  await stubSupabase(page, { sessions: [sessions[0]], bikes: [],
    queue_entries: [rider('a', OLD, 'waiting')] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${OLD}';renderStaffQueue()`);
  await page.waitForTimeout(250);
  const row = page.locator('#tab-queue').locator('tr, .q-card').filter({ hasText: 'R a' }).filter({ visible: true }).first();
  await expect(row.getByRole('button', { name: /Check In/i })).toBeVisible();
  await expect(row.getByRole('button', { name: /No-Show/i })).toHaveCount(0);  // folded away too
  await expect(row.getByRole('button', { name: /More actions/ })).toBeVisible();
  await expect(row.getByRole('button', { name: /Cancel/i })).toHaveCount(0);   // folded away
  await expect(row.getByRole('checkbox', { name: /#\d+/ })).toBeVisible(); // a real checkbox, not a button; its name is translated (selectBookingAria)
  await row.getByRole('button', { name: /More actions/ }).click();
  const menu = page.locator('.pay-menu-popup');
  await expect(menu.getByRole('menuitem', { name: /No-Show/i })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Edit/i })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /Cancel/i })).toBeVisible();
});

test('a menu action actually runs — Edit opens the booking editor', async ({ page }) => {
  await stubSupabase(page, { sessions: [sessions[0]], bikes: [],
    queue_entries: [rider('a', OLD, 'waiting')] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${OLD}';renderStaffQueue()`);
  await page.waitForTimeout(250);
  await page.locator('#tab-queue').locator('tr, .q-card').filter({ hasText: 'R a' }).filter({ visible: true }).first()
    .getByRole('button', { name: /More actions/ }).click();
  await page.waitForTimeout(150);   // let the just-positioned menu settle before clicking into it
  await page.locator('.pay-menu-popup').getByRole('menuitem', { name: /Edit/i }).click();
  // Asserted via state rather than DOM visibility: the click handler sets S._beId and flips
  // the modal to flex synchronously, and polling the page's own state has proven stable where
  // locator visibility checks raced the tap on emulated touch.
  await expect.poll(() => page.evaluate(`S._beId||null`), { timeout: 5000 }).toBe('a');
  await expect.poll(() => page.evaluate(
    `(m=>m?getComputedStyle(m).display:'gone')(document.getElementById('booking-edit-modal'))`), { timeout: 5000 }).toBe('flex');
  await expect(page.locator('.pay-menu-popup')).toHaveCount(0);   // the menu closed itself
});

// "Who has R-07?" used to be a column scan. The search box already matched names, phones,
// numbers and parties; now it matches the assigned bike too — assigned only, since a
// preference is not a bike in somebody's hands.
test('search finds the rider by their bike', async ({ page }) => {
  await stubSupabase(page, { sessions: [sessions[0]],
    bikes: [{ id: 'b7', name: 'R-07', type: 'Road', size: 'M', status: 'in-use', colors: [] }],
    queue_entries: [
      rider('a', OLD, 'active', { assigned_bike_id: 'b7', name: 'Bike Holder' }),
      rider('b', OLD, 'waiting', { queue_num: 8, name: 'Road Fan', type_preference: 'Road' }),
    ] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${OLD}';setSfSearch('r-07');renderStaffQueue()`);
  await page.waitForTimeout(300);
  const txt = await page.evaluate(`document.getElementById('tab-queue').innerText`) as string;
  expect(txt).toContain('Bike Holder');
  expect(txt).not.toContain('Road Fan');    // preferring a Road is not holding R-07
});
