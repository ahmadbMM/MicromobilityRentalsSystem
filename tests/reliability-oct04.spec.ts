import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Reliability and data consistency, 2026-10-04: one money formatter (_money), one revenue rule
// (_bookingRevenue / _revenueOf), one checked bike release (_releaseBikes), KSA-calendar weeks and
// ages, read-only RPCs on the read timeout, and op ids on the sales outbox's RPCs
// (migration 20261004150000).
const sessions = [{ id: 's0', day: 'Friday', session_date: '2099-02-10', capacity: 12, status: 'open', created_at: 1 }];
const sale = { id: 'sale1', receipt_id: 'r1', session_id: 's0', item_id: 'it1', name: 'Water', qty: 1, price: 5, pay: 'paid', category: 'drinks', created_at: '2099-02-10T18:00:00Z', customer_name: 'Buyer' };
const bike = { id: 'b1', name: 'Road 01', type: 'Road', size: 'M', status: 'in-use' };
const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, ...extra });

async function boot(page: Page, fixtures: Record<string, unknown> = {}, failWrite?: Parameters<typeof stubSupabase>[2]) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [bike], cashier_sales: [sale], ...fixtures }, failWrite);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`localStorage.setItem('cq_op_name','Spec Staff');confirmDialog=(o)=>o.onConfirm&&o.onConfirm();S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();`);
}
type Call = { name: string; body: Record<string, unknown> };
const rpcs = (page: Page) => {
  const calls: Call[] = [];
  page.on('request', (r) => { const m = r.url().match(/\/rest\/v1\/rpc\/([^/?]+)/); if (m) { let body = {}; try { body = r.postDataJSON(); } catch { /* none */ } calls.push({ name: m[1], body }); } });
  return calls;
};

test.describe('@staff:reliability one money format, one revenue rule', () => {
  test('_money: SAR on the left, cents only when there are any, isolated unless asked not to', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(`[_money(57.5),_money(57),_money('12.345',_NOISO),_money(-5,_NOISO),_money(null,{isolate:false})]`))
      .toEqual(['<bdi>SAR 57.50</bdi>', '<bdi>SAR 57</bdi>', 'SAR 12.35', 'SAR -5', 'SAR 0']);
    expect(await page.evaluate(`typeof _fmtSar`)).toBe('undefined');
    expect(await page.evaluate(`_priceLabel(5)`)).toBe('SAR 5');
  });

  test('revenue: a paid booking that stands, its rental and add-ons; cancelled, removed and unpaid are not', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(`(()=>{
      const rows=[
        {id:'a',status:'done',paid:true,price:57.5,addons:[]},
        {id:'b',status:'noshow',paid:true,price:75,addons:[]},
        {id:'c',status:'cancelled',paid:true,price:75,addons:[]},
        {id:'d',status:'removed',paid:true,price:75,addons:[]},
        {id:'e',status:'done',paid:false,price:75,addons:[]},
        {id:'f',status:'done',paid:true,price:0,addons:[]},
      ];
      return{rev:_revenueOf(rows),one:_bookingRevenue(rows[2]),due:_amountOf(rows.filter(e=>!e.paid))};
    })()`);
    expect(r).toEqual({ rev: 132.5, one: 0, due: 75 });
  });
});

test.describe('@staff:reliability bikes released through one checked door', () => {
  test('a release that lands frees the bike here too', async ({ page }) => {
    await boot(page);
    const res = await page.evaluate(`_releaseBikes(['b1'],'spec').then(bad=>({bad,st:S.bikes.find(b=>b.id==='b1').status}))`);
    expect(res).toEqual({ bad: false, st: 'available' });
  });

  test('a refused release is said, and the bike states are read back', async ({ page }) => {
    await boot(page, {}, { table: 'bikes', methods: ['PATCH'] });
    const bad = await page.evaluate(`_releaseBikes(['b1'],'spec')`);
    expect(bad).toBe(true);
    await expect(page.locator('#err-bar-el')).toBeVisible();
    expect(await page.evaluate(`S.bikes.find(b=>b.id==='b1').status`)).toBe('in-use');
  });
});

