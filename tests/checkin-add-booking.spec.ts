import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Two more things the check-in modal's Status section can do (2026-09-28). "Add a booking" chains
// another ticket into this check-in the way Scan several does - one run, steps, the next rider
// opening by itself - as a list held in this tab: nothing is written to group_id, each rider keeps
// their own payment and bike. "To staff list" parks the rider on the Staff Managed Waitlist instead
// of a bike (the row menu's button, from inside the modal) and the run moves on without them.
const A1 = 'a1a1a1a1-0000-4000-8000-000000000001', B2 = 'b2b2b2b2-0000-4000-8000-000000000002';
const E5 = 'e5e5e5e5-0000-4000-8000-000000000005';
const row = (id: string, qn: number, name: string, groupId: string | null, status = 'waiting'): Record<string, unknown> => ({
  id, session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: qn,
  name, phone: '', customer_id: null, group_id: groupId, status, paid: false,
  price: 30, walk_in: true, registered_at: '2099-01-01T10:00:00Z',
});
const q = [
  row(A1, 1, 'Solo Amal', null),
  row(B2, 2, 'Solo Badr', null),
  row('c3c3c3c3-0000-4000-8000-000000000003', 3, 'Party Cala', 'g1'),
  row('d4d4d4d4-0000-4000-8000-000000000004', 4, 'Party Dina', 'g1'),
  row(E5, 5, 'Solo Eid', null),
];
const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];

// The stub serves its fixture rows as given, so a rider re-read after Confirm would come back
// 'waiting' and the run would loop back to them: keep the writes on a fresh copy per test.
async function boot(page: Page, fixtures: Record<string, unknown> = {}) {
  const rows = q.map((r) => ({ ...r }));
  await stubSupabase(page, { queue_entries: rows, sessions, desk_waitlist: [], ...fixtures });
  await page.route(/\/rest\/v1\/queue_entries/, async (route) => {
    const r = route.request();
    if (r.method() === 'PATCH') {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
      const row = rows.find((x) => x.id === id);
      if (row) Object.assign(row, body);
    }
    return route.fallback();
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded===true');
}
const openCheckin = (page: Page, id: string) =>
  page.evaluate(`S.staffTab='queue';renderStaffQueue();showCheckinModal(${JSON.stringify(id)})`);

function watchWrites(page: Page) {
  const patches: Array<{ id: string; body: Record<string, unknown> }> = [];
  const parks: Array<Record<string, unknown>> = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) {
      const id = (r.url().match(/id=eq\.([^&]+)/) || [])[1];
      let body: Record<string, unknown> = {};
      try { body = r.postDataJSON() || {}; } catch { /* not JSON */ }
      if (id) patches.push({ id, body });
    }
    if (r.method() === 'POST' && r.url().includes('/rest/v1/desk_waitlist')) {
      let body: unknown = [];
      try { body = r.postDataJSON(); } catch { /* not JSON */ }
      (Array.isArray(body) ? body : [body]).forEach((b) => parks.push(b as Record<string, unknown>));
    }
  });
  return { patches, parks };
}

