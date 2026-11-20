import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The Marketplace section's second half (MK-S2, 2026-11-20; migration 20261121300000): the staff views Shops, Our
// listings, Commission, Settings and Categories, and what each asks of the database (the staff_market_* functions, the
// market_categories table, site_content) and of the site bucket (our own listings' photos). All traffic is stubbed and
// the data is invented. The section's frame (the rail, renderMarket, the view pills) is the first half's: here a
// stand-in in the page draws one view at a time through the ten names the two halves meet at.

const NOW = '2026-11-20T09:00:00Z';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
type Body = Record<string, unknown>;
type Call = { name: string; body: Body };

const shop = (id: number, status: string, x: Body = {}) => ({
  id, owner_id: 'c' + id, slug: 'pedal-house-' + id, name_en: 'Pedal House ' + id, name_ar: null, cr_no: '101000000' + id, cr_activity: 'Retail sale of bicycles',
  vat_no: null, city: 'jeddah', address: 'Prince Sultan Road', map_url: 'https://maps.app.goo.gl/abc123', phone: '966126000001', whatsapp: '966501112233',
  about_en: 'Bikes and parts.', about_ar: null, returns_en: 'Seven days, unused.', returns_ar: null, sells: 'Road and gravel bikes', logo: null, status,
  decided_by: null, decided_at: null, decision_note: null, approved_at: null, agreement_version: '2026-11-21', agreement_at: NOW, created_at: NOW, updated_at: NOW,
  owner_name: 'Owner ' + id, owner_phone: '+96650000000' + id, live: 0, ...x,
});
const shops = [
  shop(1, 'approved', { name_en: 'Anchor Cycles', approved_at: NOW, decided_by: 'Spec Staff', decided_at: NOW, live: 4 }),
  shop(2, 'pending', { name_en: 'Zed Sports', created_at: '2026-11-19T09:00:00Z' }),
  shop(3, 'pending', { name_en: 'Yalla Run', created_at: '2026-11-18T09:00:00Z', vat_no: '300000000000003', name_ar: 'يلا رن' }),
  shop(4, 'suspended', { name_en: 'Bay Riders', decision_note: 'Counterfeit items', decided_by: 'Spec Staff', decided_at: NOW }),
  shop(5, 'rejected', { name_en: 'Old Wheel', decision_note: 'The registration number does not match' }),
];

const cat = (slug: string, parent: string | null, name_en: string, name_ar: string, sort: number, x: Body = {}) => ({
  slug, parent, name_en, name_ar, sort, visible: true, tier: 'open', needs_serial: false, min_photos: 1, facts: [], updated_at: NOW, ...x,
});
const cats = [
  cat('running', null, 'Running', 'الجري', 20),
  cat('cycling', null, 'Cycling', 'الدراجات الهوائية', 10),
  cat('cycling-helmets', 'cycling', 'Helmets', 'الخوذات', 30, { tier: 'new_only', facts: ['brand', 'model', 'size'] }),
  cat('cycling-bike-road', 'cycling', 'Road bikes', 'دراجات الطريق', 10, { needs_serial: true, min_photos: 3, facts: ['brand', 'model', 'year', 'frame_size', 'wheel_size'] }),
  cat('cycling-bike-electric', 'cycling', 'E-bikes', 'الدراجات الكهربائية', 20, { tier: 'declare', needs_serial: true, min_photos: 3, facts: ['brand', 'model', 'year', 'frame_size', 'wheel_size'] }),
  cat('running-shoes', 'running', 'Shoes', 'الأحذية', 10, { facts: ['brand', 'model', 'size', 'for_whom'] }),
  cat('running-old', 'running', 'Old gear', 'معدات قديمة', 20, { visible: false }),
];

const row = (id: number, status: string, x: Body = {}) => ({
  id, title: 'Road bike ' + id, price: 2000 + id, status, hold_reason: null, seller_kind: 'company', customer_id: null, customer_name: null, customer_phone: null,
  shop_id: null, shop_name: null, category: 'cycling-bike-road', city: 'jeddah', photo: '/media/market/p' + id + '.jpg', photos: 3, reports_open: 0, checked_at: null,
  published_at: status === 'draft' ? null : NOW, expires_at: status === 'draft' ? null : new Date(Date.now() + 40 * 864e5).toISOString(), updated_at: NOW, ...x,
});
const ours = [
  row(11, 'draft', { title: null, price: null, photo: null, photos: 0 }),
  row(12, 'live', { expires_at: new Date(Date.now() + 3 * 864e5).toISOString() }),
  row(13, 'reserved'),
  row(14, 'sold'),
  row(15, 'expired', { expires_at: new Date(Date.now() - 864e5).toISOString() }),
];
const full = (id: number, status: string, x: Body = {}) => ({
  id, seller_kind: 'company', customer_id: null, shop_id: null, category: 'cycling-bike-road', title: 'Road bike ' + id, description: 'A well kept aluminium road bike.',
  condition: 'good', faults: null, price: 2000 + id, negotiable: true, city: 'riyadh', facts: { brand: 'Velo', year: 2022, wheel_size: '700c' }, serial: 'WTU123456',
  declarations: {}, name_mode: null, display_name: null, photos: ['/media/market/a.jpg', '/media/market/b.jpg', '/media/market/c.jpg'], status, hold_reason: null,
  published_at: NOW, expires_at: new Date(Date.now() + 40 * 864e5).toISOString(), ...x,
});

// The day in Riyadh, and three sale days: this month, the month before, and two years back.
const ksa = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const Y = Number(ksa.slice(0, 4)), M = Number(ksa.slice(5, 7));
const thisMonth = ksa.slice(0, 7) + '-15T09:00:00Z';
const lastMonth = (M === 1 ? `${Y - 1}-12` : `${Y}-${String(M - 1).padStart(2, '0')}`) + '-15T09:00:00Z';
const longAgo = `${Y - 2}-06-15T09:00:00Z`;
const com = (listing_id: number, sold_at: string, sold_price: number, due: number, x: Body = {}) => ({
  listing_id, title: 'Sold item ' + listing_id, seller_kind: 'private', customer_id: 'c' + listing_id, customer_name: 'Seller ' + listing_id, customer_phone: '+96650000010' + listing_id,
  shop_name: null, sold_at, sold_price, commission_pct: 1, commission_due: due, received: false, received_at: null, received_by: null, note: null, ...x,
});
const commission = {
  items: [
    com(31, thisMonth, 2000, 20),
    com(32, thisMonth, 500, 5, { received: true, received_at: NOW, received_by: 'Spec Staff', note: 'Cash at the hub' }),
    com(33, lastMonth, 10000, 100, { seller_kind: 'shop', shop_name: 'Anchor Cycles' }),
    com(34, longAgo, 3000, 30),
  ],
  total: 4, due_sum: 150, received_sum: 5,
};

