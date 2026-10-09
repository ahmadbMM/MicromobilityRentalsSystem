import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Analytics past twelve months (2026-10-09, M14): staff_monthly_totals (migration 20261009180000) adds the
// bookings and the till up on the server, one row a month and a 'total' row. With it "All" is all time (its own
// strip), Analytics > Months lists every month against the same month a year earlier, and the KPI tiles carry a
// year-on-year pill. Without it the page reads as before: "Last 12 months", no strip, no year-on-year.
const ksaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const ym = ksaToday().slice(0, 7);
const lyYm = String(Number(ym.slice(0, 4)) - 1) + ym.slice(4);
const row = (month: string, o: Record<string, number>) => ({ month, sessions_held: 4, seats: 48, bookings: 30, rides: 24, riders: 20, noshows: 2, cancellations: 3,
  rev_rides: 1200, rev_card: 700, rev_cash: 500, rev_sales: 150, sales_card: 50, sales_cash: 100, pending: 60, ...o });
const TOTALS = [row(lyYm, { rides: 10, rev_rides: 500 }), row(ym, { rides: 24 }), row('total', { rides: 34, riders: 25, rev_rides: 1700, rev_sales: 300, noshows: 4, cancellations: 6 })];

async function boot(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, fx);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('analytics')`);
}

test.describe('@staff:analytics months and year-on-year', () => {
  test('with the server totals, All is all time and has its strip', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/staff_monthly_totals')) asked.push(r.postData() || ''); });
    await boot(page, { 'rpc:staff_monthly_totals': TOTALS });
    await page.evaluate(`setAnRange('all')`);
    await expect(page.locator('#tab-analytics .an-range-bar .filter-pill.active')).toHaveText('All time');
    await expect(page.locator('#tab-analytics')).toContainText('The cards below count the last 12 months held on this device.');
    await expect(page.locator('#tab-analytics .analytics-kpi-grid').first()).toContainText('34');
    expect(asked.some((b) => /"p_from":"2024-01-01"/.test(b))).toBe(true);
  });

  test('Months lists every month, newest first, against the same month a year earlier', async ({ page }) => {
    await boot(page, { 'rpc:staff_monthly_totals': TOTALS });
    await page.evaluate(`setAnView('months')`);
    expect(new URL(page.url()).pathname).toBe('/analytics/months');
    const rows = page.locator('#an-mo-host tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('24');
    await expect(rows.nth(0).locator('.an-delta').first()).toContainText('+140%'); // 24 rides against 10 a year earlier
    await expect(page.locator('#an-mo-host .chart-card-title').first()).toContainText(ym.slice(0, 4));
  });

  test('a month range shows each KPI against last year and the revenue target', async ({ page }) => {
    await boot(page, { 'rpc:staff_monthly_totals': TOTALS });
    await page.evaluate(`S.anRevTarget=1000;setAnRange('month');setAnView('revenue')`);
    const tile = page.locator('#tab-analytics .analytics-kpi-label', { hasText: 'Collected' }).first();
    await expect(tile.locator('.an-delta', { hasText: 'y/y' })).toHaveCount(1);
    await expect(tile.locator('.an-tgt')).toContainText('of target');
  });

  test('without the function the page reads as before', async ({ page }) => {
    await boot(page, { 'rpc:staff_monthly_totals': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_monthly_totals in the schema cache' } } });
    await page.evaluate(`setAnRange('all')`);
    await expect(page.locator('#tab-analytics .an-range-bar .filter-pill.active')).toHaveText('Last 12 months');
    await expect(page.locator('#tab-analytics')).not.toContainText('The cards below count the last 12 months');
    await page.evaluate(`setAnView('months')`);
    await expect(page.locator('#an-mo-host')).toContainText('Months appear after the database update.');
    await page.evaluate(`setAnRange('month');setAnView('revenue')`);
    await expect(page.locator('#tab-analytics .an-delta', { hasText: 'y/y' })).toHaveCount(0);
  });
});

test.describe('@staff:analytics forecast and stamps', () => {
  test('the month forecast adds the places booked on rides to come and the walk-in pace', async ({ page }) => {
    await boot(page);
    const out = await page.evaluate(`(()=>{
      const sess=[{id:'p1',session_date:'2026-09-03',capacity:10},{id:'p2',session_date:'2026-09-10',capacity:10},{id:'u1',session_date:'2026-09-20',capacity:10},{id:'u2',session_date:'2026-09-27',capacity:10}];
      const q=[
        {sessionId:'p1',status:'done',paid:true,price:50,walkIn:true},{sessionId:'p1',status:'done',paid:true,price:50},
        {sessionId:'p2',status:'done',paid:true,price:50,walkIn:true},{sessionId:'p2',status:'done',paid:true,price:50,walkIn:true},
        {sessionId:'u1',status:'waiting',paid:false,price:60},{sessionId:'u1',status:'waiting',paid:true,price:60},{sessionId:'u2',status:'waiting',paid:false,price:60},
        {sessionId:'u2',status:'cancelled',paid:false,price:60}];
      return _anMonthForecast(sess,q,new Date('2026-09-15T09:00:00Z'));})()`) as Record<string, number>;
    expect(out.rides).toBe(4);
    expect(out.booked).toBe(3);
    expect(out.walkins).toBe(3); // 3 walk-ins over 2 rides held, for 2 rides to come
    expect(out.projRides).toBe(10);
    expect(out.projRev).toBe(200 + 180 + 150);
    expect(out.upCap).toBe(20);
    expect(out.upFill).toBe(15);
    expect(out.upFillProj).toBe(30);
  });

  test('the server stamps are read into the booking and the History export says when it was paid', async ({ page }) => {
    const today = ksaToday();
    await boot(page, {
      sessions: [{ id: today, day: 'Friday', session_date: today, capacity: 12, status: 'open' }],
      queue_entries: [{ id: 'q1', name: 'Paid Rider', session_id: today, session_date: today, session_day: 'Friday', queue_num: 1, status: 'done', paid: true, price: 50,
        paid_at: '2026-10-09T17:05:00Z', noshow_at: null, promoted_at: '2026-10-09T16:00:00Z', registered_at: '2026-10-09T10:00:00Z' }],
    });
    const e = await page.evaluate(`(()=>{const x=getQueue().find(r=>r.id==='q1');return{p:x.paidAt,pr:x.promotedAt,n:x.noshowAt};})()`) as Record<string, unknown>;
    expect(e).toEqual({ p: '2026-10-09T17:05:00Z', pr: '2026-10-09T16:00:00Z', n: null });
    await page.evaluate(`setStaffTab('history');renderHistory()`);
    const dl = page.waitForEvent('download');
    await page.evaluate(`exportHistoryCSV()`);
    const text = await (await import('node:fs/promises')).readFile(await (await dl).path() as string, 'utf8');
    expect(text.split('\n')[0]).toContain('Paid at');
    expect(text).toMatch(/20:05/); // 17:05 UTC is 20:05 in Riyadh
  });
});
