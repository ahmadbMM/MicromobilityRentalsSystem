import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The staff review's second batch, security part (2026-10-28, migration 20261029150000):
// P09 every free-ride door behind the on-the-house approval: the VIP tag (one account or many) through staff_set_vip,
//     a default payment on the house through staff_set_default_pay (admins and managers; others see it disabled), and
//     the walk-up waitlist's Give bike booking Pending at the fare, then staff_set_house;
// P15 the customer password reset only for the roles that change Bookings, said in the desk's words when the server
//     refuses, its line naming the account; Team's Save asks a confirm that says what changes, then the PIN; deposits
//     never offer "ID left" nor ask ID digits; the one-tap gender and a held tag's take-back ask a second tap.
// All Supabase traffic is stubbed; invented data only.

const ksaDay = (n = 0) => new Date(Date.now() + 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10); // UTC+3 arithmetic
const D1 = ksaDay(1);
const sessions = [{ id: 's1', day: 'Friday', session_date: D1, capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' }];
const tags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#4aa8f8', locked: true, auto_grant: false },
  { id: 'tag_vip', slug: 'vip', name: 'VIP', color: '#a67c00', locked: true, auto_grant: false },
  { id: 'tag_lead', slug: 'lead', name: 'Lead', color: '#7a46c2', locked: false, auto_grant: false },
];
const customers = [
  { id: 'v1', name: 'Vera Stone', email: 'vera@example.test', phone: '+966500000011', height: 170, gender: 'female', default_pay: null, created_at: '2026-01-01T00:00:00Z' },
  { id: 'p1', name: 'Paul Payer', email: 'paul@example.test', phone: '+966500000012', height: 180, gender: 'male', default_pay: null, created_at: '2026-01-02T00:00:00Z' },
  { id: 'g1', name: 'Gina Field', email: 'gina@example.test', phone: '+966500000013', height: 165, gender: null, default_pay: null, created_at: '2026-01-03T00:00:00Z' },
];
const bk = (id: string, n: number, cid: string | null, name: string, x: Record<string, unknown> = {}) => ({
  id, session_id: 's1', session_day: 'Friday', session_date: D1, queue_num: n, name, customer_id: cid, phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2026-10-28T10:00:00Z', ...x,
});
const ct = (cid: string, tid: string, x: Record<string, unknown> = {}) => ({ customer_id: cid, tag_id: tid, added_by: 'staff', added_at: 1, ...x });

type Call = { name: string; method: string; url: string; body: unknown };
function watch(page: Page) {
  const calls: Call[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/(?:rpc\/)?([^/?]+)/);
    if (!m || r.method() === 'GET' || r.method() === 'HEAD' || r.method() === 'OPTIONS') return;
    let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
    calls.push({ name: m[1], method: r.method(), url: decodeURIComponent(r.url()), body });
  });
  return calls;
}
const named = (calls: Call[], name: string, method?: string) => calls.filter((c) => c.name === name && (!method || c.method === method));
const row0 = (c: Call) => (Array.isArray(c.body) ? c.body[0] : c.body) as Record<string, unknown>;

