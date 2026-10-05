import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Staff security and server-side reliability (the 2026-10-04 audit): an approval with no operator
// asks who is there first, and a failed operator list refuses; check-in carries its payment in one
// staff_checkin call; an add-on line keeps the price it was sold at; an idle device signs out
// after twelve hours (it no longer asks the operator again after ten minutes: 2026-10-05); signing out takes the staff
// data off the device and asks before losing work not sent yet; every CSV export is on record.
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sessions = [{ id: today, day: 'Tuesday', session_date: today, capacity: 40, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 40 }) }];
const bikes = [{ id: 'b9', name: 'Hybrid 09', type: 'Hybrid', size: 'M', status: 'available' }];
const inventory = [{ id: 'w1', name: 'Water', category: 'Drinks', qty: 9, price: 5, low_threshold: 1 }];
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id, session_id: today, session_day: 'Tuesday', session_date: today, queue_num: 1, name: 'Waiting Rider', phone: '0551112222',
  customer_id: null, group_id: null, status: 'waiting', paid: false, price: 115, walk_in: true, type_preference: 'Road',
  registered_at: '2099-01-01T10:00:00Z', ...extra,
});

async function boot(page: Page, fx: Record<string, unknown> = {}, opts: { noOp?: boolean } = {}) {
  await stubSupabase(page, { sessions, bikes, inventory, queue_entries: [row('w1')], ...fx });
  await unlockStaff(page);
  if (opts.noOp) await page.addInitScript(() => localStorage.removeItem('cq_op_name'));
  await page.goto('/');
  await waitForSb(page);
}
const calls = (page: Page, re: RegExp) => {
  const out: { url: string; method: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    if (!re.test(r.url())) return;
    let body: Record<string, unknown> = {};
    try { body = r.postDataJSON(); } catch { /* none */ }
    out.push({ url: r.url(), method: r.method(), body });
  });
  return out;
};

test.describe('@staff:security approvals', () => {
  test('with no operator on the device, an approval opens the gate first and goes ahead only once a name is picked', async ({ page }) => {
    await boot(page, { 'rpc:staff_operator_list': [{ name: 'Nadia', has_pin: false }] }, { noOp: true });
    const gate = page.locator('#op-gate-modal .op-gate');
    await expect(gate).toBeVisible(); // the first gate of the device
    await page.evaluate(`window.__ans=undefined;_pinApprove('Refund').then(v=>{window.__ans=v;});0`);
    expect(await page.evaluate(`window.__ans`)).toBeUndefined();
    await gate.getByRole('button', { name: 'Nadia' }).click();
    await expect.poll(() => page.evaluate(`window.__ans`)).toBe(true);
    expect(await page.evaluate(`_opName()`)).toBe('Nadia');
    // switching away and cancelling the gate refuses the action
    await page.evaluate(`localStorage.removeItem('cq_op_name');window.__ans=undefined;_pinApprove('Void').then(v=>{window.__ans=v;});0`);
    await expect(gate).toBeVisible();
    await gate.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => page.evaluate(`window.__ans`)).toBe(false);
  });

  test('an operator list that cannot be read refuses the approval instead of waving it through', async ({ page }) => {
    await boot(page, { 'rpc:staff_operator_list': { __rpcError: { status: 500, code: 'XX000', message: 'boom' } } });
    expect(await page.evaluate(`S._opPins=null;_pinApprove('Refund')`)).toBe(false);
    await expect(page.locator('#toast-container')).toContainText(/connection|connect/i);
  });

  test('merge and account delete carry the operator and the approval to the server', async ({ page }) => {
    await boot(page, {
      'rpc:staff_operator_list': [{ name: 'Spec Staff', has_pin: false }],
      'rpc:staff_merge_customers': { ok: true, id: 7 },
      customers: [{ id: 'ck', name: 'Keep Me', created_at: '2026-01-01' }, { id: 'cd', name: 'Drop Me', created_at: '2026-01-02' }],
    });
    const rpc = calls(page, /\/rpc\/staff_(merge_customers|delete_customer)/);
    await page.evaluate(`setStaffRole('admin');_mgRun('ck','cd')`);
    await expect.poll(() => rpc.length).toBe(1);
    expect(rpc[0].body).toMatchObject({ p_keep: 'ck', p_drop: 'cd', p_op: 'Spec Staff', p_approval: null });
  });
});

