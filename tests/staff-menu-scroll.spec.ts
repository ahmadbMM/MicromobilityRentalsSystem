import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The sections menu behind the burger scrolls on its own. With the page at its top, the
// pull-to-refresh took every downward drag on the screen, so a menu scrolled down could not be
// dragged back up: the drag was swallowed (and asked for a refresh) instead of scrolling the
// list (the user, 2026-11-20: "the burger icon menu in staff page when scrolled down doesn't
// allow to scroll up again").

const sessions = [{ id: 's0', day: 'Sunday', session_date: '2099-02-08', capacity: 9, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null }];

test('the open sections menu scrolls back up with a finger at the top of the page', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'a finger drag on a phone');
  await page.setViewportSize({ width: 390, height: 600 }); // short enough that the menu scrolls
  await stubSupabase(page, { sessions, bikes: [], queue_entries: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue')`); // a section the pull-to-refresh works on
  await page.evaluate(`window.scrollTo(0,0)`);

  await page.locator('#snav-burger').click();
  const nav = page.locator('#staff-tab-nav');
  await expect(nav).toBeVisible();
  const room = await nav.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(room).toBeGreaterThan(150); // the list is longer than its box

  await nav.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const down = await nav.evaluate((el) => el.scrollTop);
  expect(down).toBeGreaterThan(150);
  expect(await page.evaluate(`window.scrollY`)).toBeLessThanOrEqual(2);
  await page.evaluate(`window._ptrHits=0;const f=_autoRefresh;_autoRefresh=(...a)=>{window._ptrHits++;return f(...a);}`);

  // A finger drags down inside the menu: the list scrolls back up.
  const box = (await nav.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture', {
    x: Math.round(box.x + box.width / 2), y: Math.round(box.y + 40),
    yDistance: 260, gestureSourceType: 'touch', speed: 800, preventFling: true,
  });
  await expect.poll(() => nav.evaluate((el) => el.scrollTop)).toBeLessThan(down - 100);
  await expect(nav).toBeVisible();                                 // still open
  expect(await page.evaluate(`window._ptrHits`)).toBe(0);         // and no refresh was asked for
});

test('the pull-to-refresh still works on the page itself', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'a finger drag on a phone');
  await page.setViewportSize({ width: 390, height: 600 });
  await stubSupabase(page, { sessions, bikes: [], queue_entries: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue')`);
  await page.evaluate(`window.scrollTo(0,0)`);
  await page.evaluate(`window._ptrHits=0;const f=_autoRefresh;_autoRefresh=(...a)=>{window._ptrHits++;return f(...a);}`);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture', {
    x: 195, y: 200, yDistance: 300, gestureSourceType: 'touch', speed: 800, preventFling: true,
  });
  await expect.poll(() => page.evaluate(`window._ptrHits`)).toBeGreaterThan(0);
});
