import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The desk's fast path (2026-09-28):
//  - Express: with the scanner's Express switch on, a scanned ticket whose rider has paid is checked
//    in on the spot, the whole party with them, with one Undo; a rider who still owes gets the usual
//    check-in modal, since payment is what happens next.
//  - Hand-over: Bookings > Hand-over (/bookings/handover) lists the riders checked in and still
//    without a bike. A bike number typed, a tag tapped or a sticker scanned goes to the picked rider
//    (next in line by default) through staff_swap_bike, or the classic writes where it is missing.
//  - A tag tapped on a bike that is out opens its rider's return: the condition, notes and Return.
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const row = (id: string, qn: number, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Friday', session_date: today, queue_num: qn, name, phone: '', customer_id: null,
  group_id: null, status: 'waiting', paid: true, price: 30, walk_in: true, registered_at: '2026-01-01T10:00:00Z', height: 175, ...extra,
});
const A = 'aaaa1111-0000-4000-8000-000000000001', B = 'bbbb2222-0000-4000-8000-000000000002', C = 'cccc3333-0000-4000-8000-000000000003';
const D = 'dddd4444-0000-4000-8000-000000000004', E = 'eeee5555-0000-4000-8000-000000000005', F = 'ffff6666-0000-4000-8000-000000000006';
const rows = () => [
  row(A, 1, 'Paid Amal'),
  row(B, 2, 'Party Badr', { group_id: 'g1' }),
  row(C, 3, 'Party Cala', { group_id: 'g1' }),
  row(D, 4, 'Owes Dina', { paid: false }),
  row(E, 5, 'Riding Eid', { status: 'active', assigned_bike_id: 'bk-in', checked_in_at: '2026-01-01T18:00:00Z' }),
  row(F, 6, 'Bikeless Fadi', { status: 'active', assigned_bike_id: null, checked_in_at: '2026-01-01T17:50:00Z' }),
];
const sessions = [{ id: 's0', day: 'Friday', session_date: today, capacity: 12, status: 'open', created_at: 1 }];
const bikes = [
  { id: 'bk-42', bike_number: 42, name: 'Hybrid M 042', type: 'Hybrid', size: 'M', status: 'available', colors: [] },
  { id: 'bk-43', bike_number: 43, name: 'Hybrid M 043', type: 'Hybrid', size: 'M', status: 'available', colors: [] },
  { id: 'bk-in', bike_number: 9, name: 'Road S 009', type: 'Road', size: 'S', status: 'in-use', colors: [] },
];
const found = (b: Record<string, unknown>) => ({ found: true, bike: b, rented_to: null });

// The stub serves its fixture rows as given; the writes are kept on a fresh copy per test, as the
// database would keep them, so a re-read after a check-in comes back 'active'.
async function boot(page: Page, fixtures: Record<string, unknown> = {}, init?: () => void) {
  const q = rows();
  await stubSupabase(page, { queue_entries: q, sessions, bikes, ...fixtures });
  await page.route(/\/rest\/v1\/queue_entries/, async (route) => {
    const r = route.request();
    if (r.method() === 'PATCH') {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
      const row = q.find((x) => x.id === id);
      if (row) Object.assign(row, body);
    }
    return route.fallback();
  });
  // staff_swap_bike lands the bike on the row in the database; the stub's copy follows suit.
  await page.route(/\/rest\/v1\/rpc\/staff_swap_bike/, async (route) => {
    let body: Record<string, unknown> = {};
    try { body = route.request().postDataJSON() || {}; } catch { /* not JSON */ }
    const row = q.find((x) => x.id === body.p_booking_id);
    if (row && (fixtures['rpc:staff_swap_bike'] as { ok?: boolean } | undefined)?.ok) row.assigned_bike_id = body.p_new_bike_id;
    return route.fallback();
  });
  await unlockStaff(page);
  if (init) await page.addInitScript(init);
  await page.goto('/');
  await waitForSb(page);
}
function watch(page: Page, table: string) {
  const writes: Array<{ id: string; body: Record<string, unknown> }> = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes(`/rest/v1/${table}`)) {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
      if (id) writes.push({ id, body });
    }
  });
  return writes;
}
function rpcs(page: Page, name: string) {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.url().includes(`/rest/v1/rpc/${name}`)) { try { calls.push(r.postDataJSON() || {}); } catch { calls.push({}); } } });
  return calls;
}
async function openScanner(page: Page) {
  await page.evaluate(`S.staffTab='queue';renderStaffQueue();openScanModal()`);
  // Headless has no camera: let its error land first so it cannot overwrite what a scan says.
  await expect(page.locator('#scan-msg')).toContainText(/camera/i, { timeout: 15000 });
}
const scan = (page: Page, code: string) => page.evaluate((c) => {
  // @ts-expect-error app global
  _onScanPayload(c);
}, code);

