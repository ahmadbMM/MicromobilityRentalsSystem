import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The app side of migration 20260928200000 (staff guardrails). The keypad's right answer is an
// approval token the server issued (staff_pin_approve); voids, refunds, price changes and the two
// deletes go through their RPCs with the operator's name and that token, so the PIN is checked
// where it cannot be skipped; a sale the server holds as voided is kept out of every list; and a
// database before the RPCs (the stub's default for them) takes the plain writes as before.
const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
const sale = { id: 'sale1', receipt_id: 'r1', session_id: 's0', item_id: 'it1', name: 'Water', qty: 1, price: 5, pay: 'paid', category: 'drinks', created_at: '2099-02-10T18:00:00Z', customer_name: 'Buyer' };
const voided = { ...sale, id: 'sale2', receipt_id: 'r2', voided_at: '2099-02-10T19:00:00Z', voided_by: 'Spec Staff' };
const row = { id: 'q1', session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: 1, name: 'Rider One', phone: '0500000001', status: 'waiting', paid: false, price: 115, type_preference: 'Road', registered_at: '2099-01-01T10:00:00Z' };
const bike = { id: 'b1', name: 'Road 01', type: 'Road', size: 'M', status: 'available' };
const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, ...extra });
const err = (code: string, message: string) => ({ __rpcError: { status: 400, code, message } });

async function boot(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [row], bikes: [bike], cashier_sales: [sale, voided], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`localStorage.setItem('cq_op_name','Spec Staff');confirmDialog=(o)=>o.onConfirm&&o.onConfirm();S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();`);
}
type Call = { name: string; body: Record<string, unknown> };
const rpcs = (page: Page) => {
  const calls: Call[] = [];
  page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (m) { let body = {}; try { body = r.postDataJSON(); } catch { /* none */ } calls.push({ name: m[1], body }); } });
  return calls;
};
const tableWrites = (page: Page, table: string) => {
  const out: string[] = [];
  page.on('request', (r) => { if (['PATCH', 'POST', 'DELETE'].includes(r.method()) && r.url().includes(`/rest/v1/${table}`)) out.push(r.method()); });
  return out;
};

test('a sale the server holds as voided is not in the ledger', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(`S.cashSales.map(r=>r.id).sort()`)).toEqual(['sale1']);
});

test('the keypad hands the approval token on, and the RPC calls carry it with the operator', async ({ page }) => {
  await boot(page, { 'rpc:staff_pin_approve': ok({ required: true, token: 'tok-1', expires_at: '2099-02-10T18:05:00Z' }), 'rpc:staff_set_price': ok({ id: 'q1', old_price: 115, price: 90 }) });
  const calls = rpcs(page);
  const patches = tableWrites(page, 'queue_entries');
  await page.evaluate(`S._opPins=[{name:'Spec Staff',has_pin:true}];S._opPinsAt=Date.now();window.__ans=undefined;_pinApprove('Price').then(v=>{window.__ans=v;});0`);
  await expect(page.locator('#op-gate-modal .op-gate')).toBeVisible();
  await page.evaluate(`_opgKey('1');_opgKey('2');_opgKey('3');_opgKey('4')`);
  await expect.poll(() => page.evaluate('window.__ans')).toBe(true);
  expect(calls.map((c) => c.name)).toEqual(['staff_pin_approve']);
  expect(calls[0].body).toMatchObject({ p_name: 'Spec Staff', p_pin: '1234' });
  expect(await page.evaluate(`_pinOk.token`)).toBe('tok-1');
  expect(await page.evaluate(`_pinArgs()`)).toEqual({ p_op: 'Spec Staff', p_approval: 'tok-1' });
  // the price goes through staff_set_price with the token; nothing is written to the table
  await page.evaluate(`saveEditedPrice('q1',90)`);
  await expect.poll(() => calls.filter((c) => c.name === 'staff_set_price').length).toBe(1);
  expect(calls.find((c) => c.name === 'staff_set_price')!.body).toMatchObject({ p_booking_id: 'q1', p_price: 90, p_op: 'Spec Staff', p_approval: 'tok-1' });
  await page.waitForTimeout(200);
  expect(patches).toEqual([]);
});

