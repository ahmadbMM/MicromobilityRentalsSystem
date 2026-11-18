import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// My records (the user, 2026-11-18: "My records in Stats: most Saturdays in a row, best month, and bike types and routes
// tried. Only the member sees them. It stays in Stats because the streak line on home was removed for good."). Tiles on
// the rider's Stats, for any rider with two or more finished sessions (checked in or done), counted on the phone from
// their own bookings, one per session: the longest run ever of Saturdays in a row (from 2, with the month it ended), the
// best month by sessions of any kind (from 2, the earliest of a tie), the fleet's bike types ridden ("n of 5", bike
// sessions only) and the routes ridden (from 1). Nothing is read for them. All Supabase traffic is stubbed.

const sess = (id: string, date: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({ id, day: 'Thursday', session_date: date, capacity: 20, status: 'closed', created_at: 1, location: 'JCC', bike_slots: '{"_time":"18:00 - 20:00","_total":20}', ...o });
const sat = (date: string, o: Record<string, unknown> = {}) => sess(date, date, { day: 'Saturday', event_kind: 'community', ride_kind: 'saturday', location: null, ...o });
const swim = (id: string, date: string) => sess(id, date, { event_kind: 'community', ride_kind: 'swim', location: null });
const rated = { rating_exp: 9, rating_detail: { form: 'rental', s: { experience: 9 }, why: {} }, rated_at: '2099-03-01T10:00:00Z' };
const bk = (id: string, sid: string, date: string, type: string, o: Record<string, unknown> = {}): Record<string, unknown> => ({ id, session_id: sid, session_date: date, name: 'Spec Rider', customer_id: 'c1', session_day: 'Saturday', queue_num: 3, status: 'done', paid: true, price: 0, type_preference: type, registered_at: '2098-12-01T10:00:00Z', ...rated, ...o });

// Saturday rides on 3, 10 and 17 January (the 17th checked in, never marked done), a no-show on the 24th, then 31 January
// and 7 February; 14 February cancelled. A circuit night on Road Carbon, two pool sessions (one booked as Kids, which is
// not a bike ridden). January and February hold four sessions each: January, the earlier, is the best month.
const SESS = [
  sat('2099-01-03', { route_slug: 'obhur-coast' }), sat('2099-01-10', { route_slug: 'obhur-coast' }), sat('2099-01-17', { route_slug: 'corniche-loop' }),
  sat('2099-01-24'), sat('2099-01-31'), sat('2099-02-07', { route_slug: 'obhur-coast' }), sat('2099-02-14'),
  sess('2099-02-12', '2099-02-12'), swim('sw-1', '2099-02-10'), swim('sw-2', '2099-02-20'),
];
const ROWS = [
  bk('a', '2099-01-03', '2099-01-03', 'Road'), bk('b', '2099-01-10', '2099-01-10', 'Hybrid'), bk('c', '2099-01-17', '2099-01-17', 'Hybrid', { status: 'active', paid: false }),
  bk('d', '2099-01-24', '2099-01-24', 'Road', { status: 'noshow' }), bk('e', '2099-01-31', '2099-01-31', 'Mountain'), bk('f', '2099-02-07', '2099-02-07', 'Road'),
  bk('g', '2099-02-14', '2099-02-14', 'Kids', { status: 'cancelled' }), bk('h', '2099-02-12', '2099-02-12', 'Road Carbon', { session_day: 'Thursday' }),
  bk('i', 'sw-1', '2099-02-10', 'Kids', { session_day: 'Tuesday' }), bk('j', 'sw-2', '2099-02-20', 'None', { session_day: 'Friday' }),
];

async function open(page: Page, o: { lang?: string; rows?: Record<string, unknown>[]; sessions?: Record<string, unknown>[] } = {}) {
  await page.clock.setFixedTime(new Date('2099-03-10T12:00:00+03:00'));
  const r = o.rows || ROWS, s = o.sessions || SESS;
  await stubSupabase(page, { sessions: s, 'rpc:list_sessions': s, queue_entries: r, 'rpc:my_bookings': r });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/account/stats?lang=' + (o.lang || 'en'));
  await waitForSb(page);
  await page.evaluate(`_bdgPopClose()`); // a badge's pop-up, should one be new on this date
  await expect(page.locator('#acc-pane-stats .mr-season')).toBeVisible();
}
const card = (page: Page) => page.locator('#acc-pane-stats .rec');
const tiles = (page: Page) => card(page).locator('.rec-t').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()));

