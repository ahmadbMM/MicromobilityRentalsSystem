import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';
import { tapReports, lastReport, viewerFrame } from './helpers/reports';

// The Saturday Social Ride report (2026-11-18, migrations 20261119130500 and 20261119141500): every booking given a place
// since the first Saturday ride, checked in or not (five bookings count five), the unique riders, the first ride's date and more, from one staff-only server call, opened from
// its card in Reports > Rides and bookings and extracted through the viewer (Print, PDF, Excel, CSV).

const json = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
const REPORT = {
  generated_at: '2099-02-10T08:00:00Z',
  summary: {
    attendances: 2253, checked_in: 1847, not_checked_in: 29, unique_riders: 825, first_ride: '2099-01-03', rides_held: 3, avg_per_ride: 115.4,
    best_count: 180, best_date: '2099-01-10', last_count: 135, last_date: '2099-01-17', prev_count: 137, prev_date: '2099-01-10',
    last_new: 29, repeat_riders: 318, repeat_pct: 46, five_plus: 121, five_plus_pct: 17.5, most_rides: 15, rides_per_rider: 2.67,
    came_back_pct: 48, no_shows: 377, cancellations: 444, noshow_rides: 2, show_rate: 70.4, groups_from: '2099-01-10',
  },
  rides: [
    { date: '2099-01-03', state: 'held', attended: 11, checked_in: 8, not_checked_in: 3, first_timers: 11, returning: 0, no_shows: 0, cancelled: 17, requests: 0, beginner: 0, intermediate: 0, own_bike: 0, riders_to_date: 10, attended_to_date: 11, capacity: 40 },
    { date: '2099-01-10', state: 'held', attended: 180, checked_in: 180, not_checked_in: 0, first_timers: 49, returning: 131, no_shows: 0, cancelled: 28, requests: 0, beginner: 51, intermediate: 34, own_bike: 36, riders_to_date: 531, attended_to_date: 191, capacity: 120 },
    { date: '2099-01-17', state: 'held', attended: 135, checked_in: 78, not_checked_in: 0, first_timers: 29, returning: 106, no_shows: 57, cancelled: 46, requests: 0, beginner: 80, intermediate: 55, own_bike: 35, riders_to_date: 691, attended_to_date: 326, capacity: 120 },
    { date: '2099-01-24', state: 'upcoming', attended: 0, first_timers: 0, returning: 0, no_shows: 0, cancelled: 1, requests: 134, beginner: 0, intermediate: 0, own_bike: 0, riders_to_date: 691, attended_to_date: 326, capacity: 200 },
  ],
  frequency: [
    { lo: 1, hi: 1, riders: 373, attendances: 373 }, { lo: 2, hi: 2, riders: 97, attendances: 194 },
    { lo: 5, hi: 9, riders: 95, attendances: 637 }, { lo: 10, hi: null, riders: 26, attendances: 300 },
  ],
  mix: [
    { dimension: 'gender', label: 'male', value: 298, pct: 43.1 }, { dimension: 'gender', label: 'female', value: 392, pct: 56.7 },
    { dimension: 'gender', label: '', value: 1, pct: 0.1 },
    { dimension: 'nationality', label: 'Saudi Arabia', value: 281, pct: 40.7 }, { dimension: 'nationality', label: '*', value: 96, pct: 13.9 },
    { dimension: 'group', label: 'beg', value: 453, pct: 55.5 }, { dimension: 'bike', label: 'Own', value: 336, pct: 18.2 },
    { dimension: 'age', label: '25-34', value: 216, pct: 31.3 },
  ],
};

