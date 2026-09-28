import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// A signed-out visitor's two pages (the owner, 2026-09-28): Sign in at / and Create account at
// /signup, each named by its title, with a plain line under the title for the visitor on the wrong
// one - "New to MicroMobility? Create account", "Already have an account? Sign in" - a sentence with
// a link, not a box. The old Log In / Sign Up tabs are gone. All Supabase traffic is stubbed.

const at = (page: Page) => { const u = new URL(page.url()); return u.pathname + u.search; };
const bar = (page: Page) => page.locator('#auth-modal .auth-switch');

async function open(page: Page, path = '/') {
  await stubSupabase(page, {});
  await page.goto(path);
  await waitForSb(page);
  await expect(page.locator('#auth-modal.as-page .auth-title')).toBeVisible();
}

test('Sign in is the first page: its title, and the line under it that leads to Create account', async ({ page }) => {
  await open(page);
  await expect(page.locator('.auth-title')).toHaveText('Sign in');
  await expect(page.locator('.auth-sub')).toHaveText('Welcome back.');
  await expect(page.locator('.auth-tab')).toHaveCount(0);
  await expect(bar(page)).toHaveText('New to MicroMobility? Create account');
  await expect(bar(page).locator('button')).toHaveText('Create account');
  await expect(page.locator('.auth-submit')).toHaveText('Sign in');
  // the line sits right under the title and its subtitle, plain text: no border, no background
  expect(await page.evaluate(`document.querySelector('#auth-modal .auth-sub').nextElementSibling.classList.contains('auth-switch')`)).toBe(true);
  expect(await bar(page).evaluate((el) => { const c = getComputedStyle(el); return [c.borderTopWidth, c.backgroundColor]; })).toEqual(['0px', 'rgba(0, 0, 0, 0)']);
  // the whole sentence is green (the link's own ink), and 16px
  expect(await bar(page).evaluate((el) => { const c = getComputedStyle(el); return [c.color === getComputedStyle(el.querySelector('button')!).color, c.fontSize]; })).toEqual([true, '16px']);
  // arriving does not ring the link as if it were picked
  expect(await page.evaluate('document.activeElement === document.body')).toBe(true);
});

test('Create account has its own address; Back returns to Sign in, and the line there leads back', async ({ page }) => {
  await open(page);
  await bar(page).locator('button').click();
  await expect(page.locator('.auth-title')).toHaveText('Create account');
  await expect(page.locator('.auth-sub')).toHaveText('Book your rides and keep your tickets in one place.');
  expect(at(page)).toBe('/signup');
  await expect(bar(page)).toHaveText('Already have an account? Sign in');
  await expect(bar(page).locator('button')).toHaveText('Sign in');
  await expect(page.locator('.auth-submit')).toHaveText('Create account');
  await expect(page.locator('#a-first')).toBeVisible();

  await page.goBack();
  await expect(page.locator('.auth-title')).toHaveText('Sign in');
  expect(at(page)).toBe('/');
  await page.goForward();
  await expect(page.locator('.auth-title')).toHaveText('Create account');

  await bar(page).locator('button').click();
  await expect(page.locator('.auth-title')).toHaveText('Sign in');
  expect(at(page)).toBe('/');
});

test('/signup opens Create account straight away, and a language kept in the address stays', async ({ page }) => {
  await open(page, '/signup?lang=ar');
  await expect(page.locator('.auth-title')).toHaveText('إنشاء حساب');
  await expect(bar(page)).toContainText('لديك حساب بالفعل؟');
  await expect(bar(page).locator('button')).toHaveText('تسجيل الدخول');
  expect(at(page)).toBe('/signup?lang=ar');
});

test('Forgot password is reached from Sign in and leaves the address at /', async ({ page }) => {
  await open(page, '/signup');
  await bar(page).locator('button').click();
  await page.evaluate(`switchAuthMode('forgot')`);
  await expect(bar(page)).toHaveCount(0);
  expect(at(page)).toBe('/');
});

test('the website hand-off link for sign-up lands on /signup', async ({ page }) => {
  await open(page, '/?handoff=site&auth=signup');
  await expect(page.locator('.auth-title')).toHaveText('Create account');
  expect(at(page)).toBe('/signup');
});

test('signed in, /signup is just the event picker at /', async ({ page }) => {
  await stubSupabase(page, {});
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/signup');
  await waitForSb(page);
  await page.waitForFunction(`S.view==='landing'`);
  await expect(page.locator('#auth-modal.as-page')).toHaveCount(0);
  await expect.poll(() => at(page)).toBe('/');
});
