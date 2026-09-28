import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The topbar Undo and the logs view reverse the same action. Triggering the topbar Undo must mark
// the action reversed, so the logs view can't reverse it a 2nd time. No bar pops up for it.
test('topbar undo marks the action undone (no double reversal), and no undo bar appears', async ({ page }) => {
  await stubSupabase(page);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);

  const result = await page.evaluate(`(async()=>{
    window.__reversals=0;
    pushUndo('Test action', async()=>{ window.__reversals++; });
    const bar=!!document.getElementById('undo-bar-el');
    const logEntry=S.actionLog[0];
    await doUndo();
    // the logs-view guard: only re-runs if !undone
    if(!logEntry.undone){ await logEntry.fn(); }
    return { reversals: window.__reversals, undone: logEntry.undone, bar, stackLen: S.undoStack.length };
  })()`) as { reversals: number; undone: boolean; bar: boolean; stackLen: number };

  expect(result.bar).toBe(false);        // no undo bar (owner, 2026-09-28)
  expect(result.reversals).toBe(1);      // reversed exactly once, not twice
  expect(result.undone).toBe(true);      // marked reversed
  expect(result.stackLen).toBe(0);
});
