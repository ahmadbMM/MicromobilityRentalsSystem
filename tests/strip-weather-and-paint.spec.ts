import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Two strip-adjacent changes. The forecast rides on each session chip (staffing calls get
// made off that strip), amber from 42° or 30 km/h wind, and its absence costs nothing — a
// failed fetch must never cost the roster. And the roster paints in two chunks past 40
// groups, so a 200-rider night stops freezing a booth tablet on first render.

const D1 = '2099-01-01', D2 = '2099-01-02';
const sessions = [
  { id: D1, session_date: D1, day: 'Sunday', status: 'open', capacity: 300, created_at: 2 },
  { id: D2, session_date: D2, day: 'Monday', status: 'open', capacity: 20, created_at: 1 },
];
const rider = (n: number) => ({
  id: 'r' + n, session_id: D1, session_day: 'Sunday', session_date: D1, queue_num: n,
  name: 'Rider ' + n, phone: '05500' + String(n).padStart(5, '0'), type_preference: 'Road',
  size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z' });

test('the chip shows the forecast, amber when it bites, silent when absent', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [rider(1)], bikes: [] });
  await page.route('**/api.open-meteo.com/**', (route) => route.fulfill({ json: {
    daily: { time: [D1, D2], temperature_2m_max: [43.2, 33.1], wind_speed_10m_max: [12, 31] } } }));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`localStorage.removeItem('cq_weather_fc');setStaffTab('queue');S.queueView='bookings';renderStaffQueue()`);
  await expect.poll(() => page.evaluate(`!!S.weatherFc`), { timeout: 5000 }).toBe(true);
  await page.evaluate(`renderStaffQueue()`);
  const chips = await page.evaluate(`[...document.querySelectorAll('.sess-chip-date')].map(c=>c.innerText)`) as string[];
  expect(chips.find((c) => c.includes('1 Jan'))).toContain('43°');
  expect(chips.find((c) => c.includes('2 Jan'))).toContain('31');      // windy day carries the wind
  // the wind is drawn (2026-10-09; it was the Batak letter ᯓ, which no screen reader or font names)
  expect(await page.evaluate(`[...document.querySelectorAll('.sess-chip-date')].some(c=>c.innerText.includes('2 Jan')&&!!c.querySelector('.rq-wx-warn svg'))`)).toBe(true);
  expect(chips.join(' ')).not.toContain('ᯓ');
});

test('no forecast, no problem — the strip renders bare', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [rider(1)], bikes: [] });
  await page.route('**/api.open-meteo.com/**', (route) => route.abort());
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`localStorage.removeItem('cq_weather_fc');S.weatherFc=null;setStaffTab('queue');S.queueView='bookings';renderStaffQueue()`);
  await page.waitForTimeout(400);
  const chips = await page.evaluate(`[...document.querySelectorAll('.sess-chip-date')].map(c=>c.innerText).join('|')`) as string;
  expect(chips).not.toContain('°');
  await expect(page.locator('#q-results .queue-table')).toHaveCount(1);  // the roster survived (hidden on mobile, where cards render)
});

test('a big roster still lists every rider after the second chunk lands', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'the table is not built on a phone; its cards paint in one go');
  const riders = Array.from({ length: 120 }, (_, i) => rider(i + 1));
  await stubSupabase(page, { sessions, queue_entries: riders, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>100`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${D1}';renderStaffQueue()`);
  await page.waitForTimeout(400);                                       // both chunks by now
  const count = await page.evaluate(`document.querySelectorAll('#q-results .queue-table tbody tr').length`);
  expect(count).toBe(120);
  const txt = await page.evaluate(`document.querySelector('#q-results .queue-table').innerText`) as string;
  expect(txt).toContain('Rider 1');
  expect(txt).toContain('Rider 120');                                   // the deferred half arrived
});

test('a re-render between the chunks does not double-append', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'the table is not built on a phone; its cards paint in one go');
  const riders = Array.from({ length: 90 }, (_, i) => rider(i + 1));
  await stubSupabase(page, { sessions, queue_entries: riders, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>50`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${D1}';
    renderStaffQueue();renderStaffQueue()`);                            // second render before the first rAF
  await page.waitForTimeout(400);
  const count = await page.evaluate(`document.querySelectorAll('#q-results .queue-table tbody tr').length`);
  expect(count).toBe(90);                                               // not 90 + 50 stale rows
});
