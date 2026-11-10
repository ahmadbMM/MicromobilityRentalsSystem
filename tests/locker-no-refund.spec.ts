import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Cancel a locker with no refund, and an automatic locker for a reservation made away from the desk (the user, 2026-11-10:
// "add the ability to cancel locker reservation with no refund, whenever a customer books a locker online or not on site
// assign them an automatic locker so it stays reserved for them"; migration 20261111002000). The money and the locker the
// database holds are the database's (staff_locker_cancel p_no_refund, _lk_free_unit); this is what the screens ask for and
// draw. All traffic stubbed; invented data.

const ksaDay = (n = 0) => new Date(Date.now() + 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const TODAY = ksaDay(0);
const noon = (page: Page) => page.clock.setFixedTime(new Date(`${TODAY}T12:00:00+03:00`));
const sessions = [{ id: 's1', day: 'Tuesday', session_date: TODAY, capacity: 40, status: 'open', created_at: 1, lockers: true, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' }];
const customers = [
  { id: 'c1', name: 'Rana Rider', email: 'rana@example.test', phone: '+966500000021', height: 170, created_at: '2026-01-01T00:00:00Z' },
  { id: 'c2', name: 'Omar Other', email: 'omar@example.test', phone: '+966500000022', height: 180, created_at: '2026-01-02T00:00:00Z' },
];
const LINE = [{ id: 'locker', qty: 1, p: 10 }];
const bk = (id: string, n: number, x: Record<string, unknown> = {}) => ({
  id, session_id: 's1', session_day: 'Tuesday', session_date: TODAY, queue_num: n, name: 'Rana Rider', customer_id: 'c1', phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 50, registered_at: '2026-11-09T10:00:00Z', addons: LINE, ...x,
});
const lockers = ['1', '2', '3'].map((c) => ({ id: 'L' + c, code: c, status: 'available', note: '', created_at: '2026-11-09T09:00:00Z' }));
const rent = (id: string, x: Record<string, unknown>) => ({
  id, day: TODAY, period: 'late', booking_id: null, session_id: 's1', customer_id: null, name: '', locker_id: null, price: 10, on_bill: true,
  status: 'reserved', created_at: '2026-11-09T10:00:00Z', created_by: 'rider', pay: null, receipt_id: null, house: false, refunded: 0, till_lines: [], ...x,
});

function calls(page: Page) {
  const seen: { name: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (!m || r.method() !== 'POST') return;
    let body = {}; try { body = r.postDataJSON() || {}; } catch { /* none */ }
    seen.push({ name: m[1], body });
  });
  return seen;
}
const sent = (seen: { name: string; body: Record<string, unknown> }[], name: string) => seen.find((c) => c.name === name)?.body;
async function staff(page: Page, fx: Fixtures = {}) {
  const ops = [{ name: 'Spec Staff', has_pin: false }];
  await stubSupabase(page, { sessions, customers, tags: [], customer_tags: [], bikes: [], staff_options: [],
    'rpc:staff_operator_list': ops, lockers, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded&&(S.customers||[]).length>0');
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S.staffRole='admin';`);
}
const reservations = async (page: Page) => { await page.evaluate(`setStaffTab('lockers');_lkView('reservations')`); };
const cancelQ = (page: Page) => page.getByRole('dialog', { name: 'Cancel this locker?' });

test.describe('@staff:lockers cancel with no refund', () => {
  test('a paid ride\'s locker asks where the money goes, Give the money back first; No refund sends p_no_refund and says so', async ({ page }) => {
    const seen = calls(page);
    await staff(page, {
      queue_entries: [bk('q1', 1, { paid: true, pay_method: 'cash' })],
      locker_rentals: [rent('R1', { booking_id: 'q1', customer_id: 'c1', name: 'Rana Rider', locker_id: 'L1', status: 'in_use' })],
      'rpc:staff_locker_cancel': { ok: true, kept: true, booking_id: 'q1', addons: LINE },
    });
    await reservations(page);
    await page.locator('#tab-lockers .lk-res-row', { hasText: 'Rana Rider' }).getByRole('button', { name: 'Cancel locker' }).click();
    const q = cancelQ(page);
    const back = q.getByRole('radio', { name: /Give the money back/ }), keep = q.getByRole('radio', { name: /No refund/ });
    await expect(back).toHaveAttribute('aria-checked', 'true');
    await expect(back).toContainText('Its fee comes off the booking.');
    await expect(keep).toHaveAttribute('aria-checked', 'false');
    await expect(keep).toContainText('The locker is freed and the');
    await keep.click();
    await expect(keep).toHaveAttribute('aria-checked', 'true');
    await expect(back).toHaveAttribute('aria-checked', 'false');
    await q.getByRole('button', { name: 'Cancel locker' }).click();
    await expect.poll(() => sent(seen, 'staff_locker_cancel')).toBeTruthy();
    expect(sent(seen, 'staff_locker_cancel')).toEqual({ p_rental: 'R1', p_reason: 'staff', p_undo: false, p_no_refund: true });
    await expect(page.locator('.toast', { hasText: 'Locker cancelled, no refund' })).toBeVisible(); // money: shown, not only heard
  });

  test('Give the money back (the first choice) sends the call as before', async ({ page }) => {
    const seen = calls(page);
    const paid = rent('R6', { customer_id: 'c2', name: 'Omar Other', locker_id: 'L2', on_bill: false, created_by: 'page', pay: 'wallet', receipt_id: 'lk-r6' });
    await staff(page, { queue_entries: [], locker_rentals: [paid], 'rpc:staff_locker_cancel': { ok: true, kept: false } });
    await reservations(page);
    await page.locator('#tab-lockers .lk-res-row', { hasText: 'Omar Other' }).getByRole('button', { name: 'Cancel locker' }).click();
    const q = cancelQ(page);
    await expect(q.getByRole('radio', { name: /Give the money back/ })).toContainText('The money goes back to their wallet.');
    await q.getByRole('button', { name: 'Cancel locker' }).click();
    await expect.poll(() => sent(seen, 'staff_locker_cancel')).toBeTruthy();
    expect(sent(seen, 'staff_locker_cancel')).toEqual({ p_rental: 'R6', p_reason: 'staff', p_undo: false });
    await expect(page.locator('.toast', { hasText: 'Locker cancelled' })).toHaveCount(1);
    await expect(page.locator('.toast', { hasText: 'no refund' })).toHaveCount(0);
  });

  test('a locker nothing was paid for asks no question about money', async ({ page }) => {
    await staff(page, {
      queue_entries: [bk('q2', 2, { name: 'Omar Other', customer_id: 'c2' })],
      locker_rentals: [rent('R2', { booking_id: 'q2', customer_id: 'c2', name: 'Omar Other', period: 'early' })],
    });
    await reservations(page);
    await page.locator('#tab-lockers .lk-res-row', { hasText: 'Omar Other' }).getByRole('button', { name: 'Cancel locker' }).click();
    const q = cancelQ(page);
    await expect(q).toContainText('Its fee comes off the booking.');
    await expect(q.getByRole('radio')).toHaveCount(0);
  });

  test('a till sale says it is refunded at the till; a locker on the house asks nothing', async ({ page }) => {
    const till = rent('R7', { customer_id: 'c2', name: 'Omar Other', locker_id: 'L2', on_bill: false, created_by: 'Spec Staff', pay: 'desk', till_lines: ['line-1'] });
    const free = rent('R8', { customer_id: 'c1', name: 'Rana Rider', locker_id: 'L3', on_bill: false, created_by: 'Spec Staff', pay: 'desk', house: true, price: 0 });
    await staff(page, { queue_entries: [], locker_rentals: [till, free] });
    await reservations(page);
    await page.locator('#tab-lockers .lk-res-row', { hasText: 'Omar Other' }).getByRole('button', { name: 'Cancel locker' }).click();
    await expect(cancelQ(page).getByRole('radio', { name: /Give the money back/ })).toContainText('Refund the sale at the Sales till.');
    await cancelQ(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('#tab-lockers .lk-res-row', { hasText: 'Rana Rider' }).getByRole('button', { name: 'Cancel locker' }).click();
    await expect(cancelQ(page).getByRole('radio')).toHaveCount(0);
  });

  test('a locker cancelled with no refund reads so in the reservations and the history, and its money counts in the report', async ({ page }) => {
    const kept = rent('R9', { customer_id: 'c2', name: 'Omar Other', locker_id: null, on_bill: false, created_by: 'page', pay: 'wallet', receipt_id: 'lk-r9',
      status: 'cancelled', cancel_reason: 'staff (no refund)', kept: true });
    const back = rent('R10', { customer_id: 'c1', name: 'Rana Rider', on_bill: false, created_by: 'page', pay: 'wallet', receipt_id: 'lk-r10',
      status: 'cancelled', cancel_reason: 'staff', price: 15, period: 'both' });
    await staff(page, { queue_entries: [], locker_rentals: [kept, back] });
    await reservations(page);
    await page.locator('#tab-lockers .lk-res-f').getByRole('button', { name: /^Cancelled/ }).click();
    await expect(page.locator('#tab-lockers .lk-res-row', { hasText: 'Omar Other' }).locator('.lk-res-st')).toHaveText('Cancelled · No refund');
    await expect(page.locator('#tab-lockers .lk-res-row', { hasText: 'Rana Rider' }).locator('.lk-res-st')).toHaveText('Cancelled');
    // the history reads without the kept column: the reason says it
    await page.evaluate(`S._lkH={rows:${JSON.stringify([{ ...kept, kept: undefined }, back])},at:Date.now(),busy:false,err:false};setStaffTab('lockers');_lkView('history')`);
    await expect(page.locator('#tab-lockers .lk-res-row', { hasText: 'Omar Other' }).locator('.lk-res-st')).toContainText('Cancelled · No refund');
    // the report: the kept 10 is money taken, the refunded 15 is not
    const rev = await page.evaluate(`(()=>{const R=_lkRpState();R.rows=${JSON.stringify([kept, back])};return _lkRpCalc().tot.rev;})()`);
    expect(rev).toBe(10);
  });
});

test.describe('@customer:lockers an automatic locker on the review', () => {
  const offer = { kind: 'jcc', one: 10, both: 15, left: { total: 18, early: 17, late: 17, both: 17, pm: 17 }, ended: { early: false, late: false, both: false, pm: false } };
  const board = { day: TODAY, kind: 'jcc', one: 10, both: 15, left: offer.left, ended: offer.ended,
    units: Array.from({ length: 18 }, (_, i) => ({ code: String(i + 1), out: false })), taken: { e: [], l: [] } };
  async function rider(page: Page, fx: Fixtures) {
    await stubSupabase(page, { sessions, queue_entries: [], 'rpc:customer_locker_offer': offer, 'rpc:locker_board': board, ...fx });
    await page.addInitScript(() => {
      localStorage.setItem('cq_session', JSON.stringify({ id: 'c1', name: 'Rana Rider', email: 'rana@example.test', phone: '+966500000021', height: 170, session_token: 'tok' }));
    });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`_lkOfferLoad('s1',true);_lkBoardLoad('${TODAY}',true)`);
    await page.waitForFunction(`!!_lkOffer('s1')&&!!_lkBoard('${TODAY}')`);
  }

  test('a picked door taken in the last moments: reserved again with none picked, and the rider is told the locker held for them', async ({ page }) => {
    await noon(page);
    const seen = calls(page);
    await rider(page, {});
    // the database: the picked door refused as taken; with none picked, it holds a free one (door 4)
    await page.route('**/rest/v1/rpc/customer_locker_reserve', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      const body = req.postDataJSON() || {};
      const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
      if (body.p_codes) return route.fulfill({ status: 400, headers: head, body: JSON.stringify({ code: 'P0001', message: 'LOCKER_TAKEN: 7', details: null, hint: null }) });
      return route.fulfill({ status: 200, headers: head, body: JSON.stringify({ ok: true, lockers: [{ booking_id: 'q1', code: '4' }], rows: [] }) });
    });
    await page.evaluate(`(async()=>{S.regQty=1;S.regLocker='late';S.regLockerCodes=['7'];await _lkAfterBook([{id:'q1',status:'waiting'}],_sessGet('s1'),false);})()`);
    await expect.poll(() => seen.filter((c) => c.name === 'customer_locker_reserve').length).toBe(2);
    const [first, again] = seen.filter((c) => c.name === 'customer_locker_reserve').map((c) => c.body);
    expect(first).toEqual({ p_id: 'c1', p_token: 'tok', p_booking_ids: ['q1'], p_period: 'late', p_codes: ['7'] });
    expect(again).toEqual({ p_id: 'c1', p_token: 'tok', p_booking_ids: ['q1'], p_period: 'late' });
    await expect(page.locator('.toast', { hasText: 'That locker was just taken, so locker 4 is reserved for you instead.' })).toBeVisible();
  });

  test('any other refusal is said as before and not tried again', async ({ page }) => {
    await noon(page);
    const seen = calls(page);
    await rider(page, { 'rpc:customer_locker_reserve': { __rpcError: { status: 400, code: 'P0001', message: 'LOCKERS_FULL' } } });
    await page.evaluate(`(async()=>{S.regQty=1;S.regLocker='late';S.regLockerCodes=['7'];await _lkAfterBook([{id:'q1',status:'waiting'}],_sessGet('s1'),false);})()`);
    await expect(page.locator('.toast', { hasText: 'The lockers for that time are all taken.' })).toBeVisible();
    expect(seen.filter((c) => c.name === 'customer_locker_reserve').length).toBe(1);
  });
});
