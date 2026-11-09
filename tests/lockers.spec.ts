import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Lockers (the owner, 2026-11-09; migration 20261109120000). The capacity, the price and the fee line on the
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
  { id: 'L1', code: 'P1', status: 'available', note: '', created_at: '2026-11-09T09:00:00Z' },
  { id: 'L2', code: 'P2', status: 'available', note: '', created_at: '2026-11-09T09:00:00Z' },
  { id: 'L3', code: 'P3', status: 'out', note: '', created_at: '2026-11-09T09:00:00Z' },
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
    await staff(page, { 'rpc:staff_locker_assign': { ok: true, code: 'P2' } });
    await page.evaluate(`setStaffTab('lockers')`);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/lockers');
    expect(await page.evaluate(`document.querySelector('#staff-tab-nav .tab-btn[data-stab="lockers"]').style.display`)).not.toBe('none'); // on a phone the rail sits behind the menu
    const sec = page.locator('#tab-lockers');
    await expect(sec.locator('.lk-tile')).toHaveCount(3);
    await expect(sec.locator('.lk-stat').nth(0)).toContainText('1'); // free: P2 (P1 in use, P3 out)
    await expect(sec.locator('.lk-stat').nth(1)).toContainText('1'); // in use
    await expect(sec.locator('.lk-stat').nth(2)).toContainText('1'); // waiting for a number
    await expect(sec.locator('.lk-tile.lk-t-use')).toContainText('Rana Rider');
    await expect(sec.locator('.lk-tile.lk-t-out')).toContainText('Out of service');

    await sec.locator('.lk-tile', { hasText: 'P2' }).click();
    const dlg = page.getByRole('dialog', { name: /Locker P2/ });
    await expect(dlg).toContainText('Free');
    await dlg.locator('.lk-sh-pick', { hasText: 'Omar Other' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_locker_assign').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_locker_assign')!.body).toEqual({ p_rental: 'R2', p_code: 'P2' });
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
    await expect(sec.locator('.lk-url').first()).toHaveText('https://micromobility.sa/lockers/P1');
  });

  test('the check-in shows the booking\'s locker; a number typed (any spelling) gives it', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_locker_assign': { ok: true, code: 'P2' } });
    await page.evaluate(`setStaffTab('queue');showCheckinModal('q2')`);
    const box = page.locator('#lk-ci');
    await expect(box).toContainText('Locker');
    await expect(box).toContainText('6 PM - 8 PM');
    await box.locator('#lk-ci-in').fill('p02');
    await box.locator('#lk-ci-in').press('Enter');
    await expect.poll(() => seen.filter((c) => c.name === 'staff_locker_assign').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_locker_assign')!.body).toEqual({ p_rental: 'R2', p_code: 'P2' });
  });

  test('a booking with no locker on a night that offers them: the periods to add one, on its bill', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { locker_rentals: [], 'rpc:staff_locker_reserve': { ok: true, id: 'R9', booking_id: 'q2', addons: '[{"id":"locker","qty":1,"p":15}]' } });
    await page.evaluate(`setStaffTab('queue');showCheckinModal('q2')`);
    const box = page.locator('#lk-ci');
    await expect(box.getByRole('button')).toHaveCount(3);
    await box.getByRole('button', { name: '6 PM - 8 PM + 9 PM - 11 PM' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_locker_reserve').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_locker_reserve')!.body).toEqual({ p_booking_id: 'q2', p_period: 'both', p_on_bill: true });
    await expect.poll(() => page.evaluate(`_lkFeeOf(_qGet('q2'))`)).toBe(15); // the line the server wrote, drawn without a reload
  });

  test('a locker\'s tag on a staff phone: off the address bar, its sheet opens', async ({ page }) => {
    await staff(page, {}, '/?locker=p1');
    const dlg = page.getByRole('dialog', { name: /Locker P1/ });
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

  test('the session form offers the switch on a JCC ride and a Petromin night only', async ({ page }) => {
    await staff(page);
    const on = await page.evaluate(`(()=>{S.newSessLockers=true;return _lkSessSwitch('new',true)})()`);
    expect(on).toContain('checked');
    expect(await page.evaluate(`_lkSessSwitch('new',false)`)).toBe('');
  });
});

