import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-14 (s11): dialogs that answer, the reminder's time in English, a cancel reason
// Settings wrote shown as text.
async function boot(page: Page) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], customers: [], staff_options: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`typeof promptDialog==='function'&&typeof _remTime==='function'`);
}

test.describe('@bh14 s11 dialogs and messages', () => {
  test('a ride reminder in English gives the start time in 12-hour, as the invitation does', async ({ page }) => {
    await boot(page);
    const s = (await page.evaluate(`_remTime('19:00','en')`)) as string;
    expect(s.toLowerCase()).toMatch(/7:00\s*pm/);
  });

  test('a prompt drawn over one still open answers the first with null', async ({ page }) => {
    await boot(page);
    const v = await page.evaluate(`(async()=>{const a=promptDialog({title:'a'});promptDialog({title:'b'});const r=await Promise.race([a,new Promise(r=>setTimeout(()=>r('hung'),1500))]);_promptDone(null);return r;})()`);
    expect(v).toBeNull();
  });

  test('the Log Undo question answers false when it is closed', async ({ page }) => {
    await boot(page);
    const v = await page.evaluate(`(async()=>{const p=_undoAuth('Test line',true);await new Promise(r=>setTimeout(r,50));closeConfirm();return await Promise.race([p,new Promise(r=>setTimeout(()=>r('hung'),1500))]);})()`);
    expect(v).toBe(false);
  });

  test("a cancel reason written in Settings is shown as text in the rider's dialog", async ({ page }) => {
    await boot(page);
    await page.evaluate(`CANCEL_REASONS.splice(CANCEL_REASONS.length-1,0,['c_x','<b>Bold</b>']);CANCEL_REASON_KEYS.splice(0,CANCEL_REASON_KEYS.length,...CANCEL_REASONS.map(r=>r[1]));_CANCEL_OTHER=CANCEL_REASON_KEYS.length-1;showCancelReasonModal('nope')`);
    const opt = page.locator('#cancel-reason-modal .cancel-reason-opt').filter({ hasText: '<b>Bold</b>' });
    await expect(opt).toHaveCount(1);
    await expect(page.locator('#cancel-reason-modal .cancel-reason-opt b')).toHaveCount(0);
  });
});
