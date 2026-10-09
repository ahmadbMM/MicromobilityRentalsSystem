import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Claude Design #13. The Bikes tab lists the bikes that need a mechanic (in maintenance, due
// for service, or rated low) with Mark serviced and Send to workshop on each, and the admin
// sets how many rides a service lasts, for every device at once.

const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 200, created_at: 1 }];
let qn = 0;
const rides = (bike: string, count: number, x: Record<string, unknown> = {}) => Array.from({ length: count }, () => {
  qn += 1;
  return {
    id: `r${qn}`, session_id: S1, session_day: 'Sunday', session_date: S1, queue_num: qn,
    name: `Rider ${qn}`, phone: '0550000001', type_preference: 'Road', size: 'M', status: 'done',
    paid: true, price: 75, assigned_bike_id: bike,
    registered_at: new Date(Date.parse('2099-01-01T11:00:00Z') + qn * 60000).toISOString(),
    // ridden in the past, so a service stamped now comes after every ride
    checked_out_at: new Date(Date.parse('2026-01-01T12:00:00Z') + qn * 60000).toISOString(), ...x,
  };
});
const bike = (id: string, name: string, x: Record<string, unknown> = {}) => ({ id, name, type: 'Road', size: 'M', status: 'available', colors: [], ...x });
const SERVICED = '2026-01-01T10:30:00Z'; // before every ride below

const fleet = [
  bike('b-due', 'R-DUE', { last_serviced_at: SERVICED }),          // 31 rides since its service
  bike('b-old', 'R-OLD'),                                         // 30 rides, never serviced
  bike('b-new', 'R-NEW'),                                         // 3 rides, never serviced
  bike('b-maint', 'R-MAINT', { status: 'maintenance', retired_date: '2099-01-01' }),
  bike('b-low', 'R-LOW', { last_serviced_at: SERVICED }),          // rated 4 and 5
  bike('b-ok', 'R-OK', { last_serviced_at: SERVICED }),            // 5 rides, rated 9
  bike('b-gone', 'R-GONE', { status: 'retired', retired_date: '2098-01-01' }),
];
const queue = () => {
  qn = 0;
  return [...rides('b-due', 31), ...rides('b-old', 30), ...rides('b-new', 3),
    ...rides('b-low', 1, { rating_bike: 4 }), ...rides('b-low', 1, { rating_bike: 5 }),
    ...rides('b-ok', 5, { rating_bike: 9 }), ...rides('b-gone', 40)];
};

async function openBikes(page: Page) {
  await stubSupabase(page, { sessions, queue_entries: queue(), bikes: fleet });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getBikes().length>0`);
  await page.evaluate(`setStaffTab('inventory');S.invSection='bikes';S.bkStatus='all';renderInventory();renderBikes()`);
  return page.locator('#tab-bikes .bk-attn');
}
const row = (page: Page, id: string) => page.locator(`#tab-bikes .bk-attn-row[data-bike="${id}"]`);
function bikePatches(page: Page) {
  const bodies: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/bikes')) bodies.push(r.postData() || '');
  });
  return bodies;
}

test('lists the bikes that need a mechanic, and only those', async ({ page }) => {
  const card = await openBikes(page);
  await expect(card).toContainText('Bikes needing attention · 4');
  // a low rating comes first: it is about the rider's safety, not the calendar
  await expect(card.locator('.bk-attn-row').first()).toHaveAttribute('data-bike', 'b-low');
  await expect(row(page, 'b-low')).toContainText('Low rating 4.5/10');
  await expect(row(page, 'b-due')).toContainText('Service due · 31 rides');
  await expect(row(page, 'b-due')).not.toContainText('Never serviced');
  // never serviced counts every ride, and says so once it is due...
  await expect(row(page, 'b-old')).toContainText('Service due · 30 rides');
  await expect(row(page, 'b-old')).toContainText('Never serviced');
  // ...but a new bike with a few rides is not a job yet
  await expect(row(page, 'b-new')).toHaveCount(0);
  await expect(row(page, 'b-ok')).toHaveCount(0);
  await expect(row(page, 'b-gone')).toHaveCount(0);
  await expect(row(page, 'b-maint')).toContainText('In maintenance');
  // a bike already in maintenance has nowhere else to be sent
  await expect(row(page, 'b-maint').getByRole('button', { name: 'Send to workshop' })).toHaveCount(0);
  await expect(row(page, 'b-due').getByRole('button', { name: 'Send to workshop' })).toBeVisible();
  // the recent service log: last services, and when the bike in maintenance went in
  const log = card.locator('.bk-attn-log');
  await expect(log).toContainText('Recent service log');
  await expect(log).toContainText('R-DUE');
  await expect(log.locator('.bk-attn-log-row', { hasText: 'R-MAINT' })).toContainText('Sent to workshop');
  // Hide folds it to its title
  await card.locator('.bk-attn-head').click();
  await expect(card.locator('.bk-attn-row')).toHaveCount(0);
  await expect(card).toContainText('Bikes needing attention · 4');
});

