import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// An action that puts up its undo bar has said what it did: the plain toast beside it stands
// down (owner, 2026-09-27); errors and warnings still show, and so does a toast that comes later.
// Merging two accounts takes the pair off the Duplicates list at once and asks for the customer
// list again, instead of keeping the stale list for its five-minute window.

const customers = [
  { id: 'c1', name: 'Maan Barnawi', email: 'a@gmail.com', phone: '+966502025071', gender: 'male', created_at: '2026-07-05T10:00:00Z' },
  { id: 'c2', name: 'Maan Barnawi', email: 'b@icloud.com', phone: '+966502025071', gender: 'male', created_at: '2026-07-05T11:00:00Z' },
  { id: 'c3', name: 'Someone Else', email: 'c@gmail.com', phone: '+966551876399', gender: 'male', created_at: '2026-07-05T12:00:00Z' },
];
async function boot(page: Page) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], tags: [], customers, customer_tags: [], staff_options: [], customer_merges: [], 'rpc:staff_merge_customers': { id: 'm1' } });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}
const toasts = (page: Page) => page.locator('#toast-container .toast');

test('the undo bar replaces the toast the same action shows, either order; errors and later toasts stay', async ({ page }) => {
  await boot(page);
  await page.evaluate(`toast('Saved');pushUndo('Did a thing',async()=>true)`);
  await expect(page.locator('#undo-bar-el .undo-bar-text')).toHaveText('Did a thing');
  await expect(toasts(page)).toHaveCount(0);
  await page.evaluate(`toast('Saved again')`);
  await expect(toasts(page)).toHaveCount(0);
  await page.evaluate(`toast('Oh no','error');toast('Careful','warning')`);
  await expect(toasts(page)).toHaveCount(2);
  await page.waitForTimeout(1600);
  await page.evaluate(`toast('Later news')`);
  await expect(toasts(page).filter({ hasText: 'Later news' })).toHaveCount(1);
  // The undo's own outcome is news, even right after the bar.
  await page.evaluate(`pushUndo('Second thing',async()=>true)`);
  await page.locator('#undo-bar-btn').click();
  await expect(toasts(page).filter({ hasText: 'Undone' })).toHaveCount(1);
});

test('a merge takes the pair off the Duplicates list at once and asks for the customer list again', async ({ page }) => {
  await boot(page);
  await page.evaluate(`setStaffTab('community');S.communityTab='duplicates';renderCommunity()`);
  await expect(page.locator('#tab-community')).toContainText('Maan Barnawi');
  // Approval and the reload are stubbed: the reload's answer is the fixture, which knows nothing
  // of the merge, so what is asserted is the desk's own bookkeeping.
  await page.evaluate(`window._pinApprove=async()=>true;window.__loads=0;window.loadData=async()=>{window.__loads++;};window.__dirty=null;window.refDirty=()=>{window.__dirty=true;}`);
  await page.evaluate(`_mgRun('c1','c2')`);
  await expect(page.locator('#undo-bar-el .undo-bar-text')).toContainText('Maan Barnawi');
  await expect(toasts(page)).toHaveCount(0);
  expect(await page.evaluate(`S.customers.map(c=>c.id).sort()`)).toEqual(['c1', 'c3']);
  expect(await page.evaluate(`[window.__dirty, window.__loads]`)).toEqual([true, 1]);
  await expect(page.locator('#tab-community')).not.toContainText('b@icloud.com');
});
