import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// The owner, 2026-10-03: a rider changes their password whenever they like from My Account
// (customer_change_password), and sees their own desk purchases there (customer_purchases) -
// customers cannot read cashier_sales, so the block used to show on a staff device only.
const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

// stubSupabase answers every rpc, so a spec's own route for one is added after it (the newest route wins).
async function account(page: Page, fx: Fixtures = {}, cust: Record<string, unknown> = {}, routes?: () => Promise<unknown>) {
  await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], ...fx });
  if (routes) await routes();
  await loginCustomer(page, cust);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
}

test.describe('@customer:account change password', () => {
  test('checks the boxes, says each refusal, keeps this device signed in with the new token', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    // A wrong current password is answered, not raised (20261004100000); the others still raise.
    const answers = ['ok:BAD_PASSWORD', 'SAME_PASSWORD', 'LOCKED', 'tok:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'];
    await account(page, {}, {}, () => page.route(/\/rest\/v1\/rpc\/customer_change_password/, async (route) => {
      sent.push(route.request().postDataJSON());
      const a = answers.shift()!;
      if (a.startsWith('ok:') || a.startsWith('tok:')) return route.fulfill({ status: 200, headers: head, body: JSON.stringify(a.slice(a.indexOf(':') + 1)) });
      return route.fulfill({ status: 400, headers: head, body: JSON.stringify({ code: 'P0001', message: a, details: null, hint: null }) });
    }));
    await page.locator('#acc-pwd-btn').click();
    const dlg = page.locator('#acc-pwd-modal [role="dialog"]');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('Change your password');
    await expect(dlg).toContainText('Min 8 chars, 1 uppercase, 1 number');
    await expect(dlg).not.toContainText('Google or Apple'); // a password account: the current one is asked for

    const err = page.locator('#ap-err');
    const save = page.locator('#ap-save');
    await save.click();
    await expect(err).toHaveText('Enter your current password.');
    await page.fill('#ap-cur', 'Oldpass1');
    await page.fill('#ap-new', 'short');
    await save.click();
    await expect(err).toHaveText(/at least 8 characters/);
    await page.fill('#ap-new', 'Newpass12');
    await page.fill('#ap-new2', 'Newpass13');
    await save.click();
    await expect(err).toHaveText('Passwords do not match.');
    expect(sent).toHaveLength(0); // nothing reached the server yet

    // Show and hide.
    const eye = page.locator('#acc-pwd-modal .pw-eye').nth(1);
    await eye.click();
    await expect(page.locator('#ap-new')).toHaveAttribute('type', 'text');
    await expect(eye).toHaveAttribute('aria-label', 'Hide password');
    await eye.click();
    await expect(page.locator('#ap-new')).toHaveAttribute('type', 'password');

    await page.fill('#ap-new2', 'Newpass12');
    await save.click();
    await expect(err).toHaveText('That is not your current password.');
    await save.click();
    await expect(err).toHaveText('Choose a password different from your current one.');
    await save.click();
    await expect(err).toHaveText('Too many wrong tries. Try again in 15 minutes.');
    await save.click();
    await expect(dlg).toContainText('any other phone or computer signed in to your account has been signed out');
    expect(sent[3]).toMatchObject({ p_id: 'c1', p_token: 'tok-spec', p_current: 'Oldpass1', p_new: 'Newpass12' });
    expect(await page.evaluate(`(S.loggedIn||{}).session_token`)).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(await page.evaluate(`JSON.parse(localStorage.getItem('cq_session')).session_token`)).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await dlg.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('#acc-pwd-modal [role="dialog"]')).toHaveCount(0);
  });

  test('a Google or Apple account may leave the current password empty to set one', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await account(page, { 'rpc:customer_about': [{ profession: null, workplace: null, heard_from: null, sign_in: 'google' }] }, { sign_in: 'google' },
      () => page.route(/\/rest\/v1\/rpc\/customer_change_password/, async (route) => {
        sent.push(route.request().postDataJSON());
        return route.fulfill({ status: 200, headers: head, body: JSON.stringify('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') });
      }));
    await page.locator('#acc-pwd-btn').click();
    const dlg = page.locator('#acc-pwd-modal [role="dialog"]');
    await expect(dlg).toContainText('Leave the current password empty');
    await page.fill('#ap-new', 'Newpass12');
    await page.fill('#ap-new2', 'Newpass12');
    await page.locator('#ap-save').click();
    await expect(dlg).toContainText('Your password is changed.');
    expect(sent[0]).toMatchObject({ p_current: '', p_new: 'Newpass12' });
    await page.keyboard.press('Escape');
    await expect(page.locator('#acc-pwd-modal [role="dialog"]')).toHaveCount(0);
  });
});

test.describe('@customer:account purchases', () => {
  test('lists the rider\'s own purchases from customer_purchases, voided and refunded struck out of the total', async ({ page }) => {
    const asked: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/customer_purchases')) asked.push(r.postDataJSON()); });
    await account(page, {
      'rpc:customer_purchases': [
        { id: 's1', at: '2026-10-02T18:00:00Z', name: 'Water', category: 'drinks', qty: 2, price: 5, pay: 'paid', receipt_id: 'r1', session_date: '2026-10-02', session_title: 'Saturday Social Ride', voided: false, refunded: false },
        { id: 's2', at: '2026-10-01T18:00:00Z', name: 'Gel', category: 'food', qty: 1, price: 12, pay: 'pending', receipt_id: 'r2', session_date: null, session_title: null, voided: false, refunded: false },
        { id: 's3', at: '2026-09-30T18:00:00Z', name: 'Gloves', category: 'gear', qty: 1, price: 60, pay: 'paid', receipt_id: 'r3', session_date: null, session_title: null, voided: true, refunded: false },
        { id: 's4', at: '2026-09-29T18:00:00Z', name: 'Cap', category: 'gear', qty: 1, price: 40, pay: 'refunded', receipt_id: 'r4', session_date: null, session_title: null, voided: false, refunded: true },
      ],
    });
    const box = page.locator('#acc-purch');
    await expect(box).toContainText('Purchases');
    const rows = box.locator('.cu-purch-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('Water');
    await expect(rows.nth(0)).toContainText('×2');
    await expect(rows.nth(0)).toContainText('Saturday Social Ride');
    await expect(rows.nth(0)).toContainText('Paid');
    await expect(rows.nth(1)).toContainText('Pending');
    await expect(rows.nth(2)).toHaveClass(/\boff\b/);
    await expect(rows.nth(2)).toContainText('Voided');
    await expect(rows.nth(3)).toHaveClass(/\boff\b/);
    await expect(rows.nth(3)).toContainText('Refunded');
    await expect(box.locator('.form-title bdi')).toContainText('22'); // 2 x 5 + 12; the voided and refunded lines are out
    expect(asked[0]).toMatchObject({ p_id: 'c1', p_token: 'tok-spec' });
  });

  test('says so when there are none', async ({ page }) => {
    await account(page, { 'rpc:customer_purchases': [] });
    await expect(page.locator('#acc-purch')).toContainText('No purchases yet.');
    await expect(page.locator('#acc-purch .cu-purch-row')).toHaveCount(0);
  });
});
