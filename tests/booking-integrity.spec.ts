import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, captureBookingRows } from './helpers/supabase';

// The Reserve wizard's submit paths, as the review found them: a second tap on Confirm booked
// twice, a review reached without the waiver still posted an acceptance, an edit saved with
// nothing changed swapped two riders' bikes, promo codes were stamped on riders they never
// discounted, and the server's refusals reached the rider as raw codes.

const S1 = '2099-02-01';
const S2 = '2099-02-03';
const sessions = [
  { id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 10, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":10}' },
  { id: S2, session_date: S2, day: 'Tuesday', status: 'open', capacity: 10, created_at: 2, bike_slots: '{"_time":"21:00 - 23:00","_total":10}' },
];
type Page = import('@playwright/test').Page;

async function boot(page: Page, fixtures: Record<string, unknown> = {}, cust: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: [], bikes: [], ...fixtures });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', ...cust });
  await page.goto('/');
  await waitForSb(page);
}

/** One rider, filled in, standing on the review step. */
const atReview = (extra = '') => `S.selEvent='jcc';goCustomer('register');S.selSession='${S1}';S.regQty=1;
  S.regBikeHeights=['175'];S.regBikeTypes=['Road'];S.regRiderNames=['Spec Rider'];S.promoApplied=null;S.regStep=3;${extra}renderRegister();`;

function rpcCalls(page: Page, name: string) {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes(`/rest/v1/rpc/${name}`)) calls.push(r.postDataJSON());
  });
  return calls;
}

