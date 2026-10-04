import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A Petromin check-in is the booking's check-in too (2026-09-25). Checking a registered rider
// in moves their linked booking to Active: on the bike held for it, else the free bike that
// fits best (the booking's type, or the rider's own when the booking says Any; the size nearest
// their height; a carbon frame for Road Carbon), else with no bike. Return, Undo check-in and
// Undo return move the booking the same way. A registration with no booking is stamped alone.

const PW = '2099-02-11-pw';
const sessions = [
  { id: PW, day: 'Wednesday', session_date: '2099-02-11', capacity: 35, status: 'open', created_at: 2, bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 35 }), event_kind: 'community', ride_kind: 'petromin', paid_ride: true, title: "Petromin's Wednesdays" },
];
const bikes = [
  { id: 'b1', name: 'Road 01', type: 'Road', size: 'M', status: 'available', frame_type: 'Aluminium' },
  { id: 'b2', name: 'Road 02', type: 'Road', size: 'L', status: 'available', frame_type: 'Aluminium' },
  { id: 'b3', name: 'Hybrid 03', type: 'Hybrid', size: 'S', status: 'available' },
  { id: 'b4', name: 'Mountain 04', type: 'Mountain', size: 'M', status: 'available' },
  { id: 'b5', name: 'Road 05', type: 'Road', size: 'M', status: 'available', frame_type: 'Carbon' },
  { id: 'b6', name: 'Hybrid 06', type: 'Hybrid', size: 'M', status: 'in-use' },
];
const row = (id: string, qn: number, name: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: PW, session_day: 'Wednesday', session_date: '2099-02-11', queue_num: qn, name, phone: '0551112222',
  customer_id: null, group_id: null, status, paid: false, price: 50, walk_in: true, type_preference: 'Road',
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});
const queue_entries = [
  row('q1', 1, 'Tall Road', 'waiting'),
  row('q2', 2, 'Any Booker', 'waiting', { type_preference: 'Any' }),
  row('q3', 3, 'Held Rider', 'waiting', { assigned_bike_id: 'b1' }),
  row('q4', 4, 'Own Rider', 'waiting', { type_preference: 'Own' }),
  row('q5', 5, 'Carbon Rider', 'waiting', { type_preference: 'Road Carbon', price: 250 }),
  row('q6', 6, 'On The Road', 'active', { type_preference: 'Hybrid', assigned_bike_id: 'b6' }),
  row('q7', 7, 'Back Already', 'done', { type_preference: 'Mountain', assigned_bike_id: 'b4' }),
  row('q8', 8, 'Party Lead', 'waiting'),
  row('q9', 9, 'Party Guest', 'waiting'),
];
const reg = (id: number, name: string, entry: string | null, extra: Record<string, unknown> = {}) => ({
  id, source: 'petromin', session_id: PW, booking_no: `P-${String(id).padStart(3, '0')}`, party_no: 1, badge: `B-${id}`, name, phone: '+966500000011',
  company: 'Petromin', height: 175, type_preference: 'Road', matched_entry_id: entry, matched_customer_id: null, match_kind: entry ? 'booking' : 'none',
  submissions: 1, price: null, checked_in_at: null, checked_in_by: null, checked_out_at: null, checked_out_by: null,
  created_at: '2099-02-10T09:00:00Z', updated_at: '2099-02-10T09:00:00Z', ...extra,
});
const rider_registrations = [
  reg(1, 'Tall Road', 'q1', { height: 185 }),
  reg(2, 'Any Booker', 'q2', { type_preference: 'Hybrid', height: 160 }),
  reg(3, 'Held Rider', 'q3'),
  reg(4, 'Own Rider', 'q4', { type_preference: 'Own' }),
  reg(5, 'Carbon Rider', 'q5', { type_preference: 'Road Carbon' }),
  reg(6, 'On The Road', 'q6', { type_preference: 'Hybrid', checked_in_at: '2099-02-11T16:00:00Z' }),
  reg(7, 'Back Already', 'q7', { type_preference: 'Mountain', checked_in_at: '2099-02-11T16:00:00Z', checked_out_at: '2099-02-11T17:00:00Z' }),
  reg(8, 'Party Lead', 'q8', { booking_no: 'P-008' }),
  { ...reg(9, 'Party Guest', 'q9'), booking_no: 'P-008', party_no: 2 },
  reg(10, 'Form Only', null),
];

