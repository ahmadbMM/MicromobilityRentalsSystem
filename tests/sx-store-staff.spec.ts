import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';
import { freshModule } from './helpers/fresh-module';

// The store's staff screens of the 2026-11-18 build (the user: "do all"; the website's B1-B4 on staging): quotes (N23), the
// order sheet's new parts (N07 N13 N14 N15 N17 N29 N30 N31 N34 N08), "I'm here" and the warranty claims queue, the settings
// the website reads, the fleet bike of an ex-rental product (N25), the photos' w320 / w1600 copies (P09), the status pushed
// to the customer (N04) and the push sender's store branch. All traffic stubbed; invented data.

const NOW = '2026-11-18T09:00:00Z';
const KEY = '0123456789abcdef0123456789abcdef';
const pay = (id: string) => ({ id, kind: 'order', ref: 'o1', amount: 4000, currency: 'SAR', description: 'Order', status: 'paid', hold: true,
  expires_at: NOW, paid_at: NOW, method: 'creditcard', brand: 'mada', last4: '4242', message: null, refunded: 0, receipt_no: 77, created_at: NOW });
const order = (id: string, no: number, status: string, x: Record<string, unknown> = {}) => ({
  id, no, status, fulfil: 'pickup', name: 'Huda Buyer', phone: '966501112233', email: 'huda@example.test', address: null, note: null,
  staff_note: null, customer_id: 'c1', subtotal: 4000, delivery_fee: 0, total: 4000, wallet_paid: 0, vat: 521.74, courier: null, tracking_no: null,
  expires_at: null, paid_at: NOW, created_at: NOW, cancel_reason: null, payment_id: 'p-' + id, payment: pay('p-' + id),
  items: [{ id: 11, name: 'DA54 MAX', variant: 'M · Black', qty: 1, unit_price: 4000, product_id: 'pr1', variant_id: 'v1', image: null, slug: 'max' }],
  events: [{ at: NOW, status: 'paid', note: null, by: null, public: true }], refunds: [], returns: [], ...x,
});
const products = [
  { id: 'pr1', slug: 'max', category: 'bikes', kind: 'item', condition: 'new', name_en: 'DA54 MAX', name_ar: null, price: 4000, published: true, sort: 0, images: [], specs: [], goes_with: ['pr2'], ship_ksa: false },
  { id: 'pr2', slug: 'light', category: 'accessories', kind: 'item', condition: 'new', name_en: 'Trail Light', name_ar: null, price: 120, published: true, sort: 1, images: [], specs: [], goes_with: [], ship_ksa: true },
];
const variants = [
  { id: 'v1', product_id: 'pr1', size: 'M', color_en: 'Black', stock: 3, active: true, price: null, sort: 0 },
  { id: 'v1l', product_id: 'pr1', size: 'L', color_en: 'Black', stock: 2, active: true, price: null, sort: 1 },
  { id: 'v2', product_id: 'pr2', size: null, color_en: null, stock: 9, active: true, price: null, sort: 0 },
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
const calls = (seen: { name: string; body: Record<string, unknown> }[], n: string) => seen.filter((c) => c.name === n);
function writes(page: Page, table: string) {
  const seen: { method: string; body: unknown; url: string }[] = [];
  page.on('request', (r) => {
    if (!r.url().includes(`/rest/v1/${table}`) || !['POST', 'PATCH', 'DELETE'].includes(r.method())) return;
    let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
    seen.push({ method: r.method(), body, url: r.url() });
  });
  return seen;
}
async function staff(page: Page, fx: Fixtures = {}, url = '/?staff') {
  const ops = [{ name: 'Spec Staff', has_pin: false }];
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, staff_options: [], 'rpc:staff_operator_list': ops, 'rpc:staff_store_ready': true,
    store_orders: [], payment_refunds: [], ...fx });
  await unlockStaff(page);
  await page.goto(url);
  await waitForSb(page);
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S.staffRole='admin';renderStaffTabs();`);
  await page.evaluate(`sb.auth.getSession=async()=>({data:{session:{access_token:'tok-staff',expires_at:Math.floor(Date.now()/1000)+3600}},error:null})`);
  await expect.poll(() => page.evaluate('S._storeReady')).toBe(true);
}
const view = (page: Page, v: string) => page.evaluate(`S.stoView='${v}';setStaffTab('store')`);
const dlg = (page: Page) => page.locator('#sto-dlg [role="dialog"]');
const sheet = (page: Page) => page.locator('#sto-modal [role="dialog"]');

const quote = (id: string, no: number, state: string, x: Record<string, unknown> = {}) => ({
  id, no, token: 'abc123def456ghi789jkl012mno345p' + no, fulfil: 'pickup', slot: null, handover: { day: '2026-11-21', at: '16:00' }, name: 'Huda Buyer', phone: '966501112233',
  staff_note: null, lang: 'en', status: state === 'void' ? 'void' : 'open', state, expires_at: '2026-11-25T09:00:00Z', created_at: NOW, created_by: 'Spec Staff',
  order_id: null, order_no: null, order_status: null, subtotal: 4120,
  items: [{ variant: 'v1', qty: 1, product_id: 'pr1', name_en: 'DA54 MAX', name_ar: null, label: 'M · Black', unit: 4000, live: true, stock: 3 },
    { variant: 'v2', qty: 1, product_id: 'pr2', name_en: 'Trail Light', name_ar: null, label: null, unit: 120, live: true, stock: 9 }], ...x,
});

test.describe('@staff:store quotes (N23)', () => {
  test('the list by state, a quote\'s link, WhatsApp with the link filled in, Copy link, Withdraw', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const seen = rpcCalls(page);
    const q1 = quote('q1', 7, 'open'), q2 = quote('q2', 6, 'used', { order_id: 'o3', order_no: 1003, order_status: 'paid' }), q3 = quote('q3', 5, 'void');
    await staff(page, { 'rpc:staff_store_quotes': [q1, q2, q3], 'rpc:staff_store_quote_void': { ...q1, status: 'void', state: 'void' } });
    await view(page, 'quotes');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('.sto-views .filter-pill', { hasText: 'Quotes' })).toHaveAttribute('aria-pressed', 'true');
    await expect(sec.locator('.sto-row')).toHaveCount(1); // Open
    await expect(sec.locator('.sto-row')).toContainText('Q-7');
    await sec.locator('.filter-pill', { hasText: 'All' }).click();
    await expect(sec.locator('.sto-row')).toHaveCount(3);
    await expect(sec.locator('.sto-row', { hasText: 'Q-6' })).toContainText('MM-1003'); // used: the order it became
    await expect(sec.locator('.sto-row', { hasText: 'Q-5' })).toContainText('Withdrawn');
    expect(new URL(page.url()).pathname).toBe('/store/quotes');
    await sec.locator('.sto-row', { hasText: 'Q-7' }).click();
    const d = dlg(page);
    await expect(d.locator('.sto-q-link')).toHaveValue('https://micromobility.sa/store/q/' + q1.token);
    const wa = await d.locator('a.sto-link').getAttribute('href');
    expect(wa).toContain('https://wa.me/966501112233?text=');
    expect(decodeURIComponent(String(wa).split('text=')[1])).toBe(`Hello Huda, here is your MicroMobility quote Q-7: https://micromobility.sa/store/q/${q1.token}`);
    await d.locator('button', { hasText: 'Copy link' }).click();
    await expect(page.locator('#toast-container')).toContainText('Link copied');
    await d.locator('button', { hasText: 'Withdraw' }).click();
    await page.locator('#confirm-modal button.btn-red').click();
    await expect.poll(() => calls(seen, 'staff_store_quote_void').length).toBe(1);
    expect(calls(seen, 'staff_store_quote_void')[0].body).toEqual({ p_id: 'q1' });
    await expect(sec.locator('.sto-row', { hasText: 'Q-7' })).toContainText('Withdrawn');
  });

  test('a new quote: products, an add-on, the handover time, the customer; the database\'s refusal is said in the editor', async ({ page }) => {
    const seen = rpcCalls(page);
    const saved = quote('q9', 9, 'open');
    await staff(page, { store_products: products, store_variants: variants, 'rpc:staff_store_quotes': [], 'rpc:staff_store_quote_save': saved,
      'rpc:store_handover_slots': { on: true, minutes: 20, days: [{ day: '2026-11-21', slots: [{ at: '16:00', to: '16:20', open: true }, { at: '16:20', to: '16:40', open: false }] }] } });
    await view(page, 'quotes');
    await page.locator('#tab-store .sto-head-acts button', { hasText: 'New quote' }).click();
    const d = dlg(page);
    await expect(d.locator('#sto-dlg-t')).toHaveText('New quote');
    await d.locator('button', { hasText: 'Save' }).click();
    await expect(d.locator('.sto-err')).toContainText('not on sale or not in stock'); // nothing in it yet
    await d.locator('select[aria-label="Add a product"]').selectOption('pr1');
    await expect(d.locator('.sto-qe-l')).toHaveCount(1);
    await d.locator('.sto-chips button', { hasText: 'Trail Light' }).click(); // what it goes with
    await expect(d.locator('.sto-qe-l')).toHaveCount(2);
    await d.locator('select[aria-label="Line 1, size or colour"]').selectOption('v1l');
    await d.locator('input[aria-label="Line 2, quantity"]').fill('2');
    await d.locator('#sto-qe-way').selectOption('pickup');
    await d.locator('#sto-qe-hday').selectOption('2026-11-21');
    await expect(d.locator('#sto-qe-hat option')).toHaveCount(2); // Customer picks + the one still open
    await d.locator('#sto-qe-hat').selectOption('16:00');
    await d.locator('#sto-qe-name').fill('Huda  Buyer');
    await d.locator('#sto-qe-phone').fill('12345');
    await d.locator('button', { hasText: 'Save' }).click();
    await expect(d.locator('.sto-err')).toContainText('Saudi mobile');
    expect(calls(seen, 'staff_store_quote_save')).toHaveLength(0);
    await d.locator('#sto-qe-phone').fill('050 111 2233');
    await d.locator('button', { hasText: 'Save' }).click();
    await expect.poll(() => calls(seen, 'staff_store_quote_save').length).toBe(1);
    expect(calls(seen, 'staff_store_quote_save')[0].body).toEqual({ p_quote: {
      items: [{ variant: 'v1l', qty: 1 }, { variant: 'v2', qty: 2 }], fulfil: 'pickup', name: 'Huda Buyer', phone: '966501112233', staff_note: null, lang: 'en', days: 7,
      handover: { day: '2026-11-21', at: '16:00' } } });
    // saved: the quote itself, with its link to send
    await expect(d.locator('#sto-dlg-t')).toHaveText('Quote Q-9');
    await expect(d.locator('.sto-q-link')).toHaveValue('https://micromobility.sa/store/q/' + saved.token);
  });

  test('a refusal (a product sold out meanwhile) is said in the editor, and the list is gone on a database without quotes', async ({ page }) => {
    await staff(page, { store_products: products, store_variants: variants, 'rpc:staff_store_quotes': [],
      'rpc:staff_store_quote_save': { __rpcError: { status: 400, code: 'P0001', message: 'STORE_QUOTE_ITEMS: v1' } } });
    await view(page, 'quotes');
    await page.evaluate(`_stoQeOpen()`);
    const d = dlg(page);
    await d.locator('select[aria-label="Add a product"]').selectOption('pr2');
    await d.locator('button', { hasText: 'Save' }).click();
    await expect(d.locator('.sto-err')).toContainText('not on sale or not in stock');
  });

  test('no staff_store_quotes on this database: the view says so', async ({ page }) => {
    await staff(page, { 'rpc:staff_store_quotes': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_store_quotes in the schema cache' } } });
    await view(page, 'quotes');
    await expect(page.locator('#tab-store')).toContainText('not set up on this database yet');
  });
});