test.describe('the waiver', () => {
  test('a review submitted without the waiver ticked points at it instead of booking', async ({ page }) => {
    // "Book my usual" used to land here directly; the rows then carried a waiver_version
    // for a rider who never saw the text.
    await boot(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(atReview('S.waiverOk=false;'));
    await page.evaluate(`submitReg()`);
    expect(await page.evaluate('S.regStep')).toBe(3); // the review, where the waiver is (2026-10-10)
    await expect(page.locator('#reg-waiver-cb')).toBeFocused();
    await expect(page.locator('.toast')).toContainText(/tick the waiver/i);
    await page.waitForTimeout(200);
    expect(rows.length).toBe(0);
  });

  test('a tick given for one session is not carried onto another', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='${S1}';S.regStep=3;renderRegister();toggleWaiver(true)`);
    expect(await page.evaluate('S.waiverOk')).toBe(true);
    await page.evaluate(`S.selSession='${S2}';renderRegister()`);
    expect(await page.evaluate('S.waiverOk')).toBe(false);
    await expect(page.locator('#tab-register input[type="checkbox"]')).not.toBeChecked();
  });

  test('a booking queued offline keeps the waiver it was agreed under', async ({ page }) => {
    await boot(page);
    await page.evaluate(atReview('S.waiverOk=true;'));
    await page.evaluate(`Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });submitReg()`);
    await expect.poll(() => page.evaluate(`JSON.parse(localStorage.getItem('cq_book_outbox')||'[]').length`)).toBe(1);
    const row = await page.evaluate(`JSON.parse(localStorage.getItem('cq_book_outbox'))[0]`) as Record<string, unknown>;
    expect(row.waiver_version).toBe(await page.evaluate('WAIVER_VERSION'));
  });
});

test('a second tap on Confirm while the first is still checking books once', async ({ page }) => {
  await boot(page);
  // The corrections lookup is the network wait before the booking starts (its cache lasts a
  // minute, so a real rider nearly always meets it at Confirm). Hold it open.
  await page.route(/\/rpc\/customer_fix_fields/, async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '[]' });
  });
  const creates = rpcCalls(page, 'customer_create_booking');
  await page.evaluate(atReview('S.waiverOk=true;S._fixCache=null;'));
  await page.evaluate(`Promise.all([submitReg(),submitReg()])`);
  await expect.poll(() => creates.length).toBe(1);
  await page.waitForTimeout(500);
  expect(creates.length).toBe(1);
});

test.describe('editing a booking', () => {
  // The holder's row comes back SECOND: my_bookings() has no ORDER BY, and a row moves to the
  // end once it is updated (add-ons, a paid toggle at the desk).
  const row = (id: string, qn: number, name: string, ty: string, h: number) => ({
    id, session_id: S1, session_day: 'Sunday', session_date: S1, queue_num: qn, name, phone: '0500000001',
    customer_id: 'c1', type_preference: ty, height: h, size: 'M', status: 'waiting', paid: false,
    price: ty === 'Road' ? 75 : 57.5, registered_at: '2099-01-01T10:00:00Z',
  });
  const queue_entries = [row('co', 6, 'Sara Friend', 'Hybrid', 160), row('holder', 5, 'Spec Rider', 'Road', 182)];

  test('the form lists riders in booking order, and saving with no change writes nothing', async ({ page }) => {
    await boot(page, { queue_entries, 'rpc:customer_booking_update': true });
    const updates = rpcCalls(page, 'customer_booking_update');
    await page.evaluate(`S.lastTickets=[];S.selEvent='jcc';S.selSession='${S1}';S.regStep=2;setCustTab('register')`);
    await expect.poll(() => page.evaluate('S.modifyEntryId')).toBe('holder');
    expect(await page.evaluate('S.regBikeTypes')).toEqual(['Road', 'Hybrid']);
    expect(await page.evaluate('S.regBikeHeights')).toEqual(['182', '160']);
    await page.evaluate(`submitModifyBooking()`);
    await expect(page.locator('.toast')).toContainText(/updated/i);
    expect(updates.length).toBe(0); // it used to give the holder Sara's Hybrid and height
  });

  test("an existing rider's name is shown read-only: the save cannot write it", async ({ page }) => {
    await boot(page, { queue_entries, 'rpc:customer_booking_update': true });
    await page.evaluate(`S.lastTickets=[];S.selEvent='jcc';S.selSession='${S1}';S.regStep=2;setCustTab('register')`);
    await expect(page.locator('#reg-rider-name-1')).toHaveAttribute('readonly', '');
    await page.evaluate(`changeRegQty(1)`); // a rider being added is new, so their name is theirs to type
    await expect(page.locator('#reg-rider-name-2')).not.toHaveAttribute('readonly', '');
  });

  test('a booking that changed under the edit is filled in again, not saved over', async ({ page }) => {
    await boot(page, { queue_entries, 'rpc:customer_booking_update': true });
    const updates = rpcCalls(page, 'customer_booking_update');
    await page.evaluate(`S.lastTickets=[];S.selEvent='jcc';S.selSession='${S1}';S.regStep=2;setCustTab('register')`);
    await expect.poll(() => page.evaluate('S.modifyEntryId')).toBe('holder');
    // staff cancel the co-rider while the form is open
    await page.evaluate(`getQueue().find(e=>e.id==='co').status='cancelled';submitModifyBooking()`);
    await page.waitForTimeout(200);
    expect(updates.length).toBe(0);
    expect(await page.evaluate('S.regQty')).toBe(1);
  });
});

test.describe('promo codes', () => {
  test('a code is carried only by the riders it discounted', async ({ page }) => {
    await boot(page);
    const rows = await captureBookingRows(page);
    await page.evaluate(atReview(`S.waiverOk=true;S.regQty=2;S.regBikeHeights=['175','170'];S.regBikeTypes=['Road Carbon','Hybrid'];
      S.regRiderNames=['Spec Rider','Friend Rider'];S.promoApplied={code:'CARB',kind:'flat',value:50,applies_to:'Road Carbon'};`));
    await page.evaluate(`submitReg()`);
    await expect.poll(() => rows.length).toBe(2);
    const carbon = rows.find((r) => r.type_preference === 'Road Carbon')!;
    const hybrid = rows.find((r) => r.type_preference === 'Hybrid')!;
    expect(carbon.promo_code).toBe('CARB');
    expect(carbon.price).toBe(200);
    expect(hybrid.promo_code ?? null).toBeNull(); // it used to spend a use on this rider too
  });

  test('a free seat or an own bike never carries the code', async ({ page }) => {
    await boot(page);
    const out = await page.evaluate(`(()=>{S.promoApplied={code:'TEN',kind:'pct',value:10,applies_to:null};
      const es=[{price:0,typePreference:'Own'},{price:75,typePreference:'Road'}];_applyPromoToEntries(es);
      return es.map(e=>[e.price,e.promoCode||null]);})()`);
    expect(out).toEqual([[0, null], [67.5, 'TEN']]);
  });

  test('picking another session drops the code applied for the last one', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='${S1}';S.promoApplied={code:'TEN',kind:'pct',value:10,applies_to:null};`);
    await page.evaluate(`selectSessCard('${S2}')`);
    expect(await page.evaluate('S.promoApplied')).toBeNull();
  });

  test('a code typed with Arabic-Indic digits is the same code', async ({ page }) => {
    await boot(page, { promo_codes: [{ id: 'p1', code: 'RIDE20', kind: 'pct', value: 20, active: true }] });
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='${S1}';S.regQty=1;S.regBikeHeights=['175'];S.regBikeTypes=['Road'];S.regStep=2;renderRegister()`);
    await page.locator('#reg-promo-step2').fill('RIDE٢٠');
    await page.evaluate(`applyPromoCode()`);
    expect(await page.evaluate('S.promoApplied&&S.promoApplied.code')).toBe('RIDE20');
  });

  test('switching the bike type updates the discount line under the code', async ({ page }) => {
    await boot(page);
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='${S1}';S.regQty=1;S.regBikeHeights=['175'];S.regBikeTypes=['Road Carbon'];
      S.promoApplied={code:'CARB',kind:'flat',value:50,applies_to:'Road Carbon'};S.regStep=2;renderRegister()`);
    await expect(page.locator('#reg-promo-disc-step2')).toContainText('50');
    await page.evaluate(`setBikeType(0,'Hybrid')`);
    await expect(page.locator('#reg-promo-disc-step2')).toBeEmpty();
  });
});

