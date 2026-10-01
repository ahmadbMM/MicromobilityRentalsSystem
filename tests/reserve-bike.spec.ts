import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Pre-reserving a bike for a waiting rider: the reservation is written to the booking's
// assigned_bike_id with NO status change and NO bike claim — the bike stays 'available'
// (reconcileOrphanBikes frees in-use bikes without an active holder). Check-in later
// claims it for real.
test('reserve bike holds a specific bike for a waiting rider without check-in or payment', async ({ page }) => {
  const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
  const queue_entries = [{ id: 'e1', session_id: 's0', session_day: 'Friday', session_date: '2099-02-10', queue_num: 1, name: 'Rider A', phone: '0511111111', customer_id: null, type_preference: 'Road', status: 'waiting', paid: false, price: 30, registered_at: '2099-01-01T10:00:00Z' }];
  const bikes = [{ id: 'b1', name: 'R-01', type: 'Road', size: 'M', status: 'available', colors: [] }];
  await stubSupabase(page, { sessions, queue_entries, bikes });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(() => {
    // @ts-expect-error app globals
    openModal('e1');
  });

  const modal = page.locator('#bike-modal');
  await expect(modal.getByText('R-01').first()).toBeVisible();

  const patches: { url: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/rest/v1/')) patches.push({ url: r.url(), body: r.postDataJSON() });
  });
  await modal.getByText('R-01').first().click(); // select the bike
  await modal.getByRole('button', { name: /Reserve bike/ }).click();
  await expect(modal).toBeHidden(); // reservation saved and modal closed

  // The dialog closes as the save leaves; under a loaded machine the request is seen a moment later.
  await expect.poll(() => patches.filter((p) => p.url.includes('queue_entries')).length).toBe(1);
  const queuePatches = patches.filter((p) => p.url.includes('queue_entries'));
  expect(queuePatches).toHaveLength(1);
  expect(queuePatches[0].body).toEqual({ assigned_bike_id: 'b1' }); // no status change, no payment
  expect(patches.filter((p) => p.url.includes('/bikes'))).toHaveLength(0); // bike NOT claimed in-use

  // The roster row now shows the reserved bike next to the still-waiting rider.
  const row = page.locator('#tab-queue').locator('tr, .q-card').filter({ hasText: 'Rider A' }).filter({ visible: true });
  await expect(row.getByText('R-01').first()).toBeVisible();
});
