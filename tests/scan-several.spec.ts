import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }); // the camera takes today's tickets (KSA day)

// "Scan several": riders who booked apart but turn up together. Their tickets go on a list in
// the scanner, then "Check in N" runs them through the check-in modal as one group - steps, a
// shared total, the next rider opening by itself - the way a party already works. It stays a
// list in this tab: nothing is written to group_id and the bookings stay separate.
const row = (id: string, qn: number, name: string, groupId: string | null, status = 'waiting'): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Friday', session_date: today, queue_num: qn,
  name, phone: '', customer_id: null, group_id: groupId, status, paid: false,
  price: 30, walk_in: true, registered_at: '2099-01-01T10:00:00Z',
});
const q = [
  row('a1a1a1a1-0000-4000-8000-000000000001', 1, 'Solo Amal', null),
  row('b2b2b2b2-0000-4000-8000-000000000002', 2, 'Solo Badr', null),
  row('c3c3c3c3-0000-4000-8000-000000000003', 3, 'Party Cala', 'g1'),
  row('d4d4d4d4-0000-4000-8000-000000000004', 4, 'Party Dina', 'g1'),
  row('e5e5e5e5-0000-4000-8000-000000000005', 5, 'Solo Eid', null),
];
const sessions = [{ id: 's0', day: 'Friday', session_date: today, capacity: 12, status: 'open', created_at: 1 }];

// The stub serves its fixture rows as given, so a rider re-read after Confirm would come back
// 'waiting' and the run would loop back to them. Keep the writes, as the database would, on a
// fresh copy of the rows per test.
async function boot(page: Page, init: () => void) {
  const rows = q.map((r) => ({ ...r }));
  await stubSupabase(page, { queue_entries: rows, sessions });
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
  await page.addInitScript(init);
  await page.goto('/');
  await waitForSb(page);
}

async function openScanner(page: Page) {
  await page.evaluate(() => {
    // @ts-expect-error app globals
    S.staffTab = 'queue'; renderStaffQueue(); openScanModal();
  });
  // Headless has no camera: let its error land first so it cannot overwrite what a scan says.
  await expect(page.locator('#scan-msg')).toContainText(/camera/i, { timeout: 15000 });
}
const scan = (page: Page, code: string) => page.evaluate((c) => {
  // @ts-expect-error app global
  _onScanPayload(c);
}, code);

function watchWrites(page: Page) {
  const writes: Array<{ id: string; body: Record<string, unknown> }> = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
      if (id) writes.push({ id, body });
    }
  });
  return writes;
}

