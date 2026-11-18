import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The user, 2026-11-18: "why on petromin sessions can't i select what company to show its bookings or all at once", then
// "do 1 2 3": (1) the Petromin list carries its groups as one row of choices over the list - All, Bookings, each company
// by its mark, the invitees and visitors when there are any - with their counts (it was the Company dropdown inside
// Filters); (2) the night's card leads its tiles with All; (3) on a phone the session picker puts a night's All and
// companies right under that night's row (they led the list as loose rows, and the picker scrolled past them).

const N1 = '2099-02-08-pw', N2 = '2099-02-10-pw';
const night = (id: string, date: string, day: string) => ({
  id, day, session_date: date, capacity: 40, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ _time: '19:00 - 21:00', _total: 40, _collect: '18:45' }),
  location: null, addons: null, event_kind: 'community', ride_kind: 'petromin', paid_ride: true,
  needs_approval: false, hide_queue: false, title: null,
});
const sessions = [night(N1, '2099-02-08', 'Sunday'), night(N2, '2099-02-10', 'Tuesday')];
const entry = (o: Record<string, unknown>) => ({
  session_day: 'Sunday', session_date: '2099-02-08', session_id: N1, customer_id: null, type_preference: 'Hybrid',
  status: 'waiting', paid: false, price: 57.5, registered_at: '2099-02-01T10:00:00Z', walk_in: false, via: null, size: '', ...o,
});
const queue_entries = [
  entry({ id: 'bkaaaaaaaaaaaa1', queue_num: 1, name: 'Member One', phone: '+966500000021' }),
  entry({ id: 'bkaaaaaaaaaaaa2', queue_num: 2, name: 'Member Two', phone: '+966500000022' }),
  entry({ id: 'invaaaaaaaaaaa1', queue_num: 3, name: 'Hala Invited', phone: '+966500000011', invite_no: 'I-001', via: 'invite', walk_in: true }),
  entry({ id: 'mtcdddddddddddd', queue_num: 4, name: 'Amal Employee', phone: '+966500000001' }), // her registration stands for it
  entry({ id: 'bkbbbbbbbbbbbb1', queue_num: 1, name: 'Other Night', phone: '+966500000031', session_id: N2, session_date: '2099-02-10', session_day: 'Tuesday' }),
];
const base = { source: 'petromin', created_at: '2099-02-08T09:00:00Z', updated_at: '2099-02-08T09:00:00Z', price: null, checked_in_by: null, checked_out_by: null, submissions: 1, party_no: 1, matched_entry_id: null, matched_customer_id: null, match_kind: 'none', checked_in_at: null, checked_out_at: null };
const rider_registrations = [
  { ...base, id: 1, session_id: N1, booking_no: 'PM-001', badge: 'A-12', company: 'Petromin', name: 'Amal Employee', phone: '+966500000001', height: 170, type_preference: 'Hybrid', matched_entry_id: 'mtcdddddddddddd' },
  { ...base, id: 2, session_id: N1, booking_no: 'PL-001', badge: 'B-7', company: 'Petrolube', name: 'Badr Lube', phone: '+966500000002', height: 175, type_preference: 'Hybrid' },
  { ...base, id: 3, session_id: N1, booking_no: 'D-001', badge: 'DK5', company: 'Dukan', name: 'Dana Dukan', phone: '+966500000003', height: 160, type_preference: 'Hybrid' },
];

type P = import('@playwright/test').Page;
async function boot(page: P) {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));
  await stubSupabase(page, { sessions, queue_entries, rider_registrations });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`(()=>{setStaffTab('queue');S.queueView='bookings';setSfSession(${JSON.stringify(N1)});})()`);
  await page.waitForFunction('S.ridersLoaded===true');
  return errs;
}

