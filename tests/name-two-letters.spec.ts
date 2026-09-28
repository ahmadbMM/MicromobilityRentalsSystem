import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Every word of an account name has at least two letters (user rule, 2026-09-25): "A Khan" or
// "Sara M" is an initial, not a name. Judged wherever an account name is set; a name already on
// file is not re-judged until it changes. The database refuses the same as 'name_short'.

const SHORT = 'Write each name in full: every name needs at least two letters.';
const ok = (page: Page, names: string[]) => page.evaluate(`${JSON.stringify(names)}.map(n=>_namePartsOk(n))`);

test('the rule: one letter is refused anywhere in the name, two letters and syllables pass', async ({ page }) => {
  await stubSupabase(page, {});
  await page.goto('/');
  await waitForSb(page);
  expect(await ok(page, ['A Khan', 'Sara M', 'Ahmed M Alharbi', 'محمد م', 'Mohammed Al Ghamdi', 'Li Wei', 'राम की', '  Omar   Ali ', ''])).toEqual(
    [false, false, false, false, true, true, true, true, true]);
});

async function signupForm(page: Page, first: string, last: string) {
  await page.evaluate('openAuthModal()');
  await page.evaluate('switchAuthMode("signup")');
  await page.fill('#a-first', first);
  await page.fill('#a-last', last);
  await page.evaluate('setSignupGender("male")');
  await page.fill('#a-email', 'faisal@example.com');
  await page.fill('#a-phone', '0508566560');
  await page.fill('#a-pwd', 'Zq8xTselah');
  await page.fill('#a-pwd2', 'Zq8xTselah');
  await page.fill('#a-height', '175');
}

test('sign-up: a one-letter name never leaves the form', async ({ page }) => {
  const calls: unknown[] = [];
  await stubSupabase(page, {});
  await page.route(/\/rest\/v1\/rpc\/customer_signup/, async r => { calls.push(1); await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '[]' }); });
  await page.goto('/');
  await waitForSb(page);
  await signupForm(page, 'Faisal', 'B');
  await page.evaluate('S.signupAck=true;doSignup()');
  await expect(page.locator('#auth-err')).toContainText(SHORT);
  expect(calls).toHaveLength(0);
});

test('sign-up: the server refusing a short name reads as the same message', async ({ page }) => {
  await stubSupabase(page, {});
  await page.route(/\/rest\/v1\/rpc\/customer_signup/, r => r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({ code: '22023', message: 'name_short', hint: 'Every part of a name needs at least two letters.' }) }));
  await page.goto('/');
  await waitForSb(page);
  await signupForm(page, 'Faisal', 'Babalghoum');
  await page.evaluate('S.signupAck=true;doSignup()');
  await expect(page.locator('#auth-err')).toContainText(SHORT);
});

test('Google or Apple: an initial from the provider has to be written out before the account is made', async ({ page }) => {
  const calls: unknown[] = [];
  await stubSupabase(page, {});
  await page.route(/\/rest\/v1\/rpc\/customer_oauth_signup/, async r => { calls.push(1); await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '[]' }); });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S._pendingGoogle={email:'j@x.com',name:'J Smith'};openGoogleComplete()`);
  await expect(page.locator('#a-first')).toHaveValue('J');
  await page.evaluate('setSignupGender("male")');
  await page.evaluate('doCompleteGoogle()');
  await expect(page.locator('#auth-err')).toContainText(SHORT);
  expect(calls).toHaveLength(0);
});

test('My Account: a short name already on file saves as it is; a new one is refused', async ({ page }) => {
  const saves: Record<string, unknown>[] = [];
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Sara M Khan', email: 'spec@example.com', phone: '0500000001' }] });
  await page.route(/\/rest\/v1\/rpc\/customer_update_profile/, async r => { saves.push(r.request().postDataJSON()); await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: 'true' }); });
  await loginCustomer(page, { id: 'c1', name: 'Sara M Khan', session_token: 'tok' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#acc-first')).toBeVisible();
  await page.evaluate('saveAccount()');
  await expect.poll(() => saves.length).toBe(1);
  await page.evaluate(`document.getElementById('acc-middle').value='';document.getElementById('acc-last').value='K'`);
  await page.evaluate('saveAccount()');
  await expect(page.locator('#acc-err')).toHaveText(SHORT);
  expect(saves).toHaveLength(1);
});

test('the correction pop-up will not take an initial for a name', async ({ page }) => {
  const sent: unknown[] = [];
  await stubSupabase(page, {
    sessions: [{ id: '2099-01-01', session_date: '2099-01-01', day: 'Sunday', status: 'open', capacity: 20, created_at: 1, event_kind: 'jcc' }],
    queue_entries: [], 'rpc:my_bookings': [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', nationality: 'Jordan', gender: 'male', birth_date: '1990-01-01' }],
    'rpc:customer_fix_fields': ['name'], 'rpc:customer_fix_save': [],
  });
  page.on('request', r => { if (/rpc\/customer_fix_save/.test(r.url())) sent.push(1); });
  await loginCustomer(page, { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`selectEvent('jcc')`);
  await expect(page.locator('#fix-gate .fx-box')).toBeVisible();
  await page.fill('#fx-first', 'Spec');
  await page.fill('#fx-last', 'R');
  await page.click('#fx-save');
  await expect(page.locator('#fix-gate .fx-item[data-fx="name"] .pg-msg')).toHaveText(SHORT);
  expect(sent).toHaveLength(0);
});
