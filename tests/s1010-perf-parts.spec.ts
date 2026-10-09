import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, staffReady, waitForSb } from './helpers/supabase';

// The 2026-10-09 performance round (P5-P7 of the staff deep research): a staff device fetches only the
// staff parts its account can open, a part brings its own strings (English inside it, the other languages
// in lang/staff-<part>-<code>.json), and a staff device's <head> links styles.css alone.

const DAY = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }); // tomorrow: a live ride
const fixtures = () => ({
  sessions: [{ id: DAY, session_date: DAY, day: 'Saturday', status: 'open', capacity: 20, created_at: 1 }],
  queue_entries: [],
});

async function boot(page: Page, init: Record<string, string>, asked: string[]) {
  await stubSupabase(page, fixtures());
  await page.addInitScript((kv) => {
    (window as unknown as { __staffPartsNow?: boolean }).__staffPartsNow = false; // the way a real device gets them
    localStorage.setItem('cq_staff', '1');
    localStorage.setItem('cq_op_name', 'Spec Staff');
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, init);
  page.on('request', (r) => asked.push(new URL(r.url()).pathname));
  await page.goto('/bookings');
  await staffReady(page);
  await waitForSb(page);
}
const part = (asked: string[], n: string) => asked.some((p) => p === `/staff-parts/${n}.js`);

test.describe('@staff:perf staff parts by role (2026-10-09)', () => {
  test('a front-desk account fetches the desk\'s parts after the first paint, and not Analytics, the website or Vendors', async ({ page }) => {
    const asked: string[] = [];
    await boot(page, { cq_role: 'frontdesk' }, asked);
    // the desk's own sections: the till (cashier), the workshop, the bikes, the fleet check after a return, the money dialogs
    await expect.poll(() => ['cashier', 'workshop', 'fleet', 'money', 'settings'].every((n) => part(asked, n)), { timeout: 10000 }).toBe(true);
    await page.waitForTimeout(500);
    for (const n of ['analytics', 'website', 'vendors', 'community', 'catalog', 'ambassadors', 'messages', 'team', 'history', 'sela', 'imports']) {
      expect(part(asked, n), `${n} was fetched`).toBe(false);
    }
    // A part no section of this account opens still comes when something asks for it (its stand-in).
    await page.evaluate(`_loadStaffPart('analytics')`);
    expect(part(asked, 'analytics')).toBe(true);
    expect(await page.evaluate(`typeof renderAnalytics==='function'&&!/_loadStaffPart/.test(String(renderAnalytics))`)).toBe(true);
  });

  test('an admin\'s device fetches every section\'s part, but not the two only an action reaches', async ({ page }) => {
    const asked: string[] = [];
    await boot(page, { cq_role: 'admin' }, asked);
    await expect.poll(() => ['analytics', 'community', 'website', 'vendors', 'team', 'history'].every((n) => part(asked, n)), { timeout: 10000 }).toBe(true);
    expect(part(asked, 'sela')).toBe(false);
    expect(part(asked, 'imports')).toBe(false);
  });

  test('a part\'s strings come with it: Arabic from its own pack, English from inside the part', async ({ page }) => {
    const asked: string[] = [];
    await boot(page, { cq_role: 'frontdesk', cq_lang: 'ar', cq_lang_pick: '1' }, asked);
    // anRevCollected is said by Analytics alone: not in the desk's core, in English or in Arabic
    expect(await page.evaluate(`typeof LANG.en.anRevCollected`)).toBe('undefined');
    expect(await page.evaluate(`t('anRevCollected')`)).toBe('anRevCollected');
    await page.evaluate(`_loadStaffPart('analytics')`);
    expect(asked.some((p) => p === '/lang/staff-analytics-ar.json')).toBe(true);
    expect(await page.evaluate(`t('anRevCollected')`)).toBe('الإيرادات المحصلة');
    expect(await page.evaluate(`LANG.en.anRevCollected`)).toBe('Revenue Collected');
    // a language chosen afterwards brings the strings of the parts already here
    await page.evaluate(`loadLangPack('fr')`);
    expect(asked.some((p) => p === '/lang/staff-analytics-fr.json')).toBe(true);
  });

  test('a staff device links styles.css alone; a customer\'s page links app.css', async ({ page }) => {
    const asked: string[] = [];
    await boot(page, { cq_role: 'admin' }, asked);
    expect(await page.locator('link[rel="stylesheet"][data-staff-css]').count()).toBe(1);
    expect(asked.some((p) => p === '/app.css')).toBe(false);
    expect(asked.filter((p) => p === '/styles.css').length).toBe(1);

    const p2 = await page.context().newPage();
    const cust: string[] = [];
    await stubSupabase(p2, fixtures());
    p2.on('request', (r) => cust.push(new URL(r.url()).pathname));
    await p2.addInitScript(() => localStorage.removeItem('cq_staff'));
    await p2.goto('/');
    await waitForSb(p2);
    expect(cust.includes('/app.css')).toBe(true);
    expect(cust.includes('/styles.css')).toBe(false);
  });
});
