import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Fixes from the 2026-10-03 review of the end of the app script: the Inventory add writes once,
// a reload on Settings comes back to Settings, and the account checks and the Analytics day sort
// read the KSA calendar, not the device's.
async function boot(page: Page, failWrite?: Parameters<typeof stubSupabase>[2]) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers: [], inventory: [], tags: [], customer_tags: [] }, failWrite);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test('@staff:inventory adding an item is one write: a refused one leaves nothing behind to duplicate on retry', async ({ page }) => {
  await boot(page);
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { if (r.url().includes('/rest/v1/inventory') && r.method() !== 'GET') writes.push({ method: r.method(), body: r.postDataJSON() }); });
  await page.evaluate(`setStaffTab('inventory');setInvSection('supplements');toggleAddInv();S._invName='Gel';S._invPrice='12';S._invCost='5';S._invQty='3'`);
  await page.evaluate(`addInvItem()`);
  await expect.poll(() => writes.length).toBe(1);
  await page.waitForTimeout(300);
  expect(writes).toHaveLength(1);
  expect(writes[0].method).toBe('POST');
  const row = Array.isArray(writes[0].body) ? (writes[0].body as Record<string, unknown>[])[0] : writes[0].body;
  expect(row).toMatchObject({ name: 'Gel', qty: 3, price: 12, cost: 5 });
});

test('@staff:inventory a refused add keeps the form open and says so', async ({ page }) => {
  await boot(page, { table: 'inventory', methods: ['POST'] });
  await page.evaluate(`setStaffTab('inventory');setInvSection('supplements');toggleAddInv();S._invName='Gel'`);
  await page.evaluate(`addInvItem()`);
  await expect.poll(() => page.evaluate(`S.showAddInv`)).toBe(true);
  await page.waitForTimeout(300);
  expect(await page.evaluate(`S.showAddInv`)).toBe(true);
});

test('@build a reload on Settings returns to Settings', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(`_bootStaffTab({stab:'settings'})`)).toBe('settings');
  expect(await page.evaluate(`_bootStaffTab({stab:'nowhere'})`)).toBe('');
});

test('@build an age is counted on the KSA day, whatever the device clock zone', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-05-04T22:30:00Z')); // 5 May 01:30 in Riyadh, still 4 May in UTC
  await boot(page);
  expect(await page.evaluate(`todayStr()`)).toBe('2026-05-05');
  expect(await page.evaluate(`_sxAgeAt('2000-05-05')`)).toBe(26); // a birthday today in Riyadh
  expect(await page.evaluate(`_sxAgeAt('2000-05-06')`)).toBe(25);
});

test.describe('@staff:analytics on a device west of UTC', () => {
  test.use({ timezoneId: 'America/Los_Angeles' });
  test('the session table sorts by the ride night\'s own weekday', async ({ page }) => {
    const sessions = [
      { id: 's-tue', day: 'Tuesday', session_date: '2026-02-10', capacity: 12, status: 'open', created_at: 1 },
      { id: 's-sun', day: 'Sunday', session_date: '2026-02-08', capacity: 12, status: 'open', created_at: 2 },
    ];
    const row = (id: string, sid: string, date: string, day: string) => ({ id, session_id: sid, session_day: day, session_date: date, queue_num: 1, name: 'x', phone: '', status: 'done', paid: true, price: 30, registered_at: date + 'T15:00:00Z' });
    await stubSupabase(page, { sessions, queue_entries: [row('q1', 's-tue', '2026-02-10', 'Tuesday'), row('q2', 's-sun', '2026-02-08', 'Sunday')], bikes: [], customers: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.sessions||[]).length===2');
    await page.evaluate(`S.analyticsRange='all';S.analyticsTrendSort='day';S.analyticsTrendDir=1;setStaffTab('analytics')`);
    // Sunday (0) before Tuesday (2): parsed as UTC and read in Los Angeles they were Saturday (6) and Monday (1)
    await expect(page.locator('#tab-analytics .analytics-trend-table tbody tr').first().locator('td').nth(1)).toContainText(/Sun/);
  });
});
