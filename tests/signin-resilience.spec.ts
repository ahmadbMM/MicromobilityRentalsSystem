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

// Google and Apple sign-in are gone (the owner, 2026-11-09). A session one of them left in supabase-js on a rider's
// phone is ended at boot, on that device only, so its token is never sent again; a password session is left alone.
const SB_KEY = 'sb-qpffkzmsfyilicwcsszz-auth-token';
const leftover = (provider: string) => JSON.stringify({
  access_token: 'at', refresh_token: 'rt', token_type: 'bearer', expires_in: 3600, expires_at: 4102444800,
  user: { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'g@example.com', app_metadata: { provider }, user_metadata: {} },
});
const seed = (page: Page, provider: string) => page.addInitScript(([k, v]) => {
  if (!sessionStorage.getItem('seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); }
}, [SB_KEY, leftover(provider)]);
for (const provider of ['google', 'apple']) {
  test(`a ${provider} session left on the phone is ended at boot`, async ({ page }) => {
    await seed(page, provider);
    await boot(page);
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), SB_KEY)).toBeNull();
  });
}
test('an email and password session is not touched', async ({ page }) => {
  await seed(page, 'email');
  await boot(page);
  await page.waitForTimeout(500);
  expect(await page.evaluate((k) => localStorage.getItem(k), SB_KEY)).not.toBeNull();
});
