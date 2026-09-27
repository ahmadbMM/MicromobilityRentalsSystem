import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Quick tags on the post-ride rating (2026-09-28): a rider taps what stood out beside the two
// scores, the tags travel with the rating (customer_booking_update rating_tags), and staff read them
// in Analytics > Ratings - a tag breakdown, a table by ride night, each rating's tags - while a low
// rating from the last week rings the bell.
const ago = (d: number) => new Date(Date.now() - d * 864e5).toISOString();
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
];
const sessions = [2, 20, 1].map((d) => ({ id: 's-' + d, day: 'Friday', session_date: day(d), capacity: 12, status: 'closed', created_at: 1 }));

test('a rider adds tags to a rating, and they travel with the scores', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: queue, bikes: [], 'rpc:customer_booking_update': true, 'rpc:my_bookings': queue });
  await loginCustomer(page, { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.url().includes('/rest/v1/rpc/customer_booking_update')) { try { calls.push(r.postDataJSON()); } catch { /* */ } } });
  await page.evaluate(`S._rateSnoozed=new Set();openRateModal('r4')`);
  const m = page.locator('#rate-modal');
  await expect(m.locator('.rate-tag')).toHaveCount(6);
  await m.locator('.rate-tag[data-tag="route"]').click();
  await m.locator('.rate-tag[data-tag="pace"]').click();
  await expect(m.locator('.rate-tag.active')).toHaveCount(2);
  await m.locator('.rate-tag[data-tag="pace"]').click(); // and off again
  await m.locator('.rate-tag[data-tag="staff"]').click();
  await page.evaluate(`setRate('exp',8)`);
  await m.locator('button', { hasText: 'Submit rating' }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect((calls[0] as { p_patch: Record<string, unknown> }).p_patch).toMatchObject({ rating_exp: 8, rating_tags: ['route', 'staff'] });
  await expect(m.locator('.rate-tag')).toHaveCount(0); // the modal closed on the thanks
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
    await expect(by.locator('tbody tr')).toHaveCount(2); // the two nights with a rating
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
