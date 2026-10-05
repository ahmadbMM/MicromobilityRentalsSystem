import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The page in the language on screen (2026-10-05 review, slice ra1):
// - a staff device whose staff strings do not arrive asks again later, instead of fetching and
//   redrawing in a loop (loadLangPack said they had arrived when they had not);
// - the tab's title, the description and the accessible names the markup is written with follow
//   the language;
// - places left are counted with the language's own plural forms (Arabic's dual).

/** The built packs are the expected values: a word written here would be a second, staler copy. */
const pack = (code: string) => JSON.parse(readFileSync(resolve(__dirname, `../lang/${code}.json`), 'utf8')) as Record<string, string>;
const AR = pack('ar');

test.describe('@i18n fix5 ra1 language packs', () => {
  test('a staff device whose staff strings fail asks again later, not in a loop', async ({ page }) => {
    await stubSupabase(page, { sessions: [] });
    await unlockStaff(page);
    const staffAsks: string[] = [], packAsks: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (/\/lang\/staff-ar\.json/.test(u)) staffAsks.push(u);
      else if (/\/lang\/ar\.json/.test(u)) packAsks.push(u);
    });
    await page.route(/\/lang\/staff-ar\.json/, (r) => r.fulfill({ status: 503, body: '' }));
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setLang('ar')`);
    await page.waitForTimeout(2500);
    expect(staffAsks.length).toBeLessThanOrEqual(3); // was hundreds: every answer started the next ask
    expect(packAsks.length).toBe(1);
    expect(await page.evaluate(`t('tabReserve')`)).toBe(AR.tabReserve); // the rider strings arrived and are drawn
    // once the file answers again, a later ask brings the staff strings in
    await page.unroute(/\/lang\/staff-ar\.json/);
    await expect.poll(() => page.evaluate(`_langLoaded('ar')`), { timeout: 12000 }).toBe(true);
  });
});

test.describe('@i18n fix5 ra1 page names', () => {
  test('the title, the description and the markup’s accessible names follow the language', async ({ page }) => {
    await stubSupabase(page, { sessions: [] });
    await page.goto('/?lang=ar');
    await waitForSb(page);
    await expect.poll(() => page.evaluate(`_langLoaded('ar')`)).toBe(true);
    expect(AR.pageTitle).toBeTruthy();
    await expect(page).toHaveTitle(AR.pageTitle);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', AR.pageDesc);
    await expect(page.locator('#topbar .topbar-logo')).toHaveAttribute('aria-label', AR.a11yHome);
    await expect(page.locator('#customer-tab-nav')).toHaveAttribute('aria-label', AR.a11yCustSections);
    await expect(page.locator('#cust-bottom-nav')).toHaveAttribute('aria-label', AR.a11yCustNav);
    await expect(page.locator('#staff-tab-nav')).toHaveAttribute('aria-label', AR.a11yStaffSections);
    await expect(page.locator('.landing-hero-card')).toHaveAttribute('aria-label', AR.evJccName);
    await expect(page.locator('.landing-hero-card img')).toHaveAttribute('alt', AR.evJccName);
    await expect(page.locator('.mf-social a[title="Instagram"]')).toHaveAttribute('aria-label', 'Instagram' + AR.opensNewTab);
    // and back to English, as the markup was written
    await page.evaluate(`setLang('en')`);
    await expect(page).toHaveTitle('MicroMobility Experiences');
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'Book your bike, join a community ride, and skip the queue. Pick a location and a session in a few taps.');
    await expect(page.locator('#customer-tab-nav')).toHaveAttribute('aria-label', 'Customer sections');
    await expect(page.locator('.mf-social a[title="X"]')).toHaveAttribute('aria-label', 'X (opens in a new tab)');
  });

  test('the shared page names its own address', async () => {
    const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
    expect(html).toMatch(/<meta property="og:url" content="https:\/\/[^"]+\/">/);
  });
});

test.describe('@i18n fix5 ra1 plural forms', () => {
  test('places left are counted with the language’s own forms', async ({ page }) => {
    await stubSupabase(page, { sessions: [] });
    await page.goto('/?lang=ar');
    await waitForSb(page);
    await expect.poll(() => page.evaluate(`_langLoaded('ar')`)).toBe(true);
    expect(AR.spotsLeft_two).toBeTruthy();
    expect(await page.evaluate(`spotsLeftLabel(2)`)).toBe(AR.spotsLeft_two); // the dual, not "2 مقاعد"
    expect(await page.evaluate(`spotsLeftLabel(5)`)).toBe(AR.spotsLeft_few.replace('{0}', '5'));
    expect(await page.evaluate(`spotsLeftLabel(11)`)).toBe(AR.spotsLeft_many.replace('{0}', '11'));
    expect(await page.evaluate(`spotsLeftLabel(0)`)).toBe(AR.spotsFull);
    await page.evaluate(`setLang('en')`);
    expect(await page.evaluate(`[spotsLeftLabel(1), spotsLeftLabel(2), spotsLeftLabel(12)]`)).toEqual(['1 spot left', '2 spots left', '12 spots left']);
  });

  test('the riders chart names its line by the colour it is drawn in', async ({ page }) => {
    await stubSupabase(page, { sessions: [] });
    await unlockStaff(page); // an Analytics string: it ships with the staff half
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate(`t('anChartRidersSub')`)).toMatch(/^Green = riders/);
  });
});
