import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The waiver sits on the review, above Confirm (since 2026-10-10; it was a step of its own between the
// riders and the review). One person taps the box for the whole party, and the copy they accept says so — "on behalf of every rider on this
// booking" — because a booking takes up to ten riders and only the account holder is here.
//
// What must hold: Confirm cannot be passed unticked (nor submitReg called around it), the
// agreement does not survive into the next booking, and what reaches the server is a
// VERSION (which wording) rather than a timestamp the client chose.

const S1 = '2099-02-01';
const sessions = [{
  id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 10, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":10}',
}];

async function toRiders(page: import('@playwright/test').Page) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true`);
  // heights are what validateRegInputs actually gates on, so a rider must be fillable
  await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='${S1}';S.regStep=2;
    S.regQty=1;S.regRiderNames=['Spec Rider'];S.regBikeHeights=['175'];S.regBikeTypes=['Road'];ensureBikeSizes();renderRegister()`);
}

/** Fill n riders so the step can be left. */
async function withRiders(page: import('@playwright/test').Page, n: number) {
  const names = JSON.stringify(Array.from({ length: n }, (_, i) => 'Rider ' + (i + 1)));
  const hs = JSON.stringify(Array.from({ length: n }, () => '175'));
  const ty = JSON.stringify(Array.from({ length: n }, () => 'Road'));
  await page.evaluate(`S.regQty=${n};S.regRiderNames=${names};S.regBikeHeights=${hs};S.regBikeTypes=${ty};ensureBikeSizes();renderRegister()`);
}

test('the riders step leads to the review, and the waiver is on it', async ({ page }) => {
  await toRiders(page);
  await page.evaluate(`regNextToReview()`);
  expect(await page.evaluate('S.regStep')).toBe(3);
  await expect(page.locator('#reg-waiver')).toContainText('Ride waiver');
  // The owner's terms (2026-10-03): no booking without agreeing, and the rider alone answers for
  // themselves and their belongings, injuries, fractures, loss and theft included.
  await expect(page.locator('#tab-register')).toContainText('You cannot book any ride or activity with MicroMobility until you have read and agreed to this waiver');
  await expect(page.locator('#tab-register')).toContainText('I alone am responsible for myself, my safety and my personal belongings');
  await expect(page.locator('#tab-register')).toContainText('including any injury, fracture, illness, loss, theft or damage');
});

test('confirm is refused until the box is ticked', async ({ page }) => {
  await toRiders(page);
  const rpc: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/rpc/customer_create_booking')) rpc.push(r.url()); });
  await page.evaluate(`regNextToReview()`);

  const confirm = page.locator('#tab-register .mm-reg-foot .btn-primary');
  await expect(confirm).toBeDisabled();
  await expect(page.locator('#wv-why')).toBeVisible();

  // even called directly, nothing is booked: the rider is shown the waiver
  await page.evaluate(`submitReg()`);
  expect(await page.evaluate('S.regStep')).toBe(3);
  await expect(page.locator('.toast')).toContainText(/tick the waiver/i);
  await expect(page.locator('#reg-waiver-cb')).toBeFocused();
  await page.waitForTimeout(300);
  expect(rpc).toEqual([]);
});

test('ticking it turns Confirm on', async ({ page }) => {
  await toRiders(page);
  await page.evaluate(`regNextToReview()`);
  await page.locator('#reg-waiver-cb').check();
  expect(await page.evaluate('S.waiverOk')).toBe(true);
  await expect(page.locator('#tab-register .mm-reg-foot .btn-primary')).toBeEnabled();
  await expect(page.locator('#wv-why')).toHaveCount(0);
});

test('going back from review lands on the riders', async ({ page }) => {
  await toRiders(page);
  await page.evaluate(`regNextToReview();toggleWaiver(true)`);
  expect(await page.evaluate('S.regStep')).toBe(3);
  await page.locator('#tab-register .mm-reg-foot .btn-secondary').click();
  expect(await page.evaluate('S.regStep')).toBe(2);
});

// The waiver was a step of its own from 2026-09-30 to 2026-10-10; it is part of the review now, so the
// stepper counts three steps and an old saved step (2.5) lands on the review.
test('the stepper counts three steps, and an old waiver step opens the review', async ({ page }) => {
  await toRiders(page);
  await page.evaluate(`regNextToReview()`);
  const label = await page.getAttribute('#tab-register .reg-stepper', 'aria-label');
  expect(label).toBe('Step 3 of 3');
  await page.evaluate(`S.regStep=2.5;renderRegister()`);
  expect(await page.evaluate('S.regStep')).toBe(3);
  await expect(page.locator('#reg-waiver')).toBeVisible();
  await expect(page.locator('#tab-register .reg-stepper [aria-current="step"]')).toHaveCount(1);
});

test('what reaches the server is the version, and the booking carries it', async ({ page }) => {
  await toRiders(page);
  const rpc: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rpc/customer_create_booking')) rpc.push(r.postData() || '');
  });
  await page.evaluate(`regNextToReview();toggleWaiver(true);submitReg()`);
  await expect.poll(() => rpc.length, { timeout: 6000 }).toBeGreaterThan(0);
  const sent = JSON.parse(rpc[0]);
  expect(sent.p_entries[0].waiver_version).toBe('2026-10-v3');
  // the client never sends a time: a timestamp the caller picks is not evidence
  expect(JSON.stringify(sent)).not.toContain('waiver_at');
});

test('every rider on a party booking carries the version, not just the first', async ({ page }) => {
  await toRiders(page);
  const rpc: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rpc/customer_create_booking')) rpc.push(r.postData() || '');
  });
  await withRiders(page, 3);
  await page.evaluate(`regNextToReview();toggleWaiver(true);submitReg()`);
  await expect.poll(() => rpc.length, { timeout: 6000 }).toBeGreaterThan(0);
  const entries = JSON.parse(rpc[0]).p_entries as Record<string, unknown>[];
  expect(entries.length).toBe(3);
  for (const e of entries) expect(e.waiver_version).toBe('2026-10-v3');
});

test('the agreement does not carry into the next booking', async ({ page }) => {
  await toRiders(page);
  await page.evaluate(`toggleWaiver(true)`);
  expect(await page.evaluate('S.waiverOk')).toBe(true);
  await page.evaluate(`resetRegForm&&resetRegForm()`).catch(() => {});
  await page.evaluate(`S.regBikeSizes=[];S.regBikeHeights=[];S.regBikeTypes=[];S.regRiderNames=[];S.regQty=1;S.regType=null;S.selSession=null;S.lastTickets=[];S._alreadyBookedSession=null;S.regSubmitting=false;S.waiverOk=false;`);
  expect(await page.evaluate('S.waiverOk')).toBe(false);
});

test('the waiver names who is covered, in both languages', async ({ page }) => {
  await toRiders(page);
  await page.evaluate(`regNextToReview()`);
  await expect(page.locator('#tab-register')).toContainText('on behalf of every rider on this booking');
  await page.evaluate(`setLang('ar')`);
  await page.waitForTimeout(600);
  await expect(page.locator('#tab-register')).toContainText('نيابةً عن كل راكب في هذا الحجز');
  await expect(page.locator('#tab-register')).toContainText('لا يمكنك حجز أي رحلة أو نشاط لدى مايكروموبيليتي إلا بعد قراءة هذا الإقرار والموافقة عليه');
  await expect(page.locator('#tab-register')).toContainText('بما في ذلك أي إصابة أو كسر أو مرض أو فقدان أو سرقة أو تلف');
});