const limits = { new_days: 14, new: { live: 2, price_max: 3000, threads_day: 5, wa_day: 0 }, established: { live: 10, threads_day: 20, wa_day: 10 }, shop: { live_first: 20, first_days: 14, live: 200 }, messages_day: 200 };
const content = [
  { key: 'marketplace.on', value: false, updated_at: NOW },
  { key: 'marketplace.commission_pct', value: 1, updated_at: NOW },
  { key: 'marketplace.commission_how', value: { en: 'Transfer it to our account.', ar: 'حوّلها إلى حسابنا.' }, updated_at: NOW },
  { key: 'marketplace.limits', value: limits, updated_at: NOW },
  { key: 'marketplace.listing_days', value: 60, updated_at: NOW },
  { key: 'marketplace.blocked_words', value: ['airsoft', 'pepper spray'], updated_at: NOW },
  { key: 'marketplace.auto_hold_reports', value: 3, updated_at: NOW },
];

function rpcCalls(page: Page) {
  const seen: Call[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (!m || r.method() !== 'POST') return;
    let body: Body = {}; try { body = r.postDataJSON() || {}; } catch { /* none */ }
    seen.push({ name: m[1], body });
  });
  return seen;
}
const of = (calls: Call[], name: string) => calls.filter((c) => c.name === name);
function writes(page: Page, table: string) {
  const seen: { method: string; body: unknown }[] = [];
  page.on('request', (r) => {
    if (!r.url().includes(`/rest/v1/${table}`) || !['POST', 'PATCH', 'DELETE'].includes(r.method())) return;
    let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
    seen.push({ method: r.method(), body });
  });
  return seen;
}
// One function answered from what it was sent (the stub's fixtures answer the same whatever is asked).
async function answer(page: Page, name: string, fn: (body: Body) => unknown) {
  await page.route(`**/rest/v1/rpc/${name}`, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    let body: Body = {}; try { body = req.postDataJSON() || {}; } catch { /* none */ }
    const out = fn(body) as { __rpcError?: Body } | null;
    if (out && typeof out === 'object' && out.__rpcError) {
      return route.fulfill({ status: Number(out.__rpcError.status) || 400, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ code: out.__rpcError.code ?? 'P0001', message: out.__rpcError.message, details: null, hint: null }) });
    }
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(out) });
  });
}
const refuse = (message: string) => ({ __rpcError: { status: 400, code: 'P0001', message } });
// The site bucket, answered here: what was stored is kept, or the bucket's refusal for an account that is not an admin.
async function bucket(page: Page, allow = true) {
  const stored: { method: string; path: string }[] = [];
  await page.route('**/storage/v1/object/site**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 200, headers: CORS });
    stored.push({ method: req.method(), path: new URL(req.url()).pathname.replace(/^.*\/object\/site\/?/, '') });
    if (!allow && req.method() === 'POST') return route.fulfill({ status: 400, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }) });
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(req.method() === 'DELETE' ? [] : { Key: 'site/x', Id: 'x' }) });
  });
  return stored;
}
// MK-S1's frame, stood in for (the registry is the first half's): the section's panel, _mkPaint drawing the view on
// screen, _mkCount counted, and __mkOpen doing what the frame does when a view is opened: Load, then paint.
async function frame(page: Page) {
  await page.addStyleTag({ content: '#view-staff .tab-panel:not(#tab-market){display:none!important}#tab-market{display:block!important}' });
  await page.evaluate(`(()=>{
    let p=document.getElementById('tab-market');
    if(!p){p=document.createElement('div');p.id='tab-market';p.className='tab-panel';document.getElementById('tab-testimonials').after(p);}
    const V={shops:[_mkShopsHtml,_mkShopsLoad],ours:[_mkOursHtml,_mkOursLoad],commission:[_mkComHtml,_mkComLoad],settings:[_mkSetHtml,_mkSetLoad],cats:[_mkCatsHtml,_mkCatsLoad]};
    window.__mkV='shops';window.__mkCounts=0;
    window._mkPaint=function(){p.innerHTML='<h1 class="page-title">Marketplace</h1><div class="form-section ws-mt0">'+V[window.__mkV][0]()+'</div>';};
    window._mkCount=function(){window.__mkCounts++;};
    window.__mkOpen=function(k,force){window.__mkV=k;window._mkPaint();return Promise.resolve(V[k][1](!!force)).then(()=>{window._mkPaint();});};
  })()`);
}
const open = (page: Page, view: string, force = false) => page.evaluate(`window.__mkOpen(${JSON.stringify(view)},${force})`);
async function staff(page: Page, fx: Fixtures = {}, role = 'admin') {
  const ops = [{ name: 'Spec Staff', has_pin: false }];
  await stubSupabase(page, {
    sessions: [], queue_entries: [], bikes: [], customers: [], staff_options: [], 'rpc:staff_operator_list': ops, market_categories: cats, site_content: content, site_content_history: [],
    'rpc:staff_market_shops': { items: shops, total: shops.length }, 'rpc:staff_market_listings': { items: ours, total: ours.length }, 'rpc:staff_market_commission': commission, ...fx,
  });
  await unlockStaff(page);
  await page.goto('/?staff');
  await waitForSb(page);
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S.staffRole=${JSON.stringify(role)};renderStaffTabs();`);
  await frame(page);
}
const panel = (page: Page) => page.locator('#tab-market');
const pop = (page: Page) => page.locator('#mks-pop [role="dialog"]');
const rowOf = (page: Page, id: string | number) => page.locator(`#tab-market .mks-row[data-mks="${id}"]`);
const confirmBox = (page: Page) => page.locator('#confirm-modal .confirm-box');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.describe('@staff:market Shops', () => {
  test('the applications waiting come first, the longest wait on top, and each status has its number', async ({ page }) => {
    await staff(page);
    await open(page, 'shops');
    const names = await panel(page).locator('.mks-row .mks-name bdi:first-child').allTextContents();
    expect(names).toEqual(['Yalla Run', 'Zed Sports', 'Anchor Cycles', 'Bay Riders', 'Old Wheel']);
    await expect(rowOf(page, 3).locator('.mks-pill')).toHaveText('Waiting');
    await expect(panel(page).locator('.filter-pill')).toHaveText(['All (5)', 'Waiting (2)', 'Approved (1)', 'Suspended (1)', 'Rejected (1)']);
    await panel(page).locator('.filter-pill', { hasText: 'Suspended' }).click();
    await expect(panel(page).locator('.mks-row')).toHaveCount(1);
    await expect(rowOf(page, 4)).toContainText('Bay Riders');
    // the search reads the name, the CR number, the owner and the phone
    await panel(page).locator('.filter-pill', { hasText: 'All' }).click();
    await page.evaluate(`_mksQ('sh','1010000003')`);
    await expect(panel(page).locator('.mks-row')).toHaveCount(1);
    await expect(rowOf(page, 3)).toContainText('CR 1010000003');
  });

  test('an application opened shows every field; Approve asks first, then the shop is approved and the frame counts again', async ({ page }) => {
    await staff(page);
    const calls = rpcCalls(page);
    await answer(page, 'staff_market_shop_set', (b) => ({ shop: { ...shop(3, 'approved', { name_en: 'Yalla Run', name_ar: 'يلا رن', approved_at: NOW, decided_by: 'Spec Staff', decided_at: NOW }), sent: b.p_action } }));
    await open(page, 'shops');
    await rowOf(page, 3).getByRole('button', { name: 'Open' }).click();
    const d = pop(page);
    await expect(d).toBeVisible();
    await expect(d.locator('#mks-pop-t')).toHaveText('Yalla Run');
    for (const label of ['Status', 'Logo', 'Name (English)', 'Name (Arabic)', 'Shop page address', 'Commercial registration number', 'Registered activity', 'VAT number', 'City', 'Address', 'Map link', 'Phone',
      'WhatsApp', 'What it sells', 'About (English)', 'About (Arabic)', 'Return terms (English)', 'Return terms (Arabic)', 'Owner', 'Listings on sale', 'Applied', 'Rules accepted', 'First approved', 'Last decision', 'Reason (the owner reads it)']) {
      await expect(d.locator('.mks-kv dt', { hasText: new RegExp('^' + label.replace(/[()]/g, '\\$&') + '$') })).toHaveCount(1);
    }
    const val = (label: string) => d.locator('.mks-kv', { has: page.locator('dt', { hasText: new RegExp('^' + label + '$') }) }).locator('dd');
    await expect(val('Commercial registration number')).toHaveText('1010000003');
    await expect(val('VAT number')).toHaveText('300000000000003');
    await expect(val('City')).toHaveText('Jeddah');
    await expect(val('Phone')).toHaveText('+966126000001');
    await expect(val('Owner')).toContainText('Owner 3');
    await expect(val('First approved')).toHaveText('—');
    await expect(d.getByRole('button', { name: 'Suspend' })).toHaveCount(0);
    await d.getByRole('button', { name: 'Approve' }).click();
    await expect(confirmBox(page)).toContainText('Approve Yalla Run?');
    expect(of(calls, 'staff_market_shop_set')).toHaveLength(0);
    await confirmBox(page).getByRole('button', { name: 'Approve' }).click();
    await expect.poll(() => of(calls, 'staff_market_shop_set').length).toBe(1);
    expect(of(calls, 'staff_market_shop_set')[0].body).toEqual({ p_shop: 3, p_action: 'approve', p: {} });
    await expect(d.locator('.mks-kv .mks-pill')).toHaveText('Approved');
    await expect(d.getByRole('button', { name: 'Suspend' })).toBeVisible();
    await expect(rowOf(page, 3).locator('.mks-pill')).toHaveText('Approved');
    expect(await page.evaluate('window.__mkCounts')).toBe(1);
  });

  test('Reject takes a reason the owner reads; Suspend too, and Restore puts a shop back', async ({ page }) => {
    await staff(page);
    const calls = rpcCalls(page);
    await answer(page, 'staff_market_shop_set', (b) => {
      const id = Number(b.p_shop), to = { reject: 'rejected', suspend: 'suspended', restore: 'approved' }[String(b.p_action)] || 'pending';
      return { shop: { ...shops.find((s) => s.id === id), status: to, decision_note: (b.p as Body).note ?? null } };
    });
    await open(page, 'shops');
    await rowOf(page, 2).getByRole('button', { name: 'Open' }).click();
    const d = pop(page);
    await d.getByRole('button', { name: 'Reject' }).click();
    await expect(d.getByLabel('Reason (the owner reads it)')).toBeFocused();
    await d.getByRole('button', { name: 'Reject' }).click();
    await expect(d.locator('.mks-err')).toHaveText('Check this field: Reason (the owner reads it)');
    expect(of(calls, 'staff_market_shop_set')).toHaveLength(0);
    await d.getByLabel('Reason (the owner reads it)').fill('The registration number is not a shop');
    await d.getByRole('button', { name: 'Reject' }).click();
    await expect.poll(() => of(calls, 'staff_market_shop_set').length).toBe(1);
    expect(of(calls, 'staff_market_shop_set')[0].body).toEqual({ p_shop: 2, p_action: 'reject', p: { note: 'The registration number is not a shop' } });
    await expect(d.locator('.mks-kv .mks-pill')).toHaveText('Rejected');
    await d.getByRole('button', { name: 'Close' }).click();
    await expect(pop(page)).toHaveCount(0);
    // an approved shop is suspended with a reason, a suspended one restored
    await rowOf(page, 1).getByRole('button', { name: 'Open' }).click();
    await d.getByRole('button', { name: 'Suspend' }).click();
    await d.getByLabel('Reason (the owner reads it)').fill('Sold a stolen frame');
    await d.getByRole('button', { name: 'Suspend' }).click();
    await expect.poll(() => of(calls, 'staff_market_shop_set').length).toBe(2);
    expect(of(calls, 'staff_market_shop_set')[1].body).toEqual({ p_shop: 1, p_action: 'suspend', p: { note: 'Sold a stolen frame' } });
    await expect(d.locator('.mks-kv .mks-pill')).toHaveText('Suspended');
    await d.getByRole('button', { name: 'Restore' }).click();
    await expect.poll(() => of(calls, 'staff_market_shop_set').length).toBe(3);
    expect(of(calls, 'staff_market_shop_set')[2].body).toEqual({ p_shop: 1, p_action: 'restore', p: {} });
    await expect(d.locator('.mks-kv .mks-pill')).toHaveText('Approved');
  });

  test('Edit sends only what changed, a number as the database keeps it; a refusal is said in words', async ({ page }) => {
    await staff(page);
    const calls = rpcCalls(page);
    let dup = true;
    await answer(page, 'staff_market_shop_set', (b) => (dup ? refuse('MKT_DUP: cr') : { shop: { ...shops[0], ...(b.p as Body) } }));
    await open(page, 'shops');
    await rowOf(page, 1).getByRole('button', { name: 'Open' }).click();
    const d = pop(page);
    await d.getByRole('button', { name: 'Edit' }).click();
    await expect(d.getByLabel('Name (English)')).toHaveValue('Anchor Cycles');
    await expect(d.getByLabel('City')).toHaveValue('jeddah');
    // a value that does not fit is said before anything is sent
    await d.getByLabel('Commercial registration number').fill('12345');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(d.locator('.mks-err')).toHaveText('Check this field: Commercial registration number');
    expect(of(calls, 'staff_market_shop_set')).toHaveLength(0);
    await d.getByLabel('Commercial registration number').fill('1010999999');
    await d.getByLabel('WhatsApp').fill('050 111 2244');
    await d.getByLabel('Name (Arabic)').fill('أنكور للدراجات');
    await d.getByLabel('City').selectOption('riyadh');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(d.locator('.mks-err')).toHaveText('Another shop already has this commercial registration number.');
    expect(of(calls, 'staff_market_shop_set')[0].body).toEqual({ p_shop: 1, p_action: 'edit', p: { cr_no: '1010999999', whatsapp: '966501112244', name_ar: 'أنكور للدراجات', city: 'riyadh' } });
    dup = false;
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(d.locator('.mks-kv', { has: page.locator('dt', { hasText: /^City$/ }) }).locator('dd')).toHaveText('Riyadh');
    await expect(d.locator('.mks-err')).toHaveCount(0);
    // what was typed and not saved is asked about before the pop-up closes
    await d.getByRole('button', { name: 'Edit' }).click();
    await d.getByLabel('Address', { exact: true }).fill('Another street');
    await d.getByRole('button', { name: 'Close' }).click();
    await expect(confirmBox(page)).toContainText('Leave without saving?');
    await confirmBox(page).getByRole('button', { name: 'Keep editing' }).click();
    await expect(d.getByLabel('Address', { exact: true })).toHaveValue('Another street');
  });

  test('an account that may only look sees the shops and no way to change one', async ({ page }) => {
    await staff(page);
    await page.evaluate(`S._myEdit=['queue']`);
    await open(page, 'shops');
    await rowOf(page, 2).getByRole('button', { name: 'Open' }).click();
    await expect(pop(page).locator('.mks-kv')).not.toHaveCount(0);
    await expect(pop(page).locator('.chrome-dact button')).toHaveCount(0);
    await pop(page).getByRole('button', { name: 'Close' }).click();
    await open(page, 'ours');
    await expect(panel(page).getByRole('button', { name: 'New listing' })).toHaveCount(0);
    await expect(panel(page).locator('.mks-acts')).toHaveCount(0);
    await open(page, 'cats');
    await expect(panel(page).locator('.mks-acts')).toHaveCount(0);
    await open(page, 'commission');
    await expect(panel(page).locator('.mks-acts')).toHaveCount(0);
  });
});

test.describe('@staff:market Our listings', () => {
  test('each listing of ours offers what its status allows', async ({ page }) => {
    await staff(page);
    const calls = rpcCalls(page);
    await open(page, 'ours');
    expect(of(calls, 'staff_market_listings')[0].body).toEqual({ p: { kind: 'company', status: 'all', limit: 200, offset: 0 } });
    const acts = (id: number) => rowOf(page, id).locator('.mks-acts button').allTextContents();
    expect(await acts(11)).toEqual(['Edit', 'Publish', 'Remove']);
    expect(await acts(12)).toEqual(['Edit', 'Mark reserved', 'Mark sold', 'Renew', 'Remove']); // three days left: Renew
    expect(await acts(13)).toEqual(['Edit', 'Back to live', 'Mark sold', 'Remove']);
    expect(await acts(14)).toEqual(['Back to live', 'Remove']);
    expect(await acts(15)).toEqual(['Edit', 'Renew', 'Remove']);
    await expect(rowOf(page, 11)).toContainText('Untitled draft');
    await expect(rowOf(page, 12).locator('.mks-meta')).toContainText('Road bikes');
    await expect(rowOf(page, 12).locator('.mks-meta')).toContainText('SAR 2,012');
    await expect(panel(page).locator('.filter-pill')).toHaveText(['All (5)', 'Draft (1)', 'Live (1)', 'Reserved (1)', 'Sold (1)', 'Expired (1)']);
  });

  test('a new listing: the form follows the category, a photo goes to market/ of the site bucket, Publish saves then publishes', async ({ page }) => {
    await staff(page);
    const calls = rpcCalls(page), stored = await bucket(page);
    await answer(page, 'staff_market_company_save', (b) => ({ listing: full(21, 'draft', { ...(b.p as Body) }) }));
    await answer(page, 'staff_market_company_state', () => ({ listing: full(21, 'live') }));
    await open(page, 'ours');
    await panel(page).getByRole('button', { name: 'New listing' }).click();
    const d = pop(page);
    await expect(d.locator('#mks-pop-t')).toHaveText('New listing');
    await expect(d.getByLabel('City')).toHaveValue('jeddah');
    // only shown product types of shown sports are offered, under their sport
    await expect(d.locator('#mks-f-category optgroup')).toHaveCount(2);
    await expect(d.locator('#mks-f-category option[value="running-old"]')).toHaveCount(0);
    await expect(d.getByLabel('Frame or serial number')).toHaveCount(0);
    await d.getByLabel('Category').focus();
    await d.getByLabel('Category').selectOption('cycling-bike-electric');
    for (const l of ['Brand', 'Model', 'Year', 'Frame size', 'Wheel size', 'Frame or serial number']) await expect(d.getByLabel(l, { exact: true })).toBeVisible();
    // the form was drawn again for the category: the picker still has the focus, also once the dialogs' focus pass has run
    await page.waitForTimeout(120);
    await expect(d.getByLabel('Category')).toBeFocused();
    await expect(d.getByRole('group', { name: 'Declarations' }).getByRole('checkbox')).toHaveCount(4);
    await d.getByLabel('Category').selectOption('cycling-helmets');
    await expect(d.getByLabel('Size', { exact: true })).toBeVisible();
    await expect(d.getByLabel('Frame or serial number')).toHaveCount(0);
    await expect(d.getByRole('group', { name: 'Declarations' })).toHaveCount(0);
    await d.getByLabel('Title').fill('Aero road helmet');
    await d.getByLabel('Description').fill('New in its box, never worn.');
    await d.getByLabel('Condition').selectOption('new');
    await d.getByLabel('Price (SAR)').fill('350');
    await d.getByLabel('Brand').fill('Velo');
    await d.getByLabel('Size', { exact: true }).fill('M');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), d.getByRole('button', { name: 'Add photos' }).click()]);
    await chooser.setFiles({ name: 'helmet.png', mimeType: 'image/png', buffer: PNG });
    await expect(d.locator('.mks-ph1')).toHaveCount(1);
    await expect(d.locator('.mks-ph1')).toContainText('Cover');
    const main = stored.find((s) => s.method === 'POST' && /^market\/[a-z0-9-]+\.(jpg|png)$/.test(s.path));
    expect(main, 'the photo is stored under market/ of the site bucket').toBeTruthy();
    await d.getByRole('button', { name: 'Publish' }).click();
    await expect(pop(page)).toHaveCount(0);
    const save = of(calls, 'staff_market_company_save')[0].body;
    expect(save.p_listing).toBeNull();
    expect(save.p).toEqual({ category: 'cycling-helmets', title: 'Aero road helmet', description: 'New in its box, never worn.', condition: 'new', faults: null, price: 350, negotiable: false, city: 'jeddah',
      facts: { brand: 'Velo', size: 'M' }, serial: null, declarations: {}, photos: ['/media/' + main!.path] });
    expect(of(calls, 'staff_market_company_state')[0].body).toEqual({ p_listing: 21, p_action: 'publish', p_price: null });
    // the list is read again after
    await expect.poll(() => of(calls, 'staff_market_listings').length).toBe(2);
    // nothing of the saved listing leaves the bucket
    expect(stored.filter((s) => s.method === 'DELETE')).toHaveLength(0);
  });

  test('a publish the database refuses leaves the draft saved and says what is missing; a photo not saved leaves the bucket', async ({ page }) => {
    await staff(page);
    const calls = rpcCalls(page), stored = await bucket(page);
    await answer(page, 'staff_market_company_save', (b) => ({ listing: full(22, 'draft', { ...(b.p as Body) }) }));
    await answer(page, 'staff_market_company_state', () => refuse('MKT_PHOTOS'));
    await open(page, 'ours');
    await panel(page).getByRole('button', { name: 'New listing' }).click();
    const d = pop(page);
    await d.getByLabel('Category').selectOption('cycling-bike-road');
    await d.getByLabel('Title').fill('Steel tourer');
    await d.getByLabel('Year').fill('1950');
    await d.getByRole('button', { name: 'Publish' }).click();
    await expect(d.locator('.mks-err')).toHaveText('Check this field: Year');
    expect(of(calls, 'staff_market_company_save')).toHaveLength(0);
    await d.getByLabel('Year').fill('2019');
    await d.getByLabel('Frame or serial number').fill('wtu 77 123');
    await d.getByRole('button', { name: 'Publish' }).click();
    await expect(d.locator('.mks-err')).toHaveText('Photos needed for this category: 3.');
    await expect(d.locator('#mks-pop-t')).toHaveText('Listing #22');
    const p = of(calls, 'staff_market_company_save')[0].body.p as Body;
    expect(p.serial).toBe('WTU77123');
    expect(p.facts).toEqual({ year: 2019 });
    // a photo added now and the pop-up left without saving: asked first, then the photo is taken out of the bucket
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), d.getByRole('button', { name: 'Add photos' }).click()]);
    await chooser.setFiles({ name: 'tourer.png', mimeType: 'image/png', buffer: PNG });
    await expect(d.locator('.mks-ph1')).toHaveCount(1);
    await d.getByRole('button', { name: 'Cancel' }).click();
    await confirmBox(page).getByRole('button', { name: 'Leave without saving' }).click();
    await expect(pop(page)).toHaveCount(0);
    await expect.poll(() => stored.filter((s) => s.method === 'DELETE').length).toBe(1);
  });

  test('a bucket that refuses the photo (not an admin) is said so', async ({ page }) => {
    await staff(page, {}, 'manager');
    await bucket(page, false);
    await open(page, 'ours');
    await panel(page).getByRole('button', { name: 'New listing' }).click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), pop(page).getByRole('button', { name: 'Add photos' }).click()]);
    await chooser.setFiles({ name: 'x.png', mimeType: 'image/png', buffer: PNG });
    await expect(page.locator('.toast', { hasText: 'Admin only.' })).toHaveCount(1);
    await expect(pop(page).locator('.mks-ph1')).toHaveCount(0);
  });

  test('Edit reads the listing whole and saves it; a photo made the cover, another taken off', async ({ page }) => {
    await staff(page, { 'rpc:staff_market_listing_get': full(12, 'live') });
    const calls = rpcCalls(page), stored = await bucket(page);
    await answer(page, 'staff_market_company_save', (b) => ({ listing: full(12, 'live', { ...(b.p as Body) }) }));
    await open(page, 'ours');
    await rowOf(page, 12).getByRole('button', { name: 'Edit' }).click();
    const d = pop(page);
    await expect(d.getByLabel('Title')).toHaveValue('Road bike 12');
    expect(of(calls, 'staff_market_listing_get')[0].body).toEqual({ p_listing: 12 });
    await expect(d.getByLabel('Category')).toHaveValue('cycling-bike-road');
    await expect(d.getByLabel('City')).toHaveValue('riyadh');
    await expect(d.getByLabel('Wheel size')).toHaveValue('700c');
    await expect(d.getByLabel('Year')).toHaveValue('2022');
    await expect(d.getByLabel('The price is negotiable')).toBeChecked();
    await expect(d.locator('.mks-ph1')).toHaveCount(3);
    await expect(d.getByRole('button', { name: 'Publish' })).toHaveCount(0); // already on sale
    await d.locator('.mks-ph1').nth(2).getByRole('button', { name: 'Make cover' }).click();
    await d.getByRole('button', { name: 'Remove photo 3' }).click();
    await d.getByLabel('Price (SAR)').fill('1900');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(pop(page)).toHaveCount(0);
    const save = of(calls, 'staff_market_company_save')[0].body;
    expect(save.p_listing).toBe(12);
    expect((save.p as Body).price).toBe(1900);
    expect((save.p as Body).photos).toEqual(['/media/market/c.jpg', '/media/market/a.jpg']);
    expect((save.p as Body).facts).toEqual({ brand: 'Velo', year: 2022, wheel_size: '700c' });
    expect(of(calls, 'staff_market_company_state')).toHaveLength(0);
    // the photo taken off leaves the bucket once the listing is saved without it, its copies with it
    await expect.poll(() => stored.filter((s) => s.method === 'DELETE').length).toBe(1);
  });

  test('Mark sold asks what it sold for; Mark reserved, Back to live and Renew go at once; Remove asks first', async ({ page }) => {
    await staff(page);
    const calls = rpcCalls(page);
    await answer(page, 'staff_market_company_state', (b) => ({ listing: full(Number(b.p_listing), 'live') }));
    await open(page, 'ours');
    const st = () => of(calls, 'staff_market_company_state').map((c) => c.body);
    await rowOf(page, 12).getByRole('button', { name: 'Mark sold' }).click();
    const price = page.locator('#prompt-input');
    await expect(price).toHaveValue('2012');
    await price.fill('0');
    await page.locator('#confirm-modal').getByRole('button', { name: 'Mark sold' }).click();
    await expect(page.locator('.toast', { hasText: 'Check this field: Price (SAR)' })).toHaveCount(1);
    expect(st()).toHaveLength(0);
    await rowOf(page, 12).getByRole('button', { name: 'Mark sold' }).click();
    await price.fill('1800');
    await page.locator('#confirm-modal').getByRole('button', { name: 'Mark sold' }).click();
    await expect.poll(() => st().length).toBe(1);
    expect(st()[0]).toEqual({ p_listing: 12, p_action: 'sold', p_price: 1800 });
    await rowOf(page, 12).getByRole('button', { name: 'Mark reserved' }).click();
    await expect.poll(() => st().length).toBe(2);
    await rowOf(page, 13).getByRole('button', { name: 'Back to live' }).click();
    await expect.poll(() => st().length).toBe(3);
    await rowOf(page, 15).getByRole('button', { name: 'Renew' }).click();
    await expect.poll(() => st().length).toBe(4);
    expect(st().slice(1)).toEqual([{ p_listing: 12, p_action: 'reserved', p_price: null }, { p_listing: 13, p_action: 'live', p_price: null }, { p_listing: 15, p_action: 'renew', p_price: null }]);
    await rowOf(page, 14).getByRole('button', { name: 'Remove' }).click();
    await expect(confirmBox(page)).toContainText('Remove Road bike 14?');
    expect(st()).toHaveLength(4);
    await confirmBox(page).getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => st().length).toBe(5);
    expect(st()[4]).toEqual({ p_listing: 14, p_action: 'deleted', p_price: null });
  });

  test('a step another desk took first is said, and the list is read again', async ({ page }) => {
    await staff(page);
    const calls = rpcCalls(page);
    await answer(page, 'staff_market_company_state', () => refuse('MKT_STATE'));
    await open(page, 'ours');
    await rowOf(page, 13).getByRole('button', { name: 'Back to live' }).click();
    await expect(page.locator('.toast', { hasText: 'That step is no longer possible from its current status.' })).toHaveCount(1);
    await expect.poll(() => of(calls, 'staff_market_listings').length).toBe(2);
  });

  test('the categories are part of the view: a failed read of them offers Try again, not an editor with nothing to pick', async ({ page }) => {
    await staff(page);
    let fail = true;
    await page.route('**/rest/v1/market_categories**', async (route) => {
      if (route.request().method() !== 'GET' || !fail) return route.fallback();
      return route.fulfill({ status: 500, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'XX000', message: 'boom', details: null, hint: null }) });
    });
    await open(page, 'ours');
    await expect(panel(page).getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'New listing' })).toHaveCount(0);
    fail = false;
    await panel(page).getByRole('button', { name: 'Try again' }).click();
    await expect(rowOf(page, 12).locator('.mks-meta')).toContainText('Road bikes');
    await expect(panel(page).getByRole('button', { name: 'New listing' })).toBeVisible();
  });
});