const after = (x: Record<string, unknown> = {}) => ({ build: null, arrival: null, claims: [], push: false, changes: 0, return_photos: [], slot_changes: [], push_to: null, ...x });

test.describe('@staff:store the order sheet (N07 N13 N14 N15 N17 N23 N29 N30 N31 N34 N08)', () => {
  test('company, pin, handover and its change, session, still learning, the quote, and I\'m here with Seen', async ({ page }) => {
    const seen = rpcCalls(page);
    const o = order('o1', 1001, 'ready', {
      company: { name: 'Acme Trading Co', vat: '312345678900003', cr: '4030123456', address: { building: '1234', street: 'King Road', district: 'Al Shati', city: 'Jeddah', postal: '23412' } },
      pin: { lat: 21.54321, lng: 39.17234 }, handover: { day: '2026-11-21', at: '16:20', to: '16:40' }, learning: true, quote_no: 7,
      session: { date: '2026-11-22', entry: 'q-e1', session: 's1' } });
    const af = after({ arrival: { at: '2026-11-18T13:42:00Z', car: 'White Camry', seen_at: null, seen_by: null },
      slot_changes: [{ old: { day: '2026-11-21', at: '16:00', to: '16:20' }, new: { day: '2026-11-21', at: '16:20', to: '16:40' }, at: NOW }] });
    await staff(page, { 'rpc:staff_store_orders': [o], store_products: products, store_variants: variants, 'rpc:staff_store_after_order': af,
      xp_bike_credits: [{ order_id: 'o1', customer_id: 'c1', amount: 150, bookings: ['q-e0'], reversed: 0, created_at: NOW }],
      'rpc:staff_store_after_seen': { ...af, arrival: { at: '2026-11-18T13:42:00Z', car: 'White Camry', seen_at: '2026-11-18T13:44:00Z', seen_by: 'Spec Staff' } } });
    await view(page, 'orders');
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1001' }).click();
    const sh = sheet(page);
    await expect(sh).toContainText('Still learning to ride');
    await expect(sh).toContainText('From quote Q-7');
    await expect(sh).toContainText('Tax invoice');
    await expect(sh).toContainText('Acme Trading Co');
    await expect(sh).toContainText('312345678900003');
    await expect(sh).toContainText('4030123456');
    await expect(sh.locator('.sto-kv', { hasText: 'Handover' })).toContainText('16:20–16:40');
    await expect(sh).toContainText('Moved from');
    await expect(sh).toContainText('Hand over at the session on');
    await expect(sh.locator('a.sto-link', { hasText: 'Open in Maps' })).toHaveAttribute('href', 'https://www.google.com/maps/search/?api=1&query=21.54321%2C39.17234');
    await expect(sh).toContainText('White Camry');
    await expect(sh.locator('.sto-kv', { hasText: 'Bike credit' })).toContainText('150'); // EF22's credit for this order
    expect(calls(seen, 'staff_store_after_order')[0].body).toEqual({ p_order: 'o1' });
    await sh.locator('button', { hasText: 'Seen, bringing it out' }).click();
    await expect.poll(() => calls(seen, 'staff_store_after_seen').length).toBe(1);
    expect(calls(seen, 'staff_store_after_seen')[0].body).toEqual({ p_order: 'o1' });
    await expect(sh).toContainText('Seen by Spec Staff');
  });

  test('the build: a photo shrunk on this device, the checks and a note, then Save and mark ready', async ({ page }) => {
    const seen = rpcCalls(page);
    const o = order('o1', 1001, 'paid');
    const built = after({ build: { at: NOW, photos: ['/media/store-builds/5f0c2a3e-8b1d-4c7a-9e2f-0a1b2c3d4e5f/x1.jpg'], checks: { brakes: true, gears: true, torque: false, tyres: false }, note: 'Pedals in the box', by: 'Spec Staff' } });
    await staff(page, { 'rpc:staff_store_orders': [o], store_products: products, store_variants: variants, 'rpc:staff_store_after_order': after(),
      'rpc:staff_store_after_build': built, 'rpc:staff_store_order_set': { ...o, status: 'ready' } });
    await view(page, 'orders');
    await page.evaluate(`window.__up=[];window._catUploadImage=async(f,folder,opt)=>{window.__up.push([folder,opt]);return '/media/'+folder+'/x1.jpg';}`);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1001' }).click();
    const sh = sheet(page);
    await sh.locator('button', { hasText: 'Photos and checks' }).click();
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), sh.locator('button', { hasText: 'Add photo' }).click()]);
    await fc.setFiles({ name: 'bike.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    await expect(sh.locator('.sto-pic img')).toHaveCount(1);
    // an unguessable folder for the order's build (never its sequential number: /media is public by address)
    const up = JSON.parse(String(await page.evaluate('JSON.stringify(window.__up)'))) as [string, unknown][];
    expect(up).toHaveLength(1);
    expect(up[0][0]).toMatch(/^store-builds\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(up[0][0]).not.toContain('1001');
    expect(up[0][1]).toEqual({ max: 1600, w: [640] });
    await sh.locator('#sto-bk-brakes').check();
    await sh.locator('#sto-bk-gears').check();
    await sh.locator('#sto-bd-note').fill('Pedals in the box');
    await sh.locator('button', { hasText: 'Save and mark ready' }).click();
    await expect.poll(() => calls(seen, 'staff_store_order_set').length).toBe(1);
    expect(calls(seen, 'staff_store_after_build')[0].body).toEqual({ p_order: 'o1', p_photos: [`/media/${up[0][0]}/x1.jpg`],
      p_checks: { brakes: true, gears: true, torque: false, tyres: false }, p_note: 'Pedals in the box' });
    expect(calls(seen, 'staff_store_order_set')[0].body).toMatchObject({ p_order: 'o1', p_status: 'ready' });
    await expect(sh.locator('.sto-ck-on')).toHaveCount(2);
    await expect(sh).toContainText('Pedals in the box');
    // a later photo of the same build goes into the same folder
    await sh.locator('button', { hasText: 'Change the build' }).click();
    const [fc2] = await Promise.all([page.waitForEvent('filechooser'), sh.locator('button', { hasText: 'Add photo' }).click()]);
    await fc2.setFiles({ name: 'bike2.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    await expect(sh.locator('.sto-pic img')).toHaveCount(2);
    expect(JSON.parse(String(await page.evaluate('JSON.stringify(window.__up)')))[1][0]).toBe('store-builds/5f0c2a3e-8b1d-4c7a-9e2f-0a1b2c3d4e5f');
  });

  test('a warranty claim with its photos: Not covered needs a reply; a return\'s photos show', async ({ page }) => {
    const seen = rpcCalls(page);
    const photo = 'o1001/' + 'a'.repeat(32) + '.jpg';
    const o = order('o1', 1001, 'delivered', { returns: [{ id: 'r1', kind: 'return', status: 'open', items: [{ item_id: 11, qty: 1 }], reason: 'damaged', note: null, amount: null, created_at: NOW }] });
    const claim = { id: 'cl1', item_id: 11, item: 'DA54 MAX', state: 'open', body: 'The rear brake squeaks after rain.', photos: [photo], reply: null, staff_note: null, decided_by: null, decided_at: null, created_at: NOW };
    await staff(page, { 'rpc:staff_store_orders': [o], store_products: products, store_variants: variants,
      'rpc:staff_store_after_order': after({ claims: [claim], return_photos: [{ id: 'r1', photos: [photo] }] }),
      'rpc:staff_store_after_claim_set': after({ claims: [{ ...claim, state: 'refused', reply: 'Brake pads wear with use.' }] }) });
    await page.route('**/storage/v1/object/sign/store-claims', (r: Route) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify([{ path: photo, signedURL: `/object/sign/store-claims/${photo}?token=t1`, error: null }]) }));
    await view(page, 'orders');
    await page.locator('#tab-store .filter-pill', { hasText: 'All' }).click();
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1001' }).click();
    const sh = sheet(page);
    await expect(sh.locator('.sto-rt', { hasText: 'squeaks' })).toBeVisible();
    await expect(sh.locator('.sto-pics img[src*="token=t1"]')).toHaveCount(2); // the claim's and the return's
    await sh.locator('button', { hasText: 'Answer the claim' }).click();
    const d = dlg(page);
    await expect(d.locator('#sto-dlg-t')).toHaveText('Warranty claim · MM-1001');
    await d.locator('button', { hasText: 'Not covered' }).click();
    await expect(d.locator('.sto-err')).toContainText('Write the reply');
    expect(calls(seen, 'staff_store_after_claim_set')).toHaveLength(0);
    await d.locator('#sto-cl-reply').fill('Brake pads wear with use.');
    await d.locator('button', { hasText: 'Not covered' }).click();
    await expect.poll(() => calls(seen, 'staff_store_after_claim_set').length).toBe(1);
    expect(calls(seen, 'staff_store_after_claim_set')[0].body).toEqual({ p_id: 'cl1', p_state: 'refused', p_reply: 'Brake pads wear with use.', p_note: null });
    await expect(sh.locator('.sto-rt', { hasText: 'squeaks' })).toContainText('Not covered');
  });

  test('Ready for pickup is pushed to the customer who asked (store.push.on), through the push sender\'s store branch', async ({ page }) => {
    const o = order('o1', 1001, 'paid');
    const sent: Record<string, unknown>[] = [];
    await staff(page, { 'rpc:staff_store_orders': [o], store_products: products, store_variants: variants, site_content: [{ key: 'store.push.on', value: true, updated_at: NOW }],
      'rpc:staff_store_after_order': after({ push: true, push_to: { customer_id: 'c1', url: `/store/order/1001?k=${KEY}` } }), 'rpc:staff_store_order_set': { ...o, status: 'ready' } });
    await page.route('**/api/push-send', (r: Route) => { sent.push(r.request().postDataJSON()); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, sent: 1 }) }); });
    await view(page, 'orders');
    await expect.poll(() => page.evaluate(`_stoKey('store.push.on')`)).toBe(true);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1001' }).click();
    await sheet(page).locator('button', { hasText: 'Ready for pickup' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toEqual({ store: true, staffToken: 'tok-staff', customerId: 'c1', title: 'Ready for pickup', message: 'Order MM-1001 is ready at the showroom',
      url: `/store/order/1001?k=${KEY}`, tag: 'order-1001', lang: 'en' });
  });

  test('with the switch off nothing is pushed, and a database without the after-sale functions shows the sheet as before', async ({ page }) => {
    const o = order('o1', 1001, 'paid');
    const sent: unknown[] = [];
    const gone = { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_store_after_order in the schema cache' } };
    await staff(page, { 'rpc:staff_store_orders': [o], store_products: products, store_variants: variants, 'rpc:staff_store_after_order': gone,
      'rpc:staff_store_after_queue': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_store_after_queue in the schema cache' } },
      'rpc:staff_store_order_set': { ...o, status: 'ready' } });
    await page.route('**/api/push-send', (r: Route) => { sent.push(1); return r.fulfill({ status: 200, body: '{}' }); });
    await view(page, 'orders');
    await expect(page.locator('#tab-store .sto-views .filter-pill', { hasText: 'Warranty claims' })).toHaveCount(0);
    await page.locator('#tab-store .sto-row', { hasText: 'MM-1001' }).click();
    const sh = sheet(page);
    await expect(sh.locator('button', { hasText: 'Photos and checks' })).toHaveCount(0);
    await sh.locator('button', { hasText: 'Ready for pickup' }).click();
    await expect(page.locator('#toast-container')).toContainText('MM-1001');
    await page.waitForTimeout(300);
    expect(sent).toHaveLength(0);
  });
});

