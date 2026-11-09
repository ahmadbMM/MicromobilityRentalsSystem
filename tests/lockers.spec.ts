import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Lockers (the owner, 2026-11-09; migrations 20261109120000 and 20261109220000, the lockers page: plain numbers, a picked locker). The capacity, the price and the fee line on the
// booking are the database's (customer_locker_reserve, staff_locker_*, zy_locker_line); this is what the screens
// ask for and draw. All traffic stubbed; invented data.

const ksaDay = (n = 0) => new Date(Date.now() + 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const TODAY = ksaDay(0);
const sessions = [
  { id: 's1', day: 'Tuesday', session_date: TODAY, capacity: 40, status: 'open', created_at: 1, lockers: true, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' },
  { id: 's2', day: 'Wednesday', session_date: ksaDay(1), capacity: 40, status: 'open', created_at: 2, lockers: true, event_kind: 'community', ride_kind: 'petromin', paid_ride: true, bike_slots: '{"_time":"19:00 - 21:00","_total":40}' },
  { id: 's3', day: 'Saturday', session_date: ksaDay(2), capacity: 40, status: 'open', created_at: 3, lockers: true, event_kind: 'community', ride_kind: 'saturday', bike_slots: '{"_time":"06:00 - 08:00","_total":40}' },
];
const customers = [
  { id: 'c1', name: 'Rana Rider', email: 'rana@example.test', phone: '+966500000021', height: 170, created_at: '2026-01-01T00:00:00Z' },
  { id: 'c2', name: 'Omar Other', email: 'omar@example.test', phone: '+966500000022', height: 180, created_at: '2026-01-02T00:00:00Z' },
];
const bk = (id: string, n: number, x: Record<string, unknown> = {}) => ({
  id, session_id: 's1', session_day: 'Tuesday', session_date: TODAY, queue_num: n, name: 'Rana Rider', customer_id: 'c1', phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 50, registered_at: '2026-11-09T10:00:00Z', ...x,
});
const lockers = [
  { id: 'L1', code: '1', status: 'available', note: '', created_at: '2026-11-09T09:00:00Z' },
  { id: 'L2', code: '2', status: 'available', note: '', created_at: '2026-11-09T09:00:00Z' },
  { id: 'L3', code: '3', status: 'out', note: '', created_at: '2026-11-09T09:00:00Z' },
];
const rent = (id: string, x: Record<string, unknown>) => ({
  id, day: TODAY, period: 'late', booking_id: null, session_id: 's1', customer_id: null, name: '', locker_id: null, price: 10, on_bill: true,
  status: 'reserved', created_at: '2026-11-09T10:00:00Z', created_by: 'rider', ...x,
});
const rentals = [
  rent('R1', { booking_id: 'q1', customer_id: 'c1', name: 'Rana Rider', locker_id: 'L1', status: 'in_use' }),
  rent('R2', { booking_id: 'q2', customer_id: 'c2', name: 'Omar Other', period: 'early' }),
];

function calls(page: Page) {
  const seen: { name: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (!m || r.method() !== 'POST') return;
    let body = {}; try { body = r.postDataJSON() || {}; } catch { /* none */ }
    seen.push({ name: m[1], body });
  });
  return seen;
}
const queue = [bk('q1', 1, { status: 'active' }), bk('q2', 2, { name: 'Omar Other', customer_id: 'c2' })];
async function staff(page: Page, fx: Fixtures = {}, url = '/') {
  const ops = [{ name: 'Spec Staff', has_pin: false }];
  await stubSupabase(page, { sessions, customers, tags: [], customer_tags: [], queue_entries: queue, bikes: [], staff_options: [],
    'rpc:staff_operator_list': ops, lockers, locker_rentals: rentals, ...fx });
  await unlockStaff(page);
  await page.goto(url);
  await waitForSb(page);
  await page.waitForFunction('S.dataLoaded&&(S.customers||[]).length>0');
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S.staffRole='admin';`);
}
async function rider(page: Page, fx: Fixtures) {
  await stubSupabase(page, { sessions, ...fx });
  await page.addInitScript(() => {
    localStorage.setItem('cq_session', JSON.stringify({ id: 'c1', name: 'Rana Rider', email: 'rana@example.test', phone: '+966500000021', height: 170, session_token: 'tok' }));
  });
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@staff:lockers the Lockers section', () => {
  test('its own address and rail entry; tonight\'s board counts and draws each unit; a free unit gives to the rider waiting', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_assign': { ok: true, code: '2' } });
    await page.evaluate(`setStaffTab('lockers')`);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/lockers');
    expect(await page.evaluate(`document.querySelector('#staff-tab-nav .tab-btn[data-stab="lockers"]').style.display`)).not.toBe('none'); // on a phone the rail sits behind the menu
    const sec = page.locator('#tab-lockers');
    await expect(sec.locator('.lk-tile')).toHaveCount(3);
    await expect(sec.locator('.lk-stat').nth(0)).toContainText('1'); // free: 2 (1 in use, 3 out)
    await expect(sec.locator('.lk-stat').nth(1)).toContainText('1'); // reserved (here, waiting for a number)
    await expect(sec.locator('.lk-stat').nth(2)).toContainText('1'); // in use
    await expect(sec.locator('.lk-tile', { hasText: 'Rana Rider' })).toHaveClass(/lk-t-(use|over)/); // in use, or overdue once tonight's 9-11 PM is over (after 23:00 KSA)
    await expect(sec.locator('.lk-tile.lk-t-out')).toContainText('Out of service');

    await sec.locator('.lk-tile', { hasText: 'Free' }).click();
    const dlg = page.getByRole('dialog', { name: /Locker 2/ });
    await expect(dlg).toContainText('Free');
    await dlg.locator('.lk-sh-pick', { hasText: 'Omar Other' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_locker_assign').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_locker_assign')!.body).toEqual({ p_rental: 'R2', p_code: '2' });
  });

  test('reservations and the units have their own addresses; a unit gives its tag link', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('lockers');_lkView('reservations')`);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/lockers/reservations');
    const sec = page.locator('#tab-lockers');
    await expect(sec.locator('.lk-res-row')).toHaveCount(2);
    await expect(sec.locator('.lk-res-row').first()).toContainText('Waiting for a number'); // no number yet comes first
    await page.evaluate(`_lkView('units')`);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/lockers/units');
    await expect(sec.locator('.lk-url').first()).toHaveText('https://micromobility.sa/lockers/1');
    // the lockers are plain numbers (the owner, 2026-11-09): no letter to type, and a tag written as L2 still reads 2
    await expect(sec.locator('#lk-add-pre')).toHaveCount(0);
    expect(await page.evaluate(`JSON.stringify([_lkNorm('2'),_lkNorm('l 02'),_lkNorm('L9'),_lkNorm('09'),_lkNorm('x')])`)).toBe('["2","2","9","9",""]');
    await expect(sec.getByRole('button', { name: 'Page QR' })).toBeVisible(); // the poster for micromobility.sa/lockers
  });

  test('the check-in shows the booking\'s locker; a number typed (any spelling, or the bare number) gives it', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_assign': { ok: true, code: '2' } });
    await page.evaluate(`setStaffTab('queue');showCheckinModal('q2')`);
    const box = page.locator('#lk-ci');
    await expect(box).toContainText('Locker');
    await expect(box).toContainText('6 PM - 8 PM');
    await box.locator('#lk-ci-in').fill('l02');
    await box.locator('#lk-ci-in').press('Enter');
    await expect.poll(() => seen.filter((c) => c.name === 'staff_locker_assign').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_locker_assign')!.body).toEqual({ p_rental: 'R2', p_code: '2' });
  });

  test('a booking with no locker on a night that offers them: the periods to add one, on its bill', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { locker_rentals: [], 'rpc:staff_locker_reserve': { ok: true, id: 'R9', booking_id: 'q2', addons: '[{"id":"locker","qty":1,"p":15}]' } });
    await page.evaluate(`setStaffTab('queue');showCheckinModal('q2')`);
    const box = page.locator('#lk-ci');
    await expect(box.getByRole('button')).toHaveCount(3);
    await box.getByRole('button', { name: '6 PM - 11 PM' }).click(); // both periods read as one span (the owner, 2026-11-09)
    await expect.poll(() => seen.filter((c) => c.name === 'staff_locker_reserve').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_locker_reserve')!.body).toEqual({ p_booking_id: 'q2', p_period: 'both', p_on_bill: true });
    await expect.poll(() => page.evaluate(`_lkFeeOf(_qGet('q2'))`)).toBe(15); // the line the server wrote, drawn without a reload
  });

  test('Assign a locker is on every booking\'s menu; it gives the booking\'s locker its number', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_assign': { ok: true, code: '2' } });
    await page.evaluate(`setStaffTab('queue');renderStaffQueue()`);
    await page.waitForFunction(`(S._rowMenus||{}).q2&&S._rowMenus.q1`);
    expect(await page.evaluate(`['q1','q2'].every(id=>S._rowMenus[id].some(i=>/Assign a locker/.test(i.label)))`)).toBe(true);
    await page.evaluate(`_lkAssignOpen('q2')`);
    const dlg = page.getByRole('dialog', { name: /Assign a locker · #2 Omar Other/ });
    await expect(dlg).toContainText('6 PM - 8 PM');
    await dlg.locator('#lk-as-in').fill('l2');
    await dlg.locator('#lk-as-in').press('Enter');
    await expect.poll(() => seen.filter((c) => c.name === 'staff_locker_assign').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_locker_assign')!.body).toEqual({ p_rental: 'R2', p_code: '2' });
  });

  test('Assign a locker on a booking whose night offers none: rented for its account that evening, the fee into the Sales cart', async ({ page }) => {
    const seen = calls(page);
    const sat = bk('q5', 5, { session_id: 's3', session_date: ksaDay(2), name: 'Rana Rider', customer_id: 'c1' });
    await staff(page, { queue_entries: [...queue, sat], 'rpc:staff_locker_walkup': { ok: true, id: 'R7', price: 15 } });
    await page.evaluate(`_lkAssignOpen('q5')`);
    const dlg = page.getByRole('dialog', { name: /Assign a locker · #5 Rana Rider/ });
    await expect(dlg.locator('.lk-rent-ps .toggle-btn')).toHaveCount(4); // any period: the night offers none of its own
    await dlg.getByRole('button', { name: /6 PM - 11 PM · SAR 15/ }).click();
    await dlg.locator('#lk-as-go').click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_locker_walkup').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_locker_walkup')!.body).toEqual({ p_customer: 'c1', p_name: 'Rana Rider', p_period: 'both', p_day: ksaDay(2) });
    await expect.poll(() => page.evaluate(`JSON.stringify({id:S._ctCustId,cart:(S._ctCart||[]).map(l=>[l.name,l.price])})`)).toBe(JSON.stringify({ id: 'c1', cart: [['Locker · 6 PM - 11 PM', 15]] }));
    expect(await page.evaluate('S.staffTab')).not.toBe('cashier'); // the cart waits; the desk stays where it was
  });

  test('a locker\'s tag on a staff phone: off the address bar, its sheet opens', async ({ page }) => {
    await staff(page, {}, '/?locker=l1'); // a tag written before the letter went
    const dlg = page.getByRole('dialog', { name: /Locker 1/ });
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('Rana Rider');
    await expect(dlg.getByRole('button', { name: 'Hand back' })).toBeVisible();
    expect(page.url()).not.toContain('locker=');
  });

  test('a walk-up: an account, a time, then the fee waits on the Sales till for that account', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_walkup': { ok: true, id: 'R5', price: 10 } });
    await page.evaluate(`setStaffTab('lockers');_lkRentOpen('',todayStr())`);
    const dlg = page.getByRole('dialog', { name: 'Rent a locker' });
    await dlg.locator('#lk-rent-q').fill('Rana');
    await dlg.locator('.sl-sug-b', { hasText: 'Rana Rider' }).click();
    await dlg.getByRole('button', { name: /6 PM - 8 PM · SAR 10/ }).click();
    await dlg.locator('#lk-rent-go').click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_locker_walkup').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_locker_walkup')!.body).toMatchObject({ p_customer: 'c1', p_period: 'early', p_day: TODAY });
    await page.waitForFunction(`S.staffTab==='cashier'`);
    expect(await page.evaluate(`JSON.stringify({id:S._ctCustId,cart:S._ctCart.map(l=>[l.name,l.price])})`)).toBe(JSON.stringify({ id: 'c1', cart: [['Locker · 6 PM - 8 PM', 10]] }));
  });

  test('a locker picked on micromobility.sa/lockers: held, its key not given; Give key hands it and a desk fee goes into the Sales cart', async ({ page }) => {
    const seen = calls(page);
    const page1 = rent('R4', { customer_id: 'c2', name: 'Omar Other', locker_id: 'L2', period: 'early', on_bill: false, created_by: 'page', pay: 'desk' });
    await staff(page, { locker_rentals: [rentals[0], page1], 'rpc:staff_locker_assign': { ok: true, code: '2' } });
    await page.evaluate(`setStaffTab('lockers')`);
    const sec = page.locator('#tab-lockers');
    await expect(sec.locator('.lk-tile.lk-t-res')).toContainText('Key not given');
    await expect(sec.locator('.lk-stat').nth(1)).toContainText('1'); // reserved
    await page.evaluate(`_lkView('reservations')`);
    const row = sec.locator('.lk-res-row', { hasText: 'Omar Other' });
    await expect(row).toContainText('Key not given');
    await expect(row).toContainText('paid at Sales');
    await row.getByRole('button', { name: 'Give key' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_locker_assign').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_locker_assign')!.body).toEqual({ p_rental: 'R4', p_code: '2' });
    await expect.poll(() => page.evaluate(`JSON.stringify({id:S._ctCustId,cart:(S._ctCart||[]).map(l=>[l.name,l.price])})`)).toBe(JSON.stringify({ id: 'c2', cart: [['Locker 2 · 6 PM - 8 PM', 10]] }));
  });

  test('a locker paid from the wallet on the page says so, and cancelling it says the money goes back', async ({ page }) => {
    const paid = rent('R6', { customer_id: 'c2', name: 'Omar Other', locker_id: 'L2', period: 'late', on_bill: false, created_by: 'page', pay: 'wallet', receipt_id: 'lk-r6' });
    await staff(page, { locker_rentals: [paid] });
    await page.evaluate(`setStaffTab('lockers');_lkView('reservations')`);
    const row = page.locator('#tab-lockers .lk-res-row', { hasText: 'Omar Other' });
    await expect(row).toContainText('paid from wallet');
    await row.getByRole('button', { name: 'Cancel locker' }).click();
    await expect(page.getByRole('dialog', { name: 'Cancel this locker?' })).toContainText('The money goes back to their wallet.');
  });

  test('the check-in finds the rider\'s page locker and a tag tapped hands its key', async ({ page }) => {
    const seen = calls(page);
    const page1 = rent('R4', { customer_id: 'c2', name: 'Omar Other', locker_id: 'L2', period: 'early', on_bill: false, created_by: 'page', pay: 'wallet', receipt_id: 'lk-r4' });
    await staff(page, { locker_rentals: [rentals[0], page1], 'rpc:staff_locker_assign': { ok: true, code: '2' } });
    await page.evaluate(`setStaffTab('queue');showCheckinModal('q2')`);
    const box = page.locator('#lk-ci');
    await expect(box).toContainText('Locker 2 picked, key not given yet');
    await expect(box.getByRole('button', { name: 'Give key' })).toBeVisible();
    await page.evaluate(`_lockerArrived('2')`);
    await expect.poll(() => seen.filter((c) => c.name === 'staff_locker_assign').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_locker_assign')!.body).toEqual({ p_rental: 'R4', p_code: '2' });
    expect(await page.evaluate(`(S._ctCart||[]).length`)).toBe(0); // paid from the wallet: nothing to ring up
  });

  test('the session form offers the switch on a JCC ride and a Petromin night only', async ({ page }) => {
    await staff(page);
    const on = await page.evaluate(`(()=>{S.newSessLockers=true;return _lkSessSwitch('new',true)})()`);
    expect(on).toContain('checked');
    expect(await page.evaluate(`_lkSessSwitch('new',false)`)).toBe('');
  });
});

