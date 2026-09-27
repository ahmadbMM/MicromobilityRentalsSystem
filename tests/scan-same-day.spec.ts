import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The camera takes tickets for today's ride only (2026-09-28). A ticket for another day is not
// acted on: the message names the ride it is for and how far off it is, and "Make an exception"
// carries on exactly as the scan would have - the check-in, the Scan several list, the open
// check-in's run. The offer is for the last ticket scanned and goes with the next scan or the
// camera closing. "Today" is the KSA calendar day, as everywhere in the app.
const ksa = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const shift = (iso: string, n: number) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const TODAY = ksa(new Date()), TOMORROW = shift(TODAY, 1), NEXT_WEEK = shift(TODAY, 7);
const sess = (id: string, date: string) => ({ id, day: 'Friday', session_date: date, capacity: 12, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 12 }), location: 'JCC', addons: null });
const sessions = [sess('sT', TODAY), sess('sM', TOMORROW), sess('sW', NEXT_WEEK)];
const T1 = 'a1a1a1a1-0000-4000-8000-000000000001', T2 = 'b2b2b2b2-0000-4000-8000-000000000002', T3 = 'c3c3c3c3-0000-4000-8000-000000000003';
const row = (id: string, qn: number, name: string, sid: string, date: string): Record<string, unknown> => ({
  id, session_id: sid, session_day: 'Friday', session_date: date, queue_num: qn, name, phone: '', customer_id: null,
  group_id: null, status: 'waiting', paid: false, price: 30, walk_in: true, registered_at: '2099-01-01T10:00:00Z',
});
const q = [row(T1, 1, 'Today Tala', 'sT', TODAY), row(T2, 2, 'Tomorrow Tariq', 'sM', TOMORROW), row(T3, 3, 'Later Lina', 'sW', NEXT_WEEK)];

async function boot(page: Page, init: () => void) {
  await stubSupabase(page, { queue_entries: q.map((r) => ({ ...r })), sessions });
  await unlockStaff(page);
  await page.addInitScript(init);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded===true');
}
async function openScanner(page: Page) {
  await page.evaluate(`S.staffTab='queue';renderStaffQueue();openScanModal()`);
  await expect(page.locator('#scan-msg')).toContainText(/camera/i, { timeout: 15000 }); // headless has no camera: its error first
}
const scan = (page: Page, code: string) => page.evaluate(`_onScanPayload(${JSON.stringify(code)})`);

test('a ticket for tomorrow is named and waits; the exception opens its check-in; a ticket for today needs none', async ({ page }) => {
  await boot(page, () => localStorage.setItem('cq_scan_multi', '0'));
  await openScanner(page);
  const scanner = page.locator('#scan-modal [role="dialog"]'), msg = page.locator('#scan-msg');
  const checkin = page.locator('#checkin-modal [role="dialog"]');
  await scan(page, 'MMC-2-b2b2b2');
  await expect(msg).toContainText('not today');
  await expect(msg).toContainText('Tomorrow');
  await expect(msg).toContainText('9 PM - 11 PM'); // which ride it is for
  const except = page.locator('#scan-exception-btn');
  await expect(except).toHaveText('Make an exception');
  await expect(checkin).toHaveCount(0); // nothing happened yet
  await expect(scanner).toBeVisible();
  await except.click();
  await expect(checkin).toContainText('Tomorrow Tariq');
  await expect(scanner).toBeHidden();
  expect(await page.evaluate('_scanExcept')).toBeNull();

  await page.evaluate('closeCheckinModal()');
  await openScanner(page);
  await scan(page, 'MMC-1-a1a1a1');
  await expect(checkin).toContainText('Today Tala'); // today's ticket, straight through
  await expect(page.locator('#scan-exception-btn')).toHaveCount(0);
});

test('the offer is for the last ticket scanned, and the wording counts the days either way', async ({ page }) => {
  await boot(page, () => localStorage.setItem('cq_scan_multi', '0'));
  await openScanner(page);
  const msg = page.locator('#scan-msg');
  await scan(page, 'MMC-3-c3c3c3');
  await expect(msg).toContainText('in 7 days');
  await scan(page, 'MMC-2-b2b2b2');
  await expect(msg).toContainText('Tomorrow');
  await expect(page.locator('#scan-exception-btn')).toHaveCount(1);
  await page.locator('#scan-exception-btn').click();
  await expect(page.locator('#checkin-modal [role="dialog"]')).toContainText('Tomorrow Tariq'); // the last one, not Lina
  expect(await page.evaluate(`[_scanOffToday(${JSON.stringify(shift(TODAY, -1))}),_scanOffToday(${JSON.stringify(shift(TODAY, -7))}),_scanOffToday(${JSON.stringify(TODAY)})]`))
    .toEqual(['Yesterday', '7 days ago', '']);
});

test('in Scan several, the exception puts the ticket on the list', async ({ page }) => {
  await boot(page, () => localStorage.setItem('cq_scan_multi', '1'));
  await openScanner(page);
  const scanner = page.locator('#scan-modal [role="dialog"]');
  await scan(page, 'MMC-3-c3c3c3');
  await expect(page.locator('#scan-msg')).toContainText('not today');
  await expect(scanner.getByRole('list', { name: 'Riders checking in together' })).toHaveCount(0);
  await page.locator('#scan-exception-btn').click();
  await expect(page.locator('#scan-msg')).toHaveText('Added #3 Later Lina.');
  await expect(scanner.getByRole('list', { name: 'Riders checking in together' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.locator('#scan-exception-btn')).toHaveCount(0); // used up
  await expect(scanner).toBeVisible();
});

test("from a check-in's Add a booking, a ticket for another day waits the same way and the exception adds it to the run", async ({ page }) => {
  await boot(page, () => localStorage.setItem('cq_scan_multi', '0'));
  await page.evaluate(`S.staffTab='queue';renderStaffQueue();showCheckinModal('${T1}')`);
  const modal = page.locator('#checkin-modal [role="dialog"]');
  await modal.getByRole('button', { name: /Add a booking/ }).click();
  await expect(page.locator('#scan-msg')).toContainText(/camera/i, { timeout: 15000 });
  await scan(page, 'MMC-2-b2b2b2');
  await expect(page.locator('#scan-msg')).toContainText('not today');
  await page.locator('#scan-exception-btn').click();
  await expect(page.locator('#scan-msg')).toHaveText('Added #2 Tomorrow Tariq.');
  const scanner = page.locator('#scan-modal [role="dialog"]');
  await expect(scanner.getByRole('list', { name: 'Riders checking in together' }).getByRole('listitem')).toHaveCount(2);
});
