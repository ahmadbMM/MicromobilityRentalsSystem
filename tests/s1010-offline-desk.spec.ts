import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The desk outbox (2026-10-10): check-ins, returns, payments and no-shows made while the booth is offline
// are kept on the device (IndexedDB), counted by the roster header's "N unsynced" chip, survive a reload,
// and are sent once when the connection is back, with the op id that makes a replay land once
// (20261009215000). A replay the server refuses stays as "Needs attention" with its reason until staff
// retry or discard it. Invented riders and bikes only.

const B42 = { id: 'b1', name: 'Road 042', bike_number: 42, type: 'Road', size: 'M', status: 'available', colors: ['#000000'], color_names: ['Black'] };
const B43 = { id: 'b2', name: 'Hybrid 043', bike_number: 43, type: 'Hybrid', size: 'M', status: 'available', colors: ['#ffffff'], color_names: ['White'] };
const SESSION = { id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 };
const row = (id: string, n: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: n,
  name, phone: '', customer_id: null, group_id: null, status: 'waiting', paid: false,
  price: 57.5, walk_in: true, registered_at: `2099-01-01T10:0${n}:00Z`, type_preference: 'Hybrid', size: 'M', height: 176, ...extra,
});
const E1 = row('e1', 7, 'Rider Seven');
const E2 = row('e2', 8, 'Rider Eight');
const E3 = row('e3', 9, 'Rider Nine', { status: 'active', assigned_bike_id: 'b2', checked_in_at: '2099-02-10T18:00:00Z' });

