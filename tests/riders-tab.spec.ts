import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

// The Petromin page in Queue (it was the Riders tab until 2026-09-22) lists self-registrations
// from the form at micromobility.sa/petromin
// (rider_registrations). Each row was matched server-side by phone or name: to an open
// booking, to a customer account with no booking, or to nothing; the tab does not show that
// match any more, the form registration is a booking in its own right. The desk checks a rider
// in and takes the bike back from this tab; the price a return fixes is for the billing
// report only and never appears in the list.

const D = '2099-02-08';
const SESS = '2099-02-08-pw';
const sessions = [{
  id: SESS, day: 'Wednesday', session_date: D, capacity: 35, status: 'open',
  created_at: 1, bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 35 }),
  location: 'JCC', addons: null, event_kind: 'community', ride_kind: 'petromin', paid_ride: true,
  needs_approval: false, hide_queue: false, title: "Petromin's Wednesdays",
}];
const queue_entries = [{
  id: 'e1', session_id: SESS, session_day: 'Wednesday', session_date: D, queue_num: 7,
  name: 'Amal Booked', phone: '+966500000001', customer_id: 'c1', type_preference: 'Hybrid',
  status: 'waiting', paid: false, price: 60, registered_at: '2099-01-01T10:00:00Z',
}];
const base = { source: 'petromin', session_id: SESS, created_at: '2099-02-08T09:00:00Z', updated_at: '2099-02-08T09:00:00Z', price: null, checked_in_by: null, checked_out_by: null };
const rider_registrations = [
  {
    ...base, id: 1, booking_no: 'P-001', badge: 'A-12', company: 'Petromin', name: 'Amal Booked', phone: '+966500000001',
    height: 170, type_preference: 'Hybrid', matched_entry_id: 'e1', matched_customer_id: 'c1', match_kind: 'booking',
    submissions: 1, checked_in_at: null, checked_out_at: null,
  },
  {
    ...base, id: 2, booking_no: 'P-002', badge: 'B-34', company: 'Petrolube', name: 'Bader Account', phone: '+966500000002',
    height: 180, type_preference: 'Road', matched_entry_id: null, matched_customer_id: 'c2', match_kind: 'customer',
    submissions: 2, checked_in_at: '2099-02-08T16:05:00Z', checked_out_at: null, checked_in_by: 'Desk One',
  },
  {
    ...base, id: 3, booking_no: 'P-003', badge: 'C-56', company: 'Petromin', name: 'Cara Nobody', phone: '+966500000003',
    height: 160, type_preference: 'Mountain', matched_entry_id: null, matched_customer_id: null, match_kind: 'none',
    submissions: 1, checked_in_at: '2099-02-08T16:00:00Z', checked_out_at: '2099-02-08T17:35:00Z', checked_in_by: 'Desk One', checked_out_by: 'Desk Two', price: 57.5,
  },
];

type P = import('@playwright/test').Page;

/** Collects uncaught errors for the life of the page. */
function watch(page: P) {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));
  return errs;
}

