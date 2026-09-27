import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The History tab and the smaller things around it: a date range that ran open-ended into the
// future, a CSV that ignored the filters on screen, free rides offered for "mark paid", a
// receipt with no amount, a service counter that counted bookings rather than rides, and a
// donut total drawn white on a white card.

const ksa = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const TODAY = ksa(new Date());
const NEXT_WEEK = ksa(new Date(Date.now() + 7 * 864e5));
const sess = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, day: 'Friday', session_date: date, capacity: 12, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ _time: '19:00 - 21:00' }), ...extra,
});
const S_TODAY = `${TODAY}-a`, S_NEXT = `${NEXT_WEEK}-a`, S_FREE = `${TODAY}-free`;
const sessions = [
  sess(S_TODAY, TODAY), sess(S_NEXT, NEXT_WEEK),
  sess(S_FREE, TODAY, { event_kind: 'community', paid_ride: false, title: 'Social ride' }),
];
const row = (id: string, name: string, sid: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Friday', session_date: date, queue_num: 1, name, phone: '0500000001', email: '',
  type_preference: 'Hybrid', size: 'M', status: 'done', paid: false, price: 60, registered_at: `${date}T10:00:00Z`, ...extra,
});
type P = import('@playwright/test').Page;

async function boot(page: P, fx: Record<string, unknown>) {
  await stubSupabase(page, { sessions, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
}
const shown = (page: P) => page.evaluate(`[...document.querySelectorAll('#hist-results tbody tr .rider-name')].map(x=>x.textContent.trim())`) as Promise<string[]>;

test('"Today" is today: a booking cancelled for next week is not in it', async ({ page }) => {
  await boot(page, { queue_entries: [row('h1', 'Rode Today', S_TODAY, TODAY), row('h2', 'Cancelled Ahead', S_NEXT, NEXT_WEEK, { status: 'cancelled' })] });
  await page.evaluate(`setStaffTab('history');S.histRange='today';renderHistory()`);
  expect(await shown(page)).toEqual(['Rode Today']);
  await page.evaluate(`S.histRange='7d';renderHistory()`);
  expect(await shown(page)).toEqual(['Rode Today']);
  await page.evaluate(`S.histRange='all';renderHistory()`);
  expect((await shown(page)).sort()).toEqual(['Cancelled Ahead', 'Rode Today']);
});

test('the CSV exports the rows the filters show', async ({ page }) => {
  await boot(page, { queue_entries: [row('h1', 'Paid Rider', S_TODAY, TODAY, { paid: true }), row('h2', 'Owing Rider', S_TODAY, TODAY)] });
  await page.evaluate(`setStaffTab('history');S.histPay='pending';renderHistory()`);
  expect(await shown(page)).toEqual(['Owing Rider']);
  const dl = page.waitForEvent('download');
  await page.evaluate(`exportHistoryCSV()`);
  const text = await (await import('node:fs/promises')).readFile(await (await dl).path() as string, 'utf8');
  expect(text).toContain('Owing Rider');
  expect(text).not.toContain('Paid Rider');
});

test('a free ride is never offered for "mark paid", and a stale pick of one is ignored', async ({ page }) => {
  await boot(page, { queue_entries: [row('f1', 'Free Rider', S_FREE, TODAY, { price: 0 }), row('h2', 'Owing Rider', S_TODAY, TODAY, { price: 0 })] });
  await page.evaluate(`setStaffTab('history');renderHistory()`);
  expect(await page.locator('#hist-results button[data-on-click*="toggleHistSelect"]').count()).toBe(1); // the owing one only
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && /queue_entries/.test(r.url())) writes.push({ url: r.url(), body: r.postDataJSON() }); });
  await page.evaluate(`S.histSelected=['f1','h2'];bulkHistMarkPaid()`);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].url).toContain('id=eq.h2');
  // Same write as the pill's "Paid": card, no split, and a price of 0 with no promo behind it
  // goes back to the bike's price instead of turning into "on the house".
  expect(writes[0].body).toMatchObject({ paid: true, pay_method: 'card', card_amount: null });
  expect(Number(writes[0].body.price)).toBeGreaterThan(0);
});

test('the receipt states the amount and speaks the reader\'s language for the bike', async ({ page }) => {
  await boot(page, { queue_entries: [row('h1', 'Receipt Rider', S_TODAY, TODAY, { email: 'r@example.com', paid: true, price: 75, type_preference: 'Road' })] });
  await page.evaluate(`showReceipt('h1')`);
  const box = page.locator('#receipt-modal .receipt-box');
  await expect(box).toContainText('SAR 75');
  await expect(box).not.toContainText('N/A');
});

test('rides since service count by when the ride happened, not when it was booked', async ({ page }) => {
  const bike = { id: 'b1', name: 'R-AL-0001-M', size: 'M', type: 'Road', status: 'available', colors: [], color_names: [], bike_number: 1, last_serviced_at: `${TODAY}T05:00:00Z` };
  // Booked a week before the service, ridden after it.
  const ridden = row('h1', 'Late Rider', S_TODAY, TODAY, { assigned_bike_id: 'b1', registered_at: '2020-01-01T10:00:00Z', checked_in_at: `${TODAY}T15:00:00Z`, checked_out_at: `${TODAY}T16:00:00Z` });
  await boot(page, { queue_entries: [ridden], bikes: [bike] });
  await page.evaluate(`openBikeProfile('b1')`);
  const tile = page.locator('#bike-profile-modal').getByText('Rides since service').locator('..');
  await expect(tile).toContainText('1');
});

test('durations are written in the reader\'s units, and the donut total uses the theme ink', async ({ page }) => {
  await boot(page, { queue_entries: [row('h1', 'Anyone', S_TODAY, TODAY)] });
  expect(await page.evaluate(`fmtDur(95)`)).toBe('1 h 35 min');
  expect(await page.evaluate(`fmtDur(12.4)`)).toBe('12 min');
  const svg = await page.evaluate(`_donut([{v:3,c:'#000',label:'x'}])`) as string;
  expect(svg).toContain('fill:var(--text)');
  expect(svg).not.toContain('fill="white"');
});
