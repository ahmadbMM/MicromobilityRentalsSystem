import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The bike form's lists (brands with their models, groupsets, frame types) are shared rows in
// staff_options, edited from a ✎ beside each field. Models hang off brands: Model is disabled
// until a brand is chosen, shows only that brand's models, and a new model lands under it.

const sessions = [{ id: '2099-01-09', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }];
const staff_options = [
  { key: 'bike_brands', items: [{ name: 'Giant', models: ['TCR'] }, { name: 'Trek', models: ['Domane', 'Emonda'] }] },
  { key: 'bike_groupsets', items: ['Shimano 105', 'Ultegra'] },
  { key: 'bike_frames', items: [] },
];

async function boot(page: import('@playwright/test').Page) {
  const lists: typeof staff_options = JSON.parse(JSON.stringify(staff_options));   // each test gets its own copy: saves mutate it
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], staff_options: lists });
  // The stub answers every read from the fixtures: a saved list must land in them too, or the
  // reference reload that follows a write would hand the old list straight back.
  await page.route(/\/rest\/v1\/staff_options/, async (route) => {
    if (route.request().method() === 'POST') {
      const b = JSON.parse(route.request().postData() || '{}');
      const row = lists.find(r => r.key === b.key); if (row) row.items = b.items; else lists.push({ key: b.key, items: b.items });
    }
    await route.fallback();
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.staffOptions && S.staffOptions.bike_brands`);
  await page.waitForTimeout(300);               // let the boot's reference reload land (the app never goes network-idle: it polls)
  await page.evaluate(`setStaffTab('inventory');S.invSection='bikes';renderInventory();S.showAddBike=true;S._bkBrand='';S._bkModel='';renderBikes()`);   // the Bikes UI lives under Inventory > Bikes
}
const upserts = (page: import('@playwright/test').Page) => {
  const out: Record<string, unknown>[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /staff_options/.test(r.url())) out.push(JSON.parse(r.postData() || '{}')); });
  return out;
};

test('Model waits for a Brand, then offers only that brand\'s models', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#bk-model')).toBeDisabled();
  await expect(page.locator('#bk-model')).toContainText('Choose a brand first');
  expect(await page.evaluate(`[...document.querySelectorAll('#bk-brand option')].map(o=>o.value)`)).toEqual(['', 'Giant', 'Trek', '__add__']);
  await page.selectOption('#bk-brand', 'Trek');
  await expect(page.locator('#bk-model')).toBeEnabled();
  expect(await page.evaluate(`[...document.querySelectorAll('#bk-model option')].map(o=>o.value)`)).toEqual(['', 'Domane', 'Emonda', '__add__']);
  await page.selectOption('#bk-model', 'Emonda');
  await page.selectOption('#bk-brand', 'Giant');                      // a new brand drops the model
  expect(await page.evaluate('S._bkModel')).toBe('');
  expect(await page.evaluate(`[...document.querySelectorAll('#bk-model option')].map(o=>o.value)`)).toEqual(['', 'TCR', '__add__']);
});

test('a new model typed in lands under the chosen brand, in the shared list', async ({ page }) => {
  await boot(page);
  const posts = upserts(page);
  await page.selectOption('#bk-brand', 'Trek');
  await page.selectOption('#bk-model', '__add__');
  await page.fill('#bk-model', 'Madone');
  await page.evaluate(`_bkOptSave('bk-model')`);
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].key).toBe('bike_brands');
  const trek = (posts[0].items as { name: string; models: string[] }[]).find(b => b.name === 'Trek')!;
  expect(trek.models).toEqual(['Domane', 'Emonda', 'Madone']);
  expect(await page.evaluate('S._bkModel')).toBe('Madone');
});

test('the ✎ beside Brand edits the shared list: rename, remove, add', async ({ page }) => {
  await boot(page);
  const posts = upserts(page);
  await page.locator('.opt-edit[data-on-click*="brands"]').click();
  const modal = page.locator('#optlist-modal');
  await expect(modal).toContainText('Edit Brand');
  await modal.locator('input[aria-label="Giant"]').fill('Giant Bicycles');
  await modal.locator('button[aria-label$="Trek"]').click();           // remove Trek
  await modal.locator('#optlist-add').fill('Specialized');
  await modal.locator('#optlist-add').press('Enter');
  await modal.locator('#optlist-save').click();
  await expect.poll(() => posts.length).toBe(1);
  const items = posts[0].items as { name: string; models: string[] }[];
  expect(items.map(b => b.name)).toEqual(['Giant Bicycles', 'Specialized']);
  expect(items.find(b => b.name === 'Giant Bicycles')!.models).toEqual(['TCR']);   // a rename keeps its models
  expect(items.find(b => b.name === 'Specialized')!.models).toEqual([]);            // a new brand starts empty, never another's models
  await expect(modal).toBeHidden();
  // a reference reload from boot may still land with the pre-save list; the fixture now holds
  // the saved one, so re-render and read until the form shows it
  await expect.poll(() => page.evaluate(`(renderBikes(),[...document.querySelectorAll('#bk-brand option')].map(o=>o.value))`)).toEqual(['', 'Giant Bicycles', 'Specialized', '__add__']);
});

test('Models of a brand and frame types have their own editors', async ({ page }) => {
  await boot(page);
  const posts = upserts(page);
  await page.selectOption('#bk-brand', 'Trek');
  await page.locator('.opt-edit[data-on-click*="models"]').click();
  await expect(page.locator('#optlist-modal')).toContainText('Edit Models of Trek');
  await page.locator('#optlist-modal button[aria-label$="Domane"]').click();
  await page.locator('#optlist-modal #optlist-save').click();
  await expect.poll(() => posts.length).toBe(1);
  expect((posts[0].items as { name: string; models: string[] }[]).find(b => b.name === 'Trek')!.models).toEqual(['Emonda']);
  expect(await page.evaluate(`[...document.querySelectorAll('#bk-frame option')].map(o=>o.value)`)).toEqual(['', 'Steel', 'Aluminum', 'Carbon', 'Titanium']);   // defaults while the list is empty
  await page.locator('.opt-edit[data-on-click*="frames"]').click();
  await page.locator('#optlist-modal #optlist-add').fill('Bamboo');
  await page.locator('#optlist-modal #optlist-add').press('Enter');
  await page.locator('#optlist-modal #optlist-save').click();
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toMatchObject({ key: 'bike_frames' });
  // a reference reload may still be in flight from the first save; whatever it returns now
  // carries Bamboo, so re-render and read until the form shows it
  await expect.poll(() => page.evaluate(`(renderBikes(),[...document.querySelectorAll('#bk-frame option')].map(o=>o.value))`)).toContain('Bamboo');
});

// The bike number is suggested, not imposed: staff may type another; one already on a live
// bike is called out under the field and refused at save. Kids bikes get the K prefix.
test('the bike number can be edited; a taken one is called out; Kids names start with K', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], staff_options, bikes: [{ id: 'b1', name: 'R-AL-0001-M', type: 'Road', size: 'M', status: 'available', bike_number: 1, frame_type: 'Aluminum', colors: [] }] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getBikes().length>0');
  await page.evaluate(`setStaffTab('inventory');S.invSection='bikes';renderInventory();S.showAddBike=true;S._bkNumber='';S.addBikeType='Kids';S._bkFrame='Aluminum';renderBikes()`);
  const num = page.locator('#bk-number');
  await expect(num).toBeEnabled();
  await expect(num).toHaveValue('2');                                     // the next free number, suggested
  await expect(page.locator('#bk-name')).toHaveAttribute('placeholder', /^K-AL-0002-/);
  await num.fill('7');
  await expect(page.locator('#bk-name')).toHaveAttribute('placeholder', /^K-AL-0007-/);
  await expect(page.locator('#bk-number-hint')).toContainText('suggested');
  await num.fill('1');
  await expect(page.locator('#bk-number-hint')).toContainText('Already used by R-AL-0001-M');
  await page.evaluate(`renderBikes()`);                                    // a repaint keeps what was typed
  await expect(page.locator('#bk-number')).toHaveValue('1');
});

// Specs on the form: wheel size and brakes from editable lists, weight in kg - saved with the
// bike and shown with it.
test('wheel size, brakes and weight are on the form, saved with the bike, and listed with it', async ({ page }) => {
  const lists = JSON.parse(JSON.stringify(staff_options));
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], staff_options: lists });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`S.staffOptions && S.staffOptions.bike_brands`);
  await page.evaluate(`setStaffTab('inventory');S.invSection='bikes';renderInventory();S.showAddBike=true;S.addBikeType='Road';S._bkFrame='Aluminum';S.addBikeSize='M';renderBikes()`);
  await expect(page.locator('#bk-add-form')).toContainText('Category');
  expect(await page.evaluate(`[...document.querySelectorAll('#bk-wheel option')].map(o=>o.value)`)).toEqual(['', '20"', '24"', '26"', '27.5"', '29"', '700c', '__add__']);
  expect(await page.evaluate(`[...document.querySelectorAll('#bk-brake option')].map(o=>o.value)`)).toEqual(['', 'Rim', 'Disc — mechanical', 'Disc — hydraulic', '__add__']);
  await page.selectOption('#bk-wheel', '700c');
  await page.selectOption('#bk-brake', 'Disc — hydraulic');
  await page.fill('#bk-weight', '8.75');
  const posts: Record<string, unknown>[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /\/rest\/v1\/bikes/.test(r.url())) posts.push(JSON.parse(r.postData() || '{}')); });
  await page.evaluate(`addBike()`);
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ wheel_size: '700c', brake_type: 'Disc — hydraulic', weight_kg: 8.8 });   // one decimal
  // ✎ beside Brakes edits its list too
  await page.evaluate(`S.showAddBike=true;renderBikes()`);
  await page.locator('.opt-edit[data-on-click*="brakes"]').click();
  await expect(page.locator('#optlist-modal')).toContainText('Edit Brakes');
});
