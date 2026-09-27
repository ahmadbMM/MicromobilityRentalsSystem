import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, loadStaffHalf } from './helpers/supabase';

// Temporary customer tags: staff grant a tag permanently or with a validity window
// (a duration, or explicit start/end dates with a "Today" shortcut). _tagActive()
// is the client-side window test mirrored by the DB's _ctag_active().

test('_tagActive honours the [starts_at, expires_at) window', async ({ page }) => {
  await stubSupabase(page, {});
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);

  const cases = await page.evaluate(`(()=>{
    const n=Date.now(),D=864e5;
    return {
      permanent:_tagActive({}),
      inWindow:_tagActive({starts_at:n-D,expires_at:n+D}),
      notStarted:_tagActive({starts_at:n+D,expires_at:n+2*D}),
      expired:_tagActive({starts_at:n-2*D,expires_at:n-D}),
      openEnded:_tagActive({starts_at:n-D,expires_at:null}),
    };})()`);
  expect(cases).toEqual({ permanent: true, inWindow: true, notStarted: false, expired: false, openEnded: true });
});

test('the grant dialog offers permanent/temporary, duration or dates, and a Today shortcut', async ({ page }) => {
  await stubSupabase(page, {});
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await loadStaffHalf(page); // tags are staff-only: the dialog lives in the staff half

  await page.evaluate(`
    S.tags=[{id:'tag_x',name:'VIP',color:'#4aa8f8'}];
    S.customers=[{id:'c9',name:'Some Rider'}];
    showTagGrantModal('c9','tag_x');
  `);
  const modal = page.locator('#confirm-modal');
  await expect(modal).toContainText('Permanent');
  await expect(modal).toContainText('Temporary');
  await expect(modal).toContainText('Some Rider');

  // temporary -> duration mode by default
  await modal.locator('button', { hasText: 'Temporary' }).click();
  await expect(modal.locator('select')).toBeVisible();
  await expect(modal.locator('select option')).toHaveCount(8);

  // dates mode: Today is pre-checked and the start input is disabled
  await modal.locator('button', { hasText: 'Start & end date' }).click();
  await expect(modal.locator('input[type=checkbox]')).toBeChecked();
  await expect(modal.locator('input[type=date]').first()).toBeDisabled();

  // unticking Today frees the start date input
  await modal.locator('input[type=checkbox]').click();
  await expect(modal.locator('input[type=date]').first()).toBeEnabled();
});
