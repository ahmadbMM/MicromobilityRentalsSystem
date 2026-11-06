import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff type a rider's WhatsApp number on the account editor (the owner, 2026-11-06). Empty = the mobile is
// their WhatsApp; a number equal to the mobile is saved as "same"; left alone, nothing is written.
const base = { email: 'w@example.com', phone: '+966550000009', created_at: '2026-06-10T09:00:00Z', height: 170 };
const customers = [
  { id: 'c1', name: 'Huda Saleh', ...base, whatsapp_same: null, whatsapp: null },
  { id: 'c2', name: 'Omar Saleh', ...base, phone: '+966550000010', whatsapp_same: false, whatsapp: '+966551112222' },
];

async function open(page: Page, id: string) {
  await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], customers });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`(S.customers||[]).length>1`);
  const sent: Record<string, unknown>[] = [];
  page.on('request', (r: Request) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/customers')) sent.push(r.postDataJSON()); });
  await page.evaluate(`showEditCustomerModal('${id}')`);
  return sent;
}

test('a typed WhatsApp number is saved as the account\'s own', async ({ page }) => {
  const sent = await open(page, 'c1');
  await expect(page.locator('#cf-wa-phone')).toHaveValue('');
  await page.fill('#cf-wa-phone', '501234567');
  await page.evaluate(`saveCustForm()`);
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  expect(sent[0]).toMatchObject({ whatsapp_same: false, whatsapp: '+966501234567' });
});

test('left empty on an unanswered account, nothing about WhatsApp is written', async ({ page }) => {
  const sent = await open(page, 'c1');
  await page.evaluate(`saveCustForm()`);
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  expect(sent[0]).not.toHaveProperty('whatsapp_same');
});

test('the saved number shows, and clearing it makes the mobile their WhatsApp', async ({ page }) => {
  const sent = await open(page, 'c2');
  await expect(page.locator('#cf-wa-phone')).toHaveValue('551112222');
  await page.fill('#cf-wa-phone', '');
  await page.evaluate(`saveCustForm()`);
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  expect(sent[0]).toMatchObject({ whatsapp_same: true, whatsapp: null });
});

test('a bad number is refused', async ({ page }) => {
  const sent = await open(page, 'c1');
  await page.fill('#cf-wa-phone', '12');
  await page.evaluate(`saveCustForm()`);
  await expect(page.locator('#cf-wa-phone')).toBeFocused();
  expect(sent.length).toBe(0);
});
