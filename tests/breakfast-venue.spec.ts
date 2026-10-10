import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, rateGateOn } from './helpers/supabase';

// The breakfast stop by name (the owner, 2026-10-05: "add the restaurant's name in the session whenever it's
// added and in the reports and ratings and when asking the customers to rate"): a Saturday social ride with a
// breakfast venue says "Breakfast at <venue>" on its date card, the single-date view and Details, on the staff
// ride chip, Sessions card and detail, in the reports (riders, session, close-out, day sheet), on each rating
// in Analytics and its picture, and in the rating form's breakfast question. The Arabic page shows the venue's
// Arabic name when a venue booked on the vendor portal brought one.

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const SAT = '2099-10-24';
const sat = (extra: Record<string, unknown> = {}) => ({
  id: SAT, session_date: SAT, day: 'Saturday', status: 'open', capacity: 20, spots: 20, created_at: 1, event_kind: 'community',
  ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: true, bike_slots: '{"_time":"06:00 - 06:30"}',
  breakfast_name: 'Harbour Cafe', breakfast_name_ar: 'مقهى الميناء', ...extra,
});
const sat2 = { ...sat({ breakfast_name: null, breakfast_name_ar: null }), id: '2099-10-31', session_date: '2099-10-31' };

test.describe('@customer:bf the breakfast venue on the rider’s side', () => {
  async function member(page: Page, sessions: unknown[]) {
    await stubSupabase(page, { sessions, queue_entries: [], 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', birth_date: '1995-05-05' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('goLanding()');
  }

  test('the date card names the venue once one is set, in Arabic by its Arabic name', async ({ page }) => {
    await member(page, [sat(), sat2]);
    await page.evaluate(`selectEvent('community')`);
    const card = (d: string) => page.locator('#tab-register .sess-day').filter({ hasText: d }).locator('.sess-card'); // the date is the day's heading
    await expect(page.locator('#tab-register .sess-card')).toHaveCount(2);
    await expect(page.locator('#tab-register .sess-card .sess-card-bf')).toHaveCount(1);
    await expect(page.locator('#tab-register .sess-card-bf')).toHaveText('Breakfast at Harbour Cafe');
    // the venue set while the page is open: the next draw shows it
    await page.evaluate(`(()=>{const s=S.sessions.find(x=>x.id==='2099-10-31');s.breakfast_name='Pier Bakery';renderRegister();})()`);
    await expect(page.locator('#tab-register .sess-card-bf')).toHaveCount(2);
    await expect(card('31 Oct').locator('.sess-card-bf')).toHaveText('Breakfast at Pier Bakery');
    // Details says it too
    await page.evaluate(`showSessInfo('${SAT}')`);
    await expect(page.locator('#bike-info-modal .ev-info-facts')).toContainText('Breakfast at Harbour Cafe');
    await page.evaluate('closeEventInfo()');
    await page.evaluate(`setLang('ar')`);
    await expect.poll(() => page.evaluate(`t('infoBreakfastAt')`)).toBe('الإفطار في {0}');
    await page.evaluate('renderRegister()');
    await expect(page.locator(`#tab-register .sess-card-bf`).first()).toHaveText('الإفطار في مقهى الميناء');
    // a venue with no Arabic name reads by its own name
    await expect(page.locator('#tab-register .sess-card-bf').nth(1)).toHaveText('الإفطار في Pier Bakery');
  });

  test('the rating form asks about breakfast at the venue', async ({ page }) => {
    const ride = { id: 'q1', name: 'Sara Haddad', customer_id: 'c1', session_id: 's-' + today, session_day: 'Saturday', session_date: today, queue_num: 1,
      status: 'done', paid: true, price: 0, checked_out_at: today + 'T05:00:00Z', registered_at: today + 'T04:00:00Z', approval: 'approved' };
    const s = sat({ id: 's-' + today, session_date: today, status: 'closed' });
    await stubSupabase(page, { sessions: [s], queue_entries: [ride], 'rpc:my_bookings': [ride], 'rpc:customer_booking_update': true });
    await rateGateOn(page);
    await loginCustomer(page, { id: 'c1' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.view='customer'; setCustTab('myrides')`);
    const m = page.locator('#rate-modal');
    await expect(m.locator('#rgl-breakfast')).toHaveText('Breakfast at Harbour Cafe');
    await expect(m.locator('#rgl-bf_restaurant')).toHaveText('Restaurant');
    // "I did not stay for breakfast" keeps the venue's name on the box
    await m.locator('.rg-skip').click();
    await expect(m.locator('.rg-grp .rg-lbl', { hasText: 'Breakfast at' })).toHaveText('Breakfast at Harbour Cafe');
  });
});

test.describe('@staff:bookings the breakfast venue on the staff side', () => {
  const T0 = Date.now();
  const ago = (h: number) => new Date(T0 - h * 36e5).toISOString();
  const row = (id: string, x: Record<string, unknown> = {}) => ({
    id, session_id: SAT, session_day: 'Saturday', session_date: SAT, queue_num: 1, name: 'Rider ' + id, phone: '0550000001', customer_id: 'c-' + id,
    type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 0, registered_at: '2099-10-01T10:00:00Z', approval: 'approved', ...x,
  });
  async function staff(page: Page, sessions: unknown[], queue: unknown[]) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await stubSupabase(page, { sessions, queue_entries: queue, bikes: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
  }
  const printed = (page: Page, call: string) => page.evaluate(`(()=>{let h='';const o=window._openReport;window._openReport=(x)=>{h=x;return {};};try{${call};}finally{window._openReport=o;}return h;})()`) as Promise<string>;

  test('the ride chip, the Sessions card and its detail name the venue', async ({ page }) => {
    await staff(page, [sat(), sat2], [row('a')]);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${SAT}';renderStaffQueue()`);
    await expect(page.locator(`#sess-strip .sess-summary-chip[data-on-click*='"setSfSession","${SAT}"'] .sess-chip-bf`)).toHaveText('Breakfast at Harbour Cafe');
    await expect(page.locator(`#sess-strip .sess-summary-chip[data-on-click*='"setSfSession","2099-10-31"'] .sess-chip-bf`)).toHaveCount(0);
    await page.evaluate(`S.queueView='sessions';S.selSessionDetail='${SAT}';renderStaffQueue()`);
    await expect(page.locator('#sess-host .sess-lc .sess-lc-bf')).toHaveText('Breakfast at Harbour Cafe');
    await expect(page.locator('#sess-host .sess-detail-bf')).toHaveText('Breakfast at Harbour Cafe');
  });

  test('the reports name the venue: riders, session, close-out and the day sheet', async ({ page }) => {
    const todaySat = sat({ id: today, session_date: today });
    await staff(page, [todaySat], [row('a', { session_id: today, session_date: today })]);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${today}';renderStaffQueue()`);
    // a Saturday ride's session report is its riders' roster (printCommunityRoster)
    expect(await printed(page, `printSessionReport()`)).toContain('Breakfast at Harbour Cafe');
    expect(await printed(page, `printDaySheet()`)).toContain('Breakfast at Harbour Cafe');
    expect(await printed(page, `S._ctSession='${today}';printCloseout()`)).toContain('Breakfast at Harbour Cafe');
  });

  test('each rating in Analytics, and its picture, says where the rider had breakfast', async ({ page }) => {
    const done = row('r1', {
      status: 'done', paid: true, checked_in_at: ago(30), checked_out_at: ago(28), rated_at: ago(2), rating_exp: 9, rating_bike: 8,
      session_id: 's-sat', session_date: new Date(T0 - 2 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' }),
      rating_detail: { form: 'social', s: { ride: 9, ride_checkin: 10, ride_staff: 9, ride_bike: 8, ride_route: 10, breakfast: 9, bf_restaurant: 9, bf_atmosphere: 9, bf_food: 9, bf_service: 9, overall: 9 }, why: {} },
    });
    const s = sat({ id: 's-sat', session_date: done.session_date as string, status: 'closed' });
    await staff(page, [s], [done]);
    await page.waitForFunction(`S.dataLoaded&&getQueue().length===1`);
    await page.evaluate(`(() => { window.__drawn = []; const f = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (s, ...a) { window.__drawn.push(String(s)); return f.call(this, s, ...a); }; })()`);
    await page.evaluate(`setStaffTab('analytics');setAnView('ratings')`);
    const card = page.locator('#tab-analytics .an-rate-card');
    await expect(card).toHaveCount(1);
    await expect(card.locator('.an-rate-meta')).toContainText('Breakfast at Harbour Cafe');
    await expect(card.locator('.an-rg-row').filter({ hasText: 'Breakfast at Harbour Cafe' })).toHaveCount(1);
    await page.evaluate(`_rsDraw(getQueue()[0],'full')`);
    const drawn = await page.evaluate('window.__drawn') as string[];
    expect(drawn.some((x) => x.includes('Breakfast at Harbour Cafe'))).toBe(true);
  });
});
