import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Every modal, opened with realistic data, asserting nothing throws. The tabs already have a
// smoke test; the modals did not, and they are where a refactor's loose end hides — a helper
// hoisted out of one render function and still referenced from another crashes only when the
// staffer opens that one dialog, which may be days later at the booth.

const sessions = [
  { id: '2099-11-01', day: 'Sunday', session_date: '2099-11-01', capacity: 12, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":12}', addons: '["i1"]' },
  { id: '2099-11-07', day: 'Saturday', session_date: '2099-11-07', capacity: 20, status: 'open', created_at: 2, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: true, spots: 20, title: 'Saturday Social Ride', bike_slots: '{"_time":"05:45 - 06:15"}' },
  { id: '2099-11-11-pw', day: 'Wednesday', session_date: '2099-11-11', capacity: 10, status: 'open', created_at: 3, event_kind: 'community', ride_kind: 'petromin', paid_ride: true, needs_approval: false, hide_queue: false, title: 'Petromin Wednesday Ride', bike_slots: '{"_time":"19:00 - 21:00","_total":10}' },
];
const bikes = [
  { id: 'b1', name: 'R1', size: 'M', type: 'Road', status: 'available', rental_price: 75 },
  { id: 'b2', name: 'H1', size: 'L', type: 'Hybrid', status: 'in-use', rental_price: 60 },
];
const entry = (id: string, extra: Record<string, unknown>) => ({
  id, session_id: '2099-11-01', session_day: 'Sunday', session_date: '2099-11-01',
  queue_num: 1, name: 'Rider ' + id, phone: '0551110000', email: 'r@example.com', size: 'M',
  type_preference: 'Road', status: 'waiting', paid: false, price: 75, height: 175,
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});
const fixtures = {
  sessions, bikes,
  queue_entries: [
    entry('q1', {}),
    entry('q2', { status: 'active', assigned_bike_id: 'b2', queue_num: 2, paid: true }),
    entry('q3', { status: 'done', queue_num: 3, paid: true, ride_duration: 95 }),
    entry('q4', { status: 'waitlist', queue_num: 4, waitlist_num: 1 }),
    entry('q5', { session_id: '2099-11-07', session_day: 'Saturday', session_date: '2099-11-07', queue_num: 5, approval: 'pending', price: 0 }),
    entry('q6', { queue_num: 6, group_id: 'g1', group_name: 'Tamer Group' }),
    entry('q7', { queue_num: 7, group_id: 'g1', group_name: 'Tamer Group' }),
  ],
  customers: [{ id: 'c1', name: 'Rider q1', email: 'r@example.com', phone: '0551110000', created_at: 1, height: 175 }],
  inventory: [{ id: 'i1', name: 'Energy Gel', category: 'EnergyGels', qty: 8, price: 12, low_threshold: 2 }],
  desk_waitlist: [
    { id: 'w1', name: 'Walk Up', phone: '0500000000', bike_type: 'Road', status: 'waiting', kind: 'walkup', created_at: '2099-01-01T11:00:00Z' },
    { id: 'w2', name: 'Rider q1', phone: '0551110000', bike_type: 'Road', status: 'waiting', kind: 'managed', sort_order: 1, booking_id: 'q1', created_at: '2099-01-01T11:00:00Z' },
  ],
  tags: [{ id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#4aa8f8', auto_grant: false, locked: true }],
  customer_tags: [{ customer_id: 'c1', tag_id: 'tag_saturday', starts_at: null, expires_at: null }],
  team_members: [{ id: 't1', name: 'Staffer', active: true }],
  'rpc:staff_inventory_extras': [], // Inventory asks for it on render (20261009 fleet); a database without it answers 404, which the console reports
};

// Each entry: the call to open it, and what it needs set up first.
const MODALS: [string, string][] = [
  ['check-in (waiting)', `showCheckinModal('q1')`],
  ['check-in (waitlisted)', `showCheckinModal('q4')`],
  ['bike picker', `openModal('q1')`],
  ['booking edit', `showBookingEditModal('q1')`],
  ['edit price', `showEditPriceModal('q1')`],
  ['edit queue number', `showEditQNumModal('q1')`],
  ['group edit', `showGroupEditModal('q6')`],
  ['reschedule', `showRescheduleModal('q1')`],
  ['cancel reason', `showCancelReasonModal('q1')`],
  ['return payment', `showReturnPayModal('q2')`],
  ['receipt', `showReceipt('q3')`],
  ['walk-in', `showWalkinModal()`],
  ['JCC group', `showJccGroupModal()`],
  ['community add', `S.sfSession='2099-11-07';showCommAddModal()`],
  ['customer editor', `showEditCustomerModal('c1')`],
  ['bookings & history', `openAccountHistory('c1')`],
  ['bookings & history from a booking', `openCustomerProfile('q1')`],
  ['new account', `showNewAcctModal()`],
  ['tag grant', `showTagGrantModal('c1')`],
  ['team manager', `showTeamManager()`],
  ['cashier', `showCashierModal()`],
  ['add-on picker', `showAddonPicker('q1')`],
  ['nutrition', `showNutrition('i1')`],
  ['print report options', `showPrintReportOptions()`],
  ['account report options', `showAccountReportOptions()`],
  ['members-only', `showCommMembersModal(allSessions().find(s=>s.id==='2099-11-07'))`],
];

test('every staff modal opens without throwing', async ({ page }) => {
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));

  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true&&getQueue().length>0`);

  const broken: string[] = [];
  for (const [name, call] of MODALS) {
    const before = errs.length;
    const thrown = await page.evaluate(`(()=>{try{${call};return '';}catch(e){return String(e&&e.message||e);}})()`) as string;
    await page.waitForTimeout(60);
    if (thrown) broken.push(`${name}: ${thrown}`);
    else if (errs.length > before) broken.push(`${name}: ${errs.slice(before).join(' / ')}`);
    await page.evaluate(`document.querySelectorAll('.modal-backdrop').forEach(el=>el.remove());
      document.querySelectorAll('[id$="-modal"]').forEach(el=>{el.style.display='none';});`);
  }
  expect(broken, broken.join('\n')).toEqual([]);
});

test('every staff tab and queue view renders without throwing', async ({ page }) => {
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));

  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true`);

  const broken: string[] = [];
  for (const tab of ['queue', 'bikes', 'inventory', 'cashier', 'community', 'analytics', 'history']) {
    const before = errs.length;
    const thrown = await page.evaluate(`(()=>{try{setStaffTab('${tab}');return '';}catch(e){return String(e&&e.message||e);}})()`) as string;
    await page.waitForTimeout(80);
    if (thrown || errs.length > before) broken.push(`${tab}: ${thrown || errs.slice(before).join(' / ')}`);
  }
  for (const view of ['bookings', 'sessions', 'waitlist', 'managed']) {
    const before = errs.length;
    const thrown = await page.evaluate(`(()=>{try{setStaffTab('queue');S.queueView='${view}';renderStaffQueue();return '';}catch(e){return String(e&&e.message||e);}})()`) as string;
    await page.waitForTimeout(80);
    if (thrown || errs.length > before) broken.push(`view ${view}: ${thrown || errs.slice(before).join(' / ')}`);
  }
  expect(broken, broken.join('\n')).toEqual([]);
});