test('Mark serviced on a bike in maintenance stamps it, puts it back in the pool, and undoes', async ({ page }) => {
  await openBikes(page);
  const patches = bikePatches(page);
  await row(page, 'b-maint').getByRole('button', { name: 'Mark serviced' }).click();
  await expect.poll(() => patches.find((b) => b.includes('last_serviced_at')) || '').toContain('"status":"available"');
  await expect(row(page, 'b-maint')).toHaveCount(0);
  await page.locator('#topbar-right .undo-btn').click();
  await expect.poll(() => patches.some((b) => b.includes('"status":"maintenance"'))).toBe(true);
  await expect(row(page, 'b-maint')).toContainText('In maintenance');
});

test('Mark serviced on a due bike takes it off the list', async ({ page }) => {
  await openBikes(page);
  const patches = bikePatches(page);
  await row(page, 'b-due').getByRole('button', { name: 'Mark serviced' }).click();
  await expect.poll(() => patches.find((b) => b.includes('last_serviced_at')) || '').not.toBe('');
  expect(patches.find((b) => b.includes('last_serviced_at'))).not.toContain('status');
  await expect(row(page, 'b-due')).toHaveCount(0);
});

test('Send to workshop puts an available bike into maintenance', async ({ page }) => {
  await openBikes(page);
  const patches = bikePatches(page);
  await row(page, 'b-due').getByRole('button', { name: 'Send to workshop' }).click();
  await expect.poll(() => patches.some((b) => b.includes('"status":"maintenance"'))).toBe(true);
});

test('the admin sets how many rides a service lasts, and the list follows', async ({ page }) => {
  await openBikes(page);
  const saved: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rest/v1/staff_options')) saved.push(r.postData() || '');
  });
  const every = page.locator('#tab-bikes .bk-svc-every').first(); // the second is "or every N days" (2026-10-09)
  const input = every.locator('input');
  await expect(every).toContainText('Service every');
  await expect(input).toHaveValue('30');
  await input.fill('3');
  await input.dispatchEvent('change');
  await expect.poll(() => saved.join()).toContain('service_every');
  expect(JSON.parse(saved[0]).items).toEqual([3]);
  await expect(row(page, 'b-new')).toContainText('Service due · 3 rides');
  await expect(row(page, 'b-new')).toContainText('Never serviced');
  await expect(row(page, 'b-ok')).toContainText('Service due · 5 rides');
  // the bike profile reads the same threshold
  await page.evaluate(`openBikeProfile('b-ok')`);
  await expect(page.locator('#bike-profile-modal .flt-svcn-due')).toHaveText('5');
  await expect(page.locator('#bike-profile-modal .flt-svcn-due .art-warn')).toHaveCount(1);
  await page.evaluate(`closeBikeProfile()`);
  // the front desk sees the list, not the setting
  await page.evaluate(`S.staffRole='frontdesk';renderBikes()`);
  await expect(page.locator('#tab-bikes .bk-svc-every')).toHaveCount(0);
  await expect(page.locator('#tab-bikes .bk-attn')).toBeVisible();
});

test('a healthy fleet shows no list at all', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: rides('b-ok', 2, { rating_bike: 8 }), bikes: [bike('b-ok', 'R-OK')] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getBikes().length>0`);
  await page.evaluate(`setStaffTab('inventory');S.invSection='bikes';renderInventory();renderBikes()`);
  await expect(page.locator('#tab-bikes .stats-row')).toBeVisible();
  await expect(page.locator('#tab-bikes .bk-attn')).toHaveCount(0);
});
