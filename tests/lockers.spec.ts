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
    const dlg = page.getByRole('dialog', { name: /Assign a locker #2 Omar Other/ }) // its name says whose (the title and who, under it);
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
    const dlg = page.getByRole('dialog', { name: /Assign a locker #5 Rana Rider/ });
    await expect(dlg.locator('.lk-as-p')).toHaveCount(4); // any period: the night offers none of its own
    await dlg.getByRole('button', { name: /6 PM - 11 PM\s*SAR 15/ }).click();
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

// Round two (the owner, 2026-11-09; migration 20261109233000): the desk's side.
function writes(page: Page, table: string) {
  const seen: { method: string; body: unknown; url: string }[] = [];
  page.on('request', (r) => {
    if (!r.url().includes(`/rest/v1/${table}`) || r.method() === 'GET' || r.method() === 'OPTIONS') return;
    let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
    seen.push({ method: r.method(), body, url: r.url() });
  });
  return seen;
}
const RID = '0b6f2a8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', RID2 = '1c7a3b9f-2d4e-4f6a-9b0c-1d2e3f4a5b6c';
const pageRentals = [
  rent(RID, { customer_id: 'c2', name: 'Omar Other', locker_id: 'L2', period: 'early', on_bill: false, created_by: 'page', pay: 'desk' }),
  rent(RID2, { customer_id: 'c2', name: 'Omar Son', locker_id: 'L1', period: 'early', on_bill: false, created_by: 'page', pay: 'desk' }),
];

test.describe('@staff:lockers round two', () => {
  test('a rider\'s show-at-desk QR: the scanner reads it, the dialog lists their lockers, Give all keys, then the till opens with the fees', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { locker_rentals: [rentals[1], ...pageRentals], 'rpc:staff_locker_assign': { ok: true, code: '2' } });
    expect(await page.evaluate(`JSON.stringify(_scanLockerUrl('https://micromobility.sa/lockers/r/${RID}'))`)).toBe(JSON.stringify(['', 'r:' + RID]));
    await page.evaluate(`_lockerArrived('r:${RID}')`);
    const dlg = page.getByRole('dialog', { name: /Hand the keys · Omar Other/ });
    await expect(dlg.locator('.lk-sh-row')).toHaveCount(3); // the two picked on the page, and his booking's locker waiting for a number
    await expect(dlg.locator('.lk-hd-in')).toHaveCount(1);
    await dlg.getByRole('button', { name: 'Give all keys' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_locker_assign').length).toBe(2);
    expect(seen.filter((c) => c.name === 'staff_locker_assign').map((c) => c.body.p_rental).sort()).toEqual([RID, RID2].sort());
    await dlg.getByRole('button', { name: 'Close' }).first().click(); // one still waits for a number: the till opens as the dialog closes
    await page.waitForFunction(`S.staffTab==='cashier'`);
    expect(await page.evaluate(`(S._ctCart||[]).length`)).toBe(2);
    expect(await page.evaluate('S._ctCustId')).toBe('c2');
  });

  test('a tag param ?lkr= on a staff phone opens the same dialog', async ({ page }) => {
    await staff(page, { locker_rentals: pageRentals }, `/?lkr=${RID}`);
    await expect(page.getByRole('dialog', { name: /Hand the keys/ })).toBeVisible();
    expect(page.url()).not.toContain('lkr=');
  });

  test('tonight\'s arrivals on the board, and the end of the night frees the never collected', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { locker_rentals: [rentals[0], ...pageRentals], 'rpc:staff_locker_sweep': { ok: true, freed: 2, out: ['1'] } });
    await page.evaluate(`setStaffTab('lockers')`);
    const sec = page.locator('#tab-lockers');
    await expect(sec.locator('.lk-arr')).toContainText('Waiting for their key (2)');
    await expect(sec.locator('.lk-arr .lk-res-row')).toHaveCount(2);
    await sec.getByRole('button', { name: 'End of night' }).click();
    const dlg = page.getByRole('dialog', { name: 'Free the lockers never collected?' });
    await expect(dlg).toContainText('2 reserved and never collected will be freed');
    await dlg.getByRole('button', { name: 'End of night' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_locker_sweep').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_locker_sweep')!.body).toEqual({ p_day: TODAY });
    await expect(page.locator('.toast', { hasText: '2 lockers freed' })).toBeVisible();
    // the close-out names them too
    expect(await page.evaluate(`_lkCoHtml('s1')`)).toContain('End of night');
  });

  test('the report: per evening, rentals, lockers used, how full, the money and the not collected; a CSV', async ({ page }) => {
    const past = [
      rent('P1', { day: ksaDay(-1), status: 'returned', locker_id: 'L1', price: 10 }),
      rent('P2', { day: ksaDay(-1), status: 'returned', locker_id: 'L2', price: 15, period: 'both' }),
      rent('P3', { day: ksaDay(-1), status: 'cancelled', cancel_reason: 'not collected', price: 10 }),
    ];
    await staff(page, { locker_rentals: past });
    await page.evaluate(`setStaffTab('lockers');_lkView('report')`);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/lockers/report');
    const row = page.locator('#tab-lockers .lk-rp tbody tr').nth(1);
    await expect(row.locator('td').nth(0)).toHaveText('2'); // rentals (the cancelled one not counted)
    await expect(row.locator('td').nth(1)).toHaveText('2'); // lockers used
    await expect(row.locator('td').nth(2)).toHaveText('67%'); // 2 of 3 units
    await expect(row.locator('td').nth(3)).toContainText('25');
    await expect(row.locator('td').nth(4)).toHaveText('1'); // not collected
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });

  test('items left behind: a note, the state, kept until 14 days after; WhatsApp to the rider; saved to locker_items', async ({ page }) => {
    const w = writes(page, 'locker_items');
    await staff(page, { locker_items: [] });
    await page.evaluate(`setStaffTab('lockers');_lkView('reservations')`);
    const row = page.locator('#tab-lockers .lk-res-row', { hasText: 'Rana Rider' });
    await row.getByRole('button', { name: 'Items left' }).click();
    const dlg = page.getByRole('dialog', { name: /Items left · Locker 1/ });
    await expect(dlg).toContainText(`Kept until`);
    await expect(dlg.locator('.lk-it-wa')).toHaveAttribute('href', /^https:\/\/wa\.me\/966500000021\?text=MicroMobility/);
    await dlg.locator('#lk-it-note').fill('Blue backpack');
    await dlg.getByRole('button', { name: 'Collected' }).click();
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].body).toEqual({ rental_id: 'R1', note: 'Blue backpack', state: 'collected' }); // no photo sent when none was taken
  });

  test('taking a locker out of service asks why; its history lists the log', async ({ page }) => {
    const w = writes(page, 'lockers');
    await staff(page, { locker_events: [{ at: '2026-11-09T18:00:00Z', by_name: 'Spec Staff', kind: 'out', reason: 'Broken lock' }] });
    await page.evaluate(`setStaffTab('lockers');_lkView('units')`);
    const row = page.locator('#tab-lockers .lk-res-row').filter({ has: page.locator('.lk-res-code', { hasText: /^2$/ }) });
    await row.getByRole('button', { name: 'Take out of service' }).click();
    const dlg = page.getByRole('dialog', { name: 'Why is locker 2 out of service?' });
    await dlg.getByRole('button', { name: 'Take out of service' }).click();
    await expect(page.locator('.toast', { hasText: 'Pick or type a reason' })).toBeVisible();
    await dlg.getByRole('button', { name: 'Broken lock' }).click();
    await dlg.getByRole('button', { name: 'Take out of service' }).click();
    await expect.poll(() => w.length).toBe(1);
    expect(w[0].body).toEqual({ status: 'out', note: 'Broken lock' });
    await row.getByRole('button', { name: 'History' }).click();
    await expect(page.locator('#tab-lockers .lk-ev')).toContainText('Broken lock');
  });
});