test.describe('@staff:bookings Petromin company choices', () => {
  test('the list carries its groups as one row of choices with their counts, and a choice shows that group alone', async ({ page }) => {
    const errs = await boot(page);
    await page.evaluate(`openPetrominPage(${JSON.stringify(N1)},'all')`);
    const row = page.locator('#pm-host .pm-co-row');
    const rows = page.locator('#pm-host tbody tr');
    await expect(row).toHaveAttribute('role', 'group');
    await expect(row).toHaveAttribute('aria-label', 'Company');
    // All, Bookings, the three companies by their marks, the invitees; no Visitors pill on a night with none
    expect(await row.locator('.pm-co').evaluateAll((els) => els.map((e) => e.getAttribute('data-co')))).toEqual(['all', 'Bookings', 'Petromin', 'Petrolube', 'Dukan', 'Invitees']);
    const pill = (co: string) => row.locator(`.pm-co[data-co="${co}"]`);
    await expect(pill('all')).toHaveText(/^All\s*6$/);
    await expect(pill('Bookings')).toHaveText(/^Bookings\s*2$/);                   // Amal's booking is her PM-001 row
    await expect(pill('Petromin').locator('img')).toHaveAttribute('alt', 'Petromin');
    await expect(pill('Petromin').locator('.num')).toHaveText('1');
    await expect(pill('Invitees')).toHaveText(/^Invitees\s*1$/);
    await expect(pill('all')).toHaveAttribute('aria-pressed', 'true');
    await expect(rows).toHaveCount(6);
    // the dropdown in Filters is gone: the row is the one place to pick
    await page.locator('[aria-controls="fm-riders"]').click();
    await expect(page.locator('#pm-host select[aria-label="Company"]')).toHaveCount(0);
    await expect(page.locator('#pm-host select[aria-label="Bike type"]')).toHaveCount(1);

    await pill('Petrolube').click();
    expect(await page.evaluate('[S.queueView,S.ridersSession,S.ridersCompany]')).toEqual(['petromin', N1, 'Petrolube']);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('PL-001');
    await expect(pill('Petrolube')).toHaveAttribute('aria-pressed', 'true');
    await expect(pill('all')).toHaveAttribute('aria-pressed', 'false');
    await expect(pill('Petrolube')).toBeFocused();                                // the focus comes back to the choice
    await expect(pill('all')).toHaveText(/^All\s*6$/);                            // the counts stay the night's

    await pill('Bookings').click();
    await expect(rows).toHaveCount(2);
    await expect(page.locator('#pm-host tr.bk-row')).toHaveCount(2);

    await pill('all').click();
    await expect(rows).toHaveCount(6);

    // every night at once: the counts follow
    await page.locator('#pm-host button', { hasText: 'All Petromin nights' }).click();
    await expect(pill('all')).toHaveText(/^All\s*7$/);
    await expect(pill('Bookings')).toHaveText(/^Bookings\s*3$/);
    expect(errs).toEqual([]);
  });

  test('the night\'s card leads its tiles with All: the night in one list', async ({ page, isMobile }) => {
    test.skip(isMobile, 'wide screens only: a phone has the session picker');
    const errs = await boot(page);
    const CARD = `#tab-queue .sess-bar-desktop .pm-night[data-sid="${N1}"]`;
    const tiles = page.locator(`${CARD} button.pm-tile`);
    await expect(tiles).toHaveCount(5);
    await expect(tiles.nth(0)).toContainText('All');
    await expect(tiles.nth(0).locator('.pm-tile-n')).toHaveText('6');
    await expect(tiles.nth(0)).toHaveAttribute('aria-pressed', 'false');
    await page.evaluate(`S.ridersFilter='waiting'`);
    await tiles.nth(0).click();
    expect(await page.evaluate('[S.queueView,S.ridersSession,S.ridersCompany,S.ridersFilter]')).toEqual(['petromin', N1, 'all', 'all']);
    await expect(tiles.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#pm-host tbody tr')).toHaveCount(6);
    // a company's tile and the row agree on what is on show
    await tiles.nth(3).click();
    await expect(tiles.nth(3)).toHaveAttribute('aria-pressed', 'true');
    await expect(tiles.nth(0)).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#pm-host .pm-co-row .pm-co[data-co="Petrolube"]')).toHaveAttribute('aria-pressed', 'true');
    expect(errs).toEqual([]);
  });

  test('a phone\'s session picker puts a night\'s All and companies right under that night', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phones only: wide screens have the card');
    const errs = await boot(page);
    await page.locator('#rq-sess-sel-spk').click();
    const list = page.locator('#spk-list');
    await expect(list).toBeVisible();
    // the rows in order: "All Sessions", then each night followed by its own choices
    const seq = await list.locator('.spk-row').evaluateAll((els) => els.map((e) => (e.classList.contains('spk-pm') ? 'pm:' : '') + ((e.getAttribute('data-on-click') || '').match(/"_spkPick","([^"]*)"/) || [])[1]));
    expect(seq).toEqual(['all', N1, `pm:pm:${N1}|all`, `pm:pm:${N1}|Petromin`, `pm:pm:${N1}|Petrolube`, `pm:pm:${N1}|Dukan`,
      N2, `pm:pm:${N2}|all`, `pm:pm:${N2}|Petromin`, `pm:pm:${N2}|Petrolube`, `pm:pm:${N2}|Dukan`]);
    const sub = list.locator('.spk-row.spk-pm');
    await expect(sub.nth(0)).toContainText('All');
    await expect(sub.nth(0).locator('.spk-r-left')).toHaveText('6');
    await expect(sub.nth(2).locator('img')).toHaveAttribute('alt', 'Petrolube');
    await expect(sub.nth(2)).toContainText('1 registered');
    // a company typed keeps its night above it
    await page.locator('#spk-q').fill('dukan');
    await expect(list.locator('.spk-row:not(.spk-pm)')).toHaveCount(2);
    await expect(list.locator('.spk-row.spk-pm')).toHaveCount(2);
    await page.locator('#spk-q').fill('');
    // picking one opens that night's list of that company, and the picker then marks it
    await sub.nth(2).click();
    expect(await page.evaluate('[S.queueView,S.ridersSession,S.ridersCompany]')).toEqual(['petromin', N1, 'Petrolube']);
    await expect(page.locator('#pm-host tbody tr')).toHaveCount(1);
    await page.locator('#rq-sess-sel-spk').click();
    await expect(page.locator('#spk-list .spk-row.spk-pm[aria-current="true"]')).toHaveCount(1);
    await expect(page.locator('#spk-list .spk-row.spk-pm[aria-current="true"] img')).toHaveAttribute('alt', 'Petrolube');
    expect(errs).toEqual([]);
  });
});
