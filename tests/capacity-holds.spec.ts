import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';
// These specs cover the automatic promotion: Settings > Business wl_offer_mode 'auto' (the default is 'staff' since
// 2026-10-09, R7: staff choose who gets a freed place, tests/s1010-remind-waitlist.spec.ts).
const WL_AUTO = [{ key: 'biz', items: { wl_offer_mode: 'auto' } }];

// The number staff put in is the number of riders, full stop. A place is held right through
// the ride — checking in does not release it and neither does finishing, which is where places
// used to leak: they quietly reappeared as the evening went on, so the waitlist "started late"
// and a 4-bike session served more than four people. It is released when the booking ends
// without a bike going out: cancelled, removed, or a no-show.

const sess = {
  id: '2099-12-06', day: 'Sunday', session_date: '2099-12-06', capacity: 4, status: 'open',
  created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":4}',
};
const bikes = [{ id: 'b1', name: 'R1', size: 'M', type: 'Road', status: 'available', rental_price: 75 }];
const row = (id: string, n: number, status: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: sess.id, session_day: 'Sunday', session_date: '2099-12-06', queue_num: n,
  name: 'Rider ' + n, size: 'M', type_preference: 'Road', status, paid: false, price: 75,
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});

const spots = (page: import('@playwright/test').Page) =>
  page.evaluate(`spotsLeft('${sess.id}')`) as Promise<number>;

async function staff(page: import('@playwright/test').Page, rows: Record<string, unknown>[]) {
  await stubSupabase(page, { staff_options: WL_AUTO, sessions: [sess], bikes, queue_entries: rows });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true`);
}

test.describe('a place is held until the booking is cancelled', () => {
  test('riders keep their place through check-in and the ride itself', async ({ page }) => {
    await staff(page, [
      row('a', 1, 'waiting'), row('b', 2, 'active'), row('c', 3, 'done'), row('d', 4, 'waiting'),
    ]);
    expect(await spots(page)).toBe(0); // waiting, riding and finished all still hold theirs
  });

  test('a no-show gives its place back — nobody rode on it', async ({ page }) => {
    await staff(page, [row('a', 1, 'waiting'), row('b', 2, 'active'), row('c', 3, 'noshow'), row('d', 4, 'done')]);
    expect(await spots(page)).toBe(1);
  });

  test('cancelling gives exactly one back', async ({ page }) => {
    await staff(page, [row('a', 1, 'waiting'), row('b', 2, 'active'), row('c', 3, 'cancelled'), row('d', 4, 'removed')]);
    expect(await spots(page)).toBe(2); // the two live ones hold; cancelled and removed do not
  });

  test('a rider on their own bike takes no place', async ({ page }) => {
    await staff(page, [row('a', 1, 'waiting'), row('b', 2, 'waiting', { type_preference: 'Own' })]);
    expect(await spots(page)).toBe(3);
  });

  test('the roster agrees with the booking form about how full it is', async ({ page }) => {
    await staff(page, [row('a', 1, 'done'), row('b', 2, 'active'), row('c', 3, 'noshow')]);
    await page.evaluate(`setStaffTab('queue');S.queueView='sessions';renderStaffQueue()`);
    const html = await page.evaluate(`document.getElementById('tab-queue').innerHTML`) as string;
    expect(html).toContain('2');            // two of four taken on the session card
    expect(await spots(page)).toBe(2);      // and the same number underneath
  });
});

test('a rider booking into a full session is waitlisted, even after riders finish', async ({ page }) => {
  await stubSupabase(page, { staff_options: WL_AUTO,
    sessions: [sess], bikes,
    queue_entries: [row('a', 1, 'done'), row('b', 2, 'done'), row('c', 3, 'waiting'), row('d', 4, 'active')],
  });
  await loginCustomer(page, { id: 'c1', name: 'Late Rider' });
  await page.goto('/');
  await waitForSb(page);
  const rows = await captureBookingRows(page);
  await page.evaluate(
    `S.selSession='${sess.id}'; S.regQty=1; S.regBikeHeights=[175]; S.regBikeTypes=['Road'];
     S.regRiderNames=['Late Rider']; S.promoApplied=null; S.waiverOk=true;submitReg();`,
  );
  await expect.poll(() => rows.length).toBe(1);
  expect(rows[0].status).toBe('waitlist');
});

test('both a no-show and a cancellation free a place, and both promote', async ({ page }) => {
  const withWaitlist = [row('a', 1, 'waiting'), row('b', 2, 'waiting'), row('c', 3, 'waiting'),
    row('d', 4, 'waiting'), row('w', 5, 'waitlist', { waitlist_num: 1 })];
  await staff(page, withWaitlist);
  const patches: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('queue_entries')) patches.push(r.postData() || '');
  });

  await page.evaluate(`doNoShow('a')`);
  await expect.poll(() => patches.some((b) => /"status":"noshow"/.test(b))).toBe(true);
  await expect.poll(() => patches.some((b) => /"status":"waiting"/.test(b))).toBe(true); // the place goes to the next in line

  patches.length = 0;
  await page.evaluate(`staffCancelEntry('b')`);
  await page.locator('#confirm-modal').getByRole('button', { name: /cancel booking/i }).click();
  await expect.poll(() => patches.some((b) => /"status":"cancelled"/.test(b))).toBe(true);
  await expect.poll(() => patches.some((b) => /"status":"waiting"/.test(b))).toBe(true); // the freed place is filled
});
