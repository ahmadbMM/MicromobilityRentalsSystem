import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A rider list should not carry columns nothing in it can fill. There is no bike to size or
// hand over on a pool session, and no money to take on a complimentary one — so height, bike
// type, bike and colour go where there is no bike, and price and payment go where it is free.
//
// The decision follows the ROWS, not the session filter: the All view mixes kinds, so one bike
// ride has to keep the bike columns for everybody.

const SWIM = 'swim-1', SAT = 'sat-1', JCC = '2099-04-04';
const sessions = [
  { id: SWIM, day: 'Thursday', session_date: '2099-04-01', capacity: 20, status: 'open', created_at: 3,
    event_kind: 'community', ride_kind: 'swim', needs_approval: true, hide_queue: true, paid_ride: false, spots: 20 },
  { id: SAT, day: 'Saturday', session_date: '2099-04-02', capacity: 20, status: 'open', created_at: 2,
    event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false, spots: 20 },
  { id: JCC, day: 'Sunday', session_date: JCC, capacity: 20, status: 'open', created_at: 1 },
];
const rider = (id: string, sid: string, name: string) => ({
  id, session_id: sid, session_day: 'Sunday', session_date: sid === JCC ? JCC : '2099-04-01',
  queue_num: 1, name, phone: '0559000001', type_preference: sid === SWIM ? 'None' : 'Road',
  size: sid === SWIM ? '' : 'M', height: sid === SWIM ? null : 175, status: 'waiting',
  paid: false, price: sid === JCC ? 75 : 0, registered_at: '2099-01-01T10:00:00Z',
  approval: sid === JCC ? null : 'approved',
});
const queue_entries = [rider('q1', SWIM, 'Swimmer'), rider('q2', SAT, 'Saturday Rider'), rider('q3', JCC, 'Circuit Rider')];

const BIKE_COLS = ['Bike Type', 'Bike']; // height now sits under the rider's name; colour beside the bike
const MONEY_COLS = ['Price', 'Payment'];

async function roster(page: import('@playwright/test').Page, session: string) {
  await stubSupabase(page, { sessions, queue_entries, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${session}';renderStaffQueue()`);
  await page.waitForTimeout(250);
  return (await page.evaluate(`document.querySelector('#tab-queue thead').innerText`)) as string;
}

test('a pool session carries neither the bike columns nor the money ones', async ({ page }) => {
  const head = await roster(page, SWIM);
  for (const c of [...BIKE_COLS, ...MONEY_COLS]) expect(head, c).not.toMatch(new RegExp(c, 'i'));
  expect(head).toMatch(/Rider/i);                 // the rest of the roster is untouched
  expect(head).toMatch(/Status/i);
});

test('a Saturday ride keeps its bikes but loses the money columns', async ({ page }) => {
  const head = await roster(page, SAT);
  expect(head).toMatch(/Bike Type/i);
  expect(head).toMatch(/\bBike\b/i);
  for (const c of MONEY_COLS) expect(head, c).not.toMatch(new RegExp(c, 'i'));
});

test('a paid circuit session keeps everything', async ({ page }) => {
  const head = await roster(page, JCC);
  for (const c of ['Bike Type', 'Price', 'Payment']) expect(head, c).toMatch(new RegExp(c, 'i'));
});

test('with sessions mixed, one bike ride keeps the columns for everybody', async ({ page }) => {
  const head = await roster(page, 'all');
  for (const c of ['Bike Type', 'Price', 'Payment']) expect(head, c).toMatch(new RegExp(c, 'i'));
});

test('the rows lose the same cells as the header, so nothing shifts', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'a phone builds the cards, not the table (2026-09-27): there are no cells to count');
  await roster(page, SWIM);
  const [headCells, bodyCells] = await page.evaluate(`[
    document.querySelectorAll('#tab-queue thead th').length,
    document.querySelectorAll('#tab-queue tbody tr:first-child td').length]`) as number[];
  expect(bodyCells).toBe(headCells);
});

// A filter whose control is hidden must not still be applied, or the list empties with nothing
// on screen to undo it — which reads as lost bookings.
test('a leftover paid filter does not empty a complimentary session', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`S.sfPay='paid';setStaffTab('queue');S.queueView='bookings';S.sfSession='${SWIM}';renderStaffQueue()`);
  await page.waitForTimeout(250);
  await expect(page.locator('#tab-queue .queue-mobile-view:visible, #tab-queue .queue-table-desktop-wrap:visible')).toContainText('Swimmer'); // the cards on a phone, the table elsewhere
});

test('a leftover bike-type filter does not empty a pool session either', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`S.sfBike='Road';setStaffTab('queue');S.queueView='bookings';S.sfSession='${SWIM}';renderStaffQueue()`);
  await page.waitForTimeout(250);
  await expect(page.locator('#tab-queue .queue-mobile-view:visible, #tab-queue .queue-table-desktop-wrap:visible')).toContainText('Swimmer'); // the cards on a phone, the table elsewhere
});

test('the filter controls disappear with their columns', async ({ page }) => {
  await roster(page, SWIM);
  // the labels are display:none on mobile, so assert on the controls themselves
  const has = (fn: string) => page.evaluate(
    `!!document.querySelector('#tab-queue [data-on-change*="${fn}"]')`) as Promise<boolean>;
  expect(await has('setSfPay'), 'payment filter').toBe(false);
  expect(await has('setSfBike'), 'bike type filter').toBe(false);
  expect(await has('setSfSize'), 'frame size filter').toBe(false);
  expect(await has('setSfStatus'), 'status filter still means something').toBe(true);
  expect(await has('setSfSession'), 'session filter stays').toBe(true);
});

test('history follows the same rule', async ({ page }) => {
  await stubSupabase(page, {
    sessions,
    queue_entries: [{ ...rider('h1', SWIM, 'Past Swimmer'), status: 'done' }],
    bikes: [],
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('history');renderHistory()`);
  await page.waitForTimeout(300);
  const head = await page.evaluate(`document.querySelector('#tab-history thead').innerText`) as string;
  for (const c of [...BIKE_COLS, ...MONEY_COLS]) expect(head, c).not.toMatch(new RegExp(c, 'i'));
});

// The stat row sits above the table and counted riders who brought their own bike — a number
// that can only ever be zero where there is no bike.
test('the bike-owner stat is not counted on a pool session', async ({ page }) => {
  await roster(page, SWIM);
  const stats = await page.evaluate(`document.querySelector('#tab-queue .stat-strip').innerText`) as string;
  expect(stats).not.toMatch(/Bike owner/i);
  expect(stats).toMatch(/Approved/i);             // the ones that do apply stay
  await roster(page, SAT);
  const sat = await page.evaluate(`document.querySelector('#tab-queue .stat-strip').innerText`) as string;
  expect(sat).toMatch(/Bike owner/i);             // a Saturday rider can still bring their own
});
