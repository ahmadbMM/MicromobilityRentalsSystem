import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Approvals (2026-10-09, migration 20261009163000): "PIN for every operator" and "a manager over
// X SAR" for refunds, on-the-house and price cuts. The keypad asks an approver named in Settings,
// and the RPC carries that approver's token; the server checks the same rules.

type Call = { name: string; body: Record<string, unknown> };
const rpcs = (page: Page) => {
  const calls: Call[] = [];
  page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (m) { let body = {}; try { body = r.postDataJSON(); } catch { /* none */ } calls.push({ name: m[1], body }); } });
  return calls;
};
const ops = [{ name: 'Spec Staff', has_pin: false }, { name: 'Huda', has_pin: true }, { name: 'Omar', has_pin: true }];
async function boot(page: Page, biz: Record<string, unknown>, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], 'rpc:staff_operator_list': ops, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();S._staffAuthed=true;S.staffOptions={biz:${JSON.stringify(biz)}};_listOk.opts=true;_bizFromOpts();window.__ans=undefined;`);
}

test.describe('@staff:approvals', () => {
  test('without the setting an operator with no PIN still approves', async ({ page }) => {
    await boot(page, {});
    expect(await page.evaluate(`_pinApprove('Void')`)).toBe(true);
  });

  test('PIN for every operator: one with no PIN cannot approve', async ({ page }) => {
    await boot(page, { pin_all: true });
    expect(await page.evaluate(`_pinApprove('Void')`)).toBe(false);
    await expect(page.locator('.toast').last()).toContainText('You need a PIN to approve this');
  });

  test("a refund over the limit asks a manager's PIN and the RPC carries the manager's token", async ({ page }) => {
    await boot(page, { mgr_over: 100, mgr_for: { refund: true }, approvers: ['Huda', 'Omar'] },
      { 'rpc:staff_pin_approve': { ok: true, required: true, token: 'mgr-tok' }, 'rpc:staff_refund_receipt': { ok: true, receipt_id: 'r1', count: 1, items: [] } });
    const calls = rpcs(page);
    await page.evaluate(`window.__ans=undefined;_salesRefund('r1',[{id:'x',receipt_id:'r1',qty:2,price:80,pay:'paid'}],'Refund').then(v=>{window.__ans=v;});0`);
    const gate = page.locator('#op-gate-modal .op-gate');
    await expect(gate).toContainText('Manager approval: Refund');
    await expect(gate.locator('.opg-name')).toHaveText([/Huda/, /Omar/]);
    await gate.locator('.opg-name', { hasText: 'Omar' }).click();
    await page.evaluate(`_opgKey('1');_opgKey('2');_opgKey('3');_opgKey('4')`);
    await expect.poll(() => calls.filter((c) => c.name === 'staff_refund_receipt').length).toBe(1);
    expect(calls.find((c) => c.name === 'staff_pin_approve')!.body).toMatchObject({ p_name: 'Omar', p_pin: '1234' });
    expect(calls.find((c) => c.name === 'staff_refund_receipt')!.body).toMatchObject({ p_op: 'Spec Staff', p_approval: 'mgr-tok' });
  });

  test('under the limit, or for a kind not ticked, the usual approval stands', async ({ page }) => {
    await boot(page, { mgr_over: 100, mgr_for: { refund: true }, approvers: ['Huda'] });
    expect(await page.evaluate(`_pinApprove('Refund',{kind:'refund',amount:50})`)).toBe(true);
    expect(await page.evaluate(`_pinApprove('House',{kind:'house',amount:500})`)).toBe(true);
  });

  test('no approver with a PIN: the action is refused and the page says why', async ({ page }) => {
    await boot(page, { mgr_over: 10, mgr_for: { price: true }, approvers: ['Spec Staff'] });
    expect(await page.evaluate(`_pinApprove('Price',{kind:'price',amount:40})`)).toBe(false);
    await expect(page.locator('.toast').last()).toContainText('no manager with a PIN');
  });

  test('the server asking for a manager (MANAGER_REQUIRED) brings the managers keypad', async ({ page }) => {
    await boot(page, { approvers: ['Huda'] }, { 'rpc:staff_pin_approve': { ok: true, required: true, token: 'tok-h' } });
    let n = 0;
    await page.route(/\/rest\/v1\/rpc\/staff_set_price/, (r) => {
      n++;
      if (n === 1) return r.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: '42501', message: 'MANAGER_REQUIRED', details: null, hint: null }) });
      return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true }) });
    });
    await page.evaluate(`_gatedRpc('Price',a=>sb.rpc('staff_set_price',{p_booking_id:'q1',p_price:1,...a}),{kind:'price',amount:5});0`);
    const gate = page.locator('#op-gate-modal .op-gate');
    await expect(gate).toContainText('Manager approval');
    await page.evaluate(`_opgKey('1');_opgKey('2');_opgKey('3');_opgKey('4')`);
    await expect.poll(() => n).toBe(2);
  });
});
