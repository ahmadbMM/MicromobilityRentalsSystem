import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bookings in colour (the owner, 2026-10-05): "make the session cards in the bookings page in staff website
// themed the same way they are themed in customer event picker cards, make the bookings rows be colored
// matching the status of it for instance completed green no show or cancelled red, make reserved colored
// make to be reserved colored make paid colored". The ride chips and the Sessions view's cards wear their
// event's look; each roster row (and phone card) takes its booking state's colour, its badge too; the
// payment button its own; the figures above the roster are the key.
// 2026-10-07 (the owner): "i want the pending bookings to be colored white not yellow, make the checked in
// bookings yellow instead": waiting rows are white, checked-in ones (on a bike, or still needing one) yellow.

const J = '2099-10-18';
const sessions = [
  { id: J, day: 'Sunday', session_date: J, capacity: 12, status: 'open', created_at: 1, location: 'JCC', bike_slots: '{"_time":"21:00 - 23:00","_total":12}' },
  { id: '2099-10-24', day: 'Saturday', session_date: '2099-10-24', capacity: 20, spots: 20, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: true, bike_slots: '{"_time":"06:00 - 06:30"}' },
  { id: '2099-10-22-pm', day: 'Wednesday', session_date: '2099-10-22', capacity: 30, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false, bike_slots: '{"_time":"21:00 - 23:00"}' },
  { id: '2099-10-17-rh', day: 'Saturday', session_date: '2099-10-17', capacity: 80, spots: 80, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'runher', paid_ride: false, needs_approval: false, hide_queue: true, location: 'JYC', bike_slots: '{"_time":"06:00 - 06:30"}' },
  { id: '2099-09-23-nd', day: 'Wednesday', session_date: '2099-09-23', capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'snd96', open_to_all: true, paid_ride: true, needs_approval: false, bike_slots: '{"_time":"20:00 - 22:00"}' },
  { id: '2099-10-28-ev', day: 'Tuesday', session_date: '2099-10-28', capacity: 30, spots: 30, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'event', title: 'Bike maintenance class', paid_ride: true, price: 40, open_to_all: true, needs_approval: false, hide_queue: true, bike_slots: '{"_time":"19:00 - 21:00"}' },
];
const bikes = [{ id: 'b1', name: 'R-11', type: 'Road', size: 'M', status: 'available', colors: [] }, { id: 'b2', name: 'H-02', type: 'Hybrid', size: 'L', status: 'in_use', colors: [] }];
const row = (n: number, name: string, x: Record<string, unknown> = {}) => ({
  id: 'q' + n, name, session_id: J, session_day: 'Sunday', session_date: J, queue_num: n, status: 'waiting', paid: false,
  price: 75, registered_at: J + 'T10:00:00Z', type_preference: 'Road', size: 'M', phone: '05500000' + String(n).padStart(2, '0'), ...x });
const rows = [
  row(1, 'Waiting Rider'), row(2, 'Paid Waiting', { paid: true, pay_method: 'card' }), row(3, 'Bike Held', { assigned_bike_id: 'b1' }),
  row(4, 'To Hold', { to_reserve: true }), row(5, 'Waitlisted Rider', { status: 'waitlist' }),
  row(6, 'On The Bike', { status: 'active', paid: true, assigned_bike_id: 'b2', checked_in_at: J + 'T18:10:00Z' }),
  row(7, 'Done Paid', { status: 'done', paid: true }), row(8, 'Done Unpaid', { status: 'done' }), row(9, 'House Rider', { paid: true, price: 0 }),
  row(10, 'No Show Rider', { status: 'noshow' }), row(11, 'Cancelled Rider', { status: 'cancelled', cancelled_by: 'customer' }),
];

async function bookings(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 1000 });
  await stubSupabase(page, { sessions, bikes, queue_entries: rows });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getBikes().length>0');
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${J}';S.sfShowFinished=true;renderStaffQueue()`);
}
const bg = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
const img = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundImage);

