import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A free ride has nothing to collect (the owner, 2026-10-06: "remove the mark paid button from free sessions only
// keep check in status"). The roster's price and pay pills already read "—" there; now the bar shown for selected
// riders offers Check in alone, returning a bike asks no payment question, and the bike pop-up has no payment line.
// A ride that charges keeps every one of them.

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sessions = [
  { id: 'sat', day: 'Saturday', session_date: today, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', title: 'Saturday Social Ride' },
  { id: 'jcc', day: 'Saturday', session_date: today, capacity: 40, status: 'open', created_at: 2 },
  { id: 'swim', day: 'Saturday', session_date: today, capacity: 20, status: 'open', created_at: 3, event_kind: 'community', ride_kind: 'swim', title: 'Swim' },
];
const bikes = [
  { id: 'b1', name: 'Road 001', bike_number: 1, type: 'Road', size: 'M', status: 'in-use', colors: [], color_names: [] },
  { id: 'b2', name: 'Road 002', bike_number: 2, type: 'Road', size: 'M', status: 'in-use', colors: [], color_names: [] },
];
const row = (id: string, session_id: string, queue_num: number, extra: Record<string, unknown> = {}) => ({
  id, session_id, session_day: 'Saturday', session_date: today, queue_num, name: 'Rider ' + id, phone: '', customer_id: null,
  status: 'waiting', paid: false, price: session_id === 'jcc' ? 30 : 0, type_preference: 'Road', size: 'M',
  registered_at: today + 'T05:00:00Z', ...extra,
});
const queue_entries = [
  row('f1', 'sat', 1), row('f2', 'sat', 2),
  row('f3', 'sat', 3, { status: 'active', assigned_bike_id: 'b1', checked_in_at: today + 'T06:00:00Z' }),
  row('p1', 'jcc', 1),
  row('p2', 'jcc', 2, { status: 'active', assigned_bike_id: 'b2', checked_in_at: today + 'T06:00:00Z' }),
  row('s1', 'swim', 1, { status: 'active', type_preference: 'Any', checked_in_at: today + 'T06:00:00Z' }),
];

async function boot(page: Page) {
  await stubSupabase(page, { sessions, queue_entries, bikes, 'rpc:staff_return': { ok: true, noop: false, bikes_freed: 1 } });
  await unlockStaff(page);
  await page.goto('/bookings');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded&&getQueue().length===6');
}
function patches(page: Page) {
  const out: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && /\/rest\/v1\/queue_entries\?/.test(r.url())) out.push(decodeURIComponent(r.url())); });
  return out;
}
const select = (page: Page, session: string, ids: string[]) =>
  page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession=${JSON.stringify(session)};S.sfSelected=${JSON.stringify(ids)};renderStaffQueue()`);

test.describe('@staff:bookings free rides have no Mark paid', () => {
  test('the bar for selected riders offers Check in on a free ride, Mark paid only where a ride charges', async ({ page }) => {
    await boot(page);
    const bar = page.locator('#tab-queue .rq-bulk');
    await select(page, 'sat', ['f1', 'f2']);
    await expect(bar).toContainText('2 selected');
    await expect(bar.getByRole('button', { name: 'Check in' })).toBeVisible();
    await expect(bar.getByRole('button', { name: /Mark paid/ })).toHaveCount(0);

    await select(page, 'jcc', ['p1']);
    await expect(bar.getByRole('button', { name: /Mark paid/ })).toBeVisible();

    // Both rides selected on "All sessions": Mark paid is there for the circuit rider, and pays only them.
    const sent = patches(page);
    await select(page, 'all', ['f1', 'p1']);
    await bar.getByRole('button', { name: /Mark paid/ }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toContain('id=eq.p1');
    expect(sent.some((u) => u.includes('id=eq.f1'))).toBe(false);
  });

  test('returning a bike on a free ride asks no payment; a ride that charges still asks', async ({ page }) => {
    await boot(page);
    const ret = page.locator('#return-modal');
    await page.evaluate(`doReturn('f3')`);
    await expect(ret).toHaveCSS('display', 'flex');
    await expect(ret).toContainText('Road 001');
    await expect(ret.locator('.dk-rt-fgpay')).toHaveCount(0);
    await expect(ret).not.toContainText('Payment Pending');
    await page.evaluate(`closeReturnModal()`);

    await page.evaluate(`doReturn('p2')`);
    await expect(ret.locator('.dk-rt-fgpay')).toContainText('Payment Pending');
  });

  test('a free ride without bikes finishes without the payment question', async ({ page }) => {
    await boot(page);
    const rpcs: string[] = [];
    page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (m && r.method() === 'POST') rpcs.push(m[1]); });
    await page.evaluate(`doReturn('s1')`);
    await expect.poll(() => rpcs.includes('staff_return')).toBe(true);
    await expect(page.locator('#return-pay-modal')).not.toHaveCSS('display', 'flex');
  });

  test('the bike pop-up has no payment line on a free ride', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('queue');openModal('f1')`);
    await expect(page.locator('.bkm-mname')).toHaveText('Rider f1');
    await expect(page.locator('.bkm-paywarn, .bkm-payhouse, .bkm-paygreen')).toHaveCount(0);
    await page.evaluate(`closeModal();openModal('p1')`);
    await expect(page.locator('.bkm-mname')).toHaveText('Rider p1');
    await expect(page.locator('.bkm-paywarn')).toBeVisible();
  });
});
