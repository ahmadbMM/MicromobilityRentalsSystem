import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The weekly KPI report's days with their money (2026-10-09, migration 20261009207000): fares and till sales,
// card and cash, per day. Older snapshots carry the rides alone and show those.
const ksaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const Y = addDays(ksaToday(), -1);
const totals = { sessions_held: 2, seats: 80, bookings: 60, rides: 50, riders: 40, noshows: 3, cancellations: 1, rev_rides: 2000, rev_card: 2000, rev_cash: 0, rev_sales: 300, sales_card: 100, sales_cash: 200, pending: 0 };
const week = (id: number, by_day: unknown[]) => ({ id, kind: 'weekly_kpi', period_from: addDays(Y, -6), period_to: Y, created_at: new Date(Date.now() - id * 3600e3).toISOString(),
  data: { totals, prev: totals, last_year: {}, occupancy: 62, by_day } });

test.describe('@staff:analytics weekly revenue per day', () => {
  test('each day shows its rides, fares, till sales, card, cash and total; on WhatsApp too', async ({ page }) => {
    const days = [
      { date: addDays(Y, -3), rides: 20, fares: 800, fares_card: 800, fares_cash: 0, sales: 100, sales_card: 40, sales_cash: 60 },
      { date: Y, rides: 30, fares: 1200, fares_card: 1200, fares_cash: 0, sales: 200, sales_card: 60, sales_cash: 140 },
    ];
    await stubSupabase(page, { report_snapshots: [week(1, days), week(2, [{ date: Y, rides: 9 }])] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`window.__opened=[];window.open=(u)=>{window.__opened.push(String(u));return null;};setStaffTab('analytics');setAnView('reports')`);
    const items = page.locator('#an-rp-host .rpi-item');
    await expect(items).toHaveCount(2);
    await items.nth(0).locator('.rpi-open').click();
    const tbl = items.nth(0).locator('table.rpi-days');
    await expect(tbl.locator('thead th')).toHaveText(['Day', 'Completed Rides', 'Fares', 'Till sales', 'Card', 'Cash', 'Total']);
    await expect(tbl.locator('tbody tr')).toHaveCount(2);
    const last = tbl.locator('tbody tr').nth(1);
    await expect(last).toContainText('SAR 1,200');
    await expect(last).toContainText('SAR 1,260'); // card: fares 1,200 + till 60
    await expect(last).toContainText('SAR 140');
    await expect(last).toContainText('SAR 1,400');
    await items.nth(0).locator('button', { hasText: 'WhatsApp' }).click();
    const opened = await page.evaluate('window.__opened') as string[];
    expect(decodeURIComponent(opened[0])).toContain('SAR 1,400');
    // an older week: its days, rides only
    await items.nth(0).locator('.rpi-open').click();
    await items.nth(1).locator('.rpi-open').click();
    await expect(items.nth(1).locator('table.rpi-days thead th')).toHaveText(['Day', 'Completed Rides']);
  });
});