test.describe('@staff:bookings Bookings in colour', () => {
  test('each ride chip wears its event’s look, with its mark', async ({ page }) => {
    await bookings(page);
    const chip = (id: string) => `#sess-strip .sess-summary-chip[data-on-click*='"setSfSession","${id}"']`;
    await expect(page.locator(chip(J))).toHaveClass(/\bth-jcc\b/);
    expect(await bg(page, chip(J))).toBe('rgb(6, 52, 111)'); // the circuit's navy
    await expect(page.locator(`${chip(J)} img.sf-mark`)).toHaveAttribute('src', '/jcc-white.webp');
    for (const id of ['2099-10-24', '2099-10-22-pm']) {
      await expect(page.locator(chip(id))).toHaveClass(/\bth-comm\b/);
      expect(await img(page, chip(id))).toContain('mm-pattern');
    }
    // and Petromin's registrations chip beside its night
    await expect(page.locator(`#sess-strip .pm-chip`)).toHaveClass(/\bth-comm\b/);
    // the community rides keep their own name colour: Petromin red, not the staff green
    expect(await page.locator(`${chip('2099-10-22-pm')} .sess-chip-event`).evaluate((el) => getComputedStyle(el).color)).toBe('rgb(163, 59, 46)');
    await expect(page.locator(chip('2099-10-17-rh'))).toHaveClass(/\bth-runher\b/);
    expect(await img(page, chip('2099-10-17-rh'))).toContain('radial-gradient');
    await expect(page.locator(`${chip('2099-10-17-rh')} img.sf-mark`)).toHaveAttribute('src', '/assets/runher-partners.webp');
    await expect(page.locator(chip('2099-09-23-nd'))).toHaveClass(/\bth-snd96\b/);
    expect(await bg(page, chip('2099-09-23-nd'))).toBe('rgb(0, 38, 40)');
    await expect(page.locator(chip('2099-10-28-ev'))).toHaveClass(/\bth-event\b/);
    await expect(page.locator(`${chip('2099-10-28-ev')} img.sf-mark`)).toHaveCount(0);
    // the picked ride is ringed in its own accent, and hovering keeps the look
    expect(await page.locator(chip(J)).evaluate((el) => getComputedStyle(el).boxShadow)).toContain('rgb(14, 151, 213)');
    await page.locator(chip('2099-09-23-nd')).hover();
    expect(await bg(page, chip('2099-09-23-nd'))).toBe('rgb(0, 38, 40)');
    // the Sessions view's cards too
    await page.evaluate(`S.queueView='sessions';renderStaffQueue()`);
    await expect(page.locator(`#sess-host .sess-lc.th-jcc`)).toHaveCount(1);
    await expect(page.locator(`#sess-host .sess-lc.th-comm`)).toHaveCount(2);
    await expect(page.locator(`#sess-host .sess-lc.th-runher, #sess-host .sess-lc.th-snd96, #sess-host .sess-lc.th-event`)).toHaveCount(3);
  });

  test('every booking state colours its row, its edge and its badge; money has its own colours', async ({ page }) => {
    await bookings(page);
    const tr = (name: string) => `#tab-queue .queue-table-desktop-wrap tbody tr:has-text("${name}")`;
    const want: [string, string, string, string][] = [
      ['Waiting Rider', 'row-waiting', 'rgb(255, 255, 255)', 'st-waiting'],
      ['Bike Held', 'row-reserved', 'rgb(237, 233, 254)', 'st-reserved'],
      ['To Hold', 'row-toreserve', 'rgb(250, 232, 255)', 'st-toreserve'],
      ['Waitlisted Rider', 'row-waitlist', 'rgb(255, 237, 213)', 'st-waitlist'],
      ['On The Bike', 'row-active', 'rgb(254, 246, 220)', 'st-active'],
      ['Done Paid', 'row-done-paid', 'rgb(220, 252, 231)', 'st-done'],
      ['Done Unpaid', 'row-done', 'rgb(220, 252, 231)', 'st-done'],
      ['No Show Rider', 'row-noshow-cancel', 'rgb(254, 226, 226)', 'st-noshow'],
    ];
    for (const [name, cls, colour, badge] of want) {
      await expect(page.locator(tr(name)), name).toHaveClass(new RegExp(`\\b${cls}\\b`));
      expect(await bg(page, `${tr(name)} td:nth-child(2)`), name).toBe(colour);
      // the pinned first cell is the same solid colour (it masks the columns scrolling under it) with the edge
      expect(await bg(page, `${tr(name)} td:first-child`), name).toBe(colour);
      expect(await page.locator(`${tr(name)} td:first-child`).evaluate((el) => getComputedStyle(el).boxShadow), name).toContain('inset');
      await expect(page.locator(`${tr(name)} .status-badge.${badge}`), name).toHaveCount(1);
      expect(await page.locator(tr(name)).evaluate((el) => getComputedStyle(el).opacity), name).toBe('1');
    }
    // the badge is a pill of its row's colour
    expect(await bg(page, `${tr('On The Bike')} .status-badge.st-active`)).toBe('rgb(253, 233, 176)');
    expect(await bg(page, `${tr('Waiting Rider')} .status-badge.st-waiting`)).toBe('rgb(255, 255, 255)');
    // paid green, pending amber, on the house teal
    expect(await bg(page, `${tr('Paid Waiting')} .pay-toggle.paid`)).toBe('rgb(187, 247, 208)');
    expect(await bg(page, `${tr('Waiting Rider')} .pay-toggle.pending`)).toBe('rgb(253, 230, 138)');
    expect(await bg(page, `${tr('House Rider')} .pay-toggle.house`)).toBe('rgb(204, 251, 241)');
    // the figures above the roster are the key
    await expect(page.locator('#tab-queue .stat-chip.sc-waiting')).toHaveCount(1);
    await expect(page.locator('#tab-queue .stat-chip.sc-active')).toHaveCount(1);
    await expect(page.locator('#tab-queue .stat-chip.sc-done')).toHaveCount(1);
    // cancelled is red too, when the filter shows it
    await page.evaluate(`S.sfStatus='cancelled';renderStaffQueue()`);
    await expect(page.locator(tr('Cancelled Rider'))).toHaveClass(/\brow-noshow-cancel\b/);
    expect(await bg(page, `${tr('Cancelled Rider')} td:nth-child(2)`)).toBe('rgb(254, 226, 226)');
    await expect(page.locator(`${tr('Cancelled Rider')} .status-badge.st-cancelled`)).toHaveCount(1);
  });

  test('the Member column keeps its own look (its badge is not a booking state)', async ({ page }) => {
    await stubSupabase(page, { sessions, bikes, queue_entries: [row(1, 'Saturday Member', { session_id: '2099-10-24', session_day: 'Saturday', session_date: '2099-10-24', price: 0, approval: 'approved' })] });
    await unlockStaff(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='2099-10-24';renderStaffQueue()`);
    const member = page.locator('#tab-queue td[data-label="Membership"] .status-badge').first();
    await expect(member).toBeVisible();
    await expect(member).not.toHaveClass(/\bst-/);
    expect(await member.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
  });

  test('on a phone the cards take the same colours and edge', async ({ page }) => {
    await bookings(page, 390);
    const card = (name: string) => `#tab-queue .queue-mobile-view .q-card:has-text("${name}")`;
    for (const [name, colour] of [['Waiting Rider', 'rgb(255, 255, 255)'], ['On The Bike', 'rgb(254, 246, 220)'], ['Done Paid', 'rgb(220, 252, 231)'], ['No Show Rider', 'rgb(254, 226, 226)']]) {
      expect(await bg(page, card(name)), name).toBe(colour);
      expect(await page.locator(card(name)).first().evaluate((el) => getComputedStyle(el).boxShadow), name).toContain('inset');
    }
  });
});
