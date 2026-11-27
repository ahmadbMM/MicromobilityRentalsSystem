import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The Add rider dialog's Tag filter (the user, 2026-11-27: "in add rider modal, add a tag filter to show all
// accounts under a specific tag"): a tag picked lists every account holding it now, past the 8-row first page,
// and the search narrows within it. An expired tag row does not count. All Supabase traffic is stubbed.

const COMM = '2099-03-07';
const saturday = {
  id: COMM, day: 'Saturday', session_date: COMM, status: 'open', capacity: 20, created_at: 1,
  bike_slots: '{"_time":"21:00 - 23:00","_total":20}', event_kind: 'community', ride_kind: 'saturday', needs_approval: true, spots: 20,
};
// 12 tagged accounts (more than the 8 shown before a search), 5 untagged, 1 whose tag has expired.
const customers = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, name: `Tagged Person ${i}`, created_at: '2026-01-01T00:00:00Z' })),
  ...Array.from({ length: 5 }, (_, i) => ({ id: `u${i}`, name: `Plain Person ${i}`, created_at: '2026-01-01T00:00:00Z' })),
  { id: 'x1', name: 'Expired Person', created_at: '2026-01-01T00:00:00Z' },
];
const tags = [{ id: 'tag_doc', name: 'Doctor' }, { id: 'tag_other', name: 'Banker' }];
const customer_tags = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `ct${i}`, customer_id: `t${i}`, tag_id: 'tag_doc' })),
  { id: 'ctx', customer_id: 'x1', tag_id: 'tag_doc', expires_at: 1 },
];

async function boot(page: Page) {
  await stubSupabase(page, { sessions: [saturday], queue_entries: [], bikes: [], tags, customer_tags, customers });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0&&(S.customerTags||[]).length>0');
  await page.evaluate(`S.sfSession=${JSON.stringify(COMM)};showCommAddModal()`);
}
const rows = (page: Page) => page.locator('#ca-rows .cmy-ca-row');

test('a tag picked lists every account holding it, and the search narrows within it', async ({ page }) => {
  await boot(page);
  await expect(rows(page)).toHaveCount(8);
  const opts = await page.locator('#ca-tag option').allTextContents();
  expect(opts).toEqual(['All', 'Banker', 'Doctor']);
  await page.selectOption('#ca-tag', 'tag_doc');
  await expect(rows(page)).toHaveCount(12);
  await expect(page.locator('#ca-rows')).not.toContainText('Plain Person');
  await expect(page.locator('#ca-rows')).not.toContainText('Expired Person');
  await page.fill('#ca-search', 'Person 1');
  await expect(rows(page)).toHaveCount(3); // 1, 10, 11
  // a pick re-renders the dialog; the tag stays chosen
  await rows(page).first().click();
  await expect(page.locator('#ca-tag')).toHaveValue('tag_doc');
  await expect(rows(page)).toHaveCount(3);
  await page.selectOption('#ca-tag', '');
  await expect(page.locator('#ca-rows')).toContainText('Plain Person 1');
});

test('the dialog opens with no tag picked', async ({ page }) => {
  await boot(page);
  await page.selectOption('#ca-tag', 'tag_doc');
  await page.evaluate('closeCommAddModal();showCommAddModal()');
  await expect(page.locator('#ca-tag')).toHaveValue('');
  await expect(rows(page)).toHaveCount(8);
});
