import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Editing a Petromin registration from the Riders tab changes the bookings behind it too:
// the rider's own, and each companion's under the same number. These cover the ways that used
// to leave the bookings behind - a party split across two nights, a companion added onto the
// old night, a removed companion still holding a place, a retry that forgot the booking half,
// a waitlisted booking pushed onto a full night - and the billing report's fare tiles.

const S1 = '2099-02-08-pw';
const S2 = '2099-02-15-pw';
const sess = (id: string, date: string, capacity = 35) => ({
  id, day: 'Wednesday', session_date: date, capacity, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: capacity }), location: 'JCC', addons: null,
  event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false, hide_queue: false, title: "Petromin's Wednesdays",
});
const sessions = [sess(S1, '2099-02-08'), sess(S2, '2099-02-15')];
const qe = (id: string, name: string, num: number, extra: Record<string, unknown> = {}) => ({
  id, session_id: S1, session_day: 'Wednesday', session_date: '2099-02-08', queue_num: num, name, phone: '',
  customer_id: null, type_preference: 'Hybrid', status: 'waiting', paid: false, price: 60, registered_at: '2099-01-01T10:00:00Z', ...extra,
});
const base = { source: 'petromin', session_id: S1, company: 'Petromin', badge: 'A-12', phone: '+966500000001', created_at: '2099-02-08T09:00:00Z', updated_at: '2099-02-08T09:00:00Z', price: null, checked_in_at: null, checked_out_at: null, checked_in_by: null, checked_out_by: null, submissions: 1, match_kind: 'booking', matched_customer_id: null };
const party = [
  { ...base, id: 1, booking_no: 'P-001', party_no: 1, name: 'Amal Booked', height: 170, type_preference: 'Hybrid', matched_entry_id: 'e1' },
  { ...base, id: 4, booking_no: 'P-001', party_no: 2, name: 'Amal Friend', height: 150, type_preference: 'Hybrid', matched_entry_id: 'e4' },
  { ...base, id: 5, booking_no: 'P-001', party_no: 3, name: 'Amal Cousin', height: 168, type_preference: 'Mountain', matched_entry_id: 'e5' },
];
const partyBookings = [qe('e1', 'Amal Booked', 7, { phone: '+966500000001' }), qe('e4', 'Amal Friend', 8), qe('e5', 'Amal Cousin', 9, { type_preference: 'Mountain' })];

type P = import('@playwright/test').Page;
type Req = { method: string; url: string; body: Record<string, unknown> | Record<string, unknown>[] | null };

/** Serves one table from a live copy of its rows: writes land in it and later reads see them,
 *  as they would on the server. The shared stub echoes writes without keeping them, so a reload
 *  after a save would read the old rows back - and a retry, or a check that a cancel landed,
 *  would be tested against data the server would no longer hold. `failPatchOnce` refuses the
 *  first PATCH, the way a dropped connection or an RLS denial would. */
