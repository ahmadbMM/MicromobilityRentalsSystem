import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff website round s10 ("writes", 2026-11-10):
// - item 1: bulk check-in, bulk return and the close-out go in one call each (staff_bulk_checkin, staff_bulk_return,
//   staff_close_out) answering one result per rider, every refusal said; without the functions the writes go at most
//   three at a time (_saveLane), not all at once.
// - item 2: a rider going to the end of the waitlist is sent with no W number (the server gives it).
// - item 3: one-row actions read the rows they moved again, not the whole window (no cashier_sales read).
// - item 5: walk-in, the waitlist moves and Customer showed wait in the desk outbox when offline.
// - item 9: a walk-in for one rider takes one dialog: the payment and Check in are in the form.
// - item 11: the walk-in's stock hint says nothing when the fleet holds no bike of that type.
// - item 13: No-show from the menu asks only when it moves a rider up from the waitlist or frees a locker.
// Invented riders only. The clock is fixed on the evening of the night, before its 23:00 end.

type Row = Record<string, unknown>;
const DAY = '2099-05-05';
const night = (x: Row = {}): Row => ({ id: DAY, session_date: DAY, day: 'Tuesday', status: 'open', capacity: 10, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":10}', ...x });
const row = (id: string, num: number, status: string, x: Row = {}): Row => ({
  id, session_id: DAY, session_day: 'Tuesday', session_date: DAY, queue_num: num, name: 'Rider ' + id.toUpperCase(),
  phone: '', customer_id: null, group_id: null, status, paid: false, price: 75, walk_in: true,
  registered_at: `2020-01-01T10:0${num}:00Z`, type_preference: 'Road', size: 'M', ...x,
});

async function desk(page: Page, fx: Row = {}) {
  await page.clock.setFixedTime(new Date(`${DAY}T20:00:00+03:00`));
  await stubSupabase(page, { sessions: [night()], bikes: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.staffTab='queue';S.queueView='bookings';S.sfSession='${DAY}';S.sfStatus='all';renderStaffQueue()`);
}
const calls = (page: Page, re: RegExp, method = 'POST') => {
  const out: { url: string; body: unknown }[] = [];
  page.on('request', (r) => { if (r.method() === method && re.test(r.url())) { let b: unknown = null; try { b = r.postDataJSON(); } catch { /* none */ } out.push({ url: r.url(), body: b }); } });
  return out;
};
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('bulk check-in goes in one staff_bulk_checkin and says each refused rider on its row', async ({ page }) => {
  const rows = [row('w1', 1, 'waiting'), row('w2', 2, 'waiting'), row('w3', 3, 'waiting')];
  await desk(page, { queue_entries: rows });
  await page.route(/rest\/v1\/rpc\/staff_bulk_checkin/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    rows[0].status = 'active'; rows[2].status = 'active';                     // as the server now reads them
    return json(route, [
      { id: 'w1', ok: true, r: { ok: true, noop: false, bikes: [] } },
      { id: 'w2', ok: false, code: 'P0001', message: 'NOT_APPROVED: #2 is not approved for this session yet' },
      { id: 'w3', ok: true, r: { ok: true, noop: false, bikes: [] } },
    ]);
  });
  const many = calls(page, /rpc\/staff_bulk_checkin/), one = calls(page, /rpc\/staff_checkin(\?|$)/);
  await page.evaluate(`S.sfSelected=['w1','w2','w3'];bulkSfCheckin()`);
  await expect.poll(() => many.length).toBe(1);
  const sent = many[0].body as { p_ids: string[]; p_ops: string[] };
  expect(sent.p_ids).toEqual(['w1', 'w2', 'w3']);
  expect(sent.p_ops).toHaveLength(3);                                         // each rider's op id, made on the desk
  await expect.poll(() => page.evaluate(`['w1','w2','w3'].map(id=>_qGet(id).status).join()`)).toBe('active,waiting,active');
  await expect(page.locator('.rq-err').first()).toBeVisible();               // the refusal on its row
  expect(one.length).toBe(0);                                                 // no write per rider beside it
});

test('without the one-call functions a bulk check-in sends at most three at a time', async ({ page }) => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  await desk(page, { queue_entries: ids.map((id, i) => row(id, i + 1, 'waiting')) });
  let now = 0, max = 0, n = 0;
  await page.route(/rest\/v1\/rpc\/staff_checkin(\?|$)/, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    now++; n++; max = Math.max(max, now);
    await new Promise((r) => setTimeout(r, 250));
    now--;
    return json(route, { ok: true, noop: false, bikes: [] });
  });
  await page.evaluate(`S.sfSelected=${JSON.stringify(ids)};bulkSfCheckin()`);
  await expect.poll(() => n, { timeout: 10000 }).toBe(7);
  expect(max).toBeLessThanOrEqual(3);
  expect(max).toBeGreaterThan(1);
});

test('bulk return goes in one staff_bulk_return, the payment in it', async ({ page }) => {
  const rows = [row('r1', 1, 'active', { checked_in_at: `${DAY}T16:00:00Z` }), row('r2', 2, 'active', { paid: true })];
  await desk(page, { queue_entries: rows });
  await page.route(/rest\/v1\/rpc\/staff_bulk_return/, (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    rows.forEach((r) => { r.status = 'done'; });
    return json(route, [{ id: 'r1', ok: true, r: { ok: true, noop: false, bikes_freed: 0 } }, { id: 'r2', ok: true, r: { ok: true, noop: false, bikes_freed: 0 } }]);
  });
  const many = calls(page, /rpc\/staff_bulk_return/), one = calls(page, /rpc\/staff_return(\?|$)/), pats = calls(page, /rest\/v1\/queue_entries/, 'PATCH');
  await page.evaluate(`_bulkReturnRun([{id:'r1',cond:'ok',notes:null,paid:true},{id:'r2',cond:'needs_check',notes:'brake',paid:false}])`);
  await expect.poll(() => many.length).toBe(1);
  const sent = (many[0].body as { p_rows: Row[] }).p_rows;
  expect(sent[0]).toMatchObject({ id: 'r1', cond: 'ok', paid: true, mins: 60 });
  expect(sent[1]).toMatchObject({ id: 'r2', cond: 'needs_check', notes: 'brake', paid: false });
  await expect.poll(() => page.evaluate(`['r1','r2'].map(id=>_qGet(id).status).join()`)).toBe('done,done');
  expect(one.length).toBe(0);
  expect(pats.length).toBe(0);                                                // the payment and the ride time were in the call
});

test('the close-out is one staff_close_out and names every rider it could not settle', async ({ page }) => {
  await desk(page, {
    queue_entries: [
      row('o1', 1, 'active'), row('o2', 2, 'active'),
      row('d1', 3, 'waiting', { checked_in_at: `${DAY}T17:00:00Z` }), row('n1', 4, 'waiting'), row('n2', 5, 'waiting'),
    ],
    'rpc:staff_close_out': [
      { id: 'o1', k: 'return', ok: true, r: { ok: true, noop: false, bikes_freed: 0 } },
      { id: 'o2', k: 'return', ok: false, code: 'P0001', message: 'BAD_BOOKING_STATE: #2 is done, not on a bike' },
      { id: 'd1', k: 'done', ok: true },
      { id: 'n1', k: 'noshow', ok: true },
      { id: 'n2', k: 'noshow', ok: false, lost: true, status: 'active' },
    ],
  });
  const co = calls(page, /rpc\/staff_close_out/), ret = calls(page, /rpc\/staff_return(\?|$)/);
  await page.evaluate(`closeOutSession('${DAY}')`);
  await page.locator('#confirm-modal .chrome-dact button').last().click();
  await expect.poll(() => co.length).toBe(1);
  expect(co[0].body).toMatchObject({ p_session_id: DAY, p_done: ['d1'], p_noshow: ['n1', 'n2'] });
  expect((co[0].body as { p_returns: Row[] }).p_returns.map((x) => x.id)).toEqual(['o1', 'o2']);
  const bar = page.locator('#err-bar-el');
  await expect(bar).toContainText('Rider O2');                                // every one, not the first only
  await expect(bar).toContainText('Rider N2');
  expect(ret.length).toBe(0);
});

test('To waitlist sends no W number, paints first, and reads only that row again', async ({ page }) => {
  const rows = [row('w1', 1, 'waiting'), row('l1', 2, 'waitlist', { waitlist_num: 4 })];
  await desk(page, { queue_entries: rows });
  let release: () => void = () => {};
  const held = new Promise<void>((r) => { release = r; });
  const pats: Row[] = [];
  await page.route(/rest\/v1\/queue_entries/, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    pats.push(route.request().postDataJSON());
    await held;
    Object.assign(rows[0], { status: 'waitlist', waitlist_num: 7 });           // what the server's trigger gave
    return json(route, [{ id: 'w1', waitlist_num: 7, queue_num: 1 }]);
  });
  const sales = calls(page, /rest\/v1\/cashier_sales/, 'GET');
  await page.evaluate(`staffToWaitlist('w1');0`);
  await expect.poll(() => pats.length).toBe(1);
  expect(pats[0]).toMatchObject({ status: 'waitlist', waitlist_num: null });
  expect(await page.evaluate(`_qGet('w1').status`)).toBe('waitlist');         // painted before the answer
  release();
  await expect.poll(() => page.evaluate(`_qGet('w1').waitlistNum`)).toBe(7);  // the server's number
  await page.waitForTimeout(300);
  expect(sales.length).toBe(0);                                               // no whole-window reload
});

test('offline, a walk-in and a move wait in the desk outbox and go once the connection is back', async ({ page }) => {
  await desk(page, { queue_entries: [row('w1', 1, 'waiting')] });
  await page.evaluate(`window.__off=true;Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>!window.__off})`);
  const ins = calls(page, /rest\/v1\/queue_entries/), pats = calls(page, /rest\/v1\/queue_entries/, 'PATCH');
  await page.evaluate(`showWalkinModal()`);
  await page.locator('#wi-name').fill('Walk Off');
  await page.locator('#walkin-modal [data-wi-type="Road"]').click();
  await page.locator('#walkin-modal .modal-footer button', { hasText: 'Add walk-in' }).click();
  await expect.poll(() => page.evaluate(`_DQ.map(o=>o.kind).join()`)).toBe('walkin');
  await page.evaluate(`staffToWaitlist('w1');0`);
  await expect.poll(() => page.evaluate(`_DQ.map(o=>o.kind).join()`)).toBe('walkin,move');
  expect(await page.evaluate(`getQueue().some(e=>e.name==='Walk Off')`)).toBe(true); // on the roster while it waits
  expect(await page.evaluate(`_qGet('w1').status`)).toBe('waitlist');
  expect(ins.length + pats.length).toBe(0);
  await page.evaluate(`window.__off=false;S._netDown=false;_dqFlush()`);
  await expect.poll(() => page.evaluate(`_DQ.length`)).toBe(0);
  expect(ins.length).toBe(1);
  expect((ins[0].body as Row[])[0]).toMatchObject({ name: 'Walk Off', status: 'waiting' });
  expect(pats.length).toBe(1);
  expect(pats[0].url).toContain('status=eq.waiting');                         // guarded on the status it left
  expect(pats[0].body).toMatchObject({ status: 'waitlist', waitlist_num: null });
});

test('Customer showed waits in the desk outbox offline', async ({ page }) => {
  await desk(page, { queue_entries: [row('n1', 1, 'noshow')] });
  await page.evaluate(`window.__off=true;Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>!window.__off})`);
  await page.evaluate(`doUndoNoShow('n1');0`);
  await expect.poll(() => page.evaluate(`_DQ.map(o=>o.kind+':'+o.was).join()`)).toBe('move:noshow');
  expect(await page.evaluate(`_qGet('n1').status`)).toBe('waiting');
});

test('a walk-in for one rider is one dialog: payment and Check in in the form; a party keeps Add & check in', async ({ page }) => {
  const rows = [row('w1', 1, 'waiting')];
  await desk(page, { queue_entries: rows });
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/queue_entries')) { const b = r.postDataJSON(); rows.push(...(Array.isArray(b) ? b : [b])); } });
  const ci = calls(page, /rpc\/staff_checkin(\?|$)/);
  await page.evaluate(`showWalkinModal()`);
  const form = page.locator('#walkin-modal');
  await page.locator('#wi-name').fill('Walk Up');
  await form.locator('[data-wi-type="Road"]').click();
  await expect(form.locator('[data-wi-pay="card"]')).toHaveAttribute('aria-pressed', 'true'); // Paid to begin with
  await form.locator('[data-wi-pay="pending"]').click();
  await expect(form.locator('[data-wi-pay="pending"]')).toHaveAttribute('aria-pressed', 'true');
  await form.locator('[data-wi-pay="card"]').click();
  await form.locator('.modal-footer .btn-primary', { hasText: 'Check in' }).click();
  await expect.poll(() => ci.length).toBe(1);
  expect(ci[0].body).toMatchObject({ p_paid: true, p_pay_method: 'card' });
  await expect(page.locator('#checkin-modal .modal-box')).toHaveCount(0);   // no second dialog
  await expect.poll(() => page.evaluate(`(getQueue().find(e=>e.name==='Walk Up')||{}).status`)).toBe('active');
  // two riders: the payment is each rider's, in the check-in that follows
  await page.evaluate(`showWalkinModal();_wiAddRider()`);
  await expect(form.locator('[data-wi-pay]')).toHaveCount(0);
  await expect(form.locator('.modal-footer .btn-primary')).toHaveText('Add & check in');
});

test('the stock hint says nothing for a type the fleet does not hold', async ({ page }) => {
  await desk(page, { queue_entries: [], bikes: [{ id: 'h1', name: 'Hybrid 1', bike_number: 1, type: 'Hybrid', size: 'M', status: 'available' }] });
  await page.evaluate(`showWalkinModal()`);
  await page.locator('#walkin-modal [data-wi-type="Road"]').click();
  await expect(page.locator('#wi-stock-hint')).toHaveText('');
  await page.locator('#walkin-modal [data-wi-type="Hybrid"]').click();
  await expect(page.locator('#wi-stock-hint')).not.toHaveText('');
});

test('No-show from the menu asks only when it moves a rider up or frees a locker', async ({ page }) => {
  await desk(page, {
    sessions: [night({ capacity: 2 })],
    queue_entries: [row('w1', 1, 'waiting'), row('w2', 2, 'waiting'), row('l1', 3, 'waitlist', { waitlist_num: 1, name: 'Sara Wait' })],
  });
  const pats = calls(page, /rest\/v1\/queue_entries/, 'PATCH');
  await page.evaluate(`confirmNoShow('w1');0`);
  const box = page.locator('#confirm-modal .confirm-box');
  await expect(box).toBeVisible();
  await expect(box).toContainText('Mark #1 Rider W1 as a no-show?');
  await expect(box).toContainText('Sara Wait moves up from the waitlist.');
  await expect(box.locator('.chrome-dact button').last()).toHaveText(/^No-show$/i);
  expect(pats.length).toBe(0);
  await box.locator('.chrome-dact button').first().click();                  // Cancel: nothing written
  await page.waitForTimeout(200);
  expect(pats.length).toBe(0);
  // nobody left on the waitlist: one tap
  await page.evaluate(`S.queue=getQueue().filter(e=>e.id!=='l1');confirmNoShow('w2');0`);
  await expect.poll(() => pats.some((p) => (p.body as Row).status === 'noshow')).toBe(true);
  await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
});