test.describe('@staff:market Commission', () => {
  test('the sold listings with the commission asked, and the totals of a period', async ({ page }) => {
    await staff(page);
    const calls = rpcCalls(page);
    await open(page, 'commission');
    expect(of(calls, 'staff_market_commission')[0].body).toEqual({ p: { state: 'all', limit: 200, offset: 0 } });
    const sums = () => panel(page).locator('.mks-sum b').allTextContents();
    expect(await sums()).toEqual(['SAR 155', 'SAR 5', 'SAR 150']); // asked, received, still due: all time
    await expect(panel(page).locator('.filter-pill')).toHaveText(['Due (3)', 'Received (1)', 'All (4)']);
    await expect(panel(page).locator('.mks-row')).toHaveCount(3); // Due is the list it opens on
    await expect(rowOf(page, 31)).toContainText('Sold item 31');
    await expect(rowOf(page, 31).locator('.mks-amt')).toHaveText('SAR 20');
    await expect(rowOf(page, 31)).toContainText('Private seller');
    await expect(rowOf(page, 33)).toContainText('Shop');
    await expect(rowOf(page, 33)).toContainText('Anchor Cycles');
    await expect(rowOf(page, 33)).toContainText('SAR 10,000');
    // this month: two sales, one of them received
    await page.evaluate(`_mksCoPer('month')`);
    expect(await sums()).toEqual(['SAR 25', 'SAR 5', 'SAR 20']);
    await expect(panel(page).locator('.filter-pill')).toHaveText(['Due (1)', 'Received (1)', 'All (2)']);
    await page.evaluate(`_mksCoPer('last')`);
    expect(await sums()).toEqual(['SAR 100', 'SAR 0', 'SAR 100']);
    await expect(panel(page).locator('.mks-row')).toHaveCount(1);
    // the period sits behind the Filters button, as on every list
    await panel(page).getByRole('button', { name: /Filters/ }).click();
    await panel(page).getByLabel('Period').selectOption('all');
    expect(await sums()).toEqual(['SAR 155', 'SAR 5', 'SAR 150']);
    await panel(page).locator('.filter-pill', { hasText: 'Received' }).click();
    await expect(panel(page).locator('.mks-row')).toHaveCount(1);
    await expect(rowOf(page, 32)).toContainText('by Spec Staff');
    await expect(rowOf(page, 32)).toContainText('Cash at the hub');
  });

  test('Received is ticked by hand with a note, and unticked again', async ({ page }) => {
    await staff(page);
    const calls = rpcCalls(page);
    await answer(page, 'staff_market_commission_set', (b) => ({
      row: { ...commission.items.find((x) => x.listing_id === Number(b.p_listing)), received: b.p_received, received_at: b.p_received ? NOW : null, received_by: b.p_received ? 'Spec Staff' : null, note: b.p_note },
    }));
    await open(page, 'commission');
    await rowOf(page, 31).getByRole('button', { name: 'Mark received' }).click();
    await expect(page.locator('#confirm-modal')).toContainText('Sold item 31 · SAR 20');
    await page.locator('#prompt-input').fill('Bank transfer, 20 Nov');
    await page.locator('#confirm-modal').getByRole('button', { name: 'Mark received' }).click();
    const set = () => of(calls, 'staff_market_commission_set').map((c) => c.body);
    await expect.poll(() => set().length).toBe(1);
    expect(set()[0]).toEqual({ p_listing: 31, p_received: true, p_note: 'Bank transfer, 20 Nov' });
    await expect(panel(page).locator('.mks-sum b')).toHaveText(['SAR 155', 'SAR 25', 'SAR 130']);
    await expect(rowOf(page, 31)).toHaveCount(0); // it left the Due list
    expect(await page.evaluate('window.__mkCounts')).toBe(1);
    await panel(page).locator('.filter-pill', { hasText: 'Received' }).click();
    await expect(rowOf(page, 31)).toContainText('Bank transfer, 20 Nov');
    await rowOf(page, 31).getByRole('button', { name: 'Not received' }).click();
    await expect.poll(() => set().length).toBe(2);
    expect(set()[1]).toEqual({ p_listing: 31, p_received: false, p_note: null });
    await expect(panel(page).locator('.mks-sum b')).toHaveText(['SAR 155', 'SAR 5', 'SAR 150']);
    // a prompt cancelled writes nothing
    await panel(page).locator('.filter-pill', { hasText: 'Due' }).click();
    await rowOf(page, 34).getByRole('button', { name: 'Mark received' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Cancel' }).click();
    expect(set()).toHaveLength(2);
  });
});

test.describe('@staff:market Settings', () => {
  test('the saved values fill the form; only the keys that changed are written, the Website section way', async ({ page }) => {
    await staff(page);
    const sc = writes(page, 'site_content');
    await open(page, 'settings');
    const p = panel(page);
    await expect(p.getByRole('switch', { name: 'Marketplace on micromobility.sa' })).not.toBeChecked();
    await expect(p.getByLabel('Commission (% of the sold price)')).toHaveValue('1');
    await expect(p.getByLabel('How to pay it (English)')).toHaveValue('Transfer it to our account.');
    await expect(p.getByLabel('How to pay it (Arabic)')).toHaveValue('حوّلها إلى حسابنا.');
    await expect(p.getByLabel('Days a listing stays up')).toHaveValue('60');
    await expect(p.getByLabel('Reports that hold a listing')).toHaveValue('3');
    await expect(p.getByRole('group', { name: 'New accounts' }).getByLabel('Highest price (SAR)')).toHaveValue('3000');
    await expect(p.getByRole('group', { name: 'Shops' }).getByLabel('Listings on sale after that')).toHaveValue('200');
    await expect(p.getByLabel('Blocked words, one on each line')).toHaveValue('airsoft\npepper spray');
    // a number out of its range is said, and nothing is written
    await p.getByLabel('Days a listing stays up').fill('5');
    await p.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast', { hasText: 'Days a listing stays up: a number from 7 to 180' })).toHaveCount(1);
    expect(sc).toHaveLength(0);
    await p.getByRole('button', { name: 'Discard changes' }).click();
    await expect(p.getByLabel('Days a listing stays up')).toHaveValue('60');
    await p.getByLabel('Commission (% of the sold price)').fill('2.5');
    await p.getByLabel('Reports that hold a listing').fill('4');
    await p.getByRole('group', { name: 'New accounts' }).getByLabel('Highest price (SAR)').fill('2500');
    await p.getByLabel('Blocked words, one on each line').fill('airsoft\npepper spray\n  stun   gun \nairsoft');
    await p.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => sc.length).toBe(1);
    expect(sc[0].method).toBe('POST');
    const sent = Object.fromEntries((sc[0].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    expect(sent).toEqual({
      'marketplace.commission_pct': 2.5, 'marketplace.auto_hold_reports': 4,
      'marketplace.limits': { ...limits, new: { ...limits.new, price_max: 2500 } },
      'marketplace.blocked_words': ['airsoft', 'pepper spray', 'stun gun'],
    });
    expect((sc[0].body as { updated_by: string }[])[0].updated_by).toBe('Spec Staff');
  });

  test('the switch asks first, then writes marketplace.on', async ({ page }) => {
    await staff(page);
    const sc = writes(page, 'site_content');
    await open(page, 'settings');
    const sw = panel(page).getByRole('switch', { name: 'Marketplace on micromobility.sa' });
    await sw.click();
    await expect(confirmBox(page)).toContainText('Turn the marketplace on?');
    await expect(sw).not.toBeChecked(); // what is saved, until the question is answered
    expect(sc).toHaveLength(0);
    await confirmBox(page).getByRole('button', { name: 'Turn on' }).click();
    await expect.poll(() => sc.length).toBe(1);
    expect((sc[0].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value])).toEqual([['marketplace.on', true]]);
    await expect.poll(() => page.evaluate('window.__mkCounts')).toBe(1);
  });

  test('an account that is not an admin reads the settings and changes none', async ({ page }) => {
    await staff(page, {}, 'manager');
    await open(page, 'settings');
    const p = panel(page);
    await expect(p.getByRole('switch', { name: 'Marketplace on micromobility.sa' })).toBeDisabled();
    await expect(p.getByLabel('Commission (% of the sold price)')).toBeDisabled();
    await expect(p.getByLabel('Blocked words, one on each line')).toBeDisabled();
    await expect(p.getByLabel('Rules version')).toBeDisabled();
    await expect(p.getByRole('button', { name: 'Save' })).toHaveCount(0);
  });

  test('the rules version (marketplace.terms_version) reads as the database reads it and is asked about before it is written', async ({ page }) => {
    await staff(page);
    const sc = writes(page, 'site_content');
    await open(page, 'settings');
    const p = panel(page), f = p.getByLabel('Rules version');
    await expect(f).toHaveValue('2026-11-21'); // never saved here: the database's own default
    await f.fill('2027 01');
    await p.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('.toast', { hasText: 'Check this field: Rules version' })).toHaveCount(1);
    await expect(confirmBox(page)).toHaveCount(0);
    expect(sc).toHaveLength(0);
    await f.fill('2027-01-15');
    await p.getByRole('button', { name: 'Save' }).click();
    await expect(confirmBox(page)).toContainText('Change the rules version?');
    await expect(confirmBox(page)).toContainText('Every seller is asked to accept the rules again before their next listing goes up.');
    expect(sc).toHaveLength(0);
    await confirmBox(page).getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => sc.length).toBe(1);
    expect((sc[0].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value])).toEqual([['marketplace.terms_version', '2027-01-15']]);
  });
});

