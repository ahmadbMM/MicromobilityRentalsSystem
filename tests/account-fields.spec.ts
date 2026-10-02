import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, loginCustomer } from './helpers/supabase';

// Every field of an application is a field of the account (the owner, 2026-10-02): the staff account
// editor shows and saves Profession, Company and How did you hear about us, and Bike owner is a bike type
// there and on the rider's own account page.
const customers = [{ id: 'c1', name: 'Huda Saleh', email: 'huda@example.com', phone: '+966550000009', created_at: '2026-06-10T09:00:00Z',
  profession: 'Engineer', workplace: 'Aramco', heard_from: 'instagram', type_preference: 'Own', height: 165 }];

test('the account editor shows and saves profession, company and how they heard, and offers Bike owner', async ({ page }) => {
  await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], customers });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`(S.customers||[]).length>0`);
  const sent: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/customers')) sent.push(r.postDataJSON()); });
  await page.evaluate(`showEditCustomerModal('c1')`);
  await expect(page.locator('#cf-prof')).toHaveValue('Engineer');
  await expect(page.locator('#cf-work')).toHaveValue('Aramco');
  await expect(page.locator('#cf-heard')).toHaveValue('instagram');
  const own = page.locator('#cust-form-modal .toggle-btn, .modal-box .toggle-btn', { hasText: /^Bike owner$/ }).first();
  await expect(own).toHaveClass(/active/); // the account's own choice
  await page.fill('#cf-prof', 'Architect');
  await page.fill('#cf-work', 'NEOM');
  await page.selectOption('#cf-heard', 'friend');
  await page.evaluate(`saveCustForm()`);
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  expect(sent[0]).toMatchObject({ profession: 'Architect', workplace: 'NEOM', heard_from: 'friend', type_preference: 'Own' });
});

test('My Account offers Bike owner among the bike types, and never Any', async ({ page }) => {
  await loginCustomer(page, { id: 'c1', name: 'Huda Saleh', height: 165, type_preference: 'Road' });
  await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [] });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('account')`);
  await expect(page.locator('#atp-Own')).toBeAttached();
  await expect(page.locator('#atp-Any')).toHaveCount(0);
});
