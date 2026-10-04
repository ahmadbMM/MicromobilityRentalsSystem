import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The bike catalogue on micromobility.sa/bikes is edited from the staff page (owner, 2026-09-26):
// categories with sub-types, the models in them, and each model's specifications, colours and
// photos. Admin only, under the Website group. Every save is a plain PostgREST write to the
// catalog_* tables (20260927100000); the site reads the same rows with the public key.

const sessions = [{ id: '2099-05-05', day: 'Tuesday', session_date: '2099-05-05', capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00"}' }];
const at = '2026-09-27T10:00:00Z';
const catalog = {
  catalog_categories: [
    { id: 'c-road', parent_id: null, slug: 'road', name_en: 'Road', name_ar: 'طريق', blurb_en: '', blurb_ar: '', cover: null, sort: 1, published: true, updated_at: at },
    { id: 'c-carbon', parent_id: 'c-road', slug: 'carbon', name_en: 'Carbon', name_ar: 'كربون', blurb_en: '', blurb_ar: '', cover: null, sort: 0, published: true, updated_at: at },
    { id: 'c-kids', parent_id: null, slug: 'kids', name_en: 'Kids', name_ar: 'أطفال', blurb_en: '', blurb_ar: '', cover: null, sort: 5, published: true, updated_at: at },
  ],
  catalog_spec_fields: [
    { key: 'frame', label_en: 'Frame', label_ar: 'الإطار', group_en: 'Frame', group_ar: 'الهيكل', unit_en: '', unit_ar: '', sort: 10 },
    { key: 'weight', label_en: 'Weight', label_ar: 'الوزن', group_en: 'Frame', group_ar: 'الهيكل', unit_en: 'kg', unit_ar: 'كجم', sort: 40 },
  ],
  catalog_models: [
    { id: 'm-1', category_id: 'c-road', subtype_id: 'c-carbon', slug: 'battle-aero', brand: 'Battle', name: 'Aero 3', model_year: 2026, ride_type: 'Road Carbon',
      tagline_en: 'Fast.', tagline_ar: '', description_en: '', description_ar: '', specs: { frame: { en: 'Carbon', ar: 'كربون' } }, spec_sheet: null, sort: 0, published: true, updated_at: at },
  ],
  catalog_colors: [{ id: 'col-1', model_id: 'm-1', name_en: 'Black', name_ar: 'أسود', hex: '#111111', sort: 0 }],
  catalog_photos: [{ id: 'ph-1', model_id: 'm-1', color_id: 'col-1', url: '/media/catalog/m-1/a.jpg', alt_en: '', alt_ar: '', sort: 0, is_cover: true }],
};

type Write = { table: string; method: string; url: string; body: unknown; prefer: string };
async function open(page: Page, extra: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], ...catalog, ...extra });
  await unlockStaff(page);
  const writes: Write[] = [];
  page.on('request', r => {
    const m = r.url().match(/\/rest\/v1\/(catalog_[a-z_]+)(\?|$)/);
    if (m && r.method() !== 'GET' && r.method() !== 'OPTIONS') {
      let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
      writes.push({ table: m[1], method: r.method(), url: decodeURIComponent(r.url()), body, prefer: r.headers()['prefer'] || '' });
    }
  });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('catalog')`);
  await expect(page.locator('#tab-catalog .cat-pills')).toBeVisible();
  return writes;
}
const panel = (page: Page) => page.locator('#tab-catalog');
const row = (v: unknown) => (Array.isArray(v) ? v[0] : v) as Record<string, unknown>;

test('admins find it under Website; Front Desk does not', async ({ page }) => {
  await open(page);
  const item = page.locator('#staff-tab-nav .tab-btn[data-stab="catalog"]');
  await expect(item).toHaveText('Bikes catalog');
  await expect(item).toHaveClass(/active/);
  await expect(panel(page)).toContainText('What micromobility.sa/bikes shows');
  await page.evaluate(`S.staffRole='frontdesk';renderStaffTabs();setStaffTab('catalog')`);
  await expect(item).toBeHidden();
  expect(await page.evaluate('S.staffTab')).toBe('queue');
});

test('lists the models with their place in the catalogue and their address on the site', async ({ page }) => {
  await open(page);
  const r = panel(page).locator('tr[data-model="battle-aero"]');
  await expect(r).toContainText('Battle Aero 3');
  await expect(r).toContainText('/bikes/road/carbon/battle-aero');
  await expect(r).toContainText('Road › Carbon');
  await expect(r).toContainText('Road Carbon');
  await expect(r.locator('.cat-pub')).toHaveText('Published');
  await expect(r.getByRole('button', { name: 'View on the site' })).toBeVisible();
});

test('a new model takes its address from the brand and name, and is saved with its colours', async ({ page }) => {
  const writes = await open(page);
  await panel(page).getByRole('button', { name: '+ Add model' }).click();
  await page.locator('#ce-brand').fill('Alvas');
  await page.locator('#ce-name').fill('Sprint 2');
  await expect(page.locator('#ce-slug')).toHaveValue('alvas-sprint-2');
  await expect(page.locator('#ce-slug-hint')).toContainText('/bikes/road/alvas-sprint-2');
  await page.locator('#ce-sub').selectOption('c-carbon');
  await expect(page.locator('#ce-slug-hint')).toContainText('/bikes/road/carbon/alvas-sprint-2');
  await page.locator('#ce-ride').selectOption('Road');
  // The Frame specification, English and Arabic; an empty one is never written.
  await page.locator('#cat-editor input[aria-label="Frame (English)"]').fill('Aluminium');
  await panel(page).getByRole('button', { name: '+ Add colour' }).click();
  await page.locator('#ce-col-0-en').fill('Red');
  await page.locator('#ce-save').click();
  await expect(page.locator('.toast').last()).toContainText('Saved');
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[0].table).toBe('catalog_models');
  expect(writes[0].method).toBe('POST');
  expect(writes[0].prefer).toContain('merge-duplicates');
  const m = row(writes[0].body);
  expect(typeof m.id).toBe('string');
  expect(m).toMatchObject({ brand: 'Alvas', name: 'Sprint 2', slug: 'alvas-sprint-2', category_id: 'c-road', subtype_id: 'c-carbon', ride_type: 'Road', published: false, specs: { frame: { en: 'Aluminium' } } });
  expect(writes[1].table).toBe('catalog_colors');
  expect(row(writes[1].body)).toMatchObject({ model_id: m.id, name_en: 'Red', sort: 0 });
});

test('an address another model already uses is refused before anything is sent', async ({ page }) => {
  const writes = await open(page);
  await panel(page).getByRole('button', { name: '+ Add model' }).click();
  await page.locator('#ce-brand').fill('Battle');
  await page.locator('#ce-name').fill('Aero 4');
  await page.locator('#ce-slug').fill('battle-aero');
  await page.locator('#ce-save').click();
  await expect(page.locator('#ce-err')).toHaveText('Another model already uses this address.');
  expect(writes).toHaveLength(0);
});

test('publishing from the list is one update, put back if the database refuses', async ({ page }) => {
  const writes = await open(page);
  const pub = panel(page).locator('tr[data-model="battle-aero"] .cat-pub');
  await pub.click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].method).toBe('PATCH');
  expect(writes[0].url).toContain('id=eq.m-1');
  expect(writes[0].body).toEqual({ published: false });
  await expect(pub).toHaveText('Draft');
});

test('the categories view shows the tree; a sub-type is saved under its category', async ({ page }) => {
  const writes = await open(page);
  await panel(page).getByRole('button', { name: /^Categories/ }).click();
  await expect(panel(page).locator('.cat-tree li[data-cat="carbon"]')).toHaveClass(/sub/);
  await expect(panel(page).locator('.cat-tree li[data-cat="road"]')).toContainText('1 models');
  // Road cannot be deleted while it holds Carbon and a model; Kids can.
  await expect(panel(page).locator('.cat-tree li[data-cat="road"]').getByRole('button', { name: 'Delete' })).toBeDisabled();
  await expect(panel(page).locator('.cat-tree li[data-cat="kids"]').getByRole('button', { name: 'Delete' })).toBeEnabled();
  await panel(page).locator('.cat-tree li[data-cat="road"]').getByRole('button', { name: '+ Add sub-type' }).click();
  await page.locator('#cc-name-en').fill('Endurance');
  await expect(page.locator('#cc-slug')).toHaveValue('endurance');
  await page.locator('#cc-name-ar').fill('تحمّل');
  await page.locator('#cc-save').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].table).toBe('catalog_categories');
  expect(row(writes[0].body)).toMatchObject({ parent_id: 'c-road', slug: 'endurance', name_en: 'Endurance', name_ar: 'تحمّل', published: true });
});

test('the specification fields view lists them with their unit; a new key is made safe', async ({ page }) => {
  const writes = await open(page);
  await panel(page).getByRole('button', { name: /^Specification fields/ }).click();
  await expect(panel(page).locator('tr[data-field="weight"]')).toContainText('kg');
  await panel(page).getByRole('button', { name: '+ Add field' }).click();
  await page.locator('#cf-key').fill('Tyre Width');
  await page.locator('#cf-label').fill('Tyre width');
  await page.locator('#cf-unit').fill('mm');
  await page.locator('#cf-save').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].table).toBe('catalog_spec_fields');
  expect(writes[0].prefer).toContain('merge-duplicates');
  expect(row(writes[0].body)).toMatchObject({ key: 'tyre_width', label_en: 'Tyre width', unit_en: 'mm' });
});

test('a model needs a name and a category before anything is sent', async ({ page }) => {
  const writes = await open(page, { catalog_categories: [] });
  await expect(panel(page).getByRole('button', { name: '+ Add model' })).toBeDisabled();
  await expect(panel(page)).toContainText('Add a category first');
  expect(writes).toHaveLength(0);
});

test('before the database update it says so, instead of failing', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await page.route(/\/rest\/v1\/catalog_categories(\?|$)/, r => r.fulfill({
    status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'PGRST205', message: "Could not find the table 'public.catalog_categories' in the schema cache" }),
  }));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('catalog')`);
  await expect(panel(page)).toContainText("isn't set up yet");
});

