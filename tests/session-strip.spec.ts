import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The session strip sizes each chip from its content. The Saturday ride is the long one —
// it shows two labelled times ("Gathering 5:45 AM · Start 6 AM") where every other session
// shows a plain window — and its date line used to be nowrap with no overflow rule, so it
// ran straight over the status badge sitting next to it.
// Since the staff panel tidy (2026-10-27) the chips are one grid of equal cards, 220px at the least, so that
// line wraps: it may take the lines it needs, but none of it may be cut off, sideways or under a clamped line.

const sessions = [
  { id: '2026-09-05', session_date: '2026-09-05', day: 'Saturday', status: 'open', capacity: 130, created_at: 5,
    event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false,
    spots: 130, bike_slots: '{"_time":"05:45 - 06:00","_total":130}' },
  { id: '2026-09-06', session_date: '2026-09-06', day: 'Sunday', status: 'open', capacity: 120, created_at: 4,
    bike_slots: '{"_time":"21:00 - 23:00","_total":120}' },
  { id: '2026-09-08', session_date: '2026-09-08', day: 'Tuesday', status: 'open', capacity: 120, created_at: 3,
    bike_slots: '{"_time":"21:00 - 23:00","_total":120}' },
  { id: '2026-09-09-pw', session_date: '2026-09-09', day: 'Wednesday', status: 'open', capacity: 20, created_at: 2,
    event_kind: 'community', ride_kind: 'petromin', needs_approval: false, paid_ride: true,
    bike_slots: '{"_time":"19:00 - 21:00","_total":20}' },
  { id: '2026-09-10', session_date: '2026-09-10', day: 'Thursday', status: 'open', capacity: 20, created_at: 1,
    event_kind: 'community', ride_kind: 'swim', needs_approval: true, hide_queue: true, paid_ride: false,
    spots: 20, bike_slots: '{"_time":"17:00 - 19:00","_total":20}' },
];

async function strip(page: import('@playwright/test').Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`allSessions().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='sessions';renderStaffQueue();S.queueView='bookings';renderStaffQueue()`);
  await page.waitForTimeout(300);
}

/** Chips whose text is wider than its box AND allowed to paint outside it. */
async function overlaps(page: import('@playwright/test').Page) {
  return page.evaluate(`(()=>{
    const out=[];
    document.querySelectorAll('.sess-summary-chip .sess-chip-date, .sess-summary-chip .sess-chip-counts')
      .forEach(el=>{
        const spills = el.scrollWidth > el.clientWidth + 1;
        const escapes = getComputedStyle(el).overflowX === 'visible';
        if(spills && escapes) out.push(el.textContent.trim());
      });
    return out;
  })()`) as Promise<string[]>;
}

for (const width of [1900, 1440, 1280, 1024, 820]) {
  test(`no chip text runs under its status badge at ${width}px`, async ({ page }) => {
    await strip(page, width);
    expect(await overlaps(page)).toEqual([]);
  });
}

test('@staff:bookings the long Saturday line is shown in full when there is room', async ({ page }) => {
  await strip(page, 1900);
  const date = page.locator('.sess-summary-chip', { hasText: 'SATURDAY' }).locator('.sess-chip-date');
  await expect(date).toContainText('Gathering');
  await expect(date).toContainText('Start');
  // and it is not merely overflowing its box to manage it, nor wrapped onto a line a clamp hides
  const clipped = await date.evaluate((el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
  expect(clipped).toBe(false);
});

test('a chip left alone on a wrapped row does not stretch the whole width', async ({ page }) => {
  await strip(page, 1280);
  const widths = await page.evaluate(
    `Array.from(document.querySelectorAll('.sess-summary-chip')).map(c=>c.getBoundingClientRect().width)`) as number[];
  for (const w of widths) expect(w).toBeLessThanOrEqual(461);
});
