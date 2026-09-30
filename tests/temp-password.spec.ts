import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// A temporary password staff make for a customer (the owner, 2026-09-29): Generate in the account
// editor puts a random one in the password box; saved untouched it goes through
// staff_set_customer_temp_password (which marks the account must_change_pwd, 20260929120000) and the
// message to send the customer opens. A password staff type themselves is set as before.
// All Supabase traffic is stubbed.

const customers = [{ id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', height: 165, gender: 'female', created_at: '2026-01-05T10:00:00Z' }];

async function editor(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], staff_options: [],
    'rpc:staff_set_customer_temp_password': true, 'rpc:staff_set_customer_password': true, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity();showEditCustomerModal('c1')`);
  await expect(page.locator('#new-acct-modal #cf-pwd')).toBeVisible();
}
function rpcs(page: Page) {
  const out: { fn: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    const m = /rpc\/(staff_set_customer_(?:temp_)?password)/.exec(r.url());
    if (m && r.method() === 'POST') out.push({ fn: m[1], body: JSON.parse(r.postData() || '{}') });
  });
  return out;
}

test('Generate makes a random temporary password; saving it marks it temporary and opens the message to send', async ({ page }) => {
  await editor(page);
  const calls = rpcs(page);
  const hint = page.locator('#cf-pwd-temp');
  await expect(hint).toBeHidden();
  await page.locator('.cf-pwd-gen').click();
  const pwd = await page.locator('#cf-pwd').inputValue();
  expect(pwd).toMatch(/^[A-HJ-NP-Za-km-np-z2-9]{10}$/); // no 0/O, 1/l/I to misread
  expect(pwd).toMatch(/[A-Z]/);
  expect(pwd).toMatch(/[a-z]/);
  expect(pwd).toMatch(/[0-9]/);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('chooses their own the next time they sign in');
  await page.locator('.cf-pwd-gen').click(); // a second press, a new one
  const pwd2 = await page.locator('#cf-pwd').inputValue();
  expect(pwd2).not.toBe(pwd);

  await page.evaluate('saveCustForm()');
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toEqual({ fn: 'staff_set_customer_temp_password', body: { p_customer_id: 'c1', p_new_pwd: pwd2 } });
  const msg = page.locator('#confirm-modal .ca-msg-box');
  await expect(msg).toBeVisible();
  await expect(msg.locator('.ca-pwd')).toHaveText(pwd2);
  await expect(msg).toContainText('Their old password no longer works');
  const txt = await msg.locator('#ca-msg-text').inputValue();
  // The password, where to sign in, and that it is changed at once - nothing else about the account
  // (the owner, 2026-09-30).
  expect(txt).toBe(['Hi Huda,', '', 'We’ve set a temporary password for your MicroMobility account:', pwd2, '', 'Sign in with it here:', 'https://micromobilityrentals.pages.dev', '',
    'As soon as you sign in with it, you’ll be asked to change it to a password of your own.', '', 'The MicroMobility team'].join('\n'));
  for (const none of ['huda.saleh@gmail.com', '0551239876']) expect(txt).not.toContain(none);
  // in the staff member's language to begin with, any of the ten
  await msg.locator('#ca-msg-lang').selectOption('ar');
  const ar = await msg.locator('#ca-msg-text').inputValue();
  expect(ar).toContain('أنشأنا كلمة مرور مؤقتة لحسابك في MicroMobility:\n' + pwd2);
  expect(ar).toContain('سيُطلب منك تغييرها إلى كلمة مرور خاصة بك');
  await msg.locator('#ca-msg-lang').selectOption('en');
  expect(await msg.locator('a.ca-wa').getAttribute('href')).toMatch(/^https:\/\/wa\.me\/966551239876\?text=/);
  // The log keeps that it was made, never the password
  const log = await page.evaluate(`JSON.stringify(S.actionLog||S.log||[])`);
  expect(log).not.toContain(pwd2);
});

test('a password staff type themselves is set as before, with no temporary mark and no message', async ({ page }) => {
  await editor(page);
  const calls = rpcs(page);
  await page.locator('.cf-pwd-gen').click();
  await page.locator('#cf-pwd').fill('MyChoice99'); // generated, then replaced by hand
  await expect(page.locator('#cf-pwd-temp')).toBeHidden();
  await page.evaluate('saveCustForm()');
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toEqual({ fn: 'staff_set_customer_password', body: { p_customer_id: 'c1', p_new_pwd: 'MyChoice99' } });
  await page.waitForTimeout(300);
  await expect(page.locator('#confirm-modal .ca-msg-box')).toHaveCount(0);
});

test('a refused temporary password says so and keeps the editor open', async ({ page }) => {
  await editor(page, { 'rpc:staff_set_customer_temp_password': false });
  await page.locator('.cf-pwd-gen').click();
  await page.evaluate('saveCustForm()');
  await expect(page.locator('.toast.error, .toast-error, #toast-container .error').first()).toBeVisible();
  await expect(page.locator('#new-acct-modal #cf-pwd')).toBeVisible();
  await expect(page.locator('#confirm-modal .ca-msg-box')).toHaveCount(0);
});
