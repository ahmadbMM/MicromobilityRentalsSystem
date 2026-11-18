import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The store build's staff side (2026-11-15, migration 20261115235500, staging only): the Store's new views (returns,
// back-in-stock requests, reviews, promo codes, gift cards, low stock), the product editor's new parts (photo order and
// descriptions, colours, key specs, the box, fit, FAQ, sizes, relations, condition and warranty, sale dates, Duplicate,
// bulk prices), the order sheet's out for delivery, SMSA label, gift slip and returns, and Payments > Settings' new keys.
// All traffic stubbed (the new functions as CONTRACTS.md names them); invented data only.

const NOW = '2026-11-15T09:00:00Z';
const pay = (id: string, x: Record<string, unknown> = {}) => ({
  id, kind: 'order', ref: 'o1', amount: 200, currency: 'SAR', description: 'Order MM-1001', status: 'paid', hold: true,
  expires_at: NOW, paid_at: NOW, method: 'creditcard', brand: 'mada', last4: '4242', message: null, refunded: 0, receipt_no: 77, created_at: NOW, ...x,
});
const order = (id: string, no: number, status: string, x: Record<string, unknown> = {}) => ({
  id, no, status, fulfil: 'pickup', name: 'Huda Buyer', phone: '966501112233', email: null, address: null, note: null,
  staff_note: null, customer_id: 'c1', subtotal: 200, delivery_fee: 0, total: 200, wallet_paid: 0, vat: 26.09, courier: null, tracking_no: null,
  expires_at: null, paid_at: NOW, created_at: NOW, cancel_reason: null, payment_id: 'p-' + id, payment: pay('p-' + id, { ref: id, description: `Order MM-${no}` }),
  items: [{ id: 11, name: 'Trail helmet', variant: 'M · Black', qty: 1, unit_price: 200, product_id: 'pr1', variant_id: 'v1', image: null, slug: 'trail-helmet', gift_card: false, reviewed: false }],
  events: [{ at: NOW, status: 'paid', note: null, by: null, public: true }], refunds: [],
  discount: 0, discounts: [], promo_code: null, gift_paid: 0, gift: false, gift_note: null, slot: null, delivered_at: null, returns: [], gift_cards: [], ...x,
});
const prod = (id: string, x: Record<string, unknown> = {}) => ({
  id, slug: id + '-slug', category: 'accessories', brand: 'MM', name_en: 'Product ' + id, name_ar: null, tagline_en: null, tagline_ar: null,
  description_en: null, description_ar: null, specs: [], images: [], price: 100, compare_at: null, ship_ksa: true, published: true, sort: 0,
  kind: 'item', condition: 'new', warranty_months: null, key_specs: [], box: [], fit: null, faq: [], sizes: [], image_meta: {}, goes_with: [], compare_with: [],
  bundle: null, sale_from: null, sale_to: null, catalog_model: null, ...x,
});
const vari = (id: string, pid: string, x: Record<string, unknown> = {}) => ({ id, product_id: pid, sku: null, size: null, color_en: null, color_ar: null, color_hex: null, price: null, stock: 10, active: true, sort: 0, ...x });
const customers = [{ id: 'c1', name: 'Huda Buyer', email: null, phone: '+966501112233', created_at: '2026-01-01T00:00:00Z' }];
const LIC = { key: 'store.discountLicence', value: 'DL-778899', updated_at: NOW };

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
// The website's SMSA label endpoint (staff JWT, as /api/pay/refund), answered here; what the page sent is kept.
async function smsaEndpoint(page: Page, answer: Record<string, unknown>) {
  const sent: { body: Record<string, unknown>; auth: string }[] = [];
  await page.route('https://micromobility.sa/api/store/smsa-label', async (route) => {
    const req: Request = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'POST' } });
    sent.push({ body: req.postDataJSON(), auth: req.headers()['authorization'] || '' });
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(answer) });
  });
  return sent;
}
async function staff(page: Page, fx: Fixtures = {}, url = '/?staff') {
  const ops = [{ name: 'Spec Staff', has_pin: false }];
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, staff_options: [], 'rpc:staff_operator_list': ops, 'rpc:staff_store_ready': true, ...fx });
  await unlockStaff(page);
  await page.goto(url);
  await waitForSb(page);
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S.staffRole='admin';renderStaffTabs();`);
  await page.evaluate(`sb.auth.getSession=async()=>({data:{session:{access_token:'tok-staff',expires_at:Math.floor(Date.now()/1000)+3600}},error:null})`);
}
const view = (page: Page, v: string) => page.evaluate(`S.stoView='${v}';setStaffTab('store')`);

test.describe('@staff:store the order sheet: out for delivery, the SMSA label, a gift order, discounts and returns', () => {
  test('a Jeddah order goes out for delivery, then delivered; SMSA is offered only while store.smsa.on', async ({ page }) => {
    const seen = rpcCalls(page);
    const o = order('o2', 1002, 'preparing', { fulfil: 'jeddah', address: { city: 'Jeddah', district: 'Al Rawdah', street: 'Prince Sultan Rd', building: '12' },
      slot: { day: '2026-11-17', time: 'am' }, subtotal: 300, discount: 30, discounts: [{ kind: 'promo', ref: 'EID10', amount: 30 }], total: 270, gift_paid: 50, wallet_paid: 20 });
    await staff(page, { 'rpc:staff_store_orders': [o], 'rpc:staff_store_order_set': { ...o, status: 'out' },
      site_content: [{ key: 'store.slots', value: { on: true, ahead: 6, lead: 1, skip: [5], times: [{ id: 'am', from: '09:00', to: '13:00' }] }, updated_at: NOW }] });
    await page.evaluate(`setStaffTab('store')`);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1002' }).click();
    const sh = page.locator('#sto-modal [role="dialog"]');
    await expect(sh).toContainText('Code EID10');
    await expect(sh).toContainText('From a gift card');
    await expect(sh).toContainText('By card');
    await expect(sh.locator('.sto-kv', { hasText: 'By card' })).toContainText('SAR 200'); // 270 less 50 on the gift card and 20 from the wallet
    await expect(sh).toContainText('09:00–13:00');
    await expect(sh.locator('button', { hasText: 'Create SMSA label' })).toHaveCount(0);
    await sh.locator('button', { hasText: 'Out for delivery' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_order_set').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_order_set')!.body).toMatchObject({ p_order: 'o2', p_status: 'out', p_courier: null });
    await expect(sh.locator('.sto-sh-top .sto-pill')).toHaveText('Out for delivery');
    await expect(sh.locator('button', { hasText: 'Delivered' })).toBeVisible();
    await expect(sh.locator('button', { hasText: 'Out for delivery' })).toHaveCount(0);
  });

  test('a slot that kept its own hours shows them, not the hours the time has in the settings now', async ({ page }) => {
    const o = order('o9', 1009, 'paid', { fulfil: 'jeddah', address: { city: 'Jeddah', district: 'Al Rawdah', street: 'Prince Sultan Rd' },
      slot: { day: '2026-11-17', time: 'am', from: '10:00', to: '14:00' } });
    await staff(page, { 'rpc:staff_store_orders': [o],
      site_content: [{ key: 'store.slots', value: { on: true, ahead: 6, lead: 1, skip: [5], times: [{ id: 'am', from: '09:00', to: '13:00' }] }, updated_at: NOW }] });
    await page.evaluate(`setStaffTab('store')`);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1009' }).click();
    const sh = page.locator('#sto-modal [role="dialog"]');
    await expect(sh).toContainText('10:00–14:00');
    await expect(sh).not.toContainText('09:00–13:00');
  });

  test('Create SMSA label posts the order with the staff token, saves the PDF and marks it shipped', async ({ page }) => {
    const o = order('o3', 1003, 'paid', { fulfil: 'ksa', address: { city: 'Riyadh', district: 'Olaya', street: 'King Fahd Rd', building: '7' } });
    await staff(page, { 'rpc:staff_store_orders': [o], site_content: [{ key: 'store.smsa.on', value: true, updated_at: NOW }] });
    const sent = await smsaEndpoint(page, { ok: true, awb: '290012345678', label: Buffer.from('%PDF-1.4 label').toString('base64') });
    await page.evaluate(`setStaffTab('store')`);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1003' }).click();
    const sh = page.locator('#sto-modal [role="dialog"]');
    // the order as the server answers it once the label marked it shipped
    await page.route(/\/rest\/v1\/rpc\/staff_store_orders/, (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify([{ ...o, status: 'shipped', courier: 'SMSA', tracking_no: '290012345678' }]) }));
    const dl = page.waitForEvent('download');
    await sh.locator('button', { hasText: 'Create SMSA label' }).click();
    expect((await dl).suggestedFilename()).toBe('SMSA-290012345678.pdf');
    expect(sent[0].auth).toBe('Bearer tok-staff');
    expect(sent[0].body).toEqual({ order: 'o3' });
    await expect(sh.locator('.sto-sh-top .sto-pill')).toHaveText('Shipped');
    await expect(sh).toContainText('290012345678');
  });

  test('SMSA not set up on the server is said inside the sheet', async ({ page }) => {
    const o = order('o3', 1003, 'preparing', { fulfil: 'ksa', address: { city: 'Riyadh', district: 'Olaya', street: 'King Fahd Rd', building: '7' } });
    await staff(page, { 'rpc:staff_store_orders': [o], site_content: [{ key: 'store.smsa.on', value: true, updated_at: NOW }] });
    await smsaEndpoint(page, { ok: false, error: 'smsa_off' });
    await page.evaluate(`setStaffTab('store')`);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1003' }).click();
    const sh = page.locator('#sto-modal [role="dialog"]');
    await sh.locator('button', { hasText: 'Create SMSA label' }).click();
    await expect(sh.locator('.sto-err')).toContainText('SMSA labels are not set up yet');
  });

  // The website's route (w5) makes labels for Kingdom orders only and answers saved:false when SMSA made the waybill but
  // the order could not be marked shipped: staff then save it from the ship form, filled with SMSA and the waybill.
  test('SMSA is offered on Kingdom orders only; a label the route could not save opens the ship form with its waybill', async ({ page }) => {
    const seen = rpcCalls(page);
    const j = order('o4', 1004, 'paid', { fulfil: 'jeddah', address: { city: 'Jeddah', district: 'Al Rawdah', street: 'Prince Sultan Rd', building: '12' } });
    const k = order('o5', 1005, 'preparing', { fulfil: 'ksa', address: { city: 'Riyadh', district: 'Olaya', street: 'King Fahd Rd', building: '7' } });
    await staff(page, { 'rpc:staff_store_orders': [j, k], 'rpc:staff_store_order_set': { ...k, status: 'shipped', courier: 'SMSA', tracking_no: '290055500011' },
      site_content: [{ key: 'store.smsa.on', value: true, updated_at: NOW }] });
    const sent = await smsaEndpoint(page, { ok: true, awb: '290055500011', label: Buffer.from('%PDF-1.4 label').toString('base64'), saved: false });
    await page.evaluate(`setStaffTab('store')`);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1004' }).click();
    const sh = page.locator('#sto-modal [role="dialog"]');
    await expect(sh.locator('button', { hasText: 'Shipped…' })).toBeVisible(); // the courier's way is offered, the label is not
    await expect(sh.locator('button', { hasText: 'Create SMSA label' })).toHaveCount(0);
    await page.evaluate('_stoClose()');
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1005' }).click();
    const dl = page.waitForEvent('download');
    await sh.locator('button', { hasText: 'Create SMSA label' }).click();
    expect((await dl).suggestedFilename()).toBe('SMSA-290055500011.pdf');
    expect(sent[0].body).toEqual({ order: 'o5' });
    await expect(sh.locator('.sto-err')).toContainText('the order was not marked shipped');
    await expect(sh.locator('#sto-courier')).toHaveValue('SMSA');
    await expect(sh.locator('#sto-track')).toHaveValue('290055500011');
    await expect(sh.locator('.sto-sh-top .sto-pill')).toHaveText('Preparing');
    expect(seen.filter((c) => c.name === 'staff_store_order_set')).toHaveLength(0);
    await sh.locator('button', { hasText: 'Mark shipped' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_order_set').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_order_set')!.body).toMatchObject({ p_order: 'o5', p_status: 'shipped', p_courier: 'SMSA', p_tracking: '290055500011' });
    await expect(sh.locator('.sto-sh-top .sto-pill')).toHaveText('Shipped');
  });

  test('an order SMSA refuses as moved on is said and read again', async ({ page }) => {
    const seen = rpcCalls(page);
    const o = order('o6', 1006, 'paid', { fulfil: 'ksa', address: { city: 'Riyadh', district: 'Olaya', street: 'King Fahd Rd', building: '7' } });
    await staff(page, { 'rpc:staff_store_orders': [o], site_content: [{ key: 'store.smsa.on', value: true, updated_at: NOW }] });
    await smsaEndpoint(page, { ok: false, error: 'state' });
    await page.evaluate(`setStaffTab('store')`);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1006' }).click();
    const sh = page.locator('#sto-modal [role="dialog"]');
    const before = seen.filter((c) => c.name === 'staff_store_orders').length;
    await sh.locator('button', { hasText: 'Create SMSA label' }).click();
    await expect(sh.locator('.sto-err')).toContainText('This order has moved on meanwhile');
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_orders').length).toBeGreaterThan(before);
  });

  test('a gift order shows its note and prints a slip without prices; a return request is decided from the sheet', async ({ page }) => {
    const seen = rpcCalls(page);
    const ret = { id: 'rt1', kind: 'return', status: 'open', items: [{ item_id: 11, qty: 1 }], reason: 'wrong_size', note: 'Too small', amount: null, created_at: NOW, decided_at: null };
    const o = order('o4', 1004, 'delivered', { gift: true, gift_note: 'Happy birthday, Sami', delivered_at: NOW, returns: [ret] });
    await staff(page, { 'rpc:staff_store_orders': [o], 'rpc:staff_store_return_decide': { ...o, returns: [{ ...ret, status: 'approved', amount: 200 }], refunds: [{ id: 'rf9', amount: 200, dest: null, status: 'due', at: NOW }] } });
    await page.evaluate(`window.__printed=null;window.open=()=>{const w={closed:false,focus(){},print(){},document:{_h:'',write(h){this._h+=h;window.__printed=this._h;},close(){},querySelectorAll:()=>[],images:[],fonts:{ready:Promise.resolve()},body:{offsetHeight:0}}};return w;}`);
    await page.evaluate(`setStaffTab('store')`);
    await page.locator('#tab-store .sto-pills .filter-pill', { hasText: 'All' }).click();
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1004' }).click();
    const sh = page.locator('#sto-modal [role="dialog"]');
    await expect(sh).toContainText('Gift order');
    await expect(sh).toContainText('Happy birthday, Sami');
    await sh.locator('button', { hasText: 'Print gift slip' }).click();
    await expect.poll(() => page.evaluate('window.__printed||""')).toContain('Gift slip');
    const slip = String(await page.evaluate('window.__printed'));
    expect(slip).toContain('Trail helmet');
    expect(slip).toContain('Happy birthday, Sami');
    expect(slip).not.toContain('SAR');
    // the return request
    await expect(sh.locator('.sto-rt')).toContainText('Wrong size');
    await sh.locator('.sto-rt button', { hasText: 'Decide' }).click();
    const dlg = page.locator('#sto-dlg [role="dialog"]');
    await expect(dlg).toContainText('Return request · MM-1004');
    await expect(dlg.locator('#sto-rt-amt')).toHaveValue('200');
    await dlg.locator('#sto-rt-amt').fill('150');
    await dlg.locator('button', { hasText: /^Approve$/ }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_return_decide').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_return_decide')!.body).toMatchObject({ p_id: 'rt1', p_approve: true, p_amount: 150, p_op: 'Spec Staff' });
    await expect(page.locator('#sto-dlg [role="dialog"]')).toHaveCount(0);
    await expect(sh.locator('.sto-due')).toContainText('Refund owed');
  });
});

// Void cards and refund (the owner, 2026-11-15; staff_store_order_gift_refund): a gift card order is delivered at once and
// has no Cancel, and refunding its payment would leave the codes to spend. The sheet offers one step that voids the cards
// still holding a balance and refunds only what is left on them, with the figures the server gives (gift_refund).
test.describe('@staff:store Void cards and refund', () => {
  const json = (body: unknown) => ({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const card = (id: string, code: string, x: Record<string, unknown> = {}) =>
    ({ id, code, amount: 100, balance: 100, status: 'active', expires_at: '2027-11-15T09:00:00Z', masked: false, ...x });
  // the server's answers: the order as it is, then as the action leaves it (also what a re-read finds afterwards)
  async function server(page: Page, before: Record<string, unknown>, after: Record<string, unknown>) {
    let done = false;
    await page.route(/\/rest\/v1\/rpc\/staff_store_orders/, (r) => r.fulfill(json([done ? after : before])));
    await page.route(/\/rest\/v1\/rpc\/staff_store_order_gift_refund/, (r) => { done = true; return r.fulfill(json(after)); });
  }

  test('a gift card order: no Cancel; the unspent value shown, voided and refunded as a refund owed the sheet then sends', async ({ page }) => {
    const seen = rpcCalls(page);
    const o = order('o7', 1007, 'delivered', { fulfil: 'digital', delivered_at: NOW, subtotal: 200, total: 200, vat: 0,
      items: [{ id: 21, name: 'Gift card', variant: null, qty: 2, unit_price: 100, product_id: 'gc', variant_id: 'vgc', image: null, slug: 'gift-card', gift_card: true, reviewed: false }],
      gift_cards: [card('g1', 'GC-AAAA-BBBB-CCCC'), card('g2', 'GC-DDDD-EEEE-FFFF', { balance: 40 })],
      gift_refund: { cards: 2, unspent: 140, refund: 140, card: 140, wallet: 0 } });
    const after = { ...o, gift_cards: [card('g1', 'GC-AAAA-BBBB-CCCC', { status: 'void', balance: 0 }), card('g2', 'GC-DDDD-EEEE-FFFF', { status: 'void', balance: 0 })],
      gift_refund: { cards: 0, unspent: 0, refund: 0, card: 0, wallet: 0 }, refunds: [{ id: 'rf7', amount: 140, dest: null, status: 'due', at: NOW }],
      events: [...(o.events as unknown[]), { at: NOW, status: 'gift_void', note: '140.00 SAR', by: 'Spec Staff', public: false }] };
    await staff(page, { 'rpc:staff_store_orders': [o] });
    await server(page, o, after);
    await page.evaluate(`setStaffTab('store')`);
    await page.locator('#tab-store .sto-pills .filter-pill', { hasText: 'All' }).click();
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1007' }).click();
    const sh = page.locator('#sto-modal [role="dialog"]');
    await expect(sh.locator('button', { hasText: 'Cancel order' })).toHaveCount(0);
    await expect(sh.locator('button', { hasText: /^Refund…$/ })).toHaveCount(0); // nothing owed: no plain refund of a gift card order
    await sh.locator('button', { hasText: 'Void cards and refund…' }).click();
    const form = sh.locator('.sto-form');
    await expect(form.locator('.sto-kv', { hasText: 'Gift cards to void' })).toContainText('2');
    await expect(form.locator('.sto-kv', { hasText: 'Unspent' })).toContainText('SAR 140');
    await expect(form.locator('.sto-kv', { hasText: 'To refund' })).toContainText('SAR 140');
    await sh.locator('.sto-acts button', { hasText: /^Void cards and refund$/ }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_order_gift_refund').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_order_gift_refund')!.body).toEqual({ p_order: 'o7', p_op: 'Spec Staff', p_approval: null });
    await expect(page.locator('.toast').last()).toContainText('MM-1007: gift cards voided');
    await expect(sh.locator('.sto-due')).toContainText('Refund owed: SAR 140');
    await expect(sh.locator('button', { hasText: 'Void cards and refund…' })).toHaveCount(0);
    await expect(sh.locator('button', { hasText: /^Refund…$/ })).toBeVisible(); // the refund owed, sent from the sheet
    await expect(sh.locator('.sto-tl li', { hasText: 'Gift cards voided' })).toContainText('Gift cards voided · 140.00 SAR');
    await expect(sh).toContainText('GC-AAAA-BBBB-CCCC');
  });

  test("a mixed order over the manager limit asks a manager's PIN; staff without the refund right are not offered it", async ({ page }) => {
    const seen = rpcCalls(page);
    const o = order('o8', 1008, 'paid', { subtotal: 400, total: 400, wallet_paid: 350,
      items: [{ id: 31, name: 'Trail lamp', variant: null, qty: 1, unit_price: 200, product_id: 'pl', variant_id: 'vl', image: null, slug: 'trail-lamp', gift_card: false, reviewed: false },
        { id: 32, name: 'Gift card', variant: null, qty: 1, unit_price: 200, product_id: 'gc', variant_id: 'vgc', image: null, slug: 'gift-card', gift_card: true, reviewed: false }],
      // 50 of the card spent elsewhere: 150 back, 50 owed to the card (all it paid), 100 to the wallet
      gift_cards: [card('g3', 'GC-GGGG-HHHH-JJJJ', { amount: 200, balance: 150 })], gift_refund: { cards: 1, unspent: 150, refund: 150, card: 50, wallet: 100 } });
    const after = { ...o, gift_cards: [card('g3', 'GC-GGGG-HHHH-JJJJ', { amount: 200, status: 'void', balance: 0 })], gift_refund: { cards: 0, unspent: 0, refund: 0, card: 0, wallet: 0 } };
    const ops = [{ name: 'Spec Staff', has_pin: false }, { name: 'Huda', has_pin: true }];
    await staff(page, { 'rpc:staff_store_orders': [o], 'rpc:staff_operator_list': ops, 'rpc:staff_pin_approve': { ok: true, required: true, token: 'mgr-tok' } });
    await server(page, o, after);
    await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S._staffAuthed=true;S.staffOptions={...(S.staffOptions||{}),biz:{mgr_over:100,mgr_for:{refund:true},approvers:['Huda']}};_listOk.opts=true;_bizFromOpts();`);
    await page.evaluate(`setStaffTab('store')`);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1008' }).click();
    const sh = page.locator('#sto-modal [role="dialog"]');
    await expect(sh.locator('button', { hasText: 'Cancel order' })).toBeVisible(); // the goods keep their own way
    await sh.locator('button', { hasText: 'Void cards and refund…' }).click();
    await expect(sh.locator('.sto-form .sto-kv', { hasText: 'To refund' })).toContainText('SAR 150');
    await sh.locator('.sto-acts button', { hasText: /^Void cards and refund$/ }).click();
    const gate = page.locator('#op-gate-modal .op-gate');
    await expect(gate).toContainText('Manager approval: Void cards and refund');
    await expect(gate).toContainText('Huda'); // the one approver with a PIN, asked straight away
    await page.evaluate(`_opgKey('1');_opgKey('2');_opgKey('3');_opgKey('4')`);
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_order_gift_refund').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_order_gift_refund')!.body).toEqual({ p_order: 'o8', p_op: 'Huda', p_approval: 'mgr-tok' });
    await expect(sh.locator('button', { hasText: 'Void cards and refund…' })).toHaveCount(0);
    // staff without the refund right never see it
    await page.evaluate(`_stoClose();S.staffRole='staff';S._myCaps={can_refund:false};`);
    await page.route(/\/rest\/v1\/rpc\/staff_store_orders/, (r) => r.fulfill(json([o])));
    await page.evaluate(`_stoLoad(true)`);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1008' }).click();
    await expect(sh.locator('button', { hasText: 'Delivered' }).or(sh.locator('button', { hasText: 'Preparing' })).first()).toBeVisible();
    await expect(sh.locator('button', { hasText: 'Void cards and refund…' })).toHaveCount(0);
  });

  test('a refusal of the database is said in the form', async ({ page }) => {
    const o = order('o9', 1009, 'delivered', { fulfil: 'digital', delivered_at: NOW, gift_cards: [card('g4', 'GC-KKKK-LLLL-MMMM')],
      gift_refund: { cards: 1, unspent: 100, refund: 100, card: 100, wallet: 0 } });
    await staff(page, { 'rpc:staff_store_orders': [o] });
    await page.route(/\/rest\/v1\/rpc\/staff_store_order_gift_refund/, (r) => r.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: '42501', message: 'CAP_REFUND', details: null, hint: null }) }));
    await page.evaluate(`setStaffTab('store')`);
    await page.locator('#tab-store .sto-pills .filter-pill', { hasText: 'All' }).click();
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1009' }).click();
    const sh = page.locator('#sto-modal [role="dialog"]');
    await sh.locator('button', { hasText: 'Void cards and refund…' }).click();
    await sh.locator('.sto-acts button', { hasText: /^Void cards and refund$/ }).click();
    await expect(sh.locator('.sto-form .sto-err')).toBeVisible();
    await expect(sh.locator('.sto-acts button', { hasText: /^Void cards and refund$/ })).toBeEnabled();
  });
});