async function boot(page: Page, answer: { status: number; body: unknown }) {
  await stubSupabase(page, { sessions: [], queue_entries: [] });
  await page.route(/\/rest\/v1\/rpc\/staff_saturday_ride_report/, (r) => {
    (page as unknown as { __calls?: number }).__calls = ((page as unknown as { __calls?: number }).__calls || 0) + 1;
    return r.fulfill({ status: answer.status, headers: json, body: JSON.stringify(answer.body) });
  });
  await page.route(/\/rest\/v1\/rpc\/report_log_add/, (r) => r.fulfill({ status: 200, headers: json, body: JSON.stringify({ id: 9, no: 'MM-RPT-2099-00009' }) }));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@staff:reports the Saturday Social Ride report', () => {
  test('its card is in Reports for the accounts that open Analytics, not for the front desk', async ({ page }) => {
    await boot(page, { status: 200, body: REPORT });
    await page.evaluate(`setStaffTab('reports')`);
    const card = page.locator('#tab-reports .rp2-card[data-rp2="satride"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Saturday Social Ride report');
    await page.evaluate(`S.staffRole='frontdesk';S._isAdmin=false;renderReports()`);
    await expect(page.locator('#tab-reports .rp2-card[data-rp2="satride"]')).toHaveCount(0);
  });

  test('Open draws every booking, the unique riders, the first ride and the tables from the server', async ({ page }) => {
    await boot(page, { status: 200, body: REPORT });
    await tapReports(page);
    await page.evaluate(`setStaffTab('reports')`);
    await page.locator('#tab-reports .rp2-card[data-rp2="satride"] .rp2-go').click();
    await expect.poll(() => lastReport(page)).toContain('Saturday Social Ride report');
    const html = await lastReport(page);
    expect(html).toMatch(/class="rx lk-c/); // summary first
    expect(html).toMatch(/total-item dark"><span class="total-num"><bdi>2253<\/bdi><\/span><span class="total-lbl">Total bookings/);
    expect(html).toContain('<bdi>825</bdi></span><span class="total-lbl">Unique riders');
    expect(html).toMatch(/<td class="rp-name"><bdi>Checked in<\/bdi><\/td><td><bdi>1847<\/bdi>/);
    expect(html).toMatch(/<td class="rp-name"><bdi>Given a place, never checked in<\/bdi><\/td><td><bdi>29<\/bdi>/);
    expect(html).toContain('3 Jan 2099</bdi></span><span class="total-lbl">First Saturday Social Ride');
    expect(html).toContain('Latest ride (17 Jan 2099)');
    expect(html).toContain('<bdi>−2</bdi>'); // 135 against 137
    expect(html).toContain('<bdi>318 (46%)</bdi>');
    expect(html).toContain('Show-up rate (2 rides with no-shows marked)');
    expect(html).toContain('Every ride · 3'); // the ride still to come is not in it
    expect(html).toMatch(/<tr class="rp-b8"><td class="rp-name"><bdi>Total<\/bdi><\/td><td><bdi>326<\/bdi><\/td><td><bdi>266<\/bdi><\/td><td><bdi>57<\/bdi><\/td><td><bdi>3<\/bdi>/); // bookings, checked in, no-shows, never checked in
    expect(html).toContain('<bdi>10+</bdi>');
    expect(html).toContain('<bdi>5–9</bdi>');
    expect(html).toContain('<bdi>Female</bdi>');
    expect(html).toContain('<bdi>Not given</bdi>');
    expect(html).toContain('<bdi>Other</bdi>');
    expect(html).toContain('Ride group, bookings since 10 Jan 2099');
    expect(html).toContain('<bdi>134</bdi>'); // coming up: bookings so far
    expect(html).not.toMatch(/Rider\b.*05\d{8}/); // counts only, no names or phones
  });

  test('the viewer extracts it: Excel is a workbook, a second tap while it loads opens it once', async ({ page }) => {
    await boot(page, { status: 200, body: REPORT });
    await page.evaluate(`window.__x=[];const _B=window.Blob;window.Blob=function(p,o){window.__x.push({type:o&&o.type,parts:p});return new _B(p,o);};`);
    await page.evaluate(`Promise.all([_srrOpen(),_srrOpen()])`);
    const fr = await viewerFrame(page);
    await expect(fr.locator('.rx-main .total-item.dark .total-num')).toHaveText('2253');
    expect((page as unknown as { __calls?: number }).__calls).toBe(1);
    await page.locator('#rx-modal [data-rx-act="xlsx"]').click();
    await expect.poll(() => page.evaluate(`window.__x.some(b=>/spreadsheetml/.test(b.type||''))`)).toBe(true);
  });

  test('before the database update it says so and opens nothing', async ({ page }) => {
    await boot(page, { status: 404, body: { code: 'PGRST202', message: 'Could not find the function public.staff_saturday_ride_report' } });
    await page.evaluate(`_srrOpen()`);
    await expect(page.locator('#toast-container')).toContainText('Waiting for the database update.');
    await expect(page.locator('#rx-modal .rx-frame')).toHaveCount(0);
  });
});
