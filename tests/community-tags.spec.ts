import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Community > Tags (the owner, 2026-10-07: "i want the community management to include a tag management page"):
// every tag with its holders count; Holders opens one tag: who holds it (newest grant first), one search that finds a
// holder or someone to give it to, Give (through the grant dialog) and Remove (asked first). The tag editor moved
// here from the top of the accounts list.

const sessions = [{ id: '2099-03-01', day: 'Sunday', session_date: '2099-03-01', status: 'open', capacity: 20, created_at: 1 }];
const tags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#4aa8f8', locked: true, auto_grant: false },
  { id: 'tag_x', slug: 'x', name: 'Coffee club', color: '#7c3aed', locked: false, auto_grant: false },
];
const customers = [
  { id: 'm1', name: 'Mona Member', email: 'mona@example.test', phone: '0500000021', created_at: '2026-01-01T00:00:00Z' },
  { id: 'm2', name: 'Majid Member', email: 'majid@example.test', phone: '0500000022', created_at: '2026-02-01T00:00:00Z' },
  { id: 'o1', name: 'Omar Outside', email: 'omar@example.test', phone: '0500000023', created_at: '2026-03-01T00:00:00Z' },
];
const customer_tags = [
  { customer_id: 'm1', tag_id: 'tag_saturday', added_by: 'staff', added_at: Date.parse('2026-09-01T10:00:00Z') },
  { customer_id: 'm2', tag_id: 'tag_saturday', added_by: 'staff', added_at: Date.parse('2026-10-01T10:00:00Z') },
];

async function boot(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await stubSupabase(page, { sessions, queue_entries: [], tags, customers, customer_tags, staff_options: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customerTags||[]).length===2');
  await page.evaluate(`setStaffTab('community');setCommTab('tags')`);
}

test('the Tags page lists every tag; Holders shows who holds one, newest first, and finds someone to give it to', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate('location.pathname')).toBe('/community/tags');
  const comm = page.locator('.am-tag-row', { hasText: '2 holders' });
  await expect(comm).toHaveCount(1);
  await expect(page.locator('.am-tag-row', { hasText: '0 holders' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '+ New tag' })).toBeVisible();
  await comm.getByRole('button', { name: 'Holders' }).click();
  const box = page.locator('.tg-holders');
  await expect(box.locator('.tg-row:not(.tg-give) strong')).toHaveText(['Majid Member', 'Mona Member']);
  await expect(box.locator('.tg-give')).toHaveCount(0);
  // the search narrows the holders and offers the rest
  await box.locator('#tg-q').fill('om');
  await expect(box.locator('.tg-give strong')).toHaveText(['Omar Outside']);
  await expect(page.locator('#tg-q')).toBeFocused();
  await box.locator('.tg-give').getByRole('button', { name: 'Give' }).click();
  expect(await page.evaluate('JSON.stringify([S._tg.cid,S._tg.tid])')).toBe('["o1","tag_saturday"]'); // the grant dialog asks how long
});

test('Remove asks first, then takes the tag back', async ({ page }) => {
  await boot(page);
  const deletes: string[] = [];
  page.on('request', (r) => { if (r.method() === 'DELETE' && /customer_tags/.test(r.url())) deletes.push(r.url()); });
  await page.locator('.am-tag-row', { hasText: '2 holders' }).getByRole('button', { name: 'Holders' }).click();
  const mona = page.locator('.tg-row', { hasText: 'Mona Member' });
  await mona.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('#confirm-modal')).toContainText('Take Community off Mona Member?');
  expect(deletes).toHaveLength(0);
  await page.locator('#confirm-modal').getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => deletes.length).toBe(1);
  expect(deletes[0]).toContain('customer_id=eq.m1');
  await expect(page.locator('.tg-row', { hasText: 'Mona Member' })).toHaveCount(0);
});

test('the overviews count from the same data and open their lists', async ({ page }) => {
  await boot(page);
  await page.evaluate(`setCommTab('overview')`);
  const tab = page.locator('#tab-community');
  await expect(tab.locator('.dash-kpi', { hasText: 'Community members' }).locator('strong')).toHaveText('2');
  await expect(tab.locator('.dash-kpi', { hasText: 'Tags' }).locator('strong')).toHaveText('2');
  await tab.locator('.dash-kpi', { hasText: 'Community members' }).click();
  await expect(tab.locator('#am-cust-rows')).toContainText('Mona Member');
  await expect(tab.locator('#am-cust-rows')).not.toContainText('Omar Outside'); // Members: the community's only
  await page.evaluate(`setStaffTab('customers')`);
  const cu = page.locator('#tab-customers');
  await expect(cu.locator('.dash-kpi', { hasText: /^3/ }).first()).toContainText('Accounts');
  await expect(cu.locator('.dash-kpi', { hasText: 'Community members' }).locator('strong')).toHaveText('2');
  await expect(tab).toBeEmpty(); // one section's lists on the page at a time
});
