import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-07 (catalogue, History, vendors): the catalogue's model search lost the field after
// one letter, History could not pick out Kids / Road Carbon / own-bike riders, an own-bike rider with
// nothing to pay was offered for "mark paid", and a model year outside the table's range came back
// as a bare "could not save".

const ksa = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const TODAY = ksa(new Date());
const S_TODAY = `${TODAY}-a`;
const sessions = [{ id: S_TODAY, day: 'Friday', session_date: TODAY, capacity: 12, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '19:00 - 21:00' }) }];
const row = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: S_TODAY, session_day: 'Friday', session_date: TODAY, queue_num: 1, name, phone: '0500000001', email: '',
  type_preference: 'Hybrid', size: 'M', status: 'done', paid: false, price: 60, registered_at: `${TODAY}T10:00:00Z`, ...extra,
});
const at = '2026-09-27T10:00:00Z';
const model = (id: string, slug: string, brand: string, name: string) => ({
  id, category_id: 'c-road', subtype_id: null, slug, brand, name, model_year: 2026, ride_type: 'Road',
  tagline_en: '', tagline_ar: '', description_en: '', description_ar: '', specs: {}, spec_sheet: null, sort: 0, published: false, updated_at: at,
});
const catalog = {
  catalog_categories: [{ id: 'c-road', parent_id: null, slug: 'road', name_en: 'Road', name_ar: '', blurb_en: '', blurb_ar: '', cover: null, sort: 1, published: true, updated_at: at }],
  catalog_spec_fields: [],
  catalog_models: [model('m-1', 'alvas-sprint', 'Alvas', 'Sprint'), model('m-2', 'trek-domane', 'Trek', 'Domane')],
  catalog_colors: [], catalog_photos: [],
};

async function boot(page: Page, fx: Record<string, unknown>) {
  await stubSupabase(page, { sessions, bikes: [], ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test('@staff:catalog the model search keeps its field while typing', async ({ page }) => {
  await boot(page, { queue_entries: [], ...catalog });
  await page.evaluate(`setStaffTab('catalog')`);
  await expect(page.locator('#tab-catalog tr[data-model]')).toHaveCount(2);
  const q = page.locator('#tab-catalog .cat-bar input.search-input');
  if (!(await q.isVisible())) await page.locator('[data-srch="cat"] .srch-btn').click(); // a phone folds the search into a button
  await q.click();
  await q.pressSequentially('trek');
  await expect(q).toHaveValue('trek');
  await expect(q).toBeFocused();
  await expect(page.locator('#tab-catalog tr[data-model]')).toHaveCount(1);
  await expect(page.locator('#tab-catalog tr[data-model="trek-domane"]')).toBeVisible();
});

test('@staff:catalog a model year outside 1990-2100 is said in the form, nothing sent', async ({ page }) => {
  await boot(page, { queue_entries: [], ...catalog });
  const writes: string[] = [];
  page.on('request', r => { if (/\/rest\/v1\/catalog_/.test(r.url()) && !['GET', 'OPTIONS', 'HEAD'].includes(r.method())) writes.push(r.url()); });
  await page.evaluate(`setStaffTab('catalog')`);
  await page.locator('#tab-catalog tr[data-model="alvas-sprint"]').getByRole('button', { name: 'Edit' }).click();
  await page.locator('#ce-year').fill('1985');
  await page.locator('#ce-save').click();
  await expect(page.locator('#ce-err')).toHaveText(await page.evaluate(`t('catErrYear')`) as string); // "Model year: from 1990 to 2100."
  await expect(page.locator('#ce-err')).not.toHaveText(await page.evaluate(`t('catSaveErr')`) as string);
  expect(writes).toEqual([]);
});

test('@staff:history the type filter offers every booked type, and an own-bike rider with nothing to pay is not offered for "mark paid"', async ({ page }) => {
  await boot(page, { queue_entries: [
    row('h1', 'Kids Rider', { type_preference: 'Kids' }),
    row('h2', 'Carbon Rider', { type_preference: 'Road Carbon', price: 250 }),
    row('h3', 'Own Rider', { type_preference: 'Own', price: 0 }),
  ] });
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('history');renderHistory()`);
  const opts = await page.evaluate(`[...document.querySelectorAll('#tab-history select[data-on-change*="setHistType"] option')].map(o=>o.value)`) as string[];
  for (const ty of ['Kids', 'Road Carbon', 'Own']) expect(opts).toContain(ty);
  await page.evaluate(`setHistType('Road Carbon')`);
  await expect(page.locator('#hist-results tbody tr .rider-name')).toHaveCount(1);
  await expect(page.locator('#hist-results tbody tr .rider-name').first()).toContainText('Carbon Rider');
  await page.evaluate(`setHistType('all')`);
  // Two owe (Kids, Road Carbon); the own-bike rider reads "—" where the payment goes and has no box.
  await expect(page.locator('#hist-results button[data-on-click*="toggleHistSelect"]')).toHaveCount(2);
  const writes: string[] = [];
  page.on('request', r => { if (r.method() === 'PATCH' && /queue_entries/.test(r.url())) writes.push(r.url()); });
  await page.evaluate(`S.histSelected=['h3','h1'];bulkHistMarkPaid()`);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toContain('id=eq.h1');
});
