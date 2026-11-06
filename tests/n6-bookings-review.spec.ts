import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bookings from the 2026-11-06 staff review (BK01-BK09, migration 20261107100000): offline check-ins keep the time they
// were made, the edit form does not undo another desk's change, the check-in drawer notices a rider checked in elsewhere,
// close-out waits for this device's unsent changes, bulk Paid goes through the outbox, scan or Enter returns a rider on a
// bike, the live Owing chip, who has a rider open, and who checked a rider in and out. Invented riders only.

const TODAY = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // the KSA day, as the app reads it
const SESSION = { id: 's0', day: 'Friday', session_date: TODAY, capacity: 12, status: 'open', created_at: 1 };
const B2 = { id: 'b2', name: 'Hybrid 043', bike_number: 43, type: 'Hybrid', size: 'M', status: 'in-use', colors: ['#ffffff'], color_names: ['White'] };
const row = (id: string, n: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: 's0', session_day: 'Friday', session_date: TODAY, queue_num: n,
  name, phone: '', customer_id: null, group_id: null, status: 'waiting', paid: false,
  price: 57.5, walk_in: true, registered_at: `${TODAY}T10:0${n}:00Z`, type_preference: 'Hybrid', size: 'M', height: 176, ...extra,
});
const E1 = () => row('e1aaaa11', 7, 'Rider Seven');
const E2 = () => row('e2bbbb22', 8, 'Rider Eight');
const E3 = () => row('e3cccc33', 9, 'Rider Nine', { status: 'active', assigned_bike_id: 'b2', checked_in_at: `${TODAY}T15:04:00Z`, checked_in_by: 'Sara' });

async function boot(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { queue_entries: [E1(), E2(), E3()], sessions: [SESSION], bikes: [B2], 'rpc:staff_return': { ok: true }, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
  await page.evaluate(`S.staffTab='queue';S.sfSession='s0';renderStaffQueue()`);
}
function rpcs(page: Page, fn: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.url().includes(`/rest/v1/rpc/${fn}`)) { try { out.push(r.postDataJSON()); } catch { /* none */ } } });
  return out;
}
function patches(page: Page) {
  const out: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) out.push(r.url()); });
  return out;
}
const flush = (page: Page) => page.evaluate(`_dqEdit(l=>l.forEach(o=>{o.next=0}),true).then(()=>_dqFlush())`);

