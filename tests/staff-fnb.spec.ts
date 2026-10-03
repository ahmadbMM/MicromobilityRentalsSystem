import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// F&B Partners (owner, 2026-10-03): cafés and restaurants reserve the Saturdays our Saturday social
// ride's riders come to them for breakfast. Staff confirm one venue per date (the rest are declined
// by staff_fnb_decide), make the venues' logins and edit the tiers. Admin only; migration 20261003150000.

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
const base = { sessions, queue_entries: [], bikes: [], fnb_tiers: tiers, fnb_venues: venues, fnb_users: [], fnb_dates: dates, fnb_series: [], fnb_bookings: bookings };

type Call = { fn: string; body: Record<string, unknown> };
async function open(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { ...base, ...fixtures });
  await unlockStaff(page);
  const calls: Call[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/(staff_fnb_\w+)/);
    if (m && r.method() === 'POST') calls.push({ fn: m[1], body: r.postDataJSON() });
  });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('fnb')`);
  await expect(panel(page).locator('.fnb-body')).toBeVisible();
  return calls;
}
const panel = (page: Page) => page.locator('#tab-fnb');
const dialog = (page: Page) => page.locator('#confirm-modal');
const toMay = (page: Page) => page.evaluate(`S._fnb.month='2099-05';renderFnb()`);

test.describe('@staff:fnb F&B Partners', () => {
  test('the calendar paints the dates: open with requests waiting, confirmed with the venue, closed with the reason', async ({ page }) => {
    await open(page);
    const item = page.locator('#staff-tab-nav .tab-btn[data-stab="fnb"]');
    await expect(item).toHaveClass(/active/);
    await expect(item.locator('.tab-badge')).toHaveText('2');
    expect(new URL(page.url()).pathname).toBe('/partners');
    await toMay(page);
    const day = (d: string) => panel(page).locator(`.fnb-day[data-fnb-day="${d}"]`);
    await expect(day('2099-05-02')).toHaveClass(/st-open/);
    await expect(day('2099-05-02')).toContainText('2 pending');
    await expect(day('2099-05-09')).toHaveClass(/st-confirmed/);
    await expect(day('2099-05-09')).toContainText('Bean Box');
    await expect(day('2099-05-16')).toHaveClass(/st-closed/);
    await expect(day('2099-05-16')).toContainText('Ramadan');
    await expect(day('2099-05-23')).toHaveClass(/st-off/); // a Saturday not opened yet
    // The date's dialog: the ride's breakfast stop as it stands, the requests side by side.
    await day('2099-05-09').click();
    await expect(dialog(page).locator('.fnb-ride')).toContainText('Bean Box');
    await expect(dialog(page).locator('.fnb-bk[data-fnb-bk="12"]')).toContainText('Confirmed');
    await expect(dialog(page).locator('.fnb-bk[data-fnb-bk="12"] .fnb-cancel')).toBeVisible();
  });

  test('confirming a pending request calls staff_fnb_decide, the higher tier listed first', async ({ page }) => {
    const calls = await open(page);
    await panel(page).locator('[data-fnb-view="requests"]').click();
    expect(new URL(page.url()).pathname).toBe('/partners/requests');
    const grp = panel(page).locator('.fnb-grp[data-fnb-grp="2099-05-02"]');
    await expect(grp).toContainText('2 venues asking');
    // The higher tier first.
    await expect(grp.locator('.fnb-bk').first()).toContainText('Corniche Kitchen');
    await grp.locator('.fnb-bk[data-fnb-bk="11"] .fnb-confirm').click();
    await dialog(page).getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(() => calls.filter((c) => c.fn === 'staff_fnb_decide').length).toBe(1);
    expect(calls[0].body).toEqual({ p_booking: 11, p_action: 'confirm', p_note: '', p_by: 'Spec Staff' });
  });

  test('adding a login shows the temporary password once, with a WhatsApp message', async ({ page }) => {
    const calls = await open(page, { 'rpc:staff_fnb_user_add': { id: 7, login: 'huda@beanbox.sa', password: 'Tmp9-Kq4m' } });
    await panel(page).locator('[data-fnb-view="venues"]').click();
    await panel(page).locator('.fnb-ven[data-fnb-ven="1"] .fnb-ven-open').click();
    await dialog(page).locator('#fnb-u-login').fill('Huda@BeanBox.sa');
    await dialog(page).locator('#fnb-u-name').fill('Huda Saleh');
    await dialog(page).locator('.fnb-u-add').click();
    await expect.poll(() => calls.filter((c) => c.fn === 'staff_fnb_user_add').length).toBe(1);
    expect(calls[0].body).toEqual({ p_venue: 1, p_login: 'Huda@BeanBox.sa', p_name: 'Huda Saleh', p_role: 'manager' });
    await expect(dialog(page).locator('.fnb-pw-val')).toHaveText('Tmp9-Kq4m');
    const msg = dialog(page).locator('#fnb-pw-text');
    await expect(msg).toContainText('Login: huda@beanbox.sa');
    await expect(msg).toContainText('Temporary password: Tmp9-Kq4m');
    await expect(msg).toContainText('the first time you sign in');
    await expect(msg).toContainText('Sign in here: https://vendors.micromobility.sa');
    await expect(dialog(page).locator('a.fnb-pw-wa')).toHaveAttribute('href', /^https:\/\/wa\.me\/966551234567\?text=Hello%20Huda/);
    await dialog(page).locator('#fnb-pw-lang').selectOption('ar');
    await expect(msg).toContainText('كلمة المرور المؤقتة: Tmp9-Kq4m');
    await expect(dialog(page).locator('tr[data-fnb-user="7"]')).toContainText('huda@beanbox.sa');
    // Closed and opened again: the password is gone.
    await dialog(page).locator('.ca-x').click();
    await panel(page).locator('.fnb-ven[data-fnb-ven="1"] .fnb-ven-open').click();
    await expect(dialog(page).locator('tr[data-fnb-user="7"]')).toBeVisible();
    await expect(dialog(page).locator('.fnb-pw')).toHaveCount(0);
  });

  test('a tier saves its booking types and benefits', async ({ page }) => {
    const calls = await open(page);
    await panel(page).locator('[data-fnb-view="tiers"]').click();
    const card = panel(page).locator('.fnb-tier[data-fnb-tier="recurring"]');
    await card.locator('input[data-fnb-mode="multi"]').uncheck();
    await card.locator('.fnb-ben-add').click();
    await card.locator('[data-fnb-ben="1"] input[data-fnb-ben-l="en"]').fill('Free coffee for the ride leader');
    await card.locator('[data-fnb-ben="1"] input[data-fnb-ben-l="ar"]').fill('قهوة مجانية لقائد الجولة');
    await card.locator('[data-fnb-ben="1"] .fnb-up').click(); // the new one first
    await card.locator('#fnb-t-recurring-max_per_month').fill('');
    await card.locator('.fnb-tier-save').click();
    await expect.poll(() => calls.filter((c) => c.fn === 'staff_fnb_tier_save').length).toBe(1);
    const p = calls[0].body.p as Record<string, unknown>;
    expect(p.modes).toEqual(['single', 'recurring']);
    expect(p.benefits).toEqual([{ en: 'Free coffee for the ride leader', ar: 'قهوة مجانية لقائد الجولة' }, { en: 'Logo on the ride poster', ar: 'الشعار على ملصق الجولة' }]);
    expect(p.max_per_month).toBe('');
    expect(p).toMatchObject({ id: 'recurring', horizon_days: 365, priority: 3 });
  });

  test('before the database update it says so, instead of failing', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
    await page.route(/\/rest\/v1\/fnb_\w+(\?|$)/, (r) => r.fulfill({
      status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.fnb_tiers' in the schema cache" }),
    }));
    await unlockStaff(page);
    await page.goto('/partners');
    await waitForSb(page);
    await page.waitForFunction(() => S.view === 'staff' && S.staffTab === 'fnb');
    await expect(panel(page).locator('.fnb-not-set-up')).toContainText("isn’t set up yet");
  });

  test('Front Desk does not have it', async ({ page }) => {
    await open(page);
    await page.evaluate(`S.staffRole='frontdesk';renderStaffTabs();setStaffTab('fnb')`);
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="fnb"]')).toHaveCSS('display', 'none');
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
  fnb_bookings: [
    ...bookings,
    bk({ id: 13, venue_id: 2, day: '2099-04-25', status: 'confirmed' }),
    bk({ id: 14, venue_id: 2, day: ksa(-3), status: 'confirmed' }), // no feedback yet, still within the 14 days
    bk({ id: 15, venue_id: 1, day: ksa(-30), status: 'confirmed' }), // no feedback, and too late for it: not waited on
    bk({ id: 16, venue_id: 2, day: ksa(-10), status: 'confirmed' }),
  ],
  fnb_feedback: [
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
  await panel(page).locator('[data-fnb-view="feedback"]').click();
  return calls;
}

test.describe('@staff:fnb F&B Partners feedback', () => {
  test('the Feedback tab lists it newest breakfast first: stars, turnout beside the booked riders, the two answers', async ({ page }) => {
    await openFeedback(page);
    expect(new URL(page.url()).pathname).toBe('/partners/feedback');
    const cards = panel(page).locator('.fnb-fb');
    await expect(cards).toHaveCount(3);
    expect(await cards.evaluateAll((els) => els.map((e) => e.getAttribute('data-fnb-fb')))).toEqual(['12', '13', '16']);
    const c = panel(page).locator('.fnb-fb[data-fnb-fb="12"]');
    await expect(c).toContainText('Bean Box');
    await expect(c.locator('.fnb-stars .fnb-sr')).toHaveText('4 of 5');
    await expect(c.locator('.fnb-star.on')).toHaveCount(4);
    await expect(c.locator('.fnb-star')).toHaveCount(5);
    await expect(c.locator('.fnb-fb-turn')).toContainText('Riders who came 18');
    await expect(c.locator('.fnb-fb-booked')).toHaveText('2 booked on the ride');
    await expect(c.locator('.fnb-fb-well')).toContainText('Quick service, everyone seated together');
    await expect(c.locator('.fnb-fb-better')).toContainText('Tell us the head count a day earlier');
    await expect(c.locator('.fnb-fb-at')).toContainText('Sent');
    await expect(c.locator('.fnb-fb-at')).toContainText('edited');
    // No count from the venue, no ride held for that date, nothing under "went well".
    const o = panel(page).locator('.fnb-fb[data-fnb-fb="13"]');
    await expect(o.locator('.fnb-fb-turn')).toContainText('Not given');
    await expect(o.locator('.fnb-fb-booked')).toHaveCount(0);
    await expect(o.locator('.fnb-fb-well')).toHaveCount(0);
    await expect(o.locator('.fnb-fb-at')).not.toContainText('edited');
    await expect(panel(page).locator('.fnb-fb-avg')).toHaveText('Average 3.7 of 5');
    await expect(panel(page).locator('.fnb-fb-n')).toHaveText('Feedback received: 3');
    await expect(panel(page).locator('.fnb-fb-wait')).toHaveText('Waiting for feedback: 1 breakfasts');
    expect(await page.evaluate(() => /\p{Extended_Pictographic}/u.test(document.getElementById('tab-fnb')!.textContent || ''))).toBe(false);
  });

  test('the rating, venue and search filters narrow it, and the average follows', async ({ page }) => {
    await openFeedback(page);
    const ids = () => panel(page).locator('.fnb-fb').evaluateAll((els) => els.map((e) => e.getAttribute('data-fnb-fb')));
    await panel(page).locator('.fnb-fb-rf [data-fnb-f="high"]').click();
    await expect.poll(ids).toEqual(['12', '16']);
    await expect(panel(page).locator('.fnb-fb-avg')).toHaveText('Average 4.5 of 5');
    await panel(page).locator('.fnb-fb-rf [data-fnb-f="low"]').click();
    await expect.poll(ids).toEqual(['13']);
    await panel(page).locator('.fnb-fb-rf [data-fnb-f="mid"]').click();
    await expect(panel(page).locator('.fnb-fb')).toHaveCount(0);
    await expect(panel(page).locator('#fnb-list .empty-state')).toHaveText('No feedback matches the filters.');
    await panel(page).locator('.fnb-fb-rf [data-fnb-f="all"]').click();
    await panel(page).locator('#fnb-fb-ven').selectOption('2');
    await expect.poll(ids).toEqual(['13', '16']);
    await expect(panel(page).locator('.fnb-fb-rf [data-fnb-f="high"]')).toContainText('(1)');
    await panel(page).locator('#fnb-fb-ven').selectOption('all');
    await expect.poll(ids).toEqual(['12', '13', '16']);
    const fold = panel(page).locator('[data-srch="fnbf"] .srch-btn'); // a phone folds the search into a button
    if (await fold.isVisible()) await fold.click();
    await panel(page).locator('#fnbf-q').fill('head count');
    await expect.poll(ids).toEqual(['12']);
    await expect(panel(page).locator('.fnb-fb-n')).toHaveText('Feedback received: 1');
  });

  test('the date dialog shows the confirmed venue’s feedback; the venue dialog puts stars beside its past bookings', async ({ page }) => {
    await open(page, fbFix);
    await toMay(page);
    await panel(page).locator('.fnb-day[data-fnb-day="2099-05-09"]').click();
    const fb = dialog(page).locator('.fnb-fb[data-fnb-fb="12"]');
    await expect(fb).toBeVisible();
    await expect(dialog(page)).toContainText('Venue feedback');
    await expect(fb.locator('.fnb-sr')).toHaveText('4 of 5');
    await expect(fb).toContainText('Quick service, everyone seated together');
    await expect(fb).toContainText('Tell us the head count a day earlier');
    // A date without feedback has no such block.
    await dialog(page).locator('.ca-x').click();
    await panel(page).locator('.fnb-day[data-fnb-day="2099-05-02"]').click();
    await expect(dialog(page).locator('.fnb-bk').first()).toBeVisible();
    await expect(dialog(page).locator('.fnb-fb')).toHaveCount(0);
    await dialog(page).locator('.ca-x').click();
    await panel(page).locator('[data-fnb-view="venues"]').click();
    await panel(page).locator('.fnb-ven[data-fnb-ven="2"] .fnb-ven-open').click();
    await expect(dialog(page).locator('[data-fnb-vbk="16"] .fnb-sr')).toHaveText('5 of 5');
    await expect(dialog(page).locator('[data-fnb-vbk="14"] .fnb-stars')).toHaveCount(0); // past, no feedback yet
    await expect(dialog(page).locator('[data-fnb-vbk="13"] .fnb-stars')).toHaveCount(0); // still to come
  });

  test('before its database update the Feedback tab says so calmly, and the other tabs keep working', async ({ page }) => {
    await stubSupabase(page, { ...base, ...fbFix });
    await page.route(/\/rest\/v1\/fnb_feedback(\?|$)/, (r) => r.fulfill({
      status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.fnb_feedback' in the schema cache" }),
    }));
    await unlockStaff(page);
    await page.goto('/partners/feedback');
    await waitForSb(page);
    await page.waitForFunction(() => S.view === 'staff' && S.staffTab === 'fnb');
    await expect(panel(page).locator('.fnb-fb-missing')).toHaveText('Feedback appears here once the database update is applied.');
    await expect(panel(page).locator('.fnb-retry')).toHaveCount(0);
    await panel(page).locator('[data-fnb-view="requests"]').click();
    await expect(panel(page).locator('.fnb-grp[data-fnb-grp="2099-05-02"]')).toContainText('2 venues asking');
    await panel(page).locator('[data-fnb-view="calendar"]').click();
    await toMay(page);
    await panel(page).locator('.fnb-day[data-fnb-day="2099-05-09"]').click();
    await expect(dialog(page).locator('.fnb-bk[data-fnb-bk="12"]')).toContainText('Confirmed');
    await expect(dialog(page).locator('.fnb-fb')).toHaveCount(0);
  });
});