test.describe('@staff:store returns, back-in-stock requests, reviews', () => {
  const rets = [
    { id: 'rt1', order_id: 'o4', order_no: 1004, name: 'Huda Buyer', phone: '966501112233', kind: 'return', items: [{ item_id: 11, name: 'Trail helmet', variant: 'M', qty: 1, unit_price: 200 }],
      reason: 'damaged', note: 'Cracked shell', status: 'open', amount: null, staff_note: null, created_at: NOW, decided_at: null, decided_by: null },
    { id: 'rt2', order_id: 'o5', order_no: 1005, name: 'Sami Sender', phone: '966509998877', kind: 'exchange', items: [{ item_id: 12, name: 'Jersey', variant: 'L', qty: 1, unit_price: 180 }],
      reason: 'wrong_size', note: null, status: 'approved', amount: null, staff_note: null, created_at: NOW, decided_at: NOW, decided_by: 'Spec Staff' },
  ];
  test('the returns list counts the open ones; refusing needs a reason and goes with the PIN', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { 'rpc:staff_store_returns': rets, 'rpc:staff_store_return_decide': { id: 'o4', no: 1004, status: 'delivered' } });
    await view(page, 'returns');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/store/returns');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('.sto-views .filter-pill', { hasText: 'Returns' }).locator('.tab-badge')).toHaveText('1');
    await expect(sec.locator('.sto-row')).toHaveCount(1); // Waiting
    await sec.locator('.sto-pills .filter-pill', { hasText: 'All' }).click();
    await expect(sec.locator('.sto-row')).toHaveCount(2);
    await sec.locator('.sto-row', { hasText: 'MM-1004' }).click();
    const dlg = page.locator('#sto-dlg [role="dialog"]');
    await expect(dlg).toContainText('Cracked shell');
    await dlg.locator('button', { hasText: 'Refuse' }).click();
    await expect(dlg.locator('.sto-err')).toContainText('Write why');
    expect(seen.filter((c) => c.name === 'staff_store_return_decide')).toHaveLength(0);
    await dlg.locator('#sto-rt-note').fill('Damage from a fall, not covered');
    await dlg.locator('button', { hasText: 'Refuse' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_return_decide').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_return_decide')!.body).toMatchObject({ p_id: 'rt1', p_approve: false, p_amount: null, p_note: 'Damage from a fall, not covered' });
    await expect(sec.locator('.sto-row', { hasText: 'MM-1004' }).locator('.sto-pill')).toHaveText('Refused');
  });

  test('a refusal of the database is said in the dialog', async ({ page }) => {
    await staff(page, { 'rpc:staff_store_returns': rets, 'rpc:staff_store_return_decide': { __rpcError: { status: 400, code: 'P0001', message: 'STORE_RETURN_STATE' } } });
    await view(page, 'returns');
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1004' }).click();
    const dlg = page.locator('#sto-dlg [role="dialog"]');
    await dlg.locator('button', { hasText: /^Approve$/ }).click();
    await expect(dlg.locator('.sto-err')).toContainText('already decided on another device');
  });

  test('back-in-stock requests: a WhatsApp link in the customer\'s language with the product page, and Mark told', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { 'rpc:staff_store_stock_requests': [
      { id: 'sr1', product_id: 'pr1', product_name: 'Trail helmet', slug: 'trail-helmet', variant_id: 'v1', label: 'M · Black', name: 'Noura Saleh', phone: '966551234567', lang: 'ar', status: 'open', created_at: NOW, done_at: null, done_by: null },
      { id: 'sr2', product_id: 'pr1', product_name: 'Trail helmet', slug: 'trail-helmet', variant_id: 'v2', label: 'L · Black', name: 'Omar', phone: '966559876543', lang: 'en', status: 'done', created_at: NOW, done_at: NOW, done_by: 'Spec Staff' }],
      'rpc:staff_store_stock_request_set': { id: 'sr1', status: 'done' } });
    await view(page, 'requests');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/store/back-in-stock');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('.sto-row')).toHaveCount(1);
    const href = await sec.locator('.sto-row a.sto-wa').getAttribute('href');
    expect(href).toContain('https://wa.me/966551234567?text=');
    const text = decodeURIComponent(String(href).split('?text=')[1]);
    expect(text).toContain('مرحباً Noura');
    expect(text).toContain('Trail helmet · M · Black');
    expect(text).toContain('https://micromobility.sa/store/trail-helmet?lang=ar');
    await sec.locator('.sto-row button', { hasText: 'Mark told' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_stock_request_set').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_stock_request_set')!.body).toEqual({ p_id: 'sr1', p_status: 'done' });
    await expect(sec.locator('.sto-row')).toHaveCount(0);
  });

  test('reviews: drawn stars, the month bought, no name; an admin shows one', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { store_products: [prod('pr1', { name_en: 'Trail helmet' })], store_variants: [],
      store_reviews: [{ id: 'rv1', product_id: 'pr1', order_id: 'o4', rating: 4, body: 'Light and comfortable', lang: 'en', bought_month: '2026-11', status: 'pending', created_at: NOW, decided_at: null, decided_by: null }],
      'rpc:staff_store_review_set': { id: 'rv1', status: 'shown' } });
    await view(page, 'reviews');
    const row = page.locator('#tab-store .sto-row', { hasText: 'Light and comfortable' });
    await expect(row).toContainText('Trail helmet');
    await expect(row).toContainText('Bought Nov 2026');
    await expect(row.locator('.sto-stars')).toHaveAttribute('aria-label', '4 of 5 stars');
    await expect(row.locator('.sto-stars svg')).toHaveCount(5);
    await row.locator('button', { hasText: 'Show' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_review_set').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_review_set')!.body).toEqual({ p_id: 'rv1', p_status: 'shown' });
  });
});

