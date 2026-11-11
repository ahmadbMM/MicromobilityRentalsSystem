import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, staffReady } from './helpers/supabase';

// The simple phone view (the user, 2026-11-08: "add a new view of the staff page on phone screens that simplifies the
// page so much for it to be used on the phone, make it as a switch in the settings and make the default the full look
// not the simplified one ... remove a lot of buttons"). Settings > This device > Simple view on a phone, kept on the
// device (cq_phone_simple -> html[data-staff-simple]); it applies at the roster's phone width (767px) only.

const NOW = Date.parse('2026-09-24T17:30:00Z'); // Thursday 24 September 2026, 20:30 in Riyadh
const TODAY = '2026-09-24';
const sessions = [{ id: TODAY, day: 'Thursday', session_date: TODAY, capacity: 40, status: 'open', location: 'JCC', bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 40 }), created_at: 1 }];
const q = (id: string, n: number, o: Record<string, unknown> = {}) => ({
  id, session_id: TODAY, session_day: 'Thursday', session_date: TODAY, queue_num: n, name: 'Rider ' + n, status: 'waiting', paid: false,
  price: 80, type_preference: 'Hybrid', size: 'M', height: 172, phone: '05500000' + String(n).padStart(2, '0'), registered_at: '2026-09-15T10:00:00Z', ...o,
});
const queue_entries = [
  q('w1', 1, { name: 'Wafa Waiting', addons: JSON.stringify([{ id: 'i1', qty: 2 }]) }),
  q('w2', 2, { name: 'Walid Paid', paid: true }),
  q('a1', 3, { name: 'Adel Onbike', status: 'active', paid: true, checked_in_at: '2026-09-24T17:00:00Z' }),
];
const inventory = [{ id: 'i1', name: 'Water', category: 'Drinks', qty: 30, price: 5, addon: true }];

// The bar at the thumb is what a phone shows of the staff shell in both views (the burger goes in the simple one).
const phoneReady = (page: Page) => page.locator('#staff-tabbar').filter({ visible: true }).first().waitFor();

async function open(page: Page, o: { width?: number; simple?: boolean } = {}) {
  await page.setViewportSize({ width: o.width || 390, height: 844 });
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions, queue_entries, inventory });
  await unlockStaff(page);
  if (o.simple) await page.addInitScript(() => localStorage.setItem('cq_phone_simple', '1'));
  await page.goto('/');
  await waitForSb(page);
  if ((o.width || 390) < 768) await phoneReady(page);
  else await staffReady(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${TODAY}';S._sfPicked=true;S.sfStatus='all';renderStaffQueue()`);
  await expect(page.locator('#q-results [data-id="w1"]').first()).toBeVisible();
}
const card = (page: Page, id: string) => page.locator(`#q-results .q-card[data-id="${id}"], #q-results [data-id="${id}"].q-card`).first();
const tabbar = (page: Page) => page.locator('#staff-tabbar .tb-btn[data-tb]').evaluateAll((l) => l.map((b) => (b as HTMLElement).dataset.tb));
const menu = (page: Page) => page.locator('#staff-tab-nav .tab-btn').evaluateAll((l) => l.filter((b) => (b as HTMLElement).style.display !== 'none').map((b) => (b as HTMLElement).dataset.stab));

