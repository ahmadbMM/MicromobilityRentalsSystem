import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff can delete a customer account. What goes is the login and everything personal hanging
// off it; what stays is the riding record, name and all, so rosters, close-outs and analytics
// read exactly as they did. The order matters more than it looks: queue_entries.customer_id is
// a real foreign key, so the bookings have to be unlinked BEFORE the account row goes, or
// Postgres refuses the delete and the staffer is left with a half-deleted account.
//
// With staff_delete_customer (migration 20260922150000) the server does all of it in one
// transaction. The stub answers that function as missing unless a spec provides it, so the
// specs below that do not are the device-side steps a database without it still gets.

const sessions = [{
  id: '2099-07-05', day: 'Sunday', session_date: '2099-07-05', capacity: 9, status: 'open',
  created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":9}',
}];
const customers = [
  { id: 'c1', name: 'Gone Rider', email: 'gone@example.com', phone: '0551110000', created_at: 1 },
  { id: 'c2', name: 'Stays Rider', email: 'stays@example.com', phone: '0551110001', created_at: 2 },
];
const booking = (id: string, cust: string, status: string) => ({
  id, session_id: sessions[0].id, session_day: 'Sunday', session_date: '2099-07-05',
  queue_num: 3, name: 'Gone Rider', phone: '0551110000', customer_id: cust, size: 'M',
  type_preference: 'Road', status, paid: true, price: 75, registered_at: '2099-01-01T10:00:00Z',
});

/** Every write the client sent, in order, so the FK-safe sequence can be asserted. */
function watchWrites(page: import('@playwright/test').Page) {
  const calls: { method: string; table: string; body: string; url: string }[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/([^/?]+)/);
    if (!m || !['POST', 'PATCH', 'DELETE'].includes(r.method())) return;
    calls.push({ method: r.method(), table: m[1], body: r.postData() || '', url: r.url() });
  });
  return calls;
}

async function openEditor(page: import('@playwright/test').Page, queue_entries: Record<string, unknown>[], admin = true, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, customers, bikes: [], queue_entries, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  if (!admin) await page.evaluate(`S.staffRole='frontdesk';S._isAdmin=false`);
  // The delete reads the rider's bookings to decide what to unlink, so wait for the queue to
  // be in memory — otherwise the test races the first load and proves nothing about linking.
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`showEditCustomerModal('c1')`);
}

test('deletes the account, and unlinks the bookings first so the key holds', async ({ page }) => {
  await openEditor(page, [booking('b1', 'c1', 'done')]);
  const calls = watchWrites(page);

  await page.getByRole('button', { name: /Delete account/i }).click();
  await page.locator('#confirm-modal').getByRole('button', { name: /Delete account/i }).click();

  await expect.poll(() => calls.some((c) => c.table === 'customers' && c.method === 'DELETE')).toBe(true);
  const unlink = calls.findIndex((c) => c.table === 'queue_entries' && c.method === 'PATCH' && /"customer_id":null/.test(c.body));
  const del = calls.findIndex((c) => c.table === 'customers' && c.method === 'DELETE');
  expect(unlink).toBeGreaterThanOrEqual(0);
  expect(unlink).toBeLessThan(del);                    // unlink BEFORE delete, or the FK refuses
  // everything personal goes with it - once the account row is gone, so it may land just after
  for (const table of ['customer_tags', 'push_subscriptions']) {   // notes were removed from the app
    await expect.poll(() => calls.some((c) => c.table === table && c.method === 'DELETE')).toBe(true);
  }
  // the booking row itself is never deleted — the riding record stays
  expect(calls.some((c) => c.table === 'queue_entries' && c.method === 'DELETE')).toBe(false);
});

test('refuses while the rider is on a live booking', async ({ page }) => {
  await openEditor(page, [booking('b1', 'c1', 'waiting')]);
  const calls = watchWrites(page);

  await page.getByRole('button', { name: /Delete account/i }).click();
  await expect(page.locator('.toast')).toContainText(/live booking/i);
  await page.waitForTimeout(300);
  expect(calls).toHaveLength(0);                       // nothing was written at all
  await expect(page.locator('#confirm-modal')).toBeHidden();
});

// There is no Undo: the staff list does not hold the password, the photo or the correction
// history, so the row it used to re-insert was an account its rider could not sign in to.
test('offers no undo, and the dialog says so', async ({ page }) => {
  await openEditor(page, [booking('b1', 'c1', 'done')]);
  await page.getByRole('button', { name: /Delete account/i }).click();
  await expect(page.locator('#confirm-modal .confirm-box')).toBeVisible();
  await expect(page.locator('#confirm-modal .confirm-box')).not.toContainText(/undone from the bar/i);
  await page.locator('#confirm-modal').getByRole('button', { name: /Delete account/i }).click();
  await expect(page.locator('.toast').last()).toContainText(/deleted/i);
  await page.waitForTimeout(300);
  await expect(page.locator('#topbar-right .undo-btn')).toHaveCount(0);
});

