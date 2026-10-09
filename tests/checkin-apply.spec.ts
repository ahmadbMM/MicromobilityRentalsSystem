import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The check-in modal, 2026-09-24: the outcome — Check in, Waiting, No-show, Cancel booking — is
// chosen like the payment is, one row of choices each in its own colour, and nothing happens on the
// choice: Confirm applies it together with the payment, bike type and bike. Every button in the
// modal is the same size as the ones beside it.

const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
const entry = {
  id: 'e1', session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: 7, name: 'Quick Rider',
  phone: '0500000001', customer_id: null, type_preference: 'Any', size: 'M', status: 'waiting', paid: false, price: 60,
  height: 178, registered_at: '2099-02-10T10:00:00Z',
};
const bikes = [{ id: 'b1', name: 'R-01', type: 'Road', size: 'M', status: 'available', colors: [] }];

type P = import('@playwright/test').Page;
async function open(page: P) {
  await stubSupabase(page, { sessions, queue_entries: [entry], bikes });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`showCheckinModal('e1')`);
  const modal = page.locator('#checkin-modal');
  await expect(modal.getByText('#7 Quick Rider')).toBeVisible();
  const patches: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries') && r.url().includes('id=eq.e1')) patches.push(r.postDataJSON());
    // a check-in is one staff_checkin call carrying the payment (2026-10-04): read as the row it writes
    if (r.url().includes('/rest/v1/rpc/staff_checkin')) { const b = r.postDataJSON(); if (b.p_booking_id === 'e1') patches.push({ status: 'active', assigned_bike_id: b.p_bike_id, paid: b.p_paid, price: b.p_price, type_preference: b.p_type, pay_method: b.p_pay_method }); }
  });
  return { modal, patches };
}

test('Waiting keeps the payment and type it was given, and Confirm leaves the rider waiting', async ({ page }) => {
  const { modal, patches } = await open(page);
  await modal.getByRole('button', { name: '✓ Paid', exact: true }).click();
  await modal.getByRole('button', { name: 'Road', exact: true }).click();
  await modal.locator('#ci-out-waiting').click();
  await expect(modal.locator('.modal-box')).toBeVisible();   // choosing does nothing on its own
  await modal.locator('#ci-confirm').click();
  await expect(modal).toBeHidden();

  await expect.poll(() => patches.length).toBeGreaterThanOrEqual(1);
  expect(patches[0].status).toBeUndefined();        // nobody was checked in
  expect(patches[0].paid).toBe(true);
  expect(patches[0].type_preference).toBe('Road');
  expect(await page.evaluate(`getQueue().find(e=>e.id==='e1').status`)).toBe('waiting');
});

test('the four outcomes are one row of choices, Check in first and chosen, and Confirm applies it', async ({ page }) => {
  const { modal, patches } = await open(page);
  const outs = modal.locator('.ci-outcomes .ci-out');
  await expect(outs).toHaveText(['Check In', 'Save, check in later', 'No-Show', 'Cancel booking']);
  await expect(modal.locator('#ci-out-checkin')).toHaveAttribute('aria-checked', 'true');
  // choosing another and coming back moves the choice, and touches nothing on the server
  await modal.locator('#ci-out-noshow').click();
  await expect(modal.locator('#ci-out-noshow')).toHaveAttribute('aria-checked', 'true');
  await expect(modal.locator('#ci-out-checkin')).toHaveAttribute('aria-checked', 'false');
  await modal.locator('#ci-out-checkin').click();
  expect(patches.length).toBe(0);
  await modal.locator('#ci-confirm').click();
  await expect(modal).toBeHidden();
  await expect.poll(() => patches.length).toBeGreaterThanOrEqual(1);
  expect(patches[0].status).toBe('active');
});

test('No-show chosen and confirmed marks the rider a no-show', async ({ page }) => {
  const { modal, patches } = await open(page);
  await modal.locator('#ci-out-noshow').click();
  expect(patches.length).toBe(0);                              // the choice alone writes nothing
  await modal.locator('#ci-confirm').click();
  await expect.poll(() => patches.some((b) => b.status === 'noshow')).toBe(true);
});

