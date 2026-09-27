import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// How a new account heard of us (customers.heard_from): obligatory at sign-up, the form and the
// Google completion alike, with one option per source and "Invited" among them; the desk reads
// it on the account. All Supabase traffic is stubbed.

const OPTS = ['instagram', 'tiktok', 'snapchat', 'x', 'facebook', 'youtube', 'whatsapp', 'google', 'friend', 'invited', 'passed_by', 'event', 'hotel', 'school', 'work', 'community', 'other'];

async function signupForm(page: Page) {
  await stubSupabase(page, {});
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('openAuthModal();switchAuthMode("signup")');
  await page.fill('#a-first', 'Faisal');
  await page.fill('#a-last', 'Babalghoum');
  await page.evaluate('setSignupGender("male")');
  await page.fill('#a-email', 'faisal@example.com');
  await page.fill('#a-phone', '0508566560');
  await page.fill('#a-pwd', 'Zq8xTselah');
  await page.fill('#a-pwd2', 'Zq8xTselah');
  await page.fill('#a-height', '175');
}

test('the sign-up form asks how they heard of us, with every source and Invited, and will not go on without an answer', async ({ page }) => {
  await signupForm(page);
  const sel = page.locator('#a-heard');
  await expect(sel).toBeVisible();
  expect(await sel.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).toEqual(['', ...OPTS]);
  await expect(sel.locator('option[value="invited"]')).toHaveText('Invited');
  const calls: unknown[] = [];
  await page.route(/\/rest\/v1\/rpc\/customer_signup/, async (r) => { calls.push(r.request().postDataJSON()); await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([{ session_token: 'tok-h' }]) }); });
  await page.evaluate('S.signupAck=true;doSignup()');
  await expect(page.locator('#auth-err')).toContainText('how you heard about us');
  expect(calls).toHaveLength(0);
  await sel.selectOption('invited');
  await page.evaluate('doSignup()');
  await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
  expect(calls).toHaveLength(1);
  expect((calls[0] as Record<string, unknown>).p_heard_from).toBe('invited');
  expect(await page.evaluate('S.loggedIn.heard_from')).toBe('invited');
});

test('the Google completion asks too, and writes the answer onto the account it makes', async ({ page }) => {
  await stubSupabase(page, {});
  await page.goto('/');
  await waitForSb(page);
  const made: unknown[] = [];
  await page.route(/\/rest\/v1\/rpc\/customer_oauth_signup/, async (r) => { made.push(1); await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([{ session_token: 'gtok' }]) }); });
  const heard: Record<string, unknown>[] = [];
  await page.route(/\/rest\/v1\/rpc\/customer_set_heard_from/, async (r) => { heard.push(r.request().postDataJSON()); await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: 'true' }); });
  await page.evaluate(`S._pendingGoogle={email:'g@x.com',name:'Gee User'};openGoogleComplete()`);
  await expect(page.locator('#a-heard')).toBeVisible();
  await page.evaluate('setSignupGender("female")');
  await page.fill('#a-height', '156');
  await page.fill('#a-phone', '0508727012');
  await page.evaluate('S.signupAck=true;doCompleteGoogle()');
  await expect(page.locator('#auth-err')).toContainText('how you heard about us');
  expect(made).toHaveLength(0);
  await page.selectOption('#a-heard', 'friend');
  await page.evaluate('doCompleteGoogle()');
  await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
  expect(made).toHaveLength(1);
  expect(heard).toEqual([{ p_id: expect.any(String), p_token: 'gtok', p_value: 'friend' }]);
});

test('the desk reads it on the account row and in the editor', async ({ page }) => {
  const customers = [
    { id: 'c1', name: 'Invited Rider', email: 'inv@gmail.com', phone: '+966551876500', gender: 'male', created_at: '2026-09-01T10:00:00Z', heard_from: 'invited' },
    { id: 'c2', name: 'Desk Rider', email: 'desk@gmail.com', phone: '+966551876501', gender: 'male', created_at: '2026-09-01T10:00:00Z', heard_from: 'desk' },
  ];
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], tags: [], customers, customer_tags: [], staff_options: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
  const rows = page.locator('#am-cust-rows');
  await expect(rows).toContainText('Invited');
  await expect(rows).toContainText('Added by our team');
  await page.evaluate(`showEditCustomerModal('c1')`);
  await expect(page.locator('#cust-form-modal, .modal-backdrop').last()).toContainText('How did you hear about us?');
  await expect(page.locator('#cust-form-modal, .modal-backdrop').last()).toContainText('Invited');
});