test.describe('@staff:security check-in in one call', () => {
  test('the payment rides on staff_checkin: no status, payment-method or arrival write after it', async ({ page }) => {
    await boot(page);
    const rpc = calls(page, /\/rpc\/staff_checkin/);
    const writes = calls(page, /\/rest\/v1\/queue_entries/);
    await page.evaluate(`setStaffTab('queue');S.sfSession='${today}';renderStaffQueue();showCheckinModal('w1')`);
    await page.evaluate(`(async()=>{S._ciPaid='cash';await confirmCheckinModal();})()`);
    await expect.poll(() => rpc.length).toBe(1);
    expect(rpc[0].body).toMatchObject({ p_booking_id: 'w1', p_paid: true, p_pay_method: 'cash' });
    expect(writes.filter((w) => w.method === 'PATCH' || w.method === 'POST')).toEqual([]);
  });

  // Rentals are card-only (the owner); the check-in's split-payment branch is gone (2026-10-05). A rider paid
  // before by split (or cash) keeps how they paid, so the close-out and the session report still read the row
  // as taken; a rider marked Paid at the desk is a card payment.
  test('a rider paid before by split keeps how they paid; one marked Paid is recorded as card', async ({ page }) => {
    await boot(page, { queue_entries: [row('w1'), row('w2', { queue_num: 2, name: 'Split Rider', paid: true, price: 115, pay_method: 'split', card_amount: 60 })] });
    const rpc = calls(page, /\/rpc\/staff_checkin/);
    await page.evaluate(`setStaffTab('queue');S.sfSession='${today}';renderStaffQueue();showCheckinModal('w2')`);
    await expect(page.locator('#ci-confirm')).toContainText('Paid');
    await page.evaluate(`(async()=>{await confirmCheckinModal();})()`);
    await expect.poll(() => rpc.length).toBe(1);
    expect(rpc[0].body).toMatchObject({ p_booking_id: 'w2' });
    expect(rpc[0].body).not.toHaveProperty('p_pay_method');
    expect(rpc[0].body).not.toHaveProperty('p_card_amount');
    await page.evaluate(`showCheckinModal('w1')`);
    await expect(page.locator('#ci-confirm')).toContainText('Paid'); // an unpaid rider opens on Paid
    await page.evaluate(`(async()=>{await confirmCheckinModal();})()`);
    await expect.poll(() => rpc.length).toBe(2);
    expect(rpc[1].body).toMatchObject({ p_booking_id: 'w1', p_paid: true, p_pay_method: 'card', p_card_amount: null });
  });
});

test.describe('@staff:security add-on prices', () => {
  test('a line keeps the price it was sold at; an older line reads today\'s price', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(`({
      sold: addonLineItems([{id:'w1',qty:2,p:3}]).map(a=>[a.price,a.lineTotal]),
      old: addonLineItems([{id:'w1',qty:1}]).map(a=>[a.price,a.lineTotal]),
      cost: addonsCost([{id:'w1',qty:1,p:3},{id:'w1',qty:1}]),
      merged: entryAddons({addons:'[{"id":"w1","qty":1,"p":3},{"id":"w1","qty":1,"p":3},{"id":"w1","qty":1}]'}),
    })`);
    expect(r).toEqual({ sold: [[3, 6]], old: [[5, 5]], cost: 8, merged: [{ id: 'w1', qty: 2, p: 3 }, { id: 'w1', qty: 1 }] });
  });
});

