import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures, type FailWrite } from './helpers/supabase';

// The staff desk's roster, party and account tools, held to what they promise: stored values
// render as text, a second tap does not save twice, the party buttons do what they show, a
// party moves only where there is room and never off a bike, the All view shows tonight, and
// the forms save what they display.

const LIVE = '2099-03-01';
const sess = (id: string, extra: Record<string, unknown> = {}) => ({
  id, day: 'Sunday', session_date: id.slice(0, 10), status: 'open', capacity: 20, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...extra,
});
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: 1, name: 'Rider ' + id,
  phone: '0550000000', customer_id: null, type_preference: 'Road', status: 'waiting', paid: false,
  price: 75, size: 'M', registered_at: '2099-01-01T10:00:00Z', ...extra,
});

async function boot(page: Page, fx: Fixtures, fail?: FailWrite) {
  await stubSupabase(page, { bikes: [], customers: [], tags: [], customer_tags: [], ...fx }, fail);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
function writes(page: Page, table: string, method = 'POST') {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() !== method || !new RegExp(`/rest/v1/${table}(\\?|$)`).test(r.url())) return;
    let b: unknown = null;try { b = r.postDataJSON(); } catch { /* none */ }
    (Array.isArray(b) ? b : [b]).forEach((x) => out.push({ ...(x as Record<string, unknown>), _url: r.url() }));
  });
  return out;
}

// ── stored values are text ──────────────────────────────────────────────────
const EVIL_ID = `q"><img src=x onerror="window.__pwned='id'">'`;
const EVIL_GROUP = `g'"><img src=x onerror="window.__pwned='group'">`;
const EVIL_CUST = `c'"><img src=x onerror="window.__pwned='cust'">`;

test('ids, days and types that carry markup render as text, and the buttons still work', async ({ page }) => {
  await boot(page, {
    sessions: [sess(LIVE)],
    queue_entries: [
      row(EVIL_ID, { session_day: `<img src=x onerror="window.__pwned='day'">`, type_preference: `<img src=x onerror="window.__pwned='type'">` }),
      row('p1', { queue_num: 2, group_id: EVIL_GROUP, group_name: 'Crew' }),
      row('p2', { queue_num: 3, group_id: EVIL_GROUP, group_name: 'Crew' }),
    ],
    customers: [{ id: EVIL_CUST, name: 'Evil Account', email: 'evil@example.test', phone: '+966500000009', created_at: '2026-01-01T00:00:00Z' }],
    customer_flags: [{ id: 'f1', customer_id: EVIL_CUST, fields: ['name'], status: 'answered', flagged_at: '2026-09-01T10:00:00Z', answered_at: '2026-09-02T10:00:00Z', changes: {} }],
  });
  await page.waitForFunction('getQueue().length>2&&(S.customers||[]).length>0');
  // A row's action cluster (_entryActions, _rowMenu) is another part of the desk, fixed and
  // tested on its own; it is set aside here so this spec speaks for the rows around it.
  await page.evaluate(`window._entryActions=()=>'';window._rowMenu=()=>'';window.__pwned=undefined`); // a boot paint ran before this
  const pwned = () => page.evaluate(`[window.__pwned||null, document.querySelectorAll('img[src="x"]').length]`);

  for (const view of ['all', LIVE]) {
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession=${JSON.stringify(view)};renderStaffQueue()`);
    await page.waitForTimeout(150);
    expect(await pwned()).toEqual([null, 0]);
  }
  await page.evaluate(`showCommAddModal()`);
  await page.evaluate(`closeCommAddModal();showEditCustomerModal(${JSON.stringify(EVIL_CUST)})`);
  await page.evaluate(`closeCustFormModal();showWalkinModal();_wiRenderSuggest('Evil')`);
  await page.evaluate(`closeWalkinModal();setStaffTab('customers');S.customersTab='flagged';renderCustomers()`);
  await expect(page.locator('.flg-row')).toHaveCount(1);
  expect(await pwned()).toEqual([null, 0]);

  // The same odd values still reach their handlers intact - through the roster table's pay and
  // party buttons, which are the desktop layout (a phone lists cards; their markup is checked above).
  if (test.info().project.name === 'mobile') return;
  await page.evaluate(`setStaffTab('queue');S.sfSession=${JSON.stringify(LIVE)};renderStaffQueue()`);
  await page.locator('.queue-table .pay-toggle').first().click();
  await expect(page.locator('.pay-menu-popup')).toBeVisible();
  await page.evaluate(`document.querySelectorAll('.pay-menu-popup').forEach(m=>m.remove())`);
  const toggle = page.locator('.queue-table .party-toggle').first();
  await toggle.click();
  expect(await page.evaluate(`[...(S._partyOpen||[])].some(k=>k.includes(${JSON.stringify(EVIL_GROUP)}))`)).toBe(true);
});

// ── one save per tap ─────────────────────────────────────────────────────────
test('a second tap while a save is still on the wire writes nothing more', async ({ page }) => {
  await boot(page, { sessions: [sess(LIVE)], queue_entries: [] });
  const bookings = writes(page, 'queue_entries');
  const sessions = writes(page, 'sessions');

  await page.evaluate(`setStaffTab('queue');S.sfSession=${JSON.stringify(LIVE)};showWalkinModal()`);
  await page.fill('#wi-name', 'Tamer');
  await page.evaluate(`Promise.all([saveWalkin(),saveWalkin()])`);
  await expect.poll(() => bookings.length).toBe(1);

  await page.evaluate(`showJccGroupModal()`);
  await page.fill('#jg-name', 'Falcons');
  await page.evaluate(`Promise.all([saveJccGroup(),saveJccGroup()])`);
  await expect.poll(() => bookings.length).toBe(3);                      // one group of two, once

  await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S.newSessEvent='jcc';S.newSessMode='total';renderSessions()`);
  await page.evaluate(`document.getElementById('ns-date').value='2099-04-04';Promise.all([addSession(),addSession()])`);
  await expect.poll(() => sessions.filter((w) => w.id).length).toBe(1);
  await page.waitForTimeout(300);
  expect(sessions.filter((w) => w.id).map((w) => w.id)).toEqual(['2099-04-04']);   // never a "-2"
});

