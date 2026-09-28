import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The desk's flow after the 2026-09-28 staff review: a return is one sheet (condition and, for a
// rider still owing, the payment); Confirm on the check-in modal says what it records; a walk-up
// is added and checked in in one go; a checked-in rider without a bike reads "Needs bike"; the
// roster's stat chips filter and clear, and carry the night's Close out with what is still owed;
// bulk payment and bulk check-in can be undone; On the house asks the PIN; a till item is one tap.
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const D = today;
const sessions = [{ id: D, day: 'Tuesday', session_date: D, capacity: 40, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 40 }) }];
const bikes = [
  { id: 'b1', name: 'Road 01', type: 'Road', size: 'M', status: 'in-use' },
  { id: 'b2', name: 'Road 02', type: 'Road', size: 'M', status: 'in-use' },
  { id: 'b9', name: 'Hybrid 09', type: 'Hybrid', size: 'M', status: 'available' },
];
const row = (id: string, qn: number, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: D, session_day: 'Tuesday', session_date: D, queue_num: qn, name, phone: '0551112222',
  customer_id: null, group_id: null, status, paid: true, price: 115, walk_in: true, type_preference: 'Road',
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});
const queue_entries = [
  row('r1', 1, 'Owing Rider', 'active', { assigned_bike_id: 'b1', paid: false }),
  row('r2', 2, 'Paid Rider', 'active', { assigned_bike_id: 'b2' }),
  row('r3', 3, 'Bikeless Rider', 'active', { paid: false }),
  row('w1', 4, 'Waiting Rider', 'waiting', { paid: false }),
];
const inventory = [{ id: 'it1', name: 'Water', category: 'Drinks', qty: 9, price: 5, low_threshold: 1 }];