test.describe('@staff:store promo codes and gift cards', () => {
  test('without the licence a new code is refused before anything is written; with it, it is saved', async ({ page }) => {
    const pc = writes(page, 'store_promo_codes');
    await staff(page, { store_promo_codes: [] });
    await view(page, 'codes');
    await expect(page.locator('#tab-store')).toContainText('only while a discount licence number is set');
    await page.locator('#tab-store button', { hasText: 'New code' }).click();
    const dlg = page.locator('#sto-dlg [role="dialog"]');
    await dlg.locator('#sto-cd-code').fill('eid10');
    await dlg.locator('#sto-cd-value').fill('10');
    await dlg.locator('button', { hasText: /^Save$/ }).click();
    await expect(dlg.locator('.sto-err')).toContainText('discount licence number');
    expect(pc).toHaveLength(0);
  });
  test('with the licence: a percentage code is written upper-cased', async ({ page }) => {
    const pc = writes(page, 'store_promo_codes');
    await staff(page, { store_promo_codes: [], site_content: [LIC] });
    await view(page, 'codes');
    await page.locator('#tab-store button', { hasText: 'New code' }).click();
    const dlg = page.locator('#sto-dlg [role="dialog"]');
    await dlg.locator('#sto-cd-code').fill('eid10');
    await dlg.locator('#sto-cd-value').fill('95');
    await dlg.locator('button', { hasText: /^Save$/ }).click();
    await expect(dlg.locator('.sto-err')).toContainText('at most 90');
    await dlg.locator('#sto-cd-value').fill('10');
    await dlg.locator('#sto-cd-min').fill('300');
    await dlg.locator('#sto-cd-max').fill('50');
    await dlg.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => pc.length).toBe(1);
    expect(pc[0].body).toMatchObject({ code: 'EID10', kind: 'percent', value: 10, min_subtotal: 300, max_uses: 50, active: true });
    await expect(page.locator('#tab-store .sto-row', { hasText: 'EID10' })).toContainText('10% off');
  });

  test('a gift card issued by hand shows its code; one voided says why', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { store_gift_cards: [{ id: 'g1', code: 'GC-AB2C-DE3F-GH4J', amount: 300, balance: 120, status: 'active', order_id: null, order_item_id: null, note: 'Raffle prize', issued_by: 'Spec Staff', created_at: NOW, voided_at: null, void_reason: null }],
      'rpc:staff_store_gift_card_issue': { id: 'g2', code: 'GC-KM5N-PQ6R-ST7U', amount: 250, balance: 250, status: 'active', created_at: NOW },
      'rpc:staff_store_gift_card_void': { id: 'g1', status: 'void', balance: 0 } });
    await view(page, 'cards');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/store/gift-cards');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('.sto-row', { hasText: 'GC-AB2C-DE3F-GH4J' })).toContainText('of SAR 300');
    await sec.locator('button', { hasText: 'Issue a gift card' }).click();
    const dlg = page.locator('#sto-dlg [role="dialog"]');
    await dlg.locator('#sto-gc-amt').fill('5');
    await dlg.locator('button', { hasText: /^Issue$/ }).click();
    await expect(dlg.locator('.sto-err')).toContainText('SAR 10 to SAR 5,000');
    await dlg.locator('#sto-gc-amt').fill('250');
    await dlg.locator('button', { hasText: /^Issue$/ }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_gift_card_issue').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_gift_card_issue')!.body).toMatchObject({ p_amount: 250, p_op: 'Spec Staff' });
    await expect(dlg).toContainText('GC-KM5N-PQ6R-ST7U');
    await dlg.locator('button', { hasText: 'Done' }).click();
    await sec.locator('.sto-row', { hasText: 'GC-AB2C-DE3F-GH4J' }).locator('button', { hasText: 'Void' }).click();
    await page.locator('#sto-dlg button', { hasText: 'Void gift card' }).click();
    await expect(page.locator('#sto-dlg .sto-err')).toContainText('Write the reason');
    await page.locator('#sto-gc-why').fill('Lost by the winner, reissued');
    await page.locator('#sto-dlg button', { hasText: 'Void gift card' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_gift_card_void').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_gift_card_void')!.body).toMatchObject({ p_id: 'g1', p_reason: 'Lost by the winner, reissued' });
  });
});

