import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }); // the camera takes today's tickets (KSA day)

// Two more things the check-in modal's Status section can do (2026-09-28). "Add a booking" opens
// the scanner on this check-in: each ticket scanned joins the run the way Scan several builds one
// - steps, the next rider opening by itself - and the camera stays up for the next; it is a list
// held in this tab, so nothing is written to group_id and each rider keeps their own payment and
// bike. "To staff list" parks the rider on the Staff Managed Waitlist instead of a bike (the row
// menu's button, from inside the modal) and the run moves on without them.
const A1 = 'a1a1a1a1-0000-4000-8000-000000000001', B2 = 'b2b2b2b2-0000-4000-8000-000000000002';
const E5 = 'e5e5e5e5-0000-4000-8000-000000000005';
const row = (id: string, qn: number, name: string, groupId: string | null, status = 'waiting'): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Friday', session_date: today, queue_num: qn,
  name, phone: '', customer_id: null, group_id: groupId, status, paid: false,
  price: 30, walk_in: true, registered_at: '2099-01-01T10:00:00Z',
});
const q = [
  row(A1, 1, 'Solo Amal', null),
  row(B2, 2, 'Solo Badr', null),
  row('c3c3c3c3-0000-4000-8000-000000000003', 3, 'Party Cala', 'g1'),
  row('d4d4d4d4-0000-4000-8000-000000000004', 4, 'Party Dina', 'g1'),
  row(E5, 5, 'Solo Eid', null),
];
const sessions = [{ id: 's0', day: 'Friday', session_date: today, capacity: 12, status: 'open', created_at: 1 }];

// The stub serves its fixture rows as given, so a rider re-read after Confirm would come back
// 'waiting' and the run would loop back to them: keep the writes on a fresh copy per test.
async function boot(page: Page, fixtures: Record<string, unknown> = {}) {
  const rows = q.map((r) => ({ ...r }));
  await stubSupabase(page, { queue_entries: rows, sessions, desk_waitlist: [], ...fixtures });
  await page.route(/\/rest\/v1\/queue_entries/, async (route) => {
    const r = route.request();
    if (r.method() === 'PATCH') {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
      const row = rows.find((x) => x.id === id);
      if (row) Object.assign(row, body);
    }
    return route.fallback();
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded===true');
}
const openCheckin = (page: Page, id: string) =>
  page.evaluate(`S.staffTab='queue';renderStaffQueue();showCheckinModal(${JSON.stringify(id)})`);
const scan = (page: Page, code: string) => page.evaluate(`_onScanPayload(${JSON.stringify(code)})`);
// Headless has no camera: let its error land first so it cannot overwrite what a scan says.
const cameraSettled = (page: Page) => expect(page.locator('#scan-msg')).toContainText(/camera/i, { timeout: 15000 });

function watchWrites(page: Page) {
  const patches: Array<{ id: string; body: Record<string, unknown> }> = [];
  const parks: Array<Record<string, unknown>> = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
      if (id) patches.push({ id, body });
    }
    if (r.method() === 'POST' && r.url().includes('/rest/v1/desk_waitlist')) {
      let body: unknown = [];
      try { body = r.postDataJSON(); } catch { /* not JSON */ }
      (Array.isArray(body) ? body : [body]).forEach((b) => parks.push(b as Record<string, unknown>));
    }
  });
  return { patches, parks };
}

test('Add a booking opens the scanner on this check-in: each ticket joins the run, the camera stays up, and the data never learns of a group', async ({ page }) => {
  await boot(page);
  const { patches } = watchWrites(page);
  await openCheckin(page, A1);
  const modal = page.locator('#checkin-modal [role="dialog"]'); // the wrapper has no box
  await expect(modal).toContainText('Solo Amal');
  await expect(modal.getByRole('list')).toHaveCount(0); // a solo rider: no steps yet

  await modal.getByRole('button', { name: /Add a booking/ }).click();
  const scanner = page.locator('#scan-modal [role="dialog"]');
  await expect(scanner).toBeVisible();
  await expect(scanner).toContainText('Scan the ticket of each rider checking in with #1 Solo Amal.');
  // Not the scanner's own modes: the list is this check-in's run, and Done is the way back.
  await expect(scanner.getByRole('button', { name: 'Scan several' })).toHaveCount(0);
  await expect(scanner.getByRole('button', { name: 'Keep scanning' })).toHaveCount(0);
  await expect(scanner.getByRole('button', { name: 'Express' })).toHaveCount(0);
  await cameraSettled(page);

  await scan(page, 'MMC-2-b2b2b2');
  await expect(page.locator('#scan-msg')).toHaveText('Added #2 Solo Badr.');
  const chips = scanner.getByRole('list', { name: 'Riders checking in together' }).getByRole('listitem');
  await expect(chips).toHaveCount(2);
  await expect(chips.first()).toContainText('#1 Solo'); // the rider in the modal leads the run
  await scan(page, 'MMC-3-c3c3c3'); // a party ticket brings its other rider along
  await expect(chips).toHaveCount(4);
  await scan(page, 'MMC-4-d4d4d4');
  await expect(page.locator('#scan-msg')).toHaveText('#4 Party Dina is already on the list.');
  await scan(page, 'MMC-1-a1a1a1');
  await expect(page.locator('#scan-msg')).toHaveText('#1 Solo Amal is already on the list.');
  await expect(scanner).toBeVisible(); // the camera stays up for the next ticket

  await scanner.getByRole('button', { name: 'Done' }).click();
  await expect(scanner).toBeHidden();
  // Back on the modal: one run of four under the label Scan several uses, a shared total.
  const steps = modal.getByRole('list', { name: 'Riders checking in together' }).getByRole('button');
  await expect(steps).toHaveCount(4);
  await expect(modal).toContainText('Rider 1 of 4');
  await expect(modal.locator('#ci-money')).toContainText('all SAR 120');

  await modal.locator('#ci-confirm').click();
  await expect(modal).toContainText('Solo Badr');
  await expect(modal).toContainText('Rider 2 of 4');
  for (const next of ['Party Cala', 'Party Dina']) {
    await modal.locator('#ci-confirm').click();
    await expect(modal).toContainText(next);
  }
  await modal.locator('#ci-confirm').click();
  await expect(modal).toBeHidden();

  await expect.poll(() => patches.filter((w) => w.body.status === 'active').map((w) => w.id.slice(0, 2)))
    .toEqual(['a1', 'b2', 'c3', 'd4']);
  expect(patches.some((w) => 'group_id' in w.body)).toBe(false); // never grouped in the data
  expect(patches.some((w) => w.id.startsWith('e5'))).toBe(false); // never scanned, untouched
  await expect.poll(() => page.evaluate('S._ciBatch')).toBeNull(); // the run is over
  expect(await page.evaluate('_scanAddTo')).toBeNull();
});

