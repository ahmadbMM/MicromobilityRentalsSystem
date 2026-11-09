import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The Store and Payments sections (2026-11-10, migration 20261110150000): what the staff page asks of the database
// (staff_store_*, staff_payments, staff_pay_refund_decline, the tables under RLS) and of the website's server
// (POST /api/pay/refund, which alone holds the gateway's secret key). All traffic stubbed; invented data.

const NOW = '2026-11-10T09:00:00Z';
const pay = (id: string, x: Record<string, unknown> = {}) => ({
  id, kind: 'order', ref: 'o1', amount: 200, currency: 'SAR', description: 'Order MM-1001', status: 'paid', hold: true,
  expires_at: NOW, paid_at: NOW, method: 'creditcard', brand: 'mada', last4: '4242', message: null, refunded: 0, receipt_no: 77, created_at: NOW, ...x,
});
const order = (id: string, no: number, status: string, x: Record<string, unknown> = {}) => ({
  id, no, status, fulfil: 'pickup', name: 'Huda Buyer', phone: '966501112233', email: 'huda@example.test', address: null, note: null,
  staff_note: null, customer_id: 'c1', subtotal: 200, delivery_fee: 0, total: 200, wallet_paid: 0, vat: 26.09, courier: null, tracking_no: null,
  expires_at: null, paid_at: NOW, created_at: NOW, cancel_reason: null, payment_id: 'p-' + id, payment: pay('p-' + id, { ref: id, description: `Order MM-${no}` }),
  items: [{ name: 'Trail helmet', variant: 'M · Black', qty: 1, unit_price: 200, product_id: 'pr1', variant_id: 'v1', image: null, slug: 'trail-helmet' }],
  events: [{ at: NOW, status: 'pending', note: null, by: null, public: true }, { at: NOW, status: 'paid', note: null, by: null, public: true }],
  refunds: [], ...x,
});
const orders = [
  order('o1', 1001, 'paid'),
  order('o2', 1002, 'shipped', { fulfil: 'jeddah', name: 'Sami Sender', phone: '966509998877', courier: 'Aramex', tracking_no: 'TRK1',
    address: { city: 'Jeddah', district: 'Al Rawdah', street: 'Prince Sultan Rd', building: '12', short: 'JRDA1234' } }),
  order('o3', 1003, 'delivered', { name: 'Old Order' }),
];
const customers = [{ id: 'c1', name: 'Huda Buyer', email: 'huda@example.test', phone: '+966501112233', created_at: '2026-01-01T00:00:00Z' }];

