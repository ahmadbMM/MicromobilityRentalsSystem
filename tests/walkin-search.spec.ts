import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The walk-in name field is a search over accounts as well as a place to type a new name:
// matching accounts list under it (name, phone digits or email), picking one fills what the
// account knows and links the booking by id; "use as typed" books a walk-up with no account.

const S1 = '2099-01-09';
const sessions = [{ id: S1, day: 'Friday', session_date: S1, capacity: 12, status: 'open', created_at: 1 }];
const customers = [
  { id: 'c1', name: 'Amal Member', email: 'amal@example.test', phone: '+966500000001', height: 165, type_preference: 'Hybrid', created_at: '2026-08-20T10:00:00Z' },
  { id: 'c2', name: 'Bader Lapsed', email: 'bader@example.test', phone: '+966500000002', created_at: '2025-01-05T10:00:00Z' },
];

async function boot(page: import('@playwright/test').Page) {
  await stubSupabase(page, { sessions, customers, bikes: [], queue_entries: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getCustomers().length>0');
  await page.evaluate(`setStaffTab('queue');showWalkinModal()`);
}
const posted = (page: import('@playwright/test').Page) => {
  const out: Record<string, unknown>[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /queue_entries/.test(r.url())) { const b = JSON.parse(r.postData() || '[]'); out.push(...(Array.isArray(b) ? b : [b])); } });
  return out;
};

test('typing lists matching accounts; picking one fills phone, height and bike type and links by id', async ({ page }) => {
  await boot(page);
  const rows = posted(page);
  await page.locator('#wi-name').type('amal');
  const sug = page.locator('#wi-suggest');
  await expect(sug).toBeVisible();
  await expect(sug).toContainText('Use “amal” as typed');
  await expect(sug).toContainText('Amal Member');
  await expect(sug).not.toContainText('Bader');                   // ("am" alone would also hit bader@example.test - email matches are wanted)
  await sug.getByRole('option', { name: /Amal Member/ }).click();
  await expect(page.locator('#wi-name')).toHaveValue('Amal Member');
  await expect(page.locator('#wi-phone')).toHaveValue('+966500000001');
  await expect(page.locator('#wi-height')).toHaveValue('165');
  expect(await page.evaluate('[S._wiCustId, S._wiType]')).toEqual(['c1', 'Hybrid']);
  await expect(sug).toBeHidden();
  await page.evaluate(`saveWalkin()`);
  await expect.poll(() => rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ name: 'Amal Member', customer_id: 'c1', walk_in: false, type_preference: 'Hybrid' });
});

test('a name nobody has books as typed, with no account', async ({ page }) => {
  await boot(page);
  const rows = posted(page);
  await page.locator('#wi-name').type('Zed Newcomer');
  const sug = page.locator('#wi-suggest');
  await expect(sug).toContainText('Use “Zed Newcomer” as typed');
  await expect(sug.locator('.mw-sug')).toHaveCount(1);
  await page.locator('#wi-name').press('Enter');
  await expect(sug).toBeHidden();
  expect(await page.evaluate('S._wiCustId')).toBeNull();
  await page.evaluate(`_wiSetType('Road');saveWalkin()`); // no account to bring a type: one is picked (2026-10-28)
  await expect.poll(() => rows.length).toBe(1);
  expect(rows[0]).toMatchObject({ name: 'Zed Newcomer', customer_id: null, walk_in: true, type_preference: 'Road' });
});

test('phone digits find the account too, and typing again lets a picked account go', async ({ page }) => {
  await boot(page);
  await page.locator('#wi-name').type('0500000002');
  await expect(page.locator('#wi-suggest')).toContainText('Bader Lapsed');
  await page.locator('#wi-suggest').getByRole('option', { name: /Bader/ }).click();
  expect(await page.evaluate('S._wiCustId')).toBe('c2');
  await page.locator('#wi-name').fill('Bader L');
  expect(await page.evaluate('S._wiCustId')).toBeNull();
});
