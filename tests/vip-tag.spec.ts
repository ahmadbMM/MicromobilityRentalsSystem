import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb, type Fixtures } from './helpers/supabase';

// The VIP tag (the owner, 2026-09-29): gold, the letters VIP drawn in white (no crown). Its holder
// always rides on the house, every bike type, in their own name, and never sees Road Carbon in their
// own booking picker. The database enforces both (20260929090000: _apply_default_pay,
// customer_create_booking, customer_profile, _vip_no_carbon); these specs cover the app's side.
// All Supabase traffic is stubbed.

const LIVE = '2099-03-01';
const sessions = [{ id: LIVE, day: 'Sunday', session_date: LIVE, status: 'open', capacity: 20, created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":20}' }];
const tags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#4aa8f8', locked: true, auto_grant: false },
  { id: 'tag_vip', slug: 'vip', name: 'VIP', color: '#a67c00', locked: true, auto_grant: false },
];
const customers = [
  { id: 'v1', name: 'Vera Vip', email: 'vera@example.test', phone: '0500000011', height: 170, default_pay: null, created_at: '2026-01-01T00:00:00Z' },
  { id: 'p1', name: 'Paul Payer', email: 'paul@example.test', phone: '0500000012', height: 180, default_pay: null, created_at: '2026-01-01T00:00:00Z' },
];
const VIP = [{ customer_id: 'v1', tag_id: 'tag_vip', added_by: 'staff', added_at: 1 }];
const row = (id: string, n: number, cid: string, name: string, x: Record<string, unknown> = {}) => ({
  id, session_id: LIVE, session_day: 'Sunday', session_date: LIVE, queue_num: n, name, customer_id: cid, phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2026-09-29T10:00:00Z', ...x,
});

async function boot(page: Page, fx: Fixtures = {}) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], tags, customers, customer_tags: VIP, staff_options: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
}
function patches(page: Page) {
  const out: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'PATCH' || !/\/rest\/v1\/queue_entries\?/.test(r.url())) return;
    try { out.push({ url: decodeURIComponent(r.url()), body: r.postDataJSON() }); } catch { /* not json */ }
  });
  return out;
}

