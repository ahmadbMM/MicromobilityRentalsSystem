import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-07 (the booking editor, the roster's figures, the account editor's phone).
// - The booking editor asks what the ride the booking goes TO needs: a move onto Run for Her used to
//   be refused for a distance the form never offered (it drew the fields of the booking's own ride).
// - Undo of an edit puts the Saturday ride's group back.
// - "Completed" counts a free ride's finished riders, who are never marked paid.
// - A phone typed with Arabic-Indic digits in the account editor is saved, not wiped.

const JCC = '2099-03-01', RUN = '2099-03-07-rh', SAT = '2099-03-07';
const jcc = { id: JCC, session_date: JCC, day: 'Sunday', status: 'open', capacity: 12, created_at: 1, location: 'JCC',
  bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 12 }) };
const run = { id: RUN, session_date: SAT, day: 'Saturday', status: 'open', capacity: 80, created_at: 1,
  event_kind: 'community', ride_kind: 'runher', needs_approval: false, hide_queue: true, spots: 80, open_to_all: false,
  paid_ride: false, location: 'JYC', bike_slots: '{"_time":"06:00 - 06:30"}' };
const sat = { id: SAT, session_date: SAT, day: 'Saturday', status: 'open', capacity: 30, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: false, paid_ride: false, spots: 30,
  bike_slots: '{"_time":"05:30 - 06:00"}' };
const row = (id: string, sid: string, date: string, qn: number, x: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Sunday', session_date: date, queue_num: qn, name: 'Rider ' + id,
  phone: '0550000000', type_preference: 'Hybrid', size: 'M', status: 'waiting', paid: false, price: 57.5,
  registered_at: '2099-02-01T10:00:00Z', ...x,
});

async function boot(page: Page, queue: Record<string, unknown>[], fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [jcc, run, sat], bikes: [], queue_entries: queue, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded===true');
}
function patches(page: Page, table: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes(`/rest/v1/${table}?`)) {
      try { out.push(r.postDataJSON() || {}); } catch { /* not JSON */ }
    }
  });
  return out;
}

test.describe('@staff:bookings bug hunt Oct 7 (s08)', () => {
  test('a booking moved onto Run for Her is asked its distance, and the move carries it', async ({ page }) => {
    await boot(page, [row('m1', JCC, JCC, 1)]);
    const sent = patches(page, 'queue_entries');
    await page.evaluate(`showBookingEditModal('m1')`);
    const modal = page.locator('#booking-edit-modal [role="dialog"]');
    await expect(modal.locator('.run-km-field')).toHaveCount(0); // a JCC night asks no distance
    await modal.locator('#be-sess').selectOption(RUN);
    await expect(modal.locator('.run-km-field')).toBeVisible(); // the run's own question, once it is the target
    await modal.locator('.run-km-field [data-km="5"]').click();
    await modal.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => sent.find((b) => b.session_id === RUN) || null).toMatchObject({ session_id: RUN, run_km: 5, type_preference: 'None' });
  });

  test('Undo of a move off the Saturday ride gives the booking its group back', async ({ page }) => {
    await boot(page, [row('g1', SAT, SAT, 1, { ride_group: 'beg', price: 0 })]);
    const sent = patches(page, 'queue_entries');
    await page.evaluate(`showBookingEditModal('g1')`);
    const modal = page.locator('#booking-edit-modal [role="dialog"]');
    await expect(modal.locator('.rg-field')).toBeVisible();
    await modal.locator('#be-sess').selectOption(JCC);
    await expect(modal.locator('.rg-field')).toHaveCount(0); // a JCC night has no groups
    await modal.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => sent.find((b) => b.session_id === JCC) || null).toMatchObject({ ride_group: null });
    await page.locator('#topbar-right .undo-btn').click();
    await expect.poll(() => sent.find((b) => b.session_id === SAT) || null).toMatchObject({ ride_group: 'beg' });
  });

  test('Completed counts the finished runners of a free ride', async ({ page }) => {
    const r = (id: string, qn: number, x: Record<string, unknown>) => row(id, RUN, SAT, qn, { type_preference: 'None', size: '', price: 0, run_km: 5, ...x });
    await boot(page, [r('d1', 1, { status: 'done' }), r('d2', 2, { status: 'done' }), r('w3', 3, {})]);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${RUN}';renderStaffQueue()`);
    const done = page.locator('.stat-strip .stat-chip').filter({ hasText: 'Completed' });
    await expect(done.locator('b')).toHaveText('2'); // was 0: nobody on a free ride is ever marked paid
  });

  test('a phone typed in Arabic-Indic digits in the account editor is saved as the number', async ({ page }) => {
    const cust = { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', phone: '+966500000001', height: 165, gender: 'female', type_preference: 'Any', created_at: '2099-01-01T00:00:00Z' };
    // The stub answers every read with the whole table, so the duplicate check finds this account itself:
    // the database's answer on who signs in with the number lets the save through, as it would.
    await boot(page, [], { customers: [cust], 'rpc:staff_phone_accounts': [] });
    const sent = patches(page, 'customers');
    await page.evaluate(`showEditCustomerModal('c1')`);
    await page.locator('#cf-phone').fill('٥٥١٢٣٤٥٦٧');
    await page.evaluate('saveCustForm()');
    await expect.poll(() => sent.find((b) => 'phone' in b) || null).toMatchObject({ phone: '+966551234567' });
  });
});
