import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows, loadStaffHalf, checkinAsRow } from './helpers/supabase';

// The Saturday ride's two groups (the owner, 2026-10-02): Beginners 20 km (to the Jeddah Yacht
// Club and back) and Intermediates 40 km (to just before the Marine Sciences roundabout and back).
// The rider picks one when booking, behind an "i" with the turning point's picture; staff pick it
// when adding a rider and at check-in, and the Bookings table shows Beg / Int. The Saturday
// check-in asks the bike type and the group only, with Cancel, Waiting and Check in.

const SAT = 'sat-1', JCC = 'jcc-1';
const sat = { id: SAT, session_date: '2099-01-10', day: 'Saturday', status: 'open', capacity: 30, created_at: 1,
  event_kind: 'community', ride_kind: 'saturday', needs_approval: true, hide_queue: true, paid_ride: false, spots: 30,
  bike_slots: '{"_time":"05:45 - 06:15"}', title: 'Saturday Social Ride' };
const jcc = { id: JCC, session_date: '2099-01-11', day: 'Sunday', status: 'open', capacity: 12, created_at: 1, location: 'JCC' };
const row = (id: string, sid: string, x: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: sid === SAT ? 'Saturday' : 'Sunday', session_date: sid === SAT ? '2099-01-10' : '2099-01-11',
  queue_num: 1, name: 'R ' + id, phone: '0550000009', type_preference: 'Road', size: 'M', height: 175, status: 'waiting',
  paid: false, price: 0, registered_at: '2099-01-01T10:00:00Z', approval: sid === SAT ? 'approved' : null, customer_id: 'c-' + id, ...x });

test('the rider picks a group behind an "i", and the booking carries it', async ({ page }) => {
  await stubSupabase(page, { sessions: [sat], bikes: [], queue_entries: [], 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
  await page.goto('/');
  await waitForSb(page);
  const rows = await captureBookingRows(page);
  await page.evaluate(`S.selEvent='community';S.selSession='${SAT}';S.regStep=2;S.regBikeHeights=['175'];S.regBikeTypes=['Road'];setCustTab('register')`);

  const wrap = page.locator('#reg-group-wrap');
  await expect(wrap.locator('[data-rg]')).toHaveText([/Beginners’ group.*20 km/, /Intermediates’ group.*40 km/]);
  // no group yet: the form will not go on
  expect(await page.evaluate('validateRegInputs()')).toBe(false);

  // the "i" opens the turning point's picture and the route, and Choose picks the group
  await wrap.locator('.type-info-btn').nth(1).click();
  const sheet = page.locator('#bike-info-modal .bike-info-box');
  await expect(sheet).toContainText('Intermediates’ group');
  await expect(sheet).toContainText('Marine Sciences roundabout');
  await expect(sheet.locator('img')).toHaveAttribute('src', /group-msr\.webp/);
  await sheet.getByRole('button', { name: 'Choose this group' }).click();
  await expect(wrap.locator('[data-rg="int"]')).toHaveAttribute('aria-pressed', 'true');

  await wrap.locator('.type-info-btn').first().click();
  await expect(sheet).toContainText('Jeddah Yacht Club');
  await expect(sheet.locator('img')).toHaveAttribute('src', /group-jyc\.webp/);
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(wrap.locator('[data-rg="int"]')).toHaveAttribute('aria-pressed', 'true'); // Close changes nothing

  expect(await page.evaluate('validateRegInputs()')).toBe(true);
  await page.evaluate(`S.regRiderNames=['Spec Rider'];S.waiverOk=true;submitReg()`);
  await expect.poll(() => rows.length).toBe(1);
  expect(rows[0].ride_group).toBe('int');
});

async function staffBoot(page: import('@playwright/test').Page, sid: string, q: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [sat, jcc], bikes: [], queue_entries: q, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${sid}';renderStaffQueue()`);
  await page.waitForTimeout(250);
}
function patches(page: import('@playwright/test').Page) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/queue_entries')) out.push(r.postDataJSON());
    const ci = checkinAsRow(r); if (ci) out.push(ci); // a check-in is one staff_checkin call (2026-10-04)
  });
  return out;
}

test('the Bookings table shows Beg / Int, and its bike filter lists the types, then Bike owner and Rental bike', async ({ page }) => {
  await staffBoot(page, SAT, [row('a', SAT, { ride_group: 'beg' }), row('b', SAT, { ride_group: 'int', queue_num: 2 }), row('c', SAT, { queue_num: 3 })]);
  // the table on a desk, the cards on a phone: whichever shows, it reads Beg / Int
  const mobile = await page.locator('.queue-mobile-view').isVisible();
  if (!mobile) await expect(page.locator('.queue-table th', { hasText: /^Group/ })).toBeVisible();
  await expect(page.locator(mobile ? '.queue-mobile-view .rg-chip' : '.queue-table .rg-chip')).toHaveText(['Beg', 'Int']);
  const opts = await page.evaluate(`[...document.querySelectorAll('#tab-queue select.filter-select')].map(s=>[...s.options].map(o=>o.value)).find(v=>v.includes('Road'))`) as string[];
  expect(opts).toEqual(['all', 'Road', 'Hybrid', 'Mountain', 'Kids', 'Road Carbon', 'own', 'rental']);
});

