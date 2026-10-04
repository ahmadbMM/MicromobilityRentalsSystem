import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, checkinAsRow } from './helpers/supabase';

// The check-in modal's money line for a party (or a scanned group). Stepping through riders
// must not move the amounts: the total used to price the OPEN rider as Confirm would charge
// them and everyone else at their booked fare, so a rider whose fare changes at check-in - a
// house-covered rider, most visibly - made the party total jump as staff clicked along the
// steps, with nothing changed. Every rider is now priced the one way.
const sessions = [
  { id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 20, status: 'open', created_at: 1 },
  { id: 'sp', day: 'Tuesday', session_date: '2099-02-11', capacity: 20, status: 'open', created_at: 2, event_kind: 'community', ride_kind: 'petromin', paid_ride: true },
];
const e = (id: string, x: Record<string, unknown> = {}) => ({
  id, session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: 1,
  name: 'R ' + id, phone: '', customer_id: null, group_id: 'g1', status: 'waiting', paid: false,
  type_preference: 'Any', price: 57.5, size: 'M', registered_at: '2099-01-01T10:00:00Z', ...x,
});

async function boot(page: Page, rows: Record<string, unknown>[], customers: Record<string, unknown>[] = []) {
  await stubSupabase(page, { queue_entries: rows, sessions, customers });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
}
const open = (page: Page, id: string) => page.evaluate((i) => {
  // @ts-expect-error app global
  showCheckinModal(i);
}, id);
// An unpaid rider now opens on Paid (2026-09-24). These tests are about the arithmetic, so they
// start such a rider from Pending, where the modal used to open.
const openPending = async (page: Page, id: string) => {
  await open(page, id);
  if (!(await page.evaluate(`!!getQueue().find(e=>e.id===${JSON.stringify(id)}).paid`)))
    await page.locator('#checkin-modal').getByRole('button', { name: 'Pending', exact: true }).click();
};
const money = async (page: Page) => ((await page.locator('#ci-money').textContent()) || '').replace(/\s+/g, ' ').trim();

test('a house-covered rider does not move the party total as staff step through the riders', async ({ page }) => {
  // The covered rider rides free, so the party owes the other rider's fare - from either step.
  await boot(page, [
    e('p1', { queue_num: 1, customer_id: 'c1', name: 'House Rider' }),
    e('p2', { queue_num: 2 }),
  ], [{ id: 'c1', name: 'House Rider', default_pay: 'house', email: 'h@x.com', phone: '' }]);

  await openPending(page, 'p1');
  expect(await money(page)).toContain('SAR 0');
  expect(await money(page)).toContain('party SAR 57.50');
  await openPending(page, 'p2');
  expect(await money(page)).toContain('party SAR 57.50'); // was SAR 115: the covered rider counted twice over
  expect(await money(page)).toContain('SAR 57.50 due');
});

test('an ordinary party reads the same from every step', async ({ page }) => {
  await boot(page, [
    e('p1', { queue_num: 1, type_preference: 'Road', price: 75 }),
    e('p2', { queue_num: 2 }),
    e('p3', { queue_num: 3, paid: true }),
  ]);
  const seen: string[] = [];
  for (const id of ['p1', 'p2', 'p3']) { await openPending(page, id); seen.push(await money(page)); }
  expect(seen.map((s) => s.slice(s.indexOf('party')))).toEqual([
    'party SAR 190SAR 132.50 due', 'party SAR 190SAR 132.50 due', 'party SAR 190SAR 132.50 due',
  ]);
});

test('marking one rider paid is the only thing that moves the total', async ({ page }) => {
  await boot(page, [e('p1', { queue_num: 1 }), e('p2', { queue_num: 2 })]);
  await openPending(page, 'p1');
  expect(await money(page)).toContain('SAR 115 due');
  await page.locator('#checkin-modal').getByRole('button', { name: '✓ Paid', exact: true }).click();
  expect(await money(page)).toContain('SAR 57.50 due');
  await openPending(page, 'p2'); // the choice is still only a draft, but the line keeps telling the truth about it
  expect(await money(page)).toContain('SAR 57.50 due');
});

async function bootWith(page: Page, rows: Record<string, unknown>[], rider_registrations: Record<string, unknown>[]) {
  await stubSupabase(page, { queue_entries: rows, sessions, customers: [], rider_registrations });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0');
}
const petro = (id: string, x: Record<string, unknown>) =>
  e(id, { session_id: 'sp', session_date: '2099-02-11', session_day: 'Tuesday', ...x });
// q1 came through the company's registration form; q2 booked the same night on the website.
const employeeOf = (entry: string) => [{ id: 1, badge: 'B1', name: 'R ' + entry, type_preference: 'Hybrid',
  source: 'petromin', session_id: 'sp', matched_entry_id: entry, match_kind: 'booking', party_no: 1, booking_no: 'P-001' }];

test('a Petromin employee retyped at check-in keeps the employee fare', async ({ page }) => {
  await bootWith(page, [petro('q1', { queue_num: 1, price: 50 }), petro('q2', { queue_num: 2, price: 57.5 })], employeeOf('q1'));
  const patched: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries') && r.url().includes('id=eq.q1')) {
      try { patched.push(r.postDataJSON()); } catch { /* not JSON */ }
    }
    const ci = checkinAsRow(r, 'q1'); if (ci) { delete ci.id; patched.push(ci); }
  });
  await open(page, 'q1'); // the registrations are not loaded yet: opening the rider fetches them
  const modal = page.locator('#checkin-modal');
  await modal.getByRole('button', { name: 'Mountain', exact: true }).click();
  await expect(page.locator('#ci-money')).toContainText('SAR 50');
  await expect(page.locator('#ci-money')).toContainText('party SAR 107.50'); // the website booker beside them pays 57.50
  await modal.locator('#ci-confirm').click();
  // The booked 50 stands, so there is no price to rewrite.
  await expect.poll(() => patched.some((p) => p.status === 'active')).toBe(true);
  expect(patched.filter((p) => 'price' in p).map((p) => p.price)).toEqual([]);
});

test('a website booking on a Petromin night is retyped at the standard fare, not the employees’', async ({ page }) => {
  await bootWith(page, [petro('q1', { queue_num: 1, price: 50 }), petro('q2', { queue_num: 2, price: 50 })], employeeOf('q2'));
  const patched: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries') && r.url().includes('id=eq.q1')) {
      try { patched.push(r.postDataJSON()); } catch { /* not JSON */ }
    }
    const ci = checkinAsRow(r, 'q1'); if (ci) { delete ci.id; patched.push(ci); }
  });
  await open(page, 'q1');
  await page.waitForFunction('S.ridersLoaded');
  const modal = page.locator('#checkin-modal');
  await modal.getByRole('button', { name: 'Mountain', exact: true }).click();
  await expect(page.locator('#ci-money')).toContainText('SAR 57.50');
  await modal.locator('#ci-confirm').click();
  await expect.poll(() => patched.some((p) => p.status === 'active')).toBe(true);
  expect(patched.filter((p) => 'price' in p).map((p) => p.price)).toEqual([57.5]);
});
