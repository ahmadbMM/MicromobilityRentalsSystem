import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Every return asks for the bike's condition and notes, then goes through staff_return so the
// assignment closes with them. Where the database predates the RPC the classic writes run,
// and a damaged bike still goes to maintenance.
const BIKE = { id: 'b1', name: 'Road 042', bike_number: 42, type: 'Road', size: 'M', status: 'in-use', colors: [], color_names: [] };
const ENTRY = {
  id: 'e1', session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: 7, name: 'Rider Seven', phone: '',
  customer_id: null, group_id: null, status: 'active', paid: true, price: 30, walk_in: true, registered_at: '2099-01-01T10:00:00Z',
  type_preference: 'Road', size: 'M', assigned_bike_id: 'b1', checked_in_at: '2099-02-10T09:00:00Z',
};
const SESSION = { id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 };
const base = { queue_entries: [ENTRY], sessions: [SESSION], bikes: [BIKE], 'rpc:staff_return': { ok: true, noop: false, bikes_freed: 1 } };

function watchRpcs(page: Page) {
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (m && r.method() === 'POST') { let body = {}; try { body = r.postDataJSON(); } catch { /* none */ } calls.push({ name: m[1], body }); }
  });
  return calls;
}
async function openStaff(page: Page, fixtures: Record<string, unknown>) {
  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getQueue().length>0 && getBikes().length>0');
}

test('Return asks for condition and notes, then calls staff_return with them', async ({ page }) => {
  await openStaff(page, base);
  const rpcs = watchRpcs(page);
  await page.evaluate("doReturn('e1')");
  const m = page.locator('#return-modal');
  await expect(m).toHaveCSS('display', 'flex');
  await expect(m).toContainText('Rider Seven');
  await expect(m).toContainText('Road 042');
  await m.getByRole('button', { name: 'Damaged' }).click();
  await expect(m.locator('#ret-hint')).toContainText('maintenance');
  await m.locator('#ret-notes').fill('bent derailleur');
  await m.locator('#ret-confirm').click();
  await expect.poll(() => rpcs.find((c) => c.name === 'staff_return')?.body)
    .toEqual({ p_booking_id: 'e1', p_return_condition: 'damaged', p_notes: 'bent derailleur' });
  await expect(m).toBeHidden();
});

test('the bike card offers Return while the bike is out', async ({ page }) => {
  await openStaff(page, base);
  await page.evaluate("openBikeProfile('b1')");
  const card = page.locator('#bike-profile-modal');
  await card.getByRole('button', { name: /Return Bike/i }).click();
  await expect(page.locator('#return-modal')).toHaveCSS('display', 'flex');
  await expect(page.locator('#return-modal')).toContainText('Rider Seven');
});

test('a database without the RPC: the classic writes run, and damaged still goes to maintenance', async ({ page }) => {
  await openStaff(page, { ...base, 'rpc:staff_return': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_return' } } });
  const patches: Array<{ table: string; id: string; body: Record<string, unknown> }> = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/([a-z_]+)\?.*id=eq\.([^&]+)/);
    if (m && r.method() === 'PATCH') { let body = {}; try { body = r.postDataJSON(); } catch { /* none */ } patches.push({ table: m[1], id: m[2], body }); }
  });
  await page.evaluate("doReturn('e1')");
  const m = page.locator('#return-modal');
  await m.getByRole('button', { name: 'Damaged' }).click();
  await m.locator('#ret-confirm').click();
  await expect.poll(() => patches.some((p) => p.table === 'queue_entries' && p.id === 'e1' && p.body.status === 'done')).toBe(true);
  await expect.poll(() => patches.some((p) => p.table === 'bikes' && p.id === 'b1' && p.body.status === 'maintenance')).toBe(true);
  await expect(m).toBeHidden();
});

test('an unpaid rider meets the payment on the return sheet itself, not in a dialog before it', async ({ page }) => {
  await openStaff(page, { ...base, queue_entries: [{ ...ENTRY, paid: false }] });
  await page.evaluate("doReturn('e1')");
  await expect(page.locator('#return-modal .modal-box')).toBeVisible();
  await expect(page.locator('#return-modal #ret-pay-lbl')).toBeVisible();     // what is owed, with Paid / Pending beside the condition
  await expect(page.locator('#return-pay-modal')).toBeHidden();
});
