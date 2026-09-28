import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The payment menus after the 2026-09-28 review: one helper (_popMenu) names them for the screen
// reader, drives them from the keyboard, gives focus back to the pill that opened them, and
// hangs them off the pill's START edge - the right edge in Arabic, where they used to hang off
// the left one and open away from the pill.
const D = '2099-02-10';
const sessions = [{ id: D, day: 'Tuesday', session_date: D, capacity: 40, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 40 }) }];
const queue_entries = [{ id: 'q1', session_id: D, session_day: 'Tuesday', session_date: D, queue_num: 1, name: 'Menu Rider', phone: '0551112222', customer_id: null, status: 'waiting', paid: false, price: 115, walk_in: true, type_preference: 'Road', registered_at: '2099-01-01T10:00:00Z' }];

async function roster(page: Page, lang = 'en') {
  await stubSupabase(page, { sessions, queue_entries, bikes: [] });
  await unlockStaff(page);
  await page.goto(lang === 'en' ? '/' : `/?lang=${lang}`);
  await waitForSb(page);
  // no background repaint under the measurements (the widening reload 1.2 s after boot redraws the roster)
  await page.evaluate(`window.__noWiden=true;S.staffTab='queue';S.queueView='bookings';S.sfSession='${D}';renderStaffQueue()`);
}
const pill = (page: Page) => page.locator('#tab-queue .pay-toggle, #tab-queue [data-on-click*=\'"showPayMenu"\']').filter({ visible: true }).first();

test('the payment menu is a menu: named, keyboard-driven, and focus returns to the pill', async ({ page }) => {
  await roster(page);
  const p = pill(page);
  await p.evaluate((el) => el.setAttribute('data-probe', '1'));
  await p.click();
  const menu = page.locator('.pay-menu-popup[role="menu"]');
  await expect(menu).toBeVisible();
  const items = menu.locator('[role="menuitemradio"]');
  await expect(items).toHaveCount(3);                                   // the three states
  await expect(menu.getByRole('menuitem', { name: /Edit Price/ })).toHaveCount(1);   // and the one action
  await expect(items.filter({ hasText: 'Pending' })).toHaveAttribute('aria-checked', 'true');   // the state it is in
  // the checked item has focus; the arrows move it; Escape closes and the pill has focus again
  expect(await page.evaluate(`document.activeElement.textContent.trim()`)).toContain('Pending');
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(`document.activeElement.textContent.trim()`)).toContain('Paid');
  await page.keyboard.press('ArrowUp');
  expect(await page.evaluate(`document.activeElement.textContent.trim()`)).toContain('Pending');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(await page.evaluate(`document.activeElement && document.activeElement.getAttribute('data-probe')`)).toBe('1');
});

test('in Arabic the menu hangs off the pill\'s right edge', async ({ page }) => {
  await roster(page, 'ar');
  const p = pill(page);
  await p.click();
  const menu = page.locator('.pay-menu-popup[role="menu"]');
  await expect(menu).toBeVisible();
  // the menu scales in (payMenuIn, .15s): measured mid-animation its box is a few pixels off
  await menu.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  // both measured once the menu is up: a background repaint between a measure and the click would move the pill
  const pr = (await p.boundingBox())!;
  const mr = (await menu.boundingBox())!;
  // right edges meet - unless the screen is too narrow for that, when the menu stops at the left edge
  const aligned = Math.abs((mr.x + mr.width) - (pr.x + pr.width)) < 6;
  expect(aligned || mr.x <= 8).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('a click outside closes it, a click on an item acts and closes it', async ({ page }) => {
  await roster(page);
  await pill(page).click();
  const menu = page.locator('.pay-menu-popup[role="menu"]');
  await expect(menu).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(menu).toHaveCount(0);
  await pill(page).click();
  await expect(menu).toBeVisible();
  await menu.locator('[role="menuitemradio"]', { hasText: 'Paid' }).click();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => page.evaluate(`(getQueue().find(e=>e.id==='q1')||{}).paid`)).toBe(true);
});
