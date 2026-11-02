import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Bookings in the order Apple Wallet keeps passes (the owner, 2026-10-31: "find an organised way to organize and
// sort the bookings in my bookings page, make the past bookings be sorted the same way apple pass sorts bookings and
// cards"): the rides ahead soonest first, two on one day by their start; the rides done as Wallet's stack, the latest
// on top, each showing its top strip (mark and date) until it is tapped, one out at a time.

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const off = (n: number) => { const [y, m, d] = today.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const jcc = (id: string, date: string, o: Record<string, unknown> = {}) => ({ id, day: 'Sunday', session_date: date, capacity: 20, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...o });
const sat = (id: string, date: string) => jcc(id, date, { day: 'Saturday', event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, spots: 25, paid_ride: false, title: 'Dawn Ride', bike_slots: '{"_time":"06:00 - 06:30"}' });
let n = 0;
const bk = (sid: string, date: string, o: Record<string, unknown> = {}) => ({ id: 'b' + (++n), name: 'Spec Rider', customer_id: 'c1', session_id: sid, session_day: 'Sunday', session_date: date, queue_num: n, status: 'done', paid: true, price: 75, type_preference: 'Road', registered_at: '2026-01-01T10:00:00Z', rating_detail: { form: 'rental', s: { service: 10, bike: 10, experience: 10 } }, ...o });

async function open(page: Page, sessions: unknown[], queue: unknown[], lang = 'en') {
  await page.addInitScript((l) => { localStorage.setItem('cq_lang', l); localStorage.setItem('cq_lang_pick', '1'); }, lang);
  await stubSupabase(page, { bikes: [], sessions, queue_entries: queue, 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`goCustomer('myrides')`);
}

const PAST = [jcc('p2', off(-2)), sat('p9', off(-9)), jcc('p40', off(-40)), jcc('p20', off(-20))];
const PASTQ = () => [bk('p40', off(-40)), bk('p2', off(-2)), bk('p20', off(-20)), bk('p9', off(-9), { price: 0, approval: 'approved' })];

test('past rides stack the latest first, each its strip, and one comes out whole at a time', async ({ page }) => {
  await open(page, [jcc('u5', off(5)), ...PAST], [bk('u5', off(5), { status: 'waiting', paid: false }), ...PASTQ()]);
  const stack = page.locator('#mr-past');
  await expect(stack.locator('.wl-card')).toHaveCount(4);
  expect(await stack.locator(':scope > .ticket-card').evaluateAll((els) => els.map((e) => e.id))).toEqual(['wl-p2', 'wl-p9', 'wl-p20', 'wl-p40']);
  await expect(stack.locator('#wl-p9 .wl-k')).toHaveText('Dawn Ride');
  await expect(stack.locator('.wl-open')).toHaveCount(0);
  await expect(stack.getByRole('button', { name: /Book again/ })).toHaveCount(0);
  // a stack: each pass's tail lies under the next one
  const [a, b] = await Promise.all([stack.locator('#wl-p2').boundingBox(), stack.locator('#wl-p9').boundingBox()]);
  expect(b!.y).toBeLessThan(a!.y + a!.height);
  // the upcoming ticket is untouched: whole, with its code
  await expect(page.locator('#tab-myrides .myrides-grid .ticket-card')).toHaveCount(1);

  await stack.locator('#wl-p20 .wl-strip').click();
  await expect(stack.locator('#wl-p20.wl-open .wl-head')).toHaveAttribute('aria-expanded', 'true');
  await expect(stack.locator('#wl-p20').getByRole('button', { name: /Book again/ })).toBeVisible();
  await expect(stack.locator('#wl-p20 .wl-head')).toBeFocused(); // the focus stays on the pass, now on its top

  await stack.locator('#wl-p40 .wl-strip').click(); // another one out puts the first back
  await expect(stack.locator('.wl-open')).toHaveCount(1);
  await expect(stack.locator('#wl-p40.wl-open')).toBeVisible();
  await expect(stack.locator('#wl-p20 .wl-strip')).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('Enter'); // its top, from the keyboard, puts it back
  await expect(stack.locator('.wl-open')).toHaveCount(0);
  await expect(stack.locator('#wl-p40 .wl-strip')).toBeFocused();

  // a refresh keeps the rider's choice
  await stack.locator('#wl-p9 .wl-strip').click();
  await page.evaluate('renderMyRides()');
  await expect(page.locator('#mr-past #wl-p9.wl-open')).toBeVisible();
});

test('a ride finished today is out of the stack by itself, and stays put back once closed', async ({ page }) => {
  await open(page, [jcc('t0', off(0)), ...PAST], [bk('t0', off(0), { ride_duration: 72 }), ...PASTQ()]);
  await expect(page.locator('#mr-past > .ticket-card').first()).toHaveClass(/wl-open/);
  await expect(page.locator('#mr-past .wl-open .cu-cue')).toContainText('1 h 12 min');
  await page.locator('#mr-past .wl-open .wl-head').click();
  await expect(page.locator('#mr-past .wl-open')).toHaveCount(0);
  await page.evaluate('renderMyRides()');
  await expect(page.locator('#mr-past .wl-open')).toHaveCount(0);
});

test('two rides on one day run by their start time, whatever order they were booked in', async ({ page }) => {
  const late = jcc('d-late', off(4), { bike_slots: '{"_time":"21:00 - 23:00","_total":20}' });
  const early = jcc('d-early', off(4), { event_kind: 'community', ride_kind: 'swim', needs_approval: false, bike_slots: '{"_time":"7:30 - 9:00","_total":20}' });
  await open(page, [late, early, jcc('d-next', off(6))], [bk('d-next', off(6), { status: 'waiting' }), bk('d-late', off(4), { status: 'waiting' }), bk('d-early', off(4), { status: 'waiting' })]);
  const cards = page.locator('#tab-myrides .myrides-grid .ticket-card');
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toHaveClass(/th-swim/);
  await expect(cards.nth(1)).toHaveClass(/th-jcc/);
  await expect(page.locator('#tab-myrides .analytics-section-title .mr-n').first()).toHaveText('3');
});

test('Arabic: the strip reads from the mark at the start to the date at the end', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, PAST, PASTQ(), 'ar');
  const strip = page.locator('#wl-p2 .wl-strip');
  const [logo, date] = await Promise.all([strip.locator('.tk-logo').boundingBox(), strip.locator('.wl-v').boundingBox()]);
  expect(logo!.x).toBeGreaterThan(date!.x); // the start edge is the right one
  const sb = await strip.boundingBox();
  expect(date!.x).toBeGreaterThanOrEqual(sb!.x);
});
