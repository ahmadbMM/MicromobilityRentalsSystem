import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// An undoable action puts up no undo bar (owner, 2026-09-28): its own toast says what it did, and
// the topbar's Undo, named after the action, takes it back.
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

test('an undoable action shows its own toast and no bar; the topbar Undo takes it back', async ({ page }) => {
  await boot(page);
  await page.evaluate(`toast('Saved');pushUndo('Did a thing',async()=>true)`);
  await expect(toasts(page).filter({ hasText: 'Saved' })).toHaveCount(1);
  await expect(page.locator('#undo-bar-el')).toHaveCount(0);
  await expect(page.locator('#topbar-right .undo-btn')).toHaveAttribute('title', 'Did a thing');
  await page.evaluate(`toast('Saved again')`);
  await expect(toasts(page).filter({ hasText: 'Saved again' })).toHaveCount(1);
  await page.locator('#topbar-right .undo-btn').click();
  await expect(toasts(page).filter({ hasText: 'Undone' })).toHaveCount(1);
  await expect(page.locator('#topbar-right .undo-btn')).toHaveCount(0);
});

test('a merge takes the pair off the Duplicates list at once and asks for the customer list again', async ({ page }) => {
  await boot(page);
  await page.evaluate(`setStaffTab('customers');S.customersTab='duplicates';renderCustomers()`);
  await expect(page.locator('#tab-customers')).toContainText('Maan Barnawi');
  // Approval and the reload are stubbed: the reload's answer is the fixture, which knows nothing
  // of the merge, so what is asserted is the desk's own bookkeeping.
  await page.evaluate(`window._pinApprove=async()=>true;window.__loads=0;window.loadData=async()=>{window.__loads++;};window.__dirty=null;window.refDirty=()=>{window.__dirty=true;}`);
  await page.evaluate(`_mgRun('c1','c2')`);
  await expect(page.locator('#topbar-right .undo-btn')).toHaveAttribute('title', /Maan Barnawi/);
  await expect(page.locator('#undo-bar-el')).toHaveCount(0);
  expect(await page.evaluate(`S.customers.map(c=>c.id).sort()`)).toEqual(['c1', 'c3']);
  expect(await page.evaluate(`[window.__dirty, window.__loads]`)).toEqual([true, 1]);
  await expect(page.locator('#tab-customers')).not.toContainText('b@icloud.com');
});