test.describe('@staff:bookings n6 bookings review', () => {
  test('BK01: a check-in kept offline is sent with the time it was made; a database without p_at is asked again without it', async ({ page, context }) => {
    await boot(page);
    const sent = rpcs(page, 'staff_checkin');
    // the database before 20261107100000: p_at is not a parameter
    await page.route(/\/rest\/v1\/rpc\/staff_checkin/, async (route) => {
      const b = route.request().postDataJSON() || {};
      if ('p_at' in b) return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.staff_checkin(p_at, ...) in the schema cache' }) });
      return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, noop: false, bikes: [] }) });
    });
    await context.setOffline(true);
    await page.evaluate(`_checkinMany(['e1aaaa11'])`);
    await page.waitForFunction('_DQ.length===1');
    const at = await page.evaluate('new Date(_DQ[0].at).toISOString()');
    await page.waitForTimeout(1200); // sent later than it was made
    await context.setOffline(false);
    await flush(page);
    await page.waitForFunction('_DQ.length===0');
    expect(sent.length).toBe(2);
    expect(sent[0]).toMatchObject({ p_booking_id: 'e1aaaa11', p_at: at });
    expect(sent[1].p_at).toBeUndefined();
    expect(sent[1].p_op_id).toBe(sent[0].p_op_id);
  });

  test('BK09: the status cell and the scan banner say who checked the rider in', async ({ page }) => {
    await boot(page);
    const cell = page.locator('#tab-queue .rq-by').first();
    await expect(cell).toContainText('Sara');
    await expect(cell).toContainText(/^in /);
  });

  test('BK02: the edit form does not write over a rider another desk moved meanwhile', async ({ page }) => {
    await boot(page);
    const p = patches(page);
    await page.evaluate(`showBookingEditModal('e1aaaa11')`);
    await expect(page.locator('#be-name')).toBeVisible();
    await page.evaluate(`getQueue().find(e=>e.id==='e1aaaa11').status='noshow'`);
    await page.evaluate('_saveBookingEdit()');
    await expect(page.locator('#booking-edit-modal #be-name')).toHaveCount(0);
    expect(p).toHaveLength(0);
    // a save that goes out is guarded on the state the form opened with
    await page.evaluate(`getQueue().find(e=>e.id==='e1aaaa11').status='waiting';showBookingEditModal('e1aaaa11')`);
    await page.evaluate('_saveBookingEdit()');
    await expect.poll(() => p.length).toBeGreaterThan(0);
    expect(p[0]).toContain('status=eq.waiting');
  });

  test('BK03: a rider checked in on another desk while the drawer is open is said, with Open booking and Record payment', async ({ page }) => {
    await boot(page);
    await page.evaluate(`showCheckinModal('e1aaaa11')`);
    const m = page.locator('#checkin-modal');
    await expect(m.locator('#ci-confirm')).toBeVisible();
    await page.evaluate(`Object.assign(getQueue().find(e=>e.id==='e1aaaa11'),{status:'active',checkedInAt:new Date().toISOString(),checkedInBy:'Omar'});renderCheckinModal()`);
    await expect(m).toContainText('Checked in on another desk');
    await expect(m).toContainText('Omar');
    await expect(m.locator('#ci-confirm')).toHaveCount(0);
    await expect(m.getByRole('button', { name: 'Open booking' })).toBeVisible();
    await expect(m.getByRole('button', { name: 'Record payment' })).toBeVisible();
  });

  test('BK04: close out waits for the changes this device has not sent', async ({ page, context }) => {
    await boot(page);
    await context.setOffline(true);
    await page.evaluate(`_checkinMany(['e1aaaa11'])`);
    await page.waitForFunction('_DQ.length===1');
    await page.evaluate(`closeOutSession('s0')`);
    const dlg = page.locator('#confirm-modal');
    await expect(dlg).toContainText('not sent from this device');
    await expect(dlg.getByRole('button', { name: 'Send now' })).toBeVisible();
  });

  test('BK05: bulk Paid offline goes into the desk outbox', async ({ page, context }) => {
    await boot(page);
    await context.setOffline(true);
    await page.evaluate(`S.sfSelected=['e1aaaa11','e2bbbb22'];bulkSfPaid()`);
    await page.waitForFunction('_DQ.length===2');
    expect(await page.evaluate(`_DQ.map(o=>o.kind+':'+o.args.paid+':'+o.guard).join(',')`)).toBe('pay:true:true,pay:true:true');
    expect(await page.evaluate(`getQueue().find(e=>e.id==='e1aaaa11').paid`)).toBe(true);
  });

  test('BK06: a scanned rider on a bike gets Return; Enter on their number returns them', async ({ page }) => {
    await boot(page, { queue_entries: [E1(), E2(), { ...E3(), paid: true }] });
    await page.evaluate('openScanModal()');
    await expect(page.locator('#scan-msg')).toContainText(/camera/i, { timeout: 15000 });
    await page.evaluate(`_onScanPayload('MMC-9-e3cccc33')`);
    await expect(page.locator('#scan-banner')).toContainText('Sara');
    const ret = page.locator('#scan-exception-btn');
    await expect(ret).toHaveText('Return bike');
    await ret.click();
    const dlg = page.locator('#return-modal [role="dialog"]');
    await expect(dlg).toBeVisible(); // a fleet bike: its condition is asked
    await expect(dlg).toContainText('Rider Nine');
    await page.evaluate('closeReturnModal()');
    await expect(dlg).toHaveCount(0);
    await page.evaluate(`S.sfSearch='9';sfSearchEnter()`);
    await expect(dlg).toContainText('Rider Nine');
  });

  test('BK07: the live bar says who owes and how much; a tap lists them', async ({ page }) => {
    await boot(page, { queue_entries: [E1(), row('e2bbbb22', 8, 'Rider Eight', { status: 'done' }), E3(), row('e4dddd44', 10, 'Rider Ten', { status: 'done', paid: true, price: 0 })] });
    const chip = page.locator('#tab-queue .q-lc-owing');
    await expect(chip).toContainText('2'); // on a bike and back, unpaid; the paid and the free left out
    await expect(chip).toContainText('Owing');
    await expect(chip).toContainText('115');
    await chip.click();
    expect(await page.evaluate('S.sfStatus')).toBe('owing');
    await expect(page.locator('#tab-queue').locator('.queue-table tbody tr, .q-card')).toHaveCount(2);
  });

  test('BK08: a rider another staff member has open says so on the row and in the drawer', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S._n6bPres=new Map([['e1aaaa11',['Sara']]]);renderStaffQueue();showCheckinModal('e1aaaa11')`);
    await expect(page.locator('#tab-queue .n6b-pres').first()).toContainText('Sara has this rider open');
    await expect(page.locator('#checkin-modal .n6b-pres-dlg')).toContainText('Sara has this rider open');
  });
});
