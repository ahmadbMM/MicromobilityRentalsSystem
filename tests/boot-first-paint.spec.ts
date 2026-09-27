import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// A cold start used to wait for the whole customer list, the tag rows and the sales history
// before the roster could paint. Now the roster paints on the queue, bikes and sessions, and
// the rest streams in behind it. The poll backs off while realtime is connected.
const sessions = [{ id: '2099-02-10', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
const queue_entries = [{ id: 'e1', session_id: '2099-02-10', session_day: 'Friday', session_date: '2099-02-10', queue_num: 1, name: 'Early Rider', phone: '', customer_id: null, status: 'waiting', paid: false, price: 30, walk_in: true, registered_at: '2099-01-01T10:00:00Z', type_preference: 'Road', size: 'M' }];
const customers = [{ id: 'c1', name: 'Slow Customer', email: 'a@b.test', phone: '0500000001', created_at: '2026-01-01' }];

test('the roster paints before the customer list and the sales history arrive', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries, customers, cashier_sales: [{ id: 1, created_at: '2099-01-01T10:00:00Z', team_name: 'X', total: 10 }] });
  await unlockStaff(page);
  // Registered after the stub, so it runs first: hold these two tables back for three seconds.
  await page.route(/\/rest\/v1\/(customers|cashier_sales)(\?|$)/, async (route) => { await new Promise((r) => setTimeout(r, 5000)); await route.fallback(); });
  const t0 = Date.now();
  await page.goto('/');
  // Core data only - waitForSb() also waits for the lists this test holds back on purpose.
  await page.waitForFunction('typeof S!=="undefined" && !!S.dataLoaded', null, { timeout: 4000 });
  await expect(page.locator('#tab-queue')).toContainText('Early Rider', { timeout: 4000 });
  expect(Date.now() - t0).toBeLessThan(4500); // the held-back lists take five seconds
  expect(await page.evaluate('getCustomers().length')).toBe(0);           // not in yet
  await expect.poll(() => page.evaluate('getCustomers().length'), { timeout: 8000 }).toBe(1); // lands behind the roster
  await expect.poll(() => page.evaluate('(S.cashSales||[]).length'), { timeout: 8000 }).toBe(1);
});

test('the poll backs off while realtime is connected: the light set every fifth minute, the full one every fifteenth', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  expect(await page.evaluate("[_pollPlan(1,true),_pollPlan(9,true),_pollPlan(10,true),_pollPlan(20,true),_pollPlan(30,true),_pollPlan(1,false),_pollPlan(10,false),_pollPlan(30,false)]"))
    .toEqual(['skip', 'skip', 'light', 'light', 'full', 'light', 'full', 'full']);
});
