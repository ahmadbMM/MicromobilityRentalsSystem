import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The store's catalogue screens (2026-11-19, migrations 20261119400000 / 20261119400100): staff_store_mode() says
// 'catalog' (production: the Store's catalogue views only, no Payments, no read of an order or payment table) or 'full'
// (staging: everything); Categories (two levels, a template, delete with "move its products to"), Collections (manual
// with a product list, newest, on sale, best sellers), Store > Settings (every store.* key, moved from Payments >
// Settings) and Reports (staff_store_report, CSV). All traffic stubbed; invented data only.

const NOW = '2026-11-19T09:00:00Z';
const cat = (slug: string, x: Record<string, unknown> = {}) => ({
  slug, parent: null, name_en: slug[0].toUpperCase() + slug.slice(1), name_ar: null, blurb_en: null, blurb_ar: null, image: null, sort: 10, visible: true,
  seo_title_en: null, seo_title_ar: null, seo_desc_en: null, seo_desc_ar: null, template: {}, filters: ['brand', 'size', 'colour', 'price', 'instock'], ...x,
});
const cats = [
  cat('bikes', { sort: 10, name_ar: 'دراجات' }), cat('road', { parent: 'bikes', sort: 15, name_en: 'Road' }), cat('accessories', { sort: 20 }),
  cat('gift', { sort: 60, name_en: 'Gift cards' }),
];
const prod = (id: string, x: Record<string, unknown> = {}) => ({
  id, slug: id + '-slug', category: 'accessories', brand: 'MM', name_en: 'Product ' + id, name_ar: null, tagline_en: null, tagline_ar: null,
  description_en: null, description_ar: null, specs: [], images: [], price: 100, compare_at: null, ship_ksa: true, published: true, sort: 0,
  kind: 'item', condition: 'new', warranty_months: null, key_specs: [], box: [], fit: null, faq: [], sizes: [], image_meta: {}, goes_with: [], compare_with: [],
  bundle: null, sale_from: null, sale_to: null, catalog_model: null, created_at: NOW, ...x,
});
const prods = [prod('p1', { name_en: 'Trail helmet' }), prod('p2', { name_en: 'Bottle cage' }), prod('p3', { name_en: 'Road racer', category: 'road' })];
const coll = (slug: string, x: Record<string, unknown> = {}) => ({
  slug, name_en: 'Coll ' + slug, name_ar: null, blurb_en: null, blurb_ar: null, image: null, sort: 10, visible: true, on_store: false, starts_on: null, ends_on: null,
  kind: 'manual', days: 30, max_items: 12, seo_title_en: null, seo_title_ar: null, seo_desc_en: null, seo_desc_ar: null, ...x,
});
const report = (sales: unknown = null) => ({
  mode: sales ? 'full' : 'catalog', from: '2026-10-21', to: '2026-11-19',
  products: { total: 9, live: 5, preview: 1, draft: 2, scheduled: 1 }, variants: 14, units: 120, low: 3, out: 2,
  stock: { retail: 24000, cost: 15000, missing_cost: 4 },
  by_category: [{ slug: 'bikes', name_en: 'Bikes', name_ar: 'دراجات', products: 3, units: 12, retail: 18000, cost: 12000 }, { slug: 'accessories', name_en: 'Accessories', name_ar: null, products: 6, units: 108, retail: 6000, cost: 3000 }],
  moves: { receive: 40, count: -2, damaged: -1, lost: 0, return: 0, order: -6, cancel: 0, edit: 0, import: 0, other: 0, sync: 5 }, sales,
});
const SALES = {
  orders: 7, units: 9, revenue: 4200, cost: 2600, margin: 1600,
  by_product: [{ product_id: 'p1', name: 'Trail helmet', units: 5, revenue: 1000, cost: 600 }, { product_id: 'p3', name: 'Road racer', units: 1, revenue: 3200, cost: 2000 }],
  by_category: [{ slug: 'road', units: 1, revenue: 3200 }, { slug: 'accessories', units: 8, revenue: 1000 }],
  by_day: [{ day: '2026-11-17', orders: 3, revenue: 1200 }, { day: '2026-11-18', orders: 4, revenue: 3000 }],
};

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
// Every database address the page asked for (tables and functions)
function reads(page: Page) {
  const seen: string[] = [];
  page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/(?:rpc\/)?([^/?]+)/); if (m) seen.push(m[1]); });
  return seen;
}
// What a database without orders has none of (production): never asked in catalog mode
const ORDER_THINGS = /^(store_orders|store_order_items|payments|payment_refunds|store_reviews|store_promo_codes|store_gift_cards|xp_bike_credits|staff_store_orders|staff_store_returns|staff_store_stock_requests|staff_store_after_queue|staff_store_quotes|staff_payments|staff_payment_figures|staff_store_ready)$/;
async function staff(page: Page, fx: Fixtures = {}, url = '/?staff', role = 'admin') {
  const ops = [{ name: 'Spec Staff', has_pin: false }];
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers: [], staff_options: [], 'rpc:staff_operator_list': ops, ...fx });
  await unlockStaff(page);
  await page.goto(url);
  await waitForSb(page);
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S.staffRole='${role}';renderStaffTabs();`);
  await expect.poll(() => page.evaluate('S._storeMode||null')).not.toBeNull();
}
const view = (page: Page, v: string) => page.evaluate(`S.stoView='${v}';setStaffTab('store')`);
const pills = (page: Page) => page.locator('#tab-store .sto-views .filter-pill').allTextContents();
const railBtn = (page: Page, k: string) => page.evaluate(`document.querySelector('#staff-tab-nav .tab-btn[data-stab="${k}"]').style.display`);
const CATALOG = { 'rpc:staff_store_mode': 'catalog', store_categories: cats, store_products: prods, store_variants: [], store_collections: [], store_collection_items: [] };
const FULL = { ...CATALOG, 'rpc:staff_store_mode': 'full', 'rpc:staff_store_orders': [], store_orders: [], payment_refunds: [] };

test.describe('@staff:store catalog mode (production: the catalogue alone)', () => {
  test('the Store offers only its catalogue views, opens on the products, and reads no order or payment table; no Payments', async ({ page }) => {
    const got = reads(page);
    await staff(page, CATALOG, '/store');
    expect(await page.evaluate('[S._storeMode,S._storeReady]')).toEqual(['catalog', false]);
    await expect.poll(() => page.evaluate('S.staffTab')).toBe('store');
    expect(await railBtn(page, 'store')).not.toBe('none');
    expect(await railBtn(page, 'payments')).toBe('none');
    await expect(page.locator('#tab-store .sto-views .filter-pill.active')).toHaveText('Products');
    expect(await pills(page)).toEqual(['Products', 'Low stock', 'Stock history', 'Suppliers', 'Categories', 'Collections', 'Reports', 'Settings']); // with S2's views
    for (const v of ['stock', 'categories', 'collections', 'settings', 'products']) { await view(page, v); await page.waitForTimeout(150); }
    await page.evaluate(`S.stoView='orders';setStaffTab('store')`); // an order view asked for by name still opens the products
    await expect(page.locator('#tab-store .sto-views .filter-pill.active')).toHaveText('Products');
    await page.evaluate(`setStaffTab('payments')`);
    expect(await page.evaluate('S.staffTab')).not.toBe('payments');
    expect(await page.evaluate(`JSON.stringify(_staffSections().filter(k=>k==='store'||k==='payments'))`)).toBe('["store"]');
    await page.waitForTimeout(300);
    expect(got.filter((n) => ORDER_THINGS.test(n))).toEqual([]);
  });

  test('every view has its address', async ({ page }) => {
    await staff(page, CATALOG, '/store/categories');
    await expect(page.locator('#tab-store .sto-views .filter-pill.active')).toHaveText('Categories');
    for (const [v, seg] of [['collections', 'collections'], ['settings', 'settings'], ['reports', 'reports'], ['products', 'products']]) {
      await page.locator('#tab-store .sto-views .filter-pill', { hasText: new RegExp(`^${v[0].toUpperCase() + v.slice(1)}$`) }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/store/' + seg);
    }
    expect(await page.evaluate(`JSON.stringify(['moves','suppliers'].map(k=>SUB_PATHS.store[k]))`)).toBe('["stock-history","suppliers"]');
  });

  test('a staffer who is not an admin reads the catalogue screens and changes nothing', async ({ page }) => {
    await staff(page, { ...CATALOG, site_content: [{ key: 'store.lowStock', value: 4, updated_at: NOW }] }, '/?staff', 'manager');
    await page.evaluate(`setStaffTab('store')`);
    await expect(page.locator('#tab-store .sto-views .filter-pill.active')).toHaveText('Categories');
    expect(await pills(page)).toEqual(['Stock history', 'Suppliers', 'Categories', 'Collections', 'Reports', 'Settings']); // S2's views: staff read them
    await expect(page.locator('#tab-store .spc-row')).toHaveCount(4);
    await expect(page.locator('#tab-store button', { hasText: 'New category' })).toHaveCount(0);
    await expect(page.locator('#tab-store .spc-row button')).toHaveCount(0); // no order buttons, no Edit
    await view(page, 'settings');
    await expect(page.locator('#ps-low')).toHaveValue('4');
    await expect(page.locator('#ps-low')).toBeDisabled();
    await expect(page.locator('#ss-save')).toHaveCount(0);
  });
});

test.describe('@staff:store full mode (staging) and the stock block\'s views', () => {
  test('everything as before plus the new views; the older probe still reads as full', async ({ page }) => {
    await staff(page, FULL, '/store');
    expect(await page.evaluate('[S._storeMode,S._storeReady]')).toEqual(['full', true]);
    expect(await railBtn(page, 'payments')).not.toBe('none');
    await expect(page.locator('#tab-store .sto-views .filter-pill.active')).toHaveText('Orders');
    const p = await pills(page);
    for (const k of ['Orders', 'Products', 'Categories', 'Collections', 'Reports', 'Settings']) expect(p).toContain(k);
    for (const k of ['Stock history', 'Suppliers']) expect(p).toContain(k); // S2's views, merged
  });

  test('without staff_store_mode the older staff_store_ready answers: full', async ({ page }) => {
    await staff(page, { 'rpc:staff_store_ready': true, store_orders: [], payment_refunds: [], 'rpc:staff_store_orders': [] });
    expect(await page.evaluate('[S._storeMode,S._storeReady]')).toEqual(['full', true]);
  });

  test('the stock history and suppliers views and the Import / Export / Receive / New supplier buttons come with the stock block', async ({ page }) => {
    await staff(page, CATALOG);
    await page.evaluate(`window._stoMovesHtml=()=>'<div id="mv-x">moves</div>';window._stoMovesLoad=()=>{window.__mvl=(window.__mvl||0)+1;};window._stoSupHtml=()=>'<div id="sup-x">sup</div>';window._stoSupLoad=()=>{};
      window._stoImportOpen=()=>{window.__imp=1;};window._stoExportOpen=()=>{window.__exp=1;};window._stoReceiveOpen=()=>{window.__rcv=1;};window._stoSupOpen=()=>{window.__sup=1;};`);
    await view(page, 'products');
    expect(await pills(page)).toEqual(['Products', 'Low stock', 'Stock history', 'Suppliers', 'Categories', 'Collections', 'Reports', 'Settings']);
    await page.locator('#tab-store .sto-head-acts button', { hasText: 'Import' }).click();
    await page.locator('#tab-store .sto-head-acts button', { hasText: 'Export' }).click();
    await page.locator('#tab-store .sto-views .filter-pill', { hasText: 'Stock history' }).click();
    await expect(page.locator('#mv-x')).toBeVisible();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/store/stock-history');
    await page.locator('#tab-store .sto-head-acts button', { hasText: 'Receive delivery' }).click();
    await page.locator('#tab-store .sto-views .filter-pill', { hasText: 'Suppliers' }).click();
    await page.locator('#tab-store .sto-head-acts button', { hasText: 'New supplier' }).click();
    expect(await page.evaluate('[window.__imp,window.__exp,window.__rcv,window.__sup,window.__mvl>0]')).toEqual([1, 1, 1, 1, true]);
  });
});

test.describe('@staff:store categories', () => {
  test('parents then their sub-categories with product counts; a new one with its template; the product editor names them', async ({ page }) => {
    const cw = writes(page, 'store_categories');
    await staff(page, CATALOG);
    await view(page, 'categories');
    const rows = page.locator('#tab-store .spc-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('Bikes');
    await expect(rows.nth(0)).toContainText('1 products'); // its own none, the sub-category's one
    await expect(rows.nth(1)).toContainText('Road');
    await expect(rows.nth(1)).toHaveClass(/spc-kid/);
    await expect(rows.nth(2)).toContainText('2 products');
    await page.locator('#tab-store button', { hasText: 'New category' }).click();
    const d = page.locator('#spc-dlg [role="dialog"]');
    await d.locator('#spc-name_en').fill('Helmets & Gear');
    await expect(d.locator('#spc-slug')).toHaveValue('helmets-gear');
    await d.locator('#spc-name_ar').fill('خوذ ومعدات');
    await d.locator('#spc-parent').selectOption('accessories');
    await d.locator('#spc-seo_title_en').fill('Helmets');
    await expect(d.locator('#spc-cnt-seo_title_en')).toHaveText('7/70');
    await d.locator('#spc-fl-sale').check();
    await d.locator('#spc-fl-size').uncheck();
    await d.locator('button', { hasText: 'Add a line' }).first().click();
    await d.locator('input[aria-label="Line 1 in English"]').fill('Weight');
    await d.locator('button', { hasText: 'Add a line' }).nth(1).click(); // a key-spec icon
    await d.locator('#spc-tw').fill('6');
    await d.locator('#spc-save').click();
    await expect(d.locator('.sto-err')).toContainText('Warranty');
    await d.locator('#spc-tw').fill('24');
    await d.locator('#spc-ts').selectOption('no');
    await d.locator('#spc-save').click();
    await expect.poll(() => cw.length).toBe(1);
    expect(cw[0].method).toBe('POST');
    expect(cw[0].body).toMatchObject({ slug: 'helmets-gear', parent: 'accessories', name_en: 'Helmets & Gear', name_ar: 'خوذ ومعدات', visible: true, seo_title_en: 'Helmets', sort: 70,
      filters: ['brand', 'colour', 'price', 'instock', 'sale'], template: { specs: [{ en: 'Weight', ar: null }], keys: ['weight'], box: [], warranty_months: 24, ship_ksa: false } });
    await expect(page.locator('#spc-dlg [role="dialog"]')).toHaveCount(0);
    // the product editor's picker: the database's categories, a sub-category after its parent
    await view(page, 'products');
    await page.locator('#tab-store button', { hasText: 'New product' }).click();
    await expect(page.locator('#sto-pe-category option')).toContainText(['Bikes', 'Bikes › Road', 'Accessories', 'Gift cards']);
    await expect(page.locator('#tab-store .sto-prod', { hasText: 'Road racer' })).toContainText('Bikes › Road');
  });

  test('a rename warns that the address changes and updates by the old slug; the order is saved with staff_store_sort', async ({ page }) => {
    const cw = writes(page, 'store_categories');
    const seen = rpcCalls(page);
    await staff(page, { ...CATALOG, 'rpc:staff_store_sort': 4 });
    await view(page, 'categories');
    await page.locator('#tab-store .spc-row', { hasText: 'Road' }).locator('button', { hasText: 'Edit' }).click();
    const d = page.locator('#spc-dlg [role="dialog"]');
    await expect(d.locator('#spc-slugw')).toBeHidden();
    await d.locator('#spc-slug').fill('road-bikes');
    await expect(d.locator('#spc-slugw')).toBeVisible();
    await d.locator('#spc-save').click();
    await expect.poll(() => cw.length).toBe(1);
    expect(cw[0].method).toBe('PATCH');
    expect(cw[0].url).toContain('slug=eq.road');
    expect(cw[0].body).toMatchObject({ slug: 'road-bikes', parent: 'bikes' });
    await page.locator('#tab-store .spc-row', { hasText: 'Accessories' }).locator('button[aria-label="Move Accessories up"]').click();
    await expect.poll(() => calls(seen, 'staff_store_sort').length).toBe(1);
    expect(calls(seen, 'staff_store_sort')[0].body).toEqual({ p_kind: 'categories', p_keys: ['accessories', 'bikes', 'road', 'gift'] });
  });

  test('delete moves its products first; one with sub-categories, the gift cards and the bikes cannot go', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { ...CATALOG, store_categories: [...cats, cat('kit', { sort: 30, name_en: 'Kit' }), cat('kitbags', { parent: 'kit', sort: 35, name_en: 'Kit bags' })],
      'rpc:staff_store_category_delete': 2 });
    await view(page, 'categories');
    await page.locator('#tab-store .spc-row', { hasText: 'Gift cards' }).locator('button', { hasText: 'Edit' }).click();
    const d = page.locator('#spc-dlg [role="dialog"]');
    await expect(d.locator('#spc-slug')).toBeDisabled();
    await expect(d.locator('button', { hasText: 'Delete category' })).toHaveCount(0);
    await d.locator('button', { hasText: 'Cancel' }).click();
    await page.locator('#tab-store .spc-row', { hasText: 'Bikes' }).first().locator('button', { hasText: 'Edit' }).click();
    await expect(d.locator('#spc-slug')).toBeDisabled(); // the bikes too (fix round 2026-11-19)
    await expect(d.locator('button', { hasText: 'Delete category' })).toHaveCount(0);
    await d.locator('button', { hasText: 'Cancel' }).click();
    await page.locator('#tab-store .spc-row', { hasText: 'Kit' }).first().locator('button', { hasText: 'Edit' }).click();
    await d.locator('button', { hasText: 'Delete category' }).click();
    await expect(d.locator('.sto-err')).toContainText('sub-categories first');
    await expect(d.locator('#spc-del-go')).toHaveCount(0);
    await d.locator('button', { hasText: 'Back' }).click();
    await d.locator('button', { hasText: 'Cancel' }).click();
    await page.locator('#tab-store .spc-row', { hasText: 'Accessories' }).locator('button', { hasText: 'Edit' }).click();
    await d.locator('button', { hasText: 'Delete category' }).click();
    await expect(d).toContainText('2 products are in this category.');
    await d.locator('#spc-del-go').click();
    await expect(d.locator('.sto-err')).toContainText('Choose where its products go');
    expect(calls(seen, 'staff_store_category_delete')).toHaveLength(0);
    await d.locator('#spc-move').selectOption('bikes');
    await d.locator('#spc-del-go').click();
    await expect.poll(() => calls(seen, 'staff_store_category_delete').length).toBe(1);
    expect(calls(seen, 'staff_store_category_delete')[0].body).toEqual({ p_slug: 'accessories', p_move_to: 'bikes' });
    await expect(page.locator('#toast-container')).toContainText('2 products moved');
  });

  test('the bikes: no other address, no parent, never deleted; its names, photo, order and the rest stay editable; a refusal is said', async ({ page }) => {
    const cw = writes(page, 'store_categories');
    await staff(page, { ...CATALOG, store_categories: [cat('bikes', { sort: 10, name_ar: 'دراجات' }), cat('accessories', { sort: 20 }), cat('gift', { sort: 60, name_en: 'Gift cards' })] });
    await view(page, 'categories');
    await page.locator('#tab-store .spc-row', { hasText: 'Bikes' }).locator('button', { hasText: 'Edit' }).click();
    const d = page.locator('#spc-dlg [role="dialog"]');
    await expect(d.locator('#spc-slug')).toBeDisabled();
    await expect(d.locator('#spc-parent')).toHaveCount(0); // no parent picker even with no sub-categories
    await expect(d.locator('button', { hasText: 'Delete category' })).toHaveCount(0);
    expect(await page.evaluate(`(()=>{_spcCatDelAsk();return S._spcD.mode;})()`)).toBe(''); // not by a call either
    await d.locator('#spc-name_en').fill('Bicycles');
    await d.locator('#spc-visible').uncheck();
    await d.locator('#spc-save').click();
    await expect.poll(() => cw.length).toBe(1);
    expect(cw[0].method).toBe('PATCH');
    expect(cw[0].url).toContain('slug=eq.bikes');
    expect(cw[0].body).toMatchObject({ slug: 'bikes', parent: null, name_en: 'Bicycles', visible: false });
    // the database's own refusal (STORE_CAT_BIKES) is said in the pop-up
    await page.route(/\/rest\/v1\/store_categories/, (r) => r.request().method() === 'PATCH'
      ? r.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'P0001', message: 'STORE_CAT_BIKES' }) })
      : r.fallback());
    await page.locator('#tab-store .spc-row', { hasText: 'Bikes' }).locator('button', { hasText: 'Edit' }).click();
    await d.locator('#spc-name_en').fill('Bikes');
    await d.locator('#spc-save').click();
    await expect(d.locator('.sto-err')).toHaveText('The bikes category cannot be deleted, moved or given another address');
  });

  test('a refusal of the database is said in the pop-up', async ({ page }) => {
    await staff(page, { ...CATALOG, 'rpc:staff_store_category_delete': { __rpcError: { status: 400, code: 'P0001', message: 'STORE_CAT_MOVE' } } });
    await view(page, 'categories');
    await page.locator('#tab-store .spc-row', { hasText: 'Accessories' }).locator('button', { hasText: 'Edit' }).click();
    const d = page.locator('#spc-dlg [role="dialog"]');
    await d.locator('button', { hasText: 'Delete category' }).click();
    await d.locator('#spc-move').selectOption('bikes');
    await d.locator('#spc-del-go').click();
    await expect(d.locator('.sto-err')).toContainText('Choose where its products go');
  });

  test('a database without the table: the six built-ins in the editor, and the screen says so', async ({ page }) => {
    await staff(page, { 'rpc:staff_store_mode': 'catalog', store_products: prods, store_variants: [] });
    await page.route(/\/rest\/v1\/store_categories/, (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.store_categories' in the schema cache" }) }));
    await view(page, 'categories');
    await expect(page.locator('#tab-store')).toContainText('not set up');
    expect(await page.evaluate(`_stoCats().map(c=>c.slug).join()`)).toBe('bikes,accessories,apparel,parts,nutrition,gift');
  });
});

test.describe('@staff:store collections', () => {
  test('a manual collection: products searched, added and ordered, saved with their order; newest takes its days', async ({ page }) => {
    const cw = writes(page, 'store_collections');
    const iw = writes(page, 'store_collection_items');
    const seen = rpcCalls(page);
    await staff(page, { ...CATALOG, 'rpc:staff_store_sort': 2, store_collections: [coll('eid', { kind: 'new', days: 14, on_store: true })] });
    await view(page, 'collections');
    await expect(page.locator('#tab-store .spc-row')).toHaveCount(1);
    await expect(page.locator('#tab-store .spc-row')).toContainText('Last 14 days');
    await expect(page.locator('#tab-store .spc-row')).toContainText('On the store page');
    await page.locator('#tab-store button', { hasText: 'New collection' }).click();
    const d = page.locator('#spc-dlg [role="dialog"]');
    await d.locator('#spc-name_en').fill('Summer picks');
    await d.locator('#spc-on_store').check();
    await d.locator('#spc-q').fill('helmet');
    await d.locator('.spc-add', { hasText: 'Trail helmet' }).click();
    await d.locator('#spc-q').fill('cage');
    await d.locator('.spc-add', { hasText: 'Bottle cage' }).click();
    await d.locator('button[aria-label="Move Bottle cage up"]').click();
    await d.locator('#spc-starts_on').fill('2026-12-01');
    await d.locator('#spc-ends_on').fill('2026-11-30');
    await d.locator('#spc-save').click();
    await expect(d.locator('.sto-err')).toContainText('end date');
    await d.locator('#spc-ends_on').fill('2026-12-31');
    await d.locator('#spc-save').click();
    await expect.poll(() => calls(seen, 'staff_store_sort').length).toBe(1);
    expect(cw[0].body).toMatchObject({ slug: 'summer-picks', kind: 'manual', on_store: true, starts_on: '2026-12-01', ends_on: '2026-12-31', max_items: 12, sort: 20 });
    expect(iw[0].body).toEqual([{ collection: 'summer-picks', product_id: 'p2', sort: 10 }, { collection: 'summer-picks', product_id: 'p1', sort: 20 }]);
    expect(calls(seen, 'staff_store_sort')[0].body).toEqual({ p_kind: 'collection:summer-picks', p_keys: ['p2', 'p1'] });
    // newest: its days are checked
    await page.locator('#tab-store .spc-row', { hasText: 'Coll eid' }).locator('button', { hasText: 'Edit' }).click();
    await expect(d.locator('#spc-days')).toHaveValue('14');
    await d.locator('#spc-days').fill('0');
    await d.locator('#spc-save').click();
    await expect(d.locator('.sto-err')).toContainText('Days');
  });

  test('delete asks, then deletes', async ({ page }) => {
    const cw = writes(page, 'store_collections');
    await staff(page, { ...CATALOG, store_collections: [coll('old')] });
    await view(page, 'collections');
    await page.locator('#tab-store .spc-row').locator('button', { hasText: 'Edit' }).click();
    await page.locator('#spc-dlg button', { hasText: 'Delete collection' }).click();
    await page.locator('#confirm-modal button', { hasText: 'Delete collection' }).click();
    await expect.poll(() => cw.length).toBe(1);
    expect(cw[0].method).toBe('DELETE');
    expect(cw[0].url).toContain('slug=eq.old');
  });
});

test.describe('@staff:store Store > Settings', () => {
  test('a first save on a database with no store.* keys writes only the key changed, never the form\'s defaults (fix round 2026-11-19)', async ({ page }) => {
    const sc = writes(page, 'site_content');
    await staff(page, { ...CATALOG, site_content: [] });
    await view(page, 'settings');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('#ps-pu')).toBeChecked(); // the delivery as the database reads an absent key
    await sec.locator('#ss-sort').selectOption('newest');
    await sec.locator('#ss-save').click();
    await expect.poll(() => sc.length).toBeGreaterThan(0);
    const by = Object.fromEntries((sc[0].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    expect(by).toEqual({ 'store.sort': 'newest' });
  });

  test('full mode: store.open, the order minutes and the delivery are written only when changed', async ({ page }) => {
    const sc = writes(page, 'site_content');
    await staff(page, { ...FULL, site_content: [] });
    await view(page, 'settings');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('#ps-open')).not.toBeChecked();
    await sec.locator('#ps-lic').fill('DL-1');
    await sec.locator('#ss-save').click();
    await expect.poll(() => sc.length).toBeGreaterThan(0);
    let by = Object.fromEntries((sc[0].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    expect(by).toEqual({ 'store.discountLicence': 'DL-1' });
    await expect(page.locator('#toast-container')).toContainText('Settings saved');
    await sec.locator('#ps-j').check();
    await sec.locator('#ss-save').click();
    await expect.poll(() => sc.length).toBeGreaterThan(1);
    by = Object.fromEntries((sc[sc.length - 1].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    expect(Object.keys(by)).toEqual(['store.delivery']);
    expect(by['store.delivery']).toEqual({ pickup: { on: true, fee: 0 }, jeddah: { on: true }, ksa: { on: false }, freeOver: null });
  });

  test('the catalogue build\'s keys are written in the shapes the website reads; a bad link is refused first', async ({ page }) => {
    const sc = writes(page, 'site_content');
    await staff(page, { ...FULL, site_content: [{ key: 'store.open', value: true, updated_at: NOW }, { key: 'store.delivery', value: { pickup: { on: true, fee: 0 }, jeddah: { on: false }, ksa: { on: false }, freeOver: null }, updated_at: NOW }] });
    await view(page, 'settings');
    await expect.poll(() => new URL(page.url()).pathname).toBe('/store/settings');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('#ps-open')).toBeChecked();
    await sec.locator('#ss-hte').fill('Ride further');
    await sec.locator('#ss-bn').check();
    await sec.locator('#ss-bne').fill('Free fitting this week');
    await expect(sec.locator('#spc-bnprev')).toHaveText('Free fitting this week');
    await sec.locator('#ss-bnt').selectOption('sale');
    await expect(sec.locator('#spc-bnprev')).toHaveClass(/spc-bn-sale/);
    await sec.locator('#ss-bnl').fill('//evil.example');
    await sec.locator('#ss-save').click();
    await expect(page.locator('#toast-container')).toContainText('https address');
    expect(sc).toHaveLength(0);
    await sec.locator('#ss-bnl').fill('/store/category/bikes');
    await sec.locator('#ss-bnf').fill('2026-11-20');
    await sec.locator('#ss-ste').fill('MicroMobility store');
    await expect(sec.locator('#spc-cnt-seoTe')).toHaveText('19/70');
    await sec.locator('#ss-sort').selectOption('newest');
    await sec.locator('#ss-ss').check();
    await sec.locator('#ss-ssu').fill('4');
    await sec.locator('#ss-nb').check();
    await sec.locator('#ss-min').fill('150');
    await sec.locator('#ss-max').fill('3');
    await sec.locator('#ss-save').click();
    await expect.poll(() => sc.length).toBeGreaterThan(0);
    const by = Object.fromEntries((sc[0].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    expect(by).toMatchObject({
      'store.heading': { title_en: 'Ride further', title_ar: null, intro_en: null, intro_ar: null },
      'store.banner': { on: true, en: 'Free fitting this week', ar: null, link: '/store/category/bikes', tone: 'sale', from: '2026-11-20', to: null },
      'store.seo': { title_en: 'MicroMobility store', title_ar: null, desc_en: null, desc_ar: null },
      'store.sort': 'newest', 'store.showStock': { on: true, under: 4 }, 'store.newBadge': { on: true, days: 30 }, 'store.minOrder': 150, 'store.maxPerOrder': 3,
    });
    for (const k of ['store.open', 'store.delivery', 'store.lowStock']) expect(by).not.toHaveProperty(k); // unchanged: not written
    await expect(page.locator('#toast-container')).toContainText('Settings saved'); // the save has read the rows again
    // Payments > Settings keeps the payments and the legal line only
    await page.evaluate(`S.payView='settings';setStaffTab('payments')`);
    await expect(page.locator('#tab-payments #ps-hold')).toBeVisible();
    await expect(page.locator('#tab-payments #ps-jfee')).toHaveCount(0);
    await expect(page.locator('#tab-payments #ps-open')).toHaveCount(0);
  });

  test('catalog mode: store.open is neither shown nor written', async ({ page }) => {
    const sc = writes(page, 'site_content');
    await staff(page, { ...CATALOG, site_content: [] });
    await view(page, 'settings');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('#ps-low')).toBeVisible();
    await expect(sec.locator('#ps-open')).toHaveCount(0);
    await sec.locator('#ps-low').fill('6');
    await sec.locator('#ss-save').click();
    await expect.poll(() => sc.length).toBeGreaterThan(0);
    const by = Object.fromEntries((sc[0].body as { key: string; value: unknown }[]).map((r) => [r.key, r.value]));
    expect(by['store.lowStock']).toBe(6);
    expect(by).not.toHaveProperty('store.open');
  });
});

test.describe('@staff:store Reports', () => {
  test('catalog: products by state, stock value and margin, by category and the moves, each table a CSV with a BOM', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { ...CATALOG, 'rpc:staff_store_report': report() });
    await view(page, 'reports');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('.stat-card', { hasText: 'Live' })).toContainText('5');
    await expect(sec.locator('.stat-card', { hasText: 'Value at price' })).toContainText('SAR 24,000');
    await expect(sec.locator('.stat-card', { hasText: 'Margin' })).toContainText('SAR 9,000');
    await expect(sec.locator('.stat-card', { hasText: 'Margin' })).toContainText('37.5%');
    await expect(sec.locator('.stat-card', { hasText: 'Without a cost price' })).toContainText('4');
    await expect(sec.locator('[aria-labelledby="spc-r-cat"] tbody tr')).toHaveCount(2);
    await expect(sec.locator('[aria-labelledby="spc-r-moves"] tbody tr')).toHaveCount(5); // the reasons that moved
    await expect(sec.locator('[aria-labelledby="spc-r-moves"] tbody tr').last()).toContainText('Copied from live'); // the hourly copy (sync)
    await expect(sec.locator('#spc-r-sl')).toHaveCount(0); // no sales in catalog mode
    const r0 = calls(seen, 'staff_store_report')[0].body as { p_from: string; p_to: string };
    expect(Math.round((Date.parse(r0.p_to) - Date.parse(r0.p_from)) / 864e5)).toBe(29);
    const [dl] = await Promise.all([page.waitForEvent('download'), sec.locator('[aria-labelledby="spc-r-cat"] button', { hasText: 'CSV' }).click()]);
    expect(dl.suggestedFilename()).toMatch(/^store-cat-\d{4}-\d\d-\d\d-\d{4}-\d\d-\d\d\.csv$/);
    const text = readFileSync(await dl.path() as string, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Category,Address on the website,Products,Units,Value at price,Cost');
    expect(text).toContain('Bikes,bikes,3,12,18000,12000');
    await sec.locator('.filter-pill', { hasText: 'Last 7 days' }).click();
    await expect.poll(() => calls(seen, 'staff_store_report').length).toBe(2);
    const r1 = calls(seen, 'staff_store_report')[1].body as { p_from: string; p_to: string };
    expect(Math.round((Date.parse(r1.p_to) - Date.parse(r1.p_from)) / 864e5)).toBe(6);
  });

  test('full: the sales by product, category and day', async ({ page }) => {
    await staff(page, { ...FULL, 'rpc:staff_store_report': report(SALES) });
    await view(page, 'reports');
    const sec = page.locator('#tab-store');
    await expect(sec.locator('#spc-r-sl')).toBeVisible();
    await expect(sec.locator('[aria-labelledby="spc-r-prod"] tbody tr')).toHaveCount(2);
    await expect(sec.locator('[aria-labelledby="spc-r-scat"] tbody tr').first()).toContainText('Bikes › Road');
    await expect(sec.locator('.spc-bar-r')).toHaveCount(2);
    await expect(sec.locator('.spc-bar-r').nth(1)).toContainText('4 orders');
  });

  test('a database without the report says so', async ({ page }) => {
    await staff(page, { ...CATALOG, 'rpc:staff_store_report': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_store_report in the schema cache' } } });
    await view(page, 'reports');
    await expect(page.locator('#tab-store')).toContainText('Reports are not set up');
  });
});