async function persist(page: P, table: string, rows: Record<string, unknown>[], failPatchOnce = false) {
  const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  let fails = failPatchOnce ? 1 : 0;
  await page.route(new RegExp(`/rest/v1/${table}(\\?|$)`), async (route) => {
    const req = route.request(), url = new URL(req.url()), m = req.method();
    const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
    let body: unknown = null;
    try { body = req.postDataJSON(); } catch { /* no body */ }
    if (m === 'OPTIONS') return route.fulfill({ status: 200, headers: { ...head, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (m === 'GET' || m === 'HEAD') return route.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${rows.length}/${rows.length}` }, body: JSON.stringify(rows) });
    if (m === 'PATCH' && fails > 0) { fails--; return route.fulfill({ status: 503, headers: head, body: JSON.stringify({ code: '503', message: 'upstream connect error' }) }); }
    if (m === 'PATCH') rows.forEach((r) => { if (String(r.id) === id) Object.assign(r, body as Record<string, unknown>); });
    if (m === 'POST') (Array.isArray(body) ? body : [body]).forEach((r) => rows.push({ ...(r as Record<string, unknown>) }));
    if (m === 'DELETE') rows.splice(0, rows.length, ...rows.filter((r) => String(r.id) !== id));
    return route.fulfill({ status: m === 'POST' ? 201 : 200, headers: head, body: JSON.stringify(body ? (Array.isArray(body) ? body : [body]) : []) });
  });
}

async function boot(page: P, fx: { queue_entries: Record<string, unknown>[]; rider_registrations: Record<string, unknown>[]; [k: string]: unknown }, opts: { sessions?: unknown[]; failBookingPatchOnce?: boolean } = {}) {
  const q = structuredClone(fx.queue_entries), regs = structuredClone(fx.rider_registrations);
  await stubSupabase(page, { ...fx, sessions: opts.sessions || sessions });
  await persist(page, 'queue_entries', q, !!opts.failBookingPatchOnce);
  await persist(page, 'rider_registrations', regs);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('riders')`);
  await page.waitForFunction('S.ridersLoaded===true');
  const reqs: Req[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' || r.method() === 'OPTIONS' || !/rest\/v1\/(rider_registrations|queue_entries|rpc\/rider_party_add)/.test(r.url())) return;
    let body: Req['body'] = null;
    try { body = r.postDataJSON(); } catch { /* no body */ }
    reqs.push({ method: r.method(), url: r.url(), body });
  });
  return reqs;
}
const one = (b: Req['body']) => (Array.isArray(b) ? b[0] : b) as Record<string, unknown>;
const to = (reqs: Req[], method: string, re: RegExp) => reqs.filter((q) => q.method === method && re.test(q.url));

test('moving a party moves every booking in it, books a new companion on the new night and cancels a dropped one', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));
  const reqs = await boot(page, { queue_entries: partyBookings, rider_registrations: party, 'rpc:rider_party_add': { ok: true, ids: [9], riders: 3 } });
  await page.evaluate(`showRiderEdit(1)`);
  const modal = page.locator('#rider-walkin-modal .modal-box');
  await expect(page.locator('#rw-session')).toBeEnabled();
  await page.selectOption('#rw-session', S2);
  await modal.locator('button[data-on-click*="_rwRemoveRider"][data-on-click$=",1]"]').click();    // Amal Cousin is not coming
  await modal.locator('#rw-add-rider').click();
  await page.fill('#rw-r-name-1', 'Amal Niece');
  await page.fill('#rw-r-h-1', '140');
  await page.selectOption('#rw-r-type-1', 'Hybrid');
  await modal.getByRole('button', { name: /save/i }).click();
  await expect(modal).toHaveCount(0);

  // Both bookings that stay go to the new night, on consecutive fresh numbers.
  const b1 = to(reqs, 'PATCH', /queue_entries\?.*id=eq\.e1(&|$)/), b4 = to(reqs, 'PATCH', /queue_entries\?.*id=eq\.e4(&|$)/);
  expect(b1).toHaveLength(1);
  expect(b4).toHaveLength(1);
  expect(one(b1[0].body)).toMatchObject({ session_id: S2, session_date: '2099-02-15', queue_num: 1 });
  expect(one(b4[0].body)).toMatchObject({ session_id: S2, session_date: '2099-02-15', queue_num: 2 });
  // The dropped companion's row goes, and so does the place they held.
  expect(to(reqs, 'DELETE', /rider_registrations\?.*id=eq\.5(&|$)/)).toHaveLength(1);
  const c5 = to(reqs, 'PATCH', /queue_entries\?.*id=eq\.e5(&|$)/);
  expect(c5.length).toBeGreaterThan(0);
  expect(one(c5[0].body)).toMatchObject({ status: 'cancelled', cancelled_by: 'staff' });
  // The new companion is booked on the night the party is on now, not the one it left.
  const posted = to(reqs, 'POST', /rest\/v1\/queue_entries/).flatMap((q) => (Array.isArray(q.body) ? q.body : [q.body])) as Record<string, unknown>[];
  expect(posted.map((r) => [r.name, r.session_id])).toEqual([['Amal Niece', S2]]);
  expect(posted[0].phone).toBe('');                                          // the employee's number stays on the employee's booking
  // The registrations follow as well.
  expect(one(to(reqs, 'PATCH', /rider_registrations\?.*id=eq\.1(&|$)/)[0].body)).toMatchObject({ session_id: S2 });
  expect(one(to(reqs, 'PATCH', /rider_registrations\?.*id=eq\.4(&|$)/)[0].body)).toMatchObject({ session_id: S2 });
  expect(errs).toEqual([]);
});

test('a companion\'s row cannot move the party on its own, and neither can a party with someone on a bike', async ({ page }) => {
  await boot(page, {
    queue_entries: [partyBookings[0], { ...partyBookings[1], status: 'active' }, partyBookings[2]],
    rider_registrations: party,
  });
  await page.evaluate(`showRiderEdit(5)`);                                   // a companion's own row
  await expect(page.locator('#rw-session')).toBeDisabled();
  await page.evaluate(`closeRiderWalkin();showRiderEdit(1)`);                // Amal Friend is out on a bike (checked in on the queue)
  await expect(page.locator('#rw-session')).toBeDisabled();
});

