import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The wrong ticket of the right rider (2026-10-11): an account booked on today's ride and a later one
// showed the later ticket (its Wallet pass, added last, sits on top) and the camera answered "not today",
// whose only button opened the later ride. A ticket for another day whose account is expected today opens
// today's booking and says so; a ticket whose account has nothing today is still refused. Invented riders.
const ksa = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const shift = (iso: string, n: number) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const TODAY = ksa(new Date()), WK = shift(TODAY, 7);
const sessions = [
  { id: TODAY, day: 'Saturday', session_date: TODAY, capacity: 50, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: false, spots: 50, bike_slots: '{"_time":"06:00 - 08:00"}' },
  { id: WK + '-rh', day: 'Saturday', session_date: WK, capacity: 50, status: 'open', created_at: 2, event_kind: 'community', ride_kind: 'runher', needs_approval: false, hide_queue: true, spots: 50, bike_slots: '{"_time":"06:00 - 08:00"}' },
];
const row = (id: string, sid: string, date: string, qn: number, name: string, cust: string, over: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Saturday', session_date: date, queue_num: qn, name, phone: '', customer_id: cust, group_id: null,
  status: 'waiting', paid: false, price: 0, type_preference: 'Road', size: 'S', registered_at: '2099-01-01T10:00:00Z', ...over,
});
const q = [
  row('aaaa11pmuqqt0b9', TODAY, TODAY, 13, 'Rana Rider', 'c1', { approval: 'approved' }),
  row('bbbb22mmuvrkom4', WK + '-rh', WK, 44, 'Rana Rider', 'c1', { type_preference: 'None', size: '' }),
  row('cccc33mmuvrkom5', WK + '-rh', WK, 45, 'Lina Later', 'c2', { type_preference: 'None', size: '' }),
];

async function boot(page: Page) {
  await stubSupabase(page, { queue_entries: q.map((r) => ({ ...r })), sessions, bikes: [] });
  await unlockStaff(page);
  await page.addInitScript(() => localStorage.setItem('cq_scan_multi', '0'));
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded===true');
}
async function openScanner(page: Page) {
  await page.evaluate(`S.staffTab='queue';renderStaffQueue();openScanModal()`);
  await expect(page.locator('#scan-msg')).toContainText(/camera/i, { timeout: 15000 });
}
const scan = (page: Page, code: string) => page.evaluate(`_onScanPayload(${JSON.stringify(code)})`);

test('a later ride\'s ticket of a rider booked today opens today\'s check-in and says so', async ({ page }) => {
  await boot(page);
  await openScanner(page);
  await scan(page, 'MMC-44-bbbb22');
  const checkin = page.locator('#checkin-modal [role="dialog"]');
  await expect(checkin).toContainText('Rana Rider');
  expect(await page.evaluate('S._ciId')).toBe('aaaa11pmuqqt0b9');
  await expect(page.locator('.toast, #toast-container').filter({ hasText: 'Opened their booking for today' }).first()).toBeVisible();
  await expect(page.locator('#scan-exception-btn')).toHaveCount(0);
});

test('a later ride\'s ticket of a rider with nothing today is still refused', async ({ page }) => {
  await boot(page);
  await openScanner(page);
  await scan(page, 'MMC-45-cccc33');
  await expect(page.locator('#scan-msg')).toContainText('not today');
  await expect(page.locator('#scan-exception-btn')).toHaveText('Make an exception');
  expect(await page.evaluate('S._ciId')).toBeFalsy();
});

test('a scanner gun typing the later ticket into the search opens today\'s booking too', async ({ page }) => {
  await boot(page);
  await page.evaluate(`S.staffTab='queue';S.sfSession='all';renderStaffQueue()`);
  await page.evaluate(`S.sfSearch='MMC-44-bbbb22';sfSearchEnter()`);
  await expect(page.locator('#checkin-modal [role="dialog"]')).toContainText('Rana Rider');
  expect(await page.evaluate('S._ciId')).toBe('aaaa11pmuqqt0b9');
});
