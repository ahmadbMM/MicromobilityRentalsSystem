import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The account page in three parts (the owner, 2026-11-09: "divide the customer my account page into 3 separate pages
// account stats badges"; picked a switch at the top, Account first, the wallet and Invite friends on Account, and more
// stats). Each part has its address: /account, /account/stats, /account/badges. Stats gains rides by month, rides by
// bike, sessions by event and the badges earned. The clock is held on 15 June 2099 in Riyadh, so the twelve months
// run July 2098 to June 2099.

const NOW = new Date('2099-06-15T12:00:00+03:00');
const sess = (id: string, date: string, o: Record<string, unknown> = {}) => ({ id, day: 'Sunday', session_date: date, capacity: 20, status: 'closed', created_at: 1, location: 'JCC', bike_slots: '{"_time":"18:00 - 20:00","_total":20}', ...o });
const rated = { rating_exp: 9, rating_detail: { form: 'rental', s: { experience: 9 }, why: {} }, rated_at: '2099-01-01T10:00:00Z' }; // an unrated ride holds the rating page over the account
const bk = (id: string, sid: string, date: string, o: Record<string, unknown> = {}) => ({ id, session_id: sid, session_date: date, name: 'Spec Rider', customer_id: 'c1', session_day: 'Sunday', queue_num: 3, status: 'done', paid: true, price: 75, type_preference: 'Road', registered_at: '2099-01-01T10:00:00Z', ...rated, ...o });

const sessions = [
  sess('2099-06-05', '2099-06-05'), sess('2099-06-12', '2099-06-12'), sess('2099-04-03', '2099-04-03'), sess('2097-01-04', '2097-01-04'),
  sess('2099-03-07', '2099-03-07', { event_kind: 'community', ride_kind: 'saturday' }),
  sess('sw-1', '2099-05-10', { event_kind: 'community', ride_kind: 'swim', location: null }),
];
const rows = [
  bk('a', '2099-06-05', '2099-06-05', { type_preference: 'Hybrid' }),
  bk('b', '2099-06-12', '2099-06-12', { type_preference: 'Hybrid' }),
  bk('c', '2099-04-03', '2099-04-03'),
  bk('d', '2097-01-04', '2097-01-04'),
  bk('e', '2099-03-07', '2099-03-07'),
  bk('f', 'sw-1', '2099-05-10'),
];

async function open(page: Page, path = '/', lang = 'en') {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: rows, 'rpc:my_bookings': rows });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto(path + '?lang=' + lang);
  await waitForSb(page);
}
const at = (page: Page) => new URL(page.url()).pathname;
const part = (page: Page, k: string) => page.locator(`#tab-account [data-acc-view="${k}"]`);
const closePop = async (page: Page) => { const p = page.locator('#badge-pop'); if (await p.isVisible()) await p.getByRole('button', { name: 'Close' }).click(); };