test('a session is not created with a start or end time left empty', async ({ page }) => {
  await boot(page, { sessions: [sess(LIVE)], queue_entries: [] });
  const sessions = writes(page, 'sessions');
  await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S.newSessEvent='jcc';S.newSessMode='total';renderSessions()`);
  await page.evaluate(`document.getElementById('ns-date').value='2099-04-04';document.getElementById('ns-start').value='';addSession()`);
  await expect(page.locator('#ns-start')).toHaveAttribute('aria-invalid', 'true');
  await page.waitForTimeout(300);
  expect(sessions).toHaveLength(0);
});

// ── the party's buttons ──────────────────────────────────────────────────────
test('Mark paid on a party back from the ride pays the riders who have finished', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'the party row and its Mark paid button are the desktop roster table');
  await boot(page, { sessions: [sess(LIVE)], queue_entries: [
    row('d1', { group_id: 'gp', status: 'done' }), row('d2', { queue_num: 2, group_id: 'gp', status: 'done' }),
  ] });
  await page.waitForFunction('getQueue().length===2');
  const patches = writes(page, 'queue_entries', 'PATCH');
  await page.evaluate(`setStaffTab('queue');S.sfSession=${JSON.stringify(LIVE)};S.sfShowFinished=true;renderStaffQueue()`);
  const btn = page.locator('.queue-table button', { hasText: /Mark paid/i }).first();
  await expect(btn).toBeVisible();
  await btn.click();
  await expect.poll(() => patches.filter((p) => p.paid === true).map((p) => String(p._url).match(/id=eq\.([^&]+)/)?.[1]).sort()).toEqual(['d1', 'd2']);
});

test('a party moves only where spotsLeft has room, and never while a member is on a bike', async ({ page }) => {
  const TARGET = '2099-03-08';
  await boot(page, { sessions: [sess(LIVE), sess(TARGET, { capacity: 2 })], queue_entries: [
    row('m1', { group_id: 'gm' }), row('m2', { queue_num: 2, group_id: 'gm' }),
    // the target night: two riders already done - their places are still held
    row('t1', { session_id: TARGET, session_date: TARGET, status: 'done' }), row('t2', { session_id: TARGET, session_date: TARGET, queue_num: 2, status: 'done' }),
    row('a1', { queue_num: 5, group_id: 'ga', status: 'active' }), row('a2', { queue_num: 6, group_id: 'ga' }),
  ] });
  await page.waitForFunction('getQueue().length===6');
  const patches = writes(page, 'queue_entries', 'PATCH');

  await page.evaluate(`showGroupEditModal('m1')`);
  await page.selectOption('#ge-sess', TARGET);
  await page.evaluate(`saveGroupEdit()`);
  await expect(page.locator('.toast').last()).toContainText(/space|room|full/i);
  await page.waitForTimeout(300);
  expect(patches.filter((p) => p.session_id)).toHaveLength(0);
  await page.evaluate(`closeGroupEditModal()`);

  await page.evaluate(`showGroupEditModal('a1')`);
  await expect(page.locator('#group-edit-modal .ge-no-move')).toBeVisible();
  await expect(page.locator('#ge-sess')).toHaveCount(0);
});

// ── the All view shows tonight ───────────────────────────────────────────────
test('All sessions puts tonight first under the cap, not a year-old night', async ({ page }) => {
  const old = Array.from({ length: 20 }, (_, i) => `2098-01-${String(i + 1).padStart(2, '0')}`);
  const oldRows = old.flatMap((d) => Array.from({ length: 10 }, (_, n) => row(`${d}-${n}`, {
    session_id: d, session_date: d, queue_num: n + 1, status: 'done', paid: true, name: 'Old ' + d + ' ' + n })));
  await boot(page, { sessions: [...old.map((d) => sess(d, { status: 'closed' })), sess(LIVE)],
    queue_entries: [...oldRows, row('tonight', { name: 'Tonight Rider' })] });
  await page.waitForFunction('getQueue().length>200');
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='all';renderStaffQueue()`);
  await expect(page.locator('#q-results')).toContainText('Tonight Rider');
});