test.describe('@staff:store I\'m here and the warranty claims queue (N14 N31)', () => {
  test('an arrival shows at the top of Orders and on the rail; the claims queue moves a claim to In progress', async ({ page }) => {
    const seen = rpcCalls(page);
    const q = { arrivals: [{ order_id: 'o1', no: 1001, name: 'Huda Buyer', at: '2026-11-18T13:42:00Z', car: 'White Camry', seen_at: null, seen_by: null, slot: null, handover: { day: '2026-11-18', at: '16:40', to: '17:00' } }],
      claims: [{ id: 'cl1', order_id: 'o1', no: 1001, name: 'Huda Buyer', item: 'DA54 MAX', variant: 'M · Black', state: 'open', body: 'The rear brake squeaks after rain.', photos: [], created_at: NOW }] };
    await staff(page, { 'rpc:staff_store_orders': [order('o1', 1001, 'ready')], 'rpc:staff_store_after_queue': q, 'rpc:staff_store_after_order': after(),
      'rpc:staff_store_after_claim_set': after({ claims: [{ ...q.claims[0], state: 'in_progress' }] }) });
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="store"] .sto-arr-badge')).toHaveText('1');
    await view(page, 'orders');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('.sto-arr')).toContainText('Here now');
    await expect(sec.locator('.sto-arr-r')).toContainText('White Camry');
    await expect(sec.locator('.sto-arr-r')).toContainText('Handover 16:40'); // the handover booked (B8 added it to the queue's arrivals)
    await expect(sec.locator('.sto-views .filter-pill', { hasText: 'Warranty claims' }).locator('.tab-badge')).toHaveText('1');
    await sec.locator('.sto-views .filter-pill', { hasText: 'Warranty claims' }).click();
    expect(new URL(page.url()).pathname).toBe('/store/warranty');
    await expect(sec.locator('.sto-row')).toContainText('squeaks');
    await sec.locator('.sto-row', { hasText: 'squeaks' }).click();
    await dlg(page).locator('#sto-cl-note').fill('Bled the brakes on Saturday');
    await dlg(page).locator('button', { hasText: 'In progress' }).click();
    await expect.poll(() => calls(seen, 'staff_store_after_claim_set').length).toBe(1);
    expect(calls(seen, 'staff_store_after_claim_set')[0].body).toEqual({ p_id: 'cl1', p_state: 'in_progress', p_reply: null, p_note: 'Bled the brakes on Saturday' });
    await expect(sec.locator('.sto-row', { hasText: 'squeaks' })).toContainText('In progress');
  });
});

