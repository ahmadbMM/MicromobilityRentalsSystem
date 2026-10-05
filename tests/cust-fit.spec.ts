import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The rider screens fit the phone (the owner, 2026-10-02: "the screens and pop ups in the customers website
// are sometimes zoomed in or needs to be scrolled right or left ... align all buttons and make them have the
// same size"): nothing is wider than a 320px screen, no text field is under 16px (iOS zooms into those when
// they are tapped), and the buttons a rider presses are one height. A long name and email are on purpose.
const day = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const T = day(2), P = day(-3); // P's finished ride is rated: an unrated one from RATE_FROM (2026-10-03) on opens the rating gate over the page
const NAME = 'Abdulrahman Mohammed Alqahtani Alshehri';
const sessions = [
  { id: T, day: 'Friday', session_date: T, capacity: 12, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 12 }) },
  { id: P, day: 'Monday', session_date: P, capacity: 12, status: 'closed', created_at: 1, bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 12 }) }];
const row = (id: string, sid: string, x: Record<string, unknown> = {}) => ({ id, session_id: sid, session_day: 'Friday', session_date: sid, queue_num: 3, name: NAME, phone: '0500000001', type_preference: 'Road', size: 'M', height: 175, status: 'waiting', paid: false, price: 115, registered_at: '2026-09-01T10:00:00Z', customer_id: 'c1', ...x });

async function fits(page: Page, where: string) {
  const r = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const vis = (e: Element) => { const s = getComputedStyle(e), b = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0; };
    const small = [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea')].filter(vis).filter((e) => parseFloat(getComputedStyle(e).fontSize) < 16).map((e) => e.id || e.tagName);
    const btn = [...document.querySelectorAll('.btn-primary,.btn-secondary,.btn-sm')].filter(vis).filter((e) => !e.closest('.cust-bnav,#topbar')).map((e) => Math.round(e.getBoundingClientRect().height));
    return { wide: document.documentElement.scrollWidth - W, small, short: btn.filter((h) => h < 48) };
  });
  expect(r.wide, `${where}: wider than the screen`).toBeLessThanOrEqual(1);
  expect(r.small, `${where}: text fields under 16px`).toEqual([]);
  expect(r.short, `${where}: buttons under 48px`).toEqual([]);
}

for (const lang of ['en', 'ar']) test(`the rider screens fit a 320px phone (${lang})`, async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'a phone');
  await page.setViewportSize({ width: 320, height: 760 });
  await page.addInitScript((l) => { localStorage.setItem('cq_lang', l); localStorage.setItem('cq_lang_pick', '1'); }, lang);
  await stubSupabase(page, { sessions, bikes: [], queue_entries: [] });
  await page.goto('/'); await waitForSb(page); await fits(page, 'sign in');
  await page.goto('/signup'); await waitForSb(page); await fits(page, 'sign up');
  await loginCustomer(page, { id: 'c1', name: NAME, email: 'abdulrahman.mohammed.alqahtani@privaterelay.appleid.com', height: 175, type_preference: 'Road' });
  await stubSupabase(page, { sessions, bikes: [], queue_entries: [row('b1', T), row('b3', P, { status: 'done', paid: true, rating_detail: { form: 'rental', s: { service: 10, bike: 10, experience: 10 } } })] });
  await page.goto('/'); await waitForSb(page);
  await page.evaluate(`S.selEvent='jcc';S.selSession=null;S.regStep=1;setCustTab('register')`); await fits(page, 'rides');
  await page.evaluate(`S.selSession='${T}';S.regStep=2;S.regBikeHeights=['175'];renderRegister()`); await fits(page, 'riders');
  await page.evaluate(`setCustTab('myrides')`); await page.waitForTimeout(300); await fits(page, 'my bookings');
  await page.locator('#tab-myrides .cu-tk-actions .btn-red').first().click(); await page.waitForTimeout(300); await fits(page, 'cancel');
  await page.evaluate(`closeCancelReasonModal();setCustTab('account')`); await page.waitForTimeout(300); await fits(page, 'account');
});
