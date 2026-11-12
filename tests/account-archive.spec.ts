import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Deleting an account archives it (the user, 2026-11-11; migration 20261111200000): the row and its history stay
// under the rider's name, every staff list stops showing it, and an admin finds it under Customers > Archived, reads
// its history and can restore it (staff_archived_list, staff_archived_account, staff_restore_customer).

const customers = [
  { id: 'k1', name: 'Stays On', email: 'k1@x.com', phone: '+966500000022', created_at: '2026-09-02', gender: 'female' },
];
const archived = [
  { id: 'g1', name: 'Gone Rider', email: 'gone@x.com', phone: '+966500000021', archived_at: '2026-11-11T09:00:00Z',
    archived_by: 'Malik', asked_at: '2026-11-01T09:00:00Z', created_at: '2026-01-01', bookings: 2, wallet: 40 },
];
const history = {
  ok: true,
  account: { id: 'g1', name: 'Gone Rider', email: 'gone@x.com', phone: '+966500000021', gender: 'male', created_at: '2026-01-01',
    archived_at: '2026-11-11T09:00:00Z', archived_by: 'Malik', asked_at: null, root: 'g1' },
  merged: 0, wallet: 40, bookings_n: 2,
  bookings: [
    { id: 'q2', date: '2026-10-08', session: 's2', status: 'noshow', price: 75, paid: false, bike: 'Road', num: 4 },
    { id: 'q1', date: '2026-10-01', session: 's1', status: 'done', price: 75, paid: true, bike: 'Road', num: 3 },
  ],
  sales: { n: 1, total: 20 }, badges: [{ name: 'First ride', name_ar: null }], tags: [{ name: 'Community', color: 'green' }],
  volunteer_hours: 3.5,
};

async function openAccounts(page: Page, admin: boolean, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { customers, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getCustomers().length===1');
  if (!admin) await page.evaluate(`S.staffRole='frontdesk';S._isAdmin=false`);
  await page.evaluate(`setStaffTab('customers');S.communityTab='accounts';renderCustomers()`);
}

test('an admin finds a deleted account under Archived, reads its history and restores it', async ({ page }) => {
  await openAccounts(page, true, {
    'rpc:staff_archived_list': archived,
    'rpc:staff_archived_account': history,
    'rpc:staff_restore_customer': { ok: true, email_back: false, tags: 1, tags_skipped: 0, merged_accounts: 0 },
  });
  const calls: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rpc\/(staff_restore_customer|staff_archived_account|staff_archived_list)\b/);
    if (m) calls.push({ fn: m[1], body: (r.postDataJSON() || {}) as Record<string, unknown> });
  });
  await page.locator('#tab-community').getByRole('button', { name: 'Archived', exact: true }).click();
  const dlg = page.locator('#mny-modal [role="dialog"]');
  await expect(dlg).toContainText('Archived accounts (1)');
  await expect(dlg).toContainText('Gone Rider');
  await expect(dlg).toContainText('by Malik');
  await expect(dlg).toContainText('the rider asked on');
  await expect(dlg).toContainText('2 booking(s)');
  // the search narrows the list, by name, email or phone digits
  await dlg.locator('#arc-q').fill('nobody');
  await expect(dlg).toContainText('No archived account matches.');
  await dlg.locator('#arc-q').fill('0021');
  await expect(dlg).toContainText('Gone Rider');

  await dlg.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(dlg).toContainText('gone@x.com');
  await expect(dlg).toContainText('Bookings (2)');
  await expect(dlg).toContainText('No-show');
  await expect(dlg).toContainText('Attended');
  await expect(dlg).toContainText('First ride');
  await expect(dlg).toContainText('Community');
  await expect(dlg).toContainText('Volunteer hours');
  expect(calls.find((c) => c.fn === 'staff_archived_account')!.body).toEqual({ p_id: 'g1' });

  await dlg.getByRole('button', { name: 'Restore account' }).click();
  await page.locator('#confirm-modal').getByRole('button', { name: 'Restore account' }).click();
  await expect.poll(() => calls.filter((c) => c.fn === 'staff_restore_customer').length).toBe(1);
  expect(calls.find((c) => c.fn === 'staff_restore_customer')!.body).toEqual({ p_id: 'g1', p_op: 'Spec Staff', p_approval: null });
  await expect(page.locator('.toast', { hasText: 'Gone Rider’s account restored' })).toBeVisible();
  await expect(page.locator('.toast', { hasText: 'Restored without its email' })).toBeVisible();
  // back on the list, without the restored account
  await expect(dlg).toContainText('No archived accounts yet.');
});

test('the archived list says when the database update is missing', async ({ page }) => {
  await openAccounts(page, true, {
    'rpc:staff_archived_list': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_archived_list' } },
  });
  await page.locator('#tab-community').getByRole('button', { name: 'Archived', exact: true }).click();
  await expect(page.locator('#mny-modal [role="dialog"]')).toContainText('need the database update 20261111200000');
});

test('Front Desk has no Archived button', async ({ page }) => {
  await openAccounts(page, false);
  await expect(page.locator('#tab-community').getByRole('button', { name: 'Archived', exact: true })).toHaveCount(0);
});

test('the delete dialog says the account is archived and can be restored', async ({ page }) => {
  await openAccounts(page, true);
  await page.evaluate(`deleteCustomerAccount('k1')`);
  const box = page.locator('#confirm-modal .confirm-box');
  await expect(box).toContainText('archived, not erased');
  await expect(box).toContainText('restore it from Customers > Archived');
});
