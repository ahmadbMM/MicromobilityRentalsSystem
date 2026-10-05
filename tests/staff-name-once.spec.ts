import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The owner, 2026-10-05: "why does the staff website ask the staff for his name multiple times, it must
// ask once only and save it to his name and make him able to change it later from settings". The name
// is the account's own (staff.display_name, Settings > Name, staff_my_settings): every device takes it
// from the account, the gate asks only while the account has none anywhere, the answer goes onto the
// account, a pause no longer clears it, and the bar's name chip opens Settings to change it.
test.describe('@staff:settings the staff name is asked once', () => {
  const calls: Record<string, unknown>[] = [];
  async function boot(page: Page, answer: Record<string, unknown>, deviceName: string | null) {
    calls.length = 0;
    page.on('request', (r) => { if (r.url().includes('/rest/v1/rpc/staff_my_settings') && r.method() === 'POST') calls.push(r.postDataJSON()); });
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [], 'rpc:staff_operator_list': [], 'rpc:staff_my_settings': answer });
    await unlockStaff(page);
    if (deviceName === null) await page.addInitScript(() => localStorage.removeItem('cq_op_name'));
    else await page.addInitScript((n) => localStorage.setItem('cq_op_name', n), deviceName);
    await page.goto('/');
    await waitForSb(page);
  }
  // The account's row arrives, as the sign-in and the boot's restore read it (staff select *).
  const accountRow = (page: Page, name: string | null) =>
    page.evaluate(`S._staffAuthed=true;_accessSet({role:'admin',modules_view:null,modules_edit:null,display_name:${JSON.stringify(name)},photo:null,nt_off:[]},'u1')`);
  const gate = (page: Page) => page.locator('#op-gate-modal .op-gate');

  test('an account with a name: every device goes by it, nothing asks, nothing is saved', async ({ page }) => {
    await boot(page, { display_name: 'Sara Nasser', photo: null, nt_off: [] }, null);
    await accountRow(page, 'Sara Nasser');
    await expect(gate(page)).toHaveCount(0); // a first gate the account's name answers closes by itself
    expect(await page.evaluate('_opName()')).toBe('Sara Nasser');
    await expect(page.locator('#topbar .op-chip')).toContainText('Sara Nasser');
    // a device that still holds an older name goes by the account's
    await page.evaluate(`localStorage.setItem('cq_op_name','Someone Else');_opGateCheck()`);
    await expect.poll(() => page.evaluate('_opName()')).toBe('Sara Nasser');
    expect(calls).toEqual([]);
  });

  test('an account without a name takes the one this device goes by, once, without asking', async ({ page }) => {
    await boot(page, { display_name: 'Spec Staff', photo: null, nt_off: [] }, 'Spec Staff');
    await accountRow(page, null);
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ p_name: 'Spec Staff' });
    await expect(gate(page)).toHaveCount(0);
    expect(await page.evaluate('S._meName')).toBe('Spec Staff');
    await page.evaluate(`_opGateCheck();setStaffTab('history')`);
    await page.waitForTimeout(300);
    expect(calls.length).toBe(1); // on the account now: not sent again
  });

  test('with no name anywhere it asks once; the answer goes onto the account and nothing asks again', async ({ page }) => {
    await page.clock.install({ time: new Date('2099-03-01T18:00:00+03:00') });
    await boot(page, { display_name: 'Nora Ali', photo: null, nt_off: [] }, null);
    await accountRow(page, null);
    await expect(gate(page)).toBeVisible();
    await expect(gate(page).getByRole('button', { name: 'Cancel' })).toHaveCount(0); // a first gate cannot be closed unanswered
    await gate(page).locator('#op-gate-name').fill('Nora Ali');
    await gate(page).locator('#op-gate-name').press('Enter');
    await expect(gate(page)).toHaveCount(0);
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ p_name: 'Nora Ali' });
    expect(await page.evaluate('_opName()')).toBe('Nora Ali');
    // half an hour away from the desk: the name stays, nothing asks (it used to after ten minutes)
    await page.clock.fastForward('30:00');
    await page.evaluate(`_idleCheck();setStaffTab('queue')`);
    await expect(gate(page)).toHaveCount(0);
    expect(await page.evaluate('_opName()')).toBe('Nora Ali');
    // another device (nothing stored on it): the account's name, unasked
    await page.evaluate(`localStorage.removeItem('cq_op_name');_opGateCheck()`);
    await expect.poll(() => page.evaluate('_opName()')).toBe('Nora Ali');
    await expect(gate(page)).toHaveCount(0);
    expect(calls.length).toBe(1);
  });

  test('the name chip opens Settings, where the name is changed for the account', async ({ page }) => {
    await boot(page, { display_name: 'Sara Ali', photo: null, nt_off: [] }, null);
    await accountRow(page, 'Sara Nasser');
    await page.locator('#topbar .op-chip').click();
    expect(await page.evaluate('S.staffTab')).toBe('settings');
    await expect(page.locator('#set-name')).toHaveValue('Sara Nasser');
    await page.fill('#set-name', 'Sara Ali');
    await page.click('#set-name-save');
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({ p_name: 'Sara Ali' });
    await expect(page.locator('#topbar .op-chip-name')).toHaveText('Sara Ali');
    expect(await page.evaluate('_opName()')).toBe('Sara Ali');
  });

  test('signing out takes the account\'s name off the device: the next account brings its own', async ({ page }) => {
    await boot(page, { display_name: 'Sara Nasser', photo: null, nt_off: [] }, null);
    await accountRow(page, 'Sara Nasser');
    await page.evaluate(`window._staffOutboxSettle=async()=>'ok';staffAuthSignOut(true)`);
    await expect.poll(() => page.evaluate(`[_opName(),S._meName,!!S._meRead]`)).toEqual(['', null, false]);
  });
});
