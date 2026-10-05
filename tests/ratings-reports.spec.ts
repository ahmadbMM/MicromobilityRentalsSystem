import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The ratings reports (the owner, 2026-10-05: "import all the ratings in one report with anonymous names and only
// the breakfast part for the restaurants to see, in addition make a reports builder that includes a lot of
// customization for the ratings section"). Analytics > Ratings opens one dialog in two modes: for a restaurant,
// every Saturday's breakfast part over the dates picked, anonymous and locked that way; for our team, the builder.

const day = (d: number) => new Date(Date.now() - d * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const D1 = day(9), D2 = day(2), DJ = day(5);
const sessions = [
  { id: 'sat-a', day: 'Saturday', session_date: D1, capacity: 40, status: 'closed', created_at: 1, event_kind: 'community', ride_kind: 'saturday', title: 'Saturday Social Ride', breakfast_name: 'Cafe Bloom' },
  { id: 'sat-b', day: 'Saturday', session_date: D2, capacity: 40, status: 'closed', created_at: 2, event_kind: 'community', ride_kind: 'saturday', title: 'Saturday Social Ride', breakfast_name: 'Dune Bakery' },
  { id: 'jcc-1', day: 'Tuesday', session_date: DJ, capacity: 40, status: 'closed', created_at: 3 },
];
const social = (s: Record<string, number>, why: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({ form: 'social', s, why, ...extra });
const qe = (id: string, session_id: string, date: string, queue_num: number, name: string, extra: Record<string, unknown>) => ({
  id, session_id, session_day: 'Saturday', session_date: date, queue_num, name, phone: '0551230' + String(queue_num).padStart(3, '0'),
  customer_id: 'c-' + id, type_preference: 'Road', registered_at: date + 'T05:00:00Z', checked_out_at: date + 'T08:00:00Z',
  status: 'done', paid: true, price: 0, ...extra,
});
const queue_entries = [
  qe('a1', 'sat-a', D1, 11, 'Lina Haddad', { feedback: 'Lovely morning', rated_at: D1 + 'T09:00:00Z',
    rating_detail: social({ ride: 9, ride_checkin: 9, ride_staff: 9, ride_bike: 8, ride_route: 10, breakfast: 9, bf_restaurant: 9, bf_atmosphere: 10, bf_food: 8, bf_service: 9, overall: 9 },
      { ride_bike: 'Brakes squeaked', bf_food: 'Eggs a bit cold' }) }),
  qe('a2', 'sat-a', D1, 12, 'Omar Saleh', { rated_at: D1 + 'T10:00:00Z',
    rating_detail: social({ ride: 6, breakfast: 5, bf_restaurant: 6, bf_atmosphere: 7, bf_food: 4, bf_service: 5, overall: 6 },
      { ride: 'Too fast for me', breakfast: 'Slow kitchen', bf_food: 'Food came late', bf_service: 'Hard to order', overall: 'Long wait overall' }) }),
  qe('a3', 'sat-a', D1, 13, 'Maya Saeed', { rated_at: D1 + 'T11:00:00Z', rating_detail: social({ ride: 10, overall: 10 }, {}, { skip_bf: true }) }),
  qe('b1', 'sat-b', D2, 21, 'Sami Nabil Haddad', { feedback: 'Great coffee', rated_at: D2 + 'T09:00:00Z',
    rating_detail: social({ ride: 8, breakfast: 10, bf_restaurant: 10, bf_atmosphere: 9, bf_food: 10, bf_service: 10, overall: 9 }, { ride: 'Route was busy' }) }),
  qe('j1', 'jcc-1', DJ, 4, 'Circuit Rider', { session_day: 'Tuesday', feedback: 'Good bikes overall', rated_at: DJ + 'T20:00:00Z',
    rating_detail: { form: 'rental', s: { service: 9, bike: 3, experience: 7 }, why: { bike: 'Chain slipped' } } }),
  qe('w1', 'sat-b', D2, 22, 'Not Done Yet', { status: 'waiting', rating_detail: social({ breakfast: 1, bf_food: 1 }, { bf_food: 'should not show' }) }),
];

async function boot(page: Page) {
  await stubSupabase(page, { sessions, queue_entries, bikes: [] });
  await unlockStaff(page);
  await page.goto('/analytics/ratings');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded&&getQueue().length===6&&S.staffTab==='analytics'`);
  await expect(page.locator('#tab-analytics .rr-launch')).toBeVisible();
}
/** Prints from the dialog with window.open stood in, and returns the sheet's HTML. */
async function printed(page: Page) {
  await page.evaluate(`(() => {
    window.__rr = '';
    window.__rrOpen = window.open;
    window.open = () => ({ document: { write: (h) => { window.__rr = h; }, close() {}, querySelectorAll: () => [] }, focus() {}, print() {} });
  })()`);
  await page.locator('#print-opts-modal .rr-print').click();
  await page.waitForFunction(`!!window.__rr`);
  return page.evaluate(`(() => { window.open = window.__rrOpen; return window.__rr; })()`) as Promise<string>;
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/\s+/g, ' ');
const dlg = (page: Page) => page.locator('#print-opts-modal .rr-dlg');
const pick = (page: Page, label: string, option: string) => dlg(page).locator(`select[aria-label="${label}"]`).selectOption({ label: option });

test.describe('@staff:analytics ratings reports', () => {
  test('the restaurant\'s report: every Saturday\'s breakfast in one sheet, anonymous, one restaurant or all', async ({ page }) => {
    await boot(page);
    await page.locator('#tab-analytics .rr-open-bf').click();
    await expect(dlg(page)).toHaveAttribute('data-mode', 'bf');
    await expect(dlg(page).locator('.modal-title')).toHaveText('Breakfast report for restaurants');
    await expect(page.locator('#rr-count')).toContainText('Breakfast ratings on the report: 3');
    await expect(page.locator('#rr-count')).toContainText('Did not stay for breakfast: 1');
    // Nothing on the restaurant's dialog can put a name on it.
    await expect(dlg(page).locator('.rr-lock')).toContainText('Anonymous and breakfast only');
    await expect(dlg(page).getByRole('button', { name: 'Full name' })).toHaveCount(0);

    let html = await printed(page);
    let t = text(html);
    expect(html).toContain('Breakfast ratings');
    expect(t).toContain('All restaurants');
    for (const s of ['Cafe Bloom', 'Dune Bakery']) expect(html).toContain(s);
    expect(t).toMatch(/3 Ratings/);
    expect(t).toMatch(/8\.0\/10 Breakfast average/); // (9 + 5 + 10) / 3
    expect(t).toMatch(/1 Did not stay for breakfast/);
    expect(t).toMatch(/2 Saturdays/);
    expect(t).toMatch(/2 Restaurants/);
    // The breakfast's reasons are there; nothing of the ride, the overall score, the comments or another ride.
    for (const s of ['Eggs a bit cold', 'Slow kitchen', 'Food came late', 'Hard to order']) expect(html).toContain(s);
    for (const s of ['Brakes squeaked', 'Too fast for me', 'Route was busy', 'Long wait overall', 'Lovely morning', 'Great coffee', 'Good bikes overall', 'Chain slipped', 'should not show']) {
      expect(html).not.toContain(s);
    }
    // Anonymous: no name, phone or booking number.
    for (const n of ['Lina Haddad', 'Omar Saleh', 'Maya Saeed', 'Sami Nabil Haddad', 'Circuit Rider', 'Not Done Yet']) expect(html).not.toContain(n);
    for (const q of ['011', '012', '013', '021']) expect(html).not.toContain('0551230' + q);
    for (const q of ['#11', '#12', '#21']) expect(html).not.toContain(q);

    // One restaurant: only its Saturdays.
    await page.locator('#tab-analytics .rr-open-bf').click();
    await pick(page, 'Restaurant', 'Dune Bakery');
    await expect(page.locator('#rr-count')).toContainText('Breakfast ratings on the report: 1');
    html = await printed(page);
    t = text(html);
    expect(html).toContain('Dune Bakery');
    expect(html).not.toContain('Cafe Bloom');
    expect(html).not.toContain('Slow kitchen');
    expect(t).toMatch(/1 Ratings/);
    expect(t).toMatch(/10\.0\/10 Breakfast average/);
  });

  test('the restaurant\'s CSV is anonymous and breakfast only', async ({ page }) => {
    await boot(page);
    await page.locator('#tab-analytics .rr-open-bf').click();
    const [file] = await Promise.all([page.waitForEvent('download'), dlg(page).locator('.rr-csv').click()]);
    expect(file.suggestedFilename()).toMatch(/^breakfast-ratings_/);
    const csv = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
    expect(csv.split('\n')[0]).toContain('Date,Restaurant,Breakfast,Restaurant,Atmosphere,Food,Service');
    expect(csv).toContain('Food came late');
    for (const s of ['Lina', 'Omar', 'Brakes squeaked', 'Lovely morning', '0551230']) expect(csv).not.toContain(s);
    expect(csv.trim().split('\n')).toHaveLength(4); // the header and three ratings
  });

  test('the builder: names as picked, the filters, the questions and a quick start', async ({ page }) => {
    await boot(page);
    await page.locator('#tab-analytics .rr-open').click();
    await expect(dlg(page)).toHaveAttribute('data-mode', 'team');
    await expect(dlg(page).locator('.modal-title')).toHaveText('Ratings report builder');
    await expect(page.locator('#rr-count')).toHaveText('Ratings on the report: 5 / 5'); // the waiting rider is not a rating

    // Everything, with full names, by default.
    let html = await printed(page);
    let t = text(html);
    expect(html).toContain('Ratings report');
    for (const s of ['Lina Haddad', 'Circuit Rider', 'Scores by question', 'Brakes squeaked', 'Chain slipped', 'Lovely morning', 'Every rating']) expect(t).toContain(s);
    expect(t).toMatch(/5 Ratings/);

    // A score of 8 or under anywhere: Maya's 10s are left out.
    await page.locator('#tab-analytics .rr-open').click();
    await pick(page, 'A score of 8 or under', 'Has one');
    await expect(page.locator('#rr-count')).toHaveText('Ratings on the report: 4 / 5');
    // No name: no names and no booking numbers, and their columns cannot be ticked.
    await dlg(page).getByRole('button', { name: 'No name', exact: true }).click();
    await expect(dlg(page).locator('[data-rep="cols:name"]')).toBeDisabled();
    await expect(dlg(page).locator('[data-rep="cols:qnum"]')).toBeDisabled();
    html = await printed(page);
    t = text(html);
    for (const n of ['Lina Haddad', 'Omar Saleh', 'Sami Nabil Haddad', 'Circuit Rider', 'Maya Saeed']) expect(html).not.toContain(n);
    expect(html).not.toContain('#11');
    expect(t).toContain('Anonymous: no names or booking numbers.');
    expect(t).toContain('A score of 8 or under: Has one');
    expect(t).toMatch(/4 Ratings/);

    // First names, and the bike feedback quick start: only the bike questions, so only ratings that answered one.
    await page.locator('#tab-analytics .rr-open').click();
    await dlg(page).getByRole('button', { name: 'First name', exact: true }).click();
    await dlg(page).getByRole('button', { name: 'Bike feedback' }).click();
    await expect(dlg(page).locator('[data-rep="qs:bike"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(dlg(page).locator('[data-rep="qs:overall"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#rr-count')).toHaveText('Ratings on the report: 2 / 5'); // Lina's ride bike 8, the circuit rider's bike 3
    html = await printed(page);
    t = text(html);
    expect(t).toContain('Bike score by bike type');
    expect(t).toContain('Chain slipped');
    expect(t).toContain('Brakes squeaked');
    expect(t).not.toContain('Eggs a bit cold'); // a breakfast reason: not a question picked
    expect(t).toContain('Circuit'); // first names only
    expect(html).not.toContain('Circuit Rider');

    // The picks are kept on the device.
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('cq_rr_rep_opts')||'{}').name`)).toBe('first');
  });

  test('the builder\'s CSV carries the questions picked, and its dates narrow it', async ({ page }) => {
    await boot(page);
    await page.locator('#tab-analytics .rr-open').click();
    await pick(page, 'Dates', 'Last 7 days'); // Saturday b (2 days ago) and the circuit night (5 days ago)
    await expect(page.locator('#rr-count')).toHaveText('Ratings on the report: 2 / 5');
    const [file] = await Promise.all([page.waitForEvent('download'), dlg(page).locator('.rr-csv').click()]);
    expect(file.suggestedFilename()).toMatch(/^ratings_/);
    const csv = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
    const [head, ...rows] = csv.replace(new RegExp('^' + String.fromCharCode(0xfeff)), '').trim().split('\n');
    expect(head).toContain('Date,Ride,Name');
    expect(head).toContain('Breakfast · Food');
    expect(rows).toHaveLength(2);
    expect(csv).toContain('Sami Nabil Haddad');
    expect(csv).toContain('Circuit Rider');
    expect(csv).not.toContain('Lina Haddad');
  });
});
