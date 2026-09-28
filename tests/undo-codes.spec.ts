import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Undo codes (the owner, 2026-09-28): only an admin undoes - the topbar's Undo and History > Log -
// and every undo is confirmed with a 6-digit code the admin chose. An admin without a code is asked
// for one when they sign in or next open the staff page; the other roles are never asked and see
// no Undo. The database checks the code (staff_check_undo_code); these specs stub its answers.

type Calls = { set: string[]; check: string[] };
async function boot(page: Page, hasCode: boolean, admin = true): Promise<Calls> {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], 'rpc:staff_undo_code_state': { admin, has_code: hasCode } });
  const calls: Calls = { set: [], check: [] };
  const json = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  // Registered after the stub, so these answer first: the right code is 482915.
  await page.route(/\/rest\/v1\/rpc\/staff_check_undo_code/, async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    const code = String((r.request().postDataJSON() || {}).p_code || '');
    calls.check.push(code);
    const body = code === '482915' ? { ok: true } : code === '999999' ? { ok: false, reason: 'locked', seconds: 60 } : { ok: false, reason: 'wrong', left: 4 };
    return r.fulfill({ status: 200, headers: json, body: JSON.stringify(body) });
  });
  await page.route(/\/rest\/v1\/rpc\/staff_set_undo_code/, async (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    calls.set.push(String((r.request().postDataJSON() || {}).p_code || ''));
    return r.fulfill({ status: 200, headers: json, body: JSON.stringify({ ok: true }) });
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  return calls;
}
const box = (page: Page) => page.locator('#confirm-modal .uc-box');
const undoBtn = (page: Page) => page.locator('#topbar-right .undo-btn');
async function undoable(page: Page, label = 'Payment · 1') {
  await page.evaluate(`window.__runs=0;pushUndo(${JSON.stringify(label)},async()=>{window.__runs++;})`);
}
const runs = (page: Page) => page.evaluate('window.__runs') as Promise<number>;

test.describe('@staff:undo undo codes', () => {
  test('an admin without a code is asked to choose one; the two entries must match', async ({ page }) => {
    const calls = await boot(page, false);
    await page.evaluate(`_staffRoleConfirmed('u1','admin')`);
    await expect(box(page)).toContainText('Choose your undo code');
    await expect(box(page).getByRole('button', { name: 'Not now' })).toBeVisible();
    await page.locator('#uc-code').fill('2072');
    await box(page).getByRole('button', { name: 'Save code' }).click();
    await expect(page.locator('#uc-msg')).toHaveText('The code is 6 digits.');
    await page.locator('#uc-code').fill('482915');
    await page.locator('#uc-code2').fill('207204');
    await box(page).getByRole('button', { name: 'Save code' }).click();
    await expect(page.locator('#uc-msg')).toHaveText('The two codes are not the same.');
    expect(calls.set).toEqual([]);
    await page.locator('#uc-code2').fill('482915');
    await page.locator('#uc-code2').press('Enter');
    await expect(box(page)).toHaveCount(0);
    expect(calls.set).toEqual(['482915']);
    await expect(page.locator('#toast-container .toast', { hasText: 'Undo code saved' })).toHaveCount(1);
    // Asked once per page load.
    await page.evaluate(`_staffRoleConfirmed('u1','admin')`);
    await page.waitForTimeout(300);
    await expect(box(page)).toHaveCount(0);
  });

  test('Not now closes the question; an admin who has a code, or another role, is not asked', async ({ page }) => {
    await boot(page, false);
    await page.evaluate(`_staffRoleConfirmed('u1','admin')`);
    await box(page).getByRole('button', { name: 'Not now' }).click();
    await expect(box(page)).toHaveCount(0);

    await boot(page, true);
    await page.evaluate(`_staffRoleConfirmed('u1','admin')`);
    await page.waitForTimeout(400);
    await expect(box(page)).toHaveCount(0);

    await boot(page, false, false);
    await page.evaluate(`_staffRoleConfirmed('u2','frontdesk')`);
    await page.waitForTimeout(400);
    await expect(box(page)).toHaveCount(0);
  });

  test('the topbar Undo asks for the code: a wrong one undoes nothing, the right one undoes', async ({ page }) => {
    const calls = await boot(page, true);
    await undoable(page);
    await undoBtn(page).click();
    await expect(box(page)).toContainText('Enter your undo code');
    await expect(box(page)).toContainText('Payment · 1');
    await page.locator('#uc-code').fill('111111');
    await page.locator('#uc-code').press('Enter');
    await expect(page.locator('#uc-msg')).toHaveText('Wrong code. 4 tries left.');
    await expect(page.locator('#uc-code')).toHaveValue('');
    expect(await runs(page)).toBe(0);
    await page.locator('#uc-code').fill('482915');
    await box(page).getByRole('button', { name: 'Undo' }).click();
    await expect(box(page)).toHaveCount(0);
    await expect.poll(() => runs(page)).toBe(1);
    await expect(page.locator('#toast-container .toast', { hasText: 'Undone' })).toHaveCount(1);
    await expect(undoBtn(page)).toHaveCount(0);
    expect(calls.check).toEqual(['111111', '482915']);
  });

  test('cancelling the code keeps the action undoable; a lock says how long', async ({ page }) => {
    await boot(page, true);
    await undoable(page);
    await undoBtn(page).click();
    await page.locator('#uc-code').fill('999999');
    await page.locator('#uc-code').press('Enter');
    await expect(page.locator('#uc-msg')).toHaveText('Too many tries. Try again in 60 s.');
    await box(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(box(page)).toHaveCount(0);
    expect(await runs(page)).toBe(0);
    await expect(undoBtn(page)).toHaveAttribute('title', 'Payment · 1');
  });

  test('the Log\'s Undo asks for the code too', async ({ page }) => {
    await boot(page, true);
    await undoable(page, 'Check-in #4 Spec Rider');
    await page.evaluate(`setStaffTab('history');S.histView='log';renderHistory()`);
    await page.locator('#hist-log-host').getByRole('button', { name: 'Undo' }).click();
    await expect(box(page)).toContainText('Check-in #4 Spec Rider');
    await page.locator('#uc-code').fill('482915');
    await page.locator('#uc-code').press('Enter');
    await expect.poll(() => runs(page)).toBe(1);
    await expect(page.locator('#hist-log-host').getByRole('button', { name: 'Undo' })).toHaveCount(0);
  });

  test('an undo before the admin has a code chooses one first, and then goes ahead', async ({ page }) => {
    const calls = await boot(page, false);
    await undoable(page);
    await page.evaluate(`doUndo();0`); // not awaited: it waits for the code
    await expect(box(page)).toContainText('Choose your undo code');
    await expect(box(page)).toContainText('Payment · 1');
    await page.locator('#uc-code').fill('482915');
    await page.locator('#uc-code2').fill('482915');
    await box(page).getByRole('button', { name: 'Save code' }).click();
    await expect.poll(() => runs(page)).toBe(1);
    expect(calls.set).toEqual(['482915']);
  });

  test('front desk sees no Undo and cannot undo', async ({ page }) => {
    await boot(page, false, false);
    await undoable(page);
    await page.evaluate(`setStaffTab('history');S.histView='log';renderHistory();S.staffRole='frontdesk';renderTopbarRight();renderLogs()`);
    await expect(undoBtn(page)).toHaveCount(0);
    await expect(page.locator('#hist-log-host')).toContainText('Payment · 1');
    await expect(page.locator('#hist-log-host').getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await page.evaluate(`doUndo();confirmLogUndo(S.actionLog[0].id)`);
    await expect(page.locator('#toast-container .toast', { hasText: 'Admin only.' }).first()).toBeVisible();
    await expect(box(page)).toHaveCount(0);
    expect(await runs(page)).toBe(0);
  });

  test('on a database without codes, the Log\'s Undo asks yes or no as it used to', async ({ page }) => {
    await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await undoable(page);
    await page.evaluate(`setStaffTab('history');S.histView='log';renderHistory()`);
    await page.locator('#hist-log-host').getByRole('button', { name: 'Undo' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Yes, undo it' }).click();
    await expect.poll(() => runs(page)).toBe(1);
  });
});
