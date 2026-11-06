import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The Sessions section's second round (the staff review of 2026-11-06; migration 20261107111000): announce, attendance and
// money columns, the calendar's week, pop-up and drag, the new-session form starting clean, promo codes for one session,
// bikes out of service, minimum riders, the staff rota and the lead's roster link.

const ride = (id: string, extra: Record<string, unknown> = {}) => ({
  id, session_date: id.slice(0, 10), day: 'Tuesday', status: 'open', capacity: 4, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","Road":{"M":2},"Hybrid":{"M":2}}', out_bikes: {}, go_min: null, go_decide_at: null, ...extra,
});
const SESS = [
  ride('2099-03-03'),
  ride('2099-03-05', { day: 'Thursday', capacity: 2, bike_slots: '{"_time":"19:00 - 21:00","_total":2}' }),
  ride('2099-03-07-sw', { session_date: '2099-03-07', day: 'Saturday', event_kind: 'community', ride_kind: 'swim', spots: 10, capacity: 10, title: 'Pool morning' }),
];
const entry = (id: string, sid: string, n: number, status = 'waiting', extra: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_date: sid.slice(0, 10), session_day: 'Thursday', queue_num: n, name: `Rider ${n}`,
  phone: '0500000000', type_preference: 'Road', status, price: 100, paid: false, created_at: '2099-01-01T10:00:00Z', ...extra,
});
async function open(page: Page, path = '/sessions', fx: Record<string, unknown> = {}) {
  await stubSupabase(page, {
    sessions: SESS,
    queue_entries: [entry('e1', '2099-03-03', 1), entry('e2', '2099-03-03', 2, 'waiting', { paid: true }), entry('e3', '2099-03-05', 1)],
    ...fx,
  });
  await unlockStaff(page);
  await page.goto(path);
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded&&S.staffTab==='sessions'&&!!document.querySelector('#tab-sessions .ss-page')`);
}
const writes = (page: Page, re: RegExp) => {
  const l: { method: string; url: string; body: string }[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && r.method() !== 'OPTIONS' && re.test(r.url())) l.push({ method: r.method(), url: decodeURIComponent(r.url()), body: r.postData() || '' }); });
  return l;
};

test.describe('@staff:sessions the Sessions section, second round', () => {
  test('the table takes the attendance and money columns; a free ride shows no money', async ({ page }) => {
    await open(page, '/sessions/table');
    await page.evaluate(`S.sessCols='date,owed,show,money,exp';renderSessions()`);
    const head = page.locator('#tab-sessions .ss-tbl thead');
    await expect(head).toContainText('Owed');
    await expect(head).toContainText('Show-up %');
    await expect(head).toContainText('Expected');
    const at = async (id: string) => Number(await page.evaluate(`_ssShown.findIndex(s=>s.id==='${id}')`));
    const pool = page.locator('#tab-sessions .ss-tbl tbody tr.ss-tr').nth(await at('2099-03-07-sw'));
    await expect(pool.locator('td.ss-td-money')).toHaveText('—');
    await expect(pool.locator('td.ss-td-owed')).toHaveText('—');
    await expect(page.locator('#tab-sessions .ss-tbl tbody tr.ss-tr').nth(await at('2099-03-03')).locator('td.ss-td-owed')).toContainText('100');
  });

  test('Announce gives English and Arabic words with the booking link', async ({ page }) => {
    await open(page);
    await page.evaluate(`selectSessionDetail('2099-03-03')`);
    await page.locator('#tab-sessions').getByRole('button', { name: 'Announce' }).click();
    const dlg = page.getByRole('dialog', { name: /Announce/ });
    await expect(dlg.locator('#n6r-ann-en')).toHaveValue(/is open for booking.*\?ev=jcc&session=2099-03-03/s);
    await expect(dlg.locator('#n6r-ann-ar')).toHaveValue(/الحجز مفتوح/);
    await expect(dlg.locator('#n6r-ann-link')).toHaveValue(/\?ev=jcc&session=2099-03-03$/);
  });

  test('the calendar shows a week, opens a session in a pop-up, and a drag moves it with the server\'s move', async ({ page }) => {
    await open(page, '/sessions/calendar', { 'rpc:staff_move_session': { ok: true, id: '2099-03-10', day: 'Tuesday' } });
    await page.evaluate(`S._n6rCalMode='week';S._n6rWk0='2099-03-01';renderSessions()`);
    await expect(page.locator('#tab-sessions .n6r-wk-day')).toHaveCount(7);
    await expect(page.locator('#tab-sessions .n6r-wk-day[data-day="2099-03-03"] .cal-add')).toHaveCount(1); // a + on a day that has a session
    await page.locator('#tab-sessions .n6r-wk-day[data-day="2099-03-03"] .cal-sess').click();
    const pop = page.getByRole('dialog');
    await expect(pop).toContainText('2/4');
    await pop.getByRole('button', { name: 'Close' }).click();
    const rpc = writes(page, /rpc\/staff_move_session/);
    await page.evaluate(`_n6rMove('2099-03-03','2099-03-10')`);
    await page.locator('#confirm-modal').getByRole('button', { name: 'Move', exact: true }).click();
    await expect.poll(() => rpc.length).toBe(1);
    expect(JSON.parse(rpc[0].body)).toMatchObject({ p_from: '2099-03-03', p_to_id: '2099-03-10', p_date: '2099-03-10' });
  });

  test('New session opens clean whatever an earlier form left', async ({ page }) => {
    await open(page);
    await page.evaluate(`S.showAddSession=false;S.newSessEvent='event';S.newSessTitle='Left behind';S.newSessPrice='99';S.newSessDays=[2,4]`);
    await page.locator('#tab-sessions .section-header').getByRole('button', { name: /New Session/ }).click();
    await expect(page.locator('#sess-add-form')).toBeVisible();
    expect(await page.evaluate(`[S.newSessEvent,S.newSessTitle,S.newSessPrice,S.newSessDays.length]`)).toEqual(['jcc', '', '', 0]);
  });

  test('bikes out of service take places away, and the save writes them on the session', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(`_placesCap(_sessGet('2099-03-03'))`)).toBe(4);
    const w = writes(page, /\/rest\/v1\/sessions\?/);
    await page.evaluate(`selectSessionDetail('2099-03-03')`);
    await page.locator('#tab-sessions').getByRole('button', { name: 'Bikes out of service' }).click();
    const dlg = page.getByRole('dialog', { name: /Bikes out of service/ });
    await dlg.getByLabel('Road', { exact: true }).fill('1');
    await expect(dlg.locator('#n6r-out-warn')).toContainText('Road: 2 riders, 1 places');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(JSON.parse(w[0].body)).toEqual({ out_bikes: { Road: 1 } });
    await expect(page.getByRole('dialog', { name: /Bikes out of service/ })).toHaveCount(0);
    // the reload after the save answers from the stub (no bikes out): the row as the database would now hold it
    await expect.poll(() => page.evaluate(`S.sessions=S.sessions.map(s=>s.id==='2099-03-03'?{...s,out_bikes:{Road:1}}:s);[_placesCap(_sessGet('2099-03-03')),spotsLeft('2099-03-03')]`)).toEqual([3, 1]);
  });

  test('the rota is kept per session and Bookings shows it as one line', async ({ page }) => {
    await open(page, '/sessions', { session_rota: [{ id: 'r1', session_id: '2099-03-03', role: 'lead', name: 'Sara' }] });
    await page.evaluate(`selectSessionDetail('2099-03-03')`);
    await expect(page.locator('#tab-sessions .n6r-box')).toContainText('Sara');
    const w = writes(page, /\/rest\/v1\/session_rota/);
    await page.locator('#n6r-rr').selectOption('desk');
    await page.locator('#n6r-rn').fill('Omar');
    await page.locator('#tab-sessions .n6r-rota-add').getByRole('button', { name: 'Add' }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(JSON.parse(w[0].body)).toMatchObject({ session_id: '2099-03-03', role: 'desk', name: 'Omar' });
    await expect(page.locator('#tab-sessions .n6r-box')).toContainText('Omar');
    expect(await page.evaluate(`_n6rLeadText(_sessGet('2099-03-03'))`)).toContain('Sara');
    await page.evaluate(`_ssToBookings('2099-03-03')`);
    await expect(page.locator('#tab-queue .n6r-rota-line')).toContainText('Lead: Sara');
  });

  test('minimum riders stay hidden until the Settings switch, then a short session is flagged and offers the cancel', async ({ page }) => {
    await open(page, '/sessions');
    await page.evaluate(`S.sessions=S.sessions.map(s=>s.id==='2099-03-03'?{...s,go_min:5,go_decide_at:'2020-01-01T00:00:00Z'}:s);selectSessionDetail('2099-03-03')`);
    await expect(page.locator('#tab-sessions').getByRole('button', { name: 'Minimum riders' })).toHaveCount(0);
    await page.evaluate(`S.staffOptions={...(S.staffOptions||{}),biz:{...((S.staffOptions||{}).biz||{}),gonogo_on:true}};renderSessions()`);
    await expect(page.locator('#tab-sessions .n6r-go-short')).toContainText('3 short');
    await expect(page.locator('#tab-sessions').getByRole('button', { name: 'Cancel this night' })).toBeVisible();
    expect(await page.evaluate(`_n6rGoDue().map(s=>s.id)`)).toEqual(['2099-03-03']);
  });

  test('a promo code can be limited to one session, and its use is shown', async ({ page }) => {
    await open(page, '/sessions', { promo_codes: [{ id: 'p1', code: 'ONE', kind: 'percent', value: 10, active: true, uses: 2, session_id: null, ride_kind: null }] });
    await expect(page.locator('#tab-sessions .pc-wrap')).toContainText('Used · discount given');
    const w = writes(page, /\/rest\/v1\/promo_codes/);
    await page.locator('#pc-code').fill('ONLYTUE');
    await page.locator('#pc-value').fill('20');
    await page.locator('#pc-sess').selectOption('2099-03-03');
    await page.locator('#tab-sessions .pc-wrap').getByRole('button', { name: /Add/ }).first().click();
    await expect.poll(() => w.filter((x) => x.method === 'POST').length).toBe(1);
    expect(JSON.parse(w.find((x) => x.method === 'POST')!.body)).toMatchObject({ code: 'ONLYTUE', session_id: '2099-03-03' });
  });
});