test.describe('@staff:store products: low stock, bulk prices, Duplicate, the editor\'s new parts', () => {
  test('the Low stock pill counts the variants on sale at or under store.lowStock; the list opens the product', async ({ page }) => {
    await staff(page, { store_products: [prod('pa', { name_en: 'Bottle' }), prod('pb', { name_en: 'Draft lamp', published: false }), prod('pc', { name_en: 'Gloves' })],
      store_variants: [vari('va1', 'pa', { stock: 2, color_en: 'Blue' }), vari('va2', 'pa', { stock: 9 }), vari('vb1', 'pb', { stock: 0 }), vari('vc1', 'pc', { stock: 0, size: 'M' }), vari('vc2', 'pc', { stock: 1, active: false })],
      site_content: [{ key: 'store.lowStock', value: 2, updated_at: NOW }] });
    await view(page, 'orders');
    const pill = page.locator('#tab-store .sto-views .filter-pill', { hasText: 'Low stock' });
    await expect(pill.locator('.tab-badge')).toHaveText('2'); // the draft and the inactive variant are not counted
    await pill.click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/store/low-stock');
    const rows = page.locator('#tab-store .sto-prod');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Gloves');
    await expect(rows.first()).toContainText('Sold out');
    await expect(rows.nth(1)).toContainText('2 in stock');
    await rows.first().click();
    await expect(page.locator('#sto-pe [role="dialog"]')).toContainText('Edit Gloves');
  });

  test('bulk prices: two products down 10% to whole riyals, a variant\'s own price with them; a was price stays above', async ({ page }) => {
    const pw = writes(page, 'store_products'), vw = writes(page, 'store_variants');
    await staff(page, { store_products: [prod('pa', { name_en: 'Bottle', price: 45 }), prod('pb', { name_en: 'Lamp', price: 199, compare_at: 210 }), prod('pc', { name_en: 'Gloves', price: 80 })],
      store_variants: [vari('va1', 'pa', { price: 55 })] });
    await view(page, 'products');
    await page.locator('#tab-store button', { hasText: 'Bulk edit' }).click();
    await page.locator('#tab-store .sto-prod-pick', { hasText: 'Bottle' }).locator('input').check();
    await page.locator('#tab-store .sto-prod-pick', { hasText: 'Lamp' }).locator('input').check();
    await expect(page.locator('#sto-bulk-go')).toHaveText('Apply to 2');
    await page.locator('#sto-bulk-v').fill('5');
    await page.locator('#sto-bulk-go').click(); // Lamp 199 + 5% = 209, still under 210: allowed
    await expect.poll(() => pw.length + vw.length).toBe(3);
    await expect(page.locator('#toast-container')).toContainText('Prices changed on 2 products');
    pw.length = 0; vw.length = 0;
    await page.locator('#tab-store button', { hasText: 'Bulk edit' }).click();
    await page.locator('#tab-store .sto-prod-pick', { hasText: 'Lamp' }).locator('input').check();
    await page.locator('#sto-bulk-v').fill('10');
    await page.locator('#sto-bulk-go').click();
    await expect(page.locator('#toast-container')).toContainText('not below its was price');
    expect(pw).toHaveLength(0);
    await page.locator('#tab-store .sto-prod-pick', { hasText: 'Lamp' }).locator('input').uncheck();
    await page.locator('#tab-store .sto-prod-pick', { hasText: 'Bottle' }).locator('input').check();
    await page.locator('#tab-store .sto-prod-pick', { hasText: 'Gloves' }).locator('input').check();
    await page.locator('#sto-bulk-v').fill('-10');
    await page.locator('#sto-bulk-go').click();
    await expect.poll(() => pw.length + vw.length).toBe(3);
    const by = Object.fromEntries(pw.map((w) => [new URL(w.url).searchParams.get('id'), (w.body as { price: number }).price]));
    expect(by).toEqual({ 'eq.pa': 41, 'eq.pc': 72 }); // 45 -> 40.5 -> 41, 80 -> 72
    expect(vw[0].body).toEqual({ price: 50 }); // 55 -> 49.5 -> 50
  });

  test('Duplicate opens a draft copy (no stock, no SKU, photos shared) that saves as a new product', async ({ page }) => {
    const pw = writes(page, 'store_products'), vw = writes(page, 'store_variants');
    await staff(page, { store_products: [prod('pa', { name_en: 'Trail Helmet', slug: 'trail-helmet', images: ['/media/store/pa/a.jpg'], image_meta: { '/media/store/pa/a.jpg': { alt_en: 'Helmet, side', alt_ar: null, colour: 'Black' } } })],
      store_variants: [vari('va1', 'pa', { sku: 'TH-M', size: 'M', color_en: 'Black', stock: 6 })] });
    await view(page, 'products');
    await page.locator('#tab-store .sto-prod', { hasText: 'Trail Helmet' }).click();
    const pe = page.locator('#sto-pe [role="dialog"]');
    await pe.locator('#sto-pe-name_en').fill('Trail Helmet Pro');
    await pe.locator('button', { hasText: 'Duplicate' }).click();
    await expect(page.locator('#toast-container')).toContainText('Save or discard the changes first');
    await pe.locator('#sto-pe-name_en').fill('Trail Helmet');
    await pe.locator('button', { hasText: 'Duplicate' }).click();
    await expect(pe.locator('#sto-pe-t')).toHaveText('New product');
    await expect(pe.locator('#sto-pe-name_en')).toHaveValue('Trail Helmet (copy)');
    await expect(pe.locator('#sto-pe-slug')).toHaveValue('trail-helmet-copy');
    await expect(pe.locator('#sto-pe-published')).not.toBeChecked();
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => pw.length).toBe(1);
    expect(pw[0].method).toBe('POST');
    expect(pw[0].body).toMatchObject({ slug: 'trail-helmet-copy', published: false, images: ['/media/store/pa/a.jpg'], image_meta: { '/media/store/pa/a.jpg': { alt_en: 'Helmet, side', colour: 'Black' } } });
    expect((pw[0].body as { id: string }).id).not.toBe('pa');
    await expect.poll(() => vw.length).toBe(1);
    expect((vw[0].body as Record<string, unknown>[])[0]).toMatchObject({ sku: null, size: 'M', color_en: 'Black', stock: 0 });
  });

  test('the editor writes photo order and descriptions, key specs, the box, fit, FAQ, sizes from the chart, relations, condition and warranty', async ({ page }) => {
    const pw = writes(page, 'store_products');
    await staff(page, { store_products: [
      prod('pa', { name_en: 'City Bike', category: 'bikes', images: ['/media/store/pa/1.jpg', '/media/store/pa/2.jpg', '/media/store/pa/3.jpg'] }),
      prod('pb', { name_en: 'Lock' }), prod('pc', { name_en: 'Lights' }), prod('pd', { name_en: 'Road Bike', category: 'bikes' })],
      store_variants: [vari('v1', 'pa', { size: 'S', color_en: 'Black' }), vari('v2', 'pa', { size: 'M', color_en: 'Black' }), vari('v3', 'pa', { size: 'L', color_en: 'Red' })],
      catalog_models: [{ id: 'cm1', brand: 'Alvas', name: 'Urban 3' }] });
    await view(page, 'products');
    await page.locator('#tab-store .sto-prod', { hasText: 'City Bike' }).click();
    const pe = page.locator('#sto-pe [role="dialog"]');
    // photos: the third one moved first by dragging it onto the first, then described and tagged with a colour
    if (test.info().project.name === 'mobile') await pe.locator('.sto-img').nth(2).locator('button', { hasText: 'Make cover' }).click(); // a phone moves photos with the buttons
    else {
      await pe.locator('.sto-img').nth(2).scrollIntoViewIfNeeded();
      const from = (await pe.locator('.sto-img').nth(2).locator('.sto-img-pic').boundingBox())!, to = (await pe.locator('.sto-img').nth(0).boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 3 });
      await page.mouse.move(to.x + to.width / 2, to.y + to.height / 3, { steps: 8 });
      await page.mouse.up();
    }
    await expect(pe.locator('.sto-img').nth(0).locator('img')).toHaveAttribute('src', /\/3\.jpg/);
    await pe.locator('button[aria-label="Move photo 3 earlier"]').click(); // 2.jpg (now third) goes second
    await pe.locator('input[aria-label="Photo 1, description in English"]').fill('Rider on the City Bike, side view');
    await pe.locator('input[aria-label="Photo 1, description in Arabic"]').fill('راكب على الدراجة');
    await pe.locator('select[aria-label="Photo 1, colour"]').selectOption('Red');
    await pe.locator('#sto-pe-condition').selectOption('certified');
    await pe.locator('#sto-pe-warranty').fill('6');
    await pe.locator('#sto-pe-catalog_model').selectOption('cm1');
    // key specs
    await pe.locator('.sto-pe-sh', { hasText: 'Key specs' }).click();
    await pe.locator('.sto-pe-sec', { hasText: 'Key specs' }).locator('button', { hasText: 'Add a line' }).click();
    await pe.locator('input[aria-label="Line 1 in English"]').first().fill('10.4 kg');
    // the box
    await pe.locator('.sto-pe-sh', { hasText: 'What’s in the box' }).click();
    await pe.locator('.sto-pe-sec', { hasText: 'What’s in the box' }).locator('button', { hasText: 'Add a line' }).click();
    await pe.locator('.sto-pe-sec', { hasText: 'What’s in the box' }).locator('select').selectOption('pedals');
    await pe.locator('.sto-pe-sec', { hasText: 'What’s in the box' }).locator('input[aria-label="Line 1 in English"]').fill('Flat pedals');
    // fit and FAQ
    await pe.locator('.sto-pe-sh', { hasText: /^Fit/ }).click();
    await pe.locator('input[aria-label="Fit · EN"]').fill('Upright');
    await pe.locator('.sto-pe-sh', { hasText: 'Questions and answers' }).click();
    await pe.locator('button', { hasText: 'Add a question' }).click();
    await pe.locator('input[aria-label="Question 1 in English"]').fill('Does it come built?');
    await pe.locator('textarea[aria-label="Question 1, answer in English"]').fill('Yes, ready to ride.');
    // sizes from the owner's Hybrid chart: only the sizes the variants sell
    await pe.locator('.sto-pe-sh', { hasText: 'Sizes and rider height' }).click();
    await pe.locator('button', { hasText: 'Heights from the Hybrid chart' }).click();
    await expect(pe.locator('.sto-sz:not(.sto-kh)')).toHaveCount(3);
    // relations
    await pe.locator('.sto-pe-sh', { hasText: 'Goes with, compare, bundle' }).click();
    await pe.locator('.sto-rel', { hasText: 'Goes with' }).locator('select').selectOption({ label: 'Lock' });
    await pe.locator('.sto-rel', { hasText: 'Compare with' }).locator('select').selectOption({ label: 'Road Bike' });
    // the warranty is checked against the certified minimum
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect(pe.locator('.sto-err')).toContainText('from 12 to 120');
    await pe.locator('#sto-pe-warranty').fill('12');
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => pw.length).toBe(1);
    const b = pw[0].body as Record<string, unknown>;
    expect(b.images).toEqual(['/media/store/pa/3.jpg', '/media/store/pa/2.jpg', '/media/store/pa/1.jpg']);
    expect(b.image_meta).toEqual({ '/media/store/pa/3.jpg': { alt_en: 'Rider on the City Bike, side view', alt_ar: 'راكب على الدراجة', colour: 'Red' } });
    expect(b).toMatchObject({ condition: 'certified', warranty_months: 12, catalog_model: 'cm1', kind: 'item',
      key_specs: [{ icon: 'weight', en: '10.4 kg', ar: null }], box: [{ icon: 'pedals', en: 'Flat pedals', ar: null }],
      fit: { fit: { en: 'Upright', ar: null } }, faq: [{ q: { en: 'Does it come built?', ar: null }, a: { en: 'Yes, ready to ride.', ar: null } }],
      goes_with: ['pb'], compare_with: ['pd'], bundle: null });
    expect(b.sizes).toEqual([
      { size: 'S', height: { min: 160, max: 170 }, chest: null, waist: null },
      { size: 'M', height: { min: 171, max: 185 }, chest: null, waist: null },
      { size: 'L', height: { min: 186, max: null }, chest: null, waist: null },
    ]);
  });

  test('a was price with sale dates and a bundle need the licence; refused without it, saved with it', async ({ page }) => {
    const pw = writes(page, 'store_products');
    await staff(page, { store_products: [prod('pa', { name_en: 'City Bike', price: 2000 }), prod('pb', { name_en: 'Lock', price: 150 })], store_variants: [] });
    await view(page, 'products');
    await page.locator('#tab-store .sto-prod', { hasText: 'City Bike' }).click();
    const pe = page.locator('#sto-pe [role="dialog"]');
    await pe.locator('#sto-pe-compare_at').fill('2300');
    await pe.locator('#sto-pe-sale_from').fill('2026-12-01');
    await pe.locator('#sto-pe-sale_to').fill('2026-11-20');
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect(pe.locator('.sto-err')).toContainText('end date cannot be before');
    await pe.locator('#sto-pe-sale_to').fill('2026-12-15');
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect(pe.locator('.sto-err')).toContainText('discount licence number');
    expect(pw).toHaveLength(0);
    // a refusal of the database's guard is said in the editor too
    await page.evaluate(`_sto().keys={'store.discountLicence':'DL-1'}`);
    await page.route(/\/rest\/v1\/store_products/, (r) => r.request().method() === 'PATCH'
      ? r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'P0001', message: 'STORE_LICENCE' }) })
      : r.fallback());
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect(pe.locator('.sto-err')).toContainText('discount licence number');
  });

  test('with the licence: the sale\'s dates and a bundle are written', async ({ page }) => {
    const pw = writes(page, 'store_products');
    await staff(page, { store_products: [prod('pa', { name_en: 'City Bike', price: 2000 }), prod('pb', { name_en: 'Lock', price: 150 })], store_variants: [], site_content: [LIC] });
    await view(page, 'products');
    await page.locator('#tab-store .sto-prod', { hasText: 'City Bike' }).click();
    const pe = page.locator('#sto-pe [role="dialog"]');
    await pe.locator('#sto-pe-compare_at').fill('2300');
    await pe.locator('#sto-pe-sale_from').fill('2026-12-01');
    await pe.locator('.sto-pe-sh', { hasText: 'Goes with, compare, bundle' }).click();
    await pe.locator('.sto-rel', { hasText: 'Bundle with' }).locator('select').selectOption({ label: 'Lock' });
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect(pe.locator('.sto-err')).toContainText('A bundle needs');
    await pe.locator('#sto-pe-bunp').fill('2050');
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => pw.length).toBe(1);
    expect(pw[0].body).toMatchObject({ compare_at: 2300, sale_from: '2026-12-01', sale_to: null, bundle: { items: ['pb'], price: 2050 } });
  });

  test('a gift card product belongs in the gift category', async ({ page }) => {
    const pw = writes(page, 'store_products');
    await staff(page, { store_products: [], store_variants: [] });
    await view(page, 'products');
    await page.locator('#tab-store button', { hasText: 'New product' }).click();
    const pe = page.locator('#sto-pe [role="dialog"]');
    await pe.locator('#sto-pe-name_en').fill('Gift card');
    await pe.locator('#sto-pe-price').fill('100');
    await pe.locator('#sto-pe-kind').selectOption('gift_card');
    await expect(pe.locator('#sto-pe-category')).toHaveValue('gift');
    await pe.locator('#sto-pe-category').selectOption('accessories');
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect(pe.locator('.sto-err')).toContainText('Gift cards category');
    await pe.locator('#sto-pe-category').selectOption('gift');
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => pw.length).toBe(1);
    expect(pw[0].body).toMatchObject({ kind: 'gift_card', category: 'gift' });
  });
});

