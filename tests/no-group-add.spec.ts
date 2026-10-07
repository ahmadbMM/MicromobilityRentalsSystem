import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The owner, 2026-10-07: "remove the add group button from saturday and run for her", then "from triathlon
// pool session too". A Saturday ride, Run for Her and the Triathlon Pool Session take riders one at a time:
// the roster's Add group is not on their page, its ride list leaves them out, and the Add rider
// dialog offers no Group there. Every other ride keeps them.

const NIGHT = '2099-05-01';
const SAT = '2099-05-02';
const RUN = '2099-05-03-rh';
const PW = '2099-05-06-pw';
const POOL = '2099-05-04-sw';
const EV = '2099-05-07-ev';
const slots = '{"_time":"19:00 - 21:00"}';
const sessions = [
  { id: NIGHT, day: 'Friday', session_date: NIGHT, capacity: 12, status: 'open', created_at: 1, bike_slots: slots },
  { id: SAT, day: 'Saturday', session_date: SAT, capacity: 20, status: 'open', created_at: 2, event_kind: 'community', ride_kind: 'saturday', needs_approval: true, spots: 20, bike_slots: slots },
  { id: RUN, day: 'Saturday', session_date: '2099-05-03', capacity: 50, status: 'open', created_at: 3, event_kind: 'community', ride_kind: 'runher', needs_approval: false, bike_slots: slots },
  { id: POOL, day: 'Sunday', session_date: '2099-05-04', capacity: 12, status: 'open', created_at: 5, event_kind: 'community', ride_kind: 'swim', needs_approval: false, bike_slots: slots },
  { id: EV, day: 'Thursday', session_date: '2099-05-07', capacity: 20, spots: 20, status: 'open', created_at: 6, event_kind: 'community', ride_kind: 'event', title: 'Class', needs_approval: false, bike_slots: slots },
  { id: PW, day: 'Wednesday', session_date: '2099-05-06', capacity: 10, status: 'open', created_at: 4, event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false, bike_slots: slots },
];
const customers = [{ id: 'c1', name: 'Amal Member', created_at: '2026-01-01T00:00:00Z' }, { id: 'c2', name: 'Badr Member', created_at: '2026-01-01T00:00:00Z' }];

async function boot(page: Page, queue_entries: Record<string, unknown>[] = []) {
  await stubSupabase(page, { sessions, customers, bikes: [], queue_entries, tags: [], customer_tags: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
}
const show = (page: Page, sid: string) =>
  page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession=${JSON.stringify(sid)};renderStaffQueue()`);
const addGroup = (page: Page) => page.locator('#tab-queue .section-header button', { hasText: 'Add group' });

test.describe('@staff:bookings no group add on a Saturday ride, Run for Her or the pool session', () => {
  test('the roster offers Add group on a circuit night and on all sessions, not on a Saturday ride, Run for Her or the pool session', async ({ page }) => {
    await boot(page);
    await show(page, NIGHT);
    await expect(addGroup(page)).toHaveCount(1);
    await show(page, SAT);
    await expect(addGroup(page)).toHaveCount(0);
    await show(page, RUN);
    await expect(addGroup(page)).toHaveCount(0);
    await show(page, POOL);
    await expect(addGroup(page)).toHaveCount(0);
    await show(page, 'all');
    await expect(addGroup(page)).toHaveCount(1);
  });

  test('the group dialog lists none of them', async ({ page }) => {
    await boot(page);
    await show(page, 'all');
    await page.evaluate(`showJccGroupModal()`);
    const ids = await page.locator('#jg-sess option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(ids).toContain(NIGHT);
    expect(ids).toContain(PW);
    expect(ids).not.toContain(SAT);
    expect(ids).not.toContain(RUN);
    expect(ids).not.toContain(POOL);
  });

  test('Add rider has no Group on a Saturday ride, Run for Her or the pool session, and a Group picked elsewhere ends on switching to one', async ({ page }) => {
    await boot(page);
    await show(page, EV);
    await page.evaluate(`showCommAddModal()`);
    const toggles = page.locator('#comm-add-modal .cmy-ca-toggles');
    await expect(toggles).toHaveCount(1); // a ticketed event keeps its Group (Petromin takes no Add rider since 2026-10-07)
    await page.evaluate(`_on_caGroup(true)`);
    expect(await page.evaluate('S._caGroup')).toBe(true);
    await page.evaluate(`_on_caSess(${JSON.stringify(SAT)})`);
    await expect(toggles).toHaveCount(0);
    expect(await page.evaluate('S._caGroup')).toBe(false);
    await page.evaluate(`_on_caSess(${JSON.stringify(RUN)})`);
    await expect(toggles).toHaveCount(0);
    await page.evaluate(`_on_caSess(${JSON.stringify(POOL)})`);
    await expect(toggles).toHaveCount(0);
  });

  // The owner, 2026-10-07: "yes" to removing the booking editor's Add riders on a Run for Her booking (added runners
  // got no distance) - the same rule as Add group, so on a Saturday ride and the pool session too.
  const bk = (id: string, sid: string, date: string, extra: Record<string, unknown> = {}) => ({
    id, session_id: sid, session_day: 'Saturday', session_date: date, queue_num: 1, name: 'Amal Member', customer_id: 'c1',
    phone: '0550000001', type_preference: 'Any', status: 'waiting', paid: false, price: 0, registered_at: '2099-01-01T10:00:00Z', ...extra,
  });
  const addRider = (page: Page) => page.locator('#booking-edit-modal button', { hasText: 'Add rider' });

  test('the booking editor offers no Add riders on a Run for Her booking, and drops riders typed for another ride on switching to one', async ({ page }) => {
    await boot(page, [bk('q-run', RUN, '2099-05-03', { type_preference: 'None', run_km: 5 }), bk('q-night', NIGHT, NIGHT, { name: 'Night Rider', customer_id: 'c2', price: 75 })]);
    await page.waitForFunction('S.dataLoaded===true');
    await page.evaluate(`showBookingEditModal('q-run')`);
    await expect(page.locator('#booking-edit-modal [role="dialog"]')).toBeVisible();
    await expect(addRider(page)).toHaveCount(0);
    await page.evaluate(`closeBookingEditModal();showBookingEditModal('q-night')`);
    await expect(addRider(page)).toHaveCount(1);
    await page.evaluate(`_beAddRider()`);
    await page.fill('#be-nr-name-0', 'Sara Ali');
    await page.selectOption('#be-sess', RUN);                       // the ride picked decides what the form offers
    await expect(addRider(page)).toHaveCount(0);
    expect(await page.evaluate('(S._beNewRiders||[]).length')).toBe(0);
  });

  test('the Staff List add-rider opens the editor without a rider row on such a booking', async ({ page }) => {
    await boot(page, [bk('q-sat', SAT, SAT)]);
    await page.waitForFunction('S.dataLoaded===true');
    await page.evaluate(`mwAddRider('q-sat')`);
    await expect(page.locator('#booking-edit-modal [role="dialog"]')).toBeVisible();
    await expect(addRider(page)).toHaveCount(0);
    expect(await page.evaluate('(S._beNewRiders||[]).length')).toBe(0);
  });
});
