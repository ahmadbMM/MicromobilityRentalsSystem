import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// ID or Iqama number on the account (the owner, 2026-10-14, for the Blood Donation event: "add all new fields in
// customer account info"): customers.national_id, 20261014190000, 10 digits starting 1 (ID) or 2 (Iqama). My Account
// reads it through customer_national_id and saves it through customer_set_national_id; the staff account editor reads
// it with the row and saves it with the account. Every number here is made up.

function rpcBodies(page: Page, fn: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && new RegExp(`/rpc/${fn}(\\?|$)`).test(r.url())) out.push(r.postDataJSON()); });
  return out;
}

test.describe('@customer:account ID or Iqama number', () => {
  async function account(page: Page, fx: Record<string, unknown>) {
    await stubSupabase(page, { sessions: [], queue_entries: [], 'rpc:my_bookings': [], 'rpc:customer_set_national_id': true, ...fx });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
  }

  test('shows the number the account holds', async ({ page }) => {
    await account(page, { 'rpc:customer_national_id': '2123456789' });
    await expect(page.locator('#acc-nid-in')).toHaveValue('2123456789');
    await expect(page.locator('#acc-nid')).toContainText('ID or Iqama number');
  });

  test('refuses a wrong number before any request, and saves Arabic digits as digits', async ({ page }) => {
    const sent = rpcBodies(page, 'customer_set_national_id');
    await account(page, { 'rpc:customer_national_id': null });
    await page.fill('#acc-nid-in', '3123456789');
    await page.locator('#acc-nid-save').click();
    await expect(page.locator('#acc-nid-err')).toHaveText('Enter your 10-digit ID or Iqama number.');
    await page.fill('#acc-nid-in', '12345');
    await page.locator('#acc-nid-save').click();
    await expect(page.locator('#acc-nid-err')).toHaveText('Enter your 10-digit ID or Iqama number.');
    expect(sent).toHaveLength(0);
    await page.fill('#acc-nid-in', '١٠٢٣ ٤٥٦ ٧٨٩');
    await page.locator('#acc-nid-save').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_id_no: '1023456789' });
    await expect(page.locator('#acc-nid-err')).toHaveText('');
  });

  test('a database from before the field shows no card', async ({ page }) => {
    await account(page, { 'rpc:customer_national_id': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.customer_national_id in the schema cache' } } });
    await expect(page.locator('#acc-em-host')).toBeAttached();
    await expect(page.locator('#acc-nid')).toHaveCount(0);
  });
});

test.describe('@staff:accounts ID or Iqama number', () => {
  const customers = [{ id: 'c1', name: 'Huda Saleh', email: 'huda@example.com', phone: '+966550000009', created_at: '2026-06-10T09:00:00Z',
    type_preference: 'Road', height: 165, national_id: '1023456789' }];

  async function editor(page: Page) {
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], customers });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`(S.customers||[]).length>0`);
  }

  test('the account editor shows, checks and saves it', async ({ page }) => {
    await editor(page);
    const sent: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/customers')) sent.push(r.postDataJSON()); });
    await page.evaluate(`showEditCustomerModal('c1')`);
    await expect(page.locator('#cf-nid')).toHaveValue('1023456789');
    await page.fill('#cf-nid', '99');
    await page.evaluate(`saveCustForm()`);
    await expect(page.locator('#cf-nid')).toBeFocused();
    expect(sent).toHaveLength(0);
    await page.fill('#cf-nid', '2987654321');
    await page.evaluate(`saveCustForm()`);
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({ national_id: '2987654321' });
  });

  test('never saves a number it could not read', async ({ page }) => {
    await editor(page);
    await page.route(/\/rest\/v1\/customers\?.*select=national_id/, (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '42703', message: 'column customers.national_id does not exist' }) }));
    const sent: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/customers')) sent.push(r.postDataJSON()); });
    await page.evaluate(`showEditCustomerModal('c1')`);
    await expect(page.locator('#cf-em-host')).toBeAttached();
    await expect(page.locator('#cf-nid')).toHaveCount(0);
    await page.evaluate(`saveCustForm()`);
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0]).not.toHaveProperty('national_id');
  });
});
