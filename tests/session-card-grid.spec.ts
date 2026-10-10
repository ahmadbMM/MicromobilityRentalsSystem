import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Every session card inside one event is the same card: the same height, and its time and
// status on the same lines at the same x (the date is the day's heading since 2026-10-10). That used to depend on how wide the
// words happened to be - a long weekday, a ride name, a "Gathering ... Start ..." time
// all sat on one line and pushed their neighbours along, so a list of three sessions was
// three different heights on a phone and a ragged staircase on a desktop.

const jcc = (id: string, day: string, time: string) => ({
  id, session_date: id, day, status: 'open', capacity: 12, created_at: 1, location: 'JCC',
  bike_slots: JSON.stringify({ _time: time }),
});
// Deliberately uneven: the longest weekday, the longest time and a full session, which
// carries the longer "Waitlist" status.
const circuit = [
  jcc('2099-01-09', 'Friday', '19:00 - 21:00'),
  jcc('2099-01-14', 'Wednesday', '18:30 - 20:30'),
  { ...jcc('2099-01-17', 'Saturday', '19:00 - 21:00'), status: 'full' },
];
// The community list mixes two named rides, one of which labels its two times.
const comm = (id: string, kind: string, title: string, time: string) => ({
  id, session_date: id.slice(0, 10), day: 'Saturday', status: 'open', capacity: 20, created_at: 1,
  event_kind: 'community', ride_kind: kind, title, spots: 20, needs_approval: kind !== 'petromin',
  bike_slots: JSON.stringify({ _time: time }),
});
const community = [
  comm('2099-01-10', 'saturday', 'Saturday Social Ride', '06:30 - 07:00'),
  comm('2099-01-13-pw', 'petromin', "Petromin's Wednesdays", '17:00 - 21:00'),
  comm('2099-01-24', 'saturday', 'Saturday Social Ride', '06:30 - 07:00'),
];

/** Geometry of every card in the picker, rounded to the pixel. */
async function cards(page: import('@playwright/test').Page) {
  return page.locator('.session-cards-grid').first().evaluate((g) =>
    Array.from(g.querySelectorAll('.sess-card')).map((c) => {
      const px = (n: number) => Math.round(n);
      const box = (el: Element | null) => (el ? el.getBoundingClientRect() : null);
      const card = c.getBoundingClientRect();
      const time = box(c.querySelector('.sess-card-time'))!;
      const spots = box(c.querySelector('.sess-card-spots'));
      return {
        height: px(card.height), width: px(card.width),
        timeStart: px(time.left), spotsEnd: spots ? px(spots.right) : null,
      };
    }));
}

const same = <T>(rows: T[], pick: (r: T) => number) => new Set(rows.map(pick)).size;

for (const [event, sessions] of [['the circuit', circuit], ['the community rides', community]] as const) {
  for (const [name, width] of [['a phone', 390], ['a desktop', 1280]] as const) {
    test(`${event}: every card is the same size and lines up on ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await stubSupabase(page, { sessions, bikes: [], queue_entries: [], 'rpc:community_member': true });
      await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
      await page.goto('/');
      await waitForSb(page);
      const ev = sessions === circuit ? 'jcc' : 'community';
      await page.evaluate(`S.selEvent='${ev}';setCustTab('register')`);
      await expect(page.locator('.sess-card')).toHaveCount(3);

      const rows = await cards(page);
      expect(same(rows, (r) => r.height)).toBe(1);   // one size
      expect(same(rows, (r) => r.width)).toBe(1);
      expect(same(rows, (r) => r.timeStart)).toBe(1); // one column: every row leads with its time
      const withStatus = rows.filter((r) => r.spotsEnd !== null);
      expect(same(withStatus, (r) => r.spotsEnd!)).toBeLessThanOrEqual(1);  // a status, when there is one, pinned to the far end
      // each day is said once, as a heading over its rows; no row repeats the date
      await expect(page.locator('.sess-day-h')).toHaveCount(3);
      await expect(page.locator('.sess-card .sess-card-date')).toHaveCount(0);
    });
  }
}

test('a card marked full or turned down is still the same card', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const rejected = {
    id: 'bk1', session_id: '2099-01-10', session_day: 'Saturday', session_date: '2099-01-10',
    queue_num: 4, name: 'Spec Rider', size: 'M', type_preference: 'Any', status: 'cancelled',
    cancelled_by: 'staff', approval: 'rejected', paid: false, price: 0, customer_id: 'c1',
    registered_at: '2099-01-01T10:00:00Z',
  };
  const full = { ...community[2], status: 'full' };
  await stubSupabase(page, {
    sessions: [community[0], community[1], full], bikes: [], queue_entries: [rejected],
    'rpc:community_member': true,
  });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.selEvent='community';setCustTab('register')`);
  await expect(page.locator('.sess-card-rej')).toHaveCount(1);   // the turned-down ride
  await expect(page.locator('.sess-card-spots.spots-red')).toHaveCount(1); // and the one marked full

  const rows = await cards(page);
  expect(same(rows, (r) => r.height)).toBe(1);
  expect(same(rows.filter((r) => r.spotsEnd !== null), (r) => r.spotsEnd!)).toBe(1); // "Full for this week" ends where the turned-down note does
  expect(rows.filter((r) => r.spotsEnd === null)).toHaveLength(1); // an open ride says nothing: "Available" is not news
});

// Off-screen session cards used to skip rendering (content-visibility:auto) with a 100px
// placeholder. In a grid of 1fr rows that placeholder set the height of EVERY row, so a long
// list opened with every card twice its size and collapsed under the rider's finger once the
// last card scrolled into view.
test('a long list keeps its cards at their own height, before and after scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  // 16 open nights: enough that the tail of the list is well outside the viewport
  const many = Array.from({ length: 16 }, (_, i) => jcc(`2099-02-${String(i + 1).padStart(2, '0')}`, 'Friday', '19:00 - 21:00'));
  await stubSupabase(page, { sessions: many, bikes: [], queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.selEvent='jcc';setCustTab('register')`);
  await expect(page.locator('.sess-card')).toHaveCount(16);

  const before = await cards(page);
  expect(same(before, (r) => r.height)).toBe(1);
  expect(before[0].height).toBeLessThan(140); // a card is its own height (about 100px since it carries the price line), not twice it
  for (let y = 0; y <= 3200; y += 400) { await page.evaluate((v) => window.scrollTo(0, v), y); await page.waitForTimeout(60); }
  await page.evaluate(() => window.scrollTo(0, 0));
  const after = await cards(page);
  expect(after.map((r) => r.height)).toEqual(before.map((r) => r.height)); // nothing moved
});
