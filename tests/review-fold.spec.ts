import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The review's add-ons stay folded until the rider taps their arrow (the user, 2026-11-09).
const S1 = '2099-02-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 10, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":10}', addons: ['inv1'] }];
const WATER = { id: 'inv1', name: 'Water', qty: 50, price: 5, category: 'Beverages' };

async function toReview(page: Page) {
  await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: [], bikes: [], inventory: [WATER] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='${S1}';S.regQty=1;S.regBikeHeights=['175'];S.regBikeTypes=['Road'];
    S.regRiderNames=[undefined];S.regStep=3;renderRegister()`);
}

test.describe('@customer:reserve the review', () => {
  test('the add-ons stay folded until their arrow is tapped, and the row counts what was picked', async ({ page }) => {
    await toReview(page);
    const tog = page.locator('#reg-ad-tog');
    await expect(tog).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#reg-ad-body')).toBeHidden();
    await tog.click();
    await expect(tog).toHaveAttribute('aria-expanded', 'true');
    await expect(tog).toBeFocused();
    await page.locator('#reg-ad-chk-inv1').click();
    await expect(tog.locator('.cu-ad-n')).toHaveText('1');
    await expect(page.locator('#reg-ad-body')).toBeVisible(); // a pick keeps it open
    await tog.click();
    await expect(page.locator('#reg-ad-body')).toBeHidden();
    await expect(tog.locator('.cu-ad-n')).toHaveText('1'); // folded, the row still says how many
    await expect(page.locator('#tab-register .cu-rv-addon')).toContainText('Water'); // and the review lists it
  });

  test('another ride starts folded again', async ({ page }) => {
    await toReview(page);
    await page.locator('#reg-ad-tog').click();
    await expect(page.locator('#reg-ad-body')).toBeVisible();
    await page.evaluate(`S.regAddonsOpen='another';renderRegister()`);
    await expect(page.locator('#reg-ad-body')).toBeHidden();
  });
});
