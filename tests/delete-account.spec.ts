import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff can delete a customer account. What goes is the login and everything personal hanging
// off it; what stays is the riding record, name and all, so rosters, close-outs and analytics
// read exactly as they did. The order matters more than it looks: queue_entries.customer_id is
// a real foreign key, so the bookings have to be unlinked BEFORE the account row goes, or
// Postgres refuses the delete and the staffer is left with a half-deleted account.
//
// staff_delete_customer (migration 20260922150000) does all of it in one transaction on the
// server, with the operator's approval since 20261004120000; the device-side steps a database
// without it used to get are gone (2026-10-04), so the page writes no table itself.

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
    if (/\/rpc\/staff_sign_in_methods\b/.test(r.url())) return; // a read (the editor's Google/Apple marks), sent as a POST
    if (/\/rpc\/staff_sign_in_lock\b/.test(r.url())) return; // a read (the editor's sign-in tries), sent as a POST
    if (/\/rpc\/badge_weeks\b/.test(r.url())) return; // a read (the editor's badges, since 75a25635), sent as a POST
    if (/\/rpc\/staff_pii_reveal\b/.test(r.url())) return; // the editor's look at personal data, recorded (2026-10-10): not a change to the account
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



test('Front Desk never sees the button', async ({ page }) => {
  await openEditor(page, [booking('b1', 'c1', 'done')], false);
  await expect(page.getByRole('button', { name: /Delete account/i })).toHaveCount(0);
});

test.describe('@staff:security with staff_delete_customer on the server', () => {
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
    expect(JSON.parse(rpc[0].body)).toEqual({ p_id: 'c1', p_op: 'Spec Staff', p_approval: null }); // the operator's approval travels with it
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


  test('a database without the function is said, and nothing is worked around', async ({ page }) => {
    await openEditor(page, [booking('b1', 'c1', 'done')], true, {
      'rpc:staff_delete_customer': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_delete_customer' } },
    });
    const calls = watchWrites(page);
    await confirmDelete(page);
    await expect(page.locator('#err-bar-el')).toBeVisible();
    await page.waitForTimeout(300);
    expect(calls.filter((c) => ACCOUNT_TABLES.includes(c.table))).toEqual([]);
  });
});
