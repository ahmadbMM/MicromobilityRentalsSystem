import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The owner, 2026-10-03: "you can't book anything without agreeing" - literally. The workshop and
// the ticketed event used to skip the waiver; every kind now has one of three: the ride waiver
// (a bike), the swim waiver (the pool) and the activity waiver (anything else). The database refuses
// a customer booking with none (WAIVER_REQUIRED), and the rider is sent back to agree.

const d = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const WS = d(5) + '-tw', EV = d(4) + '-ev', SWIM = d(6) + '-sw';
const sessions = [
  { id: WS, day: 'Tuesday', session_date: d(5), capacity: 30, spots: 30, status: 'open', created_at: 3,
    event_kind: 'community', ride_kind: 'workshop', needs_approval: true, hide_queue: true, paid_ride: false,
    open_to_all: true, title: 'Micromobility Triathlon Workshop', bike_slots: '{"_time":"18:00 - 20:00","_total":30}' },
  { id: EV, day: 'Friday', session_date: d(4), capacity: 30, spots: 30, status: 'open', created_at: 2,
    event_kind: 'community', ride_kind: 'event', paid_ride: true, price: 40, open_to_all: true, needs_approval: false,
    hide_queue: true, title: 'Bike maintenance class', bike_slots: '{"_time":"19:00 - 21:00"}' },
  { id: SWIM, day: 'Thursday', session_date: d(6), capacity: 20, spots: 20, status: 'open', created_at: 1,
    event_kind: 'community', ride_kind: 'swim', needs_approval: true, hide_queue: true, paid_ride: false,
    title: 'Triathlon Pool Session', bike_slots: '{"_time":"18:00 - 19:30","_total":20}' },
];

