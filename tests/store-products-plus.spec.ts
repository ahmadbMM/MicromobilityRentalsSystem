import { test, expect, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The store's product management (SPM-S2, 2026-11-19, rentals migration 20261119400100): the product editor's new fields
// (Preview, publish and unpublish times, badge, search-engine words, ordering and shipping, tags, collections, the staff-only
// cost, supplier, supplier SKU and note; a variant's barcode and cost), the category's template, the products list's search
// (a scanner gun's code and Enter), filters and row menu (Duplicate, History), the wider bulk edit, CSV export and import,
// stock adjust / count / receive and their history, and suppliers. All traffic stubbed (the functions as the build's
// CONTRACT.md names them); invented data only.

const NOW = '2026-11-19T09:00:00Z';
const prod = (id: string, x: Record<string, unknown> = {}) => ({
  id, slug: id + '-slug', category: 'accessories', brand: 'MM', name_en: 'Product ' + id, name_ar: null, tagline_en: null, tagline_ar: null,
  description_en: null, description_ar: null, specs: [], images: [], price: 100, compare_at: null, ship_ksa: true, published: true, sort: 0,
  kind: 'item', condition: 'new', warranty_months: null, key_specs: [], box: [], fit: null, faq: [], sizes: [], image_meta: {}, goes_with: [], compare_with: [],
  bundle: null, sale_from: null, sale_to: null, catalog_model: null, created_at: NOW, updated_at: NOW,
  preview: false, publish_at: null, unpublish_at: null, badge: null, badge_en: null, badge_ar: null, badge_until: null, seo_title_en: null, seo_title_ar: null,
  seo_desc_en: null, seo_desc_ar: null, max_per_order: null, preorder: false, ships_on: null, weight_g: null, dims_cm: null, tags: [], low_stock_at: null, ...x,
});
const vari = (id: string, pid: string, x: Record<string, unknown> = {}) => ({ id, product_id: pid, sku: null, barcode: null, size: null, color_en: null, color_ar: null, color_hex: null, price: null, stock: 10, active: true, sort: 0, ...x });
const SUP = { id: 7, name: 'Acme Cycles', contact: 'Omar', phone: '+966500000001', email: 'sales@acme.example', website: 'https://acme.example', note: null, active: true, created_at: NOW, updated_at: NOW };
const customers = [{ id: 'c1', name: 'Huda Buyer', email: null, phone: '+966501112233', created_at: '2026-01-01T00:00:00Z' }];

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
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function staff(page: Page, fx: Fixtures = {}) {
  const ops = [{ name: 'Spec Staff', has_pin: false }];
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, staff_options: [], 'rpc:staff_operator_list': ops, 'rpc:staff_store_ready': true,
    store_suppliers: [SUP], store_product_private: [], store_variant_costs: [], store_collection_items: [], ...fx });
  await unlockStaff(page);
  await page.goto('/?staff');
  await waitForSb(page);
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S.staffRole='admin';renderStaffTabs();`);
}
const view = (page: Page, v: string) => page.evaluate(`S.stoView='${v}';setStaffTab('store')`);
// S1's categories (with a sub-category and a template) and collections, as its build defines them
const S1 = `window._stoCats=()=>[{slug:'bikes',parent:null,name_en:'Bikes',sort:10,template:{specs:[{en:'Frame',ar:'الإطار'}],keys:['weight','gears'],box:['pedals'],warranty_months:36,ship_ksa:false}},
  {slug:'road',parent:'bikes',name_en:'Road',sort:11,template:{}},{slug:'accessories',parent:null,name_en:'Accessories',sort:20,template:{}},{slug:'gift',parent:null,name_en:'Gift cards',sort:60,template:{}}];
  window._stoCatLabel=s=>({bikes:'Bikes',road:'Bikes > Road',accessories:'Accessories',gift:'Gift cards'})[s]||s;
  window._stoColls=()=>[{slug:'summer',name_en:'Summer picks',kind:'manual'},{slug:'fresh',name_en:'Just in',kind:'new'}];`;
const pe = (page: Page) => page.locator('#sto-pe [role="dialog"]');
const dlg = (page: Page) => page.locator('#sps-dlg [role="dialog"]');
const sec = async (page: Page, l: string) => pe(page).locator('.sto-pe-sh', { hasText: l }).click();

test.describe('@staff:store the product editor\'s new fields (SPM-S2)', () => {
  test('a new product: visibility, badge, search engines, ordering, tags, collections, staff-only cost and supplier, a variant\'s barcode and cost', async ({ page }) => {
    const pw = writes(page, 'store_products'), vw = writes(page, 'store_variants'), privW = writes(page, 'store_product_private'),
      costW = writes(page, 'store_variant_costs'), collW = writes(page, 'store_collection_items');
    await staff(page, { store_products: [prod('pa', { name_en: 'Bottle' })], store_variants: [vari('va1', 'pa', { sku: 'BT-1', barcode: '6280000000017' })] });
    await page.evaluate(S1);
    await view(page, 'products');
    await page.locator('#tab-store button', { hasText: 'New product' }).click();
    const p = pe(page);
    await p.locator('#sto-pe-name_en').fill('Night Light');
    await p.locator('#sto-pe-price').fill('150');
    await p.locator('#sps-pe-preview').check();
    await p.locator('#sps-pe-pubD').fill('2026-12-01');
    await p.locator('#sps-pe-pubT').fill('09:30');
    await p.locator('#sps-pe-unpD').fill('2026-12-31');
    await sec(page, 'Badge');
    await p.locator('#sps-pe-badge').selectOption('custom');
    await p.locator('#sps-pe-badge_en').fill('Staff pick');
    await p.locator('#sps-pe-badge_ar').fill('اختيار الفريق');
    await sec(page, 'Search engines');
    await p.locator('#sps-pe-seo_title_en').fill('Night light for bikes');
    await expect(p.locator('#sps-cnt-seo_title_en')).toHaveText('21 / 70');
    await sec(page, 'Ordering and shipping');
    await p.locator('#sps-pe-max_per_order').fill('2');
    await p.locator('#sps-pe-low_stock_at').fill('4');
    await p.locator('#sps-pe-preorder').check();
    await p.locator('#sps-pe-ships_on').fill('2026-12-20');
    await p.locator('#sps-pe-weight_g').fill('850');
    await p.locator('#sps-pe-dl').fill('30');
    await p.locator('#sps-pe-dw').fill('20');
    await p.locator('#sps-pe-dh').fill('10');
    await sec(page, 'Tags');
    await p.locator('#sps-pe-tag').fill('commute');
    await p.locator('#sps-pe-tag').press('Enter');
    await p.locator('#sps-pe-tag').fill('night,');
    await expect(p.locator('.sto-chip', { hasText: 'night' })).toBeVisible();
    await sec(page, 'Collections');
    await expect(p.locator('.sps-colls .sto-chk')).toHaveCount(1); // the manual one only
    await p.locator('.sps-colls .sto-chk', { hasText: 'Summer picks' }).locator('input').check();
    await sec(page, 'Staff only');
    await p.locator('#sps-pe-cost').fill('90');
    await expect(p.locator('#sps-margin')).toContainText('SAR 60');
    await expect(p.locator('#sps-margin')).toContainText('40%');
    await p.locator('#sps-pe-supplier_id').selectOption('7');
    await p.locator('#sps-pe-supplier_sku').fill('ACME-NL');
    await p.locator('#sps-pe-staff_note').fill('Order in tens');
    await p.locator('button', { hasText: 'Add a variant' }).click();
    await p.locator('.sto-var input').nth(0).fill('NL-1');
    await p.locator('input[aria-label="Variant 1, barcode"]').fill('6280000000017'); // the other product's
    await p.locator('input[aria-label="Variant 1, cost price"]').fill('85');
    await p.locator('button', { hasText: /^Save$/ }).click();
    await expect(p.locator('.sto-err')).toContainText('Barcode 6280000000017 is on another variant');
    expect(pw).toHaveLength(0);
    await p.locator('input[aria-label="Variant 1, barcode"]').fill('6280000000024');
    await p.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => pw.length).toBe(1);
    const row = pw[0].body as Record<string, unknown>;
    expect(row).toMatchObject({ name_en: 'Night Light', price: 150, preview: true, publish_at: '2026-12-01T06:30:00.000Z', unpublish_at: '2026-12-30T21:00:00.000Z',
      badge: 'custom', badge_en: 'Staff pick', badge_ar: 'اختيار الفريق', seo_title_en: 'Night light for bikes', max_per_order: 2, low_stock_at: 4,
      preorder: true, ships_on: '2026-12-20', weight_g: 850, dims_cm: { l: 30, w: 20, h: 10 }, tags: ['commute', 'night'] });
    await expect.poll(() => vw.length).toBe(1);
    expect((vw[0].body as Record<string, unknown>[])[0]).toMatchObject({ sku: 'NL-1', barcode: '6280000000024' });
    await expect.poll(() => privW.length).toBe(1);
    expect(privW[0].body).toMatchObject({ product_id: row.id, supplier_id: 7, supplier_sku: 'ACME-NL', cost: 90, staff_note: 'Order in tens' });
    await expect.poll(() => costW.length).toBe(1);
    expect((costW[0].body as Record<string, unknown>[])[0]).toMatchObject({ cost: 85 });
    await expect.poll(() => collW.length).toBe(1);
    expect((collW[0].body as Record<string, unknown>[])[0]).toEqual({ collection: 'summer', product_id: row.id, sort: 10 });
    await expect(pe(page)).toHaveCount(0);
  });

  test('a saved product\'s fields read back; a collection taken off and a variant cost cleared are deleted; scheduled and badge chips', async ({ page }) => {
    const collW = writes(page, 'store_collection_items'), costW = writes(page, 'store_variant_costs'), privW = writes(page, 'store_product_private');
    await staff(page, {
      store_products: [prod('pa', { name_en: 'Lamp', published: true, publish_at: '2027-01-05T07:00:00Z', badge: 'best', tags: ['night'] })],
      store_variants: [vari('va1', 'pa', { sku: 'LP-1', barcode: '6280000000031' })],
      store_product_private: [{ product_id: 'pa', supplier_id: 7, supplier_sku: 'A-9', cost: 40, staff_note: null }],
      store_variant_costs: [{ variant_id: 'va1', cost: 38 }], store_collection_items: [{ collection: 'summer', product_id: 'pa', sort: 10 }] });
    await page.evaluate(S1);
    await view(page, 'products');
    const r = page.locator('#tab-store .sps-prow', { hasText: 'Lamp' });
    await expect(r.locator('.sps-p-sched')).toContainText('From');
    await expect(r.locator('.sps-p-badge')).toHaveText('Best seller');
    await r.locator('.sto-prod').click();
    const p = pe(page);
    await expect(p.locator('#sps-pe-pubD')).toHaveValue('2027-01-05');
    await expect(p.locator('#sps-pe-pubT')).toHaveValue('10:00');
    await expect(p.locator('input[aria-label="Variant 1, barcode"]')).toHaveValue('6280000000031');
    await expect(p.locator('input[aria-label="Variant 1, cost price"]')).toHaveValue('38');
    await sec(page, 'Staff only');
    await expect(p.locator('#sps-pe-cost')).toHaveValue('40');
    await expect(p.locator('#sps-pe-supplier_id')).toHaveValue('7');
    await sec(page, 'Collections');
    await p.locator('.sps-colls .sto-chk', { hasText: 'Summer picks' }).locator('input').uncheck();
    await p.locator('input[aria-label="Variant 1, cost price"]').fill('');
    await p.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => collW.length).toBe(1);
    expect(collW[0].method).toBe('DELETE');
    expect(collW[0].url).toContain('product_id=eq.pa');
    expect(decodeURIComponent(collW[0].url)).toContain('collection=in.(summer)');
    await expect.poll(() => costW.length).toBe(1);
    expect(costW[0].method).toBe('DELETE');
    expect(privW).toHaveLength(0); // nothing staff-only changed
  });

  test('a new product takes its category\'s template (a sub-category its parent\'s); Apply template adds only what is missing', async ({ page }) => {
    const pw = writes(page, 'store_products');
    await staff(page, { store_products: [prod('pa', { name_en: 'Old Bike', category: 'bikes', specs: [{ en: ['Frame', 'Steel'], ar: ['الإطار', 'فولاذ'] }] })], store_variants: [] });
    await page.evaluate(S1);
    await view(page, 'products');
    await page.locator('#tab-store button', { hasText: 'New product' }).click();
    const p = pe(page);
    await expect(p.locator('#sto-pe-category option')).toHaveText(['Bikes', 'Bikes > Road', 'Accessories', 'Gift cards']);
    await p.locator('#sto-pe-category').selectOption('road');
    await expect(p.locator('.sto-spec input').first()).toHaveValue('Frame');
    await expect(p.locator('#sto-pe-warranty')).toHaveValue('36');
    await expect(p.locator('#sto-pe-ship_ksa')).not.toBeChecked();
    await p.locator('#sto-pe-category').selectOption('accessories'); // its empty rows go with the other template
    await expect(p.locator('.sto-spec')).toHaveCount(0);
    await p.locator('#sto-pe-category').selectOption('road');
    await p.locator('.sto-spec input').nth(1).fill('6061 aluminium');
    await p.locator('#sto-pe-name_en').fill('Road One');
    await p.locator('#sto-pe-price').fill('2400');
    await p.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => pw.length).toBe(1);
    expect(pw[0].body).toMatchObject({ category: 'road', warranty_months: 36, ship_ksa: false, specs: [{ en: ['Frame', '6061 aluminium'], ar: ['الإطار', '6061 aluminium'] }],
      key_specs: [], box: [] }); // icons with no words are not saved
    // a saved bike: Apply template keeps its own Frame and adds the key specs and the box
    await page.locator('#tab-store .sto-prod', { hasText: 'Old Bike' }).click();
    await p.locator('button', { hasText: 'Apply the category template' }).click();
    await expect(page.locator('#toast-container')).toContainText('Template applied: 5 added');
    await expect(p.locator('.sto-spec')).toHaveCount(1);
  });

  test('a database before the migration: no new fields, and none written', async ({ page }) => {
    const pw = writes(page, 'store_products'), vw = writes(page, 'store_variants');
    const old = { ...prod('pa', { name_en: 'Bottle' }) } as Record<string, unknown>;
    for (const k of ['preview', 'publish_at', 'unpublish_at', 'badge', 'badge_en', 'badge_ar', 'badge_until', 'seo_title_en', 'seo_title_ar', 'seo_desc_en', 'seo_desc_ar', 'max_per_order', 'preorder', 'ships_on', 'weight_g', 'dims_cm', 'tags', 'low_stock_at']) delete old[k];
    await staff(page, { store_products: [old], store_variants: [{ id: 'va1', product_id: 'pa', sku: 'BT-1', size: null, color_en: null, color_ar: null, color_hex: null, price: null, stock: 3, active: true, sort: 0 }] });
    for (const tb of ['store_suppliers', 'store_product_private', 'store_variant_costs', 'store_collection_items']) {
      await page.route(new RegExp(`/rest/v1/${tb}`), (route) => json(route, { code: 'PGRST205', message: `Could not find the table 'public.${tb}' in the schema cache` }, 404));
    }
    await view(page, 'products');
    await page.locator('#tab-store .sto-prod', { hasText: 'Bottle' }).click();
    const p = pe(page);
    await expect(p.locator('#sto-pe-name_en')).toHaveValue('Bottle');
    await expect(p.locator('#sps-pe-preview')).toHaveCount(0);
    await expect(p.locator('.sto-pe-sh', { hasText: 'Staff only' })).toHaveCount(0);
    await expect(p.locator('input[aria-label="Variant 1, barcode"]')).toHaveCount(0);
    await p.locator('#sto-pe-price').fill('120');
    await p.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => pw.length).toBe(1);
    expect(pw[0].body).not.toHaveProperty('preview');
    expect(pw[0].body).not.toHaveProperty('tags');
    await expect.poll(() => vw.length).toBe(1);
    expect((vw[0].body as Record<string, unknown>[])[0]).not.toHaveProperty('barcode');
  });
});

test.describe('@staff:store the products list: search, a scanner gun, filters, row menu (SPM-S2)', () => {
  const prods = [prod('pa', { name_en: 'Bottle', tags: ['hydration'], created_at: '2026-11-01T00:00:00Z' }), prod('pb', { name_en: 'Draft lamp', published: false, preview: true, sort: 10 }),
    prod('pc', { name_en: 'Gloves', published: false, sort: 20, badge: 'sale' }), prod('pd', { name_en: 'Helmet', category: 'road', sort: 30, low_stock_at: 5 })];
  const vars = [vari('va1', 'pa', { sku: 'BT-1', barcode: '6281111111111', stock: 9 }), vari('vb1', 'pb', { stock: 0 }), vari('vc1', 'pc', { stock: 2 }), vari('vd1', 'pd', { sku: 'HM-M', stock: 4 })];
  test('search by name, SKU or barcode; Enter on an exact barcode opens the product; filters by state, stock, category, tag', async ({ page }) => {
    await staff(page, { store_products: prods, store_variants: vars, store_product_private: [{ product_id: 'pd', supplier_id: 7, supplier_sku: 'AC-HM', cost: 50, staff_note: null }] });
    await page.evaluate(S1);
    await view(page, 'products');
    const rows = page.locator('#tab-store .sto-prods .sto-prod');
    await expect(rows).toHaveCount(4);
    await expect(page.locator('#tab-store .sps-prow', { hasText: 'Draft lamp' }).locator('.sps-p-prev')).toHaveText('Preview');
    await expect(page.locator('#tab-store .sps-prow', { hasText: 'Draft lamp' }).locator('.sps-p-out')).toHaveText('Out of stock');
    await expect(page.locator('#tab-store .sps-prow', { hasText: 'Helmet' }).locator('.sto-p-low')).toHaveText('Low stock'); // its own level, 5
    await page.locator('#sps-q').fill('hm-m');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Helmet');
    await page.locator('#sps-q').fill('AC-HM'); // the supplier's SKU
    await expect(rows).toHaveCount(1);
    await page.locator('#sps-q').fill('6281111111111');
    await page.locator('#sps-q').press('Enter');
    await expect(pe(page)).toContainText('Edit Bottle');
    await expect(page.locator('#sps-q')).toHaveValue('');
    await page.evaluate('_stoPeClose()');
    await page.locator('#tab-store .f-show').click();
    await page.locator('#sps-f-st').selectOption('draft');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Gloves');
    await page.locator('#sps-f-st').selectOption('preview');
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Draft lamp');
    await page.locator('#sps-f-st').selectOption('');
    await page.locator('#sps-f-stock').selectOption('out');
    await expect(rows).toHaveCount(1);
    await page.locator('#sps-f-stock').selectOption('');
    await page.locator('#sps-f-cat').selectOption('bikes'); // with its sub-categories
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('Helmet');
    await page.locator('#tab-store .f-clr').click();
    await expect(rows).toHaveCount(4);
    await page.locator('#sps-f-sort').selectOption('newest');
    await expect(rows.first()).toContainText('Draft lamp');
    await expect(rows.last()).toContainText('Bottle');
  });

  test('Reorder sends the whole order; the row menu duplicates through the database and shows a product\'s stock history', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { store_products: prods, store_variants: vars, 'rpc:staff_store_sort': 4, 'rpc:staff_store_duplicate': 'new-id',
      'rpc:staff_store_stock_moves': [{ id: 3, at: NOW, variant_id: 'va1', product_id: 'pa', label: 'Bottle', delta: -2, stock_after: 9, reason: 'damaged', note: 'Dropped', supplier: null, unit_cost: null, ref: null, by_name: 'Spec Staff' }] });
    await view(page, 'products');
    await page.locator('#tab-store button', { hasText: 'Reorder' }).click();
    await page.locator('#tab-store button[aria-label="Move Draft lamp up"]').click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_sort').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_sort')!.body).toEqual({ p_kind: 'products', p_keys: ['pb', 'pa', 'pc', 'pd'] });
    await expect(page.locator('#tab-store .sto-prods .sto-prod').first()).toContainText('Draft lamp');
    await page.locator('#tab-store button', { hasText: 'Reorder' }).click();
    // Duplicate: the name and the address asked in a small pop-up
    await page.locator('#tab-store .sps-prow', { hasText: 'Gloves' }).locator('.rq-more').click();
    await page.locator('.row-sheet .pay-menu-opt', { hasText: 'Duplicate' }).click();
    await expect(page.locator('#sps-dup-name')).toHaveValue('Gloves (copy)');
    await expect(page.locator('#sps-dup-slug')).toHaveValue('pc-slug-copy');
    await page.locator('#sps-dup-slug').fill('cart');
    await dlg(page).locator('.chrome-dact button', { hasText: 'Duplicate' }).click();
    await expect(dlg(page).locator('.sto-err')).toBeVisible();
    await page.locator('#sps-dup-slug').fill('winter-gloves');
    await page.locator('#sps-dup-name').fill('Winter gloves');
    await dlg(page).locator('.chrome-dact button', { hasText: 'Duplicate' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_duplicate').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_duplicate')!.body).toEqual({ p_product: 'pc', p_slug: 'winter-gloves', p_name_en: 'Winter gloves' });
    await expect(page.locator('#toast-container')).toContainText('Copy made: Winter gloves');
    // History
    await page.locator('#tab-store .sps-prow', { hasText: 'Bottle' }).locator('.rq-more').click();
    await page.locator('.row-sheet .pay-menu-opt', { hasText: 'Stock history' }).click();
    await expect(dlg(page)).toContainText('Stock history: Bottle');
    await expect(dlg(page).locator('.sps-mvr')).toHaveCount(1);
    await expect(dlg(page).locator('.sps-mvr')).toContainText('-2');
    await expect(dlg(page).locator('.sps-mvr')).toContainText('Damaged');
    expect(seen.filter((c) => c.name === 'staff_store_stock_moves').pop()!.body).toMatchObject({ p_product: 'pa', p_from: null, p_limit: 1000 });
  });

  test('a duplicate the database refuses (the address taken) is said in the pop-up', async ({ page }) => {
    await staff(page, { store_products: prods, store_variants: vars,
      'rpc:staff_store_duplicate': { __rpcError: { status: 400, code: 'P0001', message: 'STORE_SLUG' } } });
    await view(page, 'products');
    await page.locator('#tab-store .sps-prow', { hasText: 'Gloves' }).locator('.rq-more').click();
    await page.locator('.row-sheet .pay-menu-opt', { hasText: 'Duplicate' }).click();
    await dlg(page).locator('.chrome-dact button', { hasText: 'Duplicate' }).click();
    await expect(dlg(page).locator('.sto-err')).toContainText('Another product has that address');
  });
});

test.describe('@staff:store bulk edit through staff_store_bulk (SPM-S2)', () => {
  test('select all of the filtered rows, publish them; tags added as a list; delete asks first; a refusal is said', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { store_products: [prod('pa', { name_en: 'Bottle', published: false }), prod('pb', { name_en: 'Lamp', published: false }), prod('pc', { name_en: 'Gloves' })],
      store_variants: [], 'rpc:staff_store_bulk': 2 });
    await view(page, 'products');
    await page.locator('#tab-store .f-show').click();
    await page.locator('#sps-f-st').selectOption('draft');
    await page.locator('#tab-store button', { hasText: 'Bulk edit' }).click();
    await page.locator('#tab-store button', { hasText: 'Select all' }).click();
    await expect(page.locator('#sto-bulk-go')).toHaveText('Apply to 2');
    await page.locator('#sto-bulk-m').selectOption('publish');
    await page.locator('#sto-bulk-go').click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_bulk').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_bulk')!.body).toEqual({ p_ids: ['pa', 'pb'], p_action: 'publish', p_value: null });
    await expect(page.locator('#toast-container')).toContainText('Publish · 2 products');
    // tags
    await page.locator('#tab-store button', { hasText: 'Bulk edit' }).click();
    await page.locator('#tab-store button', { hasText: 'Select all' }).click();
    await page.locator('#sto-bulk-m').selectOption('tags_add');
    await page.locator('#sps-bk-tags').fill('winter, gift ideas');
    await page.locator('#sto-bulk-go').click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_bulk').length).toBe(2);
    expect(seen.filter((c) => c.name === 'staff_store_bulk')[1].body).toMatchObject({ p_action: 'tags_add', p_value: ['winter', 'gift ideas'] });
    // delete: confirmed first
    await page.locator('#tab-store button', { hasText: 'Bulk edit' }).click();
    await page.locator('#tab-store .sto-prod-pick', { hasText: 'Bottle' }).locator('input').check();
    await page.locator('#sto-bulk-m').selectOption('delete');
    await page.locator('#sto-bulk-go').click();
    await expect(page.locator('#confirm-modal')).toContainText('Delete 1 products?');
    expect(seen.filter((c) => c.name === 'staff_store_bulk')).toHaveLength(2);
    await page.locator('#confirm-modal .btn-red').click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_bulk').length).toBe(3);
    expect(seen.filter((c) => c.name === 'staff_store_bulk')[2].body).toMatchObject({ p_ids: ['pa'], p_action: 'delete' });
  });

  test('a schedule is sent in Riyadh time; the database\'s refusal is said', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { store_products: [prod('pa', { name_en: 'Bottle' })], store_variants: [],
      'rpc:staff_store_bulk': { __rpcError: { status: 400, code: 'P0001', message: 'STORE_LICENCE: compare_at' } } });
    await view(page, 'products');
    await page.locator('#tab-store button', { hasText: 'Bulk edit' }).click();
    await page.locator('#tab-store .sto-prod-pick', { hasText: 'Bottle' }).locator('input').check();
    await page.locator('#sto-bulk-m').selectOption('schedule');
    await page.locator('#sps-bk-pd').fill('2026-12-01');
    await page.locator('#sps-bk-pdt').fill('08:00');
    await page.locator('#sto-bulk-go').click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_bulk').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_bulk')!.body).toMatchObject({ p_action: 'schedule', p_value: { publish_at: '2026-12-01T05:00:00.000Z', unpublish_at: null } });
    await expect(page.locator('#toast-container')).toContainText('discount licence');
  });
});

test.describe('@staff:store CSV export and import (SPM-S2)', () => {
  test('export: one line per variant, the contract\'s columns in order, a BOM; the blank template is the header alone', async ({ page }) => {
    await staff(page, { store_products: [prod('pa', { name_en: 'Bottle, steel', slug: 'bottle', tags: ['hydration', 'steel'], description_en: 'Line one\nline "two"' }), prod('pb', { name_en: 'Lamp', slug: 'lamp' })],
      store_variants: [vari('va1', 'pa', { sku: 'BT-S', size: 'S', stock: 3 }), vari('va2', 'pa', { sku: 'BT-L', size: 'L', stock: 0, active: false })],
      store_product_private: [{ product_id: 'pa', supplier_id: 7, supplier_sku: 'AC-1', cost: 12.5, staff_note: null }], store_variant_costs: [{ variant_id: 'va2', cost: 14 }] });
    await view(page, 'products');
    await page.locator('#tab-store button', { hasText: 'Export CSV' }).click();
    const [dl] = await Promise.all([page.waitForEvent('download'), dlg(page).locator('button', { hasText: 'All products (2)' }).click()]);
    const txt = readFileSync((await dl.path())!).toString('utf8');
    expect(txt.charCodeAt(0)).toBe(0xfeff);
    const lines = txt.slice(1).split('\n');
    expect(lines[0]).toBe('slug,name_en,name_ar,category,brand,price,compare_at,published,preview,tagline_en,tagline_ar,description_en,description_ar,tags,badge,badge_en,badge_ar,max_per_order,preorder,ships_on,weight_g,ship_ksa,warranty_months,condition,seo_title_en,seo_title_ar,seo_desc_en,seo_desc_ar,cost,supplier,supplier_sku,sku,barcode,size,color_en,color_ar,color_hex,variant_price,stock,variant_active,variant_cost');
    expect(txt).toContain('bottle,"Bottle, steel",,accessories,MM,100,,yes,no,,,"Line one\nline ""two""",,hydration|steel,');
    expect(txt).toContain(',12.5,Acme Cycles,AC-1,BT-S,,S,,,,,3,yes,');
    expect(txt).toContain(',BT-L,,L,,,,,0,no,14');
    expect(txt).toContain('\nlamp,Lamp,');
    await page.locator('#tab-store button', { hasText: 'Export CSV' }).click();
    const [dl2] = await Promise.all([page.waitForEvent('download'), dlg(page).locator('button', { hasText: 'Blank template' }).click()]);
    expect(dl2.suggestedFilename()).toBe('store-products-template.csv');
    expect(readFileSync((await dl2.path())!).toString('utf8').trim().split('\n')).toHaveLength(1);
  });

  test('import: a semicolon file with quotes and Arabic, any header case; the dry run\'s refusals said per line; then the real run, all at once', async ({ page }) => {
    const sent: Record<string, unknown>[] = [];
    await staff(page, { store_products: [prod('pa', { name_en: 'Bottle', slug: 'bottle' })], store_variants: [] });
    await page.route(/\/rest\/v1\/rpc\/staff_store_import/, async (route) => {
      const b = route.request().postDataJSON() as Record<string, unknown>; sent.push(b);
      const rows = b.p_rows as Record<string, string>[];
      const bad = rows.findIndex((r) => r.price === 'abc');
      if (bad >= 0) return json(route, { ok: false, dry: true, products: { created: 1, updated: 1 }, variants: { created: 1, updated: 0 }, suppliers: { created: 0 },
        errors: [{ row: bad + 1, col: 'price', code: 'STORE_NUMBER' }, { row: 1, col: 'category', code: 'store_products_category_fkey' }] });
      return json(route, { ok: true, dry: !!b.p_dry, products: { created: 1, updated: 1 }, variants: { created: 2, updated: 0 }, suppliers: { created: 1 }, errors: [] });
    });
    await view(page, 'products');
    await page.locator('#tab-store button', { hasText: 'Export CSV' }).click();
    await dlg(page).locator('button', { hasText: 'Import CSV' }).click();
    const file = (rows: string) => ({ name: 'stock.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + rows, 'utf8') });
    const csv1 = 'SLUG;Name EN;name_ar;Category;Price;Colour_EN;stock;Notes\r\nbottle;Bottle;قارورة;nope;"45";Blue;"3"\r\nnew-cap;"Cap; ""cool""\nline";;apparel;abc;;5;x\r\n';
    let ch = page.waitForEvent('filechooser');
    await dlg(page).locator('button', { hasText: 'Choose a CSV file' }).click();
    await (await ch).setFiles(file(csv1));
    await expect(dlg(page).locator('.sps-ie li')).toHaveCount(2);
    await expect(dlg(page).locator('.sps-ie li').first()).toContainText('Line 3');
    await expect(dlg(page).locator('.sps-ie li').first()).toContainText('Write a number');
    await expect(dlg(page).locator('.sps-ie li').nth(1)).toContainText('Line 2');
    await expect(dlg(page).locator('.sps-ie li').nth(1)).toContainText('No category with that address');
    await expect(dlg(page)).toContainText('Columns left out: Notes');
    await expect(dlg(page).locator('button', { hasText: 'Import 2 lines' })).toBeDisabled();
    expect(sent[0]).toEqual({ p_dry: true, p_rows: [{ slug: 'bottle', name_en: 'Bottle', name_ar: 'قارورة', category: 'nope', price: '45', color_en: 'Blue', stock: '3' },
      { slug: 'new-cap', name_en: 'Cap; "cool"\nline', category: 'apparel', price: 'abc', stock: '5' }] });
    const csv2 = 'slug,name_en,category,price,sku,stock\nbottle,Bottle,accessories,45,BT-1,3\nnew-cap,Cap,apparel,30,CP-1,5\n';
    ch = page.waitForEvent('filechooser');
    await dlg(page).locator('button', { hasText: 'Choose another file' }).click();
    await (await ch).setFiles(file(csv2));
    await expect(dlg(page)).toContainText('Ready to import');
    await expect(dlg(page)).toContainText('Products: 1 new, 1 changed');
    await dlg(page).locator('button', { hasText: 'Import 2 lines' }).click();
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2]).toMatchObject({ p_dry: false });
    await expect(page.locator('#toast-container')).toContainText('Imported: 2 products');
  });
});

test.describe('@staff:store stock: adjust, count, receive, history; suppliers (SPM-S2)', () => {
  test('a variant\'s Adjust (damaged takes away) and Count, from the editor', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { store_products: [prod('pa', { name_en: 'Bottle' })], store_variants: [vari('va1', 'pa', { sku: 'BT-1', stock: 9 })],
      'rpc:staff_store_stock_move': { id: 'va1', stock: 7 }, 'rpc:staff_store_stock_count': { id: 'va1', stock: 12 } });
    await view(page, 'products');
    await page.locator('#tab-store .sto-prod', { hasText: 'Bottle' }).click();
    await pe(page).locator('button', { hasText: 'Adjust or count' }).click();
    await expect(dlg(page)).toContainText('9 in stock');
    await page.locator('#sps-stk-rsn').selectOption('damaged');
    await expect(dlg(page).locator('label[for="sps-stk-qty"]')).toHaveText('Quantity taken away');
    await page.locator('#sps-stk-qty').fill('2');
    await page.locator('#sps-stk-note').fill('Dropped');
    await dlg(page).locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_stock_move').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_stock_move')!.body).toEqual({ p_variant: 'va1', p_delta: -2, p_reason: 'damaged', p_note: 'Dropped' });
    await expect(pe(page)).toContainText('7 in stock');
    await pe(page).locator('button', { hasText: 'Adjust or count' }).click();
    await dlg(page).locator('.filter-pill', { hasText: 'Count' }).click();
    await page.locator('#sps-stk-cnt').fill('12');
    await dlg(page).locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_stock_count').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_stock_count')!.body).toEqual({ p_variant: 'va1', p_count: 12, p_note: null });
    await expect(pe(page)).toContainText('12 in stock');
  });

  test('a refused move is said in the pop-up (not enough stock)', async ({ page }) => {
    await staff(page, { store_products: [prod('pa', { name_en: 'Bottle' })], store_variants: [vari('va1', 'pa', { stock: 1 })],
      'rpc:staff_store_stock_move': { __rpcError: { status: 400, code: 'P0001', message: 'STORE_STOCK' } } });
    await page.evaluate(`_stoProdLoad(true)`);
    await expect.poll(() => page.evaluate('(_sto().vars||[]).length')).toBe(1);
    await page.evaluate(`_spsStkOpen('va1')`);
    await page.locator('#sps-stk-rsn').selectOption('lost');
    await page.locator('#sps-stk-qty').fill('3');
    await dlg(page).locator('button', { hasText: /^Save$/ }).click();
    await expect(dlg(page).locator('.sto-err')).toContainText('Not enough stock');
  });

  test('receive a delivery: lines by a scanned barcode and by search, the supplier, unit costs written as cost prices', async ({ page }) => {
    const seen = rpcCalls(page);
    await staff(page, { store_products: [prod('pa', { name_en: 'Bottle' }), prod('pb', { name_en: 'Helmet' })],
      store_variants: [vari('va1', 'pa', { sku: 'BT-1', barcode: '6281111111111', stock: 1 }), vari('vb1', 'pb', { sku: 'HM-M', size: 'M', stock: 0 })],
      site_content: [{ key: 'store.lowStock', value: 2, updated_at: NOW }], 'rpc:staff_store_receive': { moves: 2, units: 13 } });
    await view(page, 'stock');
    await page.locator('#tab-store button', { hasText: 'Receive delivery' }).click();
    const d = dlg(page);
    await page.locator('#sps-rcv-q').fill('6281111111111');
    await page.locator('#sps-rcv-q').press('Enter'); // a scanner gun
    await page.locator('#sps-rcv-q').fill('6281111111111');
    await page.locator('#sps-rcv-q').press('Enter'); // the same code again: one more of it
    await expect(d.locator('.sps-rl:not(.sto-kh)')).toHaveCount(1);
    await expect(d.locator('input[aria-label="Bottle · BT-1, quantity"]')).toHaveValue('2');
    await page.locator('#sps-rcv-q').fill('helmet');
    await d.locator('.sps-res', { hasText: 'Helmet' }).click();
    await d.locator('input[aria-label="Helmet · M, quantity"]').fill('11');
    await d.locator('input[aria-label="Helmet · M, unit cost"]').fill('120');
    await page.locator('#sps-rcv-sup').selectOption('7');
    await page.locator('#sps-rcv-ref').fill('INV-204');
    await page.locator('#sps-rcv-set').check();
    await d.locator('.chrome-dact button', { hasText: 'Receive' }).click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_receive').length).toBe(1);
    expect(seen.find((c) => c.name === 'staff_store_receive')!.body).toEqual({ p_items: [{ variant: 'va1', qty: 2, cost: null }, { variant: 'vb1', qty: 11, cost: 120 }],
      p_supplier: 7, p_ref: 'INV-204', p_note: null, p_set_cost: true });
    await expect(page.locator('#toast-container')).toContainText('Received: 13 units');
  });

  test('stock history with its filters and CSV; suppliers listed, added and changed', async ({ page }) => {
    const seen = rpcCalls(page), supW = writes(page, 'store_suppliers');
    await staff(page, { store_products: [prod('pa', { name_en: 'Bottle' })], store_variants: [vari('va1', 'pa')],
      store_product_private: [{ product_id: 'pa', supplier_id: 7, supplier_sku: null, cost: null, staff_note: null }],
      'rpc:staff_store_stock_moves': [
        { id: 2, at: NOW, variant_id: 'va1', product_id: 'pa', label: 'Bottle', delta: 10, stock_after: 10, reason: 'receive', note: null, supplier: 'Acme Cycles', unit_cost: 11, ref: 'INV-1', by_name: 'Spec Staff' },
        { id: 1, at: NOW, variant_id: 'va1', product_id: 'pa', label: 'Bottle', delta: -1, stock_after: 9, reason: 'order', note: null, supplier: null, unit_cost: null, ref: null, by_name: null }] });
    await page.route(/\/rest\/v1\/store_suppliers/, (route) => route.request().method() === 'POST'
      ? json(route, [{ ...SUP, id: 9, name: 'Bolt Parts', contact: null, phone: null, email: null, website: null }], 201) : route.fallback());
    await view(page, 'products');
    await page.locator('#tab-store button', { hasText: 'Stock history' }).click(); // S1 makes it a view; until then a pop-up
    const d = dlg(page);
    await expect(d.locator('.sps-mvr')).toHaveCount(2);
    await expect(d.locator('.sps-mvr').first()).toContainText('Delivery received');
    await expect(d.locator('.sps-mvr').first()).toContainText('INV-1');
    expect(seen.filter((c) => c.name === 'staff_store_stock_moves').pop()!.body).toMatchObject({ p_product: null, p_reason: null, p_limit: 1000 });
    await d.locator('.f-show').click();
    await page.locator('#sps-mv-rsn').selectOption('receive');
    await expect.poll(() => seen.filter((c) => c.name === 'staff_store_stock_moves').pop()!.body.p_reason).toBe('receive');
    const [dl] = await Promise.all([page.waitForEvent('download'), d.locator('button', { hasText: 'Export CSV' }).click()]);
    const csv = readFileSync((await dl.path())!).toString('utf8');
    expect(csv).toContain('Date,Time,Product,Change,Stock after,Reason,Note,Reference,Supplier,Unit cost,By');
    expect(csv).toContain('Bottle,10,10,Delivery received,,INV-1,Acme Cycles,11,Spec Staff');
    await d.locator('.chrome-dact button', { hasText: 'Close' }).click();
    // suppliers
    await page.locator('#tab-store button', { hasText: 'Suppliers' }).click();
    await expect(d.locator('.sto-row')).toHaveCount(1);
    await expect(d.locator('.sto-row')).toContainText('Acme Cycles');
    await expect(d.locator('.sto-row')).toContainText('1 products');
    await d.locator('button', { hasText: 'New supplier' }).click();
    const f = page.locator('#sps-sup [role="dialog"]');
    await f.locator('button', { hasText: /^Save$/ }).click();
    await expect(f.locator('.sto-err')).toContainText('Write the supplier\'s name');
    await page.locator('#sps-sup-name').fill('acme cycles');
    await f.locator('button', { hasText: /^Save$/ }).click();
    await expect(f.locator('.sto-err')).toContainText('Another supplier has that name');
    await page.locator('#sps-sup-name').fill('Bolt Parts');
    await page.locator('#sps-sup-email').fill('not-an-email');
    await f.locator('button', { hasText: /^Save$/ }).click();
    await expect(f.locator('.sto-err')).toContainText('Check the email address');
    await page.locator('#sps-sup-email').fill('hi@bolt.example');
    await f.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => supW.length).toBe(1);
    expect(supW[0].body).toMatchObject({ name: 'Bolt Parts', email: 'hi@bolt.example', active: true });
    await expect(d.locator('.sto-row')).toHaveCount(2);
    await d.locator('.sto-row', { hasText: 'Acme Cycles' }).click();
    await expect(f).toContainText('Bottle');
    await page.locator('#sps-sup-active').uncheck();
    await f.locator('button', { hasText: /^Save$/ }).click();
    await expect.poll(() => supW.length).toBe(2);
    expect(supW[1].method).toBe('PATCH');
    expect(supW[1].url).toContain('id=eq.7');
    expect(supW[1].body).toMatchObject({ name: 'Acme Cycles', active: false });
  });

  test('a new supplier from the editor\'s picker is chosen for the product', async ({ page }) => {
    await staff(page, { store_products: [prod('pa', { name_en: 'Bottle' })], store_variants: [] });
    await page.route(/\/rest\/v1\/store_suppliers/, (route) => route.request().method() === 'POST'
      ? json(route, [{ ...SUP, id: 12, name: 'Crank Co' }], 201) : route.fallback());
    await view(page, 'products');
    await page.locator('#tab-store .sto-prod', { hasText: 'Bottle' }).click();
    await sec(page, 'Staff only');
    await pe(page).locator('#sps-pe-supplier_id').selectOption('__new');
    await page.locator('#sps-sup-name').fill('Crank Co');
    await page.locator('#sps-sup [role="dialog"] button', { hasText: /^Save$/ }).click();
    await expect(pe(page).locator('#sps-pe-supplier_id')).toHaveValue('12');
  });
});
