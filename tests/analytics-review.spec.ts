import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Analytics numbers and labels that were wrong. State is set straight into S so each case
// shows exactly the rows it is about; dates are KSA dates relative to today.
const ksaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const addDays = (iso: string, n: number) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

async function boot(page: Page) {
  await stubSupabase(page, {});
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

// Puts sessions and bookings in place (bookings in DB shape, through entryFromDB) and renders.
async function render(page: Page, data: { sessions: Record<string, unknown>[]; rows: Record<string, unknown>[]; cashSales?: Record<string, unknown>[]; setup?: string }) {
  await page.evaluate((d) => {
    S.sessions = d.sessions; S.cashSales = d.cashSales || [];
    // @ts-expect-error app globals
    S.queue = d.rows.map((r) => entryFromDB({ session_day: 'Friday', status: 'done', paid: true, price: 100, type_preference: 'Road', name: 'Rider', registered_at: '2026-01-01T10:00:00Z', ...r }));
    S.view = 'staff'; S.staffTab = 'analytics';
    if (d.setup) (0, eval)(d.setup);
    // @ts-expect-error app globals
    renderAnalytics();
  }, data);
}

test('a single-session focus from another range drops back to all sessions', async ({ page }) => {
  await boot(page);
  const today = ksaToday(), thisMonth = today.slice(0, 7) + '-01';
  const lastMonth = addDays(thisMonth, -1).slice(0, 7) + '-01';
  await render(page, {
    sessions: [{ id: 'sPrev', day: 'Friday', session_date: lastMonth, capacity: 12, status: 'closed' }, { id: 'sCur', day: 'Friday', session_date: thisMonth, capacity: 12, status: 'closed' }],
    rows: [{ id: 'p1', session_id: 'sPrev', customer_id: 'c1' }, { id: 'c1r', session_id: 'sCur', customer_id: 'c2' }],
    setup: "S.analyticsRange='all';S.anSession='sPrev';",
  });
  await page.evaluate("setAnRange('month')");
  expect(await page.evaluate('S.anSession')).toBe('all');
  expect(await page.locator('#tab-analytics select.filter-select').inputValue()).toBe('all');
  const done = await page.evaluate("document.querySelector('#tab-analytics .result-count').textContent");
  expect(done).toMatch(/·\s*1\s/); // this month's one ride, not the zero of a session out of range
});

test('RFM: every segment heading is translated, and a one-ride rider gone 45 days is at risk', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(() => ({
    // @ts-expect-error app globals
    a: _anRFMSegment(45, 1), b: _anRFMSegment(25, 1), c: _anRFMSegment(10, 1), d: _anRFMSegment(20, 2), e: _anRFMSegment(90, 5),
  }));
  expect(out).toEqual({ a: 'atrisk', b: 'atrisk', c: 'newbie', d: 'loyal', e: 'lost' });
  const past = addDays(ksaToday(), -45);
  await render(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: past, capacity: 12, status: 'closed' }],
    rows: [{ id: 'r1', session_id: 's1', customer_id: 'c1', checked_in_at: past + 'T15:00:00Z' }],
  });
  await page.evaluate("setAnView('growth')");
  const text = await page.locator('#tab-analytics').textContent();
  expect(text).not.toMatch(/anRfm/);
});

test('team consumption names the member a till sale was taken by', async ({ page }) => {
  await boot(page);
  await render(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: '2026-01-02', capacity: 12, status: 'closed' }],
    rows: [{ id: 'r1', session_id: 's1' }],
    cashSales: [{ id: 'x1', receipt_id: 'x1', session_id: 's1', name: 'Gel', category: 'Food', qty: 2, price: 10, pay: 'team', team_name: 'Ali Member' }],
  });
  await page.evaluate("setAnView('revenue')"); // only the sub-view on show is drawn (2026-10-04)
  const card = page.locator('#tab-analytics .chart-card', { hasText: 'Ali Member' });
  await expect(card).toHaveCount(1);
});

test('repeat rate counts visits: a party on one booking is not a repeat rider', async ({ page }) => {
  await boot(page);
  await render(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: '2026-01-02', capacity: 12, status: 'closed' }],
    rows: [1, 2, 3].map((i) => ({ id: 'r' + i, session_id: 's1', customer_id: 'c1' })),
  });
  await page.evaluate("setAnView('customers')");
  await expect(page.locator('#tab-analytics .hl-value', { hasText: '0/1' })).toHaveCount(1);
});