// A refused delete must not leave the rider half-deleted: their bookings get their link back,
// and the tags are still there, because tags go only once the account row itself is gone.
test('a refused delete gives the bookings their link back and keeps the tags', async ({ page }) => {
  await stubSupabase(page, { sessions, customers, bikes: [], queue_entries: [booking('b1', 'c1', 'done')],
    customer_tags: [{ customer_id: 'c1', tag_id: 't1', added_at: 1 }], tags: [{ id: 't1', name: 'Member' }] },
  { table: 'customers', methods: ['DELETE'] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`showEditCustomerModal('c1')`);
  const calls = watchWrites(page);
  await page.getByRole('button', { name: /Delete account/i }).click();
  await page.locator('#confirm-modal').getByRole('button', { name: /Delete account/i }).click();
  await expect.poll(() => calls.some((c) => c.table === 'queue_entries' && /"customer_id":"c1"/.test(c.body))).toBe(true);
  const unlink = calls.findIndex((c) => c.table === 'queue_entries' && /"customer_id":null/.test(c.body));
  const del = calls.findIndex((c) => c.table === 'customers' && c.method === 'DELETE');
  const relink = calls.findIndex((c) => c.table === 'queue_entries' && /"customer_id":"c1"/.test(c.body));
  expect(unlink).toBeLessThan(del);
  expect(del).toBeLessThan(relink);
  expect(calls.some((c) => c.table === 'customer_tags' && c.method === 'DELETE')).toBe(false);
  expect(calls.some((c) => c.table === 'push_subscriptions' && c.method === 'DELETE')).toBe(false);
});

// The unlink covers every booking on the server, not only the months this device has loaded:
// an account whose rides are all older than the window used to skip it and hit the key.
test('the unlink runs even when no booking of the account is loaded', async ({ page }) => {
  await openEditor(page, [booking('b9', 'c2', 'done')]);
  const calls = watchWrites(page);
  await page.getByRole('button', { name: /Delete account/i }).click();
  await page.locator('#confirm-modal').getByRole('button', { name: /Delete account/i }).click();
  await expect.poll(() => calls.some((c) => c.table === 'customers' && c.method === 'DELETE')).toBe(true);
  const unlink = calls.findIndex((c) => c.table === 'queue_entries' && c.method === 'PATCH' && /"customer_id":null/.test(c.body));
  expect(unlink).toBeGreaterThanOrEqual(0);
  expect(unlink).toBeLessThan(calls.findIndex((c) => c.table === 'customers' && c.method === 'DELETE'));
});

test('Front Desk never sees the button', async ({ page }) => {
  await openEditor(page, [booking('b1', 'c1', 'done')], false);
  await expect(page.getByRole('button', { name: /Delete account/i })).toHaveCount(0);
});

test.describe('with staff_delete_customer on the server', () => {
  const ACCOUNT_TABLES = ['queue_entries', 'cashier_sales', 'customers', 'customer_tags', 'push_subscriptions'];
  const confirmDelete = async (page: import('@playwright/test').Page) => {
    await page.getByRole('button', { name: /Delete account/i }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: /Delete account/i }).click();
  };

  test('one server call does the whole delete; the device writes no table itself', async ({ page }) => {
    await openEditor(page, [booking('b1', 'c1', 'done')], true, {
      'rpc:staff_delete_customer': { ok: true, bookings: 1, sales: 0, tags: 1, push_subscriptions: 0, flags: 0, rider_links: 0 },
    });
    const calls = watchWrites(page);
    await confirmDelete(page);
    await expect(page.locator('.toast').last()).toContainText(/deleted/i);
    const rpc = calls.filter((c) => /\/rpc\/staff_delete_customer/.test(c.url));
    expect(rpc).toHaveLength(1);
    expect(JSON.parse(rpc[0].body)).toEqual({ p_id: 'c1' });
    expect(calls.filter((c) => ACCOUNT_TABLES.includes(c.table))).toEqual([]);
    expect(await page.evaluate('S._cf')).toBeNull(); // the editor closed
  });

  test('a live booking the server finds (made on another device) stops it, with the count', async ({ page }) => {
    await openEditor(page, [booking('b1', 'c1', 'done')], true, {
      'rpc:staff_delete_customer': { ok: false, error: 'LIVE_BOOKINGS', live: 2 },
    });
    const calls = watchWrites(page);
    await confirmDelete(page);
    await expect(page.locator('.toast').last()).toContainText(/2 live booking/i);
    await page.waitForTimeout(300);
    expect(calls.filter((c) => ACCOUNT_TABLES.includes(c.table))).toEqual([]); // no fallback to the device's own steps
    expect(await page.evaluate(`S.fullLog.some(l=>l.label.includes(t('naDelTitle')))`)).toBe(false);
  });

  test('a refusal that is not a missing function is shown, never worked around', async ({ page }) => {
    await openEditor(page, [booking('b1', 'c1', 'done')], true, {
      'rpc:staff_delete_customer': { __rpcError: { status: 403, code: '42501', message: 'FORBIDDEN' } },
    });
    const calls = watchWrites(page);
    await confirmDelete(page);
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await page.waitForTimeout(300);
    expect(calls.filter((c) => ACCOUNT_TABLES.includes(c.table))).toEqual([]);
  });

  test('a database without the function gets the device-side steps, unlink first', async ({ page }) => {
    await openEditor(page, [booking('b1', 'c1', 'done')]); // the stub's default: PGRST202
    const calls = watchWrites(page);
    await confirmDelete(page);
    await expect.poll(() => calls.some((c) => c.table === 'customers' && c.method === 'DELETE')).toBe(true);
    const tried = calls.findIndex((c) => /\/rpc\/staff_delete_customer/.test(c.url));
    const unlink = calls.findIndex((c) => c.table === 'queue_entries' && c.method === 'PATCH' && /"customer_id":null/.test(c.body));
    expect(tried).toBeGreaterThanOrEqual(0);
    expect(tried).toBeLessThan(unlink);
    expect(unlink).toBeLessThan(calls.findIndex((c) => c.table === 'customers' && c.method === 'DELETE'));
  });
});
