import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Customers and Community are two sections (the owner, 2026-10-07: "make a separate customer management/dashboard
// page and a separate community management dashboard page ... i dont want the leaderboard and statistics to be with
// the community page"). The rider leaderboard and the community statistics are Analytics views again (they were
// Community's first two tabs from 2026-09-25); the accounts list is in both sections, Community's holding its members.
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

test('Customers opens on its overview, with Accounts, Flagged, Activity and Duplicates after it', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffTab('customers')`);
  const tab = page.locator('#tab-customers');
  const pills = tab.locator('.filter-row').first().locator('.filter-pill');
  await expect(pills).toHaveText(['Overview', 'Accounts', 'Flagged', 'Activity', /^Duplicates/]); // Duplicates (admins) carries the likely pairs
  await expect(pills.first()).toHaveClass(/active/);
  await expect(tab.locator('.dash-kpi', { hasText: 'Accounts' }).locator('strong')).toHaveText('2');
  await expect(tab.locator('.dash-row', { hasText: 'Badr Next' })).toHaveCount(1); // the newest accounts
  // a figure opens its list
  await tab.locator('.dash-kpi', { hasText: 'Accounts' }).click();
  await expect(pills.nth(1)).toHaveClass(/active/);
  await expect(tab.locator('#am-cust-rows')).toContainText('Amal Top');
  expect(await page.evaluate('location.pathname')).toBe('/customers/accounts');
  // a tab this device never heard of lands on the overview
  await page.evaluate(`S.customersTab='nope';renderCustomers()`);
  await expect(pills.first()).toHaveClass(/active/);
});

test('Community opens on its overview, with Members, Flagged, Tags, Badges, Applications and Birthdays; no leaderboard', async ({ page }) => {
  await staff(page);
  await page.evaluate(`setStaffTab('community')`);
  const tab = page.locator('#tab-community');
  const pills = tab.locator('.filter-row').first().locator('.filter-pill');
  await expect(pills).toHaveText(['Overview', 'Members', 'Flagged', 'Tags', 'Badges', /^Applications/, /^Birthdays/]);
  await expect(tab).not.toContainText('Leaderboard');
  await expect(tab.locator('.dash-kpi', { hasText: 'Community members' })).toHaveCount(1);
  // Members lists the community's members only: neither fixture account holds the tag
  await pills.nth(1).click();
  await expect(tab.locator('#am-cust-rows')).not.toContainText('Amal Top');
  expect(await page.evaluate('location.pathname')).toBe('/community/members');
});

test('the leaderboard and the statistics are Analytics views, and their controls repaint there', async ({ page }) => {
  await staff(page);
  await page.evaluate(`S.anView='leaderboard';setStaffTab('analytics')`);
  const tab = page.locator('#tab-analytics');
  await expect(tab.locator('.an-nav-btn.active')).toHaveAttribute('data-anview', 'leaderboard');
  await expect(tab.locator('#an-lb-host .form-title', { hasText: 'Leaderboard' })).toHaveCount(1);
  await expect(tab.locator('#an-lb-host').getByText('Amal Top').first()).toBeVisible();
  await page.evaluate(`setLb('lbWindow','month')`);
  await expect(tab.locator('#an-lb-host .filter-pill.active', { hasText: 'This month' })).toHaveCount(1);
  expect(await page.evaluate('S.staffTab')).toBe('analytics');
  await tab.locator('.an-nav-btn[data-anview="community"]').click();
  await expect(tab.locator('#an-cs-host').getByText('Milestone watch').first()).toBeVisible();
  await expect(tab.locator('#an-lb-host')).toBeHidden();
  expect(await page.evaluate('location.pathname')).toBe('/analytics/community');
});

test('old addresses land where their page is now', async ({ page }) => {
  for (const [from, to] of [['/community/stats', '/analytics/community'], ['/community/accounts', '/customers/accounts'], ['/community/duplicates', '/customers/duplicates'], ['/history/customers', '/customers/activity']]) {
    await stubSupabase(page, { sessions, queue_entries, customers });
    await unlockStaff(page);
    await page.goto(from);
    await waitForSb(page);
    await expect.poll(() => page.evaluate('location.pathname'), { message: from }).toBe(to);
  }
});
