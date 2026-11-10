import { test, expect } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Country of residence offers every country (Israel is not one of them); city of residence
// stays dimmed until a country is chosen, then offers every city of that country, fetched
// from cities/<iso2>.json.

const sessions = [{ id: '2099-01-01', session_date: '2099-01-01', day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }];
const opts = (sel: string) => `[...document.querySelectorAll('${sel} option')].map(o=>[o.value,o.textContent])`;

test('every country but Israel has a city file, and each file is a list of names', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [] });
  await page.goto('/');
  await waitForSb(page);
  const codes = await page.evaluate(`NATIONALITIES.map(([c])=>c.toLowerCase())`) as string[];
  expect(codes).not.toContain('il');
  expect(existsSync('cities/il.json')).toBe(false);
  expect(readdirSync('cities').sort()).toEqual(codes.map(c => `${c}.json`).sort());
  const sa = await page.evaluate(`fetch('cities/sa.json').then(r=>r.json())`) as string[][];
  expect(sa.length).toBeGreaterThan(100);
  expect(sa.every(r => typeof r[0] === 'string' && r.length <= 2)).toBe(true);
});

test('Account: every country, and the city waits for one', async ({ page }) => {
  await stubSupabase(page, {
    sessions, queue_entries: [],
    'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', nationality: null, gender: 'male' }],
    'rpc:customer_update_profile': true,
  });
  await loginCustomer(page, { id: 'c1' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account','residence')`);

  const countries = await page.evaluate(opts('#acc-country')) as [string, string][];
  expect(countries[0][0]).toBe('');
  expect(countries[1][0]).toBe('Saudi Arabia');
  expect(countries.length).toBeGreaterThan(190);
  const names = countries.map(c => c[0]);
  expect(names).toContain('Palestine');
  expect(names).toContain('Japan');
  expect(names).not.toContain('Israel');

  const city = page.locator('#acc-city');
  await expect(city).toBeDisabled();
  expect(await city.evaluate(el => Number(getComputedStyle(el).opacity))).toBeLessThan(1);

  await page.selectOption('#acc-country', 'Saudi Arabia');
  await expect(city).toBeEnabled();
  await expect.poll(() => city.evaluate(el => Number(getComputedStyle(el).opacity))).toBe(1);   // fades in over .2s
  await expect.poll(() => city.locator('option').count()).toBeGreaterThan(100);
  const sa = (await page.evaluate(opts('#acc-city')) as [string, string][]).map(o => o[0]);
  for (const c of ['Riyadh', 'Jeddah', 'Khobar', 'Mecca', 'Hail', 'Jubail', 'Al Ola']) expect(sa).toContain(c);
  expect(sa).not.toContain('Cairo');

  await page.selectOption('#acc-country', 'Egypt');
  await expect.poll(async () => (await page.evaluate(opts('#acc-city')) as [string, string][]).map(o => o[0])).toContain('Cairo');
  expect((await page.evaluate(opts('#acc-city')) as [string, string][]).map(o => o[0])).not.toContain('Riyadh');
  await page.selectOption('#acc-city', 'Alexandria');

  const calls: string[] = [];
  page.on('request', r => { if (/rpc\/customer_update_profile/.test(r.url())) calls.push(r.postData() || ''); });
  await page.evaluate(`_accPgSave('residence')`);
  await expect.poll(() => calls.length).toBe(1);
  expect(JSON.parse(calls[0])).toMatchObject({ p_country: 'Egypt', p_city: 'Alexandria' });

  await page.selectOption('#acc-country', '');
  await expect(city).toBeDisabled();
  await expect(city.locator('option')).toHaveCount(1);
});

test('a saved city survives the wait for its list, and one the list lacks is kept', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  await page.route('**/cities/sa.json*', async route => { await held; await route.continue(); });
  await stubSupabase(page, { sessions, queue_entries: [] });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', country: 'Saudi Arabia', city: 'Khobar' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account','residence')`);
  const city = page.locator('#acc-city');
  await expect(city).toHaveValue('Khobar');          // before the list arrives: the saved city alone
  await expect(city.locator('option')).toHaveCount(2);
  release();
  await expect.poll(() => city.locator('option').count()).toBeGreaterThan(100);
  await expect(city).toHaveValue('Khobar');

  await page.evaluate(`S.loggedIn={...S.loggedIn,city:'Nowhere Village'};renderAccount()`);
  await expect(city).toHaveValue('Nowhere Village'); // not on the list, still not dropped on save

  await page.evaluate(`setLang('ar')`);
  expect((await page.evaluate(opts('#acc-city')) as [string, string][]).find(o => o[0] === 'Riyadh')?.[1]).toBe('الرياض');
});

test('staff account form: the city waits for a country and saves with it', async ({ page }) => {
  const customers = [{ id: 'c2', name: 'Bader Rider', email: 'bader@example.test', phone: '+966500000002', gender: 'male', created_at: '2025-01-05T10:00:00Z' }];
  await stubSupabase(page, { customers, tags: [], customer_tags: [], sessions, queue_entries: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getCustomers().length>0');

  const patches: string[] = [];
  page.on('request', r => { if (r.method() === 'PATCH' && /customers/.test(r.url())) patches.push(r.postData() || ''); });
  await page.evaluate(`showEditCustomerModal('c2')`);
  const city = page.locator('#cf-city');
  await expect(city).toBeDisabled();
  expect((await page.evaluate(opts('#cf-country')) as [string, string][]).map(o => o[0])).not.toContain('Israel');
  await page.selectOption('#cf-country', 'Saudi Arabia');
  await expect(city).toBeEnabled();
  await expect.poll(() => city.locator('option').count()).toBeGreaterThan(100);
  await page.selectOption('#cf-city', 'Dammam');
  await page.evaluate(`saveCustForm()`);
  await expect.poll(() => patches.length).toBeGreaterThan(0);
  expect(JSON.parse(patches[0])).toMatchObject({ country: 'Saudi Arabia', city: 'Dammam' });
});
