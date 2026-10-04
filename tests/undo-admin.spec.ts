import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Only an admin undoes (the owner, 2026-09-28) - the topbar's Undo and History > Log - and the other
// roles see no Undo. The 6-digit undo code is gone (the owner, 2026-10-04: "remove the 6digit code
// for the staff"): nobody is asked to choose one, the topbar's Undo goes straight ahead and the
// Log's asks yes or no.

async function boot(page: Page): Promise<string[]> {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [] });
  const rpcs: string[] = [];
  page.on('request', (r) => { const m = /\/rest\/v1\/rpc\/(\w+)/.exec(r.url()); if (m && /undo/.test(m[1])) rpcs.push(m[1]); });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  return rpcs;
}
const undoBtn = (page: Page) => page.locator('#topbar-right .undo-btn');
async function undoable(page: Page, label = 'Payment · 1') {
  await page.evaluate(`window.__runs=0;pushUndo(${JSON.stringify(label)},async()=>{window.__runs++;})`);
}
const runs = (page: Page) => page.evaluate('window.__runs') as Promise<number>;

test.describe('@staff:undo admin undo', () => {
  test('an admin signing in is not asked for an undo code', async ({ page }) => {
    const rpcs = await boot(page);
    await page.evaluate(`_staffRoleConfirmed('u1','admin')`);
    await page.waitForTimeout(400);
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    await expect(page.locator('#uc-code')).toHaveCount(0);
    expect(rpcs).toEqual([]);
  });

  test('the topbar Undo undoes at once, with no code', async ({ page }) => {
    const rpcs = await boot(page);
    await undoable(page);
    await undoBtn(page).click();
    await expect.poll(() => runs(page)).toBe(1);
    await expect(page.locator('#uc-code')).toHaveCount(0);
    await expect(page.locator('#toast-container .toast', { hasText: 'Undone' })).toHaveCount(1);
    await expect(undoBtn(page)).toHaveCount(0);
    expect(rpcs).toEqual([]);
  });

  test('the Log\'s Undo asks yes or no; Cancel keeps it undoable', async ({ page }) => {
    await boot(page);
    await undoable(page, 'Check-in #4 Spec Rider');
    await page.evaluate(`setStaffTab('history');S.histView='log';renderHistory()`);
    const logUndo = page.locator('#hist-log-host').getByRole('button', { name: 'Undo' });
    await logUndo.click();
    await expect(page.locator('#confirm-modal')).toContainText('Check-in #4 Spec Rider');
    await expect(page.locator('#uc-code')).toHaveCount(0);
    await page.locator('#confirm-modal').getByRole('button', { name: 'Cancel' }).click();
    expect(await runs(page)).toBe(0);
    await logUndo.click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Yes, undo it' }).click();
    await expect.poll(() => runs(page)).toBe(1);
    await expect(logUndo).toHaveCount(0);
  });

  test('front desk sees no Undo and cannot undo', async ({ page }) => {
    await boot(page);
    await undoable(page);
    await page.evaluate(`setStaffTab('history');S.histView='log';renderHistory();S.staffRole='frontdesk';renderTopbarRight();renderLogs()`);
    await expect(undoBtn(page)).toHaveCount(0);
    await expect(page.locator('#hist-log-host')).toContainText('Payment · 1');
    await expect(page.locator('#hist-log-host').getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await page.evaluate(`doUndo();confirmLogUndo(S.actionLog[0].id)`);
    await expect(page.locator('#toast-container .toast', { hasText: 'Admin only.' }).first()).toBeVisible();
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    expect(await runs(page)).toBe(0);
  });
});
