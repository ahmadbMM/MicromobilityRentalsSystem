import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The sections menu behind the burger scrolls on its own. With the page at its top, the
// pull-to-refresh took every downward drag on the screen, so a menu scrolled down could not be
// dragged back up: the drag was swallowed (and asked for a refresh) instead of scrolling the
// list (the user, 2026-11-20: "the burger icon menu in staff page when scrolled down doesn't
// allow to scroll up again").
//
// The finger is the page's own touch events, sent straight to it: a synthesized scroll gesture
// moved nothing on CI's headless Linux Chrome (it did on a Mac), so the spec reads what the
// pull-to-refresh did with the drag - held it (preventDefault) and refreshed, or let it pass.

const sessions = [{ id: 's0', day: 'Sunday', session_date: '2099-02-08', capacity: 9, status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null }];

async function staffPhone(page: Page) {
  await page.setViewportSize({ width: 390, height: 600 }); // short enough that the menu scrolls
  await stubSupabase(page, { sessions, bikes: [], queue_entries: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue')`); // a section the pull-to-refresh works on
  await page.evaluate(`window.scrollTo(0,0)`);
  await page.evaluate(`window._ptrHits=0;const f=_autoRefresh;_autoRefresh=(...a)=>{window._ptrHits++;return f(...a);}`);
}

/** A finger drags 200px down from the last match of `sel`; says whether the page held the drag. */
function drag(page: Page, sel: string) {
  return page.evaluate((s) => {
    const all = document.querySelectorAll<HTMLElement>(s), el = all[all.length - 1];
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + Math.min(r.height / 2, 60);
    const at = (dy: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y + dy });
    const send = (type: string, dy: number, end = false) => {
      const t = at(dy), ev = new TouchEvent(type, { bubbles: true, cancelable: true, touches: end ? [] : [t], targetTouches: end ? [] : [t], changedTouches: [t] });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    send('touchstart', 0);
    let held = false;
    for (const dy of [20, 60, 120, 200]) held = send('touchmove', dy) || held;
    send('touchend', 200, true);
    return held;
  }, sel);
}

test('a drag inside the open sections menu scrolled down is the menu\'s, not a pull on the page', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'a finger drag on a phone');
  await staffPhone(page);
  await page.locator('#snav-burger').click();
  const nav = page.locator('#staff-tab-nav');
  await expect(nav).toBeVisible();
  expect(await nav.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(150); // the list is longer than its box
  await nav.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  expect(await nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(150);
  expect(await page.evaluate(`window.scrollY`)).toBeLessThanOrEqual(2); // the page itself is at its top

  expect(await drag(page, '#staff-tab-nav .tab-btn')).toBe(false); // the browser scrolls the list
  await page.waitForTimeout(300);
  expect(await page.evaluate(`window._ptrHits`)).toBe(0);                      // and nothing was refreshed
  await expect(nav).toBeVisible();
});

test('the same drag on the page itself is still a pull-to-refresh', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'a finger drag on a phone');
  await staffPhone(page);
  expect(await drag(page, '#tab-queue')).toBe(true);
  await expect.poll(() => page.evaluate(`window._ptrHits`)).toBeGreaterThan(0);
});

test('a box of its own scrolled down keeps the drag too, menu or not', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'a finger drag on a phone');
  await staffPhone(page);
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'ptr-box';
    box.style.height = '120px';
    box.style.overflowY = 'auto';
    const rows = document.createElement('div');
    rows.style.height = '600px';
    box.append(rows);
    document.getElementById('tab-queue')!.prepend(box);
    box.scrollTop = 200;
  });
  expect(await drag(page, '#ptr-box')).toBe(false);
  await page.waitForTimeout(300);
  expect(await page.evaluate(`window._ptrHits`)).toBe(0);
});
