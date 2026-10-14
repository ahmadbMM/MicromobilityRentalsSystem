import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-14 (s10): the roster's bulk bar, the cancel-night sheet, Team's password copy.

const FUT = '2099-06-06';
const sessions = [{ id: FUT, session_date: FUT, day: 'Saturday', status: 'open', capacity: 20, created_at: 1 }];
const e = (id: string, st: string, x: Record<string, unknown> = {}) => ({
  id, session_id: FUT, session_day: 'Saturday', session_date: FUT, queue_num: 1, name: 'R ' + id,
  phone: '05500000' + id.length, type_preference: 'Road', size: 'M', status: st, paid: false,
  price: 75, registered_at: '2099-01-01T10:00:00Z', ...x });

async function boot(page: import('@playwright/test').Page, rows: Record<string, unknown>[]) {
  await stubSupabase(page, { sessions, queue_entries: rows, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`setStaffTab('queue');S.sfSession='${FUT}';renderStaffQueue()`);
  await page.waitForTimeout(250);
}

test.describe('@bh14 s10 roster and team', () => {
  test('the cancel-night sheet is a dialog: Escape closes it', async ({ page }) => {
    await boot(page, [e('a', 'waiting')]);
    await page.evaluate(`showCancelNight('${FUT}')`);
    const m = page.locator('#cancel-night-modal');
    await expect(m).toBeVisible();
    await expect(m).toHaveClass(/modal-backdrop/);
    await page.keyboard.press('Escape');
    await expect(m).toBeHidden();
  });

  test('a double tap on Cancel the night writes once', async ({ page }) => {
    await boot(page, [e('a', 'waiting'), e('b', 'waiting', { queue_num: 2 })]);
    let sessPatches = 0;
    page.on('request', (r) => { if (r.method() === 'PATCH' && /rest\/v1\/sessions/.test(r.url())) sessPatches++; });
    await page.evaluate(`showCancelNight('${FUT}')`);
    await page.evaluate(`Promise.all([execCancelNight(),execCancelNight()])`);
    await page.waitForTimeout(500);
    expect(sessPatches).toBe(1);
  });

  test('bulk Mark paid leaves an own-bike rider with nothing to pay alone', async ({ page }) => {
    await boot(page, [e('a', 'waiting'), e('o', 'waiting', { queue_num: 2, type_preference: 'Own', price: 0 })]);
    const urls: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PATCH' && /rest\/v1\/queue_entries/.test(r.url())) urls.push(decodeURIComponent(r.url())); });
    await page.evaluate(`S.sfSelected=['a','o'];bulkSfPaid()`);
    await expect.poll(() => urls.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(300);
    expect(urls.some((u) => u.includes('id=eq.a'))).toBe(true);
    expect(urls.some((u) => u.includes('id=eq.o'))).toBe(false);
  });

  test('a refused clipboard does not say Copied', async ({ page }) => {
    await boot(page, [e('a', 'waiting')]);
    await page.evaluate(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('no'))}})`);
    const errs: string[] = [];
    page.on('pageerror', (x) => errs.push(String(x)));
    await page.evaluate(`_tmPwdShow('x@y.co','Temp1234')`);
    await page.evaluate(`_tmPwdCopy('Temp1234')`);
    await page.waitForTimeout(300);
    const sel = await page.evaluate(`String(getSelection())`);
    expect(sel).toBe('Temp1234');
    await expect(page.locator('.toast', { hasText: 'Copied' })).toHaveCount(0);
    expect(errs).toEqual([]);
  });
});