test('a booking write that fails is sent again on retry, not forgotten behind the saved registration', async ({ page }) => {
  const reqs = await boot(page, {
    queue_entries: [partyBookings[0]],
    rider_registrations: [{ ...party[0], booking_no: 'P-002' }],
  }, { failBookingPatchOnce: true });
  await page.evaluate(`showRiderEdit(1)`);
  await page.fill('#rw-name', 'Amal Edited');
  await page.click('#rw-submit');
  await expect(page.locator('#err-bar-el')).toBeVisible();                   // the booking half was refused
  await expect(page.locator('#rider-walkin-modal .modal-box')).toBeVisible();
  expect(to(reqs, 'PATCH', /rider_registrations/)).toHaveLength(1);          // the registration landed
  await page.locator('#err-bar-el .undo-bar-action', { hasText: /try again|retry/i }).click();
  await expect(page.locator('#rider-walkin-modal .modal-box')).toHaveCount(0);
  const bk = to(reqs, 'PATCH', /queue_entries\?.*id=eq\.e1(&|$)/);
  expect(bk).toHaveLength(2);                                                // refused once, then sent again
  expect(one(bk[1].body)).toMatchObject({ name: 'Amal Edited' });
  expect(to(reqs, 'PATCH', /rider_registrations/)).toHaveLength(1);          // and the registration was not written twice
});

test('a waitlisted booking is not moved onto a full night', async ({ page }) => {
  const reqs = await boot(page, {
    queue_entries: [qe('e1', 'Amal Booked', 7, { status: 'waitlist' }), qe('x9', 'Someone Else', 1, { session_id: S2, session_date: '2099-02-15' })],
    rider_registrations: [{ ...party[0], booking_no: 'P-003' }],
  }, { sessions: [sess(S1, '2099-02-08'), sess(S2, '2099-02-15', 1)] });
  await page.evaluate(`showRiderEdit(1)`);
  await page.selectOption('#rw-session', S2);
  await page.click('#rw-submit');
  await expect(page.locator('#rw-err')).toContainText(/not enough room/i);
  await expect(page.locator('#rider-walkin-modal .modal-box')).toBeVisible();
  expect(reqs).toEqual([]);                                                  // nothing written, the registration included
});

test('a registration that never had a session can still be edited, and keeps having none', async ({ page }) => {
  const reqs = await boot(page, {
    queue_entries: [],
    rider_registrations: [{ ...party[0], booking_no: 'P-004', session_id: null, matched_entry_id: null, match_kind: 'none' }],
  });
  await page.evaluate(`showRiderEdit(1)`);
  await expect(page.locator('#rw-session')).toHaveValue('');                // shown as "no session", not as the first night
  await page.fill('#rw-name', 'Amal Renamed');
  await page.click('#rw-submit');
  await expect(page.locator('#rider-walkin-modal .modal-box')).toHaveCount(0);
  const w = to(reqs, 'PATCH', /rider_registrations/);
  expect(w).toHaveLength(1);
  expect(one(w[0].body)).toEqual({ name: 'Amal Renamed' });
});

test('the billing report\'s fare tiles are the fares it bills', async ({ page }) => {
  const done = { checked_in_at: '2099-02-08T16:00:00Z', checked_out_at: '2099-02-08T17:00:00Z' };
  await boot(page, {
    queue_entries: [],
    rider_registrations: [
      { ...party[0], id: 11, booking_no: 'P-011', type_preference: 'Hybrid', price: 50, ...done },
      { ...party[0], id: 12, booking_no: 'P-012', type_preference: 'Mountain', price: 50, ...done },
      { ...party[0], id: 13, booking_no: 'P-013', type_preference: 'Road', price: 75, ...done },
    ],
  });
  // One report per company now (0a271de); these riders are Petromin's.
  const html = await page.evaluate(`(()=>{let h='';_openReport=x=>{h=x;};printRidersReport('Petromin');return h;})()`) as string;
  expect(html).not.toContain('57.5');
  expect(html).toMatch(/Hybrid\/Mountain · 50</);
  expect(html).toMatch(/Road · 75</);
  expect(html).toContain('SAR 175.00');
});