async function boot(page: Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], 'rpc:community_member': true, ...extra });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true`);
}
function bookings(page: Page) {
  const posts: Record<string, unknown>[][] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rpc/customer_create_booking')) posts.push(JSON.parse(r.postData() || '{}').p_entries);
  });
  return posts;
}
async function toWaiver(page: Page, ev: string, id: string) {
  await page.evaluate(`S.selEvent='${ev}';goCustomer('register');S.regStep=1;renderRegister();S.selSession='${id}';S.regQty=1;ensureBikeSizes();regNextFromSession()`);
  // An event asks how many seats first (up to five, 2026-10-04); the others go straight to the waiver.
  if (ev === 'event') {
    expect(await page.evaluate('S.regStep')).toBe(2);
    await page.evaluate('regNextToReview()');
  }
  expect(await page.evaluate('S.regStep')).toBe(2.5);
}

test.describe('@customer:reserve activity waiver', () => {
  for (const [label, ev, id] of [['a workshop', 'workshop', WS], ['an event', 'event', EV]] as const) {
    test(`${label} shows the Activity waiver, will not continue unticked, and posts its version`, async ({ page }) => {
      await boot(page);
      const posts = bookings(page);
      await toWaiver(page, ev, id);
      const panel = page.locator('#tab-register');
      await expect(panel).toContainText('Activity waiver');
      await expect(panel).not.toContainText('Ride waiver');
      await expect(panel).not.toContainText('Swim waiver');
      await expect(panel).toContainText('Every activity we run carries some risk.');
      await expect(panel).toContainText('I agree to follow the team’s and the venue’s instructions.');
      await expect(panel).toContainText('I have read the waiver and agree on behalf of everyone on this booking');
      await expect(panel.locator('.reg-stepper')).toHaveAttribute('aria-label', ev === 'event' ? 'Step 3 of 4' : 'Step 2 of 3');
      // unticked: the button is off, and even called directly the step stays put
      await expect(panel.locator('.mm-reg-foot .btn-primary')).toBeDisabled();
      await page.evaluate(`regWaiverContinue()`);
      expect(await page.evaluate('S.regStep')).toBe(2.5);
      // nor does a submit from here post an acceptance nobody gave
      await page.evaluate(`submitReg()`);
      expect(await page.evaluate('S.regStep')).toBe(2.5);
      expect(posts).toHaveLength(0);
      await panel.locator('input[type="checkbox"]').check();
      await panel.locator('.mm-reg-foot .btn-primary').click();
      expect(await page.evaluate('S.regStep')).toBe(3);
      await page.evaluate(`submitReg()`);
      await expect.poll(() => posts.length, { timeout: 6000 }).toBeGreaterThan(0);
      expect(posts[0][0].waiver_version).toBe('activity-2026-10-v2');
    });
  }

  test('a swim still gets the swim waiver and posts its version', async ({ page }) => {
    await boot(page);
    const posts = bookings(page);
    await toWaiver(page, 'community', SWIM);
    const panel = page.locator('#tab-register');
    await expect(panel).toContainText('Swim waiver');
    await expect(panel).toContainText('I confirm that I can swim unaided');
    await expect(panel).not.toContainText('Activity waiver');
    await page.evaluate(`toggleWaiver(true);regWaiverContinue();submitReg()`);
    await expect.poll(() => posts.length, { timeout: 6000 }).toBeGreaterThan(0);
    expect(posts[0][0].waiver_version).toBe('swim-2026-10-v3');
  });

  test('the Arabic activity waiver reads as the owner wrote it', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setLang('ar')`);
    await toWaiver(page, 'workshop', WS);
    const panel = page.locator('#tab-register');
    await expect(panel).toContainText('إقرار المشاركة');
    await expect(panel).toContainText('كل نشاط ننظّمه ينطوي على قدر من المخاطر');
  });

  test('a booking the database refuses for its waiver (WAIVER_REQUIRED) goes back to the waiver step', async ({ page }) => {
    await boot(page, { 'rpc:customer_create_booking': { __rpcError: { status: 400, code: 'P0001', message: 'WAIVER_REQUIRED' } } });
    const posts = bookings(page);
    await toWaiver(page, 'workshop', WS);
    await page.evaluate(`toggleWaiver(true);regWaiverContinue()`);
    expect(await page.evaluate('S.regStep')).toBe(3);
    await page.evaluate(`submitReg()`);
    await expect.poll(() => posts.length, { timeout: 6000 }).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate('S.regStep')).toBe(2.5);
    expect(await page.evaluate('S.waiverOk')).toBe(false);
    await expect(page.locator('.toast').filter({ hasText: 'Please accept the waiver to continue.' })).toBeVisible();
    await expect(page.locator('#tab-register')).toContainText('Activity waiver');
    await expect(page.locator('#tab-register .mm-reg-foot .btn-primary')).toBeDisabled();
    // the raw code never reaches the screen
    await expect(page.locator('.toast').filter({ hasText: 'WAIVER_REQUIRED' })).toHaveCount(0);
  });

  test('a booking queued offline without a waiver, refused on sync, leaves the outbox and re-asks on that ride', async ({ page }) => {
    await boot(page, { 'rpc:customer_create_booking': { __rpcError: { status: 400, code: 'P0001', message: 'WAIVER_REQUIRED' } } });
    await page.evaluate(`goCustomer('register');
      _bookOutboxAdd({id:'ob1',session_id:'${WS}',session_day:'Tuesday',session_date:'${d(5)}',queue_num:1,name:'Spec Rider',
        type_preference:'None',size:'',status:'waiting',paid:false,price:0,registered_at:new Date().toISOString(),customer_id:'c1'});
      _applyBookOutbox();`);
    await page.evaluate(`_bookOutboxFlush()`);
    await expect.poll(() => page.evaluate('_bookOutboxCount()')).toBe(0);
    expect(await page.evaluate(`getQueue().some(e=>e.id==='ob1')`)).toBe(false);
    expect(await page.evaluate('[S.custTab,S.selSession,S.regStep,S.regQty]')).toEqual(['register', WS, 2.5, 1]);
    await expect(page.locator('#tab-register')).toContainText('Activity waiver');
    await expect(page.locator('.toast').filter({ hasText: 'Please accept the waiver to continue.' })).toBeVisible();
  });

  test('two rides queued offline and refused: the second waits in the outbox and is re-asked once the first form is left', async ({ page }) => {
    await boot(page, { 'rpc:customer_create_booking': { __rpcError: { status: 400, code: 'P0001', message: 'WAIVER_REQUIRED' } } });
    const row = (id: string, sess: string, day: string, date: string) => `{id:'${id}',session_id:'${sess}',session_day:'${day}',session_date:'${date}',queue_num:1,name:'Spec Rider',
        type_preference:'None',size:'',status:'waiting',paid:false,price:0,registered_at:new Date().toISOString(),customer_id:'c1'}`;
    await page.evaluate(`goCustomer('register');
      _bookOutboxAdd(${row('ob1', WS, 'Tuesday', d(5))});_bookOutboxAdd(${row('ob2', EV, 'Friday', d(4))});
      _applyBookOutbox();`);
    await page.evaluate(`_bookOutboxFlush()`);
    // the first ride is re-asked; the second stays queued and on screen (it used to leave the outbox unasked)
    await expect.poll(() => page.evaluate('_bookOutboxCount()')).toBe(1);
    expect(await page.evaluate(`[_bookOutbox()[0].id,getQueue().some(e=>e.id==='ob2'),S.selSession]`)).toEqual(['ob2', true, WS]);
    // a flush while the rider is still on that form does not re-ask over it
    await page.evaluate(`_bookOutboxFlush()`);
    await page.waitForTimeout(300);
    expect(await page.evaluate('[_bookOutboxCount(),S.selSession]')).toEqual([1, WS]);
    // once the form is left, the next flush re-asks the second ride
    await page.evaluate(`S.custTab='bookings';_bookOutboxFlush()`);
    await expect.poll(() => page.evaluate('_bookOutboxCount()')).toBe(0);
    expect(await page.evaluate('[S.custTab,S.selSession,getQueue().some(e=>e.id==="ob2")]')).toEqual(['register', EV, false]);
  });
});
