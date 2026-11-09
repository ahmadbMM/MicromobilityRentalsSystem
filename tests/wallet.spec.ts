import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// The wallet (the owner, 2026-11-02; migration 20261102210000). The rules on the money itself live in that
// migration's functions and trigger; this is what the screens ask for and draw. All traffic stubbed; invented data.

const ksaDay = (n = 0) => new Date(Date.now() + 3 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
const D1 = ksaDay(1);
const sessions = [{ id: 's1', day: 'Friday', session_date: D1, capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' }];
const customers = [
  { id: 'c1', name: 'Rana Rider', email: 'rana@example.test', phone: '+966500000021', height: 170, gender: 'female', created_at: '2026-01-01T00:00:00Z' },
  { id: 'c2', name: 'Omar Other', email: 'omar@example.test', phone: '+966500000022', height: 180, gender: 'male', created_at: '2026-01-02T00:00:00Z' },
];
const bk = (id: string, n: number, x: Record<string, unknown> = {}) => ({
  id, session_id: 's1', session_day: 'Friday', session_date: D1, queue_num: n, name: 'Rana Rider', customer_id: 'c1', phone: '', email: '',
  type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 50, registered_at: '2026-10-28T10:00:00Z', ...x,
});
const WALLET = { customer_id: 'c1', balance: 120, rows: [{ id: 2, amount: 120, balance_after: 120, kind: 'topup', method: 'card', note: 'Gift for the race', created_at: new Date().toISOString(), by_name: 'Sara' }] };

function calls(page: Page) {
  const seen: { name: string; body: Record<string, unknown> }[] = [];
  page.on('request', (r) => {
    const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/);
    if (!m || r.method() !== 'POST') return;
    let body = {}; try { body = r.postDataJSON() || {}; } catch { /* none */ }
    seen.push({ name: m[1], body });
  });
  return seen;
}
async function staff(page: Page, fx: Fixtures = {}) {
  const ops = [{ name: 'Spec Staff', has_pin: false }];
  await stubSupabase(page, { sessions, customers, tags: [], customer_tags: [], queue_entries: [], bikes: [], staff_options: [], 'rpc:staff_operator_list': ops,
    'rpc:staff_wallet_balances': [{ customer_id: 'c1', balance: 120 }], 'rpc:staff_wallet_moves': [], 'rpc:staff_wallet': WALLET, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`S._opPins=${JSON.stringify(ops)};S._opPinsAt=Date.now();`);
  await page.evaluate(`S.staffRole='admin';_cwLoad(true)`);
  await page.waitForFunction('_cwOk()');
}
async function rider(page: Page, fx: Fixtures) {
  await stubSupabase(page, { sessions, ...fx });
  await page.addInitScript(() => {
    localStorage.setItem('cq_session', JSON.stringify({ id: 'c1', name: 'Rana Rider', email: 'rana@example.test', phone: '+966500000021', height: 170, session_token: 'tok' }));
  });
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@staff:customers wallet', () => {
  test('staff add money to an account: amount, how, then the server; a gift must say why', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_wallet_change': { ok: true, customer_id: 'c1', balance: 170 } });
    await page.evaluate(`setStaffTab('customers');S.communityTab='accounts';renderCustomers()`);
    const row = page.locator('#am-cust-rows .am-row[data-cust="c1"]');
    await expect(row.locator('.am-cw-btn.on')).toBeVisible();
    await expect(page.locator('#am-cust-rows .am-row[data-cust="c2"] .am-cw-btn:not(.on)')).toBeVisible();
    await row.locator('.am-cw-btn').click();
    const dlg = page.getByRole('dialog', { name: /Wallet · Rana Rider/ });
    await expect(dlg.locator('.cw-num')).toContainText('SAR 120');
    await expect(dlg.locator('.cw-line')).toContainText('Money added');
    await expect(dlg.locator('.cw-line')).toContainText('Gift for the race');

    await dlg.locator('.mny-foot .mny-go').click();
    await expect(dlg.locator('.cw-err')).toHaveText('Enter an amount.');
    await dlg.locator('#cw-amt').fill('50');
    await dlg.locator('.mny-foot .mny-go').click();
    await expect(dlg.locator('.cw-err')).toHaveText('Choose how.');
    await dlg.getByRole('button', { name: 'No money taken' }).click();
    await dlg.locator('.mny-foot .mny-go').click();
    await expect(dlg.locator('.cw-err')).toHaveText('Say why: no money moved.');
    expect(seen.filter((c) => c.name === 'staff_wallet_change')).toHaveLength(0);

    await dlg.getByRole('button', { name: 'Cash' }).click();
    await dlg.locator('.mny-foot .mny-go').click();
    await expect.poll(() => seen.filter((c) => c.name === 'staff_wallet_change').length).toBe(1);
    const sent = seen.find((c) => c.name === 'staff_wallet_change')!.body;
    expect(sent).toMatchObject({ p_customer: 'c1', p_amount: 50, p_method: 'cash' });
    expect(sent.p_op_id).toBeTruthy();
  });

  test('taking money out sends a minus', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { 'rpc:staff_wallet_change': { ok: true, customer_id: 'c1', balance: 100 } });
    await page.evaluate(`_cwOpen('c1')`);
    const dlg = page.getByRole('dialog', { name: /Wallet · Rana Rider/ });
    await expect(dlg.locator('.cw-num')).toContainText('SAR 120');
    await dlg.locator('.cw-seg').getByRole('button', { name: 'Take money out' }).click();
    await dlg.locator('#cw-amt').fill('20');
    await dlg.getByRole('button', { name: 'Card' }).click();
    await dlg.locator('.mny-foot .mny-go').click();
    await expect.poll(() => seen.find((c) => c.name === 'staff_wallet_change')?.body.p_amount).toBe(-20);
  });

  test('adding, taking out and refunding into a wallet are an admin\'s: other staff read it and can still pay from it', async ({ page }) => {
    const seen = calls(page);
    await staff(page, { queue_entries: [bk('q1', 1), bk('q2', 2, { paid: true, pay_method: 'card' })] });
    await page.evaluate(`S.staffRole='frontdesk';_cwOpen('c1')`);
    const dlg = page.getByRole('dialog', { name: /Wallet · Rana Rider/ });
    await expect(dlg.locator('.cw-num')).toContainText('SAR 120');
    await expect(dlg.locator('.cw-line')).toContainText('Money added');
    await expect(dlg.locator('#cw-amt')).toHaveCount(0);
    await expect(dlg.getByRole('button', { name: /Add money|Take money out/ })).toHaveCount(0);
    await page.evaluate(`_cwGo()`);
    expect(seen.some((c) => c.name === 'staff_wallet_change')).toBe(false);
    const opts = await page.evaluate(`(()=>{const f=id=>_cwPayOpts(_qGet(id)).map(o=>o.mode).join();return{unpaid:f('q1'),paid:f('q2')}})()`);
    expect(opts).toEqual({ unpaid: 'wpay', paid: '' });
    await page.evaluate(`S.staffRole='admin'`);
    const admin = await page.evaluate(`_cwPayOpts(_qGet('q2')).map(o=>o.mode).join()`);
    expect(admin).toBe('wrefund');
  });

  test('at the till: the switch takes what the balance can first, the rest as card, and the books read it apart', async ({ page }) => {
    const seen = calls(page);
    const row = { id: 'wal-x', receipt_id: 'x', session_id: 's1', name: 'Wallet', category: '__cardmeta__', qty: 0, price: 120, pay: 'wallet', created_at: new Date().toISOString() };
    await staff(page, { cashier_sales: [], 'rpc:staff_wallet_pay_sale': { ok: true, taken: 120, balance: 0, row } });
    await page.evaluate(`setStaffTab('cashier');S._ctSession='s1';S._ctCustId='c1';S._ctCust='Rana Rider';S._ctCart=[{item_id:null,name:'Gel',cat:'Food',qty:1,price:200,pay:'paid'}];renderCashier()`);
    const sw = page.locator('.sl-wal');
    await expect(sw).toContainText('Wallet');
    await expect(sw.locator('input')).not.toBeChecked();
    await sw.locator('input').check();
    await expect(page.locator('#ct-split')).toContainText('Wallet');
    await expect(page.locator('#ct-split')).toContainText('SAR 80');
    await page.evaluate(`S._ctCustId='c2';renderCashier()`); // another account: its own choice
    expect(await page.evaluate('_ctWalletOn()')).toBe(false);
    await page.evaluate(`S._ctCustId='c1';S._ctWallet='c1';renderCashier()`);
    await page.evaluate(`_ctRecord()`);
    await expect.poll(() => seen.find((c) => c.name === 'staff_wallet_pay_sale')?.body).toMatchObject({ p_customer: 'c1', p_amount: 200 });
    const cc = await page.evaluate(`(()=>{const lines=(S.cashSales||[]).filter(r=>r.pay==='paid'||r.pay==='wallet');return _salesCC(lines.concat([{receipt_id:lines[0].receipt_id,category:'__cardmeta__',qty:0,price:30,pay:'paid'},{receipt_id:lines[0].receipt_id,category:'__cardmeta__',qty:0,price:120,pay:'wallet'}]))})()`);
    expect(cc).toEqual({ card: 30, cash: 50, wallet: 120 });
    expect(await page.evaluate(`S._ctWallet`)).toBe('');
  });

  test('a wallet refusing a sale records nothing, and the cart stays', async ({ page }) => {
    await staff(page, { cashier_sales: [], 'rpc:staff_wallet_pay_sale': { __rpcError: { status: 400, code: 'P0001', message: 'WALLET_SHORT' } } });
    await page.evaluate(`setStaffTab('cashier');S._ctSession='s1';S._ctCustId='c1';S._ctWallet='c1';S._ctCart=[{item_id:null,name:'Gel',cat:'Food',qty:1,price:200,pay:'paid'}];renderCashier();_ctRecord()`);
    await expect(page.locator('#toast-container')).toContainText('Not enough in the wallet');
    expect(await page.evaluate(`[S._ctCart.length,(S.cashSales||[]).length]`)).toEqual([1, 0]);
  });

  test('a receipt with a wallet part is not edited, and its part is neither card nor cash', async ({ page }) => {
    const at = new Date().toISOString();
    const sales = [
      { id: 'l1', receipt_id: 'r1', session_id: 's1', name: 'Gel', category: 'Food', qty: 1, price: 100, pay: 'paid', customer_id: 'c1', created_at: at },
      { id: 'wal-r1', receipt_id: 'r1', session_id: 's1', name: 'Wallet', category: '__cardmeta__', qty: 0, price: 60, pay: 'wallet', created_at: at },
    ];
    await staff(page, { cashier_sales: sales });
    await page.waitForFunction(`(S.cashSales||[]).length===2`);
    expect(await page.evaluate(`_salesCC(S.cashSales)`)).toEqual({ card: 0, cash: 40, wallet: 60 });
    await page.evaluate(`showReceiptEdit('r1')`);
    await expect(page.locator('#toast-container')).toContainText('paid from a wallet');
    expect(await page.evaluate(`S._reKey||null`)).toBe(null);
  });

  test('the server saying only an admin may is said in the dialog', async ({ page }) => {
    await staff(page, { 'rpc:staff_wallet_change': { __rpcError: { status: 403, code: '42501', message: 'ADMIN_ONLY' } } });
    await page.evaluate(`_cwOpen('c1')`); // the device still thinks it is an admin's
    const dlg = page.getByRole('dialog', { name: /Wallet · Rana Rider/ });
    await expect(dlg.locator('.cw-num')).toContainText('SAR 120');
    await dlg.locator('#cw-amt').fill('20');
    await dlg.getByRole('button', { name: 'Card' }).click();
    await dlg.locator('.mny-foot .mny-go').click();
    await expect(dlg.locator('.cw-err')).toContainText(/admin/i);
  });

  test('Customers > Wallets: what is held and who holds it, and a search finds any account', async ({ page }) => {
    await staff(page);
    await page.evaluate(`setStaffTab('customers');setCustomersTab('wallets')`);
    await expect(page).toHaveURL(/\/people\/wallets$/);
    await expect(page.locator('#tab-community .dash-kpi').first()).toContainText('SAR 120');
    await expect(page.locator('.cw-row')).toHaveCount(1);
    await expect(page.locator('.cw-row')).toContainText('Rana Rider');
    await page.locator('#cw-q').fill('omar');
    await expect(page.locator('.cw-row')).toContainText('Omar Other');
    await expect(page.locator('#cw-q')).toBeFocused();
  });

  test('the pay menu: from the wallet when it covers the ride; a paid ride refunds into it', async ({ page }) => {
    const seen = calls(page);
    await staff(page, {
      queue_entries: [bk('q1', 1), bk('q2', 2, { paid: true, pay_method: 'card' }), bk('q3', 3, { price: 500 }), bk('q4', 4, { customer_id: null })],
      'rpc:staff_wallet_pay_booking': { ok: true, paid: ['q1'], amount: 50, balance: 70 },
      'rpc:staff_wallet_refund_booking': { ok: true, id: 'q2', amount: 50, balance: 170 },
    });
    const open = `(id,word)=>{const b=document.createElement('button');document.body.appendChild(b);showPayMenu(id,{timeStamp:performance.now(),currentTarget:b,target:b,stopPropagation(){}});
      const o=[...document.querySelectorAll('.pay-menu-popup .pay-menu-opt')];if(word){o.find(x=>x.textContent.includes(word)).click();}return o.map(x=>x.textContent).join('|');}`;
    const menu = (id: string, word = '') => page.evaluate(`(${open})(${JSON.stringify(id)},${JSON.stringify(word)})`) as Promise<string>;
    expect(await menu('q3')).toContain('Pay from wallet · SAR 120'); // the balance pays what it can of 500
    expect(await menu('q4')).not.toContain('allet'); // no account
    expect(await menu('q1')).toContain('Pay from wallet · SAR 50');
    await menu('q1', 'Pay from wallet');
    await expect.poll(() => seen.find((c) => c.name === 'staff_wallet_pay_booking')?.body.p_booking_ids).toEqual(['q1']);

    await menu('q2', 'Refund to wallet');
    const ask = page.getByRole('dialog').filter({ hasText: 'Rana Rider' });
    await ask.locator('.mny-chip').first().click();
    await expect(ask.locator('#mny-mr-go')).toHaveCount(0); // into the wallet is the only way out of this one
    await ask.locator('#mny-mr-wal').click();
    await expect.poll(() => seen.find((c) => c.name === 'staff_wallet_refund_booking')?.body.p_booking_id).toBe('q2');
  });

  test('the close-out and the till: wallet money is neither card nor cash, and it balances', async ({ page }) => {
    await staff(page, { queue_entries: [bk('q1', 1, { paid: true, pay_method: 'wallet' }), bk('q2', 2, { paid: true, pay_method: 'card' })] });
    const r = await page.evaluate(`(()=>{const q=getQueue();return{split:_mnySplit(q.find(e=>e.id==='q1')),sum:_mnySum(q)}})()`) as { split: Record<string, number>; sum: Record<string, number> };
    expect(r.split).toEqual({ card: 0, cash: 0, unknown: 0, wallet: 50, online: 0 }); // online: paid on the website (2026-11-10), its own channel
    expect(r.sum).toEqual({ card: 50, cash: 0, unknown: 0, wallet: 50, online: 0 });
    const part = await page.evaluate(`(()=>{const e=getQueue()[0];const c={...e,walletPaid:50,price:80,paid:true,pay_method:'card'},w={...e,walletPaid:80,price:80,paid:true,pay_method:'wallet'};return{card:_mnySplit(c),whole:_mnySplit(w)}})()`);
    expect(part).toEqual({ card: { card: 30, cash: 0, unknown: 0, wallet: 50, online: 0 }, whole: { card: 0, cash: 0, unknown: 0, wallet: 80, online: 0 } });
    const till = await page.evaluate(`(()=>{S._cwMoves=[
      {kind:'topup',amount:100,method:'cash',session_id:'s1',created_at:new Date().toISOString()},
      {kind:'takeout',amount:-20,method:'cash',session_id:'s1',created_at:new Date().toISOString()},
      {kind:'topup',amount:70,method:'card',session_id:null,created_at:new Date().toISOString()},
      {kind:'refund',amount:50,method:'card',card_part:50,session_id:'s1',created_at:new Date().toISOString()},
      {kind:'refund',amount:9,method:null,card_part:null,session_id:'s1',created_at:new Date().toISOString()}];
      return{ride:_cwTill({day:todayStr()},new Set(['s1'])),shop:_cwTill({day:todayStr(),shop:true})}})()`);
    expect(till).toEqual({ ride: { cash: 80, card: 50 }, shop: { cash: 0, card: 70 } });
  });

  test('a database without the wallet: no button, no tab, no pay line, nothing refused', async ({ page }) => {
    await stubSupabase(page, { sessions, customers, tags: [], customer_tags: [], queue_entries: [bk('q1', 1)], bikes: [], staff_options: [], 'rpc:staff_wallet_balances': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function in the schema cache' } } });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('(S.customers||[]).length>0');
    await page.evaluate(`_cwLoad(true)`);
    await page.waitForFunction('S._cwOff===true');
    await page.evaluate(`setStaffTab('customers');S.communityTab='accounts';renderCustomers()`);
    await expect(page.locator('#am-cust-rows .am-row[data-cust="c1"]')).toBeVisible();
    await expect(page.locator('.am-cw-btn')).toHaveCount(0);
    await expect(page.locator('#tab-community .cmy-nav')).not.toContainText('Wallets');
  });
});

test.describe('@customer:account wallet', () => {
  const mine = { balance: 120, rows: [{ id: 3, amount: 120, balance_after: 120, kind: 'refund', session_id: 's1', created_at: new Date().toISOString() }] };

  test('My Account shows the balance and its lines, and never a staff note', async ({ page }) => {
    await rider(page, { queue_entries: [], 'rpc:customer_wallet': mine });
    await page.evaluate(`setCustTab('account')`);
    await expect(page.locator('#cw-mine')).toBeVisible();
    await expect(page.locator('#cw-mine .cw-mine-t')).toHaveText('Wallet');
    await expect(page.locator('#cw-mine li')).toContainText('Refund');
  });

  const sw = (page: Page) => page.locator('.cw-pay-slot .cw-sw').first();

  test('the Wallet switch on a ticket is off until the rider turns it on, and pays what the balance can', async ({ page }) => {
    const seen = calls(page);
    await rider(page, {
      queue_entries: [bk('q1', 1, { price: 200 })], 'rpc:my_bookings': [bk('q1', 1, { price: 200 })], 'rpc:customer_wallet': mine,
      'rpc:customer_wallet_pay': { ok: true, amount: 120, balance: 0, rows: [{ id: 'q1', paid: false, pay_method: null, wallet_paid: 120 }] },
    });
    await page.evaluate(`setCustTab('myrides')`);
    await expect(sw(page)).toContainText('Wallet');
    await expect(sw(page)).toContainText('You have');
    const box = sw(page).locator('input[role="switch"]');
    await expect(box).not.toBeChecked();
    expect(seen.some((c) => c.name === 'customer_wallet_pay')).toBe(false); // nothing unasked
    await sw(page).click();
    await expect.poll(() => seen.find((c) => c.name === 'customer_wallet_pay')?.body).toMatchObject({ p_id: 'c1', p_token: 'tok', p_booking_ids: ['q1'] });
    await expect(sw(page).locator('input[role="switch"]')).toBeChecked();
    await expect(sw(page)).toContainText('left to pay at the booth');
    await expect(page.locator('.tk-owe, .cu-tk-total')).not.toHaveCount(0);
  });

  test('turning it off gives the money back', async ({ page }) => {
    const seen = calls(page);
    const held = bk('q1', 1, { price: 200, wallet_paid: 50 });
    await rider(page, {
      queue_entries: [held], 'rpc:my_bookings': [held], 'rpc:customer_wallet': { balance: 70, rows: [] },
      'rpc:customer_wallet_release': { ok: true, amount: 50, balance: 120, rows: [{ id: 'q1', paid: false, pay_method: null, wallet_paid: 0 }] },
    });
    await page.evaluate(`setCustTab('myrides')`);
    await expect(sw(page).locator('input[role="switch"]')).toBeChecked();
    await sw(page).click();
    await expect.poll(() => seen.find((c) => c.name === 'customer_wallet_release')?.body.p_booking_ids).toEqual(['q1']);
  });

  test('no balance and nothing held: no switch', async ({ page }) => {
    await rider(page, { queue_entries: [bk('q1', 1)], 'rpc:my_bookings': [bk('q1', 1)], 'rpc:customer_wallet': { balance: 0, rows: [] } });
    await page.evaluate(`setCustTab('myrides')`);
    await page.waitForFunction('S._cwMine&&S._cwMine.bal===0');
    await expect(page.locator('.cw-pay-slot .cw-sw')).toHaveCount(0);
  });

  test('the review carries the switch: off by default, and it says what is left', async ({ page }) => {
    await rider(page, { queue_entries: [], 'rpc:customer_wallet': mine });
    // at the top of the page: appended under the footer, a short landing (round two's band) left it under the floating tab bar
    await page.evaluate(`S._cwUse=false;(()=>{const h=document.createElement('div');h.id='cw-rv';h.innerHTML=_cwReviewSlot(_sessGet('s1'),'',false,200);document.body.prepend(h);})()`);
    const slot = page.locator('#cw-rv .cw-sw');
    await expect(slot).toContainText('You have');
    await expect(slot.locator('input')).not.toBeChecked();
    await slot.click();
    await expect(slot).toContainText('left to pay at the booth');
    expect(await page.evaluate('S._cwUse')).toBe(true);
    await page.evaluate(`document.querySelector('.cw-use-slot').dataset.total='100';_cwSwitchesPaint()`);
    await expect(slot).toContainText('Nothing left to pay');
    const free = await page.evaluate(`_cwReviewSlot(_sessGet('s1'),'',true,200)`);
    expect(free).toBe('');
  });

  test('what is left is what the ticket and the money read', async ({ page }) => {
    const held = bk('q1', 1, { price: 80, wallet_paid: 50 });
    await rider(page, { queue_entries: [held], 'rpc:my_bookings': [held], 'rpc:customer_wallet': { balance: 0, rows: [] } });
    const r = await page.evaluate(`(()=>{const e=entryFromDB(${JSON.stringify(held)});return{due:_bookingDue(e),cost:_bookingAmount(e)}})()`);
    expect(r).toEqual({ due: 30, cost: 80 });
  });

  test('a database without the wallet draws nothing', async ({ page }) => {
    await rider(page, { queue_entries: [bk('q1', 1)], 'rpc:my_bookings': [bk('q1', 1)], 'rpc:customer_wallet': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function in the schema cache' } } });
    await page.evaluate(`setCustTab('account')`);
    await page.waitForFunction('S._cwMineOff===true');
    await expect(page.locator('#cw-mine')).toBeHidden();
  });
});