test('a JCC night has no Group column and the same bike filter', async ({ page }) => {
  await staffBoot(page, JCC, [row('j', JCC)]);
  await expect(page.locator('.queue-table th', { hasText: /^Group/ })).toHaveCount(0);
  const opts = await page.evaluate(`[...document.querySelectorAll('#tab-queue select.filter-select')].map(s=>[...s.options].map(o=>o.value)).find(v=>v.includes('Road'))`) as string[];
  expect(opts).toEqual(['all', 'Road', 'Hybrid', 'Mountain', 'Kids', 'Road Carbon', 'own', 'rental']);
});

test('the Saturday check-in asks the type and the group, with Cancel, Waiting and Check in', async ({ page }) => {
  await staffBoot(page, SAT, [row('a', SAT)]);
  const sent = patches(page);
  await page.evaluate(`showCheckinModal('a')`);
  const box = page.locator('#checkin-modal .ci-sat');
  await expect(box).toBeVisible();
  await expect(box.locator('.ci-outcomes, #ci-bike, #ci-money')).toHaveCount(0); // no outcomes, no bike field, no money
  await expect(box.locator('.modal-footer button')).toHaveText(['Cancel', 'Save, check in later', 'Check In']);
  await expect(box.locator('#ci-confirm')).toBeDisabled();   // a group first
  await expect(box.locator('#ci-waiting')).toBeDisabled();

  // Cancel: picks are dropped, nothing written
  await box.locator('[data-rg="beg"]').click();
  await box.locator('#ci-cancel').click();
  await expect(page.locator('#checkin-modal .ci-sat')).toHaveCount(0);
  expect(sent.length).toBe(0);

  // Waiting: the type and the group are kept, the rider still waits
  await page.evaluate(`showCheckinModal('a')`);
  await expect(box.locator('[data-rg="beg"]')).toHaveAttribute('aria-pressed', 'false'); // Cancel kept nothing
  await box.locator('[data-rg="int"]').click();
  await box.locator('.ci-opts .toggle-btn', { hasText: /^Hybrid$/ }).click();
  await box.locator('#ci-waiting').click();
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  expect(sent[0]).toMatchObject({ ride_group: 'int', type_preference: 'Hybrid' });
  expect(sent[0].status).toBeUndefined();

  // Check in: on the ride, with the group
  await expect(page.locator('#checkin-modal .ci-sat')).toHaveCount(0); // Waiting closes the modal
  await page.waitForLoadState('networkidle');                            // and its reload lands
  sent.length = 0;
  await page.evaluate(`getQueue().find(e=>e.id==='a').rideGroup=null;showCheckinModal('a')`);
  await box.locator('[data-rg="beg"]').click();
  await box.locator('#ci-confirm').click();
  await expect.poll(() => sent.some((p) => p.status === 'active')).toBe(true);
  expect(sent.find((p) => p.status === 'active')).toMatchObject({ ride_group: 'beg' });
});

test('a JCC check-in keeps its full modal', async ({ page }) => {
  await staffBoot(page, JCC, [row('j', JCC)]);
  await page.evaluate(`showCheckinModal('j')`);
  await expect(page.locator('#checkin-modal .ci-outcomes')).toBeVisible();
  await expect(page.locator('#checkin-modal .rg-field')).toHaveCount(0);
});

test('Add rider onto a Saturday ride asks the group and books it', async ({ page }) => {
  await staffBoot(page, SAT, [row('a', SAT, { ride_group: 'beg' })], {
    customers: [{ id: 'cust9', name: 'New Rider', email: 'new@example.com', phone: '0550000001', height: 170, type_preference: 'Road' }],
  });
  const rows = await captureBookingRows(page);
  await page.evaluate(`showCommAddModal()`);
  const m = page.locator('#comm-add-modal');
  await m.locator('#ca-search').fill('New Rider');
  await m.locator('.cmy-ca-row', { hasText: 'New Rider' }).click();
  const add = m.locator('.modal-footer .btn-primary');
  await expect(add).toBeDisabled();            // a group first
  await m.locator('[data-rg="beg"]').click();
  await expect(add).toBeEnabled();
  await add.click();
  await expect.poll(() => rows.length).toBe(1);
  expect(rows[0].ride_group).toBe('beg');
});