type Call = { url: string; body: Record<string, unknown> };
async function desk(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, {
    sessions, bikes, queue_entries, rider_registrations,
    'rpc:staff_checkin': { ok: true, noop: false }, 'rpc:staff_return': { ok: true }, ...fixtures,
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`(async()=>{S._staffAuthed=true;await loadData();await loadRiders();})()`);
  const rpc: Call[] = [], patch: Call[] = [];
  page.on('request', (r) => {
    let body: Record<string, unknown> = {};
    try { body = r.postDataJSON() ?? {}; } catch { /* not JSON */ }
    if (r.url().includes('/rest/v1/rpc/staff_')) rpc.push({ url: r.url(), body });
    else if (r.method() === 'PATCH') patch.push({ url: r.url(), body });
  });
  return { rpc, patch };
}
const checkins = (rpc: Call[]) => rpc.filter((c) => c.url.includes('staff_checkin')).map((c) => `${c.body.p_booking_id}:${c.body.p_bike_id}`);
const onTable = (patch: Call[], table: string, id: string) => patch.filter((c) => c.url.includes(`/rest/v1/${table}?`) && c.url.includes(`id=eq.${id}`));

test('checking a rider in moves their booking to Active on the free bike of its type nearest their size', async ({ page }) => {
  const { rpc, patch } = await desk(page);
  await page.evaluate(`riderCheckin(1)`);
  await expect.poll(() => checkins(rpc)).toEqual(['q1:b2']); // 185 cm is an L; b1 is held for someone else
  expect(onTable(patch, 'rider_registrations', '1')[0].body.checked_in_at).toBeTruthy();
});

test('a booking that says Any takes the rider\'s own type, sized to their height', async ({ page }) => {
  const { rpc } = await desk(page);
  await page.evaluate(`riderCheckin(2)`);
  await expect.poll(() => checkins(rpc)).toEqual(['q2:b3']); // Hybrid, and 160 cm sits nearest the S
});

test('the bike held for the booking is the one handed over', async ({ page }) => {
  const { rpc } = await desk(page);
  await page.evaluate(`riderCheckin(3)`);
  await expect.poll(() => checkins(rpc)).toEqual(['q3:b1']);
});

test('Road Carbon goes out on a carbon frame', async ({ page }) => {
  const { rpc } = await desk(page);
  await page.evaluate(`riderCheckin(5)`);
  await expect.poll(() => checkins(rpc)).toEqual(['q5:b5']);
});

test('an own bike checks the booking in without one, and says nothing about bikes', async ({ page }) => {
  const { rpc, patch } = await desk(page);
  await page.evaluate(`riderCheckin(4)`);
  // in without a bike: staff_checkin with none named (2026-10-04)
  await expect.poll(() => checkins(rpc)).toEqual(['q4:null']);
  expect(onTable(patch, 'queue_entries', 'q4')).toEqual([]);
  await page.waitForTimeout(300);
  await expect(page.getByText('checked in without a bike')).toHaveCount(0);
});

test('with no bike of the type free, the booking goes Active without one and the desk is told', async ({ page }) => {
  const { rpc, patch } = await desk(page, { bikes: bikes.map((b) => (b.type === 'Road' ? { ...b, status: 'in-use' } : b)) });
  await page.evaluate(`riderCheckin(1)`);
  await expect.poll(() => checkins(rpc)).toEqual(['q1:null']); // no bike named: in without one (2026-10-04)
  expect(onTable(patch, 'queue_entries', 'q1')).toEqual([]);
  await expect(page.getByText('checked in without a bike')).toBeVisible();
});

test('a party checked in together gets a different bike each', async ({ page }) => {
  const { rpc } = await desk(page);
  await page.evaluate(`riderCheckinParty(8)`);
  await expect.poll(() => checkins(rpc)).toHaveLength(2);
  const [a, b] = checkins(rpc);
  expect(a.split(':')[0]).toBe('q8');
  expect(b.split(':')[0]).toBe('q9');
  expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
});

test('returning a rider returns their booking, and undoing it puts them back on the bike', async ({ page }) => {
  const { rpc, patch } = await desk(page);
  await page.evaluate(`riderReturn(6)`);
  await expect.poll(() => rpc.filter((c) => c.url.includes('staff_return')).map((c) => c.body.p_booking_id)).toEqual(['q6']);
  await page.evaluate(`riderUndoReturn(7)`);
  await expect.poll(() => onTable(patch, 'queue_entries', 'q7').map((c) => c.body.status)).toContain('active');
  expect(onTable(patch, 'rider_registrations', '7')[0].body).toMatchObject({ checked_out_at: null });
});

test('undoing a check-in puts the booking back to Waiting and frees its bike', async ({ page }) => {
  const { patch } = await desk(page);
  await page.evaluate(`riderUndoCheckin(6)`);
  await expect.poll(() => onTable(patch, 'queue_entries', 'q6').map((c) => c.body.status)).toContain('waiting');
  await expect.poll(() => onTable(patch, 'bikes', 'b6').map((c) => c.body.status)).toContain('available');
});

test('a registration with no booking is stamped alone', async ({ page }) => {
  const { rpc, patch } = await desk(page);
  await page.evaluate(`riderCheckin(10)`);
  await expect.poll(() => onTable(patch, 'rider_registrations', '10').length).toBe(1);
  expect(checkins(rpc)).toEqual([]);
  expect(patch.filter((c) => c.url.includes('/rest/v1/queue_entries?'))).toEqual([]);
});
