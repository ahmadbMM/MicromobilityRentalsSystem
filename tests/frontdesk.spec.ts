import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, staffReady } from './helpers/supabase';

test('front desk mode limits the staff tabs to Sales, Bookings & Riders, and the Workshop', async ({ page }) => {
  const sessions = [
    { id: 's-jcc', day: 'Friday', session_date: '2099-02-13', capacity: 12, status: 'open', created_at: 1 },
    { id: 's-sat', day: 'Saturday', session_date: '2099-02-14', capacity: 12, status: 'open', created_at: 2, event_kind: 'community', title: 'Saturday Social Ride' },
  ];
  const queue_entries = [
    { id: 'ej', session_id: 's-jcc', session_day: 'Friday', session_date: '2099-02-13', queue_num: 1, name: 'Jcc Rider', phone: '', customer_id: null, type_preference: 'Road', status: 'waiting', paid: false, price: 30, registered_at: '2099-01-01T10:00:00Z' },
    { id: 'ec', session_id: 's-sat', session_day: 'Saturday', session_date: '2099-02-14', queue_num: 1, name: 'Sat Rider', phone: '', customer_id: null, type_preference: 'Any', status: 'waiting', paid: false, price: 0, approval: 'approved', registered_at: '2099-01-01T10:00:00Z' },
  ];
  await stubSupabase(page, { sessions, queue_entries });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await staffReady(page);

  const vis = () => page.evaluate(() =>
    [...document.querySelectorAll('#staff-tab-nav .tab-btn')]
      .filter((b) => (b as HTMLElement).style.display !== 'none')
      .map((b) => (b as HTMLElement).dataset.stab),
  );

  // Admin (default): all tabs visible
  expect(await vis()).toEqual(expect.arrayContaining(['cashier', 'queue', 'inventory', 'analytics', 'history']));

  // Admin sees the Sessions pill, the Saturday session in the filter, and its riders
  await page.evaluate('setStaffTab("queue");setSfSession("all")'); // the queue opens on the next ride; All shows both
  const panel = page.locator('#tab-queue');
  await expect(panel.getByRole('button', { name: 'Sessions' })).toBeVisible();
  await expect(panel.locator('tr, .q-card').filter({ hasText: 'Sat Rider' }).filter({ visible: true })).toHaveCount(1);

  // Switch to Front Desk -> only Sales (cashier), Bookings (queue) and the Workshop, whose
  // bikes come in at the desk; the Petromin registrations are a page inside Queue, not a tab
  await page.evaluate('setStaffRole("frontdesk")');
  expect((await vis()).sort()).toEqual(['cashier', 'queue', 'settings', 'workshop']); // Settings is every account's own page (2026-10-02)

  // Trying to open a hidden tab bounces back to queue
  await page.evaluate('setStaffTab("analytics")');
  expect(await page.evaluate('S.staffTab')).toBe('queue');

  // The Petromin page opens, with the desk's actions; the summary report stays admin-only.
  await page.evaluate('setStaffTab("riders")');
  expect(await page.evaluate('[S.staffTab,S.queueView]')).toEqual(['queue', 'petromin']);
  const riders = page.locator('#pm-host');
  await expect(riders.locator('button[data-on-click*="showRiderWalkin"]')).toBeVisible();
  await expect(riders.locator('button[data-on-click*="openRidersReport"]')).toHaveCount(0);
  await page.evaluate('S.queueView="bookings";setStaffTab("queue")');

  // Front Desk: no Sessions pill, no Saturday rows, no Saturday option in the filter,
  // no community Add-rider button — Queue + Waitlist pills and JCC data only.
  await page.evaluate('renderStaffQueue()');
  await expect(panel.getByRole('button', { name: 'Sessions' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Waitlist' })).toBeVisible();
  await expect(panel.locator('tr, .q-card').filter({ hasText: 'Sat Rider' }).filter({ visible: true })).toHaveCount(0);
  await expect(panel.locator('tr, .q-card').filter({ hasText: 'Jcc Rider' }).filter({ visible: true })).toHaveCount(1);
  expect(await panel.locator('.filter-select').first().textContent()).not.toContain('14');
  await expect(panel.getByRole('button', { name: 'Add rider' })).toHaveCount(0);

  // Back to Admin restores everything
  await page.evaluate('setStaffRole("admin")');
  expect(await vis()).toContain('analytics');
});