// The My Bookings card's Meeting point button opened the bookings page again: its href was written
// href=""${link}", an empty address with the link left outside it (2026-10-02).
test('the booking card’s Meeting point opens the ride’s map link', async ({ page }) => {
  const MEET = 'https://maps.app.goo.gl/spec-meet';
  await stubSupabase(page, { sessions: [{ ...sat, meet_url: MEET }], bikes: [], 'rpc:community_member': true,
    queue_entries: [row('mine', SAT, { customer_id: 'c1', name: 'Spec Rider', ride_group: 'beg' })] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('myrides')`);
  const a = page.locator('#tab-myrides a.cu-tk-dir').first();
  await expect(a).toHaveAttribute('href', MEET);
  await expect(a).toHaveAttribute('target', '_blank');
});

// Each Saturday ride may set its two distances (the owner, 2026-10-02); without them the groups ride
// 20 and 40 km. They show on the rider's pills and in Ride details, English and Arabic.
test('a ride’s own distances show on the pills and in Ride details', async ({ page }) => {
  const own = { ...sat, bike_slots: JSON.stringify({ _time: '05:45 - 06:15', _km: { beg: 25, int: 45 } }) };
  await stubSupabase(page, { sessions: [own], bikes: [], queue_entries: [row('a', SAT)], 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.selEvent='community';S.selSession='${SAT}';S.regStep=2;S.regBikeHeights=['175'];S.regBikeTypes=['Road'];setCustTab('register')`);
  await expect(page.locator('#reg-group-wrap [data-rg]')).toHaveText([/Beginners’ group.*25 km/, /Intermediates’ group.*45 km/]);
  await loadStaffHalf(page); // Ride details is built on the staff side
  expect(await page.evaluate(`_rmRideText(allSessions()[0],'en')`)).toContain('Beginner’s Group *25km*\nIntermediate Group *45km*');
  expect(await page.evaluate(`_rmRideText(allSessions()[0],'ar')`)).toContain('مجموعة المبتدئين *25 كم*\nمجموعة المتوسطين *45 كم*');
  expect(await page.evaluate(`_rmRideText({...allSessions()[0],bike_slots:'{"_time":"05:45 - 06:15"}'},'en')`)).toContain('*20km*'); // none set: the usual
});

test('the new-session form keeps the distances staff give, and only those', async ({ page }) => {
  await staffBoot(page, SAT, [row('a', SAT)]);
  const slots = await page.evaluate(`(()=>{S.newSessEvent='community';S.newSessSpots='30';S.newSessKm={beg:'22.5',int:''};return _nsSlots('05:45 - 06:15','').slots;})()`);
  expect(slots).toEqual({ _time: '05:45 - 06:15', _km: { beg: 22.5 } });
  const none = await page.evaluate(`(()=>{S.newSessKm={};return _nsSlots('05:45 - 06:15','').slots;})()`);
  expect(none).toEqual({ _time: '05:45 - 06:15' });
  // the form asks them on a Saturday ride, with the usual distances as placeholders
  await page.evaluate(`setStaffTab('queue');S.queueView='sessions';S.showAddSession=true;S.newSessEvent='community';renderStaffQueue()`);
  await expect(page.locator('#newSessKm-beg')).toHaveAttribute('placeholder', '20');
  await expect(page.locator('#newSessKm-int')).toHaveAttribute('placeholder', '40');
});

// A copy of the app from before could send Any; the server refuses it (PICK_TYPE, 20261002160000) and
// the rider is taken back to choose a bike type.
test('a booking the server refuses for Any goes back to the bike type', async ({ page }) => {
  await stubSupabase(page, { sessions: [sat], bikes: [], queue_entries: [], 'rpc:community_member': true,
    'rpc:customer_create_booking': { __rpcError: { status: 400, code: 'P0001', message: 'PICK_TYPE' } } });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.selEvent='community';S.selSession='${SAT}';S.regStep=3;S.regBikeHeights=['175'];S.regBikeTypes=['Road'];S.regRideGroup='beg';S.regRiderNames=['Spec Rider'];S.waiverOk=true;setCustTab('register');submitReg()`);
  await expect.poll(() => page.evaluate('S.regStep')).toBe(2);
  await expect(page.locator('#reg-type-wrap-0')).toBeVisible(); // the riders step, where the type is chosen
});
// This app never sends Any: the riders step wants a type first, so a seeded Any stops there.
test('the app itself asks for a type instead of sending Any', async ({ page }) => {
  const rows = await (async () => {
    await stubSupabase(page, { sessions: [sat], bikes: [], queue_entries: [], 'rpc:community_member': true });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
    await page.goto('/');
    await waitForSb(page);
    return captureBookingRows(page);
  })();
  await page.evaluate(`S.selEvent='community';S.selSession='${SAT}';S.regStep=2;S.regBikeHeights=['175'];S.regBikeTypes=['Any'];S.regRideGroup='beg';setCustTab('register')`);
  expect(await page.evaluate('validateRegInputs()')).toBe(false);
  await page.waitForTimeout(300);
  expect(rows.length).toBe(0);
});
