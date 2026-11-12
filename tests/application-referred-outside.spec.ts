import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Community applications (the user, 2026-11-12): a filter for the applications a community member referred (an
// invitation to a Saturday social ride), and an application whose account was already in the community, moved to
// Approved by the database (20261112183000), says why: "Already approved outside the applications".

const customers = [
  { id: 'c1', name: 'Huda Al Saleh', email: 'huda.saleh@gmail.com', phone: '+966551239876', height: 165, created_at: '2026-01-05T10:00:00Z' },
  { id: 'c2', name: 'Omar Fathi', email: 'omar.fathi@gmail.com', phone: '+966551230000', height: 180, created_at: '2026-01-06T10:00:00Z' },
];
const base = {
  created_at: '2026-11-01T08:00:00Z', updated_at: '2026-11-01T08:00:00Z', submissions: 1, height: 178, birth_date: '1994-03-12', gender: 'male',
  nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null as string | null, decided_by: null as string | null,
  customer_id: null as string | null, existing_account: null as boolean | null, account_oauth: null, profession: 'Architect',
  instagram: '', linkedin: '', hidden_at: null, hidden_by: null, invited_by: null as string | null, invited_by_name: null as string | null,
  decided_reason: null as string | null,
};
const apps = [
  { ...base, id: 'a1', status: 'pending', name: 'Karim Mansour', email: 'karim.mansour@gmail.com', phone: '+966552468013', invited_by: 'c1', invited_by_name: 'Huda Al Saleh' },
  { ...base, id: 'a2', status: 'pending', name: 'Sami Noor', email: 'sami.noor@gmail.com', phone: '+966552468014' },
  { ...base, id: 'a3', status: 'pending', name: 'Lina Haddad', email: 'lina.haddad@gmail.com', phone: '+966552468015', invited_by: null, invited_by_name: 'Old Member' },
  { ...base, id: 'a4', status: 'approved', name: 'Omar Fathi', email: 'omar.fathi@gmail.com', phone: '+966551230000', customer_id: 'c2', existing_account: true,
    decided_at: '2026-11-12T09:00:00Z', decided_reason: 'outside' },
];

async function open(page: Page) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], community_applications: apps, learn_applications: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('community');setCommTab('applications')`);
}
const ids = (page: Page) => page.locator('.ca-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-app-id')));

test.describe('@staff:community applications referred by a member, and approved outside them', () => {
  test('the Invited by community member filter narrows the list and the pill counts', async ({ page }) => {
    await open(page);
    await expect(page.locator('.ca-row')).toHaveCount(3);
    await page.locator('[aria-controls="fm-caap"]').click();
    const sel = page.locator('#fm-caap').getByLabel('Invited by community member', { exact: true });
    await expect(sel).toBeVisible(); // in the panel's main part, not behind Advanced
    await sel.selectOption('yes');
    expect((await ids(page)).sort()).toEqual(['a1', 'a3']); // an inviter on file by id, or by the name the application kept
    await expect(page.locator('.filter-pill[data-ca-filter="pending"]')).toHaveText('Pending (2)');
    await expect(page.locator('.filter-pill[data-ca-filter="approved"]')).toHaveText('Approved (0)');
    await sel.selectOption('no');
    expect(await ids(page)).toEqual(['a2']);
    await expect(page.locator('.filter-pill[data-ca-filter="approved"]')).toHaveText('Approved (1)');
  });

  test('an application moved by the database says it was already approved outside the applications', async ({ page }) => {
    await open(page);
    await page.locator('.filter-pill[data-ca-filter="approved"]').click();
    const row = page.locator('.ca-row[data-app-id="a4"]');
    await expect(row.locator('.ca-acct')).toContainText('Already approved outside the applications');
    await expect(row.locator('.ca-acct')).not.toContainText('Tagged their existing account');
    await expect(row.locator('.ca-acct .ca-link')).toHaveText('Omar Fathi'); // the account, a tap away
    await expect(row.locator('.ca-when')).not.toContainText(' by '); // nobody decided it
  });
});