test.describe('Express', () => {
  test('a paid rider is checked in on the scan, the camera stays open, and Undo puts them back', async ({ page }) => {
    await boot(page, {}, () => localStorage.setItem('cq_scan_express', '1'));
    const writes = watch(page, 'queue_entries');
    await openScanner(page);
    await expect(page.locator('#scan-express-btn')).toHaveAttribute('aria-pressed', 'true');

    await scan(page, 'MMC-1-aaaa1111');
    await expect(page.locator('#scan-msg')).toContainText('#1 Paid Amal checked in');
    const w = writes.find((x) => x.id === A);
    expect(w && w.body.status).toBe('active');
    expect(typeof (w && w.body.checked_in_at)).toBe('string');
    await expect(page.locator('#scan-modal [role="dialog"]')).toBeVisible(); // no modal took the camera's place
    expect(await page.evaluate(`!!S._ciId`)).toBe(false);
    await expect(page.locator('#scan-tally')).toContainText('1');

    // Undo: the rider back in the line, guarded on still being on the ride.
    await page.evaluate(`doUndo()`);
    await expect.poll(() => writes.filter((x) => x.id === A && x.body.status === 'waiting').length).toBe(1);
  });

  test('a party goes in together, and the member who still owes is counted back', async ({ page }) => {
    await boot(page, {}, () => localStorage.setItem('cq_scan_express', '1'));
    const writes = watch(page, 'queue_entries');
    await openScanner(page);
    await scan(page, 'MMC-2-bbbb2222');
    await expect(page.locator('#scan-msg')).toContainText('2 riders checked in');
    await expect.poll(() => writes.filter((x) => (x.id === B || x.id === C) && x.body.status === 'active').length).toBe(2);
    expect(writes.some((x) => x.id === D)).toBe(false);
  });

  test('a rider who still owes opens the usual check-in, since payment comes next', async ({ page }) => {
    await boot(page, {}, () => localStorage.setItem('cq_scan_express', '1'));
    const writes = watch(page, 'queue_entries');
    await openScanner(page);
    await scan(page, 'MMC-4-dddd4444');
    await expect(page.locator('#ci-confirm')).toBeVisible();
    expect(await page.evaluate(`S._ciId`)).toBe(D);
    expect(writes.filter((x) => x.id === D).length).toBe(0);
  });

  test('with Express off a scan opens the modal, as before; the switch is remembered', async ({ page }) => {
    await boot(page);
    await openScanner(page);
    await expect(page.locator('#scan-express-btn')).toHaveAttribute('aria-pressed', 'false');
    await scan(page, 'MMC-1-aaaa1111');
    await expect(page.locator('#ci-confirm')).toBeVisible();
    await page.evaluate(`closeCheckinModal();openScanModal()`);
    await page.locator('#scan-express-btn').click();
    expect(await page.evaluate(`localStorage.getItem('cq_scan_express')`)).toBe('1');
    await expect(page.locator('#scan-express-hint')).not.toBeEmpty();
  });
});

