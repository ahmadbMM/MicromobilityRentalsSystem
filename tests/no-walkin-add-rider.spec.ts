import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The owner, 2026-10-07: "remove the walk in button from triathlon pool session saturday social ride and run for her,
// and remove add rider from petromin and jcc sessions". On those rides the roster's button is gone (and the phone's
// walk-in button), and neither dialog offers them in its ride list; the other rides keep both.

const NIGHT = '2099-05-01', SAT = '2099-05-02', RUN = '2099-05-03-rh', POOL = '2099-05-04-sw', PW = '2099-05-06-pw', EV = '2099-05-07-ev';
const slots = '{"_time":"19:00 - 21:00"}';
const comm = (id: string, date: string, kind: string, x: Record<string, unknown> = {}) => ({ id, day: 'Saturday', session_date: date, capacity: 20, spots: 20, status: 'open', created_at: 2, event_kind: 'community', ride_kind: kind, needs_approval: false, bike_slots: slots, ...x });
const sessions = [
  { id: NIGHT, day: 'Friday', session_date: NIGHT, capacity: 12, status: 'open', created_at: 1, bike_slots: slots },
  comm(SAT, SAT, 'saturday', { needs_approval: true }), comm(RUN, '2099-05-03', 'runher'), comm(POOL, '2099-05-04', 'swim'),
  comm(PW, '2099-05-06', 'petromin', { paid_ride: true }), comm(EV, '2099-05-07', 'event', { title: 'Class' }),
];

async function boot(page: Page) {
  await stubSupabase(page, { sessions, customers: [{ id: 'c1', name: 'Amal Member', created_at: '2026-01-01T00:00:00Z' }], bikes: [], queue_entries: [], tags: [], customer_tags: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
const show = (page: Page, sid: string) => page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession=${JSON.stringify(sid)};renderStaffQueue()`);
const head = (page: Page, name: string) => page.locator('#tab-queue .section-header button', { hasText: name });

test('Walk-in: not on the pool session, a Saturday ride or Run for Her; Add rider: not on Petromin or a circuit night', async ({ page }, info) => {
  await boot(page);
  for (const [sid, walkin, addRider] of [[NIGHT, 1, 0], [SAT, 0, 1], [RUN, 0, 1], [POOL, 0, 1], [PW, 1, 0], [EV, 1, 1]] as [string, number, number][]) {
    await show(page, sid);
    await expect(head(page, 'Walk-in'), sid).toHaveCount(walkin);
    await expect(head(page, 'Add rider'), sid).toHaveCount(addRider);
    if (info.project.name === 'mobile') await expect(page.locator('#tab-queue .walkin-fab'), sid).toHaveCount(walkin);
  }
  // all sessions: both buttons, and each dialog lists only the rides it may add to
  await show(page, 'all');
  await expect(head(page, 'Walk-in')).toHaveCount(1);
  await expect(head(page, 'Add rider')).toHaveCount(1);
  await page.evaluate(`showWalkinModal()`);
  const wi = await page.locator('#wi-sess option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(wi.sort()).toEqual([NIGHT, PW, EV].sort());
  await page.evaluate(`document.getElementById('walkin-modal').style.display='none'`);
  await page.evaluate(`showCommAddModal()`);
  const ca = await page.locator('#comm-add-modal select option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(ca.sort()).toEqual([SAT, RUN, POOL, EV].sort());
});