test.describe('@staff:market Categories', () => {
  test('the sports in their order, a sport opened shows its product types and their rules', async ({ page }) => {
    await staff(page);
    await open(page, 'cats');
    const p = panel(page);
    await expect(p.locator('.mks-row:not(.mks-kid) .mks-name bdi:first-child')).toHaveText(['Cycling', 'Running']);
    await expect(rowOf(page, 'cycling').locator('.mks-meta')).toContainText('Product types: 3');
    await expect(p.locator('.mks-kid')).toHaveCount(0);
    await p.getByRole('button', { name: 'Product types: Cycling' }).click();
    await expect(p.locator('.mks-kid .mks-name bdi:first-child')).toHaveText(['Road bikes', 'E-bikes', 'Helmets']);
    await expect(rowOf(page, 'cycling-bike-electric').locator('.mks-meta')).toContainText('With a declaration');
    await expect(rowOf(page, 'cycling-bike-electric').locator('.mks-meta')).toContainText('Frame or serial number needed');
    await expect(rowOf(page, 'cycling-bike-electric').locator('.mks-meta')).toContainText('Fewest photos: 3');
    await expect(rowOf(page, 'cycling-helmets').locator('.mks-meta')).toContainText('New items only');
    await p.getByRole('button', { name: 'Product types: Running' }).click();
    await expect(rowOf(page, 'running-old').locator('.mks-pill')).toHaveText('Hidden');
    await expect(rowOf(page, 'running-old').getByRole('button', { name: 'Show' })).toBeVisible();
  });

  test('a product type edited, a sport and a product type added, one hidden: each through staff_market_category_save', async ({ page }) => {
    await staff(page);
    const calls = rpcCalls(page);
    await answer(page, 'staff_market_category_save', (b) => {
      const p = b.p as Body, old = cats.find((c) => c.slug === p.slug);
      return { category: { ...(old || cat(String(p.slug), null, '', '', 0)), ...p } };
    });
    const saved = () => of(calls, 'staff_market_category_save').map((c) => c.body.p);
    await open(page, 'cats');
    const p = panel(page), d = pop(page);
    await p.getByRole('button', { name: 'Product types: Cycling' }).click();
    await rowOf(page, 'cycling-helmets').getByRole('button', { name: 'Edit' }).click();
    await expect(d.locator('#mks-pop-t')).toHaveText('Helmets');
    await expect(d.getByLabel('Key (lower-case letters, digits and dashes)')).toHaveCount(0); // a key is never renamed
    await expect(d.getByLabel('Rule')).toHaveValue('new_only');
    await d.getByLabel('Rule').selectOption('open');
    await d.getByLabel('Fewest photos').fill('2');
    await d.getByLabel('Order').fill('35');
    await d.getByRole('group', { name: 'Details the listing form asks for' }).getByLabel('For', { exact: true }).check();
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(pop(page)).toHaveCount(0);
    expect(saved()[0]).toEqual({ slug: 'cycling-helmets', name_en: 'Helmets', name_ar: 'الخوذات', sort: 35, visible: true, tier: 'open', needs_serial: false, min_photos: 2, facts: ['brand', 'model', 'size', 'for_whom'] });
    await expect(rowOf(page, 'cycling-helmets').locator('.mks-meta')).toContainText('Order: 35');
    await expect(rowOf(page, 'cycling-helmets').locator('.mks-meta')).not.toContainText('New items only');
    // a new product type: its key follows the sport and the English name
    await rowOf(page, 'cycling').getByRole('button', { name: 'Add a product type' }).click();
    await expect(d.locator('#mks-pop-t')).toHaveText('New product type in Cycling');
    await d.getByLabel('Name (English)').fill('Indoor trainers');
    await expect(d.getByLabel('Key (lower-case letters, digits and dashes)')).toHaveValue('cycling-indoor-trainers');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(d.locator('.mks-err')).toHaveText('Check this field: Name (Arabic)');
    await d.getByLabel('Name (Arabic)').fill('أجهزة التدريب المنزلي');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(pop(page)).toHaveCount(0);
    expect(saved()[1]).toEqual({ slug: 'cycling-indoor-trainers', name_en: 'Indoor trainers', name_ar: 'أجهزة التدريب المنزلي', sort: 45, visible: true, parent: 'cycling', tier: 'open', needs_serial: false, min_photos: 1, facts: [] });
    await expect(rowOf(page, 'cycling-indoor-trainers')).toBeVisible();
    // a new sport has no rule of its own
    await p.getByRole('button', { name: 'Add a sport' }).click();
    await expect(d.getByLabel('Rule')).toHaveCount(0);
    await d.getByLabel('Name (English)').fill('Padel');
    await d.getByLabel('Name (Arabic)').fill('البادل');
    await d.getByRole('button', { name: 'Save' }).click();
    await expect(pop(page)).toHaveCount(0);
    expect(saved()[2]).toEqual({ slug: 'padel', name_en: 'Padel', name_ar: 'البادل', sort: 30, visible: true, parent: null });
    // hidden at once; nothing is ever deleted
    await rowOf(page, 'running').getByRole('button', { name: 'Hide' }).click();
    await expect.poll(() => saved().length).toBe(4);
    expect(saved()[3]).toEqual({ slug: 'running', visible: false });
    await expect(rowOf(page, 'running').locator('.mks-pill')).toHaveText('Hidden');
  });
});

