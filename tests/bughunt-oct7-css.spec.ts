import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Visual slips found by the 2026-10-07 stylesheet review:
// - in Arabic and Urdu a rider's selects drew their chevron at the start edge, before the words, while the birth date's,
//   the correction page's and every staff select draw it at the end;
// - since every ticket wears its event's colours (2026-10-06), a few lines kept their paper inks on the circuit's navy:
//   a waitlisted rider's "Waitlist", a past ride's "Ridden" and its duration (about 2:1);
// - in Arabic the booking you are changing kept its queue number beside the title instead of at the end of the line;
// - on a tablet the roster of one ride carried a blank column (the Session placeholder every other width hides).

const S = (id: string, x: Record<string, unknown>) => ({ id, session_date: id.slice(0, 10), day: 'Saturday', status: 'open', capacity: 80, spots: 80, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00"}', event_kind: null, ride_kind: null, ...x });
const B = (id: string, sid: string, x: Record<string, unknown> = {}) => ({ id, name: 'Sara Haddad', customer_id: 'c1', session_id: sid, session_day: 'Saturday', session_date: sid.slice(0, 10), queue_num: 7, status: 'waiting', paid: false, price: 75, registered_at: '2026-08-01T10:00:00Z', type_preference: 'Road', height: 170, ...x });
const sessions = [S('2099-10-21', {}), S('2099-10-28', {}), S('2026-08-15', { status: 'closed' })];
const bookings = [
  B('j1', '2099-10-21'),
  B('w1', '2099-10-28', { status: 'waitlist', waitlist_num: 2 }),
  B('d1', '2026-08-15', { status: 'done', paid: true, ride_duration: 95, checked_in_at: '2026-08-15T18:00:00Z', checked_out_at: '2026-08-15T19:35:00Z', rating_detail: { form: 'rental', s: { service: 10, bike: 10, experience: 10 } } }),
];

async function open(page: Page, lang: string) {
  await page.addInitScript((l) => { localStorage.setItem('cq_lang', l); localStorage.setItem('cq_lang_pick', '1'); }, lang);
  await page.setViewportSize({ width: 400, height: 1200 });
  await stubSupabase(page, { sessions, queue_entries: bookings, 'rpc:my_bookings': bookings });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', birth_date: '1995-05-05', nationality: 'SA', country: 'SA' });
  await page.goto('/');
  await waitForSb(page);
}

/** WCAG contrast of an element's text against a solid colour. */
const contrast = (page: Page, sel: string, bg: string) => page.locator(sel).first().evaluate((el, bg) => {
  const rgb = (c: string) => (c.match(/[\d.]+/g) || []).map(Number);
  const [r, g, b, a = 1] = rgb(getComputedStyle(el).color), [R, G, B] = rgb(bg);
  const mix = [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
  const lum = (v: number[]) => { const f = (x: number) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(v[0]) + 0.7152 * f(v[1]) + 0.0722 * f(v[2]); };
  const L1 = lum(mix), L2 = lum([R, G, B]);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}, bg);

test('Arabic: a rider’s select draws its chevron at the end edge, with its room there', async ({ page }) => {
  await open(page, 'ar');
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#acc-country')).toBeVisible();
  const look = (sel: string) => page.locator(sel).evaluate((el) => { const cs = getComputedStyle(el); return { x: cs.backgroundPositionX, padL: parseFloat(cs.paddingLeft), padR: parseFloat(cs.paddingRight) }; });
  const country = await look('#acc-country');
  expect(country.x).toMatch(/^(left )?13px$/);
  expect(country.padL).toBeGreaterThanOrEqual(24);
  expect(country.padR).toBeLessThan(24);
  expect((await look('#acc-birth-y')).x).toMatch(/^(left )?8px$/); // its own end-edge rule is untouched
});

test('English: the chevron stays at the right', async ({ page }) => {
  await open(page, 'en');
  await page.evaluate(`setCustTab('account')`);
  const x = await page.locator('#acc-country').evaluate((el) => getComputedStyle(el).backgroundPositionX);
  expect(x).toMatch(/^(right 13px|calc\(100% - 13px\))$/);
});

test('the circuit’s navy ticket keeps every line readable: Waitlist, Ridden and the ride’s duration', async ({ page }) => {
  await open(page, 'en');
  await page.evaluate(`goCustomer('myrides')`);
  await expect(page.locator('#tab-myrides .ticket-card')).toHaveCount(3);
  const navy = 'rgb(6, 52, 111)';
  expect(await contrast(page, '#tab-myrides .ticket-card.th-jcc.tk-wl .cu-tr-wl', navy)).toBeGreaterThanOrEqual(4.5);
  expect(await contrast(page, '#tab-myrides .ticket-card.th-jcc.tk-past .tk-rt-done', navy)).toBeGreaterThanOrEqual(4.5);
  expect(await contrast(page, '#tab-myrides .ticket-card.th-jcc.tk-past .cu-tr-dur', navy)).toBeGreaterThanOrEqual(4.5);
});

test('Arabic: the booking being changed shows its queue number at the end of the line', async ({ page }) => {
  await open(page, 'ar');
  await page.evaluate(`S.selEvent='jcc';S.selSession='2099-10-21';S.regStep=2;S.regBikeHeights=['170'];setCustTab('register')`);
  const head = page.locator('#tab-register .cu-mod-head');
  await expect(head).toBeVisible();
  const [h, q] = await Promise.all([head.boundingBox(), head.locator('.cu-mod-qn').boundingBox()]);
  const padStart = await head.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  expect(Math.abs(q!.x - (h!.x + padStart))).toBeLessThanOrEqual(1); // the end edge is the left one in Arabic
});

test('tablet: the roster of one ride has no blank Session column', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 1000 });
  await stubSupabase(page, { sessions: [S('2099-10-21', {})], queue_entries: [B('j1', '2099-10-21', { customer_id: null, phone: '0500000001' })], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='2099-10-21';renderStaffQueue()`);
  await expect(page.locator('#tab-queue .queue-table tbody tr').first()).toBeVisible();
  const shown = await page.locator('#tab-queue .queue-table .rq-none').evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== 'none').length);
  expect(shown).toBe(0);
  expect(await page.locator('#tab-queue .density-toggle').evaluate((el) => getComputedStyle(el).display)).toBe('flex');
});
