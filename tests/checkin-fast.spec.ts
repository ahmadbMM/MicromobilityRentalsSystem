import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Check-in is the desk's job, so it got two accelerants. The modal now offers the bike staff
// would have scrolled to anyway — free, right type, right size — as one button, claimed with
// the same compare-and-swap as a reservation so two tills cannot hand over one bike. And a
// party checks in as a chain: confirm one rider, the next one's modal opens by itself.

const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }];
const bikes = [
  { id: 'bM', name: 'R-11', type: 'Road', size: 'M', status: 'available', colors: [] },
  { id: 'bL', name: 'R-12', type: 'Road', size: 'L', status: 'available', colors: [] },
  { id: 'hS', name: 'H-01', type: 'Hybrid', size: 'S', status: 'available', colors: [] },
];
const e = (id: string, x: Record<string, unknown> = {}) => ({
  id, session_id: S1, session_day: 'Sunday', session_date: S1, queue_num: 1, name: 'R ' + id,
  phone: '0550000001', type_preference: 'Road', size: 'M', status: 'waiting', paid: false,
  price: 75, registered_at: '2099-01-01T10:00:00Z', ...x });

async function boot(page: import('@playwright/test').Page, queue_entries: Record<string, unknown>[],
                    bikesOverride?: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions, queue_entries, bikes: bikesOverride ?? bikes });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.waitForFunction(`getBikes().length>0`);   // the Bike field resolves against the fleet
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${S1}';renderStaffQueue()`);
  await page.waitForTimeout(250);
}

test('a party shows numbered steps and moves to the next rider after Confirm', async ({ page }) => {
  await boot(page, [
    e('p1', { group_id: 'grp', name: 'First Rider' }),
    e('p2', { group_id: 'grp', name: 'Second Rider', queue_num: 2 }),
    e('solo', { name: 'Solo', queue_num: 3 }),
  ]);
  await page.evaluate(`showCheckinModal('p1')`);
  const modal = page.locator('#checkin-modal');
  await expect(modal).toContainText('Rider 1 of 2');
  await expect(modal.getByRole('list', { name: 'Riders in this party' }).getByRole('button')).toHaveCount(2);
  await modal.locator('#ci-confirm').click();
  await expect(modal).toContainText('Second Rider');   // opened by itself
  await expect(modal).toContainText('Rider 2 of 2');
});

test('tapping a pending step jumps to that rider', async ({ page }) => {
  await boot(page, [
    e('p1', { group_id: 'grp', name: 'First Rider' }),
    e('p2', { group_id: 'grp', name: 'Second Rider', queue_num: 2 }),
  ]);
  await page.evaluate(`showCheckinModal('p1')`);
  const modal = page.locator('#checkin-modal');
  await modal.getByRole('list', { name: 'Riders in this party' }).getByRole('button', { name: /2 Second/ }).click();
  await expect(modal).toContainText('Second Rider');
  await expect(modal).toContainText('Rider 2 of 2');
});

test('No-show inside the modal marks the rider and moves on', async ({ page }) => {
  await boot(page, [
    e('p1', { group_id: 'grp', name: 'First Rider' }),
    e('p2', { group_id: 'grp', name: 'Second Rider', queue_num: 2 }),
  ]);
  const patches: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('queue_entries') && r.url().includes('id=eq.p1')) patches.push(r.postData() || ''); });
  await page.evaluate(`showCheckinModal('p1')`);
  const modal = page.locator('#checkin-modal');
  await modal.locator('#ci-out-noshow').click();                // chosen, like a payment…
  expect(patches.length).toBe(0);
  await modal.locator('#ci-confirm').click();                   // …and applied by Confirm
  await expect.poll(() => patches.some((b) => /"status":"noshow"/.test(b))).toBe(true);
  await expect(modal).toContainText('Second Rider');
});

test('Cancel booking inside the modal asks once, cancels, and moves on', async ({ page }) => {
  await boot(page, [
    e('p1', { group_id: 'grp', name: 'First Rider' }),
    e('p2', { group_id: 'grp', name: 'Second Rider', queue_num: 2 }),
  ]);
  const patches: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('queue_entries') && r.url().includes('id=eq.p1')) patches.push(r.postData() || ''); });
  await page.evaluate(`showCheckinModal('p1')`);
  const modal = page.locator('#checkin-modal');
  await modal.locator('#ci-out-cancel').click();
  await modal.locator('#ci-confirm').click();                   // Confirm asks for the cancel's own confirmation
  await page.locator('#confirm-modal, .modal-backdrop').last().getByRole('button', { name: 'Cancel booking' }).click();
  await expect.poll(() => patches.some((b) => /"status":"cancelled"/.test(b))).toBe(true);
  await expect(modal).toContainText('Second Rider');
});

test('a solo rider sees no party line', async ({ page }) => {
  await boot(page, [e('a')]);
  await page.evaluate(`showCheckinModal('a')`);
  await expect(page.locator('#checkin-modal')).not.toContainText('Rider 1 of');
});

// Switching between the members of a party keeps what was set for each of them, and a
// member marked no-show by mistake can be opened again from the step row and brought back.
test("switching riders keeps each rider's choices", async ({ page }) => {
  await boot(page, [
    e('p1', { group_id: 'grp', name: 'First Rider' }),
    e('p2', { group_id: 'grp', name: 'Second Rider', queue_num: 2 }),
  ]);
  await page.evaluate(`showCheckinModal('p1')`);
  const modal = page.locator('#checkin-modal');
  await modal.getByRole('button', { name: 'Pending', exact: true }).click();   // not the default, so keeping it proves something
  await modal.getByRole('button', { name: 'Hybrid', exact: true }).click();
  await modal.locator('#ci-bike').fill('R-11');
  await modal.getByRole('list', { name: 'Riders in this party' }).getByRole('button', { name: /2 Second/ }).click();
  await expect(modal).toContainText('Rider 2 of 2');
  expect(await page.evaluate('S._ciPaid')).toBe('card');        // the second rider starts fresh — on Paid, since 2026-09-24
  await modal.getByRole('list', { name: 'Riders in this party' }).getByRole('button', { name: /1 First/ }).click();
  await expect(modal).toContainText('Rider 1 of 2');
  expect(await page.evaluate('[S._ciPaid,S._ciType]')).toEqual(['pending', 'Hybrid']);
  await expect(modal.locator('#ci-bike')).toHaveValue('R-11');
});