// The store.* keys are Store > Settings' since 2026-11-19 (spm-s1); the legal line stays in Payments > Settings.
test.describe('@staff:payments Settings: the delivery as charged, pickup days, slots, districts, switches, the legal identity', () => {
  test('X02: with no delivery saved the ways read as the database offers them, fees blank; a blank fee stays unset', async ({ page }) => {
    const sc = writes(page, 'site_content');
    await staff(page, { site_content: [{ key: 'pay.enabled', value: false, updated_at: NOW }] });
    // the legal line reads the website's defaults (Payments > Settings)
    await page.evaluate(`S.payView='settings';setStaffTab('payments')`);
    const pay = page.locator('#tab-payments');
    await expect(pay.locator('#ps-lgen')).toHaveValue('Micromobility Company Ltd.');
    await expect(pay.locator('#ps-cr')).toHaveValue('1009107240');
    await expect(pay.locator('#ps-vat')).toHaveValue('312555068900003');
    await view(page, 'settings');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('#ps-pu')).toBeChecked(); // pickup is on unless it is false (X01)
    await expect(sec.locator('#ps-j')).not.toBeChecked();
    await expect(sec.locator('#ps-k')).not.toBeChecked();
    await expect(sec.locator('#ps-jfee')).toHaveValue('');
    await expect(sec.locator('#ps-kfee')).toHaveValue('');
    await expect(sec.locator('#ps-free')).toHaveValue('');
    await sec.locator('#ps-j').check();
    await sec.locator('#ps-pudays').fill('1-2');
    await sec.locator('#ss-save').click();
    await expect.poll(() => sc.length).toBeGreaterThan(0);
    const by = Object.fromEntries((sc[0].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    expect(by['store.delivery']).toEqual({ pickup: { on: true, fee: 0, days: '1-2' }, jeddah: { on: true }, ksa: { on: false }, freeOver: null });
    for (const k of ['store.lowStock', 'store.tabby.on', 'store.smsa.on', 'store.addressLookup.on', 'store.slots', 'store.districts', 'site.legal.cr', 'site.legal.vat', 'site.legal.legalName']) expect(by).not.toHaveProperty(k);
  });

  test('X01: pickup switched off is written off; the store open with no way at all is refused', async ({ page }) => {
    const sc = writes(page, 'site_content');
    await staff(page, { site_content: [{ key: 'store.open', value: true, updated_at: NOW },
      { key: 'store.delivery', value: { pickup: { on: true, fee: 0 }, jeddah: { on: false, fee: 25 }, ksa: { on: false } }, updated_at: NOW }] });
    await view(page, 'settings');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('#ps-jfee')).toHaveValue('25');
    await sec.locator('#ps-pu').uncheck();
    await sec.locator('#ss-save').click();
    await expect(page.locator('#toast-container')).toContainText('keep at least one way');
    expect(sc).toHaveLength(0);
    await sec.locator('#ps-j').check();
    await sec.locator('#ss-save').click();
    await expect.poll(() => sc.length).toBeGreaterThan(0);
    const by = Object.fromEntries((sc[0].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    expect(by['store.delivery']).toEqual({ pickup: { on: false, fee: 0 }, jeddah: { on: true, fee: 25 }, ksa: { on: false }, freeOver: null });
  });

  test('slots, districts, the switches, low stock, complaints and the legal identity are written as the website reads them', async ({ page }) => {
    const sc = writes(page, 'site_content');
    await staff(page, { site_content: [{ key: 'biz.public', value: { vat_no: '300000000000003' }, updated_at: NOW }] });
    await view(page, 'settings');
    const sec = page.locator('#tab-store');
    await sec.locator('#ps-sl').check();
    await sec.locator('#ps-sk6').check(); // no delivery on Saturdays too
    await sec.locator('input[aria-label="Time 2, from"]').fill('17:00');
    await sec.locator('button', { hasText: 'Add a time' }).first().click(); // the slots' (the handover's and Ramadan's follow, 2026-11-18)
    await sec.locator('input[aria-label="Time 3, from"]').fill('21:00');
    await sec.locator('input[aria-label="Time 3, to"]').fill('21:00'); // a time may run past midnight since 2026-11-18 (21:00 to 01:00), never end where it starts
    await sec.locator('#ss-save').click();
    await expect(page.locator('#toast-container')).toContainText('Time 3');
    await sec.locator('input[aria-label="Time 3, to"]').fill('23:00');
    await sec.locator('#ps-ds').check();
    await sec.locator('#ss-save').click();
    await expect(page.locator('#toast-container')).toContainText('at least one district');
    await sec.locator('button', { hasText: 'Add a district' }).click();
    await sec.locator('input[aria-label="District 1, name in English"]').fill('Al Rawdah');
    await sec.locator('input[aria-label="District 1, name in Arabic"]').fill('الروضة');
    await sec.locator('#ps-tabby').check();
    await sec.locator('#ps-smsa').check();
    await sec.locator('#ps-low').fill('5');
    await sec.locator('#ps-cdays').fill('3');
    await sec.locator('#ss-save').click();
    await expect.poll(() => sc.length).toBeGreaterThan(0);
    const by = Object.fromEntries((sc[0].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    expect(by['store.slots']).toEqual({ on: true, ahead: 6, lead: 1, skip: [5, 6], times: [{ id: 'am', from: '09:00', to: '13:00' }, { id: 'pm', from: '17:00', to: '21:00' }, { id: 't1', from: '21:00', to: '23:00' }] });
    expect(by['store.districts']).toEqual({ on: true, list: [{ en: 'Al Rawdah', ar: 'الروضة' }] });
    expect(by).toMatchObject({ 'store.tabby.on': true, 'store.smsa.on': true, 'store.lowStock': 5, 'store.complaintsDays': 3 });
    expect(by).not.toHaveProperty('store.addressLookup.on');
    await expect(page.locator('#toast-container')).toContainText('Settings saved');
    // the legal identity: Payments > Settings
    await page.evaluate(`S.payView='settings';setStaffTab('payments')`);
    const pay = page.locator('#tab-payments');
    await expect(pay.locator('#ps-vat')).toHaveValue('300000000000003'); // Settings > Business's, when the legal line has none
    await pay.locator('#ps-ecr').fill('7011223344');
    await pay.locator('#ps-vat').fill('31234');
    await pay.locator('#ps-save').click();
    await expect(page.locator('#toast-container')).toContainText('15 digits');
    await pay.locator('#ps-vat').fill('311111111100003');
    await pay.locator('#ps-sbc').fill('https://eauthenticate.saudibusiness.gov.sa/certificate-details/0000000000');
    await pay.locator('#ps-cr').fill('');
    await pay.locator('#ps-save').click();
    await expect.poll(() => sc.length).toBeGreaterThan(1);
    const lg = Object.fromEntries((sc[sc.length - 1].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    expect(lg).toMatchObject({ 'site.legal.ecr': { en: '7011223344', ar: '7011223344' }, 'site.legal.vat': { en: '311111111100003', ar: '311111111100003' },
      'site.legal.sbc': { href: 'https://eauthenticate.saudibusiness.gov.sa/certificate-details/0000000000' }, 'site.legal.cr': { en: '', ar: '' } });
    expect(lg).not.toHaveProperty('site.legal.legalName');
    for (const k of Object.keys(lg)) expect(k).not.toMatch(/^store\./); // Payments writes no store key
  });
});

// The review's fixes (2026-11-15): a gift card's year and Extend (the lead's answer 3), the store's own addresses refused
// as a slug (w2's addition), a gift card's face value, clearing sale dates without the licence, a return's refund less
// the order's discount, bulk prices leaving gift cards alone, and a free-delivery threshold of 0 read as none.
const ksaDay = (days = 0) => new Date(Date.now() + 3 * 3600e3 + days * 86400e3).toISOString().slice(0, 10);
const atKsaEnd = (day: string) => new Date(Date.parse(day + 'T00:00:00+03:00') + 86400e3).toISOString(); // the instant after that day

test.describe('@staff:store review fixes', () => {
  test('gift cards: each says until when it is valid, an expired one reads Expired, and Extend moves its last day with the PIN', async ({ page }) => {
    const seen = rpcCalls(page);
    const card = (id: string, code: string, exp: string, x: Record<string, unknown> = {}) => ({ id, code, amount: 200, balance: 200, status: 'active', order_id: null, order_item_id: null,
      note: null, issued_by: 'Spec Staff', created_at: NOW, expires_at: exp, voided_at: null, void_reason: null, ...x });
    const later = ksaDay(40);
    await staff(page, { store_gift_cards: [card('g1', 'GC-AB2C-DE3F-GH4J', atKsaEnd(ksaDay(200))), card('g2', 'GC-KM5N-PQ6R-ST7U', atKsaEnd(ksaDay(-3)))],
      'rpc:staff_store_gift_card_extend': card('g2', 'GC-KM5N-PQ6R-ST7U', atKsaEnd(later)) });
    await view(page, 'cards');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('.sto-row')).toHaveCount(1); // Active: the expired one is under Expired
    await expect(sec.locator('.sto-row', { hasText: 'GC-AB2C-DE3F-GH4J' })).toContainText('Valid until');
    await sec.locator('.sto-pills .filter-pill', { hasText: 'Expired' }).click();
    const row = sec.locator('.sto-row', { hasText: 'GC-KM5N-PQ6R-ST7U' });
    await expect(row.locator('.sto-pill')).toHaveText('Expired');
    await expect(row.locator('button', { hasText: 'Print' })).toHaveCount(0);
    await row.locator('button', { hasText: 'Extend' }).click();
    const dlg = page.locator('#sto-dlg [role="dialog"]');
    await expect(dlg.locator('#sto-gc-until')).toHaveValue(String(Number(ksaDay(0).slice(0, 4)) + 1) + ksaDay(0).slice(4)); // a year from today, the card being past its own
    await dlg.locator('#sto-gc-until').fill(ksaDay(0));
    await dlg.locator('button', { hasText: /^Extend$/ }).click();
    await expect(dlg.locator('.sto-err')).toContainText('from tomorrow');
    expect(seen.filter((c) => c.name === 'staff_store_gift_card_extend')).toHaveLength(0);
    await dlg.locator('#sto-gc-until').fill(later);
    await dlg.locator('button', { hasText: /^Extend$/ }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_gift_card_extend').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_gift_card_extend')!.body).toMatchObject({ p_id: 'g2', p_until: later, p_op: 'Spec Staff' });
    await expect(page.locator('#toast-container')).toContainText('is valid until');
    await sec.locator('.sto-pills .filter-pill', { hasText: 'Active' }).click();
    await expect(sec.locator('.sto-row')).toHaveCount(2);
  });

  test('a gift card\'s new date the database refuses is said in the dialog', async ({ page }) => {
    await staff(page, { store_gift_cards: [{ id: 'g1', code: 'GC-AB2C-DE3F-GH4J', amount: 50, balance: 50, status: 'active', order_id: null, note: null, issued_by: null, created_at: NOW, expires_at: atKsaEnd(ksaDay(30)), voided_at: null, void_reason: null }],
      'rpc:staff_store_gift_card_extend': { __rpcError: { status: 400, code: 'P0001', message: 'STORE_GIFT_DATE' } } });
    await view(page, 'cards');
    await page.locator('#tab-store .sto-row button', { hasText: 'Extend' }).click();
    await page.locator('#sto-dlg button', { hasText: /^Extend$/ }).click();
    await expect(page.locator('#sto-dlg .sto-err')).toContainText('Pick a day from tomorrow');
  });

  test('the store\'s own addresses are refused as a slug, gift-card for anything but a gift card; a gift card\'s value is SAR 10 to 5,000', async ({ page }) => {
    const pw = writes(page, 'store_products');
    await staff(page, { store_products: [], store_variants: [] });
    await view(page, 'products');
    await page.locator('#tab-store button', { hasText: 'New product' }).click();
    const pe = page.locator('#sto-pe [role="dialog"]');
    await pe.locator('#sto-pe-name_en').fill('Saved');
    await pe.locator('#sto-pe-price').fill('50');
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect(pe.locator('.sto-err')).toContainText('one of the store’s own pages');
    await pe.locator('#sto-pe-slug').fill('gift-card');
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect(pe.locator('.sto-err')).toContainText('one of the store’s own pages');
    expect(pw).toHaveLength(0);
    await pe.locator('#sto-pe-kind').selectOption('gift_card');
    await pe.locator('#sto-pe-price').fill('5');
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect(pe.locator('.sto-err')).toContainText('SAR 10 to SAR 5,000');
    expect(pw).toHaveLength(0);
    await pe.locator('#sto-pe-price').fill('50');
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => pw.length).toBe(1);
    expect(pw[0].body).toMatchObject({ slug: 'gift-card', kind: 'gift_card', category: 'gift', price: 50 });
  });

  test('without the licence a sale\'s dates can still be cleared (the database allows it); the was price stays as it was', async ({ page }) => {
    const pw = writes(page, 'store_products');
    await staff(page, { store_products: [prod('pa', { name_en: 'City Bike', price: 2000, compare_at: 2300, sale_from: '2026-12-01', sale_to: '2026-12-15' })], store_variants: [], site_content: [] });
    await view(page, 'products');
    await page.locator('#tab-store .sto-prod', { hasText: 'City Bike' }).click();
    const pe = page.locator('#sto-pe [role="dialog"]');
    await pe.locator('#sto-pe-sale_from').fill('');
    await pe.locator('#sto-pe-sale_to').fill('');
    await pe.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => pw.length).toBe(1);
    expect(pw[0].body).toMatchObject({ compare_at: 2300, sale_from: null, sale_to: null });
  });

  test('a return\'s refund starts at the lines less their share of the order\'s discount', async ({ page }) => {
    const o = order('o4', 1004, 'delivered', { subtotal: 300, discount: 30, discounts: [{ kind: 'promo', ref: 'EID10', amount: 30 }], total: 270,
      items: [{ id: 11, name: 'Trail helmet', variant: 'M', qty: 1, unit_price: 200, product_id: 'pr1', variant_id: 'v1', image: null, slug: 'trail-helmet', gift_card: false, reviewed: false },
        { id: 12, name: 'Bottle', variant: null, qty: 1, unit_price: 100, product_id: 'pr2', variant_id: 'v2', image: null, slug: 'bottle', gift_card: false, reviewed: false }] });
    const rt = { id: 'rt1', order_id: 'o4', order_no: 1004, name: 'Huda Buyer', phone: '966501112233', kind: 'return', items: [{ item_id: 11, name: 'Trail helmet', variant: 'M', qty: 1, unit_price: 200 }],
      reason: 'damaged', note: null, status: 'open', amount: null, staff_note: null, created_at: NOW, decided_at: null, decided_by: null };
    await staff(page, { 'rpc:staff_store_orders': [o], 'rpc:staff_store_returns': [rt] });
    const read = page.waitForResponse((r) => r.url().includes('/rpc/staff_store_orders'));
    await view(page, 'returns');
    await read;
    await expect.poll(() => page.evaluate(`!!_stoOrder('o4')`)).toBe(true);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1004' }).click();
    await expect(page.locator('#sto-rt-amt')).toHaveValue('180'); // 200 of 300 in goods, 30 off: 200 x 270 / 300
  });

  test('a return on an order the list does not hold reads the order first: the refund still starts at the lines less their discount share (bug hunt 2026-11-18, app17-2)', async ({ page }) => {
    const rt = { id: 'rt1', order_id: 'o4', order_no: 1004, name: 'Huda Buyer', phone: '966501112233', kind: 'return', items: [{ item_id: 11, name: 'Trail helmet', variant: 'M', qty: 1, unit_price: 200 }],
      reason: 'damaged', note: null, status: 'open', amount: null, staff_note: null, created_at: NOW, decided_at: null, decided_by: null };
    await staff(page, { 'rpc:staff_store_orders': [], 'rpc:staff_store_returns': [rt], store_orders: [{ total: 270, discount: 30 }],
      store_order_items: [{ qty: 1, unit_price: 200, gift_card: false }, { qty: 1, unit_price: 100, gift_card: false }] });
    await view(page, 'returns');
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1004' }).click();
    await expect(page.locator('#sto-rt-amt')).toHaveValue('180'); // not the 200 the line costs at full price
  });

  test('bulk prices leave gift cards alone; a free-delivery threshold of 0 reads as none', async ({ page }) => {
    await staff(page, { store_products: [prod('pa', { name_en: 'Bottle', price: 45 }), prod('pg', { name_en: 'Gift card', kind: 'gift_card', category: 'gift', slug: 'gift-card', price: 100 })], store_variants: [],
      site_content: [{ key: 'store.delivery', value: { pickup: { on: true, fee: 0 }, jeddah: { on: true, fee: 20 }, ksa: { on: false }, freeOver: 0 }, updated_at: NOW }] });
    await view(page, 'products');
    await page.locator('#tab-store button', { hasText: 'Bulk edit' }).click();
    await expect(page.locator('#tab-store .sto-prod-pick')).toHaveCount(1);
    await page.locator('#tab-store button', { hasText: 'Select all' }).click();
    await expect(page.locator('#sto-bulk-go')).toHaveText('Apply to 1');
    await view(page, 'settings');
    await expect(page.locator('#tab-store #ps-jfee')).toHaveValue('20');
    await expect(page.locator('#tab-store #ps-free')).toHaveValue('');
  });
});
