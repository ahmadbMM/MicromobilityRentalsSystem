import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff open a rider's account and see what is on today, what is booked ahead, each with Edit,
// and everything they have ridden, missed or cancelled. A party is one booking. The window reads
// the bookings the staff device already holds; only rides older than that are asked for, one
// small read for this rider alone.

const day = (n: number) => new Date(Date.now() + n * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const TD = day(0), T1 = day(3), T2 = day(10), P1 = day(-7), P2 = day(-20), P3 = day(-40), OLD = day(-500);
const slots = (time: string) => JSON.stringify({ _time: time, _total: 40 });
const sessions = [
  { id: TD, day: 'Tuesday', session_date: TD, capacity: 40, status: 'open', created_at: 0, bike_slots: slots('21:00 - 23:00') },
  { id: T1, day: 'Thursday', session_date: T1, capacity: 40, status: 'open', created_at: 1, bike_slots: slots('21:00 - 23:00') },
  { id: T2 + '-pw', day: 'Wednesday', session_date: T2, capacity: 40, status: 'open', created_at: 2, bike_slots: slots('20:00 - 22:00'), event_kind: 'community', ride_kind: 'petromin' },
  { id: P1, day: 'Sunday', session_date: P1, capacity: 40, status: 'open', created_at: 3, bike_slots: slots('21:00 - 23:00') },
  { id: P2, day: 'Monday', session_date: P2, capacity: 40, status: 'open', created_at: 4, bike_slots: slots('21:00 - 23:00') },
  { id: P3, day: 'Tuesday', session_date: P3, capacity: 40, status: 'open', created_at: 5, bike_slots: slots('21:00 - 23:00') },
];
const customers = [
  { id: 'c1', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', phone: '+966551876215', gender: 'female', created_at: '2026-06-10T09:00:00Z' },
  { id: 'c2', name: 'Omar Saleh', email: 'omar.saleh@gmail.com', phone: '+966551876216', gender: 'male', created_at: '2026-06-11T09:00:00Z' },
  { id: 'c3', name: 'Someone Else', email: 'someone.else@gmail.com', phone: '+966551876217', gender: 'male', created_at: '2026-06-12T09:00:00Z' },
];
const bikes = [{ id: 'b7', name: 'Road 07', type: 'Road', size: 'M', status: 'available' }];
const row = (id: string, s: { id: string; day: string; session_date: string }, qn: number, name: string, customer_id: string | null, status: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: s.id, session_day: s.day, session_date: s.session_date, queue_num: qn, name,
  phone: customer_id === 'c1' ? '+966551876215' : '0551112222', customer_id, status, paid: false,
  type_preference: 'Road', price: 115, walk_in: !customer_id, registered_at: '2026-09-01T10:00:00Z', ...extra,
});
const [sTD, sT1, sT2, sP1, sP2, sP3] = sessions;
const queue_entries = [
  row('t1', sTD, 1, 'Lina Haddad', 'c1', 'active', { assigned_bike_id: 'b7' }),
  row('u1', sT1, 4, 'Lina Haddad', 'c1', 'waiting'),
  row('u2', sT1, 5, 'Maya Haddad', 'c1', 'waiting', { type_preference: 'Kids', price: 57.5 }),
  row('u3', sT2, 9, 'Lina Haddad', 'c1', 'waitlist', { type_preference: 'Hybrid' }),
  row('h1', sP1, 2, 'Lina Haddad', 'c1', 'done', { paid: true, assigned_bike_id: 'b7', rating_exp: 9 }),
  row('h2', sP2, 3, 'Lina Haddad', 'c1', 'noshow'),
  row('h3', sP3, 1, 'Lina Haddad', 'c1', 'cancelled', { cancelled_by: 'customer', paid: true }),
  row('x1', sT1, 6, 'Someone Else', 'c3', 'waiting'),
  row('w1', sP1, 7, 'Walk Person', null, 'done', { paid: true }),
  row('w2', sP2, 8, 'Walk Person', null, 'done'),
];

async function staff(page: Page) {
  await stubSupabase(page, { sessions, queue_entries, bikes, customers, tags: [], customer_tags: [], staff_options: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length===3&&(S.queue||[]).length===10');
  await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';S.amSearch='';renderCustomers()`);
}
const modal = (page: Page) => page.locator('#cust-modal');
const cards = (page: Page) => modal(page).locator('.ah-bk');
// The containers are empty boxes around a fixed backdrop; visibility is the dialog's.
const box = (page: Page, id: string) => page.locator(`#${id} .modal-box`);

test('the Accounts row shows what is coming up and opens it over the rider\'s past', async ({ page }) => {
  await staff(page);
  const btn = page.locator('.am-row[data-cust="c1"] .am-hist');
  // the count rides beside the button's name (the name only shows on a phone card)
  await expect(btn.locator('.am-hist-n')).toHaveText('3');         // today's ride and two ahead; the party is one
  await expect(btn).toHaveClass(/\bon\b/);
  await expect(page.locator('.am-row[data-cust="c2"] .am-hist .am-hist-n')).toHaveCount(0);
  await btn.click();

  await expect(modal(page).locator('#ah-title')).toHaveText('Lina Haddad');
  await expect(modal(page).locator('.modal-sub')).toContainText('lina.haddad@gmail.com');
  await expect(modal(page).locator('.ah-sec')).toHaveText(['Current bookings 1', 'Future bookings 2', 'History 3']);
  await expect(modal(page).locator('.ah-kpi-v')).toHaveText(['1', '1', '1', 'SAR 115']); // done, no-show, cancelled, paid

  // Today: out on a bike now.
  await expect(cards(page).nth(0).locator('.status-badge')).toHaveText('On Bike');
  await expect(cards(page).nth(0)).toContainText('Road 07');
  // Ahead, soonest first: the party of two, then the Petromin waitlist place.
  await expect(cards(page).nth(1).locator('.ah-bk-party')).toHaveText('2 riders');
  await expect(cards(page).nth(1).locator('.ah-rider-name')).toHaveText(['Lina Haddad', 'Maya Haddad']);
  await expect(cards(page).nth(2)).toHaveClass(/ev-petromin/);
  await expect(cards(page).nth(2).locator('.status-badge')).toHaveText('Waitlist');
  // Then the history, newest first, with what happened to each.
  await expect(cards(page).nth(3).locator('.status-badge')).toHaveText('Complete');
  await expect(cards(page).nth(3)).toContainText('★ 9/10');
  await expect(cards(page).nth(4).locator('.status-badge')).toHaveText('No-Show');
  await expect(cards(page).nth(5).locator('.status-badge')).toHaveText('Cancelled by Customer');
  // Only bookings still to be ridden can be edited; another rider's never shows.
  await expect(modal(page).locator('.ah-edit')).toHaveCount(4);
  await expect(cards(page).nth(3).locator('.ah-edit')).toHaveCount(0);
  await expect(modal(page)).not.toContainText('Someone Else');
});

test('Edit opens the booking over the history, and Escape closes one window at a time', async ({ page }) => {
  await staff(page);
  await page.locator('.am-row[data-cust="c1"] .am-hist').click();
  await modal(page).locator('.ah-edit').first().click();
  await expect(page.locator('#booking-edit-modal .modal-title')).toContainText('#1');
  await page.keyboard.press('Escape');
  await expect(box(page, 'booking-edit-modal')).toBeHidden();
  await expect(box(page, 'cust-modal')).toBeVisible();
  // The flag dialog sits over the history too, and Escape closes it first.
  await modal(page).locator('.fl-open').click();
  await expect(page.locator('#confirm-modal .fl-row').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#confirm-modal .fl-row').first()).toBeHidden();
  await expect(box(page, 'cust-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(box(page, 'cust-modal')).toBeHidden();
});

test('an open history follows the data, and leaves itself alone when nothing of the rider\'s changed', async ({ page }) => {
  await staff(page);
  await page.locator('.am-row[data-cust="c1"] .am-hist').click();
  await expect(modal(page).locator('.ah-sec')).toHaveText(['Current bookings 1', 'Future bookings 2', 'History 3']);
  expect(await page.evaluate(`(()=>{const b=document.querySelector('#cust-modal .ah-box');
    S.queue=S.queue.map(e=>e.id==='x1'?{...e,status:'cancelled'}:e);_renderStaffTab();
    return b===document.querySelector('#cust-modal .ah-box');})()`)).toBe(true);
  await page.evaluate(`S.queue=S.queue.map(e=>e.id==='u3'?{...e,status:'cancelled',cancelledBy:'staff'}:e);_renderStaffTab()`);
  await expect(modal(page).locator('.ah-sec')).toHaveText(['Current bookings 1', 'Future bookings 1', 'History 4']);
  await expect(modal(page).locator('.ah-kpi-v').nth(2)).toHaveText('2');
});

test('from the account editor, the history steps in front and hands the editor back as it was', async ({ page }) => {
  await staff(page);
  await page.evaluate(`showEditCustomerModal('c1')`);
  await page.fill('#cf-first', 'Leena');
  await page.locator('#new-acct-modal .cf-head-btns button', { hasText: 'Bookings & history' }).click();
  await expect(box(page, 'cust-modal')).toBeVisible();
  await expect(box(page, 'new-acct-modal')).toBeHidden();
  await modal(page).locator('.ah-close').click();
  await expect(box(page, 'new-acct-modal')).toBeVisible();
  await expect(page.locator('#cf-first')).toHaveValue('Leena');
  // Edit customer from the history goes back to that same editor, not a fresh one.
  await page.locator('#new-acct-modal .cf-head-btns button', { hasText: 'Bookings & history' }).click();
  await modal(page).locator('.ah-actions button', { hasText: 'Edit customer' }).click();
  await expect(box(page, 'cust-modal')).toBeHidden();
  await expect(page.locator('#cf-first')).toHaveValue('Leena');
});

test('rides older than the device holds come in one small read, for this rider only', async ({ page }) => {
  const reads: string[] = [];
  await staff(page);
  let customerReads = 0;
  page.on('request', r => { if (r.method() === 'GET' && /rest\/v1\/customers/.test(r.url())) customerReads++; });
  await page.route(/rest\/v1\/queue_entries\?.*customer_id=eq\./, route => {
    reads.push(decodeURIComponent(route.request().url()));
    const old = { ...row('o1', { id: OLD, day: 'Friday', session_date: OLD }, 11, 'Lina Haddad', 'c1', 'done', { paid: true }) };
    const stray = { ...row('o2', { id: OLD, day: 'Friday', session_date: OLD }, 12, 'Someone Else', 'c3', 'done') };
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([old, stray]) });
  });
  await page.locator('.am-row[data-cust="c1"] .am-hist').click();
  await expect(modal(page).locator('.ah-sec')).toHaveText(['Current bookings 1', 'Future bookings 2', 'History 4']);
  await expect(cards(page).last()).toContainText('#11');
  await expect(modal(page)).not.toContainText('Someone Else');
  expect(reads).toHaveLength(1);
  expect(reads[0]).toContain('customer_id=eq.c1');
  expect(reads[0]).toMatch(/session_date=lt\.\d{4}-\d{2}-\d{2}/);
  // Opened again: already in hand, nothing asked twice; and no customer list reload either way.
  await modal(page).locator('.ah-close').click();
  await page.locator('.am-row[data-cust="c1"] .am-hist').click();
  await expect(cards(page)).toHaveCount(7);
  expect(reads).toHaveLength(1);
  expect(customerReads).toBe(0);
});

test('a walk-in opened from a booking is matched by name and phone', async ({ page }) => {
  await staff(page);
  await page.evaluate(`openCustomerProfile('w1')`);
  await expect(modal(page).locator('#ah-title')).toHaveText('Walk Person');
  await expect(modal(page).locator('.modal-sub')).toContainText('Walk-in (no account)');
  await expect(modal(page).locator('.ah-sec')).toHaveText(['Current bookings', 'Future bookings', 'History 2']);
  await expect(modal(page).locator('.ah-actions')).toHaveCount(0);   // no account: nothing to flag or edit
});

// Production holds ~2,700 accounts and ~5,000 bookings. The per-row count must come from one
// index built once per list, never a scan of every booking for every row.
test('at production size, the row counts come from one index built once', async ({ page }) => {
  await staff(page);
  const seed = `(()=>{
    S.customers=Array.from({length:2700},(_,i)=>({id:'k'+i,name:'Rider '+i+' Name',email:'r'+i+'@example.test',phone:'+96650'+String(1000000+i*7),gender:'male',created_at:new Date(Date.UTC(2026,5,1,0,i)).toISOString()}));
    S.queue=Array.from({length:5200},(_,i)=>({id:'q'+i,customerId:'k'+(i%2700),sessionId:'${T1}',sessionDate:'${T1}',sessionDay:'Thursday',queueNum:i+1,status:i%3?'done':'waiting',name:'Rider',price:115}));
    renderCommunity();return true;})()`;
  expect(await page.evaluate(seed)).toBe(true);
  expect(await page.evaluate(`(()=>{const a=_ahByCust();renderCommunity();S.customers.slice(0,300).forEach(c=>_ahUpcoming(c.id));return a===_ahByCust();})()`)).toBe(true);
  expect(await page.evaluate(`_ahUpcoming('k0')`)).toBe(1);        // two riders, one night: one booking
  await page.evaluate(`openAccountHistory('k0')`);
  await expect(modal(page).locator('.ah-sec').nth(1)).toHaveText('Future bookings 1');
});
