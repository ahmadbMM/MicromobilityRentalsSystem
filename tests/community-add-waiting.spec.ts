import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// "Add rider to the social ride": on a Saturday (approval) ride the second destination is Waiting,
// not the waitlist - the rider is added with status waiting, a place and a number, and the
// selection still to come (approval pending); Final list approves at once. A ride without an
// approval flow has one list and no toggle. All Supabase traffic is stubbed.

const LIVE = '2099-03-01', COMM = '2099-03-07';
const sess = (id: string, extra: Record<string, unknown> = {}) => ({
  id, day: id === COMM ? 'Saturday' : 'Sunday', session_date: id, status: 'open', capacity: 20, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...extra,
});
const saturday = sess(COMM, { event_kind: 'community', ride_kind: 'saturday', needs_approval: true, spots: 20 });
const customers = [{ id: 'c1', name: 'Amal Member', created_at: '2026-01-01T00:00:00Z' }];

async function boot(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions: [sess(LIVE), saturday], queue_entries: [], bikes: [], tags: [], customer_tags: [], customers, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
}
function inserts(page: Page) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !/\/rest\/v1\/queue_entries(\?|$)/.test(r.url())) return;
    try { const b = r.postDataJSON(); out.push(...(Array.isArray(b) ? b : [b])); } catch { /* not json */ }
  });
  return out;
}
const dest = (page: Page, label: string) => page.locator('#comm-add-modal .toggle-btn', { hasText: label });

test('Waiting adds the rider waiting, with a number and the selection pending', async ({ page }) => {
  await boot(page);
  const rows = inserts(page);
  await page.evaluate(`S.sfSession=${JSON.stringify(COMM)};showCommAddModal()`);
  await expect(dest(page, 'Waiting')).toHaveCount(1);
  await expect(dest(page, 'Waitlist')).toHaveCount(0);
  await dest(page, 'Waiting').click();
  await expect(dest(page, 'Waiting')).toHaveClass(/active/);
  await page.evaluate(`S._caSel='c1';_saveCommAdd()`);
  await expect.poll(() => rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ session_id: COMM, customer_id: 'c1', status: 'waiting', approval: 'pending' });
  expect(rows[0].waitlist_num ?? null).toBeNull();
  expect(typeof rows[0].queue_num).toBe('number');
});

test('Final list approves at once; a ride without approval shows no destination toggle', async ({ page }) => {
  // a ticketed event: no approval (circuit and Petromin nights take no Add rider since 2026-10-07)
  const EV = '2099-03-02';
  await boot(page, { sessions: [sess(LIVE), saturday, sess(EV, { event_kind: 'community', ride_kind: 'event', title: 'Class', needs_approval: false, spots: 20 })] });
  const rows = inserts(page);
  await page.evaluate(`S.sfSession=${JSON.stringify(COMM)};showCommAddModal()`);
  await expect(dest(page, 'Final list')).toHaveClass(/active/);
  await page.evaluate(`S._caSel='c1';_saveCommAdd()`);
  await expect.poll(() => rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ status: 'waiting', approval: 'approved' });
  await page.selectOption('#comm-add-modal select', EV);
  await expect(dest(page, 'Final list')).toHaveCount(0);
  await expect(dest(page, 'Waiting')).toHaveCount(0);
});

test('a rider staff put on the house is added on the house to a paid ride, as from every other add; the others pay', async ({ page }) => {
  // A rider on the house, added to Petromin Wednesday from this dialog on 2026-09-29, was left owing 57.50. Petromin
  // takes no Add rider since 2026-10-07, so a paid event stands in for it.
  const PW = '2099-03-04';
  const petromin = sess(PW, { day: 'Wednesday', event_kind: 'community', ride_kind: 'event', title: 'Paid class', paid_ride: true, price: 57.5, needs_approval: false, spots: 20 });
  await boot(page, {
    sessions: [sess(LIVE), saturday, petromin],
    customers: [
      { id: 'h1', name: 'House Rider', default_pay: 'house', type_preference: 'Any', created_at: '2026-01-01T00:00:00Z' },
      { id: 'p1', name: 'Paying Rider', default_pay: null, type_preference: 'Road', created_at: '2026-01-01T00:00:00Z' },
      { id: 'r1', name: 'Road Only', default_pay: 'house:Road', type_preference: 'Hybrid', created_at: '2026-01-01T00:00:00Z' },
    ],
  });
  const rows = inserts(page);
  await page.evaluate(`S.sfSession=${JSON.stringify(PW)};showCommAddModal()`);
  for (const id of ['h1', 'p1', 'r1']) await page.evaluate(`S._caSel='${id}';_saveCommAdd()`);
  await expect.poll(() => rows.length).toBe(3);
  const by = (id: string) => rows.find((r) => r.customer_id === id)!;
  expect(by('h1')).toMatchObject({ session_id: PW, paid: true, price: 0 });
  expect(by('p1').paid).toBe(false);
  expect(Number(by('p1').price)).toBeGreaterThan(0);
  expect(by('r1').paid).toBe(false); // on the house for Road only; booked as a Hybrid
  // A group: each member on their own account's terms.
  rows.length = 0;
  await page.evaluate(`S._caGroup=true;S._caSelArr=['h1','p1'];_saveCommAdd()`);
  await expect.poll(() => rows.length).toBe(2);
  expect(by('h1')).toMatchObject({ paid: true, price: 0 });
  expect(by('p1').paid).toBe(false);
});
