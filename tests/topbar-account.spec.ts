import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The signed-in avatar + first name in the header open Account, from the landing page
// and from any customer tab.
const sessions = [{ id: '2099-01-01', session_date: '2099-01-01', day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }];

test('the avatar and name in the header open Account', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`goLanding()`);
  const link = page.locator('#topbar-right .cust-topbar-link');
  await expect(link).toContainText('Spec');
  await link.click();
  await expect.poll(() => page.evaluate('S.custTab')).toBe('account');
  await expect(page.locator('#acc-r-personal')).toBeVisible();   // the account menu is on screen
  await page.evaluate(`setCustTab('register')`);
  await page.locator('#topbar-right .cust-topbar-link').click();
  await expect.poll(() => page.evaluate('S.custTab')).toBe('account');
});
