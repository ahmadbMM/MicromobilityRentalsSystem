import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, loginCustomer, type Fixtures } from './helpers/supabase';

// The till, 2026-10-05 (bug audit, slice rc1): a receipt edit never deletes (a non-admin's DELETE does
// nothing on the server) and sends only what changed, guarded against a void or refund made
// elsewhere; voids and refunds restock what the server changed; a stock movement the network drops
// waits in the outbox; a void whose PIN ran out waits for the PIN; money given away asks the PIN; an
// On-the-house line keeps its price and takes nothing; a party booked offline goes in one call.

const S1 = 's1';
const sessions = [{ id: S1, day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }];
const inventory = [
  { id: 'gel', name: 'Gel', category: 'EnergyGels', qty: 10, price: 12, low_threshold: 1 },
  { id: 'bar', name: 'Bar', category: 'ProteinBars', qty: 4, price: 9, low_threshold: 0 },
];
const booking = {
  id: 'q1', name: 'Counter Test', size: 'M', type_preference: 'Road', paid: false, price: 30, session_id: S1, session_day: 'Friday',
  session_date: '2099-01-09', queue_num: 4, status: 'active', registered_at: '2099-01-09T10:00:00Z', walk_in: false,
  purchases: JSON.stringify([{ id: 'gel', name: 'Gel', cat: 'EnergyGels', qty: 1, price: 12, pay: 'paid', at: '2099-01-09T11:00:00Z' }]),
};

async function boot(page: Page, extra: Fixtures = {}, pin = false) {
  await stubSupabase(page, { sessions, queue_entries: [booking], inventory, ...extra });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.inventory||[]).length>0');
  await page.evaluate(`confirmDialog=(o)=>o.onConfirm&&o.onConfirm();_askMoneyReason=async()=>({v:'mistake',txt:'Rung up by mistake'});S._opPins=[{name:'Spec Staff',has_pin:${pin}}];S._opPinsAt=Date.now();`);
}
/** Writes to a table: method, decoded address, body. */
function writes(page: Page, table: string) {
  const out: { m: string; url: string; body: unknown }[] = [];
  page.on('request', (r) => {
    const m = r.method();
    if (m === 'GET' || m === 'OPTIONS' || !r.url().includes(`/rest/v1/${table}`)) return;
    let body: unknown = null;
    try { body = r.postDataJSON(); } catch { /* none */ }
    out.push({ m, url: decodeURIComponent(r.url()), body });
  });
  return out;
}

