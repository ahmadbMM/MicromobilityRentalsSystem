import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Front desk 2026-10-09 (s1009-desk), B4: a Petromin check-in hands over the bike staff can see. The rider
// pop-up names the bike the check-in will give (staff's pick, the one held, else the best fit) with a
// field to change it by number, and the Riders table has a Bike column. Invented riders and bikes only.

const PW = '2099-02-11-pw';
const sessions = [
  { id: PW, day: 'Wednesday', session_date: '2099-02-11', capacity: 35, status: 'open', created_at: 2, bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 35 }), event_kind: 'community', ride_kind: 'petromin', paid_ride: true, title: "Petromin's Wednesdays" },
];
const bikes = [
  { id: 'b1', name: 'Road 01', bike_number: 1, type: 'Road', size: 'M', status: 'available', frame_type: 'Aluminium' },
  { id: 'b2', name: 'Road 02', bike_number: 2, type: 'Road', size: 'L', status: 'available', frame_type: 'Aluminium' },
  { id: 'b3', name: 'Road 03', bike_number: 3, type: 'Road', size: 'M', status: 'in-use', frame_type: 'Aluminium' },
];
const queue_entries = [{
  id: 'q1', session_id: PW, session_day: 'Wednesday', session_date: '2099-02-11', queue_num: 1, name: 'Tall Road', phone: '0551112222',
  customer_id: null, group_id: null, status: 'waiting', paid: false, price: 50, walk_in: true, type_preference: 'Road', registered_at: '2099-01-01T10:00:00Z',
}];
const rider_registrations = [{
  id: 1, source: 'petromin', session_id: PW, booking_no: 'P-001', party_no: 1, badge: 'B-1', name: 'Tall Road', phone: '+966500000011',
  company: 'Petromin', height: 185, type_preference: 'Road', matched_entry_id: 'q1', matched_customer_id: null, match_kind: 'booking',
  submissions: 1, price: null, checked_in_at: null, checked_in_by: null, checked_out_at: null, checked_out_by: null,
  created_at: '2099-02-10T09:00:00Z', updated_at: '2099-02-10T09:00:00Z',
}];

async function desk(page: Page) {
  await stubSupabase(page, { sessions, bikes, queue_entries, rider_registrations, 'rpc:staff_checkin': { ok: true, noop: false }, 'rpc:staff_resolve_bike': { found: false } });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`(async()=>{S._staffAuthed=true;await loadData();await loadRiders();})()`);
  const checkins: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.url().includes('/rest/v1/rpc/staff_checkin')) { try { checkins.push(r.postDataJSON()); } catch { /* none */ } } });
  return checkins;
}

test.describe('@staff:petromin s1009 desk: the bike on a Petromin check-in', () => {
  test('the pop-up names the bike the check-in will give; a typed number changes it and the check-in hands that one over', async ({ page }) => {
    const checkins = await desk(page);
    await page.evaluate('openRiderModal(1)');
    const m = page.locator('#rider-modal');
    await expect(m.locator('#rider-bike-now')).toContainText('#002'); // 185 cm: the Road L
    // a bike that is out is refused, the pick stays
    await m.locator('#rider-bike-in').fill('3');
    await m.locator('#rider-bike-in').press('Enter');
    await expect(m.locator('#rider-bike-now')).toContainText('#002');
    await m.locator('#rider-bike-in').fill('1');
    await m.getByRole('button', { name: 'Change bike' }).click();
    await expect(m.locator('#rider-bike-now')).toContainText('#001');
    await m.locator('#rider-checkin').click();
    await expect.poll(() => checkins.length).toBeGreaterThan(0);
    expect(checkins[0]).toMatchObject({ p_booking_id: 'q1', p_bike_id: 'b1' });
  });

  test('the Riders table has a Bike column showing the bike picked, opening the pop-up', async ({ page }) => {
    await desk(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='petromin';renderStaffQueue();_riderPick['1']='b1';renderRiders()`);
    const host = page.locator('#pm-host');
    await expect(host.locator('thead')).toContainText('Bike');
    const cell = host.locator('.rider-bike-btn');
    await expect(cell).toContainText('#001');
    await cell.click();
    await expect(page.locator('#rider-modal #rider-bike-now')).toContainText('#001');
  });
});