test('the lapsed rider WhatsApp link carries the full international number', async ({ page }) => {
  await boot(page);
  const past = addDays(ksaToday(), -40);
  await render(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: past, capacity: 12, status: 'closed' }],
    rows: [{ id: 'r1', session_id: 's1', session_date: past, customer_id: 'c1', phone: '0512345678' }],
  });
  await page.evaluate("setAnView('customers')");
  const href = await page.locator('#tab-analytics a[href*="wa.me/"]').first().getAttribute('href');
  expect(href).toContain('https://wa.me/966512345678?');
});

test('This Month arrows compare the month so far with the same days of last month', async ({ page }) => {
  const today = ksaToday(), day = Number(today.slice(8, 10));
  const thisMonth = today.slice(0, 7) + '-01', lastMonth = addDays(thisMonth, -1).slice(0, 7) + '-01';
  const dimPrev = Number(addDays(thisMonth, -1).slice(8, 10));
  test.skip(day >= dimPrev, 'needs a day of last month that lies after today\'s date');
  const lateDay = lastMonth.slice(0, 8) + String(dimPrev).padStart(2, '0');
  await boot(page);
  await render(page, {
    sessions: [
      { id: 'cur', day: 'Friday', session_date: thisMonth, capacity: 12, status: 'closed' },
      { id: 'prev', day: 'Friday', session_date: lastMonth, capacity: 12, status: 'closed' },
      { id: 'late', day: 'Friday', session_date: lateDay, capacity: 12, status: 'closed' },
    ],
    rows: [
      { id: 'a1', session_id: 'cur' }, { id: 'a2', session_id: 'cur' },
      { id: 'b1', session_id: 'prev' }, { id: 'b2', session_id: 'prev' },
      ...Array.from({ length: 10 }, (_, i) => ({ id: 'l' + i, session_id: 'late' })),
    ],
    setup: "S.analyticsRange='month';S.anSession='all';S.anView='ridership';",
  });
  const badge = page.locator('#tab-analytics .analytics-kpi-label', { hasText: 'Completed Rides' }).locator('.an-delta');
  await expect(badge).toHaveText(/0%/);
});

test('revenue per ride divides the rides\' fares, not money paid ahead for later nights', async ({ page }) => {
  await boot(page);
  await render(page, {
    sessions: [{ id: 'past', day: 'Friday', session_date: '2026-01-02', capacity: 12, status: 'closed' }, { id: 'future', day: 'Friday', session_date: '2099-01-02', capacity: 12, status: 'open' }],
    rows: [
      { id: 'd1', session_id: 'past' }, { id: 'd2', session_id: 'past' },
      { id: 'f1', session_id: 'future', status: 'waiting' }, { id: 'f2', session_id: 'future', status: 'waiting' }, { id: 'f3', session_id: 'future', status: 'waiting' },
    ],
    setup: "S.analyticsRange='all';S.anSession='all';",
  });
  const v = await page.locator('#tab-analytics .hl-item', { hasText: 'Revenue per Ride' }).locator('.hl-value').textContent();
  expect(v).toMatch(/^SAR 100(?!\.)/); // one money format since 2026-10-09: cents only when there are any (was SAR 100.00)
});

test('no revenue at all raises no low-collection alert', async ({ page }) => {
  await boot(page);
  await render(page, { sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-02', capacity: 12, status: 'open' }], rows: [], setup: "S.analyticsRange='all';S.anSession='all';" });
  await expect(page.locator('#tab-analytics .insight-card.alert')).toHaveCount(0);
});

test('the live board counts held places, not every row that was not cancelled', async ({ page }) => {
  await boot(page);
  const today = ksaToday();
  await render(page, {
    sessions: [{ id: 't', day: 'Friday', session_date: today, capacity: 12, status: 'open' }],
    rows: [
      { id: 'w1', session_id: 't', status: 'waiting', paid: false }, { id: 'w2', session_id: 't', status: 'waiting', paid: false }, { id: 'a1', session_id: 't', status: 'active' },
      { id: 'wl', session_id: 't', status: 'waitlist', paid: false }, { id: 'rm', session_id: 't', status: 'removed', paid: false },
      { id: 'ns', session_id: 't', status: 'noshow', paid: false }, { id: 'cx', session_id: 't', status: 'cancelled', paid: false },
    ],
  });
  // 4: the two waiting, the one on a bike and the waitlisted row, which the server counts against
  // capacity (_capacity_guard) and so takes a place customers can no longer book; removed, no-show
  // and cancelled rows hold none. Capped at the capacity, so a full night never reads 53/40 (2026-10-04).
  await expect(page.locator('#tab-analytics .chart-card').first()).toContainText('4/12');
});

test('the growth funnel bars have width', async ({ page }) => {
  await boot(page);
  await render(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: '2026-01-02', capacity: 12, status: 'closed' }],
    rows: [{ id: 'r1', session_id: 's1' }, { id: 'r2', session_id: 's1', status: 'noshow' }],
    setup: "S.analyticsRange='all';S.anSession='all';",
  });
  await page.evaluate("setStaffTab('analytics'); setAnView('growth')");
  const rows = page.locator('#tab-analytics .an-funnel-row');
  await expect(rows).toHaveCount(3);
  // Booked is the whole funnel (100%): its bar spans the card, not zero pixels beside the label.
  const w = await rows.first().evaluate((el) => (el.querySelector('.an-pfill') as HTMLElement).getBoundingClientRect().width);
  expect(w).toBeGreaterThan(40);
});

