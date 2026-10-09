import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The roster row's ⋯ menu is a side sheet: from the end edge on a desk, in the middle of the screen on a phone,
// headed by the rider and their number, one full row per action. It used to be a popup anchored on
// evt.currentTarget, which under the delegated dispatcher is the document, so it opened at the
// page's top-left, far from the row. All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const sess = { id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' };
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: 1, name: 'Rider ' + id,
  phone: '0550000000', customer_id: null, type_preference: 'Road', status: 'waiting', paid: false,
  price: 75, size: 'M', registered_at: '2099-01-01T10:00:00Z', ...extra,
});

async function roster(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [sess], queue_entries: [row('q1'), row('q2', { queue_num: 2 })], bikes: [], customers: [], tags: [], customer_tags: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.sfSession=${JSON.stringify(LIVE)};renderStaffQueue()`);
  await expect(page.locator('#q-results [aria-haspopup="menu"]').first()).toBeVisible();
}
const more = (page: Page) => page.locator('#q-results [aria-haspopup="menu"]').first();
const sheet = (page: Page) => page.locator('.row-sheet');

test('the menu opens as a sheet at the edge, headed by the rider, with every action as a row', async ({ page }) => {
  await roster(page);
  await more(page).click();
  await expect(sheet(page)).toBeVisible();
  await expect(page.locator('.pay-menu-popup')).toHaveCount(1);
  await expect(sheet(page).locator('.row-sheet-title')).toHaveText('Rider q1');
  await expect(sheet(page).locator('.row-sheet-sub')).toContainText('#1');
  await sheet(page).evaluate((e) => Promise.all(e.getAnimations({ subtree: true }).map((a) => a.finished))); // it slides in; measure it at rest
  const box = (await sheet(page).boundingBox())!;
  const vp = page.viewportSize()!;
  if (test.info().project.name === 'mobile') {
    // centred on a phone (the owner, 2026-09-30: "always center pages that pop up")
    expect(Math.abs(box.x + box.width / 2 - vp.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height / 2 - vp.height / 2)).toBeLessThanOrEqual(1);
  } else {
    expect(Math.round(box.x + box.width)).toBe(vp.width);
    expect(Math.round(box.y)).toBe(0);
    expect(Math.round(box.height)).toBe(vp.height);
    expect(box.width).toBeLessThanOrEqual(360);
  }
  // The rows are the registry's items, in order; the dangerous one is last and red.
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const reg: string[] = await page.evaluate(`S._rowMenus['q1'].map(i=>i.label)`);
  const rows = await sheet(page).locator('[role="menuitem"]').allTextContents();
  expect(rows.map(strip)).toEqual(reg.map(strip));
  const last = sheet(page).locator('[role="menuitem"]').last();
  await expect(last).toHaveClass(/danger/);
  await expect(last).toHaveCSS('color', /rgb\(/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.pay-menu-popup')).toHaveCount(0);
});

test('a row runs its action and the sheet closes; the backdrop and the × close it too', async ({ page }) => {
  await roster(page);
  await more(page).click();
  await sheet(page).locator('[role="menuitem"]', { hasText: 'No-Show' }).click();
  await expect(page.locator('.pay-menu-popup')).toHaveCount(0);
  // one-tap No-show (2026-10-09): it runs without a confirm
  await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: 'Marked as No-Show' }).first()).toBeAttached(); // a quiet toast
  await more(page).click();
  await expect(sheet(page)).toBeVisible();
  await page.locator('.row-sheet-bg').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.pay-menu-popup')).toHaveCount(0);
  await more(page).click();
  await sheet(page).locator('.row-sheet-close').click();
  await expect(page.locator('.pay-menu-popup')).toHaveCount(0);
});
