import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Change bike on a rider who is out goes through staff_swap_bike (2026-10-04 review), as the
// Hand-over does: the old bike's open assignment closes as 'swapped' in the same transaction.
// Written straight to the rows, that assignment stayed open, so staff_checkin refused the old
// bike to the next rider and this rider's return freed it again under them. The plain writes
// run only where the function is missing.

const sessions = [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }];
const bikes = [
  { id: 'bA', name: 'Bike A', size: 'M', type: 'Hybrid', status: 'in-use', rental_price: 57.5 },
  { id: 'bB', name: 'Bike B', size: 'M', type: 'Hybrid', status: 'available', rental_price: 57.5 },
];
const queue_entries = [{
  id: 'q1', name: 'Rider One', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 1,
  status: 'active', paid: true, price: 57.5, assigned_bike_id: 'bA', type_preference: 'Hybrid', registered_at: '2099-01-09T10:00:00Z',
}];

type Req = { method: string; url: string; body: unknown };

async function open(page: import('@playwright/test').Page, extra: Record<string, unknown>) {
  await stubSupabase(page, { sessions, bikes, queue_entries, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const reqs: Req[] = [];
  page.on('request', (r) => {
    if (!/rest\/v1\/(rpc\/staff_swap_bike|bikes|queue_entries|bike_assignments)/.test(r.url()) || r.method() === 'GET') return;
    let body: unknown = null;try { body = JSON.parse(r.postData() || 'null'); } catch { /* none */ }
    reqs.push({ method: r.method(), url: r.url(), body });
  });
  return reqs;
}

test('a bike change is one staff_swap_bike call, and its undo swaps back the same way', async ({ page }) => {
  const reqs = await open(page, { 'rpc:staff_swap_bike': { ok: true, noop: false } });
  await page.evaluate(`(async()=>{openModal('q1');S.modalBikes=['bB'];await confirmAssign();})()`);
  const swaps = () => reqs.filter((r) => /staff_swap_bike/.test(r.url));
  expect(swaps().map((r) => r.body)).toEqual([{ p_booking_id: 'q1', p_new_bike_id: 'bB' }]);
  // no hand-written claim of the new bike nor release of the old one: the function did both
  expect(reqs.filter((r) => /rest\/v1\/bikes/.test(r.url) && r.method === 'PATCH')).toEqual([]);
  expect(reqs.filter((r) => /queue_entries/.test(r.url) && (r.body as Record<string, unknown>)?.assigned_bike_id !== undefined)).toEqual([]);

  await page.evaluate(`(async()=>{await S.undoStack[S.undoStack.length-1].fn();})()`);
  expect(swaps().map((r) => r.body)).toEqual([
    { p_booking_id: 'q1', p_new_bike_id: 'bB' },
    { p_booking_id: 'q1', p_new_bike_id: 'bA' },
  ]);
  expect(reqs.filter((r) => /rest\/v1\/bikes/.test(r.url) && r.method === 'PATCH')).toEqual([]);
});

test('a refused swap is said and changes nothing', async ({ page }) => {
  const reqs = await open(page, { 'rpc:staff_swap_bike': { __rpcError: { status: 400, code: 'P0001', message: 'BIKE_UNAVAILABLE: bike B is in-use' } } });
  await page.evaluate(`(async()=>{openModal('q1');S.modalBikes=['bB'];await confirmAssign();})()`);
  await expect(page.locator('.toast').filter({ hasText: /BIKE_UNAVAILABLE|unavailable|in-use/i }).first()).toBeVisible();
  expect(reqs.filter((r) => !/staff_swap_bike/.test(r.url))).toEqual([]);
});

test('without the function the change is said and nothing is written around it (2026-10-04)', async ({ page }) => {
  const reqs = await open(page, { 'rpc:staff_swap_bike': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_swap_bike' } } });
  await page.evaluate(`(async()=>{openModal('q1');S.modalBikes=['bB'];await confirmAssign();})()`);
  await expect(page.locator('.toast').filter({ hasText: /staff_swap_bike|function/i }).first()).toBeVisible();
  expect(reqs.filter((r) => !/staff_swap_bike/.test(r.url))).toEqual([]);
});