// ── the forms save what they show ────────────────────────────────────────────
test('the breakfast stop the picker shows is the one saved, ride after ride', async ({ page }) => {
  await boot(page, { sessions: [sess(LIVE)], queue_entries: [],
    breakfast_spots: [{ id: 'bf1', name: 'Cafe One', url: 'https://maps.example.com/cafe' }] });
  await page.waitForFunction('(S.breakfastSpots||[]).length>0');
  const patches = writes(page, 'sessions', 'POST'); // the stop is on the one insert (2026-10-04)
  const create = async (date: string) => page.evaluate(`document.getElementById('ns-date').value='${date}';addSession()`);

  await page.evaluate(`setStaffTab('sessions');S.showAddSession=true;S.newSessEvent='community';S.newSessSpots='20';renderSessions()`);
  await page.selectOption('#sess-add-form select:has(option[value="bf1"])', 'bf1');
  await create('2099-05-02');
  await expect.poll(() => patches.filter((p) => p.breakfast_name === 'Cafe One').length).toBe(1);

  // the next ride's form starts on "None", and saves none
  await page.evaluate(`S.showAddSession=true;S.newSessEvent='community';renderSessions()`);
  await expect(page.locator('#sess-add-form select:has(option[value="bf1"])')).toHaveValue('');
  await create('2099-05-09');
  await page.waitForTimeout(400);
  expect(patches.filter((p) => p.breakfast_name).length).toBe(1);

  // a picker left on a spot (its typed fields cleared) still saves that spot
  await page.evaluate(`S.showAddSession=true;S.newSessEvent='community';S.newSessBfSel='bf1';S.newSessBfName='';S.newSessBfUrl='';renderSessions()`);
  await create('2099-05-16');
  await expect.poll(() => patches.filter((p) => p.breakfast_name === 'Cafe One').length).toBe(2);
});

