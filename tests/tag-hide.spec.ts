import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Hide a tag (the owner, 2026-11-08: "the victory lap session has ended and we longer need the tag so i want to hide
// it not delete it"): Hide on the Tags page moves it under Hidden with every holder kept; Unhide brings it back. A
// hidden tag is off the account chips, the Accounts filter pills and the pickers, except an account's own picker
// while that account holds it (so it can still come off).

const sessions = [{ id: '2099-03-01', day: 'Sunday', session_date: '2099-03-01', status: 'open', capacity: 20, created_at: 1 }];
const tag = (id: string, name: string, color: string, hidden_at: string | null = null, hidden_by: string | null = null) =>
  ({ id, slug: id, name, color, locked: false, auto_grant: false, hidden_at, hidden_by });
const customers = [
  { id: 'm1', name: 'Mona Member', email: 'mona@example.test', phone: '0500000021', gender: 'female', created_at: '2026-01-01T00:00:00Z' },
  { id: 'o1', name: 'Omar Outside', email: 'omar@example.test', phone: '0500000023', gender: 'male', created_at: '2026-03-01T00:00:00Z' },
];
const customer_tags = [
  { customer_id: 'm1', tag_id: 'tag_old', added_by: 'staff', added_at: Date.parse('2026-09-01T10:00:00Z') },
  { customer_id: 'm1', tag_id: 'tag_book', added_by: 'staff', added_at: Date.parse('2026-09-02T10:00:00Z') },
];

async function boot(page: Page, tags: Record<string, unknown>[], writes: { url: string; body: Record<string, unknown> }[] = []) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await stubSupabase(page, { sessions, queue_entries: [], tags, customers, customer_tags, staff_options: [] });
  page.on('request', (r) => { if (r.method() === 'PATCH' && /\/tags\?/.test(r.url())) writes.push({ url: decodeURIComponent(r.url()), body: JSON.parse(r.postData() || '{}') }); });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customerTags||[]).length===2');
}

test('Hide moves a tag under Hidden with its holders; Unhide brings it back', async ({ page }) => {
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  await boot(page, [tag('tag_old', 'Coffee club', '#7c3aed'), tag('tag_book', 'Book club', '#0d9488')], writes);
  await page.evaluate(`setStaffTab('community');setCommTab('tags')`);
  const old = page.locator('.am-tag-row', { hasText: 'Coffee club' });
  await expect(page.getByRole('button', { name: /^Hidden/ })).toHaveCount(0); // nothing hidden yet
  await old.getByRole('button', { name: 'Hide' }).click();
  await expect(old).toHaveCount(0);
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].url).toContain('tags?id=eq.tag_old');
  expect(writes[0].body.hidden_at).toBeTruthy();
  const hidBtn = page.getByRole('button', { name: 'Hidden (1)' });
  await expect(hidBtn).toHaveAttribute('aria-expanded', 'false');
  await hidBtn.click();
  await expect(old).toContainText('1 holders'); // every holder kept
  await expect(old).toContainText('Hidden');
  await expect(old.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  expect(await page.evaluate(`S.customerTags.filter(ct=>ct.tag_id==='tag_old').length`)).toBe(1);
  await old.getByRole('button', { name: 'Unhide' }).click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].body).toEqual({ hidden_at: null, hidden_by: null });
  await expect(page.getByRole('button', { name: /^Hidden/ })).toHaveCount(0);
  await expect(page.locator('.am-tag-row', { hasText: 'Coffee club' }).getByRole('button', { name: 'Hide' })).toBeVisible();
});

test('a hidden tag is off the chips and filter pills; only its holder\'s picker offers it, to take it off', async ({ page }) => {
  await boot(page, [tag('tag_old', 'Coffee club', '#7c3aed', '2026-11-08T08:00:00Z', 'Desk A'), tag('tag_book', 'Book club', '#0d9488')]);
  await page.evaluate(`setStaffTab('community');setCommTab('accounts')`);
  const mona = page.locator('#am-cust-rows .am-row[data-cust="m1"]');
  await expect(mona.locator('.am-c-tags .am-chip')).toHaveText(['Book club']);
  await expect(page.locator('.cmy-am-pills .am-pick[title="Book club"]')).toHaveCount(1);
  await expect(page.locator('.cmy-am-pills .am-pick[title="Coffee club"]')).toHaveCount(0);
  // Mona holds it: her picker shows it (ticked); Omar does not: his picker leaves it out
  await mona.getByRole('button', { name: 'Tags', exact: true }).click();
  await expect(page.locator('.am-picker .am-pick[title="Coffee club"]')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(`_amPickTags('o1')`);
  await expect(page.locator('.am-picker .am-pick[title="Book club"]')).toHaveCount(1);
  await expect(page.locator('.am-picker .am-pick[title="Coffee club"]')).toHaveCount(0);
  // the Tags page names who hid it and when
  await page.evaluate(`setCommTab('tags')`);
  await page.getByRole('button', { name: 'Hidden (1)' }).click();
  await expect(page.locator('.am-tag-row', { hasText: 'Coffee club' })).toContainText('by Desk A');
});

test('before the database has the column, Hide says so and writes nothing', async ({ page }) => {
  const writes: { url: string; body: Record<string, unknown> }[] = [];
  const bare = [{ id: 'tag_old', slug: 'old', name: 'Coffee club', color: '#7c3aed', locked: false, auto_grant: false }];
  await boot(page, bare, writes);
  await page.evaluate(`setStaffTab('community');setCommTab('tags')`);
  await page.locator('.am-tag-row', { hasText: 'Coffee club' }).getByRole('button', { name: 'Hide' }).click();
  await expect(page.getByText('Waiting for the database update')).toBeVisible();
  await expect(page.locator('.am-tag-row', { hasText: 'Coffee club' })).toBeVisible();
  expect(writes).toHaveLength(0);
});