test.describe('@customer:reserve lockers', () => {
  const offer = { kind: 'jcc', one: 10, both: 15, left: { total: 6, early: 4, late: 0, both: 0, pm: 0 } };

  // The evening's cabinet: 18 doors, 5 out of service, 3 taken 6-8 PM, 4 taken 9-11 PM.
  const board = { day: TODAY, kind: 'jcc', one: 10, both: 15, left: { total: 17, early: 15, late: 16, both: 15, pm: 15 },
    ended: { early: false, late: false, both: false, pm: false },
    units: Array.from({ length: 18 }, (_, i) => ({ code: String(i + 1), out: i + 1 === 5 })), taken: { e: ['3'], l: ['4'] } };
  const drawReview = `(()=>{let h=document.getElementById('lk-t');if(!h){h=document.createElement('div');h.id='lk-t';document.body.prepend(h);}h.innerHTML=_lkReviewHtml(_sessGet('s1'));})()`;

  test('the review offers the night\'s periods with their prices; a full one cannot be picked; the fee joins the total', async ({ page }) => {
    await rider(page, { queue_entries: [], 'rpc:customer_locker_offer': offer, 'rpc:locker_board': board });
    await page.evaluate(`_lkOfferLoad('s1',true)`);
    await page.waitForFunction(`!!_lkOffer('s1')`);
    await page.evaluate(`S.regQty=2;S.regStep=0;` + drawReview);
    const box = page.locator('#lk-t #reg-lk');
    await expect(box.locator('.lk-rv-row')).toHaveCount(3);
    await expect(box.locator('#reg-lk-early')).toBeEnabled();
    await expect(box.locator('#reg-lk-late')).toBeDisabled();
    await expect(box.locator('.lk-rv-row').nth(1)).toContainText('Full');
    await expect(box.locator('.lk-rv-row').nth(2)).toContainText('15');
    await expect(box.locator('.lk-cab')).toHaveCount(0); // no cabinet before a time is picked
    // a time picked: the cabinet, as it stands; the fee counts the doors picked
    await page.evaluate(`S.regLocker='early';_lkBoardLoad('${TODAY}',true)`);
    await page.waitForFunction(`!!_lkBoard('${TODAY}')`);
    await page.evaluate(drawReview);
    expect(await page.evaluate(`_lkRegFee(_sessGet('s1'))`)).toBe(0);
    await page.evaluate(`S.regLockerCodes=['7','8'];`);
    expect(await page.evaluate(`_lkRegFee(_sessGet('s1'))`)).toBe(20);
    // the summary card beside the review says the same total, and names the time and the lockers
    const sums = await page.evaluate(`(()=>{const s=_sessGet('s1');S.regQty=1;S.regBikeTypes=['Road'];S.regLockerCodes=['7'];S.regLocker='';const a=_regGrandStr(s);S.regLocker='both';S.regLockerCodes=['7'];const b=_regGrandStr(s),side=_regSideHtml(s);return{a,b,side};})()`) as { a: string; b: string; side: string };
    const num = (x: string) => Number((x.match(/[\d.]+/g) || []).pop());
    expect(num(sums.b) - num(sums.a)).toBe(15);
    expect(sums.side).toContain('6 PM - 11 PM');
    expect(sums.side).toContain('<bdi>7</bdi>');
  });

  test('the cabinet: three across, numbered across the rows; taken and out-of-service doors cannot be picked; one per rider', async ({ page }) => {
    await rider(page, { queue_entries: [], 'rpc:customer_locker_offer': offer, 'rpc:locker_board': board });
    await page.evaluate(`_lkOfferLoad('s1',true);_lkBoardLoad('${TODAY}',true)`);
    await page.waitForFunction(`!!_lkOffer('s1')&&!!_lkBoard('${TODAY}')`);
    await page.evaluate(`S.regQty=2;S.regStep=0;S.regLocker='early';S.regLockerCodes=[];` + drawReview);
    const cab = page.locator('#lk-t .lk-cab');
    await expect(cab.locator('.lk-door')).toHaveCount(18);
    const at = (n: string) => cab.locator(`#lk-d-${n}`).boundingBox();
    const [b1, b2, b3, b4, b16] = await Promise.all(['1', '2', '3', '4', '16'].map(at));
    expect(Math.round(b2!.y)).toBe(Math.round(b1!.y)); // 1 2 3 on the top row
    expect(Math.round(b3!.y)).toBe(Math.round(b1!.y));
    expect(b2!.x).toBeGreaterThan(b1!.x);
    expect(Math.round(b4!.x)).toBe(Math.round(b1!.x)); // 4 under 1
    expect(b4!.y).toBeGreaterThan(b1!.y);
    expect(Math.round(b16!.x)).toBe(Math.round(b1!.x)); // 16 at the bottom, under 1
    // never mirrored: in Arabic (right to left) 1 still stands left of 2, as on the cabinet
    await page.evaluate(`document.documentElement.dir='rtl';document.documentElement.lang='ar';` + drawReview);
    const [r1, r2] = await Promise.all(['1', '2'].map(at));
    expect(r2!.x).toBeGreaterThan(r1!.x);
    await page.evaluate(`document.documentElement.dir='ltr';document.documentElement.lang='en';`);
    await expect(cab.locator('#lk-d-3')).toBeDisabled(); // taken 6-8 PM
    await expect(cab.locator('#lk-d-3')).toHaveAttribute('aria-label', 'Locker 3 · Full'); // said, not only greyed
    await expect(cab.locator('#lk-d-5')).toBeDisabled(); // out of service
    await expect(cab.locator('#lk-d-4')).toBeEnabled(); // taken only 9-11 PM
    await page.evaluate(`_lkRegDoor('7');_lkRegDoor('8');` + drawReview);
    await expect(cab.locator('#lk-d-7')).toHaveAttribute('aria-pressed', 'true');
    await expect(cab.locator('#lk-d-9')).toBeDisabled(); // two riders, two lockers
    await page.evaluate(`_lkRegDoor('7');` + drawReview); // tapped again: dropped
    await expect(cab.locator('#lk-d-9')).toBeEnabled();
    expect(await page.evaluate(`JSON.stringify(S.regLockerCodes)`)).toBe('["8"]');
    await page.evaluate(`S.regLocker='both';S.regLockerCodes=['4','8'];` + drawReview); // 4 is taken 9-11 PM: dropped
    expect(await page.evaluate(`JSON.stringify(S.regLockerCodes)`)).toBe('["8"]');
  });

  test('a picked door reserved by someone else meanwhile is dropped and said, and the booking waits at the cabinet', async ({ page }) => {
    await rider(page, { queue_entries: [], 'rpc:customer_locker_offer': offer, 'rpc:locker_board': board });
    await page.evaluate(`_lkOfferLoad('s1',true);_lkBoardLoad('${TODAY}',true)`);
    await page.waitForFunction(`!!_lkOffer('s1')&&!!_lkBoard('${TODAY}')`);
    await page.evaluate(`S.regLocker='early';S.regLockerCodes=['7','8'];`);
    expect(await page.evaluate(`_lkPicksFresh(_sessGet('s1'))`)).toBe(true); // nothing changed: the booking goes on
    // someone reserves 7 for 6-8 PM: the next read takes it out of the picks, and the booking stops
    await page.route('**/rest/v1/rpc/locker_board*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...board, taken: { e: ['3', '7'], l: ['4'] } }) }));
    expect(await page.evaluate(`_lkPicksFresh(_sessGet('s1'))`)).toBe(false);
    expect(await page.evaluate(`JSON.stringify(S.regLockerCodes)`)).toBe('["8"]');
    await expect(page.locator('.toast', { hasText: 'Locker 7 was just taken. Pick another.' })).toBeVisible();
  });

  test('a Petromin night offers its one period; a free ride offers none', async ({ page }) => {
    await rider(page, { queue_entries: [], 'rpc:customer_locker_offer': offer });
    expect(await page.evaluate(`JSON.stringify([_lkKind(_sessGet('s1')),_lkKind(_sessGet('s2')),_lkKind(_sessGet('s3'))])`)).toBe('["jcc","pm",""]');
    expect(await page.evaluate(`JSON.stringify(_lkPeriodsOf('pm'))`)).toBe('["pm"]');
  });

  test('after the booking the locker goes on the first riders\' rows; a database without lockers draws nothing', async ({ page }) => {
    const seen = calls(page);
    await rider(page, { queue_entries: [], 'rpc:customer_locker_offer': offer, 'rpc:locker_board': board, 'rpc:customer_locker_reserve': { ok: true, rows: [] } });
    await page.evaluate(`_lkOfferLoad('s1',true);_lkBoardLoad('${TODAY}',true)`);
    await page.waitForFunction(`!!_lkOffer('s1')&&!!_lkBoard('${TODAY}')`);
    await page.evaluate(`(async()=>{S.regQty=3;S.regLocker='late';S.regLockerCodes=['9','12'];await _lkAfterBook([{id:'q1',status:'waiting'},{id:'q2',status:'waitlist'},{id:'q3',status:'waiting'}],_sessGet('s1'),false);})()`);
    await expect.poll(() => seen.filter((c) => c.name === 'customer_locker_reserve').length).toBe(1);
    expect(seen.find((c) => c.name === 'customer_locker_reserve')!.body).toEqual({ p_id: 'c1', p_token: 'tok', p_booking_ids: ['q1', 'q2'], p_period: 'late', p_codes: ['9', '12'] });
    expect(await page.evaluate('S.regLocker')).toBe('');
    expect(await page.evaluate('JSON.stringify(S.regLockerCodes)')).toBe('[]');
  });

  test('a database without lockers: the review offers none', async ({ page }) => {
    await rider(page, { queue_entries: [] }); // the stub answers a function it does not know with [], as no lockers yet would
    await page.evaluate(`_lkOfferLoad('s1',true)`);
    expect(await page.evaluate(`_lkReviewHtml(_sessGet('s1'))`)).toBe('');
    expect(await page.evaluate(`(()=>{S.regLocker='early';return _lkRegFee(_sessGet('s1'))})()`)).toBe(0);
  });

  test('the ticket says the period and the number once given; the line reads Locker', async ({ page }) => {
    const held = bk('q1', 1, { addons: '[{"id":"locker","qty":1,"p":10}]' });
    await rider(page, { queue_entries: [held], 'rpc:my_bookings': [held],
      'rpc:customer_lockers': [{ booking_id: 'q1', period: 'late', status: 'in_use', price: 10, on_bill: true, code: '7' }] });
    await page.evaluate(`_lkMineLoad(null,true)`);
    await page.waitForFunction(`_lkMine().length===1`);
    const html = await page.evaluate(`_lkTkHtml([entryFromDB(${JSON.stringify(held)})],_sessGet('s1'),false)`);
    expect(html).toContain('<bdi>7</bdi>');
    expect(html).toContain('9 PM - 11 PM');
    expect(html).not.toContain('lkTkRemove'); // its key was given: no Remove
    expect(await page.evaluate(`addonLineItems([{id:'locker',qty:1,p:10}])[0].name`)).toBe('Locker');
    // picked on the review but its key not handed yet: the number shows and it can still be removed
    await page.evaluate(`S._lkMine=[{booking_id:'q1',period:'late',status:'reserved',price:10,on_bill:true,code:'7'}]`);
    const held2 = await page.evaluate(`_lkTkHtml([entryFromDB(${JSON.stringify(held)})],_sessGet('s1'),false)`);
    expect(held2).toContain('lkTkRemove');
  });

  test('My bookings lists the lockers reserved with no booking, today on; Remove gives a wallet payment back', async ({ page }) => {
    const seen = calls(page);
    const mine = [
      { id: 'r1', booking_id: null, day: TODAY, period: 'early', status: 'reserved', price: 10, on_bill: false, pay: 'wallet', paid: true, code: '7' },
      { id: 'r2', booking_id: null, day: ksaDay(1), period: 'late', status: 'reserved', price: 10, on_bill: false, pay: 'desk', paid: false, code: '12' },
      { id: 'r3', booking_id: null, day: ksaDay(-1), period: 'late', status: 'returned', price: 10, on_bill: false, pay: 'desk', paid: false, code: '1' },
    ];
    await rider(page, { queue_entries: [], 'rpc:customer_lockers': mine, 'rpc:customer_locker_drop': { ok: true } });
    await page.evaluate(`_lkMineLoad(null,true)`);
    await page.waitForFunction(`_lkMine().length===3`);
    await page.evaluate(`setCustTab('myrides')`);
    const own = page.locator('#tab-myrides .lk-own');
    await expect(own.locator('.lk-own-row')).toHaveCount(2); // yesterday's is gone
    await expect(own.locator('.lk-own-row').first()).toContainText('Paid from your wallet');
    await expect(own.locator('.lk-own-row').nth(1)).toContainText('Pay at the desk');
    await own.locator('.lk-own-row').first().getByRole('button', { name: 'Remove' }).click();
    const dlg = page.getByRole('dialog', { name: 'Remove this locker?' });
    await expect(dlg).toContainText('The money goes back to your wallet.');
    await dlg.getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'customer_locker_drop').length).toBe(1);
    expect(seen.find((c) => c.name === 'customer_locker_drop')!.body).toEqual({ p_id: 'c1', p_token: 'tok', p_rental: 'r1' });
  });

  test('?handoff=lockers sends a signed-in rider back to micromobility.sa/lockers, signed in there (its Forgot password)', async ({ page }) => {
    const code = 'ab12'.repeat(12);
    await stubSupabase(page, { sessions, bikes: [], queue_entries: [], 'rpc:customer_handoff_create': code });
    await page.route('https://micromobility.sa/lockers**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>lockers</title>' }));
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/?handoff=lockers&lang=ar');
    await page.waitForURL('https://micromobility.sa/lockers**');
    expect(page.url()).toBe(`https://micromobility.sa/lockers?lang=ar&code=${code}`);
  });
});
