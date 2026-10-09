import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// There used to be two screens for one question. A "Waitlist" page held walk-ups — people at
// the desk with no booking — and a separate "Staff List" held riders staff had hand-picked and
// ordered. Both answered "who is waiting, and who is next". They are one section now, called
// Waitlist, and these pin what that merge must not lose: a walk-up row cannot become invisible
// while its rider stands at the desk, the multi-rider add still works, handing over a bike
// still books a real queue entry, and a waitlisted booking's W position is still editable
// because auto-promotion picks the next rider by that order.

const sessions = [
  { id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 },
  { id: 's1', day: 'Saturday', session_date: '2099-02-17', capacity: 12, status: 'open', created_at: 2 },
];
const bikes = [{ id: 'b1', name: 'R-01', type: 'Road', status: 'available', colors: [] }];
const qb = (id: string, qn: number, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: qn, name,
  phone: '05555555' + qn, customer_id: null, type_preference: 'Road', status, paid: false,
  price: 30, registered_at: '2099-01-01T09:00:00Z', ...extra,
});
const walkup = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, name, phone: '0511111111', bike_type: 'Road', status: 'waiting', author: null,
  created_at: '2099-01-01T10:00:00Z', resolved_at: null, ...extra,
});

async function openWaitlist(page: import('@playwright/test').Page, fixtures: Record<string, unknown>) {
  await stubSupabase(page, { sessions, bikes, queue_entries: [], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true`);
  await page.evaluate(`setStaffTab('queue');S.queueView='managed';renderStaffQueue()`);
}

test('a walk-up and a hand-picked rider now share one list', async ({ page }) => {
  await openWaitlist(page, {
    desk_waitlist: [
      walkup('w1', 'Walk Up'),                                        // no booking, no kind
      walkup('m1', 'Picked Rider', { kind: 'managed', sort_order: 1 }),
      walkup('done1', 'Already Served', { status: 'done', resolved_at: '2099-01-01T09:30:00Z' }),
    ],
  });
  const host = page.locator('#mw-host');
  await expect(host).toContainText('Walk Up');        // would have been invisible after the merge
  await expect(host).toContainText('Picked Rider');
  await expect(host).not.toContainText('Already Served'); // resolved rows are history, not a queue
});

test('the section is called Waitlist, and the old page is gone', async ({ page }) => {
  await openWaitlist(page, { desk_waitlist: [walkup('w1', 'Walk Up')] });
  const pills = await page.evaluate(`Array.from(document.querySelectorAll('#tab-queue .filter-pill')).map(b=>b.textContent.trim())`) as string[];
  expect(pills).toContain('Waitlist');
  expect(pills.filter((p) => p === 'Waitlist')).toHaveLength(1); // not two views with one name
  expect(pills).not.toContain('Staff List');
  await expect(page.locator('#tab-queue .page-title')).toContainText('Waitlist');
});

test('a device still pointing at the removed view lands on the list, not a blank tab', async ({ page }) => {
  await openWaitlist(page, { desk_waitlist: [walkup('w1', 'Walk Up')] });
  await page.evaluate(`S.queueView='waitlist';renderStaffQueue()`);
  expect(await page.evaluate('S.queueView')).toBe('managed');
  await expect(page.locator('#mw-host')).toContainText('Walk Up');
});

test('the multi-rider add still puts a party on the list', async ({ page }) => {
  await openWaitlist(page, { desk_waitlist: [] });
  const rows: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rest/v1/desk_waitlist')) {
      const b = r.postDataJSON();
      (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => rows.push(x));
    }
  });
  await page.locator('#tab-queue').getByRole('button', { name: /Add to waitlist/i }).click();
  await page.locator('#wl-name').fill('Family Head');
  await page.locator('#wl-phone').fill('0551234567');   // required: a walk-up needs a contact
  await page.evaluate(`_wlxAdd()`);                     // re-renders, keeping what was typed
  await page.locator('#wlx-name-0').fill('Second Rider');
  await page.locator('#wlx-type-0').selectOption('Hybrid'); // an extra rider's type is picked (B8)
  await page.evaluate(`addDeskWaitlist()`);
  await expect.poll(() => rows.length).toBe(2);
  await expect(page.locator('#mw-host')).toContainText('Family Head');
});

test('handing a rider a bike books a real queue entry and clears them off', async ({ page }) => {
  await openWaitlist(page, { desk_waitlist: [walkup('w1', 'Walk Up')] });
  const inserts: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rest/v1/queue_entries')) {
      const b = r.postDataJSON();
      (Array.isArray(b) ? b : [b]).forEach((x: Record<string, unknown>) => inserts.push(x));
    }
  });
  const patches: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('desk_waitlist')) patches.push(r.postData() || '');
  });
  await page.evaluate(`giveDeskBike('w1')`);
  await expect.poll(() => inserts.length).toBe(1);
  expect(inserts[0].name).toBe('Walk Up');
  expect(inserts[0].session_id).toBe('s0');
  // asserted on the WRITE: the stub answers every refetch from the fixture, so local state
  // reverts and would prove nothing either way
  await expect.poll(() => patches.some((b) => /"status":"done"/.test(b))).toBe(true);
});

test("a waitlisted booking's position is still editable, since promotion follows it", async ({ page }) => {
  await openWaitlist(page, {
    // reordering needs somebody to reorder against: three waitlisted riders, W1..W3
    queue_entries: [
      qb('qb2', 89, 'First Waiting', 'waitlist', { waitlist_num: 1 }),
      qb('qb3', 90, 'Second Waiting', 'waitlist', { waitlist_num: 2 }),
      qb('qb4', 91, 'On The List', 'waitlist', { waitlist_num: 3 }),
    ],
    desk_waitlist: [walkup('m1', 'On The List', { kind: 'managed', sort_order: 1, booking_id: 'qb4' })],
  });
  // Every waitlisted booking carries a W box now, folded in or parked by hand — so aim at
  // the one on this rider's own card rather than at "the" W box on the page.
  const box = page.locator('#mw-host .q-card').filter({ hasText: 'On The List' }).locator('input[aria-label="W"]');
  await expect(box).toHaveValue('3');
  const patches: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('queue_entries')) patches.push(r.postData() || '');
  });
  await box.fill('1');
  await box.blur();
  await expect.poll(() => patches.some((b) => /"waitlist_num":1/.test(b))).toBe(true);
});

test('a parked booking still carries the roster controls', async ({ page }) => {
  await openWaitlist(page, {
    queue_entries: [qb('qb2', 52, 'Fully Settled', 'waiting', { paid: true })],
    desk_waitlist: [walkup('m1', 'Fully Settled', { kind: 'managed', sort_order: 1, booking_id: 'qb2' })],
  });
  const html = await page.evaluate(`document.getElementById('mw-host').innerHTML`) as string;
  expect(html).toContain(`[&quot;showCheckinModal&quot;,&quot;qb2&quot;]`);   // the booking's own check-in
  expect(html).not.toContain(`&quot;giveDeskBike&quot;,&quot;m1&quot;`);       // never the walk-up one: it would book them twice
});
