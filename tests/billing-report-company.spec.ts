import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Petromin and Petrolube are invoiced separately, so the billing report is one per company.
// A returned ride with no company would be on neither, so the dialog names it and links to
// its editor instead of letting it drop out of both invoices unseen.

const SESS = '2099-02-08-pw';
const sessions = [{
  id: SESS, day: 'Wednesday', session_date: '2099-02-08', capacity: 35, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 35 }), event_kind: 'community',
  ride_kind: 'petromin', paid_ride: true, needs_approval: false, hide_queue: false, title: "Petromin's Wednesdays",
}];
const done = { source: 'petromin', session_id: SESS, created_at: '2099-02-08T09:00:00Z', updated_at: '2099-02-08T09:00:00Z',
  checked_in_at: '2099-02-08T16:00:00Z', checked_out_at: '2099-02-08T17:30:00Z', checked_in_by: 'Desk', checked_out_by: 'Desk',
  height: 170, phone: '+966500000001', submissions: 1, match_kind: 'none', matched_entry_id: null, matched_customer_id: null };
const rider_registrations = [
  { ...done, id: 1, booking_no: 'P-001', badge: 'A-1', company: 'Petromin', name: 'Min Road', type_preference: 'Road', price: 75 },
  { ...done, id: 2, booking_no: 'P-002', badge: 'A-2', company: 'Petromin', name: 'Min Hybrid', type_preference: 'Hybrid', price: 50 },
  { ...done, id: 3, booking_no: 'P-003', badge: 'A-3', company: 'Petromin', name: 'Min Old Fare', type_preference: 'Hybrid', price: 57.5 },
  { ...done, id: 4, booking_no: 'P-004', badge: 'B-1', company: 'Petrolube', name: 'Lube Hybrid', type_preference: 'Hybrid', price: 50 },
  { ...done, id: 5, booking_no: 'P-005', badge: 'C-1', company: null, name: 'No Company', type_preference: 'Hybrid', price: 50 },
  { ...done, id: 6, booking_no: 'P-006', badge: 'A-4', company: 'Petromin', name: 'Still Riding', type_preference: 'Road', price: null, checked_out_at: null },
];

async function openReport(page: Page) {
  await stubSupabase(page, { sessions, queue_entries: [], rider_registrations });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('riders')`);
  await expect(page.locator('#pm-host tbody tr').first()).toBeVisible();
  await page.locator('#pm-host button[data-on-click*="openRidersReport"]').click();
  await expect(page.locator('#rider-report-modal .modal-box')).toBeVisible();
}

/** The printed report's HTML, captured instead of opening a window. */
function reportHtml(page: Page, co: string) {
  return page.evaluate(`(() => {
    let cap = '';
    const orig = window.open;
    window.open = () => ({ document: { write: (h) => { cap = h; }, close() {} }, focus() {}, print() {}, close() {} });
    try { printRidersReport('${co}'); } finally { window.open = orig; }
    return cap;
  })()`) as Promise<string>;
}

test('the dialog gives each company its own count and total', async ({ page }) => {
  await openReport(page);
  const min = page.locator('.rider-rep-co[data-co="Petromin"]'), lube = page.locator('.rider-rep-co[data-co="Petrolube"]');
  await expect(min).toContainText('Completed rides: 3');          // still-riding P-006 is not billed
  await expect(min).toContainText('SAR 182.50');                 // 75 + 50 + 57.5
  await expect(lube).toContainText('Completed rides: 1');
  await expect(lube).toContainText('SAR 50.00');
});

test('each printed report holds only its own company\'s rides', async ({ page }) => {
  await openReport(page);
  const min = await reportHtml(page, 'Petromin');
  expect(min).toContain('Min Road');
  expect(min).toContain('Min Old Fare');
  expect(min).not.toContain('Lube Hybrid');
  expect(min).not.toContain('No Company');
  expect(min).not.toContain('Still Riding');
  expect(min).toContain('182.50');
  expect(min).toMatch(/Billing report/);
  expect(min).toMatch(/<div class="mm-title"><strong>Petromin &middot; /); // the company heads the title line
  // one tile per fare actually charged, not a fixed price per type
  expect(min).toMatch(/Hybrid · <bdi>SAR 57\.50</);
  expect(min).toMatch(/Hybrid · <bdi>SAR 50\.00</);
  const lube = await reportHtml(page, 'Petrolube');
  expect(lube).toContain('Lube Hybrid');
  expect(lube).not.toContain('Min Road');
  expect(lube).toContain('<title>Petrolube');
});

test('the CSV is per company and named for it', async ({ page }) => {
  await openReport(page);
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('.rider-rep-co[data-co="Petrolube"] button', { hasText: 'CSV' }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^petrolube-report-/);
  const text = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8'));
  expect(text).toContain('Lube Hybrid');
  expect(text).not.toContain('Min Road');
  expect(text).toMatch(/TOTAL,50\.00/);
});

test('a ride with no company is flagged and links to its editor', async ({ page }) => {
  await openReport(page);
  const warn = page.locator('#rider-rep-noco');
  await expect(warn).toContainText('no company');
  await warn.getByRole('button', { name: 'P-005' }).click();
  await expect(page.locator('#rider-report-modal .modal-box')).toHaveCount(0);
  await expect(page.locator('#rw-name')).toHaveValue('No Company');
});

test('a company with nothing to bill cannot print an empty report; Escape closes', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], rider_registrations: rider_registrations.filter((r) => r.company !== 'Petrolube') });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('riders');openRidersReport()`);
  // Petromin first: its button turns on once the riders are in, and only then does a disabled
  // Petrolube button say anything (before the list arrives, every button is off).
  await expect(page.locator('.rider-rep-co[data-co="Petromin"] button').first()).toBeEnabled();
  await expect(page.locator('.rider-rep-co[data-co="Petrolube"] button').first()).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('#rider-report-modal .modal-box')).toHaveCount(0);
});

test('a report opened before the riders arrive fills in when they do', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], rider_registrations });
  // The list is held back until the report is on screen: a busy phone opens it that early,
  // and the report used to stay at nothing to bill for as long as it was open.
  let release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route(/\/rest\/v1\/rider_registrations/, async (route) => { await held; await route.fallback(); });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('riders');openRidersReport()`);
  const min = page.locator('.rider-rep-co[data-co="Petromin"]');
  await expect(min).toContainText('Completed rides: 0');
  await expect(min.locator('button').first()).toBeDisabled();
  release();
  await expect(min).toContainText('Completed rides: 3');
  await expect(min.locator('button').first()).toBeEnabled();
  await expect(page.locator('#rider-rep-noco')).toContainText('no company');
});