test('scanned tickets collect on a list and check in as one group, without becoming a group', async ({ page }) => {
  await boot(page, () => localStorage.setItem('cq_scan_multi', '0'));
  await openScanner(page);

  const scanner = page.locator('#scan-modal [role="dialog"]'); // the wrapper itself has no box: its backdrop is fixed
  const multi = scanner.getByRole('button', { name: 'Scan several' });
  await multi.click();
  await expect(multi).toHaveAttribute('aria-pressed', 'true');

  // Two solo tickets and one party member: the scanner stays open and lists them. The party
  // ticket brings its other member along (+1), as its own check-in would.
  await scan(page, 'MMC-1-a1a1a1');
  await expect(page.locator('#scan-msg')).toHaveText('Added #1 Solo Amal.');
  await scan(page, 'MMC-2-b2b2b2');
  await scan(page, 'MMC-3-c3c3c3');
  const list = scanner.getByRole('list', { name: 'Riders checking in together' });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await expect(list.getByRole('listitem').nth(2)).toContainText('+1');
  // The party's other ticket is already covered, and a bike sticker would drop the list.
  await scan(page, 'MMC-4-d4d4d4');
  await expect(page.locator('#scan-msg')).toHaveText('#4 Party Dina is already on the list.');
  await scan(page, 'https://micromobilityrentals.pages.dev/?bike=42');
  await expect(page.locator('#scan-msg')).toContainText('Only tickets go on the list');
  await expect(scanner).toBeVisible();
  // A ticket taken off the list is gone from the count.
  await scan(page, 'MMC-5-e5e5e5');
  await expect(scanner.getByRole('button', { name: 'Check in 5' })).toBeVisible();
  await list.getByRole('button', { name: /Remove #5/ }).click();
  const go = scanner.getByRole('button', { name: 'Check in 4' });
  await expect(go).toBeVisible();

  const writes = watchWrites(page);
  await go.click();
  await expect(scanner).toBeHidden();

  // One modal, four steps, a shared total - the party treatment for riders who booked apart.
  const modal = page.locator('#checkin-modal [role="dialog"]'); // as with the scanner, the wrapper has no box
  await expect(modal).toContainText('Solo Amal');
  await expect(modal).toContainText('Rider 1 of 4');
  const steps = modal.getByRole('list', { name: 'Riders checking in together' }).getByRole('button');
  await expect(steps).toHaveCount(4);
  await expect(modal.locator('#ci-money')).toContainText('all SAR 120');

  for (const [i, next] of [['1', 'Solo Badr'], ['2', 'Party Cala'], ['3', 'Party Dina']] as const) {
    await modal.locator('#ci-confirm').click();
    await expect(modal).toContainText(next);
    await expect(modal).toContainText(`Rider ${Number(i) + 1} of 4`);
  }
  await modal.locator('#ci-confirm').click();
  await expect(modal).toBeHidden();

  await expect.poll(() => writes.filter((w) => w.body.status === 'active').map((w) => w.id.slice(0, 2)))
    .toEqual(['a1', 'b2', 'c3', 'd4']);
  expect(writes.some((w) => 'group_id' in w.body)).toBe(false); // never grouped in the data
  expect(writes.some((w) => w.id.startsWith('e5'))).toBe(false); // taken off the list, untouched
  // The run is over: the scanned group is forgotten, so a later check-in is on its own again.
  await expect.poll(() => page.evaluate('S._ciBatch')).toBeNull(); // after Confirm's tail (row reload) settles
});

test('with Keep scanning, the camera waits for the last rider of the group instead of covering the next', async ({ page }) => {
  await boot(page, () => { localStorage.setItem('cq_scan_multi', '1'); localStorage.setItem('cq_scan_cont', '1'); });
  await openScanner(page);

  await scan(page, 'MMC-1-a1a1a1');
  await scan(page, 'MMC-5-e5e5e5');
  const scanner = page.locator('#scan-modal [role="dialog"]'); // the wrapper itself has no box: its backdrop is fixed
  await scanner.getByRole('button', { name: 'Check in 2' }).click();

  const modal = page.locator('#checkin-modal [role="dialog"]'); // as with the scanner, the wrapper has no box
  await expect(modal).toContainText('Solo Amal');
  await modal.locator('#ci-confirm').click();
  await expect(modal).toContainText('Solo Eid');
  await page.waitForTimeout(300); // past the scanner's 80 ms reopen
  await expect(scanner).toBeHidden();

  await modal.locator('#ci-confirm').click();
  await expect(modal).toBeHidden();
  await expect(scanner).toBeVisible(); // back for the next arrivals, list empty, tally kept
  await expect(scanner.getByRole('list', { name: 'Riders checking in together' })).toHaveCount(0);
  await expect(page.locator('#scan-tally')).toHaveText('2 checked in');
});

test('with Scan several off, a ticket still opens its check-in straight away', async ({ page }) => {
  await boot(page, () => localStorage.setItem('cq_scan_multi', '0'));
  await openScanner(page);
  await scan(page, 'MMC-2-b2b2b2');
  await expect(page.locator('#scan-modal [role="dialog"]')).toHaveCount(0);
  const modal = page.locator('#checkin-modal [role="dialog"]'); // as with the scanner, the wrapper has no box
  await expect(modal).toContainText('Solo Badr');
  await expect(modal.getByRole('list')).toHaveCount(0); // a solo rider: no steps
});