test.describe('@staff:market the views without their data, in Arabic, and on a phone', () => {
  test('a database without the marketplace says so; a read that failed offers Try again', async ({ page }) => {
    const absent = (fn: string) => ({ __rpcError: { status: 404, code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` } });
    await staff(page, { 'rpc:staff_market_shops': absent('staff_market_shops'), 'rpc:staff_market_commission': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } });
    await open(page, 'shops');
    await expect(panel(page)).toContainText('The marketplace is not set up on this database yet.');
    await open(page, 'commission');
    await expect(panel(page).getByRole('button', { name: 'Try again' })).toBeVisible();
    const calls = rpcCalls(page);
    await panel(page).getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => of(calls, 'staff_market_commission').length).toBe(1);
  });

  test('Arabic: the views read in Arabic, a city and a category by their Arabic names', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setLang('ar')`);
    await page.waitForFunction(`t('mksOpen')==='فتح'`);
    await open(page, 'shops');
    await expect(rowOf(page, 3).getByRole('button', { name: 'فتح' })).toBeVisible();
    await expect(rowOf(page, 3).locator('.mks-pill')).toHaveText('بانتظار المراجعة');
    await expect(rowOf(page, 3).locator('.mks-meta')).toContainText('جدة');
    await open(page, 'ours');
    await expect(rowOf(page, 12).locator('.mks-meta')).toContainText('دراجات الطريق');
    await expect(rowOf(page, 12).getByRole('button', { name: 'تحديد كمُباع' })).toBeVisible();
    expect(await panel(page).evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
  });

  test('the pop-up is centred on the screen, a phone included, and nothing is pinned to the foot of the page', async ({ page }) => {
    await staff(page);
    await open(page, 'ours');
    await panel(page).getByRole('button', { name: 'New listing' }).click();
    const vp = page.viewportSize()!;
    // once it has slid in: its middle is the screen's middle, across and down
    const off = async () => { const b = await pop(page).boundingBox(); return b ? Math.max(Math.abs(b.x + b.width / 2 - vp.width / 2), Math.abs(b.y + b.height / 2 - vp.height / 2)) : 999; };
    await expect.poll(off).toBeLessThan(6);
    const box = await pop(page).boundingBox();
    expect(box!.width).toBeLessThanOrEqual(vp.width);
    expect(box!.height).toBeLessThanOrEqual(vp.height);
    const pinned = await page.evaluate(`[...document.querySelectorAll('#tab-market [class*="mks-"],#mks-pop .confirm-box,#mks-pop .confirm-box *')].filter(el=>['fixed','sticky'].includes(getComputedStyle(el).position)).length`);
    expect(pinned).toBe(0);
  });
});