function rpcCalls(page: Page) {
  const seen: { name: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (!m || r.method() !== 'POST') return;
    let body = {}; try { body = r.postDataJSON() || {}; } catch { /* none */ }
    seen.push({ name: m[1], body });
  });
  return seen;
}
function writes(page: Page, table: string) {
  const seen: { method: string; body: unknown; url: string }[] = [];
  page.on('request', (r) => {
    if (!r.url().includes(`/rest/v1/${table}`) || !['POST', 'PATCH', 'DELETE'].includes(r.method())) return;
    let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
    seen.push({ method: r.method(), body, url: r.url() });
  });
  return seen;
}
// The website's refund endpoint, answered here; what the page sent is kept.
async function refundEndpoint(page: Page, answer: Record<string, unknown>) {
  const sent: { body: Record<string, unknown>; auth: string }[] = [];
  await page.route('https://micromobility.sa/api/pay/refund', async (route) => {
    const req: Request = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'POST' } });
    sent.push({ body: req.postDataJSON(), auth: req.headers()['authorization'] || '' });
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(answer) });
  });
  return sent;
}
async function staff(page: Page, fx: Fixtures = {}, url = '/?staff') {
  const ops = [{ name: 'Spec Staff', has_pin: false }];
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, staff_options: [], 'rpc:staff_operator_list': ops, ...fx });
  await unlockStaff(page);
  await page.goto(url);
  await waitForSb(page);
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S.staffRole='admin';renderStaffTabs();`);
  // the staff session's token, which the refund endpoint is called with
  await page.evaluate(`sb.auth.getSession=async()=>({data:{session:{access_token:'tok-staff',expires_at:Math.floor(Date.now()/1000)+3600}},error:null})`);
}
const railBtn = (page: Page, k: string) => page.evaluate(`document.querySelector('#staff-tab-nav .tab-btn[data-stab="${k}"]').style.display`);

test.describe('@staff:store the sections only where the database has them', () => {
  test('no staff_store_ready (production): no Store or Payments on the rail, and their address opens nothing', async ({ page }) => {
    await staff(page, {});
    await expect.poll(() => page.evaluate('S._storeReady')).toBe(false);
    expect(await railBtn(page, 'store')).toBe('none');
    expect(await railBtn(page, 'payments')).toBe('none');
    await page.evaluate(`setStaffTab('store')`);
    expect(await page.evaluate('S.staffTab')).not.toBe('store');
    expect(new URL(page.url()).pathname).not.toBe('/store');
  });
  test('the function missing (404, PGRST202) reads as absent too', async ({ page }) => {
    await staff(page, { 'rpc:staff_store_ready': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_store_ready in the schema cache' } } });
    await expect.poll(() => page.evaluate('S._storeReady')).toBe(false);
    expect(await railBtn(page, 'store')).toBe('none');
    expect(await railBtn(page, 'payments')).toBe('none');
  });
  test('ready: both on the rail with the orders to prepare counted, /store opens once the database says yes', async ({ page }) => {
    await staff(page, { 'rpc:staff_store_ready': true, 'rpc:staff_store_orders': orders, store_orders: [{ id: 'o1' }], payment_refunds: [] }, '/store');
    await expect.poll(() => page.evaluate('S._storeReady')).toBe(true);
    expect(await railBtn(page, 'store')).not.toBe('none');
    expect(await railBtn(page, 'payments')).not.toBe('none');
    await expect.poll(() => page.evaluate('S.staffTab')).toBe('store');
    expect(new URL(page.url()).pathname).toBe('/store');
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="store"] .tab-badge')).toHaveText('1');
    // a section list that names Sales names them too, and the Team page sends them only without it
    expect(await page.evaluate(`JSON.stringify(_modIds(['cashier']))`)).toBe('["cashier","store","payments"]');
    expect(await page.evaluate(`JSON.stringify(_modSend(['cashier','store','payments']))`)).toBe('["cashier"]');
  });
});

test.describe('@staff:store orders', () => {
  test('the list (open first, search by number, name or phone), Preparing, then Shipped with the courier and tracking number', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { 'rpc:staff_store_ready': true, 'rpc:staff_store_orders': orders,
      'rpc:staff_store_order_set': { ...orders[0], status: 'preparing', events: [...orders[0].events, { at: NOW, status: 'preparing', note: null, by: 'Spec Staff', public: true }] } });
    await page.evaluate(`setStaffTab('store')`);
    const sec = page.locator('#tab-store');
    await expect(sec.locator('.sto-row')).toHaveCount(2); // Open: to prepare and shipped; the delivered one is not open
    await expect(sec.locator('.sto-row').first()).toContainText('MM-1001'); // to prepare comes first
    await expect(sec.locator('.sto-row').first()).toContainText('To prepare');
    await sec.locator('.filter-pill', { hasText: 'All' }).click();
    await expect(sec.locator('.sto-row')).toHaveCount(3);
    await sec.locator('#sto-q').fill('0509998877');
    await expect(sec.locator('.sto-row')).toHaveCount(1);
    await expect(sec.locator('.sto-row')).toContainText('Sami Sender');
    await sec.locator('#sto-q').fill('1003');
    await expect(sec.locator('.sto-row')).toHaveCount(1);
    await sec.locator('#sto-q').fill('');
    await sec.locator('.sto-row', { hasText: 'MM-1001' }).click();
    const sh = page.locator('#sto-modal [role="dialog"]');
    await expect(sh).toContainText('Order MM-1001');
    await expect(sh).toContainText('Trail helmet');
    await expect(sh).toContainText('mada •••• 4242');
    await expect(sh).toContainText('Pickup at the showroom');
    await sh.locator('button', { hasText: 'Preparing' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_order_set').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_order_set')!.body).toMatchObject({ p_order: 'o1', p_status: 'preparing' });
    await expect(sh.locator('.sto-sh-top .sto-pill')).toHaveText('Preparing');
    // a delivery order: Shipped asks the courier first
    await page.evaluate(`_stoClose();_sto().f='all';renderStore()`);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1002' }).click();
    await expect(sh).toContainText('National short address');
    await expect(sh).toContainText('JRDA1234');
    await expect(sh.locator('button', { hasText: 'Delivered' })).toBeVisible();
  });

  test('cancel with a reason and the PIN, then the refund owed goes through the website to the card', async ({ page }) => {
    const seen = rpcCalls(page);
    const due = { id: 'rf1', amount: 200, dest: null, status: 'due', at: NOW };
    await staff(page, { 'rpc:staff_store_ready': true, 'rpc:staff_store_orders': [orders[0]],
      'rpc:staff_store_order_cancel': { ...orders[0], status: 'cancelled', cancel_reason: 'staff', refunds: [due] } });
    const sent = await refundEndpoint(page, { ok: true, id: 'rf1', status: 'pending', dest: 'card', amount: 200 });
    await page.evaluate(`setStaffTab('store')`);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1001' }).click();
    const sh = page.locator('#sto-modal [role="dialog"]');
    await sh.locator('button', { hasText: 'Cancel order…' }).click();
    await sh.locator('button', { hasText: /^Cancel order$/ }).click(); // no reason yet: said in the sheet, nothing sent
    await expect(sh.locator('.sto-err')).toContainText('Write why');
    expect(seen.filter((c) => c.name === 'staff_store_order_cancel')).toHaveLength(0);
    await sh.locator('#sto-why').fill('Out of stock at the supplier');
    await sh.locator('button', { hasText: /^Cancel order$/ }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_order_cancel').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_order_cancel')!.body).toMatchObject({ p_order: 'o1', p_reason: 'Out of stock at the supplier', p_op: 'Spec Staff' });
    await expect(sh.locator('.sto-due')).toContainText('Refund owed');
    await sh.locator('button', { hasText: 'Refund…' }).click();
    const rf = page.locator('#pay-rf [role="dialog"]');
    await expect(rf).toContainText('Refund MM-1001');
    await expect(rf.locator('#pay-rf-amt')).toHaveValue('200');
    await rf.locator('#pay-rf-why').fill('Order cancelled');
    await rf.locator('#pay-rf-go').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].auth).toBe('Bearer tok-staff');
    expect(sent[0].body).toMatchObject({ refund: 'rf1', amount: 200, dest: 'card', reason: 'Order cancelled', op: 'Spec Staff' });
    expect(sent[0].body).not.toHaveProperty('payment');
    await expect(page.locator('#pay-rf [role="dialog"]')).toHaveCount(0);
  });

  test('a refusal from the website is said in the dialog, not swallowed', async ({ page }) => {
    await staff(page, { 'rpc:staff_store_ready': true, 'rpc:staff_store_orders': [orders[0]] });
    await refundEndpoint(page, { ok: false, error: 'PAY_TOO_MUCH' });
    await page.evaluate(`setStaffTab('store')`);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1001' }).click();
    await page.locator('#sto-modal button', { hasText: 'Refund…' }).click();
    const rf = page.locator('#pay-rf [role="dialog"]');
    await rf.locator('#pay-rf-amt').fill('150');
    await rf.locator('#pay-rf-why').fill('Partial');
    await rf.locator('button', { hasText: 'To the wallet' }).click();
    await rf.locator('#pay-rf-go').click();
    await expect(rf.locator('.sto-err')).toContainText('more than is left');
  });
});

test.describe('@staff:store products', () => {
  test('a new product with a variant is saved to its tables; a variant\'s stock moves by a delta', async ({ page }) => {
    const prods = writes(page, 'store_products'), vars = writes(page, 'store_variants');
    const seen = rpcCalls(page);
    const existing = { id: 'pr9', slug: 'old-bottle', category: 'accessories', brand: 'MM', name_en: 'Old bottle', name_ar: null, tagline_en: null, tagline_ar: null,
      description_en: null, description_ar: null, specs: [], images: [], price: 30, compare_at: null, ship_ksa: true, published: true, sort: 0 };
    await staff(page, { 'rpc:staff_store_ready': true, store_products: [existing],
      store_variants: [{ id: 'v9', product_id: 'pr9', sku: 'OB-1', size: null, color_en: 'Blue', color_ar: null, color_hex: '#1155cc', price: null, stock: 4, active: true, sort: 0 }],
      'rpc:staff_store_stock': { id: 'v9', stock: 7 } });
    await page.evaluate(`S.stoView='products';setStaffTab('store')`);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/store/products');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('.sto-prod')).toHaveCount(1);
    await expect(sec.locator('.sto-prod')).toContainText('4 in stock');
    await sec.locator('button', { hasText: 'New product' }).click();
    const pe = page.locator('#sto-pe [role="dialog"]');
    await pe.locator('#sto-pe-name_en').fill('Trail Helmet');
    await expect(pe.locator('#sto-pe-slug')).toHaveValue('trail-helmet');
    await pe.locator('#sto-pe-name_ar').fill('خوذة');
    await pe.locator('#sto-pe-price').fill('250');
    await pe.locator('#sto-pe-compare_at').fill('200'); // not above the price: refused
    await pe.locator('button', { hasText: 'Add a specification' }).click();
    await pe.locator('.sto-spec input').nth(0).fill('Weight');
    await pe.locator('.sto-spec input').nth(1).fill('280 g');
    await pe.locator('button', { hasText: 'Add a variant' }).click();
    await pe.locator('.sto-var input').nth(0).fill('TH-M');
    await pe.locator('.sto-var input').nth(1).fill('M');
    await pe.locator('.sto-var input[type=number]').nth(1).fill('5');
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect(pe.locator('.sto-err')).toContainText('was price must be higher');
    expect(prods).toHaveLength(0);
    await pe.locator('#sto-pe-compare_at').fill('');
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => prods.length).toBe(1);
    expect(prods[0].method).toBe('POST');
    expect(prods[0].body).toMatchObject({ slug: 'trail-helmet', name_en: 'Trail Helmet', name_ar: 'خوذة', price: 250, compare_at: null, published: false,
      specs: [{ en: ['Weight', '280 g'], ar: ['Weight', '280 g'] }] });
    await expect.poll(() => vars.length).toBe(1);
    const v = (vars[0].body as Record<string, unknown>[])[0];
    expect(v).toMatchObject({ sku: 'TH-M', size: 'M', stock: 5, active: true, product_id: (prods[0].body as { id: string }).id });
    await expect(page.locator('#sto-pe [role="dialog"]')).toHaveCount(0);
    // the existing one: stock +3 through staff_store_stock
    await sec.locator('.sto-prod', { hasText: 'Old bottle' }).click();
    await pe.locator('input[aria-label="Variant 1, stock to add or take away"]').fill('3');
    await pe.locator('button', { hasText: 'Change stock' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_stock').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_stock')!.body).toEqual({ p_variant: 'v9', p_delta: 3 });
    await expect(pe).toContainText('7 in stock');
  });
});

test.describe('@staff:payments payments, refunds owed, settings', () => {
  const pays = [
    { ...pay('pa1', { kind: 'booking', ref: 'q1', refs: ['q1'], description: 'Tuesday ride · 2026-11-11', brand: 'visa', last4: '1111' }), customer_id: 'c1', customer: 'Huda Buyer', refunds: [] },
    { ...pay('pa2', { kind: 'order', ref: 'o1', description: 'Order MM-1001', status: 'partly_refunded', refunded: 50 }), customer_id: null, customer: null,
      refunds: [{ id: 'rx', amount: 50, dest: 'card', status: 'done', reason: 'damaged', by: 'Spec Staff', at: NOW, booking_id: null, order_id: 'o1', error: null }] },
  ];
  const owed = [
    { id: 'rd1', payment_id: 'pa1', provider_id: 'mp_1', amount: 60, dest: null, status: 'due', reason: 'booking cancelled', booking_id: 'q1', order_id: null, by_name: null, error: null, created_at: NOW, done_at: null },
    { id: 'rd2', payment_id: 'pa3', provider_id: 'mp_3', amount: 10, dest: 'card', status: 'failed', reason: 'locker 5f1', booking_id: null, order_id: null, by_name: 'system', error: 'gateway timeout', created_at: NOW, done_at: null },
  ];
  test('every online payment with its figures; the refunds owed decided to the wallet or declined', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { 'rpc:staff_store_ready': true, 'rpc:staff_payments': pays, payment_refunds: owed,
      payments: [{ id: 'pa1', kind: 'booking', customer_id: 'c1', amount: 60, refunded: 0, status: 'paid', method: 'creditcard', brand: 'visa', last4: '1111', description: 'Tuesday ride' },
        { id: 'pa3', kind: 'locker', customer_id: 'c1', amount: 10, refunded: 0, status: 'paid', method: 'applepay', brand: 'visa', last4: '2222', description: 'Locker 5 · 2026-11-10' }],
      store_orders: [], 'rpc:staff_pay_refund_decline': { id: 'rd2', status: 'declined' } });
    const sent = await refundEndpoint(page, { ok: true, id: 'rd1', status: 'done', dest: 'wallet', amount: 60 });
    await page.evaluate(`setStaffTab('payments')`);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/payments');
    const sec = page.locator('#tab-payments');
    await expect(sec.locator('.pay-row')).toHaveCount(2);
    await expect(sec.locator('.pay-figs')).toContainText('SAR 400'); // taken
    await expect(sec.locator('.pay-row', { hasText: 'Tuesday ride' })).toContainText('Visa •••• 1111');
    await expect(sec.locator('.pay-row', { hasText: 'Order MM-1001' })).toContainText('Partly refunded');
    expect(seen.find((c) => c.name === 'staff_payments')!.body).toHaveProperty('p_from');
    // the refunds owed
    await sec.locator('.filter-pill', { hasText: 'Refunds owed' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/payments/refunds');
    await expect(sec.locator('.pay-row')).toHaveCount(2);
    await expect(sec.locator('.pay-row', { hasText: 'Locker' })).toContainText('gateway timeout');
    await sec.locator('.pay-row').first().locator('button', { hasText: 'To the wallet' }).click();
    const rf = page.locator('#pay-rf [role="dialog"]');
    await expect(rf.locator('button[aria-pressed="true"]')).toHaveText('To the wallet');
    await rf.locator('#pay-rf-why').fill('Cancelled two days ahead');
    await rf.locator('#pay-rf-go').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].body).toMatchObject({ refund: 'rd1', amount: 60, dest: 'wallet', reason: 'Cancelled two days ahead' });
    // decline the failed one, with a reason
    await sec.locator('.pay-row', { hasText: 'Locker' }).locator('button', { hasText: 'Decline' }).click();
    await page.locator('#pay-rf-why').fill('Locker was used');
    await page.locator('#pay-rf-go').click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_pay_refund_decline').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_pay_refund_decline')!.body).toEqual({ p_refund: 'rd2', p_reason: 'Locker was used' });
  });

  test('Settings writes the pay.* and store.* keys as the Website editor does', async ({ page }) => {
    const sc = writes(page, 'site_content');
    await staff(page, { 'rpc:staff_store_ready': true, site_content: [
      { key: 'pay.enabled', value: false, updated_at: NOW }, { key: 'pay.holdMinutes', value: 15, updated_at: NOW },
      { key: 'store.delivery', value: { pickup: { on: true, fee: 0 }, jeddah: { on: true, fee: 30, days: '1-2' }, ksa: { on: true, fee: 45, days: '4-7' }, freeOver: 500 }, updated_at: NOW },
    ] });
    await page.evaluate(`S.payView='settings';setStaffTab('payments')`);
    await expect.poll(() => new URL(page.url()).pathname).toBe('/payments/settings');
    const sec = page.locator('#tab-payments');
    await expect(sec.locator('#ps-hold')).toHaveValue('15');
    await expect(sec.locator('.pay-set-warn')).toContainText('SAMA');
    await sec.locator('#ps-en').check();
    await sec.locator('#ps-hold').fill('90'); // out of range: refused before anything is sent
    await sec.locator('#ps-save').click();
    await expect(page.locator('#toast-container')).toContainText('from 5 to 60');
    expect(sc).toHaveLength(0);
    await sec.locator('#ps-hold').fill('20');
    await sec.locator('#ps-jfee').fill('35');
    await sec.locator('#ps-lic').fill('DL-778899');
    await sec.locator('#ps-save').click();
    await expect.poll(() => sc.length).toBeGreaterThan(0);
    const rows = sc[0].body as { key: string; value: unknown }[];
    const by = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(by['pay.enabled']).toBe(true);
    expect(by['pay.holdMinutes']).toBe(20);
    expect(by['store.discountLicence']).toBe('DL-778899');
    expect((by['store.delivery'] as { jeddah: { fee: number } }).jeddah.fee).toBe(35);
  });
});

test.describe('@staff:bookings a booking paid online, a place held while paying', () => {
  const TODAY = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
  const sessions = [{ id: 's1', day: 'Tuesday', session_date: TODAY, capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' }];
  const bk = (id: string, n: number, x: Record<string, unknown>) => ({ id, session_id: 's1', session_day: 'Tuesday', session_date: TODAY, queue_num: n, name: 'Rider ' + n,
    customer_id: null, phone: '', email: '', type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 50, registered_at: NOW, ...x });
  const queue = [
    bk('q1', 1, { paid: true, pay_method: 'online', card_amount: 50, payment_id: 'pb1' }),
    bk('q2', 2, { pay_hold_until: new Date(Date.now() + 10 * 60e3).toISOString(), payment_id: 'pb2' }),
    bk('q3', 3, { paid: true, pay_method: 'card' }),
  ];
  test('reads Paid online with the card, offers Refund only, and never marks it unpaid; the held one reads Paying now', async ({ page }) => {
    const qw = writes(page, 'queue_entries');
    await staff(page, { sessions, queue_entries: queue, payments: [{ id: 'pb1', method: 'creditcard', brand: 'visa', last4: '1111' }] });
    await page.evaluate(`setStaffTab('queue',{sid:'s1'})`);
    const row = (n: string) => page.locator('.queue-table tbody tr, .q-card').filter({ hasText: n }).first();
    await expect(row('Rider 1').locator('.pay-toggle')).toContainText('Paid online');
    await expect(row('Rider 2').locator('.pay-toggle')).toContainText('Paying now');
    await expect(row('Rider 3').locator('.pay-toggle')).toContainText('Paid');
    await row('Rider 1').locator('.pay-toggle').click();
    const menu = page.locator('.pay-menu-popup');
    await expect(menu).toContainText('Paid online');
    await expect(menu).toContainText('Visa •••• 1111');
    await expect(menu.locator('.pay-menu-opt')).toHaveCount(1);
    await expect(menu.locator('.pay-menu-opt')).toContainText('Refund');
    await page.keyboard.press('Escape');
    await page.evaluate(`document.querySelectorAll('.pay-menu-popup').forEach(m=>m.remove());togglePayment('q1','pending')`);
    await expect(page.locator('#toast-container')).toContainText('Refund it from Payments');
    expect(qw).toHaveLength(0);
    // a refusal from the database is said in its words too
    expect(await page.evaluate(`_errMessage({message:'PAID_ONLINE',code:'P0001'})`)).toContain('Paid online');
    // the money: its own channel, never card or cash
    expect(await page.evaluate(`JSON.stringify(_mnySplit(_qGet('q1')))`)).toBe(JSON.stringify({ card: 0, cash: 0, unknown: 0, wallet: 0, online: 50 }));
    expect(await page.evaluate(`_mnySum([_qGet('q1'),_qGet('q3')]).online`)).toBe(50);
    expect(await page.evaluate(`_mnySum([_qGet('q1'),_qGet('q3')]).card`)).toBe(50);
  });
  test('a locker paid by card reads Paid online once its receipt is set, else Awaiting card payment', async ({ page }) => {
    await staff(page, { sessions });
    expect(await page.evaluate(`_lkPayTxt({pay:'card',receipt_id:'pay-1'})`)).toBe('Paid online');
    expect(await page.evaluate(`_lkPayTxt({pay:'card',receipt_id:null})`)).toBe('Awaiting card payment');
  });
});