test('Add a booking chains other tickets into the run - a party as one line - and the data never learns of a group', async ({ page }) => {
  await boot(page);
  const { patches } = watchWrites(page);
  await openCheckin(page, A1);
  const modal = page.locator('#checkin-modal [role="dialog"]'); // the wrapper has no box
  await expect(modal).toContainText('Solo Amal');
  await expect(modal.getByRole('list')).toHaveCount(0); // a solo rider: no steps yet

  const add = modal.getByRole('button', { name: /Add a booking/ });
  await add.click();
  await expect(add).toHaveAttribute('aria-expanded', 'true');
  const rows = modal.locator('#ci-add-list .mw-sug');
  // Nothing typed: everyone still expected on this ride, in queue order, a party as one line.
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('#2');
  await expect(rows.nth(1)).toContainText('Party Cala');
  await expect(rows.nth(1)).toContainText('+1');
  await expect(rows.nth(2)).toContainText('Solo Eid');

  await modal.locator('#ci-add-q').fill('badr');
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  // One run of two, under the label Scan several uses; the picker stays for the next, Badr gone from it.
  const steps = modal.getByRole('list', { name: 'Riders checking in together' }).getByRole('button');
  await expect(steps).toHaveCount(2);
  await expect(modal).toContainText('Rider 1 of 2');
  await expect(rows).toHaveCount(2);
  // Enter takes the first match; the party ticket brings its other rider along.
  await modal.locator('#ci-add-q').fill('3');
  await modal.locator('#ci-add-q').press('Enter');
  await expect(steps).toHaveCount(4);
  await expect(modal).toContainText('Rider 1 of 4');
  await expect(modal.locator('#ci-money')).toContainText('all SAR 120');

  // Confirm runs them through, the next opening by itself with the picker closed.
  await modal.locator('#ci-confirm').click();
  await expect(modal).toContainText('Solo Badr');
  await expect(modal).toContainText('Rider 2 of 4');
  await expect(modal.locator('#ci-add-box')).toHaveCount(0);
  for (const next of ['Party Cala', 'Party Dina']) {
    await modal.locator('#ci-confirm').click();
    await expect(modal).toContainText(next);
  }
  await modal.locator('#ci-confirm').click();
  await expect(modal).toBeHidden();

  await expect.poll(() => patches.filter((w) => w.body.status === 'active').map((w) => w.id.slice(0, 2)))
    .toEqual(['a1', 'b2', 'c3', 'd4']);
  expect(patches.some((w) => 'group_id' in w.body)).toBe(false); // never grouped in the data
  expect(patches.some((w) => w.id.startsWith('e5'))).toBe(false); // never added, untouched
  await expect.poll(() => page.evaluate('S._ciBatch')).toBeNull(); // the run is over
});

test('To staff list parks the rider from the modal and the run moves on without them', async ({ page }) => {
  await boot(page);
  const { patches, parks } = watchWrites(page);
  await openCheckin(page, A1);
  const modal = page.locator('#checkin-modal [role="dialog"]');
  await modal.getByRole('button', { name: /Add a booking/ }).click();
  await modal.locator('#ci-add-q').fill('badr');
  await modal.locator('#ci-add-list .mw-sug').first().click();
  await expect(modal.getByRole('list', { name: 'Riders checking in together' }).getByRole('button')).toHaveCount(2);

  await modal.getByRole('button', { name: 'To staff list' }).click();
  // One staff-list row for Amal's booking, said so, and the modal is on Badr - alone now.
  await expect.poll(() => parks.length).toBe(1);
  expect(parks[0].booking_id).toBe(A1);
  expect(parks[0].kind).toBe('managed');
  await expect(page.getByText('Solo Amal moved to the staff list')).toBeVisible();
  await expect(modal).toContainText('Solo Badr');
  await expect(modal).not.toContainText('Solo Amal');
  await expect(modal.getByRole('list')).toHaveCount(0);

  await modal.locator('#ci-confirm').click();
  await expect(modal).toBeHidden();
  await expect.poll(() => patches.filter((w) => w.body.status === 'active').map((w) => w.id.slice(0, 2))).toEqual(['b2']);
  expect(patches.some((w) => w.id.startsWith('a1'))).toBe(false); // parked, not checked in
});

test('a rider already on the staff list is not offered it again; a solo rider parked closes the modal', async ({ page }) => {
  await boot(page, {
    desk_waitlist: [{ id: 'w1', name: 'Solo Badr', phone: '', bike_type: 'Road', status: 'waiting', kind: 'managed',
      sort_order: 1, booking_id: B2, author: null, created_at: '2099-01-01T10:00:00Z', resolved_at: null }],
  });
  const { parks } = watchWrites(page);
  await openCheckin(page, B2);
  const modal = page.locator('#checkin-modal [role="dialog"]');
  await expect(modal).toContainText('Solo Badr');
  await expect(modal.getByRole('button', { name: 'To staff list' })).toHaveCount(0);
  await expect(modal.getByRole('button', { name: /Add a booking/ })).toBeVisible();

  await page.evaluate('closeCheckinModal()');
  await openCheckin(page, E5);
  await expect(modal).toContainText('Solo Eid');
  await modal.getByRole('button', { name: 'To staff list' }).click();
  await expect(modal).toBeHidden();
  await expect.poll(() => parks.map((p) => p.booking_id)).toEqual([E5]);
  await expect.poll(() => page.evaluate('S._ciId')).toBeNull();
});
