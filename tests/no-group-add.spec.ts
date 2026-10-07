import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The owner, 2026-10-07: "remove the add group button from saturday and run for her". A Saturday ride
// and Run for Her take riders one at a time (each with their own ride group, distance and age check):
// the roster's Add group is not on their page, its ride list leaves them out, and the Add rider
// dialog offers no Group there. Every other ride keeps them.

const NIGHT = '2099-05-01';
const SAT = '2099-05-02';
const RUN = '2099-05-03-rh';
const PW = '2099-05-06-pw';
const slots = '{"_time":"19:00 - 21:00"}';
const sessions = [
  { id: NIGHT, day: 'Friday', session_date: NIGHT, capacity: 12, status: 'open', created_at: 1, bike_slots: slots },
  { id: SAT, day: 'Saturday', session_date: SAT, capacity: 20, status: 'open', created_at: 2, event_kind: 'community', ride_kind: 'saturday', needs_approval: true, spots: 20, bike_slots: slots },
  { id: RUN, day: 'Saturday', session_date: '2099-05-03', capacity: 50, status: 'open', created_at: 3, event_kind: 'community', ride_kind: 'runher', needs_approval: false, bike_slots: slots },
  { id: PW, day: 'Wednesday', session_date: '2099-05-06', capacity: 10, status: 'open', created_at: 4, event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false, bike_slots: slots },
];
const customers = [{ id: 'c1', name: 'Amal Member', created_at: '2026-01-01T00:00:00Z' }, { id: 'c2', name: 'Badr Member', created_at: '2026-01-01T00:00:00Z' }];

async function boot(page: Page) {
  await stubSupabase(page, { sessions, customers, bikes: [], queue_entries: [], tags: [], customer_tags: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
}
const show = (page: Page, sid: string) =>
  page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession=${JSON.stringify(sid)};renderStaffQueue()`);
const addGroup = (page: Page) => page.locator('#tab-queue .section-header button', { hasText: 'Add group' });

test.describe('@staff:bookings no group add on a Saturday ride or Run for Her', () => {
  test('the roster offers Add group on a circuit night and on all sessions, not on a Saturday ride or Run for Her', async ({ page }) => {
    await boot(page);
    await show(page, NIGHT);
    await expect(addGroup(page)).toHaveCount(1);
    await show(page, SAT);
    await expect(addGroup(page)).toHaveCount(0);
    await show(page, RUN);
    await expect(addGroup(page)).toHaveCount(0);
    await show(page, 'all');
    await expect(addGroup(page)).toHaveCount(1);
  });

  test('the group dialog lists neither of them', async ({ page }) => {
    await boot(page);
    await show(page, 'all');
    await page.evaluate(`showJccGroupModal()`);
    const ids = await page.locator('#jg-sess option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(ids).toContain(NIGHT);
    expect(ids).toContain(PW);
    expect(ids).not.toContain(SAT);
    expect(ids).not.toContain(RUN);
  });

  test('Add rider has no Group on a Saturday ride or Run for Her, and a Group picked elsewhere ends on switching to one', async ({ page }) => {
    await boot(page);
    await show(page, PW);
    await page.evaluate(`showCommAddModal()`);
    const toggles = page.locator('#comm-add-modal .cmy-ca-toggles');
    await expect(toggles).toHaveCount(1); // Petromin keeps its Group
    await page.evaluate(`_on_caGroup(true)`);
    expect(await page.evaluate('S._caGroup')).toBe(true);
    await page.evaluate(`_on_caSess(${JSON.stringify(SAT)})`);
    await expect(toggles).toHaveCount(0);
    expect(await page.evaluate('S._caGroup')).toBe(false);
    await page.evaluate(`_on_caSess(${JSON.stringify(RUN)})`);
    await expect(toggles).toHaveCount(0);
  });
});
