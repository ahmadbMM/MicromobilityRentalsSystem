import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The glance layer: what is free on the rack, who still owes, who has been out too long, and
// which phone is holding two bikes — all computed from data the page already loads.

const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }];
const bikes = [
  { id: 'b1', name: 'R-01', type: 'Road', size: 'M', status: 'available', colors: [] },
  { id: 'b2', name: 'R-02', type: 'Road', size: 'M', status: 'available', colors: [] },
  { id: 'b3', name: 'R-03', type: 'Road', size: 'L', status: 'in-use', colors: [] },
  { id: 'h1', name: 'H-01', type: 'Hybrid', size: 'S', status: 'available', colors: [] },
];
const e = (id: string, x: Record<string, unknown> = {}) => ({
  id, session_id: S1, session_day: 'Sunday', session_date: S1, queue_num: 1, name: 'R ' + id,
  phone: '0550000001', type_preference: 'Road', size: 'M', status: 'waiting', paid: false,
  price: 75, registered_at: '2099-01-01T10:00:00Z', ...x });

async function boot(page: import('@playwright/test').Page, queue_entries: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions, queue_entries, bikes });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${S1}';renderStaffQueue()`);
  await page.waitForTimeout(250);
}

// Asked for 2026-09-22: the roster carries fewer figures — the bikes-free strip and the SAR due
// tile are both gone, and what is owed is read in the rows themselves.
test('the roster shows neither the bikes-free strip nor a SAR due tile', async ({ page }) => {
  await boot(page, [
    e('a', { price: 75 }),                                   // owes 75
    e('b', { queue_num: 2, price: 60, paid: true }),         // settled
    e('rider3', { queue_num: 9, status: 'active', assigned_bike_id: 'b3' }),
  ]);
  await expect(page.locator('.stat-strip')).toBeVisible();   // the rest of the strip stays
  await expect(page.locator('.fleet-strip')).toHaveCount(0);
  await expect(page.locator('.stat-chip', { hasText: /due/i })).toHaveCount(0);
  expect(await page.evaluate(`document.getElementById('tab-queue').innerText`)).not.toContain('Bikes free');
});

test('a rider out past two hours reads amber with a warning', async ({ page }) => {
  const threeHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  await boot(page, [e('a', { status: 'active', checked_in_at: threeHoursAgo, assigned_bike_id: 'b3' })]);
  const cell = await page.evaluate(`document.getElementById('q-results').innerHTML`) as string;
  expect(cell).toContain('⚠');
  expect(cell).toContain('over two hours');
});

test('a fresh check-in stays green', async ({ page }) => {
  const tenMinAgo = new Date(Date.now() - 10 * 60000).toISOString();
  await boot(page, [e('a', { status: 'active', checked_in_at: tenMinAgo, assigned_bike_id: 'b3' })]);
  const cell = await page.evaluate(`document.getElementById('q-results').innerHTML`) as string;
  expect(cell).not.toContain('⚠');
  expect(cell).toContain('min');
});

test('one phone on two separate live bookings is flagged; a party sharing one is not', async ({ page }) => {
  await boot(page, [
    e('a', { phone: '0551112222' }),
    e('b', { queue_num: 2, phone: '0551112222', name: 'Double Booker' }),   // separate booking, same phone
    e('g1', { queue_num: 3, phone: '0553334444', group_id: 'grp' }),
    e('g2', { queue_num: 4, phone: '0553334444', group_id: 'grp' }),        // one party, shared contact
  ]);
  const rows = await page.evaluate(`document.getElementById('q-results').innerText`) as string;
  const flags = (rows.match(/⚠/g) || []).length;
  expect(flags).toBe(2);                    // both halves of the duplicate, neither of the party
});