test('PIN_REQUIRED from the server asks the keypad again and repeats the call with the new token', async ({ page }) => {
  await boot(page, { 'rpc:staff_pin_approve': ok({ required: true, token: 'tok-2' }) });
  let n = 0;
  await page.route(/\/rest\/v1\/rpc\/staff_set_price/, (r) => {
    n++;
    if (n === 1) return r.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '42501', message: 'PIN_REQUIRED', details: null, hint: null }) });
    return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, id: 'q1', old_price: 115, price: 80 }) });
  });
  const calls = rpcs(page);
  await page.evaluate(`_pinOk={name:'Spec Staff',at:Date.now(),token:'stale'};S._opPins=[{name:'Spec Staff',has_pin:true}];S._opPinsAt=Date.now();saveEditedPrice('q1',80);0`);
  await expect(page.locator('#op-gate-modal .op-gate')).toBeVisible();      // the stale token was refused: the keypad
  await page.evaluate(`_opgKey('1');_opgKey('2');_opgKey('3');_opgKey('4')`);
  await expect.poll(() => calls.filter((c) => c.name === 'staff_set_price').length).toBe(2);
  const [first, second] = calls.filter((c) => c.name === 'staff_set_price');
  expect(first.body.p_approval).toBe('stale');
  expect(second.body.p_approval).toBe('tok-2');
});

test('a void goes through staff_void_receipt: the rows leave this ledger, nothing is deleted from the table', async ({ page }) => {
  await boot(page, { 'rpc:staff_void_receipt': ok({ receipt_id: 'r1', count: 1, items: [{ id: 'sale1', item_id: 'it1', qty: 1, pay: 'paid' }] }) });
  const calls = rpcs(page);
  const writes = tableWrites(page, 'cashier_sales');
  await page.evaluate(`setStaffTab('cashier')`);
  await page.evaluate(`_ctVoidReceipt('r1')`);
  await expect.poll(() => calls.filter((c) => c.name === 'staff_void_receipt').length).toBe(1);
  expect(calls.find((c) => c.name === 'staff_void_receipt')!.body).toMatchObject({ p_receipt_id: 'r1', p_op: 'Spec Staff', p_approval: null });
  await expect.poll(() => page.evaluate(`S.cashSales.some(r=>r.id==='sale1')`)).toBe(false);
  await page.waitForTimeout(200);
  expect(writes).toEqual([]);
  expect(await page.evaluate(`_voidedIds().includes('sale1')`)).toBe(true);   // never resurrected by a stale read
});

test('a database before the RPC voids the old way: the DELETE goes out', async ({ page }) => {
  await boot(page);
  const writes = tableWrites(page, 'cashier_sales');
  await page.evaluate(`setStaffTab('cashier')`);
  await page.evaluate(`_ctVoidReceipt('r1')`);
  await expect.poll(() => writes.filter((w) => w === 'DELETE').length).toBe(1);
});

test('a refund goes through staff_refund_receipt and marks the rows refunded here', async ({ page }) => {
  await boot(page, { 'rpc:staff_refund_receipt': ok({ receipt_id: 'r1', count: 1, items: [{ id: 'sale1', item_id: 'it1', qty: 1 }] }) });
  const calls = rpcs(page);
  const writes = tableWrites(page, 'cashier_sales');
  await page.evaluate(`setStaffTab('cashier')`);
  await page.evaluate(`_ctRefundReceipt('r1')`);
  await expect.poll(() => calls.filter((c) => c.name === 'staff_refund_receipt').length).toBe(1);
  expect(calls.find((c) => c.name === 'staff_refund_receipt')!.body).toMatchObject({ p_receipt_id: 'r1', p_op: 'Spec Staff' });
  await expect.poll(() => page.evaluate(`(S.cashSales.find(r=>r.id==='sale1')||{}).pay`)).toBe('refunded');
  expect(await page.evaluate(`!!(S.cashSales.find(r=>r.id==='sale1')||{}).refunded_at`)).toBe(true);
  await page.waitForTimeout(200);
  expect(writes).toEqual([]);
});

