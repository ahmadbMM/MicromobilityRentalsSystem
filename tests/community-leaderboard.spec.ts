import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The rider leaderboard and the community statistics are Community's first two tabs, as Claude
// Design has them (#15), ahead of the accounts, the flagged list and the membership
// applications. They sat in Analytics from 2026-09-22 to 2026-09-25.
const sessions = [{ id: 's1', day: 'Friday', session_date: '2026-09-18', capacity: 20, status: 'closed', created_at: 1 }];
const ride = (id: string, qn: number, name: string, cust: string) => ({
  id, session_id: 's1', session_day: 'Friday', session_date: '2026-09-18', queue_num: qn,
  name, phone: '', customer_id: cust, status: 'done', paid: true, price: 57.5,
  type_preference: 'Hybrid', registered_at: '2026-09-17T10:00:00Z', ride_duration: 60,
});
const queue_entries = [
  ride('e1', 1, 'Amal Top', 'c1'), ride('e2', 2, 'Amal Top', 'c1'), ride('e3', 3, 'Badr Next', 'c2'),
];
const customers = [
  { id: 'c1', name: 'Amal Top', created_at: '2026-01-01' },
  { id: 'c2', name: 'Badr Next', created_at: '2026-01-02' },
];

async function staff(page: Page) {
  await stubSupabase(page, { sessions, queue_entries, customers });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test('Community opens on the Leaderboard, with Statistics, Accounts, Flagged, Applications and Birthdays after it', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffTab('community')`);
  const tab = page.locator('#tab-community');
  const pills = tab.locator('.filter-row').first().locator('.filter-pill');
  await expect(pills).toHaveText(['Leaderboard', 'Statistics', 'Accounts', 'Flagged', /^Applications/, /^Birthdays/, /^Duplicates/]); // Applications carries the pending count, Birthdays today's, Duplicates (admins) the likely pairs
  await expect(pills.first()).toHaveClass(/active/);
  await expect(tab.locator('.form-title', { hasText: 'Leaderboard' })).toHaveCount(1);
  await expect(tab.getByText('Amal Top').first()).toBeVisible();

  await pills.nth(1).click();
  await expect(tab.locator('.form-title', { hasText: 'Leaderboard' })).toHaveCount(0);
  await expect(tab.getByText('Milestone watch').first()).toBeVisible();
  await expect(tab.locator('.analytics-kpi-card').first()).toBeVisible();
  // a tab this device never heard of lands on the leaderboard
  await page.evaluate(`S.communityTab='nope';renderCommunity()`);
  await expect(pills.first()).toHaveClass(/active/);
});

test('the leaderboard controls repaint Community and keep its tab', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffTab('community');setCommTab('leaderboard')`);
  await page.evaluate(`setLb('lbWindow','month')`);
  expect(await page.evaluate('S.communityTab')).toBe('leaderboard');
  const tab = page.locator('#tab-community');
  await expect(tab.locator('.filter-pill.active', { hasText: 'This month' })).toHaveCount(1);
  await expect(tab.locator('.form-title', { hasText: 'Leaderboard' })).toHaveCount(1);
});

test('Analytics keeps its own reports, and a device left on the leaderboard lands on Overview', async ({ page }) => {
  await staff(page);
  await page.evaluate(`S.anView='leaderboard';setStaffTab('analytics')`);
  const tab = page.locator('#tab-analytics');
  await expect(tab.locator('.an-nav-btn[data-anview="leaderboard"], .an-nav-btn[data-anview="stats"]')).toHaveCount(0);
  await expect(tab.locator('.an-nav-btn.active')).toHaveAttribute('data-anview', 'overview');
  await expect(tab.locator('.an-range-bar')).toBeVisible();
  await expect(tab).not.toContainText('Milestone watch');
});
