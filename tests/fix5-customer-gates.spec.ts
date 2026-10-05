import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The forced pages (the profile page, a correction request, an application's changes), 2026-10-05:
// a save that did not land said "check your connection" whatever happened. A sign-in the server no
// longer knows now signs the rider out with the session-expired message, a refusal is said as one,
// and only a failure on the way keeps the connection message.

async function profilePage(page: Page, fx: Record<string, unknown>) {
  await stubSupabase(page, fx);
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`_pgOpen(null,{birth_date:'',nationality:''},false);S._pg.birth='1990-01-01';S._pg.nat='Saudi Arabia';renderProfileGate()`);
  await expect(page.locator('#profile-gate .pg-box')).toBeVisible();
}

test.describe('@customer:gates fix5 forced pages', () => {
  test('a sign-in the server no longer knows signs the rider out', async ({ page }) => {
    await profilePage(page, { 'rpc:customer_set_birth_nat': false });
    await page.evaluate('_pgSave()');
    await expect.poll(() => page.evaluate('S.loggedIn')).toBeNull();
    await expect(page.locator('#profile-gate .pg-box')).toHaveCount(0);
    await expect(page.locator('#toast-container')).toContainText('signed out');
  });

  test("a refusal is said as one, not as the rider's connection", async ({ page }) => {
    await profilePage(page, { 'rpc:customer_set_birth_nat': { __rpcError: { status: 400, code: 'P0001', message: 'refused for a reason' } } });
    await page.evaluate('_pgSave()');
    await expect(page.locator('#profile-gate .pg-net')).toContainText(/That didn.t work/);
    await expect(page.locator('#profile-gate .pg-net')).not.toContainText('connection');
  });

  test('a failure on the way keeps the connection message', async ({ page }) => {
    await profilePage(page, {});
    await page.route(/\/rest\/v1\/rpc\/customer_set_birth_nat/, (r) => r.abort());
    await page.evaluate('_pgSave()');
    await expect(page.locator('#profile-gate .pg-net')).toContainText('connection');
  });

  test('a correction request whose sign-in has ended signs the rider out', async ({ page }) => {
    await stubSupabase(page, { 'rpc:customer_fix_save': null });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S._fix={next:null,fields:['height'],v:{},err:{},net:false,said:'',saving:false,photoUp:false};renderFixGate()`);
    await page.locator('#fx-height').fill('175');
    await page.evaluate('_fixSave()');
    await expect.poll(() => page.evaluate('S.loggedIn')).toBeNull();
    await expect(page.locator('#fix-gate .fx-box')).toHaveCount(0);
  });

  test("an application's changes sent too often say so", async ({ page }) => {
    await stubSupabase(page, { 'rpc:community_fix_submit': { ok: false, error: 'throttled' } });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S._afx={tok:'t',hex:'${'0'.repeat(36)}',learn:false,state:'ask',v:{},err:{},net:false,said:'',saving:false,fields:['profession'],was:{},first:'Spec'};renderAppFix()`);
    await page.locator('#afx-prof').fill('Engineer');
    await page.evaluate('_afxSave()');
    await expect(page.locator('#app-fix .pg-net')).toContainText('Too many tries');
  });
});
