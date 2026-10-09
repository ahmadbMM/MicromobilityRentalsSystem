import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// On the house through the server (2026-10-09, migration 20261009205000). A hand-chosen ride on the house goes
// through staff_set_house (the operator's PIN and, over Settings' limit, a manager's approval, checked by the
// database); before the function exists the page writes the row as it always did.

const day = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }); // tomorrow: a live ride all day
const sessions = [{ id: 's1', day: 'Friday', session_date: day, capacity: 40, status: 'open', created_at: 0 }];
const rider = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  id, session_id: 's1', session_day: 'Friday', session_date: day, queue_num: n, name: `Rider ${n}`, phone: '',
  customer_id: null, status: 'waiting', paid: false, price: 60, walk_in: true, registered_at: '2026-01-01T10:00:00Z', type_preference: 'Road', ...extra,
});

type Call = { name: string; method: string; body: unknown };
function watch(page: Page) {
  const calls: Call[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/(?:rpc\/)?([^/?]+)/);
    if (!m) return;
    let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
    calls.push({ name: m[1], method: r.method(), body });
  });
  return calls;
}
async function boot(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [rider('e1', 1), rider('e2', 2)], bikes: [], 'rpc:staff_operator_list': [{ name: 'Spec Staff', has_pin: false }], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();S.staffTab='queue';renderStaffQueue()`);
}
const housePatches = (calls: Call[]) => calls.filter((c) => c.name === 'queue_entries' && c.method === 'PATCH'
  && (c.body as Record<string, unknown>)?.price === 0);

test.describe('@staff:bookings on the house through the server', () => {
  test('the pay menu sends a ride on the house to staff_set_house, with the operator, and writes no row itself', async ({ page }) => {
    await boot(page, { 'rpc:staff_set_house': { ok: true, id: 'e1', amount: 60 } });
    const calls = watch(page);
    await page.evaluate(`togglePayment('e1','house')`);
    await expect.poll(() => calls.filter((c) => c.name === 'staff_set_house').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_set_house')!.body).toMatchObject({ p_booking_id: 'e1', p_on: true, p_op: 'Spec Staff' });
    await page.waitForTimeout(300);
    expect(housePatches(calls)).toHaveLength(0);
  });

  test('before the database update the page writes the row as before', async ({ page }) => {
    await boot(page);
    const calls = watch(page);
    await page.evaluate(`togglePayment('e1','house')`);
    await expect.poll(() => housePatches(calls).length).toBe(1);
    expect(housePatches(calls)[0].body).toMatchObject({ paid: true, price: 0 });
    expect(await page.evaluate('S._houseNoDb')).toBe(true);
  });

  test('a refusal from the server is said and nothing is written', async ({ page }) => {
    await boot(page, { 'rpc:staff_set_house': { __rpcError: { status: 403, code: '42501', message: 'ADMIN_ONLY' } } });
    const calls = watch(page);
    await page.evaluate(`togglePayment('e1','house')`);
    await expect(page.locator('#toast-container .toast.error').last()).toBeVisible();
    await page.waitForTimeout(300);
    expect(housePatches(calls)).toHaveLength(0);
    expect(await page.evaluate(`getQueue().find(e=>e.id==='e1').paid`)).toBe(false);
  });

  test('the check-in set to House goes through staff_set_house first and the check-in carries no payment', async ({ page }) => {
    await boot(page, { 'rpc:staff_set_house': { ok: true, id: 'e2', amount: 60 } });
    const calls = watch(page);
    await page.evaluate(`showCheckinModal('e2');S._ciPaid='house';confirmCheckinModal()`);
    await expect.poll(() => calls.filter((c) => c.name === 'staff_checkin').length).toBe(1);
    const order = calls.filter((c) => c.name === 'staff_set_house' || c.name === 'staff_checkin').map((c) => c.name);
    expect(order).toEqual(['staff_set_house', 'staff_checkin']);
    const ci = calls.find((c) => c.name === 'staff_checkin')!.body as Record<string, unknown>;
    expect(ci.p_paid).toBeUndefined();
    expect(ci.p_price).toBeUndefined();
  });

  test('without the function the check-in carries the house as before', async ({ page }) => {
    await boot(page);
    const calls = watch(page);
    await page.evaluate(`showCheckinModal('e2');S._ciPaid='house';confirmCheckinModal()`);
    await expect.poll(() => calls.filter((c) => c.name === 'staff_checkin').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_checkin')!.body).toMatchObject({ p_paid: true, p_price: 0 });
  });
});