test.describe('@customer:reserve lockers', () => {
  const offer = { kind: 'jcc', one: 10, both: 15, left: { total: 6, early: 4, late: 0, both: 0, pm: 0 } };

  test('the review offers the night\'s periods with their prices; a full one cannot be picked; the fee joins the total', async ({ page }) => {
    await rider(page, { queue_entries: [], 'rpc:customer_locker_offer': offer });
    await page.evaluate(`_lkOfferLoad('s1',true)`);
    await page.waitForFunction(`!!_lkOffer('s1')`);
    await page.evaluate(`S.regQty=2;(()=>{const h=document.createElement('div');h.id='lk-t';h.innerHTML=_lkReviewHtml(_sessGet('s1'));document.body.prepend(h);})()`);
    const box = page.locator('#lk-t #reg-lk');
    await expect(box.locator('.lk-rv-row')).toHaveCount(3);
    await expect(box.locator('#reg-lk-early')).toBeEnabled();
    await expect(box.locator('#reg-lk-late')).toBeDisabled();
    await expect(box.locator('.lk-rv-row').nth(1)).toContainText('Full');
    await expect(box.locator('.lk-rv-row').nth(2)).toContainText('15');
    expect(await page.evaluate(`(()=>{S.regLocker='early';S.regLockerN=1;return _lkRegFee(_sessGet('s1'))})()`)).toBe(10);
    expect(await page.evaluate(`(()=>{S.regLockerN=2;return _lkRegFee(_sessGet('s1'))})()`)).toBe(20);
    expect(await page.evaluate(`(()=>{S.regLockerN=5;return _lkRegFee(_sessGet('s1'))})()`)).toBe(20); // never more than the riders booked
  });

  test('a Petromin night offers its one period; a free ride offers none', async ({ page }) => {
    await rider(page, { queue_entries: [], 'rpc:customer_locker_offer': offer });
    expect(await page.evaluate(`JSON.stringify([_lkKind(_sessGet('s1')),_lkKind(_sessGet('s2')),_lkKind(_sessGet('s3'))])`)).toBe('["jcc","pm",""]');
    expect(await page.evaluate(`JSON.stringify(_lkPeriodsOf('pm'))`)).toBe('["pm"]');
  });

  test('after the booking the locker goes on the first riders\' rows; a database without lockers draws nothing', async ({ page }) => {
    const seen = calls(page);
    await rider(page, { queue_entries: [], 'rpc:customer_locker_offer': offer, 'rpc:customer_locker_reserve': { ok: true, rows: [] } });
    await page.evaluate(`_lkOfferLoad('s1',true)`);
    await page.waitForFunction(`!!_lkOffer('s1')`);
    await page.evaluate(`(async()=>{S.regQty=3;S.regLocker='late';S.regLockerN=2;await _lkAfterBook([{id:'q1',status:'waiting'},{id:'q2',status:'waitlist'},{id:'q3',status:'waiting'}],_sessGet('s1'),false);})()`);
    await expect.poll(() => seen.filter((c) => c.name === 'customer_locker_reserve').length).toBe(1);
    expect(seen.find((c) => c.name === 'customer_locker_reserve')!.body).toEqual({ p_id: 'c1', p_token: 'tok', p_booking_ids: ['q1', 'q2'], p_period: 'late' });
    expect(await page.evaluate('S.regLocker')).toBe('');
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
      'rpc:customer_lockers': [{ booking_id: 'q1', period: 'late', status: 'in_use', price: 10, on_bill: true, code: 'P7' }] });
    await page.evaluate(`_lkMineLoad(null,true)`);
    await page.waitForFunction(`_lkMine().length===1`);
    const html = await page.evaluate(`_lkTkHtml([entryFromDB(${JSON.stringify(held)})],_sessGet('s1'),false)`);
    expect(html).toContain('P7');
    expect(html).toContain('9 PM - 11 PM');
    expect(html).not.toContain('lkTkRemove'); // a number was given: no Remove
    expect(await page.evaluate(`addonLineItems([{id:'locker',qty:1,p:10}])[0].name`)).toBe('Locker');
  });
});
