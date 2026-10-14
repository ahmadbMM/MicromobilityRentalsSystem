import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Blood type on the account (the owner, 2026-10-14: "create a field for the accounts ... and allow people to add
// their blood type in my accounts section"): customers.blood_type, 20261014180000. My Account reads it through
// customer_blood_type and saves it through customer_set_blood_type in its own card; the staff account editor reads
// it with the row and saves it with the account, never when it could not read it. Everyone here is made up.

function rpcBodies(page: Page, fn: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && new RegExp(`/rpc/${fn}(\\?|$)`).test(r.url())) out.push(r.postDataJSON()); });
  return out;
}

test.describe('@customer:account blood type', () => {
  async function account(page: Page, fx: Record<string, unknown>) {
    await stubSupabase(page, { sessions: [], queue_entries: [], 'rpc:my_bookings': [], 'rpc:customer_set_blood_type': true, ...fx });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
  }

  test('shows the type the account holds, with the eight types and "I don\'t know my blood type"', async ({ page }) => {
    await account(page, { 'rpc:customer_blood_type': 'B-' });
    const sel = page.locator('#acc-bt-sel');
    await expect(sel).toHaveValue('B-');
    await expect(page.locator('#acc-bt')).toContainText('Blood type');
    await expect(sel.locator('option')).toHaveCount(10); // Choose, eight types, I don't know
    await expect(sel.locator('option[value="unknown"]')).toHaveText("I don't know my blood type");
  });

  test('saves a choice, and "I don\'t know" too', async ({ page }) => {
    const sent = rpcBodies(page, 'customer_set_blood_type');
    await account(page, { 'rpc:customer_blood_type': null });
    await expect(page.locator('#acc-bt-sel')).toHaveValue('');
    await page.selectOption('#acc-bt-sel', 'AB+');
    await page.locator('#acc-bt-save').click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]).toMatchObject({ p_type: 'AB+' });
    await expect(page.locator('#acc-bt-sel')).toHaveValue('AB+');
    await page.selectOption('#acc-bt-sel', 'unknown');
    await page.locator('#acc-bt-save').click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1]).toMatchObject({ p_type: 'unknown' });
  });

  test('a refusal from the database says so under the card', async ({ page }) => {
    await account(page, { 'rpc:customer_blood_type': '', 'rpc:customer_set_blood_type': { __rpcError: { status: 400, code: '22023', message: 'BAD_INPUT', details: 'blood_type' } } });
    await page.selectOption('#acc-bt-sel', 'O+');
    await page.locator('#acc-bt-save').click();
    await expect(page.locator('#acc-bt-err')).toHaveText('Choose a blood type from the list.');
  });

  test('a database from before the field shows no card', async ({ page }) => {
    await account(page, { 'rpc:customer_blood_type': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.customer_blood_type in the schema cache' } } });
    await expect(page.locator('#acc-em-host')).toBeAttached();
    await expect(page.locator('#acc-bt')).toHaveCount(0);
  });
});

test.describe('@staff:accounts blood type', () => {
  const customers = [{ id: 'c1', name: 'Huda Saleh', email: 'huda@example.com', phone: '+966550000009', created_at: '2026-06-10T09:00:00Z',
    type_preference: 'Road', height: 165, blood_type: 'O-' }];

  test('the account editor shows and saves it', async ({ page }) => {
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], customers });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`(S.customers||[]).length>0`);
    const sent: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/customers')) sent.push(r.postDataJSON()); });
    await page.evaluate(`showEditCustomerModal('c1')`);
    await expect(page.locator('#cf-bt')).toHaveValue('O-');
    await page.selectOption('#cf-bt', 'A+');
    await page.evaluate(`saveCustForm()`);
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({ blood_type: 'A+' });
  });

  test('never saves a blood type it could not read', async ({ page }) => {
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], customers });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`(S.customers||[]).length>0`);
    await page.route(/\/rest\/v1\/customers\?.*select=blood_type/, (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '42703', message: 'column customers.blood_type does not exist' }) }));
    const sent: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/customers')) sent.push(r.postDataJSON()); });
    await page.evaluate(`showEditCustomerModal('c1')`);
    await expect(page.locator('#cf-em-host')).toBeAttached();
    await expect(page.locator('#cf-bt')).toHaveCount(0);
    await page.evaluate(`saveCustForm()`);
    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(sent[0]).not.toHaveProperty('blood_type');
  });
});
