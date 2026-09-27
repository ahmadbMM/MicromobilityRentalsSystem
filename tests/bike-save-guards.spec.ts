import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The bike form and the fleet's bulk actions, where a slip writes the wrong thing to the fleet:
// a second tap adding a second bike, a number swapped behind the desk's back, a number no
// scanner can read, an edit (or its undo) rewriting the status, and refusals reported as done.

const BIKE = {
  id: 'b1', name: 'R-AL-0007-M', size: 'M', type: 'Road', status: 'available', colors: ['#03ff89'], color_names: [''],
  frame_type: 'Aluminum', bike_number: 7, brand: 'TREK', wheel_size: '700c', brake_type: 'Disc', weight_kg: 9.4,
  last_serviced_at: '2099-01-01T08:00:00Z', in_service_date: '2023-01-05',
};
type P = import('@playwright/test').Page;
type W = { method: string; url: string; body: Record<string, unknown> };

async function boot(page: P, bikes: Record<string, unknown>[] = [BIKE], answer?: (w: W) => { status: number; body: unknown } | null) {
  await stubSupabase(page, { bikes });
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
const posts = (w: W[]) => w.filter((x) => x.method === 'POST');
const patches = (w: W[]) => w.filter((x) => x.method === 'PATCH');

test('two taps on Add add one bike', async ({ page }) => {
  const writes = await boot(page);
  await page.evaluate(`startClone('b1')`);
  await expect(page.locator('#bk-add-form')).toBeVisible();
  await page.evaluate(`Promise.all([addBike(),addBike()])`);
  await page.waitForTimeout(300);
  expect(posts(writes)).toHaveLength(1);
  expect(posts(writes)[0].body.bike_number).toBe(8);
});

test('a number another device just took is not swapped for the next one behind the desk\'s back', async ({ page }) => {
  const writes = await boot(page, [BIKE], (w) => (w.method === 'POST'
    ? { status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint "bikes_bike_number_key"' } }
    : null));
  await page.evaluate(`startClone('b1')`);
  await page.evaluate(`addBike()`);
  await expect(page.locator('.toast', { hasText: /already in use/i })).toBeVisible();
  expect(posts(writes)).toHaveLength(1);                    // no second insert under another number
  await expect(page.locator('#bk-add-form')).toBeVisible(); // the form stays up for the desk to choose
});

test('a bike number longer than four digits is refused before it is saved', async ({ page }) => {
  const writes = await boot(page);
  await page.evaluate(`startClone('b1')`);
  await page.evaluate(`document.getElementById('bk-number').value='10001';S._bkNumber='10001'`);
  await page.evaluate(`addBike()`);
  await page.waitForTimeout(200);
  expect(posts(writes)).toHaveLength(0);
  expect(await page.locator('#bk-number').getAttribute('max')).toBe('9999');
});

test('an edit never writes the status, and neither does its undo', async ({ page }) => {
  const writes = await boot(page);
  await page.evaluate(`startEdit('b1')`);
  await page.evaluate(`document.getElementById('bk-size').value='L'`);
  await page.evaluate(`saveBikeEdit()`);
  await expect.poll(() => patches(writes).filter((w) => 'size' in w.body).length).toBe(1);
  expect(patches(writes).find((w) => 'size' in w.body)!.body).not.toHaveProperty('status');
  await page.waitForFunction('S.undoStack.length>0');
  // The bike is retired in the meantime; undoing the edit must not bring it back.
  await page.evaluate(`S.bikes=S.bikes.map(b=>b.id==='b1'?{...b,status:'retired'}:b)`);
  await page.evaluate(`doUndo()`);
  await expect.poll(() => patches(writes).filter((w) => 'size' in w.body).length).toBe(2);
  const undo = patches(writes).filter((w) => 'size' in w.body)[1].body;
  expect(undo).not.toHaveProperty('status');
  expect(undo).toMatchObject({ size: 'M', wheel_size: '700c', brake_type: 'Disc', weight_kg: 9.4 }); // the specs come back too
});

test('a bulk retire that is partly refused says so, counts what changed, and keeps the rest selected', async ({ page }) => {
  const b2 = { ...BIKE, id: 'b2', name: 'R-AL-0008-M', bike_number: 8 };
  const writes = await boot(page, [BIKE, b2], (w) => (w.method === 'PATCH' && /id=eq\.b2/.test(w.url)
    ? { status: 403, body: { code: '42501', message: 'new row violates row-level security policy' } }
    : null));
  await page.evaluate(`S.bkSelected=['b1','b2'];bkBulkRetire()`);
  await page.evaluate(`_doConfirm()`);
  await expect(page.locator('#err-bar-el')).toBeVisible();
  await expect(page.locator('#undo-bar-el .undo-bar-text')).toContainText(/\b1\b/); // the undo bar carries the count; the plain toast stands down beside it
  expect(await page.evaluate(`S.bkSelected`)).toEqual(['b2']);
  expect(await page.evaluate(`S.undoStack[S.undoStack.length-1].label`)).toContain('(1)');
  expect(patches(writes)).toHaveLength(2);
});

test('deleting a bike shows its name as text, and undo puts it back as it was', async ({ page }) => {
  const odd = { ...BIKE, name: '<img src=x onerror="window.__pwn=1">', status: 'maintenance', retired_date: '2099-01-02' };
  const writes = await boot(page, [odd]);
  await page.evaluate(`delBike('b1')`);
  const box = page.locator('#confirm-modal .confirm-box');
  await expect(box).toContainText('<img src=x');
  expect(await page.evaluate(`window.__pwn`)).toBeUndefined();
  await page.evaluate(`_doConfirm()`);
  await expect.poll(() => writes.filter((w) => w.method === 'DELETE').length).toBe(1);
  await page.waitForFunction('S.undoStack.length>0');                        // the delete has finished and left its undo
  await page.evaluate(`doUndo()`);
  await expect.poll(() => posts(writes).length).toBe(1);
  expect(posts(writes)[0].body).toMatchObject({
    id: 'b1', status: 'maintenance', retired_date: '2099-01-02', wheel_size: '700c', brake_type: 'Disc', weight_kg: 9.4, last_serviced_at: '2099-01-01T08:00:00Z',
  });
});