// The editor puts the caret in Brand a moment after it opens (the phone's keyboard settles first). A
// staffer - or a test - already typing in another field by then kept losing the rest of the word to
// Brand: "Sprint 2" typed into Name landed in Brand, and the address came out alvassprint-2
// (2026-10-01; _catFocusLater).
test('the editor does not pull the caret back to Brand once another field has it', async ({ page }) => {
  await open(page);
  await panel(page).getByRole('button', { name: '+ Add model' }).click();
  // straight into Name, before the editor's own focus lands
  await page.evaluate(`(()=>{const n=document.getElementById('ce-name');n.focus();})()`);
  await page.waitForTimeout(120);
  expect(await page.evaluate(`document.activeElement&&document.activeElement.id`)).toBe('ce-name');
  await page.keyboard.type('Sprint 2');
  await page.locator('#ce-brand').fill('Alvas');
  await expect(page.locator('#ce-name')).toHaveValue('Sprint 2');
  await expect(page.locator('#ce-slug')).toHaveValue('alvas-sprint-2');
});

test('moving a category numbers every sibling by its new place (no tie with the stored order)', async ({ page }) => {
  const top = (id: string, slug: string, name: string, sort: number) => ({ id, parent_id: null, slug, name_en: name, name_ar: '', blurb_en: '', blurb_ar: '', cover: null, sort, published: true, updated_at: at });
  const cats = [top('c-road', 'road', 'Road', 1), top('c-mtb', 'mountain', 'Mountain', 2), top('c-hyb', 'hybrid', 'Hybrid', 3), top('c-grav', 'gravel', 'Gravel', 4), top('c-kids', 'kids', 'Kids', 5)];
  const writes = await open(page, { catalog_categories: cats, catalog_models: [], catalog_colors: [], catalog_photos: [] });
  await panel(page).getByRole('button', { name: /^Categories/ }).click();
  await panel(page).locator('.cat-tree li[data-cat="hybrid"]').getByRole('button', { name: 'Move down' }).click();
  await expect.poll(() => writes.length).toBe(4);
  const sort: Record<string, number> = Object.fromEntries(cats.map(c => [c.id, c.sort]));
  for (const w of writes) sort[(w.url.match(/id=eq\.([\w-]+)/) || [])[1]] = (w.body as { sort: number }).sort;
  // the seed values 1..5 used to tie Gravel with Mountain, and the name put Gravel first
  expect(Object.keys(sort).sort((a, b) => sort[a] - sort[b])).toEqual(['c-road', 'c-mtb', 'c-grav', 'c-hyb', 'c-kids']);
});

