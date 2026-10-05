import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The Petromin desk, 2026-10-05 (bug audit, slice rc1): a party moves to another night only through
// staff_rider_party_move (a database without it refuses the move and says why), and entering a walk-in
// again for a party already on the night keeps each companion's booking and cancels a dropped one's.

const S1 = '2099-02-08-pw';
const S2 = '2099-02-15-pw';
const sess = (id: string, date: string) => ({
  id, day: 'Wednesday', session_date: date, capacity: 35, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 35 }), location: 'JCC', addons: null,
  event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false, hide_queue: false, title: 'Petromin night',
});
const sessions = [sess(S1, '2099-02-08'), sess(S2, '2099-02-15')];
const qe = (id: string, name: string, num: number, extra: Record<string, unknown> = {}) => ({
  id, session_id: S1, session_day: 'Wednesday', session_date: '2099-02-08', queue_num: num, name, phone: '',
  customer_id: null, type_preference: 'Hybrid', status: 'waiting', paid: false, price: 60, registered_at: '2099-01-01T10:00:00Z', ...extra,
});
const base = { source: 'petromin', session_id: S1, company: 'Petromin', badge: 'A-12', phone: '+966500000001', created_at: '2099-02-08T09:00:00Z', updated_at: '2099-02-08T09:00:00Z', price: null, checked_in_at: null, checked_out_at: null, checked_in_by: null, checked_out_by: null, submissions: 1, match_kind: 'booking', matched_customer_id: null };
const party = () => [
  { ...base, id: 1, booking_no: 'P-001', party_no: 1, name: 'Amal Booked', height: 170, type_preference: 'Hybrid', matched_entry_id: 'e1' },
  { ...base, id: 4, booking_no: 'P-001', party_no: 2, name: 'Amal Friend', height: 150, type_preference: 'Hybrid', matched_entry_id: 'e4' },
  { ...base, id: 5, booking_no: 'P-001', party_no: 3, name: 'Amal Cousin', height: 168, type_preference: 'Hybrid', matched_entry_id: 'e5' },
];
const bookings = [qe('e1', 'Amal Booked', 7, { phone: '+966500000001' }), qe('e4', 'Amal Friend', 8), qe('e5', 'Amal Cousin', 9)];

type W = { m: string; url: string; body: unknown };
async function boot(page: Page, fx: Fixtures, regs: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions, queue_entries: bookings, ...fx });
  // the registrations as the server holds them, so a reload after rider_register reads what it left
  await page.route(/\/rest\/v1\/rider_registrations/, (r) => (r.request().method() === 'GET'
    ? r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json', 'content-range': `0-${regs.length}/${regs.length}` }, body: JSON.stringify(regs) })
    : r.fallback()));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('riders')`);
  await page.waitForFunction('S.ridersLoaded===true');
  const out: W[] = [];
  page.on('request', (r) => {
    const m = r.method();
    if (m === 'GET' || m === 'OPTIONS' || !/rest\/v1\/(rider_registrations|queue_entries|rpc\/)/.test(r.url())) return;
    let body: unknown = null;
    try { body = r.postDataJSON(); } catch { /* none */ }
    out.push({ m, url: decodeURIComponent(r.url()), body });
  });
  return out;
}
const tableWrites = (w: W[]) => w.filter((x) => /rest\/v1\/(rider_registrations|queue_entries)/.test(x.url));

test.describe('@staff:bookings Petromin party move', () => {
  test('a database without staff_rider_party_move refuses the move, says why, and writes nothing', async ({ page }) => {
    const w = await boot(page, { 'rpc:staff_rider_party_move': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_rider_party_move in the schema cache' } } }, party());
    await page.evaluate('showRiderEdit(1)');
    await page.selectOption('#rw-session', S2);
    await page.click('#rw-submit');
    await expect(page.locator('#rw-err')).toContainText('database update');
    await expect(page.locator('#rider-walkin-modal .modal-box')).toBeVisible();
    await page.waitForTimeout(200);
    expect(tableWrites(w)).toEqual([]); // session_id is never written from the page
  });

  test("the function's refusal is said in the form's own words", async ({ page }) => {
    const w = await boot(page, { 'rpc:staff_rider_party_move': { ok: false, error: 'checked_in' } }, party());
    await page.evaluate('showRiderEdit(1)');
    await page.selectOption('#rw-session', S2);
    await page.click('#rw-submit');
    await expect(page.locator('#rw-err')).toContainText('already on a bike');
    expect(w.filter((x) => x.url.includes('staff_rider_party_move'))).toHaveLength(1);
    expect(tableWrites(w)).toEqual([]);
  });
});

test.describe('@staff:bookings Petromin walk-in again', () => {
  test("a party entered again keeps its companions' bookings and cancels the one it left off", async ({ page }) => {
    const regs = party();
    const w = await boot(page, { 'rpc:rider_register': { ok: true, id: 1, booking_no: 'P-001', resubmitted: true, match: 'booking', riders: 2 } }, regs);
    // rider_register deletes a companion a resubmission leaves off (party_no 3 here)
    page.on('request', (r) => { if (r.url().includes('/rpc/rider_register')) { const i = regs.findIndex((x) => x.id === 5); if (i >= 0) regs.splice(i, 1); } });
    await page.evaluate('showRiderWalkin()');
    await page.selectOption('#rw-session', S1);
    await page.fill('#rw-badge', 'A-12');
    await page.fill('#rw-name', 'Amal Booked');
    await page.fill('#rw-phone', '500000001');
    await page.fill('#rw-height', '170');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Hybrid' }).click();
    await page.click('#rw-add-rider');
    await page.fill('#rw-r-name-0', 'Amal Friend');
    await page.click('#rw-checkin'); // not checked in now
    await page.click('#rw-submit');
    await expect(page.locator('#rider-walkin-modal .modal-box')).toHaveCount(0);
    await expect.poll(() => w.some((x) => x.m === 'PATCH' && x.url.includes('queue_entries') && x.url.includes('id=eq.e5'))).toBe(true);
    // no fresh booking for anyone: the employee and Amal Friend already hold theirs
    expect(w.filter((x) => x.m === 'POST' && x.url.includes('/rest/v1/queue_entries'))).toEqual([]);
    const c5 = w.find((x) => x.m === 'PATCH' && x.url.includes('queue_entries') && x.url.includes('id=eq.e5'))!;
    expect(c5.body).toMatchObject({ status: 'cancelled', cancelled_by: 'staff' });
    // Amal Friend's registration is linked to the booking she holds
    const l4 = w.find((x) => x.m === 'PATCH' && x.url.includes('rider_registrations') && x.url.includes('id=eq.4'));
    expect(l4 && l4.body).toMatchObject({ matched_entry_id: 'e4' });
    expect(w.some((x) => x.m === 'PATCH' && x.url.includes('queue_entries') && /id=eq\.e4(&|$)/.test(x.url))).toBe(false);
  });
});
