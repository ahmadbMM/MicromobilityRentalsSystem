import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The Sessions page review (2026-11-07, SS01-SS10; migration 20261107110000): past nights still open, the Date sort,
// Victory Lap's price, money older than the window, the Day / Capacity / Bookings sorts, clashes, copy a week, bulk
// edit, repeating series, and Draft / Open now / Open at.

const ride = (id: string, extra: Record<string, unknown> = {}) => ({
  id, session_date: id.slice(0, 10), day: 'Tuesday', status: 'open', capacity: 4, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":4}', ...extra,
});
const BASE = [
  ride('2099-03-03'),
  ride('2099-03-05', { day: 'Thursday', capacity: 2, bike_slots: '{"_time":"19:00 - 21:00","_total":2}' }),
  ride('2099-03-01', { day: 'Sunday', capacity: 9, bike_slots: '{"_time":"21:00 - 23:00","_total":9}' }),
  ride('2020-01-07'), // over and still open
];
async function open(page: Page, path = '/sessions', sessions: unknown[] = BASE) {
  await stubSupabase(page, { sessions });
  await unlockStaff(page);
  await page.goto(path);
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded&&S.staffTab==='sessions'`);
}
const writes = (page: Page, method: string) => {
  const l: string[] = [];
  page.on('request', (r) => { if (r.method() === method && /\/rest\/v1\/sessions/.test(r.url())) l.push(decodeURIComponent(r.url()) + ' ' + (r.postData() || '')); });
  return l;
};
const firstDates = (page: Page) => page.evaluate(`_ssShown.map(s=>s.id)`) as Promise<string[]>;

test.describe('@staff:sessions the Sessions review', () => {
  test('Date sorts the staff way round, and Day sorts Sunday first; Capacity follows the places shown', async ({ page }) => {
    await open(page);
    await page.evaluate(`setSessSort('time');setSessSort('date')`);
    expect(await page.evaluate('S.sessSortDir')).toBe(-1);
    await expect(page.locator('#tab-sessions .ss-rev')).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(`setSessSort('day')`);
    expect((await firstDates(page))[0]).toBe('2099-03-01'); // Sunday
    await page.evaluate(`setSessSort('capacity')`);
    expect((await firstDates(page))[0]).toBe('2099-03-05'); // 2 places
  });

  test('past nights still open have a figure that closes them in one write, and bulk Open skips past dates', async ({ page }) => {
    await open(page, '/sessions/summary'); // the figures are Sessions' Summary view (staff round s10)
    const patches = writes(page, 'PATCH');
    const fig = page.locator('#tab-sessions .ss-figs .dash-kpi', { hasText: 'Past, still open' });
    await expect(fig).toContainText('1');
    await fig.click();
    await page.locator('#confirm-modal .btn-red').click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toContain('2020-01-07');
    expect(patches[0]).toContain('"status":"closed"');
    // Bulk Open: a past night in the selection is left closed
    await page.waitForFunction(`!_busyKeys.has('ssBulk')`);
    await page.evaluate(`S.sessions=S.sessions.map(s=>({...s,status:'closed'}));S.sessSel=['2020-01-07','2099-03-03'];S.sessView='table';renderSessions()`);
    await page.locator('#tab-sessions .ss-bulk').getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page.locator('#confirm-modal')).toContainText('Change 1 sessions');
    await expect(page.locator('#confirm-modal')).toContainText('1 past sessions left closed');
  });

  test('a Victory Lap session\'s price can be changed in the editor', async ({ page }) => {
    await open(page, '/sessions', [...BASE, ride('2099-04-01-vl', { session_date: '2099-04-01', event_kind: 'community', ride_kind: 'vlap', spots: 50, capacity: 50, price: 150, paid_ride: true })]);
    await page.evaluate(`startEditSession('2099-04-01-vl')`);
    await expect(page.locator('#es-price')).toHaveValue('150');
  });

  test('money older than the booking window says so instead of a number', async ({ page }) => {
    await open(page, '/sessions/table');
    await page.evaluate(`S.sessCols='date,money';S.sessRange='past';renderSessions()`);
    await expect(page.locator('#tab-sessions .ss-td-money').first()).toHaveText('Too old');
  });

  test('a new session on a date that already has one of its kind is asked about first', async ({ page }) => {
    await open(page);
    const posts = writes(page, 'POST');
    await page.evaluate(`S.showAddSession=true;S.newSessEvent='jcc';S.newSessMode='total';S.newSessTotal=6;S.newSessDate='2099-03-03';renderSessions()`);
    await page.locator('#tab-sessions').getByRole('button', { name: 'Create session' }).click();
    const dlg = page.getByRole('dialog', { name: 'These dates clash with sessions already there' });
    await expect(dlg).toContainText('same kind');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(200);
    expect(posts).toHaveLength(0);
    await page.locator('#tab-sessions').getByRole('button', { name: 'Create session' }).click();
    await dlg.getByRole('button', { name: 'Go ahead anyway' }).click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toContain('"session_date":"2099-03-03"');
  });

  test('repeat every 2 weeks until a date, linked as a series once the database has the column', async ({ page }) => {
    await open(page, '/sessions', BASE.map((s) => ({ ...s, series_id: null, draft: false, opens_at: null })));
    expect(await page.evaluate(`_nsFillDates('2099-05-04','1',[],'2','2099-06-01')`)).toEqual(['2099-05-04', '2099-05-18', '2099-06-01']);
    const posts = writes(page, 'POST');
    await page.evaluate(`S.showAddSession=true;S.newSessEvent='jcc';S.newSessMode='total';S.newSessTotal=6;S.newSessDate='2099-05-04';S.n6sEvery='2';S.n6sUntil='2099-06-01';renderSessions()`);
    await expect(page.locator('#tab-sessions .n6s-pub .toggle-btn', { hasText: 'Open at a set time' })).toBeEnabled();
    await page.locator('#tab-sessions').getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => posts.length).toBe(3);
    const sid = JSON.parse(posts[0].slice(posts[0].indexOf(' ') + 1)).series_id;
    expect(sid).toBeTruthy();
    for (const p of posts) {
      const row = JSON.parse(p.slice(p.indexOf(' ') + 1));
      expect(row.series_id).toBe(sid);
      expect(row.draft).toBe(true);
      expect(row.status).toBe('closed');
    }
  });

  test('a draft wears its badge and timed opening waits for the database', async ({ page }) => {
    await open(page, '/sessions/table');
    await page.evaluate(`S.showAddSession=true;renderSessions()`);
    await expect(page.locator('#tab-sessions .n6s-pub .toggle-btn', { hasText: 'Open at a set time' })).toBeDisabled();
    await page.evaluate(`S.sessions=S.sessions.map(s=>s.id==='2099-03-03'?{...s,status:'closed',draft:true,opens_at:null}:s);S.showAddSession=false;renderSessions()`);
    await expect(page.locator('#tab-sessions .n6s-badge-draft')).toHaveCount(1);
  });

  test('copy a week makes closed copies a week on, and bulk edit writes what was typed', async ({ page }) => {
    await open(page, '/sessions/table');
    const posts = writes(page, 'POST');
    const patches = writes(page, 'PATCH');
    await page.evaluate(`S.sessSel=['2099-03-03'];renderSessions()`);
    await page.locator('#tab-sessions .ss-bulk').getByRole('button', { name: 'Copy to another week' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: '+1 weeks' }).click();
    await expect.poll(() => posts.length).toBe(1);
    const row = JSON.parse(posts[0].slice(posts[0].indexOf(' ') + 1));
    expect(row.session_date).toBe('2099-03-10');
    expect(row.status).toBe('closed');
    await expect(page.locator('#tab-sessions .ss-bulk')).toHaveCount(0); // the copy is done and the selection cleared
    await page.evaluate(`S.sessSel=['2099-03-03','2099-03-05'];renderSessions()`);
    await page.locator('#tab-sessions .ss-bulk').getByRole('button', { name: 'Edit', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: 'Edit 2 sessions' });
    await dlg.getByLabel('Description').fill('Bring water');
    await dlg.getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => patches.length).toBe(2);
    expect(patches.every((p) => p.includes('"description":"Bring water"'))).toBe(true);
  });
});
