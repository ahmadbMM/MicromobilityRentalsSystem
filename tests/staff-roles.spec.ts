import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Six staff roles (2026-09-28): admin and front desk as before, and ride leader, mechanic,
// cashier and owner (a read-only viewer), each with the sections its work needs, narrowed by the
// account's own lists as before; the Team page offers all six. And PIN approval: refunds, voids,
// deletes and price changes ask the operator's PIN when the operator has one, through the gate's
// keypad, and a right answer holds for five minutes.
const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
const sale = { id: 'sale1', receipt_id: 'r1', session_id: 's0', item_id: 'it1', name: 'Water', qty: 1, price: 5, pay: 'paid', category: 'drinks', created_at: '2099-02-10T18:00:00Z', customer_name: 'Buyer' };

async function boot(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
}

test.describe('roles', () => {
  test('each role reaches its own sections; an unknown role reads as front desk; only admin is admin', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(`(()=>{
      const out={};
      for(const role of ['admin','frontdesk','leader','mechanic','cashier','owner','bogus']){
        setStaffRole(role);
        out[role]={role:S.staffRole,admin:isAdmin(),tabs:_staffSections().filter(_deskTabOk)};
      }
      setStaffRole('admin');
      return out;})()`) as Record<string, { role: string; admin: boolean; tabs: string[] }>;
    expect(r.admin.admin).toBe(true);
    expect(r.admin.tabs.length).toBe(15); // Vendors since 2026-10-03, Customers since 2026-10-07
    expect(r.frontdesk).toEqual({ role: 'frontdesk', admin: false, tabs: ['queue', 'cashier', 'workshop'] });
    expect(r.leader).toEqual({ role: 'leader', admin: false, tabs: ['queue'] });
    expect(r.mechanic).toEqual({ role: 'mechanic', admin: false, tabs: ['inventory', 'workshop'] });
    expect(r.cashier).toEqual({ role: 'cashier', admin: false, tabs: ['cashier', 'inventory'] });
    expect(r.owner.admin).toBe(false);
    // Messages, Vendors, the website and Team too since 2026-10-09 (read-only: an owner's edit list is empty)
    expect(r.owner.tabs).toEqual(['queue', 'dashboard', 'cashier', 'inventory', 'workshop', 'customers', 'community', 'vendors', 'website', 'messages', 'analytics', 'history', 'team']);
    expect(r.bogus.role).toBe('admin'); // setStaffRole keeps the larger default for a name it does not know; the row's role is normalised on read
    expect(await page.evaluate(`_roleNorm('bogus','frontdesk')`)).toBe('frontdesk');
    expect(await page.evaluate(`_roleNorm('owner','frontdesk')`)).toBe('owner');
  });

  test('an owner opens Analytics, History and Team; the sections render', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffRole('owner')`);
    await page.evaluate(`setStaffTab('analytics')`);
    expect(await page.evaluate(`S.staffTab`)).toBe('analytics');
    await expect(page.locator('#tab-analytics')).not.toBeEmpty();
    await page.evaluate(`setStaffTab('history')`);
    expect(await page.evaluate(`S.staffTab`)).toBe('history');
    await page.evaluate(`setStaffTab('team')`);
    expect(await page.evaluate(`S.staffTab`)).toBe('team'); // the owner reads Team since 2026-10-09
    // the rail shows the owner's sections only
    await expect(page.locator('#staff-tab-nav .tab-btn[data-stab="ambassadors"]')).toBeHidden();
  });

  test('the Team page offers the seven roles, shows a role its own sections, and an owner starts read-only', async ({ page }) => {
    await boot(page, {
      'rpc:staff_team_list': [
        { user_id: 'u-me', email: 'me@x.sa', role: 'admin', modules_view: null, modules_edit: null, is_me: true },
        { user_id: 'u-mech', email: 'mech@x.sa', role: 'mechanic', modules_view: null, modules_edit: null, is_me: false },
      ],
      'rpc:staff_operator_list': [],
    });
    await page.evaluate(`setStaffTab('team')`);
    const acct = page.locator('.tm-acct[data-acct="u-mech"]');
    await expect(acct).toBeVisible();
    await expect(acct.locator('select.tm-role option')).toHaveCount(7); // Manager since 2026-10-09
    await expect(acct.locator('select.tm-role option').nth(6)).toHaveText('Owner (read-only)');
    await expect(acct.locator('.tm-chip[data-sec^="view:"]')).toHaveCount(2); // inventory, workshop
    await expect(acct.locator('.tm-chip[data-sec="view:inventory"]')).toBeVisible();
    // owner: every section on view, none on edit
    await page.evaluate(`_tmRole('u-mech','owner')`);
    await expect(acct.locator('.tm-chip[data-sec^="view:"]')).toHaveCount(13); // Customers since 2026-10-07; Messages, Vendors, website, Team since 2026-10-09
    await expect(acct.locator('.tm-chip[data-sec^="edit:"].active')).toHaveCount(0);
    const draft = await page.evaluate(`_tm().edit['u-mech']`) as { role: string; edit: string[] | null };
    expect(draft.role).toBe('owner');
    expect(draft.edit).toEqual([]);
  });
});

test.describe('PIN approval', () => {
  const withPin = { 'rpc:staff_operator_list': [{ name: 'Spec Staff', has_pin: true }, { name: 'Other', has_pin: false }] };

  test('an operator without a PIN is not asked; one with a PIN gets the keypad, a wrong PIN is refused, the right one approves and holds', async ({ page }) => {
    await boot(page, { ...withPin, 'rpc:staff_check_operator_pin': { ok: false, reason: 'wrong', left: 4 } });
    // no PIN on this name: straight through
    await page.evaluate(`localStorage.setItem('cq_op_name','Other')`);
    expect(await page.evaluate(`_pinApprove('Refund')`)).toBe(true);
    await expect(page.locator('#op-gate-modal .op-gate')).toBeHidden();
    // a PIN: the keypad, named for the action
    await page.evaluate(`localStorage.setItem('cq_op_name','Spec Staff');S._opPins=null;window.__ans=undefined;_pinApprove('Refund').then(v=>{window.__ans=v;});0`);
    const gate = page.locator('#op-gate-modal .op-gate');
    await expect(gate).toBeVisible();
    await expect(gate).toContainText('Confirm with your PIN: Refund');
    await expect(gate).toContainText('Spec Staff');
    await page.evaluate(`_opgKey('1');_opgKey('2');_opgKey('3');_opgKey('4')`);
    await expect(gate.locator('.opg-msg')).toContainText('4');
    expect(await page.evaluate(`window.__ans`)).toBeUndefined();
    // now the right PIN
    await page.route(/\/rest\/v1\/rpc\/staff_check_operator_pin/, (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) }));
    await page.evaluate(`_opgKey('9');_opgKey('9');_opgKey('9');_opgKey('9')`);
    await expect.poll(() => page.evaluate(`window.__ans`)).toBe(true);
    await expect(gate).toBeHidden();
    expect(await page.evaluate(`_opName()`)).toBe('Spec Staff'); // an approval never switches the operator
    // within the grace window the next question is not asked
    expect(await page.evaluate(`_pinApprove('Void')`)).toBe(true);
    await expect(gate).toBeHidden();
  });

  test('cancelling the keypad refuses the action', async ({ page }) => {
    await boot(page, withPin);
    await page.evaluate(`window.__ans=undefined;_pinApprove('Delete').then(v=>{window.__ans=v;});0`);
    await expect(page.locator('#op-gate-modal .op-gate')).toBeVisible();
    await page.evaluate(`_opgBack()`);
    await expect.poll(() => page.evaluate(`window.__ans`)).toBe(false);
    await expect(page.locator('#op-gate-modal .op-gate')).toBeHidden();
  });

  test('a refund asks for the PIN after its reason and writes nothing until it is given', async ({ page }) => {
    await boot(page, { ...withPin, cashier_sales: [sale] });
    const writes: string[] = [];
    page.on('request', (r) => { if (['PATCH', 'POST', 'DELETE'].includes(r.method()) && r.url().includes('/rest/v1/cashier_sales')) writes.push(r.method()); });
    await page.evaluate(`setStaffTab('cashier')`);
    await page.evaluate(`_ctRefundReceipt('r1');0`);
    await page.locator('#mny-modal .mny-chip').first().click(); // the refund asks why first (2026-10-09)
    await page.locator('#mny-mr-go').click();
    await expect(page.locator('#op-gate-modal .op-gate')).toBeVisible();
    await expect(page.locator('#op-gate-modal .op-gate')).toContainText('Refund');
    expect(writes.length).toBe(0);
    await page.evaluate(`_opgBack()`);
    await page.waitForTimeout(300);
    expect(writes.length).toBe(0);
  });
});