test.describe('@staff:store Settings: the 2026-11-18 keys (Store > Settings since 2026-11-19)', () => {
  test('handover hours past midnight, Ramadan, the order-by date, the switches and numbers are written as the website reads them', async ({ page }) => {
    const sc = writes(page, 'site_content');
    await staff(page, { site_content: [{ key: 'store.checkup', value: { on: true, weeks: 12 }, updated_at: NOW }] });
    await page.evaluate(`S.stoView='settings';setStaffTab('store')`);
    const sec = page.locator('#tab-store');
    await sec.locator('#ps-co').check();
    await sec.locator('#ps-ho').check();
    await sec.locator('#ps-hoc').fill('2');
    await sec.locator('button', { hasText: 'Add a time' }).nth(1).click(); // the handover's
    const ho = sec.locator('[aria-labelledby="ps-h6"]');
    await ho.locator('input[aria-label="Time 2, from"]').fill('21:00');
    await ho.locator('input[aria-label="Time 2, to"]').fill('01:00'); // past midnight
    await sec.locator('#ps-rm').check();
    await sec.locator('#ss-save').click();
    await expect(page.locator('#toast-container')).toContainText('Ramadan');
    expect(sc).toHaveLength(0);
    await sec.locator('#ps-rmf').fill('2027-02-08');
    await sec.locator('#ps-rmt').fill('2027-03-09');
    await sec.locator('button', { hasText: 'Add a time' }).nth(3).click(); // Ramadan's handover times
    const rh = sec.locator('[aria-labelledby="ps-rmh-l"]');
    await rh.locator('input[aria-label="Time 1, from"]').fill('21:00');
    await rh.locator('input[aria-label="Time 1, to"]').fill('01:00');
    await sec.locator('#ps-obe').fill('Eid');
    await sec.locator('#ps-obd').fill('2027-03-10');
    await sec.locator('#ps-obp').fill('2027-03-12'); // after the occasion
    await sec.locator('#ss-save').click();
    await expect(page.locator('#toast-container')).toContainText('Order-by date');
    await sec.locator('#ps-obp').fill('2027-03-07');
    await sec.locator('#ps-ckw').fill('8');
    await sec.locator('#ps-sc').uncheck();
    await sec.locator('#ps-push').check();
    await sec.locator('#ps-qd').fill('10');
    await sec.locator('#ss-save').click();
    await expect.poll(() => sc.length).toBeGreaterThan(0);
    const by = Object.fromEntries((sc[0].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    expect(by).toMatchObject({
      'store.company.on': true, 'store.push.on': true, 'store.quoteDays': 10,
      'store.handover': { on: true, minutes: 20, cap: 2, ahead: 6, skip: [5], hours: [{ from: '16:00', to: '21:00' }, { from: '21:00', to: '01:00' }] },
      'store.ramadan': { on: true, from: '2027-02-08', to: '2027-03-09', times: [], hours: [{ from: '21:00', to: '01:00' }] },
      'store.orderBy': { en: 'Eid', ar: 'Eid', day: '2027-03-10', by: { pickup: '2027-03-07' } },
      'store.checkup': { on: true, weeks: 8 }, 'store.slotChange': { on: false, hours: 24, max: 2 } });
    for (const k of ['store.pin.on', 'store.learning.on', 'store.giftCardWallet.on', 'store.sessionHandover']) expect(by).not.toHaveProperty(k); // untouched: left as they are
  });
});

test.describe('@staff:store products: the fleet bike (N25) and the photos\' copies (P09)', () => {
  const used = { id: 'pr9', slug: 'max-used', category: 'bikes', kind: 'item', condition: 'certified', name_en: 'DA54 MAX ex-rental', name_ar: null, price: 3000, published: true, sort: 0,
    images: [], specs: [], ship_ksa: false, warranty_months: 12, fleet_bike_id: null };
  const fleet = [{ id: 'b7', bike_number: 7, name: 'Fleet Seven', brand: 'Alvas', model: 'TT', size: 'M', type: 'Road', status: 'available' }];

  test('a certified product names its fleet bike; a new one cannot', async ({ page }) => {
    const pw = writes(page, 'store_products');
    await staff(page, { store_products: [used], store_variants: [{ id: 'v9', product_id: 'pr9', size: 'M', stock: 1, active: true, price: null, sort: 0 }], bikes: fleet });
    await view(page, 'products');
    await expect.poll(() => page.evaluate('(S._sto.prods||[]).length')).toBe(1);
    await page.evaluate(`_stoPeOpen('pr9')`);
    const pe = page.locator('#sto-pe [role="dialog"]');
    await pe.locator('#sto-pe-fleet').selectOption('b7');
    await expect(pe.locator('#sto-pe-fleet option[value="b7"]')).toHaveText('#7 · Fleet Seven · Alvas TT · M');
    await pe.locator('button', { hasText: 'Save' }).click();
    await expect.poll(() => pw.filter((w) => w.method === 'PATCH').length).toBe(1);
    expect(pw.find((w) => w.method === 'PATCH')!.body).toMatchObject({ fleet_bike_id: 'b7', condition: 'certified' });
    await expect(pe).toHaveCount(0); // saved and closed
    await page.evaluate(`_stoPeOpen('pr9')`);
    await pe.locator('#sto-pe-fleet').selectOption('b7');
    await pe.locator('#sto-pe-condition').selectOption('new');
    await expect(pe.locator('#sto-pe-fleet')).toHaveCount(0);
    await pe.locator('#sto-pe-warranty').fill('24');
    await pe.locator('button', { hasText: 'Save' }).click();
    await expect.poll(() => pw.filter((w) => w.method === 'PATCH').length).toBe(2);
    expect(pw.filter((w) => w.method === 'PATCH')[1].body).toMatchObject({ fleet_bike_id: null, condition: 'new' });
  });

  test('a database without the column: no picker and nothing written for it', async ({ page }) => {
    const pw = writes(page, 'store_products');
    const { fleet_bike_id: _drop, ...noCol } = used; void _drop;
    await staff(page, { store_products: [noCol], store_variants: [], bikes: fleet });
    await view(page, 'products');
    await expect.poll(() => page.evaluate('(S._sto.prods||[]).length')).toBe(1);
    await page.evaluate(`_stoPeOpen('pr9')`);
    const pe = page.locator('#sto-pe [role="dialog"]');
    await expect(pe.locator('#sto-pe-fleet')).toHaveCount(0);
    await pe.locator('button', { hasText: 'Save' }).click();
    await expect.poll(() => pw.filter((w) => w.method === 'PATCH').length).toBe(1);
    expect(pw[0].body).not.toHaveProperty('fleet_bike_id');
  });

  test('a product photo is uploaded with its 1600 / 1280 / 640 / 320 copies; a small one gets none over 1280; Resize photos writes only the missing copies', async ({ page }) => {
    const up: string[] = [];
    await staff(page, { store_products: [{ ...used, images: ['/media/store/pr9/old1.jpg'] }], store_variants: [], bikes: fleet });
    await page.route('**/storage/v1/object/site/**', (r: Route) => { up.push(new URL(r.request().url()).pathname.replace(/^.*\/object\/site\//, '')); return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ Key: 'k', Id: 'i' }) }); });
    await page.route('**/storage/v1/object/list/site', (r: Route) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify([{ name: 'old1.jpg' }, { name: 'old1.w640.webp' }, { name: 'old1.w1280.webp' }]) }));
    await page.route('**/storage/v1/object/site/store/pr9/old1.jpg', async (r: Route) => {
      if (r.request().method() !== 'GET') return r.fallback();
      const b64 = await page.evaluate(`(async()=>{const c=document.createElement('canvas');c.width=1800;c.height=1200;c.getContext('2d').fillRect(0,0,9,9);const b=await new Promise(r=>c.toBlob(r,'image/jpeg',.8));const a=new Uint8Array(await b.arrayBuffer());let s='';a.forEach(x=>s+=String.fromCharCode(x));return btoa(s);})()`);
      return r.fulfill({ status: 200, headers: { 'content-type': 'image/jpeg', 'access-control-allow-origin': '*' }, body: Buffer.from(String(b64), 'base64') });
    });
    const sizes = await page.evaluate(`(async()=>{const mk=async(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').fillRect(0,0,9,9);const b=await new Promise(r=>c.toBlob(r,'image/jpeg',.8));return new File([b],'p.jpg',{type:'image/jpeg'});};
      const a=await _catUploadImage(await mk(2400,1600),'store/pr9',STO_IMG_W);const b=await _catUploadImage(await mk(800,600),'store/pr9',STO_IMG_W);return [a,b];})()`) as string[];
    expect(sizes[0]).toMatch(/^\/media\/store\/pr9\/[a-z0-9-]+\.jpg$/);
    const base0 = sizes[0].slice('/media/'.length).replace(/\.jpg$/, ''), base1 = sizes[1].slice('/media/'.length).replace(/\.jpg$/, '');
    expect(up.filter((p) => p.startsWith(base0 + '.')).sort()).toEqual([base0 + '.jpg', base0 + '.w1280.webp', base0 + '.w1600.webp', base0 + '.w320.webp', base0 + '.w640.webp'].sort());
    expect(up.filter((p) => p.startsWith(base1 + '.')).sort()).toEqual([base1 + '.jpg', base1 + '.w1280.webp', base1 + '.w320.webp', base1 + '.w640.webp'].sort());
    up.length = 0;
    await view(page, 'products');
    await expect.poll(() => page.evaluate('(S._sto.prods||[]).length')).toBe(1);
    await page.locator('#tab-store .sto-head-acts button', { hasText: 'Resize photos' }).click();
    await expect(page.locator('#toast-container')).toContainText('Photos resized: 1');
    expect(up.sort()).toEqual(['store/pr9/old1.w1600.webp', 'store/pr9/old1.w320.webp']);
  });
});

test.describe('@staff:store the push sender\'s store branch (N04)', () => {
  const realFetch = globalThis.fetch;
  test.afterEach(() => { globalThis.fetch = realFetch; });

  test('a store order\'s status: the Store\'s staff, only to the account that asked for that order, whatever "My rides" says', async () => {
    const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const priv = Buffer.from(await crypto.subtle.exportKey('pkcs8', vapid.privateKey)).toString('base64url');
    const pub = Buffer.from(await crypto.subtle.exportKey('raw', vapid.publicKey)).toString('base64url');
    const sub = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', sub.publicKey)).toString('base64url');
    const auth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    const mods: unknown[] = [], hits: string[] = [], lookups: string[] = [];
    let asked = true;
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      if (url.includes('/rpc/_staff_mod')) { mods.push(JSON.parse(String(init?.body))); return new Response('true'); }
      if (url.includes('/auth/v1/user')) return new Response(JSON.stringify({ id: '0f8fad5b-d9cb-469f-a165-70867728950e' }));
      if (url.includes('/rest/v1/staff_actions') && init?.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': '*/0' } });
      if (url.includes('/rest/v1/staff_actions')) return new Response(null, { status: 201 });
      if (url.includes('/rest/v1/store_orders')) { lookups.push(url); return new Response(JSON.stringify(url.includes(`track_key=eq.${KEY}`) ? [{ id: 'o1' }] : [])); }
      if (url.includes('/rest/v1/store_after_push')) { lookups.push(url); return new Response(JSON.stringify(asked ? [{ order_id: 'o1' }] : [])); }
      if (url.includes('/rest/v1/push_prefs')) return new Response(JSON.stringify([{ rides: false }]));
      if (url.includes('/rest/v1/push_subscriptions')) return new Response(JSON.stringify([{ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh, auth }]));
      hits.push(url);
      return new Response('', { status: 201 });
    }) as typeof fetch;
    const post = (await freshModule('functions/api/push-send.js')).onRequestPost as (c: { request: Request; env: Record<string, string> }) => Promise<Response>;
    const send = async (extra: Record<string, unknown>) => {
      hits.length = 0;
      const res = await post({ request: new Request('https://staff.micromobility.sa/api/push-send', { method: 'POST', body: JSON.stringify({ staffToken: 'st', customerId: 'c1', title: 'Ready for pickup', message: 'Order MM-1001 is ready', ...extra }) }),
        env: { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv, SUPABASE_SERVICE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon', SUPABASE_URL: 'https://db.test' } });
      return { status: res.status, body: await res.json() };
    };
    const ok = await send({ store: true, url: `/store/order/1001?k=${KEY}`, tag: 'order-1001' });
    expect(ok.body).toMatchObject({ ok: true, sent: 1 }); // "My rides" off does not stop it: the order's own switch decides
    expect(mods).toEqual([{ p_mod: 'store', p_edit: true }]);
    expect(lookups[0]).toContain(`store_orders?no=eq.1001&track_key=eq.${KEY}`);
    expect(lookups[1]).toContain('store_after_push?order_id=eq.o1&customer_id=eq.c1');
    expect(hits).toEqual(['https://fcm.googleapis.com/fcm/send/abc']);
    asked = false;
    expect((await send({ store: true, url: `/store/order/1001?k=${KEY}` })).body).toMatchObject({ ok: true, sent: 0, reason: 'not asked' });
    expect(hits).toEqual([]);
    expect((await send({ store: true, url: `/store/order/1001?k=${'f'.repeat(32)}` })).body).toMatchObject({ ok: true, sent: 0, reason: 'not asked' });
    expect((await send({ store: true, url: '/my-bookings' })).status).toBe(400); // only an order's page
    expect((await send({ store: true, url: `https://evil.example/store/order/1001?k=${KEY}` })).status).toBe(400);
    // a booking push is unchanged: the Bookings' right, and "My rides" off stops it
    mods.length = 0;
    expect((await send({ url: '/' })).body).toMatchObject({ ok: true, sent: 0, reason: 'rides off' });
    expect(mods).toEqual([{ p_mod: 'queue', p_edit: true }]);
  });
});

test.describe('@staff:store a store order\'s pickup pass scanned at the desk (B4: MMO-<no>-<key>)', () => {
  test('the right key opens the order\'s sheet; a wrong one says no store order matches', async ({ page }) => {
    const o = order('o1', 1001, 'ready');
    await staff(page, { 'rpc:staff_store_orders': [o], store_orders: [{ id: 'o1', no: 1001, track_key: KEY }], 'rpc:staff_store_after_order': after() });
    await page.evaluate(`_onScanPayload('MMO-1001-${KEY.slice(0, 6)}')`);
    await expect(sheet(page).locator('#sto-sh-t')).toContainText('MM-1001');
    await page.evaluate(`_stoClose()`);
    await page.evaluate(`_onScanPayload('MMO-1001-ffffff')`);
    await expect(page.locator('#toast-container')).toContainText('No store order matches this code.');
  });
});