async function boot(page: Page, fx: Fixtures = {}, ops: Record<string, unknown>[] = [{ name: 'Spec Staff', has_pin: false }]) {
  await stubSupabase(page, { sessions, tags, customers, customer_tags: [], queue_entries: [], bikes: [], staff_options: [], 'rpc:staff_operator_list': ops, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();`);
}
async function accounts(page: Page) {
  await page.evaluate(`setStaffTab('customers');S.customersTab='accounts';renderCustomers()`);
  await expect(page.locator('#am-cust-rows .am-row[data-cust="v1"]')).toBeVisible();
}

test.describe('@staff:community b2-d the VIP tag through the on-the-house approval (P09)', () => {
  const VIP_ROW = { customer_id: 'v1', tag_id: 'tag_vip', added_by: 'Spec Staff', added_at: 1793280000000, starts_at: null, expires_at: null };

  test('giving VIP calls staff_set_vip with the operator, writes no tag row itself, and puts the live booking on the house', async ({ page }) => {
    await boot(page, { 'rpc:staff_set_vip': { ok: true, amount: 250, rows: [VIP_ROW] }, queue_entries: [bk('q1', 1, 'v1', 'Vera Stone')] });
    const calls = watch(page);
    await page.evaluate(`showTagGrantModal('v1','tag_vip');saveTagGrant()`);
    await expect.poll(() => named(calls, 'staff_set_vip').length).toBe(1);
    expect(named(calls, 'staff_set_vip')[0].body).toEqual({ p_customers: ['v1'], p_on: true, p_starts_at: null, p_expires_at: null, p_op: 'Spec Staff', p_approval: null });
    await expect.poll(() => page.evaluate(`_isVip({id:'v1'})`)).toBe(true);
    await expect.poll(() => named(calls, 'queue_entries', 'PATCH').length).toBe(1);
    expect(named(calls, 'queue_entries', 'PATCH')[0].body).toEqual({ paid: true, price: 0 });
    expect(named(calls, 'customer_tags')).toHaveLength(0);
  });

  test('a VIP for a week sends its window', async ({ page }) => {
    await boot(page, { 'rpc:staff_set_vip': { ok: true, amount: 250, rows: [] } });
    const calls = watch(page);
    await page.evaluate(`showTagGrantModal('v1','tag_vip');S._tg.kind='temp';S._tg.mode='dur';S._tg.dur='1w';saveTagGrant()`);
    await expect.poll(() => named(calls, 'staff_set_vip').length).toBe(1);
    const b = named(calls, 'staff_set_vip')[0].body as Record<string, number>;
    expect(typeof b.p_starts_at).toBe('number');
    expect(b.p_expires_at - b.p_starts_at).toBe(7 * 864e5);
  });

  test('taking VIP back in the picker asks a second tap, then goes through staff_set_vip', async ({ page }) => {
    await boot(page, { customer_tags: [ct('v1', 'tag_vip')], 'rpc:staff_set_vip': { ok: true, ids: ['v1'] } });
    const calls = watch(page);
    await accounts(page);
    await page.evaluate(`_amPickTags('v1')`);
    const chip = page.locator('#am-cust-rows .am-row[data-cust="v1"] .am-picker .am-pick').nth(1); // Community, VIP, Lead
    await chip.click();
    await expect(chip).toHaveClass(/scy-sure/);
    await expect(chip).toContainText('Tap again to remove');
    await page.waitForTimeout(300);
    expect(named(calls, 'staff_set_vip')).toHaveLength(0);
    await chip.click();
    await expect.poll(() => named(calls, 'staff_set_vip').length).toBe(1);
    expect(named(calls, 'staff_set_vip')[0].body).toMatchObject({ p_customers: ['v1'], p_on: false });
    await expect.poll(() => page.evaluate(`_isVip({id:'v1'})`)).toBe(false);
    await expect(page.locator('#am-cust-rows .am-row[data-cust="v1"] .am-picker .am-pick').nth(1)).not.toHaveClass(/scy-sure/);
  });

  test('VIP for many from Act on selection is one call after the second tap', async ({ page }) => {
    await boot(page, { 'rpc:staff_set_vip': { ok: true, amount: 250, rows: [VIP_ROW, { ...VIP_ROW, customer_id: 'p1' }] } });
    const calls = watch(page);
    await page.evaluate(`openSegmentActions(['v1','p1']);_segSet('tag','tag_vip')`);
    await page.evaluate(`_segTag(true)`); // the line saying what a second tap does
    await expect(page.locator('#confirm-modal .seg-sure')).toBeVisible();
    await page.evaluate(`_segTag(true)`);
    await expect.poll(() => named(calls, 'staff_set_vip').length).toBe(1);
    expect(named(calls, 'staff_set_vip')[0].body).toMatchObject({ p_customers: ['v1', 'p1'], p_on: true });
    expect(named(calls, 'customer_tags')).toHaveLength(0);
    await expect.poll(() => page.evaluate(`[_isVip({id:'v1'}),_isVip({id:'p1'})]`)).toEqual([true, true]);
  });

  test('over the manager limit in Settings, giving VIP asks a manager before anything is sent', async ({ page }) => {
    const biz = { key: 'biz', items: { mgr_over: 100, mgr_for: { house: true }, approvers: ['Boss'] } };
    await boot(page, { staff_options: [biz], 'rpc:staff_set_vip': { ok: true, rows: [VIP_ROW] } },
      [{ name: 'Spec Staff', has_pin: false }, { name: 'Boss', has_pin: true }]);
    const calls = watch(page);
    await page.waitForFunction(`_biz('mgr_over',0)===100`);
    await page.evaluate(`showTagGrantModal('v1','tag_vip');void saveTagGrant()`); // it waits on the manager's keypad
    await expect(page.locator('#op-gate-modal')).toContainText('Manager approval: VIP');
    await page.waitForTimeout(300);
    expect(named(calls, 'staff_set_vip')).toHaveLength(0);
  });

  test('a refusal is said and nothing is merged', async ({ page }) => {
    await boot(page, { 'rpc:staff_set_vip': { __rpcError: { status: 403, code: '42501', message: 'PIN_REQUIRED' } } });
    await page.evaluate(`showTagGrantModal('v1','tag_vip');saveTagGrant()`);
    await expect(page.locator('#toast-container .toast.error').last()).toBeVisible();
    expect(await page.evaluate(`_isVip({id:'v1'})`)).toBe(false);
  });
});

test.describe('@staff:community b2-d a held tag and the one-tap gender ask a second tap (P15)', () => {
  test('the first tap on a held tag arms it, another chip moves the arm, the second tap takes it off', async ({ page }) => {
    await boot(page, { customer_tags: [ct('p1', 'tag_lead'), ct('p1', 'tag_saturday')] });
    const calls = watch(page);
    await accounts(page);
    await page.evaluate(`_amPickTags('p1')`);
    const picks = page.locator('#am-cust-rows .am-row[data-cust="p1"] .am-picker .am-pick');
    await picks.nth(2).click(); // Lead
    await expect(picks.nth(2)).toContainText('Tap again to remove');
    await picks.nth(0).click(); // Community: the arm moves there
    await expect(picks.nth(0)).toHaveClass(/scy-sure/);
    await expect(picks.nth(2)).not.toHaveClass(/scy-sure/);
    await page.waitForTimeout(300);
    expect(named(calls, 'customer_tags')).toHaveLength(0);
    await picks.nth(0).click();
    await expect.poll(() => named(calls, 'customer_tags', 'DELETE').length).toBe(1);
    expect(named(calls, 'customer_tags', 'DELETE')[0].url).toMatch(/customer_id=eq\.p1.*tag_id=eq\.tag_saturday|tag_id=eq\.tag_saturday.*customer_id=eq\.p1/);
    expect(await page.evaluate(`_hasTagNow('p1','tag_lead')`)).toBe(true);
  });

  test('an armed tag lapses after four seconds', async ({ page }) => {
    await boot(page, { customer_tags: [ct('p1', 'tag_lead')] });
    await accounts(page);
    await page.evaluate(`_amPickTags('p1')`);
    const lead = page.locator('#am-cust-rows .am-row[data-cust="p1"] .am-picker .am-pick').nth(2);
    await lead.click();
    await expect(lead).toHaveClass(/scy-sure/);
    await page.waitForTimeout(4300);
    await expect(lead).not.toHaveClass(/scy-sure/);
  });

  test('Remove under a tag\'s holders keeps its one question and takes the tag off', async ({ page }) => {
    await boot(page, { customer_tags: [ct('p1', 'tag_lead')] });
    const calls = watch(page);
    await page.evaluate(`setStaffTab('community');S.communityTab='tags';renderCommunity();_tgOpen('tag_lead')`);
    await page.locator('.tg-holders .tg-row').filter({ hasText: 'Paul Payer' }).getByRole('button', { name: 'Remove' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => named(calls, 'customer_tags', 'DELETE').length).toBe(1);
  });

  test('a gender is saved on the second tap only, and only that row is drawn again', async ({ page }) => {
    await boot(page);
    const calls = watch(page);
    await accounts(page);
    const strip = page.locator('#am-cust-rows .am-row[data-cust="g1"] .am-gender');
    await strip.getByRole('button', { name: 'Female', exact: true }).click();
    await expect(strip.locator('.am-pick.scy-sure')).toHaveText('Tap again to save Female');
    await page.waitForTimeout(300);
    expect(named(calls, 'customers', 'PATCH')).toHaveLength(0);
    await page.evaluate(`document.querySelector('#am-cust-rows .am-row[data-cust="v1"]').setAttribute('data-kept','1')`);
    await strip.locator('.am-pick.scy-sure').click();
    await expect.poll(() => named(calls, 'customers', 'PATCH').length).toBe(1);
    expect(named(calls, 'customers', 'PATCH')[0].body).toEqual({ gender: 'female' });
    await expect(page.locator('#am-cust-rows .am-row[data-cust="g1"] .am-gender')).toHaveCount(0);
    await expect(page.locator('#am-cust-rows .am-row[data-cust="v1"]')).toHaveAttribute('data-kept', '1'); // not redrawn
  });

  test('a gender tap left alone lapses after four seconds', async ({ page }) => {
    await boot(page);
    await accounts(page);
    const strip = page.locator('#am-cust-rows .am-row[data-cust="g1"] .am-gender');
    await strip.getByRole('button', { name: 'Male', exact: true }).click();
    await expect(strip.locator('.am-pick.scy-sure')).toHaveCount(1);
    await page.waitForTimeout(4300);
    await expect(strip.locator('.am-pick.scy-sure')).toHaveCount(0);
    await expect(strip.getByRole('button', { name: 'Male', exact: true })).toBeVisible();
  });
});

test.describe('@staff:community b2-d a default payment on the house (P09)', () => {
  const editor = async (page: Page, role: string, cid = 'p1') => {
    await page.evaluate(`setStaffRole('${role}');showEditCustomerModal('${cid}')`);
    await expect(page.locator('#new-acct-modal #cf-defpay')).toBeVisible();
  };
  const custPatch = (calls: Call[]) => named(calls, 'customers', 'PATCH').map(row0);

  test('front desk sees the choice disabled with the reason, and its save sends no default payment', async ({ page }) => {
    await boot(page);
    const calls = watch(page);
    await editor(page, 'frontdesk');
    await expect(page.locator('#cf-defpay')).toBeDisabled();
    await expect(page.locator('#cf-defpay-hint')).toHaveText('Only an admin or a manager changes the default payment.');
    await expect(page.locator('#cf-defpay-types .toggle-btn').first()).toBeDisabled();
    await page.evaluate('saveCustForm()');
    await expect.poll(() => custPatch(calls).length).toBe(1);
    expect(custPatch(calls)[0]).not.toHaveProperty('default_pay');
    expect(named(calls, 'staff_set_default_pay')).toHaveLength(0);
  });

  test('a manager putting an account on the house goes through staff_set_default_pay first, and its live booking follows', async ({ page }) => {
    await boot(page, { 'rpc:staff_set_default_pay': { ok: true, id: 'p1', default_pay: 'house', amount: 250 }, queue_entries: [bk('q1', 1, 'p1', 'Paul Payer')] });
    const calls = watch(page);
    await editor(page, 'manager');
    await page.locator('#cf-defpay').selectOption('house');
    await page.evaluate('saveCustForm()');
    await expect.poll(() => custPatch(calls).length).toBe(1);
    expect(named(calls, 'staff_set_default_pay')[0].body).toEqual({ p_customer_id: 'p1', p_value: 'house', p_op: 'Spec Staff', p_approval: null });
    const order = calls.filter((c) => c.name === 'staff_set_default_pay' || (c.name === 'customers' && c.method === 'PATCH')).map((c) => c.name);
    expect(order).toEqual(['staff_set_default_pay', 'customers']);
    expect(custPatch(calls)[0]).not.toHaveProperty('default_pay');
    await expect.poll(() => named(calls, 'queue_entries', 'PATCH').map((c) => c.body)).toContainEqual({ paid: true, price: 0 });
  });

  test('a save that leaves the default payment as it was asks nothing', async ({ page }) => {
    await boot(page, { 'rpc:staff_set_default_pay': { ok: true } });
    const calls = watch(page);
    await editor(page, 'admin');
    await page.evaluate('saveCustForm()');
    await expect.poll(() => custPatch(calls).length).toBe(1);
    expect(named(calls, 'staff_set_default_pay')).toHaveLength(0);
    expect(custPatch(calls)[0]).not.toHaveProperty('default_pay');
  });

  test('before the database update an admin writes it as before; a manager is told it waits for the update', async ({ page }) => {
    await boot(page);
    const calls = watch(page);
    await editor(page, 'admin');
    await page.locator('#cf-defpay').selectOption('house');
    await page.evaluate('saveCustForm()');
    await expect.poll(() => custPatch(calls).length).toBe(1);
    expect(custPatch(calls)[0]).toMatchObject({ default_pay: 'house' });
    await page.evaluate(`closeCustFormModal&&closeCustFormModal()`);
    calls.length = 0;
    await editor(page, 'manager', 'v1');
    await page.locator('#cf-defpay').selectOption('house');
    await page.evaluate('saveCustForm()');
    await expect(page.locator('#toast-container')).toContainText('Waiting for the database update.');
    await page.waitForTimeout(300);
    expect(custPatch(calls)).toHaveLength(0);
  });
});

test.describe('@staff:bookings b2-d the walk-up waitlist books Pending, then asks staff_set_house (P09)', () => {
  const walkup = (id: string, x: Record<string, unknown> = {}) => ({
    id, name: 'Walk Up', phone: '0511111111', bike_type: 'Road', status: 'waiting', author: null, created_at: '2026-10-28T10:00:00Z', resolved_at: null, ...x,
  });
  const give = async (page: Page, fx: Fixtures) => {
    await boot(page, fx);
    await page.evaluate(`window.showCheckinModal=()=>{};setStaffTab('queue');S.queueView='managed';renderStaffQueue()`);
    const calls = watch(page);
    await page.evaluate(`giveDeskBike('w1')`);
    await expect.poll(() => named(calls, 'queue_entries', 'POST').length).toBe(1);
    return calls;
  };

  test('a row marked on the house is booked Pending at its fare, then put on the house through staff_set_house', async ({ page }) => {
    const calls = await give(page, { desk_waitlist: [walkup('w1', { paid: true, price: 0 })], 'rpc:staff_set_house': { ok: true, amount: 75 } });
    const ins = row0(named(calls, 'queue_entries', 'POST')[0]);
    expect(ins).toMatchObject({ paid: false, price: 75, name: 'Walk Up', session_id: 's1' });
    await expect.poll(() => named(calls, 'staff_set_house').length).toBe(1);
    expect(named(calls, 'staff_set_house')[0].body).toMatchObject({ p_booking_id: ins.id, p_on: true, p_op: 'Spec Staff' });
    const order = calls.filter((c) => ['queue_entries', 'desk_waitlist', 'staff_set_house'].includes(c.name)).map((c) => `${c.name}:${c.method}`);
    expect(order.slice(0, 3)).toEqual(['queue_entries:POST', 'desk_waitlist:PATCH', 'staff_set_house:POST']);
    expect(named(calls, 'queue_entries', 'PATCH').filter((c) => (c.body as Record<string, unknown>).price === 0)).toHaveLength(0);
  });

  test('before the database update the house is the plain write after the insert, as before', async ({ page }) => {
    const calls = await give(page, { desk_waitlist: [walkup('w1', { paid: true, price: 0 })] });
    expect(row0(named(calls, 'queue_entries', 'POST')[0])).toMatchObject({ paid: false, price: 75 });
    await expect.poll(() => named(calls, 'queue_entries', 'PATCH').map((c) => c.body)).toContainEqual({ paid: true, price: 0 });
  });

  test('an account that rides free on its own needs no approval: the booking is free from the insert', async ({ page }) => {
    const calls = await give(page, {
      desk_waitlist: [walkup('w1', { paid: true, price: 0, name: 'Vera Stone', phone: '+966500000011' })],
      customer_tags: [ct('v1', 'tag_vip')], 'rpc:staff_set_house': { ok: true },
    });
    expect(row0(named(calls, 'queue_entries', 'POST')[0])).toMatchObject({ paid: true, price: 0, customer_id: 'v1' });
    await page.waitForTimeout(400);
    expect(named(calls, 'staff_set_house')).toHaveLength(0);
  });

  test('a row paid by card carries its payment onto the booking, no approval asked', async ({ page }) => {
    const calls = await give(page, { desk_waitlist: [walkup('w1', { paid: true, price: 75, pay_method: 'card' })], 'rpc:staff_set_house': { ok: true } });
    expect(row0(named(calls, 'queue_entries', 'POST')[0])).toMatchObject({ paid: true, price: 75 });
    await page.waitForTimeout(400);
    expect(named(calls, 'staff_set_house')).toHaveLength(0);
  });
});

test.describe('@staff:bookings b2-d the customer password reset (P15)', () => {
  const keyBtn = (page: Page) => page.locator('#tab-queue .sf-icon-btn[title="Reset Customer Password"]');
  const roster = async (page: Page, js = '') => {
    await page.evaluate(`${js}setStaffTab('queue');S.queueView='bookings';renderStaffQueue()`);
    await expect(page.locator('#tab-queue .page-title').first()).toBeVisible();
  };

  test('the key is there for an admin, a ride leader and front desk, not for the Owner role or an account that cannot change Bookings', async ({ page }) => {
    await boot(page);
    await roster(page);
    await expect(keyBtn(page)).toHaveCount(1);
    await roster(page, `setStaffRole('leader');`);
    await expect(keyBtn(page)).toHaveCount(1);
    await roster(page, `setStaffRole('owner');S._myEdit=[];`);
    await expect(keyBtn(page)).toHaveCount(0);
    await roster(page, `setStaffRole('frontdesk');S._myEdit=['cashier'];`);
    await expect(keyBtn(page)).toHaveCount(0);
    await page.evaluate(`S.showResetTool=true;renderStaffQueue()`);
    await expect(page.locator('#staff-reset-email')).toHaveCount(0); // the tool itself stays shut too
  });

  test('a refusal for the role is said in the desk\'s words; a reset names the account in the log', async ({ page }) => {
    await boot(page, { customers: [...customers, { id: 'c9', name: 'Lost Key', email: 'lost@example.test', phone: '', created_at: '2026-01-01T00:00:00Z' }],
      'rpc:staff_set_customer_temp_password': { __rpcError: { status: 403, code: '42501', message: 'ROLE_REFUSED' } } });
    await page.route(/\/rest\/v1\/customers\?.*email=ilike/, (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([{ id: 'c9', name: 'Lost Key' }]) }));
    await roster(page);
    await page.evaluate(`S.showResetTool=true;renderStaffQueue()`);
    await page.fill('#staff-reset-email', 'lost@example.test');
    await page.fill('#staff-reset-pw', 'Abcdefg1');
    await page.evaluate('staffResetPassword()');
    await expect(page.locator('#staff-reset-result')).toHaveText('Your role cannot do this. Ask an admin.');
    await page.route(/\/rest\/v1\/rpc\/staff_set_customer_temp_password/, (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: 'true' }));
    const calls = watch(page);
    await page.fill('#staff-reset-pw', 'Abcdefg1');
    await page.evaluate('staffResetPassword()');
    await expect(page.locator('#staff-reset-result')).toContainText('Password reset for Lost Key.');
    await expect.poll(() => named(calls, 'staff_actions', 'POST').map(row0)).toContainEqual(expect.objectContaining({ kind: 'pwd', entity: 'customer', entity_id: 'c9' }));
  });

  test('the account editor offers a new password only to those roles', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffRole('manager');S._myEdit=['customers','community'];showEditCustomerModal('p1')`);
    await expect(page.locator('#new-acct-modal #cf-defpay')).toBeVisible();
    await expect(page.locator('#new-acct-modal #cf-pwd')).toHaveCount(0);
    await page.evaluate(`closeCustFormModal();S._myEdit=null;showEditCustomerModal('p1')`);
    await expect(page.locator('#new-acct-modal #cf-pwd')).toBeVisible();
  });
});