test.describe('refusals from the server', () => {
  const refuse = (message: string) => ({ 'rpc:customer_create_booking': { __rpcError: { status: 400, code: 'P0001', message } } });

  test('a closed session is said in words, not as SESSION_CLOSED', async ({ page }) => {
    await boot(page, refuse('SESSION_CLOSED'));
    await page.evaluate(atReview('S.waiverOk=true;'));
    await page.evaluate(`submitReg()`);
    await expect(page.locator('.toast').last()).toContainText(await page.evaluate(`t('errSessionClosed')`) as string);
    await expect(page.locator('.toast')).not.toContainText('SESSION_CLOSED');
  });

  test('a dead token signs the rider out instead of failing every retry', async ({ page }) => {
    await boot(page, refuse('STALE_SESSION'));
    await page.evaluate(atReview('S.waiverOk=true;'));
    await page.evaluate(`submitReg()`);
    await expect.poll(() => page.evaluate('S.loggedIn')).toBeNull();
    await expect(page.locator('.toast')).not.toContainText('STALE_SESSION');
  });

  // The three ride rules name themselves in the error's DETAIL (migration 20260922150000). The
  // code is what the app goes by, so a sentence it does not know still lands on the right
  // message; a database without the codes is still read by its English sentence.
  const rule = (message: string, details?: string) =>
    ({ 'rpc:customer_create_booking': { __rpcError: { status: 400, code: 'P0001', message, details } } });

  test('ONE_PER_SESSION in the detail is the already-booked message, whatever the sentence', async ({ page }) => {
    await boot(page, rule('Une place par personne.', 'ONE_PER_SESSION'));
    await page.evaluate(atReview('S.waiverOk=true;'));
    await page.evaluate(`submitReg()`);
    await expect(page.locator('.toast').last()).toContainText(await page.evaluate(`t('errAlreadyBooked')`) as string);
  });

  test('GROUP_CAP in the detail is the group-cap message; the number comes from the sentence', async ({ page }) => {
    await boot(page, rule('Up to 2 riders per booking on this ride.', 'GROUP_CAP'));
    await page.evaluate(atReview('S.waiverOk=true;'));
    await page.evaluate(`submitReg()`);
    await expect(page.locator('.toast').last()).toContainText(await page.evaluate(`t('errGroupCap').replace('{0}','2')`) as string);
  });

  test('MEMBERS_ONLY in the detail opens the members dialog', async ({ page }) => {
    await boot(page, rule('refused', 'MEMBERS_ONLY'));
    await page.evaluate(atReview('S.waiverOk=true;'));
    await page.evaluate(`submitReg()`);
    await expect(page.locator('#confirm-modal')).toContainText('Community members only');
  });

  test('without a detail, the English sentences are still read', async ({ page }) => {
    await boot(page, rule('One place per person on this session.'));
    await page.evaluate(atReview('S.waiverOk=true;'));
    await page.evaluate(`submitReg()`);
    await expect(page.locator('.toast').last()).toContainText(await page.evaluate(`t('errAlreadyBooked')`) as string);
    expect(await page.evaluate(`[
      _rideRuleRefusal({message:'This ride is for community members only.'}),
      _rideRuleRefusal({message:'Up to 2 riders per booking on this ride.'}),
      _rideRuleRefusal({message:'x',details:'GROUP_CAP'}),
      _rideRuleRefusal({message:'x',details:'session_id'}),
      _rideRuleRefusal({message:'SESSION_CLOSED'})]`)).toEqual(['MEMBERS_ONLY', 'GROUP_CAP', 'GROUP_CAP', '', '']);
  });
});

