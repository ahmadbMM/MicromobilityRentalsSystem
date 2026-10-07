import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// A rider asks for their account to be deleted from My Account (Personal Data Protection Law,
// Art. 4). It is a request: staff see it on the Accounts list and answer within 30 days, by
// deleting the account or clearing the request. The rider can withdraw it until then.
const JSON_HDR = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

async function withRequestServer(page: Page) {
  let at: string | null = null;
  const calls: Record<string, unknown>[] = [];
  await page.route(/\/rest\/v1\/rpc\/customer_deletion_request/, async (route) => {
    const b = route.request().postDataJSON() as Record<string, unknown>;
    calls.push(b);
    if (b.p_request === true) at = at || '2026-09-22T09:00:00Z';
    if (b.p_request === false) at = null;
    await route.fulfill({ status: 200, headers: JSON_HDR, body: JSON.stringify({ requested_at: at }) });
  });
  return calls;
}

test('a rider asks for deletion from My Account, after confirming, and can withdraw it', async ({ page }) => {
  await stubSupabase(page, {});
  const calls = await withRequestServer(page);
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  const sec = page.locator('#acc-delete');
  await expect(sec).toContainText('Delete my account');
  await sec.getByRole('button', { name: 'Request account deletion' }).click();
  await expect(page.locator('#confirm-modal .confirm-box')).toContainText('Delete your account?');
  expect(calls.filter((c) => c.p_request === true)).toHaveLength(0); // nothing before the answer
  await page.locator('#confirm-modal .btn-red').click();
  await expect(page.locator('#acc-del-state')).toContainText('Deletion requested on');
  expect(calls.filter((c) => c.p_request === true)).toMatchObject([{ p_id: 'c1', p_token: 'tok-spec' }]);

  await page.locator('#acc-del-btn').click(); // Withdraw the request
  await expect(sec.getByRole('button', { name: 'Request account deletion' })).toBeVisible();
  expect(calls.at(-1)).toMatchObject({ p_request: false });
});

test('before the migration the section is not shown', async ({ page }) => {
  await stubSupabase(page, { 'rpc:customer_deletion_request': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function' } } });
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await page.waitForFunction('S._delUnavailable==="c1"');
  await expect(page.locator('#acc-delete')).toHaveCount(0);
});

test('staff see who asked, filter to them, and can clear a request', async ({ page }) => {
  const customers = [
    { id: 'd1', name: 'Wants Out', email: 'd1@x.com', phone: '+966500000021', created_at: '2026-09-01', gender: 'male', deletion_requested_at: '2026-09-20T09:00:00Z' },
    { id: 'k1', name: 'Stays On', email: 'k1@x.com', phone: '+966500000022', created_at: '2026-09-02', gender: 'female', deletion_requested_at: null },
  ];
  await stubSupabase(page, { customers });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getCustomers().length===2');
  const patches: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && /\/rest\/v1\/customers/.test(r.url())) patches.push(r.postDataJSON()); });
  await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
  const pill = page.locator('#tab-customers .am-pick', { hasText: 'Deletion requested' });
  await expect(pill).toHaveText('Deletion requested (1)');
  await pill.click();
  await expect(page.locator('#am-cust-rows .am-row')).toHaveCount(1);
  const line = page.locator('#am-cust-rows .am-delreq');
  await expect(line).toContainText('Asked to delete this account on');
  await expect(line.getByRole('button', { name: 'Delete account' })).toBeVisible();
  await line.getByRole('button', { name: 'Clear request' }).click();
  await expect.poll(() => patches.length).toBe(1);
  expect(patches[0]).toEqual({ deletion_requested_at: null });
  await expect(page.locator('#am-cust-rows .am-delreq')).toHaveCount(0);
});
