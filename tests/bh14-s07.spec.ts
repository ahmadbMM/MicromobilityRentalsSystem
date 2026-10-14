import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

test.describe('@bh14 s07: sessions, promo codes, no-show flag', () => {
  // A session saved with a plain number per type ('counts' shape) cloned with every box at 0.
  test('cloning a per-type count session keeps its counts', async ({ page }) => {
    const sessions = [{ id: '2026-09-08', day: 'Tuesday', session_date: '2026-09-08', capacity: 7, status: 'closed', created_at: 1,
      bike_slots: '{"_time":"21:00 - 23:00","Road":4,"Hybrid":3}' }];
    await stubSupabase(page, { sessions });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('allSessions().length>0');
    await page.evaluate("setStaffTab('sessions'); cloneSession('2026-09-08')");
    expect(await page.evaluate('[S.newSessMode,S.newSessTypeSizes.Road.M,S.newSessTypeSizes.Hybrid.M,S.newSessTypeSizes.Mountain.M]')).toEqual(['counts', 4, 3, 0]);
  });

  // A percentage code over 100 is refused before it reaches the database.
  test('a percent promo over 100 is refused', async ({ page }) => {
    await stubSupabase(page, {});
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const r = await page.evaluate(`(async()=>{
      let n=0;const orig=sb.from.bind(sb);sb.from=(tb)=>{const q=orig(tb);if(tb==='promo_codes'){const i=q.insert.bind(q);q.insert=(...a)=>{n++;return i(...a);};}return q;};
      S._pcKind='percent';S._pcCode='BIG150';S._pcValue='150';S._pcEditId=null;
      await _addPromo();sb.from=orig;return n;
    })()`);
    expect(r).toBe(0);
  });

  // The repeat no-show flag follows a status changed in place, without waiting for a reload.
  test('no-show count follows an in-place status change', async ({ page }) => {
    await stubSupabase(page, {});
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    const counts = await page.evaluate(`(async()=>{
      const mk=(id,st)=>({id,customerId:'c1',name:'A',phone:'',status:st,sessionId:'2026-09-0'+id.slice(-1)});
      S.queue=[mk('q1','noshow'),mk('q2','noshow'),mk('q3','waiting'),mk('q4','waiting')];
      const a=customerNoShows(S.queue[3]);
      S.queue[2].status='noshow';
      await Promise.resolve();
      const b=customerNoShows(S.queue[3]);
      return [a,b];
    })()`);
    expect(counts).toEqual([2, 3]);
  });
});
