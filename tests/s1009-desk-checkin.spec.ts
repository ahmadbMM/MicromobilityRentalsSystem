import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Front desk 2026-10-09 (s1009-desk): the check-in's Bike field answers from the fleet on the device
// (D1), says a bike of another type or size and the type it changes (D4), says "Sending" while the
// write is out and never loses a failed check-in (B5), and a single check-in is undone with its
// payment (D5). Invented riders and bikes only.

const B42 = { id: 'b1', name: 'Road 042', bike_number: 42, type: 'Road', size: 'M', status: 'available', colors: ['#000000'], color_names: ['Black'] };
const B43 = { id: 'b2', name: 'Hybrid 043', bike_number: 43, type: 'Hybrid', size: 'M', status: 'available', colors: ['#ffffff'], color_names: ['White'] };
const SESSION = { id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 };
const ENTRY = {
  id: 'e1', session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: 7,
  name: 'Rider Seven', phone: '', customer_id: null, group_id: null, status: 'waiting', paid: false,
  price: 57.5, walk_in: true, registered_at: '2099-01-01T10:00:00Z', type_preference: 'Hybrid', size: 'M', height: 176,
};

async function boot(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { queue_entries: [ENTRY], sessions: [SESSION], bikes: [B42, B43], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0&&getBikes().length>0');
  await page.evaluate(`S.staffTab='queue';renderStaffQueue();showCheckinModal('e1')`);
  return page.locator('#checkin-modal');
}
function patches(page: Page) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) { try { out.push(r.postDataJSON()); } catch { /* none */ } }
  });
  return out;
}

test.describe('@staff:checkin s1009 desk: the Bike field', () => {
  test('D1: a fleet number enables Confirm at once; the slow server answer corrects the field', async ({ page }) => {
    const modal = await boot(page, { 'rpc:staff_resolve_bike': { found: true, bike: { ...B42, status: 'in-use' }, rented_to: { name: 'Someone Else', since: '2099-02-10T18:00:00Z' } } });
    await page.route(/\/rest\/v1\/rpc\/staff_resolve_bike/, async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.fallback();
    });
    await modal.locator('#ci-bike').fill('42');
    await modal.locator('#ci-bike').press('Enter');
    // the device's fleet answers: no "Looking...", Confirm on before the server has spoken
    await expect(modal.locator('#ci-bike-spec')).toContainText('042', { timeout: 1500 });
    await expect(modal.locator('#ci-confirm')).toBeEnabled({ timeout: 1500 });
    // then the server says the bike is out with someone: the field follows it
    await expect(modal.locator('#ci-bike-spec')).toContainText('Someone Else', { timeout: 6000 });
    await expect(modal.locator('#ci-confirm')).toBeDisabled();
  });

  test('D1: a network failure falls back on the fleet the device holds', async ({ page }) => {
    const modal = await boot(page);
    await page.route(/\/rest\/v1\/rpc\/staff_resolve_bike/, (route) => route.abort('failed'));
    await modal.locator('#ci-bike').fill('b2'); // a bike id, as a tag or old sticker carries it: asked of the server
    await modal.locator('#ci-bike').press('Enter');
    await expect(modal.locator('#ci-bike-spec')).toContainText('043');
    await expect(modal.locator('#ci-confirm')).toBeEnabled();
  });

  test('D4: another type is said in amber, with the type and price it changes to', async ({ page }) => {
    const modal = await boot(page);
    await modal.locator('#ci-bike').fill('42');
    await modal.locator('#ci-bike').press('Enter');
    await expect(modal.locator('.ci-fitwarn')).toContainText('Booked Hybrid');
    await expect(modal.locator('.ci-fitwarn')).toContainText('this bike is Road');
    await expect(modal.locator('.ci-tychg')).toContainText('Type will change to Road');
    await expect(modal.locator('.ci-tychg')).toContainText('SAR');
    // the bike that matches says nothing more
    await modal.locator('#ci-bike').fill('43');
    await modal.locator('#ci-bike').press('Enter');
    await expect(modal.locator('#ci-bike-spec')).toContainText('043');
    await expect(modal.locator('.ci-fitwarn')).toHaveCount(0);
    await expect(modal.locator('.ci-tychg')).toHaveCount(0);
  });
});

test.describe('@staff:checkin s1009 desk: Confirm', () => {
  test('B5: "Sending" while the write is out; a failure after the drawer moved on goes to the error bar by name', async ({ page }) => {
    const modal = await boot(page);
    await page.route(/\/rest\/v1\/rpc\/staff_checkin/, async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'P0001', message: 'BIKE_UNAVAILABLE: the bike is out' }) });
    });
    await modal.locator('#ci-confirm').click();
    await expect(modal.locator('#ci-confirm')).toHaveText('Sending…');
    await expect(modal.locator('#ci-confirm')).toHaveAttribute('aria-busy', 'true');
    await page.evaluate('closeCheckinModal()'); // the staffer moves on before the answer
    const bar = page.locator('#err-bar-el');
    await expect(bar).toContainText('#7 Rider Seven not checked in');
    await expect(bar).toContainText('the bike is out');
    // Retry opens that rider's check-in again
    await bar.getByRole('button', { name: 'Try again' }).click();
    await expect(modal.locator('#dlgt-checkin')).toContainText('Rider Seven');
  });

  test('B5: a failure on the rider still open stays in that drawer', async ({ page }) => {
    const modal = await boot(page, { 'rpc:staff_checkin': { __rpcError: { status: 400, code: 'P0001', message: 'BIKE_UNAVAILABLE: the bike is out' } } });
    await modal.locator('#ci-confirm').click();
    await expect(modal.locator('#ci-error')).toContainText('the bike is out');
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
    await expect(modal.locator('#ci-confirm')).not.toHaveText('Sending…');
  });

  test('D5: the check-in is undoable from the topbar Undo: status, bike and payment back', async ({ page }) => {
    const modal = await boot(page);
    const q = patches(page);
    await modal.locator('#ci-bike').fill('43');
    await modal.locator('#ci-bike').press('Enter');
    await expect(modal.locator('#ci-confirm')).toBeEnabled();
    await modal.locator('#ci-confirm').click(); // Paid is preselected for an unpaid rider
    await page.waitForFunction(`S.undoStack.some(u=>/Check in: #7 Rider Seven/i.test(u.label))`);
    expect(await page.evaluate(`getQueue().find(e=>e.id==='e1').status`)).toBe('active');
    await page.evaluate('S.undoStack[S.undoStack.length-1].fn()');
    await expect.poll(() => q.find((b) => b.status === 'waiting')).toBeTruthy();
    const back = q.find((b) => b.status === 'waiting')!;
    expect(back).toMatchObject({ status: 'waiting', assigned_bike_id: null, paid: false, pay_method: null });
  });

  test('D5: the row\'s own Undo check-in puts the payment back too', async ({ page }) => {
    const modal = await boot(page);
    const q = patches(page);
    await modal.locator('#ci-confirm').click();
    await page.waitForFunction(`getQueue().find(e=>e.id==='e1').status==='active'`);
    await page.evaluate(`doUndoCheckin('e1')`);
    await expect.poll(() => q.find((b) => b.status === 'waiting')).toBeTruthy();
    expect(q.find((b) => b.status === 'waiting')).toMatchObject({ paid: false });
  });
});
