import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A rider staff add must reach that rider's My Bookings, which shows only rows carrying the
// customer's id. The link used to be an exact name match and nothing else, so "Ahmed" typed
// at the desk never met the account "Ahmed Khoja" and the booking stayed invisible to him.
// Now the phone decides first, on its last nine digits, whatever the prefix.
const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
const customers = [
  { id: 'c1', name: 'Ahmed Khoja', email: 'ahmed@example.test', phone: '+966500000001', created_at: '2099-01-01' },
  { id: 'c2', name: 'Sara Ali', email: 'sara@example.test', phone: '0500000002', created_at: '2099-01-01' },
];

async function walkIn(page: import('@playwright/test').Page, name: string, phone: string) {
  await stubSupabase(page, { sessions, customers });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('allSessions().length>0 && getCustomers().length>0');
  await page.evaluate('showWalkinModal()');
  const modal = page.locator('#walkin-modal');
  await modal.locator('#wi-name').fill(name);
  if (phone) await modal.locator('#wi-phone').fill(phone);
  await modal.locator('#wi-height').fill('175');
  const posts: Record<string, unknown>[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/rest/v1/queue_entries')) {
      const sent = r.postDataJSON(); posts.push(...(Array.isArray(sent) ? sent : [sent]));
    }
  });
  await modal.locator('button', { hasText: 'Add Walk-in' }).click();   // beside Add & check in, the desk's primary
  await expect(modal).toBeHidden();
  await expect.poll(() => posts.length).toBe(1);
  return posts[0];
}

test('a different name but the account phone links the booking to the account', async ({ page }) => {
  const row = await walkIn(page, 'Ahmed', '0500000001');
  expect(row.customer_id).toBe('c1');
  expect(row.walk_in).toBe(false);
});

test('an exact name still links on its own', async ({ page }) => {
  const row = await walkIn(page, 'sara ali', '');
  expect(row.customer_id).toBe('c2');
});

test('no phone match and no name match stays a plain walk-in', async ({ page }) => {
  const row = await walkIn(page, 'Someone New', '0500009999');
  expect(row.customer_id).toBeNull();
  expect(row.walk_in).toBe(true);
});
