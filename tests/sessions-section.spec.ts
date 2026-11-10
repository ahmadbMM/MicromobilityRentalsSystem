import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Sessions is a section of its own (the owner, 2026-11-06: "separate the bookings and sessions pages, make them in
// separate clickable sections and add more features to the sessions page and customizability as much as possible").
// Its rail entry and address, the time range, search, kind and fill filters, the table and its columns (Customize),
// group by, the bulk status change with its one write, and the detail's way back to Bookings.

const ride = (id: string, extra: Record<string, unknown> = {}) => ({
  id, session_date: id.slice(0, 10), day: 'Tuesday', status: 'open', capacity: 4, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":4}', ...extra,
});
const SESS = [
  ride('2099-03-03'),
  ride('2099-03-05', { day: 'Thursday', capacity: 2, bike_slots: '{"_time":"19:00 - 21:00","_total":2}' }),
  ride('2099-03-07-sw', { session_date: '2099-03-07', day: 'Saturday', event_kind: 'community', ride_kind: 'swim', spots: 10, capacity: 10, title: 'Pool morning' }),
  ride('2020-01-07', { status: 'closed' }),
];
const entry = (id: string, sid: string, n: number, status = 'waiting') => ({
  id, session_id: sid, session_date: sid.slice(0, 10), session_day: 'Thursday', queue_num: n, name: `Rider ${n}`,
  phone: '0500000000', bike_type: 'Road', status, created_at: '2099-01-01T10:00:00Z',
});
async function open(page: Page, path = '/') {
  await stubSupabase(page, { sessions: SESS, queue_entries: [entry('e1', '2099-03-05', 1), entry('e2', '2099-03-05', 2)] });
  await unlockStaff(page);
  await page.goto(path);
  await waitForSb(page);
}
const cards = (page: Page) => page.locator('#tab-sessions .sess-lc');

test.describe('@staff:sessions the Sessions section', () => {
  test('has its own rail entry and address, and is no longer a view of Bookings', async ({ page }) => {
    await open(page);
    await page.waitForFunction(`S.dataLoaded&&S.staffTab==='queue'`);
    await expect(page.locator('#tab-queue .q-views', { hasText: 'Sessions' })).toHaveCount(0); // the row is left out when empty (staff round s10)
    if (await page.locator('#snav-burger').isVisible()) await page.locator('#snav-burger').click(); // a phone: the rail is a menu
    await page.locator('#staff-tab-nav .tab-btn[data-stab="sessions"]').click();
    await expect(page.locator('#tab-sessions .page-title').first()).toHaveText('Sessions');
    await expect(page.locator('#tab-sessions')).toBeVisible();
    await expect(page.locator('#tab-queue')).toBeHidden();
    expect(new URL(page.url()).pathname).toBe('/sessions');
    await expect(cards(page)).toHaveCount(4);
  });

  test('the time range, the search and the kind and fill filters narrow the list; Clear filters brings it back', async ({ page }) => {
    await open(page, '/sessions');
    await expect(cards(page)).toHaveCount(4);
    await page.locator('#tab-sessions .ss-range .filter-pill', { hasText: 'Upcoming' }).click();
    await expect(cards(page)).toHaveCount(3);
    const fold = page.locator('#tab-sessions [data-srch="sess"] .srch-btn');
    if (await fold.isVisible()) await fold.click(); // a phone: the search is folded into a button
    await page.locator('#ss-q').fill('pool');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('Pool');
    await page.locator('#tab-sessions').getByRole('button', { name: 'Clear filters' }).click();
    await expect(cards(page)).toHaveCount(4);
    await page.evaluate(`_ssSet('sessKind','swim')`);
    await expect(cards(page)).toHaveCount(1);
    await page.evaluate(`_ssClear();_ssSet('sessFill','high')`); // 2 of 2 booked: no places left, so not "almost full"
    await expect(cards(page)).toHaveCount(0);
    await page.evaluate(`_ssSet('sessFill','full')`);
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first()).toContainText('2/2');
  });

  test('the table shows the columns Customize picks, and the choice is kept for the staffer', async ({ page }) => {
    await open(page, '/sessions/table');
    const head = page.locator('#tab-sessions .ss-tbl thead th');
    await expect(head).toHaveCount(9); // the tick box and the eight default columns
    await page.locator('#tab-sessions').getByRole('button', { name: 'Customize' }).click();
    const dlg = page.getByRole('dialog', { name: 'Customize the Sessions page' });
    await dlg.getByLabel('Waitlist').uncheck();
    await dlg.getByLabel('Day', { exact: true }).check();
    await expect(head).toHaveCount(9);
    await expect(page.locator('#tab-sessions .ss-tbl thead')).toContainText('Day');
    await expect(page.locator('#tab-sessions .ss-tbl thead')).not.toContainText('Waitlist');
    await dlg.getByLabel('Compact rows').check();
    await expect(page.locator('#tab-sessions .ss-page')).toHaveClass(/ss-dense/);
    expect(await page.evaluate(`_pref('state.sessions',null)`)).toMatchObject({ sessDense: true, sessCols: expect.stringContaining('day') });
    await dlg.getByRole('button', { name: 'Back to the defaults' }).click();
    await expect(head).toHaveCount(9);
    await expect(page.locator('#tab-sessions .ss-tbl thead')).toContainText('Waitlist');
  });

  test('group by kind puts a heading over each kind', async ({ page }) => {
    await open(page, '/sessions');
    await page.evaluate(`_ssSet('sessGroup','kind')`);
    await expect(page.locator('#tab-sessions .ss-grp-h')).toHaveCount(2);
  });

  test('a selection changes many sessions in one write, and Undo is offered', async ({ page }) => {
    await open(page, '/sessions/table');
    const patches: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && /\/rest\/v1\/sessions\?/.test(r.url())) patches.push(decodeURIComponent(r.url()) + ' ' + r.postData()); });
    await page.getByLabel(/^Select .*2099/).first().check();
    await page.getByLabel(/^Select .*2099/).nth(1).check();
    await expect(page.locator('#tab-sessions .ss-bulk')).toContainText('2 selected');
    await page.locator('#tab-sessions .ss-bulk').getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Change', exact: true }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toContain('id=in.');
    expect(patches[0]).toContain('"status":"closed"');
    await expect(page.locator('#tab-sessions .ss-bulk')).toHaveCount(0);
  });

  test('the detail adds the night\'s numbers and opens the ride in Bookings', async ({ page }) => {
    await open(page, '/sessions');
    await page.evaluate(`selectSessionDetail('2099-03-05')`);
    await expect(page.locator('#tab-sessions .sess-detail-stats')).toContainText('2/2');
    await page.locator('#tab-sessions').getByRole('button', { name: 'Open in Bookings' }).click();
    await page.waitForFunction(`S.staffTab==='queue'&&S.sfSession==='2099-03-05'`);
    expect(new URL(page.url()).pathname).toBe('/bookings');
  });

  test('Export CSV downloads the sessions shown', async ({ page }) => {
    await open(page, '/sessions');
    await page.locator('#tab-sessions .ss-range .filter-pill', { hasText: 'Past' }).click();
    const dl = page.waitForEvent('download');
    await page.locator('#tab-sessions .ss-bar-acts').getByRole('button', { name: 'Export CSV' }).click();
    const d = await dl;
    expect(d.suggestedFilename()).toMatch(/^sessions-\d{4}-\d{2}-\d{2}\.csv$/);
    const body = String(await (await d.createReadStream()).toArray().then((c) => Buffer.concat(c)));
    expect(body.split('\n')).toHaveLength(2);
    expect(body).toContain('2020-01-07');
  });
});
