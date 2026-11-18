import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Late arrivals (the staff Bookings round, 2026-11-18, item 9): "'Late 15 min' when a rider checks in after the gathering
// time, a late count on the account beside the no-show count, and a Late filter." Late = checked in more than ten whole
// minutes after the moment to turn up (a gathering ride's gathering time, else the start where everyone starts together),
// Riyadh time, on the session's day; a circuit night's riders come any time and are never late. Invented riders only.

const DAY = '2099-05-05';
const NOW = new Date(`${DAY}T09:00:00+03:00`);
const gather = (id: string, date: string, status = 'open') => ({
  id, day: 'Tuesday', session_date: date, capacity: 30, status, created_at: 1, ride_kind: 'snd96',
  bike_slots: JSON.stringify({ Road: 20, _time: '06:00 - 07:00' }), // gather at 06:00, set off at 07:00
});
const sessions = [
  gather('g0', DAY), gather('g1', '2099-04-28', 'closed'), gather('g2', '2099-04-21', 'closed'), gather('g3', '2099-04-14', 'closed'),
  { id: 'c0', day: 'Tuesday', session_date: DAY, capacity: 30, status: 'open', created_at: 2, bike_slots: JSON.stringify({ Road: 20, _time: '20:00 - 23:00' }) }, // the circuit
];
const ksa = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+03:00`).toISOString();
const row = (id: string, sid: string, date: string, qn: number, name: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, session_id: sid, session_day: 'Tuesday', session_date: date, queue_num: qn, name, phone: '', customer_id: null, group_id: null,
  status: 'waiting', paid: true, price: 75, walk_in: true, registered_at: `${date}T00:00:00Z`, height: 175, type_preference: 'Road', ...o,
});
const queue_entries = [
  row('r1', 'g0', DAY, 1, 'Omar Ontime', { status: 'active', checked_in_at: ksa(DAY, '06:05'), checked_in_by: 'Sara' }),
  row('r2', 'g0', DAY, 2, 'Nadia Nine', { status: 'active', checked_in_at: ksa(DAY, '06:09'), checked_in_by: 'Sara' }),
  row('r3', 'g0', DAY, 3, 'Lina Late', { status: 'done', checked_in_at: ksa(DAY, '06:25'), checked_out_at: ksa(DAY, '08:00'), checked_in_by: 'Sara', checked_out_by: 'Sara' }),
  row('r4', 'g0', DAY, 4, 'Habib Habit', { customer_id: 'cust-hab' }), // still to come; twice late before
  row('r5', 'g0', DAY, 5, 'Wael Once', { customer_id: 'cust-one' }), // late once before: no chip
  // the circuit: a rider checks in long after the start, and is not late (riders come any time)
  row('c1', 'c0', DAY, 1, 'Cyrus Circuit', { status: 'active', checked_in_at: ksa(DAY, '21:30') }),
  // Habib's and Wael's earlier rides
  row('h1', 'g1', '2099-04-28', 1, 'Habib Habit', { customer_id: 'cust-hab', status: 'done', checked_in_at: ksa('2099-04-28', '06:20') }),
  row('h2', 'g2', '2099-04-21', 1, 'Habib Habit', { customer_id: 'cust-hab', status: 'done', checked_in_at: ksa('2099-04-21', '06:02') }),
  row('h3', 'g3', '2099-04-14', 1, 'Habib Habit', { customer_id: 'cust-hab', status: 'done', checked_in_at: ksa('2099-04-14', '06:40') }),
  row('w1', 'g1', '2099-04-28', 2, 'Wael Once', { customer_id: 'cust-one', status: 'done', checked_in_at: ksa('2099-04-28', '06:30') }),
  row('w2', 'g2', '2099-04-21', 2, 'Wael Once', { customer_id: 'cust-one', status: 'done', checked_in_at: ksa('2099-04-21', '05:55') }),
];
const customers = [
  { id: 'cust-hab', name: 'Habib Habit', phone: '+966551870001', created_at: '2026-01-01T00:00:00Z' },
  { id: 'cust-one', name: 'Wael Once', phone: '+966551870002', created_at: '2026-01-01T00:00:00Z' },
];

async function boot(page: Page) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { queue_entries, sessions, bikes: [], customers });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length===${queue_entries.length}`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfShowFinished=true;setSfSession('g0')`); // the finished riders unfolded
}
// the roster's row on a desk, its card on a phone
const tr = (page: Page, id: string) => page.locator(`#q-results [data-id="${id}"]`).first();
const shown = (page: Page) => page.locator('#q-results :is(.queue-table tbody tr[data-id], .q-card)');

test.describe('@staff:bookings Late arrivals', () => {
  test('a gathering ride: on time and 9 minutes are not late, 25 minutes is "Late 25 min"; a circuit night never late', async ({ page }) => {
    await boot(page);
    await expect(tr(page, 'r3').locator('.rq-ltr')).toHaveText('Late 25 min');
    await expect(tr(page, 'r1').locator('.rq-ltr')).toHaveCount(0);
    await expect(tr(page, 'r2').locator('.rq-ltr')).toHaveCount(0); // 9 minutes is within the ten
    expect(await page.evaluate("[_ltrMin(_qGet('r1')),_ltrMin(_qGet('r2')),_ltrMin(_qGet('r3')),_ltrMin(_qGet('c1'))]")).toEqual([null, null, 25, null]);
    await page.evaluate("setSfSession('c0')");
    await expect(tr(page, 'c1')).toBeVisible();
    await expect(tr(page, 'c1').locator('.rq-ltr')).toHaveCount(0);
  });

  test('the account record: "2/3 late" from the second late arrival, beside the no-show record; one late shows nothing', async ({ page }) => {
    await boot(page);
    await expect(tr(page, 'r4').locator('.rq-ltrflag')).toHaveText('2/3 late');
    await expect(tr(page, 'r5').locator('.rq-ltrflag')).toHaveCount(0);
    await expect(tr(page, 'r3').locator('.rq-ltrflag')).toHaveCount(0); // no account, no phone: no record
  });

  test('the Late filter in the Filters panel and the status:late operator (Arabic too)', async ({ page }) => {
    await boot(page);
    const opt = page.locator('#tab-queue select.filter-select option[value="late"]');
    await expect(opt).toHaveCount(1);
    await expect(opt).toHaveText('Late');
    await page.evaluate("setSfStatus('late')");
    await expect(shown(page)).toHaveCount(1);
    await expect(tr(page, 'r3')).toBeVisible();
    await expect(page.locator('#tab-queue .f-clr')).toBeVisible(); // a declared filter: counted, and Clear ends it
    await page.locator('#tab-queue .f-clr').click();
    await expect(shown(page)).toHaveCount(5);
    // the operator
    await page.waitForFunction(`typeof _sqParse==='function'`);
    const hits = (q: string) => page.evaluate(`getQueue().filter(e=>_searchHit(e,${JSON.stringify(q)})).map(e=>e.id).sort().join(',')`);
    expect(await hits('status:late')).toBe('h1,h3,r3,w1');
    expect(await hits('حالة:متأخر')).toBe('h1,h3,r3,w1');
    expect(await hits('status:done')).toBe('h1,h2,h3,r3,w1,w2'); // the other statuses unchanged
  });
});