test.describe('@customer:reserve lockers round two', () => {
  test('My bookings: a card per evening with the show-at-desk QR; Change opens the lockers page signed in', async ({ page }) => {
    const code = 'cd56'.repeat(12);
    const mine = [
      { id: RID, booking_id: null, day: TODAY, period: 'early', status: 'reserved', price: 10, on_bill: false, pay: 'desk', paid: false, code: '7', name: 'Rana Rider' },
      { id: RID2, booking_id: null, day: TODAY, period: 'early', status: 'reserved', price: 10, on_bill: false, pay: 'desk', paid: false, code: '8', name: 'Lina Rider' },
    ];
    await rider(page, { queue_entries: [], 'rpc:customer_lockers': mine, 'rpc:customer_handoff_create': code });
    await page.route('https://micromobility.sa/lockers**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>lockers</title>' }));
    await page.evaluate(`_lkMineLoad(null,true)`);
    await page.waitForFunction(`_lkMine().length===2`);
    await page.evaluate(`setCustTab('myrides')`);
    const ev = page.locator('#tab-myrides .lk-own-ev');
    await expect(ev).toHaveCount(1);
    await expect(ev).toContainText('Show this at the desk');
    await expect(ev.locator('[data-qr]').first()).toHaveAttribute('data-qr', `https://micromobility.sa/lockers/r/${RID}`);
    await expect(ev.locator('.lk-own-row').nth(1)).toContainText('Lina Rider'); // someone else's locker says whose
    await expect(ev.locator('.lk-own-row').nth(0)).not.toContainText('Rana Rider');
    await ev.locator('.lk-own-row').first().getByRole('button', { name: 'Change' }).click();
    await page.waitForURL('https://micromobility.sa/lockers**');
    expect(page.url()).toBe(`https://micromobility.sa/lockers?change=${RID}&lang=en&code=${code}`);
  });

  test('a ride\'s ticket names the rider\'s own locker that evening; the review links the locker terms', async ({ page }) => {
    const held = bk('q1', 1);
    await rider(page, { queue_entries: [held], 'rpc:my_bookings': [held], 'rpc:customer_locker_offer': { kind: 'jcc', one: 10, both: 15, left: { total: 6, early: 4, late: 4, both: 4, pm: 0 } },
      'rpc:locker_board': { day: TODAY, kind: 'jcc', one: 10, both: 15, left: {}, ended: {}, units: [{ code: '7', out: false }], taken: { e: [], l: [] } },
      'rpc:customer_lockers': [{ id: RID, booking_id: null, day: TODAY, period: 'late', status: 'reserved', price: 10, pay: 'wallet', paid: true, code: '7' }] });
    await page.evaluate(`_lkMineLoad(null,true)`);
    await page.waitForFunction(`_lkMine().length===1`);
    const html = await page.evaluate(`_lkTkHtml([entryFromDB(${JSON.stringify(held)})],_sessGet('s1'),false)`);
    expect(html).toContain('<bdi>7</bdi>');
    expect(html).toContain('Paid from your wallet');
    await page.evaluate(`_lkOfferLoad('s1',true);_lkBoardLoad('${TODAY}',true)`);
    await page.waitForFunction(`!!_lkOffer('s1')&&!!_lkBoard('${TODAY}')`);
    const rv = await page.evaluate(`(()=>{S.regLocker='late';return _lkReviewHtml(_sessGet('s1'))})()`);
    expect(rv).toContain('By reserving you accept the <button type="button" class="lk-terms-a"');
    // the website's Terms page is not open yet: the locker terms open here, in a pop-up
    await page.evaluate(`_lkTermsOpen()`);
    const dlg = page.getByRole('dialog', { name: 'Locker terms' });
    await expect(dlg).toContainText('kept for 14 days');
    await expect(dlg).toContainText('Do not put food or open drinks');
    await dlg.getByRole('button', { name: 'Close' }).last().click();
    await expect(dlg).toBeHidden();
  });
});