test.describe('@staff:sales receipts', () => {
  test('a receipt edit re-books its discounts on the rows it has, by update, never a delete', async ({ page }) => {
    await boot(page);
    const sent = writes(page, 'cashier_sales');
    const ops = await page.evaluate(`(async()=>{
      S._ctSession='${S1}';
      S.cashSales=[
        {id:'g1',receipt_id:'r1',session_id:'${S1}',name:'Gel',item_id:'gel',category:'EnergyGels',qty:1,price:50,pay:'paid',created_at:'2099-01-09T11:00:00Z'},
        {id:'c1',receipt_id:'r1',session_id:'${S1}',name:'Cap',item_id:null,category:'Apparel',qty:1,price:20,pay:'pending',created_at:'2099-01-09T11:00:00Z'},
        {id:'d1',receipt_id:'r1',session_id:'${S1}',name:'Discount',item_id:null,category:'__discount__',qty:1,price:-30,pay:'paid',created_at:'2099-01-09T11:00:00Z'},
        {id:'d2',receipt_id:'r1',session_id:'${S1}',name:'Discount',item_id:null,category:'__discount__',qty:1,price:-10,pay:'pending',created_at:'2099-01-09T11:00:00Z'}];
      showReceiptEdit('r1');S._reEdit.find(l=>l.id==='c1').pay='paid';
      await saveReceiptEdit();
      return _outbox().map(o=>o.kind+':'+o.id+':'+JSON.stringify(o.data)).sort();
    })()`) as string[];
    // Both discounts now come off the paid lines: d1 carries all 40, d2 is set to nothing (not deleted).
    expect(ops.every((o) => o.startsWith('update:'))).toBe(true);
    expect(ops).toContain('update:c1:{"pay":"paid"}');
    expect(ops).toContain('update:d1:{"price":-40}');
    expect(ops).toContain('update:d2:{"qty":0,"price":0}');
    await page.evaluate('_outboxFlush()');
    await expect.poll(() => page.evaluate('_outboxCount()')).toBe(0);
    expect(sent.some((w) => w.m === 'DELETE')).toBe(false);
    expect(sent.filter((w) => w.m === 'PATCH').every((w) => w.url.includes('voided_at=is.null') && w.url.includes('refunded_at=is.null'))).toBe(true);
    // the spare discount is not drawn on the receipt, and the receipt reads 70 - 40
    expect(await page.evaluate(`_rcTotal(S.cashSales.filter(r=>r.receipt_id==='r1'))`)).toBe(30);
    expect(await page.evaluate(`S.cashSales.filter(r=>r.receipt_id==='r1').filter(_rcShown).map(r=>r.id).sort()`)).toEqual(['c1', 'd1', 'g1']);
  });

  test('Mark paid sends only the pay column, on a row still standing', async ({ page }) => {
    await boot(page);
    const sent = writes(page, 'cashier_sales');
    await page.evaluate(`(()=>{S.cashSales=[{id:'p1',receipt_id:'rp',session_id:'${S1}',name:'Gel',category:'EnergyGels',qty:1,price:12,pay:'pending',voided_at:null,refunded_at:null,created_at:'2099-01-09T11:00:00Z'}];_ctMarkReceiptPaid('rp');})()`);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].m).toBe('PATCH');
    expect(sent[0].body).toEqual({ pay: 'paid' });
    expect(sent[0].url).toContain('id=eq.p1');
    expect(sent[0].url).toContain('voided_at=is.null');
  });

  test('a change to a sale still waiting to be sent is folded into its insert, never replaces it', async ({ page }) => {
    await boot(page, {}, false);
    await page.route(/\/rest\/v1\/cashier_sales/, (r) => (r.request().method() === 'GET' ? r.fallback() : r.abort('internetdisconnected')));
    const ops = await page.evaluate(`(()=>{
      _salesApply([{id:'n1',receipt_id:'rn',session_id:'${S1}',name:'Gel',category:'EnergyGels',qty:1,price:12,pay:'pending'}],[]);
      _salesApply([],[],[{id:'n1',cols:{pay:'paid'}}]);
      return _outbox().map(o=>o.kind+':'+o.data.pay);
    })()`);
    expect(ops).toEqual(['upsert:paid']);
  });
});

