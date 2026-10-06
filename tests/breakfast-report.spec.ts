import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The breakfast ratings report (the owner, 2026-10-05): one printed sheet per Saturday social ride day
// with every rating's breakfast part and the reasons riders wrote under it - anonymous, and nothing of
// the ride, the overall score or the closing comment. Opened from the Bookings print dialog.

const D = new Date(Date.now() - 2 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sessions = [
  { id: 'sat1', day: 'Saturday', session_date: D, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', title: 'Saturday Social Ride', breakfast_name: 'Cafe Bloom' },
  { id: 'sat2', day: 'Saturday', session_date: D, capacity: 40, status: 'open', created_at: 2, event_kind: 'community', ride_kind: 'saturday', title: 'Saturday Social Ride B', breakfast_name: 'Cafe Bloom' },
  { id: 'jcc1', day: 'Saturday', session_date: D, capacity: 40, status: 'open', created_at: 3 },
];
const social = (s: Record<string, number>, why: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({ form: 'social', s, why, ...extra });
const qe = (id: string, session_id: string, queue_num: number, name: string, extra: Record<string, unknown>) => ({
  id, session_id, session_day: 'Saturday', session_date: D, queue_num, name, phone: '05518762' + String(queue_num).padStart(2, '0'),
  customer_id: 'c-' + id, type_preference: 'Road', registered_at: D + 'T05:00:00Z', status: 'done', paid: true, price: 0, ...extra,
});
const queue_entries = [
  qe('r1', 'sat1', 17, 'Lina Haddad', {
    feedback: 'Great morning overall',
    rating_detail: social({ ride: 4, ride_staff: 5, breakfast: 9, bf_restaurant: 8, bf_atmosphere: 10, bf_food: 6, bf_service: 10, overall: 9 },
      { ride: 'Too fast for me', ride_staff: 'Hard to find at the start', bf_restaurant: 'Too small for the group', bf_food: '<b>cold</b> eggs' }),
  }),
  qe('r2', 'sat2', 23, 'Omar Saleh', {
    rating_detail: social({ ride: 9, breakfast: 7, bf_restaurant: 9, bf_atmosphere: 9, bf_food: 9, bf_service: 5, overall: 7 },
      { breakfast: 'Slow to serve', bf_service: 'We waited 40 minutes', overall: 'Long wait' }),
  }),
  qe('r3', 'sat1', 31, 'Maya Saeed', { rating_detail: social({ ride: 9, overall: 9 }, {}, { skip_bf: true }) }),
  qe('r4', 'sat1', 32, 'Not Done Yet', { status: 'waiting', rating_detail: social({ breakfast: 1, bf_food: 1 }, { bf_food: 'should not show' }) }),
  qe('r5', 'jcc1', 4, 'Circuit Rider', { rating_detail: { form: 'rental', s: { service: 2, bike: 2, experience: 2 }, why: { service: 'circuit reason' } } }),
];

async function boot(page: Page) {
  await stubSupabase(page, { sessions, queue_entries });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded&&getQueue().length===5`);
}
/** Prints through the dialog's button with window.open stood in, and returns the sheet's HTML. */
async function printed(page: Page) {
  await page.evaluate(`(() => {
    window.__bfr = '';
    window.__bfrOpen = window.open;
    window.open = () => ({ document: { write: (h) => { window.__bfr = h; }, close() {}, querySelectorAll: () => [] }, focus() {}, print() {} });
  })()`);
  await page.locator('#print-opts-modal .rpt-bf').click();
  await page.waitForFunction(`!!window.__bfr`);
  return page.evaluate(`(() => { window.open = window.__bfrOpen; return window.__bfr; })()`) as Promise<string>;
}

test.describe('@staff:bookings breakfast ratings report', () => {
  test('the print dialog offers it on a Saturday social ride only', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.sfSession='sat1';showPrintReportOptions()`);
    await expect(page.locator('#print-opts-modal .rpt-bf')).toHaveText(/Print breakfast ratings/);
    await page.evaluate(`_closePrintOpts();S.sfSession='jcc1';showPrintReportOptions()`);
    await expect(page.locator('#print-opts-modal .rpt-w100').first()).toBeVisible();
    await expect(page.locator('#print-opts-modal .rpt-bf')).toHaveCount(0);
  });

  test('the sheet carries the ride\'s breakfast ratings and reasons, anonymously, and nothing of the ride', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.sfSession='sat1';showPrintReportOptions()`);
    const html = await printed(page);
    await expect(page.locator('#print-opts-modal .rpt-bf')).toHaveCount(0); // the dialog closed

    // Which ride and which breakfast: the ride picked on the roster alone, not every Saturday ride that day
    // (the owner, 2026-10-06: "let the breakfast report make me choose the session not the date").
    expect(html).toContain('Breakfast ratings');
    expect(html).toContain('Cafe Bloom');
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toMatch(/1 Ratings/); // r1: the waiting rider, the circuit rider and the other ride's rider do not count
    expect(text).toMatch(/9\.0\/10 Breakfast average/);
    expect(text).toMatch(/1 Did not stay for breakfast/);
    // Per question: average, lowest, highest, how many.
    expect(text).toMatch(/Restaurant 8\.0 8 8 1/);
    expect(text).toMatch(/Atmosphere 10\.0 10 10 1/);
    expect(text).toMatch(/Food 6\.0 6 6 1/);
    // The breakfast's reasons, escaped; each one beside its question and score.
    expect(html).toContain('Too small for the group');
    expect(html).toContain('&lt;b&gt;cold&lt;/b&gt; eggs');
    expect(html).not.toContain('<b>cold</b>');
    // the other ride that day is a sheet of its own
    for (const s of ['Slow to serve', 'We waited 40 minutes']) expect(html).not.toContain(s);

    // Anonymous: no name, phone or booking number of anyone on the day.
    for (const name of ['Lina Haddad', 'Omar Saleh', 'Maya Saeed', 'Not Done Yet', 'Circuit Rider']) expect(html).not.toContain(name);
    for (const n of ['17', '23', '31']) expect(html).not.toContain('05518762' + n);
    expect(html).not.toContain('#17');
    expect(html).not.toContain('#23');
    // Nothing of the ride, the overall score or the closing comment, and nothing from another kind of ride.
    for (const s of ['Too fast for me', 'Hard to find at the start', 'Long wait', 'Great morning overall', 'should not show', 'circuit reason']) {
      expect(html).not.toContain(s);
    }
    const rows = await page.evaluate(`(() => {
      const d = new DOMParser().parseFromString(window.__bfr, 'text/html');
      return [...d.querySelectorAll('table')][1].querySelectorAll('tbody tr').length;
    })()`);
    expect(rows).toBe(1);
    expect(text.indexOf('1 9 8 10 6 10')).toBeGreaterThan(-1);

    // The other ride that day, picked on the roster, prints its own.
    await page.evaluate(`S.sfSession='sat2';showPrintReportOptions()`);
    const html2 = await printed(page);
    const text2 = html2.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(text2).toMatch(/1 Ratings/);
    expect(text2).toMatch(/7\.0\/10 Breakfast average/);
    expect(html2).toContain('We waited 40 minutes');
    expect(html2).not.toContain('Too small for the group');
  });

  test('a day nobody rated says so', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: queue_entries.filter((e) => e.id === 'r3') });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`S.dataLoaded&&getQueue().length===1`);
    await page.evaluate(`S.sfSession='sat1';showPrintReportOptions()`);
    const html = await printed(page);
    expect(html).toContain('No rider has rated the breakfast yet.');
    expect(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).toMatch(/1 Did not stay for breakfast/);
  });
});
