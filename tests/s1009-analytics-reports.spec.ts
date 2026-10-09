import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Scheduled reports, kept in the app (2026-10-09, M15): the database writes report_snapshots (migration
// 20261009181000) after every ride day and every Saturday morning; Analytics > Reports lists them to open, print
// or send on WhatsApp, and the bell says "Daily close-out ready" for a new close-out (no e-mail exists).
const ksaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const Y = addDays(ksaToday(), -1);
const totals = { sessions_held: 1, seats: 40, bookings: 30, rides: 26, riders: 22, noshows: 3, cancellations: 1, rev_rides: 1300, rev_card: 800, rev_cash: 500, rev_sales: 120, sales_card: 20, sales_cash: 100, pending: 50 };
const SNAPS = [
  { id: 2, kind: 'daily_closeout', period_from: Y, period_to: Y, created_at: new Date(Date.now() - 3600e3).toISOString(),
    data: { totals, sessions: [{ id: Y, title: 'Sunday', time: '21:00 - 23:00', capacity: 40, booked: 30, rides: 26, noshows: 3, cancelled: 1, fares: 1300, unpaid: 0, sales: 120 }],
      till: { paid: 120, house: 15, team: 0, refunded: 0, voided: 1, discount: 0 } } },
  { id: 1, kind: 'weekly_kpi', period_from: addDays(Y, -6), period_to: Y, created_at: new Date(Date.now() - 2 * 864e5).toISOString(),
    data: { totals, prev: { ...totals, rides: 20 }, last_year: {}, occupancy: 65, by_day: [] } },
];

async function boot(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, fx);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@staff:analytics reports inbox', () => {
  test('lists the close-outs and KPI weeks; one opens, prints and goes to WhatsApp', async ({ page }) => {
    await boot(page, { report_snapshots: SNAPS });
    await page.evaluate(`window.__opened=[];window.open=(u)=>{window.__opened.push(String(u));return null;};setStaffTab('analytics');setAnView('reports')`);
    expect(new URL(page.url()).pathname).toBe('/analytics/reports');
    const items = page.locator('#an-rp-host .rpi-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('Daily close-out');
    await expect(items.nth(1)).toContainText('Weekly KPIs');
    await items.nth(0).locator('.rpi-open').click();
    await expect(items.nth(0).locator('.rpi-lines')).toContainText('SAR 1420'); // rides and till
    await expect(items.nth(0).locator('tbody tr')).toHaveCount(1);
    await items.nth(1).locator('.rpi-open').click();
    await expect(items.nth(1)).toContainText('+30%'); // 26 rides against 20 the week before
    await items.nth(0).locator('button', { hasText: 'WhatsApp' }).click();
    const opened = await page.evaluate('window.__opened') as string[];
    expect(opened.some((u) => u.startsWith('https://wa.me/?text=') && decodeURIComponent(u).includes('Close-out'))).toBe(true);
    await items.nth(0).locator('button', { hasText: 'Print' }).click();
    expect((await page.evaluate('window.__opened') as string[]).length).toBe(2);
  });

  test('the bell says a new close-out is ready, a kind staff can turn off', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('cq_nt_read2', JSON.stringify({ closeout: [] })));
    await boot(page, { report_snapshots: SNAPS.slice(0, 1) });
    await page.evaluate(`S._rpiSnapAt=0;_ntSync()`);
    await expect.poll(() => page.evaluate(`(S._rpiSnaps||[]).length`)).toBe(1);
    await page.evaluate(`_ntOpen()`);
    const line = page.locator('#nt-panel', { hasText: 'Daily close-out ready' });
    await expect(line).toHaveCount(1);
    expect(await page.evaluate(`NT_KINDS.some(k=>k[0]==='closeout')`)).toBe(true);
    await page.evaluate(`_ntClose();S._ntOff=['closeout'];_ntSync();_ntOpen()`);
    await expect(page.locator('#nt-panel', { hasText: 'Daily close-out ready' })).toHaveCount(0);
  });

  test('without the table the view says the database update is pending', async ({ page }) => {
    await boot(page);
    await page.route(/\/rest\/v1\/report_snapshots/, (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.report_snapshots' in the schema cache" }) }));
    await page.evaluate(`setStaffTab('analytics');setAnView('reports')`);
    await expect(page.locator('#an-rp-host')).toContainText('Waiting for the database update.');
    await expect(page.locator('#an-rp-host button', { hasText: 'Close out today now' })).toHaveCount(0);
  });

  test('an admin can write today\'s close-out now', async ({ page }) => {
    const sent: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/report_snapshot_make')) sent.push(r.postData() || ''); });
    await boot(page, { report_snapshots: [], 'rpc:report_snapshot_make': 7 });
    await page.evaluate(`setStaffTab('analytics');setAnView('reports')`);
    await expect(page.locator('#an-rp-host')).toContainText('No reports yet.');
    await page.locator('#an-rp-host button', { hasText: 'Close out today now' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(JSON.parse(sent[0])).toEqual({ p_kind: 'daily_closeout', p_day: addDays(ksaToday(), 1) });
  });
});
