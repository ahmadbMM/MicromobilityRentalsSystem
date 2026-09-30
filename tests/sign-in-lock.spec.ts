import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Staff reset an account's sign-in wait (the owner, 2026-09-30): eight failed tries lock the
// sign-in for 15 minutes. The account editor says where the account stands (staff_sign_in_lock)
// and Reset the wait clears its counters (staff_clear_sign_in_lock, 20260930110000).
// All Supabase traffic is stubbed.

const customers = [{ id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', height: 165, gender: 'female', created_at: '2026-01-05T10:00:00Z' }];
const inTwelve = () => new Date(Date.now() + 12 * 60000).toISOString();

async function editor(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], staff_options: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
}
async function openEditor(page: Page) {
  await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity();showEditCustomerModal('c1')`);
  await expect(page.locator('#new-acct-modal #cf-sl')).toBeVisible();
}
function rpcs(page: Page) {
  const out: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    const m = /rpc\/(staff_(?:clear_)?sign_in_lock)\b/.exec(r.url());
    if (m && r.method() === 'POST') out.push({ fn: m[1], body: JSON.parse(r.postData() || '{}') });
  });
  return out;
}

test.describe('@staff:community sign-in wait', () => {
  test('a locked account says until when, and Reset the wait clears it and is logged', async ({ page }) => {
    const until = inTwelve();
    await editor(page, { 'rpc:staff_sign_in_lock': [{ fails: 8, locked_until: until }], 'rpc:staff_clear_sign_in_lock': 3 });
    const calls = rpcs(page);
    await openEditor(page);
    const line = page.locator('#cf-sl');
    const hm = await page.evaluate(`new Date('${until}').toLocaleTimeString(_locale(),{hour:'2-digit',minute:'2-digit',timeZone:KSA_TZ})`);
    expect(hm).toMatch(/^\d{2}:\d{2}$/);
    await expect(line.locator('.cf-sl-on')).toHaveText(`Locked after too many failed sign-in tries. They can try again at ${hm}.`);
    expect(calls).toEqual([{ fn: 'staff_sign_in_lock', body: { p_customer_id: 'c1' } }]);

    await line.locator('.cf-sl-btn').click();
    await expect(line.locator('.cf-sl-off')).toHaveText('No failed sign-in tries.');
    await expect(line.locator('.cf-sl-on')).toHaveCount(0);
    expect(calls[1]).toEqual({ fn: 'staff_clear_sign_in_lock', body: { p_customer_id: 'c1' } });
    expect(await page.evaluate(`S.fullLog.map(x=>x.label).includes('Sign-in wait reset for Huda Al Saleh')`)).toBe(true);
    // A redraw of the editor keeps what it knows and does not ask again
    await page.evaluate('renderCustFormModal()');
    await expect(page.locator('#cf-sl .cf-sl-off')).toHaveText('No failed sign-in tries.');
    expect(calls.filter((c) => c.fn === 'staff_sign_in_lock')).toHaveLength(1);
  });

  test('failed tries short of the lock are counted; none says so', async ({ page }) => {
    await editor(page, { 'rpc:staff_sign_in_lock': [{ fails: 3, locked_until: null }] });
    await openEditor(page);
    await expect(page.locator('#cf-sl .cf-sl-off')).toHaveText('Failed sign-in tries: 3. At 8 the sign-in locks for 15 minutes.');
    await expect(page.locator('#cf-sl .cf-sl-btn')).toHaveText('Reset the wait');
    await page.evaluate(`closeCustFormModal()`);
    await page.route('**/rest/v1/rpc/staff_sign_in_lock', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ fails: 0, locked_until: null }]) }));
    await openEditor(page);
    await expect(page.locator('#cf-sl .cf-sl-off')).toHaveText('No failed sign-in tries.');
  });

  test('in Arabic', async ({ page }) => {
    await editor(page, { 'rpc:staff_sign_in_lock': [{ fails: 3, locked_until: null }] });
    await page.evaluate(`setLang('ar')`);
    await openEditor(page);
    await expect(page.locator('#cf-sl .cf-sl-off')).toHaveText('محاولات الدخول الفاشلة: 3. عند 8 يُقفل الدخول لمدة 15 دقيقة.');
    await expect(page.locator('#cf-sl .cf-sl-btn')).toHaveText('إلغاء الانتظار');
  });

  test('a database without the functions says it is waiting for the update and offers no button', async ({ page }) => {
    await editor(page, { 'rpc:staff_sign_in_lock': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_sign_in_lock' } } });
    await openEditor(page);
    await expect(page.locator('#cf-sl')).toHaveText('Waiting for the database update.');
    await expect(page.locator('#cf-sl .cf-sl-btn')).toHaveCount(0);
  });

  test('a refused reset says so and keeps the standing', async ({ page }) => {
    await editor(page, { 'rpc:staff_sign_in_lock': [{ fails: 8, locked_until: inTwelve() }], 'rpc:staff_clear_sign_in_lock': { __rpcError: { status: 403, code: '42501', message: 'not allowed' } } });
    await openEditor(page);
    await page.locator('#cf-sl .cf-sl-btn').click();
    await expect(page.locator('#toast-container .toast.error, #toast-container .error').first()).toContainText('not allowed');
    await expect(page.locator('#cf-sl .cf-sl-on')).toBeVisible();
    expect(await page.evaluate(`S.fullLog.some(x=>/Sign-in wait reset/.test(x.label))`)).toBe(false);
  });

  test('a staffer who may only view Community sees the standing (a read) but cannot reset', async ({ page }) => {
    await editor(page, { 'rpc:staff_sign_in_lock': [{ fails: 8, locked_until: inTwelve() }], 'rpc:staff_clear_sign_in_lock': 3 });
    const calls = rpcs(page);
    await page.evaluate(`S._myEdit=['queue']`);
    await openEditor(page);
    expect(await page.evaluate(`_roNow()`)).toBe(true);
    await expect(page.locator('#cf-sl .cf-sl-on')).toBeVisible();
    await page.locator('#cf-sl .cf-sl-btn').click();
    await expect(page.locator('#cf-sl .cf-sl-on')).toBeVisible();
    await page.waitForTimeout(200);
    expect(calls.map((c) => c.fn)).toEqual(['staff_sign_in_lock']);
  });
});