test('an already-booked rider on a bike is pointed to My Bookings, not round the loop', async ({ page }) => {
  // The banner offered "Modify", which loads no form for a booking already on a bike, so it
  // led back to the same banner for ever.
  await boot(page, {
    queue_entries: [{
      id: 'a1', session_id: S1, session_day: 'Sunday', session_date: S1, queue_num: 3, name: 'Spec Rider',
      phone: '0500000001', customer_id: 'c1', type_preference: 'Road', status: 'active', paid: true, price: 75,
      registered_at: '2099-01-01T10:00:00Z',
    }],
  });
  await page.evaluate(atReview('S.waiverOk=true;'));
  await page.evaluate(`submitReg()`);
  const banner = page.locator('#already-booked-banner');
  await expect(banner).toBeVisible();
  await banner.locator('button').click();
  await expect.poll(() => page.evaluate('S.custTab')).toBe('myrides');
});

test('the first height is saved through the account RPC, not a direct write RLS drops', async ({ page }) => {
  // No customer_set_height here (the stub answers it as missing): the whole-profile save.
  await boot(page, {
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', height: null, type_preference: 'Road', birth_date: '1990-01-01', country: 'SA', city: 'Jeddah', nationality: 'SA' }],
    'rpc:customer_update_profile': true,
  }, { height: null });
  const tried = rpcCalls(page, 'customer_set_height');
  const saves = rpcCalls(page, 'customer_update_profile');
  const direct: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/customers')) direct.push(r.url()); });
  await page.evaluate(atReview('S.waiverOk=true;'));
  await page.evaluate(`submitReg()`);
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0].p_height).toBe(175);
  expect(saves[0].p_country).toBe('SA');      // the rest of the account is written back as it was
  expect(saves[0].p_birth_date).toBe('1990-01-01');
  expect(direct.length).toBe(0);
  expect(tried.length).toBe(1);               // the narrow save was tried first
  expect(await page.evaluate('S.loggedIn.height')).toBe(175);
});

test('with customer_set_height, the height is the only thing written', async ({ page }) => {
  await boot(page, { 'rpc:customer_set_height': true, 'rpc:customer_update_profile': true }, { height: null });
  const narrow = rpcCalls(page, 'customer_set_height');
  const whole = rpcCalls(page, 'customer_update_profile');
  const reads = rpcCalls(page, 'customer_profile');
  await page.evaluate(atReview('S.waiverOk=true;'));
  await page.evaluate(`submitReg()`);
  await expect.poll(() => narrow.length).toBe(1);
  expect(narrow[0]).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_height: 175 });
  await expect.poll(() => page.evaluate('S.loggedIn.height')).toBe(175);
  expect(whole.length).toBe(0);
  expect(reads.length).toBe(0);
});

test('a height the server does not take is not claimed, and not written another way', async ({ page }) => {
  await boot(page, { 'rpc:customer_set_height': false, 'rpc:customer_update_profile': true }, { height: null });
  const narrow = rpcCalls(page, 'customer_set_height');
  const whole = rpcCalls(page, 'customer_update_profile');
  await page.evaluate(atReview('S.waiverOk=true;'));
  await page.evaluate(`submitReg()`);
  await expect.poll(() => narrow.length).toBe(1);
  await page.waitForTimeout(300);
  expect(whole.length).toBe(0);
  expect(await page.evaluate('S.loggedIn.height||null')).toBeNull();
});