test('a category cover replaced or removed leaves the bucket only when the category is saved', async ({ page }) => {
  const cover = '/media/catalog/categories/c-kids/old.jpg';
  const cats = catalog.catalog_categories.map(c => c.id === 'c-kids' ? { ...c, cover } : c);
  const writes = await open(page, { catalog_categories: cats });
  const removed: string[] = [];
  page.on('request', r => { if (r.url().includes('/storage/v1/object/site') && r.method() === 'DELETE') removed.push(r.postData() || ''); });
  await page.route(/\/storage\/v1\/object\/site/, r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await panel(page).getByRole('button', { name: /^Categories/ }).click();
  const kids = () => panel(page).locator('.cat-tree li[data-cat="kids"]');
  // removed, then cancelled: the saved row still points at the file, so it stays
  await kids().getByRole('button', { name: 'Edit' }).click();
  await page.locator('#cat-cat-editor .web-ed-img .btn-red').click();
  await page.locator('#cat-cat-editor').getByRole('button', { name: 'Cancel' }).click();
  await page.waitForTimeout(300);
  expect(removed).toHaveLength(0);
  // removed, then saved: now it goes
  await kids().getByRole('button', { name: 'Edit' }).click();
  await page.locator('#cat-cat-editor .web-ed-img .btn-red').click();
  await page.locator('#cc-save').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(row(writes[0].body)).toMatchObject({ id: 'c-kids', cover: null });
  await expect.poll(() => removed.length).toBe(1);
  expect(removed[0]).toContain('catalog/categories/c-kids/old.jpg');
});
