import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// One number on several accounts (the owner, 2026-09-30: "make the staff able to add the phone
// number on more than one account", "but only let the main account or first account that has it
// to be able to sign with it"). Staff may save a number another account has; the account that had
// it first keeps signing in with it (customer_login, 20260930180000), and the account editor says
// which one that is (staff_phone_accounts). A database without that function refuses the number,
// as before. All Supabase traffic is stubbed.

const HUDA = '+966551239876';
const customers = [
  { id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: HUDA, height: 165, gender: 'female', created_at: '2026-01-05T10:00:00Z' },
  { id: 'c2', name: 'Sara Al Saleh', email: 'sara.saleh@gmail.com', phone: '+966552220000', height: 140, gender: 'female', created_at: '2025-06-01T10:00:00Z' },
];
const MAIN = [{ id: 'c1', name: 'Huda Al Saleh', signs_in: true }];
const GONE = { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_phone_accounts' } };

async function staff(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], staff_options: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>1');
  await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
}
function traffic(page: Page) {
  const out = { asked: [] as unknown[], patches: [] as Record<string, unknown>[], signups: [] as Record<string, unknown>[] };
  page.on('request', (r) => {
    const u = r.url(), body = () => JSON.parse(r.postData() || '{}');
    if (/rpc\/staff_phone_accounts\b/.test(u)) out.asked.push(body());
    else if (/rpc\/customer_signup\b/.test(u)) out.signups.push(body());
    else if (r.method() === 'PATCH' && /\/rest\/v1\/customers\b/.test(u)) out.patches.push(body());
  });
  return out;
}
const note = (page: Page) => page.locator('#new-acct-modal #cf-ph-share');

test.describe('@staff:community one number on several accounts', () => {
  test('another account\'s number on this one: the editor says who signs in with it, and it saves', async ({ page }) => {
    await staff(page, { 'rpc:staff_phone_accounts': MAIN });
    const t = traffic(page);
    await page.evaluate(`showEditCustomerModal('c2')`);
    await expect(page.locator('#new-acct-modal #cf-phone')).toBeVisible();
    await expect(note(page)).toBeHidden(); // Sara's own number is on no other account
    await page.locator('#cf-phone').fill('551239876');
    await expect(note(page)).toHaveText('Also on: Huda Al Saleh. Signing in with this number opens Huda Al Saleh’s account; this account signs in with its email.');
    expect(t.asked).toEqual([{ p_phone: HUDA }]);
    // Back to her own number the line goes; the shared one again brings it back
    await page.locator('#cf-phone').fill('552220000');
    await expect(note(page)).toBeHidden();
    await page.locator('#cf-phone').fill('551239876');
    await expect(note(page)).toContainText('Huda Al Saleh’s account');
    await page.locator('#new-acct-modal .btn-primary').click();
    await expect.poll(() => t.patches.length).toBe(1);
    expect(t.patches[0].phone).toBe(HUDA);
    await expect(page.locator('#new-acct-modal')).toBeHidden();
  });

  test('on a shared number, the account that had it first reads that it signs in with it', async ({ page }) => {
    const shared = customers.map((c) => ({ ...c, phone: HUDA }));
    await staff(page, { customers: shared, 'rpc:staff_phone_accounts': [...MAIN, { id: 'c2', name: 'Sara Al Saleh', signs_in: false }] });
    await page.evaluate(`showEditCustomerModal('c1')`);
    await expect(note(page)).toHaveText('Also on: Sara Al Saleh. Signing in with this number opens this account.');
    await page.evaluate(`closeCustFormModal();showEditCustomerModal('c2')`);
    await expect(note(page)).toHaveText('Also on: Huda Al Saleh. Signing in with this number opens Huda Al Saleh’s account; this account signs in with its email.');
    // A redraw keeps the line without asking again
    await page.evaluate('renderCustFormModal()');
    await expect(note(page)).toContainText('Huda Al Saleh’s account');
  });

  test('a new account can take a number another account has', async ({ page }) => {
    await staff(page, { 'rpc:staff_phone_accounts': MAIN, 'rpc:customer_signup': [{ id: 'x', session_token: 't' }] });
    // the number is on file, the email is not
    await page.route('**/rest/v1/rpc/customer_exists', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(!!JSON.parse(r.request().postData() || '{}').p_phone) }));
    const t = traffic(page);
    await page.evaluate(`showNewAcctModal()`);
    await page.locator('#cf-first').fill('Lina');
    await page.locator('#cf-last').fill('Al Saleh');
    await page.locator('#cf-email').fill('lina.saleh@gmail.com');
    await page.locator('#cf-phone').fill('551239876');
    await expect(note(page)).toHaveText('Also on: Huda Al Saleh. Signing in with this number opens Huda Al Saleh’s account; this account signs in with its email.');
    await page.locator('#cf-pwd').fill('Welcome123');
    await page.locator('#cf-height').fill('150');
    await page.locator('#new-acct-modal .toggle-btn', { hasText: 'Female' }).click();
    await page.locator('#new-acct-modal .btn-primary').click();
    await expect.poll(() => t.signups.length).toBe(1);
    expect(t.signups[0]).toMatchObject({ p_email: 'lina.saleh@gmail.com', p_phone: HUDA });
  });

  test('a database without staff_phone_accounts refuses the number as before, and shows no line', async ({ page }) => {
    await staff(page, { 'rpc:staff_phone_accounts': GONE });
    const t = traffic(page);
    await page.evaluate(`showEditCustomerModal('c2')`);
    await page.locator('#cf-phone').fill('551239876');
    await expect.poll(() => t.asked.length).toBe(1);
    await expect(note(page)).toBeHidden();
    await page.locator('#new-acct-modal .btn-primary').click();
    await expect(page.locator('.toast', { hasText: 'An account with this phone number already exists.' })).toBeVisible();
    expect(t.patches).toHaveLength(0);
  });

  test('in Arabic', async ({ page }) => {
    await staff(page, { 'rpc:staff_phone_accounts': MAIN });
    await page.evaluate(`setLang('ar')`);
    await page.evaluate(`showEditCustomerModal('c2')`);
    await page.locator('#cf-phone').fill('551239876');
    await expect(note(page)).toHaveText('هذا الرقم مسجّل أيضًا في: Huda Al Saleh. تسجيل الدخول بهذا الرقم يفتح حساب Huda Al Saleh، وهذا الحساب يسجّل الدخول ببريده الإلكتروني.');
  });
});