test.describe('@staff:sales voids, refunds and stock', () => {
  test('a void restocks what the server voided, leaving out a line already refunded', async ({ page }) => {
    await boot(page, { 'rpc:staff_void_receipt': { ok: true, receipt_id: 'r1', count: 2, items: [{ id: 'l1', item_id: 'gel', qty: 2, pay: 'refunded' }, { id: 'l2', item_id: 'bar', qty: 1, pay: 'paid' }] } });
    const inv = writes(page, 'inventory');
    await page.evaluate(`(()=>{setStaffTab('cashier');S.cashSales=[
      {id:'l1',receipt_id:'r1',session_id:'${S1}',name:'Gel',item_id:'gel',category:'EnergyGels',qty:2,price:12,pay:'paid',created_at:'2099-01-09T11:00:00Z'},
      {id:'l2',receipt_id:'r1',session_id:'${S1}',name:'Bar',item_id:'bar',category:'ProteinBars',qty:1,price:9,pay:'paid',created_at:'2099-01-09T11:00:00Z'}];
      _ctVoidReceipt('r1');})()`);
    await expect.poll(() => inv.length).toBe(1);
    await page.waitForTimeout(200);
    expect(inv).toHaveLength(1);
    expect(inv[0].url).toContain('id=eq.bar');
    expect((inv[0].body as Record<string, unknown>).qty).toBe(5);
  });

  test('a refund the server changed nothing on (another desk got there first) restocks nothing', async ({ page }) => {
    await boot(page, { 'rpc:staff_refund_receipt': { ok: true, receipt_id: 'r1', count: 0, items: [] } });
    const inv = writes(page, 'inventory');
    await page.evaluate(`(()=>{setStaffTab('cashier');S.cashSales=[{id:'l1',receipt_id:'r1',session_id:'${S1}',name:'Gel',item_id:'gel',category:'EnergyGels',qty:2,price:12,pay:'paid',created_at:'2099-01-09T11:00:00Z'}];_ctRefundReceipt('r1');})()`);
    await expect.poll(() => page.evaluate(`(S.cashSales.find(r=>r.id==='l1')||{}).pay`)).toBe('refunded');
    await page.waitForTimeout(300);
    expect(inv).toEqual([]);
  });

  test('a stock movement the network drops waits in the outbox and is applied when it returns', async ({ page }) => {
    await boot(page);
    const inv: string[] = [];
    await page.route(/\/rest\/v1\/inventory/, (r) => (r.request().method() === 'PATCH' ? r.abort('internetdisconnected') : r.fallback()));
    await page.evaluate(`_addonStockBatch([{item_id:'gel',qty:2}],-1)`);
    expect(await page.evaluate(`_outbox().map(o=>o.kind+':'+o.data.item+':'+o.data.delta)`)).toEqual(['stock:gel:-2']);
    await expect(page.locator('#err-bar-el')).toHaveCount(0); // kept for later, not said as a failure
    await page.unroute(/\/rest\/v1\/inventory/);
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('/rest/v1/inventory')) inv.push(decodeURIComponent(r.url())); });
    await page.evaluate('_outboxFlush()');
    await expect.poll(() => page.evaluate('_outboxCount()')).toBe(0);
    expect(inv.some((u) => u.includes('id=eq.gel'))).toBe(true);
    expect(await page.evaluate(`S.inventory.find(i=>i.id==='gel').qty`)).toBe(8);
  });

  test('a void the server refuses for its PIN waits for the PIN; given up, its rows show again', async ({ page }) => {
    await boot(page, { 'rpc:staff_void_receipt': { __rpcError: { status: 400, code: '42501', message: 'PIN_REQUIRED' } } });
    await page.evaluate(`(()=>{localStorage.setItem('cq_sales_outbox',JSON.stringify([{oid:'o1',kind:'void',id:'r9',data:{p_receipt_id:'r9',p_reason:null,p_op:'Spec Staff',p_approval:'old',p_op_id:'00000000-0000-4000-8000-000000000001'},rows:['v1','v2']}]));_voidedAdd('v1');_voidedAdd('v2');})()`);
    await page.evaluate('_outboxFlush()');
    await expect.poll(() => page.evaluate(`(_outbox()[0]||{}).needPin`)).toBe(true);
    const calls: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/staff_void_receipt')) calls.push(r.url()); });
    await page.evaluate('_outboxFlush()');
    await page.waitForTimeout(200);
    expect(calls).toEqual([]); // not sent again as it was, refused for ever
    await page.evaluate('_outboxDiscard()');
    expect(await page.evaluate(`[_outboxCount(),_voidedIds().includes('v1'),_voidedIds().includes('v2')]`)).toEqual([0, false, false]);
  });
});

test.describe('@staff:sales money given away asks the PIN', () => {
  test("voiding a sale rung up on a booking waits for the operator's PIN", async ({ page }) => {
    await boot(page, {}, true);
    const sent = writes(page, 'queue_entries');
    await page.evaluate(`showCashierModal('q1');_cashVoid(0);`);
    await expect(page.locator('#op-gate-modal [role="dialog"]')).toBeVisible();
    await page.waitForTimeout(200);
    expect(sent).toEqual([]);
  });

  test('an On-the-house line keeps its price, asks the PIN, and takes nothing from the cart', async ({ page }) => {
    await boot(page, {}, true);
    await page.evaluate(`setStaffTab('cashier');S._ctSession='${S1}';_ctSet('_ctItem','gel');_ctSet('_ctPay','house');`);
    expect(await page.evaluate('S._ctAmt')).toBe('12');
    await page.evaluate('void _ctCartAdd()'); // it waits on the keypad
    await expect(page.locator('#op-gate-modal [role="dialog"]')).toBeVisible();
    expect(await page.evaluate('(S._ctCart||[]).length')).toBe(0); // not in the cart before the PIN
    await page.evaluate(`_opGateDone();S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();_ctCartAdd()`);
    await expect.poll(() => page.evaluate('(S._ctCart||[]).length')).toBe(1);
    expect(await page.evaluate(`[S._ctCart[0].price,_ctCartTotals(S._ctCart).tot]`)).toEqual([12, 0]);
  });
});