async function boot(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { queue_entries: [E1, E2, E3], sessions: [SESSION], bikes: [B42, { ...B43, status: 'in-use' }], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0&&getBikes().length>0');
  await page.evaluate(`S.staffTab='queue';S.sfSession='s0';renderStaffQueue()`);
}
/** Each staff_checkin the server answered (an aborted one is not counted), with what it was sent. */
function checkins(page: Page) {
  const out: Record<string, unknown>[] = [];
  page.on('requestfinished', (r) => {
    if (r.url().includes('/rest/v1/rpc/staff_checkin')) { try { out.push(r.postDataJSON()); } catch { /* none */ } }
  });
  return out;
}
async function checkInOffline(page: Page, bike = '42') {
  await page.evaluate(`showCheckinModal('e1')`);
  const modal = page.locator('#checkin-modal');
  await modal.locator('#ci-bike').fill(bike);
  await modal.locator('#ci-bike').press('Enter');
  await expect(modal.locator('#ci-bike-spec')).toContainText('042');
  await modal.locator('#ci-confirm').click();
}
const chip = (page: Page) => page.locator('#tab-queue #dq-chip');

test.describe('@staff:checkin s1010 offline desk', () => {
  test('a check-in made offline is kept through a reload and sent once, with its op id, when the connection is back', async ({ page, context }) => {
    await boot(page);
    const sent = checkins(page);
    await context.setOffline(true);
    await checkInOffline(page);
    // the roster moves at once and says the change waits
    await expect(chip(page)).toContainText('1 unsynced');
    expect(await page.evaluate(`getQueue().find(e=>e.id==='e1').status`)).toBe('active');
    expect(await page.evaluate(`getBikes().find(b=>b.id==='b1').status`)).toBe('in-use');
    await expect(page.locator('#tab-queue .dq-mark').first()).toContainText('Waiting to sync');
    await expect(page.locator('#conn-banner')).toContainText('saved on this device');
    expect(sent).toHaveLength(0);
    const opId = await page.evaluate(`_DQ[0].args.p_op_id`);
    expect(opId).toBeTruthy();

    // Back online, but the booth's link still drops the call: the reload keeps the change (IndexedDB).
    const drop = (r: Route) => r.abort('failed');
    await page.route(/\/rest\/v1\/rpc\/staff_checkin/, drop);
    await context.setOffline(false);
    await page.reload();
    await waitForSb(page);
    await page.evaluate(`S.staffTab='queue';S.sfSession='s0';renderStaffQueue()`);
    await expect(chip(page)).toContainText('1 unsynced');
    await page.waitForFunction(`_DQ.length===1&&getQueue().find(e=>e.id==='e1').status==='active'`);
    expect(await page.evaluate(`_DQ[0].args.p_op_id`)).toBe(opId);

    // The link is back: sent once, with the same op id, and the chip goes.
    await page.unroute(/\/rest\/v1\/rpc\/staff_checkin/, drop);
    await page.evaluate(`_DQ.forEach(o=>{o.next=0});_dqEdit(l=>l.forEach(o=>{o.next=0}),true).then(()=>_dqFlush())`);
    await expect(chip(page)).toHaveCount(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ p_booking_id: 'e1', p_bike_id: 'b1', p_op_id: opId });
    // a second flush has nothing left to send
    await page.evaluate('_dqFlush()');
    await page.waitForTimeout(300);
    expect(sent).toHaveLength(1);
    expect(await page.evaluate(`getQueue().find(e=>e.id==='e1').status`)).toBe('active');
  });

  test('a replay the server refuses (bike taken meanwhile) stays as Needs attention with the reason; Discard asks first', async ({ page, context }) => {
    await boot(page, { 'rpc:staff_checkin': { __rpcError: { status: 400, code: 'P0001', message: 'BIKE_UNAVAILABLE: bike 42 is in-use (with Other Rider)' } } });
    await context.setOffline(true);
    await checkInOffline(page);
    await expect(chip(page)).toContainText('1 unsynced');
    await context.setOffline(false);
    await page.evaluate('_dqFlush()');
    await expect(chip(page)).toContainText('Needs attention');
    await expect(page.locator('#tab-queue .dq-mark.dq-bad').first()).toContainText('bike 42 is in-use (with Other Rider)');
    // never dropped: still listed, the row reads as the server has it
    expect(await page.evaluate('_DQ.length')).toBe(1);
    expect(await page.evaluate(`getQueue().find(e=>e.id==='e1').status`)).toBe('waiting');
    // the list: a centred dialog with the reason, Retry and Discard (the check-in went on to the next
    // rider after the confirm, "Open the next rider": closed first, as staff would)
    await page.evaluate('closeCheckinModal()');
    await chip(page).click();
    const dlg = page.getByRole('dialog', { name: 'Unsynced changes' });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('#7 Rider Seven');
    await expect(dlg).toContainText('bike 42 is in-use');
    await dlg.getByRole('button', { name: 'Discard' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Discard' }).click(); // the question
    await expect(chip(page)).toHaveCount(0);
    expect(await page.evaluate('_DQ.length')).toBe(0);
  });

  test('the chip counts every kind of change kept offline, in order per rider; the list names each', async ({ page, context }) => {
    await boot(page);
    await context.setOffline(true);
    await page.evaluate(`doNoShow('e2')`);
    await page.evaluate(`togglePayment('e3','paid')`);
    await page.evaluate(`_finishReturn('e3',false,'needs_check',null,null)`);
    await expect(chip(page)).toContainText('3 unsynced');
    const q = await page.evaluate(`getQueue().filter(e=>['e2','e3'].includes(e.id)).map(e=>[e.id,e.status,e.paid])`);
    expect(q).toEqual(expect.arrayContaining([['e2', 'noshow', false], ['e3', 'done', true]]));
    expect(await page.evaluate(`getBikes().find(b=>b.id==='b2').status`)).toBe('check');
    expect(await page.evaluate('_DQ.map(o=>o.kind)')).toEqual(['noshow', 'pay', 'return']);
    await chip(page).click();
    const dlg = page.getByRole('dialog', { name: 'Unsynced changes' });
    await expect(dlg.locator('.dq-row')).toHaveCount(3);
    await dlg.getByRole('button', { name: 'Close' }).first().click();
    await expect(dlg).toHaveCount(0);
    // online: all three sent, the payment before the return of the same rider
    const order: string[] = [];
    page.on('requestfinished', (r) => {
      const u = r.url();
      if (u.includes('/rpc/staff_return')) order.push('return');
      else if (r.method() === 'PATCH' && u.includes('/rest/v1/queue_entries')) { try { const b = r.postDataJSON(); order.push(b.status === 'noshow' ? 'noshow' : 'paid' in b ? 'pay' : 'patch'); } catch { /* none */ } }
    });
    await context.setOffline(false);
    await page.evaluate('_dqFlush()');
    await expect(chip(page)).toHaveCount(0);
    expect(order.indexOf('pay')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('pay')).toBeLessThan(order.indexOf('return'));
    expect(order).toContain('noshow');
  });
});

test.describe('@staff:checkin s1010 offline desk: lookups', () => {
  test('offline, a bike number is answered from the fleet on the device without asking the server', async ({ page, context }) => {
    await boot(page);
    let asked = 0;
    page.on('request', (r) => { if (r.url().includes('/rpc/staff_resolve_bike')) asked++; });
    await context.setOffline(true);
    const d = await page.evaluate(`_bikeLookup('42').then(x=>x.d&&x.d.found&&x.d.bike.id)`);
    expect(d).toBe('b1');
    expect(asked).toBe(0);
  });
});
