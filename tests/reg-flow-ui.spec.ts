import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

const fixtures = {
  sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1, location: 'JCC' }],
  bikes: [{ id: 'b1', name: 'B1', size: 'M', type: 'Hybrid', status: 'available', rental_price: 57.5 }],
  queue_entries: [],
};

test('booking flow shows a progress stepper, the waiver a step of its own, that advances', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('register')`);

  const stepper = page.locator('#tab-register .reg-stepper');
  await expect(stepper).toBeVisible();
  await expect(stepper).toHaveAttribute('aria-label', 'Step 1 of 4'); // ride, riders, waiver, confirm
  await expect(stepper).toContainText('Ride');                         // active label

  // advance to step 2
  await page.locator('.sess-card').first().click();
  await page.locator('#tab-register .mm-reg-foot button', { hasText: 'Continue' }).click();
  await expect(page.locator('#tab-register .reg-stepper')).toHaveAttribute('aria-label', 'Step 2 of 4');
  await expect(page.locator('#tab-register .reg-stepper')).toContainText('Riders');
});

test('the step action buttons are in a sticky footer bar', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('register')`);
  // step 1 Continue lives in the sticky footer
  const foot = page.locator('#tab-register .mm-reg-foot');
  await expect(foot).toBeVisible();
  await expect(foot.locator('button', { hasText: 'Continue' })).toBeVisible();
});

// On a phone the sticky Continue bar used to stick to the very bottom of the screen, which is
// where the fixed bottom bar sits, and the bottom bar is painted above it: the button was out
// of sight until the rider scrolled to the end of a long session list.
test('on a phone the sticky Continue bar sits above the bottom bar, not under it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: `2099-02-${String(i + 1).padStart(2, '0')}`, day: 'Friday', session_date: `2099-02-${String(i + 1).padStart(2, '0')}`,
    capacity: 12, status: 'open', created_at: 1, location: 'JCC',
  }));
  await stubSupabase(page, { ...fixtures, sessions: many });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('register')`);
  await page.locator('.sess-card').first().click();
  await page.evaluate(() => window.scrollTo(0, 250));
  await page.waitForTimeout(100);

  const nav = (await page.locator('#cust-bottom-nav').boundingBox())!;
  const btn = page.locator('#tab-register .mm-reg-foot button', { hasText: 'Continue' });
  const box = (await btn.boundingBox())!;
  expect(nav.y).toBeLessThan(700);                          // the bottom bar is on screen
  expect(box.y + box.height).toBeLessThanOrEqual(nav.y + 1); // and the button sits on top of it
  const onTop = await btn.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  });
  expect(onTop).toBe(true);
});
