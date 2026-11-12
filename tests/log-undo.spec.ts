import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff } from './helpers/supabase';

// The logs view shows an Undo button only for actions still reversible this session
// (a matching S.actionLog entry with a reversal fn). _undoableFor does the matching.

test('_undoableFor matches reversible actions by label + closest timestamp', async ({ page }) => {
  await stubSupabase(page);
  await unlockStaff(page);
  await page.goto('/');

  await page.evaluate(`S.actionLog = [
    { id:'a1', label:'Staff cancel #5 Ali', fn:()=>{}, timestamp:1000, undone:false },
    { id:'a2', label:'Staff cancel #5 Ali', fn:()=>{}, timestamp:9000, undone:false },
    { id:'a3', label:'Marked #7 paid', fn:()=>{}, timestamp:2000, undone:true },
    { id:'a4', label:'Text only action', timestamp:3000, undone:false }
  ]`);

  // matches the closest-timestamp candidate with the same label
  expect(await page.evaluate(`(_undoableFor({label:'Staff cancel #5 Ali', ts:1200})||{}).id`)).toBe('a1');
  expect(await page.evaluate(`(_undoableFor({label:'Staff cancel #5 Ali', ts:8800})||{}).id`)).toBe('a2');
  // the same words a day away (another desk, another night) are not this device's action
  expect(await page.evaluate(`_undoableFor({label:'Staff cancel #5 Ali', ts:86400000})`)).toBe(null);
  // undone actions are not offered
  expect(await page.evaluate(`_undoableFor({label:'Marked #7 paid', ts:2000})`)).toBe(null);
  // entries without a reversal fn (past/text-only) are not offered
  expect(await page.evaluate(`_undoableFor({label:'Text only action', ts:3000})`)).toBe(null);
  // unknown labels are not offered
  expect(await page.evaluate(`_undoableFor({label:'Never happened', ts:1000})`)).toBe(null);
});