test.describe('Hand-over', () => {
  test('lists the riders checked in without a bike, has its own address, and hands a typed number over through staff_swap_bike', async ({ page }) => {
    await boot(page, { 'rpc:staff_resolve_bike': found(bikes[0]), 'rpc:staff_swap_bike': { ok: true, noop: false, assignment_id: 'as1' } });
    const swaps = rpcs(page, 'staff_swap_bike');
    await page.evaluate(`setStaffTab('handover')`);
    expect(await page.evaluate(`location.pathname`)).toBe('/bookings/handover');
    const host = page.locator('#ho-host');
    await expect(host).toContainText('Waiting for a bike (1)');
    await expect(host.locator('.ho-row')).toHaveCount(1);
    await expect(host.locator('.ho-row.sel')).toContainText('Bikeless Fadi'); // next in line, picked by itself
    await expect(host).toContainText('On bikes (1)');
    await expect(host).toContainText('Riding Eid');
    // the pill carries the count
    await expect(page.locator('#tab-queue .filter-pill.active')).toContainText('Hand-over (1)');

    await page.locator('#ho-bike').fill('42');
    await page.locator('#ho-bike').press('Enter');
    await expect.poll(() => swaps.length).toBe(1);
    expect(swaps[0]).toEqual({ p_booking_id: F, p_new_bike_id: 'bk-42' });
    await expect(host).toContainText('Nobody is waiting for a bike.');
    expect(await page.evaluate(`getQueue().find(e=>e.id===${JSON.stringify(F)}).assignedBikeId`)).toBe('bk-42');
    // a hand-over is on the record with an undo
    expect(await page.evaluate(`S.undoStack.length`)).toBe(1);
  });

  test('a tag tapped while the view is open goes to the picked rider; without the function the classic writes run', async ({ page }) => {
    await boot(page, {
      'rpc:staff_resolve_bike': found(bikes[1]),
      'rpc:staff_swap_bike': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_swap_bike' } },
    });
    const qw = watch(page, 'queue_entries'), bw = watch(page, 'bikes');
    await page.evaluate(`setStaffTab('handover')`);
    await expect(page.locator('#ho-host .ho-row')).toHaveCount(1);
    await page.evaluate(`_bikeArrived('43','nfc')`);
    await expect.poll(() => qw.filter((x) => x.id === F && x.body.assigned_bike_id === 'bk-43').length).toBe(1);
    expect(bw.some((x) => x.id === 'bk-43' && x.body.status === 'in-use')).toBe(true);
    await expect(page.locator('#ho-host')).toContainText('Nobody is waiting for a bike.');
  });

  test('the picked rider is remembered for the tab a tag opens; leaving the view forgets them', async ({ page }) => {
    await boot(page, { 'rpc:staff_resolve_bike': found(bikes[0]), 'rpc:staff_swap_bike': { ok: true, noop: false } });
    await page.evaluate(`setStaffTab('handover')`);
    await expect(page.locator('#ho-host .ho-row')).toHaveCount(1);
    const kept = await page.evaluate(`JSON.parse(localStorage.getItem('cq_ho')||'null')`) as { id: string } | null;
    expect(kept && kept.id).toBe(F);
    // another tab, on Bookings, taps the tag: the remembered rider still gets the bike
    await page.evaluate(`S.queueView='bookings';S.staffTab='queue'`);
    expect(await page.evaluate(`(_hoTarget()||{}).id`)).toBe(F);
    // leaving the view for good forgets the pick
    await page.evaluate(`renderStaffQueue()`);
    expect(await page.evaluate(`localStorage.getItem('cq_ho')`)).toBeNull();
    expect(await page.evaluate(`_hoTarget()`)).toBeNull();
  });

  test("a tag tapped on a bike that is out opens its rider's return: the condition, notes and Return", async ({ page }) => {
    await boot(page, { 'rpc:staff_resolve_bike': { found: true, bike: bikes[2], rented_to: { name: 'Riding Eid', since: '2026-01-01T18:00:00Z' } }, 'rpc:staff_return': { ok: true } });
    const rets = rpcs(page, 'staff_return');
    await page.evaluate(`S.staffTab='queue';S.queueView='bookings';renderStaffQueue();_bikeArrived('9','nfc')`);
    const m = page.locator('#return-modal');
    await expect(m).toHaveCSS('display', 'flex');
    await expect(m.locator('#ret-title')).toContainText('#5 Riding Eid');
    await expect(m).toContainText('Road S 009');
    await expect(m.getByRole('button', { name: '✓ OK' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#confirm-modal')).toBeHidden(); // no chooser in front of it any more
    await m.getByRole('button', { name: 'Needs a check' }).click();
    await m.locator('#ret-notes').fill('Rear brake rubs');
    await m.locator('#ret-confirm').click();
    await expect.poll(() => rets.length).toBe(1);
    expect(rets[0]).toMatchObject({ p_booking_id: E, p_return_condition: 'needs_check', p_notes: 'Rear brake rubs' });
    await expect(m).toBeHidden();
  });

  test('/bookings/handover opens the view straight from the address', async ({ page }) => {
    await stubSupabase(page, { queue_entries: rows(), sessions, bikes });
    await unlockStaff(page);
    await page.goto('/bookings/handover');
    await waitForSb(page);
    await expect(page.locator('#ho-host')).toBeVisible();
    expect(await page.evaluate(`S.queueView`)).toBe('handover');
  });
});