test('the Flagged list retries after a failed read, and re-reads when a request changes', async ({ page }) => {
  let reads = 0;
  await boot(page, { sessions: [], queue_entries: [],
    customers: [{ id: 'c2', name: 'Omar Flagged', email: 'o@example.test', fix_fields: ['name'], created_at: '2026-01-06T10:00:00Z' }],
    customer_flags: [{ id: 'f1', customer_id: 'c2', fields: ['name'], status: 'pending', flagged_at: '2026-09-20T10:00:00Z', changes: {} }] });
  await page.route(/\/rest\/v1\/customer_flags/, (r) => {
    reads++;
    if (reads === 1) return r.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '{"message":"boom"}' });
    return r.fallback();
  });
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('customers');S.customersTab='flagged';renderCustomers()`);
  await expect(page.locator('.flg-retry')).toBeVisible();
  await page.locator('.flg-retry').click();
  await expect(page.locator('.flg-row')).toHaveCount(1);

  // The rider answers: their fix_fields clear (the staff-ref broadcast), and the list reads again.
  const before = reads;
  await page.evaluate(`S._flagsAt=Date.now()-5000;S.customers=S.customers.map(c=>({...c,fix_fields:null}));renderCommunity()`);
  await expect.poll(() => reads).toBeGreaterThan(before);
});

test('renaming a customer and changing their default payment in one save comps their live booking', async ({ page }) => {
  await boot(page, { sessions: [sess(LIVE)],
    customers: [{ id: 'c1', name: 'Old Name', email: 'old@example.test', phone: '+966500000001', gender: 'male', height: 175, created_at: '2026-01-01T00:00:00Z' }],
    queue_entries: [row('b1', { customer_id: 'c1', name: 'Old Name' })] });
  await page.waitForFunction('getQueue().length===1&&(S.customers||[]).length>0');
  const patches = writes(page, 'queue_entries', 'PATCH');
  await page.evaluate(`showEditCustomerModal('c1')`);
  await page.fill('#cf-first', 'New');
  await page.selectOption('#cf-defpay', 'house');
  await page.evaluate(`saveCustForm()`);
  await expect.poll(() => patches.some((p) => /id=eq\.b1/.test(String(p._url)) && p.paid === true && p.price === 0)).toBe(true);
});

test('a saved nationality that is not on the list survives an unrelated save', async ({ page }) => {
  await boot(page, { sessions: [], queue_entries: [],
    customers: [{ id: 'c1', name: 'Amal Member', email: 'a@example.test', phone: '+966500000001', gender: 'female', nationality: 'Egyptian', created_at: '2026-01-01T00:00:00Z' }] });
  await page.waitForFunction('(S.customers||[]).length>0');
  const patches = writes(page, 'customers', 'PATCH');
  await page.evaluate(`showEditCustomerModal('c1')`);
  await expect(page.locator('#cf-nationality')).toHaveValue('Egyptian');
  await page.evaluate(`saveCustForm()`);
  await expect.poll(() => patches.length).toBeGreaterThan(0);
  expect(patches[0].nationality).toBe('Egyptian');
});

// ── smaller desk rules ───────────────────────────────────────────────────────
test('Front Desk does not see cancelled Saturday-ride bookings on All sessions', async ({ page }) => {
  const COMM = '2099-03-07';
  await boot(page, { sessions: [sess(LIVE), sess(COMM, { event_kind: 'community', ride_kind: 'saturday', needs_approval: true })],
    queue_entries: [row('j1', { status: 'cancelled', name: 'Circuit Cancel' }),
      row('s1', { session_id: COMM, session_date: COMM, status: 'cancelled', name: 'Saturday Cancel' })] });
  await page.waitForFunction('getQueue().length===2');
  await page.evaluate(`S.staffRole='frontdesk';setStaffTab('queue');S.queueView='bookings';S.sfSession='all';S.sfStatus='cancelled';renderStaffQueue()`);
  await expect(page.locator('#q-results')).toContainText('Circuit Cancel');
  await expect(page.locator('#q-results')).not.toContainText('Saturday Cancel');
});

test('a party row names the riders who ride on the house', async ({ page }) => {
  await boot(page, { sessions: [sess(LIVE)], queue_entries: [
    row('h1', { group_id: 'gh', paid: true, price: 0 }), row('h2', { queue_num: 2, group_id: 'gh' }),
  ] });
  await page.waitForFunction('getQueue().length===2');
  await page.evaluate(`setStaffTab('queue');S.sfSession=${JSON.stringify(LIVE)};S._partyExpandAll=true;renderStaffQueue()`);
  await expect(page.locator('#q-results')).toContainText(/On the house/); // the row's party line counts them; a card says it on the rider
});

// Which session the desk opens on is the queue's own rule now (_currentSessId, 575fd6c), with
// its own specs (queue-desk-pass, queue-view-memory).

test('the walk-in type goes with its rider, and picking an account keeps the typed riders', async ({ page }) => {
  await boot(page, { sessions: [sess(LIVE)], queue_entries: [],
    customers: [{ id: 'c1', name: 'Tamer Hybrid', phone: '+966500000001', type_preference: 'Hybrid', created_at: '2026-01-01T00:00:00Z' }] });
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`S.sfSession=${JSON.stringify(LIVE)};showWalkinModal();_wiSetType('Road');closeWalkinModal();showWalkinModal()`);
  expect(await page.evaluate('S._wiType')).toBe('Any');

  await page.evaluate(`_wiAddRider()`);
  await page.fill('#wi-r-name-0', 'Sara');
  await page.evaluate(`_wiPickCust('c1')`);
  await expect(page.locator('#wi-r-name-0')).toHaveValue('Sara');
  expect(await page.evaluate('S._wiType')).toBe('Hybrid');
});

test('a Saturday ride takes no group: Add group does not offer it, and a stale pick books nothing', async ({ page }) => {
  // The owner, 2026-10-07: "remove the add group button from saturday and run for her".
  const COMM = '2099-03-07';
  await boot(page, { sessions: [sess(LIVE), sess(COMM, { event_kind: 'community', ride_kind: 'saturday', needs_approval: true, spots: 20 })], queue_entries: [] });
  const bookings = writes(page, 'queue_entries');
  await page.evaluate(`S.sfSession=${JSON.stringify(COMM)};showJccGroupModal()`);
  await expect(page.locator('#jg-sess option')).toHaveCount(1);
  await expect(page.locator(`#jg-sess option[value="${COMM}"]`)).toHaveCount(0);
  await page.fill('#jg-name', 'Falcons');
  await page.evaluate(`(()=>{const s=document.getElementById('jg-sess');const o=document.createElement('option');o.value=${JSON.stringify(COMM)};s.appendChild(o);s.value=${JSON.stringify(COMM)};})()`);
  await page.evaluate(`saveJccGroup()`);
  await page.waitForTimeout(300);
  expect(bookings).toEqual([]);
});

test('Add rider offers an own bike only where the ride takes owners', async ({ page }) => {
  const COMM = '2099-03-07';
  await boot(page, { sessions: [sess(LIVE), sess(COMM, { event_kind: 'community', ride_kind: 'saturday', needs_approval: true, spots: 20 })], queue_entries: [],
    customers: [{ id: 'c1', name: 'Amal Member', created_at: '2026-01-01T00:00:00Z' }] });
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`S.sfSession=${JSON.stringify(COMM)};showCommAddModal()`);
  const own = page.locator('#comm-add-modal input[type="checkbox"]');
  await expect(own).toHaveCount(1);
  await own.check();
  // a circuit night (the one ride without owners) takes no Add rider since 2026-10-07: not even in the list
  await expect(page.locator(`#comm-add-modal select option[value="${LIVE}"]`)).toHaveCount(0);
});
