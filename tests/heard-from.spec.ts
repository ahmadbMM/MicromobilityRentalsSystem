import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// How an account heard of us (customers.heard_from). The app's sign-up asked it from 2026-09-27 to
// 2026-09-28; the owner took it off (the website's community and learn-to-ride forms ask it now), so
// neither the form nor the Google completion shows it or sends it. The desk still reads what accounts
// carry. All Supabase traffic is stubbed.

const JSON_OK = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

test('the sign-up form does not ask how they heard of us, and signs up without it', async ({ page }) => {
  await stubSupabase(page, {});
  await page.goto('/');
  await waitForSb(page);
  const calls: Record<string, unknown>[] = [];
  await page.route(/\/rest\/v1\/rpc\/customer_signup/, async (r) => { calls.push(r.request().postDataJSON()); await r.fulfill({ status: 200, headers: JSON_OK, body: JSON.stringify([{ session_token: 'tok-h' }]) }); });
  await page.evaluate('openAuthModal();switchAuthMode("signup")');
  await expect(page.locator('#a-first')).toBeVisible();
  await expect(page.locator('#a-heard')).toHaveCount(0);
  await expect(page.locator('#auth-modal')).not.toContainText('How did you hear about us?');
  await page.fill('#a-first', 'Faisal');
  await page.fill('#a-last', 'Babalghoum');
  await page.evaluate('setSignupGender("male")');
  await page.fill('#a-email', 'faisal@example.com');
  await page.fill('#a-phone', '0508566560');
  await page.fill('#a-pwd', 'Zq8xTselah');
  await page.fill('#a-pwd2', 'Zq8xTselah');
  await page.fill('#a-height', '175');
  await page.evaluate('S.signupAck=true;doSignup()');
  await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
  expect(calls).toHaveLength(1);
  expect(calls[0]).not.toHaveProperty('p_heard_from');
});

test('the Google completion does not ask either, and writes nothing about it', async ({ page }) => {
  await stubSupabase(page, {});
  await page.goto('/');
  await waitForSb(page);
  const made: unknown[] = [];
  await page.route(/\/rest\/v1\/rpc\/customer_oauth_signup/, async (r) => { made.push(1); await r.fulfill({ status: 200, headers: JSON_OK, body: JSON.stringify([{ session_token: 'gtok' }]) }); });
  const heard: unknown[] = [];
  await page.route(/\/rest\/v1\/rpc\/customer_set_heard_from/, async (r) => { heard.push(1); await r.fulfill({ status: 200, headers: JSON_OK, body: 'true' }); });
  await page.evaluate(`S._pendingGoogle={email:'g@x.com',name:'Gee User'};openGoogleComplete()`);
  await expect(page.locator('#a-height')).toBeVisible();
  await expect(page.locator('#a-heard')).toHaveCount(0);
  await page.evaluate('setSignupGender("female")');
  await page.fill('#a-height', '156');
  await page.fill('#a-phone', '0508727012');
  await page.evaluate('S.signupAck=true;doCompleteGoogle()');
  await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
  expect(made).toHaveLength(1);
  expect(heard).toHaveLength(0);
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