async function queue(page: Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries, bikes, inventory, 'rpc:staff_return': { ok: true }, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.staffTab='queue';S.queueView='bookings';S.sfSession='${D}';S.sfStatus='all';renderStaffQueue()`);
}
const rpcs = (page: Page, name: string) => {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.url().includes(`/rest/v1/rpc/${name}`)) { try { calls.push(r.postDataJSON()); } catch { calls.push({}); } } });
  return calls;
};
const patches = (page: Page) => {
  const out: { id: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) { const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1]; try { out.push({ id, body: r.postDataJSON() }); } catch { /* not JSON */ } }
  });
  return out;
};

test('a return is one sheet: the condition, and the payment only for a rider still owing', async ({ page }) => {
  await queue(page);
  const returns = rpcs(page, 'staff_return');
  await page.evaluate(`doReturn('r1')`);
  const sheet = page.locator('#return-modal .modal-box');
  await expect(sheet).toBeVisible();
  await expect(page.locator('#return-pay-modal')).toBeHidden();          // no second dialog before it
  await expect(sheet.locator('#ret-pay-lbl')).toContainText('115');       // what is owed, on the sheet
  await expect(sheet.locator('#ret-cond-lbl')).toBeVisible();
  await sheet.locator('.toggle-btn', { hasText: 'Paid' }).first().click();
  expect(await page.evaluate('S._retPaid')).toBe(true);
  await sheet.locator('#ret-confirm').click();
  await expect.poll(() => returns.length).toBe(1);
  expect(returns[0]).toMatchObject({ p_booking_id: 'r1', p_return_condition: 'ok' });
  // a rider who has paid gets the condition alone
  await page.evaluate(`doReturn('r2')`);
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('#ret-pay-lbl')).toHaveCount(0);
});

test('Confirm on the check-in modal says what it records for the payment', async ({ page }) => {
  await queue(page);
  await page.evaluate(`showCheckinModal('w1')`);
  const btn = page.locator('#ci-confirm');
  await expect(btn).toContainText('Confirm · ✓ Paid');
  await page.evaluate(`_on_renderCheckinModal_3(null,null,'pending')`);
  await expect(btn).toContainText('Confirm · Pending');
});

test('a checked-in rider without a bike reads "Needs bike", not "On Bike"', async ({ page }) => {
  await queue(page);
  const rows = page.locator('.queue-table tbody tr, .q-card');
  await expect(rows.filter({ hasText: 'Bikeless Rider' }).first()).toContainText('Needs bike');
  await expect(rows.filter({ hasText: 'Paid Rider' }).first()).toContainText('On Bike');
});

test('the stat chips filter the roster and clear it; the night carries its Close out with what is still owed', async ({ page }) => {
  await queue(page);
  await page.locator('#tab-queue .stat-chip-clickable', { hasText: 'Expected' }).first().click();
  expect(await page.evaluate('S.sfStatus')).toBe('waiting');
  const clear = page.locator('#tab-queue .stat-chip-clickable', { hasText: 'Clear filter' });
  await expect(clear).toBeVisible();
  await clear.click();
  expect(await page.evaluate('S.sfStatus')).toBe('all');
  const closeOut = page.locator('#tab-queue .stat-chip-clickable', { hasText: 'Close out' });
  await expect(closeOut).toContainText('(4)');                              // three on bikes or bikeless, one expected
  await closeOut.click();
  const box = page.locator('#confirm-modal');
  await expect(box).toContainText('still owe');
  await expect(box).toContainText('230');                                  // r1 and r3, 115 each
});

test('a walk-up can be added and checked in in one go', async ({ page }) => {
  const rows = queue_entries.slice();                       // this test's own copy: the inserted row joins it, as the server would keep it
  await queue(page, { queue_entries: rows });
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/rest/v1/queue_entries')) { const b = r.postDataJSON(); rows.push(...(Array.isArray(b) ? b : [b])); } });
  await page.evaluate(`showWalkinModal()`);
  await page.locator('#wi-name').fill('Walk Up');
  await page.locator('#wi-sess').selectOption(D);
  await page.getByRole('button', { name: 'Add & check in' }).click();
  await expect(page.locator('#ci-confirm')).toBeVisible();
  await expect.poll(() => page.evaluate(`(getQueue().find(e=>e.id===S._ciId)||{}).name`)).toBe('Walk Up');
});

test('bulk payment and bulk check-in leave an undo', async ({ page }) => {
  await queue(page, { 'rpc:staff_checkin': { ok: true } });
  const writes = patches(page);
  await page.evaluate(`S.sfSelected=['w1'];bulkSfPaid()`);
  await expect(page.locator('#topbar-right .undo-btn')).toHaveAttribute('title', /Payment · 1/);
  await page.evaluate(`doUndo()`);
  await expect.poll(() => writes.some((w) => w.id === 'w1' && w.body.paid === false)).toBe(true);
  await page.evaluate(`S.sfSelected=['w1'];bulkSfCheckin()`);
  await expect(page.locator('#topbar-right .undo-btn')).toHaveAttribute('title', /Undo Check-in · 1/);
});

test('On the house asks the operator PIN, like a void', async ({ page }) => {
  await queue(page, { 'rpc:staff_operator_list': [{ name: 'Spec Staff', has_pin: true }] });
  const writes = patches(page);
  await page.evaluate(`localStorage.setItem('cq_op_name','Spec Staff');S._opPins=null;togglePayment('w1','house');0`);
  await expect(page.locator('#op-gate-modal .op-gate')).toBeVisible();
  await expect(page.locator('#op-gate-modal .op-gate')).toContainText('On the house');
  await page.waitForTimeout(200);
  expect(writes.length).toBe(0);
  await page.evaluate(`_opgBack()`);
  await page.waitForTimeout(200);
  expect(writes.length).toBe(0);
  expect(await page.evaluate(`(getQueue().find(e=>e.id==='w1')||{}).paid`)).toBe(false);
});

test('one tap on a priced till item puts it in the cart', async ({ page }) => {
  await queue(page);
  await page.evaluate(`setStaffTab('cashier')`);
  await page.evaluate(`_ctTile('it1')`);
  expect(await page.evaluate(`S._ctCart.map(c=>[c.name,c.qty,c.price])`)).toEqual([['Water', 1, 5]]);
  expect(await page.evaluate(`S._ctItem`)).toBe('');                      // the form is ready for the next
});