async function openRiders(page: P) {
  await stubSupabase(page, { sessions, queue_entries, rider_registrations });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('riders')`);
  await expect(page.locator('#pm-host tbody tr')).toHaveCount(3);
}

const rows = (page: P) => page.locator('#pm-host tbody tr');
const pill = (page: P, label: string) => page.locator('#pm-host .filter-pill', { hasText: label });

test('the Riders tab lists every registration with its number, company, phone and session', async ({ page }) => {
  const errs = watch(page);
  await openRiders(page);

  // The old Riders tab lands on the Petromin page inside Queue, on the open Petromin night.
  expect(await page.evaluate('[S.staffTab,S.queueView,S.ridersSession]')).toEqual(['queue', 'petromin', SESS]);
  await expect(page.locator('#tab-queue .pm-chip.active-sess')).toHaveCount(1);          // phones get the same page from the dropdown
  await expect(page.locator('#tab-queue .sess-bar-mobile select')).toHaveValue('pm:' + SESS);
  const r0 = rows(page).nth(0), r1 = rows(page).nth(1), r2 = rows(page).nth(2);
  await expect(r0).toContainText('P-001');
  await expect(r0).toContainText('A-12');
  await expect(r0).toContainText('Petromin');
  await expect(r0.locator('a[href^="https://wa.me/966500000001"]')).toHaveCount(1);
  await expect(r1).toContainText('B-34');
  await expect(r1).toContainText('Petrolube');
  await expect(r1).toContainText('Submitted 2 times');
  await expect(r2).toContainText('C-56');
  await expect(page.locator('#pm-host select.filter-select[aria-label="Session"]')).toContainText('(3)');

  // Pill counts reflect the whole list, not the current filter.
  await expect(pill(page, 'All')).toContainText('3');
  await expect(pill(page, 'Not arrived')).toContainText('1');
  await expect(pill(page, 'On ride')).toContainText('1');
  await expect(pill(page, 'Returned')).toContainText('1');
  expect(errs).toEqual([]);
});

test('the filter pills narrow the list by desk state', async ({ page }) => {
  const errs = watch(page);
  await openRiders(page);

  await pill(page, 'Not arrived').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('A-12');
  await pill(page, 'On ride').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('B-34');
  await pill(page, 'Returned').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText('C-56');
  await pill(page, 'All').click();
  await expect(rows(page)).toHaveCount(3);
  expect(errs).toEqual([]);
});

test('check-in and check-out times show in their own columns, with who stamped them and the ride time', async ({ page }) => {
  const errs = watch(page);
  await openRiders(page);
  const head = page.locator('#pm-host thead');
  await expect(head).toContainText('Check-in time');
  await expect(head).toContainText('Check-out time');

  // Not arrived: no times, a Check in button.
  const r0 = rows(page).nth(0);
  await expect(r0.locator('td.rider-time').nth(0)).not.toContainText(':');
  await expect(r0.locator('td.rider-time').nth(1)).not.toContainText(':');
  await expect(r0.getByRole('button', { name: 'Check in' })).toBeVisible();

  // On ride: the check-in time and who did it; Return bike is offered, with an undo.
  const r1 = rows(page).nth(1);
  await expect(r1.locator('td.rider-time').nth(0)).toContainText('19:05'); // 16:05Z in Riyadh
  await expect(r1.locator('td.rider-time').nth(0)).toContainText('by Desk One');
  await expect(r1.locator('td.rider-time').nth(1)).not.toContainText(':');
  await expect(r1.getByRole('button', { name: 'Return bike' })).toBeVisible();
  await expect(r1.getByRole('button', { name: 'Check in' })).toHaveCount(0);
  await expect(r1.getByRole('button', { name: 'Undo check-in' })).toHaveCount(1);

  // Returned: both times, the ride time between them, and only an undo left.
  const r2 = rows(page).nth(2);
  await expect(r2.locator('td.rider-time').nth(0)).toContainText('19:00');
  await expect(r2.locator('td.rider-time').nth(1)).toContainText('20:35');
  await expect(r2.locator('td.rider-time').nth(1)).toContainText('Ride 1 h 35 min');
  await expect(r2.locator('td.rider-time').nth(1)).toContainText('by Desk Two');
  await expect(r2.getByRole('button', { name: /^Check in$|Return bike/ })).toHaveCount(0);
  await expect(r2.getByRole('button', { name: 'Undo return' })).toHaveCount(1);
  expect(errs).toEqual([]);
});

test('Check in writes checked_in_at for that row, and Return bike writes checked_out_at', async ({ page }) => {
  const errs = watch(page);
  await openRiders(page);
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && /rest\/v1\/rider_registrations/.test(r.url())) writes.push({ url: r.url(), body: r.postDataJSON() });
  });

  await rows(page).nth(0).getByRole('button', { name: 'Check in' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].url).toContain('id=eq.1');
  expect(typeof writes[0].body.checked_in_at).toBe('string');
  expect(writes[0].body.checked_in_by).toBe('Spec Staff');

  await rows(page).nth(1).getByRole('button', { name: 'Return bike' }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].url).toContain('id=eq.2');
  expect(typeof writes[1].body.checked_out_at).toBe('string');
  expect(writes[1].body.checked_out_by).toBe('Spec Staff');
  expect(errs).toEqual([]);
});

test('the list never shows a price; the billing report CSV carries per-ride prices and a TOTAL line', async ({ page }) => {
  const errs = watch(page);
  await openRiders(page);
  const cells = await page.locator('#pm-host td').allTextContents();
  for (const c of cells) {
    expect(c).not.toContain('SAR');
    expect(c).not.toContain('57.5');
    expect(c).not.toContain('75.00');
  }

  await page.getByRole('button', { name: 'Billing report' }).click(); // one report per company: P-003 is Petromin's
  const dl = page.waitForEvent('download');
  await page.locator('.rider-rep-co[data-co="Petromin"]').getByRole('button', { name: 'CSV' }).click();
  const file = await dl;
  const text = await (await import('node:fs/promises')).readFile(await file.path() as string, 'utf8');
  const lines = text.replace(/^\uFEFF/, '').trim().split('\n');
  expect(lines[0]).toContain('price_sar');
  expect(lines.some((l) => l.includes('P-003') && l.includes('57.50'))).toBe(true);
  expect(lines[lines.length - 1]).toContain('TOTAL');
  expect(lines[lines.length - 1]).toContain('57.50');
  expect(errs).toEqual([]);
});

test.describe('walk-in at the desk', () => {
  test('the form draws its boxes, its tick box and its buttons like every other dialog', async ({ page }) => {
    // Badge and Full name had no type, so no input rule reached them (bare browser boxes); "Check
    // in now" had no box to see (inputs are appearance:none); the footer's buttons had no padding.
    await stubSupabase(page, { sessions, queue_entries, rider_registrations });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    await page.locator('#pm-host button', { hasText: 'Walk-in' }).click();
    await expect(page.locator('#rider-walkin-modal .modal-box')).toBeVisible();
    const look = await page.evaluate(() => {
      const st = (id: string) => getComputedStyle(document.getElementById(id)!);
      return { h: ['rw-badge', 'rw-name', 'rw-height'].map((id) => st(id).height), border: ['rw-name', 'rw-height'].map((id) => st(id).borderTopStyle + ' ' + st(id).borderTopWidth), tick: st('rw-checkin').appearance };
    });
    expect(new Set(look.h).size).toBe(1);
    expect(look.border[0]).toBe(look.border[1]);
    expect(look.tick).toBe('checkbox');
    await expect(page.locator('#rider-walkin-modal .modal-footer button').first()).toHaveClass('btn-secondary');
    await expect(page.locator('#rw-submit')).toHaveClass('btn-primary');
  });

  test('staff type the form\'s fields; it goes through rider_register, becomes an ordinary booking too, and is checked in', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries, rider_registrations,
      'rpc:rider_register': { ok: true, id: 9, match: 'none', resubmitted: false, booking_no: 'P-004' },
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    await expect(page.locator('#pm-host tbody tr')).toHaveCount(3);
    const booked = await captureBookingRows(page);

    const calls: Record<string, unknown>[] = [];
    const patches: { url: string; body: Record<string, unknown> }[] = [];
    page.on('request', (r) => {
      if (/rpc\/rider_register/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}'));
      if (r.method() === 'PATCH' && /rider_registrations/.test(r.url())) patches.push({ url: r.url(), body: JSON.parse(r.postData() || '{}') });
    });

    await page.locator('#pm-host button', { hasText: 'Walk-in' }).click();
    await expect(page.locator('#rider-walkin-modal .modal-box')).toBeVisible();
    await expect(page.locator('#rw-session')).toHaveValue(SESS);     // tonight's ride is pre-picked
    await expect(page.locator('#rw-checkin')).toBeChecked();         // a walk-in is standing at the desk
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Petromin' }).click();
    await page.fill('#rw-badge', ' D-78 ');
    await page.fill('#rw-name', 'Dana  Walkin');
    await page.fill('#rw-phone', '0500000004');
    await page.fill('#rw-height', '172');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Hybrid' }).click();
    await page.click('#rw-submit');

    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({
      p_badge: 'D-78', p_name: 'Dana Walkin', p_height: 172, p_type: 'Hybrid', p_source: 'petromin',
      p_phone: '+966500000004', p_session_id: SESS, p_company: 'Petromin',
    });
    // The same rider as an ordinary booking on the night: next number after Amal's #7.
    await expect.poll(() => booked.length).toBe(1);
    expect(booked[0]).toMatchObject({
      session_id: SESS, name: 'Dana Walkin', phone: '+966500000004', height: 172, size: 'S',
      type_preference: 'Hybrid', status: 'waiting', queue_num: 8, walk_in: true,
    });
    // One PATCH on the registration row: linked to that booking, and checked in.
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0].url).toContain('id=eq.9');
    expect(patches[0].body).toMatchObject({ matched_entry_id: booked[0].id, match_kind: 'booking' });
    expect(patches[0].body.checked_in_at).toBeTruthy();
    await expect(page.locator('#rider-walkin-modal .modal-box')).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('P-004');
  });

  test('a walk-in with two companions: one party call, one grouped booking of three, the employee linked and checked in', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries, rider_registrations,
      'rpc:rider_register': { ok: true, id: 9, match: 'none', resubmitted: false, booking_no: 'P-004', riders: 3 },
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    const booked = await captureBookingRows(page);
    const calls: Record<string, unknown>[] = [];
    const patches: { url: string; body: Record<string, unknown> }[] = [];
    page.on('request', (r) => {
      if (/rpc\/rider_register/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}'));
      if (r.method() === 'PATCH' && /rider_registrations/.test(r.url())) patches.push({ url: r.url(), body: JSON.parse(r.postData() || '{}') });
    });
    await page.evaluate(`showRiderWalkin()`);
    await page.fill('#rw-badge', 'K-11');
    await page.fill('#rw-name', 'Khalid Lead');
    await page.fill('#rw-height', '178');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Road' }).click();
    await page.click('#rw-add-rider');
    await page.fill('#rw-r-name-0', 'Khalid Junior');
    await page.fill('#rw-r-h-0', '150');
    await page.selectOption('#rw-r-type-0', 'Hybrid');
    await page.click('#rw-add-rider');
    await page.fill('#rw-r-name-1', 'Khalid Friend');
    await page.fill('#rw-r-h-1', '182');
    await page.selectOption('#rw-r-type-1', 'Mountain');
    await page.click('#rw-submit');

    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].p_riders).toEqual([{ name: 'Khalid Junior', height: 150, type: 'Hybrid' }, { name: 'Khalid Friend', height: 182, type: 'Mountain' }]);
    await expect.poll(() => booked.length).toBe(3);                 // one insert, three rows
    expect(booked.map(b => b.name)).toEqual(['Khalid Lead', 'Khalid Junior', 'Khalid Friend']);
    expect(booked.map(b => b.queue_num)).toEqual([8, 9, 10]);       // consecutive, after Amal's #7
    expect(new Set(booked.map(b => b.group_id)).size).toBe(1);      // one roster group
    expect(booked[0].group_id).toBeTruthy();
    await expect.poll(() => patches.length).toBe(1);               // the employee's row (companions' rows are not in the stub)
    expect(patches[0].url).toContain('id=eq.9');
    expect(patches[0].body).toMatchObject({ matched_entry_id: booked[0].id, match_kind: 'booking' });
    expect(patches[0].body.checked_in_at).toBeTruthy();
    await expect(page.locator('.toast')).toContainText('P-004');
  });

  test('a companion needs nothing but a place in the party: blanks take the employee\'s first name and bike type, no height; a wrong height is still refused', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries, rider_registrations, 'rpc:rider_register': { ok: true, id: 9, booking_no: 'P-004', riders: 3 } });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    const calls: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (/rpc\/rider_register/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}')); });
    await page.evaluate(`showRiderWalkin()`);
    await page.fill('#rw-badge', 'K-12');
    await page.fill('#rw-name', 'Lina Lead');
    await page.fill('#rw-height', '165');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Hybrid' }).click();
    await page.click('#rw-add-rider');
    await page.fill('#rw-r-name-0', 'Lina Kid');   // name only
    await page.click('#rw-add-rider');             // nothing at all
    await page.click('#rw-add-rider');
    await page.fill('#rw-r-h-2', '50');            // a height that is typed must be a real one
    await page.click('#rw-submit');
    await expect(page.locator('#rw-err')).toContainText(/Rider 4/);
    await expect(page.locator('#rw-err')).toContainText(/height/i);
    expect(calls).toHaveLength(0);
    await page.fill('#rw-r-h-2', '');
    await page.click('#rw-submit');
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].p_riders).toEqual([
      { name: 'Lina Kid', height: null, type: 'Hybrid' },
      { name: 'Lina 3', height: null, type: 'Hybrid' },
      { name: 'Lina 4', height: null, type: 'Hybrid' },
    ]);
  });

  test('a walk-in who already holds a place on this session gets no second booking, and is linked to it', async ({ page }) => {
    // The RPC's own match is ignored on purpose: it can point at another night or a namesake.
    // The check is local and bound to the chosen session (Amal's e1, by phone).
    await stubSupabase(page, {
      sessions, queue_entries, rider_registrations,
      'rpc:rider_register': { ok: true, id: 9, match: 'none', resubmitted: false, booking_no: 'P-004' },
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    const booked = await captureBookingRows(page);
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && /rider_registrations/.test(r.url())) patches.push(JSON.parse(r.postData() || '{}')); });

    await page.evaluate(`showRiderWalkin()`);
    await page.fill('#rw-badge', 'A-12');
    await page.fill('#rw-name', 'Amal Booked');
    await page.fill('#rw-phone', '0500000001');
    await page.fill('#rw-height', '170');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Hybrid' }).click();
    await page.click('#rw-submit');
    await expect.poll(() => patches.length).toBe(1);          // checked in...
    expect(patches[0].checked_in_at).toBeTruthy();
    expect(patches[0]).toMatchObject({ matched_entry_id: 'e1', match_kind: 'booking' }); // ...and linked to tonight's row
    expect(booked).toHaveLength(0);                            // Amal keeps her one booking
  });

  test('a match the RPC found on another night does not cost the walk-in tonight\'s booking', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries, rider_registrations,
      'rpc:rider_register': { ok: true, id: 9, match: 'booking', resubmitted: false, booking_no: 'P-004', booking: { queue_num: 3, session_date: '2099-02-15' } },
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    const booked = await captureBookingRows(page);
    await page.evaluate(`showRiderWalkin()`);
    await page.fill('#rw-badge', 'F-01');
    await page.fill('#rw-name', 'Faris Elsewhere');
    await page.fill('#rw-height', '175');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Road' }).click();
    await page.click('#rw-submit');
    await expect.poll(() => booked.length).toBe(1);
    expect(booked[0]).toMatchObject({ session_id: SESS, name: 'Faris Elsewhere', status: 'waiting' });
  });

  test('a failed booking insert keeps the form up, checks nobody in and toasts nothing', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries, rider_registrations,
      'rpc:rider_register': { ok: true, id: 9, match: 'none', resubmitted: false, booking_no: 'P-004' },
    }, { table: 'queue_entries', methods: ['POST'] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    const patches: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && /rider_registrations/.test(r.url())) patches.push(r.url()); });
    await page.evaluate(`showRiderWalkin()`);
    await page.fill('#rw-badge', 'G-02');
    await page.fill('#rw-name', 'Ghada Unlucky');
    await page.fill('#rw-height', '168');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Hybrid' }).click();
    await page.click('#rw-submit');
    await expect(page.locator('#rw-err')).toBeVisible();
    await expect(page.locator('#rider-walkin-modal .modal-box')).toBeVisible();   // still there to retry
    expect(patches).toHaveLength(0);                                                // not checked in
    await expect(page.locator('.toast', { hasText: 'P-004' })).toHaveCount(0);            // no success toast
  });

  // ── Who is this? ──────────────────────────────────────────────────────────
  // The desk's duplicate check reads the session from the server, not from this tab's copy
  // of it: a rider who booked on their own phone on the way in is a realtime message away
  // from being in that copy, and a copy one message behind books them twice. A mobile on
  // both sides settles who they are; a name on its own does not, so the form asks.

  test('the check reads the session from the server, not the tab\'s copy of it', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries: [], rider_registrations,   // the tab loads an empty session...
      'rpc:rider_register': { ok: true, id: 9, match: 'none', resubmitted: false, booking_no: 'P-004' },
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    const created: Record<string, unknown>[] = [];
    const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    // ...and while the form is open, the rider's own booking lands on the server
    await page.route(/\/rest\/v1\/queue_entries/, async (route) => {
      if (route.request().method() === 'POST') {
        const b = route.request().postDataJSON();
        (Array.isArray(b) ? b : [b]).forEach((r: Record<string, unknown>) => created.push(r));
        return route.fulfill({ status: 201, headers: head, body: '[]' });
      }
      return route.fulfill({ status: 200, headers: { ...head, 'content-range': '0-0/1' }, body: JSON.stringify(queue_entries) });
    });
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && /rider_registrations/.test(r.url())) patches.push(JSON.parse(r.postData() || '{}')); });

    await page.evaluate(`showRiderWalkin()`);
    await page.fill('#rw-badge', 'A-12');
    await page.fill('#rw-name', 'Amal Booked');
    await page.fill('#rw-phone', '0500000001');
    await page.fill('#rw-height', '170');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Hybrid' }).click();
    await page.click('#rw-submit');
    await expect.poll(() => patches.length).toBe(1);
    expect(created).toHaveLength(0);                                              // no second booking
    expect(patches[0]).toMatchObject({ matched_entry_id: 'e1', match_kind: 'booking' });
  });

  test('a name with no mobile to confirm it is a question, not a merge', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries, rider_registrations,
      'rpc:rider_register': { ok: true, id: 9, match: 'none', resubmitted: false, booking_no: 'P-004' },
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    const booked = await captureBookingRows(page);
    await page.evaluate(`showRiderWalkin()`);
    await page.fill('#rw-badge', 'A-99');
    await page.fill('#rw-name', 'Amal Booked');      // the same name, and no mobile typed
    await page.fill('#rw-height', '170');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Hybrid' }).click();
    await page.click('#rw-submit');
    await expect(page.locator('#rw-dup')).toContainText('#7');                 // the booking it found
    await expect(page.locator('#rw-submit')).toBeDisabled();                   // and no way past it
    expect(booked).toHaveLength(0);
    await page.locator('#rw-dup button', { hasText: /add a booking/i }).click();
    await expect.poll(() => booked.length).toBe(1);                            // a namesake keeps their own
    expect(booked[0]).toMatchObject({ name: 'Amal Booked', session_id: SESS, status: 'waiting' });
  });

  test('the same question answered the other way gives the rider the booking they hold', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries, rider_registrations,
      'rpc:rider_register': { ok: true, id: 9, match: 'none', resubmitted: false, booking_no: 'P-004' },
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    const booked = await captureBookingRows(page);
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && /rider_registrations/.test(r.url())) patches.push(JSON.parse(r.postData() || '{}')); });
    await page.evaluate(`showRiderWalkin()`);
    await page.fill('#rw-badge', 'A-99');
    await page.fill('#rw-name', 'Amal Booked');
    await page.fill('#rw-height', '170');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Hybrid' }).click();
    await page.click('#rw-submit');
    await page.locator('#rw-dup button', { hasText: /same rider/i }).click();
    await expect.poll(() => patches.length).toBe(1);
    expect(patches[0]).toMatchObject({ matched_entry_id: 'e1', match_kind: 'booking' });
    expect(booked).toHaveLength(0);
  });

  test('two different mobiles are two people, and neither is asked about', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries, rider_registrations,
      'rpc:rider_register': { ok: true, id: 9, match: 'none', resubmitted: false, booking_no: 'P-004' },
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    const booked = await captureBookingRows(page);
    await page.evaluate(`showRiderWalkin()`);
    await page.fill('#rw-badge', 'A-98');
    await page.fill('#rw-name', 'Amal Booked');
    await page.fill('#rw-phone', '0500000009');       // same name, a different number
    await page.fill('#rw-height', '170');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Hybrid' }).click();
    await page.click('#rw-submit');
    await expect.poll(() => booked.length).toBe(1);
    await expect(page.locator('#rw-dup')).toHaveCount(0);
  });

  test('a failed insert leaves one way forward, and the retry does not register the rider twice', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries, rider_registrations,
      'rpc:rider_register': { ok: true, id: 9, match: 'none', resubmitted: false, booking_no: 'P-004' },
    }, { table: 'queue_entries', methods: ['POST'], once: true });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    const registers: string[] = [];
    page.on('request', (r) => { if (/rpc\/rider_register/.test(r.url())) registers.push(r.url()); });
    await page.evaluate(`showRiderWalkin()`);
    await page.fill('#rw-badge', 'G-02');
    await page.fill('#rw-name', 'Ghada Unlucky');
    await page.fill('#rw-height', '168');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Hybrid' }).click();
    await page.click('#rw-submit');
    await expect(page.locator('#rw-err')).toBeVisible();
    await expect(page.locator('#rw-submit')).toHaveText(/try again/i);   // the one button, and it resumes
    expect(registers).toHaveLength(1);
    await page.click('#rw-submit');
    await expect(page.locator('#rider-walkin-modal .modal-box')).toHaveCount(0);   // done
    expect(registers).toHaveLength(1);                                             // and registered once
  });

  test('an insert whose reply was lost is not sent a second time', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries: [], rider_registrations,
      'rpc:rider_register': { ok: true, id: 9, match: 'none', resubmitted: false, booking_no: 'P-004' },
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    // The rows land; the reply never comes back. To the client that is indistinguishable
    // from a refusal, so the retry has to look before it writes.
    const created: Record<string, unknown>[] = [];
    const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    let swallowNext = true;
    await page.route(/\/rest\/v1\/queue_entries/, async (route) => {
      if (route.request().method() === 'POST') {
        const b = route.request().postDataJSON();
        (Array.isArray(b) ? b : [b]).forEach((r: Record<string, unknown>) => created.push(r));
        if (swallowNext) { swallowNext = false; return route.fulfill({ status: 503, headers: head, body: JSON.stringify({ code: '503', message: 'gateway' }) }); }
        return route.fulfill({ status: 201, headers: head, body: '[]' });
      }
      return route.fulfill({ status: 200, headers: { ...head, 'content-range': `0-${created.length}/${created.length}` }, body: JSON.stringify(created) });
    });
    await page.evaluate(`showRiderWalkin()`);
    await page.fill('#rw-badge', 'L-07');
    await page.fill('#rw-name', 'Layla Lost');
    await page.fill('#rw-phone', '0500000077');
    await page.fill('#rw-height', '166');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Road' }).click();
    await page.click('#rw-submit');
    await expect(page.locator('#rw-submit')).toHaveText(/try again/i);
    expect(created).toHaveLength(1);
    await page.click('#rw-submit');
    await expect(page.locator('#rider-walkin-modal .modal-box')).toHaveCount(0);
    expect(created).toHaveLength(1);                                  // still one booking, not two
  });

  test('a session whose window has ended is not offered, because the server would refuse it', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries, rider_registrations });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const today = await page.evaluate(`new Date().toLocaleDateString('en-CA',{timeZone:KSA_TZ})`);
    const now = await page.evaluate(`new Intl.DateTimeFormat('en-GB',{timeZone:KSA_TZ,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date())`);
    // An end written before its start is over, the way _session_window() reads it - it does
    // not run past midnight into tomorrow.
    expect(await page.evaluate(`_sessEnded({session_date:'${today}',bike_slots:JSON.stringify({_time:'23:59 - 00:30'})})`)).toBe(true);
    // And no readable window at all is the server's 09:00 - 11:00 default, not "never ends".
    expect(await page.evaluate(`_sessEnded({session_date:'${today}',bike_slots:'{}'})`)).toBe(String(now) >= '11:00');
    const listed = await page.evaluate(
      `(()=>{S.sessions=[{id:'${today}-pw',day:'Wednesday',session_date:'${today}',capacity:35,status:'open',event_kind:'community',ride_kind:'petromin',paid_ride:true,bike_slots:JSON.stringify({_time:'23:59 - 00:30'})}];return _walkinSessions().length;})()`,
    );
    expect(listed).toBe(0);
  });

  test('a pasted number with its own country code is kept, not prefixed with +966', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries, rider_registrations,
      'rpc:rider_register': { ok: true, id: 9, match: 'none', resubmitted: false, booking_no: 'P-004' },
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    const calls: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (/rpc\/rider_register/.test(r.url())) calls.push(JSON.parse(r.postData() || '{}')); });
    await captureBookingRows(page);
    await page.evaluate(`showRiderWalkin()`);
    await page.fill('#rw-badge', 'H-03');
    await page.fill('#rw-name', 'Hany Cairo');
    await page.fill('#rw-phone', '+20 100 123 4567');
    await page.fill('#rw-height', '180');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Road' }).click();
    await page.click('#rw-submit');
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0].p_phone).toBe('+201001234567');
  });

  test('a one-word name is refused before anything is sent, and the RPC\'s own verdict is shown', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries, rider_registrations,
      'rpc:rider_register': { ok: false, error: 'badge' },
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    const calls: string[] = [];
    page.on('request', (r) => { if (/rpc\/rider_register/.test(r.url())) calls.push(r.url()); });

    await page.evaluate(`showRiderWalkin()`);
    await page.fill('#rw-badge', 'E-90');
    await page.fill('#rw-name', 'Mononym');
    await page.fill('#rw-height', '170');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Road' }).click();
    await page.click('#rw-submit');
    await expect(page.locator('#rw-err')).toContainText(/full name/i);
    expect(calls).toHaveLength(0);

    await page.fill('#rw-name', 'Mono Nym');
    await page.click('#rw-submit');
    await expect.poll(() => calls.length).toBe(1);
    await expect(page.locator('#rw-err')).toContainText(/badge/i);   // the server said no; the modal stays open
    await expect(page.locator('#rider-walkin-modal .modal-box')).toBeVisible();
  });
});

test('scanning a rider QR opens the booking pop-up with a Check in button, and the pop-up writes the check-in', async ({ page }) => {
  const errs = watch(page);
  await openRiders(page);
  const writes: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && /rest\/v1\/rider_registrations/.test(r.url())) writes.push(r.postDataJSON()); });

  // The QR on the rider's phone holds MMP-<booking number>, the same shape as a rentals ticket.
  await page.evaluate(`_onScanPayload('MMP-P-001')`);
  // The night in the fixture is not today: the camera names it and waits for Make an exception (2026-09-28); take it.
  await page.evaluate('_scanExceptionGo()');
  // The toast names the rider and their number and nothing else. It used to borrow the
  // queue's message and cut the '#' off the front of the placeholder, which only worked in
  // the languages that write a number sign - Spanish, French and Portuguese print 'N.º', so
  // the substitution missed and the toast read a literal {0}.
  const toast = page.locator('.toast', { hasText: 'P-001' });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Amal Booked');
  await expect(toast).not.toContainText('{0}');
  const modal = page.locator('#rider-modal .modal-box'); // the container has no size of its own
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('P-001');
  await expect(modal).toContainText('Amal Booked');
  await expect(modal).toContainText('A-12');
  await expect(modal).toContainText('Petromin');
  await expect(modal).toContainText('170 cm');
  await expect(modal.locator('.ci-type')).toContainText('Hybrid');
  await expect(modal).toContainText('Not arrived');
  await expect(modal.locator('#rider-checkin')).toBeVisible();

  await modal.locator('#rider-checkin').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(typeof writes[0].checked_in_at).toBe('string');
  await expect(modal).toBeVisible(); // stays open to show the new state

  // An unknown code says so and opens nothing new.
  await modal.getByRole('button', { name: 'Close' }).click();
  await expect(modal).toBeHidden();
  await page.evaluate(`_onScanPayload('MMP-P-999')`);
  await expect(modal).toBeHidden();

  // A rider already on the bike gets Return bike; the number in the list opens the same pop-up.
  await rows(page).nth(1).getByRole('button', { name: 'P-002' }).click();
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('On ride');
  await expect(modal.locator('#rider-return')).toBeVisible();
  await expect(modal.locator('#rider-checkin')).toHaveCount(0);
  await expect(page.locator('#pm-host').getByRole('button', { name: 'Scan QR' })).toBeVisible();
  expect(errs).toEqual([]);
});

test.describe('editing a registration', () => {
  test('Edit in the pop-up opens the form pre-filled; saving patches the row and the linked booking', async ({ page }) => {
    await openRiders(page);
    const writes: { url: string; body: Record<string, unknown> }[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && /rest\/v1\/(rider_registrations|queue_entries)/.test(r.url())) writes.push({ url: r.url(), body: r.postDataJSON() });
    });
    await page.evaluate(`openRiderModal(1)`);
    await page.locator('#rider-modal button', { hasText: 'Edit' }).click();
    await expect(page.locator('#rider-walkin-modal .modal-box')).toBeVisible();
    await expect(page.locator('#rw-badge')).toHaveValue('A-12');
    await expect(page.locator('#rw-name')).toHaveValue('Amal Booked');
    await expect(page.locator('#rw-cc')).toHaveValue('+966');
    await expect(page.locator('#rw-phone')).toHaveValue('500000001');
    await expect(page.locator('#rw-height')).toHaveValue('170');
    await expect(page.locator('#rw-checkin')).toHaveCount(0);                 // no check-in box when editing
    await page.fill('#rw-name', 'Amal Edited');
    await page.fill('#rw-height', '175');
    await page.locator('#rider-walkin-modal .toggle-btn', { hasText: 'Mountain' }).click();
    await page.click('#rw-submit');
    await expect.poll(() => writes.length).toBe(2);
    const reg = writes.find(w => /rider_registrations/.test(w.url))!;
    const bk = writes.find(w => /queue_entries/.test(w.url))!;
    expect(reg.url).toContain('id=eq.1');
    expect(reg.body).toEqual({ name: 'Amal Edited', height: 175, type_preference: 'Mountain' });   // only what changed
    expect(bk.url).toContain('id=eq.e1');                                                          // Amal's booking follows
    expect(bk.body).toEqual({ name: 'Amal Edited', height: 175, size: 'M', type_preference: 'Mountain' }); // price 60 is not the type default, so it is left alone
    await expect(page.locator('#rider-walkin-modal .modal-box')).toHaveCount(0);
    await expect(page.locator('.toast')).toContainText('Amal Edited');
  });

  test('a badge already used on that session is refused with its own message, and the form stays up', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries, rider_registrations },
      { table: 'rider_registrations', methods: ['PATCH'], status: 409, code: '23505', message: 'duplicate key value violates unique constraint "rider_registrations_badge_session"' });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    await expect(page.locator('#pm-host tbody tr')).toHaveCount(3);
    await page.evaluate(`showRiderEdit(3)`);
    await page.fill('#rw-badge', 'A-12');
    await page.click('#rw-submit');
    await expect(page.locator('#rw-err')).toContainText(/badge/i);
    await expect(page.locator('#rider-walkin-modal .modal-box')).toBeVisible();
  });

  // Opened from a scanned QR rather than the list, and refusing a slip before it is sent.
  test('the pop-up from a scan opens the editor, the number is never rewritten, and a bad name is caught', async ({ page }) => {
    const errs = watch(page);
    await openRiders(page);
    const writes: { url: string; body: Record<string, unknown> }[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && /rest\/v1\/rider_registrations/.test(r.url())) writes.push({ url: r.url(), body: r.postDataJSON() }); });

    await page.evaluate(`_onScanPayload('MMP-P-001')`);
    // The night in the fixture is not today: the camera names it and waits for Make an exception (2026-09-28); take it.
    await page.evaluate('_scanExceptionGo()');
    await page.locator('#rider-modal .modal-box').getByRole('button', { name: 'Edit' }).click();
    const modal = page.locator('#rider-walkin-modal .modal-box');
    await expect(modal).toBeVisible();
    await expect(modal.locator('#rw-title')).toContainText('P-001');          // which booking is being edited
    await expect(modal.locator('#rw-session')).toHaveValue(SESS);
    await expect(modal.locator('.toggle-btn.active', { hasText: 'Hybrid' })).toHaveCount(1);
    await page.fill('#rw-badge', ' A-13 ');
    await modal.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].url).toContain('id=eq.1');
    expect(writes[0].body).toEqual({ badge: 'A-13' });                        // only what changed
    expect(writes[0].body).not.toHaveProperty('booking_no');                  // the number is the rider's, never rewritten
    expect(writes[0].body).not.toHaveProperty('matched_entry_id');            // same night: the booking link stands
    await expect(modal).toHaveCount(0);
    await expect(page.locator('#rider-modal .modal-box')).toContainText('P-001'); // the pop-up comes back with the saved row

    await page.evaluate(`showRiderEdit(3)`);
    await page.fill('#rw-name', 'Mononym');
    await page.locator('#rider-walkin-modal').getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#rw-err')).toContainText(/full name/i);
    expect(writes).toHaveLength(1);
    expect(errs).toEqual([]);
  });

  test('a checked-in rider keeps their session: the picker is disabled', async ({ page }) => {
    await openRiders(page);
    await page.evaluate(`showRiderEdit(2)`);                                     // Bader is on a bike
    await expect(page.locator('#rw-session')).toBeDisabled();
    await expect(page.locator('#rw-session')).toHaveValue(SESS);
    await page.evaluate(`showRiderEdit(1)`);                                     // Amal is waiting
    await expect(page.locator('#rw-session')).toBeEnabled();
  });
});

test.describe('a party under one booking number', () => {
  // The form can send companions: each is a row of their own under the employee's badge and
  // booking number, party_no 2..N. The tab shows who is with whom; the number opens the employee.
  const party = [
    { ...base, id: 5, booking_no: 'P-005', party_no: 1, badge: 'E-90', company: 'Petromin', name: 'Dana Lead', phone: '+966500000005', height: 170, type_preference: 'Road', match_kind: 'none', submissions: 1, checked_in_at: null, checked_out_at: null, updated_at: '2099-02-08T10:00:00Z' },
    { ...base, id: 6, booking_no: 'P-005', party_no: 2, badge: 'E-90', company: 'Petromin', name: 'Dana Kid', phone: null, height: 150, type_preference: 'Hybrid', match_kind: 'none', submissions: 1, checked_in_at: null, checked_out_at: null, updated_at: '2099-02-08T10:00:00Z' },
    { ...base, id: 7, booking_no: 'P-005', party_no: 3, badge: 'E-90', company: 'Petromin', name: 'Dana Friend', phone: null, height: 180, type_preference: 'Mountain', match_kind: 'none', submissions: 1, checked_in_at: null, checked_out_at: null, updated_at: '2099-02-08T10:00:00Z' },
  ];
  async function boot(page: P) {
    await stubSupabase(page, { sessions, queue_entries, rider_registrations: [...rider_registrations, ...party] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setStaffTab('riders')`);
    // The party folds to one row until opened, as on the Bookings tab.
    await expect(page.locator('#pm-host tbody tr')).toHaveCount(4);
    await page.locator('#pm-host tbody tr.party-row').getByRole('button', { name: /Show riders/ }).click();
    await expect(page.locator('#pm-host tbody tr')).toHaveCount(6);
  }

  test('the list keeps the party together and says who is with whom', async ({ page }) => {
    await boot(page);
    const rows = page.locator('#pm-host tbody tr', { hasText: 'P-005' });
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Dana Lead');
    await expect(rows.nth(0)).toContainText('Rider 1 of 3');
    await expect(rows.nth(1)).toContainText('Dana Kid');
    await expect(rows.nth(1)).toContainText('Rider 2 of 3');
    await expect(rows.nth(1)).toContainText('with Dana Lead');
    await expect(rows.nth(2)).toContainText('Rider 3 of 3');
    await expect(page.locator('#pm-host tbody tr', { hasText: 'P-001' })).not.toContainText('Rider 1 of');   // a solo row says nothing
  });

  test('scanning the number opens the employee; a companion cannot change the shared badge', async ({ page }) => {
    await boot(page);
    await page.evaluate(`_scanRider('P-005', ()=>{})`);
    // The night in the fixture is not today: the camera names it and waits for Make an exception (2026-09-28); take it.
    await page.evaluate('_scanExceptionGo()');
    expect(await page.evaluate(`S._riderModalId`)).toBe('5');
    await expect(page.locator('#rider-modal .modal-box')).toContainText('Rider 1 of 3');
    await page.evaluate(`showRiderEdit(6)`);
    await expect(page.locator('#rw-badge')).toBeDisabled();
    await expect(page.locator('#rw-badge')).toHaveValue('E-90');
    await expect(page.locator('#rw-name')).toHaveValue('Dana Kid');
  });
});