test.describe('@customer:account the account page in three parts', () => {
  test('Account opens first, on its menu; Stats and Badges each have an address and Back walks them', async ({ page }) => {
    await open(page);
    await page.evaluate(`setCustTab('account')`);
    await closePop(page);
    await expect(page.locator('#tab-account .acc-view')).toHaveText(['Account', 'Stats', 'Badges']);
    await expect(part(page, 'account')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#acc-r-personal')).toBeVisible();
    await expect(page.locator('#acc-pane-stats')).toBeHidden();
    await expect(page.locator('#acc-pane-badges')).toBeHidden();
    expect(at(page)).toBe('/account');

    await part(page, 'stats').click();
    await expect(page.locator('#tab-account .mr-season')).toBeVisible();
    await expect(page.locator('#acc-r-personal')).toBeHidden();
    expect(at(page)).toBe('/account/stats');
    await part(page, 'badges').click();
    await expect(page.locator('#mr-badges-host')).toBeVisible();
    expect(at(page)).toBe('/account/badges');

    await page.goBack();
    await expect(page.locator('#tab-account .mr-season')).toBeVisible();
    expect(at(page)).toBe('/account/stats');
    await page.goBack();
    await expect(page.locator('#acc-r-personal')).toBeVisible();
    expect(at(page)).toBe('/account');

    // the tab bar's Account opens Account's menu, whichever part or page was open
    await part(page, 'badges').click();
    await page.evaluate(`setCustTab('account')`);
    await expect(part(page, 'account')).toHaveAttribute('aria-pressed', 'true');
    expect(at(page)).toBe('/account');
    await page.evaluate(`setCustTab('account','contact')`);
    await page.evaluate(`setCustTab('account')`);
    await expect(page.locator('#acc-r-personal')).toBeVisible();
    expect(at(page)).toBe('/account');
  });

  test('a page with typed edits keeps them while the rider stays on it, and the switch asks before leaving it', async ({ page, isMobile }) => {
    test.skip(isMobile, 'a phone hides the switch while a page is open');
    await open(page);
    await page.evaluate(`setCustTab('account','personal')`);
    await closePop(page);
    await page.locator('#acc-first').fill('Typed');
    await part(page, 'stats').click();
    await expect(page.locator('#confirm-modal')).toContainText('Discard your changes?');
    await page.locator('#confirm-modal').getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.locator('#acc-first')).toHaveValue('Typed');
    expect(at(page)).toBe('/account/personal');
  });

  test('a link to /account/badges opens Badges, and a reload stays there', async ({ page }) => {
    await open(page, '/account/badges');
    await closePop(page);
    await expect(page.locator('#mr-badges-host')).toBeVisible();
    await expect(part(page, 'badges')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#acc-first')).toBeHidden();
    expect(at(page)).toBe('/account/badges');
    await page.reload();
    await waitForSb(page);
    await closePop(page);
    await expect(page.locator('#mr-badges-host')).toBeVisible();
    expect(at(page)).toBe('/account/badges');
  });

  test('the wallet, Invite friends and the profile are on Account (its pages); the season on Stats; the badges on Badges', async ({ page }) => {
    await open(page);
    await page.evaluate(`setCustTab('account')`);
    const acct = page.locator('#acc-pane-account'), stats = page.locator('#acc-pane-stats'), badges = page.locator('#acc-pane-badges');
    await expect(acct.locator('#cw-mine')).toHaveCount(1);
    await expect(acct.locator('#ref-mine')).toHaveCount(1);
    await expect(acct.locator('#acc-first')).toHaveCount(1);
    await expect(stats.locator('.mr-season')).toHaveCount(1);
    await expect(stats.locator('.myr')).toHaveCount(1);
    await expect(stats.locator('#mr-badges-host')).toHaveCount(0);
    await expect(badges.locator('#mr-badges-host')).toHaveCount(1);
    await expect(badges.locator('.mr-season')).toHaveCount(0);
  });

  test('Stats: rides by month, rides by bike, sessions by event and the badges earned', async ({ page }) => {
    await open(page, '/account/stats');
    await closePop(page);
    const mo = page.locator('#acc-pane-stats .myr-mo');
    await expect(mo.locator('.myr-h')).toHaveText('Rides by month');
    await expect(mo.locator('li')).toHaveCount(12);
    await expect(mo.locator('li').last()).toHaveAttribute('title', 'June 2099: 2 rides');
    await expect(mo.locator('li').nth(9)).toHaveAttribute('title', 'April 2099: 1 ride');
    await expect(mo.locator('li').nth(10)).toHaveAttribute('title', 'May 2099: 0 rides'); // the pool session is not a ride
    await expect(mo.locator('.myr-mo-v')).toHaveText(['2']); // one value, on the highest month
    await expect(mo.locator('.myr-mo-b:not(.z)')).toHaveCount(3); // March, April, June; the 2097 ride is older than the chart
    await expect(mo.locator('.myr-mo-l')).toHaveText(['', '', 'Sept', '', '', 'Dec', '', '', 'Mar', '', '', 'Jun']);

    const lists = page.locator('#acc-pane-stats .myr-c:has(dl)');
    await expect(lists.locator('.myr-h')).toHaveText(['Rides by bike', 'By event']);
    await expect(lists.nth(0).locator('dt')).toHaveText(['Road', 'Hybrid']);
    await expect(lists.nth(0).locator('dd')).toHaveText(['3', '2']);
    await expect(lists.nth(1).locator('dt')).toHaveText(['Jeddah Corniche Circuit', 'Saturday Social Ride', 'Triathlon Pool Session']);
    await expect(lists.nth(1).locator('dd')).toHaveText(['4', '1', '1']);

    const bd = page.locator('#acc-pane-stats .myr-bd');
    await expect(bd.locator('.myr-bd-t')).toHaveText('Badges earned');
    await expect(bd.locator('.myr-bd-n')).toHaveText(/^\d+\/\d+$/);
    await bd.click();
    await expect(page.locator('#mr-badges-host')).toBeVisible();
    expect(at(page)).toBe('/account/badges');
  });

  test('no rides: Stats shows the season and nothing of the new lists', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: [] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/account/stats?lang=en');
    await waitForSb(page);
    await expect(page.locator('#acc-pane-stats .mr-season')).toBeVisible();
    await expect(page.locator('#acc-pane-stats .myr-mo')).toHaveCount(0);
    await expect(page.locator('#acc-pane-stats .myr-c:has(dl)')).toHaveCount(0);
  });

  for (const lang of ['ar', 'ne', 'tl']) {
    test(`the switch fits a phone in ${lang}`, async ({ page }) => {
      await page.setViewportSize({ width: 360, height: 800 });
      await open(page, '/account', lang);
      await closePop(page);
      const bar = page.locator('#tab-account .acc-views');
      await expect(bar).toBeVisible();
      const over = await bar.evaluate((b) => {
        const r = b.getBoundingClientRect();
        return r.right > document.documentElement.clientWidth + 0.5 || r.left < -0.5 || [...b.querySelectorAll('button')].some((x) => x.scrollWidth > x.clientWidth + 1);
      });
      expect(over).toBe(false);
    });
  }
});