// Actions, not renders: printing the roster, the close-out and the exports are booth-critical
// and only run when someone presses the button, so no render smoke covers them. They build
// documents out of the same awkward rows — a booking with no bike, a group with no name, a
// community rider with no queue number — which is exactly where a document builder throws.
test('reports, exports and receipts build without throwing', async ({ page }) => {
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));
  // print/export open windows and download blobs; neutralise both so the test stays headless
  await page.addInitScript(() => {
    window.open = () => ({ document: { write() {}, close() {} }, focus() {}, print() {}, close() {} }) as unknown as Window;
    URL.createObjectURL = () => 'blob:stub';
    HTMLAnchorElement.prototype.click = function () {};
  });

  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true&&getQueue().length>0`);

  const ACTIONS: [string, string][] = [
    ['print report (JCC session)', `S.sfSession='2099-11-01';printSessionReport()`],
    ['print report (all sessions)', `S.sfSession='all';printSessionReport()`],
    ['height/bike report', `printHeightBikeReport()`],
    ['print roster (social ride)', `printCommunityRoster(allSessions().find(s=>s.id==='2099-11-07'))`],
    ['close-out', `printCloseout()`],
    ['session export', `S.sfSession='2099-11-01';exportSessionExcel()`],
    ['action-log CSV', `exportLogsCSV()`],
  ];
  const broken: string[] = [];
  for (const [name, call] of ACTIONS) {
    const before = errs.length;
    const thrown = await page.evaluate(`(()=>{try{${call};return '';}catch(e){return String(e&&e.message||e);}})()`) as string;
    await page.waitForTimeout(80);
    if (thrown || errs.length > before) broken.push(`${name}: ${thrown || errs.slice(before).join(' / ')}`);
  }
  expect(broken, broken.join('\n')).toEqual([]);
});

// The rider's side. A crash here costs a booking rather than a click, and the awkward rows are
// different: a ride whose session closed under them, a waitlisted booking, a community ride
// they may not book, a group booked on one account.
test('every customer screen and dialog renders without throwing', async ({ page }) => {
  const errs: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));

  await stubSupabase(page, { ...fixtures, 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Rider q1' });
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.dataLoaded===true`);

  const STEPS: [string, string][] = [
    ['landing', `goLanding()`],
    ['pick JCC', `selectEvent('jcc')`],
    ['reserve step 1', `setCustTab('register');S.regStep=1;renderRegister()`],
    ['reserve step 2', `S.selSession='2099-11-01';S.regStep=2;S.regQty=2;ensureBikeSizes();renderRegister()`],
    ['reserve step 3', `S.regStep=3;renderRegister()`],
    ['my rides', `setCustTab('myrides')`],
    ['account', `setCustTab('account')`],
    ['pick the rides card', `selectEvent('community')`],
    ['community ride selected', `S.selSession='2099-11-11-pw';S.regStep=2;renderRegister()`],
    ['saturday ride selected', `S.selSession='2099-11-07';S.regStep=2;renderRegister()`],
    ['a session that closed under them', `S.selSession='__gone__';renderRegister()`],
    ['auth dialog', `renderAuthModal()`],
  ];
  const broken: string[] = [];
  for (const [name, call] of STEPS) {
    const before = errs.length;
    const thrown = await page.evaluate(`(()=>{try{${call};return '';}catch(e){return String(e&&e.message||e);}})()`) as string;
    await page.waitForTimeout(70);
    if (thrown || errs.length > before) broken.push(`${name}: ${thrown || errs.slice(before).join(' / ')}`);
  }
  expect(broken, broken.join('\n')).toEqual([]);
});
