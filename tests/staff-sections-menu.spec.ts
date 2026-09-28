import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// On a phone the staff rail used to become a strip you had to drag sideways before Analytics
// or History came into view. It is a menu now, behind a bar that is the burger icon alone.

const sessions = [{ id: 's0', day: 'Sunday', session_date: '2099-02-08', capacity: 9, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null }];

async function staffOn(page: import('@playwright/test').Page, w: number, h: number) {
  await page.setViewportSize({ width: w, height: h });
  await stubSupabase(page, { sessions, bikes: [], queue_entries: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue')`);
}

test.describe('small screens', () => {
  test('the sections live behind a burger, and the burger is the icon alone', async ({ page }) => {
    await staffOn(page, 390, 780);
    const burger = page.locator('#snav-burger');
    const nav = page.locator('#staff-tab-nav');

    await expect(burger).toBeVisible();
    await expect(burger).toHaveAttribute('aria-expanded', 'false');
    await expect(nav).toBeHidden();                       // shut, it takes no room at all
    await expect(burger).toHaveText('');                  // no section name beside the icon
    await expect(burger).toHaveAccessibleName('Sections'); // ...but it still has a name

    await burger.click();
    await expect(nav).toBeVisible();
    await expect(burger).toHaveAttribute('aria-expanded', 'true');

    // Every section is reachable without dragging anything sideways, group headings included.
    for (const name of ['Bookings', 'Sales', 'Inventory', 'Community', 'Analytics', 'History']) { // Riders is a page in Bookings now
      await expect(nav.locator('.tab-btn', { hasText: name })).toBeVisible();
    }
    await expect(nav.locator('.snav-group', { hasText: 'Insights' })).toBeVisible();

    // Choosing one closes the menu; the bar stays the icon alone.
    await nav.locator('.tab-btn', { hasText: 'Analytics' }).click();
    await expect(nav).toBeHidden();
    await expect(burger).toHaveText('');
    expect(await page.evaluate(`S.staffTab`)).toBe('analytics');
  });

  test('the scrim and Escape both close it', async ({ page }) => {
    await staffOn(page, 390, 780);
    await page.locator('#snav-burger').click();
    await expect(page.locator('#staff-tab-nav')).toBeVisible();
    // Tap below the panel: the scrim covers the rest of the screen, the menu covers its own box.
    const box = await page.locator('#staff-tab-nav').boundingBox();
    await page.mouse.click(195, Math.min(770, Math.round((box?.y ?? 0) + (box?.height ?? 0) + 40)));
    await expect(page.locator('#staff-tab-nav')).toBeHidden();

    await page.locator('#snav-burger').click();
    await expect(page.locator('#staff-tab-nav')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#staff-tab-nav')).toBeHidden();
  });

  test('nothing scrolls sideways any more', async ({ page }) => {
    await staffOn(page, 390, 780);
    await page.locator('#snav-burger').click();
    const over = await page.locator('#staff-tab-nav').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(over).toBeLessThanOrEqual(1);
  });
});

test('on a desktop the rail is unchanged and there is no burger', async ({ page }) => {
  await staffOn(page, 1440, 900);
  await expect(page.locator('#snav-burger')).toBeHidden();
  await expect(page.locator('#staff-tab-nav')).toBeVisible();
  await expect(page.locator('#staff-tab-nav .tab-btn', { hasText: 'History' })).toBeVisible();
});
