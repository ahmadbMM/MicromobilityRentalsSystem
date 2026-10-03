import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Analytics > Ratings: the quick tags older ratings carry (2026-09-28; the rider's page no longer asks
// for them since the detailed rating, 2026-10-03), the detailed rating's questions and reasons, a table
// by ride night, and a low rating from the last week ringing the bell.
// One clock reading for every fixture: r1 and r2 end at the same moment, and two readings a millisecond
// apart ordered them by that millisecond (the newest-first list then flipped them now and then).
const T0 = Date.now();
const ago = (d: number) => new Date(T0 - d * 864e5).toISOString();
const day = (d: number) => new Date(Date.now() - d * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const done = (id: string, d: number, extra: Record<string, unknown>) => ({
  id, session_id: 's-' + d, session_day: 'Friday', session_date: day(d), queue_num: 1, name: 'Rider ' + id, phone: '', customer_id: 'c1',
  status: 'done', paid: true, price: 30, registered_at: ago(d + 1), checked_in_at: ago(d), checked_out_at: ago(d), ...extra,
});
const queue = [
  done('r1', 2, { rating_exp: 9, rating_bike: 8, rating_tags: ['route', 'fun'], feedback: 'Great night' }),
  done('r2', 2, { rating_exp: 3, rating_bike: 7, rating_tags: ['pace'] }),
  done('r3', 20, { rating_exp: 2, rating_bike: 2, rating_tags: ['bike'] }),
  done('r4', 1, {}), // completed, not rated yet
  done('r5', 1, { rating_exp: 10, rating_bike: 6, rating_detail: { form: 'rental', s: { service: 9, bike: 6, experience: 10 }, why: { bike: 'Gears slipped' } } }),
];
const sessions = [2, 20, 1].map((d) => ({ id: 's-' + d, day: 'Friday', session_date: day(d), capacity: 12, status: 'closed', created_at: 1 }));

test('a detailed rating (rating_detail) shows each question, its reason, and the averages by question', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: queue, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('analytics');setAnView('ratings')`);
  const tab = page.locator('#tab-analytics');
  const card = tab.locator('.an-rgcat-card');
  await expect(card).toBeVisible();
  await expect(card.locator('.analytics-bar-row')).toHaveCount(3); // service, bike, experience of r5
  await expect(card.locator('.analytics-bar-row[data-k="bike"]')).toContainText('1 at 8 or under');
  await expect(tab.locator('.an-rg-why')).toHaveText('Gears slipped');
});

test('every rating lists the time it was given, the most recent first; an older one shows its ride end, marked', async ({ page }) => {
  const q = [...queue, done('r6', 30, { rating_exp: 7, rated_at: ago(0.01) })]; // the oldest ride, rated a few minutes ago
  await stubSupabase(page, { sessions: [...sessions, { id: 's-30', day: 'Friday', session_date: day(30), capacity: 12, status: 'closed', created_at: 1 }], queue_entries: q, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('analytics');setAnView('ratings')`);
  const cards = page.locator('#tab-analytics .an-rate-card');
  await expect(cards.first()).toContainText('Rider r6'); // rated last, so first, though its ride is the oldest
  await expect(cards.first().locator('.an-rate-when')).toHaveText(/^Rated /);
  await expect(cards.first().locator('.an-rate-approx')).toHaveCount(0);
  await expect(cards.nth(1).locator('.an-rate-when.an-rate-approx')).toContainText('rating time not recorded');
  const names = await cards.locator('.an-name13').allTextContents();
  expect(names.slice(1)).toEqual(['Rider r5', 'Rider r1', 'Rider r2', 'Rider r3']); // the rest by their ride's end, newest first
});

test.describe('staff', () => {
  async function boot(page: Page) {
    await stubSupabase(page, { sessions, queue_entries: queue, bikes: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
  }
  test('Analytics has a Ratings view with the tag breakdown, the table by ride and each rating\'s tags', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('analytics');setAnView('ratings')`);
    const tab = page.locator('#tab-analytics');
    await expect(tab.locator('.an-nav-btn.active')).toHaveText('Ratings');
    const tags = tab.locator('.an-tags-card');
    await expect(tags).toBeVisible();
    await expect(tags.locator('.analytics-bar-row')).toHaveCount(4); // route, fun, pace, bike
    await expect(tags.locator('.analytics-bar-row').first()).toContainText(/Route|Fun|Pace|Bike/);
    const by = tab.locator('.an-bysess-card');
    await expect(by).toBeVisible();
    await expect(by.locator('tbody tr')).toHaveCount(3); // the three nights with a rating
    await expect(by.locator(`tbody tr[data-day="${day(2)}"]`)).toContainText('2/2'); // both riders of that night rated
    await expect(by.locator(`tbody tr[data-day="${day(2)}"]`)).toContainText('▼1'); // one low score that night
    await expect(tab.locator('.an-rate-tags').first()).toBeVisible();
    // the overview no longer carries the ratings block; the Ratings view does
    await page.evaluate(`setAnView('overview')`);
    await expect(tags).toBeHidden();
  });

  test('a low rating from the last week rings the bell and leads to Ratings; an old one does not', async ({ page }) => {
    await boot(page);
    const kinds = await page.evaluate(`_ntKinds().filter(k=>k.k==='lowrate').map(k=>k.ids)`) as string[][];
    expect(kinds).toEqual([['r2']]); // r3's low score is three weeks old
    await page.evaluate(`_on_goRatings()`);
    expect(await page.evaluate(`S.staffTab+'/'+S.anView`)).toBe('analytics/ratings');
  });
});
