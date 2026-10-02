import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, captureBookingRows } from './helpers/supabase';

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
  await expect(box.locator('.modal-footer button')).toHaveText(['Cancel', 'Waiting', 'Check In']);
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
