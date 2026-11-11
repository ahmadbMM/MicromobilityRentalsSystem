import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Queue rows link to the ACCOUNT behind the booking: a Customer button opens the full
// customer editor (name, contact, default payment, tags entry point) right from the roster.
test('the Customer button on a queue row opens the account editor', async ({ page }) => {
  const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
  const customers = [{ id: 'c1', name: 'Linked Rider', email: 'l@x.com', phone: '0500000001', height: 175, default_pay: 'house' }];
  const queue_entries = [{ id: 'e1', session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: 1, name: 'Linked Rider', phone: '0500000001', customer_id: 'c1', type_preference: 'Road', status: 'waiting', paid: false, price: 30, registered_at: '2099-01-01T10:00:00Z' }];
  await stubSupabase(page, { sessions, customers, queue_entries });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(() => {
    // @ts-expect-error app globals
    S.staffTab = 'queue'; renderStaffQueue();
  });

  // Customer now lives in the row's ⋯ menu — the desk keeps only Check in and No-show large
  const row = page.locator('#tab-queue').locator('tr, .q-card').filter({ hasText: 'Linked Rider' }).filter({ visible: true });
  await row.getByRole('button', { name: /More actions/ }).click();
  await page.waitForTimeout(150);   // let the just-positioned menu settle before clicking into it
  await page.locator('.pay-menu-popup').getByRole('menuitem', { name: /Customer/ }).click();
  await page.waitForTimeout(200);   // give the tap's handler a beat before asserting

  const modal = page.locator('#new-acct-modal');
  await expect(modal.locator('#cf-first')).toHaveValue('Linked');
  await expect(modal.locator('#cf-defpay')).toHaveValue('house'); // default payment editable from here
  await expect(modal.locator('#cf-defpay-types')).toBeVisible(); // house types picker shown
  await expect(modal.getByRole('button', { name: 'Tags' })).toBeVisible(); // tags entry point
});

// Changing the default payment syncs the customer's LIVE bookings immediately:
// switching to "on the house" comps their current unpaid booking on the spot.
test('a default-payment change applies to current bookings immediately', async ({ page }) => {
  const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
  // Email/phone present but UNCHANGED at save: the duplicate checks must be skipped
  // entirely (the stub returns the whole customers fixture for any filtered GET, so a
  // pre-fix dup check would wrongly block with "already exists").
  const customers = [{ id: 'c1', name: 'Live Rider', email: 'l@x.com', phone: '+966500000001', height: 175, default_pay: null }];
  const queue_entries = [{ id: 'e1', session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: 1, name: 'Live Rider', phone: '0500000001', customer_id: 'c1', type_preference: 'Road', status: 'waiting', paid: false, price: 30, registered_at: '2099-01-01T10:00:00Z' }];
  await stubSupabase(page, { sessions, customers, queue_entries });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(() => {
    // @ts-expect-error app globals
    showEditCustomerModal('c1');
  });

  const modal = page.locator('#new-acct-modal');
  await modal.locator('#cf-defpay').selectOption('house');
  // Hide a type from this customer's booking picker while we're here (the last 'Road Carbon'
  // toggle in the modal is the hidden-types row; type-pref and house-types rows come first).
  await modal.getByRole('button', { name: 'Road Carbon' }).last().click();
  const patches: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/')) patches.push({ url: r.url(), body: r.postDataJSON() });
  });
  await modal.getByRole('button', { name: /Save/ }).click();
  await expect(modal).toBeHidden();

  await expect.poll(() => patches.some((p) => p.url.includes('queue_entries') && p.url.includes('id=eq.e1'))).toBe(true);
  const qp = patches.find((p) => p.url.includes('queue_entries') && p.url.includes('id=eq.e1'));
  expect(qp?.body).toEqual({ paid: true, price: 0 }); // live booking comped on the spot
  const cp = patches.find((p) => p.url.includes('/customers'));
  expect(cp?.body.default_pay).toBe('house');
  expect(cp?.body.hidden_types).toBe('Road Carbon'); // hidden-types round trip

  // The hidden type disappears from that customer's own booking picker.
  const hidden = await page.evaluate(() => {
    S.loggedIn = { id: 'c1', name: 'Live Rider' };
    const c = (S.customers || []).find((x: { id: string }) => x.id === 'c1');
    if (c) (c as { hidden_types?: string }).hidden_types = 'Road Carbon';
    // @ts-expect-error app globals
    return [_regTypeHidden('Road Carbon'), _regTypeHidden('Road')];
  });
  expect(hidden).toEqual([true, false]);
});