test.describe('@staff:security idle device', () => {
  test('a pause keeps the name (it is asked once, 2026-10-05); twelve hours sign the device out', async ({ page }) => {
    await page.clock.install({ time: new Date('2099-03-01T18:00:00+03:00') });
    await boot(page);
    await page.evaluate(`setStaffTab('queue')`);
    expect(await page.evaluate(`_opName()`)).toBe('Spec Staff');
    await page.clock.fastForward('30:00'); // half an hour away from the desk
    await page.evaluate(`_idleCheck()`);
    expect(await page.evaluate(`_opName()`)).toBe('Spec Staff');
    await expect(page.locator('#op-gate-modal .op-gate')).toHaveCount(0);
    // twelve hours: the device signs the staff account out (caught here, not navigated)
    // (the stamp is moved back rather than the clock run twelve hours: the service worker's hourly
    // update timer has no registration under the suite, which blocks workers)
    await page.evaluate(`window.__lock=null;window.lockStaff=(a)=>{window.__lock=a;};_idleLast=0;localStorage.setItem('cq_staff_seen',String(Date.now()-12*3600e3-1000))`);
    await page.clock.fastForward('00:31'); // the next half-minute check
    await expect.poll(() => page.evaluate(`window.__lock`)).toBe(true);
  });

  test('a device woken or reopened after twelve hours is signed out at once', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('queue');window.__lock=null;window.lockStaff=(a)=>{window.__lock=a;};
      _idleLast=0;localStorage.setItem('cq_staff_seen',String(Date.now()-13*3600e3));_idleCheck()`);
    expect(await page.evaluate(`window.__lock`)).toBe(true);
  });
});

test.describe('@staff:security sign-out', () => {
  test('signing out wipes the staff data, and asks before dropping work not sent yet; a customer\'s own queued booking stays', async ({ page }) => {
    await boot(page);
    await page.evaluate(`setStaffTab('queue');
      localStorage.setItem('cq_session',JSON.stringify({id:'c9',name:'Shared Tablet',session_token:'t9'}));
      for(const k of ['cq_full_log','cq_cancellations','cq_team','cq_errors','cq_role','cq_role_uid','cq_ho','cq_ct_q1'])localStorage.setItem(k,'[]');
      localStorage.setItem('cq_sales_outbox',JSON.stringify([{oid:'o1',kind:'upsert',id:'s1',data:{id:'s1'}}]));
      localStorage.setItem('cq_book_outbox',JSON.stringify([{id:'qs',customer_id:null},{id:'qc',customer_id:'c9'}]));`);
    await page.context().setOffline(true); // nothing can be sent
    await page.evaluate(`window.__out=undefined;staffAuthSignOut().then(v=>{window.__out=v;});0`);
    const dlg = page.locator('#confirm-modal');
    await expect(dlg).toContainText('2 changes not sent yet');
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    await expect.poll(() => page.evaluate(`window.__out`)).toBe(false);
    expect(await page.evaluate(`localStorage.getItem('cq_full_log')`)).toBe('[]'); // nothing wiped: still signed in
    await page.evaluate(`window.__out=undefined;staffAuthSignOut().then(v=>{window.__out=v;});0`);
    await dlg.getByRole('button', { name: 'Sign out anyway' }).click();
    await expect.poll(() => page.evaluate(`window.__out`)).toBe(true);
    const left = await page.evaluate(`(()=>{const o={};for(const k of ['cq_full_log','cq_cancellations','cq_team','cq_errors','cq_role','cq_role_uid','cq_ho','cq_ct_q1','cq_sales_outbox','cq_op_name'])o[k]=localStorage.getItem(k);o.books=JSON.parse(localStorage.getItem('cq_book_outbox')||'[]').map(r=>r.id);return o;})()`);
    expect(left).toEqual({ cq_full_log: null, cq_cancellations: null, cq_team: null, cq_errors: null, cq_role: null, cq_role_uid: null, cq_ho: null, cq_ct_q1: null, cq_sales_outbox: null, cq_op_name: null, books: ['qc'] });
    await page.context().setOffline(false);
  });
});

test.describe('@staff:security exports', () => {
  test('a CSV goes through one helper: the link is in the page while clicked, and the export is on record', async ({ page }) => {
    await boot(page);
    const logged = calls(page, /\/rest\/v1\/staff_actions/);
    const dl = page.waitForEvent('download');
    await page.evaluate(`S.view='staff';_downloadCsv('x.csv',[['a','b'],['=1+1','2'],['3','4']],'test kind')`);
    const text = await (await import('node:fs/promises')).readFile(await (await dl).path() as string, 'utf8');
    expect(text).toBe("﻿a,b\n'=1+1,2\n3,4"); // a formula is defused
    await expect.poll(() => logged.filter((l) => l.method === 'POST').length).toBe(1);
    expect(String(logged[0].body.action)).toBe('Exported test kind as CSV (2 rows)');
  });

  test('every account in one file is for admins, with the PIN', async ({ page }) => {
    await boot(page, { 'rpc:staff_operator_list': [{ name: 'Spec Staff', has_pin: true }], customers: [{ id: 'c1', name: 'Amal', created_at: '2026-01-01' }] });
    await page.evaluate(`setStaffRole('frontdesk');exportAccountsCsv()`);
    await expect(page.locator('#toast-container')).toContainText(/admin/i);
    await page.evaluate(`setStaffRole('admin');S._opPins=null;exportAccountsCsv();0`);
    await expect(page.locator('#op-gate-modal .op-gate')).toContainText('Confirm with your PIN');
  });
});
