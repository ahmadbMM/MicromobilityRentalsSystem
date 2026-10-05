import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Ratings as pictures to share (the owner, 2026-10-05): Analytics > All ratings has Share on every rating and
// Select for several; each rating becomes a 2160 px PNG with the whole rating on it ("everything in the rating
// literally") and the name staff choose each time (full name by default). Share hands the files to the share
// menu (WhatsApp is there); Save downloads them.

const T0 = Date.now();
const ago = (h: number) => new Date(T0 - h * 36e5).toISOString();
const day = (d: number) => new Date(T0 - d * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sessions = [
  { id: 's-sat', day: 'Saturday', session_date: day(2), capacity: 40, status: 'closed', created_at: 1, event_kind: 'community', ride_kind: 'saturday', title: 'Saturday Social Ride' },
  { id: 's-1', day: 'Friday', session_date: day(3), capacity: 12, status: 'closed', created_at: 2 },
];
const done = (id: string, sid: string, d: number, extra: Record<string, unknown>) => ({
  id, session_id: sid, session_day: 'Friday', session_date: day(d), queue_num: 1, phone: '', customer_id: 'c-' + id,
  status: 'done', paid: true, price: 30, registered_at: ago(d * 24 + 3), checked_in_at: ago(d * 24 + 2), checked_out_at: ago(d * 24), ...extra,
});
const queue_entries = [
  done('r1', 's-sat', 2, {
    name: 'Lina Haddad', rating_exp: 9, rating_bike: 8, rated_at: ago(1), feedback: 'Great morning, the route was beautiful',
    rating_detail: {
      form: 'social',
      s: { ride: 9, ride_checkin: 10, ride_staff: 9, ride_bike: 8, ride_route: 10, breakfast: 7, bf_restaurant: 9, bf_atmosphere: 9, bf_food: 6, bf_service: 8, overall: 9 },
      why: { ride_bike: 'Seat was loose', bf_food: 'Eggs were cold', bf_service: 'الطعام بارد' },
    },
  }),
  done('r2', 's-1', 3, {
    name: 'Omar Saleh', rating_exp: 7, rating_bike: 6, rated_at: ago(30), rating_tags: ['route', 'fun'], feedback: 'تجربة رائعة',
    rating_detail: { form: 'rental', s: { service: 9, bike: 6, experience: 7 }, why: { bike: 'Gears slipped' } },
  }),
];

async function boot(page: Page) {
  await stubSupabase(page, { sessions, queue_entries, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded&&getQueue().length===2`);
  // Every string the pictures draw, in order.
  await page.evaluate(`(() => { window.__drawn = []; const f = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (s, ...a) { window.__drawn.push(String(s)); return f.call(this, s, ...a); }; })()`);
  await page.evaluate(`setStaffTab('analytics');setAnView('ratings')`);
  await expect(page.locator('#tab-analytics .an-rate-card')).toHaveCount(2);
}
const drawn = (page: Page) => page.evaluate(`window.__drawn.slice()`) as Promise<string[]>;
const pictures = (page: Page, n: number) => expect(page.locator('#confirm-modal .rs-dlg .rs-prev img')).toHaveCount(n);

test.describe('@staff:analytics rating pictures', () => {
  test('every rating has Share; Select picks several and the bar counts them', async ({ page }) => {
    await boot(page);
    const tab = page.locator('#tab-analytics');
    await expect(tab.locator('.rs-one')).toHaveCount(2);
    await expect(tab.locator('.rs-pick').first()).toBeHidden();
    await tab.locator('.rs-idle').click();
    await expect(tab.locator('.rs-card')).toHaveClass(/rs-on/);
    await expect(tab.locator('.rs-go')).toBeDisabled();
    await tab.locator('.rs-pick').nth(0).click();
    await tab.locator('.rs-pick').nth(1).click();
    await expect(tab.locator('.rs-n')).toHaveText('2 selected');
    await expect(tab.locator('.an-rate-card.rs-sel')).toHaveCount(2);
    await tab.locator('.rs-pick').nth(1).click();
    await expect(tab.locator('.rs-n')).toHaveText('1 selected');
    await expect(tab.locator('.rs-go')).toBeEnabled();
    await tab.locator('.rs-act', { hasText: 'Cancel' }).click();
    await expect(tab.locator('.rs-pick').first()).toBeHidden();
    await expect(tab.locator('.an-rate-card.rs-sel')).toHaveCount(0);
  });

  test('a picture carries the whole rating, sharp, with the name chosen each time (full by default)', async ({ page }) => {
    await boot(page);
    await page.locator('#tab-analytics .an-rate-card').first().locator('.rs-one').click();
    const dlg = page.locator('#confirm-modal .rs-dlg');
    await expect(dlg.locator('.rs-names .filter-pill.active')).toHaveText('Full name');
    await pictures(page, 1);
    expect(await dlg.locator('.rs-prev img').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(2160);
    const all = (await drawn(page)).join(' | ');
    for (const s of ['Lina Haddad', 'Saturday Social Ride', 'CUSTOMER RATING', 'MicroMobility', 'micromobility.sa',
      'Seat was loose', 'Eggs were cold', 'الطعام بارد', 'Great morning, the route was beautiful', 'COMMENT',
      'Breakfast', 'Restaurant', 'Atmosphere', 'Food', 'Service', '6/10', '10/10']) expect(all).toContain(s);
    expect(all).not.toContain('Omar Saleh'); // one picture, one rating

    await page.evaluate(`window.__drawn = []`);
    await dlg.locator('.rs-names .filter-pill', { hasText: 'No name' }).click();
    await expect(dlg.locator('.rs-names .filter-pill.active')).toHaveText('No name');
    await pictures(page, 1);
    let names = await drawn(page);
    expect(names).toContain('A MicroMobility rider');
    expect(names.join(' ')).not.toContain('Lina');

    await page.evaluate(`window.__drawn = []`);
    await dlg.locator('.rs-names .filter-pill', { hasText: 'First name' }).click();
    await pictures(page, 1);
    names = await drawn(page);
    expect(names).toContain('Lina');
    expect(names.join(' ')).not.toContain('Haddad');
  });

  test('Share hands every picked rating to the share menu as a PNG; Save downloads them', async ({ page }) => {
    await page.addInitScript(() => {
      const n = navigator as Navigator & { canShare: (d?: unknown) => boolean };
      Object.defineProperty(n, 'canShare', { configurable: true, value: () => true });
      Object.defineProperty(n, 'share', { configurable: true, value: (d: { files: File[] }) => {
        (window as unknown as { __shared: string[] }).__shared = d.files.map((f) => `${f.name}|${f.type}|${f.size > 10000}`);
        return Promise.resolve();
      } });
    });
    await boot(page);
    const tab = page.locator('#tab-analytics');
    await tab.locator('.rs-idle').click();
    await tab.locator('.rs-pick').nth(0).click();
    await tab.locator('.rs-pick').nth(1).click();
    await tab.locator('.rs-go').click();
    const dlg = page.locator('#confirm-modal .rs-dlg');
    await expect(dlg.locator('.rs-sub')).toHaveText('One picture for each rating: 2');
    await pictures(page, 2);
    const all = (await drawn(page)).join(' | ');
    for (const s of ['Omar Saleh', 'Gears slipped', 'تجربة رائعة', 'Route', 'Fun']) expect(all).toContain(s);

    await dlg.locator('.rs-share').click();
    await page.waitForFunction(`Array.isArray(window.__shared)`);
    const shared = await page.evaluate(`window.__shared`) as string[];
    expect(shared).toHaveLength(2);
    // Newest rating first; each a real PNG, named after the day and the rider.
    expect(shared[0]).toMatch(new RegExp(`^MicroMobility-rating-${day(2)}-Lina-Haddad-1\\.png\\|image/png\\|true$`));
    expect(shared[1]).toMatch(new RegExp(`^MicroMobility-rating-${day(3)}-Omar-Saleh-2\\.png\\|image/png\\|true$`));

    const got: string[] = [];
    page.on('download', (d) => got.push(d.suggestedFilename()));
    await dlg.locator('.rs-save').click();
    await expect.poll(() => got.length).toBe(2);
    expect(got[0]).toMatch(/Lina-Haddad-1\.png$/);
  });
});
