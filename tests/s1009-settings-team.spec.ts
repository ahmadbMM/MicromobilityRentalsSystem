import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Team accounts (2026-10-09, migration 20261009162000): last sign-in, disable / enable, a new
// temporary password, a new sign-in, role presets and what each account may do besides its
// sections (caps: export, costs, refund, undo).

const ME = '11111111-1111-1111-1111-111111111111';
const DESK = '22222222-2222-2222-2222-222222222222';
const team = [
  { user_id: ME, email: 'owner@example.com', role: 'admin', modules_view: null, modules_edit: null, is_me: true },
  { user_id: DESK, email: 'desk@example.com', role: 'frontdesk', modules_view: null, modules_edit: null, is_me: false },
];
const more = [
  { user_id: ME, disabled_at: null, caps: null, display_name: 'Owner', last_sign_in_at: '2026-10-08T18:00:00Z' },
  { user_id: DESK, disabled_at: null, caps: null, display_name: 'Desk', last_sign_in_at: null },
];
type Call = { name: string; body: Record<string, unknown> };
const rpcs = (page: Page) => {
  const calls: Call[] = [];
  page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (m) { let body = {}; try { body = r.postDataJSON(); } catch { /* none */ } calls.push({ name: m[1], body }); } });
  return calls;
};
async function boot(page: Page, x: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], 'rpc:staff_operator_list': [{ name: 'Spec Staff', has_pin: false }], 'rpc:staff_team_list': team, 'rpc:staff_team_more': more, ...x });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`confirmDialog=(o)=>o.onConfirm&&o.onConfirm();S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();`);
}

test.describe('@staff:team accounts', () => {
  test('each account shows its last sign-in; a preset fills the role and the caps, and Save sends both', async ({ page }) => {
    await boot(page, { 'rpc:staff_set_access': true, 'rpc:staff_set_caps': true });
    const calls = rpcs(page);
    await page.evaluate(`setStaffTab('team')`);
    const desk = page.locator(`.tm-acct[data-acct="${DESK}"]`);
    await expect(desk.locator('.tm-meta')).toContainText('Never');
    await expect(page.locator(`.tm-acct[data-acct="${ME}"] .tm-preset`)).toHaveCount(0); // not on your own account
    await desk.locator('.tm-preset').selectOption('manager');
    await expect(desk.locator('.tm-role')).toHaveValue('manager');
    await expect(desk.locator('[data-cap="export"]')).toHaveAttribute('aria-pressed', 'true');
    await desk.locator('[data-cap="undo"]').click();
    await expect(desk.locator('[data-cap="undo"]')).toHaveAttribute('aria-pressed', 'false');
    await desk.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => calls.filter((c) => c.name === 'staff_set_caps').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_set_access')!.body).toMatchObject({ p_user: DESK, p_role: 'manager' });
    expect(calls.find((c) => c.name === 'staff_set_caps')!.body).toEqual({ p_user: DESK, p_caps: { can_export: true, can_see_costs: true, can_refund: true, can_undo: false } });
  });

  test('a new sign-in gets a temporary password shown once; a bad name is refused first', async ({ page }) => {
    await boot(page, { 'rpc:staff_invite': { ok: true, user_id: '33333333-3333-3333-3333-333333333333' } });
    const calls = rpcs(page);
    await page.evaluate(`setStaffTab('team')`);
    await page.fill('#tm-inv-email', 'new.person@example.com');
    await page.fill('#tm-inv-name', 'Ali-2');
    await page.click('#tm-inv-go');
    expect(calls.filter((c) => c.name === 'staff_invite')).toHaveLength(0);
    await page.fill('#tm-inv-name', 'Ali Hassan');
    await page.selectOption('#tm-inv-role', 'cashier');
    await page.click('#tm-inv-go');
    await expect.poll(() => calls.filter((c) => c.name === 'staff_invite').length).toBe(1);
    const sent = calls.find((c) => c.name === 'staff_invite')!.body;
    expect(sent).toMatchObject({ p_email: 'new.person@example.com', p_name: 'Ali Hassan', p_role: 'cashier' });
    expect(String(sent.p_password)).toMatch(/^(?=.*[A-Z])(?=.*[0-9])[A-Za-z0-9]{10}$/);
    const dlg = page.locator('#confirm-modal [role="dialog"]');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('#tm-pwd-val')).toHaveText(String(sent.p_password));
  });

  test('disable and a new temporary password go through their functions; never on your own account', async ({ page }) => {
    await boot(page, { 'rpc:staff_set_disabled': true, 'rpc:staff_reset_password': true });
    const calls = rpcs(page);
    await page.evaluate(`setStaffTab('team')`);
    await expect(page.locator(`.tm-acct[data-acct="${ME}"]`).getByRole('button', { name: 'Disable' })).toHaveCount(0);
    const desk = page.locator(`.tm-acct[data-acct="${DESK}"]`);
    await desk.getByRole('button', { name: 'Disable' }).click();
    await expect.poll(() => calls.filter((c) => c.name === 'staff_set_disabled').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_set_disabled')!.body).toEqual({ p_user: DESK, p_disabled: true });
    await desk.getByRole('button', { name: 'New temporary password' }).click();
    await expect.poll(() => calls.filter((c) => c.name === 'staff_reset_password').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_reset_password')!.body).toMatchObject({ p_user: DESK });
  });

  test('a database before the accounts update shows the old Team page', async ({ page }) => {
    await boot(page, { 'rpc:staff_team_more': undefined });
    await page.evaluate(`setStaffTab('team')`);
    await expect(page.locator('.tm-acct')).toHaveCount(2);
    await expect(page.locator('.tm-preset, .tm-invite, [data-cap]')).toHaveCount(0);
  });

  test('caps decide export and undo for an account that is not an admin', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(`setStaffRole('frontdesk');S._myCaps=null;[_can('export'),_can('undo'),_can('refund'),_can('costs')]`)).toEqual([false, false, true, true]);
    expect(await page.evaluate(`S._myCaps={can_export:true,can_refund:false};[_can('export'),_can('undo'),_can('refund')]`)).toEqual([true, false, false]);
    expect(await page.evaluate(`setStaffRole('admin');S._myCaps={can_export:false};_can('export')`)).toBe(true);
  });

  test('a refund the account may not give stops before the keypad', async ({ page }) => {
    await boot(page, { 'rpc:staff_refund_receipt': { ok: true, count: 1, items: [] } });
    const calls = rpcs(page);
    const r = await page.evaluate(`setStaffRole('frontdesk');S._myCaps={can_refund:false};_salesRefund('r1',[{id:'x',receipt_id:'r1',qty:1,price:10,pay:'paid'}],'Refund')`);
    expect(r).toBe(false);
    expect(calls.filter((c) => c.name === 'staff_refund_receipt' || c.name === 'staff_pin_approve')).toHaveLength(0);
  });

  test('the Owner role opens Messages, Vendors, the website and Team, read-only', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(`['messages','vendors','website','team'].every(k=>_roleTabs('owner').includes(k))`)).toBe(true);
    expect(await page.evaluate(`_roleTabs('manager').includes('analytics')&&!_roleTabs('manager').includes('team')`)).toBe(true);
  });
});