test('one QR opens the whole party: every rider listed with their own Check in, and Check in all does the rest', async ({ page }) => {
  const errs = watch(page);
  const party: Record<string, unknown>[] = [
    ...rider_registrations.map((r) => ({ ...r, party_no: 1 })),
    { ...base, id: 4, booking_no: 'P-003', party_no: 2, badge: 'C-56', company: 'Petromin', name: 'Cara Friend', phone: '+966500000003', height: 150, type_preference: 'Hybrid', matched_entry_id: null, matched_customer_id: null, match_kind: 'none', submissions: 1, checked_in_at: null, checked_out_at: null },
    { ...base, id: 5, booking_no: 'P-003', party_no: 3, badge: 'C-56', company: 'Petromin', name: 'Cara Cousin', phone: '+966500000003', height: 168, type_preference: 'Mountain', matched_entry_id: null, matched_customer_id: null, match_kind: 'none', submissions: 1, checked_in_at: null, checked_out_at: null },
  ];
  await stubSupabase(page, { sessions, queue_entries, rider_registrations: party });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('riders')`);
  // The party folds to one row, as on the Bookings tab: its size, its counts, Show riders.
  await expect(page.locator('#pm-host tbody tr')).toHaveCount(3);
  const folded = page.locator('#pm-host tbody tr.party-row');
  await expect(folded).toHaveCount(1);
  await expect(folded).toContainText('3 riders');
  await expect(folded).toContainText('2 not arrived');
  await expect(folded).toContainText('1 returned');
  await expect(folded.getByRole('button', { name: 'Check in all' })).toBeVisible();
  await folded.getByRole('button', { name: /Show riders/ }).click();
  await expect(page.locator('#pm-host tbody tr')).toHaveCount(5);
  await expect(page.locator('#pm-host tbody tr.party-row')).toHaveCount(3);
  await page.locator('#pm-host tbody tr.party-row').first().getByRole('button', { name: /Hide riders/ }).click();
  await expect(page.locator('#pm-host tbody tr')).toHaveCount(3);
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && /rest\/v1\/rider_registrations/.test(r.url())) writes.push({ url: r.url(), body: r.postDataJSON() }); });

  await page.evaluate(`_onScanPayload('MMP-P-003')`);
  // The night in the fixture is not today: the camera names it and waits for Make an exception (2026-09-28); take it.
  await page.evaluate('_scanExceptionGo()');
  const modal = page.locator('#rider-modal .modal-box');
  await expect(modal).toBeVisible();
  const rows3 = modal.locator('#rider-party .rider-party-row');
  await expect(rows3).toHaveCount(3);
  await expect(rows3.nth(0)).toContainText('Cara Nobody');
  await expect(rows3.nth(0)).toContainText('Returned'); // the employee's row is already back in the fixture
  await expect(rows3.nth(1)).toContainText('Cara Friend');
  await expect(rows3.nth(1)).toContainText('150 cm');
  await expect(rows3.nth(1).getByRole('button', { name: 'Check in' })).toBeVisible();
  await expect(rows3.nth(2)).toContainText('Cara Cousin');

  await modal.locator('#rider-checkin-all').click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes.map((w) => (w.url.match(/id=eq\.(\d+)/) || [])[1]).sort()).toEqual(['4', '5']);
  for (const w of writes) expect(typeof w.body.checked_in_at).toBe('string');
  expect(errs).toEqual([]);
});

test('staff edit a party: companions come filled in, one is changed, one removed, one added under the same number', async ({ page }) => {
  const errs = watch(page);
  const party: Record<string, unknown>[] = [
    ...rider_registrations.map((r) => ({ ...r, party_no: 1 })),
    { ...base, id: 4, booking_no: 'P-001', party_no: 2, badge: 'A-12', company: 'Petromin', name: 'Amal Friend', phone: '+966500000001', height: 150, type_preference: 'Hybrid', matched_entry_id: null, matched_customer_id: null, match_kind: 'none', submissions: 1, checked_in_at: null, checked_out_at: null },
    { ...base, id: 5, booking_no: 'P-001', party_no: 3, badge: 'A-12', company: 'Petromin', name: 'Amal Cousin', phone: '+966500000001', height: 168, type_preference: 'Mountain', matched_entry_id: null, matched_customer_id: null, match_kind: 'none', submissions: 1, checked_in_at: null, checked_out_at: null },
  ];
  await stubSupabase(page, { sessions, queue_entries, rider_registrations: party, 'rpc:rider_party_add': { ok: true, ids: [9, 10], riders: 5 } });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('riders')`);
  await expect(page.locator('#pm-host tbody tr')).toHaveCount(3); // P-001's party folds to one row; its Edit covers the party
  const reqs: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  page.on('request', (r) => { if (/rest\/v1\/(rider_registrations|rpc\/rider_party_add)/.test(r.url()) && r.method() !== 'GET') reqs.push({ method: r.method(), url: r.url(), body: r.postData() ? r.postDataJSON() : null }); });

  await rows(page).nth(0).getByRole('button', { name: 'Edit' }).click();
  const modal = page.locator('#rider-walkin-modal .modal-box');
  await expect(modal.locator('#rw-title')).toContainText('P-001');
  await expect(modal.locator('#rw-r-name-0')).toHaveValue('Amal Friend');
  await expect(modal.locator('#rw-r-name-1')).toHaveValue('Amal Cousin');
  await expect(modal.locator('#rw-r-type-1')).toHaveValue('Mountain');

  await page.fill('#rw-r-h-0', '152');                       // companion 2: taller than we thought
  await modal.locator('button[data-on-click*="_rwRemoveRider"][data-on-click$=",1]"]').click(); // companion 3 is not coming
  await modal.locator('#rw-add-rider').click();                // a new companion
  await page.fill('#rw-r-name-1', 'Amal Niece');
  await page.fill('#rw-r-h-1', '140');
  await page.selectOption('#rw-r-type-1', 'Hybrid');
  await modal.locator('#rw-add-rider').click();                // and one the desk knows nothing about yet
  await modal.getByRole('button', { name: /save/i }).click();
  await expect(modal).toHaveCount(0);

  const upd = reqs.filter((q) => q.method === 'PATCH' && q.url.includes('id=eq.4'));
  expect(upd).toHaveLength(1);
  expect(upd[0].body).toEqual({ height: 152 });
  expect(reqs.filter((q) => q.method === 'DELETE' && q.url.includes('id=eq.5'))).toHaveLength(1);
  const add = reqs.filter((q) => q.url.includes('rider_party_add'));
  expect(add).toHaveLength(1);
  // The blank one gets the employee's first name and the next number in the party, the employee's bike type, and no height.
  expect(add[0].body).toEqual({ p_id: 1, p_riders: [{ name: 'Amal Niece', height: 140, type: 'Hybrid' }, { name: 'Amal 5', height: null, type: 'Hybrid' }] });
  expect(reqs.filter((q) => q.method === 'PATCH' && /id=eq\.1(&|$)/.test(q.url))).toHaveLength(0); // the employee's own row was untouched
  expect(errs).toEqual([]);
});

test('the pop-up says when a rider sent the form more than once (Claude Design #6)', async ({ page }) => {
  await openRiders(page);
  await page.evaluate(`openRiderModal(2)`);
  await expect(page.locator('#rider-modal .rider-sent')).toHaveText('Submitted 2 times');
  await page.evaluate(`closeRiderModal()`);
  await page.evaluate(`openRiderModal(1)`);
  await expect(page.locator('#rider-modal .rider-sent')).toHaveCount(0);
});