test.describe('@staff:team b2-d a change of access asks a confirm, then the PIN (P15)', () => {
  const ME = '11111111-1111-1111-1111-111111111111';
  const DESK = '22222222-2222-2222-2222-222222222222';
  const team = [
    { user_id: ME, email: 'owner@example.com', role: 'admin', modules_view: null, modules_edit: null, is_me: true },
    { user_id: DESK, email: 'desk@example.com', role: 'frontdesk', modules_view: null, modules_edit: null, is_me: false },
  ];
  const more = [
    { user_id: ME, disabled_at: null, caps: null, display_name: 'Owner', last_sign_in_at: null },
    { user_id: DESK, disabled_at: null, caps: null, display_name: 'Desk', last_sign_in_at: null },
  ];

  test('making an account an admin says so, and nothing is sent before the confirm and the PIN', async ({ page }) => {
    await boot(page, { 'rpc:staff_team_list': team, 'rpc:staff_team_more': more, 'rpc:staff_set_access': true, 'rpc:staff_set_caps': true,
      'rpc:staff_pin_approve': { ok: true, required: true, token: 'tok-1' } }, [{ name: 'Spec Staff', has_pin: true }]);
    await page.evaluate(`_pinOk={name:'',at:0,token:null}`);
    const calls = watch(page);
    await page.evaluate(`setStaffTab('team')`);
    const desk = page.locator(`.tm-acct[data-acct="${DESK}"]`);
    await desk.locator('.tm-role').selectOption('admin');
    await desk.getByRole('button', { name: 'Save' }).click();
    const dlg = page.locator('#confirm-modal');
    await expect(dlg).toContainText('Access for desk@example.com');
    await expect(dlg).toContainText('Role for desk@example.com: Front Desk → Admin');
    await expect(dlg).toContainText('An admin opens and changes every section and can do everything.');
    await page.waitForTimeout(300);
    expect(named(calls, 'staff_set_access')).toHaveLength(0);
    await dlg.getByRole('button', { name: 'Save' }).click();
    const gate = page.locator('#op-gate-modal .op-gate');
    await expect(gate).toBeVisible();
    expect(named(calls, 'staff_set_access')).toHaveLength(0);
    await page.keyboard.type('1234');
    await expect.poll(() => named(calls, 'staff_set_access').length).toBe(1);
    expect(named(calls, 'staff_set_access')[0].body).toMatchObject({ p_user: DESK, p_role: 'admin' });
  });

  test('Cancel at the confirm sends nothing', async ({ page }) => {
    await boot(page, { 'rpc:staff_team_list': team, 'rpc:staff_team_more': more, 'rpc:staff_set_access': true });
    const calls = watch(page);
    await page.evaluate(`setStaffTab('team')`);
    const desk = page.locator(`.tm-acct[data-acct="${DESK}"]`);
    await desk.locator('.tm-chip[data-sec="view:cashier"]').click();
    await desk.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#confirm-modal')).toContainText('Can open: Bookings, Workshop');
    await page.locator('#confirm-modal').getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(300);
    expect(named(calls, 'staff_set_access')).toHaveLength(0);
  });
});