test('the server refuses a delete by name, and the desk reads the reason in its own words', async ({ page }) => {
  await boot(page, { 'rpc:staff_delete_session': err('55000', 'HAS_BOOKINGS'), 'rpc:staff_delete_bike': err('55000', 'BIKE_HAS_HISTORY') });
  await page.evaluate(`S.staffRole='admin'`);
  const sessPatches = tableWrites(page, 'sessions');
  const bikeWrites = tableWrites(page, 'bikes');
  await page.evaluate(`S.queue=[];S.cashSales=[];deleteSession('s0')`);           // the client's own counts pass; the server's do not
  await expect(page.locator('#err-bar-el')).toContainText('Cannot delete a session with existing bookings');
  await page.evaluate(`delBike('b1')`);
  await expect(page.locator('#err-bar-el')).toContainText('handed out before');
  // the refusal is in the desk's words; the code stands beside it as the detail
  await page.waitForTimeout(200);
  expect(sessPatches).toEqual([]);
  expect(bikeWrites).toEqual([]);
});

test('a delete the server accepts is done through the RPC alone', async ({ page }) => {
  await boot(page, { 'rpc:staff_delete_session': ok({ id: 's0', status: 'deleted', previous_status: 'open' }), 'rpc:staff_delete_bike': ok({ id: 'b1', name: 'Road 01' }) });
  await page.evaluate(`S.staffRole='admin'`);
  const calls = rpcs(page);
  const sessPatches = tableWrites(page, 'sessions');
  const bikeWrites = tableWrites(page, 'bikes');
  await page.evaluate(`S.queue=[];S.cashSales=[];deleteSession('s0')`);
  await expect.poll(() => calls.filter((c) => c.name === 'staff_delete_session').length).toBe(1);
  expect(calls.find((c) => c.name === 'staff_delete_session')!.body).toMatchObject({ p_id: 's0', p_op: 'Spec Staff' });
  await page.evaluate(`delBike('b1')`);
  await expect.poll(() => calls.filter((c) => c.name === 'staff_delete_bike').length).toBe(1);
  expect(calls.find((c) => c.name === 'staff_delete_bike')!.body).toMatchObject({ p_id: 'b1', p_op: 'Spec Staff' });
  await page.waitForTimeout(200);
  expect(sessPatches).toEqual([]);
  expect(bikeWrites).toEqual([]);
});

test('an offline void waits in the sales outbox and is sent as the RPC when the connection returns', async ({ page }) => {
  await boot(page, { 'rpc:staff_void_receipt': ok({ receipt_id: 'r1', count: 1, items: [] }) });
  const calls = rpcs(page);
  await page.evaluate(`setStaffTab('cashier')`);
  // the network is down for the RPC: the call fails as the network does
  await page.route(/\/rest\/v1\/rpc\/staff_void_receipt/, (r) => r.abort('internetdisconnected'));
  await page.evaluate(`_ctVoidReceipt('r1')`);
  await expect.poll(() => page.evaluate(`_outbox().filter(o=>o.kind==='void').length`)).toBe(1);
  expect(await page.evaluate(`S.cashSales.some(r=>r.id==='sale1')`)).toBe(false);
  // the replay keeps it off the ledger after a read, and the flush sends the RPC
  expect(await page.evaluate(`(()=>{S.cashSales=[${JSON.stringify(sale)}];_outboxReplay();return S.cashSales.length;})()`)).toBe(0);
  await page.unroute(/\/rest\/v1\/rpc\/staff_void_receipt/);
  await page.evaluate(`_outboxFlush()`);
  await expect.poll(() => calls.filter((c) => c.name === 'staff_void_receipt').length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(`_outbox().length`)).toBe(0);
});
