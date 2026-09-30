import { test, expect } from '@playwright/test';
import { stubSupabase } from './helpers/supabase';

test.beforeEach(async ({ page }) => {
  await stubSupabase(page);
  await page.goto('/');
});

test('landing page renders with the customer app name', async ({ page }) => {
  await expect(page).toHaveTitle('MicroMobility Experiences');
  await expect(page.locator('#land-main-title')).toContainText('Reserve Your');
  await expect(page.locator('#land-sub')).toHaveText('Bicycle rentals & community rides in Jeddah');
});

test('shows the no-sessions message when nothing is bookable', async ({ page }) => {
  await expect(page.locator('#land-avail-strip')).toContainText('No sessions are currently open');
});

// Ten languages: the header control is a native dropdown that lists each one by its own
// name and shows the one you are reading (the rest is in languages.spec.ts).
test('the language dropdown switches to arabic and back', async ({ page }) => {
  await expect(page.locator('#lang-btn')).toHaveValue('en');
  await expect(page.locator('#lang-btn option', { hasText: 'العربية' })).toHaveCount(1);
  await page.locator('#lang-btn').selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#land-sub')).toHaveText('تأجير الدراجات وجولات مجتمعية في جدة');
  await expect(page.locator('#footer-copy')).toContainText('جميع الحقوق محفوظة');
  await expect(page.locator('#lang-btn')).toHaveValue('ar');
  await page.locator('#lang-btn').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.locator('#land-sub')).toContainText('Bicycle rentals');
});

test('language choice survives a reload', async ({ page }) => {
  await page.locator('#lang-btn').selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#land-sub')).toHaveText('تأجير الدراجات وجولات مجتمعية في جدة');
});