test('every button in the modal matches the ones beside it, each outcome in its own colour', async ({ page }) => {
  const { modal } = await open(page);
  const same = (w: number[]) => { expect(w.length).toBeGreaterThan(1); expect(Math.max(...w) - Math.min(...w)).toBeLessThanOrEqual(1); };
  const widths = (loc: import('@playwright/test').Locator) => loc.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  same(await widths(modal.locator('.ci-outcomes .ci-out')));   // Check In · Waiting · No-Show · Cancel booking
  same(await widths(modal.locator('.modal-footer > button')));  // Close · Confirm
  for (const g of await modal.locator('.ci-opts').all()) same(await widths(g.locator('.toggle-btn')));
  const colours = await modal.locator('.ci-outcomes .ci-out').evaluateAll((els) => els.map((e) => getComputedStyle(e).borderTopColor));
  expect(new Set(colours).size).toBe(4);                      // four outcomes, four colours
  for (const b of await modal.locator('.ci-out, .modal-footer > button, .ci-opts .toggle-btn').all()) {
    expect(await b.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  }
});

// 2026-09-24: the payment reads just "Paid", an unpaid rider opens on it, and a bike owner — who
// rents nothing — is shown Free, with no payment to choose, in the modal and on the roster.
test('an unpaid rider opens on Paid, and the option says Paid without "Card"', async ({ page }) => {
  const { modal } = await open(page);
  const paid = modal.getByRole('button', { name: '✓ Paid', exact: true });
  await expect(paid).toHaveClass(/\bactive\b/);
  await expect(modal).not.toContainText('Card');
});

test('a bike owner has no payment to choose: Free in the modal, Free on the roster', async ({ page }) => {
  const owner = { ...entry, id: 'o1', queue_num: 8, name: 'Owner Rider', type_preference: 'Own', price: 0 };
  await stubSupabase(page, { sessions, queue_entries: [entry, owner], bikes });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='s0';renderStaffQueue()`);
  await expect.poll(() => page.evaluate(`document.getElementById('q-results').innerText`)).toContain('Owner Rider');
  expect(await page.evaluate(`_ownFree(getQueue().find(e=>e.id==='o1'))`)).toBe(true);
  const results = await page.evaluate(`document.getElementById('q-results').innerText`) as string;
  expect(results).toContain('Free');
  await page.evaluate(`showCheckinModal('o1')`);
  const modal = page.locator('#checkin-modal');
  await expect(modal.locator('#ci-money')).toHaveText('Free');
  await expect(modal.getByRole('button', { name: '✓ Paid', exact: true })).toHaveCount(0);
  await expect(modal.getByRole('button', { name: 'Pending', exact: true })).toHaveCount(0);
  // switched to a rented bike in the modal, there is something to pay again
  await modal.getByRole('button', { name: 'Road', exact: true }).click();
  await expect(modal.getByRole('button', { name: '✓ Paid', exact: true })).toBeVisible();
});

test('the members-only dialog has one button, Apply, that fits its text', async ({ page }) => {
  await stubSupabase(page, { sessions: [{ ...sessions[0], id: 'comm1', event_kind: 'community', needs_approval: true, hide_queue: true, title: 'Saturday Social Ride' }], queue_entries: [] });
  await page.addInitScript(() => localStorage.setItem('cq_session', JSON.stringify({ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', session_token: 'tok-spec' })));
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`selectEvent('community')`);
  const row = page.locator('#confirm-modal .cm-actions');
  await expect(row.locator('a, button')).toHaveCount(1); // the owner, 2026-09-30: only Apply
  await expect(row.locator('button')).toHaveText('Apply for MicroMobility’s Community Membership');
  for (const b of await row.locator('a, button').all()) {
    expect(await b.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  }
});
