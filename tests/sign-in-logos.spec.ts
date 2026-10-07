import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// The Google and Apple marks beside an account's email (the owner, 2026-09-29): staff see them in
// Community > Accounts and the account editor from staff_sign_in_methods, a rider on their own
// account page from customer_about's sign_in (20260929140000). An account that uses both shows
// both; a password account shows none; a database without the functions shows none.

const customers = [
  { id: 'g1', name: 'Gina Google', email: 'gina@gmail.com', phone: '+966500000001', gender: 'female', created_at: '2026-08-01T10:00:00Z' },
  { id: 'a1', name: 'Adam Apple', email: 'adam@icloud.com', phone: '+966500000002', gender: 'male', created_at: '2026-08-02T10:00:00Z' },
  { id: 'b1', name: 'Bana Both', email: 'bana@gmail.com', phone: '+966500000003', gender: 'female', created_at: '2026-08-03T10:00:00Z' },
  { id: 'p1', name: 'Pavel Password', email: 'pavel@example.org', phone: '+966500000004', gender: 'male', created_at: '2026-08-04T10:00:00Z' },
];
const methods = [{ id: 'g1', google: true, apple: false }, { id: 'a1', google: false, apple: true }, { id: 'b1', google: true, apple: true }];

async function accounts(page: Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { customers, tags: [], customer_tags: [], sessions: [], queue_entries: [], 'rpc:staff_sign_in_methods': methods, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getCustomers().length>0');
  await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
}
const row = (page: Page, name: string) => page.locator('.am-cust').filter({ hasText: name });

test('Accounts: the mark after the email says how the account signs in', async ({ page }) => {
  await accounts(page);
  await expect(row(page, 'Gina Google').locator('.am-cust-contact .si-ico')).toHaveCount(1);
  await expect(row(page, 'Gina Google').locator('.si-google')).toHaveAttribute('aria-label', 'Google sign-in');
  await expect(row(page, 'Adam Apple').locator('.si-apple')).toHaveAttribute('title', 'Apple sign-in');
  await expect(row(page, 'Adam Apple').locator('.si-google')).toHaveCount(0);
  await expect(row(page, 'Bana Both').locator('.si-ico')).toHaveCount(2);
  await expect(row(page, 'Pavel Password').locator('.si-ico')).toHaveCount(0);
  // right after the email, before the phone
  const html = await row(page, 'Gina Google').locator('.am-cust-contact').innerHTML();
  expect(html.indexOf('gina@gmail.com')).toBeLessThan(html.indexOf('si-google'));
  expect(html.indexOf('si-google')).toBeLessThan(html.indexOf('+966500000001'));
  // asked once, not on every repaint
  const calls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/rpc/staff_sign_in_methods')) calls.push(r.url()); });
  await page.evaluate(`renderCommunity();_amRepaintRow('g1')`);
  await expect(row(page, 'Gina Google').locator('.si-google')).toHaveCount(1);
  expect(calls).toHaveLength(0);
});

test('the account editor shows the mark at the end of the email box', async ({ page }) => {
  await accounts(page);
  await expect(row(page, 'Bana Both').locator('.si-ico')).toHaveCount(2);
  await page.evaluate(`showEditCustomerModal('b1')`);
  const field = page.locator('#new-acct-modal .si-field');
  await expect(field.locator('#cf-email')).toHaveValue('bana@gmail.com');
  await expect(field.locator('.si-google')).toBeVisible();
  await expect(field.locator('.si-apple')).toBeVisible();
  // the text does not run under the marks
  expect(await page.evaluate(`parseFloat(getComputedStyle(document.getElementById('cf-email')).paddingInlineEnd)`)).toBeGreaterThanOrEqual(50);
  await page.evaluate(`showEditCustomerModal('p1')`);
  await expect(page.locator('#new-acct-modal .si-ico')).toHaveCount(0);
});

test('a staffer who may only view Community still sees the marks (the lookup is a read)', async ({ page }) => {
  await stubSupabase(page, { customers, tags: [], customer_tags: [], sessions: [], queue_entries: [], 'rpc:staff_sign_in_methods': methods });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getCustomers().length>0');
  await page.evaluate(`S._myEdit=['queue'];S._siAt=0;S._siMap=null;setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
  expect(await page.evaluate(`_roNow()`)).toBe(true);
  await expect(row(page, 'Adam Apple').locator('.si-apple')).toHaveCount(1);
});

test('a database without staff_sign_in_methods shows no marks and asks once', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/rpc/staff_sign_in_methods')) calls.push(r.url()); });
  await accounts(page, { 'rpc:staff_sign_in_methods': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_sign_in_methods' } } });
  await expect(row(page, 'Gina Google')).toBeVisible();
  await expect.poll(() => calls.length).toBe(1);
  await page.evaluate(`S._siAt=0;renderCommunity();showEditCustomerModal('g1')`);
  await expect(page.locator('.si-ico')).toHaveCount(0);
  expect(calls).toHaveLength(1);
});

test('a rider sees the mark beside their own email on My Account', async ({ page }) => {
  await stubSupabase(page, {
    sessions: [], queue_entries: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@gmail.com', phone: '0500000001', gender: 'male', nationality: null, socials: null }],
    'rpc:customer_about': [{ profession: null, workplace: null, heard_from: null, sign_in: 'apple' }],
  });
  await loginCustomer(page, { id: 'c1', email: 'spec@gmail.com' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  const field = page.locator('#tab-account .si-field');
  await expect(field.locator('.si-apple')).toBeVisible();
  await expect(field.locator('.si-google')).toHaveCount(0);
  await expect(field.locator('.si-apple')).toHaveAttribute('aria-label', 'Apple sign-in');
  // Arabic names it too
  await page.evaluate(`setLang('ar')`);
  await page.evaluate(`renderAccount()`);
  await expect(page.locator('#tab-account .si-apple')).toHaveAttribute('aria-label', 'تسجيل الدخول عبر Apple');
});

test('a password account has no mark on My Account', async ({ page }) => {
  await stubSupabase(page, {
    sessions: [], queue_entries: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.org', phone: '0500000001', gender: 'male', nationality: null, socials: null }],
    'rpc:customer_about': [{ profession: null, workplace: null, heard_from: null, sign_in: null }],
  });
  await loginCustomer(page, { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#acc-workplace')).toBeVisible(); // customer_about has answered
  await expect(page.locator('#tab-account .si-ico')).toHaveCount(0);
});

// An account's email changed (the owner, 2026-09-30: a customer signed up with Apple, staff gave
// the account another email, and the mark said Google). The server now answers from the new email
// (20260930100000); the page asks it again at once rather than showing the old mark for ten minutes.
test('the editor asks for the marks again when it saves a new email, and not otherwise', async ({ page }) => {
  await accounts(page);
  await expect(row(page, 'Adam Apple').locator('.si-apple')).toHaveCount(1);
  let saved = false;
  page.on('request', (r) => { if (r.method() === 'PATCH' && /\/rest\/v1\/customers/.test(r.url())) saved = true; });
  // no other account holds the new address; after the save the server has no mark for it
  await page.route(/\/rest\/v1\/customers\?.*email=eq\./, (r) => r.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: [] }));
  await page.route(/\/rest\/v1\/rpc\/staff_sign_in_methods/, (r) => saved
    ? r.fulfill({ headers: { 'access-control-allow-origin': '*' }, json: methods.filter((m) => m.id !== 'a1') })
    : r.fallback());
  const calls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/rpc/staff_sign_in_methods')) calls.push(r.url()); });

  await page.evaluate(`showEditCustomerModal('a1')`);
  await page.evaluate('saveCustForm()');
  await expect.poll(() => saved).toBe(true);
  await expect(page.locator('#new-acct-modal #cf-email')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(calls).toHaveLength(0); // same email: the marks stand
  await expect(row(page, 'Adam Apple').locator('.si-apple')).toHaveCount(1);

  await page.evaluate(`showEditCustomerModal('a1')`);
  await page.locator('#cf-email').fill('adam@example.org');
  await page.evaluate('saveCustForm()');
  await expect.poll(() => calls.length).toBe(1);
  await expect(row(page, 'Adam Apple').locator('.si-ico')).toHaveCount(0);
  await expect(row(page, 'Gina Google').locator('.si-google')).toHaveCount(1);
});

test('a rider who changes their email has the mark read again', async ({ page }) => {
  const profile = { id: 'c1', name: 'Spec Rider', email: 'spec@icloud.com', phone: '0500000001', gender: 'male', nationality: 'Egypt', socials: null };
  await stubSupabase(page, {
    sessions: [], queue_entries: [],
    'rpc:customer_profile': [profile],
    'rpc:customer_about': [{ profession: null, workplace: null, heard_from: null, sign_in: 'apple' }],
    'rpc:customer_update_profile': true,
  });
  await loginCustomer(page, { id: 'c1', email: 'spec@icloud.com' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#tab-account .si-field .si-apple')).toBeVisible();
  let saved = false;
  page.on('request', (r) => { if (r.url().includes('/rpc/customer_update_profile')) saved = true; });
  const cors = { 'access-control-allow-origin': '*' };
  await page.route(/\/rest\/v1\/rpc\/customer_profile/, (r) => saved ? r.fulfill({ headers: cors, json: [{ ...profile, email: 'spec@example.org' }] }) : r.fallback());
  await page.route(/\/rest\/v1\/rpc\/customer_about/, (r) => saved ? r.fulfill({ headers: cors, json: [{ profession: null, workplace: null, heard_from: null, sign_in: null }] }) : r.fallback());

  await page.locator('#acc-email').fill('spec@example.org');
  await page.evaluate('saveAccount()');
  await expect.poll(() => saved).toBe(true);
  await expect(page.locator('#tab-account .si-ico')).toHaveCount(0);
  await expect(page.locator('#acc-email')).toHaveValue('spec@example.org');
});