test.describe('@customer:account My records', () => {
  test('four tiles on Stats: Saturdays in a row, the best month, bike types and routes', async ({ page }) => {
    const rpcs: string[] = [];
    page.on('request', (r) => { const m = new URL(r.url()).pathname.match(/\/rpc\/(\w+)/); if (m) rpcs.push(m[1]!); });
    await open(page);
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator('.myr-h')).toHaveText('My records');
    expect(await tiles(page)).toEqual([
      '3 Saturdays in a row January 2099', // 3, 10, 17 January; 31 Jan and 7 Feb are two
      '4 Sessions in your best month January 2099', // January and February both hold four: the earlier wins
      '4 of 5 Bike types tried', // Road, Hybrid, Mountain, Road Carbon; the pool's Kids booking is not a bike ridden
      '2 Routes ridden',
    ]);
    // each tile is a big number, its name and at most one short value, nothing else
    await expect(card(page).locator('.rec-t .rec-n')).toHaveCount(4);
    await expect(card(page).locator('.rec-t .rec-v')).toHaveCount(2);
    await expect(card(page).locator('button, a, small, p')).toHaveCount(0);
    // never a current streak, and nothing is read for it
    expect(await card(page).innerText()).not.toMatch(/current|streak/i);
    expect(rpcs.filter((f) => /record/i.test(f))).toEqual([]);
    // it sits on Stats, after Your rides
    await expect(page.locator('#acc-pane-stats .myr + .rec')).toHaveCount(1);
    expect(await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')).toBe(true);
  });

  test('the longest run wins wherever it is, and a pool session on a Saturday is not a Saturday ride', async ({ page }) => {
    const sessions = [sat('2099-01-03'), sat('2099-01-10'), swim('sw-s', '2099-01-17'), sat('2099-01-24'), sat('2099-01-31'), sat('2099-02-07'), sat('2099-02-14')];
    const rows = [
      bk('a', '2099-01-03', '2099-01-03', 'Road'), bk('b', '2099-01-10', '2099-01-10', 'Road'), bk('s', 'sw-s', '2099-01-17', 'None'),
      bk('c', '2099-01-24', '2099-01-24', 'Road'), bk('d', '2099-01-31', '2099-01-31', 'Road'), bk('e', '2099-02-07', '2099-02-07', 'Road'), bk('f', '2099-02-14', '2099-02-14', 'Road'),
    ];
    await open(page, { sessions, rows });
    expect((await tiles(page))[0]).toBe('4 Saturdays in a row February 2099');
  });

  test('from two finished sessions only, each one counted once; a tile below its own threshold is left out', async ({ page }) => {
    // two circuit nights in two months, booked for a party of two each: one bike type, no run, no best month, no route
    const sessions = [sess('2099-01-08', '2099-01-08'), sess('2099-02-05', '2099-02-05')];
    const rows = [
      bk('a', '2099-01-08', '2099-01-08', 'Road', { session_day: 'Thursday' }), bk('a2', '2099-01-08', '2099-01-08', 'Road', { session_day: 'Thursday', queue_num: 4 }),
      bk('b', '2099-02-05', '2099-02-05', 'Road', { session_day: 'Thursday' }),
    ];
    await open(page, { sessions, rows });
    expect(await tiles(page)).toEqual(['1 of 5 Bike types tried']);
  });

  for (const [what, rows] of [
    ['one finished session', [bk('a', '2099-01-03', '2099-01-03', 'Road'), bk('g', '2099-02-14', '2099-02-14', 'Road', { status: 'cancelled' })]],
    ['one session booked for two', [bk('a', '2099-01-03', '2099-01-03', 'Road'), bk('a2', '2099-01-03', '2099-01-03', 'Hybrid', { queue_num: 4 })]],
    ['two still ahead or missed', [bk('d', '2099-01-24', '2099-01-24', 'Road', { status: 'noshow' }), bk('w', '2099-02-14', '2099-02-14', 'Road', { status: 'waiting' })]],
  ] as const) {
    test(`no card: ${what}`, async ({ page }) => {
      await open(page, { rows: rows as unknown as Record<string, unknown>[] });
      await expect(card(page)).toHaveCount(0);
    });
  }

  test('in Arabic', async ({ page }) => {
    await open(page, { lang: 'ar' });
    await expect(card(page).locator('.myr-h')).toHaveText('أرقامي القياسية');
    await expect(card(page).locator('.rec-l')).toHaveText(['أيام سبت متتالية', 'الجلسات في أفضل شهر لك', 'أنواع الدراجات التي جرّبتها', 'المسارات التي قطعتها']);
  });
});