test('a bike sticker scanned there still goes to this check-in, and the camera comes down', async ({ page }) => {
  await boot(page);
  await openCheckin(page, A1);
  const modal = page.locator('#checkin-modal [role="dialog"]');
  await modal.getByRole('button', { name: /Add a booking/ }).click();
  const scanner = page.locator('#scan-modal [role="dialog"]');
  await cameraSettled(page);
  await scan(page, 'https://micromobilityrentals.pages.dev/?bike=42');
  await expect(scanner).toBeHidden();
  await expect(modal).toContainText('Solo Amal'); // still this rider's check-in
  expect(await page.evaluate('_scanAddTo')).toBeNull();
  await expect(modal.getByRole('list')).toHaveCount(0); // nobody was added
});

test('To staff list parks the rider from the modal and the run moves on without them', async ({ page }) => {
  await boot(page);
  const { patches, parks } = watchWrites(page);
  await openCheckin(page, A1);
  const modal = page.locator('#checkin-modal [role="dialog"]');
  await modal.getByRole('button', { name: /Add a booking/ }).click();
  await cameraSettled(page);
  await scan(page, 'MMC-2-b2b2b2');
  await page.locator('#scan-modal [role="dialog"]').getByRole('button', { name: 'Done' }).click();
  await expect(modal.getByRole('list', { name: 'Riders checking in together' }).getByRole('button')).toHaveCount(2);

  await modal.getByRole('button', { name: 'To staff list' }).click();
  // One staff-list row for Amal's booking, said so, and the modal is on Badr - alone now.
  await expect.poll(() => parks.length).toBe(1);
  expect(parks[0].booking_id).toBe(A1);
  expect(parks[0].kind).toBe('managed');
  await expect(page.getByText('Solo Amal moved to the staff list')).toBeAttached(); // a quiet toast: said, not drawn (2026-09-29)
  await expect(modal).toContainText('Solo Badr');
  await expect(modal).not.toContainText('Solo Amal');
  await expect(modal.getByRole('list')).toHaveCount(0);

  await modal.locator('#ci-confirm').click();
  await expect(modal).toBeHidden();
  await expect.poll(() => patches.filter((w) => w.body.status === 'active').map((w) => w.id.slice(0, 2))).toEqual(['b2']);
  expect(patches.some((w) => w.id.startsWith('a1'))).toBe(false); // parked, not checked in
});

test('a rider already on the staff list is not offered it again; a solo rider parked closes the modal', async ({ page }) => {
  await boot(page, {
    desk_waitlist: [{ id: 'w1', name: 'Solo Badr', phone: '', bike_type: 'Road', status: 'waiting', kind: 'managed',
      sort_order: 1, booking_id: B2, author: null, created_at: '2099-01-01T10:00:00Z', resolved_at: null }],
  });
  const { parks } = watchWrites(page);
  await openCheckin(page, B2);
  const modal = page.locator('#checkin-modal [role="dialog"]');
  await expect(modal).toContainText('Solo Badr');
  await expect(modal.getByRole('button', { name: 'To staff list' })).toHaveCount(0);
  await expect(modal.getByRole('button', { name: /Add a booking/ })).toBeVisible();

  await page.evaluate('closeCheckinModal()');
  await openCheckin(page, E5);
  await expect(modal).toContainText('Solo Eid');
  await modal.getByRole('button', { name: 'To staff list' }).click();
  await expect(modal).toBeHidden();
  await expect.poll(() => parks.map((p) => p.booking_id)).toEqual([E5]);
  await expect.poll(() => page.evaluate('S._ciId')).toBeNull();
});
