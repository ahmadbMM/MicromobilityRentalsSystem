import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Vendors, first named F&B Partners (owner, 2026-10-03): cafés and restaurants reserve the Saturdays our Saturday social
// ride's riders come to them for breakfast. Staff confirm one venue per date (the rest are declined
// by staff_vendor_decide), make the venues' logins and edit the tiers. Admin only; migration 20261003150000.

const sessions = [
  { id: '2099-05-05', day: 'Tuesday', session_date: '2099-05-05', capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00"}' },
  { id: '2099-05-09-s', day: 'Saturday', session_date: '2099-05-09', capacity: 40, status: 'open', created_at: 2, event_kind: 'community', ride_kind: 'saturday', breakfast_name: 'Bean Box', breakfast_url: null, bike_slots: '{"_time":"06:00 - 08:00"}' },
];
const tiers = [
  { id: 'single', name_en: 'Single', name_ar: 'يوم واحد', modes: ['single'], max_per_month: 1, horizon_days: 60, min_lead_days: 7, cancel_cutoff_days: 5, priority: 1, benefits: [], active: true, sort: 1 },
  { id: 'recurring', name_en: 'Recurring', name_ar: 'شهري', modes: ['single', 'multi', 'recurring'], max_per_month: 2, horizon_days: 365, min_lead_days: 7, cancel_cutoff_days: 5, priority: 3, benefits: [{ en: 'Logo on the ride poster', ar: 'الشعار على ملصق الجولة' }], active: true, sort: 3 },
];
const venue = (o: Record<string, unknown>) => ({
  id: 1, name: 'Bean Box', name_ar: '', kind: 'cafe', area: 'Al Hamra', map_url: '', seats: 40, contact_name: 'Huda Saleh', contact_phone: '0551234567',
  contact_email: '', offer_en: '', offer_ar: '', staff_notes: '', tier_id: 'single', status: 'active', created_by: 'Spec Staff', created_at: '2099-04-01T08:00:00Z', ...o,
});
const venues = [venue({}), venue({ id: 2, name: 'Corniche Kitchen', kind: 'restaurant', tier_id: 'recurring', contact_phone: '' })];
const dates = [
  { day: '2099-05-02', state: 'open', reason: '', capacity: 1 },
  { day: '2099-05-09', state: 'open', reason: '', capacity: 1 },
  { day: '2099-05-16', state: 'closed', reason: 'ramadan', capacity: 1 },
];
const bk = (o: Record<string, unknown>) => ({
  id: 10, venue_id: 1, day: '2099-05-02', series_id: null, kind: 'single', status: 'pending', note: '', staff_note: '', requested_by: null, decided_by: '',
  decided_at: null, cancelled_by: null, cancel_reason: '', late_cancel: false, created_at: '2099-04-10T09:00:00Z', updated_at: '2099-04-10T09:00:00Z', ...o,
});
const bookings = [
  bk({}),
  bk({ id: 11, venue_id: 2, kind: 'recurring', note: 'Shakshuka for everyone', created_at: '2099-04-11T09:00:00Z' }),
  bk({ id: 12, venue_id: 1, day: '2099-05-09', status: 'confirmed' }),
];
const base = { sessions, queue_entries: [], bikes: [], vendor_tiers: tiers, vendor_venues: venues, vendor_users: [], vendor_dates: dates, vendor_series: [], vendor_bookings: bookings };

type Call = { fn: string; body: Record<string, unknown> };
async function open(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { ...base, ...fixtures });
  await unlockStaff(page);
  const calls: Call[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/(staff_vendor_\w+)/);
    if (m && r.method() === 'POST') calls.push({ fn: m[1], body: r.postDataJSON() });
  });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('vendors')`);
  await expect(panel(page).locator('.vendor-body')).toBeVisible();
  return calls;
}
const panel = (page: Page) => page.locator('#tab-vendors');
const dialog = (page: Page) => page.locator('#confirm-modal');
const toMay = (page: Page) => page.evaluate(`S._vendor.month='2099-05';renderVendors()`);

test.describe('@staff:vendors Vendors', () => {
  test('the calendar paints the dates: open with requests waiting, confirmed with the venue, closed with the reason', async ({ page }) => {
    await open(page);
    const item = page.locator('#staff-tab-nav .tab-btn[data-stab="vendors"]');
    await expect(item).toHaveClass(/active/);
    await expect(item.locator('.tab-badge')).toHaveText('2');
    expect(new URL(page.url()).pathname).toBe('/vendors');
    await toMay(page);
    const day = (d: string) => panel(page).locator(`.vendor-day[data-vendor-day="${d}"]`);
    await expect(day('2099-05-02')).toHaveClass(/st-open/);
    await expect(day('2099-05-02')).toContainText('2 pending');
    await expect(day('2099-05-09')).toHaveClass(/st-confirmed/);
    await expect(day('2099-05-09')).toContainText('Bean Box');
    await expect(day('2099-05-16')).toHaveClass(/st-closed/);
    await expect(day('2099-05-16')).toContainText('Ramadan');
    await expect(day('2099-05-23')).toHaveClass(/st-off/); // a Saturday not opened yet
    // The date's dialog: the ride's breakfast stop as it stands, the requests side by side.
    await day('2099-05-09').click();
    await expect(dialog(page).locator('.vendor-ride')).toContainText('Bean Box');
    await expect(dialog(page).locator('.vendor-bk[data-vendor-bk="12"]')).toContainText('Confirmed');
    await expect(dialog(page).locator('.vendor-bk[data-vendor-bk="12"] .vendor-cancel')).toBeVisible();
  });

  test('confirming a pending request calls staff_vendor_decide, the higher tier listed first', async ({ page }) => {
    const calls = await open(page);
    await panel(page).locator('[data-vendor-view="requests"]').click();
    expect(new URL(page.url()).pathname).toBe('/vendors/requests');
    const grp = panel(page).locator('.vendor-grp[data-vendor-grp="2099-05-02"]');
    await expect(grp).toContainText('2 venues asking');
    // The higher tier first.
    await expect(grp.locator('.vendor-bk').first()).toContainText('Corniche Kitchen');
    await grp.locator('.vendor-bk[data-vendor-bk="11"] .vendor-confirm').click();
    await dialog(page).getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(() => calls.filter((c) => c.fn === 'staff_vendor_decide').length).toBe(1);
    expect(calls[0].body).toEqual({ p_booking: 11, p_action: 'confirm', p_note: '', p_by: 'Spec Staff' });
  });

  test('adding a login shows the temporary password once, with a WhatsApp message', async ({ page }) => {
    const calls = await open(page, { 'rpc:staff_vendor_user_add': { id: 7, login: 'huda@beanbox.sa', password: 'Tmp9-Kq4m' } });
    await panel(page).locator('[data-vendor-view="venues"]').click();
    await panel(page).locator('.vendor-ven[data-vendor-ven="1"] .vendor-ven-open').click();
    await dialog(page).locator('#vendor-u-login').fill('Huda@BeanBox.sa');
    await dialog(page).locator('#vendor-u-name').fill('Huda Saleh');
    await dialog(page).locator('.vendor-u-add').click();
    await expect.poll(() => calls.filter((c) => c.fn === 'staff_vendor_user_add').length).toBe(1);
    expect(calls[0].body).toEqual({ p_venue: 1, p_login: 'Huda@BeanBox.sa', p_name: 'Huda Saleh', p_role: 'manager' });
    await expect(dialog(page).locator('.vendor-pw-val')).toHaveText('Tmp9-Kq4m');
    const msg = dialog(page).locator('#vendor-pw-text');
    await expect(msg).toContainText('Login: huda@beanbox.sa');
    await expect(msg).toContainText('Temporary password: Tmp9-Kq4m');
    await expect(msg).toContainText('the first time you sign in');
    await expect(msg).toContainText('Sign in here: https://vendors.micromobility.sa');
    await expect(dialog(page).locator('a.vendor-pw-wa')).toHaveAttribute('href', /^https:\/\/wa\.me\/966551234567\?text=Hello%20Huda/);
    await dialog(page).locator('#vendor-pw-lang').selectOption('ar');
    await expect(msg).toContainText('كلمة المرور المؤقتة: Tmp9-Kq4m');
    await expect(dialog(page).locator('tr[data-vendor-user="7"]')).toContainText('huda@beanbox.sa');
    // Closed and opened again: the password is gone.
    await dialog(page).locator('.ca-x').click();
    await panel(page).locator('.vendor-ven[data-vendor-ven="1"] .vendor-ven-open').click();
    await expect(dialog(page).locator('tr[data-vendor-user="7"]')).toBeVisible();
    await expect(dialog(page).locator('.vendor-pw')).toHaveCount(0);
  });

  test('a tier saves its booking types and benefits', async ({ page }) => {
    const calls = await open(page);
    await panel(page).locator('[data-vendor-view="tiers"]').click();
    const card = panel(page).locator('.vendor-tier[data-vendor-tier="recurring"]');
    await card.locator('input[data-vendor-mode="multi"]').uncheck();
    await card.locator('.vendor-ben-add').click();
    await card.locator('[data-vendor-ben="1"] input[data-vendor-ben-l="en"]').fill('Free coffee for the ride leader');
    await card.locator('[data-vendor-ben="1"] input[data-vendor-ben-l="ar"]').fill('قهوة مجانية لقائد الجولة');
    await card.locator('[data-vendor-ben="1"] .vendor-up').click(); // the new one first
    await card.locator('#vendor-t-recurring-max_per_month').fill('');
    await card.locator('.vendor-tier-save').click();
    await expect.poll(() => calls.filter((c) => c.fn === 'staff_vendor_tier_save').length).toBe(1);
    const p = calls[0].body.p as Record<string, unknown>;
    expect(p.modes).toEqual(['single', 'recurring']);
    expect(p.benefits).toEqual([{ en: 'Free coffee for the ride leader', ar: 'قهوة مجانية لقائد الجولة' }, { en: 'Logo on the ride poster', ar: 'الشعار على ملصق الجولة' }]);
    expect(p.max_per_month).toBe('');
    expect(p).toMatchObject({ id: 'recurring', horizon_days: 365, priority: 3 });
  });

  test('before the database update it says so, instead of failing', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
    await page.route(/\/rest\/v1\/vendor_\w+(\?|$)/, (r) => r.fulfill({
      status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.vendor_tiers' in the schema cache" }),
    }));
    await unlockStaff(page);
    await page.goto('/vendors');
    await waitForSb(page);
    await page.waitForFunction(() => S.view === 'staff' && S.staffTab === 'vendors');
    await expect(panel(page).locator('.vendor-not-set-up')).toContainText("isn’t set up yet");
  });

  test('Front Desk does not have it', async ({ page }) => {
    await open(page);
    await page.evaluate(`S.staffRole='frontdesk';renderStaffTabs();setStaffTab('vendors')`);
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="vendors"]')).toHaveCSS('display', 'none');
    expect(await page.evaluate('S.staffTab')).toBe('queue');
  });
});

// Venue feedback (2026-10-03, migration 20261003180000): a venue rates a confirmed breakfast from its portal
// for 14 days after it; staff read it on Partners > Feedback, in the date's dialog and beside the venue's bookings.
const ksa = (n: number) => new Date(Date.now() + 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10); // a Riyadh day n days from today
const fbRow = (o: Record<string, unknown>) => ({
  booking_id: 12, venue_id: 1, day: '2099-05-09', rating: 4, turnout: 18, went_well: 'Quick service, everyone seated together',
  improve: 'Tell us the head count a day earlier', created_at: '2099-05-09T10:00:00Z', updated_at: '2099-05-10T08:00:00Z', ...o,
});
const qe = (o: Record<string, unknown>) => ({
  id: 'q1', session_id: '2099-05-09-s', session_day: 'Saturday', session_date: '2099-05-09', queue_num: 1, name: 'Spec Rider', size: 'M',
  type_preference: 'Any', status: 'waiting', paid: false, price: 0, registered_at: '2099-05-01T10:00:00Z', ...o,
});
const fbFix = {
  vendor_bookings: [
    ...bookings,
    bk({ id: 13, venue_id: 2, day: '2099-04-25', status: 'confirmed' }),
    bk({ id: 14, venue_id: 2, day: ksa(-3), status: 'confirmed' }), // no feedback yet, still within the 14 days
    bk({ id: 15, venue_id: 1, day: ksa(-30), status: 'confirmed' }), // no feedback, and too late for it: not waited on
    bk({ id: 16, venue_id: 2, day: ksa(-10), status: 'confirmed' }),
  ],
  vendor_feedback: [
    fbRow({}),
    fbRow({ booking_id: 13, venue_id: 2, day: '2099-04-25', rating: 2, turnout: null, went_well: '', improve: 'Riders arrived late', created_at: '2099-04-25T09:00:00Z', updated_at: '2099-04-25T09:00:00Z' }),
    fbRow({ booking_id: 16, venue_id: 2, day: ksa(-10), rating: 5, turnout: 9, went_well: 'Lovely group', improve: '', created_at: ksa(-10) + 'T09:00:00Z', updated_at: ksa(-10) + 'T09:00:00Z' }),
  ],
  // The Saturday ride of 2099-05-09: two riders booked (waiting, done); a no-show and a rejected one do not count.
  queue_entries: [qe({}), qe({ id: 'q2', queue_num: 2, status: 'done' }), qe({ id: 'q3', queue_num: 3, status: 'noshow' }), qe({ id: 'q4', queue_num: 4, approval: 'rejected' })],
};
async function openFeedback(page: Page) {
  const calls = await open(page, fbFix);
  await page.waitForFunction('S.dataLoaded');
  await panel(page).locator('[data-vendor-view="feedback"]').click();
  return calls;
}

test.describe('@staff:vendors Vendors feedback', () => {
  test('the Feedback tab lists it newest breakfast first: stars, turnout beside the booked riders, the two answers', async ({ page }) => {
    await openFeedback(page);
    expect(new URL(page.url()).pathname).toBe('/vendors/feedback');
    const cards = panel(page).locator('.vendor-fb');
    await expect(cards).toHaveCount(3);
    expect(await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-vendor-fb')))).toEqual(['12', '13', '16']);
    const c = panel(page).locator('.vendor-fb[data-vendor-fb="12"]');
    await expect(c).toContainText('Bean Box');
    await expect(c.locator('.vendor-stars .vendor-sr')).toHaveText('4 of 5');
    await expect(c.locator('.vendor-star.on')).toHaveCount(4);
    await expect(c.locator('.vendor-star')).toHaveCount(5);
    await expect(c.locator('.vendor-fb-turn')).toContainText('Riders who came 18');
    await expect(c.locator('.vendor-fb-booked')).toHaveText('2 booked on the ride');
    await expect(c.locator('.vendor-fb-well')).toContainText('Quick service, everyone seated together');
    await expect(c.locator('.vendor-fb-better')).toContainText('Tell us the head count a day earlier');
    await expect(c.locator('.vendor-fb-at')).toContainText('Sent');
    await expect(c.locator('.vendor-fb-at')).toContainText('edited');
    // No count from the venue, no ride held for that date, nothing under "went well".
    const o = panel(page).locator('.vendor-fb[data-vendor-fb="13"]');
    await expect(o.locator('.vendor-fb-turn')).toContainText('Not given');
    await expect(o.locator('.vendor-fb-booked')).toHaveCount(0);
    await expect(o.locator('.vendor-fb-well')).toHaveCount(0);
    await expect(o.locator('.vendor-fb-at')).not.toContainText('edited');
    await expect(panel(page).locator('.vendor-fb-avg')).toHaveText('Average 3.7 of 5');
    await expect(panel(page).locator('.vendor-fb-n')).toHaveText('Feedback received: 3');
    await expect(panel(page).locator('.vendor-fb-wait')).toHaveText('Breakfasts waiting for feedback: 1');
    expect(await page.evaluate(() => /\p{Extended_Pictographic}/u.test(document.getElementById('tab-vendors')!.textContent || ''))).toBe(false);
  });

  test('the rating, venue and search filters narrow it, and the average follows', async ({ page }) => {
    await openFeedback(page);
    const ids = () => panel(page).locator('.vendor-fb').evaluateAll((els) => els.map((e) => e.getAttribute('data-vendor-fb')));
    await panel(page).locator('.vendor-fb-rf [data-vendor-f="high"]').click();
    await expect.poll(ids).toEqual(['12', '16']);
    await expect(panel(page).locator('.vendor-fb-avg')).toHaveText('Average 4.5 of 5');
    await panel(page).locator('.vendor-fb-rf [data-vendor-f="low"]').click();
    await expect.poll(ids).toEqual(['13']);
    await panel(page).locator('.vendor-fb-rf [data-vendor-f="mid"]').click();
    await expect(panel(page).locator('.vendor-fb')).toHaveCount(0);
    await expect(panel(page).locator('#vendor-list .empty-state')).toHaveText('No feedback matches the filters.');
    await panel(page).locator('.vendor-fb-rf [data-vendor-f="all"]').click();
    await panel(page).locator('#vendor-fb-ven').selectOption('2');
    await expect.poll(ids).toEqual(['13', '16']);
    await expect(panel(page).locator('.vendor-fb-rf [data-vendor-f="high"]')).toContainText('(1)');
    await panel(page).locator('#vendor-fb-ven').selectOption('all');
    await expect.poll(ids).toEqual(['12', '13', '16']);
    const fold = panel(page).locator('[data-srch="vendorf"] .srch-btn'); // a phone folds the search into a button
    if (await fold.isVisible()) await fold.click();
    await panel(page).locator('#vendorf-q').fill('head count');
    await expect.poll(ids).toEqual(['12']);
    await expect(panel(page).locator('.vendor-fb-n')).toHaveText('Feedback received: 1');
  });

  test('the date dialog shows the confirmed venue’s feedback; the venue dialog puts stars beside its past bookings', async ({ page }) => {
    await open(page, fbFix);
    await toMay(page);
    await panel(page).locator('.vendor-day[data-vendor-day="2099-05-09"]').click();
    const fb = dialog(page).locator('.vendor-fb[data-vendor-fb="12"]');
    await expect(fb).toBeVisible();
    await expect(dialog(page)).toContainText('Venue feedback');
    await expect(fb.locator('.vendor-sr')).toHaveText('4 of 5');
    await expect(fb).toContainText('Quick service, everyone seated together');
    await expect(fb).toContainText('Tell us the head count a day earlier');
    // A date without feedback has no such block.
    await dialog(page).locator('.ca-x').click();
    await panel(page).locator('.vendor-day[data-vendor-day="2099-05-02"]').click();
    await expect(dialog(page).locator('.vendor-bk').first()).toBeVisible();
    await expect(dialog(page).locator('.vendor-fb')).toHaveCount(0);
    await dialog(page).locator('.ca-x').click();
    await panel(page).locator('[data-vendor-view="venues"]').click();
    await panel(page).locator('.vendor-ven[data-vendor-ven="2"] .vendor-ven-open').click();
    await expect(dialog(page).locator('[data-vendor-vbk="16"] .vendor-sr')).toHaveText('5 of 5');
    await expect(dialog(page).locator('[data-vendor-vbk="14"] .vendor-stars')).toHaveCount(0); // past, no feedback yet
    await expect(dialog(page).locator('[data-vendor-vbk="13"] .vendor-stars')).toHaveCount(0); // still to come
  });

  test('before its database update the Feedback tab says so calmly, and the other tabs keep working', async ({ page }) => {
    await stubSupabase(page, { ...base, ...fbFix });
    await page.route(/\/rest\/v1\/vendor_feedback(\?|$)/, (r) => r.fulfill({
      status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.vendor_feedback' in the schema cache" }),
    }));
    await unlockStaff(page);
    await page.goto('/vendors/feedback');
    await waitForSb(page);
    await page.waitForFunction(() => S.view === 'staff' && S.staffTab === 'vendors');
    await expect(panel(page).locator('.vendor-fb-missing')).toHaveText('Feedback appears here once the database update is applied.');
    await expect(panel(page).locator('.vendor-retry')).toHaveCount(0);
    await panel(page).locator('[data-vendor-view="requests"]').click();
    await expect(panel(page).locator('.vendor-grp[data-vendor-grp="2099-05-02"]')).toContainText('2 venues asking');
    await panel(page).locator('[data-vendor-view="calendar"]').click();
    await toMay(page);
    await panel(page).locator('.vendor-day[data-vendor-day="2099-05-09"]').click();
    await expect(dialog(page).locator('.vendor-bk[data-vendor-bk="12"]')).toContainText('Confirmed');
    await expect(dialog(page).locator('.vendor-fb')).toHaveCount(0);
  });
});

// Riders' breakfast ratings shared with the vendor (2026-10-03, migration 20261003200000): the breakfast part
// of the post-ride rating of that date's Saturday social ride, counted and averaged, and only the reasons
// staff tick; never a rider's name. staff_vendor_share_ratings / staff_vendor_unshare_ratings.
const rd = ksa(-2), old = ksa(-9), quiet = ksa(-16);
const rgSess = (id: string, date: string, o: Record<string, unknown> = {}) => ({
  id, day: 'Saturday', session_date: date, capacity: 40, status: 'open', created_at: 3, event_kind: 'community', ride_kind: 'saturday', breakfast_name: 'Bean Box', breakfast_url: null, bike_slots: '{"_time":"06:00 - 08:00"}', ...o,
});
const social = (s: Record<string, number>, why: Record<string, string> = {}, o: Record<string, unknown> = {}) => ({ form: 'social', s, why, ...o });
const rgFix = {
  sessions: [...sessions, rgSess('rg-s', rd), rgSess('rg-o', old), rgSess('rg-q', quiet), { id: 'rg-c', day: 'Saturday', session_date: rd, capacity: 12, status: 'open', created_at: 4, bike_slots: '{"_time":"18:00 - 20:00"}' }],
  vendor_bookings: [...bookings, bk({ id: 20, venue_id: 1, day: rd, status: 'confirmed' }), bk({ id: 21, venue_id: 1, day: quiet, status: 'confirmed' })],
  queue_entries: [
    qe({ id: 'r1', name: 'Hidden Rider One', session_id: 'rg-s', session_date: rd, status: 'done', rating_exp: 9,
      rating_detail: social({ ride: 4, breakfast: 9, bf_restaurant: 8, bf_food: 6, bf_service: 10, overall: 9 }, { ride: 'Too fast for me', bf_restaurant: 'Too small for the group', bf_food: 'Eggs were cold' }) }),
    qe({ id: 'r2', name: 'Hidden Rider Two', queue_num: 2, session_id: 'rg-s', session_date: rd, status: 'done', rating_exp: 7,
      rating_detail: social({ breakfast: 7, bf_food: 9, overall: 7 }, { breakfast: 'Slow to serve', overall: 'Long wait' }) }),
    // Not counted: skipped the breakfast, still on the ride, a circuit form, another date, another ride that day.
    qe({ id: 'r3', queue_num: 3, session_id: 'rg-s', session_date: rd, status: 'done', rating_detail: social({ breakfast: 1 }, { breakfast: 'skipped' }, { skip_bf: true }) }),
    qe({ id: 'r4', queue_num: 4, session_id: 'rg-s', session_date: rd, status: 'waiting', rating_detail: social({ breakfast: 1 }) }),
    qe({ id: 'r5', queue_num: 5, session_id: 'rg-s', session_date: rd, status: 'done', rating_detail: { form: 'rental', s: { breakfast: 1, service: 1 }, why: {} } }),
    qe({ id: 'r6', session_id: 'rg-o', session_date: old, status: 'done', rating_detail: social({ breakfast: 1 }, { breakfast: 'Other date' }) }),
    qe({ id: 'r7', session_id: 'rg-c', session_date: rd, status: 'done', rating_detail: social({ breakfast: 1 }, { breakfast: 'Other ride' }) }),
  ],
};
const rgBlock = (page: Page, id = 20) => dialog(page).locator(`.vendor-rg[data-vendor-rg="${id}"]`);
async function openDay(page: Page, fixtures: Record<string, unknown> = {}) {
  const calls = await open(page, { ...rgFix, ...fixtures });
  await page.waitForFunction('S.dataLoaded');
  await page.evaluate(`_vendorDayOpen('${rd}')`);
  return calls;
}

test.describe('@staff:vendors Vendors riders’ breakfast ratings', () => {
  test('the date dialog counts and averages that ride’s breakfast answers, without names; an unticked reason is left out', async ({ page }) => {
    const calls = await openDay(page, { 'rpc:staff_vendor_share_ratings': { booking_id: 20, venue_id: 1, day: rd, riders: 2, averages: { breakfast: 8, bf_food: 7.5 }, comments: [{ k: 'bf_food', text: 'Eggs were cold' }], shared_by: 'Spec Staff', shared_at: '2099-05-10T08:00:00Z' } });
    const b = rgBlock(page);
    await expect(dialog(page)).toContainText('Riders’ breakfast ratings');
    await expect(b.locator('.vendor-rg-n')).toHaveText('Riders who rated the breakfast: 2');
    const avg = (k: string) => b.locator(`.vendor-rg-avg[data-k="${k}"] b`);
    await expect(avg('breakfast')).toHaveText('8.0/10');
    await expect(avg('bf_restaurant')).toHaveText('8.0/10');
    await expect(avg('bf_food')).toHaveText('7.5/10');
    await expect(avg('bf_service')).toHaveText('10.0/10');
    await expect(b.locator('.vendor-rg-avg[data-k="bf_atmosphere"]')).toHaveCount(0);
    // Breakfast reasons only, in question order, each ticked; the ride's and overall's are not offered.
    const why = b.locator('.vendor-rg-why');
    expect(await why.evaluateAll((els) => els.map((e) => e.getAttribute('data-k')))).toEqual(['breakfast', 'bf_restaurant', 'bf_food']);
    await expect(why.nth(0)).toContainText('Breakfast · 7/10');
    await expect(why.nth(0)).toContainText('Slow to serve');
    await expect(why.locator('input:checked')).toHaveCount(3);
    await expect(b).not.toContainText('Hidden Rider');
    await expect(b).not.toContainText('Too fast for me');
    await expect(b).not.toContainText('Long wait');
    await expect(b.locator('.vendor-rg-explain')).toHaveText('The vendor sees the averages and the reasons you tick, never riders’ names, the ride scores or their comments.');
    await why.nth(1).locator('input').uncheck();
    await b.locator('.vendor-rg-share').click();
    await expect.poll(() => calls.filter((c) => c.fn === 'staff_vendor_share_ratings').length).toBe(1);
    expect(calls.find((c) => c.fn === 'staff_vendor_share_ratings')!.body).toEqual({ p_booking: 20, p_comments: [{ e: 'r2', k: 'breakfast' }, { e: 'r1', k: 'bf_food' }], p_by: 'Spec Staff' });
    // Shared: what the vendor sees, with Share again and Stop sharing.
    await expect(b.locator('.vendor-rg-at')).toContainText('Shared on');
    await expect(b.locator('.vendor-rg-at')).toContainText('by Spec Staff');
    await expect(b.locator('.vendor-rg-share')).toHaveCount(0);
    await expect(b.locator('.vendor-rg-again')).toBeVisible();
    await expect(b.locator('.vendor-rg-stop')).toBeVisible();
  });

  test('a shared date shows what the vendor sees, keeps the shared ticks, and Stop sharing asks first', async ({ page }) => {
    const calls = await openDay(page, {
      vendor_shared_ratings: [{ booking_id: 20, venue_id: 1, day: rd, riders: 2, averages: { breakfast: 8, bf_food: 7.5 }, comments: [{ k: 'bf_food', text: 'Eggs were cold' }], shared_by: 'Huda Admin', shared_at: '2099-05-10T08:00:00Z' }],
    });
    const b = rgBlock(page);
    await expect(b.locator('.vendor-rg-at')).toContainText('by Huda Admin');
    const sees = b.locator('.vendor-rg-shared');
    await expect(sees).toContainText('What Bean Box sees');
    await expect(sees.locator('.vendor-rg-n')).toHaveText('Riders who rated the breakfast: 2');
    await expect(sees.locator('.vendor-rg-avg[data-k="bf_food"] b')).toHaveText('7.5/10');
    await expect(sees.locator('.vendor-rg-said')).toHaveCount(1);
    await expect(sees.locator('.vendor-rg-said')).toContainText('Eggs were cold');
    // The reasons left out last time stay unticked.
    await expect(b.locator('.vendor-rg-why[data-k="bf_food"] input')).toBeChecked();
    await expect(b.locator('.vendor-rg-why[data-k="breakfast"] input')).not.toBeChecked();
    await expect(b.locator('.vendor-rg-explain')).toHaveCount(0);
    await b.locator('.vendor-rg-stop').click();
    await expect(dialog(page)).toContainText('Stop sharing with Bean Box?');
    await dialog(page).getByRole('button', { name: 'Stop sharing' }).click();
    await expect.poll(() => calls.filter((c) => c.fn === 'staff_vendor_unshare_ratings').length).toBe(1);
    expect(calls.find((c) => c.fn === 'staff_vendor_unshare_ratings')!.body).toEqual({ p_booking: 20 });
    await expect(rgBlock(page).locator('.vendor-rg-shared')).toHaveCount(0);
    await expect(rgBlock(page).locator('.vendor-rg-share')).toBeVisible();
  });

  test('no rating yet: it says so and offers no share; the venue dialog and the Feedback card lead to it', async ({ page }) => {
    await openDay(page, { vendor_feedback: [fbRow({ booking_id: 20, day: rd })] });
    await dialog(page).locator('.ca-x').click();
    await page.evaluate(`_vendorDayOpen('${quiet}')`);
    await expect(rgBlock(page, 21).locator('.vendor-rg-none')).toHaveText('No rider has rated the breakfast yet.');
    await expect(rgBlock(page, 21).locator('button')).toHaveCount(0);
    await dialog(page).locator('.ca-x').click();
    await panel(page).locator('[data-vendor-view="venues"]').click();
    await panel(page).locator('.vendor-ven[data-vendor-ven="1"] .vendor-ven-open').click();
    await expect(rgBlock(page, 20).locator('.vendor-rg-n')).toHaveText('Riders who rated the breakfast: 2');
    await expect(rgBlock(page, 21).locator('.vendor-rg-none')).toBeVisible();
    await expect(dialog(page).locator('.vendor-rg[data-vendor-rg="12"]')).toHaveCount(0); // a date still to come
    await dialog(page).locator('.ca-x').click();
    await panel(page).locator('[data-vendor-view="feedback"]').click();
    await panel(page).locator('.vendor-fb[data-vendor-fb="20"] .vendor-fb-share').click();
    await expect(rgBlock(page, 20).locator('.vendor-rg-share')).toBeVisible();
    expect(await page.evaluate(() => /\p{Extended_Pictographic}/u.test(document.getElementById('confirm-modal')!.textContent || ''))).toBe(false);
  });
});
