import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// JCC: three riders per account per session, counted across bookings. The stepper stops at
// the allowance and says why beside the + / -; a second booking for the same night draws on
// the same three.

const S1 = '2099-01-11';
const jcc = { id: S1, day: 'Sunday', session_date: S1, capacity: 12, status: 'open', created_at: 1, location: 'JCC' };
const bikes = [{ id: 'b1', name: 'B1', size: 'M', type: 'Road', status: 'available', rental_price: 75 }];
const mine = (id: string, status: string, n: number) => ({
  id, customer_id: 'c1', session_id: S1, session_day: 'Sunday', session_date: S1, queue_num: n, name: 'Spec Rider',
  phone: '0500000001', type_preference: 'Road', size: 'M', status, paid: false, price: 75, registered_at: '2099-01-01T10:00:00Z',
});

async function boot(page: import('@playwright/test').Page, rows: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions: [jcc], bikes, queue_entries: rows, 'rpc:my_bookings': rows });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setCustTab('register'); S.selEvent='jcc'; S.modifyEntryId=null; S._alreadyBookedSession=null; selectSessCard('${S1}')`);
  await page.evaluate(`S.regStep=2; renderRegister()`);   // the stepper lives on step 2
}

test('a fresh account can add up to three; the fourth is refused with the sentence by the stepper', async ({ page }) => {
  await boot(page, []);
  await expect(page.locator('.qty-cap-note')).toHaveCount(0);
  await page.evaluate('changeRegQty(1); changeRegQty(1)');
  expect(await page.evaluate('S.regQty')).toBe(3);
  await expect(page.locator('.qty-cap-note')).toHaveCount(0);
  await page.evaluate('changeRegQty(1)');
  expect(await page.evaluate('S.regQty')).toBe(3);
  await expect(page.locator('.qty-cap-note')).toHaveText('One account can book up to 3 riders.');
  await page.evaluate('changeRegQty(-1)');
  await expect(page.locator('.qty-cap-note')).toHaveCount(0);            // only while + is refused
});

test('riders already on the bike for that night count against the three', async ({ page }) => {
  await boot(page, [mine('m1', 'active', 1), mine('m2', 'active', 2)]);
  expect(await page.evaluate('S.regQty')).toBe(1);
  await page.evaluate('changeRegQty(1)');
  expect(await page.evaluate('S.regQty')).toBe(1);                       // 2 on the bike + 1 = the three
  await expect(page.locator('.qty-cap-note')).toBeVisible();
});

test('modifying the existing booking: its own rows are the quantity, not extra', async ({ page }) => {
  await boot(page, [mine('m1', 'waiting', 1), mine('m2', 'waiting', 2)]);
  expect(await page.evaluate('S.regQty')).toBe(2);                       // the two rows being modified
  await page.evaluate('changeRegQty(1)');
  expect(await page.evaluate('S.regQty')).toBe(3);
  await page.evaluate('changeRegQty(1)');
  expect(await page.evaluate('S.regQty')).toBe(3);
  await expect(page.locator('.qty-cap-note')).toBeVisible();
});
