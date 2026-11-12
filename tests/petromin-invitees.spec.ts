import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Petromin invitees (the user, 2026-11-12): people Petromin invites book a Petromin night themselves. Each booking is
// on the night's Bookings list with a number of its own, I-001 upward every night, and pays at the desk. Staff see that
// number on the booking ("Invitee I-001"), find it by typing it, and see the invitees beside the Petromin, Petrolube
// and Dukan registrations on the Petromin page, whose "All Petromin nights" is the one list of every night.
// Since 2026-11-13 a guest books at micromobility.sa/petromin with a MicroMobility account and types their company
// (petromin_guest_book, migration 20261113150000): the booking is the account's and carries the company, which staff
// read after the number and on the guest list. A booking from the page before (a walk-in, no account) has none.

const N1 = '2099-02-08-pw', N2 = '2099-02-10-pw';
const night = (id: string, date: string, day: string) => ({
  id, day, session_date: date, capacity: 40, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 40, _collect: '18:45' }),
  location: null, addons: null, event_kind: 'community', ride_kind: 'petromin', paid_ride: true,
  needs_approval: false, hide_queue: false, title: "Petromin's Circuit Night",
});
const sessions = [night(N1, '2099-02-08', 'Sunday'), night(N2, '2099-02-10', 'Tuesday')];
const entry = (o: Record<string, unknown>) => ({
  session_day: 'Sunday', session_date: '2099-02-08', session_id: N1, customer_id: null, type_preference: 'Hybrid',
  status: 'waiting', paid: false, price: 57.5, registered_at: '2099-02-01T10:00:00Z', walk_in: true, via: 'invite', size: '', ...o,
});
const queue_entries = [
  entry({ id: 'invaaaaaaaaaaa1', queue_num: 4, name: 'Hala Invited', phone: '+966500000011', invite_no: 'I-001' }),
  entry({ id: 'invaaaaaaaaaaa2', queue_num: 5, name: 'Omar Guest', phone: '+966500000012', invite_no: 'I-002', status: 'active', type_preference: 'Mountain', checked_in_at: '2099-02-08T16:10:00Z' }),
  entry({ id: 'invaaaaaaaaaaa3', queue_num: 6, name: 'Gone Guest', phone: '+966500000013', invite_no: 'I-003', status: 'cancelled' }),
  entry({ id: 'invbbbbbbbbbbb1', queue_num: 2, name: 'Rana Later', phone: '+966500000014', invite_no: 'I-001', session_id: N2, session_date: '2099-02-10', session_day: 'Tuesday',
    customer_id: 'cust-rana', walk_in: false, invite_company: 'Aramco Trading' }),
  entry({ id: 'wlkcccccccccccc', queue_num: 7, name: 'Plain Walkin', phone: '+966500000015', via: null }),
  // Amal's own app booking: her registration stands for it (matched_entry_id), so it is not a second row
  entry({ id: 'mtcdddddddddddd', queue_num: 8, name: 'Amal Employee', phone: '+966500000001', via: null, walk_in: false }),
];
const base = { source: 'petromin', created_at: '2099-02-08T09:00:00Z', updated_at: '2099-02-08T09:00:00Z', price: null, checked_in_by: null, checked_out_by: null, submissions: 1, party_no: 1, matched_entry_id: null, matched_customer_id: null, match_kind: 'none', checked_in_at: null, checked_out_at: null };
const rider_registrations = [
  { ...base, id: 1, session_id: N1, booking_no: 'P-001', badge: 'A-12', company: 'Petromin', name: 'Amal Employee', phone: '+966500000001', height: 170, type_preference: 'Hybrid', matched_entry_id: 'mtcdddddddddddd' },
  { ...base, id: 2, session_id: N2, booking_no: 'D-001', badge: 'DK500000002', company: 'Dukan', name: 'Badr Dukan', phone: '+966500000002', height: null, type_preference: 'Hybrid' },
];

type P = import('@playwright/test').Page;
async function boot(page: P) {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));
  await stubSupabase(page, { sessions, queue_entries, rider_registrations });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  return errs;
}

