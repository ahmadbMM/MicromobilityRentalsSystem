import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Analytics fixes of 2026-10-05 (fix5, slice rc2): promo redemptions without cancelled bookings, paid
// no-shows out of the revenue lost, the account holder (not a companion) named on the retention lists
// and their WhatsApp links, every rider of a party counted, every bike type in the Height & Bike report
// with a translated leftover, two rides on one day kept apart in the durations, the session table's
// headings reachable by keyboard, the Ratings view honouring the range, and the rating pictures drawn
// within what iOS can hold. State is set straight into S; every name and number is invented.

const ksa = (n = 0) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });

async function boot(page: Page) {
  await stubSupabase(page, {});
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.staffRole='admin'`);
}
type Data = { sessions: Record<string, unknown>[]; rows: Record<string, unknown>[]; customers?: Record<string, unknown>[]; setup?: string };
// Bookings go in in the database's shape, through entryFromDB, as the app reads them.
async function show(page: Page, d: Data, view: string) {
  await page.evaluate(([d, view]) => {
    // The app's state and helpers are globals of its scripts (S a top-level const): read them by name.
    const g = (n: string) => (0, eval)(n);
    const S = g('S') as Record<string, unknown>, fromDB = g('entryFromDB') as (r: Record<string, unknown>) => unknown;
    S.sessions = d.sessions; S.cashSales = []; S.customers = d.customers || [];
    S.queue = d.rows.map((r) => fromDB({ session_day: 'Friday', status: 'done', paid: true, price: 100, type_preference: 'Road', name: 'Rider', registered_at: '2026-01-01T10:00:00Z', ...r }));
    S.analyticsRange = 'all'; S.anSession = 'all';
    if (d.setup) g(d.setup);
    g('setStaffTab')('analytics'); g('setAnView')(view);
  }, [d, view] as const);
}
const sess = (id: string, date: string, time = '18:00 - 20:00') => ({ id, day: 'Friday', session_date: date, capacity: 12, status: 'closed', created_at: 1, bike_slots: JSON.stringify({ _time: time }) });
const tab = (page: Page) => page.locator('#tab-analytics');

test.describe('@staff:analytics fix5 rc2', () => {
  test.beforeEach(async ({ page }) => { await boot(page); });

  test('promo redemptions leave out cancelled and removed bookings, as the database counter does', async ({ page }) => {
    await show(page, {
      sessions: [sess('s1', ksa(-5))],
      rows: [
        { id: 'p1', session_id: 's1', session_date: ksa(-5), promo_code: 'SAVEFIX', status: 'done' },
        { id: 'p2', session_id: 's1', session_date: ksa(-5), promo_code: 'SAVEFIX', status: 'cancelled' },
        { id: 'p3', session_id: 's1', session_date: ksa(-5), promo_code: 'SAVEFIX', status: 'removed' },
        { id: 'p4', session_id: 's1', session_date: ksa(-5), promo_code: 'GONEFIX', status: 'cancelled' },
      ],
    }, 'operations');
    const promo = tab(page).locator('table.an-w100-240 tbody tr');
    await expect(promo).toHaveCount(1);
    await expect(promo.locator('td')).toHaveText(['SAVEFIX', '1']);
  });

  test('a paid no-show is not revenue lost; an unpaid one is', async ({ page }) => {
    await show(page, {
      sessions: [sess('s1', ksa(-5))],
      rows: [
        { id: 'n1', session_id: 's1', session_date: ksa(-5), status: 'noshow', paid: true, price: 100 },
        { id: 'n2', session_id: 's1', session_date: ksa(-5), status: 'noshow', paid: false, price: 80 },
        { id: 'd1', session_id: 's1', session_date: ksa(-5), status: 'done' },
      ],
    }, 'operations');
    const card = tab(page).locator('.analytics-kpi-card', { hasText: 'est. revenue lost' });
    await expect(card).toContainText('~SAR 80 est. revenue lost');
  });

  test('the retention lists and their WhatsApp links name the account holder, not the companion who rode last', async ({ page }) => {
    const customers = [{ id: 'c1', name: 'Holder Fixture', email: 'holder@example.com', phone: '+966551870099', created_at: '2026-01-01T10:00:00Z' }];
    await show(page, {
      customers,
      sessions: [sess('sOld', ksa(-50)), sess('sNew', ksa(-40))],
      rows: [
        { id: 'h1', session_id: 'sOld', session_date: ksa(-50), customer_id: 'c1', name: 'Holder Fixture', phone: '+966551870099', checked_in_at: ksa(-50) + 'T15:00:00Z' },
        { id: 'h2', session_id: 'sNew', session_date: ksa(-40), customer_id: 'c1', name: 'Friend Fixture', phone: '0551999999', checked_in_at: ksa(-40) + 'T15:00:00Z' },
        // an account this device does not hold: its rows answer
        { id: 'u1', session_id: 'sNew', session_date: ksa(-40), customer_id: 'c-gone', name: 'Unknown Fixture', phone: '0551888888', checked_in_at: ksa(-40) + 'T15:00:00Z' },
      ],
    }, 'customers');
    const lapsed = tab(page).locator('.table-wrapper', { hasText: 'Lapsed riders' }).locator('table');
    const top = tab(page).locator('.table-wrapper', { hasText: 'Top customers' }).locator('table');
    await expect(lapsed.locator('tbody tr', { hasText: 'Holder Fixture' })).toHaveCount(1);
    await expect(lapsed).not.toContainText('Friend Fixture');
    const wa = lapsed.locator('tbody tr', { hasText: 'Holder Fixture' }).locator('a[href*="wa.me"]');
    await expect(wa).toHaveAttribute('href', /wa\.me\/966551870099\?/);
    await expect(lapsed.locator('tbody tr', { hasText: 'Unknown Fixture' })).toHaveCount(1);
    await expect(top.locator('tbody tr', { hasText: 'Holder Fixture' })).toHaveCount(1);
    await expect(top).not.toContainText('Friend Fixture');
    await page.evaluate(`setAnView('growth')`);
    await expect(tab(page).locator('.an-rfm-chip', { hasText: 'Holder Fixture' })).toHaveAttribute('href', /wa\.me\/966551870099\?/);
    await expect(tab(page).locator('.an-rfm-chip, .an-rfm-chip-off', { hasText: 'Friend Fixture' })).toHaveCount(0);
  });

  test('Number of Riders counts each rider of a party on one account', async ({ page }) => {
    const d = ksa(-3);
    await show(page, {
      sessions: [sess('s1', d)],
      rows: [
        { id: 'r1', session_id: 's1', session_date: d, customer_id: 'c1', name: 'Holder Fixture' },
        { id: 'r2', session_id: 's1', session_date: d, customer_id: 'c1', name: 'Friend One' },
        { id: 'r3', session_id: 's1', session_date: d, customer_id: 'c1', name: 'friend  one ' }, // the same rider typed again
        { id: 'r4', session_id: 's1', session_date: d, customer_id: 'c1', name: 'Friend Two' },
        { id: 'r5', session_id: 's1', session_date: d, customer_id: null, name: 'Walk Fixture', phone: '0551777777' },
      ],
    }, 'ridership');
    const card = tab(page).locator('.analytics-kpi-card', { hasText: 'Number of Riders' });
    await expect(card.locator('.analytics-kpi-value')).toHaveText('4');
  });

  test('the Height & Bike report counts every bike type and names the leftover in the staff language', async ({ page }) => {
    const d = ksa(-3);
    const r = (id: string, type: string, height: number) => ({ id, session_id: 's1', session_date: d, name: 'Rider ' + id, type_preference: type, height });
    await show(page, {
      sessions: [sess('s1', d)],
      rows: [r('a', 'Road', 175), r('b', 'Kids', 130), r('c', 'Road Carbon', 182), r('e', 'Own', 170), r('f', 'Any', 165), r('g', 'Tandem', 160)],
    }, 'overview');
    const rows = await page.evaluate(`_anHbTypeRows(_anHeightBikeData()[0])`);
    expect(rows).toEqual([['Road', 1], ['Hybrid', 0], ['Mountain', 0], ['Kids', 1], ['Road Carbon', 1], ['Bike owner', 1], ['Other', 2]]);
    expect(await page.evaluate(`_anHeightBikeData()[0].rented`)).toBe(6);
    // The printed report carries the same lines.
    const html = await page.evaluate(`(()=>{let h='';const o=_openReport;_openReport=(x)=>{h=x;};try{printHeightBikeReport();}finally{_openReport=o;}return h;})()`) as string;
    for (const s of ['<td>Kids</td>', '<td>Road Carbon</td>', '<td>Bike owner</td>', '<td>Other</td>']) expect(html).toContain(s);
    await page.evaluate(`setLang('ar')`);
    await expect.poll(() => page.evaluate(`_anHbTypeRows(_anHeightBikeData()[0]).at(-1)`)).toEqual(['أخرى', 2]);
  });

  test('two rides on one day keep their own average duration, each named with its start time', async ({ page }) => {
    const d = ksa(-3);
    await show(page, {
      sessions: [sess('eve', d, '18:00 - 20:00'), sess('late', d, '20:30 - 22:00')],
      rows: [
        { id: 'a', session_id: 'eve', session_date: d, ride_duration: 30 },
        { id: 'b', session_id: 'late', session_date: d, ride_duration: 60 },
      ],
    }, 'ridership');
    const card = tab(page).locator('.chart-card', { hasText: 'Avg Duration by Session' });
    const labels = card.locator('.analytics-bar-label');
    await expect(labels).toHaveCount(2);
    await expect(labels.nth(0)).toContainText('6 PM');
    await expect(labels.nth(1)).toContainText('8:30 PM');
    await expect(card.locator('.analytics-bar-value')).toHaveText(['30 min', '1 h 0 min']);
  });

  test('the session table\'s headings are buttons that say the order, and Enter sorts', async ({ page }) => {
    const rows = [1, 2, 3].map((i) => ({ id: 'q' + i, session_id: 's' + i, session_date: ksa(-i - 2) }));
    rows.push({ id: 'q4', session_id: 's1', session_date: ksa(-3) });
    await show(page, { sessions: [sess('s1', ksa(-3)), sess('s2', ksa(-4)), sess('s3', ksa(-5))], rows }, 'operations');
    const table = tab(page).locator('table.analytics-trend-table[data-nosort]');
    await expect(table.locator('thead th.an-sort-th button')).toHaveCount(8);
    await expect(table.locator('thead th').nth(0)).toHaveAttribute('aria-sort', 'descending'); // by date, newest first
    await expect(table.locator('thead th').nth(2)).toHaveAttribute('aria-sort', 'none');
    const riders = () => tab(page).locator('table.analytics-trend-table[data-nosort] thead th').nth(2);
    await riders().locator('button').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate('S.analyticsTrendSort')).toBe('riders');
    await expect(riders()).toHaveAttribute('aria-sort', 'descending');
    await expect(tab(page).locator('table.analytics-trend-table[data-nosort] tbody tr').first().locator('td').nth(2)).toHaveText('2 / 12');
    await riders().locator('button').focus();
    await page.keyboard.press('Enter');
    await expect(riders()).toHaveAttribute('aria-sort', 'ascending');
    await page.waitForTimeout(200); // the shared table sort mounts 80 ms after a paint: it keeps out of this table
    await expect(table.locator('thead th.th-sort')).toHaveCount(0);
  });

  test('the Ratings view reads the range picked above it', async ({ page }) => {
    const today = ksa(0), old = ksa(-90);
    await show(page, {
      sessions: [sess('sNow', today), sess('sOld', old)],
      rows: [
        { id: 'k1', session_id: 'sNow', session_date: today, name: 'Now Fixture', rating_exp: 9, rating_bike: 8 },
        { id: 'k2', session_id: 'sOld', session_date: old, name: 'Old Fixture', rating_exp: 4, rating_bike: 5, feedback: 'Too old' },
      ],
    }, 'ratings');
    await expect(tab(page).locator('.an-rate-card')).toHaveCount(2);
    await page.evaluate(`setAnRange('month');setAnView('ratings')`);
    await expect(tab(page).locator('.an-rate-card')).toHaveCount(1);
    await expect(tab(page).locator('.an-rate-card')).toContainText('Now Fixture');
    await expect(tab(page).locator('.an-rate-card', { hasText: 'Old Fixture' })).toHaveCount(0);
  });

  test('a long rating is drawn smaller rather than past what iOS can hold, and each canvas is let go once made', async ({ page }) => {
    const d = ksa(-2);
    await show(page, {
      sessions: [sess('s1', d)],
      rows: [
        { id: 'short', session_id: 's1', session_date: d, name: 'Short Fixture', rating_exp: 9, rating_bike: 9, feedback: 'Lovely ride' },
        { id: 'long', session_id: 's1', session_date: d, name: 'Long Fixture', rating_exp: 5, rating_bike: 6, feedback: 'The ride went on and on along the sea. '.repeat(130) },
      ],
    }, 'ratings');
    const size = (id: string) => page.evaluate(`(async()=>{const c=await _rsDraw(getQueue().find(e=>e.id==='${id}'),'full');return [c.width,c.height];})()`) as Promise<[number, number]>;
    expect((await size('short'))[0]).toBe(2160); // an ordinary rating keeps its two-times sharpness
    const [w, h] = await size('long');
    expect(h).toBeLessThanOrEqual(7700);
    expect(w).toBeGreaterThanOrEqual(1080);
    expect(w).toBeLessThan(2160);
    // Every canvas a picture was drawn on is emptied once its file is made.
    await page.evaluate(`(()=>{window.__cv=[];const d=_rsDraw;window._rsDraw=async(...a)=>{const c=await d(...a);window.__cv.push(c);return c;};})()`);
    await page.evaluate(`_rsOpen(['short','long'])`);
    await expect(page.locator('#confirm-modal .rs-dlg .rs-prev img')).toHaveCount(2);
    expect(await page.evaluate(`window.__cv.map(c=>c.width+'x'+c.height)`)).toEqual(['0x0', '0x0']);
  });
});

test.describe('@staff:bookings fix5 rc2 the N shortcut', () => {
  test('N and the Dashboard\'s Check in next open the check-in only for a role with Bookings', async ({ page }) => {
    const d = ksa(0);
    await stubSupabase(page, {
      sessions: [sess('tonight', d)],
      queue_entries: [{ id: 'w1', session_id: 'tonight', session_day: 'Friday', session_date: d, queue_num: 1, name: 'Waiting Fixture', phone: '', status: 'waiting', paid: false, price: 100, type_preference: 'Road', registered_at: d + 'T10:00:00Z' }],
      bikes: [],
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('allSessions().length>0');
    await page.waitForFunction(`S.view==='staff'&&!_visibleModals().length`);
    await page.evaluate(`window.__ci=[];showCheckinModal=id=>{window.__ci.push(id)};S.sfSession='all'`);
    // A cashier: Sales and Inventory only.
    await page.evaluate(`S.staffRole='cashier';setStaffTab('cashier')`);
    await page.evaluate(`document.activeElement&&document.activeElement.blur&&document.activeElement.blur()`);
    await page.keyboard.press('n');
    await page.evaluate(`_kbCheckInNext()`);
    await page.waitForTimeout(150);
    expect(await page.evaluate('window.__ci')).toEqual([]);
    // An admin: N opens tonight's next rider.
    await page.evaluate(`S.staffRole='admin';setStaffTab('queue')`);
    await page.evaluate(`document.activeElement&&document.activeElement.blur&&document.activeElement.blur()`);
    await page.keyboard.press('n');
    await expect.poll(() => page.evaluate('window.__ci')).toEqual(['w1']);
  });
});