test('the VIP chip is gold and wears the drawn letters, not its name as text', async ({ page }) => {
  await boot(page);
  await page.evaluate(`setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
  const chip = page.locator('#am-cust-rows .am-chip.tag-brand', { has: page.locator('.tag-logo-vip') }).first();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveCSS('background-color', 'rgb(166, 124, 0)'); // #a67c00
  await expect(chip).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(chip).not.toContainText('VIP'); // drawn, as the other brand chips; the name is the title
  await expect(chip).toHaveAttribute('title', 'VIP');
  const box = await chip.locator('.tag-logo-vip').boundingBox();
  expect(box && box.width).toBeGreaterThan(16);
  expect(box && box.width).toBeLessThan(22); // the letters alone, no crown beside them, drawn small (2026-09-30)
});

test('a VIP is on the house on every bike type, in their own name only; nobody else is', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(`['Road','Hybrid','Road Carbon','Any'].map(ty=>_custHouseFor(S.customers.find(c=>c.id==='v1'),ty))`)).toEqual([true, true, true, true]);
  expect(await page.evaluate(`_custHouseFor(S.customers.find(c=>c.id==='p1'),'Road')`)).toBe(false);
  const own = await page.evaluate(`_applyDefaultPay({customerId:'v1',name:'Vera Vip',typePreference:'Road Carbon',paid:false,price:250})`);
  expect(own).toMatchObject({ paid: true, price: 0 });
  const friend = await page.evaluate(`_applyDefaultPay({customerId:'v1',name:'Vera Friend',typePreference:'Road',paid:false,price:75})`);
  expect(friend).toMatchObject({ paid: false, price: 75 });
  expect(await page.evaluate(`_accPay(S.customers.find(c=>c.id==='v1'))`)).toBe('On the house · VIP');
});

test('giving VIP puts the live bookings in their name on the house at once; taking it away puts them back', async ({ page }) => {
  await boot(page, {
    customer_tags: [],
    queue_entries: [row('q1', 1, 'v1', 'Vera Vip'), row('q2', 2, 'v1', 'Vera Friend')],
  });
  const ps = patches(page);
  await page.evaluate(`showTagGrantModal('v1','tag_vip')`);
  await page.evaluate(`saveTagGrant()`);
  await expect.poll(() => ps.length).toBe(1);
  expect(ps[0].url).toContain('id=eq.q1');
  expect(ps[0].body).toEqual({ paid: true, price: 0 });
  expect(await page.evaluate(`_isVip({id:'v1'})`)).toBe(true);

  ps.length = 0;
  await page.evaluate(`toggleCustTag('v1','tag_vip')`);
  await expect.poll(() => ps.length).toBe(1);
  expect(ps[0].url).toContain('id=eq.q1');
  expect(ps[0].body).toEqual({ paid: false, price: 75 });
  expect(await page.evaluate(`_isVip({id:'v1'})`)).toBe(false);
});

test('the account editor says a VIP is on the house whatever its payment settings say', async ({ page }) => {
  await boot(page);
  await page.evaluate(`showEditCustomerModal('v1')`);
  const note = page.locator('#new-acct-modal .cmy-cf-vip');
  await expect(note).toContainText('Always on the house, every bike type');
  await expect(note.locator('.tag-logo-vip')).toHaveCount(1);
  await page.evaluate(`closeCustFormModal()`);
  await page.evaluate(`showEditCustomerModal('p1')`);
  await expect(page.locator('#new-acct-modal .modal-box')).toBeVisible();
  await expect(page.locator('#new-acct-modal .cmy-cf-vip')).toHaveCount(0);
});

// The rider's own app reads no tags: customer_profile tells a VIP 'house' and Road Carbon hidden.
test("a rider's app hides Road Carbon and prices every type at 0 when the profile says VIP", async ({ page }) => {
  await stubSupabase(page, {
    sessions, 'rpc:list_sessions': sessions, queue_entries: [], bikes: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', hidden_types: 'Road Carbon', default_pay: 'house' }],
  });
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`selectEvent('jcc')`);
  await expect.poll(() => page.evaluate(`_regTypeHidden('Road Carbon')`)).toBe(true);
  expect(await page.evaluate(`[_regTypeHidden('Road'),_regHouseFor('Road'),_regHouseFor('Hybrid')]`)).toEqual([false, true, true]);
});

test("a rider who is not VIP keeps Road Carbon (and the tag check runs on the rider's side without the staff code)", async ({ page }) => {
  await stubSupabase(page, {
    sessions, 'rpc:list_sessions': sessions, queue_entries: [], bikes: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', hidden_types: null, default_pay: null }],
  });
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`selectEvent('jcc')`);
  await expect.poll(() => page.evaluate(`S.loggedIn&&S.loggedIn.default_pay`)).toBe(null);
  expect(await page.evaluate(`[_regTypeHidden('Road Carbon'),_regHouseFor('Road')]`)).toEqual([false, false]);
});

test('a refused reprice is said, and the booking is read back as the database holds it', async ({ page }) => {
  await boot(page, { customer_tags: [], queue_entries: [row('q1', 1, 'v1', 'Vera Vip')] });
  await page.route(/\/rest\/v1\/queue_entries\?/, (route) => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'new row violates row-level security policy for table "queue_entries"' }) })
    : route.fallback());
  await page.evaluate(`showTagGrantModal('v1','tag_vip')`);
  await page.evaluate(`saveTagGrant()`);
  await expect(page.locator('#err-bar-el')).toBeVisible();
  // the row went back to what the server still says: not paid, at the Road price
  await expect.poll(() => page.evaluate(`(()=>{const e=S.queue.find(x=>x.id==='q1');return e&&[e.paid,e.price];})()`)).toEqual([false, 75]);
});
