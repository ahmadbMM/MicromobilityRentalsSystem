import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Fleet status writes land only on the bike as this device last saw it: one handed out, retired or sent
// to the workshop on another desk meanwhile is not overwritten, and its undo does not put back a status
// from before.

const BIKE = {
  id: 'b1', name: 'R-AL-0007-M', size: 'M', type: 'Road', status: 'available', colors: ['#03ff89'], color_names: [''],
  frame_type: 'Aluminum', bike_number: 7, in_service_date: '2023-01-05',
};
type P = import('@playwright/test').Page;
type W = { method: string; url: string; body: Record<string, unknown> };

async function boot(page: P, answer?: (w: W) => { status: number; body: unknown } | null) {
  await stubSupabase(page, { bikes: [BIKE] });
  const writes: W[] = [];
  const head = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  await page.route(/\/rest\/v1\/bikes/, async (route) => {
    const req = route.request();
    if (req.method() === 'GET' || req.method() === 'OPTIONS') return route.fallback();
    let body: Record<string, unknown> = {};
    try { const b = req.postDataJSON(); body = Array.isArray(b) ? b[0] : b; } catch { /* no body */ }
    const w = { method: req.method(), url: req.url(), body };
    writes.push(w);
    const a = answer && answer(w);
    if (a) return route.fulfill({ status: a.status, headers: head, body: JSON.stringify(a.body) });
    return route.fallback();
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('inventory');S.invSection='bikes';renderInventory();renderBikes()`);
  return writes;
}
const patches = (w: W[]) => w.filter((x) => x.method === 'PATCH');

test.describe('@bh14 s13 fleet status guards', () => {
  test('retire is guarded on the status this device saw', async ({ page }) => {
    const writes = await boot(page);
    await page.evaluate(`toggleRetire('b1')`);
    await expect.poll(() => patches(writes).length).toBeGreaterThan(0);
    const w = patches(writes)[0];
    expect(w.body.status).toBe('retired');
    expect(w.url).toContain('status=eq.available');
  });

  test('a bike changed on another desk meanwhile is not reported as retired and pushes no undo', async ({ page }) => {
    // the guarded write matches no row: the bike is no longer what this device saw
    const writes = await boot(page, (w) => (w.method === 'PATCH' ? { status: 200, body: [] } : null));
    const before = await page.evaluate('S.undoStack.length');
    await page.evaluate(`toggleRetire('b1')`);
    await expect.poll(() => patches(writes).length).toBe(1);
    await page.waitForTimeout(300);
    expect(await page.evaluate('S.undoStack.length')).toBe(before);
    await expect(page.locator('.toast', { hasText: /retired/i })).toHaveCount(0);
  });

  test('maintenance and missing are guarded too', async ({ page }) => {
    const writes = await boot(page);
    await page.evaluate(`setMaintenance('b1')`);
    await expect.poll(() => patches(writes).length).toBe(1);
    expect(patches(writes)[0].url).toContain('status=eq.available');
    await page.evaluate(`S.bikes=S.bikes.map(b=>b.id==='b1'?{...b,status:'available'}:b)`);
    await page.evaluate(`setMissing('b1')`);
    await expect.poll(() => patches(writes).length).toBe(2);
    expect(patches(writes)[1].body.status).toBe('missing');
    expect(patches(writes)[1].url).toContain('status=eq.available');
  });
});
