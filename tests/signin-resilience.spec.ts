import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, waitForSb } from './helpers/supabase';

// Sign-in paths that must tell a failed request apart from an answer.


async function boot(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, fixtures);
  await page.goto('/');
  await waitForSb(page);
}

test('Safari\'s "Load failed" at login is a connection problem, not a wrong password', async ({ page }) => {
  await boot(page);
  await page.evaluate('openAuthModal()');
  await page.evaluate(`sb.rpc=async()=>({data:null,error:{message:'TypeError: Load failed',details:'',hint:'',code:''}})`);
  await page.fill('#a-identifier', 'x@y.com');
  await page.fill('#a-pwd', 'Zq8xTselah');
  await page.evaluate('doLogin()');
  await expect(page.locator('#auth-err')).toHaveText(/Connection error|offline/);
});

test('a Google return whose account lookup fails does not open the new-account form', async ({ page }) => {
  await boot(page, { 'rpc:customer_oauth_login': { __rpcError: { status: 503, code: '', message: 'upstream unavailable' } } });
  await page.evaluate(`sb.auth.getSession=async()=>({data:{session:{user:{email:'g@example.com',app_metadata:{provider:'google'},user_metadata:{full_name:'Gee Rider'}}}}})`);
  expect(await page.evaluate('handleGoogleReturn()')).toBe(false);
  expect(await page.evaluate('S._pendingGoogle')).toBeNull();
  await expect(page.locator('.toast').last()).toContainText(/Connection error|offline/);
});

test('a Google return with no account still goes to the new-account form', async ({ page }) => {
  await boot(page, { 'rpc:customer_oauth_login': [] });
  await page.evaluate(`sb.auth.getSession=async()=>({data:{session:{user:{email:'g@example.com',app_metadata:{provider:'google'},user_metadata:{full_name:'Gee Rider'}}}}})`);
  expect(await page.evaluate('handleGoogleReturn()')).toBe('complete');
  expect(await page.evaluate('S._pendingGoogle && S._pendingGoogle.email')).toBe('g@example.com');
});