test.describe('@staff:checkin b2-d deposits take no ID (P15)', () => {
  const ENTRY = bk('e1', 7, null, 'Rider Seven', { type_preference: 'Road Carbon', price: 250 });
  const BIZ = [{ key: 'biz', items: { deposits: { 'Road Carbon': 500 } } }];

  test('the check-in offers a card hold or cash, and asks a slip or receipt number, never ID digits', async ({ page }) => {
    await boot(page, { queue_entries: [ENTRY], staff_options: BIZ, deposits: [] });
    await page.evaluate(`S.staffTab='queue';renderStaffQueue();showCheckinModal('e1')`);
    const dep = page.locator('#checkin-modal .ci-dep');
    await expect(dep).toContainText('Deposit: take SAR 500');
    expect(await dep.locator('[data-dep-m]').evaluateAll((bs) => bs.map((b) => b.getAttribute('data-dep-m')))).toEqual(['card_hold', 'cash']);
    await expect(dep).not.toContainText('ID left');
    await expect(page.locator('#ci-dep-ref')).toHaveAttribute('placeholder', 'Card slip or receipt number (no ID numbers)');
  });

  test('a deposit taken as an ID before still reads as one on the return', async ({ page }) => {
    const held = { id: 'd1', booking_id: 'e1', bike_id: null, session_id: 's1', day: D1, customer_name: 'Rider Seven', amount: 500, method: 'id_document', ref: '', taken_at: '2026-10-28T18:00:00Z', taken_by_name: 'Spec Staff', returned_at: null, returned_by_name: null, kept_amount: 0, kept_reason: '' };
    await boot(page, { queue_entries: [{ ...ENTRY, status: 'active', paid: true }], staff_options: BIZ, deposits: [held] });
    await page.evaluate(`_depLoad(true)`);
    await page.waitForFunction(`!!_depHeld('e1')`);
    await page.evaluate(`_execReturn('e1',false)`);
    await expect(page.locator('#return-modal .ret-dep')).toContainText('Deposit held: SAR 500 · ID left');
  });
});

test.describe('@staff:history b2-d tag changes in the audit trail', () => {
  test('a grant and a take-back read with the tag\'s name and open the account', async ({ page }) => {
    await boot(page);
    const lines = await page.evaluate(`[_auLines({tbl:'customer_tags',op:'INSERT',changed:{tag_id:{old:null,new:'tag_vip'},added_by:{old:null,new:'Spec Staff'}}}),
      _auLines({tbl:'customer_tags',op:'DELETE',changed:{customer_id:'v1',tag_id:'tag_vip'}}),
      _auLines({tbl:'customers',op:'UPDATE',changed:{gender:{old:null,new:'female'}}})]`);
    expect(lines).toEqual([['Tags: — → VIP', 'added by: — → Spec Staff'], ['Deleted · VIP'], ['Gender: — → Female']]);
    expect(await page.evaluate(`AU_TABLES.includes('customer_tags')&&_auTblName('customer_tags')`)).toBe('Account tags');
  });
});