test('a no-show member can be opened again and brought back to be checked in', async ({ page }) => {
  const rows = [
    e('p1', { group_id: 'grp', name: 'First Rider', status: 'noshow' }),
    e('p2', { group_id: 'grp', name: 'Second Rider', queue_num: 2 }),
  ];
  await boot(page, rows);
  // The stub echoes fixtures on every reload: once the reversal is written, the fixture follows it.
  await page.route(/\/rest\/v1\/queue_entries\?.*id=eq\.p1/, async (route) => {
    if (route.request().method() === 'PATCH' && /"status":"waiting"/.test(route.request().postData() || '')) rows[0].status = 'waiting';
    await route.fallback();
  });
  await page.evaluate(`showCheckinModal('p2')`);
  const modal = page.locator('#checkin-modal');
  const step1 = modal.getByRole('list', { name: 'Riders in this party' }).getByRole('button', { name: /✕ First/ });
  await expect(step1).toBeEnabled();
  await step1.click();
  await expect(modal).toContainText('is marked no-show');
  await modal.getByRole('button', { name: 'Customer Showed' }).click();
  await expect(modal).toContainText('Rider 1 of 2');
  await expect(modal.locator('#ci-confirm')).toBeVisible();     // back to a normal check-in
  await expect(modal.getByRole('list', { name: 'Riders in this party' }).getByRole('button', { name: /1 First/ })).toBeVisible();
});

// On the phone this modal is where the bike gets picked, so the rider's height is on it.
test("the modal shows the rider's height and size", async ({ page }) => {
  await boot(page, [e('solo', { name: 'Solo', height: 178, size: 'M' })]);
  await page.evaluate(`showCheckinModal('solo')`);
  await expect(page.locator('#checkin-modal .ci-height')).toHaveText('178 cm · M');
});

// The size is read off the owner's chart for the booked type (2026-09-29), not the size saved
// with the row: 182 cm is a Road L and a Hybrid M, and 140 cm is a Kids bike whatever was booked.
test('@staff:bookings the modal and the Bookings table show the size for the booked type', async ({ page }) => {
  await boot(page, [
    e('road', { name: 'Road Rider', height: 182, size: 'M' }),
    e('hyb', { name: 'Hybrid Rider', height: 182, size: 'M', type_preference: 'Hybrid', queue_num: 2 }),
    e('kid', { name: 'Kid Rider', height: 140, size: 'XS', queue_num: 3 }),
    e('any', { name: 'Any Rider', height: 182, size: 'M', type_preference: 'Any', queue_num: 4 }),
  ]);
  const sizeOf = (name: string) => page.locator('tr, .q-card, [class*="card"]').filter({ hasText: name }).locator('.q-size').first();
  await expect(sizeOf('Road Rider')).toHaveText('L');
  await expect(sizeOf('Hybrid Rider')).toHaveText('M');
  await expect(sizeOf('Kid Rider')).toHaveText('Kids');
  await expect(sizeOf('Any Rider')).toHaveText('Road L · Hybrid/Mountain M');
  await page.evaluate(`showCheckinModal('road')`);
  await expect(page.locator('#checkin-modal .ci-height')).toHaveText('182 cm · L');
});

test("the modal shows the rider's bike type beside the height, in the same big badge row", async ({ page }) => {
  await boot(page, [e('typed', { name: 'Typed', height: 178, size: 'M', type_preference: 'Hybrid' })]);
  await page.evaluate(`showCheckinModal('typed')`);
  const row = page.locator('#checkin-modal .ci-spec-row');
  await expect(row.locator('.ci-height')).toHaveText('178 cm · M');
  await expect(row.locator('.ci-type .type-badge')).toContainText('Hybrid');
});

// The amount on the modal follows the bike type picked there, the way Confirm would price it.
test("changing the bike type in the modal moves the rider's amount and the party total", async ({ page }) => {
  await boot(page, [
    e('p1', { group_id: 'grp', name: 'First Rider', price: 75 }),
    e('p2', { group_id: 'grp', name: 'Second Rider', queue_num: 2, price: 75 }),
  ]);
  await page.evaluate(`showCheckinModal('p1')`);
  const modal = page.locator('#checkin-modal');
  await modal.getByRole('button', { name: 'Pending', exact: true }).click(); // opens on Paid now; this is about the arithmetic
  const line = () => modal.locator('#ci-money').innerText().then(x => x.replace(/\s+/g, ' ').trim());
  await expect.poll(line).toBe('SAR 75 · party SAR 150 SAR 150 due');
  await modal.getByRole('button', { name: 'Hybrid', exact: true }).click();          // Road 75 -> Hybrid 57.5
  await expect.poll(line).toBe('SAR 57.50 · party SAR 132.50 SAR 132.50 due');
  await expect(modal.locator('label', { hasText: /^Payment/ })).toContainText('SAR 57.50');
  await modal.getByRole('button', { name: /On the house/ }).click();
  await expect.poll(line).toBe('SAR 0 ✓ Paid · party SAR 75 SAR 75 due');
});