test.describe('@staff:bookings Petromin invitees', () => {
  test('an invitee is a walk-in with its I- number on Bookings, and typing the number finds it', async ({ page }) => {
    const errs = await boot(page);
    await page.evaluate(`(()=>{setStaffTab('queue');S.queueView='bookings';setSfSession(${JSON.stringify(N1)});})()`);
    const inv = page.locator('#tab-queue [data-id="invaaaaaaaaaaa1"] .inv-badge').first();
    await expect(inv).toHaveText('Invitee I-001');
    // a plain walk-in has no invitee chip
    await expect(page.locator('#tab-queue [data-id="wlkcccccccccccc"]').first()).toBeVisible();
    await expect(page.locator('#tab-queue [data-id="wlkcccccccccccc"] .inv-badge')).toHaveCount(0);
    // the number, typed, leaves that booking alone (as i1 too)
    await page.evaluate(`setSfSearch('I-001')`);
    await expect.poll(() => page.evaluate(`[...document.querySelectorAll('#tab-queue [data-id]')].map(x=>x.dataset.id).filter((v,i,a)=>a.indexOf(v)===i)`)).toEqual(['invaaaaaaaaaaa1']);
    // a guest with an account (the merged page): the chip says the company after the number, whole in its title
    await page.evaluate(`(()=>{setSfSearch('');setSfSession(${JSON.stringify(N2)});})()`);
    const rana = page.locator('#tab-queue [data-id="invbbbbbbbbbbb1"] .inv-badge').first();
    await expect(rana).toHaveText('Invitee I-001 · Aramco Trading');
    await expect(rana).toHaveAttribute('title', 'Invitees · Aramco Trading');
    expect(await page.evaluate(`[_matchesRef(_qGet('invaaaaaaaaaaa1'),'i1'),_matchesRef(_qGet('invbbbbbbbbbbb1'),'i-001'),_matchesRef(_qGet('invaaaaaaaaaaa2'),'i-001'),_matchesRef(_qGet('wlkcccccccccccc'),'i-001')]`)).toEqual([true, true, false, false]);
    expect(errs).toEqual([]);
  });

  test('the Petromin page lists invitees beside the registrations, and All Petromin nights is every night in one list', async ({ page }) => {
    const errs = await boot(page);
    await page.evaluate(`openPetrominPage(${JSON.stringify(N1)},'all')`);
    const rows = page.locator('#pm-host tbody tr');
    // the night: its registration, its invitees still booked (the cancelled one is not listed) and its plain booking
    await expect(rows).toHaveCount(4);
    await expect(page.locator('#pm-host tr.inv-row')).toHaveCount(2);
    const hala = page.locator('#pm-host tr.inv-row[data-id="invaaaaaaaaaaa1"]');
    await expect(hala).toContainText('I-001');
    await expect(hala).toContainText('Invitees');
    await expect(hala.locator('a[href^="https://wa.me/966500000011"]')).toHaveCount(1);
    await expect(page.locator('#pm-host tr.inv-row[data-id="invaaaaaaaaaaa2"] button', { hasText: 'Return' })).toHaveCount(1);
    // the status pills count them: Omar is on a bike
    await expect(page.locator('#pm-host .filter-pill', { hasText: 'On ride' })).toContainText('1');

    // All Petromin nights: both nights, every company and the invitees
    await page.locator('#pm-host button', { hasText: 'All Petromin nights' }).click();
    expect(await page.evaluate('[S.ridersSession,S.ridersCompany]')).toEqual(['all', 'all']);
    await expect(page.locator('#pm-host h1')).toContainText('All Petromin nights');
    await expect(rows).toHaveCount(6);
    await expect(page.locator('#pm-host button', { hasText: 'All Petromin nights' })).toHaveCount(0);

    // the company filter has Invitees: only the invitees, of every night
    await page.locator('[aria-controls="fm-riders"]').click();
    await page.locator('#pm-host select[aria-label="Company"]').selectOption('Invitees');
    await expect(rows).toHaveCount(3);
    await expect(page.locator('#pm-host tr.inv-row')).toHaveCount(3);
    await expect(page.locator('#pm-host h1')).toContainText('Invitees');

    // the search finds an invitee by name, and by the company they typed, which their row says under Invitees
    await page.evaluate(`setRidersSearch('rana')`);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Rana Later');
    await page.evaluate(`setRidersSearch('aramco')`);
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator('.iv-co')).toHaveText('Aramco Trading');
    await page.evaluate(`setRidersSearch('')`);
    await expect(page.locator('#pm-host tr.inv-row[data-id="invaaaaaaaaaaa1"] .iv-co')).toHaveCount(0);

    // Check in opens the booking's own check-in
    await page.locator('#pm-host tr.inv-row[data-id="invaaaaaaaaaaa1"] button', { hasText: 'Check in' }).click();
    await expect.poll(() => page.evaluate('S._ciId')).toBe('invaaaaaaaaaaa1');
    await page.evaluate('closeCheckinModal()');

    // the number opens the booking on Bookings, found by that number on its night
    await page.locator('#pm-host tr.inv-row[data-id="invbbbbbbbbbbb1"] .iv-bno').click();
    expect(await page.evaluate('[S.queueView,S.sfSession,S.sfSearch]')).toEqual(['bookings', N2, 'I-001']);
    expect(errs).toEqual([]);
  });

  test('a phone reaches the same list from the dropdown: All under the night, with every row counted', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phones only: wide screens have the card');
    const errs = await boot(page);
    await page.evaluate(`(()=>{setStaffTab('queue');S.queueView='bookings';setSfSession(${JSON.stringify(N1)});})()`);
    const opt = page.locator(`#tab-queue .sess-bar-mobile select option[value="pm:${N1}|all"]`);
    await expect(opt).toHaveText(/^All · .* — 4$/);
    await page.locator('#tab-queue .sess-bar-mobile select').selectOption(`pm:${N1}|all`);
    expect(await page.evaluate('[S.queueView,S.ridersSession,S.ridersCompany]')).toEqual(['petromin', N1, 'all']);
    await expect(page.locator('#pm-host tbody tr')).toHaveCount(4);
    await expect(page.locator('#pm-host tr.bk-row')).toHaveCount(1);
    expect(errs).toEqual([]);
  });

  test('the night card itself opens the night in one list: its bookings, every company and the invitees', async ({ page, isMobile }) => {
    test.skip(isMobile, 'wide screens only: a phone has the dropdown');
    const errs = await boot(page);
    await page.evaluate(`(()=>{setStaffTab('queue');S.queueView='bookings';setSfSession(${JSON.stringify(N1)});})()`);
    const CARD = `#tab-queue .sess-bar-desktop .pm-night[data-sid="${N1}"]`;
    // a tile opens its own list, never the whole one
    await page.locator(`${CARD} button.pm-tile`).nth(1).click();
    expect(await page.evaluate('[S.queueView,S.ridersSession,S.ridersCompany]')).toEqual(['petromin', N1, 'Petromin']);
    await expect(page.locator(`${CARD} .pm-night-all`)).toHaveAttribute('aria-pressed', 'false');
    // the card's lines (a button, for the keyboard too): every row of the night
    await page.evaluate(`S.ridersFilter='waiting'`);
    await page.locator(`${CARD} .pm-night-all`).click();
    expect(await page.evaluate('[S.queueView,S.ridersSession,S.ridersCompany,S.ridersFilter]')).toEqual(['petromin', N1, 'all', 'all']);
    await expect(page.locator(`${CARD} .pm-night-all`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`${CARD} button.pm-tile[aria-pressed="true"]`)).toHaveCount(0);
    const rows = page.locator('#pm-host tbody tr');
    await expect(rows).toHaveCount(4);
    await expect(page.locator('#pm-host tr.inv-row')).toHaveCount(2);
    const walk = page.locator('#pm-host tr.bk-row');
    await expect(walk).toHaveCount(1);                                  // Amal's matched booking is her P-001 row
    await expect(walk).toHaveAttribute('data-id', 'wlkcccccccccccc');
    await expect(walk).toContainText('#7');
    await expect(walk).toContainText('Bookings');
    await expect(walk).toContainText('Plain Walkin');
    await expect(walk.locator('button', { hasText: 'Check in' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Amal Employee' })).toHaveCount(1);
    // the padding of the card (not a tile, not its lines) opens the same list
    await page.locator(`${CARD} button.pm-tile`).nth(0).click();
    expect(await page.evaluate('S.queueView')).toBe('bookings');
    await page.locator(CARD).click({ position: { x: 3, y: 3 } });
    expect(await page.evaluate('[S.queueView,S.ridersSession,S.ridersCompany]')).toEqual(['petromin', N1, 'all']);
    // the company filter has Bookings: the plain bookings alone
    await page.locator('[aria-controls="fm-riders"]').click();
    await page.locator('#pm-host select[aria-label="Company"]').selectOption('Bookings');
    await expect(rows).toHaveCount(1);
    await expect(page.locator('#pm-host h1')).toContainText('Bookings');
    // its number opens it on Bookings, found by that number on its night
    await page.locator('#pm-host tr.bk-row .iv-bno').click();
    expect(await page.evaluate('[S.queueView,S.sfSession,S.sfSearch]')).toEqual(['bookings', N1, '7']);
    expect(errs).toEqual([]);
  });
});