test.describe('@staff:settings simple phone view', () => {
  test('the full look is the default: the switch is off in Settings > This device and a phone keeps every tool', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'a phone');
    await open(page);
    expect(await page.evaluate(`document.documentElement.hasAttribute('data-staff-simple')`)).toBe(false);
    await expect(page.locator('#snav-burger')).toBeVisible();
    await expect(page.locator('#tab-queue .rq-hacts')).toBeVisible();
    await expect(page.locator('#tab-queue .f-show')).toBeVisible(); // the Filters button (its panel is closed until opened)
    await expect(card(page, 'w2').locator('.rq-cadbtn')).toBeVisible();
    expect(await menu(page)).toContain('analytics');
    await page.evaluate(`setStaffTab('settings')`);
    const sw = page.locator('#tab-settings #set-simple');
    await expect(sw).not.toBeChecked();
    // it is This device's first switch, named for what it does
    await expect(page.locator('section[aria-labelledby="set-h-dev"] .set-togs .set-tog').first()).toContainText('Simple view on a phone');
  });

  test('ticking the switch simplifies the phone at once; the menu foot puts the full look back', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'a phone');
    await open(page);
    await page.evaluate(`setStaffTab('settings')`);
    await page.locator('#tab-settings #set-simple').check();
    expect(await page.evaluate(`localStorage.getItem('cq_phone_simple')`)).toBe('1');
    expect(await page.evaluate(`document.documentElement.hasAttribute('data-staff-simple')`)).toBe(true);
    await expect(page.locator('#tab-settings #set-simple')).toBeChecked();
    await expect(page.locator('#tab-settings .set-views')).toBeHidden(); // Business and Pricing are the office's
    // the bar and the menu keep the night's sections, and the menu ends with the way back
    expect(await tabbar(page)).toEqual(['queue', 'sessions', 'community', 'cashier']);
    await page.locator('#staff-tabbar .tb-more').click();
    expect(await menu(page)).toEqual(['queue', 'sessions', 'volunteers', 'workshop', 'cashier', 'community', 'settings']); // the rail's groups since staff round s10 (D7): Today, Fleet, Money, People, Admin
    await expect(page.locator('#snav-full')).toHaveText('Show the full view');
    await page.locator('#snav-full').click();
    expect(await page.evaluate(`localStorage.getItem('cq_phone_simple')`)).toBeNull();
    expect(await page.evaluate(`document.documentElement.hasAttribute('data-staff-simple')`)).toBe(false);
    await expect(page.locator('#snav-full')).toBeHidden();
    await expect(page.locator('#snav-burger')).toBeVisible();
    expect(await menu(page)).toContain('analytics');
  });

  test('Bookings on the simple phone: the session, the figures, search and one action per rider; no office tools', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'a phone');
    await open(page, { simple: true });
    // the head script set the view before the first paint
    expect(await page.evaluate(`document.documentElement.hasAttribute('data-staff-simple')`)).toBe(true);
    for (const sel of ['#snav-burger', '#topbar .lang-wrap', '#tab-queue .rq-hacts', '#tab-queue .q-views > .filter-pill', '#tab-queue .f-show', '#tab-queue #fm-q', '#tab-queue .sv-bar', '#tab-queue .stat-strip'])
      await expect(page.locator(sel).first(), sel).toBeHidden();
    // kept: the ride's picker, the figures bar (its numbers filter), search, the leader's location, the scan and walk-in buttons
    for (const sel of ['#tab-queue .rq-sesssel', '#q-live-count .q-lc-nums', '#tab-queue .search-wrap', '#tab-queue .live-share', '.fab-row .scan-fab', '.fab-row .walkin-fab', '#topbar .gs-btn', '#topbar .op-chip'])
      await expect(page.locator(sel).first(), sel).toBeVisible();
    // a card: no select box or booked-at line, its one action and ⋯; add-ons listed only where there are some, none added here
    await expect(card(page, 'w1').locator('.rq-cchk')).toBeHidden();
    await expect(card(page, 'w1').locator('.q-booked-at')).toBeHidden();
    await expect(card(page, 'w1').locator('.rq-act')).toHaveText('Check in');
    await expect(card(page, 'w1').locator('.rq-more')).toBeVisible();
    await expect(card(page, 'w1').locator('.rq-cadi')).toContainText('Water');
    await expect(card(page, 'w1').locator('.rq-cadbtn')).toHaveCount(0);
    await expect(card(page, 'w2').locator('.rq-cad')).toHaveCount(0);
    await expect(card(page, 'a1').locator('.rq-act')).toHaveText('Return bike');
    // the figures filter the list
    await page.locator('#q-live-count .q-lc-active').click();
    await expect(card(page, 'w1')).toHaveCount(0);
    await expect(card(page, 'a1')).toBeVisible();
    // the waitlist view has no pill here: the roster shows instead
    await page.evaluate(`S.queueView='managed';renderStaffQueue()`);
    expect(await page.evaluate(`S.queueView`)).toBe('bookings');
  });

  test('the other sections on the simple phone: People is its find box, Sessions its cards, a session its essentials', async ({ page }) => {
    test.skip(test.info().project.name !== 'mobile', 'a phone');
    await open(page, { simple: true });
    await page.evaluate(`S.communityTab='accounts';setStaffTab('community')`);
    await expect(page.locator('#tab-community #ppl-q')).toBeVisible();
    await expect(page.locator('#tab-community .cmy-nav')).toHaveCount(0);
    await expect(page.locator('#tab-community .dash-kpis')).toHaveCount(0);
    expect(await page.evaluate(`S.communityTab`)).toBe('accounts'); // the full view keeps its own view
    await page.evaluate(`S.sessView='table';setStaffTab('sessions')`);
    await expect(page.locator('#tab-sessions .sess-list-pane')).toBeVisible();
    await expect(page.locator('#tab-sessions .ss-head-btns')).toBeHidden();
    await expect(page.locator('#tab-sessions .ss-figs')).toBeHidden();
    await page.evaluate(`selectSessionDetail('${TODAY}')`);
    const acts = page.locator('#tab-sessions .sess-detail-actions button');
    expect(await acts.allTextContents()).toEqual(['Mark full', 'Close']);
    expect(await page.locator('#tab-sessions .ss-links button').allTextContents()).toEqual(['Open in Bookings']);
    await expect(page.locator('#tab-sessions .n6r-box')).toHaveCount(0);
  });

  test('a desk-sized screen keeps the full look with the switch on', async ({ page }) => {
    test.skip(test.info().project.name === 'mobile', 'a laptop');
    await open(page, { width: 1280, simple: true });
    expect(await page.evaluate(`_simpleOn()`)).toBe(false);
    await expect(page.locator('#tab-queue .rq-hacts')).toBeVisible();
    await expect(page.locator('#snav-full')).toBeHidden();
    expect(await menu(page)).toContain('analytics');
    // narrowed to a phone, the simple view comes
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#tab-queue .rq-hacts')).toBeHidden();
    await expect.poll(() => menu(page)).not.toContain('analytics');
  });
});
