import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Reserve bike without choosing one, and by the bike's number (the owner, 2026-10-07: "change the reserve bike
// to not force the staff to choose a bike and add a bike number option when choosing a bike"). With nothing
// picked, Reserve bike reserves the booking (reserved); a typed number the fleet has picks that bike; one it
// does not have is kept on the booking (reserved_bike_no); Release reserved bike clears either kind.

const S1 = '2099-01-09';
const sessions = [{ id: S1, day: 'Friday', session_date: S1, capacity: 12, status: 'open', created_at: 1 }];
const row = (id: string, x: Record<string, unknown> = {}) => ({
  id, name: 'Rider ' + id, session_id: S1, session_day: 'Friday', session_date: S1, queue_num: 1, status: 'waiting', paid: false,
  price: 30, registered_at: S1 + 'T10:00:00Z', type_preference: 'Road', size: 'M', phone: '0550000001', ...x });

async function boot(page: Page, rows: Record<string, unknown>[], bikes: Record<string, unknown>[] = []) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await stubSupabase(page, { sessions, bikes, queue_entries: rows });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${S1}';renderStaffQueue()`);
}
// every PATCH to the booking, and the fixture follows it (the stub echoes fixtures on each reload)
function watch(page: Page, fixture: Record<string, unknown>) {
  const patches: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'PATCH' || !/queue_entries/.test(r.url())) return;
    const body = r.postDataJSON() as Record<string, unknown>;
    patches.push(body);
    Object.assign(fixture, body);
  });
  return patches;
}
const tr = (name: string) => `#tab-queue .queue-table-desktop-wrap tbody tr:has-text("${name}")`;

test('with the fleet empty, Reserve bike reserves the booking with no bike chosen', async ({ page }) => {
  const q1 = row('q1', { to_reserve: true });
  await boot(page, [q1]);
  const patches = watch(page, q1);
  await page.evaluate(`_reserveFromMenu('q1')`);
  const modal = page.locator('#bike-modal');
  await expect(modal.locator('#modal-bikeno-input')).toBeVisible();
  await expect(modal.locator('.bkm-nomsg')).toContainText('Leave it empty to reserve without choosing a bike');
  await modal.getByRole('button', { name: 'Reserve bike' }).click();
  await expect(modal.getByRole('dialog')).toBeHidden(); // the host itself has no box of its own: its dialog is what shows
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ assigned_bike_id: null, reserved: true, reserved_bike_no: null, to_reserve: false });
  await expect(page.locator(tr('Rider q1'))).toHaveClass(/\brow-reserved\b/);
  await expect(page.locator(`${tr('Rider q1')} .status-badge.st-reserved`)).toHaveCount(1);
  // and the menu offers to release it
  await expect.poll(() => page.evaluate(`((S._rowMenus||{})['q1']||[]).map(i=>i.run).join('|')`)).toContain('_releaseReserved');
});

test('a typed number the fleet does not have is kept on the booking and shown on its row', async ({ page }) => {
  const q1 = row('q1');
  await boot(page, [q1]);
  const patches = watch(page, q1);
  await page.evaluate(`openModal('q1')`);
  const modal = page.locator('#bike-modal');
  await modal.locator('#modal-bikeno-input').fill('12');
  await expect(modal.locator('.bkm-nomsg')).toContainText('Bike 012 is not in the fleet. Reserve bike keeps the number on this booking.');
  await modal.getByRole('button', { name: 'Reserve bike' }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ assigned_bike_id: null, reserved: true, reserved_bike_no: 12 });
  await expect(page.locator(`${tr('Rider q1')} .rq-held`)).toHaveText('Bike 012');
  // opened again, the field shows the number kept
  await page.evaluate(`openModal('q1')`);
  await expect(modal.locator('#modal-bikeno-input')).toHaveValue('12');
  await page.evaluate(`closeModal()`);
  // and the check-in says which bike was held
  await page.evaluate(`showCheckinModal('q1')`);
  await expect(page.locator('#checkin-modal .bkm-cbrsv')).toHaveText('Reserved: Bike 012');
  await page.evaluate(`closeCheckinModal()`);
  // Release clears it
  await page.evaluate(`_releaseReserved('q1')`);
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[1]).toEqual({ assigned_bike_id: null, reserved: false, reserved_bike_no: null });
  await expect(page.locator(tr('Rider q1'))).toHaveClass(/\brow-waiting\b/);
});

test('a typed number of the fleet picks that bike, a tapped row fills the number, a bike out is refused', async ({ page }) => {
  const bikes = [
    { id: 'rM', name: 'R-0011', bike_number: 11, type: 'Road', size: 'M', status: 'available', colors: [] },
    { id: 'rL', name: 'R-0014', bike_number: 14, type: 'Road', size: 'L', status: 'available', colors: [] },
    { id: 'rX', name: 'R-0015', bike_number: 15, type: 'Road', size: 'M', status: 'maintenance', colors: [] },
  ];
  const q1 = row('q1');
  await boot(page, [q1], bikes);
  await page.waitForFunction('getBikes().length>0');
  const patches = watch(page, q1);
  await page.evaluate(`openModal('q1')`);
  const modal = page.locator('#bike-modal');
  await modal.locator('#modal-bikeno-input').fill('11');
  expect(await page.evaluate('S.modalBikes')).toEqual(['rM']);
  await expect(modal.locator('.bkm-nomsg .bkm-cok')).toContainText('R-0011');
  // a row tapped puts its number in the field
  await modal.locator('tr.bkm-tr', { hasText: 'R-0014' }).click();
  await expect(modal.locator('#modal-bikeno-input')).toHaveValue('14');
  expect(await page.evaluate('S.modalBikes')).toEqual(['rL']);
  // a bike in maintenance is named, not picked, and Reserve bike says why instead of reserving past it
  await modal.locator('#modal-bikeno-input').fill('15');
  expect(await page.evaluate('S.modalBikes')).toEqual([]);
  await expect(modal.locator('.bkm-nomsg .bkm-cwarn')).toContainText('R-0015');
  await modal.getByRole('button', { name: 'Reserve bike' }).click();
  await expect(modal.getByRole('dialog')).toBeVisible();
  expect(patches).toHaveLength(0);
  // the fleet's number reserves that bike, as before
  await modal.locator('#modal-bikeno-input').fill('11');
  await modal.getByRole('button', { name: 'Reserve bike' }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ assigned_bike_id: 'rM' });
  await expect(page.locator(`${tr('Rider q1')} .rq-held`)).toHaveText('R-0011');
});

test('a number already kept for another rider asks first, then moves to this one', async ({ page }) => {
  const q1 = row('q1'), q2 = row('q2', { queue_num: 2, reserved: true, reserved_bike_no: 12 });
  await boot(page, [q1, q2]);
  const patches: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && /queue_entries/.test(r.url())) patches.push({ url: r.url(), body: r.postDataJSON() }); });
  await page.evaluate(`openModal('q1')`);
  const modal = page.locator('#bike-modal');
  await modal.locator('#modal-bikeno-input').fill('12');
  await modal.getByRole('button', { name: 'Reserve bike' }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(() => patches.length).toBe(2);
  expect(patches[0].url).toContain('id=eq.q1');
  expect(patches[0].body).toEqual({ assigned_bike_id: null, reserved: true, reserved_bike_no: 12 });
  expect(patches[1].url).toContain('id=eq.q2');
  expect(patches[1].body).toEqual({ reserved_bike_no: null });
});