test.describe('@staff:sales house value and team lines', () => {
  test('a recorded house line reports what was given away; a team line is not on the customer', async ({ page }) => {
    await boot(page, { customers: [{ id: 'c1', name: 'Linked Rider', created_at: '2026-01-01T00:00:00Z' }] });
    await page.evaluate(`(()=>{setStaffTab('cashier');S._ctSession='${S1}';S._ctCust='Linked Rider';S._ctCustId='c1';
      S._ctCart=[{item_id:'gel',name:'Gel',cat:'EnergyGels',qty:1,price:12,pay:'house',team:''},{item_id:null,name:'Jersey',cat:'Apparel',qty:1,price:40,pay:'team',team:'Staff Member'},{item_id:'bar',name:'Bar',cat:'ProteinBars',qty:1,price:9,pay:'paid',team:''}];
      _ctRecord();})()`);
    const r = await page.evaluate(`(()=>{const rows=S.cashSales;const t=_salesTotals(_cashSessionLines('${S1}').filter(l=>l.src==='sale'));
      return {house:rows.find(x=>x.pay==='house').price,team:rows.find(x=>x.pay==='team').customer_id||null,paid:rows.find(x=>x.pay==='paid').customer_id,total:_rcTotal(rows),free:t.free,collected:t.collected};})()`);
    expect(r).toEqual({ house: 12, team: null, paid: 'c1', total: 49, free: 12, collected: 9 });
    await expect(page.locator('#tab-cashier .sl-thouse')).toContainText('12');
  });
});

test.describe('@staff:sales outbox', () => {
  test('a call while a flush is running joins it rather than being answered at once', async ({ page }) => {
    await boot(page);
    let release: () => void = () => {};
    const held = new Promise<void>((res) => { release = res; });
    await page.route(/\/rest\/v1\/cashier_sales/, async (r) => { if (r.request().method() === 'GET') return r.fallback(); await held; return r.fallback(); });
    await page.evaluate(`_salesApply([{id:'j1',receipt_id:'rj',session_id:'${S1}',name:'Gel',category:'EnergyGels',qty:1,price:12,pay:'paid'}],[])`);
    await page.waitForFunction('_outboxBusy===true');
    expect(await page.evaluate('_outboxFlush()===_outboxP&&!!_outboxP')).toBe(true);
    release();
    await expect.poll(() => page.evaluate('_outboxCount()')).toBe(0);
  });
});

test.describe('@customer:reserve offline party', () => {
  test("a party booked offline is sent in one call, so a flat promo comes off the booking once", async ({ page }) => {
    const row = (id: string, n: number) => ({ id, name: 'Party Rider ' + n, session_id: S1, session_day: 'Friday', session_date: '2099-01-09', queue_num: n, status: 'waiting', customer_id: 'c1', type_preference: 'Road', price: 50, paid: false, promo_code: 'FLAT20', registered_at: '2099-01-01T10:00:00Z' });
    await page.addInitScript((rows) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('cq_book_outbox', JSON.stringify(rows)); } }, [row('o1', 1), row('o2', 2)]);
    await loginCustomer(page, { id: 'c1' });
    await stubSupabase(page, { sessions });
    const calls: number[] = [];
    page.on('request', (r) => { if (r.url().includes('/rpc/customer_create_booking')) { try { calls.push((r.postDataJSON().p_entries || []).length); } catch { /* none */ } } });
    await page.goto('/');
    await waitForSb(page);
    await expect.poll(() => page.evaluate('_bookOutboxCount()')).toBe(0);
    expect(calls).toEqual([2]);
  });
});