test.describe('@staff:reliability KSA calendar', () => {
  test('a week starts on the Sunday of the ride day, whatever the device clock zone', async ({ page }) => {
    await boot(page);
    // _bdgWk (main's week index, which replaced _mrWeekStart on 2026-10-04): Sunday 4 Oct to Saturday
    // 10 Oct is one week, Sunday 11 Oct the next, Saturday 3 Oct the one before.
    const [sun, sat, nextSun, prevSat] = await page.evaluate(`[_bdgWk('2026-10-04'),_bdgWk('2026-10-10'),_bdgWk('2026-10-11'),_bdgWk('2026-10-03')]`) as number[];
    expect(sat).toBe(sun);
    expect(nextSun).toBe(sun + 1);
    expect(prevSat).toBe(sun - 1);
  });
  test('an account age is counted on the KSA day', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(`(()=>{const d=todayStr(),y=+d.slice(0,4);return[_accAge({birth_date:(y-20)+d.slice(4)}),_accAge({birth_date:'x'})];})()`);
    expect(r).toEqual([20, null]);
  });
});

test.describe('@staff:reliability read-only RPCs read on the read timeout', () => {
  test('staff_sync is not counted as a write on the wire; a write RPC is', async ({ page }) => {
    await boot(page);
    await page.route(/\/rest\/v1\/rpc\/(staff_sync|staff_set_price)/, async (r) => { await new Promise((f) => setTimeout(f, 400)); await r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: '[]' }); });
    const n = await page.evaluate(`(async()=>{
      const u=SUPABASE_URL+'/rest/v1/rpc/';
      const p1=_fetchT(u+'staff_sync',{method:'POST',body:'{}'});const a=_sbWritesOut;await p1;
      const p2=_fetchT(u+'staff_set_price',{method:'POST',body:'{}'});const b=_sbWritesOut;await p2;
      return[a,b,_sbWritesOut];
    })()`);
    expect(n).toEqual([0, 1, 0]);
  });
});

test.describe('@staff:reliability outbox ops carry one op id', () => {
  test('an offline void keeps the op id of its first call and sends it again on the replay', async ({ page }) => {
    await boot(page, { 'rpc:staff_void_receipt': ok({ receipt_id: 'r1', count: 1, items: [] }) });
    const calls = rpcs(page);
    await page.evaluate(`setStaffTab('cashier')`);
    await page.route(/\/rest\/v1\/rpc\/staff_void_receipt/, (r) => r.abort('internetdisconnected'));
    await page.evaluate(`_ctVoidReceipt('r1')`);
    await expect.poll(() => page.evaluate(`_outbox().filter(o=>o.kind==='void').length`)).toBe(1);
    const queued = await page.evaluate(`_outbox()[0].data.p_op_id`);
    expect(queued).toMatch(/^[0-9a-f-]{36}$/);
    await page.unroute(/\/rest\/v1\/rpc\/staff_void_receipt/);
    await page.evaluate(`_outboxFlush()`);
    await expect.poll(() => page.evaluate(`_outbox().length`)).toBe(0);
    const sent = calls.filter((c) => c.name === 'staff_void_receipt').map((c) => c.body.p_op_id);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sent)).toEqual(new Set([queued]));
  });

  test('a database without the op ids is asked again without one', async ({ page }) => {
    await boot(page);
    let n = 0;
    await page.route(/\/rest\/v1\/rpc\/staff_refund_receipt/, (r) => {
      n++;
      const body = r.request().postDataJSON() as Record<string, unknown>;
      if ('p_op_id' in body) return r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ code: 'PGRST202', message: 'Could not find the function public.staff_refund_receipt(p_approval, p_op, p_op_id, p_reason, p_receipt_id) in the schema cache' }) });
      return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, receipt_id: 'r1', count: 1, items: [] }) });
    });
    const res = await page.evaluate(`_rpcOp('staff_refund_receipt',{p_receipt_id:'r1',p_reason:null,p_op:'Spec Staff',p_approval:null,p_op_id:_opId()}).then(r=>!r.error&&r.data.ok)`);
    expect(res).toBe(true);
    expect(n).toBe(2);
  });
});
