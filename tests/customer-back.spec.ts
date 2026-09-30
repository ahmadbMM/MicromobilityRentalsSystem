import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Customer-page back navigation: a visible Back button (wizard step back, else the
// landing event picker) and a working browser Back (history states are deduped and
// carry the chosen event + wizard step).

const fixtures = {
  sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1, location: 'JCC' }],
  bikes: [{ id: 'b1', name: 'B1', size: 'M', type: 'Hybrid', status: 'available', rental_price: 57.5 }],
  queue_entries: [],
};

test('fresh signed-in visit lands on the event picker; Back returns there from the customer page', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);

  // a remembered customer entering the link starts on PICK YOUR EVENT, not the JCC list
  expect(await page.evaluate('S.view')).toBe('landing');
  await expect(page.locator('#land-events .landing-event-card:not(.ev-snd96)')).toHaveCount(2);

  // entering an event shows the customer page with its Back button
  await page.locator('#land-events .landing-event-card.ev-jcc').click();
  await page.waitForFunction(`S.view==='customer'`);
  await expect(page.locator('#cust-back-btn')).toBeVisible();
  await page.locator('#cust-back-btn').click();
  await page.waitForFunction(`S.view==='landing'`);
  await expect(page.locator('#land-events .landing-event-card:not(.ev-snd96)')).toHaveCount(2);
});

test('a same-tab reload lands on the event picker too, not the last customer page', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.addInitScript(() => { sessionStorage.setItem('cq_nav', JSON.stringify({ view: 'customer', ctab: 'register', ev: 'jcc', step: 1 })); });
  await page.goto('/');
  await waitForSb(page);
  expect(await page.evaluate('S.view')).toBe('landing');
  await expect(page.locator('#land-events .landing-event-card:not(.ev-snd96)')).toHaveCount(2);
});

test('browser Back returns from the customer page to the landing', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');

  await page.locator('#land-events .landing-event-card.ev-jcc').click();
  await page.waitForFunction(`S.view==='customer'`);

  await page.goBack();
  await page.waitForFunction(`S.view==='landing'`);
  await expect(page.locator('#land-events .landing-event-card:not(.ev-snd96)')).toHaveCount(2);
});

test('Back walks the Reserve wizard steps (button and browser alike)', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('register')`);

  await page.locator('.sess-card').first().click();
  await page.locator('#tab-register .mm-reg-foot button', { hasText: 'Continue' }).click();
  await page.waitForFunction('S.regStep===2');

  // browser Back: step 2 -> step 1 (not out of the app)
  await page.goBack();
  await page.waitForFunction('S.regStep===1');

  // forward again, then the visible Back button does the same. From step two it is the wizard's
  // own, in its footer; the page's Back hides there so the screen carries one Back (2026-09-30).
  await page.locator('#tab-register .mm-reg-foot button', { hasText: 'Continue' }).click();
  await page.waitForFunction('S.regStep===2');
  await expect(page.locator('#cust-back-btn')).toBeHidden();
  await page.locator('#tab-register .mm-reg-foot button', { hasText: 'Back' }).click();
  await page.waitForFunction('S.regStep===1');
  expect(await page.evaluate('S.view')).toBe('customer');
  await expect(page.locator('#cust-back-btn')).toBeVisible(); // step one leads back to the event picker
});