test('the height report covers the same nights as the dashboard', async ({ page }) => {
  await boot(page);
  const today = ksaToday(), thisMonth = today.slice(0, 7) + '-01';
  const nextMonth = addDays(addDays(thisMonth, 31).slice(0, 7) + '-01', 0);
  const ids = await page.evaluate((d) => {
    S.sessions = [{ id: 'in', day: 'Friday', session_date: d.thisMonth, status: 'open' }, { id: 'gone', day: 'Friday', session_date: d.thisMonth, status: 'deleted' }, { id: 'next', day: 'Friday', session_date: d.nextMonth, status: 'open' }];
    S.analyticsRange = 'month'; S.anSession = 'all';
    // @ts-expect-error app globals
    return _anHeightBikeData().map((x) => x.sess.id);
  }, { thisMonth, nextMonth });
  expect(ids).toEqual(['in']);
});

test('booking fields a customer controls are text in Analytics, never markup', async ({ page }) => {
  await boot(page);
  const bad = (n: number) => `<img src=x onerror="window.__xss=${n}">`;
  await render(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: '2026-01-02', capacity: 12, status: 'closed' }],
    rows: [
      { id: 'r1', session_id: 's1', type_preference: bad(1), session_day: bad(2), ride_duration: 30,
        purchases: JSON.stringify([{ id: 'g', name: 'Gel', qty: 1, price: 5, pay: 'team', team: bad(3) }]) },
      { id: 'r2', session_id: 's1', type_preference: bad(1), session_day: bad(2) },
    ],
    setup: "S.analyticsRange='all';S.anSession='all';",
  });
  await page.evaluate("setAnView('growth')");
  await page.waitForTimeout(300);
  expect(await page.evaluate('window.__xss')).toBeUndefined();
  expect(await page.locator('#tab-analytics img[src="x"]').count()).toBe(0);
});

test.describe('analytics clocks read KSA time on a device set to another zone', () => {
  test.use({ timezoneId: 'America/New_York' });
  test('heatmap, cohort month and forecast month', async ({ page }) => {
    await boot(page);
    const out = await page.evaluate(() => {
      // 21:30 UTC on Friday 18 Sep = 00:30 Saturday 19 Sep in Riyadh (17:30 Friday in New York).
      // @ts-expect-error app globals
      const heat = _anHeatGrid([{ status: 'done', checkedInAt: '2026-09-18T21:30:00Z' }]);
      // @ts-expect-error app globals
      const ltv = _anLTVByCohort([{ status: 'done', customerId: 'c1', paid: true, price: 30, sessionId: 's', checkedInAt: '2026-08-31T22:00:00Z' }]);
      // @ts-expect-error app globals
      const fc = _anMonthForecast([{ id: 's9', session_date: '2026-09-15' }], [{ sessionId: 's9', status: 'done', paid: true, price: 30 }], new Date('2026-08-31T22:00:00Z'));
      return { sat0: heat.grid[6] && heat.grid[6][0], month: ltv[0].month, fcRides: fc.rides, fcDays: fc.days, fcElapsed: fc.elapsed };
    });
    expect(out).toEqual({ sat0: 1, month: '2026-09', fcRides: 1, fcDays: 30, fcElapsed: 1 });
  });
});
